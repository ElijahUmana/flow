// A page with unsaved changes holds a close of the Flow window: main waits (installed's guard), app.js brings that
// page's window into view and the page asks Leave or Stay (page's confirmClose). Stay keeps Flow open, Leave closes it.
//   node test/ui-quitguard.mjs   (stops and starts test/ui-dev.sh itself; serves its guarded page on 127.0.0.1)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';
import { PORT } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
const PAGE = '<!doctype html><title>guarded</title><textarea id="t" style="margin:20px;width:300px;height:120px"></textarea>'
  + '<script>addEventListener("beforeunload", (e) => { if (document.getElementById("t").value) { e.preventDefault(); e.returnValue = ""; } });</script>';
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_ = `http://127.0.0.1:${server.address().port}/`;
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json());
/* Flow's main window is up: listed by CDP. Once Flow has quit nothing answers on its port (refused), or a request it
   was answering is cut off (the other side closed); any other failure is an error, so it cannot pass for Flow
   having closed. */
const GONE = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET']);
async function mainOpen() {
  let list;
  try {
    list = await targets();
  } catch (err) {
    if (err.cause && GONE.has(err.cause.code)) return false;
    throw err;
  }
  return list.some((t) => t.type === 'page' && /\/src\/index\.html$/.test(t.url));
}
async function guestEval(expr) {
  const t = (await targets()).find((x) => x.type === 'webview' && x.url.startsWith(URL_));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`cannot open ${t.url}`)); });
  const v = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : undefined); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  return v;
}
const waitFor = async (app, expr, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await evaluate(app, expr); if (v) return v; }
  return evaluate(app, expr);
};
/* Until expr gives something, or Flow's window has gone (then { gone: true }: it closed without asking). */
async function askedOrGone(app, expr, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    if (!(await mainOpen())) return { gone: true };
    const v = await evaluate(app, expr);
    if (v) return v;
  }
  return null;
}
const r = (app, sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);

dev('stop');
dev('start', '--fresh');
const app = await connectTo(PORT, /\/src\/index\.html$/);
for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
await sleep(800);
// a note in front, then the dock's page button: a new page window, its address focused
const week = await r(app, '.tr[data-act="note|n-week"]');
await click(app, week.cx, week.cy);
await sleep(600);
const had = await evaluate(app, '__flow.windows().map((w) => w.id)');
const v = await r(app, '#viewport'), pb = await r(app, '#dock [data-k="page"]');
await mouse(app, 'mouseMoved', pb.cx, v.y + v.h - 3);
await sleep(300);
await waitFor(app, `(() => { const d = document.getElementById('dock'); return getComputedStyle(d).visibility !== 'hidden' && d.style.opacity !== '0'; })()`, 3000);
for (let y = v.y + v.h - 6; y > pb.cy; y -= 3) await mouse(app, 'mouseMoved', pb.cx, y);
await click(app, pb.cx, pb.cy);
await sleep(800);
const pw = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'page' && !had.includes(w.id));
if (!R.ok('a new page window', !!pw)) { dev('stop'); process.exit(1); }
await type(app, URL_);
await key(app, 'Enter');
R.ok('it loads the guarded page', await waitFor(app, `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && !p.isLoading() && p.getTitle() === 'guarded'; })()`, 20000));
// typing into the page is the user activation a beforeunload guard needs
const wv = await r(app, `.win[data-id="${pw.id}"] .pgv webview:not(.off)`);
const s = await evaluate(app, `(() => { const e = document.querySelector('.win[data-id="${pw.id}"] .pgv webview:not(.off)'); return e.getBoundingClientRect().width / e.offsetWidth; })()`);
await click(app, wv.x + 60 * s, wv.y + 60 * s);
await sleep(300);
await type(app, 'draft');
await sleep(400);
R.ok('typing reaches the page', (await guestEval('document.getElementById("t").value')) === 'draft');
// another window in front, then Flow's window is closed
const wt = await r(app, '.win[data-id="w-week"] > .tb');
await click(app, wt.x + 30, wt.cy);
await sleep(400);
await evaluate(app, 'setTimeout(() => window.close(), 50), true');
const asked = await askedOrGone(app, `(() => { const w = document.querySelector('.win[data-id="${pw.id}"]'); const a = w && w.querySelector('.pask.on'); return a ? { text: a.textContent, front: w.classList.contains('front') } : null; })()`);
R.ok('closing Flow with an unsaved page brings that page forward with Leave / Stay', !!asked && !asked.gone && asked.front && /changes that may not be saved/.test(asked.text), asked);
if (!asked || asked.gone) { R.summary(); dev('stop'); server.close(); process.exit(1); }
const stay = await r(app, `.win[data-id="${pw.id}"] .pask.on .pa-b:not(.pa-yes)`);
if (stay) await click(app, stay.cx, stay.cy);
await sleep(2000);
R.ok('Stay: Flow stays open, the page keeps its text', (await mainOpen()) && (await guestEval('document.getElementById("t").value')) === 'draft');
await evaluate(app, 'setTimeout(() => window.close(), 50), true');
const again = await askedOrGone(app, `!!document.querySelector('.win[data-id="${pw.id}"] .pask.on')`);
R.ok('closing again asks again', again === true, again);
if (again !== true) { R.summary(); dev('stop'); server.close(); process.exit(1); }
const leave = await r(app, `.win[data-id="${pw.id}"] .pask.on .pa-yes`);
if (leave) await click(app, leave.cx, leave.cy);
let closed = false;
for (let i = 0; i < 40 && !closed; i++) { await sleep(250); closed = !(await mainOpen()); }
R.ok('Leave: Flow closes', closed);
R.summary();
dev('stop');
server.close();
process.exit();




