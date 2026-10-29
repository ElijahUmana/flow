// sidebar's one-shot CDP driver for the dev app on 9574 (test/sidebar-dev.sh start).
//   node test/sidebar-do.mjs eval '<expression>'
//   node test/sidebar-do.mjs shot <file.png> [sidebar]      sidebar: crop to the sidebar
//   node test/sidebar-do.mjs click '<css selector>' [index]  a real mouse click at the element's center
//   node test/sidebar-do.mjs rclick '<css selector>' [index]
import fs from 'node:fs';
import { connectTo, evaluate, click, mouse, size, sleep } from './ui-lib.mjs';

const [cmd, a, b] = process.argv.slice(2);
const page = await connectTo(9574, /\/src\/index\.html$/);
await size(page, 1500, 913);
const center = async (sel, i) => {
  const r = await evaluate(page, `(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${+i || 0}]; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(page, a), null, 1));
} else if (cmd === 'shot') {
  const clip = b === 'sidebar' ? await evaluate(page, '(() => { const r = document.getElementById("sb").getBoundingClientRect(); return { x: 0, y: 0, width: Math.max(1, r.width), height: r.height, scale: 1 }; })()') : undefined;
  const r = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  fs.writeFileSync(a, Buffer.from(r.data, 'base64'));
  console.log(a);
} else if (cmd === 'click' || cmd === 'rclick') {
  const p = await center(a, b);
  if (cmd === 'click') await click(page, p.x, p.y);
  else {
    await mouse(page, 'mouseMoved', p.x, p.y);
    await mouse(page, 'mousePressed', p.x, p.y, { button: 'right', buttons: 2 });
    await mouse(page, 'mouseReleased', p.x, p.y, { button: 'right', buttons: 2 });
  }
  await sleep(400);
  console.log(`${cmd} ${a} at ${Math.round(p.x)},${Math.round(p.y)}`);
} else {
  console.log('usage: eval <expr> | shot <file> [sidebar] | click <sel> [i] | rclick <sel> [i]');
  process.exitCode = 2;
}
if (page.errors.length) console.log(`console: ${page.errors.join('\n')}`);
page.ws.close();




