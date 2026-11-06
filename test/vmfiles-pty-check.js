'use strict';
// sshSpawn in pty.js (test/vmfiles-pty.patch) without reaching any host: a name that cannot resolve fails at once with
// exit 255, as an unreachable VM does. Run under Electron's ABI, on src/pty.js or on a patched copy:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/vmfiles-pty-check.js [pty.js]

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { execFileSync } = childProcess;

// every ssh pty.js starts (on Linux through /bin/bash --posix -c <close fds> flow <file> <args>)
let sshRuns = 0;
for (const k of ['execFile', 'spawn']) {
  const real = childProcess[k];
  childProcess[k] = function (file, args, ...rest) {
    if ([file, ...(Array.isArray(args) ? args : [])].some((x) => typeof x === 'string' && /(^|\/)ssh$/.test(x))) sshRuns++;
    return real.call(this, file, args, ...rest);
  };
}
const pty = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'pty.js')));

let failed = 0;
const check = (name, cond, extra) => {
  const pass = cond === true;   // only true passes: anything else says what it was
  const gave = pass || cond === false ? '' : ` [gave ${cond === null ? 'null' : typeof cond}, not true]`;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${gave}${extra ? '  ' + extra : ''}`);
  if (!pass) failed++;
};
const closed = (child) => new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
async function thrown(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e.message;
  }
}

(async () => {
  await pty.init({ socket: 'flow-dev-vmfiles', version: 'test' });
  check('pty exports sshExec and sshSpawn', typeof pty.sshSpawn === 'function' && typeof pty.sshExec === 'function');

  const a = 'flow-test-a.invalid';
  const child = await pty.sshSpawn(a, ['sh', '-c', 'echo hi'], {});
  const args = child.spawnargs;
  check('sshSpawn runs ssh with sshExec\'s options', args.includes('BatchMode=yes') && args.includes('ControlMaster=auto') &&
    args.some((x) => x.startsWith('ControlPath=')) && args.includes('ControlPersist=120'), args.slice(-8).join(' '));
  check('the remote command is one quoted string after --', args[args.length - 1] === "'sh' '-c' 'echo hi'" && args[args.length - 3] === '--');
  check('stdin is closed unless asked for', child.stdin === null);
  const end = await closed(child);
  check('an unreachable host ends with 255', end.code === 255, JSON.stringify(end));
  const runs = sshRuns;
  const off = await thrown(() => pty.sshSpawn(a, ['true']));
  check('then sshSpawn backs off without starting ssh', !!off && off.startsWith(`ssh ${a}:`) && sshRuns === runs, `${off}, ssh runs ${sshRuns - runs}`);
  const exOff = await thrown(() => pty.sshExec(a, ['true']));
  check('and sshExec shares that backoff', runs > 0 && !!off && exOff === off && sshRuns === runs, `${exOff}, ssh runs before ${runs}, during ${sshRuns - runs}`);

  // ssh to a name that cannot resolve may fail by itself before kill() lands (busy machine): try fresh names until a
  // kill ends one, then check that host has no backoff.
  let stdinPipe = false;
  let k = null;
  let again = null;
  for (let i = 0; i < 5 && !(k && k.signal); i++) {
    const b = `flow-test-b${i}.invalid`;
    const killed = await pty.sshSpawn(b, ['sleep', '5'], { stdin: true });
    stdinPipe = stdinPipe || (!!killed.stdin && typeof killed.stdin.write === 'function');
    killed.kill();
    k = await closed(killed);
    if (k.signal) {
      again = await thrown(async () => {
        const c = await pty.sshSpawn(b, ['true']);
        c.kill();
        await closed(c);
      });
    }
  }
  check('stdin is a pipe when asked for', stdinPipe);
  check('a process ended with kill() starts no backoff', !!k && k.code === null && k.signal === 'SIGTERM' && again === null, `${JSON.stringify(k)} ${again}`);

  check('a host starting with - is refused', ((await thrown(() => pty.sshSpawn('-oProxyCommand=x', ['true']))) || '').startsWith('invalid ssh host'));

  // The exact command line ssh would send, run by bash -c as sshd runs it: every hostile argument comes back as it was
  // and none of them runs (running one leaves a file in the scratch folder).
  const hostile = ['-rf', '--help', '$(touch sentinel1)', '`touch sentinel2`', '; touch sentinel3 #', "' ; touch sentinel4 ; '",
    'back\\slash', '%s%n', '-n $(touch sentinel5) "', '\nnewline', '*', '~', '$HOME', '!!'];
  const q = await pty.sshSpawn('flow-test-c.invalid', ['printf', '%s\\0', ...hostile]);
  const line = q.spawnargs[q.spawnargs.length - 1];
  q.kill();
  await closed(q);
  const dir = fs.mkdtempSync('/home/claude/.flow-dev/vmfiles/quote-');
  fs.writeFileSync(path.join(dir, 'a-file-for-the-glob'), '');
  const out = execFileSync('/bin/bash', ['-c', line], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: dir } }).toString();
  const made = fs.readdirSync(dir).filter((f) => f !== 'a-file-for-the-glob');
  fs.rmSync(dir, { recursive: true });
  check('every remote argument is quoted: bash -c gives each hostile name back and runs none of them',
    out === hostile.map((h) => h + '\0').join('') && !made.length, JSON.stringify({ out: out.split('\0'), made }));
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});




