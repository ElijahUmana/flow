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
  fs.writeFileSync(path.join(probe, 'node_modules/.bin/electron'), '#!/usr/bin/env node\nconsole.error(process.env.FLOW_PROBE_OLD_MESSAGE); process.exit(Number(process.env.FLOW_PROBE_OLD_STATUS));\n', { mode: 0o700 });
  fs.writeFileSync(path.join(probe, 'scripts/rebuild-node-pty-darwin.sh'), '#!/bin/sh\nprintf "new gate ran\\n" > "$FLOW_PROBE_MARKER"\nexit "$FLOW_PROBE_NEW_STATUS"\n', { mode: 0o700 });
  let leakMessage;
  try {
    assert.deepStrictEqual([42], [], 'natural exit cycle 1: PTY masters did not return to baseline []; now [42]');
  } catch (err) {
    leakMessage = `FAIL pty-native-lifecycle: ${err.stack}`.split('\n')[0];
  }
  for (const [label, message, oldStatus, newStatus, expected, newRan] of [
    ['unrelated failure', 'FAIL pty-native-lifecycle: Error: lsof exited 2', 1, 0, 2, false],
    ['runtime failure', 'FAIL pty-native-lifecycle: AssertionError [ERR_ASSERTION]: expected Electron runtime', 1, 0, 2, false],
    ['wrong cycle', leakMessage.replace('cycle 1:', 'cycle 2:'), 1, 0, 2, false],
    ['no leaked descriptor', leakMessage.replace('now [42]', 'now []'), 1, 0, 2, false],
    ['timeout', leakMessage, 124, 0, 2, false],
    ['old unexpectedly passed', leakMessage, 0, 0, 2, false],
    ['exact leak and new pass', leakMessage, 1, 0, 0, true],
    ['exact leak and new failure', leakMessage, 1, 7, 7, true],
  ]) {
    const marker = path.join(probe, 'new-gate-marker');
    fs.rmSync(marker, { force: true });
    const result = run('/bin/bash', [path.join(probe, 'scripts/test-node-pty-old-new-darwin.sh'), path.join(probe, 'old')], probe, {
      ...process.env, PATH: path.join(probe, 'bin') + path.delimiter + process.env.PATH,
      FLOW_PROBE_OLD_MESSAGE: message, FLOW_PROBE_OLD_STATUS: String(oldStatus),
      FLOW_PROBE_NEW_STATUS: String(newStatus), FLOW_PROBE_MARKER: marker,
    });
    assert.strictEqual(result.status, expected, `${label}: ${result.stdout}${result.stderr}`);
    assert.strictEqual(fs.existsSync(marker), newRan, `${label}: new gate execution`);
  }
  console.log('PASS: old control requires the exact cycle-1 descriptor leak; unrelated failures and timeouts are rejected; new gate must pass');
  const watchdogResult = run(process.execPath, [watchdogCheck], shipped);
  pass(watchdogResult);
  process.stdout.write(watchdogResult.stdout);
  assert.strictEqual(crypto.createHash('md5').update(fs.readFileSync(lifecycle)).digest('hex'), '0315345126ad9defea0e731f5c4ad585');
  assert.strictEqual(hash(path.join(shipped, 'native/icon.icns')), '1505cbd0ac82330ad93f4d15921b7398691aff360c2895eb687045a0d9d5283e');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(shipped, 'package.json'), 'utf8')).devDependencies.electron, '45.2.1');
  assert.ok(packageScript.indexOf('scripts/apply-node-pty-patch.cjs') < packageScript.indexOf('scripts/rebuild-node-pty-darwin.sh'));
  assert.ok(rebuildScript.indexOf('scripts/apply-node-pty-patch.cjs') < rebuildScript.indexOf('scripts/node-pty-darwin-cleanup.py'));
  assert.ok(rebuildScript.indexOf('scripts/node-pty-darwin-cleanup.py') < rebuildScript.indexOf('npm rebuild node-pty --build-from-source'));
  assert.ok(rebuildScript.indexOf('npm rebuild node-pty --build-from-source') < rebuildScript.indexOf('scripts/pty-native-lifecycle.cjs'));
  assert.ok(packageScript.indexOf('"$PACKAGER" "$ROOT"') < packageScript.indexOf('scripts/pty-native-lifecycle.cjs'));
  console.log('ok shipped paths, gate order, lifecycle/icon identity, SHA256 selection and shasum-only fallback');

  const originalManifest = fs.readFileSync(manifest);
  assert.strictEqual(JSON.parse(originalManifest).version, '1.1.0');
  if (hash(source) === after) {
    pass(run('/usr/bin/patch', ['--batch', '--reverse', '-p1', '-i', patch], shipped));
  }
  assert.strictEqual(hash(source), before, 'dependency source is not the exact baseline or patched source');
  const baseline = fs.readFileSync(source);
  let result = run('python3', ['-I', cleanup, source, '--expect', 'fail'], shipped);
  pass(result);
  assert.match(result.stdout, /FAIL: success leaked descriptor\(s\), std mask 0/);
  process.stdout.write(result.stdout);
  pass(run(process.execPath, [apply, shipped], shipped));
  assert.strictEqual(hash(source), after);
  const patched = fs.readFileSync(source);
  const unchanged = fs.statSync(source);
  pass(run(process.execPath, [apply, shipped], shipped));
  assert.strictEqual(hash(source), after);
  assert.strictEqual(fs.statSync(source).mtimeMs, unchanged.mtimeMs, 'patched no-op rewrote the source');
  result = run('python3', ['-I', cleanup, source, '--expect', 'pass'], shipped);
  pass(result);
  process.stdout.write(result.stdout);

  for (const contents of [baseline, patched]) {
    fs.writeFileSync(source, Buffer.concat([contents, Buffer.from('\n')]));
    const mutationHash = hash(source);
    result = run(process.execPath, [apply, shipped], shipped);
    assert.notStrictEqual(result.status, 0, 'source mutation was accepted');
    assert.match(result.stderr, /expected baseline/);
    assert.strictEqual(hash(source), mutationHash, 'rejected source mutation was changed');
    fs.writeFileSync(source, contents);
    const invalidManifest = JSON.stringify({ ...JSON.parse(originalManifest), version: '1.1.1' });
    fs.writeFileSync(manifest, invalidManifest);
    result = run(process.execPath, [apply, shipped], shipped);
    assert.notStrictEqual(result.status, 0, 'unsupported node-pty version was accepted');
    assert.match(result.stderr, /expected node-pty 1\.1\.0/);
    assert.strictEqual(hash(source), contents === baseline ? before : after, 'version rejection changed source');
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), invalidManifest, 'version rejection changed manifest');
    fs.writeFileSync(manifest, originalManifest);
  }
  const originalPatch = fs.readFileSync(patch);
  fs.writeFileSync(source, baseline);
  fs.appendFileSync(patch, '\n');
  const mutatedPatchHash = hash(patch);
  result = run(process.execPath, [apply, shipped], shipped);
  assert.notStrictEqual(result.status, 0, 'mutated patch was accepted');
  assert.match(result.stderr, /patch content differs/);
  assert.strictEqual(hash(source), before, 'patch rejection changed source');
  assert.strictEqual(hash(patch), mutatedPatchHash, 'patch rejection changed patch');
  fs.writeFileSync(patch, originalPatch);
  fs.writeFileSync(source, patched);
  console.log(`ok exact baseline ${before} -> patched ${after}; no-op and rejected source/version/patch mutations stay unchanged`);

  for (const text of [packageScript, rebuildScript]) {
    assert.ok(text.includes('[ "$(uname -s)" = Darwin ]'), 'missing macOS guard');
    assert.ok(text.includes('[ "$(uname -m)" = arm64 ]'), 'missing arm64 guard');
  }

  for (const input of ['node_modules/.bin/electron-packager', 'node_modules/electron/package.json', 'node_modules/electron/dist/version']) {
    assert.ok(fs.existsSync(path.join(shipped, input)), `existing dependency tree is missing ${input}`);
    console.log(`ok existing dependency input: ${input}`);
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(shipped, 'node_modules/electron/package.json'), 'utf8')).version, '45.2.1');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(shipped, 'node_modules/electron-packager/package.json'), 'utf8')).version, '17.1.2');
  assert.strictEqual(fs.readFileSync(path.join(shipped, 'node_modules/electron/dist/version'), 'utf8').trim(), '45.2.1');
  if (process.platform === 'linux') {
    result = run(process.execPath, [watchdog, '120000', path.join(shipped, 'node_modules', electronExecutable), lifecycle, path.join(shipped, 'node_modules/node-pty')], shipped,
      { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
    pass(result);
    process.stdout.write(result.stdout);
    console.log('ok Linux Electron lifecycle only; no Darwin package was executed');
  }
  assert.deepStrictEqual(snapshot(dependencies), originalDependencies, 'source dependencies changed during closure checks');
  console.log('ok original dependency hashes unchanged after all temporary-tree checks');
  console.log('PASS: shipped-source closure and deterministic patch/cleanup gates; Darwin arm64 rebuild, Mach-O and packaged lifecycle still require macOS');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}




