// Item 40: a quote clipped from a page is highlighted there again after a quit (a SIGTERM) and a start, on a web page
// and on a file page opened from the sidebar's files. Real input: a triple-click selects the sentence, ✂ clips it.
//   node test/ui-marks-restart.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';
import { PORT, CWD } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
const QUOTE = 'Flow keeps every highlight across a restart.';
const PAGE = `<!doctype html><title>quotes</title><body style="margin:40px;font:18px Arial"><p>Some text first.</p><p>${QUOTE}</p><p>And some after.</p></body>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(PAGE); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_ = `http://127.0.0.1:${server.address().port}/quotes`;
const FILE = path.join(CWD, 'cwd', 'flow', 'quotes.md');
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json());
async function guestEval(match, expr) {
  const t = (await targets()).find((x) => x.type === 'webview' && match(x.url));
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
const at = (app, x, y, sel) => evaluate(app, `(() => { const e = document.elementFromPoint(${x}, ${y}); return !!(e && e.closest(${JSON.stringify(sel)})); })()`);
const marks = (match) => guestEval(match, `(() => { const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0; })()`);
async function open() {
  const app = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
  await evaluate(app, 'window.__flow.ready');
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  return app;
}
const loaded = (id, title) => `(() => { const p = __flow.page(${JSON.stringify(id)}); return !!p && p.guests().length > 0 && !p.isLoading() && p.getTitle() === ${JSON.stringify(title)}; })()`;
async function webPage(app) {
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
  if (!(await waitFor(app, loaded(pw.id, 'quotes'), 20000))) return null;
  await sleep(1000);
  return { id: pw.id, title: 'quotes', match: (u) => u.startsWith(URL_) };
}
/* A row of the sidebar's files, clicked once the sidebar has stopped changing and the row is the one under the point. */
async function filesRow(app, label, depth) {
  let last = null;
  for (const end = Date.now() + 4000; Date.now() < end; await sleep(400)) {
    const now = await evaluate(app, `document.getElementById('sblist').innerHTML`);
    if (now === last) break;
    last = now;
  }
  const p = await evaluate(app, `(() => {
    const e = [...document.querySelectorAll('#sblist .tr[data-act^="files|"]')].find((x) => x.querySelector('.l').textContent === ${JSON.stringify(label)} && x.classList.contains('d${depth}'));
    if (!e) return null;
    e.scrollIntoView({ block: 'nearest' });
    const b = e.querySelector('.l').getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
  if (!p || !(await at(app, p.x, p.y, '.tr[data-act^="files|"]'))) return false;
  await click(app, p.x, p.y);
  await sleep(400);
  return true;
}
async function filePage(app) {
  const had = await evaluate(app, '__flow.windows().map((w) => w.id)');
  const place = '~' + path.dirname(FILE).slice((process.env.HOME || '/home/claude').length);
  if (!(await filesRow(app, place, 0))) return null;
  for (let i = 0; i < 20 && !(await evaluate(app, `[...document.querySelectorAll('#sblist .tr[data-act^="files|"] .l')].some((l) => l.textContent === 'quotes.md')`)); i++) await sleep(250);
  if (!(await filesRow(app, 'quotes.md', 1))) return null;
  const pw = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'page' && !had.includes(w.id));
  if (!pw) return null;
  if (!(await waitFor(app, loaded(pw.id, 'quotes.md'), 20000))) return null;
  await sleep(1000);
  return { id: pw.id, title: 'quotes.md', match: (u) => u.startsWith('flow-file:') && u.endsWith('/quotes.md') };
}
// the quote's line in the page, as a point in the main window: the page's own coordinates, scaled to its webview
async function quotePoint(app, pg) {
  const q = await guestEval(pg.match, `(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.data.indexOf(${JSON.stringify(QUOTE)});
      if (i < 0) continue;
      const g = document.createRange();
      g.setStart(n, i);
      g.setEnd(n, i + ${QUOTE.length});
      const b = g.getClientRects()[0];
      return { x: b.left + 12, y: b.top + b.height / 2, iw: innerWidth };
    }
    return null;
  })()`);
  const wv = await r(app, `.win[data-id="${pg.id}"] .pgv webview:not(.off)`);
  if (!q || !wv) return null;
  const k = wv.w / q.iw;
  return { x: wv.x + q.x * k, y: wv.y + q.y * k };
}
async function round(label, kind) {
  dev('stop');
  dev('start', '--fresh');
  if (kind === 'file') fs.writeFileSync(FILE, `# quotes\n\nSome text first.\n\n${QUOTE}\n\nAnd some after.\n`);
  let app = await open();
  const pg = kind === 'file' ? await filePage(app) : await webPage(app);
  if (!R.ok(`${label}: the page loads`, !!pg)) return;
  const p = await quotePoint(app, pg);
  if (!R.ok(`${label}: the quote is on screen, in its page`, p && (await at(app, p.x, p.y, `.win[data-id="${pg.id}"] webview`)), p)) return;
  await mouse(app, 'mouseMoved', p.x, p.y);
  for (const n of [1, 2, 3]) {
    await mouse(app, 'mousePressed', p.x, p.y, { clickCount: n });
    await mouse(app, 'mouseReleased', p.x, p.y, { clickCount: n });
  }
  await sleep(300);
  const sel = await guestEval(pg.match, 'String(getSelection()).trim()');
  if (!R.ok(`${label}: a triple-click selects the sentence`, sel === QUOTE, sel)) return;
  // ✂ shows once the page has told its window about the selection (batch 3: only while there is one)
  let cb = null;
  for (let i = 0; i < 15 && !cb; i++) {
    const c = await r(app, `.win[data-id="${pg.id}"] .pclip`);
    if (c && c.w > 0 && (await at(app, c.cx, c.cy, `.win[data-id="${pg.id}"] .pclip`))) cb = c;
    else await sleep(200);
  }
  if (!R.ok(`${label}: ✂ is there to click`, !!cb)) return;
  await click(app, cb.cx, cb.cy);
  let n = 0;
  for (let i = 0; i < 25 && !n; i++) { await sleep(200); n = await marks(pg.match); }
  if (!R.ok(`${label}: the clipped sentence is highlighted on its page`, n >= 1, n)) return;
  await sleep(1500);
  dev('stop');
  dev('start');
  app = await open();
  await waitFor(app, loaded(pg.id, pg.title), 20000);
  const seen = [];
  for (let i = 0; i < 20; i++) {
    seen.push(await marks(pg.match));
    if (seen[seen.length - 1] >= 1) break;
    await sleep(500);
  }
  const note = await evaluate(app, `(() => { const p = __flow.page(${JSON.stringify(pg.id)}); const r = p && window.FlowNotes.pagesDoc()[window.FlowNotes.key(p.getURL())]; return r ? r.note : null; })()`);
  R.ok(`${label}: after a restart the page highlights the quote again`, seen[seen.length - 1] >= 1 && typeof note === 'string' && note.includes(QUOTE), { marks: seen.join(','), note });
}
await round('web page', 'web');
await round('file page', 'file');
R.summary();
dev('stop');
server.close();
process.exit();




