#!/bin/bash
# Builds native/touch/flow_touch.node on the Mac (arm64) from flow_touch.mm. It uses only N-API, so one build works in
# the Electron Flow runs (45) and in Node; it links AppKit and takes Node's functions from the process that loads it.
# Needs the Xcode command line tools (xcrun clang++) and the headers of a Node install (its include/node).
#   bash native/touch/build-mac.sh            NODE_INCLUDE=<dir with node_api.h> to pick the headers
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE_INCLUDE="${NODE_INCLUDE:-$(dirname "$(dirname "$(command -v node)")")/include/node}"
[ -f "$NODE_INCLUDE/node_api.h" ] || { echo "build-mac: no node_api.h in $NODE_INCLUDE; set NODE_INCLUDE" >&2; exit 1; }
xcrun clang++ -std=c++17 -ObjC++ -fobjc-arc -arch arm64 -mmacosx-version-min=11.0 -O2 -Wall -Wextra \
  -DNAPI_VERSION=8 -I "$NODE_INCLUDE" -bundle -undefined dynamic_lookup -framework AppKit \
  -o "$HERE/flow_touch.node" "$HERE/flow_touch.mm"
codesign --force --sign - "$HERE/flow_touch.node"
node -e "const t = require(process.argv[1]); for (const f of ['start', 'stop', 'watch', 'unwatch']) if (typeof t[f] !== 'function') throw new Error('no ' + f); if (t._inject) throw new Error('a test build');" "$HERE/flow_touch.node"
echo "build-mac: built $HERE/flow_touch.node ($(shasum -a 256 "$HERE/flow_touch.node" | cut -c1-16))"




