// A first-run state for ui-e2e: the app's own seed, read from a probe launch through __flow.seed() (an empty probe
// state, so the probe opens no terminal), with every window that has a host removed (no ssh to claude-agents ever
// starts from a test) and every folder moved to <CWD>/cwd/<workspace>, a folder of the test's own.
//   node test/ui-seed.mjs     writes <DATA>/flow-state.json (test/ui-dev.sh start --fresh runs it)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep } from './ui-lib.mjs';
import { PORT, MARK, SOCK, DATA, CWD } from './ui-env.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROBE = `${DATA}-probe`;
fs.rmSync(PROBE, { recursive: true, force: true });
fs.mkdirSync(PROBE, { recursive: true });
fs.writeFileSync(path.join(PROBE, 'flow-state.json'), JSON.stringify({ v: 11, ws: [{ id: 'probe', name: 'probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${PROBE}`, `FLOW_TMUX_SOCKET=${SOCK}-probe`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1',
  './node_modules/.bin/electron', '.', '--no-sandbox', `--flow-dev=${MARK}-probe`], { cwd: ROOT, stdio: 'ignore', detached: true });
let seed;
try {
  const page = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  seed = await evaluate(page, 'window.__flow.seed()');
  page.ws.close();
} finally {
  process.kill(-app.pid, 'SIGTERM');
}
for (let i = 0; i < 40; i++) {
  try { process.kill(-app.pid, 0); } catch { break; }
  await sleep(250);
}
fs.rmSync(PROBE, { recursive: true, force: true });

const removed = [];
for (const ws of seed) {
  const cwd = path.join(CWD, 'cwd', ws.id);
  fs.mkdirSync(cwd, { recursive: true });
  ws.folder = cwd;
  for (const k of ['windows', 'closed']) {
    ws[k] = (ws[k] || []).filter((w) => {
      if (w.host) { removed.push(`${ws.id}/${w.id}`); return false; }
      return true;
    });
    ws[k].forEach((w) => { if (w.type === 'term' || w.type === 'team') w.cwd = cwd; });
  }
}
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws: seed, ui: {} }));
console.log(`wrote ${path.join(DATA, 'flow-state.json')}: ${seed.map((w) => w.id).join(', ')}; removed host windows: ${removed.join(', ') || 'none'}`);




