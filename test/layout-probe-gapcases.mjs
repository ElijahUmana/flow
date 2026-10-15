// layout's probe of two drops in a gap between two windows side by side (lead 18:5x, batch 8): Sept's E5 geometry rebuilt
// with shells (a team 46x50 at 9,20.47, its first teammate 1.3% past it, a second past that, zoomed out) and a note
// carried into the gap; and a right-click "new note here" in the gap between "this week" and the term beside it. Real
// input over CDP in layout's own isolated app. Shells only, pages blank.
//   LAYOUT_ROOT=<app tree> node test/layout-probe-gapcases.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse } from './nav-lib.mjs';
import { USER_DATA, ROOT, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], wins = {};
  ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect(); wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, type: w.type, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  const vp = document.getElementById('viewport').getBoundingClientRect(); return { zoom: ws.zoom || 1, vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins }; })()`);
async function goSettled(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  let last = null;
  for (let k = 0; k < 40; k++) {
    await sleep(150);
    const s = await now(), key = q(Object.values(s.wins).map((r) => [Math.round(r.sx), Math.round(r.sy)]));
    if (key === last) return s;
    last = key;
  }
  return now();
}
function overlaps(s) {
  const ids = Object.keys(s.wins), out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = s.wins[ids[i]], b = s.wins[ids[j]];
    if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) out.push(`${ids[i]}/${ids[j]}`);
  }
  return out;
}
const made = (a, b) => Object.keys(b.wins).filter((id) => !a.wins[id]);
let px = 700, py = 400;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); px = x; py = y; }
const outline = () => ev(`(() => { const g = [...document.getElementById('viewport').children].find((e) => (e.style.borderStyle === 'dashed' || /dashed/.test(e.style.border)) && e.style.display !== 'none'); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function carry(kind, x, y) {
  const d = await ev(`(() => { const r = document.getElementById('dock').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 12 - 5 }; })()`);
  await glide(d.x, d.y, 12);
  await sleep(400);
  const b = await ev(`(() => { const d = document.getElementById('dock'), b = d.querySelector('button[data-k=${q(kind)}]'), r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(d).opacity > 0.9 && d.style.pointerEvents !== 'none' }; })()`);
  if (!b.shown) throw new Error(`the dock did not come up before carrying ${kind}`);
  await glide(b.x, b.y, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let k = 1; k <= 24; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + ((x - b.x) * k) / 24, y: b.y + ((y - b.y) * k) / 24, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(16); }
  await sleep(150);
  const seen = await outline();
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  px = x; py = y;
  await sleep(1200);
  return seen;
}
async function hereMenu(x, y, kind) {
  await glide(x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(400);
  const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => x.textContent.trim().startsWith(${q('new ' + kind)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!item) return false;
  await glide(item.x, item.y, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: item.x, y: item.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: item.x, y: item.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1200);
  return true;
}
/* moves as drawn, in % of the view, so the space growing at its start does not count as a move */
const drawn = (s, r) => ({ x: ((r.sx - s.vp.x) / s.vp.w) * 100, y: ((r.sy - s.vp.y) / s.vp.h) * 100 });
const movesOn = (a, b) => Object.keys(a.wins).map((id) => { const p = drawn(a, a.wins[id]), n = drawn(b, b.wins[id]); return [id, +(n.x - p.x).toFixed(2), +(n.y - p.y).toFixed(2)]; }).filter(([, dx, dy]) => Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1);

async function main() {
  console.log(`tree ${ROOT}`);
  await writeSeed();
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => { ws.mode = 'float'; (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }); });
  const infra = state.ws.find((w) => w.id === 'infra'), put = (id, r) => Object.assign(infra.windows.find((w) => w.id === id), { x: r[0], y: r[1], w: r[2], h: r[3] });
  put('i-bench', [9, 20.47, 46, 50]); put('i-sched', [56.3, 20.47, 36, 44]); put('i-team', [93.5, 20.47, 36, 44]); put('i-note', [9, 80, 97.6, 28]);
  infra.zoom = 0.6; infra.pan = 0; infra.panY = 0;
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();

  /* 1. Sept's E5 with shells: a note carried into the 1.3% gap between the "team" and its first "teammate", at the middle
     of their shared height */
  const s0 = await goSettled('infra'), A = s0.wins['i-bench'], B = s0.wins['i-sched'];
  console.log(`E5 geometry: zoom ${s0.zoom}; team ${q([A.x, A.y, A.w, A.h])} on screen ${q([A.sx, A.sy, A.sw, A.sh].map(Math.round))}; first teammate ${q([B.x, B.y, B.w, B.h])}`);
  const G = { x: (A.sx + A.sw + B.sx) / 2, y: (Math.max(A.sy, B.sy) + Math.min(A.sy + A.sh, B.sy + B.sh)) / 2 };
  const seen = await carry('note', G.x, G.y);
  const s1 = await now(), n1 = made(s0, s1), N = n1.length === 1 && s1.wins[n1[0]];
  const mv = movesOn(s0, s1);
  console.log(`E5: new ${q(N && [N.x, N.y, N.w, N.h])}; outline ${q(seen)}; moved on screen ${q(mv)}`);
  ok('E5: one new window, opened where its outline showed', !!N && !!seen && near(N.sx, seen.x, 3) && near(N.sy, seen.y, 3) && near(N.sw, seen.w, 3), { at: N && [N.sx, N.sy, N.sw], seen });
  ok('E5: beside the team, the usual gap off it, and level with it', !!N && near(N.x, A.x + A.w + 1.2, 0.3) && near(N.y, A.y, 0.3), { at: N && [N.x, N.y], team: [A.x, A.y, A.w] });
  ok('E5: the team stays; the two teammates make way together, right', near(s1.wins['i-bench'].x, A.x, 0.05) && near(s1.wins['i-bench'].y, A.y, 0.05)
    && ['i-sched', 'i-team'].every((id) => mv.some(([m, dx, dy]) => m === id && dx > 5 && Math.abs(dy) < 0.1)) && near(s1.wins['i-sched'].x - s0.wins['i-sched'].x, s1.wins['i-team'].x - s0.wins['i-team'].x, 0.05), mv);
  ok('E5: over no window', overlaps(s1).length === 0, overlaps(s1));

  /* 2. right-click "new note here" in the gap between "this week" and the term beside it (flows' gap) */
  const t0 = await goSettled('flow'), W = t0.wins['w-week'], D = t0.wins['w-design'];
  const H = { x: Math.round((W.sx + W.sw + D.sx) / 2), y: Math.round((Math.max(W.sy, D.sy) + Math.min(W.sy + W.sh, D.sy + D.sh)) / 2) };
  const under = await ev(`(() => { const e = document.elementFromPoint(${H.x}, ${H.y}); return e ? (e.closest('.win') ? 'window ' + e.closest('.win').dataset.id : e.className || e.tagName) : null; })()`);
  console.log(`flow gap ${(D.sx - W.sx - W.sw).toFixed(1)} px; right-click at ${q(H)} on ${under}`);
  ok('right-click in the gap offers "new note here"', await hereMenu(H.x, H.y, 'note'));
  const t1 = await now(), n2 = made(t0, t1), M = n2.length === 1 && t1.wins[n2[0]], mv2 = movesOn(t0, t1);
  console.log(`right-click: new ${q(M && [M.x, M.y, M.w, M.h])} on screen ${q(M && [M.sx, M.sy, M.sw, M.sh].map(Math.round))}; moved on screen ${q(mv2)}`);
  const left = Object.keys(t0.wins).filter((id) => t0.wins[id].sx + t0.wins[id].sw <= H.x);
  const jumped = M ? left.filter((id) => t1.wins[id].sx >= M.sx + M.sw - 1) : [];
  ok('right-click: one new note, over no window', !!M && overlaps(t1).length === 0, { made: n2, overlaps: overlaps(t1) });
  ok('right-click: nothing that was left of the gap is now right of the note', !!M && jumped.length === 0, { jumped, left });
  ok('right-click: "this week" stays where it is', near(t1.wins['w-week'].sx, W.sx, 1) && near(t1.wins['w-week'].sy, W.sy, 1), { before: [W.sx, W.sy], after: [t1.wins['w-week'].sx, t1.wins['w-week'].sy] });
  ok('right-click: the note beside it, the usual gap away, level with it as far as the view allows', !!M && near(M.sx, W.sx + W.sw + t1.vp.w * 0.012, 2) && M.sy <= W.sy + 1 && M.sy + M.sh <= t1.vp.y + t1.vp.h + 1, { note: M && [M.sx, M.sy, M.sh], week: [W.sx + W.sw, W.sy] });
  ok('right-click: nothing that made way went up or left', mv2.every(([, dx, dy]) => dx > -0.1 && dy > -0.1), mv2);
  const errs = c.errors.filter((e) => !/net::|Failed to load resource|ERR_/.test(e));
  ok('no console errors', errs.length === 0, errs.slice(0, 5));
}

try {
  if (running()) throw new Error('layout\'s app is already running');
  await main();
} catch (e) {
  fails++;
  console.log(`FAIL ${e.stack || e}`);
} finally {
  try { if (c) c.close(); } catch {}
  if (!KEEP) await stop();
  console.log(`${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}




