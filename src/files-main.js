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
  } else if (!st.isFile()) {
    return { error: 'not a file' };
  } else if ((await kindOf(file, st.size)) !== 'other') {
    return { url: dropped ? dropUrlOf(file) : urlOf(file) };
  }
  const err = await shell.openPath(file);
  return err ? { error: err } : { app: true };
}

function reveal(file) {
  if (!shown(file)) {
    console.warn(`[flow] files: refused to show ${file} in Finder: not in a workspace folder`);
    return;
  }
  shell.showItemInFolder(file);
}

/* ---------- the flow-file: scheme on the pages' session ---------- */
const privileges = { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true } };

// Every answer is used only as the type it says: a text file never loads as a script or a style sheet.
const STRICT = { 'x-content-type-options': 'nosniff' };
const SCOPE_HEADER = 'x-flow-scope';
const plain = (status, text) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': TEXT_CSP, ...STRICT } });

/* A report page's policy: its inline code, and scripts, styles, images, fonts and media from under its own folder's
   address; nothing from the network, no fetch, no frames, no workers, no forms. */
function scopedCsp(origin) {
  const base = origin.host
    ? `${SCHEME}://vm/${sign(`vmdir\0${origin.host}\0${origin.scope}`)}/${encodeURIComponent(origin.host)}/${encoded(origin.scope)}/`
    : `${SCHEME}://mac/${sign(`macdir\0${origin.scope}`)}/${encoded(origin.scope)}/`;
  return `default-src 'none'; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src data: blob: ${base}; `
    + `font-src data: ${base}; media-src data: blob: ${base}; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; `
    + 'sandbox allow-scripts allow-same-origin';
}

/* A report page leaves its flow-file: pages only when the owner clicks a link or presses a key in it, so a script there
   cannot send the page, or anything it shows, to the network; the sandbox above already stops its popups, forms and
   downloads. (WebRTC, which no page policy covers, is cut off by main.js for flow-file: html pages.) */
let guarding = false;
const OWNER_MS = 1000;
const ownerAt = new WeakMap();   // webContents -> when the owner last pressed the mouse or a key in it
function guardReports(wc) {
  wc.on('before-mouse-event', (_event, m) => { if (m.type === 'mouseDown') ownerAt.set(wc, Date.now()); });
  wc.on('before-input-event', (_event, i) => { if (i.type === 'keyDown') ownerAt.set(wc, Date.now()); });
  wc.on('will-navigate', (event) => {
    const from = wc.getURL();
    if (!from.startsWith(`${SCHEME}:`) || event.url.startsWith(`${SCHEME}:`) || !URL.canParse(from)) return;
    const n = named(new URL(from));
    if (!n || !n.scope || Date.now() - (ownerAt.get(wc) || 0) < OWNER_MS) return;
    event.preventDefault();
    console.warn(`[flow] files: a report page went for ${event.url.slice(0, 120)} with no click or key from the owner; it stays`);
  });
}
const escHTML = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* A text or code file as a page titled with its name, read as a .md is: the same dark page and colors, in the .md's
   code font. */
const TEXT_STYLE = ':root{color-scheme:dark}html{background:#0f0f11;color:#d9d9dd}body{margin:0;padding:16px 20px 48px}'
  + 'pre{margin:0;white-space:pre-wrap;word-wrap:break-word;font:12px/1.55 "SF Mono",ui-monospace,Menlo,Monaco,Consolas,monospace}'
  + '::selection{background:#4a3f66}';
function textPage(file, text) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHTML(path.basename(file))}</title>`
    + `<style>${TEXT_STYLE}</style></head>`
    + `<body><pre>${escHTML(text)}</pre></body></html>`;
}

/* A VM file goes to the VM module as flow-file://vm/<host>/<path>, its signature checked and taken off. */
async function serve(req) {
  const n = named(new URL(req.url));
  if (!n) {
    console.warn(`[flow] files: refused ${req.url}: not an address this Flow made`);
    return plain(403, 'refused');
  }
  if (n.host) return vm ? vm.serve(new Request(`${SCHEME}://vm/${encodeURIComponent(n.host)}/${encoded(n.p)}`, n.scope ? { headers: { [SCOPE_HEADER]: n.scope } } : undefined), vmFolders(n.host)) : plain(404, 'not there');
  const { file } = n;
  if (!n.dropped && !shown(file)) return plain(403, 'not in a workspace folder');
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch (e) {
    return plain(e.code === 'ENOENT' ? 404 : 403, reason(e));
  }
  if (!st.isFile()) return plain(404, 'not a file');
  return respond(file, st, n.scope ? { host: null, path: file, scope: n.scope } : undefined);
}

/* A local file as a page (a Mac file, or the VM module's copy of a VM file): its own type for a pdf, an image or html,
   a text page for text, a .md rendered, refused for anything else. origin: where the file is ({ host, path }; a VM
   copy's links resolve on the VM), this Mac's path by default; origin.scope: the report folder the page was asked for
   under, if any. */
async function respond(file, st, origin) {
  if (origin && origin.host) {
    const k = `${origin.host}\0${origin.path}`;
    vmSizes.delete(k);
    vmSizes.set(k, st.size);
    if (vmSizes.size > VM_SIZES) vmSizes.delete(vmSizes.keys().next().value);
  }
  const scope = origin && origin.scope;
  const raw = scope && SCOPED_TYPES[path.extname(file).slice(1).toLowerCase()];
  if (raw) return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'content-type': raw, 'content-length': String(st.size), ...STRICT } });
  const kind = await kindOf(file, st.size);
  if (kind === 'other') return plain(415, 'flow does not show this kind of file');
  if (kind === 'md') {
    const text = await fs.promises.readFile(file, 'utf8');
    const html = markdown.render(text, mdRules(origin || { host: null, path: file }));
    return new Response(mdPage(file, html), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': MD_CSP, ...STRICT } });
  }
  if (kind === 'text') {
    const text = await fs.promises.readFile(file, 'utf8');
    return new Response(textPage(file, text), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': TEXT_CSP, ...STRICT } });
  }
  const headers = { 'content-type': TYPES[path.extname(file).slice(1).toLowerCase()], 'content-length': String(st.size), ...STRICT };
  if (kind === 'html') {
    headers['content-security-policy'] = scope ? scopedCsp(origin) : HTML_CSP;
    headers['referrer-policy'] = 'no-referrer';
    headers['x-dns-prefetch-control'] = 'off';
    if (await undeclaredUtf8(file)) headers['content-type'] = 'text/html; charset=utf-8';
  }
  if (headers['content-type'] === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return new Response(Readable.toWeb(fs.createReadStream(file)), { headers });
}

/* ---------- a .md as the owner reads it: rendered in the look of a Flow note, and live while it shows ---------- */
const MD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src flow-file: https: data:";
const MD_STYLE = ':root{color-scheme:dark}html{background:#0f0f11;color:#d9d9dd}'
  + 'body{margin:0;padding:22px 28px 64px;font:13px/1.65 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}'
  + 'article{max-width:780px}article>:first-child{margin-top:0}'
  + 'h1,h2,h3,h4,h5,h6{color:#f0f0f2;font-weight:600;line-height:1.3;margin:1.5em 0 .55em}h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}h4,h5,h6{font-size:13px}'
  + 'p,ul,ol,pre,blockquote,table,details{margin:0 0 .85em}ul,ol{padding-left:22px}li>p{margin:0 0 .4em}'
  + 'li.task{list-style:none}li.task>input,li.task>p:first-child>input{margin:0 6px 0 -18px;accent-color:#d97757}'
  + 'a{color:#8fb5f0;text-decoration:none}a:hover{text-decoration:underline}'
  + 'code{font:12px/1.55 "SF Mono",ui-monospace,Menlo,Monaco,Consolas,monospace;background:#1c1c1f;border-radius:4px;padding:1px 4px}'
  + 'pre{background:#161618;border:1px solid #26262a;border-radius:6px;padding:10px 12px;overflow:auto}pre code{background:none;padding:0}'
  + 'blockquote{margin-left:0;padding-left:12px;border-left:2px solid #3a3a40;color:#a9a9b0}hr{border:0;border-top:1px solid #26262a;margin:1.5em 0}'
  + 'table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #26262a;padding:4px 10px}th{color:#f0f0f2;font-weight:600;background:#151517}'
  + 'img{max-width:100%}kbd{font:11px "SF Mono",ui-monospace,Menlo,monospace;border:1px solid #3a3a40;border-bottom-width:2px;border-radius:4px;padding:0 4px}'
  + 'summary{cursor:pointer}del{color:#8d8d93}::selection{background:#4a3f66}';
const mdPage = (file, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${escHTML(path.basename(file))}</title>`
  + `<style>${MD_STYLE}</style></head><body><article>${body}</article></body></html>`;

/* Links and images in a .md: a web address as it is, an anchor in the page, and a path relative to the file by its
   signed address when it names a file inside a workspace folder (on the VM: one of that host's workspace folders, by
   the VM's path). Anything else, another scheme, a hidden name or a folder, stays text. */
function mdRules(origin) {
  const here = path.posix.dirname(origin.path);
  function fileHref(raw, image) {
    const hash = raw.indexOf('#');
    const frag = hash >= 0 ? raw.slice(hash) : '';
    let rel = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/\?.*$/, '');
    try {
      rel = decodeURIComponent(rel);
    } catch (e) {
      if (e instanceof URIError) return null;
      throw e;
    }
    if (!rel) return null;
    if (rel.split('/').some((x) => x.startsWith('.') && x !== '.' && x !== '..')) return null;
    const abs = path.posix.resolve(here, rel);
    if (image && !(TYPES[path.extname(abs).slice(1).toLowerCase()] || '').startsWith('image/')) return null;
    // On the VM the same rules as here, from the VM module, which knows how that host's workspace folders resolve, and
    // knows a folder from its listings (kindAt); a link to a folder stays text, as the stat below keeps it here.
    if (origin.host) return vm && vm.shown && vm.shown(origin.host, abs, vmFolders(origin.host)) && !(vm.kindAt && vm.kindAt(origin.host, abs) === 'dir') ? vmUrlOf(origin.host, abs) + frag : null;
    if (!shown(abs)) return null;
    try {
      if (fs.statSync(abs).isDirectory()) return null;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return urlOf(abs) + frag;
  }
  return {
    link(href) {
      const h = String(href).trim();
      if (h.startsWith('#') || /^(https?|mailto):/i.test(h)) return h;
      if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null;
      return fileHref(h, false);
    },
    image(src) {
      const h = String(src).trim();
      if (/^https:/i.test(h) || /^data:image\/(png|jpe?g|gif|webp);/i.test(h)) return h;
      if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null;
      return fileHref(h, true);
    },
  };
}

/* A file's tab on screen re-renders when the file changes (an agent writing a plan, code or a log). A .md keeps the
