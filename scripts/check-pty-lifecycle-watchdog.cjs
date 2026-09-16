#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const wrapper = path.join(__dirname, 'pty-lifecycle-watchdog.cjs');
const run = (duration, ...args) => {
  const result = spawnSync(process.execPath, [wrapper, String(duration), ...args], {
    encoding: 'utf8', timeout: 10000,
  });
  if (result.error) throw result.error;
  assert.strictEqual(result.signal, null);
  return result;
};

(async () => {
  let result = run(120000, process.execPath, '-e', 'console.log("watchdog stdout"); console.error("watchdog stderr")');
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, 'watchdog stdout\n');
  assert.strictEqual(result.stderr, 'watchdog stderr\n');
  result = run(2000, process.execPath, '-e', 'process.exit(23)');
  assert.strictEqual(result.status, 23);
  result = run(2000, path.join(__dirname, '.missing-watchdog-command'));
  assert.strictEqual(result.status, 127);
  assert.match(result.stderr, /ENOENT/);
  for (const duration of [0, 120001]) {
    result = run(duration, process.execPath, '-e', 'console.log("must not run")');
    assert.strictEqual(result.status, 2);
    assert.strictEqual(result.stdout, '');
  }
  if (process.platform !== 'win32') {
    result = run(2000, process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")');
    assert.strictEqual(result.status, 143);
  }

  const hang = process.platform === 'win32'
    ? 'console.log("child=" + process.pid); setInterval(() => {}, 1000)'
    : 'const { spawn } = require("child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); console.log("child=" + process.pid + " descendant=" + child.pid); setInterval(() => {}, 1000)';
  result = run(2000, process.execPath, '-e', hang);
  assert.strictEqual(result.status, 124, result.stderr);
  assert.match(result.stderr, /timed out after 2000 ms/);
  assert.match(result.stdout, /child=\d+/);
  if (process.platform !== 'win32') {
    assert.match(result.stdout, /descendant=\d+/);
    for (const match of result.stdout.matchAll(/(?:child|descendant)=(\d+)/g)) {
      const deadline = Date.now() + 2000;
      for (;;) {
        const state = spawnSync('ps', ['-o', 'stat=', '-p', match[1]], { encoding: 'utf8' });
        if (state.error) throw state.error;
        if (state.status === 1 || /^\s*Z/.test(state.stdout)) break;
        assert.strictEqual(state.status, 0, state.stderr);
        assert.ok(Date.now() < deadline, `watchdog left process ${match[1]} running: ${state.stdout}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  console.log('PASS: watchdog forwards output/status, rejects invalid deadlines, and stops a hanging child/process group with exit 124');
})().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});




