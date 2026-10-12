// flows' helpers: start and stop flows' own isolated Flow (port 9570, socket flow-dev-flows, userData /tmp/flow-dev-flows),
// and drive it with real input over CDP (ui-lib's events). Node 22+.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connectTo, evaluate, mouse, click, dblclick, drag, key, type, wheel, swipe, rect, MOD, sleep } from './ui-lib.mjs';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// The app that runs: ~/flow, or a copy of the tree given in FLOWS_APP (its node_modules may be a link to ~/flow's).
export const APP = process.env.FLOWS_APP ? path.resolve(process.env.FLOWS_APP) : ROOT;
export const PORT = 9570;
export const SOCKET = 'flow-dev-flows';
export const UD = '/tmp/flow-dev-flows';
// under the home folder: /tmp is emptied at every reboot of this VM (MAC_NOTES 16)
export const EVID = path.join(os.homedir(), 'flow-evidence', 'flows');
export const SHOTS = path.join(EVID, 'shots');
// Claude sessions live here: trusted through /home/claude, so Claude starts without its folder trust question.
export const WORK = '/home/claude/.flow-dev/flows';
fs.mkdirSync(SHOTS, { recursive: true });

export function tmux(...args) {
  const r = spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
  return (r.stdout || '') + (r.status ? (r.stderr || '') : '');
}

export function running() {
  const r = spawnSync('pgrep', ['-f', '[e]lectron/dist/electron .*--flow-dev=flows'], { encoding: 'utf8' });
  return (r.stdout || '').trim().split('\n').filter(Boolean).map(Number);
}

export async function targets() { // page targets of flows app
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

// Starts the app (userData UD unless given) and resolves when the main window's page target is up.
export async function launch(label, userData = UD) {
  if (running().length) throw new Error(`flows' app already runs: ${running().join(' ')}`);
  const log = path.join(EVID, `app-${label}.log`);
  const fd = fs.openSync(log, 'a');
  const env = { ...process.env, FLOW_USER_DATA: userData, FLOW_TMUX_SOCKET: SOCKET, FLOW_CDP_PORT: String(PORT), FLOW_BACKGROUND: '1' };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'TMUX', 'TMUX_PANE']) delete env[k];
  const t0 = Date.now();
  const p = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', './node_modules/.bin/electron', '.', '--no-sandbox', '--flow-dev=flows'],
    { cwd: APP, env, stdio: ['ignore', fd, fd], detached: true });
  p.unref();
  fs.closeSync(fd);
  for (let i = 0; i < 240; i++) {
    try {
      const list = await targets();
      if (list.some((x) => x.type === 'page' && /\/src\/index\.html$/.test(x.url))) return { ms: Date.now() - t0, log };
    } catch (e) { /* not listening yet */ }
    await sleep(250);
  }
  throw new Error(`no Flow window on ${PORT} after 60 s; log ${log}`);
}

// A graceful quit (SIGTERM to the main process: Electron quits through will-quit). kill9 simulates a crash.
export async function stop({ kill9 = false, timeout = 20000 } = {}) {
  const pids = running();
  if (!pids.length) return 'not running';
  spawnSync('kill', [kill9 ? '-9' : '-TERM', ...pids.map(String)]);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!running().length) return `stopped ${pids.join(' ')}${kill9 ? ' (SIGKILL)' : ''}`;
    await sleep(200);
  }
  spawnSync('kill', ['-9', ...running().map(String)]);
  return `had to SIGKILL ${pids.join(' ')} after ${timeout} ms`;
}

export async function connect(match = /\/src\/index\.html$/) {
  const page = await connectTo(PORT, match);
  await page.send('Page.enable');
  return page;
}

export async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}

export const ev = evaluate;
export { mouse, click, dblclick, drag, key, type, wheel, swipe, rect, MOD, sleep };

// In the page: a space's pan in px whatever unit the state keeps it in (nav's item 44 makes it % of the view, marked by
// ws.panUnit === '%'). Use as `${PANPX}(ws, zoneOrNull, 'x' | 'y')` inside an evaluated expression.
export const PANPX = `((ws, o, axis) => { const v = document.getElementById('viewport').getBoundingClientRect(), p = (o || ws)[axis === 'y' ? 'panY' : 'pan'] || 0; return ws.panUnit === '%' ? (p / 100) * (axis === 'y' ? v.height : v.width) : p; })`;

// The main space of the workspace shown: its windows and the view, in the space's % units. For the rule on a window
// opened with no spot given (lead, batch 6, STATUS.md "the opened-window rule"): a free spot in view if one fits, else
// just past the space's last window at the top with the view following; it covers nothing and moves nothing.
export const SPACE = `(() => { const st = window.__flow.state(), ws = st.ws.find((w) => w.id === st.ui.at), v = document.getElementById('viewport').getBoundingClientRect(), P = ${PANPX}; return { at: ws.at || null, view: { left: P(ws, null, 'x') / v.width * 100, top: P(ws, null, 'y') / v.height * 100, vw: v.width, vh: v.height }, wins: ws.windows.filter((w) => !w.zone).map((w) => ({ id: w.id, x: +w.x, y: +w.y, w: +w.w, h: +w.h })) }; })()`;

// An open area of w x h inside the view of a SPACE reading, looked for with wider gaps and margins than Flow's own, so
// one found here is one Flow had as well; null if none.
export function roomIn(s, w, h) {
  const v = s.view, gx = 1.8, gy = 2.4, m = 0.6;
  const x0 = Math.max(1.2, v.left + 1.2) + m, x1 = v.left + 100 - 1.2 - m;
  const y0 = Math.max(6.6, v.top + 6.6) + m, y1 = v.top + 100 - Math.max(1.2, (12 / v.vh) * 100) - m;
  for (let y = y0; y + h <= y1; y += 0.25) for (let x = x0; x + w <= x1; x += 0.25) if (!s.wins.some((o) => x < o.x + o.w + gx && o.x < x + w + gx && y < o.y + o.h + gy && o.y < y + h + gy)) return { x: +x.toFixed(1), y: +y.toFixed(1) };
  return null;
}

// Where window id went by that rule, from SPACE readings before and after it opened; w x h is the least room it takes
// in view (its own size, or the dock's smallest window, 300 x 160 px). The view follows a window the owner opens past
// the last window; one an agent opens (a teammate) never moves the view (lead, Nov 2 13:5x): byAgent.
export function opened(id, before, after, w, h, { byAgent = false } = {}) {
  const me = after.wins.find((o) => o.id === id);
  if (!me) return { ok: false, notInTheMainSpace: id };
  const ov = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const v = before.view, a = after.view;
  const covers = after.wins.filter((o) => o.id !== id && ov(o, me) > 0.01).map((o) => o.id);
  const moved = before.wins.filter((o) => { const n = after.wins.find((x) => x.id === o.id); return n && ['x', 'y', 'w', 'h'].some((k) => Math.abs(n[k] - o[k]) > 0.05); }).map((o) => o.id);
  const inView = me.x >= v.left - 0.5 && me.x + me.w <= v.left + 100.5 && me.y >= v.top - 0.5 && me.y + me.h <= v.top + 100.5;
  const atEnd = Math.abs(me.x - (Math.max(0, ...before.wins.map((o) => o.x + o.w)) + 1.5)) < 0.6 && Math.abs(me.y - 6.6) < 0.6;
  const shownAfter = +(ov(me, { x: a.left, y: a.top, w: 100, h: 100 }) / (me.w * me.h)).toFixed(2);
  const room = inView ? null : roomIn(before, w, h);
  const viewStayed = Math.abs(a.left - v.left) < 0.5 && Math.abs(a.top - v.top) < 0.5;
  const r1 = (o) => ({ x: +o.x.toFixed(1), y: +o.y.toFixed(1), w: +o.w.toFixed(1), h: +o.h.toFixed(1) });
  const placed = inView || (atEnd && !room && (byAgent || shownAfter > 0.95));
  return { ok: covers.length === 0 && moved.length === 0 && placed && (!byAgent || viewStayed), at: r1(me), viewLeft: +v.left.toFixed(1), inView, atEnd, roomInView: room, shownAfter, viewStayed, covers, moved };
}

// A click the way a hand makes one: point at the element, let hover settle (a hovered pill shows its ⤢, which moves
// the pills after it and +), then click where the element is now.
export async function pointClick(page, selector) {
  let r = await rect(page, selector);
  if (!r) throw new Error(`no ${selector}`);
  await mouse(page, 'mouseMoved', r.cx, r.cy);
  await sleep(300);
  r = await rect(page, selector);
  await click(page, r.cx, r.cy);
  return r;
}

// Waits until fn() (an expression evaluated in the page) is truthy; returns its value and the ms it took.
export async function until(page, expr, ms = 15000, every = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await evaluate(page, expr); } catch (e) { last = e; }
    if (last && !(last instanceof Error)) return { v: last, ms: Date.now() - t0 };
    await sleep(every);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${expr.slice(0, 160)}${last instanceof Error ? ` (${last.message})` : ''}`);
}




