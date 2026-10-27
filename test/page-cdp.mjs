/* Drives test/page-harness.html over CDP and checks FlowPage against real sites. Prints ok/FAIL per check and
   exits non-zero on any failure. Start the app with the real backend and main's inspector (the webview context menu
   is native, so the test clicks its items through main) and, on Linux, /tmp/flow-dev-page-bin first on PATH (the
   test puts a recording xdg-email there, which is what Electron runs to open mailto: links), for example:
   xvfb-run -a -s "-screen 0 1600x1000x24" env PATH=/tmp/flow-dev-page-bin:$PATH FLOW_ENTRY=test/page-harness.html FLOW_USER_DATA=/tmp/flow-dev-page FLOW_TMUX_SOCKET=flow-dev-page FLOW_CDP_PORT=9564 ./node_modules/.bin/electron --inspect=9594 . --no-sandbox --flow-dev=page
   then: node test/page-cdp.mjs */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.FLOW_CDP_PORT || 9564);
const MAIN_PORT = Number(process.env.FLOW_MAIN_INSPECT || 9594);
const FIX_PORT = Number(process.env.FIX_PORT || 19574);
const MAIL_BIN = '/tmp/flow-dev-page-bin';
const MAIL_LOG = path.join(MAIL_BIN, 'xdg-email.log');
const SHOTS = process.env.SHOTS || '/tmp/flow-page-shots';
const FIX = `http://127.0.0.1:${FIX_PORT}`;
const ALPHA = 'https://www.alphaxiv.org/abs/2610.38355';
const MCK = 'https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-judgment-bottleneck-balancing-ai-and-human-speeds-in-strategy';
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(MAIL_BIN, { recursive: true });
fs.writeFileSync(path.join(MAIL_BIN, 'xdg-email'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${MAIL_LOG}\n`, { mode: 0o755 });
fs.rmSync(MAIL_LOG, { force: true });

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
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

/* ---------- fixture site ---------- */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>flow fixture</title><style>
body{margin:0;font:20px/1.4 Helvetica,Arial,sans-serif;background:#fff;color:#111;min-height:1600px}
#decoy{position:absolute;left:280px;top:40px;width:360px;height:140px;background:#fde2e2}
#target{position:absolute;left:900px;top:200px;width:220px;height:40px;background:#2251ff;color:#fff;display:flex;align-items:center;justify-content:center;text-decoration:none}
#sel{position:absolute;left:100px;top:290px;margin:0;font:24px/1 Menlo,monospace;white-space:nowrap}
#blank{position:absolute;left:100px;top:340px}
#plain{position:absolute;left:520px;top:340px}
#open{position:absolute;left:760px;top:340px;font:inherit}
#open2{position:absolute;left:760px;top:250px;font:inherit}
#applink{position:absolute;left:520px;top:250px;font:inherit}
#mail{position:absolute;left:100px;top:220px}
#words{position:absolute;left:100px;top:900px;width:900px}
</style></head><body>
<div id="decoy">decoy (an unscaled click lands here)</div>
<a id="target" href="/clicked">target link</a>
<p id="sel">alpha bravo charlie delta echo foxtrot</p>
<a id="blank" href="/popup-target" target="_blank">open in a new page</a>
<a id="plain" href="/plain-target">plain link</a>
<button id="open" type="button">window.open</button>
<button id="open2" type="button">window.open plain</button>
<button id="applink" type="button">open in zoom</button>
<a id="mail" href="mailto:someone@example.com?subject=flow">write to someone</a>
<p id="words">needle one, needle two, needle three.</p>
<script src="/fixture.js"></script>
</body></html>`;
const FIXTURE_JS = `window.__clicks = [];
addEventListener('click', (e) => {
  window.__clicks.push({ id: e.target.id, x: e.clientX, y: e.clientY, meta: e.metaKey });
  if (e.target.id === 'target' || e.target.id === 'decoy') e.preventDefault();
}, true);
document.getElementById('open').addEventListener('click', () => { window.__popup = window.open('/popup-script', 'flowtest', 'width=500,height=600'); window.__opened = String(window.__popup); });
document.getElementById('open2').addEventListener('click', () => { window.__opened2 = String(window.open('/popup-plain')); });
document.getElementById('applink').addEventListener('click', () => { window.open('zoommtg://zoom.us/join?confno=123'); });`;
const pageHTML = (t) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body><h1>${t}</h1></body></html>`;
const PDF_TEXT = 'flow pdf fixture alpha bravo charlie';
const ABOUT_PARA = 'This page has no description, so the first real paragraph of its text says what it is about instead.';
// Busy for 3 s from the moment its load ends: a read of the page then runs past its 1.5 s.
const BUSY_AFTER_LOAD = '<script>addEventListener("load", () => { const c = new MessageChannel(); c.port1.onmessage = () => { const end = Date.now() + 3000; while (Date.now() < end) {} }; c.port2.postMessage(0); });</script>';
let aboutBusy = true;
/* A one-page PDF with one line of Helvetica text, with a correct xref table. */
function pdfFixture() {
  const stream = `BT /F1 28 Tf 72 640 Td (${PDF_TEXT}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const at = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, FIX);
  const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (u.pathname === '/fixture') send('text/html; charset=utf-8', FIXTURE);
  else if (u.pathname === '/fixture.js') send('text/javascript', FIXTURE_JS);
  else if (u.pathname === '/plain-target') send('text/html; charset=utf-8', pageHTML('plain target'));
  else if (u.pathname === '/icon.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  } else if (u.pathname === '/iconic-addr') send('text/html; charset=utf-8', '<!doctype html><title>iconic addr</title><link rel="icon" href="/icon.png"><p>an icon by address</p>');
  else if (u.pathname === '/iconic-gone') send('text/html; charset=utf-8', '<!doctype html><title>iconic gone</title><link rel="icon" href="http://127.0.0.1:9/favicon.ico"><p>an icon at an address that refuses</p>');
  else if (u.pathname === '/iconic') send('text/html; charset=utf-8', '<!doctype html><title>iconic</title><link rel="icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="><p>iconic</p>');
  else if (/^\/many\/\d+$/.test(u.pathname)) send('text/html; charset=utf-8', pageHTML(`many ${u.pathname.split('/').pop()}`));
  else if (u.pathname === '/popup-target') send('text/html; charset=utf-8', pageHTML('popup target'));
  else if (u.pathname === '/popup-script') send('text/html; charset=utf-8', pageHTML('script popup'));
  else if (u.pathname === '/popup-plain') send('text/html; charset=utf-8', pageHTML('plain popup'));
  else if (u.pathname === '/clicked') send('text/html; charset=utf-8', pageHTML('clicked'));
  else if (u.pathname === '/nocontent') { res.writeHead(204); res.end(); }
  else if (u.pathname === '/about-meta') send('text/html; charset=utf-8', '<!doctype html><head><title>about meta</title><meta name="description" content="A page that says what it is about in its description."></head><body><p>short</p></body>');
  else if (u.pathname === '/about-para') send('text/html; charset=utf-8', `<!doctype html><title>about para</title><p>tiny</p><p>${ABOUT_PARA}</p>`);
  else if (u.pathname === '/dropzone') send('text/html; charset=utf-8', '<!doctype html><title>dropzone</title><body style="margin:0;font:18px Arial"><p id="a" style="margin:0;height:120px">one</p><p id="b" style="margin:0;height:120px">two</p><p id="c" style="margin:0;height:120px">three</p><script>window.__drops = 0; document.addEventListener("dragover", (e) => e.preventDefault()); document.addEventListener("drop", (e) => { e.preventDefault(); window.__drops++; });</script></body>');
  else if (u.pathname === '/about-busy') send('text/html; charset=utf-8', `<!doctype html><head><title>about busy</title><meta name="description" content="A page that is busy as its first load ends."></head><p>busy</p>${aboutBusy ? BUSY_AFTER_LOAD : ''}`);
  else if (u.pathname === '/framed') send('text/html; charset=utf-8', '<!doctype html><title>framed</title><iframe id="f" src="/inner" style="width:600px;height:160px;border:0"></iframe>');
  else if (u.pathname === '/inner') send('text/html; charset=utf-8', '<!doctype html><title>inner</title><p id="p">kilo lima mike november</p>');
  else if (u.pathname === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' }); res.end(pdfFixture()); }
  else if (u.pathname === '/marks') send('text/html; charset=utf-8', `<!doctype html><html><head><meta charset="utf-8"><title>marks</title><meta name="description" content="A page with sentences to quote."></head><body style="margin:0;font:22px/1.6 Arial"><p id="one" style="background:rgb(20,40,90);color:#eee;padding:6px">alpha bravo charlie delta</p><p id="two">echo <b>foxtrot</b>
  golf hotel</p><div style="height:1600px"></div><script>window.addLate = () => { const p = document.createElement('p'); p.id = 'late'; p.textContent = 'a late arrival text here'; document.body.appendChild(p); return true; };</script></body></html>`);
  else if (u.pathname === '/slow') setTimeout(() => send('text/html; charset=utf-8', pageHTML('slow')), 600);
  else if (u.pathname === '/closer') send('text/html; charset=utf-8', pageHTML('closer'));
  else if (u.pathname === '/tone.wav') {
    const rate = 8000, n = rate, b = Buffer.alloc(44 + n);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    res.end(b);
  } else if (u.pathname === '/player') send('text/html; charset=utf-8', '<!doctype html><title>player</title><audio id="a" src="/tone.wav" loop></audio><button id="p" style="position:absolute;left:20px;top:20px;width:200px;height:60px" onclick="document.getElementById(\'a\').play()">play</button>');
  else if (u.pathname === '/guard') send('text/html; charset=utf-8', '<!doctype html><title>guard</title><textarea id="t" style="width:600px;height:120px"></textarea><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script>');
  else if (u.pathname === '/xframed') send('text/html; charset=utf-8', `<!doctype html><title>xframed</title><p id="outer" style="font:24px Arial;padding:20px 20px 10px">outer words to select here</p><iframe id="xf" src="${XFIX}/" style="width:640px;height:140px;border:0"></iframe>`);
  else if (u.pathname === '/ticking') send('text/html; charset=utf-8', '<!doctype html><title>tick 0</title><script>let n = 0; setInterval(() => { document.title = "tick " + (++n); }, 40);</script><p>ticking</p>');
  else if (u.pathname === '/dlpage') send('text/html; charset=utf-8', '<!doctype html><title>dl page</title><body style="margin:0;font:24px Arial"><a id="dl1" href="/download" style="position:absolute;left:40px;top:40px">get the file</a><a id="dl2" href="/download" target="_blank" style="position:absolute;left:40px;top:120px">get it in a new tab</a></body>');
  else if (u.pathname === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="flow-test.bin"' }); res.end('flow'); }
  else if (u.pathname === '/to-app') { res.writeHead(302, { location: 'flowtestapp://open' }); res.end(); }
  else if (u.pathname === '/r302') { res.writeHead(302, { location: '/plain-target?via=302' }); res.end(); }
  else if (u.pathname === '/self-replace') send('text/html; charset=utf-8', '<!doctype html><title>self replace</title><script>location.replace("/plain-target?via=replace")</script>');
  else if (u.pathname === '/self-meta') send('text/html; charset=utf-8', '<!doctype html><title>self meta</title><meta http-equiv="refresh" content="0;url=/plain-target?via=meta">');
  else if (u.pathname === '/spa-start' || u.pathname === '/spa-home') send('text/html; charset=utf-8', '<!doctype html><title>spa</title><p>a single-page app</p><script>if (location.pathname === "/spa-start") history.replaceState(null, "", "/spa-home")</script>');
  else if (u.pathname === '/self-late' || u.pathname === '/self-late-moved') send('text/html; charset=utf-8', '<!doctype html><title>self late</title><p id="p" style="font:24px Arial;padding:40px">a page that moves itself a moment after it loads</p><script>setTimeout(() => history.pushState(null, "", "/self-late-moved"), 6000)</script>');
  else if (u.pathname === '/link-page') send('text/html; charset=utf-8', '<!doctype html><title>link page</title><a id="go" href="/plain-target?via=click" style="display:inline-block;font:30px Arial;padding:40px">go</a>');
  else { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(FIX_PORT, '127.0.0.1', r));
// Another origin (another port), for a frame the page's own script cannot read.
const XFIX = `http://127.0.0.1:${FIX_PORT + 7}`;
const xserver = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end('<!doctype html><title>other origin</title><p id="p" style="font:22px Arial">words in a frame from another origin</p>'); });
await new Promise((r) => xserver.listen(FIX_PORT + 7, '127.0.0.1', r));
// A site behind its own sign-in (HTTP basic auth): /router in one realm, the rest in another, so the router's sign-in,
// which Chromium keeps, does not open them. Its own port, so no other check's pages share what Chromium keeps.
const AUTH = `http://127.0.0.1:${FIX_PORT + 8}`;
const authServer = http.createServer((req, res) => {
  if (req.url.startsWith('/open')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>open</title><p>no sign-in here</p>'); return; }
  const router = req.url.startsWith('/router');
  const want = `Basic ${Buffer.from(router ? 'owner:secret' : 'two:pass').toString('base64')}`;
  if (req.headers.authorization !== want) {
    res.writeHead(401, { 'www-authenticate': `Basic realm="${router ? 'the router' : 'elsewhere'}"`, 'content-type': 'text/html' });
    res.end('');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>inside</title><p>signed in</p>');
});
await new Promise((r) => authServer.listen(FIX_PORT + 8, '127.0.0.1', r));

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
const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
async function guest(match, ms = 20000) {
  const t = await waitFor(async () => (await list()).find((x) => x.type === 'webview' && match(x.url)), ms);
  if (!t) throw new Error('no webview target matched');
  return CDP.connect(t.webSocketDebuggerUrl);
}

const hostTarget = await waitFor(async () => (await list()).find((x) => x.type === 'page' && /page-harness\.html/.test(x.url)), 20000);
if (!hostTarget) throw new Error(`no page-harness.html target on port ${PORT}`);
const host = await CDP.connect(hostTarget.webSocketDebuggerUrl);
const consoleErrors = [];
host.listeners.push((d) => {
  if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) {
    consoleErrors.push(`${d.params.type}: ${d.params.args.map((a) => a.value || a.description).join(' ')}`);
  }
  if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(`exception: ${d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text}`);
});
await host.send('Runtime.enable');
await waitFor(() => host.eval('!!window.__ready'), 10000);

async function shot(name) {
  const r = await host.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`     screenshot ${file}`);
}
const P = (id) => `window.__pages[${JSON.stringify(id)}]`;
const logOf = (id, ev) => host.eval(`window.__log.filter((e) => e.page === ${JSON.stringify(id)} && e.ev === ${JSON.stringify(ev)})`);
const settle = (id, ms = 45000) => waitFor(() => host.eval(`!${P(id)}.isLoading() && ${P(id)}.getTitle() !== ''`), ms);
async function mouse(type, x, y, extra = {}) {
  const press = type === 'mousePressed', release = type === 'mouseReleased';
  await host.send('Input.dispatchMouseEvent', { type, x, y, button: press || release ? 'left' : 'none', buttons: press ? 1 : 0, clickCount: press || release ? 1 : 0, ...extra });
}
async function click(x, y, modifiers = 0, button = 'left') {
  const buttons = { left: 1, right: 2, middle: 4 }[button];
  await mouse('mouseMoved', x, y, { modifiers });
  await mouse('mousePressed', x, y, { modifiers, button, buttons });
  await mouse('mouseReleased', x, y, { modifiers, button, buttons: 0 });
}
/* Chromium's "open link in a new tab" click modifier: ⌘ on macOS, ctrl everywhere else. */
const NEW_TAB = process.platform === 'darwin' ? { mod: 4, name: '⌘' } : { mod: 2, name: 'ctrl' };
/* Main's inspector (electron --inspect=<MAIN_PORT>), for the native webview context menu. */
async function mainProcess() {
  const url = `http://127.0.0.1:${MAIN_PORT}/json/list`;
  const t = (await (await fetch(url).catch((e) => { throw new Error(`no main-process inspector at ${url} (start electron with --inspect=${MAIN_PORT}): ${e.cause ? e.cause.code : e.message}`); })).json())[0];
  return CDP.connect(t.webSocketDebuggerUrl);
}
async function key(k, code, vk, text, modifiers = 0) {
  await host.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text, unmodifiedText: text, modifiers });
  await host.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
const enter = (modifiers = 0) => key('Enter', 'Enter', 13, '\r', modifiers);
const center = (sel) => host.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
/* Where guest CSS pixels land in the host page: the webview's transformed box over its untransformed size. */
const geometry = (win) => host.eval(`(() => {
  const w = document.querySelector('#win-${win} webview'), pgv = w.parentElement, r = w.getBoundingClientRect();
  const v = pgv.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, layoutW: w.offsetWidth, layoutH: w.offsetHeight, pgvW: pgv.clientWidth, pgvH: pgv.clientHeight, transform: w.style.transform, view: { l: v.left, t: v.top, r: v.right, b: v.bottom } };
})()`);
/* Maps guest CSS pixels to host pixels and refuses points the page view does not show. */
function mapper(geo) {
  const s = geo.width / geo.layoutW;
  return (gx, gy) => {
    const p = { x: geo.left + gx * s, y: geo.top + gy * s };
    if (p.x < geo.view.l + 1 || p.x > geo.view.r - 1 || p.y < geo.view.t + 1 || p.y > geo.view.b - 1) throw new Error(`guest point ${gx},${gy} maps to ${p.x.toFixed(1)},${p.y.toFixed(1)}, outside the page view ${JSON.stringify(geo.view)}`);
    return p;
  };
}

let main = null;
try {
  main = await mainProcess();
} catch (e) {
  ok('main-process inspector is reachable (context menu and mail link checks)', false, e.message);
}
const inMain = (expr) => main.eval(expr, { includeCommandLineAPI: true });

try {
  /* ---------- blank state ---------- */
  const blank = await host.eval(`(() => { const g = document.querySelector('#win-d .pgv'); return { text: g.innerText.trim(), fresh: g.querySelector('.pnew').classList.contains('on'), webview: !!g.querySelector('webview'), back: document.querySelector('#win-d [data-nav=back]').classList.contains('off'), reload: document.querySelector('#win-d [data-nav=reload]').classList.contains('off'), ph: document.querySelector('#win-d .ad').placeholder }; })()`);
  ok('a blank page is just its address field: nothing written in the page, no webview', blank.fresh && blank.text === '' && !blank.webview, JSON.stringify(blank));
  ok('a blank page has back and reload off and an address line with no words in it', blank.back && blank.reload && blank.ph === '');
  for (const odd of ['file:///etc/hostname', 'data:text/html,<title>x</title>', 'chrome://gpu']) {
    await host.eval(`${P('d')}.navigate(${JSON.stringify(odd)})`);
    const r = await host.eval(`(() => { const w = document.querySelector('#win-d'); return { webview: !!w.querySelector('webview'), blank: w.querySelector('.pnew').classList.contains('on') && !w.querySelector('.pnew').innerText.trim(), hint: w.querySelector('.phint').classList.contains('on') && w.querySelector('.phint').textContent, url: ${P('d')}.getURL() }; })()`);
    ok(`a blank page refuses ${odd.split(':')[0]}: addresses with "flow cannot open this kind of address" and stays blank`, !r.webview && r.blank && r.hint === 'flow cannot open this kind of address' && r.url === '', JSON.stringify(r));
  }

  /* ---------- alphaxiv ---------- */
  await settle('a');
  const aTitle = await host.eval(`${P('a')}.getTitle()`);
  ok('alphaxiv loads with its real title', /FlatCake/i.test(aTitle), aTitle);
  ok('alphaxiv address shows the url without https://www.', (await host.eval(`document.querySelector('#win-a .ad').value`)) === 'alphaxiv.org/abs/2610.38355');

  /* ---------- McKinsey ---------- */
  await settle('b', 60000);
  const mTitle = await host.eval(`${P('b')}.getTitle()`);
  const mOk = ok('McKinsey article loads (title has "judgment")', /judgment/i.test(mTitle), mTitle);
  {
    const g = await guest((u) => u.includes('mckinsey.com'));
    const info = await g.eval(`({ title: document.title, ua: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand + ' ' + b.version).join(', ') : '', h1: (document.querySelector('h1') || {}).textContent || '', text: document.body ? document.body.innerText.slice(0, 300) : '' })`);
    ok('McKinsey is not "Access Denied"', !/access denied/i.test(info.title + info.text), `h1: ${info.h1.trim().slice(0, 120)}`);
    console.log(`     user agent in the webview: ${info.ua}`);
    console.log(`     client hint brands: ${info.brands}`);
    if (!mOk) console.log(`     McKinsey body: ${info.text.replace(/\s+/g, ' ')}`);
    g.close();
  }
  await shot('01-alphaxiv-mckinsey-blank');

  /* ---------- desktop width ---------- */
  for (const w of ['a', 'b']) {
    const geo = await geometry(w);
    const s = geo.pgvW / geo.layoutW;
    ok(`page ${w} lays the webview out at max(width, 1180) and scales it to fit`, geo.layoutW === Math.max(geo.pgvW, 1180) && Math.abs(geo.width - geo.pgvW) < 1 && Math.abs(geo.layoutH * s - geo.pgvH) < 1, JSON.stringify(geo));
  }
  {
    const g = await guest((u) => u.includes('alphaxiv.org/abs/2610.38355'));
    const inner = await g.eval('innerWidth');
    const geo = await geometry('a');
    ok('the site sees a desktop-width viewport', inner === geo.layoutW, `innerWidth ${inner}, webview ${geo.layoutW}px, pgv ${geo.pgvW}px`);
    g.close();
  }

  /* ---------- clicks, selection and clip under the transform ---------- */
  await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/fixture`)})`);
  await waitFor(() => host.eval(`${P('c')}.getTitle() === 'flow fixture' && !${P('c')}.isLoading()`), 20000);
  ok('fixture page loads in page c', (await host.eval(`${P('c')}.getTitle()`)) === 'flow fixture');
  const fx = await guest((u) => u.startsWith(`${FIX}/fixture`));
  async function clickTest(label) {
    const geo = await geometry('c');
    const s = geo.width / geo.layoutW;
    const at = mapper(geo);
    const t = await fx.eval(`(() => { scrollTo(0, 0); const r = document.getElementById('target').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await fx.eval('window.__clicks.length = 0');
    const p = at(t.x, t.y);
    await click(p.x, p.y);
    const got = await waitFor(() => fx.eval('window.__clicks[0] || null'), 3000);
    ok(`${label}: a click at the scaled spot lands on the link (scale ${s.toFixed(3)})`, got && got.id === 'target' && Math.abs(got.x - t.x) <= 2 && Math.abs(got.y - t.y) <= 2, JSON.stringify({ want: t, got, host: p }));
  }
  await clickTest('wide note');
  const focusLog = await logOf('c', 'focus');
  ok('clicking into the webview calls onFocus', focusLog.length > 0, `${focusLog.length} focus events`);

  /* drag-select "bravo charlie" with the mouse under the transform */
  const clipShown = (w) => host.eval(`(() => { const b = document.querySelector('#win-${w} .pclip'); return !b.classList.contains('nosel') && getComputedStyle(b).visibility === 'visible'; })()`);
  {
    const geo = await geometry('c');
    const s = geo.width / geo.layoutW;
    const at = mapper(geo);
    const w = await fx.eval(`(() => {
      const n = document.getElementById('sel').firstChild, r = document.createRange();
      r.setStart(n, 6); r.setEnd(n, 7); const a = r.getBoundingClientRect();
      r.setStart(n, 18); r.setEnd(n, 19); const b = r.getBoundingClientRect();
      return { x0: a.left + 2, x1: b.right - 2, y: a.top + a.height / 2 };
    })()`);
    await fx.eval('getSelection().removeAllRanges()');
    await sleep(300);
    ok('with nothing selected the page shows no ✂', !(await clipShown('c')));
    const p0 = at(w.x0, w.y), p1 = at(w.x1, w.y);
    await mouse('mouseMoved', p0.x, p0.y);
    await mouse('mousePressed', p0.x, p0.y);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p0.x + ((p1.x - p0.x) * i) / 8, p0.y, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', p1.x, p1.y);
    const sel = await fx.eval('String(getSelection())');
    ok('drag-selecting under the transform selects exactly "bravo charlie"', sel === 'bravo charlie', JSON.stringify(sel));
    ok('✂ shows once text is selected', !!(await waitFor(() => clipShown('c'), 2000)));
    const c = await center('#win-c .pclip');
    await click(c.x, c.y);
    const clipped = await waitFor(async () => (await logOf('c', 'clip'))[0], 3000);
    const clipQuiet = await host.eval(`({ button: document.querySelector('#win-c .pclip').textContent, hint: document.querySelector('#win-c .phint').classList.contains('on') })`);
    const shownId = await host.eval(`(() => { const t = ${P('c')}.tabs(); return t.tabs[t.tab].id; })()`);
    ok('the clip button sends the selection, the page it came from and its tab id to onClip, with no notice', clipped && clipped.text === 'bravo charlie' && clipped.url === `${FIX}/fixture` && /^t-[a-z0-9]+$/.test(shownId) && clipped.tab === shownId && clipQuiet.button === '✂' && !clipQuiet.hint, JSON.stringify({ clipped, shownId, clipQuiet }));
    ok('the clipped text is in the page note', (await host.eval(`document.querySelector('#win-c .pnote').textContent`)) === 'bravo charlie');
    await fx.eval('getSelection().removeAllRanges()');
    const clipsBefore = (await logOf('c', 'clip')).length;
    const hidden = await waitFor(async () => !(await clipShown('c')), 2000);
    const said = await host.eval(`${P('c')}.clip()`);
    await sleep(300);
    ok('when the selection is cleared ✂ goes away; p.clip() with nothing selected says "select text on the page first" and sends nothing', hidden && said === '' && (await host.eval(`document.querySelector('#win-c .phint').classList.contains('on') && document.querySelector('#win-c .phint').textContent`)) === 'select text on the page first' && (await logOf('c', 'clip')).length === clipsBefore);
    ok('p.clip() returns the selection', (await fx.eval(`(() => { const n = document.getElementById('sel').firstChild, r = document.createRange(); r.setStart(n, 26); r.setEnd(n, 30); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`)) && (await host.eval(`${P('c')}.clip()`)) === 'echo');
    // "ravo charl": a drag that starts and ends inside words
    await fx.eval(`(() => { const n = document.getElementById('sel').firstChild, r = document.createRange(); r.setStart(n, 7); r.setEnd(n, 17); getSelection().removeAllRanges(); getSelection().addRange(r); return String(getSelection()); })()`);
    const snapped = await host.eval(`${P('c')}.clip()`);
    const shownSel = await fx.eval('String(getSelection())');
    ok('a clip snaps a selection that starts and ends mid-word to whole words, and the page shows what was clipped', snapped === 'bravo charlie' && shownSel === 'bravo charlie' && (await logOf('c', 'clip')).pop().text === 'bravo charlie', JSON.stringify({ snapped, shownSel }));
    await fx.eval('getSelection().removeAllRanges()');
  }
  await shot('02-fixture-selected-and-clipped');

  /* Popups, new-tab clicks and the context menu's "open link in new page" go through main (setWindowOpenHandler or
     the menu), come back as page:new-window and open a tab in the same window, right after the page they came from:
     shown, or left behind for a background-tab click. */
  {
    const at = mapper(await geometry('c'));
    const pos = await fx.eval(`(() => { const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }; return { blank: c('blank'), plain: c('plain'), open: c('open'), open2: c('open2') }; })()`);
    const blankAt = at(pos.blank.x, pos.blank.y), openAt = at(pos.open.x, pos.open.y), open2At = at(pos.open2.x, pos.open2.y), p = at(pos.plain.x, pos.plain.y);
    const tabsOf = () => host.eval(`${P('c')}.tabs()`);
    async function opensTab(label, u, show, act) {
      const before = await tabsOf();
      await act();
      const after = await waitFor(async () => {
        const t = await tabsOf();
        return t.tabs.length > before.tabs.length && t;
      }, 4000);
      const at2 = after ? after.tabs.findIndex((x) => x.url === u) : -1;
      ok(label, after && at2 === before.tab + 1 && (show ? after.tab === at2 : after.tab === before.tab), JSON.stringify(after || (await tabsOf())));
      if (after) {
        await host.eval(`${P('c')}.closeTab(${at2})`);
        await waitFor(async () => (await tabsOf()).tabs.length === before.tabs.length, 4000);
        await host.eval(`${P('c')}.selectTab(0)`);
        await sleep(200);
      }
    }
    await opensTab('a target=_blank link opens a tab right after this one and shows it', `${FIX}/popup-target`, true, () => click(blankAt.x, blankAt.y));
    {
      const navs = await logOf('c', 'navigate');
      const last = navs[navs.length - 1];
      ok('closing the shown tab tells the app the address the window shows now (onNavigate)', !!last && last.url === `${FIX}/fixture`, JSON.stringify(last && { url: last.url }));
    }
    await opensTab('a plain window.open opens a tab and shows it', `${FIX}/popup-plain`, true, () => click(open2At.x, open2At.y));
    ok('a plain window.open gets null in the page (main turned it into the tab)', (await fx.eval('window.__opened2')) === 'null', await fx.eval('window.__opened2'));
    {
      // A sign-in popup (window.open with features) stays a real popup, because sign-in needs window.opener.
      const before = (await host.eval(`${P('c')}.tabs()`)).tabs.length;
      await click(openAt.x, openAt.y);
      await sleep(1200);
      const kept = await fx.eval('({ opened: window.__opened, live: !!window.__popup && !window.__popup.closed })');
      ok('window.open with popup features (a sign-in popup) stays a real popup with window.opener, not a tab', kept.opened !== 'null' && kept.live && (await host.eval(`${P('c')}.tabs()`)).tabs.length === before, JSON.stringify(kept));
      await fx.eval('window.__popup && window.__popup.close()');
    }
    await opensTab(`${NEW_TAB.name}-click on a link opens a tab behind this one`, `${FIX}/plain-target`, false, () => click(p.x, p.y, NEW_TAB.mod));
    await opensTab('middle-click on a link opens a tab behind this one', `${FIX}/plain-target`, false, () => click(p.x, p.y, 0, 'middle'));
    await opensTab('shift-click on a link opens a tab and shows it', `${FIX}/plain-target`, true, () => click(p.x, p.y, 8));
    if (main) {
      await inMain(`(() => {
        const { Menu } = require('electron');
        if (!Menu.prototype.__flowTestPopup) {
          const orig = Menu.prototype.popup;
          Menu.prototype.__flowTestPopup = orig;
          Menu.prototype.popup = function (o) { globalThis.__flowTestMenu = this; return orig.call(this, o); };
        }
        globalThis.__flowTestMenu = null;
      })()`);
      await click(p.x, p.y, 0, 'right');
      const items = await waitFor(() => inMain('globalThis.__flowTestMenu && globalThis.__flowTestMenu.items.map((i) => i.label || i.type)'), 4000);
      ok('right-clicking a link shows main\'s menu with "Open Link in New Page"', Array.isArray(items) && items.includes('Open Link in New Page'), JSON.stringify(items));
      if (Array.isArray(items) && items.includes('Open Link in New Page')) {
        await opensTab('"Open Link in New Page" opens the link in a tab and shows it', `${FIX}/plain-target`, true, () => inMain(`(() => {
          const m = globalThis.__flowTestMenu;
          m.closePopup();
          m.items.find((i) => i.label === 'Open Link in New Page').click();
        })()`));
      }
      // "Clip to Note": main reads the selection from the menu's own params, so it also works where the page cannot
      // read its selection (PDFs, other sites' frames).
      const selAt = await fx.eval(`(() => { const n = document.getElementById('sel').firstChild, r = document.createRange(); r.setStart(n, 21); r.setEnd(n, 28); getSelection().removeAllRanges(); getSelection().addRange(r); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      const sp = at(selAt.x, selAt.y);
      await inMain('globalThis.__flowTestMenu = null');
      await click(sp.x, sp.y, 0, 'right');
      const clipItems = await waitFor(() => inMain('globalThis.__flowTestMenu && globalThis.__flowTestMenu.items.map((i) => i.label || i.type)'), 4000);
      const clipsBefore = (await logOf('c', 'clip')).length;
      if (Array.isArray(clipItems) && clipItems.includes('Clip to Note')) {
        await inMain(`(() => { const m = globalThis.__flowTestMenu; m.closePopup(); m.items.find((i) => i.label === 'Clip to Note').click(); })()`);
      }
      const viaMenu = await waitFor(async () => (await logOf('c', 'clip')).slice(clipsBefore)[0], 3000);
      ok('"Clip to Note" in the page menu sends the selection, snapped to whole words ("elta ec" is "delta echo"), and the page to onClip', Array.isArray(clipItems) && clipItems.includes('Clip to Note') && viaMenu && viaMenu.text === 'delta echo' && viaMenu.url === `${FIX}/fixture`, JSON.stringify({ clipItems, viaMenu }));
      await fx.eval('getSelection().removeAllRanges()');
      await inMain(`(() => {
        const { Menu } = require('electron');
        if (globalThis.__flowTestMenu) globalThis.__flowTestMenu.closePopup();
        if (Menu.prototype.__flowTestPopup) Menu.prototype.popup = Menu.prototype.__flowTestPopup;
        delete Menu.prototype.__flowTestPopup;
        delete globalThis.__flowTestMenu;
      })()`);
    }
    if (process.platform === 'darwin') console.log('     not run on macOS: a mailto link opens Mail through NSWorkspace, which this test cannot observe');
    else if (main) {
      const onPath = (await inMain('process.env.PATH')).split(':')[0] === MAIL_BIN;
      if (ok(`electron runs with ${MAIL_BIN} first on PATH (for the mailto link check)`, onPath)) {
        const m = await fx.eval(`(() => { const r = document.getElementById('mail').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        const mp = at(m.x, m.y);
        await click(mp.x, mp.y);
        const sent = await waitFor(() => fs.existsSync(MAIL_LOG) && fs.readFileSync(MAIL_LOG, 'utf8').trim(), 4000);
        ok('a mailto link in a page opens the mail app (xdg-email gets the address)', sent === 'mailto:someone@example.com?subject=flow', JSON.stringify(sent || 'nothing reached xdg-email'));
      }
    }
    ok('the page itself did not navigate on those clicks, and the tabs are back to one', (await host.eval(`${P('c')}.getURL()`)) === `${FIX}/fixture` && (await tabsOf()).tabs.length === 1, JSON.stringify(await tabsOf()));
    await click(p.x, p.y);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'plain target'`), 8000);
    const nav = await logOf('c', 'navigate');
    ok('a plain click navigates in place and calls onNavigate', nav.some((e) => e.url === `${FIX}/plain-target`), JSON.stringify(nav.map((e) => e.url)));
    ok('back is enabled after navigating, forward is not', await host.eval(`!document.querySelector('#win-c [data-nav=back]').classList.contains('off') && document.querySelector('#win-c [data-nav=fwd]').classList.contains('off')`));
    const bc = await center('#win-c [data-nav=back]');
    await click(bc.x, bc.y);
    await waitFor(() => host.eval(`${P('c')}.getURL() === ${JSON.stringify(`${FIX}/fixture`)} && !${P('c')}.isLoading()`), 8000);
    ok('the back button goes back', (await host.eval(`${P('c')}.getURL()`)) === `${FIX}/fixture`);
    ok('forward is enabled after going back', await host.eval(`!document.querySelector('#win-c [data-nav=fwd]').classList.contains('off')`));
  }
  fx.close();

  /* a narrow note: much smaller scale */
  await host.eval(`document.getElementById('win-c').style.cssText = 'width:440px;justify-self:start'`);
  await sleep(400);
  {
    const fx2 = await guest((u) => u.startsWith(`${FIX}/fixture`));
    const geo = await geometry('c');
    ok('a narrow note keeps the desktop layout width', geo.layoutW === 1180 && Math.abs(geo.width - geo.pgvW) < 1, JSON.stringify(geo));
    const geoS = geo.width / geo.layoutW;
    const t = await fx2.eval(`(() => { scrollTo(0, 0); const r = document.getElementById('target').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await fx2.eval('window.__clicks.length = 0');
    const pn = mapper(geo)(t.x, t.y);
    await click(pn.x, pn.y);
    const got = await waitFor(() => fx2.eval('window.__clicks[0] || null'), 3000);
    ok(`narrow note: a click at the scaled spot lands on the link (scale ${geoS.toFixed(3)})`, got && got.id === 'target' && Math.abs(got.x - t.x) <= 3 && Math.abs(got.y - t.y) <= 3, JSON.stringify({ want: t, got }));
    fx2.close();
  }
  await shot('03-narrow-note');
  await host.eval(`document.getElementById('win-c').style.cssText = ''`);

  /* ---------- back, forward, reload on a real site ---------- */
  await host.eval(`${P('a')}.navigate('https://www.alphaxiv.org/abs/2610.09043')`);
  await waitFor(() => host.eval(`${P('a')}.getURL().includes('2610.09043') && !${P('a')}.isLoading() && ${P('a')}.getTitle() !== ''`), 45000);
  const t2 = await host.eval(`${P('a')}.getTitle()`);
  ok('navigate() loads a second alphaxiv paper', /careful judge/i.test(t2), t2);
  await host.eval(`${P('a')}.back()`);
  await waitFor(() => host.eval(`${P('a')}.getURL().includes('2610.38355') && !${P('a')}.isLoading()`), 30000);
  ok('back() returns to the first paper', (await host.eval(`${P('a')}.getURL()`)).includes('2610.38355'), await host.eval(`${P('a')}.getTitle()`));
  await host.eval(`${P('a')}.forward()`);
  await waitFor(() => host.eval(`${P('a')}.getURL().includes('2610.09043') && !${P('a')}.isLoading()`), 30000);
  ok('forward() goes to the second paper again', (await host.eval(`${P('a')}.getURL()`)).includes('2610.09043'));
  {
    const before = (await logOf('a', 'navigate')).length;
    await host.eval(`${P('a')}.reload()`);
    const started = await waitFor(() => host.eval(`${P('a')}.isLoading()`), 3000, 20);
    await waitFor(() => host.eval(`!${P('a')}.isLoading()`), 30000);
    const after = (await logOf('a', 'navigate')).length;
    ok('reload() reloads the page (loading, then a fresh commit)', started && after > before, `navigate events ${before} -> ${after}`);
  }

  /* ---------- addresses a page cannot show ---------- */
  {
    const before = await host.eval(`${P('a')}.getURL()`);
    for (const odd of ['flowtestapp://open', 'chrome://gpu', 'file:///etc/hostname']) {
      await host.eval(`${P('a')}.navigate(${JSON.stringify(odd)})`);
      await sleep(300);
      const r = await host.eval(`({ url: ${P('a')}.getURL(), loading: ${P('a')}.isLoading(), ad: document.querySelector('#win-a .ad').value, hint: document.querySelector('#win-a .phint').classList.contains('on') && document.querySelector('#win-a .phint').textContent })`);
      ok(`a live page refuses ${odd.split(':')[0]}: with the hint and keeps its page and address`, r.url === before && !r.loading && r.ad === before.replace(/^https:\/\/(www\.)?/, '') && r.hint === 'flow cannot open this kind of address', JSON.stringify(r));
    }
    if (main) {
      await inMain(`(() => {
        const { shell } = require('electron');
        if (!shell.__flowTestOpen) { shell.__flowTestOpen = shell.openExternal; shell.openExternal = async (u) => { globalThis.__flowTestExternal.push(u); }; }
        globalThis.__flowTestExternal = [];
      })()`);
      const ad = await center('#win-a .ad');
      await click(ad.x, ad.y);
      await host.send('Input.insertText', { text: 'mailto:someone@example.com' });
      await enter();
      const sent = await waitFor(() => inMain('globalThis.__flowTestExternal.length && globalThis.__flowTestExternal'), 3000);
      const r = await host.eval(`({ url: ${P('a')}.getURL(), ad: document.querySelector('#win-a .ad').value, focused: document.activeElement === document.querySelector('#win-a .ad') })`);
      ok('a mailto: address goes to the mail app (flow.openExternal) and the page stays', JSON.stringify(sent) === JSON.stringify(['mailto:someone@example.com']) && r.url === before && r.ad === before, JSON.stringify({ sent, ...r }));
      await key('Escape', 'Escape', 27, '');
      await inMain(`(() => {
        const { shell } = require('electron');
        if (shell.__flowTestOpen) shell.openExternal = shell.__flowTestOpen;
        delete shell.__flowTestOpen;
        delete globalThis.__flowTestExternal;
      })()`);
    }
  }

  /* ---------- typing in the address field ---------- */
  {
    const ad = await center('#win-d .ad');
    await click(ad.x, ad.y);
    await host.send('Input.insertText', { text: 'alphaxiv.org/abs/2610.22948' });
    await enter();
    await waitFor(() => host.eval(`${P('d')}.getURL().includes('2610.22948') && !${P('d')}.isLoading() && ${P('d')}.getTitle() !== ''`), 45000);
    const t = await host.eval(`${P('d')}.getTitle()`);
    ok('typing a link without a scheme and pressing enter opens it', /9A Framework/i.test(t), `${await host.eval(`${P('d')}.getURL()`)} | ${t}`);
    await click(ad.x, ad.y);
    const v = await host.eval(`(() => { const i = document.querySelector('#win-d .ad'); return { v: i.value, all: i.selectionStart === 0 && i.selectionEnd === i.value.length }; })()`);
    ok('clicking the address field shows the full url, all selected', /^https:\/\/(www\.)?alphaxiv\.org\/abs\/2610\.22948/.test(v.v) && v.all, JSON.stringify(v));
    await host.send('Input.insertText', { text: 'flat kv cache storage' });
    await enter();
    await waitFor(() => host.eval(`${P('d')}.getURL().startsWith('https://www.google.com/search') && !${P('d')}.isLoading() && ${P('d')}.getTitle() !== ''`), 30000);
    const sURL = await host.eval(`${P('d')}.getURL()`);
    const sTitle = await host.eval(`${P('d')}.getTitle()`);
    ok('typing search words searches with Google', /[?&]q=flat(\+|%20)kv(\+|%20)cache(\+|%20)storage/.test(sURL) && /flat kv cache storage/i.test(sTitle), `${sURL} | ${sTitle}`);
    await shot('04-search');
  }
  {
    await host.eval(`${P('d')}.navigate('node.js')`);
    await waitFor(() => host.eval(`/[?&]q=node\\.js/.test(${P('d')}.getURL()) && !${P('d')}.isLoading()`), 30000);
    ok('a dotted word that is not a site ("node.js") falls back to a search', /[?&]q=node\.js/.test(await host.eval(`${P('d')}.getURL()`)), await host.eval(`${P('d')}.getURL()`));
  }

  /* ---------- error state ---------- */
  {
    await host.eval(`${P('d')}.navigate('https://flow-does-not-exist.invalid/')`);
    const e = await waitFor(() => host.eval(`(() => { const x = document.querySelector('#win-d .perr'); return x.classList.contains('on') && x.textContent; })()`), 20000);
    ok('a failed load shows the plain error state: what happened and the address, no error code', /could not be found/.test(e || '') && /flow-does-not-exist\.invalid/.test(e || '') && !/ERR_|error -?\d/.test(e || ''), e);
    ok('the address keeps the failed url', (await host.eval(`document.querySelector('#win-d .ad').value`)) === 'flow-does-not-exist.invalid');
    await shot('05-error');
    const fails = async () => (await logOf('d', 'navigate')).filter((x) => x.url === 'https://flow-does-not-exist.invalid/').length;
    const failsBefore = await fails();
    await host.eval(`(() => { const e = document.querySelector('#win-d .perr'); window.__errCleared = false; new MutationObserver(() => { if (!e.classList.contains('on')) window.__errCleared = true; }).observe(e, { attributes: true, attributeFilter: ['class'] }); })()`);
    const r = await center('#win-d .pe-r');
    await click(r.x, r.y);
    const again = await waitFor(async () => (await fails()) > failsBefore && host.eval(`document.querySelector('#win-d .perr').classList.contains('on')`), 15000);
    const cleared = await host.eval('window.__errCleared');
    ok('try again clears the error, loads again, and fails again for a missing site', cleared && again, JSON.stringify({ cleared, failures: `${failsBefore} -> ${await fails()}` }));
    await host.eval(`${P('d')}.navigate(${JSON.stringify(`${FIX}/nocontent`)})`);
    const kept = await waitFor(() => host.eval(`(() => { const p = ${P('d')}; return !p.isLoading() && p.getURL() === 'https://flow-does-not-exist.invalid/' && document.querySelector('#win-d .perr').classList.contains('on') && document.querySelector('#win-d .ad').value; })()`), 8000);
    ok('a navigation that never commits leaves the error state and its address', kept === 'flow-does-not-exist.invalid', JSON.stringify(kept || { url: await host.eval(`${P('d')}.getURL()`), err: await host.eval(`document.querySelector('#win-d .perr').classList.contains('on')`) }));
    await host.eval(`${P('d')}.navigate(${JSON.stringify(ALPHA)})`);
    await waitFor(() => host.eval(`${P('d')}.getURL().includes('2610.38355') && !${P('d')}.isLoading()`), 45000);
    ok('a good navigation clears the error state', await host.eval(`!document.querySelector('#win-d .perr').classList.contains('on')`));
  }

  /* ---------- the address line's buttons and the strip's + and x show only under the pointer ---------- */
  {
    const look = () => host.eval(`[...document.querySelectorAll('#win-c .addr .nv:not(.pclip)')].map((b) => ({ k: b.title, op: getComputedStyle(b).opacity, hidden: getComputedStyle(b).visibility === 'hidden', off: b.classList.contains('off') }))`);
    await mouse('mouseMoved', 1, 1);
    await sleep(400);
    const away = await look();
    const a = await center('#win-c .addr .ad');
    await mouse('mouseMoved', a.x, a.y);
    await sleep(400);
    const over = await look();
    await mouse('mouseMoved', 1, 1);
    ok('the address line\'s buttons show only while the pointer is over it, and one that cannot be used is not drawn', away.every((b) => b.op === '0') && over.every((b) => (b.off ? b.hidden : b.op === '1' && !b.hidden)) && over.some((b) => !b.off), JSON.stringify({ away, over }));
  }

  /* ---------- find in page ---------- */
  {
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/fixture`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'flow fixture' && !${P('c')}.isLoading()`), 15000);
    await host.eval(`${P('c')}.find()`);
    ok('find() opens the find bar with the cursor in it', await host.eval(`document.querySelector('#win-c .pfind').classList.contains('on') && document.activeElement === document.querySelector('#win-c .pf-q')`));
    const findAt = await host.eval(`(() => { const f = document.querySelector('#win-c .pfind').getBoundingClientRect(), a = document.querySelector('#win-c .addr').getBoundingClientRect(), v = document.querySelector('#win-c .pgv').getBoundingClientRect(); return { find: [f.top, f.bottom, f.left, f.right].map(Math.round), addr: [a.top, a.bottom, a.left, a.right].map(Math.round), page: Math.round(v.top) }; })()`);
    ok('the find bar takes the address line\'s place and covers none of the page', findAt.find[0] >= findAt.addr[0] && findAt.find[1] <= findAt.addr[1] && findAt.find[1] <= findAt.page, JSON.stringify(findAt));
    await host.send('Input.insertText', { text: 'needle' });
    const n1 = await waitFor(() => host.eval(`(() => { const t = document.querySelector('#win-c .pf-n').textContent; return /^1 of 3$/.test(t) && t; })()`), 5000);
    ok('find shows "1 of 3" for three matches', n1 === '1 of 3', n1);
    await enter();
    const n2 = await waitFor(() => host.eval(`(() => { const t = document.querySelector('#win-c .pf-n').textContent; return /^2 of 3$/.test(t) && t; })()`), 5000);
    ok('enter goes to the next match', n2 === '2 of 3', n2);
    await shot('06-find');
    await key('Escape', 'Escape', 27, '');
    await sleep(200);
    ok('esc closes the find bar', await host.eval(`!document.querySelector('#win-c .pfind').classList.contains('on')`));
    // As in Chrome: a reload keeps the bar with a fresh count, another page closes it.
    await host.eval(`${P('c')}.find()`);
    await waitFor(() => host.eval(`/ of 3$/.test(document.querySelector('#win-c .pf-n').textContent)`), 5000);
    await host.eval(`${P('c')}.reload()`);
    await waitFor(() => host.eval(`${P('c')}.isLoading()`), 3000, 20);
    await waitFor(() => host.eval(`!${P('c')}.isLoading()`), 10000);
    const reloaded = await host.eval(`({ on: document.querySelector('#win-c .pfind').classList.contains('on'), n: document.querySelector('#win-c .pf-n').textContent, q: document.querySelector('#win-c .pf-q').value })`);
    ok('a reload keeps the find bar and its words, without the old count', reloaded.on && reloaded.n === '' && reloaded.q === 'needle', JSON.stringify(reloaded));
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/plain-target`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'plain target' && !${P('c')}.isLoading()`), 10000);
    ok('going to another page closes the find bar', await host.eval(`!document.querySelector('#win-c .pfind').classList.contains('on')`));
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/fixture`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'flow fixture' && !${P('c')}.isLoading()`), 10000);
  }

  /* ---------- navigations that never commit leave the page and its address where they were ---------- */
  if (main) await inMain(`(() => { const { session } = require('electron'); globalThis.__flowTestDownloads = []; globalThis.__flowTestDl = (e, item) => { globalThis.__flowTestDownloads.push(item.getURL()); e.preventDefault(); }; session.fromPartition('persist:flow').on('will-download', globalThis.__flowTestDl); })()`);
  for (const [label, target] of [['a 204 No Content answer', `${FIX}/nocontent`], ['a redirect to another app', `${FIX}/to-app`], ...(main ? [['a download', `${FIX}/download`]] : [])]) {
    await host.eval(`${P('c')}.navigate(${JSON.stringify(target)})`);
    const r = await waitFor(() => host.eval(`(() => { const p = ${P('c')}; return !p.isLoading() && p.getURL() === ${JSON.stringify(`${FIX}/fixture`)} && { url: p.getURL(), ad: document.querySelector('#win-c .ad').value, err: document.querySelector('#win-c .perr').classList.contains('on') }; })()`), 8000);
    ok(`${label} leaves the page and its address where they were`, r && r.ad === `${FIX}/fixture` && !r.err, JSON.stringify(r || { url: await host.eval(`${P('c')}.getURL()`), ad: await host.eval(`document.querySelector('#win-c .ad').value`) }));
    if (main && target.endsWith('/to-app')) {
      // main asks the page's window before it hands a link to another app to the system (page:open-external)
      const q = await waitFor(() => host.eval(`(() => { const a = document.querySelector('#win-c .pask'); return a.classList.contains('on') && { t: a.querySelector('.pa-t').textContent, b: [...a.querySelectorAll('.pa-b')].map((x) => x.textContent) }; })()`), 5000);
      ok('a link to another app asks inline in its page first (open, cancel)', q && q.t === 'open in another app? flowtestapp://open' && q.b.join() === 'open,cancel', JSON.stringify(q));
      const askAt = await host.eval(`(() => { const q = document.querySelector('#win-c .pask').getBoundingClientRect(), a = document.querySelector('#win-c .addr').getBoundingClientRect(), v = document.querySelector('#win-c .pgv').getBoundingClientRect(); return { ask: [q.top, q.bottom].map(Math.round), addr: [a.top, a.bottom].map(Math.round), page: Math.round(v.top) }; })()`);
      ok('the question takes the address line\'s place and covers none of the page', askAt.ask[0] >= askAt.addr[0] && askAt.ask[1] <= askAt.addr[1] && askAt.ask[1] <= askAt.page, JSON.stringify(askAt));
      if (q) {
        const no = await host.eval(`(() => { const r = document.querySelectorAll('#win-c .pask .pa-b')[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await click(no.x, no.y);
        await sleep(200);
        ok('Cancel closes the question and the page stays', await host.eval(`!document.querySelector('#win-c .pask').classList.contains('on') && ${P('c')}.getURL() === ${JSON.stringify(`${FIX}/fixture`)}`));
      }
    }
  }
  if (main) {
    const dl = await inMain(`(() => { const { session } = require('electron'); session.fromPartition('persist:flow').removeListener('will-download', globalThis.__flowTestDl); const d = globalThis.__flowTestDownloads; delete globalThis.__flowTestDl; delete globalThis.__flowTestDownloads; return d; })()`);
    ok('the download really was a download (main saw will-download)', JSON.stringify(dl) === JSON.stringify([`${FIX}/download`]), JSON.stringify(dl));
    const why = await waitFor(() => host.eval(`document.querySelector('#win-c .phint').classList.contains('on') && document.querySelector('#win-c .phint').textContent`), 4000);
    const heard = ((await logOf('c', 'download')).pop() || {}).download;
    ok('a download that did not finish says why in the address line, and onDownload hears it with its page', why === 'could not download flow-test.bin' && heard && heard.state === 'cancelled' && heard.page === `${FIX}/fixture` && heard.url === `${FIX}/download`, JSON.stringify({ why, heard }));
  }

  /* ---------- tabs ---------- */
  {
    const tabsOf = () => host.eval(`${P('c')}.tabs()`);
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/fixture`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'flow fixture' && !${P('c')}.isLoading()`), 10000);
    const g0 = await guest((u) => u === `${FIX}/fixture`);
    await g0.eval('window.__keep = performance.timeOrigin');
    const origin = await g0.eval('performance.timeOrigin');
    ok('one tab shows no tab strip', await host.eval(`!document.querySelector('#win-c .ptabs').classList.contains('on')`));
    await host.eval(`${P('c')}.newTab(${JSON.stringify(`${FIX}/plain-target`)})`);
    await host.eval(`${P('c')}.newTab(${JSON.stringify(`${FIX}/popup-target`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'popup target' && !${P('c')}.isLoading()`), 10000);
    const three = await host.eval(`(() => { const w = document.querySelector('#win-c'); return { strip: w.querySelector('.ptabs').classList.contains('on'), tabs: [...w.querySelectorAll('.ptab')].map((t) => t.querySelector('.pt-t').textContent), shown: [...w.querySelectorAll('.ptab')].findIndex((t) => t.classList.contains('on')), hidden: [...w.querySelectorAll('webview')].map((v) => getComputedStyle(v).visibility) }; })()`);
    ok('three tabs: the strip shows them, the third is shown, the other two pages are hidden (visibility, not display)', three.strip && three.tabs.length === 3 && three.shown === 2 && three.hidden.filter((v) => v === 'hidden').length === 2, JSON.stringify(three));
    await shot('08-three-tabs');
    await host.eval(`window.__names = { ${JSON.stringify(`${FIX}/plain-target`)}: 'my reading' }; ${P('c')}.namesChanged()`);
    const ownName = await host.eval(`({ strip: [...document.querySelectorAll('#win-c .ptab .pt-t')].map((e) => e.textContent), titles: ${P('c')}.tabs().tabs.map((t) => t.title) })`);
    ok('a page the owner named shows that name on its tab, and its reported title stays the page\'s own', ownName.strip.includes('my reading') && !ownName.strip.includes('plain target') && ownName.titles.includes('plain target'), JSON.stringify(ownName));
    await host.eval(`window.__names = {}; ${P('c')}.namesChanged()`);
    const idsBy = async () => Object.fromEntries((await tabsOf()).tabs.map((t) => [t.url.split('/').pop(), t.id]));
    const ids0 = await idsBy();
    ok('every tab has its own id', Object.values(ids0).length === 3 && new Set(Object.values(ids0)).size === 3 && Object.values(ids0).every((x) => /^t-[a-z0-9]+$/.test(x)), JSON.stringify(ids0));
    const first = await center('#win-c .ptab');
    await click(first.x, first.y);
    await waitFor(async () => (await tabsOf()).tab === 0, 3000);
    const back0 = await g0.eval('({ keep: window.__keep, origin: performance.timeOrigin })');
    ok('clicking the first tab shows it again without reloading it', (await tabsOf()).tab === 0 && back0.keep === origin && back0.origin === origin && (await host.eval(`document.querySelector('#win-c .ad').value`)) === `${FIX}/fixture`, JSON.stringify({ back0, origin }));
    g0.close();
    // drag the third tab to the front
    const tabEls = await host.eval(`[...document.querySelectorAll('#win-c .ptab')].map((t) => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left }; })`);
    await mouse('mouseMoved', tabEls[2].x, tabEls[2].y);
    await mouse('mousePressed', tabEls[2].x, tabEls[2].y);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', tabEls[2].x + ((tabEls[0].l + 4 - tabEls[2].x) * i) / 8, tabEls[2].y, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', tabEls[0].l + 4, tabEls[2].y);
    await sleep(200);
    const moved = await tabsOf();
    const lastTabs = (await logOf('c', 'tabs')).pop();
    const ids1 = await idsBy();
    ok('a tab keeps its id when tabs are reordered', Object.keys(ids0).every((k) => ids1[k] === ids0[k]) && Object.keys(ids1).length === 3, JSON.stringify(ids1));
    ok('dragging a tab sideways moves it, and onTabs reports the new order', moved.tabs.map((t) => t.url.split('/').pop()).join(',') === 'popup-target,fixture,plain-target' && moved.tab === 0 && lastTabs.tabs.map((t) => t.url.split('/').pop()).join(',') === 'popup-target,fixture,plain-target', JSON.stringify({ moved, lastTabs }));
    {
      const strip = () => host.eval(`(() => { const s = document.querySelector('#win-c .ptabs'), p = document.querySelector('#win-c .addr .pt-new'); return { plus: p && getComputedStyle(p).visibility, x: getComputedStyle(s.querySelector('.ptab.on .pt-x')).visibility }; })()`);
      await mouse('mouseMoved', 1, 1);
      await sleep(200);
      const rest = await strip();
      const on = await center('#win-c .ptab.on');
      await mouse('mouseMoved', on.x, on.y);
      await sleep(200);
      const over = await strip();
      await mouse('mouseMoved', 1, 1);
      // the + is always there (owner, Nov 7 01/13); the × still only under the pointer
      ok('the new-tab + shows at rest and under the pointer; the shown tab\'s × only under the pointer', rest.plus === 'visible' && rest.x === 'hidden' && over.plus === 'visible' && over.x === 'visible', JSON.stringify({ rest, over }));
    }
    // × closes a tab, a middle click closes another
    const x2 = await host.eval(`(() => { const r = document.querySelectorAll('#win-c .ptab')[2].querySelector('.pt-x').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await click(x2.x, x2.y);
    await waitFor(async () => (await tabsOf()).tabs.length === 2, 4000);
    ok('× closes that tab, and the others keep their ids', (await tabsOf()).tabs.length === 2 && !(await tabsOf()).tabs.some((t) => t.url.endsWith('/plain-target')) && (await tabsOf()).tabs.every((t) => t.id === ids0[t.url.split('/').pop()]), JSON.stringify(await tabsOf()));
    const t0 = await center('#win-c .ptab');
    await click(t0.x, t0.y, 0, 'middle');
    // the tab goes at once; its page a moment later, once its place is read and its site said it guards nothing
    await waitFor(async () => (await tabsOf()).tabs.length === 1 && (await host.eval(`document.querySelectorAll('#win-c webview').length`)) === 1, 4000);
    const one = await tabsOf();
    ok('a middle click closes a tab; with one tab left the strip goes away', one.tabs.length === 1 && one.tabs[0].url === `${FIX}/fixture` && await host.eval(`!document.querySelector('#win-c .ptabs').classList.contains('on') && document.querySelectorAll('#win-c webview').length === 1`), JSON.stringify(one));
    // A press on a tab's × or a drag of a tab that spans another tab changing its title still lands: Chromium drops a
    // click whose pressed element left the page. Real input; the shown tab retitles itself every 40 ms.
    {
      await host.eval(`window.__add({ id: 'tk', url: ${JSON.stringify(`${FIX}/plain-target`)} })`);
      await host.eval(`document.getElementById('win-tk').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:7'`);
      await waitFor(() => host.eval(`${P('tk')}.getTitle() === 'plain target' && !${P('tk')}.isLoading()`), 10000);
      await host.eval(`${P('tk')}.newTab(${JSON.stringify(`${FIX}/popup-target`)}, { show: false })`);
      await host.eval(`${P('tk')}.newTab(${JSON.stringify(`${FIX}/ticking`)})`);
      await waitFor(() => host.eval(`/^tick \\d+$/.test(${P('tk')}.getTitle()) && ${P('tk')}.getTitle() !== 'tick 0'`), 10000);
      const tk = () => host.eval(`${P('tk')}.tabs()`);
      const xr = await host.eval(`(() => { const r = document.querySelectorAll('#win-tk .ptab')[1].querySelector('.pt-x').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const ticks0 = await host.eval(`${P('tk')}.getTitle()`);
      await mouse('mouseMoved', xr.x, xr.y);
      await mouse('mousePressed', xr.x, xr.y);
      await sleep(300);
      await mouse('mouseReleased', xr.x, xr.y);
      const closed = await waitFor(async () => { const t = await tk(); return t.tabs.length === 2 && t; }, 2000);
      const ticks1 = await host.eval(`${P('tk')}.getTitle()`);
      ok('× held while another tab changes its title still closes that tab', !!closed && !closed.tabs.some((t) => t.url.endsWith('/popup-target')) && ticks0 !== ticks1, JSON.stringify({ tabs: (await tk()).tabs.map((t) => t.url.split('/').pop()), ticks0, ticks1 }));
      const els = await host.eval(`[...document.querySelectorAll('#win-tk .ptab')].map((t) => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left }; })`);
      await mouse('mouseMoved', els[1].x, els[1].y);
      await mouse('mousePressed', els[1].x, els[1].y);
      for (let i = 1; i <= 8; i++) {
        await mouse('mouseMoved', els[1].x + ((els[0].l + 4 - els[1].x) * i) / 8, els[1].y, { button: 'left', buttons: 1 });
        await sleep(40);
      }
      await mouse('mouseReleased', els[0].l + 4, els[1].y);
      await sleep(300);
      const after = await tk();
      const strip = await host.eval(`[...document.querySelectorAll('#win-tk .ptab')].map((t) => t.classList.contains('on'))`);
      ok('a tab dragged while it changes its title moves where it was let go, and the strip shows each tab once', after.tabs.map((t) => t.url.split('/').pop()).join(',') === 'ticking,plain-target' && after.tab === 0 && strip.join() === 'true,false', JSON.stringify({ order: after.tabs.map((t) => t.url.split('/').pop()), tab: after.tab, strip }));
      await host.eval(`${P('tk')}.dispose(); document.getElementById('win-tk').remove()`);
    }
    const gids = await host.eval(`${P('c')}.guests()`);
    const live = await host.eval(`[...document.querySelectorAll('#win-c webview')].map((w) => w.getWebContentsId())`);
    ok('guests() lists the webContents ids of the live tabs (the quit guard finds a page window by them)', gids.length === live.length && gids.length > 0 && gids.every((g) => live.includes(g)), JSON.stringify({ gids, live }));
    // A tab closed while its page is being read (what it is about, its history) leaves no warning: nothing was lost.
    await host.eval(`${P('c')}.newTab(${JSON.stringify(`${FIX}/plain-target?busy`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'plain target' && !${P('c')}.isLoading()`), 10000);
    {
      const gbusy = await guest((u) => u === `${FIX}/plain-target?busy`);
      await gbusy.eval('setTimeout(() => { const end = Date.now() + 2500; while (Date.now() < end) {} }, 0), true');
      gbusy.close();
    }
    const warnsBefore = consoleErrors.length;
    await host.eval(`window.__aboutRead = ${P('c')}.about(1); true`);
    await host.eval(`${P('c')}.closeTab(1)`);
    await waitFor(async () => (await tabsOf()).tabs.length === 1, 6000);
    const aboutAnswer = await host.eval('window.__aboutRead');
    await sleep(1500);
    const lateWarns = consoleErrors.slice(warnsBefore);
    ok('a tab closed while its page is being read leaves no warning, and the read answers empty', aboutAnswer === '' && lateWarns.length === 0, JSON.stringify({ aboutAnswer, lateWarns }));
    ok('closing the last tab is left to the app (closeTab says false)', (await host.eval(`${P('c')}.closeTab()`)) === false && (await tabsOf()).tabs.length === 1);
    // A tab opened behind is named from its address until it loads
    await host.eval(`${P('c')}.newTab(${JSON.stringify(`${FIX}/wiki/Application_programming_interface`)}, { show: false })`);
    const named = await host.eval(`[...document.querySelectorAll('#win-c .ptab .pt-t')].map((e) => e.textContent)`);
    ok('a tab that has not loaded yet reads as words from its address, not a raw url', named[1] === 'Application programming interface', JSON.stringify(named));
    await host.eval(`${P('c')}.closeTab(1)`);
    await waitFor(async () => (await tabsOf()).tabs.length === 1, 4000);
    // After Enter in the address the page takes the keyboard once it is there, unless the owner went elsewhere first:
    // a late focus would bring this window back to the front (backlog's bug, a slow page and a press on another window).
    await host.eval(`${P('c')}.newTab('')`);
    await host.send('Input.insertText', { text: `${FIX}/slow` });
    await enter();
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'slow' && !${P('c')}.isLoading()`), 8000);
    await sleep(300);
    ok('after Enter in the address, the page takes the keyboard once it has loaded', await host.eval(`document.activeElement === document.querySelector('#win-c .pgv webview:not(.off)')`));
    await host.eval(`${P('c')}.newTab('')`);
    await host.send('Input.insertText', { text: `${FIX}/slow?again` });
    await enter();
    const tbA = await center('#win-a .tb');
    await click(tbA.x, tbA.y);
    const pressedAt = Date.now();
    await waitFor(() => host.eval(`${P('c')}.getURL().endsWith('/slow?again') && !${P('c')}.isLoading()`), 8000);
    await sleep(500);
    const lateFocus = (await logOf('c', 'focus')).filter((e) => e.t >= pressedAt);
    ok('a press on another window right after Enter keeps the keyboard there: the page neither takes it nor the front', lateFocus.length === 0 && (await host.eval(`!document.querySelector('#win-c').contains(document.activeElement)`)), JSON.stringify({ lateFocus: lateFocus.length }));
    while ((await tabsOf()).tabs.length > 1) {
      const n = (await tabsOf()).tabs.length;
      await host.eval(`${P('c')}.closeTab(${n - 1})`);
      await waitFor(async () => (await tabsOf()).tabs.length === n - 1, 4000);
    }
    await host.eval(`${P('c')}.selectTab(0)`);
    // tabs restored from saved state: only the shown one loads
    await host.eval(`window.__saved.state.tabs.h = { tabs: [{ url: ${JSON.stringify(`${FIX}/plain-target`)}, title: 'plain target' }, { url: ${JSON.stringify(`${FIX}/popup-target`)}, title: 'popup target' }, { url: ${JSON.stringify(`${FIX}/clicked`)}, title: 'clicked' }], tab: 1 }`);
    await host.eval(`window.__add({ id: 'h', url: '' })`);
    await host.eval(`document.getElementById('win-h').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:7'`);
    await waitFor(() => host.eval(`${P('h')}.getTitle() === 'popup target' && !${P('h')}.isLoading()`), 10000);
    const lazy = await host.eval(`({ webviews: document.querySelectorAll('#win-h webview').length, labels: [...document.querySelectorAll('#win-h .ptab .pt-t')].map((e) => e.textContent), tab: ${P('h')}.tabs().tab })`);
    ok('restored tabs keep their titles, and only the shown one loads a page', lazy.webviews === 1 && lazy.tab === 1 && lazy.labels.join('|') === 'plain target|popup target|clicked', JSON.stringify(lazy));
    await host.eval(`${P('h')}.selectTab(2)`);
    await waitFor(() => host.eval(`${P('h')}.getTitle() === 'clicked' && !${P('h')}.isLoading()`), 10000);
    ok('a restored tab loads when it is first shown', (await host.eval(`document.querySelectorAll('#win-h webview').length`)) === 2);
    await host.eval(`${P('h')}.dispose(); document.getElementById('win-h').remove()`);
  }

  /* ---------- a page that closes itself, unsaved changes, links to other apps, downloads, zoom ---------- */
  if (main) {
    const tabsOf = () => host.eval(`${P('c')}.tabs()`);
    const askOf = (w) => host.eval(`(() => { const a = document.querySelector('#win-${w} .pask'); return a.classList.contains('on') && { t: a.querySelector('.pa-t').textContent, b: [...a.querySelectorAll('.pa-b')].map((x) => x.textContent) }; })()`);
    const answer = async (w, i) => {
      const b = await host.eval(`(() => { const r = document.querySelectorAll('#win-${w} .pask .pa-b')[${i}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await click(b.x, b.y);
    };
    const closeFrom = async (u) => {
      const g = await guest((x) => x === u);
      await g.eval('setTimeout(() => window.close(), 50), true');
      g.close();
    };
    // window.close() takes only its own tab (OAuth and "you can close this tab" pages)
    await host.eval(`${P('c')}.newTab(${JSON.stringify(`${FIX}/closer`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'closer' && !${P('c')}.isLoading()`), 10000);
    await closeFrom(`${FIX}/closer`);
    const left = await waitFor(async () => { const t = await tabsOf(); return t.tabs.length === 1 && t; }, 5000);
    ok('a page that calls window.close() closes only its own tab', left && left.tabs[0].url === `${FIX}/fixture` && left.tab === 0 && (await host.eval(`document.querySelectorAll('#win-c webview').length`)) === 1 && (await logOf('c', 'close')).length === 0, JSON.stringify(left || (await tabsOf())));
    await host.eval(`window.__add({ id: 'k', url: ${JSON.stringify(`${FIX}/closer`)} })`);
    await host.eval(`document.getElementById('win-k').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:7'`);
    await waitFor(() => host.eval(`${P('k')}.getTitle() === 'closer' && !${P('k')}.isLoading()`), 10000);
    await closeFrom(`${FIX}/closer`);
    const asked = await waitFor(async () => (await logOf('k', 'close')).length > 0, 5000);
    const kState = await host.eval(`({ webviews: document.querySelectorAll('#win-k webview').length, fresh: document.querySelector('#win-k .pnew').classList.contains('on'), url: ${P('k')}.getURL() })`);
    ok('when the last tab closes itself, onClose asks the app to close the window and no dead page is left', !!asked && kState.webviews === 0 && kState.fresh && kState.url === '', JSON.stringify(kState));
    await host.eval(`${P('k')}.navigate(${JSON.stringify(`${FIX}/plain-target`)})`);
    ok('an address typed after that loads normally', !!(await waitFor(() => host.eval(`${P('k')}.getTitle() === 'plain target' && !${P('k')}.isLoading()`), 10000)));
    await host.eval(`${P('k')}.dispose(); document.getElementById('win-k').remove()`);

    // unsaved changes: a page whose site guards them (beforeunload, honored once the user has used the page) is never
    // asked about (owner, Nov 1 20:47): leaving goes on at once, a closed tab goes at once, and the page lives on out of
    // sight for 10 s so ⇧⌘T in that time brings back the same page with its typing.
    const typeIntoGuard = async () => {
      const g = await guest((u) => u === `${FIX}/guard`);
      const tpos = await g.eval(`(() => { const r = document.getElementById('t').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()`);
      g.close();
      const tp = mapper(await geometry('c'))(tpos.x, tpos.y);
      await click(tp.x, tp.y);
      await host.send('Input.insertText', { text: 'a draft' });
    };
    const guardText = async () => {
      const g = await guest((u) => u === `${FIX}/guard`);
      const v = await g.eval(`document.getElementById('t').value`);
      g.close();
      return v;
    };
    // whether a question showed at any moment while fn ran and for a while after
    const neverAsked = async (fn, ms = 1500) => {
      let seen = null;
      let on = true;
      const watch = (async () => { while (on) { seen = seen || (await askOf('c')); await sleep(40); } })();
      await fn();
      await sleep(ms);
      on = false;
      await watch;
      return seen;
    };
    const views = () => host.eval(`[...document.querySelectorAll('#win-c .pgv webview')].map((w) => ({ id: (() => { try { return w.getWebContentsId(); } catch { return null; } })(), off: w.classList.contains('off') }))`);
    await host.eval(`${P('c')}.newTab(${JSON.stringify(`${FIX}/guard`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'guard' && !${P('c')}.isLoading()`), 10000);
    await typeIntoGuard();
    ok('a page holding typing its site guards says so (guarded())', (await host.eval(`${P('c')}.guarded()`)) === true);
    {
      const g = await guest((u) => u === `${FIX}/guard`);
      await g.eval(`(() => { const t = document.getElementById('t'); t.focus(); t.setSelectionRange(0, 7); return true; })()`);
      const shownField = await waitFor(() => clipShown('c'), 2000);
      await g.eval(`(() => { const t = document.getElementById('t'); t.setSelectionRange(7, 7); return true; })()`);
      const goneField = await waitFor(async () => !(await clipShown('c')), 2000);
      g.close();
      ok('text selected in a text field shows ✂ too, and it goes when that selection does', !!shownField && !!goneField);
    }
    const askedLeaving = await neverAsked(async () => {
      await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/plain-target`)})`);
      await waitFor(() => host.eval(`${P('c')}.getTitle() === 'plain target' && !${P('c')}.isLoading()`), 8000);
    }, 600);
    ok('leaving a page with typing its site guards goes on to the address at once, and nothing is asked', !askedLeaving && (await host.eval(`${P('c')}.getTitle()`)) === 'plain target', JSON.stringify({ asked: askedLeaving, url: await host.eval(`${P('c')}.getURL()`) }));
    await shot('13-unsaved-changes');
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/guard`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'guard' && !${P('c')}.isLoading()`), 10000);
    await typeIntoGuard();
    const before = await views();
    const gid = await host.eval(`(() => { const w = document.querySelector('#win-c .pgv webview:not(.off)'); return w.getWebContentsId(); })()`);
    let closedAt = 0;
    let rightAfter = null;
    const askedClosing = await neverAsked(async () => {
      await host.eval(`${P('c')}.closeTab(1)`);
      closedAt = Date.now();
      rightAfter = (await tabsOf()).tabs.length;
    }, 800);
    const held = await views();
    ok('closing a tab whose page guards typing takes it off the strip at once, and nothing is asked', !askedClosing && rightAfter === 1 && (await tabsOf()).tabs.length === 1, JSON.stringify({ asked: askedClosing, rightAfter }));
    ok('its page lives on out of sight meanwhile (the same webview, hidden)', held.length === before.length && held.some((v) => v.id === gid && v.off), JSON.stringify({ before, held }));
    await host.eval(`${P('c')}.reopenTab()`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'guard'`), 4000);
    const back = await host.eval(`(() => { const w = document.querySelector('#win-c .pgv webview:not(.off)'); return w && w.getWebContentsId(); })()`);
    ok('⇧⌘T within 10 s brings back the same page with its typing', Date.now() - closedAt < 10000 && back === gid && (await guardText()) === 'a draft' && (await tabsOf()).tabs.length === 2, JSON.stringify({ after: Date.now() - closedAt, same: back === gid }));
    await host.eval(`${P('c')}.closeTab(1)`);
    await sleep(10600);
    const gone = await views();
    ok('after 10 s the closed page is gone', !gone.some((v) => v.id === gid), JSON.stringify(gone));
    await host.eval(`${P('c')}.reopenTab()`);
    // the tab shows its kept title at once; its page is up once the guard page itself answers
    await waitFor(async () => { try { const g = await guest((u) => u === `${FIX}/guard`); const up = await g.eval(`document.readyState === 'complete' && !!document.getElementById('t')`); g.close(); return up; } catch (e) { return false; } }, 10000);
    // a new page at the address the tab was on (its history was read at the close); Chromium puts the form's text back
    // from that history, as Chrome does for a reopened tab
    const again = await host.eval(`(() => { const w = document.querySelector('#win-c .pgv webview:not(.off)'); return w ? { id: w.getWebContentsId(), url: ${P('c')}.getURL() } : null; })()`);
    ok('⇧⌘T after that opens the page again in a new page, at the address it was on', !!again && again.id !== gid && again.url === `${FIX}/guard` && (await tabsOf()).tabs.length === 2, JSON.stringify({ again, text: await guardText() }));
    const plain = await views();
    await host.eval(`${P('c')}.closeTab(1)`);
    const dropped = await waitFor(async () => { const v = await views(); return v.length === plain.length - 1 && v; }, 3000);
    ok('a closed tab whose page guards nothing gives up its page at once', !!dropped, JSON.stringify({ plain, now: await views() }));
    ok('confirmClose() answers true at once, and guarded() false when no page guards typing', (await host.eval(`${P('c')}.confirmClose()`)) === true && (await host.eval(`${P('c')}.guarded()`)) === false);

    // a script opening another app asks too; Open hands the link to the system
    await inMain(`(() => {
      const { shell } = require('electron');
      if (!shell.__flowTestOpen) { shell.__flowTestOpen = shell.openExternal; shell.openExternal = async (u) => { globalThis.__flowTestExternal.push(u); }; }
      if (!shell.__flowTestShow) { shell.__flowTestShow = shell.showItemInFolder; shell.showItemInFolder = (f) => { globalThis.__flowTestShown.push(f); }; }
      globalThis.__flowTestExternal = [];
      globalThis.__flowTestShown = [];
    })()`);
    const fx3 = await guest((u) => u === `${FIX}/fixture`);
    await fx3.eval('scrollTo(0, 0)');
    const apos = await fx3.eval(`(() => { const r = document.getElementById('applink').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const ap = mapper(await geometry('c'))(apos.x, apos.y);
    await click(ap.x, ap.y);
    const q4 = await waitFor(() => askOf('c'), 5000);
    ok('a script opening another app asks inline too', q4 && q4.t === 'open in another app? zoommtg://zoom.us/join?confno=123' && q4.b.join() === 'open,cancel', JSON.stringify(q4));
    await answer('c', 0);
    const handed = await waitFor(() => inMain('globalThis.__flowTestExternal.length && globalThis.__flowTestExternal'), 3000);
    ok('Open hands the link to the system', JSON.stringify(handed) === JSON.stringify(['zoommtg://zoom.us/join?confno=123']), JSON.stringify(handed));

    // a finished download: main saves it into the downloads folder and the page says nothing
    const dlDir = path.join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-page', 'Downloads');
    const had = fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : [];
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/download`)})`);
    const got = await waitFor(() => (fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []).find((n) => !had.includes(n) && /^flow-test( \(\d+\))?\.bin$/.test(n)), 8000);
    await sleep(500);
    const after = await host.eval(`({ hint: document.querySelector('#win-c .phint').classList.contains('on') && document.querySelector('#win-c .phint').textContent, text: /downloaded/i.test(document.querySelector('#win-c').innerText), url: ${P('c')}.getURL() })`);
    const heardDone = ((await logOf('c', 'download')).pop() || {}).download;
    ok('a finished download is saved with no notice in the page, which stays where it was', !!got && fs.readFileSync(path.join(dlDir, got), 'utf8') === 'flow' && !after.hint && !after.text && after.url === `${FIX}/fixture`, JSON.stringify({ got, ...after }));
    ok('onDownload hears the finished download with its file and the page it came from (for the workspace\'s files)', heardDone && heardDone.state === 'completed' && heardDone.file === path.join(dlDir, got) && heardDone.page === `${FIX}/fixture` && heardDone.bytes === 4, JSON.stringify(heardDone));
    // A new page whose first address is a download: nothing to show. Once the download is heard (the file is then
    // with the workspace's downloads) its tab closes, and its window with it, since it was the only tab.
    {
      const before = fs.readdirSync(dlDir);
      await host.eval(`window.__add({ id: 'dl', url: ${JSON.stringify(`${FIX}/download`)} })`);
      const saved = await waitFor(() => fs.readdirSync(dlDir).find((n) => !before.includes(n) && /^flow-test( \(\d+\))?\.bin$/.test(n)), 8000);
      const heard = await waitFor(async () => ((await logOf('dl', 'download')).pop() || {}).download, 4000);
      await waitFor(async () => (await logOf('dl', 'close')).length, 4000);
      const order = await host.eval(`window.__log.filter((e) => e.page === 'dl' && (e.ev === 'download' || e.ev === 'close')).map((e) => e.ev).join()`);
      ok('a new page whose first address is a download closes once the download is heard, and asks for its window to close (its only tab)', !!saved && !!heard && heard.state === 'completed' && order === 'download,close', JSON.stringify({ saved, heard: heard && heard.state, order, tabs: await host.eval(`${P('dl')}.tabs().tabs.map((t) => t.url)`) }));
      await host.eval(`${P('dl')}.dispose(); document.getElementById('win-dl').remove()`);
    }
    // One whose download fails stays, as a new tab that says why (the owner's click did nothing).
    if (main) {
      await inMain(`(() => { const { session } = require('electron'); globalThis.__flowTestCancel = (e) => e.preventDefault(); session.fromPartition('persist:flow').on('will-download', globalThis.__flowTestCancel); })()`);
      await host.eval(`window.__add({ id: 'dlx', url: ${JSON.stringify(`${FIX}/download`)} })`);
      const heard = await waitFor(async () => ((await logOf('dlx', 'download')).pop() || {}).download, 6000);
      const why = await waitFor(() => host.eval(`document.querySelector('#win-dlx .phint').classList.contains('on') && document.querySelector('#win-dlx .phint').textContent`), 3000);
      await inMain(`(() => { const { session } = require('electron'); session.fromPartition('persist:flow').removeListener('will-download', globalThis.__flowTestCancel); delete globalThis.__flowTestCancel; })()`);
      const now = await host.eval(`({ url: ${P('dlx')}.getURL(), tabs: ${P('dlx')}.tabs().tabs.map((t) => t.url), fresh: document.querySelector('#win-dlx .pnew').classList.contains('on') })`);
      ok('a new page whose download fails stays, as a new tab that says why', !!heard && heard.state === 'cancelled' && /^could not download flow-test( \(\d+\))?\.bin$/.test(why || '') && now.url === '' && now.tabs.join() === '' && now.fresh && (await logOf('dlx', 'close')).length === 0, JSON.stringify({ heard: heard && heard.state, why, now }));
      await host.eval(`${P('dlx')}.dispose(); document.getElementById('win-dlx').remove()`);
    }
    // Real clicks: a link in a page that downloads leaves that tab on its page; a link that opens a new tab for a
    // download closes that tab once the download is heard, and the window keeps its page.
    {
      await host.eval(`window.__add({ id: 'q', url: ${JSON.stringify(`${FIX}/dlpage`)} })`);
      await host.eval(`document.getElementById('win-q').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:6'`);
      await waitFor(() => host.eval(`${P('q')}.getTitle() === 'dl page' && !${P('q')}.isLoading()`), 10000);
      await sleep(300);
      const gq = await guest((u) => u === `${FIX}/dlpage`);
      const pos = await gq.eval(`(() => { const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }; return { same: c('dl1'), fresh: c('dl2') }; })()`);
      gq.close();
      const at = mapper(await geometry('q'));
      const files = () => fs.readdirSync(dlDir).filter((n) => /^flow-test( \(\d+\))?\.bin$/.test(n));
      const heardN = async () => (await logOf('q', 'download')).length;
      let had = files();
      const p1 = at(pos.same.x, pos.same.y);
      await click(p1.x, p1.y);
      const got1 = await waitFor(() => files().find((n) => !had.includes(n)), 8000);
      await waitFor(async () => (await heardN()) === 1, 4000);
      await sleep(500);
      const stay = await host.eval(`({ url: ${P('q')}.getURL(), title: ${P('q')}.getTitle(), tabs: ${P('q')}.tabs().tabs.length })`);
      ok('a link in a page that downloads leaves that tab on its page', !!got1 && (await heardN()) === 1 && stay.url === `${FIX}/dlpage` && stay.title === 'dl page' && stay.tabs === 1 && (await logOf('q', 'close')).length === 0, JSON.stringify({ got1, stay }));
      had = files();
      // The tab can open and close between two polls (a 4-byte download): the strip's own changes are counted.
      await host.eval(`(() => { const s = document.querySelector('#win-q .ptabs'); window.__qTabs = 0; window.__qObs = new MutationObserver(() => { window.__qTabs = Math.max(window.__qTabs, s.querySelectorAll('.ptab').length); }); window.__qObs.observe(s, { childList: true }); return true; })()`);
      const p2 = at(pos.fresh.x, pos.fresh.y);
      await click(p2.x, p2.y);
      const opened = await waitFor(() => host.eval('window.__qTabs === 2'), 3000);
      const got2 = await waitFor(() => files().find((n) => !had.includes(n)), 8000);
      const back = await waitFor(async () => { const t = await host.eval(`${P('q')}.tabs()`); return (await heardN()) === 2 && t.tabs.length === 1 && t; }, 4000);
      await host.eval('window.__qObs.disconnect(); delete window.__qObs; delete window.__qTabs; true');
      ok('a link that opens a new tab for a download: that tab closes once the download is heard, and the window keeps its page', !!opened && !!got2 && !!back && back.tabs[0].url === `${FIX}/dlpage` && (await host.eval(`${P('q')}.getURL()`)) === `${FIX}/dlpage` && (await logOf('q', 'close')).length === 0, JSON.stringify({ opened: !!opened, got2, back, closes: (await logOf('q', 'close')).length }));
      await host.eval(`${P('q')}.dispose(); document.getElementById('win-q').remove()`);
    }
    await inMain(`(() => {
      const { shell } = require('electron');
      if (shell.__flowTestOpen) { shell.openExternal = shell.__flowTestOpen; delete shell.__flowTestOpen; }
      if (shell.__flowTestShow) { shell.showItemInFolder = shell.__flowTestShow; delete shell.__flowTestShow; }
      delete globalThis.__flowTestExternal;
      delete globalThis.__flowTestShown;
    })()`);

    // zoom (⌘+ ⌘- ⌘0 through the app's menu actions)
    const level = await host.eval(`${P('c')}.zoom(1)`);
    const dpr = await waitFor(async () => { const v = await fx3.eval('devicePixelRatio'); return Math.abs(v - 1.1) < 0.02 && v; }, 3000);
    const zHint = await host.eval(`document.querySelector('#win-c .phint').classList.contains('on') && document.querySelector('#win-c .phint').textContent`);
    ok('p.zoom(1) (⌘+) zooms the page one of Chrome\'s steps, to 110%, with no notice, and the tab keeps it', typeof level === 'number' && Math.abs(1.2 ** level - 1.1) < 0.001 && !!dpr && !zHint && (await tabsOf()).tabs[0].zoom === level, JSON.stringify({ level, dpr, zHint }));
    let top = level;
    for (let i = 0; i < 12; i++) top = await host.eval(`${P('c')}.zoom(1)`);
    const limit = await host.eval(`document.querySelector('#win-c .phint').classList.contains('on') && document.querySelector('#win-c .phint').textContent`);
    ok('at the largest zoom (500%), ⌘+ changes nothing and says why', Math.abs(1.2 ** top - 5) < 0.001 && limit === 'the page is as large as it gets', JSON.stringify({ factor: 1.2 ** top, limit }));
    await host.eval(`${P('c')}.zoom(0)`);
    ok('p.zoom(0) (⌘0) puts it back to 100%', !!(await waitFor(async () => Math.abs((await fx3.eval('devicePixelRatio')) - 1) < 0.02, 3000)) && (await tabsOf()).tabs[0].zoom === undefined);
    await waitFor(() => host.eval(`!document.querySelector('#win-c .phint').classList.contains('on')`), 4000);
    fx3.close();
  }

  /* ---------- saved pages ---------- */
  {
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/about-meta`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'about meta' && !${P('c')}.isLoading()`), 10000);
    ok('the star is empty on a page that is not saved', (await host.eval(`document.querySelector('#win-c .pstar').textContent`)) === '☆');
    const st0 = await center('#win-c .pstar');
    await click(st0.x, st0.y);
    const savedMeta = await waitFor(async () => (await logOf('here', 'saved')).find((e) => e.url === `${FIX}/about-meta`), 4000);
    const starState = await host.eval(`(() => { const s = document.querySelector('#win-c .pstar'), h = document.querySelector('#win-c .phint'); return { glyph: s.textContent, on: s.classList.contains('on'), title: s.title, hint: h.classList.contains('on') && h.textContent }; })()`);
    ok('the star saves the page into this workspace, with what the page says it is about, and only the star shows it', savedMeta && savedMeta.about === 'A page that says what it is about in its description.' && savedMeta.title === 'about meta' && starState.glyph === '★' && starState.on && !starState.hint, JSON.stringify({ savedMeta, starState }));
    ok('p.about() gives the same text for the sidebar', (await host.eval(`${P('c')}.about()`)) === 'A page that says what it is about in its description.');
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/about-para`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'about para' && !${P('c')}.isLoading()`), 10000);
    await host.eval(`${P('c')}.save()`);
    const savedPara = await waitFor(async () => (await logOf('here', 'saved')).find((e) => e.url === `${FIX}/about-para`), 4000);
    ok('save() (⌘D) on a page without a description keeps its first real paragraph', savedPara && savedPara.about === ABOUT_PARA, JSON.stringify(savedPara));
    await host.eval(`window.__saved.state.section.here = 'research'`);
    await host.eval(`window.__saved.add('here', ${JSON.stringify(`${FIX}/plain-target`)}, 'plain target', 'a plain page kept for research', 'research')`);
    await host.eval(`window.__saved.add('elsewhere', ${JSON.stringify(`${FIX}/clicked`)}, 'clicked', 'saved in another workspace', 'reading')`);
    const ad = (await host.eval(`${P('c')}.tabs()`)).tabs.length;
    await host.eval(`${P('c')}.newTab('')`);
    const list = await host.eval(`(() => { const n = document.querySelector('#win-c .pnew'); return { on: n.classList.contains('on'), secs: [...n.querySelectorAll('.pn-sec')].map((e) => e.textContent), rows: [...n.querySelectorAll('.pn-row .pn-t')].map((e) => e.textContent), hosts: [...n.querySelectorAll('.pn-row .pn-h')].map((e) => e.textContent), focused: document.activeElement === document.querySelector('#win-c .ad'), word: document.querySelector('#win-c').innerText.toLowerCase().includes('bookmark') }; })()`);
    ok('a new tab lists this workspace\'s saved pages by section (not another workspace\'s), with the address ready to type', list.on && list.secs.join('|') === 'research|saved' && list.rows.join('|') === 'plain target|about para|about meta' && list.hosts.length === 3 && list.hosts.every((h) => h === `127.0.0.1:${FIX_PORT}`) && list.focused && !list.word, JSON.stringify(list));
    const row = await center('#win-c .pn-row');
    await mouse('mouseMoved', row.x, row.y);
    const hover = await waitFor(() => host.eval(`(() => { const c = document.querySelector('#win-c .pcard'); return c.classList.contains('on') && c.innerText; })()`), 2000);
    ok('hovering a saved page shows what it is about, without opening it', /plain target/.test(hover || '') && /127\.0\.0\.1:19574\/plain-target/.test(hover || '') && /a plain page kept for research/.test(hover || ''), JSON.stringify(hover));
    await shot('09-new-tab-saved-pages');
    await click(row.x, row.y);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'plain target' && !${P('c')}.isLoading()`), 8000);
    const opened = await host.eval(`${P('c')}.tabs()`);
    ok('clicking a saved page opens it in that tab, and the star shows it saved', opened.tabs.length === ad + 1 && opened.tabs[opened.tab].url === `${FIX}/plain-target` && (await host.eval(`document.querySelector('#win-c .pstar').textContent`)) === '★', JSON.stringify(opened));
    const st1 = await center('#win-c .pstar');
    await click(st1.x, st1.y);
    await sleep(200);
    ok('the star on a saved page takes it out again', (await host.eval(`document.querySelector('#win-c .pstar').textContent`)) === '☆' && !(await host.eval(`window.__saved.state.saved.some((s) => s.url === ${JSON.stringify(`${FIX}/plain-target`)} && s.ws === 'here')`)));
    await host.eval(`${P('c')}.closeTab()`);
    {
      // A workspace with no saved pages of its own shows the prompt, even with another workspace's saved.
      const kept = await host.eval(`JSON.stringify(window.__saved.state.saved)`);
      await host.eval(`window.__saved.state.saved = window.__saved.state.saved.filter((s) => s.ws !== 'here'); true`);
      await host.eval(`${P('c')}.newTab('')`);
      const none = await host.eval(`(() => { const n = document.querySelector('#win-c .pnew'); return { on: n.classList.contains('on'), text: n.innerText.trim(), rows: n.querySelectorAll('.pn-row').length }; })()`);
      await host.eval(`${P('c')}.closeTab()`);
      await host.eval(`window.__saved.state.saved = JSON.parse(${JSON.stringify(kept)}); true`);
      ok('a new tab in a workspace with no saved pages of its own is just its address field, even when another workspace has some', none.on && none.rows === 0 && none.text === '', JSON.stringify(none));
    }
    await host.eval(`window.__saved.clear()`);
  }

  /* ---------- text fragments, pinch and wheel ---------- */
  {
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/fixture#:~:text=needle%20two`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'flow fixture' && !${P('c')}.isLoading()`), 8000);
    const nav = (await logOf('c', 'navigate')).pop();
    const shownAd = await host.eval(`document.querySelector('#win-c .ad').value`);
    ok('a :~:text= link scrolls the page, but the address and reported url drop the directive', !shownAd.includes(':~:') && (await host.eval(`${P('c')}.getURL()`)) === `${FIX}/fixture` && !nav.url.includes(':~:'), JSON.stringify({ shownAd, nav: nav.url }));
    const geo = await geometry('c');
    const mx = geo.left + geo.width * 0.6, my = geo.top + 60;
    const pinches = (await logOf('c', 'pinch')).length;
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mx, y: my, deltaX: 0, deltaY: -60, modifiers: 2 });
    const pinch = await waitFor(async () => (await logOf('c', 'pinch'))[pinches], 3000);
    ok('a pinch over the page reaches onPinch at the pointer, in Flow\'s pixels', pinch && Math.abs(pinch.x - mx) <= 2 && Math.abs(pinch.y - my) <= 2 && pinch.deltaY < 0 && pinch.used === false, JSON.stringify({ pinch, mx, my }));
    const wheels = (await logOf('c', 'wheel')).length;
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mx, y: my, deltaX: 0, deltaY: 120 });
    const wheel = await waitFor(async () => (await logOf('c', 'wheel'))[wheels], 3000);
    ok('a plain wheel reaches onWheel with the delta the window got (a swipe over a page counts like one over the desktop)', wheel && Math.abs(wheel.dy - 120) <= 1 && wheel.dx === 0, JSON.stringify(wheel));
    const sides = (await logOf('c', 'wheel')).length;
    await host.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mx, y: my, deltaX: 100, deltaY: 0 });
    const side = await waitFor(async () => (await logOf('c', 'wheel'))[sides], 3000);
    ok('a sideways wheel the page cannot scroll reaches onWheel unscaled, with used false (nav may swipe)', side && Math.abs(side.dx - 100) <= 1 && side.used === false, JSON.stringify(side));
  }

  /* ---------- marks: quoted sentences painted in the page (notes' page-as-primitive design) ---------- */
  {
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/marks`)})`);
    await host.eval(`${P('c')}.setMarks([{ text: 'alpha bravo', note: 'first note\\nsecond line' }, { text: 'foxtrot golf', note: '' }, { text: 'late arrival text', note: 'came late' }, { text: 'not on this page', note: 'x' }])`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'marks' && !${P('c')}.isLoading()`), 10000);
    const gm = await guest((u) => u === `${FIX}/marks`);
    const painted = () => gm.eval(`(() => { const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0; })()`);
    const first = await waitFor(async () => (await painted()) === 2 && 2, 4000);
    ok('setMarks paints the quotes found on the page (one across an element and a line break); one not on it is skipped', first === 2, `painted ${await painted()}`);
    await gm.eval('addLate()');
    ok('a quote the page adds later is painted when it appears', !!(await waitFor(async () => (await painted()) === 3, 4000)), `painted ${await painted()}`);
    const kept = await gm.eval(`[document.getElementById('one').outerHTML, document.getElementById('two').outerHTML]`);
    ok('the site\'s own HTML stays as it was (CSS highlights, no wrapping)', kept[0] === '<p id="one" style="background:rgb(20,40,90);color:#eee;padding:6px">alpha bravo charlie delta</p>' && kept[1] === '<p id="two">echo <b>foxtrot</b>\n  golf hotel</p>', JSON.stringify(kept));
    const geo = await geometry('c');
    const sc = geo.width / geo.layoutW;
    const b = await gm.eval(`(() => { const n = document.getElementById('one').firstChild, r = new Range(); r.setStart(n, 0); r.setEnd(n, 11); const q = r.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
    const mx = geo.left + b.x * sc, my = geo.top + b.y * sc;
    await mouse('mouseMoved', mx - 3, my);
    await mouse('mouseMoved', mx, my);
    const card = await waitFor(() => host.eval(`(() => { const c = document.querySelector('#win-c .pmark'); return c.classList.contains('on') && c.textContent; })()`), 3000);
    ok('hovering a mark shows what the owner wrote under it, over the page', card === 'first note\nsecond line', JSON.stringify(card));
    await shot('15-mark-hover');
    await click(mx, my);
    ok('a click on a mark calls onMark with its sentence', !!(await waitFor(async () => (await logOf('c', 'mark')).some((e) => e.text === 'alpha bravo'), 3000)), JSON.stringify(await logOf('c', 'mark')));
    await mouse('mouseMoved', mx, my + 140 * sc);
    ok('moving off the mark hides its note', !!(await waitFor(() => host.eval(`!document.querySelector('#win-c .pmark').classList.contains('on')`), 3000)));
    ok('findQuote scrolls the page to a quote and says true', (await host.eval(`${P('c')}.findQuote('late arrival text')`)) === true && (await gm.eval('scrollY')) > 1000, `scrollY ${await gm.eval('scrollY')}`);
    ok('findQuote says false for a quote that is not on the page', (await host.eval(`${P('c')}.findQuote('not on this page')`)) === false);
    const info = (await logOf('c', 'pageinfo')).map((e) => e.info).find((x) => x.url === `${FIX}/marks`);
    ok('onPage reports the page once it has loaded, with what it says it is about', info && info.title === 'marks' && info.about === 'A page with sentences to quote.', JSON.stringify(info));
    await host.eval(`${P('c')}.reload()`);
    await waitFor(() => host.eval(`${P('c')}.isLoading()`), 3000, 20);
    await waitFor(() => host.eval(`!${P('c')}.isLoading()`), 10000);
    ok('a reload paints the marks again', !!(await waitFor(async () => (await painted()) === 2, 4000)), `painted ${await painted()}`);
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/plain-target`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'plain target' && !${P('c')}.isLoading()`), 10000);
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/marks`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'marks' && !${P('c')}.isLoading()`), 10000);
    await sleep(800);
    ok('another page drops the marks until setMarks is called for it', (await painted()) === 0, `painted ${await painted()}`);
    gm.close();
  }
  {
    // A read of what a page is about that runs out of time (the page is busy as its load ends) gives notes no about,
    // and the page's next load in the tab, a reload, reads it again.
    const infos = async (path) => (await logOf('c', 'pageinfo')).map((e) => e.info).filter((x) => x.url.endsWith(path));
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/about-busy`)})`);
    const first = await waitFor(async () => (await infos('/about-busy'))[0], 8000);
    await sleep(2000);
    aboutBusy = false;
    await host.eval(`${P('c')}.reload()`);
    const again = await waitFor(async () => (await infos('/about-busy')).find((x) => x.about), 8000);
    ok('a read of what a page is about that runs out of time gives no about, and a reload reads it again', !!first && first.about === '' && !!again && again.about === 'A page that is busy as its first load ends.', JSON.stringify(await infos('/about-busy')));
  }
  {
    // A file dragged over a page and dropped there: the page says so (Flow's window sees no drag event in a page), and
    // page.js tells the app once (onDragDone, item 70), never while the drag crosses the page's own elements. The drag
    // goes in through the page's own target.
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${FIX}/dropzone`)})`);
    await waitFor(() => host.eval(`${P('c')}.getTitle() === 'dropzone' && !${P('c')}.isLoading()`), 10000);
    const gd = await guest((u) => u === `${FIX}/dropzone`);
    await waitFor(() => gd.eval('document.readyState === "complete"'), 5000);
    const file = path.join(SHOTS, 'dragged.txt');
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(file, 'dragged\n');
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    const drag = (type, x, y) => gd.send('Input.dispatchDragEvent', { type, x, y, data });
    const dones = async () => (await logOf('c', 'dragdone')).length;
    const d0 = await dones();
    await drag('dragEnter', 100, 60);
    for (const [x, y] of [[100, 60], [100, 180], [120, 300]]) {
      await drag('dragOver', x, y);
      await sleep(60);
    }
    await sleep(300);
    const moving = (await dones()) - d0;
    await drag('drop', 120, 300);
    await waitFor(async () => (await dones()) > d0, 3000);
    await sleep(400);
    const told = { moving, ended: (await dones()) - d0, drops: await gd.eval('window.__drops') };
    gd.close();
    ok('a file dropped on a page tells the app once that the drag ended there (onDragDone), and nothing while it moves over the page', told.moving === 0 && told.ended === 1 && told.drops === 1, JSON.stringify(told));
  }
  {
    // A site's own sign-in asks for a name and password in the page's area: on a new tab (the ask comes during its
    // webview's first load), again after a wrong password, gone after the right one, after Escape, and when the tab
    // goes elsewhere.
    const login = () => host.eval(`(() => { const f = document.querySelector('#win-c .plogin'); if (!f || !f.classList.contains('on')) return null; const [n, p] = f.querySelectorAll('.pl-f'); return { text: f.querySelector('.pl-t').textContent, name: n.value, pass: p.value, keys: document.activeElement === n ? 'name' : document.activeElement === p ? 'password' : String(document.activeElement && document.activeElement.className) }; })()`);
    await host.eval(`${P('c')}.newTab()`);
    const ad = await center('#win-c .ad');
    await click(ad.x, ad.y);
    await host.send('Input.insertText', { text: `${AUTH}/router` });
    await enter();
    const f1 = await waitFor(login, 8000);
    ok('a page behind a sign-in asks for a name and password in its own area, naming the site, with the keys in the name field', !!f1 && f1.text === `127.0.0.1:${FIX_PORT + 8}` && f1.keys === 'name', JSON.stringify(f1));
    await shot('16-sign-in');
    await host.send('Input.insertText', { text: 'owner' });
    await key('Tab', 'Tab', 9, '');
    await host.send('Input.insertText', { text: 'wrong' });
    await enter();
    const f2 = await waitFor(async () => { const f = await login(); return f && f.text !== `127.0.0.1:${FIX_PORT + 8}` && f; }, 6000);
    ok('a wrong password asks again, saying so, with the name kept and the keys in the password field', !!f2 && f2.text === 'that name and password did not work' && f2.name === 'owner' && f2.pass === '' && f2.keys === 'password', JSON.stringify(f2));
    await host.send('Input.insertText', { text: 'secret' });
    await enter();
    const inside = await waitFor(() => host.eval(`${P('c')}.getTitle() === 'inside' && !${P('c')}.isLoading()`), 8000);
    ok('the right ones sign in: the page loads and the form is gone', !!inside && !(await login()), JSON.stringify({ title: await host.eval(`${P('c')}.getTitle()`), form: await login() }));
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${AUTH}/second`)})`);
    const f3 = await waitFor(login, 8000);
    await key('Escape', 'Escape', 27, '');
    const gone = await waitFor(async () => !(await login()) && (await host.eval(`!${P('c')}.isLoading()`)), 5000);
    ok('Escape answers the site nothing: the form goes and the site shows its own page', !!f3 && !!gone, JSON.stringify({ f3, form: await login(), loading: await host.eval(`${P('c')}.isLoading()`) }));
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${AUTH}/third`)})`);
    const f4 = await waitFor(login, 8000);
    await host.eval(`${P('c')}.navigate(${JSON.stringify(`${AUTH}/open`)})`);
    const away = await waitFor(() => host.eval(`${P('c')}.getTitle() === 'open' && !${P('c')}.isLoading()`), 8000);
    ok('a tab that goes elsewhere while its page asks to sign in drops the form', !!f4 && !!away && !(await login()), JSON.stringify({ f4, away, form: await login() }));
    await host.eval(`${P('c')}.closeTab()`);
  }

  /* ---------- bare: the page alone, unfolded inside a note (notes' level 2) ---------- */
  {
    const BARE = `${FIX}/fixture?bare`;
    await host.eval(`window.__add({ id: 'n', url: ${JSON.stringify(BARE)}, bare: true })`);
    await host.eval(`document.getElementById('win-n').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:9'`);
    await waitFor(() => host.eval(`${P('n')}.getTitle() === 'flow fixture' && !${P('n')}.isLoading()`), 10000);
    // Its window got its size from this test: the page is laid out on the next frame (a resize observer), so look after it.
    await host.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    const shape = await host.eval(`(() => { const w = document.querySelector('#win-n .pgc'), v = w.querySelector('webview'); return { strip: !!w.querySelector('.ptabs'), addr: !!w.querySelector('.addr'), layoutW: v.offsetWidth, shownW: Math.round(v.getBoundingClientRect().width), pgvW: w.querySelector('.pgv').clientWidth }; })()`);
    ok('a bare page shows the page alone (no tab strip, no address line), laid out at desktop width and scaled to fit', !shape.strip && !shape.addr && shape.layoutW === Math.max(shape.pgvW, 1180) && Math.abs(shape.shownW - shape.pgvW) <= 1, JSON.stringify(shape));
    const gb = await guest((u) => u === BARE);
    const bpos = await gb.eval(`(() => { window.__clicks.length = 0; const r = document.getElementById('blank').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    // The bare page is fitted to its window as it loads: click once its box has stopped changing.
    const settled = await waitFor(async () => { const a = JSON.stringify(await geometry('n')); await sleep(150); return a === JSON.stringify(await geometry('n')) && JSON.parse(a); }, 4000);
    const bp = mapper(settled || (await geometry('n')))(bpos.x, bpos.y);
    const under = await host.eval(`(() => { const e = document.elementFromPoint(${bp.x}, ${bp.y}); return e ? e.tagName.toLowerCase() + '.' + e.className : null; })()`);
    await click(bp.x, bp.y);
    const opened = await waitFor(async () => (await logOf('n', 'open')).map((e) => e.url).join(), 4000);
    // On a miss, where the click went: the fixture logs every click it gets.
    const clicks = await gb.eval('window.__clicks.map((c) => c.id + "@" + Math.round(c.x) + "," + Math.round(c.y))').catch((e) => `unreadable: ${e.message}`);
    gb.close();
    ok('a link that would open a tab asks the app to open it beside (onOpen), and the bare page stays', opened === `${FIX}/popup-target` && (await host.eval(`${P('n')}.tabs().tabs.length`)) === 1 && (await host.eval(`${P('n')}.getURL()`)) === BARE, JSON.stringify({ opened, link: bpos, clicks, under, settled: !!settled }));
    await host.eval(`${P('n')}.dispose(); document.getElementById('win-n').remove()`);
    ok('dispose (folding it) frees its webview', (await host.eval(`document.querySelectorAll('#win-n webview').length`)) === 0 && !(await list()).some((t) => t.type === 'webview' && t.url === BARE));
  }

  /* ---------- clipping from a frame and from a PDF ---------- */
  {
    await host.eval(`window.__add({ id: 'g', url: ${JSON.stringify(`${FIX}/framed`)} })`);
    await host.eval(`document.getElementById('win-g').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:6'`);
    await waitFor(() => host.eval(`${P('g')}.getTitle() === 'framed' && !${P('g')}.isLoading()`), 10000);
    await sleep(300);
    const gf = await guest((u) => u === `${FIX}/framed`);
    await gf.eval(`(() => { const f = document.getElementById('f'), d = f.contentDocument, n = d.getElementById('p').firstChild, r = d.createRange(); r.setStart(n, 5); r.setEnd(n, 14); d.getSelection().removeAllRanges(); d.getSelection().addRange(r); f.focus(); return String(d.getSelection()); })()`);
    gf.close();
    ok('✂ clips a selection inside a frame of the same site', (await host.eval(`${P('g')}.clip()`)) === 'lima mike', JSON.stringify((await logOf('g', 'clip')).map((e) => e.text)));

    await host.eval(`${P('g')}.navigate(${JSON.stringify(`${FIX}/doc.pdf`)})`);
    await waitFor(() => host.eval(`${P('g')}.getURL().endsWith('/doc.pdf') && !${P('g')}.isLoading()`), 15000);
    await sleep(2500);
    const geo = await geometry('g');
    const mid = { x: (geo.view.l + geo.view.r) / 2, y: (geo.view.t + geo.view.b) / 2 };
    await click(mid.x, mid.y);
    await sleep(300);
    const SELECT_ALL = process.platform === 'darwin' ? 4 : 2;
    await key('a', 'KeyA', 65, '', SELECT_ALL);
    await sleep(400);
    const before = (await logOf('g', 'clip')).length;
    ok('a selection inside a PDF shows no ✂ (the right-click menu clips it)', !(await clipShown('g')));
    await host.eval(`${P('g')}.clip()`);
    await sleep(300);
    const hint = await host.eval(`document.querySelector('#win-g .phint').classList.contains('on') && document.querySelector('#win-g .phint').textContent`);
    ok('p.clip() on a PDF selection says flow cannot read it there, not "select text on the page first" and no how-to', hint === 'flow cannot read a selection in this part of the page' && (await logOf('g', 'clip')).length === before, JSON.stringify({ hint }));
    await host.eval(`${P('g')}.dispose()`);
    await host.eval(`document.getElementById('win-g').remove()`);
  }

  /* ---------- ✂ with the keys in a frame of another origin: the reason, not a how-to (real input) ---------- */
  {
    await host.eval(`window.__add({ id: 'x', url: ${JSON.stringify(`${FIX}/xframed`)} })`);
    await host.eval(`document.getElementById('win-x').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:420px;z-index:6'`);
    await waitFor(() => host.eval(`${P('x')}.getTitle() === 'xframed' && !${P('x')}.isLoading()`), 10000);
    await sleep(800);
    const gx = await guest((u) => u === `${FIX}/xframed`);
    const spots = await gx.eval(`(() => { const n = document.getElementById('outer').firstChild, r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 1); const a = r.getBoundingClientRect(); r.setStart(n, 10); r.setEnd(n, 11); const b = r.getBoundingClientRect(); const f = document.getElementById('xf').getBoundingClientRect(); return { x0: a.left + 2, x1: b.right - 2, y: a.top + a.height / 2, fx: f.left + 40, fy: f.top + 30 }; })()`);
    const at = mapper(await geometry('x'));
    const p0 = at(spots.x0, spots.y), p1 = at(spots.x1, spots.y);
    await mouse('mouseMoved', p0.x, p0.y);
    await mouse('mousePressed', p0.x, p0.y);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p0.x + ((p1.x - p0.x) * i) / 8, p0.y, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', p1.x, p1.y);
    const picked = await gx.eval('String(getSelection())');
    const shownAfterDrag = await waitFor(() => clipShown('x'), 2000);
    const fp = at(spots.fx, spots.fy);
    await click(fp.x, fp.y);
    await sleep(400);
    const inFrame = await gx.eval(`document.activeElement === document.getElementById('xf')`);
    gx.close();
    const shownWithFrame = await clipShown('x');
    let hint = null;
    if (shownWithFrame) {
      const c = await center('#win-x .pclip');
      await click(c.x, c.y);
      hint = await waitFor(() => host.eval(`document.querySelector('#win-x .phint').classList.contains('on') && document.querySelector('#win-x .phint').textContent`), 2000);
    }
    ok('✂ clicked while the keys are in a frame of another origin says flow cannot read it there (no how-to)', !!shownAfterDrag && inFrame && hint === 'flow cannot read a selection in this part of the page', JSON.stringify({ picked, shownAfterDrag: !!shownAfterDrag, inFrame, shownWithFrame, hint }));
    await host.eval(`${P('x')}.dispose(); document.getElementById('win-x').remove()`);
  }

  /* ---------- onRedirect: a page that goes on to another address by itself ---------- */
  {
    await host.eval(`window.__add({ id: 'r', url: ${JSON.stringify(`${FIX}/plain-target`)} })`);
    await host.eval(`document.getElementById('win-r').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:420px;z-index:6'`);
    const R = P('r');
    await waitFor(() => host.eval(`${R}.getTitle() === 'plain target' && !${R}.isLoading()`), 10000);
    const redirects = async () => (await logOf('r', 'redirect')).map(({ from, to, how }) => ({ from, to, how }));
    const lands = (url) => waitFor(() => host.eval(`${R}.getURL() === ${JSON.stringify(url)} && !${R}.isLoading()`), 10000);
    const last = async () => (await redirects()).pop() || null;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const pressIn = async (url, id) => {
      const g = await guest((u) => u === url);
      const at = await g.eval(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      g.close();
      const p = mapper(await geometry('r'))(at.x, at.y);
      await click(p.x, p.y);
    };

    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/r302`)})`);
    await lands(`${FIX}/plain-target?via=302`);
    ok('a server redirect reports where the tab was sent and where it landed', same(await last(), { from: `${FIX}/r302`, to: `${FIX}/plain-target?via=302`, how: 'server' }), JSON.stringify(await redirects()));
    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/self-replace`)})`);
    await lands(`${FIX}/plain-target?via=replace`);
    ok('a page that sends itself on with location.replace before any input reports it', same(await last(), { from: `${FIX}/self-replace`, to: `${FIX}/plain-target?via=replace`, how: 'page' }), JSON.stringify(await redirects()));
    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/self-meta`)})`);
    await lands(`${FIX}/plain-target?via=meta`);
    ok('a meta refresh reports it too', same(await last(), { from: `${FIX}/self-meta`, to: `${FIX}/plain-target?via=meta`, how: 'page' }), JSON.stringify(await redirects()));
    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/spa-start`)})`);
    await lands(`${FIX}/spa-home`);
    await sleep(300);
    ok('an app that moves to another path with replaceState while it loads reports it', same(await last(), { from: `${FIX}/spa-start`, to: `${FIX}/spa-home`, how: 'page' }), JSON.stringify(await redirects()));
    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/self-late`)})`);
    await lands(`${FIX}/self-late-moved`);
    await sleep(300);
    ok('a page that moves itself a moment later, still before any input, reports it', same(await last(), { from: `${FIX}/self-late`, to: `${FIX}/self-late-moved`, how: 'page' }), JSON.stringify(await redirects()));
    await host.eval(`window.__add({ id: 'r2', url: ${JSON.stringify(`${FIX}/r302`)} })`);
    const first = await waitFor(async () => (await logOf('r2', 'redirect')).map(({ from, to, how }) => ({ from, to, how }))[0], 10000);
    ok('a new page whose first address redirects reports it', same(first, { from: `${FIX}/r302`, to: `${FIX}/plain-target?via=302`, how: 'server' }), JSON.stringify(first));
    await host.eval(`window.__pages.r2.dispose(); document.getElementById('win-r2').remove()`);
    const counted = (await redirects()).length;

    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/self-late`)})`);
    await lands(`${FIX}/self-late`);
    await pressIn(`${FIX}/self-late`, 'p');
    await lands(`${FIX}/self-late-moved`);
    await sleep(300);
    ok('once the owner has pressed in the page, its own move is not a redirect', (await redirects()).length === counted, JSON.stringify(await redirects()));
    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/link-page`)})`);
    await lands(`${FIX}/link-page`);
    await pressIn(`${FIX}/link-page`, 'go');
    await lands(`${FIX}/plain-target?via=click`);
    await sleep(300);
    ok('a link the owner clicks is not a redirect', (await redirects()).length === counted, JSON.stringify(await redirects()));
    await host.eval(`${R}.navigate(${JSON.stringify(`${FIX}/plain-target`)})`);
    await lands(`${FIX}/plain-target`);
    await host.eval(`${R}.back()`);
    await lands(`${FIX}/plain-target?via=click`);
    await host.eval(`${R}.forward()`);
    await lands(`${FIX}/plain-target`);
    const navs = (await logOf('r', 'navigate')).length;
    await host.eval(`${R}.reload()`);
    await waitFor(async () => (await logOf('r', 'navigate')).length > navs && host.eval(`!${R}.isLoading()`), 10000);
    await sleep(300);
    ok('a typed address, back, forward and reload are not redirects', (await redirects()).length === counted, JSON.stringify(await redirects()));
    await host.eval(`${R}.dispose(); document.getElementById('win-r').remove()`);
  }

  /* ---------- a file tab shows the file's own path, not its signed address ---------- */
  {
    // The harness has no workspace folders, so main signs no file here: the address is made up (it fails to load),
    // which is all the field reads. test/page-app-cdp.mjs opens a real signed one.
    const enc = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const signed = `flow-file://mac/AAAAAAAAAAAAAAAAAAAAAA/${enc(path.join(os.homedir(), 'flow', 'notes for a tab.md'))}`;
    await host.eval(`window.__add({ id: 'ff', url: ${JSON.stringify(signed)} })`);
    await host.eval(`document.getElementById('win-ff').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:420px;z-index:6'`);
    await waitFor(() => host.eval(`!${P('ff')}.isLoading() && !!document.querySelector('#win-ff webview')`), 10000);
    const field = () => host.eval(`(() => { const w = document.querySelector('#win-ff'); const where = w.querySelector('.pwhere'); return { value: w.querySelector('.ad').value, where: where.classList.contains('on') ? where.textContent : '' }; })()`);
    const want = '~/flow/notes for a tab.md';
    const idle = await field();
    ok('a file tab shows its path in ~ form, not its signed address, and the tab keeps the signed address', idle.value === want && idle.where === '' && (await host.eval(`${P('ff')}.tabs().tabs[0].url`)) === signed, JSON.stringify({ signed, idle }));
    const behind = await host.eval(`(() => { const v = document.querySelector('#win-ff .pgv'); const w = v.querySelector('webview'); return { file: v.classList.contains('file'), view: getComputedStyle(v).backgroundColor, webview: w ? getComputedStyle(w).backgroundColor : null }; })()`);
    ok('a file tab\'s page has no white behind it (its own background reaches the edge)', behind.file && behind.view === 'rgba(0, 0, 0, 0)' && behind.webview === 'rgba(0, 0, 0, 0)', JSON.stringify(behind));
    const ad = await center('#win-ff .ad');
    await click(ad.x, ad.y);
    await sleep(200);
    const editing = await field();
    const navs = (await logOf('ff', 'navigate')).length;
    await enter();
    await sleep(800);
    const after = { url: await host.eval(`${P('ff')}.getURL()`), navs: (await logOf('ff', 'navigate')).length, focused: await host.eval(`document.activeElement === document.querySelector('#win-ff .ad')`) };
    ok('while it is edited the field still shows the path, and Enter on it unchanged stays where it is', editing.value === want && after.url === signed && after.navs === navs && !after.focused, JSON.stringify({ editing, after, navs }));
    // Marks stay with a file under a fresh signature (main's key renewed): the same page. Main answers a made-up
    // signature with a 403 page reading "refused", which is what is marked here.
    await host.eval(`${P('ff')}.setMarks([{ text: 'refused', note: '' }])`);
    const painted = async () => {
      const t = (await list()).find((x) => x.type === 'webview' && x.url.startsWith('flow-file://mac/'));
      if (!t) return null;
      const g = await CDP.connect(t.webSocketDebuggerUrl);
      const n = await g.eval(`(() => { const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0; })()`).catch(() => null);
      g.close();
      return n;
    };
    const markedFirst = await waitFor(async () => (await painted()) === 1, 4000);
    const resigned = signed.replace(/\/mac\/[^/]+\//, '/mac/BBBBBBBBBBBBBBBBBBBBBB/');
    await host.eval(`${P('ff')}.navigate(${JSON.stringify(resigned)})`);
    await waitFor(() => host.eval(`${P('ff')}.getURL() === ${JSON.stringify(resigned)} && !${P('ff')}.isLoading()`), 10000);
    const markedAgain = await waitFor(async () => (await painted()) === 1, 4000);
    ok('a file page keeps its marks under a fresh signature (the same file)', !!markedFirst && !!markedAgain, JSON.stringify({ markedFirst, markedAgain, now: await painted() }));
    const vm = 'flow-file://vm/AAAAAAAAAAAAAAAAAAAAAA/flow-test.local/home/claude/flow/notes.md';
    await host.eval(`${P('ff')}.navigate(${JSON.stringify(vm)})`);
    await waitFor(() => host.eval(`${P('ff')}.getURL() === ${JSON.stringify(vm)}`), 10000);
    await sleep(500);
    const onVm = await field();
    ok('a VM file shows its full path there, with "on the VM" beside it', onVm.value === '/home/claude/flow/notes.md' && onVm.where === 'on the VM', JSON.stringify(onVm));
    await host.eval(`${P('ff')}.dispose(); document.getElementById('win-ff').remove()`);
  }

  /* ---------- tabs: keys, a closed tab back, site icons, a strip of many ---------- */
  {
    // Its own page id (the harness keeps a page's tabs by id, and 'tk' is an earlier check's). The keys are main's menu items, which reach a page as
    // these calls (app.js MENU); a real click closes the tab.
    await host.eval(`window.__add({ id: 'tb', url: ${JSON.stringify(`${FIX}/plain-target`)} })`);
    await host.eval(`document.getElementById('win-tb').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:420px;z-index:6'`);
    const K = P('tb');
    const shown = () => host.eval(`(() => { const t = ${K}.tabs(); return { tab: t.tab, n: t.tabs.length, url: ${K}.getURL().replace(${JSON.stringify(FIX)}, '') }; })()`);
    await waitFor(() => host.eval(`${K}.getTitle() === 'plain target' && !${K}.isLoading()`), 15000);
    await host.eval(`${K}.newTab(${JSON.stringify(`${FIX}/iconic`)})`);
    const icon = await waitFor(() => host.eval(`(() => { const i = document.querySelector('#win-tb .ptab.on .pt-i'); return !!i && !i.hidden && i.complete && i.naturalWidth > 0 && i.getAttribute('src').slice(0, 22); })()`), 10000);
    ok('a tab shows its site\'s icon', icon === 'data:image/png;base64,', JSON.stringify(icon));
    // an icon the page names by address is never fetched by Flow's own document (it would be again at every launch, and
    // fail once the site is gone): that tab shows none, and nothing is logged (build's e2e check 7)
    await host.eval(`${K}.newTab(${JSON.stringify(`${FIX}/iconic-gone`)})`);
    await waitFor(() => host.eval(`${K}.getTitle() === 'iconic gone' && !${K}.isLoading()`), 10000);
    await sleep(800);
    const gone = await host.eval(`(() => { const i = document.querySelector('#win-tb .ptab.on .pt-i'); return { src: i ? i.getAttribute('src') || '' : '', kept: ${K}.tabs().tabs.find((t) => t.url.endsWith('/iconic-gone')).icon || '' }; })()`);
    ok('an icon named by address is not fetched by Flow\'s document: the tab shows none and keeps none', gone.src === '' && gone.kept === '', JSON.stringify(gone));
    await host.eval(`${K}.closeTab()`);
    // one the site does serve comes through the page's own session (main), inline; Flow's document still asks it nothing
    await host.send('Network.enable');
    const hostAsked = [];
    const onNet = (m) => { const d = JSON.parse(m.data); if (d.method === 'Network.requestWillBeSent' && /\/icon\.png/.test(d.params.request.url)) hostAsked.push(d.params.request.url); };
    host.ws.addEventListener('message', onNet);
    await host.eval(`${K}.newTab(${JSON.stringify(`${FIX}/iconic-addr`)})`);
    const addrIcon = await waitFor(() => host.eval(`(() => { const i = document.querySelector('#win-tb .ptab.on .pt-i'); return !!i && !i.hidden && i.complete && i.naturalWidth > 0 && (i.getAttribute('src') || '').slice(0, 22); })()`), 10000);
    host.ws.removeEventListener('message', onNet);
    await host.send('Network.disable');
    ok('an icon the page names by address shows, fetched through the page\'s own session: Flow\'s document asks no site for it', addrIcon === 'data:image/png;base64,' && hostAsked.length === 0, JSON.stringify({ addrIcon, hostAsked }));
    await host.eval(`${K}.closeTab()`);
    await host.eval(`${K}.newTab(${JSON.stringify(`${FIX}/fixture`)})`);
    await waitFor(() => host.eval(`${K}.getTitle() === 'flow fixture' && !${K}.isLoading()`), 15000);
    const keys = [];
    for (const [call, label] of [['stepTab(1)', 'next from the last goes round to the first'], ['stepTab(-1)', 'previous from the first goes round to the last'], ['showTab(2)', '⌘2'], ['showTab(9)', '⌘9 is the last'], ['showTab(1)', '⌘1']]) {
      await host.eval(`${K}.${call}`);
      await sleep(300);
      keys.push({ label, ...(await shown()) });
    }
    ok('the tab keys go next, previous (round the ends), to a numbered tab and to the last', keys.map((k) => k.tab).join() === '0,2,1,2,0', JSON.stringify(keys));
    // the icon tab gets a history of its own, then a real click on its ×
    await host.eval(`${K}.showTab(2)`);
    await host.eval(`${K}.navigate(${JSON.stringify(`${FIX}/plain-target?second`)})`);
    await waitFor(() => host.eval(`${K}.getURL().endsWith('?second') && !${K}.isLoading()`), 10000);
    await sleep(800);
    const before = await shown();
    const tab = await center('#win-tb .ptab.on');
    await mouse('mouseMoved', tab.x, tab.y);
    await sleep(200);
    const x = await center('#win-tb .ptab.on .pt-x');
    await click(x.x, x.y);
    const closed = await waitFor(async () => { const s2 = await shown(); return s2.n === before.n - 1 && s2; }, 4000);
    await host.eval(`${K}.reopenTab()`);
    const back = await waitFor(async () => { const s2 = await shown(); return s2.n === before.n && s2.url === before.url && !(await host.eval(`${K}.isLoading()`)) && s2; }, 10000);
    await sleep(600);
    await host.eval(`${K}.back()`);
    const prior = await waitFor(async () => { const s2 = await shown(); return s2.url === '/iconic' && s2; }, 10000);
    const iconBack = await waitFor(() => host.eval(`(() => { const i = document.querySelector('#win-tb .ptab.on .pt-i'); return !!i && !i.hidden && i.complete && i.naturalWidth > 0; })()`), 5000);
    ok('a tab closed with its × comes back (⇧⌘T) where it was with its history (back goes to the page before), and that page\'s icon shows', !!closed && !!back && back.tab === before.tab && !!prior && iconBack, JSON.stringify({ before, closed, back, prior, iconBack }));
    // print goes to the page's own print (the system's dialog is the Mac's; here the webview's print is recorded)
    await host.eval(`(() => { const w = document.querySelector('#win-tb webview:not(.off)'); window.__printed = 0; w.print = () => { window.__printed++; return Promise.resolve(); }; return true; })()`);
    await host.eval(`${K}.print()`);
    ok('print() prints the shown page through its own print', (await host.eval('window.__printed')) === 1);
    // A link of the page that would cross into a report, stopped by main (page:new-window, 'current-tab'), goes there
    // in this same tab: no new tab, and the tab gets a webview of the report's kind. main is asked to send it as it does.
    if (main) {
      const n2 = (await shown()).n;
      const gid = await host.eval(`document.querySelector('#win-tb webview:not(.off)').getWebContentsId()`);
      const enc = (q) => q.split('/').filter(Boolean).map(encodeURIComponent).join('/');
      const report = `flow-file://mac/AAAAAAAAAAAAAAAAAAAAAA/${enc(path.join(os.homedir(), 'flow', 'a report.html'))}`;
      await inMain(`(() => { const { webContents } = require('electron'); const g = webContents.fromId(${gid}); g.hostWebContents.send('page:new-window', { url: ${JSON.stringify(report)}, disposition: 'current-tab', guestId: g.id }); return true; })()`);
      const there = await waitFor(async () => { const s2 = await shown(); const id = await host.eval(`(() => { try { return document.querySelector('#win-tb webview:not(.off)').getWebContentsId(); } catch (e) { return null; } })()`); return s2.url === report && id != null && id !== gid && { ...s2, id }; }, 10000);
      ok('a crossing link the page started, stopped by main, goes on in the same tab with a new webview', !!there && there.n === n2, JSON.stringify(there || (await shown())));
      // Back acts once the tab knows its new page (bound), as for any page
      await waitFor(() => host.eval(`${K}.guests().includes(${there ? there.id : -1})`), 5000);
      await host.eval(`${K}.back()`);
      await waitFor(async () => (await shown()).url !== report && !(await host.eval(`${K}.isLoading()`)), 10000);
    }
    // a tab dragged well below the strip follows the pointer and, let go there, goes out to the app with its page
    const outs = () => logOf('tb', 'tabout');
    const n0 = (await shown()).n;
    const was = (await shown()).url;
    const from = await center('#win-tb .ptab.on');
    await mouse('mouseMoved', from.x, from.y);
    await mouse('mousePressed', from.x, from.y);
    for (const dy of [8, 30, 60, 90]) await mouse('mouseMoved', from.x + 10, from.y + dy, { button: 'left', buttons: 1 });
    const ghost = await host.eval(`!!document.querySelector('.ptghost')`);
    await mouse('mouseReleased', from.x + 10, from.y + 90);
    const out = await waitFor(async () => { const o = await outs(); return o.length && o[o.length - 1]; }, 4000);
    const left = await waitFor(async () => { const s2 = await shown(); return s2.n === n0 - 1 && s2; }, 4000);
    ok('a tab dragged off the strip follows the pointer and, let go, goes to the app with its page, history and the drop point', ghost && !!out && out.kept.url === FIX + was && !!out.kept.history && !!out.at && Math.abs(out.at.y - (from.y + 90)) <= 1 && !!left && !(await host.eval(`!!document.querySelector('.ptghost')`)), JSON.stringify({ ghost, out: out && { url: out.kept.url, at: out.at, history: !!out.kept.history }, left }));
    // the tab's own menu
    const rt = await center('#win-tb .ptab.on');
    await host.eval('window.__menu = null, true');
    await click(rt.x, rt.y, 0, 'right');
    const menu = await waitFor(() => host.eval(`window.__menu && window.__menu.page === 'tb' && window.__menu.items.map((i) => i.label)`), 3000);
    ok('right-clicking a tab offers "move to new window" and "close"', JSON.stringify(menu) === JSON.stringify(['move to new window', 'close']), JSON.stringify(menu));
    const n1 = (await shown()).n, o1 = (await outs()).length;
    await host.eval('window.__menu.items[0].run(), true');
    const sent = await waitFor(async () => { const o = await outs(); return o.length > o1 && (await shown()).n === n1 - 1 && o[o.length - 1]; }, 4000);
    ok('"move to new window" hands the tab to the app with no drop point (beside this window)', !!sent && sent.at === null, JSON.stringify(sent && { url: sent.kept.url, at: sent.at }));
    // a tab from another window, dropped on this strip
    if (out) {
      await host.eval(`${K}.adoptTab(${JSON.stringify(out.kept)}, 0)`);
      const adopted = await waitFor(async () => { const s2 = await shown(); return s2.tab === 0 && s2.url === was && !(await host.eval(`${K}.isLoading()`)) && s2; }, 10000);
      ok('a tab from another page window goes in where it is dropped and shows its page', !!adopted, JSON.stringify(adopted || (await shown())));
    }
    // twelve tabs in a narrow window: each stays readable and the strip scrolls, the shown tab in view
    await host.eval(`document.getElementById('win-tb').style.width = '420px'`);
    const more = 12 - (await shown()).n;
    for (let i = 0; i < more; i++) await host.eval(`${K}.newTab(${JSON.stringify(`${FIX}/many/${i}`)}, { show: false })`);
    await host.eval(`${K}.showTab(9)`);
    await sleep(600);
    const strip = await host.eval(`(() => { const s = document.querySelector('#win-tb .ptabs'), tabs = [...s.querySelectorAll('.ptab')], on = s.querySelector('.ptab.on'); const r = s.getBoundingClientRect(), o = on.getBoundingClientRect(); return { n: tabs.length, narrowest: Math.round(Math.min(...tabs.map((t) => t.getBoundingClientRect().width))), scrolls: s.scrollWidth > s.clientWidth, shownInView: o.left >= r.left - 1 && o.right <= r.right + 1 }; })()`);
    ok('twelve tabs in a narrow window stay readable (no tab under 100 px), and the strip scrolls with the shown tab in view', strip.n === 12 && strip.narrowest >= 99 && strip.scrolls && strip.shownInView, JSON.stringify(strip));
    await host.eval(`${K}.dispose(); document.getElementById('win-tb').remove()`);
  }

  /* ---------- a report (a workspace file's HTML page) and web pages never share a webview ---------- */
  {
    // Its own page id: the harness keeps a page's tabs by id, and an earlier check used 'x'.
    // Main runs a report in a session of its own, picked from its webview's first address, so a tab going between a
    // report and a web page gets a new webview, and ‹ and › across that line load the page there again. The harness
    // signs no file: the made-up address loads main's 403 page, which is all the webviews need. Real clicks on ‹ ›.
    const enc = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const report = `flow-file://mac/AAAAAAAAAAAAAAAAAAAAAA/${enc(path.join(os.homedir(), 'flow', 'a report.html'))}`;
    await host.eval(`window.__add({ id: 'xr', url: ${JSON.stringify(`${FIX}/plain-target`)} })`);
    await host.eval(`document.getElementById('win-xr').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:420px;z-index:6'`);
    const X = P('xr');
    const view = () => host.eval(`(() => { const all = [...document.querySelectorAll('#win-xr webview')]; const on = all.find((w) => !w.classList.contains('off')); let id = null; try { id = on ? on.getWebContentsId() : null; } catch (e) { id = null; } return { webviews: all.length, id, url: ${X}.getURL(), loading: ${X}.isLoading(), back: !document.querySelector('#win-xr [data-nav=back]').classList.contains('off'), fwd: !document.querySelector('#win-xr [data-nav=fwd]').classList.contains('off') }; })()`);
    // a step that never settles reports what it saw last; a settled one waits until the tab knows its page (bound), as
    // ‹ and › act only then
    const at = async (url, test) => {
      let last = null;
      const v = await waitFor(async () => { last = await view(); return last.url === url && last.id != null && !last.loading && test(last) && last; }, 20000);
      if (v) await waitFor(() => host.eval(`${X}.guests().includes(${v.id})`), 5000);
      return v || { timedOut: true, ...last };
    };
    const press = async (nav) => { const b = await center(`#win-xr [data-nav=${nav}]`); await click(b.x, b.y); };
    const web = await at(`${FIX}/plain-target`, () => true);
    await host.eval(`${X}.navigate(${JSON.stringify(`${FIX}/fixture`)})`);
    const web2 = await at(`${FIX}/fixture`, () => true);
    await host.eval(`${X}.navigate(${JSON.stringify(report)})`);
    const rep = await at(report, (v) => v.id !== web2.id && v.back);
    await press('back');
    const back = await at(`${FIX}/fixture`, (v) => v.id !== rep.id && v.fwd);
    await press('back');
    const back2 = await at(`${FIX}/plain-target`, (v) => v.id === back.id);
    await press('fwd');
    const fwd = await at(`${FIX}/fixture`, (v) => v.id === back.id);
    await press('fwd');
    const fwd2 = await at(report, (v) => v.id !== back.id && !v.fwd);
    const steps = { web, web2, rep, back, back2, fwd, fwd2 };
    ok('a tab going between a web page and a report gets a new webview each way and keeps one within a kind; ‹ and › step across the line', Object.values(steps).every((v) => !v.timedOut && v.webviews === 1) && web.id === web2.id, JSON.stringify(steps));
    await host.eval(`${X}.dispose(); document.getElementById('win-xr').remove()`);
  }

  /* ---------- a focus still on its way when the owner presses on another window (Electron lands a webview's focus in
     two steps; on a busy machine the second can come long after). Here every focus in lf1 lands 1.5 s late on purpose. */
  {
    await host.eval(`window.__add({ id: 'lf1', url: ${JSON.stringify(`${FIX}/plain-target?lf`)} }); window.__add({ id: 'lf2', url: ${JSON.stringify(`${FIX}/plain-target?lf2`)} }); true`);
    await host.eval(`document.getElementById('win-lf1').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:8'; document.getElementById('win-lf2').style.cssText = 'position:fixed;left:780px;top:12px;width:732px;height:430px;z-index:8'; true`);
    await waitFor(() => host.eval(`${P('lf1')}.getTitle() === 'plain target' && !${P('lf1')}.isLoading()`), 10000);
    await host.eval(`(() => {
      const proto = Object.getPrototypeOf(document.createElement('webview'));
      const orig = proto.focus;
      window.__lfOrig = orig;
      proto.focus = function (...a) { if (this.closest && this.closest('#win-lf1')) { setTimeout(() => { window.__lfLanded = performance.now(); orig.apply(this, a); }, 1500); return; } return orig.apply(this, a); };
      document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('#win-lf2')) window.__lfPress = performance.now(); }, true);
      window.__lfReports = [];
      const push = window.__log.push.bind(window.__log);
      window.__log.push = (x) => { if (x && x.page === 'lf1' && x.ev === 'focus') window.__lfReports.push(performance.now()); return push(x); };
      return true;
    })()`);
    const tb2 = await host.eval(`(() => { const r = document.querySelector('#win-lf2 .title, #win-lf2').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) }; })()`);
    let r = null;
    for (let tries = 0; tries < 3 && !(r && r.landed > r.press); tries++) {
      await host.eval(`${P('lf1')}.newTab(''), ${P('lf1')}.focusAddress(), true`);
      await host.send('Input.insertText', { text: `${FIX}/slow?lf${tries}` });
      const n0 = await host.eval(`${P('lf1')}.guests().length`);
      await enter();
      await waitFor(() => host.eval(`${P('lf1')}.guests().length > ${n0}`), 5000, 20);
      await host.eval('window.__lfPress = 0; window.__lfLanded = 0; true');
      await click(tb2.x, tb2.y);
      await sleep(2600);
      r = await host.eval(`({ press: window.__lfPress, landed: window.__lfLanded, reports: window.__lfReports.filter((t) => t > window.__lfPress).length, keys: document.getElementById('win-lf1').contains(document.activeElement) })`);
    }
    ok('a press on another window before the page\'s focus lands: the keys stay off the page and its window is not brought forward', !!r && r.landed > r.press && r.reports === 0 && !r.keys, JSON.stringify(r));
    await host.eval(`Object.getPrototypeOf(document.createElement('webview')).focus = window.__lfOrig; delete window.__log.push; true`);
    await host.eval(`${P('lf1')}.dispose(); document.getElementById('win-lf1').remove(); ${P('lf2')}.dispose(); document.getElementById('win-lf2').remove(); true`);
  }

  /* ---------- ‹ pressed before the tab knows its new page (⌘[ or the menu right after a page of another kind took its
     place): held and run at the bind, never dropped. Here the new webview keeps its id back 1.5 s on purpose. */
  {
    const enc = (q) => q.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const report = `flow-file://mac/AAAAAAAAAAAAAAAAAAAAAA/${enc(path.join(os.homedir(), 'flow', 'a report.html'))}`;
    await host.eval(`window.__add({ id: 'bk', url: ${JSON.stringify(`${FIX}/plain-target?bk`)} }); true`);
    await host.eval(`document.getElementById('win-bk').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:8'; true`);
    await waitFor(() => host.eval(`${P('bk')}.getTitle() === 'plain target' && !${P('bk')}.isLoading()`), 10000);
    await host.eval(`${P('bk')}.navigate(${JSON.stringify(`${FIX}/fixture?bk`)})`);
    await waitFor(() => host.eval(`${P('bk')}.getURL() === ${JSON.stringify(`${FIX}/fixture?bk`)} && !${P('bk')}.isLoading()`), 10000);
    await host.eval(`(() => {
      const proto = Object.getPrototypeOf(document.createElement('webview'));
      const orig = proto.getWebContentsId, first = new WeakMap(), old = new Set(document.querySelectorAll('#win-bk webview'));
      window.__bkOrig = orig;
      proto.getWebContentsId = function () {
        if (!old.has(this) && this.closest && this.closest('#win-bk')) {
          if (!first.has(this)) first.set(this, performance.now());
          if (performance.now() - first.get(this) < 1500 && /guestIdOf/.test(new Error().stack)) throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.');
        }
        return orig.call(this);
      };
      return true;
    })()`);
    const n0 = await host.eval(`${P('bk')}.guests().length`);
    await host.eval(`${P('bk')}.navigate(${JSON.stringify(report)})`);
    await waitFor(() => host.eval(`${P('bk')}.getURL() === ${JSON.stringify(report)}`), 5000);
    const early = await host.eval(`({ url: ${P('bk')}.getURL(), bound: ${P('bk')}.guests().length > ${n0}, back: !document.querySelector('#win-bk [data-nav=back]').classList.contains('off') })`);
    await host.eval(`${P('bk')}.back()`);
    const went = await waitFor(() => host.eval(`${P('bk')}.getURL() === ${JSON.stringify(`${FIX}/fixture?bk`)} && !${P('bk')}.isLoading()`), 8000);
    ok('‹ pressed before the tab knows its new page is held and goes back once it does (‹ already shown)', early.url === report && !early.bound && early.back && !!went, JSON.stringify({ early, now: await host.eval(`${P('bk')}.getURL()`) }));
    await host.eval(`Object.getPrototypeOf(document.createElement('webview')).getWebContentsId = window.__bkOrig; ${P('bk')}.dispose(); document.getElementById('win-bk').remove(); true`);
  }

  /* ---------- a tab unseen for a while gives up its page, and comes back where it was (lead, item 57) ---------- */
  {
    const zv = () => host.eval(`[...document.querySelectorAll('#win-zz .pgv webview')].map((w) => w.getAttribute('src'))`);
    const marked = (g) => g.eval(`(() => { const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0; })()`);
    await host.eval(`window.__add({ id: 'zz', url: ${JSON.stringify(`${FIX}/fixture?zz`)}, unloadAfter: 2500 })`);
    await host.eval(`document.getElementById('win-zz').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:430px;z-index:7'`);
    await waitFor(() => host.eval(`${P('zz')}.getTitle() === 'flow fixture' && !${P('zz')}.isLoading()`), 10000);
    await host.eval(`${P('zz')}.setMarks([{ text: 'needle one', note: 'kept' }])`);
    const gz = await guest((u) => u === `${FIX}/fixture?zz`);
    await gz.eval('scrollTo(0, 700), true');
    const y0 = await gz.eval('scrollY');
    const firstMarked = await waitFor(async () => (await marked(gz)) === 1, 4000);
    gz.close();
    const gzId = await host.eval(`document.querySelector('#win-zz .pgv webview').getWebContentsId()`);
    await sleep(400);
    // a page whose site guards typing, and one playing sound: neither ever goes
    await host.eval(`${P('zz')}.newTab(${JSON.stringify(`${FIX}/guard?zz`)})`);
    await waitFor(() => host.eval(`${P('zz')}.getTitle() === 'guard' && !${P('zz')}.isLoading()`), 10000);
    {
      const gg = await guest((u) => u === `${FIX}/guard?zz`);
      const tpos = await gg.eval(`(() => { const r = document.getElementById('t').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()`);
      gg.close();
      const tp = mapper(await geometry('zz'))(tpos.x, tpos.y);
      await click(tp.x, tp.y);
      await host.send('Input.insertText', { text: 'a draft' });
    }
    const guardedZ = await waitFor(() => host.eval(`${P('zz')}.guarded()`), 3000);
    await host.eval(`${P('zz')}.newTab(${JSON.stringify(`${FIX}/player`)})`);
    await waitFor(() => host.eval(`${P('zz')}.getTitle() === 'player' && !${P('zz')}.isLoading()`), 10000);
    const gp = await guest((u) => u === `${FIX}/player`);
    {
      const pp = mapper(await geometry('zz'))(60, 40);
      await click(pp.x, pp.y);
    }
    const playing = await waitFor(() => gp.eval(`!document.getElementById('a').paused`), 4000);
    gp.close();
    await host.eval(`${P('zz')}.newTab(${JSON.stringify(`${FIX}/plain-target?zz`)})`);
    await waitFor(() => host.eval(`${P('zz')}.getTitle() === 'plain target' && !${P('zz')}.isLoading()`), 10000);
    const rested = await waitFor(async () => { const v = await zv(); return !v.includes(`${FIX}/fixture?zz`) && v; }, 9000);
    const procGone = main ? await waitFor(() => inMain(`(() => { const { webContents } = require('electron'); return !webContents.fromId(${gzId}); })()`), 4000) : null;
    ok('a tab unseen past its time gives up its page: its webview and its webContents are gone', !!rested && procGone !== false && firstMarked, JSON.stringify({ rested, procGone }));
    await sleep(3000);
    const still = await zv();
    ok('the tab on screen, a page whose site guards typing and one playing sound keep theirs', still.includes(`${FIX}/plain-target?zz`) && still.includes(`${FIX}/guard?zz`) && still.includes(`${FIX}/player`) && !!playing && guardedZ === true, JSON.stringify({ still, playing, guarded: guardedZ }));
    ok('the tab that rested stays in the strip as it was', JSON.stringify((await host.eval(`${P('zz')}.tabs()`)).tabs.map((t) => t.title)) === JSON.stringify(['flow fixture', 'guard', 'player', 'plain target']));
    await host.eval(`${P('zz')}.selectTab(0)`);
    const gz2 = await guest((u) => u === `${FIX}/fixture?zz`);
    const back = await waitFor(async () => { const y = await gz2.eval('scrollY'); return y === y0 && y; }, 8000);
    const markedAgain = await waitFor(async () => (await marked(gz2)) === 1, 4000);
    gz2.close();
    ok('shown again, it comes back at its place with its highlight', y0 > 0 && back === y0 && !!markedAgain, JSON.stringify({ y0, back, markedAgain }));
    await host.eval(`${P('zz')}.dispose(); document.getElementById('win-zz').remove()`);
  }

  /* ---------- lazy creation and dispose ---------- */
  {
    await host.eval(`window.__add({ id: 'e', url: ${JSON.stringify(`${FIX}/plain-target`)}, visible: false })`);
    // focus() before the page is made: its page takes the keys once its webview is there
    await host.eval(`${P('e')}.focus()`);
    ok('a page is not created before setVisible(true)', await host.eval(`!document.querySelector('#win-e webview')`));
    await host.eval(`${P('e')}.setVisible(true)`);
    await waitFor(() => host.eval(`${P('e')}.getTitle() === 'plain target'`), 10000);
    ok('setVisible(true) creates and loads it', (await host.eval(`${P('e')}.getTitle()`)) === 'plain target');
    ok('focus() asked before the page was made puts the keys in its webview once it is there', !!(await waitFor(() => host.eval(`document.activeElement === document.querySelector('#win-e webview')`), 3000)), await host.eval(`(document.activeElement && document.activeElement.tagName) || ''`));
    await host.eval(`${P('e')}.setVisible(false); ${P('e')}.setVisible(true)`);
    ok('hiding and showing again does not recreate or reload it', (await host.eval(`document.querySelectorAll('#win-e webview').length`)) === 1 && (await logOf('e', 'navigate')).length === 1);
    // p.focus(): the app went to this window, so the keys go to the shown tab's page
    {
      await host.eval(`document.activeElement && document.activeElement.blur(), true`);
      await host.eval(`${P('e')}.focus()`);
      const onPage = await waitFor(() => host.eval(`document.activeElement === document.querySelector('#win-e webview:not(.off)')`), 2000);
      await host.eval(`${P('e')}.newTab('')`);
      await host.eval(`document.activeElement && document.activeElement.blur(), true`);
      await host.eval(`${P('e')}.focus()`);
      const onAddress = await host.eval(`document.activeElement === document.querySelector('#win-e .ad')`);
      await host.eval(`${P('e')}.closeTab(1)`);
      ok('focus() puts the keys in the shown page (its webview), and a new tab\'s in its address line', !!onPage && onAddress, JSON.stringify({ onPage, onAddress, active: await host.eval(`(document.activeElement && document.activeElement.tagName) || ''`) }));
    }
    {
      const navs = (await logOf('e', 'navigate')).length;
      await host.eval(`${P('e')}.reload()`);
      await waitFor(async () => (await logOf('e', 'navigate')).length > navs && host.eval(`!${P('e')}.isLoading()`), 8000);
      const t = await host.eval(`${P('e')}.getTitle()`);
      ok('reload keeps the title of a page whose title does not change', t === 'plain target', JSON.stringify({ title: t, navigations: `${navs} -> ${(await logOf('e', 'navigate')).length}` }));
    }
    // A click Chromium gives Flow instead of the page, as it does to a webview just attached in a new window: made here
    // by keeping the page's frame out of Chromium's hit testing for that one click. Real clicks and keys. The click
    // goes on to the page at its point, and the keys go to the page, whether they were in it (a fresh pop-out) or in
    // the address line.
    {
      await host.eval(`document.getElementById('win-e').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:420px;z-index:5'`);
      const g = await guest((u) => u === `${FIX}/plain-target`);
      await g.eval(`window.__got = []; addEventListener('pointerdown', (e) => window.__got.push(e.isTrusted ? 'click ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) : 'untrusted click'), true); addEventListener('keydown', (e) => window.__got.push(e.isTrusted ? 'key ' + e.key : 'untrusted key'), true); true`);
      await host.eval(`window.__flowGot = []; window.__flowRec = (e) => window.__flowGot.push(e.type === 'keydown' ? 'key ' + e.key : 'click on ' + e.target.tagName.toLowerCase()); document.addEventListener('pointerdown', window.__flowRec, true); document.addEventListener('keydown', window.__flowRec, true); true`);
      const hitTest = (off) => host.eval(`document.querySelector('#win-e webview:not(.off)').shadowRoot.querySelector('iframe').style.pointerEvents = ${off ? "'none'" : "''"}`);
      // the page laid out for the window's new size (page.js fits it from a ResizeObserver) before its points are read
      await waitFor(() => host.eval(`(() => { const w = document.querySelector('#win-e webview:not(.off)'), v = w.parentElement, r = w.getBoundingClientRect(); return Math.abs(r.width - v.clientWidth) < 1 && Math.abs(r.height - v.clientHeight) < 1; })()`), 3000);
      const p = mapper(await geometry('e'))(120, 90);
      const seen = [];
      for (const from of ['the page', 'the address line']) {
        if (from === 'the page') await host.eval(`${P('e')}.focus()`);
        else {
          const a = await center('#win-e .ad');
          await click(a.x, a.y);
        }
        const had = from === 'the page' ? '#win-e webview:not(.off)' : '#win-e .ad';
        const before = await waitFor(() => host.eval(`document.activeElement === document.querySelector(${JSON.stringify(had)})`), 3000);
        await g.eval('window.__got.length = 0');
        await host.eval('window.__flowGot.length = 0');
        await hitTest(true);
        await click(p.x, p.y);
        await hitTest(false);
        await waitFor(() => g.eval(`window.__got.some((x) => x.startsWith('click'))`), 3000);
        await key('End', 'End', 35, '');
        await waitFor(async () => (await g.eval(`window.__got.includes('key End')`)) || host.eval(`window.__flowGot.includes('key End')`), 3000);
        seen.push({ from, before, page: await g.eval('window.__got.slice()'), flow: await host.eval('window.__flowGot.slice()') });
      }
      await host.eval(`document.removeEventListener('pointerdown', window.__flowRec, true); document.removeEventListener('keydown', window.__flowRec, true); true`);
      g.close();
      const atPoint = (r) => { const m = /^click (\d+),(\d+)$/.exec(r.page[0] || ''); return !!m && Math.abs(m[1] - 120) <= 1 && Math.abs(m[2] - 90) <= 1; };
      ok('a click Chromium gives Flow instead of the page goes on to the page at its point, and the keys go there (from the page and from the address line)', seen.every((r) => r.before && r.flow.includes('click on webview') && atPoint(r) && r.page.includes('key End') && !r.flow.includes('key End')), JSON.stringify(seen));
    }
    {
      await host.eval(`document.getElementById('win-e').style.cssText = 'position:fixed;left:12px;top:12px;width:732px;height:420px;z-index:5'`);
      const g = await guest((u) => u === `${FIX}/plain-target`);
      // The renderer dies before it can answer, so this reply normally never comes.
      g.send('Page.crash').catch((e) => console.log(`     Page.crash answered with an error: ${e.message}`));
      const crashed = await waitFor(() => host.eval(`(() => { const e = document.querySelector('#win-e .perr'); return e.classList.contains('on') && e.innerText; })()`), 8000);
      ok('a crashed page shows "the page crashed" with try again', /the page crashed/.test(crashed || ''), JSON.stringify(crashed));
      const navs = (await logOf('e', 'navigate')).length;
      const r = await center('#win-e .pe-r');
      await click(r.x, r.y);
      const back = await waitFor(async () => (await logOf('e', 'navigate')).length > navs && host.eval(`${P('e')}.getTitle() === 'plain target' && !document.querySelector('#win-e .perr').classList.contains('on')`), 10000);
      ok('try again brings the crashed page back', back, `navigate events ${navs} -> ${(await logOf('e', 'navigate')).length}`);
    }
    // Disposed while its page is being read (the app let the window go right after it loaded): no warning either.
    {
      const gbusy = await guest((u) => u === `${FIX}/plain-target`);
      await gbusy.eval('setTimeout(() => { const end = Date.now() + 2500; while (Date.now() < end) {} }, 0), true');
      gbusy.close();
    }
    const warnsBefore = consoleErrors.length;
    await host.eval(`window.__aboutRead = ${P('e')}.about(0); true`);
    await sleep(200);
    await host.eval(`${P('e')}.dispose()`);
    const aboutAnswer = await host.eval('window.__aboutRead');
    await sleep(1500);
    const lateWarns = consoleErrors.slice(warnsBefore);
    ok('a page disposed while it is being read leaves no warning, and the read answers empty', aboutAnswer === '' && lateWarns.length === 0, JSON.stringify({ aboutAnswer, lateWarns }));
    const gone = await waitFor(async () => !(await list()).some((x) => x.type === 'webview' && x.url === `${FIX}/plain-target`), 5000);
    ok('dispose() removes the address line, the view and the guest', gone && (await host.eval(`document.querySelector('#win-e .pgc').children.length`)) === 0);
    await host.eval(`window.__add({ id: 'f', url: 'file:///etc/hostname' })`);
    const f = await host.eval(`(() => { const w = document.querySelector('#win-f'); return { webview: !!w.querySelector('webview'), text: w.querySelector('.pnew.on') && w.querySelector('.pnew.on').textContent, ad: w.querySelector('.ad').value, reload: w.querySelector('[data-nav=reload]').classList.contains('off') }; })()`);
    ok('a page saved with an address flow cannot open says so and makes no webview', !f.webview && f.text === 'flow cannot open this kind of address' && f.ad === 'file:///etc/hostname' && f.reload, JSON.stringify(f));
    await host.eval(`${P('f')}.navigate(${JSON.stringify(`${FIX}/plain-target`)})`);
    await waitFor(() => host.eval(`${P('f')}.getTitle() === 'plain target'`), 10000);
    ok('a web address typed there loads', (await host.eval(`${P('f')}.getTitle()`)) === 'plain target');
    await host.eval(`${P('f')}.dispose()`);
  }

  {
    const stray = await host.eval(`window.__log.filter((e) => e.ev === 'redirect' && e.page !== 'r' && e.page !== 'r2').map((e) => e.page + ' ' + e.from + ' -> ' + e.to)`);
    ok('no other navigation to a fixture page in this run was reported as a redirect', stray.every((x) => !x.includes(FIX)), stray.join(' | '));
  }
  await shot('07-final');
  const errs = consoleErrors.filter((m) => !m.startsWith('warning:'));
  const warns = consoleErrors.filter((m) => m.startsWith('warning:')).map((m) => m.replace(/\s+/g, ' ').slice(0, 160));
  ok('no console errors in the host page', errs.length === 0, errs.join(' | '));
  if (warns.length) console.log(`     console warnings: ${warns.join(' | ')}`);
} catch (e) {
  failures++;
  console.log(`FAIL the run stopped: ${e.stack || e}`);
  await shot('99-stopped').catch((err) => console.log(`     screenshot failed too: ${err.message}`));
} finally {
  host.close();
  if (main) main.close();
  server.close();
  xserver.close();
  authServer.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);




