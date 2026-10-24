// Writes orch's starting state the way scripts/e2e.mjs does (the seed with every `host` window removed), with every
// folder and cwd moved under /home/claude/.flow-dev/orch/work (trusted through /home/claude, so no trust question). A probe app whose state is
// one empty workspace returns seed() without opening anything.
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from './ui-lib.mjs';
import { USER_DATA, WORK, launch, connect, stop, killTmux, pids } from './orch-lib.mjs';

const PROBE = { v: 11, ws: [{ id: 'orch-probe', name: 'orch probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };
const file = path.join(USER_DATA, 'flow-state.json');

if (pids().length) throw new Error('orch Flow is running; stop it first');
killTmux();
fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.writeFileSync(file, JSON.stringify(PROBE));
launch(path.join(USER_DATA, 'probe.log'));
const page = await connect();
const seed = await evaluate(page, 'window.__flow.seed()');
const shown = await evaluate(page, 'document.querySelectorAll(".win").length');
page.ws.close();
await stop();
killTmux();
if (shown !== 0) throw new Error(`the probe showed ${shown} windows`);

const moved = (p) => {
  if (!p) return p;
  const base = p === '~' ? 'home' : p.replace(/^~\//, '').replace(/\//g, '_');
  const dir = path.join(WORK, base);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const removed = [];
for (const ws of seed) {
  ws.folder = moved(ws.folder);
  for (const k of ['windows', 'closed']) {
    ws[k] = ws[k].filter((w) => {
      if (w.host) { removed.push(`${ws.id}/${w.id} (${w.host}, attach ${w.attach})`); return false; }
      return true;
    });
    for (const w of ws[k]) if (w.cwd) w.cwd = moved(w.cwd);
  }
}
const doc = { v: 11, ws: seed, ui: {} };
fs.rmSync(file, { force: true });
for (const f of fs.readdirSync(USER_DATA)) if (f !== 'work' && f !== 'probe.log') fs.rmSync(path.join(USER_DATA, f), { recursive: true, force: true });
fs.writeFileSync(file, JSON.stringify(doc));
const hosts = seed.flatMap((ws) => [...ws.windows, ...ws.closed].filter((w) => w.host));
const cwds = [...new Set(seed.flatMap((ws) => [ws.folder, ...ws.windows.map((w) => w.cwd)].filter(Boolean)))];
console.log(`removed: ${removed.join(', ')}`);
console.log(`windows with a host left: ${hosts.length}`);
console.log(`folders and cwds: ${cwds.join(' ')}`);
if (hosts.length || cwds.some((c) => !c.startsWith(WORK))) process.exit(1);




