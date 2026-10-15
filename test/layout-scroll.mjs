// layout's check of two fingers up or down on bare desktop (STATUS item 52, with nav; owner 22:50 "maybe we even want this
// even for like below as well ... add space under"; batch 7, a Miro board: no pan limits, the view goes as far as the
// fingers do), with real input over CDP in layout's own isolated app (layout-lib.mjs): the view follows the fingers with
// nothing below and comes back by as much; room opened under a window and a window carried down past the bottom are
// reached with two fingers on bare desktop and left again, past the last window and past the top with no wall; over a
// window the content keeps the scroll; sideways still steps sub-workspaces. Shells only, no host windows, pages blank.
//   LAYOUT_ROOT=<app tree> node test/layout-scroll.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/scroll-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, shot as shotOf } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'scroll-shots');
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
/* ---------- a hand on the trackpad ---------- */
let px = 700, py = 400;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); px = x; py = y; }
/* Presses and releases carry their own times (CDP timestamp, s), as a real double-click does, so a busy renderer cannot
   stretch the 80 ms between its clicks. */
const stamp = (ms) => ({ timestamp: ms / 1000 });
async function press(x, y, n, at) { await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n, pointerType: 'mouse', ...(at ? stamp(at) : {}) }); }
async function release(x, y, n, at) { await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n, pointerType: 'mouse', ...(at ? stamp(at) : {}) }); }
async function dbl(x, y) { await glide(x, y); const t = Date.now(); await press(x, y, 1, t); await release(x, y, 1, t + 40); await press(x, y, 2, t + 120); await release(x, y, 2, t + 160); }
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

/* Two fingers on the trackpad: plain wheel events stamped 16 ms apart, as a trackpad sends them (a stall of this script
   on a loaded machine must not split one gesture in two), then a pause longer than a gesture's gap, so the next one is a
   new gesture. */
async function fingers(x, y, dys, dxs) {
  await glide(x, y);
  const t0 = Date.now();
  for (let i = 0; i < dys.length; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dxs ? dxs[i] : 0, deltaY: dys[i], button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * 16) / 1000 });
    await sleep(16);
  }
  await sleep(500);
}
const GESTURE = [2, 6, 12, 20, 24, 24, 20, 14, 8, 4];
const flip = (a) => a.map((d) => -d);
const spaceBottom = (wsId) => ev(`__flow.nav().sheet(__flow.state().ws.find((w) => w.id === ${q(wsId)})).h`);
const wholly = (s, id) => { const r = at(s, id); return r.sy >= s.vp.y - 0.5 && r.sy + r.sh <= s.vp.y + s.vp.h + 0.5; };
const what = (x, y) => ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); const w = e && e.closest && e.closest('.win'); return w ? 'window ' + w.dataset.id : (e.className || e.tagName); })()`);

/* A point of bare desktop on screen, looked for over the view (a gesture belongs to what is under its first event). */
async function bare(s) {
  for (const fy of [0.75, 0.5, 0.25, 0.9]) for (const fx of [0.5, 0.2, 0.8, 0.35, 0.65]) {
    const p = { x: s.vp.x + s.vp.w * fx, y: s.vp.y + s.vp.h * fy };
    if (/^(canvas|ws)\b/.test(await what(p.x, p.y))) return p;
  }
  throw new Error('no bare desktop on screen to swipe on');
}
/* Two fingers on bare desktop moving the view by total px (down > 0), in gestures of at most GESTURE x 4. */
async function swipeBy(total) {
  const unit = GESTURE.reduce((a, b) => a + b, 0) * 4;
  for (let left = Math.abs(total); left > 0.01;) {
    const part = Math.min(left, unit), k = part / (unit / 4), p = await bare(await now());
    await fingers(p.x, p.y, GESTURE.map((d) => (d * k) * Math.sign(total)));
    left -= part;
  }
}
const SUM = GESTURE.reduce((a, b) => a + b, 0);

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

  /* 1. voiceless: nothing below, and the board still goes on: two fingers down on bare desktop move the view down by as
     much as they move, nothing else moves, and up by as much brings it back */
  await goTo('voiceless');
  let s0 = await now();
  console.log(`voiceless: ${q(Object.fromEntries(Object.entries(s0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.y.toFixed(2), +v.w.toFixed(2), +v.h.toFixed(2)]])))}`);
  const bareTop = { x: s0.vp.x + s0.vp.w * 0.8, y: s0.vp.y + s0.vp.h * 0.93 };
  const atTop = await what(bareTop.x, bareTop.y);
  console.log(`bare desktop under the windows: ${atTop}`);
  ok('the fingers are on bare desktop', /^(canvas|ws)\b/.test(atTop), atTop);
  const still = (a, b) => Object.keys(a.wins).every((id) => near(a.wins[id].x, b.wins[id].x, 0.01) && near(a.wins[id].y, b.wins[id].y, 0.01));
  await fingers(bareTop.x, bareTop.y, GESTURE);
  let s1 = await now();
  ok('with nothing below, two fingers down on bare desktop move the view down by as much, and no window moves', near(s1.panY, s0.panY + SUM, 2) && near(s1.pan, s0.pan, 0.5) && still(s0, s1), { panY: [s0.panY, s1.panY], sum: SUM });
  await swipeBy(-SUM);
  s1 = await now();
  ok('two fingers up by as much bring the view back where it was', near(s1.panY, s0.panY, 2) && near(s1.pan, s0.pan, 0.5) && still(s0, s1), { panY: [s0.panY, s1.panY] });

  /* 2. room opened under the note: two fingers down on the bare room reach the shell moved below, go on past it with no
     wall, and come back up to the top and past it */
  const g = gapPoint(s1, 'v-note', 'v-term', 'y');
  await dbl(g.x, g.y);
  await settle();
  const s2 = await now(), bottom2 = await spaceBottom('voiceless');
  console.log(`after the double-click: v-term ${q([at(s2, 'v-term').y, at(s2, 'v-term').h])}; the space ends at ${bottom2.toFixed(2)}%`);
  ok('a double-click between the note and the shell under it opens room below', at(s2, 'v-term').y > at(s1, 'v-term').y + 30 && bottom2 > 100, { y: [at(s1, 'v-term').y, at(s2, 'v-term').y], bottom: bottom2 });
  const room = { x: at(s2, 'v-note').sx + at(s2, 'v-note').sw / 2, y: s2.vp.y + s2.vp.h * 0.6 };
  const atRoom = await what(room.x, room.y);
  console.log(`the room at ${q(room)}: ${atRoom}`);
  ok('the fingers are on the bare room', /^(canvas|ws)\b/.test(atRoom), atRoom);
  await fingers(room.x, room.y, GESTURE);
  const s3 = await now();
  ok('two fingers down on the bare room move the view down by as much', near(s3.panY, s2.panY + SUM, 2) && near(s3.pan, s2.pan, 0.5) && near(s3.zoom, 1, 0.001), { panY: [s2.panY, s3.panY], sum: SUM });
  /* just far enough for the whole shell, 20 px clear of the bottom */
  const need = at(s3, 'v-term').sy + at(s3, 'v-term').sh - (s3.vp.y + s3.vp.h) + 20;
  await swipeBy(need);
  const s4 = await now();
  ok('more of it brings the shell moved below wholly into view', near(s4.panY, s3.panY + need, 2) && wholly(s4, 'v-term'), { panY: [s3.panY, s4.panY], by: +need.toFixed(1) });
  await shot('01-room-below-reached');
  await swipeBy(SUM * 3);
  const s4b = await now();
  ok('and on past the last window: nothing stops the view below', near(s4b.panY, s4.panY + SUM * 3, 2), { panY: [s4.panY, s4b.panY], by: SUM * 3 });
  await swipeBy(-s4b.panY);
  const s5 = await now();
  ok('two fingers up by as much come back to the top', near(s5.panY, 0, 2) && still(s2, s5), { panY: s5.panY });
  await swipeBy(-SUM);
  const s5b = await now();
  ok('and on past the top: nothing stops the view above', near(s5b.panY, -SUM, 2) && still(s2, s5b), { panY: s5b.panY });
  await swipeBy(SUM);
  const s5c = await now();
  ok('down by as much is back at the top', near(s5c.panY, 0, 2), { panY: s5c.panY });

  /* 3. over a window, the scroll stays with what is in it: the view does not move */
  const overNote = { x: at(s5c, 'v-note').sx + at(s5c, 'v-note').sw / 2, y: at(s5c, 'v-note').sy + at(s5c, 'v-note').sh / 2 };
  const overTerm = { x: at(s5c, 'v-page').sx + at(s5c, 'v-page').sw / 2, y: at(s5c, 'v-page').sy + at(s5c, 'v-page').sh / 2 };
  const onNote = await what(overNote.x, overNote.y), onPage = await what(overTerm.x, overTerm.y);
  ok('the fingers are over the note and over the page', onNote === 'window v-note' && onPage === 'window v-page', { onNote, onPage });
  await fingers(overNote.x, overNote.y, GESTURE.map((d) => d * 3));
  await fingers(overTerm.x, overTerm.y, GESTURE.map((d) => d * 3));
  const s6 = await now();
  ok('two fingers down over the note and over the page leave the view where it is', near(s6.panY, s5c.panY, 0.5), { panY: [s5c.panY, s6.panY] });

  /* 4. ef: a shell carried down past the bottom grows the space; two fingers reach it and come back */
  await goTo('ef');
  const e0 = await now();
  const tb = { x: at(e0, 'e-term').sx + at(e0, 'e-term').sw / 2, y: at(e0, 'e-term').sy + 10 };
  await drag(tb.x, tb.y, tb.x, e0.vp.y + e0.vp.h - 8, 20, 600);
  await settle();
  const e1 = await now(), eb = await spaceBottom('ef');
  console.log(`ef after the carry: e-term y ${at(e1, 'e-term').y.toFixed(2)}, the space ends at ${eb.toFixed(2)}%, panY ${e1.panY.toFixed(1)}`);
  ok('a shell carried down past the bottom grows the space down', eb > 100 && at(e1, 'e-term').y > at(e0, 'e-term').y + 10, { bottom: eb, y: [at(e0, 'e-term').y, at(e1, 'e-term').y] });
  /* where the shell was: bare at the top of the space, and bare further down where nothing is */
  const bareE = { x: at(e0, 'e-term').sx + at(e0, 'e-term').sw / 2, y: e1.vp.y + e1.vp.h * 0.75 };
  const atE = await what(bareE.x, bareE.y);
  console.log(`bare desktop at ${q(bareE)}: ${atE}`);
  ok('the fingers are on bare desktop where the shell was', /^(canvas|ws)\b/.test(atE), atE);
  /* back to the top of the space by as much as the view went down with the carry, then down to the shell again */
  await swipeBy(-e1.panY);
  const e2 = await now();
  ok('two fingers up on bare desktop by as much go back to the top', near(e2.panY, 0, 2), { panY: [e1.panY, e2.panY] });
  const needE = at(e2, 'e-term').sy + at(e2, 'e-term').sh - (e2.vp.y + e2.vp.h) + 20;
  await swipeBy(needE);
  const e3 = await now();
  ok('two fingers down reach the carried shell, wholly in view', near(e3.panY, e2.panY + needE, 2) && wholly(e3, 'e-term'), { panY: [e2.panY, e3.panY], by: +needE.toFixed(1) });
  await shot('02-carried-below-reached');

  /* 5. flow: sideways on bare desktop still steps to the next sub-workspace */
  await goTo('flow');
  const f0 = await now();
  const bareF = { x: f0.vp.x + f0.vp.w * 0.2, y: f0.vp.y + f0.vp.h * 0.3 };
  const atF = await what(bareF.x, bareF.y);
  console.log(`flow bare desktop: ${atF}`);
  ok('the fingers are on bare desktop in flow', /^(canvas|ws)\b/.test(atF), atF);
  await fingers(bareF.x, bareF.y, [0, 0, 1, 2, 2, 1, 0, 0, 0, 0], [2, 6, 14, 24, 30, 30, 24, 16, 10, 6]);
  await sleep(600);
  const atNow = await ev(`__flow.state().ws.find((w) => w.id === 'flow').at || null`);
  ok('two fingers sideways on bare desktop still go to the next sub-workspace', atNow === 'z-research', { at: atNow });

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




