'use strict';
// window.flow: the only bridge between Flow's renderer and the main process (BRIEF 2.1).

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const os = require('os');

const info = ipcRenderer.sendSync('flow:info');

const pagesOf = (opts) => (opts && Array.isArray(opts.pages) ? opts.pages.map(String) : null);

const flushers = new Set();
ipcRenderer.on('window:flush-pages', (_event, id) => {
  Promise.allSettled([...flushers].map((cb) => Promise.resolve().then(() => cb()))).then((results) => {
    for (const r of results) if (r.status === 'rejected') console.error('flow: saving what this window shows before it closes failed', r.reason);
    ipcRenderer.send('window:pages-flushed', id);
  });
});

function listen(channel, cb) {
  if (typeof cb !== 'function') throw new TypeError(`flow: ${channel} listener must be a function`);
  const fn = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('flow', {
  platform: process.platform,
  homeDir: os.homedir(),
  version: info.version,

  loadState: () => ipcRenderer.invoke('state:load'),
  // pages: the ids of the page windows this window shows (live), whose tabs the store then takes from it alone
  saveState: (obj, opts) => ipcRenderer.send('state:save', obj, pagesOf(opts), opts && opts.base),
  flushState: (obj, opts) => ipcRenderer.invoke('state:flush', obj, pagesOf(opts), opts && opts.base),
  workspaceRevision: (id) => ipcRenderer.invoke('state:revision', String(id)),
  closeWorkspaceState: (obj, targetId, expected, opts) => ipcRenderer.invoke('state:closeWorkspace', obj, pagesOf(opts), opts && opts.base,
    String(targetId), expected, opts && opts.revision),
  onStateChanged: (cb) => listen('state:changed', cb),

  term: {
    open: (opts) => ipcRenderer.invoke('term:open', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    detach: (id) => ipcRenderer.send('term:detach', id),
    kill: (id, opts) => ipcRenderer.invoke('term:kill', id, opts),
    restoreAttach: (id, opts) => ipcRenderer.invoke('term:restoreAttach', id, opts),
    exists: (id, opts) => ipcRenderer.invoke('term:exists', id, opts),
    list: (expected) => ipcRenderer.invoke('term:list', Array.isArray(expected) ? expected.map((x) => ({ id: String(x && x.id), cwd: String(x && x.cwd) })) : []),
    panes: (id, opts) => ipcRenderer.invoke('term:panes', id, opts),
    find: (id, op, opts) => ipcRenderer.invoke('term:find', id, op, opts),
    breakPane: (id, paneId, newId) => ipcRenderer.invoke('term:breakPane', id, paneId, newId),
    joinPane: (srcId, dstId) => ipcRenderer.invoke('term:joinPane', srcId, dstId),
    teammate: (id, paneId, opts) => ipcRenderer.invoke('term:teammate', id, paneId, opts),
    teamSessions: (id, opts) => ipcRenderer.invoke('term:teamSessions', id, opts),
    // { command } to type in any terminal to get back into the conversation, or { error } when it has no transcript
    // (nothing to resume yet) or its host can't be reached. opts: the window's { host, cwd }.
    resumeCommand: (sessionId, opts) => ipcRenderer.invoke('term:resumeCommand', String(sessionId == null ? '' : sessionId),
      { host: opts && opts.host ? String(opts.host) : '', cwd: opts && opts.cwd ? String(opts.cwd) : '' }),
    // Whether the window's conversation still runs in its pane: false once the claude Flow started there has exited (its
    // id is then stale for that window), null with no session. opts: the window's { host, attach }.
    holds: (id, sessionId, opts) => ipcRenderer.invoke('term:holds', id, String(sessionId == null ? '' : sessionId), opts),
    onData: (cb) => listen('term:data', cb),
    onExit: (cb) => listen('term:exit', cb),
  },

  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    search: (query, opts) => ipcRenderer.invoke('sessions:search', String(query == null ? '' : query), opts && typeof opts === 'object' ? {
      limit: Number(opts.limit) || 0,
      ...(opts.meaning ? { meaning: true, items: (Array.isArray(opts.items) ? opts.items : []).slice(0, 300).map((x) => ({ key: String((x && x.key) || ''), kind: String((x && x.kind) || ''), label: String((x && x.label) || ''), text: String((x && x.text) || '').slice(0, 600) })) } : {}),
    } : {}),
    running: () => ipcRenderer.invoke('sessions:running'),
    has: (id) => ipcRenderer.invoke('sessions:has', String(id == null ? '' : id)),
  },

  files: {
    list: (host, dir) => ipcRenderer.invoke('files:list', host ? String(host) : null, String(dir)),
    exist: (paths) => ipcRenderer.invoke('files:exist', Array.isArray(paths) ? paths.map(String) : []),
    open: (host, file, how) => ipcRenderer.invoke('files:open', host ? String(host) : null, String(file), how === 'dropped' ? 'dropped' : null),
    watch: (dirs) => ipcRenderer.send('files:watch', Array.isArray(dirs) ? dirs.map((d) => (d && d.file ? { host: d.host ? String(d.host) : null, file: String(d.file) } : { host: d && d.host ? String(d.host) : null, dir: String(d && d.dir) })) : []),
    reveal: (file) => ipcRenderer.send('files:reveal', String(file)),
    onChanged: (cb) => listen('files:changed', cb),
    copy: (host, p, macDir) => ipcRenderer.invoke('files:copy', String(host), String(p), macDir == null ? null : String(macDir)),
    put: (macFile, host, dir, opts) => ipcRenderer.invoke('files:put', String(macFile), String(host), String(dir), { make: !!(opts && opts.make) }),
    retry: () => ipcRenderer.invoke('files:retry'),
  },

