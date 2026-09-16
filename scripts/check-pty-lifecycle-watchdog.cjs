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
