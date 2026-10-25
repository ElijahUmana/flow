// Owner 02/14 (Nov 7): "the guide at the bottom right should always be available whenever I go to hover that section".
// Real pointer input over CDP on overview's isolated Flow (port 9581, socket flow-dev-overview). For each board, a rest
// in the bottom-right corner brings the map up, and a click on it still works; before Nov 7 it came up only when some
// window lay off screen.   node test/overview-guide-always.mjs     exit 1 on any failed check
import fs from 'node:fs';
import { launch, stop, flowWindow, writeSeed, resetState, mouse, click, sleep, waitFor } from './overview-lib.mjs';
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const note = (id, x, y, w = 30, h = 40) => ({ id: `w-${id}`, type: 'note', noteId: `n-${id}`, x, y, w, h });
const boards = {
  'every window in view': [note('a', 2, 7), note('b', 40, 7)],
  'a window off screen to the right': [note('a', 2, 7), note('b', 120, 7)],
  'an empty board': [],
  'a window covering the corner': [note('a', 60, 40, 39, 58)],
};
const shown = (c) => c.eval('(() => { const e = document.querySelector(".ov"); return !!e && getComputedStyle(e).visibility !== "hidden" && +getComputedStyle(e).opacity > 0.5; })()');
await writeSeed();
fs.mkdirSync('/tmp/flow-dev-overview/work/gd', { recursive: true });
for (const [name, windows] of Object.entries(boards)) {
  resetState((doc) => {
    doc.ws = [{ id: 'gd', name: 'guide', folder: '/tmp/flow-dev-overview/work/gd', bg: '#141319', zones: [],
      notes: windows.map((w) => ({ id: w.noteId, kind: 'note', title: w.id, body: '' })), windows, closed: [], panUnit: '%' },
      { id: 'gk', name: 'keep', folder: '/tmp/flow-dev-overview/work/gd', bg: '#111', zones: [], notes: [], windows: [], closed: [], panUnit: '%' }];
    doc.ui = { at: 'gd', hinted: true };
  });
  launch();
  let c;
  try {
    c = await flowWindow();
    await sleep(900);
    const r = await c.eval('(() => { const v = document.getElementById("viewport").getBoundingClientRect(); return { r: v.right, b: v.bottom }; })()');
    for (const [x, y] of [[r.r - 300, r.b - 300], [r.r - 120, r.b - 40], [r.r - 60, r.b - 6]]) { await mouse(c, 'mouseMoved', x, y); await sleep(60); }
    const up = await waitFor(() => shown(c), 2000, 'the map').catch(() => false);
    check(`${name}: a rest in the bottom-right corner brings the guide up`, !!up);
    if (up) {
      const m = await c.eval('(() => { const b = document.querySelector(".ov").getBoundingClientRect(); return { x: b.left + b.width * 0.15, y: b.top + b.height * 0.5 }; })()');
      const before = await c.eval('window.__flow.state().ws.find((w) => w.id === "gd").pan || 0');
      await mouse(c, 'mouseMoved', m.x, m.y);
      await click(c, m.x, m.y);
      await sleep(600);
      const after = await c.eval('window.__flow.state().ws.find((w) => w.id === "gd").pan || 0');
      // a click near the map's left end moves the view left when the space is wider than the view; when everything fits
      // (an empty board, every window in view) there is nowhere else to go and the view stays (nav.goTo)
      const fits = name === 'an empty board' || name === 'every window in view';
      check(`${name}: a click on the guide ${fits ? 'keeps the view, the whole space is already on screen' : 'moves the view to where it points'}`,
        fits ? after === before : after < before, `pan ${before} -> ${after}`);
      check(`${name}: the guide shows each window of the space`, (await c.eval('document.querySelectorAll(".ov i").length')) === windows.length);
    }
    await mouse(c, 'mouseMoved', r.r - 700, r.b - 500);
    await sleep(700);
    check(`${name}: it goes again once the pointer leaves`, !(await shown(c)));
    check(`${name}: no console errors`, c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
  } finally { if (c) c.close(); await stop(); }
}
console.log(failed ? `${failed} failed` : 'all passed');
if (failed) process.exitCode = 1;




