// browse: the batch-3 parts of the browser walk, with real input on the Flow window: ✂ only while text is selected,
// a file tab showing its path, switching tabs (address, title, note follow the shown tab), a page whose first address
// is a download (item 32), and a page's highlight after a restart. Prints one line per step and saves screenshots.
// usage: test/browse-app.sh reset && test/browse-app.sh start && node test/browse-walk3.mjs <shots-dir>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const SHOTS = process.argv[2] || '/tmp/browse-walk3';
fs.mkdirSync(SHOTS, { recursive: true });
const APP = new URL('./browse-app.sh', import.meta.url).pathname;
let nos = 0;
const step = (name, ok, detail = '') => { if (!ok) nos++; console.log(`${ok ? 'ok  ' : 'NO  '} ${name}${detail ? `  (${detail})` : ''}`); };
let host;
async function connect() {
  host = await Cdp.connect((await waitFor(async () => (await targets(9571)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 40000, 'the Flow window')).webSocketDebuggerUrl);
  await waitFor(() => host.eval('return !!(window.__flow && window.__flow.ready);'), 40000, 'window.__flow');
  await host.eval('await window.__flow.ready; return true;');
}
await connect();
const shot = async (name) => { const r = await host.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64')); };
const ev = (p) => host.send('Input.dispatchMouseEvent', { pointerType: 'mouse', ...p });
async function click(x, y) {
  await ev({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await ev({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await ev({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function drag(x0, x1, y) {
  await ev({ type: 'mouseMoved', x: x0, y, button: 'none', buttons: 0 });
  await ev({ type: 'mousePressed', x: x0, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await ev({ type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 10, y, button: 'left', buttons: 1 }); await sleep(15); }
  await ev({ type: 'mouseReleased', x: x1, y, button: 'left', buttons: 0, clickCount: 1 });
}
const pageOf = (id) => `window.__flow.page(${JSON.stringify(id)})`;
const W = (id, sel = '') => `document.querySelector('.win[data-id="${id}"] ${sel}')`;
async function openPage(url) {
  const id = await host.eval(`return window.__flow.openPage(${JSON.stringify(url)});`);
  await waitFor(() => host.eval(`const p = ${pageOf(id)}; return !!p && p.getTitle() !== '' && !p.isLoading();`), 30000, `${url}`).catch(() => null);
  await sleep(1500);
  return id;
}
// the on-screen point of a text in the page's shown tab (CSS px of the Flow window)
async function textAt(id, text, len) {
  const box = await host.eval(`const v = ${W(id, 'webview:not(.off)')}; const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, s: b.width / v.offsetWidth };`);
  const at = await host.eval(`const v = ${W(id, 'webview:not(.off)')}; return await v.executeJavaScript(${JSON.stringify(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(${JSON.stringify(text)}); if (i >= 0) { n.parentElement.scrollIntoView({ block: 'center' }); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const a = r.getClientRects()[0]; r.setStart(n, i + ${len} - 1); r.setEnd(n, i + ${len}); const b = r.getClientRects()[0]; return { x0: a.left + 1, x1: b.right - 1, y: a.top + a.height / 2 }; } } return null; })()`)});`);
  if (!at) return null;
  return { x0: box.x + at.x0 * box.s, x1: box.x + at.x1 * box.s, y: box.y + at.y * box.s };
}
const clipShown = (id) => host.eval(`const b = ${W(id, '.pclip')}; if (!b) return false; const cs = getComputedStyle(b); return b.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && !b.classList.contains('off') && !b.disabled;`);

await host.eval(`window.__flow.go(window.__flow.state().ws.findIndex((w) => w.id === 'flow')); return true;`);
await sleep(1200);

// 1. ✂ shows only while text is selected in the page.
let WIKI;
{
  WIKI = await openPage('https://en.wikipedia.org/wiki/Web_browser');
  const before = await clipShown(WIKI);
  const p = await textAt(WIKI, 'The purpose of a web browser', 28);
  if (p) { await click(p.x0, p.y); await sleep(400); await drag(p.x0, p.x1, p.y); await sleep(500); }
  const during = await clipShown(WIKI);
  await shot('01-clip-with-selection');
  // a plain click elsewhere in the page clears the selection
  if (p) { await click(p.x0, p.y + 120); await sleep(600); }
  const after = await clipShown(WIKI);
  step('✂ is hidden without a selection, shown with one, hidden again after', !before && during && !after, `before ${before}, with a selection ${during}, after ${after}`);
}

// 2. A file tab shows its path, not the signed address.
{
  const rows = () => host.eval(`return [...document.querySelectorAll('.tr[data-act^="files|"]')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim());`);
  if (!(await rows()).some((r) => /BRIEF\.md/.test(r))) {
    const r0 = await host.eval(`const r = document.querySelector('.tr[data-act^="files|"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 };`);
    if (r0) { await click(r0.x, r0.y); await sleep(1500); }
  }
  const row = await host.eval(`const r = [...document.querySelectorAll('.tr[data-act^="files|"]')].find((e) => /^\\W*BRIEF\\.md\\W*$/.test(e.textContent.trim())); if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 };`);
  if (row) { await click(row.x, row.y); await sleep(3500); }
  const f = await host.eval(`const w = window.__flow.windows().find((x) => x.type === 'page' && document.querySelector('.win.front[data-id="' + x.id + '"]')); if (!w) return null; const el = document.querySelector('.win[data-id="' + w.id + '"]'); const tabs = [...el.querySelectorAll('.ptab')].map((t) => t.textContent.replace('×', '').trim()); return { id: w.id, url: window.__flow.page(w.id).getURL(), addr: el.querySelector('.ad').value, title: (el.querySelector('.tb .title, .tb') || {}).textContent.trim().slice(0, 60), tabs };`);
  await shot('02-file-tab-path');
  step('a file tab shows its path in the address, not the signed address', !!f && /BRIEF\.md/.test(f.addr) && !/flow-file:|[A-Za-z0-9_-]{22}/.test(f.addr), JSON.stringify(f));
}

// 3. Switching tabs: the address, the title and the note follow the shown tab.
{
  const id = WIKI;
  await host.eval(`${pageOf(id)}.newTab('https://example.com/?walk3=tab2'); return true;`);
  await sleep(3500);
  const state = () => host.eval(`const el = ${W(id)}; const m = window.__flow.windows().find((x) => x.id === ${JSON.stringify(id)}); return { addr: el.querySelector('.ad').value, title: (el.querySelector('.tb .title') || el.querySelector('.tb')).textContent.trim().slice(0, 50), model: m.url, shown: ${pageOf(id)}.tabs().tab };`);
  const onTab2 = await state();
  // switch with a real click on the first tab in the strip
  const t0 = await host.eval(`const t = ${W(id, '.ptab')}; if (!t) return null; const b = t.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
  if (t0) { await click(t0.x, t0.y); await sleep(1500); }
  const onTab1 = await state();
  await shot('03-tab-switch');
  step('switching to a tab moves the address to it', /example\.com/.test(onTab2.addr) && /wiki\/Web_browser/.test(onTab1.addr), `${onTab2.addr} -> ${onTab1.addr}`);
  step('switching to a tab moves the window\'s page (model url) to it', /example\.com/.test(String(onTab2.model)) && /Web_browser/.test(String(onTab1.model)), `${onTab2.model} -> ${onTab1.model}`);
  step('with two tabs the title bar does not repeat the tab title', !/Web browser - Wikipedia|Example Domain/.test(onTab1.title), `title bar ${JSON.stringify(onTab1.title)}`);
}

// 4. A new tab whose first address is a download closes once the download is listed; the file is in the workspace's
// downloads.
{
  const id = WIKI;
  const tabsBefore = await host.eval(`return ${pageOf(id)}.tabs().tabs.length;`);
  await host.eval(`${pageOf(id)}.newTab('https://github.com/octocat/Hello-World/archive/refs/heads/master.zip'); return true;`);
  await sleep(7000);
  const tabs = await host.eval(`return ${pageOf(id)}.tabs().tabs.map((t) => t.url.slice(0, 60));`);
  // unfold the workspace's downloads row if it is folded, then look for the file
  const dl = await host.eval(`const r = [...document.querySelectorAll('.tr[data-act^="files|"]')].find((e) => e.getClientRects().length && /^▸\\s*downloads/.test(e.textContent.trim())); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 };`);
  if (dl) { await click(dl.x, dl.y); await sleep(1200); }
  const listed = await host.eval(`return [...document.querySelectorAll('.tr[data-act^="files|"]')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()).filter((t) => /Hello-World|download/i.test(t));`);
  const rowsForIt = await host.eval(`return [...document.querySelectorAll('.tr[data-act^="tab|"]')].filter((e) => /Hello-World|codeload|archive/i.test(e.textContent)).length;`);
  await shot('04-download-tab');
  // item 32: a tab opened only for a download closes once the download is listed; the listing proves the download ran
  step('a tab opened only for a download closes, with no tab or row left for it', listed.some((t) => /Hello-World/.test(t)) && tabs.length === tabsBefore && !tabs.some((u) => /archive|codeload/.test(u)) && rowsForIt === 0, `tabs ${JSON.stringify(tabs)}, browser rows for it ${rowsForIt}`);
  step('the downloaded file is in the workspace\'s downloads', listed.some((t) => /Hello-World/.test(t)), JSON.stringify(listed));
}

// 5. A page's highlight comes back after a restart.
{
  const id = WIKI;
  await host.eval(`const p = ${pageOf(id)}; p.selectTab(0); return true;`);
  await sleep(1200);
  const p = await textAt(id, 'The purpose of a web browser', 28);
  if (p) { await click(p.x0, p.y); await sleep(300); await drag(p.x0, p.x1, p.y); await sleep(500); }
  const clip = await host.eval(`const b = ${W(id, '.pclip')}; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  await click(clip.x, clip.y);
  await sleep(1800);
  const countMarks = async () => { let n = 0; for (const t of (await targets(9571)).filter((x) => x.type === 'webview' && /wiki\/Web_browser/.test(x.url))) { const c = await Cdp.connect(t.webSocketDebuggerUrl); n = Math.max(n, await c.eval(`const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0;`)); c.close(); } return n; };
  const before = await countMarks();
  await sleep(3000);
  host.close();
  execFileSync(APP, ['stop'], { stdio: 'inherit' });
  execFileSync(APP, ['start', '/tmp/flow-dev-browse.log'], { stdio: 'inherit' });
  await connect();
  await sleep(6000);
  const after = await countMarks();
  await shot('05-mark-after-restart');
  step('a page\'s highlight comes back after a restart', before > 0 && after > 0, `marks ${before} before, ${after} after`);
}
host.close();
console.log(nos ? `${nos} NO` : 'all ok');
process.exitCode = nos ? 1 : 0;




