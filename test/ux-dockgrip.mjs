// ux's check of the dock against a window's bottom resize grip (overview, b8: the grip reaches 5 px below the window,
// into the 12 px strip that brings the dock up over windows). infra's i-note is put with its bottom on the dock's line
// by dragging its own bottom edge there (the button held, so no dock), before each case. Real input over CDP:
//   rest       the pointer rests on the grip inside the strip: the dock stays down, and a drag from there resizes with
//              the dock down all the way
//   overshoot  into the strip on the grip, back up onto the edge, press: the press is the grip's and the window resizes
//   pressup    the dock up from the very bottom, then a press on the grip below it: the dock goes, and stays down while
//              the edge is dragged
//   test/ux-dev.sh stop; test/ux-dev.sh start --fresh && node test/ux-dockgrip.mjs
import { connectTo, evaluate, size, sleep, mouse, reporter } from './ui-lib.mjs';

const R = reporter();
const app = await connectTo(9567, /\/src\/index\.html$/);
for (let i = 0; i < 120 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
await size(app, 1500, 913);
await sleep(2000);
const ID = 'i-note';
const rect = (sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; })()`);
const dockUp = () => evaluate(app, `(() => { const d = document.getElementById('dock'), cs = getComputedStyle(d); return cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.5 && cs.pointerEvents !== 'none'; })()`);
const at = (x, y) => evaluate(app, `(() => { const e = document.elementFromPoint(${x}, ${y}); if (!e) return null; if (e.dataset && e.dataset.rz) return 'grip ' + e.dataset.rz; return e.closest('#dock') ? 'the dock' : e.closest('.win') ? 'the window' : e.className || e.tagName; })()`);
async function glide(x0, y0, x1, y1, steps) { for (let i = 1; i <= steps; i++) { await mouse(app, 'mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await sleep(16); } }

/* infra on screen: its name at the top, as a hand does */
{
  const i = await evaluate(app, `__flow.state().ws.findIndex((w) => w.id === 'infra')`), p = await rect(`.sp[data-i="${i}"] .sn`);
  await mouse(app, 'mouseMoved', p.x + p.w / 2, p.y + p.h / 2);
  await mouse(app, 'mousePressed', p.x + p.w / 2, p.y + p.h / 2);
  await mouse(app, 'mouseReleased', p.x + p.w / 2, p.y + p.h / 2);
  await sleep(1200);
}
/* i-note's bottom edge dragged so the window ends `up` px above the viewport's bottom (overview's 12.8) */
async function bottomTo(up) {
  const vp0 = await rect('#viewport'), w0 = await rect(`.win[data-id="${ID}"]`), g0 = await rect(`.win[data-id="${ID}"] .rz[data-rz="s"]`);
  const gx = w0.x + w0.w / 3, gy = g0.y + g0.h / 2, ty = gy + (vp0.bottom - up - w0.bottom);
  await mouse(app, 'mouseMoved', gx, gy);
  await mouse(app, 'mousePressed', gx, gy);
  for (let i = 1; i <= 10; i++) { await mouse(app, 'mouseMoved', gx, gy + ((ty - gy) * i) / 10, { down: true }); await sleep(16); }
  await mouse(app, 'mouseReleased', gx, ty);
  await sleep(700);
  await mouse(app, 'mouseMoved', w0.x + w0.w / 2, w0.y + 40);
  await sleep(500);
}
for (const which of ['rest', 'overshoot', 'pressup']) {
await bottomTo(12.8);
const vp = await rect('#viewport'), win = await rect(`.win[data-id="${ID}"]`), grip = await rect(`.win[data-id="${ID}"] .rz[data-rz="s"]`), dock = await rect('#dock');
const setup = { ws: await evaluate(app, '__flow.state().ui.at'), windowBottomUp: win && +(vp.bottom - win.bottom).toFixed(1), grip: grip && [+(vp.bottom - grip.bottom).toFixed(1), +(vp.bottom - grip.y).toFixed(1)], dock: dock && [dock.x, dock.right, dock.y, dock.bottom] };
R.ok(`${which}: i-note sits with its bottom on the dock's line, its bottom grip reaching into the 12 px strip`, !!win && !!grip && setup.ws === 'infra' && vp.bottom - grip.bottom < 12 && Math.abs(vp.bottom - win.bottom - 12.8) < 3, setup);
const x = (dock.x + dock.right) / 2;
await glide(vp.x + vp.w / 2, vp.y + 60, win.x + win.w / 2, win.y + win.h / 2, 4);
await sleep(600);
const h0 = win.h;
let p = null;
if (which === 'rest' || which === 'overshoot') {
  const low = { x, y: vp.bottom - 9 };
  await glide(win.x + win.w / 2, win.y + win.h / 2, low.x, low.y, 10);
  await sleep(400);
  const upLow = await dockUp(), onLow = await at(low.x, low.y);
  R.ok(`${which}: the pointer resting on the grip 9 px from the bottom (inside the strip) leaves the dock down`, !upLow && onLow === 'grip s', { dockUp: upLow, under: onLow });
  p = low;
  if (which === 'overshoot') {
    const edge = { x, y: vp.bottom - 14 };
    await glide(low.x, low.y, edge.x, edge.y, 3);
    await sleep(300);
    const under = await at(edge.x, edge.y);
    R.ok('overshoot: back up onto the edge, 14 px from the bottom, the grip is under the pointer, not the dock', under === 'grip s' && !(await dockUp()), { under, dockUp: await dockUp() });
    p = edge;
  }
} else {
  const bottom = { x, y: vp.bottom - 2 };
  await glide(win.x + win.w / 2, win.y + win.h / 2, bottom.x, bottom.y, 10);
  await sleep(400);
  R.ok('pressup: at the very bottom, under the grip, the dock comes up', await dockUp(), { under: await at(bottom.x, bottom.y) });
  p = { x, y: vp.bottom - 10 };
  await glide(bottom.x, bottom.y, p.x, p.y, 2);
  await sleep(200);
  R.ok('pressup: 10 px from the bottom, below the dock, the grip is under the pointer', (await at(p.x, p.y)) === 'grip s', { under: await at(p.x, p.y), dockUp: await dockUp() });
}
await mouse(app, 'mousePressed', p.x, p.y);
const during = [];
for (let i = 1; i <= 15; i++) { await mouse(app, 'mouseMoved', p.x, p.y - i * 5, { down: true }); await sleep(30); during.push(await dockUp()); }
await mouse(app, 'mouseReleased', p.x, p.y - 75);
await sleep(700);
const h1 = (await rect(`.win[data-id="${ID}"]`)).h;
R.ok(`${which}: the drag up 75 px from there resizes the window by 75 px, with the dock down all the way`, Math.abs(h0 - h1 - 75) < 3 && during.every((u) => !u), { height: [+h0.toFixed(1), +h1.toFixed(1)], dockUpSamples: during.filter(Boolean).length });
await mouse(app, 'mouseMoved', vp.x + vp.w / 2, vp.y + 60);
await sleep(600);
}
R.ok('no console errors or exceptions', !app.errors.length, app.errors.slice(0, 5));
R.summary();
process.exit();




