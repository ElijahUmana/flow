#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { constants } = require('os');

const [duration, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(duration);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !command) {
  console.error('usage: pty-lifecycle-watchdog.cjs <timeout-ms: 1..120000> <command> [args...]');
  process.exit(2);
}

const processGroup = process.platform !== 'win32';
const child = spawn(command, args, { stdio: 'inherit', detached: processGroup });
function stop() {
  if (!child.pid) return;
  try {
    if (processGroup) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') console.error(`pty lifecycle watchdog: could not stop child: ${err.message}`);
  }
}
const timer = setTimeout(() => {
  console.error(`pty lifecycle watchdog: timed out after ${timeoutMs} ms`);
  stop();
  process.exit(124);
}, timeoutMs);
child.once('error', (err) => {
  clearTimeout(timer);
  console.error(`pty lifecycle watchdog: ${err.message}`);
  process.exitCode = 127;
});
child.once('exit', (code, signal) => {
  clearTimeout(timer);
  process.exitCode = code === null ? 128 + (constants.signals[signal] || 0) : code;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stop();
    process.exit(128 + constants.signals[signal]);
  });
}




