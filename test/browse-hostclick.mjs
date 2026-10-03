// browse: click an element inside a page's webview with real input sent to the Flow window at that element's
// on-screen point (the path a real click takes: the window routes it to the guest).
// usage: node test/browse-hostclick.mjs <url-substring> <selector | text:<visible text>> [left|middle|right] [modifiers]
//   modifiers: CDP bit mask (1 alt, 2 ctrl, 4 meta, 8 shift)
import { Cdp, targets, waitFor } from './main-cdp-lib.mjs';
const [match, what, button = 'left', mods = '0'] = process.argv.slice(2);
const all = await targets(9571);
const gt = all.find((x) => x.type === 'webview' && x.url.includes(match));
const ht = all.find((x) => x.type === 'page' && /\/src\/index\.html/.test(x.url));
if (!gt) throw new Error(`no webview at ${match}`);
const g = await Cdp.connect(gt.webSocketDebuggerUrl);
const h = await Cdp.connect(ht.webSocketDebuggerUrl);
try {
  const find = what.startsWith('text:')
    ? `[...document.querySelectorAll('a,button,[role=button],div,span')].filter((e) => e.offsetParent && e.textContent.trim() === ${JSON.stringify(what.slice(5))}).pop()`
    : `document.querySelector(${JSON.stringify(what)})`;
  const r = await g.eval(`const e = ${find}; if (!e) return null; e.scrollIntoView({ block: 'center' }); await new Promise((res) => setTimeout(res, 200)); const b = e.getClientRects()[0] || e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, vw: innerWidth, href: e.href || null, text: e.textContent.trim().slice(0, 60) };`);
  if (!r) throw new Error(`nothing matches ${what} in ${gt.url}`);
  const wv = await h.eval(`const v = [...document.querySelectorAll('webview')].find((x) => { try { return x.getURL() === ${JSON.stringify(gt.url)}; } catch (e) { return false; } }); if (!v) return null; const b = v.getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, h: b.height };`);
  if (!wv) throw new Error(`no webview element in the Flow window shows ${gt.url}`);
  const s = wv.w / r.vw;
  const x = wv.left + r.x * s, y = wv.top + r.y * s;
  const base = { x, y, button, modifiers: Number(mods), clickCount: 1, pointerType: 'mouse' };
  const buttons = { left: 1, right: 2, middle: 4 }[button];
  await h.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
  await h.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons });
  await h.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  console.log(JSON.stringify({ ...r, host: { x: Math.round(x), y: Math.round(y), scale: +s.toFixed(3) } }));
} finally {
  g.close();
  h.close();
}




