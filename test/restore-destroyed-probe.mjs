// main.js hardenGuest: a history restore that fails because its page went away (a window closed or the app quit while
// the restored entry was still loading). A webview gets a restored history whose entry answers after 3 s, and is
// removed as soon as it attaches; then the app log is read for an unhandled rejection from that catch.
//   node restore-destroyed-probe.mjs <tree> <log> [rounds] [removed|live]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [tree, LOG, ROUNDS = '3', MODE = 'removed'] = process.argv.slice(2);
const L = await import(path.join(tree, 'test', 'main-cdp-lib.mjs'));
const j = (v) => JSON.stringify(v);
const kill = () => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const server = http.createServer((req, res) => {
  setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>slow</title><p>${req.url}</p>`); }, 3000);
});

try {
  kill();
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), j({ v: 11, ws: [{ id: 'rd', name: 'rd', folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  fs.writeFileSync(LOG, '');
  L.launch(LOG);
  const page = await L.flowPage();
  for (let i = 0; i < Number(ROUNDS); i++) {
    // live: the page stays, and its entry cannot load (nothing listens on port 9)
    const base = MODE === 'live' ? 'http://127.0.0.1:9' : origin;
    const src = `${base}/slow?b${i}`;
    const hist = { index: 1, entries: [{ url: `${base}/slow?a${i}`, title: 'a' }, { url: src, title: 'b' }] };
    const accepted = await page.eval(`return await window.flow.restorePageNext(${j(src)}, ${j(hist)});`);
    await page.eval(`const wv = document.createElement('webview'); wv.src = ${j(src)};
      wv.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px';
      if (${j(MODE)} === 'removed') wv.addEventListener('did-attach', () => wv.remove(), { once: true });
      document.body.appendChild(wv); return true;`);
    await L.sleep(4500);
    console.log(`round ${i}: restore accepted ${accepted}`);
  }
  await L.sleep(1000);
  const log = fs.readFileSync(LOG, 'utf8').split('\n');
  const bad = log.filter((l) => /Object has been destroyed|Unhandled|unhandled/i.test(l));
  const restoreLines = log.filter((l) => /could not restore the history|could not load/.test(l));
  console.log(`unhandled or destroyed lines: ${bad.length}${bad.length ? '\n  ' + bad.slice(0, 4).join('\n  ') : ''}`);
  console.log(`restore warnings: ${restoreLines.length}${restoreLines.length ? '\n  ' + restoreLines.slice(0, 4).join('\n  ') : ''}`);
  page.close();
} finally {
  server.close();
  kill();
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the app to be gone').catch(() => null);
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}




