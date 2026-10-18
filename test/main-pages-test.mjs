// Page behaviour main owns (browse's list via the lead), in the real app on a light state (one workspace, no terminals)
// with local pages:
//   cookies: a fresh cookie survives kill -9 three seconds later (written within 2 s); a session cookie is kept 30 days
//            and survives a quit (principle 5), but not a partitioned one from a frame of another site;
//   downloads: straight to userData/Downloads (FLOW_USER_DATA runs), no dialog, "name (1).ext" on a clash, page:download
//            to the page's window; showItemInFolder refuses files Flow did not download (principle 3);
//   permissions: an answer in the state file is used without asking and is what pages read; a new answer is saved and
//            used after a relaunch; the microphone and the camera are answered apart;
//   context menu: Cut and Select All in a text field, image items, spelling suggestions;
//   app links: a zoommtg:/slack: link or popup asks the page's window first (page:open-external) and opens only after
//            yes; no answer in 60 s is no; blob: popups stay blocked;
//   unsaved-changes guard: a guarded page that the user touched has unsaved changes, and still never stops an
//            address-bar navigation, a link or the context menu's Reload, with nothing asked (owner, Nov 1 20:47; batch 9);
//            pageHasUnsavedChanges counts frame by frame, user interaction required;
//   zoom: per page (another page of the same site keeps its size), kept on the next document and after a reload, Chrome's
//            steps, the Page menu items;
//   history: pageHistory reads a tab's entries and page states; restorePageNext brings them back into a new webview
//            (history and scroll), as after a restart.
//   node test/main-pages-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-pages-${Date.now()}.log`);
const STATE_FILE = path.join(L.USER_DATA, 'flow-state.json');
const DOWNLOADS = path.join(L.USER_DATA, 'Downloads');
// Recorder for what Electron hands to the desktop (Linux: xdg-open for app links).
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dev-main-bin-'));
const OPENED = path.join(BIN, 'opened.log');
fs.writeFileSync(path.join(BIN, 'xdg-open'), `#!/bin/sh\nprintf '%s %s\\n' xdg-open "$*" >> '${OPENED}'\n`, { mode: 0o755 });
const openedLog = () => (fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8') : '');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDGgAQYGBgAAAP//AwBfDAP+IV7jywAAAABJRU5ErkJggg==', 'base64');

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const info = (name, text) => console.log(`info ${name}: ${text}`);
const j = (v) => JSON.stringify(v);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol * Math.abs(b);

let port = 0;
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/img.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
    return;
  }
  if (p === '/chips-frame') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'flow_part=1; Secure; SameSite=None; Path=/; Partitioned' });
    res.end('<!doctype html><title>frame</title>frame');
    return;
  }
  if (p === '/echo') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.headers.cookie || '(none)');
    return;
  }
  if (p === '/file.txt') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="flow-test.txt"' });
    res.end('flow download test\n');
    return;
  }
  const pages = {
    '/page.html': '<!doctype html><title>pages</title><body style="margin:0"><textarea id="t" spellcheck="true" style="display:block;width:400px;height:60px;font-size:20px"></textarea><img id="im" src="/img.png" style="display:block;width:120px;height:90px"></body>',
    '/guard.html': '<!doctype html><title>guard</title><body style="margin:0"><input id="i" style="display:block;width:200px;height:30px"><a id="next" href="/plain.html?from-guard" style="display:block;width:300px;height:40px;margin-top:20px">next</a><p style="height:300px">text</p><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script></body>',
    // the guard sits in a frame of another site (localhost, the page is on 127.0.0.1): Chromium shares user activation
    // among same-origin frames, so only a cross-origin frame shows the per-frame rule
    '/frame.html': `<!doctype html><title>frame</title><body style="margin:0"><p style="height:40px;margin:0">top</p><iframe id="f" src="http://localhost:${port}/guard.html?inner" style="display:block;width:400px;height:200px;border:0"></iframe></body>`,
    '/plain.html': '<!doctype html><title>plain</title><body style="margin:0"><p style="height:300px">plain</p></body>',
    '/tall.html': '<!doctype html><title>tall</title><body style="margin:0"><p style="height:5000px">tall</p></body>',
    '/chips.html': `<!doctype html><title>chips</title><iframe src="http://localhost:${port}/chips-frame"></iframe>`,
    '/apps.html': '<!doctype html><title>apps</title><body style="margin:0"><a id="zoom" href="zoommtg://zoom.us/join?confno=1" style="display:block;width:300px;height:40px">zoom</a><a id="zoom2" href="zoommtg://zoom.us/join?confno=2" style="display:block;width:300px;height:40px">zoom 2</a></body>',
  };
  res.writeHead(pages[p] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(pages[p] || 'not found');
});

function cleanup(signal = 'SIGTERM') {
  for (const pid of L.electronPids()) {
    try {
      process.kill(Number(pid), signal);
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
}

async function quitApp(mainp) {
  mainp.send('Runtime.evaluate', { expression: 'const { app } = require("electron"); setTimeout(() => app.quit(), 200); 1', includeCommandLineAPI: true })
    .catch((e) => console.log(`info quit: ${e.message}`));
  await L.sleep(50);
  mainp.close();
  await L.waitFor(() => L.electronPids().length === 0, 20000, 'the app to quit');
}

async function start() {
  // fake camera and microphone (xvfb has none, and getUserMedia fails before asking without a device)
  L.launch(LOG, { PATH: `${BIN}:${process.env.PATH}` }, ['--use-fake-device-for-media-stream']);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  await page.eval('window.__downloads = []; window.flow.onPageDownload((d) => window.__downloads.push(d)); return true;');
  return { page, mainp };
}

// Opens url as a page window; returns a CDP link to its guest and the guest's webContents id.
async function openPage(s, url, ready = 'document.readyState === "complete"') {
  await s.page.eval(`window.__flow.openPage(${j(url)}); return true;`);
  const t = await L.waitFor(async () => (await L.targets(L.PORT)).find((x) => x.type === 'webview' && x.url === url), 30000, `the page ${url}`);
  const g = await L.Cdp.connect(t.webSocketDebuggerUrl);
  // the target can show the new URL while the old document is still there: wait for this document itself
  await L.waitFor(() => g.eval(`return location.href === ${j(url)} && (${ready});`), 20000, `${url} to load`);
  // the host's <webview> answers only once it has seen the guest's dom-ready, which can come after the guest is loaded
  const id = await L.waitFor(() => s.page.eval(`const w = ${webview(url)}; return w ? w.getWebContentsId() : null;`), 10000, `the webview of ${url}`);
  return { g, url, id };
}
const webview = (url) => `[...document.querySelectorAll('webview')].find((w) => { try { return w.getURL() === ${j(url)}; } catch (e) { return false; } })`;
const webviewOf = (id) => `[...document.querySelectorAll('webview')].find((w) => { try { return w.getWebContentsId() === ${id}; } catch (e) { return false; } })`;
const openTestPage = (s, tag) => openPage(s, `http://127.0.0.1:${port}/page.html?${tag}`, 'document.readyState === "complete" && document.getElementById("im").complete');

async function clickIn(g, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await g.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
const clickOn = async (g, sel) => {
  const r = await g.eval(`const r = document.querySelector(${j(sel)}).getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 };`);
  await clickIn(g, r.x, r.y);
};

const cookies = (mainp, name) => mainp.eval(`const c = await require('electron').session.fromPartition('persist:flow').cookies.get({ name: ${j(name)} });
  return c.map((x) => ({ value: x.value, session: x.session, days: x.expirationDate ? Math.round((x.expirationDate - Date.now() / 1000) / 86400) : null }));`, { commandLine: true });
const cookie = async (mainp, name) => (await cookies(mainp, name))[0] || null;

async function rightClick(s, g, x, y) {
  await s.mainp.eval('globalThis.__menus = []; const { Menu } = require("electron"); if (!globalThis.__popup) globalThis.__popup = Menu.prototype.popup; Menu.prototype.popup = function () { globalThis.__menus.push(this); }; return true;', { commandLine: true });
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await g.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
  }
  return L.waitFor(() => s.mainp.eval('const m = globalThis.__menus.at(-1); return m ? m.items.map((i) => i.label).filter(Boolean) : null;'), 10000, 'the context menu');
}
const clickItem = (s, label) => s.mainp.eval(`const m = globalThis.__menus.at(-1); const i = m && m.items.find((x) => x.label === ${j(label)}); if (i) i.click(); return !!i;`);

async function appLinksGuardZoom(s, origin) {
  const urlOf = (p) => s.page.eval(`return ${webviewOf(p.id)}.getURL();`);

  // ---------- app links ask the page's window first ----------
  await s.page.eval('window.__ext = []; window.flow.onPageOpenExternal((x) => window.__ext.push(x)); return true;');
  const asked = (n) => L.waitFor(() => s.page.eval(`return window.__ext.length >= ${n} ? window.__ext[${n - 1}] : null;`), 8000, `question ${n}`).catch(() => null);
  const zoom1 = 'zoommtg://zoom.us/join?confno=1';
  const ap = await openPage(s, `${origin}/apps.html?a`);
  await clickOn(ap.g, '#zoom');
  const q1 = await asked(1);
  check('a zoommtg link asks its window first (page:open-external) and opens nothing yet', !!q1 && q1.url === zoom1 && q1.guestId === ap.id && Number.isInteger(q1.requestId) && !openedLog(),
    `${j(q1)} opened ${j(openedLog())}`);
  await s.page.eval(`window.flow.answerExternal(${q1 && q1.requestId}, false); return true;`);
  await L.sleep(1500);
  check('No: nothing opens and the page stays', !openedLog() && (await urlOf(ap)) === ap.url, `opened ${j(openedLog())}`);
  await clickOn(ap.g, '#zoom');
  const q2 = await asked(2);
  await s.page.eval(`window.flow.answerExternal(${q2 && q2.requestId}, true); return true;`);
  const opened = await L.waitFor(() => (openedLog().includes(`xdg-open ${zoom1}`) ? openedLog() : null), 8000, 'xdg-open').catch(() => openedLog());
  check('Open: the link goes to its app (xdg-open here)', !!q2 && q2.url === zoom1 && opened.trim() === `xdg-open ${zoom1}`, `${j(q2)} ${j(opened)}`);
  // main opens what a page opens only after the owner's own click or key in it (item 72): a real click first, on nothing
  await clickIn(ap.g, 3, 300);
  await ap.g.eval('window.open("slack://open?team=T1"); return true;', { gesture: true });
  const q3 = await asked(3);
  await s.page.eval(`window.flow.answerExternal(${q3 && q3.requestId}, true); return true;`);
  const slack = await L.waitFor(() => (openedLog().includes('xdg-open slack://open?team=T1') ? true : null), 8000, 'the slack link').catch(() => false);
  check('window.open of a slack: link asks the same way and opens after yes', !!q3 && q3.url === 'slack://open?team=T1' && slack, `${j(q3)} ${j(openedLog())}`);
  const logAt = fs.statSync(LOG).size;
  await clickIn(ap.g, 3, 300);
  const blob = await ap.g.eval('const u = URL.createObjectURL(new Blob(["x"])); window.open(u); return u;', { gesture: true });
  await s.page.eval('window.flow.answerExternal(987654, true); return true;');
  await L.sleep(800);
  let logged = fs.readFileSync(LOG, 'utf8').slice(logAt);
  check('a blob: popup is never offered as an app link and stays blocked; an answer to no question is refused (both logged)', (await s.page.eval('return window.__ext.length;')) === 3 &&
    logged.includes(`[flow] blocked a page popup to ${blob}`) && logged.includes('[flow] answerExternal: no open question 987654 for this window'), j(logged));
  // left unanswered: no after 60 s (checked at the end); one whose page goes away: no at once
  await clickOn(ap.g, '#zoom');
  const q4 = await asked(4);
  const unansweredAt = Date.now();
  const ap2 = await openPage(s, `${origin}/apps.html?b`);
  await clickOn(ap2.g, '#zoom2');
  const q5 = await asked(5);
  ap2.g.close();
  await s.page.eval(`${webviewOf(ap2.id)}.remove(); return true;`);
  ap.g.close();
  await L.sleep(500);
  const goneAt = fs.statSync(LOG).size;
  await s.page.eval(`window.flow.answerExternal(${q5 && q5.requestId}, true); return true;`);
  await L.sleep(800);
  const q5Settled = !!q5 && fs.readFileSync(LOG, 'utf8').slice(goneAt).includes(`[flow] answerExternal: no open question ${q5.requestId} for this window`);

  // ---------- unsaved-changes guard ----------
  await s.page.eval('window.__blocked = []; window.flow.onPageUnloadBlocked((b) => window.__blocked.push(b)); return true;');
  const blocked = () => s.page.eval('const b = window.__blocked; window.__blocked = []; return b;');
  const unsaved = (p) => s.page.eval(`return await window.flow.pageHasUnsavedChanges(${p.id});`);
  const hostLoad = (p, url) => s.page.eval(`return await ${webviewOf(p.id)}.loadURL(${j(url)}).then(() => 'loaded', (e) => 'rejected ' + e.message);`);
  const P = (q) => `${origin}/plain.html?${q}`;
  const G = (q) => `${origin}/guard.html?${q}`;
  const gp = await openPage(s, G('a'));
  const untouched = await unsaved(gp);
  const freeNav = await hostLoad(gp, P('free'));
  const freeBlocked = await blocked();
  check('a guarded page the user never touched has no unsaved changes and navigates freely', untouched === false && freeNav === 'loaded' && freeBlocked.length === 0,
    `${untouched} ${freeNav} ${j(freeBlocked)}`);
  const toGuard = async (q) => {
    await hostLoad(gp, G(q));
    await L.waitFor(() => gp.g.eval('return document.readyState === "complete" && !!document.getElementById("i");'), 10000, 'the guard page');
    await clickOn(gp.g, '#i');
    await L.sleep(200);
  };
  await toGuard('b');
  const touched = await unsaved(gp);
  const nav1 = await hostLoad(gp, P('address'));
  await L.sleep(300);
  const b1 = await blocked();
  check('once touched it has unsaved changes, and an address-bar navigation still goes through with nothing asked',
    touched === true && nav1 === 'loaded' && (await urlOf(gp)) === P('address') && b1.length === 0, `${touched} ${nav1} ${j(b1)}`);
  await toGuard('c');
  await clickOn(gp.g, '#next');
  const followed = await L.waitFor(async () => ((await urlOf(gp)) === P('from-guard') ? true : null), 10000, 'the link').catch(() => false);
  const b2 = await blocked();
  check('a link clicked in the page goes through too, with nothing asked', followed && b2.length === 0, `${await urlOf(gp)} ${j(b2)}`);
  await toGuard('d');
  await gp.g.eval('window.__before = 1; return true;');
  await rightClick(s, gp.g, 150, 200);
  await clickItem(s, 'Reload');
  const reloaded = await L.waitFor(() => gp.g.eval('return window.__before === undefined && document.readyState === "complete" ? true : null;'), 10000, 'the reload').catch(() => false);
  const b3 = await blocked();
  check('the context menu\'s Reload goes through too, with nothing asked', reloaded && b3.length === 0, `${j(b3)} reloaded ${reloaded}`);
  await s.mainp.eval('const { Menu } = require("electron"); if (globalThis.__popup) Menu.prototype.popup = globalThis.__popup; return true;', { commandLine: true });
  const fr = await openPage(s, `${origin}/frame.html?f`);
  await L.waitFor(() => s.mainp.eval(`const f = require('electron').webContents.fromId(${fr.id}).mainFrame.framesInSubtree.find((x) => x.url.startsWith('http://localhost:'));
    return f ? await f.executeJavaScript('document.readyState === "complete"') : null;`, { commandLine: true }), 15000, 'the frame of the other site');
  await clickIn(fr.g, 100, 20);
  const topOnly = await unsaved(fr);
  const inner = await fr.g.eval('const r = document.getElementById("f").getBoundingClientRect(); return { x: r.left + 20, y: r.top + 15 };');
  await clickIn(fr.g, inner.x, inner.y);
  const inFrame = await unsaved(fr);
  check('closing: a guard in a frame of another site counts once the user touched that frame', topOnly === false && inFrame === true, `top only ${topOnly}, frame touched ${inFrame}`);
  const foreign = await s.page.eval('return await window.flow.allowUnload(987654).then(() => "allowed", (e) => e.message);');
  check('a window can only act on its own pages', /no page 987654 in this window/.test(foreign), foreign);
  fr.g.close();
  gp.g.close();

  // ---------- zoom per page ----------
  const za = await openPage(s, P('za'));
  const zb = await openPage(s, P('zb'));
  const width = (p) => p.g.eval('return innerWidth;');
  const zoomTo = (p, step) => s.page.eval(`return await window.flow.zoomPage(${p.id}, ${step});`);
  const factor = (level) => 1.2 ** level;
  const w0 = [await width(za), await width(zb)];
  const in1 = await zoomTo(za, 1);
  await L.sleep(300);
  const w1 = [await width(za), await width(zb)];
  check('Zoom In zooms that page one Chrome step (110%) and not the other page of the same site', near(factor(in1), 1.1) && near(w0[0] / w1[0], 1.1, 0.03) && w1[1] === w0[1],
    `level ${in1}, widths ${j(w0)} -> ${j(w1)}`);
  const in2 = await zoomTo(za, 1);
  // main sets the zoom again when the new document commits; under load it can land a moment after the load event
  const zoomed = (since) => L.waitFor(async () => { const w = await width(za); return near(w0[0] / w, 1.25, 0.03) ? { w, ms: Date.now() - since } : null; }, 5000, 'the zoom')
    .catch(async () => ({ w: await width(za), ms: null }));
  let since = Date.now();
  const zoomNav = await hostLoad(za, P('za2'));
  const onNext = zoomNav === 'loaded' && (await urlOf(za)) === P('za2');
  const afterNav = await zoomed(since);
  await za.g.eval('window.__beforeReload = 1; return true;');
  since = Date.now();
  await s.page.eval(`${webviewOf(za.id)}.reload(); return true;`);
  const zoomReloaded = await L.waitFor(() => za.g.eval('return window.__beforeReload === undefined && document.readyState === "complete";'), 15000, 'the reload').catch(() => false);
  const afterReload = await zoomed(since);
  check('the page keeps its zoom (125%) on its next document and after a reload', near(factor(in2), 1.25) && onNext && afterNav.ms !== null && zoomReloaded && afterReload.ms !== null,
    `${in2}: ${zoomNav} ${onNext ? 'on' : 'not on'} the next document, width ${afterNav.w} ${afterNav.ms} ms after the navigation started, reloaded ${zoomReloaded}, ${afterReload.w} ${afterReload.ms} ms after the reload started`);
  const out1 = await zoomTo(za, -1);
  const reset = await zoomTo(za, 0);
  const restored = await s.page.eval(`return await window.flow.setPageZoom(${za.id}, ${Math.log(1.5) / Math.log(1.2)});`);
  await L.sleep(300);
  const w150 = await width(za);
  check('Zoom Out steps back (110%), Actual Size is 100%, setPageZoom sets a saved level (150%)', near(factor(out1), 1.1) && reset === 0 && near(factor(restored), 1.5) &&
    near(w0[0] / w150, 1.5, 0.03), `${out1} ${reset} ${restored} ${w150}`);
  const zoomItems = await s.mainp.eval(`const { Menu } = require('electron'); const page = Menu.getApplicationMenu().items.find((i) => i.label === 'Page').submenu;
    return page.items.filter((i) => /^(Zoom|Actual)/.test(i.label)).map((i) => [i.label, i.accelerator, i.visible]);`, { commandLine: true });
  check('the Page menu has Zoom In (⌘+, and ⌘= hidden), Zoom Out (⌘-) and Actual Size (⌘0)', j(zoomItems) === j([['Zoom In', 'Command+Plus', true], ['Zoom In', 'Command+=', false],
    ['Zoom Out', 'Command+-', true], ['Actual Size', 'Command+0', true]]), j(zoomItems));
  za.g.close();
  zb.g.close();

  // ---------- a tab's history and scroll come back after a restart (page.js keeps pageHistory, restorePageNext) ----------
  const T = (q) => `${origin}/tall.html?${q}`;
  const hp = await openPage(s, T('h1'));
  await hostLoad(hp, T('h2'));
  await L.waitFor(() => hp.g.eval('return location.search === "?h2" && document.readyState === "complete";'), 10000, 'the second entry');
  await hp.g.eval('window.scrollTo(0, 1234); return true;');
  await L.sleep(2000);   // Chromium writes the scroll into the entry's page state about a second after it
  const hist = await s.page.eval(`return await window.flow.pageHistory(${hp.id});`);
  check('pageHistory gives the tab\'s entries, its active index and their page states', hist.index === 1 && hist.entries.length === 2 && hist.entries[0].url === T('h1') &&
    hist.entries[1].url === T('h2') && typeof hist.entries[1].pageState === 'string' && hist.entries[1].pageState.length > 0,
    j({ index: hist.index, urls: hist.entries.map((e) => e.url), states: hist.entries.map((e) => (e.pageState || '').length) }));
  const before = new Set((await L.targets(L.PORT)).map((x) => x.id));
  const accepted = await s.page.eval(`return await window.flow.restorePageNext(${j(T('h2'))}, ${j(hist)});`);
  await s.page.eval(`const wv = document.createElement('webview'); wv.id = 'flow-restored'; wv.src = ${j(T('h2'))};
    wv.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px'; document.body.appendChild(wv); return true;`);
  const rt = await L.waitFor(async () => (await L.targets(L.PORT)).find((x) => x.type === 'webview' && !before.has(x.id) && x.url === T('h2')) || null, 15000, 'the restored page').catch(() => null);
  const rg = rt && await L.Cdp.connect(rt.webSocketDebuggerUrl);
  // the new target shows the entry's address while its document is still about:blank: wait for the entry itself
  const back = rg && await L.waitFor(() => rg.eval(`return location.href === ${j(T('h2'))} && document.readyState === "complete" ? { href: location.href, length: history.length, y: Math.round(scrollY) } : null;`), 10000, 'the restored page to load')
    .catch(() => rg.eval('return { href: location.href, length: history.length, y: Math.round(scrollY) };'));
  check('a new webview after restorePageNext comes back at that entry, with its back history and its scroll', accepted === true && !!back && back.href === T('h2') &&
    back.length === 2 && Math.abs(back.y - 1234) <= 2, `${accepted} ${j(back)}`);
  const refused = await s.page.eval(`return await window.flow.restorePageNext(${j(T('x'))}, { index: 0, entries: [{ url: 'file:///etc/passwd' }] });`);
  check('a history with an entry that is not http(s) is refused', refused === false, j(refused));
  if (rg) rg.close();
  hp.g.close();
  await s.page.eval('document.getElementById("flow-restored").remove(); return true;');
  // every page runs in persist:flow, whatever partition its <webview> asked for (or none)
  for (const [id, attr] of [['flow-nopart', null], ['flow-otherpart', 'persist:elsewhere']]) {
    await s.page.eval(`const wv = document.createElement('webview'); wv.id = ${j(id)}; ${attr ? `wv.setAttribute('partition', ${j(attr)});` : ''} wv.src = ${j(P(id))};
      wv.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px'; document.body.appendChild(wv); return true;`);
  }
  const sessionsOf = await L.waitFor(() => s.mainp.eval(`const { webContents, session } = require('electron'); const flow = session.fromPartition('persist:flow');
    const g = webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && /flow-(no|other)part/.test(w.getURL()));
    return g.length === 2 ? g.map((w) => w.session === flow) : null;`, { commandLine: true }), 10000, 'the two webviews').catch(() => null);
  check('a <webview> with no partition or another one still runs in persist:flow', j(sessionsOf) === j([true, true]), j(sessionsOf));
  await s.page.eval('for (const id of ["flow-nopart", "flow-otherpart"]) document.getElementById(id).remove(); return true;');
  // a workspace file's tab (files.js: a signed flow-file: address) comes back the same way. The file sits in the
  // workspace's folder (this test's userData), which files-main.js requires before it serves a file.
  const mdDir = path.join(L.USER_DATA, 'files-test');
  fs.mkdirSync(mdDir, { recursive: true });
  const md = path.join(mdDir, 'long.md');
  fs.writeFileSync(md, Array.from({ length: 3000 }, (_, i) => `line ${i} of a long markdown file`).join('\n'));
  const signed = await s.mainp.eval(`return await require(${j(path.join(L.ROOT, 'src', 'files-main.js'))}).open(null, ${j(md)});`, { commandLine: true });
  if (!signed || !signed.url) check('a workspace file\'s tab comes back with its scroll', false, j(signed));
  else {
    const fp = await openPage(s, signed.url);
    await fp.g.eval('window.scrollTo(0, 2345); return true;');
    await L.sleep(2000);
    const fh = await s.page.eval(`return await window.flow.pageHistory(${fp.id});`);
    const seen = new Set((await L.targets(L.PORT)).map((x) => x.id));
    const took = await s.page.eval(`return await window.flow.restorePageNext(${j(signed.url)}, ${j(fh)});`);
    await s.page.eval(`const wv = document.createElement('webview'); wv.id = 'flow-restored-file'; wv.src = ${j(signed.url)};
      wv.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px'; document.body.appendChild(wv); return true;`);
    const ft = await L.waitFor(async () => (await L.targets(L.PORT)).find((x) => x.type === 'webview' && !seen.has(x.id) && x.url === signed.url) || null, 15000, 'the restored file').catch(() => null);
    const fg = ft && await L.Cdp.connect(ft.webSocketDebuggerUrl);
    const fback = fg && await L.waitFor(() => fg.eval('return location.protocol === "flow-file:" && document.readyState === "complete" ? { y: Math.round(scrollY), text: document.body.innerText.slice(0, 20) } : null;'), 10000, 'the restored file to load')
      .catch(() => fg.eval('return { href: location.href, y: Math.round(scrollY) };'));
    check('a workspace file\'s tab (flow-file:) comes back at its scroll after restorePageNext', took === true && !!fback && Math.abs(fback.y - 2345) <= 2 && fback.text.startsWith('line 0'),
      `${took} ${j(fback)}`);
    if (fg) fg.close();
    fp.g.close();
    await s.page.eval('document.getElementById("flow-restored-file").remove(); return true;');
  }

  // the unanswered app link: no after 60 s; the one whose page went away ended then, so it is never logged as unanswered
  const left = 61000 - (Date.now() - unansweredAt);
  if (left > 0) await L.sleep(left);
  logged = fs.readFileSync(LOG, 'utf8');
  check('no answer in 60 s is no; a question whose page went away ends with it', !!q4 && !!q5 && q5.url === 'zoommtg://zoom.us/join?confno=2' && q5Settled &&
    logged.includes('[flow] no answer about opening zoommtg://zoom.us/join?confno=1 in 60 s, not opened') && !logged.includes('confno=2 in 60 s') &&
    openedLog().split('\n').filter((l) => l.includes('zoommtg')).length === 1, `${j(q4)} ${j(q5)} ${j(openedLog())}`);
}

async function run() {
  cleanup('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  // a saved answer for this origin: notifications allowed
  fs.writeFileSync(STATE_FILE, j({ v: 11, ws: [{ id: 'pg', name: 'pg', folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {},
    permissions: { [`${origin} notifications`]: true, [`${origin} media:audio`]: false, [`http://localhost:${port} notifications`]: false } }));
  console.log(`app log: ${LOG}`);

  let s = await start();
  let { g, url } = await openTestPage(s, 'one');

  // permissions: the saved answer is used without a dialog; a new one is asked once and saved
  await s.mainp.eval('globalThis.__asked = 0; const { dialog } = require("electron"); globalThis.__box = dialog.showMessageBox; dialog.showMessageBox = async () => { globalThis.__asked++; return { response: 0 }; }; return true;', { commandLine: true });
  const notif = await g.eval('return await Notification.requestPermission();', { gesture: true });
  check('a saved permission answer is used without asking', notif === 'granted' && (await s.mainp.eval('return globalThis.__asked;')) === 0, `${notif}, asked ${await s.mainp.eval('return globalThis.__asked;')}`);
  const geo = await g.eval('return await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r("allowed"), (e) => r("error " + e.code), { timeout: 4000 }));', { gesture: true });
  // the state file is written by the store's debounced save: under load it can take a moment
  const savedPerms = (key) => L.waitFor(() => { const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).permissions || {}; return key in p ? p : null; }, 5000, `${key} on disk`)
    .catch(() => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).permissions || {});
  const savedPerm = (await savedPerms(`${origin} geolocation`))[`${origin} geolocation`];
  check('a new answer is asked once and saved in the state file', (await s.mainp.eval('return globalThis.__asked;')) === 1 && savedPerm === true, `asked ${await s.mainp.eval('return globalThis.__asked;')}, saved ${j(savedPerm)}, page ${geo}`);
  // what pages read is the saved answer, the microphone and the camera apart; one never asked reads granted
  const reads = await g.eval(`return { notification: Notification.permission, mic: (await navigator.permissions.query({ name: 'microphone' })).state,
    camera: (await navigator.permissions.query({ name: 'camera' })).state };`);
  check('a page reads its saved answers (notifications granted, microphone denied); the camera, never asked, reads granted', j(reads) === j({ notification: 'granted', mic: 'denied', camera: 'granted' }), j(reads));
  const cam = await g.eval('return await navigator.mediaDevices.getUserMedia({ video: true }).then(() => "stream", (e) => e.name);', { gesture: true });
  const perms = await savedPerms(`${origin} media:video`);
  check('the camera is asked about apart from the denied microphone and saved as its own answer', (await s.mainp.eval('return globalThis.__asked;')) === 2 &&
    perms[`${origin} media:video`] === true && perms[`${origin} media:audio`] === false, `asked ${await s.mainp.eval('return globalThis.__asked;')}, page ${cam}, saved ${j(perms)}`);
  const lh = await openPage(s, `http://localhost:${port}/plain.html?perm`);
  const lhRead = await lh.g.eval(`return { notification: Notification.permission, shown: await new Promise((r) => { const n = new Notification('flow test'); n.onshow = () => r('shown');
    n.onerror = () => r('refused'); setTimeout(() => r('neither in 2 s'), 2000); }) };`, { gesture: true });
  check('a site the user said no to reads notifications denied and cannot show one', lhRead.notification === 'denied' && lhRead.shown === 'refused', j(lhRead));
  lh.g.close();

  // cookies
  await g.eval('document.cookie = "flow_persist=1; max-age=3600; path=/"; document.cookie = "flow_session=1; path=/"; return document.cookie;');
  await L.sleep(500);
  const sess = await cookie(s.mainp, 'flow_session');
  check('a session cookie is kept for 30 days', !!sess && sess.session === false && sess.days === 30, j(sess));
  // a partitioned session cookie set by a frame of another site: Electron cannot tell it is partitioned, so it is not
  // copied (a copy would be unpartitioned and sent to that site everywhere)
  const chips = await openPage(s, `${origin}/chips.html`);
  await L.sleep(500);
  const parts = await cookies(s.mainp, 'flow_part');
  const echo = await openPage(s, `http://localhost:${port}/echo`);
  const sent = await echo.g.eval('return document.body.innerText;');
  check('a partitioned session cookie from a frame of another site stays as it was (one cookie, a session one, not sent to that site at top level)',
    parts.length === 1 && parts[0].session === true && !sent.includes('flow_part'), `${j(parts)}, localhost got ${j(sent)}`);
  chips.g.close();
  echo.g.close();

  // downloads, twice the same name
  await s.mainp.eval(`const { webContents } = require('electron'); const w = webContents.getAllWebContents().find((x) => x.getType() === 'webview' && x.getURL() === ${j(url)});
    w.downloadURL(${j(origin + '/file.txt')}); w.downloadURL(${j(origin + '/file.txt')}); return true;`, { commandLine: true });
  const dls = await L.waitFor(() => s.page.eval('return window.__downloads.length >= 2 ? window.__downloads : null;'), 15000, 'two downloads').catch(() => []);
  const files = dls.map((d) => d.file).sort();
  check('downloads go to the downloads folder without a dialog, "(1)" on a clash, and the window hears page:download',
    j(files) === j([path.join(DOWNLOADS, 'flow-test (1).txt'), path.join(DOWNLOADS, 'flow-test.txt')]) && dls.every((d) => d.state === 'completed' && d.bytes === 19 && fs.existsSync(d.file)),
    j(dls.map(({ file, state, bytes }) => ({ file, state, bytes }))));
  const logAt = fs.statSync(LOG).size;
  await s.page.eval('window.flow.showItemInFolder("/etc/passwd"); return true;');
  await L.sleep(500);
  check('showItemInFolder refuses a file Flow did not download', /\[flow\] showItemInFolder refused \/etc\/passwd/.test(fs.readFileSync(LOG, 'utf8').slice(logAt)));

  // context menu. Spelling: macOS uses its own spellchecker; Linux uses Hunspell dictionaries picked by language and
  // fetched on first use, so this dev-only test sets en-US there.
  const spell = await s.mainp.eval(`const ses = require('electron').session.fromPartition('persist:flow');
    globalThis.__dict = []; for (const ev of ['spellcheck-dictionary-initialized', 'spellcheck-dictionary-download-begin', 'spellcheck-dictionary-download-success', 'spellcheck-dictionary-download-failure']) ses.on(ev, (_e, lang) => globalThis.__dict.push(ev.replace('spellcheck-dictionary-', '') + ' ' + lang));
    const before = ses.getSpellCheckerLanguages();
    // set afresh, not to what it is already: Chromium fetches a missing dictionary when its language is set, and the fetch
    // at start does not always come (/tmp/flow-main-evidence/dict/fetch.out)
    if (process.platform !== 'darwin') { ses.setSpellCheckerLanguages([]); ses.setSpellCheckerLanguages(['en-US']); }
    return { before, now: ses.getSpellCheckerLanguages() };`, { commandLine: true });
  info('spellchecker languages', j(spell));
  // Focus the window, the webview and the field, and type through the guest's input like the OS would.
  await s.mainp.eval('require("electron").BrowserWindow.getAllWindows()[0].focus(); return true;', { commandLine: true });
  await s.page.eval(`const w = [...document.querySelectorAll('webview')].find((x) => { try { return x.getURL() === ${j(url)}; } catch (e) { return false; } }); w.focus(); return true;`);
  await g.eval('const t = document.getElementById("t"); t.focus(); return true;');
  // The spelling dictionary is fetched at start (Dictionaries/*.bdic, about 2 s here): the test types once it is there,
  // so a fetch slowed by load does not decide the check.
  const dictAt = Date.now();
  const dict = await L.waitFor(() => (fs.existsSync(path.join(L.USER_DATA, 'Dictionaries')) && fs.readdirSync(path.join(L.USER_DATA, 'Dictionaries')).some((f) => f.endsWith('.bdic'))) || null,
    30000, 'the spelling dictionary').then(() => true, () => false);
  info('spelling dictionary', dict ? `there ${Date.now() - dictAt} ms after the test looked` : 'not there after 30 s');
  await s.mainp.eval(`const { webContents } = require('electron'); const w = webContents.getAllWebContents().find((x) => x.getType() === 'webview' && x.getURL() === ${j(url)});
    for (const ch of 'teh quick brwn fox ') w.sendInputEvent({ type: 'char', keyCode: ch }); return true;`, { commandLine: true });
  await L.sleep(1500);
  const editLabels = await rightClick(s, g, 60, 30);
  check('in a text field the menu has Cut, Copy, Paste and Select All', ['Cut', 'Copy', 'Paste', 'Select All'].every((l) => editLabels.includes(l)), j(editLabels));
  const imgBox = await g.eval('const r = document.getElementById("im").getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 };');
  const imgLabels = await rightClick(s, g, imgBox.x, imgBox.y);
  check('on an image the menu has Open Image in New Page, Copy Image, Copy Image Address and Save Image',
    ['Open Image in New Page', 'Copy Image', 'Copy Image Address', 'Save Image'].every((l) => imgLabels.includes(l)), j(imgLabels));
  await clickItem(s, 'Copy Image Address');
  const copied = await L.waitFor(() => s.mainp.eval('return await require("electron").clipboard.readText();', { commandLine: true }), 5000, 'the image address').catch(() => '');
  check('Copy Image Address copies the image URL', copied === `${origin}/img.png`, j(copied));
  await clickItem(s, 'Save Image');
  const saved = await L.waitFor(() => s.page.eval('return window.__downloads.find((d) => d.file.endsWith("img.png")) || null;'), 15000, 'the saved image').catch(() => null);
  check('Save Image saves it to the downloads folder', !!saved && saved.state === 'completed' && path.dirname(saved.file) === DOWNLOADS && fs.existsSync(saved.file), j(saved));
  // spelling: here Chromium marks a field's misspelled words when the field loses the focus, not while it keeps it
  // (/tmp/flow-main-evidence/dict/spell-*.out), so the field gives the focus up before each right-click on "teh"
  const wordAt = await g.eval('const t = document.getElementById("t"); const r = t.getBoundingClientRect(); return { x: r.left + 14, y: r.top + 16 };');
  let spellLabels = [];
  for (const until = Date.now() + 30000; !spellLabels.includes('Add to Dictionary') && Date.now() < until;) {
    await g.eval('document.getElementById("t").blur(); return true;');
    await L.sleep(300);
    spellLabels = await rightClick(s, g, wordAt.x, wordAt.y);
    if (!spellLabels.includes('Add to Dictionary')) await L.sleep(2000);
  }
  info('dictionary events', j(await s.mainp.eval('return globalThis.__dict;')));
  check('on a misspelled word the menu offers spelling suggestions and Add to Dictionary', spellLabels.includes('Add to Dictionary'), j(spellLabels));
  await s.mainp.eval('const { Menu } = require("electron"); if (globalThis.__popup) Menu.prototype.popup = globalThis.__popup; return true;', { commandLine: true });
  g.close();

  await appLinksGuardZoom(s, origin);

  // kill -9 three seconds after setting a cookie
  ({ g } = await openTestPage(s, 'two'));
  await g.eval('document.cookie = "flow_fresh=1; max-age=3600; path=/"; return true;');
  g.close();
  await L.sleep(3000);
  s.page.close();
  s.mainp.close();
  cleanup('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the killed app to be gone');
  s = await start();
  const fresh = await cookie(s.mainp, 'flow_fresh');
  check('a cookie set 3 s before kill -9 is still there after the relaunch', !!fresh && fresh.value === '1', j(fresh));
  // a normal quit keeps the session cookie, and the saved permission answer is used without asking
  await quitApp(s.mainp);
  s = await start();
  const sessAfter = await cookie(s.mainp, 'flow_session');
  check('the session cookie survives a quit and relaunch', !!sessAfter && sessAfter.value === '1', j(sessAfter));
  await s.mainp.eval('globalThis.__asked = 0; const { dialog } = require("electron"); dialog.showMessageBox = async () => { globalThis.__asked++; return { response: 1 }; }; return true;', { commandLine: true });
  ({ g } = await openTestPage(s, 'three'));
  const geo2 = await g.eval('return await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r("allowed"), (e) => r("error " + e.code), { timeout: 4000 }));', { gesture: true });
  check('after a relaunch the saved answer is used without asking', (await s.mainp.eval('return globalThis.__asked;')) === 0 && geo2 !== 'error 1', `asked ${await s.mainp.eval('return globalThis.__asked;')}, page ${geo2}`);
  g.close();
  s.page.close();
  await quitApp(s.mainp);
}

try {
  await run();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  server.close();
  cleanup('SIGKILL');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.rmSync(BIN, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




