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
