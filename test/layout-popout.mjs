// layout's check of room in a pop-out narrower than the main window, seen again in the main window, with real input
// over CDP in layout's own isolated app (layout-lib.mjs). Flow starts with the research sub-workspace popped out at
// 960 px wide (the state's popouts, as after a restart), the main window at the screen's width, and one of research's
// windows lying past the right side of the view. On the batch-7 board a double-click at a side moves what lies past it
// one view on (lead 14:2x), in the windows' own unit, the same in either window. Shells only, no host windows, pages
// blank.
//   LAYOUT_ROOT=<app tree> node test/layout-popout.mjs [--keep]     screenshots: LAYOUT_SHOTS (default /tmp/flow-dev-layout/popout-shots)
import fs from 'node:fs';
import path from 'node:path';
import { sleep, waitFor, mouse, shot as shotOf, Cdp } from './nav-lib.mjs';
import { ROOT, USER_DATA, launch, stop, flowWindow, writeSeed, running, targets } from './layout-lib.mjs';

const SHOTS = process.env.LAYOUT_SHOTS || path.join(USER_DATA, 'popout-shots');
const KEEP = process.argv.includes('--keep');
const HASH = 'solo=flow&zone=z-research';
const q = JSON.stringify;
let c, p, oks = 0, fails = 0;
function ok(name, pass, detail) {
  if (pass) oks++; else fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : q(detail)}` : ''}`);
}
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

/* research as a page sees it: its windows in % and on screen, its view as %, its room, and what is in view. */
const research = (page) => page.eval(`(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === 'flow'), zn = ws.zones.find((z) => z.id === 'z-research');
  /* the view as drawn (the canvas transform), so a pop-out's own view counts, whatever unit it is kept in */
  const vp = document.getElementById('viewport').getBoundingClientRect(), cv = document.querySelector('.ws[data-id="flow"] .canvas');
  const m = new DOMMatrixReadOnly(getComputedStyle(cv).transform), v = { x: ((-m.m41 / m.a) / vp.width) * 100, w: 100 / m.a, z: m.a };
  const wins = {}; ws.windows.filter((w) => w.zone === 'z-research').forEach((w) => { const el = document.querySelector('.win[data-id=' + JSON.stringify(w.id) + ']'), b = el && el.getBoundingClientRect();
    wins[w.id] = { x: w.x, w: w.w, sx: b ? b.left : null, sw: b ? b.width : null, shown: !!(b && b.width && getComputedStyle(el).display !== 'none') }; });
  const inView = Object.keys(wins).filter((id) => wins[id].shown && wins[id].sx < vp.right - 1 && wins[id].sx + wins[id].sw > vp.left + 1);
  const away = document.querySelector('.ws[data-id="flow"] .away');
  return { vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height }, view: { x: v.x, w: v.w, z: v.z }, roomRight: zn.roomRight || 0, wins, inView,
    at: ws.at || null, away: !!(away && getComputedStyle(away).display !== 'none') }; })()`);
/* A double-click with its own event times, as a real one has, so a busy window cannot stretch it. */
async function dbl(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  const t = Date.now();
  for (const [n, dt] of [[1, 0], [2, 120]]) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n, pointerType: 'mouse', timestamp: (t + dt) / 1000 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n, pointerType: 'mouse', timestamp: (t + dt + 40) / 1000 });
  }
}
/* Both windows share one display here, so the one acted on comes to the front first, as a hand's click would bring it. */
const front = async (page) => { await page.send('Page.bringToFront'); await sleep(400); };
/* A slow drag of the desktop, held still before the release so it does not glide. */
async function drag(page, x0, y, dx) {
  await mouse(page, 'mouseMoved', x0, y);
  await mouse(page, 'mousePressed', x0, y);
  const n = 24;
  for (let k = 1; k <= n; k++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (dx * k) / n, y, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(16); }
  await sleep(150);
  await mouse(page, 'mouseReleased', x0 + dx, y);
  await sleep(700);
}

/* A point of bare desktop to drag dx px from, clear of every window by 30 px (a window's side and the + by it), the drag
   staying in the view. */
async function bareFor(page, s, dx) {
  for (const fx of [0.9, 0.75, 0.6, 0.45, 0.3, 0.15, 0.96, 0.04]) for (const fy of [0.05, 0.94, 0.5, 0.3, 0.7, 0.15, 0.85]) {
    const x = s.vp.x + s.vp.w * fx, y = s.vp.y + s.vp.h * fy;
    if (x + dx < s.vp.x + 8 || x + dx > s.vp.x + s.vp.w - 8) continue;
    const clear = await page.eval(`(() => { const e = document.elementFromPoint(${x}, ${y}); if (!e || !e.closest('.ws') || e.closest('.win, button, .menubar')) return false;
      return [...document.querySelectorAll('.win')].every((w) => { const b = w.getBoundingClientRect(); return !b.width || ${x} < b.left - 30 || ${x} > b.right + 30 || ${y} < b.top - 30 || ${y} > b.bottom + 30; }); })()`);
    if (clear) return { x, y };
  }
  throw new Error('no bare desktop to drag from');
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`tree ${ROOT}`);
  const seed = await writeSeed();
  console.log(`seed: ${seed.ids.join(', ')}; host windows removed: ${seed.removed.join(', ') || 'none'}`);
  const state = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'seed.json'), 'utf8'));
  state.ws.forEach((ws) => (ws.notes || []).forEach((n) => { if (n.kind === 'page') n.url = ''; }));
  state.ui = { ...(state.ui || {}), at: 'flow' };
  state.popouts = [{ hash: HASH, bounds: { x: 640, y: 40, width: 960, height: 900 } }];
  /* read lies past the right side of research's view, so a double-click there has something to move; given its zone, it
     stays in the zone's own coordinates (app.js migrateZones moves only windows without one) */
  const read = state.ws.find((w) => w.id === 'flow').windows.find((w) => w.id === 'w-read');
  Object.assign(read, { zone: 'z-research', x: 110 });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify(state));
  launch();
  c = await flowWindow();
  const t = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 30000, 'the research pop-out');
  p = await Cdp.connect(t.webSocketDebuggerUrl);
  await p.send('Runtime.enable');
  await waitFor(() => p.eval('!!(window.__flow && window.__flow.ready)'), 30000, 'the pop-out ready');
  await p.eval('window.__flow.ready.then(() => true)');
  await sleep(1500);

  /* 1. the pop-out is narrower, and research lives only there */
  await front(p);
  const m0 = await research(c), p0 = await research(p);
  console.log(`research in the pop-out: ${q(Object.fromEntries(Object.entries(p0.wins).map(([k, v]) => [k, [+v.x.toFixed(2), +v.w.toFixed(2)]])))}`);
  ok('research is popped out narrower than the main window', p0.vp.w < m0.vp.w - 200, { popout: p0.vp.w, main: m0.vp.w });
  await shotOf(p, path.join(SHOTS, '01-popout-before.png'));

  /* 2. a double-click at the pop-out's right side moves what lies past it one view on, in the windows' own unit: read goes
     100% further, kv and judge in view stay, and so does the view */
  const r0 = p0.wins['w-read'].x;
  ok('read starts past the right side of the pop-out\'s view', r0 >= p0.view.x + p0.view.w && !p0.inView.includes('w-read'), { read: r0, view: p0.view });
  await dbl(p, p0.vp.x + p0.vp.w - 10, p0.vp.y + p0.vp.h * 0.5);
  await sleep(600);
  const p1 = await research(p);
  ok('in the pop-out, a double-click at the right side moves the window past it one view on', near(p1.wins['w-read'].x, r0 + 100, 0.1), { read: [r0, p1.wins['w-read'].x] });
  ok('and the pop-out\'s view and the windows in view stay', near(p1.view.x, p0.view.x, 0.05) && ['w-kv', 'w-judge'].every((id) => near(p1.wins[id].x, p0.wins[id].x, 0.01)), { view: [p0.view.x, p1.view.x] });

  /* 3. a drag in the pop-out goes there: a whole view of empty room, by as much as the hand moved */
  let d = await bareFor(p, p1, -p1.vp.w * 0.5);
  await drag(p, d.x, d.y, -p1.vp.w * 0.5);
  d = await bareFor(p, await research(p), -p1.vp.w * 0.5);
  await drag(p, d.x, d.y, -p1.vp.w * 0.5);
  const p2 = await research(p);
  ok('a drag in the pop-out goes there: a whole view of the room, with nothing in it', near(p2.view.x, p1.view.x + 100, 1) && p2.inView.length === 0, { view: [p1.view.x, p2.view.x], inView: p2.inView });
  await shotOf(p, path.join(SHOTS, '02-popout-in-room.png'));
  /* leave the pop-out's view partway back, half in the room, so the main window must show the same part of the space */
  d = await bareFor(p, p2, p2.vp.w * 0.5);
  await drag(p, d.x, d.y, p2.vp.w * 0.5);
  const p3 = await research(p);
  ok('the pop-out\'s view is left partway, half in the room', near(p3.view.x, p2.view.x - 50, 1), p3.view);

  /* 4. closed, research comes back to the main window with the same room and the same view, in the windows' unit */
  await p.eval('window.close(); true').catch(() => {});
  try { p.close(); } catch {}
  p = null;
  await waitFor(async () => !(await targets()).some((x) => x.type === 'page' && /zone=z-research/.test(x.url)), 15000, 'the pop-out to close');
  await sleep(1200);
  await front(c);
  const row = await c.eval(`(() => { const e = document.querySelector('#sblist .tr[data-act="zone|z-research"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  if (row) { await mouse(c, 'mouseMoved', row.x, row.y); await mouse(c, 'mousePressed', row.x, row.y); await mouse(c, 'mouseReleased', row.x, row.y); }
  await sleep(1200);
  const m1 = await research(c);
  ok('research is back in the main window, not "in another window"', m1.at === 'z-research' && !m1.away, { at: m1.at, away: m1.away });
  ok('the windows are where the pop-out left them, read one view on, in the windows\' unit', Object.keys(p3.wins).every((id) => near(m1.wins[id].x, p3.wins[id].x, 0.01)) && near(m1.wins['w-read'].x, r0 + 100, 0.1), { read: m1.wins['w-read'].x });
  ok('the main window shows research where the pop-out left it, in the windows\' unit', near(m1.view.x, p3.view.x, 0.5) && near(m1.view.z, p3.view.z, 0.01), { main: m1.view, popout: p3.view });
  await shotOf(c, path.join(SHOTS, '03-main-after.png'));

  /* 5. a drag in the main window reaches the same room: a whole view of it, empty, read just past it */
  d = await bareFor(c, m1, -m1.vp.w * 0.5);
  await drag(c, d.x, d.y, -m1.vp.w * 0.5);
  const m2 = await research(c);
  ok('a drag in the main window reaches the same room, empty, with read just past it', near(m2.view.x, m1.view.x + 50, 1) && m2.inView.length === 0 && m2.wins['w-read'].sx >= m2.vp.x + m2.vp.w - 1, { view: [m1.view.x, m2.view.x], inView: m2.inView });
  await shotOf(c, path.join(SHOTS, '04-main-in-room.png'));

  const errs = c.errors.filter((e) => !/net::|Failed to load resource|ERR_/.test(e));
  ok('no console errors in the main window', errs.length === 0, errs.slice(0, 5));
}

try {
  if (running()) throw new Error('layout\'s app is already running');
  await main();
} catch (e) {
  fails++;
  console.log(`FAIL ${e.stack || e}`);
} finally {
  try { if (p) p.close(); } catch {}
  try { if (c) c.close(); } catch {}
  if (!KEEP) await stop();
  console.log(`${oks} ok, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}




