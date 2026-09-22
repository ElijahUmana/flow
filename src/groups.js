/* FlowGroups: Miro-like groups of windows in a space (owner, Nov 7 02/12: "group a bunch of artifacts in one space",
   "like a miro board ... go to different things"). A group is a named frame drawn behind its windows: agent terminals,
   shells, notes and pages alike. It is kept as ws.groups [{ id, name, zone, ids }]; its frame is never stored, it is
   always the box around its windows, so it follows them wherever they go and needs no layout of its own.
   - Select: shift-click a window's title bar adds or removes it; a drag on bare board with shift held draws a box and
     selects every window it touches. Esc or a plain click on the board clears the selection.
   - Group: ⌘G with two or more selected (or "group" in a selected window's menu); ⇧⌘G or "ungroup" undoes it.
   - Move: dragging the group's name moves all its windows together; dragging one window's title bar still moves that
     window only, and the frame grows to follow.
   - Go: a click on the name flies to the group: the view glides until it fills the screen, never past 100%.
   - See all: ⇧1 (as in Figma and Miro) or "see whole workspace" in the board's menu glides out until every window and
     every group's name is in view, the owner's image 02-03; from there a click on a name flies in.
   - Rename: a double-click on the name while the group already fills the screen, or "rename group" in the menu.
   A window closed, sent to another space or workspace leaves its group; a group with fewer than two windows left goes. */
(() => {
'use strict';

const PAD = 1.4;      // % around the windows inside a frame
const LABEL_PX = 24;  // px of the name strip above the frame, at any zoom
const MARK = 'grp-';

function mount(h) {
  const selected = new Set();     // window ids
  const frames = new Map();       // group id -> { el, label, ws }
  let lastWs = null;

  const groupsOf = (ws) => (Array.isArray(ws.groups) ? ws.groups : (ws.groups = []));
  const here = (ws) => groupsOf(ws).filter((g) => (g.zone || null) === h.space(ws));
  const winsOf = (ws, g) => g.ids.map((id) => ws.windows.find((w) => w.id === id)).filter((w) => w && h.inSpace(ws, w) && !h.nav.away(ws, w));
  const groupOf = (ws, id) => groupsOf(ws).find((g) => g.ids.includes(id)) || null;
  const box = (ws, g) => {
    const gs = winsOf(ws, g).map((w) => h.geo(w));
    if (!gs.length) return null;
    const x0 = Math.min(...gs.map((r) => r.x)), y0 = Math.min(...gs.map((r) => r.y));
    const x1 = Math.max(...gs.map((r) => r.x + r.w)), y1 = Math.max(...gs.map((r) => r.y + r.h));
    return { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + 2 * PAD, h: y1 - y0 + 2 * PAD };
  };

  /* A group keeps only windows that are still open in its space; one left with under two windows goes. True when
     something changed, so the caller saves. */
  function prune(ws) {
    const list = groupsOf(ws);
    let changed = false;
    for (const g of [...list]) {
      const live = g.ids.filter((id) => { const w = ws.windows.find((o) => o.id === id); return w && (w.zone || null) === (g.zone || null); });
      if (live.length !== g.ids.length) { g.ids = live; changed = true; }
      if (live.length < 2) { list.splice(list.indexOf(g), 1); changed = true; }
    }
    return changed;
  }

  function paintSelection() {
    document.querySelectorAll('.win.gsel').forEach((el) => { if (!selected.has(el.dataset.id)) el.classList.remove('gsel'); });
    selected.forEach((id) => { const el = h.elOf({ id }); if (el) el.classList.add('gsel'); });
  }
  function clearSelection() {
    if (!selected.size) return;
    selected.clear();
    paintSelection();
  }

  /* Frames are drawn on the space's canvas, under its windows, in the canvas's own % coordinates, so they move, pan and
     zoom with the board for free. Only the name strip keeps its size on screen, as each window's title bar does far out. */
  function render() {
    const ws = h.current();
    if (!ws) return;
    if (ws !== lastWs) { clearSelection(); lastWs = ws; }
    if (prune(ws)) h.changed(ws);
    const c = h.canvas(ws), z = h.nav.zoom(ws), { vw, vh } = h.size();
    const want = new Set();
    for (const g of here(ws)) {
      const b = box(ws, g);
      if (!b || !c) continue;
      want.add(g.id);
      let f = frames.get(g.id);
      if (!f || f.el.parentElement !== c) {
        if (f) f.el.remove();
        const el = document.createElement('div');
        el.className = 'gframe';
        el.dataset.group = g.id;
        const label = document.createElement('div');
        label.className = 'glabel';
        el.appendChild(label);
        c.insertBefore(el, c.firstChild);
        f = { el, label, ws };
        frames.set(g.id, f);
        wire(f, g.id);
      }
      const k = 1 / Math.min(1, z), lh = LABEL_PX * k;
      Object.assign(f.el.style, { left: (b.x / 100) * vw + 'px', top: (b.y / 100) * vh + 'px', width: (b.w / 100) * vw + 'px', height: (b.h / 100) * vh + 'px' });
      Object.assign(f.label.style, { height: LABEL_PX + 'px', top: -lh + 'px', transform: `scale(${k})`, width: `${100 / k}%` });
      if (f.label.textContent !== g.name) f.label.textContent = g.name;
      f.el.classList.toggle('gsel', g.ids.every((id) => selected.has(id)) && selected.size === g.ids.length);
    }
    frames.forEach((f, id) => { if (!want.has(id)) { f.el.remove(); frames.delete(id); } });
  }

  /* The name strip: a click flies to the group (it fills the screen, never past 100%), the way a Miro frame's name does
     (owner, Nov 7 image 02-03); a drag moves every window of the group together; a double-click on a group already filling
     the screen renames it in place. */
  function wire(f, gid) {
    f.label.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const ws = h.current(), g = ws && groupsOf(ws).find((x) => x.id === gid);
      if (!g || f.label.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.detail >= 2) { if (h.fills(ws, box(ws, g))) rename(ws, g); return; }
      const wins = winsOf(ws, g), z = h.nav.zoom(ws), { vw, vh } = h.size();
      const start = wins.map((w) => ({ w, x: w.x, y: w.y }));
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      if (e.isTrusted) f.label.setPointerCapture(e.pointerId);
      h.busy(true);
      wins.forEach((w) => { const el = h.elOf(w); if (el) el.classList.add('drag'); });
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
        moved = true;
        const dx = ((ev.clientX - sx) / z / vw) * 100, dy = ((ev.clientY - sy) / z / vh) * 100;
        start.forEach((s) => { s.w.x = s.x + dx; s.w.y = s.y + dy; s.w.max = null; h.apply(s.w); });
        render();
      };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        f.label.removeEventListener('pointermove', move);
        f.label.removeEventListener('pointerup', up);
        f.label.removeEventListener('pointercancel', up);
        wins.forEach((w) => { const el = h.elOf(w); if (el) el.classList.remove('drag'); });
        h.busy(false);
        if (ev.type === 'pointercancel') { start.forEach((s) => { s.w.x = s.x; s.w.y = s.y; h.apply(s.w); }); render(); return; }
        if (moved) { h.settle(ws); h.changed(ws); return; }
        if (ev.detail < 2) goTo(ws, g);
      };
      f.label.addEventListener('pointermove', move);
      f.label.addEventListener('pointerup', up);
      f.label.addEventListener('pointercancel', up);
    });
  }

  /* Flies to the group: the view glides so it fills the screen. Already filling it, a click leaves the view alone. */
  function goTo(ws, g) {
    const b = box(ws, g);
    if (!b || h.fills(ws, b)) return;
    h.frame(ws, b);
  }
  /* The whole space at once (owner, Nov 7 image 02-03): every window and every group's name in view, never past 100%. */
  function seeAll(ws) {
    const gs = h.windows(ws).map((w) => h.geo(w));
    if (!gs.length) return false;
    const x0 = Math.min(...gs.map((r) => r.x)), y0 = Math.min(...gs.map((r) => r.y));
    const x1 = Math.max(...gs.map((r) => r.x + r.w)), y1 = Math.max(...gs.map((r) => r.y + r.h));
    // room above for the top group's name, which keeps its size on screen
    const lift = here(ws).length ? (LABEL_PX / h.size().vh) * 100 * 2 : 0;
    h.frame(ws, { x: x0 - PAD, y: y0 - PAD - lift, w: x1 - x0 + 2 * PAD, h: y1 - y0 + 2 * PAD + lift });
    return true;
