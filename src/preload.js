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

  // frame (optional): { x, y, width, height, maximized, fullScreen }, as closePopout gives it
  openWindow: (hash, frame) => ipcRenderer.send('window:open', hash == null ? '' : String(hash), frame && typeof frame === 'object'
    ? { x: Number(frame.x), y: Number(frame.y), width: Number(frame.width), height: Number(frame.height), maximized: !!frame.maximized, fullScreen: !!frame.fullScreen } : null),
  // the pop-out holding { ws, zone } closes, saving what it shows: its frame, null when none holds it; rejects while it
  // has pages with unsaved changes
  closePopout: (space) => ipcRenderer.invoke('popouts:close', space && typeof space === 'object' ? { ws: String(space.ws), zone: space.zone == null ? null : String(space.zone) } : null),
  popouts: () => ipcRenderer.invoke('popouts:list'),
  popoutFrames: () => ipcRenderer.invoke('popouts:frames'),
  onPopouts: (cb) => listen('popouts:changed', cb),
  focusPopout: (space) => ipcRenderer.invoke('popouts:focus', space),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath == null ? '' : String(defaultPath)),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveClipboardImage: () => ipcRenderer.invoke('clipboard:saveImage'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', String(url)),
  // a native menu at the pointer: items [{ id, label, enabled } or { type: 'separator' }], at { x, y } in the window;
  // resolves to the chosen id, or null when dismissed
  menu: {
    popup: (items, at) => ipcRenderer.invoke('menu:popup', Array.isArray(items) ? items.map((i) => (i && i.type === 'separator' ? { type: 'separator' }
      : { id: String(i && i.id), label: String(i && i.label), enabled: !(i && i.enabled === false) })) : [], at && typeof at === 'object' ? { x: Number(at.x), y: Number(at.y) } : null),
  },
  // the window's own undo, redo or paste ('undo' | 'redo' | 'paste'), as the Edit menu's roles do
  nativeEdit: (cmd) => ipcRenderer.send('edit:native', String(cmd)),
  onMenu: (cb) => listen('menu', cb),
  // { n, t, dx } from the trackpad's touches (macOS, src/touch.js): n fingers down, t epoch ms, dx px since the last
  // report while three or more move sideways (positive when they move left)
  onFingers: (cb) => {
    const off = listen('fingers', cb);
    ipcRenderer.send('fingers:wanted');
    return off;
  },
  onPageNewWindow: (cb) => listen('page:new-window', cb),
  onPageClip: (cb) => listen('page:clip', cb),
  onPageDownload: (cb) => listen('page:download', cb),
  // { id, guestId } as a page's download starts: the window answers downloadIn(id, the page's workspace id), and the
  // download then comes back to it, or to the main window once it has closed, as onDownloadDone { id, wsId, url, file,
  // state, bytes } however its tab ended.
  onDownloadStarted: (cb) => listen('download:started', cb),
  downloadIn: (id, wsId) => ipcRenderer.send('download:workspace', Number(id), String(wsId)),
  onDownloadDone: (cb) => listen('download:done', cb),
  showItemInFolder: (file) => ipcRenderer.send('shell:showItemInFolder', String(file)),
  onPageUnloadBlocked: (cb) => listen('page:unload-blocked', cb),
  allowUnload: (guestId) => ipcRenderer.invoke('page:allowUnload', Number(guestId)),
  pageHasUnsavedChanges: (guestId) => ipcRenderer.invoke('page:hasUnsavedChanges', Number(guestId)),
  zoomPage: (guestId, step) => ipcRenderer.invoke('page:zoom', Number(guestId), Number(step)),
  setPageZoom: (guestId, level) => ipcRenderer.invoke('page:setZoom', Number(guestId), Number(level)),
  pageHistory: (guestId) => ipcRenderer.invoke('page:history', Number(guestId)),
  // a two-finger pinch the page does not take itself: zoom the page inside at the fingers ({ deltaY, x, y, vv })
  pinchPage: (guestId, p) => ipcRenderer.invoke('page:pinch', Number(guestId), p),
  // this page's camera and microphone answers ({ camera, microphone, mac }): 'on' | 'off' | 'ask', and the OS's own
  // state for both; setMedia(guestId, 'camera' | 'microphone', state) answers for the site and returns the new state.
  pageMedia: (guestId) => ipcRenderer.invoke('page:media', Number(guestId)),
  setPageMedia: (guestId, device, state) => ipcRenderer.invoke('page:setMedia', Number(guestId), String(device), String(state)),
  onPageMediaChanged: (cb) => listen('page:media-changed', cb),
  // Where a page's PDF is shown ({ x, y }, or null with no PDF); and once it has loaded, its thumbnails pane closed and
  // a place from before a restart set (true once it holds).
  pdfPlace: (guestId) => ipcRenderer.invoke('page:pdfPlace', Number(guestId)),
  pdfShown: (guestId, at) => ipcRenderer.invoke('page:pdfShown', Number(guestId), at),
  restorePageNext: (src, history) => ipcRenderer.invoke('page:restoreNext', String(src), history),
  onPageOpenExternal: (cb) => listen('page:open-external', cb),
  answerExternal: (requestId, open) => ipcRenderer.send('page:answerExternal', Number(requestId), open === true),
  // A site's sign-in on a page: { guestId, requestId, host, again }, answered by answerPageLogin(requestId, { user,
  // password }), or null for none (the site's own page then shows).
  onPageLogin: (cb) => listen('page:login', cb),
  answerPageLogin: (requestId, answer) => ipcRenderer.send('page:answerLogin', Number(requestId),
    answer ? { user: String(answer.user), password: String(answer.password) } : null),
  onUnsavedPages: (cb) => {
    const off = listen('window:unsaved-pages', cb);
    ipcRenderer.send('window:unsaved-shown');
    return off;
  },
  closeAnyway: (action) => ipcRenderer.send('window:close-anyway', action === 'quit' ? 'quit' : 'close'),
  // Before this window goes away (a quit, or its own close), main calls cb and waits for the promise it returns (for
  // at most 2 s, and for every cb registered): cb saves what the window shows.
  onFlushPages: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('flow: window:flush-pages listener must be a function');
    flushers.add(cb);
    if (flushers.size === 1) ipcRenderer.send('window:flush-shown', true);
    return () => {
      if (flushers.delete(cb) && !flushers.size) ipcRenderer.send('window:flush-shown', false);
    };
  },
});




