/* A new window beside the one in front (owner, Nov 2 12:39: "create a new page to the left or a new page to the right
   ... select whether we're adding new space or we're just dividing the already existing space"). Nothing shows at rest.
   With a window in front, the pointer by one of its sides brings up a small + there; pointing at it outlines
   what a click makes: one of the same kind, the same size, on that side (what is in its way makes way, nav.beside).
   Only a click makes that. Pressed and pulled into the window past SPLIT_IN, the outline turns into the two halves the
   window then shares with the new one; let go there and it splits. A pull that never gets that far, a split a half of
   which would be too small (no outline then), or Esc: nothing (lead, 12:5x). The border and RESIZE px each side of it
   belong to resizing the window (the Finder's way, lead 14:4x), so the + never comes up there: it sits at the middle of
   the side, just past that band, as Miro's side handles do, and comes up when the pointer nears that side from outside
   and stays a moment: a hand on its way across the side (to the border to resize, or out of the window) brings none. A
   side that faces another window within REACH has none: that gap is the room double-click's.
   Above a window it is over the title bar's gap, never on the bar; never in a corner; on the bottom side it moves out of
   the dock's and the corner map's boxes. It works at any zoom. Only bare desktop outside the band brings it up: a page's
   webview tells the app nothing about the pointer, and going into the window puts the + away at once. */
(() => {
'use strict';
const RESIZE = 4;       // px each side of a window's border that resize it (and never bring up the +)
const BAND = 12;        // px past that band where the pointer brings up the +
const CORNER = 16;      // px at each end of a side that never do (the resize corners); less on a window too small for it
const SPLIT_IN = 40;    // px into the window past which a pull means splitting it (less on a small window)
const MOVE = 6;         // px a press travels before it is a pull, not a click
const SIZE = 16;        // px: the +, drawn just past the resize band
const REACH = RESIZE + BAND + SIZE;   // px a side reaches out: another window within it makes that side a gap
const SLIVER = 24;      // px of an outline that lies past the view, kept at the view's edge so it still shows which way
const IN_MS = 140, OUT_MS = 170, LINGER_MS = 250;
const DWELL = 120;      // ms the pointer stays by a side, not crossing it, before the + comes up there
const LINE = 'position:absolute;pointer-events:none;z-index:60;box-sizing:border-box;border:1px dashed rgba(255,255,255,.45);border-radius:10px;background:rgba(255,255,255,.05)';

/* h: { viewport, front() -> { ws, w, el } | null, canOpen(w), zoom(ws), toScreen(ws, rect) -> px box in the viewport,
   beside(ws, w, side, split, dry) -> { at, own } | null, open(ws, w, side, split), busy(on), isBusy(), avoid() -> boxes } */
function attach(h) {
  const plus = document.createElement('button');
  plus.className = 'bz';
  plus.textContent = '+';
  plus.style.cssText = `position:absolute;z-index:61;display:none;width:${SIZE}px;height:${SIZE}px;margin:${-SIZE / 2}px 0 0 ${-SIZE / 2}px;padding:0;border:1px solid rgba(255,255,255,.22);border-radius:50%;background:rgba(40,40,46,.92);color:#e9e9ec;font:13px/14px var(--sans,system-ui);text-align:center;cursor:default;opacity:0`;
  h.viewport.appendChild(plus);
  const lines = [document.createElement('div'), document.createElement('div')];
  lines.forEach((l) => { l.style.cssText = LINE; l.style.display = 'none'; h.viewport.appendChild(l); });

  let at = null;        // { ws, w, el, side, x, y }: where the + is up, x and y in viewport px
  let shown = false, timer = 0, anim = null, drag = null;
  let wait = 0, trail = [];   // a + about to come up, and where the pointer was by that side lately: [{ t, x, y }]

  const vbox = () => h.viewport.getBoundingClientRect();
  const fade = (on) => {
    if (on === shown) return;
    shown = on;
    if (anim) { anim.cancel(); anim = null; }
    const from = parseFloat(getComputedStyle(plus).opacity) || 0, to = on ? 1 : 0;
    plus.style.opacity = String(to);
    if (on) plus.style.display = '';
    const a = plus.animate([{ opacity: from }, { opacity: to }], { duration: Math.abs(to - from) * (on ? IN_MS : OUT_MS) });
    anim = a;
    a.onfinish = () => { if (anim !== a) return; anim = null; if (!shown) plus.style.display = 'none'; };
  };
  const hideLines = () => lines.forEach((l) => { l.style.display = 'none'; });
  /* An outline wholly past a side of the view shows as a sliver along that side. */
  const pin = (b) => {
    const W = h.viewport.clientWidth, H = h.viewport.clientHeight, o = { ...b, pinned: false };
    if (o.left >= W) { o.left = W - SLIVER; o.width = SLIVER; o.pinned = true; } else if (o.left + o.width <= 0) { o.left = 0; o.width = SLIVER; o.pinned = true; }
    if (o.top >= H) { o.top = H - SLIVER; o.height = SLIVER; o.pinned = true; } else if (o.top + o.height <= 0) { o.top = 0; o.height = SLIVER; o.pinned = true; }
    return o;
  };
  const outline = (ws, rects) => {
    lines.forEach((l, i) => {
      const r = rects[i];
      if (!r) { l.style.display = 'none'; return; }
      const b = pin(h.toScreen(ws, r));
      Object.assign(l.style, { display: '', left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
      l.dataset.pinned = b.pinned ? '1' : '';
    });
  };
  const calm = () => { clearTimeout(wait); wait = 0; trail = []; };
  const hide = () => { calm(); clearTimeout(timer); timer = 0; at = null; hideLines(); fade(false); };
  const linger = () => { if (shown && !timer && !drag) timer = setTimeout(() => { timer = 0; if (!plus.matches(':hover')) hide(); }, LINGER_MS); };

  /* The edge of the window in front that a point (client px) reaches, and where on it the + goes; null for none. */
  function reach(x, y) {
    const f = h.front();
    if (!f || !h.canOpen(f.w)) return null;
    const r = f.el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const cx = Math.min(CORNER, r.width / 4), cy = Math.min(CORNER, r.height / 4);
    const alongY = y >= r.top + cy && y <= r.bottom - cy, alongX = x >= r.left + cx && x <= r.right - cx;
    const out = RESIZE + BAND;
    let side = null;
    if (alongY && x >= r.left - out && x < r.left - RESIZE) side = 'left';
    else if (alongY && x > r.right + RESIZE && x <= r.right + out) side = 'right';
    else if (alongX && y > r.bottom + RESIZE && y <= r.bottom + out) side = 'below';
    else if (alongX && y >= r.top - out && y < r.top - RESIZE) side = 'above';
    if (!side) return null;
    // outside the band it must be bare desktop there, not another window over it
    const under = document.elementFromPoint(x, y), win = under && under.closest && under.closest('.win');
    if (win && win !== f.el) return null;
    // a side that faces another window within REACH is the gap between the two, and a double-click there opens room
    // between them (owner, Nov 1 22:50): no + on it (lead, 15:5x)
    const zone = side === 'right' ? [r.right, r.top, r.right + REACH, r.bottom] : side === 'left' ? [r.left - REACH, r.top, r.left, r.bottom]
      : side === 'below' ? [r.left, r.bottom, r.right, r.bottom + REACH] : [r.left, r.top - REACH, r.right, r.top];
    for (const o of (f.el.closest('section.ws') || document).querySelectorAll('.win')) {
      if (o === f.el || o.style.display === 'none') continue;
      const q = o.getBoundingClientRect();
      if (q.width && q.left < zone[2] && q.right > zone[0] && q.top < zone[3] && q.bottom > zone[1]) return null;
    }
    const v = vbox();
    // the middle of the side, of the part of it in view; just past the resize band
    const k = RESIZE + SIZE / 2;
    const midX = (Math.max(r.left, v.left) + Math.min(r.right, v.right)) / 2, midY = (Math.max(r.top, v.top) + Math.min(r.bottom, v.bottom)) / 2;
    let px = side === 'left' ? r.left - k : side === 'right' ? r.right + k : midX;
    const py = side === 'above' ? r.top - k : side === 'below' ? r.bottom + k : midY;
    if (side === 'below') {
      // out of the dock's and the corner map's boxes, to the nearest free point of the side
      const lo = r.left + cx, hi = r.right - cx;
      for (const b of h.avoid()) {
        if (py + SIZE / 2 < b.top || py - SIZE / 2 > b.bottom || px + SIZE / 2 < b.left || px - SIZE / 2 > b.right) continue;
        const left = b.left - SIZE / 2 - 2, right = b.right + SIZE / 2 + 2;
        const opts = [left >= lo ? left : null, right <= hi ? right : null].filter((o) => o !== null);
        if (!opts.length) return null;
        px = opts.reduce((best, o) => (Math.abs(o - midX) < Math.abs(best - midX) ? o : best));
      }
    }
    return { ...f, side, x: px - v.left, y: py - v.top };
  }
  const place = (p) => { plus.style.left = `${p.x}px`; plus.style.top = `${p.y}px`; };
  const show = (p) => {
    clearTimeout(timer); timer = 0;
    if (!at || at.w !== p.w || at.side !== p.side) hideLines();
    at = p;
    place(p);
    fade(true);
  };
  /* How far out from p's side a point is, in px. */
  const off = (p, q) => { const r = p.el.getBoundingClientRect(); return p.side === 'left' ? r.left - q.x : p.side === 'right' ? q.x - r.right : p.side === 'above' ? r.top - q.y : q.y - r.bottom; };
  /* DWELL after the pointer came by a side: up, unless in the last 60 ms it was still closing in on the border or
     leaving it (more than 1.5 px), and then it looks again in 40 ms. */
  function settle() {
    wait = 0;
    const q = trail[trail.length - 1], p = q && reach(q.x, q.y);
    if (!p) { trail = []; return; }
    const now = performance.now(), recent = trail.filter((o) => now - o.t <= 60);
    if (recent.length > 1 && Math.abs(off(p, recent[0]) - off(p, q)) > 1.5) { wait = setTimeout(settle, 40); return; }
    show(p);
  }

  function onMove(e) {
    if (drag) return;
    if (h.isBusy()) { if (shown) hide(); return; }
    if (e.target === plus) { clearTimeout(timer); timer = 0; return; }
    const p = reach(e.clientX, e.clientY);
    if (!p) {
      calm();
      const f = at && at.el.getBoundingClientRect();
      if (f && e.clientX > f.left && e.clientX < f.right && e.clientY > f.top && e.clientY < f.bottom) hide();
      else linger();
      return;
    }
    if (shown && at.w === p.w && at.side === p.side) { show(p); return; }
    const now = performance.now();
    trail = trail.filter((o) => now - o.t <= 100);
    trail.push({ t: now, x: e.clientX, y: e.clientY });
    if (!wait) wait = setTimeout(settle, DWELL);
  }
  // a page swallows the pointer: going into one is going away from the +
  const onOut = (e) => { const to = e.relatedTarget; if (!drag && (!to || to.tagName === 'WEBVIEW' || to.tagName === 'IFRAME')) { calm(); linger(); } };

  plus.addEventListener('pointerenter', () => {
    if (drag || !at) return;
    const r = h.beside(at.ws, at.w, at.side, false, true);
    outline(at.ws, r ? [r.at] : []);
  });
  plus.addEventListener('pointerleave', () => { if (!drag) { hideLines(); linger(); } });

  /* Into the window from the + 's edge, in px: below zero is outside it. */
  const depth = (p, x, y) => {
    const r = p.el.getBoundingClientRect();
    return p.side === 'left' ? x - r.left : p.side === 'right' ? r.right - x : p.side === 'above' ? y - r.top : r.bottom - y;
  };
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.removeEventListener('keydown', d.key, true);
    if (plus.hasPointerCapture(d.id)) plus.releasePointerCapture(d.id);
    h.busy(false);
    hide();
    if (d.cancelled && d.had && d.had.isConnected) d.had.focus({ preventScroll: true });
  };
  plus.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !at) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer); timer = 0;
    const p = at, split = h.beside(p.ws, p.w, p.side, true, true);
    drag = { id: e.pointerId, p, mode: 'click', sx: e.clientX, sy: e.clientY, split, had: document.activeElement, key: (k) => {
      if (k.key !== 'Escape') return;
      k.preventDefault();
      k.stopPropagation();
      drag.cancelled = true;
      end();
    } };
    plus.setPointerCapture(e.pointerId);
    // the keys come here while the + is held, so Esc reaches it even from a page that had them
    plus.focus({ preventScroll: true });
    document.addEventListener('keydown', drag.key, true);
    h.busy(true);
    const same = h.beside(p.ws, p.w, p.side, false, true);
    outline(p.ws, same ? [same.at] : []);
  });
  plus.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.mode === 'click' && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < MOVE) return;
    const { p } = drag, d = depth(p, e.clientX, e.clientY), v = vbox();
    place({ x: e.clientX - v.left, y: e.clientY - v.top });
    // a pull: the two halves once far enough in and the split is possible, else nothing to let go of
    const r = p.el.getBoundingClientRect(), need = Math.min(SPLIT_IN, 0.3 * (p.side === 'left' || p.side === 'right' ? r.width : r.height));
    const mode = d > need && drag.split ? 'split' : 'none';
    if (mode === drag.mode) return;
    drag.mode = mode;
    if (mode === 'split') outline(p.ws, [drag.split.own, drag.split.at]);
    else hideLines();
  });
  plus.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { p, mode } = drag;
    if (mode === 'none') drag.cancelled = true;
    end();
    if (mode !== 'none') h.open(p.ws, p.w, p.side, mode === 'split');   // 'click': the same size, 'split': the halves
  });
  plus.addEventListener('lostpointercapture', () => end());
  // a double-click on the + is one click, not a second window
  plus.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); });

  window.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('pointerout', onOut, true);
  window.addEventListener('blur', () => { if (!drag) hide(); });

  return {
    /* The keys' way: a window of the same size beside the one in front, on that side. */
    key(side) {
      const f = h.front();
      if (f && h.canOpen(f.w)) h.open(f.ws, f.w, side, false);
    },
  };
}

window.FlowBeside = { attach };
})();




