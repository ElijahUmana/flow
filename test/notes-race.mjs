// notes' check of page records across windows (item 40): a window's save that carries an older copy of the page records
// never undoes a newer change made in another window, deletions included, and two windows saving at the same moment
// (one store write) both keep their change, in both windows, on disk and after a restart. Real input in the main
// window and a pop-out; a stale save is fed to FlowNotes.remote as it arrives from another window. notes' isolated app
// (userData /tmp/flow-dev-notes, socket flow-dev-notes, CDP 9566), started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-race.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, key, type, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const R = reporter();
const KV = 'https://www.alphaxiv.org/abs/2610.38355';

const pids = () => spawnSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARK}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
function launch(userData) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const log = fs.openSync(path.join(UD, 'app.log'), 'a');
  spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${userData}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`,
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
async function connect(match) {
  const page = await connectTo(PORT, match);
  for (let i = 0; i < 160 && !(await evaluate(page, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready.then(() => true)');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return page;
}
const ev = (p, e) => evaluate(p, e);
/* True once nothing slides: a window opened past the others brings the view to it with a CSS transition (nav). */
const still = `!document.getAnimations().some((a) => 'transitionProperty' in a && a.effect && a.effect.target && a.effect.target.matches('.track, .canvas, .win, .sb'))`;
async function waitFor(p, expr, ms) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { v = await ev(p, expr); if (v) return v; }
  return v;
}
async function seed() {
  const probe = `${UD}-probe`;
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'flow-state.json'), JSON.stringify({ v: 11, ws: [{ id: 'probe', name: 'probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  fs.mkdirSync(UD, { recursive: true });
  launch(probe);
  const p = await connect(/\/src\/index\.html$/);
  const s = await ev(p, 'window.__flow.seed()');
  p.ws.close();
  await quit();
  fs.rmSync(probe, { recursive: true, force: true });
  for (const ws of s) {
    const dir = path.join(UD, 'cwd', ws.id);
    fs.mkdirSync(dir, { recursive: true });
    ws.folder = dir;
    for (const k of ['windows', 'closed']) {
      ws[k] = (ws[k] || []).filter((w) => !w.host);
      ws[k].forEach((w) => { if (w.type === 'term' || w.type === 'team') w.cwd = dir; });
    }
  }
  fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: s, ui: {} }));
}

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
await seed();
launch(UD);
let main = await connect(/\/src\/index\.html$/);
let pop = null;
try {
  await sleep(1500);
  const kvKey = await ev(main, `FlowNotes.key(${JSON.stringify(KV)})`);
  const stale = await ev(main, 'window.__flow.state().pages');
  R.ok('the FlatCake page has a record from the seed', !!stale[kvKey] && stale[kvKey].note.startsWith('new serving infrastructure'), stale[kvKey] && stale[kvKey].note.slice(0, 40));

  // pop out the research sub-workspace (it holds the FlatCake page window) with a real click
  const zrow = await ev(main, `(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => (x.dataset.act || '') === 'zone|z-research'); if (!r) return null; r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const x = r.querySelector('[data-zpop]'); const b = (x || r).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, pop: !!x }; })()`);
  R.ok('the research sub-workspace has a pop-out button in the sidebar', !!zrow && zrow.pop);
  await click(main, zrow.x, zrow.y);
  pop = await connect(/zone=z-research/);
  await sleep(1500);
  // in the pop-out: write in the FlatCake page's ✎ panel, its ✎ read once the view stands still
  if (!(await waitFor(pop, still, 8000))) throw new Error('the pop-out was still moving 8 s on');
  const pen = await waitFor(pop, `(() => { const b = document.querySelector('.win[data-id="w-kv"] .tb .act'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width ? { x: r.right - 8, y: r.top + r.height / 2 } : null; })()`, 10000);
  await click(pop, pen.x, pen.y);
  await sleep(500);
  if (!(await ev(pop, `!!(document.activeElement && document.activeElement.closest('.win[data-id="w-kv"] .npane'))`))) throw new Error('a click on ✎ in the pop-out did not give its note the keys');
  await type(pop, ' written in the pop-out');
  const reached = await waitFor(main, `(window.__flow.state().pages[${JSON.stringify(kvKey)}] || {}).note.endsWith(' written in the pop-out')`, 5000);
  R.ok('the edit made in the pop-out reaches the main window', !!reached);
  // another window's save that carries the older copy arrives: it must not undo the newer edit
  await ev(main, `FlowNotes.remote(${JSON.stringify(stale)})`);
  const kept = await ev(main, `window.__flow.state().pages[${JSON.stringify(kvKey)}].note`);
  R.ok('an older copy from another window does not undo the newer edit', kept.endsWith(' written in the pop-out'), kept.slice(-40));
  // a record only one window has stays when another window's doc lacks it
  const ONLY = 'https://example.com/only-here';
  await ev(main, `FlowNotes.renamePage(${JSON.stringify(ONLY)}, 'only here', 'Only here')`);
  await ev(main, `FlowNotes.remote(${JSON.stringify(stale)})`);
  R.ok('a record another window has not seen yet stays', (await ev(main, `FlowNotes.nameOf(${JSON.stringify(ONLY)})`)) === 'only here');
  const onlyKey = await ev(main, `FlowNotes.key(${JSON.stringify(ONLY)})`);
  R.ok('the pop-out gets the new record', !!(await waitFor(pop, `FlowNotes.nameOf(${JSON.stringify(ONLY)}) === 'only here'`, 5000)));
  const withOnly = await ev(pop, 'window.__flow.state().pages');

  // the same moment in two windows: the main window deletes that record (its x in the sidebar's search), the pop-out
  // types in the FlatCake note; both saves reach the store within one write
  const qb = await ev(main, `(() => { const r = document.getElementById('q').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  await click(main, qb.x, qb.y);
  await type(main, 'only here');
  const xb = await waitFor(main, `(() => { const x = document.querySelector('#sblist [data-delpage=${JSON.stringify(onlyKey)}]'); if (!x) return null; const r = x.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`, 5000);
  R.ok('the sidebar\'s search finds the record with its x', !!xb);
  const typedAt = await ev(pop, `window.__flow.state().pages[${JSON.stringify(kvKey)}].note.length`);
  // measured again right before the click (the search list can still be filling), with what is under that point
  const at = await ev(main, `(() => { const x = document.querySelector('#sblist [data-delpage=${JSON.stringify(onlyKey)}]'); const r = x.getBoundingClientRect(); const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; const e = document.elementFromPoint(p.x, p.y); return { ...p, under: e ? (e.dataset.delpage ? 'its x' : e.className || e.tagName) : '' }; })()`);
  await Promise.all([click(main, at.x, at.y), key(pop, '!')]);
  const both = await waitFor(pop, `!FlowNotes.nameOf(${JSON.stringify(ONLY)}) && window.__flow.state().pages[${JSON.stringify(kvKey)}].note.endsWith('pop-out!')`, 5000);
  R.ok('saved at the same moment: the pop-out has the deletion and its own keystroke', !!both, { under: at.under, ...(await ev(pop, `({ only: FlowNotes.nameOf(${JSON.stringify(ONLY)}), kv: window.__flow.state().pages[${JSON.stringify(kvKey)}].note.slice(${typedAt} - 12) })`)) });
  const both2 = await waitFor(main, `!FlowNotes.nameOf(${JSON.stringify(ONLY)}) && window.__flow.state().pages[${JSON.stringify(kvKey)}].note.endsWith('pop-out!')`, 5000);
  R.ok('saved at the same moment: the main window has the deletion and the pop-out\'s keystroke', !!both2, await ev(main, `({ only: FlowNotes.nameOf(${JSON.stringify(ONLY)}), kv: window.__flow.state().pages[${JSON.stringify(kvKey)}].note.slice(-12) })`));
  // the store writes a moment after the windows have it, later under load: the file is read until it has both, up
  // to 5 s
  let disk1 = {};
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(200)) {
    disk1 = JSON.parse(fs.readFileSync(path.join(UD, 'flow-state.json'), 'utf8')).pages || {};
    if (disk1[onlyKey] && disk1[onlyKey].gone && disk1[kvKey] && String(disk1[kvKey].note).endsWith('pop-out!')) break;
  }
  R.ok('saved at the same moment: flow-state.json has both', !!(disk1[onlyKey] && disk1[onlyKey].gone) && !!disk1[kvKey] && String(disk1[kvKey].note).endsWith('pop-out!'), { only: disk1[onlyKey], kv: disk1[kvKey] && String(disk1[kvKey].note).slice(-12) });
  await ev(pop, `FlowNotes.remote(${JSON.stringify(withOnly)})`);
  R.ok('an older copy does not bring the deleted record back', !(await ev(pop, `FlowNotes.nameOf(${JSON.stringify(ONLY)})`)));
  // a deletion made in one window reaches the other and is not undone by an older copy
  await ev(main, `FlowNotes.deletePage(${JSON.stringify(kvKey)}) ? 1 : 0`);
  const goneInPop = await waitFor(pop, `!FlowNotes.records().some((r) => r.key === ${JSON.stringify(kvKey)})`, 5000);
  R.ok('a page deleted in the main window is gone in the pop-out', !!goneInPop);
  await ev(pop, `FlowNotes.remote(${JSON.stringify(stale)})`);
  R.ok('an older copy does not bring a deleted page back', !(await ev(pop, `FlowNotes.records().some((r) => r.key === ${JSON.stringify(kvKey)})`)));
  await sleep(1200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(UD, 'flow-state.json'), 'utf8')).pages || {};
  R.ok('flow-state.json holds both deletions', !!(onDisk[kvKey] && onDisk[kvKey].gone) && !!(onDisk[onlyKey] && onDisk[onlyKey].gone), { kv: onDisk[kvKey], only: onDisk[onlyKey] });
  const errs = [...main.errors, ...pop.errors].filter((e) => !e.startsWith('console.warning'));
  R.ok('no console errors in either window', errs.length === 0, errs.slice(0, 3).join(' | '));
  // a restart: what was deleted stays deleted
  main.ws.close();
  pop.ws.close();
  pop = null;
  await quit();
  launch(UD);
  main = await connect(/\/src\/index\.html$/);
  await sleep(3000);
  const back = await ev(main, `({ kv: FlowNotes.records().some((r) => r.key === ${JSON.stringify(kvKey)}), only: FlowNotes.nameOf(${JSON.stringify(ONLY)}), left: FlowNotes.records().length })`);
  R.ok('after a restart both deleted records stay deleted, and the others are back', back.left > 0 && !back.kv && !back.only, back);
  R.ok('no console errors after the restart', main.errors.filter((e) => !e.startsWith('console.warning')).length === 0, main.errors.slice(0, 3).join(' | '));
} catch (err) {
  R.ok(`run stopped: ${err.message}`, false);
} finally {
  try { main.ws.close(); if (pop) pop.ws.close(); } catch (e) { console.error('closing CDP:', e.message); }
  if (process.env.NOTES_KEEP) console.log('NOTES_KEEP: the app is left running on 9566');
  else await cleanup();
}
R.summary();




