// spaces' check of a space as a board with no box (owner 14:03-14:12; zoom's board rules, Nov 2 14:2x), with real
// input over CDP. A double-click at a side of the view pushes what lies past that side one view on (one view at 100%,
// at any zoom) and does nothing when nothing lies there, since the board already goes on; a window under the pointer
// wins. A free drag goes anywhere and stays, and adds nothing to the space; only a window made out there grows it (the
// extent is the windows' own box, nav.sheet). Growing left shifts every window and view together, so nothing moves on
// screen and x stays >= 0. A view comes back where it was left. The same in sub-workspaces and pop-outs.
//   SPACES_ROOT=<app tree> node test/spaces-edges.mjs [--keep]      screenshots: SPACES_SHOTS
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, sleep, waitFor, mouse, swipe, shot as shotOf } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, freshState, targets } from './spaces-lib.mjs';

const SHOTS = process.env.SPACES_SHOTS || path.join(USER_DATA, 'edges');
const KEEP = process.argv.includes('--keep');
const SW = [8, 18, 30, 42, 46, 40, 34, 28, 22, 18, 14, 11, 9, 7, 5, 4, 3, 2, 2, 1];
const q = JSON.stringify;
let c, V, oks = 0, fails = 0;
const ERRS = [];
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const shot = (name) => shotOf(c, path.join(SHOTS, `${name}.png`));
const box = (sel) => ev(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
/* The space on screen of a workspace: its view (pan in px at zoom 1, kept in px, or in % of the view once the workspace
   says panUnit '%') and its windows' x in %. */
const space = (id) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === ${q(id)}), sid = ws.at || null, zn = sid && ws.zones.find((z) => z.id === sid);
  const vw = document.getElementById('viewport').getBoundingClientRect().width;
  const vh = document.getElementById('viewport').getBoundingClientRect().height;
  return { at: sid, x: Math.round(ws.panUnit === '%' ? ((ws.pan || 0) / 100) * vw : ws.pan || 0), y: Math.round(ws.panUnit === '%' ? ((ws.panY || 0) / 100) * vh : ws.panY || 0), z: +(ws.zoom || 1).toFixed(3), roomLeft: (zn || ws).roomLeft || 0, roomRight: +((zn || ws).roomRight || 0).toFixed(2),
    wins: Object.fromEntries(ws.windows.filter((w) => (w.zone || null) === sid).map((w) => [w.id, +w.x.toFixed(2)])) }; })()`);
/* A space's extent: its windows' own box (% of the view), every room mark it keeps, and nav's sheet while nav has one. */
const extentOf = (id) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === ${q(id)}), sid = ws.at || null, zn = sid && ws.zones.find((z) => z.id === sid);
  const wins = ws.windows.filter((w) => (w.zone || null) === sid), r = (v) => +v.toFixed(2), nav = __flow.nav();
  const s = typeof nav.sheet === 'function' ? nav.sheet(ws) : null, holder = zn || ws;
  return { box: wins.length ? [r(Math.min(...wins.map((w) => w.x))), r(Math.min(...wins.map((w) => w.y))), r(Math.max(...wins.map((w) => w.x + w.w))), r(Math.max(...wins.map((w) => w.y + w.h)))] : null,
    marks: Object.fromEntries(Object.keys(holder).filter((k) => /^room/.test(k)).map((k) => [k, holder[k]])), sheet: s && { w: r(s.w), h: r(s.h) } }; })()`);
/* Each window of the space on screen: x, y, width and height in %, and x and y relative to the view (% of the view). */
const placed = (id) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === ${q(id)}), sid = ws.at || null, r = document.getElementById('viewport').getBoundingClientRect();
  const vx = ws.panUnit === '%' ? (ws.pan || 0) : ((ws.pan || 0) / r.width) * 100, vy = ws.panUnit === '%' ? (ws.panY || 0) : ((ws.panY || 0) / r.height) * 100;
  const one = (w, closed) => [w.id, { x: +w.x.toFixed(2), y: +w.y.toFixed(2), w: +w.w.toFixed(2), h: +w.h.toFixed(2), rel: +(w.x - vx).toFixed(2), relY: +(w.y - vy).toFixed(2), ...(closed ? { closed: true } : {}) }];
  return Object.fromEntries([...ws.windows.filter((w) => (w.zone || null) === sid).map((w) => one(w, false)), ...ws.closed.filter((w) => (w.zone || null) === sid && typeof w.x === 'number').map((w) => one(w, true))]); })()`);
const screens = () => ev(`Object.fromEntries([...document.querySelectorAll('.win')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => { const b = e.getBoundingClientRect(); return [e.dataset.id, [Math.round(b.left), Math.round(b.top)]]; }))`);
const onScreen = () => ev(`[...document.querySelectorAll('.win')].filter((e) => { const b = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return b.width && getComputedStyle(e).display !== 'none' && b.right > v.left + 1 && b.left < v.right - 1; }).map((e) => e.dataset.id).sort()`);
const nearly = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const glow = () => ev(`({ r: document.getElementById('edgeR').classList.contains('on'), l: document.getElementById('edgeL').classList.contains('on') })`);

/* ---------- a hand on the trackpad ---------- */
let px = 700, py = 400;
async function glide(x, y, n = 12, o = {}) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n, o); px = x; py = y; }
async function click(x, y) { await glide(x, y); await mouse(c, 'mousePressed', x, y); await mouse(c, 'mouseReleased', x, y); }
async function dbl(x, y) {
  await glide(x, y);
  for (const n of [1, 2]) {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n, pointerType: 'mouse' });
  }
}
/* A slow drag of the desktop by dx px, held still before the release so it does not glide. */
async function pan(dx) {
  for (let left = dx; Math.abs(left) > 0.5;) {
    const part = Math.sign(left) * Math.min(Math.abs(left), V.w * 0.7), n = Math.max(1, Math.ceil(Math.abs(part) / 60)), x0 = V.x + V.w * (part < 0 ? 0.9 : 0.1), y = V.y + 50;
    await glide(x0, y);
    await mouse(c, 'mousePressed', x0, y);
    for (let k = 1; k <= n; k++) { await mouse(c, 'mouseMoved', x0 + (part * k) / n, y, { down: true }); await sleep(16); }
    await sleep(150);
    await mouse(c, 'mouseReleased', x0 + part, y);
    px = x0 + part; py = y;
    await sleep(600);
    left -= part;
  }
}
/* The same up and down: a slow held drag of the desktop by dy px, pressed on bare desktop. */
async function panV(dy) {
  for (let left = dy; Math.abs(left) > 0.5;) {
    const part = Math.sign(left) * Math.min(Math.abs(left), V.h * 0.6), n = Math.max(1, Math.ceil(Math.abs(part) / 60));
    /* bare desktop to press on: near the top for a drag down, near the bottom for a drag up (never where the dock
       comes up), across the whole width and a few rows */
    const at = await ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), d = document.getElementById('dock').getBoundingClientRect(), down = ${part > 0};
      const rows = down ? [50, 90, 130, 170] : [60, 100, 140, 180];
      for (const r of rows) { const y = down ? v.top + r : v.bottom - r; for (let x = v.left + 40; x < v.right - 40; x += 10) { if (!down && x > d.left - 60 && x < d.right + 60) continue; const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) return { x, y }; } }
      return null; })()`);
    if (!at) throw new Error(`no bare desktop to press on for a drag ${part > 0 ? 'down' : 'up'}`);
    const x0 = at.x, y0 = at.y;
    await glide(x0, y0);
    await mouse(c, 'mousePressed', x0, y0);
    for (let k = 1; k <= n; k++) { await mouse(c, 'mouseMoved', x0, y0 + (part * k) / n, { down: true }); await sleep(16); }
    await sleep(150);
    await mouse(c, 'mouseReleased', x0, y0 + part);
    px = x0; py = y0 + part;
    await sleep(600);
    left -= part;
  }
}
async function pinch(dys) { const x = V.x + V.w / 2, y = V.y + V.h / 2; await glide(x, y); for (const dy of dys) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' }); await sleep(700); }
async function dock(kind) {
  await glide(V.x + V.w / 2, V.y + V.h - 6);
  await waitFor(() => ev(`getComputedStyle(document.getElementById('dock')).opacity === '1'`), 4000, 'the dock to come up');
  const b = await box(`#dock button[data-k="${kind}"]`);
  await click(b.cx, b.cy);
  await sleep(800);
  await glide(V.x + V.w / 2, V.y + V.h / 3);
}
/* A point of bare desktop in the strip at a side of the view (a window can cover part of it). */
const edgePoint = (side) => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), mb = document.querySelector('.menubar').getBoundingClientRect(), x = ${side === 'right' ? 'v.right - 8' : 'v.left + 8'};
  for (let y = v.top + v.height / 2, k = 0; k < 200; k++, y = v.top + v.height / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 4) { if (y <= mb.bottom + 2 || y >= v.bottom - 20) continue; const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) return { x, y }; }
  return null; })()`);
const rightEdge = () => edgePoint('right');
const leftEdge = () => edgePoint('left');
/* A point of bare desktop in the strip along the bottom of the view (outside the dock's rect) or just under the top bar. */
const rowPoint = (side) => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), mb = document.querySelector('.menubar').getBoundingClientRect(), d = document.getElementById('dock').getBoundingClientRect();
  const y = ${side === 'bottom' ? 'v.bottom - 8' : 'mb.bottom + 8'};
  for (let k = 0; k < 300; k++) { const x = v.left + v.width * 0.25 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 4; if (x <= v.left + 30 || x >= v.right - 30) continue; if (x > d.left - 12 && x < d.right + 12 && y > d.top - 12) continue; const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) return { x, y }; }
  return null; })()`);
const edgeAt = (side) => (side === 'right' ? rightEdge() : side === 'left' ? leftEdge() : rowPoint(side));
/* A new start on the safe seed (the console errors so far are kept), for a check that needs a space as it starts. */
async function fresh() {
  ERRS.push(...c.errors);
  c.close();
  await stop();
  await freshState();
  launch();
  c = await flowWindow();
  await sleep(2500);
}
async function restart() {
  ERRS.push(...c.errors);
  c.close();
  await stop({ keepTmux: true });
  launch();
  c = await flowWindow();
  await sleep(2500);
}

async function edges() {
  const pill = async (i) => { const p = await box(`.sp[data-i="${i}"] .sn`); await click(p.cx, p.cy); await sleep(700); };
  const idx = (id) => ev(`__flow.state().ws.findIndex((w) => w.id === ${q(id)})`);
  /* Back to x 0 by a drag of exactly the view's distance (a held drag does not glide). */
  const toStart = async (id) => { const s = await space(id); if (s.x) await pan(s.x * s.z); if (s.y) await panV(s.y * s.z); };
  /* Moves the view so that every window of the space lies past that side of it, 10% clear. */
  async function bringPast(id, side) {
    const s = await space(id), p = Object.values(await placed(id)), vx = (s.x / V.w) * 100, vy = (s.y / V.h) * 100, span = 100 / s.z;
    const minX = Math.min(...p.map((w) => w.x)), maxX = Math.max(...p.map((w) => w.x + w.w)), minY = Math.min(...p.map((w) => w.y)), maxY = Math.max(...p.map((w) => w.y + w.h));
    if (side === 'right') await pan(-(((minX - 10 - span) - vx) / 100) * V.w * s.z);
    if (side === 'left') await pan(-(((maxX + 10) - vx) / 100) * V.w * s.z);
    if (side === 'bottom') await panV(-(((minY - 10 - span) - vy) / 100) * V.h * s.z);
    if (side === 'top') await panV(-(((maxY + 10) - vy) / 100) * V.h * s.z);
  }
  /* A double-click at a side, then what moved: windows past that side must move one view on (100% at any zoom), the
     rest keep their places on screen, every coordinate stays >= 0, and the zoom stays. */
  async function push(id, side) {
    const s0 = await space(id), p0 = await placed(id), sc0 = await screens();
    const vx = (s0.x / V.w) * 100, vy = (s0.y / V.h) * 100, span = 100 / s0.z;
    const isPast = (w) => ({ right: w.x >= vx + span - 0.01, left: w.x + w.w <= vx + 0.01, bottom: w.y >= vy + span - 0.01, top: w.y + w.h <= vy + 0.01 })[side];
    const past = Object.keys(p0).filter((k) => isPast(p0[k]));
    const e = await edgeAt(side);
    if (!e) throw new Error(`no bare desktop at the ${side} edge`);
    await dbl(e.x, e.y);
    await sleep(800);
    const s1 = await space(id), p1 = await placed(id), sc1 = await screens();
    const [axis, sign] = { right: ['rel', 1], left: ['rel', -1], bottom: ['relY', 1], top: ['relY', -1] }[side];
    const pastMoved = past.every((k) => nearly(p1[k][axis] - p0[k][axis], sign * 100, 0.1));
    const restStill = Object.keys(p0).filter((k) => !past.includes(k) && sc0[k] !== undefined).every((k) => sc1[k] !== undefined && nearly(sc1[k][0], sc0[k][0], 1) && nearly(sc1[k][1], sc0[k][1], 1));
    const coordsOk = Object.values(p1).every((w) => w.x >= -0.01 && w.y >= -0.01);
    return { side, point: e, past, pastMoved, restStill, coordsOk, xsOk: coordsOk, zoomSame: s1.z === s0.z, view: [s0.x, s1.x], viewY: [s0.y, s1.y], moved: Object.fromEntries(past.map((k) => [k, [p0[k][axis], p1[k][axis]]])) };
  }

  const efI = await idx('ef');
  await pill(efI);
  const s0 = await space('ef'), x0 = await extentOf('ef');
  ok('ef starts at its left side with its 3 windows in one view, and no glow', s0.x === 0 && Object.keys(s0.wins).length === 3 && Math.max(...Object.values(s0.wins)) < 100 && !(await glow()).r && !(await glow()).l, s0);

  // not a target: e-term's body is in the strip at the right side of the view (a page window's body is its own web
  // page, whose double-clicks never reach Flow)
  const tb = await box('.win[data-id="e-term"]');
  const onWin = { x: tb.x + tb.w - 6, y: tb.y + tb.h * 0.6 }, away = { x: V.x + V.w * 0.5, y: V.y + 40 };
  const what = (p) => ev(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return !e ? null : e.closest('.win') ? e.closest('.win').dataset.id : e.matches('.canvas, .ws') ? 'desktop' : e.className; })()`);
  const hits = { onWin: await what(onWin), inStrip: onWin.x >= V.x + V.w - 24, away: await what(away) };
  await dbl(onWin.x, onWin.y);
  await sleep(600);
  await dbl(away.x, away.y);
  await sleep(600);
  ok('a double-click on a window at the edge, or on the desktop away from the edges, changes nothing', hits.onWin === 'e-term' && hits.inStrip && hits.away === 'desktop' && q(await space('ef')) === q(s0) && q(await extentOf('ef')) === q(x0), { hits, after: await space('ef') });

  // nothing past a side: the board already goes on there
  const tried = {}, pl0 = await placed('ef');
  for (const side of ['right', 'left', 'bottom', 'top']) {
    const e = await edgeAt(side);
    tried[side] = e;
    if (!e) continue;
    await dbl(e.x, e.y);
    await sleep(700);
  }
  ok('a double-click at any of the four edges with nothing past it changes nothing: the view, every window\'s x, y, w, h and the extent stay', Object.values(tried).every(Boolean) && q(await space('ef')) === q(s0) && q(await placed('ef')) === q(pl0) && q(await extentOf('ef')) === q(x0), { tried, view: await space('ef'), extent: await extentOf('ef') });

  // the top bar and the dock keep their own double-clicks
  const b0 = await space('ef'), bx0 = await extentOf('ef');
  const barPt = await ev(`(() => { const b = document.querySelector('.menubar').getBoundingClientRect(); for (let k = 0; k < 200; k++) { const x = b.left + b.width / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 4, e = document.elementFromPoint(x, b.top + b.height / 2); if (e && e.classList.contains('menubar')) return { x, y: b.top + b.height / 2 }; } return null; })()`);
  if (barPt) { await dbl(barPt.x, barPt.y); await sleep(700); }
  const nWin0 = await ev('__flow.state().ws.reduce((n, w) => n + w.windows.length, 0)');
  await glide(V.x + V.w / 2, V.y + V.h - 6);
  await waitFor(() => ev(`getComputedStyle(document.getElementById('dock')).opacity === '1'`), 4000, 'the dock to come up');
  const dockPt = await ev(`(() => { const d = document.getElementById('dock').getBoundingClientRect(); for (const x of [d.left + 3, d.right - 3]) { const e = document.elementFromPoint(x, d.top + d.height / 2); if (e && e.id === 'dock') return { x, y: d.top + d.height / 2 }; } return null; })()`);
  if (dockPt) { await dbl(dockPt.x, dockPt.y); await sleep(700); }
  const pillPt = await box('.sp.on .sn');
  await dbl(pillPt.cx, pillPt.cy);
  await sleep(500);
  const renaming = await ev(`(() => { const a = document.activeElement; return !!(a && a.isContentEditable && a.closest('#spaces')); })()`);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  ok('a double-click on a pill renames it, the bar\'s own double-click, and no space changes', renaming && q(await space('ef')) === q(b0) && q(await extentOf('ef')) === q(bx0), { renaming });
  ok('a double-click on the top bar or on the dock changes no space: both keep their own double-clicks', !!barPt && !!dockPt && q(await space('ef')) === q(b0) && q(await extentOf('ef')) === q(bx0) && (await ev('__flow.state().ws.reduce((n, w) => n + w.windows.length, 0)')) === nWin0, { barPt, dockPt, view: await space('ef') });
  await glide(V.x + V.w / 2, V.y + V.h / 3);

  // a free drag goes anywhere and stays there, and adds nothing
  await pan(-1.3 * V.w);
  let s = await space('ef');
  ok('a drag right goes into empty board past the windows and stays there; the extent is unchanged and the left glow points back', nearly(s.x, 1.3 * V.w, 3) && (await onScreen()).length === 0 && q(await extentOf('ef')) === q(x0) && (await glow()).l, { view: s.x, glow: await glow(), extent: await extentOf('ef') });
  await shot('01-free-drag-right');
  await pan(2.6 * V.w);
  s = await space('ef');
  ok('a drag left goes past the start of the space and stays there; the extent is unchanged and the right glow points back', nearly(s.x, -1.3 * V.w, 3) && (await onScreen()).length === 0 && q(await extentOf('ef')) === q(x0) && (await glow()).r, { view: s.x, glow: await glow(), extent: await extentOf('ef') });
  await pan(-2.6 * V.w);

  // a quit: the view comes back where it was left, out in empty board
  const left = await space('ef');
  await restart();
  s = await space('ef');
  ok('after a restart the view is where it was left, out in empty board, with the windows and the extent as they were', s.x === left.x && q(s.wins) === q(left.wins) && q(await extentOf('ef')) === q(x0), { before: left, after: s });

  // a window made out there grows the space to take it, and stays after a quit
  await dock('note');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const made = await space('ef'), newNote = Object.keys(made.wins).find((k) => !(k in s0.wins)), grown = await extentOf('ef');
  await restart();
  s = await space('ef');
  ok('a note made out in empty board grows the space to take it, and it and the view are there after a restart', !!newNote && made.wins[newNote] > 100 && grown.box[2] > x0.box[2] && nearly(s.wins[newNote], made.wins[newNote], 0.05) && s.x === made.x && q(await extentOf('ef')) === q(grown), { note: newNote && made.wins[newNote], extent: [x0, grown] });
  await toStart('ef');

  // pushing what lies past a side, at 100%, 30% and 250%
  const inI = await idx('infra');
  await pill(inI);
  let r = await push('infra', 'right');
  ok('a double-click at the right edge pushes what lies past it one view on; the rest and the view stay', r.past.length > 0 && r.pastMoved && r.restStill && r.zoomSame && r.view[0] === r.view[1], r);
  await pan(-(2 * V.w));
  r = await push('infra', 'left');
  ok('a double-click at the left edge pushes what lies before it one view further left; the rest keep their places on screen; x stays >= 0', r.past.length > 0 && r.pastMoved && r.restStill && r.xsOk && r.zoomSame, r);
  await toStart('infra');
  await push('infra', 'right');
  const zoomTo = async (z) => { const cur = (await ev(`__flow.state().ws.find((w) => w.id === __flow.state().ui.at).zoom || 1`)); await pinch([100 * Math.log(cur / z)]); };
  await zoomTo(0.3);
  r = await push('infra', 'right');
  ok('at 30%, the right edge pushes what lies past it exactly one view at actual size; the rest and the view stay', (await space('infra')).z <= 0.31 && r.past.length > 0 && r.pastMoved && r.restStill && r.view[0] === r.view[1], { zoom: (await space('infra')).z, ...r });
  await shot('02-zoom-30-push');
  await zoomTo(1);
  await zoomTo(2.5);
  const z250 = (await space('infra')).z;
  r = await push('infra', 'right');
  ok('at 250%, the right edge pushes what lies past it exactly one view at actual size; the rest and the view stay', nearly(z250, 2.5, 0.01) && r.past.length > 0 && r.pastMoved && r.restStill && r.view[0] === r.view[1], { zoom: z250, ...r });
  await shot('03-zoom-250-push');
  await zoomTo(1);
  await toStart('infra');

  // a window held at the left side at the start of the space grows it left: the edge pan and x >= 0 together shift the
  // coordinates, so the held window sits at the start and the others slide right together by what the space grew
  await fresh();
  await pill(await idx('mynotes'));
  const m0 = await placed('mynotes'), sc0 = await screens(), v0m = await space('mynotes'), tb0 = await box('.win[data-id="mn-note"] .tb');
  await glide(tb0.x + 60, tb0.cy);
  await mouse(c, 'mousePressed', tb0.x + 60, tb0.cy);
  await glide(V.x + 8, tb0.cy, 16, { down: true });
  await sleep(1500);
  await mouse(c, 'mouseReleased', V.x + 8, tb0.cy);
  await sleep(700);
  const m1 = await placed('mynotes'), sc1 = await screens(), v1m = await space('mynotes');
  const others = Object.keys(m0).filter((k) => k !== 'mn-note'), grewBy = others.map((k) => m1[k].x - m0[k].x);
  const viewShift = ((v1m.x - v0m.x) / V.w) * 100, together = grewBy.every((d) => nearly(d, grewBy[0], 0.05));
  const slid = others.every((k) => nearly(sc1[k][0] - sc0[k][0], ((grewBy[0] - viewShift) / 100) * V.w * v0m.z, 2));
  ok('a window held at the left side at the start of the space grows it left: the held window sits at the start, the others slide right together by what the space grew, and every x stays >= 0', grewBy[0] > 5 && together && slid && nearly(m1['mn-note'].x, 0, 0.05) && Object.values(m1).every((w) => w.x >= -0.01), { grewBy, viewShift: +viewShift.toFixed(2), held: [m0['mn-note'].x, m1['mn-note'].x], screens: [sc0, sc1] });
  await shot('04-held-at-the-left');
  // a window held at the top grows the space up the same way: the held window sits at the top, the others slide down
  // together by what the space grew, and every y stays >= 0
  await fresh();
  await pill(await idx('mynotes'));
  const u0 = await placed('mynotes'), us0 = await screens(), uv0 = await space('mynotes'), tb1 = await box('.win[data-id="mn-build"] .tb');
  await glide(tb1.x + 60, tb1.cy);
  await mouse(c, 'mousePressed', tb1.x + 60, tb1.cy);
  await glide(tb1.x + 60, V.y + 15, 16, { down: true });
  await sleep(1500);
  await mouse(c, 'mouseReleased', tb1.x + 60, V.y + 15);
  await sleep(700);
  const u1 = await placed('mynotes'), us1 = await screens(), uv1 = await space('mynotes');
  const below = Object.keys(u0).filter((k) => k !== 'mn-build' && !u0[k].closed), grewDown = below.map((k) => u1[k].y - u0[k].y);
  const viewShiftY = ((uv1.y - uv0.y) / V.h) * 100, togetherY = grewDown.every((d) => nearly(d, grewDown[0], 0.05));
  const slidY = below.every((k) => nearly(us1[k][1] - us0[k][1], ((grewDown[0] - viewShiftY) / 100) * V.h * uv0.z, 2));
  ok('a window held at the top side grows the space up: the held window sits at the top, the others slide down together by what the space grew, and every y stays >= 0', grewDown[0] > 5 && togetherY && slidY && u1['mn-build'].y <= Math.min(...below.map((k) => u1[k].y)) && Object.values(u1).every((w) => w.y >= -0.01), { grewDown, viewShiftY: +viewShiftY.toFixed(2), held: [u0['mn-build'].y, u1['mn-build'].y] });
  await shot('05-held-at-the-top');

  await fresh();
  await pill(await idx('mynotes'));

  // pushing what lies below or above, at 100%, 30% and 250%: the view's bottom (or top) is put in a gap between windows,
  // so some are past it and some stay on screen
  async function splitAt(id, side) {
    const s1 = await space(id), p = Object.values(await placed(id)), vy = (s1.y / V.h) * 100, span = 100 / s1.z;
    const ys = [...new Set(p.map((w) => w.y))].sort((a, b) => a - b);
    const g = ys.find((y) => p.some((w) => w.y >= y) && p.some((w) => w.y + w.h <= y) && p.every((w) => w.y >= y || w.y + w.h <= y));
    if (g === undefined) return null;
    const line = (Math.max(...p.filter((w) => w.y + w.h <= g).map((w) => w.y + w.h)) + g) / 2;
    const top = side === 'bottom' ? line - span : line;
    await panV(-((top - vy) / 100) * V.h * s1.z);
    return g;
  }
  for (const z of [1, 0.3, 2.5]) {
    if (z !== 1) { await zoomTo(1); await zoomTo(z); }
    const zz = (await space('mynotes')).z;
    if (z === 1) {
      // under the dock's box the dock wins: nothing moves, past or not
      await splitAt('mynotes', 'bottom');
      const d0 = await placed('mynotes'), dv0 = await space('mynotes');
      const dockBox = await box('#dock'), under = { x: dockBox.cx, y: V.y + V.h - 4 };
      const pastBelow = Object.keys(d0).filter((k) => d0[k].relY >= 100 - 0.01);
      await dbl(under.x, under.y);
      await sleep(800);
      ok('a double-click under the dock\'s box moves nothing, with windows below the view', pastBelow.length > 0 && q(await placed('mynotes')) === q(d0) && q(await space('mynotes')) === q(dv0), { under, pastBelow });
      // a corner counts as the left or right side: from this view, where the lower windows lie past the bottom, the view
      // is moved sideways so the view's right side falls between them and a window further right
      const k0 = await placed('mynotes'), ks0 = await space('mynotes'), spanK = 100 / ks0.z;
      const lower = Object.keys(k0).filter((k) => !k0[k].closed && k0[k].relY >= spanK - 0.01), upper = Object.keys(k0).filter((k) => !k0[k].closed && !lower.includes(k));
      const maxLow = Math.max(...lower.map((k) => k0[k].x)), maxUp = Math.max(...upper.map((k) => k0[k].x));
      if (lower.length && upper.length && maxUp > maxLow) await pan(-((((maxLow + maxUp) / 2 - spanK) - (ks0.x / V.w) * 100) / 100) * V.w * ks0.z);
      const c0 = await placed('mynotes'), cs0 = await space('mynotes'), span = 100 / cs0.z, vxl = (cs0.x / V.w) * 100;
      const pastRight = Object.keys(c0).filter((k) => c0[k].x >= vxl + span - 0.01), pastBottom = Object.keys(c0).filter((k) => c0[k].relY >= span - 0.01);
      const corner = await ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (const k of [8, 6, 4, 10, 14]) { const e = document.elementFromPoint(v.right - k, v.bottom - k); if (e && e.matches('.canvas, .ws')) return { x: v.right - k, y: v.bottom - k }; } return null; })()`);
      if (corner) { await dbl(corner.x, corner.y); await sleep(800); }
      const c1 = await placed('mynotes');
      const onlyBottom = pastBottom.filter((k) => !pastRight.includes(k));
      ok('a double-click in the bottom-right corner counts as the right side: what lies past the right moves one view right, nothing moves down', !!corner && pastRight.length > 0 && onlyBottom.length > 0 && pastRight.every((k) => nearly(c1[k].rel - c0[k].rel, 100, 0.1)) && Object.keys(c0).every((k) => nearly(c1[k].relY, c0[k].relY, 0.05)) && onlyBottom.every((k) => nearly(c1[k].rel, c0[k].rel, 0.05)), { corner, pastRight, pastBottom });
      await toStart('mynotes');
    }
    for (const side of ['bottom', 'top']) {
      const g = await splitAt('mynotes', side);
      const rr = g == null ? { gap: null } : await push('mynotes', side);
      const rest = rr.past ? Object.keys(await placed('mynotes')).length - rr.past.length : 0;
      ok(`at ${Math.round(z * 100)}%, the ${side} edge pushes what lies ${side === 'bottom' ? 'below' : 'above'} it exactly one view at actual size; the rest stay on screen; every coordinate stays >= 0`, nearly(zz, z, 0.01) && g != null && rr.past.length > 0 && rest > 0 && rr.pastMoved && rr.restStill && rr.coordsOk && rr.zoomSame, { zoom: zz, gap: g, ...rr });
    }
    await zoomTo(1);
    await toStart('mynotes');
  }

  // in a sub-workspace: research only
  const p0 = await box('.sp[data-i="0"] .sn');
  await click(p0.cx, p0.cy);
  await sleep(700);
  const bx = V.x + V.w * 0.45, by = V.y + 45;
  await glide(bx, by);
  /* the swipe lands when it is let go, seconds after the wheels on a loaded machine: wait until the page has had all
     of its travel (Chromium merges wheels, keeping their sum), then until the space has stayed the same for 2 s */
  await ev(`(() => { window.__wheelSum = 0; addEventListener('wheel', (e) => { window.__wheelSum += e.deltaX; }, { capture: true, passive: true }); return true; })()`);
  await swipe(c, bx, by, SW);
  const sent = SW.reduce((a, d) => a + d, 0);
  for (let k = 0; k < 150 && Math.abs((await ev('window.__wheelSum')) - sent) > 0.5; k++) await sleep(100);
  for (let last = (await space('flow')).at, since = Date.now(), t0 = since; Date.now() - since < 2000 && Date.now() - t0 < 10000;) { await sleep(100); const now = (await space('flow')).at; if (now !== last) { last = now; since = Date.now(); } }
  const mainOf = () => ev(`__flow.state().ws[0].windows.filter((w) => !w.zone).map((w) => [+w.x.toFixed(2), +w.y.toFixed(2)])`);
  for (const side of ['right', 'left', 'bottom', 'top']) {
    const main0 = await mainOf();
    await bringPast('flow', side);
    r = await push('flow', side);
    const main1 = await mainOf();
    ok(`in research a double-click at the ${side} edge pushes research's windows past it one view on, and the main space does not change`, (await space('flow')).at === 'z-research' && r.past.length > 0 && r.pastMoved && r.coordsOk && q(main0) === q(main1), { push: r, main: [main0, main1] });
    await toStart('flow');
  }

  // a pop-out opened mid-session changes no space's view or extent, here or on disk
  const allViews = (list) => Object.fromEntries(list.flatMap((w) => [[w.id, [w.pan || 0, w.panY || 0, w.zoom || 1, w.mainPan || 0, w.mainZoom || 1]], ...(w.zones || []).map((z) => [`${w.id}/${z.id}`, [z.pan || 0, z.panY || 0, z.zoom || 1]])]));
  const k0 = allViews(await ev('__flow.state().ws'));
  const pf = await box('.sp[data-i="0"] .sn');
  await click(pf.cx, pf.cy);
  await sleep(700);
  const kA = allViews(await ev('__flow.state().ws'));
  const zrow = await box('#sblist .tr[data-act="zone|z-research"]');
  await glide(zrow.x + 60, zrow.cy);
  await sleep(300);
  const zpop = await box('#sblist .tr[data-act="zone|z-research"] [data-zpop]');
  await click(zpop.cx, zpop.cy);
  await waitFor(async () => (await targets()).some((t) => t.type === 'page' && /zone=z-research/.test(t.url)), 15000, 'the pop-out');
  await sleep(3000);
  const k1 = allViews(await ev('__flow.state().ws')), kDisk = allViews(JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8')).ws);
  ok('opening a pop-out keeps every space\'s own view, in the main window and on disk', Object.keys(kA).length >= 5 && q(k1) === q(kA) && q(kDisk) === q(kA), { before: kA, afterPopout: k1, onDisk: kDisk, first: k0 });
  const rooms = await ev(`__flow.state().ws.flatMap((w) => [[w.id, Object.keys(w).filter((k) => /^room/.test(k))], ...(w.zones || []).map((z) => [w.id + '/' + z.id, Object.keys(z).filter((k) => /^room/.test(k))])]).filter(([, ks]) => ks.length)`);
  const roomsOnDisk = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8')).ws.flatMap((w) => [[w.id, Object.keys(w).filter((k) => /^room/.test(k))], ...(w.zones || []).map((z) => [w.id + '/' + z.id, Object.keys(z).filter((k) => /^room/.test(k))])]).filter(([, ks]) => ks.length);
  ok('no room is ever stored: no space, here or on disk, keeps a room mark', rooms.length === 0 && roomsOnDisk.length === 0, { rooms, roomsOnDisk });
  const pt = (await targets()).find((t) => t.type === 'page' && /zone=z-research/.test(t.url));
  /* The pop-out closes itself; its connection may close before the answer comes, which is the only error expected. */
  if (pt) { const pc = await Cdp.connect(pt.webSocketDebuggerUrl); await pc.send('Runtime.evaluate', { expression: 'window.close()' }).catch((err) => { if (!/connection closed/.test(err.message)) throw err; }); pc.close(); await sleep(1500); }
}

async function main() {
  await stop();
  await freshState();
  fs.rmSync(SHOTS, { recursive: true, force: true });
  launch();
  try {
    c = await flowWindow();
    V = await box('#viewport');
    console.log(`app: ${ROOT}, viewport ${Math.round(V.w)}x${Math.round(V.h)}`);
    try { await edges(); } catch (err) { ok('the checks ran to the end', false, err.message); await shot('fail').catch((e) => console.log(`no screenshot of the failure: ${e.message}`)); }
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




