// The window goes to a screen of another pixel density (1x -> 2x -> 1.5x -> 1x): after each change the canvas must
// sit on whole device pixels of the new screen, and text must be as sharp as a settled re-render of the same view.
import fs from 'node:fs'; import path from 'node:path';
const tree = path.resolve(process.argv[2]), outFile = path.resolve(process.argv[3]);
const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
let c; const ev = (x) => c.eval(x), sleep = L.sleep;
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const wheel = (x, y, dy, at) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: at / 1000 });
const now = () => ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'), v=document.getElementById('viewport').getBoundingClientRect(), d=devicePixelRatio, m=new DOMMatrixReadOnly(getComputedStyle(cv).transform); const rs=[...cv.querySelectorAll(':scope > .win.note .fnote, :scope > .win.term .xterm-screen')].map((e)=>{ const b=e.getBoundingClientRect(); const l=Math.max(b.left,v.left)+4,r=Math.min(b.right,v.right)-4,t=Math.max(b.top,v.top)+4,bt=Math.min(b.bottom,v.bottom)-4; return {x:l*d,y:t*d,w:(r-l)*d,h:(bt-t)*d}; }).filter((r)=>r.w>60&&r.h>40); return { dpr:d, tf:cv.style.transform, offX:+((m.m41*d)%1).toFixed(3), offY:+((m.m42*d)%1).toFixed(3), rs }; })()`);
const score = (img, rs) => { let s = 0, a = 0; for (const r of rs) { s += C.score(img, r) * r.w * r.h; a += r.w * r.h; } return a ? s / a : 0; };
const out = { tree, rows: [] };
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'dpr.log') }); c = await L.flowWindow(); await sleep(1500);
  const vp = await ev(`({w: innerWidth, h: innerHeight})`);
  // a view that is not on whole pixels: a small pinch out at an odd point
  let at = Date.now(); for (let i = 0; i < 3; i++) { at += 16; await wheel(503.3, 401.7, 3, at); await L.sleep(16); } await sleep(1200);
  for (const dpr of [1.5]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: dpr, mobile: false }); await sleep(900);
    const s = await now(), img = await shot();
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.transform=${JSON.stringify(s.tf)}; const d=devicePixelRatio, m=/translate\\(([-0-9.e]+)px, ([-0-9.e]+)px\\)/.exec(cv.style.transform); cv.style.transform=cv.style.transform.replace(/translate\\([^)]*\\)/, 'translate('+(Math.round(+m[1]*d)/d)+'px, '+(Math.round(+m[2]*d)/d)+'px)'); return true; })()`);
    await sleep(600);
    const ref = score(await shot(), s.rs);
    out.rows.push({ dpr: s.dpr, tf: s.tf, offDevicePx: [s.offX, s.offY], ratio: +(score(img, s.rs) / ref).toFixed(3) });
    await ev(`(() => { const s=__flow.state(); const ws=s.ws.find((w)=>w.id===s.ui.at); __flow.nav().setPan(ws, (ws.pan||0)/100*document.getElementById('viewport').getBoundingClientRect().width, false); return true; })()`); await sleep(300);
  }
  out.errors = c.errors.slice(0, 5);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  for (const r of out.rows) console.log('dpr', r.dpr, 'fraction of a device px', JSON.stringify(r.offDevicePx), 'sharp vs whole-pixel re-render', r.ratio, r.tf);
  console.log('errors', JSON.stringify(out.errors));
} finally { try { c && c.close(); } catch {} await L.stop(); }




