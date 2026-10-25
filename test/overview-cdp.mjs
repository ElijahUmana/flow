// overview's checks of the corner overview with real input over CDP, on overview's own isolated Flow (port 9581,
// socket flow-dev-overview, userData /tmp/flow-dev-overview, marker --flow-dev=overview), from a fresh seed without
// host windows where every terminal is a shell. Each check is a case of the approved design (owner 18:48 and 23:40).
//   node test/overview-cdp.mjs [label]      log and shots in /tmp/flow-dev-overview/<label>/
import fs from 'node:fs';
import path from 'node:path';
import { launch, stop, flowWindow, writeSeed, resetState, mouse, moveTo, click, drag, swipe, pinch, shot, sleep, waitFor, targets, Cdp, USER_DATA } from './overview-lib.mjs';

const LABEL = process.argv[2] || 'run';
const OUT = path.join(USER_DATA, LABEL);
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'overview-cdp.log');
fs.writeFileSync(LOG, '');
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const r2 = (n) => Math.round(n * 100) / 100;

/* ---------- read in the page ---------- */
const OV = `(() => {
  const el = document.querySelector('.ov');
  if (!el) return null;
  const cs = getComputedStyle(el), r = el.getBoundingClientRect(), box = (e) => { if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
  return { shown: cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.5, vis: cs.visibility, op: parseFloat(cs.opacity), pe: cs.pointerEvents,
    x: r.left, y: r.top, w: r.width, h: r.height, area: { x: r.left + 1, y: r.top + 1, w: r.width - 2, h: r.height - 2 }, shapes: [...el.querySelectorAll('i')].map(box), frame: box(el.querySelector('u')), sheet: box(el.querySelector('b')) };
})()`;
const VIEW = `(() => {
  const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), zn = ws.at && (ws.zones || []).find((z) => z.id === ws.at);
  const vp = document.getElementById('viewport').getBoundingClientRect(), pc = ws.panUnit === '%';
  return { ws: ws.id, at: ws.at || null, pan: pc ? ((ws.pan || 0) / 100) * vp.width : ws.pan || 0, panY: pc ? ((ws.panY || 0) / 100) * vp.height : ws.panY || 0, zoom: ws.zoom || 1, roomRight: (zn || ws).roomRight || 0, roomLeft: (zn || ws).roomLeft || 0,
    vw: vp.width, vh: vp.height, left: vp.left, top: vp.top, right: vp.right, bottom: vp.bottom };
})()`;
const rectOf = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`;
const frontId = `(() => { const s = window.__flow.state(), sec = document.querySelector('.ws[data-id="' + s.ui.at + '"]'), f = sec && sec.querySelector('.win.front'); return f ? f.dataset.id : null; })()`;

const ov = (c) => c.eval(OV);
/* Where the space on screen ends on the right, in % of a view: its windows' right edge and the side gap, or its room. */
const END = `(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), zn = ws.at && (ws.zones || []).find((z) => z.id === ws.at); const xs = ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).map((w) => w.x + w.w); return Math.max(100, Math.max(...xs) + 1.2, (zn || ws).roomRight || 0); })()`;
const end = (c) => c.eval(END);
/* A missing overview would read as down and pass every check that it stays down, so where down is the answer it must
   be there. */
const ovThere = async (c) => { const o = await ov(c); if (!o) throw new Error('the overview (.ov) is not in the page'); return o; };
const view = (c) => c.eval(VIEW);
const up = (o) => o.vis === 'visible' || o.op > 0.05;
/* Samples whether the overview is up while fn runs and for ms after it. A sampling error stops the sampling and is
   thrown once fn is done, into the run's catch, so it fails the run and the app is still stopped. */
async function watch(c, fn, ms = 400) {
  let n = 0, seen = 0, run = true, err = null;
  const sampler = (async () => { while (run) { if (up(await ovThere(c))) seen++; n++; await sleep(25); } })().catch((e) => { err = e; });
  await fn();
  await sleep(ms);
  run = false;
  await sampler;
  if (err) throw err;
  return { up: seen, n };
}
/* A workspace by its pill. The pills move while a space step ends (a pill drops its "› space"), later on a loaded
   machine, so it clicks once the pill has kept its place for 150 ms, and a click that lands on another workspace stops
   the run. */
async function pill(c, i) {
  let r = await c.eval(rectOf(`.sp[data-i="${i}"] .sn`));
  for (const end = Date.now() + 3000; Date.now() < end;) {
    await sleep(150);
    const q = await c.eval(rectOf(`.sp[data-i="${i}"] .sn`));
    if (JSON.stringify(q) === JSON.stringify(r)) break;
    r = q;
  }
  await click(c, r.x + r.w / 2, r.y + r.h / 2);
  await sleep(900);
  const on = await c.eval(`(() => { const s = window.__flow.state(); return { at: s.ui.at, want: s.ws[${i}] && s.ws[${i}].id }; })()`);
  if (on.at !== on.want) throw new Error(`the click on pill ${i} went to ${on.at}, not ${on.want}`);
}
async function dblclick(c, x, y) {
  await mouse(c, 'mouseMoved', x, y);
  await mouse(c, 'mousePressed', x, y, { count: 1 });
  await mouse(c, 'mouseReleased', x, y, { count: 1 });
  await mouse(c, 'mousePressed', x, y, { count: 2 });
  await mouse(c, 'mouseReleased', x, y, { count: 2 });
}
async function key(c, k, code, vk, modifiers = 0) {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
}
/* The corner: bare desktop in the bottom strip, left of the 24 px edge strip. */
const corner = (v) => ({ x: v.right - 120, y: v.bottom - 6 });
async function reach(c, from) {
  const v = await view(c), k = corner(v), f = from || { x: v.left + v.vw / 2, y: v.top + v.vh / 2 };
  await moveTo(c, f.x, f.y, k.x, k.y, { steps: 10, gapMs: 16 });
  await sleep(60);
  await mouse(c, 'mouseMoved', k.x + 1, k.y);
  const o = await waitFor(async () => { const q = await ov(c); return q && q.shown && q.op > 0.95 ? q : null; }, 1500, 'the overview to come up').catch(() => null);
  if (!o) await ovThere(c);
  return o;
}
async function leave(c) {
  const v = await view(c);
  await moveTo(c, v.right - 120, v.bottom - 6, v.left + v.vw / 2, v.top + 46, { steps: 6, gapMs: 16 });
  return waitFor(async () => { const o = await ov(c); return o && o.vis === 'hidden' ? o : null; }, 1500, 'the overview to go').catch(() => null);
}
/* To the start of the space (pan 0, 0). The board has no ends to stop a drag there, so: slow drags of bare desktop by
   the view's offset, let go still so nothing glides, until the view is there. */
/* A spot of bare desktop with room for a drag by (dx, dy): rows and columns are tried from the side the drag leaves. */
const BARE = (dx, dy) => `(() => { const vp = document.getElementById('viewport').getBoundingClientRect(); const ys = [vp.top + 46, ...Array.from({ length: 19 }, (_, i) => vp.top + vp.height * (0.05 + i * 0.05)), vp.bottom - 6]; const xs = Array.from({ length: 19 }, (_, i) => vp.left + vp.width * (0.05 + i * 0.05)); if (${dy} < 0) ys.reverse(); if (${dx} < 0) xs.reverse(); for (const y of ys) for (const x of xs) { const e = document.elementFromPoint(x, y); if (e && e.closest('#viewport') && !e.closest('.win, .ov')) return { x, y }; } return null; })()`;
async function home(c) {
  for (let i = 0; i < 16; i++) {
    const v = await view(c);
    if (Math.abs(v.pan) < 1 && Math.abs(v.panY) < 1) return;
    const p = await c.eval(BARE(v.pan, v.panY));
    if (!p) throw new Error('home: no bare desktop in view to drag');
    const fit = (d, lo, hi) => Math.max(lo, Math.min(hi, d));
    const dx = fit(v.pan * v.zoom, v.left + 10 - p.x, v.right - 10 - p.x), dy = fit(v.panY * v.zoom, v.top + 10 - p.y, v.bottom - 10 - p.y);
    const t0 = Date.now(), n = 16;
    await mouse(c, 'mouseMoved', p.x, p.y);
    await mouse(c, 'mousePressed', p.x, p.y, { at: t0 });
    for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', p.x + (dx * k) / n, p.y + (dy * k) / n, { down: true, at: t0 + k * 16 });
    await sleep(150);
    await mouse(c, 'mouseReleased', p.x + dx, p.y + dy, { at: t0 + n * 16 + 150 });
    await sleep(400);
  }
  const v = await view(c);
  if (Math.abs(v.pan) >= 1 || Math.abs(v.panY) >= 1) throw new Error(`home: the view stayed at ${r2(v.pan)},${r2(v.panY)}`);
}
/* Back to 100% with one pinch around the middle of the view. */
async function unzoom(c) {
  for (let i = 0; i < 4; i++) {
    const v = await view(c);
    if (Math.abs(v.zoom - 1) < 0.001) return;
    /* a little past 100% in the pinch's direction: the pinch stops at exactly 100% on the way (item 6) */
    await pinch(c, v.left + v.vw * 0.5, v.top + v.vh * 0.5, [Math.log(v.zoom) * 100 + (v.zoom < 1 ? -4 : 4)]);
    await sleep(800);
  }
  const v = await view(c);
  if (Math.abs(v.zoom - 1) >= 0.001) throw new Error(`unzoom: the zoom stayed at ${v.zoom}`);
}
/* After a click or swipe that moves the view. Under load the input and the glide can take far longer than usual (a
   pop-out got its press 203 ms late and its view arrived after about 1 s at load average 110), so read again until
   the value has changed from `from` and then holds for two reads (and done says it is done), at most ms. The checks
   still judge where it ended. */
async function settle(read, from, ms = 4000, done = () => true) {
  const end = Date.now() + ms, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let last = await read(), moved = !same(last, from);
  while (Date.now() < end) {
    await sleep(150);
    const now = await read();
    if (moved && same(now, last) && done(now)) return now;
    if (!same(now, from)) moved = true;
    last = now;
  }
  return last;
}
/* A spot of the map no window's shape covers, at its right end and mid height, where a click is the map's own move
   (a click on a shape goes to that window instead). Null when none is free. */
const emptyRight = (o) => { const y = o.area.y + o.area.h / 2; for (let x = o.area.x + o.area.w - 1.2; x > o.area.x + o.area.w * 0.6; x -= 1) if (!o.shapes.some((q) => x >= q.x - 1 && x <= q.x + q.w + 1 && y >= q.y - 1 && y <= q.y + q.h + 1)) return { x, y }; return null; };
/* Where the map draws its frame: under load the map can redraw after the view is still, so a check that uses the frame
   waits for it to hold first. */
const mapAt = async (c) => { const q = await ov(c); return q && q.frame ? [r2(q.frame.x), r2(q.frame.y), r2(q.frame.w), r2(q.frame.h)] : null; };
/* The view as kept, and whether it is drawn there: nav keeps the end of a glide at once and draws its way there, and a
   glide past an end holds a moment before it springs back. */
const where = (c) => c.eval(`(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), vp = document.getElementById('viewport').getBoundingClientRect(), pc = ws.panUnit === '%', x = pc ? ((ws.pan || 0) / 100) * vp.width : ws.pan || 0, y = pc ? ((ws.panY || 0) / 100) * vp.height : ws.panY || 0, sec = document.querySelector('.ws[data-id="' + s.ui.at + '"]'), cv = sec && sec.querySelector('.canvas'), m = cv && new DOMMatrixReadOnly(getComputedStyle(cv).transform), r = (n) => Math.round(n * 100) / 100; return [ws.id, ws.at || null, r(x), r(y), r(ws.zoom || 1), !!m && Math.abs(-m.m41 / (m.a || 1) - x) < 0.6 && Math.abs(-m.m42 / (m.a || 1) - y) < 0.6]; })()`);
const drawn = (w) => w[5];

/* ---------- the seed: the app's first run, shells only, no host windows ---------- */
const { removed } = await writeSeed();
log(`seed: removed host windows ${removed.join(', ') || 'none'}; terminals are shells`);
/* As a first run lays it out (app.js fitStartingLayout, migrateZones): the bottom row ends 12 px above the bottom and
   research is a space of its own. Then: infra gets a page at its bottom right (about:blank, a real webview); flow's
   main space and research each reach past one view, so a swipe goes from one wide space to another; ef's terminal lies
   past the view at the top, so its map comes up for the edge checks while the edge beside the map stays bare. */
const VH = 940, BOTTOM = 100 - Math.max(1.2, (12 / VH) * 100), K = (BOTTOM - 6.6) / (88.4 - 6.6);
const fit = (r) => { const b = 6.6 + (r.y + r.h - 6.6) * K; r.y = 6.6 + (r.y - 6.6) * K; r.h = b - r.y; };
resetState((doc) => {
  doc.ws.forEach((ws) => ws.windows.forEach(fit));
  const flow = doc.ws.find((w) => w.id === 'flow'), infra = doc.ws.find((w) => w.id === 'infra');
  const zn = flow.zones.find((z) => z.id === 'z-research');
  flow.windows.forEach((w) => { const cx = w.x + w.w / 2; if (cx >= zn.x && cx <= zn.x + zn.w) { w.zone = zn.id; w.x = w.x - zn.x + 1.2; } });
  delete zn.x; delete zn.y; delete zn.w; delete zn.h; zn.pan = 0;
  flow.windows.find((w) => w.id === 'w-week').x = 104;
  flow.windows.find((w) => w.id === 'w-read').x = 110;
  const note = infra.windows.find((w) => w.id === 'i-note');
  note.w = 48;
  infra.notes.push({ id: 'p-ovblank', kind: 'page', title: 'blank', titleSet: true, url: 'about:blank', body: '' });
  infra.windows.push({ id: 'i-page', type: 'page', noteId: 'p-ovblank', x: 50.4, y: note.y, w: 48.4, h: note.h });
  Object.assign(doc.ws.find((w) => w.id === 'ef').windows.find((w) => w.id === 'e-term'), { x: 104, y: 6.6 });
  doc.ui.at = 'infra';
});

launch();
let c;
try {
  c = await flowWindow();

  /* 0. never by itself at start */
  {
    const a = await watch(c, async () => {}, 1500);
    const v = await view(c);
    check('0 it does not show at start', a.up === 0 && v.ws === 'infra', `${a.up} of ${a.n} samples up; on ${v.ws}, viewport ${r2(v.vw)}x${r2(v.vh)}`);
  }
  let v = await view(c);

  /* 1. never by itself while navigating: pan, glide, pinch, a window brought into view, a two-finger step, a workspace
        switch; the pointer never comes to the corner (owner 18:48) */
  {
    const y = v.top + 46;
    let brought = null;
    const a = await watch(c, async () => {
      await drag(c, v.left + v.vw * 0.7, y, Array(12).fill(-25), { gapMs: 12 });
      await sleep(1200);
      await drag(c, v.left + v.vw * 0.3, y, Array(12).fill(30), { gapMs: 12 });
      await sleep(1200);
      await pinch(c, v.left + v.vw * 0.5, v.top + v.vh * 0.4, Array(8).fill(12));
      await sleep(600);
      await unzoom(c);
      const row = await c.eval(`(() => { const e = [...document.querySelectorAll('#sblist .tr')].find((r) => /team reading/.test(r.textContent)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
      if (row) {
        await click(c, row.x, row.y);
        await sleep(900);
        const t = await c.eval(rectOf('.ws[data-id="infra"] .win[data-id="i-team"]')), w = await view(c);
        brought = !!t && t.x >= w.left - 1 && t.x + t.w <= w.right + 1;
      }
      await pill(c, 0);
      await swipe(c, v.left + v.vw * 0.5, y, Array(12).fill(20));
      await sleep(900);
      await swipe(c, v.left + v.vw * 0.5, y, Array(12).fill(-20));
      await sleep(900);
      await click(c, v.left + v.vw * 0.5, y);
      await key(c, 'ArrowRight', 'ArrowRight', 39, 2);
      await sleep(900);
      await key(c, 'ArrowLeft', 'ArrowLeft', 37, 2);
      await sleep(900);
    }, 600);
    const now = await view(c);
    check('1 a pan, a glide, a pinch, a window brought into view, a two-finger step and a workspace switch never bring it up', a.up === 0 && now.ws === 'flow' && brought === true, `${a.up} of ${a.n} samples up; ended on ${now.ws}; team reading brought into view from its sidebar row: ${brought === null ? 'no such row' : brought}`);
    await pill(c, 2);
    await home(c);
  }

  /* 2. reached for: the bare strip at the bottom right brings it up; over a window above that strip it stays down */
  v = await view(c);
  {
    const k = corner(v), pg = await c.eval(rectOf('.win[data-id="i-page"]')), py = pg.y + pg.h - 8;
    const over = await watch(c, async () => {
      await moveTo(c, v.left + v.vw / 2, v.top + v.vh / 2, k.x, py, { steps: 10, gapMs: 16 });
      await sleep(250);
    }, 300);
    check('2a over the page window at the bottom right it stays down', over.up === 0 && py < v.bottom - 12, `${over.up} of ${over.n} samples up; the page ends ${r2(v.bottom - (pg.y + pg.h))} px above the bottom`);
    const o = await reach(c, { x: k.x, y: py });
    check('2b at the bottom right (the bare strip) it comes up', !!o && v.pan < 1, o ? `box ${r2(o.w)}x${r2(o.h)} at ${r2(o.x)},${r2(o.y)}` : 'never came up');
    if (o) {
      check('2c it shows this space\'s 5 windows and the view, and draws no box (the board has no edge)', o.shapes.length === 5 && !!o.frame && !o.sheet, `${o.shapes.length} shapes, frame ${o.frame ? `${r2(o.frame.w)}x${r2(o.frame.h)}` : 'none'}, box ${o.sheet ? 'drawn' : 'none'}`);
      const span = await c.eval(`(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at); const x0 = Math.min(...ws.windows.map((g) => g.x)) - 2, x1 = Math.max(...ws.windows.map((g) => g.x + g.w)) + 2; return x1 - x0; })()`);
      check('2d the frame is the view\'s share of what the map spans (the windows)', Math.abs(o.frame.w / o.area.w - 100 / span) < 0.02, `${r2(o.frame.w / o.area.w)} of the width (want ${r2(100 / span)})`);
      check('2e it sits 28 px in from the right and 12 px up', Math.abs(v.right - (o.x + o.w) - 28) < 1.5 && Math.abs(v.bottom - (o.y + o.h) - 12) < 1.5, `right ${r2(v.right - (o.x + o.w))}, bottom ${r2(v.bottom - (o.y + o.h))}`);
      await shot(c, path.join(OUT, '02-up-infra.png'));
    }
  }

  /* 3. it goes when the pointer leaves; hidden, a click where it was reaches the window beneath */
  {
    const o = await ov(c);
    const gone = await leave(c);
    check('3a it goes when the pointer leaves', !!gone && gone.pe === 'none', gone ? `visibility ${gone.vis}, pointer-events ${gone.pe}` : 'still up');
    const bench = await c.eval(rectOf('.win[data-id="i-bench"] .tb'));
    await click(c, bench.x + bench.w / 2, bench.y + bench.h / 2);
    await sleep(200);
    await click(c, o.x + o.w / 2, o.y + o.h / 2);
    await sleep(300);
    const fr = await c.eval(frontId);
    check('3b hidden, a click where it was reaches the window beneath', fr === 'i-page', `in front after the click: ${fr}`);
    v = await view(c);
    await mouse(c, 'mouseMoved', v.left + v.vw / 2, v.top + 46);
  }

  /* 4. a click on an empty part: the view glides there, at its zoom, and that is saved */
  {
    v = await view(c);
    const o = await reach(c);
    if (o) {
      const from = await where(c), sp = emptyRight(o), tx = sp ? sp.x : NaN;
      if (sp) await click(c, sp.x, sp.y);
      await settle(() => where(c), from, 4000, drawn);
      const after = await view(c);
      await settle(() => mapAt(c), null, 2000);
      const o2 = await ov(c), fc = o2 && o2.frame ? o2.frame.x + o2.frame.w / 2 : NaN;
      /* the board has no end to stop at (item 6): the view centers on the spot, so the frame runs past the windows' end */
      const end4 = o2 ? Math.max(...o2.shapes.map((q) => q.x + q.w)) : NaN, past = !!o2 && o2.frame.x + o2.frame.w > end4 + 4;
      check('4a a click on an empty part at the right end takes the view there, centered on the click, past the windows\' end, same zoom', !!sp && after.pan > v.pan + 100 && Math.abs(fc - tx) < 2.5 && past && Math.abs(after.zoom - v.zoom) < 1e-6, `${sp ? `clicked ${r2(tx - o.area.x)} px into the map of ${r2(o.area.w)}` : 'no empty spot at the right end'}; pan ${r2(v.pan)} -> ${r2(after.pan)}; the frame centered at ${o2 ? r2(fc - o2.area.x) : '-'} px, its right side ${o2 ? r2(o2.frame.x + o2.frame.w - o2.area.x) : '-'} px, the windows end at ${o2 ? r2(end4 - o2.area.x) : '-'} px; zoom ${r2(after.zoom)}`);
      check('4b it stays up under the pointer', !!o2 && o2.shown, o2 ? `up ${o2.shown}` : 'gone');
      let disk, saved;
      const by = Date.now() + 3000;
      do {
        await sleep(200);
        disk = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8')).ws.find((w) => w.id === 'infra');
        saved = disk.panUnit === '%' ? ((disk.pan || 0) / 100) * after.vw : disk.pan || 0;
      } while (Math.abs(saved - after.pan) >= 1 && Date.now() < by);
      check('4c where it took the view is saved', Math.abs(saved - after.pan) < 1, `saved pan ${r2(saved)} px (${disk.panUnit === '%' ? `${r2(disk.pan || 0)}% of the view` : 'px'})`);
      await shot(c, path.join(OUT, '04-after-click.png'));
    } else check('4 a click on an empty part', false, 'it never came up');
  }

  /* 5. a click on a window's shape: at that window, in front, flashed (what its sidebar row does) */
  {
    const o = await ov(c);
    if (o && o.shown) {
      const s0 = [...o.shapes].sort((a, b) => a.x - b.x || a.y - b.y)[0];
      /* The flash as the page starts it, so a click that reaches the page late under load still counts it. */
      await c.eval(`(() => { window.__flashed = []; window.__onFlash = (e) => { const w = e.animationName === 'flashwin' && e.target.closest && e.target.closest('.win'); if (w) window.__flashed.push(w.dataset.id); }; addEventListener('animationstart', window.__onFlash, true); return true; })()`);
      const from = await where(c);
      await click(c, s0.x + 3, s0.y + 3);
      await settle(() => where(c), from, 4000, drawn);
      const flashed = await c.eval(`(() => { removeEventListener('animationstart', window.__onFlash, true); return [...new Set(window.__flashed)]; })()`);
      const after = await view(c), fr = await c.eval(frontId);
      check('5 a click on a window\'s shape goes to it: in view, in front, flashed', after.pan < 2 && fr === 'i-bench' && flashed.join() === 'i-bench', `pan ${r2(after.pan)}, front ${fr}, flashed ${flashed.join(',') || 'none'}`);
    } else check('5 a click on a window\'s shape', false, 'not up');
  }

  /* 6. press and drag in the map: the view follows live and stays where let go */
  {
    await settle(() => mapAt(c), null, 2000);
    const o = await ov(c);
    if (o && o.shown) {
      const fx = o.frame.x + o.frame.w / 2, fy = o.y + o.h / 2, pans = [];
      await mouse(c, 'mouseMoved', fx, fy);
      await mouse(c, 'mousePressed', fx, fy);
      for (let i = 1; i <= 8; i++) { await mouse(c, 'mouseMoved', fx + i * 6, fy, { down: true }); await sleep(20); pans.push((await view(c)).pan); }
      await mouse(c, 'mouseReleased', fx + 48, fy);
      await sleep(250);
      const end = await view(c);
      const rising = pans.every((p, i) => i === 0 || p >= pans[i - 1]) && pans[pans.length - 1] > pans[0] + 100;
      check('6 a drag in the map moves the view live and it stays where let go', rising && Math.abs(end.pan - pans[pans.length - 1]) < 1, `pan during ${pans.map(Math.round).join(' ')}, after ${r2(end.pan)}`);
    } else check('6 a drag in the map', false, 'not up');
  }

  /* 7. a button held: it never comes up, even in the corner; let go there, the next move brings it */
  {
    await leave(c);
    v = await view(c);
    const k = corner(v);
    const a = await watch(c, async () => {
      const sx = v.left + v.vw * 0.6, sy = v.top + 46;
      await mouse(c, 'mouseMoved', sx, sy);
      await mouse(c, 'mousePressed', sx, sy);
      await moveTo(c, sx, sy, k.x, k.y, { steps: 10, gapMs: 16, down: true });
      await sleep(400);
      await mouse(c, 'mouseReleased', k.x, k.y);
    }, 50);
    check('7a with the desktop held it never comes up in the corner', a.up === 0, `${a.up} of ${a.n} samples up`);
    await mouse(c, 'mouseMoved', k.x + 2, k.y);
    const o = await waitFor(async () => { const x = await ov(c); return x && x.shown ? x : null; }, 1500, 'up').catch(() => null);
    check('7b let go there, the next move brings it up', !!o);
    await leave(c);
    /* a fling, and the pointer to the corner while the view still glides: it waits until the view is still and drawn
       where nav keeps it (a glide past an end holds a moment before it springs back) */
    await home(c);
    v = await view(c);
    const k2 = corner(v), samples = [];
    const SAMPLE = `(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), sec = document.querySelector('.ws[data-id="' + s.ui.at + '"]'), cv = sec && sec.querySelector('.canvas'), m = new DOMMatrixReadOnly(getComputedStyle(cv).transform), o = getComputedStyle(document.querySelector('.ov')); return { x: -m.m41 / (m.a || 1), pan: ws.panUnit === '%' ? ((ws.pan || 0) / 100) * document.getElementById('viewport').getBoundingClientRect().width : ws.pan || 0, up: o.visibility === 'visible' && parseFloat(o.opacity) > 0.05 }; })()`;
    let sampling = true, err = null;
    const sampler = (async () => { while (sampling) { const x = await c.eval(SAMPLE); samples.push(x); if (x.up && samples.length > 2 && samples[samples.length - 2].up) break; await sleep(10); } })().catch((e) => { err = e; sampling = false; });
    await drag(c, v.left + v.vw * 0.8, v.top + 46, Array(10).fill(-40), { gapMs: 12 });
    await moveTo(c, v.left + v.vw * 0.8 - 400, v.top + 46, k2.x, k2.y, { steps: 3, gapMs: 10 });
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !(samples.length > 2 && samples[samples.length - 1].up)) { await mouse(c, 'mouseMoved', k2.x + (samples.length % 2), k2.y); await sleep(30); }
    sampling = false;
    await sampler;
    if (err) throw err;
    const first = samples.findIndex((x) => x.up);
    const moved = first > 1 && samples.slice(0, first).some((x, i, a) => i > 0 && Math.abs(x.x - a[i - 1].x) > 0.5);
    const placed = first > 0 && Math.abs(samples[first].x - samples[first].pan) < 0.6;
    check('7c reached while the view still glides, it comes up only once the view is still where nav keeps it', moved && placed, `${first} samples of glide (moving: ${moved}); when it came up the view was at ${first >= 0 ? r2(samples[first].x) : '-'} px, kept at ${first >= 0 ? r2(samples[first].pan) : '-'}`);
    await leave(c);
  }

  /* 8. thrown into the corner or against an edge at the bottom right, it comes up (owner 23:41 "go to that part of the
        screen like at the bottom right"; layout's walk); a quick pass through it and on out shows nothing */
  {
    v = await view(c);
    for (const [name, x, y] of [['into the corner', v.right - 1, v.bottom - 1], ['against the bottom edge', v.right - 100, v.bottom - 1], ['against the right edge 6 px up', v.right - 1, v.bottom - 6]]) {
      await moveTo(c, v.left + v.vw * 0.5, v.top + v.vh * 0.5, x, y, { steps: 4, gapMs: 8 });
      const o = await waitFor(async () => { const q = await ov(c); return q && q.shown && q.op > 0.95 ? q : null; }, 1500, 'up').catch(() => null);
      check(`8 a quick throw ${name} brings it up`, !!o, `pointer at ${r2(v.right - x)} px from the right, ${r2(v.bottom - y)} px from the bottom`);
      await leave(c);
    }
    /* Quick as the page saw it: from its handling the move into the bottom right to its handling the next move, out, less
       than the 90 ms dwell. Under load the test's moves can reach the page far apart; such a pass is not quick, so again. */
    await c.eval(`(() => { window.__moves = []; const f = (e) => window.__moves.push([performance.now(), e.clientX, e.clientY]); addEventListener('pointermove', f, { capture: true, passive: true }); window.__movesOff = () => removeEventListener('pointermove', f, { capture: true }); return true; })()`);
    const tx = v.right - 60, ty = v.bottom - 2, seen = [];
    let a = null;
    for (let i = 0; i < 6 && !a; i++) {
      await c.eval('window.__moves.length = 0');
      const w = await watch(c, async () => {
        await moveTo(c, v.left + v.vw * 0.5, v.top + v.vh * 0.5, tx, ty, { steps: 3, gapMs: 8 });
        await moveTo(c, tx, ty, v.left + v.vw * 0.5, v.top + 100, { steps: 3, gapMs: 8 });
        await sleep(300);
      }, 300);
      const ms = await c.eval(`(() => { const m = window.__moves, i = m.findIndex((p) => Math.abs(p[1] - ${tx}) < 0.5 && Math.abs(p[2] - ${ty}) < 0.5); return i >= 0 && m[i + 1] ? m[i + 1][0] - m[i][0] : null; })()`);
      seen.push(`${ms === null ? '?' : r2(ms)} ms${w.up ? ', up' : ''}`);
      if (ms !== null && ms < 90) a = w;
      else await waitFor(async () => { const o = await ov(c); return o && o.vis === 'hidden' ? o : null; }, 2000, 'the overview to go').catch(() => null);
    }
    await c.eval('window.__movesOff()');
    check('8 a quick pass through the bottom right and on out shows nothing', !!a && a.up === 0, `${a ? `${a.up} of ${a.n} samples up` : 'no pass in 6 was quick as the page saw it'}; in the bottom right as the page saw it: ${seen.join('; ')}`);
  }

  /* 9. pinched out: until it all fits there is nothing to show; short of that, the frame spans the height */
  {
    await home(c);
    v = await view(c);
    await pinch(c, v.left + v.vw * 0.5, v.top + v.vh * 0.45, Array(10).fill(10));
    await sleep(800);
    const z = await view(c), o = await reach(c);
    check('9a pinched out until infra fits, the corner stays empty', !o && z.zoom < 0.62, `zoom ${r2(z.zoom)}; ${o ? 'came up' : 'stayed down'}`);
    await leave(c);
    await unzoom(c);
    await home(c);
    v = await view(c);
    await pinch(c, v.left + v.vw * 0.5, v.top + v.vh * 0.45, Array(2).fill(11));
    await sleep(800);
    const z2 = await view(c), o2 = await reach(c);
    const okBand = !!o2 && o2.frame.y <= o2.area.y + 1 && o2.frame.y + o2.frame.h >= o2.area.y + o2.area.h - 1 && o2.shapes.every((q) => q.y >= o2.frame.y - 1 && q.y + q.h <= o2.frame.y + o2.frame.h + 1);
    check('9b pinched out, still wider than the view: it comes up, the frame spans the height and every window is within it', okBand && z2.zoom < 0.9, `zoom ${r2(z2.zoom)}; ${o2 ? `frame ${r2(o2.frame.y - o2.area.y)}..${r2(o2.frame.y - o2.area.y + o2.frame.h)} of ${r2(o2.area.h)}` : 'not up'}`);
    if (o2) {
      const sp = emptyRight(o2), from = await where(c), tx = sp ? sp.x : NaN;
      if (sp) await click(c, sp.x, sp.y);
      await settle(() => where(c), from, 4000, drawn);
      const z3 = await view(c);
      await settle(() => mapAt(c), null, 2000);
      const o3 = await ov(c), fc = o3 && o3.frame ? o3.frame.x + o3.frame.w / 2 : NaN;
      const end9 = o3 ? Math.max(...o3.shapes.map((q) => q.x + q.w)) : NaN, past9 = !!o3 && o3.frame.x + o3.frame.w > end9 + 4;
      check('9c there a click on an empty part at the right end moves sideways only, centered on the click, past the windows\' end', !!sp && Math.abs(z3.panY - z2.panY) < 0.5 && z3.pan > z2.pan + 50 && Math.abs(fc - tx) < 2.5 && past9, `pan ${r2(z2.pan)} -> ${r2(z3.pan)}, panY ${r2(z2.panY)} -> ${r2(z3.panY)}; ${sp ? `clicked ${r2(tx - o2.area.x)} px into the map` : 'no empty spot at the right end'}, the frame centered at ${o3 ? r2(fc - o3.area.x) : '-'} px, its right side ${o3 ? r2(o3.frame.x + o3.frame.w - o3.area.x) : '-'} px, the windows end at ${o3 ? r2(end9 - o3.area.x) : '-'} px`);
      await shot(c, path.join(OUT, '09-zoomed-out.png'));
    }
    await leave(c);
    await unzoom(c);
  }

  /* 10. a one-screen space at 100%: nothing to show; zoomed in: up, smaller frame, a click moves both ways */
  {
    await pill(c, 1);
    v = await view(c);
    const o = await reach(c);
    check('10a mynotes at 100%, all in view: the corner stays empty', !o && v.ws === 'mynotes', `on ${v.ws}, zoom ${v.zoom}`);
    await leave(c);
    await pinch(c, v.left + v.vw * 0.3, v.top + v.vh * 0.3, Array(6).fill(-10));
    await sleep(800);
    const z = await view(c), o2 = await reach(c);
    check('10b zoomed in, it comes up with a frame smaller both ways', !!o2 && o2.frame.w < o2.w - 4 && o2.frame.h < o2.h - 4, `zoom ${r2(z.zoom)}; ${o2 ? `frame ${r2(o2.frame.w)}x${r2(o2.frame.h)} of ${r2(o2.w)}x${r2(o2.h)}` : 'not up'}`);
    if (o2) {
      /* An empty part low on the right: the first spot 95% across, from 55% down, that no window's shape covers (a click
         on a shape goes to that window instead, which 5 covers). */
      const tx = o2.area.x + o2.area.w * 0.95, covered = (y) => o2.shapes.some((q) => tx >= q.x - 1 && tx <= q.x + q.w + 1 && y >= q.y - 1 && y <= q.y + q.h + 1);
      let ty = null;
      for (let f = 0.55; f <= 0.9 && ty === null; f += 0.01) if (!covered(o2.area.y + o2.area.h * f)) ty = o2.area.y + o2.area.h * f;
      const onShape = ty === null;
      const from = await where(c);
      if (!onShape) await click(c, tx, ty);
      await settle(() => where(c), from, 4000, drawn);
      const after = await view(c);
      check('10c a click on an empty part low on its right takes the view down and right, same zoom', !onShape && after.panY > z.panY + 5 && after.pan > z.pan + 5 && r2(after.zoom) === r2(z.zoom), `${onShape ? 'no empty part low on its right; ' : `clicked ${r2(((ty - o2.area.y) / o2.area.h) * 100)}% down; `}pan ${r2(z.pan)},${r2(z.panY)} -> ${r2(after.pan)},${r2(after.panY)}`);
    }
    await leave(c);
    await unzoom(c);
    await home(c);
  }

  /* 11. the board's edge double-click (item 6): with nothing past that edge it does nothing, and with every window in
         view the map stays down, at the right edge near the corner and at the left edge */
  {
    v = await view(c);
    const e1 = await end(c), ex = v.right - 10, ey = v.bottom - 30;
    await dblclick(c, ex, ey);
    await sleep(500);
    const a1 = await view(c), e2 = await end(c), o = await reach(c);
    check('11a a double-click at the right edge near the corner, nothing past it: nothing moves, and with every window in view the map stays down', Math.abs(e2 - e1) < 0.01 && Math.abs(a1.pan - v.pan) < 0.5 && !o, `mynotes ends at ${r2(e1)}% -> ${r2(e2)}%, pan ${r2(v.pan)} -> ${r2(a1.pan)}; ${o ? 'came up' : 'stayed down'}`);
    await leave(c);
    await pill(c, 3);
    await home(c);
    v = await view(c);
    const before = await c.eval(`window.__flow.state().ws.find((w) => w.id === 'voiceless').windows.map((w) => w.x).join()`);
    await dblclick(c, v.left + 10, v.top + v.vh / 2);
    await sleep(600);
    const lv = await view(c), after = await c.eval(`window.__flow.state().ws.find((w) => w.id === 'voiceless').windows.map((w) => w.x).join()`), ol = await reach(c);
    check('11d a double-click at the left edge, nothing past it: nothing moves, and the map stays down', before === after && Math.abs(lv.pan - v.pan) < 0.5 && !ol, `voiceless windows at ${before} -> ${after}, pan ${r2(v.pan)} -> ${r2(lv.pan)}; ${ol ? 'came up' : 'stayed down'}`);
    await leave(c);
  }

  /* 11e. a double-click on the right edge adds room everywhere along it, with the map down or up, beside it and below
         it (spaces' edge; the map's trigger counting the outermost px takes nothing from it); 11c, a double-click on
         the map adds none. Room is read as where the space ends: a double-click moves a window past the edge one view on. */
  {
    await pill(c, 4);
    v = await view(c);
    let last = await end(c);
    for (const [name, y] of [['a quarter down', v.top + v.vh * 0.25], ['halfway', v.top + v.vh * 0.5]]) {
      await dblclick(c, v.right - 10, y);
      await sleep(500);
      const r = await end(c);
      check(`11e a double-click on the right edge ${name} adds room`, r > last + 50, `ef ends at ${r2(last)}% -> ${r2(r)}%`);
      last = r;
    }
    const o = await reach(c);
    if (o) {
      for (const [name, y] of [['beside the map while it is up', o.y + o.h / 2], ['below the map in the bottom strip, while it is up', v.bottom - 5]]) {
        await dblclick(c, v.right - 10, y);
        await sleep(500);
        const r = await end(c), q = await ov(c);
        check(`11e a double-click on the right edge ${name} adds room`, r > last + 50, `ef ends at ${r2(last)}% -> ${r2(r)}%; the map up: ${q.shown}`);
        last = r;
      }
      const o3 = await ov(c);
      await dblclick(c, o3.x + o3.w * 0.2, o3.y + 3);
      await sleep(500);
      const r3 = await end(c);
      check('11c a double-click on the map adds no room', Math.abs(r3 - last) < 0.01, `ef ends at ${r2(last)}% -> ${r2(r3)}%`);
    } else check('11e the map comes up in ef, its terminal past the view', false, 'not up');
    await leave(c);
  }

  /* 11f. spaces' spots on the right edge: the strip's inner end beside the map, a double-click while the map is still
         fading in after a throw into the corner, and below the map when zoomed out (one view at actual size) */
  {
    v = await view(c);
    let last = await end(c);
    let o = await reach(c);
    if (o) {
      await dblclick(c, v.right - 23, o.y + o.h / 2);
      await sleep(500);
      let r = await end(c);
      check('11f a double-click at the strip\'s inner end beside the map, while it is up, adds room', r > last + 50, `ef ends at ${r2(last)}% -> ${r2(r)}%; ${r2(v.right - 23 - (o.x + o.w))} px right of the map`);
      last = r;
    } else check('11f the map is up in ef', false, 'not up');
    await leave(c);
    await moveTo(c, v.left + v.vw * 0.5, v.top + v.vh * 0.5, v.right - 1, v.bottom - 1, { steps: 4, gapMs: 8 });
    await sleep(110);
    const fading = await ov(c);
    await dblclick(c, v.right - 10, v.bottom - 5);
    await sleep(500);
    let r = await end(c);
    check('11f a double-click on the edge right after a throw into the corner, the map fading in, adds room', r > last + 50, `ef ends at ${r2(last)}% -> ${r2(r)}%; the map's opacity at the double-click about ${r2(fading.op)}`);
    last = r;
    await leave(c);
    await pinch(c, v.left + v.vw * 0.5, v.top + v.vh * 0.5, Array(7).fill(10));
    await sleep(800);
    const z = await view(c);
    o = await reach(c);
    if (o) {
      await dblclick(c, v.right - 10, v.bottom - 5);
      await sleep(500);
      r = await end(c);
      check('11f zoomed out, a double-click below the map adds one view at actual size', Math.abs(r - last - 100) < 0.5, `zoom ${r2(z.zoom)}; ef ends at ${r2(last)}% -> ${r2(r)}%`);
    } else check('11f zoomed out in ef, the map comes up', false, `zoom ${r2(z.zoom)}`);
    await leave(c);
    await unzoom(c);
  }

  /* 11g. the outermost px of the right edge near the corner, which nav counts for the double-click as the map counts it
         for coming up (batch 4): a double-click there adds room without moving the view (owner 22:50), the map down
         or up, and the map still comes up */
  {
    v = await view(c);
    let last = await end(c), a, r;
    const still = (b) => Math.abs(b.pan - v.pan) < 0.5 && Math.abs(b.panY - v.panY) < 0.5;
    /* The map not up yet as the page saw it at the double-click; under load the double-click can reach the page after the
       map came up, so again from the middle. Every double-click must add room and keep the view. */
    let down = false, each = true;
    const seen = [];
    for (let i = 0; i < 6 && !down; i++) {
      if (i) await leave(c);
      await c.eval(`(() => { window.__ovAtDbl = null; addEventListener('dblclick', () => { const cs = getComputedStyle(document.querySelector('.ov')); window.__ovAtDbl = cs.visibility === 'visible' ? parseFloat(cs.opacity) : 0; }, { capture: true, once: true }); return true; })()`);
      await dblclick(c, v.right - 1, v.bottom - 5);
      await sleep(500);
      a = await view(c);
      r = await end(c);
      const at = await c.eval('window.__ovAtDbl');
      each = each && r > last + 50 && still(a);
      seen.push(`ends at ${r2(last)}% -> ${r2(r)}%, pan ${r2(a.pan)},${r2(a.panY)}, the map's opacity ${at === null ? 'not read' : r2(at)}`);
      down = at !== null && at < 0.95;
      last = r;
    }
    check('11g a double-click on the outermost px of the right edge near the corner, the map not up yet, adds room and the view stays', each && down, `ef from pan ${r2(v.pan)},${r2(v.panY)}: ${seen.join('; ')}`);
    const o0 = await waitFor(async () => { const q = await ov(c); return q && q.shown && q.op > 0.95 ? q : null; }, 1200, 'up').catch(() => null);
    check('11g resting there after the double-click, the map stays down: a press there is work, not a reach', !o0, o0 ? 'came up' : 'stayed down');
    await leave(c);
    const o = await reach(c);
    check('11g left and reached for again, it comes up', !!o, o ? `box ${r2(o.w)}x${r2(o.h)}, its right side ${r2(v.right - (o.x + o.w))} px from the edge` : 'not up');
    if (o) {
      for (const [name, y] of [['below the map', v.bottom - 5], ['beside the map', o.y + o.h / 2]]) {
        await dblclick(c, v.right - 1, y);
        await sleep(500);
        a = await view(c);
        r = await end(c);
        const q = await ov(c);
        check(`11g with it up, a double-click on the outermost px ${name} adds room, the view stays and it stays up`, r > last + 50 && still(a) && q.shown, `ef ends at ${r2(last)}% -> ${r2(r)}%; pan ${r2(a.pan)},${r2(a.panY)}; the map up: ${q.shown}`);
        last = r;
      }
    }
    await leave(c);
    const o2 = await reach(c);
    check('11g after that, reached for, it comes up', !!o2, o2 ? `frame ${r2(o2.frame.w)} of ${r2(o2.w)}` : 'not up');
    await leave(c);
  }

  /* 18. a note made at the bottom right with the desktop menu's new note ("new note here" until batch 8, "new note"
         after; flows' board walk): the pointer stays in the corner and the map stays down over the new note; left and
         reached for again, it comes up */
  {
    await home(c);
    v = await view(c);
    const sp = { x: v.right - 160, y: v.bottom - 60 };
    const notes = () => c.eval(`window.__flow.state().ws.find((w) => w.id === 'ef').windows.length`);
    await mouse(c, 'mouseMoved', sp.x, sp.y);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x, y: sp.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.x, y: sp.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    const item = await waitFor(() => c.eval(`(() => { const e = [...document.querySelectorAll('.ctx button')].find((x) => /^new note\\b/.test(x.textContent.trim())); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`), 3000, 'the menu').catch(() => null);
    if (item) {
      /* The corner as overview.js counts it, so the pointer never leaves it on the way: x past right - 368, y past bottom - 256. */
      const inCorner = (p) => p.x >= v.right - 368 && p.y >= v.bottom - 256;
      const before = await notes(), k = corner(v);
      await moveTo(c, sp.x, sp.y, item.x, item.y, { steps: 4, gapMs: 16 });
      await click(c, item.x, item.y);
      const made = await waitFor(async () => ((await notes()) > before ? true : null), 3000, 'the note').catch(() => false);
      const a = await watch(c, async () => { await moveTo(c, item.x, item.y, k.x, k.y, { steps: 6, gapMs: 16 }); await sleep(900); }, 300);
      check('18 a note made at the bottom right with the menu\'s new note: the pointer staying in the corner, the map stays down over it', !!made && inCorner(item) && a.up === 0, `note made: ${!!made}; the menu item ${r2(v.right - item.x)} px from the right and ${r2(v.bottom - item.y)} px from the bottom${inCorner(item) ? '' : ' (outside the corner: the case did not happen)'}; ${a.up} of ${a.n} samples up`);
      await leave(c);
      const o = await reach(c);
      check('18 left and reached for again, it comes up', !!o, o ? `${o.shapes.length} shapes` : 'not up');
      await leave(c);
    } else check('18 a note made at the bottom right', false, 'no "new note" in the menu');
  }

  /* 12. sub-workspaces: only the space on screen; a two-finger swipe over it steps the space and it follows */
  {
    await pill(c, 0);
    const o = await reach(c);
    check('12a flow\'s main space: its own 3 windows only', !!o && o.shapes.length === 3, `${o ? o.shapes.length : 'no'} shapes`);
    if (o) {
      const from = await where(c);
      await swipe(c, o.x + o.w / 2, o.y + o.h / 2, Array(12).fill(20));
      await settle(() => where(c), from, 4000, drawn);
      const r = await view(c), o2 = await ov(c);
      check('12b a two-finger swipe over it goes to research, and it shows research\'s 3 windows', r.at === 'z-research' && o2.shown && o2.shapes.length === 3, `at ${r.at}, up ${o2.shown}, ${o2.shapes.length} shapes`);
      await shot(c, path.join(OUT, '12-research.png'));
      await swipe(c, o.x + o.w / 2, o.y + o.h / 2, Array(12).fill(-20));
      await waitFor(async () => ((await view(c)).at === null ? true : null), 6000, 'flow back at its main space');
    }
    await leave(c);
  }

  /* 15. from far out, a click on a window's shape goes to that window as its sidebar row does, at the same zoom (item
         6: going to a window never zooms): infra pinched out to about two thirds, team reading partly past the view. */
  {
    await pill(c, 2);
    await home(c);
    v = await view(c);
    const before15 = await where(c);
    await pinch(c, v.left + v.vw * 0.5, v.top + v.vh * 0.5, Array(4).fill(10));
    await sleep(900);
    await settle(() => where(c), before15, 4000, drawn);
    const far = await view(c);
    if (!(far.zoom < 1)) check('15 from far out', false, `the pinch did not zoom out: zoom ${r2(far.zoom)}`);
    else {
      const o = await reach(c);
      if (o) {
        const s0 = [...o.shapes].sort((a, b) => b.h - a.h || b.x - a.x)[0];
        const from = await where(c);
        await click(c, s0.x + s0.w / 2, s0.y + 3);
        await settle(() => where(c), from, 4000, drawn);
        const after = await view(c), fr = await c.eval(frontId);
        const t = await c.eval(rectOf('.ws[data-id="infra"] .win[data-id="i-team"]')), in1 = !!t && t.x >= after.left - 1 && t.x + t.w <= after.right + 1;
        check('15 from far out a click on a window\'s shape goes to it at the same zoom, in view and in front (going to a window never zooms)', far.zoom < 0.7 && Math.abs(after.zoom - far.zoom) < 0.001 && in1 && fr === 'i-team', `zoom ${r2(far.zoom)} -> ${r2(after.zoom)}, in view ${in1}, front ${fr}`);
      } else check('15 from far out', false, `not up at zoom ${r2(far.zoom)}`);
      await leave(c);
    }
  }

  /* 13. a popped-out sub-workspace: none for it in the main window; its pop-out has its own */
  {
    await pill(c, 0);
    const row = await c.eval(`(() => { const e = document.querySelector('#sblist [data-zpop="z-research"]'); if (!e) return null; const r = e.getBoundingClientRect(), t = e.closest('.tr').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tx: t.left + 30, ty: t.top + t.height / 2 }; })()`);
    if (row) {
      await mouse(c, 'mouseMoved', row.tx, row.ty);
      await sleep(150);
      await click(c, row.x, row.y);
      const t = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 20000, 'the pop-out').catch(() => null);
      if (t) {
        const p = await Cdp.connect(t.webSocketDebuggerUrl);
        await p.send('Runtime.enable');
        await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await waitFor(() => p.eval('!!(window.__flow && window.__flow.ready)'), 30000, 'the pop-out to be ready');
        await p.eval('window.__flow.ready.then(() => true)');
        await sleep(2500);
        v = await view(c);
        const before = v.at;
        await swipe(c, v.left + v.vw * 0.5, v.top + 46, Array(12).fill(20));
        await sleep(300);
        const right = (await view(c)).at, t1 = Date.now();
        /* the step ends at the swipe's speed after it is let go, which a loaded machine makes later (2.9 to 3.9 s at load
           120, overview-probe-popswipe.mjs) */
        const went = await waitFor(async () => { const q = await view(c); return q.at === 'z-research' ? q : null; }, 6000, 'the main window to go to research').catch(() => null);
        const m = went || await view(c), dt = Date.now() - t1, om = await reach(c);
        check('13a the main window has none for research while it is popped out', m.at === 'z-research' && !om, `main at ${before} -> ${right} after the swipe -> ${m.at} ${r2(dt / 1000)} s later; ${om ? 'came up' : 'stayed down'}`);
        await leave(c);
        const pv = await p.eval(VIEW), k = corner(pv);
        await moveTo(p, pv.left + pv.vw / 2, pv.top + pv.vh / 2, k.x, k.y, { steps: 10, gapMs: 16 });
        await sleep(60);
        await mouse(p, 'mouseMoved', k.x + 1, k.y);
        const op = await waitFor(async () => { const x = await p.eval(OV); return x && x.shown ? x : null; }, 1500, 'the pop-out\'s overview').catch(() => null);
        check('13b the pop-out has its own, with research\'s 3 windows', !!op && op.shapes.length === 3, op ? `${op.shapes.length} shapes` : 'not up');
        await shot(p, path.join(OUT, '13-popout.png'));
        if (op) {
          /* Where research ends: room at the view's edge either moves what lies past it one view on, or is kept as roomRight. */
          const room = () => p.eval(`(() => { const s = window.__flow.state(), fl = s.ws.find((w) => w.id === 'flow'), zn = fl.zones.find((z) => z.id === 'z-research'); const xs = fl.windows.filter((w) => w.zone === 'z-research').map((w) => w.x + w.w); return Math.max(100, Math.max(...xs) + 1.2, zn.roomRight || 0); })()`);
          let last = await room();
          for (const [name, x, y] of [['at the strip\'s inner end beside the map', pv.right - 23, op.y + op.h / 2], ['below the map in the bottom strip', pv.right - 10, pv.bottom - 5], ['at the outermost px near the corner', pv.right - 1, pv.bottom - 5]]) {
            await mouse(p, 'mouseMoved', x, y);
            const t0 = Date.now();
            await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse', timestamp: t0 / 1000 });
            await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse', timestamp: (t0 + 40) / 1000 });
            await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2, pointerType: 'mouse', timestamp: (t0 + 120) / 1000 });
            await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2, pointerType: 'mouse', timestamp: (t0 + 160) / 1000 });
            await sleep(600);
            const r = await room();
            check(`13c in the pop-out, a double-click on its right edge ${name}, the map up, adds room`, r > last + 50, `research ends at ${r2(last)}% -> ${r2(r)}%`);
            last = r;
          }
        }
        await p.eval('window.close()').catch(() => {});
        p.close();
        await sleep(1500);
      } else check('13 a pop-out', false, 'no pop-out window opened');
    } else check('13 a pop-out', false, 'no ⤢ on the research row');
  }

  /* 16. a pop-out narrower than the main window (lead, item 44): its map shows the same windows in the same places and
         the frame over the same part of the space, and a click in it lands where it points */
  {
    await pill(c, 0);
    v = await view(c);
    if ((await view(c)).at !== 'z-research') { await swipe(c, v.left + v.vw * 0.5, v.top + 46, Array(12).fill(20)); await sleep(900); }
    const norm = (o) => { const S = o.area; return { shapes: o.shapes.map((q) => ({ x: (q.x - S.x) / S.w, y: (q.y - S.y) / S.h, w: q.w / S.w, h: q.h / S.h })).sort((a, b) => a.x - b.x || a.y - b.y), frame: { x: (o.frame.x - S.x) / S.w, w: o.frame.w / S.w } }; };
    let om = await reach(c);
    if (om) {
      const from = await where(c);
      await click(c, om.area.x + om.area.w * 0.98, om.area.y + 2);
      await settle(() => where(c), from, 4000, drawn);
      await settle(() => mapAt(c), null, 2000);
      om = await ov(c);
    }
    const main = om && norm(om), mv = await view(c);
    await leave(c);
    const row = await c.eval(`(() => { const e = document.querySelector('#sblist [data-zpop="z-research"]'); if (!e) return null; const r = e.getBoundingClientRect(), t = e.closest('.tr').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tx: t.left + 30, ty: t.top + t.height / 2 }; })()`);
    if (main && row) {
      await mouse(c, 'mouseMoved', row.tx, row.ty);
      await sleep(150);
      await click(c, row.x, row.y);
      const t = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 20000, 'the pop-out').catch(() => null);
      if (t) {
        const p = await Cdp.connect(t.webSocketDebuggerUrl);
        p.errors = [];
        p.on((m) => { if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')) p.errors.push(m.method); });
        await p.send('Runtime.enable');
        await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await waitFor(() => p.eval('!!(window.__flow && window.__flow.ready)'), 30000, 'the pop-out to be ready');
        await p.eval('window.__flow.ready.then(() => true)');
        await sleep(1500);
        const pv = await p.eval(VIEW), k = corner(pv);
        await moveTo(p, pv.left + pv.vw / 2, pv.top + pv.vh / 2, k.x, k.y, { steps: 10, gapMs: 16 });
        await sleep(60);
        await mouse(p, 'mouseMoved', k.x + 1, k.y);
        const op = await waitFor(async () => { const x = await p.eval(OV); return x && x.shown && x.op > 0.95 ? x : null; }, 1500, 'the pop-out\'s overview').catch(() => null);
        if (op) {
          const pop = norm(op), d = (a, b) => Math.abs(a - b);
          const same = pop.shapes.length === main.shapes.length && pop.shapes.every((q, i) => d(q.x, main.shapes[i].x) < 0.01 && d(q.y, main.shapes[i].y) < 0.02 && d(q.w, main.shapes[i].w) < 0.01 && d(q.h, main.shapes[i].h) < 0.02);
          check('16a a pop-out narrower than the main window: its map shows the same windows in the same places', pv.vw < mv.vw - 50 && same, `viewport ${r2(pv.vw)} vs ${r2(mv.vw)} px; ${pop.shapes.length} vs ${main.shapes.length} shapes`);
          check('16b and its frame covers the same part of the space as in the main window', d(pop.frame.x, main.frame.x) < 0.01 && d(pop.frame.w, main.frame.w) < 0.01, `frame from ${r2(pop.frame.x * 100)}% (main ${r2(main.frame.x * 100)}%), ${r2(pop.frame.w * 100)}% wide (main ${r2(main.frame.w * 100)}%)`);
          const tx = op.area.x + op.area.w * 0.45, ty = op.area.y + 2;
          const center = async () => { const q = await p.eval(OV); return q && q.frame ? r2(q.frame.x + q.frame.w / 2) : null; };
          await click(p, tx, ty);
          await settle(center, r2(op.frame.x + op.frame.w / 2));
          const o2 = await p.eval(OV), fc = o2.frame.x + o2.frame.w / 2;
          check('16c a click in the pop-out\'s map lands where it points: the frame is centered on the click', Math.abs(fc - tx) < 2.5, `clicked at ${r2(tx - op.area.x)} px into the map, frame centered at ${r2(fc - o2.area.x)} px`);
          await shot(p, path.join(OUT, '16-narrow-popout.png'));
        } else check('16 a narrower pop-out', false, 'its overview did not come up');
        check('16d no console errors in the pop-out', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        await p.eval('window.close()').catch(() => {});
        p.close();
        await sleep(1500);
      } else check('16 a narrower pop-out', false, 'no pop-out window opened');
    } else check('16 a narrower pop-out', false, `${main ? '' : 'the main map did not come up; '}${row ? '' : 'no ⤢ on the research row'}`);
  }

  /* 17. a space grown three views tall with room below: the map still comes up, from the same place (it grows
         taller), and a click on the far window's shape goes there */
  {
    await pill(c, 3);
    for (let i = 0; i < 5; i++) {
      const n = await c.eval(rectOf('.ws[data-id="voiceless"] .win[data-id="v-note"]')), vb = (await view(c)).bottom;
      const gx = n.x + n.w / 2, gy = Math.min(n.y + n.h + 9, vb - 30);
      await dblclick(c, gx, gy);
      await sleep(700);
    }
    const o = await reach(c);
    const far = o && [...o.shapes].sort((a, b) => b.y - a.y)[0];
    check('17a in a space grown about three views tall the map comes up, taller than wide', !!o && o.h > o.w, o ? `${r2(o.w)}x${r2(o.h)} px, ${o.shapes.length} shapes` : 'not up');
    if (far) {
      const before = await view(c), from = await where(c);
      await click(c, far.x + far.w / 2, far.y + far.h / 2);
      await settle(() => where(c), from, 4000, drawn);
      const after = await view(c), t = await c.eval(rectOf('.ws[data-id="voiceless"] .win[data-id="v-term"]'));
      check('17b a click on the far window\'s shape takes the view down to it', after.panY > before.panY + 100 && t.y >= after.top - 1 && t.y + t.h <= after.bottom + 1, `panY ${r2(before.panY)} -> ${r2(after.panY)}; the terminal on screen at ${r2(t.y)}..${r2(t.y + t.h)}`);
      await shot(c, path.join(OUT, '17-tall.png'));
    } else check('17b a click on the far window\'s shape', false, o ? 'the map shows no window' : 'not up');
    await leave(c);
  }

  /* 14. a narrow window: the map keeps clear of the dock and its approach area */
  {
    await pill(c, 2);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 940, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    v = await view(c);
    const o = await reach(c), d = await c.eval(rectOf('#dock'));
    check('14 at 900 px wide it still comes up and keeps 52 px clear of the dock', !!o && o.x - (d.x + d.w) >= 51.5, `${o ? `map ${r2(o.x)}..${r2(o.x + o.w)}` : 'not up'}, dock ends at ${r2(d.x + d.w)}`);
    await shot(c, path.join(OUT, '14-narrow.png'));
    await leave(c);
    await c.send('Emulation.clearDeviceMetricsOverride');
    await sleep(800);
  }

  check('no console errors or exceptions', c.errors.length === 0, `${c.errors.slice(0, 6).join(' | ') || 'none'}${c.handled.length ? `; warnings for handled cases: ${c.handled.length}, ${c.handled[0]}` : ''}`);
} catch (err) {
  check('the run', false, err.stack || String(err));
} finally {
  if (c) c.close();
  await stop();
  log(`${pass} ok, ${fail} failed`);
  if (fail) process.exitCode = 1;
}




