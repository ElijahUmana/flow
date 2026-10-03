// browse: real mouse input on the Flow window. usage:
//   node test/browse-hostdo.mjs click <selector>            click the center of the first element matching selector
//   node test/browse-hostdo.mjs clickxy <x> <y> [mods]       click a point
//   node test/browse-hostdo.mjs move <x> <y>                 move the pointer
//   node test/browse-hostdo.mjs wheel <x> <y> <dx> <dy> [n] [mods]  n wheel events (default 1)
import { Cdp, targets } from './main-cdp-lib.mjs';
const [cmd, ...a] = process.argv.slice(2);
const ht = (await targets(9571)).find((x) => x.type === 'page' && /\/src\/index\.html/.test(x.url));
const h = await Cdp.connect(ht.webSocketDebuggerUrl);
const ev = (p) => h.send('Input.dispatchMouseEvent', { pointerType: 'mouse', ...p });
async function clickAt(x, y, modifiers = 0) {
  await ev({ type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers });
  await ev({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  await ev({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
}
try {
  if (cmd === 'click') {
    const r = await h.eval(`const e = document.querySelector(${JSON.stringify(a[0])}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
    if (!r) throw new Error(`nothing matches ${a[0]}`);
    await clickAt(r.x, r.y);
    console.log(JSON.stringify(r));
  } else if (cmd === 'clickxy') {
    await clickAt(Number(a[0]), Number(a[1]), Number(a[2] || 0));
  } else if (cmd === 'move') {
    await ev({ type: 'mouseMoved', x: Number(a[0]), y: Number(a[1]), button: 'none', buttons: 0 });
  } else if (cmd === 'wheel') {
    const n = Number(a[4] || 1);
    for (let i = 0; i < n; i++) {
      await ev({ type: 'mouseWheel', x: Number(a[0]), y: Number(a[1]), deltaX: Number(a[2]), deltaY: Number(a[3]), button: 'none', buttons: 0, modifiers: Number(a[5] || 0) });
      await new Promise((r) => setTimeout(r, 16));
    }
  } else throw new Error(`unknown ${cmd}`);
} finally {
  h.close();
}




