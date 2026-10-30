// sidebar's check of sections per space, batch 9 (owner 14:54, sub-workspaces organized like main, sections included), real input on the dev app made
// busy by test/sidebar-busy.mjs: research's browser heading makes a section in research; the star in a research page
// saves into research's section; a main saved page moved to research from its menu is filed there; a section moves
// between spaces from its menu; removing research shows its section under the workspace, and undo puts it back.
// Needs the dev app on 9574 (test/sidebar-dev.sh start --fresh) made busy by test/sidebar-busy.mjs, and notes.js with a
// section's space (newSection's zone, moveSection).
//   node test/sidebar-sections.mjs
import { connectTo, evaluate, size, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';

const R = reporter();
const p = await connectTo(9574, /\/src\/index\.html$/);
await size(p, 1500, 913);
await evaluate(p, 'window.__flow.ready');
const ev = (x) => evaluate(p, x);
const still = () => ev(`!document.getAnimations().some((x) => x.playState === 'running' && x.effect && x.effect.getComputedTiming().endTime !== Infinity && x.effect.target && x.effect.target.closest && !x.effect.target.closest('#sb'))`);
const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + Math.min(40, b.width / 2), cy: b.top + b.height / 2 }; })()`);
async function settled(sel) { let a = await rect(sel); for (let i = 0; i < 30; i++) { await sleep(100); const b = await rect(sel); if (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (await still())) return b; a = b; } return a; }
const press = async (sel, wait = 700) => { const r = await rect(sel); if (!r) return false; await click(p, r.cx, r.cy); await sleep(wait); return true; };
const right = async (sel) => { const r = await rect(sel); if (!r) return []; await mouse(p, 'mouseMoved', r.cx, r.cy); await mouse(p, 'mousePressed', r.cx, r.cy, { button: 'right', buttons: 2 }); await mouse(p, 'mouseReleased', r.cx, r.cy, { button: 'right', buttons: 2 }); await sleep(350); return ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.firstChild.textContent)`); };
const pick = async (label) => { const i = await ev(`[...document.querySelectorAll('.ctx button')].findIndex((b) => b.firstChild.textContent === ${JSON.stringify(label)})`); if (i < 0) { await key(p, 'Escape'); return false; } await press(`.ctx button[data-i="${i}"]`, 700); return true; };
/* which heading a row is listed under */
const under = (act) => ev(`(() => { let head = null; for (const e of document.querySelectorAll('#sblist > *')) { if (e.classList.contains('sph')) head = e.dataset.act; if (e.dataset && e.dataset.act === ${JSON.stringify(act)}) return head; } return null; })()`);
const wsState = () => ev(`(() => { const ws = window.__flow.state().ws[0]; return { at: ws.at || null, secs: ws.notes.filter((n) => n.kind === 'folder').map((n) => ({ id: n.id, title: n.title, holds: n.holds, zone: n.zone || null })), saved: (ws.saved || []).map((s) => ({ id: s.id, url: s.url, section: s.section })) }; })()`);
await mouse(p, 'mouseMoved', 900, 500);
await ev(`(() => { window.__flow.go(0); return true; })()`);
await sleep(600);
const Z = 'z-research';

/* 1. research's browser heading: its "+" makes a section there, named in place */
await press(`#sblist .tr.sph[data-act="zone|${Z}"] .l`, 900);
const gsel = `#sblist .grp[data-grp="flow:g:${Z}:browser"]`;
const gh = await rect(gsel);
if (gh) await mouse(p, 'mouseMoved', gh.x + 20, gh.cy);
/* a pointer's move reaches the page at its next frame, later under load */
let plusOn = false;
for (let i = 0; i < 15 && !plusOn; i++) { await sleep(200); plusOn = await ev(`(() => { const a = document.querySelector(${JSON.stringify(gsel + ' .gadd')}); return !!a && getComputedStyle(a).visibility === 'visible'; })()`); }
await press(`${gsel} .gadd`, 300);
/* its name is typed once the new row's name has the keys, later under load */
let naming = false;
for (let i = 0; i < 25 && !naming; i++) { naming = await ev(`(() => { const a = document.activeElement; return !!a && a.classList.contains('rn') && !!a.closest('#sblist'); })()`); if (!naming) await sleep(200); }
await key(p, 'a', 2);
await type(p, 'papers');
await key(p, 'Enter');
await sleep(600);
let st = await wsState();
const papers = st.secs.find((f) => f.title === 'papers');
R.ok('in research, its browser heading\'s "+" makes a section of research, named in place, listed under research', plusOn === true && !!papers && papers.zone === Z && papers.holds === 'page' && (await under(`sec|${papers.id}`)) === `zone|${Z}`, { plusOn, naming, secs: papers ? undefined : st.secs, papers, under: papers && (await under(`sec|${papers.id}`)) });

/* 2. the star in a research page saves it into research's section */
const pw = await ev(`(() => { const ws = window.__flow.state().ws[0]; const saved = new Set((ws.saved || []).map((s) => s.url.replace(/\\/$/, ''))); const w = ws.windows.find((x) => x.type === 'page' && x.zone === ${JSON.stringify(Z)} && x.tabs && x.tabs[x.tab || 0] && !saved.has(x.tabs[x.tab || 0].url.replace(/\\/$/, ''))); return w ? { id: w.id, url: w.tabs[w.tab || 0].url } : null; })()`);
let starred = null;
if (pw) {
  await press(`#sblist .tr[data-act="tab|${pw.id}|0"] .l`, 600);
  /* the page loaded and its star ready, then one click; what is saved can take a moment to show */
  for (let i = 0; i < 40 && !(await ev(`(() => { const b = document.querySelector('.win[data-id="${pw.id}"] .pstar'); return !!b && !b.disabled && b.getClientRects().length > 0; })()`)); i++) await sleep(250);
  const star = await settled(`.win[data-id="${pw.id}"] .pstar`);
  if (star) await click(p, star.x + star.w / 2, star.y + star.h / 2);
  for (let i = 0; i < 20 && !starred; i++) {
    await sleep(200);
    st = await wsState();
    starred = st.saved.find((s) => s.url.replace(/\/$/, '') === pw.url.replace(/\/$/, ''));
  }
  if (!starred) starred = { none: true, star: await ev(`(() => { const b = document.querySelector('.win[data-id="${pw.id}"] .pstar'); if (!b) return null; const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { text: b.textContent, cls: b.className, disabled: !!b.disabled, hit: e === b || b.contains(e) }; })()`) };
}
R.ok('the star in a research page saves it into research\'s section, listed under research', !!pw && !!starred && !starred.none && !!papers && starred.section === papers.id && (await under(`saved|${starred.id}`)) === `zone|${Z}`, { pw, starred, papers: papers && papers.id });

/* 3. a main saved page moved to research from its menu: filed in research's section */
st = await wsState();
const mainSaved = st.saved.find((s) => { const f = st.secs.find((x) => x.id === s.section); return f && !f.zone; });
let items = [];
if (mainSaved) { items = await right(`#sblist .tr[data-act="saved|${mainSaved.id}"] .l`); await pick('move to research'); }
let moved = null;
for (let i = 0; i < 15; i++) {
  st = await wsState();
  moved = mainSaved && st.saved.find((s) => s.id === mainSaved.id);
  if (moved && papers && moved.section === papers.id) break;
  await sleep(200);
}
R.ok('a main saved page moved to research from its menu is filed in research\'s section, listed under research', !!moved && !!papers && moved.section === papers.id && (await under(`saved|${moved.id}`)) === `zone|${Z}`, { items, moved });

/* 4. a section moves between spaces from its menu (5: and research removed); both need research's section from 1 */
if (!papers) { R.ok('a section moves to the workspace\'s main space and back from its menu, with its pages', false, 'no section was made in research'); R.ok('research removed: its section shows under the workspace; undo puts it back under research', false, 'no section was made in research'); }
else {
const m1 = await right(`#sblist .tr[data-act="sec|${papers.id}"] .l`);
await pick('move to the main workspace');
st = await wsState();
const inMain = st.secs.find((f) => f.id === papers.id);
const u1 = await under(`sec|${papers.id}`);
const m2 = await right(`#sblist .tr[data-act="sec|${papers.id}"] .l`);
await pick('move to research');
st = await wsState();
R.ok('a section moves to the workspace\'s main space and back from its menu, with its pages', m1.includes('move to the main workspace') && !!inMain && !inMain.zone && u1 === 'zone|' && m2.includes('move to research') && st.secs.find((f) => f.id === papers.id).zone === Z && (await under(`sec|${papers.id}`)) === `zone|${Z}`, { m1, m2, u1 });

/* 5. research removed: its section shows under the workspace; undo puts it back */
await press('#sblist .tr.sph[data-act="zone|"] .l', 900);
await right(`#sblist .tr.sph[data-act="zone|${Z}"] .l`);
await pick('remove');
await sleep(400);
const u2 = await under(`sec|${papers.id}`);
const undo = await rect('#toast.on button');
if (undo) { await click(p, undo.cx, undo.cy); await sleep(900); }
await press(`#sblist .tr.sph[data-act="zone|${Z}"] .g[data-tog]`, 500);
const u3 = await under(`sec|${papers.id}`);
R.ok('research removed: its section shows under the workspace; undo puts it back under research', u2 === 'zone|' && !!undo && u3 === `zone|${Z}`, { u2, undo: !!undo, u3 });
}
/* 6. a sub-workspace's own folder (files.js): its heading's right-click has "folder", with the folder in use as its hint
   (its own, else the workspace's); the workspace's heading has none. The Mac's picker it opens is a native dialog, not
   driven here; files-cdp checks the folder set by it. */
const menuWithHints = () => ev(`[...document.querySelectorAll('.ctx button')].map((b) => ({ label: b.firstChild.textContent, hint: (b.querySelector('.k') || {}).textContent || '' }))`);
await right(`#sblist .tr.sph[data-act="zone|${Z}"] .l`);
const zm = await menuWithHints();
await key(p, 'Escape');
await sleep(300);
await right('#sblist .tr.sph[data-act="zone|"] .l');
const mm = await menuWithHints();
await key(p, 'Escape');
await sleep(300);
const want = await ev(`(() => { const ws = window.__flow.state().ws[0]; return window.FlowFiles && window.FlowFiles.folderOf ? window.FlowFiles.folderOf(ws, ${JSON.stringify(Z)}) : null; })()`);
const fo = zm.find((x) => x.label === 'folder');
R.ok('a sub-workspace\'s heading has "folder" with the folder in use as its hint; the workspace\'s heading has none', !!fo && !!want && fo.hint === want && !mm.some((x) => x.label === 'folder'), { zm, mm, want });
R.ok('no console errors', p.errors.length === 0, p.errors.slice(0, 3));
R.summary();
p.ws.close();




