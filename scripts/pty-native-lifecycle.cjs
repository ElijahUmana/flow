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
