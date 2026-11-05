// vmfiles in the whole app: the files group of a workspace that runs on the VM, through the tree's own main.js,
// preload.js, files.js, files-main.js and pty.js's sshSpawn. The workspace's host is vmfiles-standin.invalid, a name
// that cannot resolve. test/vmfiles-app-standin.cjs (loaded with NODE_OPTIONS, in the probe too) serves only that host
// locally, refuses any other, starts no ssh process and logs every ssh asked for. The test also watches the app's
// process tree for an ssh process. Real mouse input over CDP; one app at a time; port 9577, socket flow-dev-vmfiles,
// userData /tmp/flow-dev-vmfiles. Every window that has a host is removed from the seed, and local agents are parked,
// so no terminal runs.
//   VMFILES_ROOT=<tree> node test/vmfiles-app-cdp.mjs      (the tree to run, ~/flow by default)
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, click, sleep, shot, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.VMFILES_ROOT || path.resolve(HERE, '..');
const PORT = 9577;
const MARK = 'vmfiles';
const SOCK = 'flow-dev-vmfiles';
const DATA = '/tmp/flow-dev-vmfiles';
const VMHOME = path.join(DATA, 'vmhome');
const CWD = '/home/claude/.flow-dev/vmfiles/app';
const HOST = 'vmfiles-standin.invalid';
const OUT = '/home/claude/flow-evidence/vmfiles/app';
const LOG = path.join(OUT, 'app.log');
const SSH_LOG = path.join(OUT, 'ssh-attempts.log');
const PROBE_SSH_LOG = path.join(OUT, 'probe-ssh-attempts.log');
const HOOK = `NODE_OPTIONS=--require ${path.join(HERE, 'vmfiles-app-standin.cjs')}`;
const R = reporter();

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

// A process's working folder, or '' once it has ended.
const cwdOf = (pid) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return '';
    throw e;
  }
};
/* This run's VM-side loops of WATCH_SH (life 600, not one-time listings with life 0), found in the stand-in's home since
   other tests on this machine run the same loops elsewhere; a loop's own subshells are not counted. */
function loops() {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[3].startsWith('sh -c ') && m[3].includes('tick=$1; end=') && m[3].includes('done sh 2 600 ') && cwdOf(m[1]) === VMHOME);
  const pids = new Set(rows.map((m) => m[1]));
  return rows.filter((m) => !pids.has(m[2]));
}
/* What a loop watches, from its own argv (sh -c WATCH_SH sh <tick> <life>, then kind, path, hash for each). */
function watchedBy(pid) {
  let a;
  try {
    a = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(6, -1);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null;
    throw e;
  }
  const out = [];
  for (let i = 0; i < a.length; i += 3) out.push(`${a[i]} ${a[i + 1]}`);
  return out;
}
/* The relay (the stand-in ssh client) of the running loop. */
function loopRelays() {
  return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].startsWith('/usr/bin/node -e ') && m[2].includes("'sh' '2' '600' "))
    .map((m) => +m[1]);
}

/* Processes of a Flow started with our marker (main and helpers), and any ssh below its main process. */
function procs() {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], args: m[3] }));
}
const ours = (list) => list.filter((p) => p.args.includes('electron') && / --flow-dev=vmfiles(-probe)?( |$)/.test(p.args));
const sshSeen = [];
let sampled = 0;   // samples that found this test's Flow running
function sshBelowApp() {
  const list = procs();
  const mains = ours(list).filter((p) => !p.args.includes('--type='));
  if (mains.length) sampled++;
  const kids = new Map();
  for (const p of list) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p);
  const below = [];
  const walk = (pid) => (kids.get(pid) || []).forEach((c) => { below.push(c); walk(c.pid); });
  mains.forEach((m) => walk(m.pid));
  for (const p of below) if (/(^|\/)ssh(\s|$)/.test(p.args)) sshSeen.push(p.args.slice(0, 200));
}
const watcher = setInterval(sshBelowApp, 200);
const loggedSsh = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alone = () => ours(procs()).length === 0 && !spawnSync('ss', ['-ltn']).stdout.toString().includes(`:${PORT} `);

/* ---------- a first-run state with no host windows and no running agents ---------- */
async function seed() {
  if (!alone()) throw new Error('another Flow of this test is running, or port 9577 is taken: one app at a time');
  const PROBE = `${DATA}-probe`;
  fs.rmSync(PROBE, { recursive: true, force: true });
  fs.mkdirSync(PROBE, { recursive: true });
  fs.writeFileSync(path.join(PROBE, 'flow-state.json'), JSON.stringify({ v: 11, ws: [{ id: 'probe', name: 'probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  const probe = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${PROBE}`, `FLOW_TMUX_SOCKET=${SOCK}-probe`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1',
    HOOK, `VMFILES_SSH_LOG=${PROBE_SSH_LOG}`,
    './node_modules/.bin/electron', '.', '--no-sandbox', `--flow-dev=${MARK}-probe`], { cwd: ROOT, stdio: 'ignore', detached: true });
  let ws;
  try {
    const page = await connectTo(PORT, /\/src\/index\.html$/);
    for (let i = 0; i < 80 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
    await evaluate(page, 'window.__flow.ready');
    ws = await evaluate(page, 'window.__flow.seed()');
    page.ws.close();
  } finally {
    await stop(probe, `${SOCK}-probe`);
    fs.rmSync(PROBE, { recursive: true, force: true });
  }
  for (const w of ws) {
    w.folder = path.join(CWD, w.id);
    fs.mkdirSync(w.folder, { recursive: true });
    for (const k of ['windows', 'closed']) w[k] = (w[k] || []).filter((x) => !x.host);
    w.windows = w.windows.filter((x) => {
      if (x.type !== 'term' && x.type !== 'team') return true;
      w.closed.push(x);
      return false;
    });
    if (w.id === 'ef') {
      w.host = HOST;
      w.hostFolder = '~/proj';
      w.zones = [...(w.zones || []), { id: 'z-vm', name: 'vm work', pan: 0, hostFolder: '~/zproj' }];   // item 15
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(VMHOME, 'proj', 'src'), { recursive: true });
  fs.writeFileSync(path.join(VMHOME, 'proj', 'notes.md'), '# on the vm\n\nwritten by an agent there\n\nsee [the code](src) and [main](src/main.py)\n');
  fs.writeFileSync(path.join(VMHOME, 'proj', 'src', 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(VMHOME, 'proj', '.hidden'), 'x\n');
  fs.mkdirSync(path.join(VMHOME, 'zproj'), { recursive: true });
  fs.writeFileSync(path.join(VMHOME, 'zproj', 'z.py'), 'print("in the sub-workspace")\n');
  fs.writeFileSync(path.join(VMHOME, 'zproj', 'plan.md'), '# zone plan\n');
  fs.writeFileSync(path.join(DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws, ui: {} }));
  return ws;
}

function launch() {
  if (!alone()) throw new Error('another Flow of this test is running, or port 9577 is taken: one app at a time');
  return spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${DATA}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1',
    HOOK, `VMFILES_SSH_LOG=${SSH_LOG}`,
    './node_modules/.bin/electron', '.', '--no-sandbox', `--flow-dev=${MARK}`], { cwd: ROOT, stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')], detached: true });
}
async function stop(app, sock) {
  try { process.kill(-app.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 40; i++) {
    try { process.kill(-app.pid, 0); } catch { break; }
    await sleep(250);
  }
  spawnSync('tmux', ['-L', sock, 'kill-server']);
}

/* ---------- the sidebar's files group ---------- */
const filesRows = (page) => evaluate(page, `[...document.querySelectorAll('#sblist .tr[data-act^="files|"]')].map((e) => ({ label: e.querySelector('.l').textContent, depth: +(/\\bd(\\d+)\\b/.exec(e.className) || [0, 0])[1], meta: (e.querySelector('.m') || {}).textContent || '', glyph: e.querySelector('.g').textContent }))`);
const labels = async (page) => (await filesRows(page)).map((r) => `${'  '.repeat(r.depth)}${r.glyph ? r.glyph + ' ' : ''}${r.label}${r.meta ? ` [${r.meta}]` : ''}`);
async function rowAt(page, label, depth) {
  return evaluate(page, `(() => {
    const r = [...document.querySelectorAll('#sblist .tr[data-act^="files|"]')].find((e) => e.querySelector('.l').textContent === ${JSON.stringify(label)} && e.classList.contains('d' + ${depth}));
    if (!r) return null;
    r.scrollIntoView({ block: 'nearest' });
    const b = r.querySelector('.l').getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
}
async function clickRow(page, label, depth) {
  const p = await waitFor(() => rowAt(page, label, depth), 3000);
  if (!p) throw new Error(`no files row ${label} at depth ${depth}; rows: ${(await labels(page)).join(' | ')}`);
  await click(page, p.x, p.y);
  await sleep(350);
}
const encodedPath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
async function guestOf(match, ok = () => true, ms = 10000) {
  return waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    return list.find((t) => t.type === 'webview' && t.url.includes(match) && ok(t)) || null;
  }, ms, 250);
}
async function guestEval(t, expression) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot open ${t.webSocketDebuggerUrl}`)); });
  const r = await new Promise((res) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m.result); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  ws.close();
  return r && r.result ? r.result.value : '';
}
const guestText = (t) => guestEval(t, "document.body ? document.body.innerText : ''");   // no body while a reload is under way

let app = null;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
try {
  const ws = await seed();
  const ef = ws.findIndex((w) => w.id === 'ef');
  app = launch();
  const page = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  await sleep(800);
  const mac = 'ef';   // a folder row is named by its folder's name, as in Finder

  await evaluate(page, `window.__flow.go(${ef})`);
  await sleep(700);
  let rows = await labels(page);
  R.ok('a workspace that runs on the VM shows its VM folder, marked once', JSON.stringify(rows) === JSON.stringify([`▸ ${mac}`, '▸ proj [on the VM]']), rows);
  R.ok('folded, nothing runs on the VM', loops().length === 0, loops().length);

  await clickRow(page, 'proj', 0);
  rows = await waitFor(async () => { const l = await labels(page); return l.length > 2 ? l : null; }, 10000);   // the first listing: under heavy load the stand-in takes seconds to start
  R.ok('a click unfolds it as a Mac folder unfolds: rows unmarked, no hidden names', JSON.stringify(rows) === JSON.stringify([`▸ ${mac}`, '▾ proj [on the VM]', '  ▸ src', '  notes.md']), rows);
  R.ok('while it shows, one loop runs on the VM', !!(await waitFor(() => loops().length === 1, 4000)), loops().length);
  await clickRow(page, 'src', 1);
  R.ok('a VM folder unfolds by its path on the VM', !!(await waitFor(async () => (await labels(page)).includes('    main.py'), 10000)), await labels(page));
  R.ok('two folders shown, still one loop', !!(await waitFor(() => loops().length === 1, 6000)) && (await sleep(2500), loops().length === 1), loops().length);
  await shot(page, `${OUT}/01-vm-folder.png`);

  fs.writeFileSync(path.join(VMHOME, 'proj', 'from-agent.txt'), 'written on the VM\n');
  R.ok('a file an agent writes on the VM appears by itself', !!(await waitFor(async () => (await labels(page)).includes('  from-agent.txt'), 10000)), await labels(page));

  const pageWins = () => evaluate(page, `window.__flow.windows().filter((w) => w.ws === 'ef' && w.type === 'page').map((w) => { const p = window.__flow.page(w.id); return { id: w.id, url: p ? p.getURL() : '', tabs: p ? p.tabs().tabs.length : 0, front: !!document.querySelector('.win.front[data-id="' + w.id + '"]') }; })`);
  const pages0 = await pageWins();
  await clickRow(page, 'notes.md', 1);
  const t = await guestOf('notes.md', (x) => x.title === 'notes.md', 20000);   // the first page from the VM: seconds under heavy load
  const text = t ? await guestText(t) : '';
  const want = `/${HOST}/${encodedPath(path.join(VMHOME, 'proj', 'notes.md'))}`;
  R.ok('a click on a VM file opens it as a page at its signed address', !!t && /^flow-file:\/\/vm\/[A-Za-z0-9_-]{22}\//.test(t.url) && t.url.endsWith(want) && text.includes('on the vm') && text.includes('written by an agent there'), t ? { url: t.url, text } : 'no page');
  const linked = JSON.parse((t && (await guestEval(t, "JSON.stringify({ a: [...document.querySelectorAll('a')].map((x) => [x.textContent, x.getAttribute('href')]), text: document.body.innerText })"))) || '{}');
  R.ok('in a VM .md a link to a folder stays text, as on the Mac, while a link to a file there is signed',
    Array.isArray(linked.a) && linked.a.length === 1 && linked.a[0][0] === 'main' && /^flow-file:\/\/vm\/[A-Za-z0-9_-]{22}\//.test(linked.a[0][1]) &&
    linked.a[0][1].endsWith(`/${HOST}/${encodedPath(path.join(VMHOME, 'proj', 'src', 'main.py'))}`) && linked.text.includes('see the code and main'), linked);
  const addr = await waitFor(() => evaluate(page, `[...document.querySelectorAll('.addr')].map((a) => ({ value: a.querySelector('input.ad').value, where: a.querySelector('.pwhere').textContent, on: a.querySelector('.pwhere').classList.contains('on') })).find((a) => a.where)`), 3000);
  R.ok('the VM file tab shows its full path on the VM, and says so, instead of its signed address',
    !!addr && addr.value === path.join(VMHOME, 'proj', 'notes.md') && addr.where === 'on the VM' && addr.on, addr);
  const openRow = await waitFor(async () => (await filesRows(page)).find((x) => x.depth === 1 && x.label === 'notes.md' && x.glyph === '↗'), 3000);
  R.ok('the VM file open as a page is marked on its row, as a Mac file is', !!openRow, await labels(page));
  await shot(page, `${OUT}/02-vm-page.png`);
  const pages1 = await pageWins();
  const own = pages1.find((x) => !pages0.some((y) => y.id === x.id)) || null;
  R.ok('a VM file opens as a page window of its own, never a tab in the page in front',
    pages1.length === pages0.length + 1 && !!own && own.tabs === 1 && own.front === true && own.url.endsWith(want) &&
    pages0.every((y) => (pages1.find((x) => x.id === y.id) || {}).tabs === y.tabs), { before: pages0, after: pages1 });
  await clickRow(page, 'main.py', 2);
  const mainWant = `/${HOST}/${encodedPath(path.join(VMHOME, 'proj', 'src', 'main.py'))}`;
  const pages2 = (await waitFor(async () => { const l = await pageWins(); return l.length === pages1.length + 1 && l.every((x) => x.url) ? l : null; }, 6000)) || await pageWins();
  const second = pages2.find((x) => !pages1.some((y) => y.id === x.id)) || null;
  R.ok('a second VM file opens beside it as another window, the first keeping its one tab',
    pages2.length === pages1.length + 1 && !!second && second.tabs === 1 && second.front === true && second.url.endsWith(mainWant) &&
    !!own && (pages2.find((x) => x.id === own.id) || {}).tabs === 1, { after: pages2 });
  await clickRow(page, 'notes.md', 1);
  const isFront = async () => { const l = await pageWins(); const n = own && l.find((x) => x.id === own.id); return n && n.front ? l : null; };
  const pages3 = (await waitFor(isFront, 10000)) || await pageWins();
  R.ok('clicking a VM file already open goes to its window, opening nothing new',
    pages3.length === pages2.length && !!own && (pages3.find((x) => x.id === own.id) || {}).front === true &&
    pages3.every((x) => (pages2.find((y) => y.id === x.id) || {}).tabs === x.tabs), { after: pages3 });
  const notes = path.join(VMHOME, 'proj', 'notes.md');
  fs.writeFileSync(notes, '# on the vm\n\nwritten by an agent there\n\nand again\n');
  const again = async () => {
    const g = await guestOf('notes.md', (x) => x.title === 'notes.md', 1000);
    return g ? guestText(g) : '';
  };
  R.ok('a write on the VM to the open .md shows in its page by itself', !!(await waitFor(async () => (await again()).includes('and again'), 10000, 300)), await again());

  const up = path.join(DATA, 'mac', 'up from mac.txt');
  fs.mkdirSync(path.dirname(up), { recursive: true });
  fs.writeFileSync(up, 'from the Mac\n');
  const put = await evaluate(page, `window.flow.files.put(${JSON.stringify(up)}, ${JSON.stringify(HOST)}, '~/proj')`);
  R.ok('flow.files.put carries a Mac file into the VM folder', put && put.ok && put.path === path.join(VMHOME, 'proj', 'up from mac.txt') && fs.readFileSync(put.path, 'utf8') === 'from the Mac\n', put);
  R.ok('and the folder shows it', !!(await waitFor(async () => (await labels(page)).includes('  up from mac.txt'), 6000)), await labels(page));
  const dl = path.join(DATA, 'Downloads');
  const hadDl = fs.existsSync(dl);
  const copy = await evaluate(page, `window.flow.files.copy(${JSON.stringify(HOST)}, ${JSON.stringify(path.join(VMHOME, 'proj', 'notes.md'))})`);
  R.ok('flow.files.copy with no folder brings a VM file into downloads, making the folder', !hadDl && copy && copy.ok && copy.file === path.join(dl, 'notes.md') && fs.readFileSync(copy.file, 'utf8').startsWith('# on the vm'), { hadDl, copy });

  fs.writeFileSync(path.join(VMHOME, '.down'), '');
  for (const pid of loopRelays()) process.kill(pid, 'SIGUSR1');
  rows = await waitFor(async () => { const l = await labels(page); return l.includes('▾ proj [on the VM · the VM is not reachable]') ? l : null; }, 8000);
  R.ok('a dropped connection says so on the folder row, nothing else', !!rows && rows.length === 2 && !(await evaluate(page, `document.getElementById('toast').classList.contains('on')`)), rows || await labels(page));
  await shot(page, `${OUT}/03-vm-unreachable.png`);
  await guestEval(await guestOf('notes.md', (x) => x.title === 'notes.md', 3000), 'void setTimeout(() => location.reload(), 50)');
  const notesText = async () => {
    const g = await guestOf('notes.md', () => true, 1000);
    return g ? guestText(g) : '';
  };
  R.ok('a VM .md reloaded while the VM is away says so', !!(await waitFor(async () => (await notesText()) === 'the VM is not reachable', 8000, 300)), await notesText());
  fs.rmSync(path.join(VMHOME, '.down'));
  const refilled = async () => {
    const r = await filesRows(page);
    return r.some((x) => x.depth === 1 && x.label === 'notes.md') && r.some((x) => x.depth === 2 && x.label === 'main.py') && !r.some((x) => x.meta.includes('not reachable'));
  };
  // The watch retries 5 s after a failed try, doubling to 60 s (and pty's ssh backoff the same), so rows fill in at its next try.
  R.ok('when the VM is back, the folder and the one under it fill in by themselves', !!(await waitFor(refilled, 60000)), await labels(page));
  R.ok('and the .md that could not load then loads by itself', !!(await waitFor(async () => (await again()).includes('and again'), 10000, 300)), await notesText());

  // ---- batch 9: the Mac's network coming back, or Flow's window coming to the front, fills VM rows in at once ----
  // files.js listens for the window's 'online' and 'focus' events and asks main to retry; without that the rows wait
  // for the watch's next try (here 10 s out, after its own retry failed during the outage).
  const awayAndBack = async () => {
    fs.writeFileSync(path.join(VMHOME, '.down'), '');
    for (const pid of loopRelays()) process.kill(pid, 'SIGUSR1');
    const down = await waitFor(async () => (await labels(page)).includes('▾ proj [on the VM · the VM is not reachable]'), 8000);
    await sleep(7000);
    fs.rmSync(path.join(VMHOME, '.down'));
    await sleep(1000);
    return !!down && (await labels(page)).includes('▾ proj [on the VM · the VM is not reachable]');
  };
  for (const ev of ['online', 'focus']) {
    const waiting = await awayAndBack();
    const t9 = Date.now();
    await evaluate(page, `window.dispatchEvent(new Event('${ev}')), 1`);
    const tryAfter = () => (loggedSsh(SSH_LOG).find((a) => a.via === 'spawn' && a.at >= t9) || {}).at || 0;
    await waitFor(tryAfter, 3000, 50);
    const triedMs = tryAfter() ? tryAfter() - t9 : null;
    const filled = await waitFor(refilled, 30000, 100);
    R.ok(`with the VM back and its rows still away, the window's '${ev}' event tries the VM at once, and the rows fill in`,
      waiting === true && triedMs !== null && triedMs < 1000 && !!filled, { waiting, triedMs, filledMs: Date.now() - t9 });
  }

  await clickRow(page, 'proj', 0);
  const openFiles = [`f ${notes}`, `f ${path.join(VMHOME, 'proj', 'src', 'main.py')}`].sort();
  const onlyOpen = () => { const l = loops(); const w = l.length === 1 ? watchedBy(l[0][1]) : null; return !!w && JSON.stringify([...w].sort()) === JSON.stringify(openFiles); };
  R.ok('folding the VM folder stops watching it: the one loop left watches only the files open as pages', !!(await waitFor(onlyOpen, 8000)), loops().map((m) => watchedBy(m[1])));
  // ---- item 15: a sub-workspace with its own folder on the VM; the main space keeps its own ----
  // A space's files rows: those after its heading (zone| for the main space, zone|<id> for a sub-workspace), up to the next heading.
  const spaceLabels = (head) => evaluate(page, `(() => { const all = [...document.querySelectorAll('#sblist .tr')]; const i = all.findIndex((e) => e.dataset.act === ${JSON.stringify(head)}); if (i < 0) return null; const out = []; for (const e of all.slice(i + 1)) { const a = e.dataset.act || ''; if (a.startsWith('zone|')) break; if (!a.startsWith('files|')) continue; const d = +(/\\bd(\\d+)\\b/.exec(e.className) || [0, 0])[1]; const g = e.querySelector('.g').textContent; const m = (e.querySelector('.m') || {}).textContent || ''; out.push('  '.repeat(d) + (g ? g + ' ' : '') + e.querySelector('.l').textContent + (m ? ' [' + m + ']' : '')); } return out; })()`);
  const spaceNow = () => evaluate(page, `(window.__flow.state().ws.find((w) => w.id === 'ef') || {}).at || ''`);
  const headAt = (act) => evaluate(page, `(() => { const r = document.querySelector('#sblist .tr[data-act="${act}"]'); if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.querySelector('.l').getBoundingClientRect(); return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 }; })()`);
  const zHead = await waitFor(() => headAt('zone|z-vm'), 3000);
  if (zHead) await click(page, zHead.x, zHead.y);
  const inZone = await waitFor(async () => (await spaceNow()) === 'z-vm', 4000);
  let zRows = await waitFor(async () => { const l = await spaceLabels('zone|z-vm'); return l && l.length ? l : null; }, 6000);
  R.ok("in a sub-workspace whose folder is on the VM, its files show that folder on the VM, and none of the main space's",
    !!inZone && JSON.stringify(zRows) === JSON.stringify(['▸ zproj [on the VM]']), { space: await spaceNow(), rows: zRows });
  if (zRows) await clickRow(page, 'zproj', 0);
  zRows = await waitFor(async () => { const l = await spaceLabels('zone|z-vm'); return l && l.includes('  z.py') ? l : null; }, 10000);
  R.ok('it unfolds by its path on the VM and lists its files', JSON.stringify(zRows) === JSON.stringify(['▾ zproj [on the VM]', '  plan.md', '  z.py']), zRows || await spaceLabels('zone|z-vm'));
  const z0 = await pageWins();
  if (zRows) await clickRow(page, 'z.py', 1);
  const zWant = `/${HOST}/${encodedPath(path.join(VMHOME, 'zproj', 'z.py'))}`;
  const z1 = (await waitFor(async () => { const l = await pageWins(); return l.length === z0.length + 1 ? l : null; }, 10000)) || await pageWins();
  const zWin = z1.find((x) => !z0.some((y) => y.id === x.id)) || null;
  const zPage = await guestOf('z.py', (x) => x.title === 'z.py', 20000);
  const zText = zPage ? await guestText(zPage) : '';
  R.ok("a file in the sub-workspace's VM folder opens as its own window and shows the file",
    !!zWin && zWin.tabs === 1 && zWin.url.endsWith(zWant) && zText.includes('print("in the sub-workspace")'), { win: zWin, text: zText });
  fs.writeFileSync(path.join(VMHOME, 'zproj', 'from-agent-z.txt'), 'written on the VM\n');
  R.ok("a file an agent writes in the sub-workspace's VM folder appears by itself",
    !!(await waitFor(async () => ((await spaceLabels('zone|z-vm')) || []).includes('  from-agent-z.txt'), 10000)), await spaceLabels('zone|z-vm'));
  fs.writeFileSync(path.join(VMHOME, '.down'), '');
  for (const pid of loopRelays()) process.kill(pid, 'SIGUSR1');
  zRows = await waitFor(async () => { const l = await spaceLabels('zone|z-vm'); return l && l.includes('▾ zproj [on the VM · the VM is not reachable]') ? l : null; }, 8000);
  R.ok("while the VM is not reachable the sub-workspace's folder row says so", !!zRows, zRows || await spaceLabels('zone|z-vm'));
  fs.rmSync(path.join(VMHOME, '.down'));
  R.ok('and it fills in again when the VM is back', !!(await waitFor(async () => {
    const l = (await spaceLabels('zone|z-vm')) || [];
    return l.some((x) => /^ {2}(↗ )?z\.py$/.test(x)) && !l.some((x) => x.includes('not reachable'));
  }, 60000)), await spaceLabels('zone|z-vm'));
  const mHead = await waitFor(() => headAt('zone|'), 3000);
  if (mHead) await click(page, mHead.x, mHead.y);
  const inMain = await waitFor(async () => (await spaceNow()) === '', 4000);
  const mRows = await waitFor(async () => { const l = await spaceLabels('zone|'); return l && l.length ? l : null; }, 6000);
  // With both on screen (the sub-workspace unfolded under its heading), each keeps its own folders.
  const zTog = await evaluate(page, `(() => { const g = document.querySelector('#sblist .tr[data-act="zone|z-vm"] [data-tog]'); if (!g) return null; const b = g.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (zTog) await click(page, zTog.x, zTog.y);
  const both = await waitFor(async () => { const l = await spaceLabels('zone|z-vm'); return l && l.length ? l : null; }, 6000);
  R.ok("back in the main space it keeps its own folders, and the sub-workspace under its heading keeps its own",
    !!inMain && JSON.stringify(mRows) === JSON.stringify([`▸ ${mac}`, '▸ proj [on the VM]']) && !!both && both[0] === '▾ zproj [on the VM]' &&
    !both.some((x) => / (ef|proj)( |$)/.test(x)), { space: await spaceNow(), main: mRows, sub: both });
  if (zTog) await click(page, zTog.x, zTog.y);

  await clickRow(page, 'proj', 0);
  const before = await waitFor(() => loops().length === 1, 4000);
  await evaluate(page, 'window.__flow.go(0)');
  R.ok('another workspace on screen: nothing runs on the VM', !!before && !!(await waitFor(() => loops().length === 0, 4000)), loops().length);
  page.ws.close();

  const log = fs.readFileSync(LOG, 'utf8').split('\n');
  const vmLines = log.filter((l) => l.includes('vmfiles') || l.includes('[flow] ssh'));
  const outage = /^\[flow\] (vmfiles vmfiles-standin\.invalid: (ssh: connect to host vmfiles-standin\.invalid port 22: Connection refused|the VM file watch ended \(exit 255\)|ssh vmfiles-standin\.invalid: (connection failed|ssh: connect to host vmfiles-standin\.invalid port 22: Connection refused))|ssh vmfiles-standin\.invalid: (connection failed|ssh: connect to host vmfiles-standin\.invalid port 22: Connection refused))$/;
  R.ok('the main process logged nothing about ssh or vmfiles but the outage itself', vmLines.length > 0 && vmLines.every((l) => outage.test(l)), vmLines);
  R.ok('no uncaught error in the main process', !log.some((l) => /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(l)), log.filter((l) => /Uncaught|Unhandled|Error/.test(l)).slice(0, 5));
} finally {
  if (app) await stop(app, SOCK);
  clearInterval(watcher);
  R.ok('after the app quits nothing of it runs: no Flow of this test, no loop, no relay, no tmux server, the port free',
    !!(await waitFor(() => loops().length === 0 && loopRelays().length === 0 && alone() && spawnSync('tmux', ['-L', SOCK, 'ls']).status !== 0, 6000)),
    { loops: loops().length, relays: loopRelays().length, alone: alone() });
}
const asked = loggedSsh(SSH_LOG).filter((a) => a.via !== 'loaded');
const probeLog = loggedSsh(PROBE_SSH_LOG);
R.ok('the probe asked for no ssh', probeLog.some((a) => a.via === 'loaded') && probeLog.every((a) => a.via === 'loaded'), probeLog);
R.ok(`every ssh the app asked for was to ${HOST} and served by the stand-in`, asked.length > 0 && asked.every((a) => a.host === HOST && a.routed && a.via === 'spawn'),
  [...new Set(asked.map((a) => `${a.via} ${a.host} ${a.routed ? 'served' : 'refused'}`))]);
R.ok(`${HOST} cannot resolve`, spawnSync('getent', ['hosts', HOST]).status !== 0);
R.ok('no ssh process ran below the app, in 200 ms samples over the whole run', sampled >= 25 && sshSeen.length === 0, { samples: sampled, ssh: [...new Set(sshSeen)] });
R.summary();




