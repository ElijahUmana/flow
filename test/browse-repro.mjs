// browse: reproduces the browser bugs browse reported, against a running Flow copy, with real input on its window.
// usage: node test/browse-repro.mjs [cdp-port] [main-inspector-port] [--restart]
//   defaults 9571 9671 (test/browse-app.sh reset, then start). --restart also quits and restarts browse's copy through
//   test/browse-app.sh to check that tabs and scroll come back (principle 5).
// Prints ok/FAIL per check (FAIL = the bug is still there) and exits non-zero on any FAIL. Needs network access.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const RESTART = process.argv.includes('--restart');
const PORT = Number(args[0] || 9571);
const INSPECT = Number(args[1] || 9671);
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

const host = await Cdp.connect((await waitFor(async () => (await targets(PORT)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 20000, 'the Flow window')).webSocketDebuggerUrl);
await waitFor(() => host.eval('return !!(window.__flow && window.__flow.ready);'), 40000, 'window.__flow');
await host.eval('await window.__flow.ready; return true;');
const mainp = await Cdp.connect((await waitFor(async () => (await targets(INSPECT))[0], 20000, 'the main-process inspector')).webSocketDebuggerUrl);

const mouse = (type, x, y, o = {}) => host.send('Input.dispatchMouseEvent', { type, x, y, button: o.button || (type === 'mouseMoved' ? 'none' : 'left'), buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: o.modifiers || 0 });
async function click(x, y, modifiers = 0) {
  await mouse('mouseMoved', x, y, { modifiers });
  await mouse('mousePressed', x, y, { modifiers });
  await mouse('mouseReleased', x, y, { modifiers });
}
async function openPage(url) {
  const id = await host.eval(`return window.__flow.openPage(${JSON.stringify(url)});`);
  await waitFor(() => host.eval(`const p = window.__flow.page(${JSON.stringify(id)}); return !!p && p.getTitle() !== '' && !p.isLoading();`), 30000, `${url} to load`);
  await sleep(1500);
  return id;
}
async function guestOf(url) {
  const t = await waitFor(async () => (await targets(PORT)).find((x) => x.type === 'webview' && x.url === url), 20000, `the webview at ${url}`);
  return Cdp.connect(t.webSocketDebuggerUrl);
}
const webviewBox = (id) => host.eval(`const v = (document.querySelector('.win[data-id="${id}"] webview:not(.off)') || document.querySelector('.win[data-id="${id}"] webview')); const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height };`);
// A real click on an element of a page, through Flow's window (the page is laid out at desktop width and scaled).
async function clickInPage(id, g, sel) {
  const box = await webviewBox(id);
  const s = box.w / (await g.eval('return innerWidth;'));
  const r = await g.eval(`const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
  await click(box.x + r.x * s, box.y + r.y * s);
}
const windowCount = () => host.eval('return window.__flow.windows().length;');

// 1. A popup keeps its opener (OAuth popups such as Notion's "Continue with Google" need it). Each popup opens from a
// real click on a button in the page, as the owner's click on "Continue with Google" does.
{
  const url = 'https://example.com/?flow-repro=popup';
  const id = await openPage(url);
  const g = await guestOf(url);
  await g.eval(`document.body.insertAdjacentHTML('afterbegin', '<button id="b1">blank</button> <button id="b2">popup</button>');
    document.getElementById('b1').onclick = () => { try { const w = window.open('', '_blank'); w.location.href = 'https://example.com/?flow-repro=blank-then-location'; window.__r1 = 'opened'; } catch (e) { window.__r1 = 'threw ' + e.message; } };
    document.getElementById('b2').onclick = () => { try { const w = window.open('https://example.com/?flow-repro=child', 'flowrepro', 'width=480,height=600'); window.__r2 = w === null ? 'null' : 'window'; } catch (e) { window.__r2 = 'threw ' + e.message; } };
    return true;`);
  await clickInPage(id, g, '#b1');
  await sleep(1000);
  const blank = await g.eval('return window.__r1 || "no click";');
  check('window.open("") then setting its location opens the page', blank === 'opened', blank);
  await clickInPage(id, g, '#b2');
  const popup = await g.eval('return window.__r2 || "no click";');
  check('window.open(url, name, features) returns a window', popup === 'window', `returned ${popup}`);
  await sleep(2500);
  const child = (await targets(PORT)).find((x) => x.url === 'https://example.com/?flow-repro=child');
  if (child) {
    const c = await Cdp.connect(child.webSocketDebuggerUrl);
    const opener = await c.eval('return window.opener !== null;');
    c.close();
    check('the popup page has window.opener', opener === true, `opener ${opener ? 'set' : 'null'}`);
  } else check('the popup page has window.opener', false, 'no target for the popup url');
  g.close();
  await host.eval(`window.__repro1 = ${JSON.stringify(id)}; return true;`);
}

// 2. window.close() in a page leaves a usable page (or closes it), never a dead webview.
{
  const url = 'https://example.com/?flow-repro=close';
  const id = await openPage(url);
  const g = await guestOf(url);
  // the page may close before it answers: its connection closing is the outcome checked below, any other error is not
  await g.send('Runtime.evaluate', { expression: 'window.close()', userGesture: true }).catch((e) => { if (!/connection closed/.test(e.message)) throw e; });
  g.close();
  await sleep(1500);
  const r = await host.eval(`const id = ${JSON.stringify(id)}; const win = document.querySelector('.win[data-id="' + id + '"]'); if (!win) return { gone: true }; const p = window.__flow.page(id); p.navigate('https://example.org/'); await new Promise((res) => setTimeout(res, 4000)); const err = win.querySelector('.perr'); return { gone: false, err: err && err.classList.contains('on') ? err.innerText.replace(/\\n/g, ' | ') : null, url: p.getURL() };`);
  check('after window.close() the page window still loads an address', r.gone || !r.err, r.gone ? 'window closed' : r.err || r.url);
}

// 3. A page guarding unsaved changes (beforeunload) gets a question, not a silent block: either a dialog from main or
// an ask inside the page's window (main sends page:unload-blocked). Choosing leave then takes the page where it was going.
{
  const url = 'https://en.wikipedia.org/wiki/Web_browser';
  const id = await openPage(url);
  const box = await webviewBox(id);
  const g = await guestOf(url);
  // a click on the heading (no link) gives the page the user activation a beforeunload question needs
  const h1 = await g.eval('const b = document.querySelector("h1").getBoundingClientRect(); return { x: b.left + 10, y: b.top + b.height / 2, vw: innerWidth };');
  const s = box.w / h1.vw;
  await click(box.x + h1.x * s, box.y + h1.y * s);
  const active = await g.eval('window.addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; }); return navigator.userActivation.hasBeenActive;');
  g.close();
  await mainp.eval(`const { dialog } = require('electron'); globalThis.__reproAsked = 0; if (!globalThis.__reproOrig) { globalThis.__reproOrig = dialog.showMessageBox; globalThis.__reproOrigSync = dialog.showMessageBoxSync; } dialog.showMessageBox = async () => { globalThis.__reproAsked++; return { response: 0, checkboxChecked: false }; }; dialog.showMessageBoxSync = () => { globalThis.__reproAsked++; return 0; }; return true;`, { commandLine: true });
  const target = 'https://example.com/?flow-repro=after-guard';
  await host.eval(`window.__flow.page(${JSON.stringify(id)}).navigate(${JSON.stringify(target)}); return true;`);
  const findLeave = `const win = document.querySelector('.win[data-id="${id}"]'); return !![...win.querySelectorAll('button, [role=button]')].find((e) => /^leave/i.test(e.textContent.trim()) && e.getClientRects().length);`;
  await waitFor(() => host.eval(findLeave), 5000, 'an inline leave ask').catch(() => null);
  const asked = await mainp.eval('const n = globalThis.__reproAsked; const { dialog } = require("electron"); dialog.showMessageBox = globalThis.__reproOrig; dialog.showMessageBoxSync = globalThis.__reproOrigSync; return n;', { commandLine: true });
  // an inline ask: a visible button in the page's window whose label starts with "leave"
  const leave = await host.eval(`const win = document.querySelector('.win[data-id="${id}"]'); const b = [...win.querySelectorAll('button, [role=button]')].find((e) => /^leave/i.test(e.textContent.trim()) && e.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (b.parentElement || b).textContent.trim().slice(0, 80) };`);
  if (leave) {
    await click(leave.x, leave.y);
    await waitFor(() => host.eval(`return window.__flow.page(${JSON.stringify(id)}).getURL() === ${JSON.stringify(target)};`), 8000, 'the page to leave').catch(() => null);
  }
  const at = await host.eval(`return window.__flow.page(${JSON.stringify(id)}).getURL();`);
  check('a guarded page asks before leaving, and leave goes on', (asked > 0 || !!leave) && at === target, `user activation ${active}, dialogs ${asked}, inline ask ${leave ? JSON.stringify(leave.text) : 'none'}, page at ${at}`);
}

// 4. A two-finger sideways swipe over a page that cannot scroll sideways moves to the next sub-workspace (nav).
// Uses the seed's McKinsey page window (w-mck, main area of the flow workspace, the research sub-workspace beside it).
{
  const has = await host.eval('return window.__flow.windows().some((w) => w.id === "w-mck");');
  if (!has) check('a sideways swipe over a page moves to the next sub-workspace', false, 'no w-mck window (start from the seed: test/browse-app.sh reset)');
  else {
    await host.eval(`window.__flow.go(window.__flow.state().ws.findIndex((w) => w.id === 'flow')); window.__flow.page('w-mck').navigate('https://example.com/?flow-repro=swipe'); return true;`);
    await waitFor(() => host.eval(`const p = window.__flow.page('w-mck'); return p.getURL().includes('flow-repro=swipe') && !p.isLoading();`), 20000, 'w-mck to load example.com');
    const row = await host.eval(`const n = window.__flow.windows().find((w) => w.id === 'w-mck').noteId; const r = document.querySelector('[data-act="note|' + n + '"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
    if (row) { await click(row.x, row.y); await sleep(1200); }
    const box = await webviewBox('w-mck');
    const where = `const s = window.__flow.state(); const cur = s.ws.find((w) => w.id === 'flow'); return JSON.stringify({ pan: cur.pan, zone: cur.zone, sub: cur.sub, at: cur.at });`;
    const before = await host.eval(where);
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x + box.w / 2, y: box.y + box.h / 2, deltaX: 40, deltaY: 0, button: 'none', buttons: 0, timestamp: (t0 + i * 16) / 1000 });
      await sleep(16);
    }
    await sleep(1200);
    const after = await host.eval(where);
    check('a sideways swipe over a page (which cannot scroll sideways) moves to the next sub-workspace', after !== before, `before ${before}, after ${after}`);
  }
}

// 5. A link typed in a note opens as a page (as a link in a terminal does).
{
  const ed = await host.eval('return window.__flow.spawn("note");');
  await sleep(800);
  const at = await host.eval(`const e = document.querySelector('.win[data-id="${ed}"] .nbody'); const b = e.getBoundingClientRect(); return { x: b.left + 20, y: b.top + 12 };`);
  await click(at.x, at.y);
  await host.send('Input.insertText', { text: 'read https://example.net/flow-repro-note-link later' });
  await sleep(400);
  const box = await host.eval(`const ed = document.querySelector('.win[data-id="${ed}"] .nbody'); const tw = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) { const i = n.data.indexOf('https://example.net/flow-repro-note-link'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 8); r.setEnd(n, i + 16); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } } return null;`);
  if (!box) check('a link in a note opens a page', false, 'the typed link is not in the note body');
  else {
    const before = await windowCount();
    for (const m of [0, 4, 2]) { await click(box.x, box.y, m); await sleep(1200); }
    const after = await windowCount();
    check('a link in a note opens a page (plain, meta or ctrl click)', after > before, `${before} windows before, ${after} after`);
  }
}

// 6. A page behind another window scrolls under the pointer, as background windows do on macOS.
{
  const id = await openPage('https://en.wikipedia.org/wiki/Web_browser');
  // a second page in the same space takes the front, as any other window would
  const other = await openPage('https://example.com/?flow-repro=front2');
  await sleep(800);
  const box = await webviewBox(id);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const st = await host.eval(`const e = document.elementFromPoint(${cx}, ${cy}); return { pageFront: document.querySelector('.win[data-id="${id}"]').classList.contains('front'), otherFront: document.querySelector('.win[data-id="${other}"]').classList.contains('front'), under: e ? (e.closest('.win') || {}).dataset.id || e.tagName : null };`);
  const g = await guestOf('https://en.wikipedia.org/wiki/Web_browser');
  const y0 = await g.eval('return Math.round(scrollY);');
  for (let i = 0; i < 5; i++) {
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 120, button: 'none', buttons: 0 });
    await sleep(30);
  }
  await sleep(800);
  const y1 = await g.eval('return Math.round(scrollY);');
  const st2 = await host.eval(`return document.querySelector('.win[data-id="${id}"]').classList.contains('front');`);
  g.close();
  const setup = !st.pageFront && st.otherFront && st.under === id;
  check('a wheel over a page behind another window scrolls it without bringing it to the front', setup && y1 > y0 && !st2, `setup ${setup ? 'ok' : JSON.stringify(st)}, scrollY ${y0} -> ${y1}, page front after: ${st2}`);
}

// 7. A pinch over a page that uses it (a map) stays with the page; BRIEF 3.0: "a canvas app such as Figma or Maps keeps it".
{
  const url = 'https://www.openstreetmap.org/#map=5/50.000/10.000';
  const id = await openPage(url);
  const box = await webviewBox(id);
  await click(box.x + box.w * 0.6, box.y + box.h * 0.6);
  await sleep(600);
  const t = await waitFor(async () => (await targets(PORT)).find((x) => x.type === 'webview' && x.url.includes('openstreetmap.org')), 20000, 'the map page');
  const g = await Cdp.connect(t.webSocketDebuggerUrl);
  const z0 = await g.eval('return location.hash;');
  for (let i = 0; i < 3; i++) {
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x + box.w * 0.6, y: box.y + box.h * 0.6, deltaX: 0, deltaY: -100, modifiers: 2, button: 'none', buttons: 0 });
    await sleep(60);
  }
  await sleep(2000);
  const z1 = await g.eval('return location.hash;');
  g.close();
  check('a pinch (ctrl+wheel) over a map page zooms the map', z0 !== z1, `${z0} -> ${z1}`);
}

const menuClick = (label) => mainp.eval(`const { Menu, BrowserWindow } = require('electron'); const find = (m) => { for (const it of m.items) { if (it.label === ${JSON.stringify(label)} && it.visible !== false) return it; if (it.submenu) { const f = find(it.submenu); if (f) return f; } } return null; }; const w = BrowserWindow.getAllWindows().find((x) => /index\.html/.test(x.webContents.getURL())); const it = find(Menu.getApplicationMenu()); if (!it) return false; it.click({}, w, w.webContents); return true;`, { commandLine: true });
async function frontPage(url) {
  const id = await openPage(url);
  const box = await webviewBox(id);
  const g = await guestOf(url);
  const h1 = await g.eval('const e = document.querySelector("h1") || document.body; const b = e.getBoundingClientRect(); return { x: b.left + 10, y: b.top + Math.min(b.height / 2, 20), vw: innerWidth };');
  const s = box.w / h1.vw;
  await click(box.x + h1.x * s, box.y + h1.y * s);
  await sleep(400);
  return { id, g, box, s };
}

// 9. ⌘+ and ⌘0 zoom the front page (Page > Zoom In, Actual Size).
{
  const { id, g } = await frontPage('https://example.com/?flow-repro=zoom');
  const z0 = await g.eval('return devicePixelRatio;');
  const ok1 = await menuClick('Zoom In');
  await sleep(800);
  const z1 = await g.eval('return devicePixelRatio;');
  await menuClick('Actual Size');
  await sleep(800);
  const z2 = await g.eval('return devicePixelRatio;');
  g.close();
  check('Zoom In makes the front page bigger and Actual Size resets it', ok1 && z1 > z0 && z2 === z0, `zoom ${z0} -> ${z1} -> ${z2} (${id})`);
}

// 10. A link to another app asks first; Cancel opens nothing and Open hands it to the system.
{
  const url = 'https://example.com/?flow-repro=applink';
  const { id, g, box, s } = await frontPage(url);
  const a = await g.eval(`const a = document.createElement('a'); a.href = 'zoommtg://zoom.us/join?confno=123'; a.textContent = 'join the meeting'; a.style.cssText = 'display:block;font-size:40px;margin:20px'; document.body.prepend(a); const b = a.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
  // main answers Chromium's openExternal request itself (askExternal -> answer(open)), so record the window's answers
  await mainp.eval(`const { shell, ipcMain } = require('electron'); globalThis.__reproExt = []; globalThis.__reproAns = []; if (!globalThis.__reproOpenExt) globalThis.__reproOpenExt = shell.openExternal; shell.openExternal = async (u) => { globalThis.__reproExt.push(u); }; if (!globalThis.__reproAnsF) { globalThis.__reproAnsF = (_e, id, open) => globalThis.__reproAns.push(open === true); ipcMain.on('page:answerExternal', globalThis.__reproAnsF); } return true;`, { commandLine: true });
  const askBtn = (label) => host.eval(`const win = document.querySelector('.win[data-id="${id}"]'); const b = [...win.querySelectorAll('button')].find((e) => e.textContent.trim().toLowerCase() === ${JSON.stringify(label)} && e.getClientRects().length); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, ask: (b.parentElement || b).textContent.trim().slice(0, 90) };`);
  await click(box.x + a.x * s, box.y + a.y * s);
  const cancel = await waitFor(() => askBtn('cancel'), 5000, 'the app-link ask').catch(() => null);
  if (cancel) { await click(cancel.x, cancel.y); await sleep(800); }
  const afterCancel = await mainp.eval('return { opened: globalThis.__reproExt.slice(), answers: globalThis.__reproAns.slice() };', { commandLine: true });
  await click(box.x + a.x * s, box.y + a.y * s);
  const open = await waitFor(() => askBtn('open'), 5000, 'the app-link ask again').catch(() => null);
  if (open) { await click(open.x, open.y); await sleep(1200); }
  const afterOpen = await mainp.eval('const r = { opened: globalThis.__reproExt.slice(), answers: globalThis.__reproAns.slice() }; const { shell, ipcMain } = require("electron"); shell.openExternal = globalThis.__reproOpenExt; ipcMain.removeListener("page:answerExternal", globalThis.__reproAnsF); globalThis.__reproAnsF = null; return r;', { commandLine: true });
  g.close();
  const okCancel = !!cancel && afterCancel.opened.length === 0 && JSON.stringify(afterCancel.answers) === '[false]';
  const okOpen = !!open && JSON.stringify(afterOpen.answers) === '[false,true]';
  check('a link to another app asks; cancel answers no, open answers yes', okCancel && okOpen, `ask ${cancel ? JSON.stringify(cancel.ask) : 'none'}, after cancel ${JSON.stringify(afterCancel)}, after open ${JSON.stringify(afterOpen)}`);
}

// 11. The find bar closes when the page goes to another page.
{
  const { id, g } = await frontPage('https://en.wikipedia.org/wiki/Hyperlink');
  g.close();
  await menuClick('Find');
  await sleep(500);
  await host.send('Input.insertText', { text: 'link' });
  await sleep(800);
  const open1 = await host.eval(`return !!document.querySelector('.win[data-id="${id}"] .pfind.on');`);
  await host.eval(`window.__flow.page(${JSON.stringify(id)}).navigate('https://example.com/?flow-repro=after-find'); return true;`);
  await waitFor(() => host.eval(`return window.__flow.page(${JSON.stringify(id)}).getURL().includes('after-find');`), 15000, 'the next page').catch(() => null);
  await sleep(800);
  const open2 = await host.eval(`return !!document.querySelector('.win[data-id="${id}"] .pfind.on');`);
  check('the find bar closes when the page goes to another page', open1 && !open2, `open before ${open1}, after ${open2}`);
}

// 12. ⌘/ctrl-click opens a background tab named from its address; shift-click opens a tab, not a window.
{
  const url = 'https://en.wikipedia.org/wiki/Hyperlink';
  const { id, g, box, s } = await frontPage(url);
  const linkAt = async (path) => g.eval(`const a = [...document.querySelectorAll('p a')].find((x) => x.href.endsWith(${JSON.stringify(path)})); if (!a) return null; a.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const b = a.getClientRects()[0]; return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
  const paths = await g.eval(`return [...new Set([...document.querySelectorAll('p a')].map((a) => a.href).filter((h) => h.includes('/wiki/') && !h.includes('#') && !h.split('/wiki/')[1].includes(':') && h.split('/wiki/')[1] !== 'Hyperlink'))].slice(0, 2).map((h) => new URL(h).pathname);`);
  const mod = process.platform === 'darwin' ? 4 : 2;
  const before = await host.eval(`return window.__flow.page(${JSON.stringify(id)}).tabs().tabs.length;`);
  const windowsBefore = await mainp.eval('return require("electron").BrowserWindow.getAllWindows().length;', { commandLine: true });
  const p1 = await linkAt(paths[0]);
  await click(box.x + p1.x * s, box.y + p1.y * s, mod);
  await sleep(1500);
  const label = await host.eval(`const t = [...document.querySelectorAll('.win[data-id="${id}"] .ptab')].map((e) => e.textContent.replace('×', '').trim()); return t;`);
  const mid = await host.eval(`return window.__flow.page(${JSON.stringify(id)}).tabs();`);
  // the tab strip appeared with the second tab and moved the page down: measure it again
  const box2 = await webviewBox(id);
  const s2 = box2.w / (await g.eval('return innerWidth;'));
  const p2 = await linkAt(paths[1]);
  await click(box2.x + p2.x * s2, box2.y + p2.y * s2, 8);
  await sleep(1500);
  const after = await host.eval(`return window.__flow.page(${JSON.stringify(id)}).tabs();`);
  const windowsAfter = await mainp.eval('return require("electron").BrowserWindow.getAllWindows().length;', { commandLine: true });
  g.close();
  const named = label.length >= 2 && !/^en\.wikipedia\.org/.test(label[1]);
  check('a modifier-click opens a background tab named from its address', mid.tabs.length === before + 1 && mid.tab === 0 && named, `tabs ${JSON.stringify(label)}, shown tab ${mid.tab}`);
  check('shift-click opens a tab, not a window', after.tabs.length === before + 2 && windowsAfter === windowsBefore, `tabs ${before} -> ${after.tabs.length}, windows ${windowsBefore} -> ${windowsAfter}`);
}

// 13. A file dragged from Finder onto a page lands in the page whether or not that page is Flow's front window, as a
// background window on macOS takes a drop (an attachment into Gmail, a screenshot into a chat). Input.dispatchDragEvent
// takes the browser's drag path, as an OS drag does.
{
  const dir = mkdtempSync(join(tmpdir(), 'browse-drop-'));
  const file = join(dir, 'dropme.txt');
  writeFileSync(file, 'flow drop test\n');
  const a = await openPage('https://example.com/?flow-repro=drop-a');
  const g = await Cdp.connect((await waitFor(async () => (await targets(PORT)).find((x) => x.type === 'webview' && x.url.includes('flow-repro=drop-a')), 20000, 'page a')).webSocketDebuggerUrl);
  await g.eval(`window.__drops = 0; document.addEventListener('dragover', (e) => e.preventDefault()); document.addEventListener('drop', (e) => { e.preventDefault(); if ([...e.dataTransfer.files].some((f) => f.name === 'dropme.txt')) window.__drops++; }); return true;`);
  // A real drag enters whatever is under the pointer each time that changes (Chromium sends the new target its own
  // dragenter); CDP hit-tests each event but enters nothing, so the drag is entered again once Flow has had the first.
  const dropOn = async (id) => {
    const p = await webviewBox(id);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragEnter', 'dragOver', 'drop']) { await host.send('Input.dispatchDragEvent', { type, x: p.x + p.w / 2, y: p.y + p.h / 2, data }); await sleep(250); }
  };
  await dropOn(a);
  const front = await g.eval('return window.__drops;');
  await openPage('https://example.com/?flow-repro=drop-b');
  const behind = await host.eval(`return !document.querySelector('.win[data-id="${a}"]').classList.contains('front');`);
  await dropOn(a);
  const both = await g.eval('return window.__drops;');
  check('a file dropped on a page lands in it, front or behind another window', front === 1 && behind && both === 2, `front page got ${front}, then ${behind ? 'behind another window' : 'still front'} it got ${both - front}`);
  // A real drag gives Flow's window its dragleave when it crosses into the page; CDP gives none, so Flow's window would
  // still count a drag and take the next one as a dragover. A dragover outside the window ends it.
  // (A drag that leaves over a page with no drop is not checked here: CDP's leave reaches Flow's window, not the page.)
  await host.send('Input.dispatchDragEvent', { type: 'dragOver', x: -30, y: 300, data: { items: [], files: [file], dragOperationsMask: 1 } });
  await sleep(300);
  g.close();
  rmSync(dir, { recursive: true });
}

// 14. A page cannot open tabs or windows on its own: window.open with no click (on load, or from a timer) opens nothing,
// as Chrome's popup blocker does, and the page the owner reads stays shown.
{
  const id = await openPage('https://example.com/?flow-repro=noclick');
  const g = await Cdp.connect((await waitFor(async () => (await targets(PORT)).find((x) => x.type === 'webview' && x.url.includes('flow-repro=noclick')), 20000, 'the page')).webSocketDebuggerUrl);
  const before = await host.eval(`const t = window.__flow.page(${JSON.stringify(id)}).tabs(); return { tabs: t.tabs.length, shown: t.tab, windows: window.__flow.windows().length };`);
  const active = await g.eval('return navigator.userActivation.hasBeenActive;');
  await g.eval(`window.open('https://example.org/?flow-repro=noclick-1'); setTimeout(() => window.open('https://example.org/?flow-repro=noclick-2'), 300); return true;`);
  await sleep(4000);
  const after = await host.eval(`const t = window.__flow.page(${JSON.stringify(id)}).tabs(); return { tabs: t.tabs.length, shown: t.tab, windows: window.__flow.windows().length };`);
  g.close();
  check('a page cannot open tabs or windows with no click', !active && after.tabs === before.tabs && after.shown === before.shown && after.windows === before.windows, `page had input ${active}; tabs ${before.tabs} -> ${after.tabs}, shown ${before.shown} -> ${after.shown}, windows ${before.windows} -> ${after.windows}`);
}

// 8. (--restart) Tabs and their scroll come back after a quit (principle 5; BRIEF 3.0 "tabs and their scroll").
if (RESTART) {
  const has = await host.eval('return window.__flow.windows().some((w) => w.id === "w-mck");');
  if (!has) check('tabs and scroll come back after a restart', false, 'no w-mck window (start from the seed: test/browse-app.sh reset)');
  else {
    await host.eval(`window.__flow.go(window.__flow.state().ws.findIndex((w) => w.id === 'flow')); const p = window.__flow.page('w-mck'); p.navigate('https://www.rfc-editor.org/rfc/rfc9110.html'); return true;`);
    await waitFor(() => host.eval(`const p = window.__flow.page('w-mck'); return p.getURL().includes('rfc9110') && !p.isLoading();`), 20000, 'w-mck to load');
    await host.eval(`const p = window.__flow.page('w-mck'); p.newTab('https://example.com/?flow-repro=tab2'); return true;`);
    await sleep(3000);
    await host.eval(`const p = window.__flow.page('w-mck'); p.selectTab(0); return true;`);
    await sleep(1500);
    const g = await guestOf('https://www.rfc-editor.org/rfc/rfc9110.html');
    // show w-mck the way a user does (its tab's row in the sidebar), since check 4 left the view in another space
    const row0 = await host.eval(`const r = document.querySelector('[data-act="tab|w-mck|0"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
    if (row0) { await click(row0.x, row0.y); await sleep(1500); }
    // scroll the way a user does (wheel over the page), which is what makes page.js save the scroll 2.5 s later
    const wb = await webviewBox('w-mck');
    for (let i = 0; i < 40; i++) {
      await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wb.x + wb.w / 2, y: wb.y + wb.h / 2, deltaX: 0, deltaY: 100, button: 'none', buttons: 0 });
      await sleep(20);
      if (i % 10 === 9 && (await g.eval('return scrollY;')) > 1400) break;
    }
    await sleep(Number(process.env.BROWSE_SCROLL_WAIT || 4000));
    await host.eval(`const p = window.__flow.page('w-mck'); if (typeof p.zoom === 'function') p.zoom(1); return true;`);
    await sleep(800);
    const zoomBefore = await g.eval('return devicePixelRatio;');
    const scrolledTo = await g.eval('return Math.round(scrollY);');
    g.close();
    const before = await host.eval(`return window.__flow.page('w-mck').tabs().tabs.length;`);
    await sleep(2500);
    host.close();
    mainp.close();
    execFileSync(new URL('./browse-app.sh', import.meta.url).pathname, ['stop'], { stdio: 'inherit' });
    execFileSync(new URL('./browse-app.sh', import.meta.url).pathname, ['start', '/tmp/flow-dev-browse.log'], { stdio: 'inherit' });
    const h2 = await Cdp.connect((await waitFor(async () => (await targets(PORT)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 30000, 'the Flow window')).webSocketDebuggerUrl);
    await waitFor(() => h2.eval('return !!(window.__flow && window.__flow.ready);'), 30000, 'window.__flow');
    await h2.eval('await window.__flow.ready; return true;');
    await sleep(6000);
    const after = await h2.eval(`const p = window.__flow.page('w-mck'); return p ? p.tabs().tabs.length : 0;`);
    // bring w-mck on screen the way a user does (its row in the sidebar), so its shown tab loads
    const row = await h2.eval(`const n = window.__flow.windows().find((w) => w.id === 'w-mck').noteId; const r = document.querySelector('[data-act="tab|w-mck|0"]') || document.querySelector('[data-act="note|' + n + '"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
    if (row) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await h2.send('Input.dispatchMouseEvent', { type, x: row.x, y: row.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    await waitFor(async () => (await targets(PORT)).some((x) => x.type === 'webview' && x.url.includes('rfc9110')), 20000, 'the restored rfc9110 tab').catch(() => null);
    await sleep(2000);
    let y = null, zoomAfter = null;
    const t = (await targets(PORT)).find((x) => x.type === 'webview' && x.url.includes('rfc9110'));
    if (t) { const g2 = await Cdp.connect(t.webSocketDebuggerUrl); y = await g2.eval('return Math.round(scrollY);'); zoomAfter = await g2.eval('return devicePixelRatio;'); g2.close(); }
    h2.close();
    check('tabs come back after a restart', before >= 2 && after === before, `${before} tabs before, ${after} after`);
    check('the page comes back where it was scrolled', y !== null && scrolledTo > 1000 && Math.abs(y - scrolledTo) < 50, `scrollY ${scrolledTo} before, ${y} after`);
    check('the page comes back at its zoom', zoomAfter !== null && zoomBefore > 1 && zoomAfter === zoomBefore, `zoom ${zoomBefore} before, ${zoomAfter} after`);
    console.log(fails ? `${fails} FAIL` : 'all ok');
    process.exit(fails ? 1 : 0);
  }
}

host.close();
mainp.close();
console.log(fails ? `${fails} FAIL` : 'all ok');
process.exit(fails ? 1 : 0);




