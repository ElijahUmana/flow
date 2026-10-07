// files' real-input run of a workspace's files in the sidebar (files.js, files-main.js), on real folders under
// /home/claude/.flow-dev/files/cdp, with the app on port 9576, socket flow-dev-files, userData /tmp/flow-dev-files:
//   FILES_ROOT=<tree> node test/files-cdp.mjs
// Seeds a fresh state (test/files-seed.mjs), drives the sidebar with real mouse input over CDP, downloads from a
// local page, restarts the app once, and stops it at the end. Screenshots go to /tmp/flow-files-shots.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { connectTo, evaluate, mouse, click, key, sleep, shot, reporter } from './ui-lib.mjs';
import { PORT, MARK, SOCK, DATA, CWD, ROOT, VM_HOME, minimalPdf, png } from './files-seed.mjs';
import { writeProbe, evilPage } from './files-reports.mjs';

const SHOTS = '/tmp/flow-files-shots';
const PROJ = path.join(CWD, 'flow');
const A_TILDE = (p) => (p.startsWith(`${os.homedir()}/`) ? `~/${p.slice(os.homedir().length + 1)}` : p);
const DL_DIR = path.join(DATA, 'Downloads');
const R = reporter();
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

async function waitFor(fn, ms = 5000, step = 150) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return v;
}

/* ---------- the app ---------- */
function launch() {
  return spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${DATA}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1',
    `FILES_VM=${path.join(ROOT, 'test', 'files-vm-local.js')}`,
    './node_modules/.bin/electron', '.', '--no-sandbox', `--flow-dev=${MARK}`], { cwd: ROOT, stdio: ['ignore', fs.openSync('/tmp/flow-files-cdp-app.log', 'a'), fs.openSync('/tmp/flow-files-cdp-app.log', 'a')], detached: true });
}
async function stop(app) {
  try { process.kill(-app.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 40; i++) {
    try { process.kill(-app.pid, 0); } catch { break; }
    await sleep(250);
  }
  spawnSync('tmux', ['-L', SOCK, 'kill-server']);
}
async function connect() {
  const page = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  await sleep(800);
  return page;
}
/* The main process: electron's own binary with this run's marker and no --type (not the node launcher in .bin). */
function mainPid() {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.includes('electron/dist/electron') && l.includes(`--flow-dev=${MARK}`) && !l.includes('--type='));
  return line ? +line.trim().split(/\s+/)[0] : 0;
}
/* vmfiles' copy of a VM file once it has been fetched, in test/files-vm-local.js's cache, that main process's folder. */
const VM_CACHE = '/tmp/flow-dev-files-vm-cache';
function vmCopy(pid, name) {
  const run = path.join(VM_CACHE, String(pid));
  if (!fs.existsSync(run)) return null;
  for (const d of fs.readdirSync(run, { withFileTypes: true })) {
    const f = path.join(run, d.name, name);
    if (d.isDirectory() && fs.existsSync(f)) return f;
  }
  return null;
}
/* How many of these folders the main process watches (inotify marks, matched by inode). */
function watchedOf(dirs) {
  const pid = mainPid();
  if (!pid) return -1;
  const inodes = new Set(dirs.map((d) => fs.statSync(d).ino.toString(16)));
  let n = 0;
  for (const fd of fs.readdirSync(`/proc/${pid}/fdinfo`)) {
    let text = '';
    try { text = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const m of text.matchAll(/^inotify wd:\S+ ino:([0-9a-f]+)/gm)) if (inodes.has(m[1])) n++;
  }
  return n;
}

/* ---------- the sidebar ---------- */
const filesRows = (page) => evaluate(page, `[...document.querySelectorAll('#sblist .tr[data-act^="files|"]')].map((e) => ({ label: e.querySelector('.l').textContent, depth: +(/\\bd(\\d+)\\b/.exec(e.className) || [0, 0])[1], meta: (e.querySelector('.m') || {}).textContent || '', glyph: e.querySelector('.g').textContent, dim: e.classList.contains('dim') }))`);
const labels = async (page) => (await filesRows(page)).map((r) => `${'  '.repeat(r.depth)}${r.glyph ? r.glyph + ' ' : ''}${r.label}${r.meta ? ` [${r.meta}]` : ''}`);
async function rowAt(page, label, depth) {
  return evaluate(page, `(() => {
    const r = [...document.querySelectorAll('#sblist .tr[data-act^="files|"]')].find((e) => e.querySelector('.l').textContent === ${JSON.stringify(label)} && (${depth == null} || e.classList.contains('d' + ${depth == null ? 0 : depth})));
    if (!r) return null;
    r.scrollIntoView({ block: 'nearest' });
    const b = r.querySelector('.l').getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
}
/* Rows above (the browser group) grow as pages open and get their titles, so a row is clicked only once the sidebar
   has stopped changing for 400 ms and the row is the one under the point. */
async function settled(page) {
  let last = null;
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const now = await evaluate(page, `document.getElementById('sblist').innerHTML`);
    if (now === last) return;
    last = now;
    await sleep(400);
  }
}
async function clickRow(page, label, depth, o) {
  await settled(page);
  for (let i = 0; i < 10; i++) {
    const p = await waitFor(() => rowAt(page, label, depth), 3000);
    if (!p) break;
    const there = await evaluate(page, `(() => { const r = document.elementFromPoint(${p.x}, ${p.y}); const tr = r && r.closest('.tr'); return !!tr && tr.querySelector('.l').textContent === ${JSON.stringify(label)}; })()`);
    if (!there) { await sleep(200); continue; }
    await click(page, p.x, p.y, o);
    await sleep(350);
    return p;
  }
  throw new Error(`no files row ${label}${depth == null ? '' : ` at depth ${depth}`} to click; rows: ${(await labels(page)).join(' | ')}`);
}
const curWs = (page) => evaluate(page, `(() => { const s = window.__flow.state(); return s.ws.find((w) => w.id === s.ui.at) || s.ws[0]; })()`);
const pageWins = (page) => evaluate(page, `window.__flow.windows().filter((w) => w.type === 'page')`);
const tabsOf = (page) => evaluate(page, `(() => { const s = window.__flow.state(); return s.ws.flatMap((ws) => ws.windows.filter((w) => w.type === 'page').map((w) => ({ ws: ws.id, id: w.id, urls: (w.tabs || []).map((t) => t.url), note: (ws.notes.find((n) => n.id === w.noteId) || {}).url }))); })()`);
/* Whether u is a file page's address for p: flow-file://mac/<signature>/<path> (or vm/<signature>/<host>/<path>). */
const encodedPath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const isFileUrl = (u, p, host) => typeof u === 'string' && u.startsWith(host ? 'flow-file://vm/' : 'flow-file://mac/') && u.endsWith(`/${host ? `${host}/` : ''}${encodedPath(p)}`);
/* A page's webview as a CDP target, once its address has match in it (and ok(target) holds). */
async function guestOf(match, ok = () => true, ms = 8000) {
  return waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    return list.find((t) => t.type === 'webview' && t.url.includes(match) && ok(t)) || null;
  }, ms, 250);
}
/* The page windows of the workspace shown, each with the addresses it holds, and the window in front. */
const pageWindows = (page) => evaluate(page, `(() => { const s = window.__flow.state(); const ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0]; return ws.windows.filter((w) => w.type === 'page').map((w) => { const n = ws.notes.find((x) => x.id === w.noteId); return { id: w.id, z: w.z || 0, urls: (w.tabs || []).length ? w.tabs.map((t) => t.url) : [n && n.url].filter(Boolean) }; }); })()`);
const frontWindow = (page) => evaluate(page, `(() => { const s = window.__flow.state(); const ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0]; const top = ws.windows.reduce((a, b) => ((b.z || 0) > ((a && a.z) || 0) ? b : a), null); return top ? top.id : null; })()`);
/* The windows shown beside it that a window's rectangle overlaps (by more than a pixel), by id. */
const coveredBy = (page, id) => evaluate(page, `(() => { const me = document.querySelector('.win[data-id="${id}"]'); if (!me || !me.offsetParent) return null; const a = me.getBoundingClientRect(); return [...me.parentElement.children].filter((el) => el !== me && el.classList.contains('win') && el.offsetParent).filter((el) => { const b = el.getBoundingClientRect(); return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1; }).map((el) => el.dataset.id); })()`);
/* What a click that opens a file did to the page windows: how many it added, whether that one holds just the file, how
   many others hold it as a tab, and which windows the new one covers once it has settled. */
const opened = [];
async function openedAs(page, click, file, host) {
  const before = await pageWindows(page);
  await click();
  const now = await waitFor(async () => { const x = await pageWindows(page); return x.length > before.length ? x : null; }, 10000);
  const fresh = now ? now.filter((w) => !before.some((b) => b.id === w.id)) : [];
  const elsewhere = (now || await pageWindows(page)).filter((w) => !fresh.some((f) => f.id === w.id) && w.urls.some((u) => isFileUrl(u, file, host)));
  const covers = fresh.length === 1 ? (await waitFor(async () => { const c = await coveredBy(page, fresh[0].id); return c && !c.length ? c : null; }, 2000)) || await coveredBy(page, fresh[0].id) : null;
  const k = { name: path.basename(file), newWindows: fresh.length, alone: fresh.length === 1 && fresh[0].urls.length === 1 && isFileUrl(fresh[0].urls[0], file, host), asTabElsewhere: elsewhere.length, covers };
  opened.push(k);
  return k;
}
const ownWindow = (k) => k.newWindows === 1 && k.alone && k.asTabElsewhere === 0;
/* ui-lib's connectTo attaches to pages only; a webview is its own target. A call fails, rather than waits, when the
   page goes away (a page of another kind takes its place) or gives no answer in 30 s, as ui-lib's do. */
async function connectGuest(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot open ${t.webSocketDebuggerUrl}`)); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
  };
  ws.onclose = () => { for (const p of pending.values()) p.rej(new Error(`${t.url.slice(0, 60)} went away`)); pending.clear(); };
  const send = (method, params) => new Promise((res, rej) => {
    if (ws.readyState !== WebSocket.OPEN) { rej(new Error(`${t.url.slice(0, 60)} went away`)); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} got no answer in 30s (${t.url.slice(0, 60)})`)); }, 30000);
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  return { ws, send, errors: [], on: () => {} };
}

/* ---------- a local site with a download ---------- */
const PDF = minimalPdf('the report');
const netHits = [];   // what pages asked of /net/*, the network as far as this run can tell
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/net/')) {
    netHits.push(req.url.slice(4).split('?')[0]);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.url === '/evil-report') {
    res.setHeader('content-type', 'text/html');
    res.end(evilPage(path.join(PROJ, 'reports', 'htmlcov', 'index.html')));
    return;
  }
  if (req.url.startsWith('/dl?')) {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>downloads here</title><body style="margin:0"><a id="dl" href="/report.pdf" style="display:block;font:40px sans-serif;padding:40px">get the report</a>');
    return;
  }
  if (req.url === '/report.pdf') {
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', 'attachment; filename="report.pdf"');
    res.end(PDF);
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${srv.address().port}`;
// Where a WebRTC STUN (udp) or TURN (tcp) request from a page would go.
const udpHits = [];
const udpSock = dgram.createSocket('udp4');
udpSock.on('message', (m) => udpHits.push(m.length));
await new Promise((r) => udpSock.bind(0, '127.0.0.1', r));
let tcpConns = 0;
const tcpSrv = net.createServer((c) => { tcpConns++; c.destroy(); });
await new Promise((r) => tcpSrv.listen(0, '127.0.0.1', r));
/* tag makes this page's address its own, so the click lands in the page just opened. */
async function downloadIn(page, tag) {
  const url = `${SITE}/dl?${tag}`;
  const id = await evaluate(page, `window.__flow.openPage(${JSON.stringify(url)})`);
  const t = await guestOf(url, (x) => x.title === 'downloads here');
  if (!t) throw new Error('the download page never showed');
  const guest = await connectGuest(t);
  for (let i = 0; i < 40 && !(await evaluate(guest, '!!document.getElementById("dl")')); i++) await sleep(200);
  const b = await evaluate(guest, `(() => { const r = document.getElementById('dl').getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; })()`);
  await click(guest, b.x, b.y);
  guest.ws.close();
  return id;
}

let app = null;
try {
  // an app an earlier run left behind would answer here with its own state, and every check would read that
  const stale = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
  if (stale) throw new Error(`an app still answers on port ${PORT} (an earlier run's?); stop it first: pkill -f "[e]lectron/dist/electron .*--flow-dev=${MARK}"`);
  execFileSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'files-seed.mjs')], { cwd: ROOT, env: { ...process.env, FILES_ROOT: ROOT }, stdio: 'inherit' });
  fs.rmSync(DL_DIR, { recursive: true, force: true });
  app = launch();
  let page = await connect();

  // 1. Folded, a place costs one row and nothing is watched.
  let rows = await labels(page);
  R.ok('the files group shows the workspace folder, folded', JSON.stringify(rows) === JSON.stringify(['▸ flow']), rows);
  const groups = await evaluate(page, `[...document.querySelectorAll('#sblist .grp')].map((g) => g.textContent)`);
  R.ok('the files group sits right after browser, once', groups.filter((g) => g === 'files').length === 1 && groups[groups.indexOf('files') - 1] === 'browser', groups);
  R.ok('a folded folder is not watched', watchedOf([PROJ]) === 0, watchedOf([PROJ]));
  await shot(page, `${SHOTS}/01-folded.png`);

  // 2. A click unfolds it: folders first, then files, hidden names left out; now it is watched.
  await clickRow(page, 'flow', 0);
  rows = await waitFor(async () => { const l = await labels(page); return l.length > 1 ? l : null; });
  R.ok('a click unfolds the folder: folders first, then files, no hidden names', JSON.stringify(rows) === JSON.stringify(['▾ flow', '  ▸ data', '  ▸ many', '  ▸ notes', '  ▸ src', '  PLAN.md', '  README.md']), rows);
  R.ok('the unfolded folder is watched', (await waitFor(() => watchedOf([PROJ]) === 1, 2000)) === true, watchedOf([PROJ]));
  await shot(page, `${SHOTS}/02-unfolded.png`);

  // 3. A big folder draws 300 names and an "n more" row; a click on it shows the rest.
  await clickRow(page, 'many', 1);
  rows = await waitFor(async () => { const r = await filesRows(page); return r.some((x) => x.label === '40 more') ? r : null; });
  R.ok('a folder of 340 files draws 300 and "40 more"', !!rows && rows.filter((r) => r.depth === 2).length === 301 && rows.some((r) => r.label === '40 more' && r.dim), rows && rows.filter((r) => r.depth === 2).length);
  await clickRow(page, '40 more', 2);
  rows = await filesRows(page);
  R.ok('a click on "40 more" shows all 340, by number', rows.filter((r) => r.depth === 2).length === 340 && !rows.some((r) => r.label === '40 more') && rows.findIndex((r) => r.label === 'file-9.txt') < rows.findIndex((r) => r.label === 'file-10.txt'), rows.filter((r) => r.depth === 2).length);
  await clickRow(page, 'many', 1);

  // 4. Deep folders indent down to depth 8 and keep that indent below.
  for (const [name, depth] of [['src', 1], ['deep', 2], ['a', 3], ['b', 4], ['c', 5], ['d', 6], ['e', 7], ['f', 8], ['g', 8]]) await clickRow(page, name, depth);
  // the last folder's names arrive after its click: read once leaf.txt is there
  rows = (await waitFor(async () => { const r = await filesRows(page); return r.some((x) => x.label === 'leaf.txt') ? r : null; }, 4000)) || await filesRows(page);
  const leaf = rows.find((r) => r.label === 'leaf.txt');
  const pads = await evaluate(page, `[...document.querySelectorAll('#sblist .tr[data-act^="files|"]')].filter((e) => ['f', 'g', 'leaf.txt'].includes(e.querySelector('.l').textContent)).map((e) => getComputedStyle(e).paddingLeft)`);
  R.ok('deep folders unfold in place; below depth 8 the indent stays', !!leaf && leaf.depth === 8 && JSON.stringify(pads) === JSON.stringify(['136px', '136px', '136px']), { leaf, pads });
  await shot(page, `${SHOTS}/03-deep.png`);
  const shownDirs = [PROJ, path.join(PROJ, 'src'), path.join(PROJ, 'src/deep'), path.join(PROJ, 'src/deep/a/b/c/d/e/f/g')];
  R.ok('every unfolded folder on screen is watched, nothing else', (await waitFor(() => watchedOf(shownDirs) === 4 && watchedOf([path.join(PROJ, 'many'), path.join(PROJ, 'notes')]) === 0, 2000)) === true, { shown: watchedOf(shownDirs), folded: watchedOf([path.join(PROJ, 'many'), path.join(PROJ, 'notes')]) });
  await clickRow(page, 'deep', 2);
  R.ok('folding a folder stops watching the folders under it', (await waitFor(() => watchedOf([path.join(PROJ, 'src/deep'), path.join(PROJ, 'src/deep/a/b/c/d/e/f/g')]) === 0, 2000)) === true);

  // 5. Live: a file an agent writes appears; one removed goes.
  fs.writeFileSync(path.join(PROJ, 'src', 'written-by-agent.md'), '# from an agent\n');
  R.ok('a new file in a shown folder appears by itself', !!(await waitFor(async () => (await rowAt(page, 'written-by-agent.md', 2)), 3000)));
  fs.rmSync(path.join(PROJ, 'src', 'written-by-agent.md'));
  R.ok('a removed file leaves by itself', !!(await waitFor(async () => !(await rowAt(page, 'written-by-agent.md', 2)), 3000)));

  // 6. Hidden sidebar or another workspace: nothing watched; back: watched and up to date.
  await evaluate(page, `window.__flow.menu('toggle-sidebar')`);
  R.ok('a hidden sidebar watches nothing', (await waitFor(() => watchedOf([PROJ, path.join(PROJ, 'src')]) === 0, 2000)) === true);
  fs.writeFileSync(path.join(PROJ, 'src', 'while-hidden.txt'), 'x');
  await evaluate(page, `window.__flow.menu('toggle-sidebar')`);
  R.ok('shown again, it watches and lists what changed meanwhile', (await waitFor(async () => watchedOf([PROJ, path.join(PROJ, 'src')]) === 2 && !!(await rowAt(page, 'while-hidden.txt', 2)), 3000)) === true);
  await evaluate(page, 'window.__flow.go(1)');
  await sleep(600);
  R.ok('on another workspace, the first one\'s folders are not watched', (await waitFor(() => watchedOf([PROJ, path.join(PROJ, 'src')]) === 0, 2000)) === true);
  await evaluate(page, 'window.__flow.go(0)');
  await sleep(600);

  // 7. A click on a file opens it as a page; a second click goes to it.
  await clickRow(page, 'PLAN.md', 1);
  const planPath = path.join(PROJ, 'PLAN.md');
  const isPlan = (u) => isFileUrl(u, planPath);
  const plan = await guestOf('PLAN.md', (t) => t.title === 'PLAN.md');
  R.ok('PLAN.md opens as a page in this workspace', !!plan && plan.title === 'PLAN.md' && (await tabsOf(page)).some((w) => w.ws === 'flow' && (w.urls.some(isPlan) || isPlan(w.note))), plan ? plan.title : { tabs: await tabsOf(page), wins: await pageWins(page), rows: await labels(page) });
  if (plan) {
    const g = await connectGuest(plan);
    const text = await evaluate(g, 'document.body.innerText');
    const dom = await evaluate(g, `({ h1: (document.querySelector('h1') || {}).textContent, items: [...document.querySelectorAll('ol li')].map((l) => l.textContent) })`);
    R.ok('PLAN.md shows rendered: its heading and its numbered list', dom.h1 === 'plan' && JSON.stringify(dom.items) === JSON.stringify(['files in the sidebar', 'downloads per workspace']), dom);
    g.ws.close();
  }
  await shot(page, `${SHOTS}/04-plan-open.png`);
  // page's file-tab address (batch 3): the field shows the file's path, ~ form on this Mac, not the signed address; a
  // hint says "on the VM" only for a VM file; Enter on the unchanged path stays on the file and searches nothing.
  const addrOf = (name) => evaluate(page, `(() => { const i = [...document.querySelectorAll('input.ad')].find((x) => x.value.endsWith(${JSON.stringify('/' + name)}) && x.offsetParent); if (!i) return null; const h = i.parentElement.querySelector('.phint'); const b = i.getBoundingClientRect(); return { value: i.value, hint: h ? h.textContent : '', x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  const planAddr = await addrOf('PLAN.md');
  R.ok('a file tab shows its path in ~ form, not its signed address (page, batch 3)', !!planAddr && planAddr.value === '~/.flow-dev/files/cdp/flow/PLAN.md' && !/on the VM/.test(planAddr.hint), planAddr);
  if (planAddr) {
    await click(page, planAddr.x, planAddr.y);
    await key(page, 'Enter');
    await sleep(1200);
    const after = await addrOf('PLAN.md');
    const stayed = (await tabsOf(page)).some((w) => w.urls.some(isPlan) || isPlan(w.note));
    R.ok('Enter on the unchanged path stays on the file (page, batch 3)', stayed && !!after && after.value === planAddr.value, { after, stayed });
  }
  const before = (await tabsOf(page)).flatMap((w) => w.urls.length ? w.urls : [w.note]).filter(isPlan).length;
  await clickRow(page, 'PLAN.md', 1);
  await sleep(500);
  const after = (await tabsOf(page)).flatMap((w) => w.urls.length ? w.urls : [w.note]).filter(isPlan).length;
  R.ok('a second click on an open file does not open it twice', before === 1 && after === 1, { before, after });

  // 7b. An html file shows its characters as written: no charset (UTF-8), <meta charset="utf-8">, and another charset
  // it names (windows-1252 by http-equiv) kept.
  await clickRow(page, 'notes', 1);
  await evaluate(page, `window.__clicks = []; document.getElementById('sblist').addEventListener('click', (e) => { const tr = e.target.closest('.tr'); window.__clicks.push({ t: Math.round(performance.now()), detail: e.detail, label: tr ? tr.querySelector('.l').textContent : String(e.target.className) }); }, true);`);
  for (const [name, want] of [['nometa.html', '›_ ✎ ◫'], ['utf8meta.html', '›_ ✎ ◫'], ['legacy.html', 'price €5']]) {
    await clickRow(page, name, 2);
    const t = await guestOf(name, (x) => x.title === name.replace('.html', ''), 8000);
    let text = '';
    if (t) { const g = await connectGuest(t); text = await evaluate(g, 'document.body.innerText'); g.ws.close(); }
    R.ok(`${name} opened from the files group shows ${JSON.stringify(want)}`, text.includes(want), t ? text : { tabs: (await tabsOf(page)).filter((w) => w.ws === 'flow').map((w) => w.urls.map((u) => u.split('/').pop())), errors: page.errors.slice(-6), clicks: await evaluate(page, 'window.__clicks') });
  }
  await shot(page, `${SHOTS}/04b-html-charsets.png`);

  // 7c. A file open as a page has no row in browser; its own row is marked (↗, and × closes it), nothing moves when it
  // opens, a click on it goes to its tab, and closing the tab clears the mark.
  const browserRows = () => evaluate(page, `(() => { const out = []; let g = ''; for (const e of document.querySelectorAll('#sblist .grp, #sblist .tr')) { if (e.classList.contains('grp')) g = e.textContent; else if (g === 'browser') out.push(e.querySelector('.l').textContent); } return out; })()`);
  const fileRowInfo = (label, depth) => evaluate(page, `(() => {
    const list = document.getElementById('sblist');
    const r = [...list.querySelectorAll('.tr[data-act^="files|"]')].find((e) => e.querySelector('.l').textContent === ${JSON.stringify(label)} && e.classList.contains('d' + ${depth}));
    if (!r) return null;
    const x = r.querySelector('[data-close]');
    const xb = x ? x.getBoundingClientRect() : null;
    const b = r.getBoundingClientRect();
    return { glyph: r.querySelector('.g').textContent, close: !!x, top: Math.round(b.top - list.getBoundingClientRect().top + list.scrollTop), x: xb ? { x: xb.left + xb.width / 2, y: xb.top + xb.height / 2 } : null, row: { x: b.left + 60, y: b.top + b.height / 2 } };
  })()`);
  const br = await browserRows();
  R.ok('no file open as a page has a row in browser', !br.some((l) => /PLAN\.md|nometa|utf8meta|legacy/.test(l)), br);
  await settled(page);
  const was = { readme: await fileRowInfo('README.md', 1), ideas: await fileRowInfo('ideas.txt', 2) };
  await clickRow(page, 'ideas.txt', 2);
  const ideas = await guestOf('ideas.txt', (t) => t.title === 'ideas.txt', 8000);
  await settled(page);
  const now = { readme: await fileRowInfo('README.md', 1), ideas: await fileRowInfo('ideas.txt', 2) };
  R.ok('nothing in the files group moves when a file opens', !!ideas && was.readme.top === now.readme.top && was.ideas.top === now.ideas.top, { before: [was.readme.top, was.ideas.top], after: [now.readme.top, now.ideas.top] });
  R.ok("the open file's row is marked as an open saved page is: ↗ and a × that closes it", now.ideas.glyph === '↗' && now.ideas.close && was.ideas.glyph === '' && !was.ideas.close, { before: was.ideas, after: now.ideas });
  const shownTab = async () => (await evaluate(page, `(() => { const s = window.__flow.state(); const w = s.ws[0].windows.find((x) => x.type === 'page' && (x.tabs || []).some((t) => t.url.includes('ideas.txt'))); return w ? { urls: w.tabs.map((t) => t.url), tab: w.tab } : null; })()`));
  await clickRow(page, 'PLAN.md', 1);
  await clickRow(page, 'ideas.txt', 2);
  const shown7c = await waitFor(async () => { const x = await shownTab(); return x && x.urls[x.tab] && x.urls[x.tab].includes('ideas.txt') ? x : null; }, 3000);
  R.ok('a click on the marked row goes to its tab, without opening it twice', !!shown7c && shown7c.urls.filter((u) => u.includes('ideas.txt')).length === 1, shown7c || await shownTab());
  const xb = (await fileRowInfo('ideas.txt', 2)).x;
  const rb = (await fileRowInfo('ideas.txt', 2)).row;
  await mouse(page, 'mouseMoved', rb.x, rb.y);
  await sleep(150);
  await click(page, xb.x, xb.y);
  const cleared = await waitFor(async () => { const r = await fileRowInfo('ideas.txt', 2); return r && r.glyph === '' && !r.close ? r : null; }, 3000);
  R.ok("closing the file's tab clears the mark, and the tab is gone", !!cleared && !(await shownTab()), cleared || await fileRowInfo('ideas.txt', 2));
  await shot(page, `${SHOTS}/04c-open-mark.png`);
  await clickRow(page, 'notes', 1);

  // 7d. A .md shows formatted in the look of a Flow note: its image next to it, a link to another file opening that
  // file, live while it shows (the reading place kept), watched only while it shows, and a clip landing in its note.
  await clickRow(page, 'notes', 1);
  await clickRow(page, 'guide.md', 2);
  const gt = await guestOf('guide.md', (t) => t.title === 'guide.md', 8000);
  const guide = gt ? await connectGuest(gt) : null;
  if (guide) await waitFor(() => evaluate(guide, `(() => { const i = document.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0; })()`).catch(() => false), 5000);
  const mdLook = guide ? await evaluate(guide, `({ scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.documentElement).backgroundColor })`) : null;
  R.ok('a .md page is dark to its scrollbar and boxes (color-scheme dark)', !!mdLook && mdLook.scheme === 'dark' && mdLook.bg === 'rgb(15, 15, 17)', mdLook);
  // the window showing guide.md, by its id: with every file in a window of its own, another may show PLAN.md too
  const guideWin = await evaluate(page, `(() => { const s = window.__flow.state(); const ws = s.ws.find((w) => w.id === s.ui.at) || s.ws[0]; const shows = (w) => [...(w.tabs || []).map((t) => t.url), (ws.notes.find((n) => n.id === w.noteId) || {}).url].some((u) => /\\/notes\\/guide\\.md$/.test(u || '')); const w = ws.windows.find((x) => x.type === 'page' && shows(x)); return w ? w.id : null; })()`);
  const gdom = guide ? await evaluate(guide, `(() => {
    const q = (s) => document.querySelector(s);
    const img = q('img');
    return { h1: q('h1') && q('h1').id + '|' + q('h1').textContent, bold: (q('strong') || {}).textContent, code: [...document.querySelectorAll('code')].map((c) => c.textContent),
      link: q('a') && { text: q('a').textContent, href: q('a').getAttribute('href') }, host: document.body.innerText.includes('and <host>.'),
      boxes: [...document.querySelectorAll('li.task input')].map((b) => b.checked), cells: [...document.querySelectorAll('td')].map((c) => c.textContent),
      quote: (q('blockquote') || {}).textContent, img: img && { w: img.naturalWidth, src: img.getAttribute('src') }, summary: (q('details summary') || {}).textContent,
      h2: [...document.querySelectorAll('h2')].map((h) => h.id), bg: getComputedStyle(document.documentElement).backgroundColor, font: getComputedStyle(document.body).fontSize };
  })()`) : null;
  R.ok('a .md opens formatted: heading with its anchor, bold, code, a link, <host> as text, tasks, a table, a quote, details',
    !!gdom && gdom.h1 === 'guide|Guide' && gdom.bold === 'bold' && gdom.code.includes('code') && gdom.host && JSON.stringify(gdom.boxes) === '[false,true]'
    && JSON.stringify(gdom.cells) === '["1","2"]' && /a quote line to clip/.test(gdom.quote) && gdom.summary === 'More' && JSON.stringify(gdom.h2) === '["second","third"]', gdom);
  R.ok('it reads in the look of a Flow note', !!gdom && gdom.bg === 'rgb(15, 15, 17)' && gdom.font === '13px', gdom && { bg: gdom.bg, font: gdom.font });
  R.ok('the image next to it shows, by its signed address', !!gdom && !!gdom.img && gdom.img.w === 8 && gdom.img.src.startsWith('flow-file://mac/'), gdom && gdom.img);
  R.ok('a relative link points at the other file by its signed address', !!gdom && !!gdom.link && gdom.link.text === 'plan link' && gdom.link.href.startsWith('flow-file://mac/') && gdom.link.href.endsWith('/PLAN.md#plan'), gdom && gdom.link);
  await shot(page, `${SHOTS}/04d-md.png`);
  if (guide) {
    const lb = await evaluate(guide, `(() => { const b = document.querySelector('a').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await click(guide, lb.x, lb.y);
    const plan2 = await guestOf('', (t) => t.id === gt.id && t.title === 'PLAN.md', 6000);
    R.ok('a click on it opens that file in the tab, rendered', !!plan2, plan2 ? plan2.title : await tabsOf(page));
    // the back button of the window whose address now shows PLAN.md (the tab that followed the link)
    const back = await evaluate(page, `(() => { const w = document.querySelector('[data-id="${guideWin}"]'); const b = w && w.querySelector('button.nv[data-nav="back"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (back) await click(page, back.x, back.y);
    R.ok('back returns to the .md', !!(await guestOf('', (t) => t.id === gt.id && t.title === 'guide.md', 6000)), back);

    // Live: an agent writes into the file while it shows; the tab re-renders and the part being read stays in place.
    await clickRow(page, 'notes', 1);
    const notesDir = path.join(PROJ, 'notes');
    R.ok('only the shown .md watches its folder (files group folded)', (await waitFor(() => watchedOf([notesDir]) === 1, 3000)) === true, watchedOf([notesDir]));
    await evaluate(guide, `document.getElementById('third').scrollIntoView(); 1`);
    await sleep(300);
    const top0 = await evaluate(guide, `Math.round(document.getElementById('third').getBoundingClientRect().top)`);
    const guidePath = path.join(PROJ, 'notes', 'guide.md');
    fs.writeFileSync(guidePath, fs.readFileSync(guidePath, 'utf8').replace('# Guide\n', '# Guide\n\nA new line an agent just wrote.\n'));
    const fresh = await waitFor(() => evaluate(guide, `document.body.innerText.includes('A new line an agent just wrote.')`).catch(() => false), 5000, 200);
    await sleep(300);
    const top1 = await evaluate(guide, `Math.round(document.getElementById('third').getBoundingClientRect().top)`).catch(() => null);
    R.ok('a change written to the file shows in the open tab', !!fresh);
    R.ok('and the heading being read stays where it was', top1 !== null && Math.abs(top1 - top0) <= 12, { top0, top1 });
    await evaluate(page, 'window.__flow.go(1)');
    R.ok('on another workspace the .md is not watched', (await waitFor(() => watchedOf([notesDir]) === 0, 3000)) === true, watchedOf([notesDir]));
    await evaluate(page, 'window.__flow.go(0)');
    R.ok('back on its workspace it is watched again', (await waitFor(() => watchedOf([notesDir]) === 1, 3000)) === true, watchedOf([notesDir]));

    // A clip from the .md lands in its own note, kept by its path.
    const qr = await evaluate(guide, `(() => { const p = document.querySelector('blockquote p'); p.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.selectNodeContents(p); const b = r.getBoundingClientRect(); return { x0: b.left + 1, x1: b.right - 1, y: b.top + b.height / 2 }; })()`);
    await sleep(200);
    await mouse(guide, 'mouseMoved', qr.x0, qr.y);
    await mouse(guide, 'mousePressed', qr.x0, qr.y);
    for (let k = 1; k <= 10; k++) await mouse(guide, 'mouseMoved', qr.x0 + ((qr.x1 - qr.x0) * k) / 10, qr.y, { down: true });
    await mouse(guide, 'mouseReleased', qr.x1, qr.y);
    const sel = await evaluate(guide, 'String(getSelection())');
    // An agent writes to the file while text is selected for a clip: the tab waits, so the selection stays.
    fs.appendFileSync(guidePath, '\nA line written while text was selected.\n');
    await sleep(1500);
    const held = await evaluate(guide, 'String(getSelection())').catch(() => '');
    R.ok('a write while text is selected waits, and the selection stays', !!sel && held === sel, { sel, held });
    // the ✂ of the window that shows guide.md
    const clipAt = await waitFor(() => evaluate(page, `(() => { const i = [...document.querySelectorAll('input.ad')].find((x) => x.offsetParent && /guide\\.md$/.test(x.value)); const b = i && i.closest('.addr').querySelector('button.pclip'); if (!b || b.classList.contains('off')) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`), 3000);
    if (clipAt) await click(page, clipAt.x, clipAt.y);
    const noted = await waitFor(async () => { const pages = (await evaluate(page, 'window.__flow.state().pages')) || {}; const k = Object.keys(pages).find((x) => x.endsWith('/notes/guide.md')); return k && String(pages[k].note || '').includes('a quote line to clip') ? k : null; }, 4000);
    R.ok('a clip from the .md lands in its own note, kept by its path', !!noted, { sel, clipAt: !!clipAt, noted });
    await click(guide, qr.x0, qr.y);
    const shownAfter = await waitFor(() => evaluate(guide, `document.body.innerText.includes('A line written while text was selected.')`).catch(() => false), 5000, 250);
    R.ok('once the selection is let go, the write shows', !!shownAfter);
    guide.ws.close();

    // In a long list (an agent's plan) the item being read stays put: items written above it, then one at the end.
    await clickRow(page, 'notes', 1);
    await clickRow(page, 'steps.md', 2);
    const st = await guestOf('steps.md', (t) => t.title === 'steps.md', 8000);
    if (st) {
      const sg = await connectGuest(st);
      const itemTop = (n) => evaluate(sg, `(() => { const l = [...document.querySelectorAll('li')].find((x) => x.textContent === 'plan step ${n}'); return l ? Math.round(l.getBoundingClientRect().top) : null; })()`);
      await evaluate(sg, `[...document.querySelectorAll('li')].find((x) => x.textContent === 'plan step 120').scrollIntoView(); 1`);
      await sleep(300);
      const s0 = await itemTop(120);
      const stepsPath = path.join(PROJ, 'notes', 'steps.md');
      fs.writeFileSync(stepsPath, fs.readFileSync(stepsPath, 'utf8').replace('# steps\n\n', '# steps\n\n- plan step 0a\n- plan step 0b\n- plan step 0c\n'));
      await waitFor(() => evaluate(sg, `document.body.innerText.includes('plan step 0a')`).catch(() => false), 5000, 200);
      await sleep(300);
      const s1 = await itemTop(120);
      fs.appendFileSync(stepsPath, '- plan step 201\n');
      await waitFor(() => evaluate(sg, `document.body.innerText.includes('plan step 201')`).catch(() => false), 5000, 200);
      await sleep(300);
      const s2 = await itemTop(120);
      R.ok('in a long list the item being read stays put, with items written above it and below', s0 !== null && Math.abs(s1 - s0) <= 12 && Math.abs(s2 - s0) <= 12, { s0, s1, s2 });
      sg.ws.close();
    } else {
      R.ok('steps.md opens', false, await tabsOf(page));
    }
    await clickRow(page, 'notes', 1);
  }
  await shot(page, `${SHOTS}/04e-md-live.png`);

  // 7e. Any file shown as a page is live as well: a log an agent writes follows its end when read there and stays put
  // when read in the middle. A pdf is not watched: its viewer would start again at the first page.
  {
    const notesDir = path.join(PROJ, 'notes');
    const logPath = path.join(notesDir, 'agent.log');
    fs.writeFileSync(logPath, `${Array.from({ length: 400 }, (_, k) => `step ${k}: what the agent did`).join('\n')}\n`);
    await clickRow(page, 'notes', 1);
    await clickRow(page, 'agent.log', 2);
    const lt = await guestOf('agent.log', (t) => t.title === 'agent.log', 8000);
    const lg = lt ? await connectGuest(lt) : null;
    if (lg) {
      const textLook = await evaluate(lg, `({ scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.documentElement).backgroundColor, color: getComputedStyle(document.querySelector('pre')).color, size: getComputedStyle(document.querySelector('pre')).fontSize })`);
      R.ok('a text file reads as a .md does: the same dark page, its scrollbar dark too, in the code font', textLook.scheme === 'dark' && textLook.bg === 'rgb(15, 15, 17)' && textLook.color === 'rgb(217, 217, 221)' && textLook.size === '12px', textLook);
      await shot(page, `${SHOTS}/04f-log.png`);
      await evaluate(lg, 'window.scrollTo(0, document.documentElement.scrollHeight); 1');
      await sleep(300);
      fs.appendFileSync(logPath, 'step 400: written while the end was read\n');
      const seen = await waitFor(() => evaluate(lg, `document.body.innerText.includes('step 400: written')`).catch(() => false), 5000, 200);
      await sleep(300);
      const atEnd = await evaluate(lg, 'innerHeight + scrollY >= document.documentElement.scrollHeight - 2').catch(() => null);
      R.ok('a log written while it shows updates in its tab, and read at its end it follows the end', !!seen && atEnd === true, { seen, atEnd });
      await evaluate(lg, 'window.scrollTo(0, 2000); 1');
      await sleep(300);
      const y0 = await evaluate(lg, 'Math.round(scrollY)');
      fs.appendFileSync(logPath, 'step 401: written while the middle was read\n');
      const seen2 = await waitFor(() => evaluate(lg, `document.body.innerText.includes('step 401: written')`).catch(() => false), 5000, 200);
      await sleep(300);
      const y1 = await evaluate(lg, 'Math.round(scrollY)').catch(() => null);
      R.ok('read in the middle, it stays where it was', !!seen2 && y1 === y0, { seen2, y0, y1 });
      // written while its space is not on screen (nothing is watched for it then), it shows on coming back
      await evaluate(page, 'window.__flow.go(1)');
      const away = await waitFor(() => watchedOf([notesDir]) === 0, 3000);
      fs.appendFileSync(logPath, 'step 402: written while away\n');
      await sleep(400);
      await evaluate(page, 'window.__flow.go(0)');
      const seen3 = await waitFor(() => evaluate(lg, `document.body.innerText.includes('step 402: written')`).catch(() => false), 5000, 200);
      R.ok('written while its space was not on screen, it shows on coming back', away === true && !!seen3, { away, seen3 });
      lg.ws.close();
    } else {
      R.ok('agent.log opens', false, await tabsOf(page));
    }
    // the pdf in a folder of its own, so the folder watch it is checked against is its alone
    const pdfDir = path.join(notesDir, 'brief');
    fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(path.join(pdfDir, 'brief.pdf'), minimalPdf('the brief'));
    await clickRow(page, 'brief', 2);
    await clickRow(page, 'brief.pdf', 3);
    const pt = await guestOf('brief.pdf', (t) => t.url.endsWith('/brief.pdf'), 8000);
    await clickRow(page, 'brief', 2);
    await clickRow(page, 'notes', 1);
    R.ok('a pdf shown as a page is not watched', !!pt && (await waitFor(() => watchedOf([pdfDir]) === 0, 3000)) === true, { pdf: !!pt, watched: watchedOf([pdfDir]) });
    // the log's tab shows again, so the restart below finds a page it can read
    await clickRow(page, 'notes', 1);
    await clickRow(page, 'agent.log', 2);
    await clickRow(page, 'notes', 1);
  }

  // 7f. A report opens whole: a coverage.py htmlcov and a pytest-html report (test/files-reports, made by those tools)
  // load their styles, scripts, pages and subfolders from under their own folder; a page in a subfolder reaches nothing
  // above it; a script there reads no sibling file's text and reaches no network, unless the owner clicks a link out;
  // and a web page cannot reach a report.
  {
    const reports = path.join(PROJ, 'reports');
    fs.rmSync(reports, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'test', 'files-reports'), reports, { recursive: true });
    // kept as pytest-report in test/ (the intake log cannot hold a path with a space); named as the owner might, with a
    // space, so the report's signed address carries %20
    fs.renameSync(path.join(reports, 'pytest-report'), path.join(reports, 'pytest report'));
    writeProbe(path.join(reports, 'probe'), { net: SITE, udp: udpSock.address().port, tcp: tcpSrv.address().port });
    netHits.length = 0;
    const sheetsOf = (g) => evaluate(g, `[...document.styleSheets].map((s) => { try { return (s.href || 'inline').split('/').slice(-2).join('/') + ':' + s.cssRules.length; } catch (e) { return 'unreadable'; } })`);
    // A page's style sheet is in document.styleSheets only once it has loaded; read until it has (or give the last read).
    const COV_CSS = /style_cb_4667309f\.css:\d{3}/;
    const covLoaded = async (g, extra = '0') => {
      let last = null;
      const ok = await waitFor(async () => { last = { sheets: await sheetsOf(g), js: await evaluate(g, 'typeof coverage'), extra: await evaluate(g, extra) }; return last.sheets.some((x) => COV_CSS.test(x)) && last.js === 'object'; }, 8000);
      return { ok: ok === true, ...last };
    };
    const at = (g, sel) => evaluate(g, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 }; })()`);
    await clickRow(page, 'reports', 1);
    await clickRow(page, 'htmlcov', 2);
    await clickRow(page, 'index.html', 3);
    const ct = await guestOf('htmlcov/index.html', (t) => t.title === 'Coverage report', 8000);
    const cg = ct ? await connectGuest(ct) : null;
    const cIndex = cg ? await covLoaded(cg) : null;
    R.ok("a coverage.py report opens with its own style sheet and script", !!cIndex && cIndex.ok, cIndex);
    if (cg) {
      const ln = await at(cg, 'a[href="z_470884e9ca6af4ca_ops_py.html"]');
      if (ln) await click(cg, ln.x, ln.y);
      const opsPage = await waitFor(async () => (await evaluate(cg, 'document.title').catch(() => '')).startsWith('Coverage for calc/ops.py'), 6000);
      const ops = opsPage ? await covLoaded(cg, `document.body.innerText.includes('def divide')`) : null;
      R.ok('a click on a module in it opens that page, styled and scripted, with its source', !!ops && ops.ok && ops.extra === true, ops || { link: !!ln });
      cg.ws.close();
    }
    await clickRow(page, 'htmlcov', 2);
    await clickRow(page, 'pytest report', 2);
    await clickRow(page, 'report.html', 3);
    // read once its page has loaded (its title is the file's name): a page still loading has no document to read
    const pt = await guestOf('pytest%20report/report.html', (t) => t.title === 'report.html', 8000);
    const pg = pt ? await connectGuest(pt) : null;
    const pRep = pg ? await waitFor(async () => { const x = { sheets: await sheetsOf(pg), rows: await evaluate(pg, `document.querySelectorAll('.results-table-row').length`), passed: await evaluate(pg, `(document.querySelector('.passed') || {}).textContent || ''`) }; return x.rows === 4 && x.sheets.some((y) => /^assets\/style\.css:\d+/.test(y) && !y.endsWith(':0')) ? x : null; }, 8000) : null;
    R.ok('a pytest-html report opens with its style sheet from its assets folder, and its script lists the 4 tests', !!pRep && pRep.sheets.some((x) => /^assets\/style\.css:\d+/.test(x) && !x.endsWith(':0')) && /4 Passed/.test(pRep.passed), pRep);
    if (pg) pg.ws.close();
    await clickRow(page, 'pytest report', 2);
    await clickRow(page, 'probe', 2);
    await clickRow(page, 'sub', 3);
    await clickRow(page, 'page.html', 4);
    const st = await guestOf('probe/sub/page.html', (t) => t.title === 'sub page', 8000);
    const sg = st ? await connectGuest(st) : null;
    if (sg) {
      const color = await evaluate(sg, `getComputedStyle(document.getElementById('styled')).color`);
      R.ok("a page in a subfolder does not get the style sheet above it", color !== 'rgb(1, 2, 3)', color);
      const side = await at(sg, '#side');
      await click(sg, side.x, side.y);
      const sideText = await waitFor(async () => { const t = await evaluate(sg, 'document.body.innerText').catch(() => ''); return t.includes('other page') ? t : null; }, 5000);
      R.ok('a link to a page beside it opens', !!sideText, sideText);
      await evaluate(sg, 'history.back(); 1');
      await waitFor(async () => (await evaluate(sg, 'document.title').catch(() => '')) === 'sub page', 5000);
      const up = await at(sg, '#up');
      await click(sg, up.x, up.y);
      const upText = await waitFor(async () => { const t = await evaluate(sg, 'document.body.innerText').catch(() => ''); return /refused/.test(t) ? t : null; }, 5000);
      R.ok('a link above its folder is refused', !!upText, upText);
      sg.ws.close();
    } else {
      R.ok('probe/sub/page.html opens', false, await tabsOf(page));
    }
    await clickRow(page, 'sub', 3);
    await clickRow(page, 'index.html', 3);
    const prt = await guestOf('probe/index.html', (t) => t.title === 'probe', 8000);
    R.ok("after a link out of its folder was refused there, the file's own row opens it at its own address", !!prt, prt ? prt.url.slice(0, 60) : await tabsOf(page));
    const prg = prt ? await connectGuest(prt) : null;
    const READS = ['fetch', 'xhr', 'jsonModule', 'styleSheet', 'script', 'iframe', 'object', 'worker'];
    const res = prg ? await waitFor(async () => { const r = JSON.parse(await evaluate(prg, `document.getElementById('out').textContent`)); return READS.every((k) => k in r) && r.ran ? r : null; }, 6000) : null;
    const own = prg ? await evaluate(prg, `getComputedStyle(document.getElementById('styled')).color`) : null;
    R.ok("a script in a report reads no sibling file's text: fetch, XHR, a JSON module, a style sheet, a script, a frame, an object, a worker", !!res && READS.every((k) => res[k] === 'blocked') && own === 'rgb(1, 2, 3)', { own, res });
    if (prg) {
      const ob = await at(prg, '#open');
      await click(prg, ob.x, ob.y);
      const wo = await waitFor(async () => { const r = JSON.parse(await evaluate(prg, `document.getElementById('out').textContent`)); return r.windowOpen ? r.windowOpen : null; }, 5000);
      R.ok('and a window it opens on the owner\'s click is not there to read', wo === 'null', wo);
      prg.ws.close();
    }
    await sleep(800);
    R.ok('none of it reaches the network: images, scripts, styles, fonts, media, fetch, beacons, sockets, prefetch, forms', netHits.length === 0, netHits);
    for (const [name, hit] of [['nav.html', '/nav'], ['nav2.html', '/meta'], ['nav3.html', '/replace']]) {
      await clickRow(page, name, 3);
      // once its page is open, the time its script needs to try
      await waitFor(async () => (await tabsOf(page)).flatMap((w) => w.urls).some((u) => u.endsWith(`/probe/${name}`)), 5000);
      await sleep(1500);
      const where = (await tabsOf(page)).flatMap((w) => w.urls).find((u) => u.endsWith(`/probe/${name}`));
      R.ok(`a report page that sends itself to the network (${name}) stays where it is`, !netHits.includes(hit) && !!where, { netHits, where: !!where });
    }
    await clickRow(page, 'link.html', 3);
    const lt = await guestOf('probe/link.html', (t) => t.title === 'link', 8000);
    if (lt) {
      const lg = await connectGuest(lt);
      const ext = await at(lg, '#ext');
      // the web page it opens may take this page's place before the release is answered (page's crossing rule)
      await click(lg, ext.x, ext.y).catch((e) => { if (!/went away/.test(e.message)) throw e; });
      await waitFor(() => netHits.includes('/clicked'), 5000);
      R.ok("the owner's own click on a link out of it opens, and its ping sends nothing", netHits.includes('/clicked') && !netHits.includes('/ping'), netHits);
      lg.ws.close();
    } else {
      R.ok('probe/link.html opens', false, await tabsOf(page));
    }
    // WebRTC from a report reaches nothing, from the page, a blank frame of its own or a srcdoc frame; nor when the
    // report is reached by a link from a .md in its folder.
    udpHits.length = 0;
    tcpConns = 0;
    await clickRow(page, 'webrtc.html', 3);
    const wt = await guestOf('probe/webrtc.html', (t) => t.title === 'webrtc', 8000);
    let tried = null;
    if (wt) {
      const wg = await connectGuest(wt);
      tried = await waitFor(async () => { const t = await evaluate(wg, `document.getElementById('out').textContent`).catch(() => ''); return /srcdoc frame/.test(t) ? t : null; }, 6000);
      wg.ws.close();
    }
    await sleep(4000);
    R.ok('WebRTC from a report reaches nothing: STUN over UDP and TURN over TCP, from the page, a blank frame and a srcdoc frame', /page/.test(tried || '') && /blank frame/.test(tried || '') && udpHits.length === 0 && tcpConns === 0, { tried, udp: udpHits.length, tcp: tcpConns });
    udpHits.length = 0;
    tcpConns = 0;
    await clickRow(page, 'links.md', 3);
    const mt = await guestOf('probe/links.md', (t) => t.title === 'links.md', 8000);
    let viaMd = null;
    if (mt) {
      const mg = await connectGuest(mt);
      const reports = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'webview' && t.url.includes('probe/webrtc.html'));
      const before = new Set((await reports()).map((t) => t.id));
      const wl = await at(mg, 'a');
      if (wl) await click(mg, wl.x, wl.y);
      // the report shows where the .md was, or in a page of its own kind beside it (page's crossing rule)
      const rt = await waitFor(async () => (await reports()).find((t) => !before.has(t.id)) || null, 8000);
      if (rt) {
        const rg = await connectGuest(rt);
        viaMd = await waitFor(async () => { const t = await evaluate(rg, `document.title + ' ' + ((document.getElementById('out') || {}).textContent || '')`).catch(() => ''); return /srcdoc frame/.test(t) ? t : null; }, 8000);
        rg.ws.close();
      }
      mg.ws.close();
    }
    await sleep(4000);
    R.ok('and none when the report is reached by a link from a .md', !!viaMd && udpHits.length === 0 && tcpConns === 0, { viaMd, udp: udpHits.length, tcp: tcpConns });
    await clickRow(page, 'probe', 2);
    await clickRow(page, 'reports', 1);
    // A web page cannot reach a report: it can only make addresses up, and none of them loads.
    await evaluate(page, `window.__flow.openPage(${JSON.stringify(`${SITE}/evil-report`)})`);
    const et = await guestOf(`${SITE}/evil-report`, (t) => t.title === 'evil report', 8000);
    const eg = et ? await connectGuest(et) : null;
    let evLast = null;
    const ev = eg ? await waitFor(async () => { const r = JSON.parse(await evaluate(eg, `document.getElementById('out').textContent`)); evLast = r; return ['img', 'style', 'fetch', 'iframe'].every((k) => k in r) ? r : null; }, 6000) : null;
    // read again after a while: nothing that loads late reads the report either
    if (ev) await sleep(2000);
    const evEnd = ev ? JSON.parse(await evaluate(eg, `document.getElementById('out').textContent`)) : null;
    R.ok('a web page cannot reach a report: its image, style sheet, page by fetch, page in a frame', !!evEnd && ['img', 'style', 'fetch', 'iframe'].every((k) => evEnd[k] === 'blocked' || evEnd[k] === 'refused'), evEnd || { found: !!et, partial: evLast });
    if (eg) eg.ws.close();
    // the log's tab shows again, so the restart below finds a page it can read
    await clickRow(page, 'notes', 1);
    await clickRow(page, 'agent.log', 2);
    await clickRow(page, 'notes', 1);
  }

  // 7g. A file opens as its own page window, never as a tab in another (the owner, Nov 2 14:12: "why ... are files and
  // new browser stuffs opening in new tabs in the same ... browser"); one already open is shown where it is.
  {
    const kindsDir = path.join(PROJ, 'kinds');
    fs.rmSync(kindsDir, { recursive: true, force: true });
    fs.mkdirSync(kindsDir);
    fs.writeFileSync(path.join(kindsDir, 'one.txt'), 'one\n');
    fs.writeFileSync(path.join(kindsDir, 'two.md'), '# two\n');
    fs.writeFileSync(path.join(kindsDir, 'three.html'), '<!doctype html><title>three</title><p>three</p>');
    fs.writeFileSync(path.join(kindsDir, 'four.pdf'), minimalPdf('four'));
    fs.writeFileSync(path.join(kindsDir, 'five.png'), png(12, 12));
    const pagesNow = () => pageWindows(page);
    const front = () => frontWindow(page);
    await clickRow(page, 'kinds', 1);
    const kinds = [];
    for (const name of ['one.txt', 'two.md', 'three.html', 'four.pdf', 'five.png']) kinds.push(await openedAs(page, () => clickRow(page, name, 2), path.join(kindsDir, name)));
    R.ok('a file opens as its own page window holding just it, for text, Markdown, html, pdf and an image', kinds.every(ownWindow), kinds);
    const one = (await pagesNow()).find((w) => w.urls.some((u) => isFileUrl(u, path.join(kindsDir, 'one.txt'))));
    const count = (await pagesNow()).length;
    await clickRow(page, 'one.txt', 2);
    const inFront = await waitFor(async () => (one && (await front()) === one.id ? true : null), 3000);
    R.ok('a file already open is shown where it is: no new window, its window comes to the front', !!one && inFront === true && (await pagesNow()).length === count, { one: one && one.id, front: await front(), before: count, after: (await pagesNow()).length });
    await clickRow(page, 'kinds', 1);
  }

  // 7h. A sub-workspace's own files (item 15; the owner, 14:54: "why doesn't sub workspaces have their own separate file
  // sections as needed?"): its own folder (here outside the workspace's) and what its pages downloaded; the main space
  // keeps the rest; folded and unfolded is kept per space. The sidebar draws them under each space's heading (its
  // change); here FlowFiles is driven as the sidebar calls it, on voiceless as saved (seeded with two sub-workspaces).
  {
    const own = path.join(CWD, 'zone-own');
    await evaluate(page, `(() => { window.__zt = window.__flow.state().ws.find((w) => w.id === 'voiceless'); return 1; })()`);
    const spaceRows = (zone) => evaluate(page, `(() => { const out = []; window.FlowFiles.rows(window.__zt, (g, d, glyph, label, meta, act) => out.push({ text: '  '.repeat(d) + (glyph ? glyph + ' ' : '') + label + (meta ? ' [' + meta + ']' : ''), act }), [], ${JSON.stringify(zone)}); return out; })()`);
    const texts = (r) => (r || []).map((x) => x.text);
    const has = await evaluate(page, `({ files: window.FlowFiles.has(window.__zt, 'z-files'), bare: window.FlowFiles.has(window.__zt, 'z-bare'), main: window.FlowFiles.has(window.__zt, ''), gone: window.FlowFiles.has(window.__zt, 'z-none') })`);
    const zr = await spaceRows('z-files');
    const mr = await spaceRows('');
    const br = await spaceRows('z-bare');
    R.ok("a sub-workspace shows its own folder and its own downloads; the main space its folder and the rest; one with neither shows none",
      JSON.stringify(texts(zr)) === JSON.stringify(['▸ zone-own', '▸ downloads [1]']) && JSON.stringify(texts(mr)) === JSON.stringify(['▸ voiceless', '▸ downloads [1]']) && br.length === 0
      && has.files === true && has.bare === false && has.main === true && has.gone === false, { zone: texts(zr), main: texts(mr), bare: texts(br), has });
    const folderAct = (zr.find((x) => x.text === '▸ zone-own') || {}).act;
    if (folderAct) await evaluate(page, `window.FlowFiles.perform(window.__zt, ${JSON.stringify(folderAct)})`);
    const zr2 = await waitFor(async () => { const r = texts(await spaceRows('z-files')); return r.includes('  own.txt') ? r : null; }, 5000);
    const kept = await evaluate(page, `(window.__zt.filesOpen || []).slice()`);
    R.ok("its folder unfolds there (main lets it list, though it is outside every workspace folder), kept for that space only",
      JSON.stringify(zr2) === JSON.stringify(['▾ zone-own', '  own.txt', '▸ downloads [1]']) && JSON.stringify(texts(await spaceRows(''))) === JSON.stringify(['▸ voiceless', '▸ downloads [1]'])
      && kept.length === 1 && kept[0].startsWith('z-files|'), { zone: zr2, kept });
    const notThere = await evaluate(page, `window.flow.files.list(null, ${JSON.stringify(path.join(CWD, 'zone-not'))})`);
    R.ok('a folder in no workspace and no sub-workspace is still refused', !!notThere && notThere.ok === false && notThere.error === 'not in a workspace folder', notThere);
    const dl2 = path.join(CWD, 'dl-seed', 'zone-dl2.txt');
    fs.writeFileSync(dl2, 'zone-dl2.txt\n');
    await evaluate(page, `window.FlowFiles.downloaded(window.__zt, { state: 'completed', file: ${JSON.stringify(dl2)}, url: 'http://127.0.0.1:1/zone-dl2.txt' }, 'z-files')`);
    const dz = await evaluate(page, `window.__zt.downloads[0]`);
    R.ok('a download made from a page in a sub-workspace is kept in that space', !!dz && dz.zone === 'z-files' && texts(await spaceRows('z-files')).includes('▸ downloads [2]') && texts(await spaceRows('')).includes('▸ downloads [1]'), dz);
    // the heading's "folder" item (sidebar's) asks files for the folder in use, as its hint, and sets a typed one
    const f0 = await evaluate(page, `({ own: window.FlowFiles.folderOf(window.__zt, 'z-files'), bare: window.FlowFiles.folderOf(window.__zt, 'z-bare') })`);
    const typed = await evaluate(page, `({ ok: window.FlowFiles.setFolder(window.__zt, 'z-bare', ${JSON.stringify(A_TILDE(path.join(CWD, 'zone-not')))}), bad: window.FlowFiles.setFolder(window.__zt, 'z-bare', 'relative/x') })`);
    const bareRows = texts(await spaceRows('z-bare'));
    const cleared = await evaluate(page, `window.FlowFiles.setFolder(window.__zt, 'z-bare', '')`);
    const bareAfter = texts(await spaceRows('z-bare'));
    R.ok("a sub-workspace's folder item: its hint is the folder in use (its own, else the workspace's); a typed one shows, '' goes back",
      f0.own === A_TILDE(own) && f0.bare === A_TILDE(path.join(CWD, 'voiceless')) && typed.ok === true && typed.bad === false && JSON.stringify(bareRows) === JSON.stringify(['▸ zone-not']) && cleared === true && bareAfter.length === 0,
      { f0, typed, bareRows, bareAfter });
    await evaluate(page, 'delete window.__zt; 1');
    // In the sidebar itself, with real input: going to the sub-workspace by its heading shows its own files there; its
    // folder unfolds, is watched while it shows, and a file in it opens as its own page window in that space.
    const vi = await evaluate(page, `window.__flow.state().ws.findIndex((w) => w.id === 'voiceless')`);
    await evaluate(page, `window.__flow.go(${vi})`);
    await sleep(700);
    const heading = (act) => evaluate(page, `(() => { const r = document.querySelector('#sblist .tr[data-act=${JSON.stringify(act)}]'); if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.querySelector('.l').getBoundingClientRect(); return { x: b.left + Math.min(30, b.width / 2), y: b.top + b.height / 2 }; })()`);
    const zh = await heading('zone|z-files');
    if (zh) await click(page, zh.x, zh.y);
    const zrows = await waitFor(async () => { const l = await labels(page); return l.includes('▸ zone-own') ? l : null; }, 5000);
    R.ok("its heading takes the owner there, and its own files show under it, after the main space's", JSON.stringify(zrows) === JSON.stringify(['▸ voiceless', '▸ downloads [1]', '▸ zone-own', '▸ downloads [1]']), zrows || await labels(page));
    await clickRow(page, 'zone-own', 0);
    const unf = await waitFor(async () => { const l = await labels(page); return l.includes('  own.txt') ? l : null; }, 5000);
    R.ok('its folder unfolds there and is watched while it shows', !!unf && (await waitFor(() => watchedOf([own]) === 1, 3000)) === true, { rows: unf || await labels(page), watched: watchedOf([own]) });
    const ownWin = await openedAs(page, () => clickRow(page, 'own.txt', 1), path.join(own, 'own.txt'));
    const placed = await evaluate(page, `(() => { const s = window.__flow.state(); const ws = s.ws.find((w) => w.id === 'voiceless'); const w = ws.windows.filter((x) => x.type === 'page').find((x) => { const n = ws.notes.find((m) => m.id === x.noteId); return [...(x.tabs || []).map((t) => t.url), n && n.url].some((u) => u && u.endsWith('/zone-own/own.txt')); }); return w ? w.zone || '' : null; })()`);
    const ot = await guestOf('own.txt', (t) => t.title === 'own.txt', 8000);
    let ownText = '';
    if (ot) { const og = await connectGuest(ot); ownText = await evaluate(og, 'document.body.innerText').catch(() => ''); og.ws.close(); }
    R.ok('a file in it opens as its own page window in that sub-workspace', ownWindow(ownWin) && placed === 'z-files' && ownText.includes('in the sub-workspace'), { ownWin, placed, ownText });
    const mh = await heading('zone|');
    if (mh) await click(page, mh.x, mh.y);
    R.ok('back on the main space, the sub-workspace\'s folder is no longer watched', (await waitFor(() => watchedOf([own]) === 0, 3000)) === true, { watched: watchedOf([own]), rows: await labels(page) });

    // 7j. Its own folder from its heading's right-click "folder" (sidebar's item calls pickFolder): on a Mac workspace
    // the Mac's folder picker. Under xvfb that is GTK's chooser, driven with real input by test/files-xkeys.py (a click
    // in its list, Down to its first folder, its accept button); while it is open the app answers no DevTools call,
    // so the last release is not awaited until the keys are in. The heading then shows that folder and its file; Esc in
    // the picker leaves the folder as it was.
    const pickDir = path.join(CWD, 'voiceless', 'pick-me');
    fs.mkdirSync(pickDir, { recursive: true });
    fs.writeFileSync(path.join(pickDir, 'picked.txt'), 'picked\n');
    const pid = mainPid();
    const xkeys = (...k) => { const r = spawnSync('python3', [path.join(ROOT, 'test', 'files-xkeys.py'), String(pid), ...k], { encoding: 'utf8' }); if (r.status) throw new Error(`files-xkeys: ${r.stderr || r.stdout}`); };
    const folderItem = async () => {
      const h = await heading('zone|z-bare');
      if (!h) return null;
      await mouse(page, 'mouseMoved', h.x, h.y);
      await mouse(page, 'mousePressed', h.x, h.y, { button: 'right', buttons: 2 });
      await mouse(page, 'mouseReleased', h.x, h.y, { button: 'right' });
      return waitFor(() => evaluate(page, `(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => x.firstChild && x.firstChild.textContent.trim() === 'folder'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hint: (b.querySelector('.k') || {}).textContent || '' }; })()`), 3000);
    };
    // a click on the item; its release is answered once the picker has closed, and the keys wait for it to show
    const choose = async (item, ...steps) => {
      await mouse(page, 'mouseMoved', item.x, item.y);
      await mouse(page, 'mousePressed', item.x, item.y);
      const released = mouse(page, 'mouseReleased', item.x, item.y).catch((e) => e);
      for (const s of steps) { xkeys('{dialog}', ...s); await sleep(1000); }
      await released;
    };
    const zoneFolder = () => evaluate(page, `(window.__flow.state().ws.find((w) => w.id === 'voiceless').zones.find((z) => z.id === 'z-bare') || {}).folder || null`);
    const item0 = await folderItem();
    if (item0) await choose(item0, ['{click}', '{Down}'], ['{accept}']);
    const picked = await waitFor(async () => { const f = await zoneFolder(); return f && f.endsWith('/pick-me') ? f : null; }, 4000);
    const zb = await heading('zone|z-bare');
    if (zb) await click(page, zb.x, zb.y);
    const pickRows = await waitFor(async () => { const l = await labels(page); return l.includes('▸ pick-me') ? l : null; }, 5000);
    if (pickRows) await clickRow(page, 'pick-me', 0);
    const pickFile = await waitFor(async () => (await labels(page)).includes('  picked.txt'), 5000);
    R.ok("its heading's \"folder\" (hint: the folder in use) opens the Mac's picker; the folder picked there is its own, shown under its heading with its file",
      !!item0 && item0.hint === A_TILDE(path.join(CWD, 'voiceless')) && picked === A_TILDE(pickDir) && !!pickRows && pickFile === true, { item: item0, picked, rows: pickRows || await labels(page) });
    const mh2 = await heading('zone|');
    if (mh2) await click(page, mh2.x, mh2.y);
    await sleep(500);
    const item1 = await folderItem();
    if (item1) await choose(item1, ['{Escape}']);
    const afterEsc = await zoneFolder();
    R.ok("Esc in the picker leaves the sub-workspace's folder as it was", !!item1 && item1.hint === A_TILDE(pickDir) && afterEsc === A_TILDE(pickDir), { item: item1, afterEsc });

    // 7k. A download made from a page in a sub-workspace shows under that sub-workspace's heading, not main's (app.js
    // passes the page's space to FlowFiles.downloaded). Its file goes after the check, so section 10's first download
    // is report.pdf again.
    const zb2 = await heading('zone|z-bare');
    if (zb2) await click(page, zb2.x, zb2.y);
    await sleep(700);
    // A download is reported twice, by its page (with its space) and by main (without): the check reads the end state,
    // 3 s after the first report, never the moment between the two
    await evaluate(page, `(() => { window.__dlReports = []; const f = window.FlowFiles.downloaded; window.FlowFiles.downloaded = function (ws, d, z) { window.__dlReports.push({ file: d && d.file, zone: z || null }); return f.call(this, ws, d, z); }; return true; })()`);
    const dlWinId = await downloadIn(page, 'in-a-sub-workspace');
    const dlFile = path.join(DL_DIR, 'report.pdf');
    const reported = await waitFor(() => evaluate(page, `window.__dlReports.some((x) => x.file === ${JSON.stringify(dlFile)})`), 10000);
    await sleep(3000);
    const zdl = await evaluate(page, `(() => { const ws = window.__flow.state().ws.find((w) => w.id === 'voiceless'); const d = (ws.downloads || []).find((x) => x.file === ${JSON.stringify(dlFile)}); const w = ws.windows.find((x) => x.id === ${JSON.stringify(dlWinId)}); return d ? { zone: d.zone || '', win: w ? w.zone || '' : null } : null; })()`);
    const reports = await evaluate(page, `window.__dlReports.filter((x) => x.file === ${JSON.stringify(dlFile)}).map((x) => x.zone)`);
    // the files rows under each space's heading, in the order the sidebar draws them
    const bySpace = () => evaluate(page, `(() => { const out = {}; let at = 'main'; for (const r of document.querySelectorAll('#sblist .tr')) { const act = r.dataset.act || ''; if (act.startsWith('zone|')) { at = act.slice(5) || 'main'; continue; } if (!act.startsWith('files|')) continue; const g = r.querySelector('.g'), m = r.querySelector('.m'); (out[at] = out[at] || []).push((g && g.textContent ? g.textContent + ' ' : '') + r.querySelector('.l').textContent + (m && m.textContent ? ' [' + m.textContent + ']' : '')); } return out; })()`);
    const spaces = await bySpace();
    R.ok("a download made in a sub-workspace shows under its heading once it is reported, and main's downloads stay as they were",
      reported === true && !!zdl && zdl.zone === 'z-bare' && zdl.win === 'z-bare' && !!spaces['z-bare'] && spaces['z-bare'].includes('▸ downloads [1]') && !!spaces.main && spaces.main.includes('▸ downloads [1]'),
      { download: zdl, reports, rows: spaces });
    fs.rmSync(path.join(DL_DIR, 'report.pdf'), { force: true });
    await evaluate(page, 'window.__flow.go(0)');
    await sleep(700);
  }

  // 8. Right-click: one item, show in Finder (named for this platform).
  const p = await rowAt(page, 'README.md', 1);
  await mouse(page, 'mouseMoved', p.x, p.y);
  await mouse(page, 'mousePressed', p.x, p.y, { button: 'right', buttons: 2 });
  await mouse(page, 'mouseReleased', p.x, p.y, { button: 'right', buttons: 0 });
  await sleep(300);
  const items = await evaluate(page, `[...document.querySelectorAll('.ctx button')].map((b) => b.firstChild.textContent)`);
  R.ok('right-click on a file offers only "show in Finder"', JSON.stringify(items) === JSON.stringify([process.platform === 'darwin' ? 'show in Finder' : 'show in its folder']), items);
  await shot(page, `${SHOTS}/05-menu.png`);
  await evaluate(page, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await click(page, 900, 960);

  // 9. A drag carries the file for a terminal and its path for a note; dropped on a shell here, the path is typed.
  const sh = await evaluate(page, `window.__flow.spawn('shell')`);
  const shReady = await waitFor(() => evaluate(page, `(() => { const t = window.__flow.term(${JSON.stringify(sh)}); return !!t && t.getText(50).trim().length > 0; })()`), 15000, 300);
  await page.send('Input.setInterceptDrags', { enabled: true });
  let dragged = null;
  page.on((m) => { if (m.method === 'Input.dragIntercepted') dragged = m.params.data; });
  const q = await rowAt(page, 'README.md', 1);
  await mouse(page, 'mouseMoved', q.x, q.y);
  await mouse(page, 'mousePressed', q.x, q.y);
  for (let i = 1; i <= 8; i++) await mouse(page, 'mouseMoved', q.x + i * 12, q.y + i * 6, { down: true });
  await sleep(300);
  await mouse(page, 'mouseReleased', q.x + 96, q.y + 48);
  const kinds = dragged ? Object.fromEntries(dragged.items.map((it) => [it.mimeType, it.data])) : {};
  R.ok('a dragged row carries [{ host, path }] for terminals and the path as text', kinds['application/x-flow-files'] === JSON.stringify([{ host: null, path: path.join(PROJ, 'README.md') }]) && kinds['text/plain'] === path.join(PROJ, 'README.md'), kinds);
  // An intercepted drag lasts until it is dropped or cancelled; until then the page takes no clicks.
  const box = shReady ? await evaluate(page, `(() => { const b = window.__flow.term(${JSON.stringify(sh)}).el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`) : null;
  if (dragged && box) {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data: dragged });
  } else if (dragged) {
    await page.send('Input.dispatchDragEvent', { type: 'dragCancel', x: q.x + 96, y: q.y + 48, data: dragged });
  }
  await page.send('Input.setInterceptDrags', { enabled: false });
  // A narrow terminal wraps the path over lines.
  const typed = box && await waitFor(() => evaluate(page, `window.__flow.term(${JSON.stringify(sh)}).getText(50).replace(/\\n/g, '').includes(${JSON.stringify(path.join(PROJ, 'README.md'))})`), 4000);
  R.ok('dropped on a shell in this workspace, the row types its path', !!typed, box ? await evaluate(page, `window.__flow.term(${JSON.stringify(sh)}).getText(20)`) : 'no shell came up');
  await shot(page, `${SHOTS}/05b-dropped-on-shell.png`);

  // 10. A download from a page of this workspace shows under its downloads, and opens as a page.
  await downloadIn(page, 'flow');
  const dl = await waitFor(async () => { const ws = await curWs(page); return ws.downloads && ws.downloads.length ? ws.downloads : null; }, 8000);
  R.ok('a finished download is kept in the workspace whose page downloaded it', !!dl && dl.length === 1 && dl[0].file === path.join(DL_DIR, 'report.pdf') && dl[0].url === `${SITE}/report.pdf`, dl);
  rows = await labels(page);
  R.ok('a "downloads" row appears with its count', rows.includes('▸ downloads [1]'), rows);
  await clickRow(page, 'downloads', 0);
  const dlWin = await openedAs(page, () => clickRow(page, 'report.pdf', 1), path.join(DL_DIR, 'report.pdf'));
  R.ok('a download opens as its own page window holding just it', ownWindow(dlWin), dlWin);
  const pdf = await guestOf('report.pdf', (t) => t.title === 'report.pdf');
  R.ok('a click on the download opens the pdf as a page, titled with its name', !!pdf && isFileUrl(pdf.url, path.join(DL_DIR, 'report.pdf')), pdf ? pdf.url : await tabsOf(page));
  await shot(page, `${SHOTS}/06-download-open.png`);
  R.ok('the downloads folder is watched while its row is unfolded', (await waitFor(() => watchedOf([DL_DIR]) === 1, 2000)) === true, watchedOf([DL_DIR]));

  // 11. A download in another workspace stays there.
  await evaluate(page, 'window.__flow.go(1)');
  await sleep(700);
  await downloadIn(page, 'mynotes');
  const other = await waitFor(async () => { const ws = await curWs(page); return ws.downloads && ws.downloads.length ? ws : null; }, 8000);
  const flowWs = await evaluate(page, `window.__flow.state().ws[0]`);
  R.ok('a download in mynotes is kept in mynotes only', !!other && other.id === 'mynotes' && other.downloads[0].file === path.join(DL_DIR, 'report (1).pdf') && flowWs.downloads.length === 1, { other: other && other.downloads, flow: flowWs.downloads });
  rows = await labels(page);
  R.ok('mynotes shows its folder and its own download', JSON.stringify(rows) === JSON.stringify(['▸ mynotes', '▸ downloads [1]']), rows);
  await evaluate(page, 'window.__flow.go(0)');
  await sleep(700);

  // 12. A download trashed outside Flow leaves the list.
  fs.rmSync(path.join(DL_DIR, 'report.pdf'));
  R.ok('a download removed from disk leaves the list, and the empty row goes', !!(await waitFor(async () => !(await labels(page)).some((l) => /downloads|report\.pdf/.test(l)), 4000)), await labels(page));
  R.ok('and the workspace forgets it', ((await curWs(page)).downloads || []).length === 0, (await curWs(page)).downloads);

  // 13. A folder on the VM, through vmfiles.js itself with its ssh lines run locally (test/files-vm-local.js), when
  // the tree's main.js was given it by hand (scratch trees only).
  if (!fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8').includes('FILES_VM')) {
    console.log("skip the VM rows: this tree's main.js does not wire test/files-vm-local.js");
  } else {
    const dragData = async (label, depth) => {
      let got = null;
      page.on((m) => { if (m.method === 'Input.dragIntercepted' && !got) got = m.params.data; });
      await page.send('Input.setInterceptDrags', { enabled: true });
      const at = await rowAt(page, label, depth);
      await mouse(page, 'mouseMoved', at.x, at.y);
      await mouse(page, 'mousePressed', at.x, at.y);
      for (let i = 1; i <= 8; i++) await mouse(page, 'mouseMoved', at.x + i * 12, at.y + i * 6, { down: true });
      await sleep(300);
      await mouse(page, 'mouseReleased', at.x + 96, at.y + 48);
      if (got) await page.send('Input.dispatchDragEvent', { type: 'dragCancel', x: at.x + 96, y: at.y + 48, data: got });
      await page.send('Input.setInterceptDrags', { enabled: false });
      return got ? Object.fromEntries(got.items.map((it) => [it.mimeType, it.data])) : {};
    };
    await evaluate(page, 'window.__flow.go(4)');
    await sleep(700);
    rows = await labels(page);
    R.ok('a workspace that runs on the VM shows its VM folder, marked once', JSON.stringify(rows) === JSON.stringify(['▸ ef', '▸ proj [on the VM]']), rows);
    await clickRow(page, 'proj', 0);
    rows = await waitFor(async () => { const l = await labels(page); return l.length > 2 ? l : null; });
    R.ok('it unfolds as a Mac folder does, rows unmarked, hidden names left out', JSON.stringify(rows) === JSON.stringify(['▸ ef', '▾ proj [on the VM]', '  ▸ src', '  notes.md', '  plan.md']), rows);
    await clickRow(page, 'src', 1);
    R.ok('its folders unfold by their path on the VM', !!(await waitFor(async () => (await labels(page)).includes('    main.py'))), await labels(page));
    let d = await dragData('notes.md', 1);
    R.ok('a VM file drags with its host and its absolute VM path', d['application/x-flow-files'] === JSON.stringify([{ host: 'standin', path: path.join(VM_HOME, 'proj', 'notes.md') }]), d);
    d = await dragData('proj', 0);
    R.ok("the folder asked for as '~/proj' drags as the path the VM resolved", d['application/x-flow-files'] === JSON.stringify([{ host: 'standin', path: path.join(VM_HOME, 'proj') }]), d);
    await clickRow(page, 'proj', 0);
    fs.writeFileSync(path.join(VM_HOME, '.down'), '');
    await clickRow(page, 'proj', 0);
    rows = await waitFor(async () => { const l = await labels(page); return l.includes('▾ proj [on the VM · the VM is not reachable]') ? l : null; });
    R.ok('an unreachable VM says so on its folder row, nothing else', !!rows && rows.length === 2 && !(await evaluate(page, `document.getElementById('toast').classList.contains('on')`)), rows || await labels(page));
    fs.rmSync(path.join(VM_HOME, '.down'));
    R.ok('when the VM is back, the folder and the folders under it fill in by themselves', !!(await waitFor(async () => { const l = await labels(page); return l.includes('  notes.md') && l.includes('    main.py') && !l.some((x) => x.includes('not reachable')); }, 10000)), await labels(page));
    fs.writeFileSync(path.join(VM_HOME, 'proj', 'from-agent.txt'), 'written on the VM\n');
    R.ok('a file an agent writes on the VM appears by itself', !!(await waitFor(async () => (await labels(page)).includes('  from-agent.txt'), 6000)), await labels(page));
    const vmKinds = [await openedAs(page, () => clickRow(page, 'notes.md', 1), path.join(VM_HOME, 'proj', 'notes.md'), 'standin')];
    const vmPage = await guestOf('notes.md', (t) => t.title === 'notes.md', 10000);
    let vmText = '';
    if (vmPage) { const g = await connectGuest(vmPage); vmText = await evaluate(g, 'document.body.innerText'); g.ws.close(); }
    R.ok('a click on a VM file opens it as a page, by vmfiles and the same check', !!vmPage && isFileUrl(vmPage.url, path.join(VM_HOME, 'proj', 'notes.md'), 'standin') && vmText.trim().startsWith('on the vm'), vmPage ? { url: vmPage.url, vmText } : await tabsOf(page));
    // page shows where a file is in a dim label after the field (.pwhere, shown with .on)
    const vmAddr = await evaluate(page, `(() => { const i = [...document.querySelectorAll('input.ad')].find((x) => x.value.endsWith('/notes.md') && x.offsetParent); if (!i) return null; const h = i.closest('.addr').querySelector('.pwhere.on'); return { value: i.value, hint: h && h.offsetParent ? h.textContent : '' }; })()`);
    R.ok('a VM file tab shows its full VM path, "on the VM" as the hint (page, batch 3)', !!vmAddr && vmAddr.value === path.join(VM_HOME, 'proj', 'notes.md') && /on the VM/.test(vmAddr.hint), vmAddr);
    // A .md on the VM: rendered, its relative link signed as a VM address inside the workspace folder, and live: a
    // write on the VM re-renders the open tab and the heading being read stays put. The first write lands as soon as
    // the open has fetched its copy, before the watch first looks at the file, while that copy is still young.
    const vmPlan = path.join(VM_HOME, 'proj', 'plan.md');
    const pid = mainPid();
    const early = waitFor(() => vmCopy(pid, 'plan.md'), 8000, 5).then((f) => {
      if (f) fs.writeFileSync(vmPlan, fs.readFileSync(vmPlan, 'utf8').replace('# vm plan\n', '# vm plan\n\nWritten as the tab opened.\n'));
      return !!f;
    });
    vmKinds.push(await openedAs(page, () => clickRow(page, 'plan.md', 1), vmPlan, 'standin'));
    const vt = await guestOf('plan.md', (t) => t.title === 'plan.md' && t.url.startsWith('flow-file://vm/'), 10000);
    const vg = vt ? await connectGuest(vt) : null;
    // read once it has rendered: the write just after the open re-renders it, and a read in between finds no page yet
    const vdom = vg ? await waitFor(() => evaluate(vg, `(() => { const h = document.querySelector('h1'); return h ? { h1: h.textContent, href: (document.querySelector('a') || { getAttribute: () => '' }).getAttribute('href') } : null; })()`).catch(() => null), 5000) : null;
    R.ok('a VM .md opens rendered; its relative link is a signed VM address', !!vdom && vdom.h1 === 'vm plan' && isFileUrl(vdom.href, path.join(VM_HOME, 'proj', 'notes.md'), 'standin'), vdom);
    const vsrc = vg ? await evaluate(vg, `({ text: document.body.innerText.includes('the source'), linked: [...document.querySelectorAll('a')].some((a) => a.textContent === 'the source') })`) : null;
    R.ok('a link in a VM .md to a folder stays text, as on the Mac', !!vsrc && vsrc.text && !vsrc.linked, vsrc);
    const wroteEarly = await early;
    const seenEarly = vg && wroteEarly ? await waitFor(() => evaluate(vg, `document.body.innerText.includes('Written as the tab opened.')`).catch(() => false), 8000, 250) : false;
    R.ok('a write on the VM right after the open fetched the file shows in the tab', !!seenEarly, { wroteEarly, seenEarly });
    if (vg) {
      await evaluate(vg, `document.getElementById('third').scrollIntoView(); 1`);
      await sleep(300);
      const v0 = await evaluate(vg, `Math.round(document.getElementById('third').getBoundingClientRect().top)`);
      fs.writeFileSync(vmPlan, fs.readFileSync(vmPlan, 'utf8').replace('# vm plan\n', '# vm plan\n\nA line an agent wrote on the VM.\n'));
      const vfresh = await waitFor(() => evaluate(vg, `document.body.innerText.includes('A line an agent wrote on the VM.')`).catch(() => false), 8000, 250);
      await sleep(300);
      const v1 = await evaluate(vg, `Math.round(document.getElementById('third').getBoundingClientRect().top)`).catch(() => null);
      R.ok('a write on the VM shows in the open tab, and the heading being read stays put', !!vfresh && v1 !== null && Math.abs(v1 - v0) <= 12, { vfresh, v0, v1 });
      vg.ws.close();
    }
    // A report on the VM opens whole too: its folder's address reaches the VM module, which serves each file under it as
    // this Mac does (its style sheet and script as what they are, its page under the same policy).
    fs.cpSync(path.join(ROOT, 'test', 'files-reports', 'htmlcov'), path.join(VM_HOME, 'proj', 'cov'), { recursive: true });
    const covRow = await waitFor(async () => (await labels(page)).includes('  ▸ cov'), 8000);
    if (covRow) {
      await clickRow(page, 'cov', 1);
      await waitFor(async () => (await labels(page)).includes('    index.html'), 8000);
      vmKinds.push(await openedAs(page, () => clickRow(page, 'index.html', 2), path.join(VM_HOME, 'proj', 'cov', 'index.html'), 'standin'));
    }
    const vct = await guestOf('/standin/', (t) => t.title === 'Coverage report' && t.url.startsWith('flow-file://vm/'), 10000);
    const vcg = vct ? await connectGuest(vct) : null;
    let vcov = null;
    if (vcg) {
      const okCov = await waitFor(async () => { vcov = { sheets: await evaluate(vcg, `[...document.styleSheets].map((s) => { try { return (s.href || 'inline').split('/').pop() + ':' + s.cssRules.length; } catch (e) { return 'unreadable'; } })`), js: await evaluate(vcg, 'typeof coverage') }; return vcov.sheets.some((x) => /style_cb_4667309f\.css:\d{3}/.test(x)) && vcov.js === 'object'; }, 8000);
      vcov.ok = okCov === true;
    }
    R.ok('a coverage report in a VM folder opens with its own style sheet and script', !!vcov && vcov.ok, vcov || { covRow });
    if (vcg) vcg.ws.close();
    if (covRow) await clickRow(page, 'cov', 1);
    // Any VM file shown as a page is live too: code an agent edits there shows in its open tab.
    vmKinds.push(await openedAs(page, () => clickRow(page, 'main.py', 2), path.join(VM_HOME, 'proj', 'src', 'main.py'), 'standin'));
    const pyt = await guestOf('main.py', (t) => t.title === 'main.py' && t.url.startsWith('flow-file://vm/'), 10000);
    const pyg = pyt ? await connectGuest(pyt) : null;
    if (pyg) {
      fs.writeFileSync(path.join(VM_HOME, 'proj', 'src', 'main.py'), 'print(2)\n');
      const pySeen = await waitFor(() => evaluate(pyg, `document.body.innerText.includes('print(2)')`).catch(() => false), 8000, 250);
      R.ok('code an agent edits on the VM shows in its open tab', !!pySeen);
      pyg.ws.close();
    } else {
      R.ok('main.py on the VM opens', false, await tabsOf(page));
    }
    R.ok('a VM file opens as its own page window holding just it, for Markdown, a report and code', vmKinds.length === 4 && vmKinds.every(ownWindow), vmKinds);
    const vmNotes = (await pageWindows(page)).find((w) => w.urls.some((u) => isFileUrl(u, path.join(VM_HOME, 'proj', 'notes.md'), 'standin')));
    const vmCount = (await pageWindows(page)).length;
    await clickRow(page, 'notes.md', 1);
    const vmInFront = await waitFor(async () => (vmNotes && (await frontWindow(page)) === vmNotes.id ? true : null), 3000);
    // a sub-workspace of a workspace on the VM: its own folder there (item 15)
    const vmZone = await evaluate(page, `(() => { const ws = window.__flow.state().ws.find((w) => w.id === 'ef'); const out = []; window.FlowFiles.rows(ws, (g, d, glyph, label, meta) => out.push(glyph + ' ' + label + (meta ? ' [' + meta + ']' : '')), [], 'z-vm'); return out; })()`);
    const vmTyped = await evaluate(page, `(async () => { const ws = window.__flow.state().ws.find((w) => w.id === 'ef'); const hint = window.FlowFiles.folderOf(ws, 'z-vm'); const picked = await window.FlowFiles.pickFolder(ws, 'z-vm'); const set = window.FlowFiles.setFolder(ws, 'z-vm', '~/zother'); const out = []; window.FlowFiles.rows(ws, (g, d, glyph, label, meta) => out.push(glyph + ' ' + label + (meta ? ' [' + meta + ']' : '')), [], 'z-vm'); return { hint, picked, set, rows: out }; })()`);
    R.ok('on a workspace on the VM the folder item types the VM path (no Mac picker), and the typed folder shows on the VM', vmTyped.hint === '~/zproj' && vmTyped.picked === false && vmTyped.set === true && JSON.stringify(vmTyped.rows) === JSON.stringify(['▸ zother [on the VM]']), vmTyped);
    const vmZoneOpen = await evaluate(page, `window.flow.files.open('standin', ${JSON.stringify(path.join(VM_HOME, 'zproj', 'z.py'))})`);
    const vmOther = await evaluate(page, `window.flow.files.open('standin', ${JSON.stringify(path.join(VM_HOME, 'zother', 'x.py'))})`);
    R.ok("a sub-workspace's own VM folder shows on the VM and its files open; a VM file in no workspace's folder does not", JSON.stringify(vmZone) === JSON.stringify(['▸ zproj [on the VM]']) && !!vmZoneOpen && typeof vmZoneOpen.url === 'string' && !!vmOther && vmOther.error === 'not in a workspace folder', { vmZone, vmZoneOpen, vmOther });
    R.ok('a VM file already open is shown where it is: no new window, its window comes to the front', !!vmNotes && vmInFront === true && (await pageWindows(page)).length === vmCount, { notes: vmNotes && vmNotes.id, front: await frontWindow(page), before: vmCount, after: (await pageWindows(page)).length });
    await shot(page, `${SHOTS}/06b-vm-folder.png`);
    await evaluate(page, 'window.__flow.go(0)');
    await sleep(700);
  }

  // A file's own window lands over nothing (the lead's item 1: "It never covers anything").
  R.ok("a file's own window covers no other window (Mac, VM, a download)", opened.length > 0 && opened.every((k) => Array.isArray(k.covers) && k.covers.length === 0), opened.filter((k) => !Array.isArray(k.covers) || k.covers.length).map((k) => ({ name: k.name, covers: k.covers })));

  // 14. No errors from the files code.
  const errs = page.errors.filter((e) => /files/i.test(e));
  R.ok('no console errors or warnings from the files code', errs.length === 0, errs);
  // stop() ends electron with SIGTERM, which skips the flush a real quit does (beforeunload): flush as it would.
  await evaluate(page, 'window.flow.flushState(window.__flow.state())');
  page.ws.close();

  // 15. After a restart, the folders come back unfolded as they were left, with the downloads.
  await stop(app);
  app = launch();
  page = await connect();
  // read once the unfolded src lists its names again: with every page in its own window, many come back with it
  const restoredAt = Date.now();
  rows = await waitFor(async () => { const l = await labels(page); return l.includes('  ▾ src') && l.includes('    ▸ deep') ? l : null; }, 15000);
  R.ok('after a restart the unfolded folders come back as they were', !!rows && rows[0] === '▾ flow' && rows.includes('  ▾ src') && rows.includes('  ▸ many') && rows.includes('    ▸ deep'), { listedInMs: Date.now() - restoredAt, rows: rows || await labels(page) });
  // The file tab shown in that page window when it was left (the last html file opened) comes back from its address.
  const shownBefore = { 'PLAN.md': 'files in the sidebar', nometa: '›_ ✎ ◫', utf8meta: '›_ ✎ ◫', legacy: 'price €5', 'ideas.txt': 'ideas', 'guide.md': 'The third part.', 'steps.md': 'plan step 120', 'agent.log': 'step 0', 'one.txt': 'one', 'two.md': 'two', 'three': 'three' };
  const back = await guestOf('flow-file://mac/', (t) => t.title in shownBefore, 10000);
  let backText = '';
  if (back) { const g = await connectGuest(back); backText = await evaluate(g, 'document.body.innerText'); g.ws.close(); }
  R.ok('and the file tab it showed opens its file again from its saved address', !!back && backText.includes(shownBefore[back.title]), back ? { title: back.title, text: backText.slice(0, 60) } : await tabsOf(page));
  await evaluate(page, 'window.__flow.go(1)');
  await sleep(700);
  R.ok('and mynotes still lists its download', (await labels(page)).includes('▸ downloads [1]'), await labels(page));
  await shot(page, `${SHOTS}/07-after-restart.png`);
  page.ws.close();
} catch (e) {
  R.ok(`run: ${e.message}`, false);
} finally {
  if (app) await stop(app);
  srv.close();
  udpSock.close();
  tcpSrv.close();
}
R.summary();




