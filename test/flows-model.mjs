// flows: Flow checked against each line of BRIEF 3.0 "The Flow model since Nov 1", in flows' own app with real input.
// Shells, notes and pages only (no claude). Fresh seed every run. node test/flows-model.mjs [label]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from './flows-lib.mjs';

const label = process.argv[2] || 'model';
const T0 = Date.now();
const out = [];
const log = (...a) => { const s = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`; console.log(s); out.push(s); };
const res = [];
let page = null;
const ev = (e) => L.ev(page, e);
const verdict = (id, line, ok, detail) => { res.push({ id, line, ok, detail }); log(`${ok === true ? 'ok  ' : ok === false ? 'BAD ' : 'ERR '} ${id} ${line}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const ONLY = process.env.FLOWS_ONLY ? process.env.FLOWS_ONLY.split(',') : null;
async function check(id, line, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  try { const [ok, detail] = await fn(); verdict(id, line, ok, detail); } catch (e) { verdict(id, line, null, e.message.split('\n')[0]); if (page) { try { log('     shot', await L.shot(page, `${label}-err-${id}`)); } catch (_) { /* gone */ } } }
}
const ids = () => ev(`window.__flow.windows().map((w) => w.id)`);
const newWin = async (before, ms = 10000) => (await L.until(page, `window.__flow.windows().map((w) => w.id).filter((w) => !${JSON.stringify(before)}.includes(w))[0]`, ms)).v;
const state = () => ev('window.__flow.state()');
const cur = async () => { const st = await state(); return st.ws.find((w) => w.id === st.ui.at); };
const winGeo = (id) => ev(`(() => { for (const ws of window.__flow.state().ws) { const w = ws.windows.find((x) => x.id === ${JSON.stringify(id)}); if (w) return { ws: ws.id, x: +w.x, y: +w.y, w: +w.w, h: +w.h, noteId: w.noteId, space: w.zone || w.space || w.sub || null }; } return null; })()`);
const onScreen = (id) => ev(`(() => { const el = document.querySelector('.win[data-id="${id}"]'); if (!el || el.offsetParent === null) return 0; const r = el.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left)), h = Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)); return +((w * h) / Math.max(1, r.width * r.height)).toFixed(2); })()`);
async function rclick(x, y) {
  await L.mouse(page, 'mouseMoved', x, y);
  await L.mouse(page, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await L.mouse(page, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
  await L.sleep(450);
}
const menu = () => ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.innerText.replace(/\\n/g, ' '))`);
async function menuClick(re) {
  const b = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => ${re}.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  if (!b) throw new Error(`no menu item ${re}; menu: ${JSON.stringify(await menu())}`);
  await L.click(page, b.x, b.y);
}
async function dock(k) {
  const vp = await L.rect(page, '#viewport');
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h - 6);
  await L.sleep(500);
  const b = await L.rect(page, `#dock button[data-k="${k}"]`);
  await L.mouse(page, 'mouseMoved', b.cx, b.cy);
  await L.sleep(200);
  await L.click(page, b.cx, b.cy);
}
async function sideClick(match) {
  const r = await ev(`(() => { const el = [...document.querySelectorAll('#sblist .tr, #sblist [data-act]')].find((x) => ${match}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error(`no sidebar row matching ${match}`);
  await L.click(page, r.x, r.y);
  await L.sleep(900);
}
async function pill(i) { const p = await L.rect(page, `#spaces .sp[data-i="${i}"]`); await L.click(page, p.x + 8, p.cy); await L.sleep(900); }
async function emptySpot() {
  return ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.top + 60; y < v.bottom - 140; y += 40) for (let x = v.left + 30; x < v.right - 30; x += 40) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .zl, #dock, .ctx, .toast')) return { x, y }; } return null; })()`);
}
async function emptySpotRight() {
  return ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let x = v.right - 30; x > v.left + 30; x -= 30) for (let y = v.top + 60; y < v.bottom - 140; y += 40) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .zl, #dock, .ctx, .toast')) return { x, y }; } return null; })()`);
}
async function shellAt(spot) {
  const before = await ids();
  await rclick(spot.x, spot.y);
  await menuClick('/new shell/');
  const sid = await newWin(before);
  await L.until(page, `/[%$#][\\s·.]*$/m.test(window.__flow.term(${JSON.stringify(sid)}).getText(8))`, 20000);
  return sid;
}
async function clickText(sid, needle) {
  const pos = await ev(`(() => { const el = document.querySelector('.win[data-id="${sid}"] .xterm-screen'); const rows = document.querySelectorAll('.win[data-id="${sid}"] .xterm-rows > div'); for (let i = rows.length - 1; i >= 0; i--) { const t = rows[i].textContent; const k = t.indexOf(${JSON.stringify(needle)}); if (k >= 0 && !/echo/.test(t)) { const r = el.getBoundingClientRect(); const cw = r.width / window.__flow.term(${JSON.stringify(sid)}).cols; const rh = r.height / rows.length; return { x: r.left + (k + 5) * cw, y: r.top + (i + 0.5) * rh }; } } return null; })()`);
  if (!pos) throw new Error(`${needle} is not on the terminal's screen`);
  await L.mouse(page, 'mouseMoved', pos.x, pos.y);
  await L.sleep(250);
  await L.click(page, pos.x, pos.y);
}
// which windows belong to a sub-workspace: a field on the window, a list on the zone, or (old model) its center in the zone
const membersOf = (zid) => ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => (w.zones || []).some((z) => z.id === ${JSON.stringify(zid)})); if (!ws) return []; const z = ws.zones.find((x) => x.id === ${JSON.stringify(zid)}); const listed = (z.windows || []).map((w) => w.id || w); const tagged = ws.windows.filter((w) => [w.zone, w.space, w.sub].includes(z.id)).map((w) => w.id); const geom = ws.windows.filter((w) => { const cx = w.x + w.w / 2, cy = w.y + w.h / 2; return z.x != null && cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h; }).map((w) => w.id); return [...new Set([...listed, ...tagged, ...(listed.length || tagged.length ? [] : geom)])]; })()`);
const webviews = async () => { const by = {}; (await L.targets()).filter((x) => x.type === 'webview').forEach((x) => { const k = x.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40); by[k] = (by[k] || 0) + 1; }); return by; };
const pageTargets = async () => (await L.targets()).filter((t) => t.type === 'page' && /index\.html/.test(t.url)).map((t) => t.url.replace(/^.*index\.html/, '') || 'main');
async function guestEval(re, expr) {
  const t = (await L.targets()).find((x) => x.type === 'webview' && re.test(x.url));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('guest')); });
  const v = await new Promise((r) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result && d.result.result ? d.result.result.value : undefined); }; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  ws.close();
  return v;
}
async function pageWindowIn(name) {
  await L.pointClick(page, '#addws');
  await L.sleep(500);
  await L.type(page, name);
  await L.key(page, 'Enter');
  await L.sleep(800);
  const spot = await emptySpot();
  if (!spot) throw new Error('no empty desktop in the new workspace');
  const before = await ids();
  await rclick(spot.x, spot.y);
  await menuClick('/new page/');
  const pid = await newWin(before);
  await L.sleep(400);
  return pid;
}
async function relaunch(how) {
  page.ws.close();
  page = null;
  log(await L.stop({ kill9: how === 'crash' }));
  await L.sleep(1000);
  await L.launch(`${label}-${how}`);
  page = await L.connect();
  await L.until(page, 'window.__flow && 1', 30000);
  await ev('window.__flow.ready');
  await L.sleep(3000);
}

/* ---------- start ---------- */
log('tree:', spawnSync('sh', ['-c', `cd ${L.APP} && md5sum src/*.js src/index.html | cut -c1-8,33- | tr "\\n" " "`], { encoding: 'utf8' }).stdout);
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
// the shell-only seed: claude windows of the seed become shells, so this pass starts no claude
const seedRun = spawnSync('node', [path.join(L.ROOT, 'test/flows-seed.mjs')], { encoding: 'utf8', cwd: L.ROOT });
if (seedRun.status) throw new Error(`seed failed: ${seedRun.stderr}`);
{
  const f = path.join(L.UD, 'flow-state.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const ws of st.ws) for (const w of [...ws.windows, ...(ws.closed || [])]) if (w.cmd === 'claude') { w.cmd = 'shell'; delete w.sessionId; }
  fs.writeFileSync(f, JSON.stringify(st));
}
fs.rmSync(path.join(L.UD, 'Preferences'), { force: true });
await L.launch(`${label}-1`);
page = await L.connect();
await L.until(page, 'window.__flow && 1', 30000);
await ev('window.__flow.ready');
await L.sleep(2500);
log('shot', await L.shot(page, `${label}-00-start`));

/* ---------- line 5: chrome only on demand ---------- */
await check('5.1', 'no help card, no minimap, no status marks', async () => {
  const vp = await L.rect(page, '#viewport');
  await L.drag(page, { x: vp.x + vp.w - 40, y: vp.y + vp.h / 2 }, { x: vp.x + vp.w - 300, y: vp.y + vp.h / 2 }, { steps: 8 });
  await L.sleep(200);
  const f = await ev(`({ help: !!document.querySelector('#help, .help, #helpbtn'), minimap: [...document.querySelectorAll('#mmap, .mmap')].some((e) => getComputedStyle(e).opacity > 0.05 && e.offsetWidth > 0), marks: document.querySelectorAll('.attn, [data-attn]').length })`);
  const drawn = await ev(`document.querySelectorAll('#sblist .tr').length > 0 && document.querySelectorAll('.win').length > 0`);
  return [drawn && !f.help && !f.minimap && !f.marks, { ...f, drawn }];
});
await check('5.2', 'the dock appears only at the bottom middle', async () => {
  const vp = await L.rect(page, '#viewport');
  const vis = () => ev(`(() => { const d = document.getElementById('dock'); if (!d) return 'none'; const cs = getComputedStyle(d), r = d.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.15 && r.top < v.bottom - 4 && r.bottom > v.top; })()`);
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h / 2);
  await L.sleep(900);
  const away = await vis();
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h - 6);
  await L.sleep(900);
  const near = await vis();
  return [away === false && near === true, { pointerInMiddle: away, pointerAtBottomMiddle: near }];
});
await check('5.3', 'a title or row says where only for remote windows', async () => {
  const hits = await ev(`[...document.querySelectorAll('.win .tb, #sblist .tr')].filter((e) => /this Mac/.test(e.innerText)).length`);
  const drawn = await ev(`document.querySelectorAll('#sblist .tr').length > 0 && document.querySelectorAll('.win .tb').length > 0`);
  return [drawn && hits === 0, `${hits} titles or rows say "this Mac"${drawn ? '' : ' (nothing drawn)'}`];
});
await check('5.4', 'right-click a workspace: background, folder, runs on, rename, delete', async () => {
  const p = await L.rect(page, '#spaces .sp[data-i="0"]');
  await rclick(p.x + 10, p.cy);
  // the workspace menu is wsbg.js's .wsm (headers and rows), not the agent menu .ctx
  const m = await ev(`[...document.querySelectorAll('.wsm .bh, .wsm .row')].map((e) => e.firstChild ? e.firstChild.textContent.trim() : e.textContent.trim())`);
  const swatches = await ev(`document.querySelectorAll('.wsm .bs button').length`);
  await L.key(page, 'Escape');
  const want = ['background', 'folder', 'runs on', 'rename', 'delete'];
  const missing = want.filter((w) => !m.some((x) => x.toLowerCase().includes(w)));
  return [missing.length === 0 && swatches > 0, { menu: m, gradients: swatches, missing }];
});

/* ---------- line 4: sidebar ---------- */
await check('4.1', 'sidebar order: agents, notes, browser, sub-workspaces last; pages not under notes', async () => {
  await pill(0);
  const g = await ev(`[...document.querySelectorAll('#sblist .grp')].map((x) => x.textContent.trim().toLowerCase())`);
  const order = ['agents', 'notes', 'browser', 'sub-workspaces'];
  const present = g.filter((x) => order.includes(x));
  const sorted = [...present].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const pagesUnderNotes = await ev(`(() => { let grp = ''; let n = 0; for (const el of document.querySelectorAll('#sblist .grp, #sblist .tr')) { if (el.classList.contains('grp')) grp = el.textContent.trim().toLowerCase(); else if (grp === 'notes' && /^↗/.test(el.innerText.trim())) n++; } return n; })()`);
  return [present.join() === sorted.join() && g.includes('browser') && pagesUnderNotes === 0, { groups: g, pagesUnderNotes }];
});
await check('4.2', 'notes and pages: "+ new section", shown while the pointer is over the group (batch 2)', async () => {
  // a "+ new section" row (batch 1), or the "+" at the right of the group's heading (batch 2 final, title "new section")
  const shown = () => ev(`/new section/i.test(document.getElementById('sblist').innerText) || [...document.querySelectorAll('#sblist .grp .gadd[data-make^="newsec|"]')].some((x) => x.offsetWidth > 0 && getComputedStyle(x).visibility !== 'hidden')`);
  const vp = await L.rect(page, '#viewport');
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h / 2);
  await L.sleep(400);
  const always = await shown();
  const g = await ev(`(() => { const el = [...document.querySelectorAll('#sblist .grp')].find((x) => /notes/.test(x.textContent)); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (g) { await L.mouse(page, 'mouseMoved', g.x, g.y); await L.sleep(500); }
  const hover = await shown();
  return [hover, { alwaysShown: always, shownOnHover: hover }];
});
await check('4.3', 'every row drags (onto a pill, a sub-workspace or a section)', async () => {
  const r = await ev(`(() => { const rows = [...document.querySelectorAll('#sblist .tr')].filter((x) => /^(›_|◫|✎|↗)/.test(x.innerText.trim())); return { toolRows: rows.length, notDraggable: rows.filter((x) => !x.draggable && !x.closest('[draggable="true"]')).map((x) => x.innerText.split('\\n')[0].slice(0, 30)) }; })()`);
  return [r.notDraggable.length === 0, r];
});
await check('4.4', 'no word "bookmark" anywhere', async () => {
  const dom = await ev(`(() => { const t = document.body.innerText + ' ' + [...document.querySelectorAll('[title], [placeholder]')].map((e) => (e.title || '') + ' ' + (e.placeholder || '')).join(' '); return (t.match(/bookmark/gi) || []).length; })()`);
  const code = spawnSync('grep', ['-n', '-E', "act\\('[^']*[Bb]ookmark|label: *'[^']*[Bb]ookmark", ...['main.js', 'app.js', 'page.js'].map((f) => path.join(L.ROOT, 'src', f))], { encoding: 'utf8' }).stdout.trim();
  const drawn = await ev(`document.querySelectorAll('#sblist .tr').length > 0`);
  return [drawn && dom === 0 && !code, { inTheWindow: dom, menuLabels: code || 'none', drawn }];
});

/* ---------- line 1 and 3: spaces, and tools made in a space ---------- */
await check('1.1', 'panning the main area never reaches a sub-workspace', async () => {
  await pill(0);
  const members = await membersOf('z-research');
  const vp = await L.rect(page, '#viewport');
  let drags = 0, last = -1;
  for (let i = 0; i < 14; i++) {
    const s = await emptySpotRight();
    if (!s || s.x - (vp.x + 20) < 60) break;
    await L.drag(page, { x: s.x, y: s.y }, { x: vp.x + 20, y: s.y }, { steps: 10 });
    drags++;
    await L.sleep(500);
    const p = await ev(`(() => { const st = window.__flow.state(), ws = st.ws.find((w) => w.id === st.ui.at); return ${L.PANPX}(ws, null, 'x'); })()`);
    if (Math.abs(p - last) < 2) break;
    last = p;
  }
  if (!drags) throw new Error('found no empty desktop to drag');
  await L.sleep(800);
  const seen = [];
  for (const id of members) if ((await onScreen(id)) > 0) seen.push(id);
  const shot = await L.shot(page, `${label}-1.1-main-panned`);
  return [members.length > 0 && seen.length === 0, { researchWindows: members, onScreenFromMain: seen, drags, pan: (await cur()).pan, shot }];
});
await check('3.1', 'a note made while viewing a sub-workspace lives in it', async () => {
  await sideClick(`x.dataset.act === 'zone|z-research' || /research/.test(x.innerText) && /◳/.test(x.innerText)`);
  const before = await ids();
  await dock('note');
  const id = await newWin(before);
  await L.sleep(500);
  await L.key(page, 'Escape');
  const m = await membersOf('z-research');
  return [m.includes(id), { note: await winGeo(id), researchMembers: m }];
});
await check('3.2', 'every window shows its title once', async () => {
  await pill(0);
  const r = await ev(`(() => { const out = {}; for (const el of document.querySelectorAll('.win.note, .win.page')) { if (el.offsetParent === null) continue; const tb = el.querySelector('.tb .title'); const t = tb ? tb.textContent.trim() : ''; if (!t) continue; const n = [...el.querySelectorAll('.tb .title, .ntitle, .ptitle, h1, h2')].filter((x) => x.offsetHeight > 0 && x.textContent.trim() === t).length; if (n > 1) out[el.dataset.id] = n; } return out; })()`);
  return [Object.keys(r).length === 0, Object.keys(r).length ? { titleShownTimes: r } : 'once'];
});
await check('3.3', "a page window holds only the page and its tabs; its note is behind ✎, closed", async () => {
  const r = await ev(`(() => { const el = [...document.querySelectorAll('.win.page')].find((e) => e.offsetParent !== null); if (!el) return null; const note = el.querySelector('.pnote'); return { noteShown: !!(note && note.offsetHeight > 0 && !el.querySelector('.pnote').closest('[hidden]')), pencil: !!el.querySelector('.tb [data-act="note"], .tb .act[title*="note"]'), id: el.dataset.id }; })()`);
  if (!r) throw new Error('no page window on screen');
  return [!r.noteShown && r.pencil, r];
});

/* ---------- line 3: a link from a terminal opens beside it, later links as tabs there ---------- */
await check('3.4b', 'the next link from that terminal opens as a tab in that page window', async () => {
  await pill(0);
  const spot = await emptySpot();
  if (!spot) throw new Error('no empty spot');
  const sid = await shellAt(spot);
  await L.type(page, 'echo https://example.org/ https://example.com/');
  await L.key(page, 'Enter');
  await L.sleep(1000);
  const b1 = await ids();
  await clickText(sid, 'https://example.org/');
  const pid = await newWin(b1);
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(pid)}); return p && !p.isLoading(); })()`, 30000, 200);
  const s = await winGeo(sid), p = await winGeo(pid);
  const beside = Math.abs(p.x - (s.x + s.w)) < 4 && p.y < s.y + s.h && p.y + p.h > s.y;
  const both = [await onScreen(sid), await onScreen(pid)];
  const covered = await ev(`(() => { const a = document.querySelector('.win[data-id="${sid}"]').getBoundingClientRect(), b = document.querySelector('.win[data-id="${pid}"]').getBoundingClientRect(); const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); return +((w * h) / (a.width * a.height)).toFixed(2); })()`);
  verdict('3.4a', 'a link from a terminal opens beside it, not over it', beside && covered < 0.05, { beside, shellCoveredByThePage: covered });
  // the terminal back in front, as from its sidebar row, then its second link
  await sideClick(`x.dataset.act === 'win|${sid}'`);
  const b2 = await ids();
  await clickText(sid, 'https://example.com/');
  await L.sleep(2500);
  const extra = (await ids()).filter((x) => !b2.includes(x));
  const tabs = await ev(`document.querySelectorAll('.win[data-id="${pid}"] .ptabs .ptab').length`);
  return [extra.length === 0 && tabs >= 2, { secondLinkNewWindows: extra.length, tabsInFirstPage: tabs, shell: s, page: p, shot: await L.shot(page, `${label}-3.4-links`) }];
});

/* ---------- line 3: a clip lands in the page's note and links back to the sentence ---------- */
await check('3.5', "a clip lands in the page's note and links back to the sentence", async () => {
  const pid = await pageWindowIn('model clip');
  await L.type(page, 'example.org');
  await L.key(page, 'Enter');
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(pid)}); return p && !p.isLoading() && /Example Domain/.test(p.getTitle() || ''); })()`, 30000, 200);
  await L.sleep(800);
  const pv = await L.rect(page, `.win[data-id="${pid}"] webview`);
  const w = await guestEval(/example\.org/, `(() => { const p = document.querySelector('p'); const r = document.createRange(); r.selectNodeContents(p.firstChild); const b = r.getClientRects()[0]; return { x: b.left + 12, y: b.top + b.height / 2, iw: innerWidth }; })()`);
  if (!w) throw new Error('could not find the paragraph in the page');
  const k = pv.w / w.iw, hx = pv.x + w.x * k, hy = pv.y + w.y * k;
  await L.mouse(page, 'mouseMoved', hx, hy);
  await L.mouse(page, 'mousePressed', hx, hy, { clickCount: 1 });
  await L.mouse(page, 'mouseReleased', hx, hy, { clickCount: 1 });
  await L.mouse(page, 'mousePressed', hx, hy, { clickCount: 2 });
  await L.mouse(page, 'mouseReleased', hx, hy, { clickCount: 2 });
  await L.sleep(700);
  const sel = await guestEval(/example\.org/, 'String(getSelection())');
  const clip = await L.rect(page, `.win[data-id="${pid}"] .pclip, .win[data-id="${pid}"] [data-clip]`);
  if (!clip) throw new Error('no clip button on the page');
  await L.click(page, clip.cx, clip.cy);
  await L.sleep(900);
  // the note as shown in the window's ✎ pane (batch 2 keeps a page's note in the page's own record, by its url)
  await L.sleep(600);
  const pane = await ev(`(() => { const w = document.querySelector('.win[data-id="${pid}"]'); const a = w.querySelector('.anote'); return { text: a ? a.innerText : '', clipLinks: w.querySelectorAll('.fnote-clip').length, open: w.classList.contains('noted') }; })()`);
  let body = pane.text;
  if (!body) { const nid = (await winGeo(pid)).noteId; body = await ev(`(() => { for (const ws of window.__flow.state().ws) { const n = ws.notes.find((x) => x.id === ${JSON.stringify(nid)}); if (n) return n.body || ''; } return ''; })()`); }
  const marks = await guestEval(/example\.org/, `(() => (window.CSS && CSS.highlights ? [...CSS.highlights.keys()].length : 0) + document.querySelectorAll('mark, [data-flow-mark], .flow-mark').length)()`);
  const lands = !!sel && !!body && body.includes(sel.trim());
  const linksBack = pane.clipLinks > 0 || /:~:text=/.test(body || '');
  return [lands && linksBack, { selected: sel, noteShows: (body || '').slice(0, 80), paneOpen: pane.open, lands, linksBack, marksInPage: marks }];
});

/* ---------- line 2: moving ---------- */
await check('2.1', 'a drag on the desktop glides on after release', async () => {
  await pill(2);
  const vp = await L.rect(page, '#viewport');
  const lim = () => ev(`(() => { const c = document.querySelector('.ws[data-id="infra"] > .canvas'); return { max: Math.max(0, c.getBoundingClientRect().width - document.getElementById('viewport').getBoundingClientRect().width) }; })()`);
  const pan = () => ev(`(() => { const st = window.__flow.state(), ws = st.ws.find((w) => w.id === st.ui.at); return ${L.PANPX}(ws, null, 'x'); })()`);
  const { max } = await lim();
  if (max < 600) throw new Error(`the desktop is only ${Math.round(max)} px wider than the view`);
  const s = await emptySpot();
  const start = await pan();
  // toward the side with more room: the pointer moving left raises the pan
  const dir = max - start >= start ? -1 : 1;
  const t0 = Date.now();
  const at = (i) => (t0 + i * 12) / 1000;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x, y: s.y, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: at(0) });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.x, y: s.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse', timestamp: at(0) });
  for (let i = 1; i <= 8; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x + dir * i * 25, y: s.y, button: 'left', buttons: 1, pointerType: 'mouse', timestamp: at(i) });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x + dir * 200, y: s.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse', timestamp: at(9) });
  const p0 = await pan();
  await L.sleep(800);
  const p1 = await pan();
  const edge = dir < 0 ? max : 0;
  const glided = Math.abs(p1 - p0) > 30 || (Math.abs(p1 - edge) < 2 && Math.abs(edge - p0) >= 30);
  return [glided, { panBefore: Math.round(start), panAtRelease: Math.round(p0), after800ms: Math.round(p1), max: Math.round(max) }];
});
await check('2.2', 'a two-finger swipe steps to the next space of the workspace, not the next workspace', async () => {
  await pill(0);
  const s = await emptySpot();
  const before = await state();
  await L.swipe(page, s.x, s.y, [30, 40, 50, 40, 30, 20]);
  await L.sleep(1200);
  const after = await state();
  const r = { workspaceBefore: before.ui.at, workspaceAfter: after.ui.at, researchOnScreen: await onScreen('w-kv') };
  // put it back
  if (after.ui.at !== before.ui.at) await pill(0);
  return [after.ui.at === before.ui.at && r.researchOnScreen > 0.5, r];
});
/* ---------- line 6: a popped-out space lives only there ---------- */
await check('6.1', 'a popped-out space lives only in its pop-out; the main window says "in another window"', async () => {
  await pill(0);
  const pop = await L.rect(page, '#spaces .sp[data-i="0"] .pop');
  await L.mouse(page, 'mouseMoved', pop.cx, pop.cy);
  await L.sleep(250);
  await L.click(page, pop.cx, pop.cy);
  for (let i = 0; i < 40 && !(await pageTargets()).some((u) => /solo=flow$/.test(u)); i++) await L.sleep(250);
  await L.sleep(5000);
  const twice = Object.entries(await webviews()).filter(([, n]) => n > 1).map(([u, n]) => `${u} x${n}`);
  const by = {};
  L.tmux('list-clients', '-F', '#{client_session}').trim().split('\n').filter(Boolean).forEach((s) => { by[s] = (by[s] || 0) + 1; });
  const twoClients = Object.entries(by).filter(([, n]) => n > 1).map(([s]) => s);
  const says = await ev(`/in another window/i.test(document.getElementById('viewport').innerText)`);
  const shot = await L.shot(page, `${label}-6.1-main-with-popout`);
  try { const pp = await L.connect(/index\.html#solo=flow$/); await L.ev(pp, 'setTimeout(() => window.close(), 50), 1'); pp.ws.close(); await L.sleep(1200); } catch (e) { log('     could not close the pop-out:', e.message); }
  return [twice.length === 0 && twoClients.length === 0 && says, { pagesLoadedTwice: twice, terminalsWithTwoClients: twoClients, mainSaysInAnotherWindow: says, shot }];
});

/* ---------- line 8: only what is on screen is streamed ---------- */
await check('8.1', 'terminals of a workspace you left stop streaming', async () => {
  await pill(1);
  await L.until(page, 'true', 50);
  for (let i = 0; i < 40 && !L.tmux('ls').includes('flow_mn-build'); i++) await L.sleep(250);
  if (!L.tmux('ls').includes('flow_mn-build')) throw new Error('the mynotes terminal never started');
  await L.sleep(1000);
  await pill(3);
  await L.sleep(1500);
  const clients = L.tmux('list-clients', '-F', '#{client_session}').trim().split('\n').filter((s) => /flow_(mn|v)-/.test(s));
  const offScreen = clients.filter((s) => s.startsWith('flow_mn-'));
  await pill(0);
  return [offScreen.length === 0, { attachedWhileOnAnotherWorkspace: offScreen, allClients: L.tmux('list-clients', '-F', '#{client_session}').trim().split('\n') }];
});

/* ---------- line 7: everything comes back ---------- */
await check('7.x', 'after a quit: stacking, a page scroll, pan per space, pop-outs', async () => {
  // a long page, scrolled
  const pid = await pageWindowIn('model reading');
  await L.type(page, 'en.wikipedia.org/wiki/Tmux');
  await L.key(page, 'Enter');
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(pid)}); return p && !p.isLoading() && /tmux/i.test(p.getTitle() || ''); })()`, 40000, 250);
  await L.sleep(1200);
  const pv = await L.rect(page, `.win[data-id="${pid}"] webview`);
  for (let i = 0; i < 12; i++) { await L.wheel(page, pv.cx, pv.cy, 0, 300); await L.sleep(60); }
  await L.sleep(1000);
  const y0 = await guestEval(/wikipedia\.org\/wiki\/Tmux/i, 'Math.round(scrollY)');
  log('     shot', await L.shot(page, `${label}-7x-page-before-quit`));
  // the note "this week" to the front, in flow
  await pill(0);
  await sideClick(`/this week/.test(x.innerText)`);
  const tb = await L.rect(page, '.win[data-id="w-week"] > .tb');
  if (tb) await L.click(page, tb.cx, tb.cy);
  await L.sleep(400);
  const front0 = await ev(`(() => { const wins = [...document.querySelectorAll('.ws')].find((s) => s.dataset.id === 'flow').querySelectorAll('.win'); return [...wins].sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0)).slice(0, 3).map((e) => e.dataset.id); })()`);
  const pans0 = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === 'flow'); return { main: Math.round(ws.pan || 0), spaces: (ws.zones || []).map((z) => [z.id, z.pan]) }; })()`);
  const t0 = await pageTargets();
  await relaunch('quit');
  const front1 = await ev(`(() => { const wins = [...document.querySelectorAll('.ws')].find((s) => s.dataset.id === 'flow').querySelectorAll('.win'); return [...wins].sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0)).slice(0, 3).map((e) => e.dataset.id); })()`);
  // back to the page's workspace (the last pill), where the page loads again
  const n = await ev(`document.querySelectorAll('#spaces .sp[data-i]').length`);
  await pill(n - 1);
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(pid)}); return p && !p.isLoading() && /tmux/i.test(p.getTitle() || ''); })()`, 40000, 250).catch(() => null);
  await L.sleep(2500);
  const y1 = await guestEval(/wikipedia\.org\/wiki\/Tmux/i, 'Math.round(scrollY)');
  log('     shot', await L.shot(page, `${label}-7x-page-after-quit`));
  const pans1 = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === 'flow'); return { main: Math.round(ws.pan || 0), spaces: (ws.zones || []).map((z) => [z.id, z.pan]) }; })()`);
  const t1 = await pageTargets();
  const r = { pageScroll: [y0, y1], topWindows: [front0, front1], pans: [pans0, pans1], windows: [t0, t1] };
  const ok = y0 > 500 && y1 != null && Math.abs(y1 - y0) < 200 && front0[0] === front1[0] && JSON.stringify(pans0) === JSON.stringify(pans1) && t0.length === t1.length;
  return [ok, r];
});

await check('2.3', 'a pinch zooms the space and terminals keep their cols and rows', async () => {
  await pill(0);
  const s = await emptySpot();
  const sz0 = L.tmux('list-windows', '-a', '-F', '#{session_name} #{window_width}x#{window_height}').trim();
  const tf0 = await ev(`getComputedStyle(document.querySelector('.ws .canvas')).transform`);
  for (let i = 0; i < 6; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.x, y: s.y, deltaX: 0, deltaY: -40, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' }); await L.sleep(30); }
  await L.sleep(1000);
  const tf1 = await ev(`getComputedStyle(document.querySelector('.ws .canvas')).transform`);
  const sz1 = L.tmux('list-windows', '-a', '-F', '#{session_name} #{window_width}x#{window_height}').trim();
  const zoomed = tf0 !== tf1 && /matrix\(([\d.]+)/.test(tf1) && +/matrix\(([\d.]+)/.exec(tf1)[1] !== 1;
  return [zoomed && sz0 === sz1, { before: tf0, after: tf1, terminalSizesSame: sz0 === sz1 }];
});


/* ---------- last, because it fills flow with notes ---------- */
await check('5.5', 'a click on a window right after using the dock reaches the window, not the dock', async () => {
  // new notes from the dock (no claude) until one reaches down past the dock's top, then a quick click on its bottom area
  await pill(0);
  const spawn = async () => {
    const vp = await L.rect(page, '#viewport');
    await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h - 6);
    await L.sleep(450);
    const b = await L.rect(page, '#dock button[data-k="note"]');
    await L.mouse(page, 'mouseMoved', b.cx, b.cy);
    await L.sleep(150);
    const before = await ids();
    await L.click(page, b.cx, b.cy);
    return newWin(before);
  };
  let low = null;
  for (let i = 0; i < 8 && !low; i++) {
    const id = await spawn();
    await L.sleep(600);
    const sel = `.win[data-id="${id}"]`;
    const hit = await ev(`(() => { const d = document.getElementById('dock').getBoundingClientRect(); const t = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return t.bottom > d.top + 10 && t.left < d.right - 20 && t.right > d.left + 20 ? { dock: [d.left, d.top, d.right, d.bottom] } : null; })()`);
    if (hit) low = { id, dock: hit.dock };
  }
  if (!low) throw new Error('no new window reached down past the dock in 8 tries');
  const r = await L.rect(page, `.win[data-id="${low.id}"]`);
  const x = Math.max(r.x + 20, Math.min(r.x + r.w - 20, (low.dock[0] + low.dock[2]) / 2)), y = Math.min(r.y + r.h - 12, low.dock[1] + 14);
  // straight from the dock button that made it, and click at once
  const before = await ids();
  await L.click(page, x, y);
  await L.sleep(900);
  const made = (await ids()).filter((w) => !before.includes(w));
  const focus = await ev(`(() => { const a = document.activeElement; return a && a.closest('.win') ? a.closest('.win').dataset.id : a ? a.tagName : null; })()`);
  return [made.length === 0, { clickedOn: low.id, windowsMadeByTheClick: made, focusIn: focus }];
});

if (page) page.ws.close();
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
const n = (v) => res.filter((r) => r.ok === v).length;
log(`summary: ${n(true)} ok, ${n(false)} BAD, ${n(null)} ERR`);
// a BAD or an ERR fails the run
process.exitCode = n(true) > 0 && n(false) + n(null) === 0 ? 0 : 1;
fs.writeFileSync(path.join(L.EVID, `${label}.log`), out.join('\n') + '\n');
fs.writeFileSync(path.join(L.EVID, `${label}.json`), JSON.stringify(res, null, 1));




