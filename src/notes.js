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
