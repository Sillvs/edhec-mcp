// PaperCut MF web interface at eprinting.edhec.edu (no public API, so we drive the pages).
import fs from 'node:fs';
import path from 'node:path';
import { withBrowser, pcPage, PC } from './browser.js';
import { protectedReason, UNTRUSTED_NOTE } from './safety.js';

export const PRINTERS = {
  a4: 'slippcpri01\\EPRINTING',
  a3: 'slippcpri01\\EPRINTING-A3',
  staple: 'slippcpri01\\EPRINTING-STAPPLES',
};

// Rows of the "Jobs Pending Release" table.
async function readJobs(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelector('td.documentColumnValue')).map(tr => {
    const cell = (cls) => (tr.querySelector(`td.${cls}`)?.innerText || '').trim();
    return {
      submitted: cell('dateColumnValue'),
      printer: cell('printerColumnValue'),
      document: cell('documentColumnValue'),
      client: cell('clientColumnValue'),
      pages: Number(cell('pagesColumnValue')) || cell('pagesColumnValue'),
      cost: cell('costColumnValue'),
      state: /Canceling|Cancelled|Annul/i.test(tr.innerText) ? 'cancelling' : 'held',
    };
  }));
}

// Document types only. Plain text is left out on purpose: it is the easiest way to leak
// config files or keys if a prompt injection ever talked the model into "printing" them.
const ALLOWED = /\.(pdf|docx?|docm|dotx?|dotm|rtf|xlsx?|xlsm|xlsb|xltx|xltm|pptx?|pptm|ppsx?|potx?|bmp|gif|jpe?g|png|tiff?|xps)$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 10;

// Resolve symlinks (with the real on-disk casing) and refuse secrets, hidden paths and non-documents.
export function checkPrintable(f) {
  if (typeof f !== 'string' || !path.isAbsolute(f)) throw new Error(`Use absolute paths: ${f}`);
  if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
  const real = fs.realpathSync.native ? fs.realpathSync.native(f) : fs.realpathSync(f);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`Not a regular file: ${f}`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`File larger than 100 MB: ${f}`);
  if (!ALLOWED.test(real)) throw new Error(`Only documents and images can be printed (pdf, Office, images, xps): ${f}`);
  const why = protectedReason(real);
  if (why) throw new Error(`Refusing to print from ${why}: ${f}`);
  return real;
}

export function status() {
  return withBrowser(async (c) => {
    const page = await pcPage(c, 'UserSummary');
    try {
      const balance = (await page.locator('.stat-bal .val').first().innerText().catch(() => '')).trim();
      await page.goto(`${PC}/app?service=page/UserReleaseJobs`, { waitUntil: 'domcontentloaded' });
      const jobs = await readJobs(page);
      return { note: UNTRUSTED_NOTE, balance, pendingJobs: jobs };
    } finally { await page.close().catch(() => {}); }
  });
}

export function submit({ files, printer = 'a4', copies = 1 }) {
  const printerName = Object.hasOwn(PRINTERS, printer) ? PRINTERS[printer] : null;
  if (!printerName) throw new Error(`printer must be one of: ${Object.keys(PRINTERS).join(', ')}`);
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw new Error(`Give 1 to ${MAX_FILES} files`);
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) throw new Error('copies must be 1 to 10');
  files = files.map(checkPrintable);
  return withBrowser(async (c) => {
    const page = await pcPage(c, 'UserWebPrint');
    try {
      await page.getByRole('link', { name: /Submit a Job/i }).click();
      await page.waitForLoadState('domcontentloaded');

      // Step 1: printer
      const target = page.locator('tr', { hasText: printerName }).locator('input[type=radio]').first();
      await target.check();
      await page.getByRole('button', { name: /Print Options and Account Selection/i }).click();
      await page.waitForLoadState('domcontentloaded');
      if (await page.getByText(/Please select a printer/i).count()) throw new Error('PaperCut did not accept the printer selection');

      // Step 2: copies, personal account
      const copiesBox = page.getByRole('textbox', { name: /Copies/i });
      if (await copiesBox.count()) await copiesBox.fill(String(copies));
      await page.getByRole('button', { name: /Upload Documents/i }).click();
      await page.waitForLoadState('domcontentloaded');

      // Step 3: upload via Dropzone's hidden input
      // PaperCut has a plain #upload-input that Dropzone ignores; Dropzone's own input has no id.
      await page.locator('input[type=file]:not(#upload-input)').first().setInputFiles(files);
      await page.waitForFunction((n) => window.Dropzone?.instances?.[0]?.getQueuedFiles().length === n, files.length, { timeout: 20000 });
      await page.getByRole('button', { name: /Upload & Complete/i }).click();
      await page.getByText(/successfully submitted/i).waitFor({ timeout: 120000 });
      const msg = (await page.getByText(/successfully submitted/i).first().innerText()).trim();

      // New jobs need a few seconds to be rendered before they show up in the queue.
      let jobs = [];
      for (let i = 0; i < 10; i++) {
        await page.goto(`${PC}/app?service=page/UserReleaseJobs`, { waitUntil: 'domcontentloaded' });
        jobs = await readJobs(page);
        const names = files.map(f => path.basename(f));
        if (names.every(n => jobs.some(j => j.document === n))) break;
        await page.waitForTimeout(3000);
      }
      return { printer: printerName, copies, message: msg, pendingJobs: jobs, note: 'Jobs are held until released at a printer with your card/login.' };
    } finally { await page.close().catch(() => {}); }
  });
}

export function cancel({ document }) {
  if (!document || document.length < 3) throw new Error('Give at least 3 characters of the document name');
  return withBrowser(async (c) => {
    const page = await pcPage(c, 'UserReleaseJobs');
    try {
      const rows = page.locator('tr', { has: page.locator('td.documentColumnValue', { hasText: document }) });
      let n = await rows.count();
      for (let i = 0; i < 6 && n === 0; i++) {   // a just-submitted job may still be rendering
        await page.waitForTimeout(3000);
        await page.reload({ waitUntil: 'domcontentloaded' });
        n = await rows.count();
      }
      if (n === 0) throw new Error(`No held job matches "${document}"`);
      if (n > 1) {
        const names = await rows.locator('td.documentColumnValue').allInnerTexts();
        throw new Error(`"${document}" matches ${n} jobs, be more specific: ${names.join(' | ')}`);
      }
      const name = (await rows.locator('td.documentColumnValue').innerText()).trim();
      await rows.getByRole('link', { name: /cancel/i }).click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const jobs = await readJobs(page);
      const still = jobs.find(j => j.document === name && j.state !== 'cancelling');
      return { cancelled: name, confirmed: !still, pendingJobs: jobs };
    } finally { await page.close().catch(() => {}); }
  });
}
