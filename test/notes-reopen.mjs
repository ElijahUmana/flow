// notes' check of a note reopened from its row (lead's rule for batch 9, as for a terminal: exactly where it was): a
// note closed with its red light comes back at its own place and size even when another window was moved there
// meanwhile, and that window makes way; a note closed in a sub-workspace comes back in it, wherever the owner is (its
// row is under that sub-workspace's heading in batch 9's sidebar, under the notes before); both after a restart. Real input over CDP on notes' isolated app (userData /tmp/flow-dev-notes, socket flow-dev-notes,
// CDP 9566), started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-reopen.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, drag, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const R = reporter();

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
/* The middle of what sel matches, once the view stands still, if a press there reaches it. */
async function spot(sel) {
  if (!(await waitFor(still, 8000))) throw new Error(`the view was still moving before a press on ${sel}`);
  await sleep(200);
  return ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return r.width && e.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`);
}
async function press(sel, what) {
  const at = await spot(sel);
  if (!at) throw new Error(`${what} is not where a press lands`);
  await click(p, at.x, at.y);
}
const state = () => ev('window.__flow.state().ws[0]');
const rectOf = (w) => (w ? { x: +w.x.toFixed(3), y: +w.y.toFixed(3), w: +w.w.toFixed(3), h: +w.h.toFixed(3) } : null);
const winOf = (s, nid) => s.windows.find((w) => w.noteId === nid) || null;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/* Closes a note window with its red light and waits until it is gone. */
async function closeNote(wid) {
  await press(`.win[data-id="${wid}"] [data-l=close]`, `${wid}'s red light`);
  if (!(await waitFor(`!window.__flow.state().ws[0].windows.some((w) => w.id === ${JSON.stringify(wid)})`, 5000))) throw new Error(`${wid} did not close`);
}

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(path.join(UD, 'cwd'), { recursive: true });
const A = { x: 6, y: 12, w: 26, h: 40 }, B = { x: 44, y: 12, w: 26, h: 40 };
const WS = { id: 'r', name: 'reopening', folder: path.join(UD, 'cwd'), bg: '#141319', zones: [{ id: 'z-a', name: 'research', pan: 0 }], closed: [], saved: [],
  notes: [
    { id: 'n-a', kind: 'note', title: 'alpha note', titleSet: true, body: 'alpha' },
    { id: 'n-b', kind: 'note', title: 'beta note', titleSet: true, body: 'beta' },
    { id: 'n-z', kind: 'note', title: 'research note', titleSet: true, body: 'in research' },
  ],
  windows: [
    { id: 'w-a', type: 'note', noteId: 'n-a', ...A },
    { id: 'w-b', type: 'note', noteId: 'n-b', ...B },
    { id: 'w-z', type: 'note', noteId: 'n-z', ...A, zone: 'z-a' },
  ] };
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [WS], ui: {}, pages: {} }));

launch();
p = await connect();
try {
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('.win[data-id="w-a"] .fnote-ed')`)); i++) await sleep(250);
  // closed with its red light, then another window dragged by its title bar onto where it was
  await closeNote('w-a');
  const s1 = await state();
  const placeA = s1.notes.find((n) => n.id === 'n-a').place;
  R.ok('a closed note keeps its place and size', JSON.stringify(rectOf(placeA)) === JSON.stringify(rectOf(A)) && !placeA.zone, placeA);
  const tb = await spot('.win[data-id="w-b"] .tb');
  const dx = await ev(`(() => { const b = document.querySelector('.win[data-id="w-b"]').getBoundingClientRect(); return b.width * ${(A.x + 8 - B.x) / B.w}; })()`);
  await drag(p, tb, { x: tb.x + dx, y: tb.y + 30 }, { steps: 16, stepMs: 20 });
  await sleep(900);
  const s2 = await state();
  const b2 = rectOf(s2.windows.find((w) => w.id === 'w-b'));
  R.ok('the other window now stands on that place', overlap(b2, A), b2);
  // reopened from its row: exactly where it was, and the window there makes way
  await press('#sblist .tr[data-act="note|n-a"] .l', 'the alpha note\'s row');
  const a3 = await waitFor(`(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.noteId === 'n-a'); return w ? w.id : ''; })()`, 5000);
  if (!a3) throw new Error('the row did not reopen the note');
  await waitFor(still, 8000);
  await sleep(600);
  const s3 = await state();
  const ra = rectOf(winOf(s3, 'n-a')), rb = rectOf(s3.windows.find((w) => w.id === 'w-b'));
  R.ok('reopened from its row, the note is exactly where it was, at its size', JSON.stringify(ra) === JSON.stringify(rectOf(A)) && !winOf(s3, 'n-a').zone, ra);
  R.ok('the window that stood there made way, at its own size', !overlap(ra, rb) && rb.w === b2.w && rb.h === b2.h, { rb, b2 });
  R.ok('the reopened note has the keys', (await ev(`(() => { const e = document.querySelector('.win[data-id="${a3}"] .fnote-ed'); return document.activeElement === e; })()`)) === true);

  // closed in a sub-workspace, reopened from the main space: it comes back in its sub-workspace
  await press('#sblist .tr[data-act="zone|z-a"] .l', 'the research row');
  if (!(await waitFor(`window.__flow.state().ws[0].at === 'z-a'`, 5000))) throw new Error('the research sub-workspace did not show');
  await closeNote('w-z');
  const placeZ = (await state()).notes.find((n) => n.id === 'n-z').place;
  R.ok('a note closed in a sub-workspace keeps it with its place', placeZ.zone === 'z-a' && JSON.stringify(rectOf(placeZ)) === JSON.stringify(rectOf(A)), placeZ);
  await press('#sblist .tr[data-act="zone|"] .l', 'the workspace\'s own row');
  if (!(await waitFor(`!window.__flow.state().ws[0].at`, 5000))) throw new Error('the main space did not show');
  // batch 9's sidebar lists a closed note under the sub-workspace it was closed in, folded at first: unfold it there
  if (!(await spot('#sblist .tr[data-act="note|n-z"] .l'))) await press('#sblist .tr[data-act="zone|z-a"] [data-tog]', 'the research heading\'s fold');
  await press('#sblist .tr[data-act="note|n-z"] .l', 'the research note\'s row');
  const z5 = await waitFor(`(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.noteId === 'n-z'); return w ? w.id : ''; })()`, 5000);
  if (!z5) throw new Error('the row did not reopen the research note');
  await waitFor(still, 8000);
  await sleep(600);
  const s5 = await state();
  const wz = winOf(s5, 'n-z');
  R.ok('reopened from the main space, it comes back in its sub-workspace, exactly where it was', wz.zone === 'z-a' && JSON.stringify(rectOf(wz)) === JSON.stringify(rectOf(A)), { zone: wz.zone, at: rectOf(wz) });
  R.ok('the view goes there with it', s5.at === 'z-a', s5.at);

  // restart: both where they were
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  p.ws.close();
  await quit();
  launch();
  p = await connect();
  await sleep(2000);
  const s6 = await state();
  const a6 = winOf(s6, 'n-a'), z6 = winOf(s6, 'n-z');
  R.ok('after a restart both are where they came back', !!a6 && !!z6 && JSON.stringify(rectOf(a6)) === JSON.stringify(rectOf(A)) && !a6.zone && JSON.stringify(rectOf(z6)) === JSON.stringify(rectOf(A)) && z6.zone === 'z-a', { a: rectOf(a6), z: z6 && { zone: z6.zone, at: rectOf(z6) } });
  errs.push(...p.errors.filter((e) => !e.startsWith('console.warning')));
  R.ok('no console errors in the app', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (err) {
  R.ok(`run stopped: ${err.message}`, false);
} finally {
  try { p.ws.close(); } catch (e) { console.error('closing CDP:', e.message); }
  if (process.env.NOTES_KEEP) console.log('NOTES_KEEP: the app is left running on 9566');
  else await cleanup();
}
R.summary();




