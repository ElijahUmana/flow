#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const dependencies = fs.realpathSync(process.argv[3] || path.join(root, 'node_modules'));
const before = '5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6';
const after = '98745ebe4f278afeb528021060dfdf42ac4dfd820620afaca4824435d6f09422';
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.strictEqual(result.signal, null, `${command} terminated by ${result.signal}`);
  return result;
};
const pass = (result) => assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
const electronExecutable = path.join('electron/dist', fs.readFileSync(path.join(dependencies, 'electron/path.txt'), 'utf8').trim());
const observedFiles = [
  '.package-lock.json', '.bin/electron', '.bin/electron-packager',
  'electron/package.json', 'electron/dist/version', electronExecutable,
  'electron-packager/package.json', 'electron-packager/bin/electron-packager.js',
  'node-pty/package.json', 'node-pty/src/unix/pty.cc', 'node-pty/build/Release/pty.node',
  'node-pty/prebuilds/darwin-arm64/pty.node',
];
const snapshot = (directory) => Object.fromEntries(observedFiles.map((relative) => [relative, hash(path.join(directory, relative))]));
const originalDependencies = snapshot(dependencies);
console.log(`dependency source: ${dependencies}`);
console.log(`source package.json SHA256: ${hash(path.join(root, 'package.json'))}; package-lock.json: ${fs.existsSync(path.join(root, 'package-lock.json')) ? 'present' : 'absent'}`);
for (const [relative, sha] of Object.entries(originalDependencies)) console.log(`before-copy ${sha}  ${relative}`);
for (const name of ['electron', 'electron-packager', 'node-pty']) {
  console.log(`dependency version: ${name} ${JSON.parse(fs.readFileSync(path.join(dependencies, name, 'package.json'), 'utf8')).version}`);
}
const temporary = fs.mkdtempSync(path.join(root, '.pty-shipped-closure-'));
try {
  const shipped = path.join(temporary, 'shipped');
  fs.mkdirSync(shipped);
  for (const entry of ['src', 'scripts', 'native', 'package.json']) {
    fs.cpSync(path.join(root, entry), path.join(shipped, entry), { recursive: true });
  }
  pass(run('cp', ['-a', dependencies, path.join(shipped, 'node_modules')], temporary));
  const makeWritable = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    fs.chmodSync(entry, stat.mode | (stat.isDirectory() ? 0o700 : 0o200));
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) makeWritable(path.join(entry, child));
    }
  };
  makeWritable(shipped);
  assert.ok(!fs.lstatSync(path.join(shipped, 'node_modules')).isSymbolicLink());
  for (const binary of ['electron', 'electron-packager']) {
    const relative = path.join('.bin', binary);
    const originalLink = fs.readlinkSync(path.join(dependencies, relative));
    assert.strictEqual(fs.readlinkSync(path.join(shipped, 'node_modules', relative)), originalLink);
    assert.ok(fs.realpathSync(path.join(shipped, 'node_modules', relative)).startsWith(path.join(shipped, 'node_modules') + path.sep));
    console.log(`ok copied internal link: ${relative} -> ${originalLink}`);
  }
  const copiedDependencies = snapshot(path.join(shipped, 'node_modules'));
  assert.deepStrictEqual(copiedDependencies, originalDependencies, 'dependency hashes changed while copying');
  assert.deepStrictEqual(snapshot(dependencies), originalDependencies, 'source dependencies changed while copying');
  for (const [relative, sha] of Object.entries(copiedDependencies)) console.log(`after-copy ${sha}  ${relative}`);
  assert.deepStrictEqual(fs.readdirSync(shipped).sort(), ['native', 'node_modules', 'package.json', 'scripts', 'src']);
  const source = path.join(shipped, 'node_modules/node-pty/src/unix/pty.cc');
  const manifest = path.join(shipped, 'node_modules/node-pty/package.json');
  const apply = path.join(shipped, 'scripts/apply-node-pty-patch.cjs');
  const patch = path.join(shipped, 'scripts/node-pty-darwin-fd-cleanup.patch');
  const cleanup = path.join(shipped, 'scripts/node-pty-darwin-cleanup.py');
  const lifecycle = path.join(shipped, 'scripts/pty-native-lifecycle.cjs');
  const watchdog = path.join(shipped, 'scripts/pty-lifecycle-watchdog.cjs');
  const watchdogCheck = path.join(shipped, 'scripts/check-pty-lifecycle-watchdog.cjs');
  const packageScript = fs.readFileSync(path.join(shipped, 'scripts/package.sh'), 'utf8');
  const rebuildScript = fs.readFileSync(path.join(shipped, 'scripts/rebuild-node-pty-darwin.sh'), 'utf8');
  const oldNewScript = fs.readFileSync(path.join(shipped, 'scripts/test-node-pty-old-new-darwin.sh'), 'utf8');
  const inputs = new Set(['package.json', 'scripts/node-pty-darwin-fd-cleanup.patch', 'scripts/check-pty-lifecycle-watchdog.cjs']);
  for (const [name, text] of [['package.sh', packageScript], ['rebuild-node-pty-darwin.sh', rebuildScript]]) {
    pass(run('/bin/bash', ['-n', path.join(shipped, 'scripts', name)], shipped));
    assert.ok(!/\$ROOT\/(?:test|patches|build)\//.test(text), `${name} uses an unshipped directory`);
    for (const match of text.matchAll(/\$ROOT\/([A-Za-z0-9_.\/-]+)/g)) {
      const relative = match[1];
      const top = relative.split('/')[0];
      assert.ok(['src', 'scripts', 'native', 'package.json', 'node_modules', 'dist', 'evidence'].includes(top),
        `${name} uses an unshipped path: ${relative}`);
      if (['src', 'scripts', 'native', 'package.json'].includes(top)) inputs.add(relative);
      if (top === 'evidence') assert.ok(text.includes('mkdir -p "$ROOT/evidence"'), `${name} does not create its evidence output directory`);
    }
    const shaFunction = text.match(/^sha256\(\) \{\n[\s\S]*?^\}/m);
    assert.ok(shaFunction, `${name} is missing portable SHA256 selection`);
    const normal = run('/bin/bash', ['-c', `${shaFunction[0]}\nsha256 "$1"`, 'sha256', source], shipped);
    pass(normal);
    assert.strictEqual(normal.stdout.split(/\s+/)[0], hash(source));
    const shasumOnly = path.join(temporary, name + '-shasum-only');
    fs.mkdirSync(shasumOnly);
    const shasum = run('/bin/bash', ['-c', 'command -v shasum'], shipped);
    pass(shasum);
    fs.symlinkSync(shasum.stdout.trim(), path.join(shasumOnly, 'shasum'));
    const fallback = run('/bin/bash', ['-c', `${shaFunction[0]}\nsha256 "$1"`, 'sha256', source], shipped,
      { ...process.env, PATH: shasumOnly });
    pass(fallback);
    assert.strictEqual(fallback.stdout.split(/\s+/)[0], hash(source));
  }
  for (const input of [...inputs].sort()) {
    assert.ok(fs.existsSync(path.join(shipped, input)), `missing shipped input: ${input}`);
    console.log(`ok shipped input: ${input}`);
  }
  for (const script of [apply, lifecycle, watchdog, watchdogCheck, path.join(shipped, 'scripts/e2e.mjs')]) {
    pass(run(process.execPath, ['--check', script], shipped));
  }
  for (const text of [packageScript, rebuildScript, oldNewScript]) {
    assert.match(text, /ELECTRON_RUN_AS_NODE=1 node "\$ROOT\/scripts\/pty-lifecycle-watchdog\.cjs" 120000/);
  }
  assert.ok(oldNewScript.includes('[ "$OLD_STATUS" -eq 1 ]'), 'old probe must reject watchdog timeouts');
  pass(run('/bin/bash', ['-n', path.join(shipped, 'scripts/test-node-pty-old-new-darwin.sh')], shipped));
  const probe = path.join(temporary, 'old-control-probe');
  for (const directory of ['scripts', 'bin', 'node_modules/.bin', 'old/node_modules/node-pty']) {
    fs.mkdirSync(path.join(probe, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(probe, 'scripts/test-node-pty-old-new-darwin.sh'), oldNewScript);
  fs.copyFileSync(watchdog, path.join(probe, 'scripts/pty-lifecycle-watchdog.cjs'));
  fs.writeFileSync(path.join(probe, 'bin/uname'), '#!/bin/sh\ncase "$1" in -s) printf "Darwin\\n" ;; -m) printf "arm64\\n" ;; *) exit 2 ;; esac\n', { mode: 0o700 });
