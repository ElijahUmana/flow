// layout's check of where a dock button carried out and let go puts its window (lead 16:1x, from browse's walk of a busy
// space: a drop in a gap moved 8 windows a page width, a drop on a page moved 12, a drop at the right edge landed out of
// view). The rule: the window takes the open space at the hand, sized to it down to the smallest of use (300x160 px);
// else a small nudge of the new window itself; only then do the windows directly in its way move, each its own shortest
// way by just enough, and what they run into the same way. Never a row a page width; never out of view. Real input over
// CDP in layout's own isolated app (layout-lib.mjs): the flow space filled with pages first, then the dock's page button
// carried to an empty spot, onto a page and to the right edge. Shells only, pages blank.
//   LAYOUT_ROOT=<app tree> node test/layout-drop.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/drop-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, shot as shotOf } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'drop-shots');
const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const r2 = (v) => +v.toFixed(2);
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const box = (r) => r && [r2(r.x), r2(r.y), r2(r.w), r2(r.h)];
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], at = ws.at || null;
  const vp = document.getElementById('viewport').getBoundingClientRect(), wins = {};
  ws.windows.filter((w) => (w.zone || null) === at).forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect();
    wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, type: w.type, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  return { vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins, pan: ws.panUnit === '%' ? ((ws.pan || 0) / 100) * vp.width : ws.pan || 0,
    panY: ws.panUnit === '%' ? ((ws.panY || 0) / 100) * vp.height : ws.panY || 0, zoom: ws.zoom || 1 }; })()`);
const hit = (a, b) => a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05;
function overlaps(s) {
  const ids = Object.keys(s.wins), out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (hit(s.wins[ids[i]], s.wins[ids[j]])) out.push(`${ids[i]}/${ids[j]}`);
  return out;
}
async function goTo(id) { await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`); await sleep(900); }
/* The dock's page button, the dock brought up by the pointer at the bottom middle, as a hand does. */
async function dockPage() {
  const v = await ev(`(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 6 }; })()`);
  await mouse(c, 'mouseMoved', v.x, v.y);
  await sleep(800);
  const d = await ev(`(() => { const b = document.querySelector('#dock button[data-k="page"]'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  if (d) { await mouse(c, 'mouseMoved', d.x, d.y); await sleep(300); }
  return d;
}
/* The page button carried to a point and let go there, in 14 moves, held still a moment before the release. */
async function carry(to) {
  const d = await dockPage();
  if (!d) throw new Error('no dock page button');
  await mouse(c, 'mousePressed', d.x, d.y);
  for (let i = 1; i <= 14; i++) { await mouse(c, 'mouseMoved', d.x + ((to.x - d.x) * i) / 14, d.y + ((to.y - d.y) * i) / 14, { down: true }); await sleep(30); }
  await sleep(250);
  await mouse(c, 'mouseReleased', to.x, to.y);
  await sleep(1500);
}
/* What a drop did, judged by the rule: one new window, over none, in view, the hand on it; what moved, and by how much. */
/* A window as drawn, in % of the view: when the space grows at its start every window's numbers change together while
   nothing moves on screen, so moves are judged as drawn. */
const shown = (s, id) => { const r = s.wins[id]; return { x: ((r.sx - s.vp.x) / s.vp.w) * 100, y: ((r.sy - s.vp.y) / s.vp.h) * 100, w: (r.sw / s.vp.w) * 100, h: (r.sh / s.vp.h) * 100 }; };
function judge(label, s0, s1, to, { gap, row, low } = {}) {
  const made = Object.keys(s1.wins).filter((id) => !s0.wins[id]), N = made.length === 1 ? shown(s1, made[0]) : null;
  if (N) Object.assign(N, { type: s1.wins[made[0]].type, sx: s1.wins[made[0]].sx, sy: s1.wins[made[0]].sy, sw: s1.wins[made[0]].sw, sh: s1.wins[made[0]].sh });
  const moved = Object.keys(s0.wins).filter((id) => Math.abs(shown(s1, id).x - shown(s0, id).x) > 0.1 || Math.abs(shown(s1, id).y - shown(s0, id).y) > 0.1);
  const by = Object.fromEntries(moved.map((id) => [id, [r2(shown(s1, id).x - shown(s0, id).x), r2(shown(s1, id).y - shown(s0, id).y)]]));
  console.log(`${label}: new ${q(N && [N.type, ...box(N)])} on screen; moved on screen ${moved.length}: ${q(by)}`);
  ok(`${label}: one new page window`, !!N && N.type === 'page', made);
  if (!N) return;
  ok(`${label}: it covers no window, and none covers another`, overlaps(s1).length === 0, overlaps(s1));
  const inView = N.sx >= s1.vp.x - 1 && N.sy >= s1.vp.y - 1 && N.sx + N.sw <= s1.vp.x + s1.vp.w + 1 && N.sy + N.sh <= s1.vp.y + s1.vp.h + 1;
  ok(`${label}: it is wholly in view, where the hand let go`, inView && to.x >= N.sx - 20 && to.x <= N.sx + N.sw + 20 && to.y >= N.sy - 40 && to.y <= N.sy + N.sh, { page: [r2(N.sx), r2(N.sy), r2(N.sw), r2(N.sh)], hand: to, vp: s1.vp });
  ok(`${label}: no smaller than 300x160 px`, N.sw >= 299.5 && N.sh >= 159.5, [r2(N.sw), r2(N.sh)]);
  if (gap) ok(`${label}: the gap holds it, so nothing else moves`, moved.length === 0, by);
  /* each that moved went just clear of the new window (the usual gap kept), or ran into one that moved and went the same
     way by the same amount */
  const clear = (id) => { const q = shown(s0, id), [dx, dy] = by[id]; return (Math.abs(dy) < 0.1 && Math.abs(dx - (N.x + N.w + 1.2 - q.x)) < 0.2) || (Math.abs(dx) < 0.1 && Math.abs(dy - (N.y + N.h + 1.8 - q.y)) < 0.2); };
  const padS = (a, b) => a.x < b.x + b.w + 1.2 - 0.05 && b.x < a.x + a.w + 1.2 - 0.05 && a.y < b.y + b.h + 1.8 - 0.05 && b.y < a.y + a.h + 1.8 - 0.05;
  const dragged = (id) => moved.some((m) => m !== id && Math.abs(by[m][0] - by[id][0]) < 0.1 && Math.abs(by[m][1] - by[id][1]) < 0.1 && padS(shown(s0, id), shown(s1, m)));
  const unexplained = moved.filter((id) => !clear(id) && !dragged(id));
  ok(`${label}: each that moved went just clear of it, or was run into by one that moved`, unexplained.length === 0, { unexplained, by });
  const direct = moved.filter((id) => hit(shown(s0, id), { x: N.x - 1.2, y: N.y - 1.8, w: N.w + 2.4, h: N.h + 3.6 }));
  const chained = moved.filter((id) => !direct.includes(id));
  const reason = chained.every((id) => moved.some((m) => m !== id && hit(shown(s0, id), { x: shown(s1, m).x - 1.2, y: shown(s1, m).y - 1.8, w: shown(s1, m).w + 2.4, h: shown(s1, m).h + 3.6 })));
  ok(`${label}: only what was in its way moved, and what that ran into`, reason, { direct, chained });
  /* lead 17:15: right or down only; what was in view and in its way stays in view when a right or down move keeps it so */
  ok(`${label}: nothing that made way went up or left`, moved.every((id) => by[id][0] > -0.1 && by[id][1] > -0.1), by);
  const seenR = (r) => r.y >= -0.1 && r.y + 3.3 <= 100 && Math.min(r.x + r.w, 100) - Math.max(r.x, 0) >= Math.min(r.w, 9.6);
  const lost = direct.filter((id) => { const q = shown(s0, id); if (!seenR(q) || seenR(shown(s1, id)) || !clear(id)) return false;
    return seenR({ ...q, x: N.x + N.w + 1.2 }) || seenR({ ...q, y: N.y + N.h + 1.8 }); });
  if (!row) { ok(`${label}: what was in view and in its way stays in view where a right or down move keeps it so`, lost.length === 0, lost); return; }
  /* let go on the left half of window row (batch 9, lead 19:2x): the new one in its place, level with it as far as the
     view allows; it moves right just clear of the new one, with what is past it; a row below reaching under it goes
     down; nothing that was left of it ends right of the new one */
  const U0 = shown(s0, row), U1 = shown(s1, row);
  ok(`${label}: in its place, level with it as far as the view allows`, near(N.x, U0.x, 0.3) && near(N.y, Math.min(U0.y, low), 0.3), { page: [r2(N.x), r2(N.y)], window: [r2(U0.x), r2(U0.y)], low: r2(low) });
  ok(`${label}: it moved right, just clear of the new one, level as it was`, near(U1.x, N.x + N.w + 1.2, 0.2) && near(U1.y, U0.y, 0.1), { before: [r2(U0.x), r2(U0.y)], after: [r2(U1.x), r2(U1.y)] });
  ok(`${label}: what moved went right, or down from under the new one's top`, moved.every((id) => (by[id][0] > 0.1 && Math.abs(by[id][1]) < 0.1) || (by[id][1] > 0.1 && Math.abs(by[id][0]) < 0.1 && shown(s0, id).y >= N.y - 0.05)), by);
  ok(`${label}: nothing that was left of it is now right of the new one`, Object.keys(s0.wins).every((id) => shown(s0, id).x + shown(s0, id).w > U0.x + 0.05 || shown(s1, id).x < N.x), by);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => { ws.mode = 'float'; (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }); });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();
  await goTo('flow');
  /* a busy first view, as after browse's walk: notes and shells made the way the dock's click makes them, each in the open
     space left in view (openSpot), until no note fits there; the view stays at the space's start */
  for (let i = 0; i < 8; i++) { await ev(`__flow.spawn(${q(i % 2 ? 'shell' : 'note')})`); await sleep(700); }
  /* back to the space's start by hand: the bare desktop dragged by as much as the view went on, in drags of at most most
     of the view's width, each held still before the release so nothing glides */
  let sv = await now();
  for (let n = 0; n < 24 && (Math.abs(sv.pan) > 1 || Math.abs(sv.panY) > 1); n++) {
    /* the leftmost bare desktop in view, so the drag right can be as long as the view allows */
    const b = await ev(`(() => { const vp = document.getElementById('viewport').getBoundingClientRect(); for (let x = vp.left + 20; x < vp.right - 60; x += 20) for (let y = vp.top + 60; y < vp.bottom - 120; y += 25) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win') && !e.closest('#dock') && !e.closest('button') && e.closest('.ws')) return { x, y }; } return null; })()`);
    if (!b) throw new Error('no bare desktop in view to drag back to the start from');
    const dx = Math.max(-(b.x - sv.vp.x - 20), Math.min(sv.pan * sv.zoom, sv.vp.x + sv.vp.w - 20 - b.x)), dy = Math.min(sv.panY * sv.zoom, sv.vp.y + sv.vp.h - 20 - b.y);
    await mouse(c, 'mouseMoved', b.x, b.y);
    await mouse(c, 'mousePressed', b.x, b.y);
    for (let k = 1; k <= 16; k++) { await mouse(c, 'mouseMoved', b.x + (dx * k) / 16, b.y + (dy * k) / 16, { down: true }); await sleep(16); }
    await sleep(250);
    await mouse(c, 'mouseReleased', b.x + dx, b.y + dy);
    await sleep(700);
    sv = await now();
  }
  console.log(`the view at the space's start: ${r2(sv.pan)}, ${r2(sv.panY)} px`);
  let s0 = await now();
  const inView = (s, id) => { const r = s.wins[id]; return r.sx >= s.vp.x - 1 && r.sx + r.sw <= s.vp.x + s.vp.w + 1 && r.sy >= s.vp.y - 1 && r.sy + r.sh <= s.vp.y + s.vp.h + 1; };
  ok('the busy first view is on screen, the McKinsey page in it', inView(s0, 'w-mck'), box(s0.wins['w-mck']));
  console.log(`flow, busy: ${Object.keys(s0.wins).length} windows ${q(Object.fromEntries(Object.entries(s0.wins).map(([k, v]) => [k, box(v)])))}`);
  await shotOf(c, path.join(SHOTS, '00-busy.png'));

  /* 1. an empty spot, found as browse finds one: the first bare point from the top left, 40 px steps */
  const empty = await ev(`(() => { const vp = document.getElementById('viewport').getBoundingClientRect(); for (let y = vp.top + 80; y < vp.bottom - 120; y += 40) for (let x = vp.left + 80; x < vp.right - 200; x += 40) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win') && !e.closest('#dock') && !e.closest('#ov') && !e.closest('button')) return { x, y }; } return null; })()`);
  console.log(`empty spot: ${q(empty)}`);
  if (empty) {
    await carry(empty);
    const s1 = await now();
    judge('an empty spot', s0, s1, empty);
    await shotOf(c, path.join(SHOTS, '01-empty.png'));
    s0 = s1;
  } else ok('an empty spot in view', false);

  /* 2. onto a page window, the hand on its left half (batch 9, lead 19:2x): the row keeps its order, so the page takes its
     place and the window moves right with what is past it */
  const P = s0.wins['w-mck'], onto = { x: P.sx + P.sw * 0.25, y: P.sy + P.sh / 2 };
  await carry(onto);
  const s2 = await now(), bottomPct = await ev('__flow.nav().bottom()');
  const page2 = Object.keys(s2.wins).find((id) => !s0.wins[id]);
  judge('onto a page window', s0, s2, onto, { row: 'w-mck', low: bottomPct - (page2 ? shown(s2, page2).h : 0) });
  await shotOf(c, path.join(SHOTS, '02-onto.png'));

  /* 3. the right edge of the view, at mid height: "at the end" (owner 23:48 Nov 1; the design told them at 23:56, lead
     18:5x): past the last window, at the top, covering nothing, the view where it was, nothing else moving */
  const edge = { x: s2.vp.x + s2.vp.w - 12, y: s2.vp.y + s2.vp.h / 2 };
  const end = Math.max(...Object.values(s2.wins).map((r) => r.x + r.w));
  await carry(edge);
  const s3 = await now(), m3 = Object.keys(s3.wins).filter((id) => !s2.wins[id]), N3 = m3.length === 1 ? s3.wins[m3[0]] : null;
  console.log(`the right edge: new ${q(N3 && [N3.type, ...box(N3)])}; the end was ${r2(end)}; view ${r2(s2.pan)} -> ${r2(s3.pan)} px`);
  ok('the right edge: one new page window', !!N3 && N3.type === 'page', m3);
  ok('the right edge: past the last window, at the top', !!N3 && N3.x >= end - 0.05 && N3.x <= end + 3 && near(N3.y, 6.6, 0.05), { at: N3 && box(N3), end: r2(end) });
  ok('the right edge: over no window, the view where it was, nothing else moved', !!N3 && overlaps(s3).length === 0 && near(s3.pan, s2.pan, 1) && near(s3.panY, s2.panY, 1) && Object.keys(s2.wins).every((id) => near(s3.wins[id].x, s2.wins[id].x, 0.05) && near(s3.wins[id].y, s2.wins[id].y, 0.05)), { overlaps: overlaps(s3), pan: [s2.pan, s3.pan] });
  await shotOf(c, path.join(SHOTS, '03-edge.png'));

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




