#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

[ "$(uname -s)" = Darwin ] || { echo "node-pty rebuild requires macOS" >&2; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "node-pty rebuild requires arm64, got $(uname -m)" >&2; exit 2; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

ELECTRON_VERSION=$(node -p "require('./package.json').devDependencies.electron")
[ "$ELECTRON_VERSION" = 45.2.1 ] || { echo "expected Electron 45.2.1, got $ELECTRON_VERSION" >&2; exit 2; }
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || { echo "missing Electron at $ELECTRON" >&2; exit 2; }
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e '
const assert = require("assert");
assert.strictEqual(process.versions.electron, "45.2.1");
assert.strictEqual(process.arch, "arm64");
'

node "$ROOT/scripts/apply-node-pty-patch.cjs" "$ROOT"
python3 -I "$ROOT/scripts/node-pty-darwin-cleanup.py" "$ROOT/node_modules/node-pty/src/unix/pty.cc" --expect pass
