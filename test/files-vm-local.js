'use strict';
// vmfiles.js itself behind files-main.js's vm calls, for test/files-cdp.mjs: every ssh command line runs here instead,
// in bash with HOME=/home/claude/.flow-dev/files/vm-home (as test/vmfiles-electron-test.js does), so '~' is that folder;
// while a file named .down sits in it, each call exits 255, as ssh does when the VM cannot be reached. Wired by hand into
// a scratch tree's main.js (files.init({ ..., vm: require(process.env.FILES_VM) })), never into src/.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = '/home/claude/.flow-dev/files/vm-home';
const vmfiles = require(path.join(__dirname, '..', 'src', 'vmfiles'));
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function local(host, argv, { stdin } = {}) {
  const down = fs.existsSync(path.join(HOME, '.down'));
  return spawn('/bin/bash', ['-c', down ? 'exit 255' : argv.map(shq).join(' ')], {
    cwd: HOME, env: { HOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

vmfiles.init({ spawn: local, files: require(path.join(__dirname, '..', 'src', 'files-main')), cacheDir: '/tmp/flow-dev-files-vm-cache', tick: 1, retryMs: 500, retryMaxMs: 2000 });
module.exports = vmfiles;




