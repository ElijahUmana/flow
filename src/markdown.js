'use strict';
// Markdown as the owner reads it in Flow (files-main.js shows a .md file through it): CommonMark's blocks and inlines,
// GitHub's tables, task lists, strikethrough and bare links, and the few inert HTML tags real READMEs use. Any other
// tag in the file shows as text, so nothing in a file can run or load what the link rules do not allow.

const BLOCK_TAGS = new Set(['details', 'summary', 'p']);
const INLINE_TAGS = new Set(['br', 'img', 'a', 'strong', 'b', 'em', 'i', 'code', 'kbd', 'sub', 'sup']);
const VOID = new Set(['br', 'img']);
// CommonMark's HTML block tags: a line starting with one is HTML up to the next blank line (its allowed tags kept).
const HTML_BLOCK = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl '
  + 'dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu '
  + 'menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isBlank = (l) => /^[ \t]*$/.test(l);
const indentOf = (l) => {
  let n = 0;
  for (const c of l) {
    if (c === ' ') n++;
    else if (c === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
};
/* A line without its first n columns of indent (tabs count to the next multiple of 4). */
function dedent(l, n) {
  let col = 0, k = 0;
  while (k < l.length && col < n) {
    if (l[k] === ' ') col++;
    else if (l[k] === '\t') col += 4 - (col % 4);
    else break;
    k++;
  }
  return (col > n ? ' '.repeat(col - n) : '') + l.slice(k);
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\n]*?)[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const BULLET = /^( {0,3})([-+*])([ \t]+|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DEF = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

function itemStart(line) {
  let m = BULLET.exec(line);
  if (m && !HR.test(line)) {
    const gap = m[3] ? Math.min(m[3].length, 4) : 1;
    return { ordered: false, marker: m[2], start: 1, indent: m[1].length + 1 + (m[3].length > 4 ? 1 : gap), rest: m[3].length > 4 ? ' '.repeat(m[3].length - 1) + m[4] : m[4] };
  }
  m = ORDERED.exec(line);
  if (m) {
    const gap = m[4] ? Math.min(m[4].length, 4) : 1;
    return { ordered: true, marker: m[3], start: +m[2], indent: m[1].length + m[2].length + 1 + (m[4].length > 4 ? 1 : gap), rest: m[4].length > 4 ? ' '.repeat(m[4].length - 1) + m[5] : m[5] };
  }
  return null;
}
function htmlBlockStart(line) {
  if (/^ {0,3}<!--/.test(line)) return true;
  const m = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/.exec(line);
  if (m && HTML_BLOCK.has(m[1].toLowerCase())) return true;
  // A line that is one whole tag and nothing else (CommonMark's 7th kind) is HTML too; it cannot cut into a paragraph.
  return false;
}
const lonelyTag = (line) => /^ {0,3}<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>[ \t]*$/.test(line);
const tableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && DELIM.test(lines[i + 1]) && lines[i + 1].includes('-');

/* What interrupts a paragraph. */
function interrupts(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l) || htmlBlockStart(l) || tableStart(lines, i) || (!!itemStart(l) && !isBlank(itemStart(l).rest));
}

function splitRow(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/* o: { link(href) -> href | null, image(src) -> src | null }. Returns the document's HTML. */
function render(source, o) {
  const opts = o || {};
  const link = opts.link || ((h) => h);
  const image = opts.image || ((s) => s);
  let text = String(source == null ? '' : source).replace(/\r\n?/g, '\n').replace(/\u0000/g, '�');
  const out = [];

  // Front matter shows as it is, as a code block.
  const fm = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (fm) {
    out.push(`<pre class="fm"><code>${esc(fm[1])}\n</code></pre>`);
    text = text.slice(fm[0].length);
  }
  const lines = text.split('\n');

  // Link reference definitions, outside code.
  const defs = new Map();
  const norm = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  {
    let fence = null;
    for (let k = 0; k < lines.length; k++) {
      const f = FENCE.exec(lines[k]);
      if (fence) { if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3]) fence = null; continue; }
      if (f) { fence = f[2]; continue; }
      const d = DEF.exec(lines[k]);
      if (d && (k === 0 || isBlank(lines[k - 1]) || DEF.test(lines[k - 1]))) {
        const key = norm(d[1]);
        if (!defs.has(key)) defs.set(key, { href: d[2], title: d[3] || d[4] || d[5] || '' });
        lines[k] = '\u0000def';
      }
    }
  }

  const slugs = new Map();
  function slug(html) {
    const t = html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[e]));
    let s = t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    if (!s) s = 'section';
    const n = slugs.get(s) || 0;
    slugs.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  }

  /* ---------- inline ---------- */
  function attrs(name, raw) {
    const keep = name === 'a' ? ['href'] : name === 'img' ? ['src', 'alt', 'width', 'height'] : [];
    const got = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(raw))) {
      const k = m[1].toLowerCase();
      if (keep.includes(k) && !(k in got)) got[k] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    let s = '';
    if (got.href != null) { const h = link(unentity(got.href)); if (h) s += ` href="${esc(h)}"`; }
    if (got.src != null) { const h = image(unentity(got.src)); if (!h) return null; s += ` src="${esc(h)}"`; }
    if (got.alt != null) s += ` alt="${esc(unentity(got.alt))}"`;
    for (const k of ['width', 'height']) if (got[k] != null && /^\d{1,5}%?$/.test(got[k].trim())) s += ` ${k}="${got[k].trim()}"`;
    return s;
  }
  const unentity = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));

  /* shared: the held parts of the text this is inside (a link's label), restored by that outer call. */
  function inline(src, shared) {
    const held = shared || [];
    const hold = (html) => `\uE000${held.push(html) - 1}\uE001`;
    let s = src;

    // Code spans first (their content stays as written), then backslash escapes.
    s = s.replace(/(?<!\\)(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => {
      let b = body.replace(/\n/g, ' ');
      if (/^ .* $/.test(b) && b.trim()) b = b.slice(1, -1);
      return hold(`<code>${esc(b)}</code>`);
    });
    s = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_, c) => hold(esc(c)));
    // <https://...> autolinks.
    s = s.replace(/<((?:https?|mailto):[^\s<>]+)>/gi, (_, u) => {
      const h = link(u);
      return h ? hold(`<a href="${esc(h)}">${esc(u)}</a>`) : hold(esc(`<${u}>`));
    });
    // HTML comments disappear; allowed tags stay, without their other attributes; every other tag is text.
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    const open = [];
    s = s.replace(TAG, (whole, close, name, raw) => {
      const n = name.toLowerCase();
      if (!INLINE_TAGS.has(n) && !BLOCK_TAGS.has(n)) return whole;
      if (close) {
        const at = open.lastIndexOf(n);
        if (at < 0) return BLOCK_TAGS.has(n) ? hold(`</${n}>`) : '';
        const shut = open.splice(at).reverse().map((t) => `</${t}>`).join('');
        return hold(shut);
      }
      const a = attrs(n, raw || '');
      if (a === null) {
        const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(raw || '');
        return alt ? hold(esc(unentity(alt[1] ?? alt[2]))) : '';
      }
      if (!VOID.has(n) && !BLOCK_TAGS.has(n)) open.push(n);
      return hold(`<${n}${a}>`);
    });

    // Links and images: [text](dest "title"), [text][ref], [ref], ![alt](src).
    s = links(s, hold, held);

    // Bare web addresses.
    s = s.replace(/(^|[\s(*_~])((?:https?:\/\/|www\.)[^\s<>\uE000]+?)(?=[.,:;!?'")\]*_~]*(?:[\s\uE000]|$))/g, (_, pre, u) => {
      const h = link(u.startsWith('www.') ? `https://${u}` : u);
      return pre + (h ? hold(`<a href="${esc(h)}">${esc(u)}</a>`) : esc(u));
    });

    s = esc(s);
    // Emphasis, strong, strikethrough (on escaped text; held parts are opaque).
    s = s.replace(/\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    // Hard breaks: two spaces or a backslash at a line's end.
    s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');
    s += open.reverse().map((t) => `</${t}>`).join('');
    if (shared) return s;
    // Held parts may hold others (a link's text); restore until none is left.
    for (let k = 0; k < 8 && s.includes('\uE000'); k++) s = s.replace(/\uE000(\d+)\uE001/g, (_, n) => held[+n]);
    return s;
  }

  function links(s, hold, held) {
    let outS = '';
    let k = 0;
    while (k < s.length) {
      const img = s[k] === '!' && s[k + 1] === '[';
      if (s[k] !== '[' && !img) { outS += s[k++]; continue; }
      const open = img ? k + 1 : k;
      // the matching ]
      let depth = 0, end = -1;
      for (let j = open; j < s.length; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']' && --depth === 0) { end = j; break; }
      }
      if (end < 0) { outS += s[k++]; continue; }
      const label = s.slice(open + 1, end);
      let dest = null, title = '', after = end + 1;
      if (s[end + 1] === '(') {
        const r = destination(s, end + 2);
        if (r) { dest = r.href; title = r.title; after = r.end; }
      }
      if (dest === null) {
        let ref = label;
        if (s[end + 1] === '[') {
          const close = s.indexOf(']', end + 2);
          if (close > 0) { const r2 = s.slice(end + 2, close); if (r2.trim()) ref = r2; after = close + 1; }
        }
        const d = defs.get(norm(ref.replace(/\uE000\d+\uE001/g, '')));
        if (d) { dest = d.href; title = d.title; } else after = end + 1;
      }
      if (dest === null) { outS += s[k++]; continue; }
      const t = title ? ` title="${esc(title)}"` : '';
      if (img) {
        const src = image(dest);
        const alt = label.replace(/\uE000\d+\uE001/g, '');
        outS += src ? hold(`<img src="${esc(src)}" alt="${esc(alt)}"${t}>`) : hold(esc(alt));
      } else {
        const href = link(dest);
        const inner = inline(label, held);
        outS += href ? hold(`<a href="${esc(href)}"${t}>${inner}</a>`) : hold(inner);
      }
      k = after;
    }
    return outS;
  }
  /* (dest "title") from just after the "(": { href, title, end } or null. */
  function destination(s, k) {
    while (s[k] === ' ' || s[k] === '\n') k++;
    let href = '';
    if (s[k] === '<') {
      const close = s.indexOf('>', k);
      if (close < 0) return null;
      href = s.slice(k + 1, close);
      k = close + 1;
    } else {
      let depth = 0;
      while (k < s.length && !/[\s]/.test(s[k])) {
        if (s[k] === '(') depth++;
        else if (s[k] === ')') { if (depth === 0) break; depth--; }
        href += s[k++];
      }
    }
    while (s[k] === ' ' || s[k] === '\n') k++;
    let title = '';
    if (s[k] === '"' || s[k] === "'" || s[k] === '(') {
      const q = s[k] === '(' ? ')' : s[k];
      const close = s.indexOf(q, k + 1);
      if (close < 0) return null;
      title = s.slice(k + 1, close);
      k = close + 1;
      while (s[k] === ' ' || s[k] === '\n') k++;
    }
    if (s[k] !== ')') return null;
    return { href: href.replace(/\uE000(\d+)\uE001/g, ''), title, end: k + 1 };
  }

  /* ---------- blocks ---------- */
  function blocks(ls, tight) {
    const html = [];
    let i = 0;
    const para = (body) => html.push(tight ? inline(body) : `<p>${inline(body)}</p>`);
    while (i < ls.length) {
      const line = ls[i];
      if (line === '\u0000def' || isBlank(line)) { i++; continue; }
      let m;
      if ((m = FENCE.exec(line))) {
        const ind = m[1].length, fence = m[2], info = m[3].trim().split(/\s+/)[0];
        const body = [];
        i++;
        while (i < ls.length) {
          const c = FENCE.exec(ls[i]);
          if (c && c[2][0] === fence[0] && c[2].length >= fence.length && !c[3]) { i++; break; }
          body.push(dedent(ls[i], ind));
          i++;
        }
        html.push(`<pre><code${info ? ` data-lang="${esc(info)}"` : ''}>${esc(body.join('\n'))}${body.length ? '\n' : ''}</code></pre>`);
        continue;
      }
      if ((m = ATX.exec(line))) {
        const n = m[1].length, inner = inline(m[2] || '');
        html.push(`<h${n} id="${esc(slug(inner))}">${inner}</h${n}>`);
        i++;
        continue;
      }
      if (HR.test(line)) { html.push('<hr>'); i++; continue; }
      if (QUOTE.test(line)) {
        const inner = [];
        while (i < ls.length && !isBlank(ls[i])) {
          const q = /^ {0,3}> ?(.*)$/.exec(ls[i]);
          if (q) inner.push(q[1]);
          else if (inner.length && !interrupts(ls, i)) inner.push(ls[i]);
          else break;
          i++;
        }
        html.push(`<blockquote>${blocks(inner, false)}</blockquote>`);
        continue;
      }
      if (itemStart(line)) { i = list(ls, i, html); continue; }
      if (htmlBlockStart(line) || lonelyTag(line)) {
        const body = [];
        while (i < ls.length && !isBlank(ls[i])) body.push(ls[i++]);
        html.push(inline(body.join('\n')));
        continue;
      }
      if (tableStart(ls, i)) { i = table(ls, i, html); continue; }
      if (indentOf(line) >= 4) {
        const body = [];
        while (i < ls.length && (indentOf(ls[i]) >= 4 || isBlank(ls[i]))) body.push(dedent(ls[i++], 4));
        while (body.length && isBlank(body[body.length - 1])) body.pop();
        html.push(`<pre><code>${esc(body.join('\n'))}\n</code></pre>`);
        continue;
      }
      // a paragraph, or a setext heading; a line keeps its trailing spaces (two make a hard break) until the end
      const body = [line.replace(/^[ \t]+/, '')];
      i++;
      let setext = 0;
      while (i < ls.length && !isBlank(ls[i]) && ls[i] !== '\u0000def') {
        const st = SETEXT.exec(ls[i]);
        if (st) { setext = st[1][0] === '=' ? 1 : 2; i++; break; }
        if (interrupts(ls, i)) break;
        body.push(ls[i].replace(/^[ \t]+/, ''));
        i++;
      }
      const text = body.join('\n').replace(/[ \t]+$/, '');
      if (setext) {
        const inner = inline(text);
        html.push(`<h${setext} id="${esc(slug(inner))}">${inner}</h${setext}>`);
      } else {
        para(text);
      }
    }
    return html.join('\n');
  }

  function list(ls, i, html) {
    const first = itemStart(ls[i]);
    const items = [];
    let loose = false;
    while (i < ls.length) {
      const s = itemStart(ls[i]);
      if (!s || s.ordered !== first.ordered || s.marker !== first.marker) break;
      const body = [s.rest];
      i++;
      let blank = false;
      while (i < ls.length) {
        const l = ls[i];
        if (isBlank(l)) { body.push(''); blank = true; i++; continue; }
        if (indentOf(l) >= s.indent) { body.push(dedent(l, s.indent)); blank = false; i++; continue; }
        if (blank || itemStart(l) || interrupts(ls, i)) break;
        body.push(l.replace(/^[ \t]+/, ''));
        i++;
      }
      let trailing = 0;
      while (body.length && isBlank(body[body.length - 1])) { body.pop(); trailing++; }
      if (body.slice(0, -1).some((x, n) => isBlank(x) && !isBlank(body[n + 1] || ''))) loose = true;
      items.push(body);
      if (trailing && i < ls.length && itemStart(ls[i]) && itemStart(ls[i]).ordered === first.ordered && itemStart(ls[i]).marker === first.marker) loose = true;
    }
    const tag = first.ordered ? 'ol' : 'ul';
    const start = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
    html.push(`<${tag}${start}>`);
    for (const body of items) {
      const task = /^\[([ xX])\][ \t]+/.exec(body[0] || '');
      if (task) body[0] = body[0].slice(task[0].length);
      const inner = blocks(body, !loose);
      // A task's box goes at the start of its text: inside the first paragraph when the list is loose, as GitHub does.
      const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : '';
      html.push(task ? `<li class="task">${inner.startsWith('<p>') ? `<p>${box}${inner.slice(3)}` : box + inner}</li>` : `<li>${inner}</li>`);
    }
    html.push(`</${tag}>`);
    return i;
  }

  function table(ls, i, html) {
    const head = splitRow(ls[i]);
    const align = splitRow(ls[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''));
    const cell = (tag, c, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(c)}</${tag}>`;
    const rows = [`<thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead>`, '<tbody>'];
    i += 2;
    while (i < ls.length && !isBlank(ls[i]) && ls[i].includes('|') && !FENCE.test(ls[i]) && !ATX.test(ls[i])) {
      const cells = splitRow(ls[i]);
      rows.push(`<tr>${head.map((_, n) => cell('td', cells[n] || '', n)).join('')}</tr>`);
      i++;
    }
    rows.push('</tbody>');
    html.push(`<table>${rows.join('')}</table>`);
    return i;
  }

  out.push(blocks(lines, false));
  return out.join('\n');
}

module.exports = { render };




