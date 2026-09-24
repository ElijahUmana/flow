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
