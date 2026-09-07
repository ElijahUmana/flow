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
