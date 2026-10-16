'use strict';
// src/pty.js after kill(): a claude that does not exit. A stand-in `claude` (this test's own HOME, ~/.local/bin/claude:
// a node script that ignores SIGHUP and SIGTERM) runs in a session Flow ends, on the socket flow-dev-main only:
//   - kill() keeps it as ending (it holds its conversation by its --session-id argument);
//   - a terminal opened on another conversation meanwhile starts at once;
//   - one opened on the same conversation waits 30 s, then pty sends SIGTERM, then SIGKILL 5 s later, and only after
//     the old one has gone starts its own claude there; each signal is logged.
//   - Claude Code's teammates (orch F3), which write no ~/.claude/sessions/<pid>.json and have no conversation argument:
//     one ended is kept as ending while it exits, and its conversation reopened at once starts only after it has gone;
//     a live one's conversation opened in another window is refused; one ended outside pty is found by its conversation
//     and waited for; one that ignores the hangup and TERM gets both after 30 s, still known by its --agent-id;
//   - a claude Flow ended whose environment shows no TMUX (as while it exits) is waited for, not refused as outside Flow.
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-ending-test.js

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = '/tmp/flow-dev-main/ending';
const HOME = path.join(ROOT, 'home');
const CWD = path.join(ROOT, 'work');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, '.local', 'bin'), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
// without one, zsh -i stops at its first-run menu
fs.writeFileSync(path.join(HOME, '.zshrc'), '');
// For a conversation marked with ~/no-tmux-<id>, the stand-in also starts a child on it with no TMUX in its environment,
// as a claude shows while it exits, and both go 3 s after the hangup.
fs.writeFileSync(path.join(HOME, '.local', 'bin', 'claude'),
  "#!/usr/bin/env node\nconst a = process.argv;\nconst sid = a.includes('--session-id') ? a[a.indexOf('--session-id') + 1] : '';\n" +
  "const marked = !!sid && require('fs').existsSync(`${process.env.HOME}/no-tmux-${sid}`);\n" +
  "if (marked && process.env.TMUX) { const env = { ...process.env }; delete env.TMUX; require('child_process').spawn(process.execPath, [__filename, ...a.slice(2)], { env, stdio: 'ignore' }); }\n" +
  "process.on('SIGHUP', () => { if (marked) setTimeout(() => process.exit(0), 3000); });\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
// a teammate as Claude Code starts one: the pane's own process, --agent-id <name>@<team>; it exits 6 s after the hangup,
// as Claude Code can take a while, and with --stays only a KILL ends it
const MATE_BIN = path.join(HOME, '.local', 'share', 'claude', 'versions', '2.1.296');
fs.mkdirSync(path.dirname(MATE_BIN), { recursive: true });
fs.writeFileSync(MATE_BIN, "#!/usr/bin/env node\nconst stays = process.argv.includes('--stays');\n" +
  "process.on('SIGHUP', () => { if (!stays) setTimeout(() => process.exit(0), 6000); });\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
const TEAM = `team-f3-${process.pid}`;
process.env.HOME = HOME;
const pty = require('../src/pty');

const SOCKET = 'flow-dev-main';
const wc = { id: 303, isDestroyed: () => false, send() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.join(' ')); realError(...a); };
let failed = 0;
let crashed = false;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const killServer = () => {
  try {
    tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
  }
};
// the stand-in node processes themselves (the zsh around each has the same words in its command line)
const stand = (id) => execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' }).split('\n')
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
const psLines = () => execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' }).split('\n');
const pidOf = (l) => Number(l.trim().split(/\s+/)[0]);
// its transcript names it, as a teammate's user lines do
const mateTranscript = (sid, name) => {
  const dir = path.join(HOME, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', agentName: name, teamName: TEAM, sessionId: sid, cwd: CWD, message: { role: 'user', content: 'hi' } }) + '\n');
};
const startMate = (id, name, ...more) => tmux('new-session', '-d', '-s', `flow_${id}`, '-c', CWD, '-x', '80', '-y', '24',
  [MATE_BIN, '--agent-id', `${name}@${TEAM}`, '--agent-name', name, '--team-name', TEAM, '--agent-color', 'blue', '--agent-type', 'general-purpose', ...more].join(' '));
const mateOf = (name) => psLines().filter((l) => /^\s*\d+\s+node\s/.test(l) && l.includes(MATE_BIN) && l.includes(`--agent-id ${name}@${TEAM}`)).map(pidOf);
const resumes = (sid) => psLines().filter((l) => /^\s*\d+\s+node\s/.test(l) && l.includes(path.join(HOME, '.local', 'bin', 'claude')) &&
  new RegExp(`--(resume|session-id) ${sid}(\\s|$)`).test(l)).map(pidOf);
// counts the 200 ms samples in which the teammate and a claude on its conversation both run
const overlap = (matePid, sid) => {
  const o = { both: 0, stop: false };
  (async () => { while (!o.stop) { if (alive(matePid) && resumes(sid).length) o.both++; await sleep(200); } })();
  return o;
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
  const y = crypto.randomUUID();
  const r1 = await pty.open(wc, { id: 'end1', cmd: 'claude', cwd: CWD, sessionId: x, cols: 80, rows: 24 });
  const old = await waitFor(() => stand(x)[0], 15000);
  check('the stand-in claude runs in its session', r1.ok && !!old, JSON.stringify({ r1, old }));

  await pty.kill('end1');
  check('after kill() it is still running (it ignores the hangup) and is kept as ending', alive(old) && pty.isEnding(old), `alive ${alive(old)}, ending ${pty.isEnding(old)}`);

  const t0 = Date.now();
  const r3 = await pty.open(wc, { id: 'end3', cmd: 'claude', cwd: CWD, sessionId: y, cols: 80, rows: 24 });
  check('a terminal on another conversation starts at once', r3.ok && Date.now() - t0 < 5000 && alive(old), `${Date.now() - t0} ms`);

  const t1 = Date.now();
  const r2 = await pty.open(wc, { id: 'end2', cmd: 'claude', cwd: CWD, sessionId: x, resume: true, cols: 80, rows: 24 });
  const took = Date.now() - t1;
  const fresh = await waitFor(() => stand(x).find((pid) => pid !== old), 15000);
  check('one on the same conversation starts after 30 s, a TERM and a KILL, once the old one has gone',
    r2.ok && took >= 34000 && took < 45000 && !alive(old) && !!fresh, `${took} ms, old ${alive(old) ? 'alive' : 'gone'}, new ${fresh}`);
  const sigs = logged.filter((l) => /the claude of an ended session \(process \d+\) is still running; sending SIG(TERM|KILL)/.test(l));
  check('both signals are logged with the process', sigs.length === 2 && sigs.every((l) => l.includes(`process ${old}`)) && /SIGTERM/.test(sigs[0]) && /SIGKILL/.test(sigs[1]), JSON.stringify(sigs));

  // teammates: ended, then reopened at once on their own conversation, as an undo and a click do
  const tSid = crypto.randomUUID();
  mateTranscript(tSid, 'tango');
  startMate('mate1', 'tango');
  const tango = await waitFor(() => mateOf('tango')[0], 15000);
  await pty.kill('mate1');
  check('a teammate ended with kill() is kept as ending while it exits', !!tango && alive(tango) && pty.isEnding(tango), `pid ${tango}, ending ${!!tango && pty.isEnding(tango)}`);
  const o1 = overlap(tango, tSid);
  const t2 = Date.now();
  const rt = await pty.open(wc, { id: 'mate1', cmd: 'claude', cwd: CWD, sessionId: tSid, resume: true, cols: 80, rows: 24 });
  const tookT = Date.now() - t2;
  const newT = await waitFor(() => resumes(tSid)[0], 15000);
  await sleep(500);
  o1.stop = true;
  check('its conversation reopened at once starts only after the teammate has exited, never beside it', rt.ok && !!newT && o1.both === 0 && !alive(tango),
    `${tookT} ms, ${o1.both} samples with both, new ${newT}`);

  const lSid = crypto.randomUUID();
  mateTranscript(lSid, 'lima');
  startMate('mate2', 'lima');
  const lima = await waitFor(() => mateOf('lima')[0], 15000);
  const rl = await pty.open(wc, { id: 'other2', cmd: 'claude', cwd: CWD, sessionId: lSid, resume: true, cols: 80, rows: 24 });
  await sleep(1500);
  check('a live teammate\'s conversation opened in another window starts no second claude: it is open in another Flow window',
    !!lima && !rl.ok && rl.retry === true && /another Flow window/.test(rl.error || '') && resumes(lSid).length === 0 && alive(lima), JSON.stringify(rl));

  const mSid = crypto.randomUUID();
  mateTranscript(mSid, 'mike');
  startMate('mate3', 'mike');
  const mike = await waitFor(() => mateOf('mike')[0], 15000);
  tmux('kill-session', '-t', '=flow_mate3');
  const o3 = overlap(mike, mSid);
  const rm = await pty.open(wc, { id: 'mate3', cmd: 'claude', cwd: CWD, sessionId: mSid, resume: true, cols: 80, rows: 24 });
  const newM = await waitFor(() => resumes(mSid)[0], 15000);
  await sleep(500);
  o3.stop = true;
  check('one ended outside pty is found by its conversation: its conversation starts only after it has exited', !!mike && rm.ok && !!newM && o3.both === 0 && !alive(mike),
    `${o3.both} samples with both, new ${newM}`);

  const nSid = crypto.randomUUID();
  mateTranscript(nSid, 'november');
  startMate('mate4', 'november', '--stays');
  const nov = await waitFor(() => mateOf('november')[0], 15000);
  await pty.kill('mate4');
  const t4 = Date.now();
  const rn = await pty.open(wc, { id: 'mate4', cmd: 'claude', cwd: CWD, sessionId: nSid, resume: true, cols: 80, rows: 24 });
  const tookN = Date.now() - t4;
  const newN = await waitFor(() => resumes(nSid)[0], 15000);
  const sigN = logged.filter((l) => l.includes(`(process ${nov})`) && /sending SIG(TERM|KILL)/.test(l));
  check('one that ignores the hangup and TERM is still known by its --agent-id after 30 s: TERM, KILL, then its conversation starts',
    !!nov && rn.ok && tookN >= 34000 && !alive(nov) && !!newN && sigN.length === 2, `${tookN} ms, ${JSON.stringify(sigN)}`);

  const zSid = crypto.randomUUID();
  fs.writeFileSync(path.join(HOME, `no-tmux-${zSid}`), '');
  const rz = await pty.open(wc, { id: 'end4', cmd: 'claude', cwd: CWD, sessionId: zSid, cols: 80, rows: 24 });
  // the stand-in and its child (started as process.execPath, so its command line is node's full path)
  const both = () => psLines().filter((l) => /^\s*\d+\s+\S*node\s/.test(l) && l.includes(path.join(HOME, '.local', 'bin', 'claude')) && l.includes(`--session-id ${zSid}`)).map(pidOf);
  const zs = await waitFor(() => (both().length === 2 ? both() : null), 15000);
  const noTmux = !!zs && zs.filter((pid) => !fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').some((v) => v.startsWith('TMUX='))).length === 1;
  await pty.kill('end4');
  const t5 = Date.now();
  const rz2 = await pty.open(wc, { id: 'end4', cmd: 'claude', cwd: CWD, sessionId: zSid, resume: true, cols: 80, rows: 24 });
  const tookZ = Date.now() - t5;
  check('a claude Flow ended whose environment shows no TMUX is waited for, not refused as outside Flow',
    rz.ok && noTmux && rz2.ok && tookZ >= 2000 && zs.every((pid) => !alive(pid)), `${tookZ} ms, ${JSON.stringify(rz2)}, no TMUX in one of ${JSON.stringify(zs)}: ${noTmux}`);
})().catch((err) => {
  console.log('test crashed:', err);
  crashed = true;
}).finally(async () => {
  await pty.shutdown();
  killServer();
  // the stand-ins ignore the hangup and TERM
  for (const bin of [path.join(HOME, '.local', 'bin', 'claude'), MATE_BIN]) {
    try {
      execFileSync('pkill', ['-KILL', '-f', bin], { stdio: 'ignore' });
    } catch (e) {
      if (e.status !== 1) throw e; // 1: none left
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(crashed ? 'crashed' : failed ? `${failed} FAILED` : 'all passed');
  process.exit(crashed ? 2 : failed ? 1 : 0);
});




