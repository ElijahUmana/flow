// Same-transform check for the paths that change scale while a layer is promoted or animating:
//  actual-size: ⌘0 (nav.actualSize), the board's animated zoom back to 100%
//  pinch-in-glide: a pinch arriving while a glide is still running
//  held-pinch-long: press, move, pinch with the press down, then hold 1.5 s
// Each frame's on-screen matrix (computed style, so mid-transition too) is set again un-promoted and left to settle;
// ratio = sharpness(frame) / sharpness(settled re-render), per content kind. Below 1 = softer than Flow can draw.
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
const now = () => ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'), v=document.getElementById('viewport').getBoundingClientRect(), d=devicePixelRatio; const pick=(e,k)=>{ if(!e) return null; const b=e.getBoundingClientRect(); const l=Math.max(b.left,v.left)+4,r=Math.min(b.right,v.right)-4,t=Math.max(b.top,v.top)+4,bt=Math.min(b.bottom,v.bottom)-4; return r-l>60&&bt-t>40?{k,x:l*d,y:t*d,w:(r-l)*d,h:(bt-t)*d}:null; }; return { m: getComputedStyle(cv).transform, wc: cv.style.willChange, rs: [...cv.querySelectorAll(':scope > .win.page webview')].map((e)=>pick(e,'page')).concat([...cv.querySelectorAll(':scope > .win.note .fnote')].map((e)=>pick(e,'note')), [...cv.querySelectorAll(':scope > .win.term .xterm-screen')].map((e)=>pick(e,'term'))).filter(Boolean) }; })()`);
const byKind = (img, rs) => { const o = {}; for (const r of rs) { (o[r.k] ||= [0, 0]); o[r.k][0] += C.score(img, r) * r.w * r.h; o[r.k][1] += r.w * r.h; } return Object.fromEntries(Object.entries(o).map(([k, [s, a]]) => [k, s / a])); };
const bare = () => ev(`(() => { const s=__flow.state(),v=document.getElementById('viewport').getBoundingClientRect(); for (const fy of [.5,.3,.7,.9,.15]) for (let x=v.left+v.width*.1;x<v.right-v.width*.1;x+=12){const y=v.top+v.height*fy,e=document.elementFromPoint(x,y);if(e&&e.closest('.ws[data-id="'+s.ui.at+'"]')&&!e.closest('.win,.away,#dock,.ov,.dock'))return{x,y};} return null; })()`);
const out = { tree, dpr: DPR, runs: [] };
async function judge(label, frames) {
  const keep = await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); return cv.style.transform; })()`);
  const rows = [];
  for (const f of frames) {
    if (!f.rs.length) continue;
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.classList.remove('anim'); cv.style.willChange=''; cv.style.transform=${JSON.stringify(f.m)}; return true; })()`);
    await sleep(700);
    const a = byKind(f.img, f.rs), b = byKind(await shot(), f.rs);
    rows.push({ when: f.when, wc: f.wc, scale: f.m === "none" ? 1 : +(+f.m.match(/matrix\(([^,]+)/)[1]).toFixed(4), ratio: Object.fromEntries(Object.keys(a).map((k) => [k, +(a[k] / b[k]).toFixed(3)])) });
  }
  await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.transform=${JSON.stringify(keep)}; return true; })()`);
  out.runs.push({ label, rows });
}
async function frames(list, when) { const s = await now(); list.push({ when, ...s, img: await shot() }); }
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'anim.log') }); c = await L.flowWindow(); await sleep(1500);
  if (DPR !== 1) { const vp = await ev(`({w: innerWidth, h: innerHeight})`); await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: DPR, mobile: false }); await sleep(1200); }
  await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await sleep(3000);
  // actual size from zoomed out, then from zoomed in
  for (const [label, dy, n] of [['actual-size from 0.55', 6, 10], ['actual-size from 1.8', -6, 10]]) {
    const p = await bare(); let at = Date.now(); for (let i = 0; i < n; i++) { at += 16; await wheel(p.x, p.y, dy, at); await sleep(16); } await sleep(1200);
    const f = []; await ev(`(() => { const s=__flow.state(); __flow.nav().actualSize(s.ws.find((w)=>w.id===s.ui.at)); return true; })()`);
    const t0 = Date.now(); for (const d of [40, 120, 220, 330, 600, 1200]) { await sleep(Math.max(0, t0 + d - Date.now())); await frames(f, `+${d}`); }
    await judge(label, f);
  }
  // a pinch while a glide still runs
  { await sleep(1000); const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 });
    for (let i = 1; i <= 6; i++) { at += 16; await mouse('mouseMoved', p.x - i * 20, p.y, { down: true, at }); await sleep(16); }
    await mouse('mouseReleased', p.x - 120, p.y, { at: at + 4 }); await sleep(60);
    const f = []; at = Date.now(); for (let i = 0; i < 8; i++) { at += 16; await wheel(p.x - 120, p.y, -6, at); await sleep(16); if (i % 3 === 2) await frames(f, `step ${i + 1}`); }
    const t0 = Date.now(); for (const d of [40, 200, 700]) { await sleep(Math.max(0, t0 + d - Date.now())); await frames(f, `+${d}`); }
    await judge('pinch during glide', f); }
  // held pinch, long hold
  { await sleep(1000); const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 });
    for (let i = 1; i <= 3; i++) { at += 16; await mouse('mouseMoved', p.x - i * 6, p.y, { down: true, at }); await sleep(16); }
    const f = []; at = Date.now(); for (let i = 0; i < 8; i++) { at += 16; await wheel(p.x - 18, p.y, 7, at, 1); await sleep(16); if (i % 3 === 2) await frames(f, `step ${i + 1}`); }
    const t0 = Date.now(); for (const d of [60, 400, 1500]) { await sleep(Math.max(0, t0 + d - Date.now())); await frames(f, `held +${d}`); }
    await mouse('mouseReleased', p.x - 18, p.y, { at: Date.now() }); await sleep(80); await frames(f, 'released +80');
    await judge('held pinch then hold', f); }
  out.errors = c.errors.slice(0, 5);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  for (const r of out.runs) { console.log('--', r.label); for (const x of r.rows) console.log('  ', x.when.padEnd(12), (x.wc ? '*' : ' '), String(x.scale).padEnd(7), JSON.stringify(x.ratio)); }
  console.log('errors', JSON.stringify(out.errors));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




