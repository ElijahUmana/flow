// notes' check that a page window's side note and highlights follow the page it shows (owner, Nov 2 12:39): a link
// followed in the page, back, forward and a typed address each bring that page's own note and highlights; a new tab
// (⌘T in a page) and a new page window (the dock) start with their own, not the page beside them; a new tab has no page, so typing in its panel
// writes nothing anywhere until a page shows (lead, Nov 2); after a restart every page still has its note.
// Local pages; real input over CDP on notes' isolated app (userData /tmp/flow-dev-notes, socket flow-dev-notes, CDP
// 9566), started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-follow.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, mouse, key, type, MOD, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const R = reporter();

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:28px sans-serif">${body}</body></html>`;
const PAGES = {
  '/a': page('Page A', '<p>The first sentence of page a.</p><p><a id="go" href="/b">to page b</a></p>'),
  '/b': page('Page B', '<p>The only sentence of page b.</p>'),
  '/c': page('Page C', '<p>Page c says this.</p>'),
  '/d': page('Page D', '<p>Page d says that.</p>'),
  '/e': page('Page E', '<p>Page e has nothing written about it.</p>'),
};
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (!PAGES[p]) { res.writeHead(404); res.end('not here'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGES[p]);
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
  const pg = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 160 && !(await evaluate(pg, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  await evaluate(pg, 'window.__flow.ready.then(() => true)');
  await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return pg;
}
const ev = (p, e) => evaluate(p, e);
async function waitFor(p, expr, ms) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { v = await ev(p, expr); if (v) return v; }
  return v;
}
/* True once nothing slides: a window opened past the others brings the view to it with a CSS transition (nav). */
const still = `!document.getAnimations().some((a) => 'transitionProperty' in a && a.effect && a.effect.target && a.effect.target.matches('.track, .canvas, .win, .sb'))`;
/* Where to click on sel, read once the view and the windows stand still. */
async function center(p, sel) {
  if (!(await waitFor(p, still, 8000))) throw new Error(`the view was still moving 8 s on, before a click on ${sel}`);
  return ev(p, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
}
/* A guest page by the path it shows: run an expression in it. */
async function inGuest(pathPart, expression) {
  const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url === `${BASE}${pathPart}`);
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const v = await new Promise((res) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result && d.result.result ? d.result.result.value : undefined); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  ws.close();
  return v;
}
/* Highlighted ranges in the page at that path, polled until there are `want` or ms passes. */
async function marksOn(pathPart, want, ms) {
  let n;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    n = await inGuest(pathPart, '(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; })()');
    if (n === want) return n;
  }
  return n;
}
/* What window id's ✎ panel shows, whether its ✎ is bright, and the address its shown tab is on. */
const panel = (p, id) => ev(p, `(() => { const w = document.querySelector('.win[data-id="${id}"]'); const ed = w && w.querySelector('.npane .fnote-ed'); const st = window.__flow.state().ws[0].windows.find((x) => x.id === ${JSON.stringify(id)}); const t = st && st.tabs && st.tabs[st.tab || 0]; return { text: ed ? ed.textContent : null, lit: !!(w && w.querySelector('.tb .act.on')), url: t ? t.url : '' }; })()`);
/* Whether window id's ✎ panel takes typing, and the placeholder it shows when empty. */
const editable = (p, id) => ev(p, `(() => { const ed = document.querySelector('.win[data-id="${id}"] .npane .fnote-ed'); return { editable: ed.isContentEditable, ph: getComputedStyle(ed, '::before').content }; })()`);
/* Page records whose note has what was typed in a tab with no page. */
const strays = (p) => ev(p, `Object.entries(window.__flow.state().pages).filter(([, r]) => String((r && r.note) || '').includes('typed with no page')).map(([k]) => k)`);
const noteOf = (p, pathPart) =>ev(p, `(window.__flow.state().pages[FlowNotes.key(${JSON.stringify(`${BASE}${pathPart}`)})] || {}).note || ''`);
const onPath = (p, id, pathPart, ms = 15000) => waitFor(p, `(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.id === ${JSON.stringify(id)}); const t = w && w.tabs && w.tabs[w.tab || 0]; return !!(t && t.url === ${JSON.stringify(`${BASE}${pathPart}`)}); })()`, ms);
/* Enter in the address bar. Flow puts the keys in the page on Enter's key-down, so the key-up goes to the page being
   left, and DevTools at times never answers a key-up whose page is replaced meanwhile (the app takes the next key at
   once). The key-up goes out without waiting for an answer, as a keyboard's does; the address reached is checked. */
let unanswered = 1e9;
async function enterAddress(p) {
  const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 };
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: '\r', unmodifiedText: '\r' });
  p.ws.send(JSON.stringify({ id: ++unanswered, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...k } }));
}
async function writeInPanel(p, id, text) {
  const ed = await center(p, `.win[data-id="${id}"] .npane .fnote-ed`);
  await click(p, ed.x, ed.y);
  await key(p, 'End', MOD.ctrl);
  await type(p, text);
}

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(path.join(UD, 'cwd'), { recursive: true });
const ws = { id: 'f', name: 'following', folder: path.join(UD, 'cwd'), bg: '#141319', zones: [], closed: [], saved: [],
  notes: [{ id: 'p-w', kind: 'page', title: 'Page A', url: `${BASE}/a`, body: '' }, { id: 'n-x', kind: 'note', title: 'a note', titleSet: true, body: 'beside the page' }],
  windows: [{ id: 'w-p', type: 'page', noteId: 'p-w', x: 1.2, y: 6.6, w: 60, h: 80 }, { id: 'w-n', type: 'note', noteId: 'n-x', x: 62, y: 6.6, w: 30, h: 40 }] };
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [ws], ui: {}, pages: {} }));

launch();
let p = await connect();
try {
  if (!(await onPath(p, 'w-p', '/a'))) throw new Error('page a did not load');
  await sleep(1000);
  // page a: its note, with a quoted sentence the page highlights
  const pen = await center(p, '.win[data-id="w-p"] .tb .act');
  await click(p, pen.x, pen.y);
  await sleep(500);
  await type(p, '> The first sentence of page a.');
  await key(p, 'Enter');
  await type(p, 'my note on a');
  const noteA = '> The first sentence of page a.\nmy note on a';
  R.ok('page a: the note written in its ✎ panel is page a\'s', !!(await waitFor(p, `(window.__flow.state().pages[FlowNotes.key(${JSON.stringify(`${BASE}/a`)})] || {}).note === ${JSON.stringify(noteA)}`, 5000)));
  R.ok('page a: the page highlights its quoted sentence', (await marksOn('/a', 1, 8000)) === 1);

  // a link followed in the page: page b's own note (none) and no highlight
  const a = await inGuest('/a', `(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, iw: innerWidth }; })()`);
  const wv = await ev(p, `(() => { const v = [...document.querySelectorAll('.win[data-id="w-p"] webview')].find((x) => x.getBoundingClientRect().width > 0); const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
  const k = wv.w / a.iw;
  await click(p, wv.x + a.x * k, wv.y + a.y * k);
  R.ok('a link clicked in the page goes to page b', !!(await onPath(p, 'w-p', '/b')));
  await sleep(1200);
  const atB = await panel(p, 'w-p');
  R.ok('page b: the panel shows page b\'s own note (none), and ✎ is not bright', atB.text === '' && !atB.lit, atB);
  R.ok('page b: no highlight from page a', (await marksOn('/b', 0, 4000)) === 0);
  await writeInPanel(p, 'w-p', 'my note on b');
  R.ok('page b: what is written now is page b\'s, and page a\'s note is as it was', !!(await waitFor(p, `(window.__flow.state().pages[FlowNotes.key(${JSON.stringify(`${BASE}/b`)})] || {}).note === 'my note on b'`, 5000)) && (await noteOf(p, '/a')) === noteA);

  // back: page a's note and highlight again
  const backBtn = await center(p, '.win[data-id="w-p"] .addr [data-nav=back]');
  await click(p, backBtn.x, backBtn.y);
  R.ok('back goes to page a', !!(await onPath(p, 'w-p', '/a')));
  await sleep(1200);
  const backA = await panel(p, 'w-p');
  R.ok('back on page a: the panel shows page a\'s note again, ✎ bright', backA.text === noteA && backA.lit, backA);
  R.ok('back on page a: its sentence is highlighted again', (await marksOn('/a', 1, 8000)) === 1);

  // forward: page b's note again
  const fwdBtn = await center(p, '.win[data-id="w-p"] .addr [data-nav=fwd]');
  await click(p, fwdBtn.x, fwdBtn.y);
  R.ok('forward goes to page b', !!(await onPath(p, 'w-p', '/b')));
  await sleep(1200);
  const fwdB = await panel(p, 'w-p');
  R.ok('forward on page b: the panel shows page b\'s note', fwdB.text === 'my note on b', fwdB);

  // a typed address: page c's own note
  const addr = await center(p, '.win[data-id="w-p"] .addr input.ad');
  await click(p, addr.x, addr.y);
  await key(p, 'a', MOD.ctrl);
  await type(p, `${BASE}/c`);
  await enterAddress(p);
  R.ok('a typed address goes to page c', !!(await onPath(p, 'w-p', '/c')));
  await sleep(1200);
  const atC = await panel(p, 'w-p');
  R.ok('page c: the panel shows page c\'s own note (none)', atC.text === '' && !atC.lit, atC);
  await writeInPanel(p, 'w-p', 'my note on c');
  R.ok('page c: what is written now is page c\'s', !!(await waitFor(p, `(window.__flow.state().pages[FlowNotes.key(${JSON.stringify(`${BASE}/c`)})] || {}).note === 'my note on c'`, 5000)) && (await noteOf(p, '/b')) === 'my note on b');

  // a new tab, ⌘T in the page: its own page, not page c's note (the menu's ⌘T runs this action; CDP keys never reach
  // the native menu)
  const inPage = await center(p, '.win[data-id="w-p"] .addr input.ad');
  await click(p, inPage.x, inPage.y);
  await sleep(300);
  await ev(p, `window.__flow.menu('new-page')`);
  await sleep(800);
  const blank = await panel(p, 'w-p');
  R.ok('a new tab starts with an empty panel, not page c\'s note', blank.text === '' && (await ev(p, 'window.__flow.state().ws[0].windows.find((x) => x.id === "w-p").tabs.length')) === 2, blank);
  // the new tab has no page, so it has no note: a click in its panel and typing write nothing anywhere
  const blankEd = await center(p, '.win[data-id="w-p"] .npane .fnote-ed');
  await click(p, blankEd.x, blankEd.y);
  await type(p, 'typed with no page');
  await sleep(600);
  const typed = { ...(await panel(p, 'w-p')), ...(await editable(p, 'w-p')), stored: await strays(p) };
  R.ok('the new tab has no page: typing in its panel puts nothing in it or in any page\'s note, and ✎ stays dim', typed.text === '' && !typed.lit && !typed.editable && !typed.stored.length && (await noteOf(p, '/c')) === 'my note on c', typed);
  const addrD = await center(p, '.win[data-id="w-p"] .addr input.ad');
  await click(p, addrD.x, addrD.y);
  await key(p, 'a', MOD.ctrl);
  await type(p, `${BASE}/d`);
  await enterAddress(p);
  R.ok('the new tab goes to page d', !!(await onPath(p, 'w-p', '/d')));
  await sleep(1200);
  const atD = { ...(await panel(p, 'w-p')), ...(await editable(p, 'w-p')) };
  R.ok('page d in the new tab: its own note (none), and the panel can be written in', atD.text === '' && !atD.lit && atD.editable, atD);
  await writeInPanel(p, 'w-p', 'my note on d');
  R.ok('page d: what is written now is page d\'s, and page c\'s note is as it was', !!(await waitFor(p, `(window.__flow.state().pages[FlowNotes.key(${JSON.stringify(`${BASE}/d`)})] || {}).note === 'my note on d'`, 5000)) && (await noteOf(p, '/c')) === 'my note on c');
  // back to the first tab: page c's note
  const tab0 = await center(p, '.win[data-id="w-p"] .ptabs .ptab');
  await click(p, tab0.x, tab0.y);
  await sleep(1200);
  const tabC = await panel(p, 'w-p');
  R.ok('switching back to the first tab shows page c\'s note', tabC.url === `${BASE}/c` && tabC.text === 'my note on c', tabC);

  // a new page window from the dock, beside the others: its own page and note
  const nbar = await center(p, '.win[data-id="w-n"] .tb');
  await click(p, nbar.x, nbar.y);
  await sleep(400);
  const before = await ev(p, 'window.__flow.state().ws[0].windows.map((w) => w.id)');
  const dock = await center(p, '.dock [data-k=page]');
  await mouse(p, 'mouseMoved', dock.x, dock.y);
  await sleep(400);
  await click(p, dock.x, dock.y);
  const nw = await waitFor(p, `(() => { const w = window.__flow.state().ws[0].windows.find((x) => !${JSON.stringify(before)}.includes(x.id) && x.type === 'page'); return w ? w.id : ''; })()`, 5000);
  R.ok('the dock makes a new page window', !!nw, nw);
  await sleep(600);
  await type(p, `${BASE}/e`);
  await enterAddress(p);
  R.ok('the new page window goes to page e', !!(await onPath(p, nw, '/e')));
  await sleep(1000);
  const pen2 = await center(p, `.win[data-id="${nw}"] .tb .act`);
  await click(p, pen2.x, pen2.y);
  await sleep(600);
  const atE = await panel(p, nw);
  R.ok('the new page window: page e\'s own empty note, not its neighbour\'s', atE.text === '' && !atE.lit, atE);

  // after a restart: each page still has its own note, and the window shows the note of the page it is on
  await sleep(1200);
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  p.ws.close();
  await quit();
  launch();
  p = await connect();
  await sleep(2500);
  const notes = { a: await noteOf(p, '/a'), b: await noteOf(p, '/b'), c: await noteOf(p, '/c'), d: await noteOf(p, '/d'), e: await noteOf(p, '/e'), stray: await strays(p) };
  R.ok('after a restart: pages a to d keep their notes, e has none, and what was typed with no page is nowhere', notes.a === noteA && notes.b === 'my note on b' && notes.c === 'my note on c' && notes.d === 'my note on d' && !notes.e && !notes.stray.length, notes);
  const pen3 = await center(p, '.win[data-id="w-p"] .tb .act');
  if (pen3 && !(await ev(p, '!!document.querySelector(\'.win[data-id="w-p"]\').classList.contains("noted")'))) { await click(p, pen3.x, pen3.y); await sleep(500); }
  const restored = await panel(p, 'w-p');
  R.ok('after a restart: the window shows the note of the page it is on', restored.url === `${BASE}/c` && restored.text === 'my note on c', restored);
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




