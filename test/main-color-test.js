'use strict';
// Claude Code inside Flow's tmux must draw in truecolor (STATUS: the orange box showed khaki).
// Claude Code clamps chalk to 256 colors whenever $TMUX is set unless CLAUDE_CODE_TMUX_TRUECOLOR is set;
// this test opens a real Claude Code (fresh --session-id, no prompt is submitted) through src/pty.js and
// counts the SGR color forms in what reaches the terminal. Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-color-test.js
// Uses only the tmux socket flow-dev-main and kills that server at the end.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pty = require('../src/pty');

const SOCKET = 'flow-dev-main';
let raw = '';
const wc = { id: 201, isDestroyed: () => false, send(channel, _id, data) { if (channel === 'term:data') raw += data; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const tmux = (...args) => execFileSync(pty.info().tmux, ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();

function processEnv(pid) {
  if (process.platform === 'linux') {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  }
  // macOS: ps shows the environment of the user's own processes after the arguments.
  return execFileSync('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).split(' ');
}

(async () => {
  await pty.init({ socket: SOCKET, version: 'test' });
  const id = 'color' + process.pid;
  const sid = crypto.randomUUID();
  // Team rule: real claude in tests runs under /tmp/flow-dev-main; Claude Code shows its folder trust question there.
  fs.mkdirSync('/tmp/flow-dev-main/claude-check', { recursive: true });
  const r = await pty.open(wc, { id, cmd: 'claude', cwd: '/tmp/flow-dev-main/claude-check', sessionId: sid, cols: 120, rows: 36 });
  check('open claude', r.ok && r.created, JSON.stringify(r));
  const end = Date.now() + 30000;
  while (Date.now() < end && !/Claude Code|Welcome|Free Code/.test(raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''))) await sleep(200);
  await sleep(2500);   // let the first full frame draw
  const rgb = (raw.match(/\x1b\[(?:[0-9;]*;)?38;2;\d+;\d+;\d+/g) || []).length;
  const indexed = (raw.match(/\x1b\[(?:[0-9;]*;)?38;5;\d+/g) || []).length;
  // The logo's orange (a trusted folder) or the trust question's warning amber (an untrusted one, as under
  // /tmp/flow-dev-main): exact theme colors that the 256-color clamp turns into palette indexes (the orange became 174).
  const orange = /38;2;215;119;87/.test(raw);
  const amber = /38;2;255;193;7/.test(raw);
  console.log(`foreground colors in the first frame: ${rgb} truecolor (38;2), ${indexed} 256-color (38;5); logo orange rgb(215,119,87): ${orange ? 'present' : 'absent'}, warning amber rgb(255,193,7): ${amber ? 'present' : 'absent'}`);
  check('Claude Code draws truecolor', rgb > 0 && indexed === 0);
  check('a Claude Code theme color arrives as exact RGB (logo orange 215,119,87 or warning amber 255,193,7)', orange || amber);

  // The claude process itself: find it under the pane's shell and read its environment.
  const panePid = tmux('display-message', '-p', '-t', `=flow_${id}:`, '#{pane_pid}');
  const claudePid = execFileSync('/usr/bin/pgrep', ['-P', panePid], { encoding: 'utf8' }).trim().split('\n')[0];
  const env = processEnv(claudePid);
  const pick = (k) => (env.find((e) => e.startsWith(k + '=')) || `${k} unset`);
  console.log(`claude pid ${claudePid}: ${pick('TMUX').replace(/=.*/, '=set')} ${pick('COLORTERM')} ${pick('CLAUDE_CODE_TMUX_TRUECOLOR')}`);
  check('claude runs with CLAUDE_CODE_TMUX_TRUECOLOR=1', env.includes('CLAUDE_CODE_TMUX_TRUECOLOR=1'));

  await pty.kill(id);
  pty.shutdown();
  try {
    tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(2);
});




