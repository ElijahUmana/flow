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
