// The owner's cases, real CDP input on our own profile. Each frame's content sharpness is divided by the sharpness of the
// same windows once settled (press released / glide over / pinch over), so 1 = as crisp as Flow can draw it.
//  glide-tail: a flick, frames through the slow end of the glide (the "blurry, then it sharpens by itself" moment)
//  held-still: a drag at a fractional zoom, then held still, before release (no glide under MAC_NOTES 49)
//  held-pinch: press, move, pinch with the press down, hold still
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const tree = path.resolve(process.argv[2]), outFile = path.resolve(process.argv[3]), DPR = +(process.argv[4] || 1);
const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(here, 'crisp-pages/text.html'))); });
await new Promise((ok) => srv.listen(9783, '127.0.0.1', ok));
let c; const ev = (x) => c.eval(x), sleep = L.sleep;
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const mouse = (type, x, y, o = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !o.down ? 'none' : 'left', buttons: type === 'mousePressed' || o.down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse', ...(o.at != null ? { timestamp: o.at / 1000 } : {}) });
const wheel = (x, y, dy, at, buttons = 0) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons, pointerType: 'mouse', timestamp: at / 1000 });
const state = () => ev(`(() => { const s=__flow.state(), ws=s.ws.find((w)=>w.id===s.ui.at), cv=document.querySelector('.ws[data-id="'+ws.id+'"] > .canvas'), v=document.getElementById('viewport').getBoundingClientRect(); return { z:ws.zoom||1, x:(ws.pan||0)/100*v.width, y:(ws.panY||0)/100*v.height, tf:cv.style.transform, wc:cv.style.willChange }; })()`);
const regs = () => ev(`(() => { const s=__flow.state(), v=document.getElementById('viewport').getBoundingClientRect(), d=devicePixelRatio; return [...document.querySelectorAll('.ws[data-id="'+s.ui.at+'"] > .canvas > .win')].filter((w)=>w.style.display!=='none').map((w)=>{ const tb=w.querySelector(':scope > .tb'), b=w.getBoundingClientRect(), t=tb?tb.getBoundingClientRect().bottom:b.top; const l=Math.max(b.left,v.left)+4,r=Math.min(b.right,v.right)-4,top=Math.max(t,v.top)+4,bot=Math.min(b.bottom,v.bottom)-4; return {id:w.dataset.id,kind:w.classList.contains('page')?'page':w.classList.contains('note')?'note':'term',x:l*d,y:top*d,w:(r-l)*d,h:(bot-top)*d}; }).filter((r)=>r.w>80&&r.h>80); })()`);
const bare = () => ev(`(() => { const s=__flow.state(),v=document.getElementById('viewport').getBoundingClientRect(); for (const fy of [.5,.3,.7,.9,.15]) for (let x=v.left+v.width*.1;x<v.right-v.width*.1;x+=12){const y=v.top+v.height*fy,e=document.elementFromPoint(x,y);if(e&&e.closest('.ws[data-id="'+s.ui.at+'"]')&&!e.closest('.win,.away,#dock,.ov,.dock'))return{x,y};} return null; })()`);
const total = (img, R) => R.reduce((a, r) => a + C.score(img, r) * r.w * r.h, 0) / R.reduce((a, r) => a + r.w * r.h, 0);
const out = { tree, dpr: DPR, cases: [] };
async function zoomTo(dy, n) { const p = await bare(); let at = Date.now(); for (let i = 0; i < n; i++) { at += 16; await wheel(p.x, p.y, dy, at); await sleep(16); } await sleep(900); }
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'owner.log') }); c = await L.flowWindow(); await sleep(1500);
  if (DPR !== 1) { const vp = await ev(`({w: innerWidth, h: innerHeight})`); await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: DPR, mobile: false }); await sleep(1000); }
  await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await sleep(2500);
  for (const [zlabel, dy, n] of [['zoom 1', 0, 0], ['zoom 0.86', 3, 5], ['zoom 1.27', -4, 6]]) {
    if (n) await zoomTo(dy, n);
    // glide tail
    { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 });
      for (let i = 1; i <= 5; i++) { at += 16; await mouse('mouseMoved', p.x - i * 9, p.y - i * 2, { down: true, at }); await sleep(16); }
      await mouse('mouseReleased', p.x - 45, p.y - 10, { at: at + 4 });
      const frames = []; const t0 = Date.now(); let last = null;
      while (Date.now() - t0 < 2500) { const s = await state(); const img = await shot(); frames.push({ t: Date.now() - t0, s, img }); if (!s.wc && last && !last.wc) break; last = s; }
      await sleep(400); const R = await regs(), ref = total(await shot(), R);
      const moving = frames.filter((f) => f.s.wc);
      out.cases.push({ zoom: zlabel, case: 'glide-tail', frames: moving.length, worst: +Math.min(...moving.map((f) => total(f.img, R) / ref)).toFixed(3), tail: moving.slice(-4).map((f) => [f.t, +(total(f.img, R) / ref).toFixed(3), f.s.tf]) }); }
    // held still after a drag
    { await sleep(600); const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 });
      for (let i = 1; i <= 5; i++) { at += 16; await mouse('mouseMoved', p.x + i * 7, p.y + i * 3, { down: true, at }); await sleep(16); }
      await sleep(400); const R = await regs(), held = total(await shot(), R), hs = await state();
      await mouse('mouseReleased', p.x + 35, p.y + 15, { at: Date.now() }); await sleep(500); const rs = await state(), ref = total(await shot(), R);
      out.cases.push({ zoom: zlabel, case: 'held-still', ratio: +(held / ref).toFixed(3), heldTf: hs.tf, relTf: rs.tf, sameView: Math.abs(hs.x - rs.x) < 0.01 && Math.abs(hs.y - rs.y) < 0.01 }); }
    // pinch with the press down, then held still
    { await sleep(600); const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 });
      for (let i = 1; i <= 3; i++) { at += 16; await mouse('mouseMoved', p.x - i * 6, p.y, { down: true, at }); await sleep(16); }
      at = Date.now(); for (let i = 0; i < 5; i++) { at += 16; await wheel(p.x - 18, p.y, -6, at, 1); await sleep(16); }
      await sleep(500); const R = await regs(), held = total(await shot(), R), hs = await state();
      await mouse('mouseReleased', p.x - 18, p.y, { at: Date.now() }); await sleep(600); const rs = await state(), ref = total(await shot(), R);
      out.cases.push({ zoom: zlabel, case: 'held-pinch', ratio: +(held / ref).toFixed(3), z: +hs.z.toFixed(3), sameView: Math.abs(hs.x - rs.x) < 0.01 && Math.abs(hs.z - rs.z) < 1e-6 });
      await zoomTo(6, 4); }
  }
  out.errors = c.errors.slice(0, 5);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  for (const k of out.cases) console.log(k.zoom.padEnd(10), k.case.padEnd(11), k.worst ?? k.ratio, k.frames != null ? `frames ${k.frames}` : `sameView ${k.sameView}`);
  console.log('errors', JSON.stringify(out.errors));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




