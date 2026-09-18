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
