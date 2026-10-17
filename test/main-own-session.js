'use strict';
// Sessions main's tests make for themselves (team rule: tests only open, resume or fork their own sessions, in a cwd
// under /tmp/flow-dev-main, or under /home/claude/.flow-dev/main when Claude Code has to get past its folder trust
// question: that folder is trusted through /home/claude, and tests never answer the question). `claude -p /cost` runs
// a local command, no API call, and leaves a real transcript.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = '/tmp/flow-dev-main/sessions';
const TRUSTED_ROOT = '/home/claude/.flow-dev/main/sessions';
const transcriptOf = (id, cwd) => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'), `${id}.jsonl`);

function runCost(claude, cwd, args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ELECTRON_RUN_AS_NODE|TMUX|TMUX_PANE)$/.test(k)) delete env[k];
  execFileSync(claude, ['-p', '/cost', ...args], { cwd, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A new session in a new folder under root: { id, cwd, file }.
function ownSession(claude, tag, root = ROOT) {
  const cwd = path.join(root, `${tag}-${Date.now().toString(36)}`);
  fs.mkdirSync(cwd, { recursive: true });
  const id = crypto.randomUUID();
  runCost(claude, cwd, ['--session-id', id]);
  const file = transcriptOf(id, cwd);
  if (!fs.existsSync(file)) throw new Error(`claude -p /cost made no transcript at ${file}`);
  return { id, cwd, file };
}

// A fork of one of those, made the way Flow's first start makes it (same flags, print mode): { id, cwd, file }.
function ownFork(claude, parent, id = crypto.randomUUID()) {
  runCost(claude, parent.cwd, ['--resume', parent.id, '--fork-session', '--session-id', id]);
  const file = transcriptOf(id, parent.cwd);
  if (!fs.existsSync(file)) throw new Error(`the print-mode fork made no transcript at ${file}`);
  return { id, cwd: parent.cwd, file };
}

module.exports = { ownSession, ownFork, transcriptOf, TRUSTED_ROOT };




