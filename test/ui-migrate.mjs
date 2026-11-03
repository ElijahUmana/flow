// The september-line and sub-workspace migrations on a saved state, end to end: the state as the old seed wrote it (zone z-sept with
// w-sport, w-tests, w-snote and note n-sept), live tmux sessions for its two terminals on ui's socket, then the real app
// started on that state. Run from ~/flow: node test/ui-migrate.mjs (it stops and restarts test/ui-dev.sh itself).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { connectTo, evaluate, sleep, reporter } from './ui-lib.mjs';
import { PORT, SOCK, DATA } from './ui-env.mjs';

const R = reporter();
const tmux = (...a) => {
  try { return execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
};
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });

dev('stop');
dev('start', '--fresh');
let app = await connectTo(PORT, /\/src\/index\.html$/);
await evaluate(app, 'new Promise((r) => { const t = setInterval(() => { if (window.__flow) { clearInterval(t); r(); } }, 100); })');
const ws = await evaluate(app, '__flow.seed()');
dev('stop');

// The old seed's september content, as app.js wrote it before Nov 1 19:20 UTC.
const flow = ws.find((w) => w.id === 'flow');
flow.zones.push({ id: 'z-sept', name: 'september line', x: 176, y: 5.2, w: 58, h: 83.6 });
flow.notes.push({ id: 'n-sept', kind: 'note', title: 'september line', body: 'never installed. port the oct 29 search fix first.' });
flow.windows.push(
  { id: 'w-sport', type: 'term', title: 'sept port', cmd: 'claude', cwd: '~/claude-code-manager', sessionId: crypto.randomUUID(), where: 'this Mac', x: 177.4, y: 10, w: 33.6, h: 48 },
  { id: 'w-tests', type: 'term', title: 'september line tests', cmd: 'shell', cwd: '~/claude-code-manager', where: 'this Mac', x: 212.2, y: 10, w: 20.6, h: 48 },
  { id: 'w-snote', type: 'note', noteId: 'n-sept', x: 177.4, y: 59.8, w: 55.4, h: 27.6 },
);
// no window with a host: nothing in a test may start ssh to claude-agents
for (const w of ws) for (const k of ['windows', 'closed']) w[k] = (w[k] || []).filter((x) => !x.host);
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(`${DATA}/flow-state.json`, JSON.stringify({ v: 11, ws, ui: { at: 'flow' } }));
// Stand-ins for the two live terminals: sessions with the names Flow gives them, on ui's own socket.
for (const id of ['w-sport', 'w-tests']) tmux('new-session', '-d', '-s', `flow_${id}`, 'sleep 900');
R.ok('before: tmux sessions flow_w-sport and flow_w-tests are running', tmux('has-session', '-t', 'flow_w-sport') !== null && tmux('has-session', '-t', 'flow_w-tests') !== null);

dev('start');
app = await connectTo(PORT, /\/src\/index\.html$/);
await evaluate(app, 'new Promise((r) => { const t = setInterval(() => { if (window.__flow) { clearInterval(t); r(); } }, 100); })');
await evaluate(app, 'window.__flow.ready');
await sleep(1500);
const s = await evaluate(app, '__flow.state()');
const f = s.ws.find((w) => w.id === 'flow');
R.ok('the september line zone is gone', !f.zones.some((z) => z.id === 'z-sept'), f.zones.map((z) => z.id));
R.ok('its windows are off the desktop', !f.windows.some((w) => ['w-sport', 'w-tests', 'w-snote'].includes(w.id)), f.windows.map((w) => w.id));
R.ok('its two terminals are in the closed list', ['w-sport', 'w-tests'].every((id) => f.closed.some((w) => w.id === id)), f.closed.map((w) => w.id));
R.ok('their tmux sessions are still running (never killed)', tmux('has-session', '-t', 'flow_w-sport') !== null && tmux('has-session', '-t', 'flow_w-tests') !== null);
R.ok('the untouched demo note n-sept is gone, the other notes stay', !f.notes.some((n) => n.id === 'n-sept') && f.notes.some((n) => n.id === 'n-week'));
R.ok('the sidebar shows them as closed agents', await evaluate(app, '["w-sport", "w-tests"].every((id) => !!document.querySelector(`.tr[data-act="reopen|${id}"]`))'));
const zr = f.zones.find((z) => z.id === 'z-research');
R.ok('the research region became a space of its own: no x, y, w, h left on it', !!zr && zr.x === undefined && zr.w === undefined, zr);
const inR = ['w-kv', 'w-judge', 'w-read'].map((id) => f.windows.find((w) => w.id === id));
R.ok('its three windows moved into it, keeping their place from its left edge (w-kv 103.4 -> 2.6)', inR.every((w) => w && w.zone === 'z-research') && Math.abs(inR[0].x - 2.6) < 0.01, inR.map((w) => w && [w.id, w.zone, +w.x.toFixed(2)]));
R.ok('the main space keeps the rest', ['w-design', 'w-week', 'w-mck'].every((id) => !f.windows.find((w) => w.id === id).zone));
const saved = JSON.parse(fs.readFileSync(`${DATA}/flow-state.json`, 'utf8'));
R.ok('the migrated state is saved', !JSON.stringify(saved.ws.find((w) => w.id === 'flow').zones).includes('z-sept'));
R.ok('no console errors or exceptions', app.errors.filter((e) => !e.startsWith('console.warning') && !/Host key verification failed|could not list the panes of (w-team|mn-team)|flow\.term\.panes failed for (w-team|mn-team)/.test(e)).length === 0, app.errors.slice(0, 3));
R.summary();
dev('stop');
process.exit();




