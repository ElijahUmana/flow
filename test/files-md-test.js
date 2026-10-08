'use strict';
// markdown.js on its own: what each construct renders to, that nothing in a file can run, and how long real files take.
//   node test/files-md-test.js            (FILES_MD=<path> tests another copy of markdown.js)
const fs = require('fs');
const path = require('path');
const md = require(process.env.FILES_MD || path.join(__dirname, '..', 'src', 'markdown.js'));

let failed = 0;
// Only true passes: has() returns the rendered HTML instead when a part is missing, and that is shown.
const check = (name, cond, detail) => {
  const ok = cond === true;
  const shown = detail !== undefined ? detail : typeof cond === 'string' ? cond : undefined;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || shown === undefined ? '' : `\n     ${typeof shown === 'string' ? shown : JSON.stringify(shown)}`}`);
  if (!ok) failed++;
};
// Links: web addresses and anchors pass, relative paths become "file:<path>", other schemes are refused.
const opts = {
  link: (h) => (/^(https?|mailto):/i.test(h) || h.startsWith('#') ? h : /^[a-z][a-z0-9+.-]*:/i.test(h) ? null : `file:${h}`),
  image: (s) => (/^https:/i.test(s) ? s : /^[a-z][a-z0-9+.-]*:/i.test(s) ? null : `file:${s}`),
};
const r = (s) => md.render(s, opts);
const has = (s, ...parts) => { const h = r(s); return parts.every((p) => h.includes(p)) ? true : h; };

// ---- blocks ----
check('atx headings with GitHub anchors, duplicates numbered', has('# Hello, World!\n## Hello, World!', '<h1 id="hello-world">Hello, World!</h1>', '<h2 id="hello-world-1">'));
check('setext headings', has('Title\n=====\n\nSub\n---', '<h1 id="title">Title</h1>', '<h2 id="sub">Sub</h2>'));
check('paragraphs and soft breaks', has('one\ntwo\n\nthree', '<p>one\ntwo</p>', '<p>three</p>'));
check('hard breaks', has('a  \nb\\\nc', 'a<br>\nb<br>\nc'));
check('a hard break after the first line of a list item or a quote', has('- item  \n  next\n\n> quoted  \n> next', '<li>item<br>\nnext</li>', '<p>quoted<br>\nnext</p>'));
check('thematic break', has('a\n\n***\n\nb', '<hr>'));
check('fenced code keeps its text and names its language', has('```js\nconst a = 1 < 2 && **x**;\n```', '<pre><code data-lang="js">const a = 1 &lt; 2 &amp;&amp; **x**;\n</code></pre>'));
check('tilde fences and longer closing fences', has('~~~\n```\ninside\n```\n~~~~', '<pre><code>```\ninside\n```\n</code></pre>'));
check('indented code', has('para\n\n    code line\n      more', '<pre><code>code line\n  more\n</code></pre>'));
check('block quotes, nested blocks inside', has('> quoted *text*\n> - item', '<blockquote><p>quoted <em>text</em></p>\n<ul>\n<li>item</li>\n</ul></blockquote>'));
check('tight bullet list', has('- a\n- b', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'));
check('loose list wraps paragraphs', has('- a\n\n- b', '<li><p>a</p></li>'));
check('ordered list with its start', has('3. c\n4. d', '<ol start="3">', '<li>c</li>'));
check('nested lists', has('- a\n  - b\n    - c', '<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>'));
check('task items are read-only checkboxes', has('- [ ] todo\n- [x] done', '<li class="task"><input type="checkbox" disabled> todo</li>', '<input type="checkbox" disabled checked> done'));
check('in a loose list a task box goes inside its first paragraph, on the text\'s line', has('- [ ] a\n\n- [x] b\n  more\n\n  next', '<li class="task"><p><input type="checkbox" disabled> a</p></li>', '<li class="task"><p><input type="checkbox" disabled checked> b\nmore</p>\n<p>next</p></li>'));
check('tables with alignment and escaped pipes', has('| a | b | c |\n|:--|:-:|--:|\n| 1 | x \\| y | `|` |', '<th style="text-align:left">a</th>', '<td style="text-align:center">x | y</td>', '<td style="text-align:right"><code>|</code></td>'));
check('front matter shows as code', has('---\ntitle: x\n---\n# H', '<pre class="fm"><code>title: x\n</code></pre>', '<h1 id="h">H</h1>'));

// ---- inlines ----
check('emphasis, strong, strikethrough', has('*a* _b_ **c** __d__ ~~e~~', '<em>a</em>', '<em>b</em>', '<strong>c</strong>', '<strong>d</strong>', '<del>e</del>'));
check('snake_case words stay as they are; * inside a word is emphasis, as in CommonMark (its example 5*6*78)', has('my_var_name and 5*6*78', 'my_var_name', '5<em>6</em>78'));
check('code spans keep their text', has('`<b>*x*</b>` and ``a`b``', '<code>&lt;b&gt;*x*&lt;/b&gt;</code>', '<code>a`b</code>'));
check('backslash escapes', has('\\*not em\\* \\# \\[x\\]', '*not em* # [x]'));
check('links with titles, and code in their text', has('[a `b` c](https://x.org "T")', '<a href="https://x.org" title="T">a <code>b</code> c</a>'));
check('reference links', has('[go][r] and [r]\n\n[r]: https://r.org "R"', '<a href="https://r.org" title="R">go</a>', '<a href="https://r.org" title="R">r</a>'));
check('autolinks and bare addresses', has('<https://a.org> and https://b.org/x. and www.c.org', '<a href="https://a.org">https://a.org</a>', '<a href="https://b.org/x">https://b.org/x</a>.', '<a href="https://www.c.org">www.c.org</a>'));
check('relative links go through the link rule', has('[plan](./PLAN.md#next)', '<a href="file:./PLAN.md#next">plan</a>'));
check('anchors stay in the page', has('[top](#hello)', '<a href="#hello">top</a>'));
check('images, relative and https', has('![shot](shots/a.png) ![b](https://b.org/b.png)', '<img src="file:shots/a.png" alt="shot">', '<img src="https://b.org/b.png" alt="b">'));

// ---- HTML: the inert allow-list renders, everything else is text, nothing runs ----
check('allowed inline tags render', has('a<br>b <kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup> <b>B</b> <i>I</i>', 'a<br>b', '<kbd>Ctrl</kbd>', '<sub>2</sub>', '<sup>2</sup>', '<b>B</b>', '<i>I</i>'));
check('details and summary around markdown', has('<details>\n<summary>More</summary>\n\nhidden **text**\n\n</details>', '<details>\n<summary>More</summary>', '<p>hidden <strong>text</strong></p>', '</details>'));
check('img keeps only src, alt, width, height', has('<img src="logo.png" alt="L" width="200" style="x" onerror="alert(1)">', '<img src="file:logo.png" alt="L" width="200">'));
check('a keeps only an allowed href', has('<a href="https://x.org" onclick="alert(1)">x</a>', '<a href="https://x.org">x</a>'));
check('p align is dropped, the paragraph stays', has('<p align="center">\n<img src="https://x.org/l.png">\n</p>', '<p>', '<img src="https://x.org/l.png">'));
check('prose placeholders show as text', has('ssh <host> as <user>, see <path>', 'ssh &lt;host&gt; as &lt;user&gt;, see &lt;path&gt;'));
check('comments disappear', has('a <!-- hidden --> b\n\n<!-- TOC -->', '<p>a  b</p>'));
const evil = r([
  '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe src="https://x.org">',
  '[x](javascript:alert(1))', '[y](JAVASCRIPT:alert(1))', '![z](javascript:alert(1))', '<a href="javascript:alert(1)">j</a>',
  '<a href="data:text/html,<script>alert(1)</script>">d</a>', '<img src="data:x" alt="q">', '<style>body{display:none}</style>',
  '<div onmouseover="alert(1)">d</div>', '<details open ontoggle=alert(1)><summary>s</summary></details>', '[l](https://x.org" onmouseover="alert(1))',
  '<img src="https://x.org/a.png" alt="a" onerror="alert(1)" width="10" height="x">', '<a href=https://x.org onclick=alert(1)>u</a>',
].join('\n\n'));
const tagsLeft = [...evil.matchAll(/<([a-z0-9]+)([^>]*)>/gi)].map((m) => `<${m[1]}${m[2]}>`);
check('no script, style, svg, iframe or div survives', !/<(script|style|svg|iframe|div)\b/i.test(evil), tagsLeft);
check('no event handler, javascript: or data: survives', !/\son[a-z]+\s*=/i.test(evil.replace(/&[a-z]+;/g, '')) || !tagsLeft.some((t) => /\son[a-z]+=/i.test(t)), tagsLeft);
check('no tag keeps an attribute outside the allow-list', tagsLeft.every((t) => !/\s(?!href=|src=|alt=|width=|height=|title=|class="task"|type="checkbox"|disabled|checked|id=|data-lang=|start=|style="text-align)[a-z-]+[=\s>]/i.test(t.replace(/^<\w+/, ''))), tagsLeft);
check('no href or src outside the link rules', ![...evil.matchAll(/(?:href|src)="([^"]*)"/g)].some((m) => /^(javascript|data):/i.test(m[1])), [...evil.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]));
check('an unclosed b or em does not run into the next block', has('<b>bold\n\nnext', '<p><b>bold</b></p>', '<p>next</p>'));

// ---- real files: they render without throwing, and fast ----
// STATUS.md keeps growing, so its timing uses a fixed copy of it at the 263 KB this limit was set for.
const real = [path.join(__dirname, 'files-md-fixture-status.md'), ...['OWNER_ASKS.md', 'BRIEF.md', 'MAC_NOTES.md'].map((f) => path.join(__dirname, '..', f)).filter((f) => fs.existsSync(f))];
for (const f of real) {
  const src = fs.readFileSync(f, 'utf8');
  const t0 = process.hrtime.bigint();
  let html = '';
  for (let k = 0; k < 5; k++) html = md.render(src, opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  check(`${path.basename(f)} (${(src.length / 1024).toFixed(0)} KB) renders in ${ms.toFixed(1)} ms`, html.length > src.length / 2 && ms < 200, { ms, html: html.length });
}
const big = fs.readFileSync(path.join(__dirname, '..', 'STATUS.md'), 'utf8').repeat(Math.ceil((2 * 1024 * 1024) / fs.statSync(path.join(__dirname, '..', 'STATUS.md')).size));
const t1 = process.hrtime.bigint();
md.render(big, opts);
const bigMs = Number(process.hrtime.bigint() - t1) / 1e6;
check(`2 MB of real markdown renders in ${bigMs.toFixed(0)} ms`, bigMs < 2000, bigMs);
const stars = '*'.repeat(5000) + ' _'.repeat(5000) + '[' .repeat(3000);
const t2 = process.hrtime.bigint();
md.render(stars, opts);
const starMs = Number(process.hrtime.bigint() - t2) / 1e6;
check(`a line of 13000 unmatched markers renders in ${starMs.toFixed(0)} ms`, starMs < 1000, starMs);

console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);




