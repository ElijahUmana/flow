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
