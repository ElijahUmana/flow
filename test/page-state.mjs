/* Writes a page-only first-run state into a userData folder, so the real app starts with the seed's workspaces, pages
   and notes but no terminal: a fresh seed would start real Claude Code (its agent windows, one of them in ~/flow) and
   `ssh claude-agents` (its VM windows). The seed comes from a probe app whose state is one empty workspace, so it opens
   nothing, through window.__flow.seed(), as scripts/e2e.mjs does. Every window and closed entry that is not a page or a
   note is left out.
   Usage, from the repo root, with no page dev instance running (the probe uses the page dev socket, port and marker):
   node test/page-state.mjs /tmp/flow-dev-page */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const target = process.argv[2];
if (!target) {
  console.error('usage: node test/page-state.mjs <userData folder>');
  process.exit(2);
}
const MARKER = '--flow-dev=page';
const PORT = 9564;
const PROBE_DIR = '/tmp/flow-dev-page-probe';
const PROBE_STATE = { v: 11, ws: [{ id: 'page-probe', name: 'page probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = () => {
  try {
    return execFileSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARKER}`], { encoding: 'utf8' }).trim();
  } catch (e) {
    if (e.status === 1) return '';
    throw e;
  }
};
if (running()) {
  console.error(`a page dev instance is running (${running().split('\n').join(', ')}); stop it first`);
  process.exit(2);
}

fs.rmSync(PROBE_DIR, { recursive: true, force: true });
fs.mkdirSync(PROBE_DIR, { recursive: true });
fs.writeFileSync(path.join(PROBE_DIR, 'flow-state.json'), JSON.stringify(PROBE_STATE));
const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${PROBE_DIR}`, 'FLOW_TMUX_SOCKET=flow-dev-page',
  `FLOW_CDP_PORT=${PORT}`, './node_modules/.bin/electron', '.', '--no-sandbox', MARKER], { cwd: ROOT, stdio: 'ignore' });
const exited = new Promise((r) => app.once('exit', r));
let seed = null;
try {
  let target0 = null;
  for (let i = 0; i < 120 && !target0; i++) {
    await sleep(250);
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json(), () => []);
    target0 = list.find((x) => x.type === 'page' && /index\.html/.test(x.url));
  }
  if (!target0) throw new Error(`the probe app never showed its window on port ${PORT}`);
  const ws = new WebSocket(target0.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to the probe app')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const ev = (expression) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); })
    .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 300)); return d.result.result.value; });
  for (let i = 0; i < 80 && !(await ev('!!window.__flow').catch(() => false)); i++) await sleep(250);
  await ev('window.__flow.ready.then(() => true)');
  if (!(await ev('typeof window.__flow.seed === "function"'))) throw new Error('window.__flow.seed() does not exist in this app');
  seed = await ev('window.__flow.seed()');
  ws.close();
} finally {
  execFileSync('pkill', ['-f', `[e]lectron/dist/electron .*${MARKER}`]);
  await Promise.race([exited, sleep(15000)]);
  if (running()) {
    execFileSync('pkill', ['-KILL', '-f', `[e]lectron/dist/electron .*${MARKER}`]);
    await Promise.race([exited, sleep(5000)]);
  }
  try {
    execFileSync('tmux', ['-L', 'flow-dev-page', 'kill-server'], { stdio: 'ignore' });
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  fs.rmSync(PROBE_DIR, { recursive: true, force: true });
}
if (!Array.isArray(seed) || !seed.length) throw new Error(`window.__flow.seed() gave ${JSON.stringify(seed).slice(0, 200)}`);
const keep = (x) => x && (x.type === 'page' || x.type === 'note') && !x.cmd && !x.host;
const left = [];
for (const w of seed) {
  for (const k of ['windows', 'closed']) {
    if (!Array.isArray(w[k])) continue;
    w[k] = w[k].filter((x) => {
      if (keep(x)) return true;
      left.push(`${w.id}/${x.id}`);
      return false;
    });
  }
}
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'flow-state.json'), JSON.stringify({ v: PROBE_STATE.v, ws: seed, ui: {} }));
const pages = seed.flatMap((w) => (w.windows || []).filter((x) => x.type === 'page').map((x) => x.id));
console.log(`page-only state in ${target}: ${seed.length} workspaces, page windows ${pages.join(', ')}; left out ${left.length}: ${left.join(', ')}`);




