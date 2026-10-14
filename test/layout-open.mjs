// layout's check that a window opened with no spot given never covers another (lead, Nov 2 11:3x; owner: "a new window
// never covers another"): on full spaces, a note opened from ⌘K, a note opened from its sidebar row, and a new page from
// the dock. With no free spot in the view it goes just past the space's last window, at the top, the view comes to it,
// and nothing else moves. Real input over CDP in layout's own isolated app (layout-lib.mjs). Notes and blank pages only.
//   LAYOUT_ROOT=<app tree> node test/layout-open.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/open-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, shot as shotOf } from './nav-lib.mjs';
import { type, key } from './ui-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'open-shots');
const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const shot = (name) => shotOf(c, path.join(SHOTS, `${name}.png`));
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;

/* The space on screen: its view (px of this window, whichever unit the workspace keeps it in), its windows in % and on
   screen, which one is in front, and where the keys go. */
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], sid = ws.at || null;
  const vp = document.getElementById('viewport').getBoundingClientRect();
  const wins = {}; ws.windows.filter((w) => (w.zone || null) === sid).forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect();
    wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, type: w.type, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  const front = document.querySelector('.win.front'), keys = document.activeElement && document.activeElement.closest && document.activeElement.closest('.win');
  return { ws: ws.id, pan: ws.panUnit === '%' ? ((ws.pan || 0) / 100) * vp.width : ws.pan || 0, panY: ws.panUnit === '%' ? ((ws.panY || 0) / 100) * vp.height : ws.panY || 0, zoom: ws.zoom || 1, vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins,
    front: front ? front.dataset.id : null, keys: keys ? keys.dataset.id : null, glowR: document.getElementById('edgeR').classList.contains('on') }; })()`);
let px = 700, py = 400;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); px = x; py = y; }
async function goTo(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  await sleep(900);
}

function overlaps(s) {
  const ids = Object.keys(s.wins), out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = s.wins[ids[i]], b = s.wins[ids[j]];
    if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) out.push(`${ids[i]}/${ids[j]}`);
  }
  return out;
}
const made = (a, b) => Object.keys(b.wins).filter((id) => !a.wins[id]);
const at = (s, id) => s.wins[id];
const moved = (a, b) => Object.keys(a.wins).filter((id) => !b.wins[id] || !near(a.wins[id].x, b.wins[id].x) || !near(a.wins[id].y, b.wins[id].y));
const end = (s) => Math.max(...Object.values(s.wins).map((o) => o.x + o.w));
const rowOf = (act) => ev(`(() => { const e = document.querySelector('#sblist .tr[data-act=${q(act)}]'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
async function click(x, y) {
  await glide(x, y, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
/* The checks for a window opened on the full space: one new window, over none, past the last window at the top, shown. */
function opened(label, s0, s1, kind) {
  const n = made(s0, s1), N = n.length === 1 ? at(s1, n[0]) : null, e0 = end(s0);
  console.log(`${label}: ${q(N && [+N.x.toFixed(2), +N.y.toFixed(2), +N.w.toFixed(2), +N.h.toFixed(2), N.type])}; the space ended at ${e0.toFixed(2)}`);
  ok(`${label}: one new ${kind} window`, !!N && N.type === kind, { made: n });
  ok(`${label}: it covers no window, just past the space's last one, at the top`, !!N && overlaps(s1).length === 0 && near(N.x, e0 + 1.5) && near(N.y, 6.6), { at: N && [N.x, N.y], end: e0, overlaps: overlaps(s1) });
  ok(`${label}: the view came to it`, !!N && N.sx >= s1.vp.x - 1 && N.sx + Math.min(N.sw, s1.vp.w) <= s1.vp.x + s1.vp.w + 1, { sx: N && N.sx, sw: N && N.sw, vp: s1.vp });
  ok(`${label}: nothing else moved`, moved(s0, s1).length === 0, moved(s0, s1));
  return N ? n[0] : null;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }));
  /* ef, voiceless and infra each fill their view: no spot in it fits a note or a page. A note of ef and one of voiceless
     are not open. */
  state.ws.find((s) => s.id === 'ef').notes.push({ id: 'n-walk-alpha', kind: 'note', title: 'walk alpha', body: '' });
  state.ws.find((s) => s.id === 'voiceless').notes.push({ id: 'n-walk-beta', kind: 'note', title: 'walk beta', body: '' });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();
  await goTo('ef');
  const s0 = await now();
  console.log(`ef: ${q(Object.fromEntries(Object.entries(s0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.y.toFixed(2), +v.w.toFixed(2), +v.h.toFixed(2)]])))}`);
  ok('ef is full: no window over another to start with', overlaps(s0).length === 0 && Object.keys(s0.wins).length >= 3, Object.keys(s0.wins));

  /* 1. ef, ⌘K: the search, a note's name typed, its row clicked */
  const into = at(s0, 'e-note');
  await click(into.sx + into.sw / 2, into.sy + into.sh / 2);
  await sleep(300);
  await key(c, 'k', 4);
  await sleep(400);
  const inSearch = await ev(`document.activeElement && document.activeElement.id`);
  ok('⌘K puts the keys in the search', inSearch === 'q', { active: inSearch });
  await type(c, 'walk alpha');
  await sleep(700);
  const r1 = await rowOf('note|n-walk-alpha');
  ok('the search shows the note "walk alpha"', !!r1);
  if (r1) { await click(r1.x, r1.y); await sleep(1200); }
  const s1 = await now();
  opened('⌘K', s0, s1, 'note');
  await shot('01-cmdk');
  /* the search emptied the way a hand does: ⌘K selects what is in it, Backspace clears it, Escape leaves it */
  await key(c, 'k', 4);
  await sleep(300);
  await key(c, 'Backspace');
  await key(c, 'Escape');
  await sleep(600);

  /* 2. voiceless, a note's row in the sidebar */
  await goTo('voiceless');
  const s2 = await now();
  ok('voiceless is full: no window over another to start with', overlaps(s2).length === 0 && Object.keys(s2.wins).length >= 3, Object.keys(s2.wins));
  const r2 = await rowOf('note|n-walk-beta');
  ok('the sidebar has a row for the note "walk beta"', !!r2);
  if (r2) { await click(r2.x, r2.y); await sleep(1200); }
  const s3 = await now();
  opened('a sidebar row', s2, s3, 'note');
  await shot('02-sidebar-row');

  /* 3. infra, a new page from the dock (a plain click, as ⌘T makes one when no page is in front) */
  await goTo('infra');
  const s4 = await now();
  ok('infra is full: no window over another to start with', overlaps(s4).length === 0 && Object.keys(s4.wins).length >= 3, Object.keys(s4.wins));
  const into3 = at(s4, 'i-note');
  await click(into3.sx + into3.sw / 2, into3.sy + into3.sh / 2);
  await sleep(300);
  const d = await ev(`(() => { const r = document.getElementById('dock').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 12 - 5 }; })()`);
  await glide(d.x, d.y, 12);
  await sleep(400);
  const b = await ev(`(() => { const d = document.getElementById('dock'), b = d.querySelector('button[data-k="page"]'), r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(d).opacity > 0.9 }; })()`);
  ok('the dock came up', b.shown);
  await click(b.x, b.y);
  await sleep(1200);
  const s5 = await now();
  opened('a new page', s4, s5, 'page');
  await shot('03-new-page');

  const errs = c.errors.filter((e) => !/net::|Failed to load resource|ERR_/.test(e));
  ok('no console errors', errs.length === 0, errs.slice(0, 5));
}

try {
  if (running()) throw new Error('layout\'s app is already running');
  await main();
} catch (e) {
  fails++;
  console.log(`FAIL ${e.stack || e}`);
} finally {
  try { if (c) c.close(); } catch {}
  if (!KEEP) await stop();
  console.log(`${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}




