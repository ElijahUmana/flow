// The main window comes back on the workspace it showed at a quit, with another workspace popped out: only the main
// window writes which workspace it shows (flows' find: a pop-out's save carried its stale ui.at). Real input, then a
// SIGTERM some ms after the last switch and a start.
//   node test/ui-popout-at.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e;
//   WAITS=3000,600 by default: ms between the switch in the main window and the quit)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, reporter } from './ui-lib.mjs';
import { PORT, DATA } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json());
const r = (app, sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const at = (app, x, y, sel) => evaluate(app, `(() => { const e = document.elementFromPoint(${x}, ${y}); return !!(e && e.closest(${JSON.stringify(sel)})); })()`);
async function open() {
  const app = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
  await evaluate(app, 'window.__flow.ready');
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  return app;
}
const shown = (app) => evaluate(app, `(() => { const s = __flow.state(); const on = document.querySelector('#spaces .sp.on .sn'); return { at: s.ui.at, pill: on ? on.textContent : null }; })()`);
// a click on a workspace's pill; resolves to when the click went in (0 when the pill was not there to click)
async function pill(app, i, settle = 900) {
  const p = await r(app, `#spaces .sp[data-i="${i}"] .sn`);
  if (!p || !(await at(app, p.cx, p.cy, `#spaces .sp[data-i="${i}"]`))) return 0;
  await click(app, p.cx, p.cy);
  const t = Date.now();
  await sleep(settle);
  return t;
}
async function round(wait) {
  const label = `quit ${wait} ms after the switch`;
  dev('stop');
  dev('start', '--fresh');
  let app = await open();
  // mynotes to the front, then out into its own window by its ⤢
  if (!R.ok(`${label}: mynotes' pill takes a click`, (await pill(app, 1)) > 0)) return;
  const pop = await r(app, '#spaces .sp[data-i="1"] .pop');
  await mouse(app, 'mouseMoved', pop.cx, pop.cy);
  await sleep(250);
  await click(app, pop.cx, pop.cy);
  let out = false;
  for (let i = 0; i < 60 && !out; i++) { await sleep(250); out = (await targets()).some((t) => t.type === 'page' && /#solo=mynotes$/.test(t.url)); }
  if (!R.ok(`${label}: mynotes is popped out`, out)) return;
  await sleep(1500);
  // the main window goes to "inference infra", and Flow quits `wait` ms after that click
  const t = await pill(app, 2, 0);
  if (!R.ok(`${label}: inference infra's pill takes a click`, t > 0)) return;
  const before = await shown(app);
  if (!R.ok(`${label}: the main window shows inference infra`, before.at === 'infra', before)) return;
  await sleep(Math.max(0, wait - (Date.now() - t)));
  const quitAfter = Date.now() - t;
  dev('stop');
  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'flow-state.json'), 'utf8')).ui.at;
  dev('start');
  app = await open();
  await sleep(1500);
  const after = await shown(app);
  R.ok(`${label}: the main window comes back on inference infra (the file says ${file})`, after.at === 'infra' && after.pill === before.pill && file === 'infra', { quitAfter, before, after, file });
}
for (const w of (process.env.WAITS || '3000,600').split(',').map(Number)) await round(w);
R.summary();
dev('stop');
process.exit();




