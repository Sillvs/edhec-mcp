#!/usr/bin/env node
// Generates the animated SVG mockups used in README.md (docs/assets/*.svg).
// All data shown is fictional sample data. Run: node tools/make-docs-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const C = {
  ink: '#0f172a', sub: '#475569', faint: '#94a3b8', line: '#e2e8f0', panel: '#ffffff', bg: '#f8fafc',
  claude: '#d97757', bb: '#2563eb', au: '#7c3aed', pr: '#059669', food: '#ea580c', ok: '#16a34a', warn: '#b45309',
};
const SYSTEM = {
  blackboard: { name: 'Blackboard', color: C.bb, letter: 'B' },
  aurion: { name: 'Aurion', color: C.au, letter: 'A' },
  eprint: { name: 'ePrinting', color: C.pr, letter: 'P' },
  food: { name: 'Campus food', color: C.food, letter: 'F' },
  setup: { name: 'Setup', color: '#475569', letter: 'S' },
};
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Animated chat mockup. Each step appears at `at` seconds; the loop restarts.
// ---------------------------------------------------------------------------
function chat({ file, title, cycle = 11, user, tools, answer, height }) {
  const W = 820, pad = 28;
  let y = 64;
  const parts = [];
  const css = [];
  let n = 0;
  const appear = (atSec, extra = '') => {
    const id = `s${n++}`;
    const a = (atSec / cycle) * 100, b = Math.min(a + 3, 99);
    css.push(`.${id}{opacity:0;animation:${id} ${cycle}s infinite ${extra}}@keyframes ${id}{0%,${a.toFixed(2)}%{opacity:0;transform:translateY(6px)}${b.toFixed(2)}%,94%{opacity:1;transform:translateY(0)}100%{opacity:0}}`);
    return id;
  };

  // user bubble with typing effect
  const ulines = user.lines;
  const uh = 22 * ulines.length + 22;
  const uw = Math.min(560, Math.max(...ulines.map(l => l.length)) * 8.2 + 40);
  const ux = W - pad - uw;
  const ub = appear(0.3);
  const typeId = `t${n++}`;
  const typeEnd = ((0.4 + Math.max(...ulines.map(l => l.length)) * 0.035) / cycle) * 100;
  css.push(`.${typeId}{animation:${typeId} ${cycle}s infinite steps(40)}@keyframes ${typeId}{0%,${(0.4 / cycle * 100).toFixed(2)}%{width:0}${typeEnd.toFixed(2)}%,100%{width:${uw}px}}`);
  parts.push(`<g class="${ub}">
    <rect x="${ux}" y="${y}" width="${uw}" height="${uh}" rx="16" fill="${C.ink}"/>
    <clipPath id="c${typeId}"><rect class="${typeId}" x="${ux}" y="${y}" height="${uh}" width="0"/></clipPath>
    <g clip-path="url(#c${typeId})">${ulines.map((l, i) => `<text x="${ux + 20}" y="${y + 30 + i * 22}" fill="#fff" font-size="15">${esc(l)}</text>`).join('')}</g>
  </g>`);
  y += uh + 18;

  // tool call chips
  let t = 0.6 + Math.max(...ulines.map(l => l.length)) * 0.035 + 0.4;
  for (const tool of tools) {
    const sys = SYSTEM[tool.system];
    const id = appear(t);
    const spinId = `p${n++}`, doneId = `d${n++}`;
    const doneAt = t + (tool.ms || 900) / 1000;
    css.push(`.${spinId}{transform-origin:${pad + 26}px ${y + 17}px;animation:${spinId}r .8s linear infinite, ${spinId}o ${cycle}s infinite}@keyframes ${spinId}r{to{transform:rotate(360deg)}}@keyframes ${spinId}o{0%,${(doneAt / cycle * 100).toFixed(2)}%{opacity:1}${(doneAt / cycle * 100 + 0.5).toFixed(2)}%,100%{opacity:0}}`);
    css.push(`.${doneId}{opacity:0;animation:${doneId} ${cycle}s infinite}@keyframes ${doneId}{0%,${(doneAt / cycle * 100).toFixed(2)}%{opacity:0}${(doneAt / cycle * 100 + 0.5).toFixed(2)}%,94%{opacity:1}100%{opacity:0}}`);
    const label = `${tool.name}`;
    const w = 150 + label.length * 7.6 + (tool.args ? tool.args.length * 6.6 : 0);
    parts.push(`<g class="${id}">
      <rect x="${pad}" y="${y}" width="${w}" height="34" rx="17" fill="#fff" stroke="${C.line}"/>
      <circle class="${spinId}" cx="${pad + 26}" cy="${y + 17}" r="7" fill="none" stroke="${sys.color}" stroke-width="2.5" stroke-dasharray="30 14"/>
      <g class="${doneId}"><circle cx="${pad + 26}" cy="${y + 17}" r="9" fill="${C.ok}"/><path d="M${pad + 21.5} ${y + 17.5} l3 3 l6 -6.5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/></g>
      <rect x="${pad + 44}" y="${y + 8}" width="${sys.name.length * 7 + 14}" height="18" rx="9" fill="${sys.color}" opacity=".12"/>
      <text x="${pad + 51}" y="${y + 21}" fill="${sys.color}" font-size="11.5" font-weight="700">${esc(sys.name)}</text>
      <text x="${pad + 64 + sys.name.length * 7}" y="${y + 22}" fill="${C.ink}" font-size="13.5" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(label)}<tspan fill="${C.faint}">${esc(tool.args || '')}</tspan></text>
    </g>`);
    y += 44;
    t = doneAt + 0.25;
  }
  y += 6;

  // assistant answer: claude mark + rows
  const head = appear(t);
  parts.push(`<g class="${head}"><circle cx="${pad + 12}" cy="${y + 12}" r="12" fill="${C.claude}"/><path d="M${pad + 12} ${y + 4} l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z" fill="#fff"/></g>`);
  t += 0.35;
  for (const row of answer) {
    const id = appear(t);
    t += row.gap ?? 0.28;
    if (row.kind === 'text') {
      parts.push(`<g class="${id}">${row.lines.map((l, i) => `<text x="${pad + 36}" y="${y + 17 + i * 22}" fill="${C.ink}" font-size="15">${l}</text>`).join('')}</g>`);
      y += row.lines.length * 22 + 8;
    } else if (row.kind === 'card') {
      const h = 18 + row.rows.length * 26;
      const cw = W - pad * 2 - 36;
      parts.push(`<g class="${id}"><rect x="${pad + 36}" y="${y}" width="${cw}" height="${h}" rx="12" fill="${C.bg}" stroke="${C.line}"/>
        ${row.rows.map((r, i) => {
          const ry = y + 26 + i * 26;
          const chip = r.chip ? `<rect x="${pad + 52}" y="${ry - 13}" width="${r.chip.length * 7.2 + 14}" height="18" rx="9" fill="${r.color || C.sub}" opacity=".14"/><text x="${pad + 59}" y="${ry}" fill="${r.color || C.sub}" font-size="12" font-weight="700">${esc(r.chip)}</text>` : '';
          const off = r.chip ? r.chip.length * 7.2 + 26 : 0;
          return `${chip}<text x="${pad + 52 + off}" y="${ry}" fill="${C.ink}" font-size="14.5">${r.text}</text>${r.right ? `<text x="${pad + 36 + cw - 16}" y="${ry}" text-anchor="end" fill="${r.rightColor || C.sub}" font-size="14" font-weight="600">${esc(r.right)}</text>` : ''}`;
        }).join('')}</g>`);
      y += h + 12;
    } else if (row.kind === 'buttons') {
      parts.push(`<g class="${id}">${row.items.map((b, i) => {
        const bx = pad + 36 + i * 170;
        return `<rect x="${bx}" y="${y}" width="158" height="36" rx="10" fill="${b.primary ? C.ink : '#fff'}" stroke="${b.primary ? C.ink : C.line}"/><text x="${bx + 79}" y="${y + 23}" text-anchor="middle" fill="${b.primary ? '#fff' : C.ink}" font-size="14" font-weight="600">${esc(b.label)}</text>`;
      }).join('')}</g>`);
      y += 48;
    }
  }
  const H = height || y + 26;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">Animated mockup with fictional sample data: ${esc(user.lines.join(' '))}</desc>
<style>${css.join('\n')}</style>
<rect width="${W}" height="${H}" rx="18" fill="${C.panel}" stroke="${C.line}"/>
<rect width="${W}" height="44" rx="18" fill="${C.bg}"/><rect y="26" width="${W}" height="18" fill="${C.bg}"/><line x1="0" y1="44" x2="${W}" y2="44" stroke="${C.line}"/>
<circle cx="24" cy="22" r="6" fill="#ff5f57"/><circle cx="44" cy="22" r="6" fill="#febc2e"/><circle cx="64" cy="22" r="6" fill="#28c840"/>
<text x="${W / 2}" y="27" text-anchor="middle" fill="${C.sub}" font-size="13" font-weight="600">${esc(title)}</text>
${parts.join('\n')}
</svg>`;
  fs.writeFileSync(path.join(OUT, file), svg);
  return file;
}

// ---------------------------------------------------------------------------
// Scenes (fictional data)
// ---------------------------------------------------------------------------
chat({
  file: 'demo-timetable.svg', title: 'Claude  ·  edhec-mcp',
  user: { lines: ['What do I have tomorrow, and is anything due this week?'] },
  tools: [
    { system: 'aurion', name: 'aurion_timetable', args: ' {from: "2026-11-03"}', ms: 1100 },
    { system: 'blackboard', name: 'bb_upcoming', args: ' {days: 7}', ms: 700 },
  ],
  answer: [
    { kind: 'text', lines: ['<tspan font-weight="700">Tuesday</tspan> has two sessions:'] },
    { kind: 'card', rows: [
      { chip: '09:00', color: C.au, text: 'Corporate Finance  ·  Lecture', right: 'Room E 204' },
      { chip: '14:00', color: C.au, text: 'Negotiation Skills  ·  Tutorial', right: 'Online (Teams)' },
    ] },
    { kind: 'text', lines: ['<tspan font-weight="700">Due this week:</tspan> Team case report (Fri 23:59) in Strategy.'] },
  ],
});

chat({
  file: 'demo-download.svg', title: 'Claude  ·  edhec-mcp',
  user: { lines: ['Download everything from my Corporate Finance course', 'into ~/Documents/EDHEC and tell me what to read first.'] },
  tools: [
    { system: 'blackboard', name: 'bb_course_contents', args: ' {course: "Corporate Finance"}', ms: 800 },
    { system: 'blackboard', name: 'bb_download_files', args: ' {destDir: "~/Documents/EDHEC/…"}', ms: 1500 },
  ],
  answer: [
    { kind: 'text', lines: ['Saved <tspan font-weight="700">9 files</tspan> in 6 folders. Start with these for Session 1:'] },
    { kind: 'card', rows: [
      { chip: 'PDF', color: C.bb, text: 'Syllabus 2026.pdf', right: '4 pages' },
      { chip: 'CASE', color: C.bb, text: 'Session 1 / Tesla Capital Structure.docx', right: '~25 min read' },
      { chip: 'LINK', color: C.sub, text: 'HBR reading (course pack, open in browser)', right: 'not downloaded' },
    ] },
  ],
});

chat({
  file: 'demo-print.svg', title: 'Claude  ·  edhec-mcp',
  user: { lines: ['Print the case and my summary, stapled.'] },
  tools: [
    { system: 'eprint', name: 'eprint_submit', args: ' {printer: "staple", files: 2}', ms: 1600 },
    { system: 'eprint', name: 'eprint_status', ms: 600 },
  ],
  answer: [
    { kind: 'text', lines: ['Both jobs are waiting at any campus printer. Tap your card to release them.'] },
    { kind: 'card', rows: [
      { chip: 'A4 · STAPLED', color: C.pr, text: 'Case – highlighted.pdf', right: '11 pages' },
      { chip: 'A4 · STAPLED', color: C.pr, text: 'Quiz summary.pdf', right: '4 pages' },
      { chip: 'BALANCE', color: C.sub, text: 'Print quota left after release', right: '842 pages' },
    ] },
  ],
});

chat({
  file: 'demo-lunch.svg', title: 'Claude  ·  edhec-mcp',
  user: { lines: ["What's for lunch today, and can I afford the formula?"] },
  tools: [
    { system: 'food', name: 'resto_menu', args: ' {site: "edhec"}', ms: 1300 },
    { system: 'food', name: 'resto_balance', ms: 600 },
  ],
  answer: [
    { kind: 'text', lines: ["Today's menu at the campus restaurant:"] },
    { kind: 'card', rows: [
      { chip: 'MAIN', color: C.food, text: 'Crispy chicken, hand-cut fries', right: '€11.00' },
      { chip: 'VEGGIE', color: C.food, text: 'Red cabbage tart, green beans', right: '€11.00' },
      { chip: 'FORMULA', color: C.food, text: 'Starter or dessert + main + coffee', right: '€14.00' },
    ] },
    { kind: 'text', lines: ['Your card has <tspan font-weight="700" fill="' + C.ok + '">€18.40</tspan>, so yes. That leaves €4.40.'] },
  ],
});

chat({
  file: 'demo-order.svg', title: 'Claude  ·  edhec-mcp  ·  two-step order', cycle: 13,
  user: { lines: ['Order my lunch at the snack corner: tuna sandwich,', 'a yoghurt and a chocolate waffle.'] },
  tools: [
    { system: 'food', name: 'resto_order_prepare', args: ' {main: "thon mayo", sides: 2}', ms: 1300 },
  ],
  answer: [
    { kind: 'text', lines: ['Here is the order. <tspan font-weight="700">Nothing is paid yet.</tspan>'] },
    { kind: 'card', rows: [
      { chip: 'MAIN', color: C.food, text: 'Sandwich thon mayonnaise', right: '9 left' },
      { chip: 'SIDES', color: C.food, text: 'Yaourt · Gaufre liégeoise chocolat', right: '' },
      { chip: 'TOTAL', color: C.sub, text: 'Formula €5.30, student discount −€4.30', right: '€1.00' },
    ] },
    { kind: 'buttons', items: [{ label: 'Yes, order for €1.00', primary: true }, { label: 'Change' }], gap: 0.9 },
    { kind: 'text', lines: ['<tspan fill="' + C.ok + '" font-weight="700">✓ Paid</tspan> after you said yes. Pick up 11:30 to 14:00 at Le Break.'] },
  ],
});

chat({
  file: 'demo-admin.svg', title: 'Claude  ·  edhec-mcp',
  user: { lines: ['Any absences on my record? Also I need a school certificate', 'for my bank.'] },
  tools: [
    { system: 'aurion', name: 'aurion_view', args: ' {view: "absences"}', ms: 1000 },
    { system: 'aurion', name: 'aurion_certificate', args: ' {destDir: "~/Documents"}', ms: 1300 },
  ],
  answer: [
    { kind: 'card', rows: [
      { chip: 'ABSENCE', color: C.warn, text: 'Oct 14 · Marketing Analytics · 1h30', right: 'no proof yet', rightColor: C.warn },
      { chip: 'PDF', color: C.au, text: 'Certificat_scolarite.pdf saved to ~/Documents', right: 'ready' , rightColor: C.ok },
    ] },
    { kind: 'text', lines: ['Upload a proof in Aurion within the deadline so it does not affect your grade.'] },
  ],
});

chat({
  file: 'demo-install.svg', title: 'Claude  ·  install in one message', cycle: 13,
  user: { lines: ['Install the edhec-mcp server for me:', 'https://github.com/Sillvs/edhec-mcp  …'] },
  tools: [
    { system: 'setup', name: 'check Node.js + Chrome', ms: 700 },
    { system: 'setup', name: 'download + install', args: ' ~/edhec-mcp', ms: 1300 },
    { system: 'setup', name: 'run security tests', args: ' 14 passed', ms: 900 },
    { system: 'setup', name: 'add MCP server', args: ' "edhec"', ms: 700 },
    { system: 'setup', name: 'open EDHEC sign-in', args: ' (you log in yourself)', ms: 1500 },
  ],
  answer: [
    { kind: 'text', lines: ['<tspan font-weight="700">Done.</tspan> Restart Claude, then try one of these:'] },
    { kind: 'card', rows: [
      { chip: 'ASK', color: C.au, text: '"What is on my timetable this week?"' },
      { chip: 'ASK', color: C.bb, text: '"Download my newest course files to ~/Documents/EDHEC."' },
      { chip: 'ASK', color: C.food, text: '"What is for lunch today?"' },
    ] },
  ],
});

chat({
  file: 'demo-absence.svg', title: 'Claude  ·  edhec-mcp  ·  absences', cycle: 14,
  user: { lines: ['I was sick this morning and missed the Finance quiz.', 'Here is my doctor note. What do I need to do?'] },
  tools: [
    { system: 'aurion', name: 'aurion_absence_check', ms: 1200 },
    { system: 'aurion', name: 'aurion_absence_prepare', args: ' {files: 1}', ms: 900 },
  ],
  answer: [
    { kind: 'text', lines: ['A quiz was scheduled, so a proof is <tspan font-weight="700">required within 48 h</tspan>. Here is the report:'] },
    { kind: 'card', rows: [
      { chip: 'WHEN', color: C.au, text: 'Tue 10 Nov, 09:00 to 12:00', right: '46 h left', rightColor: C.warn },
      { chip: 'REASON', color: C.au, text: '"Fever, saw a doctor this morning" (your words)' },
      { chip: 'QUIZ', color: C.au, text: 'Corporate Finance · in-class quiz', right: 'declared' },
      { chip: 'PROOF', color: C.sub, text: 'doctor-note.pdf', right: '1 file' },
    ] },
    { kind: 'buttons', items: [{ label: 'Send to Front Office', primary: true }, { label: 'Change' }], gap: 0.9 },
    { kind: 'text', lines: ['<tspan fill="' + C.ok + '" font-weight="700">✓ Sent</tspan> and visible in My proofs of absence.'] },
  ],
});

// ---------------------------------------------------------------------------
// Hero: Claude in the middle, the four EDHEC systems around it.
// ---------------------------------------------------------------------------
function hero({ file, W = 1200, H = 520, social = false }) {
  const cx = W / 2, cy = social ? 360 : 300;
  const nodes = [
    { s: SYSTEM.blackboard, x: cx - 400, y: cy - 95, sub: 'Courses · files · deadlines' },
    { s: SYSTEM.aurion, x: cx - 400, y: cy + 95, sub: 'Timetable · grades · absences' },
    { s: SYSTEM.eprint, x: cx + 400, y: cy - 95, sub: 'Print A4 · A3 · stapled' },
    { s: SYSTEM.food, x: cx + 400, y: cy + 95, sub: 'Menu · balance · orders' },
  ];
  const links = nodes.map((nd, i) => {
    const x1 = nd.x + (nd.x < cx ? 130 : -130), y1 = nd.y;
    const mx = (x1 + cx) / 2;
    const d = `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${cy}, ${cx + (nd.x < cx ? -78 : 78)} ${cy}`;
    return `<path d="${d}" stroke="${nd.s.color}" stroke-width="2.5" fill="none" stroke-dasharray="6 8" class="flow" opacity=".7"/>
      <circle r="5" fill="${nd.s.color}"><animateMotion dur="${2.2 + i * 0.35}s" repeatCount="indefinite" path="${d}" keyPoints="${i % 2 ? '0;1' : '1;0'}" keyTimes="0;1" calcMode="linear"/></circle>`;
  }).join('\n');
  const cards = nodes.map((nd, i) => `<g class="card" style="animation-delay:${i * 0.15}s">
    <rect x="${nd.x - 130}" y="${nd.y - 44}" width="260" height="88" rx="18" fill="#fff" stroke="${C.line}"/>
    <rect x="${nd.x - 112}" y="${nd.y - 22}" width="44" height="44" rx="12" fill="${nd.s.color}"/>
    <text x="${nd.x - 90}" y="${nd.y + 8}" text-anchor="middle" fill="#fff" font-size="22" font-weight="800">${nd.s.letter}</text>
    <text x="${nd.x - 56}" y="${nd.y - 3}" fill="${C.ink}" font-size="19" font-weight="700">${nd.s.name}</text>
    <text x="${nd.x - 56}" y="${nd.y + 20}" fill="${C.sub}" font-size="13">${nd.sub}</text>
  </g>`).join('\n');
  const title = social
    ? `<text x="${cx}" y="96" text-anchor="middle" fill="${C.ink}" font-size="58" font-weight="800">edhec-mcp</text>
       <text x="${cx}" y="146" text-anchor="middle" fill="${C.sub}" font-size="26">Blackboard, Aurion, ePrinting and campus food in Claude</text>`
    : `<text x="${cx}" y="70" text-anchor="middle" fill="${C.ink}" font-size="40" font-weight="800">Your EDHEC student life, inside Claude</text>
       <text x="${cx}" y="108" text-anchor="middle" fill="${C.sub}" font-size="19">One MCP server · four campus systems · your own SSO login</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-labelledby="t d">
<title id="t">edhec-mcp connects Claude to Blackboard, Aurion, ePrinting and campus food</title>
<desc id="d">Diagram: Claude in the center, linked to Blackboard (courses, files, deadlines), Aurion (timetable, grades, absences), PaperCut ePrinting (printing) and the campus food services (menu, card balance, orders).</desc>
<style>
.flow{animation:dash 1.2s linear infinite}@keyframes dash{to{stroke-dashoffset:-28}}
.card{animation:pop .7s ease-out both}@keyframes pop{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.pulse{transform-origin:${cx}px ${cy}px;animation:pulse 2.4s ease-out infinite}@keyframes pulse{0%{transform:scale(1);opacity:.45}100%{transform:scale(1.9);opacity:0}}
</style>
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfaf8"/><stop offset="1" stop-color="#f1f5f9"/></linearGradient></defs>
<rect width="${W}" height="${H}" rx="${social ? 0 : 24}" fill="url(#bg)"/>
${title}
${links}
<circle class="pulse" cx="${cx}" cy="${cy}" r="66" fill="${C.claude}"/>
<circle cx="${cx}" cy="${cy}" r="66" fill="${C.claude}"/>
<path d="M${cx} ${cy - 30} l7 22 22 7 -22 7 -7 22 -7 -22 -22 -7 22 -7z" fill="#fff"/>
<text x="${cx}" y="${cy + 98}" text-anchor="middle" fill="${C.ink}" font-size="18" font-weight="700">Claude</text>
<text x="${cx}" y="${cy + 120}" text-anchor="middle" fill="${C.sub}" font-size="13">via edhec-mcp</text>
${cards}
</svg>`;
  fs.writeFileSync(path.join(OUT, file), svg);
}
hero({ file: 'hero.svg' });
hero({ file: 'social-preview.svg', W: 1280, H: 640, social: true });

// ---------------------------------------------------------------------------
// Architecture / security diagram
// ---------------------------------------------------------------------------
(function architecture() {
  const W = 1100, H = 430;
  const box = (x, y, w, h, title, lines, color, dashed) => `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#fff" stroke="${color}" stroke-width="2" ${dashed ? 'stroke-dasharray="7 6"' : ''}/>
    <text x="${x + 18}" y="${y + 30}" fill="${color}" font-size="15" font-weight="800">${esc(title)}</text>
    ${lines.map((l, i) => `<text x="${x + 18}" y="${y + 56 + i * 22}" fill="${C.ink}" font-size="13.5">${esc(l)}</text>`).join('')}
  </g>`;
  const arrow = (x1, y1, x2, y2, label) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${C.sub}" stroke-width="2" class="flow" stroke-dasharray="5 6" marker-end="url(#ah)"/>${label ? `<text x="${(x1 + x2) / 2}" y="${y1 - 10}" text-anchor="middle" fill="${C.sub}" font-size="12">${esc(label)}</text>` : ''}`;
  const services = [
    ['Blackboard Learn', 'REST API (read-only)', C.bb], ['Aurion', 'JSF pages (read-only)', C.au],
    ['PaperCut ePrinting', 'Web Print pages', C.pr], ['ALL La Catho · MONEWEB', 'menu PDF + JSON API', C.food],
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-labelledby="t d">
<title id="t">How edhec-mcp works</title>
<desc id="d">Claude talks to the local edhec-mcp server over stdio. The server checks every request in a safety layer, then uses a private Chrome profile with your own SSO session to reach the four EDHEC services.</desc>
<style>.flow{animation:dash 1.1s linear infinite}@keyframes dash{to{stroke-dashoffset:-22}}</style>
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="${C.sub}"/></marker></defs>
<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>
${box(30, 140, 190, 120, 'Claude', ['Desktop · Code · any', 'MCP client', 'you approve writes'], C.claude)}
${arrow(222, 200, 288, 200, 'stdio')}
${box(292, 40, 330, 350, 'edhec-mcp (runs on your Mac/PC)', ['Tools: read · download · print · order (beta)', '', 'Safety layer', '• secrets redacted from every result', '• downloads only into safe folders', '• prints only documents, no secrets', '• orders need a one-time confirmation', '• only EDHEC hosts are contacted', '', 'Private Chrome profile', '~/.edhec-mcp (your SSO session)'], C.ink)}
${arrow(624, 215, 700, 215, 'HTTPS')}
${services.map(([n, d, col], i) => box(704, 34 + i * 92, 366, 78, n, [d], col)).join('\n')}
</svg>`;
  fs.writeFileSync(path.join(OUT, 'architecture.svg'), svg);
})();

console.log('wrote', fs.readdirSync(OUT).join(', '));
