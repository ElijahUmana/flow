// sidebar's walk of the owner's sidebar asks (OWNER_ASKS.md / ~/owner-record, Nov 1 18:44 to 19:19), each with real input
// on the dev app on 9574, made busy by test/sidebar-busy.mjs (a team with 13 panes, open pages, the seed's "research").
// Every check names the owner's words it answers.
//   node test/sidebar-owner.mjs
import { connectTo, evaluate, size, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';

const R = reporter();
const page = await connectTo(9574, /\/src\/index\.html$/);
await size(page, 1500, 913);
for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
await evaluate(page, 'window.__flow.ready');
const ev = (e) => evaluate(page, e);
const flowWs = () => ev(`__flow.state().ws.find((w) => w.id === 'flow')`);
const rows = () => ev(`(() => { let grp = '', space = ''; return [...document.querySelectorAll('#sblist .grp, #sblist .tr')].map((e) => {
  if (e.classList.contains('grp')) { grp = e.dataset.grp.split(':g:')[1]; return null; }
  if (e.classList.contains('sph')) { grp = 'space'; space = e.dataset.act; }
  if (!e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return null;
  const l = e.querySelector('.l'), m = e.querySelector('.m'), g = e.querySelector('.g');
  return { grp, space, depth: +((e.className.match(/\\bd(\\d)\\b/) || [0, 0])[1]), act: e.dataset.act, label: l ? l.textContent : '', meta: m ? m.textContent : '', dim: e.classList.contains('dim'), glyph: g ? g.textContent : '' };
}).filter(Boolean); })()`);
const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const rowSel = (act) => `#sblist .tr[data-act="${act}"]`;
async function clickAt(sel) { const r = await rect(sel); if (!r) throw new Error(`nothing at ${sel}`); await click(page, r.cx, r.cy); await sleep(450); }
const boxOf = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
/* A row click can pan to its window (a 0.45 s glide, app.css:80); a hand presses inside it once it has stopped. */
const still = () => ev(`!document.getAnimations().some((x) => x.playState === 'running' && x.effect && x.effect.getComputedTiming().endTime !== Infinity && x.effect.target && x.effect.target.closest && !x.effect.target.closest('#sb'))`);
async function settled(sel) {
  let a = await boxOf(sel);
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const b = await boxOf(sel);
    if (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (await still())) return b;
    a = b;
  }
  return a;
}
const said = (words) => `"${words}"`;
let data = null;
page.on((m) => { if (m.method === 'Input.dragIntercepted') data = m.params.data; });
/* An HTML5 drag the way a hand does it: press, move until the drag starts, then over the target and drop. */
async function drag(fromSel, toSel) {
  const a = await rect(fromSel);
  await page.send('Input.setInterceptDrags', { enabled: true });
  data = null;
  await mouse(page, 'mouseMoved', a.cx, a.cy);
  await mouse(page, 'mousePressed', a.cx, a.cy);
  for (let i = 1; i <= 10 && !data; i++) { await mouse(page, 'mouseMoved', a.cx, a.cy + 4 * i, { down: true }); await sleep(30); }
  for (let i = 0; i < 20 && !data; i++) await sleep(50);
  await sleep(150);
  const b = await rect(toSel);
  if (!data || !b) { await mouse(page, 'mouseReleased', a.cx, a.cy); await page.send('Input.setInterceptDrags', { enabled: false }); throw new Error(`drag ${fromSel} -> ${toSel} did not start or has no target`); }
  for (const t of ['dragEnter', 'dragOver']) await page.send('Input.dispatchDragEvent', { type: t, x: b.cx, y: b.cy, data });
  await page.send('Input.dispatchDragEvent', { type: 'drop', x: b.cx, y: b.cy, data });
  await mouse(page, 'mouseReleased', b.cx, b.cy);
  await page.send('Input.setInterceptDrags', { enabled: false });
  await sleep(500);
}
async function nameIt(name) {
  const was = await ev(`(() => { const el = document.activeElement; return el && el.classList.contains('rn') ? el.textContent : null; })()`);
  await key(page, 'a', 2); await type(page, name); await key(page, 'Enter'); await sleep(400);
  return was;
}

await ev('(() => { __flow.go(0); return true; })()');
await sleep(600);
await mouse(page, 'mouseMoved', 900, 500);
let rs = await rows();
const groups = await ev(`[...document.querySelectorAll('#sblist .grp')].map((g) => g.textContent)`);

/* 19:06 "we should have agents, we have-- we should have note, and then we should have, like, browser" ... "sub
   workspaces ... that should be like at the end of the list" */
const heads = rs.filter((r) => r.grp === 'space');
R.ok(`${said('we should have agents ... note ... browser')}: the groups read agents, notes, browser, and the sub-workspaces come last, a heading each`,
  groups[0] === 'agents' && groups[1] === 'notes' && groups[2] === 'browser' && !groups.includes('sub-workspaces') && heads.length >= 2 && heads[0].act === 'zone|'
  && heads.slice(1).every((h) => rs.filter((r) => r.space === 'zone|').every((r) => rs.indexOf(r) < rs.indexOf(h))), { groups, heads: heads.map((h) => h.label) });

/* 19:06 "under the notes section, it's showing both notes, and it's also showing apparently browser tabs" */
const inNotes = rs.filter((r) => r.grp === 'notes');
R.ok(`${said('under the notes section, it\'s showing both notes, and ... browser tabs')}: notes holds only notes and note sections`,
  inNotes.length > 0 && inNotes.every((r) => /^(note|folder)\|/.test(r.act)), inNotes.map((r) => r.label));

/* 19:06 "if i click on that same flow ... it's showing me all of this sub ... things that has been spawned for that
   agent ... why can't that even be like say collapsed" */
const team = rs.find((r) => r.grp === 'agents' && r.glyph === '▸');
R.ok(`${said('why can\'t that even be like say collapsed')}: a team is one row, folded, with how many it spawned`,
  !!team && /\d/.test(team.meta) && !rs.some((r) => r.act.startsWith(`mate|${team.act.split('|')[1]}|`)), team);
if (team) {
  await clickAt(`${rowSel(team.act)} .g[data-tog]`);
  const open = (await rows()).filter((r) => r.act.startsWith(`mate|${team.act.split('|')[1]}|`));
  await clickAt(`${rowSel(team.act)} .g[data-tog]`);
  const shut = (await rows()).filter((r) => r.act.startsWith(`mate|${team.act.split('|')[1]}|`));
  R.ok('...and opens on ▸ to show them, and folds again on ▾', open.length >= 2 && shut.length === 0, { open: open.length, shut: shut.length });
}

/* 19:06 "if i ... click on the sub workspaces ... while i'm in the ... major workspace... i should probably still be,
   like, able to see even the sub workspaces, you know, things like their notes, their agents ... if i should click on
   something there" */
const zone = rs.find((r) => r.grp === 'space' && r.act.startsWith('zone|') && r.act !== 'zone|');
if (R.ok(`${said('see even the sub workspaces ... their notes, their agents')}: from the main view a sub-workspace is listed`, !!zone, zone)) {
  if (zone.glyph === '▸') await clickAt(`${rowSel(zone.act)} .g[data-tog]`);
  rs = await rows();
  const kids = rs.filter((r) => r.space === zone.act && r.grp !== 'space');
  R.ok('...and unfolds, from the main view, to its own tools', kids.length >= 2, kids.map((r) => r.label));
  const note = kids.find((r) => r.act.startsWith('note|'));
  if (R.ok('the sub-workspace holds a note', !!note)) {
    await clickAt(rowSel(note.act));
    const nid = note.act.split('|')[1];
    const st = await ev(`(() => { const s = __flow.state().ws.find((w) => w.id === 'flow'); const w = s.windows.find((x) => x.noteId === ${JSON.stringify(nid)}); const el = w && document.querySelector('.win[data-id="' + w.id + '"]'); if (!el) return null; const b = el.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); return { at: s.at, zone: w.zone, front: el.classList.contains('front'), inView: b.left >= v.left - 2 && b.right <= v.right + 2 }; })()`);
    const word = `walk${Date.now() % 100000}`;
    await type(page, word);
    await sleep(400);
    const body = ((await flowWs()).notes.find((n) => n.id === nid) || {}).body || '';
    R.ok(`${said('if i should click on something there')}: clicking its note goes to that sub-workspace, the note in front and in view, ready to type`,
      !!st && st.at === st.zone && st.front && st.inView && body.includes(word), { ...st, typed: body.includes(word) });
  }
  /* Nov 2 14:46 "when i'm in the ... sub workspace why ... is there not ... way to go back to the main workspace without say
     ... swiping or something?! for every workspace shouldn't the first thing be like the 'main workspace' heading sort of
     thing? and i can say right click that and create new sub workspaces" */
  if ((await ev(`__flow.state().ws.find((w) => w.id === 'flow').at || null`)) === zone.act.slice(5)) {
    const first = (await rows())[0];
    await clickAt(`${rowSel('zone|')} .l`);
    await sleep(500);
    const back = await ev(`__flow.state().ws.find((w) => w.id === 'flow').at || null`);
    const marked = await ev(`(() => { const h = document.querySelector('#sblist .tr.sph.here'); return h ? h.dataset.act : null; })()`);
    const wsName = (await flowWs()).name;
    R.ok(`${said('the main workspace being like the "workspace name" before ... agents notes browser and files')}: in a sub-workspace, the list starts with the workspace's name, and a click on it goes back to its main space`,
      !!first && first.act === 'zone|' && first.label === wsName && back === null && marked === 'zone|', { first, wsName, back, marked });
    const r = await rect(`${rowSel('zone|')} .l`);
    await mouse(page, 'mouseMoved', r.cx, r.cy);
    await mouse(page, 'mousePressed', r.cx, r.cy, { button: 'right', buttons: 2 });
    await mouse(page, 'mouseReleased', r.cx, r.cy, { button: 'right', buttons: 2 });
    await sleep(300);
    const items = await ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.firstChild.textContent)`);
    await key(page, 'Escape');
    await sleep(200);
    R.ok(`${said('i can say right click that and create new sub workspaces')}: a right-click on it gives "new sub-workspace"`, items.includes('new sub-workspace'), items);
  } else R.ok('the walk is in the sub-workspace for the main workspace heading checks', false, await ev(`__flow.state().ws.find((w) => w.id === 'flow').at || null`));
}

/* 18:44 "where is the whole bookmark thing" / 19:06 "maybe there's no such thing as a bookmark per se ... section" /
   19:19 "we should maybe throw away the whole word bookmark" */
R.ok(`${said('throw away the whole word bookmark')}: nowhere in Flow's window does it say "bookmark"`, (await ev('document.body.innerText.length')) > 0 && !(await ev(`/bookmark/i.test(document.body.innerText)`)));

/* 19:06 "if something's already saved, why are we still showing it as ... currently open ... maybe it should still show
   like to have a way of telling that that one is currently open": save an open page with its star */
await ev('(() => { __flow.go(0); return true; })()');
const agent = (await rows()).find((r) => r.grp === 'agents' && r.act.startsWith('win|'));
if (agent) await clickAt(rowSel(agent.act));
rs = await rows();
const tab = rs.find((r) => r.grp === 'browser' && r.depth === 0 && r.act.startsWith('tab|') && !/^new page$/.test(r.label));
if (R.ok('the walk has an open page in browser to save', !!tab, rs.filter((r) => r.grp === 'browser').map((r) => r.label))) {
  const wid = tab.act.split('|')[1];
  await clickAt(rowSel(tab.act));
  await settled(`.win[data-id="${wid}"]`);
  const star = await boxOf(`.win[data-id="${wid}"] .pstar, .win[data-id="${wid}"] [title="save this page"]`);
  if (star) await click(page, star.cx, star.cy);
  const url = await ev(`(() => { const w = __flow.state().ws.find((x) => x.id === 'flow').windows.find((x) => x.id === ${JSON.stringify(wid)}); return w && w.tabs ? w.tabs[w.tab || 0].url : ''; })()`);
  /* under load the save reaches the sidebar later: wait for its row, up to about 4.5 s */
  let sv = null, srow = null;
  for (let i = 0; i < 30 && !srow; i++) {
    await sleep(150);
    rs = await rows();
    sv = ((await flowWs()).saved || []).find((s) => s.url === url);
    srow = sv && rs.find((r) => r.act === `saved|${sv.id}`);
  }
  R.ok(`${said('if something\'s already saved, why are we still showing it as ... currently open')}: saved with its star, the page shows once, in its section`,
    !!srow && srow.depth === 1 && !rs.some((r) => r.act === tab.act), { star: !!star, saved: !!sv, row: srow });
  R.ok(`${said('a way of telling that that one is currently open')}: bright while open`, !!srow && !srow.dim, srow);
  const red = await rect(`.win[data-id="${wid}"] [data-l=close]`);
  if (red) { await click(page, red.cx, red.cy); await sleep(700); }
  const after = sv && (await rows()).find((r) => r.act === `saved|${sv.id}`);
  R.ok('...and dim once it is closed, still in its section', !!after && after.dim && after.depth === 1, after);
}

/* 19:19 "click something and it creates a new ..." */
await mouse(page, 'mouseMoved', 900, 500);
await sleep(200);
const quiet = await ev(`[...document.querySelectorAll('#sblist .gadd')].filter((e) => getComputedStyle(e).visibility === 'visible').length`);
const gh = await rect('#sblist .grp[data-grp="flow:g:browser"]');
await mouse(page, 'mouseMoved', gh.cx, gh.cy);
await sleep(250);
const plus = await rect('#sblist .grp[data-grp="flow:g:browser"] .gadd');
const plusOn = await ev(`getComputedStyle(document.querySelector('#sblist .grp[data-grp="flow:g:browser"] .gadd')).visibility === 'visible'`);
if (plus) { await click(page, plus.cx, plus.cy); await sleep(450); }
const was = await nameIt('owner walk');
const sec = ((await flowWs()).notes || []).find((n) => n.kind === 'folder' && n.title === 'owner walk');
R.ok(`${said('click something and it creates a new')}: nothing at rest; over browser a "+" shows; one click makes a section, named in place`,
  quiet === 0 && plusOn && /^new section/.test(was || '') && !!sec, { quiet, plusOn, was, sec: !!sec });

/* 19:19 "drag a different page and it goes to like a, um, new ..." */
const tabs = await ev(`[...document.querySelectorAll('#sblist .tr[data-act^="tab|"]')].filter((e) => e.getClientRects().length && e.dataset.g === 'browser').map((e) => e.dataset.act)`);
if (R.ok('the walk has another open page to drag', tabs.length > 0, tabs)) {
  const before = ((await flowWs()).notes || []).filter((n) => n.kind === 'folder').length;
  await drag(rowSel(tabs[0]), '#sblist .grp[data-grp="flow:g:browser"]');
  const w2 = await nameIt('dragged');
  const st = await flowWs();
  const sec2 = (st.notes || []).find((n) => n.kind === 'folder' && n.title === 'dragged');
  const inIt = sec2 && (st.saved || []).some((s) => s.section === sec2.id);
  R.ok(`${said('drag a different page and it goes to like a ... new')} section: dropped on browser's heading, it makes one with the page inside, named in place`,
    /^new section/.test(w2 || '') && !!sec2 && inIt && (st.notes || []).filter((n) => n.kind === 'folder').length === before + 1, { w2, inIt });
}

/* 19:19 "also for the notice wall ... thinking about that carefully as well" (notes organize the same way) */
const nr = (await rows()).find((r) => r.grp === 'notes' && r.depth === 0 && r.act.startsWith('note|'));
if (R.ok('the walk has a note in notes', !!nr)) {
  await drag(rowSel(nr.act), '#sblist .grp[data-grp="flow:g:notes"]');
  const w3 = await nameIt('walk notes');
  const st = await flowWs();
  const f = (st.notes || []).find((n) => n.kind === 'folder' && n.title === 'walk notes');
  const n = (st.notes || []).find((x) => x.id === nr.act.split('|')[1]);
  R.ok(`${said('also for the notes ... as well')}: a note dropped on notes' heading makes a note section with it inside`, /^new section/.test(w3 || '') && !!f && n.parent === f.id, { w3, parent: n && n.parent });
}

/* Nov 2 12:49 and 14:03 "if i just say create a new page, that's not the new tab" / "i never told you every thing should
   be opening up as new tab in already existing browser page": with the keys outside a page, a new page is its own
   window (item 1) */
const pageWin = (await ev('__flow.windows()')).find((w) => w.type === 'page' && w.ws === 'flow' && w.visible);
if (R.ok('the walk has a page window on screen', !!pageWin)) {
  const pages = async () => (await ev('__flow.windows()')).filter((w) => w.type === 'page').length;
  const tabsOf = async () => ((await flowWs()).windows.find((w) => w.id === pageWin.id).tabs || []).length;
  /* "new page" with the keys elsewhere: its own window, and the page in front gets no tab */
  const tb = await settled(`.win[data-id="${pageWin.id}"] .tb .title`);
  if (tb) { await click(page, tb.cx, tb.cy); await sleep(450); }
  await mouse(page, 'mouseMoved', 900, 500);
  const outside = await ev(`(() => { const a = document.activeElement; return !(a && a.closest && a.closest('.win[data-id="${pageWin.id}"]')); })()`);
  const n0 = await pages();
  const t0 = await tabsOf();
  await ev(`__flow.menu('new-page')`);
  let n1 = n0;
  for (let i = 0; i < 30 && (n1 = await pages()) === n0; i++) await sleep(150);
  const t1 = await tabsOf();
  R.ok(`${said('if i just say create a new page, that\'s not the new tab')}: with the keys outside a page, a new page is its own page window, and the page in front gets no tab`, outside === true && n1 === n0 + 1 && t1 === t0, { outside, tabs: [t0, t1], windows: [n0, n1] });
}

/* 19:06 "close it for something like browser ... on the sidebar" (lead's call, item 48): an open page's × closes it,
   saved or not; a saved one stays in its section, dim, and its × then removes it from saved, with undo */
{
  await ev('(() => { __flow.go(0); return true; })()');
  const st = await flowWs();
  const sv = (st.saved || [])[0];
  if (R.ok('the walk has a saved page', !!sv)) {
    let row = (await rows()).find((r) => r.act === `saved|${sv.id}`);
    if (row && row.dim) {
      await clickAt(rowSel(row.act));
      for (let i = 0; i < 30 && (row = (await rows()).find((r) => r.act === `saved|${sv.id}`)) && row.dim; i++) await sleep(150);
    }
    const x1 = await ev(`(() => { const r = document.querySelector('#sblist .tr[data-act="saved|${sv.id}"]'); return r ? [...r.querySelectorAll('.x')].map((x) => Object.keys(x.dataset).join('')) : null; })()`);
    await clickAt(`${rowSel(`saved|${sv.id}`)} [data-close]`);
    /* closing one tab of several first asks the page whether it may go (page.js), which takes about a second */
    let after = null;
    for (let i = 0; i < 30 && !((after = (await rows()).find((r) => r.act === `saved|${sv.id}`)) && after.dim); i++) await sleep(150);
    const open = (await ev('__flow.windows()')).some((w) => w.type === 'page' && String(w.url || '').replace(/\/+$/, '') === sv.url.replace(/\/+$/, ''));
    R.ok(`${said('close it for something like browser ... on the sidebar')}: an open saved page's × closes it; it stays in its section, dim`,
      !!row && !row.dim && JSON.stringify(x1) === '["close"]' && !!after && after.dim && after.depth === 1, { x: x1, after, open });
    await clickAt(`${rowSel(`saved|${sv.id}`)} [data-unsave]`);
    const gone = !((await flowWs()).saved || []).some((s) => s.id === sv.id);
    let undo = null;
    for (let i = 0; i < 20 && !(undo = await rect('#toast.on button')); i++) await sleep(100);
    if (undo) { await click(page, undo.cx, undo.cy); await sleep(500); }
    const back = ((await flowWs()).saved || []).some((s) => s.id === sv.id);
    R.ok('...and then its × removes it from saved, with undo', gone && !!undo && back, { gone, undo: !!undo, back });
  }
}

/* 19:19 "drag a different page and it goes to like a, um, new" section, with the page window itself (item 47): dragged
   by its title bar onto a section or the browser heading it is filed there, the window back where it was; a note window
   the same way on the notes heading */
async function dragBar(barSel, toSel) {
  /* the row's click before it can pan the view to the window: press once nothing moves */
  let a = await settled(barSel);
  const b = await rect(toSel);
  if (!a || !b) return null;
  /* the press must land on that window's own title bar, not on a window in front of it; one more look once the view has
     settled, and what is there instead when it still is not */
  const at = (x, y) => ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); const bar = document.querySelector(${JSON.stringify(barSel)}); const on = !!e && !!bar && (bar.contains(e) || e.contains(bar) || bar.closest('.tb').contains(e)); const w = e && e.closest && e.closest('.win'); return { on, hit: e ? (typeof e.className === 'string' ? e.className : e.tagName) : null, win: w ? w.dataset.id : null }; })()`);
  let hit = await at(a.x + 30, a.cy);
  if (!hit.on) { await sleep(800); a = await settled(barSel); hit = await at(a.x + 30, a.cy); }
  if (!hit.on) return { lit: [], says: [], notOnBar: true, hit, bar: { x: Math.round(a.x), y: Math.round(a.y) } };
  const x0 = a.x + 30;
  await mouse(page, 'mouseMoved', x0, a.cy);
  await mouse(page, 'mousePressed', x0, a.cy);
  for (let i = 1; i <= 20; i++) { await mouse(page, 'mouseMoved', x0 + ((b.cx - x0) * i) / 20, a.cy + ((b.cy - a.cy) * i) / 20, { down: true }); await sleep(25); }
  await sleep(200);
  const lit = await ev(`({ lit: [...document.querySelectorAll('#sblist .drop')].map((e) => e.dataset.act || e.dataset.grp), says: [...document.querySelectorAll('#sblist .grp')].map((g) => { const a = g.querySelector('.gadd'); return a && getComputedStyle(a).visibility === 'visible' ? getComputedStyle(a, '::before').content.replace(/^"|"$/g, '') : ''; }) })`);
  await mouse(page, 'mouseReleased', b.cx, b.cy);
  await sleep(600);
  return lit;
}
{
  /* in the main space, a page window that shows a page (not a blank new tab), and a note window */
  const mainAgent = (await rows()).find((r) => r.grp === 'agents' && r.depth === 0 && r.act.startsWith('win|'));
  if (mainAgent) await clickAt(rowSel(mainAgent.act));
  const st = await flowWs();
  const pw = st.windows.find((w) => w.type === 'page' && !w.zone && w.tabs && w.tabs[w.tab || 0] && /^https?:/.test(w.tabs[w.tab || 0].url));
  const sec = (st.notes || []).find((n) => n.kind === 'folder' && n.holds === 'page');
  if (R.ok('the walk has a page window on screen and a browser section', !!pw && !!sec, { pw: pw && pw.id, sec: sec && sec.title })) {
    /* bring it to the front first, as a hand would, through its own row */
    const shownUrl = pw.tabs[pw.tab || 0].url;
    const svp = (st.saved || []).find((x) => x.url === shownUrl);
    const prow = (await rows()).find((r) => r.act === `tab|${pw.id}|${pw.tab || 0}` || (svp && r.act === `saved|${svp.id}`));
    if (prow) await clickAt(rowSel(prow.act));
    const w0 = st.windows.find((w) => w.id === pw.id);
    const url = w0.tabs ? w0.tabs[w0.tab || 0].url : '';
    const lit = await dragBar(`.win[data-id="${pw.id}"] .tb .title`, rowSel(`sec|${sec.id}`));
    const st2 = await flowWs();
    const sv = (st2.saved || []).find((s) => s.url === url);
    const w1 = st2.windows.find((w) => w.id === pw.id);
    R.ok(`${said('drag a different page and it goes to')} a section: the page window dragged by its title bar onto "${sec.title}" lights it up and saves it there; the window goes back`,
      !!lit && lit.lit.includes(`sec|${sec.id}`) && !!sv && sv.section === sec.id && !!w1 && Math.abs(w1.x - w0.x) < 0.01 && Math.abs(w1.y - w0.y) < 0.01, { lit, saved: sv && sv.section, moved: w1 && [w1.x - w0.x, w1.y - w0.y] });
    const before = (st2.notes || []).filter((n) => n.kind === 'folder').length;
    const lit2 = await dragBar(`.win[data-id="${pw.id}"] .tb .title`, '#sblist .grp[data-grp="flow:g:browser"]');
    const w2 = await nameIt('dragged window');
    const st3 = await flowWs();
    const sec3 = (st3.notes || []).find((n) => n.kind === 'folder' && n.title === 'dragged window');
    R.ok('...and onto the browser heading, which reads "+ new section", it makes a section with that page inside, named in place',
      !!lit2 && lit2.says[groups.indexOf('browser')] === '+ new section' && /^new section/.test(w2 || '') && !!sec3 && (st3.saved || []).some((s) => s.url === url && s.section === sec3.id) && (st3.notes || []).filter((n) => n.kind === 'folder').length === before + 1, { lit2, w2 });
  }
  const nw = (await flowWs()).windows.find((w) => w.type === 'note' && !w.zone);
  if (R.ok('the walk has a note window on screen', !!nw)) {
    const nrow = (await rows()).find((r) => r.act === `note|${nw.noteId}`);
    if (nrow) await clickAt(rowSel(nrow.act));
    const lit = await dragBar(`.win[data-id="${nw.id}"] .tb .title`, '#sblist .grp[data-grp="flow:g:notes"]');
    const w3 = await nameIt('dragged note');
    const st4 = await flowWs();
    const f = (st4.notes || []).find((n) => n.kind === 'folder' && n.title === 'dragged note');
    const n = (st4.notes || []).find((x) => x.id === nw.noteId);
    R.ok('a note window dragged by its title bar onto the notes heading makes a note section with that note inside', !!lit && /^new section/.test(w3 || '') && !!f && !!n && n.parent === f.id, { lit, w3, parent: n && n.parent });
  }
}

R.ok('no console errors or exceptions', page.errors.length === 0, page.errors.slice(0, 4));
R.summary();
page.ws.close();




