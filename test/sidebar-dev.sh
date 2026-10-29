#!/usr/bin/env bash
# sidebar's dev runs: the real app on CDP 9574 in its own xvfb display.
#   test/sidebar-dev.sh start [--fresh]   --fresh: new state from test/sidebar-seed.mjs (no host windows)
#   test/sidebar-dev.sh restart           restarts the app, keeping the state and the tmux server
#   test/sidebar-dev.sh stop              stops it and kills the flow-dev-sidebar tmux server
# Only touches processes started with --flow-dev=sidebar* and the tmux socket flow-dev-sidebar.
set -euo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/flow-sidebar-logs
case "${1:-}" in
  start|restart)
    if [ "$1" = restart ]; then
      pkill -f "[e]lectron/dist/electron .*--flow-dev=sidebar" || true
      for _ in $(seq 1 40); do pgrep -f "[e]lectron/dist/electron .*--flow-dev=sidebar" >/dev/null || break; sleep 0.25; done
    fi
    if pgrep -f "[e]lectron/dist/electron .*--flow-dev=sidebar" >/dev/null; then echo "already running"; exit 1; fi
    fresh=0
    for a in "${@:2}"; do case "$a" in --fresh) fresh=1 ;; esac; done
    if [ "$fresh" = 1 ]; then tmux -L flow-dev-sidebar kill-server 2>/dev/null || true; node test/sidebar-seed.mjs; fi
    [ -f /tmp/flow-dev-sidebar/flow-state.json ] || { echo "no state: run with --fresh"; exit 1; }
    mkdir -p "$LOG"
    nohup xvfb-run -a -s "-screen 0 1600x1000x24" env FLOW_USER_DATA=/tmp/flow-dev-sidebar FLOW_TMUX_SOCKET=flow-dev-sidebar FLOW_CDP_PORT=9574 FLOW_BACKGROUND=1 \
      ./node_modules/.bin/electron . --no-sandbox --flow-dev=sidebar > "$LOG/app.log" 2>&1 &
    for _ in $(seq 1 80); do curl -s -m 2 localhost:9574/json >/dev/null 2>&1 && break; sleep 0.5; done
    curl -s -m 2 localhost:9574/json >/dev/null 2>&1 || { echo "nothing on 9574, see $LOG/app.log"; exit 1; }
    echo "started on 9574"
    ;;
  stop)
    pkill -f "[e]lectron/dist/electron .*--flow-dev=sidebar" || true
    for _ in $(seq 1 20); do pgrep -f "[e]lectron/dist/electron .*--flow-dev=sidebar" >/dev/null || break; sleep 0.25; done
    tmux -L flow-dev-sidebar kill-server 2>/dev/null || true
    echo "stopped"
    ;;
  *)
    echo "usage: test/sidebar-dev.sh start [--fresh] | restart | stop"; exit 2 ;;
esac




