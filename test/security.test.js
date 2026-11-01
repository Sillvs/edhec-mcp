// Run: npm test   (no network, no browser)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeName, insideDir, apiGet, downloadFiles, courseContents } from '../src/blackboard.js';
import { submit, cancel } from '../src/eprint.js';

test('safeName neutralises path tricks from Blackboard file names', () => {
  for (const evil of ['..', '../../etc/passwd', '..\\..\\x', '.bashrc', '/abs/path', '-rf', '\u0000x', '   ', 'a/../../b']) {
    const n = safeName(evil);
    assert.ok(!n.includes('/') && !n.includes('\\'), evil);
    assert.ok(!n.startsWith('.') && !n.startsWith('-'), `${evil} -> ${n}`);
    assert.ok(n.length > 0);
  }
  assert.equal(safeName('Case Study v2.docx'), 'Case Study v2.docx');
});

test('insideDir refuses to escape the download folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edhec-'));
  assert.throws(() => insideDir(root, '..', 'x'));
  assert.throws(() => insideDir(root, '/etc/passwd'));
  assert.ok(insideDir(root, 'a', 'b.pdf').startsWith(root));
});

test('apiGet only allows the Blackboard public API', () => {
  for (const p of ['/v1/../../admin', '//evil.com/x', '/v1/users/me@evil.com', 'https://evil.com', '/learn/api/public/v1/x', '/v1/x\\y', '/v1/users/<script>']) {
    assert.throws(() => apiGet({ path: p }), p);
  }
});

test('download needs an absolute folder and valid ids', () => {
  assert.throws(() => downloadFiles({ course: '_1_1', destDir: 'relative/dir' }));
  assert.throws(() => downloadFiles({ course: '_1_1', destDir: '/tmp/x', folderId: '../x' }));
  assert.throws(() => courseContents({ course: '_1_1', folderId: '_1_1/../../x' }));
});

test('eprint_submit refuses secrets, hidden files and non-documents', () => {
  const home = os.homedir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edhec-'));
  const txt = path.join(tmp, 'notes.txt'); fs.writeFileSync(txt, 'x');
  const hiddenDir = path.join(tmp, '.secret'); fs.mkdirSync(hiddenDir);
  const hiddenPdf = path.join(hiddenDir, 'a.pdf'); fs.writeFileSync(hiddenPdf, '%PDF');
  const link = path.join(tmp, 'innocent.pdf'); fs.symlinkSync(hiddenPdf, link);
  for (const f of [txt, hiddenPdf, link, path.join(home, '.ssh', 'id_rsa'), 'relative.pdf', '/etc/hosts']) {
    assert.throws(() => submit({ files: [f] }), f);
  }
  assert.throws(() => submit({ files: [] }));
  assert.throws(() => submit({ files: [txt], printer: 'colour-laser' }));
  assert.throws(() => submit({ files: [txt], printer: '__proto__' }));
  assert.throws(() => submit({ files: Array(11).fill(txt) }));
});

test('eprint_cancel needs a specific name', () => {
  assert.throws(() => cancel({ document: '' }));
  assert.throws(() => cancel({ document: 'a' }));
});

import { redact, checkDownloadDir, protectedReason } from '../src/safety.js';
import { checkPrintable } from '../src/eprint.js';

test('redact strips browser call logs, cookies and tokens', () => {
  const msg = 'apiRequestContext.get: Timeout 30000ms exceeded.\nCall log:\n  - → GET https://x\n  - cookie: BbRouter=expires:123,id:ABC\n  - set-cookie: JSESSIONID=XYZ';
  const r = redact(msg);
  assert.ok(!/BbRouter|JSESSIONID|ABC|XYZ/.test(r), r);
  assert.ok(r.startsWith('apiRequestContext.get: Timeout'));
  const j = redact(JSON.stringify({ accessToken: 'abc123secret', user: 'x', note: 'ok' }));
  assert.ok(!j.includes('abc123secret'), j);
  assert.ok(!redact('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U').includes('eyJ'));
  assert.ok(!redact('token ' + 'a'.repeat(64)).includes('a'.repeat(64)));
});

test('downloads cannot target hidden, system or config folders', () => {
  const home = os.homedir();
  for (const d of [home, path.join(home, '.ssh'), path.join(home, '.claude'), path.join(home, 'Library', 'LaunchAgents'),
                   path.join(home, 'library', 'launchagents'), path.join(home, '.config', 'x'), '/etc', 'relative']) {
    assert.throws(() => checkDownloadDir(d), d);
  }
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'edhec-dl-'));
  assert.ok(checkDownloadDir(path.join(ok, 'Course A')));
});

test('protected folder check ignores letter case on macOS/Windows', () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  assert.ok(protectedReason(path.join(os.homedir(), 'library', 'keychains', 'x.pdf')));
  assert.ok(protectedReason(path.join(os.homedir(), 'LIBRARY', 'x.pdf')));
});

test('safeName handles Windows names, bidi spoofing and long unicode', () => {
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.pdf'), '_nul.pdf');
  assert.equal(safeName('report.pdf...'), 'report.pdf');
  assert.ok(!safeName('invoice‮fdp.exe').includes('‮'));
  const long = safeName('😀'.repeat(150) + '.pdf');
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.pdf'));
  assert.ok(!/�/.test(long));
});

test('checkPrintable refuses ~/Library with any casing', () => {
  const lib = path.join(os.homedir(), 'Library');
  if (!fs.existsSync(lib)) return;
  const f = fs.readdirSync(lib).map(n => path.join(lib, n)).find(p => /\.(pdf|png|jpg)$/i.test(p));
  if (f) assert.throws(() => checkPrintable(f));
});

import * as au from '../src/aurion.js';
import * as rs from '../src/resto.js';

test('aurion inputs are validated before any browser starts', () => {
  assert.throws(() => au.table({ view: 'admin' }));
  assert.throws(() => au.table({ view: '__proto__' }));
  assert.throws(() => au.timetable({ from: '2026-11-10', to: '2026-11-01' }));
  assert.throws(() => au.timetable({ from: '2026-01-01', to: '2026-12-31' }));
  assert.throws(() => au.timetable({ from: 'yesterday' }));
  assert.throws(() => au.attendanceCertificate({ destDir: path.join(os.homedir(), '.ssh') }));
  assert.throws(() => au.attendanceCertificate({ destDir: 'relative' }));
});

test('resto inputs are validated before any browser starts', () => {
  assert.throws(() => rs.menu({ site: '../../admin' }));
  assert.throws(() => rs.menu({ site: 'edhec', destDir: path.join(os.homedir(), 'Library') }));
});

test('badge and student numbers are redacted', () => {
  const r = redact(JSON.stringify({ Bagde: 'FAKE0001', Matricule: '00TEST0001', Solde: 1.5 }));
  assert.ok(!r.includes('FAKE0001') && !r.includes('00TEST0001') && r.includes('1.5'), r);
});
