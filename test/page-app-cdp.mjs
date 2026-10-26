/* Checks FlowPage inside the real app (src/index.html, real main and preload) over CDP: a seed page loads a real site,
   desktop-width scaling with clicks and drag-select landing under the transform, clip into the page note, popups and
   new-tab clicks opening tabs in the same page window, the address field, back/forward/reload from the buttons and the Page menu,
   find from the Edit menu, the loading bar, and the error state with a retry that succeeds. Prints ok/FAIL per check
   and exits non-zero on any failure. Never start the app on a fresh seed: its agent windows run real Claude Code (one
   in ~/flow) and its VM windows `ssh claude-agents`. test/page-state.mjs writes the seed's pages and notes without any
   terminal into the userData first; this test refuses to run if the app has a terminal window:
   rm -rf /tmp/flow-dev-page; node test/page-state.mjs /tmp/flow-dev-page; xvfb-run -a -s "-screen 0 1600x1000x24" env FLOW_USER_DATA=/tmp/flow-dev-page FLOW_TMUX_SOCKET=flow-dev-page FLOW_CDP_PORT=9564 ./node_modules/.bin/electron --inspect=9594 . --no-sandbox --flow-dev=page
   then: node test/page-app-cdp.mjs */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.FLOW_CDP_PORT || 9564);
const MAIN_PORT = Number(process.env.FLOW_MAIN_INSPECT || 9594);
const FIX_PORT = Number(process.env.FIX_PORT || 19576);
const RETRY_PORT = Number(process.env.RETRY_PORT || 19577);
const SHOTS = process.env.SHOTS || '/tmp/flow-page-app-shots';
const FIX = `http://127.0.0.1:${FIX_PORT}`;
const RETRY = `http://127.0.0.1:${RETRY_PORT}/retry`;
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`);
  if (!cond) failures++;
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, every = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

/* ---------- fixture sites ---------- */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>flow fixture</title><style>
body{margin:0;font:20px/1.4 Helvetica,Arial,sans-serif;background:#fff;color:#111;min-height:1600px}
#decoy{position:absolute;left:280px;top:40px;width:360px;height:140px;background:#fde2e2}
#target{position:absolute;left:900px;top:200px;width:220px;height:40px;background:#2251ff;color:#fff;display:flex;align-items:center;justify-content:center;text-decoration:none}
#sel{position:absolute;left:100px;top:290px;margin:0;font:24px/1 Menlo,monospace;white-space:nowrap}
#blank{position:absolute;left:100px;top:340px}
#plain{position:absolute;left:520px;top:340px}
#words{position:absolute;left:100px;top:900px;width:900px}
</style></head><body>
<div id="decoy">decoy (an unscaled click lands here)</div>
<a id="target" href="/clicked">target link</a>
<p id="sel">alpha bravo charlie delta echo foxtrot</p>
<a id="blank" href="/popup-target" target="_blank">open in a new page</a>
<a id="plain" href="/plain-target">plain link</a>
<p id="words">needle one, needle two, needle three.</p>
<script src="/fixture.js"></script>
</body></html>`;
const FIXTURE_JS = `window.__clicks = [];
addEventListener('click', (e) => {
  window.__clicks.push({ id: e.target.id, x: e.clientX, y: e.clientY });
  if (e.target.id === 'target' || e.target.id === 'decoy') e.preventDefault();
}, true);`;
const pageHTML = (t) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body><h1>${t}</h1></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, FIX);
  const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (u.pathname === '/fixture') send('text/html; charset=utf-8', FIXTURE);
  else if (u.pathname === '/fixture.js') send('text/javascript', FIXTURE_JS);
  else if (u.pathname === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="flow-test.bin"' }); res.end('flow'); }
  else if (u.pathname === '/slow') setTimeout(() => send('text/html; charset=utf-8', pageHTML('slow page')), 3000);
  else if (['/plain-target', '/popup-target', '/clicked'].includes(u.pathname)) send('text/html; charset=utf-8', pageHTML(u.pathname.slice(1).replace('-', ' ')));
  else { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(FIX_PORT, '127.0.0.1', r));
const retryServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHTML('retry ok')); });

/* ---------- CDP ---------- */
class CDP {
  static async connect(wsUrl) {
    const c = new CDP();
    c.ws = new WebSocket(wsUrl);
    c.id = 0;
    c.pending = new Map();
    c.listeners = [];
    await new Promise((res, rej) => {
      c.ws.onopen = res;
      c.ws.onerror = () => rej(new Error(`websocket error: ${wsUrl}`));
    });
    c.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && c.pending.has(d.id)) {
        const { res, rej, method } = c.pending.get(d.id);
        c.pending.delete(d.id);
        if (d.error) rej(new Error(`${method}: ${d.error.message}`));
        else res(d.result);
      } else if (d.method) c.listeners.forEach((f) => f(d));
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }
  async eval(expression, extra = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error(`evaluate threw: ${ex ? ex.description : r.exceptionDetails.text}\n  in: ${expression.slice(0, 300)}`);
    }
    return r.result.value;
  }
  close() { this.ws.close(); }
}
const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
async function guest(match, ms = 20000) {
  const t = await waitFor(async () => (await list()).find((x) => x.type === 'webview' && match(x.url)), ms);
  if (!t) throw new Error('no webview target matched');
  return CDP.connect(t.webSocketDebuggerUrl);
}

const hostTarget = await waitFor(async () => (await list()).find((x) => x.type === 'page' && /\/src\/index\.html/.test(x.url)), 20000);
if (!hostTarget) throw new Error(`no src/index.html target on port ${PORT} (start the real app, without FLOW_ENTRY)`);
const host = await CDP.connect(hostTarget.webSocketDebuggerUrl);
const consoleErrors = [];
host.listeners.push((d) => {
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
    const at = d.params.stackTrace && d.params.stackTrace.callFrames[0];
    consoleErrors.push({ text: d.params.args.map((a) => a.value || a.description).join(' '), url: at ? at.url : '' });
  }
  if (d.method === 'Runtime.exceptionThrown') {
    const x = d.params.exceptionDetails;
    consoleErrors.push({ text: `exception: ${x.exception ? x.exception.description : x.text}`, url: x.url || '' });
  }
});
await host.send('Runtime.enable');
if (!(await waitFor(() => host.eval('!!window.__flow'), 20000))) throw new Error('window.__flow never appeared in src/index.html');
await host.eval('window.__flow.ready.then(() => true)');
{
  const terms = await host.eval(`window.__flow.windows().filter((w) => w.type !== 'page' && w.type !== 'note').map((w) => w.id + ' ' + w.type)`);
  if (terms.length) {
    console.error(`this app has terminal windows (${terms.join(', ')}): a fresh seed starts real Claude Code and ssh. Start it with test/page-state.mjs's page-only state (see the top of this file).`);
    process.exit(2);
  }
}
const main = await (async () => {
  const url = `http://127.0.0.1:${MAIN_PORT}/json/list`;
  const t = (await (await fetch(url).catch((e) => { throw new Error(`no main-process inspector at ${url} (start electron with --inspect=${MAIN_PORT}): ${e.cause ? e.cause.code : e.message}`); })).json())[0];
  return CDP.connect(t.webSocketDebuggerUrl);
})();
const inMain = (expr) => main.eval(expr, { includeCommandLineAPI: true });
/* Clicks an application menu item the way the menu does: main's own click handler, with the Flow window. An item is
   found by its label or by its key (⌘T is "New Page" in batch 7 and "New Tab" from batch 8). */
const menuBy = (field, value) => inMain(`(() => {
  const { Menu, BrowserWindow } = require('electron');
  const find = (items) => { for (const i of items) { if (i[${JSON.stringify(field)}] === ${JSON.stringify(value)}) return i; const f = i.submenu && find(i.submenu.items); if (f) return f; } return null; };
  const item = find(Menu.getApplicationMenu().items);
  if (!item) throw new Error('the app menu has no ' + ${JSON.stringify(value)});
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/src/index.html'));
  item.click({}, win, win.webContents);
  return true;
})()`);
const menu = (label) => menuBy('label', label);
const menuKey = (key) => menuBy('accelerator', key);

async function shot(name) {
  const r = await host.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`     screenshot ${file}`);
}
const P = (id) => `window.__flow.page(${JSON.stringify(id)})`;
const W = (id, sel = '') => `document.querySelector('.win[data-id=${JSON.stringify(id)}] ${sel}')`;
const pageWindows = () => host.eval(`window.__flow.windows().filter((w) => w.type === 'page')`);
async function mouse(type, x, y, extra = {}) {
  const press = type === 'mousePressed', release = type === 'mouseReleased';
  await host.send('Input.dispatchMouseEvent', { type, x, y, button: press || release ? 'left' : 'none', buttons: press ? 1 : 0, clickCount: press || release ? 1 : 0, ...extra });
}
async function click(x, y, modifiers = 0) {
  await mouse('mouseMoved', x, y, { modifiers });
  await mouse('mousePressed', x, y, { modifiers });
  await mouse('mouseReleased', x, y, { modifiers });
}
async function key(k, code, vk, text, modifiers = 0) {
  await host.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text, unmodifiedText: text, modifiers });
  await host.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
const enter = () => key('Enter', 'Enter', 13, '\r');
const NEW_TAB = process.platform === 'darwin' ? { mod: 4, name: '⌘' } : { mod: 2, name: 'ctrl' };
const center = (expr) => host.eval(`(() => { const r = ${expr}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
/* The webview's box in the Flow window once the desktop has stopped moving (focusing a window can pan to it). */
async function geometry(id) {
  const read = () => host.eval(`(() => {
    const w = ${W(id, 'webview')}, pgv = w.parentElement, r = w.getBoundingClientRect(), v = pgv.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, layoutW: w.offsetWidth, layoutH: w.offsetHeight, pgvW: pgv.clientWidth, pgvH: pgv.clientHeight, transform: w.style.transform, view: { l: v.left, t: v.top, r: v.right, b: v.bottom }, inner: { w: innerWidth, h: innerHeight } };
  })()`);
  let a = await read();
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const b = await read();
    if (b.left === a.left && b.top === a.top && b.width === a.width) return b;
    a = b;
  }
  return a;
}
/* Brings a page window to the front the way a user does: its row in the sidebar (focuses it, going to its space and
   panning to it). A window in a sub-workspace is listed once that sub-workspace's row is opened. */
async function focusPage(id) {
  const sel = `.tr[data-act^=${JSON.stringify(`tab|${id}|`)}]`;
  const listed = () => host.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
  if (!(await listed())) {
    const zone = await host.eval(`(() => { const w = window.__flow.state().ws.flatMap((s) => s.windows).find((x) => x.id === ${JSON.stringify(id)}); return (w && w.zone) || ''; })()`);
    if (zone) {
      const z = await center(`document.querySelector('.tr[data-act=${JSON.stringify(`zone|${zone}`)}]')`);
      await click(z.x, z.y);
      await waitFor(listed, 3000);
    }
  }
  const row = await center(`document.querySelector(${JSON.stringify(sel)})`);
  await click(row.x, row.y);
  return waitFor(() => host.eval(`${W(id)}.classList.contains('front')`), 3000);
}
/* Maps guest CSS pixels to Flow window pixels; refuses points the page view does not show or another window covers. */
async function mapper(id) {
  const geo = await geometry(id);
  const s = geo.width / geo.layoutW;
  return async (gx, gy) => {
    const p = { x: geo.left + gx * s, y: geo.top + gy * s };
    if (p.x < geo.view.l + 1 || p.x > geo.view.r - 1 || p.y < geo.view.t + 1 || p.y > geo.view.b - 1 || p.x < 0 || p.y < 0 || p.x > geo.inner.w || p.y > geo.inner.h) {
      throw new Error(`guest point ${gx},${gy} maps to ${p.x.toFixed(1)},${p.y.toFixed(1)}, outside the page view ${JSON.stringify(geo.view)} or the window`);
    }
    const hit = await host.eval(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e === ${W(id, 'webview')} ? '' : (e ? e.outerHTML.slice(0, 120) : 'nothing'); })()`);
    if (hit) throw new Error(`guest point ${gx},${gy} maps to ${p.x.toFixed(1)},${p.y.toFixed(1)}, which shows ${hit}`);
    return p;
  };
}

try {
  /* ---------- a seed page window loads a real site ---------- */
  // The alphaxiv seed page lives in the "research" sub-workspace, its own space: a page loads once it is shown.
  ok('the sidebar shows the seed page window w-kv (in its sub-workspace)', await focusPage('w-kv'));
  const seedTitle = await waitFor(() => host.eval(`(() => { const p = ${P('w-kv')}; return p && !p.isLoading() && p.getTitle(); })()`), 45000);
  ok('the seed page window w-kv loads the real alphaxiv page', /FlatCake/.test(seedTitle || ''), seedTitle);
  ok('its address shows alphaxiv.org/abs/2610.38355', (await host.eval(`${W('w-kv', '.ad')}.value`)) === 'alphaxiv.org/abs/2610.38355');
  {
    const g = await geometry('w-kv');
    const gw = await guest((u) => u.includes('alphaxiv.org/abs/2610.38355'));
    const inner = await gw.eval('innerWidth');
    gw.close();
    ok('it lays the site out at 1180px and scales it to the note', g.layoutW === Math.max(g.pgvW, 1180) && Math.abs(g.width - g.pgvW) < 1 && inner === g.layoutW && /^scale\(/.test(g.transform), `innerWidth ${inner}, ${JSON.stringify({ layoutW: g.layoutW, pgvW: g.pgvW, transform: g.transform })}`);
  }

  /* ---------- a page window from openPage: clicks, drag-select and clip under the transform ---------- */
  const fid = await host.eval(`window.__flow.openPage(${JSON.stringify(`${FIX}/fixture`)})`);
  await waitFor(() => host.eval(`${P(fid)} && ${P(fid)}.getTitle() === 'flow fixture' && !${P(fid)}.isLoading()`), 20000);
  ok('openPage opens a page window that loads the fixture', (await host.eval(`${P(fid)}.getTitle()`)) === 'flow fixture', fid);
  const fx = await guest((u) => u === `${FIX}/fixture`);
  {
    const geo = await geometry(fid);
    const at = await mapper(fid);
    const t = await fx.eval(`(() => { scrollTo(0, 0); const r = document.getElementById('target').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await fx.eval('window.__clicks.length = 0');
    const p = await at(t.x, t.y);
    await click(p.x, p.y);
    const got = await waitFor(() => fx.eval('window.__clicks[0] || null'), 3000);
    ok(`a click lands on the link under the transform (scale ${(geo.width / geo.layoutW).toFixed(3)})`, got && got.id === 'target' && Math.abs(got.x - t.x) <= 2 && Math.abs(got.y - t.y) <= 2, JSON.stringify({ want: t, got, host: p }));
    ok('the clicked page window is the front window', await host.eval(`${W(fid)}.classList.contains('front')`));

    const w = await fx.eval(`(() => {
      const n = document.getElementById('sel').firstChild, r = document.createRange();
      r.setStart(n, 6); r.setEnd(n, 7); const a = r.getBoundingClientRect();
      r.setStart(n, 18); r.setEnd(n, 19); const b = r.getBoundingClientRect();
      return { x0: a.left + 2, x1: b.right - 2, y: a.top + a.height / 2 };
    })()`);
    await fx.eval('getSelection().removeAllRanges()');
    const p0 = await at(w.x0, w.y), p1 = await at(w.x1, w.y);
    await mouse('mouseMoved', p0.x, p0.y);
    await mouse('mousePressed', p0.x, p0.y);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p0.x + ((p1.x - p0.x) * i) / 8, p0.y, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', p1.x, p1.y);
    const sel = await fx.eval('String(getSelection())');
    ok('drag-selecting under the transform selects exactly "bravo charlie"', sel === 'bravo charlie', JSON.stringify(sel));
    ok('✂ shows once text is selected', !!(await waitFor(() => host.eval(`!${W(fid, '.pclip')}.classList.contains('nosel')`), 2000)));
    const c = await center(W(fid, '.pclip'));
    await click(c.x, c.y);
    // A page is where its notes live (notes' page as a primitive): the clip goes into the page's own note as a quote,
    // and the page marks that sentence.
    const recOf = `(() => { const r = window.FlowNotes.pagesDoc()[window.FlowNotes.key(${JSON.stringify(`${FIX}/fixture`)})]; return r ? { url: r.url, note: r.note } : null; })()`;
    const rec = await waitFor(async () => { const r = await host.eval(recOf); return r && (r.note || '').split('\n').includes('> bravo charlie') && r; }, 3000);
    const marked = await waitFor(() => fx.eval(`(() => { const h = CSS.highlights.get('flow-mark'); return !!h && [...h].some((r) => String(r) === 'bravo charlie'); })()`), 3000);
    ok('✂ clips the selection into the page\'s own note as a quote, and the page marks that sentence', !!rec && !!marked, JSON.stringify({ rec, marked }));
  }
  await shot('01-app-fixture-clipped');

  /* ---------- popups and new-tab clicks open tabs in the same page window ---------- */
  {
    const pos = await fx.eval(`(() => { const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }; return { blank: c('blank'), plain: c('plain') }; })()`);
    const blankAt = await (await mapper(fid))(pos.blank.x, pos.blank.y);
    const tabsOf = () => host.eval(`${P(fid)}.tabs()`);
    async function opensTab(label, u, show, act) {
      const before = await tabsOf();
      const wins = (await pageWindows()).length;
      await act();
      const after = await waitFor(async () => { const t = await tabsOf(); return t.tabs.length > before.tabs.length && t; }, 5000);
      const at = after ? after.tabs.findIndex((x) => x.url === u) : -1;
      const nowWins = (await pageWindows()).length;
      ok(label, after && at === before.tab + 1 && (show ? after.tab === at : after.tab === before.tab) && nowWins === wins, JSON.stringify({ tabs: after || (await tabsOf()), windows: `${wins} -> ${nowWins}` }));
      if (after) {
        await host.eval(`${P(fid)}.closeTab(${at})`);
        await waitFor(async () => (await tabsOf()).tabs.length === before.tabs.length, 4000);
        await host.eval(`${P(fid)}.selectTab(0)`);
      }
    }
    await opensTab('a target=_blank link opens a tab in the same page window and shows it', `${FIX}/popup-target`, true, () => click(blankAt.x, blankAt.y));
    ok('the sidebar brings the fixture window back to the front', await focusPage(fid));
    const plainAt = await (await mapper(fid))(pos.plain.x, pos.plain.y);
    await opensTab(`${NEW_TAB.name}-click on a link opens a tab behind, in the same page window`, `${FIX}/plain-target`, false, () => click(plainAt.x, plainAt.y, NEW_TAB.mod));
    ok('the source page did not navigate', (await host.eval(`${P(fid)}.getURL()`)) === `${FIX}/fixture`);
  }
  await shot('02-app-popups');

  /* ---------- a new tab lists this workspace's saved pages and no other's (queue item 28, real input) ---------- */
  {
    const wsOf = (id) => `window.__flow.state().ws.find((s) => s.windows.some((x) => x.id === ${JSON.stringify(id)}))`;
    const listOf = (id) => host.eval(`(() => { const f = ${W(id, '.pnew')}; return f && f.classList.contains('on') ? { secs: [...f.querySelectorAll('.pn-sec')].map((x) => x.textContent), rows: [...f.querySelectorAll('.pn-row')].map((x) => x.dataset.url), empty: (f.querySelector('.pn-empty') || {}).textContent || '' } : null; })()`);
    const tabCount = (id) => host.eval(`${P(id)}.tabs().tabs.length`);
    ok('the sidebar brings the fixture window to the front', await focusPage(fid));
    const star = await center(W(fid, '.pstar'));
    await click(star.x, star.y);
    const savedUrl = await waitFor(() => host.eval(`(() => { const w = ${wsOf(fid)}; const s = w && (w.saved || []).find((x) => x.url.endsWith('/fixture')); return ${W(fid, '.pstar')}.classList.contains('on') && s && s.url; })()`), 5000);
    const n0 = await tabCount(fid);
    // ⌘T makes a tab in the page window that has the keys (item 1): the owner is in that page.
    await host.eval(`${P(fid)}.focus()`);
    await waitFor(() => host.eval(`${W(fid)}.contains(document.activeElement)`), 3000);
    await menuKey('Command+T');
    await waitFor(async () => (await tabCount(fid)) === n0 + 1, 3000);
    const here = await waitFor(async () => { const l = await listOf(fid); return l && l.rows.length && l; }, 3000);
    ok('☆ saves the page in this workspace, and a new tab here (⌘T) lists it under its section', !!savedUrl && !!here && here.rows.includes(savedUrl) && here.secs.length >= 1, JSON.stringify({ savedUrl, here }));

    const efI = await host.eval(`window.__flow.state().ws.findIndex((s) => s.windows.some((x) => x.id === 'e-page'))`);
    const efOwn = await host.eval(`(${wsOf('e-page')}.saved || []).map((s) => s.url)`);
    const pill = await center(`document.querySelector('#spaces .sp[data-i="${efI}"] .sn')`);
    await click(pill.x, pill.y);
    const inEf = await waitFor(() => host.eval(`document.querySelector('#spaces .sp.on') === document.querySelector('#spaces .sp[data-i="${efI}"]')`), 3000);
    // The workspaces slide over: e-page's window has stopped moving before anything is pressed.
    for (let i = 0, a = null; i < 30; i++) { const b = await center(W('e-page')); if (a && a.x === b.x && a.y === b.y) break; a = b; await sleep(100); }
    ok('the ef start pill goes to that workspace, and its sidebar row brings its page window to the front', !!inEf && (await focusPage('e-page')));
    // Bringing it to the front pans the view to show all of it (nav.reveal, a 0.45 s glide): it is still before a press.
    for (let i = 0, a = null; i < 30; i++) { const b = await center(W('e-page')); if (a && a.x === b.x && a.y === b.y) break; a = b; await sleep(100); }
    const e0 = await tabCount('e-page');
    // The dock shows once the pointer comes to the bottom middle (the strip at the very bottom when a window is under
    // it), as a hand brings it up before pressing one of its buttons.
    const dockPage = await host.eval(`(() => { const d = document.getElementById('dock'), b = d.querySelector('button[data-k="page"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, edge: d.offsetParent.getBoundingClientRect().bottom - 4 }; })()`);
    await mouse('mouseMoved', dockPage.x, dockPage.edge);
    const dockUp = await waitFor(() => host.eval(`(() => { const cs = getComputedStyle(document.getElementById('dock')); return cs.opacity === '1' && cs.pointerEvents !== 'none' && cs.visibility === 'visible'; })()`), 2000, 50);
    const pagesBefore = await host.eval(`window.__flow.windows().map((x) => x.id)`);
    await click(dockPage.x, dockPage.y);
    // The dock's page button makes a page window of its own (item 1), never a tab in the page in front.
    const made = await waitFor(async () => (await host.eval(`window.__flow.windows().filter((x) => x.type === 'page').map((x) => x.id)`)).find((id) => !pagesBefore.includes(id)) || null, 5000);
    const there = made ? await waitFor(() => listOf(made), 3000) : null;
    const foreign = there ? there.rows.filter((u) => !efOwn.includes(u)) : null;
    ok('the dock\'s page button makes a page window of its own in another workspace, and its new page lists none of the pages saved elsewhere', !!dockUp && !!made && (await tabCount('e-page')) === e0 && !!there && foreign.length === 0 && !there.rows.includes(savedUrl) && (efOwn.length || (!there.rows.length && !there.secs.length && there.empty === '')), JSON.stringify({ dockUp: !!dockUp, efOwn, there }));

    if (made) {
      const shut = await center(W(made, '.lights [data-l="close"]'));
      await click(shut.x, shut.y);
      await waitFor(() => host.eval(`!${W(made)}`), 3000);
    }
    const flowI = await host.eval(`window.__flow.state().ws.findIndex((s) => s.windows.some((x) => x.id === ${JSON.stringify(fid)}))`);
    const back = await center(`document.querySelector('#spaces .sp[data-i="${flowI}"] .sn')`);
    await click(back.x, back.y);
    const inFlow = await waitFor(() => host.eval(`document.querySelector('#spaces .sp.on') === document.querySelector('#spaces .sp[data-i="${flowI}"]')`), 3000);
    // The saved fixture is listed under its section now, not as the window's tab, so the window is clicked where it
    // shows (still in front in its space), once the workspace has stopped sliding, each spot checked to be on top.
    const onTop = async (expr) => {
      if (!(await host.eval(`!!${expr}`))) return null;
      let a = await center(expr);
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        const b = await center(expr);
        if (b.x === a.x && b.y === a.y) break;
        a = b;
      }
      return (await host.eval(`document.elementFromPoint(${a.x}, ${a.y}) === ${expr}`)) ? a : null;
    };
    // A tab's × shows once the pointer is over the tab, as the owner reaches for it; each try aims again, since the
    // workspace may still be sliding in.
    const fxx = await waitFor(async () => {
      const at = await center(W(fid, '.ptab.on'));
      await host.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 });
      await sleep(150);
      return onTop(W(fid, '.ptab.on .pt-x'));
    }, 5000);
    if (fxx) await click(fxx.x, fxx.y);
    await waitFor(async () => (await tabCount(fid)) === n0, 3000);
    const star2 = await waitFor(() => onTop(W(fid, '.pstar')), 3000);
    if (star2) await click(star2.x, star2.y);
    const unsaved = await waitFor(() => host.eval(`(() => { const w = ${wsOf(fid)}; return !${W(fid, '.pstar')}.classList.contains('on') && !(w.saved || []).some((x) => x.url.endsWith('/fixture')); })()`), 3000);
    ok('the new tabs close with ×, the flow pill goes back, and ★ takes the page out again', !!inFlow && !!fxx && !!star2 && !!unsaved && (await tabCount(fid)) === n0 && (await tabCount('e-page')) === e0, JSON.stringify({ inFlow, fxx: !!fxx, star2: !!star2, unsaved, fid: await tabCount(fid), ef: await tabCount('e-page'), efTabs: (await host.eval(`${P('e-page')}.tabs().tabs`)).map((t) => t.url || '(blank)') }));
  }

  /* ---------- find from the Edit menu ---------- */
  {
    await focusPage(fid);
    await menu('Find');
    ok('Edit > Find opens the find bar in the front page window', await waitFor(() => host.eval(`${W(fid, '.pfind')}.classList.contains('on') && document.activeElement === ${W(fid, '.pf-q')}`), 3000));
    await host.send('Input.insertText', { text: 'needle' });
    const n1 = await waitFor(() => host.eval(`(() => { const t = ${W(fid, '.pf-n')}.textContent; return /^1 of 3$/.test(t) && t; })()`), 5000);
    ok('find shows "1 of 3"', n1 === '1 of 3', n1);
    await enter();
    const n2 = await waitFor(() => host.eval(`(() => { const t = ${W(fid, '.pf-n')}.textContent; return /^2 of 3$/.test(t) && t; })()`), 5000);
    ok('enter goes to "2 of 3"', n2 === '2 of 3', n2);
    await shot('03-app-find');
    await key('Escape', 'Escape', 27, '');
    ok('esc closes the find bar', await waitFor(() => host.eval(`!${W(fid, '.pfind')}.classList.contains('on')`), 2000));
  }
  fx.close();

  /* ---------- the address field ---------- */
  const ad = () => center(W(fid, '.ad'));
  async function typeAddress(text) {
    const a = await ad();
    await click(a.x, a.y);
    await host.send('Input.insertText', { text });
    await enter();
  }
  {
    await typeAddress('alphaxiv.org/abs/2610.09043');
    // A typed address is the tab's address before its load starts: the title says when the page is there.
    const t = await waitFor(() => host.eval(`${P(fid)}.getURL().includes('2610.09043') && !${P(fid)}.isLoading() && /Careful Judge/.test(${P(fid)}.getTitle()) && ${P(fid)}.getTitle()`), 45000);
    ok('a link typed without a scheme opens', /Careful Judge/.test(t || ''), `${await host.eval(`${P(fid)}.getURL()`)} | ${t}`);
    ok('the address shows it without https://www.', (await host.eval(`${W(fid, '.ad')}.value`)) === 'alphaxiv.org/abs/2610.09043');
    await typeAddress('https://www.alphaxiv.org/abs/2610.22948');
    const t2 = await waitFor(() => host.eval(`${P(fid)}.getURL().includes('2610.22948') && !${P(fid)}.isLoading() && /9A Framework/.test(${P(fid)}.getTitle()) && ${P(fid)}.getTitle()`), 45000);
    ok('a link typed with https:// opens', /9A Framework/.test(t2 || ''), t2);
    const noteTitle = await host.eval(`window.__flow.windows().find((w) => w.id === ${JSON.stringify(fid)}).title`);
    ok('the page window takes the page title', /9A Framework/.test(noteTitle), noteTitle);
    await typeAddress('flat kv cache storage');
    const s = await waitFor(() => host.eval(`(() => { const u = ${P(fid)}.getURL(); return u.startsWith('https://www.google.com/search') && !${P(fid)}.isLoading() && ${P(fid)}.getTitle() && u; })()`), 30000);
    ok('search words search with Google', /[?&]q=flat(\+|%20)kv(\+|%20)cache(\+|%20)storage/.test(s || ''), s);
    await shot('04-app-search');
  }

  /* ---------- back, forward, reload: the buttons and the Page menu ---------- */
  {
    const url = () => host.eval(`${P(fid)}.getURL()`);
    const settled = (re) => waitFor(async () => re.test(await url()) && !(await host.eval(`${P(fid)}.isLoading()`)), 30000);
    const b = await center(W(fid, '[data-nav=back]'));
    await click(b.x, b.y);
    ok('the back button goes back', !!(await settled(/2610\.22948/)), await url());
    const f = await center(W(fid, '[data-nav=fwd]'));
    await click(f.x, f.y);
    ok('the forward button goes forward', !!(await settled(/google\.com\/search/)), await url());
    await menu('Back');
    ok('Page > Back goes back', !!(await settled(/2610\.22948/)), await url());
    await menu('Back');
    ok('Page > Back again', !!(await settled(/2610\.09043/)), await url());
    await menu('Forward');
    ok('Page > Forward goes forward', !!(await settled(/2610\.22948/)), await url());
    await host.eval('window.__pageTestMarker = true');
    const r = await center(W(fid, '[data-nav=reload]'));
    await click(r.x, r.y);
    const started = await waitFor(() => host.eval(`${P(fid)}.isLoading()`), 3000, 20);
    ok('the reload button reloads', started && !!(await settled(/2610\.22948/)), `loading seen: ${!!started}`);
    await menu('Reload Page');
    const started2 = await waitFor(() => host.eval(`${P(fid)}.isLoading()`), 3000, 20);
    ok('Page > Reload Page reloads the page, not the app', started2 && !!(await settled(/2610\.22948/)) && (await host.eval('window.__pageTestMarker === true')), `loading seen: ${!!started2}`);
    await menu('Focus Address');
    const fa = await waitFor(() => host.eval(`(() => { const i = ${W(fid, '.ad')}; return document.activeElement === i && i.selectionStart === 0 && i.selectionEnd === i.value.length && i.value; })()`), 2000);
    ok('Page > Focus Address puts the cursor in the address with the full url selected', /^https:\/\/www\.alphaxiv\.org\/abs\/2610\.22948/.test(fa || ''), fa);
    await key('Escape', 'Escape', 27, '');
  }

  /* ---------- the loading bar ---------- */
  {
    await host.eval(`${P(fid)}.navigate(${JSON.stringify(`${FIX}/slow`)})`);
    const during = await waitFor(() => host.eval(`(() => { const b = ${W(fid, '.pload')}, cs = getComputedStyle(b); return b.classList.contains('on') && cs.opacity === '1' && { opacity: cs.opacity, transform: cs.transform, width: b.getBoundingClientRect().width }; })()`), 2500, 50);
    await sleep(600);
    const mid = await host.eval(`(() => { const b = ${W(fid, '.pload')}; return { on: b.classList.contains('on'), w: b.getBoundingClientRect().width, addr: b.parentElement.getBoundingClientRect().width, loading: ${P(fid)}.isLoading() }; })()`);
    ok('while a page loads, the loading bar shows and grows', !!during && mid.on && mid.loading && mid.w > 0 && mid.w < mid.addr, JSON.stringify({ during, mid }));
    await shot('05-app-loading');
    await waitFor(() => host.eval(`${P(fid)}.getTitle() === 'slow page' && !${P(fid)}.isLoading()`), 10000);
    await sleep(800);
    const after = await host.eval(`(() => { const b = ${W(fid, '.pload')}; return { on: b.classList.contains('on'), end: b.classList.contains('end'), opacity: getComputedStyle(b).opacity }; })()`);
    ok('when it finishes, the bar completes and fades out', !after.on && after.end && after.opacity === '0', JSON.stringify(after));
  }

  /* ---------- the error state and a retry that succeeds ---------- */
  {
    await host.eval(`${P(fid)}.navigate(${JSON.stringify(RETRY)})`);
    const e = await waitFor(() => host.eval(`(() => { const x = ${W(fid, '.perr')}; return x.classList.contains('on') && x.innerText; })()`), 15000);
    ok('a refused connection shows the plain error state: what happened and the address, no error code', /refused to connect/.test(e || '') && e.includes(RETRY.replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, '')) && !/ERR_|error -?\d/.test(e || ''), JSON.stringify(e));
    ok('the address keeps the failed url', (await host.eval(`${W(fid, '.ad')}.value`)) === RETRY.replace(/^https:\/\//, ''), await host.eval(`${W(fid, '.ad')}.value`));
    await shot('06-app-error');
    await new Promise((r) => retryServer.listen(RETRY_PORT, '127.0.0.1', r));
    const rr = await center(W(fid, '.pe-r'));
    await click(rr.x, rr.y);
    const t = await waitFor(() => host.eval(`${P(fid)}.getTitle() === 'retry ok' && !${P(fid)}.isLoading() && ${P(fid)}.getTitle()`), 10000);
    ok('"try again" loads the page once the site is up', t === 'retry ok', t);
    ok('and the error state is gone', await host.eval(`!${W(fid, '.perr')}.classList.contains('on')`));
  }

  /* ---------- a page opened for what becomes a download (queue item 32) ---------- */
  {
    // openPage opens in the workspace on screen; the window may be gone before the first look, so that is read first.
    const wsI = await host.eval(`+document.querySelector('#spaces .sp.on').dataset.i`);
    const dw = await host.eval(`window.__flow.openPage(${JSON.stringify(`${FIX}/download`)})`);
    const inDownloads = await waitFor(() => host.eval(`(() => { const w = window.__flow.state().ws[${wsI}]; return !!w && (w.downloads || []).some((d) => /flow-test( \\(\\d+\\))?\\.bin$/.test(d.file)); })()`), 10000);
    const gone = await waitFor(() => host.eval(`!window.__flow.windows().some((w) => w.id === ${JSON.stringify(dw)}) && !${W(dw)}`), 5000);
    await sleep(500);
    const row = await host.eval(`!!document.querySelector('.tr[data-act^="tab|${dw}|"]')`);
    // No sidebar row names the page that never was. (Its window's note is kept, as for every page window closed with an
    // address, and is not listed: the details say how many.)
    const left = await host.eval(`(() => { const u = ${JSON.stringify(`${FIX}/download`)}; return { notes: window.__flow.state().ws.flatMap((s) => s.notes).filter((n) => n.url === u).map((n) => n.title), rows: [...document.querySelectorAll('.tr')].filter((r) => r.outerHTML.includes(u) || r.outerHTML.includes('127.0.0.1:${FIX_PORT}/download')).map((r) => r.outerHTML.slice(0, 160)) }; })()`);
    ok('a page window opened for what becomes a download closes once the file is with the workspace\'s downloads, and leaves no row for it', !!inDownloads && !!gone && !row && !left.rows.length, JSON.stringify({ inDownloads, gone, row, left }));
  }

  /* ---------- a file tab shows the file's own path, not its signed address (files' rule) ---------- */
  {
    // A visible text file in the first workspace folder that has one; main signs only files there. Only read.
    const home = os.homedir();
    const folders = await host.eval(`window.__flow.state().ws.map((w) => w.folder || '')`);
    let file = null;
    for (const f of folders) {
      const dir = f.replace(/^~(?=\/|$)/, home);
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const name = fs.readdirSync(dir).find((n) => !n.startsWith('.') && /\.(md|txt)$/i.test(n) && fs.statSync(path.join(dir, n)).isFile());
      if (name) {
        file = path.join(dir, name);
        break;
      }
    }
    const opened = file ? await host.eval(`window.flow.files.open(null, ${JSON.stringify(file)})`) : null;
    const url = opened && opened.url;
    const fw = url ? await host.eval(`window.__flow.openPage(${JSON.stringify(url)})`) : null;
    const shownAs = fw ? await waitFor(async () => { const v = await host.eval(`(() => { const a = ${W(fw, '.ad')}; return a && a.value; })()`); return v && !/^flow-file:/.test(v) && v; }, 10000) : null;
    const want = file && (file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file);
    ok('a file opened from a workspace folder shows its path in the address field, and its tab keeps the signed address', !!url && /^flow-file:\/\/mac\//.test(url) && shownAs === want && (await host.eval(`${P(fw)}.tabs().tabs[0].url`)) === url, JSON.stringify({ file, url: url && url.replace(/\/mac\/[^/]+\//, '/mac/<sig>/'), shownAs, error: opened && opened.error }));
  }

  await shot('07-app-final');
  const mine = consoleErrors.filter((e) => /\/page\.js/.test(e.url) || /^flow page:/.test(e.text));
  ok('no console errors from page.js in the Flow window', mine.length === 0, mine.map((e) => e.text).join(' | '));
  if (consoleErrors.length) console.log(`     other console errors in the Flow window: ${consoleErrors.map((e) => `${e.text.replace(/\s+/g, ' ').slice(0, 160)} (${e.url.split('/').pop()})`).join(' | ')}`);
} catch (e) {
  failures++;
  console.log(`FAIL the run stopped: ${e.stack || e}`);
  await shot('99-stopped').catch((err) => console.log(`     screenshot failed too: ${err.message}`));
} finally {
  host.close();
  main.close();
  server.close();
  retryServer.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);




