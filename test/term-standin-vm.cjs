'use strict';
/* Test only: a stand-in VM for test/term-cdp.mjs, loaded into the harness app's main process with
   NODE_OPTIONS="--require <flow>/test/term-standin-vm.cjs" (see that file's header). What pty.js runs over ssh to the
   host flow-test.local runs here instead, against the tmux socket <FLOW_TMUX_SOCKET>-vm and with <userData>/vmhome
   as the VM's home folder, the same way test/main-tmux-test.js does it. No ssh connection is ever made. While
   <userData>/ps-fails exists, pty.js's /bin/ps runs time out (term-cdp's window that cannot check whether its
   conversation is open elsewhere). Every other command runs unchanged. A file renamed to <userData>/clipboard-files
   puts the paths in it (one per line) on the clipboard as a file list with their names as text, the way a Finder ⌘C
   does, and is removed. */
if (process.type === 'browser') {
  const fs = require('fs');
  const path = require('path');
  const childProcess = require('child_process');
  const nodePty = require(require.resolve('node-pty', { paths: [path.join(__dirname, '..')] }));
  const HOST = 'flow-test.local';
  const SOCKET = `${process.env.FLOW_TMUX_SOCKET || 'flow-dev-term'}-vm`;
  const VMHOME = path.join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'vmhome');
  fs.mkdirSync(VMHOME, { recursive: true });
  const onHost = (cmd) => ['/bin/sh', ['-c', `export HOME='${VMHOME}'; cd; tmux() { command tmux -L ${SOCKET} "$@"; }; ${cmd}`]];
  const sshTo = (file, args) => (file === '/usr/bin/ssh' && args.includes(HOST) ? args[args.length - 1] : null);
  /* pty.js starts every command through /bin/bash --posix -c <close fds> flow <file> <args> on Linux */
  const unwrap = (file, args) => (file === '/bin/bash' && args[0] === '--posix' && args[3] === 'flow' ? [args[4], args.slice(5)] : [file, args]);
  const PS_FAILS = path.join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'ps-fails');
  const realExecFile = childProcess.execFile;
  childProcess.execFile = function (file, args, opts, cb) {
    const [real, rest] = unwrap(file, args);
    if (real === '/bin/ps' && fs.existsSync(PS_FAILS)) return realExecFile.call(this, '/bin/sleep', ['10'], { ...opts, timeout: 50 }, cb);
    const remote = sshTo(real, rest);
    return remote ? realExecFile.call(this, ...onHost(remote), opts, cb) : realExecFile.call(this, file, args, opts, cb);
  };
  /* pty.sshSpawn (vmfiles' transfers) uses child_process.spawn; stdio stays as asked, put needs its stdin pipe */
  const realChildSpawn = childProcess.spawn;
  childProcess.spawn = function (file, args, opts) {
    const remote = Array.isArray(args) ? sshTo(...unwrap(file, args)) : null;
    return remote ? realChildSpawn.call(this, ...onHost(remote), opts) : realChildSpawn.apply(this, arguments);
  };
  const realSpawn = nodePty.spawn;
  nodePty.spawn = function (file, args, opts) {
    const remote = sshTo(...unwrap(file, args));
    return remote ? realSpawn.call(this, ...onHost(remote), { ...opts, env: { ...opts.env, TMUX: '' } }) : realSpawn.call(this, file, args, opts);
  };
  const COPIED = path.join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'clipboard-files');
  fs.watch(path.dirname(COPIED), (event, name) => {
    if (name !== path.basename(COPIED) || !fs.existsSync(COPIED)) return;
    const paths = fs.readFileSync(COPIED, 'utf8').split('\n').filter(Boolean);
    fs.rmSync(COPIED, { force: true });
    const { clipboard, ClipboardItem } = require('electron');
    const url = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
    clipboard.write([new ClipboardItem({ 'text/uri-list': paths.map(url).join('\r\n') + '\r\n', 'text/plain': paths.map((p) => path.basename(p)).join(' ') })])
      .catch((e) => console.error(`[term-standin] could not put ${paths.join(', ')} on the clipboard: ${e.message}`));
  });
}




