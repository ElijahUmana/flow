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
  cfg.ready = resolveLoginEnv().then(async (env) => {
    cfg.env = env;
    cfg.tmux = findTmux(env);
    if (!cfg.tmux) console.error('[flow] tmux was not found (looked for /opt/homebrew/bin/tmux and on PATH)');
    else await reloadConf();
    return env;
  });
  return cfg.ready;
}

// The tmux server outlives Flow (the agents keep running) and reads -f only when it starts, so each Flow start loads
// the conf into a server that is already up: conf changes arrive without ending any agent. No server: nothing to do.
async function reloadConf() {
  let r;
  try {
    r = await exec(cfg.tmux, ['-u', '-L', cfg.socket, '-f', CONF, 'source-file', CONF], 10000);
  } catch (e) {
    console.error(`[flow] could not load ${CONF} into the running tmux server: ${e.message}`);
    return;
  }
  if (r.code !== 0 && !noServer(r.stderr)) console.error(`[flow] could not load ${CONF} into the running tmux server: ${r.stderr}`);
}

// ---------- running tmux ----------

const noServer = (s) => /no server running|error connecting to|server exited unexpectedly/i.test(s);
// tmux 3.4 says "no current target" when a server is up but holds no session yet (a cold start, before the first
// new-session has made one).
const noTarget = (s) => /can't find (session|window|pane)|session not found|no such session|no current target/i.test(s);

function exec(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(...spawnable(file, args), { env: cfg.env, timeout, maxBuffer: 16 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        reject(Object.assign(new Error(`${path.basename(file)} ${args.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ')}: ${err.killed ? 'timed out' : err.message}`),
          { timedOut: !!err.killed }));
        return;
      }
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr).trim() });
    });
  });
}

const ENXIO = os.constants.errno.ENXIO;
function isPtyExhausted(error) {
  return process.platform === 'darwin' && !!error && error.code === 'ENXIO' &&
    typeof error.errno === 'number' && error.errno === ENXIO && error.syscall === 'posix_openpt';
}

async function heldPtyMasters() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'],
      { env: cfg.env, timeout: 5000, maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          resolve({ count: null, error: String(stderr || '').trim() || error.message });
          return;
        }
        const fds = new Set();
        let fd = null;
        for (const line of String(stdout || '').split('\n')) {
          if (line.startsWith('f')) {
            const match = /^f(\d+)$/.exec(line);
            fd = match ? Number(match[1]) : null;
          } else if (line.startsWith('p')) fd = null;
          else if (line === 'n/dev/ptmx' && fd !== null) fds.add(fd);
        }
        resolve({ count: fds.size, error: null });
      });
  });
}

async function ptyExhaustion(error) {
  if (!isPtyExhausted(error)) return null;
  const held = await heldPtyMasters();
  if (held.error) console.error(`could not count Flow's PTY masters: ${held.error}`);
  const count = held.count;
  const holding = count == null ? 'Flow could not count its open PTY masters.' : `Flow holds ${count} PTY master${count === 1 ? '' : 's'}.`;
  return {
    ok: false,
    error: `The Mac is out of terminals. ${holding} Retrying automatically.`,
    code: 'ENXIO', errno: error.errno, syscall: error.syscall, ptyMasters: count, retry: true,
  };
}

async function runLocal(args) {
  await cfg.ready;
  if (!cfg.tmux) throw new Error('tmux was not found (looked for /opt/homebrew/bin/tmux and on PATH)');
  return exec(cfg.tmux, ['-u', '-L', cfg.socket, '-f', CONF, ...args], 10000);
}

function controlPath() {
  const dir = path.join('/tmp', 'flow-' + process.getuid());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
    throw new Error(`refusing to use ${dir} for ssh control sockets: it must be private to this user`);
  }
  return path.join(dir, 'cm-%C');
}

const sshArgs = (host, argv) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=' + controlPath(), '-o', 'ControlPersist=120', '--', host, argv.map(shq).join(' ')];

// After a failed connection, calls to that host fail with the same error until a backoff has passed (5 s, doubling up
// to 60 s), so an unreachable host does not get a new ssh for every pane poll. The first failure of a streak is logged.
function backingOff(host) {
  const down = hostDown.get(host);
  if (down && Date.now() < down.until) throw new Error(down.error);
}

function hostFailed(host, stderr) {
  const prev = hostDown.get(host);
  const failures = prev ? prev.failures + 1 : 1;
  const error = `ssh ${host}: ${stderr || 'connection failed'}`;
  hostDown.set(host, { failures, until: Date.now() + Math.min(60000, 5000 * 2 ** (failures - 1)), error });
  if (!prev) console.error(`[flow] ${error}`);
  return error;
}

// The Mac's network is back or Flow came to the front again (vmfiles.retryNow): the next ssh to host runs at once and a
// failure starts a new streak.
function sshRetry(host) {
  hostDown.delete(checkHost(host));
}

async function sshExec(host, argv, timeout = 25000) {
  await cfg.ready;
  backingOff(host);
  const r = await exec(SSH, sshArgs(host, argv), timeout);
  if (r.code === 255) throw new Error(hostFailed(host, r.stderr));
  hostDown.delete(host);
  return r;
}

// sshExec for a long or binary transfer (vmfiles.js): the ssh process itself, stdout and stderr as Buffers, stdin a pipe
// when opts.stdin. The same connection, options and backoff; a process ended early with kill() leaves the backoff as is.
async function sshSpawn(host, argv, opts) {
  await cfg.ready;
  const h = checkHost(host);
  backingOff(h);
  const child = spawn(...spawnable(SSH, sshArgs(h, argv)), { env: cfg.env, stdio: [opts && opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  // A failed spawn (EAGAIN, EMFILE) is reported on nextTick: with this listener it can never be an uncaught error, even
  // for a caller that listens late; callers' own listeners get it too.
  child.on('error', (e) => console.error(`[flow] ssh to ${h} could not start: ${e.message}`));
  let stderr = '';
  child.stderr.on('data', (b) => { if (stderr.length < 4000) stderr += b; });
  child.on('close', (code) => {
    if (code === 255) hostFailed(h, stderr.trim());
    else if (code !== null) hostDown.delete(h);
  });
  return child;
}

// own: Flow's own tmux server on that host (the same socket name as here), not the host's default server.
const runRemote = (host, args, own) => sshExec(host, own ? ['tmux', '-L', cfg.socket, ...args] : ['tmux', ...args]);

// On a host, the sessions Flow makes live on Flow's own tmux server, with Flow's conf; an attach window (ccm) is a session
// of the host's default server. A flow_<id> session already on the default server stays there (made before Flow had its
// own server there, or broken out of an attach window's team: a pane cannot move between servers).
function remoteFor(id, opts) {
  const sid = sanitize(id);
  if (opts && typeof opts === 'object' && opts.host) {
    const host = checkHost(opts.host);
    const attach = opts.attach ? String(opts.attach) : null;
    if (attach && !exactAttachTarget(attach)) throw new Error(`invalid tmux attach target: ${attach}`);
    const known = remotes.get(sid);
    if (known && known.host === host && known.attach === attach) return known;
    const r = { host, attach, own: !attach, located: !!attach };
    remotes.set(sid, r);
    return r;
  }
  return remotes.get(sid) || null;
}

// Finds the server a Flow session of that host is on, once per run: Flow's own, else the default one; a new session goes
// to Flow's own server.
async function locate(sid, remote) {
  if (remote.located) return;
  const target = ['has-session', '-t', '=flow_' + sid];
  const own = await runRemote(remote.host, target, true);
  if (own.code !== 0 && !noServer(own.stderr) && !noTarget(own.stderr)) throw new Error(`tmux has-session on ${remote.host}: ${own.stderr}`);
  if (own.code !== 0) {
    const other = await runRemote(remote.host, target, false);
    if (other.code !== 0 && !noServer(other.stderr) && !noTarget(other.stderr)) throw new Error(`tmux has-session on ${remote.host}: ${other.stderr}`);
    if (other.code === 0) remote.own = false;
  }
  remote.located = true;
}

async function remoteAt(id, opts) {
  const remote = remoteFor(id, opts);
  if (remote) await locate(sanitize(id), remote);
  return remote;
}

// Flow's tmux conf goes to ~/.flow/flow-tmux.conf on the host before Flow's first session there in this run, and into
// Flow's server there if it is already up (as on this Mac).
const HOST_CONF = '.flow/flow-tmux.conf';
function sendConf(host) {
  if (!confSent.has(host)) {
    const write = 'umask 077 && mkdir -p "$HOME/.flow" && printf %s "$1" > "$HOME/.flow/flow-tmux.conf.$$" && ' +
      'mv -f "$HOME/.flow/flow-tmux.conf.$$" "$HOME/.flow/flow-tmux.conf" && printf %s "$HOME"';
    confSent.set(host, (async () => {
      const w = await sshExec(host, ['sh', '-c', write, 'sh', fs.readFileSync(CONF, 'utf8')]);
      if (w.code !== 0) throw new Error(`could not write ~/${HOST_CONF} on ${host}: ${w.stderr}`);
      const r = await runRemote(host, ['source-file', `${w.stdout}/${HOST_CONF}`], true);
      if (r.code !== 0 && !noServer(r.stderr)) console.error(`[flow] could not load ~/${HOST_CONF} into Flow's tmux server on ${host}: ${r.stderr}`);
    })().catch((e) => {
      confSent.delete(host);
      throw e;
    }));
  }
  return confSent.get(host);
}

// A command line for the host's shell: strings are quoted, { raw } pieces are left for that shell (to expand $HOME).
const hostLine = (args) => args.map((a) => (typeof a === 'string' ? shq(a) : a.raw)).join(' ');
const hostPath = (p) => (p === '~' ? { raw: '"$HOME"' } : p.startsWith('~/') ? { raw: '"$HOME"/' + shq(p.slice(2)) } : p);

function checkHost(host) {
  const h = String(host).trim();
  if (!HOST_RE.test(h) || h.startsWith('-')) throw new Error('invalid ssh host: ' + h);
  return h;
}

// Session (or window) target for tmux -t. Exact matching prevents a saved `ccm` target from resolving to `ccm-old`.
const ATTACH_PART = '[A-Za-z0-9_.-]+';
const attachParts = (attach) => new RegExp(`^(${ATTACH_PART})(?::(${ATTACH_PART}))?$`).exec(String(attach || ''));
const exactAttachTarget = (attach) => {
  const m = attachParts(attach);
  return m ? `=${m[1]}${m[2] ? `:${/^\d+$/.test(m[2]) ? m[2] : `=${m[2]}`}` : ''}` : '';
};
const attachIsWindow = (attach) => !!(attachParts(attach) || [])[2];
const sessionTarget = (sid, remote) => (remote && remote.attach ? exactAttachTarget(remote.attach) || '__invalid_attach__' : '=flow_' + sid);
const windowTarget = (t) => (t.includes(':') ? t : t + ':');
const runner = (remote) => (remote ? (args) => runRemote(remote.host, args, remote.own) : runLocal);

// ---------- clients ----------

function flush(c) {
  if (c.timer) {
    clearTimeout(c.timer);
    c.timer = null;
  }
  if (!c.chunks.length) return;
  const data = c.chunks.length === 1 ? c.chunks[0] : c.chunks.join('');
  c.chunks = [];
  c.size = 0;
  c.sent = performance.now();
  if (!c.quiet && !c.wc.isDestroyed()) c.wc.send('term:data', c.id, data);
}

// A key's echo (a few bytes after a quiet spell) goes to the window at once. Anything larger waits FLUSH_MS for the
// rest of it, so a screen redrawn in several reads still reaches the window whole, and a burst still costs at most one
// message per FLUSH_MS.
function queue(c, data) {
  if (c.quiet) return;
  c.chunks.push(data);
  c.size += data.length;
  if (c.size >= FLUSH_BYTES) flush(c);
  else if (!c.timer) {
    if (c.size <= ECHO_BYTES && performance.now() - (c.sent || -Infinity) >= FLUSH_MS) flush(c);
    else c.timer = setTimeout(() => flush(c), FLUSH_MS);
  }
}

function onClientExit(c, exitCode, signal) {
  if (!c.quiet) flush(c);
  if (clients.get(c.key) === c) clients.delete(c.key);
  if (!c.quiet && !c.quietExit && !c.wc.isDestroyed()) {
    c.wc.send('term:exit', c.id, typeof exitCode === 'number' ? exitCode : (signal ? 128 + signal : 0));
  }
}

// Ends one client without telling its window (detach, re-open, window gone).
function drop(c) {
  c.quiet = true;
  if (c.timer) clearTimeout(c.timer);
  c.timer = null;
  c.chunks = [];
  if (clients.get(c.key) === c) clients.delete(c.key);
  try {
    c.proc.kill();
  } catch (e) {
    if (e.code !== 'ESRCH') console.error(`[flow] could not stop the tmux client of ${c.id}: ${e.message}`);
  }
}

function spawnClient(wc, id, file, args, cols, rows, cwd) {
  const proc = nodePty.spawn(...spawnable(file, args), { name: 'xterm-256color', cols, rows, cwd, env: cfg.env });
  const c = { key: keyOf(wc.id, id), id, wcId: wc.id, wc, proc, chunks: [], size: 0, timer: null, quiet: false, quietExit: false };
  clients.set(c.key, c);
  running.add(c);
  proc.onData((d) => queue(c, d));
  proc.onExit(({ exitCode, signal }) => {
    running.delete(c);
    if (whenIdle && !running.size) whenIdle();
    onClientExit(c, exitCode, signal);
  });
  return c;
}

// A fork (forkFrom: the parent's session id) starts as a copy of the parent under its own id; once its own transcript
// exists it always resumes that, so a restart never forks the parent again.
function claudeArgs(sessionId, resume, forkFrom) {
  if (!sessionId) return '';
  if ((resume || forkFrom) && transcriptExists(sessionId)) return ' --resume ' + sessionId;
  if (forkFrom && transcriptExists(forkFrom)) return ' --resume ' + forkFrom + ' --fork-session --session-id ' + sessionId;
  return ' --session-id ' + sessionId;
}

function localCommand(cmd, sessionId, resume, forkFrom) {
  if (cmd === 'shell') return ['/bin/zsh', '-il'];
  return ['/bin/zsh', '-ilc', shq(resolveClaude()) + claudeArgs(sessionId, resume, forkFrom) + '; exec /bin/zsh -il'];
}
function localRecoveryCommand(sessionId) {
  return ['/bin/zsh', '-lc', shq(resolveClaude()) + claudeArgs(sessionId, true, null) + '; exec /bin/zsh -il'];
}

// Runs on the remote host through tmux's default-shell, so $SHELL is the remote user's shell and the
// transcript check happens over there.
function remoteClaude(sessionId, resume, forkFrom) {
  let inner = 'claude';
  const has = (sid) => `[ -n "$(find "$HOME/.claude/projects" -maxdepth 2 -name '${sid}.jsonl' -print 2>/dev/null | head -n 1)" ]`;
  if (sessionId && (resume || forkFrom)) {
    inner = `if ${has(sessionId)}; then claude --resume ${sessionId}; ` +
      (forkFrom
        ? `elif ${has(forkFrom)}; then claude --resume ${forkFrom} --fork-session --session-id ${sessionId}; ` +
          `else echo 'flow: cannot fork: session ${forkFrom} has no transcript on this host'; fi`
        : `else claude --session-id ${sessionId}; fi`);
  } else if (sessionId) {
    inner = 'claude --session-id ' + sessionId;
  }
  return 'exec "$SHELL" -lic ' + shq(inner + '; exec "$SHELL" -l');
}

// Opens and kills of one terminal: an open starts once every open and kill of it before has settled, so it never finds a
// session an end is still taking down. A kill applies at once: an open of it still in flight (checking who holds its
// conversation, waiting for an ended claude, making its session) then stops and starts nothing, or ends the session it
// has just made, so no claude starts only to be ended and no session runs on with no window.
const turns = new Map();   // terminal id -> its last open or kill, until it settles
const ends = new Map();    // terminal id -> how many kills of it came while its turns were in flight
const ENDED_FIRST = 'ended before it started';
function inTurn(sid, mine) {
  turns.set(sid, mine);
  const settled = () => {
    if (turns.get(sid) !== mine) return;
    turns.delete(sid);
    ends.delete(sid);
  };
  mine.then(settled, settled);
  return mine;
}

function open(wc, opts) {
  const sid = sanitize(opts && typeof opts === 'object' ? opts.id : '');
  const at = ends.get(sid) || 0;
  const run = () => openNow(wc, opts, () => (ends.get(sid) || 0) !== at);
  return inTurn(sid, (turns.get(sid) || Promise.resolve()).then(run, run));
}

async function openNow(wc, opts, ended) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const id = o.id == null ? '' : String(o.id);
  const sid = sanitize(id);
  const result = (fields) => Object.assign({ ok: false, created: false, cwd: '', cwdMissing: false, error: null }, fields);
  if (!sid) return result({ error: 'terminal id is empty' });
  if (o.cmd != null && o.cmd !== 'claude' && o.cmd !== 'shell') return result({ error: `cmd must be 'claude' or 'shell', got ${o.cmd}` });
  const cmd = o.cmd || 'claude';
  let sessionId = null;
  if (o.sessionId != null && o.sessionId !== '') {
    if (!UUID_RE.test(String(o.sessionId))) return result({ error: 'sessionId must be a UUID, got ' + o.sessionId });
    sessionId = String(o.sessionId);
  }
  let forkFrom = null;
  if (o.forkFrom != null && o.forkFrom !== '') {
    if (!UUID_RE.test(String(o.forkFrom))) return result({ error: 'forkFrom must be a UUID, got ' + o.forkFrom });
    if (!sessionId) return result({ error: 'forkFrom needs the new session id in sessionId' });
    forkFrom = String(o.forkFrom);
  }
  await cfg.ready;
  const cols = toInt(o.cols, 80, 2, 2000);
  const rows = toInt(o.rows, 24, 1, 1000);
  const prev = clients.get(keyOf(wc.id, id));
  if (prev) drop(prev);

  let remote;
  try {
    remote = remoteFor(id, o);
  } catch (e) {
    return result({ error: e.message });
  }

  if (remote) {
    try {
      await waitRecoveryProcesses(sid, remote);
    } catch (e) {
      return result({ cwd: HOME, error: e.message, retry: true });
    }
    const name = 'flow_' + sid;
    let created = false;
    let remoteLine;
    let size = null;
    if (remote.attach) {
      // ignore-size: Flow's client never resizes the shared window the owner and the agents also see. tmux honors it only
      // while another client is attached, so the client also starts at the window's own size plus its status lines,
      // which keeps the window as it is when Flow is its only client; term.js shows it at that size.
      remoteLine = hostLine(['tmux', '-u', 'attach', '-f', 'ignore-size', '-t', exactAttachTarget(remote.attach)]);
      try {
        size = await windowSize(remote);
      } catch (e) {
        if (!hostDown.has(remote.host)) console.error(`[flow] ${e.message}`);   // a failed connection is logged once by runRemote
      }
    } else {
      // The interactive ssh below shows a connection problem in the terminal; runRemote logged it once.
      try {
        await locate(sid, remote);
        if (remote.own) await sendConf(remote.host);
        created = (await runRemote(remote.host, ['has-session', '-t', '=' + name], remote.own)).code !== 0;
      } catch (e) {
        if (!hostDown.has(remote.host)) console.error(`[flow] ${e.message}`);
      }
      // cwd: a folder on that host; a folder missing there starts in its home
      const start = (own) => hostLine(['tmux', '-u', ...(own ? ['-L', cfg.socket, '-f', { raw: `"$HOME"/${HOST_CONF}` }] : []), 'new-session', '-A', '-s', name,
        ...(o.cwd ? ['-c', hostPath(String(o.cwd))] : []), '-x', String(cols), '-y', String(rows), ...(cmd === 'claude' ? [remoteClaude(sessionId, !!o.resume, forkFrom)] : [])]);
      // Server not known (the checks above failed): the host picks it, so a session on its default server is never
      // started a second time on Flow's server.
      remoteLine = remote.located ? start(remote.own) : `if ${hostLine(['tmux', 'has-session', '-t', '=' + name])} 2>/dev/null && ! ` +
        `${hostLine(['tmux', '-L', cfg.socket, 'has-session', '-t', '=' + name])} 2>/dev/null; then exec ${start(false)}; else exec ${start(true)}; fi`;
    }
    if (ended()) return result({ cwd: HOME, error: ENDED_FIRST });
    try {
      spawnClient(wc, id, SSH, ['-t', '--', remote.host, remoteLine], size ? size.cols : cols, size ? size.rows : rows, HOME);
    } catch (e) {
      const exhausted = await ptyExhaustion(e);
      if (exhausted) return result({ cwd: HOME, ...exhausted });
      return result({ cwd: HOME, error: 'could not start ssh: ' + e.message });
    }
    return result(size ? { ok: true, created, cwd: HOME, size } : { ok: true, created, cwd: HOME });
  }

  if (!cfg.tmux) return result({ error: 'tmux was not found (looked for /opt/homebrew/bin/tmux and on PATH)' });
  let cwd = o.cwd ? expandHome(String(o.cwd)) : HOME;
  if (!path.isAbsolute(cwd)) cwd = path.resolve(HOME, cwd);
  const name = 'flow_' + sid;
  let existed;
  try {
    existed = await hasSession(name);
  } catch (e) {
    return result({ error: e.message });
  }
  if (!existed && forkFrom && !transcriptExists(sessionId) && !transcriptExists(forkFrom)) {
    return result({ cwd, error: `cannot fork: session ${forkFrom} has no transcript in ${path.join(claudeDir(), 'projects')}` });
  }
  if (!existed && cmd === 'claude' && sessionId) {
    try {
      await holdersOf(sid, sessionId, ended);
      await untilEnded([sessionId, forkFrom].filter(Boolean), ended);
    } catch (e) {
      return result({ cwd, error: e.message, ...(e.retry ? { retry: true } : {}) });
    }
  }
  let cwdMissing = false;
  if (!isDir(cwd)) {
    if (!existed) cwdMissing = true;
    cwd = HOME;
  }
  // The command is always passed: with -A it is ignored when the session exists, and it is used if
  // the session ended between the check above and this spawn.
  const args = ['-u', '-L', cfg.socket, '-f', CONF, 'new-session', '-A', '-s', name, '-c', cwd,
    ...Object.entries(TRUECOLOR_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-x', String(cols), '-y', String(rows), ...localCommand(cmd, sessionId, !!o.resume, forkFrom)];
  if (ended()) return result({ cwd, cwdMissing, error: ENDED_FIRST });
  let c;
  try {
    c = spawnClient(wc, id, cfg.tmux, args, cols, rows, cwd);
  } catch (e) {
    const exhausted = await ptyExhaustion(e);
    if (exhausted) return result({ cwd, cwdMissing, ...exhausted });
    return result({ cwd, cwdMissing, error: 'could not start tmux: ' + e.message });
  }
  // Resolve once the session exists, so list/panes/exists right after open see it.
  if (!existed) {
    const end = Date.now() + 3000;
    while (Date.now() < end && clients.get(c.key) === c && !(await hasSession(name))) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // an end that came while tmux was making the session may have found none to kill
    if (ended()) {
      drop(c);
      await endSession(sid, null);
      return result({ cwd, cwdMissing, error: ENDED_FIRST });
    }
  }
  return result({ ok: true, created: !existed, cwd, cwdMissing });
}

// An attached window's size as a client needs it: cols x (window rows + status lines), status = the number of status
// lines (tmux's status option: off, on, or 2 to 5).
async function windowSize(remote) {
  const target = windowTarget(exactAttachTarget(remote.attach));
  if (!target) throw new Error(`invalid tmux attach target: ${remote.attach}`);
  const r = await runRemote(remote.host, ['display-message', '-p', '-t', target, '#{window_width} #{window_height} #{status}'], false);
  if (r.code !== 0) throw new Error(`tmux display-message -t ${remote.attach} on ${remote.host}: ${r.stderr}`);
  const [w, h, st] = r.stdout.trim().split(' ');
  const status = st === 'off' ? 0 : st === 'on' ? 1 : /^[2-5]$/.test(st) ? Number(st) : NaN;
  if (!/^\d+$/.test(w) || !/^\d+$/.test(h) || Number.isNaN(status)) throw new Error(`unexpected size of ${remote.attach} on ${remote.host}: ${r.stdout.trim()}`);
  return { cols: Number(w), rows: Number(h) + status, status };
}

function write(wcId, id, data) {
  const c = clients.get(keyOf(wcId, String(id)));
  if (!c || typeof data !== 'string' || !data) return;
  c.proc.write(data);
}

function resize(wcId, id, cols, rows) {
  const c = clients.get(keyOf(wcId, String(id)));
  if (!c) return;
  try {
    c.proc.resize(toInt(cols, 80, 2, 2000), toInt(rows, 24, 1, 1000));
  } catch (e) {
    console.error(`[flow] resize of ${c.id} failed: ${e.message}`);
  }
}

function detach(wcId, id) {
  const c = clients.get(keyOf(wcId, String(id)));
  if (c) drop(c);
}

function detachAll(wcId) {
  for (const c of [...clients.values()]) if (c.wcId === wcId) drop(c);
}

function idle(ms) {
  if (!running.size) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      whenIdle = null;
      resolve(false);
    }, ms);
    whenIdle = () => {
      clearTimeout(timer);
      whenIdle = null;
      resolve(true);
    };
  });
}

// Ends every client and resolves once each one's process has reported its exit. node-pty reports exits from a helper
// thread; a report still queued when Electron frees the Node environment throws where nothing catches it, which aborts
// the app (MAC_NOTES 11). A client still running after timeoutMs gets SIGKILL.
async function shutdown(timeoutMs = 2000) {
  for (const c of [...clients.values()]) drop(c);
  const count = running.size;
  if (!count) return;
  const started = Date.now();
  if (!(await idle(timeoutMs))) {
    for (const c of running) {
      console.error(`[flow] the tmux client of ${c.id} (pid ${c.proc.pid}) did not exit within ${timeoutMs} ms of quitting; sending SIGKILL`);
      try {
        c.proc.kill('SIGKILL');
      } catch (e) {
        // ESRCH: the process is gone and only its exit report is still on the way; keep waiting for it.
        if (e.code !== 'ESRCH') console.error(`[flow] could not SIGKILL the tmux client of ${c.id}: ${e.message}`);
      }
    }
    if (!(await idle(1000))) {
      for (const c of running) console.error(`[flow] the tmux client of ${c.id} (pid ${c.proc.pid}) did not exit after SIGKILL`);
    }
  }
  console.log(`[flow] quit: ${count - running.size} of ${count} terminal clients exited in ${Date.now() - started} ms`);
}

// ---------- session control ----------

async function hasSession(name) {
  const r = await runLocal(['has-session', '-t', '=' + name]);
  if (r.code === 0) return true;
  if (noServer(r.stderr) || noTarget(r.stderr)) return false;
  throw new Error('tmux has-session: ' + r.stderr);
}

// A claude keeps writing to its conversation for a while after its session is killed (its cost-state line about 2 s
// later) and exits up to 11 s later here, so kill() keeps each claude of the session until it has exited, and open()
// starts a claude on the same conversation only after that (main's sessions:running leaves these out meanwhile).
const ending = new Map(); // pid -> { at, sessionId }
const ENDING_MAX_MS = 120000;
const ENDING_WAIT_MS = 30000;
const SESSION_ARG = /(?:^|\s)(?:--session-id|--resume|-r)(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;
const FORK_ARG = /(?:^|\s)--session-id(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;
