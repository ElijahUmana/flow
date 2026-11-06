'use strict';
// Module test of src/vmfiles.js against a local stand-in for the VM: each call runs the exact command line ssh would
// send (argv shell-quoted, run by bash -c in the stand-in's home folder with sshd's small environment), through a relay
// process that plays the ssh client: killing the relay closes the session's pipes without signalling the command, so a
// VM-side loop has to notice the closed session itself, as it would over ssh. Nothing here uses ssh.
//   node test/vmfiles-test.js
// Everything it makes is under /home/claude/.flow-dev/vmfiles/test-<pid>, removed at the end.

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const vmfiles = require('../src/vmfiles');
const realFiles = require('../src/files-main');

const ROOT = `/home/claude/.flow-dev/vmfiles/test-${process.pid}`;
const HOME = path.join(ROOT, 'vm-home');      // the stand-in VM's home folder
const MAC = path.join(ROOT, 'mac');           // folders "on this Mac"
const CACHE = path.join(ROOT, 'cache');
const TMP = path.join(ROOT, 'vm-tmp');      // the stand-in's TMPDIR, where a loop keeps its one temp file
const HOST = 'claude-agents';
const TICK = 1;

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// Plays the ssh client: copies the command's output, gives it our stdin, exits with its code. SIGUSR1 makes it exit 255,
// as ssh does when the connection drops. STDIN_CUT=n closes the command's stdin after n bytes (an upload cut short).
const RELAY = `
const { spawn } = require('child_process');
const c = spawn('/bin/bash', ['-c', process.argv[1]], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
const cut = Number(process.env.STDIN_CUT || 0);
let n = 0;
process.stdin.on('data', (b) => {
  if (cut && n + b.length >= cut) { c.stdin.end(b.subarray(0, cut - n)); process.stdin.destroy(); n = cut; return; }
  n += b.length;
  if (!c.stdin.write(b)) { process.stdin.pause(); c.stdin.once('drain', () => process.stdin.resume()); }
});
process.stdin.on('end', () => c.stdin.end());
c.stdin.on('error', () => {});
c.stdout.pipe(process.stdout);
c.stderr.pipe(process.stderr);
c.on('close', (code) => { process.exitCode = code == null ? 1 : code; process.stdin.destroy(); });   // exits once stdout is flushed
process.on('SIGUSR1', () => process.exit(255));
`;

const calls = [];          // every command the module ran: { host, kind, argv, child, out }
let mode = 'up';           // 'up' | 'refused' (exit 255) | 'throw' (pty's backoff) | 'silent' | 'garbage'
let stdinCut = 0;
let live = 0;
let maxLive = 0;

function transport(host, argv, { stdin } = {}) {
  const loop = argv[2] && argv[2].includes('tick=$1');
  const kind = loop ? (argv[5] === '0' ? 'list' : 'watch') : argv[2] && argv[2].includes('cat > "$f"') ? 'put' : 'fetch';
  if (mode === 'throw') throw new Error(`ssh ${host}: Connection refused`);
  let cmd = argv.map(shq).join(' ');
  if (mode === 'refused') cmd = 'echo "ssh: connect to host claude-agents port 22: Connection refused" >&2; exit 255';
  else if (mode === 'silent') cmd = 'exec sleep 30';
  else if (mode === 'garbage') cmd = 'echo hello; exec sleep 30';
  const child = spawn(process.execPath, ['-e', RELAY, cmd], {
    cwd: HOME,
    env: { HOME, TMPDIR: TMP, USER: 'claude', SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', STDIN_CUT: String(stdinCut || '') },
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const rec = { host, kind, argv, child, out: 0 };
  child.stdout.on('data', (b) => { rec.out += b.length; });
  calls.push(rec);
  live++;
  maxLive = Math.max(maxLive, live);
  child.on('close', () => { live--; });
  return child;
}

// A window as files-main.js stands for one: an id, and the folders it was told changed.
function windowFor(id) {
  const w = { id, changes: [], changed: (host, dir) => w.changes.push({ host, dir }) };
  return w;
}
const watchAs = (w, dirs) => vmfiles.watch(w.id, dirs.map((dir) => ({ host: HOST, dir })), w.changed);
const changesOf = (w, dir) => w.changes.filter((c) => c.dir === dir).length;

// files-main.js's own rules where it exports them; until it does, the same rules written out here.
const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', html: 'text/html' };
async function stubKindOf(file, size) {
  const type = TYPES[path.extname(file).slice(1).toLowerCase()];
  if (type === 'application/pdf') return 'pdf';
  if (type && type.startsWith('image/')) return 'image';
  if (size > 8 * 1024 * 1024) return 'other';
  if (type === 'text/html') return 'html';
  const head = fs.readFileSync(file).subarray(0, 8192);
  if (head.includes(0)) return 'other';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return 'text';
  } catch (e) {
    if (e instanceof TypeError) return 'other';
    throw e;
  }
}
function stubRespond(file, st) {
  return new Response(fs.readFileSync(file), { headers: { 'content-type': TYPES[path.extname(file).slice(1)] || 'text/plain', 'content-length': String(st.size) } });
}
// files-main.js signs a VM file's address (vmUrlOf) and takes the signature off before it calls serve(); here the address
// is built the way serve() receives it.
const unsignedVmUrl = (host, p) => `flow-file://vm/${encodeURIComponent(host)}/${p.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
const origins = [];   // the origin serve() gave respond() each time
const FILES = { compare: realFiles.compare, SCHEME: realFiles.SCHEME, kindOf: realFiles.kindOf || stubKindOf,
  respond: (file, st, origin) => { origins.push(origin); return (realFiles.respond || stubRespond)(file, st, origin); }, vmUrlOf: unsignedVmUrl };
const opened = [];   // what the Mac's app was asked to open
const OPTS = { spawn: transport, cacheDir: CACHE, files: FILES, openPath: async (f) => { opened.push(f); return ''; }, tick: TICK, life: 600,
  debounceMs: 10, retryMs: 300, retryMaxMs: 1200, freshMs: 0 };
const init = (more) => vmfiles.init({ ...OPTS, ...more });

let failed = 0;
const check = (name, cond, extra) => {
  const pass = cond === true;   // only true passes: anything else says what it was
  const gave = pass || cond === false ? '' : ` [gave ${cond === null ? 'null' : typeof cond}, not true]`;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${gave}${extra ? '  ' + extra : ''}`);
  if (!pass) failed++;
};

async function until(fn, ms = 5000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// Stops watching and waits until the host's loop is gone on the VM (the debounce first, then the loop's next tick).
async function unwatch(w) {
  vmfiles.watch(w.id, [], w.changed);
  await sleep(60);
  return until(() => loops() === 0, 3000);
}
const watchCalls = () => calls.filter((c) => c.kind === 'watch');
// A process's working folder, or '' once it has ended.
const cwdOf = (pid) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return '';
    throw e;
  }
};
// This test's VM-side watch loops still running: sh processes running WATCH_SH in the stand-in's home (other tests on
// this machine run the same loops elsewhere), whose parent is not one (a loop's own subshells are not counted twice).
function loops() {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[3].startsWith('sh -c ') && m[3].includes('tick=$1; end=') && cwdOf(m[1]) === HOME);
  const pids = new Set(rows.map((m) => m[1]));
  return rows.filter((m) => !pids.has(m[2])).length;
}
const leftTemp = () => fs.readdirSync(TMP);

function setup() {
  fs.mkdirSync(path.join(HOME, 'proj', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(MAC, 'downloads'), { recursive: true });
  const p = (n) => path.join(HOME, 'proj', n);
  fs.writeFileSync(p('a.md'), '# hello\n');
  fs.writeFileSync(p('name with space.txt'), 'x');
  fs.writeFileSync(p('tab\tname'), 'tt');
  fs.writeFileSync(p('new\nline'), '');
  fs.writeFileSync(p('ünïcödé.txt'), 'u');
  fs.writeFileSync(p('.hidden'), 'h');
  fs.writeFileSync(p("it's \"quoted\" $(x) `y`"), 'q');
  fs.symlinkSync('sub', p('linkdir'));
  fs.symlinkSync('missing-target', p('broken'));
  execFileSync('mkfifo', [p('pipe')]);
  fs.mkdirSync(path.join(HOME, 'locked'));
  fs.chmodSync(path.join(HOME, 'locked'), 0);
  const hostile = path.join(HOME, 'hostile');
  fs.mkdirSync(path.join(hostile, '-exec'), { recursive: true });
  fs.mkdirSync(path.join(hostile, '$(touch sentinel5)'));
  fs.writeFileSync(path.join(hostile, '-exec', '-n.txt'), 'n');
  fs.writeFileSync(path.join(hostile, '$(touch sentinel5)', 'inside.txt'), 'i');
  for (const n of HOSTILE) fs.writeFileSync(path.join(hostile, n), `content of ${n}`);
}

// Names that would run as shell, or read as an option, if anything ever pasted them into a command line. Running any of
// them leaves a file named sentinel<n> where it ran.
const HOSTILE = ['-rf', '--help.md', '$(touch sentinel1)', '`touch sentinel2`', '; touch sentinel3 #', "' ; touch sentinel4 ; '",
  'back\\slash', '%s%n.txt', '-n $(touch sentinel6) "', '\nnewline-first'];

// The workspace folders on the VM that open() and serve() are given: here the stand-in's whole home.
const ALL = ['~'];
const callsOf = (kind) => calls.filter((c) => c.kind === kind).length;
const names = (r) => (r && r.entries ? r.entries.map((e) => e.name) : []);

async function testList() {
  const proj = path.join(HOME, 'proj');
  const r = await vmfiles.list(HOST, '~/proj');
  check('a VM folder lists', r.ok && r.dir === '~/proj' && Array.isArray(r.entries), r.error);
  check('the listing carries its absolute path on the VM', r.path === proj, r.path);
  const want = fs.readdirSync(proj).filter((n) => !n.startsWith('.'))
    .map((name) => ({ name, kind: (() => { try { return fs.statSync(path.join(proj, name)).isDirectory() ? 'dir' : 'file'; } catch (e) { if (e.code === 'ENOENT') return 'file'; throw e; } })() }))
    .sort(realFiles.compare);
  check('the same rows as a Mac folder: no dot names, folders first, Finder order, odd names intact',
    JSON.stringify(r.entries) === JSON.stringify(want), JSON.stringify(names(r)));
  const kind = (n) => (r.entries.find((e) => e.name === n) || {}).kind;
  check('a link to a folder is a folder; a link to nothing and a fifo are files', kind('linkdir') === 'dir' && kind('broken') === 'file' && kind('pipe') === 'file');
  check('total counts what is there', r.total === want.length, `${r.total}`);
  const missing = await vmfiles.list(HOST, '~/nope');
  const notdir = await vmfiles.list(HOST, '~/proj/a.md');
  const locked = await vmfiles.list(HOST, path.join(HOME, 'locked'));
  check('the Mac\'s words for a folder that is not there, not a folder, or closed',
    missing.error === 'not there' && notdir.error === 'not a folder' && locked.error === 'no access' && missing.dir === '~/nope',
    [missing.error, notdir.error, locked.error].join(' | '));
  fs.mkdirSync(path.join(HOME, 'many'));
  for (let i = 0; i < 5003; i++) fs.writeFileSync(path.join(HOME, 'many', `f${i}`), '');
  const many = await vmfiles.list(HOST, '~/many');
  check('a folder of 5003 sends 5000 names and the true total', many.ok && many.entries.length === 5000 && many.total === 5003, `${many.entries && many.entries.length} of ${many.total}`);
  fs.rmSync(path.join(HOME, 'many'), { recursive: true });
}

async function testWatch() {
  const w1 = windowFor(1);
  const first = await vmfiles.list(HOST, '~/proj');
  const lists0 = callsOf('list');
  watchAs(w1, ['~/proj']);
  const started = await until(() => watchCalls().length > 0 && loops() === 1, 3000);
  await sleep(TICK * 1000 + 300);
  check('a watch that starts from a fresh listing sends nothing', !!started && w1.changes.length === 0, `${loops()} loops, ${w1.changes.length} changes`);
  const cached = await vmfiles.list(HOST, '~/proj');
  check('a watched folder lists from the loop, with no ssh call', callsOf('list') === lists0 && JSON.stringify(cached) === JSON.stringify(first));

  const loop = watchCalls()[watchCalls().length - 1];
  const bytes0 = loop.out;
  const cpu0 = process.cpuUsage();
  await sleep(TICK * 3000 + 300);
  const cpu = process.cpuUsage(cpu0);
  check('while nothing changes only heartbeats flow (2 bytes a tick)', loop.out - bytes0 >= 2 && loop.out - bytes0 <= 2 * 4 && w1.changes.length === 0, `${loop.out - bytes0} bytes in 3 ticks`);
  console.log(`     Mac side while watching quietly: ${((cpu.user + cpu.system) / 1000).toFixed(1)} ms CPU in ${TICK * 3 + 0.3} s`);

  fs.writeFileSync(path.join(HOME, 'proj', 'report.pdf'), Buffer.alloc(1000, 1));
  const added = await until(() => changesOf(w1, '~/proj') >= 1, TICK * 3000);
  const after = await vmfiles.list(HOST, '~/proj');
  check('a new file is told within a tick or two, and listed from the cache', !!added && names(after).includes('report.pdf') && callsOf('list') === lists0);
  const c1 = changesOf(w1, '~/proj');
  fs.appendFileSync(path.join(HOME, 'proj', 'a.md'), 'more\n');
  fs.writeFileSync(path.join(HOME, 'proj', '.dotfile'), 'x');
  await sleep(TICK * 2500);
  check('a file\'s content changing or a dot name appearing tells nothing (rows show names only)', changesOf(w1, '~/proj') === c1);
  fs.unlinkSync(path.join(HOME, 'proj', 'report.pdf'));
  const removed = await until(() => changesOf(w1, '~/proj') > c1, TICK * 3000);
  check('a removed file is told', !!removed && !names(await vmfiles.list(HOST, '~/proj')).includes('report.pdf'));

  const starts = watchCalls().length;
  watchAs(w1, ['~/proj', '~/later']);
  const toldLater = await until(() => changesOf(w1, '~/later') > 0, 3000);
  const later = await vmfiles.list(HOST, '~/later');
  check('a watched folder that is not there says so', !!toldLater && later.error === 'not there', later.error);
  check('a new set of folders restarts the loop once', watchCalls().length === starts + 1, `${watchCalls().length - starts}`);
  const c2 = changesOf(w1, '~/proj');
  await sleep(TICK * 2000);
  check('the restart sends nothing for a folder that did not change', changesOf(w1, '~/proj') === c2);
  fs.mkdirSync(path.join(HOME, 'later'));
  const made = await until(() => changesOf(w1, '~/later') > 1, TICK * 3000);
  const laterNow = await vmfiles.list(HOST, '~/later');
  check('it shows once it exists', !!made && laterNow.ok && laterNow.entries.length === 0);

  const w2 = windowFor(2);
  const starts2 = watchCalls().length;
  watchAs(w2, ['~/proj']);
  await sleep(500);
  check('a second window on the same folders keeps the same loop', watchCalls().length === starts2);
  await unwatchOnly(w1);
  fs.writeFileSync(path.join(HOME, 'proj', 'b.txt'), 'b');
  const seen2 = await until(() => changesOf(w2, '~/proj') > 0, TICK * 3000);
  const w1count = w1.changes.length;
  check('the window still watching is told', !!seen2);
  await sleep(TICK * 1500);
  check('the window that stopped is not', w1.changes.length === w1count);
  const t0 = Date.now();
  const ended = await unwatch(w2);
  check('nothing runs on the VM about a tick after no folder is on screen', !!ended && Date.now() - t0 < TICK * 1000 + 1500,
    `${loops()} loops left after ${Date.now() - t0} ms`);
  check('the loop leaves no temp file', leftTemp().length === 0, leftTemp().join(' '));
}

async function unwatchOnly(w) {
  vmfiles.watch(w.id, [], w.changed);
  await sleep(60);
}

async function testLifetime() {
  init({ life: 2 });
  const w = windowFor(3);
  const starts = watchCalls().length;
  watchAs(w, ['~/proj']);
  await sleep(4500);
  check('a loop ends at its lifetime and starts again by itself', watchCalls().length >= starts + 2, `${watchCalls().length - starts} starts`);
  const n = w.changes.length;
  check('a restart at the lifetime tells nothing new', n <= 1, `${n} changes`);
  fs.writeFileSync(path.join(HOME, 'proj', 'c.txt'), 'c');
  const seen = await until(() => w.changes.length > n, TICK * 3000);
  check('changes still arrive across restarts', !!seen && names(await vmfiles.list(HOST, '~/proj')).includes('c.txt'));
  await unwatch(w);
  init();
}

async function testUnreachable() {
  const w = windowFor(4);
  mode = 'refused';
  const once = await vmfiles.list(HOST, '~/proj');
  check('listing while the VM is unreachable says so', !once.ok && once.error === 'the VM is not reachable', once.error);
  const starts = watchCalls().length;
  watchAs(w, ['~/proj']);
  await until(() => changesOf(w, '~/proj') > 0, 3000);
  const lists0 = callsOf('list');
  const down = await vmfiles.list(HOST, '~/proj');
  check('a watched folder on an unreachable VM says so, with no extra ssh call', down.error === 'the VM is not reachable' && callsOf('list') === lists0, down.error);
  await sleep(1600);
  const tries = watchCalls().length - starts;
  check('retries back off', tries >= 2 && tries <= 4, `${tries} tries in 1.6 s`);
  watchAs(w, ['~/proj', '~/later']);
  await until(() => changesOf(w, '~/later') > 0, 500);
  const later = await vmfiles.list(HOST, '~/later');
  check('a folder added while backing off says why it is empty', later.error === 'the VM is not reachable', later.error);
  mode = 'up';
  const c0 = changesOf(w, '~/proj');
  const toldBack = await until(() => changesOf(w, '~/proj') > c0, 10000);
  const back = await vmfiles.list(HOST, '~/proj');
  check('the VM coming back tells the folder, and it lists again', !!toldBack && back.ok && back.entries.length > 0);

  const loop = watchCalls()[watchCalls().length - 1];
  const c1 = changesOf(w, '~/proj');
  loop.child.kill('SIGUSR1');
  await until(() => changesOf(w, '~/proj') > c1, 10000);
  const dropped = await vmfiles.list(HOST, '~/proj');
  check('a dropped connection says the VM is not reachable', dropped.error === 'the VM is not reachable', dropped.error);
  await until(() => changesOf(w, '~/proj') > c1 + 1, 10000);
  const again = await vmfiles.list(HOST, '~/proj');
  check('after a drop the folder lists again from the new loop', again.ok && back.ok && again.entries.length === back.entries.length);
  check('a drop tells the folder twice: gone, back', changesOf(w, '~/proj') === c1 + 2, `${changesOf(w, '~/proj') - c1}`);
  await unwatch(w);

  mode = 'throw';
  const w5 = windowFor(5);
  watchAs(w5, ['~/proj']);
  await until(() => changesOf(w5, '~/proj') > 0, 10000);
  check('a refusal from the ssh helper reads the same', (await vmfiles.list(HOST, '~/proj')).error === 'the VM is not reachable');
  mode = 'up';
  const back5 = await until(() => changesOf(w5, '~/proj') > 1, 10000);
  check('and the folder comes back', !!back5 && (await vmfiles.list(HOST, '~/proj')).ok);
  await unwatch(w5);

  init({ watchdogMs: 1500 });
  mode = 'silent';
  const w6 = windowFor(6);
  const t0 = Date.now();
  watchAs(w6, ['~/proj']);
  await until(() => changesOf(w6, '~/proj') > 0, 4000);
  const deaf = await vmfiles.list(HOST, '~/proj');
  check('a session that never answers is ended', deaf.error === 'the VM is not reachable', `${Date.now() - t0} ms`);
  mode = 'garbage';
  const odd = await (async () => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const r = await vmfiles.list(HOST, '~/proj');
      if (r.error && r.error.startsWith('unexpected')) return r;
      await sleep(100);
    }
    return null;
  })();
  check('output that is not the protocol is an error, not a listing', !!odd, odd && odd.error);
  mode = 'up';
  const ok6 = await (async () => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const r = await vmfiles.list(HOST, '~/proj');
      if (r.ok) return r;
      await sleep(100);
    }
    return null;
  })();
  check('and recovers', !!ok6);
  await unwatch(w6);
  init();
}

const fetchBytes = () => calls.filter((c) => c.kind === 'fetch').reduce((n, c) => n + c.out, 0);
const fetches = () => callsOf('fetch');
async function body(url) {
  const res = await vmfiles.serve(new Request(url), ALL);
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

async function testOpen() {
  const proj = path.join(HOME, 'proj');
  const a = await vmfiles.open(HOST, '~/proj/a.md', ALL);
  const want = `flow-file://vm/claude-agents${proj.split('/').map(encodeURIComponent).join('/')}/a.md`;
  check('a text file opens as a page at flow-file://vm/<host>/<path>', a.url === want, a.url || a.error);
  const s = await body(a.url);
  const onVm = path.join(proj, 'a.md');
  const asServed = Buffer.from(await (await FILES.respond(onVm, fs.statSync(onVm), { host: HOST, path: onVm })).arrayBuffer());
  check('serving it gives the file as it is on the VM, as files-main serves it', s.status === 200 && s.buf.equals(asServed) && s.buf.toString().includes('hello'), `${s.status}`);
  const odd = "it's \"quoted\" $(x) `y`";
  const q = await vmfiles.open(HOST, path.join(proj, odd), ALL);
  const qs = q.url ? await body(q.url) : { status: 0, buf: Buffer.alloc(0) };
  check('a name with quotes and $() opens and serves as data', !!q.url && qs.status === 200 && qs.buf.toString().includes('q'), q.error);

  const bin = path.join(proj, 'data.bin');
  fs.writeFileSync(bin, crypto.randomBytes(5000));
  opened.length = 0;
  const b = await vmfiles.open(HOST, bin, ALL);
  const copy = opened[0];
  check('a kind Flow does not show opens in the Mac\'s app, from a read-only copy', b.app === true && !!copy &&
    md5(fs.readFileSync(copy)) === md5(fs.readFileSync(bin)) && (fs.statSync(copy).mode & 0o777) === 0o400 && path.basename(copy) === 'data.bin',
    JSON.stringify(b));
  check('the copy sits in the private cache', copy.startsWith(CACHE + '/') && (fs.statSync(CACHE).mode & 0o077) === 0);
  fs.appendFileSync(bin, crypto.randomBytes(3000));
  const b2 = await vmfiles.open(HOST, bin, ALL);
  check('a read-only copy still takes what the file gained', b2.app === true && md5(fs.readFileSync(copy)) === md5(fs.readFileSync(bin)));

  const big = path.join(proj, 'big.png');
  fs.writeFileSync(big, crypto.randomBytes(3 << 20));
  const url = (await vmfiles.open(HOST, big, ALL)).url;
  let b0 = fetchBytes();
  let r = await body(url);
  check('an image serves byte for byte', r.status === 200 && md5(r.buf) === md5(fs.readFileSync(big)), `${fetchBytes() - b0} bytes`);
  b0 = fetchBytes();
  r = await body(url);
  check('loading it again unchanged moves almost nothing', r.status === 200 && md5(r.buf) === md5(fs.readFileSync(big)) && fetchBytes() - b0 < 70000, `${fetchBytes() - b0} bytes`);
  fs.appendFileSync(big, crypto.randomBytes(1 << 20));
  b0 = fetchBytes();
  r = await body(url);
  const moved = fetchBytes() - b0;
  check('a file that grew fetches only the new part', md5(r.buf) === md5(fs.readFileSync(big)) && moved < (1 << 20) + 8192, `${moved} bytes for 1 MB appended`);
  const same = crypto.randomBytes(4 << 20);
  fs.writeFileSync(big, same);
  fs.utimesSync(big, new Date(), new Date(Date.now() + 5000));
  r = await body(url);
  check('a file rewritten at the same size is fetched whole', md5(r.buf) === md5(same));
  const shorter = crypto.randomBytes(1000);
  fs.writeFileSync(big, shorter);
  r = await body(url);
  check('a file that shrank is fetched whole', md5(r.buf) === md5(shorter));
  const longer = crypto.randomBytes(9000);
  fs.writeFileSync(big, longer);
  r = await body(url);
  check('a file replaced by a longer one is not taken for a growth', md5(r.buf) === md5(longer));

  init({ freshMs: 1500 });
  fs.writeFileSync(path.join(proj, 'fresh.png'), crypto.randomBytes(1000));
  const n0 = fetches();
  const fresh = await vmfiles.open(HOST, path.join(proj, 'fresh.png'), ALL);
  const page = await body(fresh.url);
  check('a click then its page load fetch once', page.status === 200 && fetches() === n0 + 1, `${fetches() - n0} fetches`);
  init();

  const words = {};
  for (const [n, p] of [['missing', path.join(proj, 'nope.md')], ['folder', path.join(proj, 'sub')], ['fifo', path.join(proj, 'pipe')]]) {
    const t0 = Date.now();
    words[n] = [(await vmfiles.open(HOST, p, ALL)).error, Date.now() - t0];
  }
  fs.writeFileSync(path.join(proj, 'secret.txt'), 's');
  fs.chmodSync(path.join(proj, 'secret.txt'), 0);
  words.denied = [(await vmfiles.open(HOST, path.join(proj, 'secret.txt'), ALL)).error, 0];
  fs.chmodSync(path.join(proj, 'secret.txt'), 0o600);
  check('the Mac\'s words: not there, a folder, not a file, no access; a fifo is never read',
    words.missing[0] === 'not there' && words.folder[0] === 'a folder' && words.fifo[0] === 'not a file' && words.fifo[1] < 3000 && words.denied[0] === 'no access',
    JSON.stringify(words));
  const gone = await body(`flow-file://vm/claude-agents${proj}/nope.md`);
  check('serving a file that is not there answers 404', gone.status === 404 && gone.buf.toString() === 'not there');
  const bad = await body('flow-file://vm/-oProxyCommand=x/etc/passwd');
  check('an address with a bad host is refused before any ssh', bad.status === 404);

  init({ maxOpen: 5000 });
  const huge = await vmfiles.open(HOST, big, ALL);
  check('a file over the cap is not opened', /^too big to open \(/.test(huge.error || ''), huge.error);
  init();

  const n1 = fetches();
  const [x, y] = await Promise.all([vmfiles.open(HOST, path.join(proj, 'b.txt'), ALL), vmfiles.open(HOST, path.join(proj, 'b.txt'), ALL)]);
  check('two opens of one file share one fetch', x.url && x.url === y.url && fetches() === n1 + 1, `${fetches() - n1} fetches`);
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(proj, `many-${i}.png`), crypto.randomBytes(200000));
  maxLive = live;
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => vmfiles.open(HOST, path.join(proj, `many-${i}.png`), ALL)));
  check('ten opens at once use at most four sessions', many.every((m) => m.url) && maxLive <= 4, `max ${maxLive} at once`);

  mode = 'refused';
  const off = await vmfiles.open(HOST, path.join(proj, 'a.md'), ALL);
  const offServe = await body(a.url);
  mode = 'up';
  check('opening or loading while the VM is unreachable says so', off.error === 'the VM is not reachable' && offServe.status === 502, `${off.error} ${offServe.status}`);
}

async function testCopyPut() {
  const proj = path.join(HOME, 'proj');
  const dl = path.join(MAC, 'downloads');
  const c1 = await vmfiles.copy(HOST, path.join(proj, 'a.md'), dl);
  const c2 = await vmfiles.copy(HOST, '~/proj/a.md', dl);
  check('a VM file copies to the Mac', c1.ok && c1.file === path.join(dl, 'a.md') && fs.readFileSync(c1.file, 'utf8') === fs.readFileSync(path.join(proj, 'a.md'), 'utf8'), c1.error);
  check('a second copy never overwrites: "name (1).ext"', c2.ok && c2.file === path.join(dl, 'a (1).md'), c2.file);
  const before = fs.readdirSync(dl).length;
  const cm = await vmfiles.copy(HOST, path.join(proj, 'nope.md'), dl);
  check('copying a missing file fails and leaves nothing', !cm.ok && cm.error === 'not there' && fs.readdirSync(dl).length === before);
  const cd = await vmfiles.copy(HOST, path.join(proj, 'sub'), dl);
  check('a folder is not copied', !cd.ok && cd.error === 'a folder', cd.error);
  const nodir = await vmfiles.copy(HOST, path.join(proj, 'a.md'), path.join(MAC, 'nope'));
  check('copying into a missing Mac folder says so', !nodir.ok && nodir.error === 'no such folder on this Mac', nodir.error);
  init({ downloads: dl });
  const byDefault = await vmfiles.copy(HOST, path.join(proj, 'tab\tname'));
  init();
  check('with no folder given, a VM file lands in the downloads folder', byDefault.ok && byDefault.file === path.join(dl, 'tab\tname'), byDefault.file);
  const freshDl = path.join(MAC, 'fresh-profile', 'Downloads');
  init({ downloads: freshDl });
  const made = await vmfiles.copy(HOST, path.join(proj, 'a.md'));
  init();
  check('a downloads folder that does not exist yet is made, as page downloads make it', made.ok && made.file === path.join(freshDl, 'a.md'), made.error);

  const pdf = path.join(dl, 'paper.pdf');
  fs.writeFileSync(pdf, crypto.randomBytes(2 << 20));
  const p1 = await vmfiles.put(pdf, HOST, '~/proj');
  const p2 = await vmfiles.put(pdf, HOST, '~/proj');
  check('a Mac file copies into the VM folder', p1.ok && p1.path === path.join(proj, 'paper.pdf') && md5(fs.readFileSync(p1.path)) === md5(fs.readFileSync(pdf)), p1.error);
  check('a second upload never overwrites: "name (1).ext"', p2.ok && p2.path === path.join(proj, 'paper (1).pdf'), p2.path);
  const oddName = path.join(dl, "o'dd $(name).txt");
  fs.writeFileSync(oddName, 'odd');
  const p3 = await vmfiles.put(oddName, HOST, '~/proj');
  check('an odd name arrives as is', p3.ok && fs.readFileSync(path.join(proj, "o'dd $(name).txt"), 'utf8') === 'odd', p3.error);
  const img = path.join(dl, 'paste.png');
  fs.writeFileSync(img, crypto.randomBytes(1000));
  const p4 = await vmfiles.put(img, HOST, '~/.flow/pasted-images', { make: true });
  check('make: an upload creates its Flow folder on the VM', p4.ok && p4.path === path.join(HOME, '.flow', 'pasted-images', 'paste.png'), p4.error);
  const pm = await vmfiles.put(pdf, HOST, '~/no-such');
  check('uploading into a missing VM folder says so', !pm.ok && pm.error === 'not there', pm.error);
  const pd = await vmfiles.put(pdf, HOST, path.join(HOME, 'locked'));
  check('uploading into a closed folder says so', !pd.ok && pd.error === 'no access', pd.error);
  const pl = await vmfiles.put(path.join(dl, 'none.pdf'), HOST, '~/proj');
  check('a missing Mac file says so', !pl.ok && pl.error === 'no such file on this Mac', pl.error);
  stdinCut = 100000;
  const cut = await vmfiles.put(pdf, HOST, '~/proj');
  stdinCut = 0;
  check('an upload cut short fails and leaves nothing on the VM', !cut.ok && cut.error === 'the copy to the VM did not finish' && !fs.existsSync(path.join(proj, 'paper (2).pdf')), cut.error);
}

// ---------- the cache ----------

function deadPid() {
  for (let pid = 4194000; pid > 4000000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return pid;
    }
  }
  throw new Error('no unused pid found');
}

async function testCache() {
  const dead = String(deadPid());
  fs.mkdirSync(path.join(CACHE, dead, 'abc'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(CACHE, dead, 'abc', 'old.pdf'), 'old', { mode: 0o400 });
  fs.mkdirSync(path.join(CACHE, '1'), { mode: 0o700 });
  fs.mkdirSync(path.join(CACHE, 'stray'), { mode: 0o700 });
  init();
  const left = fs.readdirSync(CACHE);
  check('a start removes the copies of runs that ended, read-only ones too, and keeps those of a Flow still running',
    !left.includes(dead) && !left.includes('stray') && left.includes('1'), left.join(' '));
  const a = await vmfiles.open(HOST, '~/proj/a.md', ALL);
  check('this run\'s copies sit in a folder of its own', !!a.url && fs.readdirSync(path.join(CACHE, String(process.pid))).length === 1);
  fs.rmSync(path.join(CACHE, '1'), { recursive: true });
}

// ---------- names that must never run as shell ----------

async function testHostile() {
  const dir = path.join(HOME, 'hostile');
  const weird = path.join(dir, '$(touch sentinel5)');
  const r = await vmfiles.list(HOST, '~/hostile');
  check('names with a leading dash, quotes, $(), backticks, ;, %, \\ and newlines list intact',
    r.ok && [...HOSTILE, '-exec', '$(touch sentinel5)'].every((n) => names(r).includes(n)) && r.total === HOSTILE.length + 2, JSON.stringify(names(r)));
  const inner = await vmfiles.list(HOST, '~/hostile/-exec');
  const inner2 = await vmfiles.list(HOST, weird);
  check('folders named -exec and $(touch ...) list', inner.ok && names(inner).join() === '-n.txt' && inner2.ok && names(inner2).join() === 'inside.txt',
    `${inner.error || names(inner)} | ${inner2.error || names(inner2)}`);

  const w = windowFor(20);
  watchAs(w, ['~/hostile/-exec', weird]);
  await sleep(TICK * 1000 + 300);
  fs.writeFileSync(path.join(dir, '-exec', '--new'), 'n');
  fs.writeFileSync(path.join(weird, '`new`'), 'n');
  const told = await until(() => changesOf(w, '~/hostile/-exec') > 0 && changesOf(w, weird) > 0, TICK * 3000);
  check('watching those folders tells their changes', !!told && names(await vmfiles.list(HOST, '~/hostile/-exec')).includes('--new'));
  await unwatch(w);

  const served = [];
  for (const n of HOSTILE) {
    const o = await vmfiles.open(HOST, path.join(dir, n), ALL);
    const b = o.url ? await body(o.url) : null;
    served.push(b && b.status === 200 && b.buf.toString().includes(`content of ${n}`) ? 'ok' : `${n}: ${o.error || (b && b.status)}`);
  }
  check('each opens as a page and serves its own bytes', served.every((x) => x === 'ok'), served.filter((x) => x !== 'ok').join(' | '));

  const macH = path.join(MAC, 'hostile');
  fs.mkdirSync(macH);
  const copied = [];
  for (const n of HOSTILE) {
    const c = await vmfiles.copy(HOST, path.join(dir, n), macH);
    copied.push(c.ok && c.file === path.join(macH, n) && fs.readFileSync(c.file, 'utf8') === `content of ${n}` ? 'ok' : `${n}: ${c.error || c.file}`);
  }
  check('each copies to the Mac under its own name', copied.every((x) => x === 'ok'), copied.filter((x) => x !== 'ok').join(' | '));

  const sent = [];
  for (const n of HOSTILE) {
    const u = await vmfiles.put(path.join(macH, n), HOST, '~/hostile/-exec');
    sent.push(u.ok && u.path === path.join(dir, '-exec', n) && fs.readFileSync(u.path, 'utf8') === `content of ${n}` ? 'ok' : `${n}: ${u.error || u.path}`);
  }
  check('each uploads to a VM folder named -exec under its own name', sent.every((x) => x === 'ok'), sent.filter((x) => x !== 'ok').join(' | '));
  const into = await vmfiles.put(path.join(macH, '-rf'), HOST, weird);
  check('and into a folder named $(touch sentinel5)', into.ok && into.path === path.join(weird, '-rf'), into.error || into.path);

  // (the folder without permission is skipped: nothing can be made in it)
  const found = execFileSync('/usr/bin/find', [ROOT, '-path', path.join(HOME, 'locked'), '-prune', '-o', '-name', 'sentinel*', '-print'], { encoding: 'utf8' }).trim();
  const here = fs.readdirSync(process.cwd()).filter((f) => f.startsWith('sentinel'));
  check('no name ever ran as shell: no sentinel file anywhere', !found && !here.length, found + here.join(' '));
}

// ---------- nothing lingers on the VM ----------

async function testLoopEnds() {
  vmfiles.init({ spawn: transport, cacheDir: CACHE, files: FILES, openPath: OPTS.openPath, tick: TICK, debounceMs: 10 });
  const w = windowFor(30);
  const n30 = watchCalls().length;
  watchAs(w, ['~/proj']);
  const up30 = await until(() => loops() === 1 && watchCalls().length > n30, 3000);
  const loop = watchCalls()[watchCalls().length - 1];
  check('a watch loop runs with a 10-minute lifetime by default', !!up30 && loop.argv[5] === '600', `lifetime ${loop.argv[5]} s`);

  // The ssh client dies without a word (killed): the loop on the VM finds its session closed at its next write.
  const t0 = Date.now();
  loop.child.kill('SIGKILL');
  const gone = await until(() => loops() === 0, 4000, 20);
  check('a loop whose session closes ends about a tick later, leaving no temp file', !!gone && Date.now() - t0 < TICK * 1000 + 1500 && leftTemp().length === 0,
    `${Date.now() - t0} ms`);
  await unwatch(w);

  // The session hangs: nothing reads and nothing closes, as when the Mac sleeps mid-watch. The lifetime ends the loop.
  init({ life: 3 });
  const w2 = windowFor(31);
  const n31 = watchCalls().length;
  watchAs(w2, ['~/proj']);
  const up31 = await until(() => loops() === 1 && watchCalls().length > n31, 3000);
  const frozen = watchCalls()[watchCalls().length - 1];
  frozen.child.kill('SIGSTOP');
  const t1 = Date.now();
  const capped = await until(() => loops() === 0, 6000);
  check('a loop whose session hangs still ends at its lifetime, leaving no temp file', !!up31 && !!capped && leftTemp().length === 0, `${up31 ? '' : 'no loop started; '}${Date.now() - t1} ms after the hang`);
  frozen.child.kill('SIGCONT');
  await unwatch(w2);
  init();
}

// ---------- only workspace folders: shown(), and open() and serve() refusing the rest ----------

async function testShown() {
  const S = (abs, folders) => vmfiles.shown(HOST, abs, folders);
  check('before any fetch from a host its home is unknown, so nothing is shown', vmfiles.shown('another-host', path.join(HOME, 'proj', 'a.md'), ['~/proj']) === false);
  check("after a fetch: inside a workspace's VM folder however it was typed ('~/proj', 'proj', absolute, '~')",
    S(path.join(HOME, 'proj', 'a.md'), ['~/proj']) && S(path.join(HOME, 'proj', 'sub', 'x.png'), ['proj']) &&
    S(path.join(HOME, 'proj', 'a.md'), [path.join(HOME, 'proj')]) && S(path.join(HOME, 'proj', 'a.md'), ['~']) && S(path.join(HOME, 'proj'), ['~/proj']));
  check('not shown: outside it, under a hidden name, a folder whose name only starts the same, or .. out of it',
    !S(path.join(HOME, 'other', 'a.md'), ['~/proj']) && !S(path.join(HOME, 'proj', '.git', 'config'), ['~/proj']) &&
    !S(path.join(HOME, 'project', 'a.md'), ['~/proj']) && !S('/etc/passwd', ['~/proj']) && !S(`${HOME}/proj/../other/a.md`, ['~/proj']));
  check('not shown with no folders, or a path that is not absolute', !S(path.join(HOME, 'proj', 'a.md'), []) && !S(path.join(HOME, 'proj', 'a.md')) && !S('proj/a.md', ['~/proj']));

  const proj = ['~/proj'];
  fs.mkdirSync(path.join(HOME, 'proj', '.git'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'proj', '.git', 'config'), '[core]\n');
  const n0 = fetches();
  const outside = await vmfiles.open(HOST, path.join(HOME, 'hostile', '-rf'), proj);
  const hidden = await vmfiles.open(HOST, path.join(HOME, 'proj', '.git', 'config'), proj);
  const none = await vmfiles.open(HOST, path.join(HOME, 'proj', 'a.md'));
  check('open() refuses a file outside the workspace folder, under a hidden name, or with no folders given, fetching nothing',
    outside.error === 'not in a workspace folder' && hidden.error === 'not in a workspace folder' && none.error === 'not in a workspace folder' && fetches() === n0,
    JSON.stringify({ outside, hidden, none, fetched: fetches() - n0 }));
  const inside = await vmfiles.open(HOST, '~/proj/a.md', proj);
  check('and opens one inside it, even asked for by a typed path', !!inside.url, JSON.stringify(inside));
  const ok = await vmfiles.serve(new Request(unsignedVmUrl(HOST, path.join(HOME, 'proj', 'a.md'))), proj);
  const no = await vmfiles.serve(new Request(unsignedVmUrl(HOST, path.join(HOME, 'hostile', '-rf'))), proj);
  check('serve() answers a file inside it and refuses one outside with 403', ok.status === 200 && no.status === 403 && (await no.text()) === 'not in a workspace folder', `${ok.status} ${no.status}`);
  // A tab restored before anything was fetched from its host this run: the file is fetched first, then checked.
  const fresh = 'claude-agents-2';
  const n1 = fetches();
  const first = await vmfiles.serve(new Request(unsignedVmUrl(fresh, path.join(HOME, 'hostile', '-rf'))), proj);
  const second = await vmfiles.serve(new Request(unsignedVmUrl(fresh, path.join(HOME, 'proj', 'a.md'))), proj);
  check('a host with no fetch yet: the first file is fetched, then refused when outside; inside ones are served',
    first.status === 403 && second.status === 200 && fetches() === n1 + 2, `${first.status} ${second.status}, ${fetches() - n1} fetches`);
}

// ---------- what a path is, from the listings held: a link to a folder stays text in a VM .md ----------

async function testKindAt() {
  const proj = path.join(HOME, 'proj');
  const K = (p) => vmfiles.kindAt(HOST, p);
  check('kindAt knows nothing of a folder no listing holds', K(path.join(HOME, 'hostile', '-exec', 'x', 'y')) === null && vmfiles.kindAt('another-host', path.join(proj, 'sub')) === null);
  await vmfiles.list(HOST, '~/proj/');
  const n = calls.length;
  check('after a listing of its folder (typed with a trailing slash): a folder, a link to a folder, a file, a fifo',
    K(path.join(proj, 'sub')) === 'dir' && K(path.join(proj, 'linkdir')) === 'dir' && K(`${proj}/./sub/`) === 'dir' && K(path.join(proj, 'a.md')) === 'file' && K(path.join(proj, 'pipe')) === 'file',
    [K(path.join(proj, 'sub')), K(path.join(proj, 'linkdir')), K(`${proj}/./sub/`), K(path.join(proj, 'a.md')), K(path.join(proj, 'pipe'))].join(' '));
  check('a name its listing does not have, a hidden one, one in a folder not listed, or a path that is not absolute: unknown',
    K(path.join(proj, 'nope')) === null && K(path.join(proj, '.hidden')) === null && K(path.join(proj, 'sub', 'deeper')) === null && K('proj/sub') === null);
  check('kindAt makes no round trip', calls.length === n, `${calls.length - n} calls`);
  const w = windowFor(70);
  watchAs(w, ['~/proj']);
  const up = await until(() => loops() === 1, 3000);
  fs.mkdirSync(path.join(proj, 'made-later'));
  const known = await until(() => K(path.join(proj, 'made-later')) === 'dir', TICK * 3000);
  check('in a watched folder, a folder made later is known once its loop tells it', !!up && !!known, `${K(path.join(proj, 'made-later'))}`);
  await unwatch(w);
  fs.rmdirSync(path.join(proj, 'made-later'));
}

// ---------- a report's folder, named by files-main.js, reaches respond() ----------

async function testScope() {
  const dir = path.join(HOME, 'proj', 'report');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: red }\n');
  const url = unsignedVmUrl(HOST, path.join(dir, 'style.css'));
  const n = origins.length;
  const scoped = await vmfiles.serve(new Request(url, { headers: { 'x-flow-scope': dir } }), ALL);
  const unscoped = await vmfiles.serve(new Request(url), ALL);
  const got = origins.slice(n);
  check("a report's folder in x-flow-scope reaches respond() as origin.scope, and without it scope is null",
    scoped.status === 200 && unscoped.status === 200 && got.length === 2 && got[0].scope === dir && got[0].host === HOST &&
    got[0].path === path.join(dir, 'style.css') && got[1].scope === null, JSON.stringify(got));
  fs.rmSync(dir, { recursive: true });
}

// ---------- a file open as a page, watched on its own ----------

async function testFileWatch() {
  const f = path.join(HOME, 'proj', 'plan.md');
  fs.writeFileSync(f, '# plan\n');
  const w = windowFor(40);
  const fileTold = [];
  const changed = (host, p, what) => (what === 'file' ? fileTold.push(p) : w.changes.push({ host, dir: p }));
  vmfiles.watch(w.id, [{ host: HOST, dir: '~/proj' }, { host: HOST, file: f }], changed);
  await until(() => loops() === 1, 3000);
  const loop = watchCalls()[watchCalls().length - 1];
  check('a watched file goes to the same one loop as its folder', loops() === 1 && loop.argv.includes(f) && loop.argv.includes('~/proj'), loop.argv.slice(6).join(' | '));
  await sleep(TICK * 2000 + 300);
  const bytes0 = loop.out;
  await sleep(TICK * 2000);
  check('watching an open file tells nothing until it changes, and costs only the heartbeat', fileTold.length === 0 && loop.out - bytes0 >= 2 && loop.out - bytes0 <= 2 * 3, `${fileTold.length} told, ${loop.out - bytes0} bytes`);
  const dirs0 = changesOf(w, '~/proj');
  fs.appendFileSync(f, 'step 1\n');
  const told = await until(() => fileTold.length === 1, TICK * 3000);
  await sleep(TICK * 1000);
  check('a file an agent writes to is told, alone; its folder (names only) is not', !!told && fileTold[0] === f && changesOf(w, '~/proj') === dirs0, `${fileTold.length} file, ${changesOf(w, '~/proj') - dirs0} folder`);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  check('a new time alone is told', !!(await until(() => fileTold.length === 2, TICK * 3000)));
  fs.unlinkSync(f);
  check('a file that goes is told', !!(await until(() => fileTold.length === 3, TICK * 3000)));
  fs.writeFileSync(f, '# back\n');
  check('and when it comes back', !!(await until(() => fileTold.length === 4, TICK * 3000)));
  await sleep(TICK * 2000);
  const n = fileTold.length;
  const starts40 = watchCalls().length;
  vmfiles.watch(w.id, [{ host: HOST, dir: '~/proj' }, { host: HOST, file: f }, { host: HOST, dir: '~/later' }], changed);
  await sleep(TICK * 2000 + 300);
  check('a new set restarts the loop without telling the file again', watchCalls().length === starts40 + 1 && fileTold.length === n, `${watchCalls().length - starts40} restarts, ${fileTold.length - n} told`);

  // An outage: nothing is told for the file meanwhile; a change made then is told once the VM is back.
  mode = 'refused';
  const loop2 = watchCalls()[watchCalls().length - 1];
  loop2.child.kill('SIGUSR1');
  await until(() => changesOf(w, '~/proj') > dirs0, 3000);
  fs.appendFileSync(f, 'written while the VM was away\n');
  await sleep(1000);
  check('nothing is told for the file while the VM is away', fileTold.length === n, `${fileTold.length - n}`);
  mode = 'up';
  check('a change made while away is told once it is back', !!(await until(() => fileTold.length === n + 1, 6000)) && (await sleep(TICK * 2000), fileTold.length === n + 1), `${fileTold.length - n}`);
  await unwatch(w);
  fs.unlinkSync(f);
}

// ---------- a VM .md tab that could not load while the VM was away loads by itself once it is back ----------

async function testAwayPage() {
  const f = path.join(HOME, 'proj', 'away.md');
  fs.writeFileSync(f, '# away\n');
  const url = unsignedVmUrl(HOST, f);
  const w = windowFor(42);
  const fileTold = [];
  const changed = (host, p, what) => (what === 'file' ? fileTold.push(p) : w.changes.push({ host, dir: p }));

  // As after a restart before the network is up: the restored tab's first load fails, then its watch starts.
  mode = 'refused';
  const first = await body(url);
  vmfiles.watch(w.id, [{ host: HOST, file: f }], changed);
  await sleep(1000);
  check('a tab restored while the VM is away says so, and nothing is told meanwhile', first.status === 502 && fileTold.length === 0, `${first.status}, ${fileTold.length} told`);
  mode = 'up';
  check('once the VM is back, that tab is told, so it loads by itself', !!(await until(() => fileTold.length === 1, 8000)), `${fileTold.length} told`);
  const loaded = await body(url);
  await sleep(TICK * 2000 + 300);
  check('then it shows the file, told once', loaded.status === 200 && loaded.buf.toString().includes('away') && fileTold.length === 1, `${loaded.status}, ${fileTold.length} told`);

  // An outage while it shows: a reload then fails, and the tab is told once the VM is back.
  mode = 'refused';
  watchCalls()[watchCalls().length - 1].child.kill('SIGUSR1');
  await sleep(500);
  const during = await body(url);
  mode = 'up';
  check('a reload while the VM is away fails, and the tab is told once it is back', during.status === 502 && !!(await until(() => fileTold.length === 2, 8000)), `${during.status}, ${fileTold.length} told`);
  await unwatch(w);
  fs.unlinkSync(f);
}

// ---------- the network back: a watch waiting out its backoff tries again at once ----------

async function testRetryNow() {
  const resets = [];
  init({ retryMs: 5000, retryMaxMs: 60000, sshRetry: (host) => resets.push(host) });
  const w = windowFor(80);
  watchAs(w, ['~/proj']);
  const up = await until(() => loops() === 1, 3000);
  await sleep(TICK * 1000 + 300);
  // A watched folder answers from its loop, with no ssh: "the VM is not reachable" while the watch waits out its backoff.
  const listed = async (ok, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const r = await vmfiles.list(HOST, '~/proj');
      if (ok(r)) return r;
      if (Date.now() > end) return null;
      await sleep(50);
    }
  };
  mode = 'refused';
  watchCalls()[watchCalls().length - 1].child.kill('SIGUSR1');
  const away = await listed((r) => r.error === 'the VM is not reachable', 3000);
  mode = 'up';
  const n0 = watchCalls().length;
  await sleep(1000);
  const still = await vmfiles.list(HOST, '~/proj');
  check('with the VM back, a watch waiting out its 5 s backoff has not tried again a second later',
    !!up && !!away && watchCalls().length === n0 && still.error === 'the VM is not reachable', `${watchCalls().length - n0} tries, ${still.error || 'listed'}`);
  const c1 = changesOf(w, '~/proj');
  const t0 = Date.now();
  const tried = vmfiles.retryNow();
  const started = watchCalls().length - n0;
  const back = await until(() => changesOf(w, '~/proj') > c1, 5000, 20);
  const ms = Date.now() - t0;
  const after = await vmfiles.list(HOST, '~/proj');
  check('retryNow, as when the network comes back, tries at once with both backoffs started over, and the folder lists again',
    tried.join() === HOST && resets.join() === HOST && started === 1 && !!back && after.ok === true, `${started} tries at once; told back after ${ms} ms`);
  check('a host that is not waiting is left alone', vmfiles.retryNow().length === 0 && resets.length === 1);
  await unwatch(w);
  init();
}

// ---------- live reload: a page reloaded after a change shows the change ----------

async function testLiveRaces() {
  init({ freshMs: 3000 });
  // A change right after the page fetched its copy: the reload that follows the told change must not get that copy.
  const g = path.join(HOME, 'proj', 'live.md');
  fs.writeFileSync(g, 'v0\n');
  const told = [];
  const w = windowFor(60);
  vmfiles.watch(w.id, [{ host: HOST, file: g }], (host, p, what) => { if (what === 'file') told.push(p); });
  await until(() => loops() === 1, 3000);
  await sleep(TICK * 1000 + 400);
  const o = await vmfiles.open(HOST, g, ALL);
  const t0 = Date.now();
  fs.appendFileSync(g, 'v1\n');
  await until(() => told.length === 1, TICK * 3000, 20);
  const soon = Date.now() - t0;
  const r = await body(o.url);
  check('a reload right after a told change shows the change, not the copy fetched just before', r.buf.toString().includes('v1') && soon < 3000,
    `${soon} ms after the copy: ${JSON.stringify(r.buf.toString().slice(0, 60))}`);
  await unwatch(w);

  // A change between the page's fetch and the watch's first look at the file: told at once.
  const h = path.join(HOME, 'proj', 'race.md');
  fs.writeFileSync(h, 'v0\n');
  const o2 = await vmfiles.open(HOST, h, ALL);
  fs.appendFileSync(h, 'v1\n');
  const told2 = [];
  const w2 = windowFor(61);
  vmfiles.watch(w2.id, [{ host: HOST, file: h }], (host, p, what) => { if (what === 'file') told2.push(p); });
  const first = await until(() => told2.length === 1, TICK * 3000, 20);
  const r2 = await body(o2.url);
  check("a change made before the watch's first look is told at once, and the reload shows it", !!first && r2.buf.toString().includes('v1'), `${told2.length} told`);
  await unwatch(w2);

  // A file unchanged since its page fetched it: the first look tells nothing.
  const quiet = path.join(HOME, 'proj', 'quiet.md');
  fs.writeFileSync(quiet, 'same\n');
  await vmfiles.open(HOST, quiet, ALL);
  const told3 = [];
  const w3 = windowFor(62);
  const n62 = watchCalls().length;
  vmfiles.watch(w3.id, [{ host: HOST, file: quiet }], (host, p, what) => { if (what === 'file') told3.push(p); });
  const up62 = await until(() => loops() === 1 && watchCalls().length > n62, 3000);
  await sleep(TICK * 2000 + 400);
  const loop62 = watchCalls()[watchCalls().length - 1];
  check('a file unchanged since its page fetched it tells nothing at the first look', !!up62 && loop62.argv.includes(quiet) && loop62.out > 0 && told3.length === 0,
    `${told3.length} told, ${loop62.out} bytes from its loop`);
  await unwatch(w3);
  init();
}

async function testShutdown() {
  const w = windowFor(7);
  watchAs(w, ['~/proj', '~/later']);
  await until(() => loops() === 1, 3000);
  check('a loop runs before shutdown', loops() === 1);
  vmfiles.shutdown();
  check('shutdown ends every loop on the VM', !!(await until(() => loops() === 0, 3000)));
  const wd = windowFor(9);
  watchAs(wd, ['~/proj']);
  const up9 = await until(() => loops() === 1, 3000);
  vmfiles.stop(9);
  check('a closed window stops its loop', !!up9 && !!(await until(() => loops() === 0, 3000)));
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  setup();
  init();
  console.log(`     files-main: kindOf ${realFiles.kindOf ? 'its own' : 'written out here'}, respond ${realFiles.respond ? 'its own' : 'written out here'}`);
  try {
    await testCache();
    await testList();
    await testWatch();
    await testLifetime();
    await testUnreachable();
    await testOpen();
    await testCopyPut();
    await testHostile();
    await testLoopEnds();
    await testShown();
    await testKindAt();
    await testScope();
    await testFileWatch();
    await testLiveRaces();
    await testAwayPage();
    await testRetryNow();
    await testShutdown();
  } finally {
    vmfiles.shutdown();
    await until(() => loops() === 0, 3000);
    fs.chmodSync(path.join(HOME, 'locked'), 0o700);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});




