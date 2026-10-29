// sidebar's end-to-end check of the sidebar (a heading per space; agents, notes, browser under each) with real input over CDP.
// Needs the dev app on 9574 (test/sidebar-dev.sh start --fresh) made busy by test/sidebar-busy.mjs: a team
// with panes, open pages, the seed's sub-workspace "research". Screenshots go to test/sidebar-shots/.
//   node test/sidebar-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, rect, size, sleep, click, dblclick, mouse, key, type, reporter } from './ui-lib.mjs';

const SHOTS = path.join(path.dirname(new URL(import.meta.url).pathname), 'sidebar-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const R = reporter();
const page = await connectTo(9574, /\/src\/index\.html$/);
await size(page, 1500, 913);
for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
await evaluate(page, 'window.__flow.ready');

const ev = (expr) => evaluate(page, expr);
const flowWs = () => ev(`__flow.state().ws.find((w) => w.id === 'flow')`);
/* The sidebar as rows on screen: { grp, space, depth, act, label, meta, dim, glyph, x } in order (space: the act of the
   space heading the row is under, 'zone|' for the main workspace's; a heading's grp is 'space'; x: the × actions on
   the row). */
const rows = () => ev(`(() => { let grp = '', space = ''; return [...document.querySelectorAll('#sblist .grp, #sblist .tr')].map((e) => {
  if (e.classList.contains('grp')) { grp = e.textContent; return null; }
  if (e.classList.contains('sph')) { grp = 'space'; space = e.dataset.act; }
  if (!e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return null;
  const l = e.querySelector('.l'), m = e.querySelector('.m'), g = e.querySelector('.g');
  const x = ['end', 'close', 'del', 'unsave'].filter((k) => e.querySelector('[data-' + k + ']'));
  return { grp, space, depth: +((e.className.match(/\\bd(\\d)\\b/) || [0, 0])[1]), act: e.dataset.act, label: l ? l.textContent : '', meta: m ? m.textContent : '', dim: e.classList.contains('dim'), glyph: g ? g.textContent : '', x };
}).filter(Boolean); })()`);
const groups = () => ev(`[...document.querySelectorAll('#sblist .grp')].map((g) => g.textContent)`);
/* Sections that hold notes or pages, as notes.js keeps them: { id, title } in order. */
const sections = (holds) => ev(`(() => { const ws = __flow.state().ws.find((w) => w.id === 'flow'); const kids = (id) => ws.notes.filter((n) => n.parent === id);
  return ws.notes.filter((n) => n.kind === 'folder' && (n.holds || (kids(n.id).length && kids(n.id).every((k) => k.kind === 'page') ? 'page' : 'note')) === ${JSON.stringify(holds)}).map((n) => ({ id: n.id, title: n.title })); })()`);
const rowRect = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const rowSel = (act) => `#sblist .tr[data-act="${act}"]`;
/* The toast as "<message>" or "<message> · <action>", whichever way the app draws its action button. */
const toastText = () => ev(`(() => { const t = document.getElementById('toast'); if (!t.classList.contains('on')) return ''; const b = t.querySelector('button'); const msg = [...t.childNodes].filter((n) => n !== b).map((n) => n.textContent).join('').replace(/\\s*·\\s*$/, ''); return b ? msg + ' · ' + b.textContent : msg; })()`);
async function clickSel(sel) {
  const r = await rowRect(sel);
  if (!r) throw new Error(`nothing at ${sel}`);
  await click(page, r.cx, r.cy);
  await sleep(450);
}
async function rightClick(sel) {
  const r = await rowRect(sel);
  if (!r) throw new Error(`nothing at ${sel}`);
  await mouse(page, 'mouseMoved', r.cx, r.cy);
  await mouse(page, 'mousePressed', r.cx, r.cy, { button: 'right', buttons: 2 });
  await mouse(page, 'mouseReleased', r.cx, r.cy, { button: 'right', buttons: 2 });
  await sleep(300);
  return ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.firstChild.textContent)`);
}
async function menuPick(label) {
  const i = await ev(`[...document.querySelectorAll('.ctx button')].findIndex((b) => b.firstChild.textContent === ${JSON.stringify(label)})`);
  if (i < 0) { await escape(); return false; }
  await clickSel(`.ctx button[data-i="${i}"]`);
  return true;
}
/* A row's menu and one of its items. A right-click the list moved under meets another row: one more try once it has
   settled, and the check after it says what was missed. */
async function rowPick(sel, label) {
  for (let t = 0; t < 2; t++) {
    const items = await rightClick(sel);
    if (items.includes(label)) return menuPick(label);
    await escape();
    await sleep(400);
  }
  return false;
}
async function escape() {
  await key(page, 'Escape');
  await sleep(200);
}
/* A row click can pan to its window (a 0.45 s glide, app.css:80) or slide in its space (220 ms, app.js showSpace), which
   under load can start a while after the click; a hand presses inside it once it has stopped and nothing outside the
   sidebar is still to move. */
const still = () => ev(`!document.getAnimations().some((x) => x.playState === 'running' && x.effect && x.effect.getComputedTiming().endTime !== Infinity && x.effect.target && x.effect.target.closest && !x.effect.target.closest('#sb'))`);
async function settled(sel) {
  let a = await rect(page, sel);
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const b = await rect(page, sel);
    if (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (await still())) return b;
    a = b;
  }
  return a;
}
/* Puts the pointer on something (a group heading), or away from the sidebar. */
async function hover(sel) {
  const r = sel ? await rowRect(sel) : { cx: 900, cy: 500 };
  if (!r) throw new Error(`nothing at ${sel}`);
  await mouse(page, 'mouseMoved', r.cx, r.cy);
  await sleep(200);
}
/* The headings' "+" on screen ([data-make] of each), and where every heading and row sits. */
const makeShown = () => ev(`[...document.querySelectorAll('#sblist .gadd')].filter((e) => getComputedStyle(e).visibility === 'visible').map((e) => e.dataset.make)`);
const tops = () => ev(`[...document.querySelectorAll('#sblist .grp, #sblist .tr')].map((e) => Math.round(e.getBoundingClientRect().top))`);
/* What each heading says at its right now ('' when nothing): "+", "+ new section" or "+ new sub-workspace". */
const headSays = () => ev(`Object.fromEntries([...document.querySelectorAll('#sblist .grp')].map((g) => { const a = g.querySelector('.gadd'); return [g.dataset.grp.split(':g:')[1], a && getComputedStyle(a).visibility === 'visible' ? getComputedStyle(a, '::before').content.replace(/^"|"$/g, '') : '']; }))`);
/* A drag onto a heading, checking during it that nothing in the list moved and what the headings say. */
async function dragToHeading(fromSel, group) {
  const before = await tops();
  let during = null;
  await htmlDrag(fromSel, `#sblist .grp[data-grp="flow:g:${group}"]`, async () => { during = { says: await headSays(), moved: JSON.stringify(await tops()) !== JSON.stringify(before) }; });
  return during;
}
/* A drag onto the end of the list, checking during it that nothing in the list moved and what the end says. */
async function dragToEnd(fromSel) {
  const before = await tops();
  let during = null;
  await htmlDrag(fromSel, '#sblist .sadd', async () => { during = { says: await ev(`(() => { const s = document.querySelector('#sblist .sadd'); return s && s.getClientRects().length ? getComputedStyle(s, '::before').content.replace(/^"|"$/g, '') : ''; })()`), moved: JSON.stringify(await tops()) !== JSON.stringify(before) }; });
  return during;
}
/* Whatever is in rename now gets a new name: returns the name it had. */
async function renameTo(name) {
  const was = await ev(`(() => { const el = document.activeElement; return el && el.classList.contains('rn') ? el.textContent : null; })()`);
  await key(page, 'a', 2);
  await type(page, name);
  await key(page, 'Enter');
  await sleep(400);
  return was;
}
/* An HTML5 drag inside the page: the press and moves start a real drag, Chromium hands it over (setInterceptDrags),
   and it is dropped at the target. */
let intercepted = null;
page.on((m) => { if (m.method === 'Input.dragIntercepted') intercepted = m.params.data; });
/* A target that shows only while something is dragged ("+ new section") is found once the drag has started; during()
   runs then, before the drop. */
async function htmlDrag(fromSel, toSel, during, atTarget) {
  const a = await rowRect(fromSel);
  let b = await rowRect(toSel);
  if (!a) throw new Error(`drag ${fromSel} -> ${toSel}: missing source`);
  const toward = b && b.h ? b : { cx: a.cx, cy: a.cy + 40 };
  await page.send('Input.setInterceptDrags', { enabled: true });
  intercepted = null;
  await mouse(page, 'mouseMoved', a.cx, a.cy);
  await mouse(page, 'mousePressed', a.cx, a.cy);
  for (let i = 1; i <= 10 && !intercepted; i++) {
    await mouse(page, 'mouseMoved', a.cx + ((toward.cx - a.cx) * i) / 10, a.cy + ((toward.cy - a.cy) * i) / 10, { down: true });
    await sleep(30);
  }
  for (let i = 0; i < 20 && !intercepted; i++) await sleep(50);
  const data = intercepted;
  if (!data) { await mouse(page, 'mouseReleased', toward.cx, toward.cy); await page.send('Input.setInterceptDrags', { enabled: false }); throw new Error('no drag started'); }
  await sleep(150);
  if (during) await during();
  b = await rowRect(toSel);
  if (!b || !b.h) { await page.send('Input.dispatchDragEvent', { type: 'dragCancel', x: toward.cx, y: toward.cy, data }); await mouse(page, 'mouseReleased', toward.cx, toward.cy); await page.send('Input.setInterceptDrags', { enabled: false }); throw new Error(`drag ${fromSel} -> ${toSel}: no target on screen`); }
  for (const t of ['dragEnter', 'dragOver']) await page.send('Input.dispatchDragEvent', { type: t, x: b.cx, y: b.cy, data });
  if (atTarget) await atTarget();
  await page.send('Input.dispatchDragEvent', { type: 'drop', x: b.cx, y: b.cy, data });
  await mouse(page, 'mouseReleased', b.cx, b.cy);
  await page.send('Input.setInterceptDrags', { enabled: false });
  await sleep(500);
}
const shot = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
};
/* Rows listed under a sub-workspace's heading (unfold it first). */
const underZone = (list, zid) => list.filter((r) => r.space === `zone|${zid}` && r.grp !== 'space');
async function unfoldZone(zid) {
  const r = (await rows()).find((x) => x.act === `zone|${zid}`);
  if (r && r.glyph === '▸') await clickSel(`${rowSel(`zone|${zid}`)} .g[data-tog]`);
}

/* ---------- start on the flow workspace, folded the way it starts ---------- */
await ev(`(() => { __flow.go(0); return true; })()`);
await sleep(600);
const before = await flowWs();
const team = before.windows.find((w) => w.type === 'team');
const zone = (before.zones || [])[0];

R.ok('the sidebar starts with the workspace\'s own name as the heading of its main space, marked while that space is on screen (owner, Nov 2 17:2x)', await ev(`(() => { const f = document.querySelector('#sblist').firstElementChild; const name = __flow.state().ws.find((w) => w.id === 'flow').name; return !document.querySelector('#sblist .wsh') && f.classList.contains('sph') && f.dataset.act === 'zone|' && f.classList.contains('here') && f.querySelector('.l').textContent === name; })()`));
const g0 = await groups();
const want0 = ['agents', 'notes', 'browser', ...((await ev('!!window.FlowFiles')) ? ['files'] : [])];
R.ok(`the main workspace's groups in the order ${want0.join(', ')}, and no sub-workspaces group`, JSON.stringify(g0) === JSON.stringify(want0), g0);
let rs = await rows();
const noteRows = rs.filter((r) => r.space === 'zone|' && r.grp === 'notes' && r.act !== 'newsec|note');
R.ok('notes holds only notes and note sections: no page rows', noteRows.length > 0 && noteRows.every((r) => r.glyph !== '↗' && /^(note|folder)\|/.test(r.act)), noteRows.map((r) => r.label));
const noisy = rs.filter((r) => /this Mac|off to the|^in |windows$/.test(r.meta));
R.ok('no row says "this Mac", "off to the", "in <sub-workspace>" or "N windows"', rs.length > 0 && noisy.length === 0, noisy.map((r) => `${r.label}: ${r.meta}`));
R.ok('nothing in the sidebar says "bookmark"', rs.length > 0 && !(await ev(`/bookmark/i.test(document.getElementById('sb').innerText)`)));
const panes = team ? await ev(`flow.term.panes(${JSON.stringify(team.id)}).then((l) => l.length)`) : 0;
if (R.ok('the test state has a team with sub-agents', !!team && panes >= 2, { team: team && team.id, panes })) {
  const tr = rs.find((r) => r.act === `win|${team.id}`);
  R.ok('the team is one folded row with its sub-agent count', !!tr && tr.glyph === '▸' && tr.meta.split(' · ').pop() === String(panes) && !rs.some((r) => r.act.startsWith(`mate|${team.id}|`)), tr);
  await shot('01-start-sidebar.png');
  await clickSel(`${rowSel(`win|${team.id}`)} .g[data-tog]`);
  rs = await rows();
  const mates = rs.filter((r) => r.act.startsWith(`mate|${team.id}|`));
  R.ok('▸ on the team lists its sub-agents under it', mates.length === panes && mates.every((r) => r.depth === 1), mates.map((r) => r.label));
  R.ok('unfolding the team is remembered', ((await ev('__flow.state().ui.open')) || []).includes(`flow:t:${team.id}`));
  await shot('02-team-open-sidebar.png');
  await clickSel(`${rowSel(`win|${team.id}`)} .g[data-tog]`);
  rs = await rows();
  R.ok('▾ folds it again', !rs.some((r) => r.act.startsWith(`mate|${team.id}|`)) && !((await ev('__flow.state().ui.open')) || []).includes(`flow:t:${team.id}`));
  await clickSel(rowSel(`win|${team.id}`));
  R.ok('clicking the team name brings its window to the front', await ev(`document.querySelector('.win[data-id="${team.id}"]').classList.contains('front')`));
}

/* ---------- going to a window leaves it ready to type: its row, a ⌘K result, from far out too; real key presses that
   must land in that window's own input and nowhere else (zoom's rule, STATUS "ready to type") ---------- */
{
  const textOf = (wid) => ev(`(() => { const t = __flow.term(${JSON.stringify(wid)}); return t ? t.getText(60) : ''; })()`);
  const typeIn = async (word) => { await type(page, `echo ${word}`); await key(page, 'Enter'); };
  /* two shells of our own in the main space, so keys can be typed for real */
  const main = (await rows()).find((r) => r.space === 'zone|' && r.grp === 'agents' && r.depth === 0 && r.act.startsWith('win|'));
  if (main) await clickSel(rowSel(main.act));
  const shells = [await ev('__flow.spawn("shell")'), await ev('__flow.spawn("shell")')];
  for (let i = 0; i < 40 && (await Promise.all(shells.map((id) => textOf(id)))).some((t) => !/\$|#|%/.test(t)); i++) await sleep(250);
  await sleep(500);
  const landed = async (word, wid) => {
    const other = shells.find((x) => x !== wid);
    let ok = false;
    for (let i = 0; i < 30 && !(ok = (await textOf(wid)).includes(word)); i++) await sleep(150);
    return { here: ok, elsewhere: (await textOf(other)).includes(word) };
  };
  /* from its row, at 100% */
  for (const [n, wid] of shells.entries()) {
    await clickSel(rowSel(`win|${wid}`));
    const word = `rowkey${n}${Date.now() % 100000}`;
    await typeIn(word);
    const r = await landed(word, wid);
    R.ok(`clicking a shell's row, then typing: the keys land in that shell and nowhere else (${n + 1} of 2)`, r.here && !r.elsewhere, r);
  }
  /* from far out: pinch the space out (Chromium's trackpad pinch is a ctrl-wheel), then click a row */
  const vp = await rowRect('#viewport');
  const widthOf = () => ev(`document.querySelector('.win[data-id="${shells[0]}"]').getBoundingClientRect().width`);
  const w100 = await widthOf();
  for (let i = 0; i < 12; i++) { await mouse(page, 'mouseWheel', vp.cx, vp.cy, { deltaX: 0, deltaY: 40, modifiers: 2 }); await sleep(30); }
  await sleep(600);
  const z = (await widthOf()) / w100;
  await clickSel(rowSel(`win|${shells[0]}`));
  await sleep(700);
  const wordFar = `farkey${Date.now() % 100000}`;
  await typeIn(wordFar);
  const far = await landed(wordFar, shells[0]);
  R.ok('pinched far out, clicking a shell\'s row, then typing: the keys land in that shell', z < 0.8 && far.here && !far.elsewhere, { zoom: z, ...far });
  /* and back to 100%: a row's click keeps the zoom (batch 7), and the rest of the walk is at full size */
  const zoomNow = () => ev(`__flow.state().ws.find((w) => w.id === 'flow').zoom || 1`);
  for (let i = 0; i < 40 && (await zoomNow()) < 0.995; i++) { await mouse(page, 'mouseWheel', vp.cx, vp.cy, { deltaX: 0, deltaY: (await zoomNow()) < 0.9 ? -40 : -4, modifiers: 2 }); await sleep(30); }
  for (let i = 0; i < 40 && (await zoomNow()) > 1.005; i++) { await mouse(page, 'mouseWheel', vp.cx, vp.cy, { deltaX: 0, deltaY: 2, modifiers: 2 }); await sleep(30); }
  await sleep(600);
  /* a ⌘K result: search for the shell, click its row in the results */
  const title = await ev(`(__flow.windows().find((w) => w.id === ${JSON.stringify(shells[1])}) || {}).title`);
  const qr = await rowRect('#q');
  await click(page, qr.cx, qr.cy);
  await key(page, 'a', 2);
  await type(page, String(title || 'shell').toLowerCase().slice(0, 12));
  await sleep(700);
  if (await rowRect(rowSel(`win|${shells[1]}`))) {
    await clickSel(rowSel(`win|${shells[1]}`));
    const wordK = `cmdkkey${Date.now() % 100000}`;
    await typeIn(wordK);
    const k = await landed(wordK, shells[1]);
    R.ok('a ⌘K result clicked, then typing: the keys land in that window', k.here && !k.elsewhere, k);
  } else R.ok('a ⌘K result clicked, then typing: the keys land in that window', false, { title, results: (await rows()).map((r) => r.act).slice(0, 8) });
  await ev(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  /* a note: its row, then typing goes into its text */
  const nr = (await rows()).find((r) => r.space === 'zone|' && r.grp === 'notes' && r.act.startsWith('note|') && !r.dim);
  if (R.ok('the test state has an open note to type into', !!nr)) {
    await clickSel(rowSel(nr.act));
    const wordN = `notekey${Date.now() % 100000}`;
    await type(page, wordN);
    await sleep(400);
    const body = await ev(`(__flow.state().ws.find((w) => w.id === 'flow').notes.find((n) => n.id === ${JSON.stringify(nr.act.split('|')[1])}) || {}).body || ''`);
    R.ok('clicking a note\'s row, then typing: the text goes into that note', body.includes(wordN), { note: nr.label, tail: body.slice(-60) });
  }
  /* a page: its row puts the keys in the page */
  const pr = (await rows()).find((r) => r.act.startsWith('tab|'));
  if (R.ok('the test state has an open page row to click', !!pr)) {
    await clickSel(rowSel(pr.act));
    const wid = pr.act.split('|')[1];
    let inPage = false;
    for (let i = 0; i < 10 && !(inPage = await ev(`(() => { const w = document.querySelector('.win[data-id="${wid}"]'); const a = document.activeElement; return !!w && !!a && w.contains(a) && a.tagName === 'WEBVIEW'; })()`)); i++) await sleep(150);
    R.ok('clicking a page\'s row: the keys go to that page', inPage, await ev(`(document.activeElement && (document.activeElement.tagName + '.' + document.activeElement.className)) + ''`));
  }
}

/* ---------- sub-workspaces: a heading each after the main workspace's things, folded, each with its own agents, notes
   and pages ---------- */
if (R.ok('the test state has a sub-workspace', !!zone)) {
  rs = await rows();
  const zr = rs.find((r) => r.act === `zone|${zone.id}`);
  R.ok('a sub-workspace\'s heading comes after everything of the main workspace, folded', !!zr && zr.grp === 'space' && rs.filter((r) => r.space === 'zone|').every((r) => rs.indexOf(r) < rs.indexOf(zr)) && zr.glyph === '▸', zr);
  await unfoldZone(zone.id);
  rs = await rows();
  const items = underZone(rs, zone.id);
  R.ok('▸ on it lists its own items under it, as many as its count', items.length > 0 && items.length === +rs.find((r) => r.act === `zone|${zone.id}`).meta, items.map((r) => r.label));
  const mainActs = new Set(rs.filter((r) => r.space === 'zone|').map((r) => r.act));
  R.ok('nothing listed under it is also listed in the main sections', items.length > 0 && items.every((r) => !mainActs.has(r.act)), items.filter((r) => mainActs.has(r.act)).map((r) => r.label));
  await shot('03-subworkspace-open-sidebar.png');
  const item = items.find((r) => r.act.startsWith('win|') || r.act.startsWith('note|'));
  if (R.ok('the sub-workspace lists an agent or a note', !!item)) {
    await clickSel(rowSel(item.act));
    const id = item.act.split('|')[1];
    const front = await ev(`(() => { const s = __flow.state().ws.find((w) => w.id === 'flow'); const w = s.windows.find((x) => x.id === ${JSON.stringify(id)} || x.noteId === ${JSON.stringify(id)}); const el = w && document.querySelector('.win[data-id="' + w.id + '"]'); if (!el) return null; const b = el.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return { front: el.classList.contains('front'), inView: b.left >= v.left - 2 && b.right <= v.right + 2 }; })()`);
    R.ok('clicking an item in it goes there: that window in front and in view', !!front && front.front && front.inView, { item: item.label, front });
  }
}

/* ---------- browser: open pages, then sections of saved pages; a page shows once ---------- */
const openPageRows = (list) => list.filter((r) => r.space === 'zone|' && r.grp === 'browser' && r.depth === 0 && r.act.startsWith('tab|'));
/* The url a tab row shows: the window's tab, or its page note's url for a window that has not reported tabs. */
const urlOfTab = (act) => ev(`(() => { const [, wid, i] = ${JSON.stringify(act)}.split('|'); const ws = __flow.state().ws.find((x) => x.windows.some((w) => w.id === wid)); const w = ws.windows.find((x) => x.id === wid); const n = ws.notes.find((x) => x.id === w.noteId); return (w.tabs && w.tabs[+i] ? w.tabs[+i].url : n && n.url) || ''; })()`);
const savedBy = async (url) => ((await flowWs()).saved || []).find((x) => x.url === url);
const titleOf = async (sid) => ((await sections('page')).find((f) => f.id === sid) || {}).title;
rs = await rows();
let open = openPageRows(rs);
const zones = (before.zones || []).map((zn) => zn.name);
if (R.ok('the test state has at least three open pages that are not saved', open.length >= 3, open.map((r) => r.label))) {
  const secs = (await sections('page')).map((f) => f.title);
  const p1 = open[0];
  const items = await rightClick(rowSel(p1.act));
  const want = [...secs.map((s) => `save to ${s}`), 'save to a new section', ...zones.map((z) => `move to ${z}`), 'close'];
  R.ok('right-click on an open page: save to each section, a new section, move to each sub-workspace, close', JSON.stringify(items) === JSON.stringify(want), { items, want });
  await escape();

  await rowPick(rowSel(p1.act), 'save to a new section');
  const was = await renameTo('papers');
  const p1url = await urlOfTab(p1.act);
  const saved1 = await savedBy(p1url);
  R.ok('"save to a new section" makes the section with the page in it, its name in rename', /^new section/.test(was || '') && !!saved1 && (await titleOf(saved1.section)) === 'papers', { was, saved1 });
  rs = await rows();
  const papers = saved1 && saved1.section;
  const inSec = saved1 && rs.find((r) => r.act === `saved|${saved1.id}`);
  R.ok('it shows once, inside its section, bright because it is open', !!inSec && inSec.depth === 1 && !inSec.dim && !openPageRows(rs).some((r) => r.act === p1.act), inSec);

  open = openPageRows(rs);
  const p2 = open[0];
  const p2url = await urlOfTab(p2.act);
  await htmlDrag(rowSel(p2.act), rowSel(`sec|${papers}`));
  const saved2 = await savedBy(p2url);
  R.ok('dragging an open page onto a section saves it there', !!saved2 && saved2.section === papers, saved2);
  await shot('04-saved-sections-sidebar.png');

  if (R.ok('the page saved to the new section is there for the × checks', !!saved1)) {
    R.ok('a saved page that is open has a × that closes it (item 48)', !!inSec && inSec.x.join() === 'close', inSec);
    await clickSel(`${rowSel(`saved|${saved1.id}`)} [data-close]`);
    let r1 = null;
    for (let i = 0; i < 30 && !((r1 = (rs = await rows()).find((r) => r.act === `saved|${saved1.id}`)) && r1.dim); i++) await sleep(150);
    const stillOpen = (await rows()).some((r) => r.act === p1.act);
    R.ok('× on it closes it; it stays in its section, dim, and now its × removes it from saved', !stillOpen && !!r1 && r1.dim && r1.x.join() === 'unsave', { stillOpen, r1 });
    await clickSel(rowSel(`saved|${saved1.id}`));
    const r1b = (await rows()).find((r) => r.act === `saved|${saved1.id}`);
    R.ok('clicking it opens the page again, and the row is bright', !!r1b && !r1b.dim, r1b);
  }
  const other = (await sections('page')).find((f) => f.id !== papers);
  if (R.ok('a second saved page and another section are there for "move to"', !!saved2 && !!other)) {
    await rowPick(rowSel(`saved|${saved2.id}`), `move to ${other.title}`);
    R.ok(`"move to ${other.title}" moves it`, (await savedBy(p2url)).section === other.id);
  }
  const sr = await rowRect(`${rowSel(`sec|${papers}`)} .l`);
  await dblclick(page, sr.cx, sr.cy);
  await sleep(250);
  await renameTo('to read');
  R.ok('double-click a section renames it in place, its pages stay in it', (await titleOf(papers)) === 'to read' && (await savedBy(p1url)).section === papers, await sections('page'));
  if (R.ok('the first saved page is still there for "remove from saved"', !!saved1)) {
    await rowPick(rowSel(`saved|${saved1.id}`), 'remove from saved');
    rs = await rows();
    R.ok('"remove from saved" takes it out; still open, it is back with the open pages', !(await savedBy(p1url)) && !rs.some((r) => r.act === `saved|${saved1.id}`) && openPageRows(rs).length > 0);
  }
  rs = await rows();
  const savedList = (await flowWs()).saved || [];
  const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '');
  const savedUrls = new Set(savedList.map((x) => norm(x.url)));
  const seen = new Map();
  for (const r of rs) {
    const [k, id] = r.act.split('|');
    const sv = k === 'saved' ? savedList.find((x) => x.id === id) : null;
    const u = k === 'tab' ? norm(await urlOfTab(r.act)) : sv ? norm(sv.url) : null;
    if (u && savedUrls.has(u)) seen.set(u, [...(seen.get(u) || []), r.act]);
  }
  const twice = [...seen.entries()].filter(([, acts]) => acts.length > 1 || acts.some((a) => !a.startsWith('saved|')));
  R.ok('a saved page shows once, as its saved row, never as an open page too', seen.size > 0 && twice.length === 0, { twice, seen: seen.size });
  await shot('05-browser-sidebar.png');
}

/* ---------- hovering a page row shows that page's own title, url and what it is about, nothing else ---------- */
{
  const tabRow = (await rows()).find((r) => r.act.startsWith('tab|') && r.label !== 'new page');
  if (R.ok('the test state has an open tab to hover', !!tabRow)) {
    const url = await urlOfTab(tabRow.act);
    const rr = await rowRect(rowSel(tabRow.act));
    await mouse(page, 'mouseMoved', rr.x + 40, rr.cy);
    let card = null;
    for (let i = 0; i < 20 && !(card = await ev(`(() => { const c = document.querySelector('.sbcard .nbrief'); return c ? { title: (c.querySelector('.nb-t') || {}).textContent, site: (c.querySelector('.nb-s') || {}).textContent } : null; })()`)); i++) await sleep(100);
    const host = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    R.ok('a tab\'s hover card is its page\'s brief: its title and site', !!card && !!card.title && (card.site || '').startsWith(host), { card, label: tabRow.label, host });
    await mouse(page, 'mouseMoved', 900, 500);
    await sleep(200);
  }
}

/* ---------- a new section: nothing at rest; with the pointer over the group a "+" at the right of its heading makes
   an empty one, named in place; while a page or note is dragged its group's heading reads "+ new section", and a drop
   on it makes one with it inside; nothing in the list moves (owner, 19:19 and 19:25; queue items 22 and 26) ---------- */
{
  await hover(null);
  rs = await rows();
  R.ok('with the pointer away and nothing dragged, no "+" is on screen, as a row or on a heading', !rs.some((r) => /^new(sec|zone)\|/.test(r.act)) && (await makeShown()).length === 0, { rows: rs.filter((r) => /^new(sec|zone)\|/.test(r.act)), headings: await makeShown() });
  const t0 = await tops();
  await hover('#sblist .grp[data-grp="flow:g:browser"]');
  rs = await rows();
  const t1 = await tops();
  R.ok('with the pointer over browser, a "+" shows at the right of its heading, and nothing in the list moves', JSON.stringify(await makeShown()) === '["newsec|page"]' && !rs.some((r) => /^new(sec|zone)\|/.test(r.act)) && JSON.stringify(t0) === JSON.stringify(t1), { shown: await makeShown(), moved: t0.length !== t1.length || t0.some((y, i) => y !== t1[i]) });
  await clickSel('#sblist .grp[data-grp="flow:g:browser"] .gadd');
  const was = await renameTo('later');
  const later = (await sections('page')).find((f) => f.title === 'later');
  const lr = later && (await rows()).find((r) => r.act === `sec|${later.id}`);
  R.ok('it makes an empty section, named in place, with no count', /^new section/.test(was || '') && !!lr && lr.meta === '', { was, lr });
  if (R.ok('the new section is there to remove', !!later)) {
    const items = await rightClick(rowSel(`sec|${later.id}`));
    R.ok('an empty section has "remove" in its menu', items.includes('remove'), items);
    if (items.includes('remove')) await menuPick('remove'); else await escape();
    R.ok('removed, it is gone', !(await sections('page')).some((f) => f.id === later.id));
  }
  const op = openPageRows(await rows())[0];
  if (R.ok('the test state has an open page to drag onto browser\'s heading', !!op)) {
    const url = await urlOfTab(op.act);
    const d = await dragToHeading(rowSel(op.act), 'browser');
    R.ok('while a page is dragged, browser\'s heading reads "+ new section" (notes\' does not), and nothing in the list moves', !!d && d.says.browser === '+ new section' && d.says.notes !== '+ new section' && !d.moved, d);
    const w2 = await renameTo('drafts');
    const sv = await savedBy(url);
    R.ok('dropping an open page on "+ new section" makes a section with it inside, named in place', /^new section/.test(w2 || '') && !!sv && (await titleOf(sv.section)) === 'drafts', { w2, sv });
  }
  const nr = (await rows()).find((r) => r.space === 'zone|' && r.grp === 'notes' && r.depth === 0 && r.act.startsWith('note|'));
  if (R.ok('the test state has a note at the top of notes', !!nr)) {
    const nid = nr.act.split('|')[1];
    const d = await dragToHeading(rowSel(nr.act), 'notes');
    R.ok('while a note is dragged, notes\' heading reads "+ new section" (browser\'s does not), and nothing in the list moves', !!d && d.says.notes === '+ new section' && d.says.browser !== '+ new section' && !d.moved, d);
    const w3 = await renameTo('plans');
    const f = (await sections('note')).find((x) => x.title === 'plans');
    const n = (await flowWs()).notes.find((x) => x.id === nid);
    rs = await rows();
    const at = rs.findIndex((r) => f && r.act === `folder|${f.id}`);
    R.ok('dropping a note on "+ new section" makes a note section with it inside, named in place', /^new section/.test(w3 || '') && !!f && n.parent === f.id && at >= 0 && rs[at + 1] && rs[at + 1].act === nr.act && rs[at + 1].depth === 1, { w3, parent: n.parent, f });
    await shot('07-new-sections-sidebar.png');
    /* item 38: dropped among the notes outside a section, it leaves its section and keeps its place; while it is over
       them those notes light up together, and nothing moves */
    const looseRows = async () => (await rows()).filter((r) => r.space === 'zone|' && r.grp === 'notes' && r.depth === 0 && r.act.startsWith('note|') && r.act !== nr.act);
    if ((await looseRows()).length < 2) {
      /* a new note opens in the space on screen: show the main space first, through an agent of it */
      const main = (await rows()).find((r) => r.space === 'zone|' && r.grp === 'agents' && r.depth === 0 && r.act.startsWith('win|'));
      if (main) await clickSel(rowSel(main.act));
      await ev('(() => { __flow.spawn("note"); return true; })()');
      for (let i = 0; i < 20 && (await looseRows()).length < 2; i++) await sleep(150);
    }
    const loose = (await looseRows())[0];
    if (R.ok('the test state has two notes outside a section', (await looseRows()).length >= 2, (await looseRows()).map((r) => r.label))) {
      const t0 = await tops();
      let lit = null;
      await htmlDrag(rowSel(nr.act), rowSel(loose.act), null, async () => { lit = { area: await ev(`[...document.querySelectorAll('#sblist .tr.drop.area')].map((e) => e.dataset.act)`), all: await ev(`[...document.querySelectorAll('#sblist .tr[data-drop="note|"]')].map((e) => e.dataset.act)`), moved: JSON.stringify(await tops()) !== JSON.stringify(t0) }; });
      R.ok('dropped among the notes outside a section, it leaves its section; they light up as one, and nothing moves', !(await flowWs()).notes.find((x) => x.id === nid).parent && !!lit && lit.area.length >= 2 && JSON.stringify(lit.area) === JSON.stringify(lit.all) && !lit.all.includes(nr.act) && !lit.moved, lit);
      let lit2 = null;
      await htmlDrag(rowSel(loose.act), rowSel(nr.act), null, async () => { lit2 = await ev(`[...document.querySelectorAll('#sblist .tr.drop')].map((e) => e.dataset.act)`); });
      R.ok('a note that is in no section does not light them up', !!lit2 && lit2.length === 0 && !(await flowWs()).notes.find((x) => x.id === loose.act.split('|')[1]).parent, lit2);
      if (f) await htmlDrag(rowSel(nr.act), rowSel(`folder|${f.id}`));
      R.ok('dropped on its section again, it goes back in', !!f && (await flowWs()).notes.find((x) => x.id === nid).parent === f.id);
    }
    const mi = await rightClick(rowSel(nr.act));
    if (mi.includes('move out of its section')) await menuPick('move out of its section'); else await escape();
    R.ok('"move out of its section" in its menu takes it out of its section', mi.includes('move out of its section') && !(await flowWs()).notes.find((x) => x.id === nid).parent, mi);
    if (R.ok('the note section from the drop is there to remove', !!f)) {
      const fi = await rightClick(rowSel(`folder|${f.id}`));
      if (fi.includes('remove')) await menuPick('remove'); else await escape();
      R.ok('the empty note section can be removed', fi.includes('remove') && !(await flowWs()).notes.some((x) => x.id === f.id), fi);
    }
  }
}

/* ---------- a row's × takes the row away: it deletes what is closed, with undo (principle 2: the same for notes and
   pages); an open note has none, since closing it leaves its row (batch-2 item 4) ---------- */
{
  await hover(null);
  rs = await rows();
  const says = await headSays();
  R.ok('once the drags are over, no heading says "+ new section" or anything else', Object.keys(says).length >= 3 && Object.values(says).every((v) => v === ''), says);
  const openNote = rs.find((r) => r.act.startsWith('note|') && !r.dim);
  R.ok('an open note has no ×', !!openNote && openNote.x.length === 0, openNote);
  const closedNote = rs.find((r) => r.act.startsWith('note|') && r.dim && r.x.includes('del'));
  if (R.ok('the test state has a closed note with a ×', !!closedNote)) {
    const nid = closedNote.act.split('|')[1];
    const n0 = (await flowWs()).notes.find((x) => x.id === nid);
    await clickSel(`${rowSel(closedNote.act)} [data-del]`);
    const t = await toastText();
    R.ok('× on a closed note deletes it and says so, with undo', !(await flowWs()).notes.some((x) => x.id === nid) && /^deleted .* · undo$/.test(t), t);
    const u = await rowRect('#toast button');
    if (u) { await click(page, u.cx, u.cy); await sleep(400); }
    const n1 = (await flowWs()).notes.find((x) => x.id === nid);
    R.ok('undo puts it back as it was', !!n1 && n1.title === n0.title && n1.body === n0.body && (n1.parent || null) === (n0.parent || null), n1);
  }
  const closedSaved = (await rows()).find((r) => r.act.startsWith('saved|') && r.dim && r.x.includes('unsave'));
  if (R.ok('the test state has a saved page that is not open', !!closedSaved)) {
    const sid = closedSaved.act.split('|')[1];
    const s0 = ((await flowWs()).saved || []).find((x) => x.id === sid);
    await clickSel(`${rowSel(closedSaved.act)} [data-unsave]`);
    const t = await toastText();
    R.ok('× on a saved page that is not open removes it from saved, with undo', !((await flowWs()).saved || []).some((x) => x.id === sid) && / · undo$/.test(t), t);
    const u = await rowRect('#toast button');
    if (u) { await click(page, u.cx, u.cy); await sleep(400); }
    const s1 = ((await flowWs()).saved || []).find((x) => x.id === sid);
    R.ok('undo puts it back in its section', !!s1 && s1.section === s0.section && s1.url === s0.url, s1);
  }
}

/* ---------- moving a tool to the goal it serves (principle 1): drop it on a sub-workspace ---------- */
if (R.ok('the test state has a sub-workspace to drop onto', !!zone)) {
  rs = await rows();
  const nr = rs.find((r) => r.space === 'zone|' && r.grp === 'notes' && r.act.startsWith('note|') && !r.dim);
  const ar = rs.find((r) => r.space === 'zone|' && r.grp === 'agents' && r.act.startsWith('win|') && r.glyph === '›_');
  for (const r of [nr, ar].filter(Boolean)) {
    await htmlDrag(rowSel(r.act), rowSel(`zone|${zone.id}`));
    const t = await toastText();
    await unfoldZone(zone.id);
    let list = await rows();
    const there = underZone(list, zone.id).some((x) => x.act === r.act);
    const inMain = list.some((x) => x.act === r.act && x.space === 'zone|');
    R.ok(`dropping "${r.label}" on ${zone.name} moves it there: listed under it, not in the main sections`, there && !inMain, { there, inMain, t });
    if (r === nr) await shot('08-moved-to-goal-sidebar.png');
    const items = await rightClick(rowSel(r.act));
    if (items.includes('move to the main workspace')) await menuPick('move to the main workspace'); else await escape();
    list = await rows();
    R.ok('its menu has "move to the main workspace", which brings it back', items.includes('move to the main workspace') && list.some((x) => x.act === r.act && x.space === 'zone|') && !underZone(list, zone.id).some((x) => x.act === r.act), items);
  }
}

/* ---------- every row drags, open or closed: onto a sub-workspace, or onto a workspace's pill ---------- */
{
  const closedAgent = (await rows()).find((r) => r.act.startsWith('reopen|'));
  if (zone && R.ok('the test state has a closed agent', !!closedAgent)) {
    await htmlDrag(rowSel(closedAgent.act), rowSel(`zone|${zone.id}`));
    await unfoldZone(zone.id);
    const list = await rows();
    const under = underZone(list, zone.id).find((x) => x.act === closedAgent.act);
    R.ok('a closed agent dropped on a sub-workspace moves there and stays closed', !!under && under.dim && !list.some((x) => x.act === closedAgent.act && x.space === 'zone|' && x.grp === 'agents'), under);
    const items = await rightClick(rowSel(closedAgent.act));
    if (items.includes('move to the main workspace')) await menuPick('move to the main workspace'); else await escape();
    R.ok('its menu moves it back to the main workspace', (await rows()).some((x) => x.act === closedAgent.act && x.space === 'zone|' && x.grp === 'agents'), items);
  }
  const closedNote = (await rows()).find((r) => r.act.startsWith('note|') && r.dim);
  const pills = await ev(`[...document.querySelectorAll('#spaces .sp')].map((p) => p.dataset.i)`);
  if (R.ok('the test state has a closed note and a second workspace', !!closedNote && pills.length > 1)) {
    const nid = closedNote.act.split('|')[1];
    await htmlDrag(rowSel(closedNote.act), '#spaces .sp[data-i="1"]');
    const s = await ev('__flow.state()');
    const where = s.ws.find((w) => w.notes.some((n) => n.id === nid));
    R.ok('a closed note dropped on another workspace\'s pill moves to that workspace', where && where.id === s.ws[1].id && !(await rows()).some((r) => r.act === closedNote.act), where && where.id);
    await clickSel('#spaces .sp[data-i="1"]');
    await sleep(500);
    await htmlDrag(rowSel(closedNote.act), '#spaces .sp[data-i="0"]');
    await clickSel('#spaces .sp[data-i="0"]');
    await sleep(500);
    R.ok('and dropped on the first workspace\'s pill, it comes back', (await ev('__flow.state()')).ws[0].notes.some((n) => n.id === nid) && (await rows()).some((r) => r.act === closedNote.act));
  }
  /* an open page of its own: by now the earlier steps have saved the others */
  const pw = await ev('__flow.openPage("https://www.iana.org/help/example-domains")');
  let tab = null;
  for (let i = 0; i < 60 && !(tab = openPageRows(await rows()).find((r) => r.act.startsWith(`tab|${pw}|`))); i++) await sleep(150);
  if (R.ok('the test state has an open page and a second workspace', !!tab && pills.length > 1, { tab, pills: pills.length })) {
    const wid = tab.act.split('|')[1];
    await htmlDrag(rowSel(tab.act), '#spaces .sp[data-i="1"]');
    const s = await ev('__flow.state()');
    R.ok('an open page dropped on another workspace\'s pill moves its window there', s.ws[1].windows.some((w) => w.id === wid) && !s.ws[0].windows.some((w) => w.id === wid));
    await clickSel('#spaces .sp[data-i="1"]');
    await sleep(600);
    const back = (await rows()).find((r) => r.act.startsWith(`tab|${wid}|`));
    if (back) await htmlDrag(rowSel(back.act), '#spaces .sp[data-i="0"]');
    await clickSel('#spaces .sp[data-i="0"]');
    await sleep(600);
    R.ok('and back again', (await ev('__flow.state()')).ws[0].windows.some((w) => w.id === wid));
    const own = (await rows()).find((r) => r.act.startsWith(`tab|${wid}|`));
    if (own) await clickSel(`${rowSel(own.act)} [data-close]`);
    for (let i = 0; i < 30 && (await ev('__flow.state()')).ws[0].windows.some((w) => w.id === wid); i++) await sleep(150);
  }
}

/* ---------- the star in a page saves it into the section used last; the sidebar follows ---------- */
{
  const tab = (await rows()).find((r) => r.act.startsWith('tab|') && r.label !== 'new page');
  if (R.ok('the test state has an open page to save with its star', !!tab)) {
    const wid = tab.act.split('|')[1];
    const url = await urlOfTab(tab.act);
    await clickSel(rowSel(tab.act));
    const star = `.win[data-id="${wid}"] .pstar`;
    await settled(`.win[data-id="${wid}"]`);
    /* what the first click meets: the star's state, what is under the click point, the address the window shows, and
       how far the star moved in the 300 ms after the press */
    const sr = await rect(page, star);
    if (!sr) throw new Error(`nothing at ${star}`);
    const before = await ev(`(() => { const b = document.querySelector(${JSON.stringify(star)}); const e = document.elementFromPoint(${sr.cx}, ${sr.cy}); const w = __flow.state().ws.flatMap((x) => x.windows).find((x) => x.id === ${JSON.stringify(wid)}); return { star: b.textContent + ' ' + b.className, under: e === b || b.contains(e) ? 'the star' : e ? (e.getAttribute('class') || e.tagName) : null, shown: w && w.tabs ? (w.tabs[w.tab || 0] || {}).url : null }; })()`);
    before.url = url;
    before.savedAlready = !!(await savedBy(url));
    await click(page, sr.cx, sr.cy);
    await sleep(300);
    const sr2 = await rect(page, star);
    before.moved = sr2 ? [Math.round(sr2.cx - sr.cx), Math.round(sr2.cy - sr.cy)] : null;
    await sleep(150);
    let sv = null;
    for (let i = 0; i < 20 && !(sv = await savedBy(url)); i++) await sleep(150);
    const tip = await ev(`(() => { const b = document.querySelector(${JSON.stringify(star)}); return b ? { text: b.textContent, title: b.title } : null; })()`);
    const row = sv && (await rows()).find((r) => r.act === `saved|${sv.id}`);
    R.ok('the star saves the page; the sidebar shows it once, in its section, bright', !!sv && !!row && !row.dim && !openPageRows(await rows()).some((r) => r.act === tab.act), { sv, row, before });
    R.ok('the star turns on and names the section by its name', !!tip && tip.text === '★' && tip.title === `saved in ${await titleOf(sv && sv.section)}, click to remove it`, tip);
    await clickSel(star);
    await sleep(500);
    let gone = false;
    for (let i = 0; i < 20 && !(gone = !(await savedBy(url))); i++) await sleep(150);
    R.ok('clicking the star again takes it out of saved, and its row is an open page again', gone && (await rows()).some((r) => r.act === tab.act), { gone });
  }
}

/* ---------- ⌘K finds a page with a note that was closed and never saved (notes.js's page records); × deletes it, with undo ---------- */
{
  const wid = await ev('__flow.openPage("https://example.net/")');
  let loaded = false;
  for (let i = 0; i < 60 && !loaded; i++) { loaded = /example\.net/.test(await urlOfTab(`tab|${wid}|0`)) && !!(await ev(`(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((e) => e.dataset.act === 'tab|${wid}|0'); return r && /Example Domain/.test(r.textContent); })()`)); if (!loaded) await sleep(250); }
  const pen = await rowRect(`.win[data-id="${wid}"] .tb .act`);
  await click(page, pen.cx, pen.cy);
  await sleep(500);
  await type(page, 'a note about example net');
  await sleep(600);
  const red = await rowRect(`.win[data-id="${wid}"] [data-l=close]`);
  await click(page, red.cx, red.cy);
  await sleep(600);
  const k = await ev(`FlowNotes.key("https://example.net/")`);
  const rec = await ev(`FlowNotes.records().find((r) => r.key === ${JSON.stringify(k)}) || null`);
  if (R.ok('a page with a note keeps a page record after it closes', !!rec && rec.hasNote, rec)) {
    await ev(`(() => { const q = document.getElementById('q'); q.focus(); q.value = ''; return true; })()`);
    await type(page, 'example');
    /* typed keys can lag at high load: wait for the whole word and the search's answer before aiming at a row */
    for (let i = 0; i < 40 && !(await ev(`document.getElementById('q').value === 'example' && !!document.querySelector('#sblist .tr[data-act="rec|${k}"]') && ![...document.querySelectorAll('#sblist .empty')].some((e) => /searching/.test(e.textContent))`)); i++) await sleep(250);
    await sleep(300);
    const hit = (await rows()).find((r) => r.act === `rec|${k}`);
    R.ok('⌘K lists it under pages not saved anywhere, with a × to delete it', !!hit && await ev(`!!document.querySelector('#sblist .tr[data-act="rec|${k}"] [data-delpage]')`), hit);
    if (hit) {
      const xr = await rowRect(`#sblist .tr[data-act="rec|${k}"] [data-delpage]`);
      await click(page, xr.cx, xr.cy);
      await sleep(450);
      const gone = !(await ev(`FlowNotes.records().some((r) => r.key === ${JSON.stringify(k)})`)), tt = await toastText();
      R.ok('× deletes the page and its note, with undo', gone && /^deleted .* · undo$/.test(tt), { gone, toast: tt });
      const u = await rowRect('#toast button');
      if (u) { await click(page, u.cx, u.cy); await sleep(400); }
      R.ok('undo brings it back, note and all', await ev(`(FlowNotes.records().find((r) => r.key === ${JSON.stringify(k)}) || {}).hasNote === true`));
    }
    const qr = await rowRect('#q');
    await click(page, qr.cx, qr.cy);
    await key(page, 'a', 2);
    await key(page, 'Backspace');
    await sleep(300);
  }
}

/* ---------- page rows (batch-2 items 9, 13, 4): two pages with the same name show their site; a new tab has no row
   until a page is opened in it; × on an open page closes it, with no toast ---------- */
{
  const urlOfRow = async (act) => (act.startsWith('saved|') ? (((await flowWs()).saved || []).find((x) => x.id === act.split('|')[1]) || {}).url : await urlOfTab(act)) || '';
  const site = (u) => u.replace(/^https?:\/\/(www\.)?/, '').split(/[/?#]/)[0];
  const ids = [await ev('__flow.openPage("https://example.com/?same")'), await ev('__flow.openPage("https://example.org/?same")')];
  let same = [];
  for (let i = 0; i < 80; i++) {
    same = (await rows()).filter((r) => r.label === 'Example Domain' && /^(tab|saved)\|/.test(r.act));
    if (same.filter((r) => r.act.startsWith(`tab|${ids[0]}|`) || r.act.startsWith(`tab|${ids[1]}|`)).length === 2) break;
    await sleep(250);
  }
  const seen = [];
  for (const r of same) seen.push({ meta: r.meta, site: site(await urlOfRow(r.act)) });
  const apart = seen.every((a) => a.meta && seen.every((b) => a.site === b.site || a.meta !== b.meta));
  R.ok('pages with the same name each show their site, so two sites never look alike', seen.length >= 2 && apart && seen.some((x) => x.meta.startsWith('example.org')), seen);
  const named = (await rows()).filter((r) => /^(tab|saved)\|/.test(r.act));
  const lone = named.find((r) => named.filter((x) => x.label === r.label).length === 1);
  R.ok('a page whose name is its own shows no site', !!lone && lone.meta === '', lone);

  const wid = ids[1];
  const tabsOf = () => ev(`(__flow.state().ws.find((w) => w.id === 'flow').windows.find((w) => w.id === ${JSON.stringify(wid)}) || {}).tabs || []`);
  await clickSel(rowSel(`tab|${wid}|0`));
  const rowsBefore = (await rows()).length;
  await ev(`__flow.menu('new-page')`);
  let tabs = [];
  for (let i = 0; i < 40 && (tabs = await tabsOf()).length < 2; i++) await sleep(150);
  await sleep(300);
  const after = await rows();
  R.ok('a new tab (⌘T) adds no row until a page is opened in it', tabs.length === 2 && tabs.some((t) => !t.url) && after.length === rowsBefore && after.filter((r) => r.act.startsWith(`tab|${wid}|`)).length === 1, { tabs: tabs.map((t) => t.url), rowsBefore, after: after.length });
  const bi = tabs.findIndex((t) => !t.url);
  if (bi >= 0) await ev(`__flow.page(${JSON.stringify(wid)}).closeTab(${bi})`);

  for (let i = 0; i < 40 && (await toastText()); i++) await sleep(250);
  const tr = (await rows()).find((r) => r.act.startsWith(`tab|${ids[0]}|`));
  if (R.ok('the example.com tab has a ×', !!tr && tr.x.join() === 'close', tr)) {
    await clickSel(`${rowSel(tr.act)} [data-close]`);
    const gone = !(await rows()).some((r) => r.act === tr.act);
    const t = await toastText();
    R.ok('× on an open page closes it: its row goes, and no toast says so', gone && t === '', { gone, t });
  }
}

/* ---------- a double-click renames any row in place, notes and pages too; a page's name shows wherever the page
   does, and an empty name gives it its own title back (queue items 2 and 3) ---------- */
{
  rs = await rows();
  const nr = rs.find((r) => r.space === 'zone|' && r.grp === 'notes' && r.act.startsWith('note|') && !r.dim);
  if (R.ok('the test state has an open note', !!nr)) {
    const nid = nr.act.split('|')[1];
    const lr = await rowRect(`${rowSel(nr.act)} .l`);
    await dblclick(page, lr.x + 20, lr.cy);
    await sleep(250);
    const was = await renameTo('renamed note');
    const n = (await flowWs()).notes.find((x) => x.id === nid);
    const wid = (await flowWs()).windows.find((w) => w.noteId === nid).id;
    const heading = await ev(`(() => { const h = document.querySelector('.win[data-id="${wid}"] .ned[data-key="title:${nid}"]'); return h ? h.textContent : null; })()`);
    const row = (await rows()).find((r) => r.act === nr.act);
    R.ok('double-click a note renames it in place: the row, the note and its open window', was === nr.label && n.title === 'renamed note' && !!row && row.label === 'renamed note' && heading === 'renamed note', { was, title: n.title, heading, row });
    const lr2 = await rowRect(`${rowSel(nr.act)} .l`);
    await dblclick(page, lr2.x + 20, lr2.cy);
    await sleep(250);
    await renameTo(nr.label);
  }
  /* item 65: an emptied name gives a note its first line back, and Enter on that name unchanged keeps it unnamed */
  const bodies = Object.fromEntries((await flowWs()).notes.map((x) => [x.id, x.body || '']));
  const nb = (await rows()).find((r) => r.space === 'zone|' && r.grp === 'notes' && r.act.startsWith('note|') && !r.dim && bodies[r.act.split('|')[1]].trim());
  if (R.ok('the test state has an open note with something written in it', !!nb)) {
    const bid = nb.act.split('|')[1];
    const first = bodies[bid].split('\n').map((l) => l.trim()).find(Boolean);
    const l1 = await rowRect(`${rowSel(nb.act)} .l`);
    await dblclick(page, l1.x + 20, l1.cy);
    await sleep(250);
    await key(page, 'a', 2);
    await key(page, 'Backspace');
    await key(page, 'Enter');
    await sleep(400);
    const n1 = (await flowWs()).notes.find((x) => x.id === bid);
    const r1 = (await rows()).find((r) => r.act === nb.act);
    R.ok('emptying a note\'s name gives it its first line back', !!r1 && r1.label === first && !n1.title && n1.titleSet === false, { row: r1 && r1.label, first, title: n1.title, titleSet: n1.titleSet });
    const l2 = await rowRect(`${rowSel(nb.act)} .l`);
    await dblclick(page, l2.x + 20, l2.cy);
    await sleep(250);
    const field = await ev(`(() => { const el = document.activeElement; return el && el.classList.contains('rn') ? el.textContent : null; })()`);
    await key(page, 'Enter');
    await sleep(400);
    const n2 = (await flowWs()).notes.find((x) => x.id === bid);
    const r2 = (await rows()).find((r) => r.act === nb.act);
    R.ok('renaming it starts from that line, and Enter on it unchanged leaves the note unnamed', field === first && !n2.title && n2.titleSet === false && !!r2 && r2.label === first, { field, title: n2.title, titleSet: n2.titleSet, row: r2 && r2.label });
    const l3 = await rowRect(`${rowSel(nb.act)} .l`);
    await dblclick(page, l3.x + 20, l3.cy);
    await sleep(250);
    await renameTo(nb.label);
  }
  const tr = (await rows()).find((r) => r.act.startsWith('tab|') && r.label === 'Example Domain');
  if (R.ok('the test state has an open "Example Domain" page', !!tr)) {
    const url = await urlOfTab(tr.act);
    const lr = await rowRect(`${rowSel(tr.act)} .l`);
    await dblclick(page, lr.x + 20, lr.cy);
    await sleep(250);
    /* what the double-click left: the row under the pointer, whether a name field is open, what holds the keys */
    const at = await ev(`(() => { const e = document.elementFromPoint(${lr.x + 20}, ${lr.cy}); const r = e && e.closest('.tr'); const a = document.activeElement; return { under: r ? r.dataset.act : e ? e.getAttribute('class') || e.tagName : null, field: !!document.querySelector('#sblist .rn'), keys: a ? a.tagName + (a.className ? '.' + String(a.className).split(' ')[0] : '') : null }; })()`);
    const was = await renameTo('my reading');
    const name = await ev(`FlowNotes.nameOf(${JSON.stringify(url)})`);
    const [, twid, ti] = tr.act.split('|');
    const own = await ev(`((__flow.state().ws.flatMap((x) => x.windows).find((x) => x.id === ${JSON.stringify(twid)}) || {}).tabs || [])[${+ti}].title`);
    const row = (await rows()).find((r) => r.act === tr.act);
    R.ok('double-click a page renames it in place: the row shows the name, the page keeps its own title', was === 'Example Domain' && name === 'my reading' && !!row && row.label === 'my reading' && own === 'Example Domain', { was, name, own, row, at });
    await hover(`${rowSel(tr.act)} .l`);
    let card = null;
    for (let i = 0; i < 20 && !(card = await ev(`(() => { const c = document.querySelector('.sbcard .nbrief'); return c ? (c.querySelector('.nb-t') || {}).textContent : null; })()`)); i++) await sleep(100);
    R.ok('hovering it shows the same name', card === 'my reading', card);
    await hover(null);
    const lr2 = await rowRect(`${rowSel(tr.act)} .l`);
    await dblclick(page, lr2.x + 20, lr2.cy);
    await sleep(250);
    await key(page, 'a', 2);
    await key(page, 'Backspace');
    await key(page, 'Enter');
    await sleep(400);
    const row2 = (await rows()).find((r) => r.act === tr.act);
    R.ok('emptying the name gives the page its own title back', (await ev(`FlowNotes.nameOf(${JSON.stringify(url)})`)) === '' && !!row2 && row2.label === 'Example Domain', row2);
    await hover(`${rowSel(tr.act)} .l`);
    let card2 = null;
    for (let i = 0; i < 20 && !(card2 = await ev(`(() => { const c = document.querySelector('.sbcard .nbrief'); return c ? (c.querySelector('.nb-t') || {}).textContent : null; })()`)); i++) await sleep(100);
    R.ok('and its hover card shows that title too, not its site', card2 === 'Example Domain', card2);
    await hover(null);
  }
  /* every page row shows the page's name: the owner's, else its own title */
  const pageRows = (await rows()).filter((r) => r.act.startsWith('tab|'));
  const wrong = [];
  for (const r of pageRows) {
    const [, wid, i] = r.act.split('|');
    const t = await ev(`(() => { const w = __flow.state().ws.flatMap((x) => x.windows).find((x) => x.id === ${JSON.stringify(wid)}); const t = w && w.tabs && w.tabs[${+i}]; return t ? { url: t.url, title: t.title, name: FlowNotes.nameOf(t.url) } : null; })()`);
    if (t && t.title && r.label !== (t.name || t.title)) wrong.push({ label: r.label, ...t });
  }
  R.ok('every open page row shows its page\'s name, else its own title', pageRows.length > 0 && wrong.length === 0, wrong);
}

/* ---------- one menu per tool: a window's right-click menu is its sidebar row's ---------- */
{
  const st0 = await flowWs();
  const pairs = [];
  const term = st0.windows.find((w) => w.type === 'term' && w.cmd === 'claude' && !w.zone);
  const note = st0.windows.find((w) => w.type === 'note' && !w.zone);
  if (term) pairs.push([term.id, `win|${term.id}`]);
  if (note) pairs.push([note.id, `note|${note.noteId}`]);
  /* a page that is not saved has its tab row; a saved page that is open has its saved row, and its window the same menu */
  let list = await rows();
  if (!list.some((r) => r.space === 'zone|' && r.grp === 'browser' && r.depth === 0 && r.act.startsWith('tab|'))) {
    await ev('__flow.openPage("https://example.com/?menu")');
    for (let i = 0; i < 40 && !(list = await rows()).some((r) => r.space === 'zone|' && r.grp === 'browser' && r.depth === 0 && r.act.startsWith('tab|')); i++) await sleep(150);
  }
  const tabRow = list.find((r) => r.space === 'zone|' && r.grp === 'browser' && r.depth === 0 && r.act.startsWith('tab|'));
  if (tabRow) pairs.push([tabRow.act.split('|')[1], tabRow.act]);
  const savedOpen = list.find((r) => r.act.startsWith('saved|') && !r.dim);
  if (savedOpen) {
    const sv = (st0.saved || []).find((x) => x.id === savedOpen.act.split('|')[1]);
    const win = sv && (await ev('__flow.windows()')).find((w) => w.type === 'page' && w.ws === 'flow' && String(w.url || '').replace(/\/+$/, '') === sv.url.replace(/\/+$/, ''));
    if (win) pairs.push([win.id, savedOpen.act]);
  }
  for (const [wid, act] of pairs) {
    await clickSel(rowSel(act));
    const fromRow = await rightClick(rowSel(act));
    await escape();
    /* the row's click can pan to the window: right-click its title bar once nothing moves */
    const tb = await settled(`.win[data-id="${wid}"] > .tb .title`);
    let fromWin = [];
    const hit = tb ? await ev(`(() => { const e = document.elementFromPoint(${tb.cx}, ${tb.cy}); const w = e && e.closest && e.closest('.win'); return w ? w.dataset.id : e ? (typeof e.className === 'string' ? e.className : e.tagName) : null; })()`) : null;
    if (tb) {
      await mouse(page, 'mouseMoved', tb.cx, tb.cy);
      await mouse(page, 'mousePressed', tb.cx, tb.cy, { button: 'right', buttons: 2 });
      await mouse(page, 'mouseReleased', tb.cx, tb.cy, { button: 'right', buttons: 2 });
      await sleep(300);
      fromWin = await ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.firstChild.textContent)`);
      await escape();
    }
    R.ok(`right-clicking the ${{ win: 'agent', note: 'note', tab: 'page', saved: 'saved page' }[act.split('|')[0]]} window gives the same menu as its row`, fromRow.length > 0 && JSON.stringify(fromWin) === JSON.stringify(fromRow), { fromRow, fromWin, wid, hit });
  }
}

/* ---------- sub-workspaces made in place (owner 14:4x): a right-click on the main workspace's heading gives "new
   sub-workspace", named in place; while a row is dragged the end of the list reads "+ new sub-workspace", and a drop on
   it makes one with that tool inside (queue items 22 and 26) ---------- */
if (R.ok('the test state has a sub-workspace for the "new sub-workspace" checks', !!zone)) {
  await hover(null);
  const endShown = () => ev(`(() => { const s = document.querySelector('#sblist .sadd'); return !!s && s.getClientRects().length > 0; })()`);
  R.ok('"+ new sub-workspace" is not on screen at rest, as a row, on a heading or at the end', !(await rows()).some((r) => r.act === 'newzone|') && (await makeShown()).length === 0 && (await endShown()) === false);
  const z0 = ((await flowWs()).zones || []).map((z) => z.id);
  const mm = await rightClick(rowSel('zone|'));
  if (mm.includes('new sub-workspace')) await menuPick('new sub-workspace'); else await escape();
  const was = await renameTo('goal two');
  const zs = (await flowWs()).zones || [];
  const made = zs.find((z) => !z0.includes(z.id));
  R.ok('right-click on the main workspace\'s heading gives "new sub-workspace", which makes one, named in place, and shows it', JSON.stringify(mm) === '["new sub-workspace"]' && /^new sub-workspace/.test(was || '') && !!made && made.name === 'goal two' && (await ev(`__flow.state().ws[0].at`)) === made.id, { mm, was, made, at: await ev(`__flow.state().ws[0].at`) });
  const nr = (await rows()).find((r) => r.space === 'zone|' && r.grp === 'notes' && r.act.startsWith('note|'));
  if (R.ok('the test state has a note to drop on "+ new sub-workspace"', !!nr)) {
    const d = await dragToEnd(rowSel(nr.act));
    const w2 = await renameTo('goal three');
    const zs2 = (await flowWs()).zones || [];
    const made2 = zs2.find((z) => !z0.includes(z.id) && (!made || z.id !== made.id));
    const nid = nr.act.split('|')[1];
    const nw = (await flowWs()).windows.find((w) => w.noteId === nid);
    R.ok('while a row is dragged, the end of the list reads "+ new sub-workspace", and nothing in the list moves', !!d && d.says === '+ new sub-workspace' && !d.moved, d);
    R.ok('dropping a note on it makes a sub-workspace with the note inside, named in place', /^new sub-workspace/.test(w2 || '') && !!made2 && made2.name === 'goal three' && !!nw && nw.zone === made2.id, { w2, made2, zone: nw && nw.zone });
    for (const z of [made2, made].filter(Boolean)) {
      await hover(null);
      const items = await rightClick(rowSel(`zone|${z.id}`));
      if (items.includes('remove')) await menuPick('remove'); else await escape();
    }
    R.ok('both come out again with "remove"', !((await flowWs()).zones || []).some((z) => !z0.includes(z.id)));
    for (let i = 0; i < 40 && (await toastText()); i++) await sleep(250);
  }
}

/* ---------- a sub-workspace's menu removes it (nav.js), with undo ---------- */
if (zone && R.ok('the sub-workspace\'s heading is there to right-click', !!(await rowRect(rowSel(`zone|${zone.id}`))), { space: await ev(`__flow.state().ws[0].at || null`), rows: (await rows()).map((r) => r.act).slice(-6) })) {
  const items = await rightClick(rowSel(`zone|${zone.id}`));
  /* rename and remove; "folder" when files.js sets a sub-workspace's own folder; "new sub-workspace" where spaces nest */
  const folderItem = await ev('!!(window.FlowFiles && window.FlowFiles.pickFolder)');
  const core = items.filter((x) => x !== 'new sub-workspace');
  if (R.ok('a sub-workspace\'s heading has rename and remove in its menu, and "folder" when files.js gives it one', JSON.stringify(core) === JSON.stringify(['rename', ...(folderItem ? ['folder'] : []), 'remove']), { items, folderItem })) {
    await menuPick('remove');
    const gone = !((await flowWs()).zones || []).some((z) => z.id === zone.id) && !(await rows()).some((r) => r.act === `zone|${zone.id}`);
    const t = await toastText();
    R.ok('remove takes it out of the workspace and the sidebar, with undo', gone && / · ?undo$|undo$/.test(t), { gone, t });
    const u = await rowRect('#toast button');
    if (u) { await click(page, u.cx, u.cy); await sleep(600); }
    R.ok('undo puts it back', ((await flowWs()).zones || []).some((z) => z.id === zone.id) && (await rows()).some((r) => r.act === `zone|${zone.id}`));
  } else await escape();
}

/* ---------- search still covers everything, saved pages too ---------- */
const savedNow = (await flowWs()).saved || [];
if (R.ok('the test state has saved pages to search for', savedNow.length > 0)) {
  const word = savedNow[0].title.split(/\s+/).find((w) => w.length > 5) || savedNow[0].title;
  await ev(`(() => { const q = document.getElementById('q'); q.focus(); q.value = ''; return true; })()`);
  await type(page, word.toLowerCase().replace(/[^a-z0-9 ]/g, ''));
  await sleep(500);
  const hits = await ev(`[...document.querySelectorAll('#sblist .tr')].map((e) => e.dataset.act)`);
  R.ok('⌘K search finds a saved page', hits.includes(`saved|${savedNow[0].id}`), { word, hits: hits.slice(0, 8) });
  await escape();
}

/* ⌘K from another workspace (browse's round 3): a section only when it has something under it, a path in plain words
   with no group name in it; and when nothing matches anywhere, one line says so */
const otherWs = await ev(`__flow.state().ws.findIndex((w) => w.id !== 'flow')`);
if (savedNow.length && R.ok('the test state has a second workspace', otherWs > 0)) {
  const word = savedNow[0].title.split(/\s+/).find((w) => w.length > 5) || savedNow[0].title;
  await ev(`(() => { __flow.go(${otherWs}); return true; })()`);
  await sleep(700);
  await ev(`(() => { const q = document.getElementById('q'); q.focus(); q.value = ''; return true; })()`);
  await type(page, word.toLowerCase().replace(/[^a-z0-9 ]/g, ''));
  await sleep(800);
  const view = await ev(`(() => { const kids = [...document.getElementById('sblist').children]; return { secs: kids.map((e, i) => (e.classList.contains('sec') ? { text: e.textContent, next: kids[i + 1] ? kids[i + 1].className : '' } : null)).filter(Boolean), empties: [...document.querySelectorAll('#sblist .empty')].map((e) => e.textContent), paths: [...document.querySelectorAll('#sblist .tr[data-act] .p')].map((e) => e.textContent) }; })()`);
  R.ok('⌘K from another workspace: every section has something under it, and none reads "nothing here"', view.secs.length > 0 && view.secs.every((x) => !!x.next && !/\bsec\b/.test(x.next)) && !view.empties.includes('nothing here'), view);
  R.ok('...and a result\'s path is in plain words, with no group name in it', view.paths.length > 0 && view.paths.every((x) => !/(^|› )(agents|notes|browser|files)( ›|$)/.test(x)), view.paths);
  await ev(`(() => { const q = document.getElementById('q'); q.value = ''; return true; })()`);
  await type(page, `zq${Date.now() % 100000}xv`);
  let none = [];
  for (let i = 0; i < 40; i++) {
    none = await ev(`[...document.getElementById('sblist').children].map((e) => e.className + ':' + e.textContent)`);
    if (none.length === 1 && none[0] === 'empty:nothing found') break;
    await sleep(250);
  }
  R.ok('⌘K with nothing matching anywhere shows one line, "nothing found", and no section', none.length === 1 && none[0] === 'empty:nothing found', none);
  await escape();
  await ev(`(() => { __flow.go(0); return true; })()`);
  await sleep(600);
}

/* ⌘K from the keyboard (flows; the lead, as in Spotlight): the first result is lit as you type, ↓ and ↑ move the light,
   Enter opens the lit one as a click would and ends the search, and Escape closes the search */
{
  const lit = () => ev(`[...document.querySelectorAll('#sblist .tr[data-act], #sblist .srow')].map((e) => ({ act: e.dataset.act || 'sess|' + e.dataset.sess, sel: e.classList.contains('sel') }))`);
  const typeQ = async (w) => { await ev(`(() => { const q = document.getElementById('q'); q.focus(); q.value = ''; return true; })()`); await type(page, w); await sleep(900); };
  await typeQ('human');
  const l0 = await lit();
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp']) { await key(page, k); await sleep(150); }
  const l1 = await lit();
  /* older sessions can still be arriving at the end of the list: the light is checked by which row it is on */
  const lit1 = l1.filter((x) => x.sel);
  R.ok('⌘K: the first result is lit as you type; ↓ ↓ ↑ lights the second, and only it', l0.length >= 3 && l0[0].sel === true && l0.filter((x) => x.sel).length === 1 && lit1.length === 1 && lit1[0].act === l0[1].act, { l0: l0.slice(0, 4), l1: l1.slice(0, 4), lengths: [l0.length, l1.length] });
  const pick = l1[1] ? l1[1].act : '';
  const want = await ev(`(() => { const [k, id] = ${JSON.stringify(pick)}.split('|'); const ws = __flow.state().ws[0];
    if (k === 'tab' || k === 'win') return { kind: k, wid: id };
    if (k === 'note') { const w = ws.windows.find((x) => x.noteId === id); return { kind: k, note: id, wid: w ? w.id : null }; }
    if (k === 'saved') { const sv = (ws.saved || []).find((x) => x.id === id); return { kind: k, url: sv ? sv.url : null }; }
    return { kind: k }; })()`);
  await key(page, 'Enter');
  await sleep(1200);
  const got = await ev(`(() => { const front = document.querySelector('.win.front'); const fid = front ? front.dataset.id : null; const ws = __flow.state().ws[0];
    const w = fid ? ws.windows.find((x) => x.id === fid) : null; const n = w && w.noteId ? ws.notes.find((x) => x.id === w.noteId) : null;
    const url = w && w.tabs && w.tabs[w.tab || 0] ? w.tabs[w.tab || 0].url : n && n.url ? n.url : null;
    return { front: fid, url, noteId: w ? w.noteId || null : null, q: document.getElementById('q').value }; })()`);
  const opened = want.kind === 'tab' || want.kind === 'win' ? got.front === want.wid : want.kind === 'note' ? got.noteId === want.note : want.kind === 'saved' ? !!got.url && !!want.url && got.url.replace(/\/$/, '') === want.url.replace(/\/$/, '') : false;
  R.ok('⌘K: Enter opens the lit result as a click would, and the search is over', opened === true && got.q === '', { pick, want, got });
  await typeQ('human');
  await key(page, 'Escape');
  await sleep(400);
  const esc = await ev(`({ q: document.getElementById('q').value, focused: document.activeElement === document.getElementById('q'), tree: !!document.querySelector('#sblist .tr.sph') })`);
  R.ok('⌘K: Escape closes the search: the box is empty and has no keys, and the list is back', esc.q === '' && esc.focused === false && esc.tree === true, esc);
}

R.ok('no console errors or exceptions', page.errors.length === 0, page.errors.slice(0, 5));
R.summary();
page.ws.close();




