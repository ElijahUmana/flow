// notes' check of the ✎ pane's divider (audit 4, batch 9): the pane's left edge is a divider, as in a Mac split view: a
// band either side of the line, the edge following the pointer from where it was pressed, the terminal beside it
// reflowing during the drag (ux's notes). A drag gives the pane that share of the window, from a fifth to seven
// tenths, and the terminal or page takes the rest; the width stays with its window across a restart; a double-click
// puts back the usual width. Real pointer input over CDP on notes' isolated app (userData /tmp/flow-dev-notes, socket
// flow-dev-notes, CDP 9566), started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-pane.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connectTo, evaluate, sleep, mouse, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const R = reporter();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>A page</title></head><body style="font:24px sans-serif"><p>a page beside its note</p></body></html>');
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const BASE = `http://127.0.0.1:${server.address().port}`;

const pids = () => spawnSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARK}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
function launch() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const log = fs.openSync(path.join(UD, 'app.log'), 'a');
  spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${UD}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`,
    'FLOW_BACKGROUND=1', './node_modules/.bin/electron', '.', '--no-sandbox', MARK], { cwd: DIR, env, stdio: ['ignore', log, log], detached: true }).unref();
}
async function quit() {
  for (const p of pids()) process.kill(+p, 'SIGTERM');
  for (let i = 0; i < 60 && pids().length; i++) await sleep(250);
  if (pids().length) throw new Error(`the app did not quit: ${pids().join(' ')}`);
}
async function cleanup() {
  for (const p of pids()) process.kill(+p, 'SIGKILL');
  for (let i = 0; i < 40 && pids().length; i++) await sleep(250);
  spawnSync('tmux', ['-L', SOCK, 'kill-server']);
}
async function connect() {
  const page = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 160 && !(await evaluate(page, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready.then(() => true)');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return page;
}
let p;
const ev = (e) => evaluate(p, e);
async function waitFor(expr, ms) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { v = await ev(expr); if (v) return v; }
  return v;
}
const still = `!document.getAnimations().some((a) => 'transitionProperty' in a && a.effect && a.effect.target && a.effect.target.matches('.track, .canvas, .win, .sb'))`;
/* A window's pane and its divider: the pane's share of the window body, the line (the pane's left edge), and whether a
   press 2.5 px either side of it reaches the divider. */
const look = (id) => ev(`(() => { const w = document.querySelector('.win[data-id="${id}"]'); const pane = w && w.querySelector('.npane'), g = w && w.querySelector('.npane-grip'); if (!g || !pane) return null; const b = pane.parentElement.getBoundingClientRect(), r = pane.getBoundingClientRect(); const line = r.left, y = r.top + r.height / 2; return { frac: r.width / b.width, body: { left: b.left, right: b.right, width: b.width }, line, y, x: line - 2.5, hit: document.elementFromPoint(line - 2.5, y) === g && document.elementFromPoint(line + 2.5, y) === g, cursor: getComputedStyle(g, '::before').cursor }; })()`);
const saved = (id) => ev(`(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.id === ${JSON.stringify(id)}); return w ? (w.paneW == null ? null : w.paneW) : 'missing'; })()`);
const near = (a, b, d) => typeof a === 'number' && Math.abs(a - b) <= d;
/* Presses the divider 2.5 px left of its line (over the terminal or page) and moves the pointer by dx in steps;
   during(i) runs before step i. */
async function dragBy(id, dx, during) {
  const at = await look(id);
  if (!at || !at.hit) throw new Error(`${id}'s divider is not where a press lands`);
  const steps = 20;
  await mouse(p, 'mouseMoved', at.x, at.y);
  await mouse(p, 'mousePressed', at.x, at.y);
  for (let i = 1; i <= steps; i++) {
    if (during) await during(i);
    await mouse(p, 'mouseMoved', at.x + (dx * i) / steps, at.y, { down: true });
    await sleep(40);
  }
  await mouse(p, 'mouseReleased', at.x + dx, at.y);
  await sleep(900);
  return { before: at, after: await look(id) };
}

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(path.join(UD, 'cwd'), { recursive: true });
const WS = { id: 'd', name: 'divider', folder: path.join(UD, 'cwd'), bg: '#141319', zones: [], closed: [], saved: [],
  notes: [{ id: 'p-1', kind: 'page', title: 'A page', url: `${BASE}/a`, body: '' }],
  windows: [
    { id: 'w-sh', type: 'term', title: 'a shell', cmd: 'shell', cwd: path.join(UD, 'cwd'), where: 'this Mac', note: 'a line about this shell', x: 1.2, y: 8, w: 48, h: 56, noted: true },
    { id: 'w-p', type: 'page', noteId: 'p-1', x: 50.4, y: 8, w: 48, h: 56, noted: true },
  ] };
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [WS], ui: {}, pages: {} }));

launch();
p = await connect();
try {
  if (!(await waitFor(`(() => { const t = window.__flow.term('w-sh'); return !!t && /\\S/.test(t.getText()); })()`, 15000))) throw new Error('the shell never showed a prompt');
  if (!(await waitFor(`(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.id === 'w-p'); const t = w && w.tabs && w.tabs[w.tab || 0]; return !!(t && t.url.startsWith(${JSON.stringify(BASE)})); })()`, 15000))) throw new Error('the page did not load');
  await waitFor(still, 8000);
  await sleep(800);
  const sh0 = await look('w-sh'), pg0 = await look('w-p');
  R.ok('each ✎ pane opens at the usual width; its divider takes a press either side of the line, with the resize cursor', near(sh0 && sh0.frac, 0.38, 0.01) && near(pg0 && pg0.frac, 0.38, 0.01) && sh0.hit && pg0.hit && sh0.cursor === 'col-resize', { sh0, pg0 });
  const cols0 = await ev(`window.__flow.term('w-sh').cols`);

  // a drag to the left by a fifth of the window: the edge follows the pointer from where it was pressed (no jump), the
  // terminal reflows while the hand is still moving, and the pane takes that much more
  let midCols = null;
  const d1 = await dragBy('w-sh', -0.2 * sh0.body.width, async (i) => { if (i === 16) midCols = await ev(`window.__flow.term('w-sh').cols`); });
  const sh1 = d1.after;
  R.ok('the edge moves just as far as the pointer, from where it was pressed', Math.abs(sh1.line - (sh0.line - 0.2 * sh0.body.width)) <= 1, { moved: sh1.line - sh0.line, pointer: -0.2 * sh0.body.width });
  R.ok('the terminal reflows during the drag, before it is let go', midCols != null && midCols < cols0, { cols0, midCols });
  const cols1 = await ev(`window.__flow.term('w-sh').cols`);
  R.ok('let go, the pane is wider and the terminal fits the rest', near(sh1.frac, 0.58, 0.02) && cols1 < cols0, { frac: sh1.frac, cols0, cols1 });
  R.ok('the window keeps the width', near(await saved('w-sh'), sh1.frac, 0.01), await saved('w-sh'));
  // the limits: at most seven tenths, at least a fifth
  const wide = (await dragBy('w-sh', -sh0.body.width)).after;
  const narrow = (await dragBy('w-sh', 2 * sh0.body.width)).after;
  R.ok('the pane stops at seven tenths and at a fifth of the window', near(wide.frac, 0.7, 0.01) && near(narrow.frac, 0.2, 0.01), { wide: wide.frac, narrow: narrow.frac });
  const sh2 = (await dragBy('w-sh', sh0.body.left + 0.5 * sh0.body.width - narrow.line)).after;
  R.ok('dragged back to the middle, it is half the window', near(sh2.frac, 0.5, 0.02), sh2.frac);

  // the page window's pane, narrower: the page takes the rest
  const pg1 = (await dragBy('w-p', 0.1 * pg0.body.width)).after;
  const page = await ev(`(() => { const w = document.querySelector('.win[data-id="w-p"]'); return { pn: w.querySelector('.pn').getBoundingClientRect().width, pane: w.querySelector('.npane').getBoundingClientRect().width, body: w.querySelector('.body').getBoundingClientRect().width }; })()`);
  R.ok('a page window\'s pane narrows the same way, and the page takes the rest', near(pg1.frac, 0.28, 0.02) && Math.abs(page.pn + page.pane - page.body) <= 2, { frac: pg1.frac, page });

  await sleep(1200);
  const disk = JSON.parse(fs.readFileSync(path.join(UD, 'flow-state.json'), 'utf8'));
  const dw = (id) => (disk.ws[0].windows.find((x) => x.id === id) || {}).paneW;
  R.ok('flow-state.json has both widths', near(dw('w-sh'), sh2.frac, 0.01) && near(dw('w-p'), pg1.frac, 0.01), { sh: dw('w-sh'), p: dw('w-p') });

  // restart: each pane at its width
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  p.ws.close();
  await quit();
  launch();
  p = await connect();
  if (!(await waitFor(`(() => { const t = window.__flow.term('w-sh'); return !!t && /\\S/.test(t.getText()); })()`, 15000))) throw new Error('the shell never showed a prompt after the restart');
  await waitFor(still, 8000);
  await sleep(800);
  const sh3 = await look('w-sh'), pg3 = await look('w-p');
  R.ok('after a restart each pane is at the width it was left', near(sh3 && sh3.frac, sh2.frac, 0.01) && near(pg3 && pg3.frac, pg1.frac, 0.01), { sh: sh3 && sh3.frac, p: pg3 && pg3.frac });

  // a double-click on the divider (just right of its line): the usual width again, and the window no longer keeps one
  sh3.x = sh3.line + 2.5;
  await mouse(p, 'mouseMoved', sh3.x, sh3.y);
  await mouse(p, 'mousePressed', sh3.x, sh3.y, { clickCount: 1 });
  await mouse(p, 'mouseReleased', sh3.x, sh3.y, { clickCount: 1 });
  await mouse(p, 'mousePressed', sh3.x, sh3.y, { clickCount: 2 });
  await mouse(p, 'mouseReleased', sh3.x, sh3.y, { clickCount: 2 });
  await sleep(800);
  const sh4 = await look('w-sh');
  R.ok('a double-click on the divider puts back the usual width', near(sh4.frac, 0.38, 0.01) && (await saved('w-sh')) === null, { frac: sh4.frac, kept: await saved('w-sh') });
  errs.push(...p.errors.filter((e) => !e.startsWith('console.warning')));
  R.ok('no console errors in the app', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (err) {
  R.ok(`run stopped: ${err.message}`, false);
} finally {
  try { p.ws.close(); } catch (e) { console.error('closing CDP:', e.message); }
  if (process.env.NOTES_KEEP) console.log('NOTES_KEEP: the app is left running on 9566');
  else await cleanup();
  server.close();
}
R.summary();




