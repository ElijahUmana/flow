// orch's helpers: launch and stop orch's own isolated Flow (socket flow-dev-orch, userData /tmp/flow-dev-orch,
// CDP 9569) and drive it with real input through test/ui-lib.mjs. Never touches another socket or userData.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep } from './ui-lib.mjs';

// ORCH_ROOT: run the app from another tree (a clone) while these test files stay outside it.
export const ROOT = path.resolve(process.env.ORCH_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
export const PORT = 9569;
export const SOCKET = 'flow-dev-orch';
export const USER_DATA = '/tmp/flow-dev-orch';
export const WORK = '/home/claude/.flow-dev/orch/work';
export const SHOTS = '/tmp/flow-dev-orch/shots';
const MARK = '[e]lectron/dist/electron .*--flow-dev=orch';

export function pids() {
  const r = spawnSync('pgrep', ['-f', MARK], { encoding: 'utf8' });
  return (r.stdout || '').trim().split('\n').filter(Boolean).map(Number);
}

// The Electron main process: the one without a --type= switch.
export function mainPid() {
  const r = spawnSync('pgrep', ['-af', MARK], { encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').find((l) => l && !/--type=/.test(l));
  return line ? Number(line.split(' ')[0]) : null;
}

export function launch(log = path.join(USER_DATA, 'main.log'), extraArgs = []) {
  if (pids().length) throw new Error(`orch's Flow is already running: ${pids().join(' ')}`);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_|TMUX)/.test(k)) delete env[k];
  fs.mkdirSync(USER_DATA, { recursive: true });
  const out = fs.openSync(log, 'a');
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${USER_DATA}`,
    `FLOW_TMUX_SOCKET=${SOCKET}`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1', './node_modules/.bin/electron', ...extraArgs, '.',
    '--no-sandbox', '--flow-dev=orch'], { cwd: ROOT, env, stdio: ['ignore', out, out], detached: true });
  child.unref();
  fs.closeSync(out);
  return child;
}

// A normal quit (SIGTERM to the main process, the way e2e quits), then waits for every orch process to exit.
export async function quit(ms = 20000) {
  const pid = mainPid();
  if (pid) process.kill(pid, 'SIGTERM');
  const end = Date.now() + ms;
  while (Date.now() < end && pids().length) await sleep(200);
  return pids().length === 0;
}

export async function stop() {
  if (!(await quit(15000))) spawnSync('pkill', ['-KILL', '-f', MARK]);
  await sleep(300);
}

export function killTmux() {
  spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { encoding: 'utf8' });
}

export function tmux(...args) {
  return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
}

export function tmuxTry(...args) {
  const r = spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// The main Flow window (or one whose url matches `match`), once app.js has finished init.
export async function connect(match = /\/src\/index\.html(#?)$/) {
  const page = await connectTo(PORT, match);
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      if (await evaluate(page, '!!(window.__flow && window.__flow.ready)')) break;
    } catch (e) {
      if (Date.now() > end - 1000) throw e;
    }
    await sleep(200);
  }
  await evaluate(page, 'window.__flow.ready.then(() => true)');
  return page;
}

export async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

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
    await sleep(250);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

export function readState() {
  return JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8'));
}




