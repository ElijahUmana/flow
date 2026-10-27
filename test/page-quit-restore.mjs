/* A page's place across quits that come early (MAC_NOTES 31), on the real backend with test/page-harness.html: four
   pages, each in its own page window, are scrolled and Flow quits the way ⌘Q does, after every page reads its place
   as the app's quit does (flushHistory). Then Flow starts again and quits once every page is
   back at its place; starts again and quits 3 s after the pages show, while one page (its text arrives 10 s late) is
   still loading and another has just been moved on by the owner; and starts a last time: every page must be where it
   was left, the slow one included. It starts and stops the app itself, four times, and wipes /tmp/flow-dev-page
   first, so no page dev instance may be running. Run from the repo root: node test/page-quit-restore.mjs */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9564;
const MARKER = '--flow-dev=page';
const USER_DATA = '/tmp/flow-dev-page';
const SHOTS = process.env.SHOTS || '/tmp/flow-page-shots';
const FIX_PORT = 19604, FIX = `http://127.0.0.1:${FIX_PORT}`;
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`);
  if (!cond) failures++;
  return !!cond;
};
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

const lines = (n, from = 0) => Array.from({ length: n }, (_, i) => `<p>line ${from + i}</p>`).join('');
const HEAD = '<!doctype html><meta charset=utf-8><style>p{margin:0;height:24px;font:16px sans-serif}</style>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  if (req.url === '/long') return res.end(`${HEAD}<title>long</title>${lines(300)}`);
  if (req.url === '/form') return res.end(`${HEAD}<title>form</title><input id=i size=40>${lines(300)}`);
  if (req.url === '/framed') return res.end(`${HEAD}<title>framed</title><iframe src="/inner" width=300 height=120></iframe>${lines(300)}`);
  if (req.url === '/inner') return res.end(`${HEAD}<title>inner</title><p>inner frame</p>`);
  if (req.url === '/slow') {
    // its text arrives 10 s after its head: until then the page has nothing to scroll
    res.write(`${HEAD}<title>slow</title><p>top</p>`);
    const t = setTimeout(() => res.end(lines(300, 1)), 10000);
    req.on('close', () => clearTimeout(t));
    return;
  }
  res.end(`${HEAD}<title>plain</title><p>plain</p>`);
});
await new Promise((r) => server.listen(FIX_PORT, '127.0.0.1', r));

async function waitFor(fn, ms, every = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => null);
    if (last) return last;
    await sleep(every);
  }
  return last;
}
const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`websocket error: ${url}`)); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const d = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (!d.result || d.result.exceptionDetails) throw new Error(`evaluate threw: ${JSON.stringify(d.result && d.result.exceptionDetails).slice(0, 300)}`);
    return d.result.result.value;
  };
  return { ws, send, ev, nextId: () => ++id, close: () => ws.close() };
}

const PAGES = [
  { id: 'pl', path: '/long', y: 2400, box: 'left:10px;top:10px' },
  { id: 'pf', path: '/form', y: 800, box: 'left:540px;top:10px' },
  { id: 'pr', path: '/framed', y: 1200, box: 'left:1070px;top:10px' },
  { id: 'ps', path: '/slow', y: 1600, box: 'left:10px;top:500px' },
];
let app = null;
async function start(label) {
  const log = fs.openSync(path.join(SHOTS, `quit-restore-${label}.log`), 'w');
  app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', 'FLOW_ENTRY=test/page-harness.html', `FLOW_USER_DATA=${USER_DATA}`, 'FLOW_TMUX_SOCKET=flow-dev-page', `FLOW_CDP_PORT=${PORT}`,
    './node_modules/.bin/electron', '.', '--no-sandbox', MARKER], { cwd: ROOT, stdio: ['ignore', log, log] });
  app.exited = new Promise((r) => app.once('exit', (code, signal) => r({ code, signal })));
  const t = await waitFor(async () => (await list()).find((x) => x.type === 'page' && /page-harness/.test(x.url)), 30000, 250);
  if (!t) throw new Error(`${label}: no harness target`);
  const host = await connect(t.webSocketDebuggerUrl);
  await waitFor(() => host.ev('!!window.__ready'), 20000);
  // each page in its own window, on screen (a page off screen takes its place only once it is shown)
  for (const p of PAGES) await host.ev(`window.__add({ id: '${p.id}', url: ${JSON.stringify(FIX + p.path)} }); document.getElementById('win-${p.id}').style.cssText = 'position:fixed;${p.box};width:520px;height:470px;z-index:9'; true`);
  return host;
}
const guest = async (p) => {
  const t = await waitFor(async () => (await list()).find((x) => x.type === 'webview' && x.url === FIX + p.path), 20000);
  if (!t) throw new Error(`no page at ${p.path}`);
  return connect(t.webSocketDebuggerUrl);
};
// The app's quit reads every page first (flushHistory), then ⌘Q (ctrl+Q off macOS) runs main's quit, which saves.
async function quit(host, label) {
  await host.ev('Promise.all(Object.values(window.__pages).map((p) => p.flushHistory())).then(() => true)');
  await sleep(600); // the harness writes its state 50 ms after the last change, main 150 ms after that
  await host.ev('document.activeElement && document.activeElement.blur(), true');
  const mod = process.platform === 'darwin' ? 4 : 2;
  await host.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81, modifiers: mod });
  // the window may be gone before the key-up is answered
  host.ws.send(JSON.stringify({ id: host.nextId(), method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81, modifiers: mod } }));
  const exit = await Promise.race([app.exited, sleep(20000).then(() => null)]);
  host.close();
  ok(`${label}: Flow quits cleanly`, exit && exit.code === 0, JSON.stringify(exit));
}
const where = (g) => g.ev(`({ y: Math.round(scrollY), ready: document.readyState })`);

try {
  // first run: every page at its place
  let host = await start('first');
  for (const p of PAGES) {
    const g = await guest(p);
    await waitFor(() => g.ev(`document.readyState === 'complete' && document.body.scrollHeight > ${p.y + 600}`), 20000);
    await g.ev(`scrollTo(0, ${p.y}), true`);
    g.close();
  }
  await sleep(2000);
  await quit(host, 'first run');
  // second run: back at every place, then a quit
  host = await start('second');
  for (const p of PAGES) {
    const g = await guest(p);
    const back = await waitFor(async () => { const y = await g.ev('scrollY'); return Math.abs(y - p.y) <= 2 && { y }; }, 25000, 250);
    ok(`second run: ${p.path} comes back at its place`, !!back, JSON.stringify({ ...(await where(g)), want: p.y }));
    g.close();
  }
  await sleep(1500);
  await quit(host, 'second run');
  // third run: a quit 3 s after the pages show, the slow page's text not in yet, the long page moved on by the owner
  host = await start('third');
  const gs = await guest(PAGES[3]);
  await sleep(3000);
  const early = await where(gs);
  gs.close();
  ok('third run: the slow page is still loading at the quit, not yet at its place', early.ready !== 'complete' && early.y === 0, JSON.stringify(early));
  const gl = await guest(PAGES[0]);
  await waitFor(async () => Math.abs((await gl.ev('scrollY')) - PAGES[0].y) <= 2, 15000, 250);
  await gl.ev('scrollTo(0, 3000), true');
  await sleep(1200);
  gl.close();
  await quit(host, 'third run');
  // last run: every page where it was left
  host = await start('last');
  for (const p of PAGES) {
    const want = p === PAGES[0] ? 3000 : p.y;
    const g = await guest(p);
    const at = await waitFor(async () => { const y = await g.ev('scrollY'); return Math.abs(y - want) <= 2 && { y }; }, 25000, 250);
    const now = await where(g);
    g.close();
    ok(p === PAGES[0] ? 'last run: the page moved on before an early quit comes back where it was moved to'
      : p === PAGES[3] ? 'last run: the page still loading at an early quit comes back at the place it had before'
        : `last run: ${p.path} comes back at its place after an early quit`, !!at, JSON.stringify({ ...now, want }));
  }
  await quit(host, 'last run');
} catch (e) {
  ok('the run finished', false, e.stack);
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    execFileSync('pkill', ['-f', `[e]lectron/dist/electron .*${MARKER}`]);
    await Promise.race([app.exited, sleep(10000)]);
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




