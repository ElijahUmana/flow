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
    ws.saved = [];
    const open = new Set(ws.windows.map((w) => w.noteId).filter(Boolean));
    const kids = (id) => ws.notes.filter((n) => n.parent === id);
    const secs = new Map();
    ws.notes.filter((n) => n.kind === 'folder').forEach((f) => {
      const k = kids(f.id);
      if (k.length && k.every((n) => n.kind === 'page')) { f.holds = 'page'; secs.set(f.id, f); } else if (!f.holds) f.holds = 'note';
    });
    const section = (key, title) => {
      if (!secs.has(key)) { const s = { id: newId('f'), kind: 'folder', title, holds: 'page' }; ws.notes.push(s); secs.set(key, s); }
      return secs.get(key);
    };
    ws.notes.filter((n) => n.kind === 'page').forEach((n, i) => {
      const f = n.parent ? noteById(ws, n.parent) : null;
      const keep = f || (!open.has(n.id) && String(n.body || '').trim());
      if (keep && normUrl(n.url) && !findSaved(ws, n.url)) {
        const sec = f ? section(f.id, f.title) : section('', 'saved');
        ws.saved.push({ id: newId('s'), url: n.url, title: n.title || prettyTitle(n.url), section: sec.id, at: Date.now() + i });
      }
      delete n.parent;
    });
    return true;
  }

  /* ---------- hovering a page row shows its brief (notes.js): title, site, what it is about, the start of what was
     written about it (owner's Notion browser page) ---------- */
  let cardEl = null, cardTimer = 0, cardRow = null;
  function pageOf(ws, act) {
    const [k, id, ti] = act.split('|');
    if (k === 'saved') { const s = (ws.saved || []).find((x) => x.id === id); const at = s && openOf(s, openPages(ws)); return s ? { url: s.url, title: at ? at.title : (recordOf(normUrl(s.url)) || {}).title || s.title } : null; }
    if (k === 'tab') { const t = openPages(ws).find((p) => p.w.id === id && p.i === +ti); return t ? { url: t.url, title: t.title } : null; }
    if (k === 'rec') { const r = recordOf(id); return r ? { url: r.url, title: r.title } : null; }
    return null;
  }
  function showCard(row) {
    hideCard();
    const ws = A.WS[+row.dataset.ws];
    const pg = ws && row.isConnected && pageOf(ws, row.dataset.act);
    if (!pg || !pg.url) return;
    cardEl = document.createElement('div');
    cardEl.className = 'sbcard';
    if (NOTES() && NOTES().brief) cardEl.appendChild(NOTES().brief(pg.url, pg.title));
    else cardEl.innerHTML = `<div class="sbc-t">${esc(pg.title || hostOf(pg.url))}</div><div class="sbc-u">${esc(pg.url.replace(/^https?:\/\/(www\.)?/, ''))}</div>`;
    document.body.appendChild(cardEl);
    const r = row.getBoundingClientRect(), m = cardEl.getBoundingClientRect();
    cardEl.style.left = `${sb.getBoundingClientRect().right + 8}px`;
    cardEl.style.top = `${Math.max(6, Math.min(r.top - 6, innerHeight - m.height - 6))}px`;
  }
  function hideCard() {
    clearTimeout(cardTimer);
    if (cardEl) { cardEl.remove(); cardEl = null; }
  }

  /* ---------- the rows ---------- */
  function rowsFor(ws, all) {
    const i = A.WS.indexOf(ws);
    const rows = [];
    /* the space the rows being added are in: '' for the main workspace, else the sub-workspace's id */
    let sp = '', sd = 0;
    const add = (grp, depth, glyph, label, meta, act, o = {}) => rows.push({ grp, depth, glyph, label, meta: meta ? String(meta) : '', act, ws: i, sd,
      dim: !!o.dim, path: o.path || '', text: o.text || '', pop: o.pop || '', end: o.end || '', detach: o.detach || '', close: o.close || '', del: o.del || '',
      unsave: o.unsave || '', closews: !!o.closews, tog: o.tog || '', drag: o.drag || '', drop: o.drop || '', here: !!o.here, url: o.url || '', space: sp });
    const text = (w) => (all ? agentText(w) : '');
    const open = openPages(ws);
    const recs = new Map(NOTES() && NOTES().records ? NOTES().records().map((r) => [r.key, r]) : []);
    const ownTitle = (s, at) => (at ? at.title : (recs.get(normUrl(s.url)) || {}).title || s.title);
    const saved = ws.saved || [];
    const savedUrl = new Set(saved.map((s) => normUrl(s.url)));
    const unsaved = (p) => !savedUrl.has(normUrl(p.url));
    const under = (where, label) => (where ? `${where} › ${label}` : '');
    const loose = (w) => !teamOf(ws, w);
    /* Every agent, shell and team row has a ×. It ends what Flow started; a VM session Flow only attached to keeps
       running there, and its × closes Flow's window onto it. */
    const ender = (w, closed) => (w.attach && !closed ? { detach: w.id } : { end: w.id });
    const agent = (grp, depth, w, where) => {
      const title = termTitle(w);
      if (w.type === 'team') {
        const mates = membersOf(ws, w), panes = mates.length ? [] : panesOf(w), n = mates.length + panes.length;
        const key = `${ws.id}:t:${w.id}`, down = n && (all || unfolded(key));
        const closed = ws.closed.includes(w);
        add(grp, depth, n ? (down ? '▾' : '▸') : '◫', title, [remoteOf(w), n || ''].filter(Boolean).join(' · '), closed ? `reopen|${w.id}` : `win|${w.id}`,
          { dim: closed, ...ender(w, closed), text: text(w), path: under(where, title), tog: n ? key : '', drag: `${closed ? 'closed' : 'win'}|${w.id}` });
        if (!down) return;
        mates.forEach((m) => agent(grp, depth + 1, m, title));
        panes.forEach((p) => add(grp, depth + 1, '›_', A.paneName(p), '', `mate|${w.id}|${p.paneId}`, { path: `${title} › ${A.paneName(p)}`, text: `${p.title || ''} ${p.command || ''} ${p.cwd || ''}` }));
        return;
      }
      if (ws.closed.includes(w)) {
        add(grp, depth, '›_', title, '', `reopen|${w.id}`, { dim: true, text: `${w.note || ''} ${w.osc || ''}`, end: w.id, drag: `closed|${w.id}`, path: under(where, title) });
        return;
      }
      add(grp, depth, '›_', title, remoteOf(w), `win|${w.id}`, { ...ender(w, false), text: text(w), path: under(where, title), drag: `win|${w.id}` });
    };
    const note = (grp, depth, n, w, where, drop) => {
      const name = noteName(n);
      add(grp, depth, '✎', name, '', `note|${n.id}`, { dim: !w, del: w || !NOTES() ? '' : n.id, drag: `note|${n.id}`, drop, path: under(where, name) || name, text: n.body || '' });
    };
    const page = (grp, depth, p, where) => {
      const name = pageName(p.url, p.title);
      add(grp, depth, '↗', name, '', `tab|${p.w.id}|${p.i}`, { url: p.url, close: `${p.w.id}|${p.i}`, drag: normUrl(p.url) ? `page|${p.w.id}|${p.i}` : `win|${p.w.id}`, path: under(where, name) || name, text: `${p.url} ${p.title} ${p.n ? p.n.body || '' : ''}` });
    };
    const agentsIn = (zn) => [
      ...ws.windows.filter((w) => w.type === 'team' && spaceOf(ws, w) === zn),
      ...ws.closed.filter((w) => w.type === 'team' && spaceOf(ws, w) === zn),
      ...ws.windows.filter((w) => w.type === 'term' && loose(w) && spaceOf(ws, w) === zn),
      ...ws.closed.filter((w) => w.type !== 'team' && loose(w) && spaceOf(ws, w) === zn),
    ];

    const soloZone = SOLO_ZONE && ws.id === SOLO ? zoneById(ws, SOLO_ZONE) : null;
    if (soloZone) {
      agentsIn(soloZone).forEach((w) => agent('agents', 0, w, ''));
      ws.windows.filter((w) => w.type === 'note' && spaceOf(ws, w) === soloZone).forEach((w) => { const n = noteById(ws, w.noteId); if (n) note('notes', 0, n, w, ''); });
      open.filter((p) => p.zone === soloZone && !blank(p) && !fileTab(p)).forEach((p) => page('browser', 0, p, ''));
      if (!all) tellApart(rows);
      return rows;
    }
    const main = (w) => !spaceOf(ws, w);
    /* the main space's heading reads the workspace's name, as its pill does (owner, Nov 2 17:2x). Folding any space,
       including the one on screen, only hides its sidebar rows. */
    const onScreen = curSpace(ws);
    const mainKey = `${ws.id}:m:main`, mainDown = all || !explicitlyClosed(mainKey);
    add('space', 0, mainDown ? '▾' : '▸', ws.name, '', 'zone|', { tog: mainKey, drop: 'zone|', here: !onScreen, closews: !SOLO && A.WS.length > 1 && !!A.closeWorkspace });
    const mainEnd = rows.length;

    /* agents: teams, then agents, then closed ones, in the main space */
    agentsIn(null).forEach((w) => agent('agents', 0, w, ''));

    /* notes: notes and note sections; a note outside a section that is open in a sub-workspace is listed there. The notes
       outside a section take a note dropped from one: it leaves its section and keeps its place in the order. A section
       is listed in its own space (secSpace), with everything in it. */
    const pageSec = new Set(pageSections(ws).map((f) => f.id));
    const kids = (parent) => ws.notes.filter((n) => n.kind !== 'page' && !pageSec.has(n.id) && (n.parent || null) === parent);
    const winOf = (n) => ws.windows.find((x) => x.noteId === n.id);
    /* a closed note outside a section is listed where clicking it reopens it: the sub-workspace it was closed in
       (notes.js n.place.zone), while that one still exists */
    const closedIn = (n) => (n.place && n.place.zone && zoneById(ws, n.place.zone) ? n.place.zone : '');
    const folder = (n, depth, where) => {
      const key = `${ws.id}:f:${n.id}`, down = all || unfolded(key);
      add('notes', depth, down ? '▾' : '▸', n.title, kids(n.id).length, `folder|${n.id}`, { tog: key, drop: `note|${n.id}`, drag: `folder|${n.id}`, path: under(where, n.title) });
      if (down) walk(n.id, depth + 1, where);
    };
    const walk = (parent, depth, where) => kids(parent).forEach((n) => {
      if (n.kind === 'folder') { if (parent !== null || !secSpace(ws, n)) folder(n, depth, where); return; }
      const w = winOf(n);
      if (parent === null && (w ? !main(w) : !!closedIn(n))) return;
      note('notes', depth, n, w, where, parent === null ? 'note|' : '');
    });
    walk(null, 0, '');

    /* browser: open pages that are not saved, then the saved pages by section; a saved page that is open is the same row */
    const pageSecRows = (f, where) => {
      const key = `${ws.id}:f:${f.id}`, down = all || unfolded(key);
      const list = saved.filter((s) => s.section === f.id);
      add('browser', 0, down ? '▾' : '▸', f.title, list.length, `sec|${f.id}`, { tog: key, drop: `page|${f.id}`, drag: `sec|${f.id}`, path: under(where, f.title) });
      if (down) list.forEach((s) => {
        const at = openOf(s, open);
        const name = pageName(s.url, ownTitle(s, at)) || hostOf(s.url);
        add('browser', 1, '↗', name, '', `saved|${s.id}`, { url: s.url, dim: !at, close: at ? `${at.w.id}|${at.i}` : '', unsave: at ? '' : s.id, drag: `saved|${s.id}`, path: under(where, `${f.title} › ${name}`) || `${f.title} › ${name}`, text: `${s.url} ${s.title}` });
      });
    };
    open.filter((p) => !p.zone && !blank(p) && !fileTab(p) && unsaved(p)).forEach((p) => page('browser', 0, p, ''));
    pageSections(ws).filter((f) => !secSpace(ws, f)).forEach((f) => pageSecRows(f, ''));
    /* files: the workspace's folder (and its folder on the VM) and its downloads, from files.js */
    if (!all && mainDown && window.FlowFiles) window.FlowFiles.rows(ws, add, open);
    if (!mainDown) rows.splice(mainEnd);

    /* then each sub-workspace's heading, with its own agents, notes and pages; drop anything on a heading to move it there */
    /* in the workspace's order of spaces, depth first (app.js spaces(ws)): a sub-workspace inside another is indented
       under it, and shows only while every one above it is unfolded (the one on screen keeps its line open) */
    const order = (A.spaces ? A.spaces(ws).filter(Boolean).map((id) => zoneById(ws, id)) : ws.zones || []).filter(Boolean);
    const parentOf = (zn) => (zn.parent && zoneById(ws, zn.parent)) || null;
    const depthOf = (zn) => { let d = 0; for (let z = parentOf(zn); z && d < 12; z = parentOf(z)) d++; return d; };
    const onLine = new Set();
    for (let z = onScreen ? zoneById(ws, onScreen) : null; z && onLine.size < 12; z = parentOf(z)) onLine.add(z.id);
    const unfoldedZone = new Map();
    order.forEach((zn) => {
      const up = parentOf(zn);
      if (up && unfoldedZone.get(up.id) !== true) { unfoldedZone.set(zn.id, false); return; }
      sp = zn.id;
      sd = depthOf(zn);
      const key = `${ws.id}:z:${zn.id}`;
      const agents = agentsIn(zn);
      const notes = [
        ...ws.windows.filter((w) => w.type === 'note' && spaceOf(ws, w) === zn).map((w) => ({ w, n: noteById(ws, w.noteId) })).filter((x) => x.n && !x.n.parent),
        ...ws.notes.filter((n) => n.kind !== 'page' && n.kind !== 'folder' && !n.parent && !winOf(n) && closedIn(n) === zn.id).map((n) => ({ w: null, n })),
      ];
      const pages = open.filter((p) => p.zone === zn && !blank(p) && !fileTab(p) && unsaved(p));
      /* its own folder and the downloads its pages made, from files.js (only one that draws a space's own) */
      const files = !all && !!(window.FlowFiles && window.FlowFiles.has && window.FlowFiles.has(ws, zn.id));
      const noteSecs = kids(null).filter((n) => n.kind === 'folder' && secSpace(ws, n) === zn.id);
      const pageSecs = pageSections(ws).filter((f) => secSpace(ws, f) === zn.id);
      const inside = order.filter((z) => parentOf(z) === zn).length;
      const count = agents.length + notes.length + noteSecs.length + pages.length + pageSecs.length + (files ? 1 : 0) + inside;
      const here = onScreen === zn.id;
      const down = !!count && (all || (!explicitlyClosed(key) && (onLine.has(zn.id) || unfolded(key))));
      unfoldedZone.set(zn.id, down);
      add('space', 0, count ? (down ? '▾' : '▸') : here ? '●' : '', zn.name, here ? '' : count, `zone|${zn.id}`, { pop: zn.id, tog: count ? key : '', drop: `zone|${zn.id}`, here });
      if (!down) return;
      agents.forEach((w) => agent('agents', 0, w, zn.name));
      notes.forEach((x) => note('notes', 0, x.n, x.w, zn.name));
      noteSecs.forEach((f) => folder(f, 0, zn.name));
      pages.forEach((p) => page('browser', 0, p, zn.name));
      pageSecs.forEach((f) => pageSecRows(f, zn.name));
      if (files) window.FlowFiles.rows(ws, add, open, zn.id);
    });
    if (!all) tellApart(rows);
    return rows;
  }
  /* Page rows with the same name show their site; pages of one site show the shortest end of their address that tells
     them apart. The same page open in two places is not told apart from itself. */
  function tellApart(rows) {
    const by = new Map();
    rows.filter((r) => r.url).forEach((r) => by.set(r.label, [...(by.get(r.label) || []), r]));
    by.forEach((list) => {
      if (list.length < 2 || new Set(list.map((r) => normUrl(r.url))).size < 2) return;
      const sites = list.map((r) => hostOf(r.url));
      if (new Set(sites).size === sites.length) { list.forEach((r, i) => { r.meta = sites[i]; }); return; }
