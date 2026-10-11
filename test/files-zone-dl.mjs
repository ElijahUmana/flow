// files' proof that a download from a page in a sub-workspace stays that sub-workspace's (FlowFiles.downloaded,
// files.js), with real downloads and real input, the app on port 9576 (as files-cdp):
//   FILES_ROOT=<tree> node test/files-zone-dl.mjs
// A download is reported twice: by its page (onDownload, with the page's space, app.js:493) and by main
// (download:done, without it, app.js:2254). Each check reads the end state, after both reports ran:
// 1. as they come; 2. the page's report first (main's held 1.5 s); 3. main's report first (the page's held 1.5 s);
// 4. the page window closed before its download ends: only main's report comes, so the download is main's.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connectTo, evaluate, click, sleep, reporter } from './ui-lib.mjs';
import { PORT, MARK, SOCK, DATA, ROOT, minimalPdf } from './files-seed.mjs';

const DL_DIR = path.join(DATA, 'Downloads');
const R = reporter();
const waitFor = async (fn, ms = 5000, step = 150) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };

const PDF = minimalPdf('the report');
const srv = http.createServer((req, res) => {
  const [p, q] = req.url.split('?');
  if (p === '/dl') {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>downloads here</title><body style="margin:0"><a id="dl" href="/${q}" style="display:block;font:40px sans-serif;padding:40px">get it</a>`);
    return;
  }
  if (p.endsWith('.pdf')) {
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${p.slice(1)}"`);
    res.setHeader('content-length', String(PDF.length));
    if (!p.startsWith('/slow')) { res.end(PDF); return; }
    // half now, the rest 5 s later: long enough to close its page window while it comes
    res.write(PDF.subarray(0, PDF.length >> 1));
    setTimeout(() => res.end(PDF.subarray(PDF.length >> 1)), 5000);
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${srv.address().port}`;

if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) throw new Error(`port ${PORT} is in use: an earlier run's app`);
execFileSync('node', [path.join(ROOT, 'test', 'files-seed.mjs')], { cwd: ROOT, env: { ...process.env, FILES_ROOT: ROOT }, stdio: 'ignore' });
const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${DATA}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1',
  './node_modules/.bin/electron', '.', '--no-sandbox', `--flow-dev=${MARK}`], { cwd: ROOT, stdio: 'ignore', detached: true });
try {
  const page = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  await sleep(800);
  const vi = await evaluate(page, `window.__flow.state().ws.findIndex((w) => w.id === 'voiceless')`);
  await evaluate(page, `window.__flow.go(${vi})`);
  await sleep(700);
  const heading = (act) => evaluate(page, `(() => { const r = document.querySelector('#sblist .tr[data-act=${JSON.stringify(act)}]'); if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.querySelector('.l').getBoundingClientRect(); return { x: b.left + Math.min(30, b.width / 2), y: b.top + b.height / 2 }; })()`);
  // the files rows under each space's heading, in the order the sidebar draws them
  const bySpace = () => evaluate(page, `(() => { const out = {}; let at = 'main'; for (const r of document.querySelectorAll('#sblist .tr')) { const act = r.dataset.act || ''; if (act.startsWith('zone|')) { at = act.slice(5) || 'main'; continue; } if (!act.startsWith('files|')) continue; const g = r.querySelector('.g'), m = r.querySelector('.m'); (out[at] = out[at] || []).push((g && g.textContent ? g.textContent + ' ' : '') + r.querySelector('.l').textContent + (m && m.textContent ? ' [' + m.textContent + ']' : '')); } return out; })()`);
  const entry = (file) => evaluate(page, `(() => { const ws = window.__flow.state().ws.find((w) => w.id === 'voiceless'); const d = (ws.downloads || []).find((x) => x.file === ${JSON.stringify(file)}); return d ? { zone: d.zone || '' } : null; })()`);
  const zb = await heading('zone|z-bare');
  if (!zb) throw new Error('no z-bare heading');
  await click(page, zb.x, zb.y);
  await sleep(700);
  const before = await bySpace();
  // every report of a download, as app.js makes it; hold: 'main' holds main's report (no space) 1.5 s, 'page' the page's
  await evaluate(page, `(() => { window.__dl = []; window.__hold = null; const f = window.FlowFiles.downloaded; window.FlowFiles.downloaded = function (ws, d, z) { const rec = { file: d && d.file, zone: z || null, at: Date.now() }; const go = () => { rec.ran = Date.now(); window.__dl.push(rec); return f.call(this, ws, d, z); }; const held = window.__hold === (z ? 'page' : 'main'); if (held) { setTimeout(go, 1500); return; } return go(); }; return true; })()`);
  const reportsOf = (file) => evaluate(page, `window.__dl.filter((x) => x.file === ${JSON.stringify(file)}).map((x) => x.zone)`);

  const downloadFrom = async (name) => {
    const url = `${SITE}/dl?${name}`;
    const id = await evaluate(page, `window.__flow.openPage(${JSON.stringify(url)})`);
    const t = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url === url && x.title === 'downloads here'), 15000, 250);
    if (!t) throw new Error(`the page for ${name} never showed`);
    const guest = await connectTo(PORT, url, 'webview');
    const b = await waitFor(() => evaluate(guest, `(() => { const r = document.getElementById('dl'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`), 8000, 200);
    await click(guest, b.x, b.y);
    guest.ws.close();
    return id;
  };
  const winZone = (id) => evaluate(page, `(() => { const ws = window.__flow.state().ws.find((w) => w.id === 'voiceless'); const w = ws.windows.find((x) => x.id === ${JSON.stringify(id)}) || (ws.closed || []).find((x) => x.id === ${JSON.stringify(id)}); return w ? w.zone || '' : null; })()`);

  // 1-3: a download from a page in z-bare, the two reports as they come and in both held orders
  for (const [name, hold, says] of [['report-a.pdf', null, 'as the two reports come'], ['report-b.pdf', 'main', "the page's report first, main's 1.5 s later"], ['report-c.pdf', 'page', "main's report first, the page's 1.5 s later"]]) {
    await evaluate(page, `window.__hold = ${JSON.stringify(hold)}`);
    const id = await downloadFrom(name);
    const file = path.join(DL_DIR, name);
    // held, both reports must come; as they come, main's may not (its download:done needs the page's guest found at
    // the start), so the end state is read 3 s after the first
    const reports = hold ? await waitFor(async () => { const r = await reportsOf(file); return r.length >= 2 ? r : null; }, 20000) : await waitFor(async () => { const r = await reportsOf(file); return r.length ? r : null; }, 20000);
    await sleep(hold ? 500 : 3000);
    const all = await reportsOf(file), e = await entry(file), w = await winZone(id), rows = await bySpace();
    R.ok(`a download from a page in a sub-workspace stays its own once its reports ran (${says})`, !!reports && all.includes('z-bare') && (!hold || all.includes(null)) && !!e && e.zone === 'z-bare' && w === 'z-bare', { reports: all, entry: e, win: w, rows });
  }
  const rows = await bySpace();
  R.ok("its three downloads show under its heading, and main's stay as they were", JSON.stringify((rows['z-bare'] || []).filter((x) => x.includes('downloads'))) === JSON.stringify(['▸ downloads [3]']) && JSON.stringify(rows.main) === JSON.stringify(before.main), { before, after: rows });

  // 4: the page window closed while its download comes: the page's report never comes
  await evaluate(page, 'window.__hold = null');
  const id4 = await downloadFrom('slow-d.pdf');
  const file4 = path.join(DL_DIR, 'slow-d.pdf');
  await waitFor(() => fs.readdirSync(DL_DIR).some((f) => f.startsWith('slow-d') || f.endsWith('.crdownload')), 4000, 100);
  const closeAt = await evaluate(page, `(() => { const w = document.querySelector('.win[data-id="${id4}"]'); const b = w && w.querySelector(':scope > .tb [data-l=close]'); if (!b) return null; b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!closeAt) throw new Error('no close button on the slow page window');
  await click(page, closeAt.x, closeAt.y);
  const closed = await waitFor(() => evaluate(page, `!document.querySelector('.win[data-id="${id4}"]')`), 3000);
  const reports4 = await waitFor(async () => { const r = await reportsOf(file4); return r.length ? r : null; }, 20000);
  await sleep(2000);
  const e4 = await entry(file4), rows4 = await bySpace();
  R.ok("a page window closed before its download ends: only main's report comes, so the download is main's (main does not carry the page's space yet)", closed === true && !!reports4 && JSON.stringify(await reportsOf(file4)) === JSON.stringify([null]) && !!e4 && e4.zone === '', { closed, reports: await reportsOf(file4), entry: e4, rows: rows4 });
  page.ws.close();
} finally {
  try { process.kill(-app.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 40; i++) { try { process.kill(-app.pid, 0); } catch { break; } await sleep(250); }
  spawnSync('tmux', ['-L', SOCK, 'kill-server']);
  srv.close();
}
R.summary();




