// ux's check of plan item 10 (owner, 14:33: "why cant i say close/collapse the showing of sub workspaces for other
// workspaces without navigating to that workspace"), with real input over CDP. Another workspace's pill that sits in a
// sub-workspace reads "name › sub". Pointing at "› sub" turns the › into an ×, and clicking it sends that workspace
// back to its main space while you stay where you are. The pill on screen has no ×. A double-click on the × goes
// nowhere and starts no rename.   test/ux-dev.sh stop; test/ux-dev.sh start --fresh && node test/ux-subx.mjs
import { connectTo, evaluate, size, sleep, mouse, click, reporter } from './ui-lib.mjs';

const R = reporter();
const app = await connectTo(9567, /\/src\/index\.html$/);
for (let i = 0; i < 120 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
await size(app, 1500, 913);
await sleep(1500);
const rect = (sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const state = () => evaluate(app, `(() => { const s = __flow.state(); return { at: s.ui.at, flow: s.ws.find((w) => w.id === 'flow').at || null }; })()`);
const iOf = (id) => evaluate(app, `__flow.state().ws.findIndex((w) => w.id === ${JSON.stringify(id)})`);
const strip = () => evaluate(app, `Math.round(new DOMMatrixReadOnly(getComputedStyle(document.getElementById('track')).transform).m41)`);
async function pill(id) { const b = await rect(`.sp[data-i="${await iOf(id)}"] .sn`); await click(app, b.cx, b.cy); await sleep(900); }
/* flow, on screen, into its sub-workspace research: its row in the sidebar, as a hand does */
async function research() {
  const r = await rect('.tr[data-act="zone|z-research"]');
  if (r) { await click(app, r.x + 40, r.cy); await sleep(900); }
  return (await state()).flow === 'z-research';
}
/* the › of flow's "› research": the × when the build has one, else where the › is drawn */
async function chevron() {
  const fi = await iOf('flow');
  const g = await rect(`.sp[data-i="${fi}"] [data-szx]`), sz = await rect(`.sp[data-i="${fi}"] .sz`);
  return g ? { x: g.cx, y: g.cy, own: true } : sz ? { x: sz.x + 3, y: sz.cy, own: false } : null;
}
const look = () => evaluate(app, `(() => { const i = __flow.state().ws.findIndex((w) => w.id === 'flow'), p = document.querySelector('.sp[data-i="' + i + '"]'), g = p && p.querySelector('[data-szx]');
  return { text: p ? p.querySelector('.sn').textContent + (p.querySelector('.sz') ? ' ' + p.querySelector('.sz').textContent : '') : null, x: g ? getComputedStyle(g, '::after').content : null, glyph: g ? getComputedStyle(g).color : null }; })()`);

if ((await state()).at !== 'flow') await pill('flow');
R.ok('flow on screen goes into research from its sidebar row', await research(), await state());
R.ok('the pill on screen reads "flow › research" and has no ×', !(await rect(`.sp[data-i="${await iOf('flow')}"] [data-szx]`)) && (await look()).text === 'flow › research', await look());
await pill('mynotes');
R.ok('on mynotes, flow stays in research and its pill reads "flow › research"', (await state()).at === 'mynotes' && (await state()).flow === 'z-research' && (await look()).text === 'flow › research', { state: await state(), look: await look() });
await mouse(app, 'mouseMoved', 700, 450);
await sleep(300);
const rest = await look();
R.ok('at rest it shows the ›, no ×', rest.x === 'none' || rest.x === null, rest);
const c = await chevron();
await mouse(app, 'mouseMoved', c.x, c.y);
await sleep(300);
const over = await look();
R.ok('pointing at "› research" turns the › into an ×', c.own && over.x === '"×"' && over.glyph === 'rgba(0, 0, 0, 0)', over);
const s0 = await strip();
await click(app, c.x, c.y);
await sleep(900);
const after = await state();
R.ok('clicking the × sends flow back to its main space, and you stay on mynotes where you were', after.at === 'mynotes' && after.flow === null && (await strip()) === s0 && (await look()).text === 'flow', { after, look: await look(), strip: [s0, await strip()] });
// again, with a double-click on the ×
await pill('flow');
await research();
await pill('mynotes');
const c2 = await chevron();
await mouse(app, 'mouseMoved', c2.x, c2.y);
await sleep(300);
const s1 = await strip();
await mouse(app, 'mousePressed', c2.x, c2.y, { clickCount: 1 });
await mouse(app, 'mouseReleased', c2.x, c2.y, { clickCount: 1 });
await sleep(90);
await mouse(app, 'mousePressed', c2.x, c2.y, { clickCount: 2 });
await mouse(app, 'mouseReleased', c2.x, c2.y, { clickCount: 2 });
await sleep(900);
const after2 = await state(), editing = await evaluate(app, `!!document.querySelector('#spaces [contenteditable="true"], .spaces [contenteditable="true"]')`);
R.ok('a double-click on the × sends flow back too, goes nowhere and starts no rename', after2.at === 'mynotes' && after2.flow === null && (await strip()) === s1 && !editing, { after2, editing, strip: [s1, await strip()] });
R.ok('no console errors or exceptions', !app.errors.length, app.errors.slice(0, 5));
R.summary();
process.exit();




