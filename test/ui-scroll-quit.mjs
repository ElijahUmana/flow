// Item 40: a page comes back exactly where it was after a quit that follows the scroll at once (a SIGTERM, as on
// shutdown), by wheel or by keys: a page of the main window, alone or with a pop-out open, and a page in the pop-out.
// And when the pop-out closes right after the scroll, its page is where it was once it is back in the main window;
// when a space pops out right after a scroll in the main window, its page is where it was in the pop-out; and a page
// scrolled in the main window, popped out and scrolled again there, keeps the pop-out's scroll when the pop-out closes
// and across a quit (ux's find: the main window's claim on the page outlived its release), also when the same space is
// popped out, scrolled and closed three times over.
// Real input, a page served here.
//   node test/ui-scroll-quit.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e;
//   ROUNDS=2,6 runs only those rounds)
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';
import { PORT, INSPECT } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
const PAGE = '<!doctype html><title>long</title><body style="margin:0">'
  + Array.from({ length: 400 }, (_, i) => `<p style="height:40px;margin:0">line ${i}</p>`).join('') + '</body>';
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(PAGE); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_ = `http://127.0.0.1:${server.address().port}/long`;
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json());
async function guestEval(expr) {
  const t = (await targets()).find((x) => x.type === 'webview' && x.url.startsWith(URL_));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`cannot open ${t.url}`)); });
  const v = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : undefined); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  return v;
}
const waitFor = async (app, expr, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await evaluate(app, expr); if (v) return v; }
  return evaluate(app, expr);
};
const r = (app, sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
async function open() {
  const app = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
  await evaluate(app, 'window.__flow.ready');
  // only when the window isn't that size already: the override also sizes the pages already in it to the whole window,
  // so a page scrolled to its end would come back clamped
  if ((await evaluate(app, '[innerWidth, innerHeight].join()')) !== '1500,913') {
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
  }
  await sleep(800);
  return app;
}
/* Enter in an address bar. page.js hands the keys to the page as it loads, and a page leaving for another site never
   answers a keyUp that reaches it meanwhile (CDP would wait 30 s), so the key comes up once the new page has loaded,
   as a slow release does. */
async function enter(p, loaded) {
  const spec = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec, text: '\r' });
  await loaded();
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
}
async function newPage(app) {
  const wk = await r(app, '.tr[data-act="note|n-week"]');
  await click(app, wk.cx, wk.cy);
  await sleep(500);
  const had = await evaluate(app, '__flow.windows().map((w) => w.id)');
  const v = await r(app, '#viewport'), pb = await r(app, '#dock [data-k="page"]');
  await mouse(app, 'mouseMoved', pb.cx, v.y + v.h - 3);
  await sleep(300);
  await waitFor(app, `(() => { const d = document.getElementById('dock'); return getComputedStyle(d).visibility !== 'hidden' && d.style.opacity !== '0'; })()`, 3000);
  for (let y = v.y + v.h - 6; y > pb.cy; y -= 3) await mouse(app, 'mouseMoved', pb.cx, y);
  await click(app, pb.cx, pb.cy);
  await sleep(800);
  const pw = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'page' && !had.includes(w.id));
  if (!pw) return null;
  await type(app, URL_);
  await enter(app, () => waitFor(app, `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && !p.isLoading() && p.getTitle() === 'long'; })()`, 20000));
  await sleep(1200);
  return pw;
}
async function popResearch(app) {
  const row = await r(app, '.tr[data-act="zone|z-research"]');
  if (!row) return false;
  await mouse(app, 'mouseMoved', row.cx, row.cy);
  await sleep(200);
  const pop = await r(app, '.tr[data-act="zone|z-research"] [data-zpop]');
  if (!pop) return false;
  await click(app, pop.cx, pop.cy);
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if ((await targets()).some((t) => t.type === 'page' && /zone=z-research/.test(t.url))) { await sleep(2500); return true; }
  }
  return false;
}
const popout = async () => {
  const sp = await connectTo(PORT, 'zone=z-research');
  for (let i = 0; i < 120 && !(await evaluate(sp, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  await evaluate(sp, 'window.__flow.ready');
  return sp;
};
const at = (win, x, y) => evaluate(win, `(() => { const e = document.elementFromPoint(${x}, ${y}); const w = e && e.closest('.win'); return w ? w.dataset.id : null; })()`);
/* The page itself under a point, not the shield over a window behind (a first click there only brings that window to
   the front): the window's id, else null. */
const pageAt = (win, x, y) => evaluate(win, `(() => { const e = document.elementFromPoint(${x}, ${y}); return e && e.tagName === 'WEBVIEW' && e.closest('.win') ? e.closest('.win').dataset.id : null; })()`);
/* A page window behind comes to the front by its title bar first, as the owner brings it forward to use it. */
async function toFront(win, id) {
  const wv = await r(win, `.win[data-id="${id}"] .pgv webview:not(.off)`);
  if (wv && (await pageAt(win, wv.cx, wv.cy)) === id) return wv;
  const tb = await r(win, `.win[data-id="${id}"] .tb`);
  if (tb) { await click(win, tb.cx, tb.cy); await sleep(400); }
  return r(win, `.win[data-id="${id}"] .pgv webview:not(.off)`);
}
// a research page goes to the long page, typed into its address line (in the pop-out, or in the main window on research)
/* A pop-out restored behind the main window shows its page's older scroll while covered (a covered page runs no
   animation frames) and the saved one once raised, so nothing is lost (item 67). It is raised before it is read, as the
   owner raises it to look at it; how many came back covered is counted for the Mac check. */
const restored = { covered: 0, of: 0 };
async function raiseRestored(sp) {
  const covered = (await evaluate(sp, 'document.visibilityState')) === 'hidden';
  restored.of++;
  if (covered) restored.covered++;
  console.log(`note the restored pop-out came back ${covered ? 'covered' : 'in front'}`);
  const mainp = await connectTo(INSPECT, '', 'node');
  const raised = await evaluate(mainp, `(() => { const w = require('electron').BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('zone=z-research')); if (w) w.focus(); return !!w; })()`, true);
  mainp.ws.close();
  if (!raised) throw new Error('no restored pop-out to raise');
  await sleep(1000);
}
async function researchPage(sp) {
  const id = await evaluate(sp, `(() => { const ws = __flow.state().ws.find((w) => w.id === 'flow'); const w = ws && ws.windows.find((x) => x.type === 'page' && x.zone === 'z-research'); return w ? w.id : null; })()`);
  if (!id) return null;
  const tb = await r(sp, `.win[data-id="${id}"] .tb`);
  if (!tb || (await at(sp, tb.cx, tb.cy)) !== id) return null;
  await click(sp, tb.cx, tb.cy);
  await sleep(400);
  const ad = await r(sp, `.win[data-id="${id}"] input.ad`);
  if (!ad || (await at(sp, ad.cx, ad.cy)) !== id) return null;
  await click(sp, ad.cx, ad.cy);
  await sleep(300);
  await type(sp, URL_);
  await enter(sp, () => waitFor(sp, `(() => { const p = __flow.page(${JSON.stringify(id)}); return !!p && !p.isLoading() && p.getTitle() === 'long'; })()`, 20000));
  await sleep(1200);
  return { id };
}
// where: 'main' (a new page window of the main window), 'main+popout' (the same, research popped out), 'popout' (a
// research page in its pop-out), 'popout-close' (the same, and the pop-out closes in place of the quit), 'pops-out'
// (a research page in the main window, and research pops out in place of the quit), 'pops-out-close' and
// 'pops-out-quit' (the same, then the page scrolled again in the pop-out, and the pop-out closes, or Flow quits)
// ux's repeated case: a research page live in the main window; research popped out, the page scrolled there, a
// second's wait, the pop-out closed, research shown in the main window again; three times over
async function repeated(label) {
  dev('stop');
  dev('start', '--fresh');
  const app = await open();
  const row = await r(app, '.tr[data-act="zone|z-research"]');
  await click(app, row.x + 40, row.cy);
  await sleep(1500);
  const pw = await researchPage(app);
  if (!R.ok(`${label}: a research page in the main window loads a long page`, !!pw)) return;
  const live = `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && p.guests().length > 0 && !p.isLoading(); })()`;
  for (let k = 1; k <= 3; k++) {
    if (!R.ok(`${label} ${k}: research is popped out`, await popResearch(app))) return;
    const sp = await popout();
    await waitFor(sp, live, 20000);
    await sleep(1500);
    const pv = await r(sp, `.win[data-id="${pw.id}"] .pgv webview:not(.off)`);
    for (let i = 0; i < 6; i++) await sp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pv.cx, y: pv.cy, deltaX: 0, deltaY: 160, button: 'none', buttons: 0, pointerType: 'mouse' });
    await sleep(1000);
    const there = await guestEval('Math.round(scrollY)');
    await evaluate(sp, 'setTimeout(() => window.close(), 0), true');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = !(await targets()).some((t) => t.type === 'page' && /zone=z-research/.test(t.url)); }
    if (!R.ok(`${label} ${k}: the pop-out closes`, gone)) return;
    await sleep(1000);
    const rr = await r(app, '.tr[data-act="zone|z-research"]');
    await click(app, rr.x + 40, rr.cy);
    await waitFor(app, live, 20000);
    await sleep(2500);
    const back = await guestEval('Math.round(scrollY)');
    R.ok(`${label} ${k}: back in the main window, the page is where it was last scrolled in the pop-out`, typeof there === 'number' && there > 500 * k && typeof back === 'number' && Math.abs(back - there) < 20, { there, back });
  }
}
async function round(label, how, where) {
  if (where === 'repeated') { await repeated(label); return; }
  dev('stop');
  dev('start', '--fresh');
  let app = await open();
  let win = app, pw;
  if (where.startsWith('popout')) {
    if (!R.ok(`${label}: research is popped out`, await popResearch(app))) return;
    win = await popout();
    pw = await researchPage(win);
    if (!R.ok(`${label}: a research page in the pop-out loads a long page`, !!pw)) return;
  } else if (where.startsWith('pops-out')) {
    const row = await r(app, '.tr[data-act="zone|z-research"]');
    await click(app, row.x + 40, row.cy);
    await sleep(1500);
    pw = await researchPage(app);
    if (!R.ok(`${label}: a research page in the main window loads a long page`, !!pw)) return;
  } else {
    pw = await newPage(app);
    if (!R.ok(`${label}: a long page loads in a new page window`, !!pw)) return;
    if (where === 'main+popout') R.ok(`${label}: research is popped out`, await popResearch(app));
  }
  // the page is in front: scroll it
  const wv = await toFront(win, pw.id);
  if (!R.ok(`${label}: the page is in front where it is scrolled`, !!wv && (await pageAt(win, wv.cx, wv.cy)) === pw.id)) return;
  if (how === 'keys') {
    await click(win, wv.cx, wv.cy);
    await sleep(300);
    await key(win, 'End');
  } else {
    for (let i = 0; i < 10; i++) await win.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wv.cx, y: wv.cy, deltaX: 0, deltaY: 160, button: 'none', buttons: 0, pointerType: 'mouse' });
  }
  await sleep(600);
  const before = await guestEval('Math.round(scrollY)');
  if (where.startsWith('pops-out')) {
    if (!R.ok(`${label}: research is popped out`, await popResearch(app))) return;
    let sp = await popout();
    const live = `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && p.guests().length > 0 && !p.isLoading(); })()`;
    await waitFor(sp, live, 20000);
    await sleep(2500);
    const after = await guestEval('Math.round(scrollY)');
    if (!R.ok(`${label}: in the pop-out, the page is where it was in the main window`, typeof before === 'number' && before > 500 && typeof after === 'number' && Math.abs(after - before) < 20, { before, after }) || where === 'pops-out') return;
    // scrolled again in the pop-out, to its end, then a second's wait, as the owner works
    const pv = await toFront(sp, pw.id);
    if (!R.ok(`${label}: in the pop-out, the page is in front where it is scrolled`, !!pv && (await pageAt(sp, pv.cx, pv.cy)) === pw.id)) return;
    await click(sp, pv.cx, pv.cy);
    await sleep(300);
    await key(sp, 'End');
    await sleep(1000);
    const there = await guestEval('Math.round(scrollY)');
    if (!R.ok(`${label}: End scrolls it in the pop-out`, typeof there === 'number' && there > before + 1000, { before, there, pageHasKeys: await guestEval('document.hasFocus()') })) return;
    if (where === 'pops-out-close') {
      await evaluate(sp, 'setTimeout(() => window.close(), 0), true');
      let gone = false;
      for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = !(await targets()).some((t) => t.type === 'page' && /zone=z-research/.test(t.url)); }
      if (!R.ok(`${label}: the pop-out closes`, gone)) return;
      await sleep(1000);
      const row = await r(app, '.tr[data-act="zone|z-research"]');
      await click(app, row.x + 40, row.cy);
      await waitFor(app, live, 20000);
    } else {
      dev('stop');
      dev('start');
      await open();
      sp = await popout();
      await waitFor(sp, live, 20000);
      await sleep(2500);
      await raiseRestored(sp);
    }
    await sleep(2500);
    const back = await guestEval('Math.round(scrollY)');
    R.ok(`${label}: the page is where it was last scrolled, in the pop-out`, typeof back === 'number' && Math.abs(back - there) < 20, { there, back });
    return;
  }
  if (where === 'popout-close') {
    // the pop-out closes at once: window.close() is the close its window button, ⇧⌘W and app.js all come to
    // (BrowserWindow 'close'); Linux has no frame to click here
    await evaluate(win, 'setTimeout(() => window.close(), 0), true');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250);
      gone = !(await targets()).some((t) => t.type === 'page' && /zone=z-research/.test(t.url));
    }
    if (!R.ok(`${label}: the pop-out closes`, gone)) return;
    await sleep(1000);
    // research is back in the main window: a click on its row shows it there
    const row = await r(app, '.tr[data-act="zone|z-research"]');
    await click(app, row.x + 40, row.cy);
    await waitFor(app, `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && p.guests().length > 0 && !p.isLoading(); })()`, 20000);
    await sleep(2500);
    const after = await guestEval('Math.round(scrollY)');
    R.ok(`${label}: back in the main window, the page is where it was in the pop-out`, typeof before === 'number' && before > 500 && typeof after === 'number' && Math.abs(after - before) < 20, { before, after });
    return;
  }
  // quit at once: a SIGTERM, as a shutdown or logout sends
  dev('stop');
  dev('start');
  app = await open();
  win = where === 'popout' ? await popout() : app;
  await waitFor(win, `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && !p.isLoading(); })()`, 20000);
  await sleep(2500);
  if (where === 'popout') await raiseRestored(win);
  const after = await guestEval('Math.round(scrollY)');
  R.ok(`${label}: after a quit right after the scroll, the page is back where it was`, typeof before === 'number' && before > 500 && typeof after === 'number' && Math.abs(after - before) < 20, { before, after });
}
const ROUNDS = [['wheel', 'wheel', 'main'], ['keys', 'keys', 'main'], ['wheel, pop-out open', 'wheel', 'main+popout'],
  ['keys, pop-out open', 'keys', 'main+popout'], ['wheel, in the pop-out', 'wheel', 'popout'], ['keys, in the pop-out', 'keys', 'popout'],
  ['wheel, then the pop-out closes', 'wheel', 'popout-close'], ['keys, then the pop-out closes', 'keys', 'popout-close'],
  ['wheel, then research pops out', 'wheel', 'pops-out'], ['scrolled in the pop-out, then it closes', 'wheel', 'pops-out-close'],
  ['scrolled in the pop-out, then a quit', 'wheel', 'pops-out-quit'], ['popped out, scrolled and closed, three times', 'wheel', 'repeated']];
// ROUNDS=2,6 runs only those rounds (1-based)
const only = process.env.ROUNDS ? process.env.ROUNDS.split(',').map(Number) : null;
for (const [i, a] of ROUNDS.entries()) if (!only || only.includes(i + 1)) await round(...a);
console.log(`note restored pop-outs that came back covered: ${restored.covered} of ${restored.of}`);
R.summary();
dev('stop');
server.close();
process.exit();




