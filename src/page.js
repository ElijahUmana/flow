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
