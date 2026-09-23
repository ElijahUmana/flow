'use strict';
// Preload of every page <webview>, set by main in will-attach-webview (a page never gets Flow's own preload). It runs in
// an isolated world and gives the page nothing. A trackpad pinch (a wheel with ctrlKey) the page does not take itself
// zooms inside the page as Chrome's does: it goes to main as 'flow:pinch-page' (below), never to the workspace. To the
// host's <webview> element it reports:
// - 'flow:wheel' { dx, dy, t, used }: the other wheels nav needs (below); every wheel still reaches the page. A sideways
//   swipe the page leaves alone moves Flow to the next sub-workspace (nav). used: the page took the event, something
//   under the pointer can scroll that way, or the page scrolled something sideways during the gesture; t: the event's
//   time in epoch ms.
// - From src/touch.js, 'flow:double-tap' { t }: a two-finger double tap on the trackpad; see TURN_MS below.
// To main: 'flow:page-navigate' { type, url, delta } before each navigation the page starts itself to another
// document, so main can repeat it after the user chose Leave over the page's unsaved-changes guard; 'flow:edited' at the
// owner's first edit in this document (a trusted input event: typing, pasting, cutting, dropping), so a window closing
// asks only pages that can hold the owner's unsaved text. From main: 'flow:zoom' level, this page's own zoom.

const { ipcRenderer, webFrame, contextBridge } = require('electron');

ipcRenderer.on('flow:zoom', (_event, level) => webFrame.setZoomLevel(level));

// The camera and microphone the page holds, for the control in its address bar. The guest is sandboxed and isolated,
// so the page's own world is reached with webFrame.executeJavaScript: once per document it wraps getUserMedia to keep
// every stream it hands out, and from then on the preload can ask what is live or stop a device outright. A stopped
// track ends the camera light at once, the same as Chrome's switch; the site's next request is refused by main.
const MAIN_WORLD = `(() => {
  if (window.__flowMedia) return true;
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return false;
  const got = [];                      // { stream, constraints } for every stream the page was handed
  const pcs = new Set();               // every peer connection, so a device that comes back reaches the call too
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => { const s = await original(c); got.push({ stream: s, constraints: c || {} }); return s; };
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const Orig = window[name];
    if (typeof Orig !== 'function' || Orig.__flowWrapped) continue;
    const Wrapped = function (...a) { const pc = new Orig(...a); pcs.add(pc); pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'closed') pcs.delete(pc); }); return pc; };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    Wrapped.__flowWrapped = true;
    window[name] = Wrapped;
  }
  const live = () => {
    let camera = false; let microphone = false;
    for (const { stream } of got) for (const t of stream.getTracks()) if (t.readyState === 'live') { if (t.kind === 'video') camera = true; else microphone = true; }
    return { camera, microphone };
  };
  window.__flowMedia = {
    held: live,
    stop(kind) { for (const { stream } of got) for (const t of stream.getTracks()) if (t.kind === kind && t.readyState === 'live') t.stop(); return live(); },
    // Back on: every stream that lost this device gets a fresh track from the same constraints, in place, and every
    // call that was sending the old one sends the new one. The page keeps its own stream object and needs to do nothing.
    async resume(kind) {
      const key = kind === 'video' ? 'video' : 'audio';
      for (const g of got) {
        const old = g.stream.getTracks().find((t) => t.kind === kind && t.readyState === 'ended');
        if (!old || !g.constraints[key]) continue;
        const fresh = (await original({ [key]: g.constraints[key] })).getTracks().find((t) => t.kind === kind);
        if (!fresh) continue;
        g.stream.removeTrack(old);
        g.stream.addTrack(fresh);
        for (const pc of pcs) for (const sender of pc.getSenders()) if (sender.track === old) await sender.replaceTrack(fresh).catch(() => {});
        for (const el of document.querySelectorAll('video, audio')) if (el.srcObject === g.stream) { el.srcObject = g.stream; el.play().catch(() => {}); }
      }
      return live();
    },
  };
  return true;
})()`;
const inPage = (code) => webFrame.executeJavaScript(code).catch(() => null);
const install = () => inPage(MAIN_WORLD);
// Synchronously, before the page's own scripts run, so a site that asks on load is wrapped too.
try { contextBridge.executeInMainWorld({ func: new Function(`return ${MAIN_WORLD}`) }); } catch { /* the async install below covers it */ }
install();
window.addEventListener('DOMContentLoaded', install);
const report = async () => {
  await install();
  const held = await inPage('window.__flowMedia ? window.__flowMedia.held() : { camera: false, microphone: false }');
  ipcRenderer.sendToHost('flow:using', held || { camera: false, microphone: false });
};
setInterval(report, 1500);
ipcRenderer.on('flow:using-ask', report);
ipcRenderer.on('flow:media-resume', async (_event, device) => {
  const kind = device === 'camera' ? 'video' : device === 'microphone' ? 'audio' : '';
  if (!kind) return;
  await inPage(`window.__flowMedia && window.__flowMedia.resume(${JSON.stringify(kind)})`);
  report();
});
ipcRenderer.on('flow:media-stop', async (_event, device) => {
  const kind = device === 'camera' ? 'video' : device === 'microphone' ? 'audio' : '';
  if (!kind) return;
  await inPage(`window.__flowMedia && window.__flowMedia.stop(${JSON.stringify(kind)})`);
  report();
});

let edited = false;
window.addEventListener('input', (e) => {
  if (edited || !e.isTrusted) return;
  edited = true;
  ipcRenderer.send('flow:edited');
}, { capture: true, passive: true });

// A form post is left out: repeating it would need its data.
navigation.addEventListener('navigate', (e) => {
  if (!e.isTrusted || e.destination.sameDocument || e.formData || e.downloadRequest !== null) return;
  const delta = e.navigationType === 'traverse' && e.destination.index >= 0 && navigation.currentEntry ? e.destination.index - navigation.currentEntry.index : null;
  ipcRenderer.send('flow:page-navigate', { type: e.navigationType, url: e.destination.url, delta });
});

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !e.isTrusted || window.top !== window) return;
  // After the page's own handlers (setTimeout): a page that takes the pinch itself (a map, Figma) keeps it; otherwise it
  // is reported to the host, which zooms the page inside at the fingers, as Chrome's pinch does, unless the fingers make
  // it the space's pinch (page.js, nav.js pinchKind).
  setTimeout(() => {
    if (e.defaultPrevented) return;
    ipcRenderer.sendToHost('flow:pinch', { deltaY: e.deltaY * (e.deltaMode === 1 ? 16 : 1), x: e.clientX, y: e.clientY, vv: { s: visualViewport.scale, ox: visualViewport.offsetLeft, oy: visualViewport.offsetTop } });
  }, 0);
}, { capture: true, passive: true });
// The zoomed page's visual viewport is moved to (x, y) of the layout viewport, so the point under the fingers stays
// there: a fixed-position marker (fixed is in layout-viewport coordinates) is brought to the top-left of the view, which
// moves only the visual viewport. The page sees no scroll of its own.
ipcRenderer.on('flow:pinch-anchor', (_event, at) => {
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
  const m = document.createElement('div');
  m.style.cssText = `position:fixed;left:${at.x}px;top:${at.y}px;width:1px;height:1px;pointer-events:none;visibility:hidden`;
  document.documentElement.appendChild(m);
  m.scrollIntoView({ block: 'start', inline: 'start', behavior: 'instant' });
  m.remove();
});

function scrollerX(el) {
  if (!el || el.nodeType !== 1 || el.scrollWidth <= el.clientWidth + 1) return false;
  let ox = getComputedStyle(el).overflowX;
  if (el === document.scrollingElement) {
    if (ox === 'visible' && document.body) ox = getComputedStyle(document.body).overflowX;
    return ox !== 'hidden' && ox !== 'clip';
  }
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || /^(auto|scroll|overlay)$/.test(ox);
}

function scrollsX(path, dir) {
  for (const el of path) if (scrollerX(el) && (dir > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0)) return true;
  return false;
}

// Whether anything in the document can scroll sideways (found), by walks of its elements in idle time, a few ms at a
// time: of the whole document once the page has loaded and after each resize, and, while nothing is found, of what the
// page adds and the boxes it adds it to (a Sheet builds its grid once its data is in, 12 s after its address on a slow
// load). A whole walk costs about 3 µs an element (50 ms for a long Wikipedia article on the Linux VM), too much for a
// wheel to wait on; a walk for the page's additions waits 100 times what the last walk cost, so a page that keeps
// changing spends at most about 1% on them. One in a shadow root or a frame is left out: its scroll events never reach
// the document's listener below, so holding wheels for it would only delay the switch.
let found = false;
let walking = null;   // the walk in progress
let added = [];       // what the page added since the last walk began; null: over 1000, so the next walk is a whole one
let nextAt = 0;       // no walk for the page's additions before this (performance.now())
let soonTimer = 0;
const adds = new MutationObserver((records) => {
  for (const r of records) {
    // many at once: the box they went into stands for them (each node read here costs about 3 µs)
    if (r.addedNodes.length > 50) added.push(r.target);
    else for (const n of r.addedNodes) if (n.nodeType === 1) added.push(n);
    if (added.length > 1000) {
      // the whole walk to come looks again at everything, and observes again as it starts
      added = null;
      adds.disconnect();
      break;
    }
  }
  soon();
});
function soon() {
  if (walking || soonTimer || (added && !added.length)) return;
  const wait = nextAt - performance.now();
  if (wait > 0) soonTimer = setTimeout(() => { soonTimer = 0; soon(); }, wait);
  else look(!added);
}
function* elements(roots) {
  if (!roots) {
    const walk = document.createTreeWalker(document.documentElement || document, NodeFilter.SHOW_ELEMENT);
    for (let el = walk.currentNode; el; el = walk.nextNode()) yield el;
    return;
  }
  const seen = new Set();
  for (const root of roots) {
    if (!root.isConnected || seen.has(root)) continue;
    // the boxes it went into: one of them may be wider than its view now
    for (let a = root.parentElement; a && !seen.has(a); a = a.parentElement) {
      seen.add(a);
      yield a;
    }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walk.currentNode; el; el = walk.nextNode()) {
      if (seen.has(el)) continue;
      seen.add(el);
      yield el;
    }
  }
}
function look(whole) {
  const items = elements(whole ? null : added);
  added = [];
  if (whole && document.documentElement) adds.observe(document.documentElement, { childList: true, subtree: true });
  walking = items;
  let spent = 0;
  const step = (deadline) => {
    if (walking !== items) return;
    const start = performance.now();
    const until = start + Math.max(deadline.timeRemaining(), 4);
    let hit = false;
    for (let it = items.next(); !it.done; it = items.next()) {
      if (scrollerX(it.value)) {
        hit = true;
        break;
      }
      if (performance.now() > until) {
        spent += performance.now() - start;
        requestIdleCallback(step, { timeout: 1000 });
        return;
      }
    }
    spent += performance.now() - start;
    walking = null;
    nextAt = performance.now() + 100 * spent;
    if (whole || hit) found = hit;
    if (found) {
      adds.disconnect();
      added = [];
      return;
    }
    soon();
  };
  requestIdleCallback(step, { timeout: 1000 });
}
window.addEventListener('load', () => look(true));
window.addEventListener('resize', () => look(true));

// nav gives each wheel gesture one owner, decided by its first 4 px of travel (nav.js take()), so a scroll that starts
// vertical stays with the page even if it drifts sideways. Only what that needs is sent (a fast scroll is 60 to 120
// wheels a second): every event until the gesture is decided, every mostly sideways one, and one per 100 ms to keep the
// gesture open (nav ends it after 220 ms without one, by event time). The timeout reads defaultPrevented after the
// page's own listeners have run.
// A page can also scroll with its own code, which the event does not show: a Sheet's grid is a canvas, and its wheel
// listener moves a scroller beside it without preventDefault. So a gesture whose wheels go on while something in the page
// scrolls sideways is the page's (scroll events reach the document's capture listener from any element). On a page where
// something can scroll sideways (found above) or has (moved), sideways wheels are held until that is known, each keeping
// its own time; any other page sends them at once, so switching over it is as quick as ever. A busy page answers late,
// and it is late to handle the wheel too: a real Sheet, from no CPU throttling to 6x, handled the first wheel 28 to
// 1000 ms after it was made and answered 46 to 688 ms after that. So the hold is HOLD_MS plus how late the first held
// wheel reached the page, at most HOLD_MAX_MS, and a scroll counts for a gesture until GAP_MS plus that lateness after
// the page handled its last wheel (by the wheels' own times it would come too late).
const GAP_MS = 220;
const DECIDE_PX = 4;
const KEEP_MS = 100;
const HOLD_MS = 80;
const HOLD_MAX_MS = 600;
let gesture = null;   // { last, seen, late, travel, sent, used, open, held, timer }: event times in epoch ms; seen: when
                      //   the page handled its last wheel (performance.now()), late: how long after it was made
let moved = false;
const lefts = new WeakMap();   // element -> its scrollLeft at its last scroll event
const send = (m) => ipcRenderer.sendToHost('flow:wheel', m);
function settle(g) {
  clearTimeout(g.timer);
  g.open = false;
  for (const m of g.held.splice(0)) send({ ...m, used: g.used });
}
document.addEventListener('scroll', (e) => {
  const el = e.target === document ? document.scrollingElement : e.target;
  if (!el || el.nodeType !== 1) return;
  const before = lefts.get(el);
  const left = el.scrollLeft;
  lefts.set(el, left);
  if (before === undefined ? left === 0 : left === before) return;
  moved = true;
  const g = gesture;
  if (!g || g.used || performance.now() - g.seen > GAP_MS + g.late) return;
  g.used = true;
  if (g.open) settle(g);
}, { capture: true, passive: true });
// A two-finger double tap on the trackpad (src/touch.js 'flow:double-tap'), then a swipe sideways over this page within
// TURN_MS, goes back (the fingers move right) or forward (left), once, as Chrome's two-finger page swipe does; the
// swipe is the page's, so the board does not move with it. A double tap that came while this page was being scrolled
// (two quick flicks, not taps) does nothing.
const TURN_MS = 1500;
let turnUntil = 0;
let lastWheel = -Infinity;
ipcRenderer.on('flow:double-tap', (_event, { t }) => {
  if (Number.isFinite(t) && t - lastWheel > 2 * GAP_MS) turnUntil = t + TURN_MS;
});
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey || !e.isTrusted) return;
  const t = performance.timeOrigin + e.timeStamp;
  lastWheel = t;
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerWidth : 1;
  const dx = e.deltaX * k;
  const dy = e.deltaY * k;
  if (!gesture || t - gesture.last > GAP_MS) gesture = { last: t, seen: 0, late: 0, travel: 0, sent: -Infinity, used: false, open: true, held: [], timer: 0, turn: t <= turnUntil };
  if (gesture.turn && gesture.travel + Math.abs(dx) + Math.abs(dy) >= DECIDE_PX && Math.abs(dx) > Math.abs(dy)) {
    gesture.turn = false;
    turnUntil = 0;
    gesture.used = true;
    if (dx < 0) history.back();
    else history.forward();
  }
  gesture.last = Math.max(gesture.last, t);
  gesture.seen = performance.now();
  const late = Math.max(0, performance.timeOrigin + gesture.seen - t);
  gesture.late = late;
  const deciding = gesture.travel < DECIDE_PX;
  gesture.travel += Math.abs(dx) + Math.abs(dy);
  const sideways = Math.abs(dx) > Math.abs(dy);
  if (!deciding && !sideways && t - gesture.sent < KEEP_MS) return;
  gesture.sent = t;
  let could = false;
  if (sideways) {
    const path = e.composedPath();
    if (document.scrollingElement && !path.includes(document.scrollingElement)) path.push(document.scrollingElement);
    could = scrollsX(path, dx > 0 ? 1 : -1);
  }
  const g = gesture;
  setTimeout(() => {
    if (could || e.defaultPrevented) g.used = true;
    if (g.open && !g.used && (g.held.length || (sideways && (found || moved)))) {
      g.held.push({ dx, dy, t });
      if (!g.timer) g.timer = setTimeout(() => settle(g), Math.min(HOLD_MAX_MS, HOLD_MS + late));
      return;
    }
    if (g.open) settle(g);
    send({ dx, dy, t, used: g.used });
  }, 0);
}, { capture: true, passive: true });

// Marks: sentences the owner quoted in this page's note, painted with the CSS Custom Highlight API, so the site's DOM
// never changes (page.js asks, notes.js decides what). From the host: 'flow:marks' [{ text }], the whole set ([] clears),
// and 'flow:find-quote' { id, text }. To the host: 'flow:mark-hover' { text, x, y, w, h } or null (CSS px in this page's
// viewport), 'flow:mark-click' { text }, 'flow:find-quote' { id, found }. A quote is matched with all whitespace ignored
// (a quote can span elements and lines), its first occurrence only; one that is not on the page is skipped, and for 15 s
// after the marks arrive one is still looked for in what the page adds or changes (only there, so a busy page stays
// cheap).
const MARK = 'flow-mark';
const FLASH = 'flow-mark-flash';
const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TEMPLATE)$/;
let wanted = [];          // the quotes the host asked for
let marks = [];           // [{ text, range }] found on this page
let styled = false;
let watcher = null;
let watchUntil = 0;
let rescan = 0;
let changed = new Set();  // nodes the page added or changed since the last look
let hovered = null;

function markStyle() {
  if (styled) return;
  styled = true;
  webFrame.insertCSS(`::highlight(${MARK}){background-color:rgba(255,213,74,.5)}::highlight(${FLASH}){background-color:rgba(255,170,0,.85)}`);
}

// The text under root without whitespace, kept as runs: each run of non-space characters remembers its text node and
// where it starts there, so a match maps back to the page.
function textMap(root) {
  const nodes = [];
  const runStart = [];
  const runNode = [];
  const runOff = [];
  const parts = [];
  let length = 0;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentNode && SKIP.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const run = /\S+/g;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const d = n.data;
      let k = -1;
      run.lastIndex = 0;
      for (let m = run.exec(d); m; m = run.exec(d)) {
        if (k < 0) {
          k = nodes.length;
          nodes.push(n);
        }
        runStart.push(length);
        runNode.push(k);
        runOff.push(m.index);
        parts.push(m[0]);
        length += m[0].length;
      }
    }
  }
  const text = parts.join('');
  const lower = text.toLowerCase();
  return { text, lower: lower.length === text.length ? lower : '', nodes, runStart, runNode, runOff };
}

// Text node and offset of character i of the map's text.
function spot(map, i) {
  let lo = 0;
  let hi = map.runStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.runStart[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return [map.nodes[map.runNode[lo]], map.runOff[lo] + (i - map.runStart[lo])];
}

function locate(map, quote) {
  const needle = String(quote || '').replace(/\s+/g, '');
  if (needle.length < 2) return null;
  let i = map.text.indexOf(needle);
  if (i < 0 && map.lower) {
    // text-transform shows a page's words in other case than its DOM has them
    const low = needle.toLowerCase();
    if (low.length === needle.length) i = map.lower.indexOf(low);
  }
  if (i < 0) return null;
  const [sn, so] = spot(map, i);
  const [en, eo] = spot(map, i + needle.length - 1);
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo + 1);
  return r;
}

// The host draws ↗ only beside the quotes the page has (notes), so it hears which ones each time that changes.
const tellFound = () => ipcRenderer.sendToHost('flow:marks-found', marks.map((m) => m.text));

function show() {
  if (marks.length) {
    markStyle();
    CSS.highlights.set(MARK, new Highlight(...marks.map((m) => m.range)));
  } else CSS.highlights.delete(MARK);
}

function paint() {
  const map = textMap(document.body || document.documentElement);
  marks = [];
  for (const q of wanted) {
    const r = locate(map, q.text);
    if (r) marks.push({ text: q.text, range: r });
  }
  show();
  tellFound();
  if (marks.length < wanted.length && Date.now() < watchUntil) watch();
  else unwatch();
}

// A quote still missing is looked for only in what the page added or changed since the last look (at most every
// 400 ms): a page that changes all the time costs what it changes, not a walk of everything.
function watch() {
  if (watcher) return;
  changed = new Set();
  watcher = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'characterData') changed.add(rec.target.parentNode);
      else for (const n of rec.addedNodes) changed.add(n.nodeType === 3 ? n.parentNode : n);
    }
    if (!rescan && changed.size) rescan = setTimeout(lookAgain, 400);
  });
  watcher.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
}
function unwatch() {
  if (!watcher) return;
  watcher.disconnect();
  watcher = null;
  clearTimeout(rescan);
  rescan = 0;
  changed = new Set();
}
function lookAgain() {
  rescan = 0;
  if (Date.now() >= watchUntil) {
    unwatch();
    return;
  }
  const roots = [...changed].filter((n) => n && n.isConnected && n.nodeType === 1);
  changed = new Set();
  // Many changes at once: one walk of the page costs less than sorting them out.
  const outer = roots.length > 300 ? [document.body || document.documentElement] : roots.filter((n) => !roots.some((o) => o !== n && o.contains(n)));
  let found = false;
  for (const root of outer) {
    const missing = wanted.filter((q) => !marks.some((m) => m.text === q.text));
    if (!missing.length) break;
    const map = textMap(root);
    if (!map.text) continue;
    for (const q of missing) {
      const r = locate(map, q.text);
      if (r) {
        marks.push({ text: q.text, range: r });
        found = true;
      }
    }
  }
  if (found) {
    show();
    tellFound();
  }
  if (marks.length >= wanted.length) unwatch();
}

function markAt(x, y) {
  const p = document.caretPositionFromPoint(x, y);
  if (!p || !p.offsetNode) return null;
  for (const m of marks) {
    if (!m.range.isPointInRange(p.offsetNode, p.offset)) continue;
    // The caret position is the nearest one: the pointer must also be over the mark's own text.
    for (const r of m.range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m;
  }
  return null;
}

ipcRenderer.on('flow:marks', (_event, list) => {
  wanted = (Array.isArray(list) ? list : []).filter((m) => m && typeof m.text === 'string' && m.text.trim());
  watchUntil = Date.now() + 15000;
  hovered = null;
  unwatch();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint, { once: true });
  else paint();
});

ipcRenderer.on('flow:find-quote', (_event, { id, text }) => {
  const m = marks.find((x) => x.text === text);
  const range = m ? m.range : locate(textMap(document.body || document.documentElement), text);
  if (!range) {
    ipcRenderer.sendToHost('flow:find-quote', { id, found: false });
    return;
  }
  const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  placeStopped = true;
  if (el) el.scrollIntoView({ block: 'center' });
  markStyle();
  CSS.highlights.set(FLASH, new Highlight(range));
  setTimeout(() => CSS.highlights.delete(FLASH), 1200);
  ipcRenderer.sendToHost('flow:find-quote', { id, found: true });
});

let hoverFrame = 0;
window.addEventListener('mousemove', (e) => {
  if (!marks.length || hoverFrame) return;
  const x = e.clientX;
  const y = e.clientY;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const m = markAt(x, y);
    if (m === hovered) return;
    hovered = m;
    if (!m) {
      ipcRenderer.sendToHost('flow:mark-hover', null);
      return;
    }
    const b = m.range.getBoundingClientRect();
    ipcRenderer.sendToHost('flow:mark-hover', { text: m.text, x: b.left, y: b.top, w: b.width, h: b.height });
  });
}, { capture: true, passive: true });

window.addEventListener('mouseout', (e) => {
  if (e.relatedTarget || !hovered) return;
  hovered = null;
  ipcRenderer.sendToHost('flow:mark-hover', null);
}, { capture: true, passive: true });

window.addEventListener('click', (e) => {
  if (!marks.length || !e.isTrusted || e.button !== 0 || !getSelection().isCollapsed) return;
  const m = markAt(e.clientX, e.clientY);
  if (m) ipcRenderer.sendToHost('flow:mark-click', { text: m.text });
}, { capture: true, passive: true });

// A page brought back (back or forward, a reload, a tab after a restart) gets its old scroll offset from Chromium, again
// once it has loaded. A web font that arrives after that still moved the text: scroll anchoring kept in view what the
// fallback font had at that offset (rfc9110 came back 101 px off, another paragraph at the top). So the page keeps the
// offset, with no scroll anchoring, until the owner scrolls, types or clicks there, or 10 s after it loaded.
const arrival = performance.getEntriesByType('navigation')[0]?.type;
if (arrival === 'back_forward' || arrival === 'reload') {
  const INPUT = ['wheel', 'keydown', 'pointerdown', 'touchstart'];
  const key = webFrame.insertCSS('html{overflow-anchor:none !important}');
  let timer = 0;
  let on = true;
  const anchorAgain = () => {
    if (!on) return;
    on = false;
    clearTimeout(timer);
    for (const type of INPUT) window.removeEventListener(type, anchorAgain, true);
    webFrame.removeInsertedCSS(key);
  };
  for (const type of INPUT) window.addEventListener(type, anchorAgain, { capture: true, passive: true });
  window.addEventListener('load', () => { timer = setTimeout(anchorAgain, 10000); }, { once: true });
}

// A page that moves itself before the owner has done anything in it (location.replace or assign, a meta refresh, a form
// that submits itself, an SPA's pushState or replaceState to another path) tells the host 'flow:moved-self' { from, to,
// same }, so a name or note kept under the old address can follow it (page.js onRedirect). Reload, back and forward
// never count, nor a change of the hash alone, nor any move once the page has had a press, a key, a wheel or a touch.
let usedYet = false;
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(type, (e) => { if (e.isTrusted) usedYet = true; }, { capture: true, passive: true });
}
navigation.addEventListener('navigate', (e) => {
  if (!e.isTrusted || e.userInitiated || usedYet || navigator.userActivation.hasBeenActive) return;
  if ((e.navigationType !== 'push' && e.navigationType !== 'replace') || e.hashChange || e.downloadRequest !== null) return;
  const from = location.href;
  const to = e.destination.url;
  if (to === from) return;
  if (!e.destination.sameDocument) {
    setTimeout(() => { if (!e.defaultPrevented) ipcRenderer.sendToHost('flow:moved-self', { from, to, same: false }); }, 0);
    return;
  }
  if (new URL(to).pathname === location.pathname) return;
  navigation.addEventListener('currententrychange', () => {
    if (location.href === to) ipcRenderer.sendToHost('flow:moved-self', { from, to, same: true });
  }, { once: true });
});

// Whether the page has a selection, so page.js shows ✂ only then: 'flow:selection' true or false to the host, each
// time that changes. Text selected in a text field counts, as the clip reads it; a selection inside a frame or a PDF
// does not reach here (Clip to Note in the right-click menu clips it).
let selected = false;
let selFrame = 0;
document.addEventListener('selectionchange', () => {
  if (selFrame) return;
  selFrame = requestAnimationFrame(() => {
    selFrame = 0;
    const a = document.activeElement;
    const s = getSelection();
    const field = !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel)$/i.test(a.type)));
    const now = (!!s && !s.isCollapsed) || (field && a.selectionEnd > a.selectionStart);
    if (now === selected) return;
    selected = now;
    ipcRenderer.sendToHost('flow:selection', now);
  });
}, { capture: true, passive: true });

// At quit page.js keeps where this page is scrolled (Chromium records a scroll in the page's history only about a
// second after it ends) and gives it back after a restart: the page goes there once loaded, unless the owner has done
// anything in it by then or the page restores its own scroll (history.scrollRestoration 'manual'). Item 16's rule
// above then keeps it there while late fonts come in.
// A page that scrolls inside boxes of its own (an editor, a board and its columns, a sheet's scrollbars beside its
// canvas) keeps those places too: the boxes it has scrolled, which a scroll listener in the capture phase sees, and the
// scrolled boxes around the middle of the view; at most four, the largest first. The main one, the scrollable box
// around the middle of the view, also keeps the text at its top edge, which finds the place again when what is above
// it arrives late or changes. A box is found again by its id, or by its tag and classes and its place among the
// elements that match them.
const scrolledBoxes = new Set();
document.addEventListener('scroll', (e) => { if (e.target instanceof Element) scrolledBoxes.add(e.target); }, { capture: true, passive: true });
const away = (e) => e.scrollTop > 0 || e.scrollLeft > 0;
const scrollRange = (e) => e.scrollHeight - e.clientHeight + e.scrollWidth - e.clientWidth;
function mainScroller() {
  for (let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    if (e.clientHeight < innerHeight * 0.4 || (e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1)) continue;
    const s = getComputedStyle(e);
    if (/auto|scroll|overlay/.test(s.overflowY) || /auto|scroll|overlay/.test(s.overflowX)) return e;
  }
  return null;
}
const flatText = (s) => s.replace(/\s+/g, ' ').trim();
// The words of the element at the box's top edge, its own (a box of other elements there, a board of cards, has
// none of its own and is passed over), so lineIn finds them again as they are.
function topLine(box) {
  const r = box.getBoundingClientRect();
  for (let dy = 2; dy < Math.min(r.height, 240); dy += 10) {
    const e = document.elementFromPoint(r.left + r.width / 2, r.top + dy);
    if (!e || e === box || !box.contains(e)) continue;
    const own = [...e.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && flatText(n.data).length >= 8);
    if (own) return { text: flatText(own.data).slice(0, 80), off: Math.round(e.getBoundingClientRect().top - r.top) };
  }
  return null;
}
// The element in a box whose own words start with a kept top line, if the page has it now.
function lineIn(box, text) {
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (flatText(n.data).startsWith(text)) return n.parentElement;
  }
  return null;
}
function boxKey(e) {
  if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) return { sel: `#${CSS.escape(e.id)}`, nth: 0 };
  const sel = e.tagName.toLowerCase() + [...e.classList].slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
  return { sel, nth: [...document.querySelectorAll(sel)].indexOf(e) };
}
function boxPlaces() {
  const main = mainScroller();
  const boxes = [...scrolledBoxes].filter((e) => e.isConnected && away(e));
  for (let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    if (away(e) && !boxes.includes(e)) boxes.push(e);
  }
  return boxes.sort((a, b) => scrollRange(b) - scrollRange(a)).slice(0, 4)
    .map((e) => ({ ...boxKey(e), top: Math.round(e.scrollTop), left: Math.round(e.scrollLeft), ...(e === main ? topLine(e) || {} : {}) }));
}
// The owner went somewhere in the page through Flow (a find, a quote from notes): a place still being put back stops.
let placeStopped = false;
ipcRenderer.on('flow:stop-restore', () => { placeStopped = true; });
// One box per task, with a pause: a sheet keeps only one of its two scrollbars when both are set in the same task.
// Each waits (up to 10 s in all) until its box is there and long enough for its place, or its kept line is there. Then
// it is held: put back when it moves without the owner, until those 10 s are up or 5 s after the last box is placed:
// a page that sets its own place once its data is in (Notion, about a second after it shows) would take it away
// again. A box placed by its offsets moves to its kept line when that arrives.
function placeBoxes(list) {
  const end = Date.now() + 10000;
  const left = list.slice();
  const held = [];
  let holdUntil = end;
  const byOffsets = new Set();
  const find = (at) => document.querySelectorAll(at.sel)[at.nth];
  // Puts a box at its place (its kept line when the page has it, else its offsets); false when it is there already or
  // cannot move any nearer (its page is shorter now). One whose kept line is not there yet goes by its offsets once and
  // is not held there: what arrives above it meanwhile moves it on purpose (scroll anchoring).
  const put = (at, e) => {
    const line = at.text ? lineIn(e, at.text) : null;
    if (at.text && !line) {
      if (byOffsets.has(at)) return false;
      byOffsets.add(at);
    }
    const dy = line ? line.getBoundingClientRect().top - e.getBoundingClientRect().top - at.off : at.top - e.scrollTop;
    if (Math.abs(dy) <= 2 && Math.abs(at.left - e.scrollLeft) <= 2) return false;
    const top = e.scrollTop;
    const x = e.scrollLeft;
    e.scrollTop += dy;
    e.scrollLeft = at.left;
    return e.scrollTop !== top || e.scrollLeft !== x;
  };
  const step = () => {
    if (usedYet || placeStopped || navigator.userActivation.hasBeenActive) return;
    for (const at of held) {
      const e = find(at);
      if (e && put(at, e)) {
        setTimeout(step, 100);
        return;
      }
    }
    const at = left[0];
    const e = at && Date.now() <= end ? find(at) : null;
    if (e && ((at.text && lineIn(e, at.text)) || (e.scrollHeight - e.clientHeight >= at.top - 1 && e.scrollWidth - e.clientWidth >= at.left - 1))) {
      put(at, e);
      held.push(left.shift());
      holdUntil = Math.max(holdUntil, Date.now() + 5000);
      setTimeout(step, 100);
      return;
    }
    if (Date.now() < holdUntil) setTimeout(step, 250);
  };
  step();
}
// A PDF: page.js has main set its viewer up (thumbnails closed, a place kept from before a restart).
window.addEventListener('DOMContentLoaded', () => {
  if (document.contentType === 'application/pdf') ipcRenderer.sendToHost('flow:pdf');
}, { once: true });
ipcRenderer.on('flow:scroll-now', (_event, id) => ipcRenderer.sendToHost('flow:scroll-now', { id, x: scrollX, y: scrollY, boxes: boxPlaces() }));
// The same place, sent by the page itself 150 ms after any scroll in it comes to rest ('flow:scrolled' { x, y, boxes }):
// a quit whose read above comes too late for page.js (a busy renderer) still has where the owner left the page.
let restTimer = 0;
document.addEventListener('scroll', () => {
  clearTimeout(restTimer);
  restTimer = setTimeout(() => ipcRenderer.sendToHost('flow:scrolled', { x: scrollX, y: scrollY, boxes: boxPlaces() }), 150);
}, { capture: true, passive: true });
ipcRenderer.on('flow:restore-scroll', (_event, at) => {
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
  const go = () => requestAnimationFrame(() => {
    if (usedYet || placeStopped || navigator.userActivation.hasBeenActive) return;
    if (history.scrollRestoration === 'auto') window.scrollTo({ left: at.x, top: at.y, behavior: 'instant' });
    if (Array.isArray(at.boxes) && at.boxes.length) placeBoxes(at.boxes);
  });
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
});

// A drag over this page (a file from Finder) shows the host none of its events, so the host is told when the drag is
// done with the page, 'flow:drag-done': dropped here, or gone from the page or let go where the page took nothing
// (Chromium then fires dragleave at the element the drag last entered; leaving one element for another fires dragenter
// at the new one first, and an element the page removed mid-drag gets no dragleave here).
let dragAt = null;
const dragDone = () => {
  dragAt = null;
  ipcRenderer.sendToHost('flow:drag-done');
};
window.addEventListener('dragenter', (e) => { if (e.isTrusted) dragAt = e.target; }, { capture: true, passive: true });
window.addEventListener('dragleave', (e) => { if (e.isTrusted && e.target === dragAt) dragDone(); }, { capture: true, passive: true });
window.addEventListener('drop', (e) => { if (e.isTrusted) dragDone(); }, { capture: true, passive: true });




