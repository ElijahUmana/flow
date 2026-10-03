// browse: walks files' Markdown viewer with real input on the Flow window: a README with HTML, relative links, inert
// HTML, a big file and one above 1 MB, a file written to while its tab shows, and a clip. The workspace "flow" must
// point at the folder given (browse writes it into the state after test/browse-app.sh reset).
// usage: node test/browse-mdwalk.mjs <folder> <shots-dir>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

const [DIR, SHOTS = '/tmp/browse-mdwalk'] = process.argv.slice(2);
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
const rows = () => host.eval(`return [...document.querySelectorAll('.tr[data-act^="files|"]')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim().replace(/\\s+/g, ' '));`);
async function clickRow(re) {
  const r = await host.eval(`const re = new RegExp(${JSON.stringify(re)}); const row = [...document.querySelectorAll('.tr[data-act^="files|"]')].find((e) => e.getClientRects().length && re.test(e.textContent.trim())); if (!row) return null; row.scrollIntoView({ block: 'center' }); const b = row.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 };`);
  if (r) { await click(r.x, r.y); await sleep(1200); }
  return !!r;
}
const frontPage = () => host.eval(`const w = window.__flow.windows().find((x) => x.type === 'page' && document.querySelector('.win.front[data-id="' + x.id + '"]')); if (!w) return null; const p = window.__flow.page(w.id); return { id: w.id, url: p.getURL(), tabs: p.tabs().tabs.length };`);
async function inPage(id, js) {
  return host.eval(`const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); if (!v) return 'no webview'; try { return await v.executeJavaScript(${JSON.stringify(js)}); } catch (e) { return 'unreadable: ' + e.message; }`);
}
async function open(name) {
  if (!(await clickRow(`^\\W*${name.replace(/\./g, '\\.')}\\W*$`))) return null;
  await sleep(2500);
  return frontPage();
}

await host.eval(`window.__flow.go(window.__flow.state().ws.findIndex((w) => w.id === 'flow')); return true;`);
await sleep(1500);
const r0 = await rows();
if (!r0.some((r) => /README\.md/.test(r))) await clickRow('mdwalk');
step('the files group shows the folder', (await rows()).some((r) => /README\.md/.test(r)), JSON.stringify((await rows()).slice(0, 10)));

// 1. A README with HTML renders in the look of a note, its <img> included.
{
  const p = await open('README.md');
  const info = p ? await inPage(p.id, `(() => { const h = document.querySelectorAll('h1,h2,h3').length; const imgs = [...document.images].map((i) => i.getAttribute('src') + ':' + (i.complete ? i.naturalWidth : 'loading')); const c = document.body.cloneNode(true); c.querySelectorAll('pre, code').forEach((e) => e.remove()); const raw = /^#{1,3} /m.test(c.innerText); return { h, imgs, raw, bg: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.body).fontFamily.slice(0, 40), title: document.title }; })()`) : null;
  await shot('01-readme');
  step('a README renders formatted', !!info && info.h > 2 && !info.raw, JSON.stringify(info));
  step('its HTML <img> shows', !!info && info.imgs && info.imgs.some((s) => /:\d+$/.test(s) && !/:0$/.test(s)), JSON.stringify(info && info.imgs));
}

// 2. A relative link opens the other file rendered; a link with a heading lands on it.
{
  const p = await open('a.md');
  const at = p ? await inPage(p.id, `(() => { const a = [...document.links].find((x) => x.textContent === 'the b file'); if (!a) return null; const b = a.getBoundingClientRect(); return { x: b.left + 5, y: b.top + b.height / 2, href: a.getAttribute('href') }; })()`) : null;
  let after = null;
  if (at && at.x != null) {
    const box = await host.eval(`const v = document.querySelector('.win[data-id="${p.id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, vw: v.offsetWidth };`);
    await click(box.x + at.x * (box.w / box.vw), box.y + at.y * (box.w / box.vw));
    await sleep(2500);
    after = await frontPage();
  }
  const rendered = after ? await inPage(after.id, `(() => ({ h1: (document.querySelector('h1') || {}).textContent || null, raw: /^# /m.test(document.body.innerText) }))()`) : null;
  await shot('02-relative-link');
  step('a relative link opens the other file, rendered', !!after && /b\.md/.test(after.url) && rendered && rendered.h1 === 'b' && !rendered.raw, `link ${JSON.stringify(at)}, now ${after && after.url.slice(-30)}, ${JSON.stringify(rendered)}`);
}

// 3. HTML outside the inert list shows as text; nothing in the file runs.
{
  const p = await open('unsafe.md');
  const info = p ? await inPage(p.id, `(() => ({ title: document.title, scripts: document.querySelectorAll('script').length, iframes: document.querySelectorAll('iframe').length, onerror: [...document.querySelectorAll('[onerror],[onclick]')].length, jsLinks: [...document.links].filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length, hostText: document.body.innerText.includes('<host>'), details: !!document.querySelector('details summary'), remoteImg: [...document.images].map((i) => i.getAttribute('src').slice(0, 40) + ':' + i.naturalWidth) }))()`) : null;
  await shot('03-unsafe');
  step('a file\'s HTML cannot run anything', !!info && info.title === 'unsafe.md' && info.hostText && info.scripts === 0 && info.iframes === 0 && info.onerror === 0 && info.jsLinks === 0, JSON.stringify(info));
  step('a tag outside the list shows as text, details folds', !!info && info.hostText && info.details, `host as text ${info && info.hostText}, details ${info && info.details}`);
}

// 4. STATUS.md (282 KB) renders; big.md (1.4 MB) shows as plain text.
{
  const p = await open('STATUS.md');
  const s = p ? await inPage(p.id, `(() => ({ headings: document.querySelectorAll('h1,h2,h3').length, tables: document.querySelectorAll('table').length, pre: document.querySelectorAll('pre').length }))()`) : null;
  step('a 282 KB file renders', !!s && s.headings > 5, JSON.stringify(s));
  const b = await open('big.md');
  const t = b ? await inPage(b.id, `(() => ({ headings: document.querySelectorAll('h1,h2,h3').length, pre: document.querySelectorAll('pre').length, rawHash: /^## /m.test(document.body.innerText), chars: document.body.innerText.length }))()`) : null;
  await shot('04-big');
  step('a file above 1 MB shows as plain text', !!t && t.headings === 0 && t.rawHash, JSON.stringify(t));
}

// 5. plan.md written to while its tab shows: the change shows within a second and the reading place holds.
{
  const p = await open('plan.md');
  if (!p) step('a write to an open file re-renders it', false, 'plan.md did not open');
  else {
    await inPage(p.id, `(() => { const li = [...document.querySelectorAll('li')].find((e) => e.textContent.trim() === 'plan step 120'); li.scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(800);
    const topItem = `(() => { const li = [...document.querySelectorAll('li')].find((e) => e.getBoundingClientRect().bottom > 1); return li ? li.textContent.trim() + ' @' + Math.round(li.getBoundingClientRect().top) : null; })()`;
    const topBefore = await inPage(p.id, topItem);
    // an agent's write: new lines at the top of the plan, above the reading place
    const file = path.join(DIR, 'plan.md');
    const text = fs.readFileSync(file, 'utf8').replace('# plan\n\n', '# plan\n\n- inserted by the agent 1\n- inserted by the agent 2\n- inserted by the agent 3\n\n');
    const t0 = Date.now();
    fs.writeFileSync(file, text);
    const seen = await waitFor(async () => (await inPage(p.id, `document.body.innerText.includes('inserted by the agent 3')`)) === true, 5000, 'the re-render').then(() => Date.now() - t0, () => null);
    await sleep(500);
    const topAfter = await inPage(p.id, topItem);
    // then one item appended at the very end
    fs.appendFileSync(file, '\n- appended at the end\n');
    await waitFor(async () => (await inPage(p.id, `document.body.innerText.includes('appended at the end')`)) === true, 5000, 'the second re-render').catch(() => null);
    await sleep(500);
    const topAfter2 = await inPage(p.id, topItem);
    await shot('05-live-write');
    step('a write to the open file shows within a second', seen !== null && seen < 1500, `re-rendered after ${seen} ms`);
    step('the item being read stays on top (items written above, then one appended)', !!topBefore && topAfter === topBefore && topAfter2 === topBefore, `top ${JSON.stringify(topBefore)} -> ${JSON.stringify(topAfter)} -> ${JSON.stringify(topAfter2)}`);
  }
}

// 6. A clip from a rendered file lands in that file's own note.
{
  const p = await open('b.md');
  if (!p) step('a clip from a rendered file lands in its note', false, 'b.md did not open');
  else {
    const at = await inPage(p.id, `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('second part.'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const a = r.getClientRects()[0]; r.setStart(n, i + 11); r.setEnd(n, i + 12); const b = r.getClientRects()[0]; return { x0: a.left + 1, x1: b.right - 1, y: a.top + a.height / 2 }; } } return null; })()`);
    const box = await host.eval(`const v = document.querySelector('.win[data-id="${p.id}"] webview:not(.off)'); const b = v.getBoundingClientRect(); return { x: b.left, y: b.top, s: b.width / v.offsetWidth };`);
    let sel = '';
    if (at && at.x0 != null) {
      const X0 = box.x + at.x0 * box.s, X1 = box.x + at.x1 * box.s, Y = box.y + at.y * box.s;
      await ev({ type: 'mouseMoved', x: X0, y: Y, button: 'none', buttons: 0 });
      await ev({ type: 'mousePressed', x: X0, y: Y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 10; i++) await ev({ type: 'mouseMoved', x: X0 + ((X1 - X0) * i) / 10, y: Y, button: 'left', buttons: 1 });
      await ev({ type: 'mouseReleased', x: X1, y: Y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(400);
      sel = await inPage(p.id, 'String(getSelection())');
    }
    const clipAt = await host.eval(`const b = document.querySelector('.win[data-id="${p.id}"] .pclip'); if (!b || !b.getClientRects().length) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    if (clipAt) await click(clipAt.x, clipAt.y);
    await sleep(1500);
    const note = await host.eval(`const w = document.querySelector('.win[data-id="${p.id}"]'); if (!w.classList.contains('noted')) w.querySelector('[data-act="note"]').click(); await new Promise((r) => setTimeout(r, 800)); const n = w.querySelector('.anote'); return n ? n.innerText : '';`);
    const marks = await inPage(p.id, `(() => { const h = CSS.highlights.get('flow-mark'); return h ? h.size : 0; })()`);
    await shot('06-clip');
    step('a clip from a rendered file lands in that file\'s note', /second part/.test(note), `selected ${JSON.stringify(sel)}, clip button ${clipAt ? 'shown' : 'not shown'}, note ${JSON.stringify(note.slice(-60))}, marks ${marks}`);
  }
}
host.close();
console.log(nos ? `${nos} NO` : 'all ok');
process.exitCode = nos ? 1 : 0;




