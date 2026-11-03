// Opening a pop-out must not drop edge room the owner just added in the main window (spaces' rule drops still-empty
// room only at the next start of Flow; a pop-out opening is not one). overview's repro
// (~/overview/handover/overview-repro-popout-room.mjs) on ui's own instance, with real input.
//   node test/ui-popout-room.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, mouse, reporter } from './ui-lib.mjs';
import { PORT, DATA } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
const waitFor = async (page, expr, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await evaluate(page, expr); if (v) return v; }
  return evaluate(page, expr);
};

dev('stop');
dev('start', '--fresh');
dev('stop');
// start on mynotes, as the repro does
const file = path.join(DATA, 'flow-state.json');
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
doc.ui = { ...(doc.ui || {}), at: 'mynotes' };
fs.writeFileSync(file, JSON.stringify(doc));
dev('start');
const app = await connectTo(PORT, /\/src\/index\.html$/);
for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
const room = () => evaluate(app, `(() => { const s = window.__flow.state(); const mn = s.ws.find((w) => w.id === 'mynotes'); return { mynotesRoomRight: mn.roomRight || 0, at: s.ui.at }; })()`);
// a double-click at the right edge of mynotes' space adds room there
const vp = await evaluate(app, `(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { r: r.right, b: r.bottom }; })()`);
const x = vp.r - 10, y = vp.b - 30;
await mouse(app, 'mouseMoved', x, y);
await mouse(app, 'mousePressed', x, y, { clickCount: 1 });
await mouse(app, 'mouseReleased', x, y, { clickCount: 1 });
await mouse(app, 'mousePressed', x, y, { clickCount: 2 });
await mouse(app, 'mouseReleased', x, y, { clickCount: 2 });
await sleep(600);
const r1 = await room();
R.ok('a double-click at the right edge of mynotes adds room there (roomRight 200)', r1.mynotesRoomRight === 200, r1);
// to flow by its name, then ⤢ on research's row pops research out
const pill = await evaluate(app, `(() => { const r = document.querySelector('.sp[data-i="0"] .sn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await click(app, pill.x, pill.y);
await sleep(900);
const row = await evaluate(app, `(() => { const e = document.querySelector('#sblist [data-zpop="z-research"]'); if (!e) return null; const r = e.getBoundingClientRect(), t = e.closest('.tr').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tx: t.left + 40, ty: t.top + t.height / 2 }; })()`);
let popped = false;
if (row) {
  await mouse(app, 'mouseMoved', row.tx, row.ty);
  await sleep(150);
  await click(app, row.x, row.y);
  for (let i = 0; i < 80 && !popped; i++) {
    await sleep(250);
    popped = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((t) => t.type === 'page' && /zone=z-research/.test(t.url));
  }
}
R.ok('⤢ on research\'s row opens its pop-out', popped);
if (popped) {
  const sp = await connectTo(PORT, 'zone=z-research');
  for (let i = 0; i < 120 && !(await evaluate(sp, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  // read in the pop-out as soon as it is ready, right after its start ran recover(): later, a save from the main
  // window can bring the room back by accident (save order), which hides the drop
  const inPopout = await evaluate(sp, `window.__flow.ready.then(() => { const mn = window.__flow.state().ws.find((w) => w.id === 'mynotes'); return mn.roomRight || 0; })`);
  await sleep(2000);
  const r3 = await room();
  const inFile = (JSON.parse(fs.readFileSync(file, 'utf8')).ws.find((w) => w.id === 'mynotes') || {}).roomRight || 0;
  // the pop-out's own state shows a drop at once; the main window and the file follow once its save arrives
  R.ok('the room added in mynotes is still there after flow › research was popped out', r1.mynotesRoomRight === 200 && inPopout === 200 && r3.mynotesRoomRight === 200 && inFile === 200,
    { before: r1.mynotesRoomRight, after: r3.mynotesRoomRight, popout: inPopout, file: inFile });
  await evaluate(sp, 'setTimeout(() => window.close(), 50), true');
  await sleep(800);
}
R.ok('no console errors or exceptions in the main window', app.errors.filter((e) => !e.startsWith('console.warning')).length === 0, app.errors.slice(0, 3));
R.summary();
dev('stop');
process.exit();




