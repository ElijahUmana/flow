// browse: walks the browser in browse's Flow copy the way the owner uses it, with real input on the Flow window
// (menu items are clicked through main, as their accelerators do). Prints one line per step and saves screenshots.
// usage: test/browse-app.sh reset && test/browse-app.sh start && node test/browse-walk.mjs <shots-dir>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const SHOTS = process.argv[2] || '/tmp/browse-walk';
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
const shot = async (name) => {
  const r = await host.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
};
const ev = (p) => host.send('Input.dispatchMouseEvent', { pointerType: 'mouse', ...p });
async function click(x, y, modifiers = 0, clickCount = 1) {
  await ev({ type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers });
  await ev({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount, modifiers });
  await ev({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount, modifiers });
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
const typeAndEnter = async (text) => { await host.send('Input.insertText', { text }); await key('Enter', 'Enter', 13, '\r'); };
const menu = (label) => mainp.eval(`const { Menu, BrowserWindow } = require('electron'); const find = (m) => { for (const it of m.items) { if (it.label === ${JSON.stringify(label)} && it.visible !== false) return it; if (it.submenu) { const f = find(it.submenu); if (f) return f; } } return null; }; const w = BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL())); const it = find(Menu.getApplicationMenu()); if (!it) return false; it.click({}, w, w.webContents); return true;`, { commandLine: true });
const front = () => host.eval(`const ws = window.__flow.state().ws; const f = document.querySelector('.ws.on .win.front, .win.front'); return f ? f.dataset.id : null;`);
const pageOf = (id) => `window.__flow.page(${JSON.stringify(id)})`;
const tabsOf = (id) => host.eval(`const p = ${pageOf(id)}; return p ? p.tabs() : null;`);
const pageWindows = () => host.eval(`return window.__flow.windows().filter((w) => w.type === 'page').map((w) => w.id);`);
const waitLoaded = (id, re, ms = 30000) => waitFor(() => host.eval(`const p = ${pageOf(id)}; return !!p && ${re}.test(p.getURL()) && !p.isLoading();`), ms, `${id} to load ${re}`);

await connect();

// 1. A new page from the dock while a note is in front: a page window with the address ready; typing loads.
{
  await host.eval(`window.__flow.go(window.__flow.state().ws.findIndex((w) => w.id === 'flow')); return true;`);
  const before = await pageWindows();
  const dock = await host.eval(`const b = document.querySelector('#dock button[data-k="page"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.textContent.trim() };`);
  if (dock) { await ev({ type: 'mouseMoved', x: dock.x, y: dock.y + 2, button: 'none', buttons: 0 }); await sleep(600); await click(dock.x, dock.y); }
  else await menu('New Page');
  await sleep(1200);
  const after = await pageWindows();
  const id = after.find((x) => !before.includes(x));
  const focus = await host.eval('const a = document.activeElement; return a ? a.className : null;');
  await typeAndEnter('en.wikipedia.org/wiki/Web_browser');
  const loaded = id ? await waitLoaded(id, /Web_browser/).then(() => true, () => false) : false;
  await shot('01-new-page');
  step('dock page button: a new page window, address ready, typing loads', !!id && /ad/.test(String(focus)) && loaded, `${dock ? `dock "${dock.title}"` : 'no dock button found, used File > New Page'}, new window ${id}, focus ${focus}`);
  globalThis.P1 = id;
}

// 2. ⌘T with that page in front adds a tab; ⌘W closes only that tab.
{
  const id = globalThis.P1;
  await menu('New Page');
  await sleep(1000);
  const t1 = await tabsOf(id);
  await typeAndEnter('example.com/?walk=tab2');
  await waitLoaded(id, /walk=tab2/).catch(() => null);
  const t2 = await tabsOf(id);
  await shot('02-cmd-t');
  step('⌘T on a page adds a tab and types into it', t1 && t2 && t2.tabs.length === 2 && t2.tab === 1, `tabs ${JSON.stringify(t2 && t2.tabs.map((t) => t.url))}`);
  await menu('Close Window');
  await sleep(1000);
  const t3 = await tabsOf(id);
  const stillOpen = (await pageWindows()).includes(id);
  step('⌘W closes only the shown tab', stillOpen && t3 && t3.tabs.length === 1, `window open ${stillOpen}, tabs ${t3 && t3.tabs.length}`);
}

// 3. A link that opens a new tab in the page (window.open without features), and a sign-in popup (with features).
{
  // both open from a real click on a button in the page, as the owner's click does: a page opens nothing on its own
  const id = globalThis.P1;
  const wikiTab = async () => {
    const i = (await tabsOf(id)).tabs.findIndex((x) => /Web_browser/.test(x.url));
    await host.eval(`${pageOf(id)}.selectTab(${i}); return true;`);
    await sleep(1200);
    const g = await Cdp.connect((await waitFor(async () => (await targets(9571)).find((t) => t.type === 'webview' && t.url.includes('Web_browser')), 15000, 'the Wikipedia tab')).webSocketDebuggerUrl);
    await g.eval(`if (!document.getElementById('walk-tab')) {
      const mk = (bid, label, top) => { const b = document.createElement('button'); b.id = bid; b.textContent = label; b.style.cssText = 'position:fixed;left:24px;top:' + top + 'px;z-index:2147483647;font-size:20px'; document.body.appendChild(b); return b; };
      mk('walk-tab', 'open a tab', 24).onclick = () => { window.open('https://example.com/?walk=from-page'); };
      mk('walk-signin', 'sign in', 84).onclick = () => { window.open('https://example.com/?walk=signin', 'signin', 'width=500,height=600'); };
    } return true;`);
    return g;
  };
  const press = async (g, sel) => {
    const box = await host.eval(`const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width };`);
    const s = box.w / (await g.eval('return innerWidth;'));
    const r = await g.eval(`const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
    await click(box.x + r.x * s, box.y + r.y * s);
  };
  await clickSel(`[data-act="tab|${id}|0"]`);
  await sleep(1000);
  let g = await wikiTab();
  await press(g, '#walk-tab');
  await sleep(2000);
  const t = await tabsOf(id);
  g.close();
  const wins0 = await mainp.eval('return require("electron").BrowserWindow.getAllWindows().length;', { commandLine: true });
  g = await wikiTab();
  await press(g, '#walk-signin');
  await sleep(3000);
  const wins1 = await mainp.eval('return require("electron").BrowserWindow.getAllWindows().map((w) => w.webContents.getURL());', { commandLine: true });
  g.close();
  step('a page opening a link adds a tab next to it', t && t.tabs.some((x) => /walk=from-page/.test(x.url)), `tabs ${JSON.stringify(t && t.tabs.map((x) => x.url))}`);
  step('a sign-in popup opens as its own small window', wins1.length === wins0 + 1 && wins1.some((u) => /walk=signin/.test(u)), `windows ${JSON.stringify(wins1)}`);
  await mainp.eval('const { BrowserWindow } = require("electron"); for (const w of BrowserWindow.getAllWindows()) if (/walk=signin/.test(w.webContents.getURL())) w.close(); return true;', { commandLine: true });
}

// 4. Links from a terminal: the first opens a page beside it, the next opens as a tab there (BRIEF 3.0).
{
  const before = await host.eval(`return window.__flow.windows().map((w) => w.id);`);
  await menu('New Shell');
  const tid = await waitFor(async () => (await host.eval(`return window.__flow.windows().filter((w) => w.type === 'term').map((w) => w.id);`)).find((x) => !before.includes(x)), 15000, 'the shell window').catch(() => null);
  if (!tid) step('a terminal link opens a page beside it', false, 'no shell window opened');
  else {
    await sleep(2500);
    const sess = `flow_${tid}`;
    execFileSync('tmux', ['-L', 'flow-dev-browse', 'send-keys', '-t', sess, 'clear; echo https://example.org/walk-1; echo https://example.org/walk-2', 'Enter']);
    await sleep(1500);
    const rows = execFileSync('tmux', ['-L', 'flow-dev-browse', 'capture-pane', '-p', '-t', sess], { encoding: 'utf8' }).split('\n');
    const size = execFileSync('tmux', ['-L', 'flow-dev-browse', 'display', '-p', '-t', sess, '#{pane_width} #{pane_height}'], { encoding: 'utf8' }).trim().split(' ').map(Number);
    const scr = await host.eval(`const e = document.querySelector('.win[data-id="${tid}"] .xterm-screen'); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height };`);
    const cw = scr.w / size[0], ch = scr.h / size[1];
    const at = (text) => { const r = rows.findIndex((l) => l.startsWith(text)); return r < 0 ? null : { x: scr.x + 4.5 * cw, y: scr.y + (r + 0.5) * ch }; };
    const pagesBefore = await pageWindows();
    const l1 = at('https://example.org/walk-1');
    if (l1) { await ev({ type: 'mouseMoved', x: l1.x - 10, y: l1.y, button: 'none', buttons: 0 }); await sleep(300); await ev({ type: 'mouseMoved', x: l1.x, y: l1.y, button: 'none', buttons: 0 }); await sleep(400); await click(l1.x, l1.y); }
    await sleep(2500);
    const pagesMid = await pageWindows();
    const pid = pagesMid.find((x) => !pagesBefore.includes(x));
    const l2 = at('https://example.org/walk-2');
    const scr2 = await host.eval(`const e = document.querySelector('.win[data-id="${tid}"] .xterm-screen'); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top };`);
    const dx = scr2.x - scr.x, dy = scr2.y - scr.y;
    if (l2) { await ev({ type: 'mouseMoved', x: l2.x + dx - 10, y: l2.y + dy, button: 'none', buttons: 0 }); await sleep(300); await ev({ type: 'mouseMoved', x: l2.x + dx, y: l2.y + dy, button: 'none', buttons: 0 }); await sleep(400); await click(l2.x + dx, l2.y + dy); }
    await sleep(2500);
    const pagesAfter = await pageWindows();
    const t = pid ? await tabsOf(pid) : null;
    await shot('04-terminal-links');
    step('a terminal link opens a page beside the terminal', !!pid, `rows ${JSON.stringify(rows.filter((l) => l.includes('walk')))}, new page ${pid}`);
    step('the next link from that terminal opens as a tab there', !!t && t.tabs.length === 2 && pagesAfter.length === pagesMid.length, `tabs ${JSON.stringify(t && t.tabs.map((x) => x.url))}, page windows ${pagesMid.length} -> ${pagesAfter.length}`);
  }
}

// 5. Save a page (⌘D) into a section and find it again: the sidebar, a new tab, and ⌘K.
{
  const id = globalThis.P1;
  const rowSel = `[data-act="tab|${id}|0"]`;
  await clickSel(rowSel);
  await sleep(1200);
  await host.eval(`${pageOf(id)}.selectTab(0); return true;`);
  await sleep(800);
  await menu('Save Page');
  await sleep(1500);
  const sidebar = await host.eval(`return [...document.querySelectorAll('[data-act^="saved|"], [data-act^="tab|"]')].map((r) => r.dataset.act + ' ' + r.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60));`);
  await shot('05-saved');
  const once = sidebar.filter((r) => /Web browser/i.test(r));
  // no notice says where (no notifications, the owner's Nov 1 20:45 rule): the saved row is the answer
  step('⌘D saves the page into a section', once.some((r) => r.startsWith('saved|')), JSON.stringify(once));
  step('the saved page that is open shows once in the sidebar', once.length === 1 && once[0].startsWith('saved|'), JSON.stringify(once));
  await menu('New Page');
  await sleep(1200);
  const list = await host.eval(`const w = document.querySelector('.win[data-id="${id}"]'); return w.querySelector('.pgv').innerText.slice(0, 300);`);
  await shot('05b-new-tab-list');
  step('a new tab lists the saved pages', /Web browser/i.test(list), JSON.stringify(list.slice(0, 120)));
  await menu('Close Window');
  await sleep(800);
  await menu('Search');
  await sleep(700);
  await host.send('Input.insertText', { text: 'web browser' });
  await sleep(1500);
  // the saved row must be what the search shows, and a row that does not match ("this week", a note) must be hidden:
  // the sidebar's own rows match "web browser" with or without a search
  const rows = await host.eval(`return [...document.querySelectorAll('[data-act]')].filter((e) => e.getClientRects().length).map((e) => ({ act: e.dataset.act, text: e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60) }));`);
  const found = rows.filter((r) => /web browser/i.test(r.text) && r.act.startsWith('saved|')).map((r) => r.text);
  const others = rows.filter((r) => /this week/i.test(r.text)).length;
  await shot('05c-search');
  step('⌘K finds the saved page', found.length > 0 && others === 0, `${JSON.stringify(found)}, rows not matching still shown ${others}`);
  await key('Escape', 'Escape', 27);
  await sleep(500);
}

// 6. The ✎ side note: closed, opens beside the page; a clipped sentence lands in it and leads back to the sentence.
{
  const id = globalThis.P1;
  await clickSel(`[data-act="tab|${id}|0"]`);
  await sleep(1200);
  const closed = await host.eval(`return !document.querySelector('.win[data-id="${id}"]').classList.contains('noted');`);
  // step 3 left the link's tab shown: show the Wikipedia tab, whose sentence is dragged over
  const wiki = (await tabsOf(id)).tabs.findIndex((t) => /Web_browser/.test(t.url));
  await host.eval(`${pageOf(id)}.selectTab(${wiki}); return true;`);
  await sleep(1500);
  // ✎ first: a clip opens the note by itself, so ✎ after it would close the note again
  await clickSel(`.win[data-id="${id}"] [data-act="note"]`);
  await sleep(1000);
  const opened = await host.eval(`return document.querySelector('.win[data-id="${id}"]').classList.contains('noted');`);
  const g = await Cdp.connect((await targets(9571)).find((t) => t.type === 'webview' && t.url.includes('Web_browser')).webSocketDebuggerUrl);
  const box = await host.eval(`const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width };`);
  const word = await g.eval(`const p = [...document.querySelectorAll('p')].find((e) => e.textContent.trim().length > 120); p.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const r = document.createRange(); r.selectNodeContents(p); const b = r.getClientRects()[0]; const pb = p.getBoundingClientRect(); return { x: pb.left + 4, y: b.top + b.height / 2, x2: pb.left + Math.min(pb.width - 4, 260), vw: innerWidth };`);
  const s = box.w / word.vw;
  await ev({ type: 'mouseMoved', x: box.x + word.x * s, y: box.y + word.y * s, button: 'none', buttons: 0 });
  await ev({ type: 'mousePressed', x: box.x + word.x * s, y: box.y + word.y * s, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await ev({ type: 'mouseMoved', x: box.x + (word.x + ((word.x2 - word.x) * i) / 8) * s, y: box.y + word.y * s, button: 'left', buttons: 1 });
  await ev({ type: 'mouseReleased', x: box.x + word.x2 * s, y: box.y + word.y * s, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  const sel = await g.eval('return String(getSelection()).trim();');
  g.close();
  await waitFor(() => host.eval(`const c = document.querySelector('.win[data-id="${id}"] .pclip'); return !!c && !c.classList.contains('nosel') && !c.classList.contains('off');`), 5000, 'the ✂ to show').catch(() => null);
  await clickSel(`.win[data-id="${id}"] .pclip`);
  await sleep(1200);
  const note = await host.eval(`const w = document.querySelector('.win[data-id="${id}"]'); const n = w.querySelector('.anote'); return { noted: w.classList.contains('noted'), text: n ? n.innerText.slice(-200) : null };`);
  await shot('06-side-note-clip');
  step('the ✎ note is closed until asked for, then opens beside the page', closed && opened, `closed at first ${closed}, open after ✎ ${opened}`);
  step('a clipped sentence lands in the page note', sel.length >= 10 && String(note.text).includes(sel.slice(0, 20)), `selected "${sel.slice(0, 60)}", note ends "${String(note.text).slice(-90)}"`);
}

// 7. Quit and relaunch: the page's tabs, scroll and zoom come back.
{
  const id = globalThis.P1;
  await host.eval(`${pageOf(id)}.navigate('https://www.rfc-editor.org/rfc/rfc9110.html'); return true;`);
  await waitLoaded(id, /rfc9110/).catch(() => null);
  await host.eval(`${pageOf(id)}.newTab('https://example.com/?walk=kept'); return true;`);
  await sleep(2500);
  const idx = (await tabsOf(id)).tabs.findIndex((t) => /rfc9110/.test(t.url));
  await host.eval(`${pageOf(id)}.selectTab(${idx}); return true;`);
  await sleep(1200);
  await menu('Zoom In');
  await sleep(800);
  const box = await host.eval(`const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
  const g = await Cdp.connect((await targets(9571)).find((t) => t.type === 'webview' && t.url.includes('rfc9110')).webSocketDebuggerUrl);
  for (let i = 0; i < 30; i++) { await ev({ type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 100, button: 'none', buttons: 0 }); await sleep(25); }
  await sleep(12000);
  const before = { scroll: await g.eval('return Math.round(scrollY);'), zoom: await g.eval('return devicePixelRatio;'), tabs: (await tabsOf(id)).tabs.length };
  g.close();
  host.close();
  mainp.close();
  execFileSync(APP, ['stop'], { stdio: 'inherit' });
  execFileSync(APP, ['start', '/tmp/flow-dev-browse.log'], { stdio: 'inherit' });
  await connect();
  await sleep(4000);
  await clickSel(`[data-act="tab|${id}|${idx}"]`);
  await waitFor(async () => (await targets(9571)).some((t) => t.type === 'webview' && t.url.includes('rfc9110')), 30000, 'the restored page').catch(() => null);
  await sleep(4000);
  const t = (await targets(9571)).find((x) => x.type === 'webview' && x.url.includes('rfc9110'));
  let after = { scroll: null, zoom: null };
  if (t) { const g2 = await Cdp.connect(t.webSocketDebuggerUrl); after = { scroll: await g2.eval('return Math.round(scrollY);'), zoom: await g2.eval('return devicePixelRatio;') }; g2.close(); }
  after.tabs = ((await tabsOf(id)) || { tabs: [] }).tabs.length;
  await shot('08-after-relaunch');
  step('after a quit, the page comes back with its tabs', before.tabs >= 2 && after.tabs === before.tabs, `${before.tabs} tabs before, ${after.tabs} after`);
  step('after a quit, the page comes back where it was scrolled', before.scroll > 1000 && after.scroll !== null && Math.abs(after.scroll - before.scroll) < 50, `scrollY ${before.scroll} before, ${after.scroll} after`);
  step('after a quit, the page comes back at its zoom', before.zoom > 1 && after.zoom === before.zoom, `zoom ${before.zoom} before, ${after.zoom} after`);
}
host.close();
mainp.close();
console.log(nos ? `${nos} NO` : 'all ok');
process.exitCode = nos ? 1 : 0;




