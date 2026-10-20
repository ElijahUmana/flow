// Flow's own windows come back as they were left (principle 5): full screen across a quit (SIGTERM) and a start, the
// main window and a pop-out, and windowed again once left windowed; a start in the background (FLOW_BACKGROUND=1) does
// not take the screen; windows moved just before a quit (inside the 400 ms their frame is otherwise saved after) are
// saved where they were moved, read before they leave the screen. Maximized is saved the same way, but xvfb has no window
// manager to maximize: that half is for the Mac.
//   node test/main-winstate-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-winstate-${Date.now()}.log`);
const STATE = path.join(L.USER_DATA, 'flow-state.json');
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const kill = (sig) => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const wsOf = (id) => ({ id, name: id, folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [], saved: [] });
const windows = (mainp) => mainp.eval(`return require('electron').BrowserWindow.getAllWindows().map((w) => ({ pop: w.webContents.getURL().includes('#solo='),
  full: w.isFullScreen() }));`, { commandLine: true });
const both = async (mainp) => {
  const ws = await L.waitFor(async () => { const x = await windows(mainp); return x.length === 2 ? x : null; }, 15000, 'both windows');
  return { main: ws.find((w) => !w.pop).full, pop: ws.find((w) => w.pop).full };
};

async function start(env = {}) {
  L.launch(LOG, env);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  return { page, mainp };
}
async function quit(s) {
  s.page.close();
  s.mainp.close();
  kill('SIGTERM');
  await L.waitFor(() => L.electronPids().length === 0, 15000, 'the quit');
}
const setFull = (s, on) => s.mainp.eval(`for (const w of require('electron').BrowserWindow.getAllWindows()) w.setFullScreen(${on}); return true;`, { commandLine: true });

try {
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(STATE, j({ v: 11, ws: [wsOf('one'), wsOf('two')], ui: { at: 'one' } }));
  console.log(`app log: ${LOG}`);

  let s = await start();
  await s.page.eval("window.flow.openWindow('solo=two'); return true;");
  await L.flowPage((t) => t.type === 'page' && t.url.includes('#solo=two'));
  await setFull(s, true);
  await L.sleep(1200);
  await quit(s);
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  check('a quit saves full screen for the main window and the pop-out', !!saved.bounds && saved.bounds.fullScreen === true &&
    Array.isArray(saved.popouts) && saved.popouts.length === 1 && saved.popouts[0].fullScreen === true, j({ bounds: saved.bounds, popouts: saved.popouts }));
  s = await start();
  const back = await both(s.mainp);
  check('both come back full screen', back.main && back.pop, j(back));

  await setFull(s, false);
  await L.sleep(1200);
  await quit(s);
  const savedW = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  s = await start();
  const backW = await both(s.mainp);
  check('left windowed, both come back windowed, and nothing says full screen', !backW.main && !backW.pop && !('fullScreen' in savedW.bounds) &&
    !('fullScreen' in savedW.popouts[0]), j({ backW, bounds: savedW.bounds, popouts: savedW.popouts }));
  await setFull(s, true);
  await L.sleep(1200);
  await quit(s);

  s = await start({ FLOW_BACKGROUND: '1' });
  const backB = await both(s.mainp);
  check('a start in the background does not take the screen', !backB.main && !backB.pop, j(backB));
  await quit(s);
  check('and the saved full screen stays for the next start', JSON.parse(fs.readFileSync(STATE, 'utf8')).bounds.fullScreen === true);

  s = await start();
  await both(s.mainp);
  await setFull(s, false);
  await L.sleep(1200);
  const moved = await s.mainp.eval(`const out = {};
    for (const w of require('electron').BrowserWindow.getAllWindows()) {
      const pop = w.webContents.getURL().includes('#solo=');
      w.setBounds({ x: pop ? 333 : 111, y: pop ? 222 : 77, width: 900, height: 600 });
      out[pop ? 'pop' : 'main'] = w.getNormalBounds();
    }
    return out;`, { commandLine: true });
  await quit(s);
  const savedM = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  check('the main window and a pop-out moved just before a quit are saved where they were moved', same(savedM.bounds, moved.main) &&
    same(savedM.popouts[0] && savedM.popouts[0].bounds, moved.pop), j({ moved, bounds: savedM.bounds, popouts: savedM.popouts }));
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the app to be gone').catch(() => null);
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




