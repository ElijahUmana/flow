/* The dock stays out of sight until the pointer comes to the bottom middle of the window, then fades in. It stays while
   the pointer is on it or close to it and goes shortly after the pointer leaves. Hidden, it takes no clicks, so it
   never covers anything. It only ever fades: its box never moves, so layouts that measure it never shift.
   Windows may sit under it, so while one does, only the strip at the very bottom brings it up, and once one of its
   buttons is used it gets out of the way at once: a click aimed at a window under it must never land on it. With nothing
   under it, the whole bottom middle brings it up and it stays for the next button. A space with no window keeps it
   shown, and nothing else, until it has one: the dock is how a space starts (lead, Nov 2). */
(() => {
'use strict';

const NEAR = 20;      // px beside the dock where the pointer brings it up
const KEEP = 32;      // px beside it that keep it up (more than NEAR, so its edge never flickers)
const KEEP_UP = 4;    // px above it that keep it up: less than the gap layouts leave between windows and the dock
const EDGE = 12;      // the bottom strip under it, which brings it up even over a window
const TOP = 16;       // px under its top edge where a move up is read as leaving (lower down it is landing on a button)
const BAND = 240;     // px from the bottom of the window that can hold the dock and its margins
const IN_MS = 140, OUT_MS = 170, LINGER_MS = 250;

function attach(dock) {
  let shown = true, timer = 0, anim = null, lastY = 0, bare = false;
  const under = () => {
    const d = dock.getBoundingClientRect();
    return [...document.querySelectorAll('.win')].some((w) => { const r = w.getBoundingClientRect(); return r.width && r.left < d.right && r.right > d.left && r.top < d.bottom && r.bottom > d.top; });
  };

  const measure = () => {
    const box = dock.offsetParent;
    if (!box) return null;
    const p = box.getBoundingClientRect(), r = dock.getBoundingClientRect();
    return r.width ? { left: r.left, right: r.right, top: r.top, bottom: p.bottom } : null;
  };

  const set = (on, instant) => {
    clearTimeout(timer);
    timer = 0;
    if (on === shown) return;
    shown = on;
    const from = parseFloat(getComputedStyle(dock).opacity);
    if (anim) { anim.cancel(); anim = null; }
    dock.style.opacity = on ? '' : '0';
    dock.style.pointerEvents = on ? '' : 'none';
    dock.style.visibility = on || !instant ? '' : 'hidden';
    if (instant) return;
    const to = on ? 1 : 0;
    const a = dock.animate([{ opacity: from }, { opacity: to }], { duration: Math.abs(to - from) * (on ? IN_MS : OUT_MS), easing: on ? 'cubic-bezier(.2,.8,.2,1)' : 'ease-in' });
    anim = a;
    a.onfinish = () => {
      if (anim !== a) return;
      anim = null;
      if (!shown) dock.style.visibility = 'hidden';
    };
  };
  const linger = () => {
    if (shown && !timer && !bare) timer = setTimeout(() => { timer = 0; set(false); }, LINGER_MS);
  };
  /* The space on screen holds no window. Its workspace is the one the track is moving to (translateX(-i * 100%)), even
     while it slides there; the windows of its other spaces are not shown and do not count. */
  const track = document.getElementById('track');
  const emptySpace = () => {
    if (!track) return false;
    const m = /translateX\((-?[\d.]+)%\)/.exec(track.style.transform || ''), i = m ? Math.round(-parseFloat(m[1]) / 100) : 0;
    const sec = track.querySelectorAll('section.ws')[i];
    return !!sec && ![...sec.querySelectorAll('.win')].some((w) => w.style.display !== 'none');
  };
  const check = () => {
    const now = emptySpace();
    if (now === bare) return;
    bare = now;
    if (bare) set(true);
    else linger();
  };

  /* Over a window that reaches down here, only the strip at the very bottom brings it up, so it never pops over what
     you are working in, and a window's resize grip never counts as that strip (its bottom grip reaches into it).
     Not while a button is held either: dragging past it leaves it down.
     A web page in a window above never reports the pointer to this document, not even that it left, so near its top
     edge a move up that is about to carry the pointer out (two more steps like the last one) already starts the timer;
     the next move here stops it. */
  const onMove = (e) => {
    const x = e.clientX, y = e.clientY, prevY = lastY;
    lastY = y;
    if (y < innerHeight - BAND) { linger(); return; }
    const a = measure();
    if (!a) return;
    const near = (py, side, above) => x >= a.left - side && x <= a.right + side && py >= a.top - above && py <= a.bottom;
    const next = y < a.top + TOP ? y + 2 * Math.min(0, y - prevY) : y;
    if (shown) {
      if (near(y, KEEP, KEEP_UP) && near(next, KEEP, KEEP_UP)) set(true);
      else linger();
    } else if (!e.buttons && near(y, NEAR, 0) && !(e.target.closest && e.target.closest('.rz')) && (y >= a.bottom - EDGE || (!(e.target.closest && e.target.closest('.win')) && !under()))) {
      set(true);
    }
  };
  /* Leaving the window, or going into a web page (its pointer moves never reach this document). */
  const onOut = (e) => {
    const to = e.relatedTarget;
    if (!to || to.tagName === 'WEBVIEW' || to.tagName === 'IFRAME') linger();
  };

  window.addEventListener('pointermove', onMove, { capture: true, passive: true });
  /* A press on a window's resize grip is aimed at that window: the dock gets out of the way of the edge being dragged. */
  window.addEventListener('pointerdown', (e) => { if (shown && e.target.closest && e.target.closest('.rz')) set(false); }, true);
  // a window made, closed or moved to another space, or another space shown: looked at once per frame at most
  let pending = 0;
  if (track) new MutationObserver(() => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; check(); }); })
    .observe(track, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
  document.addEventListener('pointerout', onOut, true);
  /* After the app has handled the click (and opened what it asked for). */
  dock.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(() => { if (shown && under()) set(false); }, 0); });
  set(false, true);
  check();

  return { isShown: () => shown };
}

window.FlowDock = { attach };
})();




