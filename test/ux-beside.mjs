// ux's check of the + beside the window in front (src/beside.js, nav.beside, app.js openBeside), with real input over
// CDP. Where it comes up (a side's middle, past the resize band) and where not (that band, a hand passing across), same
// size on all four sides on a full space and on an empty one, the split in half, Esc, an agent's fresh agent, the keys'
// action, far out, and the dock, the corner map, the edge room strip and a title-bar drag still doing what they did.
//   test/ux-dev.sh stop; test/ux-dev.sh start --fresh && node test/ux-beside.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectTo, evaluate, size, shot, sleep, mouse, click, key, type, reporter } from './ui-lib.mjs';

const SHOTS = path.join(os.homedir(), 'flow-evidence', 'ux', 'evidence', 'beside');
fs.mkdirSync(SHOTS, { recursive: true });
const W = 1500, H = 913, GAP_X = 1.2, GAP_Y = 1.8;
const R = reporter();
const app = await connectTo(9567, /\/src\/index\.html$/);
for (let i = 0; i < 120 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
await size(app, W, H);
await sleep(1500);

const scr = (id) => evaluate(app, `(() => { const e = document.querySelector('.win[data-id="${id}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const box = (sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
/* The windows of the space on screen in the current workspace, as the state has them (space %). */
const wins = () => evaluate(app, `(() => { const ws = __flow.state().ws[[...document.querySelectorAll('.sp')].indexOf(document.querySelector('.sp.on'))];
  return ws.windows.filter((w) => { const e = document.querySelector('.win[data-id="' + w.id + '"]'); return e && e.style.display !== 'none'; }).map((w) => ({ id: w.id, type: w.type, cmd: w.cmd, cwd: w.cwd, sessionId: w.sessionId, forkFrom: w.forkFrom, x: +w.x, y: +w.y, w: +w.w, h: +w.h })); })()`);
const plusNow = () => evaluate(app, `(() => { const p = document.querySelector('.bz'); if (!p) return null; const cs = getComputedStyle(p), b = p.getBoundingClientRect(); return { shown: cs.display !== 'none' && +cs.opacity > 0.5, x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
const outlines = () => evaluate(app, `[...document.querySelectorAll('#viewport > div')].filter((d) => d.style.border && d.style.border.includes('dashed') && d.style.display !== 'none').length`);
const outlineBox = () => evaluate(app, `(() => { const d = [...document.querySelectorAll('#viewport > div')].find((x) => x.style.border && x.style.border.includes('dashed') && x.style.display !== 'none'); if (!d) return null; const b = d.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, pinned: d.dataset.pinned === '1', inView: b.left >= v.left && b.top >= v.top && b.right <= v.right && b.bottom <= v.bottom }; })()`);
const park = async () => { await mouse(app, 'mouseMoved', 700, 300); await sleep(450); };
const overlap = (a, b) => a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05;
const near = (a, b, t = 0.3) => Math.abs(a - b) <= t;
/* Pans the board by dragging bare desktop dx, dy px, held still before letting go so it does not glide. The board has no
   pan limits: the view stays where the last window led it, so a test brings a window back by panning, as a hand does. */
async function pan(dx, dy) {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 500));
  for (let i = 0; i < n; i++) if (!(await pan1(dx / n, dy / n))) return false;
  return true;
}
async function pan1(dx, dy) {
  const vp = await box('#viewport');
  // a start on bare desktop from which the whole move stays on screen
  const x0 = vp.x + 60 + Math.max(0, -dx), x1 = vp.x + vp.w - 60 - Math.max(0, dx), y0 = vp.y + 60 + Math.max(0, -dy), y1 = vp.y + vp.h - 60 - Math.max(0, dy);
  const p = await evaluate(app, `(() => { for (let y = ${y0}; y <= ${y1}; y += 25) for (let x = ${x0}; x <= ${x1}; x += 25) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .away, #dock, .ov, .edge, .bz') && e.closest('section.ws')) return { x, y }; } return null; })()`);
  if (!p) return false;
  await mouse(app, 'mouseMoved', p.x, p.y);
  await mouse(app, 'mousePressed', p.x, p.y);
  for (let i = 1; i <= 12; i++) { await mouse(app, 'mouseMoved', p.x + (dx * i) / 12, p.y + (dy * i) / 12, { down: true }); await sleep(16); }
  await sleep(150);
  await mouse(app, 'mouseReleased', p.x + dx, p.y + dy);
  await sleep(600);
  return true;
}
async function front(id) {
  let tb = await box(`.win[data-id="${id}"] > .tb`);
  const vp0 = await box('#viewport');
  if (tb && (tb.y < vp0.y || tb.y + tb.h > vp0.y + vp0.h || tb.x + tb.w < vp0.x || tb.x > vp0.x + vp0.w)) { await show(id); tb = await box(`.win[data-id="${id}"] > .tb`); }
  const b = await scr(id);
  // on its title bar, whatever the zoom (far out the bar is a few px tall)
  await click(app, b.x + Math.min(b.w / 2, 140), tb ? tb.cy : b.y + 14);
  await sleep(450);
  return evaluate(app, `!!document.querySelector('.win.front[data-id="${id}"]')`);
}
/* From 80 px out to 6 px out from the middle of a side, as a hand comes to it. */
async function approach(id, side, along = 0.3, out = 10) {
  const b = await scr(id), vp = await box('#viewport');
  const ax = b.x + b.w * along, ay = b.y + b.h * along;
  const [tx, ty, ox, oy] = { left: [b.x - out, ay, -1, 0], right: [b.r + out, ay, 1, 0], above: [ax, b.y - out, 0, -1], below: [ax, b.b + out, 0, 1] }[side];
  for (const d of [80, 40, 18, 0]) { await mouse(app, 'mouseMoved', tx + ox * d, ty + oy * d); await sleep(40); }
  // the + fades in over 140 ms; under load the page may take longer to paint it, so wait for it, up to 1.5 s
  let p = await plusNow();
  for (let i = 0; i < 30 && !p.shown; i++) { await sleep(50); p = await plusNow(); }
  // where it belongs: the middle of the side's part in view, 12 px past the border (4 px resize band, then the + 's half)
  const midX = (Math.max(b.x, vp.x) + Math.min(b.r, vp.x + vp.w)) / 2, midY = (Math.max(b.y, vp.y) + Math.min(b.b, vp.y + vp.h)) / 2;
  const want = { left: [b.x - 12, midY], right: [b.r + 12, midY], above: [midX, b.y - 12], below: [midX, b.b + 12] }[side];
  return { ...p, want };
}
/* At the middle of the side, just past the resize band (reached at 30% along it, so following the hand would show). */
const onEdge = (p) => near(p.x, p.want[0], 2) && near(p.y, p.want[1], 2);
/* Same size on a side: the + comes up on that edge, one outline while pointing at it, a click opens one window of the
   source's kind and size flush on that side, covering nothing; what moved was in its band. */
/* The window facing id's side within the + 's reach (4 px resize band, 12 px band, 16 px +), if any: that gap is the
   room double-click's, so no + comes up on that side (lead, 15:5x). */
const REACH = 32;
const facing = (id, side) => evaluate(app, `(() => { const e = document.querySelector('.win[data-id="${id}"]'), r = e.getBoundingClientRect(), K = ${REACH};
  const z = { right: [r.right, r.top, r.right + K, r.bottom], left: [r.left - K, r.top, r.left, r.bottom], below: [r.left, r.bottom, r.right, r.bottom + K], above: [r.left, r.top - K, r.right, r.top] }['${side}'];
  const o = [...(e.closest('section.ws') || document).querySelectorAll('.win')].find((o) => { if (o === e || o.style.display === 'none') return false; const q = o.getBoundingClientRect(); return q.width && q.left < z[2] && q.right > z[0] && q.top < z[3] && q.bottom > z[1]; });
  return o ? o.dataset.id : null; })()`);
async function sameSize(label, id, side, kind = 'page') {
  if (!(await front(id))) return R.ok(`${label}: ${id} comes to the front`, false);
  const faced = await facing(id, side);
  if (faced) {
    const p = await approach(id, side);
    R.ok(`${label}: its ${side} side faces ${faced} within the band, so no + comes up there (the gap is the room double-click's)`, !p.shown, p);
    await park();
    return null;
  }
  const before = await wins();
  const p = await approach(id, side);
  R.ok(`${label}: nearing its ${side} side brings up the +, at the side's middle just past the resize band`, p.shown && onEdge(p), p);
  await mouse(app, 'mouseMoved', p.x, p.y);
  await sleep(300);
  const lines = await outlines(), ob = await outlineBox();
  await shot(app, path.join(SHOTS, `${label.replace(/\W+/g, '-')}-${side}-hover.png`));
  await click(app, p.x, p.y);
  await sleep(1300);
  const after = await wins();
  const added = after.filter((w) => !before.some((b) => b.id === w.id));
  const src = after.find((w) => w.id === id), n = added[0];
  const flush = n && src && {
    right: near(n.x, src.x + src.w + GAP_X) && near(n.y, src.y, 0.05),
    left: near(src.x, n.x + n.w + GAP_X) && near(n.y, src.y, 0.05),
    below: near(n.y, src.y + src.h + GAP_Y) && near(n.x, src.x, 0.05),
    above: near(src.y, n.y + n.h + GAP_Y) && near(n.x, src.x, 0.05),
  }[side];
  const covers = n ? after.filter((w) => w.id !== n.id && overlap(w, n)).map((w) => w.id) : [];
  // what moved, less the one shift a grow at the space's start gives everything
  const b0 = before.find((w) => w.id === id), dx = src ? src.x - b0.x : 0, dy = src ? src.y - b0.y : 0;
  const X = side === 'left' || side === 'right';
  const moved = before.filter((b) => { const a = after.find((w) => w.id === b.id); return a && b.id !== id && (Math.abs(a.x - b.x - dx) > 0.05 || Math.abs(a.y - b.y - dy) > 0.05); });
  const outOfBand = n ? moved.filter((b) => (X ? !(b.y < n.y - dy + n.h - 0.05 && n.y - dy < b.y + b.h - 0.05) : !(b.x < n.x - dx + n.w - 0.05 && n.x - dx < b.x + b.w - 0.05))).map((b) => b.id) : [];
  const ok = lines === 1 && added.length === 1 && n.type === src.type && near(n.w, src.w, 0.05) && near(n.h, src.h, 0.05) && flush && !covers.length && !outOfBand.length;
  R.ok(`${label}: a click opens a ${kind} of the same size on its ${side}, flush, covering nothing; only windows in its way moved`, ok,
    { lines, added: added.length, src: src && [src.x, src.y, src.w, src.h].map((v) => +v.toFixed(1)), new: n && [n.x, n.y, n.w, n.h].map((v) => +v.toFixed(1)), covers, moved: moved.map((b) => b.id), outOfBand });
  if (kind === 'page') R.ok(`${label}: the new page's address takes the keys`, (await evaluate(app, 'document.activeElement && document.activeElement.classList.contains("ad")')) === true);
  // an outline wholly in view is where the window lands, to the pixel or so (the view has no reason to move)
  if (ob && ob.pinned) {
    // past the view: a sliver at the view's side it lies past, and the view then shows where it went
    const vp = await box('#viewport'), nb = n && (await scr(n.id));
    const at = { right: near(ob.x + ob.w, vp.x + vp.w, 2), left: near(ob.x, vp.x, 2), below: near(ob.y + ob.h, vp.y + vp.h, 2), above: near(ob.y, vp.y, 2) }[side];
    R.ok(`${label}: the ${side} outline past the view shows as a sliver at that side, and the view then shows the new window`, at && !!nb && nb.x >= vp.x - 1 && nb.x + nb.w <= vp.x + vp.w + 1, { outline: [ob.x, ob.y, ob.w, ob.h].map(Math.round), landed: nb && [nb.x, nb.y, nb.w, nb.h].map(Math.round) });
  } else if (ob && ob.inView && n) {
    const nb = await scr(n.id);
    R.ok(`${label}: the ${side} outline was where it landed`, !!nb && near(nb.x, ob.x, 3) && near(nb.y, ob.y, 3) && near(nb.w, ob.w, 3) && near(nb.h, ob.h, 3), { outline: [ob.x, ob.y, ob.w, ob.h].map(Math.round), landed: nb && [nb.x, nb.y, nb.w, nb.h].map(Math.round) });
  }
  await park();
  return { ...n, moves: moved.map((b) => { const a = after.find((w) => w.id === b.id); return { id: b.id, dx: +(a.x - b.x - dx).toFixed(1), dy: +(a.y - b.y - dy).toFixed(1) }; }) };
}

/* ---------- a full space: flow ---------- */
await park();
R.ok('nothing beside anything at rest', !(await plusNow()).shown && (await outlines()) === 0);
const fb = await scr('w-mck');
await front('w-mck');
// what must not bring it up gets the same 1.5 s a + gets to show
const stillNone = async () => { for (let i = 0; i < 30; i++) { if ((await plusNow()).shown) return false; await sleep(50); } return true; };
await mouse(app, 'mouseMoved', fb.cx, fb.cy + 40);
R.ok('the pointer inside the window brings up no +', await stillNone());
await mouse(app, 'mouseMoved', fb.cx, fb.y + 14);
R.ok('nor does its title bar', await stillNone());
// the border and 4 px each side of it are resizing's (the Finder's way): reaching there brings no +
for (const [x, y, where] of [[fb.r + 2, fb.cy, 'right'], [fb.x - 3, fb.cy, 'left'], [fb.cx, fb.b + 2, 'bottom']]) {
  await mouse(app, 'mouseMoved', x + (where === 'right' ? 60 : where === 'left' ? -60 : 0), y + (where === 'bottom' ? 60 : 0));
  await sleep(300);
  await mouse(app, 'mouseMoved', x, y);
  R.ok(`reaching the ${where} border itself, within the resize band, brings no +`, await stillNone());
}
for (const side of ['right', 'below', 'left', 'above']) {
  await evaluate(app, `__flow.go(0)`);
  await sleep(600);
  const row = await box('.tr[data-act="tab|w-mck|0"]');
  if (row) { await click(app, row.cx, row.cy); await sleep(900); }
  const n = await sameSize('full space (flow)', 'w-mck', side);
  if (side === 'left' && n && n.moves) {
    const wk = n.moves.find((m) => m.id === 'w-week');
    R.ok('on the left, "this week", in the way by a few px, moves down by just that and the gap, not aside', !!wk && Math.abs(wk.dx) < 0.1 && wk.dy > 0 && wk.dy < 6, { moves: n.moves });
  }
}

/* ---------- the gap between two windows is the room double-click's (owner, Nov 1 22:50; lead, 15:5x) ----------
   With the pointer resting in the usual gap between the window in front and a neighbour, no + comes up, and a
   double-click there at a hand's pace opens room between the two and makes nothing. */
{
  await evaluate(app, `__flow.go(0)`);
  await sleep(600);
  const row = await box('.tr[data-act="tab|w-mck|0"]');
  if (row) { await click(app, row.cx, row.cy); await sleep(900); }
  await front('w-mck');
  let side = null, other = null;
  for (const sd of ['below', 'right', 'left', 'above']) { const o = await facing('w-mck', sd); if (o) { side = sd; other = o; break; } }
  if (!side) R.ok('w-mck faces another window within the band on some side, for the gap check', false);
  else {
    const a = await scr('w-mck'), b = await scr(other);
    const mx = (Math.max(a.x, b.x) + Math.min(a.r, b.r)) / 2, my = (Math.max(a.y, b.y) + Math.min(a.b, b.b)) / 2;
    const mid = { below: { x: mx, y: (a.b + b.y) / 2 }, above: { x: mx, y: (b.b + a.y) / 2 }, right: { x: (a.r + b.x) / 2, y: my }, left: { x: (b.r + a.x) / 2, y: my } }[side];
    for (const k of [0.5, 0.8, 1]) { await mouse(app, 'mouseMoved', mid.x + (1 - k) * 60, mid.y + (1 - k) * 40); await sleep(30); }
    await sleep(400);
    const none = await stillNone();
    const before = await wins();
    const dbl = async (n) => { await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', buttons: 1, clickCount: n }); await sleep(40); await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', buttons: 0, clickCount: n }); };
    await dbl(1);
    await sleep(80);
    await dbl(2);
    await sleep(1000);
    const after = await wins(), made = after.filter((w) => !before.some((o) => o.id === w.id)).map((w) => w.id);
    const gap = (list) => { const p = list.find((w) => w.id === 'w-mck'), q = list.find((w) => w.id === other); return side === 'below' ? q.y - (p.y + p.h) : side === 'above' ? p.y - (q.y + q.h) : side === 'right' ? q.x - (p.x + p.w) : p.x - (q.x + q.w); };
    const g0 = gap(before), g1 = gap(after);
    await shot(app, path.join(SHOTS, 'gap-double-click.png'));
    R.ok(`resting in the gap at w-mck's ${side} (${other} there) brings no +, and a double-click opens room between them and makes nothing`, none && !made.length && g1 > g0 + 5, { side, other, none, made, gapBefore: +g0.toFixed(1), gapAfter: +g1.toFixed(1) });
  }
  await park();
}

/* ---------- an empty space: a new workspace with one page ---------- */
const plus = await box('#addws');
await click(app, plus.cx, plus.cy);
await sleep(500);
await type(app, 'beside test');
await key(app, 'Enter');
await sleep(900);
await evaluate(app, `__flow.spawn('page')`);
await sleep(1200);
let solo = (await wins())[0];
R.ok('an empty workspace with one page', (await wins()).length === 1 && solo.type === 'page', await wins());
/* A hand on its way across a side, to the border to resize or out of the window, brings no +: the pointer 10 px out,
   then 30 ms later on the border (or 60 px out). Load can stretch those 30 ms past the + 's wait, so it goes again
   until the page saw them under 80 ms apart. */
async function across(id, to) {
  await front(id);
  const b = await scr(id), y = b.y + b.h * 0.3;
  for (let i = 0; i < 4; i++) {
    await mouse(app, 'mouseMoved', to === 'border' ? b.r + 60 : b.r - 40, y);
    await sleep(500);
    await evaluate(app, `(() => { window.__mv = []; addEventListener('pointermove', window.__mvL = () => __mv.push(performance.now()), true); return true; })()`);
    await mouse(app, 'mouseMoved', b.r + 10, y);
    await sleep(30);
    await mouse(app, 'mouseMoved', to === 'border' ? b.r + 2 : b.r + 60, y);
    const none = await stillNone();
    const ms = await evaluate(app, `(() => { removeEventListener('pointermove', __mvL, true); return __mv.length === 2 ? Math.round(__mv[1] - __mv[0]) : null; })()`);
    if (ms != null && ms < 80) return { none, ms, tries: i + 1 };
  }
  return { none: false, ms: null, tries: 4 };
}
for (const to of ['border', 'out']) {
  const r = await across(solo.id, to);
  R.ok(`passing its right side on the way ${to === 'border' ? 'to its border, to resize it' : 'out of it'}, the pointer brings no +`, r.none, r);
}
await park();
for (const side of ['right', 'left', 'below', 'above']) {
  // back to the one page of the empty space each time
  await sameSize('empty space', solo.id, side);
  const extra = (await wins()).filter((w) => w.id !== solo.id);
  for (const w of extra) {
    const c = await box(`.win[data-id="${w.id}"] > .tb [data-l=close]`);
    if (c) { await click(app, c.cx, c.cy); await sleep(500); }
  }
  await park();
}
solo = (await wins()).find((w) => w.id === solo.id);
/* Its row in the sidebar brings a window into view, wholly (the opens above moved it down past the view's bottom). */
/* A window partly below the view (the opens above moved it down) is dragged by its title bar back to the top. */
async function show(id) {
  const row = await box(`.tr[data-act="tab|${id}|0"]`);
  if (row) { await click(app, row.cx, row.cy); await sleep(900); }
  let b = await scr(id);
  const vp = await box('#viewport');
  const inView = (q) => !!q && q.y >= vp.y - 1 && q.b <= vp.y + vp.h + 1 && q.x >= vp.x - 1 && q.r <= vp.x + vp.w + 1;
  // a blank page has no row: pan the board until it is in view
  if (b && !inView(b)) { await pan(vp.x + 40 - b.x, vp.y + 40 - b.y); b = await scr(id); }
  if (b && (b.b > vp.y + vp.h || b.y < vp.y) && b.y >= vp.y) {
    const sx = b.x + Math.min(b.w / 2, 140), sy = b.y + 14, ty = vp.y + 40;
    await mouse(app, 'mouseMoved', sx, sy);
    await mouse(app, 'mousePressed', sx, sy);
    for (let i = 1; i <= 12; i++) await mouse(app, 'mouseMoved', sx, sy + ((ty - sy) * i) / 12, { down: true });
    await mouse(app, 'mouseReleased', sx, ty);
    await sleep(700);
    b = await scr(id);
  }
  return !!b && b.y >= vp.y - 1 && b.b <= vp.y + vp.h + 1 && b.x >= vp.x - 1 && b.r <= vp.x + vp.w + 1;
}
R.ok('the page is brought wholly into view (its row, then its title bar)', await show(solo.id), await scr(solo.id));

/* ---------- the split in half ---------- */
async function split(label, id, side) {
  await front(id);
  const before = await wins(), b0 = before.find((w) => w.id === id);
  const p = await approach(id, side);
  if (!p.shown) return R.ok(`${label}: the ${side} + comes up to pull in`, false, p);
  const into = { left: [1, 0], right: [-1, 0], above: [0, 1], below: [0, -1] }[side];
  await mouse(app, 'mouseMoved', p.x, p.y);
  await sleep(250);
  await mouse(app, 'mousePressed', p.x, p.y);
  for (let i = 1; i <= 8; i++) await mouse(app, 'mouseMoved', p.x + into[0] * 16 * i, p.y + into[1] * 16 * i, { down: true });
  await sleep(300);
  const lines = await outlines();
  await shot(app, path.join(SHOTS, `split-${side}-pulled.png`));
  await mouse(app, 'mouseReleased', p.x + into[0] * 128, p.y + into[1] * 128);
  await sleep(1300);
  const after = await wins(), src = after.find((w) => w.id === id), added = after.filter((w) => !before.some((b) => b.id === w.id)), n = added[0];
  const X = side === 'left' || side === 'right';
  const half = X ? (b0.w - GAP_X) / 2 : (b0.h - GAP_Y) / 2;
  const shares = n && (X ? near(src.w, half, 0.1) && near(n.w, half, 0.1) && near(src.h, b0.h, 0.05) && near(n.h, b0.h, 0.05) : near(src.h, half, 0.1) && near(n.h, half, 0.1) && near(src.w, b0.w, 0.05) && near(n.w, b0.w, 0.05));
  const inside = n && n.x >= b0.x - 0.05 && n.y >= b0.y - 0.05 && n.x + n.w <= b0.x + b0.w + 0.05 && n.y + n.h <= b0.y + b0.h + 0.05;
  const others = before.filter((b) => b.id !== id).filter((b) => { const a = after.find((w) => w.id === b.id); return !a || Math.abs(a.x - b.x) > 0.05 || Math.abs(a.y - b.y) > 0.05; }).map((b) => b.id);
  R.ok(`${label}: pulling the ${side} + into the window shows two halves, and letting go splits it there in half; nothing else moves`, lines === 2 && added.length === 1 && shares && inside && !others.length,
    { lines, src: src && [src.x, src.y, src.w, src.h].map((v) => +v.toFixed(1)), new: n && [n.x, n.y, n.w, n.h].map((v) => +v.toFixed(1)), was: [b0.x, b0.y, b0.w, b0.h].map((v) => +v.toFixed(1)), others });
  await park();
  return n;
}
const sb = await split('empty space', solo.id, 'below');
if (sb) { const c = await box(`.win[data-id="${sb.id}"] > .tb [data-l=close]`); if (c) { await click(app, c.cx, c.cy); await sleep(500); } }
// a page as wide as a new one (46% of the view, about 570 px) splits side by side: a page's halves may be 240 px (lead, 13:02)
{
  const before = (await wins()).map((w) => w.id);
  await evaluate(app, `__flow.spawn('page')`);
  await sleep(1200);
  const np = (await wins()).find((w) => !before.includes(w.id));
  if (R.ok('a new page of the usual size to split', !!np && np.type === 'page', np)) {
    await show(np.id);

    const width = Math.round((await scr(np.id)).w);
    const half = await split(`a page ${width} px wide`, np.id, 'right');
    for (const id of [np.id, half && half.id].filter(Boolean)) { const c = await box(`.win[data-id="${id}"] > .tb [data-l=close]`); if (c) { await click(app, c.cx, c.cy); await sleep(500); } }
  }
  await park();
}
// a split a half of which would be too small (a note keeps Claude Code's 300 px): pulling in shows no outline and letting
// go makes nothing; a short pull makes nothing either; only a click makes the same size (lead, 12:5x)
{
  const before = (await wins()).map((w) => w.id);
  await evaluate(app, `__flow.spawn('note')`);
  await sleep(1200);
  const nn = (await wins()).find((w) => !before.includes(w.id));
  if (R.ok('a new note to pull on', !!nn && nn.type === 'note', nn)) {
    await show(nn.id);
    await front(nn.id);
    const pull = async (px) => {
      const ids0 = (await wins()).map((w) => w.id), r0 = (await wins()).find((w) => w.id === nn.id);
      const p = await approach(nn.id, 'right');
      await mouse(app, 'mouseMoved', p.x, p.y);
      await sleep(250);
      await mouse(app, 'mousePressed', p.x, p.y);
      const steps = Math.max(2, Math.round(px / 16));
      for (let i = 1; i <= steps; i++) await mouse(app, 'mouseMoved', p.x - (px * i) / steps, p.y, { down: true });
      await sleep(300);
      const lines = await outlines();
      await mouse(app, 'mouseReleased', p.x - px, p.y);
      await sleep(1000);
      const after = await wins(), r1 = after.find((w) => w.id === nn.id);
      return { shown: p.shown, lines, made: after.filter((w) => !ids0.includes(w.id)).length, same: !!r1 && near(r1.w, r0.w, 0.05) && near(r1.h, r0.h, 0.05), width: Math.round((await scr(nn.id)).w) };
    };
    const far = await pull(128);
    R.ok('a split too small to use: pulling the + 128 px in shows no outline, and letting go makes nothing', far.shown && far.lines === 0 && far.made === 0 && far.same, far);
    await park();
    const short = await pull(20);
    R.ok('a short pull (20 px, not past 40) makes nothing either: only a click makes the same size', short.shown && short.lines === 0 && short.made === 0 && short.same, short);
    const c = await box(`.win[data-id="${nn.id}"] > .tb [data-l=close]`);
    if (c) { await click(app, c.cx, c.cy); await sleep(500); }
  }
  await park();
}
// a wider page: moved to the left of the view by its title bar and widened by its corner, as a hand does, then split
await show(solo.id);
await front(solo.id);
{
  const b = await scr(solo.id), vp = await box('#viewport');
  const sx = b.x + Math.min(b.w / 2, 140), sy = b.y + 14, dx = vp.x + 40 - b.x;
  await mouse(app, 'mouseMoved', sx, sy);
  await mouse(app, 'mousePressed', sx, sy);
  for (let i = 1; i <= 12; i++) await mouse(app, 'mouseMoved', sx + (dx * i) / 12, sy, { down: true });
  await mouse(app, 'mouseReleased', sx + dx, sy);
  await sleep(700);
}
const rz = await box(`.win[data-id="${solo.id}"] .rz`);
await mouse(app, 'mouseMoved', rz.cx, rz.cy);
await mouse(app, 'mousePressed', rz.cx, rz.cy);
for (let i = 1; i <= 10; i++) await mouse(app, 'mouseMoved', rz.cx + 30 * i, rz.cy, { down: true });
await mouse(app, 'mouseReleased', rz.cx + 300, rz.cy);
await sleep(600);
const wide = await scr(solo.id);
R.ok('the page is widened by its corner', wide.w > 640, { width: Math.round(wide.w) });
await park();
await split('empty space', solo.id, 'right');
solo = (await wins()).find((w) => w.id === solo.id);

/* ---------- Esc lets go of nothing ---------- */
// on a page of the usual size, whose halves top and bottom are big enough, so the pull shows them before Esc
{
  const ids = (await wins()).map((w) => w.id);
  await evaluate(app, `__flow.spawn('page')`);
  await sleep(1200);
  const ep = (await wins()).find((w) => !ids.includes(w.id));
  if (R.ok('a new page of the usual size for Esc', !!ep && ep.type === 'page', ep)) {
    await show(ep.id);
    await front(ep.id);
    const before = await wins(), b0 = before.find((w) => w.id === ep.id);
    // a side with no window facing it (a facing one is the room's gap and has no +)
    let sd = 'below';
    for (const c of ['below', 'right', 'above', 'left']) if (!(await facing(ep.id, c))) { sd = c; break; }
    const [ux, uy] = { below: [0, -1], above: [0, 1], right: [-1, 0], left: [1, 0] }[sd];
    const p = await approach(ep.id, sd);
    R.ok(`the + ${sd} comes up to pull in`, p.shown, p);
    await mouse(app, 'mouseMoved', p.x, p.y);
    await sleep(250);
    await mouse(app, 'mousePressed', p.x, p.y);
    for (let i = 1; i <= 8; i++) await mouse(app, 'mouseMoved', p.x + ux * 16 * i, p.y + uy * 16 * i, { down: true });
    await sleep(300);
    const pulled = await outlines();
    await key(app, 'Escape');
    await sleep(250);
    const gone = { lines: await outlines(), plus: (await plusNow()).shown };
    await mouse(app, 'mouseReleased', p.x + ux * 128, p.y + uy * 128);
    await sleep(900);
    const after = await wins(), a0 = after.find((w) => w.id === ep.id);
    R.ok('Esc while pulling the + in: the two halves go, letting go makes nothing and the window keeps its size', pulled === 2 && gone.lines === 0 && !gone.plus && after.length === before.length && near(a0.w, b0.w, 0.05) && near(a0.h, b0.h, 0.05), { pulled, gone, before: before.length, after: after.length });
    const c = await box(`.win[data-id="${ep.id}"] > .tb [data-l=close]`);
    if (c) { await click(app, c.cx, c.cy); await sleep(500); }
  }
  await park();
}

/* ---------- the keys' action, and zoomed out ---------- */
{
  await front(solo.id);
  const before = await wins();
  await evaluate(app, `__flow.menu('beside-right')`);
  await sleep(1300);
  const after = await wins(), added = after.filter((w) => !before.some((b) => b.id === w.id)), src = after.find((w) => w.id === solo.id), n = added[0];
  R.ok('the keys\' action (New Beside, Right) opens a page of the same size on the right of the one in front', added.length === 1 && n.type === 'page' && near(n.w, src.w, 0.05) && near(n.x, src.x + src.w + GAP_X), { added: added.length, src: src && [src.x, src.w].map((v) => +v.toFixed(1)), new: n && [n.x, n.w].map((v) => +v.toFixed(1)) });
  const main = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'main.js'), 'utf8');
  R.ok('the menu binds them to ⌃⌘ and the arrows (no Chrome or macOS meaning; ⌥⌘←/→ stays free for a tab habit)', ['Right', 'Left', 'Up', 'Down'].every((k) => main.includes(`'Control+Command+${k}'`)) && !/Alt\+Command\+(Left|Right)/.test(main));
  if (n) { const c = await box(`.win[data-id="${n.id}"] > .tb [data-l=close]`); if (c) { await click(app, c.cx, c.cy); await sleep(500); } }
  await park();
  const sb2 = await scr(solo.id);
  for (let i = 0; i < 10; i++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 300, deltaX: 0, deltaY: 12, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' }); await sleep(10); }
  await sleep(900);
  const z = await evaluate(app, `__flow.nav().zoom(__flow.state().ws[[...document.querySelectorAll('.sp')].indexOf(document.querySelector('.sp.on'))])`);
  // its left side, where there is desktop: on the right its split half sits 1.2% away, which far out is 4 px, inside
  // both windows' resize bands, so no + can come up between them there. The page goes in front first: the keys' page,
  // just closed, had been
  await front(solo.id);
  const p = await approach(solo.id, 'left');
  const ids = (await wins()).map((w) => w.id);
  if (p.shown) { await mouse(app, 'mouseMoved', p.x, p.y); await sleep(250); await click(app, p.x, p.y); await sleep(1300); }
  const made = (await wins()).filter((w) => !ids.includes(w.id));
  R.ok('zoomed out (about 30%), nearing a side still brings up the + at its middle, and a click opens one beside', z < 0.6 && p.shown && onEdge(p) && made.length === 1, { zoom: +z.toFixed(2), plus: p.shown, made: made.length });
  for (const w of made) { const c = await box(`.win[data-id="${w.id}"] > .tb [data-l=close]`); if (c) { await click(app, c.cx, c.cy); await sleep(500); } }
  // back to actual size the owner's way, by pinching in, which stops at exactly 100%
  const zoomNow = () => evaluate(app, `__flow.nav().zoom(__flow.state().ws[[...document.querySelectorAll('.sp')].indexOf(document.querySelector('.sp.on'))])`);
  for (let i = 0; i < 60 && (await zoomNow()) < 0.995; i++) { await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 300, deltaX: 0, deltaY: -6, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' }); await sleep(15); }
  await sleep(900);
  R.ok('pinching back in stops at actual size', Math.abs((await zoomNow()) - 1) < 0.01, { zoom: +(await zoomNow()).toFixed(3) });
  void sb2;
  await park();
}

/* ---------- columns: the tiling places it, right after (or before) the window, never split ---------- */
/* only where the modes still are: batch 8 took them out (owner, 14:03: no float/columns/grid) */
const cols = await box('#modes button[data-m="columns"]');
if (!cols) console.log('note: no columns mode in this build (the modes are gone), so the columns check does not apply');
else {
  await click(app, cols.cx, cols.cy);
  await sleep(900);
  const mode = await evaluate(app, `__flow.state().ws[[...document.querySelectorAll('.sp')].indexOf(document.querySelector('.sp.on'))].mode`);
  const f0 = await front(solo.id);
  const order0 = (await wins()).map((w) => w.id);
  await evaluate(app, `__flow.menu('beside-right')`);
  await sleep(1300);
  const order1 = (await wins()).map((w) => w.id), added = order1.filter((id) => !order0.includes(id));
  const i0 = order1.indexOf(solo.id), i1 = added.length ? order1.indexOf(added[0]) : -1;
  // the new one is in front now; the keys act on the window in front, so the page goes back in front first
  const f1 = await front(solo.id);
  await evaluate(app, `__flow.menu('beside-left')`);
  await sleep(1300);
  const order2 = (await wins()).map((w) => w.id), added2 = order2.filter((id) => !order1.includes(id));
  const j0 = order2.indexOf(solo.id), j1 = added2.length ? order2.indexOf(added2[0]) : -1;
  const sb3 = await scr(added[0] || ''), fr = await evaluate(app, `(() => { const f = document.querySelector('.win.front'); return f && f.dataset.id; })()`);
  R.ok('in columns the tiling places it: right goes just after the window, left just before, both on screen', mode === 'columns' && added.length === 1 && i1 === i0 + 1 && added2.length === 1 && j1 === j0 - 1 && !!sb3 && sb3.w > 50, { mode, f0, f1, front: fr, solo: solo.id, order1, order2 });
  for (const id of [...added, ...added2]) { const c = await box(`.win[data-id="${id}"] > .tb [data-l=close]`); if (c) { await click(app, c.cx, c.cy); await sleep(500); } }
  const flt = await box('#modes button[data-m="float"]');
  await click(app, flt.cx, flt.cy);
  await sleep(900);
  await park();
}

/* ---------- an agent's +: a fresh agent in its folder ---------- */
await evaluate(app, `__flow.go(0)`);
await sleep(900);
{
  const ag = (await wins()).find((w) => w.type === 'term' && w.cmd === 'claude');
  const row = await box(`.tr[data-act="win|${ag.id}"]`);
  if (row) { await click(app, row.cx, row.cy); await sleep(900); }
  const n = await sameSize('agent', ag.id, 'right', 'agent');
  const a = n && (await wins()).find((w) => w.id === n.id);
  R.ok('the agent\'s + opens a fresh agent in the same folder, not a fork', !!a && a.type === 'term' && a.cmd === 'claude' && a.cwd === ag.cwd && !!a.sessionId && a.sessionId !== ag.sessionId && !a.forkFrom, a && { cwd: a.cwd, was: ag.cwd, forkFrom: a.forkFrom || null });
}

/* ---------- what was there before still works ---------- */
// the dock, over bare desktop at the bottom middle of the empty workspace
await evaluate(app, `__flow.go(5)`);
await sleep(900);
await park();
{
  const d0 = await evaluate(app, `(() => { const d = document.getElementById('dock'), r = d.getBoundingClientRect(); return { left: r.left, w: r.width, top: r.top }; })()`);
  const bx = d0.left + d0.w / 2;
  const bare = await evaluate(app, `(() => { const e = document.elementFromPoint(${bx}, ${H - 8}); return !e.closest('.win'); })()`);
  await mouse(app, 'mouseMoved', bx, H * 0.6); await sleep(200);
  await mouse(app, 'mouseMoved', bx, H - 8); await sleep(400);
  const up = await evaluate(app, `(() => { const d = document.getElementById('dock'), cs = getComputedStyle(d); return cs.visibility === 'visible' && cs.pointerEvents === 'auto'; })()`);
  R.ok('the dock still comes up at the bottom middle', bare && up, { bare, up });
  await park();
}
// the edge strip (zoom's F, revised): a double-click on the bare desktop at the right side of the view moves the windows
// lying wholly past that side one view on (100% of the space at actual size), and nothing on screen moves. The + must
// not take it. The board is panned first so the rightmost window lies past that side.
{
  const vp = await box('#viewport');
  const all = await wins();
  const rects = await Promise.all(all.map((w) => scr(w.id)));
  const ri = rects.reduce((bi, r, i) => (r && (bi < 0 || r.r > rects[bi].r) ? i : bi), -1);
  if (ri >= 0) await pan(vp.x + vp.w - rects[ri].x + 40, 0);
  const before = await wins(), sb = await Promise.all(before.map((w) => scr(w.id)));
  const x = vp.x + vp.w - 10, y = vp.y + vp.h * 0.5;
  const bare = await evaluate(app, `(() => { const e = document.elementFromPoint(${x}, ${y}); return !e.closest('.win'); })()`);
  await mouse(app, 'mouseMoved', x, y);
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
  await sleep(900);
  const after = await wins(), sa = await Promise.all(after.map((w) => scr(w.id)));
  const past = before.map((w, i) => (sb[i] && sb[i].x >= vp.x + vp.w ? w.id : null)).filter(Boolean);
  const movedOn = past.length > 0 && past.every((id) => { const b = before.find((w) => w.id === id), a = after.find((w) => w.id === id); return a && near(a.x - b.x, 100, 0.5) && near(a.y, b.y, 0.05); });
  const stayed = before.every((w, i) => past.includes(w.id) || (sb[i] && sa[after.findIndex((o) => o.id === w.id)] && near(sa[after.findIndex((o) => o.id === w.id)].x, sb[i].x, 1) && near(sa[after.findIndex((o) => o.id === w.id)].y, sb[i].y, 1)));
  R.ok('a double-click in the strip at the right side of the view moves the windows past that side one view on, and nothing on screen moves', bare && movedOn && stayed && after.length === before.length, { bare, past, movedOn, stayed });
  await park();
}
// a title-bar drag moves the window and makes nothing
{
  await front(solo.id);
  await park();
  const before = await wins();
  const b = await scr(solo.id);
  const sx = b.x + Math.min(b.w / 2, 140), sy = b.y + 14;
  await mouse(app, 'mouseMoved', sx, sy);
  await mouse(app, 'mousePressed', sx, sy);
  for (let i = 1; i <= 10; i++) await mouse(app, 'mouseMoved', sx + 6 * i, sy + 3 * i, { down: true });
  await mouse(app, 'mouseReleased', sx + 60, sy + 30);
  await sleep(700);
  const a = await scr(solo.id), after = await wins();
  await shot(app, path.join(SHOTS, 'title-bar-drag-after.png'));
  R.ok('a title-bar drag still moves the window (60, 30) and makes nothing', near(a.x - b.x, 60, 3) && near(a.y - b.y, 30, 3) && after.length === before.length, { dx: Math.round(a.x - b.x), dy: Math.round(a.y - b.y) });
  await park();
}
// a window dragged into the space's top margin, in the way of a same-size page on the right of another: it goes right,
// and neither that page nor the space moves (the repro of 13:3x)
{
  // what earlier checks left in this space goes first: on batch 8 the new page opened 15 px from a page an earlier check
  // left, inside the 32 px band in which its right side gets no + (the gap rule)
  for (const w of await wins()) { await show(w.id); const c = await box(`.win[data-id="${w.id}"] > .tb [data-l=close]`); if (c) { await click(app, c.cx, c.cy); await sleep(500); } }
  const ids0 = (await wins()).map((w) => w.id);
  await evaluate(app, `__flow.spawn('page')`);
  await sleep(1200);
  const pg = (await wins()).find((w) => !ids0.includes(w.id));
  await show(pg.id);
  await evaluate(app, `__flow.spawn('note')`);
  await sleep(1200);
  const nt = (await wins()).find((w) => !ids0.includes(w.id) && w.id !== pg.id);
  // the space's top on screen: pan the board down until the page's top sits where the space's top margin puts it
  {
    const vp0 = await box('#viewport'), p0 = await scr(pg.id), g = (await wins()).find((w) => w.id === pg.id);
    const want = vp0.y + 40 + (g.y / 100) * vp0.h;
    if (Math.abs(p0.y - want) > 1) await pan(0, want - p0.y);
  }
  const vp = await box('#viewport'), pb = await scr(pg.id), nb = await scr(nt.id);
  // its title bar to just right of the page, as high as it goes
  const sx = nb.x + Math.min(nb.w / 2, 140), sy = nb.y + 14, tx = pb.r + 40 + Math.min(nb.w / 2, 140), ty = vp.y + 42;
  await mouse(app, 'mouseMoved', sx, sy);
  await mouse(app, 'mousePressed', sx, sy);
  for (let i = 1; i <= 12; i++) await mouse(app, 'mouseMoved', sx + ((tx - sx) * i) / 12, sy + ((ty - sy) * i) / 12, { down: true });
  await mouse(app, 'mouseReleased', tx, ty);
  await sleep(700);
  const b = await wins(), pg0 = b.find((w) => w.id === pg.id), nt0 = b.find((w) => w.id === nt.id);
  const inMargin = nt0.y < 6.5 && nt0.x < pg0.x + 2 * pg0.w;
  const n = await sameSize('beside a page, a note in the top margin', pg.id, 'right');
  const a = await wins(), pg1 = a.find((w) => w.id === pg.id), nt1 = a.find((w) => w.id === nt.id);
  R.ok('the note in the top margin goes right, and the page and the space stay put', inMargin && !!n && near(pg1.x, pg0.x, 0.05) && near(pg1.y, pg0.y, 0.05) && nt1.x > nt0.x + 1 && near(nt1.y, nt0.y, 0.05), { inMargin, page: [pg0.x, pg0.y, pg1.x, pg1.y].map((v) => +v.toFixed(1)), note: [nt0.x, nt0.y, nt1.x, nt1.y].map((v) => +v.toFixed(1)) });
  await park();
}
// the corner map, in a workspace with part of its space off screen
await evaluate(app, `__flow.go(2)`);
await sleep(1200);
await park();
{
  await mouse(app, 'mouseMoved', W - 60, H - 30); await sleep(700);
  const ov = await evaluate(app, `(() => { const e = document.querySelector('.ov'); if (!e) return null; const cs = getComputedStyle(e); return cs.visibility === 'visible' && +cs.opacity > 0.5; })()`);
  const bare = await evaluate(app, `!document.elementFromPoint(${W - 60}, ${H - 30}).closest('.win')`);
  R.ok('the corner map still comes up on a dwell at the bottom right', ov === true && bare, { ov, bare });
  await park();
}
R.ok('no console errors or exceptions', !app.errors.length, app.errors.slice(0, 5));
R.summary();
process.exit();




