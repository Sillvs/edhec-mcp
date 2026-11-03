// End-to-end check over MCP stdio (needs a signed-in profile): node test/e2e.mjs
// Read-only: it does not print, cancel, book or pay anything.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/index.js'] }));
const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map(t => t.name).join(', '));
let failed = 0;
const call = async (name, args = {}, expectError = false) => {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 240000 });
  const okish = expectError ? r.isError : !r.isError;
  if (!okish) failed++;
  const imgs = r.content.filter(c => c.type === 'image').length;
  console.log(`${okish ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(args).slice(0, 60)} (${Date.now() - t}ms${imgs ? `, ${imgs} images` : ''}): ${r.content[0].text.replace(/\s+/g, ' ').slice(0, 150)}`);
  return r;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edhec-e2e-'));
const courses = JSON.parse((await call('bb_list_courses')).content[0].text).result;
await call('bb_course_contents', { course: courses[0].id, maxDepth: 1 });
await call('bb_announcements', { course: courses[0].id, limit: 2 });
await call('bb_grades', { course: courses[0].id });
await call('bb_upcoming', { days: 30 });
await call('bb_download_files', { course: courses[0].id, destDir: tmp });
await call('bb_api_get', { path: '/v1/users/me' });
await call('eprint_status');
await call('aurion_timetable', {});
for (const view of ['grades', 'absences', 'rooms_now', 'groups']) await call('aurion_view', { view });
await call('aurion_certificate', { destDir: tmp });
await call('aurion_absence_check');
await call('resto_balance');
await call('resto_history', { limit: 3 });
await call('resto_services');
await call('resto_menu', { site: 'edhec' });
// The snack corner only takes orders in the morning (Paris time); outside that window the tool must say so.
const parisHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
await call('resto_order_offer', {}, !(parisHour >= 6 && parisHour < 10));
// must be refused
await call('bb_download_files', { course: courses[0].id, destDir: path.join(os.homedir(), '.ssh') }, true);
await call('bb_api_get', { path: '/v1/../../admin' }, true);
await call('aurion_view', { view: '__proto__' }, true);
await call('eprint_submit', { files: ['/etc/hosts'] }, true);
await call('aurion_absence_submit', { confirmationId: '00000000-0000-0000-0000-000000000000' }, true);
await call('resto_order_confirm', { confirmationId: '00000000-0000-0000-0000-000000000000', expectedTotalEUR: 1 }, true);
await call('resto_order_prepare', { main: 'thon mayo', sides: [] }, true);
await call('aurion_absence_prepare', { start: '2026-11-02T09:00', end: '2026-11-02T08:00', reason: 'test reason', files: ['/etc/hosts'] }, true);
await client.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
