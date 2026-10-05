// After a real pinch, is a page window's content rastered for the new zoom, or an old raster scaled? Compare its
// sharpness over time with the same view after the page is forced to re-raster (its webview resized by 1px and back).
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const tree = path.resolve(process.argv[2]); const dpr = +(process.argv[3] || 1); const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(here, 'crisp-pages/text.html'))); });
await new Promise((ok) => srv.listen(9783, '127.0.0.1', ok));
let c; const ev = (x) => c.eval(x);
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const region = (id) => ev(`(() => { const w=document.querySelector('.win[data-id="${id}"]'), v=document.getElementById('viewport').getBoundingClientRect(), g=w.querySelector('webview').getBoundingClientRect(); const l=Math.max(g.left,v.left)+3,r=Math.min(g.right,v.right)-3,t=Math.max(g.top,v.top)+3,b=Math.min(g.bottom,v.bottom)-3; return {x:l*${dpr},y:t*${dpr},w:(r-l)*${dpr},h:(b-t)*${dpr}}; })()`);
const wheel = (x, y, dy, at) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: at / 1000 });
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'guest.log') }); c = await L.flowWindow(); await L.sleep(1500);
  if (dpr !== 1) { const vp = await ev(`({w: innerWidth, h: innerHeight})`); await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: dpr, mobile: false }); await L.sleep(1000); }
  const id = await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await L.sleep(3000);
  const rows = [];
  for (const [label, dy, n] of [['pinch in', -8, 6], ['pinch in more', -8, 5], ['pinch out', 10, 12], ['pinch out far', 12, 10]]) {
    const p = await ev(`(() => { const g=document.querySelector('.win[data-id="${id}"] webview').getBoundingClientRect(), v=document.getElementById('viewport').getBoundingClientRect(); return {x:Math.min(Math.max(g.left+g.width/2,v.left+40),v.right-40), y:Math.min(Math.max(g.top+g.height/2,v.top+60),v.bottom-60)}; })()`);
    let at = Date.now(); for (let i = 0; i < n; i++) { at += 16; await wheel(p.x, p.y, dy, at); await L.sleep(16); }
    const t0 = Date.now(), seen = [];
    for (const d of [60, 300, 1000, 2500]) { await L.sleep(Math.max(0, t0 + d - Date.now())); const r = await region(id); seen.push({ d, s: C.score(await shot(), r), r }); }
    await ev(`(() => { const wv=document.querySelector('.win[data-id="${id}"] webview'); const w=wv.style.width; wv.style.width=(parseFloat(w)+1)+'px'; return new Promise((ok)=>requestAnimationFrame(()=>requestAnimationFrame(()=>{ wv.style.width=w; ok(true); }))); })()`);
    await L.sleep(1200);
    const r = await region(id), fresh = C.score(await shot(), r), z = await ev(`(() => { const s=__flow.state(); return s.ws.find((w)=>w.id===s.ui.at).zoom; })()`);
    rows.push({ label, z: +z.toFixed(3), area: Math.round(r.w * r.h), overFresh: seen.map((x) => [x.d, +(x.s / fresh).toFixed(3)]) });
  }
  console.log(JSON.stringify({ dpr, rows, errors: c.errors.slice(0, 5) }));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




