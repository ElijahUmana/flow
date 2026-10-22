// notes' check of a note's name (batch 5): one name in its sidebar row, ⌘K and its window's title: the title the owner
// gave it, else its first line, else "new note"; a blank title is no title. The heading holds only the owner's title and
// says "new note" (faintly) only while the whole note is empty; the body has no placeholder. Real input over CDP on
// notes' isolated app (userData /tmp/flow-dev-notes, socket flow-dev-notes, CDP 9566), started from FLOW_DIR.
//   FLOW_DIR=<tree> node test/notes-name.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, mouse, key, type, MOD, reporter } from './ui-lib.mjs';

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
const ev = (p, e) => evaluate(p, e);
async function waitFor(p, expr, ms) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { v = await ev(p, expr); if (v) return v; }
  return v;
}
const center = (p, sel) => ev(p, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
/* What the owner sees for note nid: its sidebar row's label, its window's title, its heading's text and faint text, and
   the body's faint text. */
const LABEL = `const label = (el) => { if (!el) return null; const c = el.cloneNode(true); c.querySelectorAll('.p').forEach((x) => x.remove()); return c.textContent; };`;
const rowName = (nid) => `(() => { ${LABEL} return label(document.querySelector('#sblist .tr[data-act="note|${nid}"] .l')); })()`;
const seen = (p, nid) => ev(p, `(() => { ${LABEL}
  const row = document.querySelector('#sblist .tr[data-act="note|${nid}"] .l');
  const w = window.__flow.windows().find((x) => x.noteId === ${JSON.stringify(nid)});
  const h = document.querySelector('.ntitle[data-key="title:${nid}"]'), b = document.querySelector('.nbody[data-key="note:${nid}"]');
  return { row: label(row), title: w ? w.title : null, heading: h ? h.textContent : null,
    headingFaint: h && !h.textContent ? h.dataset.ph : '', bodyFaint: b && !b.textContent ? b.dataset.ph || '' : '' };
})()`);
async function newNote(p) {
  const before = await ev(p, 'window.__flow.state().ws[0].notes.map((n) => n.id)');
  const dock = await center(p, '.dock [data-k=note]');
  await mouse(p, 'mouseMoved', dock.x, dock.y);
  await sleep(400);
  await click(p, dock.x, dock.y);
  const nid = await waitFor(p, `(() => { const n = window.__flow.state().ws[0].notes.find((n) => !${JSON.stringify(before)}.includes(n.id) && n.kind === 'note'); return n ? n.id : ''; })()`, 5000);
  await sleep(500);
  return nid;
}

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(path.join(UD, 'cwd'), { recursive: true });
const ws = { id: 'c', name: 'naming', folder: path.join(UD, 'cwd'), bg: '#141319', zones: [], closed: [], notes: [], windows: [], saved: [] };
// a note from before titles could be left unset: its default title counts as none, an owner's title as given
ws.notes.push({ id: 'n-old-default', kind: 'note', title: 'new note', body: 'an old note that was never named' });
ws.notes.push({ id: 'n-old-titled', kind: 'note', title: 'my old title', body: 'its body' });
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [ws], ui: {}, pages: {} }));

launch();
let p = await connect();
try {
  await sleep(1500);
  const old1 = await seen(p, 'n-old-default'), old2 = await seen(p, 'n-old-titled');
  R.ok('an old note with the default title is named by its first line', old1.row === 'an old note that was never named', old1);
  R.ok('an old note with the owner\'s title keeps it', old2.row === 'my old title', old2);

  // a new note: the caret is in an empty heading that says "new note" faintly; the body has no placeholder
  const nid = await newNote(p);
  R.ok('the dock ✎ makes a note with the caret in its heading', (await ev(p, 'document.activeElement && document.activeElement.dataset.key')) === `title:${nid}`);
  const s0 = await seen(p, nid);
  R.ok('a new note: an empty heading that says "new note" faintly, the row and title "new note", no body placeholder',
    s0.heading === '' && s0.headingFaint === 'new note' && s0.row === 'new note' && s0.title === 'new note' && s0.bodyFaint === '', s0);

  // the body gets a first line: the note is named by it; the heading stays blank, with no faint text
  await key(p, 'Enter');
  await type(p, '[ ] groceries for the week');
  await key(p, 'Enter');
  await type(p, 'milk');
  const s1 = await waitFor(p, `${rowName(nid)} === 'groceries for the week'`, 5000) && await seen(p, nid);
  R.ok('with a first line the note is named by it in the row and the window title; the heading stays blank, not faint',
    !!s1 && s1.row === 'groceries for the week' && s1.title === 'groceries for the week' && s1.heading === '' && s1.headingFaint === '', s1);

  // ⌘K finds it by that name
  const q = await center(p, '#q');
  await click(p, q.x, q.y);
  await type(p, 'groceries');
  const found = await waitFor(p, `${rowName(nid)} === 'groceries for the week' && ${rowName(nid)}`, 5000);
  R.ok('⌘K shows the note under that name', found === 'groceries for the week', found);
  await key(p, 'a', MOD.ctrl);
  await key(p, 'Backspace');
  await sleep(400);

  // the owner gives it a title in the heading: that name everywhere
  const h = await center(p, `.ntitle[data-key="title:${nid}"]`);
  await click(p, h.x, h.y);
  await type(p, 'weekly shop');
  const s2 = await waitFor(p, `${rowName(nid)} === 'weekly shop'`, 5000) && await seen(p, nid);
  R.ok('a title typed in the heading names the note in the row and the window title', !!s2 && s2.row === 'weekly shop' && s2.title === 'weekly shop' && s2.heading === 'weekly shop', s2);

  // the owner clears the title: no title again, so the first line names it
  await key(p, 'a', MOD.ctrl);
  await key(p, 'Backspace');
  const s3 = await waitFor(p, `${rowName(nid)} === 'groceries for the week'`, 5000) && await seen(p, nid);
  R.ok('clearing the title names the note by its first line again', !!s3 && s3.row === 'groceries for the week' && s3.title === 'groceries for the week' && s3.heading === '' && s3.headingFaint === '', s3);

  // a second new note, left empty: "new note", and the two rows can be told apart
  const nid2 = await newNote(p);
  await key(p, 'Escape');
  const t = await seen(p, nid2);
  R.ok('an empty second note is "new note", and the rows can be told apart', t.row === 'new note' && (await seen(p, nid)).row === 'groceries for the week', { second: t.row });

  // after a restart: the same names
  await sleep(1200);
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  p.ws.close();
  await quit();
  launch();
  p = await connect();
  await sleep(2000);
  const a = await seen(p, nid), b = await seen(p, nid2), c = await seen(p, 'n-old-default');
  R.ok('after a restart: the same names', a.row === 'groceries for the week' && b.row === 'new note' && c.row === 'an old note that was never named', { a: a.row, b: b.row, c: c.row });
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




