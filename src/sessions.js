'use strict';
// Index of every Claude Code session on this Mac (BRIEF 2.5): prompts from ~/.claude/history.jsonl
// grouped by sessionId, plus sessions that only exist as ~/.claude/projects/*/<uuid>.jsonl.
// Transcripts are read only at the head (cwd, first user text) and the tail (titles); both reads and
// the parsed history are cached by file mtime and size.
// search() (B4) asks sessions-index.js, in a worker thread, to search everything said in every transcript.
// running() (B1) lists the sessions a claude process has open right now.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');

const PROMPTS_CAP = 6000;
const HEAD = 64 * 1024;
const TAIL = 64 * 1024;
const PARALLEL = 32;
const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

let root = path.join(os.homedir(), '.claude');
const hist = { file: '', ino: 0, mtimeMs: -1, size: -1, offset: 0, map: new Map() };
const transcripts = new Map();   // path -> { mtimeMs, size, info }
let inflight = null;
// The parsed history and transcript heads also live in a file beside the search index, so after a restart list()
// re-reads only what changed instead of every transcript.
const listCache = { dirty: false, timer: null, lastWrite: 0, n: 0, tag: Math.random().toString(36).slice(2, 8) };

function setClaudeDir(dir) {
  if (dir && dir !== root) {
    root = dir;
    hist.mtimeMs = -1;
    transcripts.clear();
    runningMemo = null;
    stopIndex();
  }
}

function addPrompt(s, text) {
  if (s.promptsLen >= PROMPTS_CAP || !text) return;
  const room = PROMPTS_CAP - s.promptsLen;
  const piece = text.length > room ? text.slice(0, room) : text;
  s.prompts.push(piece);
  s.promptsLen += piece.length + 1;
}

// One read of history.jsonl at a time. Two at once read from the same offset, so one got a negative length once the
// file grew between them (two ⌘K searches at once: one failed) or counted new lines twice. Each read waits for the one
// before it, then reads what was added since: it sees the file as it was when it was asked for, at least.
let histLast = Promise.resolve();
function readHistory() {
  const run = histLast.then(() => readHistoryNow());
  histLast = Promise.allSettled([run]);
  return run;
}

async function readHistoryNow() {
  const file = path.join(root, 'history.jsonl');
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch (e) {
    if (e.code === 'ENOENT') {
      hist.map = new Map();
      return hist.map;
    }
    throw e;
  }
  if (hist.file === file && st.mtimeMs === hist.mtimeMs && st.size === hist.size) return hist.map;
  // history.jsonl is append-only: read just the new bytes unless it shrank or was replaced.
  if (hist.file !== file || hist.ino !== st.ino || st.size < hist.offset) {
    hist.map = new Map();
    hist.offset = 0;
  }
  listCache.dirty = true;
  const fh = await fs.promises.open(file, 'r');
  let text;
  try {
    const len = st.size - hist.offset;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, hist.offset);
    const end = buf.lastIndexOf(10, bytesRead - 1);
    if (end < 0) {
      text = '';
    } else {
      text = buf.toString('utf8', 0, end);
      hist.offset += end + 1;
    }
  } finally {
    await fh.close();
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      console.error(`[flow] skipped a malformed line in ${file}: ${e.message}`);
      continue;
    }
    if (!o || !o.sessionId) continue;
    let s = hist.map.get(o.sessionId);
    if (!s) {
      s = { id: o.sessionId, cwd: o.project || '', title: '', firstPrompt: '', prompts: [], promptsLen: 0, firstAt: o.timestamp || 0, lastAt: o.timestamp || 0, count: 0 };
      hist.map.set(o.sessionId, s);
    }
    const display = typeof o.display === 'string' ? o.display.trim() : '';
    s.count += 1;
    if (o.timestamp) {
      if (!s.firstAt || o.timestamp < s.firstAt) s.firstAt = o.timestamp;
      if (o.timestamp > s.lastAt) s.lastAt = o.timestamp;
    }
    if (!s.cwd && o.project) s.cwd = o.project;
    if (display) {
      if (!s.firstPrompt) s.firstPrompt = display;
      if (!s.title && !display.startsWith('/')) s.title = display;
      addPrompt(s, display);
    }
  }
  hist.file = file;
  hist.ino = st.ino;
  hist.mtimeMs = st.mtimeMs;
  hist.size = st.size;
  return hist.map;
}

// ---------- transcripts ----------

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

const META_TEXT = /^(<command-name>|<command-message>|<command-args>|<local-command-stdout>|<local-command-stderr>|<system-reminder>|<bash-input>|<bash-stdout>|<bash-stderr>|Caveat: |\[Request interrupted)/;

function cleanUserText(raw) {
  let text = String(raw || '').trim();
  if (!text || META_TEXT.test(text)) return '';
  const mate = text.match(/^<teammate-message\b[^>]*>([\s\S]*?)(<\/teammate-message>|$)/);
  if (mate) {
    text = mate[1].trim();
    if (text.startsWith('{')) {
      try {
        const o = JSON.parse(text);
        text = String(o.subject || o.summary || o.description || o.content || text);
      } catch (e) {
        // Not JSON after all: the message text itself is the title.
      }
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

function scanLines(text, info, isHead) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    // Parse only lines that can hold what the list shows: titles anywhere; in the head also the first lines (cwd and
    // time), prompts, queued prompts and agent or team names. Tool results and replies are the bulk and never count.
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) {
      if (!isHead || line.includes('"toolUseResult"')) continue;
      const meta = !info.cwd || !info.firstAt || (!info.agent && line.includes('"agentName"')) || (!info.team && line.includes('"teamName"'));
      if (!meta && !line.includes('"user"') && !line.includes('"queue-operation"')) continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      continue; // the cut at either end of a partial read
    }
    if (o.type === 'custom-title' && o.customTitle) info.customTitle = String(o.customTitle);
    else if (o.type === 'ai-title' && o.aiTitle) info.aiTitle = String(o.aiTitle);
    if (!isHead) continue;
    if (!info.cwd && typeof o.cwd === 'string') info.cwd = o.cwd;
    if (!info.firstAt && o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (Number.isFinite(t)) info.firstAt = t;
    }
    if (!info.agent && o.agentName) info.agent = String(o.agentName);
    if (!info.team && o.teamName) info.team = String(o.teamName);
    if (o.type === 'queue-operation' && o.operation === 'enqueue' && typeof o.content === 'string' && !info.queued) {
      info.queued = cleanUserText(o.content);
    }
    if (o.type === 'user' && !o.isMeta && o.message && !o.toolUseResult) {
      const t = cleanUserText(blockText(o.message.content));
      if (t) info.texts.push(t);
    }
  }
}

async function readTranscript(file, st) {
  const info = { cwd: '', firstAt: 0, texts: [], queued: '', customTitle: '', aiTitle: '', agent: '', team: '' };
  const fh = await fs.promises.open(file, 'r');
  try {
    if (st.size <= HEAD + TAIL) {
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      scanLines(buf.toString('utf8', 0, bytesRead), info, true);
    } else {
      const head = Buffer.alloc(HEAD);
      const h = await fh.read(head, 0, HEAD, 0);
      scanLines(head.toString('utf8', 0, h.bytesRead), info, true);
      const tail = Buffer.alloc(TAIL);
      const t = await fh.read(tail, 0, TAIL, st.size - TAIL);
      scanLines(tail.toString('utf8', 0, t.bytesRead), info, false);
    }
  } finally {
    await fh.close();
  }
  return info;
}

async function listTranscripts() {
  const dir = path.join(root, 'projects');
  let projects;
  try {
    projects = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const found = [];
  await Promise.all(projects.filter((d) => d.isDirectory()).map(async (d) => {
    const names = await fs.promises.readdir(path.join(dir, d.name));
    for (const name of names) {
      const m = UUID_FILE.exec(name);
      if (m) found.push({ id: m[1], file: path.join(dir, d.name, name) });
    }
  }));
  return found;
}

async function pool(items, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function build() {
  await loadListCache();
  const [history, files] = await Promise.all([readHistory(), listTranscripts()]);
  const seen = new Set();
  const byId = new Map();
  await pool(files, async ({ id, file }) => {
    seen.add(file);
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch (e) {
      if (e.code === 'ENOENT') return; // removed while listing
      throw e;
    }
    let cached = transcripts.get(file);
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      cached = { mtimeMs: st.mtimeMs, size: st.size, info: await readTranscript(file, st) };
      transcripts.set(file, cached);
      listCache.dirty = true;
    }
    const prev = byId.get(id);
    if (!prev || prev.mtimeMs < cached.mtimeMs) byId.set(id, cached);
  });
  for (const file of [...transcripts.keys()]) {
    if (seen.has(file)) continue;
    transcripts.delete(file);
    listCache.dirty = true;
  }
  if (listCache.dirty) scheduleListCache();

  const out = [];
  for (const s of history.values()) {
    const t = byId.get(s.id);
    const info = t ? t.info : null;
    out.push({
      id: s.id,
      cwd: s.cwd || (info && info.cwd) || '',
      title: (info && (info.customTitle || info.aiTitle)) || s.title || (info && info.texts[0]) || s.firstPrompt || '',
      prompts: s.prompts.join('\n'),
      firstAt: s.firstAt,
      lastAt: Math.max(s.lastAt, t ? Math.round(t.mtimeMs) : 0),
      count: s.count,
      resumable: !!t,
      agent: (info && info.agent) || '',
      team: (info && info.team) || '',
    });
  }
  for (const [id, t] of byId) {
    if (history.has(id)) continue;
    const info = t.info;
    const texts = info.texts.length ? info.texts : (info.queued ? [info.queued] : []);
    const acc = { prompts: [], promptsLen: 0 };
    for (const x of texts) addPrompt(acc, x);
    const firstText = texts.find((x) => !x.startsWith('/')) || texts[0] || '';
    out.push({
      id,
      cwd: info.cwd,
      title: info.customTitle || info.aiTitle || firstText,
      prompts: acc.prompts.join('\n'),
      firstAt: info.firstAt || Math.round(t.mtimeMs),
      lastAt: Math.round(t.mtimeMs),
      count: texts.length,
      resumable: true,
      agent: info.agent,
      team: info.team,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return out;
}

// ---------- the list cache ----------

function listCacheFile() {
  if (cacheDir) return path.join(cacheDir, 'list.json');
  if (process.type === 'browser') return path.join(require('electron').app.getPath('userData'), 'session-index', 'list.json');
  return '';
}

// Loaded once, before any read of history.jsonl: every build waits for the same load.
let listCacheLoad = null;
function loadListCache() {
  if (!listCacheLoad) listCacheLoad = loadListCacheNow();
  return listCacheLoad;
}

async function loadListCacheNow() {
  const file = listCacheFile();
  if (!file) return;
  let c;
  try {
    c = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[flow] session list: ignored the cache ${file}: ${e.message}`);
    return;
  }
  if (!c || c.v !== 1 || c.root !== root || !c.hist || !Array.isArray(c.hist.sessions) || !Array.isArray(c.transcripts)) return;
  if (!hist.file) {
    Object.assign(hist, { file: c.hist.file, ino: c.hist.ino, mtimeMs: c.hist.mtimeMs, size: c.hist.size, offset: c.hist.offset });
    hist.map = new Map(c.hist.sessions.map((x) => [x.id, x]));
  }
  for (const [f, t] of c.transcripts) if (!transcripts.has(f)) transcripts.set(f, t);
}

function listCacheDoc() {
  const h = { file: hist.file, ino: hist.ino, mtimeMs: hist.mtimeMs, size: hist.size, offset: hist.offset, sessions: [...hist.map.values()] };
  return JSON.stringify({ v: 1, root, hist: h, transcripts: [...transcripts] });
}

// Written 2 s after a list() that read something new, then at most once a minute, and at quit (stop).
function scheduleListCache() {
  if (listCache.timer || !listCacheFile()) return;
  const wait = listCache.lastWrite ? Math.max(2000, 60000 - (Date.now() - listCache.lastWrite)) : 2000;
  listCache.timer = setTimeout(() => {
    listCache.timer = null;
    writeListCache().catch((e) => console.warn(`[flow] session list: could not save the cache: ${e.message}`));
  }, wait);
  listCache.timer.unref();
}

async function writeListCache() {
  const file = listCacheFile();
  if (!file || !listCache.dirty) return;
  listCache.dirty = false;
  listCache.lastWrite = Date.now();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${listCache.tag}.${++listCache.n}.tmp`;
  await fs.promises.writeFile(tmp, listCacheDoc());
  await fs.promises.rename(tmp, file);
}

/* At quit: the index worker stops, and a list cache that is due is written now. */
function stop() {
  stopIndex();
  clearTimeout(listCache.timer);
  listCache.timer = null;
  const file = listCacheFile();
  if (!file || !listCache.dirty) return;
  listCache.dirty = false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${listCache.tag}.${++listCache.n}.tmp`;
  fs.writeFileSync(tmp, listCacheDoc());
  fs.renameSync(tmp, file);
}

/* search() marks running sessions from a list at most RUNNING_TTL old: listing processes and Flow's tmux panes on
   every keystroke costs about a second at a high load, and ⌘K asks running() itself right before it resumes anything. */
const RUNNING_TTL = 3000;
let runningMemo = null;   // { at, promise }
function runningRecent() {
  if (runningMemo && Date.now() - runningMemo.at < RUNNING_TTL) return runningMemo.promise;
  runningMemo = { at: Date.now(), promise: runningById() };
  return runningMemo.promise;
}

/* Sessions by id with their first running process, for search results. A failure to list processes is logged
   and leaves the results without a running mark rather than without the results. */
async function runningById() {
  const on = new Map();
  let live;
  try {
    live = await running();
  } catch (e) {
    console.error(`[flow] could not list running claude sessions: ${e.message}`);
    return on;
  }
  for (const r of live) if (!on.has(r.id)) on.set(r.id, r);
