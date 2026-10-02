// browse: click an element inside a webview guest with real CDP mouse input on that guest.
// usage: node test/browse-click.mjs <url-substring> <selector | text:<visible text>> [left|middle|right] [modifiers]
//   modifiers: CDP bit mask (1 alt, 2 ctrl, 4 meta, 8 shift)
import { Cdp, targets, waitFor } from './main-cdp-lib.mjs';
const [match, what, button = 'left', mods = '0'] = process.argv.slice(2);
const t = await waitFor(async () => (await targets(9571)).find((x) => x.type === 'webview' && x.url.includes(match)), 20000, `a webview at ${match}`);
const c = await Cdp.connect(t.webSocketDebuggerUrl);
try {
  const find = what.startsWith('text:')
    ? `[...document.querySelectorAll('a,button,[role=button],div,span')].filter((e) => e.offsetParent && e.textContent.trim() === ${JSON.stringify(what.slice(5))}).pop()`
    : `document.querySelector(${JSON.stringify(what)})`;
  const r = await c.eval(`const e = ${find}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getClientRects()[0] || e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, tag: e.tagName, href: e.href || null, text: e.textContent.trim().slice(0, 60) };`);
  if (!r) throw new Error(`nothing matches ${what} in ${t.url}`);
  const base = { x: r.x, y: r.y, button, modifiers: Number(mods), clickCount: 1, pointerType: 'mouse' };
  const buttons = { left: 1, right: 2, middle: 4 }[button];
  await c.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
  await c.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons });
  await c.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  console.log(JSON.stringify(r));
} finally {
  c.close();
}




