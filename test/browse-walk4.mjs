// browse: the page primitive follows the page (owner, Nov 2 12:4x): a page's side note, its highlights, its clips and
// whether it is saved belong to the page shown, across links, back and forward, tabs, ⌘T, a terminal link and a
// quit. Real input on the Flow window; at each step the note, the highlights and the star must be that page's own.
// usage: test/browse-app.sh reset && test/browse-app.sh start && node test/browse-walk4.mjs <shots-dir>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const SHOTS = process.argv[2] || '/tmp/browse-walk4';
fs.mkdirSync(SHOTS, { recursive: true });
const APP = new URL('./browse-app.sh', import.meta.url).pathname;
let nos = 0;
const step = (name, ok, detail = '') => { if (!ok) nos++; console.log(`${ok ? 'ok  ' : 'NO  '} ${name}${detail ? `  (${detail})` : ''}`); };
let host, mainp;
async function connect() {
  host = await Cdp.connect((await waitFor(async () => (await targets(9571)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 40000, 'the Flow window')).webSocketDebuggerUrl);
  await waitFor(() => host.eval('return !!(window.__flow && window.__flow.ready);'), 40000, 'window.__flow');
  await host.eval('await window.__flow.ready; return true;');
  mainp = await Cdp.connect((await waitFor(async () => (await targets(9671))[0], 30000, 'the main inspector')).webSocketDebuggerUrl);
}
const shot = async (name) => { const r = await host.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64')); };
const ev = (p) => host.send('Input.dispatchMouseEvent', { pointerType: 'mouse', ...p });
async function click(x, y) {
  await ev({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await ev({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await ev({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function clickSel(sel) {
  const r = await host.eval(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 24), y: b.top + b.height / 2 };`);
  if (r) await click(r.x, r.y);
  return !!r;
}
const key = async (k, code, vk, text, modifiers = 0) => {
  await host.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text, modifiers });
  await host.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const menu = (label) => mainp.eval(`const { Menu, BrowserWindow } = require('electron'); const find = (m) => { for (const it of m.items) { if (it.label === ${JSON.stringify(label)} && it.visible !== false) return it; if (it.submenu) { const f = find(it.submenu); if (f) return f; } } return null; }; const w = BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL())); const it = find(Menu.getApplicationMenu()); if (!it) return false; it.click({}, w, w.webContents); return true;`, { commandLine: true });
const pageOf = (id) => `window.__flow.page(${JSON.stringify(id)})`;
const W = (id, sel = '') => `document.querySelector('.win[data-id="${id}"] ${sel}')`;
// what the window shows: its address, its side note (opened if closed), the star, and the shown page's highlights
async function shown(id) {
  const url = await host.eval(`return ${pageOf(id)}.getURL();`);
  const s = await host.eval(`const w = ${W(id)}; const n = w.querySelector('.anote'); const st = w.querySelector('.pstar'); return { noted: w.classList.contains('noted'), note: n ? n.innerText.trim() : null, star: st ? st.textContent : null };`);
  const t = (await targets(9571)).find((x) => x.type === 'webview' && x.url === url);
  let marks = null;
  if (t) { const g = await Cdp.connect(t.webSocketDebuggerUrl); marks = await g.eval(`await new Promise((r) => setTimeout(r, 1200)); const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0;`).catch(() => null); g.close(); }
  return { url: url.replace('https://', '').slice(0, 50), ...s, marks };
}
async function openNote(id) {
  if (!(await host.eval(`return ${W(id)}.classList.contains('noted');`))) { await clickSel(`.win[data-id="${id}"] [data-act="note"]`); await sleep(900); }
}
async function write(id, text) {
  await openNote(id);
  const at = await host.eval(`const e = ${W(id, '.anote [contenteditable]')}; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + 20, y: b.bottom - 8 };`);
  if (!at) return false;
  await click(at.x, at.y);
  await key('End', 'End', 35, undefined, 2);
  await host.send('Input.insertText', { text: `\n${text}` });
  await sleep(1500);
  return true;
}
async function guestOf(id) {
  const url = await host.eval(`return ${pageOf(id)}.getURL();`);
  const t = await waitFor(async () => (await targets(9571)).find((x) => x.type === 'webview' && x.url === url), 15000, url);
  return Cdp.connect(t.webSocketDebuggerUrl);
}
async function pressInPage(id, js) {
  const g = await guestOf(id);
  const r = await g.eval(js);
  const vw = await g.eval('return innerWidth;');
  g.close();
  if (!r) return null;
  const box = await host.eval(`const v = ${W(id, 'webview:not(.off)')}; const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width };`);
  const s = box.w / vw;
  await click(box.x + r.x * s, box.y + r.y * s);
  return r;
}
async function clip(id) {
  const g = await guestOf(id);
  const sel = await g.eval(`const p = ['#mw-content-text p', 'main p', 'p'].map((q) => [...document.querySelectorAll(q)].find((e) => e.textContent.trim().length > 120 && !e.closest('#siteNotice, .frb, [class*="banner"]'))).find(Boolean); if (!p) return null; p.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const t = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n; while ((n = t.nextNode()) && n.data.trim().length < 30); if (!n) return null; const i = n.data.search(/\\S/); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, Math.min(n.data.length, i + 40)); getSelection().removeAllRanges(); getSelection().addRange(r); return String(getSelection()).trim();`);
  g.close();
  const at = await waitFor(() => host.eval(`const c = ${W(id, '.pclip')}; if (!c || c.classList.contains('nosel') || c.classList.contains('off')) return null; const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`), 5000, 'the ✂').catch(() => null);
  if (at) await click(at.x, at.y);
  await sleep(1800);
  return sel;
}
const own = (s, mine, others) => !!s.note && mine.every((m) => s.note.includes(m)) && others.every((o) => !s.note.includes(o));
// an empty note is the page's own only when the panel is open and the page shown is the one expected
const empty = (s, re, others) => s.noted && s.note !== null && re.test(s.url) && others.every((o) => !s.note.includes(o));

await connect();
await host.eval(`window.__flow.go(window.__flow.state().ws.findIndex((w) => w.id === 'flow')); return true;`);

// 1. Page A: a note, a clip (its highlight), and saved.
const A = await host.eval(`return window.__flow.openPage('https://en.wikipedia.org/wiki/Web_browser');`);
await waitFor(() => host.eval(`const p = ${pageOf(A)}; return !!p && /Web_browser/.test(p.getURL()) && !p.isLoading();`), 30000, 'A').catch(() => null);
await sleep(2000);
await write(A, 'note A: why browsers');
const quoteA = await clip(A);
await menu('Save Page');
await sleep(1500);
let s = await shown(A);
await shot('1-page-A');
step('page A: its note, its clip, its highlight, saved', own(s, ['note A', String(quoteA).slice(0, 20)], []) && s.marks > 0 && s.star === '★', JSON.stringify(s));

// 2. A link in A to page B, in the same tab: B's own note (empty), no A highlight, not saved; B's note and clip are B's.
const linkB = await pressInPage(A, `const a = [...document.querySelectorAll('#mw-content-text p a[href*="/wiki/"]')].find((e) => { const m = e.getAttribute('href').match(/\\/wiki\\/([^#?]+)/); return m && !m[1].includes(':') && m[1] !== 'Web_browser' && e.getClientRects().length; }); if (!a) return null; a.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const b = a.getClientRects()[0]; return { x: b.left + b.width / 2, y: b.top + b.height / 2, href: a.getAttribute('href') };`);
await waitFor(() => host.eval(`const p = ${pageOf(A)}; return !!p && !/Web_browser/.test(p.getURL()) && !p.isLoading();`), 30000, 'B').catch(() => null);
await sleep(2000);
s = await shown(A);
await shot('2-page-B');
step(`a link in A (${linkB && linkB.href}) shows page B with B's own note, no highlight of A's, not saved`, !!linkB && empty(s, /wikipedia\.org\/wiki\/(?!Web_browser)/, ['note A', String(quoteA).slice(0, 20)]) && s.marks === 0 && s.star === '☆', JSON.stringify(s));
await write(A, 'note B: the linked page');
const quoteB = await clip(A);
s = await shown(A);
step("B's note and clip land in B's note", own(s, ['note B', String(quoteB).slice(0, 20)], ['note A']) && s.marks > 0, JSON.stringify(s));

// 3. Back to A, forward to B, with the window's ‹ and › buttons.
const btn = (label) => host.eval(`const b = [...${W(A)}.querySelectorAll('button')].find((e) => e.textContent.trim() === ${JSON.stringify(label)} && e.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
let b = await btn('‹');
if (b) await click(b.x, b.y);
await waitFor(() => host.eval(`const p = ${pageOf(A)}; return /Web_browser/.test(p.getURL()) && !p.isLoading();`), 20000, 'back to A').catch(() => null);
await sleep(2000);
s = await shown(A);
await shot('3-back-A');
step("back to A: A's note, A's highlight, saved", /Web_browser/.test(s.url) && own(s, ['note A'], ['note B']) && s.marks > 0 && s.star === '★', JSON.stringify(s));
b = await btn('›');
if (b) await click(b.x, b.y);
await waitFor(() => host.eval(`const p = ${pageOf(A)}; return !/Web_browser/.test(p.getURL()) && !p.isLoading();`), 20000, 'forward to B').catch(() => null);
await sleep(2000);
s = await shown(A);
await shot('3-forward-B');
step("forward to B: B's note and highlight, not saved", !/Web_browser/.test(s.url) && own(s, ['note B'], ['note A']) && s.marks > 0 && s.star === '☆', JSON.stringify(s));

// 4. ⌘T: a new tab C in the same window; C's own note; switching tabs brings each tab's own back.
await menu('New Page');
await sleep(1000);
await host.send('Input.insertText', { text: 'example.com/?walk4=tab' });
await key('Enter', 'Enter', 13, '\r');
await waitFor(() => host.eval(`const p = ${pageOf(A)}; return /walk4=tab/.test(p.getURL()) && !p.isLoading();`), 20000, 'tab C').catch(() => null);
await sleep(1500);
s = await shown(A);
step("⌘T: tab C shows C's own note, no highlight, not saved", empty(s, /walk4=tab/, ['note A', 'note B']) && s.marks === 0 && s.star === '☆', JSON.stringify(s));
await write(A, 'note C: the new tab');
const tab0 = await host.eval(`const t = ${W(A, '.ptab')}; if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
if (tab0) await click(tab0.x, tab0.y);
await sleep(2000);
s = await shown(A);
await shot('4-tab1');
step("switching to the first tab shows B's note again", own(s, ['note B'], ['note A', 'note C']), JSON.stringify(s));
const tab1 = await host.eval(`const t = [...${W(A)}.querySelectorAll('.ptab')][1]; if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
if (tab1) await click(tab1.x, tab1.y);
await sleep(2000);
s = await shown(A);
step("and back to tab C shows C's note", own(s, ['note C'], ['note A', 'note B']), JSON.stringify(s));

// 5. A page from a terminal link: D's own note.
const before = await host.eval(`return window.__flow.windows().map((w) => w.id);`);
await menu('New Shell');
const tid = await waitFor(async () => (await host.eval(`return window.__flow.windows().filter((w) => w.type === 'term').map((w) => w.id);`)).find((x) => !before.includes(x)), 15000, 'the shell').catch(() => null);
let D = null;
if (tid) {
  await sleep(2500);
  const sess = `flow_${tid}`;
  execFileSync('tmux', ['-L', 'flow-dev-browse', 'send-keys', '-t', sess, 'clear; echo https://example.org/walk4-term', 'Enter']);
  await sleep(1500);
  const rows = execFileSync('tmux', ['-L', 'flow-dev-browse', 'capture-pane', '-p', '-t', sess], { encoding: 'utf8' }).split('\n');
  const size = execFileSync('tmux', ['-L', 'flow-dev-browse', 'display', '-p', '-t', sess, '#{pane_width} #{pane_height}'], { encoding: 'utf8' }).trim().split(' ').map(Number);
  const scr = await host.eval(`const e = document.querySelector('.win[data-id="${tid}"] .xterm-screen'); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height };`);
  const r = rows.findIndex((l) => l.startsWith('https://example.org/walk4-term'));
  const pagesBefore = await host.eval(`return window.__flow.windows().filter((w) => w.type === 'page').map((w) => w.id);`);
  if (r >= 0) { const x = scr.x + 4.5 * (scr.w / size[0]), y = scr.y + (r + 0.5) * (scr.h / size[1]); await ev({ type: 'mouseMoved', x: x - 10, y, button: 'none', buttons: 0 }); await sleep(300); await ev({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 }); await sleep(400); await click(x, y); }
  await sleep(3000);
  D = (await host.eval(`return window.__flow.windows().filter((w) => w.type === 'page').map((w) => w.id);`)).find((x) => !pagesBefore.includes(x)) || null;
}
if (!D) step("a terminal link's page has its own note", false, 'no page opened from the terminal link');
else {
  await openNote(D);
  s = await shown(D);
  step("a terminal link's page shows its own note (empty), not saved", empty(s, /walk4-term/, ['note A', 'note B', 'note C']) && s.star === '☆', JSON.stringify(s));
  await write(D, 'note D: from the terminal');
}
await shot('5-terminal-page');

// 5b. A site that changes its address inside one document (GitHub's repo tabs): the note follows the address
const G = await host.eval(`return window.__flow.openPage('https://github.com/octocat/Hello-World');`);
await waitFor(() => host.eval(`const p = ${pageOf(G)}; return !!p && /Hello-World/.test(p.getURL()) && !p.isLoading();`), 30000, 'G').catch(() => null);
await sleep(3000);
await write(G, 'note G: the repo page');
// a clip from the repo page's own text (its README or its description), so it has a highlight of its own
const gq = await guestOf(G);
const quoteG = await gq.eval(`const t = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = t.nextNode()) && !(n.data.includes('My first repository') && n.parentElement && n.parentElement.getClientRects().length)); if (!n) return null; n.parentElement.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const i = n.data.indexOf('My first repository'); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 'My first repository'.length); getSelection().removeAllRanges(); getSelection().addRange(r); return String(getSelection()).trim();`);
gq.close();
const at = await waitFor(() => host.eval(`const c = ${W(G, '.pclip')}; if (!c || c.classList.contains('nosel') || c.classList.contains('off')) return null; const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`), 5000, 'the ✂').catch(() => null);
if (at) await click(at.x, at.y);
await sleep(1800);
s = await shown(G);
step('the repo page has its own note and its clip\'s highlight', own(s, ['note G', String(quoteG).slice(0, 12)], []) && s.marks > 0, `quote ${JSON.stringify(quoteG)}, ${JSON.stringify(s)}`);
const g0 = await guestOf(G);
await g0.eval(`window.__sameDoc = true; return true;`);
g0.close();
const link = await pressInPage(G, `const a = [...document.querySelectorAll('a')].find((e) => /\\/octocat\\/Hello-World\\/(issues|pulls)$/.test(e.getAttribute('href') || '') && e.getClientRects().length); if (!a) return null; a.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const b = a.getClientRects()[0]; return { x: b.left + b.width / 2, y: b.top + b.height / 2, href: a.getAttribute('href') };`);
await waitFor(() => host.eval(`const p = ${pageOf(G)}; return /\\/(issues|pulls)$/.test(p.getURL()) && !p.isLoading();`), 20000, 'the tab').catch(() => null);
await sleep(2500);
const g1 = await guestOf(G);
const same = await g1.eval('return window.__sameDoc === true;').catch(() => null);
g1.close();
s = await shown(G);
await shot('7-github-tab');
step(`a link to ${link && link.href} (${same ? 'the same document' : 'a new document'}) shows that page's own note, without the repo page's highlight`, !!link && empty(s, /\/(issues|pulls)$/, ['note G']) && s.marks === 0, JSON.stringify(s));
await write(G, 'note H: the issues page');
const back = await host.eval(`const b = [...${W(G)}.querySelectorAll('button')].find((e) => e.textContent.trim() === '‹' && e.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
if (back) await click(back.x, back.y);
await waitFor(() => host.eval(`const p = ${pageOf(G)}; return /Hello-World\\/?$/.test(p.getURL()) && !p.isLoading();`), 20000, 'back').catch(() => null);
await sleep(2500);
s = await shown(G);
step('back to the repo page shows its note and highlight again, not the other page\'s', own(s, ['note G'], ['note H']) && s.marks > 0, JSON.stringify(s));

// 6. Quit and restore: every window's shown page comes back with its own note; A's highlight comes back on A.
host.close(); mainp.close();
execFileSync(APP, ['stop'], { stdio: 'inherit' });
execFileSync(APP, ['start', '/tmp/flow-dev-browse.log'], { stdio: 'inherit' });
await connect();
await sleep(4000);
const ptab = async (i) => { const t = await host.eval(`const t = [...${W(A)}.querySelectorAll('.ptab')][${i}]; if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`); if (t) { await click(t.x, t.y); await sleep(3000); } return !!t; };
await clickSel(`[data-act="tab|${A}|0"]`);
await sleep(2000);
await ptab(1);
s = await shown(A);
step("after a quit, tab C shows C's note", own(s, ['note C'], ['note A', 'note B']), JSON.stringify(s));
await ptab(0);
s = await shown(A);
step("after a quit, the first tab (B) shows B's note and highlight", own(s, ['note B'], ['note A', 'note C']) && s.marks > 0, JSON.stringify(s));
b = await btn('‹');
if (b) await click(b.x, b.y);
await waitFor(() => host.eval(`const p = ${pageOf(A)}; return /Web_browser/.test(p.getURL()) && !p.isLoading();`), 20000, 'back to A').catch(() => null);
await sleep(2000);
s = await shown(A);
await shot('6-restored-A');
step("after a quit, back to A shows A's note, highlight and star", own(s, ['note A'], ['note B', 'note C']) && s.marks > 0 && s.star === '★', JSON.stringify(s));
if (D) {
  await clickSel(`[data-act="tab|${D}|0"]`);
  await sleep(3000);
  s = await shown(D);
  step("after a quit, the terminal link's page shows its own note", own(s, ['note D'], ['note A', 'note B', 'note C']), JSON.stringify(s));
}
host.close(); mainp.close();
console.log(nos ? `${nos} NO` : 'all ok');
process.exitCode = nos ? 1 : 0;




