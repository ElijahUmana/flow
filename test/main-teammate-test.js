'use strict';
// flow.term.teammate (src/pty.js teammate(), orch's teams item 3), on the socket flow-dev-main only:
// - a pane whose process is a Claude Code teammate (`--agent-id <name>@<team> --agent-name ... --team-name ...`, as the
//   lead starts it) gives its identity, also with a shell in between; other panes, gone panes and values that are not
//   plain names give null;
// - the session id is the newest transcript of the pane's folder whose start names that teammate and team, null while
//   there is none. Transcripts here are fixtures in this process's own HOME (Flow only reads ~/.claude, and these
//   checks never touch it); a real teammate transcript is read, read-only, to confirm the exact "key":"value" form;
// - on a VM (opts.host) the exact ssh command lines, read without connecting (an unresolvable host).
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-teammate-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const REAL_CLAUDE = path.join(os.userInfo().homedir, '.claude');
const ROOT = '/tmp/flow-dev-main/teammate';
const FAKE_HOME = path.join(ROOT, 'home');
const CWD = path.join(ROOT, 'work');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;

// What pty.js runs over ssh to the test host, answered here; everything else runs for real.
const HOST = 'flow-test.invalid';
const sshCalls = [];
const remoteAnswers = [];
let slowPs = 0;   // how many of the next local ps lookups time out, as under a heavy load
const realExecFile = childProcess.execFile;
childProcess.execFile = function (file, args, opts, cb) {
  const argv = file === '/bin/bash' && args[0] === '--posix' && args[3] === 'flow' ? args.slice(4) : [file, ...args];
  if (slowPs > 0 && argv[0] === '/bin/sh' && /^ps -ww -o args= -p /.test(argv[2] || '')) {
    slowPs--;
    setImmediate(() => cb(Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }), '', ''));
    return { pid: 0 };
  }
  if (argv[0] === '/usr/bin/ssh' && argv.includes(HOST)) {
    sshCalls.push(argv[argv.length - 1]);
    const out = remoteAnswers.shift() || '';
    setImmediate(() => cb(null, out, ''));
    return { pid: 0 };
  }
  return realExecFile.call(this, file, args, opts, cb);
};
const pty = require('../src/pty');

const SOCKET = 'flow-dev-main';
const tmux = (...args) => childProcess.execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const killServer = () => {
  try {
    tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let crashed = false;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);

const PARENT = '3f2b9c1e-0d4a-4c7e-9a51-6b8e2f7d1c90';
const mateArgs = (name, team, extra = '') => `claude --agent-id ${name}@${team} --agent-name ${name} --team-name ${team} --agent-color blue ` +
  `--parent-session-id ${PARENT} --agent-type general-purpose --model opus${extra}`;
// A teammate pane: bash keeps the teammate's arguments in its own command line while it waits.
const matePane = (name, team) => `bash -c 'sleep 600; :' ${mateArgs(name, team)}`;

// Transcript fixtures in the shape Claude Code 2.1.296 writes for a teammate (first lines of a real one).
const projects = path.join(FAKE_HOME, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
function transcript(id, name, team, ageS) {
  fs.mkdirSync(projects, { recursive: true });
  const file = path.join(projects, `${id}.jsonl`);
  const lines = [{ type: 'mode', mode: 'normal', sessionId: id },
    { type: 'user', message: { role: 'user', content: 'hello' }, cwd: CWD, sessionId: id, agentName: name, teamName: team }];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = Date.now() / 1000 - ageS;
  fs.utimesSync(file, t, t);
}

(async () => {
  killServer();
  await pty.init({ socket: SOCKET, version: 'test' });

  // the format the lookup relies on, in a real teammate transcript (read-only)
  let real = null;
  const buf = Buffer.alloc(65536);
  const headOf = (file) => {
    const fd = fs.openSync(file, 'r');
    try {
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  };
  for (const d of fs.readdirSync(path.join(REAL_CLAUDE, 'projects'))) {
    const dir = path.join(REAL_CLAUDE, 'projects', d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^[0-9a-f-]{36}\.jsonl$/.test(x))) {
      const head = headOf(path.join(dir, f));
      const m = head.match(/"agentName":"([^"]+)"[^\n]*?"teamName":"([^"]+)"|"teamName":"([^"]+)"[^\n]*?"agentName":"([^"]+)"/);
      if (m) {
        real = { file: path.join(d, f), name: m[1] || m[4], team: m[2] || m[3] };
        break;
      }
    }
    if (real) break;
  }
  check('a real teammate transcript carries "agentName":"<name>" and "teamName":"<team>" in its first 64 KB, as searched', !!real, j(real));

  transcript('11111111-1111-4111-8111-111111111111', 'alice', 'flowmain', 120);
  transcript('22222222-2222-4222-8222-222222222222', 'alice', 'flowmain', 30);
  transcript('33333333-3333-4333-8333-333333333333', 'bob', 'flowmain', 10);
  transcript('44444444-4444-4444-8444-444444444444', 'alice', 'otherteam', 5);
  fs.writeFileSync(path.join(projects, 'notes.txt'), '"agentName":"alice" "teamName":"flowmain"');

  const session = (name, cmd) => {
    tmux('-f', path.join(__dirname, '..', 'src', 'flow-tmux.conf'), 'new-session', '-d', '-s', `flow_${name}`, '-c', CWD, '-x', '120', '-y', '30', cmd);
    return tmux('display-message', '-p', '-t', `=flow_${name}:`, '#{pane_id}');
  };
  const alice = session('mate1', matePane('alice', 'flowmain'));
  // a shell running a script in between: only the child carries the teammate's arguments
  fs.writeFileSync(path.join(ROOT, 'bob.sh'), `${matePane('bob', 'flowmain')}\nsleep 1\n`);
  const bob = session('mate2', `sh ${path.join(ROOT, 'bob.sh')}`);
  const plain = session('mate3', 'sleep 600');
  const unsafe = session('mate4', `bash -c 'sleep 600; :' claude --agent-id eve@flowmain --agent-name 'e$(id)' --team-name flowmain`);
  const carol = session('mate5', matePane('carol', 'flowmain'));
  await sleep(500);

  const a = await pty.teammate('mate1', alice);
  check('a teammate pane gives its identity, folder and the newest transcript naming it and its team',
    j(a) === j({ agentId: 'alice@flowmain', name: 'alice', team: 'flowmain', color: 'blue', parentSessionId: PARENT, agentType: 'general-purpose', model: 'opus',
      cwd: CWD, sessionId: '22222222-2222-4222-8222-222222222222' }), j(a));
  const b = await pty.teammate('mate2', bob);
  check('with a shell in between, the teammate is found among the pane\'s children', !!b && b.agentId === 'bob@flowmain' && b.sessionId === '33333333-3333-4333-8333-333333333333', j(b));
  const c = await pty.teammate('mate5', carol);
  check('a teammate whose transcript is not written yet has sessionId null', !!c && c.name === 'carol' && c.sessionId === null, j(c));
  check('a pane that is not a teammate gives null', (await pty.teammate('mate3', plain)) === null);
  const e = await pty.teammate('mate4', unsafe);
  check('a value that is not a plain name is not taken (no name: null)', e === null, j(e));
  check('a gone pane and a malformed pane id give null', (await pty.teammate('mate1', '%99999')) === null && (await pty.teammate('mate1', 'x;id')) === null);
  fs.rmSync(path.join(FAKE_HOME, '.claude'), { recursive: true, force: true });
  const noDir = await pty.teammate('mate1', alice);
  check('no transcript folder at all: sessionId null', !!noDir && noDir.sessionId === null, j(noDir));

  // under a heavy load the ps lookup can take longer than its 5 s: it is asked again, up to three times
  slowPs = 2;
  const slow = await pty.teammate('mate1', alice).catch((err) => ({ error: err.message }));
  check('a ps lookup that timed out twice is asked a third time and finds the teammate', !!slow && slow.agentId === 'alice@flowmain' && slowPs === 0, j(slow));
  slowPs = 3;
  const gaveUp = await pty.teammate('mate1', alice).then((r) => `resolved ${j(r)}`, (err) => err.message);
  check('three timeouts in a row: it says so', /timed out/.test(gaveUp) && slowPs === 0, gaveUp);
  slowPs = 0;

  // on a VM: the exact command lines, answered here
  remoteAnswers.push('4242\t/home/claude/flow\n',
    `${mateArgs('gamma', 'session-b95a50b3')}\n`,
    '6e53205c-901b-4f1d-b582-8e2c270ef425.jsonl\n');
  const r = await pty.teammate('vmteam', '%7', { host: HOST, attach: 'ccm' });
  const want = [
    "'tmux' 'display-message' '-p' '-t' '%7' '#{pane_pid}\t#{pane_current_path}'",
    `'sh' '-c' 'ps -ww -o args= -p 4242; for c in $(pgrep -P 4242); do ps -ww -o args= -p "$c"; done'`,
    `'sh' '-c' 'cd "$HOME"/'\\''.claude/projects/-home-claude-flow'\\'' 2>/dev/null && ls -t | head -n 60 | while read f; do ` +
      `head -c 65536 "$f" | grep -qF '\\''"agentName":"gamma"'\\'' && head -c 65536 "$f" | grep -qF '\\''"teamName":"session-b95a50b3"'\\'' && { echo "$f"; break; }; done'`,
  ];
  check('on a VM: display-message, then ps of the pane and its children, then a read of its transcripts, over ssh', j(sshCalls) === j(want), j(sshCalls));
  check('on a VM: the teammate and its session id come back', !!r && r.agentId === 'gamma@session-b95a50b3' && r.cwd === '/home/claude/flow' &&
    r.sessionId === '6e53205c-901b-4f1d-b582-8e2c270ef425', j(r));
  sshCalls.length = 0;
  remoteAnswers.push('4242; id\t/x\n');
  check('on a VM: a pane pid that is not a number never reaches sh', (await pty.teammate('vmteam', '%7', { host: HOST, attach: 'ccm' })) === null && sshCalls.length === 1, j(sshCalls));
})().catch((err) => {
  console.error('test crashed:', err);
  crashed = true;
}).finally(async () => {
  await pty.shutdown();
  killServer();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(crashed ? 'crashed' : failed ? `${failed} FAILED` : 'all passed');
  process.exit(crashed ? 2 : failed ? 1 : 0);
});




