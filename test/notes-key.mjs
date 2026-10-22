// notes' check of the page key (FlowNotes.key in src/notes.js): every way of writing one page gives one key, and
// different pages give different keys. Cases from browse's run on real sites (test/browse-pagekey.mjs) and the design.
//   node test/notes-key.mjs [path/to/notes.js]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const file = process.argv[2] || path.join(HERE, '..', 'src', 'notes.js');
const sandbox = { URL, console, encodeURIComponent, decodeURIComponent };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
const key = sandbox.FlowNotes.key;
let bad = 0, n = 0;
const same = (label, urls) => {
  n++;
  const keys = urls.map(key);
  const ok = keys.every((k) => k && k === keys[0]);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} one page: ${label}${ok ? ` (${keys[0]})` : `\n      ${urls.map((u, i) => `${u} -> ${keys[i]}`).join('\n      ')}`}`);
};
const differ = (label, urls) => {
  n++;
  const keys = urls.map(key);
  const ok = keys.every((k) => k) && new Set(keys).size === keys.length;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} different pages: ${label}${ok ? '' : `\n      ${urls.map((u, i) => `${u} -> ${keys[i]}`).join('\n      ')}`}`);
};

same('http/https, www, trailing slash, fragment, text fragment, tracking keys, query order', [
  'https://www.alphaxiv.org/abs/2610.09043', 'http://alphaxiv.org/abs/2610.09043/', 'https://alphaxiv.org/abs/2610.09043#comments',
  'https://alphaxiv.org/abs/2610.09043#:~:text=human%20review', 'https://alphaxiv.org/abs/2610.09043?utm_source=x&utm_medium=y&fbclid=z',
]);
same('query order', ['https://example.com/s?b=2&a=1', 'https://example.com/s?a=1&b=2']);
same('Notion: id, slug, app.notion.com, ?pvs, ?__dm_a', [
  'https://www.notion.so/f675abdb2a9b4ddd98eb09e2d576f669', 'https://app.notion.com/p/f675abdb2a9b4ddd98eb09e2d576f669?__dm_a=1',
  'https://www.notion.so/Voiceless-Full-System-Design-f675abdb2a9b4ddd98eb09e2d576f669?pvs=4', 'https://app.notion.com/p/Voiceless-Full-System-Design-f675abdb2a9b4ddd98eb09e2d576f669',
  'https://someone.notion.site/Renamed-Page-f675abdb2a9b4ddd98eb09e2d576f669',
]);
same('YouTube: watch, youtu.be, ?si, &t, /shorts, m., app=desktop, feature', [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
  'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
]);
same('Medium: @user path, user.medium.com, /p/id, ?source', [
  'https://medium.com/@karpathy/software-2-0-a64152b37c35', 'https://karpathy.medium.com/software-2-0-a64152b37c35?source=rss----1',
  'https://medium.com/p/a64152b37c35',
]);
same('Wikipedia: en.m., #section, index.php?title=, escapes', [
  'https://en.wikipedia.org/wiki/Electron_(software_framework)', 'https://en.m.wikipedia.org/wiki/Electron_(software_framework)#History',
  'https://en.wikipedia.org/wiki/Electron_%28software_framework%29', 'https://en.wikipedia.org/w/index.php?title=Electron_(software_framework)',
]);
same('GitHub: owner and repo in any case', ['https://github.com/Torvalds/Linux', 'https://github.com/torvalds/linux']);
same('X: twitter.com, ?s=20, &t=', ['https://twitter.com/karpathy/status/1', 'https://x.com/karpathy/status/1?s=20&t=abc']);
same('Guardian: ?CMP=, ?ref=', ['https://www.theguardian.com/world/2026/nov/01/story', 'https://www.theguardian.com/world/2026/nov/01/story?CMP=share_btn_url', 'https://www.theguardian.com/world/2026/nov/01/story?ref=x']);
same('Google Docs: /edit, /view, /u/1/, #heading', [
  'https://docs.google.com/document/d/1AbC_dEf/edit', 'https://docs.google.com/document/d/1AbC_dEf/view', 'https://docs.google.com/document/u/1/d/1AbC_dEf/edit#heading=h.x',
]);
differ('hash routes: an app at #/… and #!…', ['https://app.example.com/#/projects/1', 'https://app.example.com/#/projects/2', 'https://app.example.com/#!/inbox']);
differ('Teams web conversations', ['https://teams.microsoft.com/_#/conversations/19:aa', 'https://teams.microsoft.com/_#/conversations/19:bb']);
differ('Excalidraw drawings (the drawing is in the fragment)', ['https://excalidraw.com/#json=aaa,111', 'https://excalidraw.com/#json=bbb,222', 'https://excalidraw.com/#room=ccc,333']);
same('an anchor in a page is the same page', ['https://example.com/guide#install', 'https://example.com/guide', 'https://example.com/guide#:~:text=install']);
differ('Gmail threads (the thread is in the fragment)', ['https://mail.google.com/mail/u/0/#inbox/FMfcgzQ1', 'https://mail.google.com/mail/u/0/#inbox/FMfcgzQ2']);
differ('different YouTube videos', ['https://www.youtube.com/watch?v=aaaaaaaaaaa', 'https://www.youtube.com/watch?v=bbbbbbbbbbb']);
differ('GitHub blob, tree and ?plain=1', ['https://github.com/torvalds/linux/blob/master/README', 'https://github.com/torvalds/linux/tree/master', 'https://github.com/torvalds/linux/blob/master/README?plain=1']);
differ('searches with different words', ['https://www.google.com/search?q=flow', 'https://www.google.com/search?q=notes']);
differ('Wikipedia pages in two languages', ['https://en.wikipedia.org/wiki/Hyperlink', 'https://de.wikipedia.org/wiki/Hyperlink']);
differ('two Notion pages', ['https://www.notion.so/f675abdb2a9b4ddd98eb09e2d576f669', 'https://www.notion.so/a675abdb2a9b4ddd98eb09e2d576f669']);
same('a file shown as a page: the signature in its address does not matter', [
  'flow-file://mac/AbCdEfGhIjKlMnOpQrStUv/home/claude/flow/BRIEF.md', 'flow-file://mac/ZyXwVuTsRqPoNmLkJiHgFe/home/claude/flow/BRIEF.md',
  'flow-file://mac/AbCdEfGhIjKlMnOpQrStUv/home/claude/flow/BRIEF.md#install',
]);
same('a file with a space in its name, escaped either way', ['flow-file://mac/AbCdEfGhIjKlMnOpQrStUv/home/claude/my%20notes.txt', 'flow-file://mac/ZyXwVuTsRqPoNmLkJiHgFe/home/claude/my notes.txt']);
same('a file on the VM', ['flow-file://vm/AbCdEfGhIjKlMnOpQrStUv/claude-agents/home/claude/flow/BRIEF.md', 'flow-file://vm/ZyXwVuTsRqPoNmLkJiHgFe/claude-agents/home/claude/flow/BRIEF.md']);
differ('files: two paths, the Mac and the VM, two VM hosts', [
  'flow-file://mac/AbCdEfGhIjKlMnOpQrStUv/home/claude/flow/BRIEF.md', 'flow-file://mac/AbCdEfGhIjKlMnOpQrStUv/home/claude/flow/STATUS.md',
  'flow-file://vm/AbCdEfGhIjKlMnOpQrStUv/claude-agents/home/claude/flow/BRIEF.md', 'flow-file://vm/AbCdEfGhIjKlMnOpQrStUv/other-box/home/claude/flow/BRIEF.md',
]);
n++;
const none = ['', 'about:blank', 'mailto:a@b.c', 'not a url', 'file:///tmp/x.html'].filter((u) => key(u) !== '');
if (none.length) bad++;
console.log(`${none.length ? 'FAIL' : 'ok  '} addresses that are not web pages have no key${none.length ? ` (${none.join(', ')})` : ''}`);
console.log(`\n${n - bad}/${n} passed`);
process.exitCode = bad ? 1 : 0;




