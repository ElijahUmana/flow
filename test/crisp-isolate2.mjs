// A layer kept with will-change and then moved/scaled, against the same transform rastered fresh (will-change off).
// ratio < 1 means the frame on screen is softer than what the same view gives once it re-rasters.
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const tree = path.resolve(process.argv[2]); const dprs = (process.argv[3] || '1,2').split(',').map(Number); const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(here, 'crisp-pages/text.html'))); });
await new Promise((ok) => srv.listen(9783, '127.0.0.1', ok));
let c; const ev = (x) => c.eval(x);
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const set = (tf, wc) => ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); ${tf ? `cv.style.transform='${tf}';` : ''} ${wc !== undefined ? `cv.style.willChange='${wc}';` : ''} return true; })()`);
const regs = (dpr) => ev(`(() => { const s=__flow.state(), v=document.getElementById('viewport').getBoundingClientRect(); return [...document.querySelectorAll('.ws[data-id="'+s.ui.at+'"] > .canvas > .win')].filter((w)=>w.style.display!=='none'&&!w.classList.contains('term')).map((w)=>{ const tb=w.querySelector(':scope > .tb'), b=w.getBoundingClientRect(), t=tb?tb.getBoundingClientRect().bottom:b.top; const l=Math.max(b.left,v.left)+3,r=Math.min(b.right,v.right)-3,top=Math.max(t,v.top)+3,bot=Math.min(b.bottom,v.bottom)-3; return {id:w.dataset.id,kind:w.classList.contains('page')?'page':'note',x:l*${dpr},y:top*${dpr},w:(r-l)*${dpr},h:(bot-top)*${dpr}}; }).filter((r)=>r.w>60&&r.h>60); })()`);
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'iso2.log') }); c = await L.flowWindow(); await L.sleep(1500);
  await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await L.sleep(2500);
  const out = [];
  for (const dpr of dprs) {
    const vp = await ev(`({w: innerWidth, h: innerHeight})`);
    await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: dpr, mobile: false }); await L.sleep(800);
    const cases = [
      ['pan by half a device px', 'translate(-40px,-20px) scale(1)', `translate(${-40 + 0.5 / dpr}px,${-20 + 0.5 / dpr}px) scale(1)`],
      ['pan by a third px at 0.83', 'translate(-40px,-20px) scale(0.83)', `translate(${-40 + 1 / 3}px,-20px) scale(0.83)`],
      ['pan whole device px', 'translate(-40px,-20px) scale(1)', `translate(${-40 + 7 / dpr}px,${-20 + 3 / dpr}px) scale(1)`],
      ['pinch in 1 -> 1.5 while held', 'translate(-40px,-20px) scale(1)', 'translate(-40px,-20px) scale(1.5)'],
      ['pinch in 0.6 -> 1 while held', 'translate(-40px,-20px) scale(0.6)', 'translate(-40px,-20px) scale(1)'],
      ['pinch out 1 -> 0.5 while held', 'translate(-40px,-20px) scale(1)', 'translate(-40px,-20px) scale(0.5)'],
    ];
    for (const [name, a, b] of cases) {
      await set(a, ''); await L.sleep(300); await set(null, 'transform'); await L.sleep(300); await set(b); await L.sleep(400);
      const R = await regs(dpr), held = await shot();
      await set(null, ''); await L.sleep(400); const fresh = await shot();
      out.push({ dpr, name, ratio: Object.fromEntries(R.map((r) => [r.kind + ':' + r.id, +(C.score(held, r) / C.score(fresh, r)).toFixed(3)])), diff: Object.fromEntries(R.map((r) => [r.kind + ':' + r.id, +C.diff(held, fresh, r).toFixed(2)])) });
    }
  }
  console.log(JSON.stringify({ out, errors: c.errors.slice(0, 5) }));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




