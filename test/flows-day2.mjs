// flows: batch 2 in the owner's day, with real input, on the tree in FLOWS_APP (a copy) or ~/flow: files per workspace,
// a page's note wherever the page opens, marks, page names, the edge double-click, room between windows, the sidebar
// changes (the "+" and drops on a heading), names through redirects, undo after ending an agent, then a quit. Fresh
// seed. Claude only in flow (folder under L.WORK), one tiny prompt. node test/flows-day2.mjs [label]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import http from 'node:http';
import * as L from './flows-lib.mjs';

const label = process.argv[2] || 'day2';
const T0 = Date.now();
const out = [];
const log = (...a) => { const s = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`; console.log(s); out.push(s); };
let page = null;
const ev = (e) => L.ev(page, e);
const S = {};
const res = [];
const verdict = (id, line, ok, detail) => { res.push({ id, line, ok, detail }); log(`${ok === true ? 'ok  ' : ok === false ? 'BAD ' : 'ERR '} ${id} ${line}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const ONLY = process.env.FLOWS_ONLY ? process.env.FLOWS_ONLY.split(',') : null;
async function check(id, line, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  try { const [ok, detail] = await fn(); verdict(id, line, ok, detail); } catch (e) { verdict(id, line, null, e.message.split('\n')[0]); if (page) { try { log('     shot', await L.shot(page, `${label}-err-${id}`)); } catch (_) { /* gone */ } } }
}
const ids = () => ev(`window.__flow.windows().map((w) => w.id)`);
const newWin = async (before, ms = 10000) => (await L.until(page, `window.__flow.windows().map((w) => w.id).filter((w) => !${JSON.stringify(before)}.includes(w))[0]`, ms)).v;
const typeSlow = async (t) => { for (const ch of t) { await L.key(page, ch); await L.sleep(35); } };
async function rclick(x, y) {
  await L.mouse(page, 'mouseMoved', x, y);
  await L.mouse(page, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await L.mouse(page, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
  await L.sleep(450);
}
const menu = () => ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.innerText.split('\\n')[0].trim())`);
async function menuClick(re) {
  const b = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => ${re}.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  if (!b) throw new Error(`no menu item ${re}; menu: ${JSON.stringify(await menu())}`);
  await L.click(page, b.x, b.y);
}
async function pill(i) { const p = await L.rect(page, `#spaces .sp[data-i="${i}"]`); await L.click(page, p.x + 8, p.cy); await L.sleep(900); }
async function emptySpot() {
  return ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.top + 60; y < v.bottom - 140; y += 40) for (let x = v.left + 40; x < v.right - 40; x += 40) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .zl, #dock, .ctx, .toast, .wsm')) return { x, y }; } return null; })()`);
}
const rows = () => ev(`[...document.querySelectorAll('#sblist .grp, #sblist .tr')].map((x) => (x.classList.contains('grp') ? '## ' : '') + x.innerText.replace(/\\n/g, ' | '))`);
const rowAt = (match) => ev(`(() => { const el = [...document.querySelectorAll('#sblist .tr')].find((x) => ${match}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2, text: el.innerText.replace(/\\n/g, ' | '), act: el.dataset.act || '' }; })()`);
async function guestEval(re, expr) {
  const t = (await L.targets()).find((x) => x.type === 'webview' && re.test(x.url));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('guest')); });
  const v = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result && d.result.result ? d.result.result.value : undefined); }; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  ws.close();
  return v;
}
async function newPageAt(url) {
  const spot = await emptySpot();
  if (!spot) throw new Error('no empty desktop for "new page here"');
  const before = await ids();
  await rclick(spot.x, spot.y);
  await menuClick('/new page/');
  const id = await newWin(before);
  await L.sleep(400);
  await typeSlow(url);
  await L.key(page, 'Enter');
  return id;
}
const winGeo = (id) => ev(`(() => { for (const ws of window.__flow.state().ws) { const w = ws.windows.find((x) => x.id === ${JSON.stringify(id)}); if (w) return { ws: ws.id, x: +w.x.toFixed(1), y: +w.y.toFixed(1), w: +w.w.toFixed(1), h: +w.h.toFixed(1), zone: w.zone || null }; } return null; })()`);

/* ---------- start: fresh seed, test files in flow's folder ---------- */
log('tree:', L.APP, spawnSync('sh', ['-c', `cd ${L.APP} && md5sum src/*.js src/index.html | cut -c1-8,33- | tr "\\n" " "`], { encoding: 'utf8' }).stdout);
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
spawnSync('node', [path.join(L.ROOT, 'test/flows-seed.mjs')], { encoding: 'utf8', cwd: L.ROOT, env: process.env });
fs.rmSync(path.join(L.UD, 'Preferences'), { force: true });
const FOLDER = path.join(L.WORK, 'p', 'flow');
fs.mkdirSync(path.join(FOLDER, 'sub'), { recursive: true });
fs.writeFileSync(path.join(FOLDER, 'flows-notes.txt'), 'flows file text: the owner keeps this next to the agents.\n');
fs.writeFileSync(path.join(FOLDER, '.flows-hidden'), 'dotfile\n');
fs.writeFileSync(path.join(FOLDER, 'sub', 'inner.md'), '# inner\n');
// a plan an agent writes in the project folder, long enough to scroll
fs.writeFileSync(path.join(FOLDER, 'plan.md'), ['# flows plan', '', 'What the agents do next, in order.', '', '- read the brief', '- check the fork', '', '- [ ] walk the day', '- [x] land batch 4', '', '| step | who |', '|---|---|', '| walk | flows |', '', 'See [the example](https://example.org/).', '', ...Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the plan\n`)].join('\n') + '\n');
await L.launch(`${label}-1`);
page = await L.connect();
await L.until(page, 'window.__flow && 1', 30000);
await ev('window.__flow.ready');
await L.sleep(3000);

/* ---------- files per workspace (owner 20:45) ---------- */
await check('F1', 'a "files" group after browser: the workspace folder unfolds, folders first, dotfiles hidden', async () => {
  const groups = await ev(`[...document.querySelectorAll('#sblist .grp')].map((x) => x.textContent.trim().toLowerCase())`);
  const folderRow = await rowAt(`(x.dataset.act || '').startsWith('files|') && !/downloads/.test(x.innerText)`);
  if (!folderRow) return [false, { groups, filesRows: 'none' }];
  await L.click(page, folderRow.x, folderRow.y);
  await L.sleep(1500);
  const r = (await rows()).filter((t) => /flows-notes|inner|sub|flows-hidden|downloads/.test(t));
  const iSub = r.findIndex((t) => /\bsub\b/.test(t)), iTxt = r.findIndex((t) => /flows-notes\.txt/.test(t));
  log('     shot', await L.shot(page, `${label}-f1-files`));
  const order = groups.indexOf('files') === groups.indexOf('browser') + 1 || (groups.indexOf('files') > groups.indexOf('notes') && groups.indexOf('files') < groups.indexOf('sub-workspaces'));
  return [order && iSub >= 0 && iTxt > iSub && !r.some((t) => /flows-hidden/.test(t)), { groups, rows: r }];
});
await check('F2', 'a click on a text file opens it as a page in this space; the file shows once and its row stays put', async () => {
  const f = await rowAt(`/flows-notes\\.txt/.test(x.innerText)`);
  if (!f) throw new Error('no row for flows-notes.txt');
  const before = await ids();
  const tabs0 = await ev(`document.querySelectorAll('.ptabs .ptab').length`);
  await L.click(page, f.x, f.y);
  await L.sleep(2500);
  const made = (await ids()).filter((w) => !before.includes(w));
  const text = await guestEval(/flows-notes|flow-file/i, 'document.body ? document.body.innerText.slice(0, 120) : ""');
  const listed = (await rows()).filter((t) => /flows-notes\.txt/.test(t));
  const f1 = await rowAt(`/flows-notes\\.txt/.test(x.innerText) && (x.dataset.act || '').startsWith('files|')`);
  log('     shot', await L.shot(page, `${label}-f2-file-open`));
  return [/flows file text/.test(text || '') && listed.length === 1 && !!f1 && Math.abs(f1.y - f.y) < 1, { newWindows: made, tabsBefore: tabs0, shows: text, rows: listed, rowMovedBy: f1 ? f1.y - f.y : null }];
});
await check('F3', "a file the page downloads shows under this workspace's downloads", async () => {
  const pid = await newPageAt('https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dflows-dl.txt');
  S.dlPage = pid;
  let row = null;
  for (let i = 0; i < 20 && !row; i++) { await L.sleep(1000); row = await rowAt(`/downloads/.test(x.innerText) && (x.dataset.act || '').startsWith('files|')`); if (row && !/[1-9]/.test(row.text)) row = null; }
  if (!row) return [false, { downloadsRow: await rowAt(`/downloads/.test(x.innerText)`) }];
  await L.click(page, row.x, row.y);
  await L.sleep(1200);
  const listed = (await rows()).filter((t) => /flows-dl/.test(t));
  return [listed.length > 0, { downloadsRow: row.text, listed }];
});

await check('F4', "a .md from the files group shows rendered in Flow's own viewer, and follows the file as an agent writes it, keeping the place", async () => {
  // owner: "our own say md viewer , our own 'finder application' ... im having some particular distatae for the stuffs built by others"
  // (cli-code-manager-live.md:107)
  const f = await rowAt(`/plan\\.md/.test(x.innerText)`);
  if (!f) throw new Error('no row for plan.md');
  await L.click(page, f.x, f.y);
  let shown = null;
  for (let i = 0; i < 40 && !shown; i++) { await L.sleep(250); shown = await guestEval(/plan\.md/i, `(() => { const a = document.querySelector('article'); if (!a) return null; return { h1: (a.querySelector('h1') || {}).textContent || '', items: a.querySelectorAll('li').length, tasks: [...a.querySelectorAll('li.task input[type=checkbox]')].map((x) => x.checked), table: !!a.querySelector('table'), link: !!a.querySelector('a[href^="https://example.org"]'), raw: /^#\\s/m.test(a.innerText) }; })()`); }
  if (!shown) throw new Error('plan.md did not open rendered');
  const look = await guestEval(/plan\.md/i, `(() => { const h = getComputedStyle(document.documentElement), b = getComputedStyle(document.body); return { htmlBg: h.backgroundColor, bodyBg: b.backgroundColor, color: b.color, styles: document.querySelectorAll('style').length, csp: (document.querySelector('meta[http-equiv]') || {}).content || null }; })()`);
  log('     plan.md look:', JSON.stringify(look));
  // the page as its own renderer paints it (the main window's capture can show an embedded page differently on this VM)
  {
    const t = (await L.targets()).find((x) => x.type === 'webview' && /plan\.md/i.test(x.url));
    if (t) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('guest')); });
      const png = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result && d.result.data); }; ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
      ws.close();
      if (png) { const f = path.join(L.SHOTS, `${label}-f4-plan-md-itself.png`); fs.writeFileSync(f, Buffer.from(png, 'base64')); log('     shot', f); }
    }
  }
  // each task's box on its own text's line (the plan's list is loose: a blank line in it, as agents write)
  const boxes = await guestEval(/plan\.md/i, `[...document.querySelectorAll('article li.task')].map((li) => { const box = li.querySelector('input[type=checkbox]'); const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) }); const t = w.nextNode(); const r = document.createRange(); r.selectNodeContents(t); const line = r.getClientRects()[0], b = box.getBoundingClientRect(); return Math.abs((b.top + b.height / 2) - (line.top + line.height / 2)); })`);
  shown.boxesOffTheirLinePx = (boxes || []).map((d) => Math.round(d));
  const rendered = shown.h1 === 'flows plan' && shown.items >= 4 && JSON.stringify(shown.tasks) === '[false,true]' && shown.table && shown.link && !shown.raw && Array.isArray(boxes) && boxes.length === 2 && boxes.every((d) => d <= 6);
  // read further down with the wheel, then an agent adds a line at the end
  // the webview showing plan.md (it may be a second tab in the window of the file opened before)
  const wv = await ev(`(() => { const v = [...document.querySelectorAll('.win webview')].find((e) => /plan\\.md/i.test(e.getURL ? e.getURL() : e.src) && e.offsetParent !== null); if (!v) return null; const b = v.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, win: v.closest('.win').dataset.id }; })()`);
  if (!wv) throw new Error('no window showing plan.md');
  await L.mouse(page, 'mouseMoved', wv.cx, wv.cy);
  for (let i = 0; i < 5; i++) { await L.wheel(page, wv.cx, wv.cy, 0, 300); await L.sleep(60); }
  await L.sleep(900);
  // the block at the top of the view: the first one whose bottom is inside it
  const topBlock = `(() => { const b = [...document.querySelectorAll('article h1, article h2, article h3, article p, article li, article tr, article pre')].find((e) => e.getBoundingClientRect().bottom > 4); return b ? Math.round(scrollY) + ' ' + b.textContent.trim().slice(0, 40) : null; })()`;
  const at0 = await guestEval(/plan\.md/i, topBlock);
  fs.appendFileSync(path.join(FOLDER, 'plan.md'), '\nline 61 added by an agent\n');
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) { await L.sleep(200); seen = !!(await guestEval(/plan\.md/i, `/line 61 added by an agent/.test(document.body.innerText)`)); }
  await L.sleep(400);
  const at1 = await guestEval(/plan\.md/i, topBlock);
  log('     shot', await L.shot(page, `${label}-f4-markdown`));
  // read, it goes again: its tab's × when it shares a window, else its window's red button
  const shut = await ev(`(() => { const v = [...document.querySelectorAll('.win webview')].find((e) => /plan\\.md/i.test(e.getURL ? e.getURL() : e.src)); if (!v) return null; const w = v.closest('.win'); const tabs = [...w.querySelectorAll('.ptabs .ptab')]; const t = tabs.find((x) => /plan\\.md/.test(x.innerText)); const b = (tabs.length > 1 && t ? t.querySelector('.pt-x') : w.querySelector('.tb [data-l="close"]')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, how: tabs.length > 1 ? 'tab' : 'window' }; })()`);
  if (shut) { await L.mouse(page, 'mouseMoved', shut.x, shut.y); await L.sleep(200); await L.click(page, shut.x, shut.y); await L.sleep(800); }
  // the same block on top after the re-render (its scroll may shift by a pixel or two)
  const blockOf = (x) => (x ? x.replace(/^\d+ /, '') : null);
  return [rendered && seen && !!at0 && /line \d+ of the plan/.test(at0) && blockOf(at1) === blockOf(at0), { rendered: shown, followsTheFile: seen, readingAt: [at0, at1] }];
});

/* ---------- a page's note wherever the page opens (owner 21:01) ---------- */
await check('P1', "a page's note comes with the page when it opens in another workspace", async () => {
  await pill(0);
  const pid = await newPageAt('example.org');
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(pid)}); return p && !p.isLoading() && /Example Domain/.test(p.getTitle() || ''); })()`, 40000, 250);
  S.ex = pid;
  const pen = await L.rect(page, `.win[data-id="${pid}"] .tb [data-act="note"]`);
  await L.click(page, pen.cx, pen.cy);
  await L.sleep(600);
  await typeSlow('flows page note');
  await L.sleep(1200);
  await pill(1);
  const p2 = await newPageAt('example.org');
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(p2)}); return p && !p.isLoading() && /Example Domain/.test(p.getTitle() || ''); })()`, 40000, 250);
  const pen2 = await L.rect(page, `.win[data-id="${p2}"] .tb [data-act="note"]`);
  await L.click(page, pen2.cx, pen2.cy);
  await L.sleep(800);
  const there = await ev(`(document.querySelector('.win[data-id="${p2}"] .anote') || {}).innerText || ''`);
  log('     shot', await L.shot(page, `${label}-p1-note-elsewhere`));
  await pill(0);
  return [/flows page note/.test(there), { noteInMynotes: there.slice(0, 120) }];
});
await check('P2', 'a clip marks its sentence in the page and the note links back to it', async () => {
  const pv = await L.rect(page, `.win[data-id="${S.ex}"] webview`);
  const w = await guestEval(/example\.org/, `(() => { const p = document.querySelector('p'); const r = document.createRange(); r.selectNodeContents(p.firstChild); const b = r.getClientRects()[0]; return { x: b.left + 12, y: b.top + b.height / 2, iw: innerWidth }; })()`);
  const k = pv.w / w.iw, hx = pv.x + w.x * k, hy = pv.y + w.y * k;
  await L.mouse(page, 'mouseMoved', hx, hy);
  await L.mouse(page, 'mousePressed', hx, hy, { clickCount: 1 });
  await L.mouse(page, 'mouseReleased', hx, hy, { clickCount: 1 });
  await L.mouse(page, 'mousePressed', hx, hy, { clickCount: 2 });
  await L.mouse(page, 'mouseReleased', hx, hy, { clickCount: 2 });
  await L.sleep(700);
  const clip = await L.rect(page, `.win[data-id="${S.ex}"] .pclip`);
  if (!clip) throw new Error('no clip button while text is selected');
  await L.click(page, clip.cx, clip.cy);
  await L.sleep(1500);
  const marks = await guestEval(/example\.org/, `(() => (window.CSS && CSS.highlights ? [...CSS.highlights.keys()].length : 0) + document.querySelectorAll('mark, [data-flow-mark], .flow-mark').length)()`);
  const note = await ev(`(document.querySelector('.win[data-id="${S.ex}"] .anote') || {}).innerText || ''`);
  const links = (await ev(`document.querySelectorAll('.win[data-id="${S.ex}"] .fnote-clip').length`)) > 0;
  log('     shot', await L.shot(page, `${label}-p2-mark`));
  return [marks > 0 && links, { marksInPage: marks, linksBack: links, note: (note || '').slice(0, 160) }];
});
await check('P3', 'one name per page: rename it on its row and the window and tab show the same name', async () => {
  const r = await rowAt(`/Example Domain/.test(x.innerText) && /↗/.test(x.innerText)`);
  if (!r) throw new Error('no row for the page');
  await L.dblclick(page, r.x, r.y);
  await L.sleep(500);
  await L.key(page, 'a', L.MOD.ctrl);
  await typeSlow('flows example');
  await L.key(page, 'Enter');
  await L.sleep(1000);
  const names = await ev(`(() => { const w = document.querySelector('.win[data-id="${S.ex}"]'); return { title: (w.querySelector('.tb .title') || {}).innerText || '', tab: [...w.querySelectorAll('.ptabs .ptab')].map((t) => t.innerText).join(' / '), rows: [...document.querySelectorAll('#sblist .tr')].filter((x) => /flows example|Example Domain/.test(x.innerText)).map((x) => x.innerText.replace(/\\n/g, ' | ')) }; })()`);
  const ok = /flows example/.test(names.title) && names.rows.some((t) => /flows example/.test(t)) && !names.rows.some((t) => /Example Domain/.test(t) && !/flows example/.test(t));
  return [ok, names];
});

/* ---------- room: the edge double-click and room between windows (owner 22:50) ---------- */
await check('R1', 'a double-click at the right edge adds a view of room and the view stays', async () => {
  await pill(0);
  const vp = await L.rect(page, '#viewport');
  const x = vp.x + vp.w - 12;
  let y = null;
  for (let yy = vp.y + 80; yy < vp.y + vp.h - 120; yy += 20) { const bare = await ev(`(() => { const e = document.elementFromPoint(${x}, ${yy}); return !!e && !e.closest('.win, .zl, #dock, .ctx, .toast'); })()`); if (bare) { y = yy; break; } }
  if (y == null) throw new Error('no bare desktop at the right edge');
  const before = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === st.ui.at); return { pan: Math.round(${L.PANPX}(ws, null, 'x')), width: Math.round(document.querySelector('.ws[data-id="' + ws.id + '"] > .canvas').getBoundingClientRect().width) }; })()`);
  await L.dblclick(page, x, y);
  await L.sleep(1200);
  const after = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === st.ui.at); return { pan: Math.round(${L.PANPX}(ws, null, 'x')), width: Math.round(document.querySelector('.ws[data-id="' + ws.id + '"] > .canvas').getBoundingClientRect().width) }; })()`);
  const grew = after.width - before.width;
  return [grew > vp.w * 0.8 && Math.abs(after.pan - before.pan) < 3, { before, after, grewPx: grew, viewWidth: Math.round(vp.w) }];
});
await check('R2', 'a double-click in the gap between two windows side by side makes room for one more like the right one', async () => {
  await pill(0);
  // two windows side by side with a thin gap, and a point of that gap that no other window covers
  const pair = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === st.ui.at); const v = document.getElementById('viewport').getBoundingClientRect(); const pan = ${L.PANPX}(ws, null, 'x'); const vis = ws.windows.filter((w) => !w.zone && document.querySelector('.win[data-id="' + w.id + '"]')); for (const a of vis) for (const b of vis) { if (a === b) continue; const gap = b.x - (a.x + a.w); const top = Math.max(a.y, b.y), bot = Math.min(a.y + a.h, b.y + b.h); if (!(gap > 0.3 && gap < 3 && bot - top > 10)) continue; const x = a.x + a.w + gap / 2, px = v.left + (x / 100) * v.width - pan; for (let y = top + 2; y < bot - 2; y += 2) { const py = v.top + (y / 100) * v.height; const e = document.elementFromPoint(px, py); if (e && !e.closest('.win, #dock, .ctx, .toast')) return { a: a.id, b: b.id, gap, px, py, bx: b.x, bw: b.w }; } } return null; })()`);
  if (!pair) throw new Error('no bare gap between two windows side by side in this space');
  const px = pair.px, py = pair.py;
  const bare = await ev(`(() => { const e = document.elementFromPoint(${px}, ${py}); return e ? (e.closest('.win') ? 'window ' + e.closest('.win').dataset.id : 'bare') : null; })()`);
  await L.dblclick(page, px, py);
  await L.sleep(1200);
  const b1 = await winGeo(pair.b);
  const moved = +(b1.x - pair.bx).toFixed(1);
  return [Math.abs(moved - (pair.bw + pair.gap)) < 2.5, { pair, under: bare, rightWindowMovedBy: moved, expected: +(pair.bw + pair.gap).toFixed(1) }];
});

/* ---------- the sidebar (queue 1, 6/22, 13) ---------- */
await check('S1', '"+ new section" shows only while the pointer is over its group', async () => {
  const vp = await L.rect(page, '#viewport');
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h / 2);
  await L.sleep(500);
  const away = await ev(`[...document.querySelectorAll('#sblist .tr')].filter((x) => /new section/.test(x.innerText) && x.offsetHeight > 0 && getComputedStyle(x).visibility !== 'hidden' && +getComputedStyle(x).opacity > 0.1).length`);
  const g = await rowAt(`/this week/.test(x.innerText)`);
  if (g) { await L.mouse(page, 'mouseMoved', g.x, g.y); await L.sleep(500); }
  const over = await ev(`[...document.querySelectorAll('#sblist .tr')].filter((x) => /new section/.test(x.innerText) && x.offsetHeight > 0 && getComputedStyle(x).visibility !== 'hidden' && +getComputedStyle(x).opacity > 0.1).length + [...document.querySelectorAll('#sblist .grp .gadd')].filter((x) => x.offsetWidth > 0 && getComputedStyle(x).visibility !== 'hidden' && +getComputedStyle(x).opacity > 0.1).length`);
  return [away === 0 && over > 0, { pointerOnDesktop: away, pointerOverNotes: over }];
});
await check('S2', 'one right-click menu per tool: the same on a page window and on its row', async () => {
  const tb = await L.rect(page, `.win[data-id="${S.ex}"] .tb .title`);
  await rclick(tb.cx, tb.cy);
  const onWindow = await menu();
  await L.key(page, 'Escape');
  await L.sleep(300);
  const r = await rowAt(`/flows example|Example Domain/.test(x.innerText) && /↗/.test(x.innerText)`);
  await rclick(r.x, r.y);
  const onRow = await menu();
  await L.key(page, 'Escape');
  return [onWindow.length > 0 && JSON.stringify(onWindow) === JSON.stringify(onRow), { onWindow, onRow }];
});
await check('S3', 'a blank new tab adds no row', async () => {
  const before = (await rows()).filter((t) => /new page|new tab/.test(t)).length;
  const tabs = () => ev(`(() => { const p = window.__flow.page(${JSON.stringify(S.ex)}); return p ? p.tabs().tabs.length : -1; })()`);
  const tabs0 = await tabs();
  const vp = await L.rect(page, '#viewport');
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h - 6);
  await L.sleep(500);
  // the page window in front first (its title), so the dock's page button adds a tab to it
  const tb = await L.rect(page, `.win[data-id="${S.ex}"] .tb .title`);
  await L.click(page, tb.cx, tb.cy);
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h - 6);
  await L.sleep(500);
  const b = await L.rect(page, '#dock button[data-k="page"]');
  await L.click(page, b.cx, b.cy);
  await L.sleep(1200);
  await L.key(page, 'Escape');
  const after = (await rows()).filter((t) => /new page|new tab/.test(t)).length;
  const tabs1 = await tabs();
  // the dock really added a blank tab, and no row came with it
  return [tabs0 >= 1 && tabs1 === tabs0 + 1 && after === before, { tabs: [tabs0, tabs1], blankRowsBefore: before, after }];
});

await check('H1', 'nothing to make a new one shows at rest; the "+" on the notes heading makes a section named in place', async () => {
  const vp = await L.rect(page, '#viewport');
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h / 2);
  await L.sleep(500);
  const shown = () => ev(`({ rows: [...document.querySelectorAll('#sblist .tr')].filter((x) => /^\\+/.test(x.innerText.trim()) && x.offsetHeight > 0 && +getComputedStyle(x).opacity > 0.1).length, plus: [...document.querySelectorAll('#sblist .grp .gadd')].filter((x) => x.offsetWidth > 0 && getComputedStyle(x).visibility !== 'hidden' && +getComputedStyle(x).opacity > 0.1).length })`);
  const atRest = await shown();
  const h = await ev(`(() => { const el = [...document.querySelectorAll('#sblist .grp')].find((x) => /^notes/.test(x.textContent.trim())); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; })()`);
  if (!h) throw new Error('no notes heading');
  await L.mouse(page, 'mouseMoved', h.x, h.y);
  await L.sleep(500);
  const onHover = await shown();
  const plus = await ev(`(() => { const el = [...document.querySelectorAll('#sblist .grp')].find((x) => /^notes/.test(x.textContent.trim())); const p = el && el.querySelector('.gadd'); if (!p) return null; const b = p.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; })()`);
  if (!plus || !plus.w) return [false, { atRest, onHover, headingPlus: 'none' }];
  await L.mouse(page, 'mouseMoved', plus.x, plus.y);
  await L.sleep(200);
  await L.click(page, plus.x, plus.y);
  await L.sleep(600);
  await typeSlow('flows heading section');
  await L.key(page, 'Enter');
  await L.sleep(800);
  const made = (await rows()).filter((t) => /flows heading section/.test(t));
  return [atRest.rows === 0 && atRest.plus === 0 && onHover.plus > 0 && made.length === 1, { atRest, onHover, made }];
});
/* Drag the first draggable row of a group onto that group's heading (OWNER_ASKS.md:389-390): while dragging, the heading
   reads "+ new section" and nothing in the list moves; the drop makes a section, named in place, with the row inside. */
async function dragOntoHeading(grp, name, tag) {
  const key = `flow:g:${grp}`;
  const src = await ev(`(() => { const h = document.querySelector('#sblist .grp[data-grp="${key}"]'); if (!h) return null; let el = h.nextElementSibling; while (el && !el.classList.contains('grp') && !(el.dataset.drag && /^(page|saved|note)\\|/.test(el.dataset.drag))) el = el.nextElementSibling; if (!el || el.classList.contains('grp')) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2, drag: el.dataset.drag, label: el.querySelector('.l').firstChild.textContent }; })()`);
  if (!src) throw new Error(`no draggable row under the ${grp} heading`);
  const layout = () => ev(`[...document.querySelectorAll('#sblist .grp, #sblist .tr')].map((x) => (x.dataset.act || x.dataset.grp) + '@' + Math.round(x.getBoundingClientRect().top)).join(' ')`);
  const head = () => ev(`(() => { const el = document.querySelector('#sblist .grp[data-grp="${key}"]'); if (!el) return null; const b = el.getBoundingClientRect(), g = el.querySelector('.gadd'), cs = g && getComputedStyle(g), bc = g && getComputedStyle(g, '::before'); return { x: b.left + 40, y: b.top + b.height / 2, reads: bc ? bc.content : 'none', shown: !!cs && cs.visibility !== 'hidden' && +cs.opacity > 0.1, lit: el.classList.contains('drop') }; })()`);
  await L.mouse(page, 'mouseMoved', src.x, src.y);
  await L.sleep(400);
  const before = await layout();
  await page.send('Input.setInterceptDrags', { enabled: true });
  const data = await new Promise(async (resolve) => {
    page.on((m) => { if (m.method === 'Input.dragIntercepted') resolve(m.params.data); });
    await L.mouse(page, 'mousePressed', src.x, src.y);
    for (let i = 1; i <= 6; i++) await L.mouse(page, 'mouseMoved', src.x + i * 2, src.y - i * 2, { down: true });
    setTimeout(() => resolve(null), 3000);
  });
  if (!data) { await L.mouse(page, 'mouseReleased', src.x, src.y); await page.send('Input.setInterceptDrags', { enabled: false }); throw new Error(`the ${src.drag} row did not start a drag`); }
  await L.sleep(200);
  const h = await head();
  await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: h.x, y: h.y, data });
  await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: h.x, y: h.y, data });
  await L.sleep(300);
  const over = await head(), during = await layout();
  log('     shot', await L.shot(page, `${label}-${tag}-dragging`));
  await page.send('Input.dispatchDragEvent', { type: 'drop', x: over.x, y: over.y, data });
  await L.mouse(page, 'mouseReleased', over.x, over.y);
  await page.send('Input.setInterceptDrags', { enabled: false });
  await L.sleep(800);
  await typeSlow(name);
  await L.key(page, 'Enter');
  await L.sleep(800);
  const inside = await ev(`(() => { const rs = [...document.querySelectorAll('#sblist .tr')]; const s = rs.find((x) => x.querySelector('.l') && x.querySelector('.l').firstChild.textContent === ${JSON.stringify(name)}); if (!s) return null; const d = (x) => +(/\\bd(\\d+)/.exec(x.className) || [0, 0])[1]; const out = []; for (let el = s.nextElementSibling; el && el.classList.contains('tr') && d(el) > d(s); el = el.nextElementSibling) out.push(el.querySelector('.l').firstChild.textContent); return { section: s.dataset.act, kids: out }; })()`);
  log('     shot', await L.shot(page, `${label}-${tag}-dropped`));
  const ok = /new section/.test(over.reads) && over.shown && over.lit && before === during && !!inside && inside.kids.includes(src.label);
  return [ok, { dragged: `${src.drag} "${src.label}"`, headingWhileDragging: { reads: over.reads, shown: over.shown, highlighted: over.lit }, listUnmovedWhileDragging: before === during, made: inside }];
}
await check('H2', 'a page dragged onto the browser heading ("+ new section" while dragging) makes a section with it inside', async () => {
  await pill(0);
  return dragOntoHeading('browser', 'flows page section', 'h2');
});
await check('H3', 'a note dragged onto the notes heading ("+ new section" while dragging) makes a section with it inside', async () => {
  await pill(0);
  return dragOntoHeading('notes', 'flows note section', 'h3');
});

/* ---------- a page keeps the name the owner gave it through a redirect (STATUS.md:275-278, item 25) ---------- */
// a local site whose addresses start redirecting when told to, as app.efstart.com/work does
const SITE = { work: false, keep: false, hits: [] };
const server = http.createServer((q, s) => {
  const u = q.url.split('?')[0];
  const go = { '/work': SITE.work && '/home', '/keep': SITE.keep && '/kept' }[u];
  const t = { '/work': 'flows work', '/home': 'flows home', '/keep': 'flows keep', '/kept': 'flows kept' }[u];
  const code = go ? (u === '/work' ? 307 : 302) : t ? 200 : 404;
  SITE.hits.push(`${u} ${code}`);
  if (go) { s.writeHead(code, { location: go, 'cache-control': 'no-store' }); s.end(); return; }
  s.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  s.end(t ? `<!doctype html><title>${t}</title><h1>${t}</h1>` : '');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE_AT = `http://127.0.0.1:${server.address().port}`;
async function pillNamed(name) {
  const p = await ev(`(() => { const el = [...document.querySelectorAll('#spaces .sp[data-i]')].find((x) => x.innerText.trim() === ${JSON.stringify(name)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 8, y: b.top + b.height / 2 }; })()`);
  if (!p) throw new Error(`no "${name}" pill`);
  await L.click(page, p.x, p.y);
  await L.sleep(900);
}
async function renameRow(match, name) {
  const r = await rowAt(match);
  if (!r) throw new Error(`no row for ${match}`);
  await L.dblclick(page, r.x, r.y);
  await L.sleep(500);
  await L.key(page, 'a', L.MOD.ctrl);
  await typeSlow(name);
  await L.key(page, 'Enter');
  await L.sleep(1000);
}
const shownName = (id) => ev(`(() => { const w = document.querySelector('.win[data-id="${id}"]'); if (!w) return null; return (w.querySelector('.tb .title') || {}).innerText || [...w.querySelectorAll('.ptabs .ptab')].map((t) => t.innerText).join(' / '); })()`);
const landed = (id, re, ms) => L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(id)}); return p && !p.isLoading() && ${re}.test(p.getURL()) ? p.getURL() : ''; })()`, ms, 250);

await check('N1', 'the owner\'s page "EF Start · my work" keeps its name after app.efstart.com/work redirects', async () => {
  await pillNamed('ef start');
  let at;
  try { at = (await landed('e-page', '/^https:\\/\\/app\\.efstart\\.com(?!\\/work$)/', 45000)).v; } catch (_) {
    const p = await ev(`(() => { const p = window.__flow.page('e-page'); return p ? { url: p.getURL(), loading: p.isLoading() } : null; })()`);
    throw new Error(`app.efstart.com/work did not land elsewhere within 45 s: ${JSON.stringify(p)}`);
  }
  await L.sleep(1500);
  const shown = await shownName('e-page');
  const browser = (await rows()).filter((t) => /↗/.test(t));
  log('     shot', await L.shot(page, `${label}-n1-efstart`));
  return [/EF Start · my work/.test(shown) && browser.some((t) => /EF Start · my work/.test(t)), { landedAt: at, window: shown, rows: browser }];
});

await check('N2', 'a page named at its address keeps the name when the address starts redirecting', async () => {
  await pill(0);
  const pid = await newPageAt(`${SITE_AT}/work`);
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(pid)}); return p && !p.isLoading() && /flows work/.test(p.getTitle() || ''); })()`, 20000, 250);
  await L.sleep(600);
  await renameRow(`/flows work/.test(x.innerText) && /↗/.test(x.innerText)`, 'flows redirect');
  const named = await shownName(pid);
  SITE.work = true;
  const rel = await L.rect(page, `.win[data-id="${pid}"] button[data-nav="reload"]`);
  await L.click(page, rel.cx, rel.cy);
  const at = (await landed(pid, '/\\/home$/', 20000)).v;
  await L.sleep(1200);
  const shown = await shownName(pid);
  const browser = (await rows()).filter((t) => /flows (redirect|work|home)/.test(t));
  log('     shot', await L.shot(page, `${label}-n2-redirect`));
  return [/flows redirect/.test(named) && /flows redirect/.test(shown) && browser.length > 0 && browser.every((t) => /flows redirect/.test(t)), { namedBefore: named, landedAt: at, window: shown, rows: browser, site: SITE.hits.join(', ') }];
});

/* ---------- undo after ending an agent (queue 4) ---------- */
await check('U1', 'end an agent, undo, reopen it: its conversation comes back', async () => {
  await pill(0);
  const folder = await ev(`(() => { const st = window.__flow.state(); return st.ws.find((w) => w.id === st.ui.at).folder; })()`);
  if (!String(folder).startsWith(L.WORK)) throw new Error(`not starting claude in ${folder}`);
  await L.until(page, `(() => { const t = window.__flow.term('w-design'); const s = t && t.getText(40); return s && !/trust this folder/.test(s) && /bypass permissions|for shortcuts|❯/.test(s); })()`, 90000, 300);
  // bring it to the front from its row, so the click lands in its terminal and not in a window over it
  const row0 = await rowAt(`x.dataset.act === 'win|w-design'`);
  if (row0) { await L.click(page, row0.x, row0.y); await L.sleep(900); }
  const r = await L.rect(page, '.win[data-id="w-design"] .termhost');
  const top = await ev(`(() => { const e = document.elementFromPoint(${r.x + r.w / 2}, ${r.y + r.h / 2}); return e && e.closest('.win') ? e.closest('.win').dataset.id : null; })()`);
  if (top !== 'w-design') throw new Error(`w-design is covered by ${top}`);
  await L.click(page, r.x + r.w / 2, r.y + r.h / 2);
  await typeSlow('Reply with exactly one word: kiwi');
  await L.sleep(1500);
  await L.key(page, 'Enter');
  await L.until(page, `window.__flow.term('w-design').getText(80).split('\\n').some((l) => /^\\s*[⏺●]/.test(l) && /kiwi/i.test(l))`, 180000, 500);
  const red = await L.rect(page, '.win[data-id="w-design"] .tb [data-l="close"]');
  await L.click(page, red.cx, red.cy);
  await L.sleep(800);
  const x = await ev(`(() => { const r = document.querySelector('#sblist [data-act="reopen|w-design"]'); if (!r) return null; r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const e = r.querySelector('[data-end], [data-del], [data-close]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!x) throw new Error('no × on the closed agent row');
  await L.mouse(page, 'mouseMoved', x.x, x.y);
  await L.sleep(200);
  await L.click(page, x.x, x.y);
  // "ended ... / undo" may take a few seconds under load until item 71 lands (flows' pending check times it)
  const tEnd = Date.now();
  await L.until(page, `[...document.querySelectorAll('.toast.on button')].some((x) => /undo/.test(x.innerText))`, 30000, 100).catch(() => null);
  const undoMs = Date.now() - tEnd;
  // the session may end behind the toast (item 71's fix); 6 s at most, so undo is still on screen (its toast lasts 8 s)
  for (let k = 0; k < 60 && !L.tmux('has-session', '-t', 'flow_w-design').match(/can't find|no server running/) != null; k++) await L.sleep(100);
  const killed = L.tmux('has-session', '-t', 'flow_w-design').match(/can't find|no server running/) != null;
  log('     undo showed after', undoMs, 'ms');
  const u = await ev(`(() => { const b = [...document.querySelectorAll('.toast.on button')].find((x) => /undo/.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, toast: document.getElementById('toast').innerText }; })()`);
  if (!u) {
    const now = await ev(`({ toast: (document.querySelector('.toast.on') || {}).innerText || null, rowBack: !!document.querySelector('#sblist [data-act="reopen|w-design"]') })`);
    return [false, { endedSession: killed, undo: 'no undo button', undoShowedAfterMs: undoMs, toastNow: now.toast, rowBack: now.rowBack, consoleErrors: page.errors.filter((e) => /end|kill/i.test(e)).slice(0, 3) }];
  }
  await L.click(page, u.x, u.y);
  await L.sleep(1000);
  const back = await rowAt(`x.dataset.act === 'reopen|w-design'`);
  if (!back) return [false, { endedSession: killed, toast: u.toast, rowBack: false }];
  await L.click(page, back.x, back.y);
  // back when the NEW pane shows the old reply: tmux itself, not the window's terminal widget, which can still hold the
  // screen from before the end
  let conv = false;
  for (let k = 0; k < 240 && !conv; k++) { conv = L.tmux('capture-pane', '-p', '-t', 'flow_w-design').split('\n').some((l) => /^\s*[⏺●]/.test(l) && /kiwi/i.test(l)); if (!conv) await L.sleep(500); }
  const start = L.tmux('list-panes', '-t', 'flow_w-design', '-F', '#{pane_start_command}').trim().replace(/.*claude. /, 'claude ').slice(0, 70);
  return [killed && conv, { endedSession: killed, toast: u.toast, rowBack: true, conversationBack: conv, start }];
});

/* ---------- undo and reopen at once (items 71 and 69, batch 5) ----------
   The owner ends an agent by mistake and at once clicks undo, then the row: the reopen lands while the old session is still
   being ended. Its conversation must come back in a new session, and that session must still be there 5 s later (the old
   kill must not take it). */
/* The claude processes holding a conversation, as orch's F checks count them (test/orch-suite.mjs:506-512): --session-id
   or --resume with that id in the args, and only claude's own binary, not the shell line around it. Async, so sampling
   it never holds up the clicks. */
const claudesOf = (sid) => new Promise((resolve) => execFile('ps', ['-eo', 'pid=,args='], { maxBuffer: 1 << 24 }, (err, out) => {
  if (err) { resolve(null); return; }
  const re = new RegExp(`(^|\\s)(--session-id|--resume)\\s+${sid}(\\s|$)`);
  resolve(out.split('\n').map((l) => l.trim()).filter((l) => l && re.test(l)).map((l) => +l.split(/\s+/)[0]).filter((pid) => { try { const exe = fs.readlinkSync(`/proc/${pid}/exe`); return /\/claude\/versions\//.test(exe) || path.basename(exe) === 'claude'; } catch { return false; } }));
}));
await check('U2', 'end an agent, undo and reopen it at once: one claude on its conversation at any time, and it comes back and stays', async () => {
  await pill(0);
  const folder = await ev(`(() => { const st = window.__flow.state(); return st.ws.find((w) => w.id === st.ui.at).folder; })()`);
  if (!String(folder).startsWith(L.WORK)) throw new Error(`not starting claude in ${folder}`);
  await L.until(page, `(() => { const t = window.__flow.term('w-design'); const s = t && t.getText(40); return s && !/trust this folder/.test(s) && /bypass permissions|for shortcuts|❯/.test(s); })()`, 90000, 300);
  const row0 = await rowAt(`x.dataset.act === 'win|w-design'`);
  if (row0) { await L.click(page, row0.x, row0.y); await L.sleep(900); }
  const r = await L.rect(page, '.win[data-id="w-design"] .termhost');
  await L.click(page, r.x + r.w / 2, r.y + r.h / 2);
  await typeSlow('Reply with exactly one word: kiwi');
  await L.sleep(1500);
  await L.key(page, 'Enter');
  await L.until(page, `window.__flow.term('w-design').getText(80).split('\\n').some((l) => /^\\s*[⏺●]/.test(l) && /kiwi/i.test(l))`, 180000, 500);
  const red = await L.rect(page, '.win[data-id="w-design"] .tb [data-l="close"]');
  await L.click(page, red.cx, red.cy);
  await L.sleep(800);
  const x = await ev(`(() => { const r = document.querySelector('#sblist [data-act="reopen|w-design"]'); if (!r) return null; r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const e = r.querySelector('[data-end], [data-del], [data-close]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!x) throw new Error('no × on the closed agent row');
  await L.mouse(page, 'mouseMoved', x.x, x.y);
  await L.sleep(200);
  const pid0 = L.tmux('list-panes', '-t', 'flow_w-design', '-F', '#{pane_pid}').trim();
  const sid = await ev(`(() => { for (const ws of window.__flow.state().ws) { const w = [...ws.windows, ...(ws.closed || [])].find((x) => x.id === 'w-design'); if (w) return w.sessionId; } return null; })()`);
  if (!sid || !/^[0-9a-f-]{36}$/i.test(sid)) throw new Error(`no session id for w-design: ${sid}`);
  const samples = [];
  let sampling = true;
  const t0 = Date.now();
  const sampler = (async () => { while (sampling) { const pids = await claudesOf(sid); if (pids) samples.push([Date.now() - t0, pids.length, pids.join(',')]); await L.sleep(20); } })();
  await L.click(page, x.x, x.y);
  // undo the moment it can be clicked, then the row the moment it is back
  const u = (await L.until(page, `(() => { const b = [...document.querySelectorAll('.toast.on button')].find((x) => /undo/.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, 30000, 20)).v;
  await L.click(page, u.x, u.y);
  const back = (await L.until(page, `(() => { const el = document.querySelector('#sblist [data-act="reopen|w-design"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`, 10000, 20)).v;
  const oldAlive = L.tmux('has-session', '-t', 'flow_w-design').match(/can't find|no server running/) == null;
  await L.click(page, back.x, back.y);
  const reopenMs = Date.now() - t0;
  // what the new pane itself shows (tmux, not the window's terminal widget, which can still hold the old screen), and
  // 30 s of counting after the reopen
  const paneText = () => L.tmux('capture-pane', '-p', '-t', 'flow_w-design').split('\n').map((l) => l.trim()).filter(Boolean);
  const paneAt = {};
  for (const at of [1000, 5000, 10000, 20000, 30000]) {
    await L.sleep(Math.max(0, at - (Date.now() - t0 - reopenMs)));
    const lines = paneText();
    paneAt[at] = { kiwi: lines.some((l) => /^[⏺●]/.test(l) && /kiwi/i.test(l)), last: lines.slice(-2).join(' | ').slice(0, 120) };
  }
  sampling = false;
  await sampler;
  const most = samples.reduce((m, x) => Math.max(m, x[1]), 0);
  const changes = samples.filter((x, i) => i === 0 || x[1] !== samples[i - 1][1] || x[2] !== samples[i - 1][2]).map(([t, n, pids]) => `${t}ms:${n}${pids ? '(' + pids + ')' : ''}`);
  log(`     claudes on ${sid}: ${samples.length} samples, at most ${most}; changes: ${changes.join(' ')}`);
  // the conversation is back when the NEW pane shows the old reply (claude resumed it there)
  const conv = Object.values(paneAt).some((x) => x.kiwi);
  const first = samples.length ? samples[0][2].split(',') : [];
  const newClaudeAt = samples.find((x) => x[2] && x[2].split(',').some((q) => !first.includes(q)));
  const pid1 = L.tmux('list-panes', '-t', 'flow_w-design', '-F', '#{pane_pid}').trim();
  const alive = !!pid1 && !/can't find|no server running/.test(pid1);
  const win = await ev(`!!document.querySelector('.win[data-id="w-design"]')`);
  const start = alive ? L.tmux('list-panes', '-t', 'flow_w-design', '-F', '#{pane_start_command}').trim().replace(/.*claude. /, 'claude ').slice(0, 70) : null;
  log('     shot', await L.shot(page, `${label}-u2-fast-reopen`));
  return [most <= 1 && conv && alive && win && pid1 !== pid0, { mostClaudesAtOnce: most, samples: samples.length, newClaudeFromMs: newClaudeAt ? newClaudeAt[0] : null, newPane: paneAt, reopenedAfterMs: reopenMs, oldSessionStillThereAtReopen: oldAlive, conversationBack: conv, aliveAfter: alive, windowThere: win, panePid: [pid0, pid1], start }];
});

/* ---------- a quit: what batch 2 adds comes back ---------- */
async function relaunch(n) {
  page.ws.close();
  page = null;
  log(await L.stop());
  await L.sleep(1000);
  await L.launch(`${label}-${n}`);
  page = await L.connect();
  await L.until(page, 'window.__flow && 1', 30000);
  await ev('window.__flow.ready');
  await L.sleep(4000);
}
await check('Q1', 'after a quit: the page note, the page name, the room and the unfolded files come back', async () => {
  const s0 = { rows: await rows(), geo: await winGeo('w-design') };
  await relaunch(2);
  const r1 = await rows();
  const keep = (re) => s0.rows.some((t) => re.test(t)) && r1.some((t) => re.test(t));
  const note = /flows page note/.test(JSON.stringify(await ev('window.__flow.state()')));
  log('     shot', await L.shot(page, `${label}-q1-after-quit`));
  return [keep(/flows example/) && keep(/flows-notes\.txt/) && note, { pageName: keep(/flows example/), filesUnfolded: keep(/flows-notes\.txt/), pageNote: note }];
});

await check('N3', 'after a quit, a named page whose address now redirects comes back with its name', async () => {
  await pill(0);
  const kid = await newPageAt(`${SITE_AT}/keep`);
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(kid)}); return p && !p.isLoading() && /flows keep/.test(p.getTitle() || ''); })()`, 20000, 250);
  await L.sleep(600);
  await renameRow(`/flows keep/.test(x.innerText) && /↗/.test(x.innerText)`, 'flows kept name');
  const named = await shownName(kid);
  SITE.keep = true;
  const hits0 = SITE.hits.length;
  await relaunch(3);
  // the restored tab loads once its window shows: its row brings it into view
  const r = await rowAt(`/flows kep/.test(x.innerText) && /↗/.test(x.innerText)`);
  if (r) await L.click(page, r.x, r.y);
  const at = (await landed(kid, '/\\/kept$/', 20000)).v;
  await L.sleep(1200);
  const shown = await shownName(kid);
  const browser = (await rows()).filter((t) => /flows kep/.test(t));
  log('     shot', await L.shot(page, `${label}-n3-restored`));
  return [/flows kept name/.test(named) && /flows kept name/.test(shown) && browser.length > 0 && browser.every((t) => /flows kept name/.test(t)), { namedBefore: named, landedAt: at, window: shown, rows: browser, siteAfterRelaunch: SITE.hits.slice(hits0).join(', ') }];
});

/* ---------- organizing is moving a tool to the sub-workspace it serves (OWNER_ASKS.md:19-24, cli-code-manager-live.md:245) ----------
   STATUS item 55 (lead, layout, batch 5): a window moved to a sub-workspace keeps its size and never covers another; it
   takes a free spot in that sub-workspace's view if one fits, otherwise the end of that space, and nothing there moves;
   the same for every way of moving a tool there (landed in batch 5). */
const goalLayout = (zid) => ev(`(() => { const ws = window.__flow.state().ws.find((w) => w.id === 'flow'); const z = (ws.zones || []).find((x) => x.id === ${JSON.stringify(zid)}); const vw = document.getElementById('viewport').getBoundingClientRect().width; return { view: +(${L.PANPX}(ws, z, 'x') / vw * 100).toFixed(2), wins: Object.fromEntries(ws.windows.filter((w) => w.zone === ${JSON.stringify(zid)}).map((w) => [w.id, { x: +w.x.toFixed(2), y: +w.y.toFixed(2), w: +w.w.toFixed(2), h: +w.h.toFixed(2) }])) }; })()`);
const sizeOf = (id) => ev(`(() => { for (const ws of window.__flow.state().ws) { const w = ws.windows.find((x) => x.id === ${JSON.stringify(id)}); if (w) return { w: +w.w.toFixed(2), h: +w.h.toFixed(2) }; } return null; })()`);
function rule55(id, size0, before, after) {
  const m = after.wins[id];
  if (!m) return { ok: false, notInGoal: true };
  const others = Object.entries(after.wins).filter(([k]) => k !== id);
  const covers = others.map(([k, w]) => [k, +((Math.max(0, Math.min(w.x + w.w, m.x + m.w) - Math.max(w.x, m.x)) * Math.max(0, Math.min(w.y + w.h, m.y + m.h) - Math.max(w.y, m.y))) / (w.w * w.h)).toFixed(2)]);
  const othersMoved = others.filter(([k, w]) => before.wins[k] && JSON.stringify(before.wins[k]) !== JSON.stringify(w)).map(([k]) => k);
  const inView = m.x >= after.view - 0.1 && m.x + m.w <= after.view + 100 + 0.1;
  const atEnd = m.x >= Math.max(0, ...others.map(([, w]) => w.x + w.w)) - 0.1;
  const sizeKept = Math.abs(m.w - size0.w) < 0.1 && Math.abs(m.h - size0.h) < 0.1;
  return { ok: sizeKept && covers.every(([, c]) => c === 0) && othersMoved.length === 0 && (inView || atEnd), at: m, sizeKept, covers, othersMoved, inView, atEnd };
}
const researchId = () => ev(`(() => { const ws = window.__flow.state().ws.find((w) => w.id === 'flow'); const z = (ws.zones || []).find((x) => /research/.test(x.name)); return z ? z.id : null; })()`);
const onScreenOf = (id) => ev(`(() => { const el = document.querySelector('.win[data-id="${id}"]'); if (!el || el.offsetParent === null) return 0; const r = el.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left)), h = Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)); return +((w * h) / Math.max(1, r.width * r.height)).toFixed(2); })()`);
await check('M1', 'a page moved to a sub-workspace from its menu lives there, keeps its size and covers nothing (item 55)', async () => {
  await pill(0);
  const rz = await researchId();
  if (!rz) throw new Error('no research sub-workspace in flow');
  const url0 = await ev(`window.__flow.page(${JSON.stringify(S.ex)}).getURL()`);
  const size0 = await sizeOf(S.ex), before = await goalLayout(rz);
  const tb = await L.rect(page, `.win[data-id="${S.ex}"] .tb .title`);
  await rclick(tb.cx, tb.cy);
  await menuClick('/move to research/');
  await L.sleep(1200);
  const g = await winGeo(S.ex);
  const inMain = await onScreenOf(S.ex);
  const s = await emptySpot();
  await L.swipe(page, s.x, s.y, [30, 40, 50, 40, 30, 20]);
  await L.sleep(1500);
  const at = await ev(`window.__flow.state().ws.find((w) => w.id === 'flow').at || null`);
  const inGoal = await onScreenOf(S.ex);
  const url1 = await ev(`(() => { const p = window.__flow.page(${JSON.stringify(S.ex)}); return p ? p.getURL() : null; })()`);
  const r55 = rule55(S.ex, size0, before, await goalLayout(rz));
  log('     shot', await L.shot(page, `${label}-m1-in-research`));
  await pill(0);
  // in view after the swipe only if it took a free spot there; at the end it may be off screen
  return [g && g.zone === rz && inMain === 0 && at === rz && (inGoal > 0.5 || r55.atEnd) && url1 === url0 && r55.ok, { zone: g && g.zone, onScreenInMain: inMain, swipedTo: at, onScreenInResearch: inGoal, url: [url0, url1], item55: r55 }];
});
await check('M2', 'a page row dragged onto a sub-workspace in the sidebar moves it there, by the same rule (item 55)', async () => {
  await pill(0);
  const rz = await researchId();
  // a page of its own in the main space (earlier checks file the seed's pages into sections)
  const id = await newPageAt('https://example.com/');
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(id)}); return p && !p.isLoading() && /Example/.test(p.getTitle() || ''); })()`, 30000, 250);
  await L.sleep(800);
  const src = await ev(`(() => { const el = document.querySelector('#sblist .tr[data-drag^="page|${id}|"]'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2, drag: el.dataset.drag }; })()`);
  if (!src) throw new Error(`no row to drag for ${id}`);
  const size0 = await sizeOf(id), before = await goalLayout(rz);
  await L.mouse(page, 'mouseMoved', src.x, src.y);
  await L.sleep(300);
  await page.send('Input.setInterceptDrags', { enabled: true });
  const data = await new Promise(async (resolve) => {
    page.on((m) => { if (m.method === 'Input.dragIntercepted') resolve(m.params.data); });
    await L.mouse(page, 'mousePressed', src.x, src.y);
    for (let i = 1; i <= 6; i++) await L.mouse(page, 'mouseMoved', src.x + i * 2, src.y + i * 2, { down: true });
    setTimeout(() => resolve(null), 3000);
  });
  if (!data) { await L.mouse(page, 'mouseReleased', src.x, src.y); await page.send('Input.setInterceptDrags', { enabled: false }); throw new Error('the page row did not start a drag'); }
  const dst = await ev(`(() => { const el = document.querySelector('#sblist .tr[data-drop="zone|${rz}"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (!dst) { await page.send('Input.setInterceptDrags', { enabled: false }); throw new Error('no research row to drop on'); }
  await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: dst.x, y: dst.y, data });
  await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: dst.x, y: dst.y, data });
  await L.sleep(200);
  await page.send('Input.dispatchDragEvent', { type: 'drop', x: dst.x, y: dst.y, data });
  await L.mouse(page, 'mouseReleased', dst.x, dst.y);
  await page.send('Input.setInterceptDrags', { enabled: false });
  await L.sleep(1200);
  const g = await winGeo(id);
  const r55 = rule55(id, size0, before, await goalLayout(rz));
  return [!!g && g.zone === rz && r55.ok, { dragged: src.drag, zone: g && g.zone, item55: r55 }];
});

if (page) { const errs = page.errors.filter((e) => !/favicon|ERR_ABORTED/.test(e)); if (errs.length) log('page errors:', errs.slice(0, 8).join(' | ')); page.ws.close(); }
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
server.close();
const n = (v) => res.filter((r) => r.ok === v).length;
log(`summary: ${n(true)} ok, ${n(false)} BAD, ${n(null)} ERR`);
// a BAD or an ERR fails the run
process.exitCode = n(true) > 0 && n(false) + n(null) === 0 ? 0 : 1;
fs.writeFileSync(path.join(L.EVID, `${label}.log`), out.join('\n') + '\n');




