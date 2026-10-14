// layout's check of a new window placed at a spot of open desktop (STATUS item 51; owner 23:45 "spawned at that exact
// space there", 22:50 "so everything still looks nice ... not necessarily say forcefully reorganizing"), with real input
// over CDP in layout's own isolated app (layout-lib.mjs): a dock button carried to open desktop where its own size would
// cover a neighbour, right-click "new note here" where only a smaller window fits, and pockets too small for a usable
// window, by right-click and by a carry, a plain dock click with no room for a note's own size in view, and a right-click
// in the strip above the windows, where nothing may be left under the new note, and the strip under the windows, carried
// and right-clicked, where the window above is not pushed, a click just above a wide window, which moves only by the
// overlap plus the gap, and zoom's case far out, by zoom's own steps. The layouts are set in the seed, as the owner could
// have arranged them. Notes only, no host windows.
//   LAYOUT_ROOT=<app tree> node test/layout-place.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/place-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, shot as shotOf } from './nav-lib.mjs';
import { type } from './ui-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'place-shots');
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
function overlaps(s, ignore = []) {
  const ids = Object.keys(s.wins).filter((id) => !ignore.includes(id)), out = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = s.wins[ids[i]], b = s.wins[ids[j]];
    if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) out.push(`${ids[i]}/${ids[j]}`);
  }
  return out;
}
const made = (a, b) => Object.keys(b.wins).filter((id) => !a.wins[id]);
const at = (s, id) => s.wins[id];

let px = 700, py = 400;
async function glide(x, y, n = 10) { for (let k = 1; k <= n; k++) await mouse(c, 'mouseMoved', px + ((x - px) * k) / n, py + ((y - py) * k) / n); px = x; py = y; }
/* Brings the dock up the way a hand does (to the bottom middle, no button held) and returns a button's centre. */
async function dockButton(kind) {
  const d = await ev(`(() => { const r = document.getElementById('dock').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 12 - 5 }; })()`);
  await glide(d.x, d.y, 12);
  await sleep(400);
  return ev(`(() => { const d = document.getElementById('dock'), b = d.querySelector('button[data-k=${q(kind)}]'), r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(d).opacity > 0.9 && d.style.pointerEvents !== 'none' }; })()`);
}
/* Presses a dock button and carries it to x, y in steps, held still before the release; check() runs while it is held. */
async function carry(kind, x, y, check) {
  const b = await dockButton(kind);
  if (!b.shown) throw new Error(`the dock did not come up before carrying ${kind}`);
  await glide(b.x, b.y, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  const n = 24;
  for (let k = 1; k <= n; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + ((x - b.x) * k) / n, y: b.y + ((y - b.y) * k) / n, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(16); }
  await sleep(150);
  const seen = check ? await check() : null;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  px = x; py = y;
  await sleep(700);
  return { button: b, seen };
}
/* the dashed outline showing in the view (the +'s own outlines, beside.js, sit there hidden) */
const outline = () => ev(`(() => { const g = [...document.getElementById('viewport').children].find((e) => (e.style.borderStyle === 'dashed' || /dashed/.test(e.style.border)) && e.style.display !== 'none'); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function goTo(id) {
  await ev(`__flow.go(__flow.state().ws.findIndex((w) => w.id === ${q(id)}))`);
  await sleep(900);
}

/* Right-click on the desktop at x, y and choose "new note here". */
async function noteHere(x, y, kind = 'note') {
  await glide(x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(400);
  const item = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => x.textContent.trim().startsWith(${q('new ' + kind)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!item) return false;
  await glide(item.x, item.y, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: item.x, y: item.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: item.x, y: item.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(800);
  return true;
}
const scr = (s, x, y) => ({ x: s.vp.x + (x / 100) * s.vp.w, y: s.vp.y + (y / 100) * s.vp.h });
/* The screen point of a point of the space on screen (% of the view), from the drawn canvas, wherever the view is. */
const spaceAt = (x, y) => ev(`(() => { const s = __flow.state(), id = s.ui.at, e = document.querySelector('.ws[data-id="' + id + '"]'), cv = e.querySelector(':scope > .canvas'), m = new DOMMatrixReadOnly(getComputedStyle(cv).transform), o = e.getBoundingClientRect(), vp = document.getElementById('viewport').getBoundingClientRect();
  return { x: o.left + m.m41 + m.a * (${x} / 100) * vp.width, y: o.top + m.m42 + m.a * (${y} / 100) * vp.height }; })()`);
const inside = (r, p) => p.x >= r.sx - 0.5 && p.x <= r.sx + r.sw + 0.5 && p.y >= r.sy - 0.5 && p.y <= r.sy + r.sh + 0.5;
const box = (r) => r && [+r.x.toFixed(2), +r.y.toFixed(2), +r.w.toFixed(2), +r.h.toFixed(2)];
const moved = (a, b, ids) => ids.filter((id) => !near(at(a, id).x, at(b, id).x) || !near(at(a, id).y, at(b, id).y));

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }));
  const set = (wsId, id, x, y, w, h) => Object.assign(state.ws.find((s) => s.id === wsId).windows.find((o) => o.id === id), { x, y, w, h });
  /* voiceless: open space at the top left, 350 px wide, with a window right of it and one under it */
  set('voiceless', 'v-page', 1.2, 60, 58.8, 28.4); set('voiceless', 'v-note', 30, 6.6, 68.8, 48); set('voiceless', 'v-term', 61.2, 56.4, 37.6, 32);
  /* ef: a pocket 176 px wide at the left, the rest of the space past it */
  set('ef', 'e-note', 16, 6.6, 30, 81.8); set('ef', 'e-page', 47.2, 6.6, 51.6, 47); set('ef', 'e-term', 47.2, 55.4, 51.6, 33);
  /* infra: a pocket 151 px wide at the top left, over the note that spans the width */
  set('infra', 'i-bench', 14, 6.6, 35.6, 52);
  /* flow: no free spot of a note's own size in view, one open column 320 px wide */
  set('flow', 'w-week', 1.2, 6.6, 20, 81.8);
  /* two more workspaces of note windows: zoom's case (zoom, 09:4x) and its mirror, a click just above a wide window */
  const mkWs = (id, name, wins) => ({ id, name, folder: '~', bg: '#141319', zones: [], closed: [],
    windows: wins.map(([wid, x, y, w, h]) => ({ id: wid, type: 'note', noteId: `n-${wid}`, x, y, w, h })),
    notes: wins.map(([wid]) => ({ id: `n-${wid}`, kind: 'note', title: wid, body: '' })) });
  state.ws.push(mkWs('zoomcase', 'zoom case', [['z-mck', 49.4, 6.6, 49.4, 50], ['z-design', 49.4, 58.4, 49.4, 30], ['z-week', 1.2, 55.4, 47, 33]]));
  state.ws.push(mkWs('mirror', 'mirror', [['m-top', 1.2, 16.6, 97.6, 40], ['m-low', 1.2, 58.4, 97.6, 30]]));
  /* browse's walk5b on b7copy2 (lead 16:5x): the page the dock's click made at the top left, the McKinsey page beside it
     27 px away, a shell and a note under them */
  state.ws.push(mkWs('topcase', 'top case', [['t-dock', 1.2, 6.6, 46, 47], ['t-mck', 49.4, 6.6, 49.4, 50], ['t-design', 49.4, 58.4, 49.4, 30], ['t-week', 1.2, 55.4, 47, 33]]));
  /* the same with the lower right of the view open (batch 9: a click with no room goes to the nearest open place in view) */
  state.ws.push(mkWs('topopen', 'top open', [['o-dock', 1.2, 6.6, 46, 47], ['o-mck', 49.4, 6.6, 49.4, 50], ['o-week', 1.2, 55.4, 47, 33]]));
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();

  /* 1. mynotes, a note carried to open desktop where its own size would cover the note window under it (overview's B2) */
  await goTo('mynotes');
  const s0 = await now(), ids0 = Object.keys(s0.wins);
  console.log(`mynotes: ${q(Object.fromEntries(ids0.map((k) => [k, box(s0.wins[k])])))}`);
  const T1 = scr(s0, 20, 30);
  const r1 = await carry('note', T1.x, T1.y, outline);
  const s1 = await now(), n1 = made(s0, s1), N1 = n1.length === 1 ? at(s1, n1[0]) : null;
  console.log(`new note: ${q(box(N1))}; outline while carried: ${q(r1.seen)}`);
  ok('a note carried to open desktop opens at its own size, over no window', !!N1 && near(N1.w, 34) && near(N1.h, 46) && overlaps(s1).length === 0, { at: box(N1), overlaps: overlaps(s1) });
  ok('it stops the usual gap short of the window under it', !!N1 && near(at(s1, 'mn-note').y - (N1.y + N1.h), 1.8, 0.05), { gap: N1 && at(s1, 'mn-note').y - (N1.y + N1.h) });
  ok('the place it was let go is in it', !!N1 && inside(N1, T1), { hand: T1, at: N1 && [N1.sx, N1.sy, N1.sw, N1.sh] });
  ok('while carried, the outline showed exactly where it opened', !!N1 && !!r1.seen && near(r1.seen.x, N1.sx, 1) && near(r1.seen.y, N1.sy, 1) && near(r1.seen.w, N1.sw, 1) && near(r1.seen.h, N1.sh, 1), { outline: r1.seen, opened: N1 && [N1.sx, N1.sy, N1.sw, N1.sh] });
  ok('nothing else moved and the view stayed', moved(s0, s1, ids0).length === 0 && near(s1.pan, s0.pan, 0.5), moved(s0, s1, ids0));
  ok('it takes the keys', !!N1 && s1.keys === n1[0], { keys: s1.keys });
  await type(c, 'placed-here');
  await sleep(400);
  const t1 = N1 && await ev(`(() => { const e = document.querySelector('.win[data-id=${q(n1[0])}] .ntitle'); return e && e.textContent; })()`);
  ok('real key presses go into it', t1 === 'placed-here', { title: t1 });
  await shot('01-carried-fits');

  /* 2. voiceless, right-click "new note here" in open space narrower than a note: a narrower note, nothing moves (B3) */
  await goTo('voiceless');
  const s2 = await now(), ids2 = Object.keys(s2.wins);
  console.log(`voiceless: ${q(Object.fromEntries(ids2.map((k) => [k, box(s2.wins[k])])))}`);
  const P2 = scr(s2, 10, 20);
  ok('right-click there offers "new note here"', await noteHere(P2.x, P2.y));
  const s3 = await now(), n2 = made(s2, s3), N2 = n2.length === 1 ? at(s3, n2[0]) : null;
  console.log(`new note: ${q(box(N2))}`);
  ok('a note made there fills the open space: as wide as it is, the usual gaps kept, as tall as a note', !!N2 && near(N2.x, 1.2) && near(N2.x + N2.w, at(s3, 'v-note').x - 1.2, 0.05) && near(N2.h, 46) && N2.w * s3.vp.w / 100 >= 300, { at: box(N2), px: N2 && Math.round(N2.w * s3.vp.w / 100) });
  ok('over no window, the click in it', !!N2 && overlaps(s3).length === 0 && inside(N2, P2), { overlaps: overlaps(s3) });
  ok('nothing else moved', moved(s2, s3, ids2).length === 0, moved(s2, s3, ids2));
  await shot('02-right-click-narrower');

  /* 7. voiceless, a note carried to the strip under the windows, so thin that its title bar row overlaps the window above:
     that window is not pushed; the note goes just under it, at the hand, and nothing moves (zoom, 09:4x) */
  const s3a = await now(), ids3a = Object.keys(s3a.wins);
  const H7 = await spaceAt(30, 89.5);
  console.log(`the hand at ${q(H7)}: ${await ev(`(() => { const e = document.elementFromPoint(${H7.x}, ${H7.y}); const w = e && e.closest && e.closest('.win'); return w ? 'window ' + w.dataset.id : (e.className || e.tagName); })()`)}`);
  await carry('note', H7.x, H7.y);
  const s3b = await now(), n7 = made(s3a, s3b), N7 = n7.length === 1 ? at(s3b, n7[0]) : null;
  console.log(`new note: ${q(box(N7))}; v-page ends at ${(at(s3b, 'v-page').y + at(s3b, 'v-page').h).toFixed(2)}`);
  ok('a note carried into the strip under a window goes just under it, held at the hand, at its own size', !!N7 && near(N7.w, 34) && near(N7.h, 46) && near(N7.x, 30 - 17, 0.3) && near(N7.y, at(s3b, 'v-page').y + at(s3b, 'v-page').h + 1.8, 0.1), { at: box(N7) });
  ok('the window above is not pushed and nothing moves; nothing is under it', moved(s3a, s3b, ids3a).length === 0 && overlaps(s3b).length === 0, { moved: moved(s3a, s3b, ids3a), overlaps: overlaps(s3b) });

  /* 8. voiceless, right-click "new note here" in the strip under the windows, too thin for a note: it opens at the click,
     reaching below, the view comes to it, and nothing moves; the windows above it are not pushed (zoom, 09:4x). The
     view went down to the note made in 7; v-page's sidebar row brings it back to where v-page shows (the board has no
     top edge, so swipes would go on past it). The click is at three quarters across, clear of the space's map at the
     bottom right and of the dock. */
  const row8 = await ev(`(() => { const e = document.querySelector('#sblist .tr[data-act="win|v-page"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (row8) {
    await glide(row8.x, row8.y);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row8.x, y: row8.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row8.x, y: row8.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(900);
  }
  const s3c0 = await now(), ids3 = Object.keys(s3c0.wins);
  console.log(`view back at ${q([s3c0.pan, s3c0.panY])}`);
  const PS = await spaceAt(75, 95), vp8 = (await now()).vp;
  ok('the strip under the windows is on screen', PS.x > vp8.x && PS.x < vp8.x + vp8.w && PS.y > vp8.y && PS.y < vp8.y + vp8.h, { at: PS, panY: (await now()).panY });
  console.log(`the strip at ${q(PS)}: ${await ev(`(() => { const e = document.elementFromPoint(${PS.x}, ${PS.y}); const w = e && e.closest && e.closest('.win'); return w ? 'window ' + w.dataset.id : (e.className || e.tagName); })()`)}`);
  ok('right-click in the strip under the windows offers "new note here"', await noteHere(PS.x, PS.y));
  const s3c = await now(), nS = made(s3c0, s3c), NS = nS.length === 1 ? at(s3c, nS[0]) : null;
  console.log(`new note: ${q(box(NS))}; view ${q([s3c0.pan, s3c0.panY, s3c.pan, s3c.panY])}`);
  /* batch 8 (lead 16:1x, "in view"): at the click as far as the view allows, so the view need not move to show it */
  ok('a note made there has its own size, as near the click as the view allows, the click in it', !!NS && near(NS.w, 34) && near(NS.h, 46) && NS.x <= 75 + 0.2 && NS.y <= 95 + 0.2 && inside(NS, PS), { at: box(NS) });
  ok('nothing moved and nothing is under it', moved(s3c0, s3c, ids3).length === 0 && overlaps(s3c).length === 0, { moved: moved(s3c0, s3c, ids3), overlaps: overlaps(s3c) });
  ok('the view came to it: it is shown whole', !!NS && NS.sy >= s3c.vp.y - 0.5 && NS.sy + NS.sh <= s3c.vp.y + s3c.vp.h + 0.5 && NS.sx >= s3c.vp.x - 0.5 && NS.sx + NS.sw <= s3c.vp.x + s3c.vp.w + 0.5, { at: NS && [NS.sx, NS.sy, NS.sw, NS.sh], vp: s3c.vp });
  await shot('08-strip-under-the-windows');

  /* 3. ef, right-click in a pocket narrower than any usable window: its own size there, what is past it makes way */
  await goTo('ef');
  const s4 = await now(), ids4 = Object.keys(s4.wins);
  console.log(`ef: ${q(Object.fromEntries(ids4.map((k) => [k, box(s4.wins[k])])))}`);
  const P4 = scr(s4, 7, 30);
  ok('right-click in the pocket offers "new note here"', await noteHere(P4.x, P4.y));
  const s5 = await now(), n4 = made(s4, s5), N4 = n4.length === 1 ? at(s5, n4[0]) : null;
  const dx4 = at(s5, 'e-note').x - at(s4, 'e-note').x;
  console.log(`new note: ${q(box(N4))}; e-note moved by ${dx4.toFixed(2)}`);
  ok('a note made there has its own size, at the pocket', !!N4 && near(N4.x, 1.2) && near(N4.w, 34) && near(N4.h, 46) && inside(N4, P4), { at: box(N4) });
  ok('what is past it made way together, just enough', !!N4 && near(at(s5, 'e-note').x, N4.x + N4.w + 1.2, 0.05) && ['e-page', 'e-term'].every((id) => near(at(s5, id).x - at(s4, id).x, dx4, 0.05)) && ids4.every((id) => near(at(s5, id).y, at(s4, id).y)), { eNote: at(s5, 'e-note').x, dx: dx4 });
  ok('nothing resized, no window over another, the view stayed', ids4.every((id) => near(at(s5, id).w, at(s4, id).w) && near(at(s5, id).h, at(s4, id).h)) && overlaps(s5).length === 0 && near(s5.pan, s4.pan, 0.5), overlaps(s5));
  await shot('03-right-click-makes-way');

  /* 4. infra, a note carried into a pocket too small: the outline shows it at its own size, and on letting go what is in
     its way makes way, each its own way (lead 16:1x): the row past it right, the note under it down */
  await goTo('infra');
  const s6 = await now(), ids6 = Object.keys(s6.wins);
  console.log(`infra: ${q(Object.fromEntries(ids6.map((k) => [k, box(s6.wins[k])])))}`);
  const T6 = scr(s6, 6, 30);
  const r6 = await carry('note', T6.x, T6.y, outline);
  const s7 = await now(), n6 = made(s6, s7), N6 = n6.length === 1 ? at(s7, n6[0]) : null;
  const dx6 = at(s7, 'i-bench').x - at(s6, 'i-bench').x;
  console.log(`new note: ${q(box(N6))}; i-bench moved by ${dx6.toFixed(2)}; outline ${q(r6.seen)}`);
  ok('carried into a pocket too small, it opens at its own size there, the place let go in it', !!N6 && near(N6.x, 1.2) && near(N6.w, 34) && near(N6.h, 46) && inside(N6, T6), { at: box(N6) });
  ok('the outline showed it there, at that size', !!N6 && !!r6.seen && near(r6.seen.x, N6.sx, 1) && near(r6.seen.y, N6.sy, 1) && near(r6.seen.w, N6.sw, 1) && near(r6.seen.h, N6.sh, 1), { outline: r6.seen, opened: N6 && [N6.sx, N6.sy, N6.sw, N6.sh] });
  ok('the windows in its way made way, each its own way by just enough: the row right, the note under it down', !!N6 && near(at(s7, 'i-bench').x, N6.x + N6.w + 1.2, 0.05) && ['i-sched', 'i-team'].every((id) => near(at(s7, id).x - at(s6, id).x, dx6, 0.05)) && near(at(s7, 'i-note').x, at(s6, 'i-note').x) && near(at(s7, 'i-note').y, Math.max(at(s6, 'i-note').y, N6.y + N6.h + 1.8), 0.05), { bench: [at(s6, 'i-bench').x, at(s7, 'i-bench').x], note: [at(s6, 'i-note').y, at(s7, 'i-note').y] });
  ok('no window over another, the view stayed', overlaps(s7).length === 0 && near(s7.pan, s6.pan, 0.5), overlaps(s7));
  await shot('04-carried-makes-way');

  /* 5. flow, a plain click on the dock's note with no free spot of its own size in view, but an open column that holds
     more than half a note (batch 10, lead 23:5x): in view, the column filled, as tall as a note; nothing else moves */
  await goTo('flow');
  const s8 = await now(), ids8 = Object.keys(s8.wins), end8 = Math.max(...ids8.map((k) => s8.wins[k].x + s8.wins[k].w));
  console.log(`flow: ${q(Object.fromEntries(ids8.map((k) => [k, box(s8.wins[k])])))}`);
  const b8 = await dockButton('note');
  await glide(b8.x, b8.y, 4);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b8.x, y: b8.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b8.x, y: b8.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(900);
  const s9 = await now(), n8 = made(s8, s9), N8 = n8.length === 1 ? at(s9, n8[0]) : null;
  console.log(`new note: ${q(box(N8))}`);
  ok('a plain click on the dock with no room for a note\'s own size, an open column holding more than half of it: it fills the column, as tall as a note', !!N8 && near(N8.x, at(s9, 'w-week').x + at(s9, 'w-week').w + 1.2) && near(N8.x + N8.w, at(s9, 'w-mck').x - 1.2) && near(N8.y, 6.6) && near(N8.h, 46) && N8.w >= 34 / 2, { at: box(N8) });
  ok('over no window, in view, nothing else moved', !!N8 && overlaps(s9).length === 0 && N8.sx >= s9.vp.x && N8.sx + N8.sw <= s9.vp.x + s9.vp.w && moved(s8, s9, ids8).length === 0, overlaps(s9));
  ok('it takes the keys', !!N8 && s9.keys === n8[0], { keys: s9.keys });
  await shot('05-dock-click-open-column');

  /* 6. mynotes, right-click "new note here" in the strip just above the windows (backlog's case on batch 4): no open area
     at the click, so it keeps its own size there and what is past it makes way; nothing is left under it */
  await goTo('mynotes');
  const s10 = await now(), ids10 = Object.keys(s10.wins);
  console.log(`mynotes: ${q(Object.fromEntries(ids10.map((k) => [k, box(s10.wins[k])])))}`);
  const P10 = { x: at(s10, 'mn-build').sx + 50, y: s10.vp.y + 46 };
  console.log(`the click at ${q(P10)}: ${await ev(`(() => { const e = document.elementFromPoint(${P10.x}, ${P10.y}); const w = e && e.closest && e.closest('.win'); return w ? 'window ' + w.dataset.id : (e.className || e.tagName); })()`)}`);
  ok('right-click in the strip above the windows offers "new note here"', await noteHere(P10.x, P10.y));
  const s11 = await now(), n10 = made(s10, s11), N10 = n10.length === 1 ? at(s11, n10[0]) : null;
  const dys = ids10.map((id) => at(s11, id).y - at(s10, id).y), dxs = ids10.map((id) => at(s11, id).x - at(s10, id).x);
  console.log(`new note: ${q(box(N10))}; moved by ${q(Object.fromEntries(ids10.map((id, i) => [id, [+dxs[i].toFixed(2), +dys[i].toFixed(2)]])))}`);
  ok('a note made there has its own size, its top left at the click as far as the view allows', !!N10 && near(N10.w, 34) && near(N10.h, 46) && near(N10.y, 6.6) && near(N10.sx, P10.x, 1), { at: box(N10), click: P10 });
  ok('it is over no window: what was under it made way', overlaps(s11).length === 0, overlaps(s11));
  ok('the windows that made way all moved down together by the same amount, none sideways', dys.some((d) => d > 5) && dys.filter((d) => d > 0.05).every((d) => near(d, Math.max(...dys), 0.05)) && dxs.every((d) => near(d, 0, 0.05)) && at(s11, 'mn-build').y > at(s10, 'mn-build').y + 5, { dy: dys, dx: dxs });
  ok('nothing resized and the view stayed', ids10.every((id) => near(at(s11, id).w, at(s10, id).w) && near(at(s11, id).h, at(s10, id).h)) && near(s11.pan, s10.pan, 0.5) && near(s11.panY, s10.panY, 0.5));
  await shot('06-top-strip-makes-way');

  /* 9. mirror: right-click "new note here" in the strip just above a wide window: no small nudge clears it, so the window
     makes way, only by what it overlaps the note plus the gap, never by the note's full size (lead, 10:3x) */
  await goTo('mirror');
  const s12 = await now(), ids12 = Object.keys(s12.wins);
  const P12 = scr(s12, 40, 10);
  console.log(`mirror: ${q(Object.fromEntries(ids12.map((k) => [k, box(s12.wins[k])])))}; the click ${q(P12)}: ${await ev(`(() => { const e = document.elementFromPoint(${P12.x}, ${P12.y}); const w = e && e.closest && e.closest('.win'); return w ? 'window ' + w.dataset.id : (e.className || e.tagName); })()`)}`);
  ok('right-click in the strip just above a window offers "new note here"', await noteHere(P12.x, P12.y));
  const s13 = await now(), n12 = made(s12, s13), N12 = n12.length === 1 ? at(s13, n12[0]) : null;
  const dyTop = at(s13, 'm-top').y - at(s12, 'm-top').y, dyLow = at(s13, 'm-low').y - at(s12, 'm-low').y;
  const want12 = N12 ? N12.y + N12.h + 1.8 - at(s12, 'm-top').y : null;
  console.log(`new note: ${q(box(N12))}; m-top moved ${dyTop.toFixed(2)}, m-low ${dyLow.toFixed(2)}; overlap plus gap ${want12 && want12.toFixed(2)}`);
  ok('the note has its own size, the click in it', !!N12 && near(N12.w, 34) && near(N12.h, 46) && inside(N12, P12), { at: box(N12) });
  ok('the window under it moved down only by the overlap plus the gap, less than the note\'s own size, and the one below it by the same', !!N12 && near(dyTop, want12, 0.05) && dyTop < 46 + 1.8 - 0.5 && near(dyLow, dyTop, 0.05) && near(at(s13, 'm-top').x, at(s12, 'm-top').x), { moved: dyTop, overlapPlusGap: want12, fullSizePlusGap: 47.8 });
  ok('nothing is under the note', overlaps(s13).length === 0, overlaps(s13));

  /* 10. zoom's case, zoom's own steps (~/zoom/tools/probe-new-far-layout.mjs): pinched out at the bare point nearest 30%/30%
     of the view by 10 ctrl-wheel events of 10, "new note here" at the bare point of the sheet nearest 75%/60%. That is in
     the strip under the windows, at the right edge of their column (98.4, 97.6 here). The note opens at the click and
     nothing moves; before, placeAt pulled it up into the edge of the window above and windows were pushed. */
  await goTo('zoomcase');
  const empty = (fx, fy, inSheet) => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), top = document.querySelector('.menubar').getBoundingClientRect().bottom + 8;
    const sh = document.querySelector('.ws[data-id="zoomcase"] .zshade'), sb = sh && sh.style.display !== 'none' ? sh.getBoundingClientRect() : null;
    const want = { x: v.left + v.width * ${fx}, y: top + (v.bottom - top) * ${fy} }; let best = null;
    for (let y = top; y < v.bottom - 16; y += 8) for (let x = v.left + 12; x < v.right - 12; x += 8) {
      if (${inSheet} && sb && (x < sb.left + 4 || x > sb.right - 4 || y < sb.top + 4 || y > sb.bottom - 4)) continue;
      const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) { const d = Math.hypot(x - want.x, y - want.y); if (!best || d < best.d) best = { x, y, d }; } }
    return best; })()`);
  const toSpace = (x, y) => ev(`(() => { const e = document.querySelector('.ws[data-id="zoomcase"]'), cv = e.querySelector(':scope > .canvas'), m = new DOMMatrixReadOnly(getComputedStyle(cv).transform), o = e.getBoundingClientRect(), vp = document.getElementById('viewport').getBoundingClientRect();
    return { x: (((${x} - o.left - m.m41) / m.a) / vp.width) * 100, y: (((${y} - o.top - m.m42) / m.a) / vp.height) * 100, z: m.a }; })()`);
  const zp = await empty(0.3, 0.3, false);
  await glide(zp.x, zp.y);
  const zt = Date.now();
  for (let k = 0; k < 10; k++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zp.x, y: zp.y, deltaX: 0, deltaY: 10, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (zt + k * 16) / 1000 }); }
  await sleep(3000);
  const menuAt = (x, y) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === 'zoomcase'); return __flow.nav().toSpace(ws, ${x}, ${y}); })()`);
  const z1 = await now(), idsZ = Object.keys(z1.wins), zc = await empty(0.75, 0.6, true), zs = zc && await toSpace(zc.x, zc.y), zm = zc && await menuAt(zc.x, zc.y);
  console.log(`zoom ${z1.zoom.toFixed(3)}; zoom's click ${q(zc)}, in the space ${q(zs)}; as the menu reads it (nav.toSpace) ${q(zm)}`);
  ok('far out, the menu reads zoom\'s click where it is on screen: under the windows, not inside the one above', !!zm && near(zm.x, zs.x, 0.05) && near(zm.y, zs.y, 0.05) && zm.y > at(z1, 'z-design').y + at(z1, 'z-design').h, { menu: zm, screen: zs });
  ok('far out, right-click at zoom\'s spot offers "new note here"', !!zc && await noteHere(zc.x, zc.y));
  const z2 = await now(), nz = made(z1, z2), NZ = nz.length === 1 ? at(z2, nz[0]) : null;
  console.log(`new note: ${q(box(NZ))}`);
  ok('far out, the note opens at the click, at its own size', !!NZ && !!zs && near(NZ.x, zs.x, 0.1) && near(NZ.y, zs.y, 0.1) && near(NZ.w, 34) && near(NZ.h, 46), { at: box(NZ), click: zs });
  ok('far out, nothing else moves and nothing is under it', !!NZ && moved(z1, z2, idsZ).length === 0 && overlaps(z2).length === 0, { moved: moved(z1, z2, idsZ), overlaps: overlaps(z2) });

  /* 11. far out again, real right-clicks just beside windows: each note opens at the click, or just past the window beside
     it, nothing moves and nothing is under it. Each note is closed by its red light after, and the space pinched out again
     zoom's way, since a new window brings the view back to 100% around it. */
  const closeNote = async (id) => { const l = await ev(`(() => { const e = document.querySelector('.win[data-id=${q(id)}] .lights i:nth-child(1)'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); if (l) { await glide(l.x, l.y, 4); await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: l.x, y: l.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: l.x, y: l.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }); await sleep(900); } };
  if (NZ) await closeNote(nz[0]);
  /* 8 px on screen past the window's side at the zoom the pinch reaches: past its resize band (4 px each side of every
     border), which is the window's own */
  for (const [what, wid, side, along] of [['just right of the window at the top', 'z-mck', 'right', 30], ['just right of the window under it', 'z-design', 'right', 72], ['just under the window under it', 'z-design', 'below', 70], ['just under the window on the left', 'z-week', 'below', 25]]) {
    const zp3 = await empty(0.3, 0.3, false);
    await glide(zp3.x, zp3.y);
    const zt3 = Date.now();
    for (let k = 0; k < 10; k++) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zp3.x, y: zp3.y, deltaX: 0, deltaY: 10, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (zt3 + k * 16) / 1000 });
    await sleep(3000);
    const y1 = await now(), idsY = Object.keys(y1.wins), W = at(y1, wid);
    const sx = side === 'right' ? W.x + W.w + (8 / (y1.vp.w * y1.zoom)) * 100 : along, sy = side === 'below' ? W.y + W.h + (8 / (y1.vp.h * y1.zoom)) * 100 : along;
    const sc0 = await spaceAt(sx, sy), sc = { x: Math.round(sc0.x), y: Math.round(sc0.y) };
    const there = await ev(`(() => { const e = document.elementFromPoint(${sc.x}, ${sc.y}); const w = e && e.closest && e.closest('.win'); return w ? 'window ' + w.dataset.id : (e.className || e.tagName); })()`);
    const ma = await menuAt(sc.x, sc.y);
    if (!(await noteHere(sc.x, sc.y))) { ok(`far out, ${what}: right-click offers "new note here"`, false, { there }); continue; }
    const y2 = await now(), ny = made(y1, y2), NY = ny.length === 1 ? at(y2, ny[0]) : null;
    const past = NY && idsY.some((id) => { const o = at(y2, id); return (near(NY.x, o.x + o.w + 1.2, 0.1) && near(NY.y, ma.y, 0.15)) || (near(NY.y, o.y + o.h + 1.8, 0.1) && near(NY.x, ma.x, 0.15)); });
    console.log(`far out (${y1.zoom.toFixed(3)}), ${what}: the click ${q({ x: +ma.x.toFixed(2), y: +ma.y.toFixed(2) })} on ${there}; note ${q(box(NY))}`);
    ok(`far out, ${what}: the note opens at the click, or just past the window beside it`, !!NY && ((near(NY.x, ma.x, 0.15) && near(NY.y, ma.y, 0.15)) || past), { click: ma, at: box(NY) });
    ok(`far out, ${what}: nothing moves and nothing is under it`, !!NY && moved(y1, y2, idsY).length === 0 && overlaps(y2).length === 0, { moved: moved(y1, y2, idsY), overlaps: overlaps(y2) });
    if (NY) await closeNote(ny[0]);
  }

  /* 12. browse's walk5b (lead 16:5x): right-click "new page here" at the first empty spot from the top left, in the strip
     just above the top row (zoom: (320, 60), inside the dock page's gap). On b7copy2 the space re-based by 65.8% and every window slid 601 px down on
     screen. Batch 8: open space at the hand (sized down), else a small nudge, else only what is in its way moves, each its
     own shortest way by just enough; the rest stays where it is on screen */
  await goTo('topcase');
  const t0 = await now(), idsT = Object.keys(t0.wins);
  console.log(`top case: ${q(Object.fromEntries(idsT.map((k) => [k, box(t0.wins[k])])))}`);
  /* browse's point on b7copy2, (320, 60): the strip just above the top row. Its own scan (browse-walk5.mjs:126) lands
     elsewhere once the resize grips reach 4 px past every border, so the point is taken as it was: 8 px above the dock
     page, past its grip */
  const TD = at(t0, 't-dock'), PT = { x: Math.round(TD.sx + 45), y: Math.round(TD.sy - 8) };
  const onPT = await ev(`(() => { const e = document.elementFromPoint(${PT.x}, ${PT.y}); return e ? (e.closest('.win') ? 'window' : e.className || e.tagName) : null; })()`);
  console.log(`the point in the strip above the top row: ${q(PT)} on ${onPT}`);
  ok('the point is bare desktop in the strip just above the top row', !!onPT && onPT !== 'window', onPT);
  if (PT) {
    ok('right-click there offers "new page here"', await noteHere(PT.x, PT.y, 'page'));
    await sleep(600);
    const t1 = await now(), nT = made(t0, t1), NT = nT.length === 1 ? at(t1, nT[0]) : null;
    /* moves as seen on screen, in % of the view: a space growing at its start changes every window's numbers together */
    const sh = (s, id) => ({ x: ((at(s, id).sx - s.vp.x) / s.vp.w) * 100, y: ((at(s, id).sy - s.vp.y) / s.vp.h) * 100, w: (at(s, id).sw / s.vp.w) * 100, h: (at(s, id).sh / s.vp.h) * 100 });
    const mv = idsT.map((id) => [id, sh(t1, id).x - sh(t0, id).x, sh(t1, id).y - sh(t0, id).y]).filter(([, dx, dy]) => Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1);
    console.log(`new page: ${q(NT && box(sh(t1, nT[0])))} on screen; moved on screen: ${q(mv.map(([id, dx, dy]) => [id, +dx.toFixed(2), +dy.toFixed(2)]))}`);
    /* the click is in the strip above the top margin, so the page's top sits just under it */
    ok('one new page there, over no window, under the click', !!NT && overlaps(t1).length === 0 && PT.x >= NT.sx - 1 && PT.x <= NT.sx + NT.sw + 1 && NT.sy >= PT.y - 1 && NT.sy <= PT.y + 12, { made: nT, overlaps: overlaps(t1), at: NT && [NT.sx, NT.sy, NT.sw, NT.sh] });
    /* lead 17:15: what is in its way moves right or down only, never up or left; a window the owner was looking at stays
       in view when a right or down move keeps it so: the dock page ends in view */
    ok('nothing that made way went up or left', !!NT && mv.every(([, dx, dy]) => dx > -0.1 && dy > -0.1), mv.map(([id, dx, dy]) => [id, +dx.toFixed(2), +dy.toFixed(2)]));
    const D = sh(t1, 't-dock');
    ok('the dock page ends in view, its title bar on screen', D.y >= -0.1 && D.y + 3.3 <= 100 && Math.min(D.x + D.w, 100) - Math.max(D.x, 0) >= 9.6, box(D));
    /* each that moved went right or down by just enough to clear the new page, the usual gap kept, or ran into one that moved
       and went the same way by the same amount */
    const N = NT && sh(t1, nT[0]);
    const own = (id, dx, dy) => { const q = sh(t0, id); return (Math.abs(dy) < 0.1 && Math.abs(dx - (N.x + N.w + 1.2 - q.x)) < 0.2) || (Math.abs(dx) < 0.1 && Math.abs(dy - (N.y + N.h + 1.8 - q.y)) < 0.2); };
    const lead = mv.filter(([id, dx, dy]) => own(id, dx, dy));
    const pad = (a, b2) => a.x < b2.x + b2.w + 1.2 - 0.05 && b2.x < a.x + a.w + 1.2 - 0.05 && a.y < b2.y + b2.h + 1.8 - 0.05 && b2.y < a.y + a.h + 1.8 - 0.05;
    const ranInto = (id, dx, dy, seen = new Set()) => mv.some(([m, mx, my]) => m !== id && !seen.has(m) && Math.abs(mx - dx) < 0.1 && Math.abs(my - dy) < 0.1 && pad(sh(t0, id), sh(t1, m)) && (own(m, mx, my) || ranInto(m, mx, my, new Set([...seen, id]))));
    const why = mv.map(([id, dx, dy]) => [id, +dx.toFixed(2), +dy.toFixed(2), own(id, dx, dy) ? 'just clear of the new page' : ranInto(id, dx, dy) ? 'ran into one that moved' : 'no reason']);
    ok('each that made way went just clear of the new page, or was run into by one that moved', !!N && why.every((w) => w[3] !== 'no reason'), why);
    await shot('12-top-case');
  }

  /* 13. batch 9 (lead 18:0x): a right-click "new page here" in the thin strip just above the top row, where no window
     can sit, with the lower right of the view open: the page opens there, sized to it, and nothing moves */
  await goTo('topopen');
  const u0 = await now(), idsU = Object.keys(u0.wins), D0 = at(u0, 'o-dock');
  const PU = { x: Math.round(D0.sx + D0.sw / 2), y: Math.round(D0.sy - 8) };
  console.log(`top open: ${q(Object.fromEntries(idsU.map((k) => [k, box(u0.wins[k])])))}; the click ${q(PU)} on ${await ev(`(() => { const e = document.elementFromPoint(${PU.x}, ${PU.y}); return e ? (e.closest('.win') ? 'window' : e.className || e.tagName) : null; })()`)}`);
  ok('batch 9: right-click in the strip above the top row offers "new page here"', await noteHere(PU.x, PU.y, 'page'));
  await sleep(600);
  const u1 = await now(), nU = made(u0, u1), NU = nU.length === 1 ? at(u1, nU[0]) : null;
  const shU = (s, id) => ({ x: ((at(s, id).sx - s.vp.x) / s.vp.w) * 100, y: ((at(s, id).sy - s.vp.y) / s.vp.h) * 100 });
  const mvU = idsU.filter((id) => Math.abs(shU(u1, id).x - shU(u0, id).x) > 0.1 || Math.abs(shU(u1, id).y - shU(u0, id).y) > 0.1);
  console.log(`new page: ${q(NU && box(NU))}; moved on screen: ${q(mvU)}`);
  ok('batch 9: the page opens in the open place, over no window, wholly in view, at least 300x160 px', !!NU && overlaps(u1).length === 0 && NU.sx >= u1.vp.x - 1 && NU.sx + NU.sw <= u1.vp.x + u1.vp.w + 1 && NU.sy >= u1.vp.y - 1 && NU.sy + NU.sh <= u1.vp.y + u1.vp.h + 1 && NU.sw >= 299.5 && NU.sh >= 159.5, { at: NU && [NU.sx, NU.sy, NU.sw, NU.sh], overlaps: overlaps(u1) });
  ok('batch 9: nothing moves', mvU.length === 0, mvU);
  await shot('13-top-open');

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




