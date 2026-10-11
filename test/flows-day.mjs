// flows: the parts of the owner's day the walk does not cover, in flows' own app with real input: pages and tabs, saved
// pages, notes in sections with delete and undo, an agent team, zoom, then a quit and relaunch. Fresh seed.
// Claude only under L.WORK, tiny prompts. node test/flows-day.mjs [label]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from './flows-lib.mjs';

const label = process.argv[2] || 'day';
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
async function dock(k) {
  const vp = await L.rect(page, '#viewport');
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h - 6);
  await L.sleep(500);
  const b = await L.rect(page, `#dock button[data-k="${k}"]`);
  await L.mouse(page, 'mouseMoved', b.cx, b.cy);
  await L.sleep(200);
  await L.click(page, b.cx, b.cy);
}
async function emptySpot() {
  return ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.top + 60; y < v.bottom - 140; y += 40) for (let x = v.left + 30; x < v.right - 30; x += 40) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .zl, #dock, .ctx, .toast, .wsm')) return { x, y }; } return null; })()`);
}
const row = (match) => ev(`(() => { const el = [...document.querySelectorAll('#sblist .tr')].find((x) => ${match}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2, text: el.innerText.replace(/\\n/g, ' | '), act: el.dataset.act || '' }; })()`);
const sidebarText = () => ev(`[...document.querySelectorAll('#sblist .grp, #sblist .tr')].map((x) => (x.classList.contains('grp') ? '## ' : '') + x.innerText.replace(/\\n/g, ' | ')).join('\\n')`);
const typeSlow = async (t) => { for (const ch of t) { await L.key(page, ch); await L.sleep(35); } };
const pageTargets = async () => (await L.targets()).filter((t) => t.type === 'page' && /index\.html/.test(t.url)).map((t) => t.url.replace(/^.*index\.html/, '') || 'main');

log('tree:', spawnSync('sh', ['-c', `cd ${L.APP} && md5sum src/app.js src/page.js src/sidebar.js src/notes.js src/teams.js src/nav.js | cut -c1-8,33- | tr "\\n" " "`], { encoding: 'utf8' }).stdout);
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
spawnSync('node', [path.join(L.ROOT, 'test/flows-seed.mjs')], { encoding: 'utf8', cwd: L.ROOT });
fs.rmSync(path.join(L.UD, 'Preferences'), { force: true });
await L.launch(`${label}-1`);
page = await L.connect();
await L.until(page, 'window.__flow && 1', 30000);
await ev('window.__flow.ready');
await L.sleep(3000);

/* ---------- pages and tabs ---------- */
await check('D1', 'the dock\'s new page opens a page window of its own at its own size, not a tab in the page in front, and covers nothing', async () => {
  // a fresh workspace keeps this part apart from the seed's windows
  await L.pointClick(page, '#addws');
  await L.sleep(500);
  await typeSlow('flows day');
  await L.key(page, 'Enter');
  await L.sleep(800);
  const spot = await emptySpot();
  const before = await ids();
  await rclick(spot.x, spot.y);
  await menuClick('/new page/');
  S.page = await newWin(before);
  await L.sleep(400);
  await typeSlow('example.org');
  await L.key(page, 'Enter');
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(S.page)}); return p && !p.isLoading() && /Example Domain/.test(p.getTitle() || ''); })()`, 40000, 250);
  const b2 = await ids();
  const s0 = await ev(L.SPACE);
  await dock('page');
  await L.sleep(1200);
  const extra = (await ids()).filter((x) => !b2.includes(x));
  const tabsInFront = await ev(`window.__flow.page(${JSON.stringify(S.page)}).tabs().tabs.length`);
  // where it went by the plan's rule for a page opened with no spot given (item 1): free room in view, else past the
  // last window with the view following; it covers nothing. Batch 10 (lead): at its own size, 46 x 64, never shrunk
  const s1 = await ev(L.SPACE), mine = extra.length === 1 ? s1.wins.find((o) => o.id === extra[0]) : null;
  const rule = extra.length === 1 ? L.opened(extra[0], s0, s1, 46, 64) : null;
  const ownSize = !!mine && Math.abs(mine.w - 46) < 0.05 && Math.abs(mine.h - 64) < 0.05;
  const focused = extra.length === 1 && (await ev(`!!(document.activeElement && document.activeElement.closest('.win[data-id="${extra[0]}"]') && document.activeElement.classList.contains('ad'))`));
  log('     shot', await L.shot(page, `${label}-d1-new-page`));
  // the blank tab D2 and D3 read: the one the owner asks for, ⌘T with the keys in the page (its address line; a title-bar
  // click gives a window the keys only from batch 8). The menu's own action: a chord sent over CDP never reaches the Mac
  // menu's accelerator on this VM
  const tb = await L.rect(page, `.win[data-id="${S.page}"] input.ad`);
  await L.click(page, tb.cx, tb.cy);
  await L.sleep(500);
  await ev(`window.__flow.menu('new-page')`);
  await L.sleep(1200);
  return [extra.length === 1 && tabsInFront === 1 && !!rule && rule.ok && ownSize, { newWindows: extra, tabsInFront, addressFocused: focused, ownSize, rule }];
});

/* ---------- saved pages ---------- */
await check('D2', 'save a page with the star: it shows once in the browser section, marked open', async () => {
  // back to the first tab (example.org), then the star
  const t1 = await L.rect(page, `.win[data-id="${S.page}"] .ptabs .ptab`);
  if (t1) { await L.click(page, t1.cx, t1.cy); await L.sleep(700); }
  const star = await L.rect(page, `.win[data-id="${S.page}"] .pstar`);
  if (!star) throw new Error('no star on the page');
  await L.click(page, star.cx, star.cy);
  await L.sleep(1000);
  const starred = await ev(`document.querySelector('.win[data-id="${S.page}"] .pstar').textContent`);
  // a new tab opened now, after the save, for D3: ⌘T with the keys in the page (the dock's page button makes a window of
  // its own since batch 7)
  const ad = await L.rect(page, `.win[data-id="${S.page}"] input.ad`);
  await L.click(page, ad.cx, ad.cy);
  await L.sleep(400);
  await ev(`window.__flow.menu('new-page')`);
  await L.sleep(1500);
  S.blankTab = await ev(`(() => { const v = document.querySelector('.win[data-id="${S.page}"] .pgv'); return v ? v.innerText.slice(0, 600) : ''; })()`);
  const side = await sidebarText();
  const rows = side.split('\n').filter((l) => /Example Domain/.test(l));
  S.side1 = side;
  log('     sidebar:', JSON.stringify(side.split('\n')));
  return [starred === '★' && rows.length === 1, { star: starred, rowsForThePage: rows }];
});
await check('D3', 'a new tab lists the saved pages', async () => {
  // the new tab's own list (.pgv), not the tab strip, which also reads "Example Domain"
  const has = /saved/.test(S.blankTab || '') && /Example Domain/.test(S.blankTab || '');
  return [has, { newTabShows: (S.blankTab || '').replace(/\s+/g, ' ').slice(0, 200) }];
});
await check('D4', 'hovering a saved page shows what the page is about', async () => {
  const r = await row(`/Example Domain/.test(x.innerText)`);
  if (!r) throw new Error('no row for the saved page');
  await L.mouse(page, 'mouseMoved', r.x, r.y);
  await L.sleep(1500);
  // the sidebar's card for that row (sidebar.js showCard: body > .sbcard), not any text on screen
  const card = await ev(`(() => { const c = document.querySelector('body > .sbcard'); if (!c || !c.offsetHeight) return null; const b = c.getBoundingClientRect(), sb = document.getElementById('sb').getBoundingClientRect(); return { text: c.innerText.slice(0, 200), besideSidebar: b.left >= sb.right - 1 }; })()`);
  log('     shot', await L.shot(page, `${label}-d4-hover`));
  // it names the page as its row does and repeats nothing (owner: "i don't want any of your stupid sloppy things here and
  // all these like bloated things", "how do we make sure we're not com- com- bloating that list up", owner-prompts.md:315, :376)
  const name = await ev(`(() => { const el = [...document.querySelectorAll('#sblist .tr')].find((x) => /Example Domain/.test(x.innerText)); const l = el && el.querySelector('.l'); return l && l.firstChild ? l.firstChild.textContent.trim() : null; })()`);
  const lines = card ? card.text.split('\n').map((t) => t.trim()).filter(Boolean) : [];
  const twice = lines.filter((t, i) => lines.indexOf(t) !== i);
  return [!!card && card.besideSidebar && lines[0] === name && twice.length === 0, { rowName: name, cardLines: lines, shownTwice: twice }];
});

/* ---------- notes ---------- */
await check('D5', 'a new note: title, Enter to the body, a todo', async () => {
  const before = await ids();
  await dock('note');
  S.note = await newWin(before);
  await L.sleep(600);
  await typeSlow('flows day note');
  await L.key(page, 'Enter');
  await L.sleep(300);
  await typeSlow('[ ] check the fork');
  await L.sleep(1200);
  const n = await ev(`(() => { const st = window.__flow.state(); for (const ws of st.ws) { const w = ws.windows.find((x) => x.id === ${JSON.stringify(S.note)}); if (w) { const n = ws.notes.find((x) => x.id === w.noteId); return { title: n.title, body: n.body, box: !!document.querySelector('.win[data-id="${S.note}"] input[type=checkbox], .win[data-id="${S.note}"] .todo, .win[data-id="${S.note}"] [data-todo]') }; } } return null; })()`);
  log('     shot', await L.shot(page, `${label}-d5-note`));
  return [n && n.title === 'flows day note' && /check the fork/.test(n.body || ''), n];
});
await check('D6', 'a note dropped on "+ new section" makes a section with it inside', async () => {
  const src = await row(`/flows day note/.test(x.innerText)`);
  // the drop target: the "+ new section" row (batch 1, freeze 1), or the notes heading, which reads "+ new section" while a
  // note is dragged (batch 2 final)
  const target = () => ev(`(() => { const el = document.querySelector('#sblist .tr[data-act="newsec|note"]') || document.querySelector('#sblist .grp[data-grp$=":g:notes"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2, kind: el.classList.contains('grp') ? 'heading' : 'row', text: el.innerText }; })()`);
  if (src) { await L.mouse(page, 'mouseMoved', src.x, src.y); await L.sleep(500); }
  let dst = await target();
  if (!src || !dst) throw new Error(`rows: note ${!!src}, a "+ new section" target ${!!dst}`);
  // HTML drag and drop from the sidebar row (CDP Input drag events)
  await page.send('Input.setInterceptDrags', { enabled: true });
  const dragData = await new Promise(async (resolve) => {
    const h = (m) => { if (m.method === 'Input.dragIntercepted') resolve(m.params.data); };
    page.on(h);
    await L.mouse(page, 'mouseMoved', src.x, src.y);
    await L.mouse(page, 'mousePressed', src.x, src.y);
    for (let i = 1; i <= 6; i++) await L.mouse(page, 'mouseMoved', src.x, src.y + ((dst.y - src.y) * i) / 6, { down: true });
    setTimeout(() => resolve(null), 3000);
  });
  if (!dragData) { await L.mouse(page, 'mouseReleased', dst.x, dst.y); await page.send('Input.setInterceptDrags', { enabled: false }); throw new Error('the note row did not start a drag'); }
  dst = (await target()) || dst;
  log('     dropping on the', dst.kind, JSON.stringify(dst.text));
  await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: dst.x, y: dst.y, data: dragData });
  await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: dst.x, y: dst.y, data: dragData });
  await page.send('Input.dispatchDragEvent', { type: 'drop', x: dst.x, y: dst.y, data: dragData });
  await L.mouse(page, 'mouseReleased', dst.x, dst.y);
  await page.send('Input.setInterceptDrags', { enabled: false });
  await L.sleep(800);
  // the new section is named in place
  await typeSlow('flows section');
  await L.key(page, 'Enter');
  await L.sleep(800);
  const side = await sidebarText();
  log('     sidebar:', JSON.stringify(side.split('\n')));
  log('     shot', await L.shot(page, `${label}-d6-section`));
  const lines = side.split('\n');
  const si = lines.findIndex((l) => /flows section/.test(l)), ni = lines.findIndex((l) => /flows day note/.test(l));
  return [si >= 0 && ni > si, { section: lines[si], note: lines[ni] }];
});
await check('D7', 'delete a note, then undo', async () => {
  // close its window first, then the × on its row deletes it
  const red = await L.rect(page, `.win[data-id="${S.note}"] .tb [data-l="close"]`);
  if (red) { await L.click(page, red.cx, red.cy); await L.sleep(700); }
  const x = await ev(`(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => /flows day note/.test(x.innerText)); if (!r) return null; r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const e = r.querySelector('[data-del], [data-close]'); if (!e) return { none: r.innerHTML.slice(0, 200) }; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, kind: e.dataset.del != null ? 'del' : 'close' }; })()`);
  if (!x || x.none) throw new Error(`no × on the note row ${x ? x.none : ''}`);
  await L.mouse(page, 'mouseMoved', x.x, x.y);
  await L.sleep(200);
  await L.click(page, x.x, x.y);
  await L.sleep(700);
  const gone = !(await sidebarText()).includes('flows day note');
  const toast = await ev(`document.getElementById('toast') ? document.getElementById('toast').innerText : ''`);
  const u = await ev(`(() => { const b = [...document.querySelectorAll('.toast.on button')].find((x) => /undo/.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (u) { await L.click(page, u.x, u.y); await L.sleep(800); }
  const back = (await sidebarText()).includes('flows day note');
  return [gone && !!u && back, { kind: x.kind, goneAfterDelete: gone, toast, undoButton: !!u, backAfterUndo: back }];
});

/* ---------- an agent team ---------- */
await check('D8', 'a team: a teammate gets its own window in the team\'s space, near the team when there is room, covering nothing and leaving the view where it was; the team\'s row counts it', async () => {
  // claude runs only under L.WORK: the team goes into flow (folder L.WORK/p/flow), never into a new workspace (folder ~)
  const p0 = await L.rect(page, '#spaces .sp[data-i="0"]');
  await L.click(page, p0.x + 8, p0.cy);
  await L.sleep(1000);
  const folder = await ev(`(() => { const st = window.__flow.state(); return st.ws.find((w) => w.id === st.ui.at).folder; })()`);
  if (!String(folder).startsWith(L.WORK)) throw new Error(`not starting claude in ${folder}`);
  const before = await ids();
  await dock('team');
  S.team = await newWin(before);
  await L.until(page, `(() => { const t = window.__flow.term(${JSON.stringify(S.team)}); const s = t && t.getText(40); if (!s) return false; if (/trust this folder/.test(s)) return 'TRUST'; return /bypass permissions|for shortcuts|❯/.test(s); })()`, 90000, 300);
  const r = await L.rect(page, `.win[data-id="${S.team}"] .termhost`);
  await L.click(page, r.x + 60, r.y + r.h - 30);
  await typeSlow('Start an agent team with exactly one teammate named fig. Its only task: reply with the single word ok and finish. Do nothing else.');
  await L.sleep(1500);
  const s0 = await ev(L.SPACE);
  await L.key(page, 'Enter');
  const b2 = await ids();
  const t0 = Date.now();
  let mate = null;
  try { mate = (await L.until(page, `window.__flow.windows().filter((w) => w.type === 'term' || w.type === 'team').map((w) => w.id).filter((w) => !${JSON.stringify(b2)}.includes(w))[0]`, 240000, 1000)).v; } catch (e) { /* none */ }
  const panes = L.tmux('list-panes', '-a', '-F', '#{session_name} #{pane_id} #{pane_current_command} #{pane_title}').trim();
  log('     tmux panes:', JSON.stringify(panes.split('\n')));
  log('     shot', await L.shot(page, `${label}-d8-team`));
  if (!mate) return [false, { teammateWindow: null, waitedMs: Date.now() - t0, teamText: (await ev(`window.__flow.term(${JSON.stringify(S.team)}).getText(30)`)).split('\n').filter((l) => l.trim()).slice(-8) }];
  S.mate = mate;
  await L.sleep(4000);
  const g = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.windows.some((x) => x.id === ${JSON.stringify(mate)})); const m = ws.windows.find((x) => x.id === ${JSON.stringify(mate)}), t = ws.windows.find((x) => x.id === ${JSON.stringify(S.team)}); return { mate: { x: +m.x.toFixed(1), y: +m.y.toFixed(1), w: +m.w.toFixed(1), zone: m.zone || null, title: m.title || m.osc || '', mateOf: m.mate ? m.mate.team || m.mate.lead || JSON.stringify(m.mate).slice(0, 60) : null }, team: { x: +t.x.toFixed(1), y: +t.y.toFixed(1), w: +t.w.toFixed(1), zone: t.zone || null } }; })()`);
  // beside the team (right or left of it, or under it) when there is room there, else by the rule for a window an agent
  // opens: a free spot in view, else past the last window; the view stays (lead, Nov 2 13:5x)
  const s1 = await ev(L.SPACE), me = s1.wins.find((o) => o.id === mate), tm = s1.wins.find((o) => o.id === S.team);
  const beside = !!(me && tm) && (Math.abs(me.x - (tm.x + tm.w)) < 6 || Math.abs(tm.x - (me.x + me.w)) < 6 || (Math.abs(me.x - tm.x) < 6 && Math.abs(me.y - (tm.y + tm.h)) < 6));
  const rule = L.opened(mate, s0, s1, me ? me.w : 46, me ? me.h : 44, { byAgent: true });
  const teamRow = await ev(`(() => { const r = document.querySelector('#sblist .tr[data-act="win|${S.team}"]'); return r ? r.innerText.replace(/\\n/g, ' | ') : null; })()`);
  const counted = !!teamRow && /\b1\b/.test(teamRow.split(' | ').slice(-1)[0]);
  return [g.mate.zone === g.team.zone && counted && (rule.ok || (beside && rule.covers.length === 0 && rule.moved.length === 0 && rule.viewStayed)), { ...g, beside, rule, waitedMs: Date.now() - t0, sidebarTeamRow: teamRow }];
});

/* ---------- zoom, then a quit and relaunch ---------- */
await check('D9', 'after a quit: zoom, saved page, the section, the page window\'s tabs, the team and its teammate come back', async () => {
  // back to "flows day", where the saved page and the section live (D8 ran its team in flow): what is checked must be on
  // screen before the quit, so "kept" can't mean "absent both times"
  const fd = await ev(`[...document.querySelectorAll('#spaces .sp[data-i]')].findIndex((x) => x.querySelector('.sn').textContent.trim() === 'flows day')`);
  if (fd < 0) throw new Error('no "flows day" workspace');
  await L.pointClick(page, `#spaces .sp[data-i="${fd}"] .sn`);
  await L.sleep(900);
  const s = await emptySpot();
  for (let i = 0; i < 4; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.x, y: s.y, deltaX: 0, deltaY: -40, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse' }); await L.sleep(40); }
  await L.sleep(1200);
  const z0 = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === st.ui.at); return { ws: ws.id, zoom: ws.zoom || (ws.view && ws.view.z) || null, transform: getComputedStyle(document.querySelector('.ws[data-id="' + ws.id + '"] > .canvas')).transform }; })()`);
  const side0 = await sidebarText();
  const wins0 = await ev(`window.__flow.windows().map((w) => w.id)`);
  // the page window's tabs (D1 gave it a second one) and the one in front
  const tabsOf = () => ev(`(() => { const p = window.__flow.page(${JSON.stringify(S.page || '')}); if (!p || !p.tabs) return null; const t = p.tabs(); return { n: t.tabs.length, urls: t.tabs.map((x) => x.url), front: t.tab }; })()`);
  const tabs0 = await tabsOf();
  page.ws.close();
  page = null;
  log(await L.stop());
  await L.sleep(1000);
  await L.launch(`${label}-2`);
  page = await L.connect();
  await L.until(page, 'window.__flow && 1', 30000);
  await ev('window.__flow.ready');
  await L.sleep(4000);
  const z1 = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === st.ui.at); return { ws: ws.id, zoom: ws.zoom || (ws.view && ws.view.z) || null, transform: getComputedStyle(document.querySelector('.ws[data-id="' + ws.id + '"] > .canvas')).transform }; })()`);
  const side1 = await sidebarText();
  const wins1 = await ev(`window.__flow.windows().map((w) => w.id)`);
  await L.until(page, `!!window.__flow.page(${JSON.stringify(S.page || '')})`, 10000).catch(() => null);
  const tabs1 = await tabsOf();
  const lost = wins0.filter((w) => !wins1.includes(w));
  log('     shot', await L.shot(page, `${label}-d9-after-quit`));
  const keep = (re) => re.test(side0) && re.test(side1);
  const tabsKept = !!tabs0 && JSON.stringify(tabs0) === JSON.stringify(tabs1);
  return [z0.transform === z1.transform && lost.length === 0 && keep(/flows section/) && keep(/Example Domain/) && tabsKept, { zoom: [z0, z1], windowsLost: lost, tabs: [tabs0, tabs1], sectionKept: keep(/flows section/), savedPageKept: keep(/Example Domain/), teamAndMate: [S.team, S.mate].map((id) => id && wins1.includes(id)) }];
});

if (page) { const errs = page.errors.filter((e) => !/favicon|ERR_ABORTED/.test(e)); if (errs.length) log('page errors:', errs.slice(0, 8).join(' | ')); page.ws.close(); }
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
const n = (v) => res.filter((r) => r.ok === v).length;
log(`summary: ${n(true)} ok, ${n(false)} BAD, ${n(null)} ERR`);
// a BAD or an ERR fails the run
process.exitCode = n(true) > 0 && n(false) + n(null) === 0 ? 0 : 1;
fs.writeFileSync(path.join(L.EVID, `${label}.log`), out.join('\n') + '\n');




