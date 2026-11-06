// zoom's check of pinch zoom in the real app, with real input over CDP: ctrl-wheel events stand in for a trackpad pinch
// (Chromium's own form of it), mouse events for clicks, drags and double-clicks. Runs zoom's isolated app
// (test/zoom-lib.mjs: socket flow-dev-zoom, userData /tmp/flow-dev-zoom, CDP 9579) on the safe seed: shells only, no
// host windows.
//   node test/zoom-cdp.mjs [--keep] [--only a,b]
// Screenshots go to ~/flow-evidence/zoom/shots (not /tmp: this VM empties it at every reboot).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './zoom-lib.mjs';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const SHOTS = path.join(os.homedir(), 'flow-evidence/zoom/shots');
const SW = [8, 18, 30, 42, 46, 40, 34, 28, 22, 18, 14, 11, 9, 7, 5, 4, 3, 2, 2, 1];
const BACK = SW.map((d) => -d);

let fails = 0, oks = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

let c;
const earlier = [];
const ev = (x) => c.eval(x);
/* The space on screen of the workspace on screen: its view, and where it is drawn this frame. */
/* Pans in px at zoom 1: kept in % of the view once ws.panUnit is '%' (item 44), converted with the view's size as nav does. */
const view = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), r = document.getElementById('viewport').getBoundingClientRect();
  const px = (p, d) => (ws.panUnit === '%' ? ((p || 0) / 100) * d : p || 0);
  const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ws[data-id="' + ws.id + '"] .canvas')).transform);
  return { ws: ws.id, sp: ws.at || null, x: +px(ws.pan, r.width).toFixed(2), y: +px(ws.panY, r.height).toFixed(2), z: +(ws.zoom || 1).toFixed(4), dx: +(-m.m41 / m.a).toFixed(2), dy: +(-m.m42 / m.a).toFixed(2), dz: +m.a.toFixed(4) }; })()`);
const VP = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), m = document.querySelector('.menubar').getBoundingClientRect(); return { x: v.left, y: v.top, w: v.width, h: v.height, top: m.bottom }; })()`);
/* The canvas point under a screen point, in px at zoom 1, from what is drawn. */
const under = (x, y) => ev(`(() => { const c = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"] .canvas'), m = new DOMMatrixReadOnly(getComputedStyle(c).transform), b = c.parentElement.getBoundingClientRect();
  return { x: +((${x} - b.left - m.m41) / m.a).toFixed(2), y: +((${y} - b.top - m.m42) / m.a).toFixed(2) }; })()`);
/* The space's extent (nav's sheet: its windows, at least one view, room added) as drawn this frame, in px of the view. */
const extent = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), e = __flow.nav().sheet(ws), sec = document.querySelector('.ws[data-id="' + ws.id + '"]');
  const m = new DOMMatrixReadOnly(getComputedStyle(sec.querySelector('.canvas')).transform), b = sec.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect();
  return { x: +(b.left - v.left + m.m41).toFixed(1), y: +(b.top - v.top + m.m42).toFixed(1), w: +((e.w / 100) * v.width * m.a).toFixed(1), h: +((e.h / 100) * v.height * m.a).toFixed(1) }; })()`);
/* What the space on screen is drawn on: its section's visible layers and the backgrounds behind them (owner, Nov 2
   14:12: zooming out must not change the background, as if it were another workspace). */
const layers = () => ev(`(() => { const sec = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"]'), bg = (e) => { const c = getComputedStyle(e); return c.backgroundColor + ' ' + c.backgroundImage; };
  return { layers: [...sec.children].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.className || e.tagName.toLowerCase()), space: bg(sec), view: bg(document.getElementById('viewport')) }; })()`);
const glows = () => ev(`[document.getElementById('edgeL').classList.contains('on'), document.getElementById('edgeR').classList.contains('on')]`);
/* Empty desktop near a share of the view (elementFromPoint is the space or its canvas), below the pills. */
const empty = (fx = 0.5, fy = 0.5, inSpace = false) => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), top = document.querySelector('.menubar').getBoundingClientRect().bottom + 8;
  const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), e = __flow.nav().sheet(ws), sec = document.querySelector('.ws[data-id="' + ws.id + '"]'), b = sec.getBoundingClientRect();
  const m = new DOMMatrixReadOnly(getComputedStyle(sec.querySelector('.canvas')).transform), x0 = b.left + m.m41, y0 = b.top + m.m42;
  const sb = { left: x0, top: y0, right: x0 + (e.w / 100) * v.width * m.a, bottom: y0 + (e.h / 100) * v.height * m.a };
  const want = { x: v.left + v.width * ${fx}, y: top + (v.bottom - top) * ${fy} }; let best = null;
  for (let y = top; y < v.bottom - 16; y += 8) for (let x = v.left + 12; x < v.right - 12; x += 8) {
    if (${inSpace} && (x < sb.left + 4 || x > sb.right - 4 || y < sb.top + 4 || y > sb.bottom - 4)) continue;
    const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) { const d = Math.hypot(x - want.x, y - want.y); if (!best || d < best.d) best = { x, y, d }; } }
  return best; })()`);
const box = (id) => ev(`(() => { const e = document.querySelector('.win[data-id="${id}"]'); if (!e || e.style.display === 'none') return null; const b = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect();
  return { x: +(b.left - v.left).toFixed(1), y: +(b.top - v.top).toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), inView: b.left >= v.left - 1 && b.right <= v.right + 1 && b.top >= v.top - 1 && b.bottom <= v.bottom + 1 }; })()`);
async function pinch(x, y, dys, gapMs = 16) {
  const t0 = Date.now();
  for (let i = 0; i < dys.length; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dys[i], modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * gapMs) / 1000 });
  }
}
/* In the page: when the last wheel event arrived, and every zoom the space on screen is drawn at, in order (this VM
   is loaded enough that events queue for a second or more behind slow frames). */
const RECORD = `(() => { if (window.__z) return true; window.__z = { last: 0, zs: [], mo: null };
  for (const t of ['wheel', 'pointermove', 'pointerdown', 'pointerup']) window.addEventListener(t, () => { __z.last = performance.now(); }, { capture: true, passive: true });
  __z.watch = () => { if (__z.mo) __z.mo.disconnect(); __z.zs = []; const c = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"] .canvas');
    __z.mo = new MutationObserver(() => { const m = /scale\\(([0-9.e-]+)\\)/.exec(c.style.transform); const z = m ? +m[1] : 1; if (__z.zs[__z.zs.length - 1] !== z) __z.zs.push(z); });
    __z.mo.observe(c, { attributes: true, attributeFilter: ['style'] }); return true; };
  return true; })()`;
/* Until the page has had no wheel or pointer event for 1.4 s (longer than the end of a pinch can wait), then until the
   view has settled: what is drawn (the canvas) matches the state and stays put. Throws if either never
   comes, so no check reads a view that is still moving or drawn other than it is kept. */
async function drain() {
  await L.sleep(150);
  for (let i = 0; (await ev('performance.now() - window.__z.last')) < 1400; i++) {
    if (i === 150) throw new Error('events still arriving 15 s after the last one was sent');
    await L.sleep(100);
  }
  let last = '', v;
  for (let i = 0; i < 40; i++) {
    await L.sleep(200);
    v = await view();
    const now = JSON.stringify(v);
    // drawn on whole device pixels (nav show): what is drawn may sit up to half a device pixel from the kept view
    const tol = 0.5 / v.dz + 0.01;
    if (now === last && near(v.dx, v.x, tol) && near(v.dy, v.y, tol) && near(v.dz, v.z, 0.0005)) return;
    last = now;
  }
  throw new Error(`the view did not settle in 8 s: drawn at ${v.dz} (${v.dx}, ${v.dy}), kept at ${v.z} (${v.x}, ${v.y})`);
}
/* A pinch that has ended: the fingers lifted and the app settled. */
async function pinched(x, y, dys) { await pinch(x, y, dys); await drain(); }
async function press(x, y) { await L.mouse(c, 'mouseMoved', x, y); await L.mouse(c, 'mousePressed', x, y); await L.mouse(c, 'mouseReleased', x, y); }
async function rightClick(x, y) {
  await L.mouse(c, 'mouseMoved', x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
async function menuItem(re) {
  const it = await ev(`(() => { const e = [...document.querySelectorAll('.ctx button')].find((x) => ${re}.test(x.textContent)); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!it) throw new Error(`no menu item ${re}`);
  await press(it.x, it.y);
}
async function pill(i) { const p = await ev(`(() => { const b = document.querySelector('.sp[data-i="${i}"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); await press(p.x, p.y); await L.sleep(800); }
/* batch 8 lets a swipe go once no wheel has come for a while plus however late its wheels came: wait for it to land */
async function swipe(dxs, x, y) { await L.swipe(c, x, y, dxs); await L.sleep(800); await drain(); }
const windowsHere = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at); return ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).map((w) => w.id); })()`);

/* Back to actual size at the start of the space on screen, with real input: a pinch to 1, then drags. */
async function home() {
  for (let k = 0; k < 3; k++) {
    const v = await view();
    if (v.z === 1) break;
    const p = await empty(0.5, 0.5, true);
    await pinched(p.x, p.y, [100 * Math.log(v.z)]);
  }
  // the space's start at the left of what the sidebar leaves in view (batch 9's overlay; 0 when it does not cover the view)
  const ins = await ev(`(() => { const s = document.getElementById('sb').getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return Math.max(0, Math.round(s.right - v.left)); })()`);
  for (let k = 0; k < 10; k++) {
    const v = await view();
    if (Math.abs(v.x + ins) < 0.5 && Math.abs(v.y) < 0.5) break;
    const p = await empty(v.x + ins > 0 ? 0.1 : 0.9, v.y > 0 ? 0.2 : 0.8);
    const dx = Math.max(-500, Math.min(500, v.x + ins)), dy = Math.max(-300, Math.min(300, v.y));
    await L.drag(c, p.x, p.y, Array(10).fill(dx / 10), { gapMs: 30, holdMs: 200, dy });
    await L.sleep(500);
  }
  const v = await view();
  if (v.z !== 1 || Math.abs(v.x + ins) > 0.5 || Math.abs(v.y) > 0.5) throw new Error(`could not get back to actual size at the start (${JSON.stringify(v)}, sidebar over ${ins} px)`);
  return v;
}

const SCEN = [];
const scenario = (name, fn) => SCEN.push({ name, fn });

/* Flows' farbar case (Nov 2 15:3x), first, while no window lies over another as seeded: at 0.4868, above the 40%
   where bars are drawn at their 100% size, a window's bar is its own and a click on its first row reaches the row. */
scenario('farbar', async () => {
  await home();
  const p = await empty(0.5, 0.45);
  await pinched(p.x, p.y, Array(12).fill(6));
  const z = (await view()).z, rows = await firstRows(['w-design', 'w-week']);
  ok(`at ${z} a click on a window's first row reaches the row, under a bar of the window's own scale (flows' farbar case)`, z >= 0.4 && z < 0.5 && rows.every((r) => r.hitsRow && near(r.tb, 30 * z, 1)), rows);
  await home();
});

scenario('out', async () => {
  await home();
  const V = await VP();
  const flat = await layers();
  ok('at actual size neither side glows on a space that fits the view', (await glows()).join() === 'false,false', { glows: await glows(), drawnOn: flat });
  const p = await empty(0.3, 0.35);
  const u0 = await under(p.x, p.y), zs = [];
  // each reading once that pinch shows (on a loaded VM its events can be drawn a frame or two late), the last once all are
  for (let i = 0; i < 6; i++) {
    const was = i ? zs[i - 1] : 1;
    await pinch(p.x, p.y, Array(4).fill(5));
    await L.waitFor(async () => (await view()).dz < was - 1e-4, 4000, 'the pinch to show').catch(() => {});
    zs.push((await view()).dz);
  }
  await drain();
  const zEnd = (await view()).dz, u1 = await under(p.x, p.y);
  ok('pinching in on empty desktop zooms out progressively, the more the further', zs.every((z, i) => i === 0 || z < zs[i - 1]) && zs[0] < 1 && zEnd < 0.32, { drawn: zs, end: zEnd });
  ok('the point under the fingers stays put', near(u1.x, u0.x, 2) && near(u1.y, u0.y, 2), { before: u0, after: u1 });
  await L.sleep(500);
  const far = await layers();
  ok(`zoomed out (${(await view()).z}), the workspace is drawn on the same background as at 100%, with nothing laid over it or around it`, JSON.stringify(far) === JSON.stringify(flat), { atActualSize: flat, zoomedOut: far });
  ok('with the whole space in view, neither side glows', (await glows()).join() === 'false,false', await glows());
  await L.shot(c, path.join(SHOTS, 'z01-out.png'));
  await pinched(p.x, p.y, Array(25).fill(10));
  ok('pinching on, a small space zooms out on to 5%, where it stops', (await view()).z === 0.05, await view());
});

scenario('hold', async () => {
  await home();
  const p = await empty(0.4, 0.4);
  await pinched(p.x, p.y, Array(12).fill(8));
  const z0 = (await view()).z;
  await ev('__z.watch()');
  const n = 45, d = -3;
  await pinch(p.x, p.y, Array(n).fill(d));
  await drain();
  const zs = await ev('__z.zs'), z1 = (await view()).z;
  const free = z0 * Math.exp((-d * n) / 100), held = free / 1.12;
  ok('pinching back from far out, the zoom rests at exactly 100% on the way', zs.includes(1) && zs.indexOf(1) > 0 && zs[zs.indexOf(1) - 1] < 1 && zs.slice(zs.indexOf(1)).some((z) => z > 1), zs.map((z) => +z.toFixed(3)));
  ok('and goes on past it only after 12% more pinch, with no jump', near(z1, held, 0.01) && zs.filter((z) => z > 1).every((z, i, a) => (i === 0 ? z < 1.04 : z > a[i - 1] && z / a[i - 1] < 1.04)), { from: z0, end: z1, without: +free.toFixed(4), want: +held.toFixed(4) });
  await ev('__z.watch()');
  await pinch(p.x, p.y, [3]);
  await drain();
  const zs2 = await ev('__z.zs');
  ok('a new pinch that starts away from 100% moves at once', zs2.length >= 1 && zs2[0] < z1, { start: z1, drawn: zs2 });
  await home();
  await ev('__z.watch()');
  await pinch(p.x, p.y, [3]);
  await drain();
  const zs3 = await ev('__z.zs');
  ok('a pinch that starts at 100% moves at once (the rest is only on the way back)', zs3.length >= 1 && zs3[0] < 1, zs3);
});

scenario('settle', async () => {
  await home();
  const p = await empty(0.75, 0.6);
  await pinched(p.x, p.y, [100 * -Math.log(0.95)]);
  const v1 = await view();
  ok('a pinch that ends at 95% stays at 95%: nothing but the fingers moves the zoom', near(v1.z, 0.95, 0.002) && near(v1.dz, 0.95, 0.002), v1);
  await home();
  await pinched(p.x, p.y, [100 * -Math.log(0.88)]);
  const v2 = await view();
  ok('a pinch that ends at 88% stays at 88%', near(v2.z, 0.88, 0.002), v2);
  await home();
  await pinched(p.x, p.y, [100 * -Math.log(1.06)]);
  ok('one that ends at 106% stays at 106%', near((await view()).z, 1.06, 0.002), await view());
});

/* The board point under the fingers stays under them wherever they are (lead, Nov 2 21:1x: as on a Miro board):
   zoomed out, a pinch in over empty board below the windows zooms into that spot. */
scenario('anchor', async () => {
  await home();
  const p = await empty(0.5, 0.35);
  await pinched(p.x, p.y, Array(12).fill(10));
  const V = await VP(), s0 = await extent(), v0 = await view();
  const below = { x: V.x + V.w * 0.85, y: V.y + Math.min(V.h - 20, s0.y + s0.h + 120) };
  const hit = await ev(`document.elementFromPoint(${below.x}, ${below.y}).className`);
  const b0 = await under(below.x, below.y);
  await pinched(below.x, below.y, Array(14).fill(-5));
  const v = await view(), b1 = await under(below.x, below.y), drift = +(Math.hypot(b1.x - b0.x, b1.y - b0.y) * v.z).toFixed(2);
  ok(`zoomed out, a pinch in on empty board below the windows (${hit}) zooms into that spot: the point under the fingers stays put (${drift} px)`, v.z > v0.z + 0.2 && drift < 1, { from: v0, view: v, pointBefore: b0, pointAfter: b1 });
  await L.shot(c, path.join(SHOTS, 'z03-anchor.png'));
});

/* Pinching out draws everything toward the fingers: from any point of the view the board point under them stays put
   and every window wholly in view stays wholly in view (lead, Nov 2 21:1x; ux's drift case is the first point: 15 px
   before batch 10). */
scenario('pinch-out-keeps', async () => {
  for (const [fx, fy] of [[0.3, 0.3], [0.04, 0.05], [0.96, 0.95], [0.5, 0.5], [0.96, 0.05], [0.04, 0.95]]) {
    await home();
    const p0 = await empty(0.55, 0.5);
    await pinched(p0.x, p0.y, Array(9).fill(10));
    const V = await VP(), top = V.top, pt = { x: Math.round(V.x + V.w * fx), y: Math.round(top + (V.y + V.h - 14 - top) * fy) };
    const whole = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), t = ${top};
      return [...document.querySelectorAll('.ws[data-id="' + __flow.state().ui.at + '"] .canvas > .win')].filter((e) => e.style.display !== 'none').filter((e) => { const b = e.getBoundingClientRect(); return b.left >= v.left - 0.5 && b.right <= v.right + 0.5 && b.top >= t - 0.5 && b.bottom <= v.bottom + 0.5; }).map((e) => e.dataset.id).sort(); })()`);
    const v0 = await view(), w0 = await whole(), b0 = await under(pt.x, pt.y);
    await pinched(pt.x, pt.y, Array(6).fill(10));
    const v1 = await view(), w1 = await whole(), b1 = await under(pt.x, pt.y), drift = +(Math.hypot(b1.x - b0.x, b1.y - b0.y) * v1.z).toFixed(2);
    ok(`pinching out ${v0.z} to ${v1.z} with the fingers at ${fx}/${fy} of the view: the point under them stays put (${drift} px), and the ${w0.length} windows wholly in view stay so`, v1.z < v0.z - 0.1 && drift < 1 && w0.every((id) => w1.includes(id)), { at: pt, before: { view: v0, whole: w0, point: b0 }, after: { view: v1, whole: w1, point: b1 } });
  }
  await home();
});

scenario('floor', async () => {
  const i = await ev(`__flow.state().ws.findIndex((w) => w.id === 'infra')`);
  await pill(i);
  await home();
  /* Park windows past the end until the space is wider than three views. */
  for (let k = 0; k < 6; k++) {
    const end = await ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === 'infra'); return Math.max(...ws.windows.filter((w) => !w.zone).map((w) => w.x + w.w)); })()`);
    if (end > 345) break;
    await home();
    const id = await ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); const e = [...document.querySelectorAll('.ws[data-id="infra"] .win')].find((x) => { const b = x.getBoundingClientRect(); return x.style.display !== 'none' && b.left > v.left && b.right < v.right; }); return e && e.dataset.id; })()`);
    if (!id) break;
    const y = await ev(`(() => { const b = document.querySelector('.win[data-id="${id}"] .lights i:nth-child(2)').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await press(y.x, y.y);
    await L.sleep(700);
  }
  const end = await ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === 'infra'); return Math.max(...ws.windows.filter((w) => !w.zone).map((w) => w.x + w.w)); })()`);
  await home();
  const V = await VP(), p = await empty(0.5, 0.5);
  await pinched(p.x, p.y, Array(40).fill(10));
  const v = await view(), s = await extent();
  ok(`a space ${Math.round(end)}% wide zooms out to 5%, as every space does`, end > 300 && v.z === 0.05, { zoom: v.z, end });
  ok('and there the whole space is on screen', s.x >= -1 && s.x + s.w <= V.w + 1 && s.y >= -1 && s.y + s.h <= V.h + 1, { space: s, view: { w: V.w, h: V.h } });
  await L.shot(c, path.join(SHOTS, 'z04-floor.png'));
  await home();
  await pill(0);
});

scenario('go-far', async () => {
  await home();
  const p = await empty(0.3, 0.3);
  await pinched(p.x, p.y, Array(9).fill(10));
  const v0 = await view();
  const row = await ev(`(() => { const e = [...document.querySelectorAll('#sblist .tr')].find((x) => /design: workspaces/.test(x.textContent)); const b = e.getBoundingClientRect(); return { x: b.left + 50, y: b.top + b.height / 2 }; })()`);
  await press(row.x, row.y);
  await L.sleep(1000);
  const v1 = await view(), b = await box('w-design');
  ok(`far out (${v0.z}), clicking an agent in the sidebar keeps the zoom and brings the agent into view`, v0.z < 0.5 && v1.z === v0.z && v1.dz === v0.z && b && b.inView, { before: v0, after: v1, agent: b });
  await L.shot(c, path.join(SHOTS, 'z05-go-far.png'));
  await home();
  await pinched(p.x, p.y, [100 * -Math.log(0.8)]);
  const v2 = await view();
  await press(row.x, row.y);
  await L.sleep(1000);
  const v3 = await view();
  ok(`at ${v2.z} (still readable) the same click keeps the zoom and only moves to the agent`, v2.z < 1 && v3.z === v2.z, { before: v2, after: v3 });
});

scenario('held-pan', async () => {
  await pill(await ev(`__flow.state().ws.findIndex((w) => w.id === 'infra')`));
  await home();
  const d0 = await empty(0.85, 0.3);
  await L.drag(c, d0.x, d0.y, Array(10).fill(-30), { gapMs: 30, holdMs: 200 });
  await L.sleep(500);
  const p = await empty(0.6, 0.3);
  await L.mouse(c, 'mouseMoved', p.x, p.y);
  await L.mouse(c, 'mousePressed', p.x, p.y);
  for (let i = 1; i <= 4; i++) await L.mouse(c, 'mouseMoved', p.x - i * 5, p.y, { down: true });
  const g = { x: p.x - 20, y: p.y };
  await drain();
  const u0 = await under(g.x, g.y);
  await pinch(g.x, g.y, [10, 10, 10]);
  await drain();
  const z1 = (await view()).dz;
  await L.mouse(c, 'mouseMoved', g.x - 40, g.y, { down: true });
  await drain();
  const v2 = await view(), u2 = await under(g.x - 40, g.y);
  await L.mouse(c, 'mouseReleased', g.x - 40, g.y);
  await L.sleep(700);
  ok('a pinch while the desktop is held keeps its zoom when the drag goes on (it used to snap back)', z1 < 0.8 && v2.dz === z1 && (await view()).z === z1, { pinched: z1, afterMove: v2.dz, released: (await view()).z });
  ok('and the desktop point that was grabbed stays under the pointer', near(u2.x, u0.x, 2) && near(u2.y, u0.y, 2), { grabbed: u0, underPointerNow: u2, view: await view() });
  await home();
  await pill(0);
});

/* Where a screen point lies inside a window, in the window's own px (it scales with the zoom). */
const inWin = (id, x, y) => ev(`(() => { const b = document.querySelector('.win[data-id="${id}"]').getBoundingClientRect(), z = __flow.state().ws.find((w) => w.id === __flow.state().ui.at).zoom || 1;
  return { x: +((${x} - b.left) / z).toFixed(2), y: +((${y} - b.top) / z).toFixed(2), z }; })()`);
scenario('window-drag', async () => {
  await home();
  const V = await VP(), b0 = await box('w-week');
  const tb = { x: V.x + b0.x + b0.w / 2, y: V.y + b0.y + 12 };
  await L.mouse(c, 'mouseMoved', tb.x, tb.y);
  await L.mouse(c, 'mousePressed', tb.x, tb.y);
  for (let i = 1; i <= 4; i++) await L.mouse(c, 'mouseMoved', tb.x + i * 10, tb.y, { down: true });
  await drain();
  const g = { x: tb.x + 40, y: tb.y };
  const o0 = await inWin('w-week', g.x, g.y);
  await pinch(g.x, g.y, [10, 10, 10]);
  await drain();
  await L.mouse(c, 'mouseMoved', g.x + 60, g.y + 30, { down: true });
  await drain();
  const o1 = await inWin('w-week', g.x + 60, g.y + 30);
  await L.mouse(c, 'mouseReleased', g.x + 60, g.y + 30);
  await drain();
  ok('a pinch while a window is held by its title: the window stays under the pointer as the drag goes on', o1.z < 0.8 && near(o1.x, o0.x, 2) && near(o1.y, o0.y, 2), { before: o0, after: o1 });
  const rz = await ev(`(() => { const b = document.querySelector('.win[data-id="w-week"] .rz').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  const corner = () => ev(`(() => { const b = document.querySelector('.win[data-id="w-week"]').getBoundingClientRect(); return { x: b.right, y: b.bottom }; })()`);
  await L.mouse(c, 'mouseMoved', rz.x, rz.y);
  await L.mouse(c, 'mousePressed', rz.x, rz.y);
  for (let i = 1; i <= 3; i++) await L.mouse(c, 'mouseMoved', rz.x + i * 8, rz.y + i * 4, { down: true });
  await drain();
  const k = { x: rz.x + 24, y: rz.y + 12 }, k0 = await corner();
  const z0 = (await view()).z;
  await pinch(k.x, k.y, [-8, -8]);
  await drain();
  const z1 = (await view()).z, to = { x: k.x + 120, y: k.y + 60 };
  await L.mouse(c, 'mouseMoved', to.x, to.y, { down: true });
  await drain();
  const k1 = await corner();
  await L.mouse(c, 'mouseReleased', to.x, to.y);
  await drain();
  const off0 = { x: (k0.x - k.x) * (z1 / z0), y: (k0.y - k.y) * (z1 / z0) }, off1 = { x: k1.x - to.x, y: k1.y - to.y };
  ok('and while it is resized by its corner, the corner stays with the pointer', Math.abs(z1 - z0) > 0.1 && near(off1.x, off0.x, 4) && near(off1.y, off0.y, 4), { zoom: [z0, z1], cornerFromPointer: { before: off0, after: off1 } });
  await home();
});

/* Far out, each window's own title bar drawn at its 100% size (nav scales it back up below 40%): its text, on-screen
   size and place against its window. on: some bar is drawn so. */
const titles = () => ev(`(() => { const c = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"] .canvas');
  const es = c ? [...c.querySelectorAll(':scope > .win > .tb')].filter((e) => /scale/.test(e.style.transform) && e.parentElement.style.display !== 'none') : [];
  if (!es.length) return { on: false, items: [] };
  return { on: true, items: es.map((e) => { const r = e.getBoundingClientRect(), w = e.parentElement.getBoundingClientRect(), t = e.querySelector('.title, .ned[data-key^="title:"]');
    return { id: e.parentElement.dataset.id, text: (t ? t.innerText : e.innerText).trim(), h: +r.height.toFixed(1), w: +r.width.toFixed(1), x: +r.left.toFixed(1), top: +(r.top - w.top).toFixed(1), dx: +(r.left - w.left).toFixed(1), winW: +w.width.toFixed(1), winH: +w.height.toFixed(1),
      inside: r.left >= w.left - 0.5 && r.right <= w.right + 0.5 && r.top >= w.top - 0.5 && r.bottom <= w.bottom + 0.5 }; }) }; })()`);
/* Each window's first row (a terminal's top row, a note's title line), the height its bar is drawn and what a click
   on the middle of the row's left part reaches, as flows' farbar case reads them. */
const firstRows = (ids) => ev(`${JSON.stringify(ids)}.map((id) => { const w = document.querySelector('.win[data-id="' + id + '"]'), tb = w && w.querySelector(':scope > .tb');
  const first = w && (w.querySelector('.xterm-rows > div') || w.querySelector('[contenteditable] > *, [contenteditable]')); if (!first) return { id, missing: true };
  const fb = first.getBoundingClientRect(), hit = document.elementFromPoint(fb.left + Math.min(20, fb.width / 2), fb.top + fb.height / 2);
  return { id, tb: +tb.getBoundingClientRect().height.toFixed(1), row: [+fb.left.toFixed(1), +fb.top.toFixed(1), +fb.width.toFixed(1), +fb.height.toFixed(1)], text: first.textContent.trim().slice(0, 30),
    hit: hit ? hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.split(' ')[0] : '') : null, hitsRow: !!hit && first.contains(hit) }; })`);
const titleOf = (id) => ev(`(() => { const w = document.querySelector('.win[data-id="' + ${JSON.stringify(id)} + '"]'), e = w && w.querySelector(':scope > .tb .title, :scope > .tb .ned[data-key^="title:"]'); return e ? e.innerText.trim() : null; })()`);
scenario('titles', async () => {
  await home();
  const p = await empty(0.5, 0.45);
  await pinched(p.x, p.y, Array(12).fill(6));
  const t1 = await titles(), z1 = (await view()).z;
  ok(`at ${z1} (not yet below 40%) every title bar is drawn at its window's scale`, z1 >= 0.4 && !t1.on, t1);
  await pinched(p.x, p.y, Array(5).fill(6));
  const t2 = await titles(), z2 = (await view()).z, here = (await windowsHere()).sort();
  const names = await ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at); return Object.fromEntries(ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).map((w) => [w.id, document.querySelector('.win[data-id="' + w.id + '"] .tb .title') ? document.querySelector('.win[data-id="' + w.id + '"] .tb .title').textContent : ''])); })()`);
  ok(`below 40% (${z2}) each window in the space draws its own title bar at its 100% size, over its top edge, and no copy of it`, t2.on && t2.items.map((i) => i.id).sort().join() === here.join() && (await ev(`document.querySelectorAll('.ztitle').length`)) === 0, { titles: t2.items.map((i) => [i.id, i.text]), windows: here });
  ok('each 30 px tall (the window\'s height if less), inside its window and as wide as it', t2.items.every((i) => near(i.h, Math.min(30, i.winH), 0.8) && near(i.top, 0, 1.5) && near(i.dx, 0, 1.5) && near(i.w, i.winW, 1.5) && i.inside), t2.items);
  ok('with the window\'s title on it (notes: their title)', t2.items.every((i) => !names[i.id] || i.text === names[i.id]) && t2.items.every((i) => i.text.length > 0), { titles: t2.items.map((i) => [i.id, i.text]), bars: names });
  await L.shot(c, path.join(SHOTS, 'z07-titles.png'));
  const V = await VP(), wb = await box('w-week');
  const g = { x: V.x + wb.x + wb.w / 2, y: V.y + wb.y + 5 };
  const before = (await titles()).items.find((i) => i.id === 'w-week');
  await L.mouse(c, 'mouseMoved', g.x, g.y);
  await L.mouse(c, 'mousePressed', g.x, g.y);
  for (let i = 1; i <= 6; i++) await L.mouse(c, 'mouseMoved', g.x + i * 10, g.y + i * 5, { down: true });
  await drain();
  const mid = (await titles()).items.find((i) => i.id === 'w-week');
  await L.mouse(c, 'mouseReleased', g.x + 60, g.y + 30);
  await drain();
  ok('a window dragged while far out takes its title along as it moves', near(mid.top, 0, 1.5) && near(mid.dx, 0, 1.5) && Math.abs(mid.x - before.x) > 30, { before, duringTheDrag: mid });
  const nt = await ev(`(() => { const e = document.querySelector('.win[data-id="w-week"] > .tb .title'), ed = document.querySelector('.win[data-id="w-week"] .ned[data-key^="title:"]'), b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, text: ed.innerText.trim() }; })()`);
  await press(nt.x, nt.y);
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await c.send('Input.insertText', { text: ' far' });
  const changed = await L.waitFor(async () => (await titleOf('w-week')) === `${nt.text} far`, 8000, 'the note\'s new title on it').then(() => true, () => false);
  ok('far out, a click on a note\'s title in its bar types into it, and the bar shows the new title within a second or so', changed, { was: nt.text, now: await titleOf('w-week') });
  await pinched(p.x, p.y, [-30]);
  const t3 = await titles(), z3 = (await view()).z;
  ok(`back at ${z3} (40% or over) every title bar is at its window's scale again`, z3 >= 0.4 && !t3.on, { zoom: z3, titles: t3 });
  await home();
});

/* sept's finding on batch 3: drawn above its window, a far title covered the last rows of the window right above it
   (w-zc's over w-za's input line). In the stack workspace (addStack) every title, and every row of another window it
   covers, if any. */
const stackGeo = () => ev(`(() => { const c = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"] .canvas');
  const R = (b) => ({ x: b.left, y: b.top, w: b.width, h: b.height }), cut = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const wins = [...c.querySelectorAll(':scope > .win')].filter((e) => e.style.display !== 'none').map((e) => ({ id: e.dataset.id, r: R(e.getBoundingClientRect()), t: e.querySelector(':scope > .tb') }));
  const ts = wins.filter((w) => w.t && /scale/.test(w.t.style.transform)).map((w) => ({ id: w.id, r: R(w.t.getBoundingClientRect()), win: w.r }));
  const over = [];
  ts.forEach((t) => wins.forEach((o) => { if (o.id === t.id || !cut(t.r, o.r)) return;
    const s = document.querySelector('.win[data-id="' + o.id + '"] .xterm-screen'), n = __flow.term(o.id) ? __flow.term(o.id).rows : 0, b = s && s.getBoundingClientRect();
    const rows = b && n ? [...Array(n).keys()].filter((i) => Math.min(b.top + ((i + 1) * b.height) / n, t.r.y + t.r.h) - Math.max(b.top + (i * b.height) / n, t.r.y) > 0.5 && Math.min(b.right, t.r.x + t.r.w) > Math.max(b.left, t.r.x)).length : 0;
    over.push(t.id + "'s title over " + o.id + ': ' + cut(t.r, o.r).toFixed(0) + ' px², its last ' + rows + ' of ' + n + ' rows'); }));
  const a = wins.find((w) => w.id === 'w-za'), u = wins.find((w) => w.id === 'w-zc');
  return { titles: ts.map((t) => ({ id: t.id, h: +t.r.h.toFixed(1), top: +(t.r.y - t.win.y).toFixed(1), winH: +t.win.h.toFixed(1), inside: t.r.x >= t.win.x - 0.5 && t.r.x + t.r.w <= t.win.x + t.win.w + 0.5 && t.r.y >= t.win.y - 0.5 && t.r.y + t.r.h <= t.win.y + t.win.h + 0.5 })),
    over, gap: a && u ? +(u.r.y - a.r.y - a.r.h).toFixed(1) : null }; })()`);
/* Pinches on the desktop until the space on screen is drawn at z (within 0.005), each pinch ended before the next. */
async function zoomTo(z) {
  for (let i = 0; i < 10; i++) {
    const v = await view();
    if (Math.abs(v.dz - z) < 0.005) return v.dz;
    const p = await empty(0.5, 0.5), dy = -100 * Math.log(z / v.dz), n = Math.max(1, Math.ceil(Math.abs(dy) / 30));
    await pinched(p.x, p.y, Array(n).fill(dy / n));
  }
  return (await view()).dz;
}
scenario('titles-stacked', async () => {
  const from = (await view()).ws, ids = await ev('__flow.state().ws.map((w) => w.id)');
  await pill(ids.indexOf('zoom-stack'));
  await L.waitFor(async () => (await view()).ws === 'zoom-stack', 8000, 'the stack workspace on screen');
  await drain();
  await home();
  const V = await VP(), a = await box('w-za');
  await press(V.x + a.x + a.w / 2, V.y + a.y + a.h / 2);
  await c.send('Input.insertText', { text: 'seq 1 1000' });
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const full = await L.waitFor(() => /^1000\s*$/m.test(L.tmux('capture-pane', '-p', '-t', 'flow_w-za')), 10000, 'seq in w-za').then(() => true, () => false);
  ok('w-za is full of text to its last row, as a terminal running Claude Code is (typed: seq 1 1000)', full);
  for (const z of [0.39, 0.3, 0.15, 0.11]) {
    const got = await zoomTo(z), g = await stackGeo(), pct = Math.round(z * 100);
    ok(`at ${pct}% (drawn at ${got}) w-za, w-zb and w-zc each draw their own title bar at its 100% size over their top edge`, Math.abs(got - z) < 0.005 && ['w-za', 'w-zb', 'w-zc'].every((id) => g.titles.some((t) => t.id === id && t.inside && near(t.top, 0, 1.5) && near(t.h, Math.min(30, t.winH), 0.8))), g.titles);
    ok(`at ${pct}% no title bar covers another window (w-zc's included, ${g.gap} px under w-za)`, g.titles.length >= 3 && g.over.length === 0, g.over.length ? g.over : `${g.titles.length} titles, none over another window`);
    await L.shot(c, path.join(SHOTS, `z08-stack-${pct}.png`));
  }
  await home();
  await pill(ids.indexOf(from));
  await L.waitFor(async () => (await view()).ws === from, 8000, 'back on the workspace the other scenarios use');
  await drain();
});

/* One pinch whose last events come late, after its settling already ran (they waited behind a slow frame; by their
   own event times they are still part of it): it ends where the same pinch ends unbroken. */
scenario('late', async () => {
  await home();
  const p = await empty(0.5, 0.5);
  await pinched(p.x, p.y, Array(7).fill(5));
  const whole = (await view()).z;
  await home();
  const t0 = Date.now(), at = (i) => ({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 5, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * 16) / 1000 });
  await c.send('Input.dispatchMouseEvent', at(0));
  await L.sleep(1500);
  const between = (await view()).z;
  for (let i = 1; i < 7; i++) await c.send('Input.dispatchMouseEvent', at(i));
  await drain();
  const split = (await view()).z;
  ok('a pinch whose last six events arrive after its end ran ends where the same pinch ends unbroken, nothing moving the zoom in between', whole < 0.8 && near(between, Math.exp(-0.05), 0.002) && near(split, whole, 0.002), { whole, inBetween: between, split });
  await home();
});

/* A pinch over a page that does not use pinch itself zooms the space around the fingers, as one pinch by the page's
   own event times. */
scenario('page-pinch', async () => {
  await home();
  const w = await ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect();
    const e = [...document.querySelectorAll('.ws[data-id="' + __flow.state().ui.at + '"] .canvas > .win webview')].map((x) => x.getBoundingClientRect())
      .find((b) => b.width > 80 && b.height > 80 && b.left > v.left && b.right < v.right && b.top > v.top && b.bottom < v.bottom);
    return e ? { x: Math.round(e.left + e.width / 2), y: Math.round(e.top + e.height / 2) } : null; })()`);
  if (!w) { ok('a page window in view at actual size to pinch over', false, null); return; }
  const u0 = await under(w.x, w.y);
  await pinched(w.x, w.y, Array(6).fill(5));
  const v = await view(), u1 = await under(w.x, w.y);
  ok('a pinch over a page that does not use pinch zooms the space around the fingers, as one pinch', near(v.z, Math.exp(-0.3), 0.003) && near(u1.x, u0.x, 3) && near(u1.y, u0.y, 3), { zoom: v.z, want: +Math.exp(-0.3).toFixed(4), at: w, before: u0, after: u1 });
  await home();
});

scenario('swipe-guard', async () => {
  await home();
  const p = await empty(0.5, 0.4);
  const t0 = Date.now();
  await Promise.all([
    ...Array(14).fill(4).map((d, i) => L.sleep(i * 16).then(() => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: d, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * 16) / 1000 }))),
    ...SW.map((dx, i) => L.sleep(40 + i * 16).then(() => L.wheel(c, p.x, p.y, dx, 0, t0 + 40 + i * 16))),
  ]);
  await drain();
  const v = await view();
  ok('a sideways two-finger movement during a pinch never moves to another sub-workspace', v.sp === null && v.z < 0.8, v);
  await swipe(SW, p.x, p.y);
  ok('after the pinch, a two-finger swipe moves to the next sub-workspace as usual', (await view()).sp === 'z-research', await view());
  ok('which is at its own zoom, 100%', (await view()).z === 1, await view());
  await swipe(BACK, p.x, p.y);
  const back = await view();
  ok('and back in the main space the zoom is as it was left', back.sp === null && near(back.z, v.z, 0.0001), { left: v, back });
});

/* In infra, wider than the view, so the glide moves the view inside the space (in flow's main space, one view wide at
   100%, it is only a pull past the side): it is still going when the pinch comes. */
scenario('glide', async () => {
  await pill(await ev(`__flow.state().ws.findIndex((w) => w.id === 'infra')`));
  await home();
  const p = await empty(0.85, 0.3);
  const end = await L.drag(c, p.x, p.y, [-8, -10, -12, -14, -16, -16], { gapMs: 12 });
  await L.sleep(60);
  const g0 = await view();
  await L.sleep(50);
  const moving = await view();
  await pinch(end, p.y, [6, 6, 6, 6]);
  await L.sleep(120);
  const a = await view();
  await L.sleep(500);
  const b = await view();
  ok('a pinch during a glide stops the glide; the zoom happens around the fingers and nothing drifts after', moving.x > g0.x + 1 && a.z < 1 && Math.abs(b.x - a.x) < 1 && Math.abs(b.y - a.y) < 1, { gliding: [g0, moving], atPinch: a, later: b });
  await home();
  await pill(0);
});

/* No edges: the desktop drag takes the view past every window, in any direction, and it stays there; the glow on the
   side the windows are on points the way back (owner, Nov 2 14:08: "drag within workspaces is so clipped"). */
scenario('board', async () => {
  await home();
  const V = await VP();
  for (let k = 0; k < 3; k++) {
    const p = await empty(0.9, 0.5);
    await L.drag(c, p.x, p.y, Array(10).fill(-V.w / 20), { gapMs: 30, holdMs: 250 });
    await L.sleep(400);
  }
  const q = await empty(0.5, 0.9);
  await L.drag(c, q.x, q.y, Array(10).fill(0), { gapMs: 30, holdMs: 250, dy: -V.h / 2 });
  await L.sleep(1000);
  const v = await view(), g = await glows();
  ok('dragged past the windows, the view goes where the hand takes it, right and down, and stays there, with the glow on the side the windows are on', v.x > V.w * 1.3 && v.y > V.h * 0.3 && g[0] === true && g[1] === false, { view: v, glowsLeftRight: g });
  await home();
});

scenario('restart', async () => {
  await home();
  const p = await empty(0.4, 0.4);
  await pinched(p.x, p.y, Array(11).fill(9));
  const v0 = await view(), s0 = await extent();
  earlier.push(...c.errors);
  c.close();
  await L.stop({ keepTmux: true });
  L.launch({ log: path.join(L.USER_DATA, 'main.log') });
  c = await L.flowWindow();
  await ev(RECORD);
  await L.sleep(1500);
  const v1 = await view(), s1 = await extent();
  ok('after a quit Flow comes back at the same zoom and place, drawn the same', v1.z === v0.z && near(v1.x, v0.x, 0.5) && near(v1.y, v0.y, 0.5) && near(s1.x, s0.x, 1) && near(s1.w, s0.w, 1), { before: [v0, s0], after: [v1, s1] });
  const t = await titles();
  ok(`and, far out (${v1.z}), with each window's title on it`, v1.z < 0.4 && t.on && t.items.length === (await windowsHere()).length, { zoom: v1.z, titles: t.items.map((i) => [i.id, i.text]) });
});

/* A new app on the seed: what the scenarios before changed is gone. */
async function fresh() {
  earlier.push(...c.errors);
  c.close();
  await L.stop();
  await L.writeSeed();
  addStack();
  L.launch({ log: path.join(L.USER_DATA, 'main.log') });
  c = await L.flowWindow();
  await ev(RECORD);
  await L.sleep(1500);
}

/* Far out, a window made where no open area holds it (the strip above w-mck, between it and the space's top) keeps its
   size there and what is in its way makes way (nav's makeWay): it opens at 100%, all of it in view, over nothing.
   Last before the error check: the windows that made way stay where they went. */
/* every pair of windows in the space on screen that overlap (ids in order, area in %²) */
const overlaps = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), ins = ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const cut = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)), out = [];
  ins.forEach((a, i) => ins.slice(i + 1).forEach((b) => { const c = cut(a, b); if (c > 0.05) out.push([a.id, b.id, +c.toFixed(2)]); })); return out; })()`);
scenario('new-far-strip', async () => {
  await home();
  const p = await empty(0.3, 0.3);
  await pinched(p.x, p.y, Array(10).fill(10));
  const v0 = await view(), before = await windowsHere(), m = await box('w-mck'), before0 = await overlaps();
  const at = m && await ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), x = v.left + ${m.x} + ${m.w} / 2;
    for (let y = v.top + ${m.y} - 2; y > v.top + ${m.y} - 30; y -= 2) { const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) return { x: Math.round(x), y: Math.round(y) }; }
    return null; })()`);
  if (!at) { ok('far out, a point of bare desktop right above w-mck', false, { mck: m }); await home(); return; }
  await rightClick(at.x, at.y);
  await L.sleep(500);
  await menuItem('/^new note/');
  await L.sleep(1500);
  const id = (await windowsHere()).find((x) => !before.includes(x));
  const v1 = await view(), b = id && (await box(id));
  const after = await overlaps(), fresh = after.filter((o) => !before0.some((q) => q[0] === o[0] && q[1] === o[1]));
  ok(`far out (${v0.z}), "new note" right above w-mck opens the note there at the same zoom, all of it in view, over no window, and what made way lands on none`, v0.z < 0.5 && !!id && v1.z === v0.z && b && b.inView && fresh.length === 0, { note: id, box: b, view: v1, newOverlaps: fresh, overlapsBefore: before0, at });
  if (id) { const l = await ev(`(() => { const b = document.querySelector('.win[data-id="${id}"] .lights i:nth-child(1)').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); await press(l.x, l.y); await L.sleep(500); }
  await home();
});

/* After new-far-strip, last before the error check: a note made far out on this small space makes the windows it would
   cover move out of its way (makeWay), and they stay there. */
scenario('new-far', async () => {
  await home();
  const p = await empty(0.3, 0.3);
  await pinched(p.x, p.y, Array(10).fill(10));
  const v0 = await view();
  const before = await windowsHere();
  const at = await empty(0.75, 0.6, true);
  const hit = await ev(`document.elementFromPoint(${at.x}, ${at.y}).className`);
  await rightClick(at.x, at.y);
  await L.sleep(500);
  await menuItem('/^new note/');
  await L.sleep(1200);
  const id = (await windowsHere()).find((x) => !before.includes(x));
  const v1 = await view(), b = id && (await box(id));
  ok(`far out (${v0.z}), "new note" in the space (${hit}) opens the note there at the same zoom, all of it in view`, v0.z < 0.5 && !!id && v1.z === v0.z && b && b.inView, { note: id, box: b, view: v1 });
  await c.send('Input.insertText', { text: 'made far out' });
  await L.sleep(400);
  const typed = await ev(`(() => { const a = document.activeElement, w = a && a.closest('.win'); return w ? [w.dataset.id, a.innerText.trim()] : null; })()`);
  ok('typing goes straight into it', !!typed && typed[0] === id && /made far out/.test(typed[1]), typed);
  await L.shot(c, path.join(SHOTS, 'z06-new-far.png'));
  const lights = await ev(`(() => { const b = document.querySelector('.win[data-id="${id}"] .lights i:nth-child(1)').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await press(lights.x, lights.y);
  await L.sleep(500);
});

/* The dock's note button carried to a point (screen px) and let go, far out: the outline shown just before the release
   (the dashed box that follows the hand), the note it made and the view after (lead, Nov 2 19:2x: the outline is the box
   the note lands in; in a gap between two windows room is made and the hand may stay in the gap). */
async function carryNote(to) {
  const V = await VP(), before = await windowsHere(), before0 = await overlaps();
  await L.mouse(c, 'mouseMoved', V.x + V.w / 2, V.y + V.h - 6);
  await L.sleep(600);
  const nb = await ev(`(() => { const e = document.querySelector('#dock button[data-k="note"]'); if (!e) return null; const b = e.getBoundingClientRect(); return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`);
  if (!nb) return { error: 'no note button on the dock' };
  await L.mouse(c, 'mouseMoved', nb.x, nb.y);
  await L.mouse(c, 'mousePressed', nb.x, nb.y);
  for (let i = 1; i <= 12; i++) await L.mouse(c, 'mouseMoved', nb.x + ((to.x - nb.x) * i) / 12, nb.y + ((to.y - nb.y) * i) / 12, { down: true });
  await L.sleep(300);
  const outline = await ev(`(() => { const v = document.getElementById('viewport'), g = [...v.children].find((e) => (e.style.borderStyle === 'dashed' || /dashed/.test(e.style.border)) && e.style.display !== 'none'); if (!g) return null; const r = g.getBoundingClientRect(), b = v.getBoundingClientRect(); return { x: +(r.left - b.left).toFixed(1), y: +(r.top - b.top).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })()`);
  await L.mouse(c, 'mouseReleased', to.x, to.y);
  await L.sleep(1500);
  const id = (await windowsHere()).find((x) => !before.includes(x));
  const b = id && (await box(id)), fresh = (await overlaps()).filter((o) => !before0.some((q) => q[0] === o[0] && q[1] === o[1]));
  return { id, box: b, outline, view: await view(), newOverlaps: fresh, hand: { x: +(to.x - V.x).toFixed(1), y: +(to.y - V.y).toFixed(1) } };
}
/* lands on its outline (1 px), covers nothing, in view, the zoom kept, the hand in it or within the usual gap of its edge */
async function dropOk(r, z) {
  const V = await VP(), b = r.box, o = r.outline, gx = (1.2 / 100) * V.w * z + 1, gy = (1.8 / 100) * V.h * z + 1;
  const onOutline = !!b && !!o && ['x', 'y', 'w', 'h'].every((k) => near(b[k], o[k], 1));
  const byHand = !!b && r.hand.x >= b.x - gx && r.hand.x <= b.x + b.w + gx && r.hand.y >= b.y - gy && r.hand.y <= b.y + b.h + gy;
  return !!r.id && onOutline && byHand && b.inView && r.newOverlaps.length === 0 && r.view.z === z;
}
async function closeNote(id) {
  if (!id) return;
  const l = await ev(`(() => { const b = document.querySelector('.win[data-id="${id}"] .lights i:nth-child(1)').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await press(l.x, l.y);
  await L.sleep(500);
}

/* Far out, the dock's note button carried onto bare desktop and let go (lead, Nov 2 18:4x: "right-click and drop when
   zoomed out"). */
scenario('drop-far', async () => {
  await home();
  const p = await empty(0.3, 0.3);
  await pinched(p.x, p.y, Array(10).fill(10));
  const z = (await view()).z, to = await empty(0.6, 0.45, true);
  if (!to) { ok('far out, bare desktop to drop the dock\'s note on', false, null); await home(); return; }
  const r = await carryNote(to);
  ok(`far out (${z}), the dock's note button let go on bare desktop: the note lands on the outline shown, by the hand, at the same zoom, all of it in view, over no window`, z < 0.5 && !r.error && (await dropOk(r, z)), r);
  await closeNote(r.id);
  await home();
});

/* The same, let go halfway into the gap just above a window: the gap between two windows makes room, the hand may stay
   in the gap (layout and lead, Nov 2 19:2x). */
scenario('drop-gap', async () => {
  await home();
  const p = await empty(0.3, 0.3);
  await pinched(p.x, p.y, Array(10).fill(10));
  const z = (await view()).z;
  const to = await ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), v = document.getElementById('viewport').getBoundingClientRect(), bar = document.querySelector('.menubar').getBoundingClientRect().bottom, gap = (1.8 / 100) * v.height * ${z};
    for (const w of ws.windows.filter((w) => (w.zone || null) === (ws.at || null))) { const e = document.querySelector('.win[data-id="' + w.id + '"]'); if (!e || e.style.display === 'none') continue;
      const b = e.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top - gap / 2; if (y < bar + 40 || x < v.left + 20 || x > v.right - 20) continue;
      return { x: Math.round(x), y: Math.round(y * 10) / 10, above: w.id }; } return null; })()`);
  if (!to) { ok('far out, a window in view with room above it', false, null); await home(); return; }
  const r = await carryNote(to);
  ok(`far out (${z}), the dock's note button let go in the gap just above ${to.above}: the note lands on the outline shown, by the hand, at the same zoom, all of it in view, over no window`, z < 0.5 && !r.error && (await dropOk(r, z)), { ...r, above: to.above });
  await closeNote(r.id);
  await home();
});

/* Far out (15%), a window is handled with the same hands as at 100% (lead, Nov 2 14:1x): moved by its title bar,
   resized by its corner, closed by its red light, filed into another workspace by a drop on that workspace's pill.
   Last before the error check: it closes w-design and files w-week into infra. */
scenario('far-hands', async () => {
  for (const fz of [0.3, 0.15]) {
    await fresh();   // the seeded windows, whatever the scenarios before moved
    await home();
    const z = await zoomTo(fz), V = await VP();
    const geo = (id) => ev(`(() => { for (const ws of __flow.state().ws) for (const k of ['windows', 'closed']) { const w = (ws[k] || []).find((x) => x.id === ${JSON.stringify(id)}); if (w) return { ws: ws.id, list: k, x: +(+w.x).toFixed(2), y: +(+w.y).toFixed(2), w: +(+w.w).toFixed(2), h: +(+w.h).toFixed(2) }; } return null; })()`);
    const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
    const pct = (px, d) => (px / z / d) * 100;
    let b = await rect('.win[data-id="w-design"] > .tb');
    const g0 = await geo('w-design');
    await L.drag(c, b.x + Math.min(b.w - 8, 70), b.y + b.h / 2, Array(8).fill(10), { gapMs: 30, holdMs: 250, dy: 40 });
    await L.sleep(800);
    const g1 = await geo('w-design');
    ok(`at ${z} a window moves by its title bar (drawn ${Math.round(b.h)} px tall), and the zoom stays`, Math.abs(z - fz) < 0.005 && near(g1.x - g0.x, pct(80, V.w), 1) && near(g1.y - g0.y, pct(40, V.h), 1) && (await view()).z === z, { bar: b, before: g0, after: g1, want: { dx: +pct(80, V.w).toFixed(2), dy: +pct(40, V.h).toFixed(2) } });
    const rz = await rect('.win[data-id="w-design"] > .rz[data-rz=se]');
    await L.drag(c, rz.x + rz.w / 2, rz.y + rz.h / 2, Array(8).fill(5), { gapMs: 30, holdMs: 250, dy: 30 });
    await L.sleep(800);
    const g2 = await geo('w-design');
    ok(`at ${z} it resizes by its corner (drawn ${Math.round(rz.w)} px, the grips' 12 px at any zoom)`, rz.w >= 11.5 && rz.w <= 14 && near(g2.w - g1.w, pct(40, V.w), 1) && near(g2.h - g1.h, pct(30, V.h), 1), { corner: rz, before: g1, after: g2 });
    const red = await rect('.win[data-id="w-design"] > .tb .lights i:nth-child(1)');
    await press(red.x + red.w / 2, red.y + red.h / 2);
    await L.sleep(1000);
    const g3 = await geo('w-design');
    ok(`at ${z} its red light (drawn ${Math.round(red.w)} px) closes it`, red.w >= 10 && !!g3 && g3.list === 'closed', { light: red, now: g3 });
    const ii = await ev(`__flow.state().ws.findIndex((w) => w.id === 'infra')`), pr = await rect(`.sp[data-i="${ii}"]`);
    b = await rect('.win[data-id="w-week"] > .tb');
    const from = { x: b.x + Math.min(b.w - 8, 70), y: b.y + b.h / 2 }, to = { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 };
    await L.drag(c, from.x, from.y, Array(12).fill((to.x - from.x) / 12), { gapMs: 40, holdMs: 400, dy: to.y - from.y });
    await L.sleep(1200);
    const g4 = await geo('w-week');
    ok(`at ${z} a window dropped by its title bar on another workspace's pill is filed there`, !!g4 && g4.ws === 'infra', { now: g4, pill: pr });
    await L.shot(c, path.join(SHOTS, `z09-far-hands-${Math.round(fz * 100)}.png`));
  }
});

scenario('errors', async () => {
  ok('no console errors or exceptions in the Flow window', [...earlier, ...c.errors].length === 0, [...earlier, ...c.errors]);
});

/* sept's arrangement from batch 3, for 'titles-stacked': w-za with w-zc under it at the gap windows keep under each
   other (1.8% of the view), w-zb beside them, w-zd eight views to the right so the space zooms out past 11%. Shells. */
function addStack() {
  const dir = path.join(L.WORK, 'zoom-stack'), t = (id, title, x, y, w, h) => ({ id, type: 'term', title, cmd: 'shell', cwd: dir, x, y, w, h });
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['flow-state.json', 'seed.json']) {
    const f = path.join(L.USER_DATA, n), doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.ws.push({ id: 'zoom-stack', name: 'stack', folder: dir, bg: '#141319', zones: [], notes: [], closed: [], windows: [
      t('w-za', 'zoom a', 1.2, 6.6, 48, 55), t('w-zb', 'zoom b, a longer title to see where it goes', 50, 6.6, 48, 55),
      t('w-zc', 'zoom c, under a', 1.2, 6.6 + 55 + 1.8, 48, 30), t('w-zd', 'zoom d, eight views right', 800, 6.6, 40, 40)] });
    fs.writeFileSync(f, JSON.stringify(doc));
  }
}

/* ---------- run ---------- */
const unknown = (ONLY || []).filter((n) => !SCEN.some((s) => s.name === n));
if (unknown.length) { console.log(`FAIL --only names no scenario: ${unknown.join(', ')} (there are ${SCEN.map((s) => s.name).join(', ')})`); process.exit(1); }
fs.mkdirSync(SHOTS, { recursive: true });
const t0 = Date.now();
await L.writeSeed();
addStack();
L.launch({ log: path.join(L.USER_DATA, 'main.log') });
try {
  c = await L.flowWindow();
  await ev(RECORD);
  for (const s of SCEN) {
    if (ONLY && !ONLY.includes(s.name) && s.name !== 'errors') continue;
    console.log(`-- ${s.name}`);
    try { await s.fn(); } catch (e) { ok(`${s.name} ran to its end`, false, e.message); }
  }
} finally {
  if (!KEEP) await L.stop();
}
console.log(`\n${oks} ok, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(fails ? 1 : 0);




