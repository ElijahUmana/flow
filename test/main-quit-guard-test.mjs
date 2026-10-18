// Quitting or closing a Flow window never silently drops a page's unsaved changes (principle 5): Electron destroys
// webviews without running their beforeunload, so main asks the pages first. In the real app on a light state:
//   a window that shows unsaved pages (flow.onUnsavedPages) and holds a guarded page the user touched: app.quit() waits,
//   the window stays on screen and gets window:unsaved-pages { action: 'quit', pages }; flow.closeAnyway('quit') quits;
//   with every page clean, the quit goes on at once, and a guarded page the owner only clicked (never typed in) counts as
//   clean: only pages the owner typed or pasted in are asked (item 74), so a window with none leaves the screen at once
//   even when asking its page would be slow, and one the owner typed in waits while it is asked;
//   closing the window waits the same way ({ action: 'close' }); flow.closeAnyway('close') closes it, the window leaving
//   the screen at once and saving what it shows (window:flush-pages) before it closes.
//   node test/main-quit-guard-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-quitguard-${Date.now()}.log`);
const STATE_FILE = path.join(L.USER_DATA, 'flow-state.json');
const EVENTS = path.join(os.tmpdir(), `flow-dev-main-quitguard-events-${process.pid}`);

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);

const server = http.createServer((req, res) => {
  const guarded = req.url.startsWith('/guard');
  res.writeHead(200, { 'content-type': 'text/html' });
  // a page whose beforeunload takes 1.5 s: asking it holds a close for the 1 s main gives each frame
  if (req.url.startsWith('/slow')) {
    res.end('<!doctype html><title>slow</title><body style="margin:0"><input id="i" style="display:block;width:200px;height:30px">' +
      '<script>addEventListener("beforeunload", () => { const t = Date.now(); while (Date.now() - t < 1500); });</script></body>');
    return;
  }
  res.end(`<!doctype html><title>${guarded ? 'guarded' : 'plain'}</title><body style="margin:0"><input id="i" style="display:block;width:200px;height:30px">` +
    (guarded ? '<script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script>' : '') + '</body>');
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

async function start() {
  L.launch(LOG);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  await page.eval('window.__unsaved = []; window.flow.onUnsavedPages((x) => window.__unsaved.push(x)); return true;');
  return { page, mainp };
}

async function openPage(s, url) {
  await s.page.eval(`window.__flow.openPage(${j(url)}); return true;`);
  const t = await L.waitFor(async () => (await L.targets(L.PORT)).find((x) => x.type === 'webview' && x.url === url), 30000, `the page ${url}`);
  const g = await L.Cdp.connect(t.webSocketDebuggerUrl);
  // a webview's first document is about:blank, also "complete"
  await L.waitFor(() => g.eval(`return location.href === ${j(url)} && document.readyState === "complete";`), 20000, `${url} to load`);
  const id = await L.waitFor(() => s.page.eval(`const w = [...document.querySelectorAll('webview')].find((x) => { try { return x.getURL() === ${j(url)}; } catch (e) { return false; } });
    return w ? w.getWebContentsId() : null;`), 10000, `the webview of ${url}`);
  return { g, id, url };
}

// The owner clicks the page's field, and with typing, types a letter in it (as rawKeyDown, the form main sees keys in).
async function touch(p, typing = true) {
  const r = await p.g.eval('const r = document.getElementById("i").getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 };');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await p.g.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  const landed = await p.g.eval('return document.activeElement && document.activeElement.id === "i" && navigator.userActivation.hasBeenActive;');
  if (!landed) throw new Error('the click did not land in the page\'s field');
  if (typing) {
    for (const type of ['rawKeyDown', 'char', 'keyUp']) {
      await p.g.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, ...(type === 'char' ? { text: 'a' } : {}) });
    }
  }
  await L.sleep(200);
}

// require exists only while the evaluation runs, so app is taken before the timeout
const askQuit = (s) => s.mainp.send('Runtime.evaluate', { expression: 'const { app } = require("electron"); setTimeout(() => app.quit(), 0); 1', includeCommandLineAPI: true })
  .catch((e) => console.log(`info quit: ${e.message}`));
const gone = () => L.waitFor(() => L.electronPids().length === 0, 15000, 'the app to quit').then(() => true, () => false);
const shown = (s) => s.mainp.eval('return require("electron").BrowserWindow.getAllWindows().map((w) => w.isVisible());', { commandLine: true });

async function run() {
  cleanup('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, j({ v: 11, ws: [{ id: 'qg', name: 'qg', folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  console.log(`app log: ${LOG}`);

  // a quit waits for a touched guarded page
  let s = await start();
  const plain = await openPage(s, `${origin}/plain?1`);
  await touch(plain);
  const guarded = await openPage(s, `${origin}/guard?1`);
  await touch(guarded);
  await askQuit(s);
  await L.sleep(2500);
  const held = await s.page.eval('return window.__unsaved;');
  const shownHeld = await shown(s);
  check('app.quit() waits while a page has unsaved changes, the window stays on screen and is told which', L.electronPids().length > 0 && held.length === 1 &&
    held[0].action === 'quit' && j(held[0].pages) === j([{ guestId: guarded.id, url: guarded.url, title: 'guarded' }]) && j(shownHeld) === j([true]), j({ held, shownHeld }));
  await s.page.eval('window.flow.closeAnyway("quit"); return true;');
  plain.g.close();
  guarded.g.close();
  s.page.close();
  s.mainp.close();
  check('Quit anyway quits', await gone());

  // every page clean: the quit goes on at once
  s = await start();
  const clean = await openPage(s, `${origin}/plain?2`);
  await touch(clean);
  const untouched = await openPage(s, `${origin}/guard?2`);
  await touch(untouched, false);
  clean.g.close();
  untouched.g.close();
  await askQuit(s);
  s.page.close();
  s.mainp.close();
  check('with every page clean (a guarded page the owner clicked but never typed in included), the quit goes on', await gone());

  // only pages the owner typed in are asked: a window whose page is slow to ask leaves the screen at once unless typed in
  for (const typing of [false, true]) {
    s = await start();
    const sp = await openPage(s, `${origin}/slow?${typing ? 't' : 'c'}`);
    await touch(sp, typing);
    sp.g.close();
    fs.rmSync(EVENTS, { force: true });
    await s.mainp.eval(`const { BrowserWindow } = require('electron'); const fs = require('fs');
      const note = (what) => fs.appendFileSync(${j(EVENTS)}, what + ' ' + Date.now() + '\\n');
      const w = BrowserWindow.getAllWindows()[0];
      w.on('hide', () => note('hide'));
      note('close');
      w.close();
      return true;`, { commandLine: true });
    s.page.close();
    s.mainp.close();
    const closed = await gone();
    const ev = fs.existsSync(EVENTS) ? Object.fromEntries(fs.readFileSync(EVENTS, 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([w, t]) => [w, Number(t)])) : {};
    const offAfter = ev.hide && ev.close ? ev.hide - ev.close : null;
    check(typing ? 'a window whose page the owner typed in waits while that page is asked (here 1 s, its beforeunload being slow), then closes'
      : 'a window whose page the owner only clicked is not asked: it leaves the screen at once, though asking that page would take 1 s',
    closed && offAfter !== null && (typing ? offAfter >= 900 : offAfter < 600), `off the screen ${offAfter} ms after the close`);
    fs.rmSync(EVENTS, { force: true });
  }

  // closing the window waits the same way
  s = await start();
  const g2 = await openPage(s, `${origin}/guard?3`);
  await touch(g2);
  await s.mainp.eval('require("electron").BrowserWindow.getAllWindows()[0].close(); return true;', { commandLine: true });
  await L.sleep(2500);
  const heldClose = await s.page.eval('return window.__unsaved;');
  const shownClose = await shown(s);
  check('closing the window waits too, on screen: { action: "close" } with the page', j(shownClose) === j([true]) && heldClose.length === 1 &&
    heldClose[0].action === 'close' && heldClose[0].pages.length === 1 && heldClose[0].pages[0].guestId === g2.id, `shown ${j(shownClose)}, ${j(heldClose)}`);
  g2.g.close();
  fs.rmSync(EVENTS, { force: true });
  await s.mainp.eval(`const { ipcMain, BrowserWindow } = require('electron'); const fs = require('fs');
    const note = (what) => fs.appendFileSync(${j(EVENTS)}, what + ' ' + Date.now() + '\\n');
    const w = BrowserWindow.getAllWindows()[0];
    w.on('hide', () => note('hide'));
    w.on('closed', () => note('closed'));
    ipcMain.on('window:pages-flushed', () => note('flushed'));
    return true;`, { commandLine: true });
  await s.page.eval('window.flow.onFlushPages(() => new Promise((r) => setTimeout(r, 300))); window.flow.closeAnyway("close"); return true;');
  s.page.close();
  s.mainp.close();
  const closed = await gone();
  const ev = fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]) : [];
  check('Close anyway closes the window (on Linux the last window quits the app): it leaves the screen first, then saves what it shows',
    closed && j(ev) === j(['hide', 'flushed', 'closed']), j(ev));
  fs.rmSync(EVENTS, { force: true });
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
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




