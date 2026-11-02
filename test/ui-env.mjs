// Where a ui-e2e run lives. Defaults are ui's own; another owner runs the suite in isolation with
//   UI_ROLE=<role> UI_PORT=<port> [UI_MOCK_PORT=<port>] test/ui-dev.sh start --fresh && UI_ROLE=<role> UI_PORT=<port> node test/ui-e2e.mjs
// which uses tmux socket flow-dev-<role>-e2e, userData /tmp/flow-dev-<role>-e2e, logs /tmp/flow-<role>-e2e-logs,
// screenshots /tmp/flow-<role>-e2e-shots and folders under /home/claude/.flow-dev/<role>-e2e (trusted through
// /home/claude, so Claude Code starts without its trust question). test/ui-dev.sh derives the same names.
import path from 'node:path';

export const ROLE = process.env.UI_ROLE || 'ui';
const own = ROLE === 'ui';
if (!own && !process.env.UI_PORT) throw new Error(`UI_ROLE=${ROLE} needs UI_PORT (a CDP port of your own)`);
export const PORT = +(process.env.UI_PORT || 9562);
export const MOCK_PORT = +(process.env.UI_MOCK_PORT || (own ? 9572 : 0));
export const INSPECT = +(process.env.UI_INSPECT_PORT || PORT + 100);   // the main process's inspector (test/ui-dev.sh)
export const MARK = own ? 'ui' : `${ROLE}-e2e`;
export const SOCK = `flow-dev-${MARK}`;
export const DATA = `/tmp/flow-dev-${MARK}`;
export const LOGS = own ? '/tmp/flow-ui-logs' : `/tmp/flow-${MARK}-logs`;
export const SHOTS = own ? path.join(path.dirname(new URL(import.meta.url).pathname), 'ui-shots') : `/tmp/flow-${MARK}-shots`;
export const CWD = `/home/claude/.flow-dev/${MARK}`;




