#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const packageJson = path.join(root, 'node_modules/node-pty/package.json');
const target = path.join(root, 'node_modules/node-pty/src/unix/pty.cc');
const patch = path.join(root, 'scripts/node-pty-darwin-fd-cleanup.patch');
const patchHash = 'acb873d11d9921888c42f653325fb5a9cc2cb7ad7d6912ddd31ffc5f19b7a9cb';
const before = '5e1005d6bdcfbe97b486ee415419fe7adae99035047f07340fbad36419e0bae6';
const after = '98745ebe4f278afeb528021060dfdf42ac4dfd820620afaca4824435d6f09422';
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (!fs.existsSync(packageJson)) throw new Error(`missing ${packageJson}`);
const version = JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
if (version !== '1.1.0') throw new Error(`node-pty patch: expected node-pty 1.1.0, got ${version}`);
if (!fs.existsSync(target)) throw new Error(`missing ${target}`);
if (!fs.existsSync(patch)) throw new Error(`missing ${patch}`);
if (hash(patch) !== patchHash) throw new Error('node-pty patch: patch content differs from the pinned patch');
let got = hash(target);
if (got === after) {
  console.log(`node-pty patch: already applied (${after.slice(0, 12)})`);
  process.exit(0);
}
if (got !== before) throw new Error(`node-pty patch: ${target} is ${got}, expected baseline ${before} or patched ${after}`);
const result = spawnSync('/usr/bin/patch', ['--batch', '--forward', '-p1', '-i', patch], {
  cwd: root,
  encoding: 'utf8'
});
if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  throw new Error(`node-pty patch: patch exited ${result.status}`);
}
got = hash(target);
if (got !== after) throw new Error(`node-pty patch: result is ${got}, expected ${after}`);
console.log(`node-pty patch: applied (${after.slice(0, 12)})`);




