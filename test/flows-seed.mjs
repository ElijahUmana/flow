// Writes flows' starting state the way scripts/e2e.mjs does (the seed read from a probe app, every window with a host
// removed), plus one change for this VM's rules: every folder and cwd moves under /home/claude/.flow-dev/flows/p/, so real
// claude only ever runs there. Run with the app stopped: node test/flows-seed.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as L from './flows-lib.mjs';

const PROBE = { v: 11, ws: [{ id: 'flows-probe', name: 'flows probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };
const stateFile = path.join(L.UD, 'flow-state.json');
fs.mkdirSync(L.UD, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(PROBE));
const t = await L.launch('probe');
const page = await L.connect();
await L.until(page, 'window.__flow && window.__flow.ready && 1', 30000);
await L.ev(page, 'window.__flow.ready');
const seed = await L.ev(page, 'window.__flow.seed()');
const shown = await L.ev(page, 'document.querySelectorAll(".win").length');
page.ws.close();
console.log('probe up in', t.ms, 'ms;', shown, 'windows shown;', await L.stop());
const removed = [];
const where = (p) => {
  if (!p) return p;
  const base = String(p).replace(/^~\/?/, '').replace(/\//g, '-') || 'home';
  const dir = path.join(L.WORK, 'p', base);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
for (const ws of seed) {
  ws.folder = where(ws.folder);
  for (const k of ['windows', 'closed']) {
    ws[k] = (ws[k] || []).filter((w) => { if (w.host) { removed.push(`${ws.id}/${w.id}`); return false; } return true; });
    for (const w of ws[k]) if (w.cwd) w.cwd = where(w.cwd);
  }
}
fs.writeFileSync(stateFile, JSON.stringify({ v: 11, ws: seed, ui: {} }));
console.log('removed host windows:', removed.join(', '));
console.log('workspaces:', seed.map((w) => `${w.id} (${w.folder}; ${w.windows.length} windows: ${w.windows.map((x) => `${x.id}:${x.type}${x.cmd ? '/' + x.cmd : ''}${x.cwd ? '@' + x.cwd.replace(L.WORK, '') : ''}`).join(' ')})`).join('\n  '));
console.log('tmux after probe:', L.tmux('ls').trim() || '(no server)');




