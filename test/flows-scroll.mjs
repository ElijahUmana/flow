// flows: a page comes back at the scroll it was left at after a quit (principle 5, OWNER_ASKS.md:43; STATUS item 40):
// left 0.3 s after a scroll, quit 0.6 s after a wheel scroll, quit 0.6 s after End, quit 0.6 s after a scroll in the main
// window while another workspace is popped out, and quit 0.6 s after a scroll in a page inside a pop-out. Long local
// pages with no images, so nothing on them moves by itself. Shell-only seed (no claude). node test/flows-scroll.mjs [label]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import * as L from './flows-lib.mjs';

const label = process.argv[2] || 'scroll';
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`);
let page = null;
const ev = (e) => L.ev(page, e);
const ids = () => ev(`window.__flow.windows().map((w) => w.id)`);
const newWin = async (before, ms = 10000) => (await L.until(page, `window.__flow.windows().map((w) => w.id).filter((w) => !${JSON.stringify(before)}.includes(w))[0]`, ms)).v;
async function rclick(x, y) {
  await L.mouse(page, 'mouseMoved', x, y);
  await L.mouse(page, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await L.mouse(page, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
  await L.sleep(450);
}
async function menuClick(re) {
  const b = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => ${re}.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  if (!b) throw new Error(`no menu item ${re}`);
  await L.click(page, b.x, b.y);
}
const pillIndex = (name) => ev(`[...document.querySelectorAll('#spaces .sp[data-i]')].findIndex((x) => x.querySelector('.sn').textContent.trim() === ${JSON.stringify(name)})`);
async function pillNamed(name) {
  const i = await pillIndex(name);
  if (i < 0) throw new Error(`no "${name}" pill`);
  await L.pointClick(page, `#spaces .sp[data-i="${i}"] .sn`);
  await L.sleep(900);
  return i;
}
const emptySpot = () => ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.top + 60; y < v.bottom - 140; y += 40) for (let x = v.left + 30; x < v.right - 30; x += 40) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .zl, #dock, .ctx, .toast')) return { x, y }; } return null; })()`);
async function guestEval(re, expr) {
  const t = (await L.targets()).find((x) => x.type === 'webview' && re.test(x.url));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('guest')); });
  const v = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result && d.result.result ? d.result.result.value : undefined); }; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  ws.close();
  return v;
}
const scrollOf = (q) => guestEval(new RegExp(`/long\\?${q}$`), 'Math.round(scrollY)');
const waitScrollable = async (q, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const h = await guestEval(new RegExp(`/long\\?${q}$`), 'document.body ? document.body.scrollHeight : 0'); if (h > 5000) return true; await L.sleep(250); } return false; };
const targetsNow = async () => (await L.targets()).filter((t) => t.type === 'page' && /index\.html/.test(t.url)).map((t) => t.url.replace(/^.*index\.html/, '') || 'main');
const shown = async () => ev(`(() => { const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at); return ws ? ws.name : s.ui.at; })()`);
async function launch(n) {
  await L.launch(`${label}-${n}`);
  page = await L.connect();
  await L.until(page, 'window.__flow && 1', 30000);
  await ev('window.__flow.ready');
  await L.sleep(2500);
}
async function quit() {
  page.ws.close();
  page = null;
  log(await L.stop());
  await L.sleep(1000);
}
/* the wheel the way a mouse sends it, over a page window's webview in the window cdp drives */
async function wheelOver(cdp, id, n = 8) {
  const r = await L.ev(cdp, `(() => { const e = document.querySelector('.win[data-id="${id}"] webview'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error(`no webview for ${id}`);
  await L.mouse(cdp, 'mouseMoved', r.x, r.y);
  for (let i = 0; i < n; i++) { await L.wheel(cdp, r.x, r.y, 0, 300); await L.sleep(60); }
}
async function popOut(name) {
  const i = await pillNamed(name);
  const id = await ev(`window.__flow.state().ws[${i}].id`);
  const pop = await L.rect(page, `#spaces .sp[data-i="${i}"] .pop`);
  if (!pop || !pop.w) throw new Error(`no ⤢ on the "${name}" pill`);
  await L.mouse(page, 'mouseMoved', pop.cx, pop.cy);
  await L.sleep(250);
  await L.click(page, pop.cx, pop.cy);
  for (let k = 0; k < 40 && !(await targetsNow()).some((u) => u === `#solo=${id}`); k++) await L.sleep(250);
  if (!(await targetsNow()).some((u) => u === `#solo=${id}`)) throw new Error(`"${name}" did not pop out`);
  await L.sleep(1500);
  return id;
}

// long pages with no images: one per case
const server = http.createServer((q, s) => {
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  s.end(`<!doctype html><title>flows long</title><body style="font:16px/24px sans-serif">${Array.from({ length: 800 }, (_, i) => `<p>line ${i}</p>`).join('')}</body>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const AT = `http://127.0.0.1:${server.address().port}`;

log('tree:', L.APP, spawnSync('sh', ['-c', `cd ${L.APP} && md5sum src/page.js src/main.js src/app.js src/store.js src/guest-preload.js | cut -c1-8,33- | tr "\\n" " "`], { encoding: 'utf8' }).stdout);
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
const seedRun = spawnSync('node', [path.join(L.ROOT, 'test/flows-seed.mjs')], { encoding: 'utf8', cwd: L.ROOT, env: process.env });
if (seedRun.status) throw new Error(`seed failed: ${seedRun.stderr}`);
{
  const f = path.join(L.UD, 'flow-state.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const ws of st.ws) for (const w of [...ws.windows, ...(ws.closed || [])]) if (w.cmd === 'claude') { w.cmd = 'shell'; delete w.sessionId; }
  fs.writeFileSync(f, JSON.stringify(st));
}
fs.rmSync(path.join(L.UD, 'Preferences'), { force: true });
await launch(1);

// a workspace with one long page for each case
const C = { now: { ws: 'scroll now' }, wheel: { ws: 'scroll wheel' }, end: { ws: 'scroll end' }, main: { ws: 'scroll main' }, pop: { ws: 'scroll pop' } };
for (const [q, c] of Object.entries(C)) {
  await L.pointClick(page, '#addws');
  await L.sleep(500);
  await L.type(page, c.ws);
  await L.key(page, 'Enter');
  await L.sleep(800);
  if ((await pillIndex(c.ws)) < 0) throw new Error(`no "${c.ws}" workspace was made`);
  const spot = await emptySpot();
  const before = await ids();
  await rclick(spot.x, spot.y);
  await menuClick('/new page/');
  c.id = await newWin(before);
  await L.sleep(400);
  await L.type(page, `${AT}/long?${q}`);
  await L.key(page, 'Enter');
  if (!(await waitScrollable(q))) throw new Error(`the ${q} page did not load`);
  await L.sleep(800);
}
const results = [];
const verdict = (q, what, left, back, after = 'the quit') => { const ok = left > 500 && back === left; results.push(ok); log(`${ok ? 'ok  ' : 'BAD '} ${q}: ${what}: ${left} when left, ${back} after ${after}`); };

// 1. left 0.3 s after a scroll; and a wheel scroll, then a quit 0.6 s later in the same window
await pillNamed(C.now.ws);
await wheelOver(page, C.now.id);
await L.sleep(300);
C.now.left = await scrollOf('now');
await pillNamed('flow');
await L.sleep(1000);
await pillNamed(C.wheel.ws);
await wheelOver(page, C.wheel.id);
await L.sleep(600);
C.wheel.left = await scrollOf('wheel');
await quit();
await launch(2);
await waitScrollable('wheel');
await L.sleep(2000);
verdict('wheel', 'a quit 0.6 s after a wheel scroll', C.wheel.left, await scrollOf('wheel'));
await pillNamed(C.now.ws);
await waitScrollable('now');
await L.sleep(2000);
verdict('now', 'its workspace left 0.3 s after a wheel scroll, then a quit', C.now.left, await scrollOf('now'));

// 2. End in the page, then a quit 0.6 s later
await pillNamed(C.end.ws);
await waitScrollable('end');
{
  const r = await L.ev(page, `(() => { const b = document.querySelector('.win[data-id="${C.end.id}"] webview').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 40 }; })()`);
  await L.click(page, r.x, r.y);
  await L.sleep(400);
  await L.key(page, 'End');
}
await L.sleep(600);
C.end.left = await scrollOf('end');
await quit();
await launch(3);
await waitScrollable('end');
await L.sleep(2000);
verdict('end', 'a quit 0.6 s after End', C.end.left, await scrollOf('end'));

// 3. another workspace popped out; a wheel scroll in the main window, then a quit 0.6 s later
await popOut('mynotes');
await pillNamed(C.main.ws);
await waitScrollable('main');
await wheelOver(page, C.main.id);
await L.sleep(600);
C.main.left = await scrollOf('main');
const t3 = await targetsNow(), at3 = await shown();
await quit();
await launch(4);
await L.sleep(1500);
const t4 = await targetsNow(), at4 = await shown();
const okAt = at4 === at3;
results.push(okAt);
log(`${okAt ? 'ok  ' : 'BAD '} main-at: the main window comes back on the workspace it showed at the quit, mynotes popped out: "${at3}" -> "${at4}" (windows ${JSON.stringify(t3)} -> ${JSON.stringify(t4)})`);
if (!okAt) await pillNamed(C.main.ws);
await waitScrollable('main');
await L.sleep(2000);
verdict('main', 'a quit 0.6 s after a wheel scroll in the main window, mynotes popped out', C.main.left, await scrollOf('main'));

// 4. the page's own workspace popped out; a wheel scroll in the pop-out, then a quit 0.6 s later
const popId = await popOut(C.pop.ws);
{
  const pp = await L.connect(new RegExp(`index\\.html#solo=${popId}$`));
  await L.until(pp, 'window.__flow && 1', 15000).catch(() => null);
  await waitScrollable('pop');
  await L.sleep(800);
  await wheelOver(pp, C.pop.id);
  pp.ws.close();
}
await L.sleep(600);
C.pop.left = await scrollOf('pop');
await quit();
await launch(5);
for (let k = 0; k < 40 && !(await targetsNow()).some((u) => u === `#solo=${popId}`); k++) await L.sleep(250);
await waitScrollable('pop');
await L.sleep(2000);
verdict('pop', `a quit 0.6 s after a wheel scroll in a page inside a pop-out (windows ${JSON.stringify(await targetsNow())})`, C.pop.left, await scrollOf('pop'));

// 5. a wheel scroll in a page inside a pop-out, then the pop-out closed 0.6 s later: the page shows in the main window at
//    that scroll; and how long the pop-out takes to go once asked
{
  const pp = await L.connect(new RegExp(`index\\.html#solo=${popId}$`));
  await L.until(pp, 'window.__flow && 1', 15000).catch(() => null);
  await waitScrollable('pop');
  await L.sleep(800);
  await wheelOver(pp, C.pop.id, 6);
  await L.sleep(600);
  C.close = { left: await scrollOf('pop') };
  const t0 = Date.now();
  await L.ev(pp, 'setTimeout(() => window.close(), 0), 1').catch(() => null);
  pp.ws.close();
  let gone = false;
  for (let k = 0; k < 200 && !gone; k++) { gone = !(await targetsNow()).includes(`#solo=${popId}`); if (!gone) await L.sleep(25); }
  C.close.ms = gone ? Date.now() - t0 : 'still open after 5 s';
}
await pillNamed(C.pop.ws);
await waitScrollable('pop');
await L.sleep(2000);
verdict('close', `the pop-out closed 0.6 s after a wheel scroll in its page (gone ${C.close.ms} ms after the close), the page in the main window`, C.close.left, typeof C.close.ms === 'number' ? await scrollOf('pop') : 'the pop-out never closed', 'the close');

log('     shot', await L.shot(page, `${label}-end`));
page.ws.close();
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
server.close();
log(`summary: ${results.filter(Boolean).length} of ${results.length} came back where they were left`);
process.exitCode = results.length > 0 && results.every(Boolean) ? 0 : 1;




