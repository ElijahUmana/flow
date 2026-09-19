#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OLD_ROOT=${1:?usage: test-node-pty-old-new-darwin.sh /path/to/unpatched-b10land2}
cd "$ROOT"
mkdir -p evidence

[ "$(uname -s)" = Darwin ] || { echo "old/new node-pty proof requires macOS" >&2; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "old/new node-pty proof requires arm64" >&2; exit 2; }
[ -d "$OLD_ROOT/node_modules/node-pty" ] || { echo "missing old node-pty under $OLD_ROOT" >&2; exit 2; }

set +e
set -o pipefail
ELECTRON_RUN_AS_NODE=1 node "$ROOT/scripts/pty-lifecycle-watchdog.cjs" 120000 \
  "$ROOT/node_modules/.bin/electron" "$ROOT/scripts/pty-native-lifecycle.cjs" "$OLD_ROOT/node_modules/node-pty" \
  2>&1 | tee evidence/pty-native-lifecycle-old.txt
OLD_STATUS=${PIPESTATUS[0]}
set -e
[ "$OLD_STATUS" -eq 1 ] || { echo "old node-pty probe must report a lifecycle failure, got exit $OLD_STATUS" >&2; exit 2; }
node - "$ROOT/evidence/pty-native-lifecycle-old.txt" <<'NODE'
const fs = require('fs');
const log = fs.readFileSync(process.argv[2], 'utf8');
const leak = /^FAIL pty-native-lifecycle: AssertionError \[ERR_ASSERTION\]: natural exit cycle 1: PTY masters did not return to baseline (\[(?:\d+(?:,\d+)*)?\]); now (\[\d+(?:,\d+)*\])$/m.exec(log);
if (!leak || !JSON.parse(leak[2]).some((fd) => !JSON.parse(leak[1]).includes(fd))) {
  console.error('old node-pty probe did not report the cycle-1 PTY descriptor leak');
  process.exit(2);
}
NODE

echo "old node-pty failed as expected (exit $OLD_STATUS)"
scripts/rebuild-node-pty-darwin.sh




