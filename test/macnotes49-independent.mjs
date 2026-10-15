import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '');
if (!root) throw new Error('candidate tree required');
const L = await import(path.join(root, 'test/zoom-lib.mjs'));
const navHash = crypto.createHash('md5').update(fs.readFileSync(path.join(root, 'src/nav.js'))).digest('hex');
const navSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/nav.js'))).digest('hex');
const out = { root, navHash, navSha, gestures: [] };
const SW = [8,18,30,42,46,40,34,28,22,18,14,11,9,7,5,4,3,2,2,1];
let c, m;
const ev = (x) => c.eval(x);
const sleep = L.sleep;
const near = (a,b,d=.35) => Math.abs(a-b)<=d;
const sign = (v) => v < -.08 ? -1 : v > .08 ? 1 : 0;
const mouse = (type,x,y,{down=false,at}={}) => c.send('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'&&!down?'none':'left',buttons:type==='mousePressed'||down?1:0,clickCount:type==='mouseMoved'?0:1,pointerType:'mouse',...(at==null?{}:{timestamp:at/1000})});
const view = () => ev(`(() => {const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at),v=document.getElementById('viewport').getBoundingClientRect(),cv=document.querySelector('.ws[data-id="'+ws.id+'"] > .canvas'),mx=new DOMMatrixReadOnly(getComputedStyle(cv).transform);return{ws:ws.id,sp:ws.at||null,x:((ws.pan||0)/100)*v.width,y:((ws.panY||0)/100)*v.height,z:ws.zoom||1,dx:-mx.m41/mx.a,dy:-mx.m42/mx.a,dz:mx.a,moving:cv.style.willChange==='transform'};})()`);
const bare = () => ev(`(() => {const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at),v=document.getElementById('viewport').getBoundingClientRect(),top=Math.max(v.top,document.querySelector('.menubar').getBoundingClientRect().bottom)+4;for(const fy of [.25,.72,.45,.85,.15])for(let x=v.left+v.width*.15;x<v.right-v.width*.12;x+=16){const y=v.top+v.height*fy,e=document.elementFromPoint(x,y);if(e&&e.closest('.ws[data-id="'+ws.id+'"]')&&!e.closest('.win,.away,#dock,.ov'))return{x,y};}return null;})()`);
async function waitStopped(ms=2500){let last=null,stable=0;const end=Date.now()+ms;while(Date.now()<end){const v=await view();if(last&&near(v.x,last.x,.06)&&near(v.y,last.y,.06)&&!v.moving)stable++;else stable=0;if(stable>=3)return v;last=v;await sleep(50);}throw new Error(`glide did not stop: ${JSON.stringify(await view())}`);}
async function stopMotion(){await sleep(520);const p=await bare();if(p){const t=Date.now();await mouse('mouseMoved',p.x,p.y,{at:t});await mouse('mousePressed',p.x,p.y,{at:t+1});await mouse('mouseReleased',p.x,p.y,{at:t+2});}await sleep(520);}
async function gesture(name,{points=[],gaps=[],hold=0,pause=0,stillEvery=0,releaseAt=null,expectGlide=true}){
  await stopMotion();const p=await bare();if(!p)throw new Error(`no bare point for ${name}`);const before=await view();let at=Date.now()+20;await mouse('mouseMoved',p.x,p.y,{at});await mouse('mousePressed',p.x,p.y,{at:at+2});if(hold)await sleep(hold);at+=hold+2;
  let last={x:0,y:0},prior={x:0,y:0},lastNonzero={x:0,y:0};
  for(let i=0;i<points.length;i++){const gap=gaps[i]??gaps.at(-1)??16;await sleep(gap);at+=gap;prior=last;last=points[i];const d={x:last.x-prior.x,y:last.y-prior.y};if(d.x||d.y)lastNonzero=d;await mouse('mouseMoved',p.x+last.x,p.y+last.y,{down:true,at});}
  const held=await view();if(pause){if(stillEvery){let elapsed=0;while(elapsed<pause){const d=Math.min(stillEvery,pause-elapsed);await sleep(d);elapsed+=d;at+=d;await mouse('mouseMoved',p.x+last.x,p.y+last.y,{down:true,at});}}else{await sleep(pause);at+=pause;}}
  const final=releaseAt||last,dFinal={x:final.x-last.x,y:final.y-last.y};if(dFinal.x||dFinal.y)lastNonzero=dFinal;
  await ev(`(() => {window.__m48Release=null;document.addEventListener('pointerup',()=>{const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at),v=document.getElementById('viewport').getBoundingClientRect(),cv=document.querySelector('.ws[data-id="'+ws.id+'"] > .canvas'),mx=new DOMMatrixReadOnly(getComputedStyle(cv).transform);window.__m48Release={ws:ws.id,sp:ws.at||null,x:((ws.pan||0)/100)*v.width,y:((ws.panY||0)/100)*v.height,z:ws.zoom||1,dx:-mx.m41/mx.a,dy:-mx.m42/mx.a,dz:mx.a,moving:cv.style.willChange==='transform'};},{once:true});return true;})()`);
  await mouse('mouseReleased',p.x+final.x,p.y+final.y,{at:at+1});const released=(await ev('window.__m48Release'))||await view(),frames=[],t0=Date.now();
  for(const ms of [25,50,100,150,250,400,650,900,1200,1600]){await sleep(Math.max(0,t0+ms-Date.now()));frames.push({ms,...await view()});}
  const direct={x:released.x-before.x,y:released.y-before.y},expectedDirect={x:-final.x/before.z,y:-final.y/before.z},axis=Math.abs(lastNonzero.x)>=Math.abs(lastNonzero.y)?'x':'y',orth=axis==='x'?'y':'x',want=-sign(lastNonzero[axis]),deltas=frames.map((f)=>({x:f.x-released.x,y:f.y-released.y})),along=deltas.map((d)=>d[axis]*want),orths=deltas.map((d)=>Math.abs(d[orth])),monotonic=along.every((v,i)=>v>=-.12&&(i===0||v>=along[i-1]-.18)),noBounce=deltas.every((d)=>sign(d[axis])===0||sign(d[axis])===want)&&orths.every((v)=>v<.6),tail=along.at(-1),settled=near(frames.at(-1).x,frames.at(-2).x,.08)&&near(frames.at(-1).y,frames.at(-2).y,.08)&&!frames.at(-1).moving,directOk=near(direct.x,expectedDirect.x)&&near(direct.y,expectedDirect.y),glideOk=expectGlide?want!==0&&tail>.5&&monotonic&&noBounce:settled&&deltas.every((d)=>Math.hypot(d.x,d.y)<.15);
  const row={name,hold,pause,stillEvery,points,releaseAt,held:{x:held.x-before.x,y:held.y-before.y},direct,expectedDirect,lastNonzero,tail,deltas,checks:{directOk,glideOk,monotonic,noBounce,settled}};row.ok=directOk&&glideOk&&monotonic&&noBounce&&settled;out.gestures.push(row);return row;
}
async function heldPinchGesture(name,{after}){
  await stopMotion();const p=await bare();if(!p)throw new Error('no bare point for '+name);const before=await view();let at=Date.now()+20;
  await mouse('mouseMoved',p.x,p.y,{at});await mouse('mousePressed',p.x,p.y,{at:at+2});at+=2;
  for(let i=1;i<=3;i++){await sleep(40);at+=40;await mouse('mouseMoved',p.x-i*4,p.y,{down:true,at});}
  const pin={x:p.x-12,y:p.y},held=await view(),under0=await ev(`(() => {const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at);return __flow.nav().toSpace(ws,${pin.x},${pin.y});})()`);
  for(let i=0;i<4;i++){await sleep(16);at+=16;await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:pin.x,y:pin.y,deltaX:0,deltaY:6,modifiers:2,button:'none',buttons:1,pointerType:'mouse',timestamp:at/1000});}
  const pinchedHeld=await view(),under1=await ev(`(() => {const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at);return __flow.nav().toSpace(ws,${pin.x},${pin.y});})()`);
  let rx=pin.x;
  if(after==='rest'){await sleep(120);at+=120;}else{for(let i=1;i<=2;i++){await sleep(16);at+=16;rx=pin.x-i*4;await mouse('mouseMoved',rx,p.y,{down:true,at});}}
  const preRelease=await view();
  await ev(`(() => {window.__m48Release=null;document.addEventListener('pointerup',()=>{const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at),v=document.getElementById('viewport').getBoundingClientRect(),cv=document.querySelector('.ws[data-id="'+ws.id+'"] > .canvas'),mx=new DOMMatrixReadOnly(getComputedStyle(cv).transform);window.__m48Release={ws:ws.id,sp:ws.at||null,x:((ws.pan||0)/100)*v.width,y:((ws.panY||0)/100)*v.height,z:ws.zoom||1,dx:-mx.m41/mx.a,dy:-mx.m42/mx.a,dz:mx.a,moving:cv.style.willChange==='transform'};},{once:true});return true;})()`);
  await mouse('mouseReleased',rx,p.y,{at:at+1});const released=(await ev('window.__m48Release'))||await view(),frames=[],t0=Date.now();
  for(const ms of [25,50,100,150,250,400,650,900,1200,1600]){await sleep(Math.max(0,t0+ms-Date.now()));frames.push({ms,...await view()});}
  const direct={x:held.x-before.x,y:held.y-before.y},expectedDirect={x:12/before.z,y:0},deltas=frames.map((f)=>({x:f.x-released.x,y:f.y-released.y})),along=deltas.map((d)=>d.x),orths=deltas.map((d)=>Math.abs(d.y)),monotonic=along.every((v,i)=>v>=-.12&&(i===0||v>=along[i-1]-.18)),noBounce=deltas.every((d)=>sign(d.x)>=0)&&orths.every((v)=>v<.6),tail=along.at(-1),settled=near(frames.at(-1).x,frames.at(-2).x,.08)&&near(frames.at(-1).y,frames.at(-2).y,.08)&&!frames.at(-1).moving;
  const postMoveOk=after==='rest'||near(preRelease.x-pinchedHeld.x,8/pinchedHeld.z)&&near(preRelease.y,pinchedHeld.y);
  const glideOk=after==='rest'?Math.hypot(deltas.at(-1).x,deltas.at(-1).y)<.15&&deltas.every((d)=>Math.hypot(d.x,d.y)<.15):tail>.5;
  const row={name,after,before,held,pinchedHeld,preRelease,released,under0,under1,direct,expectedDirect,tail,deltas,checks:{directOk:near(direct.x,expectedDirect.x)&&near(direct.y,expectedDirect.y),zoomed:pinchedHeld.z<held.z,anchor:near(under0.x,under1.x,.2)&&near(under0.y,under1.y,.2),postMoveOk,releaseStable:near(preRelease.x,released.x)&&near(preRelease.y,released.y)&&near(preRelease.z,released.z,.0005),glideOk,monotonic,noBounce,settled}};row.ok=Object.values(row.checks).every(Boolean);return row;
}
async function startGlide(){await stopMotion();const p=await bare(),t=Date.now();await mouse('mouseMoved',p.x,p.y,{at:t});await mouse('mousePressed',p.x,p.y,{at:t+1});for(let i=1;i<=6;i++)await mouse('mouseMoved',p.x-i*12,p.y,{down:true,at:t+1+i*12});await mouse('mouseReleased',p.x-72,p.y,{at:t+80});return p;}
try{
  await L.writeSeed();L.launch({log:path.join(L.USER_DATA,'macnotes49-independent.log')});c=await L.flowWindow();m=await L.mainProcess();await sleep(1000);
  const slow=await gesture('slow drag released while moving glides',{points:[{x:-4,y:0},{x:-8,y:0},{x:-12,y:0}],gaps:[100,100,100],hold:80});
  await gesture('trackpad-shaped click-drag released while moving glides',{points:[{x:0,y:2},{x:0,y:4},{x:0,y:6}],gaps:[90,90,90],hold:350});
  await gesture('trackpad-shaped tap-drag released while moving glides',{points:[{x:-2,y:0},{x:-4,y:0},{x:-6,y:0}],gaps:[70,70,70]});
  await gesture('three-pixel slow drag released while moving glides',{points:[{x:1,y:0},{x:2,y:0},{x:3,y:0}],gaps:[120,120,120]});
  const tiny=await gesture('one-pixel flick glides',{points:[{x:1,y:0}],gaps:[16]});
  const reversed=await gesture('final movement direction wins on moving release',{points:[{x:-20,y:0},{x:-19,y:0}],gaps:[16,120]});
  await gesture('pointerup-only final movement glides',{points:[{x:3,y:0}],gaps:[80],pause:250,releaseAt:{x:6,y:0}});
  const fast=await gesture('fast flick glides farther',{points:[{x:-4,y:0},{x:-16,y:0},{x:-32,y:0}],gaps:[16,16,16]});
  for(const ms of [80,100,120,250,500])await gesture(`drag rested ${ms}ms before release stays exactly placed`,{points:[{x:-4,y:0},{x:-8,y:0},{x:-12,y:0}],gaps:[16,16,16],pause:ms,expectGlide:false});
  await gesture('fast flick rested 100ms before release stays exactly placed',{points:[{x:-4,y:0},{x:-16,y:0},{x:-32,y:0}],gaps:[16,16,16],pause:100,expectGlide:false});
  await gesture('trackpad-shaped click-drag rested 100ms stays placed',{points:[{x:0,y:2},{x:0,y:4},{x:0,y:6}],gaps:[16,16,16],hold:350,pause:100,expectGlide:false});
  await gesture('trackpad-shaped tap-drag rested 100ms stays placed',{points:[{x:-2,y:0},{x:-4,y:0},{x:-6,y:0}],gaps:[16,16,16],pause:100,expectGlide:false});
  await gesture('same-position reports during a 120ms rest do not make it glide',{points:[{x:3,y:0},{x:6,y:0}],gaps:[16,16],pause:120,stillEvery:20,expectGlide:false});
  await gesture('net-zero trip then 120ms rest stays placed',{points:[{x:5,y:0},{x:0,y:0}],gaps:[16,16],pause:120,expectGlide:false});
  const zero=await gesture('zero-move press has no glide',{points:[],hold:500,expectGlide:false});
  out.heldPinchRest=await heldPinchGesture('held move, pinch, 120ms rest, release stays placed',{after:'rest'});
  out.heldPinchMove=await heldPinchGesture('held move, pinch, move, release while moving glides',{after:'move'});
  out.scaling={fast:fast.tail,slow:slow.tail,tiny:tiny.tail,reversed:reversed.tail,ok:fast.tail>slow.tail+2&&fast.tail>tiny.tail+2&&slow.tail>0&&tiny.tail>0&&reversed.tail>0};

  const gp=await startGlide();await sleep(80);const moving=await view();const q=await bare();const tt=Date.now();await mouse('mouseMoved',q.x,q.y,{at:tt});await mouse('mousePressed',q.x,q.y,{at:tt+1});await mouse('mouseReleased',q.x,q.y,{at:tt+2});const stopped=await view();await sleep(450);const stoppedLater=await view();out.pressStop={moving,stopped,stoppedLater,ok:moving.moving&&!stopped.moving&&near(stopped.x,stoppedLater.x,.08)&&near(stopped.y,stoppedLater.y,.08)};

  await startGlide();await sleep(70);const gliding=await view(),pin=await bare();await ev(`(() => {window.__m48PinchBefore=null;document.addEventListener('wheel',(e)=>{const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at);window.__m48PinchBefore=__flow.nav().toSpace(ws,e.clientX,e.clientY);},{once:true,capture:true});return true;})()`);const pt=Date.now();for(let i=0;i<4;i++)await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:pin.x,y:pin.y,deltaX:0,deltaY:6,modifiers:2,button:'none',buttons:0,pointerType:'mouse',timestamp:(pt+i*16)/1000});const under0=await ev('window.__m48PinchBefore');await sleep(700);const pinched=await view(),under1=await ev(`(() => {const s=__flow.state(),ws=s.ws.find((w)=>w.id===s.ui.at);return __flow.nav().toSpace(ws,${pin.x},${pin.y});})()`);await sleep(450);const pinchLater=await view();out.pinch={gliding,pinched,pinchLater,under0,under1,ok:gliding.moving&&pinched.z<gliding.z&&!pinched.moving&&near(pinched.x,pinchLater.x,.1)&&near(pinched.y,pinchLater.y,.1)&&near(pinched.z,pinchLater.z,.0005)&&near(under0.x,under1.x,.2)&&near(under0.y,under1.y,.2)};

  await stopMotion();const sp=await bare();await L.swipe(c,sp.x,sp.y,SW);await L.waitFor(async()=>(await view()).sp==='z-research'||null,5000,'two-finger next sub-space');const twoLeft=await view();await L.swipe(c,sp.x,sp.y,SW.map((x)=>-x));await L.waitFor(async()=>(await view()).sp===null||null,5000,'two-finger main space');const twoBack=await view();out.twoFinger={twoLeft,twoBack,ok:twoLeft.ws==='flow'&&twoLeft.sp==='z-research'&&twoBack.ws==='flow'&&twoBack.sp===null};

  await stopMotion();const before3=await view();await m.eval(`(() => {process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].emit('swipe',{},'left');return true;})()`);await L.waitFor(async()=>(await view()).ws!==before3.ws||null,5000,'three-finger next workspace');const left3=await view();await m.eval(`(() => {process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].emit('swipe',{},'right');return true;})()`);await L.waitFor(async()=>(await view()).ws===before3.ws||null,5000,'three-finger previous workspace');const back3=await view();out.threeFinger={before3,left3,back3,ok:left3.ws!==before3.ws&&back3.ws===before3.ws};

  out.errors=c.errors.slice(0,10);out.checks={gestures:out.gestures.every((x)=>x.ok),heldPinchRest:out.heldPinchRest.ok,heldPinchMove:out.heldPinchMove.ok,scaling:out.scaling.ok,zero:zero.ok,pressStop:out.pressStop.ok,pinch:out.pinch.ok,twoFinger:out.twoFinger.ok,threeFinger:out.threeFinger.ok,errors:out.errors.length===0};out.ok=Object.values(out.checks).every(Boolean);console.log(JSON.stringify(out));if(!out.ok)process.exitCode=1;
}finally{try{if(c)c.close();}catch{}try{if(m)m.close();}catch{}await L.stop();}




