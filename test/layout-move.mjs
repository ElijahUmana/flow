// layout's check that a tool moved to another sub-workspace or workspace keeps its size and covers nothing (STATUS item
// 55; owner 22:50 "not necessarily say forcefully reorganizing", "not scattering"; 23:45 "at the end"), with real input
// over CDP in layout's own isolated app (layout-lib.mjs): "move to research" from a window's title bar, a window carried
// by its title bar onto a sub-workspace's row in the sidebar, and one carried onto another workspace's pill. It takes a
// free spot in that space's view when one fits, else it goes past the space's last window, and nothing there moves.
// Notes, blank pages and shells.
//   LAYOUT_ROOT=<app tree> node test/layout-move.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/move-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, shot as shotOf } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'move-shots');
const KEEP = process.argv.includes('--keep');
const q = JSON.stringify;
let c, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const ev = (x) => c.eval(x);
const shot = (name) => shotOf(c, path.join(SHOTS, `${name}.png`));
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;

/* The space on screen: its view (px of this window, whichever unit the workspace keeps it in), its windows in % and on
   screen, which one is in front, and where the keys go. */
const now = () => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0], sid = ws.at || null;
  const vp = document.getElementById('viewport').getBoundingClientRect();
  const wins = {}; ws.windows.filter((w) => (w.zone || null) === sid).forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect();
    wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, type: w.type, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  const front = document.querySelector('.win.front'), keys = document.activeElement && document.activeElement.closest && document.activeElement.closest('.win');
  return { ws: ws.id, pan: ws.panUnit === '%' ? ((ws.pan || 0) / 100) * vp.width : ws.pan || 0, panY: ws.panUnit === '%' ? ((ws.panY || 0) / 100) * vp.height : ws.panY || 0, zoom: ws.zoom || 1, vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, wins,
    front: front ? front.dataset.id : null, keys: keys ? keys.dataset.id : null, glowR: document.getElementById('edgeR').classList.contains('on') }; })()`);
let px = 700, py = 400;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); px = x; py = y; }
async function goTo(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  await sleep(900);
}

/* Every window of a workspace in one space (null: the main one), in %. */
const spaceOf = (wsId, sid) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === ${q(wsId)}), out = {};
  ws.windows.filter((w) => (w.zone || null) === ${q(sid)}).forEach((w) => { out[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h }; });
  return out; })()`);
const winOf = (wsId, id) => ev(`(() => { for (const ws of __flow.state().ws) { const w = ws.windows.find((x) => x.id === ${q(id)}); if (w) return { ws: ws.id, zone: w.zone || null, x: w.x, y: w.y, w: w.w, h: w.h }; } return null; })()`);
/* The view of a space as % of the view (x, w), from what is saved for it. */
const viewOf = (wsId, sid) => ev(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === ${q(wsId)}), vw = document.getElementById('viewport').getBoundingClientRect().width;
  const on = (ws.at || null) === ${q(sid)}, zn = ${q(sid)} && ws.zones.find((z) => z.id === ${q(sid)});
  const o = on ? { pan: ws.pan, z: ws.zoom, u: ws.panUnit } : zn ? { pan: zn.pan, z: zn.zoom, u: ws.panUnit } : { pan: ws.mainPan, z: ws.mainZoom, u: ws.panUnit };
  const px = o.u === '%' ? ((o.pan || 0) / 100) * vw : o.pan || 0, z = o.z || 1;
  return { x: (px / vw) * 100, w: 100 / z }; })()`);
function overIn(set, r, id) {
  return Object.entries(set).filter(([k, o]) => k !== id && r.x < o.x + o.w - 0.05 && o.x < r.x + r.w - 0.05 && r.y < o.y + o.h - 0.05 && o.y < r.y + r.h - 0.05).map(([k]) => k);
}
const same = (a, b) => Object.keys(a).every((id) => b[id] && near(a[id].x, b[id].x) && near(a[id].y, b[id].y) && near(a[id].w, b[id].w) && near(a[id].h, b[id].h));
const end = (set) => Math.max(0, ...Object.values(set).map((o) => o.x + o.w));
async function rclick(x, y) {
  await glide(x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(450);
}
async function menuPick(re) {
  const b = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => ${re}.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!b) return false;
  await glide(b.x, b.y, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1000);
  return true;
}
const rect = (sel) => ev(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
/* A window carried by its title bar to x, y, slowly, held there a moment, then let go. */
async function carryWin(id, x, y) {
  const t = await rect(`.win[data-id="${id}"] .tb .title`) || await rect(`.win[data-id="${id}"] .tb`);
  const x0 = t.x + 30, y0 = t.cy;
  await glide(x0, y0, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  const n = 30;
  for (let k = 1; k <= n; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x - x0) * k) / n, y: y0 + ((y - y0) * k) / n, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(16); }
  for (let k = 0; k < 6; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(40); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  px = x; py = y;
  await sleep(1200);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }));
  /* the week note narrow enough for the free column research has in its view */
  Object.assign(state.ws.find((s) => s.id === 'flow').windows.find((o) => o.id === 'w-week'), { w: 22, h: 40 });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();
  await goTo('flow');
  const zid = await ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === 'flow'); const z = ws.zones.find((x) => /research/.test(x.name)); return z ? z.id : null; })()`);
  console.log(`flow main: ${q(await spaceOf('flow', null))}; research (${zid}): ${q(await spaceOf('flow', zid))}`);

  /* 1. "move to research" from a window's title bar, with a free spot in research's view that fits it */
  let r0 = await spaceOf('flow', zid), v0 = await viewOf('flow', zid), m0 = await now();
  let tb = await rect('.win[data-id="w-week"] .tb .title') || await rect('.win[data-id="w-week"] .tb');
  await rclick(tb.cx, tb.cy);
  ok('a window\'s title bar offers "move to research"', await menuPick('/move to research/'));
  let r1 = await spaceOf('flow', zid), W = await winOf('flow', 'w-week'), m1 = await now();
  console.log(`w-week now ${q(W)}; research view ${q(v0)}`);
  ok('it moves to research, at its own size', !!W && W.zone === zid && near(W.w, 22) && near(W.h, 40), W);
  ok('it covers nothing there', !!W && overIn(r1, W, 'w-week').length === 0, W && overIn(r1, W, 'w-week'));
  ok('it took a free spot in research\'s view', !!W && W.x >= v0.x - 0.05 && W.x + W.w <= v0.x + v0.w + 0.05, { at: W && [W.x, W.w], view: v0 });
  ok('nothing in research moved', same(r0, r1));
  ok('the main space\'s view stayed', near(m1.pan, m0.pan, 0.5) && near(m1.zoom, m0.zoom, 0.001));

  /* 2. the same with no free spot that fits: past research's last window, nothing moved */
  r0 = await spaceOf('flow', zid);
  const end0 = end(r0);
  tb = await rect('.win[data-id="w-mck"] .tb .title') || await rect('.win[data-id="w-mck"] .tb');
  await rclick(tb.cx, tb.cy);
  ok('"move to research" again, for a page too wide for any free spot there', await menuPick('/move to research/'));
  r1 = await spaceOf('flow', zid);
  W = await winOf('flow', 'w-mck');
  console.log(`w-mck now ${q(W)}; research ended at ${end0.toFixed(2)}`);
  ok('it moves to research at its own size, past its last window, at the top', !!W && W.zone === zid && near(W.w, 49.4) && near(W.h, 50) && near(W.x, end0 + 1.5) && near(W.y, 6.6), W);
  ok('it covers nothing and nothing in research moved', !!W && overIn(r1, W, 'w-mck').length === 0 && same(r0, r1), W && overIn(r1, W, 'w-mck'));

  /* 3. a window carried by its title bar onto research's row in the sidebar */
  r0 = await spaceOf('flow', zid);
  const end1 = end(r0);
  const row = await rect(`#sblist .tr[data-act="zone|${zid}"]`);
  ok('research has a row in the sidebar', !!row);
  if (row) {
    await carryWin('w-design', row.x + 60, row.cy);
    r1 = await spaceOf('flow', zid);
    W = await winOf('flow', 'w-design');
    console.log(`w-design now ${q(W)}`);
    ok('carried onto research\'s row, it moves there at its own size, past the last window', !!W && W.zone === zid && near(W.w, 49.4) && near(W.h, 30) && near(W.x, end1 + 1.5), W);
    ok('it covers nothing and nothing in research moved', !!W && overIn(r1, W, 'w-design').length === 0 && same(r0, r1), W && overIn(r1, W, 'w-design'));
  }
  await shot('03-flow-main-after');

  /* 4. a window carried onto another workspace's pill: that workspace's space has no room, so past its last window */
  await goTo('mynotes');
  const v0s = await spaceOf('voiceless', null), vEnd = end(v0s);
  const pill = await ev(`(() => { const i = __flow.state().ws.findIndex((w) => w.id === 'voiceless'), e = document.querySelector('#spaces .sp[data-i="' + i + '"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await carryWin('mn-note', pill.x, pill.y);
  const v1s = await spaceOf('voiceless', null), N = await winOf('voiceless', 'mn-note');
  console.log(`mn-note now ${q(N)}; voiceless ended at ${vEnd.toFixed(2)}`);
  ok('carried onto another workspace\'s pill, it moves there at its own size', !!N && N.ws === 'voiceless' && near(N.w, 40) && near(N.h, 30), N);
  ok('past that space\'s last window, covering nothing, nothing there moved', !!N && near(N.x, vEnd + 1.5) && overIn(v1s, N, 'mn-note').length === 0 && same(v0s, v1s), { at: N, end: vEnd });
  await goTo('flow');
  await shot('04-flow');

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




