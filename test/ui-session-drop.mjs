// A session dragged from the sidebar onto the desktop opens where it is let go and covers no window (nav.placeRoom, as
// a dock drop does): on open space its corner is where the hand put it; where that spot is taken, it takes the open
// space there or what is in its way makes way. The sessions are the test's own (claude -p /cost in a folder of its
// own, no API call). Real input over CDP: the row's drag is intercepted (Input.setInterceptDrags) and let go with
// Input.dispatchDragEvent, as a mouse drag is.
//   node test/ui-session-drop.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, key, type, MOD, reporter } from './ui-lib.mjs';
import { PORT, CWD } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
function ownSession(tag) {
  const word = `${tag}-${Date.now().toString(36)}`;
  const cwd = path.join(CWD, 'sessions', word);
  fs.mkdirSync(cwd, { recursive: true });
  const id = crypto.randomUUID();
  execFileSync('claude', ['-p', '/cost', '--session-id', id], { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!fs.existsSync(path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'), `${id}.jsonl`))) throw new Error(`claude -p /cost made no transcript for ${id}`);
  return { id, word };
}
const waitFor = async (app, expr, ms = 15000, step = 200) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { const v = await evaluate(app, expr); if (v) return v; }
  return evaluate(app, expr);
};
const box = (app, sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null; })()`);
const others = (app, id) => evaluate(app, `[...document.querySelectorAll('.win')].filter((e) => e.offsetParent && e.dataset.id !== ${JSON.stringify(id)}).map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.id, x: r.left, y: r.top, w: r.width, h: r.height }; })`);
const hit = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

/* ⌘K, the session's word typed: its row shows in the sidebar. */
async function showRow(app, s) {
  const ok = await waitFor(app, `flow.sessions.search(${JSON.stringify(s.word)}).then((r) => r.results.some((x) => x.id === ${JSON.stringify(s.id)}))`, 300000, 2000);
  if (!ok) throw new Error(`the search did not find ${s.id}`);
  await evaluate(app, 'document.activeElement && document.activeElement.blur && document.activeElement.blur(), true');
  await key(app, 'k', MOD.meta);
  await sleep(300);
  await evaluate(app, 'document.getElementById("q").select(), true');
  await type(app, s.word);
  return waitFor(app, `!!document.querySelector('.srow[data-sess="${s.id}"]')`, 8000);
}
/* The row picked up, carried to the point and let go there. */
async function dragRowTo(app, s, to) {
  const row = await box(app, `.srow[data-sess="${s.id}"]`);
  let data = null;
  app.on((m) => { if (m.method === 'Input.dragIntercepted') data = m.params.data; });
  await app.send('Input.setInterceptDrags', { enabled: true });
  await mouse(app, 'mouseMoved', row.cx, row.cy);
  await mouse(app, 'mousePressed', row.cx, row.cy, { button: 'left', buttons: 1 });
  for (let i = 1; i <= 6 && !data; i++) { await mouse(app, 'mouseMoved', row.cx + i * 10, row.cy + i * 3, { down: true }); await sleep(60); }
  for (let i = 0; i < 40 && !data; i++) await sleep(50);
  if (!data) throw new Error('the row\'s drag never started');
  for (const type of ['dragEnter', 'dragOver']) { await app.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data }); await sleep(80); }
  await app.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
  await mouse(app, 'mouseReleased', to.x, to.y, { button: 'left', buttons: 0 });
  await app.send('Input.setInterceptDrags', { enabled: false });
}
/* Close the window and end its session from the sidebar, so the resumed claude does not keep running. */
async function closeAndEnd(app, id) {
  const c = await box(app, `.win[data-id="${id}"] > .tb [data-l=close]`);
  if (!c) return;
  await click(app, c.cx, c.cy);
  await sleep(500);
  const e = await box(app, `.tr[data-act="reopen|${id}"] [data-end]`);
  if (!e) return;
  await mouse(app, 'mouseMoved', e.cx - 30, e.cy);
  await sleep(100);
  const e2 = await box(app, `.tr[data-act="reopen|${id}"] [data-end]`);
  await click(app, e2.cx, e2.cy);
  await sleep(1200);
}

const picks = [ownSession('drop-open'), ownSession('drop-full')];
dev('stop');
dev('start', '--fresh');
const app = await connectTo(PORT, /\/src\/index\.html$/);
for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
if ((await evaluate(app, '[innerWidth, innerHeight].join()')) !== '1500,913') {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
}
await sleep(1500);
const v = await box(app, '#viewport');
const z = (await evaluate(app, '__flow.state().ws[0].zoom')) || 1;
// the window a dropped session opens as: 34% x 42% of the view, its corner 12% left of and 4% above the hand
const size = { w: 0.34 * v.w * z, h: 0.42 * v.h * z }, off = { x: 0.12 * v.w * z, y: 0.04 * v.h * z };
const opened = [];
try {
  for (const [s, kind] of [[picks[0], 'open'], [picks[1], 'full']]) {
    // open: a point of bare desktop whose spot is clear; full: one whose spot covers a window
    const to = await evaluate(app, `(() => {
      const v = ${JSON.stringify(v)}, size = ${JSON.stringify(size)}, off = ${JSON.stringify(off)}, open = ${kind === 'open'};
      const wins = [...document.querySelectorAll('.win')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
      const hit = (a, b) => a.x < b.x + b.width - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.h - 1;
      for (let y = v.y + 60; y < v.y + v.h - 120; y += 20) for (let x = v.x + off.x + 20; x < v.x + v.w - 40; x += 20) {
        const spot = { x: x - off.x, y: y - off.y, w: size.w, h: size.h };
        // inside the view, and no higher than a window's top row (nav's TOP, 6.6% of the view): there the spot is what it gets
        if (spot.x < v.x || spot.y < v.y + 0.066 * v.h || spot.x + spot.w > v.x + v.w || spot.y + spot.h > v.y + v.h - 12) continue;
        if (wins.some((b) => hit(spot, b)) === open) continue;
        const e = document.elementFromPoint(x, y);
        if (e && !e.closest('.win, #dock, .toast, .ctx') && e.closest('#viewport')) return { x, y, spot };
      }
      return null;
    })()`);
    if (!R.ok(`${kind}: a point to let it go`, !!to, kind)) continue;
    if (!R.ok(`${kind}: its row shows in the sidebar`, await showRow(app, s))) continue;
    await dragRowTo(app, s, to);
    const w = await waitFor(app, `__flow.windows().find((x) => x.sessionId === ${JSON.stringify(s.id)}) || null`, 10000, 250);
    if (!R.ok(`${kind}: letting the row go on the desktop opens the session there`, !!w, w && w.id)) continue;
    opened.push(w.id);
    await sleep(1500);
    const g = await box(app, `.win[data-id="${w.id}"]`), rest = await others(app, w.id);
    const under = rest.filter((o) => hit(g, o)).map((o) => o.id);
    R.ok(`${kind}: it covers no window`, under.length === 0, { win: g, under });
    if (kind === 'open') R.ok('open: its corner is where the hand put it', Math.abs(g.x - to.spot.x) < 4 && Math.abs(g.y - to.spot.y) < 4, { win: { x: g.x, y: g.y }, spot: { x: to.spot.x, y: to.spot.y } });
    else R.ok('full: it opens at the point it was let go, the hand inside it side to side', g.x - 0.012 * v.w * z <= to.x && to.x <= g.x + g.w + 0.012 * v.w * z && g.y <= to.y + 0.06 * v.h * z, { win: g, to: { x: to.x, y: to.y } });
    await key(app, 'Escape');
  }
  R.ok('no console errors or exceptions in the main window', app.errors.filter((e) => !e.startsWith('console.warning')).length === 0, app.errors.slice(0, 5));
} finally {
  for (const id of opened) await closeAndEnd(app, id);
  dev('stop');
}
R.summary();
process.exit();




