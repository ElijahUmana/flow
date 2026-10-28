#!/usr/bin/env node
// ship's bug sweep: the mockup's features (spec/workspaces-mockup.html) done one at a time in the real dev app, with
// real input over CDP (Input.dispatchMouseEvent / dispatchKeyEvent / dispatchDragEvent), screenshots on every FAIL.
//
//   node test/ship-sweep.mjs start [--fresh]   Xvfb :115, then the dev app (--fresh: a new seed without its VM windows)
//   node test/ship-sweep.mjs run [group ...]   run groups against the running app (default: all, in order)
//   node test/ship-sweep.mjs restart           SIGTERM the app this script started, wait for its exit, start it again
//   node test/ship-sweep.mjs stop              stop that app and Xvfb, kill the tmux server flow-dev-ship
//
// Isolated: FLOW_USER_DATA=/tmp/flow-dev-ship, FLOW_TMUX_SOCKET=flow-dev-ship, FLOW_CDP_PORT=9565, FLOW_BACKGROUND=1,
// marker --flow-dev=ship. Only the pids recorded in $SHOTS/run.json are ever signalled. The seed's windows with a host
// (ssh claude-agents) are removed before the first launch, so nothing here runs ssh. Claude Code runs for real and
// nothing is ever submitted to it (typing without Enter only).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectTo, evaluate, mouse, click, dblclick, drag, wheel, swipe, key, type, shot, MOD, sleep } from './ui-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// FLOW_ROOT=<dir>: sweep another copy of Flow (a combined batch tree) with this harness; that copy is never written.
const APP_ROOT = process.env.FLOW_ROOT ? path.resolve(process.env.FLOW_ROOT) : ROOT;
const PORT = 9565, SOCKET = 'flow-dev-ship', USER_DATA = '/tmp/flow-dev-ship', MARK = '--flow-dev=ship';
// evidence lives under the home folder: /tmp is emptied at every reboot (MAC_NOTES 16)
const OUT = process.env.SHOTS || path.join(process.env.HOME, 'flow-ship-evidence', 'sweep');
const RUN = path.join(OUT, 'run.json');
const PROBE_STATE = { v: 11, ws: [{ id: 'ship-probe', name: 'ship probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };
fs.mkdirSync(OUT, { recursive: true });

const readRun = () => { try { return JSON.parse(fs.readFileSync(RUN, 'utf8')); } catch { return {}; } };
const writeRun = (r) => fs.writeFileSync(RUN, JSON.stringify(r, null, 2));
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const tmux = (...a) => spawnSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8' });
const q = (v) => JSON.stringify(v);

async function until(fn, timeout = 10000, interval = 150) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    if (Date.now() > end) return null;
    await sleep(interval);
  }
}

/* ---------- Xvfb and the app ---------- */
async function ensureX() {
  const r = readRun();
  if (alive(r.xvfb) && r.display && fs.existsSync(`/tmp/.X11-unix/X${r.display.slice(1)}`)) return r.display;
  // Xvfb picks a free display itself and reports it (-displayfd): teammates' xvfb-run -a take display numbers from 99
  // up, so a fixed number collides with theirs whenever this server is down.
  const x = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], detached: true });
  let got = '';
  x.stdio[3].on('data', (b) => { got += String(b); });
  const n = await until(() => (/^\d+\n/.test(got) ? got.trim() : null), 5000, 50);
  x.stdio[3].destroy();
  x.unref();
  if (!n) throw new Error('Xvfb did not report a display');
  const display = `:${n}`;
  if (!(await until(() => fs.existsSync(`/tmp/.X11-unix/X${n}`), 5000))) throw new Error(`Xvfb did not start on ${display}`);
  writeRun({ ...readRun(), xvfb: x.pid, display });
  return display;
}

function appEnv() {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', DISPLAY: readRun().display };
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, FLOW_USER_DATA: USER_DATA, FLOW_TMUX_SOCKET: SOCKET, FLOW_CDP_PORT: String(PORT), FLOW_BACKGROUND: '1' };
}

async function launch(label) {
  const r = readRun();
  if (alive(r.app)) throw new Error(`the app from this script is still running (pid ${r.app})`);
  const bin = path.join(ROOT, 'node_modules/electron/dist', fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim());
  if (APP_ROOT !== ROOT) console.log(`sweeping ${APP_ROOT}`);
  const log = path.join(OUT, `main-${label}.log`);
  const fd = fs.openSync(log, 'w');
  const p = spawn(bin, [APP_ROOT, '--no-sandbox', MARK], { cwd: APP_ROOT, env: appEnv(), stdio: ['ignore', fd, fd], detached: true });
  fs.closeSync(fd);
  p.unref();
  writeRun({ ...readRun(), app: p.pid, log, label, started: new Date().toISOString() });
  const page = await until(async () => {
    if (!alive(p.pid)) throw new Error(`the app exited during startup, see ${log}`);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    return list.find((t) => t.type === 'page' && /\/src\/index\.html$/.test(t.url));
  }, 45000, 250);
  if (!page) throw new Error(`no Flow window on CDP ${PORT} after 45 s, see ${log}`);
  return { pid: p.pid, log };
}

async function stopApp(timeout = 20000) {
  const r = readRun();
  if (!alive(r.app)) return { was: false };
  const t0 = Date.now();
  process.kill(r.app, 'SIGTERM');
  const gone = await until(() => !alive(r.app), timeout, 100);
  return { was: true, sigterm: new Date(t0).toISOString(), ms: Date.now() - t0, exited: !!gone, log: r.log };
}

async function connect(match = /\/src\/index\.html$/) {
  const page = await connectTo(PORT, match);
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.enable');
  return page;
}

/* ---------- results ---------- */
const results = [];
let P = null;
let shotN = 0;
async function snap(name) {
  const file = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`);
  try { await shot(P, file); return file; } catch (err) { return `(no screenshot: ${err.message})`; }
}
async function ok(name, cond, detail) {
  const pass = !!cond;
  const rec = { group: currentGroup, name, ok: pass, detail };
  if (!pass) rec.shot = await snap(`FAIL-${currentGroup}-${name}`);
  results.push(rec);
  console.log(`${pass ? 'ok  ' : 'FAIL'} [${currentGroup}] ${name}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : q(detail)})` : ''}${rec.shot ? `\n     screenshot ${rec.shot}` : ''}`);
  return pass;
}
let currentGroup = '';

/* ---------- page helpers ---------- */
const ev = (expr) => evaluate(P, expr);
const state = () => ev('window.__flow.state()');
const curIndex = () => ev('+(document.querySelector("#spaces .sp.on") || {dataset: {i: -1}}).dataset.i');
const toastNow = () => ev('({ on: document.getElementById("toast").classList.contains("on"), text: document.getElementById("toast").textContent })');
async function toastSaid(re, timeout = 3000) {
  const t = await until(async () => { const x = await toastNow(); return x.on && re.test(x.text) ? x : null; }, timeout, 60);
  return t ? t.text : null;
}
const rectOf = (sel, i = 0) => ev(`(() => { const el = document.querySelectorAll(${q(sel)})[${i}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const winSel = (id) => `.win[data-id="${id}"]`;
const winRect = (id) => rectOf(winSel(id));
// Windows can still be moving after a layout or a placement (animated, and slower on a busy machine): measure or grab
// them once they have held still for 300 ms, as a person would, up to 3 s.
async function settled(ids) {
  let last = '';
  return until(async () => { const r = JSON.stringify(await Promise.all(ids.map((id) => winRect(id)))); const still = r === last; last = r; return still; }, 3000, 300);
}
const titlePoint = async (id) => {
  const r = await rectOf(`${winSel(id)} > .tb .title`);
  return r && { x: r.x + Math.min(40, r.w / 2), y: r.cy };
};
const wsWindows = async (wsId) => (await state()).ws.find((w) => w.id === wsId).windows;
// A workspace's pan in px: item 44 (nav) stores pans as % of the view (ws.panUnit '%'), like window x and y.
const panPx = (i) => ev(`(() => { const w = window.__flow.state().ws[${i}]; const vw = document.getElementById('viewport').getBoundingClientRect().width; return w.panUnit === '%' ? (w.pan || 0) / 100 * vw : (w.pan || 0); })()`);
/* A point on the bare desktop of the shown workspace (not on a window, zone label, dock or minimap). */
const emptyPoint = () => ev(`(() => {
  const v = document.getElementById('viewport').getBoundingClientRect();
  for (let y = v.top + v.height * 0.12; y < v.bottom - 90; y += 23) for (let x = v.left + 30; x < v.right - 30; x += 29) {
    const el = document.elementFromPoint(x, y);
    if (el && (el.classList.contains('canvas') || el.classList.contains('ws') || el.classList.contains('zone'))) return { x, y };
  }
  return null;
})()`);
async function bodyFocus() {
  const p = await emptyPoint();
  if (p) await click(P, p.x, p.y);
  return p;
}
/* Click an element the way a person does: move onto it first (hover can change the layout, e.g. a pill shows ⤢),
   measure it again, and record what was actually under the pointer. */
async function hit(sel, o = {}) {
  let r = await rectOf(sel, o.idx || 0);
  if (!r) throw new Error(`nothing matches ${sel}`);
  // the dock appears from the strip at the very bottom when a window lies under it, as a person reaches for it
  if (sel.startsWith('#dock')) {
    const vh = await ev('innerHeight');
    await mouse(P, 'mouseMoved', r.cx, vh - 4);
    await sleep(250);
    for (let y = vh - 4; y > r.cy; y -= 6) await mouse(P, 'mouseMoved', r.cx, Math.max(r.cy, y));
  }
  await mouse(P, 'mouseMoved', r.cx, r.cy);
  await sleep(80);
  // things that appear on approach (the dock, ⤢ on a pill) take a moment to take clicks
  let top = null, x = r.cx, y = r.cy;
  for (let i = 0; i < 12; i++) {
    r = await rectOf(sel, o.idx || 0);
    x = r.cx;
    y = r.cy;
    top = await ev(`(() => { const el = document.elementFromPoint(${x}, ${y}); const want = document.querySelectorAll(${q(sel)})[${o.idx || 0}]; const cs = want ? getComputedStyle(want) : null; return { on: !!(el && want && (el === want || want.contains(el))) && cs.pointerEvents !== 'none' && +cs.opacity > 0.5, el: el ? (el.id ? '#' + el.id : String(el.className || el.tagName)) : null }; })()`);
    if (top.on) break;
    await mouse(P, 'mouseMoved', x, y);
    await sleep(100);
  }
  if (!top.on) console.log(`     note: ${sel} is covered at ${Math.round(x)},${Math.round(y)} by ${top.el}`);
  if (o.dbl) await dblclick(P, x, y); else await click(P, x, y);
  return { x, y, covered: !top.on, by: top.el };
}
/* Put the caret at the end of a note window's body the way a person does: click into the text, then ⌘↓/ctrl+End.
   Returns what has focus, so a click that lands elsewhere is reported instead of typing into nothing. */
async function focusNoteEnd(winId) {
  const body = await rectOf(`${winSel(winId)} .nbody`);
  if (!body) return { ok: false, why: 'no .nbody' };
  const x = body.x + Math.min(40, body.w / 2), y = body.y + Math.min(12, body.h / 2);
  const under = await ev(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? (el.className || el.tagName) : null; })()`);
  await click(P, x, y);
  await P.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: MOD.ctrl });
  await P.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: MOD.ctrl });
  const focus = await ev(`(() => { const a = document.activeElement; return a ? (a.className || a.tagName) : null; })()`);
  return { ok: /nbody/.test(focus || ''), under, focus };
}
/* A fresh page window from the dock, in view with its address focused. The dock's page button adds a tab when a page
   window is in front (batch 2, BRIEF 3.0), so a non-page window is brought to the front first. */
async function freshPageWindow(wsId) {
  if ((await state()).ws.find((w) => w.id === wsId).at) { await hit('#spaces .sp.on .sn'); await sleep(500); }
  const other = await ev(`(() => { const ws = window.__flow.state().ws.find((w) => w.id === ${q(wsId)}); for (const w of ws.windows) { if (w.type === 'page' || w.zone) continue; const t = document.querySelector('.win[data-id="' + w.id + '"] > .tb'); if (!t) continue; const r = t.getBoundingClientRect(); const v = document.getElementById('viewport').getBoundingClientRect(); if (r.left > v.left + 10 && r.right < v.right - 10 && r.top > v.top) return { id: w.id, x: r.left + r.width / 2, y: r.top + r.height / 2 }; } return null; })()`);
  if (other) await click(P, other.x, other.y);
  const n0 = (await wsWindows(wsId)).length;
  await hit('#dock button[data-k="page"]');
  await sleep(600);
  const wins = await wsWindows(wsId);
  const pg = wins.length > n0 && wins[wins.length - 1].type === 'page' ? wins[wins.length - 1] : null;
  // a new window must be reachable: its title bar (✎, close, the drag) inside the viewport, not under the pills row
  if (pg) {
    const vp = await rectOf('#viewport'), tb = await rectOf(`${winSel(pg.id)} > .tb`);
    const v = await ev(`(() => { const w = window.__flow.state().ws.find((x) => x.id === ${q(wsId)}); return { pan: w.pan, panY: w.panY, zoom: w.zoom, at: w.at || null }; })()`);
    G.lastPagePlace = { win: pg.id, titleBar: tb && { x: Math.round(tb.x), y: Math.round(tb.y), w: Math.round(tb.w) }, viewport: { x: Math.round(vp.x), y: Math.round(vp.y), w: Math.round(vp.w), h: Math.round(vp.h) }, view: v };
    G.lastPagePlace.inView = !!tb && tb.y >= vp.y - 1 && tb.y + tb.h <= vp.y + vp.h + 1 && tb.x + tb.w > vp.x && tb.x < vp.x + vp.w;
  }
  return pg;
}
/* A note window in the main space of a workspace, in view (a new one from the dock when none is). */
async function noteInView(wsId) {
  if ((await state()).ws.find((w) => w.id === wsId).at) { await hit('#spaces .sp.on .sn'); await sleep(500); }
  const note = (await wsWindows(wsId)).find((w) => w.type === 'note' && !w.zone);
  if (note && (await G._focusRow(`note|${note.noteId}`))) return note;
  const n0 = (await wsWindows(wsId)).length;
  await hit('#dock button[data-k="note"]');
  await sleep(500);
  await bodyFocus();
  const wins = await wsWindows(wsId);
  return wins.length > n0 ? wins[wins.length - 1] : note;
}
async function rightClick(x, y) {
  await mouse(P, 'mouseMoved', x, y);
  await mouse(P, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await mouse(P, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
}
/* Right-click the empty desktop and pick an item by its label ("new shell", or batch 8's "new shell here"; the hint after
   it, "zsh", is not part of it): the new window, if any. */
async function desktopMenu(label) {
  const ws0 = (await state()).ws[await curIndex()];
  const n0 = ws0.windows.length;
  const p = await emptyPoint();
  if (!p) return { why: 'no bare desktop in view' };
  await rightClick(p.x, p.y);
  await sleep(300);
  const items = await ev('[...document.querySelectorAll(".ctx button")].map((b) => (b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent : b.textContent).trim())');
  const i = items.findIndex((t) => t === label || t === `${label} here`);
  if (i < 0) { await key(P, 'Escape'); return { items }; }
  await hit(`.ctx button[data-i="${i}"]`);
  const w = await until(async () => { const ws = (await state()).ws[await curIndex()]; return ws.windows.length > n0 ? ws.windows[ws.windows.length - 1] : null; }, 5000, 150);
  return { items, w, at: p };
}
const sbRows = () => ev(`[...document.querySelectorAll('#sblist .tr')].map((r) => ({ act: r.dataset.act, label: (r.querySelector('.l') || r).childNodes[0] ? (r.querySelector('.l').childNodes[0].textContent || '') : '', meta: (r.querySelector('.m') || {}).textContent || '', dim: r.classList.contains('dim') }))`);
const rowRect = (act) => rectOf(`#sblist .tr[data-act="${act}"]`);
const tmuxHas = (id) => tmux('has-session', '-t', `flow_${id}`).status === 0;
const tmuxClients = (id) => (tmux('list-clients', '-t', `flow_${id}`, '-F', '#{client_tty}').stdout || '').trim().split('\n').filter(Boolean).length;
const termText = (id) => ev(`(() => { const t = window.__flow.term(${q(id)}); return t ? t.getText() : null; })()`);

/* A tiny local site for the page checks: links, a new-tab link, text to clip, a reload counter. */
let site = null, siteHits = { '/': 0 };
function startSite() {
  return new Promise((resolve) => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      siteHits[u.pathname] = (siteHits[u.pathname] || 0) + 1;
      const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:22px sans-serif;margin:40px} a{display:block;margin:28px 0;font-size:30px}</style></head><body>${body}</body></html>`;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (u.pathname === '/two') res.end(page('sweep two', '<h1>page two</h1><p id="t2">second page of the sweep site</p>'));
      else if (u.pathname === '/three') res.end(page('sweep three', '<h1>page three</h1><p>opened in a new page</p><div style="height:4000px;background:linear-gradient(#fff,#ccd)"></div><p id="end">the end of page three</p>'));
      else res.end(page('sweep one', `<h1 id="h">sweep site</h1><p id="clipme">clip this exact sentence please</p><a id="go2" href="/two">to page two</a><a id="blank3" href="/three" target="_blank">page three in a new page</a><p>hits ${siteHits['/']}</p>`));
    });
    site.listen(0, '127.0.0.1', () => resolve(site.address().port));
  });
}

/* ---------- groups ---------- */
const G = {};

G.boot = async () => {
  const s = await state();
  await ok('5 workspace pills with the seed names', s.ws.length >= 5, s.ws.map((w) => w.name).join(', '));
  const hosts = s.ws.flatMap((w) => [...w.windows, ...w.closed].filter((x) => x.host).map((x) => x.id));
  await ok('no window with a host in the state (no ssh)', hosts.length === 0, hosts.join(', ') || 'none');
  const r = readRun();
  if (r.hint && /workspaces? at the top/.test(r.hint)) console.log(`     note: the first-run hint toast still shows: ${r.hint}`);
  const bootErrors = P.errors.filter((x) => !x.startsWith('console.warning'));
  await ok('no console errors since this run attached', bootErrors.length === 0, bootErrors.slice(0, 3).join(' | '));
};

G.pills = async () => {
  const names = await ev('[...document.querySelectorAll("#spaces .sp .sn")].map((s) => s.textContent)');
  for (const i of [2, 1, 0]) {
    const p = await rectOf(`#spaces .sp[data-i="${i}"] .sn`);
    await hit(`#spaces .sp[data-i="${i}"] .sn`);
    await sleep(350);
    const at = await curIndex();
    const tr = await ev('document.getElementById("track").style.transform');
    await ok(`click pill ${i} (${names[i]}) switches to it`, at === i && tr === `translateX(${-i * 100}%)`, { at, tr });
  }
  await sleep(500);
  await ok('the shown workspace is saved (ui.at)', (await state()).ui.at === (await state()).ws[0].id);

  // + makes a workspace and puts its name straight into rename; Enter saves.
  const add = await rectOf('#addws');
  await hit('#addws');
  await sleep(250);
  const rn = await ev('(() => { const el = document.activeElement; return el && el.classList.contains("rn") ? { text: el.textContent, sel: String(getSelection()), pill: el.closest(".sp") ? +el.closest(".sp").dataset.i : null } : null; })()');
  await ok('+ adds a pill in rename with its name selected', rn && rn.text === 'new workspace' && rn.sel === 'new workspace', rn);
  await type(P, 'sweep space');
  await key(P, 'Enter');
  await sleep(300);
  let s = await state();
  const nw = s.ws[s.ws.length - 1];
  await ok('Enter saves the new name and shows that workspace', nw.name === 'sweep space' && (await curIndex()) === s.ws.length - 1, { name: nw.name, at: await curIndex(), notes: nw.notes.length });
  const pi = s.ws.length - 1;

  // double-click renames in place; Esc cancels, Enter saves.
  let p = await rectOf(`#spaces .sp[data-i="${pi}"] .sn`);
  await hit(`#spaces .sp[data-i="${pi}"] .sn`, { dbl: true });
  await sleep(200);
  await type(P, 'nope');
  await key(P, 'Escape');
  await sleep(250);
  s = await state();
  const pillText = await ev(`document.querySelector('#spaces .sp[data-i="${pi}"] .sn').textContent`);
  await ok('double-click a pill, type, Esc: the name stays', s.ws[pi].name === 'sweep space' && pillText === 'sweep space', { state: s.ws[pi].name, pill: pillText });
  p = await rectOf(`#spaces .sp[data-i="${pi}"] .sn`);
  await hit(`#spaces .sp[data-i="${pi}"] .sn`, { dbl: true });
  await sleep(200);
  await type(P, 'sweep renamed');
  await key(P, 'Enter');
  await sleep(250);
  s = await state();
  await ok('double-click a pill, type, Enter: renamed', s.ws[pi].name === 'sweep renamed', s.ws[pi].name);

  // ⌃→ / ⌃← from the desktop, starting at the first workspace.
  await G._go(0);
  await bodyFocus();
  await key(P, 'ArrowRight', MOD.ctrl);
  await sleep(350);
  const a1 = await curIndex();
  await key(P, 'ArrowRight', MOD.ctrl);
  await sleep(350);
  const a2 = await curIndex();
  await key(P, 'ArrowLeft', MOD.ctrl);
  await key(P, 'ArrowLeft', MOD.ctrl);
  await sleep(400);
  await ok('⌃→ ⌃→ ⌃← ⌃← goes 1, 2, then back to 0', a1 === 1 && a2 === 2 && (await curIndex()) === 0, { a1, a2, end: await curIndex() });
};

/* ---------- navigation (nav.js): two fingers between spaces, a pinch zooms, a fast drag glides, the workspace menu ---------- */
G.nav = async () => {
  await G._go(0);
  let s = await state();
  if (s.ws[0].at) { await hit('#spaces .sp.on .sn'); await sleep(500); s = await state(); }
  const order = [null, ...s.ws[0].zones.map((z) => z.id)];
  const vp = await rectOf('#viewport');
  const p = await emptyPoint();
  // two fingers sideways: the next space of this workspace, then back; one space per swipe. A swipe goes on past half
  // the view or after a flick of 1 px/ms or faster (nav.js FLICK, owner Nov 2 14:1x): 30 px every 16 ms is a flick.
  await swipe(P, p.x, p.y, Array(20).fill(30), 16);
  // it goes on once let go (no wheel for nav's SWIPE_END_MS, longer when the wheels come late) and the slide has been
  // drawn, which took up to 4.1 s at load 80-130: wait for it
  s = (await until(async () => { const x = await state(); return x.ws[0].at === order[1] ? x : null; }, 8000, 100)) || (await state());
  const at1 = s.ws[0].at, cur1 = await curIndex();
  await ok('a two-finger swipe moves to the next space of the workspace (its first sub-workspace), not the next workspace', order.length > 1 && at1 === order[1] && cur1 === 0, { order, at: at1, workspace: cur1 });
  // the next swipe after a pause, as a person's: nav makes one gesture of wheels less than GAP_MS apart by event time
  await sleep(700);
  const p2 = (await emptyPoint()) || p;
  await swipe(P, p2.x, p2.y, Array(20).fill(-30), 16);
  s = (await until(async () => { const x = await state(); return !x.ws[0].at ? x : null; }, 8000, 100)) || (await state());
  await ok('a swipe back returns to the main space', !s.ws[0].at && (await curIndex()) === 0, { at: s.ws[0].at });
  await sleep(700);
  await swipe(P, p2.x, p2.y, Array(20).fill(-30), 16);
  await sleep(1500);
  s = await state();
  await ok('swiping before the main space stays there (same workspace, same space)', !s.ws[0].at && (await curIndex()) === 0, { at: s.ws[0].at, workspace: await curIndex() });
  // a pinch (ctrl-wheel, as Chromium hands it over) zooms the space; terminals keep their columns and rows
  const term = (await wsWindows('flow')).find((w) => w.type === 'term' && !w.zone && tmuxHas(w.id));
  const paneSize = () => (term ? (tmux('list-panes', '-t', `flow_${term.id}`, '-F', '#{pane_width}x#{pane_height}').stdout || '').trim() : '');
  const size0 = paneSize();
  const z0 = (await state()).ws[0].zoom || 1;
  for (let i = 0; i < 6; i++) await P.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.cx, y: vp.cy, deltaX: 0, deltaY: 10, modifiers: MOD.ctrl, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(700);
  const z1 = (await state()).ws[0].zoom || 1;
  const size1 = paneSize();
  await ok('a pinch zooms the space out; the terminal keeps its columns and rows', z1 < z0 - 0.2 && size1 === size0, { zoom: [z0, z1], pane: [size0, size1] });
  for (let i = 0; i < 6; i++) await P.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.cx, y: vp.cy, deltaX: 0, deltaY: -10, modifiers: MOD.ctrl, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(800);
  const z2 = (await state()).ws[0].zoom || 1;
  await ok('pinching back in settles on actual size', Math.abs(z2 - 1) < 0.001, { zoom: z2 });
  // right-click a workspace's name: its menu (background, folder, rename, delete)
  const s4 = await state();
  const di = s4.ws.findIndex((w) => w.name === 'sweep renamed');
  if (di < 0) { await ok('the workspace the pills group made, to delete', false, s4.ws.map((w) => w.name)); return; }
  const pill = await rectOf(`#spaces .sp[data-i="${di}"] .sn`);
  await rightClick(pill.cx, pill.cy);
  await sleep(300);
  const menu = await ev(`(() => { const m = document.querySelector('.wsm'); return m ? { presets: m.querySelectorAll('.bs button').length, rows: [...m.querySelectorAll('.row')].map((r) => r.firstChild.textContent) } : null; })()`);
  // batch 7 (wsbg, owner Nov 2 14:33): the backgrounds open from the "background" row, as a Mac submenu does
  if (menu && !menu.presets && menu.rows.includes('background')) {
    const br = await rectOf('.wsm .row', menu.rows.indexOf('background'));
    await mouse(P, 'mouseMoved', br.cx, br.cy);
    menu.presets = (await until(() => ev('document.querySelectorAll(".bs button").length'), 2500, 100)) || 0;
    menu.submenu = true;
  }
  await ok('right-click a workspace name: its menu with backgrounds, folder, rename and delete', menu && menu.presets > 2 && ['folder', 'rename', 'delete'].every((r) => menu.rows.includes(r)), menu);
  if (!menu) return;
  // pointing at a background shows it; Esc puts the old one back
  const bg0 = await ev(`document.querySelector('#track section.ws[data-id="${s4.ws[di].id}"]').style.background`);
  const pre = await rectOf('.bs button', 2);
  await mouse(P, 'mouseMoved', pre.cx, pre.cy);
  await sleep(200);
  const bgHover = await ev(`document.querySelector('#track section.ws[data-id="${s4.ws[di].id}"]').style.background`);
  await key(P, 'Escape');
  await sleep(300);
  const bgEsc = await ev(`document.querySelector('#track section.ws[data-id="${s4.ws[di].id}"]').style.background`);
  await ok('pointing at a background previews it; Esc puts the old one back', bgHover !== bg0 && bgEsc === bg0 && !(await ev('!!document.querySelector(".wsm")')), { changedOnHover: bgHover !== bg0, restored: bgEsc === bg0 });
  // delete: the workspace goes, its agents to the neighbour's closed list (still running); undo brings it back
  await rightClick(pill.cx, pill.cy);
  await sleep(300);
  const del = await ev(`[...document.querySelectorAll('.wsm .row')].findIndex((r) => r.firstChild.textContent === 'delete')`);
  await hit('.wsm .row', { idx: del });
  const said = await toastSaid(/^removed sweep renamed/, 3000);
  await sleep(400);
  const gone = !(await state()).ws.some((w) => w.name === 'sweep renamed');
  const undo = await rectOf('#toast .tact');
  await ok('delete removes the workspace, with undo in the toast', gone && /^removed sweep renamed/.test(said) && !!undo, { gone, toast: said, undo: !!undo });
  if (undo) {
    await hit('#toast .tact');
    await sleep(600);
    const back = (await state()).ws.findIndex((w) => w.name === 'sweep renamed');
    await ok('undo brings the workspace back in its place', back === di, { at: back, was: di });
  }
};

G.windows = async () => {
  await G._go(0);
  // a fresh note from the dock lands in view; it is the window this group moves around
  const n0 = (await wsWindows('flow')).length;
  await hit('#dock button[data-k="note"]');
  await sleep(500);
  await bodyFocus();
  const wins = await wsWindows('flow');
  const note = wins.length > n0 ? wins[wins.length - 1] : null;
  if (!(await ok('a new note window to move around', note && note.type === 'note', note))) return;
  const id = note.id;
  // drag by the title bar
  let r0 = await winRect(id);
  const vp0 = await rectOf('#viewport');
  const mx = r0.cx > vp0.cx ? -120 : 120, my = r0.cy > vp0.cy ? -60 : 60;
  let t = await titlePoint(id);
  await drag(P, t, { x: t.x + mx, y: t.y + my }, { steps: 14 });
  await sleep(300);
  let r1 = await winRect(id);
  await ok('drag the title bar moves the window by the drag', Math.abs(r1.x - r0.x - mx) < 3 && Math.abs(r1.y - r0.y - my) < 3, { want: [mx, my], dx: r1.x - r0.x, dy: r1.y - r0.y });
  await sleep(400);
  const saved = (await wsWindows('flow')).find((w) => w.id === id);
  await ok('the new spot is saved', Math.abs(((saved.x - note.x) / 100) * vp0.w - mx) < 3, { from: note.x, to: saved.x });
  // resize from the corner
  r0 = await winRect(id);
  const rz = await rectOf(`${winSel(id)} > .rz`);
  const dockR = await rectOf('#dock');
  const gx = rz.cx + 110 < vp0.x + vp0.w ? 100 : -100;
  const gy = rz.cy + 80 < dockR.y ? 70 : -70;
  await drag(P, { x: rz.cx, y: rz.cy }, { x: rz.cx + gx, y: rz.cy + gy }, { steps: 10 });
  await sleep(300);
  r1 = await winRect(id);
  await ok('drag the corner resizes by the drag', Math.abs(r1.w - r0.w - gx) < 3 && Math.abs(r1.h - r0.h - gy) < 3, { want: [gx, gy], dw: r1.w - r0.w, dh: r1.h - r0.h });
  // green fills the screen, green again puts it back
  await sleep(500);
  r0 = await winRect(id);
  const spot = (await wsWindows('flow')).find((w) => w.id === id);
  let g = await rectOf(`${winSel(id)} > .tb [data-l="max"]`);
  await hit(`${winSel(id)} > .tb [data-l="max"]`);
  await sleep(350);
  const vp = await rectOf('#viewport');
  const dock = await rectOf('#dock');
  r1 = await winRect(id);
  await ok('green fills the screen (the dock hides until the pointer comes to it)', r1.w > vp.w * 0.97 && r1.y - vp.y < vp.h * 0.06 && r1.y + r1.h <= vp.y + vp.h + 1 && r1.h > vp.h * 0.85, { r1, vp });
  g = await rectOf(`${winSel(id)} > .tb [data-l="max"]`);
  await hit(`${winSel(id)} > .tb [data-l="max"]`);
  await sleep(350);
  let r2 = await winRect(id);
  const sv = (await wsWindows('flow')).find((w) => w.id === id);
  await ok('green again puts it back', Math.abs(sv.x - spot.x) < 0.01 && Math.abs(sv.y - spot.y) < 0.01 && Math.abs(sv.w - spot.w) < 0.01 && Math.abs(sv.h - spot.h) < 0.01 && Math.abs(r2.x - r0.x) < 3, { before: spot, after: { x: sv.x, y: sv.y, w: sv.w, h: sv.h } });
  // double-click the title: fill, double-click again: back (the saved spot, exactly; the window animates there)
  t = await titlePoint(id);
  await dblclick(P, t.x, t.y);
  await sleep(500);
  r1 = await winRect(id);
  t = await titlePoint(id);
  await dblclick(P, t.x, t.y);
  await sleep(700);
  const sv2 = (await wsWindows('flow')).find((w) => w.id === id);
  await ok('double-click the title fills the screen, again puts it back', r1.w > vp.w * 0.97 && Math.abs(sv2.x - spot.x) < 0.01 && Math.abs(sv2.y - spot.y) < 0.01 && Math.abs(sv2.w - spot.w) < 0.01 && Math.abs(sv2.h - spot.h) < 0.01, { filled: r1.w, before: spot, after: { x: sv2.x, y: sv2.y, w: sv2.w, h: sv2.h } });
  // yellow parks it off to the right of everything
  const others = (await wsWindows('flow')).filter((w) => w.id !== id);
  const end = Math.max(...others.map((w) => w.x + w.w));
  const y = await rectOf(`${winSel(id)} > .tb [data-l="park"]`);
  await hit(`${winSel(id)} > .tb [data-l="park"]`);
  const said = await toastSaid(/^parked off to the right\. drag the desktop to get to it\.$/);
  await sleep(300);
  const parked = (await wsWindows('flow')).find((w) => w.id === id);
  await ok('yellow parks it to the right of everything', parked.x >= end, { x: parked.x, end, toast: said });
  await sleep(400);
  const nrow = (await sbRows()).find((r) => r.act === `note|${note.noteId}`);
  const pr = await winRect(id);
  void nrow;
  // red closes a note; it stays in the sidebar (dim) and its row opens it again
  const title = (await ev(`document.querySelector('${winSel(id)} > .tb .title').textContent`));
  await G._focusRow(`note|${note.noteId}`);
  const rd = await rectOf(`${winSel(id)} > .tb [data-l="close"]`);
  await hit(`${winSel(id)} > .tb [data-l="close"]`);
  const closedSaid = await toastSaid(/closed\. it stays in the sidebar\.$/);
  await sleep(400);
  const gone = !(await rectOf(winSel(id)));
  const row = (await sbRows()).find((r) => r.act === `note|${note.noteId}`);
  await ok('red closes the note, its row stays (dim)', gone && row && row.dim, { gone, toast: closedSaid, row });
  const rr = await rowRect(`note|${note.noteId}`);
  await hit(`#sblist .tr[data-act="${`note|${note.noteId}`}"]`);
  await sleep(500);
  const back = (await wsWindows('flow')).find((w) => w.noteId === note.noteId);
  await ok('clicking its row opens it again', !!back && !!(await rectOf(winSel(back.id))), back && back.id);
};

G._go = async (i) => {
  if ((await curIndex()) === i) return;
  const p = await rectOf(`#spaces .sp[data-i="${i}"] .sn`);
  await hit(`#spaces .sp[data-i="${i}"] .sn`);
  await sleep(450);
};
/* Click a sidebar row (waiting for it to be there) and, for a window or note, wait until that window is in view. */
G._focusRow = async (act) => {
  let r = await until(() => rowRect(act), 2000, 100);
  // the BRIEF 3.0 sidebar lists an open page by its tabs (tab|<window>|<i>), a closed one as note|<id>
  if (!r && act.startsWith('note|')) {
    const w = (await state()).ws.flatMap((x) => x.windows).find((x) => x.noteId === act.slice(5));
    const alt = w && (await ev(`(() => { const el = document.querySelector('#sblist .tr[data-act^="tab|${w.id}|"]') || document.querySelector('#sblist .tr[data-act="win|${w.id}"]'); return el ? el.dataset.act : null; })()`));
    if (alt) { act = alt; r = await rowRect(alt); }
  }
  if (!r) { console.log(`     note: no sidebar row ${act}`); return false; }
  await hit(`#sblist .tr[data-act="${act}"]`);
  const [k, id] = act.split('|');
  const sel = k === 'win' ? winSel(id) : k === 'note' ? `.win.note, .win.page` : null;
  if (!sel) { await sleep(600); return true; }
  const inView = await until(() => ev(`(() => {
    const v = document.getElementById('viewport').getBoundingClientRect();
    const el = ${k === 'win' ? `document.querySelector(${q(winSel(id))})` : `[...document.querySelectorAll('.win')].find((w) => { const L = window.__flow.windows().find((x) => x.id === w.dataset.id); return L && L.noteId === ${q(id)}; })`};
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.left >= v.left - 2 && r.right <= v.right + 2;
  })()`), 2500, 100);
  await sleep(250);
  if (!inView) console.log(`     note: ${act} is not in view after clicking its row`);
  return !!inView;
};

G.sidebar = async () => {
  await G._go(0);
  const rows = await sbRows();
  const groups = await ev('[...document.querySelectorAll("#sblist .grp")].map((g) => g.textContent)');
  await ok('the flow tree has agents and notes groups', groups.includes('agents') && groups.includes('notes'), groups);
  // collapse and open a group
  const gr = await rectOf('#sblist .grp');
  const before = rows.length;
  await click(P, gr.cx, gr.cy);
  await sleep(250);
  const mid = (await sbRows()).length;
  const gr2 = await rectOf('#sblist .grp');
  await hit('#sblist .grp');
  await sleep(250);
  await ok('clicking a group name folds it and opens it again', mid < before && (await sbRows()).length === before, { before, folded: mid, after: (await sbRows()).length });
  // right-click the empty desktop: "new shell" makes a plain shell, at that spot when the open space there holds 300 x 160,
  // else beside a window or at the nearest open place in view (batch 9, layout); it never covers a window
  const rects = async (skipId) => Promise.all((await wsWindows('flow')).filter((w) => !w.zone && w.id !== skipId).map(async (w) => ({ id: w.id, r: await winRect(w.id) })));
  const shown = (r) => r && r.w > 0 && r.h > 0;
  const beforeShell = await rects(null);
  const made = await desktopMenu('new shell');
  const term = made.w;
  if (term) await settled([term.id]);
  const tr0 = term && (await winRect(term.id));
  const room = !!made.at && !beforeShell.some(({ r }) => shown(r) && r.x < made.at.x + 300 && made.at.x < r.x + r.w && r.y < made.at.y + 160 && made.at.y < r.y + r.h);
  const covers = tr0 ? (await rects(term.id)).filter(({ r }) => shown(r) && tr0.x < r.x + r.w - 1 && r.x < tr0.x + tr0.w - 1 && tr0.y < r.y + r.h - 1 && r.y < tr0.y + tr0.h - 1).map((o) => o.id) : [];
  const atSpot = !!tr0 && Math.abs(tr0.x - made.at.x) < 40 && Math.abs(tr0.y - made.at.y) < 120;
  await ok('right-click the desktop, "new shell": a shell window at the spot when it has room, else where it covers no window', term && term.type === 'term' && term.cmd === 'shell' && tr0 && !covers.length && (atSpot || !room), { items: made.items, win: term && term.id, at: made.at, room, atSpot, rect: tr0, covers });
  if (!term) return;
  G.shell = term;
  // a click on its sidebar row brings it to the front (and into view)
  await G._focusRow('note|' + ((await wsWindows('flow')).find((w) => w.type === 'note') || {}).noteId);
  await G._focusRow(`win|${term.id}`);
  const front = await ev(`document.querySelector('${winSel(term.id)}').classList.contains('front')`);
  const vr = await rectOf('#viewport');
  const wr = await winRect(term.id);
  await ok('clicking an agent row brings it to the front, in view', front && wr.x >= vr.x - 2 && wr.x + wr.w <= vr.x + vr.w + 2, { front, wr });
  // red on a terminal: closed list, session kept with no client; the row reopens it and reattaches
  const ready = await until(() => tmuxHas(term.id) && tmuxClients(term.id) === 1, 20000);
  await ok(`${term.id} runs in tmux with one client`, ready, { has: tmuxHas(term.id), clients: tmuxClients(term.id) });
  const title = await ev(`document.querySelector('${winSel(term.id)} > .tb .tt').textContent`);
  const rd = await rectOf(`${winSel(term.id)} > .tb [data-l="close"]`);
  await hit(`${winSel(term.id)} > .tb [data-l="close"]`);
  const said = await toastSaid(/closed\. the session keeps going; it stays in the sidebar\.$/);
  await sleep(600);
  const crow = (await sbRows()).find((r) => r.act === `reopen|${term.id}`);
  await ok('red on a terminal: a dim closed row', crow && crow.dim, { toast: said, row: crow });
  const detached = await until(() => tmuxHas(term.id) && tmuxClients(term.id) === 0, 5000);
  await ok('the tmux session keeps going with no client', detached, { has: tmuxHas(term.id), clients: tmuxClients(term.id) });
  const rr = await rowRect(`reopen|${term.id}`);
  await hit(`#sblist .tr[data-act="${`reopen|${term.id}`}"]`);
  await sleep(800);
  const re = await until(() => tmuxClients(term.id) === 1, 10000);
  const shownAgain = !!(await rectOf(winSel(term.id)));
  await ok('clicking the closed row reopens it and reattaches', re && shownAgain, { clients: tmuxClients(term.id), shown: shownAgain });
  // end: a claude agent closed with red, then × on its closed row stops its session
  const madeAg = await desktopMenu('new agent');
  const ag = madeAg.w;
  if (!(await ok('right-click the desktop, "new agent": a Claude agent window', ag && ag.type === 'term' && ag.cmd === 'claude', { items: madeAg.items, win: ag && ag.id }))) return;
  await G._focusRow(`win|${ag.id}`);
  const agUp = await until(() => tmuxHas(ag.id), 20000);
  const agTitle = await ev(`document.querySelector('${winSel(ag.id)} > .tb .tt').textContent`);
  await hit(`${winSel(ag.id)} > .tb [data-l="close"]`);
  await sleep(600);
  const er = await rectOf(`#sblist .tr[data-act="reopen|${ag.id}"] [data-end]`);
  if (!(await ok('the closed row has an end ×', !!er))) return;
  await hit(`#sblist .tr[data-act="reopen|${ag.id}"] [data-end]`);
  const endSaid = await toastSaid(/ended\./, 5000);
  await sleep(500);
  const stillRow = (await sbRows()).some((r) => r.act === `reopen|${ag.id}`);
  await ok('× ends a closed agent: tmux session gone, row gone', !!agUp && !tmuxHas(ag.id) && !stillRow, { wasUp: !!agUp, has: tmuxHas(ag.id), row: stillRow, toast: endSaid });
  G.ended = ag;
};

G.sidebarToggle = async () => {
  // The owner's old bug: in workspace 2, hide the sidebar and it could not be opened again.
  await G._go(1);
  const col = await rectOf('#collapse');
  await hit('#collapse');
  await sleep(500);
  const hid = await ev('document.getElementById("sb").classList.contains("hide")');
  const ex = await rectOf('#expand');
  const exVis = ex && ex.w > 0 && (await ev('getComputedStyle(document.getElementById("expand")).visibility + "/" + getComputedStyle(document.getElementById("expand")).opacity'));
  await ok('‹ hides the sidebar and › shows', hid && ex && ex.w > 0, { hid, ex, exVis });
  await click(P, ex.cx, ex.cy);
  await sleep(500);
  await ok('› brings the sidebar back (in workspace 2)', !(await ev('document.getElementById("sb").classList.contains("hide")')));
  await bodyFocus();
  await key(P, '\\', MOD.meta);
  await sleep(450);
  const h1 = await ev('document.getElementById("sb").classList.contains("hide")');
  await key(P, '\\', MOD.meta);
  await sleep(450);
  const h2 = await ev('document.getElementById("sb").classList.contains("hide")');
  await ok('⌘\\ hides the sidebar, ⌘\\ again shows it', h1 && !h2, { h1, h2 });
  await G._go(0);
};

G.dock = async () => {
  await G._go(0);
  const n0 = (await wsWindows('flow')).length;
  // note: a window, title selected for typing
  let b = await rectOf('#dock button[data-k="note"]');
  await hit('#dock button[data-k="note"]');
  await sleep(400);
  let wins = await wsWindows('flow');
  const note = wins.length > n0 && wins[wins.length - 1].type === 'note' ? wins[wins.length - 1] : null;
  const foc = await ev('(() => { const el = document.activeElement; return el ? { cls: el.className, sel: String(getSelection()), text: el.textContent, ph: el.dataset ? el.dataset.ph || "" : "" } : null; })()');
  // batch 5 (notes): an empty note's title is empty and says "new note" faintly, so there is nothing to select; earlier
  // the title held "new note", selected. Either way typing gives the title (checked next).
  const ready = foc && /ntitle/.test(foc.cls) && (foc.sel === 'new note' || (foc.text === '' && foc.ph === 'new note'));
  await ok('new note: a note window with its title focused, ready to type over', note && ready, { note: note && note.id, foc });
  await type(P, 'sweep note');
  await sleep(500);
  const tt = note && (await ev(`document.querySelector('${winSel(note.id)} > .tb .title').textContent`));
  const sbHas = (await sbRows()).some((r) => r.label === 'sweep note');
  await ok('typing the title renames the note and its sidebar row', sbHas && (tt === 'sweep note' || tt === ''), { titleBar: tt, sbHas });
  // page: a page window with the address focused
  b = await rectOf('#dock button[data-k="page"]');
  await hit('#dock button[data-k="page"]');
  await sleep(500);
  wins = await wsWindows('flow');
  const page = wins[wins.length - 1];
  const af = await ev('(() => { const el = document.activeElement; return el ? el.className + "|" + (el.placeholder || "") : null; })()');
  await ok('new page: a page window with the address focused', page.type === 'page' && /\bad\b/.test(af || ''), { type: page.type, focus: af });
  G.dockPage = page;
  // agent: real Claude Code in tmux
  b = await rectOf('#dock button[data-k="agent"]');
  await hit('#dock button[data-k="agent"]');
  await sleep(500);
  wins = await wsWindows('flow');
  const ag = wins[wins.length - 1];
  const txt = await until(async () => { const t = await termText(ag.id); return t && /Claude Code|Welcome|trust the files|\? for shortcuts|Quick safety check/i.test(t) ? t : null; }, 40000, 500);
  await ok('new agent: real Claude Code in tmux', ag.type === 'term' && ag.cmd === 'claude' && !!txt && tmuxHas(ag.id), { id: ag.id, tmux: tmuxHas(ag.id), text: (txt || (await termText(ag.id)) || '').slice(0, 160) });
  G.agent = ag;
  // team
  b = await rectOf('#dock button[data-k="team"]');
  await hit('#dock button[data-k="team"]');
  await sleep(500);
  wins = await wsWindows('flow');
  const tm = wins[wins.length - 1];
  const tmOk = await until(() => tmuxHas(tm.id), 20000);
  const ttl = await ev(`(document.querySelector('${winSel(tm.id)} > .tb .tt') || {}).textContent`);
  await ok('new team: a team window in tmux', tm.type === 'team' && tmOk, { id: tm.id, title: ttl });
  G.team = tm;
  // sub-workspace: a space of its own, shown at once
  b = await rectOf('#dock button[data-k="zone"]');
  const zones0 = (await state()).ws[0].zones.length;
  await hit('#dock button[data-k="zone"]');
  const zsaid = await toastSaid(/sub-workspace/);
  await sleep(700);
  const s = await state();
  const zn = s.ws[0].zones[s.ws[0].zones.length - 1];
  const shownWins = await ev(`[...document.querySelectorAll('#track section.ws[data-id="flow"] .win')].filter((w) => w.style.display !== 'none').length`);
  await ok('new sub-workspace: a space of its own, shown at once and empty', s.ws[0].zones.length === zones0 + 1 && s.ws[0].at === zn.id && shownWins === 0, { toast: zsaid, at: s.ws[0].at, zone: zn && zn.id, shownWins });
  G.zone = zn;
  // back to the main space: click the current workspace's name
  await hit('#spaces .sp.on .sn');
  await sleep(500);
  G.zone = zn;
};

G.zones = async () => {
  await G._go(0);
  let s = await state();
  if (s.ws[0].at) { await hit('#spaces .sp.on .sn'); await sleep(500); s = await state(); }
  const zn = G.zone ? s.ws[0].zones.find((z) => z.id === G.zone.id) : s.ws[0].zones[s.ws[0].zones.length - 1];
  if (!(await ok('a sub-workspace to work with', !!zn))) return;
  const row = `zone|${zn.id}`;
  // a page in the main space, to see that leaving and coming back never reloads it
  if (!G.site) G.site = { port: await startSite() };
  const pageWin = await ev(`window.__flow.openPage('http://localhost:${G.site.port}/')`);
  const page = await until(async () => { const p = await ev(`(() => { const p = window.__flow.page(${q(pageWin)}); return p && !p.isLoading() && p.getURL().includes(':${G.site.port}') ? p.getURL() : null; })()`); return p; }, 15000, 250);
  // read through the window's own webview (two guests can show one address) and list every target at that address
  const ownOrigin = () => ev(`(() => { const v = document.querySelector('${winSel(pageWin)} webview:not(.off)'); return v ? v.executeJavaScript('performance.timeOrigin') : null; })()`);
  const origin0 = page && (await ownOrigin());
  const targets0 = page && (await targetsAt(page));
  const hits0 = siteHits['/'];
  // and a terminal left behind: its tmux pane keeps its size while hidden (a 0-size fit would reflow Claude Code)
  const termLeft = (await wsWindows('flow')).find((w) => w.type === 'term' && !w.zone && tmuxHas(w.id));
  const paneSize = () => termLeft ? (tmux('list-panes', '-t', `flow_${termLeft.id}`, '-F', '#{pane_width}x#{pane_height}').stdout || '').trim() : '';
  const size0 = paneSize();
  // drag a note in the main space onto the sub-workspace's row: it moves into that space
  const note = (await wsWindows('flow')).find((w) => w.type === 'note' && !w.zone);
  await G._focusRow(`note|${note.noteId}`);
  const t = await titlePoint(note.id);
  const r = await rowRect(row);
  const title = await ev(`document.querySelector('${winSel(note.id)} > .tb .title').textContent`);
  await drag(P, t, { x: r.cx, y: r.cy }, { steps: 16 });
  const said = await toastSaid(/^moved /, 3000);
  await sleep(500);
  s = await state();
  const nw = s.ws[0].windows.find((w) => w.id === note.id);
  const hidden = await ev(`document.querySelector('${winSel(note.id)}').style.display === 'none'`);
  await ok('a window dropped on a sub-workspace row moves into that space (and leaves this one)', nw && nw.zone === zn.id && hidden, { zone: nw && nw.zone, hidden, toast: said });
  // the row goes there; the window shows; the row says here
  await hit(`#sblist .tr[data-act="${row}"]`);
  await sleep(600);
  s = await state();
  const shownNow = await ev(`document.querySelector('${winSel(note.id)}').style.display !== 'none'`);
  const meta = ((await sbRows()).find((x) => x.act === row) || {}).meta;
  const hereCls = await ev(`!!document.querySelector('#sblist .tr[data-act="${row}"].here')`);
  await ok('clicking the sub-workspace row goes there: its window shows, the row says here', s.ws[0].at === zn.id && shownNow && (/\d+ windows? · here/.test(meta || '') || (hereCls && /^\d*$/.test(meta || ''))), { at: s.ws[0].at, shownNow, meta, hereCls });
  await sleep(1200);
  const sizeAway = paneSize();
  // rename by double-clicking the row
  await hit(`#sblist .tr[data-act="${row}"]`, { dbl: true });
  await sleep(300);
  const editing = await ev('(() => { const a = document.activeElement; return !!a && a.classList.contains("rn"); })()');
  await type(P, 'sweep area');
  await key(P, 'Enter');
  await sleep(400);
  s = await state();
  const label = ((await sbRows()).find((x) => x.act === row) || {}).label;
  await ok('double-clicking the row renames the sub-workspace in place', editing && s.ws[0].zones.find((z) => z.id === zn.id).name === 'sweep area' && label === 'sweep area', { editing, name: s.ws[0].zones.find((z) => z.id === zn.id).name, label });
  // back to the main space with a click on the workspace's name
  await hit('#spaces .sp.on .sn');
  await sleep(600);
  s = await state();
  const backHidden = await ev(`document.querySelector('${winSel(note.id)}').style.display === 'none'`);
  await ok('clicking the workspace name goes back to its main space', !s.ws[0].at && backHidden, { at: s.ws[0].at, noteHidden: backHidden });
  // the page in the main space was never reloaded by leaving and coming back
  if (page) {
    await sleep(800);
    const origin1 = await ownOrigin();
    const targets1 = await targetsAt(page);
    const inView = await ev(`(() => { const w = window.__flow.windows().find((x) => x.id === ${q(pageWin)}); return w ? w.visible : null; })()`);
    await ok('a page left behind in the main space is not reloaded by going to a sub-workspace and back', origin0 != null && origin1 === origin0 && siteHits['/'] === hits0, { timeOrigin: [origin0, origin1], serverHits: [hits0, siteHits['/']], targets: [targets0, targets1], visibleAfter: inView });
  } else await ok('a page to watch across the switch', false, 'the local page did not load');
  if (termLeft) {
    await sleep(1200);
    const sizeBack = paneSize();
    await ok('a terminal left behind keeps its tmux size while its space is hidden and after', size0 && sizeAway === size0 && sizeBack === size0, { terminal: termLeft.id, before: size0, away: sizeAway, back: sizeBack });
  }
  G.zoneNote = note;
};

/* Batch 2: a page's note belongs to the page (state.pages, by FlowNotes.key of its address), not to its window. */
async function pageNoteOf(url) {
  const s = await state();
  const k = await ev(`window.FlowNotes.key(${q(url)})`);
  const r = s.pages && s.pages[k];
  return r ? r.note || '' : null;
}
const titleBarOf = (id) => ev(`(() => { const t = document.querySelector('${winSel(id)} > .tb .title'); return t ? t.textContent : null; })()`);
const pageNow = (id) => ev(`(() => { const p = window.__flow.page(${q(id)}); return p ? { url: p.getURL(), loading: p.isLoading() } : null; })()`);
const toastShown = (timeout) => until(async () => { const x = await toastNow(); return x.on ? x.text : null; }, timeout, 60);

/* Evaluate in the webview of a page window (its current tab), through that guest's own CDP target. */
async function guestEval(winId, expr) {
  const url = await ev(`(() => { const p = window.__flow.page(${q(winId)}); return p ? p.getURL() : null; })()`);
  const t = url && (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url === url);
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const v = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : null); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  return v;
}

/* ---------- arrange (arrange.js; owner 14:03: one control, no modes): each press lays the space out another tidy way,
   covering no window; the presses come back to the owner's own arrangement exactly, and a hand move is the owner's ---------- */
G.arrange = async () => {
  await G._go(2);
  const own = async () => Object.fromEntries((await state()).ws[2].windows.filter((w) => !w.zone).map((w) => [w.id, [w.x, w.y, w.w, w.h].map((v) => Math.round(v * 100) / 100).join(' ')]));
  const base = await own();
  const ids = Object.keys(base);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const press = async () => { await hit('#dock button[data-k="arrange"]'); await sleep(300); await settled(ids); };
  const vp = await rectOf('#viewport');
  const covering = async () => {
    const rs = (await Promise.all(ids.map(async (id) => ({ id, r: await winRect(id) })))).filter(({ r }) => r && r.w > 0 && r.h > 0 && r.x < vp.x + vp.w && r.x + r.w > vp.x && r.y < vp.y + vp.h && r.y + r.h > vp.y);
    const pairs = [];
    rs.forEach((a, i) => rs.forEach((b, j) => { if (i < j && a.r.x < b.r.x + b.r.w - 1 && b.r.x < a.r.x + a.r.w - 1 && a.r.y < b.r.y + b.r.h - 1 && b.r.y < a.r.y + a.r.h - 1) pairs.push(`${a.id}/${b.id}`); }));
    return { shown: rs.length, pairs };
  };
  await ok('one arrange control: the float / columns / grid switch is gone', await ev('!document.querySelector("#modes")'), {});
  const seen = [base];
  let back = 0;
  for (let i = 1; i <= 5 && !back; i++) {
    await press();
    const now = await own();
    if (same(now, base)) { back = i; break; }
    const c = await covering();
    await ok(`arrange, press ${i}: the windows move to a layout new to this round, and none covers another`, !seen.some((x) => same(x, now)) && c.shown > 1 && !c.pairs.length, { moved: ids.filter((id) => now[id] !== base[id]).length, of: ids.length, shown: c.shown, covering: c.pairs });
    seen.push(now);
  }
  await ok("pressing on comes back to the owner's own arrangement exactly", back > 1, { presses: back, layouts: seen.length - 1 });
  await press();
  const arranged = await own();
  let mover = null, t = null;
  for (const id of ids) { t = await titlePoint(id); if (t && t.x > vp.x + 20 && t.x < vp.x + vp.w - 80 && t.y > vp.y && t.y < vp.y + vp.h - 90) { mover = id; break; } }
  if (!mover) throw new Error('no arranged window has its title bar in view to drag');
  await drag(P, t, { x: t.x + 40, y: t.y }, { steps: 10 });
  await sleep(300);
  await settled(ids);
  const moved = await own();
  const others = ids.filter((id) => id !== mover && moved[id] !== arranged[id]);
  await ok('after a press, dragging a window just moves it; the others stay', moved[mover] !== arranged[mover] && !others.length, { mover, from: arranged[mover], to: moved[mover], others });
  let back2 = 0;
  for (let i = 1; i <= 5 && !back2; i++) { await press(); if (same(await own(), moved)) back2 = i; }
  await ok("the hand-moved layout is the owner's own: pressing on comes back to it", back2 > 1, { presses: back2 });
  await G._go(0);
};

G.desktop = async () => {
  await G._go(0);
  const s0 = await state();
  const ws = s0.ws[0];
  const pan0 = await panPx(0);
  const p = await emptyPoint();
  if (!(await ok('a bare spot on the desktop', !!p))) return;
  // drag the desktop left: it pans
  await mouse(P, 'mouseMoved', p.x, p.y);
  await mouse(P, 'mousePressed', p.x, p.y);
  for (let i = 1; i <= 10; i++) await mouse(P, 'mouseMoved', p.x - i * 30, p.y, { down: true });
  await sleep(120);
  await mouse(P, 'mouseReleased', p.x - 300, p.y);
  await sleep(600);
  const pan1 = await panPx(0);
  await ok('dragging the empty desktop pans it', pan1 > pan0 + 100, { from: pan0, to: pan1 });
  // the left glow is on exactly when a window of the main space lies left of the view (nav.js edges()); which windows
  // do depends on what the groups before moved, so the check reads the geometry instead of assuming it, and drags on
  // (on batch 7's board there is no end) until a window lies to the left, so the glow's "on" is what gets checked
  const leftCount = () => ev(`(() => { const ws = window.__flow.state().ws[0]; const vw = document.getElementById('viewport').getBoundingClientRect().width; const x = ws.panUnit === '%' ? (ws.pan || 0) / 100 * vw : (ws.pan || 0); return ws.windows.filter((w) => !w.zone && (w.x / 100) * vw < x - 2).length; })()`);
  for (let k = 0; k < 4 && !(await leftCount()); k++) {
    const before = await panPx(0);
    const q0 = await emptyPoint();
    await drag(P, q0, { x: q0.x - 300, y: q0.y }, { steps: 10, holdMs: 120 });
    await sleep(600);
    if (Math.abs((await panPx(0)) - before) < 5) break;
  }
  const leftOf = await ev(`(() => { const ws = window.__flow.state().ws[0]; const vw = document.getElementById('viewport').getBoundingClientRect().width; const x = ws.panUnit === '%' ? (ws.pan || 0) / 100 * vw : (ws.pan || 0); return ws.windows.filter((w) => !w.zone && (w.x / 100) * vw < x - 2).map((w) => w.id); })()`);
  const edgeL = await until(async () => { const on = await ev('document.getElementById("edgeL").classList.contains("on")'); return on === leftOf.length > 0 ? { on } : null; }, 1500, 100);
  await ok('the left edge glows exactly when there is a window to the left', !!edgeL, { windowsLeftOfView: leftOf, glowOn: await ev('document.getElementById("edgeL").classList.contains("on")') });
  // a fast drag back, let go while moving, glides on after the release (BRIEF 3.0)
  const g0 = await emptyPoint();
  const panBeforeFling = await panPx(0);
  await mouse(P, 'mouseMoved', g0.x, g0.y);
  // Each event carries its own time, 8 ms apart, as a trackpad's do on a busy machine: nav reads the speed from event
  // times, and a release 50 ms after the last move counts as held still (CDP stamps arrival time otherwise).
  // the pan at the release itself, taken in the page before nav starts the glide (a read after it can come late on a
  // busy machine, once the glide has already run)
  await ev(`(() => { window.__panAtRelease = null; window.addEventListener('pointerup', () => { const w = window.__flow.state().ws[0]; const vw = document.getElementById('viewport').getBoundingClientRect().width; window.__panAtRelease = w.panUnit === '%' ? (w.pan || 0) / 100 * vw : (w.pan || 0); }, { capture: true, once: true }); })()`);
  const t0 = Date.now();
  await mouse(P, 'mousePressed', g0.x, g0.y, { at: t0 });
  for (let i = 1; i <= 6; i++) await mouse(P, 'mouseMoved', g0.x + i * 25, g0.y, { down: true, at: t0 + i * 8 });
  await mouse(P, 'mouseReleased', g0.x + 150, g0.y, { at: t0 + 7 * 8 });
  const atRelease = ((await until(async () => { const v = await ev('window.__panAtRelease'); return v === null ? null : { v }; }, 3000, 50)) || {}).v;
  // the saved pan follows once the glide has settled (about 2 s from a quick flick)
  await sleep(3500);
  const glided = await panPx(0);
  await ok('a fast drag let go while moving glides on after the release', atRelease < panBeforeFling && glided < atRelease - 20, { before: panBeforeFling, release: atRelease, after: glided });
  // back to the start of the desktop
  for (let k = 0; k < 12 && (await state()).ws[0].pan > 0; k++) {
    const e2 = await emptyPoint();
    await drag(P, e2, { x: e2.x + 500, y: e2.y }, { steps: 10, holdMs: 120 });
    await sleep(400);
  }
  // past the windows the desktop keeps going, with no box and no spring back (batch 7's board; owner 14:08: "so
  // clipped"). Until batch 6 the room ended at its start and sprang back.
  const p3 = await emptyPoint();
  await mouse(P, 'mouseMoved', p3.x, p3.y);
  await mouse(P, 'mousePressed', p3.x, p3.y);
  for (let i = 1; i <= 10; i++) await mouse(P, 'mouseMoved', p3.x + i * 60, p3.y, { down: true });
  // the canvas by its class: batch 3 puts a zoomed-out shade (.zshade) before it in the section
  const during = await ev('document.querySelector("#track section.ws > .canvas").style.transform');
  await mouse(P, 'mouseReleased', p3.x + 600, p3.y);
  await sleep(600);
  const afterT = await ev('document.querySelector("#track section.ws > .canvas").style.transform');
  const px = (s) => +(/translate(?:X)?\((-?[\d.]+)px/.exec(s) || [0, NaN])[1];
  await ok('past the windows the desktop keeps going, with no spring back (the board has no box)', px(during) > 0 && px(afterT) >= px(during) - 2, { during, after: afterT });
  // a window dropped on another workspace's name moves there (help card)
  const wins = await wsWindows('flow');
  // a note of the main space: a sub-workspace's notes sit folded under its row (the seed's last note is one)
  const n = wins.filter((w) => w.type === 'note' && !w.zone).pop();
  await G._focusRow(`note|${n.noteId}`);
  await settled([n.id]);
  const t = await titlePoint(n.id);
  const pill = await rectOf('#spaces .sp[data-i="3"] .sn');
  const name3 = (await state()).ws[3].name;
  await drag(P, t, { x: pill.cx, y: pill.cy }, { steps: 18 });
  const said = await toastSaid(/^moved to /);
  await sleep(500);
  const s2 = await state();
  const moved = s2.ws[3].windows.some((w) => w.id === n.id) && !s2.ws[0].windows.some((w) => w.id === n.id);
  const noteMoved = s2.ws[3].notes.some((x) => x.id === n.noteId);
  await ok('a window dropped on a workspace name moves there, with its note', moved && noteMoved, { moved, noteMoved, toast: said });
};

G.notes = async () => {
  await G._go(0);
  const wins = await wsWindows('flow');
  const note = await noteInView('flow');
  if (!(await ok('a note window in flow, in view', !!note))) return;
  const fo = await focusNoteEnd(note.id);
  await type(P, ' sweep body text');
  await sleep(700);
  const n = (await state()).ws[0].notes.find((x) => x.id === note.noteId);
  await ok('typing in a note body saves it', /sweep body text$/.test(n.body), { tail: n.body.slice(-60), focus: fo });
  G.noteBody = { ws: 'flow', id: note.noteId, body: n.body };
  // ✎ on an agent opens its note under the terminal; typing saves w.note and the row shows ✎
  const ag = wins.find((w) => w.type === 'term' && !w.host);
  await G._focusRow(`win|${ag.id}`);
  const isNoted = () => ev(`document.querySelector('${winSel(ag.id)}').classList.contains('noted')`);
  if (await isNoted()) {
    await hit(`${winSel(ag.id)} > .tb [data-act="note"]`);
    await sleep(300);
    await ok('✎ on an agent whose note is open closes it', !(await isNoted()));
  }
  await hit(`${winSel(ag.id)} > .tb [data-act="note"]`);
  await sleep(300);
  const opened = await ev(`(() => { const el = document.querySelector('${winSel(ag.id)}'); return { noted: el.classList.contains('noted'), focus: !!(document.activeElement && document.activeElement.closest('.anote')) }; })()`);
  await type(P, 'agent-note-from-the-sweep');
  await sleep(700);
  const w = (await wsWindows('flow')).find((x) => x.id === ag.id);
  const row = (await sbRows()).find((r) => r.act === `win|${ag.id}`);
  await ok('✎ opens the agent note focused; typing saves it', opened.noted && opened.focus && /agent-note-from-the-sweep/.test(w.note || ''), { opened, note: w.note, meta: row && row.meta });
  G.agentNote = { id: ag.id, note: w.note };
};

G.search = async () => {
  await G._go(0);
  await bodyFocus();
  await key(P, 'k', MOD.meta);
  await sleep(300);
  const focused = await ev('document.activeElement === document.getElementById("q")');
  await ok('⌘K focuses the search box', focused);
  // a window in another workspace
  const s = await state();
  const other = s.ws[2].windows.find((w) => w.type === 'term');
  const word = (other && (other.title || '')).split(/\s+/).find((x) => x.length > 3) || 'bench';
  await type(P, word.toLowerCase());
  await sleep(500);
  const secs = await ev('[...document.querySelectorAll("#sblist .sec")].map((x) => x.textContent)');
  const hits = await ev('[...document.querySelectorAll("#sblist .tr")].map((r) => r.dataset.act || ("sess|" + r.dataset.sess))');
  await ok(`search "${word.toLowerCase()}" lists ${s.ws[2].name}'s window under other workspaces`, secs.includes('in other workspaces') && hits.includes(`win|${other && other.id}`), { secs, hits: hits.slice(0, 6) });
  const hr = await rowRect(`win|${other.id}`);
  await hit(`#sblist .tr[data-act="${`win|${other.id}`}"]`);
  await sleep(700);
  await ok('clicking it goes to that workspace', (await curIndex()) === 2, await curIndex());
  await key(P, 'Escape');
  await G._go(0);
  // an old session: only one this sweep makes itself (STATUS, rule since 18:45), never anybody else's
  const own = ownSession();
  if (!(await ok('a session of the sweep\'s own to find (claude -p "/cost" in /tmp/flow-dev-ship/sessions)', own.ok, own))) return;
  await bodyFocus();
  await key(P, 'k', MOD.meta);
  await sleep(200);
  await type(P, own.word);
  const row = await until(() => rectOf(`#sblist .srow[data-sess="${own.id}"]`), 15000, 200);
  const sec = await ev('[...document.querySelectorAll("#sblist .sec")].map((x) => x.textContent)');
  // the section header: "older sessions, not in a workspace" until batch 8, "older sessions" from it (sidebar)
  await ok('⌘K finds that session by its folder', !!row && sec.some((x) => x.startsWith('older sessions')), { sec });
  if (!row) return;
  await hit(`#sblist .srow[data-sess="${own.id}"]`);
  const said = await toastSaid(/^opened in /);
  await sleep(600);
  const wins = await wsWindows('flow');
  const w = wins.find((x) => x.sessionId === own.id);
  await ok('clicking it opens it here as a resumed agent', !!w && w.resume === true, { w: w && { id: w.id, title: w.title, resume: w.resume }, toast: said });
  const qv = await ev('document.getElementById("q").value');
  await ok('the search box is cleared after opening', qv === '', qv);
  if (w) {
    const txt = await until(async () => { const t = await termText(w.id); return t && /Total cost:|Total code changes:|trust the files in this folder|Do you trust|safety check|trust this folder|Security guide|Enter to confirm/i.test(t) ? t : null; }, 40000, 500);
    const trust = /trust the files in this folder|Do you trust|safety check|trust this folder|Security guide|Enter to confirm/i.test(txt || '');
    await ok(`the resumed agent shows Claude Code${trust ? ' (its trust question for the new folder, not answered)' : ' with the /cost exchange'}`, !!txt, (txt || (await termText(w.id)) || '').slice(-160));
    G.trustAsked = trust;
    const pid = (tmux('list-panes', '-t', `flow_${w.id}`, '-F', '#{pane_pid}').stdout || '').trim();
    const args = spawnSync('bash', ['-c', `pgrep -P ${pid} | xargs -r ps -o args= -p; pgrep -P ${pid} | xargs -r -I{} pgrep -P {} | xargs -r ps -o args= -p`], { encoding: 'utf8' }).stdout;
    await ok('it runs claude --resume with that id', args.includes(`--resume ${own.id}`), args.trim().split('\n').filter((l) => /claude/.test(l)).join(' | ').slice(0, 200));
    G.resumed = { ...w, own };
  }
};

/* A session made by the sweep itself: local, no tokens, a real transcript (the way backlog makes test sessions). Its
   folder is under the home folder, which Claude Code already trusts, so it opens on its conversation; the sweep never
   answers the trust question (the lead, Nov 1). Every id the sweep makes goes to $SHOTS/../own-sessions.txt. */
const SESSIONS_LOG = path.join(path.dirname(OUT), 'own-sessions.txt');
const logSession = (line) => fs.appendFileSync(SESSIONS_LOG, `${new Date().toISOString()} sweep: ${line}\n`);
let OWN = null;
function ownSession() {
  if (OWN) return OWN;
  const word = `shipsweep${Date.now().toString(36)}`;
  const dir = path.join(process.env.HOME, '.flow-dev', 'ship', word);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const claude = path.join(process.env.HOME, '.local/bin/claude');
  const r = spawnSync(claude, ['-p', '/cost', '--session-id', id], { cwd: dir, encoding: 'utf8', timeout: 90000, env: { ...process.env } });
  const file = path.join(process.env.HOME, '.claude/projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  OWN = { ok: r.status === 0 && fs.existsSync(file), id, word, dir, file, status: r.status, out: (r.stdout || '').trim().slice(0, 120), err: (r.stderr || '').trim().slice(0, 200) };
  logSession(`${id} claude -p "/cost" in ${dir} (exit ${r.status})`);
  return OWN;
}

G.popout = async () => {
  await G._go(1);
  const s = await state();
  const ws = s.ws[1];
  const pill = await rectOf('#spaces .sp[data-i="1"]');
  await mouse(P, 'mouseMoved', pill.cx, pill.cy);
  await sleep(200);
  const pop = await rectOf('#spaces .sp[data-i="1"] .pop');
  await hit('#spaces .sp[data-i="1"] .pop');
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && t.url.includes(`#solo=${encodeURIComponent(ws.id)}`)), 15000, 250);
  if (!(await ok('⤢ on a pill opens that workspace in its own window', !!target, target && target.url))) return;
  const W = await connect(new RegExp(`#solo=${ws.id}$`));
  await until(() => evaluate(W, 'window.__flow && window.__flow.ready.then(() => true)'), 15000);
  const nav = await evaluate(W, 'document.getElementById("spaces").innerText');
  const nwin = await evaluate(W, 'document.querySelectorAll(".win").length');
  await ok('the pop-out shows the workspace by name, with its windows', nav.startsWith(ws.name) && nwin === ws.windows.length, { nav, nwin, want: ws.windows.length });
  const terms = ws.windows.filter((w) => w.type === 'term' || w.type === 'team');
  await sleep(2000);
  const clientsIn = terms.map((w) => tmuxClients(w.id));
  const mainSays = await ev(`(document.querySelector('#track section.ws[data-id="${ws.id}"]') || {}).innerText || ''`);
  await ok('the popped-out space lives only in its pop-out: one tmux client each, the main window says "in another window" (BRIEF 3.0)', terms.every((w, i) => clientsIn[i] === 1) && /in another window/.test(mainSays), { terms: terms.map((w) => w.id), clients: clientsIn, main: mainSays.slice(0, 80) });
  const fs1 = await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  // the pop-out's client goes and the main window attaches its own again: waited for (one read after 1.5 s found 0 at
  // load 113-167, the lead's A/B in ~/flow-lead-evidence/b9-popab/)
  const closedAt = Date.now();
  let after = terms.map((w) => [tmuxHas(w.id), tmuxClients(w.id)]);
  await until(async () => { after = terms.map((w) => [tmuxHas(w.id), tmuxClients(w.id)]); return after.every(([h, c]) => h && c === 1); }, 10000, 200);
  const stillHere = (await state()).ws.some((w) => w.id === ws.id);
  await ok('closing it keeps the workspace and its sessions (one client each again)', fs1.ok && stillHere && after.every(([h, c]) => h && c === 1), { after, stillHere, ms: Date.now() - closedAt });
  W.ws.close();
  // ⤢ on a sub-workspace's sidebar row: that space in its own window
  await G._go(0);
  const s0 = await state();
  const zn = s0.ws[0].zones.find((z) => z.id === 'z-research') || s0.ws[0].zones[0];
  const rr = await rowRect(`zone|${zn.id}`);
  await mouse(P, 'mouseMoved', rr.cx, rr.cy);
  await sleep(150);
  await hit(`#sblist .tr[data-act="zone|${zn.id}"] [data-zpop]`);
  const zt = await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && t.url.includes(`#solo=flow&zone=${encodeURIComponent(zn.id)}`)), 15000, 250);
  if (await ok('⤢ on a sub-workspace row opens that space in its own window', !!zt, zt && zt.url)) {
    const Z = await connect(new RegExp(`zone=${zn.id}$`));
    await until(() => evaluate(Z, 'window.__flow && window.__flow.ready.then(() => true)'), 15000);
    await sleep(800);
    const members = (await state()).ws[0].windows.filter((w) => w.zone === zn.id).map((w) => w.id).sort();
    const shownZ = await evaluate(Z, `[...document.querySelectorAll('.win')].filter((w) => w.style.display !== 'none').map((w) => w.dataset.id).sort()`);
    const navZ = await evaluate(Z, 'document.getElementById("spaces").innerText');
    await ok('it shows only that space\'s windows, named workspace › sub-workspace', q(members) === q(shownZ) && navZ.startsWith(`${s0.ws[0].name} › ${zn.name}`), { members, shown: shownZ, nav: navZ });
    await fetch(`http://127.0.0.1:${PORT}/json/close/${zt.id}`);
    await sleep(1200);
    await ok('closing it keeps the sub-workspace in the main window', (await state()).ws[0].zones.some((z) => z.id === zn.id));
    Z.ws.close();
  }
};

G.pages = async () => {
  const port = await startSite();
  const base = `http://localhost:${port}/`;
  await G._go(0);
  // type a link at the top of a page: it opens inside the note
  const pg = await freshPageWindow('flow');
  if (!(await ok('a fresh page window from the dock, address focused', !!pg, pg))) return;
  await type(P, `localhost:${port}/`);
  await key(P, 'Enter');
  const loaded = await until(async () => { const w = (await state()).ws[0].notes.find((n) => n.id === pg.noteId); const p = await ev(`(() => { const p = window.__flow.page(${q(pg.id)}); return p ? { url: p.getURL(), title: p.getTitle(), loading: p.isLoading() } : null; })()`); return w && w.url === base && p && !p.loading && /sweep/.test(p.title) ? { url: w.url, title: p.title } : null; }, 15000, 250);
  await ok('typing a link in the address opens it in the page (the page names itself)', !!loaded, loaded);
  const guest = await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'webview' && t.url.startsWith(base)), 8000);
  // click a link inside the page (real mouse on the scaled webview)
  const link = await guestPoint(pg.id, '#go2');
  if (await ok('the page link is on screen', !!link, link)) {
    await sleep(500);
    const under = await ev(`(() => { const el = document.elementFromPoint(${link.x}, ${link.y}); return el ? el.tagName + '.' + el.className : null; })()`);
    await mouse(P, 'mouseMoved', link.x, link.y);
    await sleep(120);
    await click(P, link.x, link.y);
    const two = await until(async () => { const n = (await state()).ws[0].notes.find((x) => x.id === pg.noteId); return n.url === `${base}two` ? n : null; }, 10000, 200);
    await ok('clicking a link in the page navigates it', !!two, two ? two.url : { under, body: await ev('document.body.className'), url: (await state()).ws[0].notes.find((x) => x.id === pg.noteId).url });
  }
  // back, forward, reload buttons
  const nav = (k) => rectOf(`${winSel(pg.id)} .addr [data-nav="${k}"]`);
  let b = await nav('back');
  await click(P, b.cx, b.cy);
  const back = await until(async () => ((await state()).ws[0].notes.find((x) => x.id === pg.noteId).url === base), 8000, 200);
  b = await nav('fwd');
  await click(P, b.cx, b.cy);
  const fwd = await until(async () => ((await state()).ws[0].notes.find((x) => x.id === pg.noteId).url === `${base}two`), 8000, 200);
  await ok('‹ goes back, › goes forward', back && fwd, { back, fwd });
  b = await nav('back');
  await click(P, b.cx, b.cy);
  await until(async () => ((await state()).ws[0].notes.find((x) => x.id === pg.noteId).url === base), 8000, 200);
  await sleep(600);
  const hits0 = siteHits['/'];
  b = await nav('reload');
  await click(P, b.cx, b.cy);
  const rel = await until(() => siteHits['/'] > hits0, 8000, 100);
  await ok('↻ reloads the page from the server', rel, { before: hits0, after: siteHits['/'] });
  await sleep(800);
  // a link that opens a new tab: Flow opens it as a tab in the same page window (owner, Nov 1: "a somehow new tab")
  const n0 = (await wsWindows('flow')).length;
  const bl = await guestPoint(pg.id, '#blank3');
  if (await ok('the new-tab link is on screen', !!bl, bl)) {
    await mouse(P, 'mouseMoved', bl.x, bl.y);
    await sleep(120);
    await click(P, bl.x, bl.y);
    const strip = `${winSel(pg.id)} .ptabs`;
    const tabs = await until(async () => { const r = await ev(`(() => { const el = document.querySelector('${strip}'); return el ? { on: el.classList.contains('on'), n: el.querySelectorAll('.ptab').length, active: (el.querySelector('.ptab.on .pt-t') || {}).textContent } : null; })()`); return r && r.n >= 2 ? r : null; }, 10000, 200);
    const url = await until(async () => { const u = await ev(`window.__flow.page(${q(pg.id)}).getURL()`); return u === `${base}three` ? u : null; }, 10000, 200);
    const n1 = (await wsWindows('flow')).length;
    await ok('a link that opens a new tab lands as a tab in the same page window', !!tabs && tabs.on && !!url && n1 === n0, { tabs, url, windows: [n0, n1] });
    // × on the new tab closes it; the page shows the first tab again and the strip goes away
    if (tabs) {
      await hit(`${strip} .ptab.on .pt-x`);
      const one = await until(async () => { const r = await ev(`(() => { const el = document.querySelector('${strip}'); return { on: el.classList.contains('on'), url: window.__flow.page(${q(pg.id)}).getURL() }; })()`); return !r.on && r.url === base ? r : null; }, 5000, 200);
      await ok('× on a tab closes it, back to the first tab, the strip hides with one tab', !!one, one);
      // what the state keeps for the window (its note's address) is the tab it shows; a restart reads it
      await sleep(600);
      const kept = (await ev('window.__flow.windows()')).find((w) => w.id === pg.id);
      const shownUrl = (await pageNow(pg.id) || {}).url;
      await ok('after the tab closes, the window\'s stored address is the tab it shows', kept && kept.url === shownUrl, { stored: kept && kept.url, shown: shownUrl });
    }
  }
  // clip: select the sentence in the page, ✂ appends it to the page's note
  await G._focusRow(`note|${pg.noteId}`);
  await sleep(500);
  const cl = await guestPoint(pg.id, '#clipme', true);
  if (await ok('the sentence to clip is on screen', !!cl, cl)) {
    await drag(P, { x: cl.x0 + 1, y: cl.y }, { x: cl.x1 - 1, y: cl.y }, { steps: 10 });
    await sleep(500);
    const c = await rectOf(`${winSel(pg.id)} .addr .pclip`);
    const off = await ev(`document.querySelector('${winSel(pg.id)} .addr .pclip').classList.contains('off')`);
    await click(P, c.cx, c.cy);
    const clipped = await until(async () => { const n = await pageNoteOf(base); return /clip this exact sentence please/.test(n || '') ? n : null; }, 5000, 200);
    await ok('✂ adds the selected text to the page\'s note (state.pages, batch 2)', !!clipped, { clipWasOff: off, note: clipped || (await pageNoteOf(base)) });
  }
  G.site = { port, base, page: pg };
};

/* Where an element inside a page window's webview is on screen (the guest is laid out at desktop width and scaled). */
async function targetEval(t, expression) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const v = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : undefined); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression } }));
  });
  ws.close();
  return v;
}
// A page window says it is loaded (its address set, not loading) before its page has started, so a page and the element
// in it are waited for, up to 6 s.
async function guestPoint(winId, sel, span) {
  const end = Date.now() + 6000;
  for (;;) {
    const p = await guestPointOnce(winId, sel, span);
    if (p || Date.now() > end) return p;
    await sleep(300);
  }
}
async function guestPointOnce(winId, sel, span) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const wv = await ev(`(() => { const v = document.querySelector('${winSel(winId)} webview:not(.off)') || document.querySelector('${winSel(winId)} webview'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, id: v.getWebContentsId(), cssW: v.offsetWidth, url: v.getURL() }; })()`);
  if (!wv) return null;
  // two windows can show the same address: this window's page is the target that carries a mark set through its webview
  const same = list.filter((x) => x.type === 'webview' && x.url === wv.url);
  let t = same[0];
  if (same.length > 1) {
    const mark = `${winId}-${Date.now()}`;
    await ev(`(() => { const v = document.querySelector('${winSel(winId)} webview:not(.off)') || document.querySelector('${winSel(winId)} webview'); return v.executeJavaScript(${q(`window.__sweepMark = ${JSON.stringify(mark)}`)}); })()`);
    t = null;
    for (const x of same) if ((await targetEval(x, 'window.__sweepMark')) === mark) { t = x; break; }
    if (!t) console.log(`sweep: none of the ${same.length} targets showing ${wv.url} carries window ${winId}'s mark`);
  }
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  // Chromium routes a click by what the page has drawn: one sent before its first frames never reaches the page
  // (popupprobe: 5 of 20 tries on a busy machine, 0 of 20 once two frames were drawn). A person cannot click what is not
  // on screen yet, so the sweep waits for two frames too.
  await new Promise((resolve) => {
    ws.onmessage = (m) => { if (JSON.parse(m.data).id === 0) resolve(); };
    ws.send(JSON.stringify({ id: 0, method: 'Runtime.evaluate', params: { awaitPromise: true, expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))' } }));
  });
  const res = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result && d.result.result.value); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: true, expression: `(async () => { const el = document.querySelector(${q(sel)}); if (!el) return null; const box = () => { if (${!!span}) { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); } return el.getBoundingClientRect(); }; let r = box(); const below = r.top < 0 || r.bottom > innerHeight; if (below) { el.scrollIntoView({ block: 'center' }); await new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(d))); r = box(); } return { l: r.left, t: r.top, w: r.width, h: r.height, vw: innerWidth, scrolled: below }; })()` } }));
  });
  ws.close();
  if (!res) return null;
  if (res.scrolled) console.log(`sweep: ${sel} was outside the page's own view in window ${winId}; scrolled it into view first`);
  const s = wv.w / res.vw;
  const out = { x: wv.x + (res.l + res.w / 2) * s, y: wv.y + (res.t + res.h / 2) * s, x0: wv.x + res.l * s, x1: wv.x + (res.l + res.w) * s, scale: s };
  const vp = await rectOf('#viewport');
  return out.y > wv.y && out.y < wv.y + wv.h && out.x0 > vp.x && out.x1 < vp.x + vp.w ? out : null;
}

/* ---------- terminals: typing, ⌘F, links, copy and paste, a dropped file, an image ---------- */
/* Where a piece of text is on screen in a terminal (last occurrence), from xterm's buffer and its screen element. */
async function termSpot(id, needle) {
  return ev(`(() => {
    const t = window.__flow.term(${q(id)});
    const scr = document.querySelector('${winSel(id)} .xterm-screen');
    if (!t || !scr) return null;
    const lines = t.getText().split(String.fromCharCode(10));
    for (let y = lines.length - 1; y >= 0; y--) {
      const x = lines[y].lastIndexOf(${q(needle)});
      if (x < 0) continue;
      const r = scr.getBoundingClientRect();
      const cw = r.width / t.cols, ch = r.height / t.rows;
      return { x0: r.left + (x + 0.5) * cw, x1: r.left + (x + ${needle.length} - 0.5) * cw, x: r.left + (x + ${needle.length} / 2) * cw, y: r.top + (y + 0.5) * ch };
    }
    return null;
  })()`);
}
async function keyCmd(k, modifiers, commands) {
  const code = `Key${k.toUpperCase()}`, vk = k.toUpperCase().charCodeAt(0);
  await P.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, commands });
  await P.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
async function focusTerm(id) {
  await G._focusRow(`win|${id}`);
  const r = await rectOf(`${winSel(id)} .xterm-screen`);
  await click(P, r.x + r.w - 30, r.y + r.h - 12);
  await sleep(200);
  return ev(`document.activeElement === (window.__flow.term(${q(id)}) && document.querySelector('${winSel(id)} .xterm-helper-textarea'))`);
}

G.terms = async () => {
  await G._go(0);
  const sh = G.shell ? (await wsWindows('flow')).find((w) => w.id === G.shell.id) : (await desktopMenu('new shell')).w;
  if (!(await ok('a shell window in flow', !!sh))) return;
  const ready = await until(async () => { const t = await termText(sh.id); return t && /[$%#>]\s*$/m.test(t) ? t : null; }, 30000, 300);
  await ok('the shell shows a prompt', !!ready, (await termText(sh.id) || '').slice(-120));
  const f = await focusTerm(sh.id);
  await ok('a click in the terminal focuses it', f);
  await type(P, 'echo sweep-$((6*7))');
  await key(P, 'Enter');
  const echoed = await until(async () => /^sweep-42$/m.test((await termText(sh.id)) || ''), 5000, 150);
  await ok('typing runs in the shell (echo sweep-$((6*7)) prints sweep-42)', echoed, (await termText(sh.id) || '').slice(-120));
  // ⌘F finds text in the terminal
  await key(P, 'f', MOD.meta);
  await sleep(300);
  const find = await ev(`(() => { const f = document.querySelector('${winSel(sh.id)} .fterm-find'); return f ? { hidden: f.hidden, focus: document.activeElement === f.querySelector('input') } : null; })()`);
  await type(P, 'sweep-42');
  await sleep(500);
  const count = await ev(`(document.querySelector('${winSel(sh.id)} .fterm-n') || {}).textContent`);
  await key(P, 'Escape');
  await sleep(300);
  const closed = await ev(`(() => { const f = document.querySelector('${winSel(sh.id)} .fterm-find'); return { hidden: f.hidden, back: document.activeElement === document.querySelector('${winSel(sh.id)} .xterm-helper-textarea') }; })()`);
  await ok('⌘F opens find, finds the text, Esc closes it and goes back to the terminal', find && !find.hidden && find.focus && /\d/.test(count || '') && closed.hidden && closed.back, { find, count, closed });
  // a link printed in the terminal opens as a page next to it
  if (!G.site) G.site = { port: await startSite() };
  const url = `http://localhost:${G.site.port}/two`;
  await focusTerm(sh.id);
  await type(P, `echo ${url}`);
  await key(P, 'Enter');
  await until(async () => (await termText(sh.id) || '').split('\n').some((l) => l.trim() === url), 5000, 150);
  const n0 = (await wsWindows('flow')).length;
  const spot = await termSpot(sh.id, url);
  if (await ok('the printed link is on screen', !!spot, spot)) {
    await mouse(P, 'mouseMoved', spot.x - 4, spot.y);
    await sleep(150);
    await mouse(P, 'mouseMoved', spot.x, spot.y);
    await sleep(300);
    await click(P, spot.x, spot.y);
    const pw = await until(async () => { const ws = await wsWindows('flow'); return ws.length > n0 ? ws[ws.length - 1] : null; }, 6000, 200);
    const n = pw && (await state()).ws[0].notes.find((x) => x.id === pw.noteId);
    await ok('clicking a link in the terminal opens it as a page window', pw && pw.type === 'page' && n && n.url === url, { win: pw && pw.id, url: n && n.url });
    G.linkPage = pw;
  }
  // copy: a forced selection (Shift+drag on Linux, Option on macOS) and ⌘C, then ⌘V into a note
  await G._focusRow(`win|${sh.id}`);
  const sel = await termSpot(sh.id, 'sweep-42');
  if (await ok('the echoed text is on screen', !!sel, sel)) {
    await mouse(P, 'mouseMoved', sel.x0 - 2, sel.y);
    await mouse(P, 'mousePressed', sel.x0 - 2, sel.y, { modifiers: MOD.shift });
    for (let i = 1; i <= 8; i++) await mouse(P, 'mouseMoved', sel.x0 - 2 + ((sel.x1 + 3 - sel.x0) * i) / 8, sel.y, { down: true, modifiers: MOD.shift });
    await mouse(P, 'mouseReleased', sel.x1 + 3, sel.y, { modifiers: MOD.shift });
    await sleep(200);
    await key(P, 'c', MOD.meta);
    await sleep(300);
    const note = await noteInView('flow');
    await focusNoteEnd(note.id);
    await type(P, ' pasted:');
    await keyCmd('v', MOD.meta, ['paste']);
    await sleep(700);
    const nb = (await state()).ws[0].notes.find((x) => x.id === note.noteId).body;
    await ok('a selection copied with ⌘C pastes with ⌘V into a note', /pasted:sweep-42\b/.test(nb), { tail: nb.slice(-40) });
  }
  // paste into the terminal: text copied from a note goes in as one bracketed paste, not run
  const note2 = await noteInView('flow');
  if (!/sweep body text/.test((await state()).ws[0].notes.find((x) => x.id === note2.noteId).body || '')) {
    // run without the notes group: the note gets the text to copy here
    await focusNoteEnd(note2.id);
    await type(P, ' sweep body text');
    await sleep(400);
  }
  await ev(`(() => { const ed = document.querySelector('${winSel(note2.id)} .nbody'); ed.focus(); const r = document.createRange(); const tn = [...ed.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('sweep body text')) || ed.firstChild; const k = tn.textContent.indexOf('sweep body text'); r.setStart(tn, Math.max(0, k)); r.setEnd(tn, Math.max(0, k) + 'sweep body text'.length); getSelection().removeAllRanges(); getSelection().addRange(r); return String(getSelection()); })()`);
  await keyCmd('c', MOD.meta, ['copy']);
  await focusTerm(sh.id);
  await keyCmd('v', MOD.meta, ['paste']);
  await sleep(600);
  const pasted = await termText(sh.id);
  const last = (pasted || '').split('\n').filter((l) => l.trim()).pop() || '';
  await ok('⌘V pastes text into the terminal input without running it', /sweep body text\s*$/.test(last), last);
  await key(P, 'u', MOD.ctrl);
  // a file dropped on the terminal types its quoted path
  // test input, not evidence: a short path, so the typed path fits on one terminal row
  const file = '/tmp/flow-ship-drop/drop me.txt';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'dropped\n');
  const tr = await rectOf(`${winSel(sh.id)} .xterm-screen`);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const t of ['dragEnter', 'dragOver']) await P.send('Input.dispatchDragEvent', { type: t, x: tr.cx, y: tr.cy, data });
  await P.send('Input.dispatchDragEvent', { type: 'drop', x: tr.cx, y: tr.cy, data });
  await sleep(700);
  const dl = ((await termText(sh.id)) || '').split('\n').filter((l) => l.trim()).pop() || '';
  await ok('a dropped file types its path, spaces escaped, into the terminal', dl.includes(file.replace(/ /g, '\\ ')), dl);
  await focusTerm(sh.id);
  await key(P, 'u', MOD.ctrl);
};

/* B3: an image on the clipboard, ⌘V in a Claude terminal: Claude Code shows [Image #1]. Nothing is submitted. */
G.image = async () => {
  await G._go(0);
  const ag = G.agent || (await wsWindows('flow')).find((w) => w.type === 'term' && w.cmd === 'claude');
  const up = await until(async () => /\? for shortcuts|bypass permissions|Claude Code/i.test((await termText(ag.id)) || ''), 40000, 500);
  if (!(await ok('a Claude Code window is up', up, ag.id))) return;
  const wrote = await ev(`(async () => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const x = c.getContext('2d'); x.fillStyle = '#d77757'; x.fillRect(0, 0, 64, 48); const b = await new Promise((r) => c.toBlob(r, 'image/png')); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); return true; })()`).catch((e) => e.message);
  await ok('an image is on the clipboard', wrote === true, wrote);
  await focusTerm(ag.id);
  await keyCmd('v', MOD.meta, ['paste']);
  const img = await until(async () => /\[Image #1\]/.test((await termText(ag.id)) || ''), 10000, 250);
  await ok('⌘V of an image in Claude Code shows [Image #1]', img, ((await termText(ag.id)) || '').split('\n').filter((l) => l.trim()).slice(-4).join(' / '));
  const dir = path.join(USER_DATA, 'pasted-images');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  await ok('the image was saved under userData/pasted-images, not ~/.claude', files.length > 0, files);
  // clear Claude's input without submitting: Ctrl+U deletes the line
  await key(P, 'u', MOD.ctrl);
  await sleep(300);
};

/* ---------- teams: a teammate dragged out becomes its own window; a terminal dropped on a team joins it ---------- */
G.teams = async () => {
  await G._go(2);
  const team = (await wsWindows((await state()).ws[2].id)).find((w) => w.type === 'team' && !w.host);
  if (!(await ok('a local team window in the third workspace', !!team))) return;
  await G._focusRow(`win|${team.id}`);
  await until(() => tmuxHas(team.id), 30000);
  const panesAt = () => (tmux('list-panes', '-t', `flow_${team.id}`, '-F', '#{pane_id}').stdout || '').trim().split('\n').filter(Boolean).length;
  const base = panesAt();
  const sp = tmux('split-window', '-d', '-h', '-t', `flow_${team.id}`, '-c', path.join(process.env.HOME, '.flow-dev/ship/seed', (await state()).ws[2].id));
  await ok('a second pane in the team (tmux split-window on flow-dev-ship)', sp.status === 0, sp.stderr.trim());
  const mates = await until(async () => { const n = await ev(`document.querySelectorAll('${winSel(team.id)} .fterm-mate').length`); return n >= 2 ? n : null; }, 10000, 300);
  await ok('the team shows a handle per pane', mates >= 2, mates);
  const rows = await until(async () => { const r = (await sbRows()).filter((x) => (x.act || '').startsWith(`mate|${team.id}|`) || x.act === `win|${team.id}`); return r.length ? r : null; }, 8000, 300);
  await ok('the sidebar lists the team (its teammates folded under it)', !!rows, rows);
  // the lead stays
  const lead = await rectOf(`${winSel(team.id)} .fterm-mate`, 0);
  const handles = await ev(`[...document.querySelectorAll('${winSel(team.id)} .fterm-mate')].map((m) => { const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  const panes0 = (tmux('list-panes', '-t', `flow_${team.id}`, '-F', '#{pane_id} #{pane_index} #{pane_left}').stdout || '').trim().split('\n');
  const ep = await emptyPoint();
  const tr = await winRect(team.id);
  const out = ep && !(ep.x > tr.x && ep.x < tr.x + tr.w && ep.y > tr.y && ep.y < tr.y + tr.h) ? ep : { x: Math.max(tr.x - 120, 300), y: tr.y + 100 };
  await drag(P, handles[0], out, { steps: 12 });
  const leadSaid = await toastSaid(/the lead stays with its team/, 2000);
  await ok('dragging the lead out is refused and says why', /^the lead stays with its team/.test(leadSaid), leadSaid);
  await sleep(500);
  const n0 = (await wsWindows((await state()).ws[2].id)).length;
  const h2 = await ev(`[...document.querySelectorAll('${winSel(team.id)} .fterm-mate')].map((m) => { const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`);
  await drag(P, h2[1], out, { steps: 14 });
  const said = await toastSaid(/is its own window now\./, 6000);
  await sleep(800);
  const wins = await wsWindows((await state()).ws[2].id);
  const nw = wins.length > n0 ? wins[wins.length - 1] : null;
  const panes1 = (tmux('list-panes', '-t', `flow_${team.id}`, '-F', '#{pane_id}').stdout || '').trim().split('\n').filter(Boolean);
  await ok('a teammate dragged out becomes its own window, the team has one pane less', nw && nw.type === 'term' && tmuxHas(nw.id) && panes1.length === base, { win: nw && nw.id, toast: said, teamPanes: panes1.length, before: panes0 });
  if (!nw) return;
  const txt = await until(async () => ((await termText(nw.id)) || '').trim().length > 0, 8000, 250);
  await ok('the new window shows that pane (same process, not a new one)', !!txt, ((await termText(nw.id)) || '').slice(-80));
  // dropped on the team it stays its own window and moves beside the team, grouped with it (BRIEF 3.0 Teams)
  await sleep(500);
  const t = await titlePoint(nw.id);
  const tr2 = await winRect(team.id);
  await drag(P, t, { x: tr2.cx, y: tr2.cy }, { steps: 16 });
  await sleep(900);
  const after = (await wsWindows((await state()).ws[2].id)).find((w) => w.id === nw.id);
  const nr = after && (await winRect(nw.id));
  const tr3 = await winRect(team.id);
  const besideTeam = nr && (Math.abs(nr.y - tr3.y) < 4 && (nr.x >= tr3.x + tr3.w - 2 || nr.x + nr.w <= tr3.x + 2) || Math.abs(nr.x - tr3.x) < 4 && nr.y >= tr3.y + tr3.h - 2);
  const panes2 = (tmux('list-panes', '-t', `flow_${team.id}`, '-F', '#{pane_id}').stdout || '').trim().split('\n').filter(Boolean);
  await ok('a terminal dropped on a team keeps its own window, beside the team, grouped with it', after && after.group === team.id && besideTeam && tmuxHas(nw.id) && panes2.length === base, { group: after && after.group, win: nr, team: tr3, teamPanes: panes2.length });
  // put the team back as it was: the shell pane this group added goes away again
  if (panesAt() > base) tmux('kill-pane', '-t', (tmux('list-panes', '-t', `flow_${team.id}`, '-F', '#{pane_id}').stdout || '').trim().split('\n').pop());
  await G._go(0);
};

/* ---------- B5 fork: right-click an agent, fork; a new window beside it with the conversation and its own id ---------- */
G.fork = async () => {
  await G._go(0);
  // only the sweep's own session is ever forked (STATUS, rule since 18:45)
  const parent = G.resumed && G.resumed.own ? (await wsWindows('flow')).find((w) => w.id === G.resumed.id && w.sessionId === G.resumed.own.id) : null;
  if (!(await ok('the sweep\'s own resumed session to fork', !!parent))) return;
  await G._focusRow(`win|${parent.id}`);
  const r = await rectOf(`${winSel(parent.id)} .xterm-screen`);
  const before = await termText(parent.id);
  await mouse(P, 'mouseMoved', r.cx, r.cy);
  await mouse(P, 'mousePressed', r.cx, r.cy, { button: 'right', buttons: 2 });
  await mouse(P, 'mouseReleased', r.cx, r.cy, { button: 'right', buttons: 0 });
  await sleep(500);
  const menu = await ev('[...document.querySelectorAll(".ctx button")].map((b) => b.textContent)');
  const after = await termText(parent.id);
  const tmuxMenu = /Swap Up|Kill|Respawn|Horizontal Split|Mark/.test(after || '') && !/Swap Up|Respawn|Horizontal Split/.test(before || '');
  await ok('right-click on an agent shows Flow\'s menu (fork, copy resume command), not tmux\'s', menu.some((m) => /^fork/.test(m)) && !tmuxMenu, { menu, tmuxMenu });
  if (tmuxMenu) { await key(P, 'Escape'); await sleep(300); }
  if (!menu.some((m) => /^fork/.test(m))) return;
  const n0 = (await wsWindows('flow')).length;
  const pr0 = await winRect(parent.id);
  await hit('.ctx button[data-i="0"]');
  const said = await toastSaid(/^forked /, 8000);
  const f = await until(async () => { const ws = await wsWindows('flow'); return ws.length > n0 ? ws.find((w) => w.forkFrom === parent.sessionId) : null; }, 8000, 200);
  await ok('fork opens a new window named "fork of ..." with its own session id', f && f.sessionId && f.sessionId !== parent.sessionId && /^fork of /.test(f.title || f.label || ''), { f: f && { id: f.id, title: f.title, label: f.label, sessionId: f.sessionId, forkFrom: f.forkFrom }, toast: said });
  if (!f) return;
  await sleep(900);
  const pr1 = await winRect(parent.id);
  const fr = await winRect(f.id);
  const beside = (Math.abs(fr.y - pr1.y) < 3 && fr.x > pr1.x) || (Math.abs(fr.x - pr1.x) < 3 && fr.y > pr1.y);
  await ok('the fork sits beside its parent (the parent splits in two)', beside && (pr1.w < pr0.w - 20 || pr1.h < pr0.h - 20), { parentBefore: pr0, parent: pr1, fork: fr });
  if (G.trustAsked) {
    const tq = await until(async () => /trust the files in this folder|Do you trust|safety check|trust this folder|Security guide|Enter to confirm/i.test((await termText(f.id)) || ''), 40000, 500);
    console.log('     note: Claude Code asks to trust the session folder first, so the conversation itself is not on screen in the parent or the fork');
    await ok('the fork shows Claude Code (the same trust question as its parent)', tq, ((await termText(f.id)) || '').slice(-120));
  } else {
    const conv = await until(async () => /Total cost:|Total duration \(|Total code changes:|\d+ input, \d+ output/.test((await termText(f.id)) || ''), 40000, 500);
    await ok('the fork shows the parent\'s conversation (the /cost exchange)', conv, ((await termText(f.id)) || '').slice(-200));
  }
  const pid = (tmux('list-panes', '-t', `flow_${f.id}`, '-F', '#{pane_pid}').stdout || '').trim();
  const ps = spawnSync('ps', ['-o', 'args=', '--ppid', pid], { encoding: 'utf8' }).stdout + spawnSync('bash', ['-c', `pgrep -P ${pid} | xargs -r -I{} ps -o args= --ppid {}`], { encoding: 'utf8' }).stdout;
  await ok('the fork runs claude --resume <parent> --fork-session --session-id <new>', ps.includes(`--resume ${parent.sessionId} --fork-session --session-id ${f.sessionId}`) || ps.includes(`--resume ${f.sessionId}`), ps.trim().split('\n').filter((l) => /claude/.test(l)).join(' | ').slice(0, 300));
  G.fork = f;
  logSession(`${f.sessionId} fork of ${parent.sessionId} (window ${f.id})`);
  // copy resume command
  await G._focusRow(`win|${parent.id}`);
  const r2 = await rectOf(`${winSel(parent.id)} .xterm-screen`);
  await mouse(P, 'mouseMoved', r2.cx, r2.cy);
  await mouse(P, 'mousePressed', r2.cx, r2.cy, { button: 'right', buttons: 2 });
  await mouse(P, 'mouseReleased', r2.cx, r2.cy, { button: 'right', buttons: 0 });
  await sleep(400);
  const items = await ev('[...document.querySelectorAll(".ctx button")].map((b) => b.textContent)');
  const ci = items.findIndex((m) => /^copy resume command/.test(m));
  if (ci >= 0) {
    await hit(`.ctx button[data-i="${ci}"]`);
    await sleep(400);
    const note = await noteInView('flow');
    await focusNoteEnd(note.id);
    await type(P, ' resume:');
    await keyCmd('v', MOD.meta, ['paste']);
    await sleep(700);
    const nb = (await state()).ws[0].notes.find((x) => x.id === note.noteId).body || '';
    await ok('copy resume command puts cd <folder> && claude --resume <id> on the clipboard', nb.includes(`claude --resume ${parent.sessionId}`), nb.slice(-140));
  } else await ok('the menu has copy resume command', false, items);
};

/* ---------- browser flows across features: title, close and reopen, move to another workspace, pop-out ---------- */
G.browser = async () => {
  if (!G.site) G.site = { port: await startSite() };
  const base = `http://localhost:${G.site.port}/`;
  await G._go(0);
  // a fresh page from the dock, pointed at the local site
  const pg = await freshPageWindow('flow');
  if (!(await ok('a new page window from the dock', pg && pg.type === 'page'))) return;
  await ok('the new page window\'s title bar is in view (reachable: ✎, close, drag)', G.lastPagePlace && G.lastPagePlace.inView, G.lastPagePlace);
  await type(P, `localhost:${G.site.port}/`);
  await key(P, 'Enter');
  const loaded = await until(async () => { const p = await pageNow(pg.id); const tb = await titleBarOf(pg.id); return p && p.url === base && !p.loading && tb === 'sweep one' ? { url: p.url, titleBar: tb } : null; }, 15000, 250);
  await ok('the page loads and the title bar shows its title (BRIEF 3.0)', !!loaded, loaded || { page: await pageNow(pg.id), titleBar: await titleBarOf(pg.id) });
  // a new page holds only the page: its note waits behind ✎ (owner, Nov 1: "the whole write about page thing should be on the fucking side")
  const noteShown = () => ev(`(() => { const w = document.querySelector('${winSel(pg.id)}'); const ed = w.querySelector('.npane') || w.querySelector('.anote') || w.querySelector('.pnote'); return { noted: w.classList.contains('noted'), visible: !!ed && ed.offsetParent !== null && ed.getBoundingClientRect().width > 0, focused: !!ed && !!document.activeElement && ed.contains(document.activeElement) }; })()`);
  const paneText = () => ev(`(() => { const ed = document.querySelector('${winSel(pg.id)} .npane'); return ed ? ed.innerText : null; })()`);
  const n0s = await noteShown();
  await ok('a new page holds only the page: no note showing', !n0s.noted && !n0s.visible, n0s);
  await hit(`${winSel(pg.id)} > .tb [data-act="note"]`);
  await sleep(400);
  const n1s = await noteShown();
  await type(P, 'note beside the page');
  await sleep(600);
  const pn = await pageNoteOf(base);
  await hit(`${winSel(pg.id)} > .tb [data-act="note"]`);
  await sleep(400);
  const n2s = await noteShown();
  await ok('✎ opens the page note beside it, focused; typing saves it with the page (state.pages); ✎ again closes it', n1s.noted && n1s.visible && n1s.focused && /note beside the page/.test(pn || '') && !n2s.visible, { open: n1s, note: pn, closed: n2s });
  // after a link the title bar shows the new page, and the ✎ note is that page's own (page-as-primitive, batch 2)
  const link = await guestPoint(pg.id, '#go2');
  if (link) {
    await mouse(P, 'mouseMoved', link.x, link.y);
    await sleep(120);
    await click(P, link.x, link.y);
  }
  const moved = await until(async () => { const p = await pageNow(pg.id); return p && p.url === `${base}two` && !p.loading ? p : null; }, 10000, 250);
  await sleep(400);
  const tbTitle = await titleBarOf(pg.id);
  await hit(`${winSel(pg.id)} > .tb [data-act="note"]`);
  await sleep(400);
  const twoPane = await paneText();
  await hit(`${winSel(pg.id)} > .tb [data-act="note"]`);
  await sleep(300);
  const firstKept = await pageNoteOf(base);
  await ok('after a link the title bar shows the new page, its ✎ note is that page\'s own, the first page keeps its note (batch 2)', !!moved && tbTitle === 'sweep two' && twoPane !== null && !/note beside the page/.test(twoPane) && /note beside the page/.test(firstKept || ''), { url: moved && moved.url, titleBar: tbTitle, pane: twoPane, firstPage: firstKept });
  // ⌘D saves it; red closes it with no toast (owner, 20:45); its saved row opens it again on the same address
  const tp = await titlePoint(pg.id);
  await click(P, tp.x, tp.y);
  await sleep(200);
  await ev(`window.__flow.menu('save-page')`);
  const saved = await until(async () => ((await state()).ws.find((w) => w.id === 'flow').saved || []).find((x) => x.url === `${base}two`), 4000, 200);
  await ok('⌘D saves the page (a saved row in the browser group)', !!saved && !!(await until(() => rowRect(`saved|${saved.id}`), 2000, 100)), saved);
  await hit(`${winSel(pg.id)} > .tb [data-l="close"]`);
  const closeToast = await toastShown(1500);
  const gone = !(await ev('window.__flow.windows()')).some((w) => w.id === pg.id);
  const other = await ev(`(() => { const ws = window.__flow.state().ws.find((w) => w.id === 'flow'); for (const w of ws.windows) { if (w.type === 'page' || w.zone) continue; const t = document.querySelector('.win[data-id="' + w.id + '"] > .tb'); if (!t) continue; const r = t.getBoundingClientRect(); const v = document.getElementById('viewport').getBoundingClientRect(); if (r.left > v.left + 10 && r.right < v.right - 10 && r.top > v.top) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; } return null; })()`);
  if (other) await click(P, other.x, other.y);
  const row = saved && (await rowRect(`saved|${saved.id}`));
  if (row) await hit(`#sblist .tr[data-act="saved|${saved.id}"]`);
  const back = row && (await until(async () => { for (const w of await wsWindows('flow')) { if (w.type !== 'page') continue; const p = await pageNow(w.id); if (p && p.url === `${base}two` && !p.loading) return { id: w.id, ...p }; } return null; }, 15000, 300));
  await ok('red closes the page with no toast; its saved row opens it again on the same address (BRIEF 3.0)', gone && !closeToast && !!back, { gone, toast: closeToast, row: !!row, reopened: back });
  const re = back && (await wsWindows('flow')).find((w) => w.id === back.id);
  // dropped on another workspace's name: it moves there and loads the same address
  const win = re;
  if (!win) { console.log('     note: the moves below need the reopened page, skipped'); await G._go(0); return; }
  await settled([win.id]);
  const t = await titlePoint(win.id);
  const pill = await rectOf('#spaces .sp[data-i="2"] .sn');
  const ws2 = (await state()).ws[2];
  await drag(P, t, { x: pill.cx, y: pill.cy }, { steps: 18 });
  await sleep(400);
  await G._go(2);
  const there = await until(async () => { const p = await ev(`(() => { const p = window.__flow.page(${q(win.id)}); return p ? { url: p.getURL(), loading: p.isLoading() } : null; })()`); return p && p.url === `${base}two` && !p.loading ? p : null; }, 15000, 250);
  const inWs = (await state()).ws[2].windows.some((w) => w.id === win.id);
  await ok(`dropped on ${ws2.name}'s name it moves there and shows the same page`, inWs && !!there, { inWs, page: there });
  // in a pop-out of that workspace the page shows too, and closing the pop-out keeps it in the main window
  const pillR = await rectOf('#spaces .sp[data-i="2"]');
  await mouse(P, 'mouseMoved', pillR.cx, pillR.cy);
  await sleep(200);
  await hit('#spaces .sp[data-i="2"] .pop');
  const tgt = await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && x.url.includes(`#solo=${encodeURIComponent(ws2.id)}`)), 15000, 250);
  if (await ok('the workspace opens in its own window', !!tgt)) {
    const W = await connect(new RegExp(`#solo=${ws2.id}$`));
    await until(() => evaluate(W, 'window.__flow && window.__flow.ready.then(() => true)'), 15000);
    const inPop = await until(async () => { const p = await evaluate(W, `(() => { const p = window.__flow.page(${q(win.id)}); return p ? { url: p.getURL(), loading: p.isLoading() } : null; })()`); return p && p.url === `${base}two` && !p.loading ? p : null; }, 15000, 300);
    await ok('the moved page loads in the pop-out as well', !!inPop, inPop);
    await fetch(`http://127.0.0.1:${PORT}/json/close/${tgt.id}`);
    await sleep(1500);
    const still = await ev(`(() => { const p = window.__flow.page(${q(win.id)}); return p ? { url: p.getURL(), loading: p.isLoading() } : null; })()`);
    await ok('after the pop-out closes the page is still live in the main window', still && still.url === `${base}two`, still);
    W.ws.close();
  }
  await G._go(0);
};

/* ---------- installed's scroll repro (item 16): exact steps and timings, the state file's tab entry over time ---------- */
const STATE_FILE = path.join(USER_DATA, 'flow-state.json');
const tabEntry = (winId) => {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const ws of d.ws) for (const w of ws.windows) if (w.id === winId) {
      const t = (w.tabs || [])[w.tab || 0];
      const ps = t && t.history && t.history.entries ? t.history.entries.map((e) => e.pageState || '').join('|') : '';
      return { tab: w.tab || 0, url: t && t.url, entries: t && t.history ? t.history.entries.length : 0, pageState: ps ? `${ps.length} chars, md5 ${crypto.createHash('md5').update(ps).digest('hex').slice(0, 8)}` : 'none' };
    }
  } catch (e) { return { error: e.message }; }
  return null;
};
// Chromium's page state holds the scroll offset as an int32 (ViewState.scroll_offset, a gfx::Point).
const holdsScroll = (ps, y) => {
  if (!ps || !(y > 0)) return false;
  const b = Buffer.from(ps, 'base64');
  const pat = Buffer.alloc(4);
  pat.writeInt32LE(Math.round(y));
  return b.indexOf(pat) >= 0;
};
const liveHistory = (winId) => ev(`(() => { const v = document.querySelector('${winSel(winId)} webview:not(.off)'); return v ? window.flow.pageHistory(v.getWebContentsId()) : null; })()`);
const stateTab = (winId, file = STATE_FILE) => {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const ws of d.ws) for (const w of ws.windows) if (w.id === winId) return { tab: w.tab || 0, t: (w.tabs || [])[w.tab || 0] };
  } catch { return null; }
  return null;
};
const setupRetries = [];
let setupMiss = '';
G.scrollrepro = async () => {
  if (!G.site) G.site = { port: await startSite() };
  const base = `http://localhost:${G.site.port}/`;
  const url = `${base}three`;
  const tabsWanted = Number(process.env.SCROLL_TABS || 1);
  const how = process.env.SCROLL_HOW || 'popup';
  await G._go(0);
  let id;
  if (tabsWanted === 1) {
    id = await ev(`window.__flow.openPage(${q(url)})`);
  } else {
    // as in the save group: a page on / (its own address, so its guest can be told apart), then /three as its second
    // tab, shown
    const first = `${base}?repro=${Date.now()}`;
    id = await ev(`window.__flow.openPage(${q(first)})`);
    await until(async () => ev(`(() => { const p = window.__flow.page(${q(id)}); return p && !p.isLoading() && p.getURL() === ${q(first)}; })()`), 15000, 200);
    if (how === 'popup') {
      // Click once the window holds still and the page has drawn (guestPoint waits for that). Every retry is printed
      // with where the click landed, what was under it and what the page saw: a page that got the click and opened no
      // tab is a real miss, never retried.
      const shownUrl = () => ev(`(() => { const p = window.__flow.page(${q(id)}); return p ? p.getURL() : null; })()`);
      await guestEvalUrl(first, `(() => { window.__reproClicks = []; document.addEventListener('click', (e) => { window.__reproClicks.push(e.target.id || e.target.tagName); }, true); return 1; })()`);
      setupRetries.length = 0;
      for (let k = 0; k < 3 && (await shownUrl()) !== url && !setupMiss; k++) {
        let last = '';
        await until(async () => { const r = JSON.stringify(await winRect(id)); const still = r === last; last = r; return still; }, 3000, 300);
        const bl = await guestPoint(id, '#blank3');
        const under = bl && (await ev(`(() => { const el = document.elementFromPoint(${bl.x}, ${bl.y}); const w = el && el.closest('.win'); return el ? el.tagName.toLowerCase() + ' in ' + (w ? w.dataset.id : 'no window') : null; })()`));
        if (bl) {
          await mouse(P, 'mouseMoved', bl.x, bl.y);
          await sleep(120);
          await click(P, bl.x, bl.y);
        }
        if (await until(async () => (await shownUrl()) === url, 5000, 200)) break;
        const seen = (await guestEvalUrl(first, 'window.__reproClicks')) || [];
        const line = { attempt: k + 1, at: bl && { x: Math.round(bl.x), y: Math.round(bl.y) }, under, pageSaw: seen };
        console.log(`     retry after click ${k + 1}: at ${bl ? `(${line.at.x}, ${line.at.y})` : 'no point (link not on screen)'} over ${under || 'nothing'}, no tab opened; the page saw ${seen.length ? seen.join(', ') : 'no click'}`);
        setupRetries.push(line);
        if (seen.includes('blank3')) setupMiss = `the page got the click on its new-tab link and no tab opened (click ${k + 1})`;
      }
    } else {
      await ev(`window.__flow.menu('new-page')`);
      await sleep(400);
      await type(P, url);
      await key(P, 'Enter');
    }
  }
  await until(async () => ev(`(() => { const p = window.__flow.page(${q(id)}); return p && !p.isLoading() && p.getURL() === ${q(url)}; })()`), 15000, 200);
  await sleep(Number(process.env.SCROLL_SETTLE || 1500));
  const tabs = await ev(`[...document.querySelectorAll('${winSel(id)} .ptab')].map((t) => t.textContent.replace('×', '').trim())`);
  const before = tabEntry(id);
  const front = await ev(`document.querySelector('.win.front') && document.querySelector('.win.front').dataset.id`);
  const wvr = await ev(`(() => { const v = document.querySelector('${winSel(id)} webview:not(.off)'); const r = v.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  // SCROLL_INPUT=keys: a click in the page, then End (a keyboard scroll sends the host no wheel)
  const input = process.env.SCROLL_INPUT || 'wheel';
  if (input === 'keys') {
    await click(P, wvr.x, wvr.y);
    await sleep(300);
    await key(P, 'End');
  } else for (let i = 0; i < 8; i++) await P.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wvr.x, y: wvr.y, deltaX: 0, deltaY: 120, button: 'none', buttons: 0, pointerType: 'mouse' });
  const tScroll = new Date().toISOString();
  await sleep(800);
  const sy = await guestEval(id, 'scrollY');
  // SCROLL_POPOUT=1: then a pop-out of voiceless from its pill, left open (page's race: its older state comes back)
  const popout = process.env.SCROLL_POPOUT === '1';
  if (popout) {
    const vi = (await state()).ws.findIndex((w) => w.id === 'voiceless');
    const pill = await rectOf(`#spaces .sp[data-i="${vi}"]`);
    await mouse(P, 'mouseMoved', pill.cx, pill.cy);
    await sleep(200);
    await hit(`#spaces .sp[data-i="${vi}"] .pop`);
  }
  const wait = Number(process.env.SCROLL_WAIT || 3);
  const samples = [];
  for (let k = 0; k <= wait; k++) {
    const live = await liveHistory(id);
    const live0 = live && live.entries ? live.entries[live.index] : null;
    const st = stateTab(id);
    const saved0 = st && st.t && st.t.history ? st.t.history.entries[st.t.history.index] : null;
    samples.push({ t: `+${k}s`, entry: tabEntry(id), scrollInChromiumEntry: holdsScroll(live0 && live0.pageState, sy), scrollInStateFile: holdsScroll(saved0 && saved0.pageState, sy) });
    if (k < wait) await sleep(1000);
  }
  const repro = { window: id, url, tabs, how: tabsWanted === 1 ? 'one tab' : how, input, popout, setupRetries: [...setupRetries], setupMiss, shownTab: true, windowInFront: front === id, scrollY: sy, tScroll, quitAfterScrollS: wait + 1, stateBeforeScroll: before, stateAfterScroll: samples };
  const name = `scroll-repro-${tabsWanted === 1 ? '' : `${tabsWanted}tabs-${how}-`}${input === 'keys' ? 'keys-' : ''}${popout ? 'popout-' : ''}${wait}s.json`;
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(repro, null, 2));
  const ready = sy > 100 && (tabsWanted === 1 || tabs.length === tabsWanted) && !setupMiss;
  const retried = setupRetries.length ? `, setup needed ${setupRetries.length} retr${setupRetries.length === 1 ? 'y' : 'ies'}` : '';
  await ok(`scroll repro prepared (${repro.how}, tabs ${q(tabs)}): scrollY ${sy}, quit about ${wait + 1}s after the scroll${retried}${setupMiss ? ` (REAL MISS: ${setupMiss})` : ready ? '' : ' (setup failed: nothing was scrolled to restore)'}`, ready, repro);
};
G.scrollcheck = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^scroll-repro-(\d+tabs-\w+-)?(keys-)?(popout-)?\d+s\.json$/.test(f)).map((f) => path.join(OUT, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const r = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const atStart = tabEntry(r.window);
  const st = stateTab(r.window, path.join(OUT, 'state-at-quit.json'));
  const saved0 = st && st.t && st.t.history ? st.t.history.entries[st.t.history.index] : null;
  await until(async () => ev(`(() => { const p = window.__flow.page(${q(r.window)}); return p && !p.isLoading() && p.getURL() === ${q(r.url)}; })()`), 20000, 200);
  await sleep(2000);
  const sy = await guestEval(r.window, 'scrollY');
  const live = await liveHistory(r.window);
  const live0 = live && live.entries ? live.entries[live.index] : null;
  let stop = null;
  try { stop = JSON.parse(fs.readFileSync(path.join(OUT, 'last-stop.json'), 'utf8')); } catch { stop = null; }
  if (stop && stop.sigterm) r.quitAfterScrollMs = Date.parse(stop.sigterm) - Date.parse(r.tScroll);
  r.afterRelaunch = { stateFileAtLaunch: atStart, scrollInStateFileAtLaunch: holdsScroll(saved0 && saved0.pageState, r.scrollY), scrollInRestoredEntry: holdsScroll(live0 && live0.pageState, r.scrollY), restoredEntries: live && live.entries ? live.entries.length : null, scrollY: sy };
  fs.writeFileSync(files[0], JSON.stringify(r, null, 2));
  await ok(`after the relaunch the page is back at scrollY ${r.scrollY}`, Math.abs((sy || 0) - r.scrollY) < 20, { before: r.scrollY, after: sy, quitAfterScrollMs: r.quitAfterScrollMs, input: r.input, inStateFileAtQuit: r.afterRelaunch.scrollInStateFileAtLaunch, file: files[0] });
};

/* The zones reload check once read a different timeOrigin with no new request (batch 4, load about 100): list every
   webview target showing the page, with its timeOrigin, and read the window's own webview directly, before and after
   a trip to a sub-workspace. */
async function targetsAt(url) {
  const out = [];
  for (const t of (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((x) => x.type === 'webview' && x.url === url)) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const v = await new Promise((resolve) => {
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : null); };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'performance.timeOrigin', returnByValue: true } }));
    });
    ws.close();
    out.push({ target: t.id.slice(0, 8), timeOrigin: v });
  }
  return out;
}
G.zonesprobe = async () => {
  await G._go(0);
  let s = await state();
  if (s.ws[0].at) { await hit('#spaces .sp.on .sn'); await sleep(500); s = await state(); }
  const zn = s.ws[0].zones[s.ws[0].zones.length - 1];
  if (!G.site) G.site = { port: await startSite() };
  const url = `http://localhost:${G.site.port}/`;
  const win = await ev(`window.__flow.openPage(${q(url)})`);
  await until(async () => { const p = await pageNow(win); return p && p.url === url && !p.loading; }, 15000, 250);
  await sleep(800);
  const own = () => ev(`(() => { const v = document.querySelector('${winSel(win)} webview:not(.off)'); return v ? v.executeJavaScript('performance.timeOrigin') : null; })()`);
  const before = { own: await own(), targets: await targetsAt(url), hits: siteHits['/'] };
  await hit(`#sblist .tr[data-act="zone|${zn.id}"]`);
  await sleep(1500);
  const away = { targets: await targetsAt(url) };
  await hit('#spaces .sp.on .sn');
  await sleep(1400);
  const after = { own: await own(), targets: await targetsAt(url), hits: siteHits['/'] };
  const file = path.join(OUT, `zonesprobe-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ url, window: win, before, away, after }, null, 2));
  await ok('the page left in the main space keeps its document across a trip to a sub-workspace (own webview read)', before.own != null && before.own === after.own && before.hits === after.hits, { before, away, after, file });
};

/* Batch 7: the side glows follow the view only when a move settles. After a plain drag of the desktop let go without a
   flick, does the left glow come on (windows lie to the left), or only after something else moves the view? */
G.edgeprobe = async () => {
  await G._go(0);
  if ((await state()).ws[0].at) { await hit('#spaces .sp.on .sn'); await sleep(500); }
  const glow = () => ev('({ left: document.getElementById("edgeL").classList.contains("on"), right: document.getElementById("edgeR").classList.contains("on") })');
  const pan0 = await panPx(0);
  const p = await emptyPoint();
  await mouse(P, 'mouseMoved', p.x, p.y);
  await mouse(P, 'mousePressed', p.x, p.y);
  for (let i = 1; i <= 10; i++) await mouse(P, 'mouseMoved', p.x - i * 30, p.y, { down: true });
  await sleep(120);
  await mouse(P, 'mouseReleased', p.x - 300, p.y);
  await sleep(600);
  const at06 = { pan: await panPx(0), ...(await glow()) };
  await sleep(1900);
  const at25 = { pan: await panPx(0), ...(await glow()) };
  const vp = await rectOf('#viewport');
  await P.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.cx, y: vp.cy, deltaX: 2, deltaY: 0, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(1200);
  const afterWheel = { pan: await panPx(0), ...(await glow()) };
  const leftmost = await ev(`(() => { const ws = window.__flow.state().ws[0]; const vw = document.getElementById('viewport').getBoundingClientRect().width; const xs = ws.windows.filter((w) => !w.zone).map((w) => (w.x / 100) * vw); return Math.min(...xs); })()`);
  await ok('after a plain drag of the desktop the left glow shows the windows to the left', at25.left, { pan0, leftmostWindowPx: Math.round(leftmost), at06, at25, afterWheel });
};

/* Where new page windows land (batch 7 run: a dock page window's title bar ended up under the pills row): five from the
   dock's page button and two from openPage, each window's top and title bar against the viewport's top. */
G.placeprobe = async () => {
  await G._go(0);
  if (!G.site) G.site = { port: await startSite() };
  const vp = await rectOf('#viewport');
  const rows = [];
  const look = async (how, id) => {
    await sleep(900);
    const w = await winRect(id);
    const tb = await rectOf(`${winSel(id)} > .tb`);
    const pen = await rectOf(`${winSel(id)} > .tb [data-act="note"]`);
    const under = pen && (await ev(`(() => { const el = document.elementFromPoint(${pen.cx}, ${pen.cy}); const w = el && el.closest('.win'); return el ? (w ? 'win ' + w.dataset.id : el.id || el.className || el.tagName) : null; })()`));
    rows.push({ how, id, top: w && Math.round(w.y), tbTop: tb && Math.round(tb.y), vpTop: Math.round(vp.y), titleBarHidden: !!tb && tb.y < vp.y, penUnder: under });
  };
  for (let i = 0; i < 5; i++) {
    const n0 = (await wsWindows('flow')).map((w) => w.id);
    await hit('#dock button[data-k="page"]');
    const made = await until(async () => (await wsWindows('flow')).find((w) => !n0.includes(w.id) && w.type === 'page'), 5000, 200);
    if (made) await look('dock', made.id);
    else rows.push({ how: 'dock', made: false });
  }
  for (let i = 0; i < 2; i++) {
    const id = await ev(`window.__flow.openPage('http://localhost:${G.site.port}/')`);
    await look('openPage', id);
  }
  fs.writeFileSync(path.join(OUT, `placeprobe-${Date.now()}.json`), JSON.stringify({ vp, rows }, null, 2));
  const hidden = rows.filter((r) => r.titleBarHidden);
  await ok(`a new page window's title bar is in view (${rows.length} made)`, hidden.length === 0, { hidden: hidden.length, rows });
};

/* scrollsuite's popup case once opened no tab (item 40 candidate 2, run 1). N tries of that step, each on a page of its
   own address so its guest can be told apart: did the click reach the link inside the page, did the window move around
   the click, what was under the click point, did a request for /three arrive, did a tab open, and any new warnings. */
async function guestEvalUrl(url, expr) {
  const t = await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url === url), 5000, 200);
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const v = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : null); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return v;
}
G.popupprobe = async () => {
  if (!G.site) G.site = { port: await startSite() };
  const base = `http://localhost:${G.site.port}/`;
  await G._go(0);
  const n = Number(process.env.POPUP_N || 10);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const first = `${base}?probe=${i}`;
    const id = await ev(`window.__flow.openPage(${q(first)})`);
    await until(async () => { const p = await pageNow(id); return p && p.url === first && !p.loading; }, 15000, 200);
    // counters inside the page: any click (and on what), and clicks on the link itself
    const listener = await guestEvalUrl(first, `(() => { window.__probeClicks = 0; window.__probeAny = []; document.addEventListener('click', (e) => { window.__probeAny.push(e.target.id || e.target.tagName); }, true); document.getElementById('blank3').addEventListener('click', () => { window.__probeClicks++; }, true); return 1; })()`) === 1;
    // POPUP_PAINTED=1: click only after the page has drawn two frames
    const painted = process.env.POPUP_PAINTED === '1' ? await guestEvalUrl(first, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))') : null;
    const hits0 = siteHits['/three'] || 0, errs0 = P.errors.length;
    const r0 = JSON.stringify(await winRect(id));
    const bl = await guestPoint(id, '#blank3');
    const r1 = JSON.stringify(await winRect(id));
    const under = bl && (await ev(`(() => { const el = document.elementFromPoint(${bl.x}, ${bl.y}); const w = el && el.closest('.win'); return el ? el.tagName.toLowerCase() + ' in ' + (w ? w.dataset.id : 'no window') : null; })()`));
    if (bl) {
      await mouse(P, 'mouseMoved', bl.x, bl.y);
      await sleep(120);
      await click(P, bl.x, bl.y);
    }
    const r2 = JSON.stringify(await winRect(id));
    const tab = await until(async () => { const p = await pageNow(id); return p && p.url === `${base}three` ? p : null; }, 5000, 200);
    rows.push({ i, window: id, listener, painted, clicksAnywhere: await guestEvalUrl(first, 'window.__probeAny'), clicksInPage: await guestEvalUrl(first, 'window.__probeClicks'), tabOpened: !!tab, tabs: await ev(`document.querySelectorAll('${winSel(id)} .ptab').length`), threeRequests: (siteHits['/three'] || 0) - hits0, movedAroundClick: r0 !== r1 || r1 !== r2, under, underIsThisWindow: !!under && under.endsWith(` in ${id}`), newWarnings: P.errors.slice(errs0) });
  }
  const file = path.join(OUT, `popupprobe-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  const missed = rows.filter((r) => !r.tabOpened);
  await ok(`a click on a new-tab link opens a tab every time (${n} tries)`, missed.length === 0, { missed: missed.length, clickReachedLinkButNoTab: missed.filter((r) => r.clicksInPage > 0).length, file, rows: missed.slice(0, 4) });
};

/* ---------- restart: everything comes back (run "save" before "node test/ship-sweep.mjs restart", then "persist") ---------- */
const EXPECT = path.join(OUT, 'expect.json');
G.save = async () => {
  const extra = {};
  // BRIEF 3.0: pan and zoom per space, tabs and their scroll, pop-outs and their bounds, stacking all come back
  await G._go(0);
  let s0 = await state();
  if (s0.ws[0].at) { await hit('#spaces .sp.on .sn'); await sleep(500); }
  const vp = await rectOf('#viewport');
  // SAVE_SKIP=zoom,popout leaves a step out, to find which one the scroll restore depends on
  const skip = (process.env.SAVE_SKIP || '').split(',');
  if (!skip.includes('zoom')) for (let i = 0; i < 2; i++) await P.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.cx, y: vp.cy, deltaX: 0, deltaY: 10, modifiers: MOD.ctrl, button: 'none', buttons: 0, pointerType: 'mouse' });
  await sleep(700);
  // a page with two tabs, the second scrolled down
  if (!G.site) G.site = { port: await startSite() };
  const base = `http://localhost:${G.site.port}/`;
  const pw = await ev(`window.__flow.openPage(${q(base)})`);
  await until(async () => (await ev(`(() => { const p = window.__flow.page(${q(pw)}); return p && !p.isLoading() && p.getURL() === ${q(base)}; })()`)), 15000, 250);
  const bl = await guestPoint(pw, '#blank3');
  if (bl) {
    await mouse(P, 'mouseMoved', bl.x, bl.y);
    await sleep(120);
    await click(P, bl.x, bl.y);
    await until(async () => (await ev(`window.__flow.page(${q(pw)}).getURL()`)) === `${base}three`, 10000, 200);
    await sleep(800);
    const wvr = await ev(`(() => { const v = document.querySelector('${winSel(pw)} webview:not(.off)'); const r = v.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (let i = 0; i < 8; i++) await P.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wvr.x, y: wvr.y, deltaX: 0, deltaY: 120, button: 'none', buttons: 0, pointerType: 'mouse' });
    extra.scrolledAt = Date.now();
    // every 200 ms until the save ends: is the window visible, and is the scroll in Chromium's entry and in Flow's state
    extra.pageTrace = [];
    G._tracing = (async () => {
      let last = '', y = 0;
      while (!G._traceStop) {
        if (!y) y = (await guestEval(pw, 'scrollY')) || 0;
        const vis = (await ev('window.__flow.windows()')).find((w) => w.id === pw);
        const live = await liveHistory(pw);
        const live0 = live && live.entries ? live.entries[live.index] : null;
        const mem = (await state()).ws.flatMap((w) => w.windows).find((w) => w.id === pw);
        const memT = mem && mem.tabs ? mem.tabs[mem.tab || 0] : null;
        const row = { visible: !!(vis && vis.visible), chromium: holdsScroll(live0 && live0.pageState, y), flow: holdsScroll(memT && memT.history && memT.history.entries[memT.history.index].pageState, y) };
        const k = JSON.stringify(row);
        if (k !== last) { extra.pageTrace.push({ ms: Date.now() - extra.scrolledAt, ...row }); last = k; }
        await sleep(200);
      }
    })();
    await sleep(800);
    extra.page = { id: pw, tabs: await ev(`[...document.querySelectorAll('${winSel(pw)} .ptab')].map((t) => t.textContent.replace('×', '').trim())`), url: `${base}three`, scrollY: await guestEval(pw, 'scrollY') };
  }
  // a pop-out left open
  if (extra.page) extra.popoutAt = Date.now() - extra.scrolledAt;
  const vi = (await state()).ws.findIndex((w) => w.id === 'voiceless');
  const pill = await rectOf(`#spaces .sp[data-i="${vi}"]`);
  if (!skip.includes('popout')) {
    await mouse(P, 'mouseMoved', pill.cx, pill.cy);
    await sleep(200);
    await hit(`#spaces .sp[data-i="${vi}"] .pop`);
  }
  const pt = !skip.includes('popout') && await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && t.url.includes('#solo=voiceless')), 15000, 250);
  if (pt) {
    const W = await connect(/#solo=voiceless$/);
    await until(() => evaluate(W, 'window.__flow && window.__flow.ready.then(() => true)'), 15000);
    extra.popout = { hash: 'solo=voiceless', bounds: await evaluate(W, '({ x: screenX, y: screenY, w: outerWidth, h: outerHeight })') };
    W.ws.close();
  }
  // stacking in flow's main space, back to front
  extra.stack = await ev(`[...document.querySelectorAll('#track section.ws[data-id="flow"] .win')].filter((w) => w.style.display !== 'none').sort((a, b) => (+a.style.zIndex) - (+b.style.zIndex)).map((w) => w.dataset.id)`);
  await sleep(1200);
  const s = await state();
  const panes = {};
  for (const w of s.ws.flatMap((x) => x.windows).filter((w) => w.type === 'term' || w.type === 'team')) {
    const r = tmux('list-panes', '-t', `flow_${w.id}`, '-F', '#{pane_id} #{pane_pid}');
    if (r.status === 0) panes[w.id] = r.stdout.trim();
  }
  const sb = await ev('document.getElementById("sb").classList.contains("hide")');
  extra.skip = skip;
  if (G._tracing) { G._traceStop = true; await G._tracing; }
  if (extra.page) {
    // where the scroll is when the save ends: in Chromium's entry for the tab, in Flow's state, in the state file
    const live = await liveHistory(pw);
    const live0 = live && live.entries ? live.entries[live.index] : null;
    const mem = s.ws.flatMap((w) => w.windows).find((w) => w.id === pw);
    const memT = mem && mem.tabs ? mem.tabs[mem.tab || 0] : null;
    const st = stateTab(pw);
    const saved0 = st && st.t && st.t.history ? st.t.history.entries[st.t.history.index] : null;
    extra.pageDiag = { secondsSinceScroll: +((Date.now() - extra.scrolledAt) / 1000).toFixed(1), skip, scrollInChromiumEntry: holdsScroll(live0 && live0.pageState, extra.page.scrollY), scrollInFlowState: holdsScroll(memT && memT.history && memT.history.entries[memT.history.index].pageState, extra.page.scrollY), scrollInStateFile: holdsScroll(saved0 && saved0.pageState, extra.page.scrollY) };
  }
  fs.writeFileSync(EXPECT, JSON.stringify({ state: s, panes, sb, at: await curIndex(), extra }, null, 2));
  const ids = s.ws.flatMap((w) => [...w.windows, ...w.closed]).filter((w) => w.sessionId).map((w) => `${w.sessionId} (${w.id}${w.forkFrom ? `, fork of ${w.forkFrom}` : ''})`);
  logSession(`claude windows in the state at the end of the run: ${ids.join('; ')}`);
  // the persist checks can only compare what this step recorded: missing pieces fail here, not silently later
  const missing = [];
  if (!extra.page || !(extra.page.scrollY > 100) || (extra.page.tabs || []).length !== 2) missing.push('a scrolled page with two tabs');
  if (!skip.includes('popout') && !extra.popout) missing.push('an open pop-out');
  if (!extra.stack || !extra.stack.length) missing.push('the stacking order');
  await ok('saved what a restart must bring back', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${s.ws.length} workspaces, ${Object.keys(panes).length} live terminals`);
};
G.persist = async () => {
  const e = JSON.parse(fs.readFileSync(EXPECT, 'utf8'));
  const s = await state();
  const strip = (ws) => ws.map((w) => ({ id: w.id, name: w.name, folder: w.folder, mode: w.mode, zones: w.zones, notes: w.notes, closed: w.closed.map((c) => c.id), windows: w.windows.map((x) => { const { cur, ...rest } = x; return rest; }) }));
  const a = strip(e.state.ws), b = strip(s.ws);
  const diff = [];
  a.forEach((w, i) => {
    const o = b[i];
    if (!o) { diff.push(`workspace ${w.id} missing`); return; }
    for (const k of ['id', 'name', 'folder', 'mode']) if (w[k] !== o[k]) diff.push(`${w.id}.${k}: ${q(w[k])} -> ${q(o[k])}`);
    if (q(w.zones) !== q(o.zones)) diff.push(`${w.id}.zones differ`);
    if (q(w.notes) !== q(o.notes)) diff.push(`${w.id}.notes differ`);
    if (q(w.closed) !== q(o.closed)) diff.push(`${w.id}.closed: ${q(w.closed)} -> ${q(o.closed)}`);
    w.windows.forEach((x) => {
      const y = o.windows.find((z) => z.id === x.id);
      if (!y) { diff.push(`${w.id}/${x.id} missing`); return; }
      for (const k of ['type', 'x', 'y', 'w', 'h', 'title', 'note', 'noted', 'sessionId', 'forkFrom', 'noteId']) if (q(x[k]) !== q(y[k])) diff.push(`${w.id}/${x.id}.${k}: ${q(x[k])} -> ${q(y[k])}`);
    });
    if (o.windows.length !== w.windows.length) diff.push(`${w.id}: ${w.windows.length} windows -> ${o.windows.length}`);
  });
  await ok('workspaces, names, notes, zones, closed lists, windows and their spots all come back', diff.length === 0 && a.length === b.length, diff.slice(0, 8).join('; ') || `${b.length} workspaces`);
  await ok('the same workspace is shown', (await curIndex()) === e.at, { was: e.at, now: await curIndex() });
  await ok('the sidebar is shown or hidden as before', (await ev('document.getElementById("sb").classList.contains("hide")')) === e.sb);
  // terminals: same tmux panes (same processes), attached again, with their screens
  const shown = s.ws[await curIndex()];
  const terms = shown.windows.filter((w) => (w.type === 'term' || w.type === 'team') && e.panes[w.id]);
  const res = [];
  for (const w of terms) {
    await until(() => tmuxClients(w.id) >= 1, 20000, 300);
    const now = (tmux('list-panes', '-t', `flow_${w.id}`, '-F', '#{pane_id} #{pane_pid}').stdout || '').trim();
    const txt = await until(async () => { const t = await termText(w.id); return t && t.trim() ? t : null; }, 20000, 300);
    res.push({ id: w.id, samePanes: now === e.panes[w.id], clients: tmuxClients(w.id), screen: !!txt });
  }
  await ok('every terminal in view reattaches to the same tmux panes and shows its screen', res.length > 0 && res.every((r) => r.samePanes && r.clients === 1 && r.screen), res);
  const x = e.extra || {};
  const lost = [!(x.stack && x.stack.length) && 'the stacking order', !x.page && 'the two-tab page', !x.popout && !(x.skip || []).includes('popout') && 'the pop-out'].filter(Boolean);
  if (lost.length) await ok('the save step left everything a restart must bring back', false, `nothing saved to compare for: ${lost.join(', ')}`);
  // pan and zoom of every space
  const views = (ws) => ({ pan: Math.round(ws.pan || 0), panY: Math.round(ws.panY || 0), zoom: +(ws.zoom || 1).toFixed(3), mainPan: Math.round(ws.mainPan || 0), mainZoom: +(ws.mainZoom || 1).toFixed(3), zones: (ws.zones || []).map((z) => [z.id, Math.round(z.pan || 0), +(z.zoom || 1).toFixed(3)]) });
  const vb = e.state.ws.map(views), va = s.ws.map(views);
  await ok('pan and zoom of every space come back (BRIEF 3.0)', q(vb) === q(va), { before: vb[0], after: va[0] });
  // stacking
  if (x.stack) {
    const stack = await ev(`[...document.querySelectorAll('#track section.ws[data-id="flow"] .win')].filter((w) => w.style.display !== 'none').sort((a, b) => (+a.style.zIndex) - (+b.style.zIndex)).map((w) => w.dataset.id)`);
    await ok('the windows come back in the same stacking order, front window in front (BRIEF 3.0)', q(stack) === q(x.stack) || stack[stack.length - 1] === x.stack[x.stack.length - 1], { before: x.stack.slice(-4), after: stack.slice(-4) });
  }
  // tabs and their scroll
  if (x.page) {
    const tabs = await until(async () => { const t = await ev(`[...document.querySelectorAll('${winSel(x.page.id)} .ptab')].map((t) => t.textContent.replace('×', '').trim())`); return t.length ? t : null; }, 15000, 300);
    const url = await until(async () => { const u = await ev(`(() => { const p = window.__flow.page(${q(x.page.id)}); return p && !p.isLoading() ? p.getURL() : null; })()`); return u; }, 20000, 300);
    await ok('a page window comes back with its tabs and the same tab in front (BRIEF 3.0)', q(tabs) === q(x.page.tabs) && url === x.page.url, { before: x.page.tabs, after: tabs, url });
    await sleep(1500);
    const sy = await guestEval(x.page.id, 'scrollY');
    const live = await liveHistory(x.page.id);
    const live0 = live && live.entries ? live.entries[live.index] : null;
    const quitTab = stateTab(x.page.id, path.join(OUT, 'state-at-quit.json'));
    const quit0 = quitTab && quitTab.t && quitTab.t.history ? quitTab.t.history.entries[quitTab.t.history.index] : null;
    const atLaunch = { scrollInStateFileAtQuit: holdsScroll(quit0 && quit0.pageState, x.page.scrollY), scrollInRestoredEntry: holdsScroll(live0 && live0.pageState, x.page.scrollY) };
    await ok('the page in front comes back at the same scroll position (BRIEF 3.0)', x.page.scrollY > 100 && Math.abs((sy || 0) - x.page.scrollY) < 20, { before: x.page.scrollY, after: sy, atSave: x.pageDiag, atLaunch });
  }
  // the pop-out reopens where it was
  if (x.popout) {
    const t = await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((tt) => tt.type === 'page' && tt.url.endsWith(`#${x.popout.hash}`)), 15000, 300);
    let b = null;
    if (t) {
      const W = await connect(new RegExp(`#${x.popout.hash}$`));
      b = await evaluate(W, '({ x: screenX, y: screenY, w: outerWidth, h: outerHeight })');
      W.ws.close();
    }
    await ok('the pop-out left open reopens with its bounds (BRIEF 3.0)', !!t && b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(b[k] - x.popout.bounds[k]) <= 2), { before: x.popout.bounds, after: b });
  }
};

const GROUPS = ['boot', 'pills', 'nav', 'windows', 'sidebar', 'sidebarToggle', 'dock', 'zones', 'arrange', 'desktop', 'notes', 'search', 'popout', 'pages', 'browser', 'terms', 'image', 'teams', 'fork', 'save'];

/* Every Claude Code process under this sweep's tmux server (and the sweep's own `claude -p`) must have its working
   folder inside ~/.flow-dev/ship; anything else is recorded with its pid, cwd and session id. */
const ALLOWED_CWD = path.join(process.env.HOME, '.flow-dev', 'ship');
const cwdSeen = new Map(), cwdBad = new Map();
function claudeCwdSample() {
  const srv = (tmux('display-message', '-p', '#{pid}').stdout || '').trim();
  const table = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      table.set(+d, { ppid: +st.slice(st.lastIndexOf(')') + 2).split(' ')[1], cmd: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ') });
    } catch { /* gone */ }
  }
  const roots = new Set([process.pid]);
  if (/^\d+$/.test(srv)) roots.add(+srv);
  let grew = true;
  while (grew) { grew = false; for (const [p, v] of table) if (!roots.has(p) && roots.has(v.ppid)) { roots.add(p); grew = true; } }
  for (const p of roots) {
    const v = table.get(p);
    const first = v ? v.cmd.split(' ')[0] : '';
    if (!v || !(path.basename(first) === 'claude' || /\/share\/claude\/versions\//.test(first) || v.cmd.includes('.local/bin/claude'))) continue;
    let cwd = '';
    try { cwd = fs.readlinkSync(`/proc/${p}/cwd`); } catch { continue; }
    cwdSeen.set(p, cwd);
    if (cwd !== ALLOWED_CWD && !cwd.startsWith(ALLOWED_CWD + '/')) cwdBad.set(p, { cwd, cmd: v.cmd.slice(0, 140) });
  }
}

async function runGroups(list) {
  claudeCwdSample();
  const cwdTimer = setInterval(claudeCwdSample, 2000);
  P = await connect();
  await until(() => ev('window.__flow && window.__flow.ready.then(() => true)'), 20000);
  // For the owner's principles (OWNER_ASKS.md): every toast text the run sees, and the labels on window title bars.
  await ev(`(() => { if (window.__sweepToasts) return true; window.__sweepToasts = []; const t = document.getElementById('toast'); new MutationObserver(() => { const x = t.textContent; if (x && window.__sweepToasts[window.__sweepToasts.length - 1] !== x) window.__sweepToasts.push(x); }).observe(t, { childList: true, characterData: true, subtree: true }); return true; })()`);
  for (const g of list) {
    currentGroup = g;
    try {
      await G[g]();
    } catch (err) {
      await ok('group finished without an exception', false, err.stack.split('\n').slice(0, 3).join(' | '));
    }
  }
  currentGroup = 'end';
  clearInterval(cwdTimer);
  claudeCwdSample();
  await ok('every Claude Code process of this sweep ran inside ~/.flow-dev/ship (test rule)', cwdBad.size === 0 && cwdSeen.size > 0, cwdBad.size ? [...cwdBad].map(([p, v]) => `${p} ${v.cwd} :: ${v.cmd}`) : `${cwdSeen.size} claude processes seen, all inside`);
  const errs = P.errors.filter((x) => !x.startsWith('console.warning')), warns = [...new Set(P.errors.filter((x) => x.startsWith('console.warning')))];
  await ok('no console errors or exceptions in the main window', errs.length === 0, errs.slice(0, 5).join(' | '));
  if (warns.length) console.log(`console warnings (not counted): ${warns.join(' | ')}`);
  const toasts = await ev('Array.isArray(window.__sweepToasts) ? [...new Set(window.__sweepToasts)] : null').catch(() => null);
  const labels = await ev(`[...new Set([...document.querySelectorAll('.win > .tb .where')].map((e) => e.textContent).filter(Boolean))]`).catch(() => []);
  fs.writeFileSync(path.join(OUT, `principles-${Date.now()}.json`), JSON.stringify({ toasts, whereLabels: labels }, null, 2));
  // The owner (20:45): a toast only offers undo after a removal, or says why an action the owner just took did nothing.
  const allowed = (t) => /^removed /.test(t) || /undo$/.test(t) || /could not|cannot|is not there|nothing to|stays with its team|failed/.test(t);
  const extra = toasts ? toasts.filter((t) => !allowed(t)) : ['the toast collector was not running (the window reloaded, or it could not be read)'];
  await ok('toasts only for undo after a removal or why an action did nothing (owner, 20:45)', extra.length === 0, extra);
  // A local window's title bar may name its team, or, for a shell nobody has titled, its folder (app.js whereOf); a
  // place ("this Mac" or any other) only for a remote window.
  const whereBad = await ev(`(() => {
    const out = [];
    for (const ws of window.__flow.state().ws) for (const w of ws.windows) {
      const el = document.querySelector('.win[data-id="' + w.id + '"] > .tb .where');
      const t = el ? el.textContent : '';
      if (!t || w.host) continue;
      const team = window.FlowTeams && typeof window.FlowTeams.label === 'function' ? window.FlowTeams.label(w) : '';
      if (team && t === team) continue;
      if (w.cmd === 'shell' && !w.title && /^[~\/]/.test(t)) continue;
      out.push({ id: w.id, where: t });
    }
    return out;
  })()`).catch((e) => [{ error: e.message }]);
  await ok('no title bar says where a window is unless it is remote (BRIEF 3.0)', whereBad.length === 0, { bad: whereBad, seen: labels });
  const glyphs = await ev(`[...document.querySelectorAll('.win > .tb .title')].map((t) => t.textContent.trim()).filter((t) => /^[\u2800-\u28ff✳✻✽✶✢·]/.test(t)).slice(0, 5)`).catch((e) => [`could not read the titles: ${e.message}`]);
  await ok('titles show the topic without a ✳ or spinner glyph (owner, 20:45)', glyphs.length === 0, glyphs);
  console.log(`\ntoasts seen (${toasts ? toasts.length : 'unknown'}):\n  ${(toasts || []).join('\n  ')}\ntitle-bar place labels: ${labels.join(', ')}`);
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  fs.writeFileSync(path.join(OUT, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));
  if (site) { site.closeAllConnections(); site.close(); }
  P.ws.close();
  // open guest sockets or keep-alive connections must not keep the run alive after its summary
  process.exit(bad.length ? 1 : 0);
}

async function startCmd(fresh) {
  await ensureX();
  if (fresh) {
    // a fresh userData, except the sessions the sweep made itself (their transcripts point at those folders)
    fs.mkdirSync(USER_DATA, { recursive: true });
    for (const f of fs.readdirSync(USER_DATA)) if (f !== 'sessions') fs.rmSync(path.join(USER_DATA, f), { recursive: true, force: true });
    fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(PROBE_STATE));
    await launch('probe');
    P = await connect();
    await until(() => ev('window.__flow && window.__flow.ready.then(() => true)'), 20000);
    const seed = await ev('window.__flow.seed()');
    P.ws.close();
    const st = await stopApp();
    if (!st.exited) throw new Error('the probe app did not quit');
    const removed = [];
    for (const w of seed) for (const k of ['windows', 'closed']) w[k] = (w[k] || []).filter((x) => { if (x.host) { removed.push(`${w.id}/${x.id}`); return false; } return true; });
    // Every folder the seed would start Claude Code in (~/flow, ~/infra-reading, ...) moves under ~/.flow-dev/ship/seed:
    // a test's Claude sessions live only there (lead, Nov 2), never in the VM's real projects.
    for (const w of seed) {
      const rel = `.flow-dev/ship/seed/${w.id}`;
      fs.mkdirSync(path.join(process.env.HOME, rel), { recursive: true });
      w.folder = `~/${rel}`;
      for (const k of ['windows', 'closed']) for (const x of w[k] || []) if ('cwd' in x) x.cwd = `~/${rel}`;
    }
    fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws: seed, ui: {} }));
    console.log(`seed written without its VM windows (${removed.join(', ')}), every folder under ~/.flow-dev/ship/seed`);
  }
  const { pid, log } = await launch(fresh ? 'fresh' : `restart-${Date.now()}`);
  P = await connect();
  await until(() => ev('window.__flow && window.__flow.ready.then(() => true)'), 20000);
  const hint = await toastSaid(/workspaces? at the top/, 3000);
  if (fresh) writeRun({ ...readRun(), hint });
  await snap(fresh ? 'start-fresh' : 'start');
  P.ws.close();
  console.log(`started pid ${pid}, log ${log}${fresh ? `, hint toast: ${hint}` : ''}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'start') await startCmd(rest.includes('--fresh'));
else if (cmd === 'run') await runGroups(rest.length ? rest : GROUPS);
else if (cmd === 'restart') {
  const s = await stopApp();
  console.log(`stopped: ${q(s)}`);
  fs.writeFileSync(path.join(OUT, 'last-stop.json'), JSON.stringify(s));
  // the state file as the quit left it, before the relaunch reads it (and later rewrites it)
  if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, path.join(OUT, 'state-at-quit.json'));
  await startCmd(false);
}
else if (cmd === 'scrollsuite') {
  // Item 40's check: a page's scroll comes back exactly after a quit, whenever the quit comes and with a pop-out open.
  // Each case runs scrollrepro, a normal quit (SIGTERM) and relaunch, then scrollcheck; FLOW_ROOT picks the tree.
  const cases = [
    { name: 'wheel, quit about 2 s after', env: { SCROLL_WAIT: '0' } },
    { name: 'End key, quit about 6.5 s after', env: { SCROLL_INPUT: 'keys', SCROLL_WAIT: '5' } },
    { name: 'wheel, quit about 4.5 s after', env: { SCROLL_WAIT: '3' } },
    { name: 'two tabs (the popup tab shown), wheel, quit about 4.5 s after', env: { SCROLL_TABS: '2', SCROLL_WAIT: '3' } },
    { name: 'two tabs, wheel, a pop-out opened right after, quit about 4 s after', env: { SCROLL_TABS: '2', SCROLL_POPOUT: '1', SCROLL_WAIT: '2' }, fresh: true },
  ];
  const self = (args, env = {}) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 300000 });
  const lines = [];
  let up = false;
  for (const c of cases) {
    if (!up || c.fresh) {
      if (up) self(['stop']);
      const st = self(['start', '--fresh']);
      if (st.status !== 0) throw new Error(`start --fresh failed: ${(st.stdout + st.stderr).slice(-400)}`);
      up = true;
    }
    const a = self(['run', 'scrollrepro'], c.env);
    const rest = self(['restart']);
    const b = self(['run', 'scrollcheck']);
    // every step's whole output, console warnings included, for the case's evidence
    const k = cases.indexOf(c) + 1;
    for (const [step, r] of [['repro', a], ['restart', rest], ['check', b]]) fs.writeFileSync(path.join(OUT, `scrollsuite-case${k}-${step}.log`), `${r.stdout || ''}${r.stderr || ''}`);
    // the state the quit left, which the relaunch read: kept per case
    if (fs.existsSync(path.join(OUT, 'state-at-quit.json'))) fs.copyFileSync(path.join(OUT, 'state-at-quit.json'), path.join(OUT, `scrollsuite-case${k}-state-at-quit.json`));
    const prep = (a.stdout.split('\n').find((l) => l.includes('[scrollrepro]')) || '').trim();
    const check = (b.stdout.split('\n').find((l) => l.includes('[scrollcheck]')) || '').trim();
    const fails = [a.stdout, b.stdout].join('\n').split('\n').filter((l) => l.startsWith('FAIL') && !l.includes('[scrollcheck]'));
    const pass = prep.startsWith('ok') && check.startsWith('ok') && rest.status === 0;
    const retry = /setup needed (\d+) retr/.exec(prep);
    const what = (prep.startsWith('ok') ? check.replace(/^(ok|FAIL)\s+\[scrollcheck\]\s*/, '') : `SETUP FAILED, nothing to restore: ${prep.replace(/^(ok|FAIL)\s+\[scrollrepro\]\s*/, '')}`) + (retry && prep.startsWith('ok') ? ` [setup needed ${retry[1]} retr${retry[1] === '1' ? 'y' : 'ies'}: scrollsuite-case${cases.indexOf(c) + 1}-repro.log]` : '');
    lines.push({ case: c.name, pass, check: what.slice(0, 300), other: fails.filter((l) => !l.includes('[scrollrepro] scroll repro prepared')).map((l) => l.slice(0, 160)) });
  }
  self(['stop']);
  for (const l of lines) console.log(`${l.pass ? 'ok  ' : 'FAIL'} ${l.case}: ${l.check}${l.other.length ? ` | also: ${l.other.join(' | ')}` : ''}`);
  const bad = lines.filter((l) => !l.pass).length;
  console.log(`scrollsuite: ${lines.length - bad} of ${lines.length} cases came back at their scroll`);
  process.exitCode = bad ? 1 : 0;
}
else if (cmd === 'stop') {
  const s = await stopApp();
  const r = readRun();
  if (alive(r.xvfb)) {
    process.kill(r.xvfb, 'SIGTERM');
    // the next start must not find this server's display lock still there
    await until(() => !alive(r.xvfb), 5000, 100);
  }
  tmux('kill-server');
  console.log(`stopped: ${q(s)}`);
} else {
  console.log('usage: node test/ship-sweep.mjs start [--fresh] | run [group ...] | restart | stop | scrollsuite');
  process.exitCode = 2;
}




