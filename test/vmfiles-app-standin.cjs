'use strict';
/* Test only, for test/vmfiles-app-cdp.mjs: loaded into the app's main process with NODE_OPTIONS="--require <this file>".
   No ssh process is ever started. Every ssh pty.js asks for, through child_process.spawn (sshSpawn), execFile (sshExec)
   or node-pty (terminals), is written to VMFILES_SSH_LOG as a JSON line. Only the host vmfiles-standin.invalid (a
   name that cannot resolve) is served: the exact remote command line runs in bash with <FLOW_USER_DATA>/vmhome as the
   home folder, through a relay that plays the ssh client. Killing the relay closes the session's pipes without
   signalling the command, as ending ssh does; SIGUSR1 makes it exit 255, as ssh does when the connection drops. While
   <vmhome>/.down exists, every call exits 255, as ssh does when the VM cannot be reached. Any other host is refused
   with exit 255 and nothing runs. */
if (process.type === 'browser') {
  const childProcess = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const HOST = 'vmfiles-standin.invalid';
  const VMHOME = path.join(process.env.FLOW_USER_DATA, 'vmhome');
  const LOG = process.env.VMFILES_SSH_LOG || path.join(process.env.FLOW_USER_DATA, 'ssh-attempts.log');
  const RELAY = `
const { spawn } = require('child_process');
const c = spawn('/bin/bash', ['-c', process.argv[1]], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
process.stdin.on('data', (b) => { if (!c.stdin.write(b)) { process.stdin.pause(); c.stdin.once('drain', () => process.stdin.resume()); } });
process.stdin.on('end', () => c.stdin.end());
c.stdin.on('error', () => {});
c.stdout.pipe(process.stdout);
c.stderr.pipe(process.stderr);
c.on('close', (code) => { process.exitCode = code == null ? 1 : code; process.stdin.destroy(); });
process.on('SIGUSR1', () => process.exit(255));
`;
  const REFUSED = (host) => `echo "ssh to ${host.replace(/[^A-Za-z0-9_.@:-]/g, '?')} refused by the vmfiles test" >&2; exit 255`;
  /* pty.js starts every command through /bin/bash --posix -c <close fds> flow <file> <args> on Linux */
  const unwrap = (file, args) => (file === '/bin/bash' && Array.isArray(args) && args[0] === '--posix' && args[3] === 'flow' ? [args[4], args.slice(5)] : [file, args]);
  /* The host and remote command of an ssh command line (the host follows '--' in every line pty.js builds). */
  function sshOf(file, args) {
    const [f, a] = unwrap(file, args);
    if (!(f === '/usr/bin/ssh' || path.basename(String(f)) === 'ssh') || !Array.isArray(a)) return null;
    const i = a.indexOf('--');
    return { host: i >= 0 ? a[i + 1] : a.find((x) => !String(x).startsWith('-')) || '?', remote: a[a.length - 1] };
  }
  const note = (via, host, routed) => fs.appendFileSync(LOG, JSON.stringify({ via, host, routed, at: Date.now() }) + '\n');
  note('loaded', null, false);   // so an empty log means no ssh was asked for, not that this hook never ran
  const local = (cmd) => ['/usr/bin/node', ['-e', RELAY, cmd]];
  const commandFor = (s) => (s.host !== HOST ? REFUSED(s.host)
    : fs.existsSync(path.join(VMHOME, '.down')) ? `echo "ssh: connect to host ${HOST} port 22: Connection refused" >&2; exit 255`
    : s.remote);
  const vmEnv = { HOME: VMHOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };

  const realSpawn = childProcess.spawn;
  childProcess.spawn = function (file, args, opts) {
    const s = sshOf(file, args);
    if (!s) return realSpawn.apply(this, arguments);
    note('spawn', s.host, s.host === HOST);
    return realSpawn.call(this, ...local(commandFor(s)), { ...opts, cwd: VMHOME, env: vmEnv });
  };
  const realExecFile = childProcess.execFile;
  childProcess.execFile = function (file, args, opts, cb) {
    const s = sshOf(file, args);
    if (!s) return realExecFile.apply(this, arguments);
    note('execFile', s.host, s.host === HOST);
    return realExecFile.call(this, ...local(commandFor(s)), { ...(typeof opts === 'object' ? opts : {}), cwd: VMHOME, env: vmEnv }, typeof opts === 'function' ? opts : cb);
  };
  const nodePty = require(require.resolve('node-pty', { paths: [path.join(__dirname, '..')] }));
  const realPty = nodePty.spawn;
  nodePty.spawn = function (file, args, opts) {
    const s = sshOf(file, args);
    if (!s) return realPty.call(this, file, args, opts);
    note('pty', s.host, false);
    return realPty.call(this, '/bin/sh', ['-c', REFUSED(s.host)], opts);
  };
}




