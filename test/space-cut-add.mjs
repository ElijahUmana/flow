// The owner's space items (Nov 7: 02/6, 03/5, 03/9, 03/1) with real input over CDP in this check's own isolated app:
// socket flow-dev-space, CDP 9595, userData /tmp/flow-dev-space, marker --flow-dev=space. Shells only, no host windows.
// The board is the owner's image 02-02: three windows on one row with a wide empty gap in the middle.
//   SPACE_ROOT=<app tree> node test/space-cut-add.mjs [--keep]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, sleep, waitFor, mouse } from './nav-lib.mjs';

const ROOT = path.resolve(process.env.SPACE_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const PORT = 9595, SOCKET = 'flow-dev-space', USER_DATA = '/tmp/flow-dev-space', MARK = 'space';
const SHOTS = process.env.SPACE_SHOTS || path.join(USER_DATA, 'shots');
const PATTERN = `[e]lectron/dist/electron .*--flow-dev=${MARK}( |$)`;
const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const running = () => spawnSync('pgrep', ['-f', PATTERN]).status === 0;

function launch() {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const out = fs.openSync(path.join(USER_DATA, 'main.log'), 'a');
  spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${USER_DATA}`, `FLOW_TMUX_SOCKET=${SOCKET}`,
    `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1', './node_modules/.bin/electron', '.', '--no-sandbox', `--flow-dev=${MARK}`],
  { cwd: ROOT, env, stdio: ['ignore', out, out], detached: true }).unref();
}
async function stop() {
  spawnSync('pkill', ['-f', PATTERN]);
  const gone = await waitFor(() => !running(), 15000, 'the app to exit').then(() => true, () => false);
  if (!gone) spawnSync('pkill', ['-9', '-f', PATTERN]);
  spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
}
async function flowWindow() {
  const t = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .find((x) => x.type === 'page' && /\/src\/index\.html/.test(x.url) && !/solo=/.test(x.url)), 60000, 'the Flow window');
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') cdp.errors.push(`exception: ${m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') cdp.errors.push(`console.error: ${m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ')}`);
  });
  await cdp.send('Runtime.enable');
  await waitFor(() => cdp.eval('!!(window.__flow && window.__flow.ready)'), 60000, 'window.__flow');
  await cdp.eval('window.__flow.ready.then(() => true)');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

/* The owner's 02-02 board: a note at the left, a shell and a page-sized note far right, a wide empty gap between. */
function seed() {
  const work = path.join(USER_DATA, 'work');
  fs.mkdirSync(work, { recursive: true });
  const win = (id, type, x, y, w, h, extra = {}) => ({ id, type, x, y, w, h, ...extra });
  const ws = {
    id: 'board', name: 'board', folder: work, bg: '#17130f', mode: 'float', zones: [], closed: [], pan: 0, panY: 0, zoom: 1, panUnit: '%',
    notes: [{ id: 'n-left', title: 'left', body: '' }, { id: 'n-right', title: 'right', body: '' }],
    windows: [
      win('w-left', 'note', 1.2, 10, 22, 40, { noteId: 'n-left' }),
      win('w-mid', 'term', 120, 30, 22, 30, { cmd: 'shell', cwd: work }),
      win('w-right', 'note', 150, 12, 30, 34, { noteId: 'n-right' }),
      win('w-low', 'note', 1.2, 70, 22, 20, { noteId: 'n-left' }),
    ],
  };
  ws.notes.push({ id: 'n-low', title: 'low', body: '' });
  ws.windows[3].noteId = 'n-low';
  const other = { id: 'other', name: 'other', folder: work, bg: '#141319', mode: 'float', zones: [], closed: [], notes: [], windows: [], panUnit: '%' };
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws: [ws, other], ui: { at: 'board', hinted: true } }));
}

const state = () => c.eval(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === 'board'), vp = document.getElementById('viewport').getBoundingClientRect();
  const wins = {}; ws.windows.forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect();
    wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, sx: b && b.left, sy: b && b.top, sw: b && b.width, lit: !!(el && el.classList.contains('spacemove')) }; });
  const band = document.querySelector('.spaceband');
  return { pan: ws.pan || 0, panY: ws.panY || 0, zoom: ws.zoom || 1, roomRight: ws.roomRight || 0, sheet: __flow.nav().sheet(__flow.state().ws.find((w) => w.id === 'board')),
    vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins, cur: s.ui.at,
    band: band ? { cut: band.classList.contains('cut'), text: band.textContent, w: band.getBoundingClientRect().width } : null,
    canvasW: parseFloat(document.querySelector('.ws[data-id=board] .canvas').style.width) || 0 }; })()`);
const vwPx = (s, pct) => (pct / 100) * s.vp.w;
/* Real mouse: a press with Option held, moves, and a release. */
async function altDrag(x, y, dx, dy, { cancel = false, steps = 12, check } = {}) {
  await mouse(c, 'mouseMoved', x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: 1, pointerType: 'mouse' });
  let mid = null;
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1, modifiers: 1, pointerType: 'mouse' });
    await sleep(16);
    if (i === Math.ceil(steps / 2) && check) mid = await check();
  }
  if (cancel) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1, modifiers: cancel ? 0 : 1, pointerType: 'mouse' });
  await sleep(600);
  return mid;
}
async function cmdZ() {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 });
  await sleep(700);
}
async function rightClick(x, y) {
  await mouse(c, 'mouseMoved', x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(250);
  return c.eval(`[...document.querySelectorAll('.ctx button')].map((b) => b.firstChild.textContent)`);
}
async function pick(label) {
  const r = await c.eval(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => x.firstChild.textContent === ${q(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!r) return false;
  await mouse(c, 'mouseMoved', r.x, r.y);
  await mouse(c, 'mousePressed', r.x, r.y);
  await mouse(c, 'mouseReleased', r.x, r.y);
  await sleep(700);
  return true;
}
async function main() {
  console.log(`tree ${ROOT}`);
  if (running()) throw new Error('a --flow-dev=space app is already running');
  await stop();
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  seed();
  launch();
  c = await flowWindow();
  await sleep(1500);

  /* zoomed out so the whole row is in view, as in the owner's image: a real pinch (ctrl-wheel) at the left of the view */
  for (let i = 0; i < 16; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 500, deltaX: 0, deltaY: 6, modifiers: 2, pointerType: 'mouse' }); await sleep(20); }
  await sleep(900);
  const s0 = await state();
  console.log(`view zoom ${s0.zoom.toFixed(3)}, pan ${s0.pan.toFixed(2)}; gap left->mid ${(s0.wins['w-mid'].x - s0.wins['w-left'].x - s0.wins['w-left'].w).toFixed(1)}%`);
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (n) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${n}.png`), Buffer.from(r.data, 'base64')); };
  await shot('0-before');

  /* A. right-click in the gap: "remove empty space here" closes the gap down to the usual gap; nothing at the left moves */
  const L = s0.wins['w-left'], M = s0.wins['w-mid'];
  const gx = Math.round((L.sx + L.sw + M.sx) / 2), gy = Math.round(L.sy + 60);
  const items = await rightClick(gx, gy);
  ok('right-click on the empty gap offers remove empty space, add space, and more workspace to the right',
    items.includes('remove empty space here') && items.includes('add space here') && items.includes('more workspace to the right'), items);
  await pick('remove empty space here');
  const s1 = await state();
  const gap1 = s1.wins['w-mid'].x - (s1.wins['w-left'].x + s1.wins['w-left'].w);
  ok('the gap closes to the usual 1.2% and the middle window is now beside the left one', near(gap1, 1.2, 0.05), { gap: gap1 });
  ok('the windows past the gap move together, by the same amount, keeping their arrangement',
    near(s1.wins['w-right'].x - s0.wins['w-right'].x, s1.wins['w-mid'].x - s0.wins['w-mid'].x, 0.01) && near(s1.wins['w-right'].y, s0.wins['w-right'].y, 0.01),
    { mid: s1.wins['w-mid'].x - s0.wins['w-mid'].x, right: s1.wins['w-right'].x - s0.wins['w-right'].x });
  ok('the windows before the gap never move', near(s1.wins['w-left'].x, s0.wins['w-left'].x, 0.001) && near(s1.wins['w-low'].x, s0.wins['w-low'].x, 0.001));
  ok('the workspace got smaller: its right end moved in by the gap removed', s1.sheet.w < s0.sheet.w - 50, { before: s0.sheet.w, after: s1.sheet.w });
  await shot('1-gap-removed');

  /* B. ⌘Z puts it back exactly */
  await cmdZ();
  const s2 = await state();
  ok('Cmd+Z puts the removed space back exactly, every window where it was', ['w-left', 'w-mid', 'w-right', 'w-low'].every((id) => near(s2.wins[id].x, s0.wins[id].x, 0.001) && near(s2.wins[id].y, s0.wins[id].y, 0.001)));

  /* C. Option-drag left in the gap: removes exactly the dragged amount, with a red band and its size, the windows that move lit */
  const s2b = await state(), z = s2b.zoom, dragPx = -200;
  const mid = await altDrag(gx, gy, dragPx, 0, { check: () => state() });
  const s3 = await state();
  const want = (dragPx / z / s3.vp.w) * 100;
  ok('while dragging, the stretch being cut shows red with its size at actual size', mid && mid.band && mid.band.cut && /^\u2212\d+ px$/.test(mid.band.text), mid && mid.band);
  ok('while dragging, the windows that will move are lit and the left ones are not', mid && mid.wins['w-mid'].lit && mid.wins['w-right'].lit && !mid.wins['w-left'].lit && !mid.wins['w-low'].lit);
  ok('Option-drag left removes exactly the amount dragged', near(s3.wins['w-mid'].x - s2b.wins['w-mid'].x, want, 0.05), { moved: s3.wins['w-mid'].x - s2b.wins['w-mid'].x, want });
  ok('after letting go no band and no lit window remain', !s3.band && !Object.values(s3.wins).some((w) => w.lit));
  await shot('2-cut-by-drag');

  /* D. dragging far past the gap stops at the usual gap: it never pushes a window over another */
  await altDrag(gx - 120, gy, -2000, 0);
  const s4 = await state();
  const gap4 = s4.wins['w-mid'].x - (s4.wins['w-left'].x + s4.wins['w-left'].w);
  ok('cutting further than the gap stops at the usual gap; nothing overlaps', near(gap4, 1.2, 0.05), { gap: gap4 });

  /* E. Option-drag right adds exactly the amount dragged at that point, green, and Esc mid-drag cancels */
  // the two windows are now a usual gap apart, all of it resize grip on screen: the press lands on a grip
  const s4b = await state(), gx2 = Math.round(s4b.wins['w-left'].sx + s4b.wins['w-left'].sw + 3);
  const under = await c.eval(`(() => { const e = document.elementFromPoint(${gx2}, ${gy}); return e && e.classList.contains('rz') ? 'grip' : e ? e.className : null; })()`);
  console.log(`the add press at ${gx2},${gy} lands on: ${under}`);
  const midAdd = await altDrag(gx2, gy, 240, 0, { check: () => state() });
  const s5 = await state();
  const wantAdd = (240 / s5.zoom / s5.vp.w) * 100;
  ok('while adding, the band is green with +size', midAdd && midAdd.band && !midAdd.band.cut && /^\+\d+ px$/.test(midAdd.band.text), midAdd && midAdd.band);
  ok('Option-drag right adds exactly the amount dragged at that point, even on the grips between close windows; nothing is resized',
    near(s5.wins['w-mid'].x - s4b.wins['w-mid'].x, wantAdd, 0.05) && near(s5.wins['w-left'].x, s4b.wins['w-left'].x, 0.001) && near(s5.wins['w-left'].w, s4b.wins['w-left'].w, 0.001) && near(s5.wins['w-mid'].w, s4b.wins['w-mid'].w, 0.001),
    { moved: s5.wins['w-mid'].x - s4b.wins['w-mid'].x, want: wantAdd });
  await altDrag(gx2, gy, 300, 0, { cancel: true });
  const s6 = await state();
  ok('Esc during the drag puts everything back where it was', near(s6.wins['w-mid'].x, s5.wins['w-mid'].x, 0.01) && near(s6.wins['w-right'].x, s5.wins['w-right'].x, 0.01));
  await cmdZ();
  const s6u = await state();
  ok('Cmd+Z takes back the space just added', near(s6u.wins['w-mid'].x, s4b.wins['w-mid'].x, 0.01) && near(s6u.wins['w-right'].x, s4b.wins['w-right'].x, 0.01));

  /* F. a vertical cut: Option-drag up between the left window and the one under it */
  const s6b = await state(), A = s6b.wins['w-left'], B = s6b.wins['w-low'];
  const vy = Math.round((A.sy + (A.h / 100) * s6b.vp.h * s6b.zoom + B.sy) / 2), vx = Math.round(A.sx + 40);
  await altDrag(vx, vy, 0, -2000);
  const s7 = await state();
  const gapY = s7.wins['w-low'].y - (s7.wins['w-left'].y + s7.wins['w-left'].h);
  ok('Option-drag up between windows one above the other closes that gap to the usual gap', near(gapY, 1.8, 0.05), { gapY });
  ok('the vertical cut moves only the windows below', near(s7.wins['w-left'].y, s6b.wins['w-left'].y, 0.001) && near(s7.wins['w-mid'].y, s6b.wins['w-mid'].y, 0.001));

  /* G. 03/1: more workspace to the right with nothing dragged there, from the bare board's right-click and from a
     double-click at the right edge; Cmd+Z takes it back; the same tool cuts the empty end back to the windows */
  const s7b = await state(), bx = Math.round(s7b.vp.x + s7b.vp.w * 0.9);
  await rightClick(bx, gy);
  await pick('more workspace to the right');
  const s8 = await state();
  ok('"more workspace to the right" makes the workspace one view wider at its right end, nothing moved', near(s8.sheet.w, s7b.sheet.w + 100, 0.01) && ['w-left', 'w-mid', 'w-right', 'w-low'].every((id) => near(s8.wins[id].x, s7b.wins[id].x, 0.001)),
    { before: s7b.sheet.w, after: s8.sheet.w });
  ok('the new right end is in view', s8.sheet.w <= s8.pan + 100 / s8.zoom + 0.01, { end: s8.sheet.w, viewRight: s8.pan + 100 / s8.zoom });
  await shot('3-more-right');
  const ex = s8.vp.x + s8.vp.w - 6, ey = s8.vp.y + s8.vp.h / 2;
  for (const n of [1, 2]) {
    await mouse(c, 'mouseMoved', ex, ey);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ex, y: ey, button: 'left', buttons: 1, clickCount: n, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', buttons: 0, clickCount: n, pointerType: 'mouse' });
    await sleep(60);
  }
  await sleep(900);
  const s9 = await state();
  ok('a double-click at the right edge with nothing past it adds a view of workspace there too', near(s9.sheet.w, s8.sheet.w + 100, 0.01), { before: s8.sheet.w, after: s9.sheet.w });
  await cmdZ();
  const s10 = await state();
  ok('Cmd+Z takes that added room back', near(s10.sheet.w, s8.sheet.w, 0.01), { now: s10.sheet.w, want: s8.sheet.w });
  const endX = Math.round(s10.vp.x + s10.vp.w - 80);
  const midEnd = await altDrag(endX, gy, -4000, 0, { check: () => state() });
  const s11 = await state(), ends = Math.max(100, ...Object.values(s11.wins).map((w) => w.x + w.w + 1.2));
  ok('empty room at the right end is removable with the same Option-drag, back to the windows and no further', near(s11.sheet.w, ends, 0.05) && ['w-left', 'w-mid', 'w-right', 'w-low'].every((id) => near(s11.wins[id].x, s10.wins[id].x, 0.001)),
    { before: s10.sheet.w, after: s11.sheet.w, windowsEnd: ends, band: midEnd && midEnd.band });

  /* H. it lasts: a restart keeps the closed gap */
  const keep = await state();
  c.close();
  await stop();
  launch();
  c = await flowWindow();
  await sleep(1200);
  const s12 = await state();
  ok('after a restart every window is where the space changes left it', ['w-left', 'w-mid', 'w-right', 'w-low'].every((id) => near(s12.wins[id].x, keep.wins[id].x, 0.001) && near(s12.wins[id].y, keep.wins[id].y, 0.001)));
  ok('no console errors', c.errors.length === 0, c.errors);
  await shot('4-after-restart');
}

main().catch((e) => { fails++; console.log(`FAIL the check finished: ${e.stack || e}`); }).finally(async () => {
  if (c) c.close();
  if (!KEEP) await stop();
  console.log(`${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
});




