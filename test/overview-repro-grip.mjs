// overview's check of the resize grips at the bottom right (batch 8's grips): a window whose bottom sits on the dock's
// line has its bottom grips reach 5 px into the bare strip that brings the map up. A rest on a grip there must leave the
// map down, and a press outside the map while it is up must send it away, so it never sits over a corner being
// resized. Real input over CDP on overview's isolated Flow (port 9581, socket flow-dev-overview, userData
// /tmp/flow-dev-overview), infra's i-sched moved to the bottom right in a fresh seed without host windows.
//   node test/overview-repro-grip.mjs [label]      exit 1 on any failed check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launch, stop, flowWindow, writeSeed, resetState, mouse, moveTo, sleep, waitFor, shot, USER_DATA } from './overview-lib.mjs';

const LABEL = process.argv[2] || 'repro-grip';
const OUT = path.join(USER_DATA, LABEL);
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'repro.log');
fs.writeFileSync(LOG, '');
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const r1 = (n) => Math.round(n * 10) / 10;
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };
const ID = 'i-sched';
const UP = `(() => { const el = document.querySelector('.ov'); if (!el) return null; const cs = getComputedStyle(el); return cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.5; })()`;
const RECT = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; })()`;

await writeSeed();
const CASES = ['the bottom grip, in the strip', 'the corner grip, in the strip', 'the map reached for first, then the corner grip'];
for (const name of CASES) {
  resetState((doc) => {
    const ws = doc.ws.find((w) => w.id === 'infra');
    const w = ws.windows.find((q) => q.id === ID);
    Object.assign(w, { x: 58, y: 52, w: 38, h: 46.6, z: 999 });
    doc.ui.at = 'infra';
  });
  launch();
  let c;
  try {
    c = await flowWindow();
    await sleep(2500);
    const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', f))).digest('hex').slice(0, 8);
    if (name === CASES[0]) log(`overview.js ${md5('overview.js')}, app.js ${md5('app.js')}, app.css ${md5('app.css')}; load ${fs.readFileSync('/proc/loadavg', 'utf8').trim()}`);
    const vp = await c.eval(RECT('#viewport'));
    const win = await c.eval(RECT(`.win[data-id="${ID}"]`));
    const s = await c.eval(RECT(`.win[data-id="${ID}"] .rz[data-rz="s"]`)), se = await c.eval(RECT(`.win[data-id="${ID}"] .rz[data-rz="se"]`));
    if (!win || !s || !se) throw new Error(`no ${ID} window or no grips: ${JSON.stringify({ win, s, se })}`);
    if (name === CASES[0]) log(`viewport bottom ${r1(vp.bottom)}, right ${r1(vp.right)}; ${ID} bottom ${r1(win.bottom)} (${r1(vp.bottom - win.bottom)} px above), right ${r1(win.right)}; s grip ${r1(s.y)}..${r1(s.bottom)}, se grip ${r1(se.x)}..${r1(se.right)} x ${r1(se.y)}..${r1(se.bottom)}`);
    const p = name === CASES[0] ? { x: Math.min(s.right - 60, vp.right - 120), y: vp.bottom - 9 } : { x: se.x + se.w / 2, y: vp.bottom - 9 };
    const on = await c.eval(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? (e.dataset.rz ? 'grip ' + e.dataset.rz : e.className || e.tagName) : null; })()`);
    let reached = null;
    if (name === CASES[2]) {
      await moveTo(c, win.x + win.w / 2, win.y + win.h / 2, vp.right - 1, vp.bottom - 1, { steps: 12, gapMs: 16 });
      reached = await waitFor(() => c.eval(UP), 3000, 'the map').catch(() => false);
      await moveTo(c, vp.right - 1, vp.bottom - 1, p.x, p.y, { steps: 6, gapMs: 16 });
    } else await moveTo(c, win.x + win.w / 2, win.y + win.h / 2, p.x, p.y, { steps: 12, gapMs: 16 });
    await sleep(500);
    const upRest = await c.eval(UP);
    const tag = name.replace(/\W+/g, '-').replace(/-+$/, '');
    await shot(c, path.join(OUT, `${tag}-rest.png`));
    await mouse(c, 'mousePressed', p.x, p.y);
    const t0 = Date.now(), during = [];
    for (let i = 1; i <= 15; i++) {
      await mouse(c, 'mouseMoved', p.x - i * 5, p.y - i * 5, { down: true });
      await sleep(30);
      during.push([Date.now() - t0, await c.eval(UP)]);
    }
    await sleep(200);
    const mid = await c.eval(UP);
    await shot(c, path.join(OUT, `${tag}-resizing.png`));
    await mouse(c, 'mouseReleased', p.x - 75, p.y - 75);
    await sleep(400);
    const g1 = await c.eval(RECT(`.win[data-id="${ID}"]`));
    /* the map fades out over 170 ms, so samples from 250 ms after the press on count */
    /* UP is null when the page has no map at all: that counts as a failure, never as down */
    const late = during.filter((q) => q[0] >= 250), upLate = late.filter((q) => q[1] !== false).length, upAll = during.filter((q) => q[1] !== false).length;
    const onGrip = on === (name === CASES[0] ? 'grip s' : 'grip se');
    const resized = g1.h < win.h - 40 && (name === CASES[0] || g1.w < win.w - 40);
    const what = `under the pointer ${on}; after a 500 ms rest the map ${upRest === null ? 'was not in the page' : upRest ? 'was up' : 'was down'}; while resizing up in ${upAll} of ${during.length} samples (${upLate} of ${late.length} from 250 ms on)${mid ? ', still up at the end' : ''}; ${ID} ${r1(win.w)}x${r1(win.h)} -> ${r1(g1.w)}x${r1(g1.h)}`;
    if (name === CASES[2]) check('3 reached for, then a press on the corner grip beside it: the map goes, and the window resizes', reached === true && onGrip && late.length >= 5 && upLate === 0 && mid === false && resized, `the map ${reached ? 'came up in the corner' : 'did not come up in the corner'}; ${what}`);
    else check(`${name === CASES[0] ? '1 a rest on a window\'s bottom grip' : '2 a rest on its corner grip'} in the bottom strip leaves the map down, and the window resizes`, onGrip && upRest === false && upAll === 0 && mid === false && resized, what);
    check(`${CASES.indexOf(name) + 1}x no console errors or exceptions`, !c.errors.length, c.errors.length ? c.errors.slice(0, 5).join(' | ') : 'none');
  } catch (err) {
    fails++;
    log(`FAIL the check stopped: ${err.stack || err}`);
    process.exitCode = 1;
  } finally {
    if (c) c.close();
    await stop();
  }
}
log(`${fails ? `${fails} failed` : 'all passed'}`);
if (fails) process.exitCode = 1;




