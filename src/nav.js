/* FlowNav: moving around a workspace and laying windows out in it (BRIEF 3.0, nav). app.js mounts it once with hooks
   into its model, where every sub-workspace is a space of its own (w.zone; ws.at is the space on screen). Each space
   keeps its own pan and zoom: the space on screen in ws.pan, ws.panY and ws.zoom; a space off screen in its zone
   (zn.pan, zn.panY, zn.zoom) or, for the main space, in ws.mainPan, ws.mainPanY and ws.mainZoom. Pans are % of the
   view at zoom 1 (pan of its width, panY of its height), the unit of window positions, so a space shows the same part
   of itself in a window of any size; window positions are relative to their space.
   Drag the empty desktop to pan; let go while moving and it glides on and slows to a stop. The trackpad, the owner's
   finger map (MAC_NOTES 60): two fingers in any direction move around the space, steadied, and never leave it; three
   fingers sideways step through the spaces of the workspace; four switch workspace; a three-finger pinch zooms the
   space around the fingers; a two-finger pinch zooms only the window under them (its page, note or terminal). */
(() => {
  'use strict';

  /* src/guest-preload.js repeats GAP_MS and DECIDE_PX to thin out a page's wheel events: change them together. */
  const GAP_MS = 220;        // a wheel gesture ends after this long without an event, by event time
  const DECIDE_PX = 4;       // travel that decides a gesture's axis
  const FLICK = 1;           // px/ms on screen: a swipe let go this fast, not pulled back, goes on to the next space
  const SWIPE_END_MS = 140;  // a swipe with no step for this long (plus how late its steps have come) has been let go
  const SWIPE_RUB = 90;      // px: the most a swipe pulls the first or last space
  const DYING_MS = 40;       // a flick slowing to nothing this long without coming back was let go
  const AXIS = 2.5;          // a two-finger pan this much more along one axis than the other keeps to that axis
  const TWO_PX = 24;         // two fingers that moved this far just before macOS's swipe made it (01/14)
  const WS_FINGERS = 4;      // fingers that move the workspaces; three move the spaces of one
  const FLING_DECAY_SLOW = 0.995, FLING_DECAY_FAST = 0.988;
  const FLING_MAX = 6;
  const FLING_END = 0.05;
  const VEL_MS = 50;
  const VEL_MIN_MS = 8;
  const STILL_MS = 80;       // a release this long after the last changed sample stays exactly placed; no glide
  const ZMAX = 2.5;
  const FAR = 0.05;          // the furthest out, on every workspace
  const HOLD = Math.log(1.12);
  const PINCH_START_MS = 400; // how far back a pinch's first event looks for its third finger
  const TITLED = 0.4;        // further out (its own bar under 12 px on screen), each window's title bar and resize corner
                             // are drawn at their 100% size; above it a window's own bar covers none of its rows
  const TOP = 6.6, SIDE = 1.2, BOTTOM_PX = 12;
  const EDGE_PX = 40;        // a dragged window this close to a side of the view pans its space
  const EDGE_HIT = 24;       // px of bare desktop along each edge of the view where a double-click makes a view of room,
                             // the outermost px included, as for the dock and the overview
  const ADD = 100;           // % a double-click at a side adds: one view at actual size, at any zoom
  const ATTACH = 2.5;        // windows this close (% of the view) sit against each other and make way together
  const GAP_X = 1.2, GAP_Y = 1.8; // the gaps windows keep beside and under each other, in %
  const DBL_MS = 500;        // a second press this soon after a click on the desktop, in the same place, is a double-click
  const MIN_W = 300, MIN_H = 160; // px at actual size: the smallest window still of use (as splitRect in app.js)
  const NUDGE = 0.15;         // of its own size each way: how far a window made at a point may move from it before others make way
  const PAGE_W = 240;        // px: a page split side by side may be this narrow (lead, Nov 2 13:2x); it shows its narrow layout

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* A space's view as kept on whatever holds it (the workspace for the space on screen). */
  const viewOf = (o) => ({ pan: (o && o.pan) || 0, panY: (o && o.panY) || 0, zoom: (o && o.zoom) || 1 });

  /* Can something between the target and the desktop scroll sideways in this direction? */
  function scrollsX(target, dir, stop) {
    for (let el = target; el && el !== stop && el.nodeType === 1; el = el.parentElement) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
      if (!field && !/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowX)) continue;
      if (dir > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
    }
    return false;
  }

  function mount(h) {
    const vp = h.viewport;
    let fling = null, rubber = 0, gest = null, pinchTimer = 0, edgeLoop = null, grab = null, pinching = null;
    const size = () => h.size();
    const inSpace = (w, sid) => (w.zone || null) === (sid || null);
    const zoneOf = (ws, sid) => (sid && (ws.zones || []).find((zn) => zn.id === sid)) || null;

    /* ---------- views ---------- */
    /* Kept in % of the view, worked with in px at zoom 1 of this window. */
    const toPx = (p, d) => ((p || 0) / 100) * d, toPct = (x, d) => (x / d) * 100;
    const view = (ws) => { const { vw, vh } = size(); return { x: toPx(ws.pan, vw), y: toPx(ws.panY, vh), z: ws.zoom || 1 }; };
    /* A space's view wherever it is kept: on the workspace when it is on screen, else in its zone or ws.main*. */
    function viewIn(ws, sid) {
      if ((sid || null) === h.space(ws)) return view(ws);
      const zn = zoneOf(ws, sid), { vw, vh } = size();
      return zn ? { x: toPx(zn.pan, vw), y: toPx(zn.panY, vh), z: zn.zoom || 1 } : { x: toPx(ws.mainPan, vw), y: toPx(ws.mainPanY, vh), z: ws.mainZoom || 1 };
    }
    /* showSpace calls this as it changes ws.at: the view of the space it leaves is kept, the one it goes to comes back. */
    function swap(ws, from, to) {
      const fz = zoneOf(ws, from), tz = zoneOf(ws, to);
      if (fz) Object.assign(fz, { pan: ws.pan || 0, panY: ws.panY || 0, zoom: ws.zoom || 1 });
      else Object.assign(ws, { mainPan: ws.pan || 0, mainPanY: ws.panY || 0, mainZoom: ws.zoom || 1 });
      Object.assign(ws, viewOf(tz || { pan: ws.mainPan, panY: ws.mainPanY, zoom: ws.mainZoom }));
    }
    /* Pans saved before they were kept in % were CSS px at zoom 1 of the window that saved them: converted once, with
       this window's size, and marked (show marks a workspace made since). recover counts them, so the main window saves
       them at its start. Those builds never took a pop-out's view back when it closed, so its popView is marked old:
       takeBack drops it, and a pop-out still open opens at it as before. */
    function toPercent(ws) {
      if (ws.panUnit === '%') return false;
      const { vw, vh } = size();
      const conv = (o, kx, ky) => { if (!o) return; if (o[kx]) o[kx] = toPct(o[kx], vw); if (o[ky]) o[ky] = toPct(o[ky], vh); };
      conv(ws, 'pan', 'panY');
      conv(ws, 'mainPan', 'mainPanY');
      [ws, ...(ws.zones || [])].forEach((ho) => {
        if (ho !== ws) conv(ho, 'pan', 'panY');
        if (ho.popView) { conv(ho.popView, 'pan', 'panY'); ho.popView.old = true; }
      });
      ws.panUnit = '%';
      return true;
    }
    const converted = h.workspaces().filter(toPercent).length;

    /* ---------- geometry of the space on screen ---------- */
    /* The left start of what is in a space, in % (a window's own space when one is given); 0 when it is empty. */
    function contentStart(ws, except, sid) {
      const s = sid !== undefined ? sid : except ? except.zone || null : h.space(ws), windows = ws.windows.filter((w) => w !== except && inSpace(w, s));
      return windows.length ? Math.min(...windows.map((w) => h.geo(w).x)) : 0;
    }
    /* The right end of what is in a space, in % (a window's own space when one is given). */
    function contentEnd(ws, except, sid) {
      const s = sid !== undefined ? sid : except ? except.zone || null : h.space(ws);
      return Math.max(0, ...ws.windows.filter((w) => w !== except && inSpace(w, s)).map((w) => { const g = h.geo(w); return g.x + g.w; }));
    }
    /* Room added by a double-click at a side of a space (owner, 21:50 and 22:50) is kept on what holds the space, its
       zone or, for the main space, the workspace: roomRight, where it ends at the right, and roomLeft, how much was
       added before the first window, both in %. */
    const holderOf = (ws, sid) => zoneOf(ws, sid) || ws;
    /* The right end of a space in %: its windows, at least one view, and room added at its right. */
    const spaceEnd = (ws, sid = h.space(ws)) => Math.max(100, contentEnd(ws, null, sid) + SIDE, holderOf(ws, sid).roomRight || 0);
    const here = (ws, sid = h.space(ws)) => ws.windows.filter((w) => inSpace(w, sid));
    /* The bottom of a space in %: one view, or lower where a window reaches below it (room opened under a window, or a
       window carried down past the bottom). */
    function spaceBottom(ws, sid = h.space(ws)) {
      return Math.max(100, ...here(ws, sid).map((w) => { const g = h.geo(w); return g.y + g.h + 100 - bottom(); }));
    }
    /* Zooming out goes on to FAR on every workspace (owner, Nov 1 22:28: "zoom progressive out the more i do"). */
    const zmin = () => FAR;
    /* quick: only the canvas moves (a drag's or a glide's frame); what depends on where the view is, the bars and the
       glows, follows when it stops (settle). */
    function show(ws, animate, quick) {
      const c = h.canvas(ws);
      if (!c) return;
      ws.panUnit = '%';
      const v = view(ws);
      c.style.transformOrigin = '0 0';
      c.classList.toggle('anim', !!animate);
      c.style.transform = `translate(${-v.x * v.z + rubber}px, ${-v.y * v.z}px) scale(${v.z})`;
      if (quick) return;
      // what a window part sized in screen px needs (app.css: the resize band, calc(4px * var(--zi, 1)); and the clip
      // margin that lets its outer half take the pointer, which takes no calc(), so a plain length, 10 px on screen out to
      // the far zooms: backlog, batch 9)
      c.style.setProperty('--zi', String(1 / v.z));
      c.style.setProperty('--ocm', 10 / Math.min(1, v.z) + 'px');
      titles(ws, c, v);
      if (ws === h.current()) edges();
    }
    /* Far out a window's own title bar, lights and resize corner would be too small to read or use, so below TITLED each
       window in the space on screen draws them at their 100% size: the bar counter-scaled over its top edge, as wide as
       the window and never taller than it (so it never covers another window); the resize grips keep their size on
       screen by themselves (app.css, --zi). One bar
       per window, the window's own: moving, closing, filing and resizing work with the same hands at any zoom (owner,
       Nov 2 14:03; lead's design 14:1x). A note's bar, empty at 100%, holds its title. A window made or resized, or a
       title changed, while far out shows so within a second. */
    const barSets = new Map();   // ws.id -> { c, on, timer }
    function titles(ws, c, v) {
      const on = v.z < TITLED && !spaceAway(ws, h.space(ws));
      let t = barSets.get(ws.id);
      if (!on && !t) return;
      if (!t || t.c !== c) {
        t = { c, on: false, timer: 0 };
        barSets.set(ws.id, t);
      }
      t.on = on;
      if (!on) { clearInterval(t.timer); t.timer = 0; fillBars(ws, c, 1); return; }
      fillBars(ws, c, v.z);
      if (!t.timer) t.timer = setInterval(() => { if (h.canvas(ws) === c && t.on) fillBars(ws, c, view(ws).z); else { clearInterval(t.timer); t.timer = 0; } }, 1000);
    }
    function fillBars(ws, c, z) {
      const want = new Map(here(ws).map((w) => [w.id, w])), { vh } = size(), tb0 = c.querySelector(':scope > .win > .tb'), bar = (tb0 && tb0.offsetHeight) || 30;
      [...c.children].filter((win) => win.classList.contains('win')).forEach((win) => {
        const w = win.style.display !== 'none' && want.get(win.dataset.id), tb = win.querySelector(':scope > .tb');
        const k = w && z < TITLED ? Math.max(1, Math.min(1 / z, ((h.geo(w).h / 100) * vh) / bar)) : 1;
        if (tb) Object.assign(tb.style, k > 1 ? { position: 'relative', zIndex: '6', transformOrigin: '0 0', transform: `scale(${k})`, width: `${100 / k}%` } : { position: '', zIndex: '', transformOrigin: '', transform: '', width: '' });
        // a note's bar has an empty title (its title heads its body, too small to read far out): far out it holds it, and a
        // click on it types into the note's own title, which the bar then covers
        const t = win.classList.contains('note') && tb && tb.querySelector(':scope > .title');
        if (t) {
          const text = k > 1 && typeof h.title === 'function' ? String(h.title(ws, w) || '') : '';
          if (t.textContent !== text) t.textContent = text;
          // on the bar itself: app.js holds the pointer there while it is pressed, so a click lands on the bar, not on its title
          if (!tb.dataset.far) {
            tb.dataset.far = '1';
            tb.addEventListener('click', (e) => {
              const tt = tb.querySelector(':scope > .title'), r = tt && tt.getBoundingClientRect();
              const ed = /scale/.test(tb.style.transform) && r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && win.querySelector('.ned[data-key^="title:"]');
              if (!ed) return;
              ed.focus();
              const sel = window.getSelection();
              sel.selectAllChildren(ed);
              sel.collapseToEnd();
            });
          }
        }
      });
    }
    /* The board has no edges: a view goes wherever it is put, at any zoom (owner, Nov 2 14:08: "drag within workspaces
       is so clipped"). rub: px of x offset drawn on top (a swipe's pull), never kept. */
    function setView(ws, v, animate, rub, quick) {
      ws.zoom = clamp(v.z || 1, zmin(ws), ZMAX);
      const { vw, vh } = size();
      ws.pan = toPct(v.x || 0, vw);
      ws.panY = toPct(v.y || 0, vh);
      rubber = rub || 0;
      show(ws, animate, quick);
    }
    const setPan = (ws, x, animate) => setView(ws, { ...view(ws), x }, animate);
    /* The canvas is as wide as what is in the space, and never narrower than the view's right end. */
    function sizeCanvas(ws) {
      const c = h.canvas(ws);
      if (!c) return;
      const { vw } = size(), v = view(ws);
      c.style.width = Math.max((spaceEnd(ws) / 100) * vw, v.x + vw / v.z) + 'px';
      setView(ws, v, false, rubber);
    }
    /* The glow along the bottom, like the side ones in index.html: more of the space lies below. */
    let glowB = null;
    function edgeB() {
      if (glowB && glowB.isConnected) return glowB;
      glowB = document.createElement('div');
      glowB.className = 'edge';
      glowB.style.cssText = 'top:auto;left:0;right:0;bottom:0;width:auto;height:34px;background:linear-gradient(180deg,transparent,rgba(255,255,255,.075))';
      h.edgeR.parentElement.appendChild(glowB);
      return glowB;
    }
    /* And along the top. */
    let glowT = null;
    function edgeT() {
      if (glowT && glowT.isConnected) return glowT;
      glowT = document.createElement('div');
      glowT.className = 'edge';
      glowT.style.cssText = 'top:0;bottom:auto;left:0;right:0;width:auto;height:34px;background:linear-gradient(0deg,transparent,rgba(255,255,255,.075))';
      h.edgeR.parentElement.appendChild(glowT);
      return glowT;
    }
    /* A glow means a window of the space lies past that side, however far: on a board with no edges, it is the way back. */
    function edges() {
      const ws = h.current();
      if (!ws || !h.canvas(ws)) return;
      showAway(ws);
      const v = view(ws), { vw, vh } = size(), gs = here(ws).map((w) => h.geo(w));
      const past = (f) => gs.some(f);
      h.edgeR.classList.toggle('on', past((g) => ((g.x + g.w) / 100) * vw > v.x + vw / v.z + 2));
      h.edgeL.classList.toggle('on', past((g) => (g.x / 100) * vw < v.x - 2));
      edgeB().classList.toggle('on', past((g) => ((g.y + g.h) / 100) * vh > v.y + vh / v.z + 2));
      edgeT().classList.toggle('on', past((g) => (g.y / 100) * vh < v.y - 2));
    }
    /* The part of a space on screen, in the % of window positions (a space off screen: as it was left). */
    function visible(ws, sid) {
      const { vw, vh } = size(), v = sid === undefined ? view(ws) : viewIn(ws, sid);
      return { x: (v.x / vw) * 100, y: (v.y / vh) * 100, w: 100 / v.z, h: 100 / v.z, z: v.z };
    }
    /* A point on screen (client px) as a position in the space on screen, in %. */
    function toSpace(ws, cx, cy) {
      const r = vp.getBoundingClientRect(), { vw, vh } = size(), v = view(ws);
      return { x: ((v.x + (cx - r.left) / v.z) / vw) * 100, y: ((v.y + (cy - r.top) / v.z) / vh) * 100 };
    }
    /* Windows use the full height: the dock shows only on approach. The bottom 12 px stay bare desktop, so the dock can
       always come up there, even over a page (a page never tells the app where the pointer is). */
    const bottom = () => 100 - Math.max(SIDE, (BOTTOM_PX / size().vh) * 100);
    function collides(ws, x, y, w, hh, sid) {
      const s = sid === undefined ? h.space(ws) : sid, gap = 1.2;
      return ws.windows.some((o) => {
        if (!inSpace(o, s)) return false;
        const g = h.geo(o);
        return x < g.x + g.w + gap && g.x < x + w + gap && y < g.y + g.h + gap && g.y < y + hh + gap;
      });
    }
    /* The rows a new window may use in a view: inside the view's margins and between the space's own top and bottom,
       which a zoomed-out view shows more than; as near the view as the window's height allows. */
    function rows(ws, vr, k, hh, sid) {
      const floor = spaceBottom(ws, sid) - (100 - bottom());
      hh = Math.min(hh, (bottom() - TOP) * Math.min(1, k));
      const top = Math.max(TOP, vr.y + TOP * k), bot = Math.min(floor, vr.y + bottom() * k);
      if (bot - top >= hh) return { top, bot, hh };
      const t = clamp(top, TOP, floor - hh);
      return { top: t, bot: t + hh, hh };
    }
    /* A new window goes into the space you are in, inside the view: the first empty spot top to bottom, left to right,
       and then the view stays. With none, it goes just past the space's last window, at its top, over nothing; whoever
       opens it brings the view to it (focusWin). A new window never covers another (lead, Nov 2 11:3x). It never goes
       left of the space or above it, which a zoomed-out view also shows. clear: only an empty spot in view, else null. */
    function freeSpot(ws, w, hh, sid, clear) {
      const s = sid === undefined ? h.space(ws) : sid, vr = visible(ws, s), k = 1 / vr.z, { top, bot, hh: fit } = rows(ws, vr, k, hh, s);
      w = Math.min(w, vr.w - 2 * SIDE * k);
      hh = fit;
      const left = Math.max(SIDE, vr.x + SIDE * k), right = Math.max(vr.x + vr.w - SIDE * k, left + w);
      for (let y = top; y + hh <= bot + 0.01; y += 1.8 * k) {
        for (let x = left; x + w <= right + 0.01; x += 1.2 * k) {
          if (!collides(ws, x, y, w, hh, s)) return { x, y, w, h: hh };
        }
      }
      if (clear) return null;
      return { x: contentEnd(ws, null, s) + 1.5, y: TOP, w, h: hh };
    }
    /* A new window from the dock or the menu (lead, batch 10): at its own size in the first empty spot in view; else in
       view, in the largest open area that holds at least half its own width and height and the smallest window of use
       (MIN_W x MIN_H), the larger of the two each way, sized to it up to its own size, at its top left; only with none,
       just past the space's last window at its top at its own size, the view brought to it (focusWin) (freeSpot; K4).
       sized (a drop or a right-click at a spot with no way at all, placeRoom): the open area needs only MIN_W x MIN_H. */
    function openSpot(ws, w, hh, sized) {
      const s = freeSpot(ws, w, hh, undefined, true);
      if (s) return s;
      const vr = visible(ws), k = 1 / vr.z, { vw, vh } = size(), { top, bot, hh: fit } = rows(ws, vr, k, hh);
      const cw = Math.min(w, vr.w - 2 * SIDE * k);
      const wUse = Math.min(cw, (MIN_W / vw) * 100), hUse = Math.min(fit, (MIN_H / vh) * 100);
      const wMin = sized ? wUse : Math.max(cw / 2, wUse), hMin = sized ? hUse : Math.max(fit / 2, hUse);
      let best = null;
      clearings(ws, null, Math.max(SIDE, vr.x + SIDE * k), vr.x + vr.w - SIDE * k, top, bot).forEach((c) => {
        const W = Math.min(cw, c.R - c.L), H = Math.min(fit, c.B - c.T), area = W * vw * H * vh;
        if (W < wMin - 0.01 || H < hMin - 0.01) return;
        if (!best || area > best.area * 1.001 || (area > best.area * 0.999 && (c.T < best.y - 0.05 || (c.T < best.y + 0.05 && c.L < best.x)))) best = { x: c.L, y: c.T, w: W, h: H, area };
      });
      return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : freeSpot(ws, w, hh);
    }
    /* Its top left corner at the point, moved in just enough to stay inside the view and the space. */
    function placeAt(ws, at, w, hh) {
      const vr = visible(ws), k = 1 / vr.z, { top, bot, hh: fit } = rows(ws, vr, k, hh);
      w = Math.min(w, vr.w - 1.2 * k);
      return { x: Math.max(0.6, clamp(at.x, vr.x + 0.6 * k, vr.x + vr.w - 0.6 * k - w)), y: clamp(at.y, top, bot - fit), w, h: fit };
    }
    /* What green fills: the view, inside its margins. */
    function fillRect(ws) {
      const vr = visible(ws), k = 1 / vr.z;
      return { x: vr.x + 0.6 * k, y: vr.y + 4.6 * k, w: 98.8 * k, h: (bottom() - 4.6) * k };
    }
    /* Pans the space on screen just enough that a window is in view, as much of it as fits: past the right side its
       right edge comes in, past the left side (or wider than the view) its left edge. What was in view stays in view as
       far as it can, so a fork that lands beside its parent leaves the parent in view. The zoom stays as it is: making or
       going to a window far out never brings the space back to 100% (owner, Nov 2 14:03). */
    function reveal(ws, g) {
      const vr = visible(ws), { vw, vh } = size(), k = 1 / vr.z;
      let x = vr.x, y = vr.y;
      if (g.x + g.w > vr.x + vr.w) x = g.x + g.w + SIDE * k - vr.w;
      if (g.x < x) x = g.x - SIDE * k;
      if (g.y + g.h > vr.y + vr.h) y = g.y + g.h + (100 - bottom()) * k - vr.h;
      // the top bar lies over the view's top: a bar under it is not in view (sidebar, Nov 2 17:4x)
      const bar = document.querySelector('.menubar'), under = bar ? ((bar.getBoundingClientRect().bottom - vp.getBoundingClientRect().top) / vh) * 100 : 0;
      if (g.y < y + Math.max(0, under) * k) y = g.y - TOP * k;
      if (x !== vr.x || y !== vr.y) setView(ws, { x: (x / 100) * vw, y: (y / 100) * vh, z: vr.z }, true);
    }
    /* The first-run layout is drawn so its bottom row ends at 88.4% of the height: this stretches it to end at the
       bottom on whatever screen it opens on. Windows you moved are restored where you left them, untouched. */
    function fitStart(list) {
      const k = (bottom() - TOP) / (88.4 - TOP), fy = (y) => TOP + (y - TOP) * k;
      list.forEach((ws) => ws.windows.forEach((r) => { const b = fy(r.y + r.h); r.y = fy(r.y); r.h = b - r.y; }));
    }
    /* On load: a window dragged past the left edge before that was stopped comes back into reach. A view comes back
       exactly as it was left, wherever that is (the edge glows point to the windows). Returns how many. Only at Flow's
       start: a pop-out leaves the saved state as it is, room added and not used yet included. */
    function recover(list) {
      if (h.solo) return 0;
      let n = converted;
      list.forEach((ws) => {
        [...ws.windows, ...ws.closed].forEach((w) => { if (w.x < 0) { w.x = SIDE; n++; } });
        [null, ...(ws.zones || []).map((zn) => zn.id)].forEach((sid) => {
          const zn = zoneOf(ws, sid), [o, k] = sid === h.space(ws) ? [ws, 'pan', 'zoom'] : zn ? [zn, 'pan', 'zoom'] : [ws, 'mainPan', 'mainZoom'];
          const ho = holderOf(ws, sid), l = ho.roomLeft || 0, here = [...ws.windows, ...ws.closed].filter((w) => inSpace(w, sid));
          if (l && !here.some((w) => w.x < l)) {
            here.forEach((w) => { w.x -= l; if (w.max) w.max.x -= l; });
            o[k] = Math.max(0, (o[k] || 0) - l);
            n++;
          }
          if (l || ho.roomRight) { delete ho.roomLeft; delete ho.roomRight; n++; }
        });
      });
      return n;
    }
    /* The overview's click or drag (src/overview.js): the view centered on x, y (% of the space on screen), at its zoom.
       Along a side where all of the space is in view already, the view stays. */
    function goTo(ws, x, y, animate) {
      stopFling();
      const { vw, vh } = size(), v = view(ws);
      const fitsX = (spaceEnd(ws) / 100) * vw <= vw / v.z, fitsY = (spaceBottom(ws) / 100) * vh <= vh / v.z;
      setView(ws, { x: fitsX ? v.x : (x / 100) * vw - vw / v.z / 2, y: fitsY ? v.y : (y / 100) * vh - vh / v.z / 2, z: v.z }, animate);
    }

    /* ---------- drag the empty desktop, and let it glide ---------- */
    /* While the desktop is held or glides, the canvas is a layer of its own, so a frame only moves it. */
    function showPan(ws, x, y, z) {
      const c = h.canvas(ws);
      if (c && c.style.willChange !== 'transform') c.style.willChange = 'transform';
      setView(ws, { x, y, z }, false, 0, true);
    }
    function settle(ws) {
      const c = h.canvas(ws);
      if (c) c.style.willChange = '';
      rubber = 0;
      show(ws, false);
      h.changed(ws);
    }
    function stopFling() {
      if (!fling) return;
      const f = fling;
      fling = null;
      cancelAnimationFrame(f.raf);
      settle(f.ws);
    }
    /* A glide ends by itself when the workspace or space changes, or anything else pans or zooms the space. A release
       below the shared animation cutoff still glides once, visibly, then settles: the cutoff is held to a quarter of
       the actual release speed so a one-pixel flick travels a fraction of its direction before stopping. */
    function startFling(ws, x, y, vx, vy) {
      const z = view(ws).z, end = Math.min(FLING_END, Math.hypot(vx, vy) * z * 0.25);
      let last = performance.now();
      const frame = (now) => {
        const dt = Math.min(250, Math.max(0, now - last));
        last = now;
        const v0 = view(ws);
        if (h.current() !== ws || h.space(ws) !== fling.space || v0.z !== z || Math.abs(v0.x - fling.x) > 0.5 || Math.abs(v0.y - fling.y) > 0.5) { stopFling(); return; }
        const speed = Math.hypot(vx, vy) * z;
        const q = clamp(speed / FLING_MAX, 0, 1);
        const decay = FLING_DECAY_SLOW + (FLING_DECAY_FAST - FLING_DECAY_SLOW) * q;
        vx *= Math.pow(decay, dt);
        vy *= Math.pow(decay, dt);
        x += vx * dt;
        y += vy * dt;
        showPan(ws, x, y, z);
        const v1 = view(ws);
        fling.x = v1.x;
        fling.y = v1.y;
        if (Math.hypot(vx, vy) * z < end) { stopFling(); return; }
        fling.raf = requestAnimationFrame(frame);
      };
      const v = view(ws);
      fling = { ws, space: h.space(ws), x: v.x, y: v.y, raf: requestAnimationFrame(frame) };
    }
    /* A drag that starts while the space is still sliding somewhere starts from where it is on screen. */
    function freeze(ws) {
      const c = h.canvas(ws);
      if (!c) return;
      const m = new DOMMatrixReadOnly(getComputedStyle(c).transform), v = view(ws);
      const x = -m.m41 / m.a, y = -m.m42 / m.a;
      if (Math.abs(x - v.x) > 0.5 || Math.abs(y - v.y) > 0.5) setView(ws, { x, y, z: v.z }, false, 0);
    }
    function startPan(e, ws, sec) {
      e.preventDefault();
      const a = document.activeElement;
      if (a && a !== document.body && a.blur) a.blur();
      freeze(ws);
      const id = e.pointerId;
      let v0 = view(ws), sx = e.clientX, sy = e.clientY, lx = sx, ly = sy;
      let x = v0.x, y = v0.y, sampled = { x: sx, y: sy, t: e.timeStamp }, moved = false, lastDx = 0, lastDy = 0, recentSpeed = 0, lastMove = e.timeStamp;
      const sample = (c) => {
        const dx = c.clientX - sampled.x, dy = c.clientY - sampled.y;
        if (!dx && !dy) return;
        const distance = Math.hypot(dx, dy), dt = clamp(c.timeStamp - sampled.t, VEL_MIN_MS, VEL_MS);
        moved = true;
        lastDx = dx;
        lastDy = dy;
        recentSpeed = distance / dt;
        lastMove = c.timeStamp;
        sampled = { x: c.clientX, y: c.clientY, t: c.timeStamp };
      };
      /* A pinch while the desktop is held: the drag goes on from the new zoom, under the same point. */
      grab = { ws, rebase: () => {
        v0 = view(ws);
        sx = lx;
        sy = ly;
        x = v0.x;
        y = v0.y;
        sampled = { x: lx, y: ly, t: performance.now() };
        lastDx = 0;
        lastDy = 0;
        recentSpeed = 0;
        lastMove = -Infinity;
      } };
      h.busy(true);
      vp.classList.add('panning');
      if (e.isTrusted) sec.setPointerCapture(id);
      const move = (ev) => {
        if (ev.pointerId !== id) return;
        const all = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
        (all.length ? all : [ev]).forEach(sample);
        lx = ev.clientX;
        ly = ev.clientY;
        x = v0.x - (ev.clientX - sx) / v0.z;
        y = v0.y - (ev.clientY - sy) / v0.z;
        showPan(ws, x, y, v0.z);
      };
      const up = (ev) => {
        if (ev.pointerId !== id) return;
        if (ev.type === 'pointerup' && (ev.clientX !== lx || ev.clientY !== ly)) move(ev);
        sec.removeEventListener('pointermove', move);
        sec.removeEventListener('pointerup', up);
        sec.removeEventListener('pointercancel', up);
        sec.removeEventListener('lostpointercapture', up);
        grab = null;
        vp.classList.remove('panning');
        h.busy(false);
        click = ev.type === 'pointerup' && !moved ? { t: ev.timeStamp, x: ev.clientX, y: ev.clientY } : null;
        const direction = Math.hypot(lastDx, lastDy), speed = Math.min(recentSpeed, FLING_MAX);
        if (ev.type === 'pointerup' && moved && ev.timeStamp - lastMove < STILL_MS && direction > 0 && h.current() === ws) {
          const k = speed / direction / v0.z;
          startFling(ws, x, y, -lastDx * k, -lastDy * k);
        } else settle(ws);
      };
      sec.addEventListener('pointermove', move);
      sec.addEventListener('pointerup', up);
      sec.addEventListener('pointercancel', up);
      sec.addEventListener('lostpointercapture', up);
    }
    /* The second press of a double-click between two windows opens room there (startRoom); any other press pans. press:
       where the last press on the desktop was, so a double-click counts only where it was let go (not a pull). */
    let click = null, press = null;
    vp.addEventListener('pointerdown', (e) => {
      stopFling();
      slideStop();
      if (e.button !== 0 || !e.target.closest) return;
      const grip = e.target.closest('.win .rz');
      const blank = e.target.matches('.win > .nd, .win .pgc, .win .npane');
      if (!grip && e.target.closest('.win, .away') && !blank) return;
      const sec = e.target.closest('.ws');
      const ws = h.current();
      if (!sec || !ws || sec.dataset.id !== ws.id) return;
      const c = click, again = !!c && e.timeStamp - c.t < DBL_MS && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 6;
      click = null;
      press = { x: e.clientX, y: e.clientY };
      /* Two close windows' resize grips can cover the whole gap between them: a double-click there still opens room,
         and a press that is not one resizes as before. */
      if (grip) {
        if (again && !inBand(e.clientX, e.clientY) && between(ws, toSpace(ws, e.clientX, e.clientY)) && startRoom(e, ws, sec)) { e.stopPropagation(); return; }
        if (e.altKey && startSpace(e, ws, sec, true)) { e.stopPropagation(); return; }
        const x0 = e.clientX, y0 = e.clientY;
        window.addEventListener('pointerup', (u) => { click = u.clientX === x0 && u.clientY === y0 ? { t: u.timeStamp, x: u.clientX, y: u.clientY } : null; }, { once: true, capture: true });
        return;
      }
      if (again && !inBand(e.clientX, e.clientY) && startRoom(e, ws, sec)) return;
      if (e.altKey && !e.target.closest('.win') && startSpace(e, ws, sec)) return;
      startPan(e, ws, sec);
    }, true);

    /* While a dragged window is near a side of the view, its space pans that way and the window goes along: moved(dx, dy)
       gets each step in px at zoom 1; at the bottom that grows the space down. grow(dx), asked first for each step to
       the left, opens room there instead when the window is at the space's own left side (owner, 22:50) and says whether
       it did. cx null stops it. */
    function edgePan(ws, cx, moved, grow, cy) {
      const r = vp.getBoundingClientRect();
      const near = (c, lo, hi) => (c == null ? 0 : c < lo + EDGE_PX ? (c - lo - EDGE_PX) / EDGE_PX : c > hi - EDGE_PX ? (c - hi + EDGE_PX) / EDGE_PX : 0);
      const depth = near(cx, r.left, r.right), depthY = cx == null ? 0 : near(cy, r.top, r.bottom);
      if (!depth && !depthY) {
        if (edgeLoop) { cancelAnimationFrame(edgeLoop.raf); edgeLoop = null; }
        return;
      }
      if (edgeLoop) { Object.assign(edgeLoop, { depth, depthY, moved, grow }); return; }
      let last = performance.now();
      const frame = (now) => {
        const dt = Math.min(250, Math.max(0, now - last));
        last = now;
        const v = view(ws), step = (clamp(edgeLoop.depth, -1, 1) * 0.9 * dt) / v.z, down = (clamp(edgeLoop.depthY, -1, 1) * 0.9 * dt) / v.z;
        sizeCanvas(ws);
        // left of or above the space's start the board grows there under the held window instead (app.js: the others move)
        const grew = step < 0 && edgeLoop.grow && edgeLoop.grow(-step, 0), grewY = down < 0 && edgeLoop.grow && edgeLoop.grow(0, -down);
        setView(ws, { x: grew ? v.x : v.x + step, y: grewY ? v.y : v.y + down, z: v.z }, false);
        const d = view(ws).x - v.x, dy = view(ws).y - v.y;
        if (d || dy) edgeLoop.moved(d, dy);
        edgeLoop.raf = requestAnimationFrame(frame);
      };
      edgeLoop = { depth, depthY, moved, grow, raf: requestAnimationFrame(frame) };
    }

    /* ---------- room (owner, 21:50 and 22:50) ---------- */
    /* The windows that make way when room opens at a line of the space on screen: those entirely past it on side (1
       right or below, -1 left) that are in its way along [from, to] (the stretch of the line that opens, in the other
       axis), and the ones in their way or sitting against them (ATTACH or closer), on and on. They all move by the same
       amount, so their arrangement is kept and no window ends up over another. axis 'x': a line down the space at x =
       line; 'y': across it at y = line. closed: closed windows too (only with the whole line). */
    function inWay(ws, axis, line, side, from, to, closed) {
      const X = axis === 'x', sid = h.space(ws), all = [...ws.windows, ...(closed ? ws.closed : [])].filter((w) => inSpace(w, sid));
      const g = (w) => (ws.windows.includes(w) ? h.geo(w) : w);
      const a0 = (r) => (X ? r.x : r.y), a1 = (r) => (X ? r.x + r.w : r.y + r.h);
      const b0 = (r) => (X ? r.y : r.x), b1 = (r) => (X ? r.y + r.h : r.x + r.w);
      const over = (p0, p1, q0, q1) => p0 < q1 - 0.05 && q0 < p1 - 0.05;
      const past = all.filter((w) => (side > 0 ? a0(g(w)) >= line : a1(g(w)) <= line));
      const moving = new Set(past.filter((w) => b0(g(w)) <= to + 0.05 && from - 0.05 <= b1(g(w))));
      for (let grew = true; grew;) {
        grew = false;
        past.forEach((w) => {
          if (moving.has(w)) return;
          const r = g(w);
          if ([...moving].some((m) => { const q = g(m);
            return over(b0(r), b1(r), b0(q), b1(q)) || (over(a0(r), a1(r), a0(q), a1(q)) && Math.max(b0(r), b0(q)) - Math.min(b1(r), b1(q)) <= ATTACH); })) {
            moving.add(w);
            grew = true;
          }
        });
      }
      return [...moving];
    }
    /* Room opens at a line across the space on screen, along axis ('x': a vertical line at line % of the width, 'y': a
       horizontal one at line % of the height): the windows, open or closed, entirely past it on side (1 right or down,
       -1 left or up) move away from it by amount %, all together, so their arrangement is kept and nothing overlaps; the
       rest stays and so does the view. Left and up keep x, y >= 0 the other way round: the rest and the view move
       instead, so nothing on screen moves. With nothing past the line nothing moves. Returns how many windows lie past. */
    function room(ws, axis, line, side, amount) {
      const sid = h.space(ws), all = [...ws.windows, ...ws.closed].filter((w) => inSpace(w, sid)), X = axis === 'x';
      const past = inWay(ws, axis, line, side, -Infinity, Infinity, true);
      if (!past.length) return 0;
      if (side > 0) h.moveWindows(ws, past, X ? amount : 0, X ? 0 : amount);
      else {
        if (X) ws.pan = (ws.pan || 0) + amount; else ws.panY = (ws.panY || 0) + amount;
        h.moveWindows(ws, all.filter((w) => !past.includes(w)), X ? amount : 0, X ? 0 : amount);
      }
      return past.length;
    }
    /* A double-click on the bare desktop at an edge of the view, any of the four (owner, Nov 1 21:50 and 22:50, "even for
       like below as well"; lead, Nov 2 14:4x), moves the windows lying entirely past that edge one view on (ADD, at
       actual size, whatever the zoom), so a drag shows a view of room there next to what is in view. Nothing on screen
       moves. At the right with nothing past it, the space itself gets a view more there (extendRight). */
    function addRoom(ws, axis, side) {
      stopFling();
      const { vw, vh } = size(), v = view(ws), X = axis === 'x';
      const line = X ? ((side > 0 ? v.x + vw / v.z : v.x) / vw) * 100 : ((side > 0 ? v.y + vh / v.z : v.y) / vh) * 100;
      if (!room(ws, axis, line, side, ADD)) {
        if (X && side > 0) extendRight(ws);
        return;
      }
      sizeCanvas(ws);
      h.changed(ws);
    }
    /* More workspace at the right with nothing dragged there (owner, Nov 7, 03/1): the space's right end moves one view on
       (ADD) and the view glides over so the new room is in sight. */
    function extendRight(ws) {
      stopFling();
      const { vw } = size(), v = view(ws), ho = holderOf(ws, h.space(ws)), end = spaceEnd(ws);
      remember(ws, [], 0, 0, ho);
      ho.roomRight = end + ADD;
      sizeCanvas(ws);
      setView(ws, { ...v, x: Math.max(v.x, ((end + ADD) / 100) * vw - vw / v.z) }, true);
      h.changed(ws);
    }

    /* ---------- space at a point: cut it out or add it (owner, Nov 7: 02/6, 03/5, 03/9) ---------- */
    /* "cut out spaces at different points" and "add just a specific amount of space at a certain point", seeing what it
       does to everything around it. A line across the space (a vertical one at x for axis 'x', a horizontal one at y for
       'y'): the windows entirely past it move together, by the same amount, as room() moves them, so their arrangement
       is kept; the rest never moves. Cutting stops where a moving window would come closer than the usual gap to one
       that stays level with it, or to the space's own start. */
    function spaceAt(ws, axis, line) {
      const X = axis === 'x', moving = inWay(ws, axis, line, 1, -Infinity, Infinity, true);
      const open = moving.filter((w) => ws.windows.includes(w)), stay = here(ws).filter((w) => !moving.includes(w));
      const a0 = (r) => (X ? r.x : r.y), a1 = (r) => (X ? r.x + r.w : r.y + r.h), b0 = (r) => (X ? r.y : r.x), b1 = (r) => (X ? r.y + r.h : r.x + r.w);
      let lo = open.length ? -Infinity : 0;
      open.forEach((m) => {
        const M = h.geo(m);
        lo = Math.max(lo, (X ? SIDE : TOP) - a0(M));
        stay.forEach((s) => { const S = h.geo(s); if (b0(S) < b1(M) - 0.05 && b0(M) < b1(S) - 0.05) lo = Math.max(lo, a1(S) + (X ? GAP_X : GAP_Y) - a0(M)); });
      });
      // nothing past a line down the space: what can go is room added at its right end, back to its windows
      if (!open.length && X) { const ho = holderOf(ws, h.space(ws)); lo = ho.roomRight ? Math.max(100, contentEnd(ws) + SIDE) - ho.roomRight : 0; }
      return { moving, open, lo: Math.min(0, lo) };
    }
    /* One step back for ⌘Z: the last change of space, while the windows it moved are still where it left them and no
       other board action came after it (app.js asks with spaceUndo(t), t its own last step's time). */
    let lastSpace = null;
    function remember(ws, moving, dx, dy, ho) {
      lastSpace = { ws, sid: h.space(ws), ho, roomRight: ho.roomRight, moving, dx, dy, at: moving.map((w) => [w.x, w.y]), t: performance.now() };
    }
    function spaceUndoReady(after) {
      const u = lastSpace;
      return !!u && u.t > (after || -Infinity) && h.current() === u.ws && h.space(u.ws) === u.sid
        && u.moving.every((w, i) => Math.abs(w.x - u.at[i][0]) < 0.01 && Math.abs(w.y - u.at[i][1]) < 0.01);
    }
    function undoSpace(after) {
      if (!spaceUndoReady(after)) return false;
      const u = lastSpace;
      lastSpace = null;
      stopFling();
      if (u.roomRight === undefined) delete u.ho.roomRight; else u.ho.roomRight = u.roomRight;
      if (u.moving.length) h.moveWindows(u.ws, u.moving, -u.dx, -u.dy, true);
      sizeCanvas(u.ws);
      h.changed(u.ws);
      return true;
    }
    /* Moves what lies past the line by d % (d < 0 cuts, at most down to spaceAt's lo) and remembers it for ⌘Z; past the
       last window, added space across is more room at the right. Returns the amount it moved by. */
    function shiftAt(ws, axis, line, d, slide) {
      const at = spaceAt(ws, axis, line), X = axis === 'x', by = Math.max(at.lo, d), ho = holderOf(ws, h.space(ws));
      if (!at.moving.length) {
        if (!X || Math.abs(by) < 0.01) return 0;
        remember(ws, [], 0, 0, ho);
        ho.roomRight = by < 0 ? ho.roomRight + by : Math.max(spaceEnd(ws), line + by);
        return by;
      }
      if (Math.abs(by) < 0.01) return 0;
      h.moveWindows(ws, at.moving, X ? by : 0, X ? 0 : by, slide);
      remember(ws, at.moving, X ? by : 0, X ? 0 : by, ho);
      return by;
    }
    /* The empty space at a point (the desktop's right-click), cut out down to the usual gap: the gap across (between
       windows side by side) where there is one, else the gap down. Returns whether anything moved. */
    function cutAt(ws, p) {
      stopFling();
      const axis = spaceAt(ws, 'x', p.x).lo < -0.05 ? 'x' : spaceAt(ws, 'y', p.y).lo < -0.05 ? 'y' : null;
      if (!axis || !shiftAt(ws, axis, axis === 'x' ? p.x : p.y, -Infinity, true)) return false;
      sizeCanvas(ws);
      h.changed(ws);
      return true;
    }
    const canCut = (ws, p) => spaceAt(ws, 'x', p.x).lo < -0.05 || spaceAt(ws, 'y', p.y).lo < -0.05;
    /* d % more across the space at p (the desktop's right-click: one view, ADD). */
    function addAt(ws, p, d) {
      stopFling();
      if (!shiftAt(ws, 'x', p.x, d, true)) return false;
      sizeCanvas(ws);
      h.changed(ws);
      return true;
    }
    /* Option-drag on bare desktop: the space tool. From the press point, drag right (or down) and space opens there by
       exactly the amount dragged; drag left (or up) and the space there closes up by that much, down to the usual gap.
       The windows that will move light up as the drag starts and follow the pointer the whole way; a band over the
       stretch shows its size in px at actual size, green while adding, red while cutting. The first 4 px pick across or
       down. Let go: done (⌘Z takes it back); Esc: everything back where it was. */
    /* Two windows a usual gap apart are all resize grip on screen: an Option-press on a grip is the space tool's. Half a
       grip lies over its window's edge: a press there puts the line just outside that edge, so the window itself never
       counts as past it; anywhere else the line is where the press was. */
    function gapLine(ws, p, axis) {
      const X = axis === 'x', c = X ? p.x : p.y, o = X ? p.y : p.x;
      const r = here(ws).map((w) => h.geo(w)).find((g) => (X ? g.x < c && c < g.x + g.w && g.y <= o && o <= g.y + g.h : g.y < c && c < g.y + g.h && g.x <= o && o <= g.x + g.w));
      if (!r) return c;
      const a0 = X ? r.x : r.y, a1 = X ? r.x + r.w : r.y + r.h;
      return c - a0 < a1 - c ? a0 - 0.01 : a1 + 0.01;
    }
    function startSpace(e, ws, sec, grip) {
      if (typeof h.moveWindows !== 'function') return false;
      e.preventDefault();
      stopFling();
      const p = toSpace(ws, e.clientX, e.clientY), z = view(ws).z, sx = e.clientX, sy = e.clientY, id = e.pointerId, { vw, vh } = size();
      let axis = null, at = null, d = 0, done = false, end0 = 0;
      const c = h.canvas(ws), band = document.createElement('div'), label = document.createElement('span');
      band.className = 'spaceband';
      band.appendChild(label);
      const lit = (on) => at && at.open.forEach((w) => { const el = c && c.querySelector(`:scope > .win[data-id="${CSS.escape(w.id)}"]`); if (el) el.classList.toggle('spacemove', on); });
      const paint = () => {
        // room taken back at the right end is drawn where that room is
        const X = axis === 'x', line = X && !at.moving.length && d < 0 ? Math.min(p.x, end0) : X ? p.x : p.y, k = X ? vw : vh, v = view(ws);
        const from = (Math.min(line, line + d) / 100) * k, len = (Math.abs(d) / 100) * k;
        band.classList.toggle('cut', d < 0);
        Object.assign(band.style, X
          ? { left: from + 'px', width: len + 'px', top: v.y + 'px', height: vh / v.z + 'px' }
          : { left: v.x + 'px', width: vw / v.z + 'px', top: from + 'px', height: len + 'px' });
        label.style.fontSize = 12 / v.z + 'px';
        label.textContent = len >= 0.5 ? `${d > 0 ? '+' : '\u2212'}${Math.round(len)} px` : '';
      };
      h.busy(true);
      if (e.isTrusted) sec.setPointerCapture(id);
      const move = (ev) => {
        if (ev.pointerId !== id) return;
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!axis) {
          if (Math.hypot(dx, dy) < 4) return;
          axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
          if (grip) p[axis] = gapLine(ws, p, axis);
          at = spaceAt(ws, axis, axis === 'x' ? p.x : p.y);
          end0 = spaceEnd(ws);
          sec.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
          if (c) c.appendChild(band);
          lit(true);
        }
        const X = axis === 'x', want = ((X ? dx : dy) / z / (X ? vw : vh)) * 100;
        // nothing past a line down the space: adding across is room at the right, cutting takes back room added there
        const nd = at.moving.length || X ? Math.max(at.lo, want) : 0;
        if (at.moving.length && Math.abs(nd - d) >= 0.01) h.moveWindows(ws, at.moving, X ? nd - d : 0, X ? 0 : nd - d);
        d = nd;
        paint();
      };
      const end = (ev, cancel) => {
        if (done || (ev && ev.pointerId !== id)) return;
        done = true;
        sec.removeEventListener('pointermove', move);
        sec.removeEventListener('pointerup', end);
        sec.removeEventListener('pointercancel', end);
        sec.removeEventListener('lostpointercapture', end);
        window.removeEventListener('keydown', esc, true);
        lit(false);
        band.remove();
        sec.style.cursor = '';
        h.busy(false);
        const X = axis === 'x', ho = holderOf(ws, h.space(ws));
        if (cancel || !at || Math.abs(d) < 0.01) {
          if (at && at.moving.length && d) h.moveWindows(ws, at.moving, X ? -d : 0, X ? 0 : -d, true);
        } else if (at.moving.length) remember(ws, at.moving, X ? d : 0, X ? 0 : d, ho);
        else { remember(ws, [], 0, 0, ho); ho.roomRight = d < 0 ? ho.roomRight + d : Math.max(spaceEnd(ws), p.x + d); }
        sizeCanvas(ws);
        h.changed(ws);
      };
      const esc = (ev) => { if (ev.key !== 'Escape') return; ev.preventDefault(); ev.stopPropagation(); end(null, true); };
      sec.addEventListener('pointermove', move);
      sec.addEventListener('pointerup', end);
      sec.addEventListener('pointercancel', end);
      sec.addEventListener('lostpointercapture', end);
      window.addEventListener('keydown', esc, true);
      return true;
    }
    if (typeof h.moveWindows !== 'function') console.error('app.js does not pass moveWindows, so a double-click at a side of the view adds no room');
    /* Which side of the view a point is at: 1 right, -1 left, 0 neither (EDGE_HIT px). */
    function sideOf(x) {
      const r = vp.getBoundingClientRect();
      return x >= r.right - EDGE_HIT ? 1 : x <= r.left + EDGE_HIT ? -1 : 0;
    }
    /* Is a point in the band along an edge of the bare desktop (EDGE_HIT px, at the bottom under the dock's box too)? A
       double-click there is the edge's: it never also opens room between two windows. */
    function inBand(x, y) {
      const r = vp.getBoundingClientRect(), bar = document.querySelector('.menubar'), top = Math.max(r.top, bar ? bar.getBoundingClientRect().bottom : r.top);
      return x >= r.right - EDGE_HIT || x <= r.left + EDGE_HIT || y >= r.bottom - EDGE_HIT || (y >= top && y <= top + EDGE_HIT);
    }
    /* Which edge of the bare desktop a point is at (EDGE_HIT px): left or right first, then the bottom (not under the
       dock's box: the dock wins there) or the top (below the bar: on the bar or the pills the bar wins). */
    function edgeOf(x, y) {
      const r = vp.getBoundingClientRect(), bar = document.querySelector('.menubar'), top = Math.max(r.top, bar ? bar.getBoundingClientRect().bottom : r.top);
      const dock = document.getElementById('dock'), d = dock && dock.getBoundingClientRect();
      if (x >= r.right - EDGE_HIT) return { axis: 'x', side: 1 };
      if (x <= r.left + EDGE_HIT) return { axis: 'x', side: -1 };
      if (y >= r.bottom - EDGE_HIT) return d && d.width && x >= d.left && x <= d.right && y >= d.top ? null : { axis: 'y', side: 1 };
      if (y >= top && y <= top + EDGE_HIT) return { axis: 'y', side: -1 };
      return null;
    }
    vp.addEventListener('dblclick', (e) => {
      const ws = h.current(), sec = e.target.closest && e.target.closest('.ws');
      if (!ws || !sec || sec.dataset.id !== ws.id || (e.target.closest('.win, .away') && !e.target.closest('.win .rz')) || typeof h.moveWindows !== 'function') return;
      if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) return;
      const at = edgeOf(e.clientX, e.clientY);
      if (at) addRoom(ws, at.axis, at.side);
    });

    /* ---------- room between windows (owner, 22:50) ---------- */
    /* The two windows a point of bare desktop lies between, one of them at least partly in view: side by side (axis
       'x': the room opens between them and the right one makes way) or one above the other ('y': the lower one makes
       way). With both, the narrower gap on screen. */
    function between(ws, p) {
      const vr = visible(ws), { vw, vh } = size(), list = here(ws).map((w) => ({ w, r: h.geo(w) }));
      const seen = (r) => r.x < vr.x + vr.w && r.x + r.w > vr.x && r.y < vr.y + vr.h && r.y + r.h > vr.y;
      const best = (arr, f) => arr.reduce((b, o) => (!b || f(o) < f(b) ? o : b), null);
      const row = list.filter((o) => o.r.y <= p.y && p.y <= o.r.y + o.r.h), col = list.filter((o) => o.r.x <= p.x && p.x <= o.r.x + o.r.w);
      const L = best(row.filter((o) => o.r.x + o.r.w <= p.x + 0.05), (o) => -(o.r.x + o.r.w)), R = best(row.filter((o) => o.r.x >= p.x - 0.05), (o) => o.r.x);
      const U = best(col.filter((o) => o.r.y + o.r.h <= p.y + 0.05), (o) => -(o.r.y + o.r.h)), D = best(col.filter((o) => o.r.y >= p.y - 0.05), (o) => o.r.y);
      const gx = L && R && (seen(L.r) || seen(R.r)) ? R.r.x - L.r.x - L.r.w : Infinity;
      const gy = U && D && (seen(U.r) || seen(D.r)) ? D.r.y - U.r.y - U.r.h : Infinity;
      if (gx === Infinity && gy === Infinity) return null;
      return (gx / 100) * vw <= (gy / 100) * vh ? { axis: 'x', near: L.r, far: R.r } : { axis: 'y', near: U.r, far: D.r };
    }
    /* The open areas of the space on screen inside [X0, X1] x [Y0, Y1], each the widest clear stretch across a band, the
       usual gaps kept from every window; with p, only those at p (within a gap of it). */
    function clearings(ws, p, X0, X1, Y0, Y1) {
      const obs = here(ws).map((o) => { const g = h.geo(o); return { x0: g.x - GAP_X, x1: g.x + g.w + GAP_X, y0: g.y - GAP_Y, y1: g.y + g.h + GAP_Y }; });
      const ys = [...new Set([Y0, Y1, ...obs.flatMap((o) => [o.y0, o.y1])])].filter((y) => y >= Y0 && y <= Y1).sort((a, b) => a - b);
      const out = [];
      ys.forEach((T, i) => ys.slice(i + 1).forEach((B) => {
        if (p && (T > p.y + GAP_Y || B < p.y - GAP_Y)) return;
        const xs = obs.filter((o) => o.y0 < B - 0.05 && o.y1 > T + 0.05).sort((a, b) => a.x0 - b.x0);
        let x = X0;
        for (const o of [...xs, { x0: X1, x1: Infinity }]) {
          const e = Math.min(o.x0, X1);
          if (e - x > 0.05 && (!p || (x - GAP_X <= p.x && p.x <= e + GAP_X))) out.push({ L: x, R: e, T, B });
          x = Math.max(x, o.x1);
        }
      }));
      return out;
    }
    /* A window r at a spot with no usable open area there, or let go over a window (under), keeps its own size, and
       nothing is left under it (lead, Nov 2 09:1x and 10:3x). First a small nudge of r itself: within about 15% of its
       size each way, the point it was made at (pt) still in it, the usual gap from every window, never above y0 or left
       of x0; then nothing else moves. Else windows past it, starting at or after its top (or its left side), make way down
       (or to the right) by what they overlap it plus the gap: those it would cover or crowd, those they then run into,
       and their row-mates past that side, all by one amount, the way that moves the fewest windows, then the least; the
       rest stays, and windows already over each other stay so. A window before it, above or left of it, is never pushed:
       r goes just past it instead, down or right, whichever is less. The window under the hand makes way too. With no
       way at all, r goes past the space's last window, at its top. dry: only says where it would go, moving nothing. */
    function makeWay(ws, r, dry, under, pt, x0, y0) {
      if (typeof h.moveWindows !== 'function') return r;
      const { vw, vh } = size(), all = here(ws), geo = new Map(all.map((o) => [o, h.geo(o)]));
      const hit = (p, q) => p.x < q.x + q.w - 0.05 && q.x < p.x + p.w - 0.05 && p.y < q.y + q.h - 0.05 && q.y < p.y + p.h - 0.05;
      const pad = (p, q) => p.x < q.x + q.w + GAP_X - 0.05 && q.x < p.x + p.w + GAP_X - 0.05 && p.y < q.y + q.h + GAP_Y - 0.05 && q.y < p.y + p.h + GAP_Y - 0.05;
      const dxs = [0], dys = [0];
      geo.forEach((g) => { if (pad(r, g)) { dxs.push(g.x - GAP_X - r.x - r.w, g.x + g.w + GAP_X - r.x); dys.push(g.y - GAP_Y - r.y - r.h, g.y + g.h + GAP_Y - r.y); } });
      let small = null;
      dxs.forEach((dx) => dys.forEach((dy) => {
        if (Math.abs(dx) > 0.15 * r.w + 0.01 || Math.abs(dy) > 0.15 * r.h + 0.01) return;
        const b = { ...r, x: r.x + dx, y: r.y + dy }, cost = Math.abs(dx) * vw + Math.abs(dy) * vh;
        if ((small && small.cost <= cost) || b.x < (x0 || 0) - 0.01 || b.y < (y0 || 0) - 0.01) return;
        if (pt && (pt.x < b.x - 0.01 || pt.x > b.x + b.w + 0.01 || pt.y < b.y - 0.01 || pt.y > b.y + b.h + 0.01)) return;
        if (![...geo.values()].some((g) => pad(b, g))) small = { b, cost };
      }));
      if (small) return small.b;
      const way = (a, X) => {
        const A0 = (g) => (X ? g.x : g.y), A1 = (g) => (X ? g.x + g.w : g.y + g.h), B0 = (g) => (X ? g.y : g.x), B1 = (g) => (X ? g.y + g.h : g.x + g.w);
        const G = X ? GAP_X : GAP_Y, along = (p, q) => A0(p) < A1(q) - 0.05 && A0(q) < A1(p) - 0.05;
        const crowds = (p, q) => B0(p) < B1(q) - 0.05 && B0(q) < B1(p) - 0.05 && A0(p) < A1(q) + G - 0.05 && A0(q) < A1(p) + G - 0.05;
        const row = (p, q) => along(p, q) && Math.max(B0(p), B0(q)) - Math.min(B1(p), B1(q)) <= ATTACH;
        const past = (o) => o === under || A0(geo.get(o)) >= A0(a) - 0.05;
        const m = all.filter((o) => past(o) && crowds(a, geo.get(o))), need = Math.max(0, ...m.map((o) => A1(a) + G - A0(geo.get(o))));
        const moved = (o) => { const g = geo.get(o); return X ? { ...g, x: g.x + need } : { ...g, y: g.y + need }; };
        for (let grew = true; grew;) {
          grew = false;
          all.forEach((o) => {
            if (m.includes(o)) return;
            const g = geo.get(o);
            if (m.some((q) => (crowds(moved(q), g) && !hit(geo.get(q), g)) || (past(o) && row(geo.get(q), g)))) { m.push(o); grew = true; }
          });
        }
        return all.every((o) => m.includes(o) || !hit(a, geo.get(o))) ? { X, m, need, px: need * (X ? vw : vh) } : null;
      };
      let a = { ...r };
      for (let i = 0; i < 8; i++) {
        const ok = [way(a, false), way(a, true)].filter(Boolean).sort((p, q) => p.m.length - q.m.length || p.px - q.px)[0];
        if (ok) {
          if (ok.need > 0 && !dry) h.moveWindows(ws, ok.m, ok.X ? ok.need : 0, ok.X ? 0 : ok.need, true);
          return a;
        }
        const block = all.filter((o) => o !== under && hit(a, geo.get(o))).map((o) => geo.get(o));
        const down = Math.max(...block.filter((g) => g.y < a.y - 0.05).map((g) => g.y + g.h + GAP_Y));
        const right = Math.max(...block.filter((g) => g.x < a.x - 0.05).map((g) => g.x + g.w + GAP_X));
        const byDown = Number.isFinite(down) ? (down - a.y) * vh : Infinity, byRight = Number.isFinite(right) ? (right - a.x) * vw : Infinity;
        if (byDown === Infinity && byRight === Infinity) break;
        a = byRight < byDown ? { ...a, x: right } : { ...a, y: down };
      }
      return { ...r, x: contentEnd(ws) + 1.5, y: TOP };
    }
    /* A window made at a point of the desktop: by its right-click menu there, or a dock button carried there and let go,
       held by its title bar at the hand (lead 16:1x, from browse's walk of a busy space: a drop in a gap moved 8 windows a
       page width, one on a page 12, one at the right edge landed out of view). At the hand, at its own size, wholly in
       view where nothing is, else where the hand is; else in the open space at the hand, sized to it down to the smallest
       of use (MIN_W x MIN_H); else nudged a little from where the hand holds it; in a gap between two windows, beside
       the near one with what is past it making way (owner 23:57); let go over a window, into its row in order (lead
       19:2x); on bare desktop with no room at the hand, the nearest open place in view, nothing moving (lead 18:0x); only
       then the windows directly in its
       way make way, right or down only, never up or left (lead 17:15, as the + does), each by just enough, in view if it
       was and one way keeps it so, the way that moves the least in all, what they run into the same way (makeRoom 'rd';
       where that would push one two ways, right or down as for beside(), else down). With no way at all, the first open
       place (openSpot). Never a row a page width when moving one down will do. pt: the hand, else the point; dry: only
       says where, moving nothing. */
    function placeRoom(ws, at, w, hh, hand, dry) {
      /* the view's own bottom, not the space's: on the board a point below the windows is a place too */
      const vr = visible(ws), k = 1 / vr.z, { vw, vh } = size(), { top, hh: fit } = rows(ws, vr, k, hh), bot = Math.max(top + fit, vr.y + bottom() * k);
      const L = Math.max(SIDE, vr.x + SIDE * k), R = Math.max(L, vr.x + vr.w - SIDE * k), W0 = Math.min(w, R - L), H0 = fit;
      const mw = Math.min(W0, (MIN_W / vw) * 100), mh = Math.min(H0, (MIN_H / vh) * 100), pt = hand || at, wins = here(ws).map((o) => h.geo(o));
      const pad = (r) => wins.some((g) => r.x < g.x + g.w + GAP_X - 0.05 && g.x < r.x + r.w + GAP_X - 0.05 && r.y < g.y + g.h + GAP_Y - 0.05 && g.y < r.y + r.h + GAP_Y - 0.05);
      /* at the hand, at its own size: moved in just enough to be wholly in view where that covers nothing; else right where
         the hand is when that covers nothing, past the view's side or bottom (the view comes to it, focusWin) */
      const spot = { x: clamp(at.x, L, R - W0), y: clamp(at.y, top, bot - H0), w: W0, h: H0 };
      if (!pad(spot)) return spot;
      const raw = { x: Math.max(L, at.x), y: Math.max(top, at.y), w: W0, h: H0 };
      if (!pad(raw)) return raw;
      /* the open space at the hand, the window sized to it down to the smallest of use, as near the spot as it fits */
      const p = { x: clamp(pt.x, L, R), y: clamp(pt.y, top, bot) };
      let best = null;
      clearings(ws, p, L, R, top, bot).forEach((c) => {
        const cw = Math.min(W0, c.R - c.L), ch = Math.min(H0, c.B - c.T);
        if (cw < mw - 0.01 || ch < mh - 0.01) return;
        const x = clamp(spot.x, c.L, c.R - cw), y = clamp(spot.y, c.T, c.B - ch), area = cw * vw * ch * vh, off = Math.abs(x - spot.x) * vw + Math.abs(y - spot.y) * vh;
        if (!best || area > best.area * 1.001 || (area > best.area * 0.999 && off < best.off)) best = { x, y, w: cw, h: ch, area, off };
      });
      if (best) return { x: best.x, y: best.y, w: best.w, h: best.h };
      /* a small nudge of the window itself from where the hand holds it: within NUDGE of its size each way, flush the usual
         gap off a neighbour (just under a window its title bar was let go over); past the view's bottom or right side the
         view comes to it (focusWin), never above or left */
      const dxs = [0], dys = [0];
      wins.forEach((g) => { dxs.push(g.x - GAP_X - raw.x - W0, g.x + g.w + GAP_X - raw.x); dys.push(g.y - GAP_Y - raw.y - H0, g.y + g.h + GAP_Y - raw.y); });
      let near = null;
      dxs.forEach((dx) => dys.forEach((dy) => {
        if (Math.abs(dx) > NUDGE * W0 + 0.01 || Math.abs(dy) > NUDGE * H0 + 0.01) return;
        const r = { ...raw, x: raw.x + dx, y: raw.y + dy }, cost = Math.abs(dx) * vw + Math.abs(dy) * vh;
        if ((near && near.cost <= cost) || r.x < L - 0.01 || r.y < top - 0.01 || pad(r)) return;
        near = { r, cost };
      }));
      if (near) return near.r;
      /* in a gap between two windows, side by side or one over the other (owner 23:57: "dropped in a gap, room is made"):
         beside the near one, level with it as far as the view allows, the usual gap from it, and what is past it in its
         way makes way, all that way; the near one never moves, so nothing jumps over the new window (flows, batch 8).
         Only where it fits in the view there and all in its way is past the near one; else the push below. */
      const bare = !wins.some((g) => pt.x > g.x && pt.x < g.x + g.w && pt.y > g.y && pt.y < g.y + g.h);
      const gap = bare && typeof h.moveWindows === 'function' && between(ws, p);
      if (gap) {
        const X = gap.axis === 'x', n = gap.near;
        const r = X ? { x: n.x + n.w + GAP_X, y: clamp(n.y, top, bot - H0), w: W0, h: H0 } : { x: clamp(n.x, L, R - W0), y: n.y + n.h + GAP_Y, w: W0, h: H0 };
        const fits = X ? r.x >= L - 0.01 && r.x + r.w <= R + 0.01 : r.y >= top - 0.01 && r.y + r.h <= bot + 0.01;
        const past = wins.filter((g) => r.x < g.x + g.w + GAP_X - 0.05 && g.x < r.x + r.w + GAP_X - 0.05 && r.y < g.y + g.h + GAP_Y - 0.05 && g.y < r.y + r.h + GAP_Y - 0.05)
          .every((g) => (X ? g.x >= n.x + n.w - 0.05 : g.y >= n.y + n.h - 0.05));
        const keep = here(ws).find((o) => { const g = h.geo(o); return g.x === n.x && g.y === n.y && g.w === n.w && g.h === n.h; });
        const Rg = fits && past ? makeRoom(ws, r, keep, X ? 'x' : 'y', X ? 'x' : 'y') : null;
        if (Rg && Rg.ok) return dry ? r : settle4(ws, Rg, r);
      }
      /* let go over a window (lead 19:2x, batch 9): the row keeps its order. The hand on its right half: beside it on the
         right; on its left half: in its place, it moving right. Level with it and as wide as the view allows, down to the
         smallest of use; it and what is past it in its way move right, all that way, and a row below reaching under it
         moves down, so nothing jumps over the new window. Only where nothing above reaches into it; beside it that
         failing, in its place; else the push. */
      const U = !bare && typeof h.moveWindows === 'function' && wins.find((g) => pt.x > g.x && pt.x < g.x + g.w && pt.y > g.y && pt.y < g.y + g.h);
      if (U) {
        const y = clamp(U.y, top, bot - H0), keepU = here(ws).find((o) => { const g = h.geo(o); return g.x === U.x && g.y === U.y && g.w === U.w && g.h === U.h; });
        const at2 = (x) => ({ x, y, w: Math.min(W0, R - x), h: H0 }), its = [at2(Math.max(L, U.x)), null, Math.max(L, U.x)];
        for (const [r, keep, from] of pt.x >= U.x + U.w / 2 ? [[at2(U.x + U.w + GAP_X), keepU, U.x + U.w], its] : [its]) {
          const inWay = wins.filter((g) => r.x < g.x + g.w + GAP_X - 0.05 && g.x < r.x + r.w + GAP_X - 0.05 && r.y < g.y + g.h + GAP_Y - 0.05 && g.y < r.y + r.h + GAP_Y - 0.05);
          /* it, or past where the new one starts: right; else, under its top (a row below reaching under it): down; else no way */
          const dir = (g) => (g === U || g.x >= from - 0.05 ? 'x' : g.y >= r.y + 0.05 ? 'y' : null);
          if (r.w < mw - 0.01 || !inWay.every(dir)) continue;
          const Ru = makeRoom(ws, r, keep, 'x', dir, 'one');
          if (Ru.ok) return dry ? r : settle4(ws, Ru, r);
        }
      }
      /* on bare desktop with no room at the hand for even the smallest window (lead 18:0x, batch 9): the nearest open place
         in view, sized to it down to the smallest of use, and nothing moves; a place past the view does not count */
      if (bare) {
        let close = null;
        clearings(ws, null, L, R, top, vr.y + bottom() * k).forEach((c) => {
          const cw = Math.min(W0, c.R - c.L), ch = Math.min(H0, c.B - c.T);
          if (cw < mw - 0.01 || ch < mh - 0.01) return;
          const x = clamp(spot.x, c.L, c.R - cw), y = clamp(spot.y, c.T, c.B - ch);
          const off = Math.hypot((Math.max(0, x - p.x, p.x - (x + cw)) / 100) * vw, (Math.max(0, y - p.y, p.y - (y + ch)) / 100) * vh), area = cw * vw * ch * vh;
          if (!close || off < close.off - 0.5 || (off < close.off + 0.5 && area > close.area)) close = { r: { x, y, w: cw, h: ch }, off, area };
        });
        if (close) return close.r;
      }
      /* what is directly in its way makes way, right or down; the window itself at the space's start when what it would
         leave there is under half the smallest window, a sliver nothing can use */
      if (typeof h.moveWindows === 'function') {
        const r = { ...spot, x: spot.x - L < (MIN_W / 2 / vw) * 100 * k ? L : spot.x, y: spot.y - top < (MIN_H / 2 / vh) * 100 * k ? top : spot.y };
        let Rm = makeRoom(ws, r, null, null, null, 'rd');
        if (!Rm.ok) Rm = makeRoom(ws, r, null, null);
        if (!Rm.ok) Rm = makeRoom(ws, r, null, 'y', 'y');
        if (Rm.ok) return dry ? r : settle4(ws, Rm, r);
      }
      return openSpot(ws, w, hh, true);
    }
    /* The windows in the way of a rect at (a new window, or one just resized or let go) make way, each its own way by just
       enough to stand the usual gap off it: right for one to its right, down for one below it, never up or left (lead,
       batch 7); one that is neither goes def ('x' or 'y'; none: the shorter way), and with only every one goes that way
       (only a function: the way it gives each). Any ways: a window goes one way only. ways 'four': each goes the shortest of its four ways out, up and left too, so what is pushed moves away from where
       it is pushed (lead 16:1x: a resize let go). ways 'rd' (lead 17:15: a drop or "new ... here"): right or down only;
       of the two, one that keeps its title bar in view if it was and either does, then its own shorter one, unless the
       other moves less than half as much in all (it and what it then runs into), so a whole row is not pushed a page
       width when moving the one down will do. What a moved window then runs into goes the same way by the same amount,
       so rows and columns keep their shape. keep never moves. from: where keep stood before a resize; a window it did not
       come nearer to is left as it is (lead 18:5x: only what this resize newly crowds). ok: nothing is left under at,
       nothing runs into keep, nothing lands on another, nothing is pushed two ways. slide: does it. */
    function makeRoom(ws, at, keep, def, only, ways, from) {
      const four = ways === 'four';
      const { vw, vh } = size(), all = here(ws, keep ? keep.zone || null : undefined).filter((o) => o !== keep), geo = new Map(all.map((o) => [o, h.geo(o)])), kg = keep && h.geo(keep);
      const hit = (p, q) => p.x < q.x + q.w - 0.05 && q.x < p.x + p.w - 0.05 && p.y < q.y + q.h - 0.05 && q.y < p.y + p.h - 0.05;
      const pad = (p, q) => p.x < q.x + q.w + GAP_X - 0.05 && q.x < p.x + p.w + GAP_X - 0.05 && p.y < q.y + q.h + GAP_Y - 0.05 && q.y < p.y + p.h + GAP_Y - 0.05;
      const apart = (p, q) => Math.max(((q.x - p.x - p.w) / 100) * vw, ((p.x - q.x - q.w) / 100) * vw, ((q.y - p.y - p.h) / 100) * vh, ((p.y - q.y - q.h) / 100) * vh);
      const asIs = (o) => !!from && apart(at, geo.get(o)) >= apart(from, geo.get(o)) - 0.5;
      const needX = (q) => at.x + at.w + GAP_X - q.x, needY = (q) => at.y + at.h + GAP_Y - q.y;
      const dirOf = (q) => (typeof only === 'function' ? only(q) : only) || (q.y >= at.y + at.h / 2 ? 'y' : q.x >= at.x + at.w / 2 ? 'x' : def || ((needX(q) / 100) * vw <= (needY(q) / 100) * vh ? 'x' : 'y'));
      /* four ways: the move that takes q out of at's way, the gap kept, the shortest on screen */
      const out4 = (q) => [[needX(q), 0], [-(q.x + q.w + GAP_X - at.x), 0], [0, needY(q)], [0, -(q.y + q.h + GAP_Y - at.y)]]
        .reduce((b, m) => (Math.abs(m[0] / 100) * vw + Math.abs(m[1] / 100) * vh < Math.abs(b[0] / 100) * vw + Math.abs(b[1] / 100) * vh ? m : b));
      const moves = new Map(), after = (o) => { const q = geo.get(o), d = moves.get(o); return d ? { ...q, x: q.x + d.dx, y: q.y + d.dy } : q; };
      let torn = false;
      const more = (a, b) => (Math.abs(a) > Math.abs(b) + 0.01 ? a : b);
      /* four ways or right-or-down: a window goes one way only; pushed two ways (or along both axes), there is no such room */
      const push = (o, dx, dy) => {
        const c = moves.get(o) || { dx: 0, dy: 0 };
        if ((dx && c.dx && Math.sign(dx) !== Math.sign(c.dx)) || (dy && c.dy && Math.sign(dy) !== Math.sign(c.dy))) { torn = true; return false; }
        if (ways && ((dx && c.dy) || (dy && c.dx))) { torn = true; return false; }
        const n = { dx: more(dx, c.dx), dy: more(dy, c.dy) };
        if (Math.abs(n.dx - c.dx) < 0.01 && Math.abs(n.dy - c.dy) < 0.01) return false;
        moves.set(o, n);
        return true;
      };
      /* right or down: what moving o alone that way moves in all, in px on screen (it and what it then runs into) */
      const drag = (o, dx, dy) => {
        const set = new Set([o]);
        for (let grew = true; grew;) {
          grew = false;
          [...set].forEach((p) => {
            const P0 = geo.get(p), P = { ...P0, x: P0.x + dx, y: P0.y + dy };
            all.forEach((n) => { const q = geo.get(n); if (set.has(n) || hit(P0, q) || !pad(P, q) || (dx > 0 ? q.x < P0.x : q.y < P0.y)) return; set.add(n); grew = true; });
          });
        }
        return set.size * ((dx / 100) * vw + (dy / 100) * vh);
      };
      const vr = visible(ws), k = 1 / vr.z, tb = (30 / vh) * 100 * k, x0 = vr.x, x1 = vr.x + vr.w, y1 = vr.y + (vr.h * bottom()) / 100;
      const seen = (r) => r.y >= vr.y - 0.05 && r.y + tb <= y1 + 0.05 && Math.min(r.x + r.w, x1) - Math.max(r.x, x0) >= Math.min(r.w, (120 / vw) * 100 * k) - 0.05;
      const rd = (q, o) => {
        const opts = [[needX(q), 0], [0, needY(q)]].filter(([dx, dy]) => dx > 0.01 || dy > 0.01).map(([dx, dy]) => ({ dx, dy, in: seen({ ...q, x: q.x + dx, y: q.y + dy }), cost: drag(o, dx, dy) }));
        const pool = seen(q) && opts.some((m) => m.in) ? opts.filter((m) => m.in) : opts;
        /* its own shorter move, unless the other drags less than half as much in all (a row pushed a page width) */
        const own = pool.reduce((b, m) => (!b || (m.dx / 100) * vw + (m.dy / 100) * vh < (b.dx / 100) * vw + (b.dy / 100) * vh ? m : b), null);
        return pool.find((m) => m !== own && m.cost < own.cost / 2) || own;
      };
      all.filter((o) => pad(at, geo.get(o)) && !asIs(o)).forEach((o) => {
        const q = geo.get(o);
        if (four) { const [dx, dy] = out4(q); if (Math.abs(dx) + Math.abs(dy) > 0.01) push(o, dx, dy); return; }
        if (ways === 'rd') { const m = rd(q, o); if (m) push(o, m.dx, m.dy); return; }
        const X = dirOf(q) === 'x', need = X ? needX(q) : needY(q);
        if (need > 0) push(o, X ? need : 0, X ? 0 : need);
      });
      for (let grew = true; grew && !torn;) {
        grew = false;
        [...moves.keys()].forEach((p) => {
          const d = moves.get(p), P = after(p), p0 = geo.get(p);
          all.forEach((o) => {
            const q = geo.get(o);
            if (o === p || hit(p0, q) || !pad(P, after(o))) return;
            const dx = (d.dx > 0 && q.x >= p0.x) || (d.dx < 0 && q.x + q.w <= p0.x + p0.w) ? d.dx : 0;
            const dy = (d.dy > 0 && q.y >= p0.y) || (d.dy < 0 && q.y + q.h <= p0.y + p0.h) ? d.dy : 0;
            if (push(o, dx, dy)) grew = true;
          });
        });
      }
      const mvd = [...moves.keys()];
      const ok = !torn && !mvd.some((o) => (kg && hit(after(o), kg)) || hit(after(o), at)) && !all.some((o) => !moves.has(o) && !asIs(o) && hit(at, geo.get(o)))
        && !mvd.some((o) => all.some((p) => p !== o && hit(after(o), after(p)) && !hit(geo.get(o), geo.get(p))));
      const slide = () => {
        const groups = new Map();
        moves.forEach((d, o) => { const k = `${d.dx.toFixed(3)},${d.dy.toFixed(3)}`; if (!groups.has(k)) groups.set(k, { d, list: [] }); groups.get(k).list.push(o); });
        groups.forEach(({ d, list }) => h.moveWindows(ws, list, d.dx, d.dy, true));
      };
      return { moves, ok, slide };
    }
    /* After w is resized (or let go), the windows it now covers or comes within the usual gap of make way, w staying as it
       is (lead, batch 7: "the never-cover rule applies when you let go"): what you push moves away from the edge you push,
       on all four edges (lead 16:1x, batch 8), each by just enough and what it runs into the same way (makeRoom, four
       ways), the space growing at its start where that goes past it (room), nothing else moving on screen. Where that
       cannot clear w, right or down as before; else they all go down past it. from: w before the resize, so only what it
       came nearer to moves. Returns how many moved; dry: only counts. */
    function clear(ws, w, dry, from) {
      if (typeof h.moveWindows !== 'function') return 0;
      const r = h.geo(w), at = { x: r.x, y: r.y, w: r.w, h: r.h };
      let R = makeRoom(ws, at, w, null, null, 'four', from);
      if (!R.ok) R = makeRoom(ws, at, w, null, null, null, from);
      if (!R.ok) R = makeRoom(ws, at, w, 'y', 'y', null, from);
      if (!R.ok) return 0;
      if (!dry) settle4(ws, R, at, w.zone || null);
      return R.moves.size;
    }
    /* Does R's moves, after growing the space at its start (left or top) by what any of them, or the rect at, goes past it:
       every window of the space and the view move by that much together, so nothing moves on screen; then the moved
       windows slide. sid: the space, the one on screen unless given (clear: its window's own). Returns at where it is
       after the growing. */
    function settle4(ws, R, at, sid = h.space(ws)) {
      const ends = [...R.moves].map(([o, d]) => { const g = h.geo(o); return { x: g.x + d.dx, y: g.y + d.dy }; }).concat(at ? [at] : []);
      const gx = Math.max(0, SIDE - Math.min(SIDE, ...ends.map((e) => e.x))), gy = Math.max(0, TOP - Math.min(TOP, ...ends.map((e) => e.y)));
      if (!gx && !gy) { R.slide(); return at; }
      // a space not on screen keeps its view in its zone (the main space: in ws.mainPan)
      const on = (sid || null) === h.space(ws), zn = !on && zoneOf(ws, sid), [o, kx, ky] = on ? [ws, 'pan', 'panY'] : zn ? [zn, 'pan', 'panY'] : [ws, 'mainPan', 'mainPanY'];
      o[kx] = (o[kx] || 0) + gx;
      o[ky] = (o[ky] || 0) + gy;
      h.moveWindows(ws, [...ws.windows, ...ws.closed].filter((w) => inSpace(w, sid)), gx, gy, false);
      /* the moved windows slide once the held move has drawn without sliding */
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(R.slide)));
      return at && { ...at, x: at.x + gx, y: at.y + gy };
    }
    /* A new window beside w (owner 12:39, "add a new page just like side by side to it"; lead 13:1x), on side 'right',
       'left', 'above' or 'below'. split: the two share w's own rectangle, half each, and nothing else moves; null when a
       half would be under MIN_W (a page: PAGE_W) x MIN_H at actual size.
       Otherwise it is w's size, flush on that side the usual gap away. Only the windows in its way make way, each its
       own way by just enough (makeRoom: right or down, never up or left), and what they run into the same way; w never
       moves. Where the new window or they would go left of the space's start or above its top, the space grows there by
       what is missing. Returns { at, own }: where the new window goes
       and, for a split, w's. dry: only says where, moving nothing; its at is where the new window shows before the view
       comes to it, in the coordinates of now (the same as at unless the space grows). dims: the new window's own size
       ({ w, h } in %) for one that is not w's size, such as a page opened from a terminal's link (lead, batch 7). */
    function beside(ws, w, side, split, dry, dims) {
      const r0 = h.geo(w), g = { x: r0.x, y: r0.y, w: r0.w, h: r0.h }, X = side === 'left' || side === 'right', fwd = side === 'right' || side === 'below', { vw, vh } = size();
      const G = X ? GAP_X : GAP_Y, a0 = X ? g.x : g.y, len = X ? g.w : g.h, put = (r, a, l) => (X ? { ...r, x: a, w: l } : { ...r, y: a, h: l });
      if (split) {
        const half = (len - G) / 2;
        if ((half / 100) * (X ? vw : vh) < (X ? (w.type === 'page' ? PAGE_W : MIN_W) : MIN_H)) return null;
        const first = put(g, a0, half), second = put(g, a0 + half + G, half);
        return fwd ? { at: second, own: first } : { at: first, own: second };
      }
      /* dims: a size of its own ({ w, h } in %) instead of w's, its top (or left side) level with w's */
      const sz = dims ? { w: dims.w, h: dims.h } : { w: g.w, h: g.h }, nl = X ? sz.w : sz.h;
      const at = { ...put(g, fwd ? a0 + len + G : a0 - G - nl, nl), ...(X ? { h: sz.h } : { w: sz.w }) }, all = here(ws).filter((o) => o !== w);
      /* the way for one in the way that is neither right of it nor below it: along the side (right beside it, down under
         it; for the left side down, for the top right, as back toward w is no way) */
      const R = makeRoom(ws, at, w, side === 'right' || side === 'above' ? 'x' : 'y'), moves = R.moves, mvd = [...moves.keys()];
      if (!R.ok) return { at: makeWay(ws, { ...at, x: Math.max(SIDE, at.x), y: Math.max(TOP, at.y) }, dry), moved: all.length };
      const gx = Math.max(0, SIDE - at.x), gy = Math.max(0, TOP - at.y);
      const to = { ...at, x: at.x + gx, y: at.y + gy }, v = view(ws);
      /* The space grows as room at the left does: the view moves with it, so nothing moves on screen until the view comes
         to the new window. At actual size the view cannot sit lower than the space reaches, so where the space is too
         short below, what is there slides down instead. */
      const low = Math.max(100, Math.max(to.y + to.h, ...here(ws).map((o) => { const q = h.geo(o), d = moves.get(o); return q.y + q.h + (d ? d.dy : 0) + gy; })) + 100 - bottom());
      const holdY = gy > 0 && (v.z !== 1 || (v.y / vh) * 100 + gy <= Math.max(0, low - 100 / v.z) + 0.01);
      /* moved: how many windows move (all of them when the space grows), so a caller can pick the side that moves none */
      if (dry) return { at: { ...at, y: holdY || !gy ? at.y : to.y }, moved: gx || gy ? all.length + 1 : mvd.length };
      const slide = R.slide;
      if (gx || gy) {
        const ho = holderOf(ws, h.space(ws));
        if (gx && ho.roomRight) ho.roomRight += gx;
        if (gx) ws.pan = (ws.pan || 0) + gx;
        if (holdY) ws.panY = (ws.panY || 0) + gy;
        const held = gx > 0 || holdY;
        h.moveWindows(ws, [...ws.windows, ...ws.closed].filter((o) => inSpace(o, h.space(ws))), gx, gy, !held);
        /* the windows in the way slide once the held move has drawn without sliding */
        if (mvd.length && held) requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(slide)));
        else slide();
      } else slide();
      return { at: to };
    }
    /* The windows of the space on screen in one of the arranging styles (owner 14:03: "one thing for dynamic arranging
       things ... different dynamic styles that make stuff look nice"; lead 14:5x): a rect for each window id, in %, none
       over another and none under MIN_W x MIN_H at actual size. Each is made from base, the owner's own layout ("yours",
       id -> rect; where the windows are now for any it leaves out), so going through the styles never drifts. tidy:
       yours with sizes and order kept, each window lined up the usual gap from the ones before it where that is a small
       move. kind, focus and grid fill one view at actual size, the one the owner is looking at (centred on it when
       zoomed), and go on below it only where the windows would be too small: kind a strip per kind (agents and
       shells, pages, notes) as wide as its share, tiled; focus front large on the left and the rest beside it; grid
       even rows across the view. Windows keep their reading order. */
    function arrange(ws, style, front, base) {
      const { vw, vh } = size(), wins = here(ws), out = {};
      if (!wins.length) return out;
      const g = new Map(wins.map((o) => { const r = (base && base[o.id]) || h.geo(o); return [o, { x: r.x, y: r.y, w: r.w, h: r.h }]; }));
      const mw = (MIN_W / vw) * 100, mh = (MIN_H / vh) * 100;
      const order = [...wins].sort((a, b) => { const p = g.get(a), q = g.get(b); return Math.abs(p.y - q.y) > 8 ? p.y - q.y : p.x - q.x; });
      if (style === 'tidy') {
        /* in reading order each window goes to the nearest place that lines up with one placed before it (level, flush
           or the usual gap past it) when that is within SNAP of where it is, else it stays; where it would be over or
           against one placed before it, the nearest such place, else under them all */
        const SNAP = 5, placed = [];
        const pad = (r, q) => r.x < q.x + q.w + GAP_X - 0.05 && q.x < r.x + r.w + GAP_X - 0.05 && r.y < q.y + q.h + GAP_Y - 0.05 && q.y < r.y + r.h + GAP_Y - 0.05;
        const dist = (c, o) => Math.hypot(((c.x - o.x) / 100) * vw, ((c.y - o.y) / 100) * vh);
        order.forEach((o) => {
          const r = g.get(o), own = { ...r, x: Math.max(SIDE, r.x), y: Math.max(TOP, r.y) };
          const xs = [SIDE, ...placed.flatMap((q) => [q.x, q.x + q.w + GAP_X, q.x + q.w - r.w])], ys = [TOP, ...placed.flatMap((q) => [q.y, q.y + q.h + GAP_Y, q.y + q.h - r.h])];
          const cand = xs.flatMap((x) => ys.map((y) => ({ ...r, x, y }))).filter((c) => c.x >= SIDE - 0.01 && c.y >= TOP - 0.01 && !placed.some((q) => pad(c, q)));
          cand.sort((p, q) => dist(p, own) - dist(q, own));
          const free = !placed.some((q) => pad(own, q)), snap = cand[0];
          const at = snap && (!free || dist(snap, own) <= (SNAP / 100) * vw) ? snap : free ? own : { ...r, x: SIDE, y: Math.max(TOP, ...placed.map((q) => q.y + q.h + GAP_Y)) };
          placed.push(at);
          out[o.id] = { x: at.x, y: at.y, w: r.w, h: r.h };
        });
        return out;
      }
      /* the part of the view the owner sees (visible(): what no sidebar covers), at actual size, around its middle, never
         before the space's start */
      const vis = visible(ws), cx = vis.x + vis.w / 2, cy = vis.y + vis.h / 2, aw = vis.w * vis.z, ah = vis.h * vis.z;
      const X0 = Math.max(SIDE, cx - aw / 2 + SIDE), Y0 = Math.max(TOP, cy - ah / 2 + TOP), W = aw - 2 * SIDE, H = bottom() - TOP;
      /* list in rows across x0..x0+w from y0, the tiles of a row even: the number of rows whose tiles come closest to the
         view's own shape, none under the smallest of use; with too many for that, rows of the smallest go on below */
      const rows = (list, x0, y0, w, hh) => {
        const n = list.length, aspect = vw / vh;
        let best = null;
        for (let r = 1; r <= n; r++) {
          const per = Array.from({ length: r }, (_, i) => Math.floor(n / r) + (i < n % r ? 1 : 0));
          const th = (hh - (r - 1) * GAP_Y) / r;
          if (th < mh - 0.01) break;
          if (per.some((c) => (w - (c - 1) * GAP_X) / c < mw - 0.01)) continue;
          const cost = per.reduce((a, c) => { const tw = (w - (c - 1) * GAP_X) / c; return a + c * Math.abs(Math.log(((tw / 100) * vw) / ((th / 100) * vh) / aspect)); }, 0) / n;
          if (!best || cost < best.cost) best = { per, th, cost };
        }
        if (!best) {
          const c = Math.max(1, Math.floor((w + GAP_X) / (mw + GAP_X))), r = Math.ceil(n / c), fit = Math.max(1, Math.min(r, Math.floor((hh + GAP_Y) / (mh + GAP_Y))));
          best = { per: Array.from({ length: r }, (_, i) => Math.min(c, n - i * c)), th: Math.max(mh, (hh - (fit - 1) * GAP_Y) / fit) };
        }
        let k = 0;
        best.per.forEach((c, i) => {
          const tw = (w - (c - 1) * GAP_X) / c;
          for (let j = 0; j < c; j++, k++) out[list[k].id] = { x: x0 + j * (tw + GAP_X), y: y0 + i * (best.th + GAP_Y), w: tw, h: best.th };
        });
      };
      if (style === 'kind') {
        /* agents and shells, then pages, then notes, then the rest: a strip each, as wide as its share of the windows and
           never under the smallest of use, tiled in rows; where the view is too narrow for a strip each (a pop-out), a
           band each, top to bottom, as tall as its share */
        const kindOf = (o) => (o.type === 'term' || o.type === 'team' ? 0 : o.type === 'page' ? 1 : o.type === 'note' ? 2 : 3);
        const kinds = [0, 1, 2, 3].map((kd) => order.filter((o) => kindOf(o) === kd)).filter((l) => l.length);
        const across = kinds.length * mw + (kinds.length - 1) * GAP_X <= W + 0.01, G = across ? GAP_X : GAP_Y, m = across ? mw : mh;
        const room = (across ? W : H) - (kinds.length - 1) * G, share = kinds.map((l) => Math.max(m, (room * l.length) / order.length));
        const over = share.reduce((a, b) => a + b, 0) - room, spare = share.map((x) => x - m), all = spare.reduce((a, b) => a + b, 0);
        if (over > 0.01 && all > 0) share.forEach((x, i) => { share[i] = Math.max(m, x - (Math.min(over, all) * spare[i]) / all); });
        let at = across ? X0 : Y0;
        kinds.forEach((l, i) => { if (across) rows(l, at, Y0, share[i], H); else rows(l, X0, at, W, share[i]); at += share[i] + G; });
        return out;
      }
      if (style === 'focus') {
        /* front large on the left, full height; the rest beside it in rows */
        const f = wins.includes(front) ? front : order[0], rest = order.filter((o) => o !== f);
        if (!rest.length) { out[f.id] = { x: X0, y: Y0, w: W, h: H }; return out; }
        const fw = Math.max(mw, Math.min(W * 0.62, W - mw - GAP_X));
        out[f.id] = { x: X0, y: Y0, w: fw, h: H };
        rows(rest, X0 + fw + GAP_X, Y0, Math.max(mw, W - fw - GAP_X), H);
        return out;
      }
      if (style !== 'grid') throw new Error(`arrange: no style ${style}`);
      rows(order, X0, Y0, W, H);
      return out;
    }
    /* The second press of a double-click between two windows. Let go: the far one (right, or lower) makes way by its own
       width or height, so a window like it fits between them. Held and dragged: the room follows the pointer, wider or
       back down to the usual gap, and stays where you let go. */
    function startRoom(e, ws, sec) {
      if (typeof h.moveWindows !== 'function') return false;
      const p = toSpace(ws, e.clientX, e.clientY), b = between(ws, p);
      if (!b) return false;
      const X = b.axis === 'x', m = inWay(ws, b.axis, X ? p.x : p.y, 1, X ? p.y : p.x, X ? p.y : p.x);
      if (!m.length) return false;
      e.preventDefault();
      stopFling();
      const a0 = (r) => (X ? r.x : r.y), a1 = (r) => (X ? r.x + r.w : r.y + r.h);
      const b0 = (r) => (X ? r.y : r.x), b1 = (r) => (X ? r.y + r.h : r.x + r.w);
      let least = Infinity;
      m.forEach((q) => here(ws).forEach((s) => {
        if (m.includes(s)) return;
        const Q = h.geo(q), S = h.geo(s);
        if (a1(S) <= a0(Q) + 0.05 && b0(S) < b1(Q) - 0.05 && b0(Q) < b1(S) - 0.05) least = Math.min(least, a0(Q) - a1(S) - (X ? GAP_X : GAP_Y));
      }));
      const lo = -Math.max(0, least === Infinity ? 0 : least), z = view(ws).z, sx = e.clientX, sy = e.clientY, id = e.pointerId;
      let d = 0, pulled = false;
      h.busy(true);
      if (e.isTrusted) sec.setPointerCapture(id);
      const move = (ev) => {
        if (ev.pointerId !== id) return;
        const px = X ? ev.clientX - sx : ev.clientY - sy;
        if (!pulled && px === 0) return;
        if (!pulled) sec.style.cursor = X ? 'col-resize' : 'row-resize';
        pulled = true;
        const nd = Math.max(lo, (px / z / (X ? size().vw : size().vh)) * 100);
        if (Math.abs(nd - d) < 0.01) return;
        h.moveWindows(ws, m, X ? nd - d : 0, X ? 0 : nd - d);
        d = nd;
      };
      const up = (ev) => {
        if (ev.pointerId !== id) return;
        sec.removeEventListener('pointermove', move);
        sec.removeEventListener('pointerup', up);
        sec.removeEventListener('pointercancel', up);
        sec.removeEventListener('lostpointercapture', up);
        sec.style.cursor = '';
        h.busy(false);
        if (!pulled && ev.type === 'pointerup') h.moveWindows(ws, m, X ? b.far.w + GAP_X : 0, X ? 0 : b.far.h + GAP_Y, true);
        sizeCanvas(ws);
        h.changed(ws);
      };
      sec.addEventListener('pointermove', move);
      sec.addEventListener('pointerup', up);
      sec.addEventListener('pointercancel', up);
      sec.addEventListener('lostpointercapture', up);
      return true;
    }

    /* ---------- three fingers: the next or previous space; four: the next or previous workspace ---------- */
    /* A sideways swipe moves what is on screen and what is beside it with the fingers, as macOS moves its Spaces
       (owner, Nov 2 14:1x): every step of the fingers' travel 1:1 on screen, the momentum after they lift too. With
       three fingers (the trackpad's touch count, fingers()) that is the space on screen and the one beside it in its
       workspace; with four it is the strip of workspaces. Let go (the fingers lift, or no travel for SWIPE_END_MS, or a
       forward flick's momentum dies out), it
       completes past half the view, or after a flick of FLICK or faster not pulled back, going on at the speed it
       had; else it goes back. Reaching the next one completes it at once. At the first or last one, and in a pop-out
       of one (sub-)workspace, it pulls at most SWIPE_RUB and goes back. One step at most per gesture; a gesture that
       goes on by event time after it went back picks up again. The space beside is drawn where its own view shows it,
       one view to the side, each space only inside its own view (app.js peek lays it out, a frame after the first
       step, so that step is handled at once). */
    let slide = null, touch = { n: 0, t: -Infinity, travel: false, was: 0, pinchBy: '' }, touchHeld = false, touchFree = 0;
    const warned = new Set();
    const warnOnce = (k, msg) => { if (!warned.has(k)) { warned.add(k); console.error(msg); } };
    const strip = () => (typeof h.track === 'function' ? h.track() : null);
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const boxOf = (el) => ({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: parseFloat(el.style.width) || 0, h: parseFloat(el.style.height) || 0 });
    /* The part of a window (b, in its space's px) outside view v, as a clip-path. */
    function clipTo(b, v) {
      const { vw, vh } = size();
      return `inset(${Math.max(0, v.y - b.y)}px ${Math.max(0, b.x + b.w - v.x - vw / v.z)}px ${Math.max(0, b.y + b.h - v.y - vh / v.z)}px ${Math.max(0, v.x - b.x)}px)`;
    }
    /* kind: 'space' (two fingers) or 'ws' (three). */
    function slideStart(ws, kind) {
      const order = kind === 'ws' ? h.workspaces() : h.spaces(ws), from = kind === 'ws' ? ws : h.space(ws);
      slide = { kind, ws, from, order, i: order.indexOf(from), gest, dir: 0, to: undefined, off: 0, shown: 0, v: 0, fwd: 0, lt: 0, late: 0, dying: 0, timer: 0, raf: 0, peekRaf: 0, going: false, own: [], peek: [] };
      // the same gesture again after a let-go that took it back (its wheels came late): its last event time and speed go on
      if (gest && gest.carry) Object.assign(slide, gest.carry);
      const el = kind === 'ws' ? strip() : h.canvas(ws);
      if (el) el.style.willChange = 'transform';
      if (kind === 'space' && typeof h.peek !== 'function') warnOnce('peek', 'app.js does not pass peek, so a swipe cannot show the space beside');
      if (kind === 'ws' && (typeof h.goWs !== 'function' || !strip())) warnOnce('goWs', 'app.js does not pass track and goWs, so three fingers cannot move the workspaces');
    }
    /* Toward dir: the one beside that way; for a space, laid out and drawn one view to the side, the one on screen kept to its view. */
    function slideAim(s, dir) {
      slideUnpeek(s);
      s.dir = dir;
      if (s.kind === 'ws') {
        s.to = dir && !h.solo && s.i >= 0 && typeof h.goWs === 'function' && strip() ? s.order[s.i + dir] : undefined;
        return;
      }
      s.to = dir && h.solo !== 'zone' && s.i >= 0 && typeof h.peek === 'function' ? s.order[s.i + dir] : undefined;
      if (s.to === undefined) return;
      const c = h.canvas(s.ws), v0 = view(s.ws);
      s.own = here(s.ws).filter((w) => !winAway(s.ws, w)).map((w) => c && c.querySelector(`:scope > .win[data-id="${CSS.escape(w.id)}"]`)).filter(Boolean);
      s.own.forEach((el) => { el.style.clipPath = clipTo(boxOf(el), v0); });
      s.peekRaf = requestAnimationFrame(() => { if (slide === s && s.dir === dir) slidePeek(s); });
    }
    function slidePeek(s) {
      const { vw } = size(), v0 = view(s.ws), v1 = viewIn(s.ws, s.to);
      s.peek = (h.peek(s.ws, s.to) || []).map((o) => o.el).filter(Boolean);
      s.peek.forEach((el) => {
        const b = boxOf(el), x = ((b.x - v1.x) * v1.z + s.dir * vw) / v0.z + v0.x, y = ((b.y - v1.y) * v1.z) / v0.z + v0.y;
        Object.assign(el.style, { transformOrigin: '0 0', transform: `translate(${x - b.x}px, ${y - b.y}px) scale(${v1.z / v0.z})`, clipPath: clipTo(b, v1) });
      });
    }
    function slideUnpeek(s) {
      cancelAnimationFrame(s.peekRaf);
      s.own.forEach((el) => { el.style.clipPath = ''; });
      s.own = [];
      const peeked = s.peek.length > 0;
      s.peek.forEach((el) => Object.assign(el.style, { transform: '', transformOrigin: '', clipPath: '' }));
      s.peek = [];
      if (peeked) h.peek(s.ws, undefined);
    }
    /* Where it is drawn: a space by the canvas's x offset, the workspaces by the strip's. */
    function slidePaint(s) {
      if (s.kind === 'ws') {
        const t = strip();
        if (t) { t.style.transition = 'none'; t.style.transform = `translateX(calc(${-s.i * 100}% + ${-s.shown}px))`; }
        return;
      }
      rubber = -s.shown;
      show(s.ws, false, true);
    }
    function slideDraw(s) {
      const { vw } = size(), a = Math.abs(s.off);
      s.shown = s.to === undefined ? (Math.sign(s.off) * SWIPE_RUB * a) / (a + SWIPE_RUB * 1.5) : clamp(s.off, -vw, vw);
      slidePaint(s);
    }
    /* One step of the swipe: dx px at event time t. lifted: the touch stream says the fingers came off (three fingers). */
    function slideMove(s, dx, t) {
      if (s.going) return;
      const dt = s.lt ? t - s.lt : 0;
      s.lt = t;
      s.late = Math.max(0, performance.now() - t);
      if (dt > 0) { const v = dx / Math.max(dt, 4); s.v = s.v ? 0.5 * s.v + 0.5 * v : v; }
      s.off += dx;
      const dir = Math.sign(s.off);
      if (dir && dir !== s.dir) slideAim(s, dir);
      if (Math.sign(s.v) === s.dir) s.fwd = Math.max(s.fwd, Math.abs(s.v));
      else if (Math.abs(s.v) > 0.05) { s.fwd = 0; s.dying = 0; }
      if (s.to !== undefined && Math.abs(s.off) >= size().vw) { slideGo(s, true); return; }
      slideDraw(s);
      clearTimeout(s.timer);
      /* by event time: the latest step coming late (a loaded machine) gives it as much longer, not the gesture's latest
         ever (lead, Nov 2 19:1x: that held the board up to a second after the fingers lifted), and it is checked in a
         frame, before which the page is handed any wheels already waiting; fingers still down hold it (their lift lets
         go, as in macOS Spaces) */
      const at = s.lt;
      s.timer = setTimeout(() => requestAnimationFrame(() => { if (s.lt === at && !(s.byTouch && touch.n >= 3)) slideLetGo(s, s.fwd >= FLICK); }), SWIPE_END_MS + Math.min(s.late, 1000));
      /* a forward flick slowing to nothing: its momentum dying out, or fingers about to come back; after DYING_MS of
         event time without coming back, it was the momentum, and the switch goes on from here */
      if (s.to !== undefined && s.fwd >= FLICK && Math.abs(s.v) < FLICK / 6 && !(s.byTouch && touch.n >= 3)) {
        if (!s.dying) s.dying = t;
        else if (t - s.dying >= DYING_MS) slideLetGo(s, true);
      } else s.dying = 0;
    }
    /* Let go: on past half the view, or after a flick not pulled back since (flicked), else back. */
    function slideLetGo(s, flicked) {
      if (slide !== s || s.going) return;
      slideGo(s, s.to !== undefined && (Math.abs(s.off) >= size().vw / 2 || flicked));
    }
    /* On to the one beside (done) or back, from where it is drawn at the speed it had; the rest of the gesture's
       steps go nowhere while it moves. */
    function slideGo(s, done) {
      clearTimeout(s.timer);
      s.going = true;
      s.goingOn = done;
      if (s.gest) s.gest.done = true;
      const from = s.shown, to = done ? s.dir * size().vw : 0, dist = Math.abs(to - from);
      const ms = dist < 0.5 ? 0 : clamp((3 * dist) / Math.max(Math.abs(s.v), 0.8), 140, done ? 380 : 320), t0 = performance.now();
      const frame = (now) => {
        if (slide !== s) return;
        if (h.current() !== s.ws || (s.kind === 'space' && h.space(s.ws) !== s.from)) { slideEnd(s, false); return; }
        const p = ms ? clamp((now - t0) / ms, 0, 1) : 1;
        s.shown = from + (to - from) * ease(p);
        slidePaint(s);
        if (p < 1) s.raf = requestAnimationFrame(frame);
        else slideEnd(s, done);
      };
      s.raf = requestAnimationFrame(frame);
    }
    /* The one beside becomes the one on screen exactly where it is drawn, or the one on screen is alone again. */
    function slideEnd(s, done) {
      cancelAnimationFrame(s.raf);
      clearTimeout(s.timer);
      if (slide === s) slide = null;
      const g = s.gest;
      if (g) {
        if (done) { g.switched = true; g.last = Math.max(g.last, performance.now()); } else if (!g.switched) { g.done = false; g.carry = { lt: s.lt, v: s.v, fwd: s.fwd }; }
      }
      if (s.kind === 'ws') {
        const t = strip();
        if (t) t.style.willChange = '';
        if (typeof h.goWs === 'function') h.goWs(done ? s.i + s.dir : s.i, { still: true });
        return;
      }
      rubber = 0;
      const c = h.canvas(s.ws);
      if (c) c.style.willChange = '';
      if (done) {
        cancelAnimationFrame(s.peekRaf);
        s.own.forEach((el) => { el.style.clipPath = ''; });
        h.showSpace(s.ws, s.to, { still: true });
        show(s.ws, false);
        s.peek.forEach((el) => Object.assign(el.style, { transform: '', transformOrigin: '', clipPath: '' }));
      } else {
        slideUnpeek(s);
        show(s.ws, false);
      }
    }
    /* Anything else that takes the space (a press, a pinch) ends a swipe where it is going. */
    function slideStop() {
      const s = slide;
      if (!s) return;
      slideEnd(s, s.going && s.to !== undefined && Math.abs(s.shown) > size().vw / 2);
    }
    /* The trackpad's touch count from the native stream: while three or more fingers are down, pages are covered so
       their wheels come here and nothing scrolls under them; the fingers lifting let a swipe go at once. travel: the
       touches' own sideways px since the last report, which the fingers then follow instead of the wheels. Three move
       the spaces of the workspace, WS_FINGERS the workspaces. pinch: three fingers spread (above 1) or closed by that
       ratio since the last report, at x, y (the pointer, in this window's px); it zooms the space there as a pinch's
       wheels would. A touch's pinch is the stream's or the wheels', whichever came first (pinchBy), never both, and a
       touch that pinched steps nothing after. */
    function fingers(n, t, travel, pinch, x, y) {
      const was = touch.n, same = n >= 3 && was >= 3;
      touch = { n, t, travel: Number.isFinite(travel), was: n >= 3 ? n : was >= 3 ? was : 0, pinchBy: same ? touch.pinchBy : '' };
      _counts.push({ n, t });
      while (_counts.length && t - _counts[0].t > 600) _counts.shift();

      if (n >= 3) {
        clearTimeout(touchFree);
        if (!touchHeld) { touchHeld = true; h.busy(true); }
        if (pinch > 0) {
          // a two-finger pinch is marked 'win' so it becomes no step, though its wheels, not its touches, do the zooming
          const kind = pinchKind(t);
          if (kind === 'win') touch.pinchBy = 'win';
          else {
            if (!touch.pinchBy) touch.pinchBy = 'stream';
            if (touch.pinchBy === 'stream') zoomAt(-100 * Math.log(pinch), x, y, t, 'stream');
          }
        } else if (Number.isFinite(travel) && travel && !touch.pinchBy) takeFingers(n >= WS_FINGERS ? 'ws' : 'space', travel, t);
      } else if (was >= 3) {
        if (slide && slide.byTouch) slideLetGo(slide, slide.fwd >= FLICK);
        touchFree = setTimeout(() => { if (touchHeld && touch.n < 3) { touchHeld = false; h.busy(false); } }, GAP_MS);
      }
    }
    /* A step of a three- or four-finger swipe (kind 'space' or 'ws'): dx px at time t, from the touches or (with no
       travel in the stream) the wheels. A change in the count mid-swipe starts the other kind. */
    function takeFingers(kind, dx, t) {
      if (!gest || t - gest.last > GAP_MS || gest.owner !== 'fingers' || gest.kind !== kind) {
        if (slide) slideStop();
        gest = { start: t, last: t, sx: 0, sy: 0, travel: 0, owner: 'fingers', kind, acc: 0, done: false, switched: false, bare: false };
      }
      gest.last = Math.max(gest.last, t);
      if (gest.done) return;
      stopFling();
      if (!slide && h.current()) { slideStart(h.current(), kind); slide.byTouch = true; }
      if (slide && slide.kind === kind) slideMove(slide, dx, t);
    }
    /* macOS's own swipe (Electron's 'swipe', passed on by touch.js), dir 'left' or 'right'. With Swipe between pages on
       two or three fingers it comes once at the end of a quick three-finger flick, and macOS keeps the third finger
       from the touch stream (MAC_NOTES 32), so on such a Mac this is all Flow sees of three fingers: one step to the
       space beside, as three fingers moving would. With Flow's trackpad settings on (touch.js: macOS's three-finger
       swipes off) it does not come at all. It also comes at the end of some two-finger swipes (owner, Nov 7, 01/14:
       two fingers switched workspaces; 10 of the 79 in the owner's run 3, MAC_NOTES 28): one within GAP_MS of two
       fingers that moved TWO_PX is theirs, and does nothing. */
    function systemSwipe(dir, t) {
      if (gest && gest.owner !== 'fingers' && t - gest.last <= GAP_MS && gest.travel >= TWO_PX) return;
      // the end of a swipe the touch stream already followed (three or four fingers it saw): that gesture's own end
      if (touch.n >= 3 || (t - touch.t <= GAP_MS && touch.was >= 3)) return;
      const ws = h.current();
      if (!ws || h.solo === 'zone') return;
      stopFling();
      slideStop();
      gest = null;
      slideStart(ws, 'space');
      const s = slide;
      slideAim(s, dir);
      if (s.to === undefined) {
        // at the first or last space it pulls a little and comes back, as a swipe there does
        s.shown = (dir * SWIPE_RUB) / 3;
        slidePaint(s);
      }
      slideGo(s, s.to !== undefined);
    }
    /* Two fingers (wheels) are one gesture with one owner, chosen at its start: three or more fingers down (the touch
       stream) give it to them; else the board (pan), when it started over bare desktop or moves mostly sideways over
       something that cannot scroll that way; else content (a terminal, page or note scrolls as before). The board moves
       with the fingers 1:1 in any direction, and macOS's momentum after they lift carries it on. Steadied: a gesture
       that starts AXIS times more along one axis than the other keeps to that axis, so a hand's wobble does not shake
       the board, until a step moves more across it than along it (the fingers turned); over a window only its sideways
       part moves the board, so up and down stay the window's. The gap that ends a gesture is measured by
       event time, so events that waited behind a slow one stay part of it. bare: the gesture's first event was over
       bare desktop. late: a page's wheel, whose page can tell it used the wheel only after (it scrolled something
       beside the wheel's path, as a spreadsheet does); such a wheel hands the gesture back to the page. Returns whether
       nav took this event. */
    function take(dx, dy, t, canScroll, bare, late) {
      if (touch.n >= 3) {
        if (!touch.travel && !touch.pinchBy && Math.abs(dx) >= Math.abs(dy)) takeFingers(touch.n >= WS_FINGERS ? 'ws' : 'space', dx, t);
        return true;
      }
      if (!gest || t - gest.last > GAP_MS || gest.owner === 'fingers') {
        if (slide && !slide.going) slideStop();
        gest = { start: t, last: t, sx: 0, sy: 0, travel: 0, owner: '', axis: '', acc: 0, done: false, switched: false, bare: !!bare };
      }
      gest.last = Math.max(gest.last, t);
      gest.travel += Math.abs(dx) + Math.abs(dy);
      if (!gest.owner) {
        gest.sx += dx;
        gest.sy += dy;
        if (Math.abs(gest.sx) + Math.abs(gest.sy) < DECIDE_PX) return Math.abs(dx) > Math.abs(dy) || gest.bare;
        const side = Math.abs(gest.sx) > Math.abs(gest.sy);
        gest.owner = gest.bare || (side && !canScroll(gest.sx > 0 ? 1 : -1)) ? 'pan' : 'content';
        if (gest.owner === 'content') return false;
        stopFling();
        gest.axis = !gest.bare ? 'x' : Math.abs(gest.sx) > AXIS * Math.abs(gest.sy) ? 'x' : Math.abs(gest.sy) > AXIS * Math.abs(gest.sx) ? 'y' : '';
        dx = gest.sx;
        dy = gest.sy;
      }
      if (gest.owner === 'pan' && late && canScroll(dx > 0 ? 1 : -1)) gest.owner = 'content';
      if (gest.owner !== 'pan') return false;
      // a step that moves more across a kept axis than along it, by DECIDE_PX or more, is the fingers turning: free
      const across = gest.axis === 'x' ? dy : dx, along = gest.axis === 'x' ? dx : dy;
      if (gest.bare && gest.axis && Math.abs(across) > Math.abs(along) && Math.abs(across) >= DECIDE_PX) gest.axis = '';
      panBy(gest.axis === 'y' ? 0 : dx, gest.axis === 'x' ? 0 : dy);
      return true;
    }

    let _counts = [];   // { n, t } of the last 600 ms of counts, for a pinch's start (pinchKind)
    /* What a pinch at t (performance clock) is for, decided once, at its first event: 'space' when three or more fingers
       were down as it began, 'win' under two. His two fingers land one after the other and a third one brushes in
       mid-pinch for a moment, which used to flip a page pinch into a workspace zoom (owner, Nov 8), so it is decided
       once and latched for the whole pinch: only no wheel for GAP_MS starts another. Three fingers are looked for a
       moment back too (PINCH_START_MS), in case the third touch reaches here after the pinch's first wheel. With no
       touch stream at all (no module), touch.n stays 0 and every pinch is the window's, as it was without the counts. */
    let pinchK = null;   // { kind, last }
    function pinchKind(t) {
      if (pinchK && t - pinchK.last <= GAP_MS) { pinchK.last = Math.max(pinchK.last, t); return pinchK.kind; }
      let peak = touch.n;
      for (const c of _counts) if (t - c.t <= PINCH_START_MS && c.n > peak) peak = c.n;
      pinchK = { kind: peak >= 3 ? 'space' : 'win', last: t };
      return pinchK.kind;
    }
    let panSave = 0;
    function panBy(dx, dy) {
      const ws = h.current();
      if (!ws) return;
      const v = view(ws);
      showPan(ws, v.x + dx / v.z, v.y + dy / v.z, v.z);
      clearTimeout(panSave);
      panSave = setTimeout(() => settle(ws), GAP_MS);
    }

    /* ---------- pinch: zoom the space around the fingers ---------- */
    /* Chromium hands a trackpad pinch over as ctrl-wheel events, zoom factor exp(-deltaY / 100) per event. The canvas
       point under the fingers stays put, wherever they are, as on a Miro board (owner, Nov 1 18:53; lead, Nov 2 21:1x):
       pinching in over empty board zooms into that spot, and pinching out draws everything toward the fingers, so what is
       in view stays in view. Only the look changes: windows keep their layout size, so terminals keep their columns and
       rows. Pinching back, actual size holds until the fingers go 12% further: that is the way back to 100%. Nothing
       else moves the zoom or the view.
       Like a swipe, a pinch is one gesture by event time (t), so events that waited behind a slow frame stay part of it,
       and its end, which saves the view, waits as long again as the last event waited, and for whatever is held (a
       window, the desktop) to be let go; once another space is on screen, there is nothing to save. */
    /* The space at zoom z, the point px, py of the view (px from its top left) staying put. */
    function zoomAround(ws, z, px, py) {
      const v = view(ws), { vw, vh } = size();
      Object.assign(ws, { zoom: z, pan: toPct(v.x + px / v.z - px / z, vw), panY: toPct(v.y + py / v.z - py / z, vh) });
    }
    /* by: what drives the pinch, 'stream' (the touches) or 'wheel' (Chromium's). */
    function zoomAt(dy, cx, cy, t, by) {
      const ws = h.current();
      if (!ws) return;
      stopFling();
      slideStop();
      const r = vp.getBoundingClientRect();
      if (!pinching || pinching.ws !== ws || t - pinching.last > GAP_MS) pinching = { ws, last: t, hold: null };
      pinching.by = by;
      pinching.last = Math.max(pinching.last, t);
      const v = view(ws), was = Math.log(v.z), d = -dy / 100;
      let lz = was + d;
      if (pinching.hold !== null) pinching.hold += d;
      else if (was !== 0 && Math.sign(lz) !== Math.sign(was)) pinching.hold = 0;   // the event that crosses it stops at 100%
      if (pinching.hold !== null) {
        lz = Math.abs(pinching.hold) < HOLD ? 0 : pinching.hold - Math.sign(pinching.hold) * HOLD;
        if (lz !== 0) pinching.hold = null;
      }
      const z = clamp(Math.exp(lz), zmin(ws), ZMAX), sp = h.space(ws);
      const px = cx - r.left, py = cy - r.top;
      if (z !== v.z) {
        zoomAround(ws, z, px, py);
        rubber = 0;
        show(ws, false);
        if (grab && grab.ws === ws) grab.rebase();
      }
      clearTimeout(pinchTimer);
      const end = () => {
        if (document.body.classList.contains('busy')) { pinchTimer = setTimeout(end, 250); return; }
        if (h.space(ws) === sp) h.changed(ws);
      };
      pinchTimer = setTimeout(end, 250 + clamp(performance.now() - t, 0, 1000));
    }
    /* A pinch (Chromium's ctrl-wheel) zooms the space only with three fingers down (the owner's Miro zoom, MAC_NOTES
       58 a / 60). With two it belongs to what is under them (58 b): over a window it goes to that window as a bubbling
       'flow-pinch' { factor, x, y, t } (factor the zoom ratio of this event; its note or terminal zooms itself; a page
       zooms itself in guest-preload and never sends its pinch here), and over bare desktop it does nothing. A space's
       pinch keeps its last wheels, which can come after the lift, by event time. */
    function pinchAt(e) {
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      const kind = pinchKind(e.timeStamp);
      if (kind === 'space') {
        if (!touch.pinchBy) touch.pinchBy = 'wheel';
        if (touch.pinchBy === 'wheel') zoomAt(dy, e.clientX, e.clientY, e.timeStamp, 'wheel');
        return;
      }
      const win = e.target.closest && e.target.closest('.win');
      if (win) e.target.dispatchEvent(new CustomEvent('flow-pinch', { bubbles: true, detail: { factor: Math.exp(-dy / 100), x: e.clientX, y: e.clientY, t: performance.timeOrigin + e.timeStamp } }));
    }
    vp.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        pinchAt(e);
        return;
      }
      if (pinching && e.timeStamp - pinching.last < GAP_MS) return;
      const bare = !!e.target.closest && !e.target.closest('.win, .away') && !!e.target.closest('.ws');
      if (take(e.deltaX, e.deltaY, e.timeStamp, (dir) => scrollsX(e.target, dir, vp), bare)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, { capture: true, passive: false });

    /* ---------- removing a sub-workspace or a workspace ---------- */
    /* Never ends an agent: its terminals go to the closed list of the workspace that stays, sessions running. The toast
       offers undo, which puts everything back where it was. */
    /* A removed workspace's terminals, by kind (a shell is no agent), and where the sidebar shows them: dimmed under the
       workspace that holds them now (browse, batch 8) */
    const agents = (list, where) => {
      if (!list.length) return '';
      const kinds = new Set(list.map((w) => (w.type === 'team' ? 'team' : w.cmd === 'shell' ? 'shell' : 'agent'))), one = kinds.size === 1 ? [...kinds][0] : 'terminal';
      return `. ${list.length === 1 ? `its ${one} still runs` : `its ${list.length} ${one}s still run`}, dimmed under ${where} in the sidebar`;
    };
    const isTerm = (w) => w.type === 'term' || w.type === 'team';
    /* A workspace as itself or by its index (the sidebar has indexes, the pill menu the workspace). */
    const wsOf = (x) => (typeof x === 'number' ? h.workspaces()[x] : x);
    /* Nothing in a sub-workspace goes with it (lead, Nov 2 15:5x): its windows move into the space it is in (main at
       the top) as they are, agents running and pages loaded, together as they were arranged and each at its own size,
       over nothing: where that space's view has room for all of them, else past its last window at its top. Its own
       sub-workspaces move up one level whole, and its sections with them (batch 9). Undo puts it and everything back
       exactly. */
    function removeZone(which, sid) {
      const ws = wsOf(which), zn = ws && zoneOf(ws, sid);
      if (!zn) return false;
      /* Open in a pop-out (lead, Nov 2 16:4x): that window closes first, the normal way (its page saves, as on any pop-out
         close), its windows come back here, and then it goes as any sub-workspace does; undo opens the pop-out again
         where it was, at its size. It always goes (lead 20:1x: nothing refuses): should the close fail, its window closes
         itself once its space is gone (app.js applyRemote), and undo cannot open it again. */
      if (awayOn && away.has(awayKey(ws.id, sid))) {
        let frame = null;
        window.flow.closePopout({ ws: ws.id, zone: sid })
          .then((f) => { frame = f; return window.flow.popouts().then(setAway); })
          .catch((err) => console.error(`flow: could not close the window that holds ${zn.name}; it closes itself once ${zn.name} is removed, and undo will not open it again`, err))
          .then(() => { if (zoneOf(ws, sid)) removeHere(ws, sid, frame); });
        return true;
      }
      return removeHere(ws, sid, null);
    }
    /* frame: the pop-out it was in, to open again on undo. */
    function removeHere(ws, sid, frame) {
      const zn = zoneOf(ws, sid), at = ws.zones.indexOf(zn), shown = h.space(ws) === sid;
      // nested sub-workspaces (batch 9, lead): everything in it goes one level up, to the space it is in (main at the top)
      const up = zn.parent && zoneOf(ws, zn.parent) ? zn.parent : null, kids = ws.zones.filter((z) => z.parent === sid);
      const wins = ws.windows.filter((w) => inSpace(w, sid)), shut = ws.closed.filter((w) => inSpace(w, sid));
      const was = new Map([...wins, ...shut].map((w) => [w, { x: w.x, y: w.y, w: w.w, h: w.h, max: w.max }]));
      if (shown) h.showSpace(ws, up);
      wins.forEach((w) => { if (w.max) Object.assign(w, w.max); w.max = null; });
      if (wins.length) {
        // one spot for the group, found among main's own windows while these are still research's
        const x0 = Math.min(...wins.map((w) => w.x)), y0 = Math.min(...wins.map((w) => w.y));
        const bw = Math.max(...wins.map((w) => w.x + w.w)) - x0, bh = Math.max(...wins.map((w) => w.y + w.h)) - y0;
        const fit = freeSpot(ws, bw, bh, up, true), to = fit && fit.w >= bw - 0.01 && fit.h >= bh - 0.01 ? fit : { x: contentEnd(ws, null, up) + 1.5, y: TOP };
        wins.forEach((w) => { w.x += to.x - x0; w.y += to.y - y0; });
      }
      [...wins, ...shut].forEach((w) => { if (up) w.zone = up; else delete w.zone; });
      // its own sub-workspaces move up one level whole, in their places; its sections go up too (app.js, notes)
      kids.forEach((z) => { if (up) z.parent = up; else delete z.parent; });
      const unSections = typeof h.moveSections === 'function' ? h.moveSections(ws, sid, up) : null;
      ws.zones.splice(at, 1);
      h.refresh(ws);
      h.changed(ws);
      // into a space open in a pop-out: that window shows them now, so this one lets their pages and terminals go
      if (up && spaceAway(ws, up)) wins.forEach((w) => h.release(w));
      h.toast(`removed ${zn.name}`, 8000, { label: 'undo', run: () => {
        if (zoneOf(ws, sid)) return;
        ws.zones.splice(Math.min(at, ws.zones.length), 0, zn);
        kids.forEach((z) => { z.parent = sid; });
        if (unSections) unSections();
        was.forEach((g, w) => { if (ws.windows.includes(w) || ws.closed.includes(w)) Object.assign(w, g, { zone: sid }); });
        if (shown) h.showSpace(ws, sid);
        h.refresh(ws);
        h.changed(ws);
        if (frame) h.popOut(ws.id, sid, frame);
      } });
      return true;
    }
    function removeWorkspace(which) {
      const ws = wsOf(which);
      return ws && typeof h.closeWorkspace === 'function' ? h.closeWorkspace(ws) : false;
    }

    /* ---------- a popped-out space lives only in its pop-out ---------- */
    /* In the main window a space open in a pop-out has no page and no terminal client of its own (each page loads once,
       each terminal has one tmux client) and shows only its name and "in another window"; a click brings that window
       forward. A pop-out of a whole workspace takes all its spaces. The pop-out itself shows its space as usual. */
    let away = new Set();
    /* Only once app.js passes release and refresh (its side of this) does a pop-out take a space away from here. */
    const awayOn = !h.solo && typeof h.release === 'function' && typeof h.refresh === 'function';
    const awayKey = (wsId, zid) => `${wsId}|${zid || ''}`;
    const spaceAway = (ws, zid) => awayOn && (away.has(awayKey(ws.id, null)) || (!!zid && away.has(awayKey(ws.id, zid))));
    const winAway = (ws, w) => spaceAway(ws, w.zone || null);
    const awayEls = new Map();
    function showAway(ws) {
      const c = ws && h.canvas(ws), sec = c && c.parentElement;
      if (!sec) return;
      const zid = h.space(ws), on = spaceAway(ws, zid);
      let el = awayEls.get(ws.id);
      if (!on) { if (el) el.style.display = 'none'; return; }
      if (!el || el.parentElement !== sec) {
        el = document.createElement('div');
        el.className = 'away';
        el.style.cssText = 'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer;user-select:none;-webkit-user-select:none';
        el.addEventListener('click', () => bringAway(ws, h.space(ws)));
        sec.appendChild(el);
        awayEls.set(ws.id, el);
      }
      const zn = zoneOf(ws, zid), name = away.has(awayKey(ws.id, null)) || !zn ? ws.name : zn.name;
      if (el.dataset.name !== name) {
        const line = (text, css) => Object.assign(document.createElement('div'), { textContent: text, style: css });
        el.replaceChildren(line(name, 'color:#cfcfd4;font-size:14px'), line('in another window', 'color:#8d8d93;font-size:12px'));
        el.dataset.name = name;
      }
      el.style.display = 'flex';
    }
    /* Brings forward the pop-out that holds a space of this workspace (zid null: the main space). */
    function bringAway(ws, zid) {
      const space = { ws: ws.id, zone: away.has(awayKey(ws.id, null)) ? null : zid };
      window.flow.focusPopout(space).then((ok) => {
        if (!ok) console.warn(`flow: no window holds ${space.ws}${space.zone ? ` › ${space.zone}` : ''} any more, so none came forward`);
      }, (err) => console.error('flow: could not bring the pop-out forward', err));
    }
    function setAway(list) {
      if (!awayOn) return;
      const before = away;
      away = new Set((Array.isArray(list) ? list : []).map((p) => awayKey(p.ws, p.zone)));
      h.workspaces().forEach((ws) => {
        const was = (w) => before.has(awayKey(ws.id, null)) || (!!w.zone && before.has(awayKey(ws.id, w.zone)));
        let changed = false;
        ws.windows.forEach((w) => {
          const now = winAway(ws, w), then = was(w);
          if (now === then) return;
          changed = true;
          if (now) h.release(w);
        });
        if (changed) h.refresh(ws);
        if (takeBack(ws)) h.changed(ws);
      });
      showAway(h.current());
    }
    /* A space's view moves with it between windows. Its pop-out keeps the view it shows as popView (app.js); once the
       space is not in a pop-out, that view is the space's here: on screen, or kept for it. */
    function takeBack(ws) {
      let n = 0;
      [null, ...(ws.zones || []).map((zn) => zn.id)].forEach((sid) => {
        const zn = zoneOf(ws, sid), ho = zn || ws, pv = ho.popView;
        if (!pv || spaceAway(ws, sid)) return;
        delete ho.popView;
        n++;
        if (pv.old) return;
        const v = viewOf(pv);
        if ((sid || null) === h.space(ws)) { Object.assign(ws, v); sizeCanvas(ws); }
        else if (zn) Object.assign(zn, v);
        else Object.assign(ws, { mainPan: v.pan, mainPanY: v.panY, mainZoom: v.zoom });
      });
      return n;
    }
    let ready = Promise.resolve();
    if (awayOn && (!window.flow.popouts || !window.flow.onPopouts)) {
      console.error('flow.popouts is missing (preload), so a popped-out space also stays live in the main window');
    } else if (awayOn) {
      ready = window.flow.popouts().then(setAway, (err) => console.error('flow: could not read which spaces are popped out', err));
      window.flow.onPopouts(setAway);
    }

    return {
      /* geometry app.js calls in place of its own */
      setPan, sizeCanvas, edges, visible, toSpace, bottom, collides, contentStart, contentEnd, freeSpot, openSpot, placeAt, fillRect,
      reveal, fitStart, recover, swap, zoom: (ws) => view(ws).z, edgePan, placeRoom, beside, clear, arrange, sideOf,
      cutAt, canCut, addAt, extendRight, undoSpace, spaceUndoReady, spaceAt,
      /* ⌘0 with no page in front (app.js routes it; lead, Nov 2 14:2x): the space back to 100% around the middle of the
         view, the way back to default besides pinching back. */
      actualSize: (ws) => { stopFling(); const { vw, vh } = size(); zoomAround(ws, 1, vw / 2, vh / 2); setView(ws, view(ws), true); h.changed(ws); },
      /* The view glides so box (in % of the view at 100%) shows whole and as large as fits, never past 100%: the overview
         and a group's name (owner Nov 7, image 02-03). One asked-for move, like actualSize; a box smaller than the view is
         centred at 100%. */
      frameTo: (ws, box, margin = 0.05) => {
        if (!box || !(box.w > 0) || !(box.h > 0)) return;
        stopFling();
        const { vw, vh } = size(), bw = (box.w / 100) * vw, bh = (box.h / 100) * vh;
        const z = clamp(Math.min((vw * (1 - 2 * margin)) / bw, (vh * (1 - 2 * margin)) / bh, 1), zmin(ws), ZMAX);
        const cx = ((box.x + box.w / 2) / 100) * vw, cy = ((box.y + box.h / 2) / 100) * vh;
        setView(ws, { x: cx - vw / z / 2, y: cy - vh / z / 2, z }, true);
        h.changed(ws);
      },
      removeZone, removeWorkspace,
      /* The space on screen as a sheet, in % of the view (what the overview draws), and the overview's way to move over it. */
      sheet: (ws) => ({ w: spaceEnd(ws), h: spaceBottom(ws) }), goTo,
      /* Is this window's space open in a pop-out (main window only)? app.js gives it no body and no frame then. */
      away: (ws, w) => winAway(ws, w),
      /* Brings forward the pop-out that holds this window's space. */
      focusAway: (ws, w) => bringAway(ws, w.zone || null),
      /* Resolves once the main window knows which spaces are popped out; app.js awaits it before building windows. */
      ready,
      /* Whether app.js passes release and refresh, so a popped-out space lives only in its pop-out. */
      popoutsLive: awayOn,
      /* Whether a gesture nav took (two fingers moving the board, three or four moving spaces or workspaces) still goes
         on at event time t (performance clock): a wheel then belongs to it, not to a page under the fingers. */
      swiping: (t) => touch.n >= 3 || (!!gest && (gest.owner === 'pan' || gest.owner === 'fingers') && t - gest.last <= GAP_MS),
      /* The trackpad from main (touch.js): { n, t, dx, pinch, x, y } n fingers down (0 when lifted) at t epoch ms; dx,
         when the stream has it, the touches' sideways px since the last report (MAC_NOTES 25); pinch, their spread's
         ratio since then, at x, y; or { swipe: 'left' | 'right', t }, macOS's own swipe (systemSwipe). */
      fingers: (f) => {
        if (!f) return;
        const t = Number.isFinite(+f.t) ? +f.t - performance.timeOrigin : performance.now();
        if (f.swipe === 'left' || f.swipe === 'right') { systemSwipe(f.swipe === 'left' ? 1 : -1, t); return; }
        fingers(Math.max(0, +f.n || 0), t, f.dx === undefined || f.dx === null ? undefined : +f.dx, +f.pinch || 0, +f.x || 0, +f.y || 0);
      },
      /* A page's wheel event (page.js onWheel): dx, dy in px, t epoch ms, used when the page could use it. behind: the
         page is behind another window; the wheel reached nav from the window itself (app.js backPageWheel sends the page
         a copy), and a sideways swipe there moves to the next space at once, whatever the page does with it: the page
         is brought in front to scroll it sideways. So its report is not used. */
      wheel: (w) => {
        if (!w || w.ctrl || w.behind) return;
        const t = Number.isFinite(+w.t) ? +w.t - performance.timeOrigin : performance.now();
        if (pinching && t - pinching.last < GAP_MS) return;
        take(+w.dx || 0, +w.dy || 0, t, () => !!w.used, false, true);
      },
      /* A page's pinch, from its preload through page.js (onPinch): x, y in this window's CSS px; t epoch ms. Only a
         three-finger pinch zooms the space (MAC_NOTES 60) and this returns true; under two the page zooms itself and this
         returns false (the page takes a pinch it took itself before it reaches here at all). Which a pinch is comes from
         pinchKind, latched once: never from the count at one event alone. */
      pinch: (p) => {
        if (!p) return false;
        const t = Number.isFinite(+p.t) ? +p.t - performance.timeOrigin : performance.now();
        if (pinchKind(t) !== 'space') return false;
        if (!touch.pinchBy) touch.pinchBy = 'wheel';
        if (touch.pinchBy !== 'wheel') return false;
        zoomAt((+p.deltaY || 0) * (p.deltaMode === 1 ? 16 : 1), +p.x || 0, +p.y || 0, t, 'wheel');
        return true;
      },
    };
  }

  window.FlowNav = { mount, viewOf };
})();




