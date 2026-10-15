// layout's probe of a plain click on the dock's page button with no room in view for a page at its own size, only a
// strip (build's b9copy sweep, lead batch 10): the page opens at its own size, never shrunk to the strip, just past
// the space's last window at its top, the view brought to it, nothing else moving. Real input over CDP in layout's own
// isolated app. Shells only, pages blank.
//   LAYOUT_ROOT=<app tree> node test/layout-probe-dockclick.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse } from './nav-lib.mjs';
import { USER_DATA, ROOT, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], wins = {};
  ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect(); wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, type: w.type, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  const vp = document.getElementById('viewport').getBoundingClientRect(); return { vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins, pan: ws.panUnit === '%' ? ((ws.pan || 0) / 100) * vp.width : ws.pan || 0 }; })()`);
async function goSettled(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  let last = null;
  for (let k = 0; k < 40; k++) {
    await sleep(150);
    const s = await now(), key = q(Object.values(s.wins).map((r) => [Math.round(r.sx), Math.round(r.sy)]));
    if (key === last) return s;
    last = key;
  }
  return now();
}
function overlaps(s) {
  const ids = Object.keys(s.wins), out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = s.wins[ids[i]], b = s.wins[ids[j]];
    if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) out.push(`${ids[i]}/${ids[j]}`);
  }
  return out;
}
let px = 700, py = 400;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); px = x; py = y; }

/* A plain click on a dock button (brought up at the bottom middle, as a hand does); the space after it settles, the one
   new window, and what else moved in the space. */
async function clickDock(kind, s0) {
  const d = await ev(`(() => { const r = document.getElementById('dock').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 12 - 5 }; })()`);
  await glide(d.x, d.y, 12);
  await sleep(400);
  const b = await ev(`(() => { const d = document.getElementById('dock'), b = d.querySelector('button[data-k=${q(kind)}]'), r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(d).opacity > 0.9 && d.style.pointerEvents !== 'none' }; })()`);
  await glide(b.x, b.y, 4);
  await sleep(200);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(600);
  await glide(b.x, b.y - 300, 6);
  let s1 = await now();
  for (let k = 0; k < 20; k++) { await sleep(150); const s = await now(); if (q(Object.values(s.wins).map((r) => [Math.round(r.sx), Math.round(r.sy)])) === q(Object.values(s1.wins).map((r) => [Math.round(r.sx), Math.round(r.sy)]))) break; s1 = s; }
  const made = Object.keys(s1.wins).filter((id) => !s0.wins[id]), P = made.length === 1 ? s1.wins[made[0]] : null;
  const moved = Object.keys(s0.wins).filter((id) => ['x', 'y', 'w', 'h'].some((k) => Math.abs(s1.wins[id][k] - s0.wins[id][k]) > 0.05));
  console.log(`${kind}: new ${q(P && [P.type, P.x, P.y, P.w, P.h, Math.round(P.sx), Math.round(P.sy), Math.round(P.sw), Math.round(P.sh)])}; moved ${q(moved)}`);
  return { s1, P, made, moved, shown: b.shown, b };
}

async function main() {
  console.log(`tree ${ROOT}`);
  await writeSeed();
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => { ws.mode = 'float'; (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }); });
  /* flow with "this week" taller, so the only open area in view is a strip at the top left, 47 x 25.6 points (about
     580 x 230 px): room for the smallest window, none for a page at its own size, 46 x 64 */
  Object.assign(state.ws.find((w) => w.id === 'flow').windows.find((w) => w.id === 'w-week'), { y: 34, h: 54.4 });
  /* infra and voiceless: one open column between a tall window on the left and two on the right, 25.0 points (310 px)
     and 23.4 points (290 px) wide; half a note is 210 px, so the 300 px smallest window decides (lead 23:5x) */
  const put = (wsId, id, r) => Object.assign(state.ws.find((w) => w.id === wsId).windows.find((w) => w.id === id), { x: r[0], y: r[1], w: r[2], h: r[3] });
  put('infra', 'i-bench', [1.2, 6.6, 20.8, 81.8]); put('infra', 'i-sched', [49.4, 6.6, 49.4, 50]); put('infra', 'i-note', [49.4, 58.4, 49.4, 30]);
  put('voiceless', 'v-page', [1.2, 6.6, 22.4, 81.8]); put('voiceless', 'v-note', [49.4, 6.6, 49.4, 50]); put('voiceless', 'v-term', [49.4, 58.4, 49.4, 30]);
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();

  /* 1. flow, a page with only a 580 x 230 px strip free (build's b9copy case): it goes past the last window at its own
     size, the view on it */
  const s0 = await goSettled('flow'), end = Math.max(...Object.values(s0.wins).map((r) => r.x + r.w));
  console.log(`flow: ${q(Object.fromEntries(Object.entries(s0.wins).map(([k, r]) => [k, [r.x, r.y, r.w, r.h]])))}; the last window ends at ${end}`);
  const r1 = await clickDock('page', s0);
  const { s1, P, moved } = r1;
  ok('the dock comes up with its page button', r1.shown, r1.b);
  ok('a click on the dock\'s page button makes one page window', !!P && P.type === 'page', r1.made);
  ok('at its own size, not shrunk to the strip (46 x 64)', !!P && near(P.w, 46, 0.05) && near(P.h, 64, 0.05), P && [P.w, P.h]);
  ok('just past the space\'s last window, at its top, over no window', !!P && near(P.x, end + 1.5, 0.05) && near(P.y, 6.6, 0.05) && overlaps(s1).length === 0, { at: P && [P.x, P.y], end, overlaps: overlaps(s1) });
  ok('the view is on it: the whole page on screen', !!P && P.sx >= s1.vp.x - 1 && P.sy >= s1.vp.y - 1 && P.sx + P.sw <= s1.vp.x + s1.vp.w + 1 && P.sy + P.sh <= s1.vp.y + s1.vp.h + 1, { page: P && [P.sx, P.sy, P.sw, P.sh], vp: s1.vp });
  ok('nothing else moves', moved.length === 0, moved);

  /* 2. infra, a note with a 310 px open column: in view, filling the column, as tall as a note; nothing moves */
  const i0 = await goSettled('infra');
  const r2 = await clickDock('note', i0), N2 = r2.P, B = i0.wins['i-bench'];
  ok('a note with a 310 px open column opens in view, filling it (wider than the smallest window, 300 px), as tall as a note', !!N2 && N2.type === 'note' && near(N2.x, B.x + B.w + 1.2, 0.05) && near(N2.x + N2.w, 49.4 - 1.2, 0.05) && near(N2.y, 6.6, 0.05) && near(N2.h, 46, 0.05) && N2.sw >= 300 && overlaps(r2.s1).length === 0, { at: N2 && [N2.x, N2.y, N2.w, N2.h, Math.round(N2.sw)] });
  ok('nothing else moves and the view stays', r2.moved.length === 0 && near(r2.s1.pan, i0.pan, 0.5), { moved: r2.moved, pan: [i0.pan, r2.s1.pan] });

  /* 3. voiceless, a note with only a 290 px open column: under the smallest window, so past the last window at its own
     size, the view on it */
  const v0 = await goSettled('voiceless'), endV = Math.max(...Object.values(v0.wins).map((r) => r.x + r.w));
  const r3 = await clickDock('note', v0), N3 = r3.P;
  ok('a note with a 290 px open column goes past the last window at its own size, at its top', !!N3 && N3.type === 'note' && near(N3.w, 34, 0.05) && near(N3.h, 46, 0.05) && near(N3.x, endV + 1.5, 0.05) && near(N3.y, 6.6, 0.05) && overlaps(r3.s1).length === 0, { at: N3 && [N3.x, N3.y, N3.w, N3.h], end: endV });
  ok('the view is on it and nothing else moves', !!N3 && N3.sx >= r3.s1.vp.x - 1 && N3.sx + N3.sw <= r3.s1.vp.x + r3.s1.vp.w + 1 && r3.moved.length === 0, { note: N3 && [N3.sx, N3.sw], moved: r3.moved });
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




