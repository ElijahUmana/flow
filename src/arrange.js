/* The arrange control. The dock's arrange button opens a short menu of named ways to lay the space on screen out (owner,
   Nov 7, 02/11: "offer ... dynamic multiple options", and one view where things are "actually viewable" instead of
   "terribly tiny"); ⌃⌘A goes on to the next way, as the button did before (owner, Nov 2 14:03). Every way starts from
   the owner's own arrangement, and "yours" puts it back exactly, view included. A hand move, a resize, or a window
   opened or closed makes what is there the owner's own for the next press. tidy, kind, focus and grid are
   nav.arrange's (layout). readable is this file's: equal tiles at actual size, never under READ_W x READ_H, as many as
   fill one view and more rows below, and the view goes to actual size on them, so each window can be read. */
(() => {
'use strict';

const WAYS = ['tidy', 'kind', 'focus', 'grid'];   // nav.arrange's, in the order ⌃⌘A goes through them
const ROWS = [
  ['readable', 'readable', 'never tiny'],
  ['tidy', 'tidy', 'line up'],
  ['kind', 'by kind', 'agents, pages, notes'],
  ['focus', 'focus', 'front one large'],
  ['grid', 'grid', 'all in one view'],
  ['yours', 'yours', 'as you left it'],
];
const READ_W = 420, READ_H = 300;   // px at actual size: a page's text and a terminal's lines can still be read
const SIDE = 1.2, TOP = 6.6, GAP_X = 1.2, GAP_Y = 1.8;   // nav.js's margins and gaps, in %

/* h: { current() -> { ws, key } | null (the space on screen, and a key that names it), windows(ws) -> [{ id, x, y, w, h }]
   of that space, front(ws) -> the window in front or null, arrange(ws, way, front, base) -> { id: { x, y, w, h } },
   size() -> { vw, vh } (the view in px), visible(ws) -> { x, y } (% of the space at the view's top left),
   bottom() -> % where windows end, view(ws) -> { pan, panY, zoom }, apply(ws, rects, view) (puts the windows there with
   the usual glide, the view there when one is given, and saves) } */
function attach(h) {
  const cycles = new Map();   // space key -> { base, view, step, last }: the own arrangement and view, the way it is at, what that made
  const round = (v) => Math.round(v * 100) / 100;
  const sig = (rects) => JSON.stringify(Object.keys(rects).sort().map((id) => [id, round(rects[id].x), round(rects[id].y), round(rects[id].w), round(rects[id].h)]));
  const now = (ws) => Object.fromEntries(h.windows(ws).map((r) => [r.id, { x: r.x, y: r.y, w: r.w, h: r.h }]));
  const sameView = (a, b) => !!a && !!b && Math.abs(a.pan - b.pan) < 0.01 && Math.abs(a.panY - b.panY) < 0.01 && Math.abs(a.zoom - b.zoom) < 0.001;

  /* Equal tiles in reading order of the own arrangement, as many across one view at actual size as stay at least
     READ_W x READ_H, as large as fills the view, and more rows of the same below when they do not all fit; the view goes
     to actual size on the first row. Bigger windows are not kept bigger: every window gets the same readable share. */
  function readable(ws, base) {
    const { vw, vh } = h.size(), vis = h.visible(ws), out = {};
    const order = Object.keys(base).sort((a, b) => { const p = base[a], q = base[b]; return Math.abs(p.y - q.y) > 8 ? p.y - q.y : p.x - q.x; });
    const n = order.length, W = 100 - 2 * SIDE, H = Math.max(TOP + 1, h.bottom()) - TOP;
    const rw = Math.min(W, (READ_W / vw) * 100), rh = Math.min(H, (READ_H / vh) * 100);
    const cols = Math.max(1, Math.min(n, Math.floor((W + GAP_X) / (rw + GAP_X))));
    const rows = Math.max(1, Math.min(Math.ceil(n / cols), Math.floor((H + GAP_Y) / (rh + GAP_Y))));
    const tw = (W - (cols - 1) * GAP_X) / cols, th = (H - (rows - 1) * GAP_Y) / rows;
    const x0 = Math.max(SIDE, vis.x + SIDE), y0 = Math.max(TOP, vis.y + TOP);
    order.forEach((id, i) => { out[id] = { x: x0 + (i % cols) * (tw + GAP_X), y: y0 + Math.floor(i / cols) * (th + GAP_Y), w: tw, h: th }; });
    return { rects: out, view: { pan: x0 - SIDE, panY: y0 - TOP, zoom: 1 } };
  }

  /* The cycle of the space on screen, started again from what is there when that is not what the last way made. */
  function cycleOf(c, here) {
    const cy = cycles.get(c.key);
    return cy && cy.last === sig(here) ? cy : { base: here, view: h.view(c.ws), step: 0 };
  }
  function layoutOf(c, cy, way) {
    if (way === 'yours') return { rects: cy.base, view: cy.view };
    if (way === 'readable') return readable(c.ws, cy.base);
    return { rects: h.arrange(c.ws, way, h.front(c.ws), cy.base), view: null };
  }
  /* Lays the space out one way; false when nothing, windows or view, would move. */
  function put(c, cy, here, way) {
    const { rects, view } = layoutOf(c, cy, way);
    const after = { ...here, ...rects };
    if (sig(after) === sig(here) && (!view || sameView(view, h.view(c.ws)))) return false;
    h.apply(c.ws, rects, view);
    cy.last = sig(after);
    cycles.set(c.key, cy);
    return true;
  }

  /* ⌃⌘A: the next way that moves something; after the last, the owner's own again. */
  function press() {
    const c = h.current();
    if (!c) return false;
    const here = now(c.ws);
    if (!Object.keys(here).length) return false;
    const cy = cycleOf(c, here);
    for (let n = 0; n <= WAYS.length; n++) {
      cy.step = (cy.step + 1) % (WAYS.length + 1);
      if (put(c, cy, here, cy.step ? WAYS[cy.step - 1] : 'yours')) return true;
    }
    cycles.set(c.key, cy);
    return false;
  }

  /* One way chosen by name from the dock's menu; ⌃⌘A goes on from it. */
  function pick(way) {
    const c = h.current();
    if (!c || !ROWS.some((r) => r[0] === way)) return false;
    const here = now(c.ws);
    if (!Object.keys(here).length) return false;
    const cy = cycleOf(c, here);
    cy.step = Math.max(0, WAYS.indexOf(way) + 1);
    const moved = put(c, cy, here, way);
    cycles.set(c.key, cy);
    return moved;
  }

  const menu = () => ROWS.map(([way, label, hint]) => ({ way, label, hint }));

  return { press, pick, menu };
}

window.FlowArrange = { attach };
})();




