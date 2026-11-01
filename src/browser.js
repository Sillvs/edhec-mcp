// Shared browser session for EDHEC services.
// Uses a persistent Chrome profile so the SSO login survives restarts.
// Runs headless for normal tool calls; `login()` opens a visible window once.
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PROFILE_DIR = process.env.EDHEC_MCP_PROFILE || path.join(os.homedir(), '.edhec-mcp', 'profile');
export const BB = 'https://learning.edhec.edu';
export const PC = 'https://eprinting.edhec.edu';

const IDLE_CLOSE_MS = 5 * 60 * 1000;

let ctx = null;
let ctxHeadless = true;
let idleTimer = null;
let queue = Promise.resolve();

// The profile holds your session cookies: keep it private to your user.
fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(PROFILE_DIR, 0o700);
  // Only tighten the parent when it is our own default folder, never e.g. $HOME.
  if (!process.env.EDHEC_MCP_PROFILE) fs.chmodSync(path.dirname(PROFILE_DIR), 0o700);
} catch { /* best effort */ }

async function launch(headless) {
  let c;
  try {
    c = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: process.env.EDHEC_MCP_BROWSER_CHANNEL || 'chrome',
      headless,
      acceptDownloads: true, // needed for Aurion PDFs; files stay in Playwright's temp dir until saved via insideDir()
      viewport: headless ? { width: 1280, height: 900 } : null,
    });
  } catch (e) {
    if (/ProcessSingleton|SingletonLock|already in use/i.test(e.message)) {
      throw new Error('The edhec-mcp browser profile is already in use (another Claude session or the login window is open). Close it and retry.');
    }
    if (/chrome.*not found|Executable doesn't exist|distribution/i.test(e.message)) {
      throw new Error('Google Chrome was not found. Install Chrome, or set EDHEC_MCP_BROWSER_CHANNEL=msedge / chromium.');
    }
    throw e;
  }
  c.on('close', () => { if (ctx === c) ctx = null; });
  return c;
}

export async function closeBrowser() {
  if (ctx) { const c = ctx; ctx = null; await c.close().catch(() => {}); }
}

async function getContext({ headless = true } = {}) {
  if (ctx && ctxHeadless !== headless) await closeBrowser();
  if (!ctx) { ctx = await launch(headless); ctxHeadless = headless; }
  return ctx;
}

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { closeBrowser(); }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

// Run browser work one call at a time (one profile = one browser).
export function withBrowser(fn, opts) {
  const run = queue.then(async () => {
    const c = await getContext(opts);
    try { return await fn(c); } finally { touchIdle(); }
  });
  queue = run.catch(() => {});
  return run;
}

export class NeedsLoginError extends Error {
  constructor(service) {
    super(`Not signed in to ${service}. Call the "edhec_login" tool (opens a browser window for SSO), then retry.`);
    this.name = 'NeedsLoginError';
  }
}

// --- Blackboard session -------------------------------------------------

async function bbLoggedIn(c) {
  const r = await c.request.get(`${BB}/learn/api/public/v1/users/me`, { failOnStatusCode: false });
  return r.status() === 200;
}

// Blackboard's landing page offers "I have an Edhec Email Address", which
// goes straight through when the Microsoft SSO cookie is still valid.
async function bbTrySso(c) {
  const page = await c.newPage();
  try {
    await page.goto(`${BB}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const btn = page.getByRole('button', { name: /I have an Edhec Email Address/i });
    if (await btn.count()) {
      await btn.first().click();
      await page.waitForURL(u => u.hostname === 'learning.edhec.edu' && !u.search.includes('new_loc'), { timeout: 30000 }).catch(() => {});
    }
  } catch { /* fall through */ } finally { await page.close().catch(() => {}); }
  return bbLoggedIn(c);
}

export async function ensureBlackboard(c) {
  if (await bbLoggedIn(c)) return;
  if (await bbTrySso(c)) return;
  throw new NeedsLoginError('Blackboard (learning.edhec.edu)');
}

// --- PaperCut session ---------------------------------------------------

function pcIsLoginPage(page) {
  return page.getByRole('button', { name: /Login with Edhec Email/i }).count().then(n => n > 0);
}

// Returns an open page on PaperCut, signed in. Caller closes it.
export async function pcPage(c, servicePage = 'UserSummary') {
  const page = await c.newPage();
  await page.goto(`${PC}/app?service=page/${servicePage}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (await pcIsLoginPage(page)) {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // SSO hops through Microsoft and back; re-click if the button is still there after a while.
    let signedIn = false;
    for (let i = 0; i < 30 && !signedIn; i++) {
      const onPc = page.url().startsWith(PC);
      const loginShown = onPc && await pcIsLoginPage(page).catch(() => true);
      if (onPc && loginShown && i % 6 === 0) {
        await page.getByRole('button', { name: /Login with Edhec Email/i }).first().click().catch(() => {});
      }
      await page.waitForTimeout(1500);
      signedIn = page.url().startsWith(PC) && !(await pcIsLoginPage(page).catch(() => true));
    }
    if (!signedIn) {
      const where = (() => { try { const u = new URL(page.url()); return u.host + u.pathname; } catch { return '?'; } })();
      if (process.env.EDHEC_MCP_DEBUG) await page.screenshot({ path: path.join(os.tmpdir(), 'edhec-mcp-pc-login.png') }).catch(() => {});
      await page.close().catch(() => {});
      const e = new NeedsLoginError('ePrinting (eprinting.edhec.edu)');
      e.message += ` (stopped at ${where})`;
      throw e;
    }
    await page.goto(`${PC}/app?service=page/${servicePage}`, { waitUntil: 'domcontentloaded' });
  }
  return page;
}

// --- Interactive login ----------------------------------------------------

export async function interactiveLogin({ timeoutMs = 5 * 60 * 1000 } = {}) {
  return withBrowser(async (c) => {
    const page = c.pages()[0] || await c.newPage();
    await page.goto(`${BB}/`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    const deadline = Date.now() + timeoutMs;
    let bb = false;
    while (Date.now() < deadline) {
      if (await bbLoggedIn(c)) { bb = true; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    let pc = false;
    if (bb) {
      try { const p = await pcPage(c); pc = true; await p.close(); } catch { pc = false; }
    }
    await closeBrowser();
    return { blackboard: bb, eprinting: pc };
  }, { headless: false });
}
