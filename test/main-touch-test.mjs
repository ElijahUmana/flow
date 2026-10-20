// MAC_NOTES 25, main's side: the trackpad's touches from native/touch reach the Flow window as 'fingers' { n, t, dx },
// and the legacy 'swipe' stops switching while they stream. On the VM, a Linux build of the same module
// (native/touch/flow_touch.mm with FLOW_TOUCH_FAKE, no AppKit) is loaded through FLOW_TOUCH_ADDON and its _inject(win,
// n, dx, dy, w, t) sends reports the way AppKit's touch events do on the Mac (dx dy in trackpad points, x right, y up,
// w the trackpad's width). In the real app:
//   - three fingers: the count comes at once, travel only once they moved 4 points, then all of it, in the window's px
//     (the trackpad's width is the window's), positive when they move left; the lift reports 0;
//   - three fingers moving up or down report no travel, two fingers only their count, an unwatched window nothing;
//   - until the page asks (onFingers) nothing is sent and the legacy 'swipe' switches as before, while FLOW_TOUCH_LOG=1
//     logs each change in the count, with the travel when three fingers lift (MAC_NOTES 27);
//   - the legacy 'swipe' just after three fingers switches nothing, and 1.5 s later switches as before;
//   - a touch event AppKit refuses to read is logged once;
//   - with FLOW_TOUCH_LOG=1 the module's trace of a gesture event logs its counts by phase and resting, one line, and
//     nothing goes to the page; an unwatched window's trace logs nothing; without FLOW_TOUCH_LOG there is no trace;
//   - a quit with 3000 reports still queued exits 0 with no abort, and so does a launch with no module (the legacy
//     'swipe' then switches at once).
//   node test/main-touch-test.mjs <linux flow_touch.node>
import fs from 'node:fs';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const ADDON = path.resolve(process.argv[2] || '');
const LOG = process.env.MAIN_APP_LOG || '/tmp/flow-dev-main-touch.log';
const j = (v) => JSON.stringify(v);
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};
const kill = () => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

async function launch(env) {
  kill();
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  const ws = (id) => ({ id, name: id, folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [], saved: [] });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), j({ v: 11, ws: [ws('a'), ws('b'), ws('c')], ui: { at: 'b' } }));
  const from = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  const child = L.launch(LOG, env);
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  // main's sessions index warms up after launch and holds main a while under load: the touches are tested after it
  await page.eval('await window.flow.sessions.list(); return true;', { timeout: 180000 });
  await page.eval('window.__menus = []; window.flow.onMenu((a) => window.__menus.push(a)); return true;');
  const logSince = () => fs.readFileSync(LOG, 'utf8').slice(from);
  return { page, mainp, exited, logSince };
}

async function run() {
  if (!fs.existsSync(ADDON)) throw new Error(`no test build at ${ADDON}`);
  let app = await launch({ FLOW_TOUCH_ADDON: ADDON, FLOW_TOUCH_LOG: '1' });
  const { page, mainp } = app;
  check('the module loaded: no "trackpad touches are off" line', !/trackpad touches are off/.test(app.logSince()));
  // the main window's id in the module: watching it again gives the same one
  const id = await mainp.eval(`const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
    globalThis.__touch = require(${j(ADDON)}); globalThis.__win = w; return globalThis.__touch.watch(w.getNativeWindowHandle());`, { commandLine: true });
  const width = await mainp.eval('return globalThis.__win.getContentBounds().width;', { commandLine: true });
  const inject = (reports) => mainp.eval(`const t = Date.now(); for (const [n, dx, dy] of ${j(reports)}) globalThis.__touch._inject(${id}, n, dx, dy, 400, t); return true;`, { commandLine: true });
  const got = async () => { await L.sleep(300); const g = await page.eval('const g = window.__got; window.__got = []; return g;'); return g; };

  // before a page takes the touches (no onFingers yet): the legacy 'swipe' is the path, right after three fingers too.
  // app.js asks as it starts, so that page is a pop-out's whose ask main does not get.
  await mainp.eval(`globalThis.__sent = 0; const wc = globalThis.__win.webContents; const send = wc.send.bind(wc);
    wc.send = (ch, ...a) => { if (ch === 'fingers') globalThis.__sent++; return send(ch, ...a); };
    const { ipcMain } = require('electron'); globalThis.__asks = ipcMain.listeners('fingers:wanted'); ipcMain.removeAllListeners('fingers:wanted');
    return true;`, { commandLine: true });
  await page.eval('window.flow.openWindow("solo=a"); return true;');
  const pop = await L.flowPage((t) => t.type === 'page' && t.url.includes('#solo=a'));
  await pop.eval('window.__menus = []; window.flow.onMenu((a) => window.__menus.push(a)); return true;');
  const popId = await mainp.eval(`const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#solo=a'));
    globalThis.__pop = w; globalThis.__popSent = 0; const wc = w.webContents; const send = wc.send.bind(wc);
    wc.send = (ch, ...a) => { if (ch === 'fingers') globalThis.__popSent++; return send(ch, ...a); };
    return globalThis.__touch.watch(w.getNativeWindowHandle());`, { commandLine: true });
  const logFrom = app.logSince().length;
  await mainp.eval(`const t = Date.now(); for (const [n, dx, dy] of ${j([[3, 0, 0], [3, -5, 0], [0, 0, 0]])}) globalThis.__touch._inject(${popId}, n, dx, dy, 400, t); return true;`, { commandLine: true });
  await L.sleep(300);
  const logged = app.logSince().slice(logFrom).split('\n').filter((l) => l.startsWith('[flow] touches:'));
  const sentUnasked = await mainp.eval('return globalThis.__popSent;', { commandLine: true });
  check('FLOW_TOUCH_LOG=1 with no page asking: a line per change in the count, the travel at the lift, and nothing sent',
    j(logged) === j(['[flow] touches: 3 fingers on a Flow window', '[flow] touches: 0 fingers on a Flow window; three or more moved -5 pt sideways, 0 pt up (x)']) && sentUnasked === 0,
    `${j(logged)}, sent ${sentUnasked}`);
  await mainp.eval("globalThis.__pop.emit('swipe', {}, 'left'); return true;", { commandLine: true });
  await L.sleep(400);
  const unasked = await pop.eval('return window.__menus.splice(0);');
  check('until the page asks for the touches, the legacy swipe switches right after three fingers', j(unasked) === j(['next-ws']), j(unasked));
  await mainp.eval(`const { ipcMain } = require('electron'); for (const l of globalThis.__asks) ipcMain.on('fingers:wanted', l);
    globalThis.__pop.close(); return true;`, { commandLine: true });
  pop.close();
  await L.waitFor(async () => (await mainp.eval("return require('electron').BrowserWindow.getAllWindows().length;", { commandLine: true })) === 1, 15000, 'the pop-out to close');
  await page.eval('window.__got = []; window.flow.onFingers((f) => window.__got.push(f)); return true;');
  await L.sleep(300);

  await inject([[3, 0, 0], [3, -2, 0.5], [3, -2, -0.5], [3, -2, 0], [0, 0, 0]]);
  const side = await got();
  const px = (pt) => (pt / 400) * width;
  check('three fingers moving left: the count at once, no travel before 4 points, then all of it and the rest, then the lift',
    side.length === 5 && side.map((f) => f.n).join() === '3,3,3,3,0' && side[0].dx === undefined && side[1].dx === undefined &&
    near(side[2].dx, px(4)) && near(side[3].dx, px(2)) && side[4].dx === undefined && side.every((f) => Number.isFinite(f.t)),
    `${j(side)} (window ${width} px)`);
  await inject([[3, 0, 0], [3, 3, 0], [3, 3, 0], [0, 0, 0]]);
  const right = await got();
  check('moving right: negative travel', right.length === 4 && near(right[2].dx, -px(6)), j(right));
  await inject([[3, 0, 0], [3, 0.5, 5], [3, 6, 0], [0, 0, 0]]);
  const up = await got();
  check('three fingers moving up first: no travel for the rest of the touch, sideways or not', up.length === 4 && up.every((f) => f.dx === undefined), j(up));
  await inject([[2, 0, 0], [2, -9, 0], [0, 0, 0]]);
  const two = await got();
  check('two fingers: no travel', two.length === 3 && two.every((f) => f.dx === undefined), j(two));
  await mainp.eval(`globalThis.__touch._inject(999, 3, -9, 0, 400, Date.now()); return true;`, { commandLine: true });
  check('an unwatched window: nothing', (await got()).length === 0);

  // the legacy 'swipe' at the end of a flick, with the touches streaming and after
  await inject([[3, 0, 0], [3, -5, 0], [0, 0, 0]]);
  await got();
  await mainp.eval("globalThis.__win.emit('swipe', {}, 'left'); return true;", { commandLine: true });
  await L.sleep(400);
  const during = await page.eval('return window.__menus.splice(0);');
  await L.sleep(1300);
  await mainp.eval("globalThis.__win.emit('swipe', {}, 'left'); return true;", { commandLine: true });
  await L.sleep(400);
  const after = await page.eval('return window.__menus.splice(0);');
  check('the legacy swipe just after three fingers switches nothing; 1.5 s on it switches as before', during.length === 0 && j(after) === j(['next-ws']), `during ${j(during)}, after ${j(after)}`);

  await mainp.eval('globalThis.__touch._inject(0, -1, 0, 0, 0, 0); globalThis.__touch._inject(0, -1, 0, 0, 0, 0); return true;', { commandLine: true });
  const refusedOf = () => app.logSince().split('\n').filter((l) => l.includes("AppKit would not give a touch event's touches"));
  await L.waitFor(() => refusedOf().length > 0, 10000, 'the refused line').catch(() => null);
  await L.sleep(500);
  const refusedLines = refusedOf();
  check('a touch event AppKit refuses is logged once', refusedLines.length === 1 && (await got()).length === 0, `${refusedLines.length} lines`);

  const traceFrom = app.logSince().length;
  const sentBefore = await mainp.eval('return globalThis.__sent;', { commandLine: true });
  await mainp.eval(`globalThis.__touch._injectTrace(${id}, 2, 1, 0, 0, 0, 1, 1793640000123); globalThis.__touch._injectTrace(999, 3, 0, 0, 0, 0, 3, 1793640000456); return true;`, { commandLine: true });
  const traceOf = () => app.logSince().slice(traceFrom).split('\n').filter((l) => l.startsWith('[flow] touches trace:'));
  await L.waitFor(() => traceOf().length > 0, 10000, 'the trace line').catch(() => null);
  await L.sleep(500);
  const traced = traceOf();
  const sentAfter = await mainp.eval('return globalThis.__sent;', { commandLine: true });
  check('FLOW_TOUCH_LOG=1: a traced gesture event logs its counts by phase and resting, one line for the watched window, and nothing goes to the page',
    j(traced) === j(['[flow] touches trace: 2 began, 1 moved, 0 stationary, 0 ended, 0 cancelled; 1 resting; t 1793640000123']) && sentAfter === sentBefore && (await got()).length === 0,
    `${j(traced)}, sent ${sentAfter - sentBefore}`);

  // a quit with reports still queued; Node waits at exit while a debugger is attached, so the inspector link goes first
  mainp.send('Runtime.evaluate', { expression: `const { app } = require('electron'); const t = globalThis.__touch;
    setTimeout(() => { for (let i = 0; i < 3000; i++) t._inject(${id}, 3, -1, 0, 400, Date.now()); app.quit(); }, 200); 1`, includeCommandLineAPI: true }).catch(() => null);
  await L.sleep(50);
  page.close();
  mainp.close();
  const quit = await Promise.race([app.exited, L.sleep(30000).then(() => null)]);
  const quitLog = app.logSince();
  check('a quit with 3000 reports queued exits 0, with no abort or N-API error', !!quit && quit.code === 0 && !/Napi::Error|abort|FATAL|SIGABRT|Segmentation/i.test(quitLog), `${j(quit)}`);

  // no module: the legacy swipe is the path
  app = await launch({ FLOW_TOUCH_ADDON: path.join(path.dirname(ADDON), 'missing.node') });
  check('a missing module is said once and Flow goes on', (app.logSince().match(/trackpad touches are off/g) || []).length === 1);
  await app.mainp.eval("require('electron').BrowserWindow.getAllWindows()[0].emit('swipe', {}, 'right'); return true;", { commandLine: true });
  await L.sleep(400);
  const none = await app.page.eval('return window.__menus.splice(0);');
  check('with no module the legacy swipe switches at once', j(none) === j(['prev-ws']), j(none));
  app.mainp.send('Runtime.evaluate', { expression: "const { app } = require('electron'); setTimeout(() => app.quit(), 200); 1", includeCommandLineAPI: true }).catch(() => null);
  await L.sleep(50);
  app.page.close();
  app.mainp.close();
  const quit2 = await Promise.race([app.exited, L.sleep(30000).then(() => null)]);
  check('and quits with exit 0', !!quit2 && quit2.code === 0, j(quit2));

  // the module without FLOW_TOUCH_LOG: no trace
  app = await launch({ FLOW_TOUCH_ADDON: ADDON });
  const id3 = await app.mainp.eval(`const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
    globalThis.__touch = require(${j(ADDON)}); return globalThis.__touch.watch(w.getNativeWindowHandle());`, { commandLine: true });
  const from3 = app.logSince().length;
  await app.mainp.eval(`globalThis.__touch._injectTrace(${id3}, 3, 0, 0, 0, 0, 1, Date.now()); globalThis.__touch._inject(${id3}, 3, 0, 0, 400, Date.now()); globalThis.__touch._inject(${id3}, 0, 0, 0, 0, Date.now()); return true;`, { commandLine: true });
  await L.sleep(1500);
  const quiet = app.logSince().slice(from3).split('\n').filter((l) => l.startsWith('[flow] touches'));
  check('without FLOW_TOUCH_LOG: no trace line and no touches lines', quiet.length === 0, j(quiet));
  app.mainp.send('Runtime.evaluate', { expression: "const { app } = require('electron'); setTimeout(() => app.quit(), 200); 1", includeCommandLineAPI: true }).catch(() => null);
  await L.sleep(50);
  app.page.close();
  app.mainp.close();
  const quit3 = await Promise.race([app.exited, L.sleep(30000).then(() => null)]);
  check('and that launch quits with exit 0', !!quit3 && quit3.code === 0, j(quit3));
}

console.log(`app log: ${LOG}`);
run().catch((e) => { failed++; console.log(`FAIL the test stopped: ${e.stack || e.message}`); }).finally(() => {
  kill();
  try { fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch (e) { console.log(`cleanup: ${e.message}`); }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
});




