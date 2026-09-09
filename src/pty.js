'use strict';
// Terminals backed by tmux. Every Flow terminal is a tmux session flow_<id> on Flow's own socket;
// every (BrowserWindow, id) pair owns one node-pty process running a tmux client attached to it.
// Closing a window or quitting Flow kills the clients only, so the agents keep running.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const nodePty = require('node-pty');

const HOME = os.homedir();
const CONF = path.join(__dirname, 'flow-tmux.conf');
const SSH = '/usr/bin/ssh';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANE_RE = /^%\d+$/;
const HOST_RE = /^[A-Za-z0-9_.@%+:[\]-]+$/;
const FLUSH_MS = 8;
const FLUSH_BYTES = 256 * 1024;
const ECHO_BYTES = 16;
const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'TMUX', 'TMUX_PANE', 'ELECTRON_RUN_AS_NODE'];
// Claude Code drops to 256 colors whenever $TMUX is set unless CLAUDE_CODE_TMUX_TRUECOLOR is set
// (claude 2.1.296: `if(a.TMUX&&u.level>2)return u.level=2`). Flow's tmux passes RGB through to
// xterm.js (flow-tmux.conf), so it is set for every Flow session, also via new-session -e because a
// tmux server started by an older Flow keeps its old global environment.
const TRUECOLOR_ENV = { COLORTERM: 'truecolor', CLAUDE_CODE_TMUX_TRUECOLOR: '1' };
// The login shell starts from the same small environment launchd gives a fresh Terminal window, so
// variables of whatever process launched Flow (a parent Claude Code session, iTerm, a dev shell)
// never leak into Flow's terminals.
const BASE_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING',
  'COMMAND_MODE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY'];
// On Linux node-pty (forkpty) and libuv fork without closing the descriptors Electron opened
// without CLOEXEC; on macOS both spawn with POSIX_SPAWN_CLOEXEC_DEFAULT. A tmux server started from
// Flow would keep them after Flow quits, the DevTools port among them, so children start through
// bash, which closes everything above stderr and execs the real program. --posix: no BASH_ENV.
const CLOSE_FDS = 'for f in /proc/self/fd/*; do n=${f##*/}; ((n > 2)) && exec {n}>&-; done; exec "$@"';
const spawnable = (file, args) => (process.platform === 'linux'
  ? ['/bin/bash', ['--posix', '-c', CLOSE_FDS, 'flow', file, ...args]]
  : [file, args]);

const cfg = { socket: 'flow', version: '0', tmux: null, env: null, ready: null };
const clients = new Map();   // `${webContentsId}\0${id}` -> client
const running = new Set();   // clients whose process has not reported its exit yet, dropped ones included
const remotes = new Map();   // sanitized id -> { host, attach, own, located } (own: on Flow's tmux server on the host)
const confSent = new Map();  // ssh host -> promise of Flow's tmux conf written there (once per run)
const hostDown = new Map();  // ssh host -> { failures, until, error } while connections to it fail
const recoveryProcesses = new Map(); // terminal id -> exact remote pid/start pairs whose target was already destroyed
let whenIdle = null;         // set while shutdown() waits for running to empty

// ---------- helpers ----------

const sanitize = (id) => String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
const keyOf = (wcId, id) => wcId + '\0' + id;
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function toInt(v, def, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

function whichIn(name, pathVar) {
  for (const dir of String(pathVar || '').split(':')) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function claudeDir() {
  const dir = cfg.env && cfg.env.CLAUDE_CONFIG_DIR;
  return dir ? expandHome(dir) : path.join(HOME, '.claude');
}

function transcriptOf(sessionId) {
  const root = path.join(claudeDir(), 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  for (const d of dirs) {
    const f = path.join(root, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const transcriptExists = (sessionId) => !!transcriptOf(sessionId);

function resolveClaude() {
  for (const p of [path.join(HOME, 'bin', 'claude'), path.join(HOME, '.local', 'bin', 'claude')]) {
    if (isExecutable(p)) return p;
  }
  // Not found: the bare name still runs through the login shell, so an alias or function works and
  // a real "command not found" shows up in the terminal itself.
  return whichIn('claude', cfg.env && cfg.env.PATH) || 'claude';
}

// ---------- the command that resumes a conversation ----------

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shq(s));
const shPath = (p) => (p === HOME ? '~' : p.startsWith(HOME + '/') ? '~/' + shWord(p.slice(HOME.length + 1)) : shWord(p));
const TRANSCRIPT_HEAD = 256 * 1024;

// The folder a transcript's conversation ran in, from its first entry that has one: Claude Code keeps a conversation
// under that folder's project and resumes it only from there.
function cwdIn(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.cwd === 'string' && e.cwd.startsWith('/')) return e.cwd;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return null;
}

async function headOf(file) {
  const h = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(TRANSCRIPT_HEAD);
    const { bytesRead } = await h.read(buf, 0, TRANSCRIPT_HEAD, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await h.close();
  }
}

// What to type in any terminal to get back into conversation sessionId (owner, Nov 2 14:5x: a copied command found no
// conversation on the Mac): the claude Flow runs, with the CLAUDE_CONFIG_DIR it runs with, in the folder the
// transcript says the conversation ran in. A window on another host gets ssh and that host's own claude and transcript.
// { command }, or { error } when there is no transcript (nothing to resume yet) or the host can't be reached.
// opts: { host, cwd }, the window's; its cwd is used only when the transcript names no folder.
async function resumeCommand(sessionId, opts) {
  await cfg.ready;
  const sid = String(sessionId == null ? '' : sessionId);
  if (!SESSION_ID_RE.test(sid)) return { error: `not a conversation id: ${sid.slice(0, 60)}` };
  const host = opts && typeof opts.host === 'string' ? opts.host : '';
  const own = opts && typeof opts.cwd === 'string' && /^(~($|\/)|\/)/.test(opts.cwd) ? opts.cwd : '';
  if (host) {
    const find = `f=$(find "$HOME/.claude/projects" -maxdepth 2 -name ${shq(sid + '.jsonl')} -print 2>/dev/null | head -n 1); ` +
      `[ -n "$f" ] || exit 3; head -c ${TRANSCRIPT_HEAD} "$f"`;
    let r;
    try {
      r = await sshExec(host, [find]);
    } catch (e) {
      return { error: `${host} could not be reached: ${e.message}` };
    }
    if (r.code === 3) return { error: `this conversation has no transcript on ${host} yet` };
    if (r.code !== 0) return { error: `could not read the transcript on ${host}: ${String(r.stderr).trim().slice(0, 200)}` };
    const cwd = cwdIn(String(r.stdout));
    const at = cwd ? shWord(cwd) : own === '~' ? '"$HOME"' : own.startsWith('~/') ? '"$HOME"/' + shq(own.slice(2)) : own ? shWord(own) : '';
    const inner = `${at ? `cd ${at} && ` : ''}claude --resume ${sid}`;
    return { command: `ssh -t ${shWord(host)} ${shq('exec "$SHELL" -lic ' + shq(inner))}` };
  }
  const file = transcriptOf(sid);
  if (!file) return { error: 'this conversation has no transcript yet' };
  const cwd = cwdIn(await headOf(file)) || (own && expandHome(own));
  const dir = cfg.env && cfg.env.CLAUDE_CONFIG_DIR;
  return { command: `${cwd ? `cd ${shPath(cwd)} && ` : ''}${dir ? `CLAUDE_CONFIG_DIR=${shPath(expandHome(dir))} ` : ''}${shPath(resolveClaude())} --resume ${sid}` };
}

// Whether conversation sessionId still runs in flow_<id> (MAC_NOTES 26): some process in its panes, or their children,
// carries the id on its command line, which is the claude Flow started there, or the shell about to start it. Once that
// claude has exited, the pane's shell no longer carries it, and the id is stale for that window. null when there is no
// such session.
async function holds(id, sessionId, opts) {
  const sid = sanitize(id);
  const conv = String(sessionId == null ? '' : sessionId);
  if (!sid || !SESSION_ID_RE.test(conv)) return null;
  const remote = await remoteAt(id, opts);
  const panes = await runner(remote)(['list-panes', '-s', '-t', sessionTarget(sid, remote), '-F', '#{pane_pid}']);
  if (panes.code !== 0) {
    if (noServer(panes.stderr) || noTarget(panes.stderr)) return null;
    throw new Error('tmux list-panes: ' + panes.stderr);
  }
  const ps = remote ? await sshExec(remote.host, ['ps', '-axww', '-o', 'pid=,ppid=,args=']) : await exec('/bin/ps', ['-axww', '-o', 'pid=,ppid=,args='], 10000);
  if (ps.code !== 0) throw new Error('ps: ' + ps.stderr);
  const kids = new Map();
  const args = new Map();
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    args.set(m[1], m[3]);
    if (!kids.has(m[2])) kids.set(m[2], []);
    kids.get(m[2]).push(m[1]);
  }
  const todo = panes.stdout.split('\n').filter((p) => /^\d+$/.test(p));
  for (const seen = new Set(); todo.length;) {
    const pid = todo.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if ((args.get(pid) || '').includes(conv)) return true;
    todo.push(...(kids.get(pid) || []));
  }
  return false;
}

// ---------- login environment (resolved once at startup) ----------

function finishEnv(env) {
  for (const k of STRIP_ENV) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('FLOW_') || k.startsWith('ELECTRON_')) delete env[k];
  for (const k of ['_', 'SHLVL', 'PWD', 'OLDPWD']) delete env[k];
  env.TERM = 'xterm-256color';
  env.COLORTERM = TRUECOLOR_ENV.COLORTERM;
  env.CLAUDE_CODE_TMUX_TRUECOLOR = TRUECOLOR_ENV.CLAUDE_CODE_TMUX_TRUECOLOR;
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  env.TERM_PROGRAM = 'Flow';
  env.TERM_PROGRAM_VERSION = cfg.version;
  if (!env.HOME) env.HOME = HOME;
  return env;
}

function fallbackEnv() {
  const env = { ...process.env };
  const parts = String(env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
  for (const extra of [path.join(HOME, '.local', 'bin'), path.join(HOME, 'bin'), '/opt/homebrew/bin']) {
    if (!parts.includes(extra)) parts.unshift(extra);
  }
  env.PATH = parts.join(':');
  return env;
}

function resolveLoginEnv() {
  const base = {};
  for (const k of BASE_ENV) if (process.env[k] != null) base[k] = process.env[k];
  base.HOME = base.HOME || HOME;
  base.SHELL = base.SHELL || '/bin/zsh';
  base.USER = base.USER || os.userInfo().username;
  base.LOGNAME = base.LOGNAME || base.USER;
  base.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const marker = '__FLOW_ENV_' + process.pid + '__';
  return new Promise((resolve) => {
    execFile(...spawnable('/bin/zsh', ['-ilc', `printf '%s\\0' ${marker}; env -0`]),
      { env: base, cwd: HOME, timeout: 20000, maxBuffer: 16 << 20, encoding: 'utf8' },
      (err, stdout) => {
        const out = String(stdout || '');
        const at = out.indexOf(marker + '\0');
        let env = null;
        if (at >= 0) {
          env = {};
          for (const entry of out.slice(at + marker.length + 1).split('\0')) {
            const eq = entry.indexOf('=');
            if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
          }
        }
        if (!env || !env.PATH) {
          console.error('[flow] could not read the login environment from /bin/zsh -ilc (' +
            (err ? err.message : 'no output') + '); using the app environment instead');
          env = fallbackEnv();
        } else if (err) {
          console.error('[flow] /bin/zsh -ilc exited with an error after printing the environment: ' + err.message);
        }
        resolve(finishEnv(env));
      });
  });
}

function findTmux(env) {
  if (isExecutable('/opt/homebrew/bin/tmux')) return '/opt/homebrew/bin/tmux';
  return whichIn('tmux', env.PATH) || whichIn('tmux', process.env.PATH);
}

function init(opts) {
  cfg.socket = opts.socket || 'flow';
  cfg.version = opts.version || '0';
