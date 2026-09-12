(() => {
'use strict';

const flow = window.flow;
const HASH = new URLSearchParams(location.hash.slice(1));
const SOLO = HASH.get('solo');
const SOLO_ZONE = HASH.get('zone');
const HOME = (flow && flow.homeDir) || '';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rectHas = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
let uid = 0;
const newId = (p) => `${p}-${Date.now().toString(36)}${(uid++).toString(36)}`;
const uuid = () => crypto.randomUUID();
const tilde = (p) => (p && HOME && (p === HOME || p.startsWith(HOME + '/')) ? '~' + p.slice(HOME.length) : p || '');
const expand = (p) => (!p ? HOME : HOME && (p === '~' || p.startsWith('~/')) ? HOME + p.slice(1) : p);
const hostOf = (url) => (url ? String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./, '') : '');
/* A workspace file's page (files.js) is called by its file name until it says its title. */
const fileName = (url) => { const s = url.slice(url.lastIndexOf('/') + 1); try { return decodeURIComponent(s); } catch (e) { return s; } };
const prettyTitle = (url) => (/^flow-file:/i.test(url) ? fileName(url) : url.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/').slice(0, 2).join('/'));
const isTerm = (w) => w.type === 'term' || w.type === 'team';
const remoteOpts = (w) => (w.host ? { host: w.host, attach: w.attach || undefined } : undefined);

/* ---------- the first run: the five workspaces of the approved mockup, with real terminals and real pages ---------- */
function seed() {
  const local = (cwd) => ({ cmd: 'claude', cwd, sessionId: uuid(), where: 'this Mac' });
  return [
    {
      id: 'flow', name: 'flow', folder: '~/flow',
      bg: 'radial-gradient(1100px 650px at 18% 8%, #2b2444 0%, transparent 62%), radial-gradient(900px 600px at 92% 95%, #3b2236 0%, transparent 60%), #141319',
      zones: [
        { id: 'z-research', name: 'research', x: 102, y: 5.2, w: 72, h: 83.6 },
      ],
      notes: [
        { id: 'n-week', kind: 'note', title: 'this week', body: 'project spaces, one swipe between them, organize fast, find any session fast, keep track of my thoughts and of what every agent is doing.' },
        { id: 'p-mck', kind: 'page', title: 'The judgment bottleneck: Balancing AI and human speeds in strategy', titleSet: true, url: 'https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-judgment-bottleneck-balancing-ai-and-human-speeds-in-strategy', body: 'judgment is the bottleneck now. ai makes the analysis 10 to 20 times faster, but people can\'t judge it any faster, so reviews get slower. three moves: expand the capacity for judgment, build it through practice, protect accountability.' },
        { id: 'p-judge', kind: 'page', title: 'Careful Judge: Safe and Efficient Human-AI Collaborative Decision Making', titleSet: true, url: 'https://www.alphaxiv.org/abs/2610.09043', body: 'human judgment in the loop: who decides what, and when.' },
        { id: 'p-kv', kind: 'page', title: 'FlatCake: A Flat KVCache Storage Architecture for LLM Serving', titleSet: true, url: 'https://www.alphaxiv.org/abs/2610.38355', body: 'new serving infrastructure: how they lay out the kv cache.' },
        { id: 'n-read', kind: 'note', title: 'reading notes', body: 'human judgment, decision speed, serving infrastructure. what would change how we build.' },
        { id: 'n-design', kind: 'note', title: 'design', body: 'one workspace = everything for one goal. everything is a note, even a page.' },
        { id: 'f-read', kind: 'folder', title: 'reading list' },
        { id: 'p-9a', kind: 'page', parent: 'f-read', title: 'Designing Human-AI Collaborative Science: The 9A Framework', titleSet: true, url: 'https://www.alphaxiv.org/abs/2610.22948', body: '' },
        { id: 'p-audit', kind: 'page', parent: 'f-read', title: 'Who Does What in AI Auditing? Designing Human-AI Collaboration for Auditing Generative AI', titleSet: true, url: 'https://www.alphaxiv.org/abs/2609.24986', body: '' },
        { id: 'p-kvtier', kind: 'page', parent: 'f-read', title: 'When the KV Cache Is Slower Than the GPU: Scaling Remote KV Tiers for Context-Parallel Prefill', titleSet: true, url: 'https://www.alphaxiv.org/abs/2610.21500', body: '' },
        { id: 'p-dualpace', kind: 'page', parent: 'f-read', title: 'DualPace: Decoupled Scheduling and Cooperative GPU--CPU Decoding for LLM Serving', titleSet: true, url: 'https://www.alphaxiv.org/abs/2610.33501', body: '' },
      ],
      windows: [
        { id: 'w-team', type: 'team', title: 'team flow', where: 'on the VM', host: 'claude-agents', attach: 'ccm', x: 1.2, y: 6.6, w: 47, h: 47 },
        { id: 'w-design', type: 'term', title: 'design: workspaces', ...local('~/flow'), x: 49.4, y: 58.4, w: 49.4, h: 30, noted: true, front: true,
          note: 'keep my sidebar, rethought. mac-style windows, the plain look. no status bars.' },
        { id: 'w-week', type: 'note', noteId: 'n-week', x: 1.2, y: 55.4, w: 47, h: 33 },
        { id: 'w-mck', type: 'page', noteId: 'p-mck', x: 49.4, y: 6.6, w: 49.4, h: 50 },
        { id: 'w-kv', type: 'page', noteId: 'p-kv', x: 103.4, y: 10, w: 40, h: 77.4 },
        { id: 'w-judge', type: 'page', noteId: 'p-judge', x: 144.6, y: 10, w: 28.4, h: 45 },
        { id: 'w-read', type: 'note', noteId: 'n-read', x: 144.6, y: 56.8, w: 28.4, h: 30.6 },
      ],
      closed: [],
    },
    {
      id: 'mynotes', name: 'mynotes', folder: '~/elevennotes',
      bg: 'radial-gradient(1100px 650px at 15% 10%, #16323a 0%, transparent 62%), radial-gradient(900px 600px at 90% 92%, #1d3a2f 0%, transparent 60%), #10171a',
      zones: [],
      notes: [
        { id: 'n-mn', kind: 'note', title: 'mynotes', body: "use both when it's noisy: switch in the menu, lowercase. rollback for combining is in ~/MyNotes-backups." },
        { id: 'p-mnp', kind: 'page', title: 'MyNotes Noise Pipeline', titleSet: true, url: '', body: '' },
      ],
      windows: [
        { id: 'mn-team', type: 'team', title: 'team mynotes-audio', where: 'on the VM', host: 'claude-agents', attach: 'mynotes-audio', x: 1.2, y: 6.6, w: 58, h: 50,
          note: "keep the final test independent. don't tune anything on its recordings." },
        { id: 'mn-build', type: 'term', title: 'combining build', ...local('~/elevennotes'), x: 60.5, y: 6.6, w: 38.3, h: 50, front: true,
          note: 'build A7AF54A0 is the verified one. rollback: ~/MyNotes-backups.' },
        { id: 'mn-note', type: 'note', noteId: 'n-mn', x: 1.2, y: 58.4, w: 40, h: 30 },
        { id: 'mn-page', type: 'page', noteId: 'p-mnp', x: 42.5, y: 58.4, w: 56.3, h: 30 },
      ],
      closed: [],
    },
    {
      id: 'infra', name: 'inference infra', folder: '~/infra-reading',
      bg: 'radial-gradient(1100px 650px at 15% 10%, #3a2a17 0%, transparent 62%), radial-gradient(900px 600px at 90% 92%, #33241a 0%, transparent 60%), #17130f',
      zones: [],
      notes: [{ id: 'n-infra', kind: 'note', title: 'inference infra', body: 'what to read and reproduce this week: kv cache layout, scheduling, remote kv tiers. the twelve readers are parked off to the right.' }],
      windows: [
        { id: 'i-bench', type: 'term', title: 'kv cache bench', ...local('~/infra-reading'), x: 1.2, y: 6.6, w: 48.4, h: 52, front: true },
        { id: 'i-sched', type: 'term', title: 'serving notes', ...local('~/infra-reading'), x: 50.4, y: 6.6, w: 48.4, h: 52 },
        { id: 'i-note', type: 'note', noteId: 'n-infra', x: 1.2, y: 60.4, w: 97.6, h: 28 },
        { id: 'i-team', type: 'team', title: 'team reading', ...local('~/infra-reading'), x: 101.5, y: 6.6, w: 60, h: 81.8,
          note: 'twelve readers, one topic each. swipe over when i want to look.' },
      ],
      closed: [],
    },
    {
      id: 'voiceless', name: 'voiceless', folder: '~/voiceless',
      bg: 'radial-gradient(1100px 650px at 15% 10%, #33203b 0%, transparent 62%), radial-gradient(900px 600px at 90% 92%, #2a1c33 0%, transparent 60%), #151018',
      zones: [],
      notes: [
        { id: 'p-vsd', kind: 'page', title: 'Voiceless: Full System Design', titleSet: true, url: 'https://www.notion.so/f675abdb2a9b4ddd98eb09e2d576f669', body: '' },
        { id: 'n-vl', kind: 'note', title: 'voiceless', body: 'talk to agents faster than typing.' },
      ],
      windows: [
        { id: 'v-page', type: 'page', noteId: 'p-vsd', x: 1.2, y: 6.6, w: 60, h: 81.8 },
        { id: 'v-note', type: 'note', noteId: 'n-vl', x: 62.4, y: 6.6, w: 36.4, h: 40 },
        { id: 'v-term', type: 'term', title: 'voiceless prototype', ...local('~/voiceless'), x: 62.4, y: 48.4, w: 36.4, h: 40, front: true },
      ],
      closed: [],
    },
    {
      id: 'ef', name: 'ef start', folder: '~/ef-start',
      bg: 'radial-gradient(1100px 650px at 15% 10%, #1c2a45 0%, transparent 62%), radial-gradient(900px 600px at 90% 92%, #1b2f4a 0%, transparent 60%), #0f131b',
      zones: [],
      notes: [
        { id: 'n-efw', kind: 'note', title: 'this week', body: '1. project spaces: every terminal, page and note for a project in one space\n2. one swipe to the next space\n3. organize everything into spaces fast\n4. find any session fast\n5. keep track of my thoughts and of what each agent is doing\n\nstay terminal-first. keep it simple.' },
        { id: 'p-ef', kind: 'page', title: 'EF Start · my work', titleSet: true, url: 'https://app.efstart.com/work', body: 'progress videos and evidence for each day go here.' },
      ],
      windows: [
        { id: 'e-note', type: 'note', noteId: 'n-efw', x: 1.2, y: 6.6, w: 44, h: 81.8 },
        { id: 'e-page', type: 'page', noteId: 'p-ef', x: 46.6, y: 6.6, w: 52.2, h: 47 },
        { id: 'e-term', type: 'term', title: 'workspaces prototype', ...local('~/ef-start'), x: 46.6, y: 55.4, w: 52.2, h: 33, front: true },
      ],
      closed: [],
    },
  ];
}

let WS = [];
let ui = { at: 'flow', sbHidden: false, closed: [], hinted: false };
let stateBase = null;
let cur = 0;
let soloSbHidden = false, soloBase = null;
const sbHidden = () => (SOLO ? soloSbHidden : !!ui.sbHidden);
const setSbHidden = (v) => { if (SOLO) soloSbHidden = v; else ui.sbHidden = v; };

/* Runtime handles live here, keyed by id, never in the saved state. */
const WIN = new Map(); // window id -> { el, tb, host, term, page, cur, osc, vis }
const SEC = new Map(); // workspace id -> { sec, canvas, rubber }
const busy = new Set(); // ids of windows being dragged or resized right now

/* A pop-out's view is its own: it is kept as popView on the space it shows (its sub-workspace, or the workspace for its
   main space), and the workspace keeps the main window's view (soloBase). Once the pop-out has closed, the main window
   takes popView back as that space's view (nav.js takeBack). */
function snapshot() {
  const s = JSON.parse(JSON.stringify({ v: 11, ws: WS, ui: { ...ui, at: SOLO ? ui.at : (WS[cur] ? WS[cur].id : ui.at) }, pages: window.FlowNotes.pagesDoc() }));
  if (SOLO) {
    const sw = s.ws.find((x) => x.id === SOLO), live = WS[idx(SOLO)], sid = live && curSpace(live);
    const zn = sw && sid && (sw.zones || []).find((z) => z.id === sid), at = SOLO_ZONE ? zn : zn || sw;
    if (at && live) at.popView = FlowNav.viewOf(live);
    if (sw && soloBase) Object.assign(sw, soloBase);
  }
  return s;
}
let saveTimer = 0;
/* A page is live where its tabs have loaded. A pop-out also mounts the rest of its workspace, hidden and never loaded, so
   a mounted page alone is not one this window shows. The store takes a live page's tabs from its window only. */
const livePage = (r) => !!(r && r.page && r.page.guests().length);
const shownPages = () => [...WIN.entries()].filter(([, r]) => livePage(r)).map(([id]) => id);
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    const doc = snapshot();
    flow.saveState(doc, { pages: shownPages(), base: stateBase });
    stateBase = doc;
  }, 120);
}
async function flushNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const doc = snapshot();
  const merged = await flow.flushState(doc, { pages: shownPages(), base: stateBase });
  stateBase = merged || doc;
  return merged;
}
async function syncState() {
  const merged = await flushNow();
  if (merged && merged.v === 11 && Array.isArray(merged.ws)) applyRemote(merged, true);
  return merged;
}
/* Where each local shell is now, as tmux has it, so a shell started again after a reboot opens there. True when one
   moved. A claude window's folder never changes, and a VM shell lives on the VM. */
async function keepShellFolders(only) {
  const spaces = only ? [only] : WS;
  const shells = spaces.flatMap((ws) => [...ws.windows, ...ws.closed].filter((w) => isTerm(w) && w.cmd === 'shell' && !w.host).map((w) => ({ ws, w })));
  if (!shells.length) return false;
  const now = new Map((await flow.term.list(shells.map(({ ws, w }) => ({ id: w.id, cwd: expand(w.cwd || ws.folder) })))).map((t) => [t.id, t]));
  let moved = false;
  for (const { w } of shells) {
    const current = now.get(w.id);
    if (current && current.cwd && !current.sameCwd) { w.cwd = tilde(current.cwd); moved = true; }
  }
  return moved;
}
/* Before this window goes away (a quit, or this window closing; main asks and waits up to its own cap) and before a
   space leaves it for a pop-out: every live page reads its tabs' scroll and history now, and the local shells their
   folders, for at most 1.5 s, then the state is written. */
async function flushPages(only) {
  const ids = only ? new Set(only.windows.map((w) => w.id)) : null;
  const read = Promise.all([...WIN.entries()].filter(([id, r]) => (!ids || ids.has(id)) && livePage(r)).map(([, r]) => r.page.flushHistory()
    .catch((err) => console.error('a page could not read its scroll before saving', err)))
    .concat(keepShellFolders(only).catch((err) => console.error('could not read where the shells are before saving', err))));
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1500); });
  if (!(await Promise.race([read.then(() => true), late]))) console.warn('the pages did not read their scroll within 1.5 s; saving the copy they last sent');
  clearTimeout(timer);
  await flushNow();
}

const $ = (id) => document.getElementById(id);
const viewport = $('viewport'), track = $('track'), spacesEl = $('spaces');
const edgeL = $('edgeL'), edgeR = $('edgeR');
const sb = $('sb'), sblist = $('sblist'), q = $('q'), toastEl = $('toast');
let VW = 1, VH = 1, z = 10, dragging = false, toastTimer = 0, sideTimer = 0, fitTimer = 0;
let workspaceQuestion = null, closingWorkspace = false, workspaceCritical = false, pendingRemoteState = null;
/* Workspace close deliberately has one silent Cmd-Z slot. It is persisted across a restart, and a later successful
   close replaces it; the exact post-close workspace/current signature prevents it from applying to another state. */
const workspaceUndos = () => {
  const stack = Array.isArray(ui.workspaceUndos) ? ui.workspaceUndos : (ui.workspaceUndos = []);
  if (stack.length > 1) stack.splice(0, stack.length - 1);
  return stack;
};
/* While anything is being dragged, live pages must not swallow the pointer. */
function setDragging(v) {
  dragging = v;
  document.body.classList.toggle('busy', v);
}
let nav = null;
let groups = null;
let arrangeCtl = null;
let besideKeys = null;
const stopEdgePan = (ws) => { if (nav && ws) nav.edgePan(ws, null); };
const feedEdgePan = (ws, x, y, moved) => {
  if (!nav || !ws) return;
  const r = viewport.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) { stopEdgePan(ws); return; }
  nav.edgePan(ws, x, moved || (() => {}), null, y);
};

const idx = (id) => WS.findIndex((w) => w.id === id);
const findWin = (ws, id) => ws.windows.find((w) => w.id === id);
const noteById = (ws, id) => ws.notes.find((n) => n.id === id);
const zoneById = (ws, id) => (ws.zones || []).find((zn) => zn.id === id);
/* Sub-workspaces are separate spaces: a window lives in the space named by w.zone (none: the main space), and only the
   space on screen (ws.at, or the zone of a sub-workspace pop-out) shows. ws.pan is the pan of the space on screen;
   a space you leave keeps its own (zn.pan, ws.mainPan). */
const curSpace = (ws) => (SOLO_ZONE && ws.id === SOLO ? SOLO_ZONE : ws.at && zoneById(ws, ws.at) ? ws.at : null);
const inSpace = (ws, w, sid = curSpace(ws)) => (w.zone || null) === sid;
const shown = () => (SOLO ? WS.filter((w) => w.id === SOLO) : WS);
const rtOf = (w) => WIN.get(w.id);
const elOf = (w) => { const r = WIN.get(w.id); return r ? r.el : null; };
const geo = (w) => { const r = WIN.get(w.id); return (r && r.cur) || w; };
const canvasOf = (ws) => { const s = SEC.get(ws.id); return s ? s.canvas : null; };
function locate(id) {
  for (const ws of WS) { const w = findWin(ws, id); if (w) return { ws, w }; }
  return null;
}
const lights = () => '<div class="lights"><i data-l="close"></i><i data-l="park" title="park it off to the right"></i><i data-l="max" title="fill the screen"></i></div>';

/* action: { label, run }, a button after the text (undo). */
// Only a toast's action takes clicks (app.css .tact): the rest lets them through to the title bars under it.
function toast(msg, ms, action) {
  toastEl.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'tact';
    b.textContent = action.label;
    b.addEventListener('click', () => { clearTimeout(toastTimer); toastEl.classList.remove('on'); action.run(); });
    toastEl.appendChild(b);
  }
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms || 2400);
}
/* A workspace out of the window and the list. Its model stays whole for the one silent workspace-close undo; disposing
   its bodies closes pages, notes and file views and detaches terminal clients. Sessions are ended separately by
   closeWorkspace, before this runs. */
function detachWorkspace(ws, persist = true) {
  const i = WS.indexOf(ws), keep = WS[cur] === ws ? WS[i + 1] || WS[i - 1] : WS[cur];
  // The notes keep exactly what they had: FlowNotes.detach records where a closing note window was, and here no window
  // closes, the whole workspace leaves with its windows in place.
  const places = new Map(ws.notes.map((n) => [n, 'place' in n ? cloneModel(n.place) : undefined]));
  ws.windows.forEach((w) => {
    const r = WIN.get(w.id);
    window.FlowNotes.detach(w.id);
    if (r) { disposeBody(r); WIN.delete(w.id); }
  });
  places.forEach((place, n) => { if (place === undefined) delete n.place; else n.place = place; });
  const s = SEC.get(ws.id);
  if (s) { s.sec.remove(); SEC.delete(ws.id); }
  WS.splice(i, 1);
  cur = WS.indexOf(keep);
  jumpTo(cur);
  renderNav();
  renderModes();
  edges();
  renderSidebar();
  syncVisible();
  if (persist) save();
}
/* Back at index i, built again, and shown. The same model object keeps every place, view, tab, note, file and session
   identity. A terminal killed by closeWorkspace waits for that kill to settle in ensureBody, then resumes its retained
   conversation; one left running on the VM attaches to the same id/host/attach. */
function attachWorkspace(ws, i, show = true) {
  const keep = WS[cur];
  WS.splice(Math.min(i, WS.length), 0, ws);
  track.insertBefore(buildWS(ws), track.children[WS.indexOf(ws)] || null);
  ws.windows.forEach((w) => ensureBody(ws, w));
  layout(ws);
  cur = WS.indexOf(keep);
  jumpTo(cur);
  if (show) go(WS.indexOf(ws));
  else {
    renderNav();
    renderModes();
    edges();
    renderSidebar();
    syncVisible();
    save();
  }
}

const workspaceTerminals = (ws) => [...ws.windows, ...ws.closed].filter(isTerm);
const workspaceVM = (ws) => workspaceTerminals(ws).filter((w) => !!w.host);
const cloneModel = (value) => JSON.parse(JSON.stringify(value));
const workspacePaneIdentity = (p) => ({ paneId: p.paneId, panePid: p.panePid, sessionTmuxId: p.sessionTmuxId,
  windowId: p.windowId, windowIndex: p.windowIndex, windowLayout: p.windowLayout || '', windowName: p.windowName || '', windowWidth: Number(p.windowWidth),
  windowHeight: Number(p.windowHeight), index: p.index, left: Number(p.left), top: Number(p.top), width: Number(p.width),
  height: Number(p.height), cwd: p.cwd, sessionId: p.sessionId,
  mate: p.mate ? { agentId: p.mate.agentId || '', name: p.mate.name || '', team: p.mate.team || '' } : null });
const workspaceChoice = (w) => {
  const seam = Object.prototype.hasOwnProperty.call(w, 'canShutdown');
  const canKill = (seam ? !!w.canShutdown : w.type !== 'team') && !(w.attach && !w.sessionId && w.type !== 'team' && !(Array.isArray(w.panes) && w.panes.length));
  return {
    id: w.id, type: w.type, title: w.title || termTitle(w), host: w.host, attach: w.attach || '', cmd: w.cmd || '', cwd: w.cwd || '',
    sessionId: w.sessionId || '', mate: w.mate ? cloneModel(w.mate) : null,
    panes: Array.isArray(w.panes) ? w.panes.map(workspacePaneIdentity) : [], canKill,
    reason: canKill ? '' : w.reason || (w.type === 'team' ? 'leave running: its agents need their own conversations to restore' : 'leave running: no resumable conversation yet'),
  };
};
const workspaceComparable = (ws) => {
  const copy = cloneModel(ws);
  for (const key of ['at', 'pan', 'panY', 'zoom', 'mainPan', 'mainPanY', 'mainZoom', 'popView']) delete copy[key];
  for (const zone of copy.zones || []) for (const key of ['pan', 'panY', 'zoom', 'popView']) delete zone[key];
  for (const w of [...(copy.windows || []), ...(copy.closed || [])]) delete w.osc;
  return copy;
};
const pendingChangesWorkspace = (ws) => {
  if (!pendingRemoteState || !Array.isArray(pendingRemoteState.ws)) return false;
  const incoming = pendingRemoteState.ws.find((item) => item && item.id === ws.id);
  return !incoming || JSON.stringify(workspaceComparable(incoming)) !== JSON.stringify(workspaceComparable(ws));
};
const workspaceCloseFrame = (ws) => JSON.stringify({ list: WS.map((x) => x.id), current: WS[cur] && WS[cur].id, at: WS.indexOf(ws), count: WS.length });
const workspaceCloseState = (ws) => JSON.stringify({ frame: JSON.parse(workspaceCloseFrame(ws)), workspace: workspaceComparable(ws) });
const workspaceCloseRuntime = (seam, fallback) => JSON.stringify({
  choices: (seam && Array.isArray(seam.choices) ? seam.choices : fallback).map(workspaceChoice).map(({ title, reason, ...choice }) => choice),
  restore: ((seam && seam.restore) || []).map((r) => ({ teamId: r.teamId, leadSessionId: r.leadSessionId,
    signature: (r.signature || []).map(workspacePaneIdentity), members: (r.members || []).map((m) => ({
      id: m.id, paneId: m.paneId, zone: m.zone || null, cwd: m.cwd, sessionId: m.sessionId,
      mate: m.mate ? { name: m.mate.name || '', team: m.mate.team || '', lead: m.mate.lead || '', paneId: m.mate.paneId || '' } : null,
    })) })),
  blocked: cloneModel((seam && seam.blocked) || []),
});
function clearWorkspaceQuestion(answer) {
  const qn = workspaceQuestion;
  if (!qn) return;
  workspaceQuestion = null;
  qn.el.remove();
  qn.done(answer);
}
function explainWorkspaceBlock(ws, blocked) {
  if (workspaceQuestion) clearWorkspaceQuestion(null);
  return new Promise((done) => {
    const box = document.createElement('form');
    box.className = 'wsclose';
    box.innerHTML = `<div class="wc-title">cannot close ${esc(ws.name)}</div><div class="wc-detail">these agents cannot be restored yet</div>` +
      blocked.map((item) => `<div class="wc-row disabled"><span></span><span>${esc(item.title || item.id)}</span><small>${esc(item.reason || 'conversation unavailable')}</small></div>`).join('') +
      '<div class="wc-actions"><button type="submit">ok</button></div>';
    box.addEventListener('submit', (e) => { e.preventDefault(); clearWorkspaceQuestion(false); });
    document.body.appendChild(box);
    workspaceQuestion = { el: box, done };
    box.querySelector('button').focus({ preventScroll: true });
  });
}
/* One in-Flow question, before any mutation. Every VM item explicitly reads "leave running" or "shut down"; leaving
   running is the safe default. null is cancel, and means zero mutation. */
function askWorkspaceVM(ws, items) {
  if (!items.length) return Promise.resolve(new Set());
  if (workspaceQuestion) clearWorkspaceQuestion(null);
  const choices = items.map(workspaceChoice);
  return new Promise((done) => {
    const box = document.createElement('form');
    box.className = 'wsclose';
    box.innerHTML = `<div class="wc-title">close ${esc(ws.name)}?</div><div class="wc-detail">what should happen on the VM?</div>` +
      choices.map((w) => `<label class="wc-row${w.canKill ? '' : ' disabled'}"><input type="checkbox" data-kill="${esc(w.id)}"${w.canKill ? '' : ' disabled'}><span>${esc(w.title)}</span><small>${esc(w.reason || 'leave running')}</small></label>`).join('') +
      '<div class="wc-actions"><button type="button" data-cancel>cancel</button><button type="submit">close workspace</button></div>';
    box.addEventListener('change', (e) => {
      const input = e.target.closest('[data-kill]');
      if (input) input.closest('label').querySelector('small').textContent = input.checked ? 'shut down' : 'leave running';
    });
    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-cancel]')) { e.preventDefault(); clearWorkspaceQuestion(null); }
    });
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const allowed = new Set(choices.filter((x) => x.canKill).map((x) => x.id));
      clearWorkspaceQuestion(new Set([...box.querySelectorAll('[data-kill]:checked')].map((x) => x.dataset.kill).filter((id) => allowed.has(id))));
    });
    document.body.appendChild(box);
    workspaceQuestion = { el: box, done };
    box.querySelector('[data-cancel]').focus({ preventScroll: true });
  });
}
async function reopenWorkspacePopouts(ws, list) {
  if (!list.length) return;
  await flushNow();
  for (const p of list) flow.openWindow('solo=' + encodeURIComponent(ws.id) + (p.zone ? '&zone=' + encodeURIComponent(p.zone) : ''), p.frame);
  if (!flow.popouts) return;
  const want = new Set(list.map((p) => p.zone == null ? '' : String(p.zone)));
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const open = new Set((await flow.popouts()).filter((p) => p.ws === ws.id).map((p) => p.zone == null ? '' : String(p.zone)));
    if ([...want].every((zone) => open.has(zone))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the pop-out windows of ${ws.name} did not reopen`);
}
async function closeWorkspacePopouts(ws) {
  if (!flow.popouts || !flow.closePopout) return [];
  const open = (flow.popoutFrames ? await flow.popoutFrames() : await flow.popouts()).filter((p) => p.ws === ws.id);
  const results = await Promise.allSettled(open.map((p) => flow.closePopout({ ws: ws.id, zone: p.zone == null ? null : p.zone })));
  const kept = results.map((result, i) => ({ zone: open[i].zone == null ? null : open[i].zone,
    frame: result.status === 'fulfilled' && result.value ? result.value : open[i].frame })).filter((p) => p.frame);
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    await reopenWorkspacePopouts(ws, open.map((p) => ({ zone: p.zone == null ? null : p.zone, frame: p.frame })).filter((p) => p.frame));
    throw new Error(failed.map((result) => String((result.reason && result.reason.message) || result.reason)).join('; '));
  }
  return kept;
}
function killForWorkspace(w, sessionIds, expectedPanes, requireExists) {
  const opts = { ...remoteOpts(w), shutdownAttach: !!(w.host && w.attach), waitSessionIds: sessionIds,
    expectedPanes: expectedPanes || [], requireExists: !!requireExists };
  const k = flow.term.kill(w.id, opts);
  ending.set(w.id, k);
  k.finally(() => {
    if (ending.get(w.id) === k) ending.delete(w.id);
  }).catch(() => {});
  return k;
}
async function restoreWorkspaceTerminal(ws, operation) {
  const { w, expectedPanes } = operation;
  let alive = false;
  try {
    alive = await flow.term.exists(w.id, remoteOpts(w));
  } catch (err) {
    if (w.host) throw err;
  }
  if (alive || !operation.shouldRestore) return;
  if (expectedPanes.length) {
    await flow.term.restoreAttach(w.id, { ...remoteOpts(w), expectedPanes });
  } else {
    const opened = await flow.term.open(termRequest(ws, w));
    if (!opened || !opened.ok) throw new Error((opened && opened.error) || `could not restore ${termTitle(w)}`);
    flow.term.detach(w.id);
  }
  const r = WIN.get(w.id);
  if (r) {
    disposeBody(r);
    ensureBody(ws, w);
    syncVisible();
  }
}
async function preflightWorkspaceTerminals(ws, answer, restores) {
  const byTeam = new Map(restores.map((r) => [r.teamId, r]));
  const list = workspaceTerminals(ws).filter((w) => !w.host || answer.has(w.id));
  return Promise.all(list.map(async (w) => {
    const wasAlive = await flow.term.exists(w.id, remoteOpts(w));
    if (w.host && !wasAlive) throw new Error(`${termTitle(w)} is no longer running`);
    const r = byTeam.get(w.id), expectedPanes = r ? r.signature : [];
    const ids = r ? [r.leadSessionId, ...(r.members || []).map((m) => m.sessionId)] : w.sessionId ? [w.sessionId] : [];
    return { w, ids, expectedPanes, wasAlive, shouldRestore: wasAlive };
  }));
}
async function restoreWorkspaceTerminals(ws, operations) {
  const recovered = await Promise.allSettled(operations.filter((x) => x.shouldRestore).map((x) => restoreWorkspaceTerminal(ws, x)));
  return recovered.filter((x) => x.status === 'rejected').map((x) => String((x.reason && x.reason.message) || x.reason));
}
async function endWorkspaceTerminals(ws, operations, expectedState) {
  if (workspaceCloseState(ws) !== expectedState) throw new Error('the workspace changed before its terminals could close');
  const attempted = [];
  try {
    for (const operation of operations) {
      if (pendingChangesWorkspace(ws) || workspaceCloseState(ws) !== expectedState) throw new Error('the workspace changed during terminal shutdown');
      if (!operation.wasAlive && operation.w.host) continue;
      attempted.push(operation);
      await killForWorkspace(operation.w, operation.ids, operation.expectedPanes, operation.wasAlive);
    }
    if (pendingChangesWorkspace(ws) || workspaceCloseState(ws) !== expectedState) throw new Error('the workspace changed during terminal shutdown');
  } catch (error) {
    const recovery = await restoreWorkspaceTerminals(ws, attempted);
    throw new Error(`${(error && error.message) || error}${recovery.length ? `; recovery failed: ${recovery.join('; ')}` : ''}`);
  }
  return { killed: new Set(attempted.filter((x) => x.wasAlive).map((x) => x.w.id)), operations: attempted };
}
function teamRestoreInto(model, list) {
  const snapshots = [];
  for (const r of list) {
    const team = [...model.windows, ...model.closed].find((w) => w.id === r.teamId);
    if (!team) continue;
    delete team.attach;
    team.sessionId = r.leadSessionId;
    const lead = (r.signature || []).find((p) => p.sessionId === r.leadSessionId);
    if (!team.host && lead && lead.cwd) team.cwd = tilde(lead.cwd);
    snapshots.push({ teamId: r.teamId, panes: cloneModel(r.signature || []) });
  }
  return snapshots;
}
async function closeWorkspace(ws) {
  if (SOLO || closingWorkspace || !WS.includes(ws) || WS.length < 2) return false;
  closingWorkspace = true;
  let popouts = [], teamLocked = false, closed = false, detached = false, shutdown = null;
  let restoreIndex = -1, restoreKeepId = '';
  const teams = window.FlowTeams, oldUndos = workspaceUndos().slice();
  try {
    const entryFrame = workspaceCloseFrame(ws);
    if (workspaceTerminals(ws).some((w) => w.type === 'team') && !(teams && typeof teams.closeSnapshot === 'function')) throw new Error('team inventory is unavailable');
    const inventory = teams && typeof teams.closeSnapshot === 'function' ? await teams.closeSnapshot(ws) : null;
    if (workspaceCloseFrame(ws) !== entryFrame) return false;
    if (inventory && inventory.blocked && inventory.blocked.length) {
      await explainWorkspaceBlock(ws, inventory.blocked);
      return false;
    }
    const choices = inventory && Array.isArray(inventory.choices) ? inventory.choices : workspaceVM(ws);
    await syncState();
    if (workspaceCloseFrame(ws) !== entryFrame) return false;
    const preparedRevision = await flow.workspaceRevision(ws.id);
    const preparedState = workspaceCloseState(ws), preparedRuntime = workspaceCloseRuntime(inventory, choices);
    const answer = await askWorkspaceVM(ws, choices);
    if (answer == null || workspaceCloseState(ws) !== preparedState) return false;
    document.body.classList.add('workspace-committing');
    await syncState();
    if (!WS.includes(ws) || workspaceCloseState(ws) !== preparedState || await flow.workspaceRevision(ws.id) !== preparedRevision) return false;

    let frame = workspaceCloseFrame(ws);
    await flushPages(ws);
    if (workspaceCloseFrame(ws) !== frame) return false;
    frame = workspaceCloseFrame(ws);
    popouts = await closeWorkspacePopouts(ws);
    if (workspaceCloseFrame(ws) !== frame) throw new Error('the workspace list changed while its pop-outs closed');

    const beforeLockState = workspaceCloseState(ws);
    if (teams && typeof teams.beginClose === 'function') {
      teamLocked = await teams.beginClose(ws);
      if (!teamLocked) throw new Error('the workspace is already closing');
    }
    if (workspaceCloseState(ws) !== beforeLockState) throw new Error('the workspace changed while its team lock settled');
    workspaceCritical = true;
    pendingRemoteState = null;
    await syncState();
    if (!WS.includes(ws) || workspaceCloseState(ws) !== beforeLockState) throw new Error('the workspace changed before its final shutdown');
    const freshRevision = await flow.workspaceRevision(ws.id);
    const freshState = workspaceCloseState(ws);
    const fresh = teams && typeof teams.closeSnapshot === 'function' ? await teams.closeSnapshot(ws) : null;
    const freshChoices = fresh && Array.isArray(fresh.choices) ? fresh.choices : workspaceVM(ws);
    if (pendingChangesWorkspace(ws) || workspaceCloseState(ws) !== freshState || workspaceCloseRuntime(fresh, freshChoices) !== preparedRuntime) throw new Error('the workspace changed before its final shutdown');
    if (fresh && fresh.blocked && fresh.blocked.length) throw new Error('the final team inventory is incomplete');
    const selectedTeams = ((fresh && fresh.restore) || []).filter((r) => {
      const w = workspaceTerminals(ws).find((x) => x.id === r.teamId);
      return w && (!w.host || answer.has(r.teamId));
    });
    const operations = (await preflightWorkspaceTerminals(ws, answer, selectedTeams))
      .sort((a, b) => Number(!!b.w.host) - Number(!!a.w.host) || Number(!!b.w.attach) - Number(!!a.w.attach));
    if (pendingChangesWorkspace(ws) || workspaceCloseState(ws) !== freshState) throw new Error('the workspace changed during terminal preflight');
    const i = WS.indexOf(ws), keepId = WS[cur] && WS[cur].id, model = cloneModel(ws);
    restoreIndex = i;
    restoreKeepId = keepId;
    shutdown = await endWorkspaceTerminals(ws, operations, freshState);
    if (pendingChangesWorkspace(ws) || workspaceCloseState(ws) !== freshState) throw new Error('the workspace changed before commit');
    for (const w of [...model.windows, ...model.closed]) if (shutdown.killed.has(w.id) && w.host && w.attach) delete w.attach;
    const teamSnapshots = teamRestoreInto(model, selectedTeams);
    const afterIds = WS.filter((x) => x !== ws).map((x) => x.id);
    const afterCurrentId = keepId === ws.id ? afterIds[Math.min(i, afterIds.length - 1)] : keepId;
    const undo = { ws: model, i, keepId, popouts, killed: [...shutdown.killed], teams: teamSnapshots, afterIds, afterCurrentId };
    workspaceUndos().splice(0, Infinity, undo);
    const expected = workspaceComparable(ws);
    detachWorkspace(ws, false);
    detached = true;
    const committed = await flow.closeWorkspaceState(snapshot(), ws.id, expected, { pages: shownPages(), base: stateBase, revision: freshRevision });
    if (!committed || !committed.ok) {
      if (committed && committed.doc) pendingRemoteState = committed.doc;
      throw new Error('the workspace changed before its state committed');
    }
    applyRemote(committed.doc, true);
    if (WS.some((item) => item.id === ws.id)) throw new Error('the workspace remained after its state committed');
    closed = true;
    workspaceClosedAt = performance.now();
    dropWorkspaceHeld(ws);
    popouts = [];
    return true;
  } catch (err) {
    const recovery = [];
    if (shutdown) recovery.push(...await restoreWorkspaceTerminals(ws, shutdown.operations));
    if (detached && !WS.includes(ws)) attachWorkspace(ws, restoreIndex < 0 ? WS.length : Math.min(restoreIndex, WS.length), restoreKeepId === ws.id);
    workspaceUndos().splice(0, Infinity, ...oldUndos);
    if (shutdown || detached || popouts.length || pendingRemoteState) {
      pendingRemoteState = null;
      try {
        const merged = await flushNow();
        if (merged) applyRemote(merged, true);
      } catch (flushError) { recovery.push(`state: ${(flushError && flushError.message) || flushError}`); }
    }
    if (popouts.length) {
      try { await reopenWorkspacePopouts(ws, popouts); } catch (reopenError) { recovery.push(`pop-outs: ${(reopenError && reopenError.message) || reopenError}`); }
    }
    console.error(`could not close workspace ${ws.name}`, recovery.length ? new Error(`${(err && err.message) || err}; recovery failed: ${recovery.join('; ')}`) : err);
    return false;
  } finally {
    workspaceCritical = false;
    document.body.classList.remove('workspace-committing');
    if (teamLocked && teams && typeof teams.endClose === 'function') teams.endClose(ws);
    const pending = pendingRemoteState;
    pendingRemoteState = null;
    closingWorkspace = false;
    if (pending) applyRemote(pending);
  }
}
async function openDetachedTerm(ws, w) {
  const r = await flow.term.open(termRequest(ws, w));
  if (!r || !r.ok) throw new Error((r && r.error) || `could not resume ${w.id} after undo`);
  flow.term.detach(w.id);
}
async function restoreUndoTerminal(ws, w, panes) {
  if (await flow.term.exists(w.id, remoteOpts(w))) return;
  if (panes && panes.length) {
    const restored = await flow.term.restoreAttach(w.id, { ...remoteOpts(w), expectedPanes: panes });
    if (!restored || !restored.ok) throw new Error((restored && restored.error) || `could not restore ${w.id}`);
    return;
  }
  await openDetachedTerm(ws, w);
}
let undoingWorkspace = false;
/* ⌘Z on the bare board takes back the newer of a closed workspace and a change of space (nav: cut, added, more at the
   right). One press can reach this window both as the key and as Edit > Undo: the second is the same press. */
let workspaceClosedAt = -Infinity, spaceUndoneAt = -Infinity;
const spaceUndoFirst = () => nav.spaceUndoReady(workspaceUndoReady() ? workspaceClosedAt : -Infinity);
function undoSpace() {
  if (!nav.undoSpace(workspaceUndoReady() ? workspaceClosedAt : -Infinity)) return false;
  spaceUndoneAt = performance.now();
  return true;
}
function workspaceUndoReady() {
  const u = workspaceUndos().at(-1), currentId = WS[cur] && WS[cur].id;
  return !!u && !undoingWorkspace && !closingWorkspace && !WS.some((x) => x.id === u.ws.id)
    && JSON.stringify(WS.map((x) => x.id)) === JSON.stringify(u.afterIds) && currentId === u.afterCurrentId;
}
async function undoWorkspaceClose() {
  if (!workspaceUndoReady()) return false;
  undoingWorkspace = true;
  try { return await restoreClosedWorkspace(); } finally { undoingWorkspace = false; }
}
async function restoreClosedWorkspace() {
  const stack = workspaceUndos(), u = stack[stack.length - 1];
  const killed = new Set(u.killed || []), teams = new Map((u.teams || []).map((r) => [r.teamId, r.panes]));
  const records = [...u.ws.windows, ...u.ws.closed].filter((w) => isTerm(w) && killed.has(w.id));
  try {
    for (const w of records) {
      const wait = ending.get(w.id) || (w.mate && ending.get(w.mate.lead));
      if (wait) await wait.catch(() => {});
      await restoreUndoTerminal(u.ws, w, teams.get(w.id));
    }
  } catch (err) {
    console.error(`could not restore ${u.ws.name} after undo`, err);
    return false;
  }
  stack.pop();
  attachWorkspace(u.ws, u.i, u.keepId === u.ws.id);
  const keep = WS.findIndex((x) => x.id === u.keepId);
  if (keep >= 0 && u.keepId !== u.ws.id && cur !== keep) go(keep);
  try {
    await flushNow();
    await reopenWorkspacePopouts(u.ws, u.popouts || []);
  } catch (err) {
    console.error(`could not finish restoring ${u.ws.name} after undo`, err);
  }
  return true;
}
function flash(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}
function measure() {
  const r = viewport.getBoundingClientRect();
  VW = Math.max(1, r.width);
  VH = Math.max(1, r.height);
}
function selectAll(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
const scheduleSidebar = () => { clearTimeout(sideTimer); sideTimer = setTimeout(renderSidebar, 300); };

/* ---------- titles: Claude Code puts ✳ (idle) or a spinner (working) in front of its terminal title ---------- */
const GLYPH = /^([\u2800-\u28ff✳✻✽✶✢·])\s*/;
function splitTitle(t) {
  const s = String(t || '').trim();
  const m = GLYPH.exec(s);
  return m ? { glyph: m[1], text: s.slice(m[0].length).trim() } : { glyph: '', text: s };
}
/* A terminal's title names it only when it names its conversation: the CLI's own name ("Free Code", "Claude Code") or a
   prompt line ("❯") never does (term.js nameFrom; owner, Nov 2 14:54), also when it was saved before that rule. */
const oscName = (t) => (t && window.FlowTerm.nameFrom(t) ? t : '');
function termTitle(w) {
  const r = WIN.get(w.id);
  return w.title || oscName(r && r.osc) || oscName(w.osc) || w.label || (w.type === 'team' ? 'new team' : w.cmd === 'shell' ? 'shell' : 'new agent');
}
/* A page window's name: the page's own name (notes keeps the one the owner gives it), else its shown tab's title. */
function pageName(ws, w) {
  const t = Array.isArray(w.tabs) ? w.tabs[w.tab || 0] : null;
  const n = noteById(ws, w.noteId);
  const url = (t && t.url) || (n && n.url) || '';
  return (url && window.FlowNotes.nameOf(url)) || (t && t.title) || (n && n.title) || 'untitled';
}
function winTitle(ws, w) {
  if (isTerm(w)) return termTitle(w);
  if (w.type === 'page') return pageName(ws, w);
  return window.FlowNotes.noteName(noteById(ws, w.noteId));
}
/* After a terminal's title: its team, the host it runs on, or for a shell nobody has titled yet, its folder. */
function whereOf(ws, w) {
  const team = window.FlowTeams && window.FlowTeams.label(w);
  if (team) return team;
  if (w.host) return w.where || '';
  const r = WIN.get(w.id);
  return w.cmd === 'shell' && !w.title && !oscName(r && r.osc) && !oscName(w.osc) ? tilde(w.cwd || ws.folder) : '';
}
/* A page window with two or more tabs leaves its title bar empty: the tab strip names them. */
const pageTitle = (ws, w) => (Array.isArray(w.tabs) && w.tabs.length > 1 ? '' : winTitle(ws, w));
function titleHTML(ws, w) {
  if (isTerm(w)) {
    return `${lights()}<div class="title"><span class="tt">${esc(termTitle(w))}</span><span class="where">${esc(whereOf(ws, w))}</span></div><button class="act${window.FlowNotes.lit(ws, w) ? ' on' : ''}" data-act="note" title="${w.type === 'team' ? 'this team\'s note' : 'this agent\'s note'}">✎</button>`;
  }
  if (w.type === 'page') return `${lights()}<div class="title">${esc(pageTitle(ws, w))}</div><button class="act${window.FlowNotes.lit(ws, w) ? ' on' : ''}" data-act="note" title="this page's note">✎</button>`;
  if (w.type === 'note') return `${lights()}<div class="title"></div><span class="act"></span>`;
  return `${lights()}<div class="title">${esc(winTitle(ws, w))}</div><span class="act"></span>`;
}
function renderTitle(ws, w) {
  const r = WIN.get(w.id);
  if (!r) return;
  r.tb.innerHTML = titleHTML(ws, w);
}
function updateNoteTitle(ws, n, except) {
  ws.windows.filter((w) => w.noteId === n.id).forEach((w) => {
    const r = WIN.get(w.id);
    if (!r) return;
    const t = w.type !== 'note' && r.tb.querySelector('.title');
    if (t) t.textContent = w.type === 'page' ? pageTitle(ws, w) : n.title || 'untitled';
    r.el.querySelectorAll(`.ned[data-key="title:${CSS.escape(n.id)}"]`).forEach((ed) => {
      if (ed !== except && ed !== document.activeElement && ed.innerText.replace(/\n$/, '') !== (n.title || '')) ed.textContent = n.title || '';
    });
  });
}

/* ---------- windows: the frame is built once; the body (a live terminal or web page) is never rebuilt ---------- */
function bodyHTML(w) {
  const N = window.FlowNotes;
  if (w.type === 'term' || w.type === 'team') return `<div class="body"><div class="termhost"></div>${N.paneHTML(w)}</div>`;
  if (w.type === 'note') return N.noteHTML(w);
  return `<div class="body"><div class="pn"><div class="pgc"></div></div>${N.paneHTML(w)}</div>`;
}
const fillEditors = (ws, w, force) => window.FlowNotes.fill(ws, w, force);
/* A window resizes from each edge and corner (owner, after 14:03), its grips across the border (app.css). The bottom
   right one comes first: tests and the old single grip take the first .rz. */
const RZ = ['se', 'n', 's', 'e', 'w', 'nw', 'ne', 'sw'].map((d) => `<div class="rz" data-rz="${d}"></div>`).join('');
function buildWin(ws, w) {
  const el = document.createElement('div');
  el.className = `win ${w.type}`;
  el.dataset.id = w.id;
  const tb = document.createElement('div');
  tb.className = 'tb';
  el.appendChild(tb);
  el.insertAdjacentHTML('beforeend', bodyHTML(w) + RZ);
  WIN.set(w.id, { el, tb, host: el.querySelector('.termhost, .pgc'), term: null, page: null, cur: null, osc: '', vis: null });
  renderTitle(ws, w);
  window.FlowNotes.attach(ws, w);
  fillEditors(ws, w);
  el.classList.toggle('noted', !!w.noted);
  el.style.zIndex = ++z;
  const id = w.id;
  el.addEventListener('pointerdown', (e) => { const L = locate(id); if (L) onPointerDown(e, L.ws, L.w); });
  el.addEventListener('click', (e) => { const L = locate(id); if (L) onClick(e, L.ws, L.w); });
  el.addEventListener('contextmenu', (e) => {
    const L = locate(id);
    // text being edited gets the Mac's Cut, Copy and Paste (main's textMenu); the window's menu stays on the rest
    if (!L || (!isTerm(L.w) && (e.target.isContentEditable || e.target.closest('input, textarea')))) return;
    openCtx(e, L.ws, L.w);
  });
  el.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tb');
    if (!t || t.parentElement !== el || e.target.closest('[data-l], button')) return;
    const L = locate(id);
    if (L) toggleMax(L.ws, L.w);
  });
  canvasOf(ws).appendChild(el);
  return el;
}
let warnedTerm = false, warnedPage = false;
// window id -> the kill of its session while that runs (endAgent). Its terminal opens only once the kill has settled,
// or it would attach to the session the kill then ends (installed, item 71).
const ending = new Map();
function ensureBody(ws, w) {
  const r = WIN.get(w.id);
  if (!r || !r.host || !r.el.isConnected || r.term || r.page) return;
  if (nav.away(ws, w)) return;
  if (isTerm(w)) {
    if (!window.FlowTerm) { if (!warnedTerm) { warnedTerm = true; console.error('term.js did not load, so terminals cannot start'); } return; }
    const k = ending.get(w.id);
    if (k) {
      if (r.ending !== k) {
        r.ending = k;
        const after = () => { if (ending.get(w.id) === k) ending.delete(w.id); openAfterEnd(w.id); };
        k.then(after, after);
      }
      return;
    }
    r.term = window.FlowTerm.mount(r.host, termOpts(ws, w));
    r.vis = null;
  } else if (w.type === 'page') {
    if (!window.FlowPage) { if (!warnedPage) { warnedPage = true; console.error('page.js did not load, so pages cannot open'); } return; }
    const n = noteById(ws, w.noteId);
    r.page = window.FlowPage.mount(r.host, pageOpts(w.id, n));
    r.vis = null;
    // buildWin handed this window to notes before its page existed, so the page's highlights are painted only now
    fillEditors(ws, w);
  }
}
/* A terminal held back while its session was being ended opens now, with the keys if its window is in front and
   nothing else has them. */
function openAfterEnd(id) {
  const L = locate(id), r = WIN.get(id);
  if (!L || !r) return;
  const a = document.activeElement, keys = r.el.classList.contains('front') && (!a || a === document.body || r.el.contains(a));
  ensureBody(L.ws, L.w);
  syncVisible();
  if (keys && r.term) r.term.focus();
}
function disposeBody(r) {
  if (r.term) { r.term.dispose(); r.term = null; }
  if (r.page) { r.page.dispose(); r.page = null; }
  r.vis = null;
}
function termRequest(ws, w) {
  const cmd = w.cmd === 'shell' ? 'shell' : 'claude';
  return {
    id: w.id, cmd, cwd: w.host ? w.cwd || '~' : expand(w.cwd || ws.folder), host: w.host || undefined, attach: w.attach || undefined,
    sessionId: w.sessionId || undefined, resume: cmd === 'claude' && !!w.sessionId, forkFrom: w.forkFrom || undefined,
    team: w.type === 'team', vmFolder: w.host ? ws.hostFolder || '~' : undefined,
  };
}
function termOpts(ws, w) {
  const id = w.id;
  return {
    ...termRequest(ws, w),
    onTitle: (t) => onTermTitle(id, t),
    onOpened: (res) => onTermOpened(id, res),
    onLink: (url) => openLink(id, url),
    onFocus: () => { const L = locate(id); if (L) bringFront(L.ws, L.w); },
    panesFrom: 'app',
    onExit: () => { if (window.FlowTeams) window.FlowTeams.onExit(id); },
    onMateDragStart: (pane, e) => { if (window.FlowTeams) window.FlowTeams.startPaneDrag(id, pane, e); },
    onCannot: (text) => toast(text, 5000),
    onDownload: (file) => { const L = locate(id); if (L && window.FlowFiles) window.FlowFiles.downloaded(L.ws, { state: 'completed', file, url: '' }, L.w.zone); },
  };
}
function onTermTitle(id, t) {
  const r = WIN.get(id);
  const L = locate(id);
  if (!r || !L) return;
  const { text } = splitTitle(t);
  if (text && text !== r.osc) {
    r.osc = text;
    if (!L.w.title) renderTitle(L.ws, L.w);
    if (L.w.osc !== text) { L.w.osc = text; save(); }
    scheduleSidebar();
  }
}
function onTermOpened(id, res) {
  const L = locate(id);
  if (!L || !res) return;
  // the terminal itself says why it could not start (term.js notice); no toast repeats it
  if (!res.ok) return;
  if (window.FlowTeams) window.FlowTeams.onOpened(id, res);
}
// A drop into a page, or a drag leaving it, is seen only by the page, which says so (page.js onDragDone): the shield
// over pages behind comes back, unless the drag goes on over this window within 150 ms.
let fileDragTimer = 0;
const fileDragDone = () => { clearTimeout(fileDragTimer); fileDragTimer = setTimeout(() => document.body.classList.remove('filedrag'), 150); };
function pageOpts(id, n) {
  const L = locate(id);
  return {
    id, url: (n && n.url) || '',
    tabs: L && Array.isArray(L.w.tabs) && L.w.tabs.length ? L.w.tabs : undefined,
    tab: L && L.w.tab,
    onNavigate: (nav) => { onPageNav(id, nav && nav.url); const L = locate(id); if (L) window.FlowNotes.follow(L.ws, L.w); },
    onPage: (pg) => { if (pg) window.FlowNotes.seen(pg.url, pg); },
    onMark: (text) => window.FlowNotes.onMark(id, text),
    onRedirect: (r) => { if (r) window.FlowNotes.moved(r.from, r.to); },
    nameOf: (u) => window.FlowNotes.nameOf(u),
    onClip: (text, url) => window.FlowNotes.clip(id, text, url),
    onFocus: () => { const L = locate(id); if (L) bringFront(L.ws, L.w); },
    onClose: () => { const L = locate(id); if (L) closeWin(L.ws, L.w); },
    saved: window.FlowSidebar ? window.FlowSidebar.savedHooks(id) : undefined,
    onDownload: (d) => { const L = locate(id); if (L && window.FlowFiles) window.FlowFiles.downloaded(L.ws, d, L.w.zone); },
    onTabs: (tabs, tab) => {
      const L = locate(id);
      if (!L) return;
      L.w.tabs = tabs;
      L.w.tab = tab;
      window.FlowNotes.follow(L.ws, L.w);
      const t = WIN.get(id) && WIN.get(id).tb.querySelector('.title');
      if (t && t.textContent !== pageTitle(L.ws, L.w)) t.textContent = pageTitle(L.ws, L.w);
      scheduleSidebar();
      save();
    },
    onWheel: (w) => nav.wheel({ ...w, behind: !(WIN.get(id) && WIN.get(id).el.classList.contains('front')) }),
    onDragDone: () => fileDragDone(),
    onPinch: (p) => nav.pinch(p),
    // a link the page opens as a page, not a tab (shift-click, "Open Link in New Page"): a page window beside this one
    onOpen: (url) => { const L = locate(id); if (L) openPageWin(L.ws, url, L.w); },
    // a tab dragged off the strip or moved from its menu: a page window of its own, at the drop or beside this one
    onTabOut: (kept, pt) => { const L = locate(id); return !!L && !!openPageWin(L.ws, kept.url, L.w, null, { tabs: [kept], tab: 0 }, pt); },
    showMenu: (e, items) => showMenu(e, items),
  };
}
function onPageNav(id, url) {
  const L = locate(id);
  if (!L) return;
  const n = noteById(L.ws, L.w.noteId);
  if (!n) return;
  let changed = false;
  if (url && url !== 'about:blank' && url !== n.url) { n.url = url; changed = true; }
  if (changed) { scheduleSidebar(); save(); }
}

/* Bodies of the space on screen are visible; the rest are told they are hidden. */
function syncVisible() {
  WS.forEach((ws, i) => {
    const on = SOLO ? ws.id === SOLO : i === cur;
    ws.windows.forEach((w) => {
      const r = WIN.get(w.id);
      if (!r) return;
      const vis = on && inSpace(ws, w) && !nav.away(ws, w);
      const h = r.term || r.page;
      if (h && r.vis !== vis) { r.vis = vis; h.setVisible(vis); }
    });
  });
}
function fitSoon(ms) {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { WIN.forEach((r) => { if (r.term && r.vis) r.term.fit(); }); }, ms == null ? 420 : ms);
}

/* ---------- geometry ---------- */
function apply(w, pos) {
  const r = WIN.get(w.id);
  if (!r) return;
  r.cur = { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
  const s = r.el.style;
  s.left = (pos.x / 100) * VW + 'px';
  s.top = (pos.y / 100) * VH + 'px';
  s.width = (pos.w / 100) * VW + 'px';
  s.height = (pos.h / 100) * VH + 'px';
  groupsSoon();
}
/* A group's frame is the box around its windows: it is drawn again once whatever moved them has drawn its frame. */
let groupsFrame = 0;
function groupsSoon() {
  if (groupsFrame || !groups) return;
  groupsFrame = requestAnimationFrame(() => { groupsFrame = 0; groups.render(); });
}
const zoneOf = (ws, w) => (w.zone ? zoneById(ws, w.zone) || null : null);
const membersOf = (ws, zn) => ws.windows.filter((w) => zoneOf(ws, w) === zn);
function layout(ws) {
  if (!canvasOf(ws)) return;
  const here = ws.windows.filter((w) => inSpace(ws, w) && !nav.away(ws, w));
  ws.windows.forEach((w) => { const el = elOf(w); if (el) el.style.display = here.includes(w) ? '' : 'none'; });
  place(ws, here);
  sizeCanvas(ws);
  groupsSoon();
}
/* A space's windows where they go: their own places when the workspace floats, else its columns or grid. */
function place(ws, here) {
  if (ws.mode === 'float') {
    here.forEach((w) => apply(w, w));
  } else {
    const main = here.filter((w) => w.x < 99);
    const n = Math.max(1, main.length);
    const top = 6.6, bottom = nav.bottom(), left = 1.2, right = 98.8, gap = 1.1, vgap = 1.8;
    const cols = ws.mode === 'columns' ? n : Math.ceil(Math.sqrt(n));
    const rows = Math.max(1, Math.ceil(n / cols));
    const cw = (right - left - gap * (cols - 1)) / cols;
    const rh = (bottom - top - vgap * (rows - 1)) / rows;
    main.forEach((w, k) => apply(w, { x: left + (k % cols) * (cw + gap), y: top + Math.floor(k / cols) * (rh + vgap), w: cw, h: rh }));
    here.filter((w) => !main.includes(w)).forEach((w) => apply(w, w));
  }
}
/* nav's swipe shows the space beside this one while the fingers bring it in (nav, batch 7): peek(ws, sid) lays out and
   shows that space's windows in ws's canvas as showSpace would and changes nothing else (ws.at, the views, the
   sidebar, nothing saved); nav moves them with their own transform. peek(ws) puts back what layout shows. Windows in a
   pop-out stay out. */
function peek(ws, sid) {
  if (sid === undefined) { layout(ws); syncVisible(); return []; }
  const to = sid && zoneById(ws, sid) ? sid : null;
  const list = ws.windows.filter((w) => inSpace(ws, w, to) && !nav.away(ws, w));
  list.forEach((w) => { const el = elOf(w); if (el) el.style.display = ''; ensureBody(ws, w); });
  place(ws, list);
  return list.map((w) => {
    const r = WIN.get(w.id), h = r && (r.term || r.page);
    if (h && r.vis !== true) { r.vis = true; h.setVisible(true); }
    return r ? { w, el: r.el } : null;
  }).filter(Boolean);
}
const layoutAll = () => shown().forEach(layout);
const contentEnd = (ws, except, sid) => nav.contentEnd(ws, except, sid);
const contentStart = (ws, except, sid) => nav.contentStart(ws, except, sid);
const sizeCanvas = (ws) => nav.sizeCanvas(ws);
const setPan = (ws, p, animate) => nav.setPan(ws, p, animate);
const edges = () => nav.edges();
function raise(ws, w) {
  ws.windows.forEach((o) => { const el = elOf(o); if (el) el.classList.toggle('front', o === w); });
  const el = w && elOf(w);
  // above every saved z of the workspace: a pop-out counts its own, so a window raised there can be ahead of this count
  z = Math.max(z, ...ws.windows.map((o) => o.z || 0));
  if (el) el.style.zIndex = ++z;
}
function bringFront(ws, w) {
  raise(ws, w);
  // already in front of every saved window: the order is unchanged, so a focus (one coming back with a restored
  // terminal) saves nothing
  if (w && ws.windows.every((o) => o === w || (o.z || 0) < (w.z || 0))) return;
  if (w && w.z !== z) { w.z = z; save(); }
}
function captureFloat(ws) {
  ws.windows.forEach((w) => { const r = WIN.get(w.id); if (r && r.cur) Object.assign(w, { x: r.cur.x, y: r.cur.y, w: r.cur.w, h: r.cur.h }); });
}
function setMode(ws, m) {
  if (!['float', 'columns', 'grid'].includes(m) || ws.mode === m) return;
  if (ws.mode === 'float') captureFloat(ws);
  ws.mode = m;
  layout(ws);
  renderModes();
  fitSoon();
  save();
}
/* The float, columns and grid buttons left with the arrange control (batch 8): a workspace's mode changes no control. */
function renderModes() {}
function whereIs(ws, w) {
  const zn = zoneOf(ws, w);
  if (zn) return `in ${zn.name}`;
  const r = WIN.get(w.id);
  if (!r || !r.cur || ws !== WS[cur]) return '';
  const v = nav.visible(ws);
  if (r.cur.x >= v.x + v.w - 0.3) return 'off to the right';
  if (r.cur.x + r.cur.w <= v.x + 0.3) return 'off to the left';
  return '';
}
function focusWin(ws, w) {
  if (!w) return;
  if (nav.away(ws, w)) { nav.focusAway(ws, w); return; }
  const r = WIN.get(w.id);
  if (!r) return;
  if (!inSpace(ws, w)) showSpace(ws, w.zone || null);
  if (ws === WS[cur] && r.cur) nav.reveal(ws, r.cur);
  bringFront(ws, w);
  flash(r.el);
  keysTo(ws, w, r);
}
/* The keys to w's window, as focusWin gives them, without revealing or flashing it (a title-bar click or drag). */
function keysTo(ws, w, r = WIN.get(w.id)) {
  if (!r) return;
  if (r.term) r.term.focus();
  else if (r.page) r.page.focus();
  else if (w.type === 'note') window.FlowNotes.focus(ws, w);
}
const collides = (ws, x, y, w, h, sid) => nav.collides(ws, x, y, w, h, sid);
const fitStartingLayout = () => nav.fitStart(WS);
const freeSpot = (ws, w, h, sid, clear) => nav.freeSpot(ws, w, h, sid, clear);
/* Moves windows of a space by dx, dy % for room opened in the space: at once (not with their own slide), or with it
   when slide is set, so windows that make way in view are seen to move; columns or a grid float first, as a drag does. */
function moveWindows(ws, wins, dx, dy, slide) {
  if (ws.mode !== 'float') { captureFloat(ws); ws.mode = 'float'; renderModes(); }
  wins.forEach((w) => { w.x += dx; w.y += dy; if (w.max) { w.max.x += dx; w.max.y += dy; } });
  if (!slide) track.classList.add('noanim');
  layout(ws);
  if (!slide) requestAnimationFrame(() => requestAnimationFrame(() => track.classList.remove('noanim')));
  save();
}
/* Window geometry stays nonnegative, but an edge drag may carry the camera past the old origin. Shift this space and
   its camera together only when the held item is finally left there. Nothing on screen moves. */
function keepSpaceOrigin(ws, sid = curSpace(ws)) {
  const here = [...ws.windows, ...ws.closed].filter((w) => inSpace(ws, w, sid));
  const xs = here.map((w) => w.x).filter(Number.isFinite), ys = here.map((w) => w.y).filter(Number.isFinite);
  const left = Math.min(0, ...xs), top = Math.min(4.5, ...ys);
  if (left >= 0 && top >= 4.5) return;
  const dx = -left, dy = 4.5 - top, canvas = canvasOf(ws), onScreen = sid === curSpace(ws);
  track.classList.add('noanim');
  if (canvas) canvas.classList.remove('anim');
  void track.offsetWidth;
  here.forEach((w) => {
    if (Number.isFinite(w.x)) w.x += dx;
