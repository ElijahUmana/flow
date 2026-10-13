// layout's check of the never-cover rule when a resize is let go (lead, batch 7; nav.clear): the windows the resized one now
// covers make way, each its own way by just enough (right for one to its right, down for one below it), what they run into
// the same way, the resized window staying as it was left. Real input over CDP: the window's corner handle pulled with
// the mouse in layout's own isolated app (layout-lib.mjs). Shells only.
//   LAYOUT_ROOT=<app tree> [EDGES=1] node test/layout-clear.mjs [--keep]     EDGES=1: also a left and a top edge (four-edge resize)     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/clear-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, shot as shotOf } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'clear-shots');
const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const box = (r) => r && [+r.x.toFixed(2), +r.y.toFixed(2), +r.w.toFixed(2), +r.h.toFixed(2)];
/* The space on screen: each window in % and as drawn (px). Moves are judged as drawn, in % of the view: when the space
   grows at its start, every window's numbers change together while nothing moves on screen. */
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], at = ws.at || null;
  const vp = document.getElementById('viewport').getBoundingClientRect(), wins = {};
  ws.windows.filter((w) => (w.zone || null) === at).forEach((w) => { const b = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']').getBoundingClientRect();
    wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, sx: b.left, sy: b.top, sw: b.width, sh: b.height }; });
  return { vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins }; })()`);
const shown = (s, id) => { const r = s.wins[id]; return { x: ((r.sx - s.vp.x) / s.vp.w) * 100, y: ((r.sy - s.vp.y) / s.vp.h) * 100, w: (r.sw / s.vp.w) * 100, h: (r.sh / s.vp.h) * 100 }; };
function overlaps(s) {
  const ids = Object.keys(s.wins), out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = s.wins[ids[i]], b = s.wins[ids[j]];
    if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) out.push(`${ids[i]}/${ids[j]}`);
  }
  return out;
}
/* The corner handle of id pulled by dx, dy px with the mouse, held still, let go. */
/* A point of id's grip d (null: the first, the corner) where a press reaches it: its middle, else stepping in from
   there toward the window's own inside (a grip that straddles the border reaches only inside it when the window clips). */
const gripAt = (id, d) => ev(`(() => { const win = document.querySelector('.win[data-id=${q(id)}]'), e = win.querySelector(${q(d ? `.rz[data-rz="${d}"]` : '.rz')});
  if (!e) return null; const b = e.getBoundingClientRect(), wb = win.getBoundingClientRect(), cx = (wb.left + wb.right) / 2, cy = (wb.top + wb.bottom) / 2;
  let x = b.left + b.width / 2, y = b.top + b.height / 2;
  for (let k = 0; k < 12; k++) { if (document.elementFromPoint(x, y) === e) return { x, y }; x += Math.sign(cx - x) * (b.width < b.height || b.width === b.height ? 1 : 0); y += Math.sign(cy - y) * (b.height < b.width || b.width === b.height ? 1 : 0); }
  return null; })()`);
async function pullCorner(id, dx, dy) {
  const h = await gripAt(id, null);
  if (!h) throw new Error(`no point of ${id}'s corner grip takes a press`);
  await mouse(c, 'mouseMoved', h.x, h.y);
  await mouse(c, 'mousePressed', h.x, h.y);
  for (let k = 1; k <= 12; k++) { await mouse(c, 'mouseMoved', h.x + (dx * k) / 12, h.y + (dy * k) / 12, { down: true }); await sleep(20); }
  await sleep(200);
  await mouse(c, 'mouseReleased', h.x + dx, h.y + dy);
  await sleep(1300);
}
/* Goes to a workspace and waits until its windows stop moving on screen (the switch slides it in, slower on a busy
   machine), so the grips are read where they are. */
async function goSettled(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  let last = null;
  for (let k = 0; k < 40; k++) {
    await sleep(150);
    const s = await now(), key = JSON.stringify(Object.values(s.wins).map((r) => [Math.round(r.sx), Math.round(r.sy)]));
    if (key === last) return s;
    last = key;
  }
  return now();
}
/* The grip on side d ('w' left, 'n' top, as backlog's four-edge resize draws them) of id pulled by dx, dy px. */
async function pullEdge(id, d, dx, dy) {
  const has = await ev(`!!document.querySelector('.win[data-id=${q(id)}] .rz[data-rz=${q(d)}]')`);
  if (!has) throw new Error(`no ${d} grip on ${id}: this tree has no four-edge resize`);
  const h = await gripAt(id, d);
  if (!h) throw new Error(`no point of ${id}'s ${d} grip takes a press`);
  await mouse(c, 'mouseMoved', h.x, h.y);
  await mouse(c, 'mousePressed', h.x, h.y);
  for (let k = 1; k <= 12; k++) { await mouse(c, 'mouseMoved', h.x + (dx * k) / 12, h.y + (dy * k) / 12, { down: true }); await sleep(20); }
  await sleep(200);
  await mouse(c, 'mouseReleased', h.x + dx, h.y + dy);
  await sleep(1300);
}
/* After a pull: the pulled window kept what the hand gave it; exactly moved made way, each by just enough to stand the
   usual gap off it, the way given; nothing over anything. */
function checks(label, s0, s1, id, moved) {
  const W = shown(s1, id);
  const shifted = Object.keys(s0.wins).filter((o) => o !== id && (!near(shown(s1, o).x, shown(s0, o).x, 0.1) || !near(shown(s1, o).y, shown(s0, o).y, 0.1)));
  const by = Object.fromEntries(shifted.map((o) => [o, [+(shown(s1, o).x - shown(s0, o).x).toFixed(2), +(shown(s1, o).y - shown(s0, o).y).toFixed(2)]]));
  console.log(`${label}: ${id} ${q(box(shown(s0, id)))} -> ${q(box(W))} on screen; moved ${q(by)}`);
  const way = { right: ([dx, dy]) => dx > 0 && near(dy, 0, 0.1), left: ([dx, dy]) => dx < 0 && near(dy, 0, 0.1), down: ([dx, dy]) => dy > 0 && near(dx, 0, 0.1), up: ([dx, dy]) => dy < 0 && near(dx, 0, 0.1) };
  ok(`${label}: only ${Object.keys(moved).join(', ')} made way, each its own way (${Object.values(moved).join(', ')}), and nothing else moved on screen`, q(shifted.sort()) === q(Object.keys(moved).sort()) && Object.entries(moved).every(([o, dir]) => way[dir](by[o])), by);
  const first = Object.entries(moved)[0];
  if (first) {
    const [o, dir] = first, r = shown(s1, o);
    const gap = dir === 'right' ? r.x - (W.x + W.w) : dir === 'left' ? W.x - (r.x + r.w) : dir === 'down' ? r.y - (W.y + W.h) : W.y - (r.y + r.h);
    ok(`${label}: ${o} stands the usual gap off it, no more`, near(gap, dir === 'right' || dir === 'left' ? 1.2 : 1.8, 0.1), { gap: +gap.toFixed(2) });
  }
  ok(`${label}: no window over another`, overlaps(s1).length === 0, overlaps(s1));
  return W;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => { ws.mode = ws.mode || 'float'; (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }); });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();
  await goSettled('infra');

  /* 1. kv cache bench's corner pulled right by a tenth of the view, over serving notes: it goes right, and the team it
     then runs into goes the same way */
  const s0 = await now();
  await pullCorner('i-bench', Math.round(s0.vp.w * 0.1), 0);
  const s1 = await now(), W1 = checks('infra, i-bench pulled right over i-sched', s0, s1, 'i-bench', { 'i-sched': 'right', 'i-team': 'right' });
  ok('infra: i-bench kept the width the hand gave it', near(W1.w, shown(s0, 'i-bench').w + 10, 0.2) && near(W1.h, shown(s0, 'i-bench').h, 0.1), box(W1));
  await shotOf(c, path.join(SHOTS, '01-right.png'));

  /* 2. then pulled down over the note under it: the note goes down */
  await pullCorner('i-bench', 0, Math.round(s1.vp.h * 0.06));
  const s2 = await now(), W2 = checks('infra, i-bench pulled down over i-note', s1, s2, 'i-bench', { 'i-note': 'down' });
  ok('infra: i-bench kept the height the hand gave it', near(W2.h, shown(s1, 'i-bench').h + 6, 0.2), box(W2));
  await shotOf(c, path.join(SHOTS, '02-down.png'));

  /* 3. with four-edge resize: the shared notes page's left edge pulled left over the note beside it. What you push moves
     away from the edge you push (lead 16:1x, batch 8): the note goes left by just enough, the space growing at its start,
     nothing else moving on screen */
  if (process.env.EDGES) {
    const m0 = await goSettled('mynotes');
    await pullEdge('mn-page', 'w', -Math.round(m0.vp.w * 0.1), 0);
    const m1 = await now(), P = checks('mynotes, mn-page\'s left edge pulled left over mn-note', m0, m1, 'mn-page', { 'mn-note': 'left' });
    const P0 = shown(m0, 'mn-page');
    ok('mynotes: mn-page kept the left edge the hand gave it', near(P.x, P0.x - 10, 0.2) && near(P.x + P.w, P0.x + P0.w, 0.1), box(P));
    await shotOf(c, path.join(SHOTS, '03-left.png'));
    /* 4. a shell's top edge pulled up over the note above it: the note goes up by just enough, the space growing at its
       top where that goes past it, nothing else moving on screen */
    const v0 = await goSettled('voiceless');
    await pullEdge('v-term', 'n', 0, -Math.round(v0.vp.h * 0.06));
    const v1 = await now(), T = checks('voiceless, v-term\'s top edge pulled up over v-note', v0, v1, 'v-term', { 'v-note': 'up' });
    const T0 = shown(v0, 'v-term');
    ok('voiceless: v-term kept the top edge the hand gave it', near(T.y, T0.y - 6, 0.2) && near(T.y + T.h, T0.y + T0.h, 0.1), box(T));
    await shotOf(c, path.join(SHOTS, '04-top.png'));
  }

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




