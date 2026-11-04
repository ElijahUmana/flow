// ux's check of the dock (src/dock.js) and the workspace menu (src/wsbg.js) in the real app, with real input over CDP.
//   test/ux-dev.sh stop; test/ux-dev.sh start --fresh && node test/ux-cdp.mjs   (--mock: also shoot the mockup, after
//   test/ux-dev.sh start --fresh --mock)
// Restarts the app once (test/ux-dev.sh) to check that a background survives. Screenshots go to ~/flow-evidence/ux/evidence.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectTo, evaluate, size, shot, sleep, mouse, click, drag, key, type, reporter } from './ui-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = path.join(os.homedir(), 'flow-evidence', 'ux', 'evidence');   // not /tmp: it is emptied at every reboot
const W = 1500, H = 913;
const R = reporter();
fs.mkdirSync(SHOTS, { recursive: true });

const PAGE = process.env.UX_ENTRY ? new RegExp(`/${process.env.UX_ENTRY.replace(/[.]/g, '\\.')}$`) : /\/src\/index\.html$/;
let app = await connectTo(9567, PAGE);
const mock = process.argv.includes('--mock') ? await connectTo(9573, 'workspaces-mockup.html') : null;
const rect = (sel, i = 0) => evaluate(app, `(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const dock = () => evaluate(app, `(() => { const d = document.getElementById('dock'), cs = getComputedStyle(d), r = d.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + 20, r.top + r.height / 2); return { vis: cs.visibility, op: +(+cs.opacity).toFixed(2), pe: cs.pointerEvents, top: r.top, left: r.left, w: r.width, takesClicks: !!(hit && d.contains(hit)) }; })()`);
const hidden = (d) => d.vis === 'hidden' && d.op === 0 && d.pe === 'none' && !d.takesClicks;
const up = (d) => d.vis === 'visible' && d.pe === 'auto' && d.takesClicks;
const rightClick = async (x, y) => {
  await mouse(app, 'mouseMoved', x, y);
  await mouse(app, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await mouse(app, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
  await sleep(250);
};
/* ssh to the VM whose ancestors include this run's app (--flow-dev=ux) or its tmux server (-L flow-dev-ux). seen counts
   this run's processes the scan recognized: none means the scan itself is broken, not that there is no ssh. */
function sshFromMe() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(([, pid, ppid, args]) => ({ pid, ppid, args }));
  const by = new Map(rows.map((r) => [r.pid, r]));
  const mine = (r) => { for (let x = r, n = 0; x && n < 30; x = by.get(x.ppid), n++) if (/--flow-dev=ux( |$)|-L flow-dev-ux( |$)/.test(x.args)) return true; return false; };
  return { seen: rows.filter(mine).length, ssh: rows.filter((r) => /^(\S*\/)?ssh /.test(r.args) && r.args.includes('claude-agents') && mine(r)).map((r) => `${r.pid} ${r.args}`) };
}
const rest = async () => { await mouse(app, 'mouseMoved', W * 0.45, H * 0.4); await sleep(700); };
/* A pointer slows down into its target, the way a hand moves it. */
async function glide(from, to) {
  for (const f of [0.5, 0.75, 0.88, 0.95, 1]) await mouse(app, 'mouseMoved', from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f);
}
const state = () => evaluate(app, '__flow.state()');
/* Pans the board by dragging bare desktop dx, dy px, held still before letting go so it does not glide. The board stays
   where a drag leaves it (no pan limits), so a check that needs a window at a place pans it there and back. */
async function pan(dx, dy) {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 400));
  for (let i = 0; i < n; i++) if (!(await pan1(dx / n, dy / n))) return false;
  return true;
}
async function pan1(dx, dy) {
  const vp = await rect('#viewport'), dk = await rect('#dock');
  const x0 = vp.x + 60 + Math.max(0, -dx), x1 = vp.x + vp.w - 60 - Math.max(0, dx), y0 = vp.y + 60 + Math.max(0, -dy), y1 = Math.min(vp.y + vp.h, dk.y) - 60 - Math.max(0, dy);
  const p = await evaluate(app, `(() => { for (let y = ${y0}; y <= ${y1}; y += 20) for (let x = ${x0}; x <= ${x1}; x += 20) { const e = document.elementFromPoint(x, y); if (e && (e.classList.contains('canvas') || e.classList.contains('ws'))) return { x, y }; } return null; })()`);
  if (!p) return false;
  await mouse(app, 'mouseMoved', p.x, p.y);
  await mouse(app, 'mousePressed', p.x, p.y);
  for (let i = 1; i <= 12; i++) { await mouse(app, 'mouseMoved', p.x + (dx * i) / 12, p.y + (dy * i) / 12, { down: true }); await sleep(16); }
  await sleep(150);
  await mouse(app, 'mouseReleased', p.x + dx, p.y + dy);
  await sleep(600);
  return true;
}
/* The window over a point's column (x) whose bottom is lowest, in the flow workspace on screen. */
const overColumn = (x) => evaluate(app, `(() => { let best = null; for (const e of document.querySelectorAll('section.ws[data-id="flow"] .win')) { if (e.style.display === 'none') continue; const r = e.getBoundingClientRect(); if (r.width && r.left < ${x} && r.right > ${x} && (!best || r.bottom > best.b)) best = { id: e.dataset.id, t: r.top, b: r.bottom }; } return best; })()`);
const secBg = (id) => evaluate(app, `document.querySelector('section.ws[data-id="${id}"]').style.background`);
async function ready(page) {
  for (let i = 0; i < 120 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  await size(page, W, H);
}

await ready(app);
if (mock) await size(mock, W, H);
const loaded = await evaluate(app, '({ dock: !!window.FlowDock, menu: !!window.FlowWsMenu, css: [...document.styleSheets].some((s) => /wsbg\\.css$/.test(s.href || "")) })');
R.ok('index.html loads dock.js, wsbg.js and wsbg.css', loaded.dock && loaded.menu && loaded.css, loaded);
if (!loaded.dock || !loaded.menu) { R.summary(); process.exit(); }

/* ---------- the dock ---------- */
await rest();
const d0 = await dock();
R.ok('with the pointer away from it, the dock is hidden and takes no clicks', hidden(d0), d0);
await shot(app, path.join(SHOTS, 'dock-1-hidden-app.png'));
if (mock) await shot(mock, path.join(SHOTS, 'dock-1-mockup.png'));
const bx = d0.left + d0.w / 2, by = H - 8;
await mouse(app, 'mouseMoved', bx, H * 0.6);
await sleep(300);
R.ok('the pointer on the desktop above it leaves it hidden', hidden(await dock()));
/* Times in the page, from the pointer event to the dock's change, so a slow CDP round trip cannot skew them. */
const watch = () => evaluate(app, `(() => {
  const d = document.getElementById('dock');
  window.__dk = { move: 0, change: 0, hid: 0 };
  window.addEventListener('pointermove', (e) => { __dk.move = e.timeStamp; __dk.during = getComputedStyle(d).pointerEvents; }, { capture: true, once: true });
  const pe = getComputedStyle(d).pointerEvents;
  const mo = new MutationObserver(() => {
    const cs = getComputedStyle(d);
    if (!__dk.change && cs.pointerEvents !== pe) __dk.change = performance.now();
    if (!__dk.hid && cs.visibility === 'hidden') { __dk.hid = performance.now(); mo.disconnect(); }
  });
  mo.observe(d, { attributes: true, attributeFilter: ['style'] });
  return true;
})()`);
const took = () => evaluate(app, '({ ms: __dk.change ? Math.round(__dk.change - __dk.move) : null, during: __dk.during, hid: __dk.hid ? Math.round(__dk.hid - __dk.move) : null })');
await watch();
await mouse(app, 'mouseMoved', bx, by);
const dMid = await dock();
await sleep(100);
const d1 = await dock(), t1 = await took();
R.ok('its box does not move while it fades in (layouts that measure it never shift)', dMid.top === d0.top && dMid.left === d0.left, { resting: d0.top, fading: dMid.top, opacity: dMid.op });
R.ok('the pointer at the bottom middle brings it up at once (it takes clicks while that same move is handled)', up(d1) && t1.during === 'auto', t1);
await sleep(300);
const d2 = await dock();
R.ok('it rests where it always was (same top, so layouts do not change)', up(d2) && d2.op === 1 && d2.top === d0.top, { hidden: d0.top, shown: d2.top });
const agent = await rect('#dock [data-k="agent"]');
await glide({ x: bx, y: by }, { x: agent.cx, y: agent.cy });
await sleep(300);
const tip = await evaluate(app, `getComputedStyle(document.querySelector('#dock [data-k="agent"] span')).opacity`);
R.ok('it stays while the pointer is on it, and the button shows its name', up(await dock()) && +tip === 1, tip);
await shot(app, path.join(SHOTS, 'dock-2-shown-app.png'));
await watch();
await mouse(app, 'mouseMoved', bx, H * 0.5);
await sleep(900);
const d4 = await dock(), t4 = await took();
R.ok('it goes about a quarter second after the pointer leaves', hidden(d4) && t4.ms >= 240 && t4.ms < 700 && t4.hid >= 380 && t4.hid < 1000, t4);
const lay0 = await evaluate(app, `[...document.querySelectorAll('section.ws[data-id="flow"] .win')].map((w) => w.style.top + w.style.height).join()`);
await mouse(app, 'mouseMoved', bx, by);
await sleep(300);
const lay1 = await evaluate(app, `[...document.querySelectorAll('section.ws[data-id="flow"] .win')].map((w) => w.style.top + w.style.height).join()`);
R.ok('no window moves when it comes up', lay0 !== '' && lay0 === lay1, { windows: lay0 ? lay0.split(',').length : 0 });
await rest();
// dragging the desktop past it
const m0 = await rect('.win[data-id="w-mck"]');
await mouse(app, 'mouseMoved', bx - 120, H * 0.4);
await mouse(app, 'mousePressed', bx - 120, H * 0.4);
for (let i = 1; i <= 10; i++) await mouse(app, 'mouseMoved', bx - 120 + 12 * i, H * 0.4 + ((by - H * 0.4) * i) / 10, { down: true });
await sleep(250);
const d5 = await dock();
await mouse(app, 'mouseReleased', bx, by);
R.ok('dragging past it with the button held leaves it hidden', hidden(d5), d5);
await sleep(400);
// the board stays where that drag left it: back, so the windows are where the next checks expect them
{ const m1 = await rect('.win[data-id="w-mck"]'); if (m1 && Math.hypot(m1.x - m0.x, m1.y - m0.y) > 2) await pan(m0.x - m1.x, m0.y - m1.y); }
await rest();
// a real click from the hidden state, as a person does it: move there, press
const before = (await state()).ws[0].windows.length;
const nb = await rect('#dock [data-k="note"]');
await click(app, nb.cx, nb.cy);
await sleep(700);
const afterWs = (await state()).ws[0];
const head = await evaluate(app, `(() => { const a = document.activeElement; if (!a || !a.classList.contains('ntitle')) return null; return { text: a.textContent, shows: getComputedStyle(a, '::before').content }; })()`);
R.ok('moving onto ✎ and clicking makes a new note, its heading focused, empty and saying "new note" faintly (item 65)', afterWs.windows.length === before + 1 && !!head && head.text === '' && head.shows === '"new note"', { before, after: afterWs.windows.length, head });
const nw = afterWs.windows[afterWs.windows.length - 1];
const ncl = await rect(`.win[data-id="${nw.id}"] > .tb [data-l=close]`);
await click(app, ncl.cx, ncl.cy);
await rest();
// a window reaching into its area: the board panned up until the window over the bottom middle reaches past the
// screen's bottom (dropping a window there would have the never-cover rule move it off what it lands on)
const ov = await overColumn(bx);
const lift = ov ? H - 85 - ov.t : 0;
if (ov) await pan(0, lift);
await rest();
const wk = ov && (await rect(`.win[data-id="${ov.id}"]`));
await mouse(app, 'mouseMoved', bx, H - 40);
await sleep(300);
const overWin = !!ov && (await evaluate(app, `(() => { const e = document.elementFromPoint(${bx}, ${H - 40}); return !!e && !!e.closest('.win[data-id="${ov.id}"]'); })()`));
R.ok('over a window in its area it stays hidden, so it never pops over what you work in', overWin && hidden(await dock()), { window: wk, overWin });
await mouse(app, 'mouseMoved', bx, H - 5);
await sleep(300);
R.ok('the bottom strip brings it up even over that window', up(await dock()));
await shot(app, path.join(SHOTS, 'dock-3-over-window-app.png'));
await mouse(app, 'mouseMoved', bx, H - 150);
await sleep(700);
R.ok('going up into the window hides it again', hidden(await dock()));
await rest();
if (ov) await pan(0, -lift);
await rest();
// a web page right above it, where a layout puts a window (1% of the height above the dock): pages never report the pointer
const prow = await rect('.tr[data-act="tab|w-mck|0"]');
await click(app, prow.cx, prow.cy);
await sleep(900);
const pwv = await rect('.win[data-id="w-mck"] webview');
const ptb = await rect('.win[data-id="w-mck"] > .tb');
await drag(app, { x: ptb.x + 40, y: ptb.cy }, { x: ptb.x + 40 + (bx - pwv.cx), y: ptb.cy + (d0.top - H * 0.01 - (pwv.y + pwv.h)) }, { steps: 10 });
await sleep(400);
const ptb2 = await rect('.win[data-id="w-mck"] > .tb');
await click(app, ptb2.x + 40, ptb2.cy);
await rest();
const pwv2 = await rect('.win[data-id="w-mck"] webview');
const nbtn = await rect('#dock [data-k="note"]');
await mouse(app, 'mouseMoved', nbtn.cx, by);
await sleep(250);
const upNow = up(await dock());
await glide({ x: nbtn.cx, y: by }, { x: nbtn.cx, y: nbtn.cy });
await sleep(1500);
R.ok('resting on a button keeps it up (1.5 s)', upNow && up(await dock()));
for (let y = nbtn.cy - 12; y > pwv2.y + pwv2.h - 40; y -= 12) await mouse(app, 'mouseMoved', nbtn.cx, y);
const inPage = await evaluate(app, `document.elementFromPoint(${nbtn.cx}, ${pwv2.y + pwv2.h - 30}).tagName`);
await sleep(700);
R.ok('moving up out of it into a web page right above hides it', inPage === 'WEBVIEW' && hidden(await dock()), { inPage, webviewBottom: pwv2.y + pwv2.h, dockTop: d0.top });
await rest();
const ptb3 = await rect('.win[data-id="w-mck"] > .tb');
await drag(app, { x: ptb3.x + 40, y: ptb3.cy }, { x: ptb.x + 40, y: ptb.cy }, { steps: 10 });
await rest();
// out of the window through the bottom
await mouse(app, 'mouseMoved', bx, by);
await sleep(250);
await mouse(app, 'mouseMoved', bx, H + 60);
await sleep(700);
R.ok('leaving the window through the bottom hides it', hidden(await dock()));
// the sidebar hidden: the dock is centered on the wider desktop
const col = await rect('#collapse');
await click(app, col.cx, col.cy);
await sleep(900);
await rest();
const ds = await dock();
await mouse(app, 'mouseMoved', ds.left + ds.w / 2, by);
await sleep(300);
R.ok('with the sidebar hidden, the new bottom middle brings it up', up(await dock()) && ds.left < d0.left, { before: d0.left, now: ds.left });
await rest();
const ex = await rect('#expand');
await click(app, ex.cx, ex.cy);
await sleep(900);
await rest();
// a smaller window
await size(app, 1100, 700);
await sleep(600);
const dsm = await dock();
await mouse(app, 'mouseMoved', dsm.left + dsm.w / 2, 700 - 6);
await sleep(300);
R.ok('in a smaller window, its bottom middle brings it up', up(await dock()), dsm);
await size(app, W, H);
await rest();

/* Windows may sit under the dock now that layouts reach the bottom: a click aimed at one must never land on the dock. */
const nNow = () => evaluate(app, '__flow.windows().length');
const focusIn = (id) => evaluate(app, `(() => { const a = document.activeElement; const w = a && a.closest && a.closest('.win'); return w ? w.dataset.id === ${JSON.stringify(id)} : false; })()`);
const newest = async (n) => (await state()).ws[0].windows.slice(-n);
const closeWin = async (id) => { const c = await rect(`.win[data-id="${id}"] > .tb [data-l=close]`); if (c) { await click(app, c.cx, c.cy); await sleep(300); } };
await rest();
await mouse(app, 'mouseMoved', bx, by);
await sleep(250);
let nbt = await rect('#dock [data-k="note"]');
await glide({ x: bx, y: by }, { x: nbt.cx, y: nbt.cy });
await sleep(400);
let n0 = await nNow();
await click(app, nbt.cx, nbt.cy);
await sleep(500);
const pgb = await rect('#dock [data-k="page"]');
await glide({ x: nbt.cx, y: nbt.cy }, { x: pgb.cx, y: pgb.cy });
await click(app, pgb.cx, pgb.cy);
await sleep(800);
R.ok('two dock buttons in a row still both work (✎ then ↗)', (await nNow()) === n0 + 2, { made: (await nNow()) - n0 });
for (const w of await newest(2)) await closeWin(w.id);
await rest();
await mouse(app, 'mouseMoved', bx, by);
await sleep(250);
n0 = await nNow();
await mouse(app, 'mouseMoved', nbt.cx, nbt.cy);
await mouse(app, 'mousePressed', nbt.cx, nbt.cy);
await mouse(app, 'mouseReleased', nbt.cx, nbt.cy);
await sleep(500);
R.ok('one fast step of 36 px up onto ✎, then a click: the note opens (backlog\'s case)', (await nNow()) === n0 + 1, { made: (await nNow()) - n0 });
for (const w of await newest(1)) await closeWin(w.id);
await rest();
await mouse(app, 'mouseMoved', bx, by);
await sleep(250);
await mouse(app, 'mouseMoved', nbt.cx, nbt.cy);
await sleep(1500);
R.ok('resting on ✎ after that fast step keeps it up (1.5 s)', up(await dock()));
await rest();
const bare = await evaluate(app, `(() => { for (let y = ${d0.top} - 30; y > 400; y -= 10) for (let x = ${bx} - 40; x < ${d0.left} + ${d0.w}; x += 10) { const el = document.elementFromPoint(x, y); if (el && (el.classList.contains('canvas') || el.classList.contains('ws'))) return { x, y }; } return null; })()`);
await rightClick(bare.x, bare.y);
const shBtn = await evaluate(app, `(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /shell/.test(x.textContent)); if (!b) return null; const q = b.getBoundingClientRect(); return { cx: q.left + 30, cy: q.top + q.height / 2 }; })()`);
await click(app, shBtn.cx, shBtn.cy);
await sleep(1500);
const lowId = (await evaluate(app, `__flow.windows().filter((w) => w.ws === 'flow' && w.type === 'term').map((w) => w.id)`)).pop();
const lowR = await rect(`.win[data-id="${lowId}"]`);
R.ok('a shell opened low on the desktop reaches under the dock', lowR.y + lowR.h > d0.top + 20 && lowR.x < bx && lowR.x + lowR.w > bx, { shell: lowR, dockTop: d0.top });
const aim = { x: bx, y: d0.top + 14 };
await rest();
await mouse(app, 'mouseMoved', bx, by);
await sleep(250);
nbt = await rect('#dock [data-k="note"]');
await glide({ x: bx, y: by }, { x: nbt.cx, y: nbt.cy });
await sleep(400);
n0 = await nNow();
await evaluate(app, `(() => { const d = document.getElementById('dock'); window.__aside = { click: 0, off: 0 };
  d.addEventListener('click', () => { __aside.click = performance.now(); }, { capture: true, once: true });
  const mo = new MutationObserver(() => { if (__aside.click && !__aside.off && getComputedStyle(d).pointerEvents === 'none') { __aside.off = performance.now(); mo.disconnect(); } });
  mo.observe(d, { attributes: true, attributeFilter: ['style'] }); return true; })()`);
await click(app, nbt.cx, nbt.cy);
let asideMs = null;
for (let i = 0; i < 80 && asideMs === null; i++) { asideMs = await evaluate(app, '__aside.off ? Math.round(__aside.off - __aside.click) : null'); if (asideMs === null) await sleep(25); }
const n1 = await nNow();
await mouse(app, 'mouseMoved', aim.x, aim.y);
await sleep(60);
await mouse(app, 'mousePressed', aim.x, aim.y);
await mouse(app, 'mouseReleased', aim.x, aim.y);
await sleep(600);
let asideDone = false;
for (let i = 0; i < 40 && !asideDone; i++) { asideDone = hidden(await dock()); if (!asideDone) await sleep(50); }
R.ok('with a window under it, using ✎ sends the dock out of the way (it stops taking clicks once the note is open, then fades); a click 60 ms later on the shell reaches it (flows\' case)', asideMs !== null && asideDone && n1 === n0 + 1 && (await nNow()) === n1 && (await focusIn(lowId)), { asideMs, asideDone, made: n1 - n0, extra: (await nNow()) - n1 });
for (const w of (await state()).ws[0].windows.filter((w) => w.type === 'note').slice(-1)) await closeWin(w.id);
await rest();
const lowRed = await rect(`.win[data-id="${lowId}"] > .tb [data-l=close]`);
await click(app, lowRed.cx, lowRed.cy);
await rest();

/* While a window lies under part of the dock's box, the bare desktop beside it at the bottom middle leaves the dock
   down; only the bottom strip brings it up, so a click on that window right after passing by cannot land on the dock. */
await rest();
await rightClick(d0.left - 340, d0.top - 27);
const shL = await evaluate(app, `(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /shell/.test(x.textContent)); if (!b) return null; const q = b.getBoundingClientRect(); return { cx: q.left + 30, cy: q.top + q.height / 2 }; })()`);
await click(app, shL.cx, shL.cy);
await sleep(1500);
const partId = (await evaluate(app, `__flow.windows().filter((w) => w.ws === 'flow' && w.type === 'term').map((w) => w.id)`)).pop();
const partR = await rect(`.win[data-id="${partId}"]`);
const bareX = d0.left + d0.w - 30;
const besideBare = await evaluate(app, `(() => { const el = document.elementFromPoint(${bareX}, ${d0.top + 33}); return !!el && (el.classList.contains('canvas') || el.classList.contains('ws')); })()`);
R.ok('a shell covers the left part of the dock\'s box, with bare desktop to its right', partR.x + partR.w > d0.left + 30 && partR.x + partR.w < bareX - 10 && partR.y + partR.h > d0.top + 20 && besideBare, { shell: partR, bareX, besideBare });
await rest();
await mouse(app, 'mouseMoved', bareX, d0.top + 33);
await sleep(300);
R.ok('then the bare desktop at the bottom middle leaves the dock down', hidden(await dock()));
await mouse(app, 'mouseMoved', bareX, H - 4);
await sleep(300);
R.ok('the bottom strip still brings it up there', up(await dock()));
await rest();
const gapX = d0.left + 10 + 38 + 4;
n0 = await nNow();
await mouse(app, 'mouseMoved', bareX, d0.top + 33);
await mouse(app, 'mouseMoved', gapX, d0.top + 23);
await sleep(60);
await mouse(app, 'mousePressed', gapX, d0.top + 23);
await mouse(app, 'mouseReleased', gapX, d0.top + 23);
await sleep(500);
R.ok('a click on that shell 60 ms after passing the bottom middle reaches the shell', (await nNow()) === n0 && (await focusIn(partId)), { extra: (await nNow()) - n0, focus: await focusIn(partId) });
await rest();
await closeWin(partId);
await rest();

/* ---------- the workspace menu ---------- */
/* Rows only, as a Mac menu is (owner 14:33): background and where new agents start open their choices beside the menu
   when pointed at (a moment later) or clicked. */
const presets = await evaluate(app, 'FlowWsMenu.presets');
const pill = await rect('.sp', 0);
const s0 = await state();
const orig = s0.ws[0].bg;
const menuNow = () => evaluate(app, `(() => { const m = document.querySelector('.wsm:not(.sub)'); if (!m) return null; const sub = document.querySelector('.wsm.sub');
  const hint = (t) => { const r = [...m.querySelectorAll('.row')].find((x) => x.firstChild.textContent === t); const k = r && r.querySelector('.k'); return k ? k.textContent : null; };
  const box = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right }; };
  return { rows: [...m.querySelectorAll('.row')].map((r) => r.firstChild.textContent), inMenu: m.querySelectorAll('.bs button').length,
    folder: hint('folder'), runsOn: hint('new agents start on'), open: [...m.querySelectorAll('.row.open')].map((r) => r.firstChild.textContent),
    menu: box(m), sub: sub && { ...box(sub), swatches: sub.querySelectorAll('.bs button').length, on: [...sub.querySelectorAll('.bs button.on')].map((b) => b.title),
      places: [...sub.querySelectorAll('.row')].map((r) => r.textContent + (r.classList.contains('on') ? ' (marked)' : '')) } }; })()`);
const inMenu = (sel, text) => evaluate(app, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.firstChild.textContent === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.left + Math.min(30, r.width / 2), cy: r.top + r.height / 2, top: r.top, right: r.right }; })()`);
const calls = () => evaluate(app, 'window.__uxCalls ? window.__uxCalls.slice() : null');
const last = async () => JSON.stringify((await calls()).slice(-1)[0] || null);
const subNow = async (ms = 1000) => { for (let i = 0; i < ms / 50; i++) { const m = await menuNow(); if (m && m.sub) return m; await sleep(50); } return menuNow(); };
const ORDER = ['background', 'folder', 'new agents start on', 'rename', 'delete'];
await rightClick(pill.cx, pill.cy);
const pk = await menuNow();
const fold = s0.ws[0].folder.length > 30 ? `…${s0.ws[0].folder.slice(-29)}` : s0.ws[0].folder;
R.ok('right-click a workspace name at the top: rows only (background, folder, new agents start on, rename, delete), no choices open', !!pk && pk.rows.join() === ORDER.join() && pk.inMenu === 0 && !pk.sub, pk);
R.ok('it shows the folder, and that new agents start on this Mac', !!pk && pk.folder === fold && pk.runsOn === 'this Mac ›', pk);
await shot(app, path.join(SHOTS, 'menu-1-app.png'));
const bgRow = await inMenu('.wsm .row', 'background');
// the rest of the menu's checks drive its rows; without them there is nothing to drive
if (!bgRow) { R.ok('the workspace menu has its "background" row to point at', false, pk); R.summary(); process.exit(1); }
await glide({ x: bgRow.cx - 80, y: bgRow.cy }, { x: bgRow.cx, y: bgRow.cy });
const pt = await subNow();
R.ok('pointing at "background" opens its gradients beside the menu, at its height, the current one marked', !!pt && !!pt.sub && pt.sub.swatches === presets.length && pt.sub.on.join() === 'dusk' && pt.sub.left >= pt.menu.right && Math.abs(pt.sub.top - bgRow.top) <= 8 && pt.open.join() === 'background', pt);
await shot(app, path.join(SHOTS, 'menu-2-gradients-app.png'));
// a slanting path from the row to the second line of gradients crosses the folder row: they stay open
const ocean = presets.findIndex((p) => p.name === 'ocean');
let sw = await rect('.wsm.sub .bs button', ocean);
const bg0 = await secBg('flow');
const fr0 = await inMenu('.wsm .row', 'folder');
// at a hand's pace (a move every 25 ms, each stamped with its time, none waiting on the page), what is under each point
// read in the page as it gets the moves, coalesced ones included
await evaluate(app, `(() => { window.__cross = []; window.__crossT = []; window.__crossOn = (e) => { __crossT.push(performance.now()); for (const c of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) { const t = document.elementFromPoint(c.clientX, c.clientY), r = t && t.closest('.row'); __cross.push(r ? r.firstChild.textContent : t && t.closest('.wsm.sub') ? 'gradients' : 'outside'); } };
  addEventListener('pointermove', __crossOn, true); return true; })()`);
const tc = Date.now();
await Promise.all([0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1].map((f, i) => sleep(i * 25).then(() => mouse(app, 'mouseMoved', bgRow.cx + (sw.cx - bgRow.cx) * f, bgRow.cy + (sw.cy - bgRow.cy) * f, { at: tc + i * 25 }))));
await sleep(350);
const crossed = await evaluate(app, `(() => { removeEventListener('pointermove', __crossOn, true); return __cross; })()`);
// the page's own gaps between the moves it handled: over SWITCH_MS (250) the menu's timer can close them between two
// moves whatever the hand did, which only a loaded machine does
const pageGapsMs = await evaluate(app, `__crossT.slice(1).map((t, i) => Math.round(t - __crossT[i]))`);
const slant = await menuNow();
const bgHover = await secBg('flow');
R.ok('a slanting path to them over the folder row keeps them open, and pointing at a gradient shows it on the workspace', crossed.includes('folder') && !!slant && !!slant.sub && slant.open.join() === 'background' && bgHover !== bg0 && /17, 48, 70/.test(bgHover), { crossed, pageGapsMs, open: slant && slant.open, bg: bgHover.slice(0, 70) });
await shot(app, path.join(SHOTS, 'menu-3-pointing-app.png'));
const fr = await inMenu('.wsm .row', 'folder');
await mouse(app, 'mouseMoved', fr.cx, fr.cy);
await sleep(600);
const onFolder = await menuNow();
R.ok('resting on another row puts the old background back and closes the gradients', (await secBg('flow')) === bg0 && !!onFolder && !onFolder.sub && !onFolder.open.length, onFolder);
await key(app, 'Escape');
await sleep(300);
R.ok('Esc closes it, nothing saved', !(await rect('.wsm')) && (await secBg('flow')) === bg0 && (await state()).ws[0].bg === orig);
await rightClick(pill.cx, pill.cy);
let row = await inMenu('.wsm .row', 'background');
await click(app, row.cx, row.cy);
const clicked = await menuNow();
R.ok('a click on "background" opens its gradients at once', !!clicked && !!clicked.sub && clicked.sub.swatches === presets.length, clicked);
sw = await rect('.wsm.sub .bs button', ocean);
await mouse(app, 'mouseMoved', row.right - 4, row.cy);
await click(app, sw.cx, sw.cy);
await sleep(400);
const s1 = await state();
R.ok('a click on a gradient keeps it: the menu closes, the workspace shows it, its state holds it', !(await rect('.wsm')) && s1.ws[0].bg === presets[ocean].css && /17, 48, 70/.test(await secBg('flow')), s1.ws[0].bg.slice(0, 60));
await rest();
await shot(app, path.join(SHOTS, 'menu-4-ocean-app.png'));
await rightClick(pill.cx, pill.cy);
row = await inMenu('.wsm .row', 'background');
await click(app, row.cx, row.cy);
const pk2 = await menuNow();
R.ok('opened again, ocean is the one marked', !!pk2 && !!pk2.sub && pk2.sub.on.join() === 'ocean', pk2);
const amber = presets.findIndex((p) => p.name === 'amber');
sw = await rect('.wsm.sub .bs button', amber);
await mouse(app, 'mouseMoved', row.right - 4, row.cy);
await mouse(app, 'mouseMoved', sw.cx, sw.cy);
await sleep(200);
await click(app, W * 0.45, H * 0.4);
await sleep(300);
R.ok('a click elsewhere closes it and keeps ocean', !(await rect('.wsm')) && (await state()).ws[0].bg === presets[ocean].css && /17, 48, 70/.test(await secBg('flow')));
// another workspace, from its name at the top, without going there
const pill1 = await rect('.sp', 1);
await rightClick(pill1.cx, pill1.cy);
row = await inMenu('.wsm .row', 'background');
await click(app, row.cx, row.cy);
const forest = presets.findIndex((p) => p.name === 'forest');
sw = await rect('.wsm.sub .bs button', forest);
await mouse(app, 'mouseMoved', row.right - 4, row.cy);
await click(app, sw.cx, sw.cy);
await sleep(400);
const s2 = await state();
R.ok('another workspace changes without leaving this one', s2.ws[1].bg === presets[forest].css && s2.ui.at === 'flow', { at: s2.ui.at });
await click(app, pill1.cx, pill1.cy);
await sleep(900);
await rest();
R.ok('going there shows it', /27, 52, 36/.test(await secBg('mynotes')));
await shot(app, path.join(SHOTS, 'menu-5-forest-app.png'));
await click(app, pill.cx, pill.cy);
await sleep(900);
/* Where new agents start, through the real hook. Switching moves nothing that runs and starts nothing; it is switched
   back before anything new could open, and no ssh to the VM may start from this app or its tmux server at any point. */
const place = async (text) => {
  const r = await inMenu('.wsm .row', 'new agents start on');
  await click(app, r.cx, r.cy);
  await sleep(150);
  const b = await inMenu('.wsm.sub .row', text);
  await mouse(app, 'mouseMoved', r.right - 4, r.cy);
  await click(app, b.cx, b.cy);
  await sleep(300);
};
await rightClick(pill.cx, pill.cy);
let r0 = await inMenu('.wsm .row', 'new agents start on');
await click(app, r0.cx, r0.cy);
const places = await menuNow();
R.ok('"new agents start on" opens its two places beside it, this Mac marked', !!places && !!places.sub && places.sub.places.join() === 'this Mac (marked),the VM', places);
await shot(app, path.join(SHOTS, 'menu-6-places-app.png'));
await key(app, 'Escape');
await sleep(200);
await rightClick(pill.cx, pill.cy);
await place('the VM');
let sv = await state();
R.ok('"the VM" makes new agents start on the VM (ws.host)', !(await rect('.wsm')) && sv.ws[0].host === 'claude-agents', sv.ws[0].host);
await rightClick(pill.cx, pill.cy);
const onVm = await menuNow();
R.ok('its menu then says new agents start on the VM and shows its VM folder, ~ until one is typed', !!onVm && onVm.runsOn === 'the VM ›' && onVm.folder === '~', onVm);
const vmFolder = await inMenu('.wsm .row', 'folder');
await click(app, vmFolder.cx, vmFolder.cy);
await sleep(200);
const vmField = await evaluate(app, `(() => { const f = document.querySelector('.wsm .ed'); return f ? { focused: document.activeElement === f, selected: f.value.slice(f.selectionStart, f.selectionEnd) } : null; })()`);
await type(app, '~/proj');
await key(app, 'Enter');
await sleep(300);
sv = await state();
R.ok('its folder row edits the VM folder in place: ~/proj and Enter keep it (ws.hostFolder)', !!vmField && vmField.focused && vmField.selected === '~' && sv.ws[0].hostFolder === '~/proj', { vmField, hostFolder: sv.ws[0].hostFolder });
await rightClick(pill.cx, pill.cy);
await place('this Mac');
sv = await state();
await rightClick(pill.cx, pill.cy);
const backMac = await menuNow();
await key(app, 'Escape');
R.ok('"this Mac" puts it back: the Mac folder shows again, the VM folder is kept', !sv.ws[0].host && sv.ws[0].hostFolder === '~/proj' && !!backMac && backMac.runsOn === 'this Mac ›' && backMac.folder === fold, { host: sv.ws[0].host, hostFolder: sv.ws[0].hostFolder, menu: backMac });
const ssh = sshFromMe();
R.ok('no ssh to claude-agents started from this app or its tmux server', ssh.seen > 0 && !ssh.ssh.length, ssh);
/* Each row on FlowWsMenu itself, with callbacks that record what they get: the places and delete before a hook passes
   them, and the typed folder of a workspace on the VM. The real hook's folder row opens the Mac's folder picker, which
   a test cannot answer, so it is not clicked. via: the row whose choices hold the one to click. */
const direct = async (opts, sel, text, via) => {
  await evaluate(app, `(() => { window.__uxCalls = []; const rec = (n) => (...a) => __uxCalls.push([n, ...a]);
    FlowWsMenu.open(new MouseEvent('contextmenu', { clientX: ${pill.cx}, clientY: ${pill.cy} }), ${opts}); return true; })()`);
  await sleep(150);
  if (via) { const v = await inMenu('.wsm .row', via); await click(app, v.cx, v.cy); await sleep(150); await mouse(app, 'mouseMoved', v.right - 4, v.cy); }
  if (!sel) return;
  const b = await inMenu(sel, text);
  await click(app, b.cx, b.cy);
  await sleep(250);
};
const MAC = "{ folder: '~/flow', onFolder: rec('folder'), runsOn: 'mac', onRunsOn: rec('runs on'), onRename: rec('rename'), onDelete: rec('delete') }";
const VM = (f) => `{ folder: '${f}', onFolderText: rec('folder text'), runsOn: 'vm', onRunsOn: rec('runs on'), onRename: rec('rename'), onDelete: rec('delete') }`;
const ROWS = ORDER.filter((r) => r !== 'background');
await direct(MAC);
const all = await menuNow();
R.ok('all its rows, in order: folder, new agents start on (this Mac), rename, delete', !!all && all.rows.join() === ROWS.join() && all.runsOn === 'this Mac ›' && all.folder === '~/flow', all);
await key(app, 'Escape');
await direct(MAC, '.wsm .row', 'folder');
R.ok('"folder" closes the menu and asks for a folder', !(await rect('.wsm')) && (await last()) === '["folder"]', await last());
await direct(MAC, '.wsm.sub .row', 'the VM', 'new agents start on');
R.ok('"the VM" closes the menu and asks for it', !(await rect('.wsm')) && (await last()) === '["runs on","vm"]', await last());
await direct(MAC, '.wsm.sub .row', 'this Mac', 'new agents start on');
R.ok('the place it already has only closes the menu', !(await rect('.wsm')) && (await calls()).length === 0);
await direct(MAC, '.wsm .row', 'rename');
R.ok('"rename" closes the menu and asks for it', !(await rect('.wsm')) && (await last()) === '["rename"]', await last());
await direct(MAC, '.wsm .row', 'delete');
R.ok('"delete" closes the menu and asks for it', !(await rect('.wsm')) && (await last()) === '["delete"]', await last());
await direct(VM('~'));
const vm = await menuNow();
R.ok('on the VM: it says so, and shows its folder (~ until one is typed)', !!vm && vm.runsOn === 'the VM ›' && vm.folder === '~', vm);
const vf = await inMenu('.wsm .row', 'folder');
await click(app, vf.cx, vf.cy);
await sleep(200);
const field = await evaluate(app, `(() => { const f = document.querySelector('.wsm .ed'); return f ? { focused: document.activeElement === f, value: f.value, selected: f.value.slice(f.selectionStart, f.selectionEnd) } : null; })()`);
await shot(app, path.join(SHOTS, 'menu-7-vm-folder-app.png'));
await type(app, '~/proj');
await key(app, 'Enter');
await sleep(250);
R.ok('its folder row turns into a field with ~ selected; a typed path and Enter keep it', !!field && field.focused && field.selected === '~' && !(await rect('.wsm')) && (await last()) === '["folder text","~/proj"]', { field, got: await last() });
await direct(VM('~/proj'), '.wsm .row', 'folder');
await type(app, 'zz');
await key(app, 'Escape');
await sleep(250);
R.ok('Esc drops what was typed', !(await rect('.wsm')) && (await calls()).length === 0);
await direct(VM('~/proj'), '.wsm .row', 'folder');
await type(app, '~/work');
await click(app, W * 0.45, H * 0.4);
await sleep(250);
R.ok('a click elsewhere keeps what was typed, as renaming in place does', !(await rect('.wsm')) && (await last()) === '["folder text","~/work"]', await last());
await direct(VM('~/work'), '.wsm .row', 'folder');
await key(app, 'Enter');
await sleep(250);
R.ok('Enter on an unchanged folder asks for nothing', !(await rect('.wsm')) && (await calls()).length === 0);
// rename, in place on the name at the top
await rightClick(pill.cx, pill.cy);
const rn = await inMenu('.wsm .row', 'rename');
await click(app, rn.cx, rn.cy);
await sleep(250);
const ren = await evaluate(app, `(() => { const n = document.querySelector('.sp[data-i="0"] .sn'); return { editing: n.isContentEditable, focused: document.activeElement === n, sel: getSelection().toString() }; })()`);
await type(app, 'home base');
await key(app, 'Enter');
await sleep(400);
const s4 = await state();
R.ok('"rename" puts the name at the top into rename; Enter keeps the new name', ren.editing && ren.focused && ren.sel === 'flow' && s4.ws[0].name === 'home base', { ren, name: s4.ws[0].name });
// a new workspace picks up a home folder named like it (queue item 14)
if (R.ok('flow.files and FlowWsMenu.folderFor are there for a new workspace\'s folder', await evaluate(app, '!!(window.flow.files && window.FlowWsMenu && window.FlowWsMenu.folderFor)'))) {
  const want = fs.existsSync(path.join(os.homedir(), 'gmgn-parity')) ? '~/gmgn-parity' : null;
  await rest();
  const plus = await rect('#addws');
  await click(app, plus.cx, plus.cy);
  await sleep(500);
  await type(app, 'gmgn parity');
  await key(app, 'Enter');
  let got = null;
  for (let i = 0; i < 40; i++) { const sw = (await state()).ws.find((w) => w.name === 'gmgn parity'); got = sw ? sw.folder : null; if (got && got !== '~') break; await sleep(150); }
  R.ok('a new workspace named "gmgn parity" picks up ~/gmgn-parity as its folder', !!want && got === want, { got, want });
  // a name no home folder has keeps '~', and while that workspace is saved with '~' the home folder can be read again
  await rest();
  const plus2 = await rect('#addws');
  await click(app, plus2.cx, plus2.cy);
  await sleep(500);
  await type(app, 'zz no such place');
  await key(app, 'Enter');
  await sleep(1500);
  const kept = ((await state()).ws.find((w) => w.name === 'zz no such place') || {}).folder;
  const direct = await evaluate(app, `Promise.all([FlowWsMenu.folderFor('Flow'), FlowWsMenu.folderFor('no such folder anywhere 7f3')])`);
  R.ok('a name no home folder has keeps ~; folderFor finds ~/flow for "Flow" and nothing for a made-up name', kept === '~' && direct[0] === '~/flow' && direct[1] === null, { kept, direct });
  await click(app, pill.cx, pill.cy);
  await sleep(900);
}
/* An empty space keeps the dock shown, with nothing else, until it has a window; then the dock goes back to showing only
   when approached (lead, Nov 2, browse's round 2). */
{
  await rest();
  const add = await rect('#addws');
  await click(app, add.cx, add.cy);
  await sleep(500);
  await type(app, 'empty one');
  await key(app, 'Enter');
  await sleep(900);
  await rest();
  const e1 = await dock();
  R.ok('a new, empty workspace shows the dock with the pointer away from it, and it takes clicks', up(e1), e1);
  const nb = await rect('#dock button[data-k="note"]');
  await click(app, nb.cx, nb.cy);
  await sleep(700);
  await rest();
  await sleep(400);
  const e2 = await dock(), one = await evaluate(app, `(() => { const ws = __flow.state().ws[[...document.querySelectorAll('.sp')].indexOf(document.querySelector('.sp.on'))]; return ws.windows.map((w) => w.id); })()`);
  R.ok('a note made from it: with a window in the space, the dock goes when the pointer is away', one.length === 1 && hidden(e2), { windows: one, dock: e2 });
  const cl = one.length === 1 && (await rect(`.win[data-id="${one[0]}"] > .tb [data-l=close]`));
  if (cl) { await click(app, cl.cx, cl.cy); await sleep(800); }
  await rest();
  const e3 = await dock();
  R.ok('closing its one window shows the dock again', !!cl && up(e3), e3);
  await click(app, pill.cx, pill.cy);
  await sleep(1200);
  await rest();
  const e4 = await dock();
  const empty1 = await rect('.sp', (await state()).ws.findIndex((w) => w.name === 'empty one'));
  await click(app, empty1.cx, empty1.cy);
  await sleep(1200);
  await rest();
  const e5 = await dock();
  R.ok('going to a workspace with windows hides it, and coming back to the empty one shows it', hidden(e4) && up(e5), { there: e4, back: e5 });
  await click(app, pill.cx, pill.cy);
  await sleep(1200);
  await rest();
}
// both survive a restart
await sleep(600);
const file = JSON.parse(fs.readFileSync('/tmp/flow-dev-ux/flow-state.json', 'utf8'));
R.ok('saved in flow-state.json', file.ws[0].bg === presets[ocean].css && file.ws[1].bg === presets[forest].css);
const errs = app.errors.slice();
app.ws.close();
execFileSync(path.join(ROOT, 'test/ux-dev.sh'), ['stop'], { stdio: 'ignore' });
execFileSync(path.join(ROOT, 'test/ux-dev.sh'), ['start'], { stdio: 'ignore', timeout: 120000 });
app = await connectTo(9567, PAGE);
await ready(app);
const s3 = await state();
R.ok('after a restart both backgrounds and the new name are back', s3.ws[0].bg === presets[ocean].css && s3.ws[1].bg === presets[forest].css && s3.ws[0].name === 'home base' && /17, 48, 70/.test(await secBg('flow')));
/* How the dock starts, read the moment it is attached, before any pointer move: under xvfb the pointer sits over the
   window, so a dock that started shown would be hidden by its own linger before a later look. */
await app.send('Page.enable');
await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { let F; Object.defineProperty(window, 'FlowDock', { configurable: true, get: () => F, set: (v) => { F = { ...v, attach: (d) => { const r = v.attach(d); const cs = getComputedStyle(d); window.__dockAtAttach = { vis: cs.visibility, pe: cs.pointerEvents, op: cs.opacity }; return r; } }; } }); })()` });
await evaluate(app, 'window.__beforeReload = true');
await app.send('Page.reload');
// while the page reloads its old context goes away, so an evaluate can fail until the new one is there
for (let i = 0; i < 120; i++) {
  const there = await evaluate(app, '!window.__beforeReload && !!window.__flow && document.readyState === "complete"').catch((e) => (/context|navigat|Target closed/i.test(e.message) ? false : Promise.reject(e)));
  if (there) break;
  await sleep(250);
}
await ready(app);
const atAttach = await evaluate(app, 'window.__dockAtAttach || null');
R.ok('the dock starts hidden: the moment it is attached it is hidden and takes no clicks', !!atAttach && atAttach.vis === 'hidden' && atAttach.pe === 'none', atAttach);
R.ok('no console errors or exceptions', !errs.length && !app.errors.length, [...errs, ...app.errors].slice(0, 5));
const sshEnd = sshFromMe();
R.ok('still no ssh to claude-agents from this app or its tmux server at the end', sshEnd.seen > 0 && !sshEnd.ssh.length, sshEnd);
R.summary();
process.exit();




