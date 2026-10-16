// Item 63: a page's download lands in its workspace's downloads however its tab ends. In the real app, a 2 s download
// (three chunks, 0.9 s apart) started from a page (main's guest.downloadURL, as Save Image does):
//   - with the tab kept, the file is in the workspace's downloads once it is done;
//   - with the tab closed (the window's close-window action) right after it starts, the same;
//   - with the pop-out that shows the page closed right after it starts, the main window puts it in that workspace.
//   node test/main-downloads-test.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-downloads-${Date.now()}.log`);
const STATE = path.join(L.USER_DATA, 'flow-state.json');
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const kill = (sig) => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const wsOf = (id) => ({ id, name: id, folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [], saved: [] });
const CHUNK = 65536;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/slow.bin')) {
    const name = new URL(req.url, 'http://x').searchParams.get('name') || 'slow';
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}.bin"`, 'content-length': 3 * CHUNK });
    let n = 0;
    const tick = () => { res.write(Buffer.alloc(CHUNK, 1)); if (++n < 3) setTimeout(tick, 900); else res.end(); };
    tick();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>dl</title><p>a page</p>');
});
const downloadsOf = (page, wsId) => page.eval(`return (window.__flow.state().ws.find((w) => w.id === ${j(wsId)}).downloads || []).map((d) => d.file);`);
const guestIdOf = (mainp, url, host = '') => mainp.eval(`return require('electron').webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.getURL() === ${j(url)} &&
  w.hostWebContents.getURL().includes(${j(host)}))?.id ?? null;`, { commandLine: true });
const download = (mainp, guestId, url) => mainp.eval(`require('electron').webContents.fromId(${guestId}).downloadURL(${j(url)}); return true;`, { commandLine: true });
const fileDone = (name) => { const f = path.join(L.USER_DATA, 'Downloads', `${name}.bin`); return fs.existsSync(f) && fs.statSync(f).size === 3 * CHUNK ? f : null; };

// opens a page in the workspace the main window shows; its guest's webContents id once main has it at that address
async function openPageIn(page, mainp, url) {
  await page.eval(`window.__flow.openPage(${j(url)}); return true;`);
  return L.waitFor(() => guestIdOf(mainp, url), 20000, `the page ${url}`);
}

try {
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(STATE, j({ v: 11, ws: [wsOf('dl'), wsOf('two')], ui: { at: 'dl' } }));
  console.log(`app log: ${LOG}`);
  L.launch(LOG);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  await L.sleep(1000);

  // the tab kept
  const ga = await openPageIn(page, mainp, `${origin}/a`);
  await L.sleep(800);
  await download(mainp, ga, `${origin}/slow.bin?name=kept`);
  const kept = await L.waitFor(() => fileDone('kept'), 15000, 'the kept download').catch(() => null);
  const keptListed = await L.waitFor(async () => ((await downloadsOf(page, 'dl')).includes(kept) ? true : null), 5000, 'the kept download listed').catch(() => false);
  check('with its tab kept, a finished download is in its workspace\'s downloads', !!kept && keptListed, j(await downloadsOf(page, 'dl')));

  // the tab closed right after the download starts
  const gb = await openPageIn(page, mainp, `${origin}/b`);
  await L.sleep(800);
  await download(mainp, gb, `${origin}/slow.bin?name=tabclosed`);
  await L.sleep(300);
  await page.eval("window.__flow.menu('close-window'); return true;");
  const tabGone = await L.waitFor(() => mainp.eval(`const w = require('electron').webContents.fromId(${gb}); return !w || w.isDestroyed();`, { commandLine: true }), 5000, 'the tab closed').catch(() => false);
  const tabFile = await L.waitFor(() => fileDone('tabclosed'), 15000, 'the download whose tab closed').catch(() => null);
  const tabListed = await L.waitFor(async () => ((await downloadsOf(page, 'dl')).includes(tabFile) ? true : null), 5000, 'it listed').catch(() => false);
  check('with its tab closed before it finished, the download is still in its workspace\'s downloads', tabGone && !!tabFile && tabListed,
    j({ tabGone, file: tabFile, downloads: await downloadsOf(page, 'dl') }));

  // the pop-out that shows the page closed right after the download starts
  await page.eval("window.__flow.go(1); return true;");
  await L.waitFor(async () => (await page.eval('return window.__flow.state().ui.at;')) === 'two' || null, 5000, 'the main window on two');
  await openPageIn(page, mainp, `${origin}/c`);
  await L.sleep(1000);
  await page.eval("window.__flow.go(0); return true;");
  await L.sleep(800);
  await page.eval("window.flow.openWindow('solo=two'); return true;");
  await L.flowPage((t) => t.type === 'page' && t.url.includes('#solo=two'));
  const gc = await L.waitFor(() => guestIdOf(mainp, `${origin}/c`, '#solo=two'), 20000, 'the page in the pop-out');
  await L.sleep(800);
  await download(mainp, gc, `${origin}/slow.bin?name=popclosed`);
  await L.sleep(300);
  await mainp.eval(`require('electron').BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#solo=two')).close(); return true;`, { commandLine: true });
  const popGone = await L.waitFor(() => mainp.eval(`return !require('electron').BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('#solo='));`, { commandLine: true }), 5000, 'the pop-out closed').catch(() => false);
  const popFile = await L.waitFor(() => fileDone('popclosed'), 15000, 'the download whose pop-out closed').catch(() => null);
  const popListed = await L.waitFor(async () => ((await downloadsOf(page, 'two')).includes(popFile) ? true : null), 5000, 'it listed').catch(() => false);
  check('with the pop-out that showed its page closed before it finished, the main window puts it in that workspace\'s downloads', popGone && !!popFile && popListed,
    j({ popGone, file: popFile, downloads: await downloadsOf(page, 'two') }));
  page.close();
  mainp.close();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  server.close();
  kill('SIGKILL');
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the app to be gone').catch(() => null);
  try {
    fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  } catch (e) {
    console.log(`cleanup: ${e.message}`);
  }
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




