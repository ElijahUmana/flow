#!/usr/bin/env bash
# ux's dev runs: the real app (CDP 9567) and, with --mock, the approved mockup (CDP 9573), each in its own xvfb display
# (in one display the window on top leaves the other one occluded: its document goes hidden and its timers and frames
# get throttled).
#   test/ux-dev.sh start [--fresh] [--mock]   --fresh: new state from test/ux-seed.mjs (no host windows)
#   test/ux-dev.sh stop                       stops both and ux's tmux servers
#   UX_ENTRY=<html> test/ux-dev.sh start ...  the app loads that page instead of src/index.html (FLOW_ENTRY)
# Only touches processes started with --flow-dev=ux* and the tmux sockets flow-dev-ux and flow-dev-ux-mock.
set -euo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/flow-ux-logs
case "${1:-}" in
  start)
    if pgrep -f "[e]lectron/dist/electron .*--flow-dev=ux" >/dev/null; then echo "already running"; exit 1; fi
    fresh=0; mock=0
    for a in "${@:2}"; do case "$a" in --fresh) fresh=1 ;; --mock) mock=1 ;; esac; done
    if [ "$fresh" = 1 ]; then rm -rf /tmp/flow-dev-ux /tmp/flow-dev-ux-mock; tmux -L flow-dev-ux kill-server 2>/dev/null || true; node test/ux-seed.mjs; fi
    [ -f /tmp/flow-dev-ux/flow-state.json ] || { echo "no state: run with --fresh"; exit 1; }
    mkdir -p "$LOG"
    wait_port() {
      for _ in $(seq 1 80); do curl -s -m 2 "localhost:$1/json" >/dev/null 2>&1 && return 0; sleep 0.5; done
      echo "nothing on $1, see $LOG"; exit 1
    }
    nohup xvfb-run -a -s "-screen 0 1600x1000x24" env ${UX_ENTRY:+FLOW_ENTRY=$UX_ENTRY} FLOW_USER_DATA=/tmp/flow-dev-ux FLOW_TMUX_SOCKET=flow-dev-ux FLOW_CDP_PORT=9567 FLOW_BACKGROUND=1 \
      ./node_modules/.bin/electron . --no-sandbox --flow-dev=ux > "$LOG/app.log" 2>&1 &
    wait_port 9567
    ports=9567
    if [ "$mock" = 1 ]; then
      nohup xvfb-run -a -s "-screen 0 1600x1000x24" env FLOW_ENTRY=spec/workspaces-mockup.html FLOW_USER_DATA=/tmp/flow-dev-ux-mock FLOW_TMUX_SOCKET=flow-dev-ux-mock FLOW_CDP_PORT=9573 FLOW_BACKGROUND=1 \
        ./node_modules/.bin/electron . --no-sandbox --flow-dev=ux-mock > "$LOG/mock.log" 2>&1 &
      wait_port 9573
      ports="9567 9573"
    fi
    echo "started on $ports"
    ;;
  stop)
    pkill -f "[e]lectron/dist/electron .*--flow-dev=ux" || true
    for _ in $(seq 1 20); do pgrep -f "[e]lectron/dist/electron .*--flow-dev=ux" >/dev/null || break; sleep 0.25; done
    tmux -L flow-dev-ux kill-server 2>/dev/null || true
    tmux -L flow-dev-ux-mock kill-server 2>/dev/null || true
    echo "stopped"
    ;;
  *)
    echo "usage: test/ux-dev.sh start [--fresh] [--mock] | stop"; exit 2 ;;
esac




