// Item 73: a site's own sign-in (HTTP basic auth) on a page is asked in the page's window, through the real preload
// (flow.onPageLogin, flow.answerPageLogin), with local servers behind basic auth:
//   - the first ask names the site (host:port) with again false; a wrong password asks again with again true; the right
//     one signs in and the page shows; neither the name nor the password is ever in the app log;
//   - an answer of null (the owner cancels) shows the site's own 401 page;
//   - a page that goes elsewhere while asked drops the ask: the old ask answers nothing and the new page shows;
//   - a sign-in inside a frame of the page reaches main as a frame's and is not asked;
//   - an answer to an ask that is not open is refused and logged.
//   node test/main-login-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-login-${Date.now()}.log`);
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const kill = (sig) => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const USER = 'owner-73';
const PASSWORD = 'pa55-word-73x';
const WRONG = 'n0t-the-pa55-73';
// one server per case, so Chromium's memory of a sign-in for a site never carries over from one case to the next
const servers = [];
function guarded(frameTo) {
  const server = http.createServer((req, res) => {
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>plain</title><p>plain page');
      return;
    }
    if (req.url === '/framed') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>framed</title><p>outer page</p><iframe src="${frameTo}/secret"></iframe>`);
      return;
    }
    const auth = req.headers.authorization || '';
    const [user, password] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
    if (user === USER && password === PASSWORD) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>inside</title><p>signed in');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="the router"' });
    res.end('<!doctype html><title>401</title><p>the site says no');
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
}

try {
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  const [a, b, c, d] = [await guarded(), await guarded(), await guarded(), await guarded()];
  const outer = await guarded(d.replace('127.0.0.1', 'localhost'));
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), j({ v: 11, ws: [{ id: 'l', name: 'l', folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [], saved: [] }], ui: {} }));
  console.log(`app log: ${LOG}`);
  L.launch(LOG);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  // what main itself is told: each sign-in a page meets, main frame or not
  await mainp.eval(`const { app } = require('electron'); globalThis.__met = [];
    app.on('web-contents-created', (_e, wc) => wc.on('login', (_ev, d, info) => globalThis.__met.push({ main: d.isMainFrame, first: d.firstAuthAttempt, proxy: info.isProxy })));
    return true;`, { commandLine: true });
  const met = () => mainp.eval('return globalThis.__met.slice();', { commandLine: true });
  await page.eval('window.__asks = []; window.flow.onPageLogin((x) => window.__asks.push(x)); return true;');
  const asks = () => page.eval('return window.__asks.slice();');
  const answer = (requestId, ans) => page.eval(`window.flow.answerPageLogin(${j(requestId)}, ${j(ans)}); return true;`);
  const guestTitle = async (url) => {
    const t = (await L.targets(L.PORT)).find((x) => x.type === 'webview' && x.url.startsWith(url));
    if (!t) return null;
    const g = await L.Cdp.connect(t.webSocketDebuggerUrl);
    try {
      return await g.eval('return document.readyState === "complete" ? document.title : null;');
    } finally {
      g.close();
    }
  };

  // the right name after a wrong one
  await page.eval(`window.__flow.openPage(${j(`${a}/secret`)}); return true;`);
  const first = await L.waitFor(async () => (await asks())[0], 20000, 'the first ask');
  await answer(first.requestId, { user: USER, password: WRONG });
  const second = await L.waitFor(async () => (await asks())[1], 20000, 'the ask again');
  await answer(second.requestId, { user: USER, password: PASSWORD });
  const inside = await L.waitFor(() => guestTitle(a), 20000, 'the page signed in').catch(() => null);
  check('the first ask names the site, a wrong password asks again, the right one signs in',
    first.host === a.replace('http://', '') && first.again === false && typeof first.guestId === 'number' && second.again === true &&
    second.guestId === first.guestId && inside === 'inside', j({ first, second, inside }));

  // the owner cancels
  await page.eval(`window.__flow.openPage(${j(`${b}/secret`)}); return true;`);
  const third = await L.waitFor(async () => (await asks())[2], 20000, 'the ask on b');
  await answer(third.requestId, null);
  const own = await L.waitFor(() => guestTitle(b), 20000, "the site's own page").catch(() => null);
  await L.sleep(500);
  check("a cancelled ask shows the site's own 401 page, and asks nothing more", own === '401' && (await asks()).length === 3, j({ own, asks: (await asks()).length }));

  // the page goes elsewhere while asked
  await page.eval(`window.__flow.openPage(${j(`${c}/secret`)}); return true;`);
  const fourth = await L.waitFor(async () => (await asks())[3], 20000, 'the ask on c');
  await page.eval(`const w = [...document.querySelectorAll('webview')].find((x) => x.getWebContentsId() === ${fourth.guestId}); w.loadURL(${j(`${c}/plain`)}); return true;`);
  const moved = await L.waitFor(() => guestTitle(`${c}/plain`), 20000, 'the page elsewhere').catch(() => null);
  await answer(fourth.requestId, { user: USER, password: PASSWORD });
  await L.sleep(800);
  const logText = fs.readFileSync(LOG, 'utf8');
  check('a page that goes elsewhere while asked drops the ask: answering it then is refused and logged, the new page shows',
    moved === 'plain' && logText.includes(`answerPageLogin: no open sign-in ${fourth.requestId} for this window`), j({ moved }));

  // a frame's sign-in
  const before = (await asks()).length;
  const metBefore = (await met()).length;
  await page.eval(`window.__flow.openPage(${j(`${outer}/framed`)}); return true;`);
  const framed = await L.waitFor(() => guestTitle(`${outer}/framed`), 20000, 'the framed page').catch(() => null);
  await L.sleep(2000);
  const frameMet = (await met()).slice(metBefore);
  check("a sign-in inside a frame of the page reaches main as a frame's and is not asked",
    framed === 'framed' && frameMet.length >= 1 && frameMet.every((m) => m.main === false) && (await asks()).length === before,
    j({ framed, asks: (await asks()).length - before, frameMet }));
  const all3 = (await met()).slice(0, metBefore);
  check('the main-frame sign-ins reached main as main-frame ones (first, then again)', all3.length >= 4 && all3.every((m) => m.main === true && m.proxy === false) &&
    all3[0].first === true && all3[1].first === false, j(all3));

  const all = fs.readFileSync(LOG, 'utf8');
  // the log is this run's: it holds the refusal logged above
  check('neither the name nor the password is in the app log', all.includes(`answerPageLogin: no open sign-in ${fourth.requestId}`) &&
    !all.includes(PASSWORD) && !all.includes(USER) && !all.includes(WRONG), `${all.length} bytes of log`);
  page.close();
  mainp.close();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  for (const s of servers) s.close();
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'gone').catch(() => null);
  try { fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch (e) { console.log(`cleanup: ${e.message}`); }
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




