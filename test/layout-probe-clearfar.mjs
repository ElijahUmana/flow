// layout's probe of the release after a resize that brings nothing closer (lead 18:5x): infra's kv cache bench and
// serving notes stand 0.8% apart, under the usual 1.2% gap; the bench's bottom edge is pulled up 30 px (away from
// everything), then its right edge pulled 6 px toward serving notes. Real input over CDP in layout's own isolated app.
//   LAYOUT_ROOT=<app tree> node test/layout-probe-clearfar.mjs [--keep]
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
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], wins = {};
  ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).forEach((w) => { const b = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']').getBoundingClientRect(); wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, sx: b.left, sy: b.top, sw: b.width, sh: b.height }; });
  const vp = document.getElementById('viewport').getBoundingClientRect(); return { vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins }; })()`);
const hitAt = (x, y) => ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e && e.classList.contains('rz') ? 'grip-' + e.dataset.rz + '@' + e.closest('.win').dataset.id : null; })()`);
async function goSettled(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  let last = null;
  for (let k = 0; k < 40; k++) {
    await sleep(150);
    const s = await now(), key = q(Object.values(s.wins).map((r) => [Math.round(r.sx), Math.round(r.sy), Math.round(r.sw), Math.round(r.sh)]));
    if (key === last) return s;
    last = key;
  }
  return now();
}
const btn = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse' });
async function drag(x, y, dx, dy) {
  await mouse(c, 'mouseMoved', x, y);
  await sleep(300);
  await btn('mousePressed', x, y);
  for (let k = 1; k <= 12; k++) { await mouse(c, 'mouseMoved', x + (dx * k) / 12, y + (dy * k) / 12, { down: true }); await sleep(20); }
  await sleep(200);
  await btn('mouseReleased', x + dx, y + dy);
  return goSettled('infra');
}
const drawn = (s, r) => ({ x: ((r.sx - s.vp.x) / s.vp.w) * 100, y: ((r.sy - s.vp.y) / s.vp.h) * 100 });
const movesOn = (a, b, but) => Object.keys(a.wins).filter((id) => id !== but).map((id) => { const p = drawn(a, a.wins[id]), n = drawn(b, b.wins[id]); return [id, +(n.x - p.x).toFixed(2), +(n.y - p.y).toFixed(2)]; }).filter(([, dx, dy]) => Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05);

async function main() {
  console.log(`tree ${ROOT}`);
  await writeSeed();
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => { ws.mode = 'float'; (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }); });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();

  const s0 = await goSettled('infra'), A = s0.wins['i-bench'], B = s0.wins['i-sched'];
  console.log(`infra: kv cache bench to serving notes ${(B.x - A.x - A.w).toFixed(2)}% (${(B.sx - A.sx - A.sw).toFixed(1)} px); the usual gap is 1.2%`);
  const mx = Math.round(A.sx + A.sw / 2);
  let gy = null;
  for (let y = Math.round(A.sy + A.sh) - 6; y <= Math.round(A.sy + A.sh) + 6; y++) if ((await hitAt(mx, y)) === 'grip-s@i-bench') { gy = y; break; }
  ok('kv cache bench\'s bottom grip found', gy !== null, gy);
  if (gy === null) return;
  const s1 = await drag(mx, gy, 0, -30), m1 = movesOn(s0, s1, 'i-bench');
  console.log(`bottom edge pulled up: kv cache bench ${q([A.sh, s1.wins['i-bench'].sh].map(Math.round))} px tall; others moved on screen ${q(m1)}`);
  ok('the pull resized kv cache bench', Math.abs(s1.wins['i-bench'].sh - A.sh + 30) <= 3, [A.sh, s1.wins['i-bench'].sh]);
  ok('a resize that brings nothing closer moves nothing else', m1.length === 0, m1);

  const C = s1.wins['i-bench'], cy = Math.round(C.sy + C.sh / 2);
  let gx = null;
  for (let x = Math.round(C.sx + C.sw) - 6; x <= Math.round(C.sx + C.sw) + 6; x++) if ((await hitAt(x, cy)) === 'grip-e@i-bench') { gx = x; break; }
  ok('kv cache bench\'s right grip found', gx !== null, gx);
  if (gx === null) return;
  const s2 = await drag(gx, cy, 6, 0), m2 = movesOn(s1, s2, 'i-bench'), S = s2.wins['i-sched'], E = s2.wins['i-bench'];
  console.log(`right edge pulled 6 px toward serving notes: others moved on screen ${q(m2)}; gap now ${(S.x - E.x - E.w).toFixed(2)}%`);
  ok('a resize toward serving notes still makes it stand the usual gap off', m2.some(([id, dx]) => id === 'i-sched' && dx > 0) && Math.abs(S.x - E.x - E.w - 1.2) < 0.06, { moved: m2, gap: +(S.x - E.x - E.w).toFixed(2) });
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




