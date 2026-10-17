'use strict';
// src/pty.js: no claude starts on a conversation another claude still holds. A stand-in `claude` (this test's own HOME,
// ~/.local/bin/claude: a node script that ignores SIGHUP and SIGTERM) plays every claude; /bin/ps times out on demand
// (child_process.execFile wrapped before pty.js loads):
//   - an end whose lookup fails keeps nothing as ending; reopening that conversation, the first scans fail too and are
//     retried; the one that works finds the old claude (Flow's server started it, its pane is gone), waits for it as an
//     ended one (30 s, TERM, KILL 5 s later) and only then starts its own: one claude on it at a time;
//   - a terminal on another conversation starts at once all along;
//   - a claude outside Flow on the conversation (another terminal): the open fails at once saying so in plain words (the
//     process only in the log) with retry set, so the window opens again by itself, and that claude is never signalled;
//     once it has exited, the next open starts the conversation;
//   - a claude in another Flow window on it: the open fails at once the same way, and that claude keeps running;
//   - a fork of a running claude starts at once, its parent untouched;
//   - when every scan fails, the open fails after 30 s, with retry set, and starts nothing; on a conversation no claude
//     holds, the next open once ps works again starts it at once;
//   - an end that comes while its terminal is still opening (its scan slow, or waiting for an ended claude) applies at
//     once: the open stops there and starts nothing, no claude and no session, and signals nothing.
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-ending-unread-test.js
// FLOW_TEST_SOCKET and FLOW_TEST_ROOT move it off main's socket flow-dev-main and /tmp/flow-dev-main.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOCKET = process.env.FLOW_TEST_SOCKET || 'flow-dev-main';
const ROOT = process.env.FLOW_TEST_ROOT || '/tmp/flow-dev-main/ending-unread';
const HOME = path.join(ROOT, 'home');
const CWD = path.join(ROOT, 'work');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, '.local', 'bin'), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
// without one, zsh -i stops at its first-run menu
fs.writeFileSync(path.join(HOME, '.zshrc'), '');
const STARTED = path.join(ROOT, 'started');   // a line per stand-in started: its arguments
const SIGNALS = path.join(ROOT, 'signals');   // a line per signal a stand-in got: "<pid> HUP" or "<pid> TERM" (a KILL ends it)
fs.writeFileSync(path.join(HOME, '.local', 'bin', 'claude'),
  `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(STARTED)}, process.argv.slice(2).join(' ') + '\\n');\n` +
  `const got = (s) => fs.appendFileSync(${JSON.stringify(SIGNALS)}, process.pid + ' ' + s + '\\n');\n` +
  "process.on('SIGHUP', () => got('HUP'));\nprocess.on('SIGTERM', () => got('TERM'));\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
const starts = (id) => (fs.existsSync(STARTED) ? fs.readFileSync(STARTED, 'utf8').split('\n').filter((l) => l.includes(id)).length : 0);
const sigs = (pid) => (fs.existsSync(SIGNALS) ? fs.readFileSync(SIGNALS, 'utf8').split('\n').filter((l) => l.startsWith(`${pid} `)).map((l) => l.split(' ')[1]) : []);
process.env.HOME = HOME;

/* /bin/ps through pty.js's exec, which on Linux runs as /bin/bash --posix -c <close fds> flow <file> <args>: the next
   psFails calls time out the way execFile reports a timeout (killed, no exit code) */
let psFails = 0, psCalls = 0, psFailed = 0, psSlowNext = 0;
const PS_SLOW_MS = 2500;   // a slowed scan (case I): ps -axww answers this late
const realExecFile = childProcess.execFile;
childProcess.execFile = function (file, args, opts, cb) {
  const real = file === '/bin/bash' && args[0] === '--posix' && args[3] === 'flow' ? args[4] : file;
  if (real === '/bin/ps') {
    psCalls++;
    const psArgs = file === '/bin/bash' ? args.slice(5) : args;
    if (psSlowNext > 0 && psFails <= 0 && psArgs.includes('-axww')) {
      psSlowNext--;
      const late = cb;
      cb = (...a) => setTimeout(() => late(...a), PS_SLOW_MS);
    }
    if (psFails > 0) {
      psFails--;
      psFailed++;
      const err = Object.assign(new Error('Command failed: ps'), { killed: true, signal: 'SIGTERM', code: null });
      setImmediate(() => cb(err, '', ''));
      return { pid: 0, kill() {} };
    }
  }
  return realExecFile.call(this, file, args, opts, cb);
};
const pty = require('../src/pty');

const wc = { id: 303, isDestroyed: () => false, send() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.join(' ')); realError(...a); };
const realLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); realLog(...a); };
let failed = 0;
let crashed = false;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const tmux = (...args) => childProcess.execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const killServer = () => {
  try {
    tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
  }
};
// the stand-in node processes themselves (the zsh around each has the same words in its command line)
const stand = (id) => childProcess.execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' }).split('\n')
  .filter((l) => /^\s*\d+\s+node\s/.test(l) && l.includes(path.join(HOME, '.local', 'bin', 'claude')) && l.includes(`--session-id ${id}`))
  .map((l) => Number(l.trim().split(/\s+/)[0]));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return fn();
}

(async () => {
  killServer();
  await pty.init({ socket: SOCKET, version: 'test' });
  check('the stand-in is the claude pty starts', pty.info().claude === path.join(HOME, '.local', 'bin', 'claude'), pty.info().claude);
  const x = crypto.randomUUID();
  const z = crypto.randomUUID();
  const y = crypto.randomUUID();
  const w = crypto.randomUUID();
  const v = crypto.randomUUID();
  const u = crypto.randomUUID();
  const parentId = crypto.randomUUID();
  const childId = crypto.randomUUID();

  // A: the end's lookup fails, then the first scans at the reopen fail too
  const r1 = await pty.open(wc, { id: 'un1', cmd: 'claude', cwd: CWD, sessionId: x, cols: 80, rows: 24 });
  const old = await waitFor(() => stand(x)[0], 15000);
  check('the stand-in claude runs in its session', r1.ok && !!old, JSON.stringify({ ok: r1.ok, old }));
  psFails = 1;
  await pty.kill('un1');
  check('the end could not read its processes: logged, and the claude (still running) is not kept as ending',
    psFailed === 1 && alive(old) && !pty.isEnding(old) && logged.some((l) => l.includes('ending un1: could not read its processes')),
    `ps failed ${psFailed}, alive ${alive(old)}, ending ${pty.isEnding(old)}`);

  const t0 = Date.now();
  const r3 = await pty.open(wc, { id: 'un3', cmd: 'claude', cwd: CWD, sessionId: y, cols: 80, rows: 24 });
  check('a terminal on another conversation starts at once', r3.ok && Date.now() - t0 < 5000 && alive(old), `${Date.now() - t0} ms`);

  psFails = 3;
  const before = psFailed;
  const t1 = Date.now();
  const opened = pty.open(wc, { id: 'un1', cmd: 'claude', cwd: CWD, sessionId: x, resume: true, cols: 80, rows: 24 });
  await sleep(8000);
  const meanwhile = stand(x);
  check('reopening it starts nothing while the old claude still holds the conversation', meanwhile.length === 1 && meanwhile[0] === old && pty.isEnding(old),
    `claudes on it ${JSON.stringify(meanwhile)}, ending ${pty.isEnding(old)}`);
  const r2 = await opened;
  const took = Date.now() - t1;
  const fresh = await waitFor(() => stand(x).find((pid) => pid !== old), 15000);
  const retries = logged.filter((l) => l.includes('opening un1: could not read which claudes hold its conversation; trying again')).length;
  check('the failed scans are retried (logged once); once one works the old claude is waited for, stopped (TERM, KILL) and only then a new one starts',
    psFailed - before === 3 && retries === 1 && r2.ok && took >= 34000 && took < 50000 && !alive(old) && sigs(old).includes('TERM') &&
    ['SIGTERM', 'SIGKILL'].every((sig) => logged.some((l) => l.includes(`process ${old}`) && l.includes(`sending ${sig}`))) && !!fresh && stand(x).length === 1,
    `${psFailed - before} scans failed, ${retries} retries logged, ${took} ms, old ${alive(old) ? 'alive' : 'gone'} (got ${sigs(old).join(' ') || 'nothing'}), now ${JSON.stringify(stand(x))}`);

  // D: a claude outside Flow holds the conversation (another terminal: no TMUX, or another server's)
  const outEnv = { ...process.env };
  delete outEnv.TMUX;
  delete outEnv.TMUX_PANE;
  const outside = childProcess.spawn('node', [path.join(HOME, '.local', 'bin', 'claude'), '--session-id', w], { env: outEnv, detached: true, stdio: 'ignore' });
  outside.unref();
  await waitFor(() => stand(w).includes(outside.pid), 10000);
  const t3 = Date.now();
  const r6 = await pty.open(wc, { id: 'out1', cmd: 'claude', cwd: CWD, sessionId: w, resume: true, cols: 80, rows: 24 });
  const took3 = Date.now() - t3;
  await sleep(1000);
  check('a claude outside Flow on the conversation: the open fails at once, saying so (the process only in the log), to be tried again, and starts nothing',
    !r6.ok && r6.error === 'this conversation is open in a Claude outside Flow' && r6.retry === true && logged.some((l) => l.includes(`claude ${outside.pid} outside Flow holds`)) &&
    took3 < 5000 && stand(w).length === 1 && alive(outside.pid), `${took3} ms, error ${JSON.stringify(r6.error)}, retry ${r6.retry}, claudes on it ${JSON.stringify(stand(w))}`);

  // E: another Flow window holds it
  const r7 = await pty.open(wc, { id: 'lv1', cmd: 'claude', cwd: CWD, sessionId: v, cols: 80, rows: 24 });
  const livePid = await waitFor(() => stand(v)[0], 15000);
  const t4 = Date.now();
  const r8 = await pty.open(wc, { id: 'lv2', cmd: 'claude', cwd: CWD, sessionId: v, resume: true, cols: 80, rows: 24 });
  const took4 = Date.now() - t4;
  await sleep(500);
  const lv1There = await pty.exists('lv1');
  check('a claude in another Flow window on it: the open fails at once the same way, and that claude keeps running, untouched',
    r7.ok && !!livePid && !r8.ok && r8.error === 'this conversation is open in another Flow window' && r8.retry === true &&
    logged.some((l) => l.includes(`claude ${livePid} in another Flow window holds`)) && took4 < 5000 && alive(livePid) && sigs(livePid).length === 0 && lv1There &&
    stand(v).length === 1, `${took4} ms, error ${JSON.stringify(r8.error)}, retry ${r8.retry}, claudes on it ${JSON.stringify(stand(v))}, it got ${sigs(livePid).join(' ') || 'nothing'}, flow_lv1 ${lv1There}`);

  // F: a fork of a running claude
  fs.mkdirSync(path.join(HOME, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'projects', 'p', parentId + '.jsonl'), '');
  const r9 = await pty.open(wc, { id: 'fp', cmd: 'claude', cwd: CWD, sessionId: parentId, cols: 80, rows: 24 });
  const parentPid = await waitFor(() => stand(parentId)[0], 15000);
  const t5 = Date.now();
  const r10 = await pty.open(wc, { id: 'fc', cmd: 'claude', cwd: CWD, sessionId: childId, forkFrom: parentId, cols: 80, rows: 24 });
  const took5 = Date.now() - t5;
  const forkLine = await waitFor(() => childProcess.execFileSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' }).split('\n')
    .find((l) => /^node\s/.test(l) && l.includes(`--fork-session --session-id ${childId}`)), 15000);
  const fpThere = await pty.exists('fp');
  check('a fork of a running claude starts at once, its parent untouched',
    r9.ok && !!parentPid && r10.ok && took5 < 5000 && !!forkLine && alive(parentPid) && sigs(parentPid).length === 0 && fpThere,
    `${took5} ms, parent ${parentPid} ${alive(parentPid) ? 'running' : 'gone'}, it got ${sigs(parentPid).join(' ') || 'nothing'}, flow_fp ${fpThere}`);

  // B: every scan fails
  const r4 = await pty.open(wc, { id: 'un4', cmd: 'claude', cwd: CWD, sessionId: z, cols: 80, rows: 24 });
  const held = await waitFor(() => stand(z)[0], 15000);
  psFails = 1;
  await pty.kill('un4');
  psFails = 1e9;
  const t2 = Date.now();
  // H, alongside: a window on a conversation no claude holds, opened while no scan works either
  const r13p = pty.open(wc, { id: 'nh1', cmd: 'claude', cwd: CWD, sessionId: u, resume: true, cols: 80, rows: 24 });
  const r5 = await pty.open(wc, { id: 'un4', cmd: 'claude', cwd: CWD, sessionId: z, resume: true, cols: 80, rows: 24 });
  const took2 = Date.now() - t2;
  const r13 = await r13p;
  psFails = 0;
  await sleep(1500);
  check('when no scan works, the open fails after 30 s, to be tried again, and starts nothing',
    r4.ok && !!held && !r5.ok && r5.error === 'could not check whether this conversation is open elsewhere' && r5.retry === true && took2 >= 30000 &&
    took2 < 45000 && stand(z).length === 1 && alive(held), `${took2} ms, error ${JSON.stringify(r5.error)}, retry ${r5.retry}, claudes on it ${JSON.stringify(stand(z))}`);
  const t7 = Date.now();
  const r14 = await pty.open(wc, { id: 'nh1', cmd: 'claude', cwd: CWD, sessionId: u, resume: true, cols: 80, rows: 24 });
  const took7 = Date.now() - t7;
  const nh = await waitFor(() => stand(u)[0], 15000);
  check('H: a conversation no claude holds, while no scan works: refused the same way; the next try once ps works starts it at once',
    !r13.ok && r13.error === 'could not check whether this conversation is open elsewhere' && r13.retry === true && r14.ok && r14.created && !r14.retry &&
    took7 < 5000 && !!nh && stand(u).length === 1, `first ${JSON.stringify({ ok: r13.ok, error: r13.error, retry: r13.retry })}, then ${took7} ms ${JSON.stringify({ ok: r14.ok, created: r14.created, error: r14.error })}, claudes on it ${JSON.stringify(stand(u))}`);
  const sessions = tmux('ls', '-F', '#{session_name}').split('\n');
  check('no session was made for any refused open', !sessions.includes('flow_un4') && !sessions.includes('flow_out1') && !sessions.includes('flow_lv2'), sessions.join(' '));
  await sleep(36500 - (Date.now() - t3));
  const signalled = logged.filter((l) => l.includes(`process ${outside.pid}`) && /sending SIG/.test(l));
  check('the claude outside Flow is never signalled: still running well past the 35 s an ended one gets', alive(outside.pid) && Date.now() - t3 > 36000 && signalled.length === 0 &&
    sigs(outside.pid).length === 0, `${Math.round((Date.now() - t3) / 1000)} s later ${alive(outside.pid) ? 'running' : 'gone'}, signals logged ${signalled.length}, it got ${sigs(outside.pid).join(' ') || 'nothing'}`);

  // G: the owner quits that outside claude; the window's next try starts the conversation
  process.kill(outside.pid, 'SIGKILL');
  await waitFor(() => !alive(outside.pid), 10000);
  const r11 = await pty.open(wc, { id: 'out1', cmd: 'claude', cwd: CWD, sessionId: w, resume: true, cols: 80, rows: 24 });
  const mine = await waitFor(() => stand(w).find((p) => p !== outside.pid), 15000);
  check('once the claude outside Flow has exited, the next try starts the conversation, one claude on it', r11.ok && !!mine && stand(w).length === 1,
    `${JSON.stringify({ ok: r11.ok, error: r11.error })}, claudes on it ${JSON.stringify(stand(w))}`);

  const timed = (p, t) => p.then((value) => ({ value, ms: Date.now() - t }));
  const said = (s) => (s.status === 'fulfilled' ? `${s.value.value ? JSON.stringify({ ok: s.value.value.ok, error: s.value.value.error }) : 'done'} at ${s.value.ms} ms` : String(s.reason));

  // I: an end while its terminal is still opening: the open's scan is slow, the end's is not
  const q = crypto.randomUUID();
  psSlowNext = 1;
  const tI = Date.now();
  const openI = timed(pty.open(wc, { id: 'oi1', cmd: 'claude', cwd: CWD, sessionId: q, cols: 80, rows: 24 }), tI);
  await sleep(500);
  const killI = timed(pty.kill('oi1'), tI);
  const [rI, kI] = await Promise.allSettled([openI, killI]);
  await sleep(1500);
  const sessionsI = tmux('ls', '-F', '#{session_name}').split('\n');
  check('I: an end that comes while its terminal is still opening (its scan slow) applies at once, and the open starts nothing: no claude, no session',
    kI.status === 'fulfilled' && kI.value.ms < 1500 && rI.status === 'fulfilled' && rI.value.value.error === 'ended before it started' && starts(q) === 0 &&
    !sessionsI.includes('flow_oi1'), `end ${said(kI)}, open ${said(rI)}, claudes started ${starts(q)}, flow_oi1 ${sessionsI.includes('flow_oi1') ? 'still there' : 'gone'}`);

  // J: an end while its window waits for an ended claude to exit (up to 35 s)
  const p = crypto.randomUUID();
  const rJ0 = await pty.open(wc, { id: 'oj1', cmd: 'claude', cwd: CWD, sessionId: p, cols: 80, rows: 24 });
  const oldJ = await waitFor(() => stand(p)[0], 15000);
  await pty.kill('oj1');
  const tJ = Date.now();
  let waitedJ = true;
  const openJ = timed(pty.open(wc, { id: 'oj1', cmd: 'claude', cwd: CWD, sessionId: p, resume: true, cols: 80, rows: 24 }), tJ);
  openJ.then(() => { waitedJ = Date.now() - tJ >= 2000; }, () => { waitedJ = false; });
  await sleep(2000);
  const heldJ = waitedJ && pty.isEnding(oldJ) && starts(p) === 1;
  const killJ = timed(pty.kill('oj1'), tJ);
  const [rJ, kJ] = await Promise.allSettled([openJ, killJ]);
  await sleep(3000);
  const sessionsJ = tmux('ls', '-F', '#{session_name}').split('\n');
  const signalledJ = logged.filter((l) => l.includes(`process ${oldJ}`) && /sending SIG/.test(l)).length;
  check('J: an end while its window waits for an ended claude applies at once: the open stops waiting and starts nothing, and the old claude is not signalled',
    rJ0.ok && !!oldJ && heldJ && waitedJ && kJ.status === 'fulfilled' && kJ.value.ms < 3000 && rJ.status === 'fulfilled' && rJ.value.value.error === 'ended before it started' &&
    rJ.value.ms < 3000 && starts(p) === 1 && !sessionsJ.includes('flow_oj1') && alive(oldJ) && signalledJ === 0 && !sigs(oldJ).includes('TERM'),
    `waiting at 2 s ${heldJ}, end ${said(kJ)}, open ${said(rJ)}, claudes started ${starts(p)}, flow_oj1 ${sessionsJ.includes('flow_oj1') ? 'there' : 'gone'}, ` +
    `old ${alive(oldJ) ? 'running' : 'gone'}, signals logged ${signalledJ}, it got ${sigs(oldJ).join(' ') || 'nothing'}`);
})().catch((err) => {
  console.log('test crashed:', err);
  crashed = true;
}).finally(async () => {
  psFails = 0;
  await pty.shutdown();
  killServer();
  // the stand-ins ignore the hangup and TERM
  try {
    childProcess.execFileSync('pkill', ['-KILL', '-f', path.join(HOME, '.local', 'bin', 'claude')], { stdio: 'ignore' });
  } catch (e) {
    if (e.status !== 1) throw e; // 1: none left
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(crashed ? 'crashed' : failed ? `${failed} FAILED` : 'all passed');
  process.exit(crashed ? 2 : failed ? 1 : 0);
});




