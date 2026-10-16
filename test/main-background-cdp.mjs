// MAC_NOTES item 10 on the VM: with FLOW_BACKGROUND=1 no Flow window takes focus (first window, pop-out,
// second-instance). A control launch without it first shows that a plain show() does focus the window here
// (xvfb, no window manager), so the background result means something. The state is one empty workspace:
// no terminals, pages or ssh start.
//   node test/main-background-cdp.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-background-${Date.now()}.log`);
const STATE = { v: 11, ws: [{ id: 'bg', name: 'bg', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const logSize = () => (fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);
const logSince = (at) => fs.readFileSync(LOG, 'utf8').slice(at);
const shownLines = (text, label) => text.split('\n').filter((l) => l === `[flow] background: ${label} shown inactive, isFocused=false`).length;

function cleanup() {
  for (const pid of L.electronPids()) {
    try {
      process.kill(Number(pid), 'SIGTERM');
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

const windows = (mainp) => mainp.eval(`const { BrowserWindow } = require('electron'); const f = BrowserWindow.getFocusedWindow();
  return { focusedWindow: f ? f.id : null, all: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, visible: w.isVisible(), focused: w.isFocused() })) };`, { commandLine: true });

async function start(extraEnv) {
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), JSON.stringify(STATE));
  L.launch(LOG, extraEnv);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  await L.waitFor(async () => { const x = await windows(mainp); return x.all.length === 1 && x.all[0].visible; }, 15000, 'a visible window');
  await L.sleep(500);
  return { page, mainp, first: await windows(mainp) };
}

async function run() {
  cleanup();
  console.log(`app log: ${LOG}`);

  const controlAt = logSize();
  const control = await start({});
  check('control: without FLOW_BACKGROUND the window is shown and focused', control.first.all[0].visible && control.first.all[0].focused && control.first.focusedWindow === control.first.all[0].id, j(control.first));
  check('control: document.hasFocus() is true', (await control.page.eval('return document.hasFocus();')) === true);
  control.page.close();
  await quitApp(control.mainp);
  check('control: no background log lines', !/\[flow\] background:/.test(logSince(controlAt)));

  const bgAt = logSize();
  const bg = await start({ FLOW_BACKGROUND: '1' });
  check('FLOW_BACKGROUND=1: the window is shown without focus', bg.first.all[0].visible && !bg.first.all[0].focused && bg.first.focusedWindow === null, j(bg.first));
  check('FLOW_BACKGROUND=1: document.hasFocus() is false', (await bg.page.eval('return document.hasFocus();')) === false);
  check('FLOW_BACKGROUND=1: main logs "main shown inactive, isFocused=false"', shownLines(logSince(bgAt), 'main') === 1, j(logSince(bgAt).split('\n').filter((l) => l.includes('background:'))));

  await bg.page.eval('window.flow.openWindow("solo=bg"); return true;');
  await L.waitFor(async () => { const x = await windows(bg.mainp); return x.all.length === 2 && x.all.every((w) => w.visible); }, 15000, 'the pop-out');
  await L.sleep(500);
  const afterPop = await windows(bg.mainp);
  check('FLOW_BACKGROUND=1: a pop-out is shown without focus', afterPop.all.length === 2 && afterPop.all.every((w) => w.visible && !w.focused) && afterPop.focusedWindow === null, j(afterPop));
  const popPage = await L.flowPage((t) => t.type === 'page' && t.url.includes('#solo=bg'));
  check('FLOW_BACKGROUND=1: document.hasFocus() is false in the pop-out', (await popPage.eval('return document.hasFocus();')) === false);
  popPage.close();
  check('FLOW_BACKGROUND=1: main logs "solo=bg shown inactive, isFocused=false" for the pop-out', shownLines(logSince(bgAt), 'solo=bg') === 1);
  // a window on its way out leaves the screen first: its "hidden" line is expected from here on (as in e2e check 9)
  const popCloseAt = logSize();
  await bg.mainp.eval(`const { BrowserWindow } = require('electron'); BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('#solo=')).forEach((w) => w.close()); return true;`, { commandLine: true });
  await L.waitFor(async () => (await windows(bg.mainp)).all.length === 1, 10000, 'the pop-out to close');

  await bg.mainp.eval('const { app } = require("electron"); globalThis.__flowSecond = 0; app.on("second-instance", () => { globalThis.__flowSecond++; }); return true;', { commandLine: true });
  const second = L.launch(LOG, { FLOW_BACKGROUND: '1' });
  await L.waitFor(() => bg.mainp.eval('return globalThis.__flowSecond === 1;'), 30000, 'the second-instance event');
  await new Promise((r) => (second.exitCode !== null ? r() : second.once('exit', r)));
  await L.sleep(500);
  const afterSecond = await windows(bg.mainp);
  check('FLOW_BACKGROUND=1: a second launch leaves the window shown and unfocused', afterSecond.all.length === 1 && afterSecond.all[0].visible && !afterSecond.all[0].focused && afterSecond.focusedWindow === null, j(afterSecond));
  check('the second launch exited (single instance)', L.electronPids().length === 1, j(L.electronPids()));
  check('FLOW_BACKGROUND=1: the second launch logs another "main shown inactive, isFocused=false"', shownLines(logSince(bgAt), 'main') === 2);

  const bgLines = logSince(bgAt).split('\n').filter((l) => l.includes('[flow] background:'));
  check('FLOW_BACKGROUND=1: no "got focus" line and no activating call in the whole run', bgLines.length > 0 && !bgLines.some((l) => l.includes(' got focus') || l.includes('() called')), j(bgLines));
  const hiddenIn = (text) => text.split('\n').filter((l) => l.startsWith('[flow] background:') && l.endsWith(' hidden'));
  const whole = fs.readFileSync(LOG, 'utf8');
  const unexpected = [...hiddenIn(whole.slice(bgAt, popCloseAt)), ...hiddenIn(whole.slice(popCloseAt)).filter((l) => l !== '[flow] background: solo=bg hidden')];
  check('FLOW_BACKGROUND=1: no "hidden" line in the whole run but the pop-out\'s on its way out', unexpected.length === 0, j(unexpected));

  // The diagnostics themselves (MAC_NOTES 12): a forced focus logs its context and stack, a forced hide logs "hidden".
  const forcedAt = logSize();
  await bg.mainp.eval('const { BrowserWindow } = require("electron"); (function flowTestFocus() { BrowserWindow.getAllWindows()[0].focus(); })(); return true;', { commandLine: true });
  const focusLine = await L.waitFor(() => logSince(forcedAt).split('\n').find((l) => l.startsWith('[flow] background: main got focus; ')), 5000, 'the got focus line');
  check('a forced focus logs "main got focus" with its timing, the focused contents and a stack', /got focus; \d+ ms after it was shown, focused contents (window|webview) \d+, stack: .*emit/.test(focusLine), focusLine);
  const callLine = logSince(forcedAt).split('\n').find((l) => l.startsWith('[flow] background: main focus() called; stack: '));
  check('the focus() call is logged with its JS caller', !!callLine && callLine.includes('flowTestFocus'), callLine);
  await bg.mainp.eval('const { BrowserWindow } = require("electron"); BrowserWindow.getAllWindows()[0].hide(); return true;', { commandLine: true });
  const hideLine = await L.waitFor(() => logSince(forcedAt).split('\n').find((l) => l === '[flow] background: main hidden'), 5000, 'the hidden line');
  check('a forced hide logs "main hidden"', !!hideLine);

  bg.page.close();
  await quitApp(bg.mainp);
}

try {
  await run();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  cleanup();
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
}
const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => /^\[flow renderer|^\[flow\]|Error occurred in handler|\(electron\)/.test(l));
console.log(`info main-process log lines: ${lines.length}`);
for (const l of lines.slice(0, 10)) console.log(`  log: ${l}`);
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




