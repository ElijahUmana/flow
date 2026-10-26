// overview's check of the map in a sub-workspace inside a sub-workspace (batch 9's nesting): flow › research › deep holds
// two windows, one past the view. Reached for, does the map come up with deep's two windows only, and does a click on
// bare map at its right end move deep's view and keep Flow in deep? Real input over CDP on overview's isolated Flow
// (port 9581, socket flow-dev-overview), a fresh seed without host windows where every terminal is a shell.
//   node test/overview-repro-nested.mjs [label]      exit 1 on any failed check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launch, stop, flowWindow, writeSeed, resetState, mouse, moveTo, click, sleep, waitFor, shot, USER_DATA } from './overview-lib.mjs';

const LABEL = process.argv[2] || 'repro-nested';
const OUT = path.join(USER_DATA, LABEL);
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'probe.log');
fs.writeFileSync(LOG, '');
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const r2 = (n) => Math.round(n * 100) / 100;
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };
const OV = `(() => {
  const el = document.querySelector('.ov');
  if (!el) return null;
  const cs = getComputedStyle(el), r = el.getBoundingClientRect(), box = (e) => { if (!e) return null; const q = e.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
  return { shown: cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.95, area: { x: r.left + 1, y: r.top + 1, w: r.width - 2, h: r.height - 2 }, shapes: [...el.querySelectorAll('i')].map(box), frame: box(el.querySelector('u')) };
})()`;
const VIEW = `(() => {
  const s = window.__flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), vp = document.getElementById('viewport').getBoundingClientRect();
  // ws.pan is the view of the space on screen, a sub-workspace's own included (app.js:210)
  const pc = ws.panUnit === '%', pan = ws.pan || 0;
  return { ws: ws.id, at: ws.at || null, pan: pc ? (pan / 100) * vp.width : pan, right: vp.right, bottom: vp.bottom, left: vp.left, top: vp.top, vw: vp.width, vh: vp.height };
})()`;
const emptyRight = (o) => { const y = o.area.y + o.area.h / 2; for (let x = o.area.x + o.area.w - 1.2; x > o.area.x + o.area.w * 0.6; x -= 1) if (!o.shapes.some((q) => x >= q.x - 1 && x <= q.x + q.w + 1 && y >= q.y - 1 && y <= q.y + q.h + 1)) return { x, y }; return null; };

await writeSeed();
let moved = [];
resetState((doc) => {
  const flow = doc.ws.find((w) => w.id === 'flow');
  const zn = flow.zones.find((z) => z.id === 'z-research');
  flow.windows.forEach((w) => { const cx = w.x + w.w / 2; if (cx >= zn.x && cx <= zn.x + zn.w) { w.zone = zn.id; w.x = w.x - zn.x + 1.2; } });
  delete zn.x; delete zn.y; delete zn.w; delete zn.h; zn.pan = 0;
  flow.zones.push({ id: 'z-deep', name: 'deep', pan: 0, parent: 'z-research' });
  const inR = flow.windows.filter((w) => w.zone === 'z-research');
  if (inR.length < 2) throw new Error(`research has ${inR.length} windows in the seed, not 2 or more`);
  Object.assign(inR[0], { zone: 'z-deep', x: 1.2 });
  Object.assign(inR[1], { zone: 'z-deep', x: 104 });
  moved = [inR[0].id, inR[1].id];
  flow.at = 'z-deep';
  doc.ui.at = 'flow';
});

launch();
let c;
try {
  c = await flowWindow();
  await sleep(2500);
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', f))).digest('hex').slice(0, 8);
  log(`overview.js ${md5('overview.js')}, app.js ${md5('app.js')}, nav.js ${md5('nav.js')}; deep holds ${moved.join(', ')}; load ${fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ')}`);
  const v = await c.eval(VIEW);
  if (v.ws !== 'flow' || v.at !== 'z-deep') throw new Error(`Flow opened on ${v.ws} › ${v.at}, not flow › z-deep`);
  const k = { x: v.right - 120, y: v.bottom - 6 };
  await moveTo(c, v.left + v.vw / 2, v.top + v.vh / 2, k.x, k.y, { steps: 10, gapMs: 16 });
  await sleep(60);
  await mouse(c, 'mouseMoved', k.x + 1, k.y);
  const o = await waitFor(async () => { const q = await c.eval(OV); return q && q.shown ? q : null; }, 4000, 'the map').catch(() => null);
  check('N1 in flow › research › deep, reached for, the map comes up with deep\'s 2 windows only', !!o && o.shapes.length === 2, o ? `${o.shapes.length} shapes` : 'not up');
  await shot(c, path.join(OUT, 'deep-map.png'));
  if (o) {
    const sp = emptyRight(o);
    if (sp) await click(c, sp.x, sp.y);
    const after = await waitFor(async () => { const q = await c.eval(VIEW); return q.pan > v.pan + 100 ? q : null; }, 5000, 'the view to move').catch(() => null) || await c.eval(VIEW);
    check('N2 a click on bare map at its right end moves deep\'s view there, and Flow stays in deep', !!sp && after.pan > v.pan + 100 && after.at === 'z-deep', `${sp ? `clicked ${r2(sp.x - o.area.x)} px into the map of ${r2(o.area.w)}` : 'no bare spot at the right end'}; pan ${r2(v.pan)} -> ${r2(after.pan)}; at ${after.at}`);
  }
  check('N3 no console errors or exceptions', !c.errors.length, `${c.errors.slice(0, 4).join(' | ') || 'none'}${c.handled.length ? `; warnings for handled cases: ${c.handled.length}` : ''}`);
} catch (err) {
  fails++;
  log(`FAIL the probe stopped: ${err.stack || err}`);
} finally {
  if (c) c.close();
  await stop();
}
log(fails ? `${fails} failed` : 'all passed');
if (fails) process.exitCode = 1;




