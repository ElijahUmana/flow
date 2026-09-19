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

export npm_config_runtime=electron
export npm_config_target="$ELECTRON_VERSION"
export npm_config_arch=arm64
export npm_config_target_arch=arm64
export npm_config_disturl=https://electronjs.org/headers
export npm_config_build_from_source=true
npm rebuild node-pty --build-from-source
[ "$(sha256 "$ROOT/node_modules/node-pty/src/unix/pty.cc" | cut -d ' ' -f 1)" = 98745ebe4f278afeb528021060dfdf42ac4dfd820620afaca4824435d6f09422 ] \
  || { echo "node-pty source changed during rebuild" >&2; exit 2; }

mkdir -p "$ROOT/evidence"
BINARY="$ROOT/node_modules/node-pty/build/Release/pty.node"
[ -f "$BINARY" ] || { echo "node-pty rebuild did not make $BINARY" >&2; exit 2; }
BINARY_FILE=$(file "$BINARY")
printf '%s\n' "$BINARY_FILE" | tee "$ROOT/evidence/node-pty-binary-file.txt"
case "$BINARY_FILE" in
  *Mach-O*arm64*) ;;
  *) echo "node-pty binary is not Mach-O arm64" >&2; exit 2 ;;
esac
[ "$(lipo -archs "$BINARY")" = arm64 ] || { echo "node-pty binary is not arm64" >&2; exit 2; }
sha256 "$ROOT/node_modules/node-pty/src/unix/pty.cc" "$BINARY" | tee "$ROOT/evidence/node-pty-source-binary-sha256.txt"
ELECTRON_RUN_AS_NODE=1 node "$ROOT/scripts/pty-lifecycle-watchdog.cjs" 120000 \
  "$ELECTRON" "$ROOT/scripts/pty-native-lifecycle.cjs" "$ROOT/node_modules/node-pty" \
  | tee "$ROOT/evidence/pty-native-lifecycle-new.txt"




