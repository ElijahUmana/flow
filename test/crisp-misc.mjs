// Remaining owner paths, each frame against a settled re-render of the identical view:
//  far-titles: pinch far out (below TITLED), title bars are drawn at 100% size; frames right after and later
//  window-resize: the Flow window itself resizes (viewport ResizeObserver path)
//  sub-space swipe: two-finger swipe to the research space and back; frames after it lands
import fs from 'node:fs'; import path from 'node:path';
const tree = path.resolve(process.argv[2]), outFile = path.resolve(process.argv[3]), DPR = +(process.argv[4] || 1);
const here = path.dirname(new URL(import.meta.url).pathname);
const L = await import(path.join(tree, 'test/zoom-lib.mjs')); const C = await import(path.join(here, 'crisp-lib.mjs'));
let c; const ev = (x) => c.eval(x), sleep = L.sleep;
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const wheel = (x, y, dy, at) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: at / 1000 });
const now = (sel) => ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'), v=document.getElementById('viewport').getBoundingClientRect(), d=devicePixelRatio; const rs=[...cv.querySelectorAll(${JSON.stringify(sel)})].filter((e)=>e.offsetParent).map((e)=>{ const b=e.getBoundingClientRect(); const l=Math.max(b.left,v.left)+2,r=Math.min(b.right,v.right)-2,t=Math.max(b.top,v.top)+2,bt=Math.min(b.bottom,v.bottom)-2; return {x:l*d,y:t*d,w:(r-l)*d,h:(bt-t)*d}; }).filter((r)=>r.w>30&&r.h>8); return { tf:cv.style.transform, sp:s.ws.find((w)=>w.id===s.ui.at).at||null, rs }; })()`);
const score = (img, rs) => { let s = 0, a = 0; for (const r of rs) { s += C.score(img, r) * r.w * r.h; a += r.w * r.h; } return a ? s / a : 0; };
const out = { tree, dpr: DPR, runs: [] };
async function judge(label, frames, sel) {
  const rows = [];
  for (const f of frames) { if (!f.rs.length) continue;
    await ev(`(() => { const s=__flow.state(), cv=document.querySelector('.ws[data-id="'+s.ui.at+'"] > .canvas'); cv.style.willChange=''; cv.classList.remove('anim'); cv.style.transform=${JSON.stringify(f.tf)}; return true; })()`); await sleep(1300);
    rows.push({ when: f.when, ratio: +(score(f.img, f.rs) / score(await shot(), f.rs)).toFixed(3) }); }
  out.runs.push({ label, rows });
}
try {
  await L.writeSeed(); L.launch({ log: path.join(L.USER_DATA, 'misc.log') }); c = await L.flowWindow(); await sleep(1500);
  const vp = await ev(`({w: innerWidth, h: innerHeight})`);
  if (DPR !== 1) { await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: DPR, mobile: false }); await sleep(1200); }
  // far out: title bars drawn at their 100% size
  { const sel = ':scope > .win > .tb'; let at = Date.now(); for (let i = 0; i < 26; i++) { at += 16; await wheel(vp.w * 0.5, vp.h * 0.45, 9, at); await sleep(16); }
    const f = []; const t0 = Date.now(); for (const d of [30, 150, 400, 1200]) { await sleep(Math.max(0, t0 + d - Date.now())); f.push({ when: `+${d}`, ...(await now(sel)), img: await shot() }); }
    await judge(`far-out titles (z ${await ev("(() => { const s=__flow.state(); return +(s.ws.find((w)=>w.id===s.ui.at).zoom).toFixed(3); })()")})`, f, sel);
    at = Date.now(); for (let i = 0; i < 26; i++) { at += 16; await wheel(vp.w * 0.5, vp.h * 0.45, -9, at); await sleep(16); } await sleep(1500); }
  // the Flow window resizes
  { const sel = ':scope > .win.note .fnote, :scope > .win.term .xterm-screen'; const f = [];
    await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w - 137, height: vp.h - 61, deviceScaleFactor: DPR, mobile: false });
    const t0 = Date.now(); for (const d of [30, 150, 400, 1200]) { await sleep(Math.max(0, t0 + d - Date.now())); f.push({ when: `+${d}`, ...(await now(sel)), img: await shot() }); }
    await judge('window resize', f, sel);
    await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: DPR, mobile: false }); await sleep(1200); }
  // two-finger swipe to the next sub-space
  { const sel = ':scope > .win.note .fnote, :scope > .win.term .xterm-screen, :scope > .win.page webview'; const SW = [8,18,30,42,46,40,34,28,22,18,14,11,9,7,5,4,3,2,2,1];
    const p = await ev(`(() => { const s=__flow.state(),v=document.getElementById('viewport').getBoundingClientRect(); for (let x=v.left+v.width*.15;x<v.right-v.width*.12;x+=16){const y=v.top+v.height*.5,e=document.elementFromPoint(x,y);if(e&&e.closest('.ws[data-id="'+s.ui.at+'"]')&&!e.closest('.win,.away,#dock,.ov'))return{x,y};} return {x:v.left+20,y:v.top+v.height/2}; })()`);
    await L.swipe(c, p.x, p.y, SW); await L.waitFor(async () => (await now(sel)).sp === 'z-research' || null, 5000, 'research space');
    const f = []; const t0 = Date.now(); for (const d of [0, 120, 400, 1200]) { await sleep(Math.max(0, t0 + d - Date.now())); f.push({ when: `landed +${d}`, ...(await now(sel)), img: await shot() }); }
    await judge('two-finger swipe to a sub-space', f, sel); }
  out.errors = c.errors.slice(0, 5);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  for (const r of out.runs) console.log(r.label.padEnd(36), r.rows.map((x) => `${x.when}:${x.ratio}`).join('  '));
  console.log('errors', JSON.stringify(out.errors));
} finally { try { c && c.close(); } catch {} await L.stop(); }




