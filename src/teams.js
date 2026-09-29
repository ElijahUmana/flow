/* FlowTeams: Claude Code agent teams (BRIEF 3.0, Teams). app.js mounts it once with hooks into its model.
   A lead that runs inside Flow's tmux starts each teammate as a pane of its own window. Flow moves every teammate to a
   window of its own beside the team, in the team's space ("agent of the teams are ACTUALLY a different terminal
   winbdow being spawned up", cli-code-manager-live.md:75), and keeps the teammate's session id. After a Mac restart
   that window resumes the teammate's own conversation; the team link cannot come back (Claude Code 2.1.296 gives a
   resumed lead a new team), and the window says so. A terminal dropped on a team keeps its own window and record and
   sits beside the team, grouped with it, without becoming a teammate.
   This is Flow's one pane poller: only windows on screen are polled, so no tmux call and no ssh runs for a team
   nobody is looking at (BRIEF 3.0: the Mac stays light). term.js takes the lists through setPanes. */
(() => {
  'use strict';

  const POLL_MS = 1500;
  const SETTLE_MS = 3000;
  const SETTLE_TRIES = 10;

  let A = null;
  let locate, save, toast, addWindow, removeWindow, apply, sizeCanvas, focusWin, bringFront, besideSpot, toSpace, bottom;
  let geo, elOf, termTitle, splitTitle, renderTitle, onTermTitle, scheduleSidebar, renderSidebar, remoteOpts, newId;
  let tilde, setDragging, edgePan, keepSpaceOrigin, rectHas, inSpace, WIN, viewport;

  const PANES = new Map();     // window id -> its last flow.term.panes() list
  const paneErr = new Set();   // window ids whose last poll failed (logged once)
  const busy = new Set();      // polls and lookups in flight
  const locking = new Set();   // workspace ids accepting no new pane moves while existing ones settle
  const closing = new Set();   // workspace ids whose final close snapshot is coupled to shutdown
  const mutations = new Map(); // workspace id -> pane moves already in flight when closing began
  const notMate = new Map();   // `${team id} ${pane id}` -> the pane's command when it was not a teammate
  const slow = new Map();      // lookup key -> how many times in a row pty.js's ps timed out for it
  let warnedMate = false;
  /* On a loaded machine ps can take longer than pty.js waits for it: that lookup runs again (the next pane poll, the next
     settle), so it is no error. One that has timed out SLOW_TRIES times in a row is reported, once. */
  const SLOW_TRIES = 20;
  function failed(key, err, what) {
    if (!/timed out$/.test(String((err && err.message) || err))) {
      slow.delete(key);
      console.error(what, err);
      return;
    }
    const n = (slow.get(key) || 0) + 1;
    slow.set(key, n);
    if (n === SLOW_TRIES) console.error(`${what}: ps timed out ${n} times in a row`, err);
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const leadPane = (list) => list.reduce((a, b) => (b.index < a.index ? b : a));
  const isClosing = (ws) => !!(ws && closing.has(ws.id));
  const isBlocked = (ws) => !!(ws && (locking.has(ws.id) || closing.has(ws.id)));
  function trackMutation(ws, promise) {
    if (!ws) return promise;
    if (!mutations.has(ws.id)) mutations.set(ws.id, new Set());
    const set = mutations.get(ws.id);
    set.add(promise);
    promise.finally(() => {
      set.delete(promise);
      if (!set.size) mutations.delete(ws.id);
    }).catch(() => {});
    return promise;
  }

  function paneName(p) {
    return splitTitle(p.title || '').text || p.command || `pane ${p.index}`;
  }
  /* Panes still inside a team window, for the sidebar (a lead's own window, or teammates not moved out yet). */
  function members(w) {
    const list = PANES.get(w.id) || [];
    return list.length < 2 ? [] : list;
  }
  /* Where a new agent of this workspace runs: this Mac, or the VM when the workspace menu set ws.host (BRIEF 3.0). A VM
     folder is kept as typed ('~' when unset), so the VM expands it. In a sub-workspace with a folder of its own (zn.folder
     on this Mac, zn.hostFolder on the VM, files.js), it starts there. */
  const runsOn = (ws, zn) => (ws.host
    ? { host: ws.host, where: 'on the VM', cwd: (zn && zn.hostFolder) || ws.hostFolder || '~' }
    : { where: 'this Mac', cwd: (zn && zn.folder) || ws.folder });
  /* The workspace menu's folder and "runs on" rows (ux's FlowWsMenu). The VM is the owner's ssh host claude-agents,
     the host of the first-run VM windows. A VM folder is typed, since the Mac's picker cannot browse the VM; '' unsets
     it (the VM home). Changing where a workspace runs moves nothing that is already running. */
  const VM_HOST = 'claude-agents';
  function runsOnMenu(ws, pickFolder) {
    return {
      folder: ws.host ? ws.hostFolder || '~' : ws.folder,
      ...(ws.host
        ? { onFolderText: (text) => { if (text) ws.hostFolder = text; else delete ws.hostFolder; renderSidebar(); save(); } }
        : { onFolder: pickFolder }),
      runsOn: ws.host ? 'vm' : 'mac',
      onRunsOn: (where) => {
        if (where === 'vm') ws.host = VM_HOST;
        else delete ws.host;
        renderSidebar();
        save();
      },
    };
  }
  /* The few words a teammate window shows once its link to the lead is gone. */
  const label = (w) => (w.mate && w.mate.unlinked ? 'team link ended' : '');

  /* ---------- the one poller: windows on screen only ---------- */
  function onScreen(w) {
    const r = WIN.get(w.id);
    if (!r || !r.term || !r.vis || document.hidden || r.el.style.display === 'none') return false;
    const a = r.el.getBoundingClientRect(), b = viewport.getBoundingClientRect();
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }
  function poll() {
    const ws = A.WS[A.cur];
    if (!ws || isBlocked(ws)) return;
    ws.windows.forEach((w) => {
      if (!onScreen(w)) return;
      if (w.type === 'team' || w.attach || w.pollTitle) pollPanes(w.id);
      if (w.mate && !w.sessionId) findSession(w);
    });
  }
  function pollPanes(id) {
    if (busy.has(id)) return;
    const L = locate(id);
    if (!L || isBlocked(L.ws)) return;
    busy.add(id);
    window.flow.term.panes(id, remoteOpts(L.w)).then((got) => {
      const list = Array.isArray(got) ? got : [];
      const sig = (l) => JSON.stringify(l.map((p) => [p.paneId, p.index, p.title, p.command]));
      const was = PANES.get(id) || [];
      PANES.set(id, list);
      paneErr.delete(id);
      const r = WIN.get(id);
      if (r && r.term && r.term.setPanes) r.term.setPanes(list);
      if (sig(was) !== sig(list)) scheduleSidebar();
      const T = locate(id);
      if (!T || isClosing(T.ws) || !list.length) return;
      if (T.w.type === 'team') adopt(T.ws, T.w, list);
      /* A window on the VM's own tmux server (an attach window, or a pane taken out of one) gets no titles from it: a
         team takes its lead's pane title, any other window its active pane's. Sessions Flow makes on the VM run on
         Flow's socket there, whose conf passes titles on. */
      if (T.w.attach || T.w.pollTitle) {
        const p = T.w.type === 'team' ? leadPane(list) : list.find((x) => x.active) || list[0];
        /* the same rule as a terminal's own title: the CLI's name or a prompt line names nothing (term.js nameFrom) */
        if (p.title && window.FlowTerm.nameFrom(p.title)) onTermTitle(id, p.title);
      }
    }, (err) => {
      if (!paneErr.has(id)) { paneErr.add(id); console.warn(`could not list the panes of ${id}`, err); }
    }).finally(() => busy.delete(id));
  }

  /* ---------- teammates get windows of their own ---------- */
  /* Claude Code splits the pane first and starts the teammate in it a moment later, so a pane that is not a teammate
     yet is checked again once its command changes. */
  function adopt(ws, team, list) {
    if (isBlocked(ws)) return;
    /* An attach window shows a session Flow did not make (the VM's ccm): its layout stays as its owner keeps it, for
       every other client too. Only a pane the owner drags out leaves it. */
    if (list.length < 2 || team.attach) return;
    if (typeof window.flow.term.teammate !== 'function') {
      if (!warnedMate) { warnedMate = true; console.error('flow.term.teammate is missing (preload), so teammates stay as panes of their team'); }
      return;
    }
    const lead = leadPane(list);
    list.forEach((p) => {
      const key = `${team.id} ${p.paneId}`;
      if (p.paneId === lead.paneId || busy.has(key) || notMate.get(key) === p.command) return;
      busy.add(key);
      const move = window.flow.term.teammate(team.id, p.paneId, remoteOpts(team)).then((mate) => {
        slow.delete(key);
        const L = locate(team.id);
        if (!L || isClosing(L.ws)) return null;
        if (!mate) { notMate.set(key, p.command); return null; }
        return breakOut(L.ws, L.w, p, null, null, mate);
      }).catch((err) => failed(key, err, `could not check pane ${p.paneId} of ${team.id} for a teammate`))
        .finally(() => busy.delete(key));
      trackMutation(ws, move);
    });
  }
  /* Moves one pane of a team into a window of its own: a teammate (mate set) goes beside the team in its space, a pane
     dragged out goes where it was dropped. */
  async function breakOut(ws, team, pane, cx, cy, mate) {
    const nid = newId('w');
    const name = mate ? mate.name : paneName(pane);
    const p = cx == null ? null : toSpace(ws, cx, cy);
    const sid = team.zone || null;
    let res;
    try {
      res = await window.flow.term.breakPane(team.id, pane.paneId, nid);
    } catch (err) {
      res = { ok: false, error: err && err.message };
    }
    if (!res || !res.ok) {
      const why = (res && res.error) || 'no reason given';
      if (cx != null) toast(`could not take ${name} out: ${why}`, 5000);
      else console.error(`could not move teammate ${name} of ${termTitle(team)} to its own window: ${why}`);
      return null;
    }
    /* nav zooms and pans each space, so the drop point was captured in the space's own % before the async pane move. */
    const at = p ? { w: 30, h: 38, x: p.x - 10, y: p.y - 4 } : mateSpot(ws, team);
    const w = addWindow(ws, {
      id: nid, type: 'term', title: name, where: team.host ? team.where : 'this Mac', host: team.host || undefined, note: '',
      cmd: 'claude', cwd: team.host ? pane.cwd : tilde(pane.cwd) || ws.folder,
      ...(team.attach || team.pollTitle ? { pollTitle: true } : {}),
      ...(mate ? { sessionId: mate.sessionId || undefined, mate: { name: mate.name, team: mate.team, color: mate.color || '', lead: team.id, paneId: pane.paneId } } : {}),
      ...at,
    }, null, sid);
    if (p) keepSpaceOrigin(ws, sid);
    if (w.mate && !w.sessionId) settle(w.id, SETTLE_TRIES);
    pollPanes(team.id);
    renderSidebar();
    return w;
  }
  /* Beside the team, then beside the teammate placed last, in the team's space. */
  function mateSpot(ws, team) {
    const mates = ws.windows.filter((o) => inSpace(ws, o) && ((o.mate && o.mate.lead === team.id) || o.group === team.id));
    return besideSpot(ws, mates.length ? mates[mates.length - 1] : team);
  }
  /* A teammate writes its transcript once it has handled its first message, so its session id can come a little after
     its window. Right after the move it is looked up a few times, on screen or not, so the window can resume its own
     conversation after a restart; later only while on screen. */
  function settle(id, tries) {
    setTimeout(() => {
      const L = locate(id);
      if (!L || L.w.sessionId || !L.w.mate) return;
      lookup(L.w).then((found) => { if (!found && tries > 1) settle(id, tries - 1); });
    }, SETTLE_MS);
  }
  function findSession(w) {
    if (!busy.has(w.id + ' sid')) lookup(w);
  }
  function lookup(w) {
    if (typeof window.flow.term.teammate !== 'function') return Promise.resolve(false);
    const L = locate(w.id);
    if (!L || isBlocked(L.ws)) return Promise.resolve(false);
    const key = w.id + ' sid';
    busy.add(key);
    const found = window.flow.term.teammate(w.id, w.mate.paneId, remoteOpts(w)).then((mate) => {
      slow.delete(key);
      const now = locate(w.id);
      if (!now || isClosing(now.ws)) return false;
      if (!mate || !mate.sessionId) return false;
      if (!w.sessionId) { w.sessionId = mate.sessionId; save(); }
      return true;
    }, (err) => {
      failed(key, err, `could not find the session of teammate ${termTitle(w)}`);
      return false;
    }).finally(() => busy.delete(key));
    return trackMutation(L.ws, found);
  }

  /* ---------- hooks app.js calls ---------- */
  /* A teammate window whose own session had to be started again (after a Mac restart, or reopened after its lead ended)
     has lost its team link: it resumes its own conversation and says the link ended. */
  function onOpened(id, res) {
    const L = locate(id);
    if (!L || isClosing(L.ws) || !res || !res.ok) return;
    if (L.w.mate && res.created && !L.w.mate.unlinked) {
      L.w.mate.unlinked = true;
      if (!L.w.sessionId) L.w.title = '';
      renderTitle(L.ws, L.w);
      scheduleSidebar();
      save();
    }
    if (L.w.type === 'team') pollPanes(id);
  }
  /* A lead that ends takes its teammates with it (Claude Code kills their panes): their windows go to the closed list,
     where each one opens again with its own conversation. */
  function onExit(id) {
    const L = locate(id);
    if (!L || isClosing(L.ws) || !L.w.mate || !L.ws.windows.includes(L.w)) return;
    const { ws, w } = L;
    removeWindow(ws, w);
    w.max = null;
    ws.closed.push(w);
    renderSidebar();
    save();
  }
  const teamAt = (ws, x, y, except) => ws.windows.find((o) => o.type === 'team' && o !== except && inSpace(ws, o) && elOf(o) && rectHas(elOf(o).getBoundingClientRect(), x, y));
  /* A terminal dropped on a team keeps its own window and record and moves beside the team, grouped with it. It does
     not become a teammate: only the lead's own spawn makes one, and Flow never types into an agent. */
  function dropOnTeam(ws, w, team) {
    if (isBlocked(ws)) return;
    w.group = team.id;
    w.max = null;
    Object.assign(w, dropSpot(ws, team, w));
    apply(w, w);
    sizeCanvas(ws);
    focusWin(ws, w);
    renderSidebar();
    save();
  }
  /* The nearest free place around the team (right, below, left) at the window's own size, then below it at the height
     left above nav's layout bottom, else after the team's last member in its row. */
  function dropSpot(ws, team, w) {
    const g = geo(team), floor = bottom(), gap = 1.2;
    const others = ws.windows.filter((o) => o !== w && inSpace(ws, o));
    const free = (x, y, ww, hh) => !others.some((o) => {
      const q = geo(o);
      return x < q.x + q.w + gap && q.x < x + ww + gap && y < q.y + q.h + gap && q.y < y + hh + gap;
    });
    const W = w.w, H = Math.min(w.h, floor - 6.6);
    for (const t of [{ x: g.x + g.w + 1.3, y: g.y }, { x: g.x, y: g.y + g.h + 1.3 }, { x: g.x - W - 1.3, y: g.y }]) {
      if (t.x >= 0 && t.y >= 5.4 && t.y + H <= floor && free(t.x, t.y, W, H)) return { x: t.x, y: t.y, w: W, h: H };
    }
    const under = { x: g.x, y: g.y + g.h + 1.3, w: W, h: floor - (g.y + g.h + 1.3) };
    if (under.h >= 18 && free(under.x, under.y, under.w, under.h)) return under;
    const row = others.filter((o) => (o.mate && o.mate.lead === team.id) || o.group === team.id).map(geo);
    let x = Math.max(g.x + g.w, ...row.map((q) => q.x + q.w)) + 1.3;
    const y = clamp(g.y, 5.4, floor - H);
    for (let i = 0; i < 400 && !free(x, y, W, H); i++) x += 1.3;
    return { x, y, w: W, h: H };
  }
  /* A pane's handle dragged out of its team window and dropped outside it. */
  function startPaneDrag(teamId, pane, e) {
    const L = locate(teamId);
    if (!L || !pane || document.body.classList.contains('busy') || isBlocked(L.ws)) return;
    const { ws, w: team } = L;
    const list = PANES.get(teamId) || [];
    const lead = list.length ? leadPane(list) : null;
    if ((lead && lead.paneId === pane.paneId) || (!lead && pane.index === 0)) { toast('the lead stays with its team.'); return; }
    if (e && e.preventDefault) e.preventDefault();
    bringFront(ws, team);
    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    ghost.textContent = `${paneName(pane)}: drop it outside the team`;
    document.body.appendChild(ghost);
    const target = e.target, pointerId = e.pointerId;
    let lx = e.clientX, ly = e.clientY, finished = false;
    const place = (ev) => {
      if (ev.pointerId !== pointerId) return;
      lx = ev.clientX;
      ly = ev.clientY;
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 10 + 'px';
      edgePan(ws, ev.clientX, ev.clientY, () => { ghost.style.left = lx + 12 + 'px'; ghost.style.top = ly + 10 + 'px'; });
    };
    place(e);
    setDragging(true);
    if (e.isTrusted && target && target.setPointerCapture) target.setPointerCapture(pointerId);
    const finish = (commit, ev) => {
      if (finished) return;
      finished = true;
      edgePan(ws, null);
      window.removeEventListener('pointermove', place, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', blur);
      if (target && target.removeEventListener) target.removeEventListener('lostpointercapture', cancel);
      if (target && target.hasPointerCapture && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      ghost.remove();
      setDragging(false);
      if (!commit || !ev || isBlocked(ws)) return;
      const tel = elOf(team);
      if (tel && !rectHas(tel.getBoundingClientRect(), ev.clientX, ev.clientY)) trackMutation(ws, breakOut(ws, team, pane, ev.clientX, ev.clientY, null));
    };
    const up = (ev) => { if (ev.pointerId === pointerId) finish(true, ev); };
    const cancel = (ev) => { if (ev.pointerId === pointerId) finish(false); };
    const blur = () => finish(false);
    window.addEventListener('pointermove', place, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', blur);
    if (target && target.addEventListener) target.addEventListener('lostpointercapture', cancel);
  }

  const memberRecordId = (used, teamId, pane) => {
    const suffix = String(pane.sessionId || pane.paneId).replace(/[^A-Za-z0-9_-]/g, '').slice(-18) || 'member';
    let id = `${teamId}-member-${suffix}`, n = 2;
    while (used.has(id)) id = `${teamId}-member-${suffix}-${n++}`;
    used.add(id);
    return id;
  };

  /* A team still holding teammate panes is one atomic shutdown: capture every pane conversation before the question, so
     undo can resume the lead in the team window and each teammate as its own unlinked closed record. Any local team with
     an incomplete snapshot blocks closure; an attached VM team becomes a disabled VM choice. Re-read before kill. */
  async function closeSnapshot(ws) {
    const choices = [], restore = [], blocked = [];
    const terms = [...ws.windows, ...ws.closed].filter((w) => w.type === 'term' || w.type === 'team');
    const usedIds = new Set([...ws.windows, ...ws.closed].map((w) => w.id));
    for (const w of terms) {
      const remote = !!w.host;
      const choice = remote ? { id: w.id, type: w.type, title: termTitle(w), host: w.host, attach: w.attach || '', cmd: w.cmd || '',
        cwd: w.cwd || '', sessionId: w.sessionId || '', mate: w.mate ? JSON.parse(JSON.stringify(w.mate)) : null, canShutdown: true } : null;
      if (w.type === 'team' || (remote && w.attach)) {
        let inventory = null, inventoryError = null;
        try {
          inventory = await window.flow.term.teamSessions(w.id, remoteOpts(w));
        } catch (err) {
          inventoryError = err;
        }
        const legacy = Array.isArray(inventory);
        const panes = legacy ? inventory : inventory && Array.isArray(inventory.panes) ? inventory.panes : [];
        const exists = legacy ? panes.length > 0 : !!(inventory && inventory.exists === true);
        if (!inventoryError && (!inventory || (!legacy && inventory.exists !== true && inventory.exists !== false))) inventoryError = new Error('invalid team inventory');
        if (!inventoryError && exists && !panes.length) inventoryError = new Error('the running team returned an empty pane inventory');
        if (inventoryError) {
          const reason = `could not verify every pane: ${(inventoryError && inventoryError.message) || inventoryError}`;
          if (choice) { choice.canShutdown = false; choice.reason = reason; choice.panes = []; }
          else blocked.push({ id: w.id, title: termTitle(w), reason });
        } else if (exists) {
          const lead = w.type === 'team' ? (panes.length ? leadPane(panes) : null)
            : panes.find((p) => p.windowActive && p.active) || panes.find((p) => p.active) || (panes.length ? leadPane(panes) : null);
          const complete = !!lead && panes.every((p) => p && p.paneId && p.sessionId && p.cwd)
            && new Set(panes.map((p) => p.paneId)).size === panes.length
            && new Set(panes.map((p) => p.sessionId)).size === panes.length;
          if (choice) {
            choice.canShutdown = complete;
            choice.panes = panes;
            if (!complete) choice.reason = 'not every pane has a distinct conversation to resume';
          } else if (!complete) blocked.push({ id: w.id, title: termTitle(w), reason: 'not every pane has a distinct conversation to resume' });
          if (complete) {
            restore.push({
              teamId: w.id,
              signature: panes.map((p) => ({ paneId: p.paneId, panePid: p.panePid, sessionTmuxId: p.sessionTmuxId,
                windowId: p.windowId, windowIndex: p.windowIndex, windowActive: !!p.windowActive, windowLayout: p.windowLayout || '',
                windowName: p.windowName || '', windowWidth: p.windowWidth, windowHeight: p.windowHeight, index: p.index, active: !!p.active, left: p.left, top: p.top, width: p.width, height: p.height, cwd: p.cwd,
                command: p.command || '', title: p.title || '', sessionId: p.sessionId, mate: p.mate ? JSON.parse(JSON.stringify(p.mate)) : null })),
              leadSessionId: lead.sessionId,
              members: panes.filter((p) => p !== lead).map((p) => ({
                id: memberRecordId(usedIds, w.id, p), paneId: p.paneId, zone: w.zone || null,
                title: (p.mate && p.mate.name) || paneName(p), cwd: p.cwd, sessionId: p.sessionId,
                mate: p.mate ? { name: p.mate.name, team: p.mate.team, color: p.mate.color || '', lead: w.id, paneId: p.paneId, unlinked: true } : null,
              })),
            });
          }
        }
      }
      if (choice) choices.push(choice);
    }
    return { choices, restore, blocked };
  }

  async function beginClose(ws) {
    if (!ws || locking.has(ws.id) || closing.has(ws.id)) return false;
    locking.add(ws.id);
    try {
      for (;;) {
        const pending = [...(mutations.get(ws.id) || [])];
        if (!pending.length) break;
        await Promise.allSettled(pending);
      }
      closing.add(ws.id);
      return true;
    } finally {
      locking.delete(ws.id);
    }
  }
  function endClose(ws) {
    if (ws) { locking.delete(ws.id); closing.delete(ws.id); }
  }

  function mount(app) {
    A = app;
    ({ locate, save, toast, addWindow, removeWindow, apply, sizeCanvas, focusWin, bringFront, besideSpot, toSpace, bottom } = app);
    ({ geo, elOf, termTitle, splitTitle, renderTitle, onTermTitle, scheduleSidebar, renderSidebar, remoteOpts, newId } = app);
    ({ tilde, setDragging, edgePan, keepSpaceOrigin, rectHas, inSpace, WIN } = app);
    ({ viewport } = app.els);
    setInterval(poll, POLL_MS);
  }

  window.FlowTeams = { mount, onOpened, onExit, teamAt, dropOnTeam, startPaneDrag, members, paneName, label, pollPanes, runsOn, runsOnMenu, closeSnapshot, beginClose, endClose };
})();




