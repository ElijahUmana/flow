// spaces' own isolated Flow: socket flow-dev-spaces, CDP port 9575, main inspector 9675, userData /tmp/flow-dev-spaces,
// marker --flow-dev=spaces, run from SPACES_ROOT (default: this repo). The seed is the app's own with every window that
// has a host dropped and every terminal a shell in /home/claude/.flow-dev/spaces/work, so no claude runs here.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, waitFor } from './nav-lib.mjs';

export const ROOT = path.resolve(process.env.SPACES_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
export const PORT = 9575, INSPECT = 9675, SOCKET = 'flow-dev-spaces', USER_DATA = '/tmp/flow-dev-spaces', MARK = 'spaces';
export const WORK = '/home/claude/.flow-dev/spaces/work';
const PATTERN = `[e]lectron/dist/electron .*--flow-dev=${MARK}`;

export const running = () => spawnSync('pgrep', ['-f', PATTERN]).status === 0;
export function launch({ inspect = false } = {}) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const out = fs.openSync(path.join(USER_DATA, 'main.log'), 'a');
  spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${USER_DATA}`, `FLOW_TMUX_SOCKET=${SOCKET}`,
    `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1', './node_modules/.bin/electron', ...(inspect ? [`--inspect=${INSPECT}`] : []), '.',
    '--no-sandbox', `--flow-dev=${MARK}`],
  { cwd: ROOT, env, stdio: ['ignore', out, out], detached: true }).unref();
}
/* Stops spaces' app and, unless keepTmux (a quit rather than a reboot), its tmux server; nothing else. */
export async function stop({ keepTmux = false } = {}) {
  spawnSync('pkill', ['-f', PATTERN]);
  const gone = await waitFor(() => !running(), 15000, 'spaces\' app to exit').then(() => true, () => false);
  if (!gone) spawnSync('pkill', ['-9', '-f', PATTERN]);
  if (!keepTmux) spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
}
export async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}
/* A Flow window with its console errors collected: the main one, or the pop-out whose url matches. */
export async function flowWindow(match = (u) => /\/src\/index\.html/.test(u) && !/solo=/.test(u)) {
  const t = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && match(x.url)), 45000, 'a Flow window');
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  cdp.url = t.url;
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') cdp.errors.push(`exception: ${m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) cdp.errors.push(`console.${m.params.type}: ${m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ')}`);
  });
  await cdp.send('Runtime.enable');
  await waitFor(() => cdp.eval('!!(window.__flow && window.__flow.ready)'), 45000, 'window.__flow');
  await cdp.eval('window.__flow.ready.then(() => true)');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}
export async function mainProcess() {
  const t = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json())[0], 30000, 'the main-process inspector');
  return Cdp.connect(t.webSocketDebuggerUrl);
}
/* The app's own seed, read from a probe launch whose state is one empty workspace, made safe for this VM. */
export async function writeSeed() {
  await stop();
  fs.mkdirSync(USER_DATA, { recursive: true });
  const probe = { v: 11, ws: [{ id: 'spaces-probe', name: 'spaces probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(probe));
  launch();
  let seed;
  try {
    const cdp = await flowWindow();
    seed = await cdp.eval('window.__flow.seed()');
    cdp.close();
  } finally {
    await stop();
  }
  const removed = [];
  for (const ws of seed) {
    ws.folder = path.join(WORK, ws.id);
    fs.mkdirSync(ws.folder, { recursive: true });
    for (const k of ['windows', 'closed']) {
      ws[k] = (ws[k] || []).filter((w) => { if (w.host) { removed.push(`${ws.id}/${w.id}`); return false; } return true; });
      for (const w of ws[k]) if (w.type === 'term' || w.type === 'team') { w.cmd = 'shell'; delete w.sessionId; w.cwd = ws.folder; }
    }
  }
  fs.writeFileSync(path.join(USER_DATA, 'seed.json'), JSON.stringify({ v: 11, ws: seed, ui: { hinted: true } }));
  return { ids: seed.map((w) => w.id), removed };
}
/* Back to the safe seed (writes it first if there is none); the app must not be running. */
export async function freshState() {
  if (!fs.existsSync(path.join(USER_DATA, 'seed.json'))) await writeSeed();
  if (running()) throw new Error('spaces\' app is running; stop it before resetting its state');
  fs.copyFileSync(path.join(USER_DATA, 'seed.json'), path.join(USER_DATA, 'flow-state.json'));
}




