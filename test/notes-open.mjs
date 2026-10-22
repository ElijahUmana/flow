// notes' check that every way of opening a page gives that page its own note and highlights (owner 14:03-14:12, the
// lead's plan item 1): the dock's page button with a page in front, a right-click "new page", a terminal's first
// and second link, a saved page and a file from the sidebar each show the page's own note in ✎, bright, with its quoted
// sentence highlighted; a link followed in a page brings that page's note; no page's note changes on the way. Whether a
// path made a window or a tab is logged, not checked (that is item 1's own check).
// Local pages; real input over CDP on notes' isolated app (userData /tmp/flow-dev-notes, socket flow-dev-notes, CDP
// 9566), started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-open.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const R = reporter();

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:24px sans-serif">${body}</body></html>`;
const SAYS = {
  '/a': 'Page a is where the owner starts.',
  '/b': 'Page b came from the dock.',
  '/c': 'Page c came from a right-click.',
  '/d': 'Page d came from a terminal.',
  '/e': 'Page e came from the same terminal.',
  '/f': 'Page f is one link away from b.',
  '/s': 'Page s was saved for later.',
};
const PAGES = Object.fromEntries(Object.entries(SAYS).map(([p, s]) => [p, page(`Page ${p[1].toUpperCase()}`, `<p>${s}</p>${p === '/b' ? '<p><a id="go" href="/f">to page f</a></p>' : ''}`)]));
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (!PAGES[p]) { res.writeHead(404); res.end('not here'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGES[p]);
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const BASE = `http://127.0.0.1:${server.address().port}`;
const KEY = (p) => `https://127.0.0.1:${server.address().port}${p}`;
const NOTE = (p) => `> ${SAYS[p]}\nmy note on page ${p[1]}`;
const FOLDER = path.join(UD, 'cwd', 'flow');
const FILE_KEY = `flow-file://mac${FOLDER}/paper.txt`;
const FILE_NOTE = '> Flow is a macOS Electron app\nmy note on the paper';

const pids = () => spawnSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARK}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
function launch() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const log = fs.openSync(path.join(UD, 'app.log'), 'a');
  spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${UD}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`,
    'FLOW_BACKGROUND=1', './node_modules/.bin/electron', '.', '--no-sandbox', MARK], { cwd: DIR, env, stdio: ['ignore', log, log], detached: true }).unref();
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
/* A guest page whose address passes match: run an expression in it. */
async function inGuest(match, expression) {
  const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && match(x.url));
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
/* Highlighted ranges in the page whose address passes match, polled until there are `want` or ms passes. */
async function marksOn(match, want, ms) {
  let n;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    n = await inGuest(match, '(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; })()');
    if (n === want) return n;
  }
  return n;
}
/* The page window whose shown page (its tab on screen, else its note's address) passes test, a JS predicate on u. */
const showing = (p, test, ms = 15000) => waitFor(p, `(() => { const ws = window.__flow.state().ws[0]; for (const w of ws.windows) { if (w.type !== 'page') continue; const t = Array.isArray(w.tabs) && w.tabs.length ? w.tabs[w.tab || 0] : null; const u = t ? t.url : (ws.notes.find((n) => n.id === w.noteId) || {}).url || ''; if ((${test})(u)) return { id: w.id, tabs: (w.tabs || []).length }; } return null; })()`, ms);
const pageIds = (p) => ev(p, 'window.__flow.state().ws[0].windows.filter((w) => w.type === "page").map((w) => w.id)');
/* What window id's ✎ panel shows and whether its ✎ is bright, with the panel opened first if it was closed. */
async function panelOf(p, id) {
  if (!(await ev(p, `document.querySelector('.win[data-id="${id}"]').classList.contains('noted')`))) {
    const pen = await center(p, `.win[data-id="${id}"] .tb .act`);
    await click(p, pen.x, pen.y);
    await sleep(500);
  }
  return ev(p, `(() => { const w = document.querySelector('.win[data-id="${id}"]'); const ed = w.querySelector('.npane .fnote-ed'); return { text: ed ? ed.textContent : null, lit: !!w.querySelector('.tb .act.on') }; })()`);
}
/* The window that came from a path shows the page's own note, bright, and the page highlights its one sentence. */
async function ownNote(p, label, before, test, match, note) {
  const at = await showing(p, test);
  if (!at) { R.ok(`${label}: a window shows the page`, false); return null; }
  const made = (await pageIds(p)).length > before.length ? 'a window' : `a tab (${at.tabs} in ${at.id})`;
  const pn = await panelOf(p, at.id);
  const marks = await marksOn(match, 1, 8000);
  R.ok(`${label}: the page's own note in ✎, bright, its sentence highlighted`, pn.text === note && pn.lit && marks === 1, { made, ...pn, marks });
  return at;
}
const urlIs = (pathPart) => `(u) => u === ${JSON.stringify(`${BASE}${pathPart}`)}`;
const guestIs = (pathPart) => (u) => u === `${BASE}${pathPart}`;
/* Enter in the address bar; the key-up goes out without waiting for an answer (see notes-follow). */
let unanswered = 1e9;
async function enterAddress(p) {
  const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 };
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: '\r', unmodifiedText: '\r' });
  p.ws.send(JSON.stringify({ id: ++unanswered, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...k } }));
}
/* The dock's button k, pressed as the owner must when windows sit under the dock: the bottom strip brings it up. */
async function pressDock(p, k) {
  const b = await center(p, `.dock [data-k=${k}]`);
  if (!b) throw new Error(`the dock has no ${k} button`);
  const low = await ev(p, `document.getElementById('dock').offsetParent.getBoundingClientRect().bottom - 4`);
  await mouse(p, 'mouseMoved', b.x, low);
  if (!(await waitFor(p, `getComputedStyle(document.getElementById('dock')).pointerEvents !== 'none'`, 3000))) throw new Error('the dock did not come up');
  await sleep(250);
  await mouse(p, 'mouseMoved', b.x, (b.y + low) / 2);
  await mouse(p, 'mouseMoved', b.x, b.y);
  await sleep(100);
  await click(p, b.x, b.y);
}
/* Waits for the keys to be in a page's address line, else stops the run: typing must never land somewhere else. */
async function inAddress(p, what) {
  if (!(await waitFor(p, `!!(document.activeElement && document.activeElement.matches('.addr input.ad'))`, 4000))) throw new Error(`${what} left the keys outside an address line (${await ev(p, 'document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "none"')})`);
}
/* A point on the bare desktop, in view. */
const bare = (p) => ev(p, `(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.bottom - 90; y > v.top + 60; y -= 40) for (let x = v.right - 70; x > v.left + 60; x -= 40) { const e = document.elementFromPoint(x, y); if (e && e.closest('#viewport') && !e.closest('.win, .ctx, #dock')) return { x, y }; } return null; })()`);
/* Right-click on the bare desktop and pick label from its menu. */
async function desktopMenu(p, label) {
  if (!(await waitFor(p, still, 8000))) throw new Error('the view was still moving 8 s on, before a right-click');
  const at = await bare(p);
  if (!at) throw new Error('no bare desktop in view for a right-click');
  await mouse(p, 'mouseMoved', at.x, at.y);
  await mouse(p, 'mousePressed', at.x, at.y, { button: 'right', buttons: 2 });
  await mouse(p, 'mouseReleased', at.x, at.y, { button: 'right', buttons: 0 });
  // batch 8 says "new page here", batch 9 "new page"
  const re = `^${label}(?: here)?(?![\\w-])`;
  const it = await waitFor(p, `(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => new RegExp(${JSON.stringify(re)}).test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, 3000);
  if (!it) throw new Error(`no "${label}" in the desktop's menu`);
  await click(p, it.x, it.y);
}
const termText = (p, id) => ev(p, `(() => { const t = window.__flow.term(${JSON.stringify(id)}); return t ? t.getText() : null; })()`);
/* Where the last printed copy of needle sits in terminal window id. */
const termSpot = (p, id, needle) => ev(p, `(() => {
  const t = window.__flow.term(${JSON.stringify(id)});
  const scr = document.querySelector('.win[data-id="${id}"] .xterm-screen');
  if (!t || !scr) return null;
  const lines = t.getText().split(String.fromCharCode(10));
  for (let y = lines.length - 1; y >= 0; y--) {
    const x = lines[y].lastIndexOf(${JSON.stringify(needle)});
    if (x < 0) continue;
    const r = scr.getBoundingClientRect();
    const cw = r.width / t.cols, ch = r.height / t.rows;
    return { x: r.left + (x + ${needle.length} / 2) * cw, y: r.top + (y + 0.5) * ch };
  }
  return null;
})()`);
/* Prints url in shell window id and clicks it, as the owner would. */
async function clickPrinted(p, id, url) {
  if (!(await center(p, `.win[data-id="${id}"] .xterm-screen`))) throw new Error('the shell has no screen');
  const r = await ev(p, `(() => { const b = document.querySelector('.win[data-id="${id}"] .xterm-screen').getBoundingClientRect(); return { x: b.right - 30, y: b.bottom - 12 }; })()`);
  await click(p, r.x, r.y);
  await sleep(200);
  if (!(await ev(p, `!!(document.activeElement && document.activeElement.closest('.win[data-id="${id}"]'))`))) throw new Error(`a click on the shell did not give it the keys (the click at ${Math.round(r.x)},${Math.round(r.y)} of a ${await ev(p, 'innerWidth')} px wide window)`);
  await type(p, `echo ${url}`);
  await key(p, 'Enter');
  if (!(await waitFor(p, `(() => { const t = window.__flow.term(${JSON.stringify(id)}); return !!t && t.getText().split(String.fromCharCode(10)).some((l) => l.trim() === ${JSON.stringify(url)}); })()`, 8000))) throw new Error(`the shell did not print ${url}`);
  const spot = await termSpot(p, id, url);
  if (!spot) throw new Error(`${url} is not on screen in the shell`);
  await mouse(p, 'mouseMoved', spot.x - 4, spot.y);
  await sleep(150);
  await mouse(p, 'mouseMoved', spot.x, spot.y);
  await sleep(300);
  await click(p, spot.x, spot.y);
}

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(FOLDER, { recursive: true });
fs.writeFileSync(path.join(FOLDER, 'paper.txt'), 'A paper in the project folder.\nFlow is a macOS Electron app with notes on every page.\nThe end.\n');
const pages = {};
for (const p of Object.keys(SAYS)) pages[KEY(p)] = { url: `${BASE}${p}`, title: `Page ${p[1].toUpperCase()}`, about: '', note: NOTE(p), at: Date.now() };
pages[FILE_KEY] = { url: FILE_KEY, title: 'paper.txt', about: '', note: FILE_NOTE, at: Date.now() };
const WS = { id: 'flow', name: 'flow', folder: FOLDER, bg: '#141319', zones: [], closed: [],
  notes: [{ id: 'p-a', kind: 'page', title: 'Page A', url: `${BASE}/a`, body: '' }, { id: 'sec-r', kind: 'folder', holds: 'page', title: 'reading' }],
  saved: [{ id: 's-s', url: `${BASE}/s`, title: 'Page S', section: 'sec-r', at: Date.now() }],
  windows: [{ id: 'w-a', type: 'page', noteId: 'p-a', x: 1.2, y: 6.6, w: 32, h: 44 }] };
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [WS], ui: {}, pages }));
const seeded = JSON.stringify(Object.entries(pages).map(([k, r]) => [k, r.note]).sort());

launch();
let p = await connect();
try {
  if (!(await showing(p, urlIs('/a')))) throw new Error('page a did not load');
  R.ok('the seeded notes are keyed as the app keys their pages', (await ev(p, `FlowNotes.key(${JSON.stringify(`${BASE}/b`)})`)) === KEY('/b'));
  await ownNote(p, 'page a, open at the start', await pageIds(p), urlIs('/a'), guestIs('/a'), NOTE('/a'));

  // a right-click "new page", then an address
  let before = await pageIds(p);
  await desktopMenu(p, 'new page');
  await inAddress(p, 'a right-click "new page"');
  await type(p, `${BASE}/c`);
  await enterAddress(p);
  await ownNote(p, 'a right-click "new page"', before, urlIs('/c'), guestIs('/c'), NOTE('/c'));

  // a shell, then its first and second printed links
  const terms0 = await ev(p, 'window.__flow.state().ws[0].windows.filter((w) => w.type === "term").map((w) => w.id)');
  await desktopMenu(p, 'new shell');
  const sh = await waitFor(p, `(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.type === 'term' && !${JSON.stringify(terms0)}.includes(x.id)); return w ? w.id : ''; })()`, 8000);
  if (!sh) throw new Error('the right-click made no shell');
  if (!(await waitFor(p, `(() => { const t = window.__flow.term(${JSON.stringify(sh)}); return !!t && /\\S/.test(t.getText()); })()`, 15000))) throw new Error('the shell never showed a prompt');
  before = await pageIds(p);
  await clickPrinted(p, sh, `${BASE}/d`);
  await ownNote(p, 'a terminal\'s first link', before, urlIs('/d'), guestIs('/d'), NOTE('/d'));
  before = await pageIds(p);
  await clickPrinted(p, sh, `${BASE}/e`);
  await ownNote(p, 'the same terminal\'s second link', before, urlIs('/e'), guestIs('/e'), NOTE('/e'));

  // the dock's page button with a page window in front, then an address
  await waitFor(p, still, 8000);
  const bar = await ev(p, `(() => { const ws = window.__flow.state().ws[0]; for (const el of [...document.querySelectorAll('.win')].reverse()) { const m = ws.windows.find((x) => x.id === el.dataset.id); if (!m || m.type !== 'page') continue; const r = el.querySelector('.tb .title').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2, e = document.elementFromPoint(x, y); if (e && e.closest('.win') === el) return { x, y }; } return null; })()`);
  if (!bar) throw new Error('no page window has a title bar in view');
  await click(p, bar.x, bar.y);
  await sleep(300);
  if (!(await ev(p, `(() => { const f = document.querySelector('.win.front'); const m = f && window.__flow.state().ws[0].windows.find((x) => x.id === f.dataset.id); return !!m && m.type === 'page'; })()`))) throw new Error('a click on a page window\'s title bar did not bring it to the front');
  before = await pageIds(p);
  await pressDock(p, 'page');
  await inAddress(p, 'the dock\'s page button');
  await type(p, `${BASE}/b`);
  await enterAddress(p);
  const atB = await ownNote(p, 'the dock\'s page button, a page in front', before, urlIs('/b'), guestIs('/b'), NOTE('/b'));

  // a link followed in that page: page f's own note
  if (atB) {
    const a = await inGuest(guestIs('/b'), `(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, iw: innerWidth }; })()`);
    await waitFor(p, still, 8000);
    const wv = await ev(p, `(() => { const v = [...document.querySelectorAll('.win[data-id="${atB.id}"] webview')].find((x) => x.getBoundingClientRect().width > 0); const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
    const k = wv.w / a.iw;
    await click(p, wv.x + a.x * k, wv.y + a.y * k);
    await ownNote(p, 'a link followed in page b', await pageIds(p), urlIs('/f'), guestIs('/f'), NOTE('/f'));
  }

  // a saved page from the sidebar
  before = await pageIds(p);
  const saved = await center(p, '#sblist .tr[data-act="saved|s-s"]');
  if (!saved) throw new Error('the saved page has no row in the sidebar');
  await click(p, saved.x, saved.y);
  await ownNote(p, 'a saved page from the sidebar', before, urlIs('/s'), guestIs('/s'), NOTE('/s'));

  // a file from the files group, its folder unfolded first
  const folderRow = await center(p, '#sblist .tr[data-act^="files|"]');
  if (!folderRow) throw new Error('the workspace folder has no row in the sidebar');
  await click(p, folderRow.x, folderRow.y);
  before = await pageIds(p);
  const fileRow = await waitFor(p, `(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => /^files\\|/.test(x.dataset.act || '') && x.textContent.trim().endsWith('paper.txt')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`, 8000);
  if (!fileRow) throw new Error('paper.txt has no row in the files group');
  await waitFor(p, still, 8000);
  await click(p, fileRow.x, fileRow.y);
  await ownNote(p, 'a file from the files group', before, '(u) => u.startsWith("flow-file:") && u.endsWith("/paper.txt")', (u) => u.startsWith('flow-file:') && u.endsWith('/paper.txt'), FILE_NOTE);

  const now = await ev(p, `JSON.stringify(Object.entries(window.__flow.state().pages).filter(([, r]) => r && !r.gone && r.note).map(([k, r]) => [k, r.note]).sort())`);
  R.ok('no page\'s note changed on the way', now === seeded, now === seeded ? '' : now);
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
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




