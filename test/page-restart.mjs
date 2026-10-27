/* Tabs and saved pages across a restart, on the real backend: opens three tabs in a page of test/page-harness.html
   (a real alphaxiv page and two fixture pages), saves two of them, reorders, quits Flow the way ⌘Q does, starts it
   again on the same userData and checks that the tabs come back in order with the same tab shown, that only the shown
   tab loads, that the saved pages are still starred, and that a new tab lists them with the hover card.
   It starts and stops the app itself, twice, and wipes /tmp/flow-dev-page first, so no page dev instance may be
   running. Run from the repo root: node test/page-restart.mjs */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9564;
const MAIN_PORT = 9594;
const FIX_PORT = Number(process.env.FIX_PORT || 19575);
const USER_DATA = '/tmp/flow-dev-page';
const MARKER = '--flow-dev=page';
const SHOTS = process.env.SHOTS || '/tmp/flow-page-shots';
const FIX = `http://127.0.0.1:${FIX_PORT}`;
const REAL = 'https://www.alphaxiv.org/abs/2610.09043';
const ABOUT_PARA = 'This page has no description, so the first real paragraph of its text says what it is about instead.';
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`);
  if (!cond) failures++;
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, every = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch (e) {
      // A target listed before its document is ready has no context to evaluate in yet.
      if (!/Cannot find default execution context/.test(String(e && e.message))) throw e;
      last = null;
    }
    if (last) return last;
    await sleep(every);
  }
  return last;
}
const running = () => {
  try {
    return execFileSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARKER}`], { encoding: 'utf8' }).trim();
  } catch (e) {
    if (e.status === 1) return '';
    throw e;
  }
};
if (running()) {
  console.error(`a page dev instance is already running (${running().split('\n').join(', ')}); stop it first: pkill -f "[e]lectron/dist/electron .*${MARKER}"`);
  process.exit(2);
}
fs.rmSync(USER_DATA, { recursive: true, force: true });

/* ---------- fixture site ---------- */
// A web font that arrives 1.5 s after its page has loaded, after Chromium's last scroll restore, and that changes how the
// text wraps (rfc9110 does this with its fonts).
const LATE_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const LATE_TEXT = 'a sentence long enough to wrap onto more lines when its font is wider, so the text above the view grows. '.repeat(4);
const TOP_TEXT = `(() => { const p = [...document.querySelectorAll('p')].find((e) => e.getBoundingClientRect().bottom > 0); return { y: Math.round(scrollY), top: p ? p.textContent.split(':')[0] : '', at: p ? Math.round(p.getBoundingClientRect().top) : null }; })()`;
const lateLoaded = `[...document.fonts].some((f) => f.family === 'Late' && f.status === 'loaded')`;
// /moving answers itself in the first run and redirects to /moved in the second (EF Start's /work once its session is gone).
let movingAway = false;
// A page that scrolls inside a box of its own; by the second start, lines arrive above its content after it loads.
let innerGrows = false;
const INNER_LINE = (i) => `inner line ${i} of a box that scrolls by itself`;
const pageHTML = (t) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body><h1>${t}</h1><p>nothing else here</p></body></html>`;
const server = http.createServer((req, res) => {
  const send = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
  if (req.url === '/plain-target') send(pageHTML('plain target'));
  else if (req.url === '/nested' || req.url === '/nestfind') send(`<!doctype html><title>nested</title><body style="margin:0;font:18px/1.5 Arial"><div id="pg" style="position:fixed;inset:0;overflow-y:auto"><p>a page that scrolls inside its own box</p>${Array.from({ length: 30 }, (_, i) => `<p>above the board ${i}</p>`).join('')}<div class="board" style="overflow-x:auto;white-space:nowrap;height:240px">${Array.from({ length: 40 }, (_, i) => `<span style="display:inline-block;width:200px">column ${i}</span>`).join('')}</div>${Array.from({ length: 60 }, (_, i) => `<p>below the board ${i}</p>`).join('')}</div></body>`);
  // Like Notion: a page box with a board in it, which sets its own place (box and board) a second after it shows, once
  // its data is in, and so would undo a place set before that.
  else if (req.url === '/selfplace') send(`<!doctype html><title>selfplace</title><body style="margin:0;font:18px/1.5 Arial"><div id="pg" style="position:fixed;inset:0;overflow-y:auto"><p>a page that sets its own place late</p>${Array.from({ length: 30 }, (_, i) => `<p>above the board ${i}</p>`).join('')}<div class="board" style="overflow-x:auto;white-space:nowrap;height:240px">${Array.from({ length: 40 }, (_, i) => `<span style="display:inline-block;width:200px">column ${i}</span>`).join('')}</div>${Array.from({ length: 60 }, (_, i) => `<p>below the board ${i}</p>`).join('')}</div><script>
    addEventListener('load', () => {
      const own = () => setTimeout(() => { document.getElementById('pg').scrollTop = 200; document.querySelector('.board').scrollLeft = 0; }, 1000);
      if (document.visibilityState === 'visible') own();
      else document.addEventListener('visibilitychange', own, { once: true });
    });
  </script></body>`);
  // A sheet: its grid is drawn from a model, and two thin scrollbars beside it hold the place; a wheel over the grid
  // moves the model, and a scrollbar's scroll sets the model then redraws both bars from it, as Sheets does (so two
  // bars set in the same task keep only one).
  else if (req.url === '/sheet') send(`<!doctype html><title>sheet</title><body style="margin:0;font:16px Arial"><div id="grid" style="position:fixed;left:0;top:0;width:640px;height:420px;background:#f4f4f4">cell 0,0</div><div class="native-scrollbar-x" style="position:fixed;left:0;top:420px;width:640px;height:14px;overflow-x:auto"><div style="width:3200px;height:1px"></div></div><div class="native-scrollbar-y" style="position:fixed;left:640px;top:0;width:14px;height:420px;overflow-y:auto"><div style="width:1px;height:3000px"></div></div><script>
    const sx = document.querySelector('.native-scrollbar-x'), sy = document.querySelector('.native-scrollbar-y'), grid = document.getElementById('grid'), model = { x: 0, y: 0 };
    const draw = () => { sx.scrollLeft = model.x; sy.scrollTop = model.y; grid.textContent = 'cell ' + model.x + ',' + model.y; };
    sx.addEventListener('scroll', () => { model.x = sx.scrollLeft; draw(); });
    sy.addEventListener('scroll', () => { model.y = sy.scrollTop; draw(); });
    grid.addEventListener('wheel', (e) => { e.preventDefault(); model.x = Math.max(0, Math.min(2560, model.x + e.deltaX)); model.y = Math.max(0, Math.min(2580, model.y + e.deltaY)); draw(); }, { passive: false });
  </script></body>`);
  else if (req.url === '/inner') send(`<!doctype html><title>inner</title><body style="margin:0;font:18px/1.5 Arial"><div id="box" style="position:fixed;inset:0;overflow:auto">${Array.from({ length: 600 }, (_, i) => `<p>${INNER_LINE(i)}</p>`).join('')}</div>${innerGrows ? '<script>addEventListener("load", () => setTimeout(() => { const b = document.getElementById("box"); for (let i = 0; i < 25; i++) b.insertAdjacentHTML("afterbegin", "<p>arrived later " + i + "</p>"); }, 600));</script>' : ''}</body>`);
  else if (req.url === '/long2') send(`<!doctype html><title>long two</title><body style="margin:0;font:18px/1.5 Arial">${Array.from({ length: 300 }, (_, i) => `<p>row ${i}</p>`).join('')}</body>`);
  else if (req.url === '/long') send(`<!doctype html><title>long</title><body style="margin:0;font:18px/1.5 Arial">${Array.from({ length: 300 }, (_, i) => `<p>line ${i}</p>`).join('')}</body>`);
  else if (req.url === '/moving' && movingAway) { res.writeHead(302, { location: '/moved' }); res.end(); }
  else if (req.url === '/moving' || req.url === '/moved') send(pageHTML(req.url.slice(1)));
  else if (req.url === '/about-para') send(`<!doctype html><title>about para</title><p>tiny</p><p>${ABOUT_PARA}</p>`);
  else if (req.url === '/late-font') send(`<!doctype html><title>late font</title><style>body{margin:0;font:18px/1.5 Late,Arial}</style><script>addEventListener('load', () => { const f = new FontFace('Late', 'url(/late.ttf)'); document.fonts.add(f); f.load(); });</script><body>${Array.from({ length: 200 }, (_, i) => `<p>para ${i}: ${LATE_TEXT}</p>`).join('')}</body>`);
  else if (req.url === '/late.ttf') setTimeout(() => { res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'no-store' }); res.end(fs.readFileSync(LATE_FONT)); }, 1500);
  else { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(FIX_PORT, '127.0.0.1', r));

/* ---------- CDP ---------- */
class CDP {
  static async connect(wsUrl) {
    const c = new CDP();
    c.ws = new WebSocket(wsUrl);
    c.id = 0;
    c.pending = new Map();
    c.listeners = [];
    await new Promise((res, rej) => {
      c.ws.onopen = res;
      c.ws.onerror = () => rej(new Error(`websocket error: ${wsUrl}`));
    });
    c.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && c.pending.has(d.id)) {
        const { res, rej, method } = c.pending.get(d.id);
        c.pending.delete(d.id);
        if (d.error) rej(new Error(`${method}: ${d.error.message}`));
        else res(d.result);
      } else if (d.method) c.listeners.forEach((f) => f(d));
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
  async eval(expression, extra = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error(`evaluate threw: ${ex ? ex.description : r.exceptionDetails.text}\n  in: ${expression.slice(0, 300)}`);
    }
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const json = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

/* ---------- the app ---------- */
let app = null;
async function start(label) {
  const log = fs.openSync(path.join(SHOTS, `restart-${label}.log`), 'w');
  app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', 'FLOW_ENTRY=test/page-harness.html', `FLOW_USER_DATA=${USER_DATA}`,
    'FLOW_TMUX_SOCKET=flow-dev-page', `FLOW_CDP_PORT=${PORT}`, './node_modules/.bin/electron', `--inspect=${MAIN_PORT}`, '.', '--no-sandbox', MARKER],
  { cwd: ROOT, stdio: ['ignore', log, log] });
  app.exited = new Promise((r) => app.once('exit', (code, signal) => r({ code, signal })));
  const t = await waitFor(async () => (await json(PORT).catch(() => [])).find((x) => x.type === 'page' && /page-harness\.html/.test(x.url)), 30000);
  if (!t) throw new Error(`${label}: no page-harness.html target on port ${PORT} (log: ${SHOTS}/restart-${label}.log)`);
  const host = await CDP.connect(t.webSocketDebuggerUrl);
  host.errors = [];
  host.listeners.push((d) => {
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') host.errors.push(d.params.args.map((a) => a.value || a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') host.errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
  });
  await host.send('Runtime.enable');
  if (!(await waitFor(() => host.eval('!!window.__ready'), 15000))) throw new Error(`${label}: the harness never got ready`);
  return host;
}
/* Main's inspector, only to load the harness with a hash (main blocks a Flow window's own navigations). A quit started
   from code evaluated there never finishes on this VM, while the menu's Quit does, so quit() presses the key. */
async function mainProcess() {
  const m = await waitFor(async () => (await json(MAIN_PORT).catch(() => []))[0], 10000);
  if (!m) throw new Error(`no main-process inspector on port ${MAIN_PORT}`);
  return CDP.connect(m.webSocketDebuggerUrl);
}
/* Presses ⌘Q (ctrl+Q off macOS): the menu's Quit runs before-quit and will-quit, where main writes the state. */
async function quit(host) {
  const mod = process.platform === 'darwin' ? 4 : 2;
  await host.eval('document.activeElement && document.activeElement.blur(), true');
  await host.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81, modifiers: mod });
  // The window may be gone before the key-up is answered.
  host.ws.send(JSON.stringify({ id: ++host.id, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81, modifiers: mod } }));
  const exit = await Promise.race([app.exited, sleep(20000).then(() => null)]);
  host.close();
  if (!exit) throw new Error('Flow did not quit within 20 s of ⌘Q');
  return exit;
}

const P = 'window.__pages.c';
let host = null;
async function shot(name) {
  const r = await host.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`     screenshot ${file}`);
}
const center = (sel) => host.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
async function click(x, y) {
  await host.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await host.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await host.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
const loaded = (title, ms = 30000) => waitFor(() => host.eval(`(() => { const t = ${P}.getTitle(); return !${P}.isLoading() && (${title instanceof RegExp ? `${title}.test(t)` : `t === ${JSON.stringify(title)}`}); })()`), ms);
const star = () => host.eval(`(() => { const s = document.querySelector('#win-c .pstar'); return { glyph: s.textContent, on: s.classList.contains('on'), title: s.title }; })()`);
const view = () => host.eval(`(() => {
  const w = document.querySelector('#win-c');
  return {
    strip: [...w.querySelectorAll('.ptabs .ptab')].map((e) => ({ name: e.querySelector('.pt-t').textContent, on: e.classList.contains('on') })),
    webviews: [...w.querySelectorAll('.pgv webview')].map((v) => ({ src: v.getAttribute('src'), hidden: v.classList.contains('off') })),
    address: w.querySelector('.ad').value,
  };
})()`);

try {
  /* ---------- first run: three tabs, two saved ---------- */
  host = await start('first');
  // Pages a, b and d stay empty, so only page c loads anything. Main blocks a Flow window's own navigations (a hash
  // change too), so main sets the hash and reloads. Each empty page then reports one empty tab, so the second run
  // restores them empty instead of falling back to the harness's default sites.
  await host.eval('window.__old = true');
  const main = await mainProcess();
  await main.eval(`(async () => {
    const wc = require('electron').webContents.getAllWebContents().find((w) => w.getType() === 'window' && /page-harness\\.html/.test(w.getURL()));
    await wc.loadURL(wc.getURL().split('#')[0] + '#' + ${JSON.stringify(`fresh&a=&b=&d=&c=${encodeURIComponent(REAL)}`)});
    wc.reload();
    return true;
  })()`, { includeCommandLineAPI: true });
  main.close();
  const reloaded = await waitFor(() => host.eval('!window.__old && !!window.__ready').catch((e) => {
    if (/context|Inspected target navigated/i.test(e.message)) return false;
    throw e;
  }), 15000);
  if (!reloaded) throw new Error('the harness did not come back after its reload');
  for (const id of ['a', 'b', 'd']) await host.eval(`window.__pages.${id}.newTab(''), window.__pages.${id}.closeTab(1)`);
  ok('first run: page c opens the real alphaxiv page', !!(await loaded(/Careful Judge/i, 60000)), await host.eval(`${P}.getTitle()`));
  await sleep(500);
  const s0 = await center('#win-c .pstar');
  await click(s0.x, s0.y);
  const realSaved = await waitFor(() => host.eval(`window.__saved.state.saved.find((s) => /Careful Judge/i.test(s.title)) || null`), 5000);
  ok('first run: the star saves the real page with what it says it is about', realSaved && /Careful Judge/i.test(realSaved.title) && realSaved.about.length > 40, JSON.stringify(realSaved));
  await host.eval(`${P}.newTab(${JSON.stringify(`${FIX}/about-para`)})`);
  await loaded('about para');
  await host.eval(`${P}.save()`);
  const paraSaved = await waitFor(() => host.eval(`window.__saved.state.saved.find((s) => s.url === ${JSON.stringify(`${FIX}/about-para`)}) || null`), 5000);
  ok('first run: save() (⌘D) saves the second tab with its first paragraph', paraSaved && paraSaved.about === ABOUT_PARA, JSON.stringify(paraSaved));
  await host.eval(`${P}.newTab(${JSON.stringify(`${FIX}/plain-target`)})`);
  await loaded('plain target');
  await host.eval(`${P}.moveTab(2, 0)`);
  // The first tab goes on to a long page and is scrolled down with the wheel: back/forward history and scroll.
  await host.eval(`${P}.selectTab(0)`);
  await host.eval(`${P}.navigate(${JSON.stringify(`${FIX}/long`)})`);
  await loaded('long');
  const lg = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/long`), 10000)).webSocketDebuggerUrl);
  const box = await host.eval(`(() => { const r = document.querySelector('#win-c .pgv').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 6; i++) {
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 300 });
    await sleep(120);
  }
  const scrolled = await waitFor(async () => { const a = await lg.eval('scrollY'); await sleep(400); const b = await lg.eval('scrollY'); return a === b && a > 600 && a; }, 8000);
  lg.close();
  await sleep(3500); // Chromium updates the page state about a second after a scroll; page.js reads it 2 s after the wheel
  const hist0 = (await host.eval(`${P}.tabs()`)).tabs[0].history;
  ok('first run: the tab keeps its back/forward history (main\'s page:history)', !!hist0 && hist0.index === 1 && hist0.entries.map((e) => e.url.split('/').pop()).join(',') === 'plain-target,long' && !!hist0.entries[1].pageState, JSON.stringify(hist0 ? { index: hist0.index, urls: hist0.entries.map((e) => e.url) } : { pageHistory: await host.eval('typeof window.flow.pageHistory') }));
  await host.eval(`${P}.selectTab(2)`);
  await loaded('about para');
  const zoomed = await host.eval(`${P}.zoom(1)`);
  ok('first run: ⌘+ zooms the shown tab to 110%', typeof zoomed === 'number' && Math.abs(1.2 ** zoomed - 1.1) < 0.001, String(zoomed));
  const before = await host.eval(`${P}.tabs()`);
  const brief = (t) => JSON.stringify({ tabs: t.tabs.map(({ id, url, title }) => ({ id, url, title })), tab: t.tab });
  ok('first run: three tabs, the first one went on to a long page and was scrolled, the third one shown', before.tabs.map((t) => (/Careful Judge/i.test(t.title) ? 'alphaxiv' : t.title)).join(',') === 'long,alphaxiv,about para' && before.tab === 2 && scrolled > 600, `${brief(before)} scrolled to ${scrolled}`);
  // Page b: a page that will redirect by the next start.
  await host.eval(`window.__pages.b.navigate(${JSON.stringify(`${FIX}/moving`)})`);
  await waitFor(() => host.eval(`window.__pages.b.getTitle() === 'moving' && !window.__pages.b.isLoading()`), 10000);
  // Page d: the page whose font arrives late, scrolled down with the wheel once the font is in.
  const D = 'window.__pages.d';
  await host.eval(`${D}.navigate(${JSON.stringify(`${FIX}/late-font`)})`);
  await waitFor(() => host.eval(`${D}.getTitle() === 'late font' && !${D}.isLoading()`), 15000);
  const lf = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/late-font`), 10000)).webSocketDebuggerUrl);
  await waitFor(() => lf.eval(lateLoaded), 8000);
  const dbox = await host.eval(`(() => { const r = document.querySelector('#win-d .pgv').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 6; i++) {
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: dbox.x, y: dbox.y, deltaX: 0, deltaY: 300 });
    await sleep(120);
  }
  const lateBefore = await waitFor(async () => { const a = await lf.eval(TOP_TEXT); await sleep(400); const b = await lf.eval(TOP_TEXT); return a.y === b.y && a.y > 600 && b; }, 8000);
  await sleep(2500);
  await lf.eval('window.__old = true');
  await host.eval(`${D}.reload()`);
  await waitFor(() => lf.eval(`!window.__old && ${lateLoaded}`).catch(() => false), 10000);
  await sleep(300);
  const lateReloaded = await lf.eval(TOP_TEXT);
  ok('first run: after a reload, the page whose font arrives late keeps the same paragraph at the top, at the same place', !!lateBefore && lateReloaded.top === lateBefore.top && lateReloaded.y === lateBefore.y && Math.abs(lateReloaded.at - lateBefore.at) <= 1, JSON.stringify({ before: lateBefore, reloaded: lateReloaded }));
  lf.close();
  await sleep(3500);
  // Page a: scrolled right before the quit, which reads where every tab is (p.flushHistory, as the app does at quit):
  // Chromium itself records a scroll in the page's history only about a second after it ends.
  const A = 'window.__pages.a';
  // Page a, a second tab: a page that scrolls inside a box of its own, scrolled with the wheel, then tab 1 shown again.
  // The line at the top edge of the box: the first one whose bottom is below that edge, and where it sits from it.
  const innerTop = `(() => { const b = document.getElementById('box'); if (!b) return null; const r = b.getBoundingClientRect(); const e = [...b.children].find((x) => x.getBoundingClientRect().bottom > r.top + 1); return { top: b.scrollTop, text: e ? e.textContent : '', off: e ? Math.round(e.getBoundingClientRect().top - r.top) : null, grew: !!b.firstElementChild && b.firstElementChild.textContent.startsWith('arrived later') }; })()`;
  await host.eval(`${A}.newTab(${JSON.stringify(`${FIX}/inner`)})`);
  await waitFor(() => host.eval(`${A}.getTitle() === 'inner' && !${A}.isLoading()`), 10000);
  await sleep(800);
  const ibox = await host.eval(`(() => { const r = document.querySelector('#win-a .pgv').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 10; i++) {
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ibox.x, y: ibox.y, deltaX: 0, deltaY: 300 });
    await sleep(80);
  }
  const ig = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/inner`), 10000)).webSocketDebuggerUrl);
  const innerBefore = await waitFor(async () => { const a = await ig.eval(innerTop); await sleep(300); const b = await ig.eval(innerTop); return a && b && a.top === b.top && a.top > 1000 && b; }, 8000);
  ig.close();
  ok('first run: a page that scrolls inside its own box is scrolled there with the wheel', !!innerBefore && /^inner line \d+/.test(innerBefore.text), JSON.stringify(innerBefore));
  // Page a, a third tab: a page box with a board inside that scrolls sideways; a fourth: a sheet. Both by the wheel.
  const wheelAt = async (x, y, dx, dy, n) => {
    for (let i = 0; i < n; i++) {
      await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
      await sleep(80);
    }
  };
  const guestAt = async (u) => CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === u), 10000)).webSocketDebuggerUrl);
  const toHost = (g, sel) => g.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const mapA = async (p) => host.eval(`(() => { const w = document.querySelector('#win-a webview:not(.off)'), r = w.getBoundingClientRect(), s = r.width / w.offsetWidth; return { x: r.left + ${p.x} * s, y: r.top + ${p.y} * s }; })()`);
  const nestedPlace = `(() => { const pg = document.getElementById('pg'), b = document.querySelector('.board'); return pg && b ? { page: pg.scrollTop, board: b.scrollLeft } : null; })()`;
  await host.eval(`${A}.newTab(${JSON.stringify(`${FIX}/nested`)})`);
  await waitFor(() => host.eval(`${A}.getTitle() === 'nested' && !${A}.isLoading()`), 10000);
  await sleep(800);
  const ng = await guestAt(`${FIX}/nested`);
  const mid = await mapA(await toHost(ng, '#pg'));
  await wheelAt(mid.x, mid.y, 0, 300, 3);
  await sleep(600);
  const onBoard = await mapA(await toHost(ng, '.board'));
  await wheelAt(onBoard.x, onBoard.y, 300, 0, 4);
  const nestedBefore = await waitFor(async () => { const a = await ng.eval(nestedPlace); await sleep(300); const b = await ng.eval(nestedPlace); return a && b && a.page === b.page && a.board === b.board && a.page > 300 && a.board > 300 && b; }, 8000);
  ng.close();
  ok('first run: a page box and a board inside it that scrolls sideways are both scrolled with the wheel', !!nestedBefore, JSON.stringify(nestedBefore));
  const sheetPlace = `(() => { const x = document.querySelector('.native-scrollbar-x'), y = document.querySelector('.native-scrollbar-y'); return x && y ? { left: x.scrollLeft, top: y.scrollTop, cell: document.getElementById('grid').textContent } : null; })()`;
  await host.eval(`${A}.newTab(${JSON.stringify(`${FIX}/sheet`)})`);
  await waitFor(() => host.eval(`${A}.getTitle() === 'sheet' && !${A}.isLoading()`), 10000);
  await sleep(800);
  const sg = await guestAt(`${FIX}/sheet`);
  const onGrid = await mapA(await toHost(sg, '#grid'));
  await wheelAt(onGrid.x, onGrid.y, 200, 0, 4);
  await wheelAt(onGrid.x, onGrid.y, 0, 200, 3);
  const sheetBefore = await waitFor(async () => { const a = await sg.eval(sheetPlace); await sleep(300); const b = await sg.eval(sheetPlace); return a && b && a.left === b.left && a.top === b.top && a.left > 300 && a.top > 300 && b; }, 8000);
  sg.close();
  ok('first run: a sheet is scrolled sideways and down with the wheel over its grid', !!sheetBefore, JSON.stringify(sheetBefore));
  // A fifth: the page that sets its own place a second after it shows, scrolled after that.
  await host.eval(`${A}.newTab(${JSON.stringify(`${FIX}/selfplace`)})`);
  await waitFor(() => host.eval(`${A}.getTitle() === 'selfplace' && !${A}.isLoading()`), 10000);
  const fg = await guestAt(`${FIX}/selfplace`);
  await waitFor(async () => { const v = await fg.eval(nestedPlace); return v && v.page === 200; }, 5000);
  const fmid = await mapA(await toHost(fg, '#pg'));
  await wheelAt(fmid.x, fmid.y, 0, 300, 2);
  await sleep(600);
  const fboard = await mapA(await toHost(fg, '.board'));
  await wheelAt(fboard.x, fboard.y, 300, 0, 4);
  const selfBefore = await waitFor(async () => { const a = await fg.eval(nestedPlace); await sleep(300); const b = await fg.eval(nestedPlace); return a && b && a.page === b.page && a.board === b.board && a.page > 600 && a.board > 300 && b; }, 8000);
  fg.close();
  ok('first run: a page that sets its own place a second after it shows is scrolled after that, box and board', !!selfBefore, JSON.stringify(selfBefore));
  // A sixth: the page box and board again, for a find right after it comes back.
  await host.eval(`${A}.newTab(${JSON.stringify(`${FIX}/nestfind`)})`);
  await waitFor(() => host.eval(`${A}.getURL() === ${JSON.stringify(`${FIX}/nestfind`)} && !${A}.isLoading()`), 10000);
  await sleep(800);
  const qg = await guestAt(`${FIX}/nestfind`);
  const qmid = await mapA(await toHost(qg, '#pg'));
  await wheelAt(qmid.x, qmid.y, 0, 300, 3);
  const findBefore = await waitFor(async () => { const a = await qg.eval(nestedPlace); await sleep(300); const b = await qg.eval(nestedPlace); return a && b && a.page === b.page && a.page > 300 && b; }, 8000);
  qg.close();
  ok('first run: a sixth tab, the page box again, is scrolled with the wheel', !!findBefore, JSON.stringify(findBefore));
  await host.eval(`${A}.selectTab(0)`);
  await host.eval(`${A}.navigate(${JSON.stringify(`${FIX}/long2`)})`);
  await waitFor(() => host.eval(`${A}.getTitle() === 'long two' && !${A}.isLoading()`), 10000);
  await sleep(1500);
  const abox = await host.eval(`(() => { const r = document.querySelector('#win-a .pgv').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (let i = 0; i < 8; i++) await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: abox.x, y: abox.y, deltaX: 0, deltaY: 120, button: 'none', buttons: 0, pointerType: 'mouse' });
  const quickBefore = await waitFor(async () => {
    const g = await CDP.connect((await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/long2`).webSocketDebuggerUrl);
    const a = await g.eval('scrollY');
    await sleep(150);
    const b = await g.eval('scrollY');
    g.close();
    return a === b && a > 600 && a;
  }, 5000);
  const tFlush = Date.now();
  await host.eval(`${A}.flushHistory().then(() => true)`);
  const flushMs = Date.now() - tFlush;
  await shot('10-before-restart');
  await sleep(600); // the harness writes its state 50 ms after the last change, main 150 ms after that
  const exit1 = await quit(host);
  ok('first run: Flow quits cleanly', exit1.code === 0, JSON.stringify(exit1));
  ok('first run: no errors in the window', host.errors.length === 0, host.errors.join(' | '));
  const file = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8'));
  ok('the state file holds the tabs and the saved pages', file.tabs && file.tabs.c && file.tabs.c.tabs.length === 3 && file.saved.length === 2, JSON.stringify({ tabs: file.tabs && file.tabs.c, saved: (file.saved || []).map((s) => s.url) }));

  ok('first run: reading every tab at quit is quick (flushHistory)', flushMs < 200, `${flushMs} ms`);
  /* ---------- second run: the same tabs and saved pages ---------- */
  movingAway = true;
  innerGrows = true;
  host = await start('second');
  {
    const lf2 = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/late-font`), 15000)).webSocketDebuggerUrl);
    await waitFor(() => lf2.eval(lateLoaded), 10000);
    await sleep(300);
    const lateAfter = await lf2.eval(TOP_TEXT);
    ok('a page whose web font arrives after it has loaded comes back with the same paragraph at the top, at the same place', !!lateBefore && lateAfter.top === lateBefore.top && lateAfter.y === lateBefore.y && Math.abs(lateAfter.at - lateBefore.at) <= 1, JSON.stringify({ before: lateBefore, after: lateAfter }));
    const box2 = await host.eval(`(() => { const r = document.querySelector('#win-d .pgv').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const anchoring = await lf2.eval('getComputedStyle(document.documentElement).overflowAnchor');
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box2.x, y: box2.y, deltaX: 0, deltaY: 100 });
    await sleep(300);
    const anchoringAfter = await lf2.eval('getComputedStyle(document.documentElement).overflowAnchor');
    ok('while it comes back the page keeps the offset (no scroll anchoring), and the first wheel gives it back', anchoring === 'none' && anchoringAfter === 'auto', `${anchoring} -> ${anchoringAfter}`);
    lf2.close();
  }
  await loaded('about para');
  {
    await waitFor(() => host.eval(`window.__pages.a.getURL() === ${JSON.stringify(`${FIX}/long2`)} && !window.__pages.a.isLoading()`), 15000);
    await sleep(1000);
    const g = await CDP.connect((await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/long2`).webSocketDebuggerUrl);
    const quickAfter = await g.eval('scrollY');
    g.close();
    ok('a scroll made right before the quit comes back exactly (read at quit, put back after load)', !!quickBefore && quickAfter === quickBefore, `${quickBefore} -> ${quickAfter}`);
  }
  {
    // Page a's second tab, shown now: back at the same line at the top of its box, although lines arrived above it
    // after the page loaded (the text at the box's top edge finds it again where the offset alone would not).
    await host.eval(`window.__pages.a.selectTab(1)`);
    await waitFor(() => host.eval(`window.__pages.a.getTitle() === 'inner' && !window.__pages.a.isLoading()`), 15000);
    const ig2 = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/inner`), 10000)).webSocketDebuggerUrl);
    await waitFor(async () => { const v = await ig2.eval(innerTop); return v && v.grew; }, 8000);
    await sleep(1500);
    const innerAfter = await ig2.eval(innerTop);
    ig2.close();
    ok('a page that scrolls inside its own box comes back with the same line at the top of the box, though lines arrived above it', !!innerBefore && !!innerAfter && innerAfter.grew && innerAfter.text === innerBefore.text && Math.abs(innerAfter.off - innerBefore.off) <= 2 && innerAfter.top > innerBefore.top, JSON.stringify({ innerBefore, innerAfter }));
    for (const [tab, title, place, before, name] of [[2, 'nested', `(() => { const pg = document.getElementById('pg'), b = document.querySelector('.board'); return pg && b ? { page: pg.scrollTop, board: b.scrollLeft } : null; })()`, nestedBefore, 'a page box and the board inside it that scrolls sideways both come back where they were'],
      [3, 'sheet', `(() => { const x = document.querySelector('.native-scrollbar-x'), y = document.querySelector('.native-scrollbar-y'); return x && y ? { left: x.scrollLeft, top: y.scrollTop, cell: document.getElementById('grid').textContent } : null; })()`, sheetBefore, 'a sheet comes back at the same cell, both of its scrollbars set (one at a time)'],
      [4, 'selfplace', `(() => { const pg = document.getElementById('pg'), b = document.querySelector('.board'); return pg && b ? { page: pg.scrollTop, board: b.scrollLeft } : null; })()`, selfBefore, 'a page that sets its own place a second after it shows (as Notion does once its data is in) still comes back where it was, box and board']]) {
      await host.eval(`window.__pages.a.selectTab(${tab})`);
      await waitFor(() => host.eval(`window.__pages.a.getTitle() === ${JSON.stringify(title)} && !window.__pages.a.isLoading()`), 15000);
      const g = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/${title}`), 10000)).webSocketDebuggerUrl);
      await waitFor(() => g.eval(place), 5000);
      await sleep(2000);
      const after = await g.eval(place);
      g.close();
      ok(name, !!before && JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
    }
    // A find right after a page box comes back takes the owner to what they searched for: the place being put back
    // stops, where it would otherwise hold the box where it was for a few seconds.
    await host.eval('window.__pages.a.selectTab(5)');
    const qg2 = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/nestfind`), 15000, 50)).webSocketDebuggerUrl);
    // Back at its place: page.js has the page (it asks for the place once its guest is bound), and the place is held.
    const back = await waitFor(async () => { const v = await qg2.eval(nestedPlace); return v && findBefore && v.page === findBefore.page && v; }, 10000, 50);
    await host.eval('window.__pages.a.find(), true');
    await host.send('Input.insertText', { text: 'below the board 59' });
    await sleep(2000);
    const found = await qg2.eval(`(() => { const p = [...document.querySelectorAll('p')].find((x) => x.textContent === 'below the board 59'); const r = p.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), view: innerHeight, page: document.getElementById('pg').scrollTop }; })()`);
    qg2.close();
    ok('a find right after a page box comes back takes the owner to the match, and the box stays there', !!back && found.top >= 0 && found.bottom <= found.view, JSON.stringify({ back, found }));
    await host.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await host.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  {
    const r = await waitFor(() => host.eval(`window.__log.filter((e) => e.page === 'b' && e.ev === 'redirect').map(({ from, to, how }) => ({ from, to, how }))[0] || null`), 10000);
    ok('a tab that comes back to an address that now redirects reports where it went (EF Start\'s /work to /)', !!r && r.from === `${FIX}/moving` && r.to === `${FIX}/moved` && r.how === 'server', JSON.stringify({ r, b: await host.eval(`({ url: window.__pages.b.getURL(), title: window.__pages.b.getTitle(), log: window.__log.filter((e) => e.page === 'b').map((e) => e.ev + ' ' + (e.url || e.from || '') + ' ' + (e.to || '')) })`) }));
  }
  const after = await host.eval(`${P}.tabs()`);
  ok('after the restart the three tabs are back in the same order with their ids and titles, the same one shown', brief(after) === brief(before), brief(after));
  const v1 = await view();
  ok('the strip shows all three titles and marks the shown tab', v1.strip.map((s) => s.name).join('|') === before.tabs.map((t) => t.title).join('|') && v1.strip.map((s) => s.on).join() === 'false,false,true', JSON.stringify(v1.strip));
  ok('only the shown tab loads: one webview, the others wait until they are shown', v1.webviews.length === 1 && v1.webviews[0].src === `${FIX}/about-para`, JSON.stringify(v1.webviews));
  {
    const ap = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/about-para`), 10000)).webSocketDebuggerUrl);
    const dpr = await waitFor(async () => { const v = await ap.eval('devicePixelRatio'); return Math.abs(v - 1.1) < 0.02 && v; }, 5000);
    ok('the shown tab comes back at its zoom, 110%', !!dpr, String(await ap.eval('devicePixelRatio')));
    ap.close();
  }
  const st1 = await waitFor(async () => { const s = await star(); return s.on && s; }, 3000);
  ok('the shown saved page is still starred', st1 && st1.glyph === '★' && st1.title === 'saved in saved, click to remove it', JSON.stringify(st1 || (await star())));
  const t1 = await center('#win-c .ptabs .ptab:nth-child(2)');
  await click(t1.x, t1.y);
  ok('clicking the real page\'s tab loads it now', !!(await loaded(/Careful Judge/i, 60000)), await host.eval(`${P}.getTitle()`));
  const st2 = await waitFor(async () => { const s = await star(); return s.on && s; }, 3000);
  ok('the real page is still starred after the restart', st2 && st2.glyph === '★', JSON.stringify(st2 || (await star())));
  const v2 = await view();
  ok('the real page got its own webview, and the one it replaced is hidden, not removed', v2.webviews.length === 2 && v2.webviews.filter((w) => !w.hidden).length === 1 && v2.webviews.find((w) => !w.hidden).src === before.tabs[1].url, JSON.stringify(v2.webviews));
  await sleep(1500);
  await shot('11-after-restart-starred');
  await host.eval(`${P}.selectTab(0)`);
  await loaded('long');
  const lg2 = await CDP.connect((await waitFor(async () => (await json(PORT)).find((x) => x.type === 'webview' && x.url === `${FIX}/long`), 10000)).webSocketDebuggerUrl);
  const y2 = await waitFor(async () => { const y = await lg2.eval('scrollY'); return Math.abs(y - scrolled) <= 40 && y; }, 5000);
  const back2 = { scrollY: await lg2.eval('scrollY'), want: scrolled, historyLength: await lg2.eval('history.length'), backButton: await host.eval(`!document.querySelector('#win-c [data-nav=back]').classList.contains('off')`) };
  lg2.close();
  ok('the tab that went on to the long page comes back scrolled where it was, with Back to the page before', !!y2 && back2.historyLength === 2 && back2.backButton, JSON.stringify(back2));
  ok('the tab that was never saved shows an empty star', (await star()).glyph === '☆');
  await host.eval(`${P}.back()`);
  ok('Back goes to the page it came from', !!(await loaded('plain target', 10000)), await host.eval(`${P}.getURL()`));
  await host.eval(`${P}.newTab('')`);
  const list = await host.eval(`(() => { const n = document.querySelector('#win-c .pnew'); return { on: n.classList.contains('on'), secs: [...n.querySelectorAll('.pn-sec')].map((e) => e.textContent), rows: [...n.querySelectorAll('.pn-row .pn-t')].map((e) => e.textContent), hosts: [...n.querySelectorAll('.pn-row .pn-h')].map((e) => e.textContent) }; })()`);
  ok('a new tab lists both saved pages under "saved", newest first, with their sites', list.on && list.secs.join('|') === 'saved' && list.rows.length === 2 && list.rows[0] === 'about para' && /Careful Judge/i.test(list.rows[1]) && list.hosts.join(',') === `127.0.0.1:${FIX_PORT},alphaxiv.org`, JSON.stringify(list));
  const row = await host.eval(`(() => { const r = [...document.querySelectorAll('#win-c .pn-row')].find((e) => /Careful Judge/i.test(e.textContent)).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await host.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
  const hover = await waitFor(() => host.eval(`(() => { const c = document.querySelector('#win-c .pcard'); return c.classList.contains('on') && { title: c.querySelector('.pc-t').textContent, url: c.querySelector('.pc-u').textContent, about: (c.querySelector('.pc-a') || {}).textContent || '' }; })()`), 3000);
  ok('hovering the real page shows its title, address and what it is about', hover && /Careful Judge/i.test(hover.title) && hover.url === realSaved.url.replace(/^https:\/\/(?:www\.)?/, '') && hover.about === realSaved.about, JSON.stringify(hover));
  await shot('12-after-restart-new-tab-hover');
  ok('no page text says "bookmark"', !(await host.eval(`document.body.innerText.toLowerCase().includes('bookmark') || [...document.querySelectorAll('[title]')].some((e) => e.title.toLowerCase().includes('bookmark'))`)));
  ok('second run: no errors in the window', host.errors.length === 0, host.errors.join(' | '));
  const exit2 = await quit(host);
  ok('second run: Flow quits cleanly', exit2.code === 0, JSON.stringify(exit2));
  host = null;
} catch (e) {
  ok('the run finished', false, e.stack);
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    execFileSync('pkill', ['-f', `[e]lectron/dist/electron .*${MARKER}`]);
    if (!(await Promise.race([app.exited, sleep(10000).then(() => null)]))) {
      console.log('     Flow ignored SIGTERM for 10 s; sending SIGKILL');
      execFileSync('pkill', ['-KILL', '-f', `[e]lectron/dist/electron .*${MARKER}`]);
      await Promise.race([app.exited, sleep(5000)]);
    }
  }
  try {
    execFileSync('tmux', ['-L', 'flow-dev-page', 'kill-server'], { stdio: 'ignore' });
  } catch (e) {
    if (e.status !== 1) console.log(`     tmux -L flow-dev-page kill-server: ${e.message}`);
  }
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);




