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
