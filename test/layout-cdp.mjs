// layout's check of room between windows, with real input over CDP in layout's own isolated app (layout-lib.mjs): a
// double-click between two windows side by side or one above the other, the pull (double-click held and dragged), what
// makes way, spaces' sides on the same mechanism, a window carried past the start or the bottom, a pinch, columns,
// right-click "new note here" in a gap, and a restart. Shells only, no host windows, pages blank.
//   LAYOUT_ROOT=<app tree> node test/layout-cdp.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, waitFor, mouse, shot as shotOf } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'shots');
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

/* The space on screen of the current workspace: its view (px of this window, whichever unit the workspace keeps it in), its
   windows in % and on screen, and the room kept. */
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], sid = ws.at || null, zn = sid && ws.zones.find((z) => z.id === sid), ho = zn || ws;
  const vp = document.getElementById('viewport').getBoundingClientRect();
  const wins = {}; ws.windows.filter((w) => (w.zone || null) === sid).forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect();
    wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  return { ws: ws.id, mode: ws.mode, pan: ws.panUnit === '%' ? ((ws.pan || 0) / 100) * vp.width : ws.pan || 0, panY: ws.panUnit === '%' ? ((ws.panY || 0) / 100) * vp.height : ws.panY || 0, zoom: ws.zoom || 1, roomRight: ho.roomRight || 0, roomLeft: ho.roomLeft || 0, roomBottom: ho.roomBottom || 0,
    vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins,
    glow: { r: document.getElementById('edgeR').classList.contains('on'), l: document.getElementById('edgeL').classList.contains('on'), b: [...document.querySelectorAll('#viewport > .edge')].some((e) => e !== document.getElementById('edgeR') && e !== document.getElementById('edgeL') && e.classList.contains('on')) } }; })()`);
/* No two windows of the space overlap (in %). */
function overlaps(s) {
  const ids = Object.keys(s.wins), out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = s.wins[ids[i]], b = s.wins[ids[j]];
    if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) out.push(`${ids[i]}/${ids[j]}`);
  }
  return out;
}

/* ---------- a hand on the trackpad ---------- */
let px = 700, py = 400;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); px = x; py = y; }
/* Presses and releases carry their own times (CDP timestamp, s), as a real double-click does, so a busy renderer cannot
   stretch the 80 ms between its clicks. */
const stamp = (ms) => ({ timestamp: ms / 1000 });
async function press(x, y, n, at) { await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n, pointerType: 'mouse', ...(at ? stamp(at) : {}) }); }
async function release(x, y, n, at) { await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n, pointerType: 'mouse', ...(at ? stamp(at) : {}) }); }
async function dbl(x, y) { await glide(x, y); const t = Date.now(); await press(x, y, 1, t); await release(x, y, 1, t + 40); await press(x, y, 2, t + 120); await release(x, y, 2, t + 160); }
/* A double-click whose second press is held and dragged by dx, dy px, slowly, then let go. */
async function pull(x, y, dx, dy, steps = 12) {
  await glide(x, y);
  const t = Date.now();
  await press(x, y, 1, t); await release(x, y, 1, t + 40); await press(x, y, 2, t + 120);
  for (let k = 1; k <= steps; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * k) / steps, y: y + (dy * k) / steps, button: 'left', buttons: 1, pointerType: 'mouse', ...stamp(t + 120 + 16 * k) }); await sleep(16); }
  await sleep(120);
  await release(x + dx, y + dy, 2, t + 120 + 16 * steps + 150);
  px = x + dx; py = y + dy;
}
/* A slow drag from one point to another with the button held, still before the release so nothing glides. */
async function drag(x0, y0, x1, y1, steps = 20, hold = 0) {
  await glide(x0, y0);
  await press(x0, y0, 1);
  for (let k = 1; k <= steps; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * k) / steps, y: y0 + ((y1 - y0) * k) / steps, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(16); }
  if (hold) { const end = Date.now() + hold; while (Date.now() < end) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(30); } }
  await sleep(150);
  await release(x1, y1, 1);
  px = x1; py = y1;
}
async function pinch(dys, x, y) { await glide(x, y); for (const dy of dys) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' }); await sleep(700); }
const settle = () => sleep(700);

async function goTo(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  await sleep(900);
}
/* A point of bare desktop between two windows: side by side ('x') or one above the other ('y'), on screen (the part of
   their overlap that is in view). */
function gapPoint(s, a, b, axis) {
  const A = s.wins[a], B = s.wins[b], V = s.vp;
  if (axis === 'x') { const y0 = Math.max(A.sy, B.sy, V.y), y1 = Math.min(A.sy + A.sh, B.sy + B.sh, V.y + V.h); return { x: (A.sx + A.sw + B.sx) / 2, y: (y0 + y1) / 2 }; }
  const x0 = Math.max(A.sx, B.sx, V.x), x1 = Math.min(A.sx + A.sw, B.sx + B.sw, V.x + V.w - 30);
  return { x: (x0 + x1) / 2, y: (A.sy + A.sh + B.sy) / 2 };
}
const at = (s, id) => s.wins[id];

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }));
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();

  /* ---------- 1. side by side: infra, two shells and a team past the right side ---------- */
  await goTo('infra');
  let s0 = await now();
  console.log(`infra: ${q(Object.fromEntries(Object.entries(s0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.y.toFixed(2), +v.w.toFixed(2), +v.h.toFixed(2)]])))}`);
  await shot('01-infra-before');
  let g = gapPoint(s0, 'i-bench', 'i-sched', 'x');
  await dbl(g.x, g.y);
  await settle();
  let s1 = await now();
  await shot('02-infra-gap-dblclick');
  const step = at(s0, 'i-sched').w + 1.2;
  ok('a double-click between two windows side by side: the left one stays', near(at(s1, 'i-bench').x, at(s0, 'i-bench').x) && near(at(s1, 'i-bench').sx, at(s0, 'i-bench').sx, 0.5), [at(s0, 'i-bench').x, at(s1, 'i-bench').x]);
  ok('the right one makes way by its own width', near(at(s1, 'i-sched').x, at(s0, 'i-sched').x + step), { before: at(s0, 'i-sched').x, after: at(s1, 'i-sched').x, step });
  ok('what lies past it in its way moves the same, so the arrangement is kept', near(at(s1, 'i-team').x, at(s0, 'i-team').x + step), { before: at(s0, 'i-team').x, after: at(s1, 'i-team').x });
  ok('the view does not move', near(s1.pan, s0.pan, 0.5) && near(s1.zoom, s0.zoom, 0.001), { pan: [s0.pan, s1.pan] });
  ok('no window over another', overlaps(s1).length === 0, overlaps(s1));
  ok('nothing changed size', ['i-bench', 'i-sched', 'i-team'].every((id) => near(at(s1, id).w, at(s0, id).w) && near(at(s1, id).h, at(s0, id).h)));
  ok('the right glow shows there is more that way', s1.glow.r, s1.glow);

  /* the pull: double-click held, dragged wider, then back past the usual gap */
  g = gapPoint(s1, 'i-bench', 'i-sched', 'x');
  await pull(g.x, g.y, 160, 0);
  await settle();
  const s2 = await now();
  const wider = (160 / s1.vp.w) * 100;
  ok('held and dragged, the room follows the pointer', near(at(s2, 'i-sched').x, at(s1, 'i-sched').x + wider, 0.3), { before: at(s1, 'i-sched').x, after: at(s2, 'i-sched').x, expected: at(s1, 'i-sched').x + wider });
  ok('and the rest in its way goes along', near(at(s2, 'i-team').x - at(s2, 'i-sched').x, at(s1, 'i-team').x - at(s1, 'i-sched').x, 0.05));
  await shot('03-infra-pulled-wider');
  g = gapPoint(s2, 'i-bench', 'i-sched', 'x');
  await pull(g.x, g.y, -2000, 0, 20);
  await settle();
  const s3 = await now();
  const gapNow = at(s3, 'i-sched').x - (at(s3, 'i-bench').x + at(s3, 'i-bench').w);
  ok('pulled back, the room closes to the usual gap and no further', near(gapNow, 1.2, 0.05), { gap: gapNow });
  ok('a pull let go past the left side adds no room there, and the view stays', s3.roomLeft === 0 && near(s3.pan, s2.pan, 0.5), { roomLeft: s3.roomLeft, pan: [s2.pan, s3.pan] });
  ok('no window over another after the pulls', overlaps(s3).length === 0, overlaps(s3));
  await shot('04-infra-pulled-closed');

  /* a plain click and a drag of the desktop in the gap still pan, as before */
  g = gapPoint(s3, 'i-bench', 'i-sched', 'x');
  await drag(g.x, g.y, g.x - 300, g.y, 20);
  await settle();
  const s4 = await now();
  ok('a drag in the same gap still pans the space', s4.pan > s3.pan + 100 && near(at(s4, 'i-sched').x, at(s3, 'i-sched').x), { pan: [s3.pan, s4.pan] });
  await drag(g.x - 300, g.y, g.x, g.y, 20);
  await settle();

  /* ---------- 2. spaces' sides, now on moveWins: right adds a view past everything, left a view before the start ---------- */
  let r0 = await now();
  const end0 = await ev('__flow.nav().sheet(__flow.state().ws.find((w) => w.id === "infra")).w');
  await dbl(r0.vp.x + r0.vp.w - 8, r0.vp.y + r0.vp.h * 0.5);
  await settle();
  let r1 = await now();
  const end1 = await ev('__flow.nav().sheet(__flow.state().ws.find((w) => w.id === "infra")).w');
  const edgeR = (r0.pan / r0.vp.w) * 100 + 100 / r0.zoom, beyond = Object.keys(r0.wins).filter((id) => at(r0, id).x >= edgeR);
  ok('spaces\' right side, same mechanism: the view and what is in view stay, what lay past the edge is one view further', near(r1.pan, r0.pan, 0.5) && beyond.length > 0 && Object.keys(r0.wins).every((id) => near(at(r1, id).x, at(r0, id).x + (beyond.includes(id) ? 100 / r0.zoom : 0))), { beyond, end: [end0, end1] });
  ok('the right glow shows', r1.glow.r);
  const l0 = await now();
  await dbl(l0.vp.x + 8, l0.vp.y + l0.vp.h * 0.5);
  await settle();
  const l1 = await now();
  ok('spaces\' left side: nothing on screen moves', Object.keys(l0.wins).every((id) => near(at(l1, id).sx, at(l0, id).sx, 0.6)), Object.fromEntries(Object.keys(l0.wins).map((id) => [id, [at(l0, id).sx, at(l1, id).sx]])));
  /* batch 7, the board with no edges: with nothing past the left edge nothing happens, the board already goes on there */
  ok('with nothing past the left edge, nothing changes: the windows and the view stay', near(l1.pan, l0.pan, 0.5) && Object.keys(l0.wins).every((id) => near(at(l1, id).x, at(l0, id).x)), { pan: [l0.pan, l1.pan] });
  ok('no left glow: nothing lies past the left side', !l1.glow.l, l1.glow);
  await shot('05-infra-sides');
  g = gapPoint(l1, 'i-bench', 'i-sched', 'x');
  await dbl(g.x, g.y);
  await settle();
  const l2 = await now();
  ok('room between windows after the left room: the right one makes way by its own width', near(at(l2, 'i-sched').x, at(l1, 'i-sched').x + at(l1, 'i-sched').w + 1.2) && near(at(l2, 'i-bench').x, at(l1, 'i-bench').x), { sched: [at(l1, 'i-sched').x, at(l2, 'i-sched').x] });
  await shot('06-infra-room-kept-for-restart');

  /* ---------- 4. one above the other: ef, a page over a shell, a note beside them ---------- */
  await goTo('ef');
  const e0 = await now();
  console.log(`ef: ${q(Object.fromEntries(Object.entries(e0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.y.toFixed(2), +v.w.toFixed(2), +v.h.toFixed(2)]])))}`);
  await shot('08-ef-before');
  g = gapPoint(e0, 'e-page', 'e-term', 'y');
  await dbl(g.x, g.y);
  await settle();
  const e1 = await now();
  const down = at(e0, 'e-term').h + 1.8;
  ok('a double-click between two windows one above the other: the lower one makes way by its own height', near(at(e1, 'e-term').y, at(e0, 'e-term').y + down), { before: at(e0, 'e-term').y, after: at(e1, 'e-term').y, down });
  ok('the upper one and the one beside stay', near(at(e1, 'e-page').y, at(e0, 'e-page').y) && near(at(e1, 'e-note').x, at(e0, 'e-note').x) && near(at(e1, 'e-note').y, at(e0, 'e-note').y));
  ok('the view does not move', near(e1.panY, e0.panY, 0.5) && near(e1.pan, e0.pan, 0.5));
  ok('the bottom glow shows there is more below', e1.glow.b, e1.glow);
  ok('no window over another', overlaps(e1).length === 0, overlaps(e1));
  await shot('09-ef-room-below');
  /* up just far enough for the whole shell moved below, 20 px clear of the bottom: the board has no end to stop at */
  const D = at(e1, 'e-term').sy + at(e1, 'e-term').sh - (e1.vp.y + e1.vp.h) + 20;
  await drag(e1.vp.x + e1.vp.w * 0.2, e1.vp.y + e1.vp.h * 0.97, e1.vp.x + e1.vp.w * 0.2, e1.vp.y + e1.vp.h * 0.97 - D, 24);
  await settle();
  const e2 = await now();
  ok('a drag up goes down to it by as much as the hand moved, at actual size', near(e2.panY, e1.panY + D, 2) && e2.zoom === 1, { panY: [e1.panY, e2.panY], by: +D.toFixed(1) });
  await shot('10-ef-scrolled-down');
  /* back up, from the new room itself (bare desktop between the page and the shell) */
  const R2 = { x: (at(e2, 'e-page').sx + at(e2, 'e-page').sw / 2), y: (at(e2, 'e-page').sy + at(e2, 'e-page').sh + at(e2, 'e-term').sy) / 2 };
  await drag(R2.x, R2.y, R2.x, R2.y + e2.panY - e1.panY, 24);
  await settle();
  const e3 = await now();
  ok('and back up by as much', near(e3.panY, e1.panY, 2), { panY: [e2.panY, e3.panY] });
  g = gapPoint(e3, 'e-page', 'e-term', 'y');
  await pull(g.x, g.y, 0, -2000, 20);
  await settle();
  const e3b = await now();
  const vgap = at(e3b, 'e-term').y - (at(e3b, 'e-page').y + at(e3b, 'e-page').h);
  ok('held and dragged up, the room under closes to the usual gap', near(vgap, 1.8, 0.05), { gap: vgap });

  /* side by side where the right side is a column: both of the column make way together */
  g = gapPoint(e3b, 'e-note', 'e-page', 'x');
  await dbl(g.x, g.y);
  await settle();
  const e4 = await now();
  const right = at(e3b, 'e-page').w + 1.2;
  ok('a column makes way as one: the page and the shell under it', near(at(e4, 'e-page').x, at(e3b, 'e-page').x + right) && near(at(e4, 'e-term').x, at(e3b, 'e-term').x + right), { page: [at(e3b, 'e-page').x, at(e4, 'e-page').x], term: [at(e3b, 'e-term').x, at(e4, 'e-term').x] });
  ok('the note beside stays', near(at(e4, 'e-note').x, at(e3b, 'e-note').x));
  ok('no window over another', overlaps(e4).length === 0, overlaps(e4));
  await shot('11-ef-column');

  /* ---------- 5. a window carried to the start of the space, and down past the bottom ---------- */
  const t0 = await now(), T = at(t0, 'e-note');
  await drag(T.sx + T.sw * 0.5, T.sy + 12, t0.vp.x + 5, T.sy + 12, 30, 900);
  await settle();
  const t1 = await now();
  ok('pushed against the start, the window makes room before the others (spaces\' grow, on moveWins)', near(at(t1, 'e-note').x, 0, 0.3) && at(t1, 'e-page').x > at(t0, 'e-page').x + 5, { note: at(t1, 'e-note').x, page: [at(t0, 'e-page').x, at(t1, 'e-page').x] });
  ok('the others keep their arrangement', near(at(t1, 'e-term').x - at(t1, 'e-page').x, at(t0, 'e-term').x - at(t0, 'e-page').x, 0.05) && near(at(t1, 'e-term').y, at(t0, 'e-term').y));
  ok('no window over another', overlaps(t1).length === 0, overlaps(t1));
  await shot('12-ef-carried-left');
  const N = at(t1, 'e-note');
  await drag(N.sx + N.sw * 0.5, N.sy + 12, N.sx + N.sw * 0.5, t1.vp.y + t1.vp.h - 10, 30, 1200);
  await settle();
  const t2 = await now();
  ok('carried to the bottom, the space grows down and the view follows', t2.panY > 50 && at(t2, 'e-note').y > at(t1, 'e-note').y + 20, { panY: t2.panY, y: [at(t1, 'e-note').y, at(t2, 'e-note').y] });
  ok('the window is still under the pointer', Math.abs(at(t2, 'e-note').sy + 12 - (t1.vp.y + t1.vp.h - 10)) < 30, { sy: at(t2, 'e-note').sy });
  await shot('13-ef-carried-down');

  /* ---------- 6. zoomed out: the same gestures, amounts in the space's own size ---------- */
  await goTo('mynotes');
  const z0 = await now();
  console.log(`mynotes: ${q(Object.fromEntries(Object.entries(z0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.y.toFixed(2), +v.w.toFixed(2), +v.h.toFixed(2)]])))}`);
  await pinch([40, 40], z0.vp.x + z0.vp.w * 0.5, z0.vp.y + z0.vp.h * 0.5);
  const z1 = await now();
  const ids = Object.keys(z1.wins).sort((a, b) => at(z1, a).x - at(z1, b).x);
  ok('pinched out', z1.zoom < 0.8, z1.zoom);
  if (ids.length >= 2) {
    g = gapPoint(z1, ids[0], ids[1], 'x');
    await dbl(g.x, g.y);
    await settle();
    const z2 = await now();
    const by = at(z1, ids[1]).w + 1.2;
    ok('zoomed out, a double-click between two windows opens the same room', near(at(z2, ids[1]).x, at(z1, ids[1]).x + by), { before: at(z1, ids[1]).x, after: at(z2, ids[1]).x, by });
    ok('on screen it moved that much times the zoom', near(at(z2, ids[1]).sx - at(z1, ids[1]).sx, (by / 100) * z1.vp.w * z1.zoom, 2), { moved: at(z2, ids[1]).sx - at(z1, ids[1]).sx, zoom: z1.zoom });
    ok('the zoom and the view stay', near(z2.zoom, z1.zoom, 0.001) && near(z2.pan, z1.pan, 0.5));
    await shot('14-mynotes-zoomed-gap');
  } else ok('mynotes has two windows side by side', false, ids);

  /* ---------- 7. columns: gone in batch 8 (owner 14:03: one arrange control replaces float, columns and grid); while a
     tree still has the switch, room floats the space first, as a drag does ---------- */
  await goTo('voiceless');
  if (await ev(`!!document.querySelector('#modes button[data-m="columns"]')`)) {
    await ev(`document.querySelector('#modes button[data-m="columns"]').click()`);
    await sleep(800);
    const c0 = await now();
    const cids = Object.keys(c0.wins).sort((a, b) => at(c0, a).sx - at(c0, b).sx);
    if (cids.length >= 2) {
      g = gapPoint(c0, cids[0], cids[1], 'x');
      await dbl(g.x, g.y);
      await settle();
      const c1 = await now();
      ok('in columns, room floats the space and opens', c1.mode === 'float' && at(c1, cids[1]).sx > at(c0, cids[1]).sx + 50 && near(at(c1, cids[0]).sx, at(c0, cids[0]).sx, 0.6), { mode: c1.mode, sx: [at(c0, cids[1]).sx, at(c1, cids[1]).sx] });
    } else ok('voiceless has two windows', false, cids);
  } else console.log('no columns switch in this tree (batch 8: modes are gone): the columns case does not apply');

  /* ---------- 7b. a window made between two windows: at the click, what is in its way makes way (batch 8) ---------- */
  await goTo('flow');
  const n0 = await now();
  console.log(`flow: ${q(Object.fromEntries(Object.entries(n0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.y.toFixed(2), +v.w.toFixed(2), +v.h.toFixed(2)]])))}`);
  if (n0.wins['w-week'] && n0.wins['w-design']) {
    g = gapPoint(n0, 'w-week', 'w-design', 'x');
    await glide(g.x, g.y);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(300);
    const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /^new note/.test(x.textContent.trim())); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    ok('right-click between two windows offers "new note here"', !!item);
    if (item) {
      await glide(item.x, item.y);
      await press(item.x, item.y, 1); await release(item.x, item.y, 1);
      await settle();
      const n1 = await now();
      const made = Object.keys(n1.wins).filter((id) => !n0.wins[id]);
      const N1 = made.length === 1 ? at(n1, made[0]) : null;
      /* batch 8 (lead 16:1x): at the click, its own size or the open space there; else only what is in its way makes way,
         each its own way by just enough */
      const clickIn = (N, p) => !!N && p.x >= N.sx - 1 && p.x <= N.sx + N.sw + 1 && p.y >= N.sy - 1 && p.y <= N.sy + N.sh + 1;
      /* right or down only (lead 17:15), each just clear of the note (the usual gap kept) or run into by one that moved and
         gone the same way by the same amount; as drawn, in % of the view */
      const shw = (s, id) => { const r = at(s, id); return { x: ((r.sx - s.vp.x) / s.vp.w) * 100, y: ((r.sy - s.vp.y) / s.vp.h) * 100, w: (r.sw / s.vp.w) * 100, h: (r.sh / s.vp.h) * 100 }; };
      const oneWay = (sA, sB, Nw) => {
        const N = { x: ((Nw.sx - sB.vp.x) / sB.vp.w) * 100, y: ((Nw.sy - sB.vp.y) / sB.vp.h) * 100, w: (Nw.sw / sB.vp.w) * 100, h: (Nw.sh / sB.vp.h) * 100 };
        const d = Object.keys(sA.wins).map((id) => [id, shw(sB, id).x - shw(sA, id).x, shw(sB, id).y - shw(sA, id).y]).filter(([, dx, dy]) => Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1);
        const clear = (id, dx, dy) => { const q = shw(sA, id); return (Math.abs(dy) < 0.1 && Math.abs(dx - (N.x + N.w + 1.2 - q.x)) < 0.2) || (Math.abs(dx) < 0.1 && Math.abs(dy - (N.y + N.h + 1.8 - q.y)) < 0.2); };
        const padW = (a, b) => a.x < b.x + b.w + 1.2 - 0.05 && b.x < a.x + a.w + 1.2 - 0.05 && a.y < b.y + b.h + 1.8 - 0.05 && b.y < a.y + a.h + 1.8 - 0.05;
        const dragged = (id, dx, dy) => d.some(([m, mx, my]) => m !== id && Math.abs(mx - dx) < 0.1 && Math.abs(my - dy) < 0.1 && padW(shw(sA, id), shw(sB, m)));
        return d.map(([id, dx, dy]) => [id, +dx.toFixed(2), +dy.toFixed(2), dx > -0.1 && dy > -0.1 && (clear(id, dx, dy) || dragged(id, dx, dy))]);
      };
      /* the click is in the gap, so the gap step (lead 18:5x) puts the note beside "this week", the usual gap off it, the
         click in that gap; "this week" stays */
      const W0 = at(n0, 'w-week'), W1 = at(n1, 'w-week');
      ok('the new note opens beside the window left of the click, the click in the gap between them, wholly in view', !!N1 && g.x >= W0.sx + W0.sw - 1 && g.x <= N1.sx + 1 && Math.abs(N1.sx - (W0.sx + W0.sw + n0.vp.w * 0.012)) <= 2
        && Math.abs(W1.sx - W0.sx) <= 1 && Math.abs(W1.sy - W0.sy) <= 1 && N1.sy + N1.sh <= n0.vp.y + n0.vp.h + 1 && N1.sx + N1.sw <= n0.vp.x + n0.vp.w + 1, { made, at: N1 && [N1.sx, N1.sy, N1.sw, N1.sh], click: g, week: [W0.sx, W0.sx + W0.sw, W1.sx] });
      const w1 = N1 ? oneWay(n0, n1, N1) : [];
      ok('what made way went right or down, each just clear of the note or run into by one that moved', !!N1 && w1.every((m) => m[3]), w1);
      await shot('15-flow-new-note-between');
      /* and one above the other: right-click between the page and the shell under it, which moved together */
      const m0 = await now();
      g = gapPoint(m0, 'w-mck', 'w-design', 'y');
      await glide(g.x, g.y);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
      await sleep(300);
      const item2 = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /^new note/.test(x.textContent.trim())); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (item2) {
        await glide(item2.x, item2.y);
        await press(item2.x, item2.y, 1); await release(item2.x, item2.y, 1);
        await settle();
        const m1 = await now();
        const made2 = Object.keys(m1.wins).filter((id) => !m0.wins[id]);
        const M1 = made2.length === 1 ? at(m1, made2[0]) : null;
        /* batch 9 (lead 18:0x): at the click; with no room there for even the smallest window, at the nearest open place in
           view, at least 300x160 px, and nothing moves */
        const still2 = Object.keys(m0.wins).every((id) => Math.abs(at(m1, id).sx - at(m0, id).sx) <= 1 && Math.abs(at(m1, id).sy - at(m0, id).sy) <= 1);
        const open2 = !!M1 && still2 && M1.sw >= 299.5 && M1.sh >= 159.5 && M1.sx >= m0.vp.x - 1 && M1.sx + M1.sw <= m0.vp.x + m0.vp.w + 1 && M1.sy >= m0.vp.y - 1;
        ok('between two windows one above the other, the new note opens at the click, or at an open place in view with nothing moving, wholly in view', (clickIn(M1, g) || open2) && M1.sy + M1.sh <= m0.vp.y + m0.vp.h + 1, { made2, at: M1 && [M1.sx, M1.sy, M1.sw, M1.sh], click: g, still: still2 });
        const w2 = M1 ? oneWay(m0, m1, M1) : [];
        ok('and what made way went right or down, each just clear of the note or run into by one that moved', !!M1 && w2.every((m) => m[3]), w2);
        ok('no window over another', overlaps(m1).length === 0, overlaps(m1));
        await shot('15b-flow-new-note-under');
      } else ok('right-click between two stacked windows offers "new note here"', false);
    }
  } else ok('flow has w-week and w-design', false, Object.keys(n0.wins));

  /* ---------- 8. a restart: room left empty at a side is gone, room between windows stays ---------- */
  await goTo('infra');
  const b0 = await now();
  await ev('window.__flow.state() && true');
  await sleep(400);
  c.close();
  await stop({ keepTmux: true });
  launch();
  c = await flowWindow();
  await goTo('infra');
  const b1 = await now();
  const gapB = (s) => at(s, 'i-sched').x - at(s, 'i-bench').x - at(s, 'i-bench').w;
  ok('after a restart, the room between windows is still there', near(gapB(b1), gapB(b0), 0.05) && gapB(b0) > 40, { before: gapB(b0), after: gapB(b1) });
  ok('the empty room added at the left is gone, the windows back at the start', b1.roomLeft === 0 && near(at(b1, 'i-bench').x, at(b0, 'i-bench').x - b0.roomLeft, 0.05), { roomLeft: [b0.roomLeft, b1.roomLeft], x: [at(b0, 'i-bench').x, at(b1, 'i-bench').x] });
  await goTo('ef');
  const f1 = await now();
  ok('room with a window in it stays part of the space', near(at(f1, 'e-note').x, 0, 0.3) && f1.roomLeft === 0, { note: at(f1, 'e-note').x, roomLeft: f1.roomLeft });
  await shot('16-after-restart');

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




