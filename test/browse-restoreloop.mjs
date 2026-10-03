// browse: how often a page comes back at its saved scroll across repeated quits. Each round wheel-scrolls one page
// to a new place the way a user does, waits for page.js to save it, quits and relaunches browse's copy, shows the
// page through its sidebar row and reads where it came back.
// usage: test/browse-app.sh reset && test/browse-app.sh start && node test/browse-restoreloop.mjs [rounds] [wait-ms]
//   BROWSE_LOOP_URL=<page> picks another page (default rfc9110)
import { execFileSync } from 'node:child_process';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const ROUNDS = Number(process.argv[2] || 6);
const WAIT = Number(process.argv[3] || 12000);
const URL_ = process.env.BROWSE_LOOP_URL || 'https://www.rfc-editor.org/rfc/rfc9110.html';
const MATCH = new URL(URL_).pathname;
const APP = new URL('./browse-app.sh', import.meta.url).pathname;
let host;
async function connect() {
  host = await Cdp.connect((await waitFor(async () => (await targets(9571)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 40000, 'the Flow window')).webSocketDebuggerUrl);
  await waitFor(() => host.eval('return !!(window.__flow && window.__flow.ready);'), 40000, 'window.__flow');
  await host.eval('await window.__flow.ready; return true;');
}
const guest = async () => {
  const t = await waitFor(async () => (await targets(9571)).find((x) => x.type === 'webview' && x.url.includes(MATCH)), 30000, 'the page');
  return Cdp.connect(t.webSocketDebuggerUrl);
};
async function show(id) {
  const r = await host.eval(`const e = document.querySelector('[data-act="tab|${id}|0"]'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 };`);
  if (r) for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await host.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
}

await connect();
const id = await host.eval(`return window.__flow.openPage(${JSON.stringify(URL_)});`);
await sleep(8000);
const results = [];
for (let round = 1; round <= ROUNDS; round++) {
  await show(id);
  await sleep(1500);
  const g = await guest();
  await sleep(1500);
  const box = await host.eval(`const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
  // a different place each round: wheel down or up by a few screens
  // odd rounds go further down, even rounds come back up a little: never back at the top
  const dir = round % 2 ? 1 : -1;
  const steps = round % 2 ? 20 + round * 7 : 12;
  for (let i = 0; i < steps; i++) { await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 100 * (round === 1 ? 1 : dir), button: 'none', buttons: 0 }); await sleep(20); }
  await sleep(WAIT);
  const saved = await g.eval('return Math.round(scrollY);');
  g.close();
  host.close();
  execFileSync(APP, ['stop'], { stdio: 'inherit' });
  execFileSync(APP, ['start', '/tmp/flow-dev-browse.log'], { stdio: 'inherit' });
  await connect();
  await sleep(4000);
  await show(id);
  const g2 = await guest();
  await sleep(6000);
  const back = await g2.eval('return Math.round(scrollY);');
  g2.close();
  // a round whose scroll did not take (the page still at the top) proves nothing: it is not counted as back
  const ok = saved > 500 && Math.abs(back - saved) < 50;
  results.push(ok);
  console.log(`round ${round}: saved ${saved}, came back ${back} ${ok ? 'ok' : 'OFF'}`);
}
console.log(`${results.filter(Boolean).length} of ${results.length} came back at the saved place (wait ${WAIT} ms after the scroll)`);
process.exitCode = results.length && results.every(Boolean) ? 0 : 1;
host.close();




