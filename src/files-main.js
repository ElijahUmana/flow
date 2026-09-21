'use strict';
// A workspace's files (BRIEF 3.0): the sidebar lists one folder level at a time, watches only the folders it shows,
// and opens a file as a page through the flow-file: scheme. Folders on the VM go to the VM module given to init().

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { app, shell, webContents } = require('electron');
const markdown = require('./markdown');

const SCHEME = 'flow-file';
const MAX_ENTRIES = 5000;            // names returned for one folder level; total says how many there are
const MAX_SHOWN = 8 * 1024 * 1024;   // a text or html file bigger than this opens in the Mac's app
const MAX_MD = 1024 * 1024;          // a .md bigger than this shows as plain text (rendering 1 MB takes main ~250 ms here)
const MD_RE = /\.(md|markdown|mdown|mkd)$/i;
const LIVE_MS = 150;                 // a file on screen re-renders this long after it changes, at most once a second
                                     // (once every n seconds for an n MB file, so a big log stays light)
const HOLD_MS = 500;                 // while text is selected in it, it looks again this often
const VM_SIZES = 256;                // VM file sizes kept for that
const MAX_WATCHED = 64;              // folders watched per window
const SETTLE_MS = 400;               // a burst of changes in one folder is reported once

// Mac app and document bundles are folders that Finder shows and opens as files.
const PACKAGE_RE = /\.(app|bundle|framework|plugin|kext|key|pages|numbers|rtfd|photoslibrary|xcodeproj|xcworkspace|playground|logicx|fcpbundle|sparsebundle)$/i;
const TYPES = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  html: 'text/html', htm: 'text/html',
};
const HTML_RE = /\.html?$/i;
// Under the folder of an .html page opened at its folder's address (a report), these load as what they are, for the
// page to use; anything else is served as it is everywhere.
const SCOPED_TYPES = {
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
};
// An html file runs its own inline scripts and styles but reaches nothing: no network, no other file.
const HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
const TEXT_CSP = "default-src 'none'; style-src 'unsafe-inline'";

let store = null;
let home = '';
let vm = null;

/* o: { store, home, vm }. vm (optional) handles files on the VM: list(host, dir); watch(senderId, [{ host, dir } or
   { host, file }], changed(host, path, kind)) with the window's whole VM set each time (kind 'file' for a file);
   stop(senderId); open(host, file, folders); serve(request, folders); shown(host, path, folders). folders: that host's
   workspace folders as typed. */
function init(o) {
  store = o.store;
  home = o.home;
  vm = o.vm || null;
  if (!guarding) {
    guarding = true;
    app.on('web-contents-created', (_event, wc) => guardReports(wc));
  }
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/* Folders first, then files, by name as Finder sorts them (numbers by value, case ignored). */
function compare(a, b) {
  if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
  return collator.compare(a.name, b.name);
}

const expand = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

/* The workspace folders, their sub-workspaces' own folders and the recorded downloads, read from the state the
   renderer saved last. */
function roots() {
  const doc = store ? store.load() : null;
  const list = doc && Array.isArray(doc.ws) ? doc.ws : [];
  const folders = [];
  const downloads = new Set();
  for (const w of list) {
    if (!w || typeof w !== 'object') continue;
    if (typeof w.folder === 'string' && w.folder) folders.push(expand(w.folder));
    if (Array.isArray(w.zones)) for (const z of w.zones) if (z && typeof z.folder === 'string' && z.folder) folders.push(expand(z.folder));
    if (Array.isArray(w.downloads)) for (const d of w.downloads) if (d && typeof d.file === 'string') downloads.add(d.file);
  }
  return { folders, downloads };
}

const absolute = (p) => typeof p === 'string' && path.isAbsolute(p) && path.resolve(p) === p;

/* The folders on a VM host that workspaces run in, as typed ('~' when unset), their sub-workspaces' own folders there,
   and the folders their VM agents work in (ws.vmPlaces, files.js): the VM module resolves them. */
function vmFolders(host) {
  const doc = store ? store.load() : null;
  const list = doc && Array.isArray(doc.ws) ? doc.ws : [];
  return list.filter((w) => w && w.host === host).flatMap((w) => [(typeof w.hostFolder === 'string' && w.hostFolder) || '~',
    ...(Array.isArray(w.zones) ? w.zones : []).filter((z) => z && typeof z.hostFolder === 'string' && z.hostFolder).map((z) => z.hostFolder)])
    .concat(list.flatMap((w) => (w && Array.isArray(w.vmPlaces) ? w.vmPlaces : [])
      .filter((v) => v && v.host === host && typeof v.path === 'string' && v.path).map((v) => v.path)));
}

/* What Flow may list, open or show: a download it recorded, or a path inside a workspace folder that is not hidden
   (the list leaves out names starting with a dot, as Finder does, so nothing under one is ever reached). The state
   main has can be up to one save (120 ms) behind the window's, so a check that only answers "is it there" or "did it
   change" for a path the window names (exist, watch) does not depend on it. */
function shown(p) {
  if (!absolute(p)) return false;
  const { folders, downloads } = roots();
  if (downloads.has(p)) return true;
  return folders.some((f) => {
    const rel = path.relative(f, p);
    if (rel === '') return true;
    const parts = rel.split(path.sep);
    return parts[0] !== '..' && !path.isAbsolute(rel) && !parts.some((s) => s.startsWith('.'));
  });
}

function reason(e) {
  if (e.code === 'ENOENT') return 'not there';
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'no access';
  if (e.code === 'ENOTDIR') return 'not a folder';
  console.error(`[flow] files: ${e.message}`);
  return e.message;
}

async function linkKind(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory() ? 'dir' : 'file';
  } catch (e) {
    // A link to nothing is listed as a file; opening it says it is not there.
    if (e.code !== 'ENOENT' && e.code !== 'ELOOP') console.warn(`[flow] files: could not follow the link ${p}: ${e.message}`);
    return 'file';
  }
}

/* One folder level: { ok, dir, entries: [{ name, kind: 'dir'|'file' }], total } or { ok: false, dir, error }. No stat per
   entry except for links. */
async function list(host, dir) {
  if (host) return vm ? vm.list(host, dir) : { ok: false, dir, error: 'files on the VM are not set up' };
  if (!shown(dir)) return { ok: false, dir, error: 'not in a workspace folder' };
  let ents;
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, dir, error: reason(e) };
  }
  const all = await Promise.all(ents.filter((d) => !d.name.startsWith('.')).map(async (d) => {
    let kind = d.isDirectory() ? 'dir' : 'file';
    if (d.isSymbolicLink()) kind = await linkKind(path.join(dir, d.name));
    if (kind === 'dir' && PACKAGE_RE.test(d.name)) kind = 'file';
    return { name: d.name, kind };
  }));
  all.sort(compare);
  return { ok: true, dir, entries: all.slice(0, MAX_ENTRIES), total: all.length };
}

/* Which of these paths are still there, as files. */
async function exist(paths) {
  return Promise.all((Array.isArray(paths) ? paths : []).map(async (p) => {
    if (!absolute(p)) return false;
    try {
      return (await fs.promises.stat(p)).isFile();
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[flow] files: could not check ${p}: ${e.message}`);
      return false;
    }
  }));
}

/* ---------- watching: exactly the folders a window shows, nothing else ---------- */
const watched = new Map();   // webContents id -> Map(dir -> { w, timer })

function stopWatching(id) {
  const mine = watched.get(id);
  if (mine) for (const x of mine.values()) { x.w.close(); clearTimeout(x.timer); }
  watched.delete(id);
  const md = live.get(id);
  if (md) for (const x of md.values()) { x.w.close(); clearTimeout(x.timer); }
  live.delete(id);
  const vmMd = vmLive.get(id);
  if (vmMd) for (const x of vmMd.values()) clearTimeout(x.timer);
  vmLive.delete(id);
  if (vm) vm.stop(id);
}

/* dirs: [{ host, dir }], the folders the window shows now; [] stops all. A change is sent as files:changed { host, dir }. */
function watch(sender, dirs) {
  const id = sender.id;
  let mine = watched.get(id);
  if (!mine) {
    mine = new Map();
    watched.set(id, mine);
    sender.once('destroyed', () => stopWatching(id));
  }
  const send = (host, dir) => { if (!sender.isDestroyed()) sender.send('files:changed', { host, dir }); };
  const local = new Set();
  const remote = [];
  const shown = new Set();
  for (const d of (Array.isArray(dirs) ? dirs : []).slice(0, MAX_WATCHED)) {
    if (d && typeof d.file === 'string') {
      if (d.host) remote.push({ host: String(d.host), file: d.file });
      else if (absolute(d.file)) shown.add(d.file);
      continue;
    }
    if (!d || typeof d.dir !== 'string') continue;
    if (d.host) remote.push({ host: String(d.host), dir: d.dir });
    else if (absolute(d.dir)) local.add(d.dir);
  }
  liveSet(sender, shown);
  if (Array.isArray(dirs) && dirs.length > MAX_WATCHED) console.warn(`[flow] files: watching the first ${MAX_WATCHED} of ${dirs.length} folders shown`);
  for (const [dir, x] of mine) {
    if (local.has(dir)) continue;
    x.w.close();
    clearTimeout(x.timer);
    mine.delete(dir);
  }
  for (const dir of local) {
    if (mine.has(dir)) continue;
    let w;
    try {
      w = fs.watch(dir, { persistent: false });
    } catch (e) {
      // The folder is gone or closed to Flow: its list says so when the window lists it again.
      console.warn(`[flow] files: could not watch ${dir}: ${e.message}`);
      send(null, dir);
      continue;
    }
    const x = { w, timer: 0 };
    w.on('change', () => {
      if (!x.timer) x.timer = setTimeout(() => { x.timer = 0; send(null, dir); }, SETTLE_MS);
    });
    w.on('error', (e) => {
      console.warn(`[flow] files: stopped watching ${dir}: ${e.message}`);
      w.close();
      clearTimeout(x.timer);
      if (mine.get(dir) === x) mine.delete(dir);
      send(null, dir);
    });
    mine.set(dir, x);
  }
  const paced = vmLive.get(id);
  if (paced) for (const [k, x] of paced) if (!remote.some((r) => r.file && `${r.host}\0${r.file}` === k)) { clearTimeout(x.timer); paced.delete(k); }
  if (vm) vm.watch(id, remote, (host, p, kind) => (kind === 'file' ? vmChanged(sender, host, p) : send(host, p)));
  else if (remote.length) console.warn('[flow] files: folders on the VM are not watched (no VM module)');
}

/* ---------- opening: in Flow as a page where it can be shown, otherwise in the Mac's app ---------- */
async function readHead(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function looksLikeText(file) {
  const head = await readHead(file);
  return !head.includes(0) && isUtf8(head);
}

/* An html file that names no charset (no byte order mark, no <meta charset> in its first 1024 bytes, where browsers
   look) is read as UTF-8 when it starts as valid UTF-8, as Chrome reads a local file; one that names its own keeps it. */
async function undeclaredUtf8(file) {
  const head = await readHead(file);
  if ((head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) || (head[0] === 0xfe && head[1] === 0xff) || (head[0] === 0xff && head[1] === 0xfe)) return false;
  if (/<meta[^>]+charset\s*=/i.test(head.subarray(0, 1024).toString('latin1'))) return false;
  return isUtf8(head);
}

/* Valid UTF-8, allowing a character cut off at the end of the 8 KB read. */
function isUtf8(b) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true });
    return true;
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
}

/* 'pdf' | 'image' | 'html' | 'text' (shown in Flow) or 'other' (the Mac's app). */
async function kindOf(file, size) {
  const type = TYPES[path.extname(file).slice(1).toLowerCase()];
  if (type === 'application/pdf') return 'pdf';
  if (type && type.startsWith('image/')) return 'image';
  if (size > MAX_SHOWN) return 'other';
  if (type === 'text/html') return 'html';
  if (!(await looksLikeText(file))) return 'other';
  return MD_RE.test(file) && size <= MAX_MD ? 'md' : 'text';
}

/* ---------- signed addresses ---------- */
/* Every flow-file: address carries an HMAC of the file it names, made with a key only main holds, so a web page can
   neither make one up nor include, frame or open a file with it. The key is kept in userData: a tab or a saved page
   showing a file comes back after a restart. No webRequest listener is needed, which would slow every page's requests. */
let key = null;
function secret() {
  if (key) return key;
  const file = path.join(app.getPath('userData'), 'flow-file.key');
  try {
    const k = fs.readFileSync(file);
    if (k.length === 32) return (key = k);
    console.warn(`[flow] files: ${file} is not a 32-byte key, so a new one is made and file pages open from the sidebar again`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const k = crypto.randomBytes(32);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, k, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return (key = k);
}
const canon = (p) => '/' + p.split('/').filter(Boolean).join('/');
const sign = (what) => crypto.createHmac('sha256', secret()).update(what).digest('base64url').slice(0, 22);
const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const encoded = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
/* An .html file's address is signed for its folder, so a report's styles, scripts, pages and subfolders load with it;
   nothing above that folder does. */
const dirOf = (p) => path.posix.dirname(canon(p));
const urlOf = (file) => `${SCHEME}://mac/${sign(HTML_RE.test(file) ? `macdir\0${dirOf(file)}` : `mac\0${canon(file)}`)}/${encoded(file)}`;
/* A file the owner dropped on Flow from Finder opens wherever it is: its address is signed as that grant, for that file
   alone (an .html one too, so nothing beside it loads with it). */
const dropUrlOf = (file) => `${SCHEME}://mac/${sign(`drop\0${canon(file)}`)}/${encoded(file)}`;
/* A VM file's address, made for the VM module: flow-file://vm/<signature>/<host>/<absolute path>. */
const vmUrlOf = (host, p) => `${SCHEME}://vm/${sign(HTML_RE.test(p) ? `vmdir\0${host}\0${dirOf(p)}` : `vm\0${host}\0${canon(p)}`)}/${encodeURIComponent(host)}/${encoded(p)}`;

/* What a signed address names: { file } on this Mac (dropped: true for one the owner dropped), { host, p } on the VM,
   with scope: the folder it was signed for when it is a report's (under that folder), or null when this Flow did not
   sign it or it does not decode. */
function named(u) {
  let parts;
  try {
    parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch (e) {
    if (e instanceof URIError) return null;
    throw e;
  }
  const sig = parts.shift();
  if (u.host === 'mac') {
    const file = canon(parts.join('/'));
    if (same(sig, sign(`mac\0${file}`))) return { file };
    if (same(sig, sign(`drop\0${file}`))) return { file, dropped: true };
    const scope = scopeOf(sig, file, (d) => `macdir\0${d}`);
    return scope ? { file, scope } : null;
  }
  if (u.host === 'vm' && parts.length > 1) {
    const host = parts.shift();
    const p = canon(parts.join('/'));
    if (same(sig, sign(`vm\0${host}\0${p}`))) return { host, p };
    const scope = scopeOf(sig, p, (d) => `vmdir\0${host}\0${d}`);
    return scope ? { host, p, scope } : null;
  }
  return null;
}

/* The folder of p's that sig was made for, if any (never / itself). */
function scopeOf(sig, p, what) {
  for (let d = path.posix.dirname(p); d !== '/'; d = path.posix.dirname(d)) if (same(sig, sign(what(d)))) return d;
  return null;
}

/* { url } to open as a page, { app: true } when the Mac's app opened it, or { error }. */
/* how: 'dropped' when the owner dropped the file on Flow from Finder, which opens it wherever it is. */
async function open(host, file, how) {
  if (host) return vm ? vm.open(host, file, vmFolders(host)) : { error: 'files on the VM are not set up' };
  const dropped = how === 'dropped' && absolute(file);
  if (!dropped && !shown(file)) return { error: 'not in a workspace folder' };
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch (e) {
    return { error: reason(e) };
  }
  if (st.isDirectory()) {
    if (!PACKAGE_RE.test(file)) return { error: 'a folder' };
