'use strict';
// A workspace's files on the VM (ws.host, ws.hostFolder) for files-main.js, with the same calls and the same rows as a
// folder on the Mac. Every call goes through pty.js's ssh helper (init's spawn): the same ControlMaster connection,
// options and per-host backoff as the rest of Flow.
// Only folders a window shows are watched. Per host, one ssh session runs WATCH_SH on the VM, which lists each of them
// one level deep every tick and sends a folder only when its names changed, otherwise a heartbeat, so the Mac starts no
// process and parses nothing while nothing changes. A file is shown from a private temp copy on the Mac, refreshed when
// it is opened or loaded; when the file only grew, just the new bytes come.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOST_RE = /^[A-Za-z0-9_.@%+:[\]-]+$/;
const MAX_ENTRIES = 5000;
const MAX_OPEN = 256 * 1024 * 1024;
const OVERLAP = 4096;
const SESSIONS = 4;       // listings, fetches and uploads per host at once; sshd allows 10 sessions per connection by default
const MADE_KEEP_DAYS = 7; // a Flow folder put() makes (pasted images) keeps a week of files
const FRESH_MS = 1500;    // a copy this young serves as is (a click opens it, then its page loads it)
const SEEN_MAX = 256;

const DIR = 'd\0';    // keys of what a window watches: a folder's path, or a file's
const FILE = 'f\0';
const UNREACHABLE = 'the VM is not reachable';
const OUTSIDE = 'not in a workspace folder';
// The words files-main.js uses for a folder or file on the Mac.
const WORDS = { missing: 'not there', notdir: 'not a folder', denied: 'no access', folder: 'a folder', notfile: 'not a file' };

// The VM resolves a path the way its shells do: '~' and relative paths start at the home folder.
const AT = 'at() { case $1 in "~") p=$HOME ;; "~/"*) p=$HOME/${1#"~/"} ;; /*) p=$1 ;; *) p=$HOME/$1 ;; esac; }';

// Arguments: tick seconds, lifetime seconds, then (kind, path, hash last seen) triples, kind d for a folder, f for a file.
// For each folder whose listing changed it writes "D<TAB>i<TAB>hash<TAB>bytes\n" and that many bytes (the folder's path
// NUL, type<TAB>name NUL per entry not starting with a dot, at most MAX_ENTRIES + 1 of them, then "#<count>" NUL), or
// "E<TAB>i<TAB>missing|notdir|denied\n"; for each file whose size or time changed, "F<TAB>i<TAB>size:mtime|missing\n";
// then ".\n" once per tick. It ends at its lifetime, or at its first write after the session closed.
const WATCH_SH = `${AT}
t=$(mktemp) || exit 1
trap 'rm -f "$t"' EXIT
trap 'exit 1' PIPE HUP INT TERM
tick=$1; end=$(( $(date +%s) + $2 )); shift 2
while :; do
  i=0; n=$(( $# / 3 ))
  while [ "$i" -lt "$n" ]; do
    k=$1; d=$2; h=$3; shift 3
    at "$d"
    if [ "$k" = f ]; then
      g=$(stat -L -c '%s:%.9Y' -- "$p" 2>/dev/null) || g=missing
      [ "$g" = "$h" ] || printf 'F\\t%s\\t%s\\n' "$i" "$g" || exit 1
      set -- "$@" "$k" "$d" "$g"; i=$((i + 1))
      continue
    fi
    if [ ! -e "$p" ]; then g=missing
    elif [ ! -d "$p" ]; then g=notdir
    elif [ ! -r "$p" ] || [ ! -x "$p" ]; then g=denied
    else
      { printf '%s\\0' "$p"; find -L "$p" -mindepth 1 -maxdepth 1 ! -name '.*' -printf '%y\\t%f\\0' 2>/dev/null | head -z -n ${MAX_ENTRIES + 1}; } > "$t"
      c=$(( $(tr -cd '\\0' < "$t" | wc -c) - 1 ))
      [ "$c" -le ${MAX_ENTRIES} ] || c=$(find -L "$p" -mindepth 1 -maxdepth 1 ! -name '.*' -printf . 2>/dev/null | wc -c)
      printf '#%s\\0' "$c" >> "$t"
      g=$(md5sum < "$t"); g=\${g%% *}
    fi
    if [ "$g" != "$h" ]; then
      case $g in
        missing|notdir|denied) printf 'E\\t%s\\t%s\\n' "$i" "$g" || exit 1 ;;
        *) { printf 'D\\t%s\\t%s\\t%s\\n' "$i" "$g" "$(wc -c < "$t")" && cat "$t"; } || exit 1 ;;
      esac
    fi
    set -- "$@" "$k" "$d" "$g"; i=$((i + 1))
  done
  printf '.\\n' || exit 1
  [ "$(date +%s)" -lt "$end" ] || exit 0
  sleep "$tick"
done`;

// Arguments: path, offset, size cap (0: none). Writes one word and a newline, or "F size mtime<TAB>home\\0path\\0" (home:
// the VM's $HOME) and the file's bytes from offset on.
const FETCH_SH = `${AT}
at "$1"
if [ ! -e "$p" ]; then echo missing; exit 0; fi
if [ -d "$p" ]; then echo folder; exit 0; fi
if [ ! -f "$p" ]; then echo notfile; exit 0; fi
if [ ! -r "$p" ]; then echo denied; exit 0; fi
s=$(stat -L -c '%s %.9Y' -- "$p") || { echo missing; exit 0; }
if [ "$3" -gt 0 ] && [ "\${s%% *}" -gt "$3" ]; then echo "toobig \${s%% *}"; exit 0; fi
printf 'F %s\\t%s\\0%s\\0' "$s" "$HOME" "$p" && exec tail -c +"$(( $2 + 1 ))" -- "$p"`;

// Arguments: folder, name without extension, extension, size, "make" to create the folder (private to its user), and
// a number of days: files in that folder older than that are removed first (a Flow folder that fills up, as pasted
// images do). Stores stdin under a name nothing has yet ("name (1).ext" on a clash, as downloads do) and writes
// "P<TAB>path\\0", or one word and a newline.
const PUT_SH = `${AT}
at "$1"
[ "$5" != make ] || { mkdir -p -m 700 -- "$p" 2>/dev/null; chmod 700 -- "$p" 2>/dev/null; }
[ -d "$p" ] || { echo missing; exit 0; }
p=\${p%/}; f=$p/$2$3; k=1
case $6 in [1-9]*) find "$p" -mindepth 1 -maxdepth 1 -type f -mtime +"$6" -exec rm -f -- {} + 2>/dev/null ;; esac
until (set -C; : > "$f") 2>/dev/null; do
  [ -e "$f" ] || [ -L "$f" ] || { echo denied; exit 0; }
  f="$p/$2 ($k)$3"; k=$((k + 1))
done
if cat > "$f" && [ "$(stat -c %s -- "$f")" = "$4" ]; then printf 'P\\t%s\\0' "$f"; exit 0; fi
rm -f -- "$f"; echo short`;

const DEFAULTS = { spawn: null, cacheDir: null, downloads: null, openPath: null, files: null, maxOpen: MAX_OPEN, freshMs: FRESH_MS, tick: 2,
  life: 600, watchdogMs: null, debounceMs: 30, retryMs: 5000, retryMaxMs: 60000, sshRetry: null };
const cfg = { ...DEFAULTS };
const hosts = new Map();    // host -> watch state, while a window shows a folder there
const seen = new Map();     // `${host}\0${dir}` -> { hash, result } of a one-time listing, so a watch starting next can use it
const copies = new Map();   // `${host}\0${absolute path}` -> { file, size, mtime, at } of a VM file's temp copy
const aliases = new Map();  // `${host}\0${path as asked}` -> its absolute path on the VM
const homes = new Map();    // host -> the VM's $HOME, from every fetch
const changedAt = new Map(); // `${host}\0${absolute path}` -> when the watch last saw that open file change
const away = new Set();     // `${host}\0${absolute path}` of files whose last fetch found the VM not reachable
const pending = new Map();  // `${host}\0${path as asked}` -> refresh of its copy in flight
const queues = new Map();   // host -> { busy, waiting[] }
const children = new Set(); // listing, fetch and upload processes, ended by shutdown()

/* o: { spawn(host, argv, { stdin }) -> ChildProcess or a Promise of one (pty.js's sshSpawn), cacheDir (in userData),
   downloads (where copy() puts a VM file by default: the folder page downloads go to), openPath(file) (shell.openPath),
   files (files-main.js, for compare, kindOf and respond), and timings for tests }. Called once at start. */
function init(o) {
  if (!o || typeof o.spawn !== 'function') throw new TypeError('vmfiles.init needs spawn(host, argv, { stdin })');
  for (const k of Object.keys(DEFAULTS)) cfg[k] = o[k] != null ? o[k] : DEFAULTS[k];
  if (cfg.watchdogMs == null) cfg.watchdogMs = cfg.tick * 3000 + 10000;
  if (!cfg.cacheDir) cfg.cacheDir = path.join(os.tmpdir(), 'flow-vm-' + process.getuid());
  clearOldRuns();
}

// Each run keeps its copies in <cacheDir>/<pid>. Nothing reads them once that Flow has quit, so a start removes the
// folder of every run whose process is gone; a Flow still running keeps its own.
function clearOldRuns() {
  let names;
  try {
    names = fs.readdirSync(cacheRoot());
  } catch (e) {
    console.error(`[flow] vmfiles could not clear old copies: ${e.message}`);
    return;
  }
  for (const n of names) {
    if (/^\d+$/.test(n) && (Number(n) === process.pid || alive(Number(n)))) continue;
    fs.rmSync(path.join(cfg.cacheDir, n), { recursive: true, force: true });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true;
    throw e;
  }
}

// ---------- helpers ----------

const files = () => cfg.files || (cfg.files = require('./files-main'));
const keyOf = (host, p) => host + '\0' + p;
const fail = (error) => ({ ok: false, error });

function checkHost(host) {
  const h = String(host == null ? '' : host).trim();
  if (!HOST_RE.test(h) || h.startsWith('-')) throw new Error('invalid ssh host: ' + h);
  return h;
}

function checkPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.length > 4096) throw new TypeError('not a path: ' + JSON.stringify(p));
  return p;
}

function localPath(p) {
  const s = checkPath(p);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  if (!path.isAbsolute(s)) throw new Error('not an absolute path: ' + s);
  return s;
}

function sizeText(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB';
  if (n >= 1 << 20) return Math.round(n / (1 << 20)) + ' MB';
  return Math.ceil(n / 1024) + ' KB';
}

function lastLine(s) {
  const lines = String(s || '').trim().split('\n');
  return lines[lines.length - 1] || '';
}

function wordError(word) {
  if (WORDS[word]) return WORDS[word];
  if (word.startsWith('toobig ')) return `too big to open (${sizeText(Number(word.slice(7)))})`;
  return 'unexpected answer from the VM: ' + word.slice(0, 200);
}

async function spawn(host, argv, stdin) {
  if (!cfg.spawn) throw new Error('vmfiles is not initialised');
  return cfg.spawn(host, argv, { stdin: !!stdin });
}

// At most SESSIONS listings, fetches and uploads per host at once; the rest wait their turn.
async function slot(host) {
  let q = queues.get(host);
  if (!q) queues.set(host, (q = { busy: 0, waiting: [] }));
