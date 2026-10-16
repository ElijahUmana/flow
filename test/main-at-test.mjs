// Item 45: after a quit with a workspace popped out, the main window comes back on the workspace it showed at the
// quit. Which workspace the main window shows (ui.at, with its sidebar state ui.sbHidden) is the main window's alone,
// so the store never takes a pop-out's older copy of it. Flows' at-repro with real clicks in the Flow window: the
// "mynotes" pill, its pop-out button, then the "infra" pill in the main window; a quit (SIGTERM to the main process)
// 3000 ms and 600 ms later; the state file after the quit, and the main window after a restart, show infra.
//   node test/main-at-test.mjs [rounds per delay]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const ROUNDS = Number(process.argv[2] || 2);
const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-at-${Date.now()}.log`);
const STATE = path.join(L.USER_DATA, 'flow-state.json');
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const kill = (sig) => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const quitNow = () => {
  if (!L.electronPids().length) throw new Error('no Flow process to quit');
  kill('SIGTERM');
};
const gone = () => L.waitFor(() => L.electronPids().length === 0, 20000, 'the app to quit').then(() => true, () => false);
const wsOf = (id) => ({ id, name: id, folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [], saved: [] });

async function click(page, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
const pill = (page, name, sel = '') => L.waitFor(() => page.eval(`const p = [...document.querySelectorAll('#spaces .sp[data-i]')].find((x) => x.querySelector('.sn').textContent.trim() === ${j(name)});
  const e = p && (${j(sel)} ? p.querySelector(${j(sel)}) : p); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;`), 10000, `the ${name} pill${sel ? ' ' + sel : ''}`);
const shows = (page) => page.eval('return window.__flow.state().ui.at;');

async function round(delay, n) {
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(STATE, j({ v: 11, ws: [wsOf('flow'), wsOf('mynotes'), wsOf('infra')], ui: { at: 'flow' } }));
  L.launch(LOG);
  let page = await L.flowPage();
  await L.sleep(1500);
  const my = await pill(page, 'mynotes');
  await click(page, my.x, my.y);
  await L.waitFor(async () => (await shows(page)) === 'mynotes' || null, 5000, 'the main window on mynotes');
  const pop = await pill(page, 'mynotes', '.pop').catch(() => null);
  if (pop) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pop.x, y: pop.y });
    await L.sleep(250);
    await click(page, pop.x, pop.y);
  }
  const popped = await L.waitFor(async () => (await L.targets(L.PORT)).some((t) => t.type === 'page' && t.url.includes('#solo=mynotes')) || null, 10000, 'the pop-out').catch(() => false);
  await L.sleep(1500);
  const inf = await pill(page, 'infra');
  await click(page, inf.x, inf.y);
  const onInfra = await L.waitFor(async () => (await shows(page)) === 'infra' || null, 5000, 'the main window on infra').catch(() => false);
  await L.sleep(delay);
  const atQuit = await shows(page);
  page.close();
  quitNow();
  const quit = await gone();
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8')).ui || {};
  L.launch(LOG);
  page = await L.flowPage();
  await L.sleep(1500);
  const after = await shows(page);
  page.close();
  quitNow();
  await gone();
  check(`quit ${delay} ms after the main window moved to infra, mynotes popped out (round ${n}): the state file and the main window after a restart say infra`,
    popped && onInfra && atQuit === 'infra' && quit && saved.at === 'infra' && after === 'infra', j({ popped, atQuit, savedAt: saved.at, after }));
}

try {
  console.log(`app log: ${LOG}`);
  for (const delay of [3000, 600]) for (let n = 1; n <= ROUNDS; n++) await round(delay, n);
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




