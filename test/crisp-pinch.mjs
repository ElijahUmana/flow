// Frames during a real pinch (ctrl-wheel stream, as a trackpad sends) and just after it, each against a settled
// re-render of the identical view: the same canvas transform set again and left 700 ms so every layer, the page's own
// process included, has drawn at that scale. ratio = sharpness(frame) / sharpness(settled), per kind of content.
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const tree = path.resolve(process.argv[2]), outFile = path.resolve(process.argv[3]), DPR = +(process.argv[4] || 1);
const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(here, 'crisp-pages/text.html'))); });
await new Promise((ok) => srv.listen(9783, '127.0.0.1', ok));
let c; const ev = (x) => c.eval(x), sleep = L.sleep;
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const wheel = (x, y, dy, at) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: at / 1000 });
const now = () => ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'), v=document.getElementById('viewport').getBoundingClientRect(), d=devicePixelRatio; const pick=(e,k)=>{ if(!e) return null; const b=e.getBoundingClientRect(); const l=Math.max(b.left,v.left)+4,r=Math.min(b.right,v.right)-4,t=Math.max(b.top,v.top)+4,bt=Math.min(b.bottom,v.bottom)-4; return r-l>60&&bt-t>40?{k,x:l*d,y:t*d,w:(r-l)*d,h:(bt-t)*d}:null; }; return { tf: cv.style.transform, rs: [...cv.querySelectorAll(':scope > .win.page webview')].map((e)=>pick(e,'page')).concat([...cv.querySelectorAll(':scope > .win.note .fnote')].map((e)=>pick(e,'note')), [...cv.querySelectorAll(':scope > .win.term .xterm-screen')].map((e)=>pick(e,'term'))).filter(Boolean) }; })()`);
const byKind = (img, rs) => { const o = {}; for (const r of rs) { (o[r.k] ||= [0, 0]); o[r.k][0] += C.score(img, r) * r.w * r.h; o[r.k][1] += r.w * r.h; } return Object.fromEntries(Object.entries(o).map(([k, [s, a]]) => [k, s / a])); };
const out = { tree, dpr: DPR, runs: [] };
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'pinch.log') }); c = await L.flowWindow(); await sleep(1500);
  if (DPR !== 1) { const vp = await ev(`({w: innerWidth, h: innerHeight})`); await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: DPR, mobile: false }); await sleep(1200); }
  const id = await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await sleep(3000);
  for (const [label, dy, n] of [['pinch in', -5, 24], ['pinch out', 5, 30], ['pinch in again', -4, 20]]) {
    await sleep(1200);
    const p = await ev(`(() => { const g=document.querySelector('.win[data-id="${id}"] webview').getBoundingClientRect(), v=document.getElementById('viewport').getBoundingClientRect(); return {x:Math.min(Math.max(g.left+g.width*.4,v.left+60),v.right-60), y:Math.min(Math.max(g.top+g.height*.4,v.top+80),v.bottom-80)}; })()`);
    const frames = []; let at = Date.now();
    for (let i = 0; i < n; i++) { at += 16; await wheel(p.x, p.y, dy, at); if (i % 4 === 3) { const s = await now(); frames.push({ when: `step ${i + 1}`, ...s, img: await shot() }); } else await sleep(10); }
    const t0 = Date.now();
    for (const d of [30, 100, 250, 600]) { await sleep(Math.max(0, t0 + d - Date.now())); const s = await now(); frames.push({ when: `+${d}ms`, ...s, img: await shot() }); }
    const rows = [];
    for (const f of frames) {
      await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange=''; cv.classList.remove('anim'); cv.style.transform=${JSON.stringify(f.tf)}; return true; })()`);
      await sleep(700);
      const a = byKind(f.img, f.rs), b = byKind(await shot(), f.rs);
      rows.push({ when: f.when, tf: f.tf, ratio: Object.fromEntries(Object.keys(a).map((k) => [k, +(a[k] / b[k]).toFixed(3)])) });
    }
    const last = frames.at(-1).tf;
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.transform=${JSON.stringify(last)}; return true; })()`);
    out.runs.push({ label, rows });
  }
  out.errors = c.errors.slice(0, 5);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  for (const r of out.runs) { console.log('--', r.label); for (const x of r.rows) console.log('  ', x.when.padEnd(9), JSON.stringify(x.ratio), x.tf.replace(/translate\([^)]*\) /, '')); }
  console.log('errors', JSON.stringify(out.errors));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




