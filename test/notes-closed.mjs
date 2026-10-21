// notes' check of item 30: a page window closed with nothing written, saved or named leaves no ws.notes entry; one
// with something of the owner's keeps it, and so does its record, also after a restart. Removing a sub-workspace with
// pages takes nothing with it (lead, Nov 2 15:5x): its windows move into main with their entries and notes, its undo
// puts them back, and nothing goes once the undo is gone; its plain page closed in main then leaves no entry. A page
// window whose entry is missing (a state that should not happen) removes no note when it closes: every other note
// stays, in its order. A local server serves the pages. Real input over CDP on notes' isolated app (userData /tmp/flow-dev-notes, socket flow-dev-notes, CDP 9566),
// started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-closed.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, dblclick, mouse, key, type, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const R = reporter();

const NAMES = ['written', 'saved', 'named', 'plain'];
const ZONED = ['written2', 'plain2'];
const ORPHANS = ['orphan', 'orphan2'];
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0].slice(1);
  if (![...NAMES, ...ZONED, ...ORPHANS].includes(p)) { res.writeHead(404); res.end('not here'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>The ${p} page</title></head><body style="font:32px sans-serif"><p>the ${p} page</p></body></html>`);
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
const ev = (p, e) => evaluate(p, e);
async function waitFor(p, expr, ms) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) { v = await ev(p, expr); if (v) return v; }
  return v;
}
const center = (p, sel) => ev(p, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(path.join(UD, 'cwd'), { recursive: true });
const ws = { id: 'c', name: 'closing', folder: path.join(UD, 'cwd'), bg: '#141319', zones: [{ id: 'z-read', name: 'reading' }], closed: [], notes: [], windows: [], saved: [] };
ws.notes.push({ id: 'n-first', kind: 'note', title: 'the first note', body: 'first' });
[...NAMES, ...ZONED].forEach((x, i) => {
  ws.notes.push({ id: `p-${x}`, kind: 'page', title: `The ${x} page`, url: `${BASE}/${x}`, body: '' });
  ws.windows.push({ id: `w-${x}`, type: 'page', noteId: `p-${x}`, x: 1.2 + (i % 2) * 49, y: 6.6 + Math.floor((i % 4) / 2) * 46, w: 48, h: 44, ...(ZONED.includes(x) ? { zone: 'z-read' } : {}) });
});
ws.notes.push({ id: 'n-last', kind: 'note', title: 'the last note', body: 'keep me' });
// page windows whose entry is missing: one on the desktop, one in the sub-workspace
ws.windows.push({ id: 'w-orphan', type: 'page', noteId: 'p-gone', tabs: [{ url: `${BASE}/orphan`, title: 'The orphan page' }], tab: 0, x: 60, y: 30, w: 30, h: 30 });
ws.windows.push({ id: 'w-orphan2', type: 'page', noteId: 'p-gone2', tabs: [{ url: `${BASE}/orphan2`, title: 'The orphan2 page' }], tab: 0, x: 60, y: 30, w: 30, h: 30, zone: 'z-read' });
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [ws], ui: {}, pages: {} }));

launch();
let p = await connect();
try {
  const st = () => ev(p, 'window.__flow.state()');
  for (const x of NAMES) {
    const ok = await waitFor(p, `(() => { const w = window.__flow.state().ws[0].windows.find((w) => w.id === 'w-${x}'); const t = w && w.tabs && w.tabs[w.tab || 0]; return !!(t && t.url === ${JSON.stringify(`${BASE}/${x}`)}); })()`, 15000);
    if (!ok) throw new Error(`the ${x} page did not load`);
  }
  await sleep(800);
  const ids = (s) => s.ws[0].notes.map((n) => n.id).join(' ');
  const start = await st();
  R.ok('the page windows without an entry are there, their entries missing', ORPHANS.every((x) => start.ws[0].windows.some((w) => w.id === `w-${x}`)) && !start.ws[0].notes.some((n) => n.id === 'p-gone' || n.id === 'p-gone2'), ids(start));
  // written: a line in its ✎ panel
  const pen = await ev(p, `(() => { const b = document.querySelector('.win[data-id="w-written"] .tb .act'); const r = b.getBoundingClientRect(); return { x: r.right - 8, y: r.top + r.height / 2 }; })()`);
  await click(p, pen.x, pen.y);
  await sleep(500);
  await type(p, 'a line about it');
  R.ok('written: the line is in the page\'s record', !!(await waitFor(p, `(window.__flow.state().pages[FlowNotes.key(${JSON.stringify(`${BASE}/written`)})] || {}).note === 'a line about it'`, 5000)));
  // saved: the star in its address bar
  const tb = await center(p, '.win[data-id="w-saved"] .tb .title');
  await click(p, tb.x, tb.y);
  await sleep(300);
  const star = await center(p, '.win[data-id="w-saved"] .pstar');
  R.ok('saved: the page has a star', !!star);
  await click(p, star.x, star.y);
  R.ok('saved: the star saves it', !!(await waitFor(p, `window.__flow.state().ws[0].saved.some((s) => s.url.startsWith(${JSON.stringify(`${BASE}/saved`)}))`, 5000)));
  // its row's hover card names the page as the row does and shows its site once (nothing written about it yet)
  const srow = await waitFor(p, `(() => { const r = [...document.querySelectorAll('#sblist .tr[data-act^="saved|"]')].find((x) => x.textContent.includes('The saved page')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`, 5000);
  await mouse(p, 'mouseMoved', srow.x, srow.y);
  const card = await waitFor(p, `(() => { const c = document.querySelector('body > .sbcard'); return c ? [...c.querySelectorAll('.nbrief > div')].map((d) => d.textContent) : null; })()`, 5000);
  R.ok('saved: its hover card names it as its row does and shows the site once', !!card && card[0] === 'The saved page' && card.filter((t) => t === '127.0.0.1').length === 1 && new Set(card).size === card.length, card);
  await mouse(p, 'mouseMoved', 5, 5);
  // named: a double-click on its row in the sidebar, a name, Enter
  const row = await center(p, '#sblist .tr[data-act="tab|w-named|0"] .l');
  R.ok('named: its tab has a row in the sidebar', !!row);
  await dblclick(p, row.x, row.y);
  // the first click gave the page the keys, which Electron lands in two steps: past page.js's 500 ms hand-back, the
  // name field the double-click opened must still have them
  await sleep(700);
  const keys = await ev(p, `(() => { const a = document.activeElement; const w = a && a.closest && a.closest('.win'); return a && a.classList.contains('rn') && a.closest('#sblist') && document.hasFocus() ? '' : \`\${a ? a.tagName : 'nothing'}\${w ? \` in \${w.dataset.id}\` : ''}, the window \${document.hasFocus() ? 'has' : 'lost'} the keys\`; })()`);
  if (keys) throw new Error(`the name field the double-click opened lost the keys to ${keys}`);
  await key(p, 'End');
  for (let i = 0; i < 40; i++) await key(p, 'Backspace');
  await type(p, 'my named page');
  await key(p, 'Enter');
  R.ok('named: the name is in the page\'s record', !!(await waitFor(p, `FlowNotes.nameOf(${JSON.stringify(`${BASE}/named`)}) === 'my named page'`, 5000)));
  // close all four with the red light, and the window without an entry (the star made a "saved" section in the notes)
  const order0 = ids(await st());
  for (const x of [...NAMES, 'orphan']) {
    const red = await center(p, `.win[data-id="w-${x}"] [data-l=close]`);
    if (!red) throw new Error(`no red light on w-${x}`);
    await click(p, red.x, red.y);
    await waitFor(p, `!window.__flow.state().ws[0].windows.some((w) => w.id === 'w-${x}')`, 5000);
  }
  await sleep(1200);
  const entries = (s, of = NAMES) => s.ws[0].notes.filter((n) => n.kind === 'page' && of.some((x) => n.id === `p-${x}`)).map((n) => n.id).sort().join(' ');
  const s1 = await st();
  R.ok('closed: all four windows are gone', !s1.ws[0].windows.some((w) => NAMES.some((x) => w.id === `w-${x}`)), s1.ws[0].windows.map((w) => w.id));
  R.ok('closed: the plain page leaves no entry, the written, saved and named ones keep theirs', entries(s1) === 'p-named p-saved p-written', entries(s1));
  const disk = JSON.parse(fs.readFileSync(path.join(UD, 'flow-state.json'), 'utf8'));
  R.ok('closed: flow-state.json has the same entries', entries(disk) === 'p-named p-saved p-written', entries(disk));
  const order1 = order0.split(' ').filter((x) => x !== 'p-plain').join(' ');
  R.ok('closed: the window without an entry removes no note; every other note stays, in its order', ids(s1) === order1, ids(s1));

  // a sub-workspace with a written page, a plain one and one without an entry, removed from the sidebar (right-click, remove)
  const zrow = await center(p, '#sblist .tr[data-act="zone|z-read"]');
  await click(p, zrow.x, zrow.y);
  // the view moves to the sub-workspace: wait until its ✎ stays put and is what a click there hits
  let pen2 = null;
  for (let i = 0, last = ''; i < 60 && !pen2; i++, await sleep(250)) {
    const at = await ev(p, `(() => { const b = document.querySelector('.win[data-id="w-written2"] .tb .act'); if (!b) return null; const r = b.getBoundingClientRect(); const x = r.right - 8, y = r.top + r.height / 2; return r.width && document.elementFromPoint(x, y) === b ? { x, y } : null; })()`);
    if (at && JSON.stringify(at) === last) pen2 = at;
    last = JSON.stringify(at);
  }
  if (!pen2) throw new Error('the sub-workspace\'s page has no ✎ to click');
  await click(p, pen2.x, pen2.y);
  await sleep(500);
  await type(p, 'written in the sub-workspace');
  R.ok('sub-workspace: the line is in its page\'s record', !!(await waitFor(p, `(window.__flow.state().pages[FlowNotes.key(${JSON.stringify(`${BASE}/written2`)})] || {}).note === 'written in the sub-workspace'`, 5000)));
  const removeIt = async () => {
    const at = await center(p, '#sblist .tr[data-act="zone|z-read"]');
    await mouse(p, 'mouseMoved', at.x, at.y);
    await mouse(p, 'mousePressed', at.x, at.y, { button: 'right', buttons: 2 });
    await mouse(p, 'mouseReleased', at.x, at.y, { button: 'right', buttons: 0 });
    const item = await waitFor(p, `(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => x.textContent.startsWith('remove')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, 3000);
    if (!item) throw new Error('no remove in the sub-workspace\'s menu');
    await click(p, item.x, item.y);
    await waitFor(p, `!window.__flow.state().ws[0].zones.some((z) => z.id === 'z-read')`, 5000);
    await sleep(600);
  };
  const order1b = ids(await st());
  const where = (s, xs) => xs.map((x) => { const w = s.ws[0].windows.find((o) => o.id === `w-${x}`); return w ? `${x}${w.zone ? ` in ${w.zone}` : ''}` : `${x} gone`; }).join(' ');
  const ZW = [...ZONED, 'orphan2'];
  const key2 = await ev(p, `FlowNotes.key(${JSON.stringify(`${BASE}/written2`)})`);
  const note2 = (s) => (s.pages[key2] || {}).note;
  await removeIt();
  const s3 = await st();
  R.ok('sub-workspace removed: its page windows move into main, none closed', where(s3, ZW) === ZW.join(' '), where(s3, ZW));
  R.ok('sub-workspace removed: every note stays, in its order, its pages\' entries too', ids(s3) === order1b, ids(s3));
  R.ok('sub-workspace removed: the line stays in its page\'s record', note2(s3) === 'written in the sub-workspace', note2(s3));
  const undo = await center(p, '#toast.on button');
  R.ok('the toast offers undo', !!undo);
  await click(p, undo.x, undo.y);
  await sleep(800);
  const s4 = await st();
  R.ok('undo puts the sub-workspace and its windows back, each note where it was', s4.ws[0].zones.some((z) => z.id === 'z-read') && where(s4, ZW) === ZW.map((x) => `${x} in z-read`).join(' ') && ids(s4) === order1b, `${where(s4, ZW)}; ${ids(s4)}`);
  await removeIt();
  await sleep(9000);
  const s5 = await st();
  R.ok('once the undo is gone, nothing of the sub-workspace\'s has gone: every note, in its order, and the line', ids(s5) === order1b && note2(s5) === 'written in the sub-workspace' && where(s5, ZW) === ZW.join(' '), `${where(s5, ZW)}; ${ids(s5)}`);
  // its plain page and the window without an entry, now in main, closed with their red lights (each brought into
  // view from its row first)
  for (const x of ['plain2', 'orphan2']) {
    const r = await center(p, `#sblist .tr[data-act="tab|w-${x}|0"] .l`);
    if (!r) throw new Error(`no row for w-${x}`);
    await click(p, r.x, r.y);
    let red = null;
    for (let i = 0, last = ''; i < 60 && !red; i++, await sleep(250)) {
      const at = await ev(p, `(() => { const b = document.querySelector('.win[data-id="w-${x}"] [data-l=close]'); if (!b) return null; const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return r.width && document.elementFromPoint(x, y) === b ? { x, y } : null; })()`);
      if (at && JSON.stringify(at) === last) red = at;
      last = JSON.stringify(at);
    }
    if (!red) throw new Error(`w-${x}'s red light is not where a click lands`);
    await click(p, red.x, red.y);
    await waitFor(p, `!window.__flow.state().ws[0].windows.some((w) => w.id === 'w-${x}')`, 5000);
  }
  await sleep(1200);
  const s6 = await st();
  const order2 = order1b.split(' ').filter((x) => x !== 'p-plain2').join(' ');
  R.ok('closed in main: the plain page leaves no entry, the written one keeps its; the window without an entry removes no note', entries(s6, ZONED) === 'p-written2' && ids(s6) === order2, `${entries(s6, ZONED)}; ${ids(s6)}`);
  // restart
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  p.ws.close();
  await quit();
  launch();
  p = await connect();
  await sleep(2000);
  const s2 = await st();
  R.ok('after a restart: the same notes in the same order', ids(s2) === order2, ids(s2));
  R.ok('after a restart: the line, the saved page and the name are there',
    (s2.pages[await ev(p, `FlowNotes.key(${JSON.stringify(`${BASE}/written`)})`)] || {}).note === 'a line about it'
    && s2.ws[0].saved.some((s) => s.url.startsWith(`${BASE}/saved`))
    && (await ev(p, `FlowNotes.nameOf(${JSON.stringify(`${BASE}/named`)})`)) === 'my named page');
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




