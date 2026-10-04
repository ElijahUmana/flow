// browse: the batch-2 parts of the browser walk, with real input on the Flow window: files opened as pages from the
// sidebar's files group, a download listed there, and marks (quoted sentences highlighted in the page, a note that
// comes back wherever the page opens again). Prints one line per step and saves screenshots.
// usage: test/browse-app.sh reset && test/browse-app.sh start && node test/browse-walk2.mjs <shots-dir>
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const SHOTS = process.argv[2] || '/tmp/browse-walk2';
fs.mkdirSync(SHOTS, { recursive: true });
let nos = 0;
const step = (name, ok, detail = '') => { if (!ok) nos++; console.log(`${ok ? 'ok  ' : 'NO  '} ${name}${detail ? `  (${detail})` : ''}`); };
const host = await Cdp.connect((await waitFor(async () => (await targets(9571)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 40000, 'the Flow window')).webSocketDebuggerUrl);
await waitFor(() => host.eval('return !!(window.__flow && window.__flow.ready);'), 40000, 'window.__flow');
await host.eval('await window.__flow.ready; return true;');
const shot = async (name) => { const r = await host.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64')); };
const ev = (p) => host.send('Input.dispatchMouseEvent', { pointerType: 'mouse', ...p });
async function click(x, y) {
  await ev({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await ev({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await ev({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function clickRow(textRe) {
  const r = await host.eval(`const re = new RegExp(${JSON.stringify(textRe)}); const row = [...document.querySelectorAll('.tr[data-act^="files|"]')].find((e) => e.getClientRects().length && re.test(e.textContent.trim())); if (!row) return null; row.scrollIntoView({ block: 'center' }); const b = row.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2, text: row.textContent.trim().slice(0, 50), act: row.dataset.act };`);
  if (r) { await click(r.x, r.y); await sleep(900); }
  return r;
}
const filesRows = () => host.eval(`return [...document.querySelectorAll('.tr[data-act^="files|"]')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 50));`);
const pages = () => host.eval(`return window.__flow.windows().filter((w) => w.type === 'page').flatMap((w) => { const p = window.__flow.page(w.id); if (!p) return []; const t = p.tabs(); return t.tabs.map((x, i) => ({ id: w.id, tab: i, shown: i === t.tab, url: x.url })); });`);
const pageOf = (id) => `window.__flow.page(${JSON.stringify(id)})`;

await host.eval(`window.__flow.go(window.__flow.state().ws.findIndex((w) => w.id === 'flow')); return true;`);
await sleep(1500);

// 1. The files group lists the workspace folder; a text file, an html file and an image open as pages.
{
  const rows0 = await filesRows();
  step('the sidebar lists this workspace\'s files', rows0.length > 0, JSON.stringify(rows0.slice(0, 6)));
  // unfold the workspace folder row if it is folded (its first row)
  if (rows0.length && !(await filesRows()).some((r) => /BRIEF\.md/.test(r))) await clickRow('^.*flow');
  const opened = [];
  for (const [label, re, check] of [
    ['a markdown file', 'BRIEF\\.md', `document.body ? document.body.innerText.slice(0, 80) : ''`],
    ['an image', null, `(() => { const i = document.querySelector('img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : ''; })()`],
    ['an html file', null, `(() => { const t = document.body ? document.body.innerText : ''; return (/â€|âœ|Ã/.test(t) ? 'MOJIBAKE ' : 'clean ') + t.replace(/\\s+/g, ' ').slice(0, 60); })()`],
  ]) {
    let row = null;
    if (re) row = await clickRow(re);
    else if (label === 'an image') {
      if (!(await filesRows()).some((r) => /ui-shots/.test(r))) { await clickRow('^test$|test'); await sleep(600); await clickRow('ui-shots'); await sleep(900); }
      row = await clickRow('\\.png');
    } else {
      if ((await filesRows()).some((r) => /^.test$/.test(r))) await clickRow('^.test$');
      if (!(await filesRows()).some((r) => /mockup/.test(r))) await clickRow('^.spec$');
      row = await clickRow('workspaces-mockup\\.html');
    }
    if (!row) { step(`${label} opens as a page`, false, 'row not found'); continue; }
    await sleep(3000);
    const all = await pages();
    const p = all.find((x) => /^flow-file:/i.test(x.url) && !opened.includes(x.url));
    let seen = '';
    if (p) {
      opened.push(p.url);
      seen = await host.eval(`const v = document.querySelector('.win[data-id="${p.id}"] webview:not(.off)') || [...document.querySelectorAll('webview')].find((x) => { try { return x.getURL() === ${JSON.stringify(p.url)}; } catch (e) { return false; } }); if (!v) return 'no webview'; try { return String(await v.executeJavaScript(${JSON.stringify(check)})); } catch (e) { return 'unreadable: ' + e.message; }`);
    }
    await shot(`01-file-${label.replace(/\W+/g, '-')}`);
    step(`${label} opens as a page`, !!p && !!seen && !/^unreadable|^no webview|^MOJIBAKE/.test(seen), `row "${row.text}", page ${p ? p.url.slice(0, 70) : 'none'}, shows ${JSON.stringify(seen.slice(0, 80))}`);
  }
}

// 2. A download is listed under the workspace's files.
{
  const before = await filesRows();
  const id = await host.eval('return window.__flow.openPage("https://example.com/?walk2=dl");');
  await sleep(4000);
  await host.eval(`${pageOf(id)}.navigate('https://github.com/octocat/Hello-World/archive/refs/heads/master.zip'); return true;`);
  await sleep(6000);
  if (!(await filesRows()).some((r) => /Hello-World-master/.test(r))) await clickRow('download');
  await sleep(1200);
  const after = await filesRows();
  await shot('02-download-listed');
  step('a finished download is listed under the workspace\'s files', after.some((r) => /Hello-World-master/.test(r)), `rows ${JSON.stringify(after.filter((r) => !before.includes(r)).slice(0, 5))}`);
}

// ✂ shows once the page's preload has reported the selection; until then it is visibility:hidden and a click falls
// through to the address bar.
const clipButton = (id) => waitFor(() => host.eval(`const c = document.querySelector('.win[data-id="${id}"] .pclip'); if (!c || c.classList.contains('nosel') || c.classList.contains('off')) return null; const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`), 5000, 'the ✂ to show').catch(() => null);

// 3. Marks: a clipped sentence is highlighted in its page, and the note comes back when the page opens again.
{
  const url = 'https://en.wikipedia.org/wiki/Web_browser';
  const id = await host.eval(`return window.__flow.openPage(${JSON.stringify(url)});`);
  await waitFor(() => host.eval(`const p = ${pageOf(id)}; return !!p && /Web_browser/.test(p.getURL()) && !p.isLoading();`), 30000, 'the page').catch(() => null);
  await sleep(2000);
  const g = await Cdp.connect((await targets(9571)).find((t) => t.type === 'webview' && t.url === url).webSocketDebuggerUrl);
  const sentence = 'The purpose of a web browser is to fetch content';
  await g.eval(`const p = [...document.querySelectorAll('p')].find((e) => e.textContent.includes(${JSON.stringify(sentence)})); p.scrollIntoView({ block: 'center' }); const t = [...p.childNodes].find((n) => n.nodeType === 3 && n.data.includes('The purpose')); const i = t.data.indexOf('The purpose'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + ${sentence.length}); getSelection().removeAllRanges(); getSelection().addRange(r); return true;`);
  const clipAt = await clipButton(id);
  if (clipAt) await click(clipAt.x, clipAt.y);
  await sleep(2000);
  const marked = await g.eval(`const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0;`);
  await shot('03-mark-in-page');
  step('a clipped sentence is highlighted in its page', marked > 0, `${marked} highlighted range(s)`);
  // write a line under the quote in the page's note, as the owner annotates
  const pen = await host.eval(`const w = document.querySelector('.win[data-id="${id}"]'); if (!w.classList.contains('noted')) { const b = w.querySelector('[data-act="note"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } return null;`);
  if (pen) { await click(pen.x, pen.y); await sleep(800); }
  const edAt = await host.eval(`const e = document.querySelector('.win[data-id="${id}"] .anote [contenteditable]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + 20, y: b.bottom - 8 };`);
  if (edAt) {
    await click(edAt.x, edAt.y);
    await host.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
    await host.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
    await host.send('Input.insertText', { text: 'flow walk: why this matters' });
    await sleep(1200);
  }
  // hover the highlighted sentence: its note shows beside it
  const box = await host.eval(`const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width };`);
  const pos = await g.eval(`const h = CSS.highlights.get('flow-mark'); const r = h && [...h][0]; if (!r) return null; const b = r.getClientRects()[0]; return { x: b.left + 20, y: b.top + b.height / 2, vw: innerWidth };`);
  let card = null;
  if (pos) {
    const s = box.w / pos.vw;
    await ev({ type: 'mouseMoved', x: box.x + pos.x * s - 30, y: box.y + pos.y * s, button: 'none', buttons: 0 });
    await sleep(200);
    await ev({ type: 'mouseMoved', x: box.x + pos.x * s, y: box.y + pos.y * s, button: 'none', buttons: 0 });
    await sleep(1200);
    card = await host.eval(`const c = document.querySelector('.win[data-id="${id}"] .pmark.on'); return c ? c.textContent : null;`);
  }
  await shot('03b-mark-hover');
  step('hovering the sentence shows the line written under it', !!card && /why this matters/.test(card), `card ${JSON.stringify(card)}`);
  g.close();
  // the same page opened again elsewhere (a fresh page window) brings its note and its mark back
  const id2 = await host.eval(`return window.__flow.openPage('https://en.wikipedia.org/wiki/Web_browser#History');`);
  await waitFor(() => host.eval(`const p = ${pageOf(id2)}; return !!p && /Web_browser/.test(p.getURL()) && !p.isLoading();`), 30000, 'the page again').catch(() => null);
  await sleep(2500);
  const t2 = (await targets(9571)).filter((t) => t.type === 'webview' && /wiki\/Web_browser/.test(t.url));
  let marked2 = 0;
  for (const t of t2) { const c = await Cdp.connect(t.webSocketDebuggerUrl); marked2 = Math.max(marked2, await c.eval(`const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0;`)); c.close(); }
  const pen2 = await host.eval(`const w = document.querySelector('.win[data-id="${id2}"]'); if (!w.classList.contains('noted')) w.querySelector('[data-act="note"]').click(); await new Promise((r) => setTimeout(r, 700)); const n = w.querySelector('.anote'); return n ? n.innerText : '';`);
  await shot('03c-same-page-again');
  step('the same page opened again shows its note and its mark', /why this matters/.test(pen2) && marked2 > 0, `note ${JSON.stringify(pen2.slice(-80))}, marks ${marked2}`);
}

// 4. A clip from a file opened as a page, with a real drag selection: it lands in that file's note and is marked.
{
  const p = (await pages()).find((x) => /^flow-file:.*BRIEF\.md/i.test(x.url));
  if (!p) step('a clip from a file page lands in its note', false, 'no BRIEF.md tab open');
  else {
    // show that tab the way a user does: its row in the sidebar (brings the window into view and to the front)
    const row = await host.eval(`const r = document.querySelector('[data-act="tab|${p.id}|${p.tab}"]'); if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 };`);
    if (row) await click(row.x, row.y);
    else await host.eval(`${pageOf(p.id)}.selectTab(${p.tab}); return true;`);
    await sleep(1500);
    const t = (await targets(9571)).find((x) => x.type === 'webview' && /BRIEF\.md/.test(x.url));
    const g = await Cdp.connect(t.webSocketDebuggerUrl);
    const at = await g.eval(`const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('Flow is a macOS Electron app'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const top = r.getBoundingClientRect().top; let sc = r.startContainer.parentElement; while (sc && sc !== document.body && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement; if (sc && sc !== document.body) sc.scrollTop += top - sc.getBoundingClientRect().top - sc.clientHeight / 2; else window.scrollBy(0, top - innerHeight / 2); await new Promise((res) => setTimeout(res, 300)); const a = r.getClientRects()[0]; r.setStart(n, i + 27); r.setEnd(n, i + 28); const b = r.getClientRects()[0]; return { x0: a.left + 1, x1: b.right - 1, y: a.top + a.height / 2, vw: innerWidth }; } } return null;`);
    const box = await host.eval(`const v = document.querySelector('.win[data-id="${p.id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width };`);
    let sel = '';
    if (at) {
      const s2 = box.w / at.vw;
      const X0 = box.x + at.x0 * s2, X1 = box.x + at.x1 * s2, Y = box.y + at.y * s2;
      // a window behind another takes its first press to come to the front, as on the desktop: press once first
      await click(X0, Y);
      await sleep(700);
      await ev({ type: 'mouseMoved', x: X0, y: Y, button: 'none', buttons: 0 });
      await ev({ type: 'mousePressed', x: X0, y: Y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 10; i++) await ev({ type: 'mouseMoved', x: X0 + ((X1 - X0) * i) / 10, y: Y, button: 'left', buttons: 1 });
      await ev({ type: 'mouseReleased', x: X1, y: Y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(400);
      sel = await g.eval('return String(getSelection());');
    }
    const clipAt = await clipButton(p.id);
    if (clipAt) await click(clipAt.x, clipAt.y);
    await sleep(1800);
    const marked = await g.eval(`const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0;`);
    g.close();
    const note = await host.eval(`const w = document.querySelector('.win[data-id="${p.id}"]'); if (!w.classList.contains('noted')) w.querySelector('[data-act="note"]').click(); await new Promise((r) => setTimeout(r, 800)); const n = w.querySelector('.anote'); return n ? n.innerText : '';`);
    const key = await host.eval(`return window.FlowNotes && window.FlowNotes.key ? window.FlowNotes.key(${JSON.stringify(p.url)}) : 'no key()';`);
    await shot('04-file-clip');
    step('a clip from a file page (real drag) lands in that file\'s note', /Flow is a macOS/.test(note), `selected ${JSON.stringify(sel)}, note ${JSON.stringify(note.slice(-70))}`);
    step('the clipped sentence is marked in the file page', marked > 0, `${marked} highlighted range(s)`);
    step('the file page has a key of its own, without the signature', !!key && !/\/[A-Za-z0-9_-]{22}\//.test(key), `key ${JSON.stringify(key)}`);
  }
}
host.close();
console.log(nos ? `${nos} NO` : 'all ok');
process.exitCode = nos ? 1 : 0;




