'use strict';
// pty.resumeCommand (STATUS plan item 17: a copied resume command found no conversation on the Mac). Each case runs
// src/pty.js in a child process whose HOME is a fresh folder under /tmp/flow-dev-installed-resume, so the real
// ~/.claude is never read or written, and runs the command it gives in zsh against a stand-in ~/bin/claude that
// prints where it ran, its arguments and its CLAUDE_CONFIG_DIR:
//   - the claude Flow runs (~/bin/claude), in the folder the transcript names (a space in it), not the window's;
//   - CLAUDE_CONFIG_DIR from the login environment (~/.zshenv here) is in the command, and only that folder's
//     transcripts count;
//   - no transcript (the owner's 76331b72: a --session-id claude that never got a first message), or a folder-less
//     transcript and a window cwd, or a bad id, or an unreachable host;
//   - pty.holds (MAC_NOTES 26): true while a process in the window's tmux session or a child of one carries the id,
//     false once the pane's command has replaced itself without it (as Flow's zsh -ilc does when its claude exits),
//     null with no session or a bad id.
// Run under Electron's ABI:  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/main-resume-test.js

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = '/tmp/flow-dev-installed-resume';
const SID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const NONE = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const BARE = '7e8f9a0b-1c2d-4e3f-a4b5-c6d7e8f9a0b1';

function child(scenario) {
  const home = path.join(ROOT, scenario);
  const pty = require('../src/pty');
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const runIt = (command) => {
    // zsh -f: no startup files, so what the claude gets comes from the command alone
    const r = spawnSync('/bin/zsh', ['-f', '-c', command], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000 });
    return `${r.stdout}${r.stderr}`.trim();
  };
  return (async () => {
    await pty.init({ socket: 'flow-dev-installed-resume', version: 'test' });
    if (scenario === 'plain') {
      const r = await pty.resumeCommand(SID, { cwd: '~/elsewhere' });
      check('Flow\'s claude, in the transcript\'s folder (a space in it), not the window\'s', r.command === `cd ~/'x y' && ~/bin/claude --resume ${SID}`, JSON.stringify(r));
      check('the command, run in zsh, starts that claude there with --resume', runIt(r.command || 'false') === `at /tmp/flow-dev-installed-resume/plain/x y; args --resume ${SID}; config -`, runIt(r.command || 'false'));
      const bare = await pty.resumeCommand(BARE, { cwd: '~/work' });
      check('a transcript that names no folder: the window\'s, in ~ form', bare.command === `cd ~/work && ~/bin/claude --resume ${BARE}`, JSON.stringify(bare));
      const none = await pty.resumeCommand(NONE, { cwd: '~' });
      check('a --session-id claude that never got a message (no transcript): no command, and says so', !none.command && /no transcript/.test(none.error), JSON.stringify(none));
      const tm = (...a) => execFileSync('tmux', ['-L', 'flow-dev-installed-resume', ...a], { encoding: 'utf8' });
      tm('new-session', '-d', '-s', 'flow_h1', `sh -c 'sleep 600' claude --session-id ${SID}`);
      tm('new-session', '-d', '-s', 'flow_h2', `sh -c 'sleep 1; exec sleep 600' claude --session-id ${NONE}`);
      tm('new-session', '-d', '-s', 'flow_h3', `env CONV=${BARE} sh -c 'sh -c "sleep 600" claude --resume "$CONV"; sleep 600'`);
      await new Promise((r) => setTimeout(r, 2500));
      const held = { live: await pty.holds('h1', SID), exited: await pty.holds('h2', NONE), child: await pty.holds('h3', BARE), other: await pty.holds('h1', NONE),
        gone: await pty.holds('nope', SID), bad: await pty.holds('h1', 'x') };
      check('holds: the claude running, yes; exited (its shell took over), no; in a child, yes; another id, no; no session or a bad id, null',
        JSON.stringify(held) === JSON.stringify({ live: true, exited: false, child: true, other: false, gone: null, bad: null }), JSON.stringify(held));
      const bad = await pty.resumeCommand('$(touch /tmp/x)', {});
      check('a bad id: no command', !bad.command && /not a conversation id/.test(bad.error), JSON.stringify(bad));
      const far = await pty.resumeCommand(SID, { host: 'flow-test.invalid', cwd: '~' });
      check('an unreachable host: no command, and says so', !far.command && /could not be reached/.test(far.error), JSON.stringify(far));
    } else {
      const r = await pty.resumeCommand(SID, {});
      check('CLAUDE_CONFIG_DIR from the login environment goes with it', r.command === `cd ~/'x y' && CLAUDE_CONFIG_DIR=~/'alt claude' ~/bin/claude --resume ${SID}`, JSON.stringify(r));
      check('and reaches that claude when the command runs', runIt(r.command || 'false') === `at /tmp/flow-dev-installed-resume/config/x y; args --resume ${SID}; config ${home}/alt claude`, runIt(r.command || 'false'));
      const other = await pty.resumeCommand(NONE, {});
      check('a transcript only in ~/.claude does not count when CLAUDE_CONFIG_DIR points elsewhere', !other.command && /no transcript/.test(other.error), JSON.stringify(other));
    }
    return checks;
  })();
}

function setUp(scenario) {
  const home = path.join(ROOT, scenario);
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin', 'claude'), '#!/bin/sh\necho "at $(pwd); args $*; config ${CLAUDE_CONFIG_DIR:--}"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'x y'), { recursive: true });
  const dir = scenario === 'config' ? path.join(home, 'alt claude') : path.join(home, '.claude');
  const proj = path.join(dir, 'projects', '-tmp-x-y');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), [
    JSON.stringify({ type: 'summary', summary: 'a conversation' }),
    JSON.stringify({ type: 'user', cwd: path.join(home, 'x y'), sessionId: SID, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', cwd: '/somewhere/later', sessionId: SID }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(proj, `${BARE}.jsonl`), JSON.stringify({ type: 'summary', summary: 'no folder' }) + '\n');
  if (scenario === 'config') {
    fs.writeFileSync(path.join(home, '.zshenv'), 'export CLAUDE_CONFIG_DIR="$HOME/alt claude"\n');
    const plainDir = path.join(home, '.claude', 'projects', '-tmp');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, `${NONE}.jsonl`), JSON.stringify({ type: 'user', cwd: home }) + '\n');
  }
}

if (process.env.FLOW_RESUME_SCENARIO) {
  child(process.env.FLOW_RESUME_SCENARIO).then((checks) => {
    process.stdout.write(JSON.stringify(checks) + '\n');
    process.exit(0);
  }, (e) => {
    process.stdout.write(JSON.stringify([{ name: 'the case ran', ok: false, detail: e.stack || e.message }]) + '\n');
    process.exit(0);
  });
} else {
  let failed = 0;
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const scenario of ['plain', 'config']) {
    setUp(scenario);
    const env = { PATH: '/usr/bin:/bin', HOME: path.join(ROOT, scenario), ELECTRON_RUN_AS_NODE: '1', FLOW_RESUME_SCENARIO: scenario };
    const r = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', timeout: 120000 });
    let checks;
    try {
      checks = JSON.parse(String(r.stdout).trim().split('\n').pop());
    } catch (e) {
      checks = [{ name: `the ${scenario} case reported`, ok: false, detail: `${r.stdout}${r.stderr}`.slice(0, 600) }];
    }
    for (const c of checks) {
      if (!c.ok) failed++;
      console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
    }
  }
  try {
    execFileSync('tmux', ['-L', 'flow-dev-installed-resume', 'kill-server'], { stdio: 'ignore' });
  } catch (e) {
    if (e.status !== 1) console.log(`tmux cleanup: ${e.message}`);
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
}




