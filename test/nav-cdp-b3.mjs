// nav's check of moving around and laying out in the real app, with real input over CDP (Input.dispatchMouseEvent,
// ctrl-wheel for pinches, BrowserWindow 'swipe' emitted in main for three fingers). Sub-workspaces are separate spaces
// (app.js: w.zone, ws.at), each with its own pan and zoom (nav.js). Runs nav's own isolated app (test/nav-lib.mjs) on
// the safe seed. --entry runs another page through FLOW_ENTRY, such as a copy of index.html loading an older nav.js
// (it must be test/nav-app.html, the name flowWindow looks for).
//   node test/nav-cdp.mjs [--entry test/nav-app.html] [--keep] [--only a,b]
// Screenshots go to test/nav-shots/.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './nav-lib.mjs';

const args = process.argv.slice(2);
const ENTRY = args.includes('--entry') ? args[args.indexOf('--entry') + 1] : null;
const KEEP = args.includes('--keep');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const SHOTS = process.env.NAV_SHOTS || path.join(L.ROOT, 'test', 'nav-shots');
const PAGES_PORT = 9768;
const SW = [8, 18, 30, 42, 46, 40, 34, 28, 22, 18, 14, 11, 9, 7, 5, 4, 3, 2, 2, 1];
const BACK = SW.map((d) => -d);

let fails = 0, oks = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const tmux = (...a) => execFileSync('tmux', ['-L', L.SOCKET, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
const hasSession = (id) => spawnSync('tmux', ['-L', L.SOCKET, 'has-session', '-t', `flow_${id}`], { stdio: 'ignore', timeout: 10000 }).status === 0;

let c, m, V, Y, TERM_SIZE = '';
const ev = (x) => c.eval(x);
const at = () => ev('__flow.state().ui.at');
const wsIndex = (id) => ev(`__flow.state().ws.findIndex((w) => w.id === ${JSON.stringify(id)})`);
const space = (i = 0) => ev(`__flow.state().ws[${i}].at || null`);
/* A space's view: the one on screen from ws.pan/panY/zoom, one off screen from its zone or ws.main*. */
const view = (i = 0, zid) => ev(`(() => { const ws = __flow.state().ws[${i}], sid = ${zid === undefined ? 'undefined' : JSON.stringify(zid)};
  const on = sid === undefined || (sid || null) === (ws.at || null), zn = sid ? ws.zones.find((z) => z.id === sid) : null;
  const v = on ? { x: ws.pan, y: ws.panY, z: ws.zoom } : zn ? { x: zn.pan, y: zn.panY, z: zn.zoom } : { x: ws.mainPan, y: ws.mainPanY, z: ws.mainZoom };
  return { x: Math.round(v.x || 0), y: Math.round(v.y || 0), z: +(v.z || 1).toFixed(3) }; })()`);
/* The canvas point under a screen point in the space on screen, in px at zoom 1. */
const under = (x, y) => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), z = ws.zoom || 1; const b = document.getElementById('viewport').getBoundingClientRect(); return { x: (ws.pan || 0) + (${x} - b.left) / z, y: (ws.panY || 0) + (${y} - b.top) / z, z }; })()`);
/* A pinch as a trackpad sends it, events stamped 16 ms apart, then until the space has settled: changed (within 4 s; a
   pinch over a page goes through the page first) and then unchanged for 300 ms, view and drawing (on a loaded VM the
   events are handled long after they are sent). */
const viewNow = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), c = document.querySelector('.ws[data-id="' + ws.id + '"] > .canvas'); return JSON.stringify([ws.at || null, ws.pan, ws.panY, ws.zoom, c && getComputedStyle(c).transform]); })()`);
async function pinch(x, y, dys) {
  const t0 = Date.now(), was = await viewNow();
  for (let i = 0; i < dys.length; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dys[i], modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * 16) / 1000 });
  for (let k = 0; k < 20 && (await viewNow()) === was; k++) await L.sleep(200);
  let last = '';
  for (let k = 0; k < 20; k++) {
    await L.sleep(300);
    const now = await viewNow();
    if (now === last) return;
    last = now;
  }
}
const r = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const winState = (id) => ev(`(() => { for (const ws of __flow.state().ws) { const w = [...ws.windows, ...ws.closed].find((x) => x.id === ${JSON.stringify(id)}); if (w) return { ws: ws.id, zone: w.zone || null, x: +w.x.toFixed(2), y: +w.y.toFixed(2), w: +w.w.toFixed(2), h: +w.h.toFixed(2) }; } return null; })()`);
/* The windows whose frames are on screen in the viewport. */
const onScreen = () => ev(`[...document.querySelectorAll('.win')].filter((e) => { const b = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return b.width && b.right > v.left + 1 && b.left < v.right - 1 && b.bottom > v.top && b.top < v.bottom; }).map((e) => e.dataset.id).sort()`);
/* The canvas point under a screen point in the shown space, in px at zoom 1. */
const spot = (fx = 0.5) => ({ x: V.x + V.w * fx, y: Y });
const findY = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), mb = document.querySelector('.menubar').getBoundingClientRect();
  for (let y = Math.max(v.top, mb.bottom) + 2; y < v.top + 120; y += 1) if ([0.1, 0.3, 0.5, 0.8, 0.85, 0.95].every((f) => { const e = document.elementFromPoint(v.left + v.width * f, y); return e && e.matches('.canvas, .ws'); })) return y;
  return null; })()`);
const termSize = () => tmux('display', '-p', '-t', 'flow_w-design', '#{window_width}x#{window_height}');
/* A point of empty desktop in the space on screen, scanning from the bottom right (for a right-click there). */
const emptyAt = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect();
  for (let y = v.bottom - 30; y > v.top + 60; y -= 12) for (let x = v.right - 30; x > v.left + 30; x -= 12) { const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) return { x, y }; }
  return null; })()`);
async function press(x, y) { await L.mouse(c, 'mouseMoved', x, y); await L.mouse(c, 'mousePressed', x, y); await L.mouse(c, 'mouseReleased', x, y); }
async function pill(i) { const p = await r(`.sp[data-i="${i}"]`); await press(p.cx, p.cy); await L.sleep(700); }
async function swipe(dxs, x = spot().x, y = spot().y) { await L.swipe(c, x, y, dxs); await L.sleep(750); }

/* Back to flow's main space at zoom 1 and pan 0, with real input only. */
async function home() {
  if ((await at()) !== 'flow') await pill(0);
  for (let i = 0; i < 4 && (await space(0)) !== null; i++) await swipe(BACK);
  const z = await ev('__flow.state().ws[0].zoom || 1');
  if (z !== 1) { await pinch(spot().x, spot().y, [100 * Math.log(z)]); await L.sleep(500); }
  for (let k = 0; k < 6 && ((await view(0)).x !== 0 || (await view(0)).y !== 0); k++) await L.drag(c, spot(0.2).x, spot().y, Array(10).fill(80), { gapMs: 16, holdMs: 120, dy: 0 });
  const h = await view(0);
  if ((await space(0)) !== null || h.x !== 0 || h.z !== 1) throw new Error(`could not get back to flow's main space at zoom 1 (${JSON.stringify(h)}, space ${await space(0)})`);
}

const SCEN = [];
const scenario = (name, fn) => SCEN.push({ name, fn });

scenario('spaces', async () => {
  const s = await ev(`(() => { const f = __flow.state().ws[0]; return { zones: f.zones.map((z) => z.id), wins: f.windows.map((w) => [w.id, w.zone || null]) }; })()`);
  const research = s.wins.filter(([, z]) => z === 'z-research').map(([id]) => id).sort();
  ok('flow has its research sub-workspace as a space of its own', research.join() === 'w-judge,w-kv,w-read', s);
  await home();
  await L.shot(c, path.join(SHOTS, '01-main.png'));
  await L.drag(c, spot(0.9).x, spot().y, Array(20).fill(-60), { gapMs: 16, holdMs: 120 });
  const seen = await onScreen();
  ok('dragging the main space 1200 px never shows a sub-workspace\'s windows', seen.length > 0 && !seen.some((id) => ['w-kv', 'w-judge', 'w-read'].includes(id)), seen);
  await swipe(SW);
  ok('a two-finger swipe left goes to the research space', (await space(0)) === 'z-research' && (await at()) === 'flow', await space(0));
  const seen2 = await onScreen();
  ok('it shows research\'s windows and none of the main space\'s', seen2.join() === 'w-judge,w-kv,w-read', seen2);
  await L.shot(c, path.join(SHOTS, '02-research.png'));
  await swipe(SW);
  ok('another swipe left at the last space bounces in place', (await space(0)) === 'z-research');
  await swipe(BACK);
  ok('a swipe right comes back to the main space', (await space(0)) === null);
  await swipe(BACK);
  ok('a swipe right at the main space bounces in place', (await space(0)) === null);
  const row = await r('.tr[data-act="zone|z-research"]');
  await press(row.cx, row.cy);
  await L.sleep(800);
  ok('a click on the sub-workspace in the sidebar goes to its space', (await space(0)) === 'z-research');
  await swipe(BACK);
});

scenario('one-step', async () => {
  await home();
  const t = Date.now();
  await L.wheel(c, spot().x, spot().y, 140, 0, t);
  await L.sleep(80);
  await L.wheel(c, spot().x, spot().y, 140, 0, t + 80);
  await L.sleep(750);
  ok('two events of one swipe, stamped 80 ms apart: one step', (await space(0)) === 'z-research', await space(0));
  await swipe(BACK);
  const busy = ev('(() => { const e = performance.now() + 600; while (performance.now() < e); return true; })()');
  await L.sleep(30);
  await L.swipe(c, spot().x, spot().y, SW);
  await busy;
  await L.sleep(750);
  ok('a whole swipe that arrives while the Flow window is blocked for 600 ms: one step', (await space(0)) === 'z-research', await space(0));
  await swipe(BACK);
  await L.swipe(c, spot().x, spot().y, [0, 0, 1, 2, 10, 30, 40, 40, 30, 20], { dys: [6, 10, 12, 10, 8, 4, 2, 1, 0, 0] });
  await L.sleep(750);
  ok('a scroll that starts up or down and drifts sideways does not move', (await space(0)) === null, await space(0));
});

scenario('content', async () => {
  await home();
  const t = await r('.win[data-id="w-design"] .xterm-screen');
  await ev(`window.__navXt = 0; document.querySelector('.win[data-id="w-design"] .xterm').addEventListener('wheel', () => { window.__navXt++; }, { passive: true }); true`);
  await L.swipe(c, t.cx, t.cy, Array(8).fill(0), { dys: [-10, -20, -30, -30, -20, -10, -5, -2] });
  await L.sleep(750);
  ok('a scroll up over a terminal reaches the terminal and moves nothing', (await ev('window.__navXt')) > 0 && (await space(0)) === null, { terminalGot: await ev('window.__navXt') });
  await L.swipe(c, t.cx, t.cy, Array(12).fill(0), { dys: Array(12).fill(40) });
  await L.waitFor(() => tmux('display', '-p', '-t', 'flow_w-design', '#{pane_in_mode}') === '0', 8000, 'tmux to leave its history (copy mode) after scrolling back down');
  await L.sleep(400);
  await ev('window.__navXt = 0; true');
  await swipe(SW, t.cx, t.cy);
  ok('a sideways swipe over a terminal moves to the next space and never reaches the terminal', (await space(0)) === 'z-research' && (await ev('window.__navXt')) === 0, { space: await space(0), terminalGot: await ev('window.__navXt') });
  await swipe(BACK);
  const n = await r('.win[data-id="w-week"] .nbody');
  await swipe(SW, n.cx, n.cy);
  ok('a sideways swipe over a note moves to the next space', (await space(0)) === 'z-research');
  await swipe(BACK);
  const ad = await r('.win[data-id="w-mck"] .addr .ad');
  const long = await ev(`(() => { const a = document.querySelector('.win[data-id="w-mck"] .addr .ad'); a.scrollLeft = 0; return a.scrollWidth > a.clientWidth + 1; })()`);
  await swipe(SW, ad.x + 40, ad.cy);
  const sl = await ev(`document.querySelector('.win[data-id="w-mck"] .addr .ad').scrollLeft`);
  ok('a sideways swipe over a page\'s long address scrolls the address and does not move', long && sl > 0 && (await space(0)) === null, { overflows: long, scrollLeft: sl, space: await space(0) });
  await ev(`document.querySelector('.win[data-id="w-mck"] .addr .ad').scrollLeft = 0; true`);
});

scenario('pages', async () => {
  await home();
  const id = await ev(`__flow.openPage('http://127.0.0.1:${PAGES_PORT}/wide.html')`);
  await L.waitFor(() => ev(`(() => { const p = __flow.page(${JSON.stringify(id)}); return !!p && !p.isLoading() && /sideways/.test(p.getTitle()); })()`), 20000, 'the test page');
  await L.sleep(500);
  const w = await winState(id);
  ok('a page opened while the main space is full lands in the main space, in view, and the view stays', w.zone === null && (await onScreen()).includes(id) && (await view(0)).x === 0, { w, view: await view(0) });
  const pg = await r(`.win[data-id="${id}"] .pgv`);
  const sc = await ev(`new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.win[data-id="${id}"] webview')).transform).a`);
  const guest = (js) => ev(`document.querySelector('.win[data-id="${id}"] webview').executeJavaScript(${JSON.stringify(js)})`);
  await swipe(SW, pg.x + 100, pg.y + (300 + 100) * sc);
  const sl = await guest('document.getElementById("wide").scrollLeft');
  ok('a sideways swipe over a scroller inside a page scrolls it and does not move', sl > 0 && (await space(0)) === null, { scrollLeft: sl, space: await space(0) });
  await L.swipe(c, pg.x + 60, pg.y + 30, [0, 0, 1, 2, 10, 30, 40, 40, 30, 20], { dys: [6, 10, 12, 10, 8, 4, 2, 1, 0, 0] });
  await L.sleep(750);
  ok('a scroll over a page that starts up or down and drifts sideways does not move', (await space(0)) === null, await space(0));
  await swipe(SW, pg.x + 60, pg.y + 30);
  ok('a sideways swipe over the plain part of the front page moves to the next space', (await space(0)) === 'z-research', await space(0));
  await L.shot(c, path.join(SHOTS, '03-page-swipe.png'));
  await swipe(BACK);
  const before = await under(pg.x + 60, pg.y + 30);
  await pinch(pg.x + 60, pg.y + 30, Array(6).fill(8));
  const after = await under(pg.x + 60, pg.y + 30);
  const pageScale = await guest('visualViewport.scale');
  ok('a pinch over a page zooms the space around the fingers, not the page', after.z < 0.7 && near(after.x, before.x, 3) && near(after.y, before.y, 3) && pageScale === 1, { before, after, pageScale });
  await L.shot(c, path.join(SHOTS, '04-page-pinch.png'));
  await pinch(pg.x + 60, pg.y + 30, Array(6).fill(-8));
  await L.sleep(400);
  const cl = await r(`.win[data-id="${id}"] [data-l="close"]`);
  await press(cl.cx, cl.cy);
  await L.sleep(400);
});

scenario('pinch', async () => {
  await home();
  const p = { x: V.x + V.w * 0.62, y: V.y + V.h * 0.55 };
  const b0 = await under(p.x, p.y);
  await pinch(p.x, p.y, Array(10).fill(7));
  const b1 = await under(p.x, p.y);
  ok('pinching in (ctrl-wheel) zooms out around the fingers: the point under them stays put', b1.z < 0.55 && near(b1.x, b0.x, 2) && near(b1.y, b0.y, 2), { before: b0, after: b1 });
  await L.shot(c, path.join(SHOTS, '05-zoom-0.5.png'));
  await pinch(p.x, p.y, Array(20).fill(-7));
  const b2 = await under(p.x, p.y);
  const b2z = b1.z * Math.exp(1.4) / 1.12;
  ok('pinching out zooms in around the same point, resting at 100% on the way (12% more pinch goes past it)', near(b2.z, b2z, 0.01) && near(b2.x, b0.x, 2) && near(b2.y, b0.y, 2), { after: b2, want: +b2z.toFixed(3) });
  await L.shot(c, path.join(SHOTS, '06-zoom-2.png'));
  await pinch(p.x, p.y, Array(30).fill(-20));
  ok('zoom stops at its largest', (await view(0, null)).z === 2.5, await view(0, null));
  await pinch(p.x, p.y, Array(60).fill(20));
  ok('and at its smallest', (await view(0, null)).z === 0.3, await view(0, null));
  await L.shot(c, path.join(SHOTS, '07-zoom-0.3.png'));
  const t = await r('.win[data-id="w-design"] .xterm-screen');
  await ev(`window.__navXt = 0; document.querySelector('.win[data-id="w-design"] .xterm').addEventListener('wheel', () => { window.__navXt++; }, { passive: true }); true`);
  await pinch(t.cx, t.cy, Array(10).fill(-10));
  ok('a pinch over a terminal zooms the space and never reaches the terminal', (await view(0, null)).z > 0.6 && (await ev('window.__navXt')) === 0, { z: (await view(0, null)).z, terminalGot: await ev('window.__navXt') });
  await L.sleep(800);
  ok('zooming never resizes a terminal (tmux size the same as at zoom 1)', termSize() === TERM_SIZE, { now: termSize(), atZoom1: TERM_SIZE });
});

const startFailed = () => ev(`/failed to start/.test(document.getElementById('toast').textContent)`);
/* A note from the dock (real input: the pointer at the bottom brings it up); returns the new window's id or null. */
async function dockNote() {
  const ids0 = await ev('__flow.windows().map((w) => w.id)');
  await L.mouse(c, 'mouseMoved', V.x + V.w / 2, V.y + V.h - 6);
  await L.waitFor(() => ev(`getComputedStyle(document.getElementById('dock')).visibility === 'visible' && +getComputedStyle(document.getElementById('dock')).opacity > 0.9`), 3000, 'the dock to come up');
  const dock = await r('#dock button[data-k="note"]');
  await L.mouse(c, 'mouseMoved', dock.cx, dock.cy);
  await L.sleep(150);
  await press(dock.cx, dock.cy);
  return L.waitFor(() => ev(`__flow.windows().map((w) => w.id).find((x) => !${JSON.stringify(ids0)}.includes(x)) || null`), 4000, 'a new window from the dock').then((v) => v, () => null);
}
/* The part of a workspace's space on screen, in the % of window positions. */
const shown = (i) => ev(`(() => { const ws = __flow.state().ws[${i}]; const b = document.getElementById('viewport').getBoundingClientRect(), z = ws.zoom || 1; return { x: (ws.pan || 0) / b.width * 100, y: (ws.panY || 0) / b.height * 100, w: 100 / z, h: 100 / z }; })()`);
const inView = (w, vr) => w.x >= vr.x - 0.01 && w.x + w.w <= vr.x + vr.w + 0.01 && w.y >= vr.y - 0.01 && w.y + w.h <= vr.y + vr.h + 0.01;
/* Inside the space itself: from its left side, below the menu bar's margin (6.6%) and above the bottom strip kept for the dock. */
const inSpaceArea = (w) => w.x >= 1.19 && w.y >= 6.59 && w.y + w.h <= 98.7;
/* Where the canvas of a workspace's space on screen is drawn this frame, in px at zoom 1. */
const drawnX = (i) => ev(`(() => { const id = __flow.state().ws[${i}].id, m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ws[data-id="' + id + '"] > .canvas')).transform); return 0 - m.m41 / m.a; })()`);
scenario('pinch-ends', async () => {
  const i = await wsIndex('infra');
  await pill(i);
  const max = await ev(`(() => { const vw = document.getElementById('viewport').getBoundingClientRect().width; const c = document.querySelector('.ws[data-id="infra"] > .canvas'); return Math.round(parseFloat(c.style.width) - vw); })()`);
  const last = await ev(`(() => { const ws = __flow.state().ws[${i}], vw = document.getElementById('viewport').getBoundingClientRect().width; return Math.round((Math.max(100, __flow.nav().contentEnd(ws) + 1.2) / 100) * vw - vw); })()`);
  const p = { x: V.x + V.w * 0.5, y: V.y + V.h * 0.5 };
  for (let k = 0; k < 6 && (await view(i)).x < max; k++) await L.drag(c, spot(0.9).x, spot().y, Array(20).fill(-70), { gapMs: 16, holdMs: 150 });
  await L.sleep(300);
  const e0 = await view(i), u0 = await under(p.x, p.y);
  await pinch(p.x, p.y, [40, 40, 40]);
  const u1 = await under(p.x, p.y), d1 = await drawnX(i);
  ok('at the far right end of a space, pinching out keeps the point under the fingers', e0.x === max && u1.z < 0.32 && near(u1.x, u0.x, 2) && near(u1.y, u0.y, 2) && near(d1, (await view(i)).x, 1), { end: max, pan: e0.x, before: u0, after: u1, drawn: Math.round(d1) });
  await L.shot(c, path.join(SHOTS, '07b-pinched-out-at-the-end.png'));
  await pinch(p.x, p.y, [-40, -40, -40]);
  await L.sleep(500);
  const e1 = await view(i);
  ok('and pinching back in returns to actual size at the same place', e1.z === 1 && near(e1.x, max, 1) && e1.y === 0, { now: e1, end: max });
  for (let k = 0; k < 6 && (await view(i)).x > 0; k++) await L.drag(c, spot(0.1).x, spot().y, Array(20).fill(70), { gapMs: 16, holdMs: 150 });
  await L.drag(c, spot(0.9).x, spot().y, Array(13).fill(-last / 13), { gapMs: 16, holdMs: 150 });
  await L.sleep(300);
  const w0 = await view(i), wu0 = await under(p.x, p.y);
  await pinch(p.x, p.y, [40, 40, 40]);
  const wu1 = await under(p.x, p.y);
  ok('where its last window ends, pinching out keeps the point under the fingers', near(w0.x, last, 1) && near(wu1.x, wu0.x, 2) && near(wu1.y, wu0.y, 2), { lastWindowEnds: last, pan: w0.x, before: wu0, after: wu1 });
  await pinch(p.x, p.y, [-40, -40, -40]);
  await L.sleep(500);
  for (let k = 0; k < 6 && (await view(i)).x > 0; k++) await L.drag(c, spot(0.1).x, spot().y, Array(20).fill(70), { gapMs: 16, holdMs: 150 });
  await L.sleep(300);
  const s0 = await view(i), l0 = await under(p.x, p.y);
  await pinch(p.x, p.y, [15, 15]);
  const l1 = await under(p.x, p.y), s1 = await view(i);
  ok('at the start of a space wider than the view, pinching out keeps the point under the fingers', s0.x === 0 && s1.x < 0 && near(l1.x, l0.x, 2) && near(l1.y, l0.y, 2), { before: l0, after: l1, view: s1 });
  const nid = await dockNote();
  const nw = nid && await winState(nid), nvr = await shown(i);
  ok('a new note there lands in view and inside the space, not in the desktop left of it or above it', !!nw && nw.zone === null && inView(nw, nvr) && inSpaceArea(nw) && JSON.stringify(await view(i)) === JSON.stringify(s1), { w: nw, view: nvr });
  if (nid) {
    const cl = await r(`.win[data-id="${nid}"] .lights i[data-l="close"]`);
    await press(cl.cx, cl.cy);
    await L.waitFor(() => ev(`!__flow.windows().some((w) => w.id === ${JSON.stringify(nid)})`), 4000, 'the new note to close');
    await L.sleep(300);
  }
  const g0 = await drawnX(i);
  await L.drag(c, spot(0.6).x, spot().y, Array(5).fill(-20), { gapMs: 16, holdMs: 150 });
  await L.sleep(300);
  const g1 = await drawnX(i);
  ok('a drag from there pans with the pointer (100 px), with no jump', near((g1 - g0) * s1.z, 100, 2), { drawnBefore: Math.round(g0), drawnAfter: Math.round(g1), zoom: s1.z });
  await pinch(V.x + V.w * 0.1, V.y + V.h * 0.2, [-15, -15]);
  await L.sleep(500);
  const s2 = await view(i), sd = await drawnX(i);
  ok('pinched back to actual size around another point, the space starts at the left side and fills the height again', s2.z === 1 && s2.x === 0 && s2.y === 0 && near(sd, 0, 1), { view: s2, drawn: Math.round(sd) });
  const bot = { x: p.x, y: V.y + V.h * 0.9 }, top = { x: p.x, y: V.y + V.h * 0.08 };
  await pinch(bot.x, bot.y, Array(10).fill(-7));
  const t0 = await under(top.x, top.y);
  await pinch(top.x, top.y, Array(4).fill(7));
  const t1 = await under(top.x, top.y), tv = await view(i);
  ok('zoomed in at the bottom, pinching out at the top keeps the point under the fingers too', near(t1.x, t0.x, 2) && near(t1.y, t0.y, 2), { before: t0, after: t1, view: tv });
  await pinch(p.x, p.y, [100 * Math.log(tv.z)]);
  await L.sleep(500);
  const tz = await view(i);
  ok('and back at actual size the space fills the height again', tz.z === 1 && tz.y === 0 && tz.x >= 0, tz);
  if (tz.x !== 0) await L.drag(c, spot(0.1).x, spot().y, Array(20).fill(70), { gapMs: 16, holdMs: 150 });
  await pill(0);
});

scenario('zoomed-input', async () => {
  await home();
  await pinch(spot().x, V.y + V.h * 0.5, Array(7).fill(7));
  const z = (await view(0, null)).z;
  const nb = await r('.win[data-id="w-week"] .nbody');
  await press(nb.x + nb.w * 0.5, nb.y + nb.h - 4);
  await c.send('Input.insertText', { text: ' zoomed' });
  await L.sleep(300);
  const body = await ev(`__flow.state().ws[0].notes.find((n) => n.id === 'n-week').body`);
  const focused = await ev(`(() => { const a = document.activeElement; const w = a && a.closest && a.closest('.win'); return w ? w.dataset.id : null; })()`);
  ok(`at zoom ${z} a click in a note and typing land in that note`, /zoomed$/.test(body) && focused === 'w-week', { end: body.slice(-30), focused });
  const before = await winState('w-mck');
  const tb = await r('.win[data-id="w-mck"] .tb');
  await L.drag(c, tb.x + 40, tb.cy, Array(5).fill(20), { gapMs: 16, holdMs: 80 });
  await L.sleep(300);
  const after = await winState('w-mck');
  const movedScreen = ((after.x - before.x) / 100) * V.w * z;
  ok('dragging a window 100 px on screen moves it 100 px on screen, so it stays under the pointer', near(movedScreen, 100, 2), { movedScreenPx: Math.round(movedScreen), zoom: z });
  await L.drag(c, tb.x + 140, tb.cy, Array(5).fill(-20), { gapMs: 16, holdMs: 80 });
  ok('the terminal is at its prompt, not in its history', tmux('display', '-p', '-t', 'flow_w-design', '#{pane_in_mode}') === '0');
  const ts = await r('.win[data-id="w-design"] .xterm-screen');
  await press(ts.x + ts.w - 6, ts.y + ts.h - 6);
  await c.send('Input.insertText', { text: 'clear; printf "%s\\n" 0123456789abcdefghijABCDEFGHIJ' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const typed = await L.waitFor(() => ev(`/^0123456789abcdefghijABCDEFGHIJ$/m.test(__flow.term('w-design').getText(20))`), 8000, 'the typed line in the terminal').then(() => true, () => false);
  ok(`at zoom ${z} a click in a terminal and typing land in that terminal (its shell ran the typed line)`, typed);
  const g = await ev(`(() => { const s = document.querySelector('.win[data-id="w-design"] .xterm-screen').getBoundingClientRect(); return { left: s.left, top: s.top, w: s.width, h: s.height }; })()`);
  const [cols, rows] = tmux('display', '-p', '-t', 'flow_w-design', '#{pane_width} #{pane_height}').split(' ').map(Number);
  const cw = g.w / cols, ch = g.h / rows, cell = (col) => ({ x: g.left + (col + 0.5) * cw, y: g.top + 0.5 * ch });
  if (tmux('list-buffers')) tmux('delete-buffer');
  const a = cell(10), b = cell(19);
  await L.sleep(700);
  await L.mouse(c, 'mouseMoved', a.x, a.y);
  await L.mouse(c, 'mousePressed', a.x, a.y);
  for (let i = 1; i <= 6; i++) await L.mouse(c, 'mouseMoved', a.x + ((b.x - a.x) * i) / 6, a.y, { down: true });
  await L.mouse(c, 'mouseReleased', b.x, b.y);
  await L.sleep(500);
  const buf = tmux('show-buffer');
  ok(`at zoom ${z} a drag across a terminal's "abcdefghij" selects those cells`, buf === 'abcdefghij', buf);
});

scenario('link-page', async () => {
  await home();
  const ids0 = await ev('__flow.windows().map((w) => w.id)');
  const tl = await ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.top + 70; y < v.top + 220; y += 10) for (let x = v.left + 20; x < v.left + 220; x += 10) { const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) return { x, y }; } return null; })()`);
  if (!tl) throw new Error('found no empty desktop at the top left of the main space');
  await L.mouse(c, 'mouseMoved', tl.x, tl.y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tl.x, y: tl.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tl.x, y: tl.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await L.sleep(300);
  const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /new shell here/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
  await press(item.cx, item.cy);
  const sh = await L.waitFor(() => ev(`__flow.windows().map((w) => w.id).find((x) => !${JSON.stringify(ids0)}.includes(x)) || null`), 8000, 'the new shell');
  await L.waitFor(() => ev(`(() => { const t = __flow.term(${JSON.stringify(sh)}); return !!t && /[%$#] *$/m.test(t.getText(20)); })()`), 20000, 'the shell prompt');
  const url = `http://127.0.0.1:${PAGES_PORT}/wide.html`;
  const scr = await r(`.win[data-id="${sh}"] .xterm-screen`);
  await press(scr.x + scr.w - 8, scr.y + scr.h - 8);
  await c.send('Input.insertText', { text: `echo ${url}` });
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await L.waitFor(() => ev(`__flow.term(${JSON.stringify(sh)}).getText(40).split('\\n').includes(${JSON.stringify(url)})`), 8000, 'the echoed link');
  const row = await ev(`__flow.term(${JSON.stringify(sh)}).getText(40).split('\\n').indexOf(${JSON.stringify(url)})`);
  const [cols, rows] = tmux('display', '-p', '-t', `flow_${sh}`, '#{pane_width} #{pane_height}').split(' ').map(Number);
  const g = await r(`.win[data-id="${sh}"] .xterm-screen`);
  const cell = { x: g.x + (5 + 0.5) * (g.w / cols), y: g.y + (row + 0.5) * (g.h / rows) };
  await L.sleep(700);
  await press(cell.x, cell.y);
  const pg = await L.waitFor(() => ev(`__flow.windows().filter((w) => w.type === 'page' && w.url === ${JSON.stringify(url)} && !${JSON.stringify(ids0)}.includes(w.id)).map((w) => w.id)[0] || null`), 10000, 'the page from the link').then((v) => v, () => null);
  ok('a link clicked in a terminal opens a page window', !!pg, pg);
  if (!pg) return;
  await L.sleep(500);
  const a = await r(`.win[data-id="${sh}"]`), b = await r(`.win[data-id="${pg}"]`);
  const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const pw = await winState(pg);
  ok('with no free room in view, the page does not cover the terminal it came from (flows\' repro)', overlap === 0 && pw.zone === null && (await onScreen()).includes(pg), { overlapPx: Math.round(overlap), terminal: [Math.round(a.x), Math.round(a.y), Math.round(a.w), Math.round(a.h)], page: [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)] });
  await L.shot(c, path.join(SHOTS, '14-link-page-beside-terminal.png'));
  for (const id of [pg, sh]) { const cl = await r(`.win[data-id="${id}"] [data-l="close"]`); if (cl) { await press(cl.cx, cl.cy); await L.sleep(400); } }
});

scenario('fling', async () => {
  const i = await wsIndex('infra');
  await pill(i);
  const max = await ev(`(() => { const vw = document.getElementById('viewport').getBoundingClientRect().width; const c = document.querySelector('.ws[data-id="infra"] > .canvas'); return Math.round(parseFloat(c.style.width) - vw); })()`);
  if ((await view(i)).x !== 0) await L.drag(c, spot(0.2).x, spot().y, Array(12).fill(80), { gapMs: 16, holdMs: 120 });
  await ev(`window.__navAtUp = null; window.addEventListener('pointerup', () => { window.__navAtUp = Math.round(__flow.state().ws[${i}].pan || 0); }, { capture: true, once: true }); true`);
  await L.drag(c, spot(0.8).x, spot().y, Array(8).fill(-12), { gapMs: 16 });
  const x1 = (await L.waitFor(async () => { const v = await ev('window.__navAtUp'); return v === null ? null : { v }; }, 5000, 'the pan at the release')).v;
  const xs = [];
  for (let k = 0; k < 40; k++) { await L.sleep(100); xs.push((await view(i)).x); if (k >= 3 && xs[k] === xs[k - 1] && xs[k] === xs[k - 2] && xs[k] === xs[k - 3]) break; }
  const steps = xs.slice(1).map((v, k) => v - xs[k]);
  ok('a quick drag pans with the pointer (96 px)', x1 >= 94 && x1 < 170, x1);
  ok('after the release it keeps moving', xs[3] > x1 + 40, { atRelease: x1, every100ms: xs });
  const first = steps.slice(0, 3).reduce((s, v) => s + v, 0), later = steps.slice(6, 9).reduce((s, v) => s + v, 0);
  ok('and slows down to a stop short of the end', first > 2 * later && xs[xs.length - 1] < max && xs.length < 30, { moved: steps, end: max });
  await L.drag(c, spot(0.85).x, spot().y, Array(10).fill(-70), { gapMs: 16 });
  const seenX = [];
  for (let k = 0; k < 30; k++) { seenX.push(await ev(`Math.round(-new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ws[data-id="infra"] > .canvas')).transform).m41)`)); await L.sleep(50); }
  await L.sleep(500);
  ok('a hard fling runs past the end a little and comes back to it', Math.max(...seenX) > max + 3 && (await view(i)).x === max, { end: max, furthest: Math.max(...seenX), now: (await view(i)).x });
  await L.drag(c, spot(0.2).x, spot().y, Array(12).fill(80), { gapMs: 16, holdMs: 120 });
  await L.drag(c, spot(0.8).x, spot().y, Array(8).fill(-12), { gapMs: 16 });
  await L.sleep(120);
  await press(spot(0.5).x, spot().y);
  const p1 = (await view(i)).x;
  await L.sleep(500);
  ok('a press stops a fling where it is', (await view(i)).x === p1 && p1 > 96 && p1 < max, { atPress: p1, later: (await view(i)).x });
  await L.drag(c, spot(0.8).x, spot().y, Array(8).fill(-35), { gapMs: 16 });
  await m.eval(`(() => { process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].emit('swipe', {}, 'left'); return true; })()`);
  await L.sleep(900);
  const held = (await view(i)).x;
  ok('a three-finger swipe left (BrowserWindow swipe in main) goes to the next workspace', (await at()) === 'voiceless', await at());
  await L.sleep(400);
  ok('and stops the fling on the workspace it left', (await view(i)).x === held);
  await m.eval(`(() => { process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].emit('swipe', {}, 'right'); return true; })()`);
  await L.sleep(900);
  ok('a three-finger swipe right goes back', (await at()) === 'infra', await at());
});

scenario('drop', async () => {
  const i = await wsIndex('infra');
  await pill(i);
  for (let k = 0; k < 6 && (await view(i)).x > 0; k++) await L.drag(c, spot(0.1).x, spot().y, Array(12).fill(70), { gapMs: 16, holdMs: 150 });
  const last = await ev(`(() => { const ws = __flow.state().ws[${i}], vw = document.getElementById('viewport').getBoundingClientRect().width; return Math.round((Math.max(100, __flow.nav().contentEnd(ws) + 1.2) / 100) * vw - vw); })()`);
  await L.drag(c, spot(0.9).x, spot().y, Array(13).fill(-last / 13), { gapMs: 16, holdMs: 150 });
  await L.sleep(300);
  const end = (await view(i)).x;
  const t = await r('.win[data-id="i-team"] .tb');
  await L.mouse(c, 'mouseMoved', t.x + 60, t.cy);
  await L.mouse(c, 'mousePressed', t.x + 60, t.cy);
  for (let k = 1; k <= 10; k++) await L.mouse(c, 'mouseMoved', t.x + 60 - 30 * k, t.cy, { down: true });
  await L.sleep(150);
  const mid = await r('.win[data-id="i-team"]');
  await L.mouse(c, 'mouseReleased', t.x + 60 - 300, t.cy);
  await L.sleep(600);
  const after = await r('.win[data-id="i-team"]');
  ok('dropping the rightmost window with the view where it ends moves neither the view nor the window (build\'s repro)', near(end, last, 1) && (await view(i)).x === end && near(after.x, mid.x, 2), { panBefore: end, panAfter: (await view(i)).x, windowMidDrag: Math.round(mid.x), windowAfter: Math.round(after.x) });
  await L.drag(c, spot(0.2).x, spot().y, Array(10).fill(70), { gapMs: 16, holdMs: 150 });
  ok('then a pan back left works from there', (await view(i)).x < end, (await view(i)).x);
  await pill(0);
});

scenario('place', async () => {
  await home();
  await swipe(SW);
  await pinch(spot().x, V.y + V.h * 0.5, Array(4).fill(7));
  const v0 = await view(0, 'z-research');
  const id = await dockNote();
  if (!id) { ok('the dock\'s new note made a window', false, await ev(`document.getElementById('toast').textContent`)); return; }
  const w = await winState(id), vr = await shown(0);
  ok('a new note from the dock lands in the space you are in, inside the view and inside the space, and the view stays', w.zone === 'z-research' && inView(w, vr) && inSpaceArea(w) && JSON.stringify(await view(0, 'z-research')) === JSON.stringify(v0), { w, view: vr });
  await L.shot(c, path.join(SHOTS, '08-new-note-in-research.png'));
});

scenario('edge-pan', async () => {
  await home();
  const tb = await r('.win[data-id="w-week"] .tb');
  await L.mouse(c, 'mouseMoved', tb.x + 40, tb.cy);
  await L.mouse(c, 'mousePressed', tb.x + 40, tb.cy);
  const edgeX = V.x + V.w - 8;
  for (let k = 1; k <= 12; k++) await L.mouse(c, 'mouseMoved', tb.x + 40 + ((edgeX - tb.x - 40) * k) / 12, tb.cy, { down: true });
  await L.sleep(1500);
  const v = await view(0, null);
  await L.mouse(c, 'mouseReleased', edgeX, tb.cy);
  await L.sleep(300);
  const w = await winState('w-week');
  ok('a window held at the right edge carries its space along: the space pans and the window goes with the pointer', v.x > 300 && w.x > 100, { pan: v.x, windowX: w.x });
  const tb2 = await r('.win[data-id="w-week"] .tb');
  await L.drag(c, tb2.x + 40, tb2.cy, Array(30).fill(-80), { gapMs: 16, holdMs: 100 });
  await L.sleep(300);
  ok('a window dragged past the left edge stops at it and is never lost', (await winState('w-week')).x >= 0, await winState('w-week'));
});

scenario('restart', async () => {
  const ii = await wsIndex('infra');
  await pill(ii);
  const imax = await ev(`(() => { const vw = document.getElementById('viewport').getBoundingClientRect().width; const c = document.querySelector('.ws[data-id="infra"] > .canvas'); return Math.round(parseFloat(c.style.width) - vw); })()`);
  for (let k = 0; k < 6 && (await view(ii)).x < imax; k++) await L.drag(c, spot(0.9).x, spot().y, Array(20).fill(-70), { gapMs: 16, holdMs: 150 });
  await pinch(V.x + V.w * 0.5, V.y + V.h * 0.5, [40, 40, 40]);
  const infra = await view(ii);
  const vi = await wsIndex('voiceless');
  await pill(vi);
  const endPx = await ev(`Math.round(__flow.nav().contentEnd(__flow.state().ws[${vi}]) / 100 * document.getElementById('viewport').getBoundingClientRect().width)`);
  const nid = await dockNote();
  let left = null;
  if (nid) {
    const tb = await r(`.win[data-id="${nid}"] .tb`);
    await L.mouse(c, 'mouseMoved', tb.x + 40, tb.cy);
    await L.mouse(c, 'mousePressed', tb.x + 40, tb.cy);
    const edgeX = V.x + V.w - 8;
    for (let k = 1; k <= 12; k++) await L.mouse(c, 'mouseMoved', tb.x + 40 + ((edgeX - tb.x - 40) * k) / 12, tb.cy, { down: true });
    const far = await L.waitFor(async () => (await view(vi)).x > endPx + 150, 15000, 'the carried note to take the view past the windows').then(() => true, () => false);
    await L.mouse(c, 'mouseReleased', edgeX, tb.cy);
    await L.sleep(400);
    const cl = await r(`.win[data-id="${nid}"] .lights i[data-l="close"]`);
    await press(cl.cx, cl.cy);
    await L.waitFor(() => ev(`!__flow.windows().some((w) => w.id === ${JSON.stringify(nid)})`), 4000, 'the carried note to close');
    await L.sleep(400);
    left = { view: await view(vi), endPx, far };
  }
  await home();
  await swipe(SW);
  await pinch(spot().x, V.y + V.h * 0.5, Array(3).fill(9));
  const research = await view(0, 'z-research');
  await swipe(BACK);
  await pinch(spot(0.3).x, V.y + V.h * 0.4, Array(3).fill(-9));
  const main = await view(0, null);
  await swipe(SW);
  await L.sleep(600);
  c.close();
  m.close();
  await L.stop({ keepTmux: true });
  L.launch(ENTRY ? { entry: ENTRY } : {});
  c = await L.flowWindow();
  m = await L.mainProcess();
  await L.sleep(800);
  const r2 = await view(0, 'z-research'), m2 = await view(0, null);
  ok('Flow starts again on the state it saved: ready, and no "failed to start"', !(await startFailed()), await ev(`document.getElementById('toast').textContent`));
  ok('after a restart Flow is back in the research space', (await space(0)) === 'z-research', await space(0));
  ok('with each space\'s own zoom and pan as they were left', JSON.stringify(r2) === JSON.stringify(research) && JSON.stringify(m2) === JSON.stringify(main), { research: [research, r2], main: [main, m2] });
  const i2 = await view(ii);
  if (left) {
    const now = await view(vi), to = await ev(`(() => { const ws = __flow.state().ws[${vi}], vw = document.getElementById('viewport').getBoundingClientRect().width; return Math.max(0, Math.round((Math.max(100, __flow.nav().contentEnd(ws) + 1.2) / 100) * vw - vw / (ws.zoom || 1))); })()`);
    ok('a view left out past its space\'s last window, showing none of it, is back where the windows end after a restart', left.far && left.view.x > left.endPx && now.x === to, { carriedPastTheWindows: left.far, before: left.view, windowsEndPx: left.endPx, after: now, backTo: to });
  } else ok('a carried note for the empty-view check', false, 'no note from the dock');
  ok('and a space pinched out at its far right end is back exactly as it was left', infra.z < 0.32 && JSON.stringify(i2) === JSON.stringify(infra), { before: infra, after: i2 });
  await L.shot(c, path.join(SHOTS, '09-after-restart.png'));
});

scenario('remove', async () => {
  await home();
  await swipe(SW);
  const rc = await emptyAt();
  if (!rc) throw new Error('found no empty desktop in research for a right-click');
  await L.mouse(c, 'mouseMoved', rc.x, rc.y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await L.sleep(300);
  const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /new shell here/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await press(item.x, item.y);
  await L.sleep(800);
  const shell = await ev(`__flow.state().ws[0].windows.filter((w) => w.zone === 'z-research' && w.cmd === 'shell').map((w) => w.id).pop()`);
  await L.waitFor(() => hasSession(shell), 15000, 'the new shell\'s tmux session');
  const inResearch = await ev(`__flow.state().ws[0].windows.filter((w) => w.zone === 'z-research').map((w) => w.id).sort()`);
  await ev(`__flow.nav().removeZone(0, 'z-research')`);
  await L.sleep(700);
  const s1 = await ev(`(() => { const f = __flow.state().ws[0]; return { zones: f.zones.map((z) => z.id), space: f.space || null, open: f.windows.filter((w) => w.zone === 'z-research').length, closed: f.closed.map((w) => w.id) }; })()`);
  const alive = hasSession(shell);
  ok('removing a sub-workspace goes to the main space, and its terminal goes to the closed list with its session running', !s1.zones.includes('z-research') && s1.space === null && s1.open === 0 && s1.closed.includes(shell) && alive, { ...s1, sessionAlive: alive });
  await L.shot(c, path.join(SHOTS, '11-removed-research.png'));
  const undo = await r('#toast .tact');
  ok('the toast offers undo', !!undo, await ev(`document.getElementById('toast').textContent`));
  await press(undo.cx, undo.cy);
  await L.sleep(1200);
  const back = await ev(`__flow.state().ws[0].windows.filter((w) => w.zone === 'z-research').map((w) => w.id).sort()`);
  const clients = tmux('list-clients', '-t', `flow_${shell}`).split('\n').filter(Boolean).length;
  ok('undo puts the sub-workspace back with every window, the terminal attached again', (await space(0)) === 'z-research' && back.join() === inResearch.join() && clients >= 1 && !(await ev(`__flow.state().ws[0].closed.map((w) => w.id)`)).includes(shell), { back, clients });
  await swipe(BACK);
  const i = await wsIndex('infra');
  const terms = await ev(`__flow.state().ws[${i}].windows.filter((w) => w.type === 'term' || w.type === 'team').map((w) => w.id).sort()`);
  await pill(i);
  await L.waitFor(() => terms.every(hasSession), 20000, 'infra\'s terminals to start');
  await pill(0);
  const left = (await ev('__flow.state().ws.map((w) => w.id)'))[i - 1];
  await ev(`__flow.nav().removeWorkspace(${i})`);
  await L.sleep(700);
  const s2 = await ev(`(() => { const s = __flow.state(); const st = s.ws.find((w) => w.id === ${JSON.stringify(left)}); return { ids: s.ws.map((w) => w.id), closed: st.closed.map((w) => w.id).sort() }; })()`);
  const sessions = terms.filter(hasSession);
  ok('removing a workspace moves its terminals to the closed list of the workspace before it, sessions running', !s2.ids.includes('infra') && terms.every((id) => s2.closed.includes(id)) && sessions.length === terms.length, { ...s2, terms, sessions });
  const undo2 = await r('#toast .tact');
  await press(undo2.cx, undo2.cy);
  await L.sleep(1200);
  const s3 = await ev(`(() => { const s = __flow.state(); return { ids: s.ws.map((w) => w.id), at: s.ui.at, wins: s.ws.find((w) => w.id === 'infra').windows.filter((w) => w.type === 'term' || w.type === 'team').map((w) => w.id).sort() }; })()`);
  ok('undo puts the workspace back in its place with its terminals, and goes there', s3.ids[i] === 'infra' && s3.at === 'infra' && s3.wins.join() === terms.join(), s3);
  await pill(0);
});

scenario('popout', async () => {
  if (!(await ev('__flow.nav().popoutsLive'))) { console.log('skip popout: app.js does not pass nav release and refresh yet (nav STATUS bullet), so pop-outs stay as before'); return; }
  await home();
  await swipe(SW);
  const ids0 = await ev('__flow.windows().map((w) => w.id)');
  const at0 = await emptyAt();
  if (!at0) throw new Error('found no empty desktop in research for a right-click');
  await L.mouse(c, 'mouseMoved', at0.x, at0.y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at0.x, y: at0.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at0.x, y: at0.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await L.sleep(300);
  const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /new shell here/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
  await press(item.cx, item.cy);
  const sh = await L.waitFor(() => ev(`__flow.windows().map((w) => w.id).find((x) => !${JSON.stringify(ids0)}.includes(x)) || null`), 8000, 'the new shell');
  const clients = () => tmux('list-clients', '-t', `flow_${sh}`).split('\n').filter(Boolean).length;
  await L.waitFor(() => hasSession(sh) && clients() === 1, 15000, 'the shell\'s tmux session with this window\'s client');
  const pop = await r('.tr[data-act="zone|z-research"] [data-zpop]');
  await press(pop.cx, pop.cy);
  const t = await L.waitFor(async () => (await L.targets()).find((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 20000, 'the research pop-out');
  const sc = await L.Cdp.connect(t.webSocketDebuggerUrl);
  try {
    await sc.send('Runtime.enable');
    await L.waitFor(() => sc.eval('!!(window.__flow && window.__flow.ready)'), 20000, 'the pop-out ready');
    await sc.eval('window.__flow.ready.then(() => true)');
    await L.waitFor(() => sc.eval(`!!document.querySelector('.win[data-id="w-kv"] webview') && !!document.querySelector('.win[data-id="${sh}"] .xterm')`), 20000, 'research\'s page and shell in the pop-out');
    await L.sleep(1500);
    const awayText = await ev(`(() => { const a = document.querySelector('.ws[data-id="flow"] .away'); return a && getComputedStyle(a).display !== 'none' ? a.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
    ok('the main window shows research only as its name and "in another window"', awayText === 'research in another window' && !(await onScreen()).some((id) => ['w-kv', 'w-judge', 'w-read', sh].includes(id)), { awayText, onScreen: await onScreen() });
    const pages = { main: await ev(`document.querySelectorAll('.win[data-id="w-kv"] webview, .win[data-id="w-judge"] webview').length`), popout: await sc.eval(`document.querySelectorAll('.win[data-id="w-kv"] webview, .win[data-id="w-judge"] webview').length`) };
    ok('research\'s pages load once, in the pop-out', pages.main === 0 && pages.popout === 2, pages);
    ok('its terminal has one tmux client, the pop-out\'s', clients() === 1 && !(await ev(`!!document.querySelector('.win[data-id="${sh}"] .xterm')`)), { clients: clients() });
    await L.shot(c, path.join(SHOTS, '12-research-in-another-window.png'));
    const log = path.join(L.USER_DATA, 'main.log');
    const forward = () => (fs.readFileSync(log, 'utf8').match(/background: solo=flow&zone=z-research shown inactive/g) || []).length;
    const n0 = forward();
    const a = await r('.ws[data-id="flow"] .away');
    await press(a.cx, a.cy);
    await L.waitFor(() => forward() > n0, 5000, 'main to bring the pop-out forward').then(() => true, () => false).then((brought) => ok('a click on it brings the pop-out forward (main.log)', brought, { before: n0, after: forward() }));
    await swipe(BACK);
    const usual = await ev(`(() => { const e = document.querySelector('.win[data-id="w-design"]'), a = document.querySelector('.ws[data-id="flow"] .away'); return { framed: !!e && getComputedStyle(e).display !== 'none', terminal: !!(e && e.querySelector('.xterm')), away: !!a && getComputedStyle(a).display !== 'none' }; })()`);
    ok('the main space, which is not popped out, shows as usual: its windows have their frames and bodies, and no "in another window"', (await space(0)) === null && usual.framed && usual.terminal && !usual.away, { space: await space(0), ...usual });
    await sc.eval('window.close(); true').catch(() => {});
  } finally { sc.close(); }
  await L.waitFor(async () => !(await L.targets()).some((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 10000, 'the pop-out to close');
  await swipe(SW);
  const back = await L.waitFor(() => ev(`(() => { const a = document.querySelector('.ws[data-id="flow"] .away'); return (!a || getComputedStyle(a).display === 'none') && document.querySelectorAll('.win[data-id="w-kv"] webview, .win[data-id="w-judge"] webview').length === 2 && !!document.querySelector('.win[data-id="${sh}"] .xterm'); })()`), 15000, 'research back in the main window').then(() => true, () => false);
  await L.waitFor(() => clients() === 1, 10000, 'one client again').catch(() => {});
  ok('when the pop-out closes, research is back in the main window with its pages and its terminal (one client)', back && clients() === 1 && (await onScreen()).includes('w-kv'), { clients: clients(), onScreen: await onScreen() });
  await L.shot(c, path.join(SHOTS, '13-research-back.png'));
  await swipe(BACK);
});

scenario('solo-zone', async () => {
  await home();
  const before = (await L.targets()).filter((t) => t.type === 'page').length;
  const pop = await r('.tr[data-act="zone|z-research"] [data-zpop]');
  await press(pop.cx, pop.cy);
  const t = await L.waitFor(async () => (await L.targets()).find((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 20000, 'the research pop-out');
  const sc = await L.Cdp.connect(t.webSocketDebuggerUrl);
  try {
    await sc.send('Runtime.enable');
    await L.waitFor(() => sc.eval('!!(window.__flow && window.__flow.ready)'), 20000, 'the pop-out ready');
    await sc.eval('window.__flow.ready.then(() => true)');
    await L.sleep(600);
    const ids = await sc.eval(`[...document.querySelectorAll('.win')].filter((e) => { const b = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return b.width && b.right > v.left + 1 && b.left < v.right - 1; }).map((e) => e.dataset.id).sort()`);
    const mine = await ev(`__flow.state().ws[0].windows.filter((w) => w.zone === 'z-research').map((w) => w.id).sort()`);
    const where = await sc.eval(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ws[data-id="flow"] > .canvas')).transform); return { view: { pan: Math.round(-m.e / m.a), panY: Math.round(-m.f / m.a), zoom: +m.a.toFixed(3), width: Math.round(v.width) }, frames: Object.fromEntries([...document.querySelectorAll('.win')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.id, [Math.round(b.left - v.left), Math.round(b.top - v.top), Math.round(b.width), Math.round(b.height)]]; })) }; })()`);
    ok('a sub-workspace\'s own window shows only its space', ids.length > 0 && ids.every((id) => mine.includes(id)), { shown: ids, research: mine, ...where });
    const v = await sc.eval(`(() => { const b = document.getElementById('viewport').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; })()`);
    await L.swipe(sc, v.x + v.w / 2, v.y + 45, SW);
    await L.sleep(700);
    const after = await sc.eval(`[...document.querySelectorAll('.win')].filter((e) => { const b = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return b.width && b.right > v.left + 1 && b.left < v.right - 1; }).map((e) => e.dataset.id).sort()`);
    ok('and a two-finger swipe there does not leave it', after.join() === ids.join(), after);
    await L.shot(sc, path.join(SHOTS, '10-solo-zone.png'));
    await sc.eval('window.close(); true').catch(() => {});
  } finally { sc.close(); }
  await L.waitFor(async () => (await L.targets()).filter((x) => x.type === 'page').length === before, 10000, 'the pop-out to close').catch((e) => ok('the pop-out closed', false, e.message));
  await L.sleep(400);
  ok('the main window still shows the main space', (await space(0)) === null, await space(0));
});

/* A window's frame: how much of it is on screen in the viewport (0..1). */
const inViewShare = (id) => ev(`(() => { const e = document.querySelector('.win[data-id="${id}"]'); if (!e) return -1; const r = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left)), h = Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)); return +((w * h) / Math.max(1, r.width * r.height)).toFixed(2); })()`);
/* A pop-out is not a Flow start: opening one leaves the saved state as it is, so room just added elsewhere stays
   (overview's report: mynotes' room went 200 -> 0 two seconds after research was popped out). */
scenario('popout-room', async () => {
  if (!(await ev('__flow.nav().popoutsLive'))) return;
  const mi = await wsIndex('mynotes');
  await pill(mi);
  const x = V.x + V.w - 8, y = spot().y;
  for (const n of [1, 2]) {
    await L.mouse(c, 'mouseMoved', x, y);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n, pointerType: 'mouse' });
    await L.sleep(60);
  }
  await L.sleep(600);
  const added = await ev(`__flow.state().ws[${mi}].roomRight || 0`);
  await pill(0);
  const before = (await L.targets()).filter((t) => t.type === 'page').length;
  const pop = await r('.tr[data-act="zone|z-research"] [data-zpop]');
  await press(pop.cx, pop.cy);
  const t = await L.waitFor(async () => (await L.targets()).find((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 20000, 'the research pop-out');
  const sc = await L.Cdp.connect(t.webSocketDebuggerUrl);
  try {
    await sc.send('Runtime.enable');
    await L.waitFor(() => sc.eval('!!(window.__flow && window.__flow.ready)'), 20000, 'the pop-out ready');
    await sc.eval('window.__flow.ready.then(() => true)');
    await L.sleep(2500);
    const kept = await ev(`__flow.state().ws[${mi}].roomRight || 0`);
    ok('opening a pop-out leaves room just added in another workspace as it is', added > 100 && kept === added, { added, afterPopout: kept });
    await sc.eval('window.close(); true').catch(() => {});
  } finally { sc.close(); }
  await L.waitFor(async () => (await L.targets()).filter((x) => x.type === 'page').length === before, 10000, 'the pop-out to close').catch((e) => ok('the pop-out closed', false, e.message));
});

/* A window past the right side comes into view just enough, so what was in view stays in view as far as it can. It is
   the geometry of a fork that besideSpot puts beside its parent in the right column (flows' repro on 32a7bf39: the
   view slid onto the fork, parent 0% in view); the fork itself needs Claude Code in a trusted folder. */
scenario('beside', async () => {
  const i = await wsIndex('ef');
  await pill(i);
  const pk = await r('.win[data-id="e-term"] .lights i[data-l="park"]');
  await L.mouse(c, 'mouseMoved', pk.cx, pk.cy);
  await L.sleep(200);
  await press(pk.cx, pk.cy);
  await L.sleep(900);
  const g = await ev(`(() => { const ws = __flow.state().ws[${i}], w = ws.windows.find((x) => x.id === 'e-term'); return { x: w.x, w: w.w }; })()`);
  const v0 = await view(i), off = await inViewShare('e-term'), page0 = await inViewShare('e-page');
  const row = await ev(`(() => { const e = document.querySelector('#sblist [data-act="win|e-term"], #sblist [data-id="e-term"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (!row) { ok('e-term has a sidebar row', false); return; }
  await press(row.x, row.y);
  await L.sleep(900);
  const v1 = await view(i), tIn = await inViewShare('e-term'), pIn = await inViewShare('e-page');
  const want = Math.round(((g.x + g.w + 1.2) / 100) * V.w - V.w);
  ok('parked past the right side, e-term is out of view and the window beside it is in view', off < 0.05 && page0 >= 0.99, { eTerm: off, ePage: page0, view: v0 });
  ok('its sidebar row brings it in just enough: its right side at the view\'s, and the window beside it stays in view', tIn >= 0.99 && pIn >= 0.5 && near(v1.x, want, 2), { eTerm: tIn, ePage: pIn, pan: v1.x, justEnough: want });
  await L.shot(c, path.join(SHOTS, '15-beside-in-view.png'));
});

/* The literal fork: Claude Code in mynotes (L.CLAUDE_WORK, trusted through /home/claude, so it never asks to trust the
   folder; if it asks anyway the check stops there and the question stays unanswered), one tiny prompt, and a fork of
   that session from the right-click menu. Owner: a fork "side by side" with its parent (cli-code-manager-live.md:289).
   Both sessions are the test's own and end with it. */
scenario('fork', async () => {
  const i = await wsIndex('mynotes');
  const under = (dir) => typeof dir === 'string' && dir.startsWith(`${L.CLAUDE_WORK}/`);
  const folder = await ev(`__flow.state().ws[${i}].folder`);
  if (!under(folder)) { ok(`mynotes' folder is under ${L.CLAUDE_WORK}, where Claude Code may run`, false, folder); return; }
  await pill(i);
  const made = [];
  try {
    const mb = await r('#modes button[data-m="columns"]');
    if (mb && mb.w > 2) await press(mb.cx, mb.cy);
    else await ev(`__flow.menu('mode-columns')`);
    await L.waitFor(() => ev(`__flow.state().ws[${i}].mode === 'columns'`), 3000, 'mynotes in columns, so a new window is the rightmost');
    const ids0 = await ev('__flow.windows().map((w) => w.id)');
    await L.mouse(c, 'mouseMoved', V.x + V.w / 2, V.y + V.h - 6);
    await L.waitFor(() => ev(`getComputedStyle(document.getElementById('dock')).visibility === 'visible' && +getComputedStyle(document.getElementById('dock')).opacity > 0.9`), 3000, 'the dock to come up');
    const db = await r('#dock button[data-k="agent"]');
    await L.mouse(c, 'mouseMoved', db.cx, db.cy);
    await L.sleep(150);
    await press(db.cx, db.cy);
    const id = await L.waitFor(() => ev(`__flow.windows().map((w) => w.id).find((x) => !${JSON.stringify(ids0)}.includes(x)) || null`), 6000, 'the agent window');
    made.push(id);
    await L.mouse(c, 'mouseMoved', spot().x, spot().y);
    const cwd = await ev(`__flow.state().ws[${i}].windows.find((w) => w.id === ${JSON.stringify(id)}).cwd`);
    if (!under(cwd)) { ok('the agent runs Claude Code in mynotes\' folder', false, cwd); return; }
    const text = (w, n) => ev(`(() => { const t = __flow.term(${JSON.stringify(w)}); return t ? t.getText(${n}) : ''; })()`);
    const ready = await L.waitFor(async () => { const t = await text(id, 60); if (/trust this folder/i.test(t)) return 'trust'; return /for shortcuts|bypass permissions|❯/.test(t) && 'ready'; }, 90000, 'Claude Code to be ready');
    if (ready === 'trust') { ok('Claude Code starts without asking to trust the folder (the check stops here; the question is not answered)', false, cwd); return; }
    const th = await r(`.win[data-id="${id}"] .termhost`);
    await press(th.x + 60, th.y + th.h - 30);
    for (const ch of 'Reply with exactly one word: kiwi') { await c.send('Input.insertText', { text: ch }); await L.sleep(35); }
    await L.sleep(1500);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await L.waitFor(async () => (await text(id, 80)).split('\n').some((l) => /^\s*[⏺●]/.test(l) && /kiwi/i.test(l)), 120000, 'the reply');
    const parent = await r(`.win[data-id="${id}"]`), v0 = await view(i);
    ok('the parent sits in the right column, so its fork lands past the view (the case to check)', parent.x + parent.w > V.x + V.w * 0.97, { parent, view: v0 });
    const ids1 = await ev('__flow.windows().map((w) => w.id)');
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: th.cx, y: th.cy, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: th.cx, y: th.cy, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await L.sleep(450);
    const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /^fork/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!item) { ok('the right-click menu offers fork', false, await ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`)); return; }
    await press(item.x, item.y);
    const fid = await L.waitFor(() => ev(`__flow.windows().map((w) => w.id).find((x) => !${JSON.stringify(ids1)}.includes(x)) || null`), 30000, 'the fork window').then((v) => v, () => null);
    if (!fid) { ok('fork opened a window', false, await ev(`document.getElementById('toast').textContent`)); return; }
    made.push(fid);
    const conv = await L.waitFor(async () => /kiwi/i.test(await text(fid, 80)), 90000, 'the fork to show the conversation').then(() => true, () => false);
    await L.sleep(1500);
    const pIn = await inViewShare(id), fIn = await inViewShare(fid), v1 = await view(i);
    await L.shot(c, path.join(SHOTS, '16-fork-beside-parent.png'));
    ok('a fork opens with its parent\'s conversation', conv);
    ok('a fork lands beside its parent and both stay in view', fIn >= 0.9 && pIn >= 0.9, { parentInView: pIn, forkInView: fIn, viewBefore: v0, viewAfter: v1, parent: await winState(id), fork: await winState(fid) });
  } finally {
    for (const x of made) if (hasSession(x)) tmux('kill-session', '-t', `flow_${x}`);
  }
});

async function main() {
  if (!fs.existsSync(path.join(L.USER_DATA, 'seed.json'))) { console.log('writing the safe seed (probe launch)'); await L.writeSeed(); }
  await L.stop();
  L.resetState();
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const server = spawn('node', [path.join(L.ROOT, 'test', 'nav-pages', 'serve.mjs'), String(PAGES_PORT)], { stdio: 'ignore' });
  L.launch(ENTRY ? { entry: ENTRY } : {});
  try {
    c = await L.flowWindow();
    m = await L.mainProcess();
    V = await r('#viewport');
    Y = await findY();
    if (Y == null) throw new Error('found no empty strip of desktop under the menu bar');
    await L.waitFor(() => /^\d+x\d+$/.test(termSize()), 20000, 'w-design\'s tmux session');
    TERM_SIZE = termSize();
    console.log(`app: ${ENTRY || 'src/index.html'}, viewport ${Math.round(V.w)}x${Math.round(V.h)}, w-design ${TERM_SIZE}`);
    ok('Flow starts on the fresh seed: ready, and no "failed to start"', !(await startFailed()), await ev(`document.getElementById('toast').textContent`));
    for (const s of SCEN) {
      if (ONLY && !ONLY.includes(s.name)) continue;
      try { await s.fn(); } catch (err) { ok(`${s.name} ran`, false, err.message); }
    }
    ok('no console errors or exceptions in the Flow window', c.errors.length === 0, c.errors.slice(0, 5));
  } finally {
    if (c) c.close();
    if (m) m.close();
    server.kill();
    if (!KEEP) await L.stop();
  }
  console.log(`\n${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });




