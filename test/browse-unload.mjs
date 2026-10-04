// browse: what real pages lose when Flow brings them back through its restore path (history + pageState, as after a
// quit), the path an unload of an unseen tab would use. Each page gets some state (an inner scroller, a sideways place, the window
// scroll, half-typed text), its tab's memory is read, Flow restarts once, and the state is read back.
// usage: test/browse-app.sh reset && test/browse-app.sh start && node test/browse-unload.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const APP = new URL('./browse-app.sh', import.meta.url).pathname;
const CASES = [
  { name: 'Notion (public board)', url: 'https://supercopy.notion.site/Public-Roadmap-9daded17aac146dcb7ba3ff696d738fd', match: 'supercopy.notion.site',
    detail: `(() => { const s = document.querySelector('.notion-scroller.vertical'); return s ? 'page scroller ' + s.scrollTop + ' of ' + (s.scrollHeight - s.clientHeight) : 'no page scroller'; })()`,
    // the page scroller down 600, then the board (a sideways scroller inside it) right 150
    set: `(async () => { const s = document.querySelector('.notion-scroller.vertical'); if (!s) return 'no inner scroller'; s.scrollTop = 600; await new Promise((r) => setTimeout(r, 800)); const b = document.querySelector('.notion-scroller.horizontal'); if (b) b.scrollLeft = 150; return 'inner ' + s.scrollTop + ' of ' + s.scrollHeight + ', board left ' + (b ? b.scrollLeft + ' of ' + (b.scrollWidth - b.clientWidth) : 'none'); })()`,
    // where the owner's line is in the view, not the offset alone: content that grows above it moves the offset, not the line
    get: `(() => { const s = document.querySelector('.notion-scroller.vertical'); if (!s) return 'no inner scroller'; const b = document.querySelector('.notion-scroller.horizontal'); const r = s.getBoundingClientRect(); const line = [...s.querySelectorAll('a, span, div')].find((e) => /^Click here to add your feedback/.test(e.textContent.trim()) && e.children.length < 3); return 'board left ' + (b ? b.scrollLeft : 'none') + ', line "Click here to add your feedback" at ' + (line ? Math.round(line.getBoundingClientRect().top - r.top) + ' px' : 'none') + ' in the view'; })()` },
  { name: 'Google Doc (view-only)', url: 'https://docs.google.com/document/d/1YB7mhT1bQFAkicR3ycouX-cxHZL3xffM7iS3qTv7qZk/edit', match: 'docs.google.com/document',
    set: `(() => { const s = document.querySelector('.kix-appview-editor'); if (!s) return 'no editor scroller'; s.scrollTop = 900; return 'inner ' + s.scrollTop + ' of ' + s.scrollHeight; })()`,
    get: `(() => { const s = document.querySelector('.kix-appview-editor'); if (!s) return 'no editor scroller'; const r = s.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + 30); return 'inner ' + s.scrollTop + ', top ' + JSON.stringify(e ? (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 40) : null); })()` },
  { name: 'Google Maps (a place)', url: 'https://www.google.com/maps/@48.8584,2.2945,15z', match: 'google.com/maps',
    set: `location.href.slice(0, 80)`, get: `location.href.slice(0, 80)` },
  { name: 'a web form, half typed', url: 'https://httpbin.org/forms/post', match: 'httpbin.org/forms',
    set: `(() => { const t = document.querySelector('textarea'); t.focus(); t.value = 'half-typed comment from the walk'; t.dispatchEvent(new Event('input', { bubbles: true })); window.scrollTo(0, 200); return 'typed, window ' + scrollY; })()`,
    get: `(() => { const t = document.querySelector('textarea'); return 'text ' + JSON.stringify(t ? t.value : null) + ', window ' + scrollY; })()` },
  { name: 'Google Sheet (right and down)', url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', match: 'spreadsheets/d/1Bxi',
    // the grid is a canvas; its place is in the two scrollbars beside it. Sheets keeps only the last one set in a task.
    set: `(async () => { const x = document.querySelector('.native-scrollbar-x'), y = document.querySelector('.native-scrollbar-y'); if (!x || !y) return 'no scrollbars'; x.scrollLeft = 800; await new Promise((r) => setTimeout(r, 1500)); y.scrollTop = 600; await new Promise((r) => setTimeout(r, 1500)); return 'left ' + x.scrollLeft + ' of ' + (x.scrollWidth - x.clientWidth) + ', top ' + y.scrollTop + ' of ' + (y.scrollHeight - y.clientHeight); })()`,
    get: `(() => { const x = document.querySelector('.native-scrollbar-x'), y = document.querySelector('.native-scrollbar-y'); return x && y ? 'left ' + x.scrollLeft + ', top ' + y.scrollTop : 'no scrollbars'; })()` },
  { name: 'Wikipedia (window scroll)', url: 'https://en.wikipedia.org/wiki/Web_browser', match: 'wiki/Web_browser',
    set: `(() => { window.scrollTo(0, 3000); return 'window ' + scrollY; })()`, get: `(() => { const e = document.elementFromPoint(innerWidth / 2, 20); return 'window ' + scrollY + ', top text ' + JSON.stringify(e ? e.textContent.trim().slice(0, 40) : null); })()` },
];

let host, mainp;
async function connect() {
  host = await Cdp.connect((await waitFor(async () => (await targets(9571)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 40000, 'the Flow window')).webSocketDebuggerUrl);
  await waitFor(() => host.eval('return !!(window.__flow && window.__flow.ready);'), 40000, 'window.__flow');
  await host.eval('await window.__flow.ready; return true;');
  mainp = await Cdp.connect((await waitFor(async () => (await targets(9671))[0], 30000, 'the main inspector')).webSocketDebuggerUrl);
}
async function inGuest(match, js) {
  const t = (await targets(9571)).find((x) => x.type === 'webview' && x.url.includes(match));
  if (!t) return 'not loaded';
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  try { return await c.eval(`return ${js};`); } catch (e) { return 'error ' + e.message; } finally { c.close(); }
}
const memOf = (match) => mainp.eval(`const { app, webContents } = require('electron'); const by = new Map(app.getAppMetrics().map((x) => [x.pid, x])); const w = webContents.getAllWebContents().find((x) => x.getType() === 'webview' && x.getURL().includes(${JSON.stringify(match)})); const m = w && by.get(w.getOSProcessId()); return m ? Math.round(m.memory.workingSetSize / 1024) : null;`, { commandLine: true });

await connect();
const before = {};
for (const c of CASES) {
  const id = await host.eval(`return window.__flow.openPage(${JSON.stringify(c.url)});`);
  await waitFor(async () => (await targets(9571)).some((x) => x.type === 'webview' && x.url.includes(c.match)), 30000, c.name).catch(() => null);
  await sleep(9000);
  const state = await inGuest(c.match, c.set);
  await sleep(1500);
  before[c.name] = { id, state, read: await inGuest(c.match, c.get), detail: c.detail ? await inGuest(c.match, c.detail) : '', mb: await memOf(c.match) };
}
// page.js reads every shown page's history and scroll every 10 s: let it, then quit the way the owner does
await sleep(12000);
host.close();
mainp.close();
execFileSync(APP, ['stop'], { stdio: 'inherit' });
// what Flow saved for each tab at the quit (its place, and the boxes it scrolls inside)
const state = JSON.parse(fs.readFileSync('/tmp/flow-dev-browse/flow-state.json', 'utf8'));
const tabsSaved = state.ws.flatMap((w) => w.windows || []).flatMap((w) => w.tabs || []);
const savedOf = (match) => { const t = tabsSaved.find((x) => String(x.url).includes(match)); if (!t) return 'no tab'; const sc = t.scroll; if (!sc) return 'no place'; return `window ${Math.round(sc.y)}` + (sc.boxes ? ', boxes ' + sc.boxes.map((b) => `${b.sel.split('.').pop()} top ${Math.round(b.top)} left ${Math.round(b.left)}${b.text ? ' "' + b.text.slice(0, 20) + '"' : ''}`).join('; ') : ''); };
execFileSync(APP, ['start', '/tmp/flow-dev-browse.log'], { stdio: 'inherit' });
const t0 = Date.now();
await connect();
for (const c of CASES) {
  const b = before[c.name];
  // show the page the way the owner does: its tab's row in the sidebar (only shown tabs load)
  const row = await host.eval(`const r = document.querySelector('[data-act="tab|${b.id}|0"]'); if (!r) return null; r.scrollIntoView({ block: 'center' }); const x = r.getBoundingClientRect(); return { x: x.left + 30, y: x.top + x.height / 2 };`);
  if (row) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await host.send('Input.dispatchMouseEvent', { type, x: row.x, y: row.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
  const shownAt = Date.now();
  await waitFor(async () => (await targets(9571)).some((x) => x.type === 'webview' && x.url.includes(c.match)), 30000, `${c.name} again`).catch(() => null);
  // a restore lands once the page has drawn the boxes it scrolls inside, which with every page of the space loading at
  // launch can take a while: read until it matches what was there before the quit, for up to 30 s
  let after = null;
  let matchedAt = null;
  while (Date.now() - shownAt < 30000) {
    after = await inGuest(c.match, c.get);
    if (after === b.read) { matchedAt = Date.now(); break; }
    await sleep(500);
  }
  const detailAfter = c.detail ? await inGuest(c.match, c.detail) : '';
  console.log(`${c.name}\n  set: ${b.state}\n  before quit: ${b.read}, tab ${b.mb} MB${b.detail ? ` (${b.detail})` : ''}\n  saved: ${savedOf(c.match)}\n  after restore: ${after}${detailAfter ? ` (${detailAfter})` : ''} (shown ${Math.round((shownAt - t0) / 1000)} s after launch; ${matchedAt ? `the same as before ${((matchedAt - shownAt) / 1000).toFixed(1)} s after it was shown` : 'not the same after 30 s'})`);
}
host.close();
mainp.close();




