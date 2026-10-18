// MAC_NOTES item 11: quitting with live terminals must never abort. node-pty reports each exit from a helper thread
// through a ThreadSafeFunction; a call still queued when Electron frees the Node environment throws a Napi::Error that
// nothing catches (SIGABRT). Launches the real app again and again (default 32) on one workspace with 6 live terminals
// (2 Claude Code, 4 shells), with a pop-out kept open in some launches and opened then closed in others (the space's
// terminals move to the pop-out and back: a popped-out space lives only there), and quits by
// app.quit() (main-process inspector) or SIGTERM to the main process, alternately. Every launch must exit 0, its log must
// hold no Napi::Error or abort, and every flow_<id> session must survive the quit. Closing a pop-out must log no
// [flow] line. One extra launch checks that a rejecting pty.shutdown() still lets Flow exit 0. Nothing is typed into
// Claude Code.
//   node test/main-quit-loop.mjs [launches]      (MAIN_QUIT_DIR=<dir> keeps the per-launch logs and summary there)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const RUNS = Number(process.argv[2] || 32);
const OUT = process.env.MAIN_QUIT_DIR || fs.mkdtempSync('/tmp/flow-main-quit-');
const TERMS = 6;
const ABORT_RE = /Napi::Error|terminating due to uncaught|exited with signal|Aborted|SIGABRT/;
// Team rule: real claude in tests runs under /tmp/flow-dev-main.
const WORK = path.join(L.USER_DATA, 'quit-loop');
const term = (id, cmd, x, y) => ({ id, type: 'term', title: id, cmd, cwd: WORK, ...(cmd === 'claude' ? { sessionId: crypto.randomUUID() } : {}), where: 'this Mac', x, y, w: 31, h: 40 });
const STATE = {
  v: 11,
  ws: [{
    id: 'q', name: 'quit loop', folder: WORK, bg: '#141319', zones: [], notes: [], closed: [],
    windows: [term('q-claude1', 'claude', 1, 6), term('q-claude2', 'claude', 34, 6), term('q-sh1', 'shell', 67, 6),
      term('q-sh2', 'shell', 1, 50), term('q-sh3', 'shell', 34, 50), term('q-sh4', 'shell', 67, 50)],
  }],
  ui: {},
};

const summary = [];
const say = (line) => {
  console.log(line);
  summary.push(line);
};

const clientPids = () => L.tmux('list-clients', '-F', '#{client_pid}').split('\n').filter(Boolean);
const clients = () => clientPids().length;
// A popped-out space lives only in its pop-out (nav): its terminals' clients move from one window to the other.
const moved = (from) => () => { const now = clientPids(); return now.length === TERMS && now.every((p) => !from.includes(p)); };
const sessions = () => Object.fromEntries(L.tmux('list-sessions', '-F', '#{session_name} #{session_created}').split('\n').filter(Boolean).map((l) => l.split(' ')));

function cleanup() {
  for (const pid of L.electronPids()) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
  try {
    L.tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
  }
}

async function once(i) {
  const how = i % 2 === 0 ? 'app.quit()' : 'SIGTERM';
  const pop = ['open', 'closed', 'none'][i % 3];
  const log = path.join(OUT, `launch-${String(i + 1).padStart(2, '0')}.log`);
  const child = L.launch(log);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const page = await L.flowPage();
  await L.waitFor(() => clients() >= TERMS, 60000, `${TERMS} tmux clients`);
  let mainp = null;
  let popLines = null;
  if (pop !== 'none') {
    // a pop-out open at the last quit comes back by itself (the launch after an 'open' one)
    const restored = (await page.eval('return (await window.flow.popouts()).length;')) > 0;
    if (!restored) {
      const inMain = clientPids();
      await page.eval('window.flow.openWindow("solo=q"); return true;');
      await L.waitFor(moved(inMain), 60000, `the ${TERMS} terminals to move to the pop-out`);
    }
    if (pop === 'closed') {
      mainp = await L.mainProcess();
      const mark = fs.statSync(log).size;
      const inPop = clientPids();
      await mainp.eval('const { BrowserWindow } = require("electron"); BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("#solo=")).close(); return true;', { commandLine: true });
      await L.waitFor(moved(inPop), 20000, 'the terminals back in the main window');
      await L.sleep(1500);
      popLines = fs.readFileSync(log, 'utf8').slice(mark).split('\n').filter((l) => /\[flow|Napi|rror/.test(l));
    }
  }
  const before = sessions();
  const attached = clients();
  page.close();
  if (how === 'app.quit()') {
    mainp = mainp || await L.mainProcess();
    mainp.send('Runtime.evaluate', { expression: 'const { app } = require("electron"); setTimeout(() => app.quit(), 200); 1', includeCommandLineAPI: true })
      .catch((e) => console.log(`  inspector: ${e.message}`));
    await L.sleep(50);
    mainp.close();
  } else {
    // Node waits at exit while a debugger is attached, so the inspector link goes first.
    if (mainp) mainp.close();
    const pids = L.electronPids();
    if (pids.length !== 1) throw new Error(`expected one Flow main process, found ${JSON.stringify(pids)}`);
    process.kill(Number(pids[0]), 'SIGTERM');
  }
  const end = await Promise.race([exited, L.sleep(30000).then(() => null)]);
  const gone = await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process left').then(() => true, () => false);
  const text = fs.readFileSync(log, 'utf8');
  const aborts = text.split('\n').filter((l) => ABORT_RE.test(l));
  const waited = (text.match(/\[flow\] quit: (\d+ of \d+) terminal clients exited in (\d+) ms/) || []).slice(1);
  const killed = text.split('\n').filter((l) => /did not exit/.test(l));
  const after = sessions();
  const kept = Object.keys(before).filter((k) => after[k] === before[k]);
  const ok = end && gone && end.code === 0 && end.signal === null && aborts.length === 0 && killed.length === 0 && kept.length === Object.keys(before).length &&
    Object.keys(before).length >= TERMS && (popLines === null || popLines.length === 0);
  say(`launch ${String(i + 1).padStart(2, '0')}  ${how.padEnd(10)}  pop-out ${pop.padEnd(6)}  clients ${String(attached).padStart(2)}  ` +
    `exit ${end ? `${end.code}${end.signal ? ' ' + end.signal : ''}` : 'none in 30 s'}${gone ? '' : ' (a Flow process is still running)'}  aborts ${aborts.length}  ` +
    `sessions kept ${kept.length}/${Object.keys(before).length}` + (popLines ? `  [flow] lines after closing the pop-out ${popLines.length}` : '') +
    (waited.length ? `  waited for ${waited[0]} clients, ${waited[1]} ms` : '  nothing to wait for') + (killed.length ? `  ${JSON.stringify(killed)}` : '') +
    `  ${ok ? 'ok' : 'FAIL'}` + (aborts.length ? `  ${JSON.stringify(aborts.slice(0, 2))}` : '') + (popLines && popLines.length ? `  ${JSON.stringify(popLines.slice(0, 3))}` : ''));
  if (!end || !gone) cleanup();
  return ok;
}

// will-quit must exit even if pty.shutdown() rejects (otherwise every later quit is prevented and Flow never quits).
// The running app's pty module gets a rejecting shutdown (and pending() true, so will-quit takes that path).
async function rejectingShutdown() {
  const log = path.join(OUT, 'launch-reject.log');
  const child = L.launch(log);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const page = await L.flowPage();
  await L.waitFor(() => clients() >= TERMS, 60000, `${TERMS} tmux clients`);
  const before = sessions();
  const mainp = await L.mainProcess();
  await mainp.eval(`const m = require.cache[${JSON.stringify(path.join(L.ROOT, 'src', 'pty.js'))}];
    m.exports.pending = () => true; m.exports.shutdown = () => Promise.reject(new Error('injected rejection')); return true;`, { commandLine: true });
  page.close();
  mainp.send('Runtime.evaluate', { expression: 'const { app } = require("electron"); setTimeout(() => app.quit(), 200); 1', includeCommandLineAPI: true })
    .catch((e) => console.log(`  inspector: ${e.message}`));
  await L.sleep(50);
  mainp.close();
  const end = await Promise.race([exited, L.sleep(30000).then(() => null)]);
  const gone = await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process left').then(() => true, () => false);
  const text = fs.readFileSync(log, 'utf8');
  const after = sessions();
  const kept = Object.keys(before).filter((k) => after[k] === before[k]).length;
  const ok = end && gone && end.code === 0 && end.signal === null && text.includes('[flow] quit: injected rejection') && !ABORT_RE.test(text) &&
    kept === Object.keys(before).length;
  say(`extra launch  pty.shutdown() rejects  exit ${end ? `${end.code}${end.signal ? ' ' + end.signal : ''}` : 'none in 30 s'}  ` +
    `"[flow] quit: injected rejection" ${text.includes('[flow] quit: injected rejection') ? 'logged' : 'missing'}  sessions kept ${kept}/${Object.keys(before).length}  ${ok ? 'ok' : 'FAIL'}`);
  if (!end || !gone) cleanup();
  return ok;
}

let failed = 0;
try {
  cleanup();
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), JSON.stringify(STATE));
  fs.mkdirSync(OUT, { recursive: true });
  say(`quit loop: ${RUNS} launches, ${TERMS} terminals each, logs in ${OUT}`);
  for (let i = 0; i < RUNS; i++) {
    if (!(await once(i))) failed++;
  }
  if (!(await rejectingShutdown())) failed++;
} catch (e) {
  say(`FAIL the loop stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  cleanup();
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
}
say(failed ? `${failed} of ${RUNS + 1} launches FAILED` : `all ${RUNS} launches and the extra one passed`);
fs.writeFileSync(path.join(OUT, 'summary.txt'), summary.join('\n') + '\n');
process.exit(failed ? 1 : 0);




