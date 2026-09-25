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
