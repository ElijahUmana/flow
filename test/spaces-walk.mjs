// spaces' walk of a day with workspaces and sub-workspaces, with real input over CDP (pointer paths in small steps,
// HTML5 drags handed over by Chromium as the sidebar's own test does, wheel swipes, three-finger swipes emitted in main).
// Each check is a principle from OWNER_ASKS.md. Runs spaces' own isolated app from SPACES_ROOT (default: this repo) on
// the safe seed (spaces-lib.mjs: shells only, port 9575, socket flow-dev-spaces).
//   SPACES_ROOT=<app tree> node test/spaces-walk.mjs [--keep]      screenshots: SPACES_SHOTS (default /tmp/flow-dev-spaces/walk)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sleep, waitFor, mouse, swipe, shot as shotOf } from './nav-lib.mjs';
import { ROOT, USER_DATA, SOCKET, launch, stop, flowWindow, mainProcess, targets, freshState } from './spaces-lib.mjs';

const SHOTS = process.env.SPACES_SHOTS || path.join(USER_DATA, 'walk');
const KEEP = process.argv.includes('--keep');
const SW = [8, 18, 30, 42, 46, 40, 34, 28, 22, 18, 14, 11, 9, 7, 5, 4, 3, 2, 2, 1];
const q = JSON.stringify;
let c, m, oks = 0, fails = 0;
const ERRS = [];
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const shot = (name, on = c) => shotOf(on, path.join(SHOTS, `${name}.png`));
const box = (sel) => ev(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const flowWs = () => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === 'flow'); return { at: ws.at || null, zones: ws.zones.map((z) => ({ id: z.id, name: z.name })), wins: ws.windows.map((w) => ({ id: w.id, zone: w.zone || null })) }; })()`);
const at = () => ev('__flow.state().ui.at');
const pill = () => ev(`document.querySelector('.sp.on') ? document.querySelector('.sp.on').textContent.replace('⤢', '') : null`);
const editing = () => ev(`(() => { const a = document.activeElement; return a && a.isContentEditable ? { cls: a.className, text: a.textContent, inPill: !!a.closest('#spaces') } : null; })()`);
const pages = async () => (await targets()).filter((t) => t.type === 'page').map((t) => t.url.replace(/^.*index\.html/, 'main'));

/* ---------- a hand on the trackpad ---------- */
let px = 700, py = 400;
async function glide(x, y, n = 14, o = {}) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n, o); px = x; py = y; }
async function click(x, y) { await glide(x, y); await mouse(c, 'mousePressed', x, y); await mouse(c, 'mouseReleased', x, y); }
async function dbl(x, y) {
  await glide(x, y);
  for (const n of [1, 2]) {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n, pointerType: 'mouse' });
  }
}
async function rclick(x, y) {
  await glide(x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
async function type(text) { for (const ch of text) { await c.send('Input.insertText', { text: ch }); await sleep(20); } }
async function key(k) {
  const code = { Enter: 13, Escape: 27 }[k];
  for (const t of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type: t, key: k, code: k, windowsVirtualKeyCode: code });
}
async function dock(kind) {
  const V = await box('#viewport');
  await glide(V.x + V.w / 2, V.y + V.h - 6);
  await waitFor(() => ev(`getComputedStyle(document.getElementById('dock')).opacity === '1'`), 4000, 'the dock to come up');
  const b = await box(`#dock button[data-k="${kind}"]`);
  await click(b.cx, b.cy);
  await sleep(800);
}
async function menu(text) {
  const items = await ev(`[...document.querySelectorAll('.ctx button')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const it = items.find((i) => i.t.startsWith(text));
  if (!it) throw new Error(`no menu item "${text}" in ${q(items.map((i) => i.t))}`);
  await click(it.x, it.y);
  await sleep(700);
}
const rowBox = (act) => box(`#sblist .tr[data-act="${act}"]`);
const rowStarting = (text) => ev(`(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((e) => e.textContent.startsWith(${q(text)})); if (!r) return null; const b = r.getBoundingClientRect(); return { act: r.dataset.act, x: b.left + 60, y: b.top + b.height / 2 }; })()`);
/* A point of bare desktop in the view. */
const bare = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), mb = document.querySelector('.menubar').getBoundingClientRect();
  for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) for (let y = Math.max(v.top, mb.bottom) + 2; y < v.bottom - 40; y += 3) { const x = v.left + v.width * f; const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws, .away')) return { x, y }; }
  return null; })()`);
/* Two fingers sideways on bare desktop. A swipe follows the fingers and lands when it is let go; on a loaded machine
   the page gets its wheels seconds late (Chromium merges some, keeping their sum), so this waits until the page has had
   all of the swipe's travel and then until the space on screen has stayed the same for 2 s, and keeps how long after
   that the step landed (null: no change after it). */
const spaceNow = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at); return ws ? ws.at || null : null; })()`);
const LANDED = [];
async function twoFingers(dir) {
  const p = await bare(), sent = SW.reduce((a, d) => a + d, 0) * dir;
  await glide(p.x, p.y);
  await ev(`(() => { if (window.__wheelSum === undefined) addEventListener('wheel', (e) => { window.__wheelSum += e.deltaX; }, { capture: true, passive: true }); window.__wheelSum = 0; return true; })()`);
  await swipe(c, p.x, p.y, SW.map((d) => d * dir));
  for (let k = 0; k < 150 && Math.abs((await ev('window.__wheelSum')) - sent) > 0.5; k++) await sleep(100);
  const had = Date.now();
  let last = await spaceNow(), since = had, landed = null;
  while (Date.now() - since < 2000 && Date.now() - had < 10000) { await sleep(100); const now = await spaceNow(); if (now !== last) { last = now; since = Date.now(); landed = since - had; } }
  LANDED.push(landed);
}
async function threeFingers(dir) { await m.eval(`(() => { process.mainModule.require('electron').BrowserWindow.getAllWindows().find((w) => !/solo=/.test(w.webContents.getURL())).emit('swipe', {}, '${dir}'); return true; })()`); await sleep(900); }
async function pinch(dys) { const { x, y } = await bare(); await glide(x, y); for (const dy of dys) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' }); await sleep(600); }
/* An HTML5 drag: a real press and moves start it, Chromium hands it over, it is dropped at b. b can be a function of
   what shows once the drag has started ({ x, y } first passed over, then where to drop); it returns null to drop nowhere. */
async function htmlDrag(a, b, over) {
  let data = null;
  const on = (msg) => { if (msg.method === 'Input.dragIntercepted') data = msg.params.data; };
  const toward = over || b;
  c.on(on);
  await c.send('Input.setInterceptDrags', { enabled: true });
  await glide(a.x, a.y);
  await mouse(c, 'mousePressed', a.x, a.y);
  for (let i = 1; i <= 10 && !data; i++) { await mouse(c, 'mouseMoved', a.x + ((toward.x - a.x) * i) / 10, a.y + ((toward.y - a.y) * i) / 10, { down: true }); await sleep(30); }
  for (let i = 0; i < 20 && !data; i++) await sleep(50);
  c.listeners = c.listeners.filter((f) => f !== on);
  if (!data) { await mouse(c, 'mouseReleased', toward.x, toward.y); await c.send('Input.setInterceptDrags', { enabled: false }); throw new Error('no drag started'); }
  if (over) {
    for (const t of ['dragEnter', 'dragOver']) await c.send('Input.dispatchDragEvent', { type: t, x: over.x, y: over.y, data });
    await sleep(300);
    b = await b();
    if (!b) {
      await c.send('Input.dispatchDragEvent', { type: 'dragCancel', x: over.x, y: over.y, data });
      await mouse(c, 'mouseReleased', over.x, over.y);
      await c.send('Input.setInterceptDrags', { enabled: false });
      px = over.x; py = over.y;
      await sleep(600);
      return false;
    }
  }
  for (const t of ['dragEnter', 'dragOver', 'drop']) await c.send('Input.dispatchDragEvent', { type: t, x: b.x, y: b.y, data });
  await mouse(c, 'mouseReleased', b.x, b.y);
  await c.send('Input.setInterceptDrags', { enabled: false });
  px = b.x; py = b.y;
  await sleep(900);
  return true;
}
async function restart() {
  ERRS.push(...c.errors);
  c.close();
  if (m) m.close();
  await stop({ keepTmux: true });
  launch({ inspect: true });
  c = await flowWindow();
  m = await mainProcess();
  await sleep(2500);
}
const mainLog = () => fs.readFileSync(path.join(USER_DATA, 'main.log'), 'utf8');

/* ---------- removing a space, and undo ---------- */
const FLOW = `__flow.state().ws.find((w) => w.id === 'flow')`;
/* flow's sub-workspaces (each with its parent), the space on screen, and every window of flow, open or closed, with its
   space and its place */
const snap = () => ev(`(() => { const ws = ${FLOW}, r = (v) => Math.round(v * 1000) / 1000;
  const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  return { at: ws.at || null, zones: ws.zones.map((z) => canon(z)), tree: ws.zones.map((z) => ({ id: z.id, name: z.name, parent: z.parent || null })),
    wins: [...ws.windows.map((w) => [w, 'open']), ...ws.closed.map((w) => [w, 'closed'])].map(([w, st]) => ({ id: w.id, type: w.type, st, zone: w.zone || null, x: r(w.x), y: r(w.y), w: r(w.w), h: r(w.h) })) }; })()`);
async function settled() { let last = '', same = 0, s = null; for (let k = 0; k < 40 && same < 4; k++) { s = await snap(); const now = q(s); same = now === last ? same + 1 : 0; last = now; await sleep(250); } return s; }
const depthFirst = (tree) => { const out = [], down = (p) => tree.filter((z) => z.parent === p).forEach((z) => { out.push(z.id); down(z.id); }); down(null); return out; };
const under = (s, zid) => { const out = [zid]; for (let i = 0; i < out.length; i++) s.tree.filter((z) => z.parent === out[i]).forEach((z) => out.push(z.id)); return out; };
/* A terminal's shell by its tmux pane: the same pid is the same shell, still running. */
const panePid = (id) => spawnSync('tmux', ['-L', SOCKET, 'list-panes', '-s', '-t', `=flow_${id}`, '-F', '#{pane_pid}']).stdout.toString().split('\n')[0].trim() || null;
const shellsUnder = (s, zid) => Object.fromEntries(s.wins.filter((w) => under(s, zid).includes(w.zone) && w.st === 'open' && /^(term|team)$/.test(w.type)).map((w) => [w.id, panePid(w.id)]));
const over = (p, o) => p.x < o.x + o.w - 0.05 && o.x < p.x + p.w - 0.05 && p.y < o.y + o.h - 0.05 && o.y < p.y + p.h - 0.05;
/* What removing zid did, from snapshots before and after (lead, Nov 2 16:4x): its windows are in the space one level up
   (open ones open), none lies over a window it did not lie over before, every other window is where it was, the shells
   given still run in open windows, and its sub-workspaces moved up one level whole: each child's parent is the removed
   one's, every other parent is kept, and the sidebar's order is the one before less the removed one. */
function removal(a, b, zid, pids) {
  const was = a.tree.find((z) => z.id === zid);
  if (!was) return { ok: false, detail: { why: `no ${zid} before the removal` } };
  const up = was.parent, byId = new Map(b.wins.map((w) => [w.id, w]));
  const mine = a.wins.filter((w) => w.zone === zid), ids = new Set(mine.map((w) => w.id));
  const lost = mine.filter((w) => { const n = byId.get(w.id); return !n || n.zone !== up || n.st !== w.st; }).map((w) => w.id);
  const moved = a.wins.filter((w) => !ids.has(w.id) && q(byId.get(w.id)) !== q(w)).map((w) => w.id);
  const pairs = (list) => { const s = new Set(); list.forEach((p, i) => list.slice(i + 1).forEach((o) => { if (over(p, o)) s.add([p.id, o.id].sort().join(' over ')); })); return s; };
  const had = pairs(mine.filter((w) => w.st === 'open'));
  const covered = [...pairs(b.wins.filter((w) => w.st === 'open' && w.zone === up))].filter((k) => k.split(' over ').some((id) => ids.has(id)) && !had.has(k));
  const stopped = Object.entries(pids).filter(([id, pid]) => !pid || panePid(id) !== pid || !byId.has(id) || byId.get(id).st !== 'open').map(([id]) => id);
  const parents = a.tree.filter((z) => z.id !== zid && (b.tree.find((n) => n.id === z.id) || {}).parent !== (z.parent === zid ? up : z.parent)).map((z) => z.name);
  const order = q(depthFirst(b.tree)) === q(depthFirst(a.tree).filter((id) => id !== zid));
  const gone = !b.tree.some((z) => z.id === zid);
  return { ok: mine.length > 0 && gone && !lost.length && !moved.length && !covered.length && !stopped.length && !parents.length && order,
    detail: { windows: mine.length, gone, lost, moved, covered, stopped, parents, order, tree: b.tree.map((z) => `${z.name} in ${z.parent || 'main'}`) } };
}
/* Undo put back exactly what was there: the sub-workspaces in their order with every field as it was, every window of
   flow in its space and place, the space on screen, and the same shells. Fields are compared by name, not by the order
   they were written in. */
function sameAs(a, c, pids) {
  const byId = new Map(c.wins.map((w) => [w.id, w]));
  const changed = a.wins.filter((w) => q(byId.get(w.id)) !== q(w)).map((w) => w.id).concat(c.wins.filter((w) => !a.wins.some((x) => x.id === w.id)).map((w) => `${w.id} new`));
  const stopped = Object.entries(pids).filter(([id, pid]) => !pid || panePid(id) !== pid).map(([id]) => id);
  const order = q(a.zones.map((z) => z.id)) === q(c.zones.map((z) => z.id));
  /* A space's view: while it is popped out its pop-out's view is kept as popView, and once that window closes the main
     window takes it back as the space's own pan and zoom (app.js:137-139, nav.js takeBack); a pop-out opened again
     shows popView, else that view (app.js:2068-2069). So the view compared is that one, wherever it is kept. */
  const norm = (z) => { if (!z) return {}; const { popView, pan, panY, zoom, ...rest } = z; return { ...rest, view: popView ? { pan: popView.pan, panY: popView.panY, zoom: popView.zoom } : { pan, panY, zoom } }; };
  const fields = a.zones.flatMap((z0) => { const z = norm(z0), y = norm(c.zones.find((x) => x.id === z0.id)); return [...new Set([...Object.keys(z), ...Object.keys(y)])].filter((k) => q(z[k]) !== q(y[k])).map((k) => `${z0.name}.${k}: ${q(z[k])} -> ${q(y[k])}`); });
  const zones = order && !fields.length && a.zones.length === c.zones.length;
  return { ok: zones && !changed.length && a.at === c.at && !stopped.length,
    detail: { zones, order, fields, changed, at: [a.at, c.at], stopped, ...(zones ? {} : { tree: c.tree.map((z) => `${z.name} in ${z.parent || 'main'}`) }) } };
}
const headings = () => ev(`[...document.querySelectorAll('#sblist .tr.sph')].map((e) => e.dataset.act.slice(5)).filter(Boolean)`);
const indent = (id) => ev(`(() => { const e = document.querySelector('#sblist .tr.sph[data-act="zone|${id}"] .l'); return e && e.getBoundingClientRect().height ? Math.round(e.getBoundingClientRect().left) : null; })()`);
/* A sub-workspace's heading on screen, unfolding the headings above it when they fold it away. */
async function headingBox(id) {
  const vis = () => ev(`(() => { const e = document.querySelector('#sblist .tr.sph[data-act="zone|${id}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return b.height ? { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 } : null; })()`);
  const first = await vis();
  if (first) return first;
  const t = (await snap()).tree, chain = [];
  for (let z = t.find((x) => x.id === id); z && z.parent; z = t.find((x) => x.id === z.parent)) chain.unshift(z.parent);
  for (const p of chain) {
    const g = await ev(`(() => { const e = document.querySelector('#sblist .tr.sph[data-act="zone|${p}"] [data-tog]'); if (!e || e.textContent !== '▸') return null; const b = e.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
    if (g) { await click(g.cx, g.cy); await sleep(500); }
  }
  return vis();
}
/* Every heading folded away is opened, by a click on its fold mark, so the sidebar lists every space. */
async function unfoldAll() {
  for (let k = 0; k < 12; k++) {
    const g = await ev(`(() => { const e = [...document.querySelectorAll('#sblist .tr.sph [data-tog]')].find((x) => x.textContent === '▸'); if (!e) return null; const b = e.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
    if (!g) return;
    await click(g.cx, g.cy);
    await sleep(400);
  }
}
const menuItems = () => ev(`[...document.querySelectorAll('.ctx button')].map((b) => (b.childNodes[0] ? b.childNodes[0].textContent : b.textContent).trim())`);
/* A sub-workspace made inside another from its heading's right-click, and named in its heading. */
async function nestNew(parent, name) {
  const h = await headingBox(parent);
  if (!h) return { id: null, why: `no heading for ${parent}` };
  const before = (await flowWs()).zones.map((z) => z.id);
  await rclick(h.x + 60, h.cy);
  await sleep(400);
  const items = await menuItems();
  if (!items.includes('new sub-workspace')) { await key('Escape'); await sleep(300); return { id: null, items }; }
  await menu('new sub-workspace');
  const e = await editing();
  const inHeading = await ev(`(() => { const a = document.activeElement; return !!(a && a.isContentEditable && a.closest('.tr.sph.here')); })()`);
  if (e) { await type(name); await key('Enter'); await sleep(500); }
  const f = await flowWs(), z = f.zones.find((x) => !before.includes(x.id));
  return { id: z ? z.id : null, name: z ? z.name : null, at: f.at, items, inHeading };
}
/* A sub-workspace made from the dock while its parent is on screen; it counts only when it lands inside the parent. */
async function dockChild(parent, name) {
  const h = await headingBox(parent);
  if (!h) return null;
  await click(h.x + 60, h.cy);
  await sleep(900);
  const ids = (await flowWs()).zones.map((z) => z.id);
  await dock('zone');
  if (await editing()) { await type(name); await key('Enter'); await sleep(500); }
  const z = (await snap()).tree.find((x) => !ids.includes(x.id));
  return z && z.parent === parent ? z.id : null;
}
let toastAt = 0;
async function removeSpace(id) {
  const h = await headingBox(id);
  if (!h) return false;
  await rclick(h.x + 60, h.cy);
  await sleep(400);
  if (!(await menuItems()).includes('remove')) { await key('Escape'); await sleep(300); return false; }
  await menu('remove');
  toastAt = 0;
  for (let k = 0; k < 150 && !toastAt; k++) { if (await ev(`(() => { const t = document.querySelector('#toast.on'); return !!t && /^removed /.test(t.textContent); })()`)) toastAt = Date.now(); else await sleep(100); }
  await sleep(300);
  return true;
}
/* The toast's undo, pressed as a hand does. It lasts 8 s from when the toast showed, so this keeps how old the toast was
   at the press and whether it was still there: a press after it has gone lands on whatever is under it. */
async function undo() {
  const b = await box('#toast.on .tact');
  if (!b) return { pressed: false, age: toastAt ? Date.now() - toastAt : null };
  await glide(b.cx, b.cy, 4);
  const still = await ev(`!!document.querySelector('#toast.on .tact')`), age = toastAt ? Date.now() - toastAt : null;
  await mouse(c, 'mousePressed', b.cx, b.cy);
  await mouse(c, 'mouseReleased', b.cx, b.cy);
  await sleep(1500);
  return { pressed: true, still, age };
}
/* A pop-out's place and size on the screen, from the main process; moved there first when given. */
const popWin = (zid, set) => m.eval(`(() => { const w = process.mainModule.require('electron').BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('zone=${zid}')); if (!w) return null; ${set ? `w.setBounds(${q(set)});` : ''} return w.getBounds(); })()`);
/* Names the sub-workspace just made: by typing, when its name is ready to type; else the way that always works, a
   double-click on its row in the sidebar (so the walk goes on when the first way fails). */
async function nameNew(name, ws = 'flow') {
  if (!(await editing())) {
    const zn = (await ev(`__flow.state().ws.find((w) => w.id === ${q(ws)}).zones`)).slice(-1)[0];
    const r = await rowBox(`zone|${zn.id}`);
    await dbl(r.x + 60, r.cy);
    await sleep(300);
  }
  await type(name);
  await key('Enter');
  await sleep(500);
}

/* ---------- the day ---------- */
async function walk() {
  const p0 = await box('.sp[data-i="0"] .sn');
  await click(p0.cx, p0.cy);
  await sleep(700);

  // 1, the goal: a sub-workspace is a goal, and a goal is named as it is made
  await dock('zone');
  const e1 = await editing();
  ok('a sub-workspace made from the dock goes there with its name ready to type, in the pill', !!e1 && e1.inPill && e1.text === 'new sub-workspace' && (await flowWs()).at !== null, { editing: e1, at: (await flowWs()).at });
  await nameNew('launch plan');
  let f = await flowWs();
  const lp = f.zones.find((z) => z.name === 'launch plan');
  ok('typing names it: the pill and the sidebar say launch plan', !!lp && f.at === lp.id && (await pill()) === 'flow› launch plan' && !!(await rowBox(`zone|${lp.id}`)), { pill: await pill(), zones: f.zones });
  await shot('01-named-sub-workspace');

  // tools made while in a space live in that space
  await dock('note');
  await key('Escape');
  const V = await box('#viewport');
  await rclick(V.x + V.w * 0.7, V.y + V.h * 0.4);
  await menu('new shell');
  await sleep(1200);
  f = await flowWs();
  const inLp = f.wins.filter((w) => w.zone === lp.id).map((w) => w.id);
  ok('a note from the dock and a shell from the desktop menu land in launch plan', inLp.length === 2, inLp);

  // the pill is where you are: "› launch plan" stays put on a click, renames on a double-click; "flow" goes back
  let sz = await box('.sp.on .sz');
  await click(sz.cx, sz.cy);
  await sleep(500);
  ok('a click on "› launch plan" in the pill stays in launch plan', (await at()) === 'flow' && (await flowWs()).at === lp.id, { at: await at(), space: (await flowWs()).at });
  await sleep(600);
  if ((await flowWs()).at !== lp.id) { const r = await rowBox(`zone|${lp.id}`); await click(r.x + 60, r.cy); await sleep(700); }
  sz = await box('.sp.on .sz');
  await dbl(sz.cx, sz.cy);
  await sleep(500);
  const e2 = await editing();
  ok('a double-click on "› launch plan" renames launch plan, and the workspace stays flow', (await at()) === 'flow' && !!e2 && e2.inPill && e2.text === 'launch plan', { at: await at(), editing: e2 });
  await key('Escape');
  await sleep(400);
  if ((await at()) !== 'flow') { const p = await box('.sp[data-i="0"] .sn'); await click(p.cx, p.cy); await sleep(700); }
  if ((await flowWs()).at !== lp.id) { const r = await rowBox(`zone|${lp.id}`); await click(r.x + 60, r.cy); await sleep(700); }
  const sn = await box('.sp.on .sn');
  await click(sn.cx, sn.cy);
  await sleep(700);
  ok('a click on "flow" in the pill goes back to flow\'s main space', (await flowWs()).at === null && (await pill()) === 'flow', { pill: await pill() });
  await dock('zone');
  await type('notes goal');
  const sn3 = await box('.sp.on .sn');
  await click(sn3.cx, sn3.cy);
  await sleep(700);
  ok('typing a new sub-workspace\'s name and then one click on "flow" keeps the name and goes back to the main space', (await flowWs()).at === null && (await flowWs()).zones.some((z) => z.name === 'notes goal') && !(await editing()), { at: (await flowWs()).at, zones: (await flowWs()).zones.map((z) => z.name), pill: await pill() });
  if ((await flowWs()).at !== null) { const sn4 = await box('.sp.on .sn'); await click(sn4.cx, sn4.cy); await sleep(700); }

  // the last workspace: a double-click on its sub-workspace never makes a workspace
  const nWs = await ev('__flow.state().ws.length');
  const pl = await box(`.sp[data-i="${nWs - 1}"] .sn`);
  await click(pl.cx, pl.cy);
  await sleep(700);
  await dock('zone');
  await nameNew('ef goal', 'ef');
  sz = await box('.sp.on .sz');
  await dbl(sz.cx, sz.cy);
  await sleep(600);
  await key('Escape');
  await sleep(400);
  ok('in the last workspace, a double-click on its sub-workspace in the pill makes no new workspace', (await ev('__flow.state().ws.length')) === nWs && (await at()) === 'ef', { workspaces: await ev('__flow.state().ws.map((w) => w.name)'), at: await at() });
  if (await editing()) { await key('Escape'); await sleep(300); }
  const back = await box('.sp[data-i="0"] .sn');
  await click(back.cx, back.cy);
  await sleep(700);

  // 2, organizing is moving a tool to the goal it serves: by window drag, by sidebar drag, by the sidebar's new place
  const week = await box('.win[data-id="w-week"] .tb'), research = await rowBox('zone|z-research');
  await glide(week.x + 80, week.cy);
  await mouse(c, 'mousePressed', week.x + 80, week.cy);
  await glide(research.x + 60, research.cy, 24, { down: true });
  await sleep(300);
  await mouse(c, 'mouseReleased', research.x + 60, research.cy);
  await sleep(900);
  ok('a window dragged onto a sub-workspace in the sidebar moves there, and the view stays', (await flowWs()).wins.find((w) => w.id === 'w-week').zone === 'z-research' && (await flowWs()).at === null);
  const agent = await rowStarting('›_design');
  await htmlDrag(agent, { x: (await rowBox(`zone|${lp.id}`)).x + 60, y: (await rowBox(`zone|${lp.id}`)).cy });
  ok('an agent\'s sidebar row dropped on launch plan moves the agent there', (await flowWs()).wins.find((w) => w.id === 'w-design').zone === lp.id);
  // a new sub-workspace takes no room at rest: the workspace's own heading has it in its right-click, and while a row is
  // dragged a strip at the end of the list reads "+ new sub-workspace" and takes the drop; nothing in the list moves
  // (owner 14:46; sidebar's space headings, batch 8)
  const STRIP = '#sblist .sadd', MAIN = '#sblist .tr.sph[data-act="zone|"]';
  const tops = () => ev(`Object.fromEntries([...document.querySelectorAll('#sblist .tr[data-act], #sblist .grp')].map((e) => [e.dataset.act || e.dataset.grp, Math.round(e.getBoundingClientRect().top)]))`);
  const seen = (sel) => ev(`(() => { const e = [...document.querySelectorAll(${q(sel)})].find((e) => { const b = e.getBoundingClientRect(), cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.1 && b.height > 0 && b.width > 0; }); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2, text: getComputedStyle(e, '::before').content.replace(/^"|"$/g, '') }; })()`);
  const present = (sel) => ev(`!!document.querySelector(${q(sel)})`);
  /* Anything shown in the sidebar that offers a new sub-workspace, by its own text or its ::before. A space's name in its
     heading is not an offer: a sub-workspace left with its first name is called "new sub-workspace". */
  const offers = () => ev(`[...document.querySelectorAll('#sblist *')].filter((e) => { const cs = getComputedStyle(e), b = e.getBoundingClientRect(); if (cs.display === 'none' || cs.visibility === 'hidden' || !b.height || e.closest('.tr.sph > .l')) return false; const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') + getComputedStyle(e, '::before').content.replace(/^"|"$|^none$/g, ''); return /new sub-workspace/.test(own); }).length`);
  /* What moved between two readings of the sidebar; a row that is gone counts as moved. A reading counts only when it
     has main's heading and research's in it, so "nothing moved" is never said of an empty list. */
  const shifted = (a, b) => Object.fromEntries(Object.keys(a).filter((k) => b[k] !== a[k]).map((k) => [k, b[k] === undefined ? 'gone' : b[k] - a[k]]));
  const measured = (t) => !!t && t['zone|'] !== undefined && t['zone|z-research'] !== undefined;
  const rest = await bare();
  await glide(rest.x, rest.y);
  await sleep(400);
  const atRest = await tops();
  ok('at rest nothing in the sidebar offers a new sub-workspace and no blank line is kept for one', (await present(STRIP)) && !(await seen(STRIP)) && (await offers()) === 0 && measured(atRest), { strip: await present(STRIP), offers: await offers(), measured: measured(atRest) });
  // the main space's heading is the workspace's own name, as its pill says it (owner, Nov 2 17:2x)
  const first = await ev(`(() => { const h = document.querySelector('#sblist .tr.sph'), l = h && h.querySelector('.l'); return h ? { act: h.dataset.act, name: l ? [...l.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') : null } : null; })()`);
  const wsName = await ev(`${FLOW}.name`), pillName = await ev(`document.querySelector('.sp.on .sn').textContent`);
  ok('the first heading in the sidebar is the workspace\'s own name, as its pill says it', !!first && first.act === 'zone|' && first.name === wsName && pillName === wsName, { first, workspace: wsName, pill: pillName });
  const mainRow = await box(MAIN);
  await rclick(mainRow.x + 60, mainRow.cy);
  await sleep(400);
  const items = await ev(`[...document.querySelectorAll('.ctx button')].map((b) => (b.childNodes[0] ? b.childNodes[0].textContent : b.textContent).trim())`);
  const n0 = (await flowWs()).zones.length;
  await menu('new sub-workspace');
  const e4 = await editing();
  const inHeading = await ev(`(() => { const a = document.activeElement; return !!(a && a.isContentEditable && a.closest('.tr.sph.here')); })()`);
  await type('spare goal');
  await key('Enter');
  await sleep(500);
  f = await flowWs();
  const made = f.zones[f.zones.length - 1];
  ok('a right-click on the workspace\'s own heading offers exactly "new sub-workspace"; picking it makes one, goes there and opens its name for typing in its heading', q(items) === q(['new sub-workspace']) && f.zones.length === n0 + 1 && f.at === made.id && inHeading && made.name === 'spare goal', { items, zones: f.zones.map((z) => z.name), at: f.at, editing: e4 });
  const home2 = await box('.sp.on .sn');
  await click(home2.cx, home2.cy);
  await sleep(700);
  const rest2 = await bare();
  await glide(rest2.x, rest2.y);
  await sleep(400);
  const atRest2 = await tops();
  const mck = await rowStarting('↗');
  const before = (await flowWs()).zones.length;
  const overRow = await rowBox('zone|z-research');
  let during = null;
  await htmlDrag(mck, async () => {
    during = { strip: await seen(STRIP), tops: await tops(), last: await ev(`(() => { const l = [...document.querySelectorAll('#sblist > *')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height); const e = l[l.length - 1]; return e ? e.className : null; })()`) };
    return during.strip ? { x: during.strip.cx, y: during.strip.cy } : null;
  }, { x: overRow.x + 60, y: overRow.cy });
  ok('while a page row is dragged, a strip at the end of the list reads "+ new sub-workspace" and nothing in the list moves', !!during && !!during.strip && during.strip.text === '+ new sub-workspace' && /\bsadd\b/.test(during.last || '') && measured(atRest2) && measured(during.tops) && Object.keys(shifted(atRest2, during.tops)).length === 0, { strip: during && during.strip, last: during && during.last, moved: during && shifted(atRest2, during.tops) });
  if (during && during.strip) {
    const e3 = await editing();
    await type('reading');
    await key('Enter');
    await sleep(600);
    f = await flowWs();
    const rd = f.zones.find((z) => z.name === 'reading');
    ok('a page dropped there makes a new sub-workspace with the page in it, named as it is made', f.zones.length === before + 1 && !!rd && f.wins.find((w) => w.id === 'w-mck').zone === rd.id && f.at === rd.id && !!e3, { zones: f.zones.map((z) => z.name), editing: e3 });
    await shot('02-dropped-into-new-sub-workspace');
  }
  const back2 = await bare();
  await glide(back2.x, back2.y);
  await sleep(400);
  ok('after the drag the strip is gone again and nothing offers a new sub-workspace', (await present(STRIP)) && !(await seen(STRIP)) && (await offers()) === 0, { strip: await seen(STRIP), offers: await offers() });

  // 4, spaces you move through: two fingers between goals, three between projects, a pinch per space
  const sn2 = await box('.sp.on .sn');
  await click(sn2.cx, sn2.cy);
  await sleep(700);
  const ids = (await flowWs()).zones.map((z) => z.id), order = [];
  for (let k = 0; k <= ids.length; k++) { await twoFingers(1); order.push((await flowWs()).at); }
  ok('two fingers step through the sub-workspaces in order, one per swipe, and stop at the last', q(order) === q([...ids, ids[ids.length - 1]]), { order, zones: ids });
  await pinch([30, 30, 30]);
  const z1 = await ev(`__flow.state().ws[0].zoom`);
  await threeFingers('left');
  const away = await at();
  await threeFingers('right');
  ok('three fingers go to the next workspace and back, to the same sub-workspace at its own zoom', away === 'mynotes' && (await at()) === 'flow' && (await flowWs()).at === order[order.length - 1] && Math.abs((await ev(`__flow.state().ws[0].zoom`)) - z1) < 0.001 && z1 < 0.5, { away, zoom: z1 });
  await pinch([-30, -30, -30]);

  // a popped-out goal lives only in its pop-out
  await twoFingers(-1);
  await twoFingers(-1);
  const pop = await box(`#sblist .tr[data-act="zone|${lp.id}"] [data-zpop]`);
  const r0 = await rowBox(`zone|${lp.id}`);
  await glide(r0.x + 60, r0.cy);
  await sleep(300);
  await click(pop.cx, pop.cy);
  await waitFor(async () => (await pages()).some((u) => u.includes(`zone=${lp.id}`)), 15000, 'the pop-out');
  await sleep(2500);
  ok('launch plan pops out into its own window', (await pages()).some((u) => u.includes(`zone=${lp.id}`)), await pages());
  const tog = await box(`#sblist .tr[data-act="zone|${lp.id}"] [data-tog]`);
  if (tog) { await click(tog.cx, tog.cy); await sleep(500); }
  /* its first tool: the first row after its heading, before the next heading */
  const kid = await ev(`(() => { const rows = [...document.querySelectorAll('#sblist .tr')]; const i = rows.findIndex((e) => e.dataset.act === 'zone|${lp.id}'); const e = i < 0 ? null : rows[i + 1]; if (!e || e.classList.contains('sph')) return null; const b = e.getBoundingClientRect(); return { t: e.textContent, x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  const spaceBefore = (await flowWs()).at, logBefore = mainLog().length;
  if (kid) { await click(kid.x, kid.y); await sleep(1200); }
  const forward = !!kid && mainLog().slice(logBefore).includes(`background: solo=flow&zone=${lp.id} shown inactive`);
  ok('clicking one of its tools in the main sidebar brings the pop-out forward, and the main window stays where it was', forward && (await flowWs()).at === spaceBefore, { row: kid ? kid.t : null, forward, mainSpace: (await flowWs()).at, before: spaceBefore });
  await shot('03-main-after-clicking-a-popped-out-tool');

  // 5, comes back exactly: windows, spaces, zoom, the pop-out
  await restart();
  f = await flowWs();
  ok('after a restart: the sub-workspaces, their windows and the pop-out are back', ['research', 'launch plan'].every((n) => f.zones.some((z) => z.name === n)) && f.wins.find((w) => w.id === 'w-design').zone === lp.id && (await pages()).some((u) => u.includes(`zone=${lp.id}`)), { zones: f.zones.map((z) => z.name), pages: await pages() });

  // removing a sub-workspace open in its own window: that window closes first and its windows move into main; undo puts
  // everything back, its own window at the same place and size (lead, Nov 2 16:4x); removed again, it stays gone after a
  // restart
  const hadPop = (await pages()).some((u) => u.includes(`zone=${lp.id}`));
  await popWin(lp.id, { x: 211, y: 97, width: 903, height: 611 });
  await sleep(900);
  const placed = await popWin(lp.id);
  const l0 = await snap(), l0p = shellsUnder(l0, lp.id);
  const lGone = await removeSpace(lp.id);
  const l1 = await settled(), lr = removal(l0, l1, lp.id, l0p);
  ok('removing launch plan while it is open in its own window closes that window and moves its windows into main: over no window, every other window where it was, its agents still running', lGone && hadPop && !(await pages()).some((u) => u.includes(`zone=${lp.id}`)) && Object.keys(l0p).length > 0 && lr.ok, { popOutBefore: hadPop, pages: await pages(), shells: Object.keys(l0p), ...lr.detail });
  const toastSaid = await ev(`(() => { const t = document.querySelector('#toast.on'); return t ? t.textContent : null; })()`);
  const lUndo = lGone ? await undo() : null;
  const rightAfter = (await flowWs()).zones.map((z) => z.name);
  for (let k = 0; k < 30 && !(await pages()).some((u) => u.includes(`zone=${lp.id}`)); k++) await sleep(500);
  const l2 = await settled(), lb = sameAs(l0, l2, l0p), reopened = await popWin(lp.id);
  ok('undo puts launch plan back exactly, and its own window reopens at the same place and size', !!lUndo && lUndo.pressed && lUndo.still && lb.ok && !!placed && !!reopened && ['x', 'y', 'width', 'height'].every((k) => Math.abs(reopened[k] - placed[k]) <= 1), { undo: lUndo, toast: toastSaid, rightAfter, placed, reopened, ...lb.detail });
  if ((await flowWs()).zones.some((z) => z.id === lp.id)) await removeSpace(lp.id);
  await restart();
  ok('and it does not come back after a restart', hadPop && !(await pages()).some((u) => u.includes(`zone=${lp.id}`)) && !(await flowWs()).zones.some((z) => z.id === lp.id), { popOutBefore: hadPop, pages: await pages() });

  // a new workspace is named in its pill, and the click that ends the naming still lands
  const addWs = await box('#addws');
  await click(addWs.cx, addWs.cy);
  await sleep(800);
  const e5 = await editing();
  await type('garden plan');
  const home = await box('.sp[data-i="0"] .sn');
  const hit = await ev(`(() => { const e = document.elementFromPoint(${home.cx}, ${home.cy}); return !!(e && e.closest('.sp[data-i="0"]')); })()`);
  await click(home.cx, home.cy);
  await sleep(900);
  const names = await ev('__flow.state().ws.map((w) => w.name)');
  ok('typing a new workspace\'s name and then one click on "flow" keeps the name and goes to flow', !!e5 && e5.inPill && hit && names.includes('garden plan') && (await at()) === 'flow' && !(await editing()), { editing: e5, hit, names, at: await at(), pill: await pill() });
  await shot('04-after-naming-a-new-workspace');
  if ((await at()) !== 'flow') { const h2 = await box('.sp[data-i="0"] .sn'); await click(h2.cx, h2.cy); await sleep(900); }

  // a sub-workspace renamed in the sidebar: the click on a pill that ends it still lands
  const rr = await box('#sblist .tr[data-act="zone|z-research"] .l');
  await dbl(rr.cx, rr.cy);
  await sleep(500);
  const e6 = await editing();
  await type('papers');
  const other = await box('.sp[data-i="1"] .sn');
  await click(other.cx, other.cy);
  await sleep(900);
  ok('renaming research in the sidebar and then one click on mynotes keeps the name and goes to mynotes', !!e6 && !e6.inPill && (await at()) === 'mynotes' && (await flowWs()).zones.some((z) => z.name === 'papers'), { editing: e6, at: await at(), zones: (await flowWs()).zones.map((z) => z.name) });

  // a swipe while a sub-workspace's name is open in the pill: once named, the pill shows the space on screen
  const fp = await box('.sp[data-i="0"] .sn');
  await click(fp.cx, fp.cy);
  await sleep(900);
  const pr = await rowBox('zone|z-research');
  await click(pr.x + 60, pr.cy);
  await sleep(900);
  const zname = await box('.sp.on .sz');
  await dbl(zname.cx, zname.cy);
  await sleep(400);
  const e7 = await editing();
  await twoFingers(-1);
  await key('Enter');
  await sleep(500);
  f = await flowWs();
  ok('a two-finger swipe while a sub-workspace\'s name is open in the pill goes back to the main space, and after Enter the pill shows it', !!e7 && e7.inPill && f.at === null && (await pill()) === 'flow', { editing: e7, at: f.at, pill: await pill() });

  // 6, sub-workspaces inside sub-workspaces (owner 14:46, "even for sub workspaces ... further create sub workspaces for
  // them as well"; lead 16:4x): one is made from a sub-workspace's heading; two fingers go through them in the sidebar's
  // order, depth first; removing one moves its windows one level up, over no window, its agents still running, and its
  // own sub-workspaces up one level whole; undo puts everything back exactly
  const pp = await headingBox('z-research');
  await click(pp.x + 60, pp.cy);
  await sleep(900);
  const kv = await nestNew('z-research', 'kv notes'), t1 = (await snap()).tree, hs = await headings();
  const ind = { papers: await indent('z-research'), inside: kv.id ? await indent(kv.id) : null };
  ok('a right-click on a sub-workspace\'s heading makes one inside it: indented under it, Flow goes there and its name is typed in its heading', !!kv.id && kv.name === 'kv notes' && kv.at === kv.id && kv.inHeading && (t1.find((z) => z.id === kv.id) || {}).parent === 'z-research' && hs[hs.indexOf('z-research') + 1] === kv.id && ind.inside > ind.papers + 4, { ...kv, indent: ind, sidebar: hs });
  // until a heading offers it (sidebar's next step), kv notes is made from the dock while in papers, so the checks
  // after this one still run
  if (!kv.id && kv.items) { const id = await dockChild('z-research', 'kv notes'); if (id) Object.assign(kv, { id, via: 'the dock' }); }
  // what is made while in a sub-workspace lives in it: the dock's "new sub-workspace" in kv notes makes one inside it
  // (backlog's model, 18:2x)
  let shell = null, deep = { id: null, why: 'no sub-workspace was made inside papers' };
  if (kv.id) {
    const p = await bare();
    await rclick(p.x, p.y);
    await menu('new shell');
    await sleep(1500);
    shell = ((await flowWs()).wins.find((w) => w.zone === kv.id) || {}).id || null;
    const ids6 = (await flowWs()).zones.map((z) => z.id);
    await dock('zone');
    const typed = !!(await editing());
    if (typed) { await type('kv deep'); await key('Enter'); await sleep(500); }
    const f6 = await flowWs(), dz = f6.zones.find((z) => !ids6.includes(z.id));
    deep = { id: dz ? dz.id : null, name: dz ? dz.name : null, at: f6.at, typed, parent: dz ? ((await snap()).tree.find((z) => z.id === dz.id) || {}).parent : null };
    if (deep.id) { await dock('note'); await key('Escape'); await sleep(400); }
  }
  ok('the dock\'s "new sub-workspace" while in kv notes makes one inside kv notes: Flow goes there and its name is typed', !!deep.id && deep.name === 'kv deep' && deep.at === deep.id && deep.typed && deep.parent === kv.id, deep);
  if (!(await nestNew('z-research', 'judge notes')).id && kv.via) await dockChild('z-research', 'judge notes');
  const home5 = await box('.sp.on .sn');
  await click(home5.cx, home5.cy);
  await sleep(800);
  await unfoldAll();
  const t2 = (await snap()).tree, df = depthFirst(t2), side = await headings(), steps = [];
  for (let k = 0; k <= df.length; k++) { await twoFingers(1); steps.push((await flowWs()).at); }
  ok('two fingers go through sub-workspaces inside sub-workspaces in the sidebar\'s order, depth first, one per swipe, and stop at the last', t2.some((z) => z.parent) && q(side) === q(df) && q(steps) === q([...df, df[df.length - 1]]), { steps, sidebar: side, depthFirst: df, inside: t2.filter((z) => z.parent).map((z) => z.name) });

  // a pop-out shows one space: papers' pop-out shows only papers' own windows, none of its sub-workspaces' (lead 16:4x)
  let popOwn = { why: 'no sub-workspace was made inside papers' };
  if (kv.id) {
    const own = (await snap()).wins.filter((w) => w.zone === 'z-research' && w.st === 'open').map((w) => w.id).sort();
    const ph = await headingBox('z-research');
    await glide(ph.x + 60, ph.cy);
    await sleep(300);
    const zp = await box('#sblist .tr[data-act="zone|z-research"] [data-zpop]');
    if (zp) { await click(zp.cx, zp.cy); for (let k = 0; k < 30 && !(await pages()).some((u) => u.includes('zone=z-research')); k++) await sleep(500); }
    let inPop = null;
    if ((await pages()).some((u) => u.includes('zone=z-research'))) {
      await sleep(2500);
      const pc = await flowWindow((u) => /[#&]zone=z-research(&|$)/.test(u));
      inPop = await pc.eval(`[...document.querySelectorAll('.win[data-id]')].filter((e) => e.offsetParent !== null).map((e) => e.dataset.id).sort()`);
      ERRS.push(...pc.errors);
      pc.close();
      await m.eval(`(() => { const w = process.mainModule.require('electron').BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('zone=z-research')); if (w) w.close(); return !!w; })()`);
      for (let k = 0; k < 30 && (await pages()).some((u) => u.includes('zone=z-research')); k++) await sleep(500);
    }
    popOwn = { button: !!zp, own, inPop };
  }
  ok('papers\' own window, while papers holds sub-workspaces, shows only papers\' own windows', !!popOwn.inPop && q(popOwn.inPop) === q(popOwn.own), popOwn);

  const k0 = await snap(), k0p = kv.id ? shellsUnder(k0, kv.id) : {};
  const kGone = kv.id ? await removeSpace(kv.id) : false;
  const k1 = await settled(), kr = kv.id ? removal(k0, k1, kv.id, k0p) : { ok: false, detail: { why: 'no sub-workspace was made inside papers' } };
  ok('removing kv notes, inside papers, moves its windows into papers, over no window, its agent still running, and kv deep up into papers in its place', kGone && kr.ok && !!shell && !!deep.id && Object.keys(k0p).length > 0 && (k1.tree.find((z) => z.id === deep.id) || {}).parent === 'z-research', { shell, deep: deep.id, ...kr.detail });
  const kUndo = kGone ? await undo() : null;
  const k2 = await settled(), kb = sameAs(k0, k2, k0p);
  ok('undo puts kv notes back exactly: inside papers, with kv deep, its windows and its agent', !!kUndo && kUndo.pressed && kUndo.still && kb.ok && !!kv.id && k0.tree.some((z) => z.parent === kv.id), { undo: kUndo, ...kb.detail });

  const g0 = await snap(), g0p = shellsUnder(g0, 'z-research'), kids0 = g0.tree.filter((z) => z.parent === 'z-research').map((z) => z.name);
  const gGone = await removeSpace('z-research');
  const g1 = await settled(), gr = removal(g0, g1, 'z-research', g0p);
  ok('removing papers, which holds sub-workspaces, moves its windows into main, over no window, every other window where it was, and its sub-workspaces up one level whole, in their order, with their windows and agents', gGone && gr.ok && kids0.length >= 2 && g0.tree.some((z) => z.parent && z.parent !== 'z-research') && Object.keys(g0p).length > 0, { inside: kids0, shells: Object.keys(g0p), ...gr.detail });
  const gUndo = gGone ? await undo() : null;
  const g2 = await settled(), gb = sameAs(g0, g2, g0p);
  ok('undo puts papers back exactly, with its sub-workspaces, their windows and agents', !!gUndo && gUndo.pressed && gUndo.still && gb.ok && kids0.length >= 2, { undo: gUndo, ...gb.detail });
}

async function main() {
  await stop();
  await freshState();
  fs.rmSync(SHOTS, { recursive: true, force: true });
  launch({ inspect: true });
  try {
    c = await flowWindow();
    m = await mainProcess();
    console.log(`app: ${ROOT}`);
    try { await walk(); } catch (err) { ok('the walk ran to the end', false, err.message); await shot('fail').catch((e) => console.log(`no screenshot of the failure: ${e.message}`)); }
    ERRS.push(...c.errors);
    ok('no console errors or exceptions in the Flow window', ERRS.length === 0, ERRS.slice(0, 5));
    console.log(`two-finger steps landed this long after the page had all of the swipe (ms): ${q(LANDED)}`);
  } finally {
    if (c) c.close();
    if (m) m.close();
    if (!KEEP) await stop();
  }
  console.log(`\n${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });




