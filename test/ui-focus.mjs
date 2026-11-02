// Going to a page window from the sidebar leaves it ready to type: after a click on a note's row (the keys in the
// note), a click on the page's row and a key press reach the page, not the note. Real input, a page served here.
//   node test/ui-focus.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';
import { PORT } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
const PAGE = '<!doctype html><title>long</title><body style="margin:0">'
  + Array.from({ length: 400 }, (_, i) => `<p style="height:40px;margin:0">line ${i}</p>`).join('') + '</body>';
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(PAGE); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_ = `http://127.0.0.1:${server.address().port}/long`;
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json());
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
const waitFor = async (app, expr, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await evaluate(app, expr); if (v) return v; }
  return evaluate(app, expr);
};
const r = (app, sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
async function open() {
  const app = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
  await evaluate(app, 'window.__flow.ready');
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  return app;
}
async function newPage(app) {
  const wk = await r(app, '.tr[data-act="note|n-week"]');
  await click(app, wk.cx, wk.cy);
  await sleep(500);
  const had = await evaluate(app, '__flow.windows().map((w) => w.id)');
  const v = await r(app, '#viewport'), pb = await r(app, '#dock [data-k="page"]');
  await mouse(app, 'mouseMoved', pb.cx, v.y + v.h - 3);
  await sleep(300);
  await waitFor(app, `(() => { const d = document.getElementById('dock'); return getComputedStyle(d).visibility !== 'hidden' && d.style.opacity !== '0'; })()`, 3000);
  for (let y = v.y + v.h - 6; y > pb.cy; y -= 3) await mouse(app, 'mouseMoved', pb.cx, y);
  await click(app, pb.cx, pb.cy);
  await sleep(800);
  const pw = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'page' && !had.includes(w.id));
  if (!pw) return null;
  await type(app, URL_);
  await key(app, 'Enter');
  await waitFor(app, `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && !p.isLoading() && p.getTitle() === 'long'; })()`, 20000);
  await sleep(1200);
  return pw;
}

const at = (app, x, y, sel) => evaluate(app, `(() => { const e = document.elementFromPoint(${x}, ${y}); return !!(e && e.closest(${JSON.stringify(sel)})); })()`);
async function rowClick(app, sel) {
  const p = await r(app, sel);
  if (!p || !(await at(app, p.x + 40, p.cy, sel))) return false;
  await click(app, p.x + 40, p.cy);
  await sleep(600);
  return true;
}
const noteBody = (app) => evaluate(app, `(() => { const s = __flow.state(); for (const ws of s.ws) { const n = ws.notes.find((x) => x.id === 'n-week'); if (n) return n.body || ''; } return null; })()`);
dev('stop');
dev('start', '--fresh');
const app = await open();
const pw = await newPage(app);
if (R.ok('a long page loads in a new page window', !!pw)) {
  R.ok('the week note\'s row takes a click', await rowClick(app, '.tr[data-act="note|n-week"]'));
  const inNote = await evaluate(app, `!!(document.activeElement && document.activeElement.closest('.win') && document.activeElement.closest('.win').dataset.id === 'w-week')`);
  R.ok('the keys are in the note', inNote);
  const body0 = await noteBody(app);
  R.ok('the page\'s row takes a click', await rowClick(app, `.tr[data-act^="tab|${pw.id}|"]`));
  const focused = await evaluate(app, `(() => { const a = document.activeElement; return a ? a.tagName + (a.closest('.win') ? ' in ' + a.closest('.win').dataset.id : '') : null; })()`);
  await key(app, 'End');
  await sleep(800);
  const y = await guestEval('Math.round(scrollY)');
  const body1 = await noteBody(app);
  R.ok('a key pressed after it reaches the page: End scrolls it to the end', typeof y === 'number' && y > 500, { y, focused });
  R.ok('and nothing went into the note', body1 === body0, { before: body0 && body0.slice(-40), after: body1 && body1.slice(-40) });
}
R.ok('no console errors or exceptions in the main window', app.errors.filter((e) => !e.startsWith('console.warning')).length === 0, app.errors.slice(0, 3));
R.summary();
dev('stop');
server.close();
process.exit();




