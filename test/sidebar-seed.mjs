// sidebar's isolated first-run state: the app's own seed (read from a probe launch through __flow.seed(), as
// scripts/e2e.mjs does) with every window that has a host removed and every folder moved under
// /tmp/flow-dev-sidebar/cwd, so no terminal ever opens over ssh or in a real project.
//   node test/sidebar-seed.mjs        writes /tmp/flow-dev-sidebar/flow-state.json (deletes /tmp/flow-dev-sidebar first)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep } from './ui-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = '/tmp/flow-dev-sidebar', PROBE = '/tmp/flow-dev-sidebar-probe', PORT = 9574;

fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(PROBE, { recursive: true, force: true });
fs.mkdirSync(PROBE, { recursive: true });
fs.writeFileSync(path.join(PROBE, 'flow-state.json'), JSON.stringify({ v: 11, ws: [{ id: 'sb-probe', name: 'sidebar probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${PROBE}`, 'FLOW_TMUX_SOCKET=flow-dev-sidebar', `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1',
  './node_modules/.bin/electron', '.', '--no-sandbox', '--flow-dev=sidebar-probe'], { cwd: ROOT, stdio: 'ignore', detached: true });
let seed;
try {
  const page = await connectTo(PORT, 'index.html');
  for (let i = 0; i < 40 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
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
  const cwd = path.join(DIR, 'cwd', ws.id);
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
fs.writeFileSync(path.join(DIR, 'flow-state.json'), JSON.stringify({ v: 11, ws: seed, ui: {} }));
console.log(`wrote ${path.join(DIR, 'flow-state.json')}: ${seed.map((w) => w.id).join(', ')}; removed host windows ${removed.join(', ') || 'none'}`);




