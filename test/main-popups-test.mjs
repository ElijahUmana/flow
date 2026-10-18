// Item 72: a page opens a page, a window or another app only from the owner's own action (a click, key or tap in it,
// within 5 s, once per action), as a browser's popup blocker allows. In the real app, with input sent into the page
// through its own CDP target (main sees it on its way in, as an owner's click):
//   - window.open on load and twice from timers, no input: nothing opens, and main logs the drop once;
//   - a click on a button that calls window.open: one page opens in the window;
//   - a click on a button that opens a sign-in popup (window.open with features): a popup window opens;
//   - a click whose handler calls window.open twice: one page opens;
//   - a ctrl-click on a link: one page opens;
//   - a click on a button in a frame of another site (a sign-in button on a page): one page opens;
//   - a click, then window.open from a timer 6 s later: nothing opens.
//   node test/main-popups-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-popups-${Date.now()}.log`);
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const kill = (sig) => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const button = (id, onclick) => `<button id="${id}" style="display:block;width:300px;height:40px;margin:4px" onclick="${onclick}">${id}</button>`;
const PAGE = (origin) => '<!doctype html><title>opener</title><body style="margin:0">' +
  button('one', `window.open('${origin}/t/one')`) +
  button('popup', `window.open('${origin}/t/popup', 'signin', 'width=400,height=300')`) +
  button('two', `window.open('${origin}/t/two-a'); window.open('${origin}/t/two-b')`) +
  button('late', `setTimeout(() => window.open('${origin}/t/late'), 6000)`) +
  `<a id="link" href="${origin}/t/link" style="display:block;width:300px;height:40px;margin:4px">link</a>` +
  `<iframe id="frame" src="${origin.replace('127.0.0.1', 'localhost')}/framebtn" style="display:block;width:320px;height:60px;border:0;margin:4px"></iframe></body>`;
const NOCLICK = (origin) => `<!doctype html><title>noclick</title><script>window.open('${origin}/t/n1');
  setTimeout(() => window.open('${origin}/t/n2'), 300); setTimeout(() => window.open('${origin}/t/n3'), 900);</script>`;
let origin;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url.startsWith('/opener')) res.end(PAGE(origin));
  else if (req.url === '/noclick') res.end(NOCLICK(origin));
  else if (req.url === '/framebtn') res.end(`<!doctype html><body style="margin:0"><button id="fb" style="width:300px;height:40px" onclick="window.open('${origin}/t/frame')">frame</button>`);
  else res.end(`<!doctype html><title>${req.url}</title><p>${req.url}`);
});

try {
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), j({ v: 11, ws: [{ id: 'p', name: 'p', folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [], saved: [] }], ui: {} }));
  console.log(`app log: ${LOG}`);
  L.launch(LOG);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  await page.eval('window.__nw = []; window.flow.onPageNewWindow((x) => window.__nw.push(x.url)); return true;');
  const opened = () => page.eval('return window.__nw.slice();');
  const popups = () => mainp.eval(`return require('electron').BrowserWindow.getAllWindows().filter((w) => !/index\\.html/.test(w.webContents.getURL())).length;`, { commandLine: true });
  const open = async (url) => {
    await page.eval(`window.__flow.openPage(${j(url)}); return true;`);
    const t = await L.waitFor(async () => (await L.targets(L.PORT)).find((x) => x.type === 'webview' && x.url === url), 20000, url);
    const g = await L.Cdp.connect(t.webSocketDebuggerUrl);
    await L.waitFor(() => g.eval(`return location.href === ${j(url)} && document.readyState === 'complete';`), 20000, `${url} loaded`);
    return g;
  };
  const logAt = fs.statSync(LOG).size;

  // no input at all
  const gn = await open(`${origin}/noclick`);
  await L.sleep(2500);
  const none = await opened();
  const dropLines = fs.readFileSync(LOG, 'utf8').slice(logAt).split('\n').filter((l) => l.includes('with no click or key from the owner'));
  check('window.open on load and from timers, no input: nothing opens, and main logs the drop once', none.length === 0 && (await popups()) === 0 && dropLines.length === 1,
    j({ opened: none, dropLines }));
  gn.close();

  // each case clicks in an opener page of its own (a page that opened one shows that one in front)
  const click = async (id, modifiers = 0) => {
    const g = await open(`${origin}/opener?${id}`);
    await L.sleep(1200);
    const r = await g.eval(`const r = document.getElementById(${j(id)}).getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 };`);
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    for (const type of ['mousePressed', 'mouseReleased']) await g.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers });
    g.close();
  };
  const after = async (fn, ms = 2500) => { const before = (await opened()).length; await fn(); await L.sleep(ms); return (await opened()).slice(before); };

  const one = await after(() => click('one'));
  check('a click on a button that calls window.open: one page opens', j(one) === j([`${origin}/t/one`]), j(one));
  const popupsBefore = await popups();
  await click('popup');
  const popupWin = await L.waitFor(async () => ((await popups()) > popupsBefore ? true : null), 8000, 'the popup').catch(() => false);
  check('a click on a button that opens a sign-in popup: a popup window opens', popupWin === true, `popups ${await popups()}`);
  await mainp.eval(`for (const w of require('electron').BrowserWindow.getAllWindows()) if (!/index\\.html/.test(w.webContents.getURL())) w.destroy(); return true;`, { commandLine: true });
  const two = await after(() => click('two'));
  check('a click whose handler calls window.open twice: one page opens', j(two) === j([`${origin}/t/two-a`]), j(two));
  const link = await after(() => click('link', 2));
  check('a ctrl-click on a link: one page opens', j(link) === j([`${origin}/t/link`]), j(link));
  const frame = await after(() => click('frame'));
  check('a click on a button in a frame of another site: one page opens', j(frame) === j([`${origin}/t/frame`]), j(frame));
  const lateAt = fs.statSync(LOG).size;
  const late = await after(() => click('late'), 8000);
  const lateDropped = fs.readFileSync(LOG, 'utf8').slice(lateAt).includes(`dropped ${origin}/t/late`);
  check('a click, then window.open from a timer 6 s later: nothing opens, and main logs the drop', late.length === 0 && lateDropped, j({ late, lateDropped }));
  page.close();
  mainp.close();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  server.close();
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the app to be gone').catch(() => null);
  try { fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch (e) { console.log(`cleanup: ${e.message}`); }
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




