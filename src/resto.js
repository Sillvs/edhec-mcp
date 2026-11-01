// Campus food: ALL La Catho (all-lacatho.fr, menus) and MONEWEB (allresto.moneweb.fr, card balance,
// receipts, reservation services). Both sign in through Keycloak with the "EDHEC - Connect" button.
// Read-only: no top-ups, payments or orders are made from here.
import fs from 'node:fs';
import { withBrowser, NeedsLoginError } from './browser.js';
import { checkDownloadDir, insideDir, safeName, uniquePath } from './safety.js';

export const LC = 'https://all-lacatho.fr';
export const MW = 'https://allresto.moneweb.fr';
const ASSETS = 'https://rabbit-api.all-lacatho.fr/assets/';
export const MENU_SITES = { edhec: 'edhec', lille: '', issy: 'issy', piktura: 'piktura' };

const msLoginVisible = (page) => /login\.microsoftonline\.com/.test(page.url())
  && page.locator('input[type=email], input[name=loginfmt], input[type=password]').first().isVisible().catch(() => false);

// Walk through Keycloak ("EDHEC - Connect") and Microsoft SSO until `done(page)` is true.
async function ssoUntil(page, done, service) {
  for (let i = 0; i < 40; i++) {
    if (await done(page)) return;
    if (page.url().includes('keycloak.all-lacatho.fr')) {
      const btn = page.getByText('EDHEC - Connect', { exact: true });
      if (await btn.count()) await btn.first().click().catch(() => {});
      // A Keycloak form asking to create/update an account means first-time setup: the user must do that.
      if (await page.locator('input[name=firstName], #kc-register-form, #kc-update-profile-form').count()) {
        throw new Error(`${service} needs a one-time account setup. Open ${LC} in your browser and sign in with "EDHEC - Connect" once.`);
      }
    }
    if (await msLoginVisible(page)) break;
    await page.waitForTimeout(1500);
  }
  if (!(await done(page))) throw new NeedsLoginError(service);
}

// --- MONEWEB (card balance, receipts, reservations) -----------------------

async function mwGet(c, p) {
  const r = await c.request.get(MW + p, { failOnStatusCode: false, maxRedirects: 0, timeout: 30000 });
  return { status: r.status(), body: await r.json().catch(() => null) };
}
async function mwPost(c, p, data) {
  const r = await c.request.post(MW + p, { data, failOnStatusCode: false, maxRedirects: 0, timeout: 30000 });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

async function ensureMoneweb(c) {
  const a = await mwGet(c, '/clients/api/authenticated');
  if (a.body?.Authenticated) return;
  const page = await c.newPage();
  try {
    await page.goto(`${MW}/clients#/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let clicked = false;
    await ssoUntil(page, async () => {
      if (!clicked && page.url().includes('#/login')) {
        const b = page.getByText(/COMPTE SITE WEB ALL LA CATHO/i).first();
        if (await b.count()) { await b.click().catch(() => {}); clicked = true; }
      }
      return (await mwGet(c, '/clients/api/authenticated')).body?.Authenticated === true;
    }, 'MONEWEB (allresto.moneweb.fr)');
  } finally { await page.close().catch(() => {}); }
}

const mw = (fn) => withBrowser(async (c) => { await ensureMoneweb(c); return fn(c); });

export function balance() {
  return mw(async (c) => {
    const acc = await mwGet(c, '/clients/api/compte');
    if (acc.status !== 200) throw new Error(`MONEWEB account ${acc.status}`);
    const dash = await mwPost(c, '/clients/api/compte/dashboard', { LastTicketInstant: null, LastVersementInstant: null });
    const b = acc.body;
    return {
      balanceEUR: b.Solde,
      mode: b.ManagementMode,              // Pre_Paiement = prepaid card
      lastVisit: dash.body?.DateDernierPassage ?? null,
      canReserve: !!b.Features?.Reservation,
      topUp: 'Top-ups are payments: do them yourself at https://allresto.moneweb.fr (RECHARGE).',
    };
  });
}

export function history({ limit = 30 } = {}) {
  return mw(async (c) => {
    const dash = await mwPost(c, '/clients/api/compte/dashboard', { LastTicketInstant: null, LastVersementInstant: null });
    if (dash.status !== 200) throw new Error(`MONEWEB history ${dash.status}`);
    const tickets = (dash.body?.Tickets?.List || []).map(t => ({
      date: t.DateTicket, activity: t.Activite,
      // MONEWEB puts the amount paid from the card in TotalPlateau ("tray total").
      amountEUR: Math.round(((t.TotalPlateau || 0) + (t.TotalTTC || 0)) * 100) / 100,
      balanceBefore: t.AncienSolde, balanceAfter: t.NouveauSolde,
    })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const payments = (dash.body?.Versements?.List || []).map(v => ({
      date: v.DateCreation || v.Date, amountEUR: v.Montant, status: v.Statut,
    }));
    return { balanceEUR: dash.body?.Solde, purchases: tickets.slice(0, limit), topUps: payments.slice(0, limit) };
  });
}

export function services() {
  return mw(async (c) => {
    const s = await mwGet(c, '/client/api/reservation-service/en-GB');
    if (s.status !== 200) throw new Error(`MONEWEB services ${s.status}`);
    return {
      services: (s.body || []).map(x => ({ id: x.Id, name: x.Name, canBook: x.CanCreate, description: x.Description })),
      note: 'Click & Collect for the snack corner only shows up while ordering is open (mornings, until about 10:00). Booking from this server is not enabled yet.',
    };
  });
}

// --- ALL La Catho menu ----------------------------------------------------

// The menu is a PDF (one page per day) rendered on a canvas. We return each page as an image
// so the model can read it, and optionally save the PDF.
export function menu({ site = 'edhec', destDir, maxPages = 7 } = {}) {
  if (typeof site !== 'string' || !Object.hasOwn(MENU_SITES, site)) throw new Error(`site must be one of: ${Object.keys(MENU_SITES).join(', ')}`);
  const root = destDir ? checkDownloadDir(destDir) : null;
  return withBrowser(async (c) => {
    const page = await c.newPage({ viewport: { width: 900, height: 1300 } }).catch(() => c.newPage());
    try {
      let pdfUrl = null;
      page.on('response', (r) => {
        if (r.url().startsWith(ASSETS) && /pdf/i.test(r.headers()['content-type'] || '')) pdfUrl = r.url();
      });
      const url = `${LC}/fr/menu-jour${MENU_SITES[site] ? '/' + MENU_SITES[site] : ''}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await ssoUntil(page, async (pg) => pg.url().startsWith(LC), 'ALL La Catho (all-lacatho.fr)');
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      const reject = page.getByRole('button', { name: /Tout rejeter|Reject all/i }).first();
      if (await reject.count()) await reject.click().catch(() => {}); // privacy-friendly cookie choice
      const canvas = page.locator('canvas').first();
      await canvas.waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);

      const images = [];
      for (let i = 0; i < Math.min(maxPages, 10); i++) {
        images.push({ mimeType: 'image/png', data: (await canvas.screenshot()).toString('base64') });
        const next = page.locator('button:has(svg[data-testid*="ChevronRight"]), button:has(svg[data-testid*="ArrowForward"]), button[aria-label*="next" i]').last();
        const nextBtn = (await next.count()) ? next : page.locator('button').last();
        if (!(await nextBtn.isEnabled().catch(() => false))) break;
        const before = images[images.length - 1].data.length;
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
        const after = (await canvas.screenshot()).toString('base64');
        if (Math.abs(after.length - before) < 50 && after === images[images.length - 1].data) break; // no more pages
      }

      let saved = null;
      if (root && pdfUrl) {
        const r = await c.request.get(pdfUrl, { timeout: 60000 });
        const buf = await r.body();
        if (buf.subarray(0, 4).toString() === '%PDF') {
          fs.mkdirSync(root, { recursive: true });
          saved = uniquePath(insideDir(root, safeName(`Menu ${site} ${new Date().toISOString().slice(0, 10)}.pdf`)));
          fs.writeFileSync(saved, buf, { flag: 'wx' });
        }
      }
      return { site, pages: images.length, savedPdf: saved, hint: 'Each image is one day of the menu (French). Prices: "+2" means €2 extra.', __images: images };
    } finally { await page.close().catch(() => {}); }
  });
}
