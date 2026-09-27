'use strict';
// Full-text index of every Claude Code transcript, for ⌘K search (B4). sessions.js runs this file in a worker
// thread so main never blocks. It copies what was said (your prompts, Claude's replies, compaction summaries,
// titles) out of ~/.claude/projects/*/<uuid>.jsonl into a pack in userData, one line per message, keyed by each
// transcript's inode, size and mtime, so a transcript is read once and then only its new lines. ~/.claude is only
// ever read.
//
// pack.txt holds the messages as written, pack.lc the same bytes with A-Z lowered (so offsets match), meta.runs the
// stretches of the pack that belong to one transcript, and pack.tri one 32768-bit set per 64 KB block of the pack
// of the three-byte sequences in it. A search reads only the blocks that hold every three bytes of a word, finds
// it with Buffer.indexOf and, after a few hits in a transcript's stretch, jumps to its end.

const fs = require('fs');
const path = require('path');
const { parentPort, workerData, threadId } = require('worker_threads');

const V = 3;
const CHUNK = 16 * 1024 * 1024;
const HEAD = 4096;
const MAX_TEXT = 50000;
const PER_RUN = 8;
const BLOCK = 64 * 1024;
const TRI = 4096;
const SAVE_EVERY = 2000;
const REFRESH_AFTER = 3000;
const REFRESH_BUDGET = 500;
const KEEP_MS = Number(workerData.keepMs) || 60000;
// The first build reads every transcript once (tens of GB on the Mac): it runs at a quarter of one core and at most
// 64 MB/s of reads, so the Mac stays quiet. Later updates read only new lines and run at full speed.
const GENTLE_SHARE = 0.25;
const GENTLE_RATE = 64 * 1024 * 1024;
const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const META_TEXT = /^(<command-name>|<command-message>|<command-args>|<local-command-stdout>|<local-command-stderr>|<system-reminder>|<bash-input>|<bash-stdout>|<bash-stderr>|Caveat: |\[Request interrupted)/;
const KIND = { u: 'you', a: 'claude', s: 'summary', t: 'title' };
const WEIGHT = { t: 5, u: 4, h: 4, s: 3, a: 2, f: 2 };
const B = (s) => Buffer.from(s);
const ROLE_USER = B('"role":"user"');
const ROLE_ASSISTANT = B('"role":"assistant"');
const TOOL_RESULT = B('"tool_use_id"');
const TEXT_BLOCK = B('"type":"text"');
const OTHER_TYPES = [B('"type":"summary"'), B('"type":"custom-title"'), B('"type":"ai-title"')];

const root = workerData.root;
const dir = workerData.cacheDir;
const PACK = path.join(dir, 'pack.txt');
const LC = path.join(dir, 'pack.lc');
const TRIS = path.join(dir, 'pack.tri');
const META = path.join(dir, 'meta.json');
const TMP = `.${process.pid}-${threadId}.tmp`;   // this thread's own temp names

let meta = null;
const status = { sessions: 0, pending: 0, built: false };
const byNo = new Map();
let packFd = null;
let lcFd = null;
let tri = Buffer.alloc(0);
let triDirty = Infinity;
let refreshing = null;
let lastRefresh = 0;
// A search inside REFRESH_AFTER of the last refresh answers from what that refresh saw; changes since then (a session
// that just ended) come in with one more refresh, and until it has run the answer says updating, so ⌘K asks again.
let lastStart = 0;
let lastAnswer = 0;
let trailing = null;
let compacting = null;
let searches = 0;
let savedAt = 0;
const hist = { file: '', ino: 0, offset: 0, map: new Map() };

const threadCpu = () => {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const pacing = { on: false, cpu: 0, wall: 0, bytes: 0 };
async function pace(bytes) {
  if (!pacing.on) return;
  pacing.bytes += bytes;
  const wall = Date.now() - pacing.wall;
  const wait = Math.max((threadCpu() - pacing.cpu) / GENTLE_SHARE - wall, (pacing.bytes / GENTLE_RATE) * 1000 - wall, 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  pacing.cpu = threadCpu();
  pacing.wall = Date.now();
  pacing.bytes = 0;
}

const fresh = () => ({ v: V, root, packBytes: 0, deadBytes: 0, nextNo: 1, files: {}, runs: [], blocks: [] });
const tick = () => new Promise((r) => setImmediate(r));
const lower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    if (e.code === 'ENOENT') return -1;
    throw e;
  }
};

// ---------- three-byte block sets ----------

const hash3 = (a, b, c) => Math.imul((a << 16) | (b << 8) | c, -1640531535) >>> 17;

function blockSet(b) {
  const need = (b + 1) * TRI;
  if (tri.length < need) {
    const grown = Buffer.alloc(Math.max(need, tri.length * 2, 64 * TRI));
    tri.copy(grown);
    tri = grown;
  }
  if (b < triDirty) triDirty = b;
}

/* Adds the complete lines in lc (which start at pack offset at) to the block sets, opening a new block when the
   current one would pass BLOCK. Blocks always start at a line, so no match is ever split between two. */
function addBlocks(lc, at) {
  const blocks = meta.blocks;
  let s = 0;
  while (s < lc.length) {
    let e = lc.indexOf(10, s);
    if (e < 0) e = lc.length - 1;
    const start = at + s;
    if (!blocks.length || (start > blocks[blocks.length - 1] && start + (e + 1 - s) - blocks[blocks.length - 1] > BLOCK)) blocks.push(start);
    const b = blocks.length - 1;
    blockSet(b);
    const base = b * TRI;
    for (let i = s; i + 2 < e; i++) {
      const h = hash3(lc[i], lc[i + 1], lc[i + 2]);
      tri[base + (h >>> 3)] |= 1 << (h & 7);
    }
    s = e + 1;
  }
}

function rebuildBlocks() {
  meta.blocks = [];
  tri = Buffer.alloc(0);
  triDirty = 0;
  const fd = fs.openSync(LC, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let at = 0;
    while (at < meta.packBytes) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, meta.packBytes - at), at);
      if (!n) break;
      let last = buf.lastIndexOf(10, n - 1);
      if (last < 0) last = n - 1;
      addBlocks(buf.subarray(0, last + 1), at);
      at += last + 1;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function saveBlocks() {
  const n = meta.blocks.length;
  if (triDirty >= n) return;
  const fd = fs.openSync(TRIS, fs.existsSync(TRIS) ? 'r+' : 'w');
  try {
    fs.writeSync(fd, tri, triDirty * TRI, (n - triDirty) * TRI, triDirty * TRI);
    fs.ftruncateSync(fd, n * TRI);
  } finally {
    fs.closeSync(fd);
  }
  triDirty = Infinity;
}

function load() {
  fs.mkdirSync(dir, { recursive: true });
  let m = null;
  try {
    m = JSON.parse(fs.readFileSync(META, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[flow] session index: starting over, ${META} was unreadable: ${e.message}`);
  }
  if (!m || m.v !== V || m.root !== root || sizeOf(PACK) < m.packBytes || sizeOf(LC) < m.packBytes) {
    m = fresh();
    fs.writeFileSync(PACK, '');
    fs.writeFileSync(LC, '');
  } else {
    // Lines appended after the last save are dropped; their transcripts are read again from the saved offsets.
    fs.truncateSync(PACK, m.packBytes);
    fs.truncateSync(LC, m.packBytes);
  }
  meta = m;
  status.built = Object.keys(meta.files).length > 0;
  // Until the first listing ends, the saved index says how many transcripts there are.
  status.sessions = Object.keys(meta.files).length;
  status.pending = 0;
  byNo.clear();
  for (const f of Object.values(meta.files)) byNo.set(f.no, f);
  tri = Buffer.alloc(0);
  triDirty = Infinity;
  if (sizeOf(TRIS) === meta.blocks.length * TRI) {
    if (meta.blocks.length) tri = fs.readFileSync(TRIS);
  } else {
    rebuildBlocks();
    saveBlocks();
  }
  packFd = fs.openSync(PACK, 'a');
  lcFd = fs.openSync(LC, 'a');
}

function save(force) {
  const now = Date.now();
  if (!force && now - savedAt < SAVE_EVERY) return;
  savedAt = now;
  saveBlocks();
  const tmp = META + TMP;
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, META);
}

function drop(file) {
  const f = meta.files[file];
  if (!f) return;
  meta.deadBytes += f.bytes;
  byNo.delete(f.no);
  delete meta.files[file];
}

// ---------- reading transcripts ----------

function clean(raw) {
  let text = String(raw || '').trim();
  if (!text || META_TEXT.test(text)) return '';
  const mate = text.match(/^<teammate-message\b[^>]*>([\s\S]*?)(<\/teammate-message>|$)/);
  if (mate) text = mate[1];
  return text;
}

function texts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
}

function push(out, kind, raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  out.push(`${kind}\t${text}\n`);
}

function take(o, f, out) {
  if (!f.cwd && typeof o.cwd === 'string') f.cwd = o.cwd;
  if (o.type === 'summary') return push(out, 's', o.summary);
  if (o.type === 'custom-title') return push(out, 't', o.customTitle);
  if (o.type === 'ai-title') return push(out, 't', o.aiTitle);
  const m = o.message;
  if (!m) return;
  if (o.type === 'user') {
    if (o.isCompactSummary) return push(out, 's', texts(m.content).join(' '));
    if (o.isMeta || o.toolUseResult !== undefined) return;
    for (const t of texts(m.content)) push(out, 'u', clean(t));
  } else if (o.type === 'assistant') {
    for (const t of texts(m.content)) push(out, 'a', t);
  }
}

/* Most of a transcript is tool output. Cheap byte tests skip those lines before JSON.parse ever sees them. */
function wanted(line) {
  const head = line.subarray(0, HEAD);
  if (head.indexOf(ROLE_USER) >= 0) return head.indexOf(TOOL_RESULT) < 0;
  if (head.indexOf(ROLE_ASSISTANT) >= 0) return line.indexOf(TEXT_BLOCK) >= 0;
  return OTHER_TYPES.some((t) => head.indexOf(t) >= 0);
}

function lines(data, end, f, out, bad) {
  let s = 0;
  while (s < end) {
    let e = data.indexOf(10, s);
    if (e < 0 || e > end) e = end;
    if (e - s > 2 && data[s] === 0x7b) {
      const line = data.subarray(s, e);
      if (wanted(line)) {
        let o = null;
        try {
          o = JSON.parse(line.toString('utf8'));
        } catch (err) {
          bad.n += 1;
        }
        if (o) take(o, f, out);
      }
    }
    s = e + 1;
  }
}

function append(out, f) {
  if (!out.length) return;
  const text = out.join('');
  const orig = Buffer.from(text);
  const lc = Buffer.from(lower(text));
  if (lc.length !== orig.length) throw new Error('session index: lowering changed the byte length');
  fs.writeSync(packFd, orig);
  fs.writeSync(lcFd, lc);
  addBlocks(lc, meta.packBytes);
  const last = meta.runs[meta.runs.length - 1];
  if (!last || last[1] !== f.no) meta.runs.push([meta.packBytes, f.no]);
  meta.packBytes += orig.length;
  f.bytes += orig.length;
}

async function indexFile({ id, file, st }) {
  let f = meta.files[file];
  if (!f || f.ino !== st.ino || st.size < f.offset) {
    if (f) drop(file);
    f = { no: meta.nextNo++, id, ino: st.ino, size: 0, mtimeMs: 0, offset: 0, bytes: 0, cwd: '' };
    meta.files[file] = f;
    byNo.set(f.no, f);
  }
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let readAt = f.offset;
    let carry = null;
    const bad = { n: 0 };
    while (readAt < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - readAt), readAt);
      if (!bytesRead) break;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const start = readAt - (carry ? carry.length : 0);
      readAt += bytesRead;
      const end = data.lastIndexOf(10);
      if (end < 0) {
        carry = Buffer.from(data);
        continue;
      }
      const out = [];
      lines(data, end, f, out, bad);
      append(out, f);
      f.offset = start + end + 1;
      carry = end + 1 < data.length ? Buffer.from(data.subarray(end + 1)) : null;
      await pace(bytesRead);
    }
    if (bad.n) console.warn(`[flow] session index: skipped ${bad.n} unreadable line(s) in ${file}`);
  } finally {
    await fh.close();
  }
  // A last line still being written stays unread (offset stops before it) and is read with the next change.
  f.size = st.size;
  f.mtimeMs = st.mtimeMs;
}

async function listTranscripts() {
  const projects = path.join(root, 'projects');
  let dirs;
  try {
    dirs = await fs.promises.readdir(projects, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const found = [];
  await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
    for (const name of await fs.promises.readdir(path.join(projects, d.name))) {
      const m = UUID_FILE.exec(name);
      if (m) found.push({ id: m[1].toLowerCase(), file: path.join(projects, d.name, name) });
    }
  }));
  return found;
}

async function readHistory() {
  const file = path.join(root, 'history.jsonl');
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (hist.file !== file || hist.ino !== st.ino || st.size < hist.offset) {
    hist.file = file;
    hist.ino = st.ino;
    hist.offset = 0;
    hist.map = new Map();
  }
  if (st.size === hist.offset) return;
  const fh = await fs.promises.open(file, 'r');
  let text = '';
  try {
    const buf = Buffer.alloc(st.size - hist.offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, hist.offset);
    const end = buf.lastIndexOf(10, bytesRead - 1);
    if (end >= 0) {
      text = buf.toString('utf8', 0, end);
      hist.offset += end + 1;
    }
  } finally {
    await fh.close();
  }
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      bad += 1;
      continue;
    }
    if (!o || !o.sessionId || typeof o.display !== 'string') continue;
    const id = String(o.sessionId).toLowerCase();
    let h = hist.map.get(id);
    if (!h) hist.map.set(id, (h = { cwd: o.project || '', parts: [], lc: '', last: 0 }));
    const t = o.display.replace(/\s+/g, ' ').trim();
    if (t) h.parts.push(t);
    if (o.timestamp > h.last) h.last = o.timestamp;
    h.lc = '';
  }
  if (bad) console.warn(`[flow] session index: skipped ${bad} unreadable line(s) in ${file}`);
}

async function refreshNow(gentle) {
  const [files] = await Promise.all([listTranscripts(), readHistory()]);
  const seen = new Set();
  const work = [];
  for (const { id, file } of files) {
    seen.add(file);
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    const f = meta.files[file];
    if (f && f.ino === st.ino && f.size === st.size && f.mtimeMs === st.mtimeMs) continue;
    work.push({ id, file, st });
  }
  for (const file of Object.keys(meta.files)) if (!seen.has(file)) drop(file);
  work.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  status.sessions = files.length;
  status.pending = work.length;
  pacing.on = gentle || !status.built;
  pacing.cpu = threadCpu();
  pacing.wall = Date.now();
  pacing.bytes = 0;
  for (const w of work) {
    try {
      await indexFile(w);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      drop(w.file);
    }
    status.pending -= 1;
    save(false);
    await pace(0);
    await tick();
  }
  pacing.on = false;
  status.built = true;
  save(true);
  const live = byNo.size;
  if ((meta.deadBytes > 64 * 1024 * 1024 && meta.deadBytes > meta.packBytes * 0.3) || meta.runs.length > 4 * live + 1000) await compact();
}

function refresh(gentle) {
  if (!refreshing) {
    lastStart = Date.now();
    refreshing = refreshNow(gentle).finally(() => {
      refreshing = null;
      lastRefresh = Date.now();
    });
  }
  return refreshing;
}

/* Rewrites both packs with each live transcript's stretches together and the dropped ones gone. Never while a
   search reads them. */
async function compact() {
  while (searches > 0) await new Promise((r) => setTimeout(r, 50));
  compacting = (async () => {
    const ends = meta.runs.map((r, i) => (i + 1 < meta.runs.length ? meta.runs[i + 1][0] : meta.packBytes));
    const byFile = new Map();
    meta.runs.forEach((r, i) => {
      if (!byNo.has(r[1])) return;
      if (!byFile.has(r[1])) byFile.set(r[1], []);
      byFile.get(r[1]).push([r[0], ends[i]]);
    });
    const runs = [];
    let at = 0;
    const copies = [[PACK, PACK + TMP], [LC, LC + TMP]].map(([from, to]) => ({ from: fs.openSync(from, 'r'), to: fs.openSync(to, 'w'), name: to }));
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (const [no, parts] of byFile) {
        const start = at;
        for (const [s, e] of parts) {
          for (let p = s; p < e; p += CHUNK) {
            const n = Math.min(CHUNK, e - p);
            for (const c of copies) {
              fs.readSync(c.from, buf, 0, n, p);
              fs.writeSync(c.to, buf, 0, n);
            }
            at += n;
          }
        }
        runs.push([start, no]);
        await tick();
      }
    } finally {
      for (const c of copies) {
        fs.closeSync(c.from);
        fs.closeSync(c.to);
      }
    }
    fs.closeSync(packFd);
    fs.closeSync(lcFd);
    fs.renameSync(PACK + TMP, PACK);
    fs.renameSync(LC + TMP, LC);
    packFd = fs.openSync(PACK, 'a');
    lcFd = fs.openSync(LC, 'a');
    meta.packBytes = at;
    meta.deadBytes = 0;
    meta.runs = runs;
    rebuildBlocks();
    save(true);
  })().finally(() => {
    compacting = null;
  });
  return compacting;
}

// ---------- search ----------

/* Up to 70 characters before the match and 150 after, with … where the message goes on. */
function around(text, at, len) {
  const from = Math.max(0, at - 70);
  const to = Math.min(text.length, at + len + 150);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

async function snippet(fd, h) {
  const from = Math.max(h.textAt, h.at - 300);
  const to = Math.min(h.lineEnd, h.at + h.len + 600);
  const buf = Buffer.alloc(to - from);
  const { bytesRead } = await fd.read(buf, 0, buf.length, from);
  const m0 = h.at - from;
  const m1 = Math.min(bytesRead, m0 + h.len);
  const pre = buf.toString('utf8', 0, m0).replace(/^�+/, '');
  const post = buf.toString('utf8', m1, bytesRead).replace(/�+$/, '');
  const a = pre.length > 70 ? pre.slice(-70) : pre;
  const b = post.length > 150 ? post.slice(0, 150) : post;
  return `${a.length < pre.length || from > h.textAt ? '…' : ''}${a}${buf.toString('utf8', m0, m1)}${b}${b.length < post.length || to < h.lineEnd ? '…' : ''}`;
}

function runAt(runs, off) {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs[mid][0] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* Buffer.indexOf searches words under 7 bytes by scanning for their first byte, which for "error" is the most
   common letter there is. Look for the rarest byte's tail instead and check the head. */
const COMMON = ' etaoinsrhldcumfpgwybvkxjqz';
function finder(needle) {
  if (needle.length >= 7) return (buf, from) => buf.indexOf(needle, from);
  let j = 0;
  for (let x = 1; x < needle.length; x++) {
    const r = COMMON.indexOf(String.fromCharCode(needle[x]));
    const best = COMMON.indexOf(String.fromCharCode(needle[j]));
    if (r < 0 ? best >= 0 : best >= 0 && r > best) j = x;
  }
  if (!j) return (buf, from) => buf.indexOf(needle, from);
  const tail = needle.subarray(j);
  return (buf, from) => {
    let p = buf.indexOf(tail, from + j);
    while (p >= 0) {
      if (buf.compare(needle, 0, j, p - j, p) === 0) return p - j;
      p = buf.indexOf(tail, p + 1);
    }
    return -1;
  };
}

/* Runs every job ({ needle, ranges, onHit }) over its stretches of pack.lc, at most PER_RUN hits in each
   transcript's stretch. The union of all stretches is read once, 16 MB at a time, and searched in place. */
async function scanMany(fd, jobs) {
  const runs = meta.runs;
  const end = meta.packBytes;
  jobs = jobs.filter((j) => j.ranges.length);
  if (!runs.length || !jobs.length) return;
  const union = [];
  for (const [s, e] of jobs.flatMap((j) => j.ranges).sort((a, b) => a[0] - b[0])) {
    const last = union[union.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else union.push([s, e]);
  }
  for (const j of jobs) {
    j.find = finder(j.needle);
    j.skipUntil = 0;
    j.ri = 0;
  }
  const buf = Buffer.allocUnsafe(CHUNK);
  let cpu = 0;
  const searchIn = (j, base, from, to) => {
    const view = buf.subarray(from, to);
    const at0 = base + from;
    let r = runAt(runs, at0);
    let run = -1;
    let counted = 0;
    let i = j.find(view, Math.max(0, j.skipUntil - at0));
    while (i >= 0) {
      const abs = at0 + i;
      while (r + 1 < runs.length && runs[r + 1][0] <= abs) r++;
      const runEnd = r + 1 < runs.length ? runs[r + 1][0] : end;
      if (r !== run) {
        run = r;
        counted = 0;
      }
      const ls = view.lastIndexOf(10, i) + 1;
      let next;
      if (!byNo.has(runs[r][1])) {
        next = runEnd - at0;
      } else if (i < ls + 2) {
        next = ls + 2;
      } else {
        const le = view.indexOf(10, i);
        j.onHit(runs[r][1], String.fromCharCode(view[ls]), abs, at0 + ls + 2, at0 + le, j.needle.length);
        counted += 1;
        next = counted >= PER_RUN ? runEnd - at0 : le + 1;
      }
      if (next >= view.length) {
        j.skipUntil = at0 + next;
        return;
      }
      i = j.find(view, next);
    }
  };
  let ui = 0;
  while (ui < union.length) {
    const w0 = union[ui][0];
    let uj = ui;
    while (uj < union.length && union[uj][1] <= w0 + CHUNK) uj++;
    const w1 = uj > ui ? union[uj - 1][1] : w0 + CHUNK;
    const { bytesRead } = await fd.read(buf, 0, w1 - w0, w0);
    if (!bytesRead) break;
    stats.read += bytesRead;
    const c0 = process.hrtime.bigint();
    let wEnd = w1;
    if (uj === ui) {
      let last = buf.lastIndexOf(10, bytesRead - 1);
      if (last < 0) last = bytesRead - 1;
      wEnd = w0 + last + 1;
      union[ui][0] = wEnd;
    } else {
      ui = uj;
    }
    for (const j of jobs) {
      while (j.ri < j.ranges.length && j.ranges[j.ri][1] <= w0) j.ri++;
      for (let x = j.ri; x < j.ranges.length && j.ranges[x][0] < wEnd; x++) {
        const s = Math.max(j.ranges[x][0], w0);
        const e = Math.min(j.ranges[x][1], wEnd);
        if (s < e) searchIn(j, w0, s - w0, e - w0);
      }
    }
    cpu += Number(process.hrtime.bigint() - c0) / 1e6;
    await tick();
  }
  stats.cpu += cpu;
}

const stats = { read: 0, cpu: 0 };

/* The pack's stretches that belong to these sessions, merged where they touch. */
function rangesFor(ids) {
  const runs = meta.runs;
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const f = byNo.get(runs[i][1]);
    if (!f || !ids.has(f.id)) continue;
    const s = runs[i][0];
    const e = i + 1 < runs.length ? runs[i + 1][0] : meta.packBytes;
    if (out.length && out[out.length - 1][1] === s) out[out.length - 1][1] = e;
    else out.push([s, e]);
  }
  return out;
}

/* The blocks that hold every three-byte sequence of the needle (all blocks for a needle under three bytes). */
function blocksWith(needle) {
  const n = meta.blocks.length;
  const hs = [];
  for (let i = 0; i + 2 < needle.length; i++) {
    const h = hash3(needle[i], needle[i + 1], needle[i + 2]);
    if (!hs.includes(h)) hs.push(h);
  }
  const out = [];
  for (let b = 0; b < n; b++) {
    const base = b * TRI;
    let all = true;
    for (const h of hs) {
      if (!(tri[base + (h >>> 3)] & (1 << (h & 7)))) {
        all = false;
        break;
      }
    }
    if (all) out.push(b);
  }
  return out;
}

/* The parts of the ranges that lie in the given blocks. */
function within(ranges, blocks) {
  const starts = meta.blocks;
  const out = [];
  let ri = 0;
  for (const b of blocks) {
    const bs = starts[b];
    const be = b + 1 < starts.length ? starts[b + 1] : meta.packBytes;
    while (ri < ranges.length && ranges[ri][1] <= bs) ri++;
    for (let rj = ri; rj < ranges.length && ranges[rj][0] < be; rj++) {
      const s = Math.max(bs, ranges[rj][0]);
      const e = Math.min(be, ranges[rj][1]);
      if (s >= e) continue;
      if (out.length && out[out.length - 1][1] === s) out[out.length - 1][1] = e;
      else out.push([s, e]);
    }
  }
  return out;
}

async function search(query, limit) {
  if (compacting) await compacting;
  searches += 1;
  try {
    const q = lower(String(query || '').replace(/\s+/g, ' ').trim());
    const terms = [...new Set(q.split(' ').filter(Boolean))];
    if (!terms.length) return { total: 0, results: [] };
    const P = terms.length;
    const needles = terms.map((t) => Buffer.from(t));
    const sessions = new Map();
    const get = (id) => {
      let s = sessions.get(id);
      if (!s) sessions.set(id, (s = { id, counts: new Array(P).fill(0), best: new Array(P).fill(''), first: new Array(P).fill(null), phrase: null, mtimeMs: 0, cwd: '' }));
      return s;
    };
    const lfd = await fs.promises.open(LC, 'r');
    let candidates;
    try {
      const hit = (k) => (no, kind, at, textAt, lineEnd, len) => {
        const s = get(byNo.get(no).id);
        if (k === P) {
          if (!s.phrase) s.phrase = { kind, at, textAt, lineEnd, len };
          return;
        }
        s.counts[k] += 1;
        if (!s.best[k] || WEIGHT[kind] > WEIGHT[s.best[k]]) s.best[k] = kind;
        if (!s.first[k] || WEIGHT[kind] > WEIGHT[s.first[k].kind]) s.first[k] = { kind, at, textAt, lineEnd, len };
      };
      const withCwd = (k, ids) => {
        for (const f of byNo.values()) if (lower(f.cwd).includes(terms[k])) ids.add(f.id);
        return ids;
      };
      // The word in the fewest blocks picks the candidate sessions; the other words and the exact phrase are then
      // looked for together, in one pass over just those sessions' stretches.
      const blocks = needles.map(blocksWith);
      const order = needles.map((_, k) => k).sort((a, b) => blocks[a].length - blocks[b].length || needles[b].length - needles[a].length);
      const first = order[0];
      const all = [[0, meta.packBytes]];
      if (P > 1 && blocks[first].length * 2 > meta.blocks.length) {
        // Even the rarest word is in most blocks: narrowing to its sessions would read nearly everything twice.
        const phrase = Buffer.from(q);
        await scanMany(lfd, [...order.map((k) => ({ needle: needles[k], ranges: within(all, blocks[k]), onHit: hit(k) })), { needle: phrase, ranges: within(all, blocksWith(phrase)), onHit: hit(P) }]);
        candidates = withCwd(first, new Set([...sessions.keys()]));
        for (const k of order.slice(1)) {
          const has = withCwd(k, new Set());
          for (const id of candidates) {
            const x = sessions.get(id);
            if (!(x && x.counts[k]) && !has.has(id)) candidates.delete(id);
          }
        }
      } else {
        await scanMany(lfd, [{ needle: needles[first], ranges: within(all, blocks[first]), onHit: hit(first) }]);
        candidates = withCwd(first, new Set([...sessions.keys()]));
      }
      if (P > 1 && candidates.size && blocks[first].length * 2 <= meta.blocks.length) {
        const mine = rangesFor(candidates);
        const phrase = Buffer.from(q);
        const jobs = order.slice(1).map((k) => ({ needle: needles[k], ranges: within(mine, blocks[k]), onHit: hit(k) }));
        jobs.push({ needle: phrase, ranges: within(mine, blocksWith(phrase)), onHit: hit(P) });
        await scanMany(lfd, jobs);
        for (const k of order.slice(1)) {
          const has = withCwd(k, new Set());
          for (const id of candidates) {
            const x = sessions.get(id);
