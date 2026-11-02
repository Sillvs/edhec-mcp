// Absences in Aurion: check what needs a proof, then report an absence in two confirmed steps.
//
// This is sensitive: a report goes to the EDHEC HUB Front Office and can decide whether a missed
// assessment counts as 0/20. So:
//   - aurion_absence_check is read-only and explains the rules with their source.
//   - aurion_absence_prepare only validates and shows the exact report. Nothing is sent.
//   - aurion_absence_submit sends exactly that report, once, after the user confirmed it,
//     and refuses if anything changed (files, time window, used or expired confirmation).
// The server never writes or rephrases reasons and never creates or edits documents.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { withBrowser } from './browser.js';
import { aurionPage, navMenu, readTable, hideSpinner, table, timetable } from './aurion.js';
import { listCourses, gradesAndDueDates } from './blackboard.js';
import { protectedReason } from './safety.js';

// ---------------------------------------------------------------------------
// Rules (shown with their source; they can differ between programmes)
// ---------------------------------------------------------------------------
export const RULES = {
  source: [
    'Aurion > Attendance > How to report my absences',
    'Programme Rules (Attendance chapter) and the programme Welcome Session, both on Blackboard > Programme Life',
  ],
  appliesTo: 'Checked against the MSc programme welcome session 2026-27. Other programmes (BBA, PGE, other MSc) can have different rules: always check your own Programme Rules.',
  summary: [
    'Attendance is compulsory and recorded with your student card at the start of each class.',
    'You may occasionally miss a class without a proof, but it stays recorded and you must catch up on the content.',
    'A proof is required when an assessment (quiz, midterm, exam, graded presentation, deadline) was scheduled during the absence.',
    'A missed assessment without an accepted proof counts as 0/20.',
    'An accepted proof lets you take the resit without the 10/20 cap.',
    'Accepted reasons for an uncapped resit: hospitalisation, declared long-term medical condition, illness during the assessment, an assessment centre or Spring recruitment event, death of a close family member, force majeure approved by the Programme Team.',
    'Submit the proof to the HUB Front Office within 48 hours of the start of the absence (via Aurion > Attendance > Report an absence).',
    'Proofs must be in English or French (pdf, jpg, jpeg or png). If you were ill during several assessments, submit one report per assessment with its date, time and course.',
    'Too many absences can exclude you from the first exam session (resit capped at 10/20).',
  ],
};

const ASSESSMENT_WORDS = /exam|examen|assessment|quiz|mcq|qcm|test|partiel|midterm|mid-term|final|évaluation|evaluation|soutenance|oral|presentation|pitch|défense|defense/i;

// "10/29/26" -> Date (local); "10:00 - 13:00" -> [start, end]
function parseAurionDate(d) {
  const m = String(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(y, Number(m[1]) - 1, Number(m[2]));
}
function withTime(day, hhmm) {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  const d = new Date(day);
  if (m) d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmt = (d) => `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// 1) Check (read-only)
// ---------------------------------------------------------------------------
export async function check({ now = new Date() } = {}) {
  const abs = await table({ view: 'absences' });
  const proofs = await table({ view: 'proofs_of_absence' });

  const items = abs.rows.map((r) => {
    const day = parseAurionDate(r.Date);
    const [from, to] = String(r['Schedule or timesheet'] || '').split('-').map(s => s.trim());
    return { raw: r, day, start: day && withTime(day, from), end: day && withTime(day, to) };
  }).filter(x => x.day);

  // Timetable around the absences (Aurion, max 120 days per call)
  const tt = [];
  const recent = items.filter(x => now - x.day < 120 * 864e5);
  if (recent.length) {
    const min = new Date(Math.min(...recent.map(x => x.day)));
    const max = new Date(Math.max(...recent.map(x => x.day)) + 864e5);
    try { tt.push(...(await timetable({ from: ymd(min), to: ymd(max) })).events); } catch { /* evidence stays partial */ }
  }

  // Blackboard gradebook per course (due dates on the day of the absence)
  let courses = [];
  try { courses = await listCourses({ includeHidden: true }); } catch { /* ignore */ }
  const gradebooks = new Map();
  for (const name of [...new Set(items.map(x => String(x.raw.Course || '').toUpperCase()))]) {
    const c = courses.find(cc => String(cc.name || '').toUpperCase().includes(name));
    if (!c) continue;
    try { gradebooks.set(name, (await gradesAndDueDates({ course: c.id })).columns); } catch { /* ignore */ }
  }

  const proofRows = proofs.rows.map(p => ({
    status: p['Statut du justificatif'] || p.Status || '',
    reason: p.Motif || '',
    from: p['Début'] || p.Start || '',
    to: p.Fin || p.End || '',
  }));

  const results = items.map((x) => {
    const course = String(x.raw.Course || '');
    const evidence = [];
    let assessment = 'no evidence';
    for (const e of tt) {
      const s = new Date(e.start);
      if (!sameDay(s, x.day)) continue;
      if (String(e.course || '').toUpperCase().includes(course.toUpperCase()) && ASSESSMENT_WORDS.test(`${e.type} ${e.note} ${e.kind}`)) {
        assessment = 'yes'; evidence.push(`Timetable: ${e.type || e.kind} ${fmt(s)}`);
      }
    }
    const cols = gradebooks.get(course.toUpperCase()) || [];
    for (const col of cols) {
      if (col.due && sameDay(new Date(col.due), x.day)) { assessment = 'yes'; evidence.push(`Blackboard: "${col.name}" due ${fmt(new Date(col.due))}`); }
    }
    if (assessment !== 'yes') {
      const undated = cols.filter(col => !col.due && /quiz|mcq|qcm|test|exam/i.test(col.name));
      if (undated.length) { assessment = 'possible'; evidence.push(`Blackboard has undated graded items: ${undated.map(u => `"${u.name}"`).join(', ')}`); }
    }

    const deadline = new Date(x.start.getTime() + 48 * 3600e3);
    const hoursLeft = Math.round((deadline - now) / 3600e3);
    const proof = proofRows.find(p => p.from && (p.from.includes(ymd(x.day)) || p.from.includes(x.raw.Date)));

    let advice;
    if (proof) advice = `A proof is on file (status: ${proof.status || 'unknown'}). Check its status under My proofs of absence.`;
    else if (assessment === 'yes' && hoursLeft > 0) advice = `Assessment found: submit a proof before ${fmt(deadline)} (${hoursLeft} h left), otherwise the assessment counts as 0/20.`;
    else if (assessment === 'yes') advice = 'Assessment found and the 48 h window has passed: contact the HUB Front Office now and explain. A late proof may not be accepted.';
    else if (assessment === 'possible') advice = 'This course has in-class quizzes without a date. If one took place in this session, a proof is needed (48 h). Ask the professor or check the syllabus.';
    else advice = 'No assessment found for this session: no proof is required. The absence stays on your record and can affect participation.';

    return {
      date: ymd(x.day), time: x.raw['Schedule or timesheet'], course, duration: x.raw.Duration,
      recordedAs: x.raw['Reason of absence'], assessment, evidence,
      proofDeadline: fmt(deadline), hoursLeft, proofOnFile: !!proof, advice,
    };
  });

  return { rules: RULES, absences: results, proofsOnFile: proofRows };
}

// ---------------------------------------------------------------------------
// 2) Prepare (validate, show the exact report, nothing is sent)
// ---------------------------------------------------------------------------
const pending = new Map(); // confirmationId -> { report, files, expires, used }
const TTL_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
const D = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocal(s, re, what) {
  const m = String(s || '').match(re);
  if (!m) throw new Error(`${what} must look like ${re === DT ? 'YYYY-MM-DDTHH:MM' : 'YYYY-MM-DD'}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  if (isNaN(d) || d.getMonth() !== Number(m[2]) - 1) throw new Error(`${what} is not a real date`);
  return d;
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function checkProofFile(f) {
  if (typeof f !== 'string' || !path.isAbsolute(f)) throw new Error(`Use the absolute path of the proof file: ${f}`);
  if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
  const real = fs.realpathSync.native ? fs.realpathSync.native(f) : fs.realpathSync(f);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`Not a regular file: ${f}`);
  if (!/\.(pdf|jpe?g|png)$/i.test(real)) throw new Error(`Aurion only accepts pdf, jpg, jpeg or png: ${f}`);
  if (st.size === 0 || st.size > MAX_FILE_BYTES) throw new Error(`Proof file must be between 1 byte and 10 MB: ${f}`);
  const why = protectedReason(real);
  if (why) throw new Error(`Refusing to upload from ${why}: ${f}`);
  return { path: real, name: path.basename(real), bytes: st.size, sha256: sha256(real) };
}

export function prepare({ start, end, reason, files, assessment, now = new Date() }) {
  const s = parseLocal(start, DT, 'start');
  const e = parseLocal(end, DT, 'end');
  if (e <= s) throw new Error('end must be after start');
  if (e - s > 31 * 864e5) throw new Error('One report can cover at most 31 days');
  if (now - s > 365 * 864e5) throw new Error('start is more than a year ago');
  if (s - now > 90 * 864e5) throw new Error('start is more than 90 days ahead');

  const text = String(reason || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (text.length < 5 || text.length > 1500) throw new Error('reason must be 5 to 1500 characters, in the user\'s own words');

  if (!Array.isArray(files) || files.length < 1 || files.length > 2) throw new Error('Aurion requires 1 or 2 proof files');
  const checked = files.map(checkProofFile);
  if (new Set(checked.map(f => f.path)).size !== checked.length) throw new Error('The same file was given twice');

  let a = null;
  if (assessment) {
    const day = parseLocal(assessment.date, D, 'assessment.date');
    const dayEnd = new Date(day.getTime() + 864e5);
    if (dayEnd <= new Date(s.getFullYear(), s.getMonth(), s.getDate()) || day > e) throw new Error('assessment.date must fall inside the absence');
    if (!/^[A-Za-z0-9_ .\-]{2,80}$/.test(String(assessment.courseCode || ''))) throw new Error('assessment.courseCode must be the course code, e.g. 27_M2_..._1234');
    a = { date: ymd(day), courseCode: String(assessment.courseCode).trim() };
  }

  const warnings = [];
  const hoursSinceStart = (now - s) / 3600e3;
  if (hoursSinceStart > 48) warnings.push(`The absence started ${Math.round(hoursSinceStart)} h ago. The rule is 48 h, so the Front Office may refuse a late proof.`);
  if (a && (e - s) > 864e5) warnings.push('If you missed several assessments, EDHEC asks for one report per assessment.');
  if (!a) warnings.push('No assessment declared. Only declare one if an assessment really was scheduled during the absence.');

  const report = {
    start: fmt(s), end: fmt(e), status: 'Déclaration absence / absence request',
    reason: text, assessment: a, files: checked.map(({ name, bytes }) => ({ name, bytes })),
  };
  const id = crypto.randomUUID();
  pending.set(id, { report, files: checked, expires: now.getTime() + TTL_MS, used: false, s, e });
  for (const [k, v] of pending) if (v.expires < Date.now() - TTL_MS) pending.delete(k);

  return {
    sent: false,
    report,
    warnings,
    confirmationId: id,
    expiresInMinutes: TTL_MS / 60000,
    nextStep: 'Show this exact report to the user. Only after they explicitly confirm it, call aurion_absence_submit with this confirmationId.',
  };
}

// Claim a confirmation. Exported for tests. consume=false is used for dry runs.
export function claimConfirmation(id, { consume = true, now = Date.now() } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown confirmationId');
  const p = pending.get(id);
  if (!p) throw new Error('Unknown confirmationId. Call aurion_absence_prepare again.');
  if (p.used) throw new Error('This confirmation was already used. Prepare a new report if you really need to send another one.');
  if (now > p.expires) { pending.delete(id); throw new Error('This confirmation expired (10 minutes). Prepare the report again.'); }
  for (const f of p.files) {
    if (!fs.existsSync(f.path) || sha256(f.path) !== f.sha256) throw new Error(`The file ${f.name} changed after the preview. Prepare the report again.`);
  }
  if (consume) p.used = true;
  return p;
}

// ---------------------------------------------------------------------------
// 3) Submit (exactly the prepared report, once)
// ---------------------------------------------------------------------------
const auDate = (d, withTimeToo = true) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` +
  (withTimeToo ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '');

export function submit({ confirmationId, dryRun = false }) {
  const p = claimConfirmation(confirmationId, { consume: !dryRun });
  return withBrowser(async (c) => {
    const page = await aurionPage(c);
    const blocked = [];
    try {
      await navMenu(page, ['Attendance', 'Report an absence']);
      await page.waitForSelector('[id$="dateFin_indispo_input"]', { timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await hideSpinner(page);
      if (dryRun) {
        // From here on nothing may reach the server.
        await page.route('**/*', (r) => (r.request().method() === 'GET' ? r.continue() : (blocked.push(r.request().method()), r.abort())));
      }

      const ids = await page.evaluate(() => {
        const q = (suffix) => document.querySelector(`[id$="${suffix}"]`)?.id;
        return {
          start: q('composant_0_2_input'), end: q('dateFin_indispo_input'), reason: q('composant_0_7'),
          assessBox: q('composant_0_8'), assessDate: q('composant_0_9_input'), course: q('composant_0_10'),
        };
      });
      if (!ids.start || !ids.end || !ids.reason) throw new Error('The Aurion absence form looks different than expected. Nothing was sent.');

      const setCal = (id, value) => page.evaluate(({ id, value }) => {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }, { id, value });

      await setCal(ids.start, auDate(p.s));
      await setCal(ids.end, auDate(p.e));
      await page.getByText('Déclaration absence/ absence request', { exact: false }).first().click();
      await page.locator(`[id="${ids.reason}"]`).fill(p.report.reason);
      if (p.report.assessment) {
        const box = page.locator(`[id="${ids.assessBox}"] .ui-chkbox-box`);
        await box.scrollIntoViewIfNeeded();
        if (!(await page.locator(`[id="${ids.assessBox}"] .ui-chkbox-box.ui-state-active`).count())) await box.click();
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const [y, m, d] = p.report.assessment.date.split('-').map(Number);
        await setCal(ids.assessDate, auDate(new Date(y, m - 1, d), false));
        await page.locator(`[id="${ids.course}"]`).fill(p.report.assessment.courseCode);
      }

      // Read everything back before anything is sent.
      const back = await page.evaluate((ids) => ({
        start: document.getElementById(ids.start).value,
        end: document.getElementById(ids.end).value,
        reason: document.getElementById(ids.reason).value,
        statusChecked: !!document.querySelector('[id$="composant_0_5:0"]')?.checked || !!document.querySelector('[id*="composant_0_5"] .ui-state-active'),
        assessment: !!document.querySelector(`[id="${ids.assessBox}"] input`)?.checked
          && !!document.querySelector(`[id="${ids.assessBox}"] .ui-chkbox-box.ui-state-active`),
        anyDisabled: [ids.start, ids.end, ids.reason, ids.assessDate, ids.course].filter(Boolean)
          .some(i => document.getElementById(i)?.disabled || document.getElementById(i)?.readOnly && i !== ids.start && i !== ids.end),
        assessDate: ids.assessDate ? document.getElementById(ids.assessDate)?.value : '',
        course: ids.course ? document.getElementById(ids.course)?.value : '',
      }), ids);
      const expected = {
        start: auDate(p.s), end: auDate(p.e), reason: p.report.reason, statusChecked: true, assessment: !!p.report.assessment, anyDisabled: false,
        assessDate: p.report.assessment ? auDate(new Date(...p.report.assessment.date.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))), false) : back.assessDate,
        course: p.report.assessment ? p.report.assessment.courseCode : back.course,
      };
      const mismatch = Object.keys(expected).filter(k => String(back[k]) !== String(expected[k]));
      if (mismatch.length) throw new Error(`The form did not take these values: ${mismatch.join(', ')}. Nothing was sent.`);

      if (dryRun) {
        const shot = path.join(os.tmpdir(), `edhec-mcp-absence-dryrun-${Date.now()}.png`);
        // Hide the floating Validate bar so it cannot cover fields in the screenshot.
        await page.addStyleTag({ content: '.ui-panel-footer, .fixed-bottom, [class*="footer"][style*="fixed"] { position: static !important; }' }).catch(() => {});
        await page.locator('form').first().screenshot({ path: shot }).catch(() => page.screenshot({ path: shot, fullPage: true }));
        return { sent: false, dryRun: true, formFilled: back, filesNotUploaded: p.report.files.map(f => f.name), blockedRequests: blocked.length, screenshot: shot, note: 'Dry run: the form was filled and checked, nothing was uploaded or submitted.' };
      }

      // Upload proofs: Aurion uploads each file as soon as it is chosen.
      for (const [i, f] of p.files.entries()) {
        await page.locator(`input[id="form:docUpload:${i}:ajouterDocument_input"]`).setInputFiles(f.path);
        await page.getByText(f.name, { exact: false }).first().waitFor({ timeout: 60000 }).catch(() => {
          throw new Error(`Upload of ${f.name} did not finish. The report was NOT submitted; check Aurion before trying again.`);
        });
      }

      await page.getByRole('button', { name: /^\s*Validate\s*$/ }).click();
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const messages = await page.evaluate(() => Array.from(document.querySelectorAll('.ui-messages, .ui-growl, .ui-message, .ui-messages-error, .ui-messages-info'))
        .map(m => m.innerText.trim()).filter(Boolean).join(' | '));
      const errorShown = await page.locator('.ui-messages-error, .ui-message-error, .ui-state-error').count();

      // Verify on the proofs page.
      await navMenu(page, ['My proofs of absence']).catch(() => {});
      const proofs = await readTable(page).catch(() => ({ rows: [] }));
      const day = auDate(p.s, false);
      const found = proofs.rows.some(r => Object.values(r).some(v => String(v).includes(day)));

      return {
        sent: !errorShown,
        aurionMessage: messages || null,
        visibleInMyProofs: found,
        report: p.report,
        next: found ? 'The Front Office will review it. Check the status later with aurion_view proofs_of_absence.' : 'Not visible yet in My proofs of absence. Check Aurion before sending anything again.',
      };
    } finally { await page.close().catch(() => {}); }
  });
}
