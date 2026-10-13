// layout's check of where new things open, with real input over CDP in layout's own isolated app (layout-lib.mjs): a
// dock button carried to a spot (open desktop, a gap between windows, on top of a window, the right side of the view,
// back onto the dock), a plain click on it, and the same zoomed out. Batch 8, the lead's rule for a drop (16:1x): the
// open space at the hand, sized to it down to 300x160 px; else a small nudge of the new window; else only what is in its
// way moves, each its own way by just enough; in view, held by its title bar. Notes and blank pages only: no agent or
// team is made (they would start Claude Code), no host windows.
//   LAYOUT_ROOT=<app tree> node test/layout-dock.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/dock-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, mouse, shot as shotOf } from './nav-lib.mjs';
import { type } from './ui-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'dock-shots');
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

/* The lead's rule for a drop: over no window, wholly in view, the hand on its title bar (or, where the open space or the
   space's start took it, on it); what moved was in its way or ran into one that moved, each one way, no further than the
   new window's own size. */
function dropRule(label, sA, sB, N, hand) {
  ok(`${label}: over no window`, overlaps(sB).length === 0, overlaps(sB));
  ok(`${label}: wholly in view, the hand on it`, !!N && N.sx >= sB.vp.x - 1 && N.sy >= sB.vp.y - 1 && N.sx + N.sw <= sB.vp.x + sB.vp.w + 1 && N.sy + N.sh <= sB.vp.y + sB.vp.h + 1
    && hand.x >= N.sx - 1 && hand.x <= N.sx + N.sw + 1 && hand.y >= N.sy - 1 && hand.y <= N.sy + N.sh + 1, { at: N && [N.sx, N.sy, N.sw, N.sh], hand });
  /* as drawn, in % of the view (when the space grows at its start every window's numbers change together) */
  const sh = (s, id) => { const r = at(s, id); return { x: ((r.sx - s.vp.x) / s.vp.w) * 100, y: ((r.sy - s.vp.y) / s.vp.h) * 100, w: (r.sw / s.vp.w) * 100, h: (r.sh / s.vp.h) * 100 }; };
  const d = Object.keys(sA.wins).map((id) => [id, sh(sB, id).x - sh(sA, id).x, sh(sB, id).y - sh(sA, id).y]).filter(([, dx, dy]) => Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1);
  ok(`${label}: nothing that made way went up or left`, d.every(([, dx, dy]) => dx > -0.1 && dy > -0.1), d.map(([id, dx, dy]) => [id, +dx.toFixed(2), +dy.toFixed(2)]));
  /* each went just clear of the new window (the usual gap kept), or ran into one that moved and went the same way */
  const M = N && { x: ((N.sx - sB.vp.x) / sB.vp.w) * 100, y: ((N.sy - sB.vp.y) / sB.vp.h) * 100, w: (N.sw / sB.vp.w) * 100, h: (N.sh / sB.vp.h) * 100 };
  const clear = ([id, dx, dy]) => { const q = sh(sA, id); return (Math.abs(dy) < 0.1 && Math.abs(dx - (M.x + M.w + 1.2 - q.x)) < 0.2) || (Math.abs(dx) < 0.1 && Math.abs(dy - (M.y + M.h + 1.8 - q.y)) < 0.2); };
  const pad = (a, b) => a.x < b.x + b.w + 1.2 - 0.05 && b.x < a.x + a.w + 1.2 - 0.05 && a.y < b.y + b.h + 1.8 - 0.05 && b.y < a.y + a.h + 1.8 - 0.05;
  const dragged = ([id, dx, dy]) => d.some(([m, mx, my]) => m !== id && Math.abs(mx - dx) < 0.1 && Math.abs(my - dy) < 0.1 && pad(sh(sA, id), sh(sB, m)));
  ok(`${label}: each that made way went just clear of it, or was run into by one that moved`, !!N && d.every((m) => clear(m) || dragged(m)), d.map(([id, dx, dy]) => [id, +dx.toFixed(2), +dy.toFixed(2)]));
  return d;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }));
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();
  await goTo('flow');

  /* 1. open desktop: it opens under the hand, held by its title bar, and nothing else moves */
  const s0 = await now();
  console.log(`flow: ${q(Object.fromEntries(Object.entries(s0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.y.toFixed(2), +v.w.toFixed(2), +v.h.toFixed(2)]])))}`);
  const T = { x: s0.vp.x + s0.vp.w * 0.24, y: s0.vp.y + s0.vp.h * 0.1 };
  const r1 = await carry('note', T.x, T.y, outline);
  const s1 = await now(), n1 = made(s0, s1);
  ok('the dock came up under the hand', r1.button.shown);
  ok('while carried, an outline the size of the new note follows the hand, held by its title bar', !!r1.seen && near(r1.seen.x + r1.seen.w / 2, T.x, 2) && T.y >= r1.seen.y && T.y <= r1.seen.y + 30 && near(r1.seen.w, s0.vp.w * 0.34, 2), r1.seen);
  ok('let go on open desktop, one new note opens right there', n1.length === 1 && at(s1, n1[0]).type === 'note' && near(at(s1, n1[0]).sx, r1.seen.x, 2) && near(at(s1, n1[0]).sy, r1.seen.y, 2), { made: n1, at: n1[0] && [at(s1, n1[0]).sx, at(s1, n1[0]).sy], outline: r1.seen });
  ok('nothing else moves and the view stays', Object.keys(s0.wins).every((id) => near(at(s1, id).x, at(s0, id).x) && near(at(s1, id).y, at(s0, id).y)) && near(s1.pan, s0.pan, 0.5));
  ok('the outline is gone and the new note takes the keys', !(await outline()) && s1.keys === n1[0], { keys: s1.keys });
  await type(c, 'hello-carried');
  await sleep(400);
  const t1 = await ev(`(() => { const e = document.querySelector('.win[data-id=${q(n1[0])}] .ntitle'); return e && e.textContent; })()`);
  ok('real key presses after the drop go into the new note', t1 === 'hello-carried', { title: t1 });
  await shot('01-carried-to-open-desktop');

  /* 2. the gap between two windows, narrower than a note: the note at the hand, held by its title bar; only what is in its
     way makes way */
  const s2 = await now(), A = at(s2, 'w-week'), B = at(s2, 'w-design');
  const G = { x: (A.sx + A.sw + B.sx) / 2, y: (Math.max(A.sy, B.sy) + Math.min(A.sy + A.sh, B.sy + B.sh)) / 2 };
  const r2 = await carry('note', G.x, G.y, outline);
  const s3 = await now(), n2 = made(s2, s3), N2 = n2.length === 1 ? at(s3, n2[0]) : null;
  ok('over a gap, the outline showed exactly where it opened', !!N2 && !!r2.seen && near(r2.seen.x, N2.sx, 1) && near(r2.seen.y, N2.sy, 1) && near(r2.seen.w, N2.sw, 1), { outline: r2.seen, at: N2 && [N2.sx, N2.sy, N2.sw] });
  /* in the gap the note goes beside the window on its left, so the hand, in the gap, is just left of it */
  dropRule('let go in the gap', s2, s3, N2, { x: N2 ? Math.max(G.x, N2.sx) : G.x, y: G.y });
  /* owner 23:57, "dropped in a gap, room is made"; flows on batch 8: the window on the left jumped over the new one. Here
     the window left of the gap stays, the note goes beside it the usual gap away, level with it, and what is past it
     makes way to the right: the order is kept */
  const A3 = at(s3, 'w-week');
  ok('in the gap: the window on its left stays where it is', !!A3 && near(A3.sx, A.sx, 1) && near(A3.sy, A.sy, 1), { before: [A.sx, A.sy], after: A3 && [A3.sx, A3.sy] });
  /* level with it as far as the view allows: its bottom never past the view's (the view does not move to show it) */
  const lowest = s3.vp.y + s3.vp.h * (await ev('__flow.nav().bottom()')) / 100 - (N2 ? N2.sh : 0);
  ok('in the gap: the note goes beside it, the usual gap away, level with it as far as the view allows', !!N2 && near(N2.sx, A3.sx + A3.sw + s3.vp.w * 0.012, 2) && near(N2.sy, Math.min(A3.sy, lowest), 2), { note: N2 && [N2.sx, N2.sy], left: [A3.sx + A3.sw, A3.sy], lowest });
  const past = Object.keys(s2.wins).filter((id) => id !== 'w-week' && (Math.abs(at(s3, id).sx - at(s2, id).sx) > 1 || Math.abs(at(s3, id).sy - at(s2, id).sy) > 1));
  ok('in the gap: what made way went right, and nothing that was left of the gap is now right of the note', past.length > 0 && past.every((id) => at(s3, id).sx > at(s2, id).sx && near(at(s3, id).sy, at(s2, id).sy, 1)) && Object.keys(s2.wins).every((id) => at(s2, id).sx + at(s2, id).sw > G.x || at(s3, id).sx + at(s3, id).sw <= N2.sx + 1), { moved: past });
  await shot('02-carried-into-gap');

  /* 3. on top of a window, the hand on its right half (batch 9, lead 19:2x): the row keeps its order, so the note opens
     beside it on the right, level with it as far as the view allows; it stays and what is past it moves right */
  const s4 = await now(), W = at(s4, n1[0]);
  const O = { x: W.sx + W.sw * 0.75, y: W.sy + W.sh * 0.5 };
  await carry('note', O.x, O.y);
  const s5 = await now(), n3 = made(s4, s5), N3 = n3.length === 1 ? at(s5, n3[0]) : null, W5 = at(s5, n1[0]);
  ok('let go on a window: it opens at its own size, over no window, wholly in view', !!N3 && near(N3.w, 34) && near(N3.h, 46) && overlaps(s5).length === 0
    && N3.sx >= s5.vp.x - 1 && N3.sy >= s5.vp.y - 1 && N3.sx + N3.sw <= s5.vp.x + s5.vp.w + 1 && N3.sy + N3.sh <= s5.vp.y + s5.vp.h + 1, { at: N3 && [N3.sx, N3.sy, N3.w, N3.h], overlaps: overlaps(s5) });
  const low3 = s5.vp.y + s5.vp.h * (await ev('__flow.nav().bottom()')) / 100 - (N3 ? N3.sh : 0);
  ok('let go on its right half: the window stays, the note beside it on the right, the usual gap off, level with it as far as the view allows', !!N3 && near(W5.sx, W.sx, 1) && near(W5.sy, W.sy, 1)
    && near(N3.sx, W.sx + W.sw + s5.vp.w * 0.012, 2) && near(N3.sy, Math.min(W.sy, low3), 2), { note: N3 && [N3.sx, N3.sy], window: [W.sx, W.sx + W.sw, W.sy], after: [W5.sx, W5.sy], lowest: low3 });
  const m3 = Object.keys(s4.wins).filter((id) => Math.abs(at(s5, id).sx - at(s4, id).sx) > 1 || Math.abs(at(s5, id).sy - at(s4, id).sy) > 1);
  ok('let go on its right half: what made way went right, and nothing that was left of the hand is now right of the note', !!N3 && m3.every((id) => at(s5, id).sx > at(s4, id).sx && near(at(s5, id).sy, at(s4, id).sy, 1))
    && Object.keys(s4.wins).every((id) => at(s4, id).sx + at(s4, id).sw > O.x || at(s5, id).sx < N3.sx), m3.map((id) => [id, Math.round(at(s5, id).sx - at(s4, id).sx), Math.round(at(s5, id).sy - at(s4, id).sy)]));
  await shot('03-carried-onto-window');

  /* 4. the right side of the view: at the end, past the last window; the view stays and the window in use keeps the keys.
     The window in use is a shell, clicked into first; real key presses after the drop must reach it. */
  let D = at(await now(), 'w-design');
  const dv = (await now()).vp;
  if (D.sx + D.sw < dv.x + 60 || D.sx > dv.x + dv.w - 60 || D.sy + D.sh < dv.y + 60 || D.sy > dv.y + dv.h - 60) {
    /* the room made in 3 moved the shell out of view: its sidebar row brings it back, as a hand would */
    const row = await ev(`(() => { const e = document.querySelector('#sblist .tr[data-act="win|w-design"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
    if (row) { await glide(row.x, row.y); await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }); await sleep(900); }
    D = at(await now(), 'w-design');
  }
  /* into the terminal itself, not the note beside it, on the part of it in view */
  const tr = await ev(`(() => { const e = document.querySelector('.win[data-id="w-design"] .xterm'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const into = tr ? { x: Math.min(Math.max(tr.x, dv.x) + 40, dv.x + dv.w - 60), y: tr.y + tr.h * 0.6 } : { x: Math.min(D.sx + D.sw - 20, dv.x + dv.w - 60), y: D.sy + D.sh * 0.6 };
  await glide(into.x, into.y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: into.x, y: into.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: into.x, y: into.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(500);
  const s6 = await now();
  const end = Math.max(...Object.values(s6.wins).map((w) => w.x + w.w));
  const r4 = await carry('page', s6.vp.x + s6.vp.w - 10, s6.vp.y + s6.vp.h * 0.4, outline);
  const s7 = await now(), n4 = made(s6, s7), N4 = n4.length === 1 ? at(s7, n4[0]) : null;
  ok('at the right side, the outline sticks out past the edge', !!r4.seen && r4.seen.x > s6.vp.x + s6.vp.w - 40, r4.seen);
  ok('let go there: a new page past the last window', !!N4 && N4.type === 'page' && near(N4.x, end + 1.5) && near(N4.y, 6.6), { at: N4 && [N4.x, N4.y], end });
  ok('the view stays, the right glow lights', near(s7.pan, s6.pan, 0.5) && s7.glowR, { pan: [s6.pan, s7.pan], glow: s7.glowR });
  ok('the window in use stays in front with the keys', s6.keys === 'w-design' && s7.front === s6.front && s7.keys === s6.keys, { front: [s6.front, s7.front], keys: [s6.keys, s7.keys] });
  await type(c, 'echo probe-end');
  await sleep(800);
  const typed = await ev(`(() => { const t = __flow.term('w-design'); return !!t && t.getText().includes('echo probe-end'); })()`);
  ok('real key presses after the drop reach it', typed, { typed });
  ok('nothing else moves', Object.keys(s6.wins).every((id) => near(at(s7, id).x, at(s6, id).x) && near(at(s7, id).y, at(s6, id).y)));
  await shot('04-carried-to-the-end');

  /* 5. back onto the dock: nothing is made */
  const s8 = await now(), back = await dockButton('note');
  await carry('note', back.x - 60, back.y - 2);
  const s9 = await now();
  ok('carried back onto the dock, nothing is made and the keys stay', made(s8, s9).length === 0 && s9.keys === s8.keys && !!s8.keys, { made: made(s8, s9), keys: [s8.keys, s9.keys] });

  /* 6. a plain click still opens it in view, where it fits */
  const b6 = await dockButton('note');
  await glide(b6.x, b6.y, 3);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b6.x, y: b6.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b6.x, y: b6.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(700);
  const s10 = await now(), n6 = made(s9, s10), N6 = n6.length === 1 ? at(s10, n6[0]) : null;
  ok('a plain click on the dock makes one note, inside the view', !!N6 && N6.sx >= s10.vp.x - 1 && N6.sx + N6.sw <= s10.vp.x + s10.vp.w + 1, { made: n6, at: N6 && [N6.sx, N6.sw] });

  /* 7. zoomed out: it still opens under the hand */
  await goTo('voiceless');
  const z0 = await now();
  const mid = { x: z0.vp.x + z0.vp.w * 0.5, y: z0.vp.y + z0.vp.h * 0.5 };
  await glide(mid.x, mid.y);
  for (const dy of [40, 40]) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(700);
  const z1 = await now();
  const Z = { x: z1.vp.x + z1.vp.w * 0.82, y: z1.vp.y + z1.vp.h * 0.15 };
  const r7 = await carry('note', Z.x, Z.y, outline);
  const z2 = await now(), n7 = made(z1, z2), N7 = n7.length === 1 ? at(z2, n7[0]) : null;
  /* where the outline was, in the space's own % (the view may zoom back in to the new note afterwards, zoom's rule) */
  const O7 = r7.seen && { x: ((z1.pan + (r7.seen.x - z1.vp.x) / z1.zoom) / z1.vp.w) * 100, y: ((z1.panY + (r7.seen.y - z1.vp.y) / z1.zoom) / z1.vp.h) * 100 };
  ok('zoomed out, it opens where the outline showed it, at its own size', z1.zoom < 0.8 && !!N7 && !!O7 && near(N7.x, O7.x, 0.3) && near(N7.y, O7.y, 0.3) && near(N7.w, 34, 0.05) && near(r7.seen.w, z1.vp.w * 0.34 * z1.zoom, 2), { zoom: [z1.zoom, z2.zoom], at: N7 && [N7.x, N7.y, N7.w], outline: O7 });
  await shot('05-zoomed-out');

  /* 8. at the end while the end is in view (pinched out): the new window takes the keys, ready to type */
  await goTo('ef');
  const e0 = await now(), em = { x: e0.vp.x + e0.vp.w * 0.5, y: e0.vp.y + e0.vp.h * 0.5 };
  await glide(em.x, em.y);
  for (const dy of [35, 35]) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: em.x, y: em.y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(700);
  const e1 = await now();
  await carry('note', e1.vp.x + e1.vp.w - 10, e1.vp.y + e1.vp.h * 0.4);
  const e2 = await now(), n8 = made(e1, e2), N8 = n8.length === 1 ? at(e2, n8[0]) : null;
  const endE = Math.max(...Object.values(e1.wins).map((w) => w.x + w.w));
  ok('pinched out with the end in view, a note carried to the right side opens past the last window', e1.zoom < 0.7 && !!N8 && near(N8.x, endE + 1.5), { zoom: e1.zoom, at: N8 && [N8.x, N8.y], end: endE });
  ok('and, being in view, it takes the keys', !!N8 && e2.keys === n8[0], { keys: e2.keys });
  await type(c, 'end-in-view');
  await sleep(400);
  const t8 = N8 ? await ev(`(() => { const e = document.querySelector('.win[data-id=${q(n8[0])}] .ntitle'); return e && e.textContent; })()`) : null;
  ok('real key presses go into it', t8 === 'end-in-view', { title: t8 });
  await shot('06-end-in-view');

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




