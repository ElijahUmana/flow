'use strict';
// vmfiles.js behind files-main.js in real Electron: VM rows, the flow-file: scheme serving VM files into a real webview
// (text, PDF, image, html), the Mac's app for other kinds, watching through files-main, and files-main's signed
// addresses for VM files (an address it did not sign, or one altered, never reaches the VM). The VM is a local stand-in: each call runs the exact command line ssh would send, with bash -c, in a home
// folder under /home/claude/.flow-dev/vmfiles. Nothing here uses ssh.
//   xvfb-run -a ./node_modules/.bin/electron test/vmfiles-electron-test.js --no-sandbox

const { app, BrowserWindow, protocol, session, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const ROOT = `/home/claude/.flow-dev/vmfiles/electron-${process.pid}`;
const HOME = path.join(ROOT, 'vm-home');
const PROJ = path.join(HOME, 'proj');
const HOST = 'claude-agents';
app.setPath('userData', '/home/claude/.flow-dev/vmfiles/electron-userData');   // one, reused: Electron writes it after the test ends

const files = require('../src/files-main');
const vmfiles = require('../src/vmfiles');
protocol.registerSchemesAsPrivileged([files.privileges]);

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra === undefined ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// A process's working folder, or '' once it has ended.
const cwdOf = (pid) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return '';
    throw e;
  }
};
// This test's VM-side watch loops: WATCH_SH processes in the stand-in's home (other tests on this machine run the same
// loops elsewhere).
const loops = () => execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
  .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
  .filter((m) => m && m[2].startsWith('sh -c ') && m[2].includes('tick=$1; end=') && m[2].includes(' 600 ') && cwdOf(m[1]) === HOME).length;

let sshCalls = 0;
function standIn(host, argv, { stdin } = {}) {
  sshCalls++;
  return spawn('/bin/bash', ['-c', argv.map(shq).join(' ')], {
    cwd: HOME, env: { HOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

function minimalPdf(text) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 36 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function load(win, url, waitMs = 2000) {
  await win.webContents.executeJavaScript(`new Promise((res) => { const wv = document.querySelector('webview'); wv.addEventListener('did-stop-loading', () => res(), { once: true }); wv.src = ${JSON.stringify(url)}; })`);
  await sleep(waitMs);
  return win.webContents.executeJavaScript(`(() => { const wv = document.querySelector('webview'); return wv.executeJavaScript('({ title: document.title, text: document.body ? document.body.innerText.slice(0, 400) : "", type: document.contentType, img: document.images.length ? document.images[0].naturalWidth : 0 })').then((r) => ({ ...r, url: wv.getURL(), shownTitle: wv.getTitle() }), (e) => ({ err: String(e), url: wv.getURL(), shownTitle: wv.getTitle() })); })()`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'README.md'), '# on the VM\n\nsome <b>text</b> & more\n');
  fs.writeFileSync(path.join(PROJ, 'paper.pdf'), minimalPdf('vm files test'));
  fs.writeFileSync(path.join(PROJ, 'pic.png'), nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 200), { width: 8, height: 8 }).toPNG());
  fs.writeFileSync(path.join(PROJ, 'page.html'), '<!doctype html><title>made on the vm</title><body><p id=p>static</p><script>document.getElementById("p").textContent = "script ran"; fetch("https://example.com/").then(() => { document.title = "fetched"; }, () => { document.title += " no-fetch"; });</script>');
  fs.writeFileSync(path.join(PROJ, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 7]));
  fs.writeFileSync(path.join(PROJ, 'été ü #1.txt'), 'unicode name\n');
  fs.writeFileSync(path.join(PROJ, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(HOME, 'elsewhere.md'), '# outside the workspace folder\n');
  fs.mkdirSync(path.join(PROJ, 'img'));
  fs.mkdirSync(path.join(PROJ, 'notes'));
  fs.writeFileSync(path.join(PROJ, 'img', 'dot.png'), nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 120), { width: 8, height: 8 }).toPNG());
  fs.writeFileSync(path.join(PROJ, 'notes', 'plan.md'), '# Plan\n\n![a dot](../img/dot.png)\n\nsee [the readme](../README.md)\n\n[outside](../../elsewhere.md) and [hidden](../.env)\n');

  const opened = [];
  vmfiles.init({ spawn: standIn, files, cacheDir: path.join(ROOT, 'cache'), openPath: async (f) => { opened.push(f); return ''; }, tick: 1, debounceMs: 10 });
  const doc = { ws: [{ id: 'a', folder: path.join(ROOT, 'mac-folder'), host: HOST, hostFolder: '~/proj' }] };
  files.init({ store: { load: () => doc }, home: path.join(ROOT, 'mac-home'), vm: vmfiles });

  // ---- rows ----
  const r = await files.list(HOST, '~/proj');
  check('files.list hands a VM folder to vmfiles: rows as on the Mac (no dot names, folders first)',
    r.ok && JSON.stringify(r.entries.map((e) => `${e.kind[0]}:${e.name}`)) === JSON.stringify(['d:img', 'd:notes', 'd:src', 'f:blob.bin', 'f:été ü #1.txt', 'f:page.html', 'f:paper.pdf', 'f:pic.png', 'f:README.md']) && r.total === 9,
    r.entries && r.entries.map((e) => e.name));

  // ---- watching through files-main ----
  const sender = Object.assign(new EventEmitter(), { id: 41, sent: [], isDestroyed: () => false, send(ch, d) { this.sent.push([ch, d]); } });
  files.watch(sender, [{ host: HOST, dir: '~/proj' }]);
  await sleep(1500);
  const calls0 = sshCalls;
  const cached = await files.list(HOST, '~/proj');
  check('a watched VM folder lists from the loop with no new ssh call', cached.ok && sshCalls === calls0);
  fs.writeFileSync(path.join(PROJ, 'new.md'), 'new\n');
  let told = null;
  for (let i = 0; i < 40 && !told; i++) {
    await sleep(100);
    told = sender.sent.find(([ch, d]) => ch === 'files:changed' && d.host === HOST && d.dir === '~/proj');
  }
  check('a new file on the VM reaches the window as files:changed', !!told, sender.sent);
  check('and the next list shows it', (await files.list(HOST, '~/proj')).entries.some((e) => e.name === 'new.md'));
  const running = loops();
  sender.emit('destroyed');
  await sleep(1500);
  check('a closed window ends the loop on the VM', running === 1 && loops() === 0, `${running} loops before, ${loops()} after`);

  // ---- opening ----
  let o = await files.open(HOST, '~/proj/README.md');
  check('files.open of a VM text file gives a signed flow-file://vm/<signature>/<host>/ address',
    /^flow-file:\/\/vm\/[A-Za-z0-9_-]{22}\/claude-agents\/home\//.test(o.url || ''), o);
  o = await files.open(HOST, '~/proj/blob.bin');
  check('a kind Flow does not show opens in the Mac\'s app from a read-only copy', o.app === true && opened.length === 1 &&
    (fs.statSync(opened[0]).mode & 0o777) === 0o400 && fs.readFileSync(opened[0]).equals(fs.readFileSync(path.join(PROJ, 'blob.bin'))), o);

  // ---- the scheme in a real webview ----
  const ses = session.fromPartition('persist:vmfiles-test');
  files.serveOn(ses);
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { webviewTag: true, contextIsolation: true } });
  await win.loadURL(`data:text/html,${encodeURIComponent('<!doctype html><body style="margin:0"><webview partition="persist:vmfiles-test" style="width:1000px;height:700px"></webview></body>')}`);
  const U = async (p) => (await files.open(HOST, p)).url;

  let p = await load(win, await U('~/proj/README.md'));
  check('a VM markdown file shows rendered, titled with its name', p.title === 'README.md' && p.text.includes('on the VM') && p.text.includes('some text & more') && !p.text.includes('# on the VM'), p);
  p = await load(win, await U(path.join(PROJ, 'notes', 'plan.md')), 2500);
  const refs = await win.webContents.executeJavaScript(`document.querySelector('webview').executeJavaScript('({ img: document.images[0] && document.images[0].getAttribute("src"), w: document.images[0] && document.images[0].naturalWidth, a: [...document.querySelectorAll("a")].map((x) => x.getAttribute("href")), text: document.body.innerText })')`);
  const enc = (q) => q.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const vmAddr = (q) => (u) => typeof u === 'string' && /^flow-file:\/\/vm\/[A-Za-z0-9_-]{22}\//.test(u) && u.endsWith(`/${HOST}/${enc(q)}`);
  check("a VM .md's relative image and link resolve on the VM from the file's own folder, as signed VM addresses",
    vmAddr(path.join(PROJ, 'img', 'dot.png'))(refs.img) && refs.w === 8 && refs.a.length === 1 && vmAddr(path.join(PROJ, 'README.md'))(refs.a[0]), refs);
  check('a link out of the workspace VM folder, or to a hidden name, stays text', refs.a.length === 1 && refs.text.includes('outside') && refs.text.includes('hidden'), refs);
  p = await load(win, files.vmUrlOf(HOST, path.join(HOME, 'elsewhere.md')));
  check('a signed address outside the workspace VM folder is refused by vmfiles', p.text.includes('not in a workspace folder'), p);
  p = await load(win, await U(path.join(PROJ, 'été ü #1.txt')));
  check('a name with spaces, accents and # shows', p.title === 'été ü #1.txt' && p.text.includes('unicode name'), p);
  p = await load(win, await U('~/proj/paper.pdf'), 3500);
  check('a VM pdf opens in the pdf viewer, titled with its name', p.type === 'application/pdf' && p.shownTitle === 'paper.pdf', p);
  fs.mkdirSync('/home/claude/flow-evidence/vmfiles', { recursive: true });
  fs.writeFileSync('/home/claude/flow-evidence/vmfiles/vm-pdf-shot.png', (await win.webContents.capturePage()).toPNG());
  p = await load(win, await U('~/proj/pic.png'));
  check('a VM image shows', p.type === 'image/png' && p.img === 8, p);
  p = await load(win, await U('~/proj/page.html'), 2500);
  check('a VM html file runs its inline script and cannot fetch', p.text.includes('script ran') && p.title === 'made on the vm no-fetch', p);
  fs.appendFileSync(path.join(PROJ, 'README.md'), 'a line the agent wrote\n');
  p = await load(win, await U('~/proj/README.md'));
  check('loading it again shows what changed on the VM', p.text.includes('a line the agent wrote'), p);
  p = await load(win, files.vmUrlOf(HOST, path.join(PROJ, 'blob.bin')));
  check('a binary VM file is not shown', p.text.includes('flow does not show this kind of file'), p);
  p = await load(win, files.vmUrlOf(HOST, path.join(PROJ, 'gone.md')));
  check('a VM file that is not there says so', p.text.includes('not there'), p);

  // ---- only addresses Flow signed reach the VM ----
  const F = `flow-file://vm/${HOST}${PROJ}/README.md`;   // what a page could make up: no signature
  const signed = files.vmUrlOf(HOST, path.join(PROJ, 'README.md'));
  const sig = new URL(signed).pathname.split('/')[1];
  const before0 = sshCalls;
  p = await load(win, `flow-file://vm/${sig}/${HOST}${PROJ}/paper.pdf`);
  check('a signed address altered to name another file is refused', p.text.includes('refused') && !p.text.includes('vm files test'), p);
  p = await load(win, `flow-file://vm/${sig}/other-host${PROJ}/README.md`);
  check('a signed address altered to name another host is refused', p.text.includes('refused'), p);
  p = await load(win, F);
  check('an unsigned address is refused', p.text.includes('refused') && !p.text.includes('on the VM'), p);
  check('none of them reached the VM', sshCalls === before0, `${sshCalls - before0} ssh calls`);
  const evil = `<!doctype html><title>evil</title><iframe src="${F}"></iframe><script>setTimeout(() => { fetch(${JSON.stringify(F)}).then((r) => r.text()).then(() => { document.title += ' read'; }, () => { document.title += ' no-read'; }); }, 300);</script>`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/evil') { res.setHeader('content-type', 'text/html'); res.end(evil); return; }
    if (req.url === '/go') { res.setHeader('content-type', 'text/html'); res.end(`<script>location = ${JSON.stringify(F)}</script>`); return; }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const before = sshCalls;
  p = await load(win, `${base}/evil`, 1500);
  check('a web page cannot frame or fetch a VM file', p.title === 'evil no-read', p);
  p = await load(win, `${base}/go`, 1500);
  check('a web page that sends itself to an address it made up gets "refused", not the file', p.text.includes('refused') && !p.text.includes('on the VM'), p);
  check('and neither reached the VM', sshCalls === before, `${sshCalls - before} ssh calls`);
  srv.close();

  vmfiles.shutdown();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'all ok');
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(2);
});




