// ui's CDP driver for a running dev Flow (FLOW_CDP_PORT). Node 22+ (global WebSocket).
//   node test/ui-cdp.mjs eval '<expression>'       evaluate in the Flow window (awaits promises), print JSON
//   node test/ui-cdp.mjs shot <file.png> [match]   screenshot of the Flow window
//   node test/ui-cdp.mjs watch <file.log>          append console messages and exceptions until killed
//   node test/ui-cdp.mjs targets                   list targets
// Env: CDP_PORT (default 9562), CDP_MATCH (substring of the target url, default index.html).
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || '9562';
const [cmd, arg, arg2] = process.argv.slice(2);

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return r.json();
}
async function pick(match) {
  const m = match || process.env.CDP_MATCH || 'index.html';
  const list = await targets();
  const t = list.find((x) => x.type === 'page' && x.url.includes(m));
  if (!t) throw new Error(`no page target matching ${m}: ${list.map((x) => `${x.type} ${x.url}`).join(', ')}`);
  return t;
}
function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) listeners.forEach((f) => f(msg));
  };
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  return { ws, ready, send, on: (f) => listeners.push(f) };
}

if (cmd === 'targets') {
  console.log(JSON.stringify(await targets(), null, 2));
} else if (cmd === 'eval') {
  const c = connect(await pick(arg2));
  await c.ready;
  const r = await c.send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    console.error('EXCEPTION', JSON.stringify(r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value) || r.exceptionDetails.text));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(r.result.value, null, 1));
  }
  c.ws.close();
} else if (cmd === 'shot') {
  const c = connect(await pick(arg2));
  await c.ready;
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log(`wrote ${arg}`);
  c.ws.close();
} else if (cmd === 'watch') {
  const t = await pick();
  const c = connect(t);
  await c.ready;
  const out = (line) => fs.appendFileSync(arg, `${new Date().toISOString()} ${line}\n`);
  c.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ');
      out(`console.${m.params.type}: ${text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      out(`EXCEPTION: ${(d.exception && d.exception.description) || d.text} at ${d.url}:${d.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      out(`log.${e.level} [${e.source}]: ${e.text}${e.url ? ' ' + e.url : ''}`);
    }
  });
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  out(`watching ${t.url}`);
} else {
  console.error('usage: ui-cdp.mjs eval <expr> | shot <file> | watch <file> | targets');
  process.exitCode = 2;
}




