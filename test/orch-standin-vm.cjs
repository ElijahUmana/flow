'use strict';
/* Test only: orch's stand-in VM for checking "runs on the VM" in the whole app, loaded into the app's main process with
   NODE_OPTIONS="--require <flow>/test/orch-standin-vm.cjs". What pty.js runs over ssh to the host flow-test.local runs
   here instead, with HOME=/tmp/flow-dev-orch/vmhome and the tmux in /tmp/flow-dev-orch/vmbin first on PATH, which sends
   Flow's own socket there to flow-dev-orch-vmflow and the VM's default server to flow-dev-orch-vmdefault. No ssh
   connection is ever made, and nothing reaches this machine's default tmux server. Every other command runs unchanged. */
if (process.type === 'browser') {
  const path = require('path');
  const childProcess = require('child_process');
  const nodePty = require(require.resolve('node-pty', { paths: [process.env.ORCH_ROOT || path.join(__dirname, '..')] }));
  const HOST = 'flow-test.local';
  const VM_HOME = '/tmp/flow-dev-orch/vmhome';
  const VM_BIN = '/tmp/flow-dev-orch/vmbin';
  const onVm = (env) => ({ ...env, HOME: VM_HOME, PATH: `${VM_BIN}:${(env && env.PATH) || '/usr/bin:/bin'}`, TMUX: '', TMUX_PANE: '' });
  const sshTo = (file, args) => (file === '/usr/bin/ssh' && args.includes(HOST) ? args[args.length - 1] : null);
  /* pty.js starts every command through /bin/bash --posix -c <close fds> flow <file> <args> on Linux */
  const unwrap = (file, args) => (file === '/bin/bash' && args[0] === '--posix' && args[3] === 'flow' ? [args[4], args.slice(5)] : [file, args]);
  const realExecFile = childProcess.execFile;
  childProcess.execFile = function (file, args, opts, cb) {
    const remote = sshTo(...unwrap(file, args));
    if (!remote) return realExecFile.call(this, file, args, opts, cb);
    return realExecFile.call(this, '/bin/bash', ['-c', remote], { ...opts, cwd: VM_HOME, env: onVm(opts && opts.env) }, cb);
  };
  const realSpawn = nodePty.spawn;
  nodePty.spawn = function (file, args, opts) {
    const remote = sshTo(...unwrap(file, args));
    if (!remote) return realSpawn.call(this, file, args, opts);
    return realSpawn.call(this, '/bin/bash', ['-c', remote], { ...opts, cwd: VM_HOME, env: onVm(opts.env) });
  };
}




