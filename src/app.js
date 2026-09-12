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
