// Batch 8's menu items (page's tab keys and print, sept's Select All, the lead's 14:44 menu bar), in the real app:
//   - the File menu makes what the dock makes, in its order and words: agent, shell, team, note, page, sub-workspace;
//   - each item is in the menu with its key, the second keys and the numbered tabs as hidden items (their keys still
//     work); View has Arrange and no Float, Columns or Grid; Toggle Developer Tools is hidden and keeps its key;
//   - each sends its action to the Flow window it was used in, in order;
//   - Select All in a sign-in popup (a plain window) selects in that window and sends nothing to Flow;
//   - Undo and Redo are Flow's actions too (notes, batch 9): in a plain window they undo and redo there, and
//     flow.nativeEdit does the Flow window's own undo and redo, for app.js when no note has the keys.
//   node test/main-menu-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(L.USER_DATA + '-logs', 'main-menu-test.log');
const j = (v) => JSON.stringify(v);
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};
const kill = () => { for (const pid of L.electronPids()) { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };

const ITEMS = [
  // label, action, key, shown
  ['New Tab', 'new-page', 'Command+T', true],
  ['New Page', 'new-page-window', 'Alt+Command+P', true],
  ['New Sub-workspace', 'new-zone', '', true],
  ['Arrange', 'arrange', 'Control+Command+A', true],
  ['Reopen Closed Tab', 'tab-reopen', 'Shift+Command+T', true],
  ['Print…', 'page-print', 'Command+P', true],
  ['Select All', 'select-all', 'Command+A', true],
  ['Undo', 'undo', 'Command+Z', true],
  ['Redo', 'redo', 'Shift+Command+Z', true],
  ['Next Tab', 'tab-next', 'Shift+Command+]', true],
  ['Next Tab', 'tab-next', 'Control+Tab', false],
  ['Previous Tab', 'tab-prev', 'Shift+Command+[', true],
  ['Previous Tab', 'tab-prev', 'Control+Shift+Tab', false],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => [`Tab ${k}`, `tab-${k}`, `Command+${k}`, false]),
  ['Last Tab', 'tab-last', 'Command+9', false],
];

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
  await page.eval('window.__menus = []; window.flow.onMenu((a) => window.__menus.push(a)); return true;');
  const all = await mainp.eval(`const { Menu } = require('electron'); const out = [];
    const walk = (m) => { for (const i of m.items) { out.push({ label: i.label, key: i.accelerator || '', shown: i.visible, role: i.role || '', enabled: i.enabled }); if (i.submenu) walk(i.submenu); } };
    walk(Menu.getApplicationMenu()); return out;`, { commandLine: true });
  const missing = ITEMS.filter(([label, , key, shown]) => !all.some((i) => i.label === label && i.key === key && i.shown === shown));
  check('every new item is in the menu with its key, the second keys and numbered tabs hidden', missing.length === 0, j(missing));
  const file = await mainp.eval(`const { Menu } = require('electron'); return Menu.getApplicationMenu().items.find((i) => i.label === 'File').submenu.items.map((i) => i.label).filter(Boolean);`, { commandLine: true });
  check('the File menu makes what the dock makes, in its order and words', file.slice(0, 6).join() === 'New Agent,New Shell,New Team,New Note,New Page,New Sub-workspace', j(file));
  check('View has no Float, Columns or Grid, no New Zone is left, and no workspace switching keys (owner: gestures)', !all.some((i) => ['Float', 'Columns', 'Grid', 'New Zone', 'Next Workspace', 'Previous Workspace'].includes(i.label)),
    j(all.filter((i) => /Float|Columns|Grid|Zone|Workspace/.test(i.label))));
  check('Toggle Developer Tools is hidden and keeps ⌥⌘I', all.some((i) => /toggledevtools/i.test(i.role) && i.key === 'Alt+Command+I' && i.shown === false), j(all.filter((i) => /devtools/i.test(i.role))));
  check('Select All is Flow\'s action now, not the selectAll role', !all.some((i) => i.role === 'selectall' || i.role === 'selectAll'), j(all.filter((i) => /select/i.test(i.label + i.role))));
  check('Undo and Redo are Flow\'s actions, not the roles, and always enabled', !all.some((i) => /^(undo|redo)$/i.test(i.role)) &&
    ['Undo', 'Redo'].every((l) => all.some((i) => i.label === l && i.enabled)), j(all.filter((i) => /undo|redo/i.test(i.label + i.role))));
  for (const [label, , key] of ITEMS) {
    await mainp.eval(`const { Menu, BrowserWindow } = require('electron'); const find = (m) => { for (const i of m.items) { if (i.label === ${j(label)} && (i.accelerator || '') === ${j(key)}) return i; if (i.submenu) { const f = find(i.submenu); if (f) return f; } } return null; };
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/src/index.html')); find(Menu.getApplicationMenu()).click({}, w, w.webContents); return true;`, { commandLine: true });
    await L.sleep(150);
  }
  await L.sleep(300);
  const got = await page.eval('return window.__menus.splice(0);');
  check('each item sends its action to the Flow window, in order', j(got) === j(ITEMS.map((i) => i[1])), j(got));

  // a plain window, as a sign-in popup is: Select All selects in it
  const sel = await mainp.eval(`const { BrowserWindow, Menu } = require('electron');
    const w = new BrowserWindow({ width: 400, height: 200, show: true });
    await w.loadURL('data:text/html,<input id=f value="hello world">');
    await w.webContents.executeJavaScript('document.getElementById("f").focus(); document.getElementById("f").setSelectionRange(0, 0); true');
    const find = (m) => { for (const i of m.items) { if (i.label === 'Select All' && i.accelerator === 'Command+A') return i; if (i.submenu) { const f = find(i.submenu); if (f) return f; } } return null; };
    find(Menu.getApplicationMenu()).click({}, w, w.webContents);
    await new Promise((r) => setTimeout(r, 400));
    const s = await w.webContents.executeJavaScript('const f = document.getElementById("f"); [f.selectionStart, f.selectionEnd]');
    w.destroy(); return s;`, { commandLine: true, timeout: 30000 });
  await L.sleep(300);
  const leaked = await page.eval('return window.__menus.splice(0);');
  check('Select All in a plain window selects its field and sends nothing to Flow', j(sel) === j([0, 11]) && leaked.length === 0, `selection ${j(sel)}, Flow got ${j(leaked)}`);

  // Undo and Redo in a plain window act there
  const ur = await mainp.eval(`const { BrowserWindow, Menu } = require('electron');
    const w = new BrowserWindow({ width: 400, height: 200, show: true });
    await w.loadURL('data:text/html,<input id=f>');
    await w.webContents.executeJavaScript('document.getElementById("f").focus(); true');
    w.webContents.insertText('abc');
    await new Promise((r) => setTimeout(r, 300));
    const find = (label) => { const walk = (m) => { for (const i of m.items) { if (i.label === label) return i; if (i.submenu) { const f = walk(i.submenu); if (f) return f; } } return null; }; return walk(Menu.getApplicationMenu()); };
    const value = () => w.webContents.executeJavaScript('document.getElementById("f").value');
    const typed = await value();
    find('Undo').click({}, w, w.webContents);
    await new Promise((r) => setTimeout(r, 400));
    const undone = await value();
    find('Redo').click({}, w, w.webContents);
    await new Promise((r) => setTimeout(r, 400));
    const redone = await value();
    w.destroy(); return [typed, undone, redone];`, { commandLine: true, timeout: 30000 });
  await L.sleep(300);
  const leaked2 = await page.eval('return window.__menus.splice(0);');
  check('Undo and Redo in a plain window undo and redo there and send nothing to Flow', j(ur) === j(['abc', '', 'abc']) && leaked2.length === 0, `${j(ur)}, Flow got ${j(leaked2)}`);

  // flow.nativeEdit: the Flow window's own undo and redo
  await page.eval('const i = document.createElement("input"); i.id = "__ne"; document.body.appendChild(i); i.focus(); return document.activeElement === i;');
  await mainp.eval(`const { BrowserWindow } = require('electron'); BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/src/index.html')).webContents.insertText('xyz'); return true;`, { commandLine: true });
  await L.sleep(300);
  const ne = [await page.eval('return document.getElementById("__ne").value;')];
  await page.eval('window.flow.nativeEdit("undo"); return true;');
  await L.sleep(400);
  ne.push(await page.eval('return document.getElementById("__ne").value;'));
  await page.eval('window.flow.nativeEdit("redo"); return true;');
  await L.sleep(400);
  ne.push(await page.eval('const i = document.getElementById("__ne"); const v = i.value; i.remove(); return v;'));
  check('flow.nativeEdit undoes and redoes in the Flow window itself', j(ne) === j(['xyz', '', 'xyz']), j(ne));
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




