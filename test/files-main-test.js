'use strict';
// files-main.js under real Electron, on real folders under ~/.flow-dev/files/main-test:
//   xvfb-run -a ./node_modules/.bin/electron test/files-main-test.js --no-sandbox
// FILES_MAIN=<path> tests another copy of files-main.js (a version prepared outside src/).
// Prints ok/FAIL per check and exits non-zero on any failure.

const { app, BrowserWindow, protocol, session, webContents } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'flow-files-main-')));
const FILES_MAIN = process.env.FILES_MAIN || require.resolve('../src/files-main');
const files = require(FILES_MAIN);
protocol.registerSchemesAsPrivileged([files.privileges]);

const ROOT = path.join(os.homedir(), '.flow-dev', 'files', 'main-test');
const PROJ = path.join(ROOT, 'proj a');
const DL = path.join(ROOT, 'downloads');
const OUTSIDE = path.join(ROOT, 'outside');
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function build() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of [PROJ, DL, OUTSIDE, path.join(PROJ, 'src'), path.join(PROJ, 'Docs'), path.join(PROJ, '.git'), path.join(PROJ, 'big'), path.join(PROJ, 'Thing.app')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'README.md'), '# proj a\n\nsome <b>text</b> & more\n');
  fs.writeFileSync(path.join(PROJ, 'notes 10.txt'), 'ten\n');
  fs.writeFileSync(path.join(PROJ, 'notes 9.txt'), 'nine\n');
  fs.writeFileSync(path.join(PROJ, 'run.sh'), '#!/bin/sh\necho hi\n');
  fs.writeFileSync(path.join(PROJ, 'main.ts'), 'export const x: number = 1;\n');
  fs.writeFileSync(path.join(PROJ, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 7]));
  fs.writeFileSync(path.join(PROJ, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(PROJ, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(PROJ, 'paper.pdf'), minimalPdf('flow files test'));
  fs.writeFileSync(path.join(PROJ, 'page.html'), '<!doctype html><title>made here</title><body><p id=p>static</p><script>document.getElementById("p").textContent = "script ran"; fetch("https://example.com/").then(() => { document.title = "fetched"; }, () => { document.title += " no-fetch"; });</script>');
  fs.writeFileSync(path.join(PROJ, 'secret.js'), 'window.SECRET = "leaked";\n');
  fs.writeFileSync(path.join(PROJ, 'Docs', 'nometa.html'), '<!doctype html><title>no charset</title><p>›_ ✎ ◫</p>');
  fs.writeFileSync(path.join(PROJ, 'Docs', 'utf8meta.html'), '<!doctype html><meta charset="utf-8"><title>utf-8</title><p>›_ ✎ ◫</p>');
  fs.writeFileSync(path.join(PROJ, 'Docs', 'legacy.html'), Buffer.concat([Buffer.from('<!doctype html><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>legacy</title><p>price '), Buffer.from([0x80]), Buffer.from('5</p>')]));
  fs.writeFileSync(path.join(PROJ, 'été ü #1.txt'), 'unicode name\n');
  fs.writeFileSync(path.join(OUTSIDE, 'other.txt'), 'outside\n');
  fs.symlinkSync(path.join(PROJ, 'src'), path.join(PROJ, 'src-link'));
  fs.symlinkSync(path.join(PROJ, 'nothing-here'), path.join(PROJ, 'dangling'));
  for (let i = 0; i < 6000; i++) fs.writeFileSync(path.join(PROJ, 'big', `f${i}.txt`), '');
  fs.writeFileSync(path.join(DL, 'report.pdf'), minimalPdf('downloaded'));
}

const sender = (id) => Object.assign(new EventEmitter(), { id, sent: [], isDestroyed: () => false, send(ch, d) { this.sent.push([ch, d]); } });

async function load(win, url, waitMs = 2500) {
  await win.webContents.executeJavaScript(`new Promise((res) => { const wv = document.querySelector('webview'); wv.addEventListener('did-stop-loading', () => res(), { once: true }); wv.src = ${JSON.stringify(url)}; })`);
  await sleep(waitMs);
  return win.webContents.executeJavaScript(`(() => { const wv = document.querySelector('webview'); return wv.executeJavaScript('({ title: document.title, text: document.body ? document.body.innerText.slice(0, 400) : "", type: document.contentType })').then((r) => ({ ...r, url: wv.getURL(), shownTitle: wv.getTitle() }), (e) => ({ err: String(e), url: wv.getURL(), shownTitle: wv.getTitle() })); })()`);
}

app.whenReady().then(async () => {
  build();
  const doc = { ws: [{ id: 'a', folder: PROJ, downloads: [{ file: path.join(DL, 'report.pdf') }, { file: path.join(DL, 'gone.pdf') }] }] };
  files.init({ store: { load: () => doc }, home: os.homedir() });

  // ---- list ----
  let r = await files.list(null, PROJ);
  const names = r.ok ? r.entries.map((e) => `${e.kind === 'dir' ? 'd' : 'f'}:${e.name}`) : [];
  check('lists one level, folders first, by name as Finder sorts (numbers by value, case and accents ignored)', JSON.stringify(names) === JSON.stringify(['d:big', 'd:Docs', 'd:src', 'd:src-link', 'f:blob.bin', 'f:dangling', 'f:été ü #1.txt', 'f:main.ts', 'f:notes 9.txt', 'f:notes 10.txt', 'f:page.html', 'f:paper.pdf', 'f:README.md', 'f:run.sh', 'f:secret.js', 'f:Thing.app']), names);
  check('hidden names are left out', !names.some((n) => n.includes(':.')), names);
  check('an app bundle is a file', names.includes('f:Thing.app'));
  check('a link to a folder is a folder, a link to nothing a file', names.includes('d:src-link') && names.includes('f:dangling'));
  r = await files.list(null, path.join(PROJ, 'big'));
  check('a big folder returns 5000 names and its total', r.ok && r.entries.length === 5000 && r.total === 6000 && r.entries[0].name === 'f0.txt' && r.entries[1].name === 'f1.txt', r.ok ? { n: r.entries.length, total: r.total, first: r.entries.slice(0, 3) } : r);
  r = await files.list(null, path.join(PROJ, 'missing'));
  check('a missing folder says not there', !r.ok && r.error === 'not there', r);
  r = await files.list(null, OUTSIDE);
  check('a folder outside every workspace is refused', !r.ok && r.error === 'not in a workspace folder', r);
  r = await files.list(null, path.join(PROJ, '.git'));
  check('a hidden folder is refused', !r.ok && r.error === 'not in a workspace folder', r);
  r = await files.list(null, path.join(PROJ, 'src', '..', '.git'));
  check('a path with .. is refused', !r.ok, r);
  r = await files.list(null, 'relative/path');
  check('a relative path is refused', !r.ok, r);
  r = await files.list('claude-agents', '/home/claude');
  check('a VM folder without the VM module says so', !r.ok && /VM/.test(r.error), r);

  // ---- exist ----
  const ex = await files.exist([path.join(DL, 'report.pdf'), path.join(DL, 'gone.pdf'), path.join(OUTSIDE, 'other.txt'), path.join(PROJ, 'README.md'), path.join(PROJ, 'src')]);
  check('exist: a recorded download, a gone one, any other file, a workspace file, a folder', JSON.stringify(ex) === JSON.stringify([true, false, true, true, false]), ex);
  const rel = await files.exist(['relative/README.md', `${PROJ}/src/../README.md`]);
  check('exist: a relative or unresolved path is not checked', JSON.stringify(rel) === JSON.stringify([false, false]), rel);

  // ---- watch ----
  const s1 = sender(9001);
  files.watch(s1, [{ host: null, dir: PROJ }, { host: null, dir: path.join(PROJ, 'src') }, { host: null, dir: 'outside/relative' }, { host: null, dir: `${OUTSIDE}/../outside` }]);
  fs.writeFileSync(path.join(PROJ, 'src', 'new.js'), 'x\n');
  await sleep(900);
  const changed = s1.sent.filter(([ch]) => ch === 'files:changed').map(([, d]) => d.dir);
  check('a new file in a watched folder is reported once', changed.length === 1 && changed[0] === path.join(PROJ, 'src'), s1.sent);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(PROJ, `burst${i}.txt`), String(i));
  await sleep(900);
  const burst = s1.sent.filter(([, d]) => d.dir === PROJ).length;
  check('a burst of 20 changes is reported once or twice', burst >= 1 && burst <= 2, burst);
  s1.sent.length = 0;
  fs.writeFileSync(path.join(OUTSIDE, 'x.txt'), 'x');
  await sleep(700);
  check('a relative or unresolved folder path is not watched', s1.sent.length === 0, s1.sent);
  files.watch(s1, [{ host: null, dir: PROJ }]);
  s1.sent.length = 0;
  fs.writeFileSync(path.join(PROJ, 'src', 'later.js'), 'x\n');
  await sleep(700);
  check('a folder no longer shown is no longer watched', s1.sent.length === 0, s1.sent);
  files.watch(s1, []);
  fs.writeFileSync(path.join(PROJ, 'after.txt'), 'x');
  await sleep(700);
  check('watch([]) stops everything', s1.sent.length === 0, s1.sent);
  const s2 = sender(9002);
  files.watch(s2, [{ host: null, dir: path.join(PROJ, 'Docs') }]);
  s2.emit('destroyed');
  fs.writeFileSync(path.join(PROJ, 'Docs', 'd.txt'), 'x');
  await sleep(700);
  check('a closed window stops its watches', s2.sent.length === 0, s2.sent);

  // ---- open ----
  let o = await files.open(null, path.join(PROJ, 'README.md'));
  check('open: a markdown file opens as a page', o.url === files.urlOf(path.join(PROJ, 'README.md')), o);
  o = await files.open(null, path.join(PROJ, 'run.sh'));
  check('open: a shell script opens as a page (text, never a download)', !!o.url, o);
  o = await files.open(null, path.join(PROJ, 'paper.pdf'));
  check('open: a pdf opens as a page', !!o.url, o);
  o = await files.open(null, path.join(PROJ, 'src'));
  check('open: a folder is not opened', o.error === 'a folder', o);
  o = await files.open(null, path.join(PROJ, '.env'));
  check('open: a hidden file is refused', o.error === 'not in a workspace folder', o);
  o = await files.open(null, path.join(OUTSIDE, 'other.txt'));
  check('open: a file outside every workspace is refused', o.error === 'not in a workspace folder', o);
  o = await files.open(null, path.join(DL, 'report.pdf'));
  check('open: a recorded download opens as a page', !!o.url, o);
  o = await files.open(null, path.join(PROJ, 'dangling'));
  check('open: a link to nothing says not there', o.error === 'not there', o);

  // ---- the flow-file: scheme in a real webview ----
  const ses = session.fromPartition('persist:files-test');
  files.serveOn(ses);
  const downloads = [];
  ses.on('will-download', (_e, item) => { downloads.push(item.getURL()); item.cancel(); });
  const F = (p) => files.urlOf(p);
  // What a web page can make: the address without a signature, or with one it made up.
  const bare = (p) => `flow-file://mac/${p.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  const forged = (p) => `flow-file://mac/AAAAAAAAAAAAAAAAAAAAAA/${p.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  const evil = `<!doctype html><title>evil</title><img src="${bare(path.join(PROJ, 'paper.pdf'))}"><iframe src="${forged(path.join(PROJ, 'README.md'))}"></iframe><script referrerpolicy="no-referrer" src="${forged(path.join(PROJ, 'secret.js'))}"></script><script referrerpolicy="no-referrer" src="${bare(path.join(PROJ, 'secret.js'))}"></script><script>setTimeout(() => { document.title = 'evil:' + (window.SECRET || 'none'); fetch(${JSON.stringify(forged(path.join(PROJ, 'README.md')))}).then((r) => r.text()).then((t) => { document.title += t.includes('proj a') ? ' read' : ' no-read'; }, () => { document.title += ' no-read'; }); }, 300);</script>`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/evil') { res.setHeader('content-type', 'text/html'); res.end(evil); return; }
    if (req.url === '/go') { res.setHeader('content-type', 'text/html'); res.end(`<script>location = ${JSON.stringify(forged(path.join(PROJ, 'README.md')))}</script>`); return; }
    if (req.url === '/dl') { res.setHeader('content-disposition', 'attachment; filename="real.bin"'); res.end('x'); return; }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const win = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { webviewTag: true, contextIsolation: true } });
  await win.loadURL(`data:text/html,${encodeURIComponent('<!doctype html><body style="margin:0"><webview partition="persist:files-test" style="width:1000px;height:700px"></webview></body>')}`);

  let p = await load(win, F(path.join(PROJ, 'README.md')));
  check('a .md shows rendered, titled with its name', p.title === 'README.md' && p.text.startsWith('proj a') && !p.text.includes('#') && p.text.includes('some text & more'), p);
  p = await load(win, F(path.join(PROJ, 'run.sh')));
  check('a shell script shows as text', p.title === 'run.sh' && p.text.includes('echo hi'), p);
  p = await load(win, F(path.join(PROJ, 'main.ts')));
  check('a .ts file shows as text', p.title === 'main.ts' && p.text.includes('export const x'), p);
  p = await load(win, F(path.join(PROJ, 'été ü #1.txt')));
  check('a name with spaces, accents and # shows', p.title === 'été ü #1.txt' && p.text.includes('unicode name'), p);
  p = await load(win, F(path.join(PROJ, 'paper.pdf')), 4000);
  check('a pdf opens in the pdf viewer, titled with its name', p.type === 'application/pdf' && p.shownTitle === 'paper.pdf', p);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'pdf-shot.png'), shot.toPNG());
  p = await load(win, F(path.join(PROJ, 'page.html')), 3000);
  check('an html file runs its inline script and cannot fetch', p.text.includes('script ran') && p.title === 'made here no-fetch', p);
  p = await load(win, F(path.join(PROJ, 'Docs', 'nometa.html')));
  check('an html file that names no charset shows its UTF-8 as written', p.text.includes('›_ ✎ ◫'), p);
  p = await load(win, F(path.join(PROJ, 'Docs', 'utf8meta.html')));
  check('an html file with <meta charset="utf-8"> shows as written', p.text.includes('›_ ✎ ◫'), p);
  p = await load(win, F(path.join(PROJ, 'Docs', 'legacy.html')));
  check('an html file that names another charset (http-equiv windows-1252) keeps it', p.text.includes('price €5'), p);
  p = await load(win, F(path.join(PROJ, 'blob.bin')));
  check('a binary file is not shown', p.text.includes('flow does not show this kind of file'), p);
  p = await load(win, F(path.join(PROJ, '.env')));
  check('a hidden file is refused', p.text.includes('not in a workspace folder') && !p.text.includes('SECRET'), p);
  p = await load(win, F(path.join(OUTSIDE, 'other.txt')));
  check('a file outside every workspace is refused', p.text.includes('not in a workspace folder'), p);
  // A file the owner dropped on Flow from Finder opens wherever it is, by an address that grants that file alone.
  const dropped = path.join(OUTSIDE, 'dropped.md');
  fs.writeFileSync(dropped, '# dropped\n\nfrom Finder\n');
  const notDropped = await files.open(null, dropped);
  const drop = await files.open(null, dropped, 'dropped');
  p = drop.url ? await load(win, drop.url) : null;
  check('a file dropped from Finder opens wherever it is; the same file not dropped is refused', notDropped.error === 'not in a workspace folder' && !!p && p.title === 'dropped.md' && p.text.startsWith('dropped') && p.text.includes('from Finder'), { notDropped, drop, p });
  const dsig = drop.url ? drop.url.split('/')[3] : '';
  p = await load(win, `flow-file://mac/${dsig}/${path.join(OUTSIDE, 'other.txt').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`);
  const relDrop = await files.open(null, 'outside/dropped.md', 'dropped');
  check("a dropped file's address opens no other file beside it; a relative path is not taken as dropped", String(p.text).includes('refused') && !String(p.text).includes('outside') && relDrop.error === 'not in a workspace folder', { p, relDrop });
  p = await load(win, F(path.join(PROJ, 'missing.txt')));
  check('a missing file says not there', p.text.includes('not there'), p);
  p = await load(win, `${base}/evil`, 2000);
  check('a web page cannot include, frame or fetch a workspace file', p.title === 'evil:none no-read', p);
  p = await load(win, `${base}/go`, 2000);
  check('a web page cannot send itself to a workspace file: it is sent there and refused', String(p.url).startsWith('flow-file://') && String(p.text).includes('refused') && !String(p.text).includes('proj a'), p);
  check('nothing was downloaded', downloads.length === 0, downloads);
  // The listener that saw nothing does see a real download, so the check above can fail.
  const wvc = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.hostWebContents && w.hostWebContents.id === win.webContents.id);
  wvc.downloadURL(`${base}/dl`);
  for (let i = 0; i < 30 && !downloads.length; i++) await sleep(100);
  check('and a real download is seen', downloads.length === 1 && downloads[0] === `${base}/dl`, downloads);

  // A .md from the VM: its links are signed only when the VM module says the path is inside that host's workspace
  // folders (the Mac's rule), and it is told those folders as typed.
  if (files.vmUrlOf) {
    fs.writeFileSync(path.join(PROJ, 'Docs', 'vm-copy.md'), '[in](./b.md) [up](../../etc/x) ![img](shots/p.png)');
    doc.ws.push({ id: 'v', folder: path.join(ROOT, 'v-mac'), host: 'vmhost', hostFolder: '~/proj' }, { id: 'w', folder: path.join(ROOT, 'w-mac'), host: 'vmhost' });
    const calls = [];
    files.init({ store: { load: () => doc }, home: os.homedir(), vm: { shown: (host, abs, folders) => { calls.push([host, abs, folders]); return abs.startsWith('/home/u/proj/'); } } });
    const res = await files.respond(path.join(PROJ, 'Docs', 'vm-copy.md'), fs.statSync(path.join(PROJ, 'Docs', 'vm-copy.md')), { host: 'vmhost', path: '/home/u/proj/doc.md' });
    const html = await res.text();
    const hrefs = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    check('a VM .md links inside its workspace folder by a signed VM address', hrefs.includes(files.vmUrlOf('vmhost', '/home/u/proj/b.md')) && hrefs.includes(files.vmUrlOf('vmhost', '/home/u/proj/shots/p.png')), hrefs);
    check('a VM .md link outside it shows as text', !hrefs.some((h) => h.includes('/etc/x')) && html.includes('up'), hrefs);
    check("the VM module is told the host's workspace folders as typed", calls.length === 3 && calls.every((c) => c[0] === 'vmhost' && JSON.stringify(c[2]) === JSON.stringify(['~/proj', '~'])), calls);
    // A link to a folder on the VM stays text, as on the Mac: the VM module knows a folder from its listings (kindAt).
    files.init({ store: { load: () => doc }, home: os.homedir(), vm: { shown: (host, abs) => abs.startsWith('/home/u/proj/'), kindAt: (host, abs) => (abs === '/home/u/proj/docs' ? 'dir' : 'file') } });
    fs.writeFileSync(path.join(PROJ, 'Docs', 'vm-dir.md'), '[docs](docs) and [b](b.md)');
    const dirHtml = await (await files.respond(path.join(PROJ, 'Docs', 'vm-dir.md'), fs.statSync(path.join(PROJ, 'Docs', 'vm-dir.md')), { host: 'vmhost', path: '/home/u/proj/doc.md' })).text();
    const dirHrefs = [...dirHtml.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    check('a VM .md link to a folder stays text, as on the Mac; one to a file beside it is signed', !dirHrefs.some((h) => h.includes('/docs')) && dirHtml.includes('docs') && dirHrefs.includes(files.vmUrlOf('vmhost', '/home/u/proj/b.md')), dirHrefs);
    doc.ws.splice(-2);
    files.init({ store: { load: () => doc }, home: os.homedir() });
  }

  // An address names one file: another path under its signature, or a changed signature, is refused.
  const good = F(path.join(PROJ, 'README.md'));
  const sig = good.split('/')[3];
  p = await load(win, `flow-file://mac/${sig}/${path.join(PROJ, 'secret.js').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`);
  check("one file's signature does not open another", String(p.text).includes('refused') && !String(p.text).includes('SECRET'), p);
  p = await load(win, good.replace(`/${sig}/`, `/${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}/`));
  check('a changed signature is refused', String(p.text).includes('refused'), p);
  p = await load(win, good);
  check('the signed address itself opens the file', String(p.text).includes('some text & more'), p);
  const keyFile = path.join(app.getPath('userData'), 'flow-file.key');
  const kst = fs.statSync(keyFile);
  check('the key is 32 bytes in userData, readable only by this user', kst.size === 32 && (kst.mode & 0o777) === 0o600, { size: kst.size, mode: (kst.mode & 0o777).toString(8) });
  delete require.cache[FILES_MAIN];
  const again = require(FILES_MAIN);
  check('after a restart the same file has the same address', again.urlOf(path.join(PROJ, 'README.md')) === good);

  // A file shown as a page re-renders when it changes: soon after the first change, then at most once a second, and
  // once every n seconds for an n MB file, so a big log an agent keeps writing stays light. Timed by when each reload
  // starts, on a page that is 3 MB on disk but quick to load (a comment), so its loading does not hide the wait.
  const bigLog = path.join(PROJ, 'Docs', 'big.html');
  fs.writeFileSync(bigLog, `<!doctype html><title>big</title><!--${'x'.repeat(3 * 1024 * 1024 - 200)}-->\n<p>end 0</p>\n`);
  await load(win, F(bigLog), 800);
  const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.hostWebContents && w.hostWebContents.id === win.webContents.id);
  const starts = [];
  guest.on('did-start-loading', () => starts.push(Date.now()));
  files.watch(win.webContents, [{ host: null, file: bigLog }]);
  await sleep(300);
  const t1 = Date.now();
  fs.appendFileSync(bigLog, '<p>end 1</p>\n');
  await sleep(600);
  fs.appendFileSync(bigLog, '<p>end 2</p>\n');
  for (let i = 0; i < 100 && starts.length < 2; i++) await sleep(100);
  await new Promise((res) => (guest.isLoading() ? guest.once('did-stop-loading', res) : res()));
  await sleep(300);
  const shownEnd = await guest.executeJavaScript('document.body.innerText.slice(-12)');
  const paced = { reloads: starts.length, first: starts[0] - t1, between: starts[1] - starts[0], shownEnd };
  check('a 3 MB file shown as a page re-renders soon after a change, then waits 3 s before the next', paced.reloads === 2 && paced.first < 1000 && paced.between >= 2800 && paced.between < 4000 && shownEnd.includes('end 2'), paced);
  files.watch(win.webContents, []);

  // A file on the VM is paced the same way, by its size when the VM module last served it (a stand-in module here,
  // serving a copy through respond() as vmfiles does).
  const vmCopy = path.join(PROJ, 'Docs', 'vm-big.html');
  const vmPath = '/home/u/proj/big.html';
  fs.copyFileSync(bigLog, vmCopy);
  let toldVm = null;
  files.init({ store: { load: () => doc }, home: os.homedir(), vm: {
    watch: (_id, _entries, changed) => { toldVm = changed; },
    stop: () => {},
    serve: async () => files.respond(vmCopy, fs.statSync(vmCopy), { host: 'vmhost', path: vmPath }),
  } });
  await load(win, files.vmUrlOf('vmhost', vmPath), 800);
  const vmStarts = [];
  guest.on('did-start-loading', () => vmStarts.push(Date.now()));
  files.watch(win.webContents, [{ host: 'vmhost', file: vmPath }]);
  await sleep(200);
  const v1 = Date.now();
  fs.appendFileSync(vmCopy, '<p>vm 1</p>\n');
  if (toldVm) toldVm('vmhost', vmPath, 'file');
  await sleep(600);
  fs.appendFileSync(vmCopy, '<p>vm 2</p>\n');
  if (toldVm) toldVm('vmhost', vmPath, 'file');
  for (let i = 0; i < 100 && vmStarts.length < 2; i++) await sleep(100);
  await new Promise((res) => (guest.isLoading() ? guest.once('did-stop-loading', res) : res()));
  await sleep(300);
  const vmEnd = await guest.executeJavaScript('document.body.innerText.slice(-12)');
  const vmPaced = { told: !!toldVm, reloads: vmStarts.length, first: vmStarts[0] - v1, between: vmStarts[1] - vmStarts[0], vmEnd };
  check('a 3 MB file on the VM is paced the same way', vmPaced.told && vmPaced.reloads === 2 && vmPaced.first < 1000 && vmPaced.between >= 2800 && vmPaced.between < 4000 && vmEnd.includes('vm 2'), vmPaced);
  files.watch(win.webContents, []);

  // A change told while a tab is still loading the file (its answer made from the file before the change, the page not
  // shown yet, so the tab's address is still the page before) shows once the page does.
  const lateCopy = path.join(PROJ, 'Docs', 'vm-late.txt');
  const latePath = '/home/u/proj/late.txt';
  fs.writeFileSync(lateCopy, 'before the change\n');
  let toldLate = null;
  let answered = false;
  let release;
  const held = new Promise((res) => { release = res; });
  files.init({ store: { load: () => doc }, home: os.homedir(), vm: {
    watch: (_id, _entries, changed) => { toldLate = changed; },
    stop: () => {},
    serve: async () => {
      const res = await files.respond(lateCopy, fs.statSync(lateCopy), { host: 'vmhost', path: latePath });
      if (!answered) { answered = true; await held; }
      return res;
    },
  } });
  files.watch(win.webContents, [{ host: 'vmhost', file: latePath }]);
  const lateShown = win.webContents.executeJavaScript(`new Promise((res) => { const wv = document.querySelector('webview'); wv.addEventListener('did-stop-loading', () => res(), { once: true }); wv.src = ${JSON.stringify(files.vmUrlOf('vmhost', latePath))}; })`);
  for (let i = 0; i < 50 && !answered; i++) await sleep(100);
  const before = guest.getURL();
  fs.writeFileSync(lateCopy, 'after the change\n');
  if (toldLate) toldLate('vmhost', latePath, 'file');
  await sleep(300);
  release();
  await lateShown;
  let lateText = '';
  for (let i = 0; i < 30 && !lateText.includes('after the change'); i++) {
    await sleep(100);
    lateText = await guest.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
  }
  check('a change told while its tab is still loading the file shows once the page does', answered && !!toldLate && before !== files.vmUrlOf('vmhost', latePath) && lateText.includes('after the change'), { answered, told: !!toldLate, before, lateText });
  files.watch(win.webContents, []);
  files.init({ store: { load: () => doc }, home: os.homedir() });

  // A file shown again after nothing watched it (its space, or Flow, off screen) re-renders if it changed meanwhile,
  // and not if it did not.
  const awayFile = path.join(PROJ, 'Docs', 'away.txt');
  fs.writeFileSync(awayFile, 'before going away\n');
  await load(win, F(awayFile), 800);
  files.watch(win.webContents, [{ host: null, file: awayFile }]);
  await sleep(300);
  const awayStarts = [];
  const onAway = () => awayStarts.push(Date.now());
  guest.on('did-start-loading', onAway);
  files.watch(win.webContents, []);
  await sleep(300);
  files.watch(win.webContents, [{ host: null, file: awayFile }]);
  await sleep(1000);
  const unchanged = awayStarts.length;
  files.watch(win.webContents, []);
  fs.appendFileSync(awayFile, 'written while away\n');
  await sleep(300);
  files.watch(win.webContents, [{ host: null, file: awayFile }]);
  for (let i = 0; i < 30 && awayStarts.length === unchanged; i++) await sleep(100);
  await new Promise((res) => (guest.isLoading() ? guest.once('did-stop-loading', res) : res()));
  const awayText = await guest.executeJavaScript('document.body.innerText');
  guest.off('did-start-loading', onAway);
  check('a file shown again re-renders if it changed while nothing watched it, and not if it did not', unchanged === 0 && awayStarts.length === 1 && awayText.includes('written while away'), { unchanged, reloads: awayStarts.length, awayText });
  files.watch(win.webContents, []);

  // A task's box sits on its text's line and at the same place, in a tight list and in a loose one (a blank line
  // between items, as agents' plans often have).
  const tasksMd = path.join(PROJ, 'Docs', 'tasks.md');
  fs.writeFileSync(tasksMd, '- [ ] tight one\n- [x] tight two\n\nand a loose list:\n\n- [ ] loose one\n\n- [x] loose two\n');
  await load(win, F(tasksMd), 800);
  const boxes = await guest.executeJavaScript(`[...document.querySelectorAll('li.task')].map((li) => {
    const b = li.querySelector('input').getBoundingClientRect();
    const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let t = w.nextNode();
    while (t && !t.textContent.trim()) t = w.nextNode();
    const r = document.createRange();
    r.selectNodeContents(t);
    const line = r.getClientRects()[0];
    return { text: t.textContent.trim(), sameLine: Math.abs((b.top + b.bottom) / 2 - (line.top + line.bottom) / 2) < line.height / 2, x: Math.round(b.left) };
  })`);
  check("a task box sits on its text's line, at the same place in a tight list and a loose one", boxes.length === 4 && boxes.every((b) => b.sameLine) && new Set(boxes.map((b) => b.x)).size === 1, boxes);

  // A report: an .html is signed for its folder, so what is under that folder loads at its address (a script or style
  // sheet as what it is, any other file as it shows anywhere), nothing above it or hidden does, and its page gets a
  // policy naming only that folder. Any other file's address still names only that file.
  const rep = path.join(PROJ, 'Docs', 'rep');
  fs.mkdirSync(path.join(rep, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(rep, 'index.html'), '<!doctype html><title>rep</title><link rel="stylesheet" href="s.css"><p>rep</p>');
  fs.writeFileSync(path.join(rep, 's.css'), 'p { color: red }');
  fs.writeFileSync(path.join(rep, 'a.js'), 'window.ran = 1;');
  fs.writeFileSync(path.join(rep, 'notes.txt'), 'plain words');
  fs.writeFileSync(path.join(rep, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(rep, 'sub', 'p.html'), '<!doctype html><title>p</title>');
  const repUrl = F(path.join(rep, 'index.html'));
  const repSig = repUrl.split('/')[3];
  const under = (p) => `flow-file://mac/${repSig}/${p.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  const ask = async (u) => { const r = await ses.fetch(u); return { status: r.status, type: r.headers.get('content-type'), nosniff: r.headers.get('x-content-type-options'), csp: r.headers.get('content-security-policy') || '', referrer: r.headers.get('referrer-policy'), text: (await r.text()).slice(0, 40) }; };
  const page = await ask(repUrl);
  const repBase = `flow-file://mac/${repSig}/${rep.split('/').filter(Boolean).map(encodeURIComponent).join('/')}/`;
  check("a report page's policy names only its folder's address, sandboxed, with no network, fetch, frames, workers or forms", page.status === 200 && page.csp.includes(`script-src 'unsafe-inline' ${repBase};`) && page.csp.includes('sandbox allow-scripts allow-same-origin') && /default-src 'none'/.test(page.csp) && /worker-src 'none'/.test(page.csp) && /frame-src 'none'/.test(page.csp) && /form-action 'none'/.test(page.csp) && !/https?:|connect-src/.test(page.csp) && page.referrer === 'no-referrer' && page.nosniff === 'nosniff', page);
  const css = await ask(under(path.join(rep, 's.css')));
  const js = await ask(under(path.join(rep, 'a.js')));
  const sub = await ask(under(path.join(rep, 'sub', 'p.html')));
  check('its style sheet, script and a page in a subfolder load at its address, each as what it is', css.status === 200 && /^text\/css/.test(css.type) && js.status === 200 && /^text\/javascript/.test(js.type) && sub.status === 200 && sub.text.includes('<title>p</title>') && css.nosniff === 'nosniff', { css, js, sub });
  const txt = await ask(under(path.join(rep, 'notes.txt')));
  check('a text file there is the page it is anywhere, never raw text a script could take in', txt.status === 200 && /^text\/html/.test(txt.type) && txt.nosniff === 'nosniff', txt);
  const above = await ask(under(path.join(PROJ, 'Docs', 'nometa.html')));
  const hidden = await ask(under(path.join(rep, '.env')));
  check('a file above its folder, or a hidden one in it, is refused at its address', above.status === 403 && hidden.status === 403 && !hidden.text.includes('SECRET'), { above, hidden });
  const subOwn = F(path.join(rep, 'sub', 'p.html'));
  const upFromSub = await ask(`flow-file://mac/${subOwn.split('/')[3]}/${path.join(rep, 'index.html').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`);
  check("a page opened from a subfolder gets its own folder's address, and nothing above it there", subOwn.split('/')[3] !== repSig && upFromSub.status === 403, upFromSub);
  const txtOwn = await ask(F(path.join(rep, 'notes.txt')));
  const txtOwnSig = F(path.join(rep, 'notes.txt')).split('/')[3];
  const besideTxt = await ask(`flow-file://mac/${txtOwnSig}/${path.join(rep, 's.css').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`);
  check("any other file's address still names only that file", txtOwn.status === 200 && besideTxt.status === 403, { txtOwn: txtOwn.status, besideTxt: besideTxt.status });
  const old = await ask(`flow-file://mac/${crypto.createHmac('sha256', fs.readFileSync(path.join(app.getPath('userData'), 'flow-file.key'))).update(`mac\0${path.join(rep, 'index.html')}`).digest('base64url').slice(0, 22)}/${path.join(rep, 'index.html').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`);
  check("a report saved at its file's own address before still opens, with the file's own policy", old.status === 200 && /img-src data: blob:; font-src data:/.test(old.csp) && !old.csp.includes('sandbox'), old);
  // On the VM the same: the VM module gets the folder for a file under a report's address, and respond() takes it.
  let gotScope = null;
  files.init({ store: { load: () => doc }, home: os.homedir(), vm: {
    watch: () => {}, stop: () => {},
    serve: async (req) => { gotScope = req.headers.get('x-flow-scope'); return new Response('vm'); },
  } });
  const vmRep = files.vmUrlOf('vmhost', '/home/u/proj/cov/index.html');
  await ses.fetch(`flow-file://vm/${vmRep.split('/')[3]}/vmhost/home/u/proj/cov/style.css`);
  const vmCss = await files.respond(path.join(rep, 's.css'), fs.statSync(path.join(rep, 's.css')), { host: 'vmhost', path: '/home/u/proj/cov/style.css', scope: '/home/u/proj/cov' });
  const vmPage = await files.respond(path.join(rep, 'index.html'), fs.statSync(path.join(rep, 'index.html')), { host: 'vmhost', path: '/home/u/proj/cov/index.html', scope: '/home/u/proj/cov' });
  check("a VM report's files reach the VM module with their folder, and come back as on the Mac", gotScope === '/home/u/proj/cov' && /^text\/css/.test(vmCss.headers.get('content-type')) && (vmPage.headers.get('content-security-policy') || '').includes(`flow-file://vm/${vmRep.split('/')[3]}/vmhost/home/u/proj/cov/`), { gotScope, css: vmCss.headers.get('content-type'), csp: vmPage.headers.get('content-security-policy') });
  files.init({ store: { load: () => doc }, home: os.homedir() });

  srv.close();
  console.log(failed ? `${failed} FAILED` : 'all ok');
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(2);
});




