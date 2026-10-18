'use strict';
// Module test of src/pty.js without a window. Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-pty-test.js
// Uses the isolated tmux socket flow-dev-main and kills that server at the end.

const childProcess = require('child_process');
const { execFileSync } = childProcess;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Counts the ssh runs pty.js starts for the unreachable test host (pty.js takes execFile when it loads).
const UNREACHABLE = 'flow-test.invalid';
const sshRuns = [];
const realExecFile = childProcess.execFile;
childProcess.execFile = function (file, args, ...rest) {
  if (Array.isArray(args) && args.includes(UNREACHABLE)) sshRuns.push(Date.now());
  return realExecFile.call(this, file, args, ...rest);
};
const pty = require('../src/pty');
const { ownSession, ownFork } = require('./main-own-session');

const SOCKET = 'flow-dev-main';
// Team rule for real claude in tests: own sessions only, cwd under /tmp/flow-dev-main, nothing typed into Claude Code
// here. That folder is not trusted, so Claude Code stops at its folder trust question, which is never answered.
const CLAUDE_CWD = '/tmp/flow-dev-main/claude-check';
const FIRST_SCREEN = /Welcome back|Claude Code|ClaudeCode|Free Code|Quick safety check/;
let TMUX = null;                    // the tmux pty.js found
let crashed = false;
const out = new Map();
const exits = [];
const wc = {
  id: 101,
  isDestroyed: () => false,
  send(channel, id, payload) {
    if (channel === 'term:data') out.set(id, (out.get(id) || '') + payload);
    else if (channel === 'term:exit') exits.push([id, payload]);
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\x1b[=>]/g, '');
const fdLinks = (pid) => fs.readdirSync(`/proc/${pid}/fd`).map((f) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/fd/${f}`);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}).filter(Boolean);
const tmuxLs = () => {
  try {
    return execFileSync(TMUX, ['-L', SOCKET, 'ls'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return 'ls failed: ' + String(e.stderr || e.message).trim();
  }
};
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

(async () => {
  const t0 = Date.now();
  await pty.init({ socket: SOCKET, version: 'test' });
  console.log('login env resolved in', Date.now() - t0, 'ms', JSON.stringify(pty.info()));
  TMUX = pty.info().tmux;

  // shell: open, output, write, resize
  const r1 = await pty.open(wc, { id: 'sh1', cmd: 'shell', cwd: '/tmp', cols: 100, rows: 30 });
  check('open shell', r1.ok && r1.created && r1.cwd === '/tmp' && !r1.cwdMissing, JSON.stringify(r1));
  check('shell prompt arrives', await waitFor(() => (out.get('sh1') || '').length > 0, 8000));
  pty.write(wc.id, 'sh1', 'echo FLOW_$((40+2))_OK; echo cols=$COLUMNS rows=$LINES term=$TERM_PROGRAM ct=$COLORTERM cc=${CLAUDECODE:-unset} tc=${CLAUDE_CODE_TMUX_TRUECOLOR:-unset}\r');
  check('write reaches the shell', await waitFor(() => strip(out.get('sh1') || '').includes('FLOW_42_OK'), 8000));
  check('size from open', await waitFor(() => strip(out.get('sh1') || '').includes('cols=100 rows=30'), 3000));
  const envLine = (strip(out.get('sh1') || '').match(/cols=\d+ rows=\d+ term=\S* ct=\S* cc=\S* tc=\S*/) || [''])[0];
  check('env: tmux TERM_PROGRAM, truecolor, no CLAUDECODE, Claude Code told tmux passes RGB', /term=tmux ct=truecolor cc=unset tc=1/.test(envLine), envLine);
  pty.resize(wc.id, 'sh1', 120, 40);
  await sleep(300);
  pty.write(wc.id, 'sh1', 'echo now=$COLUMNS"x"$LINES\r');
  check('resize reaches tmux', await waitFor(() => strip(out.get('sh1') || '').includes('now=120x40'), 3000));

  // detach keeps the session; re-open reattaches and redraws
  pty.detach(wc.id, 'sh1');
  await sleep(300);
  check('detach keeps the session', /flow_sh1: 1 windows/.test(tmuxLs()), tmuxLs().split('\n').join(' | '));
  check('no exit event for a detached client', !exits.some(([id]) => id === 'sh1'));
  out.set('sh1', '');
  const r2 = await pty.open(wc, { id: 'sh1', cmd: 'shell', cwd: '/tmp', cols: 120, rows: 40 });
  check('re-open reattaches (created false)', r2.ok && r2.created === false, JSON.stringify(r2));
  check('reattach redraws the screen', await waitFor(() => strip(out.get('sh1') || '').includes('FLOW_42_OK'), 5000));

  // second open on the same (window, id) replaces the client silently
  const r3 = await pty.open(wc, { id: 'sh1', cmd: 'shell', cols: 120, rows: 40 });
  await sleep(400);
  check('second open replaces the client without an exit event', r3.ok && !exits.some(([id]) => id === 'sh1'), JSON.stringify(exits));

  // list / exists / panes
  const ls = await pty.list();
  const mine = ls.find((s) => s.id === 'sh1');
  check('list shows flow_sh1', !!mine && mine.name === 'flow_sh1' && mine.panes === 1 && mine.created > 1e12, JSON.stringify(mine));
  check('exists true', (await pty.exists('sh1')) === true);
  check('exists false for unknown', (await pty.exists('nope')) === false);
  const p1 = await pty.panes('sh1');
  check('panes: one pane with geometry', p1.length === 1 && /^%\d+$/.test(p1[0].paneId) && p1[0].width === 120, JSON.stringify(p1));
  check('panes of a missing session is []', (await pty.panes('nope')).length === 0);

  // missing cwd falls back to home
  const r4 = await pty.open(wc, { id: 'sh2', cmd: 'shell', cwd: '/definitely/not/here', cols: 80, rows: 24 });
  check('missing cwd: home + cwdMissing', r4.ok && r4.cwdMissing === true && r4.cwd === require('os').homedir(), JSON.stringify(r4));

  // kill ends the session and the client reports exit
  await pty.kill('sh2');
  check('kill: exit event', await waitFor(() => exits.some(([id]) => id === 'sh2'), 4000), JSON.stringify(exits));
  check('kill: session gone', (await pty.exists('sh2')) === false);

  // claude: fresh session id
  fs.mkdirSync(CLAUDE_CWD, { recursive: true });
  const sid = crypto.randomUUID();
  const r5 = await pty.open(wc, { id: 'cc1', cmd: 'claude', cwd: CLAUDE_CWD, sessionId: sid, cols: 110, rows: 34 });
  check('open claude', r5.ok && r5.created && r5.cwd === CLAUDE_CWD, JSON.stringify(r5));
  const sawClaude = await waitFor(() => FIRST_SCREEN.test(strip(out.get('cc1') || '')), 30000);
  check('Claude Code draws its first screen', sawClaude, JSON.stringify(strip(out.get('cc1') || '').replace(/\s+/g, ' ').slice(0, 300)));
  const cmdline = execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', '=flow_cc1:', '-F', '#{pane_start_command}'], { encoding: 'utf8' }).trim();
  check('claude started with --session-id', cmdline.includes('--session-id ' + sid), cmdline);
  console.log(`claude check session: new ${sid} (stopped at the trust question, no prompt)`);

  // claude: resume a session this test makes itself (`claude -p /cost`, no API call; never someone else's session:
  // even without a prompt, --resume appends to its transcript)
  const own = ownSession(pty.info().claude, 'pty-resume');
  const r6 = await pty.open(wc, { id: 'cc2', cmd: 'claude', cwd: own.cwd, sessionId: own.id, resume: true, cols: 110, rows: 34 });
  check('open claude --resume', r6.ok && r6.created, JSON.stringify(r6) + ' ' + own.id);
  const cmdline2 = execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', '=flow_cc2:', '-F', '#{pane_start_command}'], { encoding: 'utf8' }).trim();
  check('claude started with --resume <own id>', cmdline2.includes('--resume ' + own.id), cmdline2);
  const pane2 = () => execFileSync(TMUX, ['-L', SOCKET, 'capture-pane', '-p', '-t', '=flow_cc2:'], { encoding: 'utf8' });
  const sawResume = await waitFor(() => FIRST_SCREEN.test(pane2()), 30000);
  check('resumed session draws its first screen', sawResume, JSON.stringify(pane2().replace(/\s+/g, ' ').trim().slice(0, 200)));

  // Fork command lines (B5) with sessions this test makes itself, killed at once: nothing is typed and Claude Code's
  // folder trust question is left unanswered.
  const parent = ownSession(pty.info().claude, 'pty-fork');
  const forked = ownFork(pty.info().claude, parent);
  const fresh = crypto.randomUUID();
  const f1 = await pty.open(wc, { id: 'fk_first', cmd: 'claude', cwd: parent.cwd, sessionId: fresh, forkFrom: parent.id, resume: true, cols: 100, rows: 30 });
  const argv1 = execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', '=flow_fk_first:', '-F', '#{pane_start_command}'], { encoding: 'utf8' }).trim();
  check('fork, first start: claude --resume <parent> --fork-session --session-id <new> in the given cwd', f1.ok && f1.cwd === parent.cwd &&
    argv1.includes(`--resume ${parent.id} --fork-session --session-id ${fresh}`), `${JSON.stringify(f1)} ${argv1}`);
  await pty.kill('fk_first');
  const f2 = await pty.open(wc, { id: 'fk_again', cmd: 'claude', cwd: parent.cwd, sessionId: forked.id, forkFrom: parent.id, resume: true, cols: 100, rows: 30 });
  const argv2 = execFileSync(TMUX, ['-L', SOCKET, 'list-panes', '-t', '=flow_fk_again:', '-F', '#{pane_start_command}'], { encoding: 'utf8' }).trim();
  check('fork, restart: a fork with its own transcript resumes it and never forks again', f2.ok && argv2.includes(`--resume ${forked.id};`) && !argv2.includes('--fork-session'), argv2);
  await pty.kill('fk_again');
  console.log(`sessions this test made: resumed ${own.id} (${own.cwd}), fork parent ${parent.id}, its fork ${forked.id} (${parent.cwd}), fork start ${fresh} (stopped at the trust question, no transcript)`);

  // Linux: node-pty forks without CLOEXEC and never marks its pty masters CLOEXEC, so without pty.js's wrapper each
  // later tmux client (and a server it starts) would hold the masters of the terminals opened before it.
  if (process.platform === 'linux') {
    const clientPids = execFileSync(TMUX, ['-L', SOCKET, 'list-clients', '-F', '#{client_pid}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const inherited = clientPids.flatMap((pid) => fdLinks(pid).filter((l) => l === '/dev/ptmx').map((l) => `${pid}: ${l}`));
    check('no tmux client holds another terminal\'s pty master', clientPids.length >= 3 && inherited.length === 0, `${clientPids.length} clients ${JSON.stringify(inherited)}`);
    const server = execFileSync(TMUX, ['-L', SOCKET, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim();
    const files = fdLinks(server).filter((l) => l.startsWith('/') && !/^\/dev\/(null|ptmx|pts\/\d+)$/.test(l));
    check('the tmux server holds no files of the process that started it', files.length === 0, `${fdLinks(server).length} fds ${JSON.stringify(files)}`);
  }

  // An unreachable ssh host (the renderer polls team panes every 1.5 s and 3 s): after a failed connection, calls fail
  // with the same error and start no ssh until the backoff has passed; the failure is logged once per streak.
  const logged = [];
  const realErr = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  const remote = { host: UNREACHABLE, attach: 'nothere' };
  const tryPanes = () => pty.panes('rt', remote).then(() => 'resolved', (e) => e.message);
  let first, second, third, afterBackoff, runs, streakLogs, retried, afterRetry;
  try {
    first = await tryPanes();
    runs = [sshRuns.length];
    second = await tryPanes();
    third = await tryPanes();
    runs.push(sshRuns.length);
    await sleep(5200);
    afterBackoff = await tryPanes();
    runs.push(sshRuns.length);
    streakLogs = logged.filter((l) => l.includes(UNREACHABLE));
    // the Mac's network is back (vmfiles.retryNow): the backoff starts over
    pty.sshRetry(UNREACHABLE);
    retried = await tryPanes();
    runs.push(sshRuns.length);
    afterRetry = await tryPanes();
    runs.push(sshRuns.length);
  } finally {
    console.error = realErr;
  }
  check('a call to an unreachable host fails with the ssh error', new RegExp(`^ssh ${UNREACHABLE}: `).test(first) && runs[0] === 1, `${first} (ssh runs ${runs[0]})`);
  check('during the backoff, calls fail with the same error and start no ssh', second === first && third === first && runs[1] === 1, `ssh runs ${runs[1]}`);
  check('after the backoff, the next call tries ssh again', afterBackoff === first && runs[2] === 2, `ssh runs ${runs[2]}`);
  check('the failure is logged once for the streak', streakLogs.length === 1, JSON.stringify(streakLogs));
  check('after sshRetry, the next call tries ssh at once', retried === first && runs[3] === 3, `${retried} (ssh runs ${runs[3]})`);
  check('and its failure backs off again, logged once as a new streak', afterRetry === first && runs[4] === 3 &&
    logged.filter((l) => l.includes(UNREACHABLE)).length === streakLogs.length + 1, `ssh runs ${runs[4]}, logged ${logged.length - streakLogs.length} more`);

  // sessionId validation
  const r7 = await pty.open(wc, { id: 'bad', cmd: 'claude', sessionId: 'not-a-uuid' });
  check('non-UUID sessionId is refused', !r7.ok && /UUID/.test(r7.error), JSON.stringify(r7));

  // MAC_NOTES 11: shutdown resolves only once every client's exit has been reported (the app quits right after).
  check('clients are running before shutdown', pty.pending());
  const t1 = Date.now();
  await pty.shutdown();
  check('shutdown resolves once every client reported its exit', !pty.pending(), `${Date.now() - t1} ms`);
  check('shutdown keeps sessions alive', /flow_cc1/.test(tmuxLs()) && /flow_cc2/.test(tmuxLs()) && /flow_sh1/.test(tmuxLs()), tmuxLs().split('\n').join(' | '));

  // A client that cannot finish its exit (its tmux server is stopped) gets SIGKILL after the timeout.
  // Both clients must be attached before the server stops: a client stopped half-way through connecting ends at the
  // first signal and never needs the SIGKILL these checks are about.
  const attached = () => execFileSync(TMUX, ['-L', SOCKET, 'list-clients', '-F', '#{client_session}'], { encoding: 'utf8' }).trim().split('\n');
  const bothAttached = () => ['flow_sh1', 'flow_cc1'].every((n) => attached().includes(n));
  await pty.open(wc, { id: 'sh1', cmd: 'shell', cols: 80, rows: 24 });
  await pty.open(wc, { id: 'cc1', cmd: 'claude', cols: 80, rows: 24 });
  check('both clients are attached before the server stops', await waitFor(bothAttached, 10000), JSON.stringify(attached()));
  const server = Number(execFileSync(TMUX, ['-L', SOCKET, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' }).trim());
  process.kill(server, 'SIGSTOP');
  const t2 = Date.now();
  try {
    await pty.shutdown(500);
  } finally {
    process.kill(server, 'SIGCONT');
  }
  const took = Date.now() - t2;
  check('with the tmux server stopped, shutdown kills the clients after the timeout and still sees every exit', !pty.pending() && took >= 500 && took < 1500, `${took} ms`);
  check('the sessions survive that too', /flow_cc1/.test(tmuxLs()) && /flow_sh1/.test(tmuxLs()), tmuxLs().split('\n').join(' | '));

  // A SIGKILL that throws must not stop shutdown. node-pty swallows kill errors itself, so its kill is patched to throw:
  // ESRCH (already gone) for sh1, EPERM for cc1. The tmux server is stopped so neither client can exit meanwhile.
  await pty.open(wc, { id: 'sh1', cmd: 'shell', cols: 80, rows: 24 });
  await pty.open(wc, { id: 'cc1', cmd: 'claude', cols: 80, rows: 24 });
  check('both clients are attached again before the server stops', await waitFor(bothAttached, 10000), JSON.stringify(attached()));
  const pids = execFileSync(TMUX, ['-L', SOCKET, 'list-clients', '-F', '#{client_session} #{client_pid}'], { encoding: 'utf8' }).trim().split('\n')
    .map((l) => l.split(' ')).reduce((m, [name, pid]) => Object.assign(m, { [Number(pid)]: name }), {});
  const { UnixTerminal } = require('node-pty/lib/unixTerminal');
  const realKill = UnixTerminal.prototype.kill;
  UnixTerminal.prototype.kill = function (signal) {
    if (signal !== 'SIGKILL') return realKill.call(this, signal);
    const code = pids[this.pid] === 'flow_sh1' ? 'ESRCH' : 'EPERM';
    throw Object.assign(new Error(`kill ${code} (test)`), { code });
  };
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  process.kill(server, 'SIGSTOP');
  let outcome;
  try {
    outcome = await pty.shutdown(300).then(() => 'resolved', (e) => `rejected: ${e.message}`);
  } finally {
    process.kill(server, 'SIGCONT');
    UnixTerminal.prototype.kill = realKill;
    console.error = realError;
  }
  check('a SIGKILL that throws does not stop shutdown: it keeps waiting and resolves', outcome === 'resolved', outcome);
  check('ESRCH is expected (already gone) and not logged; EPERM is logged', !errors.some((l) => /could not SIGKILL the tmux client of sh1/.test(l)) &&
    errors.some((l) => /could not SIGKILL the tmux client of cc1: kill EPERM \(test\)/.test(l)), JSON.stringify(errors));
  check('those clients still report their exit once the server runs again', await waitFor(() => !pty.pending(), 5000));
})().catch((e) => {
  console.error('test crashed:', e);
  crashed = true;
}).finally(async () => {
  await pty.shutdown();
  try {
    execFileSync(TMUX || 'tmux', ['-L', SOCKET, 'kill-server'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) console.error(`could not kill the ${SOCKET} tmux server: ${e.stderr || e.message}`);
  }
  console.log(crashed ? 'crashed' : failed ? `${failed} FAILED` : 'all passed');
  process.exit(crashed ? 2 : failed ? 1 : 0);
});




