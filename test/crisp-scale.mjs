// Is each kind of content rastered at the resolution the screen needs? Same device-pixel geometry two ways:
// A) devicePixelRatio 1, board zoom 2 (reached by a real pinch)   B) devicePixelRatio 2, board zoom 1
// Fully rastered content has the same sharpness in both; content rastered at 1x and scaled up is much softer in A.
// Samples are taken over time after the pinch so a late re-raster shows as the score rising.
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const tree = path.resolve(process.argv[2]), outFile = path.resolve(process.argv[3]);
const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(here, 'crisp-pages/text.html'))); });
await new Promise((ok) => srv.listen(9783, '127.0.0.1', ok));
let c; const ev = (x) => c.eval(x), sleep = L.sleep;
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const wheel = (x, y, dy, at) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: at / 1000 });
const regs = (id) => ev(`(() => { const v=document.getElementById('viewport').getBoundingClientRect(), d=devicePixelRatio; const pick=(e,k)=>{ if(!e) return null; const b=e.getBoundingClientRect(); const l=Math.max(b.left,v.left)+4,r=Math.min(b.right,v.right)-4,t=Math.max(b.top,v.top)+4,bt=Math.min(b.bottom,v.bottom)-4; return r-l>60&&bt-t>40?{k,x:l*d,y:t*d,w:(r-l)*d,h:(bt-t)*d}:null; }; return [pick(document.querySelector('.win[data-id="${id}"] webview'),'page'), pick(document.querySelector('.win.note .fnote'),'note'), pick(document.querySelector('.win.term .xterm-screen'),'term')].filter(Boolean); })()`);
const out = { tree, runs: [] };
try {
  for (const [label, dpr, steps] of [['A dpr1 zoom2', 1, 7], ['B dpr2 zoom1', 2, 0]]) {
    await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'scale.log') }); c = await L.flowWindow(); await sleep(1500);
    if (dpr !== 1) { const vp = await ev(`({w: innerWidth, h: innerHeight})`); await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: dpr, mobile: false }); await sleep(1200); }
    const id = await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await sleep(3000);
    const p = await ev(`(() => { const g=document.querySelector('.win[data-id="${id}"] webview').getBoundingClientRect(); return {x:g.left+30, y:g.top+30}; })()`);
    let at = Date.now(); for (let i = 0; i < steps; i++) { at += 16; await wheel(p.x, p.y, -9.9, at); await sleep(16); }
    const t0 = Date.now(), samples = [];
    for (const d of [16, 50, 120, 300, 800, 2000]) { await sleep(Math.max(0, t0 + d - Date.now())); const R = await regs(id), img = await shot(); samples.push({ d, s: Object.fromEntries(R.map((r) => [r.k, +C.score(img, r).toFixed(1)])) }); }
    const z = await ev(`(() => { const s=__flow.state(); return s.ws.find((w)=>w.id===s.ui.at).zoom||1; })()`);
    out.runs.push({ label, dpr, z: +z.toFixed(4), samples, errors: c.errors.slice(0, 5) });
    c.close(); await L.stop();
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  for (const r of out.runs) console.log(r.label, 'z', r.z, r.samples.map((s) => s.d + ':' + JSON.stringify(s.s)).join('  '), 'errors', JSON.stringify(r.errors));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




