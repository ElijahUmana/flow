// Owner 02/10 (Nov 7, image 02-03): zoomed out, a new item must not come out tiny. MAC_NOTES 54: readable where it is
// made, no forced zoom-in. Real pointer and key input over CDP on overview's isolated Flow (port 9581, socket
// flow-dev-overview). At 33%: right-click bare board, "new note"; it is drawn at actual size over where it was made and
// takes the typing; the board's zoom, pan and every other window stay; a click away settles it at its place, the same
// scale as its neighbours; pinching back to 100% shows it at its usual size, never over-zoomed; at 100% nothing changes.
//   node test/overview-zoomed-create.mjs      exit 1 on any failed check
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, launch, stop, flowWindow, writeSeed, resetState, mouse, sleep, waitFor, USER_DATA } from './overview-lib.mjs';
/* The owner's finger map (MAC_NOTES 60): a pinch zooms the board only with three fingers down. main tells the window
   how many fingers are on the trackpad ('fingers' { n, t }); with the inspector on main this test does the same. */
const MAIN = 9683;
const mainEval = async (expression) => {
  const t = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${MAIN}/json/list`)).json())[0], 30000, 'main inspector');
  const m = await Cdp.connect(t.webSocketDebuggerUrl);
  try { return await m.eval(expression); } finally { m.close(); }
};
const fingers = (n) => mainEval(`(() => { const { BrowserWindow } = process.mainModule.require('electron');
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('fingers', { n: ${n}, t: Date.now() }); return true; })()`);
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const W = '/tmp/flow-dev-overview/work/zc';
const note = (id, x, y) => ({ id: `w-${id}`, type: 'note', noteId: `n-${id}`, x, y, w: 34, h: 46 });
const seed = (zoom) => ({ id: 'zc', name: 'zoomed', folder: W, bg: '#141319', zones: [], panUnit: '%', zoom, pan: 0, panY: -16,
  notes: ['a', 'b', 'c', 'd', 'e'].map((k) => ({ id: `n-${k}`, kind: 'note', title: k, body: k })),
  windows: [note('a', 1.2, 6.6), note('b', 37, 6.6), note('c', 73, 6.6), note('d', 1.2, 55), note('e', 37, 55)], closed: [] });
const disk = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, 'flow-state.json'), 'utf8')).ws.find((w) => w.id === 'zc');
const box = (c, id) => c.eval(`(() => { const e = document.querySelector('.win[data-id="${id}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const fontPx = (c, id) => c.eval(`(() => { const e = document.querySelector('.win[data-id="${id}"] .ntitle, .win[data-id="${id}"] .nbody'); if (!e) return 0; const r = e.getBoundingClientRect(); return +(parseFloat(getComputedStyle(e).fontSize) * r.height / e.offsetHeight).toFixed(2); })()`);
const others = (c) => c.eval('JSON.stringify(window.__flow.state().ws.find((w) => w.id === "zc").windows.filter((w) => /^w-[a-e]$/.test(w.id)).map((w) => [w.id, w.x, w.y, w.w, w.h]))');
const view = (c) => c.eval('(() => { const w = window.__flow.state().ws.find((x) => x.id === "zc"); return [w.zoom, +(w.pan || 0).toFixed(4), +(w.panY || 0).toFixed(4)]; })()');
const rightClickNew = async (c, x, y, label) => {
  await mouse(c, 'mouseMoved', x, y);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  const b = await waitFor(() => c.eval(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => x.textContent.startsWith(${JSON.stringify(label)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`), 3000, 'the menu');
  await mouse(c, 'mouseMoved', b.x, b.y);
  await mouse(c, 'mousePressed', b.x, b.y);
  await mouse(c, 'mouseReleased', b.x, b.y);
};
const newest = (c, before) => c.eval(`window.__flow.state().ws.find((w) => w.id === "zc").windows.map((w) => w.id).find((id) => !${JSON.stringify(before)}.includes(id)) || ''`);
const bare = (c) => c.eval(`(() => { const vp = document.getElementById('viewport').getBoundingClientRect();
  for (let y = vp.top + vp.height * 0.55; y < vp.bottom - 120; y += 10) for (let x = vp.left + vp.width * 0.55; x < vp.right - 60; x += 10) {
    const e = document.elementFromPoint(x, y); if (e && e.matches('.ws, .canvas')) return { x, y }; } return null; })()`);

await writeSeed();
fs.mkdirSync(W, { recursive: true });
const grant = async (c) => c.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
for (const zoom of [0.33, 1]) {
  resetState((doc) => { doc.ws = [seed(zoom), { id: 'zk', name: 'keep', folder: W, bg: '#111', zones: [], notes: [], windows: [], closed: [], panUnit: '%' }]; doc.ui = { at: 'zc', hinted: true }; });
  launch({ inspect: MAIN });
  let c;
  try {
    c = await flowWindow();
    await grant(c);
    await sleep(900);
    const at = await bare(c);
    const ids0 = await c.eval('window.__flow.state().ws.find((w) => w.id === "zc").windows.map((w) => w.id)');
    const v0 = await view(c), o0 = await others(c);
    const neighbour = await box(c, 'w-b');
    await rightClickNew(c, at.x, at.y, 'new note');
    const id = await waitFor(() => newest(c, ids0), 3000, 'the new note');
    await sleep(450);
    const made = await box(c, id), model = await c.eval(`window.__flow.state().ws.find((w) => w.id === "zc").windows.find((w) => w.id === ${JSON.stringify(id)})`);
    const vw = await c.eval('document.getElementById("viewport").getBoundingClientRect().width');
    const usual = (model.w / 100) * vw;
    const tag = `at ${Math.round(zoom * 100)}%`;
    if (zoom < 1) {
      check(`${tag}: a note made from the board's menu is drawn at actual size, readable, not tiny`, Math.abs(made.w - usual) < 2, `${Math.round(made.w)} px wide on screen, usual ${Math.round(usual)} px; neighbour ${Math.round(neighbour.w)} px`);
      check(`${tag}: its text is at its usual size on screen`, (await fontPx(c, id)) >= 12, `${await fontPx(c, id)} px`);
      const vp = await c.eval('(() => { const r = document.getElementById("viewport").getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()');
      check(`${tag}: it is wholly on screen`, made.x >= vp.l && made.y >= vp.t && made.x + made.w <= vp.r && made.y + made.h <= vp.b, JSON.stringify(made));
      check(`${tag}: it is made at its usual size in the board, where the click was`, Math.abs(model.w - 34) < 0.01 && Math.abs(model.h - 46) < 0.01, JSON.stringify([model.x, model.y, model.w, model.h]));
      check(`${tag}: the board does not zoom in or pan`, JSON.stringify(await view(c)) === JSON.stringify(v0), `${JSON.stringify(v0)} -> ${JSON.stringify(await view(c))}`);
      const o1 = await others(c);
      check(`${tag}: no other window moves`, o1 === o0, o1 === o0 ? '' : `${o0}\n  -> ${o1}`);
      const typed = 'typed while zoomed out';
      for (const ch of typed) await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
      await sleep(300);
      const title = await c.eval(`window.__flow.state().ws.find((w) => w.id === "zc").notes.find((n) => n.id === window.__flow.state().ws.find((w) => w.id === "zc").windows.find((w) => w.id === ${JSON.stringify(id)}).noteId).title`);
      check(`${tag}: it takes the typing at once`, title === typed, JSON.stringify(title));
      const away = await bare(c);
      await mouse(c, 'mouseMoved', away.x - 300, away.y - 200);
      await mouse(c, 'mousePressed', away.x - 300, away.y - 200);
      await mouse(c, 'mouseReleased', away.x - 300, away.y - 200);
      await sleep(500);
      const settled = await box(c, id);
      check(`${tag}: a click elsewhere settles it into its place at the board's scale`, Math.abs(settled.w - neighbour.w) < 1.5, `${Math.round(settled.w)} px, neighbour ${Math.round(neighbour.w)} px`);
      check(`${tag}: settling keeps it where it was made`, JSON.stringify(await c.eval(`(() => { const w = window.__flow.state().ws.find((x) => x.id === "zc").windows.find((w) => w.id === ${JSON.stringify(id)}); return [w.x, w.y, w.w, w.h]; })()`)) === JSON.stringify([model.x, model.y, model.w, model.h]));
      await sleep(400);
      const saved = disk().windows.find((w) => w.id === id);
      check(`${tag}: what is saved is its usual place and size, no zoom of its own`, saved && saved.w === model.w && saved.h === model.h && !('transform' in saved) && !('lens' in saved));
      // pinch back to 100% around the middle of the view: the note comes back at its usual size, never larger
      const mid = await c.eval('(() => { const r = document.getElementById("viewport").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
      await fingers(3);
      for (let i = 0; i < 40 && (await view(c))[0] < 1; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: 0, deltaY: -12, modifiers: 2, pointerType: 'mouse' });
      await fingers(0);
      await sleep(600);
      const at100 = await box(c, id), z100 = (await view(c))[0];
      check(`${tag}: pinched back to 100%, it is at its usual size, never over-zoomed`, z100 === 1 && Math.abs(at100.w - usual) < 2, `zoom ${z100}, ${Math.round(at100.w)} px, usual ${Math.round(usual)} px`);
      const zout = async () => { await fingers(3); for (let i = 0; i < 60 && (await view(c))[0] > 0.34; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: 0, deltaY: 12, modifiers: 2, pointerType: 'mouse' }); await fingers(0); await sleep(600); };
      // a note carried out of the dock and let go lands on the outline the hand was shown, at the board's scale (lead,
      // Nov 2 19:2x): the hand chose its size there, so it is not drawn readable over it
      await zout();
      const ids1 = await c.eval('window.__flow.state().ws.find((w) => w.id === "zc").windows.map((w) => w.id)');
      const vpr = await c.eval('(() => { const r = document.getElementById("viewport").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
      await mouse(c, 'mouseMoved', vpr.x + vpr.w / 2, vpr.y + vpr.h - 6);
      await sleep(600);
      const nbtn = await c.eval(`(() => { const e = document.querySelector('#dock button[data-k="note"]'); const b = e && e.getBoundingClientRect(); return b && b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`);
      const drop = await bare(c);
      await mouse(c, 'mouseMoved', nbtn.x, nbtn.y);
      await mouse(c, 'mousePressed', nbtn.x, nbtn.y);
      for (let i = 1; i <= 12; i++) await mouse(c, 'mouseMoved', nbtn.x + ((drop.x - nbtn.x) * i) / 12, nbtn.y + ((drop.y - nbtn.y) * i) / 12, { down: true });
      await sleep(300);
      const outline = await c.eval(`(() => { const v = document.getElementById('viewport'), g = [...v.children].find((e) => /dashed/.test(e.style.border + e.style.borderStyle) && e.style.display !== 'none'); if (!g) return null; const r = g.getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
      await mouse(c, 'mouseReleased', drop.x, drop.y);
      await sleep(900);
      const did = await newest(c, ids1), dbox = did && (await box(c, did));
      check(`at ${Math.round((await view(c))[0] * 100)}%: a note carried out of the dock lands on the outline shown, not enlarged`, !!dbox && !!outline && Math.abs(dbox.w - outline.w) < 1.5,
        JSON.stringify({ outline, box: dbox }));
      await mouse(c, 'mouseMoved', drop.x - 300, drop.y - 200); await mouse(c, 'mousePressed', drop.x - 300, drop.y - 200); await mouse(c, 'mouseReleased', drop.x - 300, drop.y - 200);
      await sleep(300);
      // a shell made from the dock at this zoom: typing and a drag-selection land on the cells under the hand, as at 100%
      await zout();
      const sid = await c.eval('window.__flow.spawn("shell")');
      await waitFor(() => c.eval(`flow.term.exists(${JSON.stringify(sid)})`), 15000, 'the shell');
      await sleep(1200);
      const sz = (await view(c))[0], sbox = await box(c, sid), smodel = await c.eval(`window.__flow.state().ws.find((w) => w.id === "zc").windows.find((w) => w.id === ${JSON.stringify(sid)})`);
      check(`at ${Math.round(sz * 100)}%: a shell made from the dock is drawn at actual size`, Math.abs(sbox.w - (smodel.w / 100) * vw) < 2, `${Math.round(sbox.w)} px`);
      for (const ch of 'clear; echo ABCDEFGHIJKLMNOP\r') await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch === '\r' ? 'Enter' : ch, text: ch });
      await sleep(900);
      const g = await c.eval(`(() => { const s = document.querySelector('.win[data-id="${sid}"] .xterm-screen').getBoundingClientRect(); const t = window.__flow.term("${sid}");
        const rows = [...document.querySelectorAll('.win[data-id="${sid}"] .xterm-rows > div')]; const r = rows.find((x) => x.textContent.startsWith('ABCDEFGH')); const b = r && r.getBoundingClientRect();
        return b ? { l: s.left, w: s.width, cols: t.cols, y: b.top + b.height / 2 } : null; })()`);
      check(`at ${Math.round(sz * 100)}%: what is typed reaches the shell`, !!g);
      if (g) {
        // from the middle of cell 2 to the middle of cell 5 of "ABCDEFGH...": C, D, E, F, as at 100% (xterm takes the cell
        // the release lands in once past its middle)
        const x0 = g.l + (g.w / g.cols) * 2.5, x1 = g.l + (g.w / g.cols) * 5.5;
        await mouse(c, 'mouseMoved', x0, g.y);
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: g.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
        for (let i = 1; i <= 6; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 6, y: g.y, button: 'left', buttons: 1, pointerType: 'mouse' }); await sleep(16); }
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: g.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
        await sleep(400);
        // a selection is copied on release (term.js copy): what reached the clipboard is exactly what the hand covered
        const got = await c.eval('navigator.clipboard.readText().catch(() => "")');
        check(`at ${Math.round(sz * 100)}%: a drag over its text selects exactly the cells under the hand`, got === 'CDEF', JSON.stringify(got));
      }
    } else {
      check(`${tag}: at actual size a new note is unchanged (no lens, no transform)`, Math.abs(made.w - usual) < 2 && (await c.eval(`document.querySelector('.win[data-id="${id}"]').style.transform`)) === '');
      check(`${tag}: the board does not move`, JSON.stringify(await view(c)) === JSON.stringify(v0));
    }
    check(`${tag}: no console errors`, c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
  } catch (err) {
    check(`the ${zoom} proof completes`, false, err.stack || String(err));
  } finally { if (c) c.close(); await stop(); }
}
console.log(failed ? `${failed} failed` : 'all passed');
if (failed) process.exitCode = 1;




