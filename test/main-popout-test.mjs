// Pop-outs come back after a quit or a crash, where they were (owner: "set it self up ... the exact way ... you left
// it"). A light state (two workspaces, no terminals), two pop-outs, one of them moved; then:
//   quit and relaunch, kill -9 and relaunch: both pop-outs return with their hash and bounds;
//   a pop-out the user closed stays closed; one for a workspace that is gone is dropped from the list;
//   with FLOW_BACKGROUND=1 the restored pop-outs are shown without focus;
//   the list of popped-out spaces (flow.popouts, onPopouts, focusPopout), and a space already out comes forward when
//   opened again instead of opening twice;
//   a sub-workspace removed while popped out (nav, batch 9): flow.closePopout closes its pop-out the usual way, its
//   pages saved first, and gives its frame; null for a space no window holds; openWindow(hash, frame) opens it there
//   again; a pop-out whose page has unsaved changes closes too, with nothing asked or shown (owner, Nov 1 20:46).
//   node test/main-popout-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-popout-${Date.now()}.log`);
const STATE_FILE = path.join(L.USER_DATA, 'flow-state.json');
const ws = (id) => ({ id, name: id, folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [] });
const STATE = { v: 11, ws: [ws('pa'), ws('pb')], ui: {} };
const MOVED = { x: 210, y: 140, width: 900, height: 600 };

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const disk = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const box = (b) => b && { x: b.x, y: b.y, width: b.width, height: b.height };

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

const windows = (mainp) => mainp.eval(`const { BrowserWindow } = require('electron');
  return BrowserWindow.getAllWindows().map((w) => ({ hash: (w.webContents.getURL().split('#')[1] || ''), bounds: w.getBounds(), visible: w.isVisible(), focused: w.isFocused() }))
    .sort((a, b) => a.hash.localeCompare(b.hash));`, { commandLine: true });
const popsOf = (list) => list.filter((w) => w.hash).map((w) => ({ hash: w.hash, bounds: box(w.bounds) }));

async function start(env = {}, count) {
  L.launch(LOG, env);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  const list = await L.waitFor(async () => {
    const l = await windows(mainp);
    return l.length === count && l.every((w) => w.visible) && l.filter((w) => w.hash).length === count - 1 ? l : null;
  }, 30000, `${count} visible windows`);
  return { page, mainp, list };
}

async function run() {
  cleanup('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, j(STATE));
  console.log(`app log: ${LOG}`);

  // two pop-outs, one moved
  let s = await start({}, 1);
  await s.page.eval('window.__pops = []; window.flow.onPopouts((l) => window.__pops.push(l)); window.flow.openWindow("solo=pa"); window.flow.openWindow("solo=pb"); return true;');
  await L.waitFor(async () => (await windows(s.mainp)).filter((w) => w.hash).length === 2, 20000, 'two pop-outs');
  await s.mainp.eval(`const { BrowserWindow } = require('electron'); BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#solo=pb')).setBounds(${j(MOVED)}); return true;`, { commandLine: true });
  // the move is saved after a 400 ms debounce; under load it can take longer
  await L.waitFor(() => { const p = (disk().popouts || []).find((x) => x.hash === 'solo=pb'); return p && j(box(p.bounds)) === j(MOVED); }, 10000, 'the moved bounds on disk').catch(() => null);
  const open1 = popsOf(await windows(s.mainp));
  const saved = disk().popouts || [];
  check('the state file lists both open pop-outs with their bounds', j(saved.map((p) => p.hash).sort()) === j(['solo=pa', 'solo=pb']) &&
    j(box(saved.find((p) => p.hash === 'solo=pb').bounds)) === j(MOVED), j(saved));
  const loaded = await s.page.eval('return await window.flow.loadState();');
  check('loadState never returns main\'s popouts key', !!loaded && !('popouts' in loaded) && !('bounds' in loaded));

  // the list of popped-out spaces every Flow window gets (nav: the main window shows such a space as in another window)
  const byWs = (l) => l.slice().sort((a, b) => (a.ws + a.zone).localeCompare(b.ws + b.zone));
  const spaces = await s.page.eval('return await window.flow.popouts();');
  check('flow.popouts() lists the open pop-outs as { ws, zone }', j(byWs(spaces)) === j([{ ws: 'pa', zone: null }, { ws: 'pb', zone: null }]), j(spaces));
  const heard = await s.page.eval('return window.__pops;');
  check('each opening reaches the main window as it happens (onPopouts)', heard.length === 2 && heard[0].length === 1 && j(byWs(heard[1])) === j(byWs(spaces)), j(heard));
  const focusedHash = () => s.mainp.eval(`const w = require('electron').BrowserWindow.getFocusedWindow(); return w ? (w.webContents.getURL().split('#')[1] || '') : null;`, { commandLine: true });
  await s.mainp.eval(`require('electron').BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#solo=pb')).focus(); return true;`, { commandLine: true });
  const pbFirst = await L.waitFor(async () => ((await focusedHash()) === 'solo=pb' ? 'solo=pb' : null), 5000, 'pb in front first').catch(() => focusedHash());
  await s.page.eval('window.flow.openWindow("solo=pa"); return true;');
  const dupFocus = await L.waitFor(async () => ((await focusedHash()) === 'solo=pa' ? 'solo=pa' : null), 5000, 'pa in front').catch(() => focusedHash());
  const afterDup = await windows(s.mainp);
  check('opening a space that is already out brings its pop-out forward instead of a second window', pbFirst === 'solo=pb' && afterDup.length === 3 && dupFocus === 'solo=pa',
    `pb in front first ${pbFirst}, ${afterDup.length} windows, focused ${dupFocus}`);
  const fb = await s.page.eval('return await window.flow.focusPopout({ ws: "pb", zone: null });');
  const fbFocus = await L.waitFor(async () => ((await focusedHash()) === 'solo=pb' ? 'solo=pb' : null), 5000, 'pb in front').catch(() => focusedHash());
  const fGone = await s.page.eval('return await window.flow.focusPopout({ ws: "gone" });');
  check('focusPopout brings that pop-out forward; a space with no pop-out gives false', fb === true && fbFocus === 'solo=pb' && fGone === false, `${fb} ${fbFocus} ${fGone}`);
  await s.page.eval('window.flow.openWindow("solo=pa&zone=z1"); return true;');
  await L.waitFor(async () => (await windows(s.mainp)).some((w) => w.hash === 'solo=pa&zone=z1'), 20000, 'the sub-workspace pop-out');
  const withZone = await s.page.eval('return await window.flow.popouts();');
  check('a sub-workspace pop-out is a space of its own: { ws, zone }', j(byWs(withZone)) === j([{ ws: 'pa', zone: null }, { ws: 'pa', zone: 'z1' }, { ws: 'pb', zone: null }]), j(withZone));
  await s.mainp.eval(`const { BrowserWindow } = require('electron'); BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#solo=pa&zone=z1')).close(); return true;`, { commandLine: true });
  await L.waitFor(async () => (await windows(s.mainp)).length === 3, 10000, 'the sub-workspace pop-out to close');
  await L.sleep(300);
  const lastHeard = (await s.page.eval('return window.__pops;')).at(-1);
  check('closing a pop-out sends the list without it', j(byWs(lastHeard)) === j([{ ws: 'pa', zone: null }, { ws: 'pb', zone: null }]), j(lastHeard));

  // quit and relaunch
  s.page.close();
  await quitApp(s.mainp);
  check('a quit keeps both pop-outs on the list', j((disk().popouts || []).map((p) => p.hash).sort()) === j(['solo=pa', 'solo=pb']), j(disk().popouts));
  s = await start({}, 3);
  check('after a quit and relaunch both pop-outs are back with their hash and bounds', j(popsOf(s.list)) === j(open1), `${j(popsOf(s.list))} vs ${j(open1)}`);

  // kill -9 and relaunch
  s.page.close();
  s.mainp.close();
  cleanup('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the killed app to be gone');
  await L.sleep(500);
  s = await start({}, 3);
  check('after kill -9 and relaunch both pop-outs are back with their hash and bounds', j(popsOf(s.list)) === j(open1), `${j(popsOf(s.list))} vs ${j(open1)}`);

  // the user closes one: it stays closed
  await s.mainp.eval(`const { BrowserWindow } = require('electron'); BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#solo=pa')).close(); return true;`, { commandLine: true });
  await L.waitFor(async () => (await windows(s.mainp)).length === 2, 10000, 'the closed pop-out to go');
  check('closing a pop-out takes it off the list at once', j((disk().popouts || []).map((p) => p.hash)) === j(['solo=pb']), j(disk().popouts));
  s.page.close();
  await quitApp(s.mainp);
  s = await start({}, 2);
  check('after a relaunch only the pop-out still open comes back', j(popsOf(s.list).map((p) => p.hash)) === j(['solo=pb']), j(popsOf(s.list)));
  s.page.close();
  await quitApp(s.mainp);

  // a pop-out of a workspace that is gone is dropped
  const doc = disk();
  doc.popouts.push({ hash: 'solo=gone', bounds: { x: 300, y: 200, width: 800, height: 500 } });
  fs.writeFileSync(STATE_FILE, j(doc));
  s = await start({}, 2);
  await L.sleep(600);
  check('a pop-out of a workspace that no longer exists is not reopened and leaves the list', !s.list.some((w) => w.hash === 'solo=gone') &&
    !(disk().popouts || []).some((p) => p.hash === 'solo=gone'), `${j(s.list.map((w) => w.hash))} ${j(disk().popouts)}`);
  s.page.close();
  await quitApp(s.mainp);

  // FLOW_BACKGROUND=1: restored pop-outs are shown without focus
  const at = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  s = await start({ FLOW_BACKGROUND: '1' }, 2);
  await L.sleep(500);
  const bgList = await windows(s.mainp);
  const lines = fs.readFileSync(LOG, 'utf8').slice(at).split('\n').filter((l) => l.startsWith('[flow] background:'));
  check('with FLOW_BACKGROUND=1 the restored pop-out is shown without focus', bgList.every((w) => w.visible && !w.focused) &&
    lines.includes('[flow] background: solo=pb shown inactive, isFocused=false') && !lines.some((l) => l.includes('got focus')), `${j(bgList)} ${j(lines)}`);
  s.page.close();
  await quitApp(s.mainp);

  // a sub-workspace removed while it is popped out
  s = await start({}, 2);
  const FRAME = { x: 260, y: 180, width: 820, height: 560 };
  const byHash = (h) => `require('electron').BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(${j('#' + h)}))`;
  await s.page.eval('window.flow.openWindow("solo=pa&zone=z2"); return true;');
  // its page has started (it saves what it shows when asked)
  (await L.flowPage((t) => t.type === 'page' && t.url.endsWith('#solo=pa&zone=z2'))).close();
  await s.mainp.eval(`const w = ${byHash('solo=pa&zone=z2')}; w.setBounds(${j(FRAME)}); globalThis.__flushAsked = 0; const send = w.webContents.send.bind(w.webContents);
    w.webContents.send = (ch, ...a) => { if (ch === 'window:flush-pages') globalThis.__flushAsked++; return send(ch, ...a); }; return true;`, { commandLine: true });
  const frame = await s.page.eval('return await window.flow.closePopout({ ws: "pa", zone: "z2" });');
  const afterClose = await windows(s.mainp);
  const flushAsked = await s.mainp.eval('return globalThis.__flushAsked;', { commandLine: true });
  check('closePopout closes the pop-out holding that space, its pages saved first, and gives its frame',
    !!frame && j(box(frame)) === j(FRAME) && frame.maximized === false && frame.fullScreen === false && !afterClose.some((w) => w.hash === 'solo=pa&zone=z2') && flushAsked === 1,
    `${j(frame)}, windows ${j(afterClose.map((w) => w.hash))}, asked to save ${flushAsked}`);
  const none = await s.page.eval('return await window.flow.closePopout({ ws: "pa", zone: "nothere" });');
  check('a space no window holds gives null', none === null, j(none));
  await s.page.eval(`window.flow.openWindow("solo=pa&zone=z2", ${j(frame)}); return true;`);
  const again = await L.waitFor(async () => (await windows(s.mainp)).find((w) => w.hash === 'solo=pa&zone=z2' && w.visible), 20000, 'the pop-out again');
  check('openWindow with that frame opens it there again', j(box(again.bounds)) === j(FRAME), j(again));

  // a pop-out holding a page the owner changed and that guards its changes
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><body><input id="i"><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/guard`;
  const pop = await L.flowPage((t) => t.type === 'page' && t.url.endsWith('#solo=pb'));
  await pop.eval(`window.__flow.openPage(${j(url)}); return true;`);
  const t = await L.waitFor(async () => (await L.targets(L.PORT)).find((x) => x.type === 'webview' && x.url === url), 30000, 'the guarded page');
  const g = await L.Cdp.connect(t.webSocketDebuggerUrl);
  await L.waitFor(() => g.eval(`return location.href === ${j(url)} && document.readyState === "complete";`), 20000, 'the guarded page to load');
  const at2 = await g.eval('const r = document.getElementById("i").getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 };');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await g.send('Input.dispatchMouseEvent', { type, x: at2.x, y: at2.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await g.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, ...(type === 'char' ? { text: 'a' } : {}) });
  }
  await L.sleep(300);
  const guarded = await s.mainp.eval(`const w = ${byHash('solo=pb')}; globalThis.__asked = 0; const send = w.webContents.send.bind(w.webContents);
    w.webContents.send = (ch, ...a) => { if (ch === 'window:unsaved-pages') globalThis.__asked++; return send(ch, ...a); }; return true;`, { commandLine: true });
  const held = await s.page.eval('return await window.flow.closePopout({ ws: "pb", zone: null }).then((f) => "closed " + JSON.stringify(f), (e) => "refused: " + e.message);');
  const asked = await s.mainp.eval('return globalThis.__asked;', { commandLine: true });
  const stillOut = (await windows(s.mainp)).some((w) => w.hash === 'solo=pb');
  check('a pop-out whose page has unsaved changes closes too, with nothing asked or shown, and gives its frame',
    guarded && /^closed \{"x":/.test(held) && !stillOut && asked === 0, `${held}, still out ${stillOut}, asked ${asked}`);
  g.close();
  pop.close();
  server.close();
  s.page.close();
  s.mainp.close();
}

try {
  await run();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  cleanup('SIGKILL');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




