// Item 40, main's side: before Flow quits, or before a Flow window closes, a window that saves what it shows
// (flow.onFlushPages) is asked to, and the quit or close waits for its answer, at most 2 s. The windows leave the screen
// first and save behind it, unthrottled. In the real app, with main's own clock (events written from the main process):
//   - a quit waits for a window whose flush takes 600 ms, and its answer comes before will-quit;
//   - that quit takes every window off the screen before the flush answers;
//   - a window that never answers holds the quit 2 s, and main says so;
//   - closing a pop-out waits for its own flush first, and the main window is not asked;
//   - the pop-out leaves the screen before its flush answers, and its renderer still runs as shown: the page is
//     visible to itself and a 300 ms timer is not stretched to a background page's once-a-second wake-ups;
//   - a pop-out opened just before a quit, painting only while the quit saves, never comes on screen;
//   - its space opened again while a pop-out saves on its way out: that window stays off the screen, and a new pop-out
//     opens once it has closed;
//   - a flush that answers at once adds only a few ms to a quit (before-quit to will-quit, against no listener).
//   node test/main-flush-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-flush-${Date.now()}.log`);
const EVENTS = path.join(os.tmpdir(), `flow-dev-main-flush-events-${process.pid}`);

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);

function cleanup(signal = 'SIGTERM') {
  for (const pid of L.electronPids()) {
    try {
      process.kill(Number(pid), signal);
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
}
const gone = (ms = 15000) => L.waitFor(() => L.electronPids().length === 0, ms, 'the app to quit').then(() => true, () => false);
const events = () => (fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
  const [what, t, ...rest] = l.split(' ');
  return { what, t: Number(t), rest: rest.join(' ') };
}) : []);
const at = (what) => (events().find((e) => e.what === what) || {}).t;

async function start(listen) {
  fs.rmSync(EVENTS, { force: true });
  L.launch(LOG);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  // main's clock: when the quit starts, each answer, will-quit, and each window closing
  await mainp.eval(`const { app, ipcMain, BrowserWindow } = require('electron'); const fs = require('fs');
    const note = (what, rest = '') => fs.appendFileSync(${j(EVENTS)}, what + ' ' + Date.now() + (rest ? ' ' + rest : '') + '\\n');
    app.prependListener('before-quit', () => note('before-quit'));
    app.on('will-quit', () => note('will-quit'));
    ipcMain.on('window:pages-flushed', (event) => note('flushed', String(event.sender.id)));
    const watch = (w) => {
      const id = String(w.webContents.id);
      for (const ev of ['closed', 'hide', 'show', 'ready-to-show']) w.on(ev, () => note(ev, id));
      w.webContents.on('console-message', (e) => { if (/^flushprobe /.test(e.message)) note('flushprobe', id + ' ' + e.message.slice(11)); });
    };
    for (const w of BrowserWindow.getAllWindows()) watch(w);
    app.on('browser-window-created', (_e, w) => { note('created', String(w.webContents.id)); watch(w); });
    return true;`, { commandLine: true });
  if (listen) await page.eval(`window.flow.onFlushPages(${listen}); return true;`);
  return { page, mainp };
}
// the inspector links are closed right after: Node keeps the process alive while a debugger is attached
const quit = async (s) => {
  await s.mainp.send('Runtime.evaluate', { expression: 'const { app } = require("electron"); setTimeout(() => app.quit(), 0); 1', includeCommandLineAPI: true })
    .catch((e) => console.log(`info quit: ${e.message}`));
  s.page.close();
  s.mainp.close();
};

async function run() {
  cleanup('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), j({ v: 11, ws: [{ id: 'fl', name: 'fl', folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  console.log(`app log: ${LOG}`);

  // a slow flush
  let s = await start('() => new Promise((r) => setTimeout(r, 600))');
  await quit(s);
  const slowGone = await gone();
  const slow = { quit: at('before-quit'), flushed: at('flushed'), willQuit: at('will-quit') };
  check('a quit waits for a window whose flush takes 600 ms, and its answer comes before will-quit', slowGone && slow.flushed - slow.quit >= 590 && slow.willQuit >= slow.flushed,
    `flushed +${slow.flushed - slow.quit} ms, will-quit +${slow.willQuit - slow.quit} ms`);
  check('that quit takes the window off the screen before the flush answers', slowGone && at('hide') >= slow.quit && at('hide') < slow.flushed,
    `hidden +${at('hide') - slow.quit} ms, flushed +${slow.flushed - slow.quit} ms`);

  // a window that never answers
  const logBefore = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').length : 0;
  s = await start('() => new Promise(() => {})');
  await quit(s);
  const hungGone = await gone();
  const hung = { quit: at('before-quit'), willQuit: at('will-quit'), flushed: at('flushed') };
  const said = fs.readFileSync(LOG, 'utf8').slice(logBefore);
  check('a window that never answers holds the quit 2 s, and main says so', hungGone && !hung.flushed && hung.willQuit - hung.quit >= 1990 && hung.willQuit - hung.quit < 4000 &&
    /\[flow\] window \d+ did not save what it shows within 2000 ms; going on/.test(said), `will-quit +${hung.willQuit - hung.quit} ms`);

  // a pop-out closing
  s = await start('() => new Promise((r) => setTimeout(r, 400))');
  const mainId = await s.mainp.eval('return require("electron").BrowserWindow.getAllWindows()[0].webContents.id;', { commandLine: true });
  await s.page.eval("window.flow.openWindow('solo=fl'); return true;");
  const pop = await L.flowPage((t) => t.type === 'page' && t.url.includes('#solo='));
  // what the pop-out's renderer sees while it saves: its visibility, and how long a 300 ms timer takes
  await pop.eval(`window.flow.onFlushPages(() => { const vis = document.visibilityState; const t = performance.now();
    return new Promise((r) => setTimeout(() => { console.log('flushprobe ' + vis + ' ' + Math.round(performance.now() - t)); r(); }, 300)); }); return true;`);
  const popId = await s.mainp.eval('return require("electron").BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("#solo=")).webContents.id;', { commandLine: true });
  const asked = Date.now();
  await s.mainp.eval('require("electron").BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("#solo=")).close(); return true;', { commandLine: true });
  await L.waitFor(() => events().some((e) => e.what === 'closed' && e.rest === String(popId)), 5000, 'the pop-out to close').catch(() => null);
  // the main window answers 400 ms after it is asked: had it been asked, its answer is in by now
  await L.sleep(800);
  const ev = events();
  const flushedPop = ev.find((e) => e.what === 'flushed' && e.rest === String(popId));
  const closedPop = ev.find((e) => e.what === 'closed' && e.rest === String(popId));
  check('closing a pop-out waits for its own flush first, and the main window is not asked',
    !!flushedPop && !!closedPop && flushedPop.t - asked >= 290 && closedPop.t >= flushedPop.t && !ev.some((e) => e.what === 'flushed' && e.rest === String(mainId)),
    j(ev.map((e) => `${e.what}${e.rest ? ' ' + e.rest : ''} +${e.t - asked}`)));
  const hidPop = ev.find((e) => e.what === 'hide' && e.rest === String(popId));
  const [vis, took] = ((ev.find((e) => e.what === 'flushprobe' && e.rest.startsWith(`${popId} `)) || {}).rest || '').split(' ').slice(1);
  check('the pop-out leaves the screen before its flush answers, and its renderer runs as shown meanwhile (visible, a 300 ms timer within 600 ms)',
    !!hidPop && !!flushedPop && hidPop.t < flushedPop.t && vis === 'visible' && Number(took) < 600, `hidden +${hidPop ? hidPop.t - asked : null} ms, page ${vis}, timer ${took} ms`);
  pop.close();
  await quit(s);
  if (!(await gone())) throw new Error('the app did not quit');

  // a pop-out opened just before a quit paints while the main window saves (1800 ms): it stays off the screen
  s = await start('() => new Promise((r) => setTimeout(r, 1800))');
  await s.page.eval("window.flow.openWindow('solo=fl'); return true;");
  await L.waitFor(() => s.mainp.eval('return require("electron").BrowserWindow.getAllWindows().length === 2;', { commandLine: true }), 5000, 'the pop-out window');
  await quit(s);
  const lateGone = await gone();
  const late = events();
  const lateQuit = at('before-quit');
  const popLate = late.find((e) => e.what === 'ready-to-show' && e.t >= lateQuit);
  check('a pop-out that paints only while the quit saves never comes on screen', lateGone && !!popLate && !late.some((e) => e.what === 'show' && e.rest === popLate.rest),
    j(late.filter((e) => e.what !== 'flushprobe').map((e) => `${e.what}${e.rest ? ' ' + e.rest : ''} +${e.t - lateQuit}`)));

  // the space opened again while its pop-out saves (800 ms) on its way out
  s = await start(null);
  await s.page.eval("window.flow.openWindow('solo=fl'); return true;");
  const p2 = await L.flowPage((t) => t.type === 'page' && t.url.includes('#solo='));
  await p2.eval('window.flow.onFlushPages(() => new Promise((r) => setTimeout(r, 800))); return true;');
  const oldPop = await s.mainp.eval('return require("electron").BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("#solo=")).webContents.id;', { commandLine: true });
  const reAsked = Date.now();
  await s.mainp.eval(`require('electron').webContents.fromId(${oldPop}).getOwnerBrowserWindow().close(); return true;`, { commandLine: true });
  await L.waitFor(() => events().some((e) => e.what === 'hide' && e.rest === String(oldPop)), 5000, 'the pop-out off the screen');
  await s.page.eval("window.flow.openWindow('solo=fl'); return true;");
  await L.waitFor(() => events().some((e) => e.what === 'closed' && e.rest === String(oldPop)), 5000, 'the old pop-out to close');
  const newPop = await L.waitFor(() => s.mainp.eval(`return require('electron').BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#solo=') &&
    x.webContents.id !== ${oldPop})?.webContents.id ?? null;`, { commandLine: true }), 10000, 'a new pop-out').catch(() => null);
  const re = events();
  const oldClosed = re.find((e) => e.what === 'closed' && e.rest === String(oldPop));
  const newMade = re.find((e) => e.what === 'created' && e.rest === String(newPop));
  check('the space opened again while its pop-out saves on its way out: that window never comes back, a new one opens after it closed',
    !re.some((e) => e.what === 'show' && e.rest === String(oldPop) && e.t >= reAsked) && !!newPop && !!oldClosed && !!newMade && newMade.t >= oldClosed.t,
    j(re.filter((e) => e.what !== 'flushprobe').map((e) => `${e.what}${e.rest ? ' ' + e.rest : ''} +${e.t - reAsked}`)));
  p2.close();
  await quit(s);
  if (!(await gone())) throw new Error('the app did not quit');

  // what a flush that answers at once adds
  const spans = { none: [], instant: [] };
  for (let i = 0; i < 3; i++) {
    for (const k of ['none', 'instant']) {
      s = await start(k === 'instant' ? '() => undefined' : null);
      await L.sleep(500);
      await quit(s);
      spans[k].push((await gone()) ? at('will-quit') - at('before-quit') : NaN);
    }
  }
  const median = (a) => [...a].sort((x, y) => x - y)[1];
  check('a flush that answers at once adds only a few ms to a quit (median of 3, before-quit to will-quit)',
    [...spans.none, ...spans.instant].every(Number.isFinite) && median(spans.instant) - median(spans.none) < 100, j(spans));
}

try {
  await run();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  cleanup('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the app to be gone').catch(() => null);
  fs.rmSync(EVENTS, { force: true });
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




