#!/bin/bash
# browse: browse's isolated Flow copy (userData /tmp/flow-dev-browse, socket flow-dev-browse, CDP 9571, main inspector 9671).
# usage: test/browse-app.sh start [logfile] | stop | reset
#   reset: writes the current seed (read from a probe launch, as scripts/e2e.mjs does) without any window that has a
#   host, any team window or any claude window, so nothing reaches the VM's sessions or starts Claude Code.
cd "$(dirname "$0")/.." || exit 1
DATA=/tmp/flow-dev-browse
start() {
  xvfb-run -a -s "-screen 0 1600x1000x24" env FLOW_USER_DATA="$1" FLOW_TMUX_SOCKET=flow-dev-browse FLOW_CDP_PORT=9571 FLOW_BACKGROUND=1 ./node_modules/.bin/electron --inspect=9671 . --no-sandbox --flow-dev=browse >"$2" 2>&1 &
  for _ in $(seq 1 60); do curl -s localhost:9571/json >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "no CDP on 9571 after 30 s" >&2; return 1
}
stop() {
  pkill -f "[e]lectron/dist/electron .*--flow-dev=browse"
  for _ in $(seq 1 40); do pgrep -f "[e]lectron/dist/electron .*--flow-dev=browse" >/dev/null || break; sleep 0.25; done
  tmux -L flow-dev-browse kill-server 2>/dev/null
  return 0
}
case "$1" in
  start) start "$DATA" "${2:-/tmp/flow-dev-browse.log}" ;;
  stop) stop ;;
  reset)
    stop
    probe=$(mktemp -d /tmp/flow-dev-browse-probe.XXXX)
    echo '{"v":11,"ws":[{"id":"browse-probe","name":"browse probe","folder":"~","bg":"#141319","zones":[],"notes":[],"windows":[],"closed":[]}],"ui":{}}' >"$probe/flow-state.json"
    start "$probe" "$probe/probe.log" || exit 1
    seed=$(node test/browse-eval.mjs 9571 'new Promise((r) => { const t = setInterval(() => { if (window.__flow) { clearInterval(t); r(); } }, 100); }).then(() => window.__flow.ready).then(() => JSON.stringify(window.__flow.seed()))') || { stop; exit 1; }
    stop
    rm -rf "$probe" "$DATA"
    mkdir -p "$DATA"
    SEED="$seed" node -e '
      const ws = JSON.parse(process.env.SEED);
      const drop = (x) => x && (x.host || x.type === "team" || x.cmd === "claude");
      for (const w of ws) for (const k of ["windows", "closed"]) if (Array.isArray(w[k])) w[k] = w[k].filter((x) => !drop(x));
      require("fs").writeFileSync(process.argv[1], JSON.stringify({ v: 11, ws, ui: {} }));
      console.log("seed written:", ws.map((w) => `${w.id} ${w.windows.length} windows`).join(", "));
    ' "$DATA/flow-state.json" ;;
  *) echo "usage: $0 start [log] | stop | reset" >&2; exit 2 ;;
esac




