// zoom's helpers: launch zoom's own isolated Flow (socket flow-dev-zoom, userData /tmp/flow-dev-zoom, CDP 9579, main
// inspector 9679, marker --flow-dev=zoom) and drive it with real input over CDP. Node 22+ (global WebSocket).
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const PORT = 9579;
export const INSPECT = 9679;
export const SOCKET = 'flow-dev-zoom';
export const USER_DATA = '/tmp/flow-dev-zoom';
export const WORK = '/tmp/flow-dev-zoom/work';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

export class Cdp {
  static async connect(url) {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    c.seq = 0;
    c.pending = new Map();
    c.listeners = [];
    c.errors = [];
    await new Promise((resolve, reject) => { c.ws.onopen = resolve; c.ws.onerror = () => reject(new Error(`cannot open ${url}`)); });
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(`${p.what}: ${m.error.message} ${m.error.data || ''}`));
        else p.resolve(m.result);
      } else if (m.method) c.listeners.forEach((f) => f(m));
    };
    c.ws.onclose = () => { for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${p.what}: connection closed`)); } c.pending.clear(); };
    return c;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const what = params.type ? `${method} ${params.type}` : method;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${what} got no answer in 30 s`)); }, 30000);
      this.pending.set(id, { resolve, reject, what, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(f) { this.listeners.push(f); }
  async eval(expression, commandLine = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: commandLine });
    if (r.exceptionDetails) throw new Error(`eval: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}\n  in: ${expression.slice(0, 160)}`);
    return r.result.value;
  }
  close() { this.ws.close(); }
}

export async function targets(port = PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

/* The Flow window, ready (window.__flow.ready resolved), with console errors and exceptions collected. */
export async function flowWindow(match = /\/src\/index\.html/) {
  const t = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && match.test(x.url)), 45000, 'the Flow window');
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  c.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') c.errors.push(`exception: ${m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) c.errors.push(`console.${m.params.type}: ${m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ')}`);
  });
  await c.send('Runtime.enable');
  await waitFor(() => c.eval('!!(window.__flow && window.__flow.ready)'), 45000, 'window.__flow');
  await c.eval('window.__flow.ready.then(() => true)');
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return c;
}

export async function mainProcess() {
  const t = await waitFor(async () => (await targets(INSPECT))[0], 30000, 'the main-process inspector');
  return Cdp.connect(t.webSocketDebuggerUrl);
}

/* The lead's dev command for zoom, plus a main-process inspector. entry: FLOW_ENTRY (repo-relative), for harness pages. */
export function launch({ entry, log = path.join(USER_DATA, 'main.log') } = {}) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const out = fs.openSync(log, 'a');
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${USER_DATA}`,
    `FLOW_TMUX_SOCKET=${SOCKET}`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1', ...(entry ? [`FLOW_ENTRY=${entry}`] : []),
    './node_modules/.bin/electron', `--inspect=${INSPECT}`, '.', '--no-sandbox', '--flow-dev=zoom'],
  { cwd: ROOT, env, stdio: ['ignore', out, out], detached: true });
  child.unref();
  return child;
}

/* Exactly zoom's app: the marker ends there, so nothing else is ever matched. */
const MINE = '[e]lectron/dist/electron .*--flow-dev=zoom( |$)';
export function running() {
  return spawnSync('pgrep', ['-f', MINE]).status === 0;
}

/* Stops zoom's app and, unless keepTmux (a quit rather than a reboot), its tmux server; nothing else. */
export async function stop({ keepTmux = false } = {}) {
  spawnSync('pkill', ['-f', MINE]);
  const gone = await waitFor(() => !running(), 15000, 'zoom\'s app to exit').then(() => true, () => false);
  if (!gone) spawnSync('pkill', ['-9', '-f', MINE]);
  if (!keepTmux) spawnSync('tmux', ['-L', SOCKET, 'kill-server']);
}

export function tmux(...args) {
  return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
}

/* The seed as app.js makes it, read from a probe app whose state is one empty workspace (nothing opens), then made
   safe for this VM as scripts/e2e.mjs does: every window with a host is dropped. Also: terminals become shells and
   every folder is under /tmp/flow-dev-zoom/work, so no claude runs and nothing starts in a real project. */
export async function writeSeed() {
  await stop();
  fs.mkdirSync(USER_DATA, { recursive: true });
  const probe = { v: 11, ws: [{ id: 'zoom-probe', name: 'zoom probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(probe));
  launch();
  let seed;
  try {
    const c = await flowWindow(/\/src\/index\.html/);
    seed = await c.eval('window.__flow.seed()');
    c.close();
  } finally {
    await stop();
  }
  const removed = [];
  for (const ws of seed) {
    ws.folder = `${WORK}/${ws.id}`;
    fs.mkdirSync(ws.folder, { recursive: true });
    for (const k of ['windows', 'closed']) {
      ws[k] = (ws[k] || []).filter((w) => { if (w.host) { removed.push(`${ws.id}/${w.id}`); return false; } return true; });
      for (const w of ws[k]) if (w.type === 'term' || w.type === 'team') { w.cmd = 'shell'; delete w.sessionId; w.cwd = ws.folder; }
    }
  }
  const doc = { v: 11, ws: seed, ui: { hinted: true } };
  fs.writeFileSync(path.join(USER_DATA, 'seed.json'), JSON.stringify(doc));
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(doc));
  return { removed, doc };
}

/* Back to the safe seed from writeSeed() (the app must not be running). */
export function resetState() {
  const seed = path.join(USER_DATA, 'seed.json');
  if (!fs.existsSync(seed)) throw new Error(`${seed} is missing: run writeSeed() first`);
  if (running()) throw new Error('zoom\'s app is running; stop it before resetting its state');
  fs.copyFileSync(seed, path.join(USER_DATA, 'flow-state.json'));
}

/* ---------- input ---------- */
export async function mouse(c, type, x, y, o = {}) {
  await c.send('Input.dispatchMouseEvent', {
    type, x, y, button: o.button || (type === 'mouseMoved' && !o.down ? 'none' : 'left'),
    buttons: type === 'mousePressed' || o.down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse',
    ...(o.at != null ? { timestamp: o.at / 1000 } : {}),
  });
}
/* A press, moves stamped gapMs apart along dxs (px per move), and a release holdMs after the last move. */
export async function drag(c, x, y, dxs, { gapMs = 16, holdMs = 0, dy = 0 } = {}) {
  const t0 = Date.now();
  await mouse(c, 'mouseMoved', x, y);
  await mouse(c, 'mousePressed', x, y, { at: t0 });
  let cx = x, t = t0;
  for (const d of dxs) {
    cx += d;
    t += gapMs;
    await mouse(c, 'mouseMoved', cx, y + dy, { down: true, at: t });
  }
  t += holdMs;
  if (holdMs) await sleep(holdMs);
  await mouse(c, 'mouseReleased', cx, y + dy, { at: t });
  return cx;
}
/* at: epoch ms, as a trackpad stamps the event. */
export async function wheel(c, x, y, deltaX, deltaY = 0, at) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0, pointerType: 'mouse', ...(at != null ? { timestamp: at / 1000 } : {}) });
}
/* A trackpad-like swipe: events stamped gapMs apart, sent without waiting for the app (a trackpad does not wait). */
export async function swipe(c, x, y, dxs, { gapMs = 16, dys } = {}) {
  const t0 = Date.now();
  await Promise.all(dxs.map((dx, i) => sleep(i * gapMs).then(() => wheel(c, x, y, dx, dys ? dys[i] : 0, t0 + i * gapMs))));
}
export async function shot(c, file) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}




