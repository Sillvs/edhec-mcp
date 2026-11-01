// Aurion (aurion.edhec.edu): timetable, grades, attendance, rooms, certificates.
// Aurion is a JSF/PrimeFaces app without a public API, so we drive its menu and read its tables.
// Everything here is read-only; the only write is saving a certificate PDF to your disk.
import fs from 'node:fs';
import path from 'node:path';
import { withBrowser, NeedsLoginError } from './browser.js';
import { checkDownloadDir, insideDir, safeName, uniquePath } from './safety.js';

export const AU = 'https://aurion.edhec.edu';

// Menu paths (labels exactly as shown in Aurion's English UI).
export const VIEWS = {
  grades: ['My pathway', 'My results', 'My grades'],
  resit_grades: ['My pathway', 'My results', 'My resit grades'],
  resit_sessions: ['My pathway', 'My resit sessions'],
  absences: ['Attendance', 'My absences'],
  proofs_of_absence: ['Attendance', 'My proofs of absence'],
  optional_courses: ['My pathway', 'My registrations', 'My optional courses'],
  options: ['My pathway', 'My registrations', 'My options'],
  lv2_courses: ['My pathway', 'My registrations', 'My LV2 courses'],
  groups: ['My pathway', 'My registrations', 'My groups'],
  rooms_now: ['Schedule', 'The rooms available today (Lille Campus)', 'room available now'],
  rooms_morning: ['Schedule', 'The rooms available today (Lille Campus)', 'This morning - Lille campus'],
  rooms_afternoon: ['Schedule', 'The rooms available today (Lille Campus)', 'This afternoon - Lille campus'],
  academic_calendar: ['Schedule', 'My academic calendar'],
};

async function hideSpinner(page) {
  await page.evaluate(() => { try { window.PF && PF('modalePatientez') && PF('modalePatientez').hide(); } catch { /* ignore */ } }).catch(() => {});
}

// Open Aurion signed in (Microsoft SSO goes through by itself when the session cookie is valid).
async function aurionPage(c) {
  const page = await c.newPage();
  await page.goto(AU, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 30; i++) {
    const ready = page.url().startsWith(AU) && await page.evaluate(() => !!window.PrimeFaces && document.querySelectorAll('li > a').length > 0 && document.readyState === 'complete').catch(() => false);
    if (ready) { await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); return page; }
    if (/login\.microsoftonline\.com/.test(page.url()) && await page.locator('input[type=email], input[name=loginfmt]').isVisible().catch(() => false)) break;
    await page.waitForTimeout(1000);
  }
  await page.close().catch(() => {});
  throw new NeedsLoginError('Aurion (aurion.edhec.edu)');
}

// Click through the sidebar, waiting for each label to appear (submenus load via ajax/page change).
const clickMenu = (page, t) => page.evaluate((t) => {
  const a = Array.from(document.querySelectorAll('li > a')).find(x => x.innerText.trim() === t && x.offsetParent);
  if (a) a.click();
  return !!a;
}, t).catch(() => false);

async function navMenu(page, labels) {
  let prev = null;
  for (const label of labels) {
    let clicked = false;
    for (let i = 0; i < 30 && !clicked; i++) {
      clicked = await clickMenu(page, label);
      if (!clicked) {
        if (prev && i % 8 === 7) await clickMenu(page, prev); // parent click got lost: open it again
        await page.waitForTimeout(800);
      }
    }
    prev = label;
    if (!clicked) throw new Error(`Aurion menu entry not found: "${label}"`);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }
  await hideSpinner(page);
}

// Read the main PrimeFaces data table, following the paginator (max 20 pages).
async function readTable(page) {
  for (let i = 0; i < 25; i++) {
    if (await page.locator('.ui-datatable').count()) break;
    await page.waitForTimeout(800);
  }
  const extract = () => page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('.ui-datatable')).filter(t => !/Past 24 hours/.test(t.innerText));
    const t = tables[0];
    if (!t) return null;
    const seen = {};
    const headers = Array.from(t.querySelectorAll('thead th')).map(th => {
      let h = (th.querySelector('.ui-column-title')?.innerText ?? th.innerText).trim().replace(/\s+/g, ' ');
      seen[h] = (seen[h] || 0) + 1;
      return seen[h] > 1 ? `${h} ${seen[h]}` : h;
    });
    const rows = Array.from(t.querySelectorAll('tbody tr')).filter(tr => !tr.classList.contains('ui-datatable-empty-message'))
      .map(tr => Array.from(tr.cells).map(td => td.innerText.trim().replace(/\s+/g, ' ')));
    const links = Array.from(t.querySelectorAll('tbody a')).map(a => a.innerText.trim()).filter(Boolean);
    const next = t.querySelector('.ui-paginator-next');
    return { headers, rows, links, hasNext: !!next && !next.classList.contains('ui-state-disabled'), first: rows[0]?.join('|') };
  });
  const first = await extract();
  if (!first) return { headers: [], rows: [] };
  const all = [...first.rows];
  const links = [...first.links];
  let cur = first;
  for (let p = 0; p < 20 && cur.hasNext; p++) {
    await page.locator('.ui-paginator-next').first().click();
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); const n = await extract(); if (n && n.first !== cur.first) { cur = n; break; } }
    all.push(...cur.rows); links.push(...cur.links);
  }
  const headers = first.headers;
  const objects = all.map(r => Object.fromEntries(r.map((v, i) => [headers[i] || `col${i + 1}`, v]).filter(([k, v]) => k || v)));
  return { headers, rows: objects, ...(links.length ? { documents: [...new Set(links)] } : {}) };
}

export function table({ view }) {
  const labels = Object.hasOwn(VIEWS, view) ? VIEWS[view] : null; // no inherited keys like "__proto__"
  if (!labels) throw new Error(`view must be one of: ${Object.keys(VIEWS).join(', ')}`);
  return withBrowser(async (c) => {
    const page = await aurionPage(c);
    try {
      await navMenu(page, labels);
      const t = await readTable(page);
      return { view, ...t, count: t.rows.length };
    } finally { await page.close().catch(() => {}); }
  });
}

// Example: "On campus - De 09:00 à 12:00 - CORPORATE FINANCE - Madam DUPONT - E 204 - Lecture - "
function parseEvent(e) {
  const parts = String(e.title || '').split(' - ').map(s => s.trim());
  const [mode, , course, teacher, room, type, ...rest] = parts;
  return {
    start: e.start, end: e.end,
    course: course || e.title, teacher: teacher || null, room: room || null, type: type || null, mode: mode || null,
    note: rest.filter(Boolean).join(' - ') || null,
    kind: e.className || null,
  };
}

const DAY = 864e5;
export function timetable({ from, to } = {}) {
  const local = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('from must be YYYY-MM-DD');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('to must be YYYY-MM-DD');
  const start = from ? local(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const end = to ? local(to) : new Date(start.getTime() + 7 * DAY);
  if (isNaN(start) || isNaN(end) || end <= start) throw new Error('from/to must be valid dates (YYYY-MM-DD) with to after from');
  if (end - start > 120 * DAY) throw new Error('Range too long (max 120 days)');
  return withBrowser(async (c) => {
    const page = await aurionPage(c);
    try {
      await navMenu(page, ['Schedule', 'My timetable']);
      await page.waitForURL(/Planning/, { timeout: 30000 }).catch(() => {});
      await page.waitForSelector('.fc', { state: 'attached', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      // Ask the schedule component for events the same way its own "next week" button does.
      const xml = await page.evaluate(async ({ s, e }) => {
        // The schedule's client id is the nearest id around the FullCalendar element (minus "_container").
        const el = document.querySelector('.fc')?.closest('[id]');
        const id = el?.id?.replace(/_container$/, '');
        if (!id || !document.getElementById(id)) throw new Error('timetable component not found');
        const form = document.getElementById(id).closest('form');
        const fd = new URLSearchParams(new FormData(form));
        fd.set('javax.faces.partial.ajax', 'true');
        fd.set('javax.faces.source', id);
        fd.set('javax.faces.partial.execute', id);
        fd.set('javax.faces.partial.render', id);
        fd.set(id, id);
        fd.set(`${id}_start`, String(s));
        fd.set(`${id}_end`, String(e));
        const r = await fetch(form.action, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Faces-Request': 'partial/ajax', 'X-Requested-With': 'XMLHttpRequest' },
          body: fd.toString(),
        });
        return { id, text: await r.text() };
      }, { s: start.getTime(), e: end.getTime() });
      const m = xml.text.match(/\{"events"\s*:[\s\S]*?\]\s*\}(?=\]\]>)/);
      if (!m) {
        const hint = /ViewExpired|viewExpired/.test(xml.text) ? 'session view expired' : /<redirect/.test(xml.text) ? 'redirected (signed out?)' : 'unexpected response';
        throw new Error(`Aurion did not return timetable data (${hint})`);
      }
      const events = JSON.parse(m[0]).events.map(parseEvent).sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { from: ymd(start), to: ymd(end), count: events.length, events };
    } finally { await page.close().catch(() => {}); }
  });
}

// Download the official "Certificat de scolarité" (school attendance certificate) PDF.
export function attendanceCertificate({ destDir }) {
  const root = checkDownloadDir(destDir);
  return withBrowser(async (c) => {
    const page = await aurionPage(c);
    try {
      await navMenu(page, ['Administrative documents', 'My School Attendance Certificate']);
      const link = page.locator('a', { hasText: /Certificat scolarit/i }).first();
      await link.waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await hideSpinner(page);
      // The PDF may arrive on this tab or on a new one, depending on Aurion's state.
      const dl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Aurion did not start the certificate download (try again in a minute)')); }, 90000);
        const onDl = (d) => { cleanup(); resolve(d); };
        const onPage = (p) => p.on('download', onDl);
        const cleanup = () => { clearTimeout(timer); page.off('download', onDl); c.off('page', onPage); };
        page.on('download', onDl);
        c.on('page', onPage);
        link.click().catch((e) => { cleanup(); reject(e); });
      });
      fs.mkdirSync(root, { recursive: true });
      const name = safeName(dl.suggestedFilename() || 'Certificat_scolarite.pdf');
      if (!/\.pdf$/i.test(name)) throw new Error(`Unexpected file type: ${name}`);
      const file = uniquePath(insideDir(root, name));
      await dl.saveAs(file);
      return { file, bytes: fs.statSync(file).size };
    } finally { await page.close().catch(() => {}); }
  });
}
