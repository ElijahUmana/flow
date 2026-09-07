#!/bin/bash
# Packages Flow into dist/ with electron-packager, ad-hoc signs it, launches the staged copy to make sure it
# answers over CDP, then swaps it into the install path (default ~/Applications/Flow.app) and prints that path.
#
#   FLOW_INSTALL_PATH=<dir>/Flow.app   install somewhere else
#   FLOW_SKIP_INSTALL=1                stop after building and signing dist/Flow-darwin-arm64/Flow.app
#
# A bundle at the install path is only ever replaced when it is a Flow build (so.flow.app). Anything else there,
# like the App Store app "Flow" (design.yugen.Flow), is left alone and the script stops.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME=Flow
BUNDLE_ID=so.flow.app
OUT="$ROOT/dist"
BUILT="$OUT/$APP_NAME-darwin-arm64/$APP_NAME.app"
INSTALL_PATH="${FLOW_INSTALL_PATH:-$HOME/Applications/$APP_NAME.app}"
PACKAGER="$ROOT/node_modules/.bin/electron-packager"
ELECTRON_DIST="$ROOT/node_modules/electron/dist"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

say() { echo "package: $*"; }
die() { echo "package: $*" >&2; exit 1; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || true; }
regex_escape() { printf '%s' "$1" | sed 's/[][\.*^$()+?{}|]/\\&/g'; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

[ "$(uname -s)" = Darwin ] || die "packaging requires macOS"
[ "$(uname -m)" = arm64 ] || die "packaging requires arm64, got $(uname -m)"

WORK="$(mktemp -d /tmp/flow-package.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

[ -x "$PACKAGER" ] || die "electron-packager is missing from node_modules ($PACKAGER)"
[ -x "$ELECTRON_DIST/Electron.app/Contents/MacOS/Electron" ] || die "Electron is missing from node_modules ($ELECTRON_DIST)"
[ -f "$ROOT/native/icon.icns" ] || die "native/icon.icns is missing"
ELECTRON_VERSION="$(node -p "require('$ROOT/node_modules/electron/package.json').version")"
[ "$ELECTRON_VERSION" = 45.2.1 ] || die "expected Electron 45.2.1, got $ELECTRON_VERSION"
[ "$(cat "$ELECTRON_DIST/version")" = "$ELECTRON_VERSION" ] || die "node_modules/electron/dist is not Electron $ELECTRON_VERSION"

say "patching and rebuilding node-pty for Electron $ELECTRON_VERSION arm64"
node "$ROOT/scripts/apply-node-pty-patch.cjs" "$ROOT" || die "node-pty patch contract failed"
"$ROOT/scripts/rebuild-node-pty-darwin.sh" || die "node-pty patch, rebuild or lifecycle gate failed"
PTY_SOURCE_SHA="$(sha256 "$ROOT/node_modules/node-pty/src/unix/pty.cc" | awk '{print $1}')"
PTY_BINARY_SHA="$(sha256 "$ROOT/node_modules/node-pty/build/Release/pty.node" | awk '{print $1}')"

# Package the exact Electron the app is developed against, from node_modules, instead of downloading one.
say "zipping Electron $ELECTRON_VERSION from node_modules"
mkdir "$WORK/zips"
(cd "$ELECTRON_DIST" && zip -qry0 "$WORK/zips/electron-v$ELECTRON_VERSION-darwin-arm64.zip" .)

say "packaging into $OUT"
"$PACKAGER" "$ROOT" "$APP_NAME" \
  --platform=darwin --arch=arm64 \
  --electron-version="$ELECTRON_VERSION" --electron-zip-dir="$WORK/zips" \
  --out="$OUT" --overwrite --asar=false --prune=true \
  --app-bundle-id="$BUNDLE_ID" --icon="$ROOT/native/icon.icns" \
  --ignore='^/dist($|/)' --ignore='^/test($|/)' --ignore='^/spec($|/)' --ignore='^/scripts($|/)' \
  --ignore='^/patches($|/)' --ignore='^/evidence($|/)' \
  --ignore='^/build($|/)' --ignore='\.md$' \
  --ignore='^/node_modules/node-pty/prebuilds/(?!darwin-arm64(/|$))' \
  --quiet

[ -d "$BUILT" ] || die "electron-packager did not produce $BUILT"
APPDIR="$BUILT/Contents/Resources/app"
[ -d "$APPDIR" ] || die "no Contents/Resources/app in the bundle"
[ ! -e "$BUILT/Contents/Resources/app.asar" ] || die "the bundle has an app.asar; it must be built with --asar=false"
MAIN="$(node -p "require('$APPDIR/package.json').main")"
[ -f "$APPDIR/$MAIN" ] || die "the bundle has no $MAIN"
for gone in dist test spec scripts build BRIEF.md node_modules/electron node_modules/electron-packager; do
  [ ! -e "$APPDIR/$gone" ] || die "$gone should not be in the bundle"
done
[ "$(plist "$BUILT" CFBundleIdentifier)" = "$BUNDLE_ID" ] || die "bundle id is $(plist "$BUILT" CFBundleIdentifier), expected $BUNDLE_ID"
[ "$(plist "$BUILT" CFBundleName)" = "$APP_NAME" ] || die "bundle name is $(plist "$BUILT" CFBundleName), expected $APP_NAME"
[ -x "$BUILT/Contents/MacOS/$APP_NAME" ] || die "no executable at Contents/MacOS/$APP_NAME"
ICON="$(plist "$BUILT" CFBundleIconFile)"
cmp -s "$ROOT/native/icon.icns" "$BUILT/Contents/Resources/${ICON%.icns}.icns" || die "the bundle icon ($ICON) is not native/icon.icns"

PTY="$APPDIR/node_modules/node-pty"
[ -f "$PTY/build/Release/pty.node" ] || die "node-pty/build/Release/pty.node is missing from the bundle"
[ -f "$PTY/build/Release/spawn-helper" ] || die "node-pty/build/Release/spawn-helper is missing from the bundle"
[ "$(sha256 "$PTY/src/unix/pty.cc" | awk '{print $1}')" = "$PTY_SOURCE_SHA" ] || die "the bundle does not contain the patched node-pty source"
[ "$(sha256 "$PTY/build/Release/pty.node" | awk '{print $1}')" = "$PTY_BINARY_SHA" ] || die "the bundle does not contain the rebuilt node-pty binary"
PTY_FILE="$(file "$PTY/build/Release/pty.node")"
case "$PTY_FILE" in
  *Mach-O*arm64*) ;;
  *) die "packaged node-pty binary is not Mach-O arm64: $PTY_FILE" ;;
esac
[ "$(lipo -archs "$PTY/build/Release/pty.node")" = arm64 ] || die "packaged node-pty binary is not arm64"
for helper in "$PTY/build/Release/spawn-helper" "$PTY/prebuilds/darwin-arm64/spawn-helper"; do
  [ -f "$helper" ] || continue
  if [ ! -x "$helper" ]; then
    chmod +x "$helper"
    say "made ${helper#"$APPDIR/"} executable"
  fi
  [ -x "$helper" ] || die "${helper#"$APPDIR/"} is not executable"
done

say "signing (ad-hoc)"
codesign --force --deep --sign - "$BUILT"
codesign --verify --deep --strict --verbose=1 "$BUILT" 2>&1 | sed 's/^/package: /'

# node-pty must load under the packaged Electron and spawn through the bundled spawn-helper.
ELECTRON_RUN_AS_NODE=1 "$BUILT/Contents/MacOS/$APP_NAME" -e '
const assert = require("assert");
assert.strictEqual(process.versions.electron, "45.2.1");
assert.strictEqual(process.arch, "arm64");
const pty = require(process.argv[1]);
const p = pty.spawn("/bin/sh", ["-c", "echo flow-pty-$((40 + 2))"], { cols: 80, rows: 24 });
let out = "";
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => {
  if (exitCode === 0 && out.includes("flow-pty-42")) process.exit(0);
  console.error(`node-pty spawn failed: exit ${exitCode}, output ${JSON.stringify(out)}`);
  process.exit(1);
});
setTimeout(() => { console.error("node-pty spawn timed out"); process.exit(1); }, 10000);
' "$PTY" || die "node-pty does not work inside the packaged app"
say "node-pty spawns through the bundled spawn-helper"
mkdir -p "$ROOT/evidence"
ELECTRON_RUN_AS_NODE=1 node "$ROOT/scripts/pty-lifecycle-watchdog.cjs" 120000 \
  "$BUILT/Contents/MacOS/$APP_NAME" "$ROOT/scripts/pty-native-lifecycle.cjs" "$PTY" \
  | tee "$ROOT/evidence/pty-native-lifecycle-packaged.txt" \
  || die "packaged node-pty lifecycle gate failed"
say "packaged node-pty source $PTY_SOURCE_SHA"
say "packaged node-pty binary $PTY_BINARY_SHA"
say "built $BUILT"

if [ "${FLOW_SKIP_INSTALL:-}" = 1 ]; then
  echo "$BUILT"
  exit 0
fi

NEW="$INSTALL_PATH.new"
OLD="$INSTALL_PATH.old"
mkdir -p "$(dirname "$INSTALL_PATH")"

if [ -e "$INSTALL_PATH" ]; then
  HAVE="$(plist "$INSTALL_PATH" CFBundleIdentifier)"
  [ "$HAVE" = "$BUNDLE_ID" ] || die "$INSTALL_PATH is another app (${HAVE:-no bundle id}); leaving it alone. Set FLOW_INSTALL_PATH to install somewhere else."
  if pgrep -f "^$(regex_escape "$INSTALL_PATH")/Contents/MacOS/$APP_NAME" >/dev/null; then
    die "Flow is running from $INSTALL_PATH; quit it, then run this again"
  fi
fi
for stale in "$NEW" "$OLD"; do
  [ -e "$stale" ] || continue
  HAVE="$(plist "$stale" CFBundleIdentifier)"
  [ "$HAVE" = "$BUNDLE_ID" ] || die "$stale is not a Flow build (${HAVE:-no bundle id}); move it away by hand"
  rm -rf "$stale"
done

say "staging $NEW"
ditto "$BUILT" "$NEW"
codesign --verify --deep --strict "$NEW" || die "the staged copy at $NEW fails signature verification"
node "$ROOT/scripts/e2e.mjs" --smoke --app "$NEW" || die "the staged copy at $NEW did not start cleanly; $INSTALL_PATH is untouched"

if [ -e "$INSTALL_PATH" ]; then
  mv "$INSTALL_PATH" "$OLD"
fi
if ! mv "$NEW" "$INSTALL_PATH"; then
  [ -e "$OLD" ] && mv "$OLD" "$INSTALL_PATH"
  die "could not move $NEW into place; the previous install is back"
fi
rm -rf "$OLD"

[ "$(plist "$INSTALL_PATH" CFBundleIdentifier)" = "$BUNDLE_ID" ] || die "installed bundle id is wrong"
codesign --verify --deep --strict "$INSTALL_PATH" || die "the installed copy fails signature verification"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$INSTALL_PATH"
say "installed"
echo "$INSTALL_PATH"




