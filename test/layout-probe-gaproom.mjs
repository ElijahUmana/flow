// layout's probe of the gap between two close windows once their resize grips cover it (lead 18:0x, batch 8): a double-click
// there at a hand's pace opens room (the far window makes way by its own width), and a press-and-drag there resizes the
// window whose grip it is. Real input over CDP in layout's own isolated app. Shells only, pages blank.
//   LAYOUT_ROOT=<app tree> node test/layout-probe-gaproom.mjs [--keep]
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
  ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).forEach((w) => { const b = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']').getBoundingClientRect(); wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, sx: b.left, sy: b.top, sw: b.width, sh: b.height }; });
  const vp = document.getElementById('viewport').getBoundingClientRect(); return { vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins }; })()`);
const hitAt = (x, y) => ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.classList.contains('rz') ? 'grip-' + e.dataset.rz + '@' + e.closest('.win').dataset.id : e.closest('.win') ? 'window' : (e.className || e.tagName)) : null; })()`);
/* Goes to a workspace and waits until its windows stop moving on screen. */
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
const btn = (type, x, y, n) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: n, pointerType: 'mouse' });

async function main() {
  console.log(`tree ${ROOT}`);
  await writeSeed();
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => { ws.mode = 'float'; (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }); });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();

  /* 1. infra: kv cache bench and serving notes 9.9 px apart, every pixel of it a grip; a hand-paced double-click in the
     middle opens room: serving notes (and the team past it) make way by serving notes' own width */
  const s0 = await goSettled('infra'), A = s0.wins['i-bench'], B = s0.wins['i-sched'];
  const g = { x: Math.round((A.sx + A.sw + B.sx) / 2), y: Math.round(A.sy + A.sh / 2) };
  const under = await hitAt(g.x, g.y);
  console.log(`infra gap ${(B.sx - A.sx - A.sw).toFixed(1)} px; the middle ${q(g)} is ${under}`);
  ok('the middle of the gap is a resize grip (the case this fixes)', /^grip-/.test(under), under);
  await mouse(c, 'mouseMoved', g.x, g.y);
  await sleep(300);
  await btn('mousePressed', g.x, g.y, 1); await sleep(40); await btn('mouseReleased', g.x, g.y, 1);
  await sleep(80); await btn('mousePressed', g.x, g.y, 2); await sleep(40); await btn('mouseReleased', g.x, g.y, 2);
  await sleep(1200);
  const s1 = await now();
  ok('a double-click there opens room: serving notes makes way by its own width', near(s1.wins['i-sched'].x, s0.wins['i-sched'].x + s0.wins['i-sched'].w + 1.2), { sched: [s0.wins['i-sched'].x, s1.wins['i-sched'].x] });
  ok('and the team past it goes along; kv cache bench is not resized', near(s1.wins['i-team'].x - s0.wins['i-team'].x, s1.wins['i-sched'].x - s0.wins['i-sched'].x) && near(s1.wins['i-bench'].w, s0.wins['i-bench'].w, 0.01) && near(s1.wins['i-bench'].x, s0.wins['i-bench'].x, 0.01), { bench: [s0.wins['i-bench'].w, s1.wins['i-bench'].w] });

  /* 2. mynotes: the note and the page beside it 16 px apart; a press on the note's right grip in that gap, dragged 30 px
     right, resizes the note by as much */
  const m0 = await goSettled('mynotes'), N = m0.wins['mn-note'], P = m0.wins['mn-page'];
  const y = Math.round(N.sy + N.sh / 2);
  let gx = null;
  for (let x = Math.floor(N.sx + N.sw); x < Math.ceil(P.sx); x++) if ((await hitAt(x, y)) === 'grip-e@mn-note') { gx = x; break; }
  console.log(`mynotes gap ${(P.sx - N.sx - N.sw).toFixed(1)} px; the note's right grip in it at x ${gx}`);
  ok('the note\'s right grip reaches into the gap', gx !== null, gx);
  if (gx !== null) {
    await mouse(c, 'mouseMoved', gx, y);
    await sleep(300);
    await btn('mousePressed', gx, y, 1);
    for (let k = 1; k <= 12; k++) { await mouse(c, 'mouseMoved', gx + (30 * k) / 12, y, { down: true }); await sleep(20); }
    await sleep(200);
    await btn('mouseReleased', gx + 30, y, 1);
    await sleep(1200);
    const m1 = await now();
    ok('a press-and-drag on that grip resizes the note by the drag', near(m1.wins['mn-note'].sw - m0.wins['mn-note'].sw, 30, 2) && near(m1.wins['mn-note'].sx, m0.wins['mn-note'].sx, 1), { width: [m0.wins['mn-note'].sw, m1.wins['mn-note'].sw] });
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




