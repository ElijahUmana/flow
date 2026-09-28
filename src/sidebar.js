/* FlowSidebar: the sidebar and ⌘K (BRIEF 3.0). app.js mounts it once with hooks into its model and calls render()
   whenever something it shows has changed.
   Each space has a heading: the workspace's own name for its main space first, then each sub-workspace's; a click goes
   there, and the one on screen is marked. Under each: agents (a team folded, with its count), notes, browser (open pages; in the main
   workspace also the saved pages by section, a saved page that is open showing once), and files: the workspace's in
   the main one, a sub-workspace's own folder and downloads in it.
   Notes and pages share one section model, kept by notes.js. Nothing to make a new one shows at rest: while the
   pointer is over notes or browser, a "+" at the right of its heading makes an empty section, named in place; while a
   row is dragged, the heading of each group that can take it reads "+ new section", the end of the list "+ new
   sub-workspace", and a drop on either makes one with that tool inside. Nothing in the list moves for either. A
   right-click on the workspace's heading makes a new sub-workspace.
   A row's × closes an open page, saved or not, and deletes what is closed, with undo. Every row drags onto a
   workspace pill, a sub-workspace or a section. A double-click renames any row in place. */
(() => {
  'use strict';

  let A = null;
  let esc, hostOf, prettyTitle, tilde, newId, ago, termTitle, isTerm, noteById, zoneById, findWin, locate, zoneOf, curSpace, inSpace;
  let save, go, toast, focusWin, openNote, openPageWin, closeWin, addWindow, reopen, endAgent, popOut, showSpace, moveToSpace;
  let moveWindow, frontWin, freeSpot, renameInline, renameAgent, renameZone, showMenu, agentItems, forkSession, copyResume;
  let copyText, openSessionIds;
  let sb, sblist, q, spacesEl, viewport, WIN, SOLO, SOLO_ZONE;
  const NOTES = () => window.FlowNotes;

  /* One key for an address everywhere (open, saved, never twice, page records): notes.js's for web pages; anything
     else (a file, a blank page) by its address without a #fragment or a trailing slash. */
  const plainUrl = (u) => String(u || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
  const normUrl = (u) => (NOTES() && NOTES().key && NOTES().key(u)) || plainUrl(u);
  /* One name per page wherever it shows: the owner's, kept in the page's record by notes.js, else the page's own. */
  const nameOf = (url) => (NOTES() && NOTES().nameOf ? NOTES().nameOf(url) : '');
  const pageName = (url, own) => nameOf(url) || own || '';
  const noteName = (n) => (NOTES() && NOTES().noteName ? NOTES().noteName(n) : n.title);
  const remoteOf = (w) => (w.where && w.where !== 'this Mac' ? w.where : '');
  const spaceOf = (ws, w) => zoneOf(ws, w);
  function agentText(w) {
    const r = WIN.get(w.id);
    const screen = r && r.term && r.vis ? r.term.getText(400) : '';
    return `${w.note || ''} ${w.osc || ''} ${screen || ''}`;
  }

  /* Teams and sub-workspaces start folded (ui.open lists the unfolded ones); the main workspace, sections and groups
     start unfolded. ui.closed records any explicit fold, including the space on screen. Keys are
     `${ws.id}:<kind>:<id>`. */
  const FOLDED = new Set(['t', 'z']);
  const kindOf = (key) => key.split(':')[1];
  const explicitlyClosed = (key) => (A.ui.closed || []).includes(key);
  const unfolded = (key) => !explicitlyClosed(key) && (FOLDED.has(kindOf(key)) ? (A.ui.open || []).includes(key) : true);
  function toggleKey(key, down = unfolded(key)) {
    const ui = A.ui, next = !down;
    const closed = ui.closed || [];
    ui.closed = next ? closed.filter((x) => x !== key) : closed.includes(key) ? closed : [...closed, key];
    if (FOLDED.has(kindOf(key))) {
      const open = ui.open || [];
      ui.open = next ? open.includes(key) ? open : [...open, key] : open.filter((x) => x !== key);
    }
    render();
    save();
  }

  /* ---------- teams: the windows a lead spawned (w.mate.lead) or that were dropped on it (w.group) ---------- */
  const leadOf = (w) => (w.mate && w.mate.lead) || w.group || null;
  const isMember = (w, team) => leadOf(w) === team.id;
  function teamOf(ws, w) {
    const id = leadOf(w);
    return id ? findWin(ws, id) || ws.closed.find((x) => x.id === id) || null : null;
  }
  const membersOf = (ws, team) => [...ws.windows, ...ws.closed].filter((w) => isMember(w, team));
  /* A team that has no member windows yet may still run its teammates as tmux panes inside it. */
  const panesOf = (team) => (A.members ? A.members(team) : []);

  /* ---------- saved pages: ws.saved = [{ id, url, title, section, at }], section a page section's id; what a page is
     about lives in its page record (notes.js) ---------- */
  const savedOf = (ws) => ws.saved || (ws.saved = []);
  /* Sections are notes.js's. Without it the sidebar still draws them, but cannot make, move into or delete them, and
     says why in the console. */
  const pageSections = (ws) => (NOTES() ? NOTES().sections(ws, 'page') : ws.notes.filter((n) => n.kind === 'folder' && n.holds === 'page'));
  const isPageSection = (ws, id) => pageSections(ws).some((f) => f.id === id);
  const findSaved = (ws, url) => { const u = normUrl(url); return u ? (ws.saved || []).find((s) => normUrl(s.url) === u) || null : null; };
  const sectionTitle = (ws, id) => { const f = noteById(ws, id); return f ? f.title : 'saved'; };
  /* A section belongs to a space: its zone, a sub-workspace's id kept by notes.js, or main without one (or once that
     sub-workspace is gone). A saved page or a note in a section is in the section's space. */
  const secSpace = (ws, f) => (f && f.zone && zoneById(ws, f.zone) ? f.zone : '');
  const withZone = (o, zone) => (zone ? { ...o, zone } : o);
  /* The section used last in a space ('' for main), else its first, else a new one there called "saved". A notes.js
     that keeps no space on its sections (no moveSection) has main's only. */
  function lastSection(ws, zone = '') {
    if (zone && !(NOTES() && NOTES().moveSection)) zone = '';
    const here = (id) => isPageSection(ws, id) && secSpace(ws, noteById(ws, id)) === zone;
    const used = (ws.saved || []).filter((s) => here(s.section));
    if (used.length) return used.reduce((a, b) => (b.at >= a.at ? b : a)).section;
    const first = pageSections(ws).find((f) => secSpace(ws, f) === zone);
    return first ? first.id : NOTES() ? NOTES().newSection(ws, withZone({ holds: 'page', title: 'saved' }, zone)).id : null;
  }
  /* Pages redraw their star and their new-tab list after any change to what is saved. */
  function savedChanged() {
    WIN.forEach((r) => { if (r.page && r.page.savedChanged) r.page.savedChanged(); });
  }
  /* Saves a url into a section (sectionId; without one, the section used last in the space it is saved from). A url
     saved already only moves when a section is given. */
  function savePage(ws, url, title, sectionId, zone = '') {
    if (!normUrl(url)) return null;
    let s = findSaved(ws, url);
    const sec = sectionId && isPageSection(ws, sectionId) ? sectionId : s ? s.section : lastSection(ws, zone);
    if (!sec) { toast('could not save the page: notes.js, which keeps the sections, did not load', 6000); return null; }
    if (s) {
      s.section = sec;
      if (title) s.title = title;
      s.at = Date.now();
    } else {
      s = { id: newId('s'), url, title: title || prettyTitle(url), section: sec, at: Date.now() };
      savedOf(ws).push(s);
    }
    render();
    save();
    savedChanged();
    return s;
  }
  function moveSaved(ws, id, sectionId) {
    const s = (ws.saved || []).find((x) => x.id === id);
    if (!s || !isPageSection(ws, sectionId)) return false;
    s.section = sectionId;
    s.at = Date.now();
    render();
    save();
    savedChanged();
    return true;
  }
  /* quiet: the page's own star says what happened, and clicking it again puts it back. */
  function removeSaved(ws, id, quiet) {
    const list = savedOf(ws);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const s = list.splice(i, 1)[0];
    render();
    save();
    savedChanged();
    if (quiet) return;
    toast(`${pageName(s.url, s.title) || hostOf(s.url)} removed from saved`, 6000, { label: 'undo', run: () => {
      if (!isPageSection(ws, s.section)) s.section = lastSection(ws);
      list.splice(Math.min(i, list.length), 0, s);
      render();
      save();
      savedChanged();
    } });
  }
  /* What a page window gets for its star and its new-tab list, bound to the window's workspace when called. Sections
     reach page.js as their names. */
  function savedHooks(winId) {
    const wsOf = () => { const L = locate(winId); return L ? L.ws : A.WS[A.cur]; };
    const view = (ws, s) => (s ? { ...s, section: sectionTitle(ws, s.section), ws: ws.id, wsName: ws.name } : null);
    return {
      find: (url) => { const ws = wsOf(); return view(ws, findSaved(ws, url)); },
      save: (o) => { const L = locate(winId), ws = L ? L.ws : A.WS[A.cur]; const z = L && L.w && L.w.zone && zoneById(ws, L.w.zone) ? L.w.zone : ''; return view(ws, savePage(ws, o && o.url, o && o.title, null, z)); },
      remove: (id) => removeSaved(wsOf(), id, true),
      all: () => { const here = wsOf(); return A.WS.flatMap((ws) => (ws.saved || []).map((s) => ({ ...view(ws, s), here: ws === here }))); },
    };
  }
  /* The name of the section a url is saved in, or null. */
  function savedSection(ws, url) {
    const s = findSaved(ws, url);
    return s ? sectionTitle(ws, s.section) : null;
  }

  /* Every page open in a workspace, one per tab, with the sub-workspace it is in. */
  function openPages(ws) {
    return ws.windows.filter((w) => w.type === 'page').flatMap((w) => {
      const n = noteById(ws, w.noteId);
      const tabs = Array.isArray(w.tabs) && w.tabs.length ? w.tabs : n ? [{ url: n.url || '', title: n.title || '' }] : [];
      return tabs.map((t, i) => ({ w, n, i, url: t.url || '', title: t.title || (t.url ? prettyTitle(t.url) : 'new page'), zone: spaceOf(ws, w) }));
    });
  }
  /* A tab with nothing opened in it yet is not a page, so it has no row; a file shows on its row in files, marked open. */
  const blank = (p) => !p.url || p.url === 'about:blank';
  const fileTab = (p) => /^flow-file:/i.test(p.url);
  const openOf = (s, open) => { const u = normUrl(s.url); return open.find((p) => normUrl(p.url) === u) || null; };
  /* Shows one tab of a page window, or closes it (the window when it is the last tab). */
  function showTab(ws, w, i) {
    focusWin(ws, w);
    const r = WIN.get(w.id);
    if (r && r.page && r.page.selectTab) r.page.selectTab(i);
  }
  function closeTab(ws, w, i) {
    const r = WIN.get(w.id);
    if (r && r.page && r.page.closeTab && (w.tabs || []).length > 1 && r.page.closeTab(i)) return;
    closeWin(ws, w);
  }
  /* A page by its address: where it is open, else a page window of its own in free room (openPageWin with no window
     to stand beside, so nothing moves); never a tab in another page. */
  function openUrl(ws, url, dropAt) {
    const at = openPages(ws).find((p) => normUrl(p.url) === normUrl(url));
    if (at) {
      showTab(ws, at.w, at.i);
      /* the same file at another address (a link out of a report's folder was refused there) loads at the one asked for;
         a web page, or a file scrolled to a heading, is only shown */
      if (/^flow-file:/i.test(url) && at.url.split('#')[0] !== url.split('#')[0]) {
        const r = WIN.get(at.w.id);
        if (r && r.page && r.page.navigate) r.page.navigate(url);
      }
      return at.w;
    }
    const w = openPageWin(ws, url, null, null, null, dropAt);
    render();
    save();
    return w;
  }
  /* A saved page opens like any address; what was written about it is in its page record, wherever it opens. */
  function openSaved(ws, id) {
    const s = (ws.saved || []).find((x) => x.id === id);
    return s ? openUrl(ws, s.url) : null;
  }

  /* Once per workspace, when it has no saved list yet: pages leave the notes. A folder that held only pages becomes a
     page section; pages in a folder that also held notes go to a page section of the same name; a closed page with
     something written about it goes to "saved". Nothing is deleted: every page note stays, open ones stay open, and
     ⌘K finds the closed ones. True when it changed something. */
  function migrate(ws) {
    if (Array.isArray(ws.saved)) return false;
