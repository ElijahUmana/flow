// Transient blur probe: after each real-input gesture, screenshots at fixed delays; every window's content region is
// scored for sharpness and compared with the same region once fully settled (late). early/late well below 1 = the
// owner's "blurry, then it sharpens by itself".
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const tree = path.resolve(process.argv[2]), outDir = path.resolve(process.argv[3]);
const only = process.argv[4] && process.argv[4] !== 'all' ? process.argv[4].split(',') : null;
const DPR = +(process.argv[5] || 1);
fs.mkdirSync(outDir, { recursive: true });
const L = await import(path.join(tree, 'test/zoom-lib.mjs'));
const here = path.dirname(new URL(import.meta.url).pathname);
const C = await import(path.join(here, 'crisp-lib.mjs'));
const pages = path.join(here, 'crisp-pages');
const srv = http.createServer((q, r) => { const f = path.join(pages, path.basename(new URL(q.url, 'http://x').pathname) || 'text.html'); if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(f)); });
await new Promise((ok) => srv.listen(9783, '127.0.0.1', ok));
const DELAYS = [30, 120, 300, 700, 1500, 3000];
let c; const out = { tree, scenarios: [] };
const ev = (x) => c.eval(x), sleep = L.sleep;
const shot = async () => C.gray(Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const regions = () => ev(`(() => { const s=__flow.state(), id=s.ui.at, v=document.getElementById('viewport').getBoundingClientRect(), dpr=devicePixelRatio; return [...document.querySelectorAll('.ws[data-id="'+id+'"] > .canvas > .win')].filter((w)=>w.style.display!=='none').map((w)=>{ const tb=w.querySelector(':scope > .tb'), b=w.getBoundingClientRect(), t=tb?tb.getBoundingClientRect().bottom:b.top; const l=Math.max(b.left,v.left)+3, r=Math.min(b.right,v.right)-3, top=Math.max(t,v.top)+3, bot=Math.min(b.bottom,v.bottom)-3; return { id:w.dataset.id, kind:[...w.classList].filter((k)=>k!=='win').join('.'), x:l*dpr, y:top*dpr, w:(r-l)*dpr, h:(bot-top)*dpr }; }).filter((r)=>r.w>40&&r.h>40); })()`);
const view = () => ev(`(() => { const s=__flow.state(), ws=s.ws.find((w)=>w.id===s.ui.at), cv=document.querySelector('.ws[data-id="'+ws.id+'"] > .canvas'); return { ws:ws.id, z:ws.zoom||1, pan:ws.pan||0, panY:ws.panY||0, wc:cv.style.willChange, tf:cv.style.transform }; })()`);
const bare = () => ev(`(() => { const s=__flow.state(),v=document.getElementById('viewport').getBoundingClientRect(); for (const fy of [.5,.3,.7,.9,.15]) for (let x=v.left+v.width*.1;x<v.right-v.width*.1;x+=12){const y=v.top+v.height*fy,e=document.elementFromPoint(x,y);if(e&&e.closest('.ws[data-id="'+s.ui.at+'"]')&&!e.closest('.win,.away,#dock,.ov,.dock'))return{x,y};} return null; })()`);
const mouse = (type, x, y, o = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !o.down ? 'none' : 'left', buttons: type === 'mousePressed' || o.down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse', ...(o.at != null ? { timestamp: o.at / 1000 } : {}) });
const wheel = (x, y, dy, at, buttons = 0) => c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2, button: 'none', buttons, pointerType: 'mouse', timestamp: at / 1000 });
async function pinch(dy, n, at0, p, buttons = 0) { let at = at0; for (let i = 0; i < n; i++) { at += 16; await wheel(p.x, p.y, dy, at, buttons); await sleep(16); } return at; }
async function trace(name, act) {
  if (only && !only.includes(name)) return;
  await sleep(1200);
  const pre = await view();
  const t0 = await act();
  const t = t0 ?? Date.now(), shots = [];
  for (const d of DELAYS) { await sleep(Math.max(0, t + d - Date.now())); shots.push({ d, img: await shot(), v: await view() }); }
  const regs = await regions(), late = shots.at(-1).img;
  fs.writeFileSync(path.join(outDir, `${name}-late.gray`), late.px);
  const rows = regs.map((r) => { const s = shots.map((x) => C.score(x.img, r)), ref = s.at(-1) || 1; return { id: r.id, kind: r.kind, ref: +ref.toFixed(1), ratio: s.map((x) => +(x / ref).toFixed(3)), diff: shots.map((x) => +C.diff(x.img, late, r).toFixed(2)) }; });
  const worst = Math.min(...rows.flatMap((r) => r.ratio.slice(0, -1)));
  const row = { name, pre, views: shots.map((x) => ({ d: x.d, z: +x.v.z.toFixed(4), wc: x.v.wc })), delays: DELAYS, regions: rows, worst: +worst.toFixed(3) };
  out.scenarios.push(row);
  console.error(`${name}: worst early/late ${row.worst}  ${rows.map((r) => r.id + ' ' + r.ratio.join('/')).join('  ')}`);
}
try {
  await L.writeSeed();
  L.launch({ log: path.join(L.USER_DATA, 'crisp.log') });
  c = await L.flowWindow(); await sleep(1500);
  if (DPR !== 1) { const vp = await ev(`({w: innerWidth, h: innerHeight})`); await c.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: DPR, mobile: false }); await sleep(1000); }
  out.dpr = await ev('devicePixelRatio');
  await ev(`__flow.openPage('http://127.0.0.1:9783/text.html')`); await sleep(2500);
  const P = await bare();
  // reset to 100% around the middle, settled
  const reset = async () => { await ev(`(() => { const s=__flow.state(); const ws=s.ws.find((w)=>w.id===s.ui.at); return true; })()`); };
  await trace('settled-start', async () => Date.now());
  await trace('pinch-in', async () => { const at = await pinch(-8, 6, Date.now(), P); return Date.now(); });
  await trace('pinch-out', async () => { await pinch(10, 8, Date.now(), P); return Date.now(); });
  await trace('pan-glide', async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 6; i++) { at += 16; await mouse('mouseMoved', p.x - i * 10, p.y, { down: true, at }); await sleep(16); } await mouse('mouseReleased', p.x - 60, p.y, { at: at + 4 }); return Date.now(); });
  await trace('pan-rest', async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 6; i++) { at += 16; await mouse('mouseMoved', p.x + i * 10, p.y, { down: true, at }); await sleep(16); } await sleep(200); await mouse('mouseReleased', p.x + 60, p.y, { at: Date.now() }); return Date.now(); });
  await trace('held-pinch-release', async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 3; i++) { at += 16; await mouse('mouseMoved', p.x - i * 6, p.y, { down: true, at }); await sleep(16); } await pinch(-8, 6, Date.now(), { x: p.x - 18, y: p.y }, 1); await sleep(200); await mouse('mouseReleased', p.x - 18, p.y, { at: Date.now() }); return Date.now(); });
  let held = null;
  await trace('pan-held-still', async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 5; i++) { at += 16; await mouse('mouseMoved', p.x - i * 7, p.y - i * 3, { down: true, at }); await sleep(16); } held = { x: p.x - 35, y: p.y - 15 }; return Date.now(); });
  await mouse('mouseReleased', held.x, held.y, { at: Date.now() }); await sleep(300);
  await trace('pinch-while-held', async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 3; i++) { at += 16; await mouse('mouseMoved', p.x - i * 6, p.y, { down: true, at }); await sleep(16); } await pinch(-8, 6, Date.now(), { x: p.x - 18, y: p.y }, 1); held = { x: p.x - 18, y: p.y }; return Date.now(); });
  await mouse('mouseReleased', held.x, held.y, { at: Date.now() }); await sleep(300);
  await trace('long-glide', async () => { const p = await bare(); let at = Date.now(); await mouse('mouseMoved', p.x, p.y, { at }); await mouse('mousePressed', p.x, p.y, { at: at + 1 }); for (let i = 1; i <= 6; i++) { at += 16; await mouse('mouseMoved', p.x + i * 25, p.y + i * 3, { down: true, at }); await sleep(16); } await mouse('mouseReleased', p.x + 150, p.y + 18, { at: at + 4 }); return Date.now(); });
  await trace('actual-size-anim', async () => { await ev(`(() => { const s=__flow.state(); __flow.nav().actualSize(s.ws.find((w)=>w.id===s.ui.at)); return true; })()`); return Date.now(); });
  out.errors = c.errors.slice(0, 10);
  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ dpr: out.dpr, worst: Object.fromEntries(out.scenarios.map((s) => [s.name, s.worst])), errors: out.errors }));
} finally { try { c && c.close(); } catch {} srv.close(); await L.stop(); }




