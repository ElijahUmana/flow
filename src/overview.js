/* FlowOverview: the space on screen in miniature at the bottom right, there only when the owner reaches for it (owner,
   Nov 1 23:40; shown while navigating it was "just fucking distracting", 18:48). It comes up when the pointer, with no
   button held, stays a moment at the bottom right while the view is still and a window is at least partly off screen;
   over a window only the bare strip at the very bottom counts, as for the dock, and a window's resize grip never does.
   It goes when the pointer leaves or presses a resize grip, and hidden it takes no clicks. The board has no edge (owner
   Nov 2 14:33, "why am i seeing this boxed thing"), so it draws no box: only the windows as shapes over what they span,
   and the view as a frame, which runs off the map's side when the view is out on empty board. So the map never rescales
   as the view moves, and a click lands where it points. A click on an empty part takes the view there at its zoom, a
   click on a window's shape goes to that window as its sidebar row does, and a drag moves the view. */
(() => {
'use strict';

const RIGHT = 28;      // px in from the right side, so the 24 px strip where a double-click adds room stays bare
const BOTTOM = 12;     // px up from the bottom: the dock's line
const W = 200, H = 120;  // px: the map's usual largest size
const MIN_W = 60, MIN_H = 32, WIDE = 320, TALL = 240; // a thin map may grow wider up to WIDE, a narrow one taller up to TALL
const LEAST_W = 24, LEAST_H = 8; // smaller than this, a map is no use
const NEAR = 20;       // px left of it where the pointer brings it up
const KEEP = 32, KEEP_UP = 4; // px beside it and above it that keep it up
const EDGE = 12;       // the bare strip at the bottom that brings it up over a window
const ZONE_H = 64;     // px from the bottom that bring it up even when the map is thin
const DOCK_GAP = 52;   // px between the dock and the map, so their two approach areas never meet
const DWELL_MS = 90;   // the pointer stays this long first: passing through on its way elsewhere it shows nothing
const IN_MS = 140, OUT_MS = 170, LINGER_MS = 250;
const MARGIN = 2;      // % of a view around what the map spans, so no shape touches its border
const CLICK_PX = 3;

function mount(h) {
  const el = document.createElement('div');
  el.className = 'ov';
  h.stage.appendChild(el);
  let shown = false, timer = 0, dwell = 0, anim = null, raf = 0, lastX = 0, lastY = 0, held = false, drawn = null, map = null;
  let working = false;   // a press at the bottom right: the owner works there (a note made there), the map waits

  /* The space on screen and the view, in % of the view at zoom 1, and what the map spans: its windows and the view as
     it was when the map came up, kept while it is up, so a click that moves the view never moves the map under the
     pointer. It is there whenever the owner reaches for it (owner, Nov 7 02/14: "always be available"), with every
     window in view and on an empty board too: then it shows just the view. */
  let span = null;
  function scene() {
    const ws = h.current();
    if (!ws || h.nav.away(ws, { zone: h.space(ws) })) return null;
    const v = h.nav.visible(ws), gs = h.windows(ws).map((w) => h.geo(w));
    if (!span || span.ws !== ws) {
      const all = [...gs, v];
      span = { ws,
        x0: Math.min(...all.map((g) => g.x)) - MARGIN, y0: Math.min(...all.map((g) => g.y)) - MARGIN,
        x1: Math.max(...all.map((g) => g.x + g.w)) + MARGIN, y1: Math.max(...all.map((g) => g.y + g.h)) + MARGIN };
    }
    return { ws, v, x0: span.x0, y0: span.y0, x1: span.x1, y1: span.y1 };
  }
  /* The map's scale (px per px of the space at zoom 1) and its box on screen; null when the window is too narrow. */
  function measure(s) {
    const { vw, vh } = h.size(), sw = ((s.x1 - s.x0) / 100) * vw, sh = ((s.y1 - s.y0) / 100) * vh;
    let k = Math.min(W / sw, H / sh);
    if (sh * k < MIN_H) k = Math.min(MIN_H / sh, WIDE / sw);
    if (sw * k < MIN_W) k = Math.min(MIN_W / sw, TALL / sh);
    const st = h.stage.getBoundingClientRect(), d = h.dock && h.dock.getBoundingClientRect();
    const room = st.right - RIGHT - 2 - (d && d.width ? d.right + DOCK_GAP : st.left + 8);
    if (room < MIN_W) return null;
    if (sw * k > room) k = room / sw;
    const w = sw * k, hh = sh * k;
    if (w < LEAST_W || hh < LEAST_H) return null;
    return { k, vw, vh, w, h: hh, left: st.right - RIGHT - w - 2, top: st.bottom - BOTTOM - hh - 2, st };
  }
  /* What is on screen now: the canvas moves while the view glides, so the frame follows its transform. */
  function onScreen(s, m) {
    const c = h.canvas(s.ws), t = c ? getComputedStyle(c).transform : 'none';
    if (!t || t === 'none') return s.v;
    const x = new DOMMatrixReadOnly(t), z = x.a || 1;
    return { x: (-x.m41 / z / m.vw) * 100, y: (-x.m42 / z / m.vh) * 100, w: 100 / z, h: 100 / z };
  }
  /* Shapes are kept and moved, not rebuilt, so the one under the pointer stays lit while the view glides. */
  const frameEl = el.appendChild(document.createElement('u')), shapes = new Map();
  const css = (e, q) => {
    const s = `left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px`;
    if (e.dataset.at !== s) { e.style.cssText = s; e.dataset.at = s; }
  };
  function draw(s, m) {
    const lx = (x) => (x / 100) * m.vw * m.k, ly = (y) => (y / 100) * m.vh * m.k, r1 = (n) => Math.round(n * 2) / 2;
    const px = (x) => lx(x - s.x0), py = (y) => ly(y - s.y0);
    const rects = h.windows(s.ws).sort((a, b) => (a.z || 0) - (b.z || 0)).map((w) => {
      const g = h.geo(w);
      return { id: w.id, x: r1(px(g.x)), y: r1(py(g.y)), w: r1(Math.max(2, lx(g.w))), h: r1(Math.max(2, ly(g.h))) };
    });
    const v = onScreen(s, m), f = { x: r1(px(v.x)), y: r1(py(v.y)), w: r1(lx(v.w)), h: r1(ly(v.h)) };
    const wpx = `${r1(m.w) + 2}px`, hpx = `${r1(m.h) + 2}px`;
    if (el.style.width !== wpx) el.style.width = wpx;
    if (el.style.height !== hpx) el.style.height = hpx;
    const order = rects.map((q) => q.id).join('\n');
    shapes.forEach((e, id) => { if (!rects.some((q) => q.id === id)) { e.remove(); shapes.delete(id); } });
    rects.forEach((q) => {
      let e = shapes.get(q.id);
      if (!e) { e = document.createElement('i'); shapes.set(q.id, e); }
      css(e, q);
      if (order !== drawn || !e.isConnected) el.insertBefore(e, frameEl);
    });
    drawn = order;
    css(frameEl, f);
    map = { s, m, rects, f };
  }
  function render() {
    const s = scene(), m = s && measure(s);
    if (!m) return false;
    draw(s, m);
    return true;
  }
  function loop() {
    cancelAnimationFrame(raf);
    const frame = () => {
      raf = 0;
      if (!shown) return;
      if (!render() && !held) { set(false); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  /* Like the dock, it only ever fades, and hidden it takes no clicks. */
  function set(on) {
    clearTimeout(timer);
    timer = 0;
    if (on === shown) return;
    if (on) span = null;
    if (on && !render()) return;
    shown = on;
    const from = parseFloat(getComputedStyle(el).opacity) || 0;
    if (anim) { anim.cancel(); anim = null; }
    el.style.opacity = on ? '1' : '0';
    el.style.pointerEvents = on ? 'auto' : 'none';
    el.style.visibility = 'visible';
    if (on) loop();
    else { cancelAnimationFrame(raf); raf = 0; }
    const to = on ? 1 : 0;
    const a = el.animate([{ opacity: from }, { opacity: to }], { duration: Math.abs(to - from) * (on ? IN_MS : OUT_MS), easing: on ? 'cubic-bezier(.2,.8,.2,1)' : 'ease-in' });
    anim = a;
    a.onfinish = () => {
      if (anim !== a) return;
      anim = null;
      if (!shown) el.style.visibility = 'hidden';
    };
  }
  const linger = () => {
    if (shown && !timer && !held) timer = setTimeout(() => { timer = 0; set(false); }, LINGER_MS);
  };
  const stopDwell = () => { clearTimeout(dwell); dwell = 0; };
  /* The view as drawn right now, to tell whether it is still moving by itself (a glide, a step's slide, a pinch
