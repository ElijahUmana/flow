// Owner 02/12 (Nov 7): "group a bunch of artifacts in one space ... like a miro board". Real pointer and key input over
// CDP on overview's isolated Flow (port 9581, socket flow-dev-overview), zoomed out as in the owner's image 02-03.
// A shell, a note and a page become one group by shift-click and ⌘G; dragging the group's name moves all three; one
// window's own drag still moves only it and the frame follows; the group survives a restart; ⇧⌘G takes it apart with
// every window left where it is; a box drawn with shift selects; nothing else in the space moves.
//   node test/overview-groups.mjs      exit 1 on any failed check
import fs from 'node:fs';
import path from 'node:path';
import { launch, stop, flowWindow, writeSeed, resetState, mouse, sleep, waitFor, USER_DATA } from './overview-lib.mjs';
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const SHIFT = 8, META = 4;
const W = '/tmp/flow-dev-overview/work/grp';
const seedWs = () => ({
  id: 'grp', name: 'groups', folder: W, bg: '#141319', zones: [], panUnit: '%', zoom: 0.4, pan: 0, panY: -12,
  notes: [{ id: 'n-a', kind: 'note', title: 'plan', body: 'plan' }, { id: 'n-b', kind: 'note', title: 'other', body: 'other' },
    { id: 'p-a', kind: 'page', title: 'docs', titleSet: true, url: 'about:blank', body: '' }],
  windows: [
    { id: 'sh', type: 'term', cmd: 'shell', cwd: W, title: 'build shell', x: 2, y: 7, w: 36, h: 44, z: 2 },
    { id: 'na', type: 'note', noteId: 'n-a', x: 40, y: 7, w: 34, h: 46, z: 3 },
    { id: 'pa', type: 'page', noteId: 'p-a', tabs: [{ id: 't1', url: 'about:blank', title: 'docs' }], tab: 0, x: 76, y: 7, w: 46, h: 64, z: 4 },
    { id: 'nb', type: 'note', noteId: 'n-b', x: 160, y: 7, w: 34, h: 46, z: 5 },
  ], closed: [],
});
const disk = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8')).ws.find((w) => w.id === 'grp');
const rect = (c, sel) => c.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const press = async (c, x, y, modifiers = 0) => {
  await mouse(c, 'mouseMoved', x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers, pointerType: 'mouse' });
};
const dragFrom = async (c, x, y, dx, dy, modifiers = 0) => {
  await mouse(c, 'mouseMoved', x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers, pointerType: 'mouse' });
  for (let i = 1; i <= 10; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 10, y: y + (dy * i) / 10, button: 'left', buttons: 1, modifiers, pointerType: 'mouse' });
    await sleep(16);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1, modifiers, pointerType: 'mouse' });
};
const key = async (c, k, modifiers) => {
  const code = 'Key' + k.toUpperCase();
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: modifiers & SHIFT ? k.toUpperCase() : k, code, modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifiers & SHIFT ? k.toUpperCase() : k, code, modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
};
const geoOf = (c) => c.eval('Object.fromEntries(window.__flow.state().ws.find((w) => w.id === "grp").windows.map((w) => [w.id, { x: +w.x.toFixed(3), y: +w.y.toFixed(3) }]))');

await writeSeed();
fs.mkdirSync(W, { recursive: true });
resetState((doc) => { doc.ws = [seedWs(), { id: 'gk', name: 'keep', folder: W, bg: '#111', zones: [], notes: [], windows: [], closed: [], panUnit: '%' }]; doc.ui = { at: 'grp', hinted: true }; });
launch();
let c;
try {
  c = await flowWindow();
  await waitFor(() => c.eval('flow.term.exists("sh")'), 15000, 'shell');
  await sleep(800);
  const before = await geoOf(c);

  for (const id of ['sh', 'na', 'pa']) {
    const tb = await rect(c, `.win[data-id="${id}"] > .tb`);
    await press(c, tb.x + tb.w * 0.6, tb.cy, SHIFT);
    await sleep(80);
  }
  const sel = await c.eval('[...document.querySelectorAll(".win.gsel")].map((e) => e.dataset.id).sort()');
  check('shift-click on three title bars (a shell, a note and a page) selects exactly those three', JSON.stringify(sel) === '["na","pa","sh"]', JSON.stringify(sel));
  check('a shift-click selects without moving any window', JSON.stringify(await geoOf(c)) === JSON.stringify(before));

  await key(c, 'g', META);
  await sleep(300);
  const g = await c.eval('(window.__flow.state().ws.find((w) => w.id === "grp").groups || [])');
  check('⌘G makes one group of the three selected windows', g.length === 1 && JSON.stringify([...g[0].ids].sort()) === '["na","pa","sh"]', JSON.stringify(g));
  const frame = await rect(c, '.gframe');
  const shR = await rect(c, '.win[data-id="sh"]'), paR = await rect(c, '.win[data-id="pa"]'), nbR = await rect(c, '.win[data-id="nb"]');
  check('its frame encloses all three windows and not the fourth', frame && frame.x <= shR.x && frame.x + frame.w >= paR.x + paR.w && nbR.x > frame.x + frame.w,
    JSON.stringify({ frame, sh: shR.x, paEnd: paR.x + paR.w, nb: nbR.x }));
  const label = await rect(c, '.glabel');
  check('its name is readable while zoomed out (at least 20 px tall on screen)', label && label.h >= 20, JSON.stringify(label));

  await dragFrom(c, label.x + 30, label.cy, 120, 60);
  await sleep(500);
  const moved = await geoOf(c);
  const z = 0.4, dxPct = (120 / z / (await c.eval('document.getElementById("viewport").getBoundingClientRect().width'))) * 100;
  const shift = (id) => +(moved[id].x - before[id].x).toFixed(2);
  check('dragging the group name moves all three windows by the same amount', ['sh', 'na', 'pa'].every((id) => Math.abs(shift(id) - shift('sh')) < 0.05) && shift('sh') > 0,
    JSON.stringify({ sh: shift('sh'), na: shift('na'), pa: shift('pa') }));
  check('the move matches the hand at this zoom', Math.abs(shift('sh') - dxPct) < 2, `moved ${shift('sh')}% for ${dxPct.toFixed(2)}%`);
  check('the window outside the group did not move', moved.nb.x === before.nb.x && moved.nb.y === before.nb.y);

  const naTb = await rect(c, '.win[data-id="na"] > .tb');
  const naBefore = (await geoOf(c)).na, shBefore = (await geoOf(c)).sh;
  await dragFrom(c, naTb.x + naTb.w * 0.6, naTb.cy, 0, 90);
  await sleep(500);
  const one = await geoOf(c);
  const f2 = await rect(c, '.gframe'), na2 = await rect(c, '.win[data-id="na"]');
  check('one window dragged on its own moves only itself', one.na.y > naBefore.y && one.sh.x === shBefore.x && one.sh.y === shBefore.y);
  check('the frame grows to follow it', f2.y + f2.h >= na2.y + na2.h - 1, JSON.stringify({ frameBottom: f2.y + f2.h, noteBottom: na2.y + na2.h }));

  await sleep(500);
  check('the group is saved', (disk().groups || []).length === 1);
  check('no console errors so far', c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
  const kept = await geoOf(c);
  c.close(); c = null;
  await stop({ keepTmux: true });
  launch();
  c = await flowWindow();
  await sleep(1200);
  const back = await c.eval('(window.__flow.state().ws.find((w) => w.id === "grp").groups || [])');
  check('after a restart the group is still there with the same three windows', back.length === 1 && JSON.stringify([...back[0].ids].sort()) === '["na","pa","sh"]');
  check('and its frame is drawn again', !!(await rect(c, '.gframe')));

  const shTb = await rect(c, '.win[data-id="sh"] > .tb');
  await press(c, shTb.x + shTb.w * 0.6, shTb.cy);
  await key(c, 'g', META | SHIFT);
  await sleep(300);
  check('⇧⌘G with a grouped window in front takes the group apart', (await c.eval('(window.__flow.state().ws.find((w) => w.id === "grp").groups || []).length')) === 0 && !(await rect(c, '.gframe')));
  check('ungrouping leaves every window exactly where it was', JSON.stringify(await geoOf(c)) === JSON.stringify(kept));

  const v = await rect(c, '#viewport');
  // A box on bare board that touches the page and the last note but not the shell or the first note: from bare board
  // below the page and right of it (above the strip where the dock comes up), up and left into the page's lower right.
  const paNow = await rect(c, '.win[data-id="pa"]'), nbNow = await rect(c, '.win[data-id="nb"]'), naNow = await rect(c, '.win[data-id="na"]');
  const bare = await c.eval(`(() => { const vp = document.getElementById('viewport').getBoundingClientRect();
    for (let y = ${paNow.y + paNow.h} + 40; y < vp.bottom - 140; y += 10) { const x = ${nbNow.x + nbNow.w} + 20;
      const e = document.elementFromPoint(x, y); if (e && e.matches('.ws, .canvas')) return { x, y }; } return null; })()`);
  const ex = Math.max(naNow.x + naNow.w, paNow.x + paNow.w - 40), ey = nbNow.y + 20;
  await mouse(c, 'mouseMoved', bare.x, bare.y - 200);
  await sleep(400);
  await dragFrom(c, bare.x, bare.y, ex + 10 - bare.x, ey - bare.y, SHIFT);
  await sleep(200);
  const boxed = await c.eval('[...document.querySelectorAll(".win.gsel")].map((e) => e.dataset.id).sort()');
  check('a shift-drag on bare board draws a box that selects every window it touches', JSON.stringify(boxed) === '["nb","pa"]', JSON.stringify({ boxed, from: bare }));
  check('drawing the box moves nothing and does not pan', JSON.stringify(await geoOf(c)) === JSON.stringify(kept));
  // Esc in a terminal is the terminal's (it has the keys since its title bar was clicked); with the keys on the board it
  // clears the selection, and so does a plain click on bare board.
  const esc = async () => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
  };
  const count = () => c.eval('document.querySelectorAll(".win.gsel").length');
  await esc();
  check('Esc typed into a terminal stays the terminal\'s and keeps the selection', (await count()) === 2);
  await c.eval('document.activeElement.blur(), true');
  await esc();
  check('Esc on the board clears the selection', (await count()) === 0);
  await mouse(c, 'mouseMoved', bare.x, bare.y - 200);
  await dragFrom(c, bare.x, bare.y, ex + 10 - bare.x, ey - bare.y, SHIFT);
  await sleep(200);
  await press(c, bare.x, bare.y - 30);
  await sleep(100);
  check('a plain click on bare board clears the selection', (await count()) === 0);
  check('no console errors', c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
} catch (err) {
  check('the proof completes', false, err.stack || String(err));
} finally { if (c) c.close(); await stop(); }
console.log(failed ? `${failed} failed` : 'all passed');
if (failed) process.exitCode = 1;




