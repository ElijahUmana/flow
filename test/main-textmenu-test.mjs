// Right-click on text in Flow itself (the lead, batch 9: notes, titles, the address bar, search, terminals) gives the
// Mac's text menu from main, wherever app.js leaves the right-click to Chromium. In the real app, with real
// right-clicks on fields of the Flow window (outside its windows, where app.js shows menus of its own):
//   - in a field with its text selected: Cut, Copy, Paste; Copy copies it;
//   - in an empty field: Paste pastes it, Cut and Copy are off;
//   - on selected text that cannot be edited: Copy alone; on text not selected that cannot be edited: no menu;
//   - a misspelled word (Chromium's spelling, given as the event gives it; this VM has no dictionary): its suggestions
//     and Add to Dictionary come first, and a suggestion replaces the word;
//   - flow.menu.popup (sept's terminal menu): the renderer's own items at the pointer, the chosen id back, null when
//     dismissed.
// Menus are recorded instead of shown (Menu.popup is replaced in main).
//   node test/main-textmenu-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(L.USER_DATA + '-logs', 'main-textmenu-test.log');
const j = (v) => JSON.stringify(v);
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};
const kill = () => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const FLOW = "require('electron').BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/src/index.html'))";

async function run() {
  kill();
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), j({ v: 11, ws: [{ id: 'w', name: 'w', folder: L.USER_DATA, bg: '#141319', zones: [], notes: [], windows: [], closed: [], saved: [] }], ui: { at: 'w' } }));
  L.launch(LOG);
  const page = await L.flowPage();
  const mainp = await L.mainProcess();
  await mainp.eval(`const { Menu } = require('electron'); globalThis.__shown = [];
    Menu.prototype.popup = function (o) { globalThis.__shown.push(this.items.map((i) => ({ label: i.label, enabled: i.enabled, type: i.type }))); globalThis.__last = this; globalThis.__lastOpts = o || {}; };
    return true;`, { commandLine: true });
  await page.eval(`const box = document.createElement('div'); box.id = 'tm';
    box.style.cssText = 'position:fixed;left:120px;top:120px;z-index:2147483647;background:#fff;padding:8px;font:20px monospace;color:#000';
    box.innerHTML = '<input id="tm-a" value="alpha beta" style="font:20px monospace;width:300px"><br><input id="tm-b" style="font:20px monospace;width:300px"><p id="tm-p">plain words here</p>';
    document.body.appendChild(box); return true;`);
  const rightClick = async (sel) => {
    const p = await page.eval(`const b = document.querySelector(${j(sel)}).getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
    }
    await L.sleep(700);
    return mainp.eval('const s = globalThis.__shown.splice(0); return s;', { commandLine: true });
  };
  const choose = (label) => mainp.eval(`globalThis.__last.items.find((i) => i.label === ${j(label)}).click(); return true;`, { commandLine: true });
  const items = (menus) => (menus[0] || []).map((i) => (i.type === 'separator' ? '-' : `${i.label}${i.enabled ? '' : ' (off)'}`));

  await mainp.eval("require('electron').clipboard.writeText(''); return true;", { commandLine: true });
  await page.eval('const a = document.getElementById("tm-a"); a.focus(); a.select(); return true;');
  const m1 = await rightClick('#tm-a');
  check('a right-click in a field with its text selected gives Cut, Copy, Paste', j(items(m1)) === j(['Cut', 'Copy', 'Paste (off)']), j(m1));
  if (m1.length) await choose('Copy');
  await L.sleep(300);
  const copied = await mainp.eval("return require('electron').clipboard.readText();", { commandLine: true });
  check('and its Copy copies the selection', copied === 'alpha beta', j(copied));

  await page.eval('document.getElementById("tm-b").focus(); return true;');
  const m2 = await rightClick('#tm-b');
  check('in an empty field: Paste, with Cut and Copy off', j(items(m2)) === j(['Cut (off)', 'Copy (off)', 'Paste']), j(m2));
  if (m2.length) await choose('Paste');
  await L.sleep(300);
  check('and its Paste pastes into the field', (await page.eval('return document.getElementById("tm-b").value;')) === 'alpha beta');

  await page.eval('document.activeElement.blur(); getSelection().selectAllChildren(document.getElementById("tm-p")); return true;');
  const m3 = await rightClick('#tm-p');
  check('on selected text that cannot be edited: Copy alone', j(items(m3)) === j(['Copy']), j(m3));
  await page.eval('getSelection().removeAllRanges(); return true;');
  const m4 = await rightClick('#tm-p');
  check('on text that cannot be edited and is not selected: no menu', m4.length === 0, j(m4));

  await mainp.eval(`const wc = ${FLOW}.webContents; globalThis.__replaced = [];
    wc.replaceMisspelling = (w) => globalThis.__replaced.push(w);
    wc.emit('context-menu', {}, { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten'], selectionText: '',
      editFlags: { canCut: false, canCopy: false, canPaste: true } }); return true;`, { commandLine: true });
  await L.sleep(300);
  const m5 = await mainp.eval('return globalThis.__shown.splice(0);', { commandLine: true });
  check('a misspelled word: its suggestions and Add to Dictionary first, then Cut, Copy, Paste',
    j(items(m5)) === j(['the', 'tea', 'ten', 'Add to Dictionary', '-', 'Cut (off)', 'Copy (off)', 'Paste']), j(m5));
  if (m5.length) await choose('the');
  check('and a suggestion replaces the word', j(await mainp.eval('return globalThis.__replaced;', { commandLine: true })) === j(['the']));

  const pick = page.eval('return await window.flow.menu.popup([{ id: "copy", label: "Copy", enabled: false }, { type: "separator" }, { id: "paste", label: "Paste" }], { x: 40, y: 50 });')
    .catch((e) => `error: ${e.message}`);
  await L.sleep(500);
  const m6 = await mainp.eval('return { shown: globalThis.__shown.splice(0), x: globalThis.__lastOpts.x, y: globalThis.__lastOpts.y };', { commandLine: true });
  if (m6.shown.length) await mainp.eval("globalThis.__last.items.find((i) => i.label === 'Paste').click(); globalThis.__lastOpts.callback(); return true;", { commandLine: true });
  const chosen = await pick;
  check('flow.menu.popup shows the renderer\'s items at the pointer and gives the chosen id', j(items(m6.shown)) === j(['Copy (off)', '-', 'Paste']) && m6.x === 40 && m6.y === 50 && chosen === 'paste',
    `${j(m6)} chose ${j(chosen)}`);
  const pick2 = page.eval('return await window.flow.menu.popup([{ id: "a", label: "A" }], { x: 1, y: 1 });').catch((e) => `error: ${e.message}`);
  await L.sleep(500);
  if ((await mainp.eval('return globalThis.__shown.splice(0).length;', { commandLine: true })) > 0) await mainp.eval('globalThis.__lastOpts.callback(); return true;', { commandLine: true });
  const none = await pick2;
  check('dismissed, it gives null', none === null, j(none));
  page.close();
  mainp.close();
}

console.log(`app log: ${LOG}`);
run().catch((e) => { failed++; console.log(`FAIL the test stopped: ${e.stack || e.message}`); }).finally(() => {
  kill();
  try { fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch (e) { console.log(`cleanup: ${e.message}`); }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
});




