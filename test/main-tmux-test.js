'use strict';
// tmux behaviour of src/pty.js that only a running server shows (orch's findings), on the socket flow-dev-main only:
// - a server started with an older conf picks up flow-tmux.conf on the next Flow start (pty.init), and nothing is
//   duplicated after three starts; with no server, a start leaves none running;
// - a VM attach window attaches with -f ignore-size, so its client never resizes the shared window: the exact command
//   line pty.js builds is read without connecting (an unresolvable host), and the flag's effect is shown on a local
//   window against a control client without it;
// - the attach client starts at the window's size plus its status lines (term.open returns size { cols, rows, status }),
//   so the window keeps its size also when Flow is its only client;
// - sessions Flow makes on a VM run on Flow's own tmux server there, with Flow's conf (sent once per run) and the folder
//   given as cwd; a flow_<id> session already on the VM's default server stays there (made before, or broken out of an
//   attach window's team); with the server not known, the VM picks it, so such a session is never started twice.
// The VM checks run on a stand-in VM: a host whose ssh commands run here, with their own HOME and two private tmux
// sockets for the VM's default server and Flow's server there.
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-tmux-test.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const nodePty = require('node-pty');

const SOCKET = 'flow-dev-main';
// The stand-in VM: what pty.js runs over ssh to this host runs here with HOME = VM_HOME, and `tmux` there reaches
// VM_DEFAULT (the VM's default server) or, given -L, VM_OWN (Flow's server on the VM).
const LOCALVM = 'flow-test.local';
const VM_ROOT = '/tmp/flow-dev-main/vm';
const VM_HOME = path.join(VM_ROOT, 'home');
const VM_BIN = path.join(VM_ROOT, 'bin');
const VM_DEFAULT = 'flow-dev-main-vm';
const VM_OWN = 'flow-dev-main-vmflow';
fs.rmSync(VM_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(VM_HOME, 'proj'), { recursive: true });
fs.mkdirSync(VM_BIN, { recursive: true });
fs.writeFileSync(path.join(VM_BIN, 'tmux'), `#!/bin/sh\nsock=${VM_DEFAULT}\nu=\nif [ "$1" = -u ]; then u=-u; shift; fi\n` +
  `if [ "$1" = -L ]; then sock=${VM_OWN}; shift 2; fi\nexec ${execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()} $u -L "$sock" "$@"\n`, { mode: 0o755 });
const onVm = (env) => ({ ...env, HOME: VM_HOME, PATH: `${VM_BIN}:${(env && env.PATH) || process.env.PATH}`, TMUX: '' });
const sshTo = (file, args) => (file === '/usr/bin/ssh' && args.includes(LOCALVM) ? args[args.length - 1] : null);
const unwrap = (file, args) => (file === '/bin/bash' && args[0] === '--posix' && args[3] === 'flow' ? [args[4], args.slice(5)] : [file, args]);
const vmCalls = [];
let failNext = null;   // a remote command matching this regexp fails once as an ssh connection failure
const realExecFile = childProcess.execFile;
childProcess.execFile = function (file, args, opts, cb) {
  const remoteCmd = sshTo(...unwrap(file, args));
  if (!remoteCmd) return realExecFile.call(this, file, args, opts, cb);
  vmCalls.push(remoteCmd);
  if (failNext && failNext.test(remoteCmd)) {
    failNext = null;
    setImmediate(() => cb(Object.assign(new Error('ssh failed'), { code: 255 }), '', `ssh: connect to host ${LOCALVM} port 22: Connection refused`));
    return { pid: 0 };
  }
  return realExecFile.call(this, '/bin/sh', ['-c', remoteCmd], { ...opts, cwd: VM_HOME, env: onVm(opts.env) }, cb);   // ssh starts in the home folder
};
// What pty.js asks node-pty to start (it calls nodePty.spawn at each open).
const spawns = [];
const realSpawn = nodePty.spawn;
nodePty.spawn = function (file, args, opts) {
  spawns.push([file, ...args, { cols: opts.cols, rows: opts.rows }]);
  const remoteCmd = sshTo(...unwrap(file, args));
  return remoteCmd ? realSpawn.call(this, '/bin/sh', ['-c', remoteCmd], { ...opts, cwd: VM_HOME, env: onVm(opts.env) }) : realSpawn.call(this, file, args, opts);
};
const pty = require('../src/pty');

const CONF = path.join(__dirname, '..', 'src', 'flow-tmux.conf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmuxOn = (socket) => (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmux = tmuxOn(SOCKET);
const vmTmux = tmuxOn(VM_DEFAULT);
const ownTmux = tmuxOn(VM_OWN);
const has = (run, name) => {
  try {
    run('has-session', '-t', '=' + name);
    return true;
  } catch (e) {
    return false;
  }
};
const serverUp = () => {
  try {
    tmux('ls');
    return true;
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
    return false;
  }
};
const killServer = () => {
  try {
    tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
  }
};
const j = (v) => JSON.stringify(v);
let failed = 0;
let crashed = false;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const wc = { id: 303, isDestroyed: () => false, send() {} };

(async () => {
  killServer();
  await pty.init({ socket: SOCKET, version: 'test' });
  check('with no server running, a Flow start starts none', !serverUp());
  // a server that is up but holds no session yet answers "no current target" (a cold start, before new-session made one)
  tmux('-f', '/dev/null', 'start-server', ';', 'set', '-g', 'exit-empty', 'off');
  const empty = await Promise.all([pty.exists('nothing'), pty.panes('nothing')]).then((r) => r, (e) => e.message);
  check('a server with no session yet counts as no session (exists false, no panes), not as an error', j(empty) === j([false, []]), j(empty));
  killServer();

  // a server from an older conf, then three Flow starts
  const old = path.join(os.tmpdir(), `flow-old-conf-${process.pid}.conf`);
  fs.writeFileSync(old, 'set -g history-limit 1234\nset -g mouse off\n');
  tmux('-f', old, 'new-session', '-d', '-s', 'flow_oldconf', 'sleep 600');
  fs.unlinkSync(old);
  check('the server started with the older conf', tmux('show', '-gv', 'history-limit') === '1234' && tmux('show', '-gv', 'mouse') === 'off');
  for (let i = 0; i < 3; i++) await pty.init({ socket: SOCKET, version: 'test' });
  const want = fs.readFileSync(CONF, 'utf8');
  const limit = (want.match(/^set -g history-limit (\d+)/m) || [])[1];
  check('after a Flow start the running server has flow-tmux.conf (history-limit, mouse)', tmux('show', '-gv', 'history-limit') === limit && tmux('show', '-gv', 'mouse') === 'on',
    `${tmux('show', '-gv', 'history-limit')} ${tmux('show', '-gv', 'mouse')}`);
  const count = (text, needle) => text.split('\n').filter((l) => l.includes(needle)).length;
  const overrides = tmux('show', '-s', 'terminal-overrides');
  const features = tmux('show', '-s', 'terminal-features');
  const hooks = tmux('show-hooks', '-gw', 'window-layout-changed');
  check('after three starts nothing is duplicated (terminal-overrides, terminal-features, the layout hook)',
    count(overrides, 'xterm-256color:Tc') === 1 && count(features, 'xterm-256color:RGB') === 1 && hooks.split('\n').filter(Boolean).length === 1,
    `Tc ${count(overrides, 'xterm-256color:Tc')}, RGB ${count(features, 'xterm-256color:RGB')}, hooks ${hooks.split('\n').filter(Boolean).length}`);
  killServer();

  // the VM attach command line, without connecting
  const r = await pty.open(wc, { id: 'vmattach', cmd: 'claude', host: 'flow-test.invalid', attach: 'ccm', cols: 80, rows: 22 });
  const ssh = (spawns.find((a) => a.includes('flow-test.invalid')) || []).slice(0, -1);
  check('a VM attach window runs tmux attach -f ignore-size over ssh', r.ok && ssh[ssh.length - 1] === "'tmux' '-u' 'attach' '-f' 'ignore-size' '-t' 'ccm'", JSON.stringify(ssh.slice(-4)));
  check('with the VM unreachable there is no size, and the client starts at the size term.js asked for', r.ok && !('size' in r) && j(spawns.find((a) => a.includes('flow-test.invalid')).at(-1)) === j({ cols: 80, rows: 22 }), j(r));
  pty.detach(wc.id, 'vmattach');

  // What the flag does, as on the VM: the owner's terminal (an unflagged 200x50 client) is attached to a window with
  // three panes, and a Flow-sized client (80x22) attaches with and without the flag. tmux only skips a flagged client's
  // size while an unflagged client is attached (resize.c, ignore_client_size).
  tmux('-f', CONF, 'new-session', '-d', '-s', 'flow_vmsize', '-x', '200', '-y', '49', 'sleep 600');
  tmux('split-window', '-d', '-h', '-t', '=flow_vmsize:', 'sleep 600');
  tmux('split-window', '-d', '-v', '-t', '=flow_vmsize:', 'sleep 600');
  const size = () => tmux('display-message', '-p', '-t', '=flow_vmsize:', '#{window_width}x#{window_height} #{window_layout}');
  const owner = realSpawn('tmux', ['-L', SOCKET, 'attach', '-t', '=flow_vmsize'], { name: 'xterm-256color', cols: 200, rows: 50, cwd: os.tmpdir(), env: { ...process.env, TMUX: '' } });
  await sleep(800);
  const before = size();
  const attach = async (flags) => {
    const c = realSpawn('tmux', ['-L', SOCKET, 'attach', ...flags, '-t', '=flow_vmsize'], { name: 'xterm-256color', cols: 80, rows: 22, cwd: os.tmpdir(), env: { ...process.env, TMUX: '' } });
    await sleep(800);
    const seen = size();
    c.kill();
    await sleep(400);
    return seen;
  };
  const withFlag = await attach(['-f', 'ignore-size']);
  check('a client attached with -f ignore-size leaves the window size and layout as they were', withFlag === before, `${before} -> ${withFlag}`);
  const control = await attach([]);
  check('control: the same client without the flag resizes the window', control.split(' ')[0] !== before.split(' ')[0], `${before} -> ${control}`);
  owner.kill();
  await sleep(400);
  const alone = await attach(['-f', 'ignore-size']);
  console.log(`info: with no other client attached, an ignore-size client still sizes the window (tmux rule): ${before.split(' ')[0]} -> ${alone.split(' ')[0]}`);

  // the real size, on the stand-in VM: session ccm with a 150x45 window
  vmTmux('-f', CONF, 'new-session', '-d', '-s', 'ccm', '-x', '150', '-y', '45', 'sleep 600');
  const ccmSize = () => vmTmux('display-message', '-p', '-t', 'ccm', '#{window_width}x#{window_height}');
  const clientSize = () => vmTmux('list-clients', '-t', 'ccm', '-F', '#{client_width}x#{client_height}');
  for (const [status, want] of [['on', { cols: 150, rows: 46, status: 1 }], ['off', { cols: 150, rows: 45, status: 0 }], ['3', { cols: 150, rows: 48, status: 3 }]]) {
    vmTmux('set', '-t', 'ccm', 'status', status);
    const v = await pty.open(wc, { id: 'vmreal', cmd: 'claude', host: LOCALVM, attach: 'ccm', cols: 80, rows: 22 });
    await sleep(1000);
    const started = spawns.filter((a) => a.includes(LOCALVM)).at(-1).at(-1);
    check(`status ${status}: term.open returns size ${j(want)}, the client starts at it, and the window keeps 150x45 with Flow as its only client`,
      v.ok && j(v.size) === j(want) && j(started) === j({ cols: want.cols, rows: want.rows }) && clientSize() === `${want.cols}x${want.rows}` && ccmSize() === '150x45',
      `${j(v.size)}, started ${j(started)}, client ${clientSize()}, window ${ccmSize()}`);
    pty.detach(wc.id, 'vmreal');
    await sleep(500);
  }
  // control: a client with the window's rows only (no row for the status line) shrinks the window
  vmTmux('set', '-t', 'ccm', 'status', 'on');
  const short = realSpawn('tmux', ['-L', VM_DEFAULT, 'attach', '-f', 'ignore-size', '-t', 'ccm'], { name: 'xterm-256color', cols: 150, rows: 45, cwd: os.tmpdir(), env: { ...process.env, TMUX: '' } });
  await sleep(800);
  const shrunk = ccmSize();
  short.kill();
  await sleep(400);
  check('control: a 150x45 client alone shrinks the 150x45 window to 150x44 (its status line takes a row)', shrunk === '150x44', shrunk);

  // sessions Flow makes on the VM: Flow's own server there (already up, from an older conf), Flow's conf, the folder given
  ownTmux('-f', '/dev/null', 'new-session', '-d', '-s', 'older', 'sleep 600');
  ownTmux('set', '-g', 'history-limit', '1234');
  const confWrites = () => vmCalls.filter((c) => c.includes('flow-tmux.conf.$$')).length;
  const n1 = await pty.open(wc, { id: 'vmnew', cmd: 'shell', host: LOCALVM, cwd: '~/proj', cols: 100, rows: 30 });
  await sleep(1200);
  check('a session Flow makes on the VM starts on Flow\'s own server there, in the folder given (~ is the VM\'s home)',
    n1.ok && n1.created && has(ownTmux, 'flow_vmnew') && !has(vmTmux, 'flow_vmnew') && ownTmux('display-message', '-p', '-t', '=flow_vmnew:', '#{pane_current_path}') === path.join(VM_HOME, 'proj'),
    `${j(n1)} ${has(ownTmux, 'flow_vmnew') ? ownTmux('display-message', '-p', '-t', '=flow_vmnew:', '#{pane_current_path}') : 'not on Flow\'s server'}`);
  const sent = path.join(VM_HOME, '.flow', 'flow-tmux.conf');
  check('Flow\'s conf is on the VM at ~/.flow/flow-tmux.conf (0600) and loaded into Flow\'s server that was already up',
    fs.existsSync(sent) && fs.readFileSync(sent, 'utf8') === fs.readFileSync(CONF, 'utf8') && (fs.statSync(sent).mode & 0o777) === 0o600 && ownTmux('show', '-gv', 'history-limit') === limit,
    `history-limit ${ownTmux('show', '-gv', 'history-limit')}`);
  await pty.open(wc, { id: 'vmnew2', cmd: 'shell', host: LOCALVM, cols: 100, rows: 30 });
  await sleep(800);
  check('the conf is sent once per run, and a session started without a folder starts in the VM\'s home', confWrites() === 1 && has(ownTmux, 'flow_vmnew2') &&
    ownTmux('display-message', '-p', '-t', '=flow_vmnew2:', '#{pane_current_path}') === VM_HOME, `${confWrites()} writes`);

  // a flow_<id> session already on the VM's default server (made before Flow had its own server there)
  vmTmux('new-session', '-d', '-s', 'flow_vmold', '-x', '90', '-y', '25', 'sleep 600');
  const o1 = await pty.open(wc, { id: 'vmold', cmd: 'shell', host: LOCALVM, cols: 90, rows: 25 });
  await sleep(1000);
  const clientsOf = (run, name) => run('list-clients', '-t', '=' + name, '-F', '#{client_name}').split('\n').filter(Boolean).length;
  check('a flow_<id> session already on the VM\'s default server is attached there, never started again on Flow\'s server',
    o1.ok && !o1.created && clientsOf(vmTmux, 'flow_vmold') === 1 && !has(ownTmux, 'flow_vmold'), j(o1));
  const oldPanes = await pty.panes('vmold', { host: LOCALVM });
  check('panes and exists find it there too', oldPanes.length === 1 && (await pty.exists('vmold', { host: LOCALVM })) === true, j(oldPanes));
  const jr = await pty.joinPane(wc.id, 'vmnew', 'vmold');
  check('joinPane refuses two terminals on different tmux servers of the VM', !jr.ok && /same tmux server/.test(jr.error), j(jr));

  // a pane broken out of an attach window's team stays on the VM's default server (a pane cannot change servers)
  vmTmux('new-session', '-d', '-s', 'teamv', '-x', '120', '-y', '30', 'sleep 600');
  vmTmux('split-window', '-d', '-t', '=teamv:', 'sleep 600');
  await pty.open(wc, { id: 'teamwin', cmd: 'claude', host: LOCALVM, attach: 'teamv', cols: 120, rows: 31 });
  const tp = await pty.panes('teamwin', { host: LOCALVM, attach: 'teamv' });
  const br = tp.length === 2 ? await pty.breakPane('teamwin', tp[1].paneId, 'mate9') : { ok: false, error: `${tp.length} panes` };
  check('a pane broken out of an attach window\'s team stays on the VM\'s default server, and Flow finds it there',
    br.ok && has(vmTmux, 'flow_mate9') && !has(ownTmux, 'flow_mate9') && (await pty.exists('mate9', { host: LOCALVM })) === true, j(br));

  // the server not known (its check failed): the VM picks it (last: the failure starts this host's ssh backoff)
  vmTmux('new-session', '-d', '-s', 'flow_vmrace', 'sleep 600');
  failNext = /has-session.*=flow_vmrace/;
  const rr = await pty.open(wc, { id: 'vmrace', cmd: 'shell', host: LOCALVM, cols: 80, rows: 24 });
  await sleep(1200);
  const raceLine = spawns.filter((x) => x.includes(LOCALVM)).at(-1).at(-2);
  check('with the server not known, the VM picks it: the session on its default server is attached, none is started on Flow\'s server',
    rr.ok && /^if /.test(raceLine) && clientsOf(vmTmux, 'flow_vmrace') === 1 && !has(ownTmux, 'flow_vmrace'), raceLine);
})().catch((e) => {
  console.error('test crashed:', e);
  crashed = true;
}).finally(async () => {
  await pty.shutdown();
  killServer();
  for (const run of [vmTmux, ownTmux]) {
    try {
      run('kill-server');
    } catch (e) {
      if (!/no server running|error connecting/.test(String(e.stderr))) console.error(`could not stop a stand-in VM server: ${e.stderr}`);
    }
  }
  fs.rmSync(VM_ROOT, { recursive: true, force: true });
  console.log(crashed ? 'crashed' : failed ? `${failed} FAILED` : 'all passed');
  process.exit(crashed ? 2 : failed ? 1 : 0);
});




