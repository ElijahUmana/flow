// ui's CDP helpers: real input events (Input.dispatchMouseEvent / dispatchKeyEvent) into a running Flow window,
// plus the same for the mockup running in its own Electron on the same X display. Node 22+ (global WebSocket).
import fs from 'node:fs';

/* match: a substring of the target url, or a RegExp. type: 'node' for the main process's inspector. */
export async function connectTo(port, match, type = 'page') {
  const hit = (u) => (match instanceof RegExp ? match.test(u) : u.includes(match));
  let list = null;
  for (let i = 0; i < 40 && !list; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      const all = await r.json();
      if (all.some((x) => x.type === type && hit(x.url))) list = all;
    } catch (err) {
      if (i === 39) throw err;
    }
    if (!list) await sleep(250);
  }
  if (!list) throw new Error(`no ${type} target on ${port} matching ${match}`);
  const t = list.find((x) => x.type === type && hit(x.url));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
      else resolve(msg.result);
    } else if (msg.method) listeners.forEach((f) => f(msg));
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`cannot open ${t.webSocketDebuggerUrl}`)); });
  /* A CDP call that never answers fails after 30s naming the call (and an input event's type and point), instead of hanging the run. */
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const what = params && params.type ? `${method} ${params.type}${params.x != null ? ` at ${Math.round(params.x)},${Math.round(params.y)}` : ''}` : method;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${what} got no answer in 30s (${t.url.slice(0, 60)})`)); }, 30000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const page = { ws, url: t.url, send, on: (f) => listeners.push(f), errors: [] };
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      page.errors.push(`exception: ${(d.exception && d.exception.description) || d.text}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      page.errors.push(`console.${m.params.type}: ${m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ')}`);
    }
  });
  await send('Runtime.enable');
  return page;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* commandLine: with the inspector's command line API (require, in the main process). */
export async function evaluate(page, expression, commandLine = false) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: commandLine });
  if (r.exceptionDetails) throw new Error(`eval failed: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
  return r.result.value;
}

/* The center (or a point) of the first element matching a selector, in viewport CSS pixels. */
export async function rect(page, selector, index = 0) {
  return evaluate(page, `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
}

export async function size(page, width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

const BUTTONS = { none: 0, left: 1 };
export async function mouse(page, type, x, y, o = {}) {
  await page.send('Input.dispatchMouseEvent', {
    type, x, y, button: o.button || (type === 'mouseMoved' ? (o.down ? 'left' : 'none') : 'left'),
    buttons: o.buttons != null ? o.buttons : (type === 'mousePressed' || o.down ? BUTTONS.left : 0),
    clickCount: o.clickCount || (type === 'mouseMoved' ? 0 : 1), modifiers: o.modifiers || 0,
    deltaX: o.deltaX, deltaY: o.deltaY, pointerType: 'mouse',
    timestamp: o.at != null ? o.at / 1000 : undefined,
  });
}

export async function click(page, x, y, o = {}) {
  await mouse(page, 'mouseMoved', x, y);
  await mouse(page, 'mousePressed', x, y, o);
  await mouse(page, 'mouseReleased', x, y, o);
}

/* Two presses with clickCount 1 then 2, as a real double-click arrives. */
export async function dblclick(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  await mouse(page, 'mousePressed', x, y, { clickCount: 1 });
  await mouse(page, 'mouseReleased', x, y, { clickCount: 1 });
  await mouse(page, 'mousePressed', x, y, { clickCount: 2 });
  await mouse(page, 'mouseReleased', x, y, { clickCount: 2 });
}

export async function drag(page, from, to, o = {}) {
  const steps = o.steps || 12;
  await mouse(page, 'mouseMoved', from.x, from.y);
  await mouse(page, 'mousePressed', from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps, y = from.y + ((to.y - from.y) * i) / steps;
    await mouse(page, 'mouseMoved', x, y, { down: true });
    if (o.stepMs) await sleep(o.stepMs);
  }
  if (o.holdMs) await sleep(o.holdMs);
  await mouse(page, 'mouseReleased', to.x, to.y);
}

/* at: the event's time in epoch ms, as a trackpad stamps it (default: when the browser gets the command). */
export async function wheel(page, x, y, deltaX, deltaY = 0, at) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: at != null ? at / 1000 : undefined });
}

/* A trackpad-like swipe: wheel events stamped gapMs apart, sent without waiting for the app's answers (a trackpad does not wait). */
export async function swipe(page, x, y, deltas, gapMs = 16) {
  const t0 = Date.now();
  await Promise.all(deltas.map((dx, i) => sleep(i * gapMs).then(() => wheel(page, x, y, dx, 0, t0 + i * gapMs))));
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Tab: { code: 'Tab', keyCode: 9 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, Backspace: { code: 'Backspace', keyCode: 8 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
};
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/* Windows virtual key codes for characters whose char code is not their key code (46 for "." is Delete). */
const PUNCT = { '.': [190, 'Period'], ',': [188, 'Comma'], '-': [189, 'Minus'], '/': [191, 'Slash'], '\\': [220, 'Backslash'],
  ';': [186, 'Semicolon'], "'": [222, 'Quote'], '=': [187, 'Equal'], '[': [219, 'BracketLeft'], ']': [221, 'BracketRight'], '`': [192, 'Backquote'], ' ': [32, 'Space'] };
function charSpec(ch) {
  if (/^[a-z]$/i.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  if (PUNCT[ch]) return { code: PUNCT[ch][1], keyCode: PUNCT[ch][0], text: ch };
  return { code: '', keyCode: 0, text: ch };
}

/* A key press: rawKeyDown + (char) + keyUp, with modifiers. */
export async function key(page, k, modifiers = 0) {
  const spec = KEYS[k] || (k.length === 1 ? charSpec(k) : { code: k, keyCode: 0 });
  const text = modifiers & (MOD.ctrl | MOD.meta | MOD.alt) ? undefined : spec.text;
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers, text, unmodifiedText: text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers });
}

/* Types text one character at a time as key events (a real keyboard, not insertText). */
export async function type(page, text) {
  for (const ch of text) await key(page, ch);
}

export async function shot(page, file) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/* A small results printer: ok / FAIL lines, exits non-zero on failure. */
export function reporter() {
  const results = [];
  return {
    /* Only true passes. A check that hands over anything else (an object or a string found, null) fails, and says what
       it gave, so a miss that returns something truthy cannot pass. */
    ok(name, cond, detail) {
      const pass = cond === true;
      const gave = pass || cond === false ? '' : ` [gave ${cond === null ? 'null' : Array.isArray(cond) ? 'an array' : typeof cond}, not true]`;
      results.push({ name, ok: pass, detail });
      console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${gave}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
      return pass;
    },
    summary() {
      const bad = results.filter((r) => !r.ok);
      console.log(`\n${results.length - bad.length}/${results.length} passed`);
      if (bad.length) process.exitCode = 1;
      return bad;
    },
  };
}




