// ux's check of the arrange control (src/arrange.js with nav.arrange, item 7), with real input over CDP: the dock's ▦
// and ⌃⌘A ('arrange'). In flow's main space: each press moves the windows to a new arrangement where none covers another,
// the fifth comes back to the owner's own exactly, a hand move starts a new cycle from it, a window opened does too; the
// windows glide (frame by frame); no words show at rest.   test/ux-dev.sh stop; test/ux-dev.sh start --fresh && node test/ux-arrange.mjs
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { connectTo, evaluate, size, shot, sleep, mouse, click, reporter } from './ui-lib.mjs';

const SHOTS = path.join(os.homedir(), 'flow-evidence', 'ux', 'evidence', 'arrange');
fs.mkdirSync(SHOTS, { recursive: true });
const W = 1500, H = 913;
const R = reporter();
const app = await connectTo(9567, /\/src\/index\.html$/);
for (let i = 0; i < 120 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
await size(app, W, H);
await sleep(1500);
const rect = (sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
/* The windows of the space on screen, as the state has them (space %). */
const wins = () => evaluate(app, `(() => { const ws = __flow.state().ws[[...document.querySelectorAll('.sp')].indexOf(document.querySelector('.sp.on'))];
  return ws.windows.filter((w) => { const e = document.querySelector('.win[data-id="' + w.id + '"]'); return e && e.style.display !== 'none'; }).map((w) => ({ id: w.id, x: +w.x, y: +w.y, w: +w.w, h: +w.h })); })()`);
const key = (list) => JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map((w) => [w.id, ...[w.x, w.y, w.w, w.h].map((v) => Math.round(v * 100) / 100)]));
const overlaps = (list) => { const o = []; list.forEach((a, i) => list.slice(i + 1).forEach((b) => { if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) o.push([a.id, b.id]); })); return o; };
const rest = async () => { await mouse(app, 'mouseMoved', W * 0.45, H * 0.4); await sleep(700); };
const mode = () => evaluate(app, `__flow.state().ws[[...document.querySelectorAll('.sp')].indexOf(document.querySelector('.sp.on'))].mode`);

/* The dock's ▦: brought up at the bottom middle, then clicked, as a hand does; the slide given time to end. */
async function pressDock() {
  const d = await rect('#dock');
  await mouse(app, 'mouseMoved', d.cx, H - 6);
  await sleep(250);
  const b = await rect('#dock [data-k="arrange"]');
  await click(app, b.cx, b.cy);
  await sleep(900);
  await rest();
}

await rest();
const btn = await rect('#dock [data-k="arrange"]');
const name = await evaluate(app, `(() => { const s = document.querySelector('#dock [data-k="arrange"] span'); return s ? { text: s.textContent, op: getComputedStyle(s).opacity } : null; })()`);
R.ok('the dock has the arrange button, its name "arrange" shown only on hover', !!btn && !!name && name.text === 'arrange' && name.op === '0', name);
R.ok('the space is free (float), as it will be once the modes go', (await mode()) === 'float', await mode());
const yours = await wins();
const seen = [key(yours)];
const glides = [];
for (let n = 1; n <= 4; n++) {
  // the glide of the first press, frame by frame: a window's left as drawn
  if (n === 1) {
    // every window of the space, every frame: the one that moves most shows the glide
    const ids = JSON.stringify(yours.map((w) => w.id));
    await evaluate(app, `(() => { const els = ${ids}.map((id) => document.querySelector('.win[data-id="' + id + '"]')); window.__gl = { f: [], on: true, t0: performance.now() }; const tick = () => { if (!__gl.on) return; __gl.f.push([+(performance.now() - __gl.t0).toFixed(1), els.map((e) => { const r = e.getBoundingClientRect(); return [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]; })]); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
  }
  await pressDock();
  if (n === 1) glides.push(await evaluate(app, '(() => { __gl.on = false; return __gl.f; })()'));
  const now = await wins();
  const k = key(now);
  R.ok(`press ${n}: the windows move to a new arrangement, none covering another`, !seen.includes(k) && overlaps(now).length === 0, { overlaps: overlaps(now) });
  seen.push(k);
  await shot(app, path.join(SHOTS, `press-${n}.png`));
}
await pressDock();
R.ok('press 5 brings back the owner\'s own arrangement exactly, after four different ones', key(await wins()) === seen[0] && new Set(seen).size === 5);
// the glide: frames between the first and last change, the largest jump between frames, and frame gaps
{
  const all = glides[0] || [];
  // the window that travelled furthest between the first and last frame
  const far = all.length ? all[0][1].map((r0, k) => Math.hypot(all[all.length - 1][1][k][0] - r0[0], all[all.length - 1][1][k][1] - r0[1]) + Math.abs(all[all.length - 1][1][k][2] - r0[2])) : [];
  const k = far.indexOf(Math.max(...far));
  const f = all.map((x) => [x[0], ...x[1][k]]);
  const moving = f.filter((x, i) => i && (x[1] !== f[i - 1][1] || x[2] !== f[i - 1][2] || x[3] !== f[i - 1][3]));
  const span = moving.length ? moving[moving.length - 1][0] - moving[0][0] : 0;
  const steps = moving.map((x, i) => (i ? Math.hypot(x[1] - moving[i - 1][1], x[2] - moving[i - 1][2]) : 0));
  const gaps = f.slice(1).map((x, i) => x[0] - f[i][0]);
  R.ok('the first press glides: the window moves over several frames, not in one jump', moving.length >= 5 && span >= 150, { framesMoving: moving.length, spanMs: Math.round(span), biggestStepPx: Math.round(Math.max(0, ...steps)), worstGapMs: Math.round(Math.max(0, ...gaps)) });
}
// ⌃⌘A, from the menu, does what the button does
await evaluate(app, `__flow.menu('arrange')`);
await sleep(900);
const viaKey = await wins();
R.ok('⌃⌘A (the menu\'s arrange) presses it too: the windows move, none covering another', key(viaKey) !== seen[0] && overlaps(viaKey).length === 0);
// a hand move makes a new own arrangement: five presses later the windows are back where the hand left them
{
  const first = viaKey[0];
  const tb = await rect(`.win[data-id="${first.id}"] > .tb`);
  await mouse(app, 'mouseMoved', tb.x + 60, tb.cy);
  await mouse(app, 'mousePressed', tb.x + 60, tb.cy);
  for (let i = 1; i <= 10; i++) await mouse(app, 'mouseMoved', tb.x + 60 + 4 * i, tb.cy + 3 * i, { down: true });
  await sleep(150);
  await mouse(app, 'mouseReleased', tb.x + 100, tb.cy + 30);
  await sleep(800);
  await rest();
  const moved = await wins();
  let changed = false;
  for (let n = 0; n < 5; n++) { await pressDock(); if (n < 4 && key(await wins()) !== key(moved)) changed = true; }
  R.ok('after a hand move, five presses go through other arrangements and come back to the one the hand left', changed && key(await wins()) === key(moved), { changed, moved: key(moved).slice(0, 120) });
}
// a window opened makes a new own arrangement too
{
  await pressDock();
  const id = await evaluate(app, `__flow.spawn('note')`);
  await sleep(1200);
  await rest();
  const withNew = await wins();
  // a way that would move nothing is skipped, so the way back can take fewer than five presses
  let back = 0, clean = true;
  for (let n = 1; n <= 5 && !back; n++) { await pressDock(); const now = await wins(); if (overlaps(now).length) clean = false; if (key(now) === key(withNew)) back = n; }
  R.ok('after a window is opened, the presses start from the arrangement with it, and come back to it within five', withNew.some((w) => w.id === id) && back > 1 && clean, { back, clean });
}
R.ok('no console errors or exceptions', !app.errors.length, app.errors.slice(0, 5));
R.summary();
process.exit();




