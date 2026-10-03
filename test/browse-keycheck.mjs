// browse: usage: node test/browse-keycheck.mjs <path to notes.js> (default src/notes.js)
// Loads notes' held notes.js in a sandbox with a stub window and checks FlowNotes.key on the addresses real sites
// landed on in browse's Flow runs (pagekey.txt), plus collision cases. Reads the file; changes nothing.
import fs from 'node:fs';
import vm from 'node:vm';
const file = process.argv[2] || new URL('../src/notes.js', import.meta.url).pathname;
const src = fs.readFileSync(file, 'utf8');
const win = {};
const ctx = vm.createContext({ window: win, document: { addEventListener() {}, fonts: null }, URL, console, CSS: { highlights: new Map() }, Highlight: class {}, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 0, setTimeout, clearTimeout, navigator: {} });
vm.runInContext(src, ctx, { filename: 'notes.js' });
const key = win.FlowNotes.key;
const SAME = [
  ['Wikipedia', ['https://en.wikipedia.org/wiki/Web_browser', 'https://en.wikipedia.org/wiki/Web_browser#History', 'https://en.wikipedia.org/w/index.php?title=Web_browser', 'https://en.m.wikipedia.org/wiki/Web_browser']],
  ['Wikipedia escapes', ['https://en.wikipedia.org/wiki/Electron_(software_framework)', 'https://en.wikipedia.org/wiki/Electron_%28software_framework%29']],
  ['YouTube', ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=10s', 'https://www.youtube.com/watch?app=desktop&v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw?si=x', 'https://www.youtube.com/shorts/jNQXAC9IVRw']],
  ['X', ['https://x.com/jack/status/20', 'https://x.com/jack/status/20?s=20', 'https://twitter.com/jack/status/20']],
  ['Notion (landed)', ['https://app.notion.com/p/f675abdb2a9b4ddd98eb09e2d576f669?__dm_a=1', 'https://app.notion.com/p/Voiceless-Full-System-Design-f675abdb2a9b4ddd98eb09e2d576f669?__dm_a=1', 'https://app.notion.com/p/f675abdb2a9b4ddd98eb09e2d576f669?pvs=4&__dm_a=1', 'https://www.notion.so/f675abdb2a9b4ddd98eb09e2d576f669']],
  ['Medium', ['https://karpathy.medium.com/software-2-0-a64152b37c35', 'https://medium.com/@karpathy/software-2-0-a64152b37c35?source=rss----------------------', 'https://medium.com/p/a64152b37c35']],
  ['GitHub repo', ['https://github.com/torvalds/linux', 'https://github.com/Torvalds/Linux', 'https://github.com/torvalds/linux/']],
  ['Guardian', ['https://www.theguardian.com/technology/artificialintelligenceai', 'https://www.theguardian.com/technology/artificialintelligenceai?CMP=share_btn_url', 'https://www.theguardian.com/technology/artificialintelligenceai?ref=hn']],
  ['Google Docs', ['https://docs.google.com/document/d/1AbC/edit', 'https://docs.google.com/document/d/1AbC/view', 'https://docs.google.com/document/u/1/d/1AbC/edit', 'https://docs.google.com/document/d/1AbC/edit#heading=h.x', 'https://docs.google.com/document/d/1AbC/edit?usp=sharing']],
];
const DIFFERENT = [
  ['GitHub file views', ['https://github.com/microsoft/vscode/blob/main/README.md', 'https://github.com/microsoft/vscode/blob/main/README.md?plain=1', 'https://github.com/microsoft/vscode/tree/main/src']],
  ['GitHub file name case', ['https://github.com/o/r/blob/main/README.md', 'https://github.com/o/r/blob/main/readme.md']],
  ['Gmail threads', ['https://mail.google.com/mail/u/0/#inbox/FMfcgzAAA', 'https://mail.google.com/mail/u/0/#inbox/FMfcgzBBB']],
  ['YouTube pages without v', ['https://www.youtube.com/playlist?list=PL1', 'https://www.youtube.com/playlist?list=PL2', 'https://www.youtube.com/@mkbhd', 'https://www.youtube.com/results?search_query=flow']],
  ['YouTube videos', ['https://www.youtube.com/watch?v=AAAAAAAAAAA', 'https://www.youtube.com/watch?v=BBBBBBBBBBB']],
  ['Medium articles', ['https://medium.com/@a/one-0123456789ab', 'https://medium.com/@a/two-ba9876543210']],
  ['Medium non-articles', ['https://medium.com/@karpathy', 'https://medium.com/tag/ai']],
  ['Notion pages', ['https://www.notion.so/a-0123456789abcdef0123456789abcdef', 'https://www.notion.so/a-fedcba9876543210fedcba9876543210']],
  ['Wikipedia languages', ['https://en.wikipedia.org/wiki/Paris', 'https://fr.wikipedia.org/wiki/Paris']],
  ['Docs products', ['https://docs.google.com/document/d/1AbC/edit', 'https://docs.google.com/spreadsheets/d/1XyZ/edit']],
  ['Google searches', ['https://www.google.com/search?q=flow', 'https://www.google.com/search?q=notes']],
  ['Hash-routed app (not Gmail)', ['https://app.example.com/#/projects/1', 'https://app.example.com/#/projects/2']],
  ['Teams conversations', ['https://teams.microsoft.com/_#/conversations/19:aaa@thread.v2', 'https://teams.microsoft.com/_#/conversations/19:bbb@thread.v2']],
  ['Excalidraw drawings', ['https://excalidraw.com/#json=AAA,key1', 'https://excalidraw.com/#json=BBB,key2', 'https://excalidraw.com/#room=CCC,key3']],
];
// Files opened as pages (flow-file:): one file is one page whatever signature its address carries; Mac and VM differ.
SAME.push(['File page, two signatures', ['flow-file://mac/gO4pzk0dTdOBHJhoi3-pCY/home/claude/flow/BRIEF.md', 'flow-file://mac/YLnn_ZegL2XIBpXF17jPPz/home/claude/flow/BRIEF.md']]);
SAME.push(['File page, escapes', ['flow-file://mac/gO4pzk0dTdOBHJhoi3-pCY/home/claude/My%20Notes/a.md', 'flow-file://mac/YLnn_ZegL2XIBpXF17jPPz/home/claude/My%20Notes/a.md']]);
DIFFERENT.push(['File pages, different files', ['flow-file://mac/gO4pzk0dTdOBHJhoi3-pCY/home/claude/flow/BRIEF.md', 'flow-file://mac/gO4pzk0dTdOBHJhoi3-pCY/home/claude/flow/STATUS.md']]);
DIFFERENT.push(['File pages, Mac and VM', ['flow-file://mac/gO4pzk0dTdOBHJhoi3-pCY/home/claude/flow/BRIEF.md', 'flow-file://vm/pXJCou4mOzt5jQ0OohWIov/claude-agents/home/claude/flow/BRIEF.md']]);
// Anchors and sentence links on route-keeping hosts must still be one page.
SAME.push(['Gmail thread with a sentence link', ['https://mail.google.com/mail/u/0/#inbox/FMfcgzAAA', 'https://mail.google.com/mail/u/0/#inbox/FMfcgzAAA:~:text=hello']]);
SAME.push(['Anchor on an ordinary page', ['https://example.com/docs/page', 'https://example.com/docs/page#section-2', 'https://example.com/docs/page#:~:text=word']]);
let bad = 0;
for (const [name, urls] of SAME) {
  const keys = urls.map(key);
  // one key, and a real one: an empty key means the page has no record at all
  const ok = new Set(keys).size === 1 && !!keys[0];
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'MISS'} same page, ${name}${ok ? `: ${keys[0]}` : `:\n  ${urls.map((u, i) => `${u}\n    -> ${keys[i]}`).join('\n  ')}`}`);
}
for (const [name, urls] of DIFFERENT) {
  const keys = urls.map(key);
  const ok = new Set(keys).size === keys.length && keys.every(Boolean);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'SAME'} different pages, ${name}${ok ? '' : `:\n  ${urls.map((u, i) => `${u}\n    -> ${keys[i]}`).join('\n  ')}`}`);
}
console.log(bad ? `${bad} problems` : 'all ok');
process.exitCode = bad ? 1 : 0;




