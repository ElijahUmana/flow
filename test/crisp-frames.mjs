// What the owner sees vs what Flow can draw at that exact spot. Real CDP input on our own profile drives a gesture;
// each captured frame records the canvas transform and its text regions (note bodies, page content). Afterwards every
// recorded transform is set again with the canvas un-promoted (a settled re-render of the identical view) and shot.
// ratio = sharpness(frame) / sharpness(re-render). 1 = as crisp as at rest; well below 1 = blurry, sharpens later.
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
// one round trip: transform, promotion, text regions (device px) at this instant
const now = () => ev(`(() => { const s=__flow.state(), id=s.ui.at, cv=document.querySelector('.ws[data-id="'+id+'"] > .canvas'), v=document.getElementById('viewport').getBoundingClientRect(), d=devicePixelRatio; const rs=[...cv.querySelectorAll(':scope > .win.note .fnote, :scope > .win.page webview')].map((e)=>{ const b=e.getBoundingClientRect(); const l=Math.max(b.left,v.left)+4,r=Math.min(b.right,v.right)-4,t=Math.max(b.top,v.top)+4,bt=Math.min(b.bottom,v.bottom)-4; return {k:e.tagName==='WEBVIEW'?'page':'note',x:l*d,y:t*d,w:(r-l)*d,h:(bt-t)*d}; }).filter((r)=>r.w>60&&r.h>40); return { tf: cv.style.transform, wc: cv.style.willChange, rs }; })()`);
const score = (img, rs) => { let s = 0, a = 0; for (const r of rs) { s += C.score(img, r) * r.w * r.h; a += r.w * r.h; } return a ? s / a : 0; };
const bare = () => ev(`(() => { const s=__flow.state(),v=document.getElementById('viewport').getBoundingClientRect(); for (const fy of [.5,.3,.7,.9,.15]) for (let x=v.left+v.width*.1;x<v.right-v.width*.1;x+=12){const y=v.top+v.height*fy,e=document.elementFromPoint(x,y);if(e&&e.closest('.ws[data-id="'+s.ui.at+'"]')&&!e.closest('.win,.away,#dock,.ov,.dock'))return{x,y};} return null; })()`);
async function rerender(tf) { await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange=''; cv.classList.remove('anim'); cv.style.transform=${JSON.stringify(tf)}; return true; })()`); await sleep(350); return shot(); }
const out = { tree, dpr: DPR, cases: [] };
async function zoomTo(dy, n) { const p = await bare(); let at = Date.now(); for (let i = 0; i < n; i++) { at += 16; await wheel(p.x, p.y, dy, at); await sleep(16); } await sleep(900); }
async function record(name, zlabel, act, until) {
  await sleep(700);
  const frames = [];
  await act(frames);
  const t0 = Date.now();
  while (Date.now() - t0 < until) { const s = await now(); frames.push({ t: Date.now() - t0, ...s, img: await shot() }); if (!s.wc && frames.length > 2 && !frames.at(-2).wc) break; }
  const settledTf = (await now()).tf;
  const rows = [];
  for (const f of frames) { if (!f.rs.length) continue; const ref = await rerender(f.tf); const a = score(f.img, f.rs), b = score(ref, f.rs); rows.push({ t: f.t, wc: f.wc, tf: f.tf, ratio: +(a / b).toFixed(3) }); }
  await ev(`(() => { const s=__flow.state(); __flow.nav().setPan(s.ws.find((w)=>w.id===s.ui.at), (s.ws.find((w)=>w.id===s.ui.at).pan||0)/100*document.getElementById('viewport').getBoundingClientRect().width, false); return true; })()`);
  const held = rows.filter((r) => r.wc), rest = rows.filter((r) => !r.wc);
  out.cases.push({ name, zoom: zlabel, settledTf, held: held.length, worstHeld: held.length ? Math.min(...held.map((r) => r.ratio)) : null, worstRest: rest.length ? Math.min(...rest.map((r) => r.ratio)) : null, rows });
}
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'frames.log') }); c = await L.flowWindow(); await sleep(1500);
  if (DPR !== 1) { const vp = await ev(`({w: innerWidth, h: innerHeight})`); await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: DPR, mobile: false }); await sleep(1000); }
  await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await sleep(2500);
  for (const [zlabel, dy, n] of [['1', 0, 0], ['0.86', 3, 5], ['1.27', -4, 7]]) {
    if (n) await zoomTo(dy, n);
    await record('glide', zlabel, async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 5; i++) { at += 16; await mouse('mouseMoved', p.x - i * 9, p.y - i * 2, { down: true, at }); await sleep(16); } await mouse('mouseReleased', p.x - 45, p.y - 10, { at: at + 4 }); }, 3000);
    let hp;
    await record('held-still', zlabel, async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 5; i++) { at += 16; await mouse('mouseMoved', p.x + i * 7, p.y + i * 3, { down: true, at }); await sleep(16); } hp = { x: p.x + 35, y: p.y + 15 }; await sleep(300); }, 600);
    await mouse('mouseReleased', hp.x, hp.y, { at: Date.now() }); await sleep(400);
    await record('held-pinch', zlabel, async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 3; i++) { at += 16; await mouse('mouseMoved', p.x - i * 6, p.y, { down: true, at }); await sleep(16); } at = Date.now(); for (let i = 0; i < 5; i++) { at += 16; await wheel(p.x - 18, p.y, -6, at, 1); await sleep(16); } hp = { x: p.x - 18, y: p.y }; await sleep(300); }, 600);
    await mouse('mouseReleased', hp.x, hp.y, { at: Date.now() }); await sleep(500);
    await zoomTo(6, 4);
  }
  out.errors = c.errors.slice(0, 5);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  for (const k of out.cases) console.log(`zoom ${k.zoom.padEnd(5)} ${k.name.padEnd(11)} heldFrames ${k.held}  worstHeld ${k.worstHeld}  worstRest ${k.worstRest}  ${k.rows.map((r) => (r.wc ? '*' : '') + r.ratio).join(' ')}`);
  console.log('errors', JSON.stringify(out.errors));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




