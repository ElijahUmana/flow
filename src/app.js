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
    if (Number.isFinite(w.y)) w.y += dy;
    if (w.max && Number.isFinite(w.max.x)) w.max.x += dx;
    if (w.max && Number.isFinite(w.max.y)) w.max.y += dy;
  });
  const holder = sid && zoneById(ws, sid);
  if (onScreen) {
    ws.pan = (Number.isFinite(ws.pan) ? ws.pan : 0) + dx;
    ws.panY = (Number.isFinite(ws.panY) ? ws.panY : 0) + dy;
  } else if (holder) {
    holder.pan = (Number.isFinite(holder.pan) ? holder.pan : 0) + dx;
    holder.panY = (Number.isFinite(holder.panY) ? holder.panY : 0) + dy;
  } else {
    ws.mainPan = (Number.isFinite(ws.mainPan) ? ws.mainPan : 0) + dx;
    ws.mainPanY = (Number.isFinite(ws.mainPanY) ? ws.mainPanY : 0) + dy;
  }
  layout(ws);
  void track.offsetWidth;
  requestAnimationFrame(() => requestAnimationFrame(() => track.classList.remove('noanim')));
}
/* Before the first window of a space, at its top: the dock's "at the start". */
function startSpot(ws, w, h, sid) {
  return { x: contentStart(ws, null, sid) - w - 1.5, y: 6.6, w, h: Math.min(h, nav.bottom() - 6.6) };
}
/* Past the last window of a space, at its top: the dock's "at the end". */
function endSpot(ws, w, h, sid) {
  return { x: contentEnd(ws, null, sid) + 1.5, y: 6.6, w, h: Math.min(h, nav.bottom() - 6.6) };
}
/* Into another space of the same workspace, at its own size and over no window: the first free spot in that space's
   view, else past its last window, where nothing moves (lead, item 55). */
function moveToSpace(ws, w, zid) {
  board(() => moveToSpaceNow(ws, w, zid));
}
function moveToSpaceNow(ws, w, zid) {
  const to = zid && zoneById(ws, zid) ? zid : null;
  if ((w.zone || null) === to) return;
  w.max = null;
  Object.assign(w, freeSpot(ws, w.w, w.h, to, true) || endSpot(ws, w.w, w.h, to));
  if (to) w.zone = to;
  else delete w.zone;
  const r = WIN.get(w.id);
  if (r) r.cur = null;
  layout(ws);
  syncVisible();
  renderSidebar();
  save();
}


/* ---------- renaming in place: Enter saves, Esc cancels ---------- */
let renaming = null;
function renameInline(el, value, done, kind) {
  if (renaming) renaming.finish(true);
  const old = value;
  const host = el.closest('[draggable="true"]');
  el.textContent = value;
  el.setAttribute('contenteditable', 'plaintext-only');
  el.spellcheck = false;
  el.classList.add('rn');
  if (host) host.draggable = false;
  let over = false;
  const finish = (commit) => {
    if (over) return;
    over = true;
    renaming = null;
    el.removeEventListener('keydown', key);
    el.removeEventListener('blur', blur);
    el.removeEventListener('focus', back);
    document.removeEventListener('pointerdown', touch, true);
    document.removeEventListener('keydown', touch, true);
    clearTimeout(away);
    el.removeAttribute('contenteditable');
    el.classList.remove('rn');
    if (host) host.draggable = true;
    const v = el.textContent.replace(/\s+/g, ' ').trim();
    done(commit ? v : null, old);
  };
  const key = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  /* A name being typed keeps the keys until Enter or Escape. When they leave without the owner pressing or typing
     somewhere else (a page's late focus, which the page hands back), the name ends only if they stay away. */
  let elsewhere = false, away = 0, at = null;
  const touch = (e) => { if (!el.contains(e.target)) elsewhere = true; };
  document.addEventListener('pointerdown', touch, true);
  document.addEventListener('keydown', touch, true);
  const blur = () => {
    if (elsewhere) { finish(true); return; }
    const sel = getSelection();
    at = sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    away = setTimeout(() => finish(true), 150);
  };
  const back = () => {
    if (!away) return;
    clearTimeout(away);
    away = 0;
    if (at) { const s = getSelection(); s.removeAllRanges(); s.addRange(at); at = null; }
  };
  el.addEventListener('focus', back);
  el.addEventListener('keydown', key);
  el.addEventListener('blur', blur);
  renaming = { el, kind, finish };
  el.focus({ preventScroll: true });
  selectAll(el);
}
function renamePill(i, after) {
  const pill = spacesEl.querySelector(`.sp[data-i="${i}"]`);
  const ws = WS[i];
  if (!pill || !ws) return;
  renameInline(pill.querySelector('.sn'), ws.name, (v) => {
    if (v && v !== ws.name) {
      ws.name = v;
      if (after) after(v);
      save();
    }
    renderNav();
    renderSidebar();
  }, 'pill');
}
function renameAgent(ws, w, label) {
  renameInline(label, termTitle(w), (v) => {
    if (v !== null) {
      w.title = v;
      const r = WIN.get(w.id);
      if (r) renderTitle(ws, w);
      save();
    }
    renderSidebar();
  }, 'row');
}

/* ---------- workspaces and sub-workspaces ---------- */
function renameZone(ws, zid, label) {
  const zn = ws && zoneById(ws, zid);
  if (!zn || !label) return;
  const inPill = spacesEl.contains(label);
  renameInline(label, zn.name, (v) => {
    if (v && v !== zn.name) { zn.name = v; save(); }
    renderSidebar();
    if (inPill) label.textContent = `› ${zn.name}`;
    renderNav();
  }, inPill ? 'pill' : 'zone');
}
function buildWS(ws) {
  ws.mode = ws.mode || 'float';
  ws.pan = ws.pan || 0;
  ws.zones = ws.zones || [];
  ws.closed = ws.closed || [];
  ws.notes = ws.notes || [];
  ws.windows = ws.windows || [];
  const sec = document.createElement('section');
  sec.className = 'ws';
  sec.dataset.id = ws.id;
  sec.style.background = ws.bg;
  const canvas = document.createElement('div');
  canvas.className = 'canvas';
  sec.appendChild(canvas);
  SEC.set(ws.id, { sec, canvas, rubber: 0 });
  const wid = ws.id;
  [...ws.windows].sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((w) => buildWin(ws, w));
  const top = ws.windows.reduce((a, b) => ((b.z || 0) > ((a && a.z) || 0) ? b : a), null);
  const front = (top && top.z ? top : null) || ws.windows.find((w) => w.front) || ws.windows[ws.windows.length - 1];
  // the saved order comes back as it was: a launch raises the front window on screen and saves nothing
  if (front) raise(ws, front);
  return sec;
}
function buildAll() {
  track.innerHTML = '';
  shown().forEach((ws) => track.appendChild(buildWS(ws)));
  shown().forEach((ws) => ws.windows.forEach((w) => ensureBody(ws, w)));
  layoutAll();
  syncVisible();
}
function jumpTo(i) {
  track.style.transition = 'none';
  track.style.transform = SOLO ? 'none' : `translateX(${-i * 100}%)`;
  requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
}
function go(i) {
  if (SOLO || i < 0 || i >= WS.length || i === cur) return false;
  cur = i;
  track.style.transform = `translateX(${-i * 100}%)`;
  renderNav();
  renderModes();
  edges();
  renderSidebar();
  syncVisible();
  fitSoon(600);
  save();
  return true;
}
function step(dir) {
  if (!go(cur + dir)) bounce(dir);
}
/* go(i) for a three-finger swipe that has already brought the strip there (nav.js): no slide of its own; the same i
   puts the strip back where it belongs, also without one. */
function goWs(i, o) {
  if (!(o && o.still)) return go(i);
  track.style.transition = 'none';
  const moved = go(i);
  if (!moved) track.style.transform = SOLO ? 'none' : `translateX(${-cur * 100}%)`;
  requestAnimationFrame(() => requestAnimationFrame(() => { track.style.transition = ''; }));
  return moved;
}
function bounce(dir) {
  const base = `translateX(${-cur * 100}%)`;
  track.animate([{ transform: base }, { transform: `translateX(calc(${-cur * 100}% + ${-dir * 26}px))` }, { transform: base }], { duration: 300, easing: 'ease-out' });
}
/* Pills rebuilt under a press would drop its click (the click that ends a rename, on another workspace's pill for one),
   so while the pills are pressed they are rebuilt once the press is over, as the sidebar does with its rows. */
let navPressed = false, navHeld = false, szxAt = -Infinity;
function renderNav() {
  if (renaming && renaming.kind === 'pill') return;
  if (navPressed) { navHeld = true; return; }
  if (SOLO) {
    const ws = WS[cur];
    const zn = SOLO_ZONE && zoneById(ws, SOLO_ZONE);
    spacesEl.innerHTML = `<span class="sp on">${esc(ws.name)}${zn ? ` › ${esc(zn.name)}` : ''}</span>`;
    document.title = zn ? `${ws.name} › ${zn.name}` : ws.name;
    return;
  }
  spacesEl.innerHTML = '<div class="pills">' + WS.map((ws, i) => { const zn = zoneById(ws, curSpace(ws)); return `<div class="sp${i === cur ? ' on' : ''}" draggable="true" data-i="${i}"><span class="sn">${esc(ws.name)}</span>${zn ? `<span class="sz">${i === cur ? '›' : `<span class="szx" data-szx="${i}" title="back to ${esc(ws.name)}">›</span>`} ${esc(zn.name)}</span>` : ''}<span class="pop" data-pop="${i}" title="open in its own window">⤢</span>${WS.length > 1 ? `<button type="button" draggable="false" class="pillx" data-close-ws="${i}" aria-label="close ${esc(ws.name)}" title="close ${esc(ws.name)}">×</button>` : ''}</div>`; }).join('') + '</div>'
    + '<button class="addws" id="addws" title="new workspace">+</button>';
  const on = spacesEl.querySelector('.sp.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
const PALETTE = [
  ['#24304a', '#2f2446', '#121318'], ['#16323a', '#1d3a2f', '#10171a'], ['#3a2a17', '#33241a', '#17130f'],
  ['#33203b', '#2a1c33', '#151018'], ['#1c2a45', '#1b2f4a', '#0f131b'], ['#2b2444', '#3b2236', '#141319'],
];
function addWorkspace(name) {
  const [a, b, c] = PALETTE[WS.length % PALETTE.length];
  const ws = {
    id: newId('ws'), name, folder: '~', zones: [], closed: [], notes: [], saved: [],
    bg: `radial-gradient(1100px 650px at 15% 10%, ${a} 0%, transparent 62%), radial-gradient(900px 600px at 90% 92%, ${b} 0%, transparent 60%), ${c}`,
    windows: [],
  };
  WS.push(ws);
  track.appendChild(buildWS(ws));
  layout(ws);
  go(WS.length - 1);
  return ws;
}
/* + makes the workspace right away, empty, and puts its name into rename. */
function newWorkspace() {
  if (SOLO) return null;
  const ws = addWorkspace('new workspace');
  // named, it picks up a home folder of that name; flushNow first: files.list lists only folders of the saved state
  renamePill(WS.indexOf(ws), (name) => {
    if (!window.FlowWsMenu || ws.folder !== '~') return;
    flushNow().then(() => window.FlowWsMenu.folderFor(name)).then((f) => { if (f && ws.folder === '~') { ws.folder = f; renderSidebar(); save(); } },
      (err) => console.error('could not pick up the new workspace\'s folder', err));
  });
  return ws;
}
async function popOut(wsId, zoneId, frame) {
  try {
    await flushPages();
  } catch (err) {
    console.error('could not save before opening a window', err);
    toast('could not save, so the new window did not open', 4000);
    return;
  }
  flow.openWindow('solo=' + encodeURIComponent(wsId) + (zoneId ? '&zone=' + encodeURIComponent(zoneId) : ''), frame);
}
/* The spaces of a workspace in the sidebar's order, depth first: main (null), then each sub-workspace followed by its own
   (zn.parent), siblings in ws.zones order. A zone whose parent is gone counts as top level. */
function spaceOrder(ws) {
  const zs = ws.zones || [], ids = new Set(zs.map((z) => z.id)), seen = new Set(), out = [null];
  const under = (z, pid) => (pid ? z.parent === pid : !z.parent || !ids.has(z.parent));
  const walk = (pid) => zs.forEach((z) => { if (!seen.has(z.id) && under(z, pid)) { seen.add(z.id); out.push(z.id); walk(z.id); } });
  walk(null);
  zs.forEach((z) => { if (!seen.has(z.id)) out.push(z.id); });
  return out;
}
/* A new sub-workspace in parentId's space (null: directly in the workspace), last among that space's own; ws.zones is
   kept in the sidebar's order. Flow goes there. */
function addZone(ws, parentId) {
  if (SOLO) return null;
  const parent = parentId && zoneById(ws, parentId) ? parentId : null;
  const zn = { id: newId('z'), name: 'new sub-workspace', pan: 0, ...(parent ? { parent } : {}) };
  // within: in parent's subtree (a parent chain never made by Flow cannot loop it)
  const order = spaceOrder(ws).slice(1), within = (id) => {
    let z = zoneById(ws, id);
    for (let i = 0; z && i < 64; i++) { if (z.parent === parent) return true; z = z.parent ? zoneById(ws, z.parent) : null; }
    return false;
  };
  let at = parent ? order.indexOf(parent) : order.length - 1;
  if (parent) while (at + 1 < order.length && within(order[at + 1])) at++;
  order.splice(at + 1, 0, zn.id);
  const byId = new Map([...ws.zones, zn].map((z) => [z.id, z]));
  ws.zones.splice(0, ws.zones.length, ...order.map((id) => byId.get(id)));
  showSpace(ws, zn.id);
  return zn;
}
/* Show another space of this workspace (zid null: the main one). The canvas slides in from the side it lies on. */
/* still: no slide in, when a swipe has already brought the space in (nav). */
function showSpace(ws, zid, opts) {
  if (SOLO_ZONE && ws.id === SOLO) return;
  const to = zid && zoneById(ws, zid) ? zid : null, from = curSpace(ws);
  if (to === from) return;
  const order = spaceOrder(ws);
  const dir = order.indexOf(to) > order.indexOf(from) ? 1 : -1;
  nav.swap(ws, from, to);
  ws.at = to;
  layout(ws);
  const c = canvasOf(ws);
  if (c && ws === WS[cur] && !(opts && opts.still)) c.animate([{ translate: `${dir * 48}px 0`, opacity: 0.4 }, { translate: '0 0', opacity: 1 }], { duration: 220, easing: 'ease-out' });
  syncVisible();
  edges();
  renderNav();
  renderSidebar();
  fitSoon(260);
  save();
}


/* ---------- undo for the board (owner, Nov 7: "undo say whatever last action that was say taken and it sort of like
   auto repalys that back") ---------- */
/* ⌘Z and ⇧⌘Z, and Edit > Undo and Redo, take back and put again what the hands last did to the board: a window moved,
   resized, filled, parked, made, closed, reopened, sent to another space or workspace, an arrange. The screen goes back
   to the workspace and space it was done in, the view to where it was unless the owner moved it since, and the windows
   glide there, so the undo is seen. A step covers only the windows and notes it changed. Typing since then (a note, a
   field, a terminal) keeps ⌘Z for the text, and a workspace closed since keeps it for that (the silent undo above). A
   page that has the keys undoes in itself: main sends Edit > Undo to it. Kept for this window's run. */
const BOARD_STEPS = 50;
const boardPast = [], boardFuture = [];
let boardDepth = 0, boardReplaying = false, editAt = -Infinity, boardLast = { t: -Infinity, by: '' };
const boardGeo = (w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, max: w.max ? { ...w.max } : null, zone: w.zone || null });
const boardView = (ws) => ({ at: ws.at || null, pan: ws.pan || 0, panY: ws.panY || 0, zoom: ws.zoom || 1 });
const boardWinKey = (e) => (e ? JSON.stringify([e.ws, e.list, e.g], (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)) : '');
const boardNoteKey = (e) => (e ? JSON.stringify([e.ws, e.parent]) : '');
function boardSnap() {
  const wins = new Map(), notes = new Map(), modes = new Map(), views = new Map();
  WS.forEach((ws) => {
    const note = (w) => (w.noteId ? noteById(ws, w.noteId) || null : null);
    ws.windows.forEach((w, i) => wins.set(w.id, { ws: ws.id, list: 'windows', i, g: boardGeo(w), ref: w, note: note(w) }));
    ws.closed.forEach((w, i) => wins.set(w.id, { ws: ws.id, list: 'closed', i, g: boardGeo(w), ref: w, note: null }));
    ws.notes.forEach((n, i) => notes.set(n.id, { ws: ws.id, i, parent: n.parent || null, ref: n }));
    modes.set(ws.id, ws.mode);
    views.set(ws.id, boardView(ws));
  });
  return { wins, notes, modes, views, cur: WS[cur] ? WS[cur].id : null };
}
/* Runs one board action as one step. before: taken earlier, for an action that starts before it is known to be one
   (a drag, a resize). Actions inside another, or an undo replaying, are part of that one. */
function board(fn, before) {
  if (boardReplaying || boardDepth) return fn();
  const was = before || boardSnap();
  boardDepth++;
  try { return fn(); } finally { boardDepth--; boardDone(was); }
}
function boardDone(before) {
  const after = boardSnap(), changed = (a, b, key) => [...new Set([...a.keys(), ...b.keys()])].filter((id) => key(a.get(id)) !== key(b.get(id)));
  const wins = changed(before.wins, after.wins, boardWinKey), notes = changed(before.notes, after.notes, boardNoteKey);
  const modes = changed(before.modes, after.modes, (m) => m || '');
  if (!wins.length && !notes.length && !modes.length) return;
  const keep = (s) => ({ ...s, wins: new Map(wins.filter((id) => s.wins.has(id)).map((id) => [id, s.wins.get(id)])),
    notes: new Map(notes.filter((id) => s.notes.has(id)).map((id) => [id, s.notes.get(id)])) });
  boardPast.push({ before: keep(before), after: keep(after), wins, notes, modes, t: performance.now() });
  if (boardPast.length > BOARD_STEPS) boardPast.shift();
  boardFuture.length = 0;
}
/* The next undo (or redo) is the board's when it has a step, unless the keys are in text typed in since that step (the
   text's own undo comes first there) or a workspace closed since then can still come back. */
function boardTurn(stack) {
  const top = stack[stack.length - 1];
  if (!top || dragging || closingWorkspace || workspaceCritical || undoingWorkspace) return false;
  if (workspaceClosedAt > top.t && workspaceUndoReady()) return false;
  // space cut or added since (nav's own ⌘Z, the newer action) goes back first
  if (stack === boardPast && nav.spaceUndoReady(top.t)) return false;
  return top.t > editAt || !isEditingTarget(document.activeElement);
}
/* by: 'key' or 'menu'. One ⌘Z can reach this window both as a key and as Edit > Undo: the second is the same press. */
function boardStep(back, by) {
  const now = performance.now();
  if (boardLast.by && boardLast.by !== by && now - boardLast.t < 400) return true;
  if (back && !dragging && !closingWorkspace && !workspaceCritical && !undoingWorkspace) {
    // the space cut or added and the closed workspace keep their own undo; the newest of them and the board's step goes
    // back first, and the keys in text keep the press only when something was typed there since (the board's rule)
    const top = boardPast[boardPast.length - 1], topT = top ? top.t : -Infinity;
    const closed = workspaceUndoReady() ? workspaceClosedAt : -Infinity, inText = isEditingTarget(document.activeElement);
    if (nav.spaceUndoReady(Math.max(topT, closed)) && (nav.spaceUndoReady(editAt) || !inText)) {
      undoSpace();
      boardLast = { t: performance.now(), by };
      return true;
    }
    if (closed > topT && (closed > editAt || !inText)) {
      undoWorkspaceClose();
      boardLast = { t: performance.now(), by };
      return true;
    }
  }
  const from = back ? boardPast : boardFuture, to = back ? boardFuture : boardPast;
  let rec = null;
  while (boardTurn(from)) {
    const r = from.pop(), O = back ? r.after : r.before;
    // only what is still as the step left it: a window closed, deleted or moved again since stays as it is now
    const live = { ...r, wins: r.wins.filter((id) => boardNowWin(id) === boardWinKey(O.wins.get(id))),
      notes: r.notes.filter((id) => boardNowNote(id) === boardNoteKey(O.notes.get(id))),
      modes: r.modes.filter((id) => { const ws = WS.find((x) => x.id === id); return !!ws && ws.mode === O.modes.get(id); }) };
    if (live.wins.length || live.notes.length || live.modes.length) { rec = live; break; }
  }
  if (!rec) return false;
  boardReplaying = true;
  try {
    boardApply(rec, back ? rec.before : rec.after, back ? rec.after : rec.before);
  } catch (err) {
    console.error('could not undo that on the board', err);
  } finally {
    boardReplaying = false;
  }
  rec.t = performance.now();
  to.push(rec);
  boardLast = { t: rec.t, by };
  return true;
}
/* A plain note made by the step and written in since stays when the step is undone; a page's note goes or stays with
   its window as closing decides (dropPageNote). */
const boardKeepsNote = (n) => n.kind === 'page' || !!n.titleSet || !!(n.body && n.body.trim());
function boardPutGeo(ws, w, g) {
  Object.assign(w, { x: g.x, y: g.y, w: g.w, h: g.h });
  w.max = g.max ? { ...g.max } : null;
  if (g.zone && zoneById(ws, g.zone)) w.zone = g.zone;
  else delete w.zone;
  const r = WIN.get(w.id);
  if (r) r.cur = null;
}
function boardNowWin(id) {
  const f = boardFind(id);
  return f && f.list !== 'held' ? boardWinKey({ ws: f.ws.id, list: f.list, g: boardGeo(f.w) }) : '';
}
function boardNowNote(id) {
  for (const ws of WS) { const n = noteById(ws, id); if (n) return boardNoteKey({ ws: ws.id, parent: n.parent || null }); }
  return '';
}
function boardFind(id) {
  for (const ws of WS) {
    let i = ws.windows.findIndex((w) => w.id === id);
    if (i >= 0) return { ws, list: 'windows', i, w: ws.windows[i] };
    i = ws.closed.findIndex((w) => w.id === id);
    if (i >= 0) return { ws, list: 'closed', i, w: ws.closed[i] };
  }
  const h = HELD.find((x) => x.w.id === id);
  return h ? { ws: h.ws, list: 'held', h, w: h.w } : null;
}
/* Puts the board as S has it for the step's windows and notes; O is the other side, what is there now if nothing
   moved since. */
function boardApply(rec, S, O) {
  const wsOf = (id) => WS.find((x) => x.id === id) || null;
  const touched = new Set(), back = [];
  rec.modes.forEach((id) => { const ws = wsOf(id); if (ws && S.modes.has(id)) { ws.mode = S.modes.get(id); touched.add(ws); } });
  // notes first, so a window coming back finds its note
  const noteAt = (id) => { for (const ws of WS) { const i = ws.notes.findIndex((n) => n.id === id); if (i >= 0) return { ws, i, n: ws.notes[i] }; } return null; };
  rec.notes.forEach((id) => {
    const t = S.notes.get(id), now = noteAt(id), to = t && wsOf(t.ws), n = now ? now.n : (t || O.notes.get(id)).ref;
    if (!t && boardKeepsNote(n)) return;
    if (t) { if (t.parent) n.parent = t.parent; else delete n.parent; }
    if (now && now.ws === to) return;
    if (now) now.ws.notes.splice(now.i, 1);
    if (to) to.notes.splice(Math.min(t.i, to.notes.length), 0, n);
  });
  rec.wins.forEach((id) => {
    const t = S.wins.get(id), now = boardFind(id), to = t && wsOf(t.ws);
    if (!to) {
      // made by the step: it closes as the red light closes it (a terminal goes to the closed list, its session on)
      if (now && now.list === 'windows') { closeWin(now.ws, now.w); touched.add(now.ws); }
      return;
    }
    const w = now ? now.w : t.ref;
    if (now && now.list === 'windows' && now.ws === to && t.list === 'windows') {
      boardPutGeo(to, w, t.g);
      touched.add(to);
      back.push({ ws: to, w });
      return;
    }
    if (now && now.list === 'windows' && t.list === 'windows') { now.ws.windows.splice(now.i, 1); touched.add(now.ws); }
    else if (now && now.list === 'windows') { removeWindow(now.ws, w); touched.add(now.ws); }
    else if (now && now.list === 'closed') now.ws.closed.splice(now.i, 1);
    else if (now && now.list === 'held') {
      const h = now.h;
      HELD.splice(HELD.indexOf(h), 1);
      clearTimeout(h.timer);
      if (t.list === 'windows' && h.ws === to) { h.r.el.classList.replace('held', 'win'); WIN.set(id, h.r); }
      else { disposeBody(h.r); h.r.el.remove(); }
    }
    boardPutGeo(to, w, t.g);
    if (t.list === 'closed') { to.closed.splice(Math.min(t.i, to.closed.length), 0, w); touched.add(to); return; }
    // a window coming back whose note went after the step (a closed page's, once its site was done saving)
    const nt = t.note || (O.wins.get(id) && O.wins.get(id).note);
    if (w.noteId && !noteById(to, w.noteId) && nt && !noteAt(w.noteId)) to.notes.unshift(nt);
    to.windows.splice(Math.min(t.i, to.windows.length), 0, w);
    touched.add(to);
    back.push({ ws: to, w });
  });
  touched.forEach((ws) => {
    const canvas = canvasOf(ws);
    ws.windows.forEach((w) => {
      const r = WIN.get(w.id);
      if (!canvas) { if (r) { disposeBody(r); r.el.remove(); WIN.delete(w.id); } return; }
      if (!r) { buildWin(ws, w).classList.add('pop-in'); ensureBody(ws, w); return; }
      if (r.el.parentElement !== canvas) {
        canvas.appendChild(r.el);
        if (r.page) { r.page.dispose(); r.page = null; r.vis = null; }
        ensureBody(ws, w);
      }
    });
    layout(ws);
  });
  // the screen where the step was done: its workspace, its space, and its view unless the owner moved it since
  const there = wsOf(S.cur);
  if (there && !SOLO && WS[cur] !== there) go(WS.indexOf(there));
  const ws = WS[cur], sv = ws && S.views.get(ws.id), ov = ws && O.views.get(ws.id);
  if (sv && (ws.at || null) !== sv.at && (!sv.at || zoneById(ws, sv.at))) showSpace(ws, sv.at);
  syncVisible();
  const live = ws && boardView(ws);
  const same = (a, b) => !!a && !!b && a.at === b.at && Math.abs(a.pan - b.pan) < 0.01 && Math.abs(a.panY - b.panY) < 0.01 && Math.abs(a.zoom - b.zoom) < 0.0001;
  const seen = back.filter((x) => x.ws === ws && inSpace(ws, x.w) && WIN.get(x.w.id));
  if (sv && same(live, ov) && sv.at === live.at) {
    ws.panY = sv.panY;
    ws.zoom = sv.zoom;
    nav.setPan(ws, (sv.pan / 100) * VW, true);
  } else if (seen.length) {
    const x = Math.min(...seen.map((s) => s.w.x)), y = Math.min(...seen.map((s) => s.w.y));
    nav.reveal(ws, { x, y, w: Math.max(...seen.map((s) => s.w.x + s.w.w)) - x, h: Math.max(...seen.map((s) => s.w.y + s.w.h)) - y });
  }
  seen.forEach((s) => flash(WIN.get(s.w.id).el));
  if (seen.length) bringFront(ws, seen[seen.length - 1].w);
  fitSoon();
  renderSidebar();
  save();
}
/* ⌘Z and ⇧⌘Z before anything else has them (a note's or a terminal's own keys), when the board's step is the newest. */
function boardKey(e) {
  if (!e.metaKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== 'z') return;
  if (document.body.classList.contains('workspace-committing')) return;
  if (!boardStep(!e.shiftKey, 'key')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

/* ---------- window actions ---------- */
function addWindow(ws, w, at, sp = curSpace(ws)) {
  if (sp) w.zone = sp;
  else delete w.zone;
  if (at == null) ws.windows.push(w);
  else ws.windows.splice(at, 0, w);
  const el = buildWin(ws, w);
  ensureBody(ws, w);
  layout(ws);
  el.classList.add('pop-in');
  bringFront(ws, w);
  syncVisible();
  save();
  return w;
}
function removeWindow(ws, w) {
  const r = WIN.get(w.id);
  window.FlowNotes.detach(w.id);
  if (r) { disposeBody(r); r.el.remove(); WIN.delete(w.id); }
  const i = ws.windows.indexOf(w);
  if (i >= 0) ws.windows.splice(i, 1);
  layout(ws);
}
/* Quitting, or closing this window, while pages here guard unsaved typing (main waits and names them): nothing is
   asked and nothing comes into view; it goes on at once (owner, Nov 1 20:47). */
function onUnsavedPages({ action } = {}) {
  flow.closeAnyway(action);
}
/* The red light and ⌘W on a page's last tab: a page guarding unsaved changes asks Leave or Stay first. */
function closeAsked(ws, w) {
  const r = WIN.get(w.id);
  if (!r || !r.page) { closeWin(ws, w); return; }
  r.page.confirmClose().then((ok) => { if (ok && locate(w.id)) closeWin(ws, w); }, (err) => {
    console.error(`could not ask ${w.id}'s page before closing it`, err);
    toast(`could not close ${winTitle(ws, w)}: ${(err && err.message) || 'no reason given'}`, 5000);
  });
}
function closeWin(ws, w) {
  return board(() => closeWinNow(ws, w));
}
function closeWinNow(ws, w) {
  const r = w.type === 'page' && WIN.get(w.id);
  if (r && r.page) holdWin(ws, w, r);
  else removeWindow(ws, w);
  w.max = null;
  if (isTerm(w)) {
    ws.closed.push(w);
  } else if (w.type === 'page' && !(r && r.page)) {
    dropPageNote(ws, w);
  }
  renderSidebar();
  save();
}
const dropPageNote = (ws, w) => {
  const n = noteById(ws, w.noteId);
  if (n && (!n.url || window.FlowNotes.unused(ws, w))) ws.notes.splice(ws.notes.indexOf(n), 1);
};
/* A page window leaves at once when it closes. If its site guards unsaved typing (Docs, Gmail), it stays in the
   document, hidden, for 10 s so the site can finish saving (a webview dies when it leaves the document), and ⇧⌘T in
   that time brings it back as it was (owner, Nov 1 20:47; lead, Nov 2). */
const HELD = [];
function holdWin(ws, w, r) {
  const h = { ws, w, r, at: ws.windows.indexOf(w), timer: 0 };
  WIN.delete(w.id);
  if (h.at >= 0) ws.windows.splice(h.at, 1);
  r.el.classList.replace('win', 'held');
  HELD.push(h);
  layout(ws);
  r.page.guarded().then((yes) => {
    if (!HELD.includes(h)) return;
    if (yes) h.timer = setTimeout(() => dropHeld(h), 10000);
    else dropHeld(h);
  }, (err) => {
    console.error(`could not ask ${w.id}'s page about unsaved typing`, err);
    dropHeld(h);
  });
}
function dropWorkspaceHeld(ws) {
  for (const h of HELD.filter((x) => x.ws === ws)) dropHeld(h);
}
function dropHeld(h) {
  const i = HELD.indexOf(h);
  if (i < 0) return;
  HELD.splice(i, 1);
  clearTimeout(h.timer);
  window.FlowNotes.detach(h.w.id);
  disposeBody(h.r);
  h.r.el.remove();
  dropPageNote(h.ws, h.w);
  renderSidebar();
  save();
}
function reopenHeld() {
  const h = HELD.pop();
  if (!h) return false;
  clearTimeout(h.timer);
  h.r.el.classList.replace('held', 'win');
  WIN.set(h.w.id, h.r);
  h.ws.windows.splice(Math.max(0, Math.min(h.at, h.ws.windows.length)), 0, h.w);
  layout(h.ws);
  focusWin(h.ws, h.w);
  renderSidebar();
  save();
  return true;
}
function reopen(ws, wid) {
  board(() => reopenNow(ws, wid));
}
function reopenNow(ws, wid) {
  const i = ws.closed.findIndex((w) => w.id === wid);
  if (i < 0) return;
  const w = ws.closed.splice(i, 1)[0];
  const zone = w.zone && zoneById(ws, w.zone) ? w.zone : null;
  // back where it was, at its own size; a record with no place of its own takes a free spot (lead, browse r6)
  const placed = [w.x, w.y, w.w, w.h].every((n) => Number.isFinite(n));
  if (!placed) Object.assign(w, freeSpot(ws, w.w || 36, w.h || 44, zone));
  addWindow(ws, w, null, zone);
  focusWin(ws, w);
  // after focusWin has shown its space: nav.clear makes way in the space on screen
  if (placed && inSpace(ws, w)) nav.clear(ws, w);
  renderSidebar();
}
/* The sidebar's × on an agent, shell or team, open or closed: its window goes and its session ends; a team's own
   teammates end with it. An attached VM session Flow did not start only loses Flow's connection (pty.kill). */
async function endAgent(ws, wid) {
  if (closingWorkspace || undoingWorkspace) return;
  const w = findWin(ws, wid) || ws.closed.find((x) => x.id === wid);
  if (!w) return;
  const all = [w, ...(w.type === 'team' ? [...ws.windows, ...ws.closed].filter((m) => m.mate && m.mate.lead === w.id) : [])];
  const title = termTitle(w);
  // the click shows its result at once and the sessions end behind it; one that can't end comes back, closed
  const ended = all.map((x) => {
    const kept = window.FlowNotes.keep(ws, x), open = ws.windows.includes(x);
    if (open) removeWindow(ws, x);
    else ws.closed.splice(ws.closed.indexOf(x), 1);
    return { w: x, kept, open };
  });
  renderSidebar();
  save();
  if ((w.cmd === 'claude' && w.sessionId) || w.cmd === 'shell') toast(`ended ${title}`, 8000, { label: 'undo', run: () => unend(ws, ended) });
  const failed = [];
  await Promise.all(ended.map(async (e) => {
    const k = flow.term.kill(e.w.id, remoteOpts(e.w));
    ending.set(e.w.id, k);
    try {
      await k;
    } catch (err) {
      console.error(`could not end ${e.w.id}`, err);
      failed.push(err);
      if (WS.includes(ws) && !ws.closed.includes(e.w) && !findWin(ws, e.w.id)) {
        if (e.kept) window.FlowNotes.take(e.w.sessionId);
        ws.closed.push(e.w);
      }
    } finally {
      if (ending.get(e.w.id) === k) ending.delete(e.w.id);
    }
  }));
  if (failed.length) {
    renderSidebar();
    save();
    toast(`could not end ${title}: ${(failed[0] && failed[0].message) || 'no reason given'}`, 5000);
  }
}
/* Undo after ending an agent, a shell or a team: what was open opens again where it was, resuming its conversation
   (or a shell in its folder) once its end has settled; what was closed comes back closed. */
function unend(ws, ended) {
  if (!WS.includes(ws)) return;
  const ids = openSessionIds();
  for (const { w, kept, open } of ended) {
    if ((w.sessionId && ids.has(w.sessionId)) || findWin(ws, w.id) || ws.closed.includes(w)) continue;
    if (kept) window.FlowNotes.take(w.sessionId);
    ws.closed.push(w);
    // the toast's own undo, not a step of the board's
    if (open) reopenNow(ws, w.id);
  }
  renderSidebar();
  save();
}
function park(ws, w) {
  board(() => parkNow(ws, w));
}
function parkNow(ws, w) {
  w.max = null;
  w.x = contentEnd(ws, w) + 1.5;
  w.y = clamp(w.y, 6.6, 60);
  apply(w, w);
  sizeCanvas(ws);
  renderSidebar();
  save();
}
function toggleMax(ws, w) {
  board(() => toggleMaxNow(ws, w));
}
function toggleMaxNow(ws, w) {
  if (w.max) {
    Object.assign(w, w.max);
    w.max = null;
  } else {
    w.max = { x: w.x, y: w.y, w: w.w, h: w.h };
    Object.assign(w, nav.fillRect(ws));
  }
  if (ws.mode !== 'float') { ws.mode = 'float'; renderModes(); }
  apply(w, w);
  bringFront(ws, w);
  sizeCanvas(ws);
  fitSoon();
  save();
}
function resizeTo(ws, w, wPct, hPct, xPct = w.x, yPct = w.y) {
  w.max = null;
  w.w = Math.max(16, wPct);
  w.h = Math.max(16, hPct);
  w.x = xPct;
  w.y = yPct;
  apply(w, w);
}
function moveWindow(from, w, to) {
  board(() => moveWindowNow(from, w, to));
}
function moveWindowNow(from, w, to) {
  const r = WIN.get(w.id);
  const i = from.windows.indexOf(w);
  if (i >= 0) from.windows.splice(i, 1);
  w.max = null;
  if (w.noteId) {
    const n = noteById(from, w.noteId);
    if (n) {
      from.notes.splice(from.notes.indexOf(n), 1);
      n.parent = null;
      to.notes.unshift(n);
    }
  }
  if (r) r.cur = null;
  const sp = curSpace(to);
  if (sp) w.zone = sp;
  else delete w.zone;
  Object.assign(w, freeSpot(to, w.w, w.h, sp || null, true) || endSpot(to, w.w, w.h, sp || null));
  to.windows.push(w);
  const canvas = canvasOf(to);
  if (r && canvas) {
    canvas.appendChild(r.el);
    if (r.page) { r.page.dispose(); r.page = null; r.vis = null; ensureBody(to, w); }
  } else if (r) {
    disposeBody(r);
    r.el.remove();
    WIN.delete(w.id);
  }
  layout(from);
  layout(to);
  syncVisible();
  renderSidebar();
  save();
}
const openNote = (ws, nid) => window.FlowNotes.open(ws, nid);
/* A page opened from a link, a popup or a terminal goes right next to the window it came from when there is room. */
function openPageWin(ws, url, near, last, extra, pt) {
  return board(() => openPageWinNow(ws, url, near, last, extra, pt));
}
function openPageWinNow(ws, url, near, last, extra, pt) {
  const n = { id: newId('n'), kind: 'page', title: url ? prettyTitle(url) : 'new page', url: url || '', body: '' };
  ws.notes.unshift(n);
  const W = 46, H = 64;
  let pos = null;
  /* a tab or a file dropped in the view: where it was dropped, as for a dock button. A file drag captures its world
     point at drop, after every edge-pan frame; opening it is async, so converting its screen point later would drift. */
  const vr = pt && !pt.world && viewport.getBoundingClientRect();
  const hand = pt && pt.world ? pt.hand : vr && pt.x >= vr.left && pt.x <= vr.right && pt.y >= vr.top && pt.y <= vr.bottom ? nav.toSpace(ws, pt.x, pt.y) : null;
  if (hand) {
    pos = nav.placeRoom(ws, { x: hand.x - W / 2, y: hand.y - (14 / nav.zoom(ws) / VH) * 100, hand }, W, H, hand);
  }
  /* from a terminal's or a note's link: its own page at that window's height and a page's width, flush and level with it,
     on its right unless only the left moves no window; the next one beside the last, the same way; what is in the way
     makes way (nav.beside; lead, batch 7) */
  if (!pos && near) {
    const dims = { w: W, h: geo(near).h };
    let from = near, side = 'right';
    if (last) { from = last; side = geo(last).x < geo(near).x ? 'left' : 'right'; }
    else {
      const R = nav.beside(ws, near, 'right', false, true, dims), Lf = nav.beside(ws, near, 'left', false, true, dims);
      if (R && Lf && R.moved > 0 && Lf.moved === 0) side = 'left';
    }
    const r = nav.beside(ws, from, side, false, false, dims);
    if (r) pos = r.at;
  }
  const w = addWindow(ws, { id: newId('w'), type: 'page', noteId: n.id, ...(pos || freeSpot(ws, W, H)), ...extra });
  focusWin(ws, w);
  renderSidebar();
  return w;
}

/* ---------- old sessions: every Claude Code session on this Mac ---------- */
let SESS = null, sessLoading = null, sessAll = false, dragSession = null;
function loadSessions() {
  if (sessLoading) return sessLoading;
  sessLoading = flow.sessions.list().then((list) => {
    SESS = Array.isArray(list) ? list : [];
    sessLoading = null;
    if (q.value.trim()) renderSidebar();
  }, (err) => {
    sessLoading = null;
    console.error('could not read the old sessions', err);
    toast('could not read the old sessions', 4000);
  });
  return sessLoading;
}
function openSessionIds() {
  const ids = new Set();
  WS.forEach((ws) => [...ws.windows, ...ws.closed].forEach((w) => { if (w.sessionId) ids.add(w.sessionId); }));
  return ids;
}
function ago(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  const d = new Date(ms);
  const m = d.toLocaleString('en-US', { month: 'short' });
  return d.getFullYear() === new Date().getFullYear() ? `${m} ${d.getDate()}` : `${m} ${d.getDate()} ${d.getFullYear()}`;
}
/* at: where a session dragged from the sidebar is let go (the drop handler): the window's corner, and at.hand, the
   point held. It takes the open space there and covers no window, as a dock drop does (nav.placeRoom). */
function openSession(sid, at) {
  const s = SESS && SESS.find((x) => x.id === sid);
  if (!s) return null;
  if (s.resumable === false) { toast(`${s.title || 'that session'} cannot be resumed: its transcript is gone`, 5000); return null; }
  const ws = WS[cur];
  const note = window.FlowNotes.take(s.id);
  const w = addWindow(ws, { id: newId('w'), type: 'term', title: '', label: s.title || '', where: 'this Mac', note, noted: !!note, cmd: 'claude', cwd: tilde(s.cwd) || ws.folder, sessionId: s.id, resume: true, ...(at ? nav.placeRoom(ws, at, 34, 42, at.hand) : freeSpot(ws, 34, 42)) });
  q.value = '';
  sessAll = false;
  renderSidebar();
  return w;
}

/* ---------- pointer and clicks on windows ---------- */
function onPointerDown(e, ws, w) {
  if (dragging) return;
  bringFront(ws, w);
  if (e.button !== 0) return;
  if (e.target.closest('.rz')) { startResize(e, ws, w); return; }
  if (e.target.closest('[data-l]')) return;
  const r = WIN.get(w.id);
  const tb = e.target.closest('.tb');
  if (!r || tb !== r.tb || e.target.closest('button')) return;
  e.preventDefault();
  const boardBefore = boardSnap();
  const pointerId = e.pointerId, initialMode = ws.mode, initialSpace = curSpace(ws), viewKeys = ['pan', 'panY', 'zoom'];
  const snapView = (o, keys = viewKeys) => Object.fromEntries(viewKeys.map((key, i) => [key, { has: Object.hasOwn(o, keys[i]), value: o[keys[i]] }]));
  const putView = (o, at, keys = viewKeys) => viewKeys.forEach((key, i) => { if (at[key].has) o[keys[i]] = at[key].value; else delete o[keys[i]]; });
  const initialLiveView = snapView(ws);
  const initialMainView = snapView(ws, ['mainPan', 'mainPanY', 'mainZoom']);
  const initialZoneViews = new Map((ws.zones || []).map((zn) => [zn.id, snapView(zn)]));
  const initialViewOf = (sid) => sid === initialSpace ? initialLiveView : sid ? initialZoneViews.get(sid) : initialMainView;
  const restoreViews = () => {
    const currentSpace = curSpace(ws), currentView = initialViewOf(currentSpace);
    if (currentView) putView(ws, currentView);
    putView(ws, initialMainView, ['mainPan', 'mainPanY', 'mainZoom']);
    (ws.zones || []).forEach((zn) => { const at = initialZoneViews.get(zn.id); if (at) putView(zn, at); });
    if (currentSpace !== initialSpace) {
      if (initialSpace) { const zn = zoneById(ws, initialSpace); if (zn) putView(zn, initialLiveView); }
      else putView(ws, initialLiveView, ['mainPan', 'mainPanY', 'mainZoom']);
    }
  };
  const initialGeometry = ws.windows.map((win) => ({ win, x: win.x, y: win.y, w: win.w, h: win.h, hasMax: Object.hasOwn(win, 'max'), max: win.max ? { ...win.max } : win.max }));
  keysTo(ws, w, r);
  if (ws.mode !== 'float') { captureFloat(ws); ws.mode = 'float'; layout(ws); renderModes(); }
  let sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y, zf = nav.zoom(ws);
  let teamTarget = null, tabTarget = null, spaceTarget = null, moved = false, panned = 0, pannedY = 0, lx = sx, ly = sy, finished = false;
  const place = () => {
    w.x = ox + (((lx - sx) / zf + panned) / VW) * 100;
    w.y = oy + (((ly - sy) / zf + pannedY) / VH) * 100;
    apply(w, w);
  };
  setDragging(true);
  busy.add(w.id);
  r.el.classList.add('drag');
  if (e.isTrusted) tb.setPointerCapture(pointerId);
  const move = (ev) => {
    if (ev.pointerId !== pointerId) return;
    /* A press alone keeps a filled window's old size, so a double-click on its title can put it back. */
    if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
    moved = true;
    w.max = null;
    /* A pinch while the window is held zoomed around the pointer: go on from there at the new zoom. */
    if (nav.zoom(ws) !== zf) { sx = lx; sy = ly; ox = w.x; oy = w.y; panned = 0; pannedY = 0; zf = nav.zoom(ws); }
    lx = ev.clientX;
    ly = ev.clientY;
    place();
    feedEdgePan(ws, ev.clientX, ev.clientY, (d, dy) => { panned += d; pannedY += dy; place(); });
    const t = w.type === 'term' && window.FlowTeams ? window.FlowTeams.teamAt(ws, ev.clientX, ev.clientY, w) : null;
    if (t !== teamTarget) { if (teamTarget && elOf(teamTarget)) elOf(teamTarget).classList.remove('dropon'); teamTarget = t; if (t) elOf(t).classList.add('dropon'); }
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const tabEl = under && !SOLO ? under.closest('.sp[data-i]') : null;
    const target = tabEl && +tabEl.dataset.i !== WS.indexOf(ws) ? tabEl : null;
    if (target !== tabTarget) { if (tabTarget) tabTarget.classList.remove('dropon'); tabTarget = target; if (target) target.classList.add('dropon'); }
    const zrow = under && !SOLO ? under.closest('#sblist .tr[data-act^="zone|"]') : null;
    const home = tabEl && !target && curSpace(ws) ? tabEl : null;
    const sp = home || (zrow && zrow.dataset.act.slice(5) !== curSpace(ws) ? zrow : null);
    if (sp !== spaceTarget) { if (spaceTarget) spaceTarget.classList.remove('dropon'); spaceTarget = sp; if (sp) sp.classList.add('dropon'); }
    if (window.FlowSidebar) window.FlowSidebar.windowDrag(ws, w, under);
  };
  const clearTargets = () => {
    if (tabTarget) tabTarget.classList.remove('dropon');
    if (spaceTarget) spaceTarget.classList.remove('dropon');
    if (teamTarget && elOf(teamTarget)) elOf(teamTarget).classList.remove('dropon');
    if (window.FlowSidebar && window.FlowSidebar.windowCancel) window.FlowSidebar.windowCancel();
  };
  const finish = (commit) => {
    if (finished) return;
    // a window dropped on a team joins its tmux panes, which the board cannot put back
    if (commit && teamTarget) finishNow(commit);
    else board(() => finishNow(commit), boardBefore);
  };
  const finishNow = (commit) => {
    finished = true;
    stopEdgePan(ws);
    tb.removeEventListener('pointermove', move);
    tb.removeEventListener('pointerup', up);
    tb.removeEventListener('pointercancel', cancel);
    tb.removeEventListener('lostpointercapture', cancel);
    window.removeEventListener('blur', blur);
    if (tb.hasPointerCapture && tb.hasPointerCapture(pointerId)) tb.releasePointerCapture(pointerId);
    r.el.classList.remove('drag');
    setDragging(false);
    busy.delete(w.id);
    if (!commit) {
      clearTargets();
      initialGeometry.forEach((at) => {
        Object.assign(at.win, { x: at.x, y: at.y, w: at.w, h: at.h });
        if (at.hasMax) at.win.max = at.max ? { ...at.max } : at.max;
        else delete at.win.max;
      });
      ws.mode = initialMode;
      restoreViews();
      layout(ws);
      restoreViews();
      renderModes();
      renderSidebar();
      save();
      return;
    }
    if (window.FlowSidebar && window.FlowSidebar.windowDrop(ws, w)) { w.x = ox; w.y = oy; apply(w, w); sizeCanvas(ws); save(); return; }
    if (tabTarget) { tabTarget.classList.remove('dropon'); w.x = ox; w.y = oy; moveWindow(ws, w, WS[+tabTarget.dataset.i]); return; }
    if (spaceTarget) { const t = spaceTarget; t.classList.remove('dropon'); w.x = ox; w.y = oy; moveToSpace(ws, w, t.classList.contains('sp') ? null : t.dataset.act.slice(5)); return; }
    if (teamTarget) { const t = teamTarget; if (elOf(t)) elOf(t).classList.remove('dropon'); window.FlowTeams.dropOnTeam(ws, w, t); return; }
    if (moved) keepSpaceOrigin(ws);
    sizeCanvas(ws);
    renderSidebar();
    save();
  };
  const up = (ev) => { if (ev.pointerId === pointerId) finish(true); };
  const cancel = (ev) => { if (ev.pointerId === pointerId) finish(false); };
  const blur = () => finish(false);
  tb.addEventListener('pointermove', move);
  tb.addEventListener('pointerup', up);
  tb.addEventListener('pointercancel', cancel);
  tb.addEventListener('lostpointercapture', cancel);
  window.addEventListener('blur', blur);
}
function startResize(e, ws, w) {
  e.preventDefault();
  e.stopPropagation();
  const handle = e.target.closest('.rz');
  const r = WIN.get(w.id), side = handle.dataset.rz || 'se';
  let sx = e.clientX, sy = e.clientY, o = { x: w.x, y: w.y, w: w.w, h: w.h };
  const o0 = { ...o }, boardBefore = boardSnap();
  if (ws.mode !== 'float') { captureFloat(ws); ws.mode = 'float'; layout(ws); renderModes(); }
  setDragging(true);
  if (window.FlowTerm && window.FlowTerm.hold) window.FlowTerm.hold(true);
  busy.add(w.id);
  r.el.classList.add('drag');
  if (e.isTrusted) handle.setPointerCapture(e.pointerId);
  let zf = nav.zoom(ws), lx = sx, ly = sy;
  const move = (ev) => {
    if (nav.zoom(ws) !== zf) { sx = lx; sy = ly; o = { x: w.x, y: w.y, w: w.w, h: w.h }; zf = nav.zoom(ws); }
    lx = ev.clientX;
    ly = ev.clientY;
    const dx = ((ev.clientX - sx) / zf / VW) * 100, dy = ((ev.clientY - sy) / zf / VH) * 100;
    // a left or top grip moves that edge only, and no further than a title-bar drag can take the window
    const W = Math.max(16, side.includes('e') ? o.w + dx : side.includes('w') ? Math.min(o.w - dx, o.x + o.w) : o.w);
    const H = Math.max(16, side.includes('s') ? o.h + dy : side.includes('n') ? Math.min(o.h - dy, o.y + o.h - 4.5) : o.h);
    resizeTo(ws, w, W, H, side.includes('w') ? o.x + o.w - W : o.x, side.includes('n') ? o.y + o.h - H : o.y);
  };
  const up = () => board(upNow, boardBefore);
  const upNow = () => {
    setDragging(false);
    if (window.FlowTerm && window.FlowTerm.hold) window.FlowTerm.hold(false);
    busy.delete(w.id);
    r.el.classList.remove('drag');
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    // let go: what the window now covers makes way (layout's clear); a press that resized nothing moves nothing
    if (w.x !== o0.x || w.y !== o0.y || w.w !== o0.w || w.h !== o0.h) nav.clear(ws, w, false, o0);
    sizeCanvas(ws);
    fitSoon(60);
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}
function onClick(e, ws, w) {
  const r = WIN.get(w.id);
  if (!r) return;
  const l = e.target.closest('[data-l]');
  if (l && l.closest('.tb') === r.tb) {
    if (l.dataset.l === 'close') closeAsked(ws, w);
    else if (l.dataset.l === 'park') park(ws, w);
    else toggleMax(ws, w);
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act || act.closest('.tb') !== r.tb) return;
  if (act.dataset.act === 'note') window.FlowNotes.toggle(ws, w);
}


/* ---------- sidebar: src/sidebar.js draws it (FlowSidebar, mounted in init) ---------- */
function renderSidebar() {
  if (window.FlowSidebar) window.FlowSidebar.render();
}
function toggleSidebar(force) {
  const h = typeof force === 'boolean' ? force : !sbHidden();
  setSbHidden(h);
  sb.classList.toggle('hide', h);
  fitSoon(360);
  save();
}
function openSearch() {
  if (sbHidden()) toggleSidebar(false);
  q.focus();
  q.select();
  loadSessions();
}
async function pickFolder(ws = WS[cur]) {
  const p = await flow.pickFolder(expand(ws.folder));
  if (!p) return;
  ws.folder = tilde(p);
  renderSidebar();
  save();
}

/* ---------- right-click on an agent: fork its conversation into a split beside it ---------- */
const canFork = (w) => w.type === 'term' && w.cmd === 'claude' && !!w.sessionId && !w.attach;
/* Whether a session on this Mac has a conversation to fork; says why not when it has none. */
async function hasConversation(sid, title) {
  let has;
  try {
    has = await flow.sessions.has(sid);
  } catch (err) {
    console.error(`could not read session ${sid} before forking`, err);
    toast('could not read the session, so nothing was forked', 4000);
    return false;
  }
  if (has) return true;
  toast(`nothing to fork yet: ${title} has no conversation yet`, 4000);
  return false;
}
async function forkWin(ws, w) {
  if (!w.host && !(await hasConversation(w.sessionId, termTitle(w)))) return null;
  const at = ws.windows.indexOf(w);
  if (at < 0 || !canFork(w)) return null;
  return board(() => forkNow(ws, w, at));
}
function forkNow(ws, w, at) {
  const title = termTitle(w);
  const f = { id: newId('w'), type: 'term', title: '', label: `fork of ${title}`, where: w.where || 'this Mac', note: '', cmd: 'claude', cwd: w.cwd, sessionId: uuid(), forkFrom: w.sessionId };
