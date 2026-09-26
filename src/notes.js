/* FlowNote: one plain-text note, used for every note in Flow (a note window's body, the ✎ pane of an agent, a team or
   a page). The text stays plain; two kinds of line get a mark drawn over their first characters:
   - "[ ] " and "[x] " are todos: a box to tick, done lines dimmed and struck through;
   - "> " in a page's note quotes a sentence of that page (an annotation): an arrow scrolls the page to it.
   Web addresses in the text are links. A click unfolds the page under its line: first in brief (what it is, what was
   written about it), a click on that shows the page itself; a click on the link folds it. ⌘-click opens the page
   beside the note. What is unfolded is drawn between the lines and is never part of the text. */
(() => {
  'use strict';

  const TODO_RE = /^\[( |x)\] /;
  const TODO_LEN = 4;
  const QUOTE = '> ';
  const MARK = '\uE000';
  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  const noop = () => {};
  let marks = null;
  let LIVE = null;
  /* Where the caret last was in each note (by key), so going back to a note puts it there again. */
  const CARETS = new Map();

  /* One Highlight per name for the whole document; each note adds and removes its own ranges. */
  function highlights() {
    if (!marks) {
      marks = { hide: new Highlight(), done: new Highlight(), quote: new Highlight(), link: new Highlight() };
      CSS.highlights.set('fnote-hide', marks.hide);
      CSS.highlights.set('fnote-done', marks.done);
      CSS.highlights.set('fnote-quote', marks.quote);
      CSS.highlights.set('fnote-link', marks.link);
    }
    return marks;
  }

  /* The editor holds text nodes and the odd <br> (a "\n"). In pre-wrap a last "\n" draws no line, so a note whose text
     ends in "\n" is kept with one more "\n" after it, and that one is not part of the note. */
  const isX = (n) => n.nodeType === Node.ELEMENT_NODE && n.classList.contains('fnote-x');
  const flat = (ed) => [...ed.childNodes].every((n) => n.nodeType === Node.TEXT_NODE || n.nodeName === 'BR' || isX(n));
  const lenOf = (n) => (n.nodeType === Node.TEXT_NODE ? n.data.length : isX(n) ? 0 : 1);
  function raw(ed) {
    let s = '';
    for (const n of ed.childNodes) s += n.nodeType === Node.TEXT_NODE ? n.data : isX(n) ? '' : '\n';
    return s;
  }
  const valueOf = (ed) => raw(ed).replace(/\n$/, '');
  const shown = (v) => (v.endsWith('\n') ? `${v}\n` : v);
  function point(ed, off) {
    let left = off;
    const kids = ed.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i], len = lenOf(n);
      if (n.nodeType === Node.TEXT_NODE && left <= len) return { node: n, offset: left };
      if (!isX(n) && left < len) return { node: ed, offset: i };
      left -= len;
    }
    return { node: ed, offset: kids.length };
  }
  function offsetOf(ed, node, offset) {
    let s = 0;
    if (node === ed) {
      for (let i = 0; i < offset; i++) s += lenOf(ed.childNodes[i]);
      return s;
    }
    for (const n of ed.childNodes) {
      if (n === node) return s + offset;
      s += lenOf(n);
    }
    return s;
  }
  function rangeOf(ed, a, b) {
    const s = point(ed, a), e = point(ed, b);
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    return r;
  }
  /* Web addresses in a line, without the punctuation that ends a sentence (a ")" stays when the address opened one). */
  function urls(line) {
    const out = [];
    for (const m of line.matchAll(URL_RE)) {
      let u = m[0];
      for (;;) {
        const t = u.replace(/[.,;:!?'"\]}>]+$/, '');
        if (t !== u) { u = t; continue; }
        if (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) { u = u.slice(0, -1); continue; }
        break;
      }
      if (u.length > 4) out.push({ at: m.index, len: u.length, url: /^www\./i.test(u) ? `https://${u}` : u });
    }
    return out;
  }
  function lines(text) {
    const out = [];
    let start = 0;
    for (const line of text.split('\n')) {
      out.push({ start, end: start + line.length, text: line });
      start += line.length + 1;
    }
    return out;
  }

  function mount(container, o) {
    const onChange = o.onChange || noop;
    const quotes = !!o.quotes;
    // found: whether the page has a quoted sentence; ↗ shows only on those
    const found = o.found || (() => true);
    const onQuote = o.onQuote || noop;
    const onOpenLink = o.onOpenLink || noop;
    const wrap = document.createElement('div');
    wrap.className = 'fnote';
    const ed = document.createElement('div');
    ed.className = `fnote-ed${o.className ? ` ${o.className}` : ''}`;
    ed.spellcheck = false;
    const setWritable = (on) => { ed.contentEditable = on ? 'plaintext-only' : 'false'; ed.dataset.ph = on ? o.placeholder || '' : ''; };
    setWritable(o.writable !== false);
    if (o.key) ed.dataset.key = o.key;
    const layer = document.createElement('div');
    layer.className = 'fnote-marks';
    wrap.append(ed, layer);
    container.appendChild(wrap);
    ed.textContent = shown(String(o.value || ''));

    let mine = { hide: [], done: [], quote: [], link: [] };
    let links = [];
    let disposed = false;
    const listeners = [];
    const on = (target, type, f) => { target.addEventListener(type, f); listeners.push([target, type, f]); };

    function caret() {
      const s = getSelection();
      if (!s.rangeCount || !ed.contains(s.anchorNode)) return null;
      const r = s.getRangeAt(0);
      return { a: offsetOf(ed, r.startContainer, r.startOffset), b: offsetOf(ed, r.endContainer, r.endOffset) };
    }
    if (o.key) {
      const keep = () => { const c = caret(); if (c) CARETS.set(o.key, c); };
      on(document, 'selectionchange', () => { if (document.activeElement === ed) keep(); });
      // the last move before leaving: selectionchange comes later, when this note no longer has the focus
      on(ed, 'blur', keep);
    }
    function select(a, b) {
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(rangeOf(ed, a, b));
    }
    /* An edit that left elements other than <br> behind (a drop, an input method) is put back to plain text, caret kept. */
    function flatten() {
      for (const url of [...X.keys()]) unplace(url);
      const s = getSelection();
      if (s.rangeCount && ed.contains(s.anchorNode)) {
        const r = s.getRangeAt(0);
        r.collapse(false);
        r.insertNode(document.createTextNode(MARK));
      }
      const t = ed.innerText.replace(/\n$/, '');
      const at = t.indexOf(MARK);
      ed.textContent = shown(t.replace(MARK, ''));
      if (at >= 0) select(at, at);
    }

    function unpaint() {
      const hl = highlights();
      for (const k of Object.keys(mine)) mine[k].forEach((r) => hl[k].delete(r));
      mine = { hide: [], done: [], quote: [], link: [] };
      links = [];
    }
    /* A mark covers the line's first characters (hidden by the fnote-hide highlight). */
    function paint() {
      if (disposed) return;
      unpaint();
      const hl = highlights();
      const base = layer.getBoundingClientRect();
      const out = [];
      const mark = (ln, len, cls, data, title) => {
        const r = rangeOf(ed, ln.start, ln.start + len);
        const rect = r.getClientRects()[0];
        if (!rect) return false;
        mine.hide.push(r);
        const b = document.createElement('span');
        b.className = cls;
        Object.assign(b.dataset, data);
        if (title) b.title = title;
        b.style.left = `${rect.left - base.left}px`;
        b.style.top = `${rect.top - base.top}px`;
        b.style.width = `${rect.width}px`;
        b.style.height = `${rect.height}px`;
        out.push(b);
        return true;
      };
      for (const ln of lines(valueOf(ed))) {
        for (const u of urls(ln.text)) {
          const r = rangeOf(ed, ln.start + u.at, ln.start + u.at + u.len);
          mine.link.push(r);
          links.push({ a: ln.start + u.at, b: ln.start + u.at + u.len, url: u.url, r });
        }
        const t = TODO_RE.exec(ln.text);
        if (t) {
          const done = t[1] === 'x';
          if (mark(ln, 3, `fnote-box${done ? ' done' : ''}`, { at: String(ln.start) }) && done && ln.text.length > TODO_LEN) {
            mine.done.push(rangeOf(ed, ln.start + TODO_LEN, ln.end));
          }
          continue;
        }
        const all = quotes && ln.text.startsWith(QUOTE) && ln.text.length > QUOTE.length ? rangeOf(ed, ln.start, ln.end).getBoundingClientRect() : null;
        const has = all && found(ln.text.slice(QUOTE.length).trim());
        if (all && mark(ln, QUOTE.length, `fnote-clip${has ? '' : ' gone'}`, { quote: ln.text.slice(QUOTE.length), y0: String(all.top - base.top), y1: String(all.bottom - base.top) }, has ? 'show it on the page' : '')) {
          mine.quote.push(rangeOf(ed, ln.start + QUOTE.length, ln.end));
          // the quote's bar, in the gutter left of all its lines
          const b = document.createElement('span');
          b.className = 'fnote-qbar';
          b.style.left = `${all.left - base.left - 6}px`;
          b.style.top = `${all.top - base.top}px`;
          b.style.height = `${all.height}px`;
          out.push(b);
        }
      }
      for (const k of Object.keys(mine)) mine[k].forEach((r) => hl[k].add(r));
      // the marks already there are reused: a mark taken out and put back at every key is churn for nothing
      const kids = layer.children;
      out.forEach((b, i) => {
        const k = kids[i];
        if (!k) { layer.appendChild(b); return; }
        k.className = b.className;
        k.title = b.title;
        for (const a of Object.keys(k.dataset)) if (!(a in b.dataset)) delete k.dataset[a];
        Object.assign(k.dataset, b.dataset);
        k.style.cssText = b.style.cssText;
      });
      while (kids.length > out.length) layer.lastChild.remove();
    }

    function caretAt(n) {
      ed.focus({ preventScroll: true });
      select(n, n);
      const s = getSelection();
      const r = s.rangeCount ? s.getRangeAt(0).getClientRects()[0] : null;
      if (r) {
        const box = wrap.getBoundingClientRect();
        if (r.bottom > box.bottom || r.top < box.top) wrap.scrollTop += r.top - box.top - box.height / 2;
      }
    }
    /* Edits go through editing commands, so ⌘Z undoes a tick like any typing. */
    function edit(a, b, text) {
      run = '';
      ed.focus({ preventScroll: true });
      select(a, b);
      if (text) document.execCommand('insertText', false, text);
      else document.execCommand('delete');
      run = '';
    }
    function toggle(at) {
      const ln = lines(valueOf(ed)).find((x) => x.start === at);
      const t = ln && TODO_RE.exec(ln.text);
      if (!t) return;
      const was = document.activeElement === ed ? caret() : null;
      edit(at + 1, at + 2, t[1] === 'x' ? ' ' : 'x');
      if (was) select(was.a, was.b);
      else select(ln.end, ln.end);
    }

    /* Undo is the note's own. Chromium ends a run of typing whenever a node anywhere in the window is removed (a
       terminal redrawing, the sidebar), so its undo took typing back a few letters at a time. Here a run of typing, or
       of deleting, with the caret not moved in between is one step, as on the Mac; a paste, a cut or a tick is one of
       its own. Text put in from outside (another window, another page shown) starts the history again. */
    const past = [], future = [];
    let now = { text: valueOf(ed), at: null }, run = '';
    const runOf = (type) => (/^insert(?:Text|CompositionText|LineBreak|Paragraph)$/.test(type) ? 'type' : /^delete(?:Content|Word)/.test(type) ? 'delete' : '');
    function record(type) {
      const text = valueOf(ed), at = caret();
      if (text !== now.text) {
        const kind = runOf(type), last = past[past.length - 1];
        if (kind && kind === run && last) last.after = { text, at };
        else if (past.push({ before: now, after: { text, at } }) > 500) past.shift();
        run = kind;
        future.length = 0;
      }
      now = { text, at };
    }
    function travel(from, to, back) {
      const step = from.pop();
      if (!step) return false;
      to.push(step);
      run = '';
      const s = back ? step.before : step.after, at = s.at || { a: s.text.length, b: s.text.length };
      for (const url of [...X.keys()]) unplace(url);
      ed.textContent = shown(s.text);
      select(Math.min(at.a, s.text.length), Math.min(at.b, s.text.length));
      now = { text: s.text, at: caret() };
      paint();
      placeAll();
      onChange(s.text);
      return true;
    }
    const back = () => travel(past, future, true);
    function step(type) {
      if (type === 'historyUndo') back();
      else travel(future, past, false);
    }
    // Chromium's own undo and redo commands, from anywhere else that sends them, take the same steps
    on(ed, 'beforeinput', (e) => {
      if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
      e.preventDefault();
      step(e.inputType);
    });
    // ⌘Z and ⇧⌘Z where the keys reach the note before the menu: the same steps. A key or a press that moves the caret
    // ends the run at once (its selectionchange can come after a second move that brings the caret back).
    on(ed, 'mousedown', () => { run = ''; });
    on(ed, 'keydown', (e) => {
      if (/^(?:Arrow|Page|Home$|End$)/.test(e.key)) run = '';
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); back(); }
      else if ((k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.metaKey)) { e.preventDefault(); travel(future, past, false); }
    });
    on(document, 'selectionchange', () => {
      if (document.activeElement !== ed) return;
      const c = caret();
      if (!c || (now.at && c.a === now.at.a && c.b === now.at.b)) return;
      run = '';
      now = { text: now.text, at: c };
    });
    on(ed, 'blur', () => { run = ''; });
    on(ed, 'input', (e) => {
      if (!flat(ed)) { flatten(); placeAll(); }
      if (ed.firstChild && !raw(ed).replace(/\n$/, '')) { for (const url of [...X.keys()]) unplace(url); ed.textContent = ''; }
      paint();
      if (X.size) checkFolds();
      record(e.inputType || '');
      onChange(valueOf(ed));
    });
    on(ed, 'keydown', (e) => {
      if (e.key === 'Escape' && X.size) { for (const url of [...X.keys()]) fold(url, 0); return; }
      if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const c = caret();
      if (!c || c.a !== c.b) return;
      const ln = lines(valueOf(ed)).find((x) => c.a >= x.start + TODO_LEN && c.a <= x.end && TODO_RE.test(x.text));
      if (!ln) return;
      e.preventDefault();
      if (ln.text.length === TODO_LEN) { edit(ln.start, ln.end, ''); return; }
      document.execCommand('insertLineBreak');
      document.execCommand('insertText', false, '[ ] ');
    });
    /* A link under the pointer: the text under the point must be inside the address, not just near its end. */
    function linkAt(x, y) {
      if (!links.length) return null;
      const p = document.caretPositionFromPoint(x, y);
      if (!p || !ed.contains(p.offsetNode)) return null;
      const off = offsetOf(ed, p.offsetNode, p.offset);
      const l = links.find((k) => off >= k.a && off <= k.b);
      if (!l) return null;
      return [...l.r.getClientRects()].some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) ? l : null;
    }
    /* ---------- unfolding a link: under its line, the page in brief (1), then the page itself (2) ---------- */
    const briefOf = o.brief || null;
    const peekOf = o.peek || null;
    const onFolds = o.onFolds || noop;
    const folds = { ...(o.folds || {}) };
    const X = new Map();
    function insertAt(pos, el) {
      const p = point(ed, pos);
      if (p.node.nodeType === Node.TEXT_NODE) ed.insertBefore(el, p.offset < p.node.data.length ? p.node.splitText(p.offset) : p.node.nextSibling);
      else ed.insertBefore(el, ed.childNodes[p.offset] || null);
    }
    function unplace(url) {
      const x = X.get(url);
      if (!x) return;
      if (x.live) x.live.dispose();
      if (LIVE && LIVE.x === x) LIVE = null;
      x.el.remove();
      X.delete(url);
    }
    function place(url, level) {
      const k = links.find((l) => l.url === url);
      if (!k || !briefOf) return false;
      if (level === 2 && LIVE) LIVE.down();
      const el = document.createElement('div');
      el.className = `fnote-x l${level}`;
      el.contentEditable = 'false';
      el.dataset.url = url;
      const b = briefOf(url);
      b.classList.add('fx-brief');
      b.title = level === 1 ? 'show the page' : 'fold the page back';
      const open = document.createElement('span');
      open.className = 'fx-open';
      open.title = 'open it beside';
      el.append(open, b);
      const x = { el, level, live: null };
      if (level === 2 && peekOf) {
        const box = document.createElement('div');
        box.className = 'fx-live';
        el.appendChild(box);
        x.live = peekOf(url, box);
        LIVE = { x, down: () => fold(url, 1) };
      }
      const text = valueOf(ed);
      const nl = text.indexOf('\n', k.b);
      insertAt(nl < 0 ? text.length : nl + 1, el);
      X.set(url, x);
      return true;
    }
    function fold(url, level) {
      unplace(url);
      if (level && place(url, level)) folds[url] = level;
      else delete folds[url];
      onFolds({ ...folds });
    }
    function placeAll() {
      for (const url of [...X.keys()]) unplace(url);
      for (const url of Object.keys(folds)) if (!place(url, folds[url])) delete folds[url];
    }
    /* After an edit: an unfolded page whose link left the line above it folds. */
    function checkFolds() {
      let changedFolds = false;
      const text = valueOf(ed);
      for (const [url, x] of [...X]) {
        const i = [...ed.childNodes].indexOf(x.el);
        const at = i < 0 ? -1 : offsetOf(ed, ed, i);
        const line = at < 0 ? '' : text.slice(text.lastIndexOf('\n', at - 2) + 1, at > 0 && text[at - 1] === '\n' ? at - 1 : at);
        if (at < 0 || !urls(line).some((u) => u.url === url)) { unplace(url); delete folds[url]; changedFolds = true; }
      }
      if (changedFolds) onFolds({ ...folds });
    }
    on(ed, 'mousedown', (e) => { if (e.target.closest && e.target.closest('.fnote-x')) e.preventDefault(); });
    on(ed, 'click', (e) => {
      const x = e.target.closest && e.target.closest('.fnote-x');
      if (x) {
        const url = x.dataset.url;
        if (e.target.closest('.fx-open')) onOpenLink(url);
        else if (e.target.closest('.fx-brief')) fold(url, folds[url] === 2 ? 1 : 2);
        return;
      }
      if (e.button !== 0 || e.detail > 1 || !getSelection().isCollapsed) return;
      const l = linkAt(e.clientX, e.clientY);
      if (!l) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey || !briefOf) onOpenLink(l.url);
      else fold(l.url, folds[l.url] ? 0 : 1);
    });
    /* A quote shows its ↗ only while the pointer is on one of its lines. */
    function lineUnder(y) {
      const top = layer.getBoundingClientRect().top;
      for (const c of layer.querySelectorAll('.fnote-clip')) c.classList.toggle('on', y != null && y - top >= +c.dataset.y0 && y - top < +c.dataset.y1);
    }
    let hoverQueued = false, hx = 0, hy = 0;
    on(ed, 'mousemove', (e) => {
      hx = e.clientX;
      hy = e.clientY;
      if (!links.length && !quotes) { ed.classList.remove('onlink'); return; }
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        if (disposed) return;
        ed.classList.toggle('onlink', links.length > 0 && !!linkAt(hx, hy));
        lineUnder(hy);
      });
    });
    on(ed, 'mouseleave', () => { ed.classList.remove('onlink'); lineUnder(null); });
    on(layer, 'mousedown', (e) => { if (e.target.closest('.fnote-box, .fnote-clip')) e.preventDefault(); });
    on(layer, 'click', (e) => {
      const b = e.target.closest('.fnote-box');
      if (b) { toggle(+b.dataset.at); return; }
      const c = e.target.closest('.fnote-clip');
      if (c) onQuote(c.dataset.quote);
    });
    const ro = new ResizeObserver(() => paint());
    ro.observe(wrap);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => paint());
    paint();
    placeAll();

    return {
      el: ed,
      value: () => valueOf(ed),
      /* Text from outside (another window, a clip). A focused note keeps its caret. */
      set(text) {
        const v = String(text == null ? '' : text);
        if (disposed) return;
        if (v === valueOf(ed)) { paint(); return; }
        const was = document.activeElement === ed ? caret() : null;
        for (const url of [...X.keys()]) unplace(url);
        ed.textContent = shown(v);
        if (was) select(Math.min(was.a, v.length), Math.min(was.b, v.length));
        past.length = 0;
        future.length = 0;
        run = '';
        now = { text: v, at: was ? caret() : null };
        paint();
        placeAll();
      },
      /* Another note's folds (a page window showing another page). */
      setFolds(f) {
        if (disposed) return;
        for (const k of Object.keys(folds)) delete folds[k];
        Object.assign(folds, f || {});
        placeAll();
      },
      /* at: 'start', 'end', or 'last' (where the caret last was in this note, else the end). */
      focus(at) {
        if (disposed || ed.contentEditable === 'false') return;
        const len = valueOf(ed).length, c = at === 'last' && o.key ? CARETS.get(o.key) : null;
        if (!c) { caretAt(at === 'start' ? 0 : len); return; }
        caretAt(Math.min(c.b, len));
        select(Math.min(c.a, len), Math.min(c.b, len));
      },
      focusAt(n) {
        if (!disposed && ed.contentEditable !== 'false') caretAt(Math.max(0, Math.min(n, valueOf(ed).length)));
      },
      /* false: nothing can be written in it now, so it takes no caret and shows no placeholder. */
      writable(on) {
        if (!disposed) setWritable(!!on);
      },
      /* Edit > Undo and Redo, as Flow's own menu actions: a step of this note's history. */
      undo() {
        if (!disposed) step('historyUndo');
      },
      redo() {
        if (!disposed) step('historyRedo');
      },
      repaint: paint,
      dispose() {
        if (disposed) return;
        disposed = true;
        ro.disconnect();
        listeners.forEach(([t, type, f]) => t.removeEventListener(type, f));
        for (const url of [...X.keys()]) unplace(url);
        unpaint();
        wrap.remove();
      },
    };
  }

  window.FlowNote = { mount };
})();

/* FlowNotes: the notes in the app. app.js mounts it once with hooks into its model and calls it for the parts of a
   window that are notes: the ✎ side panel of an agent, a team or a page, and a note window's title and body.
   A web page is a thing of its own: one record per page for the whole app, keyed by its address (key below), holds
   what was written about it. Open the page again, anywhere, and its note is there. A "> sentence" line in it is an
   annotation: the page highlights that sentence and shows the lines under it. */
(() => {
  'use strict';

  let H = null;
  let PAGES = {};
  const ED = new Map();
  const PANE = new Map();
  const LIT = new Map();
  const FOUND = new Map();   // page window id -> the quoted sentences its page has (page.js setMarks reports them)
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = (key, ph, cls) => `<div class="nhost" data-key="${esc(key)}" data-ph="${esc(ph)}"${cls ? ` data-cls="${esc(cls)}"` : ''}></div>`;
  const titleField = (cls, key, ph) => `<div class="${cls} ned" contenteditable="plaintext-only" spellcheck="false" data-key="${esc(key)}" data-ph="${esc(ph)}"></div>`;
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ');
  const QUOTE = '> ';
  /* A note's name, one for its row, ⌘K and its window's title: the title the owner gave it, else its first line (without
     a todo box or quote mark), else "new note". A blank title is no title. A title from before the owner could leave it
     unset counts as given unless it is the default. */
  const NEW_NOTE = 'new note';
  const titled = (n) => !!n && !!String(n.title || '').trim() && (n.titleSet != null ? !!n.titleSet : n.title !== NEW_NOTE);
  function noteName(n) {
    if (titled(n)) return oneLine(n.title).trim();
    const line = String((n && n.body) || '').split('\n').map((l) => oneLine(l.replace(/^(?:\[[ x]\] |> )/, '')).trim()).find(Boolean);
    return line || NEW_NOTE;
  }
  /* A note window's heading holds only the owner's title, and says "new note" (faintly) only while the whole note is
     empty. The window may not be in the page yet (it is filled before it is placed). */
  function heading(ws, w) {
    const r = H.win(w.id), n = H.noteById(ws, w.noteId);
    if (!r || !n) return;
    const ph = !titled(n) && !String(n.body || '').trim() ? NEW_NOTE : '';
    r.el.querySelectorAll('.ntitle').forEach((ed) => { ed.dataset.ph = ph; });
  }

  /* ---------- the page: its address, the same for every way of writing it (checked on real sites by browse) ----------
     https; no "www." or mobile host; no trailing "/"; path escapes written one way; no fragment or :~:text=; no tracking
     keys; the rest of the query sorted. Sites that name a page by an id key by that id: Notion and Medium by the id at
     the end, YouTube by v, Google Docs by d, Wikipedia's index.php by its title, GitHub's owner and repo in any case.
     A fragment is dropped (an anchor in the page) unless it is a route ("#/…", "#!…") or the page itself lives in it
     (Gmail's thread, an Excalidraw drawing). Always key the address a page landed on. A file shown as a page
     (flow-file://mac/<signature>/<path>, flow-file://vm/<signature>/<host>/<path>) is keyed by where it is and its path,
     never by the signature in its address. */
  const TRACK = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|si|ref|ref_src|source|cmp)$/i;
  const SITE_DROP = { 'x.com': /^(?:s|t)$/, 'notion.so': /^(?:pvs|__dm_a)$/ };
  const IN_HASH = /^(?:mail\.google\.com|excalidraw\.com)$/;
  /* One way of writing a path segment; a segment whose escapes do not decode stays as it was written. */
  function segment(x) {
    if (!/%[0-9a-f]{2}/i.test(x)) return encodeURIComponent(x);
    let d = x;
    try { d = decodeURIComponent(x); } catch (err) { return x; }
    return encodeURIComponent(d);
  }
  function key(url) {
    const s = String(url || '').trim();
    if (!URL.canParse(s)) return '';
    const u = new URL(s);
    if (u.protocol === 'flow-file:') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (/^[A-Za-z0-9_-]{22}$/.test(parts[0] || '')) parts.shift();
      const where = u.hostname === 'vm' && parts.length ? `vm/${segment(parts.shift())}` : 'mac';
      return parts.length ? `flow-file://${where}/${parts.map(segment).join('/')}` : '';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    let host = u.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '').replace(/\.m\.wikipedia\.org$/, '.wikipedia.org');
    if (host === 'twitter.com') host = 'x.com';
    let parts = u.pathname.split('/').filter(Boolean);
    const q = u.searchParams;
    if (host === 'youtu.be' && parts[0]) return `https://youtube.com/watch?v=${encodeURIComponent(parts[0])}`;
    if (host === 'youtube.com') {
      const v = q.get('v') || (/^(?:shorts|embed|live)$/.test(parts[0] || '') ? parts[1] : '');
      if (v) return `https://youtube.com/watch?v=${encodeURIComponent(v)}`;
    }
    if (/(?:^|\.)notion\.(?:so|site)$/.test(host) || host === 'app.notion.com') {
      const m = /([0-9a-f]{32})$/i.exec(parts[parts.length - 1] || '');
      if (m) return `https://notion.so/${m[1].toLowerCase()}`;
      host = 'notion.so';
    }
    if (host === 'medium.com' || host.endsWith('.medium.com')) {
      const last = parts[parts.length - 1] || '';
      const m = parts[0] === 'p' ? /^([0-9a-f]{8,16})$/i.exec(last) : /-([0-9a-f]{8,16})$/i.exec(last);
      if (m) return `https://medium.com/p/${m[1].toLowerCase()}`;
    }
    if (host === 'docs.google.com') {
      const i = parts.indexOf('d');
      if (i > 0 && parts[i + 1]) return `https://docs.google.com/${parts[0]}/d/${parts[i + 1]}`;
    }
    if (host.endsWith('.wikipedia.org') && u.pathname === '/w/index.php' && q.get('title')) {
      parts = ['wiki', ...q.get('title').replace(/ /g, '_').split('/')];
      q.delete('title');
    }
    if (host === 'github.com') parts = parts.map((x, i) => (i < 2 ? x.toLowerCase() : x));
    const drop = SITE_DROP[host];
    const kept = [...q].filter(([k]) => !TRACK.test(k) && !(drop && drop.test(k))).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    const qs = kept.length ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
    const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
    const frag = u.hash.split(':~:')[0];
    const hash = frag.length > 1 && (IN_HASH.test(host) || /^#[/!]/.test(frag)) ? frag : '';
    return `https://${host}${port}${parts.length ? `/${parts.map(segment).join('/')}` : ''}${qs}${hash}`;
  }
  const plainUrl = (url) => String(url || '').split('#')[0];
  /* A record is found by its page's key, or by an address that page redirected from (its `from`). */
  const ALIAS = new Map();
  /* A deleted or moved record leaves { gone: true, at } so that windows and the store can tell a deletion from a record
     they have not seen yet; it counts as no record. */
  const own = (k) => !!k && Object.prototype.hasOwnProperty.call(PAGES, k) && !!PAGES[k] && !PAGES[k].gone;
  const keyOf = (k) => (own(k) ? k : ALIAS.has(k) && own(ALIAS.get(k)) ? ALIAS.get(k) : '');
  const rec = (k) => { const x = keyOf(k); return x ? PAGES[x] : null; };
  function reindex() {
    ALIAS.clear();
    for (const k of Object.keys(PAGES)) if (own(k)) for (const f of PAGES[k].from || []) if (f !== k) ALIAS.set(f, k);
  }
  function ensure(url, title) {
    const k = key(url);
    if (!k) return null;
    if (!rec(k)) PAGES[k] = { url: plainUrl(url), title: title || '', about: '', note: '', at: Date.now() };
    return rec(k);
  }
  /* What was written under each quoted sentence of a page's note, up to the next blank line or quote. */
  function marksOf(note) {
    const out = [];
    let cur = null;
    for (const line of String(note || '').split('\n')) {
      if (line.startsWith(QUOTE) && line.slice(QUOTE.length).trim()) { cur = { text: line.slice(QUOTE.length).trim(), note: '' }; out.push(cur); continue; }
      if (!line.trim()) { cur = null; continue; }
      if (cur) cur.note = cur.note ? `${cur.note}\n${line}` : line;
    }
    return out;
  }

  function split(key) {
    const k = key.indexOf(':');
    return { kind: key.slice(0, k), id: key.slice(k + 1) };
  }
  /* The address a page window shows now: its tab on screen (none yet for a new tab, which so has no note of a page),
     else, for a window with no tabs yet, its note's. */
  function pageUrl(ws, w) {
    if (Array.isArray(w.tabs) && w.tabs.length) {
      const t = w.tabs[Number.isInteger(w.tab) ? w.tab : 0];
      return (t && t.url) || '';
    }
    const n = H.noteById(ws, w.noteId);
    return (n && n.url) || '';
  }
  function valueFor(ws, key, w) {
    const { kind, id } = split(key);
    if (kind === 'win') { const x = H.findWin(ws, id); return x ? x.note || '' : null; }
    if (kind === 'page') { const b = PANE.get(id); const r = b && rec(b.key); return r ? r.note : ''; }
    const n = H.noteById(ws, id);
    if (!n) return null;
    if (kind === 'note') return n.body || '';
    return n.kind === 'page' || titled(n) ? n.title || '' : '';
  }
  function setValue(ws, key, v, ed) {
    const { kind, id } = split(key);
    if (kind === 'win') {
      const w = H.findWin(ws, id);
      if (!w) return false;
      w.note = v;
      return true;
    }
    if (kind === 'page') {
      const b = PANE.get(id);
      const r = b && (rec(b.key) || (v ? ensure(b.url, b.title) : null));
      if (!r) return false;
      r.note = v;
      r.at = Date.now();
      return true;
    }
    const n = H.noteById(ws, id);
    if (!n) return false;
    if (kind === 'note') { n.body = v; return true; }
    n.title = v;
    n.titleSet = !!v.trim();
    H.updateNoteTitle(ws, n, ed);
    return true;
  }
  function changed(winId, key, v, ed) {
    const L = H.locate(winId);
    if (!L) return;
    const n = L.w.noteId ? H.noteById(L.ws, L.w.noteId) : null, name = n ? noteName(n) : '';
    if (!setValue(L.ws, key, v, ed)) return;
    if (key.startsWith('page:')) { marks(L.ws, L.w); paintOthers(winId); }
    else if (L.w.type === 'note') heading(L.ws, L.w);
    const relit = relight(L.ws, L.w);
    // the sidebar shows a note's name and ✎, and its search finds notes by their text: only those draw it again
    const q = document.getElementById('q');
    if (relit || (n && noteName(n) !== name) || (q && q.value.trim())) H.scheduleSidebar();
    H.save();
  }

  /* ---------- markup: the ✎ panel, and a note window's body ---------- */
  // the divider sits just before the pane, on its edge (the pane clips what lies outside it)
  const GRIP = '<div class="npane-grip"></div>';
  function paneHTML(w) {
    if (w.type === 'term') return `${GRIP}<div class="anote npane">${host(`win:${w.id}`, '')}</div>`;
    if (w.type === 'team') return `${GRIP}<div class="tnote npane">${host(`win:${w.id}`, '')}</div>`;
    if (w.type === 'page') return `${GRIP}<div class="anote npane">${host(`page:${w.id}`, '')}</div>`;
    return '';
  }
  /* The ✎ pane's left edge is a divider, as in a Mac split view: dragged, the pane takes that share of the window (a
     fifth to seven tenths), kept with the window, and a terminal beside it reflows as it goes; a double-click puts back
     the usual width. */
  function divider(r, id) {
    const g = r.el.querySelector('.npane-grip'), pane = g && g.nextElementSibling;
    if (!g || g.dataset.on || !pane || !pane.classList.contains('npane')) return;
    g.dataset.on = '1';
    const L0 = H.locate(id);
    if (L0 && L0.w.paneW) pane.style.width = `${(L0.w.paneW * 100).toFixed(2)}%`;
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // the edge keeps the distance from where it was pressed, and a terminal fits itself at most every 100 ms
      const body = pane.parentElement.getBoundingClientRect(), off = e.clientX - pane.getBoundingClientRect().left;
      let f = null, fitAt = 0;
      const move = (ev) => {
        f = Math.min(0.7, Math.max(0.2, (body.right - (ev.clientX - off)) / body.width));
        pane.style.width = `${(f * 100).toFixed(2)}%`;
        if (ev.timeStamp - fitAt >= 100) {
          fitAt = ev.timeStamp;
          H.fitSoon(0);
        }
      };
      const up = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        pane.classList.remove('sizing');
        H.fitSoon(0);
        const L = H.locate(id);
        if (f == null || !L) return;
        L.w.paneW = +f.toFixed(4);
        H.save();
      };
      if (e.isTrusted) g.setPointerCapture(e.pointerId);
      pane.classList.add('sizing');
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    });
    g.addEventListener('dblclick', () => {
      const L = H.locate(id);
      if (!L || !L.w.paneW) return;
      delete L.w.paneW;
      pane.style.width = '';
      H.fitSoon(60);
      H.save();
    });
  }
  function noteHTML(w) {
    return `<div class="nd">${titleField('ntitle', `title:${w.noteId}`, '')}${host(`note:${w.noteId}`, '', 'nbody')}</div>`;
  }

  /* Mounts an editor in each note host of a window that is in the DOM. */
  function attach(ws, w) {
    const r = H.win(w.id);
    if (!r) return;
    const eds = ED.get(w.id) || new Map();
    ED.set(w.id, eds);
    if (w.type === 'page') bind(ws, w);
    r.el.querySelectorAll('.nhost[data-key]').forEach((h) => {
      const key = h.dataset.key;
      if (eds.has(key)) return;
      const page = key.startsWith('page:');
      eds.set(key, window.FlowNote.mount(h, {
        key, className: `ned${h.dataset.cls ? ` ${h.dataset.cls}` : ''}`, placeholder: h.dataset.ph, value: valueFor(ws, key, w) || '',
        writable: !page || !!PANE.get(w.id).key,
        onChange: (v) => changed(w.id, key, v),
        quotes: page,
        found: page ? (text) => { const f = FOUND.get(w.id); return !!f && f.has(text); } : null,
        onQuote: (text) => showQuote(w.id, text),
        onOpenLink: (url) => H.openLink(w.id, url),
        brief,
        peek: (url, box) => peek(w.id, url, box),
        folds: foldsOf(ws, key) || {},
        onFolds: (f) => { const L = H.locate(w.id); if (L) setFolds(L.ws, key, f); },
      }));
    });
    if (w.type === 'page') marks(ws, w);
    LIT.set(w.id, lit(ws, w));
    divider(r, w.id);
  }
  /* What is unfolded in a note is remembered with that note: the agent's window, the note, the page's record. */
  function foldsOf(ws, key) {
    const { kind, id } = split(key);
    if (kind === 'win') { const w = H.findWin(ws, id); return w && w.folds; }
    if (kind === 'page') { const b = PANE.get(id); const r = b && rec(b.key); return r && r.folds; }
    const n = H.noteById(ws, id);
    return n && n.folds;
  }
  function setFolds(ws, key, f) {
    const { kind, id } = split(key);
    const has = Object.keys(f).length;
    let o = null;
    if (kind === 'win') o = H.findWin(ws, id);
    else if (kind === 'page') { const b = PANE.get(id); o = b && rec(b.key); }
    else if (kind === 'note') o = H.noteById(ws, id);
    if (!o) return;
    if (has) o.folds = f;
    else delete o.folds;
    if (kind === 'page') o.at = Date.now();
    H.save();
  }
  /* The page itself inside a note: one at a time, gone when folded. */
  let peeks = 0;
  function peek(winId, url, box) {
    if (!window.FlowPage) { console.error('page.js did not load, so a page cannot show inside a note'); return { dispose: noopDispose }; }
    const p = window.FlowPage.mount(box, { id: `peek-${winId}-${++peeks}`, url, bare: true, onOpen: (u) => H.openLink(winId, u) });
    p.setVisible(true);
    return { dispose: () => p.dispose() };
  }
  const noopDispose = () => {};
  function detach(id) {
    // a note window going away leaves its place, size and sub-workspace with its note (the size it had before ⤢, if it
    // was so)
    const L = H.locate(id), n = L && L.w.type === 'note' ? H.noteById(L.ws, L.w.noteId) : null;
    if (n) { const g = L.w.max || L.w; n.place = { x: g.x, y: g.y, w: g.w, h: g.h, ...(L.w.zone ? { zone: L.w.zone } : {}) }; }
    const eds = ED.get(id);
    if (eds) eds.forEach((e) => e.dispose());
    ED.delete(id);
    PANE.delete(id);
    LIT.delete(id);
    FOUND.delete(id);
  }
  function editorOf(id, key) {
    const eds = ED.get(id);
    return eds ? eds.get(key) || null : null;
  }
  /* Edit > Undo and Redo (app.js's menu actions) for what has the keys: true when it is in a note's text, which keeps
     its own history, so nothing else may undo there. */
  function history(el, back) {
    if (!el) return false;
    const t = el.closest && el.closest('.ntitle');
    if (t) {
      titleStep(t, back);
      return true;
    }
    for (const eds of ED.values()) {
      for (const e of eds.values()) {
        if (!e.el.contains(el)) continue;
        if (back) e.undo();
        else e.redo();
        return true;
      }
    }
    return false;
  }

  /* Puts the model's text into a window's notes; a focused one is left alone unless force. */
  function fill(ws, w, force) {
    const r = H.win(w.id);
    if (!r) return;
    if (w.type === 'page') bind(ws, w);
    const eds = ED.get(w.id);
    if (eds) eds.forEach((e, key) => {
      if (!force && e.el === document.activeElement) return;
      const v = valueFor(ws, key, w);
      if (v != null) e.set(v);
    });
    r.el.querySelectorAll('.ned[contenteditable][data-key^="title:"]').forEach((ed) => {
      if (!force && ed === document.activeElement) return;
      const v = valueFor(ws, ed.dataset.key, w);
      if (v != null && ed.innerText.replace(/\n$/, '') !== v) {
        ed.textContent = v;
        TITLES.delete(ed);
      }
    });
    if (w.type === 'note') heading(ws, w);
    if (w.type === 'page') marks(ws, w);
    relight(ws, w);
  }

  /* ---------- a page window's ✎ panel shows the note of the page on screen ---------- */
  function bind(ws, w) {
    const url = pageUrl(ws, w);
    const k = key(url);
    const n = H.noteById(ws, w.noteId);
    const old = PANE.get(w.id);
    PANE.set(w.id, { key: k, url, title: (n && n.title) || '' });
    // a tab with no page has no note: its panel takes no typing until a page shows
    const e = editorOf(w.id, `page:${w.id}`);
    if (e) e.writable(!!k);
    return !old || old.key !== k;
  }
  /* The page on screen changed (another tab, a link followed): its own note shows. */
  function follow(ws, w) {
    if (w.type !== 'page' || !bind(ws, w)) { const r = rec((PANE.get(w.id) || {}).key); if (r && !r.title && PANE.get(w.id).title) r.title = PANE.get(w.id).title; return; }
    FOUND.delete(w.id);
    const e = editorOf(w.id, `page:${w.id}`);
    if (e) { e.set(valueFor(ws, `page:${w.id}`, w)); e.setFolds(foldsOf(ws, `page:${w.id}`) || {}); }
    marks(ws, w);
    relight(ws, w);
  }
  /* The page on screen highlights its quoted sentences; hovering one shows what was written under it. It says which
     of them it has, so ↗ shows only where it can take the owner. */
  let warnedMarks = false;
  function marks(ws, w) {
    const p = H.page(w.id);
    if (!p) return;
    if (typeof p.setMarks !== 'function') {
      if (!warnedMarks) { warnedMarks = true; console.warn('page.js has no setMarks yet, so annotations are not highlighted on pages'); }
      return;
    }
    const r = rec((PANE.get(w.id) || {}).key);
    p.setMarks(marksOf(r ? r.note : ''), (texts) => {
      FOUND.set(w.id, new Set(texts));
      const e = editorOf(w.id, `page:${w.id}`);
      if (e) e.repaint();
    });
  }
  /* Another window showing the same page follows an edit made here. */
  function paintOthers(fromId) {
    const b = PANE.get(fromId);
    if (!b) return;
    for (const [id, x] of PANE) {
      if (id === fromId || x.key !== b.key) continue;
      const L = H.locate(id);
      if (L) fill(L.ws, L.w);
    }
  }
  let warnedFind = false;
  function showQuote(id, text) {
    const p = H.page(id);
    if (!p) return;
    if (typeof p.findQuote !== 'function') {
      if (!warnedFind) { warnedFind = true; console.warn('page.js has no findQuote yet, so ↗ cannot scroll the page to a quoted sentence'); }
      return;
    }
    p.findQuote(text).then((found) => {
      if (found) return;
      // the page changed since it said it had the sentence: its ↗ goes
      const f = FOUND.get(id);
      if (f) f.delete(String(text).trim());
      const e = editorOf(id, `page:${id}`);
      if (e) e.repaint();
    }, (err) => console.error('could not look for the sentence on the page', err));
  }
  /* A click on a highlighted sentence in the page opens the ✎ panel at what was written under it. */
  function onMark(id, text) {
    const L = H.locate(id);
    const r = L && rec((PANE.get(id) || {}).key);
    if (!r) return;
    setPane(L.ws, L.w, true, 'end');
    const e = editorOf(id, `page:${id}`);
    const lines = r.note.split('\n');
    let off = 0, end = -1;
    for (const line of lines) {
      const start = off;
      off += line.length + 1;
      if (end < 0) {
        if (line.startsWith(QUOTE) && line.slice(QUOTE.length).trim() === text) end = start + line.length;
        continue;
      }
      if (!line.trim() || line.startsWith(QUOTE)) break;
      end = start + line.length;
    }
    if (e && end >= 0) e.focusAt(end);
  }

  /* ---------- ✎: open or closed, bright when the window's note has something in it ---------- */
  function paneKey(w) {
    if (w.type === 'term' || w.type === 'team') return `win:${w.id}`;
    if (w.type === 'page') return `page:${w.id}`;
    return '';
  }
  function setPane(ws, w, on, at) {
    const r = H.win(w.id);
    if (!r) return;
    w.noted = on;
    r.el.classList.toggle('noted', on);
    if (on) {
      const e = editorOf(w.id, paneKey(w));
      if (e) e.focus(at || 'end');
    }
    H.fitSoon(60);
    H.save();
  }
  function toggle(ws, w) {
    const r = H.win(w.id);
    if (r) setPane(ws, w, !r.el.classList.contains('noted'));
  }
  function lit(ws, w) {
    if (w.type === 'term' || w.type === 'team') return !!String(w.note || '').trim();
    if (w.type === 'page') { const b = PANE.get(w.id) || { key: key(pageUrl(ws, w)) }; const r = rec(b.key); return !!(r && r.note.trim()); }
    return false;
  }
  function relight(ws, w) {
    const now = lit(ws, w);
    if (LIT.get(w.id) === now) return false;
    LIT.set(w.id, now);
    H.renderTitle(ws, w);
    return true;
  }

  /* ---------- note windows ---------- */
  function open(ws, nid) {
    const n = H.noteById(ws, nid);
    let w = ws.windows.find((x) => x.noteId === nid), back = false;
    if (!w) {
      if (!n) return null;
      const page = n.kind === 'page', p = !page && n.place;
      if (p) {
        // a note opened again comes back exactly where it was, at its size, in its sub-workspace, and what is there now
        // makes way, as for a terminal reopened from its row (app.js's clear); without that, a place another window
        // took meanwhile gives a free spot in that space
        const zone = p.zone && spaceOf(ws, p.zone) ? p.zone : null;
        const taken = !H.clear && ws.windows.some((o) => (o.zone || null) === zone && p.x < o.x + o.w && o.x < p.x + p.w && p.y < o.y + o.h && o.y < p.y + p.h);
        const at = taken ? H.freeSpot(ws, p.w, p.h, zone) : { x: p.x, y: p.y, w: p.w, h: p.h };
        w = H.addWindow(ws, { id: H.newId('w'), type: 'note', noteId: nid, ...at }, null, zone);
        back = !taken && !!H.clear;
      } else w = H.addWindow(ws, { id: H.newId('w'), type: page ? 'page' : 'note', noteId: nid, ...H.freeSpot(ws, page ? 46 : 34, page ? 62 : 46) });
      H.renderSidebar();
    }
    H.focusWin(ws, w);
    // once its space is on screen: clear makes room in the space shown
    if (back) H.clear(ws, w);
    focus(ws, w);
    return w;
  }
  /* Going to a note window: its body takes the caret where it last was (the end the first time). */
  function focus(ws, w) {
    if (!w || w.type !== 'note') return;
    const e = editorOf(w.id, `note:${w.noteId}`);
    if (e) e.focus('last');
  }

  /* A note's title is one line: Enter goes on to the body, a paste comes in as one line. */
  function onTitleKey(e) {
    const t = e.target.closest && e.target.closest('.ntitle');
    if (!t) return;
    // ⌘Z and ⇧⌘Z where the keys reach the title before the menu: the title's own steps; a key that moves the caret ends
    // the run
    if (/^(?:Arrow|Page|Home$|End$)/.test(e.key)) titleHist(t).run = '';
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' || (k === 'y' && e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        titleStep(t, k === 'z' && !e.shiftKey);
        return;
      }
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const win = t.closest('.win');
    const L = win && H.locate(win.dataset.id);
    const b = L ? editorOf(L.w.id, `note:${L.w.noteId}`) : null;
    if (b) b.focus('start');
  }
  function onTitlePaste(e) {
    const t = e.target.closest && e.target.closest('.ntitle');
    if (!t) return;
    e.preventDefault();
    // a paste is a step of its own
    const h = titleHist(t);
    h.run = '';
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ').replace(/\s+$/, ''));
    h.run = '';
  }
  function onTitleInput(e) {
    const ed = e.target.closest && e.target.closest('.ntitle');
    if (!ed || !ed.dataset.key) return;
    recordTitle(ed, e.inputType || '');
    const win = ed.closest('.win');
    if (win) changed(win.dataset.id, ed.dataset.key, titleText(ed), ed);
  }
  // Chromium's own undo and redo commands on a title (from anywhere that sends them) take the same steps
  function onTitleBefore(e) {
    const t = e.target.closest && e.target.closest('.ntitle');
    if (!t) return;
    // the history starts from the title as it was before its first change
    titleHist(t);
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
    e.preventDefault();
    titleStep(t, e.inputType === 'historyUndo');
  }
  function onTitleMoved(e) {
    const t = e.target.closest && e.target.closest('.ntitle');
    if (t && TITLES.has(t)) TITLES.get(t).run = '';
  }

  /* A note's title keeps its own undo, as its body does (FlowNote's mount): each key in a title renames the note and
     redraws its row, and Chromium ends a typing run whenever a node in the window is removed, so its undo took a title
     back a letter at a time. A run of typing, or of deleting, with the caret left alone is one step; text put in from
     outside (fill) starts the history again. */
  const TITLES = new WeakMap();
  const titleText = (t) => t.innerText.replace(/\n$/, '').replace(/\n/g, ' ');
  const titleRun = (type) => (/^insert(?:Text|CompositionText)$/.test(type) ? 'type' : /^delete(?:Content|Word)/.test(type) ? 'delete' : '');
  function titleCaret(t) {
    const sel = getSelection();
    if (!sel.rangeCount || !t.contains(sel.anchorNode) || !t.contains(sel.focusNode)) return null;
    const off = (node, o) => { const r = document.createRange(); r.selectNodeContents(t); r.setEnd(node, o); return r.toString().length; };
    const a = off(sel.anchorNode, sel.anchorOffset), b = off(sel.focusNode, sel.focusOffset);
    return { a: Math.min(a, b), b: Math.max(a, b) };
  }
  function titleSelect(t, a, b) {
    const n = t.firstChild && t.firstChild.nodeType === 3 ? t.firstChild : null, len = n ? n.data.length : 0;
    const r = document.createRange();
    if (n) {
      r.setStart(n, Math.min(a, len));
      r.setEnd(n, Math.min(b, len));
    } else r.setStart(t, 0);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function titleHist(t) {
    let h = TITLES.get(t);
    if (!h) {
      h = { past: [], future: [], now: { text: t.textContent, at: null }, run: '' };
      TITLES.set(t, h);
    }
    return h;
  }
  function recordTitle(t, type) {
    const h = titleHist(t), text = t.textContent, at = titleCaret(t);
    if (text !== h.now.text) {
      const kind = titleRun(type), last = h.past[h.past.length - 1];
      if (kind && kind === h.run && last) last.after = { text, at };
      else if (h.past.push({ before: h.now, after: { text, at } }) > 200) h.past.shift();
      h.run = kind;
      h.future.length = 0;
    }
    h.now = { text, at };
  }
  function titleStep(t, back) {
    const h = titleHist(t), step = (back ? h.past : h.future).pop();
    if (!step) return;
    (back ? h.future : h.past).push(step);
    h.run = '';
    const s = back ? step.before : step.after, at = s.at || { a: s.text.length, b: s.text.length };
    t.textContent = s.text;
    titleSelect(t, at.a, at.b);
    h.now = { text: s.text, at: titleCaret(t) };
    const win = t.closest('.win');
    if (win && t.dataset.key) changed(win.dataset.id, t.dataset.key, titleText(t), t);
  }

  /* ---------- a clip is an annotation: the sentence goes into the page's own note, and the page highlights it ---------- */
  function clip(id, text, url) {
    const L = H.locate(id);
    const quote = oneLine(text).trim();
    if (!L || !quote) return;
    const b = PANE.get(id);
    const r = ensure(url || (b && b.url), b && b.title);
    if (!r) return;
    const body = r.note.replace(/\s+$/, '');
    r.note = `${body}${body ? '\n\n' : ''}${QUOTE}${quote}\n`;
    r.at = Date.now();
    follow(L.ws, L.w);
    fill(L.ws, L.w, true);
    paintOthers(id);
    setPane(L.ws, L.w, true, 'end');
    H.scheduleSidebar();
    H.save();
  }
  /* A page that loaded tells what it is; its record (if it has one, or once it is saved somewhere) keeps that. */
  function seen(url, o = {}) {
    const k = key(url);
    if (!k) return;
    /* What a page says about itself is not the owner's change (notes-merge.js). A record made here for a saved page
       loses to one the owner changed in another window, but not to a deletion this window already knows of. */
    let r = rec(k);
    if (!r && H.workspaces().some((ws) => (ws.saved || []).some((s) => key(s.url) === k))) {
      const was = PAGES[k];
      r = ensure(url, o.title);
      r.at = was && was.gone ? (was.at || 0) + 1 : 0;
    }
    if (!r) return;
    let c = false;
    if (o.title && o.title !== r.title) { r.title = o.title; c = true; }
    if (o.about && o.about !== r.about) { r.about = o.about; c = true; }
    if (!c) return;
    r.seen = Date.now();
    H.save();
  }

  /* ---------- a page's name: the one the owner gave it ('' for none), shown instead of its own title ---------- */
  function nameOf(url) {
    const r = rec(key(url));
    return (r && r.name) || '';
  }
  /* title: the page's own title, for a record made here (the page had no notes and was not saved). */
  function renamePage(url, name, title) {
    const k = key(url);
    if (!k) return false;
    const v = oneLine(name).trim();
    const r = rec(k) || (v ? ensure(url, oneLine(title).trim()) : null);
    if (!r) return false;
    let c = false;
    if (!r.title && title) { r.title = oneLine(title).trim(); c = true; }
    if ((r.name || '') !== v) {
      if (v) r.name = v;
      else delete r.name;
      c = true;
    }
    if (!c) return false;
    r.at = Date.now();
    H.save();
    H.renamed(k);
    return true;
  }

  /* ---------- a redirect (the server's, or the page's own before any input) keeps the page: its record moves to where
     the page landed, merging into one that is already there, and the address it left still finds it. A navigation the
     owner makes is not a redirect: page.js reports only redirects. ---------- */
  /* A bounce to sign in (a sign-in address, or one that carries the page it came from to go back to) is not the page
     moving: the name stays where it was given. */
  const RETURN = /^(?:next|return_?to|return_?url|redirect(?:_?uri|_?url|_?to)?|continue|callback(?:_?url)?|dest(?:ination)?|goto|target)$/i;
  const SIGNIN = /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|auth|sso|oauth2?|authorize)(?:[/.]|$)/i;
  function bounce(from, to) {
    const t = new URL(to);
    if (SIGNIN.test(t.pathname)) return true;
    const fp = URL.canParse(from) ? new URL(from).pathname : '';
    for (const [k, v] of t.searchParams) if (RETURN.test(k) || (fp.length > 1 && v.includes(fp))) return true;
    return false;
  }
  function moved(from, to) {
    const a = keyOf(key(from)), b = key(to);
    if (!a || !b || a === b || keyOf(b) === a || bounce(from, to)) return false;
    const src = PAGES[a];
    const bk = keyOf(b) || b;
    const dst = own(bk) ? PAGES[bk] : null;
    /* Two pages that both hold the owner's words stay two pages. */
    if (dst && ((dst.name && src.name && dst.name !== src.name) || (dst.note.trim() && src.note.trim() && !dst.note.includes(src.note.trim())))) return false;
    if (!dst) {
      PAGES[bk] = src;
      src.url = plainUrl(to);
    } else {
      if (!dst.name && src.name) dst.name = src.name;
      const t = src.note.trim();
      if (t && !dst.note.includes(t)) dst.note = dst.note.trim() ? `${dst.note.replace(/\s+$/, '')}\n\n${src.note}` : src.note;
      if (!dst.title && src.title) dst.title = src.title;
      if (!dst.about && src.about) dst.about = src.about;
      if (src.folds) dst.folds = { ...src.folds, ...(dst.folds || {}) };
    }
    const r = PAGES[bk];
    r.from = [...new Set([...(r.from || []), a, ...(src.from || [])])].filter((k) => k !== bk);
    r.at = Date.now();
    PAGES[a] = { gone: true, at: r.at };
    reindex();
    const showing = [...PANE].filter(([, x]) => x.key === a || x.key === bk).map(([id]) => id);
    for (const id of showing) {
      const L = H.locate(id);
      if (L) { PANE.delete(id); fill(L.ws, L.w, false); }
    }
    H.save();
    H.renamed(bk);
    return true;
  }

  /* ---------- records for the sidebar: the page in brief, and deleting what was written about a page ---------- */
  function records() {
    return Object.keys(PAGES).filter(own).map((k) => ({ key: k, url: PAGES[k].url, title: PAGES[k].title, name: PAGES[k].name || '', at: PAGES[k].at, hasNote: !!String(PAGES[k].note || '').trim() }));
  }
  function deletePage(k) {
    const r = own(k) ? PAGES[k] : null;
    if (!r) return null;
    PAGES[k] = { gone: true, at: Date.now() };
    reindex();
    refreshKey(k);
    H.save();
    let undone = false;
    return {
      title: r.title || r.url,
      undo: () => {
        if (undone || rec(k)) return false;
        undone = true;
        PAGES[k] = { ...r, at: Date.now() };
        reindex();
        refreshKey(k);
        H.save();
        return true;
      },
    };
  }
  /* A closed page window's entry in ws.notes stays only while it holds something of the owner's: a page among its tabs
     with text or a name in its record, or saved in any workspace; the entry in a section; another window on it. */
  function unused(ws, w) {
    const n = w && H.noteById(ws, w.noteId);
    if (!n || n.kind !== 'page' || n.parent || String(n.body || '').trim() || (n.titleSet && n.title)) return false;
    if (ws.windows.some((x) => x !== w && x.noteId === n.id)) return false;
    const saved = new Set(H.workspaces().flatMap((x) => (x.saved || []).map((s) => key(s.url))));
    return ![n.url, ...(w.tabs || []).map((t) => t && t.url)].map(key).filter(Boolean)
      .some((k) => { const r = rec(k); return saved.has(k) || (r && (r.note.trim() || r.name)); });
  }
  function refreshKey(k) {
    for (const [id, b] of PANE) {
      if (b.key !== k) continue;
      const L = H.locate(id);
      if (L) fill(L.ws, L.w, true);
    }
    H.renderSidebar();
  }
  const siteOf = (url) => { const s = String(url || ''); return URL.canParse(s) ? new URL(s).hostname.replace(/^www\./, '') : s; };
  /* The page in brief: its name as its row shows it (the owner's, else the title the row has, else its own), its site
     unless that is the name, what it is about, the start of its note and its quoted sentences. */
  function brief(url, title) {
    const r = rec(key(url));
    const el = document.createElement('div');
    el.className = 'nbrief';
    const add = (cls, text) => { if (!text) return; const d = document.createElement('div'); d.className = cls; d.textContent = text; el.appendChild(d); };
    const site = siteOf(url);
    const name = (r && r.name) || oneLine(title).trim() || (r && r.title) || site;
    add('nb-t', name);
    if (name !== site) add('nb-s', site);
    add('nb-a', r && r.about);
    if (r && r.note.trim()) {
      const lines = r.note.split('\n').filter((l) => l.trim()).slice(0, 8);
      lines.forEach((l) => (l.startsWith(QUOTE) ? add('nb-q', l.slice(QUOTE.length)) : add('nb-n', l)));
    }
    return el;
  }

  /* ---------- the store: load, save, other windows. A state saved before page records existed (no pages in it) has
     its page notes moved into records once; after that a launch changes nothing, so a page comes back as it was left. */
  function load(doc) {
    use(window.FlowNotesMerge.merge({}, doc).pages);
    return doc == null ? migrate() : 0;
  }
  function use(pages) {
    PAGES = pages;
    for (const r of Object.values(PAGES)) if (!r.gone) r.note = String(r.note || '');
    reindex();
  }
  /* Old page notes (ws.notes entries of kind 'page') move into their page's record, written or not, so every page the
     owner had stays in the state and ⌘K finds it until the owner's × removes it. Nothing is lost: text already in the
     record is not added twice, a page without an address keeps its entry, an entry a window points at stays (empty),
     and so does one in a section until the sidebar has moved it to its saved pages. */
  function migrate() {
    let moved = 0;
    for (const ws of H.workspaces()) {
      const used = new Set(ws.windows.map((w) => w.noteId).filter(Boolean));
      for (const n of [...ws.notes]) {
        if (n.kind !== 'page' || !key(n.url)) continue;
        const text = String(n.body || '').replace(/\s+$/, '');
        if (!rec(key(n.url))) moved++;
        const r = ensure(n.url, n.title || '');
        if (!r.title && n.title) r.title = n.title;
        if (n.titleSet && n.title && !r.name) { r.name = n.title; moved++; }
        if (text && !r.note.includes(text)) r.note = r.note.trim() ? `${r.note.replace(/\s+$/, '')}\n\n${text}` : text;
        if (n.body || n.clips) moved++;
        n.body = '';
        delete n.clips;
        if (!used.has(n.id) && !n.parent && Array.isArray(ws.saved)) { ws.notes.splice(ws.notes.indexOf(n), 1); moved++; }
      }
    }
    return moved;
  }
  const pagesDoc = () => PAGES;
  /* Another window saved: each record is taken from whichever copy changed it last (notes-merge.js; the store merges
     the same way). A focused note is not rewritten under the caret (fill leaves it), and its next keystroke is newer. */
  function remote(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return;
    use(window.FlowNotesMerge.merge(PAGES, doc).pages);
  }

  /* ---------- an agent's note stays with its Claude session when the agent ends, and comes back with it ---------- */
  function keep(ws, w) {
    if (!w || !w.sessionId || !(w.note || '').trim()) return false;
    ws.sessionNotes = { ...(ws.sessionNotes || {}), [w.sessionId]: w.note };
    return true;
  }
  function take(sid) {
    for (const ws of H.workspaces()) {
      const m = ws.sessionNotes;
      if (m && Object.prototype.hasOwnProperty.call(m, sid)) {
        const v = m[sid];
        const rest = { ...m };
        delete rest[sid];
        if (Object.keys(rest).length) ws.sessionNotes = rest;
        else delete ws.sessionNotes;
        return v;
      }
    }
    return '';
  }

  /* ---------- sections: a note or a page moves into a named section of its group. A section is a ws.notes entry of
     kind 'folder' that holds 'note' or 'page'; an item points at its section with parent. A section is in one space of
     its workspace: zone is that sub-workspace's id, none for the main space. ---------- */
  const byId = (ws, id) => ws.notes.find((n) => n.id === id) || null;
  const isSection = (n) => !!n && n.kind === 'folder';
  const itemsOf = (ws, id) => ws.notes.filter((n) => (n.parent || null) === id);
  function holdsOf(ws, f) {
    if (f.holds) return f.holds;
    const items = itemsOf(ws, f.id);
    return items.length && items.every((n) => n.kind === 'page') ? 'page' : 'note';
  }
  const kindOf = (n) => (n.kind === 'page' ? 'page' : 'note');
  const spaceOf = (ws, zone) => (zone && (ws.zones || []).some((z) => z.id === zone) ? zone : null);
  const done = (v) => { H.renderSidebar(); H.save(); return v; };
  function sections(ws, holds) {
    return ws.notes.filter((n) => isSection(n) && (!holds || holdsOf(ws, n) === holds));
  }
  function sectionOf(ws, id) {
    const n = byId(ws, id);
    const f = n && n.parent ? byId(ws, n.parent) : null;
    return isSection(f) ? f : null;
  }
  function newSection(ws, o = {}) {
    const holds = o.holds === 'page' ? 'page' : 'note';
    const title = String(o.title || '').trim() || 'new section';
    const f = { id: H.newId('n'), kind: 'folder', title, holds };
    const zone = spaceOf(ws, o.zone);
    if (zone) f.zone = zone;
    const last = ws.notes.map((n, i) => (isSection(n) && holdsOf(ws, n) === holds ? i : -1)).filter((i) => i >= 0).pop();
    ws.notes.splice(last == null ? ws.notes.length : last + 1, 0, f);
    const item = o.item ? byId(ws, o.item) : null;
    if (item && !isSection(item) && kindOf(item) === holds) item.parent = f.id;
    return done(f);
  }
  /* A note renamed from the sidebar: its window's heading follows. A blank name takes the title away, so the note is
     named by its first line again. */
  function renameNote(ws, id, title) {
    const n = byId(ws, id);
    const t = oneLine(title).trim();
    if (!n || isSection(n) || n.kind === 'page' || (t ? titled(n) && n.title === t : !titled(n))) return false;
    n.title = t;
    n.titleSet = !!t;
    H.updateNoteTitle(ws, n);
    ws.windows.filter((x) => x.noteId === id).forEach((x) => heading(ws, x));
    return done(true);
  }
  function renameSection(ws, id, title) {
    const f = byId(ws, id);
    const t = String(title || '').trim();
    if (!isSection(f) || !t) return false;
    f.title = t;
    return done(true);
  }
  function move(ws, id, sectionId) {
    const n = byId(ws, id);
    if (!n || isSection(n)) return false;
    if (sectionId) {
      const f = byId(ws, sectionId);
      if (!isSection(f) || holdsOf(ws, f) !== kindOf(n)) return false;
      n.parent = f.id;
    } else delete n.parent;
    return done(true);
  }
  /* A section to another space of its workspace (zone null: the main one). */
  function moveSection(ws, id, zone) {
    const f = byId(ws, id), z = spaceOf(ws, zone);
    if (!isSection(f) || (zone && !z) || (f.zone || null) === z) return false;
    if (z) f.zone = z;
    else delete f.zone;
    return done(true);
  }
  /* Saved pages (sidebar's ws.saved) count as items of their section too. */
  function removeSection(ws, id) {
    const f = byId(ws, id);
    if (!isSection(f) || itemsOf(ws, id).length || (ws.saved || []).some((x) => x.section === id)) return false;
    ws.notes.splice(ws.notes.indexOf(f), 1);
    return done(true);
  }
  /* Deleting closes the note's window; undo puts the note back in its place and its window where it was. */
  function deleteNote(ws, id) {
    const n = byId(ws, id);
    if (!n || isSection(n)) return null;
    const at = ws.notes.indexOf(n);
    const wins = ws.windows.filter((w) => w.noteId === id).map((w) => ({ ...w }));
    ws.windows.filter((w) => w.noteId === id).forEach((w) => { detach(w.id); H.removeWindow(ws, w); });
    ws.notes.splice(at, 1);
    let undone = false;
    const undo = () => {
      if (undone || byId(ws, id)) return false;
      undone = true;
      if (n.parent && !isSection(byId(ws, n.parent))) delete n.parent;
      ws.notes.splice(Math.min(at, ws.notes.length), 0, n);
      wins.forEach((w) => H.addWindow(ws, w));
      return done(true);
    };
    done(true);
    return { title: noteName(n) || 'untitled', undo };
  }

  function mount(hooks) {
    H = hooks;
    document.addEventListener('keydown', onTitleKey, true);
    document.addEventListener('paste', onTitlePaste, true);
    document.addEventListener('input', onTitleInput);
    document.addEventListener('beforeinput', onTitleBefore, true);
    document.addEventListener('mousedown', onTitleMoved, true);
    document.addEventListener('focusout', onTitleMoved, true);
  }

  window.FlowNotes = {
    mount, paneHTML, noteHTML, attach, detach, fill, toggle, open, focus, noteName, clip, keep, take,
    key, load, pagesDoc, remote, follow, lit, seen, onMark, records, deletePage, unused, brief, nameOf, renamePage, renameNote, moved,
    newSection, renameSection, move, moveSection, removeSection, deleteNote, sections, sectionOf,
    undo: (el) => history(el, true), redo: (el) => history(el, false),
  };
})();




