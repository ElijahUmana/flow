'use strict';
// Fork backend (B5) through src/pty.js with the real claude, on the isolated tmux socket flow-dev-main. Team rules: the
// test makes its own parent (`claude -p /cost`, a local command, no API call) under /home/claude/.flow-dev/main
// (trusted through /home/claude, so Claude Code opens without its folder trust question, which tests never answer) and
// forks only that; the one prompt it types goes into the fork it created (a one-word reply).
//  - bad forkFrom values fail with an error and start nothing;
//  - a fork's first start runs `claude --resume <parent> --fork-session --session-id <new>` in the parent's cwd and
//    shows the parent's conversation;
//  - after one prompt in the fork, <new>.jsonl holds it and every message of the parent; the parent is byte-identical;
//  - reopening the fork after its session ended resumes <new> instead of forking again.
// Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-fork-test.js

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const pty = require('../src/pty');
const { ownSession, TRUSTED_ROOT } = require('./main-own-session');

const SOCKET = 'flow-dev-main';
const wc = { id: 202, isDestroyed: () => false, send() {} };
const findTranscript = (sid, cwd) => require('./main-own-session').transcriptOf(sid, cwd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let crashed = false;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(250);
  }
  return fn();
}
const tmux = (...args) => execFileSync(pty.info().tmux, ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sessionExists = (name) => {
  try {
    tmux('has-session', '-t', '=' + name);
    return true;
  } catch (e) {
    return false;
  }
};
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const uuids = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).uuid).filter(Boolean);

(async () => {
  await pty.init({ socket: SOCKET, version: 'test' });
  const claude = pty.info().claude;
  const parent = ownSession(claude, 'fork-parent', TRUSTED_ROOT);
  const command = (fs.readFileSync(parent.file, 'utf8').match(/<command-name>([^<]+)<\/command-name>/) || [])[1];
  const before = md5(parent.file);
  console.log(`parent (made by this test): ${parent.id} in ${parent.cwd}`);

  // bad forkFrom values: an error, and no session
  const bad1 = await pty.open(wc, { id: 'fk_bad1', cmd: 'claude', cwd: parent.cwd, sessionId: crypto.randomUUID(), forkFrom: 'not-a-uuid', resume: true });
  check('forkFrom that is not a UUID: ok false with an error, no session', !bad1.ok && /forkFrom must be a UUID/.test(bad1.error) && !sessionExists('flow_fk_bad1'), JSON.stringify(bad1));
  const bad2 = await pty.open(wc, { id: 'fk_bad2', cmd: 'claude', cwd: parent.cwd, sessionId: crypto.randomUUID(), forkFrom: crypto.randomUUID(), resume: true });
  check('forkFrom without a transcript: ok false with an error, no session', !bad2.ok && /cannot fork: session .* has no transcript/.test(bad2.error) && !sessionExists('flow_fk_bad2'), JSON.stringify(bad2));
  const bad3 = await pty.open(wc, { id: 'fk_bad3', cmd: 'claude', cwd: parent.cwd, forkFrom: parent.id, resume: true });
  check('forkFrom without a sessionId: ok false with an error, no session', !bad3.ok && /needs the new session id/.test(bad3.error) && !sessionExists('flow_fk_bad3'), JSON.stringify(bad3));

  // first start
  const child = crypto.randomUUID();
  const opts = { id: 'fk1', cmd: 'claude', cwd: parent.cwd, sessionId: child, forkFrom: parent.id, resume: true, cols: 120, rows: 40 };
  const r1 = await pty.open(wc, opts);
  check('the fork opens', r1.ok && r1.created && r1.cwd === parent.cwd, JSON.stringify(r1));
  const start1 = tmux('list-panes', '-t', '=flow_fk1:', '-F', '#{pane_start_command}');
  check('it runs claude --resume <parent> --fork-session --session-id <new>', start1.includes(`--resume ${parent.id} --fork-session --session-id ${child}`), start1);
  const cwd1 = tmux('display-message', '-p', '-t', '=flow_fk1:', '#{pane_current_path}');
  check("in the parent's cwd", cwd1 === parent.cwd, cwd1);
  // tmux's rendered pane: Claude Code moves the cursor between words, so the raw stream has no spaces to match.
  const pane = () => tmux('capture-pane', '-p', '-J', '-t', '=flow_fk1:');
  const history = await waitFor(() => !!command && pane().includes(command), 30000);
  check("it shows the parent's conversation", history, `${command} | ${JSON.stringify(pane().split('\n').filter((l) => l.trim()).slice(-6))}`);

  // one prompt, typed into the fork this test made
  const word = 'FORKED-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  pty.write(wc.id, 'fk1', `Reply with exactly: ${word}`);
  await sleep(500);
  pty.write(wc.id, 'fk1', '\r');
  const answered = await waitFor(() => new RegExp(`●\\s*${word}`).test(pane()), 120000);
  check('the fork answers its prompt', answered, JSON.stringify(pane().split('\n').filter((l) => l.trim()).slice(-4)));
  const childFile = findTranscript(child, parent.cwd);
  await waitFor(() => fs.existsSync(childFile) && fs.readFileSync(childFile, 'utf8').includes(word), 10000);
  const childText = fs.existsSync(childFile) ? fs.readFileSync(childFile, 'utf8') : '';
  check('<new>.jsonl holds the prompt and every message of the parent', childText.includes(word) && uuids(parent.file).length > 0 && uuids(parent.file).every((u) => childText.includes(u)), childFile);
  check('<parent>.jsonl is byte-identical', md5(parent.file) === before, `${before} -> ${md5(parent.file)}`);

  // a restart resumes <new>, it does not fork again
  await pty.kill('fk1');
  await waitFor(() => !sessionExists('flow_fk1'), 5000);
  const r2 = await pty.open(wc, opts);
  const start2 = tmux('list-panes', '-t', '=flow_fk1:', '-F', '#{pane_start_command}');
  check('reopened after the session ended, it resumes <new> and does not fork', r2.ok && r2.created && start2.includes(`--resume ${child};`) && !start2.includes('--fork-session'), start2);
  check('the resumed fork shows its own conversation', await waitFor(() => pane().includes(word), 30000));
  await pty.kill('fk1');
  check('<parent>.jsonl still byte-identical', md5(parent.file) === before);
  console.log(`sessions this test made: parent ${parent.id}, fork ${child} (${parent.cwd})`);
})().catch((e) => {
  console.error('test crashed:', e);
  crashed = true;
}).finally(async () => {
  await pty.shutdown();
  try {
    execFileSync(pty.info().tmux || 'tmux', ['-L', SOCKET, 'kill-server'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) console.error(`could not kill the ${SOCKET} tmux server: ${e.stderr || e.message}`);
  }
  console.log(crashed ? 'crashed' : failed ? `${failed} FAILED` : 'all passed');
  process.exit(crashed ? 2 : failed ? 1 : 0);
});




