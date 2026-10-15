// layout's probe of two batch 9 edges of a drop (lead 20:0x), with real input over CDP in layout's own isolated app:
// a note let go 4 px into the gap above a window whose open strip above is exactly one note tall (nothing moves, and the
// outline while carried is exactly where it lands), and a note let go on the left half of serving notes, which kv cache
// bench crowds 0.8% off its left (no row place: the right-or-down push, the known fail). Shells only, pages blank.
//   LAYOUT_ROOT=<app tree> node test/layout-probe-dropedge.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse } from './nav-lib.mjs';
import { USER_DATA, ROOT, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0, knowns = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
/* on the known list (lead 20:0x): a miss is reported, not counted as a failure */
function known(name, pass, detail) {
  if (pass) oks++; else knowns++;
  console.log(`${pass ? 'ok  ' : 'KNOWN'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], wins = {};
  ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect(); wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  const vp = document.getElementById('viewport').getBoundingClientRect(); return { vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins }; })()`);
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
  await sleep(200);
  const seen = await outline();
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  px = x; py = y;
  await sleep(1200);
  return seen;
}
const drawn = (s, r) => ({ x: ((r.sx - s.vp.x) / s.vp.w) * 100, y: ((r.sy - s.vp.y) / s.vp.h) * 100 });
const movesOn = (a, b) => Object.keys(a.wins).map((id) => { const p = drawn(a, a.wins[id]), n = drawn(b, b.wins[id]); return [id, +(n.x - p.x).toFixed(2), +(n.y - p.y).toFixed(2)]; }).filter(([, dx, dy]) => Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1);

async function main() {
  console.log(`tree ${ROOT}`);
  await writeSeed();
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => { ws.mode = 'float'; (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }); });
  const ef = state.ws.find((w) => w.id === 'ef'), put = (id, r) => Object.assign(ef.windows.find((w) => w.id === id), { x: r[0], y: r[1], w: r[2], h: r[3] });
  put('e-note', [1.2, 6.6, 44, 81.8]); put('e-page', [49.4, 54.4, 49.4, 40]); put('e-term', [120, 6.6, 40, 40]);
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();

  /* 1. the strip above e-page, 6.6 to 52.6, is exactly one note tall; let go 4 px into the 1.8% gap above e-page */
  const a0 = await goSettled('ef'), P = a0.wins['e-page'];
  const H = { x: Math.round(P.sx + P.sw / 2), y: Math.round(P.sy - a0.vp.h * 0.018 + 4) };
  const seen = await carry('note', H.x, H.y);
  const a1 = await now(), n1 = made(a0, a1), N = n1.length === 1 && a1.wins[n1[0]], mv = movesOn(a0, a1);
  console.log(`strip edge: hand ${q(H)}, e-page's top ${P.sy}; outline ${q(seen)}; new ${q(N && [N.x, N.y, N.w, N.h, N.sx, N.sy, N.sw, N.sh])}; moved ${q(mv)}`);
  ok('let go just inside the gap above a window: one new note, over no window, nothing moves', !!N && overlaps(a1).length === 0 && mv.length === 0, { made: n1, overlaps: overlaps(a1), moved: mv });
  ok('the outline while carried is exactly where it lands', !!N && !!seen && near(seen.x, N.sx, 1) && near(seen.y, N.sy, 1) && near(seen.w, N.sw, 1) && near(seen.h, N.sh, 1), { outline: seen, at: N && [N.sx, N.sy, N.sw, N.sh] });
  ok('it fills the strip above, the hand within the usual gap of its bottom edge', !!N && near(N.y, 6.6, 0.05) && H.y >= N.sy + N.sh - 1 && H.y <= N.sy + N.sh + a1.vp.h * 0.018 + 1, { top: N && N.y, bottom: N && N.sy + N.sh, hand: H.y });

  /* 2. infra: let go on the left half of serving notes, which kv cache bench crowds 0.8% off its left. Its place would
     cover kv cache bench, which is level with it and starts left of it, so there is no row place: the right-or-down
     push, which can carry a window over the new one (lead 20:0x: known list) */
  const b0 = await goSettled('infra'), S = b0.wins['i-sched'], B = b0.wins['i-bench'];
  console.log(`infra: kv cache bench to serving notes ${(S.x - B.x - B.w).toFixed(2)}%`);
  const O = { x: Math.round(S.sx + S.sw * 0.25), y: Math.round(S.sy + S.sh * 0.5) };
  const seen2 = await carry('note', O.x, O.y);
  const b1 = await now(), n2 = made(b0, b1), M = n2.length === 1 && b1.wins[n2[0]], mv2 = movesOn(b0, b1);
  console.log(`left half of serving notes: hand ${q(O)}; new ${q(M && [M.x, M.y, M.w, M.h])}; moved ${q(mv2)}`);
  ok('crowded neighbour: one new note, over no window, where its outline showed', !!M && overlaps(b1).length === 0 && !!seen2 && near(seen2.x, M.sx, 1) && near(seen2.y, M.sy, 1), { made: n2, overlaps: overlaps(b1), outline: seen2, at: M && [M.sx, M.sy] });
  const left = Object.keys(b0.wins).filter((id) => b0.wins[id].sx + b0.wins[id].sw <= O.x);
  /* over it: from left of its left edge to past its right one, or from above its top to below its bottom */
  const over = M ? left.filter((id) => (b0.wins[id].sx < M.sx && b1.wins[id].sx >= M.sx + M.sw - 1) || (b0.wins[id].sy < M.sy && b1.wins[id].sy >= M.sy + M.sh - 1)) : left;
  known('crowded neighbour: nothing that was left of the hand ends past the new note', !!M && over.length === 0, { over, left });
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
  console.log(`${oks} ok, ${fails} failed${knowns ? `, ${knowns} known` : ''}`);
  process.exit(fails ? 1 : 0);
}




