// Which canvas state blurs content: will-change on/off x integer/fractional device-px translate x zoom. Static frames,
// no motion, so any loss is rasterization/resampling, not movement.
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const tree = path.resolve(process.argv[2]); const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(here, 'crisp-pages/text.html'))); });
await new Promise((ok) => srv.listen(9783, '127.0.0.1', ok));
let c; const ev = (x) => c.eval(x);
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'iso.log') }); c = await L.flowWindow(); await L.sleep(1500);
  await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await L.sleep(2500);
  const rows = [];
  for (const z of [1, 0.83, 1.3, 0.35]) for (const wc of ['', 'transform']) for (const fx of [0, 0.5, 0.25]) {
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange=''; cv.style.transform='translate(${-40 + fx}px, ${-20 + fx}px) scale(${z})'; void cv.offsetWidth; return true; })()`);
    await L.sleep(250);
    if (wc) { await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange='transform'; return true; })()`); await L.sleep(250); }
    const regs = await ev(`(() => { const s=__flow.state(), v=document.getElementById('viewport').getBoundingClientRect(); return [...document.querySelectorAll('.ws[data-id="'+s.ui.at+'"] > .canvas > .win')].filter((w)=>w.style.display!=='none').map((w)=>{ const tb=w.querySelector(':scope > .tb'), b=w.getBoundingClientRect(), t=tb?tb.getBoundingClientRect().bottom:b.top; const l=Math.max(b.left,v.left)+3,r=Math.min(b.right,v.right)-3,top=Math.max(t,v.top)+3,bot=Math.min(b.bottom,v.bottom)-3; return {id:w.dataset.id,x:l,y:top,w:r-l,h:bot-top}; }).filter((r)=>r.w>40&&r.h>40); })()`);
    const img = await shot(); rows.push({ z, wc: wc || 'none', fx, s: Object.fromEntries(regs.map((r) => [r.id, +C.score(img, r).toFixed(1)])) });
  }
  // and: will-change set at one scale, then the scale changed while it stays on (a pinch frame on a held layer)
  for (const [z0, z1] of [[1, 0.5], [0.5, 1], [1, 1.5]]) {
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange=''; cv.style.transform='translate(-40px,-20px) scale(${z0})'; void cv.offsetWidth; return true; })()`); await L.sleep(250);
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange='transform'; return true; })()`); await L.sleep(250);
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.transform='translate(-40px,-20px) scale(${z1})'; return true; })()`); await L.sleep(400);
    const regs = await ev(`(() => { const s=__flow.state(), v=document.getElementById('viewport').getBoundingClientRect(); return [...document.querySelectorAll('.ws[data-id="'+s.ui.at+'"] > .canvas > .win')].filter((w)=>w.style.display!=='none').map((w)=>{ const tb=w.querySelector(':scope > .tb'), b=w.getBoundingClientRect(), t=tb?tb.getBoundingClientRect().bottom:b.top; const l=Math.max(b.left,v.left)+3,r=Math.min(b.right,v.right)-3,top=Math.max(t,v.top)+3,bot=Math.min(b.bottom,v.bottom)-3; return {id:w.dataset.id,x:l,y:top,w:r-l,h:bot-top}; }).filter((r)=>r.w>40&&r.h>40); })()`);
    const held = await shot();
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange=''; return true; })()`); await L.sleep(400);
    const fresh = await shot();
    rows.push({ heldScale: `${z0}->${z1}`, ratio: Object.fromEntries(regs.map((r) => [r.id, +(C.score(held, r) / C.score(fresh, r)).toFixed(3)])) });
  }
  console.log(JSON.stringify({ dpr: await ev('devicePixelRatio'), rows, errors: c.errors.slice(0, 5) }));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




