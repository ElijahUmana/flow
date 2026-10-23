// notes' check that ⌘Z in a note takes back what was typed as the Mac does (browse, Nov 2: it took typing back a few
// letters at a time, because Chromium ends a typing run whenever any node in the window is removed): a run typed with
// the caret left alone is one step, also while a terminal in the same window prints and on a checklist line, whose box
// stays the same element; a caret move starts a new step; a run of deletes is one step; a tick is one of its own; ⇧⌘Z
// brings a step back, by the keys and by Edit > Undo and Redo (the menu's own items clicked in the main process, for
// the Flow window); a note's title the same (batch 11: it took a title back a letter at a time); what is undone is what the note keeps. Typing in a titled note leaves the sidebar alone, and an
// untitled note's row still follows its first line. Real key presses over CDP on notes' isolated app (userData /tmp/flow-dev-notes, socket
// flow-dev-notes, CDP 9566), started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-undo.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, mouse, key, type, MOD, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, INSPECT = 9666, MARK = '--flow-dev=notes';
const R = reporter();
const GAP = 150;

const pids = () => spawnSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARK}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
async function cleanup() {
  for (const p of pids()) process.kill(+p, 'SIGKILL');
  for (let i = 0; i < 40 && pids().length; i++) await sleep(250);
  spawnSync('tmux', ['-L', SOCK, 'kill-server']);
}
await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(path.join(UD, 'cwd'), { recursive: true });
const WS = { id: 'u', name: 'undo', folder: path.join(UD, 'cwd'), bg: '#141319', zones: [], closed: [], saved: [],
  notes: [{ id: 'n-x', kind: 'note', title: 'groceries', titleSet: true, body: '' }, { id: 'n-y', kind: 'note', title: 'new note', body: '' }],
  windows: [{ id: 'w-n', type: 'note', noteId: 'n-x', x: 2, y: 8, w: 30, h: 40 }, { id: 'w-y', type: 'note', noteId: 'n-y', x: 2, y: 52, w: 30, h: 28 }] };
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [WS], ui: {}, pages: {} }));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
const log = fs.openSync(path.join(UD, 'app.log'), 'a');
spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${UD}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`,
  'FLOW_BACKGROUND=1', './node_modules/.bin/electron', `--inspect=${INSPECT}`, '.', '--no-sandbox', MARK], { cwd: DIR, env, stdio: ['ignore', log, log], detached: true }).unref();

const ED = `document.querySelector('.win[data-id="w-n"] .fnote-ed[data-key^="note:"]')`;
async function waitFor(expr, ms) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { v = await evaluate(p, expr); if (v) return v; }
  return v;
}
/* True once nothing slides: a window opened past the others brings the view to it with a CSS transition (nav). */
const still = `!document.getAnimations().some((a) => 'transitionProperty' in a && a.effect && a.effect.target && a.effect.target.matches('.track, .canvas, .win, .sb'))`;
/* Counts what is taken out of the elements sel matches from now on; mutes() reads and stops it. */
const watch = (sel) => evaluate(p, `(() => { window.__out = 0; if (window.__mo) window.__mo.disconnect(); window.__mo = new MutationObserver((ms) => { for (const m of ms) window.__out += m.removedNodes.length; }); for (const e of document.querySelectorAll(${JSON.stringify(sel)})) window.__mo.observe(e, { childList: true, subtree: true }); return document.querySelectorAll(${JSON.stringify(sel)}).length; })()`);
const mutes = () => evaluate(p, '(() => { window.__mo.disconnect(); return window.__out; })()');
let p;
const text = () => evaluate(p, `${ED}.textContent.replace(/\\n$/, '')`);
const kept = () => evaluate(p, `window.__flow.state().ws[0].notes.find((n) => n.id === 'n-x').body`);
const typeSlow = async (s) => { for (const ch of s) { await key(p, ch); await sleep(GAP); } };
const undo = async () => { await key(p, 'z', MOD.ctrl); await sleep(250); return text(); };
const redo = async () => { await key(p, 'z', MOD.ctrl | MOD.shift); await sleep(250); return text(); };
/* Edit > Undo and Redo: the main process clicks the Edit menu's own item for the Flow window, as a click in the menu
   bar does (a role item calls the window's undo() or redo(), a Flow action sends it to the window). */
let main = null;
const menu = async (what) => {
  const label = what === 'undo' ? 'Undo' : 'Redo';
  await evaluate(main, `(() => { const { Menu, BrowserWindow, webContents } = require('electron'); const host = webContents.getAllWebContents().find((w) => /\\/src\\/index\\.html$/.test(w.getURL())); const edit = Menu.getApplicationMenu().items.find((i) => i.label === 'Edit'); const it = edit && edit.submenu.items.find((i) => i.label === ${JSON.stringify(label)}); if (!it) throw new Error('no ${label} in the Edit menu'); it.click(undefined, BrowserWindow.fromWebContents(host), host); return true; })()`, true);
  await sleep(300);
  return text();
};
/* A click on a part of editor sel that is in view and not under another window; it must give that note the keys. */
async function clickInto(sel) {
  if (!(await waitFor(still, 8000))) throw new Error('the view was still moving before a click in a note');
  const at = await evaluate(p, `(() => { const ed = document.querySelector(${JSON.stringify(sel)}); const r = ed.getBoundingClientRect(); for (let y = r.top + 8; y < r.bottom - 4; y += 12) for (let x = r.left + 12; x < r.right - 8; x += 24) { const e = document.elementFromPoint(x, y); if (e && ed.contains(e)) return { x, y }; } return null; })()`);
  if (!at) throw new Error(`no part of ${sel} is clickable (${await evaluate(p, 'JSON.stringify(window.__flow.state().ws[0].windows.map((w) => [w.id, Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h)]))')})`);
  await click(p, at.x, at.y);
  if (!(await evaluate(p, `document.activeElement === document.querySelector(${JSON.stringify(sel)})`))) throw new Error(`a click in ${sel} did not give it the keys`);
}
const NOTE_ED = '.win[data-id="w-n"] .fnote-ed[data-key^="note:"]';
/* Empties the note with real keys and gives it the caret at its end. */
async function fresh(start = '') {
  await clickInto(NOTE_ED);
  await key(p, 'a', MOD.ctrl);
  await key(p, 'Backspace');
  for (const ch of start) await key(p, ch === '\n' ? 'Enter' : ch);
  await sleep(300);
  await key(p, 'End', MOD.ctrl);
  await sleep(200);
  // what was set up is a run of its own: the caret moves before the run under test
  if (start) await moveCaret();
}
/* Ends the run as the owner would, by moving the caret: one left and back. */
async function moveCaret() {
  await key(p, 'ArrowLeft');
  await key(p, 'ArrowRight');
  await sleep(200);
}

try {
  p = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 160 && !(await evaluate(p, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  await evaluate(p, 'window.__flow.ready.then(() => true)');
  await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (let i = 0; i < 40 && !(await evaluate(p, `!!${ED}`)); i++) await sleep(250);
  main = await connectTo(INSPECT, /./, 'node');
  const SENT = 'the quick brown fox jumps over the lazy dog';
  // one run typed slowly: one step back, one step forward; the note is titled, so the sidebar has nothing to redraw
  await fresh();
  await watch('#sblist');
  await typeSlow(SENT);
  await sleep(600);
  const redrawn = await mutes();
  const typed = await text();
  const back = await undo();
  const keptBack = await kept();
  const fwd = await redo();
  R.ok('a sentence typed slowly goes in one ⌘Z, and ⇧⌘Z brings it back', typed === SENT && back === '' && fwd === SENT, { typed, back, fwd });
  R.ok('what is undone is what the note keeps', keptBack === '', JSON.stringify(keptBack));
  R.ok('typing in a titled note leaves the sidebar alone', redrawn === 0, `${redrawn} rows taken out`);

  // the same while a terminal in this window prints (a shell, 20 lines a second, the way an agent's output redraws it)
  const terms0 = await evaluate(p, 'window.__flow.state().ws[0].windows.filter((w) => w.type === "term").map((w) => w.id)');
  if (!(await waitFor(still, 8000))) throw new Error('the view was still moving before the right-click');
  const bare = await evaluate(p, `(() => { const v = document.getElementById('viewport').getBoundingClientRect(), n = document.querySelector('.win[data-id="w-n"]').getBoundingClientRect(); for (let y = v.top + 60; y < v.bottom - 90; y += 30) for (let x = n.right + 40; x < v.right - 70; x += 30) { const e = document.elementFromPoint(x, y); if (e && e.closest('#viewport') && !e.closest('.win, .ctx, #dock')) return { x, y }; } return null; })()`);
  await mouse(p, 'mouseMoved', bare.x, bare.y);
  await mouse(p, 'mousePressed', bare.x, bare.y, { button: 'right', buttons: 2 });
  await mouse(p, 'mouseReleased', bare.x, bare.y, { button: 'right', buttons: 0 });
  const item = await waitFor(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => /^new shell(?: here)?(?![\\w-])/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, 3000);
  if (!item) throw new Error('no "new shell" in the desktop\'s menu');
  await click(p, item.x, item.y);
  const sh = await waitFor(`(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.type === 'term' && !${JSON.stringify(terms0)}.includes(x.id)); return w ? w.id : ''; })()`, 8000);
  if (!sh) throw new Error('the right-click made no shell');
  if (!(await waitFor(`(() => { const t = window.__flow.term(${JSON.stringify(sh)}); return !!t && /\\S/.test(t.getText()); })()`, 15000))) throw new Error('the shell never showed a prompt');
  await waitFor(still, 8000);
  const scr = await evaluate(p, `(() => { const b = document.querySelector('.win[data-id="${sh}"] .xterm-screen').getBoundingClientRect(); return { x: b.right - 30, y: b.bottom - 12 }; })()`);
  await click(p, scr.x, scr.y);
  await sleep(300);
  await type(p, 'while :; do date +%s%N; sleep 0.05; done');
  await key(p, 'Enter');
  if (!(await waitFor(`(() => { const t = window.__flow.term(${JSON.stringify(sh)}); return !!t && t.getText().split(String.fromCharCode(10)).filter((l) => /^\\d{15,}$/.test(l.trim())).length > 5; })()`, 10000))) throw new Error('the shell is not printing');
  await fresh();
  await watch(`.win[data-id="${sh}"] .xterm-rows`);
  await typeSlow(SENT);
  const churn = await mutes();
  const termBack = await undo();
  const termFwd = await redo();
  R.ok('with a terminal printing in the same window, a typed run goes in one ⌘Z and ⇧⌘Z brings it back', churn > 0 && termBack === '' && termFwd === SENT, { churn, termBack, termFwd });
  await click(p, scr.x, scr.y);
  await key(p, 'c', MOD.ctrl);

  // on a checklist line, whose box is redrawn at every key
  await fresh('[ ] milk\n');
  const base = await text();
  await evaluate(p, `(() => { window.__box = document.querySelectorAll('.win[data-id="w-n"] .fnote-box')[1]; return !!window.__box; })()`);
  await typeSlow('eggs and bread');
  const sameBox = await evaluate(p, `document.querySelectorAll('.win[data-id="w-n"] .fnote-box')[1] === window.__box`);
  const onList = await text();
  const listBack = await undo();
  R.ok('typing on a checklist line goes in one ⌘Z, and its box stays the same element', onList === `${base}eggs and bread` && listBack === base && sameBox === true, { base, onList, listBack, sameBox });

  // Edit > Undo and Redo, the menu's way: one step each way, again and again, and after the keys' undo too
  await fresh();
  await typeSlow('alpha beta');
  const m1 = await menu('undo');
  const m2 = await menu('redo');
  const m3 = await menu('undo');
  const m4 = await menu('redo');
  R.ok('Edit > Undo takes the typed run back and Edit > Redo brings it, twice over', m1 === '' && m2 === 'alpha beta' && m3 === '' && m4 === 'alpha beta', { m1, m2, m3, m4 });
  await moveCaret();
  await typeSlow(' gamma');
  const k1 = await undo();
  const k2 = await menu('redo');
  const k3 = await menu('undo');
  const k4 = await menu('undo');
  const k5 = await menu('redo');
  R.ok('the keys and the menu move through the same steps, one at a time', k1 === 'alpha beta' && k2 === 'alpha beta gamma' && k3 === 'alpha beta' && k4 === '' && k5 === 'alpha beta', { k1, k2, k3, k4, k5 });

  // a caret move starts a new step
  await fresh();
  await typeSlow('hello ');
  await moveCaret();
  await typeSlow('world');
  const two = await text();
  const one = await undo();
  const none = await undo();
  R.ok('a caret move between two runs makes them two steps', two === 'hello world' && one === 'hello ' && none === '', { two, one, none });

  // a run of deletes is one step
  await fresh();
  await typeSlow('abcdef');
  await moveCaret();
  for (let i = 0; i < 3; i++) { await key(p, 'Backspace'); await sleep(GAP); }
  const cut = await text();
  const restored = await undo();
  R.ok('three Backspaces go back in one ⌘Z', cut === 'abc' && restored === 'abcdef', { cut, restored });

  // a tick is a step of its own
  await fresh('[ ] milk\n');
  const box = await evaluate(p, `(() => { const b = document.querySelector('.win[data-id="w-n"] .fnote-box'); const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return document.elementFromPoint(x, y) === b ? { x, y } : null; })()`);
  if (!box) throw new Error('the checklist box is not clickable');
  await click(p, box.x, box.y);
  await sleep(300);
  const ticked = await text();
  const unticked = await undo();
  R.ok('a tick goes back on its own', ticked.startsWith('[x] milk') && unticked.startsWith('[ ] milk'), { ticked, unticked });

  // a note's title: a run typed slowly is one step, by the keys and by the menu, a caret move makes two, and the note
  // and its row follow what is undone
  const TT = `document.querySelector('.win[data-id="w-n"] .ntitle')`;
  const title = () => evaluate(p, `${TT}.textContent`);
  const keptTitle = () => evaluate(p, `window.__flow.state().ws[0].notes.find((n) => n.id === 'n-x').title`);
  await clickInto('.win[data-id="w-n"] .ntitle');
  await key(p, 'End');
  for (let i = 0; i < 12; i++) await key(p, 'Backspace');
  await sleep(300);
  await moveCaret();
  const t0 = await title();
  await typeSlow('weekly groceries');
  const t1 = await title();
  await undo();
  const tTitle = await title(), tKept = await keptTitle();
  await redo();
  const tFwd = await title();
  R.ok('a title typed slowly goes in one ⌘Z, and ⇧⌘Z brings it back', t0 === '' && t1 === 'weekly groceries' && tTitle === '' && tFwd === 'weekly groceries', { t0, t1, tTitle, tFwd });
  R.ok('what is undone in a title is the note\'s title', tKept === '' && (await keptTitle()) === 'weekly groceries', { tKept, now: await keptTitle() });
  const rowNamed = await waitFor(`(() => { const r = document.querySelector('#sblist .tr[data-act="note|n-x"] .l'); return r && r.textContent.trim() === 'weekly groceries'; })()`, 4000);
  R.ok('the note\'s row follows its title back and forth', !!rowNamed);
  const mt1 = await menu('undo'), mtTitle = await title();
  const mt2 = await menu('redo'), mtTitle2 = await title();
  R.ok('Edit > Undo and Redo take a title\'s typed run back and forth in one step each', mtTitle === '' && mtTitle2 === 'weekly groceries', { mtTitle, mtTitle2 });
  await moveCaret();
  await typeSlow(' list');
  await moveCaret();
  await typeSlow(' now');
  const tt = await title();
  await undo();
  const tOne = await title();
  await undo();
  const tNone = await title();
  R.ok('a caret move between two runs in a title makes them two steps', tt === 'weekly groceries list now' && tOne === 'weekly groceries list' && tNone === 'weekly groceries', { tt, tOne, tNone });

  // an untitled note's row follows its first line
  await clickInto('.win[data-id="w-y"] .fnote-ed[data-key^="note:"]');
  await typeSlow('call the bank');
  const named = await waitFor(`(() => { const r = document.querySelector('#sblist .tr[data-act="note|n-y"]'); return r && r.textContent.includes('call the bank') ? r.textContent.trim() : ''; })()`, 4000);
  R.ok('an untitled note\'s row in the sidebar follows its first line', !!named, named);

  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  R.ok('no console errors in the app', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (err) {
  R.ok(`run stopped: ${err.message}`, false);
} finally {
  try { if (p) p.ws.close(); if (main) main.ws.close(); } catch (e) { console.error('closing CDP:', e.message); }
  await cleanup();
}
R.summary();




