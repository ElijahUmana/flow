// zoom's check that a pop-out keeps its own view across a quit (principle 5: come back exactly where you left), and that
// the main window's view stays its own. Real input over CDP in both windows (ctrl-wheel for the pinch, a drag for the
// pan, the sidebar's and the pill's own pop-out buttons). Runs zoom's isolated app (test/zoom-lib.mjs) on the safe seed.
//   node test/zoom-popout.mjs [--only zone,zone-left,zone-here,workspace]
import fs from 'node:fs';
import path from 'node:path';
import * as L from './zoom-lib.mjs';

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const SW = [8, 18, 30, 42, 46, 40, 34, 28, 22, 18, 14, 11, 9, 7, 5, 4, 3, 2, 2, 1];
let oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const same = (a, b) => !!a && !!b && near(a.x, b.x, 0.5) && near(a.y, b.y, 0.5) && near(a.z, b.z, 0.0005);

async function connect(re, what) {
  const t = await L.waitFor(async () => (await L.targets()).find((x) => x.type === 'page' && re.test(x.url)), 40000, what);
  const c = await L.Cdp.connect(t.webSocketDebuggerUrl);
  c.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') c.errors.push(`exception: ${m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) c.errors.push(`console.${m.params.type}: ${m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ')}`);
  });
  await c.send('Runtime.enable');
  await L.waitFor(() => c.eval('!!(window.__flow && window.__flow.ready)'), 40000, `${what} ready`);
  await c.eval('window.__flow.ready.then(() => true)');
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.eval(`(() => { window.__q = 0; for (const t of ['wheel', 'pointermove', 'pointerdown', 'pointerup']) window.addEventListener(t, () => { window.__q = performance.now(); }, { capture: true, passive: true }); return true; })()`);
  return c;
}
const MAIN = /\/src\/index\.html$/, POP = /\/src\/index\.html#solo=/;
/* What a window shows: its workspace, the space on screen and that space's view as drawn (pan in px at zoom 1). */
const shown = (c) => c.eval(`(() => { const solo = new URLSearchParams(location.hash.slice(1)).get('solo'), id = solo || __flow.state().ui.at;
  const cv = document.querySelector('.ws[data-id="' + id + '"] .canvas'), m = new DOMMatrixReadOnly(getComputedStyle(cv).transform);
  return { ws: id, x: +(-m.m41 / m.a).toFixed(2), y: +(-m.m42 / m.a).toFixed(2), z: +m.a.toFixed(4) }; })()`);
/* What a window shows of its space on screen, in any window size: each window's place as shares of the viewport. */
const seen = (c) => c.eval(`(() => { const solo = new URLSearchParams(location.hash.slice(1)).get('solo'), id = solo || __flow.state().ui.at;
  const cv = document.querySelector('.ws[data-id="' + id + '"] .canvas'), v = document.getElementById('viewport').getBoundingClientRect(), r3 = (n) => +n.toFixed(3);
  const wins = [...cv.querySelectorAll(':scope > .win')].filter((e) => e.style.display !== 'none').map((e) => { const b = e.getBoundingClientRect();
    return [e.dataset.id, [r3((b.left - v.left) / v.width), r3((b.top - v.top) / v.height), r3(b.width / v.width), r3(b.height / v.height)]]; });
  return { vw: Math.round(v.width), vh: Math.round(v.height), wins: Object.fromEntries(wins) }; })()`);
const sameSight = (a, b) => Object.keys(a.wins).length > 0 && Object.keys(a.wins).sort().join() === Object.keys(b.wins).sort().join()
  && Object.keys(a.wins).every((id) => a.wins[id].every((n, i) => near(n, b.wins[id][i], 0.005)));
/* The main window's own view of a workspace, from its model (also for a space shown "in another window"). */
/* Pans in px at zoom 1: kept in % of the view once ws.panUnit is '%' (item 44), converted with the view's size as nav does. */
const mainView = (c, wsId) => c.eval(`(() => { const ws = __flow.state().ws.find((w) => w.id === ${JSON.stringify(wsId)}), r = document.getElementById('viewport').getBoundingClientRect();
  const px = (p, d) => (ws.panUnit === '%' ? ((p || 0) / 100) * d : p || 0);
  return { at: ws.at || null, x: +px(ws.pan, r.width).toFixed(2), y: +px(ws.panY, r.height).toFixed(2), z: +(ws.zoom || 1).toFixed(4) }; })()`);
const viewSize = (c) => c.eval(`(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
const empty = (c, fx = 0.5, fy = 0.5) => c.eval(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(), top = document.querySelector('.menubar').getBoundingClientRect().bottom + 8;
  const want = { x: v.left + v.width * ${fx}, y: top + (v.bottom - top) * ${fy} }; let best = null;
  for (let y = top; y < v.bottom - 16; y += 8) for (let x = v.left + 12; x < v.right - 12; x += 8) { const e = document.elementFromPoint(x, y); if (e && e.matches('.canvas, .ws')) { const d = Math.hypot(x - want.x, y - want.y); if (!best || d < best.d) best = { x, y, d }; } }
  return best; })()`);
async function pinch(c, x, y, dys) {
  const t0 = Date.now();
  for (let i = 0; i < dys.length; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dys[i], modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * 16) / 1000 });
}
async function press(c, x, y) {
  await L.mouse(c, 'mouseMoved', x, y);
  await L.mouse(c, 'mousePressed', x, y);
  await L.mouse(c, 'mouseReleased', x, y);
}
/* Until a window had no input for 1.4 s and what it draws stays put, then the saves (debounced) have gone out. */
async function quiet(c) {
  await L.sleep(150);
  for (let i = 0; i < 150 && (await c.eval('performance.now() - window.__q')) < 1400; i++) await L.sleep(100);
  let last = '';
  for (let i = 0; i < 30; i++) {
    await L.sleep(250);
    const now = JSON.stringify(await shown(c));
    if (now === last) break;
    last = now;
  }
  await L.sleep(600);
}
async function relaunch(cs) {
  cs.forEach((c) => { try { c.close(); } catch {} });
  await L.stop({ keepTmux: true });
  L.launch({ log: path.join(L.USER_DATA, 'main.log') });
}
/* Pinch and pan in a window: around an empty point, then a drag of the desktop. Checked to have moved what it shows,
   or a view kept and brought back would pass by never having left where it opened. */
async function zoomAndPan(c, dys, dx, what) {
  const v0 = await shown(c), p = await empty(c, 0.45, 0.45);
  await pinch(c, p.x, p.y, dys);
  await quiet(c);
  const v1 = await shown(c), q = await empty(c, 0.6, 0.5);
  await L.drag(c, q.x, q.y, Array(8).fill(dx / 8), { gapMs: 30, holdMs: 250 });
  await quiet(c);
  const v2 = await shown(c);
  ok(`${what}: the pinch zooms it out and the drag moves it`, v1.z < v0.z - 0.05 && near(v2.z, v1.z, 0.0005) && Math.abs(v2.x - v1.x) > 20, { before: v0, pinched: v1, dragged: v2 });
}
const disk = () => JSON.parse(fs.readFileSync(path.join(L.USER_DATA, 'flow-state.json'), 'utf8'));

const SCEN = [];
const scenario = (name, fn) => SCEN.push({ name, fn });

/* A sub-workspace popped out while the main window shows its workspace's main space. */
scenario('zone', async () => {
  let m = await connect(MAIN, 'the main window');
  const mp = await empty(m, 0.4, 0.4);
  await pinch(m, mp.x, mp.y, Array(4).fill(5));
  await quiet(m);
  const m0 = await mainView(m, 'flow');
  const row = await m.eval(`(() => { const e = document.querySelector('#sblist .tr[data-act="zone|z-research"]'); const b = e.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  await L.mouse(m, 'mouseMoved', row.x, row.y);
  await L.sleep(300);
  const zp = await m.eval(`(() => { const b = document.querySelector('#sblist [data-zpop="z-research"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await press(m, zp.x, zp.y);
  let p = await connect(POP, 'the research pop-out');
  await zoomAndPan(p, Array(12).fill(5), 80, 'in the research pop-out');
  const p0 = await shown(p);
  await quiet(m);
  const d = disk(), dw = d.ws.find((w) => w.id === 'flow'), dz = dw.zones.find((z) => z.id === 'z-research'), pv = dz.popView || {};
  const ps = await viewSize(p), kx = dw.panUnit === '%' ? ((pv.pan || 0) / 100) * ps.w : pv.pan || 0, ky = dw.panUnit === '%' ? ((pv.panY || 0) / 100) * ps.h : pv.panY || 0;
  ok(`the pop-out's own view (${p0.z}) is kept with research as its pop-out view`, near(pv.zoom || 1, p0.z, 0.0005) && near(kx, p0.x, 0.5) && near(ky, p0.y, 0.5), { popout: p0, kept: pv, unit: dw.panUnit || 'px', keptPx: { x: +kx.toFixed(2), y: +ky.toFixed(2) } });
  ok('and research\'s own view, the one the main window uses, is left as it was', (dz.zoom || 1) === 1 && (dz.pan || 0) === 0 && near(dw.zoom || 1, m0.z, 0.0005), { research: { x: dz.pan, y: dz.panY, z: dz.zoom }, flow: { x: dw.pan, y: dw.panY, z: dw.zoom } });
  await relaunch([m, p]);
  m = await connect(MAIN, 'the main window after the quit');
  p = await connect(POP, 'the research pop-out after the quit');
  await L.sleep(1500);
  const p1 = await shown(p), m1 = await mainView(m, 'flow');
  ok('after a quit the research pop-out comes back at the zoom and pan it had', same(p1, p0), { before: p0, after: p1 });
  ok('and the main window\'s own view of flow is unchanged', same(m1, m0) && m1.at === null, { before: m0, after: m1 });
  errs.push(...m.errors, ...p.errors);
  m.close();
  p.close();
});

/* The main window shows research when it is popped out, and then goes back to flow's main space. */
scenario('zone-left', async () => {
  let m = await connect(MAIN, 'the main window');
  const sp = await empty(m, 0.5, 0.4);
  await L.swipe(m, sp.x, sp.y, SW);
  await quiet(m);
  const inResearch = (await mainView(m, 'flow')).at;
  const row = await m.eval(`(() => { const e = document.querySelector('#sblist .tr[data-act="zone|z-research"]'); const b = e.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  await L.mouse(m, 'mouseMoved', row.x, row.y);
  await L.sleep(300);
  const zp = await m.eval(`(() => { const b = document.querySelector('#sblist [data-zpop="z-research"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await press(m, zp.x, zp.y);
  let p = await connect(POP, 'the research pop-out');
  await zoomAndPan(p, Array(12).fill(5), 80, 'in the research pop-out');
  const p0 = await shown(p);
  const bp = await m.eval(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); return { x: v.left + v.width / 2, y: v.top + v.height / 2 }; })()`);
  await L.swipe(m, bp.x, bp.y, SW.map((dx) => -dx));
  await quiet(m);
  const m0 = await mainView(m, 'flow');
  ok('the main window was in research, then back in flow\'s main space', inResearch === 'z-research' && m0.at === null, { first: inResearch, then: m0.at });
  await quiet(p);
  await relaunch([m, p]);
  m = await connect(MAIN, 'the main window after the quit');
  p = await connect(POP, 'the research pop-out after the quit');
  await L.sleep(1500);
  const p1 = await shown(p), m1 = await mainView(m, 'flow');
  ok('after the main window left research and a quit, the pop-out still comes back at its own zoom and pan', same(p1, p0), { before: p0, after: p1 });
  ok('and the main window\'s own view of flow\'s main space is unchanged', same(m1, m0), { before: m0, after: m1 });
  errs.push(...m.errors, ...p.errors);
  m.close();
  p.close();
});

/* Item 49: a space takes its view along between windows. research, zoomed and panned in the main window, popped out
   from there: the pop-out shows what the main window showed. Zoomed and panned again in the pop-out, then closed (as
   its close button does): the main window shows research where the pop-out left it. */
scenario('zone-here', async () => {
  let m = await connect(MAIN, 'the main window');
  // low in the view, so the swipe's last events after the step land on desktop in research, not on its page w-judge
  const sp = await empty(m, 0.5, 0.97);
  await L.swipe(m, sp.x, sp.y, SW);
  await quiet(m);
  await zoomAndPan(m, Array(6).fill(5), 60, 'in research in the main window');
  const at0 = (await mainView(m, 'flow')).at, m0 = await seen(m), mv0 = await shown(m);
  ok('the main window shows research, zoomed and panned with real input', at0 === 'z-research' && mv0.z < 0.95 && Math.abs(mv0.x) > 20, { at: at0, view: mv0 });
  const row = await m.eval(`(() => { const e = document.querySelector('#sblist .tr[data-act="zone|z-research"]'); const b = e.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  await L.mouse(m, 'mouseMoved', row.x, row.y);
  await L.sleep(300);
  const zp = await m.eval(`(() => { const b = document.querySelector('#sblist [data-zpop="z-research"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await press(m, zp.x, zp.y);
  const p = await connect(POP, 'the research pop-out');
  await quiet(p);
  const p0 = await seen(p), pv0 = await shown(p);
  ok('popped out from there, the pop-out shows what the main window showed', at0 === 'z-research' && mv0.z < 0.95 && sameSight(m0, p0), { main: { view: mv0, ...m0 }, popout: { view: pv0, ...p0 } });
  await zoomAndPan(p, Array(6).fill(5), -60, 'in the research pop-out');
  const p1 = await seen(p), pv1 = await shown(p);
  errs.push(...p.errors);
  await p.eval('setTimeout(() => window.close(), 50), true');
  await L.waitFor(async () => !(await L.targets()).some((x) => x.type === 'page' && POP.test(x.url)), 15000, 'the pop-out to close');
  await quiet(m);
  const at1 = (await mainView(m, 'flow')).at, m1 = await seen(m), mv1 = await shown(m);
  ok('closed, research is back in the main window where the pop-out left it', at1 === 'z-research' && sameSight(p1, m1), { popout: { view: pv1, ...p1 }, main: { view: mv1, ...m1 } });
  errs.push(...m.errors);
  m.close();
  try { p.close(); } catch {}
});

/* A whole workspace popped out from its pill. */
scenario('workspace', async () => {
  let m = await connect(MAIN, 'the main window');
  const i = await m.eval(`__flow.state().ws.findIndex((w) => w.id === 'infra')`);
  const m0 = { flow: await mainView(m, 'flow'), infra: await mainView(m, 'infra') };
  const pill = await m.eval(`(() => { const b = document.querySelector('.sp[data-i="${i}"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await L.mouse(m, 'mouseMoved', pill.x, pill.y);
  await L.sleep(300);
  const pb = await m.eval(`(() => { const e = document.querySelector('.sp[data-i="${i}"] [data-pop]'); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, shown: getComputedStyle(e).display }; })()`);
  await press(m, pb.x, pb.y);
  let p = await connect(POP, 'the infra pop-out');
  // a drag to the left: the pinch leaves infra past the view's right side, and it may not go further out that way
  await zoomAndPan(p, Array(10).fill(5), -60, 'in the infra pop-out');
  const p0 = await shown(p);
  await quiet(m);
  await relaunch([m, p]);
  m = await connect(MAIN, 'the main window after the quit');
  p = await connect(POP, 'the infra pop-out after the quit');
  await L.sleep(1500);
  const p1 = await shown(p), m1 = { flow: await mainView(m, 'flow'), infra: await mainView(m, 'infra') };
  ok('after a quit the infra pop-out comes back at the zoom and pan it had', same(p1, p0), { before: p0, after: p1 });
  ok('and the main window\'s own views (flow on screen, infra in another window) are unchanged', same(m1.flow, m0.flow) && same(m1.infra, m0.infra), { before: m0, after: m1 });
  errs.push(...m.errors, ...p.errors);
  m.close();
  p.close();
});

const unknown = (ONLY || []).filter((n) => !SCEN.some((s) => s.name === n));
if (unknown.length) { console.log(`FAIL --only names no scenario: ${unknown.join(', ')} (there are ${SCEN.map((s) => s.name).join(', ')})`); process.exit(1); }
const errs = [];
const t0 = Date.now();
for (const s of SCEN) {
  if (ONLY && !ONLY.includes(s.name)) continue;
  console.log(`-- ${s.name}`);
  await L.writeSeed();
  L.launch({ log: path.join(L.USER_DATA, 'main.log') });
  try { await s.fn(); } catch (e) { ok(`${s.name} ran to its end`, false, e.message); }
  await L.stop();
}
ok('no console errors or exceptions in any Flow window', errs.length === 0, errs.slice(0, 6));
console.log(`\n${oks} ok, ${fails} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(fails ? 1 : 0);




