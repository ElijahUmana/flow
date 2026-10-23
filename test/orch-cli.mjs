// One action against orch's running Flow, for exploring by hand:
//   node test/orch-cli.mjs eval '<expression>' [urlRegex]
//   node test/orch-cli.mjs shot <name> [urlRegex]          -> /tmp/flow-dev-orch/shots/<name>.png
//   node test/orch-cli.mjs click <x> <y> | rclick <x> <y> | dbl <x> <y>
//   node test/orch-cli.mjs drag <x1> <y1> <x2> <y2> [steps]
//   node test/orch-cli.mjs type '<text>' | key <Key> [mods] | insert '<text>'
//   node test/orch-cli.mjs wheel <x> <y> <dx> <dy> [count]
//   node test/orch-cli.mjs targets
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, shot, click, dblclick, mouse, drag, type, key, wheel, sleep } from './ui-lib.mjs';
import { connect, targets, SHOTS } from './orch-lib.mjs';

const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'targets') {
  for (const t of await targets()) console.log(t.type, t.id, t.url.slice(0, 160));
  process.exit(0);
}
const urlArg = { eval: a[1], shot: a[1] }[cmd];
const page = await connect(urlArg ? new RegExp(urlArg) : undefined);
try {
  if (cmd === 'eval') {
    const v = await evaluate(page, a[0]);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  } else if (cmd === 'shot') {
    fs.mkdirSync(SHOTS, { recursive: true });
    console.log(await shot(page, path.join(SHOTS, `${a[0]}.png`)));
  } else if (cmd === 'click') {
    await click(page, +a[0], +a[1]);
  } else if (cmd === 'rclick') {
    await mouse(page, 'mouseMoved', +a[0], +a[1]);
    await mouse(page, 'mousePressed', +a[0], +a[1], { button: 'right', buttons: 2 });
    await mouse(page, 'mouseReleased', +a[0], +a[1], { button: 'right', buttons: 0 });
  } else if (cmd === 'dbl') {
    await dblclick(page, +a[0], +a[1]);
  } else if (cmd === 'drag') {
    await drag(page, { x: +a[0], y: +a[1] }, { x: +a[2], y: +a[3] }, { steps: +(a[4] || 16), stepMs: 16, holdMs: 100 });
  } else if (cmd === 'type') {
    await type(page, a[0]);
  } else if (cmd === 'insert') {
    await page.send('Input.insertText', { text: a[0] });
  } else if (cmd === 'key') {
    await key(page, a[0], +(a[1] || 0));
  } else if (cmd === 'wheel') {
    const n = +(a[4] || 1);
    for (let i = 0; i < n; i++) { await wheel(page, +a[0], +a[1], +a[2], +a[3]); await sleep(16); }
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
  if (page.errors.length) console.log('page errors:', page.errors.join(' | '));
} finally {
  page.ws.close();
}




