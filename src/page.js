/* Flow page: real web pages in tabs, with saved pages (BRIEF.md 2.3). */
(() => {
  'use strict';

  const DESKTOP_WIDTH = 1180;
  const SEARCH = 'https://www.google.com/search?q=';
  const ERR_ABORTED = -3;
  const NOT_FOUND = new Set([-105, -137]);
  // An https address typed without a scheme falls back to http on these (as Chrome's HTTPS upgrades do), plus
  // every certificate error (-200 to -299).
  const HTTP_FALLBACK = new Set([-100, -101, -102, -107, -113]);
  const CANNOT_OPEN = 'flow cannot open this kind of address';
  const PLAIN = {
    '-7': 'the site took too long to respond',
    '-21': 'the network changed while loading',
    '-100': 'the connection was closed',
    '-101': 'the connection was reset',
    '-102': 'the site refused to connect',
    '-105': 'the address could not be found',
    '-106': 'you are offline',
    '-109': 'the site cannot be reached',
    '-118': 'the site took too long to respond',
    '-137': 'the address could not be found',
    '-300': 'that is not a valid address',
    '-301': CANNOT_OPEN,
    '-302': CANNOT_OPEN,
    '-310': 'the site redirected too many times',
    '-324': 'the site sent nothing back',
  };
  const GONE = { crashed: 'the page crashed', oom: 'the page ran out of memory', killed: 'the page was stopped by the system' };
  const SCHEME_RE = /^(?:https?|file|about|data|blob|view-source|chrome|mailto|tel):|^[a-z][a-z0-9+.-]*:\/\//i;
  // What main lets a webview load (will-attach-webview refuses any other src, and the webview then never attaches).
  const LOADABLE_RE = /^(?:https?:|flow-file:|about:blank$)/i;
  const ERROR_PAGE_RE = /^chrome-error:\/\/chromewebdata\/?$/i;
  // A workspace file's HTML page (a report): main runs it in a session of its own with no network, picked from the
  // webview's first address, which the webview then keeps.
  const REPORT_RE = /^flow-file:[^?#]*\.html?(?:[?#]|$)/i;
  // A site's icon only as an inline image: Flow's own document never fetches from a site (a stored address would be
  // fetched at launch, and fail once the site is gone).
  const ICON_RE = /^data:image\//i;
  // How long a closed page whose site guards unsaved typing lives on out of sight (lead, Nov 2).
  const HOLD_MS = 10000;
  const RECOVER_STABILIZE_MS = 1000;
  const RECOVER_MAX_MS = 3000;
  // A load that failed for want of the network tries again by itself after 2 s, then twice as long each time, up to 30 s.
  const RETRY_FIRST_MS = 2000;
  const RETRY_MAX_MS = 30000;
  const NETWORK_DOWN = new Set([-7, -21, -100, -101, -102, -104, -105, -106, -109, -118, -130, -137, -324]);
  // Whether a page shows nothing: no visible text, and no visible image, media, canvas, frame or form field.
  const BLANK_JS = `(() => { const b = document.body; if (!b) return true; if ((b.innerText || '').trim()) return false;
    return ![...b.querySelectorAll('img,svg,video,canvas,iframe,embed,object,input,textarea,select,[contenteditable]')]
      .some((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; }); })()`;
  // How long a tab can go unseen before it gives up its page to keep the Mac light (lead, item 57).
  const UNLOAD_MS = 30 * 60 * 1000;
  const HOST_RE = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]*[a-z0-9¡-￿])?\.)+[a-z¡-￿][a-z0-9¡-￿-]*)(:\d{1,5})?([/?#].*)?$/i;
  const LOCAL_RE = /^(?:localhost|\[.*\]|\d{1,3}(?:\.\d{1,3}){3}|.+\.(?:localhost|local|test|internal|lan|home\.arpa))$/i;
  // The selection in the focused field, frame or document. A page selection is first widened to whole words (a drag
  // usually starts or ends mid-word, and a #:~:text= link only matches whole words); the visible selection follows.
  // A frame from another site, a PDF or a plugin keeps its selection to itself: framed says the focus is in one.
  const SELECTION_JS = `(() => {
    const wc = /[\\p{L}\\p{N}]/u;
    const mid = (n, i) => n.nodeType === 3 && i > 0 && i < n.data.length && wc.test(n.data[i - 1]) && wc.test(n.data[i]);
    const pick = (doc) => {
      if (doc.contentType === 'application/pdf') return { text: '', framed: true };
      const a = doc.activeElement;
      if (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) {
        const inner = a.contentDocument;
        if (!inner) return { text: '', framed: true };
        const r = pick(inner);
        if (r.text || r.framed) return r;
      }
      if (a && (a.tagName === 'EMBED' || a.tagName === 'OBJECT')) return { text: '', framed: true };
      if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel)$/i.test(a.type))) && a.selectionEnd > a.selectionStart) {
        return { text: a.value.slice(a.selectionStart, a.selectionEnd), framed: false };
      }
      const s = doc.getSelection ? doc.getSelection() : null;
      if (!s) return { text: '', framed: false };
      if (s.rangeCount && !s.isCollapsed) {
        const r = s.getRangeAt(0);
        let so = r.startOffset, eo = r.endOffset;
        while (mid(r.startContainer, so)) so--;
        while (mid(r.endContainer, eo)) eo++;
        if (so !== r.startOffset) r.setStart(r.startContainer, so);
        if (eo !== r.endOffset) r.setEnd(r.endContainer, eo);
      }
      return { text: String(s), framed: false };
    };
    return pick(document);
  })()`;
  // What the page says it is about: its description, else its first real paragraph.
  const ABOUT_JS = `(() => {
    const text = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const meta = (sel) => { const m = document.querySelector(sel); return m ? text(m.content) : ''; };
    let about = meta('meta[name="description" i]') || meta('meta[property="og:description" i]') || meta('meta[name="twitter:description" i]');
    if (!about) {
      for (const p of document.querySelectorAll('main p, article p, p')) {
        const t = text(p.innerText);
        if (t.length >= 60) { about = t; break; }
      }
    }
    return about.slice(0, 300);
  })()`;

  const noop = () => {};
  const search = (text) => ({ url: SEARCH + encodeURIComponent(text), kind: 'search', text });
  /* Chromium drops a :~:text= directive from the page's own address once it has scrolled to it: so does Flow. */
  function tidy(u) {
    const s = String(u || '');
    const h = s.indexOf('#');
    const d = h < 0 ? -1 : s.indexOf(':~:', h);
    if (d < 0) return s;
    const out = s.slice(0, d);
    return out.endsWith('#') ? out.slice(0, -1) : out;
  }
  /* A file tab's own path, since its signed flow-file: address means nothing to the owner: a Mac file in ~ form, a VM
     file as its full path there (only the Mac's home is known here), with where it is. */
  function fileOf(u) {
    const m = /^flow-file:\/\/(mac|vm)\/[^/?#]+\/([^?#]*)/i.exec(String(u || ''));
    if (!m) return null;
    let parts;
    try {
      parts = m[2].split('/').filter(Boolean).map(decodeURIComponent);
    } catch (e) {
      if (e instanceof URIError) return null;
      throw e;
    }
    if (m[1].toLowerCase() === 'vm') return parts.length > 1 ? { path: '/' + parts.slice(1).join('/'), where: 'on the VM' } : null;
    const p = '/' + parts.join('/');
    const home = window.flow && typeof window.flow.homeDir === 'string' ? window.flow.homeDir.replace(/\/+$/, '') : '';
    return { path: home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p, where: '' };
  }
  // What the address field shows while it is being edited: the address itself, or a file tab's path.
  const editable = (u) => { const f = fileOf(u); return f ? f.path : tidy(u); };
  const display = (u) => { const f = fileOf(u); return f ? f.path : tidy(u).replace(/^https:\/\/(?:www\.)?/i, '').replace(/^([^/?#]+)\/$/, '$1'); };
  const hostOf = (u) => {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:www\.)?([^/?#]+)/i.exec(String(u || ''));
    return m ? m[1] : display(u);
  };
  /* %XX escapes as UTF-8 text; a broken sequence becomes U+FFFD instead of failing. */
  function unescapeURL(s) {
    let out = '';
    const bytes = [];
    const flush = () => {
      if (bytes.length) out += new TextDecoder().decode(new Uint8Array(bytes.splice(0)));
    };
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        flush();
        out += s[i];
      }
    }
    flush();
    return out;
  }
  /* What to call a page that has not loaded yet: the last part of its path when it reads as words, else its site. */
  function nameOf(u) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(String(u || ''));
    const last = m ? m[1].split('/').filter(Boolean).pop() || '' : '';
    const words = unescapeURL(last).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_+-]+/g, ' ').trim();
    return /\p{L}{3}/u.test(words) ? words : hostOf(u);
  }
  const sameURL = (a, b) => String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, '');
  const samePath = (a, b) => {
    try {
      const x = new URL(a), y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname;
    } catch (_) {
      return false;
    }
  };
  const plainError = (code) => PLAIN[code] || (code <= -200 && code > -300 ? "the site's certificate is not trusted" : 'this page could not be loaded');

  /* A URL (scheme optional) or search words. kind 'host' marks an address typed without a scheme. */
  function resolve(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    if (/^javascript:/i.test(t)) return search(t);
    if (SCHEME_RE.test(t)) return URL.canParse(t) ? { url: new URL(t).href, kind: 'url', text: t } : search(t);
    const m = /\s/.test(t) ? null : HOST_RE.exec(t);
    if (m) {
      const u = (LOCAL_RE.test(m[1]) ? 'http://' : 'https://') + t;
      if (URL.canParse(u)) return { url: new URL(u).href, kind: 'host', text: t, bare: !m[2] && !m[3] };
    }
    return search(t);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /* One observer for every page view: the webviews are laid out at desktop width and scaled down to fit. */
  const sizers = new WeakMap();
  const ro = new ResizeObserver((entries) => entries.forEach(({ target }) => {
    const fit = sizers.get(target);
    if (fit) fit();
  }));

  /* Popups, ⌘-clicks, "Open Link in New Page" and "Clip to Note" arrive once per Flow window; route them to the
     tab they came from by its guest webContents id. */
  const byGuest = new Map();
  /* An event for a guest no tab is bound to yet waits up to 2 s for the tab that binds that id: a webview's first
     events, the end of a small download among them, can come before Electron has attached it. */
  const unbound = new Map();   // guestId -> { list: [{ what, fn }], timer }
  // Each mounted page's tab whose webview has a given guest but is not bound to it yet: a site asks to sign in during
  // the first load, before the events that bind a tab.
  const unboundTabs = new Set();
  // Every mounted page's media refresh: main says the camera or microphone changed once, and each page asks again. One
  // listener for all of them, so a board of many pages adds no listener per page.
  const mediaWatchers = new Set();
  let mediaRouted = false;
  function watchMedia(fn) {
    if (!mediaRouted && window.flow && typeof window.flow.onPageMediaChanged === 'function') {
      mediaRouted = true;
      window.flow.onPageMediaChanged(() => { for (const f of mediaWatchers) f(); });
    }
    mediaWatchers.add(fn);
    return () => mediaWatchers.delete(fn);
  }
  function deliver(guestId, tab) {
    const u = unbound.get(guestId);
    if (!u) return;
    clearTimeout(u.timer);
    unbound.delete(guestId);
    for (const x of u.list) x.fn(tab);
  }
  let routed = false;
  // Tab ids: stable across reorder, closing others and restarts (notes keys a tab's note to it).
  let tabSeq = 0;
  const newTabId = () => `t-${Date.now().toString(36)}${(++tabSeq).toString(36)}`;
  function route() {
    if (routed) return;
    routed = true;
    if (!window.flow || typeof window.flow.onPageNewWindow !== 'function') {
      console.error('flow page: window.flow.onPageNewWindow is missing, so popups and ⌘-click cannot open tabs');
      return;
    }
    window.flow.onPageNewWindow(({ url, disposition, guestId }) => {
      const tab = byGuest.get(guestId);
      if (!tab) {
        console.warn(`flow page: a popup (${disposition}) came from webview ${guestId}, which is not a page in this window: ${url}`);
        return;
      }
      tab.popup(url, disposition);
    });
    const routeTo = (what, guestId, fn) => {
      const tab = byGuest.get(guestId);
      if (tab) {
        fn(tab);
        return;
      }
      let u = unbound.get(guestId);
      if (!u) {
        u = { list: [], timer: 0 };
        u.timer = setTimeout(() => {
          unbound.delete(guestId);
          for (const x of u.list) console.warn(`flow page: ${x.what} came from webview ${guestId}, which is not a page in this window`);
        }, 2000);
        unbound.set(guestId, u);
      }
      u.list.push({ what, fn });
    };
    if (typeof window.flow.onPageClip === 'function') {
      window.flow.onPageClip(({ guestId, text }) => routeTo('a clip', guestId, (tab) => tab.clipText(text)));
    }
    if (typeof window.flow.onPageDownload === 'function') {
      window.flow.onPageDownload((d) => routeTo('a download', d && d.guestId, (tab) => tab.downloaded(d)));
    }
    if (typeof window.flow.onPageLogin === 'function') {
      window.flow.onPageLogin(({ guestId, requestId, host, again }) => {
        // A new tab's first load can ask before its webview here knows its guest: it is looked for again for 2 s.
        const find = (tries) => {
          const tab = byGuest.get(guestId) || [...unboundTabs].map((f) => f(guestId)).find(Boolean);
          if (tab) tab.signIn({ requestId, host: String(host || ''), again: again === true });
          else if (tries < 40) setTimeout(() => find(tries + 1), 50);
          else {
            console.warn(`flow page: a sign-in came from webview ${guestId}, which is not a page in this window`);
            window.flow.answerPageLogin(requestId, null);
          }
        };
        find(0);
      });
    }
    if (typeof window.flow.onPageOpenExternal === 'function') {
      window.flow.onPageOpenExternal(({ guestId, url, requestId }) => {
        const tab = byGuest.get(guestId);
        if (tab) tab.openExternal(url, requestId);
        else {
          console.warn(`flow page: a link to another app came from webview ${guestId}, which is not a page in this window`);
          window.flow.answerExternal(requestId, false);
        }
      });
    }
  }

  function mount(container, opts) {
    const o = opts || {};
    const onTabs = o.onTabs || noop;
    const onNavigate = o.onNavigate || noop;
    const onTitle = o.onTitle || noop;
    const onClip = o.onClip || noop;
    const onFocus = o.onFocus || noop;
    const onWheel = o.onWheel || noop;
    const onPinch = o.onPinch || (() => false);
    const onClose = o.onClose || noop;
    const onDownload = o.onDownload || noop;
    const onMark = o.onMark || noop;
    const onPage = o.onPage || noop;
    const onRedirect = o.onRedirect || noop;
    // A drag (a file from Finder) ended inside a page: it dropped there or left the page, which Flow's window never sees.
    const onDragDone = o.onDragDone || noop;
    // bare: only the page itself (a live page unfolded inside a note): no tab strip, no address line, no new-tab list.
    const bare = !!o.bare;
    const onOpen = typeof o.onOpen === 'function' ? o.onOpen : null;
    // A tab dragged off the strip or sent to a new window: the app takes it (true) as a window of its own where it
    // was let go (at, or beside this one when null), or into another page window's strip.
    const onTabOut = typeof o.onTabOut === 'function' ? o.onTabOut : null;
    const showMenu = typeof o.showMenu === 'function' ? o.showMenu : null;
    // The owner's own name for a page, wherever it opens (notes keeps it; the app passes nameOf(url)).
    const pageName = typeof o.nameOf === 'function' ? (u) => String(o.nameOf(u) || '') : () => '';
    const saved = o.saved && typeof o.saved.find === 'function' ? o.saved : null;
    const unloadAfter = Number.isFinite(o.unloadAfter) && o.unloadAfter >= 0 ? o.unloadAfter : UNLOAD_MS;
    // a pop-out space (index.html?zone=...): its pages stay while it is on screen
    const popout = /[?&]zone=/.test(location.search);
    route();

    let shown = false;
    let visible = false;
    let disposed = false;
    let dirty = false;
    let clickFocus = false;
    let findReq = 0;
    let findText = '';
    let findTab = null;
    let hintTimer = 0;
    let tabsQueued = false;
    let quoteReq = 0;
    const quoteWaits = new Map();
    const scrollAsks = new Map();   // id -> resolve, for the page preload's 'flow:scroll-age'
    let scrollAskId = 0;
    const listeners = [];
    const on = (target, type, fn) => {
      target.addEventListener(type, fn);
      listeners.push([target, type, fn]);
    };

    /* ---------- the tab strip (only with two tabs or more), the address line and the page view ---------- */
    const strip = el('div', 'ptabs');
    const addr = el('div', 'addr');
    const navBtn = (nav, glyph, label) => {
      const b = el('button', 'nv off', glyph);
      b.type = 'button';
      b.dataset.nav = nav;
      b.title = label;
      return b;
    };
    const back = navBtn('back', '‹', 'back');
    const fwd = navBtn('fwd', '›', 'forward');
    const rel = navBtn('reload', '↻', 'reload');
    const input = el('input', 'ad');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'address');
    const hint = el('span', 'phint');
    const where = el('span', 'pwhere');
    const star = el('button', 'nv pstar off', '☆');
    star.type = 'button';
    star.dataset.save = '';
    star.title = 'save this page';
    star.hidden = !saved;
    const clipBtn = el('button', 'nv pclip off', '✂');
    clipBtn.type = 'button';
    clipBtn.dataset.clip = '';
    clipBtn.title = 'clip the selection to the note';
    // Camera and microphone as Chrome shows them: one shield in the bar while a site holds a device (or is refused one),
    // opening a panel with a switch per device, the OS gate, and reset. Nothing stands in the bar otherwise.
    const media = el('span', 'pmedia');
    media.hidden = true;
    const shield = el('button', 'nv pshield', '\u26BF');
    shield.type = 'button';
    shield.title = 'camera and microphone';
    on(shield, 'mousedown', (e) => { e.preventDefault(); e.stopPropagation(); openMediaMenu(shield); });
    media.append(shield);
    // A new tab: always there at the end of the address line, whatever the tab count (owner, Nov 7 01/13), so it never
    // moves as tabs come and go.
    const plus = el('button', 'pt-new', '+');
    plus.type = 'button';
    plus.title = 'new tab (⌘T)';
    const bar = el('i', 'pload');
    addr.append(back, fwd, rel, input, where, hint, star, clipBtn, media, plus, bar);

    const pgv = el('div', 'pgv');
    const fresh = el('div', 'pnew');
    const card = el('div', 'pcard');
    const err = el('div', 'perr');
    const errT = el('div', 'pe-t');
    const errD = el('div', 'pe-d');
    const errR = el('button', 'pe-r', 'try again');
    errR.type = 'button';
    err.append(errT, errD, errR);
    const find = el('div', 'pfind');
    const fq = el('input', 'pf-q');
    fq.type = 'text';
    fq.spellcheck = false;
    fq.autocomplete = 'off';
    fq.placeholder = 'find in page';
    const fn = el('span', 'pf-n');
    const fPrev = el('button', 'pf-b', '↑');
    const fNext = el('button', 'pf-b', '↓');
    const fClose = el('button', 'pf-b', '×');
    [fPrev, fNext, fClose].forEach((b) => { b.type = 'button'; });
    fPrev.title = 'previous (shift enter)';
    fNext.title = 'next (enter)';
    fClose.title = 'close (esc)';
    find.append(fq, fn, fPrev, fNext, fClose);
    // A question from the shown tab's page: unsaved changes, or a link to another app.
    const ask = el('div', 'pask');
    const askT = el('span', 'pa-t');
    const askYes = el('button', 'pa-b pa-yes');
    const askNo = el('button', 'pa-b');
    askYes.type = 'button';
    askNo.type = 'button';
    ask.append(askT, askYes, askNo);
    // A site's own sign-in (HTTP auth) for the shown tab's page: its name and password, in the page's area.
    const login = el('form', 'plogin');
    const loginT = el('div', 'pl-t');
    const loginName = el('input', 'pl-f');
    const loginPass = el('input', 'pl-f');
    const loginGo = el('button', 'pl-b', 'sign in');
    loginName.placeholder = 'name';
    loginName.autocomplete = 'username';
    loginName.spellcheck = false;
    loginPass.type = 'password';
    loginPass.placeholder = 'password';
    loginPass.autocomplete = 'current-password';
    loginGo.type = 'submit';
    login.append(loginT, loginName, loginPass, loginGo);
    // What the owner wrote under a quoted sentence, while the pointer is on its mark in the page.
    const markCard = el('div', 'pmark');
    pgv.append(fresh, card, err, markCard, login);
    // Find and a question take the address line's place, over none of the page; a bare page has no address line.
    (bare ? pgv : addr).append(find, ask);
    pgv.classList.toggle('bare', bare);
    if (bare) container.append(pgv);
    else container.append(strip, addr, pgv);

    /* ---------- tabs ---------- */
    const tabs = [];
    const unboundTab = (guestId) => tabs.find((t) => t.guestId == null && t.wv && guestIdOf(t.wv) === guestId) || null;
    unboundTabs.add(unboundTab);
    let cur = 0;
    const st = () => tabs[cur];

    // Where a tab's page was scrolled, as its preload says: the page's own offset, and the boxes it scrolls inside
    // (each found again by a selector and its place among the matches, the main one with the text at its top edge).
    function scrollOf(a) {
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
      const at = { x: a.x, y: a.y };
      const boxes = (Array.isArray(a.boxes) ? a.boxes : []).filter((b) => b && typeof b.sel === 'string' && b.sel.length <= 300 && Number.isInteger(b.nth) && b.nth >= 0 && Number.isFinite(b.top) && Number.isFinite(b.left)).slice(0, 4)
        .map((b) => (typeof b.text === 'string' && b.text ? { sel: b.sel, nth: b.nth, top: b.top, left: b.left, text: b.text.slice(0, 80), off: Number.isFinite(b.off) ? b.off : 0 } : { sel: b.sel, nth: b.nth, top: b.top, left: b.left }));
      if (boxes.length) at.boxes = boxes;
      if (a.pdf && Number.isFinite(a.pdf.x) && Number.isFinite(a.pdf.y)) at.pdf = { x: a.pdf.x, y: a.pdf.y };
      return at;
    }

    function rememberGood(t, at) {
      if (!t || t.err || !t.url || ERROR_PAGE_RE.test(t.url) || !LOADABLE_RE.test(t.url)) return;
      const history = validHistory(t.history);
      const active = history && history.entries[history.index];
      if (active && !sameURL(active.url, t.url)) return;
      const scroll = scrollOf(at) || scrollOf(t.place) || scrollOf(t.scroll);
      t.good = {
        url: t.url,
        title: t.title,
        icon: t.icon,
        history,
        scroll,
        zoom: t.zoom,
      };
    }

    // Where a tab was on the other side of a report line: its address, title, web history and place.
    function sideOf(a) {
      if (!a || typeof a.url !== 'string' || !LOADABLE_RE.test(a.url)) return null;
      return { url: a.url, title: String(a.title || ''), history: validHistory(a.history), scroll: scrollOf(a.scroll) };
    }
    const sidesOf = (list) => (Array.isArray(list) ? list.map(sideOf).filter(Boolean).slice(-10) : []);
    function makeTab(u, t, kept) {
      const r = resolve(u);
      const k = kept || {};
      const history = validHistory(k.history);
      const tab = {
        id: typeof k.id === 'string' && /^t-[a-z0-9]+$/.test(k.id) ? k.id : newTabId(),
        url: r ? r.url : '', title: String(t || ''), wv: null, guestId: null, pending: null, committed: '',
        inflight: false, typed: null, loading: false, titleSince: true, err: null, mine: [],
        history, historyJSON: history ? JSON.stringify(history) : '', histTimer: 0, restoring: false,
        zoom: Number.isFinite(k.zoom) ? k.zoom : 0, ask: null, login: null, restored: false, scrollBack: null, pdfBack: null, putting: null,
        good: null, recovering: false, reloading: false, reloadRequest: 0, recoverHistory: null, recoverTimer: 0,
        scroll: scrollOf(k.scroll),
        marks: null, marksPage: '', reported: '', docs: 0, nav: null, selfMove: null, restoredFrom: '', selection: false,
        report: false, before: sidesOf(k.before), after: sidesOf(k.after),
        icon: typeof k.icon === 'string' && ICON_RE.test(k.icon) ? k.icon : '',
        seenAt: Date.now(), playing: false,
      };
      if (history && tab.url) rememberGood(tab, tab.scroll);
      tab.popup = (url, disposition) => {
        if (disposed) return;
        if (!url || /^(?:about:blank|javascript:)/i.test(url)) {
          console.warn(`flow page: ignored a popup without an address (${url})`);
          return;
        }
        // A link or form of the page that would cross between a report and the web, which main stopped: the page goes
        // there in its own tab, in a new webview (REPORT_RE).
        if (disposition === 'current-tab') {
          const r = resolve(url);
          if (r && !refuse(r)) go(tab, r);
          return;
        }
        // A bare page has no tabs to open: the app opens the link beside it (onOpen), or it goes there itself.
        if (bare) {
          if (onOpen) onOpen(url);
          else go(tab, resolve(url));
          return;
        }
        // A new page the owner asks for (a shift-click, "Open Link in New Page") is a page window of its own beside
        // this one; a tab comes from ⌘-click, a middle click, target=_blank and a page's window.open after a click.
        if (onOpen && (disposition === 'new-window' || disposition === 'new-page')) {
          onOpen(url);
          return;
        }
        newTab(url, { show: disposition !== 'background-tab', after: tabs.indexOf(tab) });
      };
      // From the menu's "Clip to Note", which read the selection in main: widen it to whole words where the page can
      // read its own selection (it cannot in a PDF or another site's frame, where main's text is used as it is).
      tab.clipText = (text) => {
        const s = String(text || '').trim();
        if (disposed || !s) return;
        const flat = (x) => x.replace(/\s+/g, ' ').trim();
        const read = tab.guestId == null ? Promise.resolve('') : tab.wv.executeJavaScript(SELECTION_JS).then((r) => String((r && r.text) || '').trim(), (e) => {
          console.warn('flow page: could not read the selection to widen it to whole words', e);
          return '';
        });
        read.then((words) => {
          if (!disposed && tabs.includes(tab)) clipped(tab, words && flat(words).includes(flat(s)) ? words : s);
        });
      };
      // A download from this tab: the app records it with its workspace. Only one that failed says so here, since the
      // owner's click then did nothing.
      tab.downloaded = (d) => {
        if (disposed || !d) return;
        onDownload({ url: d.url, file: d.file, state: d.state, bytes: d.bytes, page: tidy(tab.url) });
        // A tab that never showed a page, opened for what became this download, has nothing to show. Once the file is
        // with the downloads it closes, and its window with it when it was the only tab; it waits for this end, which
        // main sends through the tab's page. One whose download failed goes back to a new tab, to say so.
        const forDownload = !tab.committed && !tab.inflight && tab.url;
        if (forDownload && d.state === 'completed') {
          closeSelf(tab);
          return;
        }
        if (forDownload) blankTab(tab);
        if (d.state === 'completed') return;
        const name = String(d.file || '').split(/[\\/]/).pop() || 'the file';
        flashHint(`could not download ${name.length > 40 ? `${name.slice(0, 39)}…` : name}`, 4000);
      };
      tab.openExternal = (url, requestId) => {
        askTab(tab, { text: `open in another app? ${url}`, yes: 'open', no: 'cancel', answer: (open) => window.flow.answerExternal(requestId, open) });
      };
      // The site asks for a name and password (again: the last ones did not work); a newer ask answers an older one
      // with nothing.
      tab.signIn = (q) => {
        if (tab.login) window.flow.answerPageLogin(tab.login.requestId, null);
        tab.login = q;
        ifShown(tab, renderLogin);
      };
      return tab;
    }

    function validHistory(h) {
      if (!h || typeof h !== 'object' || !Array.isArray(h.entries) || !h.entries.length || h.entries.length > 50) return null;
      if (!Number.isInteger(h.index) || h.index < 0 || h.index >= h.entries.length) return null;
      const ok = h.entries.every((e) => e && typeof e.url === 'string' && /^https?:/i.test(e.url) && (e.pageState == null || typeof e.pageState === 'string'));
      return ok ? { index: h.index, entries: h.entries.map((e) => (e.pageState ? { url: e.url, title: String(e.title || ''), pageState: e.pageState } : { url: e.url, title: String(e.title || '') })) } : null;
    }

    const snapshot = () => tabs.map((t) => {
      const e = { id: t.id, url: tidy(t.url), title: t.title };
      if (t.history) e.history = t.history;
      if (t.zoom) e.zoom = t.zoom;
      if (t.scroll) e.scroll = t.scroll;
      if (t.before.length) e.before = t.before;
      if (t.after.length) e.after = t.after;
      if (t.icon) e.icon = t.icon;
      return e;
    });
    function emitTabs() {
      if (tabsQueued || disposed) return;
      tabsQueued = true;
      queueMicrotask(() => {
        tabsQueued = false;
        if (!disposed) onTabs(snapshot(), cur);
      });
    }

    const label = (t) => (t.url && pageName(tidy(t.url))) || t.title || (t.url ? nameOf(t.url) : 'new tab');
    // Each tab keeps its element and a render changes only text and classes: a press on a tab or its × must not lose
    // its click to another tab's title changing (Chromium drops a click whose pressed element left the page). Elements
    // move only when the order changed, and not while a tab is dragged, since the drag places it.
    let dragged = null;
    function tabEl(t) {
      if (!t.stripEl) {
        const x = el('button', 'pt-x', '×');
        x.type = 'button';
        x.title = 'close tab';
        t.stripEl = el('div', 'ptab');
        // drawn before the title (page.css order), after it here so the title stays the first child
        t.stripIcon = el('img', 'pt-i');
        t.stripIcon.alt = '';
        t.stripIcon.hidden = true;
        t.stripIcon.addEventListener('error', () => { t.stripIcon.hidden = true; });
        t.stripEl.append(el('span', 'pt-t', ''), x, t.stripIcon);
      }
      return t.stripEl;
    }
    function renderStrip() {
      strip.classList.toggle('on', tabs.length > 1);
      if (tabs.length < 2) {
        strip.replaceChildren();
        return;
      }
      const els = tabs.map((t, i) => {
        const e = tabEl(t);
        const name = label(t);
        const title = t.url ? `${name}\n${display(t.url)}` : 'new tab';
        e.classList.toggle('on', i === cur);
        if (e.title !== title) e.title = title;
        if (e.firstChild.textContent !== name) e.firstChild.textContent = name;
        if (t.stripIcon.dataset.src !== t.icon) {
          t.stripIcon.dataset.src = t.icon;
          t.stripIcon.hidden = !t.icon;
          if (t.icon) t.stripIcon.src = t.icon;
          else t.stripIcon.removeAttribute('src');
        }
        return e;
      });
      if (dragged) return;
      const want = els;
      for (const c of [...strip.children]) if (!want.includes(c)) c.remove();
      want.forEach((e, i) => {
        if (strip.children[i] !== e) strip.insertBefore(e, strip.children[i] || null);
      });
      // More tabs than fit: the strip scrolls sideways, keeping the shown tab in view.
      const on = els[cur];
      if (on) {
        const l = on.offsetLeft, r = l + on.offsetWidth;
        if (l < strip.scrollLeft) strip.scrollLeft = l;
        else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth;
      }
    }

    /* ---------- layout: each webview at desktop width, scaled to fit ---------- */
    function layout() {
      const w = pgv.clientWidth, h = pgv.clientHeight;
      if (!w || !h) return;
      const rw = Math.max(w, DESKTOP_WIDTH), s = w / rw;
      for (const t of tabs) {
        if (!t.wv) continue;
        // A workspace file (files.js) reads at the window's own width; a site gets the desktop width it was made for.
        const own = /^flow-file:/i.test(t.url), tw = own ? w : rw, ts = own ? 1 : s;
        t.wv.style.width = `${tw}px`;
        t.wv.style.height = `${h / ts}px`;
        t.wv.style.transform = ts < 1 ? `scale(${ts})` : '';
      }
    }
    sizers.set(pgv, layout);
    ro.observe(pgv);

    /* ---------- what the shown tab looks like ---------- */
    function showAddress() {
      const t = st();
      void refreshMedia();
      const f = fileOf(t.url);
      where.textContent = (f && f.where) || '';
      where.classList.toggle('on', !!(f && f.where));
      if (document.activeElement === input) {
        if (!dirty) input.value = editable(t.url);
        return;
      }
      input.value = display(t.url);
    }

    function updateNav() {
      const t = st();
      const ready = t.guestId != null;
      // ‹ and › from where the tab is in its history as main last gave it, whatever its pages are (a file, a PDF), until
      // then from the history kept for a restart (never the webview's canGoBack: a blocking call into main on every
      // render); a page of another kind to go back to shows ‹ even before the tab knows its new page
      const h = ready && (t.navAt || (t.history && { index: t.history.index, length: t.history.entries.length }));
      back.classList.toggle('off', !(t.before.length || (h && h.index > 0)));
      fwd.classList.toggle('off', !(t.after.length || (h && h.index < h.length - 1)));
      rel.classList.toggle('off', !t.wv);
      clipBtn.classList.toggle('off', !ready);
      // ✂ shows only while the page has a selection (its preload says when that changes).
      clipBtn.classList.toggle('nosel', !ready || !t.selection);
    }

    function renderLoading(restart) {
      if (st().loading) {
        if (restart || !bar.classList.contains('on')) {
          bar.classList.remove('end');
          void bar.offsetWidth;
          bar.classList.add('on');
        }
      } else if (bar.classList.contains('on')) {
        bar.classList.remove('on');
        bar.classList.add('end');
      }
    }

    function renderError() {
      const e = st().err;
      err.classList.toggle('on', !!e);
      if (!e) return;
      errT.textContent = e.t;
      errD.textContent = e.d;
      errD.title = e.d;
    }

    function renderStar() {
      if (!saved) return;
      const t = st();
      const can = !!t.url && LOADABLE_RE.test(t.url);
      const e = can ? saved.find(tidy(t.url)) : null;
      star.textContent = e ? '★' : '☆';
      star.classList.toggle('on', !!e);
      star.classList.toggle('off', !can);
      star.title = e ? `saved in ${e.section}, click to remove it` : 'save this page';
    }

    /* A new tab lists this workspace's saved pages, by section. */
    function renderNew() {
      const t = st();
      const blank = !t.url || !LOADABLE_RE.test(t.url);
      fresh.classList.toggle('on', blank);
      hideCard();
      if (!blank) return;
      if (t.url) {
        fresh.replaceChildren(el('div', 'pn-empty', CANNOT_OPEN));
        return;
      }
      if (bare) {
        fresh.replaceChildren();
        return;
      }
      const all = saved ? saved.all().filter((s) => s.here) : [];
      if (!all.length) {
        fresh.replaceChildren();
        return;
      }
      const groups = new Map();
      for (const s of all) {
        if (!groups.has(s.section)) groups.set(s.section, { name: s.section, list: [] });
        groups.get(s.section).list.push(s);
      }
      const order = [...groups.values()].sort((a, b) => Math.max(...b.list.map((x) => x.at || 0)) - Math.max(...a.list.map((x) => x.at || 0)));
      const list = el('div', 'pn-list');
      for (const g of order) {
        list.append(el('div', 'pn-sec', g.name));
        for (const s of g.list.sort((a, b) => (b.at || 0) - (a.at || 0))) {
          const row = el('div', 'pn-row');
          row.dataset.url = s.url;
          row.append(el('span', 'pn-t', pageName(s.url) || s.title || display(s.url)), el('span', 'pn-h', hostOf(s.url)));
          row.savedEntry = s;
          list.append(row);
        }
      }
      fresh.replaceChildren(list);
    }

    function showCard(row) {
      const s = row.savedEntry;
      card.replaceChildren(el('div', 'pc-t', pageName(s.url) || s.title || display(s.url)), el('div', 'pc-u', display(s.url)));
      if (s.about) card.append(el('div', 'pc-a', s.about));
      const r = row.getBoundingClientRect(), v = pgv.getBoundingClientRect();
      card.classList.add('on');
      const top = Math.min(r.bottom - v.top + 4, pgv.clientHeight - card.offsetHeight - 6);
      card.style.top = `${Math.max(6, top)}px`;
      card.style.left = `${Math.max(6, Math.min(r.left - v.left + 24, pgv.clientWidth - card.offsetWidth - 6))}px`;
    }
    function hideCard() {
      card.classList.remove('on');
    }

    /* Marks (notes.js): quoted sentences painted in the page by its preload. They belong to the page they were set on:
       a reload or an in-page navigation paints them again, another page drops them until setMarks is called again. */
    // The page marks belong to: its address without the hash, and a file's without its signature (a file is the same
    // page under a fresh one).
    const pageOf = (u) => tidy(u).replace(/#.*$/, '').replace(/^(flow-file:\/\/(?:mac|vm)\/)[^/?#]+\//i, '$1');
    function sendMarks(t) {
      if (!t.wv || t.guestId == null || !t.marks || pageOf(t.url) !== t.marksPage) return;
      t.wv.send('flow:marks', t.marks.map((m) => ({ text: m.text })));
    }
    function showMark(t, a) {
      const m = a && t === st() && t.wv && (t.marks || []).find((x) => x.text === a.text);
      if (!m || !m.note.trim()) {
        hideMark();
        return;
      }
      markCard.textContent = m.note;
      markCard.classList.add('on');
      const r = t.wv.getBoundingClientRect(), v = pgv.getBoundingClientRect();
      const s = t.wv.offsetWidth ? r.width / t.wv.offsetWidth : 1;
      const left = r.left - v.left + a.x * s, top = r.top - v.top + a.y * s, bottom = top + a.h * s;
      const below = bottom + 6 + markCard.offsetHeight <= pgv.clientHeight;
      markCard.style.top = `${Math.max(6, below ? bottom + 6 : top - 6 - markCard.offsetHeight)}px`;
      markCard.style.left = `${Math.max(6, Math.min(left, pgv.clientWidth - markCard.offsetWidth - 6))}px`;
    }
    function hideMark() {
      markCard.classList.remove('on');
    }
    /* onRedirect: a tab's page went on to another address by itself, through a server redirect or by moving before the
       owner did anything in it (the page's preload says which), so what notes keeps under the old address can follow. */
    function redirected(from, to, how) {
      const a = tidy(from);
      const b = tidy(to);
      if (a !== b && LOADABLE_RE.test(a) && LOADABLE_RE.test(b)) onRedirect({ from: a, to: b, how });
    }
    // onPage: once a tab's page has loaded, what notes keeps for it. A read that failed or ran out of time says no
    // about (notes keeps the one it has), and the page's next load in the tab reads it again.
    function reportPage(t) {
      const u = tidy(t.url);
      if (!LOADABLE_RE.test(u) || u === 'about:blank' || t.err || t.reported === u) return;
      t.reported = u;
      aboutOf(t).then((about) => {
        if (disposed || !tabs.includes(t) || t.reported !== u) return;
        if (about === null) t.reported = '';
        onPage({ url: u, title: t.title, about: about || '' });
      });
    }

    function renderView() {
      const t = st();
      for (const x of tabs) if (x.wv) x.wv.classList.toggle('off', x !== t);
      pgv.classList.toggle('live', !!t.wv && !!t.url && LOADABLE_RE.test(t.url));
      // A workspace file's page draws its own background, which no white may show around.
      pgv.classList.toggle('file', !!fileOf(t.url));
    }

    function renderAsk() {
      const q = st().ask;
      ask.classList.toggle('on', !!q);
      if (!q) return;
      askT.textContent = q.text;
      askT.title = q.text;
      askYes.textContent = q.yes;
      askNo.textContent = q.no;
    }

    function renderLogin() {
      const q = st().login;
      const was = login.classList.contains('on');
      login.classList.toggle('on', !!q);
      if (!q) return;
      loginT.textContent = q.again ? 'that name and password did not work' : q.host;
      if (was) return;
      if (!q.again) loginName.value = '';
      loginPass.value = '';
      if (container.contains(document.activeElement) || document.activeElement === document.body) (q.again ? loginPass : loginName).focus();
    }
    function answerLogin(answer) {
      const t = st();
      const q = t.login;
      if (!q) return;
      t.login = null;
      loginPass.value = '';
      renderLogin();
      window.flow.answerPageLogin(q.requestId, answer);
    }

    function render() {
      renderStrip();
      renderView();
      showAddress();
      updateNav();
      renderLoading(false);
      renderError();
      renderStar();
      renderNew();
      renderAsk();
      renderLogin();
    }

    /* A question shows on its tab until answered; a newer one on the same tab answers the older one with no. */
    function askTab(t, q) {
      const old = t.ask;
      t.ask = q;
      if (old) old.answer(false);
      ifShown(t, renderAsk);
    }
    function answerAsk(yes) {
      const t = st();
      const q = t.ask;
      if (!q) return;
      t.ask = null;
      renderAsk();
      q.answer(yes);
    }

    const ifShown = (t, fn2) => { if (t === st() && !disposed) fn2(); };

    /* ---------- one tab's page ---------- */
    function setLoading(t, v) {
      if (t.loading === v) return;
      t.loading = v;
      ifShown(t, () => renderLoading(true));
    }
    function showError(t, title, detail, retry, recover = false) {
      t.err = { t: title, d: detail, retry, recover };
      ifShown(t, renderError);
    }
    function clearError(t) {
      t.err = null;
      stopRetry(t);
      ifShown(t, renderError);
    }
    function stopRetry(t) {
      clearTimeout(t.retryTimer);
      t.retryTimer = 0;
      t.retryWait = 0;
    }
    function retry() {
      const t = st();
      const f = t.err && t.err.retry;
      if (f) f();
      else clearError(t);
    }

    /* getWebContentsId() throws until the guest is attached, which is certain by the first commit, failure or dom-ready. */
    /* Puts the keyboard in a tab's page. A webview that has not attached yet would take the focus whenever it attaches,
       and that focus brings its window to the front: so the focus waits for the attach and is dropped if the keys go
       somewhere else first (the owner presses or types outside this page, or Flow puts them in another field). */
    let pendingFocus = null;
    function away(e) {
      if (!container.contains(e.target)) dropPendingFocus();
    }
    function dropPendingFocus() {
      if (!pendingFocus) return;
      pendingFocus = null;
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', away, true);
      document.removeEventListener('focusin', away, true);
    }
    /* Electron lands a webview's focus in two steps, the second up to tens of ms later (far more on a busy machine).
       When the owner went elsewhere before it landed (the keys to the address, a name field, ⌘K, or a press on another
       window's title bar, which takes no keys), it gives them back there, and the page's window is not brought forward
       for it; nor for a tab no longer shown. It waits for the landing, at most 5 s. */
    function handBack(t) {
      // a newer focus asked for this tab replaces the one still on its way
      if (t.handing) t.handing.stop();
      const wv = t.wv;
      // the owner's last move counts: the keys to something else (to), or a press outside this page (away)
      const h = { to: null, away: false, stop: null };
      const moved = (e) => {
        if (e.target === wv) return;
        h.to = e.target;
        h.away = false;
      };
      const pressed = (e) => {
        if (container.contains(e.target)) return;
        h.away = true;
        h.to = null;
      };
      let timer = 0;
      const stop = () => {
        clearTimeout(timer);
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', pressed, true);
        wv.removeEventListener('focus', landed);
        if (t.handing === h) t.handing = null;
      };
      h.stop = stop;
      // each step of the landing (the second can fire focus again a moment after the first)
      const landed = () => {
        if (h.to && h.to.isConnected) h.to.focus({ preventScroll: true });
        else if (h.away || t !== st()) wv.blur();
        clearTimeout(timer);
        timer = setTimeout(stop, 150);
      };
      timer = setTimeout(stop, 5000);
      t.handing = h;
      document.addEventListener('focusin', moved, true);
      document.addEventListener('pointerdown', pressed, true);
      wv.addEventListener('focus', landed);
    }
    function focusTab(t) {
      dropPendingFocus();
      if (disposed || !t.url) return;
      if (t.guestId != null) {
        // Only a webview that did not have the keys gets the late focus; one that had them gets none, and a later
        // focus (the owner's click into the page) must keep the keys there.
        const had = document.activeElement === t.wv;
        t.wv.focus();
        if (!had) handBack(t);
        return;
      }
      pendingFocus = t;
      document.addEventListener('pointerdown', away, true);
      document.addEventListener('keydown', away, true);
      document.addEventListener('focusin', away, true);
    }

    /* A webview's id once Electron has attached its guest. The guest's first events can come before that (a first
       address that is a download from a server this close), and getWebContentsId then throws: bind tries again shortly,
       and does what that event could not (a download-only load leaves no later event to bind on). */
    function guestIdOf(wv) {
      try {
        return wv.getWebContentsId();
      } catch (e) {
        if (/must be attached to the DOM/.test(String(e && e.message))) return null;
        throw e;
      }
    }
    function bind(t) {
      if (t.guestId != null || !t.wv) return;
      const id = guestIdOf(t.wv);
      if (id == null) {
        if ((t.bindTries = (t.bindTries || 0) + 1) > 100) {
          if (t.bindTries === 101) console.warn('flow page: a webview was not attached within 5 s', t.url);
          return;
        }
        if (!t.bindRetry) {
          t.bindRetry = setTimeout(() => {
            t.bindRetry = 0;
            if (disposed || !tabs.includes(t)) return;
            bind(t);
            if (t.guestId != null && t.inflight && !t.wv.isLoading()) dropped(t);
          }, 50);
        }
        return;
      }
      t.guestId = id;
      byGuest.set(t.guestId, t);
      // After the event that bound it has done its part (a load that became a download is dropped first).
      queueMicrotask(() => deliver(id, t));
      if (t.steps && t.steps.length) queueMicrotask(() => nextStep(t));
      if (pendingFocus === t) {
        dropPendingFocus();
        if (t === st()) {
          t.wv.focus();
          handBack(t);
        }
      }
      if (t.zoom && typeof window.flow.setPageZoom === 'function') {
        window.flow.setPageZoom(t.guestId, t.zoom).catch((e) => console.warn('flow page: could not set the page zoom', e));
      }
      if (t.pending) {
        const u = t.pending;
        t.pending = null;
        load(t, u);
      }
    }

    function load(t, u) {
      t.inflight = true;
      t.wv.loadURL(u).catch((e) => {
        if (disposed || !t.wv) return;
        // Network failures also arrive as did-fail-load, which draws the error state. -3 (a newer navigation, a
        // download or an external app took over) and -2 (loading stopped without a page) are not page failures.
        if (/\((-?\d+)\) loading '/.test(String(e && e.message))) return;
        console.error('flow page: loadURL failed', u, e);
        showError(t, 'this page could not be loaded', String((e && e.message) || e), () => load(t, u));
      });
    }

    /* Only web addresses load in the page; mail links go to the mail app. Anything else keeps the page as it is. */
    function refuse(r) {
      if (/^mailto:/i.test(r.url)) {
        window.flow.openExternal(r.url);
        dirty = false;
        showAddress();
        if (document.activeElement === input) input.select();
        return true;
      }
      if (LOADABLE_RE.test(r.url)) return false;
      flashHint(CANNOT_OPEN);
      return true;
    }

    function setIcon(t, u) {
      if (u === t.icon) return;
      t.icon = u;
      rememberGood(t);
      renderStrip();
      emitTabs();
    }
    /* ‹ and ›. One pressed before the tab knows its page (its webview not bound yet, as right after a page of
       another kind took its place) is held and runs at the bind, in order; never dropped (lead, Nov 2). */
    function step(t, dir) {
      if (disposed || !t) return;
      t.reloadRequest += 1;
      t.recovering = false;
      t.reloading = false;
      clearRecoveryHistory(t);
      clearError(t);
      if (t.guestId == null) {
        if (t.wv || t.restoring) (t.steps || (t.steps = [])).push(dir);
        return;
      }
      if (dir < 0) {
        if (!t.wv.canGoBack()) {
          if (t.before.length) cross(t, t.after, () => t.before.pop());
          return;
        }
        t.wv.goBack();
        return;
      }
      if (!t.wv.canGoForward()) {
        if (t.after.length) cross(t, t.before, () => t.after.pop());
        return;
      }
      t.wv.goForward();
    }
    // the next held step, once the tab knows its page (at the bind, and after each step lands)
    function nextStep(t) {
      if (!t.steps || !t.steps.length || t.guestId == null || disposed || !tabs.includes(t)) return;
      step(t, t.steps.shift());
    }

    function go(t, r) {
      t.reloadRequest += 1;
      t.recovering = false;
      t.reloading = false;
      clearRecoveryHistory(t);
      clearError(t);
      // an address the owner gave supersedes ‹ and › still held for this tab
      if (t.steps) t.steps.length = 0;
      if (t.wv && REPORT_RE.test(r.url) !== t.report) {
        cross(t, t.before, () => {
          t.after.length = 0;
          return { url: r.url };
        });
        return;
      }
      t.typed = r.kind === 'host' ? r : null;
      t.url = r.url;
      if (t === st()) {
        dirty = false;
        showAddress();
        renderStar();
        renderNew();
      }
      emitTabs();
      if (!t.wv) {
        createWebview(t);
        return;
      }
      if (t.guestId == null) {
        t.pending = r.url;
        return;
      }
      load(t, r.url);
    }

    /* A tab going between a report and any other page gets a new webview (REPORT_RE), once the page it leaves has let
       it go. Where it was is kept on that side (keep), so back or forward across the line loads that page again. */
    function cross(t, keep, next) {
      const keys = container.contains(document.activeElement);
      Promise.all([guarded(t), refreshHistory(t), scrollNow(t)]).then(([unsaved, , at]) => {
        const to = disposed || !tabs.includes(t) ? null : next();
        if (!to) return;
        keep.push({ url: t.url, title: t.title, history: t.history, scroll: at || t.place || null });
        if (unsaved) park(t);
        dropTab(t);
        clearError(t);
        if (t.login) {
          t.login = null;
          ifShown(t, renderLogin);
        }
        setLoading(t, false);
        Object.assign(t, { url: to.url, title: to.title || '', history: to.history || null, historyJSON: to.history ? JSON.stringify(to.history) : '', navAt: null, scroll: to.scroll || null,
          place: null, restored: false, committed: '', inflight: false, typed: null, selection: false });
        ifShown(t, render);
        createWebview(t);
        emitTabs();
        if (keys && t === st()) focusTab(t);
      });
    }

    function failed(t, code, failedURL) {
      const ty = t.typed;
      t.typed = null;
      if (ty && sameURL(failedURL, ty.url)) {
        if (NOT_FOUND.has(code) && ty.bare) {
          go(t, search(ty.text));
          return;
        }
        if (ty.url.startsWith('https://') && (HTTP_FALLBACK.has(code) || (code <= -200 && code > -300))) {
          go(t, { url: `http://${ty.url.slice(8)}`, kind: 'url', text: ty.text });
          return;
        }
      }
      const good = t.good;
      const keep = !!good && (!!(t.err && t.err.recover) || t.recovering || t.reloading);
      t.inflight = false;
      t.reloading = false;
      t.recovering = false;
      if (keep) {
        Object.assign(t, {
          url: good.url,
          title: good.title,
          icon: good.icon,
          history: validHistory(good.history),
          historyJSON: good.history ? JSON.stringify(good.history) : '',
          navAt: good.history ? { index: good.history.index, length: good.history.entries.length } : t.navAt,
          scroll: scrollOf(good.scroll),
          zoom: good.zoom,
        });
      } else {
        if (failedURL) t.url = failedURL;
        if (!t.titleSince) t.title = '';
      }
      ifShown(t, () => {
        showAddress();
        updateNav();
        renderStar();
      });
      showError(t, plainError(code), display(t.url), () => {
        if (keep) recoverFailed(t);
        else {
          clearError(t);
          load(t, t.url);
        }
      }, keep);
      if (keep && NETWORK_DOWN.has(code)) retryLater(t);
      emitTabs();
      ifShown(t, () => onNavigate({ url: tidy(t.url), title: t.title }));
    }

    /* A navigation that stops without a commit or a failure (a download, a 204, a link to another app, a page that
       would not unload) leaves the page where it was: the address goes back to it. */
    function blankTab(t) {
      t.url = '';
      t.title = '';
      t.typed = null;
      ifShown(t, () => {
        render();
        onTitle('');
      });
      emitTabs();
    }
    function dropped(t) {
      t.inflight = false;
      t.typed = null;
      const was = t.wv.getURL();
      if (!was || was === 'about:blank' || was === t.url) return;
      t.url = was;
      ifShown(t, () => {
        showAddress();
        renderStar();
      });
      emitTabs();
    }

    function mergeRecoveredHistory(current, saved) {
      if (!saved || current.index !== saved.index || current.entries.length !== saved.entries.length) return null;
      return {
        index: current.index,
        entries: current.entries.map((e, i) => samePath(e.url, saved.entries[i].url) ? { ...e, url: saved.entries[i].url } : e),
      };
    }
    /* A tab's back/forward history with Chromium's page state (scroll, form values), as main reads it. */
    function refreshHistory(t, recovery) {
      clearTimeout(t.histTimer);
      t.histTimer = 0;
      if (disposed || t.guestId == null || typeof window.flow.pageHistory !== 'function') return Promise.resolve();
      const docs = t.docs;
      const wv = t.wv;
      return window.flow.pageHistory(t.guestId).then(async (h) => {
        if (disposed || !tabs.includes(t) || t.docs !== docs || t.wv !== wv || (recovery && t.recoverHistory !== recovery)) return;
        // where the tab is, for ‹ and ›, on any page; only an http(s) history is kept for a restart (validHistory)
        const at = h && Number.isInteger(h.index) && Array.isArray(h.entries) ? { index: h.index, length: h.entries.length } : null;
        if (JSON.stringify(at) !== JSON.stringify(t.navAt || null)) {
          t.navAt = at;
          ifShown(t, updateNav);
        }
        let v = validHistory(h);
        if (!v) return;
        let recovered = recovery && recovery.history;
        if (recovered) {
          const merged = mergeRecoveredHistory(v, recovered);
          if (merged) v = merged;
          else {
            clearRecoveryHistory(t);
            recovered = null;
            t.scroll = null;
            t.place = null;
            const active = v.entries[v.index];
            if (active) {
              t.url = active.url;
              t.committed = active.url;
              ifShown(t, () => {
                showAddress();
                renderStar();
                onNavigate({ url: tidy(t.url), title: t.title });
              });
            }
          }
        }
        const active = recovered && v.entries[v.index];
        const currentURL = wv.getURL();
        if (active && samePath(currentURL, active.url) && !sameURL(currentURL, active.url)) {
          const replaced = await wv.executeJavaScript(`(() => { if (location.href !== ${JSON.stringify(currentURL)}) return false; history.replaceState(history.state, '', ${JSON.stringify(active.url)}); return true; })()`);
          if (!replaced || disposed || !tabs.includes(t) || t.docs !== docs || t.wv !== wv || t.recoverHistory !== recovery) return;
          t.url = active.url;
          t.committed = active.url;
          ifShown(t, showAddress);
        }
        const json = JSON.stringify(v);
        if (json !== t.historyJSON) {
          t.history = v;
          t.historyJSON = json;
          ifShown(t, updateNav);
          emitTabs();
        }
        rememberGood(t);
      }).catch((e) => {
        if (stillThere(t, docs)) console.warn('flow page: could not read the page history', e);
      });
    }
    /* Where a tab's page is scrolled right now, from its preload: Chromium records a scroll in the page's history only
       about a second after it ends. null when it does not answer within 300 ms. */
    function scrollNow(t) {
      if (!t.wv || t.guestId == null) return Promise.resolve(null);
      const id = ++scrollAskId;
      return new Promise((resolve) => {
        const end = (at) => {
          clearTimeout(timer);
          scrollAsks.delete(id);
          resolve(at);
        };
        const timer = setTimeout(() => end(null), 300);
        scrollAsks.set(id, end);
        t.wv.send('flow:scroll-now', id);
      });
    }
    // Where a tab's PDF is: Chromium's viewer keeps it in a frame only main can read; null for any other page.
    function pdfPlace(t) {
      if (typeof window.flow.pdfPlace !== 'function') return Promise.resolve(null);
      const docs = t.docs;
      return window.flow.pdfPlace(t.guestId).then((at) => at || null, (e) => {
        if (stillThere(t, docs)) console.warn('flow page: could not read where the PDF is', e);
        return null;
      });
    }
    // A PDF's page has loaded: main closes its viewer's thumbnails pane and puts one kept from before a restart back.
    function pdfShown(t) {
      if (t.guestId == null || typeof window.flow.pdfShown !== 'function') return;
      const at = t.pdfBack;
      t.pdfBack = null;
      const docs = t.docs;
      window.flow.pdfShown(t.guestId, at).catch((e) => {
        if (stillThere(t, docs)) console.warn('flow page: could not set up the PDF viewer', e);
      }).then(() => {
        if (t.docs === docs) t.putting = null;
      });
    }
    function refreshSoon(t, ms) {
      clearTimeout(t.histTimer);
      t.histTimer = setTimeout(() => refreshHistory(t), ms);
    }
    function clearRecoveryHistory(t) {
      const recovery = t.recoverHistory;
      clearTimeout(t.recoverTimer);
      if (recovery) clearTimeout(recovery.maxTimer);
      t.recoverTimer = 0;
      t.recoverHistory = null;
    }
    function stabilizeRecoveryHistory(t, recovery) {
      if (t.recoverHistory !== recovery) return;
      const left = recovery.deadline - Date.now();
      if (left <= 0) { clearRecoveryHistory(t); return; }
      clearTimeout(t.recoverTimer);
      t.recoverTimer = setTimeout(() => {
        if (t.recoverHistory === recovery) clearRecoveryHistory(t);
      }, Math.min(RECOVER_STABILIZE_MS, left));
    }
    function repairRecoveryHistory(t) {
      const recovery = t.recoverHistory;
      if (!recovery || !recovery.stopped) return;
      if (Date.now() >= recovery.deadline) { clearRecoveryHistory(t); return; }
      if (recovery.busy) { recovery.again = true; return; }
      recovery.busy = true;
      recovery.again = false;
      clearTimeout(t.recoverTimer);
      t.recoverTimer = 0;
      refreshHistory(t, recovery).finally(() => {
        if (t.recoverHistory !== recovery) return;
        recovery.busy = false;
        if (Date.now() >= recovery.deadline) { clearRecoveryHistory(t); return; }
        if (recovery.again) repairRecoveryHistory(t);
        else stabilizeRecoveryHistory(t, recovery);
      });
    }
    function recoverFailed(t) {
      const good = t && t.good;
      if (!good || !t.err || !t.err.recover || t.recovering || disposed || !tabs.includes(t)) return;
      t.recovering = true;
      dropTab(t);
      Object.assign(t, {
        url: good.url,
        title: good.title,
        icon: good.icon,
        history: validHistory(good.history),
        historyJSON: good.history ? JSON.stringify(good.history) : '',
        navAt: good.history ? { index: good.history.index, length: good.history.entries.length } : null,
        scroll: scrollOf(good.scroll),
        zoom: good.zoom,
        restored: false,
        restoredFrom: '',
        scrollBack: null,
        pdfBack: null,
        putting: null,
        committed: '',
        inflight: false,
        typed: null,
        recoverHistory: { history: validHistory(good.history), stopped: false, deadline: 0, maxTimer: 0, busy: false, again: false },
        recoverTimer: 0,
      });
      ifShown(t, () => {
        render();
        onTitle(t.title);
      });
      emitTabs();
      createWebview(t);
    }
    function online() {
      for (const t of tabs) {
        if (t.err && t.err.recover) recoverFailed(t);
        else if (t.wentOffline) reloadAfterOffline(t);
      }
    }
    on(window, 'online', online);
    /* A page that was loaded when the connection went can go white on its own (Notion does when its sync fails), with no
       failed load for Flow to see. Its place is kept now; when the connection is back a page that shows nothing reloads
       there. One that still shows something is left alone: it reconnects by itself, and a reload would lose its state. */
    function offline() {
      for (const t of tabs) if (t.wv && t.guestId != null && !t.err && LOADABLE_RE.test(t.url)) t.wentOffline = { place: scrollOf(t.place) || scrollOf(t.scroll) };
    }
    on(window, 'offline', offline);
    async function reloadAfterOffline(t) {
      const was = t.wentOffline;
      t.wentOffline = null;
      const wv = t.wv;
      if (!was || disposed || !wv || t.guestId == null || t.err) return;
      if (!(await wv.executeJavaScript(BLANK_JS).catch(() => false))) return;
      if (disposed || !tabs.includes(t) || t.wv !== wv || t.err) return;
      t.reloadRequest += 1;
      t.reloading = true;
      if (was.place) {
        t.restoredFrom = t.url;
        t.scrollBack = was.place;
        t.putting = was.place;
      }
      wv.reload();
    }
    /* A load that failed for want of the network tries again by itself, sooner first, as Chrome's error page does: a
       loose connection, or a site that comes back, sends Flow no online event. */
    function retryLater(t) {
      clearTimeout(t.retryTimer);
      t.retryWait = Math.min(RETRY_MAX_MS, t.retryWait ? t.retryWait * 2 : RETRY_FIRST_MS);
      t.retryTimer = setTimeout(() => {
        t.retryTimer = 0;
        if (!disposed && tabs.includes(t) && t.err && t.err.recover) recoverFailed(t);
      }, t.retryWait);
    }

    function createWebview(t) {
      if (t.wv || t.restoring || disposed || !shown || t !== st() || !t.url || !LOADABLE_RE.test(t.url)) return;
      // A tab kept from before a restart gets its back/forward history and scroll back: main restores them into the
      // new webview instead of loading its address (Chromium restores only into a page that has loaded nothing).
      if (t.history && !t.restored && typeof window.flow.restorePageNext === 'function') {
        t.restoring = true;
        t.restored = true;
        // Main starts the restored load as the guest attaches, before this webview hears of it: its start and any
        // redirect go unseen, so a first page that lands elsewhere than this address was redirected.
        t.restoredFrom = t.url;
        t.scrollBack = t.scroll;
        t.pdfBack = t.scroll && t.scroll.pdf;
        t.putting = t.scroll;
        window.flow.restorePageNext(t.url, t.history).catch((e) => console.warn('flow page: main could not take the history to restore', e)).then(() => {
          t.restoring = false;
          if (tabs.includes(t)) createWebview(t);
        });
        return;
      }
      // One kept without a history Chromium can restore (a file's page: history holds web pages only) still gets the
      // scroll read at the quit, once its page has loaded.
      if (t.scroll && !t.restored) {
        t.restored = true;
        t.restoredFrom = t.url;
        t.scrollBack = t.scroll;
        t.pdfBack = t.scroll.pdf;
        t.putting = t.scroll;
      }
      const wv = document.createElement('webview');
      t.wv = wv;
      wv.setAttribute('partition', 'persist:flow');
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('src', t.url);
      t.report = REPORT_RE.test(t.url);
      t.inflight = true;
      const tOn = (type, f) => {
        wv.addEventListener(type, f);
        t.mine.push([type, f]);
      };
      tOn('did-start-loading', () => setLoading(t, true));
      tOn('media-started-playing', () => { t.playing = true; });
      tOn('media-paused', () => { t.playing = false; });
      tOn('did-stop-loading', () => {
        void refreshMedia();
        setLoading(t, false);
        bind(t);
        reportPage(t);
        if (t.inflight && t.guestId != null && !wv.isLoading()) dropped(t);
        if (t.recoverHistory && !t.err) {
          if (!t.recoverHistory.stopped) {
            const recovery = t.recoverHistory;
            recovery.stopped = true;
            recovery.deadline = Date.now() + RECOVER_MAX_MS;
            recovery.maxTimer = setTimeout(() => {
              if (t.recoverHistory === recovery) clearRecoveryHistory(t);
            }, RECOVER_MAX_MS);
          }
          repairRecoveryHistory(t);
        }
        ifShown(t, updateNav);
      });
      tOn('dom-ready', () => {
        bind(t);
        sendMarks(t);
        ifShown(t, updateNav);
      });
      tOn('did-start-navigation', (e) => {
        if (!e.isMainFrame || e.isInPlace) return;
        const recovery = t.recoverHistory;
        const recovered = recovery && recovery.history;
        const saved = recovered && recovered.entries[recovered.index];
        if (saved && !samePath(e.url, saved.url)) clearRecoveryHistory(t);
        t.reloading = !!t.good && sameURL(e.url, t.good.url);
        // Main drops a sign-in the page leaves unanswered.
        if (t.login) {
          t.login = null;
          ifShown(t, renderLogin);
        }
        t.titleSince = false;
        t.nav = { url: e.url, redirected: false };
        if (t.selfMove && tidy(t.selfMove.to) !== tidy(e.url)) t.selfMove = null;
      });
      tOn('did-redirect-navigation', (e) => {
        if (e.isMainFrame && !e.isInPlace && t.nav) t.nav.redirected = true;
      });
      tOn('did-navigate', (e) => {
        bind(t);
        if (t.recovering && e.url === 'about:blank' && t.good && !sameURL(t.good.url, e.url)) return;
        if (ERROR_PAGE_RE.test(e.url)) {
          failed(t, -106, t.good ? t.good.url : t.url);
          return;
        }
        const recovering = t.recovering;
        const recovery = recovering ? t.recoverHistory : null;
        let recovered = recovery && recovery.history;
        const recoveredAt = recovered && recovered.entries[recovered.index];
        if (recoveredAt && !samePath(e.url, recoveredAt.url)) {
          clearRecoveryHistory(t);
          recovered = null;
        }
        const exactURL = recoveredAt && recovered && samePath(e.url, recoveredAt.url) ? recoveredAt.url : '';
        const moved = t.selfMove || (t.nav && t.nav.redirected ? { from: t.nav.url, how: 'server' } : null) ||
          (!t.nav && t.restoredFrom ? { from: t.restoredFrom, how: 'server' } : null);
        // The scroll kept at quit, for the page the tab came back to (not where a redirect took it). A recovered page
        // may strip a query while it loads; it is still the page whose exact address and place Flow is putting back.
        const restored = t.restoredFrom && (tidy(e.url) === tidy(t.restoredFrom) || (recovering && samePath(e.url, t.restoredFrom)));
        if (t.scrollBack && restored) t.wv.send('flow:restore-scroll', t.scrollBack);
        else t.putting = null;
        if (t.pdfBack && !restored) t.pdfBack = null;
        t.scrollBack = null;
        t.scroll = null;
        t.place = null;
        t.selfMove = null;
        t.nav = null;
        t.restoredFrom = '';
        if (moved) redirected(moved.from, e.url, moved.how);
        const reload = recovering || e.url === t.committed;
        // A reload keeps its history entry, and Chromium only reports a title that differs from the entry's, so an
        // unchanged title never arrives again: keep it.
        if (!t.titleSince && !reload) t.title = '';
        t.committed = exactURL || e.url;
        t.docs += 1;
        const docs = t.docs;
        t.selection = false;
        t.url = exactURL || e.url;
        t.inflight = false;
        t.typed = null;
        t.recovering = false;
        t.reloading = false;
        if (t.marks && pageOf(e.url) !== t.marksPage) t.marks = null;
        ifShown(t, hideMark);
        clearError(t);
        // As in Chrome, another page closes the find bar; a reload keeps it, with a fresh count. Results of the old
        // page's search can still arrive after this: the request id no longer matches.
        if (findTab === t || (t === st() && find.classList.contains('on'))) {
          if (reload) {
            findText = '';
            findReq = -1;
            fn.textContent = '';
          } else closeFind(false);
        }
        ifShown(t, () => {
          showAddress();
          updateNav();
          renderStar();
          renderView();
          onNavigate({ url: tidy(t.url), title: t.title });
        });
        emitTabs();
        if (!recovered) {
          refreshHistory(t);
          refreshSoon(t, 500);
        }
        nextStep(t);
      });
      tOn('did-navigate-in-page', (e) => {
        if (!e.isMainFrame) return;
        const recovery = t.recoverHistory;
        const recovered = recovery && recovery.history;
        const saved = recovered && recovered.entries[recovered.index];
        const stabilizing = saved && samePath(e.url, saved.url);
        if (!stabilizing) {
          t.scroll = null;
          t.place = null;
          if (recovery) clearRecoveryHistory(t);
        }
        t.url = stabilizing ? saved.url : e.url;
        t.inflight = false;
        if (t.marks && pageOf(e.url) !== t.marksPage) {
          t.marks = null;
          t.wv.send('flow:marks', []);
        } else sendMarks(t);
        ifShown(t, hideMark);
        ifShown(t, () => {
          showAddress();
          updateNav();
          renderStar();
          onNavigate({ url: tidy(t.url), title: t.title });
        });
        emitTabs();
        if (stabilizing) {
          if (recovery.stopped) repairRecoveryHistory(t);
        } else {
          refreshHistory(t);
          refreshSoon(t, 500);
        }
      });
      tOn('page-title-updated', (e) => {
        if (t.err || t.recovering) return;
        t.titleSince = true;
        t.title = e.title || '';
        rememberGood(t);
        if (t.title) ifShown(t, () => onTitle(t.title));
        renderStrip();
        emitTabs();
      });
      tOn('did-fail-load', (e) => {
        if (!e.isMainFrame || e.errorCode === ERR_ABORTED) return;
        bind(t);
        t.inflight = false;
        failed(t, e.errorCode, e.validatedURL);
      });
      tOn('render-process-gone', (e) => {
        const reason = (e.details && e.details.reason) || '';
        t.inflight = false;
        t.selection = false;
        ifShown(t, updateNav);
        setLoading(t, false);
        showError(t, GONE[reason] || 'this page stopped working', display(t.url), () => wv.reload());
      });
      tOn('found-in-page', (e) => {
        const r = e.result;
        if (findTab !== t || !r || r.requestId !== findReq || r.matches == null) return;
        fn.textContent = r.matches ? `${r.activeMatchOrdinal} of ${r.matches}` : 'no matches';
      });
      // a focus the owner already left (handBack gives the keys back): the window is not brought forward for it
      tOn('focus', () => { if (t === st() && !(t.handing && (t.handing.to || t.handing.away))) onFocus(); });
      tOn('page-favicon-updated', (e) => {
        if (t.err || t.recovering) return;
        const list = (e.favicons || []).filter((x) => typeof x === 'string');
        const inline = list.find((x) => ICON_RE.test(x));
        const at = list.find((x) => /^https?:/i.test(x));
        if (inline || !at || t.guestId == null || typeof window.flow.pageIcon !== 'function') {
          setIcon(t, inline || '');
          return;
        }
        // an icon by address comes through the page's own session, inline: Flow's document never fetches from a site
        const page = t.url;
        window.flow.pageIcon(t.guestId, at).then((data) => {
          if (!disposed && t.url === page) setIcon(t, typeof data === 'string' && ICON_RE.test(data) ? data : '');
        }, (err) => console.warn('flow page: main could not get a page\'s icon', err));
      });
      // Flow's document only gets a click on the page when Chromium sent it to Flow instead (a webview just attached in
      // a new window misses its first clicks), and the keys then stay out of the page. It goes on to the page.
      let passing = false;
      const passClick = (e) => {
        if (!e.isTrusted || e.pointerType !== 'mouse' || t.guestId == null || (e.type === 'pointerup' && !passing)) return;
        passing = e.type === 'pointerdown';
        // Flow's own focus for the press would take the keys back out of the page.
        e.preventDefault();
        if (passing) wv.focus();
        const r = wv.getBoundingClientRect();
        const s = wv.offsetWidth ? r.width / wv.offsetWidth : 1;
        wv.sendInputEvent({
          type: passing ? 'mouseDown' : 'mouseUp', x: Math.round((e.clientX - r.left) / s), y: Math.round((e.clientY - r.top) / s),
          button: ['left', 'middle', 'right'][e.button] || 'left', clickCount: 1,
          modifiers: [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean),
        }).catch((err) => console.error('flow page: a click could not be passed on to its page', err));
      };
      tOn('pointerdown', passClick);
      tOn('pointerup', passClick);
      // window.close() from the page (OAuth and "you can close this tab" pages): Electron destroys the guest.
      tOn('close', () => closeSelf(t));
      // The page's own preload reports pinches and wheels (it never sees a pinch). The pinch point is mapped into
      // Flow's pixels; wheel deltas already match Flow's, since Chromium does not scale them for the transform.
      tOn('ipc-message', (e) => {
        const a = e.args && e.args[0];
        if (e.channel === 'flow:mark-hover') {
          showMark(t, a);
          return;
        }
        if (e.channel === 'flow:probe-world') { media.dataset.probe = JSON.stringify(a); return; }
        if (e.channel === 'flow:boot') { media.dataset.boot = String(a); window.__booted = (window.__booted || 0) + 1; return; }
        if (e.channel === 'flow:using') {
          t.using = { camera: !!(a && a.camera), microphone: !!(a && a.microphone) };
          // Not refreshMedia() here: the guest reports twice a second and every report asked it again, so the page looped.
          paintMedia(mediaStateNow || { camera: 'ask', microphone: 'ask', mac: {} });
          return;
        }
        if (e.channel === 'flow:moved-self') {
          if (!a || typeof a.from !== 'string' || typeof a.to !== 'string') return;
          if (a.same) redirected(a.from, a.to, 'page');
          // Under load this message can come after the tab committed the new address: it is reported now, and the page
          // again if it was already reported there before notes knew it had moved.
          else if (tidy(t.committed) === tidy(a.to)) {
            redirected(a.from, a.to, 'page');
            if (t.reported === tidy(t.url)) {
              t.reported = '';
              reportPage(t);
            }
          } else t.selfMove = { from: a.from, to: a.to, how: 'page' };
          return;
        }
        if (e.channel === 'flow:selection') {
          t.selection = a === true;
          ifShown(t, updateNav);
          return;
        }
        if (e.channel === 'flow:mark-click') {
          if (a && typeof a.text === 'string') onMark(a.text);
          return;
        }
        if (e.channel === 'flow:pdf') {
          pdfShown(t);
          return;
        }
        if (e.channel === 'flow:drag-done') {
          onDragDone();
          return;
        }
        if (e.channel === 'flow:scroll-now') {
          const done = a && scrollAsks.get(a.id);
          if (done) done(scrollOf(a));
          return;
        }
        if (e.channel === 'flow:scrolled') {
          const at = scrollOf(a);
          if (at) {
            t.place = at;
            t.putting = null;
            if (t.good) t.good.scroll = at;
          }
          return;
        }
        if (e.channel === 'flow:marks-found') {
          if (t === st() && t.onFound && Array.isArray(a) && pageOf(t.url) === t.marksPage) t.onFound(a.filter((x) => typeof x === 'string'));
          return;
        }
        if (e.channel === 'flow:find-quote') {
          const done = a && quoteWaits.get(a.id);
          if (done) done(!!a.found);
          return;
        }
        if (e.channel === 'flow:pinch') {
          // nav decides by the fingers down (pinchKind): a pinch of the space's it has already zoomed, and this window
          // does nothing; the window's own the page zooms itself, as Chrome does
          if (!a || onPinch({ ...a, used: false, t: performance.timeOrigin + e.timeStamp })) return;
          window.flow.pinchPage(t.guestId, a).catch((err) => console.warn('flow page: a pinch could not zoom the page', err));
          return;
        }
        if (!a || e.channel !== 'flow:wheel') return;
        onWheel({ dx: a.dx, dy: a.dy, t: a.t, used: !!a.used });
        // Chromium updates the page state about a second after a scroll stops (smooth scrolling runs on a bit).
        refreshSoon(t, 2500);
      });
