/* FlowFiles: a workspace's files in the sidebar (BRIEF 3.0), under each space that has some. One row for each place
   they live: the workspace folder on the Mac, its folder on the VM when it runs there ("on the VM"), and what its pages
   downloaded; a sub-workspace shows its own folder, when it has one, and what its own pages downloaded. A folder
   unfolds in place, one level at a time. A click on a file opens it as a page, or in the Mac's app when Flow cannot
   show it. Dragging a row onto a terminal types its path. Only the folders the sidebar shows are listed and watched. */
(() => {
  'use strict';

  const flow = window.flow;
  const SHOW = 300;   // names of one folder drawn before an "n more" row
  const DEEPEST = 8;  // deeper folders keep this indent (files.css)
  let A = null;
  let carried = null;   // this window's file row being dragged; cleared at drag end or its one board drop

  /* ---------- listings, one per folder shown, refreshed when it changes ---------- */
  const keyOf = (host, p) => `${host || ''}\n${p}`;
  const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
  const baseName = (p) => String(p).split('/').filter(Boolean).pop() || p;
  const listings = new Map();   // keyOf(host, dir) -> { ok, path, entries, total, error, loading, stale, all }

  function listing(host, dir) {
    const k = keyOf(host, dir);
    let L = listings.get(k);
    if (!L) {
      L = { ok: null, path: '', entries: [], total: 0, error: '', loading: false, stale: true, all: false };
      listings.set(k, L);
    }
    if (L.stale && !L.loading) load(host, dir, L);
    return L;
  }
  const shape = (L) => `${L.ok}|${L.error}|${L.total}|${L.entries.map((e) => `${e.kind}:${e.name}`).join('/')}`;
  function load(host, dir, L) {
    L.loading = true;
    L.stale = false;
    flow.files.list(host, dir).then((r) => {
      L.loading = false;
      const before = shape(L);
      const failed = L.ok === false;
      L.ok = !!(r && r.ok);
      // A VM folder is asked for as typed ('~/src'); its listing says where that is, and its rows use that path.
      L.path = (L.ok && r.path) || dir;
      L.entries = L.ok ? r.entries : [];
      L.total = L.ok ? r.total : 0;
      L.error = L.ok ? '' : (r && r.error) || 'could not list it';
      // The VM is back: its other folders that failed meanwhile are listed again when they show.
      if (host && failed && L.ok) listings.forEach((X, k) => { if (X.ok === false && k.startsWith(`${host}\n`)) X.stale = true; });
      if (L.stale) load(host, dir, L);
      else if (shape(L) !== before) A.renderSidebar();
    }, (e) => {
      L.loading = false;
      L.ok = false;
      L.error = 'could not list it';
      console.error(`files: could not list ${dir}${host ? ` on ${host}` : ''}`, e);
      A.renderSidebar();
    });
  }

  /* ---------- rows: stable ids for what each row stands for ---------- */
  const nodes = new Map();   // id -> { t: 'dir'|'file'|'more'|'dls', ws, zone, host, path, key }
  const ids = new Map();
  let seq = 0;
  function idOf(n) {
    const k = `${n.t}\n${n.ws.id}\n${n.zone || ''}\n${keyOf(n.host, n.path || '')}`;
    let id = ids.get(k);
    if (!id) {
      id = (++seq).toString(36);
      ids.set(k, id);
    }
    nodes.set(id, n);
    return `files|${id}`;
  }
  const nodeOf = (act) => nodes.get(String(act).split('|')[1]) || null;

  /* Where a space's files live: the workspace's folder on the Mac, and its folder on the VM when it runs there; a
     sub-workspace's (zn) own folder there, only when it has one (zn.folder, or zn.hostFolder on the VM). Each row is
     named as Finder names a folder (the VM's home folder as "home"). */
  function placesOf(ws, zn) {
    const at = zn || ws;
    const out = [];
    if (at.folder) out.push({ host: null, path: A.expand(at.folder), label: baseName(A.expand(at.folder)), where: '' });
    if (ws.host && (!zn || zn.hostFolder)) {
      const typed = at.hostFolder || '~';
      out.push({ host: ws.host, path: typed, label: typed === '~' ? 'home' : baseName(typed), where: 'on the VM' });
    }
    // A workspace that runs on this Mac can still have agents on the VM: their folders there are its VM files too.
    (ws.vmPlaces || []).filter((v) => (v.zone || '') === (zn ? zn.id : '') && !out.some((o) => o.host === v.host && o.path === v.path))
      .forEach((v) => out.push({ host: v.host, path: v.path, label: v.path === '~' ? 'home' : baseName(v.path), where: 'on the VM' }));
    return out;
  }
  /* The folder each VM window of a workspace works in: a team's lead pane's (teams.js polls it, an attach team like the
     VM's ccm included), else a terminal's own cwd as Flow started it. Kept in ws.vmPlaces, so they show at once after a
     restart and main lets their files open; a team not polled yet keeps the folder last seen for it. */
  function noteVmPlaces(ws) {
    if (ws.host && !ws.vmPlaces) return;
    const T = window.FlowTeams;
    const got = [];
    if (!ws.host) ws.windows.forEach((w) => {
      if (!w.host) return;
      const panes = T && T.members ? T.members(w) : [];
      const lead = panes.length ? panes.reduce((a, b) => (b.index < a.index ? b : a)) : null;
      const kept = (ws.vmPlaces || []).find((v) => v.win === w.id);
      const p = lead && lead.cwd ? lead.cwd : w.type === 'term' && !w.attach ? w.cwd || '~' : kept && kept.path;
      if (p && !got.some((g) => g.host === w.host && g.path === p)) got.push({ host: w.host, path: p, win: w.id, ...(w.zone ? { zone: w.zone } : {}) });
    });
    if (JSON.stringify(got) === JSON.stringify(ws.vmPlaces || [])) return;
    if (got.length) ws.vmPlaces = got;
    else delete ws.vmPlaces;
    A.save();
  }
  const zoneOf = (ws, id) => (ws.zones || []).find((z) => z.id === id) || null;
  /* What a space's pages downloaded: a sub-workspace's own, and in the main space the rest (one whose sub-workspace is
     gone shows there, so nothing is lost). */
  const downloadsOf = (ws, zn) => (ws.downloads || []).filter((d) => (zn ? d.zone === zn.id : !d.zone || !zoneOf(ws, d.zone)));
  /* Folded and unfolded is kept per space: the same folder can show in the main space and in a sub-workspace. */
  const inSpace = (zn, key) => (zn ? `${zn.id}|${key}` : key);
  const unfolded = (ws, key) => (ws.filesOpen || []).includes(key);
  function toggle(ws, key) {
    const list = ws.filesOpen || (ws.filesOpen = []);
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1);
    else list.push(key);
    A.renderSidebar();
    A.save();
  }

  /* The file a page shows, as keyOf(host, path), from its address flow-file://mac/<sig>/<path> or
     flow-file://vm/<sig>/<host>/<path>; null for any other page. */
  function fileOfPage(url) {
    const m = /^flow-file:\/\/(mac|vm)\/[^/]+\/(.*)$/i.exec(url || '');
    if (!m) return null;
    let parts;
    try {
      parts = m[2].split('/').filter(Boolean).map(decodeURIComponent);
    } catch (e) {
      if (e instanceof URIError) return null;
      throw e;
    }
    if (m[1].toLowerCase() === 'mac') return keyOf(null, '/' + parts.join('/'));
    const host = parts.shift();
    return host ? keyOf(host, '/' + parts.join('/')) : null;
  }

  let shownDirs = [];
  let frame = null;   // the folders one draw of the sidebar shows, gathered over its rows() calls (one per space)
  /* Whether a space (zoneId: a sub-workspace's id, none for the main space) has files to show. */
  function has(ws, zoneId) {
    const zn = zoneId ? zoneOf(ws, zoneId) : null;
    if (zoneId && !zn) return false;
    return placesOf(ws, zn).length > 0 || downloadsOf(ws, zn).length > 0;
  }
  /* The sidebar draws a space's files from these (add is its row maker; open, its open pages { w, i, url }; zoneId, the
     sub-workspace's id, none for the main space). Folded places cost one row and no listing. A file open as a page is
     marked on its own row, as an open saved page is: ↗, and × closes it; it gets no row in browser, so nothing shows
     twice or moves when a file opens. */
  function rows(ws, add, open, zoneId) {
    if (!flow.files) return;
    const zn = zoneId ? zoneOf(ws, zoneId) : null;
    if (zoneId && !zn) return;
    const zone = zn ? zn.id : '';
    if (!zn) noteVmPlaces(ws);
    if (!frame) {
      frame = [];
      queueMicrotask(() => {
        shownDirs = frame;
        frame = null;
        sync();
      });
    }
    const want = [];
    const opened = new Map();
    (open || []).forEach((p) => { const k = fileOfPage(p.url); if (k && !opened.has(k)) opened.set(k, `${p.w.id}|${p.i}`); });
    const fileRow = (depth, host, p, label) => {
      const act = idOf({ t: 'file', ws, zone, host, path: p });
      const at = opened.get(keyOf(host, p));
      add('files', depth, at ? '↗' : '', label, '', act, { drag: act, close: at || '' });
    };
    const tree = (host, dir, level) => {
      const depth = Math.min(level, DEEPEST);
      const L = listing(host, dir);
      // A VM folder that could not be listed stays watched: the VM side retries and says when it is back.
      if (L.ok || (host && L.ok === false)) want.push({ host, dir });
      const names = L.entries.filter((e) => !e.name.startsWith('.'));
      const list = L.all ? names : names.slice(0, SHOW);
      list.forEach((e) => {
        const p = join(L.path || dir, e.name);
        if (e.kind !== 'dir') {
          fileRow(depth, host, p, e.name);
          return;
        }
        const key = inSpace(zn, keyOf(host, p));
        const down = unfolded(ws, key);
        const sub = down ? listing(host, p) : null;
        const act = idOf({ t: 'dir', ws, zone, host, path: p, key });
        add('files', depth, down ? '▾' : '▸', e.name, sub && sub.ok === false ? sub.error : '', act, { dim: !!(sub && sub.ok === false), drag: act });
        if (down) tree(host, p, level + 1);
      });
      // Past SHOW names a click draws the rest; past what main lists (5000) the folder opens in Finder.
      const more = names.length > list.length ? names.length - list.length : L.total - L.entries.length;
      if (more > 0) add('files', depth, '', `${more} more`, '', idOf({ t: 'more', ws, zone, host, path: dir }), { dim: true });
    };
    placesOf(ws, zn).forEach((pl) => {
      const key = inSpace(zn, keyOf(pl.host, pl.path));
      const down = unfolded(ws, key);
      const L = down ? listing(pl.host, pl.path) : null;
      const meta = [pl.where, L && L.ok === false ? L.error : ''].filter(Boolean).join(' · ');
      const act = idOf({ t: 'dir', ws, zone, host: pl.host, path: pl.path, key });
      add('files', 0, down ? '▾' : '▸', pl.label, meta, act, { dim: !!(L && L.ok === false), drag: act });
      if (down) tree(pl.host, pl.path, 1);
    });
    const dls = downloadsOf(ws, zn);
    if (dls.length) {
      checkDownloads(ws);
      const key = inSpace(zn, 'downloads');
      const down = unfolded(ws, key);
      add('files', 0, down ? '▾' : '▸', 'downloads', dls.length, idOf({ t: 'dls', ws, zone, host: null, path: '', key }));
      if (down) {
        dls.forEach((d) => fileRow(1, null, d.file, baseName(d.file)));
        [...new Set(dls.map((d) => d.file.slice(0, d.file.lastIndexOf('/')) || '/'))].forEach((dir) => want.push({ host: null, dir, downloads: true }));
      }
    }
    frame.push(...want);
  }

  /* ---------- a sub-workspace's own folder, for its heading's "folder" item ---------- */
  /* The folder in use there, as shown: its own, else the workspace's (on the VM as typed). */
  function folderOf(ws, zoneId) {
    const zn = zoneOf(ws, zoneId);
    if (ws.host) return (zn && zn.hostFolder) || ws.hostFolder || '~';
    return A.tilde(A.expand((zn && zn.folder) || ws.folder || '~'));
  }
  /* On a Mac workspace the Mac's folder picker chooses it; false when nothing was chosen, or on the VM, whose folders
     the picker cannot browse (the item types one there: setFolder). */
  async function pickFolder(ws, zoneId) {
    const zn = zoneOf(ws, zoneId);
    if (!zn || ws.host) return false;
    const p = await flow.pickFolder(A.expand(zn.folder || ws.folder || '~'));
    if (!p) return false;
    zn.folder = A.tilde(p);
    A.renderSidebar();
    A.save();
    return true;
  }
  /* A typed folder: on the VM as the VM's shells read it ('~/x', 'x' from the home folder, '/x'); on the Mac only
     '~', '~/x' or '/x'. '' goes back to the workspace's folder. */
  function setFolder(ws, zoneId, typed) {
    const zn = zoneOf(ws, zoneId);
    if (!zn || typeof typed !== 'string') return false;
    const v = typed.trim();
    if (!ws.host && v && !(v === '~' || v.startsWith('~/') || v.startsWith('/'))) return false;
    const k = ws.host ? 'hostFolder' : 'folder';
    if (v) zn[k] = v;
    else delete zn[k];
    A.renderSidebar();
    A.save();
    return true;
  }

  /* ---------- downloads: each finished one is kept in the workspace whose page downloaded it, in its space ---------- */
  function downloaded(ws, d, zoneId) {
    if (!ws || !d || d.state !== 'completed' || !d.file) return;
    const list = ws.downloads || (ws.downloads = []);
    const i = list.findIndex((x) => x.file === d.file);
    // main reports the same download again without the page's space (download:done after the page's onDownload): it keeps
    // the space it was given
    const zone = zoneId || (i >= 0 ? list[i].zone : '');
    if (i >= 0) list.splice(i, 1);
    list.unshift({ file: d.file, url: d.url || '', at: Date.now(), ...(zone ? { zone } : {}) });
    checked.set(ws, list.map((x) => x.file).join('\n'));
    A.renderSidebar();
    A.save();
  }
  /* A download moved or trashed in Finder leaves the list. Checked when the list changes or the window comes back. */
  const checked = new WeakMap();   // ws -> the downloads it was checked with
  function checkDownloads(ws) {
    const sig = ws.downloads.map((x) => x.file).join('\n');
    if (checked.get(ws) === sig) return;
    checked.set(ws, sig);
    const files = ws.downloads.map((x) => x.file);
    flow.files.exist(files).then((there) => {
      const gone = new Set(files.filter((_f, i) => !there[i]));
      if (!gone.size) return;
      ws.downloads = (ws.downloads || []).filter((x) => !gone.has(x.file));
      checked.set(ws, ws.downloads.map((x) => x.file).join('\n'));
      A.renderSidebar();
      A.save();
    }, (e) => {
      checked.delete(ws);
      console.error(`files: could not check the downloads of ${ws.name}`, e);
    });
  }

  /* ---------- watching: the folders shown in the sidebar, while it shows them ---------- */
  let watching = '[[],[]]', syncing = false;
  function syncSoon() {
    if (syncing) return;
    syncing = true;
    queueMicrotask(() => { syncing = false; sync(); });
  }
  /* The files a page tab shows in the space on screen (on this Mac or the VM): main re-renders such a tab when its file
     changes. Not a pdf: its viewer would start again at the first page. */
  const PDF_RE = /\.pdf$/i;
  function shownFiles() {
    const ws = A.WS[A.cur];
    if (document.hidden || !ws) return [];
    const zone = new URLSearchParams(location.hash.slice(1)).get('zone');
    const at = zone || (ws.at && (ws.zones || []).some((z) => z.id === ws.at) ? ws.at : null);
    const out = [];
    ws.windows.forEach((w) => {
      if (w.type !== 'page' || (w.zone || null) !== at) return;
      const tabs = Array.isArray(w.tabs) && w.tabs.length ? w.tabs : null;
      const n = tabs ? null : ws.notes.find((x) => x.id === w.noteId);
      const k = fileOfPage(tabs ? (tabs[w.tab] || tabs[0]).url : n && n.url);
      const [host, file] = k ? k.split('\n') : [];
      if (k && !PDF_RE.test(file) && !out.some((x) => x.file === file && x.host === (host || null))) out.push({ host: host || null, file });
    });
    return out;
  }
  function sync() {
    const { sb, sblist, q } = A.els;
    const onScreen = !document.hidden && !sb.classList.contains('hide') && !q.value.trim() && !!sblist.querySelector('.tr[data-act^="files|"]');
    const dirs = onScreen ? shownDirs.map((d) => ({ host: d.host, dir: d.dir })) : [];
    const files = shownFiles();
    const next = JSON.stringify([dirs, files]);
    if (next === watching) return;
    // A folder no longer watched may change unseen: it is listed again the next time it shows.
    const kept = new Set(dirs.map((d) => keyOf(d.host, d.dir)));
    JSON.parse(watching)[0].forEach((d) => {
      const L = listings.get(keyOf(d.host, d.dir));
      if (L && !kept.has(keyOf(d.host, d.dir))) L.stale = true;
    });
    watching = next;
    flow.files.watch([...dirs, ...files]);
    dirs.forEach((d) => {
      const L = listings.get(keyOf(d.host, d.dir));
      if (L && L.stale && !L.loading) load(d.host, d.dir, L);
    });
  }
  function changed({ host, dir }) {
    const L = listings.get(keyOf(host, dir));
    if (L) {
      L.stale = true;
      if (!L.loading) load(host, dir, L);
    }
    if (!host && shownDirs.some((d) => d.downloads && d.dir === dir)) {
      const ws = A.WS[A.cur];
      if (ws) checked.delete(ws);
      A.renderSidebar();
    }
  }

  /* ---------- what a row does ---------- */
  async function openFile(ws, n, at) {
    const name = baseName(n.path);
    let r;
    try {
      r = await flow.files.open(n.host, n.path);
    } catch (e) {
      console.error(`files: could not open ${n.path}`, e);
      A.toast(`could not open ${name}`, 4000);
      return;
    }
    if (r && r.url) A.openUrl(ws, r.url, at);
    else if (r && r.error) A.toast(`${name}: ${r.error}`, 4000);
  }
  function perform(ws, act) {
    const n = nodeOf(act);
    if (!n) return;
    if (n.t === 'dir') toggle(ws, n.key);
    else if (n.t === 'dls') toggle(ws, n.key);
    else if (n.t === 'file') openFile(ws, n);
    else if (n.t === 'more') {
      const L = listings.get(keyOf(n.host, n.path));
      if (L && !L.all && L.entries.filter((e) => !e.name.startsWith('.')).length > SHOW) {
        L.all = true;
        A.renderSidebar();
      } else if (!n.host) {
        flow.files.reveal(n.path);
      }
    }
  }
  /* Right-click: only "show in Finder", which hands every other file action to Finder. */
  function menu(ws, act) {
    const n = nodeOf(act);
    if (!n || n.host || (n.t !== 'dir' && n.t !== 'file')) return [];
    return [{ label: flow.platform === 'darwin' ? 'show in Finder' : 'show in its folder', hint: '', run: () => flow.files.reveal(n.path) }];
  }
  /* A row dragged onto a terminal types its path there (term.js; vmfiles carries it to the other machine); onto a
     note, the path as text. A VM folder asked for as '~' is dragged as the path its listing gave, since a quoted '~'
     does not expand. */
  function dragStart(e, act) {
    const n = nodeOf(act);
    if (!n || (n.t !== 'dir' && n.t !== 'file')) {
      e.preventDefault();
      return;
    }
    const own = n.host ? listings.get(keyOf(n.host, n.path)) : null;
    const p = own && own.ok ? own.path : n.path;
    carried = { ...n, path: p };
    e.dataTransfer.setData('application/x-flow-files', JSON.stringify([{ host: n.host || null, path: p }]));
    e.dataTransfer.setData('text/plain', p);
    e.dataTransfer.effectAllowed = 'copy';
  }
  function dragEnd() { carried = null; }
  const dragging = () => carried;
  /* A file dropped on bare board opens once, at the final world point captured after edge-pan. Directories still drag to
     terminals, but a board drop does nothing: it never starts a transfer or creates a duplicate page. */
  function dropOnBoard(ws, at) {
    const n = carried;
    carried = null;
    if (!n || n.t !== 'file') return false;
    openFile(ws, n, at);
    return true;
  }

  /* app: { WS, cur, els: { sb, sblist, q }, save, renderSidebar, toast, expand, tilde, openUrl(ws, url) }. */
  function mount(app) {
    A = app;
    if (!flow || !flow.files) {
      console.error('files: window.flow.files is missing, so the sidebar shows no files (main.js and preload.js register it)');
      return;
    }
    flow.files.onChanged(changed);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        const ws = A.WS[A.cur];
        if (ws) checked.delete(ws);
      }
      sync();
    });
    new MutationObserver(syncSoon).observe(A.els.sb, { attributes: true, attributeFilter: ['class'] });
    A.els.q.addEventListener('input', syncSoon);
    // a VM folder that says it is not reachable lists again as soon as the Mac's network or Flow's window is back
    window.addEventListener('online', () => flow.files.retry && flow.files.retry());
    window.addEventListener('focus', () => flow.files.retry && flow.files.retry());
  }

  window.FlowFiles = { mount, rows, has, perform, menu, dragStart, dragEnd, dragging, dropOnBoard, downloaded, folderOf, pickFolder, setFolder };
})();




