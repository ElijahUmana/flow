// flows: batch 3 in the owner's day, with real input, on the tree in FLOWS_APP (a copy) or ~/flow: a pinch out until the
// whole workspace shows and back to 100%, far-out titles, going to a window from far out, a dock button carried to a
// spot, into a gap and to the right side, the overview at the bottom right, and a quit. Shell-only seed (no claude).
// node test/flows-day3.mjs [label]     FLOWS_ONLY=Z1,D1 runs only those checks (each needs the ones before it in its group)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from './flows-lib.mjs';

const label = process.argv[2] || 'day3';
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`);
let page = null;
const ev = (e) => L.ev(page, e);
const res = [];
const verdict = (id, line, ok, detail) => { res.push({ id, ok }); log(`${ok === true ? 'ok  ' : ok === false ? 'BAD ' : 'ERR '} ${id} ${line}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const ONLY = process.env.FLOWS_ONLY ? process.env.FLOWS_ONLY.split(',') : null;
async function check(id, line, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  try { const [ok, detail] = await fn(); verdict(id, line, ok, detail); } catch (e) { verdict(id, line, null, e.message.split('\n')[0]); if (page) { try { log('     shot', await L.shot(page, `${label}-err-${id}`)); } catch (_) { /* gone */ } } }
}
const ids = () => ev(`window.__flow.windows().map((w) => w.id)`);
const newWins = async (before) => (await ids()).filter((w) => !before.includes(w));
async function pill(i) { await L.pointClick(page, `#spaces .sp[data-i="${i}"] .sn`); await L.sleep(900); }
const emptySpot = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), top = document.querySelector('.menubar').getBoundingClientRect().bottom + 8; for (let y = top + 40; y < v.bottom - 140; y += 20) for (let x = v.left + 40; x < v.right - 60; x += 20) { const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) return { x, y }; } return null; })()`);
/* the space on screen: zoom and pan from the state, the viewport, and its windows on screen (share of each in view) */
const view = () => ev(`(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), zn = ws.at && (ws.zones || []).find((z) => z.id === ws.at), o = zn || ws; const v = document.getElementById('viewport').getBoundingClientRect();
  const wins = ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).map((w) => { const e = document.querySelector('.win[data-id="' + w.id + '"]'); if (!e) return [w.id, 0]; const r = e.getBoundingClientRect(); const a = Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left)) * Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)); return [w.id, +(a / Math.max(1, r.width * r.height)).toFixed(2)]; });
  return { ws: ws.id, zoom: o.zoom || 1, pan: Math.round(${L.PANPX}(ws, o, 'x')), panY: Math.round(${L.PANPX}(ws, o, 'y')), vp: { x: v.left, y: v.top, w: v.width, h: v.height, r: v.right, b: v.bottom }, wins: Object.fromEntries(wins) }; })()`);
const sheet = () => ev(`(() => { const sec = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"]'), e = sec && sec.querySelector('.zshade'), v = document.getElementById('viewport').getBoundingClientRect(); if (!e || e.style.display === 'none') return { on: false }; const b = e.getBoundingClientRect(), a = +(/rgba\\(0, 0, 0, ([0-9.]+)\\)/.exec(getComputedStyle(e).boxShadow) || [0, 0])[1]; return { on: a > 0, shade: a, x: +(b.left - v.left).toFixed(1), y: +(b.top - v.top).toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), vw: +v.width.toFixed(1), vh: +v.height.toFixed(1) }; })()`);
/* far-out titles: inside each window over its top edge (zoom's fix, nav.js a639d549), or the older box above them */
const titles = () => ev(`(() => { const c = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"] .canvas'); if (!c) return []; const inWin = [...c.querySelectorAll(':scope > .win > .ztitle')].filter((e) => e.style.opacity === '1' && e.parentElement.style.display !== 'none').map((e) => [e.parentElement.dataset.id, e.textContent]); if (inWin.length) return inWin; const b = c.querySelector('.ztitles'); if (!b || b.style.opacity !== '1') return []; return [...b.children].map((e) => [e.dataset.id, e.textContent]); })()`);
const ov = () => ev(`(() => { const el = document.querySelector('.ov'); if (!el) return null; const cs = getComputedStyle(el), r = el.getBoundingClientRect(), box = (e) => { if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; }; return { up: cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.5, x: r.left, y: r.top, w: r.width, h: r.height, shapes: [...el.querySelectorAll('i')].map(box), frame: box(el.querySelector('u')) }; })()`);
const keysIn = () => ev(`(() => { const a = document.activeElement, w = a && a.closest && a.closest('.win'); return w ? w.dataset.id : null; })()`);
const frontId = () => ev(`(() => { const sec = document.querySelector('.ws[data-id="' + __flow.state().ui.at + '"]'), f = sec && sec.querySelector('.win.front'); return f ? f.dataset.id : null; })()`);
let px = 0, py = 0;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) { await L.mouse(page, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); await L.sleep(16); } px = x; py = y; }
/* a pinch the way a trackpad sends it: ctrl-wheel events 16 ms apart; then until the zoom and pan stay put */
async function pinch(x, y, dys) {
  const t0 = Date.now();
  for (let i = 0; i < dys.length; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dys[i], modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * 16) / 1000 });
  px = x; py = y;
  let last = '', same = 0;
  for (let i = 0; i < 40 && same < 3; i++) { await L.sleep(300); const v = await view(); const k = `${v.zoom}|${v.pan}|${v.panY}`; same = k === last ? same + 1 : 0; last = k; }
}
/* the dock comes up the way a hand brings it (to the bottom middle); then one of its buttons is pressed, carried to x, y
   and let go; what the outline shows is read while it is held */
const outline = () => ev(`(() => { const g = [...document.getElementById('viewport').children].find((e) => e.style.borderStyle === 'dashed' || /dashed/.test(e.style.border)); if (!g || g.style.display === 'none') return null; const r = g.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function carry(kind, x, y) {
  const d = await ev(`(() => { const r = document.getElementById('dock').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 7 }; })()`);
  await glide(d.x, d.y, 12);
  await L.sleep(400);
  const b = await ev(`(() => { const d = document.getElementById('dock'), b = d.querySelector('button[data-k="${kind}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: +getComputedStyle(d).opacity > 0.9 && d.style.pointerEvents !== 'none' }; })()`);
  if (!b || !b.shown) throw new Error(`the dock did not come up with a ${kind} button`);
  await glide(b.x, b.y, 4);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let k = 1; k <= 24; k++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + ((x - b.x) * k) / 24, y: b.y + ((y - b.y) * k) / 24, button: 'left', buttons: 1, pointerType: 'mouse' }); await L.sleep(16); }
  await L.sleep(200);
  const seen = await outline();
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  px = x; py = y;
  await L.sleep(900);
  return seen;
}
const geo = (id) => ev(`(() => { for (const ws of window.__flow.state().ws) { const w = ws.windows.find((x) => x.id === ${JSON.stringify(id)}); if (w) return { x: +w.x.toFixed(1), y: +w.y.toFixed(1), w: +w.w.toFixed(1), h: +w.h.toFixed(1), type: w.type }; } return null; })()`);
const screenRect = (id) => ev(`(() => { const e = document.querySelector('.win[data-id="${id}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);

/* ---------- start: the shell-only seed (no claude), as the model check ---------- */
log('tree:', L.APP, spawnSync('sh', ['-c', `cd ${L.APP} && md5sum src/*.js src/index.html | cut -c1-8,33- | tr "\\n" " "`], { encoding: 'utf8' }).stdout);
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
const seedRun = spawnSync('node', [path.join(L.ROOT, 'test/flows-seed.mjs')], { encoding: 'utf8', cwd: L.ROOT, env: process.env });
if (seedRun.status) throw new Error(`seed failed: ${seedRun.stderr}`);
{
  const f = path.join(L.UD, 'flow-state.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const ws of st.ws) for (const w of [...ws.windows, ...(ws.closed || [])]) if (w.cmd === 'claude') { w.cmd = 'shell'; delete w.sessionId; }
  fs.writeFileSync(f, JSON.stringify(st));
}
fs.rmSync(path.join(L.UD, 'Preferences'), { force: true });
await L.launch(`${label}-1`);
page = await L.connect();
await L.until(page, 'window.__flow && 1', 30000);
await ev('window.__flow.ready');
await L.sleep(3000);
const S = {};

/* ---------- a pinch out shows more, back to 100% (owner 22:27, OWNER_ASKS.md:302; approved, :352) ---------- */
await check('Z1', 'pinching out shows more the further it goes, until the whole workspace is on screen as a sheet on a darker backdrop', async () => {
  await pill(0);
  S.start = await view();
  // a second view of room at the right (batch 2's edge double-click), so the space is wider than the view
  const v = S.start.vp;
  await L.dblclick(page, v.r - 6, v.y + v.h / 2);
  await L.sleep(1000);
  const p = await emptySpot();
  if (!p) throw new Error('no empty desktop to pinch on');
  const zs = [];
  for (let i = 0; i < 12; i++) { await pinch(p.x, p.y, Array(4).fill(8)); zs.push((await view()).zoom); if (i >= 2 && zs[i] === zs[i - 1] && zs[i - 1] === zs[i - 2]) break; }
  const s = await sheet(), v1 = await view();
  const offScreen = Object.entries(v1.wins).filter(([, a]) => a < 1).map(([id]) => id);
  const inView = s.on && s.x >= -1 && s.y >= -1 && s.x + s.w <= s.vw + 1 && s.y + s.h <= s.vh + 1;
  const drops = zs.slice(0, zs.indexOf(zs[zs.length - 1]) + 1);
  S.far = v1.zoom;
  log('     shot', await L.shot(page, `${label}-z1-far-out`));
  return [drops.every((z, i) => i === 0 || z < drops[i - 1]) && zs[zs.length - 1] < 1 && inView && offScreen.length === 0, { zooms: zs.map((z) => +z.toFixed(3)), sheet: s, windowsNotFullyOnScreen: offScreen }];
});
await check('Z2', 'far out (below 50%), each window shows its title once, plainly', async () => {
  const v = await view(), t = await titles();
  const n = Object.keys(v.wins).length;
  return [v.zoom < 0.5 && n > 0 && t.length === n && t.every(([, text]) => text.trim().length > 0), { zoom: +v.zoom.toFixed(3), windows: n, titles: t }];
});
await check('Z3', 'pinching back rests at 100%, with the workspace back in place', async () => {
  const p = await emptySpot();
  // one pinch that would end at 108% on its own: it rests at 100% on the way
  const total = 100 * Math.log(S.far / 1.08);
  await pinch(p.x, p.y, Array(10).fill(total / 10));
  await L.sleep(800);
  const v = await view();
  const cut = Object.entries(S.start.wins).filter(([id, a]) => a === 1 && (v.wins[id] || 0) < 1).map(([id]) => id);
  log('     shot', await L.shot(page, `${label}-z3-back`));
  return [v.zoom === 1 && cut.length === 0, { zoom: v.zoom, pan: [S.start.pan, v.pan], fullyInViewBeforeButNotNow: cut }];
});
await check('Z4', 'from far out, a click on a sidebar row zooms back in to that window, ready to type', async () => {
  const p = await emptySpot();
  await pinch(p.x, p.y, Array(10).fill(12));
  const far = (await view()).zoom;
  const r = await ev(`(() => { const el = [...document.querySelectorAll('#sblist .tr')].find((x) => /this week/.test(x.innerText)); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error('no "this week" row');
  await glide(r.x, r.y, 8);
  await L.click(page, r.x, r.y);
  await L.sleep(1500);
  const v = await view(), keys = await keysIn();
  return [far < 0.7 && v.zoom === 1 && v.wins['w-week'] === 1 && keys === 'w-week', { far: +far.toFixed(3), zoom: v.zoom, inView: v.wins['w-week'], keys }];
});

/* ---------- a new note, agent or page exactly where the owner wants it (owner 23:45, OWNER_ASKS.md:326; approved, :362) ---------- */
await check('D1', 'a dock button carried to an open spot: an outline follows the hand, and the new note opens right there, ready to type', async () => {
  const p = await emptySpot();
  if (!p) throw new Error('no open spot in view');
  const before = await ids();
  const seen = await carry('note', p.x, p.y);
  const made = await newWins(before);
  const r = made.length === 1 ? await screenRect(made[0]) : null;
  const keys = await keysIn();
  log('     shot', await L.shot(page, `${label}-d1-carried-note`));
  return [!!seen && made.length === 1 && !!r && Math.abs(r.x - seen.x) < 3 && Math.abs(r.y - seen.y) < 3 && keys === made[0], { outline: seen, made, at: r, keys }];
});
await check('D2', 'dropped in the gap between two windows side by side, room is made: the right one slides over and nothing overlaps', async () => {
  const pair = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === st.ui.at); const v = document.getElementById('viewport').getBoundingClientRect(); const pan = ${L.PANPX}(ws, null, 'x'); const vis = ws.windows.filter((w) => !w.zone && document.querySelector('.win[data-id="' + w.id + '"]')); for (const a of vis) for (const b of vis) { if (a === b) continue; const gap = b.x - (a.x + a.w); const top = Math.max(a.y, b.y), bot = Math.min(a.y + a.h, b.y + b.h); if (!(gap > 0.3 && gap < 3 && bot - top > 10)) continue; const x = a.x + a.w + gap / 2, px = v.left + (x / 100) * v.width - pan; if (px < v.left + 20 || px > v.right - 40) continue; for (let y = top + 2; y < bot - 2; y += 2) { const py = v.top + (y / 100) * v.height; const e = document.elementFromPoint(px, py); if (e && !e.closest('.win, #dock, .ctx, .toast')) return { a: a.id, b: b.id, gap, px, py, bx: b.x }; } } return null; })()`);
  if (!pair) throw new Error('no bare gap between two windows side by side in view');
  const before = await ids();
  const seen = await carry('note', pair.px, pair.py);
  const made = await newWins(before);
  const a = await geo(pair.a), b = await geo(pair.b), n = made.length === 1 ? await geo(made[0]) : null;
  const overlap = (p, q) => p && q && p.x < q.x + q.w - 0.05 && q.x < p.x + p.w - 0.05 && p.y < q.y + q.h - 0.05 && q.y < p.y + p.h - 0.05;
  log('     shot', await L.shot(page, `${label}-d2-gap`));
  return [!!seen && !!n && b.x > pair.bx + 1 && n.x >= a.x + a.w - 0.1 && n.x + n.w <= b.x + 0.1 && !overlap(n, a) && !overlap(n, b), { pair, outline: seen, left: a, newNote: n, right: b }];
});
await check('D3', 'carried to the right side, the new page opens at the end of the space and the view stays', async () => {
  const v0 = await view();
  const before = await ids();
  const seen = await carry('page', v0.vp.r - 10, v0.vp.y + v0.vp.h * 0.4);
  const made = await newWins(before);
  const v1 = await view();
  const ends = await ev(`(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at); return ws.windows.filter((w) => !w.zone).map((w) => [w.id, +(w.x + w.w).toFixed(1)]); })()`);
  const n = made.length === 1 ? await geo(made[0]) : null;
  const lastEnd = Math.max(...ends.filter(([id]) => id !== made[0]).map(([, e]) => e));
  S.end = made[0];
  log('     shot', await L.shot(page, `${label}-d3-at-the-end`));
  return [!!seen && !!n && n.type === 'page' && n.x >= lastEnd - 0.1 && v1.pan === v0.pan && v1.zoom === v0.zoom, { outline: seen, newPage: n, lastEndBefore: lastEnd, pan: [v0.pan, v1.pan] }];
});

/* ---------- the overview at the bottom right (owner 23:40, OWNER_ASKS.md:317; approved, :361) ---------- */
await check('O1', 'with part of the space off screen, the pointer at the bottom right brings up a map of it: windows as shapes, a frame for the view', async () => {
  const v = await view();
  if (Object.values(v.wins).every((a) => a === 1)) throw new Error('the whole space is on screen, so the map has nothing to show');
  await glide(v.vp.r - 80, v.vp.b - 8, 12);
  await L.sleep(600);
  const o = await ov();
  S.ov = o;
  log('     shot', await L.shot(page, `${label}-o1-map`));
  return [!!o && o.up && Object.keys(v.wins).length > 0 && o.shapes.length === Object.keys(v.wins).length && !!o.frame, { map: o && { up: o.up, shapes: o.shapes.length, frame: o.frame }, windows: Object.keys(v.wins).length }];
});
await check('O2', 'a click on a part of the map takes the view to that part of the workspace', async () => {
  const o = S.ov;
  if (!o || !o.up) throw new Error('no map up');
  const v0 = await view();
  // the far right of the map, where the new page and the room are
  await glide(o.x + o.w - 6, o.y + o.h / 2, 4);
  await L.click(page, o.x + o.w - 6, o.y + o.h / 2);
  await L.sleep(1500);
  const v1 = await view();
  return [v1.pan > v0.pan && (v1.wins[S.end] || 0) > 0.5, { pan: [v0.pan, v1.pan], newPageInView: v1.wins[S.end] }];
});
await check('O3', "a click on a window's shape goes to that window: in view and in front", async () => {
  const o = await ov();
  if (!o || !o.up) throw new Error('the map went away');
  const left = o.shapes.reduce((m, s) => (!m || s.x < m.x ? s : m), null);
  const target = await ev(`(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at); return ws.windows.filter((w) => !w.zone).reduce((m, w) => (!m || w.x < m.x ? w : m), null).id; })()`);
  await glide(left.x + left.w / 2, left.y + left.h / 2, 4);
  await L.click(page, left.x + left.w / 2, left.y + left.h / 2);
  await L.sleep(1500);
  const v = await view(), f = await frontId();
  return [(v.wins[target] || 0) === 1 && f === target, { target, inView: v.wins[target], front: f }];
});
await check('O4', 'the map never shows by itself: not on a drag of the desktop, a two-finger swipe or a workspace switch', async () => {
  const seen = [];
  const watch = async (what, fn) => { let up = 0, run = true; const t = (async () => { while (run) { const o = await ov(); if (o && o.up) up++; await L.sleep(40); } })(); await fn(); await L.sleep(500); run = false; await t; seen.push([what, up]); };
  const v = await view();
  const p = await emptySpot();
  await glide(p.x, p.y, 8);
  // the pointer has left the map (O3): it goes first; how long that takes is part of the result
  const t0 = Date.now();
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) { const o = await ov(); gone = !o || !o.up; if (!gone) await L.sleep(40); }
  seen.push(['goneAfterLeavingMs', gone ? Date.now() - t0 : 'still up after 2 s']);
  await watch('drag', async () => { await L.mouse(page, 'mousePressed', p.x, p.y); const t0 = Date.now(); for (let k = 1; k <= 12; k++) await L.mouse(page, 'mouseMoved', p.x - k * 25, p.y, { down: true, at: t0 + k * 12 }); await L.mouse(page, 'mouseReleased', p.x - 300, p.y, { at: t0 + 13 * 12 }); px = p.x - 300; await L.sleep(900); });
  await watch('swipe', async () => { const t0 = Date.now(); for (let k = 0; k < 10; k++) await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: v.vp.x + v.vp.w / 2, y: v.vp.y + v.vp.h / 2, deltaX: 60, deltaY: 0, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + k * 16) / 1000 }); await L.sleep(900); });
  await watch('switch', async () => { await pill(1); await pill(0); });
  return [gone && seen.filter(([k]) => k !== 'goneAfterLeavingMs').every(([, up]) => up === 0), Object.fromEntries(seen)];
});

/* ---------- nothing moves under the pointer (STATUS.md:283; backlog's ⤢ fix for batch 3) ---------- */
await check('B1', 'after a click on a pill, + stays where it was seen: a click there makes a new workspace', async () => {
  // flow's main space (a swipe may have left it in a sub-workspace, whose pill reads "flow › name")
  await pill(0);
  if (await ev(`!!window.__flow.state().ws.find((w) => w.id === 'flow').at`)) await pill(0);
  // at rest: the pointer on the desktop, no pill under it
  const d = await emptySpot();
  await glide(d.x, d.y, 8);
  await L.sleep(300);
  const rest = await ev(`(() => { const p = document.getElementById('addws').getBoundingClientRect(); return { plus: Math.round(p.left + p.width / 2), pills: [...document.querySelectorAll('#spaces .sp[data-i]')].map((e) => Math.round(e.getBoundingClientRect().width)) }; })()`);
  const sn = await L.rect(page, '#spaces .sp[data-i="0"] .sn');
  await glide(sn.cx, sn.cy, 8);
  await L.click(page, sn.cx, sn.cy);
  await L.sleep(900);
  const plus = await L.rect(page, '#addws');
  // the hovered pill: its name, its ⤢ and its right side
  const hov = await ev(`(() => { const p = document.querySelector('#spaces .sp[data-i="0"]'), n = p.querySelector('.sn').getBoundingClientRect(), o = p.querySelector('.pop'), q = o && o.getBoundingClientRect(), r = p.getBoundingClientRect(); return { nameRight: Math.round(n.right), popLeft: q && q.width ? Math.round(q.left) : null, popRight: q && q.width ? Math.round(q.right) : null, pillRight: Math.round(r.right) }; })()`);
  const n0 = await ev(`document.querySelectorAll('#spaces .sp[data-i]').length`);
  await glide(plus.cx, plus.cy, 10);
  const plusAtClick = await L.rect(page, '#addws');
  await L.click(page, plus.cx, plus.cy);
  await L.sleep(700);
  const n1 = await ev(`document.querySelectorAll('#spaces .sp[data-i]').length`);
  if (n1 > n0) { await L.key(page, 'Enter'); await L.sleep(400); }
  return [n1 === n0 + 1, { pills: [n0, n1], plusAtRest: rest.plus, pillWidthsAtRest: rest.pills, plusSeenWithPillHovered: Math.round(plus.cx), plusAtClick: Math.round(plusAtClick.cx), hoveredPill: hov }];
});

/* ---------- a quit: the zoom comes back (principle 5, OWNER_ASKS.md:43) ---------- */
await check('Q1', 'after a quit, the space comes back at the zoom it was left at', async () => {
  await pill(0);
  const p = await emptySpot();
  await pinch(p.x, p.y, Array(4).fill(8));
  const z0 = (await view()).zoom;
  page.ws.close();
  page = null;
  log(await L.stop());
  await L.sleep(1000);
  await L.launch(`${label}-2`);
  page = await L.connect();
  await L.until(page, 'window.__flow && 1', 30000);
  await ev('window.__flow.ready');
  await L.sleep(3000);
  const z1 = (await view()).zoom;
  log('     shot', await L.shot(page, `${label}-q1-after-quit`));
  return [z0 < 1 && Math.abs(z1 - z0) < 0.001, { before: +z0.toFixed(4), after: +z1.toFixed(4) }];
});

if (page) { const errs = page.errors.filter((e) => !/favicon|ERR_ABORTED/.test(e)); if (errs.length) log('page errors:', errs.slice(0, 8).join(' | ')); page.ws.close(); }
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
const n = (v) => res.filter((r) => r.ok === v).length;
log(`summary: ${n(true)} ok, ${n(false)} BAD, ${n(null)} ERR`);
// a BAD or an ERR fails the run
process.exitCode = n(true) > 0 && n(false) + n(null) === 0 ? 0 : 1;




