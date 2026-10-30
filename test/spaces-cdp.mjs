// spaces' check of dragging a space as a board with no box (owner 14:08 "so clipped", 14:12; zoom's board rules, Nov 2
// 14:2x): a free drag into empty board goes there 1:1 and stays where it is let go, nothing jumps back, and the space's
// extent (nav.sheet: the windows' own box) does not grow from looking; the edge glow points back to the windows.
// The edge double-click and growing are spaces-edges.mjs. Runs spaces' own isolated app from SPACES_ROOT (default:
// this repo) on the safe seed: socket flow-dev-spaces, CDP port 9575, userData /tmp/flow-dev-spaces, marker
// --flow-dev=spaces, windows with a host dropped, terminals as shells in /home/claude/.flow-dev/spaces/work.
//   SPACES_ROOT=<app tree> node test/spaces-cdp.mjs [--keep]      (--today is accepted and changes nothing)
// Screenshots go to SPACES_SHOTS.
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, drag, shot } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed } from './spaces-lib.mjs';

const SHOTS = process.env.SPACES_SHOTS || path.join(USER_DATA, 'shots');
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const q = JSON.stringify;

/* ---------- reading the app ---------- */
let c, V, Y, oks = 0, fails = 0;
const ERRS = [];
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const wsIndex = (id) => ev(`__flow.state().ws.findIndex((w) => w.id === ${q(id)})`);
/* The view of a workspace's space on screen, in px at zoom 1. Pans are kept in px, or in % of the view (pan of its
   width, panY of its height) once the workspace says panUnit '%'. */
const panPx = (ws, vw, vh) => (ws.panUnit === '%' ? { x: ((ws.pan || 0) / 100) * vw, y: ((ws.panY || 0) / 100) * vh } : { x: ws.pan || 0, y: ws.panY || 0 });
const view = (id) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === ${q(id)}), r = document.getElementById('viewport').getBoundingClientRect();
  const p = (${panPx.toString()})(ws, r.width, r.height);
  return { x: Math.round(p.x), y: Math.round(p.y), z: +(ws.zoom || 1).toFixed(3), at: ws.at || null }; })()`);
/* Where the canvas is drawn this frame (a rubber band included), in px at zoom 1. */
const drawnX = (id) => ev(`(() => { const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ws[data-id=${q(id)}] > .canvas')).transform); return Math.round(-m.m41 / m.a); })()`);
/* The space on screen's extent: its windows' places (% of the view), every room mark it keeps, and nav's sheet while
   nav has one. */
const extent = (id) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === ${q(id)}), sid = ws.at || null, zn = sid && ws.zones.find((z) => z.id === sid);
  const nav = __flow.nav(), s = typeof nav.sheet === 'function' ? nav.sheet(ws) : null, holder = zn || ws;
  return { wins: Object.fromEntries(ws.windows.filter((w) => (w.zone || null) === sid).map((w) => [w.id, [+w.x.toFixed(2), +w.y.toFixed(2)]])),
    marks: Object.fromEntries(Object.keys(holder).filter((k) => /^room/.test(k)).map((k) => [k, holder[k]])), sheet: s && { w: +s.w.toFixed(2), h: +s.h.toFixed(2) } }; })()`);
const glow = () => ev(`({ r: document.getElementById('edgeR').classList.contains('on'), l: document.getElementById('edgeL').classList.contains('on') })`);
/* Where each window is drawn on screen, px from the viewport's left. */
const screenX = (id) => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); return Object.fromEntries([...document.querySelectorAll('.ws[data-id=${q(id)}] .win')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => [e.dataset.id, Math.round(e.getBoundingClientRect().left - v.left)])); })()`);
const onScreen = () => ev(`[...document.querySelectorAll('.win')].filter((e) => { const b = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return b.width && b.right > v.left + 1 && b.left < v.right - 1 && b.bottom > v.top && b.top < v.bottom; }).map((e) => e.dataset.id).sort()`);
const box = (sel) => ev(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
/* A strip of bare desktop under the menu bar, wherever the view is. */
const findY = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), mb = document.querySelector('.menubar').getBoundingClientRect();
  for (let y = Math.max(v.top, mb.bottom) + 2; y < v.top + 120; y += 1) if ([0.1, 0.3, 0.5, 0.8, 0.85, 0.95].every((f) => { const e = document.elementFromPoint(v.left + v.width * f, y); return e && e.matches('.canvas, .ws'); })) return y;
  return null; })()`);
const spot = (fx = 0.5) => ({ x: V.x + V.w * fx, y: Y });

/* ---------- real input ---------- */
async function press(x, y) { await mouse(c, 'mouseMoved', x, y); await mouse(c, 'mousePressed', x, y); await mouse(c, 'mouseReleased', x, y); }
async function pill(id) { const p = await box(`.sp[data-i="${await wsIndex(id)}"]`); await press(p.cx, p.cy); await sleep(700); }
/* A slow drag of the desktop by dx px that is held still before the release, so it does not glide. */
async function pan(dx) {
  for (let left = dx; Math.abs(left) > 0.5;) {
    const part = Math.sign(left) * Math.min(Math.abs(left), V.w * 0.7), n = Math.max(1, Math.ceil(Math.abs(part) / 60));
    await drag(c, spot(part < 0 ? 0.9 : 0.1).x, spot().y, Array(n).fill(part / n), { gapMs: 16, holdMs: 150 });
    await sleep(550);
    left -= part;
  }
}
/* A held drag of the desktop by dx px: the most the space's canvas gave while it was held (px at zoom 1), so a check
   that the view stays put knows the drag reached the app. */
async function heldDrag(id, dx) {
  const x0 = spot(dx < 0 ? 0.9 : 0.1).x, n = Math.max(1, Math.ceil(Math.abs(dx) / 30));
  let most = 0;
  await mouse(c, 'mouseMoved', x0, Y);
  await mouse(c, 'mousePressed', x0, Y);
  for (let k = 1; k <= n; k++) {
    await mouse(c, 'mouseMoved', x0 + (dx * k) / n, Y, { down: true });
    await sleep(16);
    const d = Math.abs(await drawnX(id));
    if (Number.isFinite(d)) most = Math.max(most, d);
  }
  await mouse(c, 'mouseReleased', x0 + dx, Y);
  await sleep(900);
  return most;
}

async function checks() {
  const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
  await pill('ef');
  const v0 = await view('ef'), e0 = await extent('ef'), x0 = await screenX('ef');
  const held = await heldDrag('ef', -300);
  const v1 = await view('ef'), e1 = await extent('ef'), x1 = await screenX('ef');
  await sleep(1500);
  const v2 = await view('ef'), x2 = await screenX('ef');
  await shot(c, path.join(SHOTS, '00-ef-after-free-drag.png'));
  const followed = Object.keys(x0).length === 3 && Object.keys(x0).filter((id) => x1[id] !== undefined).every((id) => near(x1[id], x0[id] - 300) && x2[id] === x1[id]);
  ok('a free drag on ef\'s desktop goes into empty board 1:1 and stays where it is let go; nothing jumps back and the space\'s extent is unchanged',
    near(held, 300) && near(v1.x - v0.x, 300) && v2.x === v1.x && followed && q(e1) === q(e0), { heldDrawn: held, view: [v0.x, v1.x, v2.x], extent: [e0, e1], followed });
  await pill('infra');
  const ei = await extent('infra'), vi0 = await view('infra');
  await pan(-3000);
  await sleep(900);
  const vi = await view('infra'), ei1 = await extent('infra'), g = await glow();
  ok('in infra a drag goes past its last window and stays there; the extent is unchanged and the left glow points back to the windows',
    near(vi.x - vi0.x, 3000, 4) && (await onScreen()).length === 0 && q(ei1) === q(ei) && g.l, { view: [vi0.x, vi.x], extent: [ei, ei1], glow: g });
  await shot(c, path.join(SHOTS, '00-infra-past-the-end.png'));
}

async function main() {
  if (!fs.existsSync(path.join(USER_DATA, 'seed.json'))) { const r = await writeSeed(); console.log(`wrote the safe seed: ${r.ids.join(', ')}; dropped host windows: ${r.removed.join(', ') || 'none'}`); }
  await stop();
  fs.copyFileSync(path.join(USER_DATA, 'seed.json'), path.join(USER_DATA, 'flow-state.json'));
  fs.rmSync(SHOTS, { recursive: true, force: true });
  launch();
  try {
    c = await flowWindow();
    V = await box('#viewport');
    Y = await findY();
    if (Y == null) throw new Error('found no strip of bare desktop under the menu bar');
    console.log(`app: ${ROOT}, viewport ${Math.round(V.w)}x${Math.round(V.h)}`);
    try { await checks(); } catch (err) { ok('the checks ran to the end', false, err.message); }
    ERRS.push(...c.errors);
    ok('no console errors or exceptions in the Flow window', ERRS.length === 0, ERRS.slice(0, 5));
  } finally {
    if (c) c.close();
    if (!KEEP) await stop();
  }
  console.log(`\n${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });




