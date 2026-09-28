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
  return on;
}

function list() {
  if (!inflight) inflight = build().finally(() => { inflight = null; });
  if (!indexTimer && !worker && (cacheDir || process.type === 'browser')) indexTimer = setTimeout(warmIndex, INDEX_DELAY).unref();
  return inflight;
}

/* Whether session id has a transcript here, so it can be forked (what list() calls resumable), without building the
   list: the file list() last saw for it, else one stat in each project folder. */
async function has(id) {
  const name = `${id}.jsonl`;
  if (typeof id !== 'string' || !UUID_FILE.test(name)) return false;
  const isFile = (file) => fs.promises.stat(file).then((st) => st.isFile(), (e) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  });
  for (const file of transcripts.keys()) {
    if (path.basename(file) === name && (await isFile(file))) return true;
  }
  const dir = path.join(root, 'projects');
  let projects;
  try {
    projects = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  const found = await Promise.all(projects.filter((d) => d.isDirectory()).map((d) => isFile(path.join(dir, d.name, name))));
  return found.includes(true);
}

// ---------- search (B4) ----------

const INDEX_DELAY = 15000;
let cacheDir = '';
let worker = null;
let workerDir = '';
// One index worker per folder in a process: a second copy of this module (a test loading it fresh inside the running
// app) would otherwise start its own worker on the same pack and both would write it.
const openDirs = process.__flowSessionIndexDirs || (process.__flowSessionIndexDirs = new Set());
let indexTimer = null;
let nextReq = 0;
const waiting = new Map();

function setCacheDir(dir) {
  if (dir && dir !== cacheDir) {
    cacheDir = dir;
    stopIndex();
  }
}

function indexDir() {
  if (cacheDir) return cacheDir;
  if (process.type === 'browser') return path.join(require('electron').app.getPath('userData'), 'session-index');
  throw new Error('flow sessions: no cache folder for the search index (call setCacheDir)');
}

function stopIndex() {
  clearTimeout(indexTimer);
  indexTimer = null;
  if (worker) {
    const w = worker;
    worker = null;
    openDirs.delete(workerDir);
    workerDir = '';
    w.terminate();
  }
}

function startIndex() {
  clearTimeout(indexTimer);
  indexTimer = null;
  if (worker) return worker;
  const dir = indexDir();
  if (openDirs.has(dir)) throw new Error(`the session index in ${dir} is already open in this process (is sessions.js loaded twice?)`);
  const w = new Worker(path.join(__dirname, 'sessions-index.js'), { workerData: { root, cacheDir: dir } });
  openDirs.add(dir);
  workerDir = dir;
  w.unref();
  const fail = (err) => {
    if (worker === w) {
      worker = null;
      openDirs.delete(dir);
      workerDir = '';
    }
    for (const { rej } of waiting.values()) rej(err);
    waiting.clear();
  };
  w.on('message', (m) => {
    const p = m && waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    if (m.error) p.rej(new Error(`session index: ${m.error}`));
    else p.res(m.result);
  });
  w.on('error', (err) => {
    console.error(`[flow] session index worker failed: ${err.stack || err}`);
    fail(err);
  });
  w.on('exit', (code) => {
    if (worker === w && code !== 0) console.error(`[flow] session index worker exited with code ${code}`);
    fail(new Error(`session index worker exited (code ${code})`));
  });
  worker = w;
  return w;
}

/* Starts indexing a while after the first list(), so the first ⌘K search finds a ready index. */
function warmIndex() {
  try {
    startIndex();
  } catch (e) {
    console.error(`[flow] could not start the session index: ${e.stack || e}`);
  }
}

function ask(msg) {
  const w = startIndex();
  const id = ++nextReq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    w.postMessage({ ...msg, id });
  });
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/* Every word of the query must appear in the session: in what you typed, what Claude replied, a compaction
   summary, the title or the folder. An exact phrase ranks first, then more matches, then the newest. */
async function search(query, opts) {
  if (opts && opts.meaning) return meaning(query, opts.items);
  const t0 = Date.now();
  const q = String(query == null ? '' : query).trim();
  const limit = Math.max(1, Math.min(500, Number(opts && opts.limit) || 50));
  const [found, all, on] = await Promise.all([q ? ask({ type: 'search', query: q, limit }) : ask({ type: 'status' }), build(), runningRecent()]);
  const byId = new Map(all.map((s) => [s.id, s]));
  // A session id or the start of one (⌘K finds a session by its id, as a resume command starts with it) comes first.
  const idq = /^[0-9a-f-]{4,36}$/i.test(q) && (q.match(/[0-9a-f]/gi) || []).length >= 4 ? q.toLowerCase() : '';
  const top = Math.max(0, ...(found.results || []).map((r) => r.score || 0)) + 1;
  const byIdq = idq ? all.filter((s) => s.id.startsWith(idq)).slice(0, limit).map((s) => ({ id: s.id, cwd: s.cwd, score: top, hits: [{ kind: 'id', text: s.id }] })) : [];
  const ids = new Set(byIdq.map((r) => r.id));
  const merged = [...byIdq, ...(found.results || []).filter((r) => !ids.has(r.id))].slice(0, limit);
  const results = merged.map((r) => {
    const s = byId.get(r.id);
    const cwd = (s && s.cwd) || r.cwd || '';
    return {
      id: r.id,
      cwd,
      title: (s && s.title) || '',
      firstAt: s ? s.firstAt : 0,
      lastAt: s ? s.lastAt : 0,
      count: s ? s.count : 0,
      resumable: s ? s.resumable : false,
      resume: cwd ? `cd ${shq(cwd)} && claude --resume ${r.id}` : `claude --resume ${r.id}`,
      running: on.get(r.id) || null,
      score: r.score,
      hits: r.hits,
    };
  });
  const total = (found.total || 0) + byIdq.filter((r) => !(found.results || []).some((x) => x.id === r.id)).length;
  return { query: q, ms: Date.now() - t0, scanMs: found.scanMs || 0, total, index: found.index, results };
}

// ---------- by meaning (owner Nov 7: "natural language search ... just like we built for the CLI code manager") ----------

/* The CLI code manager's search: gpt-5.4 without reasoning ranks by meaning. Here it ranks only candidates: the
   sessions that share the most telling words with the question (the index's any-word search) and the items ⌘K has
   in its workspaces, so a search sends a few thousand tokens, never every prompt ever typed. */
const MEANING_MODEL = 'gpt-5.4';
const CANDIDATES = 40;
const DIGEST = 360;
let keyNote = '';
function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const file = path.join(os.homedir(), 'Library', 'Application Support', 'MyNotes', 'config.json');
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw new Error(`could not read ${file}: ${e.message}`);
  }
  return (c && typeof c.openaiApiKey === 'string' && c.openaiApiKey) || '';
}
function respond(instructions, input) {
  const key = openaiKey();
  if (!key) {
    if (!keyNote) { keyNote = 'no OpenAI key (MyNotes config.json or OPENAI_API_KEY)'; console.warn(`[flow] search by meaning is off: ${keyNote}`); }
    return Promise.resolve(null);
  }
  const https = require('https');
  const body = JSON.stringify({ model: MEANING_MODEL, instructions, input, max_output_tokens: 600, reasoning: { effort: 'none' }, store: false, prompt_cache_key: 'flow-search' });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.openai.com', path: '/v1/responses', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let o;
        try {
          o = JSON.parse(data);
        } catch (e) {
          reject(new Error(`OpenAI answered HTTP ${res.statusCode} with no JSON`));
          return;
        }
        if (o.error) { reject(new Error(o.error.message || `OpenAI answered HTTP ${res.statusCode}`)); return; }
        resolve((o.output || []).filter((x) => x.type === 'message').flatMap((x) => x.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('').trim());
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('OpenAI did not answer within 30 s')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
const digest = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= DIGEST ? s : `${s.slice(0, 240)} … ${s.slice(-110)}`; };

/* items: what ⌘K has in Flow's workspaces, [{ key, kind, label, text }]. Answers { ranked: [{ key, why }], sessions }
   with sessions the session results (as search() gives them) for any ranked session. */
async function meaning(query, items) {
  const t0 = Date.now();
  const q = String(query == null ? '' : query).trim();
  if (!q) return { ranked: [], sessions: [], ms: 0 };
  const [cand, all, on] = await Promise.all([ask({ type: 'search', query: q, limit: CANDIDATES, any: true }), build(), runningRecent()]);
  const byId = new Map(all.map((s) => [s.id, s]));
  const sess = (cand.results || []).map((r) => byId.get(r.id)).filter(Boolean);
  const own = (Array.isArray(items) ? items : []).slice(0, 300).filter((x) => x && x.key && x.label);
  if (!sess.length && !own.length) return { ranked: [], sessions: [], ms: Date.now() - t0, terms: cand.terms || [] };
  const lines = [
    ...sess.map((s) => `[s:${s.id.slice(0, 8)}] session "${digest(s.title)}" in ${s.cwd || '?'}: ${digest(s.prompts)}`),
    ...own.map((x, i) => `[i:${i}] ${x.kind} "${digest(x.label)}"${x.text ? `: ${digest(x.text)}` : ''}`),
  ];
  const answer = await respond(
    'You find things in the user\'s workspaces. The input lists candidates, each with a bracketed tag, a kind (a Claude Code ' +
    'session, an agent, a note, a page, a file, a sub-workspace), its name and some of its text, then a search in plain words. ' +
    'Return the candidates that match what the user is looking for by meaning, not only by words: at most 8, best first, one per ' +
    'line, exactly as\n[tag] why it matches, in under 10 words\nCopy tags exactly. If nothing fits, return nothing.',
    `${lines.join('\n')}\n\nSearch: ${q}`);
  if (answer == null) return { ranked: [], sessions: [], ms: Date.now() - t0, off: keyNote };
  const ranked = [];
  const sessKeys = new Map(sess.map((s) => [`s:${s.id.slice(0, 8)}`, s]));
  for (const line of answer.split('\n')) {
    const m = /^\s*\[([si]:[0-9a-f]+)\]\s*[-—:]*\s*(.*)$/i.exec(line);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const why = m[2].trim();
    if (tag.startsWith('s:') && sessKeys.has(tag)) ranked.push({ key: `sess|${sessKeys.get(tag).id}`, why });
    else if (tag.startsWith('i:') && own[Number(tag.slice(2))]) ranked.push({ key: own[Number(tag.slice(2))].key, why });
  }
  const sessions = ranked.filter((r) => r.key.startsWith('sess|')).map((r) => {
    const s = byId.get(r.key.slice(5));
    return { id: s.id, cwd: s.cwd, title: s.title, firstAt: s.firstAt, lastAt: s.lastAt, count: s.count, resumable: s.resumable,
      resume: s.cwd ? `cd ${shq(s.cwd)} && claude --resume ${s.id}` : `claude --resume ${s.id}`, running: on.get(s.id) || null, hits: [] };
  });
  return { ranked, sessions, ms: Date.now() - t0, candidates: sess.length + own.length };
}

// ---------- running sessions (B1) ----------

const SESSION_ARG = /(?:^|\s)(?:--session-id|--resume|-r)(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i;
let tmux = { bin: '', socket: '' };

function setTmux(info) {
  tmux = { bin: (info && info.tmux) || '', socket: (info && info.socket) || '' };
  runningMemo = null;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, error: err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function processes() {
  const r = await run('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,args='], { LC_ALL: 'C' });
  if (r.code !== 0) throw new Error(`ps failed: ${r.stderr.trim() || (r.error && r.error.message)}`);
  const procs = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), start: Date.parse(m[3]), args: m[4] });
  }
  return procs;
}

/* The claude binary itself (any install), not a shell or wrapper that has claude on its command line. */
function isClaude(args) {
  const [a0, a1] = args.split(/\s+/);
  if (/claude/i.test(path.basename(a0 || ''))) return true;
  return /^(node|bun)$/.test(path.basename(a0 || '')) && /claude/i.test(a1 || '');
}

async function registry() {
  const dir = path.join(root, 'sessions');
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  await Promise.all(names.filter((n) => /^\d+\.json$/.test(n)).map(async (n) => {
    const file = path.join(dir, n);
    for (let attempt = 0; ; attempt++) {
      let text;
      try {
        text = await fs.promises.readFile(file, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return; // the session ended while listing
        throw e;
      }
      try {
        const o = JSON.parse(text);
        if (o && typeof o.sessionId === 'string' && Number.isInteger(o.pid)) out.push(o);
        return;
      } catch (e) {
        // Claude Code rewrites these files in place, so a read can catch one half written.
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        // Then this process counts by its --session-id/--resume argument, if it has one.
        if (!unreadable.has(file)) console.warn(`[flow] ${file} stayed unreadable over 100 ms: ${e.message}`);
        unreadable.add(file);
        return;
      }
    }
  }));
  return out;
}
const unreadable = new Set();

/* The process this registry file describes is the one running now, not a later process given the same pid:
   Linux keeps Claude Code's procStart as field 22 of /proc/<pid>/stat; elsewhere the process cannot have started
   after the session it holds. */
function sameProcess(r, p) {
  if (typeof r.procStart === 'string' && process.platform === 'linux') {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${r.pid}/stat`, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ESRCH') return false;
      throw e;
    }
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === r.procStart;
  }
  if (Number.isFinite(r.startedAt) && Number.isFinite(p.start)) return p.start <= r.startedAt + 2000;
  return true;
}

async function flowPanes() {
  const panes = new Map();
  if (!tmux.bin || !tmux.socket) return panes;
  const r = await run(tmux.bin, ['-L', tmux.socket, 'list-panes', '-a', '-F', '#{pane_pid} #{session_name}']);
  if (r.code !== 0) {
    if (/no server running|error connecting|No such file/i.test(r.stderr)) return panes;
    throw new Error(`tmux list-panes: ${r.stderr.trim() || (r.error && r.error.message)}`);
  }
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+) (.+)$/.exec(line);
    if (m) panes.set(Number(m[1]), m[2]);
  }
  return panes;
}

/* Claude Code's own registry (~/.claude/sessions/<pid>.json) says which session each live claude process has
   open now, also after /resume or /clear. Processes it does not list count by their --session-id or --resume
   argument. tmux is the tmux session around the process; flowWindow is set when that is Flow's own flow_<id>. */
async function running() {
  const [procs, reg, panes] = await Promise.all([processes(), registry(), flowPanes()]);
  const byPid = new Map();
  for (const r of reg) {
    const p = procs.get(r.pid);
    if (!p) continue; // a registry file left behind by a process that is gone
    // Claude Code wrote the file, and its start time (procStart, else startedAt) proves the pid is still that process,
    // whatever its binary is called (an install can run as .../claude/current). A file without either must name claude.
    if (typeof r.procStart !== 'string' && !Number.isFinite(r.startedAt) && !isClaude(p.args)) continue;
    if (!sameProcess(r, p)) continue; // the pid now belongs to a newer process
    byPid.set(r.pid, { id: r.sessionId.toLowerCase(), pid: r.pid, status: String(r.status || ''), cwd: String(r.cwd || ''), tmux: String(r.tmux || '').split(':')[0], flowWindow: '' });
  }
  for (const [pid, p] of procs) {
    if (byPid.has(pid) || !isClaude(p.args) || /(^|\s)--fork-session(\s|$)/.test(p.args)) continue;
    const m = SESSION_ARG.exec(p.args);
    if (m) byPid.set(pid, { id: m[1].toLowerCase(), pid, status: '', cwd: '', tmux: '', flowWindow: '' });
  }
  for (const e of byPid.values()) {
    for (let q = e.pid, i = 0; q > 1 && i < 64; i++) {
      const name = panes.get(q);
      if (name) {
        e.tmux = name;
        e.flowWindow = name.startsWith('flow_') ? name.slice(5) : '';
        break;
      }
      const p = procs.get(q);
      if (!p) break;
      q = p.ppid;
    }
  }
  return [...byPid.values()];
}

module.exports = { list, has, search, running, setClaudeDir, setCacheDir, setTmux, stop };




