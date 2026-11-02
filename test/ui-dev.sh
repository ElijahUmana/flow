#!/usr/bin/env bash
# ui-e2e's dev runs: the real app and, with --mock, the approved mockup, each in its own xvfb display (in one display
# the window on top leaves the other occluded: its document goes hidden and its frames and timers are throttled).
#   test/ui-dev.sh start [--fresh] [--mock]   --fresh: new state from test/ui-seed.mjs (the seed without host windows)
#   test/ui-dev.sh stop                       stops both and this role's tmux servers
# Defaults are ui's own (CDP 9562, main-process inspector 9662, mockup 9572, socket flow-dev-ui, /tmp/flow-dev-ui).
# Another owner runs in isolation with UI_ROLE=<role> UI_PORT=<port> [UI_MOCK_PORT=<port>] [UI_INSPECT_PORT=<port>,
# else UI_PORT + 100]: socket flow-dev-<role>-e2e, /tmp/flow-dev-<role>-e2e
# (see test/ui-env.mjs). Only touches processes started with this role's --flow-dev marker and its tmux sockets.
set -euo pipefail
cd "$(dirname "$0")/.."
ROLE="${UI_ROLE:-ui}"
if [ "$ROLE" = ui ]; then MARK=ui; PORT="${UI_PORT:-9562}"; MOCK_PORT="${UI_MOCK_PORT:-9572}"; LOG=/tmp/flow-ui-logs
else
  MARK="$ROLE-e2e"; PORT="${UI_PORT:?UI_ROLE=$ROLE needs UI_PORT}"; MOCK_PORT="${UI_MOCK_PORT:-}"; LOG="/tmp/flow-$MARK-logs"
fi
SOCK="flow-dev-$MARK"; DATA="/tmp/flow-dev-$MARK"
INSPECT="${UI_INSPECT_PORT:-$((PORT + 100))}"   # the main process's inspector, for checks of what main does
case "${1:-}" in
  start)
    if pgrep -f "[e]lectron/dist/electron .*--flow-dev=$MARK( |$|-mock)" >/dev/null; then echo "already running"; exit 1; fi
    fresh=0; mock=0
    for a in "${@:2}"; do case "$a" in --fresh) fresh=1 ;; --mock) mock=1 ;; esac; done
    if [ "$fresh" = 1 ]; then
      rm -rf "$DATA" "$DATA-mock"
      tmux -L "$SOCK" kill-server 2>/dev/null || true
      node test/ui-seed.mjs
    fi
    [ -f "$DATA/flow-state.json" ] || { echo "no state in $DATA: start with --fresh"; exit 1; }
    mkdir -p "$LOG"
    wait_port() {
      for _ in $(seq 1 80); do curl -s -m 2 "localhost:$1/json" >/dev/null 2>&1 && return 0; sleep 0.5; done
      echo "nothing on $1, see $LOG"; exit 1
    }
    nohup xvfb-run -a -s "-screen 0 1600x1000x24" env FLOW_USER_DATA="$DATA" FLOW_TMUX_SOCKET="$SOCK" FLOW_CDP_PORT="$PORT" \
      ./node_modules/.bin/electron --inspect="$INSPECT" . --no-sandbox --flow-dev="$MARK" > "$LOG/app.log" 2>&1 &
    wait_port "$PORT"
    ports="$PORT"
    if [ "$mock" = 1 ]; then
      [ -n "$MOCK_PORT" ] || { echo "--mock needs UI_MOCK_PORT"; exit 1; }
      nohup xvfb-run -a -s "-screen 0 1600x1000x24" env FLOW_ENTRY=spec/workspaces-mockup.html FLOW_USER_DATA="$DATA-mock" FLOW_TMUX_SOCKET="$SOCK-mock" FLOW_CDP_PORT="$MOCK_PORT" \
        ./node_modules/.bin/electron . --no-sandbox --flow-dev="$MARK-mock" > "$LOG/mock.log" 2>&1 &
      wait_port "$MOCK_PORT"
      ports="$ports $MOCK_PORT"
    fi
    echo "started: $ports"
    ;;
  stop)
    pkill -f "[e]lectron/dist/electron .*--flow-dev=$MARK( |$|-mock|-probe)" || true
    for _ in $(seq 1 20); do pgrep -f "[e]lectron/dist/electron .*--flow-dev=$MARK( |$|-mock|-probe)" >/dev/null || break; sleep 0.25; done
    for s in "$SOCK" "$SOCK-mock" "$SOCK-probe"; do tmux -L "$s" kill-server 2>/dev/null || true; done
    echo "stopped"
    ;;
  *)
    echo "usage: test/ui-dev.sh start [--fresh] [--mock] | stop   (UI_ROLE=<role> UI_PORT=<port> for another owner)"; exit 2 ;;
esac




