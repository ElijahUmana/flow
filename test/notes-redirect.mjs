// notes' check that a page keeps the name (and note) the owner gave it through a redirect: a server redirect, a page
// moving itself before any input (location.replace, history.replaceState), and that a link the owner clicks in that tab
// does not carry the name over. A local server serves the pages; the names come in through the one-time migration of
// an old state, as on the Mac's first launch. Real input over CDP on notes' isolated app (userData /tmp/flow-dev-notes,
// socket flow-dev-notes, CDP 9566), started from FLOW_DIR (default this repo).
//   FLOW_DIR=<tree> node test/notes-redirect.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, shot, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const R = reporter();

/* ---------- the pages ---------- */
const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:40px sans-serif">${body}</body></html>`;
const PAGES = {
  '/new': html('New Place', '<p>the new place</p><p><a id="away" href="/elsewhere">go elsewhere</a></p>'),
  '/client': html('Client', '<script>location.replace("/landed")</script><p>moving</p>'),
  '/landed': html('Landed', '<p>landed by the page itself</p>'),
  '/spa': html('Spa', '<script>history.replaceState(null, "", "/spa-home")</script><p>an app that rewrites its address</p>'),
  '/elsewhere': html('Elsewhere', '<p>somewhere the owner went</p>'),
  '/login': html('Sign in', '<p>sign in to go on</p>'),
};
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/old') { res.writeHead(302, { Location: '/new' }); res.end(); return; }
  if (p === '/dash') { res.writeHead(302, { Location: '/login?next=%2Fdash' }); res.end(); return; }
  if (PAGES[p]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[p]); return; }
  res.writeHead(404); res.end('not here');
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---------- the app ---------- */
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

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.mkdirSync(path.join(UD, 'cwd'), { recursive: true });
fs.mkdirSync(path.join(HERE, 'notes-shots'), { recursive: true });
// an old state (no page records yet) with three named pages whose saved addresses redirect
const ws = { id: 'r', name: 'redirects', folder: path.join(UD, 'cwd'), bg: '#141319', zones: [], closed: [], notes: [], windows: [] };
const named = [
  { id: 'old', url: `${BASE}/old`, to: `${BASE}/new`, name: 'my server redirect', note: 'written on the old address' },
  { id: 'client', url: `${BASE}/client`, to: `${BASE}/landed`, name: 'my page that moves itself', note: '' },
  { id: 'spa', url: `${BASE}/spa`, to: `${BASE}/spa-home`, name: 'my app page', note: '' },
];
const bounced = { id: 'dash', url: `${BASE}/dash`, name: 'my dashboard', note: 'what i watch here' };
[...named, bounced].forEach((x, i) => {
  ws.notes.push({ id: `p-${x.id}`, kind: 'page', title: x.name, titleSet: true, url: x.url, body: x.note });
  ws.windows.push({ id: `w-${x.id}`, type: 'page', noteId: `p-${x.id}`, x: 1.2 + (i % 3) * 33, y: i < 3 ? 6.6 : 50, w: 32, h: i < 3 ? 40 : 40 });
});
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: [ws], ui: {} }));

launch(UD);
let p = await connect();
try {
  const keyOf = (u) => ev(p, `FlowNotes.key(${JSON.stringify(u)})`);
  const title = (id) => ev(p, `(() => { const t = document.querySelector('.win[data-id="${id}"] .tb .title'); return t ? t.textContent : null; })()`);
  for (const x of named) {
    const landed = await waitFor(p, `(() => { const w = window.__flow.state().ws[0].windows.find((w) => w.id === 'w-${x.id}'); const t = w && w.tabs && w.tabs[w.tab || 0]; return t && t.url && t.url.startsWith(${JSON.stringify(x.to)}) ? t.url : ''; })()`, 15000);
    R.ok(`${x.id}: the tab lands on ${x.to.slice(BASE.length)}`, !!landed, landed);
    await sleep(800);
    const st = await ev(p, 'window.__flow.state()');
    const r = st.pages[await keyOf(x.to)];
    const left = st.pages[await keyOf(x.url)];
    R.ok(`${x.id}: the owner's name followed the page to where it landed`, !!r && r.name === x.name && !(left && !left.gone), r && { name: r.name, from: r.from, left });
    R.ok(`${x.id}: the title bar shows the owner's name`, (await title(`w-${x.id}`)) === x.name, await title(`w-${x.id}`));
    R.ok(`${x.id}: the old address still finds it`, (await ev(p, `FlowNotes.nameOf(${JSON.stringify(x.url)})`)) === x.name);
    if (x.note) R.ok(`${x.id}: the note went with it`, r && r.note === x.note);
  }
  // a bounce to sign in is not the page moving
  const signin = await waitFor(p, `(() => { const w = window.__flow.state().ws[0].windows.find((w) => w.id === 'w-dash'); const t = w && w.tabs && w.tabs[w.tab || 0]; return t && t.url.includes('/login') ? t.url : ''; })()`, 15000);
  R.ok('dash: an expired session bounces the tab to sign in', !!signin, signin);
  await sleep(800);
  R.ok('dash: the name and note stay with the dashboard, not the sign-in page', (await ev(p, `FlowNotes.nameOf(${JSON.stringify(bounced.url)})`)) === bounced.name && (await ev(p, `FlowNotes.nameOf(${JSON.stringify(signin)})`)) === '' && (await ev(p, `window.__flow.state().pages[FlowNotes.key(${JSON.stringify(bounced.url)})].note`)) === bounced.note);
  await shot(p, path.join(HERE, 'notes-shots', 'redirect-1-named.png'));

  // a link the owner clicks in that tab: the name stays with the page it was given to
  const g = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'webview' && t.url === `${BASE}/new`);
  const gws = new WebSocket(g.webSocketDebuggerUrl);
  await new Promise((res) => { gws.onopen = res; });
  const gev = (expression) => new Promise((res) => { gws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 9) res(d.result.result.value); }; gws.send(JSON.stringify({ id: 9, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
  const a = await gev(`(() => { const r = document.getElementById('away').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, iw: innerWidth }; })()`);
  gws.close();
  const wv = await ev(p, `(() => { const v = [...document.querySelectorAll('.win[data-id="w-old"] webview')].find((x) => x.getBoundingClientRect().width > 0); const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
  const tb = await ev(p, `(() => { const r = document.querySelector('.win[data-id="w-old"] .tb .title').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  await click(p, tb.x, tb.y);
  await sleep(400);
  const k = wv.w / a.iw;
  await click(p, wv.x + a.x * k, wv.y + a.y * k);
  const went = await waitFor(p, `(() => { const w = window.__flow.state().ws[0].windows.find((w) => w.id === 'w-old'); const t = w.tabs && w.tabs[w.tab || 0]; return t && t.url === ${JSON.stringify(`${BASE}/elsewhere`)} ? t.url : ''; })()`, 10000);
  R.ok('a click on a link in that tab goes to the other page', !!went);
  await sleep(800);
  R.ok('the other page does not take the owner\'s name', (await ev(p, `FlowNotes.nameOf(${JSON.stringify(`${BASE}/elsewhere`)})`)) === '' && (await title('w-old')) !== 'my server redirect', await title('w-old'));
  R.ok('the name stays with the page it was given to', (await ev(p, `FlowNotes.nameOf(${JSON.stringify(`${BASE}/new`)})`)) === 'my server redirect');

  // restart: names and records as they were
  const before = JSON.stringify((await ev(p, 'window.__flow.state()')).pages);
  p.ws.close();
  await quit();
  launch(UD);
  p = await connect();
  await sleep(4000);
  const after = await ev(p, 'window.__flow.state()');
  R.ok('after a restart the page records are as they were left', JSON.stringify(after.pages) === before);
  for (const x of named.slice(1)) R.ok(`after a restart: ${x.id} still shows the owner's name`, (await title(`w-${x.id}`)) === x.name, await title(`w-${x.id}`));
  await shot(p, path.join(HERE, 'notes-shots', 'redirect-2-restarted.png'));
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




