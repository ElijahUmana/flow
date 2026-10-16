// Small CDP helpers for main's full-app checks (Node 22 global WebSocket). Used by test/main-app-cdp.mjs.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const PORT = 9561;          // renderer CDP (FLOW_CDP_PORT)
export const INSPECT = 9661;       // main process inspector
export const SOCKET = 'flow-dev-main';
export const USER_DATA = '/tmp/flow-dev-main';
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

export async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

export class Cdp {
  static async connect(wsUrl) {
    const c = new Cdp();
    c.ws = new WebSocket(wsUrl);
    c.next = 0;
    c.pending = new Map();
    c.listeners = [];
    await new Promise((resolve, reject) => {
      c.ws.onopen = resolve;
      c.ws.onerror = () => reject(new Error(`cannot open ${wsUrl}`));
    });
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject, method } = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolve(m.result);
      } else if (m.method) {
        for (const l of c.listeners) l(m);
      }
    };
    c.ws.onclose = () => {
      for (const { reject, method } of c.pending.values()) reject(new Error(`${method}: connection closed`));
      c.pending.clear();
    };
    return c;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  // Evaluates an async function body; returns its value.
  async eval(body, { timeout = 30000, gesture = false, commandLine = false } = {}) {
    const run = this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true,
      userGesture: gesture, includeCommandLineAPI: commandLine,
    });
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`evaluation timed out after ${timeout} ms`)), timeout); });
    try {
      const r = await Promise.race([run, limit]);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text);
      }
      return r.result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    this.ws.close();
  }
}

// Launches the real app per the lead's dev command (own socket, userData, port and marker) plus a main-process inspector.
// extraEnv: more variables for the app (FLOW_* from this process never reach it); extraArgs: more Chromium switches.
export function launch(logFile, extraEnv = {}, extraArgs = []) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const out = fs.openSync(logFile, 'a');
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${USER_DATA}`,
    `FLOW_TMUX_SOCKET=${SOCKET}`, `FLOW_CDP_PORT=${PORT}`, ...Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`),
    './node_modules/.bin/electron', `--inspect=${INSPECT}`, '.',
    '--no-sandbox', ...extraArgs, '--flow-dev=main'], { cwd: ROOT, env, stdio: ['ignore', out, out], detached: true });
  child.unref();
  return child;
}

export function electronPids() {
  try {
    return execFileSync('pgrep', ['-f', '[e]lectron/dist/electron .*--flow-dev=main'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

export async function pageTarget(filter = (t) => t.type === 'page' && /\/src\/index\.html$/.test(t.url)) {
  return waitFor(async () => (await targets(PORT)).find(filter), 40000, 'the Flow window target');
}

export async function mainProcess() {
  const t = await waitFor(async () => (await targets(INSPECT))[0], 30000, 'the main-process inspector');
  return Cdp.connect(t.webSocketDebuggerUrl);
}

export function tmux(...args) {
  return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
}

// Connects to the Flow window and waits until app.js has finished init (window.__flow.ready).
export async function flowPage(filter) {
  const t = await pageTarget(filter);
  const page = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => page.eval('return !!(window.__flow && window.__flow.ready);'), 40000, 'window.__flow');
  await page.eval('await window.__flow.ready; return true;', { timeout: 60000 });
  page.target = t;
  return page;
}




