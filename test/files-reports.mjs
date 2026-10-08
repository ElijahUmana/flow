// files' probe pages for a report's folder, for test/files-cdp.mjs: what a script in a report tries in order to read a
// sibling file or reach the network, each result written into the page. net: a local http site standing in for the
// network (its /net/* requests are counted); udp, tcp: local ports a WebRTC STUN or TURN request would reach.
import fs from 'node:fs';
import path from 'node:path';

export function writeProbe(dir, { net, udp, tcp }) {
  const N = `${net}/net`;
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  put('secret.txt', 'the secret text\n');
  put('data.json', '{"secret": "json data"}\n');
  put('probe.css', '#styled { color: rgb(1, 2, 3); }\n');
  put('w.js', "fetch('secret.txt').then((r) => r.text()).then((t) => postMessage('read:' + t), () => postMessage('blocked'));\n");
  put('probe.js', `const out = document.getElementById('out');
const results = {};
const done = (k, v) => { results[k] = v; out.textContent = JSON.stringify(results); };
// reading a sibling file's text
fetch('secret.txt').then((r) => r.text()).then((t) => done('fetch', 'read:' + t.slice(0, 20)), () => done('fetch', 'blocked'));
try { const x = new XMLHttpRequest(); x.open('GET', 'secret.txt'); x.onload = () => done('xhr', 'read:' + x.responseText.slice(0, 20)); x.onerror = () => done('xhr', 'blocked'); x.send(); } catch (e) { done('xhr', 'blocked'); }
import('./data.json', { with: { type: 'json' } }).then((m) => done('jsonModule', 'read:' + JSON.stringify(m.default).slice(0, 20)), () => done('jsonModule', 'blocked'));
const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'secret.txt';
l.onload = () => { let t = ''; try { t = [...l.sheet.cssRules].map((r) => r.cssText).join(''); } catch (e) { t = ''; } done('styleSheet', t ? 'read:' + t.slice(0, 20) : 'nothing'); };
l.onerror = () => done('styleSheet', 'blocked'); document.head.append(l);
const sc = document.createElement('script'); sc.src = 'secret.txt'; sc.onload = () => done('script', 'loaded'); sc.onerror = () => done('script', 'blocked'); document.head.append(sc);
const f = document.createElement('iframe'); f.src = 'secret.txt';
f.onload = () => { let t = null; try { t = f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText : null; } catch (e) { t = null; } done('iframe', t ? 'read:' + t.slice(0, 20) : 'blocked'); };
document.body.append(f);
try { const w = new Worker('w.js'); w.onmessage = (e) => done('worker', String(e.data).slice(0, 25)); w.onerror = () => done('worker', 'blocked'); } catch (e) { done('worker', 'blocked'); }
const o = document.createElement('object'); o.data = 'secret.txt'; o.onload = () => done('object', 'loaded'); o.onerror = () => done('object', 'blocked'); document.body.append(o);
document.getElementById('open').onclick = () => { const w = window.open('secret.txt'); setTimeout(() => { let t = null; try { t = w && w.document && w.document.body ? w.document.body.innerText : null; } catch (e) { t = null; } done('windowOpen', t ? 'read:' + t.slice(0, 20) : (w ? 'no read' : 'null')); }, 1500); };
// reaching the network
const img = new Image(); img.onload = () => done('netImg', 'loaded'); img.onerror = () => done('netImg', 'blocked'); img.src = ${JSON.stringify(N + '/img')};
const ns = document.createElement('script'); ns.src = ${JSON.stringify(N + '/js')}; ns.onload = () => done('netScript', 'loaded'); ns.onerror = () => done('netScript', 'blocked'); document.head.append(ns);
const nl = document.createElement('link'); nl.rel = 'stylesheet'; nl.href = ${JSON.stringify(N + '/css')}; nl.onload = () => done('netStyle', 'loaded'); nl.onerror = () => done('netStyle', 'blocked'); document.head.append(nl);
fetch(${JSON.stringify(N + '/fetch')}).then(() => done('netFetch', 'reached'), () => done('netFetch', 'blocked'));
try { navigator.sendBeacon(${JSON.stringify(N + '/beacon')}, 'x'); } catch (e) { done('netBeacon', 'blocked'); }
try { const ws = new WebSocket(${JSON.stringify(N.replace(/^http/, 'ws') + '/ws')}); ws.onopen = () => done('netWs', 'open'); ws.onerror = () => done('netWs', 'blocked'); } catch (e) { done('netWs', 'blocked'); }
try { const es = new EventSource(${JSON.stringify(N + '/es')}); es.onopen = () => done('netEs', 'open'); es.onerror = () => { es.close(); done('netEs', 'blocked'); }; } catch (e) { done('netEs', 'blocked'); }
for (const rel of ['prefetch', 'preconnect', 'preload']) { const p = document.createElement('link'); p.rel = rel; p.href = ${JSON.stringify(N + '/')} + rel; if (rel === 'preload') p.as = 'fetch'; document.head.append(p); }
const st = document.createElement('style'); st.textContent = "@font-face { font-family: n; src: url('${N}/font'); } #bg { background: url('${N}/bg'); font-family: n; }"; document.head.append(st);
const vd = document.createElement('video'); vd.src = ${JSON.stringify(N + '/media')}; document.body.append(vd);
const fm = document.createElement('form'); fm.method = 'post'; fm.action = ${JSON.stringify(N + '/form')}; document.body.append(fm);
try { fm.submit(); } catch (e) { done('netForm', 'blocked'); }
done('ran', 'yes');
`);
  put('index.html', '<!doctype html><meta charset="utf-8"><title>probe</title><link rel="stylesheet" href="probe.css"><body><p id="styled">styled</p><p id="bg">bg</p><pre id="out">{}</pre><button id="open" style="font:30px sans-serif">open</button><script src="probe.js"></script></body>\n');
  put('sub/page.html', '<!doctype html><meta charset="utf-8"><title>sub page</title><link rel="stylesheet" href="../probe.css"><body style="font:30px sans-serif"><p id="styled">styled</p><a id="up" href="../index.html">up</a> <a id="side" href="other.html">side</a></body>\n');
  put('sub/other.html', '<!doctype html><meta charset="utf-8"><title>other</title><p>other page</p>\n');
  put('nav.html', `<!doctype html><meta charset="utf-8"><title>nav</title><p>nav</p><script>location = ${JSON.stringify(N + '/nav')};</script>\n`);
  put('nav2.html', `<!doctype html><meta charset="utf-8"><title>nav2</title><meta http-equiv="refresh" content="0;url=${N}/meta"><p>nav2</p>\n`);
  put('nav3.html', `<!doctype html><meta charset="utf-8"><title>nav3</title><p>nav3</p><script>setTimeout(() => location.replace(${JSON.stringify(N + '/replace')}), 50);</script>\n`);
  put('link.html', `<!doctype html><meta charset="utf-8"><title>link</title><body style="margin:0"><a id="ext" href="${N}/clicked" ping="${N}/ping" style="display:block;width:400px;height:200px;font:30px sans-serif;background:#ccc">external</a></body>\n`);
  // WebRTC from the page itself, from a blank frame of its own and from a srcdoc frame: STUN over UDP, TURN over TCP.
  put('webrtc.html', `<!doctype html><meta charset="utf-8"><title>webrtc</title><pre id="out"></pre><script>
const tried = [];
const go = (win, label) => { try { const pc = new win.RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udp}' }, { urls: 'turn:127.0.0.1:${tcp}?transport=tcp', username: 'u', credential: 'p' }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); tried.push(label); } catch (e) { tried.push(label + ': ' + e.message); } document.getElementById('out').textContent = tried.join(', '); };
go(window, 'page');
const f = document.createElement('iframe'); document.body.append(f); go(f.contentWindow, 'blank frame');
const s = document.createElement('iframe'); s.srcdoc = '<p>x</p>'; s.onload = () => go(s.contentWindow, 'srcdoc frame'); document.body.append(s);
</script>\n`);
  // A note that links to it, as a .md reaches a report.
  put('links.md', '# links\n\n[the webrtc page](webrtc.html)\n');
}

// A web page that tries to reach a report by addresses it made up (it cannot know a real one): each result in its page.
export function evilPage(macPath) {
  const made = (p) => `flow-file://mac/AAAAAAAAAAAAAAAAAAAAAA${p.split('/').map(encodeURIComponent).join('/')}`;
  const page = made(macPath);
  const css = made(macPath.replace(/[^/]*$/, 'style_cb_4667309f.css'));
  return `<!doctype html><meta charset="utf-8"><title>evil report</title><pre id="out">{}</pre><script>
const results = {};
const done = (k, v) => { results[k] = v; document.getElementById('out').textContent = JSON.stringify(results); };
const img = new Image(); img.onload = () => done('img', 'loaded'); img.onerror = () => done('img', 'blocked'); img.src = ${JSON.stringify(made(macPath.replace(/[^/]*$/, 'favicon_32_cb_c827f16f.png')))};
const s = document.createElement('link'); s.rel = 'stylesheet'; s.href = ${JSON.stringify(css)}; s.onload = () => done('style', 'loaded'); s.onerror = () => done('style', 'blocked'); document.head.append(s);
fetch(${JSON.stringify(page)}).then((r) => r.text()).then((t) => done('fetch', /refused/.test(t) ? 'refused' : 'read:' + t.slice(0, 20)), () => done('fetch', 'blocked'));
const f = document.createElement('iframe'); f.src = ${JSON.stringify(page)};
f.onload = () => { let t = null; try { t = f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText : null; } catch (e) { t = null; } done('iframe', t && !/refused/.test(t) ? 'read:' + t.slice(0, 20) : 'blocked'); };
document.body.append(f);
// a frame whose load Flow stops never fires load: blocked, unless it loads later (the reader looks again after a while)
setTimeout(() => { if (!('iframe' in results)) done('iframe', 'blocked'); }, 3000);
</script>\n`;
}




