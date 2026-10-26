// Owner image 02-03 (Nov 7) as a real overview: "zoom out a workspace to be like this", with groups, "go to different
// things" as on a Miro board. Real pointer and key input over CDP on overview's isolated Flow (port 9581, socket
// flow-dev-overview). A workspace of three named groups spread wider than the screen, at 100%:
//  - ⇧1 on the board (or "see whole workspace" in its menu) glides out until every window and every group name is on
//    screen, each name readable;
//  - a click on a group's name flies to that group: it fills the screen, never past 100%; a click on another name
//    from the overview flies there instead;
//  - ⇧1 typed into a note types "!" and moves nothing; a group name's drag still moves the group, not the view;
//  - the view reached is saved and comes back after a restart.
//   node test/overview-see-all.mjs      exit 1 on any failed check
import fs from 'node:fs';
import { launch, stop, flowWindow, writeSeed, resetState, mouse, sleep, waitFor, shot, USER_DATA } from './overview-lib.mjs';
import path from 'node:path';
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const W = '/tmp/flow-dev-overview/work/sa';
const note = (id, x, y) => ({ id: `w-${id}`, type: 'note', noteId: `n-${id}`, x, y, w: 34, h: 46 });
const layout = [['a1', 2, 8], ['a2', 38, 8], ['b1', 130, 8], ['b2', 166, 8], ['b3', 130, 58], ['c1', 260, 60], ['c2', 296, 60], ['lone', 60, 70]];
const seed = () => ({
  id: 'sa', name: 'see all', folder: W, bg: '#141319', zones: [], panUnit: '%', zoom: 1, pan: 0, panY: 0,
  notes: layout.map(([k]) => ({ id: `n-${k}`, kind: 'note', title: k, body: k })),
  windows: layout.map(([k, x, y]) => note(k, x, y)), closed: [],
  groups: [
    { id: 'grp-research', name: 'research', zone: null, ids: ['w-a1', 'w-a2'] },
    { id: 'grp-build', name: 'build', zone: null, ids: ['w-b1', 'w-b2', 'w-b3'] },
    { id: 'grp-ship', name: 'ship', zone: null, ids: ['w-c1', 'w-c2'] },
  ],
});
const SHIFT = 8;
const vp = (c) => c.eval('(() => { const r = document.getElementById("viewport").getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()');
const rectOf = (c, sel) => c.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const label = (c, name) => c.eval(`(() => { const e = [...document.querySelectorAll('.glabel')].find((x) => x.textContent === ${JSON.stringify(name)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + Math.min(60, r.width / 2), cy: r.top + r.height / 2 }; })()`);
const zoom = (c) => c.eval('window.__flow.state().ws.find((w) => w.id === "sa").zoom || 1');
const geo = (c) => c.eval('JSON.stringify(window.__flow.state().ws.find((w) => w.id === "sa").windows.map((w) => [w.id, +w.x.toFixed(3), +w.y.toFixed(3)]))');
const inView = async (c, sel) => { const v = await vp(c), r = await rectOf(c, sel); return !!r && r.x >= v.l - 1 && r.y >= v.t - 1 && r.x + r.w <= v.r + 1 && r.y + r.h <= v.b + 1; };
const groupInView = async (c, ids) => { for (const id of ids) if (!(await inView(c, `.win[data-id="${id}"]`))) return false; return true; };
const shift1 = async (c) => {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '!', code: 'Digit1', text: '!', modifiers: SHIFT, windowsVirtualKeyCode: 49 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '!', code: 'Digit1', modifiers: SHIFT, windowsVirtualKeyCode: 49 });
};
const settle = async (c) => { await sleep(700); };
const bare = (c) => c.eval(`(() => { const vp = document.getElementById('viewport').getBoundingClientRect();
  for (let y = vp.top + 120; y < vp.bottom - 140; y += 15) for (let x = vp.left + 40; x < vp.right - 60; x += 15) {
    const e = document.elementFromPoint(x, y); if (e && e.matches('.ws, .canvas')) return { x, y }; } return null; })()`);
const clickAt = async (c, x, y) => { await mouse(c, 'mouseMoved', x, y); await mouse(c, 'mousePressed', x, y); await mouse(c, 'mouseReleased', x, y); };

await writeSeed();
fs.mkdirSync(W, { recursive: true });
resetState((doc) => { doc.ws = [seed(), { id: 'sk', name: 'keep', folder: W, bg: '#111', zones: [], notes: [], windows: [], closed: [], panUnit: '%' }]; doc.ui = { at: 'sa', hinted: true }; });
launch();
let c;
try {
  c = await flowWindow();
  await sleep(900);
  const g0 = await geo(c);
  check('at 100% the three groups do not all fit on screen', !(await groupInView(c, ['w-c1', 'w-c2'])));

  const spot = await bare(c);
  await clickAt(c, spot.x, spot.y);
  await shift1(c);
  await settle(c);
  const z1 = await zoom(c);
  const all = [];
  for (const [k] of layout) all.push(await inView(c, `.win[data-id="w-${k}"]`));
  check('⇧1 on the board zooms out until every window is on screen', all.every(Boolean) && z1 < 1, `zoom ${z1.toFixed(3)}, in view ${all.filter(Boolean).length}/${all.length}`);
  const names = [];
  for (const n of ['research', 'build', 'ship']) { const l = await label(c, n); names.push(l && l.h >= 20 && l.y >= (await vp(c)).t - 1 ? 'ok' : JSON.stringify(l)); }
  check('every group is named on screen, each name readable (at least 20 px tall)', names.every((x) => x === 'ok'), names.join(' '));
  check('zooming out moves no window', (await geo(c)) === g0);
  fs.mkdirSync(path.join(USER_DATA, 'see-all'), { recursive: true });
  await shot(c, path.join(USER_DATA, 'see-all', 'whole-workspace.png'));

  const build = await label(c, 'build');
  await clickAt(c, build.cx, build.cy);
  await settle(c);
  const zb = await zoom(c);
  check('a click on "build" flies to that group: it fills the screen', (await groupInView(c, ['w-b1', 'w-b2', 'w-b3'])) && zb > z1, `zoom ${z1.toFixed(3)} -> ${zb.toFixed(3)}`);
  const bf = await c.eval(`(() => { const f = document.querySelector('.gframe[data-group="grp-build"]').getBoundingClientRect(); const v = document.getElementById('viewport').getBoundingClientRect(); return { fw: f.width / v.width, fh: f.height / v.height }; })()`);
  check('it fills the screen in at least one direction', Math.max(bf.fw, bf.fh) > 0.8, JSON.stringify(bf));
  check('the click on the name moved no window', (await geo(c)) === g0);

  await shift1(c);
  await settle(c);
  const ship = await label(c, 'ship');
  await clickAt(c, ship.cx, ship.cy);
  await settle(c);
  check('back out with ⇧1, a click on "ship" flies there instead', await groupInView(c, ['w-c1', 'w-c2']) && !(await groupInView(c, ['w-a1'])));

  // a small group flies in at no more than 100%
  await shift1(c);
  await settle(c);
  const research = await label(c, 'research');
  await clickAt(c, research.cx, research.cy);
  await settle(c);
  check('flying to a group never zooms past 100%', (await zoom(c)) <= 1.0001, `zoom ${await zoom(c)}`);

  // the board's own menu does the same as ⇧1
  const spot2 = await bare(c);
  await mouse(c, 'mouseMoved', spot2.x, spot2.y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot2.x, y: spot2.y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot2.x, y: spot2.y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  const item = await waitFor(() => c.eval(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => x.textContent.startsWith('see whole workspace')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`), 3000, 'the menu item');
  await clickAt(c, item.x, item.y);
  await settle(c);
  const viaMenu = [];
  for (const [k] of layout) viaMenu.push(await inView(c, `.win[data-id="w-${k}"]`));
  check('"see whole workspace" in the board\'s menu shows every window too', viaMenu.every(Boolean));
  const zAll = await zoom(c);

  // dragging a group name still moves the group, and does not fly
  const shipNow = await label(c, 'ship');
  await mouse(c, 'mouseMoved', shipNow.cx, shipNow.cy);
  await mouse(c, 'mousePressed', shipNow.cx, shipNow.cy);
  for (let i = 1; i <= 8; i++) { await mouse(c, 'mouseMoved', shipNow.cx + i * 6, shipNow.cy + i * 3, { down: true }); await sleep(16); }
  await mouse(c, 'mouseReleased', shipNow.cx + 48, shipNow.cy + 24);
  await settle(c);
  const moved = JSON.parse(await geo(c)), was = JSON.parse(g0);
  const dx = moved.find((w) => w[0] === 'w-c1')[1] - was.find((w) => w[0] === 'w-c1')[1];
  check('dragging a group name moves the group and does not fly', dx > 0 && Math.abs((await zoom(c)) - zAll) < 1e-6, `dx ${dx.toFixed(2)}%, zoom ${zAll.toFixed(3)} -> ${(await zoom(c)).toFixed(3)}`);

  // ⇧1 typed into a note is a "!"
  const nb = await rectOf(c, '.win[data-id="w-lone"] .nbody');
  await clickAt(c, nb.cx, nb.cy);
  await sleep(150);
  const z2 = await zoom(c);
  await shift1(c);
  await sleep(300);
  const body = await c.eval('window.__flow.state().ws.find((w) => w.id === "sa").notes.find((n) => n.id === "n-lone").body');
  check('⇧1 typed into a note types "!" and the view does not move', body.includes('!') && (await zoom(c)) === z2, JSON.stringify({ body, z2, now: await zoom(c) }));

  const kept = await zoom(c);
  await sleep(500);
  c.close(); c = null;
  await stop({ keepTmux: true });
  launch();
  c = await flowWindow();
  await sleep(1000);
  check('the zoomed-out view and the groups come back after a restart', Math.abs((await zoom(c)) - kept) < 1e-6 && (await c.eval('document.querySelectorAll(".glabel").length')) === 3);
  check('no console errors', c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
} catch (err) {
  check('the proof completes', false, err.stack || String(err));
} finally { if (c) c.close(); await stop(); }
console.log(failed ? `${failed} failed` : 'all passed');
if (failed) process.exitCode = 1;




