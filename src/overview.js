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
     settling, a workspace sliding in): it comes up only once the view is still and drawn where nav keeps it, so not
     while a glide holds past an end before it springs back. */
  const motion = () => {
    const ws = h.current(), c = ws && h.canvas(ws);
    if (!c) return '';
    const t = c.closest('.track'), cs = getComputedStyle(c);
    return `${cs.transform}|${cs.translate}|${t ? getComputedStyle(t).transform : ''}`;
  };
  const placed = () => {
    const ws = h.current(), c = ws && h.canvas(ws), t = c ? getComputedStyle(c).transform : 'none';
    if (!t || t === 'none') return true;
    const m = new DOMMatrixReadOnly(t), z = m.a || 1, v = h.nav.visible(ws), { vw, vh } = h.size();
    // in screen px: nav draws the canvas up to half a device pixel from its view
    return Math.abs(-m.m41 - (v.x / 100) * vw * z) <= 1 && Math.abs(-m.m42 - (v.y / 100) * vh * z) <= 1;
  };

  /* The bottom right: from NEAR left of the map (at least of where a usual W-wide map would be, so the place to reach
     for stays the same whatever the space's shape) to the window's right side, and from the map's top (at least ZONE_H
     up) to the window's bottom, its outermost px included as for the dock, so a quick throw into the corner or against
     an edge brings it up (layout's walk, owner 23:41); over a window only the bottom EDGE px. */
  function inZone(x, y, overWin) {
    const s = scene(), m = s && measure(s);
    if (!m) return false;
    const left = Math.min(m.left, m.st.right - RIGHT - W - 2) - NEAR;
    if (x < left || x > m.st.right || y > m.st.bottom || y < Math.min(m.top, m.st.bottom - ZONE_H)) return false;
    return !overWin || y >= m.st.bottom - EDGE;
  }
  const near = (x, y) => {
    const m = map && map.m;
    return !!m && x >= m.left - KEEP && x <= m.st.right && y >= m.top - KEEP_UP && y <= m.st.bottom;
  };
  /* Well away from the bottom right: no move here can bring the map up. */
  const outside = (st, x, y) => x < st.right - RIGHT - WIDE - NEAR || y < st.bottom - BOTTOM - Math.max(TALL, ZONE_H) - 4;
  /* A window's resize grips (app.js .rz) reach 5 px below its bottom edge, into the bare strip: a rest there aims at
     the grip, not at the map. */
  const grip = (t) => !!(t && t.closest && t.closest('.rz'));
  const onMove = (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (held) return;
    if (shown) {
      if (near(lastX, lastY)) { clearTimeout(timer); timer = 0; } else linger();
      return;
    }
    const st = h.stage.getBoundingClientRect();
    if (outside(st, lastX, lastY)) { stopDwell(); working = false; return; }
    const over = !!(e.target && e.target.closest && e.target.closest('.win'));
    if (e.buttons || grip(e.target) || !inZone(lastX, lastY, over)) { stopDwell(); return; }
    if (working) return;
    if (!dwell) {
      let was = motion();
      const fire = () => {
        const now = motion();
        if (now !== was || !placed()) { was = now; dwell = setTimeout(fire, DWELL_MS); return; }
        dwell = 0;
        const t = document.elementFromPoint(lastX, lastY);
        if (!shown && !held && !grip(t) && inZone(lastX, lastY, !!(t && t.closest && t.closest('.win')))) set(true);
      };
      dwell = setTimeout(fire, DWELL_MS);
    }
  };
  /* A press at the bottom right, the map down, is work there (a right-click "new note here", a double-click at the edge):
     a rest there afterwards is not a reach, so the map waits until the pointer has gone well away from the corner or
     out of the window (flows' board walk: it came up over a note just made under it). Crossing a window there, the
     note just made included, is not going away. With the map up, a press on a window's resize grip beside it is such
     work too, and the map goes so it never sits over the corner being resized. */
  const onPress = (e) => {
    if (el.contains(e.target) || outside(h.stage.getBoundingClientRect(), e.clientX, e.clientY)) return;
    if (shown && !grip(e.target)) return;
    working = true;
    stopDwell();
    if (shown) set(false);
  };
  /* Leaving the window, or going into a web page (its pointer moves never reach this document). */
  const onOut = (e) => {
    const to = e.relatedTarget;
    if (!to || to.tagName === 'WEBVIEW' || to.tagName === 'IFRAME') { stopDwell(); working = false; linger(); }
  };

  /* A click on an empty part centers the view there; on a window's shape it goes to that window; a drag moves the frame
     (held where it was taken, or centered on the pointer when taken outside it). */
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !map) return;
    e.preventDefault();
    e.stopPropagation();
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    const { s, m, f } = map, r = el.getBoundingClientRect(), ox = r.left + 1, oy = r.top + 1;
    const p0x = e.clientX - ox, p0y = e.clientY - oy;
    const inFrame = p0x >= f.x && p0x <= f.x + f.w && p0y >= f.y && p0y <= f.y + f.h;
    const dx = inFrame ? p0x - (f.x + f.w / 2) : 0, dy = inFrame ? p0y - (f.y + f.h / 2) : 0;
    const at = (cx, cy, ax = 0, ay = 0) => ({ x: s.x0 + ((cx - ox - ax) / m.k / m.vw) * 100, y: s.y0 + ((cy - oy - ay) / m.k / m.vh) * 100 });
    let moved = false;
    held = true;
    clearTimeout(timer);
    timer = 0;
    if (e.isTrusted) el.setPointerCapture(e.pointerId);
    h.busy(true);
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < CLICK_PX) return;
      moved = true;
      const p = at(ev.clientX, ev.clientY, dx, dy);
      h.nav.goTo(s.ws, p.x, p.y, false);
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      held = false;
      h.busy(false);
      if (ev.type === 'pointerup' && !moved) {
        const px = ev.clientX - ox, py = ev.clientY - oy;
        const hit = map && [...map.rects].reverse().find((q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h);
        const w = hit && s.ws.windows.find((o) => o.id === hit.id);
        if (w) h.go(s.ws, w);
        else { const p = at(ev.clientX, ev.clientY); h.nav.goTo(s.ws, p.x, p.y, true); }
      }
      h.changed();
      if (!near(lastX, lastY)) linger();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  });
  /* Two fingers over it still move between the spaces of the workspace; a pinch over it does nothing. */
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!e.ctrlKey) h.nav.wheel({ dx: e.deltaX, dy: e.deltaY, t: performance.timeOrigin + e.timeStamp });
  }, { passive: false });

  window.addEventListener('pointermove', onMove, { capture: true, passive: true });
  window.addEventListener('pointerdown', onPress, { capture: true, passive: true });
  window.addEventListener('contextmenu', onPress, { capture: true, passive: true });
  document.addEventListener('pointerout', onOut, true);
  return { isShown: () => shown };
}

window.FlowOverview = { mount };
})();




