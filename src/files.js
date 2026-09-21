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
