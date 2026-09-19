'use strict';

/*
 * Real node-pty lifecycle gate for the macOS pty_posix_spawn spare-master leak (MAC_NOTES 39/40).
 * Run under the Electron binary whose pty.node will ship:
 *   ELECTRON_RUN_AS_NODE=1 <electron> scripts/pty-native-lifecycle.cjs <node-pty root>
 *
 * The test never closes a PTY descriptor itself. It uses only node-pty's public lifecycle (natural exit, kill, destroy,
 * failed spawn) and asks the OS which PTY master descriptors this process owns. It stops at the first leaked cycle, so
 * an unpatched build consumes one cycle's descriptors rather than approaching the Mac's system-wide PTY limit.
 */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'node_modules', 'node-pty'));
const pty = require(root);
const nodePtyVersion = require(path.join(root, 'package.json')).version;
const platform = process.platform;
const cycles = boundedInt('FLOW_PTY_LIFECYCLE_CYCLES', 8, 8, 64);
const timeoutMs = boundedInt('FLOW_PTY_LIFECYCLE_TIMEOUT_MS', 5000, 1000, 30000);
const holdSeconds = Math.ceil(timeoutMs / 1000) + 1;

assert.ok(process.versions.electron, 'pty-native-lifecycle must run under the Electron binary whose pty.node will ship');
assert.strictEqual(nodePtyVersion, '1.1.0', `pty-native-lifecycle expected node-pty 1.1.0, got ${nodePtyVersion}`);

function boundedInt(name, fallback, min, max) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const n = Number(value);
  assert.ok(Number.isInteger(n) && n >= min && n <= max, `${name} must be an integer from ${min} to ${max}`);
  return n;
}

function procFdLinks() {
  const dir = `/proc/${process.pid}/fd`, links = [];
  for (const name of fs.readdirSync(dir)) {
    try { links.push({ fd: Number(name), target: fs.readlinkSync(path.join(dir, name)) }); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return links;
}

function linuxMasters() {
  return procFdLinks().filter(({ target }) => target === '/dev/ptmx').map(({ fd }) => fd).sort((a, b) => a - b);
}

function macMasters() {
  const r = childProcess.spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn', '/dev/ptmx'], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  });
  if (r.error) throw r.error;
  const stdout = String(r.stdout || ''), stderr = String(r.stderr || '');
  if (r.status !== 0 && !(r.status === 1 && !stdout.trim() && !stderr.trim())) {
    throw new Error(`lsof exited ${r.status}: ${stderr.trim()}`);
  }
  const masters = [];
  let fd = null;
  for (const line of stdout.split('\n')) {
    const match = /^f(\d+)/.exec(line);
    if (match) fd = Number(match[1]);
    else if (line === 'n/dev/ptmx' && fd !== null) masters.push(fd);
  }
  return [...new Set(masters)].sort((a, b) => a - b);
}

const masterFds = platform === 'darwin' ? macMasters : platform === 'linux' ? linuxMasters : null;
if (!masterFds) throw new Error(`pty-native-lifecycle: unsupported platform ${platform}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function exitOf(term) {
  return new Promise((resolve, reject) => {
    let subscription;
    const timer = setTimeout(() => {
      if (subscription) subscription.dispose();
      reject(new Error(`PTY ${term.pid} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    subscription = term.onExit((event) => {
      clearTimeout(timer);
      if (subscription) subscription.dispose();
      resolve(event);
    });
  });
}

async function settleTo(expected) {
  // The native exit event can precede the last descriptor cleanup; require two consecutive baseline readings.
  const want = expected.join(','), deadline = Date.now() + timeoutMs;
  let consecutive = 0, delay = 40, last = [];
  while (Date.now() < deadline) {
    await sleep(delay);
    last = masterFds();
    if (last.join(',') === want) {
      if (++consecutive === 2) return last;
    } else consecutive = 0;
    delay = Math.min(delay * 2, 400);
  }
  return last;
}

function spawn(command, args = []) {
  return pty.spawn(command, args, {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

async function naturalExit(i, baseline) {
  const term = spawn('/bin/sh', ['-c', i === 0 ? 'sleep 1; exit 0' : 'exit 0']);
  if (i === 0) {
    const live = masterFds();
    assert.ok(live.some((fd) => !baseline.includes(fd)),
      `descriptor detector did not see the live node-pty master; baseline ${JSON.stringify(baseline)}, live ${JSON.stringify(live)}`);
  }
  const event = await exitOf(term);
  assert.strictEqual(event.exitCode, 0, `natural exit code ${event.exitCode}`);
}

async function killedExit() {
  const term = spawn('/bin/sh', ['-c', `sleep ${holdSeconds}`]);
  const exited = exitOf(term);
  term.kill();
  await exited;
}

async function destroyedExit() {
  const term = spawn('/bin/sh', ['-c', `sleep ${holdSeconds}`]);
  const exited = exitOf(term);
  term.destroy();
  await exited;
}

async function failedSpawn() {
  const missing = path.join(process.cwd(), `.flow-missing-pty-command-${process.pid}`);
  let term;
  try {
    term = spawn(missing);
  } catch (err) {
    assert.match(String(err && err.message), /posix_spawnp failed|ENOENT|No such file|not found/i,
      'the synchronous failure should be the missing executable');
    return;
  }
  const event = await exitOf(term);
  assert.strictEqual(event.exitCode, 1, `missing executable exit code ${event.exitCode}`);
  assert.strictEqual(event.signal, 0, `missing executable signal ${event.signal}`);
}

async function phase(name, operation) {
  const start = masterFds();
  for (let i = 0; i < cycles; i++) {
    await operation(i, start);
    const end = await settleTo(start);
    assert.deepStrictEqual(end, start,
      `${name} cycle ${i + 1}: PTY masters did not return to baseline ${JSON.stringify(start)}; now ${JSON.stringify(end)}`);
  }
  console.log(`ok ${name}: ${cycles} cycles, masters ${start.length} -> ${start.length}`);
}

(async () => {
  console.log(`pty-native-lifecycle: pid ${process.pid}, platform ${platform}, node-pty ${nodePtyVersion}, cycles ${cycles}`);
  await phase('natural exit', naturalExit);
  await phase('kill', killedExit);
  await phase('destroy', destroyedExit);
  await phase('failed spawn', failedSpawn);
  console.log('pty-native-lifecycle: all lifecycle phases passed');
})().catch((err) => {
  console.error(`FAIL pty-native-lifecycle: ${err.stack || err}`);
  process.exitCode = 1;
});




