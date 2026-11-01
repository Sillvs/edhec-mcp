// Blackboard Learn REST API, called with the student's own browser session.
import fs from 'node:fs';
import path from 'node:path';
import { withBrowser, ensureBlackboard, BB } from './browser.js';
import { safeName, insideDir, checkDownloadDir, uniquePath, EXECUTABLE_EXT, UNTRUSTED_NOTE, redact } from './safety.js';

const API = `${BB}/learn/api/public`;

const stripHtml = (s = '') => s
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

export { safeName, insideDir } from './safety.js';

const ID_RE = /^_\d+_\d+$/;
function checkId(v, what) {
  if (v != null && !ID_RE.test(v)) throw new Error(`${what} must look like "_12345_1"`);
  return v;
}

async function getJson(c, url) {
  const u = new URL(url.startsWith('http') ? url : `${API}${url}`);
  if (u.origin !== BB || u.username || u.password) throw new Error(`Refusing request to ${u.origin}`);
  let r;
  try { r = await c.request.get(u.toString(), { failOnStatusCode: false, maxRedirects: 0, timeout: 30000 }); }
  catch (e) { throw new Error(`Blackboard request failed for ${u.pathname}: ${redact(e.message).split('\n')[0]}`); }
  const status = r.status();
  let body = null;
  try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status, body };
}

async function getAll(c, url) {
  const out = [];
  let next = url;
  for (let pages = 0; next; pages++) {
    if (pages >= 50) throw new Error('Too many result pages (stopped at 50)');
    const { status, body } = await getJson(c, next);
    if (status !== 200) throw new Error(`Blackboard API ${status} for ${next}: ${JSON.stringify(body).slice(0, 300)}`);
    out.push(...(body.results || []));
    next = body.paging?.nextPage ? `${BB}${body.paging.nextPage}` : null;
  }
  return out;
}

async function me(c) {
  const { body } = await getJson(c, '/v1/users/me');
  return body;
}

// Accepts "_12345_1", a course code, or a course URL.
async function resolveCourseId(c, ref) {
  const m = String(ref).match(/_\d+_\d+/);
  if (m) return m[0];
  if (!/^[A-Za-z0-9_.\-]{3,100}$/.test(String(ref))) throw new Error(`Invalid course reference: ${ref}`);
  const { status, body } = await getJson(c, `/v3/courses/courseId:${encodeURIComponent(ref)}`);
  if (status === 200 && ID_RE.test(body?.id)) return body.id;
  throw new Error(`Course not found: ${ref}`);
}

const bb = (fn) => withBrowser(async (c) => { await ensureBlackboard(c); return fn(c); });

export function listCourses({ includeHidden = false } = {}) {
  return bb(async (c) => {
    const u = await me(c);
    const mships = await getAll(c, `/v1/users/${u.id}/courses?expand=course&limit=100`);
    return mships
      .filter(m => includeHidden || m.availability?.available !== 'No')
      .map(m => ({
        id: m.course?.id || m.courseId,
        courseCode: m.course?.courseId,
        name: m.course?.name,
        role: m.courseRoleId,
        lastAccessed: m.lastAccessed,
        url: m.course?.externalAccessUrl,
      }))
      .sort((a, b) => String(b.lastAccessed || '').localeCompare(String(a.lastAccessed || '')));
  });
}

async function walk(c, courseId, parentId, depth, maxDepth, pathParts, out) {
  const url = parentId ? `/v1/courses/${courseId}/contents/${parentId}/children?limit=200` : `/v1/courses/${courseId}/contents?limit=200`;
  let items;
  try { items = await getAll(c, url); } catch (e) { out.push({ depth, path: pathParts.join(' / '), error: e.message }); return; }
  for (const it of items) {
    const h = it.contentHandler || {};
    const node = {
      depth,
      path: pathParts.join(' / '),
      id: it.id,
      title: it.title,
      type: h.id,
      available: it.availability?.available,
    };
    const text = stripHtml(it.body || it.description || '');
    if (text) node.text = text.slice(0, 1500);
    if (h.url) node.url = h.url;
    if (h.gradeColumnId) node.gradeColumnId = h.gradeColumnId;
    if (h.id === 'resource/x-bb-file' || h.id === 'resource/x-bb-document' || h.id === 'resource/x-bb-assignment') {
      try {
        const att = await getAll(c, `/v1/courses/${courseId}/contents/${it.id}/attachments`);
        if (att.length) node.attachments = att.map(a => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType }));
      } catch { /* no attachments */ }
    }
    out.push(node);
    if (it.hasChildren && depth < maxDepth) await walk(c, courseId, it.id, depth + 1, maxDepth, [...pathParts, it.title], out);
  }
}

export function courseContents({ course, folderId, maxDepth = 6 }) {
  checkId(folderId, 'folderId');
  return bb(async (c) => {
    const id = await resolveCourseId(c, course);
    const out = [];
    await walk(c, id, folderId || null, 0, maxDepth, [], out);
    return { note: UNTRUSTED_NOTE, courseId: id, items: out };
  });
}

// Never overwrites: existing files are skipped (default) or saved as "name (1).ext".
export function downloadFiles({ course, destDir, folderId, onlyContentIds, skipExisting = true, includeExecutables = false }) {
  const root = checkDownloadDir(destDir);
  checkId(folderId, 'folderId');
  (onlyContentIds || []).forEach(x => checkId(x, 'onlyContentIds item'));
  const MAX_BYTES = 200 * 1024 * 1024;
  return bb(async (c) => {
    const id = await resolveCourseId(c, course);
    const items = [];
    await walk(c, id, folderId || null, 0, 8, [], items);
    fs.mkdirSync(root, { recursive: true });
    const results = [];
    for (const it of items) {
      if (!it.attachments) continue;
      if (onlyContentIds?.length && !onlyContentIds.includes(it.id)) continue;
      const sub = it.path ? it.path.split(' / ').map(safeName) : [];
      for (const a of it.attachments) {
        let file = '';
        try {
          file = insideDir(root, ...sub, safeName(a.fileName));
          if (!ID_RE.test(it.id) || !ID_RE.test(a.id)) { results.push({ file, status: 'skipped (unexpected id)' }); continue; }
          if (EXECUTABLE_EXT.test(file) && !includeExecutables) { results.push({ file, status: 'skipped (program or script, pass includeExecutables to save it)' }); continue; }
          if (fs.existsSync(file)) {
            if (skipExisting) { results.push({ file, status: 'skipped (exists)' }); continue; }
            file = uniquePath(file);
          }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          let r;
          try {
            r = await c.request.get(`${API}/v1/courses/${id}/contents/${it.id}/attachments/${a.id}/download`, { failOnStatusCode: false, timeout: 120000 });
          } catch (e) { results.push({ file, status: `error: ${redact(e.message).split('\n')[0]}` }); continue; }
          if (r.status() !== 200) { results.push({ file, status: `error ${r.status()}` }); continue; }
          const len = Number(r.headers()['content-length'] || 0);
          if (len > MAX_BYTES) { results.push({ file, status: 'skipped (larger than 200 MB)' }); continue; }
          const buf = await r.body();
          if (buf.length > MAX_BYTES) { results.push({ file, status: 'skipped (larger than 200 MB)' }); continue; }
          fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o644 }); // never overwrite, never follow a planted symlink
          results.push({ file, status: 'downloaded', bytes: buf.length });
        } catch (e) {
          results.push({ file: file || a.fileName, status: `error: ${redact(e.message).split('\n')[0]}` });
        }
      }
    }
    const links = items.filter(i => i.url).map(i => ({ path: i.path, title: i.title, url: i.url }));
    return { note: UNTRUSTED_NOTE, courseId: id, destDir: root, files: results, externalLinksNotDownloaded: links };
  });
}

export function announcements({ course, limit = 20 }) {
  return bb(async (c) => {
    const id = await resolveCourseId(c, course);
    const list = await getAll(c, `/v1/courses/${id}/announcements?limit=100`);
    const items = list
      .sort((a, b) => String(b.created).localeCompare(String(a.created)))
      .slice(0, limit)
      .map(a => ({ id: a.id, created: a.created, title: a.title, text: stripHtml(a.body).slice(0, 4000) }));
    return { note: UNTRUSTED_NOTE, courseId: id, announcements: items };
  });
}

// Gradebook columns: due dates, points and (when visible) the student's own grade.
export function gradesAndDueDates({ course }) {
  return bb(async (c) => {
    const id = await resolveCourseId(c, course);
    const u = await me(c);
    const cols = await getAll(c, `/v2/courses/${id}/gradebook/columns?limit=200`);
    const out = [];
    for (const col of cols) {
      const row = {
        id: col.id,
        name: col.name,
        due: col.grading?.due || null,
        pointsPossible: col.score?.possible ?? null,
        type: col.grading?.type,
      };
      const g = await getJson(c, `/v2/courses/${id}/gradebook/columns/${col.id}/users/${u.id}`);
      if (g.status === 200) {
        row.myGrade = g.body.displayGrade?.text ?? g.body.displayGrade?.score ?? g.body.score ?? null;
        row.status = g.body.status;
      }
      out.push(row);
    }
    return { courseId: id, columns: out };
  });
}

// Due items across all courses from the Blackboard calendar.
export function upcoming({ days = 21 } = {}) {
  return bb(async (c) => {
    const since = new Date();
    const until = new Date(Date.now() + days * 864e5);
    const q = `since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`;
    const { status, body } = await getJson(c, `/v1/calendars/items?${q}`);
    if (status !== 200) throw new Error(`Calendar API ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    return (body.results || []).map(i => ({
      type: i.type, title: i.title, start: i.start, end: i.end,
      calendar: i.calendarName || i.calendarId, location: i.location,
      text: stripHtml(i.description || '').slice(0, 500),
    })).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  });
}

// Read-only escape hatch for any public API GET endpoint.
// Only GET, only below /learn/api/public/vN/ on learning.edhec.edu.
export function apiGet({ path: p }) {
  if (typeof p !== 'string' || !/^\/v\d\/[A-Za-z0-9_\-/.:%?=&,+]*$/.test(p) || /\.\.|\/\/|\\|@/.test(p)) {
    throw new Error('path must look like /v1/... relative to /learn/api/public (no "..", "//", "@" or backslashes)');
  }
  const url = new URL(`${API}${p}`);
  if (url.origin !== BB || !url.pathname.startsWith('/learn/api/public/v')) throw new Error('Refusing request outside the Blackboard public API');
  return bb(async (c) => getJson(c, url.toString()));
}
