#!/usr/bin/env node
// End-to-end test for Flow, driven over the Chrome DevTools Protocol (Node 22+: global fetch and WebSocket).
//
//   node scripts/e2e.mjs                   the installed app, ~/Applications/Flow.app
//   node scripts/e2e.mjs --app <Flow.app>  another build of Flow (its bundle id must be so.flow.app)
//   node scripts/e2e.mjs --dev             the repo, with node_modules/electron
//   node scripts/e2e.mjs --smoke [...]     only: starts, answers over CDP, __flow.ready, no console errors, 5 pills
//
// Isolated from the real app: FLOW_USER_DATA=/tmp/flow-e2e-<ts>, FLOW_TMUX_SOCKET=flow-e2e, FLOW_CDP_PORT=9565, and
// the bare environment macOS gives an app opened from the Finder. Prints one ok/FAIL line per check, saves
// screenshots and main-process logs to /tmp/flow-e2e-shots/, exits 1 on any failure, and always cleans up.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const PORT = 9565;
const SOCKET = 'flow-e2e';
const BUNDLE_ID = 'so.flow.app';
const SHOTS = '/tmp/flow-e2e-shots';
const TMUX = fs.existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux';
const ALPHAXIV = 'https://www.alphaxiv.org/abs/2610.38355';
const SEED_NAMES = ['flow', 'mynotes', 'inference infra', 'voiceless', 'ef start'];
const DOCK = ['agent', 'shell', 'team', 'note', 'page', 'zone', 'arrange'];
// Text that only real Claude Code draws: its banner (it differs per machine), its folder trust prompt, its input footer.
const CLAUDE_RE = /Welcome back|Claude Code|Free Code|Quick safety check|Welcome to Claude|\? for shortcuts|trust the files in this folder|bypass permissions|Tips for getting started/i;
const LINUX = process.platform === 'linux';
// Claude Code ready for input, and its question whether to trust a folder (never answered by the e2e).
const PROMPT_RE = /\? for shortcuts|bypass permissions|for agents/;
const TRUST_RE = /Quick safety check|trust the files in this folder|trust this folder|Enter to confirm/i;
// /cost on a subscription (the owner's Max plan on the Mac) prints this line instead of totals (MAC_NOTES 17). A narrow
// window wraps it, mid-word or at a space, so it is matched with the line breaks taken out both ways.
const SUBSCRIPTION_RE = /currently using your (?:subscription|overages) to power your Claude Code usage/;
const subscriptionCost = (t) => ['', ' '].some((j) => SUBSCRIPTION_RE.test(String(t || '').replace(/\n\s*/g, j).replace(/[ \t]+/g, ' ')));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_PAGE_RE = /access denied|not found|forbidden|just a moment|attention required|\berror\b|^\s*\d{3}\b/i;
// The seed's remote windows run `ssh claude-agents`, which works from the Mac but not from the VM itself.
const REMOTE_RE = /ssh claude-agents/;
// Lists console errors, saying how many come from the seed's remote windows (still failures).
function describeErrors(list, n) {
  const remote = list.filter((e) => REMOTE_RE.test(e.text)).length;
  const why = remote ? ` (${remote} from \`ssh claude-agents\` in the seed's remote windows, which only works from the Mac)` : '';
  return `${list.length} console error(s)${why}: ${list.slice(0, n).map((e) => `${e.phase === 'launch 1' ? '' : `[${e.phase}] `}${e.text}`).join(' | ')}`;
}

const opt = { dev: false, smoke: false, app: path.join(HOME, 'Applications/Flow.app'), costProbeSelfTest: null, costProbeEvidence: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--dev') opt.dev = true;
  else if (a === '--smoke') opt.smoke = true;
  else if (a === '--app' && process.argv[i + 1]) opt.app = path.resolve(process.argv[++i]);
  else if (a === '--self-test-cost-probe' && process.argv[i + 1]) opt.costProbeSelfTest = path.resolve(process.argv[++i]);
  else if (a === '--record-cost-probe' && process.argv[i + 1]) opt.costProbeEvidence = path.resolve(process.argv[++i]);
  else {
    console.error(`e2e: unknown argument ${a}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (s, n = 160) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const q = (v) => JSON.stringify(v);

class Fatal extends Error {}

async function waitFor(fn, { timeout = 10000, interval = 250, label = 'a condition' } = {}) {
  const end = Date.now() + timeout;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e instanceof Fatal) throw e;
      lastErr = e;
    }
    if (Date.now() >= end) {
      throw new Error(`timed out after ${Math.round(timeout / 1000)}s waiting for ${label}${lastErr ? ` (last error: ${oneLine(lastErr.message, 300)})` : ''}`);
    }
    await sleep(interval);
  }
}

/* ---------- CDP ---------- */

class CDP {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  async open(timeout = 10000) {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`could not connect to ${this.url} within ${timeout / 1000}s`)), timeout);
      this.ws.onopen = () => { clearTimeout(t); resolve(); };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error(`websocket error connecting to ${this.url}`)); };
    });
    this.ws.onmessage = (m) => this.onMessage(JSON.parse(m.data));
    this.ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('the CDP connection closed (did the app exit?)'));
      this.pending.clear();
    };
  }

  send(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error(`${method}: the CDP connection is closed`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer within ${timeout / 1000}s`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onMessage(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    for (const h of this.handlers.get(msg.method) || []) h(msg.params);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  async eval(expression, timeout = 30000) {
    // No userGesture: a user activation would let app code such as window.focus() activate the window.
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw new Error(`in the page: ${exceptionText(r.exceptionDetails)}`);
    return r.result.value;
  }

  close() {
    if (!this.closed && this.ws) this.ws.close();
  }
}

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

const isMainWindow = (t) => t.type === 'page' && /\/index\.html(?:$|[?#])/.test(t.url) && !/[#&]solo=/.test(t.url);
const isPopOut = (t) => t.type === 'page' && /\/index\.html#(?:.*&)?solo=/.test(t.url);

function remoteText(o) {
  if (!o) return '';
  if ('value' in o) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  return o.description || o.unserializableValue || o.type;
}
const shortUrl = (u) => String(u || '').replace(/^file:\/\/.*?\/(src\/)/, '$1');
function exceptionText(d) {
  const msg = d.exception ? d.exception.description || remoteText(d.exception) : d.text;
  return `${msg}${d.url ? ` (${shortUrl(d.url)}:${d.lineNumber + 1})` : ''}`;
}

const consoleErrors = [];
function watchConsole(cdp, phase) {
  const add = (text) => {
    const t = oneLine(text, 500);
    if (!consoleErrors.some((e) => e.phase === phase && e.text === t)) consoleErrors.push({ phase, text: t });
  };
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => add(`uncaught ${exceptionText(exceptionDetails)}`));
  cdp.on('Runtime.consoleAPICalled', ({ type, args, stackTrace }) => {
    if (type !== 'error' && type !== 'assert') return;
    const f = stackTrace && stackTrace.callFrames && stackTrace.callFrames[0];
    add(`console.${type}: ${args.map(remoteText).join(' ')}${f ? ` (${shortUrl(f.url)}:${f.lineNumber + 1})` : ''}`);
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') add(`${entry.source}: ${entry.text}${entry.url ? ` (${shortUrl(entry.url)})` : ''}`);
  });
}

async function attach(target, phase) {
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  connections.push(cdp);
  watchConsole(cdp, phase);
  // Both replay what was logged before we attached, so nothing from startup is missed.
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  // The page behaves as focused (element.focus(), typing, ⌘K) while the window stays inactive (MAC_NOTES 12).
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return cdp;
}

async function waitReady(cdp, timeout = 45000) {
  const t0 = Date.now();
  await waitFor(() => cdp.eval('!!(window.__flow && window.__flow.ready && typeof window.__flow.ready.then === "function")'), { timeout, label: 'window.__flow.ready' });
  const left = Math.max(2000, timeout - (Date.now() - t0));
  await cdp.eval(`Promise.race([Promise.resolve(window.__flow.ready).then(() => true), new Promise((_, reject) => setTimeout(() => reject(new Error('window.__flow.ready did not resolve within ${Math.round(left / 1000)}s')), ${left}))])`, left + 5000);
  return Date.now() - t0;
}

async function shot(cdp, name) {
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  } catch (e) {
    // Screenshots are evidence only: a capture that times out on a busy machine never decides a check.
    console.log(`e2e: no screenshot ${name}: ${e.message}`);
    return null;
  }
}

async function mouse(cdp, type, x, y) {
  const press = type === 'mousePressed' || type === 'mouseReleased';
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: press ? 'left' : 'none', buttons: type === 'mousePressed' ? 1 : 0, clickCount: press ? 1 : 0 });
}
async function click(cdp, x, y) {
  await mouse(cdp, 'mouseMoved', x, y);
  await mouse(cdp, 'mousePressed', x, y);
  await mouse(cdp, 'mouseReleased', x, y);
}
async function rightClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
}
const KEYS = { k: ['KeyK', 75], u: ['KeyU', 85], v: ['KeyV', 86], Escape: ['Escape', 27], Backspace: ['Backspace', 8] };
// mods: true for ⌘ (meta), or CDP modifier bits (2 ctrl, 4 meta). commands: editing commands sent with the key, the
// way the native Edit menu's paste reaches the page on macOS.
async function key(cdp, k, mods = 0, commands) {
  const [code, vk] = KEYS[k];
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods === true ? 4 : mods };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(commands ? { commands } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Types like a person: clicks the field when nothing covers it, puts the caret at the end (or selects all to
// replace), then inserts the text, which fires the same beforeinput/input events as the keyboard.
async function typeInto(cdp, selector, text, replace) {
  const r = await cdp.eval(`(() => {
    const el = document.querySelector(${q(selector)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const x = b.left + Math.min(b.width / 2, 60), y = b.top + Math.min(b.height / 2, 10);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (hit === el || el.contains(hit)) };
  })()`);
  if (!r) throw new Error(`no element matches ${selector}`);
  if (r.hit) await click(cdp, r.x, r.y);
  await cdp.eval(`(() => {
    const el = document.querySelector(${q(selector)});
    if (document.activeElement !== el) el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!${q(replace)}) range.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  })()`);
  await cdp.send('Input.insertText', { text });
  return r.hit ? 'clicked and typed' : 'focused and typed (the field was covered)';
}

const termText = (id) => `(() => { const t = window.__flow.term(${q(id)}); return t && typeof t.getText === 'function' ? t.getText() : null; })()`;
const pageInfo = (id) => `(() => { const p = window.__flow.page(${q(id)}); return p ? { url: p.getURL(), title: p.getTitle(), loading: p.isLoading() } : null; })()`;
const claudeLine = (text) => oneLine(String(text).split('\n').find((l) => CLAUDE_RE.test(l)) || '', 90);
const idOf = (w) => (typeof w === 'string' ? w : w && w.id);

/* ---------- fork and images (checks 11 and 12) ---------- */

// A small solid PNG, written by hand so the e2e needs nothing but Node.
function writePng(file, w = 48, h = 32) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([0xd7, 0x77, 0x57], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

// Brings a window into view through its sidebar row and returns the middle of its terminal.
async function termPoint(cdp, id) {
  const row = await cdp.eval(`(() => { const r = document.querySelector('#sblist .tr[data-act="win|${id}"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + Math.min(60, b.width / 2), y: b.top + b.height / 2 }; })()`);
  if (row) {
    await click(cdp, row.x, row.y);
    await sleep(800);
  }
  const p = await cdp.eval(`(() => {
    const el = document.querySelector('.win[data-id="${id}"] .xterm-screen');
    if (!el) return null;
    const b = el.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, inView: x > v.left && x < v.right && y > v.top && y < v.bottom, onTerm: !!top && !!top.closest('.win[data-id="${id}"]') };
  })()`);
  if (!p || !p.inView || !p.onTerm) throw new Error(`the terminal of ${id} is not on screen to act on (${q(p)})`);
  return p;
}

// Claude Code's input line must be up (never its trust question, which the e2e does not answer).
async function claudePrompt(cdp, id, what) {
