/* A file tab comes back where it was scrolled after a quit, as a web page does (STATUS item 50). In the real app with
   the page-only state (test/page-state.mjs, written fresh into /tmp/flow-dev-page), files open as page windows: a
   Markdown file from the flow workspace's folder (~/flow/test/files-md-fixture-status.md, a fixed copy of STATUS.md,
   read only: STATUS.md itself changes under a run) and a long HTML and a long text file
   that Flow downloads first, so they are with the workspace's downloads. Each is scrolled with the wheel; Flow quits
   (SIGTERM, the same quit as the menu, the flush of every tab's place included) and starts again on the same userData;
   each file's page must be back at the same scrollY. It starts and stops the app itself, so no page dev instance may
   be running. Run from the repo root: node test/page-file-restart.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = process.env.SHOTS || '/tmp/flow-page-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 9564;
const MARKER = '--flow-dev=page';
const USER_DATA = '/tmp/flow-dev-page';
const FIX_PORT = 19588, FIX = `http://127.0.0.1:${FIX_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = () => {
  try {
    return execFileSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARKER}`], { encoding: 'utf8' }).trim();
  } catch (e) {
    if (e.status === 1) return '';
    throw e;
  }
};
if (running()) {
  console.error(`a page dev instance is running (${running().split('\n').join(', ')}); stop it first`);
  process.exit(2);
}
fs.rmSync(USER_DATA, { recursive: true, force: true });
execFileSync('node', [path.join(ROOT, 'test', 'page-state.mjs'), USER_DATA], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
async function waitFor(fn, ms, every = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => null);
    if (last) return last;
    await sleep(every);
  }
  return last;
}
/* A PDF of n pages, one line of Helvetica each, with a correct xref table. */
function pdfOf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 36 Tf 72 640 Td (page ${i + 1} of a long pdf) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return out;
}
const server = http.createServer((req, res) => {
  if (req.url === '/long.pdf' || req.url === '/web.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', ...(req.url === '/long.pdf' ? { 'content-disposition': 'attachment; filename="flow-long.pdf"' } : {}) });
    res.end(pdfOf(12));
    return;
  }
  if (req.url === '/long.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="flow-long.txt"' });
    res.end(Array.from({ length: 4000 }, (_, i) => `line ${i} of a long text file`).join('\n'));
    return;
  }
  if (req.url === '/long.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': 'attachment; filename="flow-long.html"' });
    res.end(`<!doctype html><title>long html</title><body style="font:18px/1.6 Arial">${Array.from({ length: 1500 }, (_, i) => `<p>paragraph ${i}</p>`).join('')}</body>`);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(FIX_PORT, '127.0.0.1', r));
class CDP {
  static async connect(wsUrl) {
    const c = new CDP();
    c.ws = new WebSocket(wsUrl);
    c.id = 0;
    c.pending = new Map();
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error(`websocket error: ${wsUrl}`)); });
    c.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && c.pending.has(d.id)) {
        const { res, rej, method } = c.pending.get(d.id);
        c.pending.delete(d.id);
        if (d.error) rej(new Error(`${method}: ${d.error.message}`));
        else res(d.result);
      }
    };
    c.ws.onclose = () => c.pending.forEach(({ rej, method }) => rej(new Error(`${method}: connection closed`)));
    return c;
  }
  send(method, params = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}: the connection is closed`));
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate threw: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const json = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let app = null;
async function start(label) {
  const log = fs.openSync(path.join(SHOTS, `file-restart-${label}.log`), 'w');
  app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${USER_DATA}`, 'FLOW_TMUX_SOCKET=flow-dev-page', `FLOW_CDP_PORT=${PORT}`,
    './node_modules/.bin/electron', '--inspect=9594', '.', '--no-sandbox', MARKER], { cwd: ROOT, stdio: ['ignore', log, log] });
  app.exited = new Promise((r) => app.once('exit', (code, signal) => r({ code, signal })));
  const t = await waitFor(async () => (await json()).find((x) => x.type === 'page' && /index\.html$/.test(x.url)), 30000);
  if (!t) throw new Error(`${label}: no index.html target`);
  const host = await CDP.connect(t.webSocketDebuggerUrl);
  await waitFor(() => host.eval('!!window.__flow && window.__flow.ready.then(() => true)'), 20000);
  return host;
}
const P = (id) => `window.__flow.page(${JSON.stringify(id)})`;
const guestY = async (url) => {
  const t = (await json()).find((x) => x.type === 'webview' && x.url === url);
  if (!t) return null;
  const g = await CDP.connect(t.webSocketDebuggerUrl);
  const y = await g.eval('scrollY');
  g.close();
  return y;
};
// Where Chromium's PDF viewer is in the page at a url, read from main (the viewer's frame is out of the page's reach).
async function inViewer(url, what) {
  const m = (await (await fetch('http://127.0.0.1:9594/json/list')).json())[0];
  const main = await CDP.connect(m.webSocketDebuggerUrl);
  const r = await main.send('Runtime.evaluate', { includeCommandLineAPI: true, awaitPromise: true, returnByValue: true, expression: `(async () => {
    const { webContents } = require('electron');
    const wc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.getURL() === ${JSON.stringify(url)});
    const f = wc && wc.mainFrame.framesInSubtree.find((x) => x.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'));
    return f ? f.executeJavaScript(${JSON.stringify(what)}) : null;
  })()` });
  main.close();
  return r.result.value;
}
const pdfY = (url) => inViewer(url, "(() => { const p = document.querySelector('pdf-viewer')?.viewport_; return p && p.position ? p.position.y : null; })()");
const paneClosed = (url) => inViewer(url, "(() => { const v = document.querySelector('pdf-viewer'); return v ? v.sidenavCollapsed_ === true : null; })()");
const panes = [];
let host = null;
const results = [];
try {
  host = await start('first');
  // a long text file and a long HTML file, downloaded by Flow (each page window closes once its file is with the
  // downloads); the HTML file in ~/flow (the mockup) scrolls inside its own boxes, not the window, which is item 56's
  const wsI = await host.eval(`+document.querySelector('#spaces .sp.on').dataset.i`);
  const downloaded = async (name) => {
    await host.eval(`window.__flow.openPage(${JSON.stringify(`${FIX}/${name}`)})`);
    const ext = name.split('.').pop();
    const f = await waitFor(() => host.eval(`(() => { const d = (window.__flow.state().ws[${wsI}].downloads || []).find((x) => new RegExp('flow-long( \\\\(\\\\d+\\\\))?\\\\.${ext}$').test(x.file)); return d && d.file; })()`), 15000);
    if (!f) throw new Error(`${name} was not downloaded`);
    return f;
  };
  const files = [path.join(os.homedir(), 'flow', 'test', 'files-md-fixture-status.md'), await downloaded('long.html'), await downloaded('long.txt'), await downloaded('long.pdf')];
  const opened = [];
  // the files as file tabs, then a PDF that is a web page
  const pages = [];
  for (const file of files) {
    const o = await host.eval(`window.flow.files.open(null, ${JSON.stringify(file)})`);
    if (!o || !o.url) throw new Error(`files.open ${file}: ${JSON.stringify(o)}`);
    pages.push({ file, url: o.url });
  }
  pages.push({ file: 'web.pdf (a web page)', url: `${FIX}/web.pdf` });
  const placeOf = (pg) => (/\.pdf\b/.test(pg.file) ? pdfY(pg.url) : guestY(pg.url));
  for (const pg of pages) {
    const { file } = pg;
    const o = { url: pg.url };
    const id = await host.eval(`window.__flow.openPage(${JSON.stringify(o.url)})`);
    await waitFor(() => host.eval(`(() => { const p = ${P(id)}; return !!p && !p.isLoading() && p.getURL() === ${JSON.stringify(o.url)}; })()`), 20000);
    await sleep(/\.pdf\b/.test(file) ? 3000 : 1200);
    if (/\.pdf\b/.test(file)) panes.push({ file, when: 'first open', closed: await waitFor(() => paneClosed(o.url), 6000) });
    // the wheel over the middle of its page, once its window is in front and nothing covers that point
    // over the document itself: a PDF viewer this narrow keeps its page thumbnails in its left half
    const across = /\.pdf\b/.test(file) ? 0.8 : 0.5;
    const at = await host.eval(`(() => { const w = document.querySelector('.win[data-id=${JSON.stringify(id)}] webview'); const r = w.getBoundingClientRect(); const x = r.left + r.width * ${across}, y = r.top + r.height / 2; return document.elementFromPoint(x, y) === w ? { x, y } : null; })()`);
    if (!at) throw new Error(`${file}: its page is covered where the wheel would go`);
    // a PDF scrolls once its viewer has the document: the wheel goes on until it has moved
    for (let k = 0; k < (/\.pdf\b/.test(file) ? 10 : 1); k++) {
      for (let i = 0; i < 12; i++) {
        await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 400, button: 'none', buttons: 0 });
        await sleep(60);
      }
      if (!/\.pdf\b/.test(file) || (await placeOf(pg)) > 2000) break;
      await sleep(500);
    }
    await sleep(800);
    const y0 = await placeOf(pg);
    opened.push({ file, id, url: o.url, y0, pg });
    console.log(`first run: ${path.basename(file)} scrolled to ${y0}`);
  }
  host.close();
  host = null;
  execFileSync('pkill', ['-TERM', '-f', `[e]lectron/dist/electron .*${MARKER}`]);
  console.log('SIGTERM:', JSON.stringify(await Promise.race([app.exited, sleep(20000).then(() => null)])));
  if (process.env.DEBUG) {
    const st = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8'));
    for (const w of st.ws.flatMap((x) => x.windows)) for (const t of w.tabs || []) if (/pdf/.test(t.url)) console.log('DEBUG kept', w.id, t.url.slice(-40), JSON.stringify(t.scroll || null), t.history ? `history ${t.history.entries.length}` : 'no history');
  }
  host = await start('second');
  if (process.env.DEBUG) {
    await host.send('Runtime.enable');
    host.ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.consoleAPICalled' && /warn|error/.test(d.params.type)) console.log('DEBUG console', d.params.type, d.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300)); });
  }
  // The windows come back where the first run put them, side by side and partly past the view. A page off screen is
  // hidden and takes its place on the first frame it is shown, so the whole space comes into view first, as a pinch
  // out shows it (ctrl+wheel over the desktop).
  const desk = await host.eval(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); return { x: Math.round(v.left + v.width / 2), y: Math.round(v.bottom - 40) }; })()`);
  for (let i = 0; i < 8; i++) {
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: desk.x, y: desk.y, deltaX: 0, deltaY: 300, modifiers: 2, button: 'none', buttons: 0 });
    await sleep(80);
  }
  for (const o of opened) {
    // a page loads once its window is shown: bring each to the front the way the sidebar does (focusWin)
    await waitFor(() => host.eval(`!!${P(o.id)}`), 15000);
    const y = await waitFor(async () => {
      const v = await placeOf(o.pg);
      return v != null && (await host.eval(`!${P(o.id)}.isLoading()`)) ? { v } : null;
    }, 20000);
    await sleep(/\.pdf\b/.test(o.file) ? 6000 : 2500);
    const y1 = await placeOf(o.pg);
    if (/\.pdf\b/.test(o.file)) panes.push({ file: o.file, when: 'after the restart', closed: await paneClosed(o.url) });
    results.push({ file: path.basename(o.file), before: o.y0, after: y1, ok: o.y0 > 0 && y1 === o.y0, loaded: !!y });
    console.log(`${o.y0 > 0 && y1 === o.y0 ? 'ok  ' : 'FAIL'} the file tab ${path.basename(o.file)} comes back at its scroll after a quit (${y1}, before the quit ${o.y0})`);
  }
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e}`);
} finally {
  if (host) host.close();
  server.close();
  try { execFileSync('pkill', ['-f', `[e]lectron/dist/electron .*${MARKER}`]); } catch (e) { if (e.status !== 1) throw e; }
  await sleep(1500);
  try { execFileSync('tmux', ['-L', 'flow-dev-page', 'kill-server'], { stdio: 'ignore' }); } catch (e) { if (e.status !== 1) throw e; }
}
for (const p of panes) console.log(`${p.closed === true ? 'ok  ' : 'FAIL'} the PDF ${p.file} opens with its thumbnails pane closed (${p.when})`);
const good = results.filter((r) => r.ok).length + panes.filter((p) => p.closed === true).length - panes.length;
console.log(results.length === 5 && good === 5 ? 'all checks passed' : `${5 - good} of 5 tabs did not come back at their place`);
process.exit(results.length === 5 && good === 5 ? 0 : 1);




