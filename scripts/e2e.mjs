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
  let text = '';
  await waitFor(async () => {
    text = (await cdp.eval(termText(id))) || '';
    return TRUST_RE.test(text) || PROMPT_RE.test(text);
  }, { timeout: 30000, interval: 500, label: `Claude Code's input line in ${id}` }).catch((e) => {
    throw new Error(`${e.message}; screen ${q(oneLine(text, 240))}`);
  });
  if (TRUST_RE.test(text)) throw new Error(`Claude Code in ${id} is asking whether to trust its folder; the e2e never answers that, so nothing was ${what} (screen ${q(oneLine(text, 200))})`);
  return text;
}

async function clearClaudeInput(cdp, id, at) {
  await click(cdp, at.x, at.y);
  await key(cdp, 'u', 2);
  await waitFor(async () => !/\[Image #\d+\]/.test((await cdp.eval(termText(id))) || ''), { timeout: 5000, interval: 200, label: `Claude Code's input in ${id} to be empty again after ctrl+u` });
}

// 12a drops an image file on the agent's terminal; 12b puts an image on the clipboard and pastes it with ⌘V.
async function imageCheck(cdp, agent, how, userData) {
  if (!agent) throw new Error('no agent from check 2');
  await claudePrompt(cdp, agent.id, how === 'drop' ? 'dropped' : 'pasted');
  const at = await termPoint(cdp, agent.id);
  const savedDir = path.join(userData, 'pasted-images');
  const savedBefore = fs.existsSync(savedDir) ? fs.readdirSync(savedDir).length : 0;
  if (how === 'drop') {
    const file = writePng(path.join(userData, 'e2e image.png'));
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
  } else {
    const wrote = await cdp.eval(`(async () => {
      const c = document.createElement('canvas');
      c.width = 48;
      c.height = 32;
      const g = c.getContext('2d');
      g.fillStyle = '#d77757';
      g.fillRect(0, 0, 48, 32);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    })()`).catch((e) => e.message);
    if (wrote !== true) throw new Error(`could not put an image on the clipboard: ${wrote}`);
    await click(cdp, at.x, at.y);
    await key(cdp, 'v', 4, ['paste']);
  }
  let text = '';
  await waitFor(async () => {
    text = (await cdp.eval(termText(agent.id))) || '';
    return /\[Image #\d+\]/.test(text);
  }, { timeout: 30000, interval: 300, label: `[Image #N] in Claude Code's input in ${agent.id}` }).catch((e) => {
    const typed = /e2e\\ image\.png|pasted-images|paste-[\dT-]+Z-\w+\.png/.test(text);
    throw new Error(`${e.message}${typed ? '; the image path is in Claude Code\'s input but Claude Code did not attach it' : ''}; the last lines are ${q(oneLine(text.split('\n').filter((l) => l.trim()).slice(-4).join(' / '), 300))}`);
  });
  const line = text.split('\n').find((l) => /\[Image #\d+\]/.test(l)).trim();
  let saved = '';
  if (how === 'paste') {
    const now = fs.existsSync(savedDir) ? fs.readdirSync(savedDir) : [];
    if (now.length <= savedBefore) throw new Error(`Claude Code shows ${q(line)} but nothing new was saved in ${savedDir}`);
    saved = `; main saved it as ${path.join(savedDir, now.sort().pop())}`;
  }
  await clearClaudeInput(cdp, agent.id, at);
  return `Claude Code's input shows ${q(line)}${saved}; cleared again with ctrl+u, nothing sent`;
}

// A page window holds only the page; its note is a side panel behind ✎, closed by default (owner, Nov 1).
async function pageNoteCheck(cdp) {
  const id = idOf(await cdp.eval(`window.__flow.spawn('page')`));
  if (!id) throw new Error(`__flow.spawn('page') returned no window`);
  await sleep(500);
  const look = () => cdp.eval(`(() => {
    const w = document.querySelector('.win[data-id="${id}"]');
    if (!w) return null;
    const ed = w.querySelector('.npane') || w.querySelector('.anote') || w.querySelector('.pnote'), pn = w.querySelector('.pn'), pen = w.querySelector(':scope > .tb [data-act="note"]');
    const er = ed ? ed.getBoundingClientRect() : null, nr = pn ? pn.getBoundingClientRect() : null, pr = pen ? pen.getBoundingClientRect() : null;
    return {
      noted: w.classList.contains('noted'),
      visible: !!er && ed.offsetParent !== null && er.width > 0 && er.height > 0,
      focused: !!ed && !!document.activeElement && ed.contains(document.activeElement),
      beside: !!er && !!nr && er.left >= nr.right - 2,
      pen: pr && pr.width ? { x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 } : null,
    };
  })()`);
  const a = await look();
  if (!a) throw new Error(`window ${id} is not in the DOM`);
  const bad = [];
  if (a.noted || a.visible) bad.push(`the new page shows a note (${q(a)})`);
  if (!a.pen) {
    bad.push('the page window has no ✎ in its title bar');
  } else {
    await click(cdp, a.pen.x, a.pen.y);
    await sleep(500);
    const b = await look();
    if (!b.noted || !b.visible || !b.beside) bad.push(`✎ should open the note beside the page (${q(b)})`);
    await click(cdp, b.pen.x, b.pen.y);
    await sleep(500);
    const c = await look();
    if (c.noted || c.visible) bad.push(`a second ✎ should close it (${q(c)})`);
  }
  if (bad.length) throw new Error(bad.join('; '));
  await shot(cdp, '13-page-note');
  return `new page ${id}: no note showing; ✎ opened the note beside the page and closed it again`;
}

// A local page with a link that opens a new tab, served by the e2e itself (127.0.0.1 only, closed after the check).
function tabSite() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // __clicks: the clicks the page itself got (clickInPage)
      const page = (title, body) => `<!doctype html><title>${title}</title><style>body{font:28px sans-serif;margin:40px}a{display:inline-block;margin:30px 0}</style><script>window.__clicks = 0; addEventListener('click', () => { window.__clicks += 1; }, true);</script>${body}`;
      const guard = '<h1>e2e guard</h1><input id="t" style="font-size:28px;width:80%"><script>addEventListener(\'beforeunload\', (e) => { if (document.getElementById(\'t\').value) { e.preventDefault(); e.returnValue = \'\'; } });</script>';
      if (req.url === '/guard') return res.end(page('e2e guard', guard));
      res.end(req.url === '/popped' ? page('e2e popped', '<h1>opened from a link</h1>') : page('e2e tabs', '<h1>e2e tabs</h1><a id="pop" href="/popped" target="_blank">open in a new tab</a>'));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

// A link with target=_blank in a page lands as a tab in that page window (owner, Nov 1: "a somehow new tab").
/* The dock comes up when the pointer reaches the bottom middle (with a window under it, only from the strip at the very
   bottom): approach the button from there, as a person does, and click it once it is under the pointer. */
async function clickDock(cdp, kind) {
  const r = await cdp.eval(`(() => { const b = document.querySelector('#dock button[data-k="${kind}"]'); if (!b) return null; const x = b.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2, vh: innerHeight }; })()`);
  if (!r) return `the dock has no ${kind} button`;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.vh - 4, button: 'none', buttons: 0 });
  await sleep(250);
  let at = null;
  for (let i = 0; i < 25; i++) {
    at = await cdp.eval(`(() => { const b = document.querySelector('#dock button[data-k="${kind}"]'); const x = b.getBoundingClientRect(); const cx = x.left + x.width / 2, cy = x.top + x.height / 2; const el = document.elementFromPoint(cx, cy); return { x: cx, y: cy, on: !!el && b.contains(el) && getComputedStyle(b).pointerEvents !== 'none' && +getComputedStyle(document.getElementById('dock')).opacity > 0.5 }; })()`);
    if (at.on) break;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: Math.max(at.y, r.vh - 4 - i * 6), button: 'none', buttons: 0 });
    await sleep(100);
  }
  if (!at || !at.on) return `the dock's ${kind} button never came up under the pointer`;
  await click(cdp, at.x, at.y);
  return null;
}

// A click through the window, as a person clicks, then a wait on the app's own state (done). Chromium drops a click that
// reaches a page before the page has drawn, and a window macOS reports covered may not draw at all, so nothing here waits
// on the page's frames: the page counts the clicks it gets (g is its CDP). A click it never got is sent again, each retry
// printed; a click it got with no done() within timeout fails, and so does a page that got none of five.
async function clickInPage(cdp, g, x, y, what, done, timeout) {
  for (let i = 1; i <= 5; i++) {
    const n = await g.eval('window.__clicks');
    if (typeof n !== 'number') throw new Error(`the page has no click counter (window.__clicks is ${q(n)})`);
    await click(cdp, x, y);
    const got = await waitFor(async () => (await g.eval('window.__clicks')) > n, { timeout: 2000, interval: 100, label: `the page to get the click on ${what}` }).then(() => true, () => false);
    if (got) {
      const r = await waitFor(done, { timeout, interval: 200, label: what }).catch(() => null);
      if (!r) throw new Error(`the page got the click on ${what} and nothing came of it within ${timeout / 1000}s`);
      return r;
    }
    const under = await cdp.eval(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '') : 'nothing'; })()`);
    console.log(`e2e: retry: click ${i} of 5 on ${what} at ${Math.round(x)},${Math.round(y)} (${under} there) never reached the page${i < 5 ? '; clicking again' : ''}`);
    if (i < 5) await sleep(1000);
  }
  throw new Error(`the page got none of 5 clicks on ${what}`);
}

async function tabsCheck(cdp) {
  const { srv, base } = await tabSite();
  try {
    const id = idOf(await cdp.eval(`window.__flow.openPage(${q(base)})`));
    if (!id) throw new Error('__flow.openPage() returned no window');
    const pageUrl = () => cdp.eval(`(() => { const p = window.__flow.page(${q(id)}); return p && !p.isLoading() ? p.getURL() : null; })()`);
    const tabCountNow = () => cdp.eval(`(() => { const p = window.__flow.page(${q(id)}); return p ? p.tabs().tabs.length : null; })()`);
    const stripNow = () => cdp.eval(`(() => { const el = document.querySelector('.win[data-id="${id}"] .ptabs'); return el ? { on: el.classList.contains('on'), tabs: [...el.querySelectorAll('.ptab')].map((t) => t.textContent.replace('×', '').trim()), active: [...el.querySelectorAll('.ptab')].findIndex((t) => t.classList.contains('on')) } : null; })()`);
    await waitFor(async () => (await pageUrl()) === base, { timeout: 20000, interval: 300, label: `the local page ${base} in window ${id}` });
    const before = await cdp.eval('window.__flow.windows().length');
    // A new window can still be gliding to its spot: click once it holds still (as a person clicks where the link is).
    let last = '';
    await waitFor(async () => {
      const r = JSON.stringify(await cdp.eval(`(() => { const w = document.querySelector('.win[data-id="${id}"]'); if (!w) return null; const b = w.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`));
      const still = r === last;
      last = r;
      return still;
    }, { timeout: 5000, interval: 300, label: `window ${id} to hold still` });
    // where the link is on screen: the page is laid out at desktop width and scaled to fit
    const target = (await listTargets()).find((t) => t.type === 'webview' && t.url === base);
    if (!target) throw new Error(`no webview target for ${base}`);
    const g = new CDP(target.webSocketDebuggerUrl);
    await g.open();
    try {
      const link = await g.eval(`(() => { const r = document.getElementById('pop').getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2, vw: innerWidth }; })()`);
      const wv = await cdp.eval(`(() => { const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)') || document.querySelector('.win[data-id="${id}"] webview'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
      if (!wv) throw new Error(`window ${id} has no webview`);
      const sc = wv.w / link.vw;
      await clickInPage(cdp, g, wv.x + link.x * sc, wv.y + link.y * sc, `a target=_blank link in window ${id}`, async () => (await tabCountNow()) >= 2, 15000);
    } finally {
      g.close();
    }
    const strip = await waitFor(async () => {
      const r = await stripNow();
      return r && r.tabs.length >= 2 ? r : null;
    }, { timeout: 5000, interval: 200, label: `the tab strip of window ${id} to show its second tab` });
    await waitFor(async () => (await pageUrl()) === `${base}popped`, { timeout: 15000, interval: 300, label: 'the new tab to show the linked page' });
    const after = await cdp.eval('window.__flow.windows().length');
    const bad = [];
    if (!strip.on) bad.push('the tab strip is not showing with two tabs');
    if (after !== before) bad.push(`the link opened ${after - before} new window(s) instead of a tab`);
    // ⌘T in a page (item 1): the keys are in the page, as when the owner works there, so first a click on a blank spot of
    // it; then the native menu's new-page action, run the way main runs it (CDP key events never reach the native menu).
    // With the keys anywhere else ⌘T makes a page window of its own.
    const popped = await waitFor(async () => (await listTargets()).find((t) => t.type === 'webview' && t.url === `${base}popped`), { timeout: 10000, interval: 300, label: `a webview target for ${base}popped` });
    const spot = await cdp.eval(`(() => { const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.85 }; })()`);
    if (!spot) throw new Error(`window ${id} shows no webview for its second tab`);
    const pg = new CDP(popped.webSocketDebuggerUrl);
    await pg.open();
    try {
      const keysIn = () => cdp.eval(`(() => { const w = document.querySelector('.win[data-id="${id}"]'); return !!w && w.contains(document.activeElement); })()`);
      await clickInPage(cdp, pg, spot.x, spot.y, `a blank spot of the page in window ${id}`, keysIn, 3000).catch((e) => bad.push(`a click in the page did not put the keys in window ${id} (${e.message})`));
    } finally {
      pg.close();
    }
    const ran = await cdp.eval(`typeof window.__flow.menu === 'function' ? window.__flow.menu('new-page') : 'no __flow.menu'`);
    let t3 = null;
    if (ran !== true) bad.push(`__flow.menu('new-page') returned ${q(ran)}`);
    else {
      t3 = await waitFor(async () => {
        if ((await tabCountNow()) !== strip.tabs.length + 1) return null;
        const r = await cdp.eval(`(() => { const w = document.querySelector('.win[data-id="${id}"]'); const el = w.querySelector('.ptabs'); const ad = w.querySelector('.addr .ad'); return { tabs: [...el.querySelectorAll('.ptab')].map((t) => t.textContent.replace('×', '').trim()), active: [...el.querySelectorAll('.ptab')].findIndex((t) => t.classList.contains('on')), address: document.activeElement === ad }; })()`);
        return r.tabs.length === strip.tabs.length + 1 ? r : null;
      }, { timeout: 5000, interval: 200, label: `a third tab in window ${id} after ⌘T` }).catch((e) => { bad.push(e.message); return null; });
      if (t3 && t3.active !== t3.tabs.length - 1 && t3.active !== strip.active + 1) bad.push(`the new tab is not the one in front (${q(t3)})`);
      if (t3 && !t3.address) bad.push('the address field of the new tab is not focused');
      const after2 = await cdp.eval('window.__flow.windows().length');
      if (after2 !== before) bad.push(`⌘T opened ${after2 - before} new window(s) instead of a tab`);
    }
    // the dock's page button (item 1): a page window of its own, even with this page window in front; its tabs stay
    const ids = () => cdp.eval('window.__flow.windows().map((w) => w.id)');
    const tabCount = () => cdp.eval(`document.querySelectorAll('.win[data-id="${id}"] .ptab').length`);
    const ids0 = await ids(), tabs0 = await tabCount();
    const dockErr = await clickDock(cdp, 'page');
    let made = null;
    if (dockErr) bad.push(dockErr);
    else {
      made = await waitFor(async () => {
        const fresh = (await ids()).filter((x) => !ids0.includes(x));
        return fresh.length ? cdp.eval(`window.__flow.windows().find((w) => w.id === ${q(fresh[0])})`) : null;
      }, { timeout: 5000, interval: 200, label: 'a window from the dock\'s page button' }).catch((e) => { bad.push(e.message); return null; });
      if (made && made.type !== 'page') bad.push(`the dock's page button made a ${made.type} window`);
      const tabs1 = await tabCount();
      if (tabs1 !== tabs0) bad.push(`the dock's page button changed the tabs of ${id} (${tabs0} to ${tabs1})`);
    }
    if (bad.length) throw new Error(bad.join('; '));
    await shot(cdp, '14-tabs');
    return `a target=_blank link in window ${id} opened tab ${strip.active + 1} of ${strip.tabs.length} [${strip.tabs.join(' | ')}] showing ${base}popped; ⌘T (new-page) with that window in front added tab ${t3.active + 1} of ${t3.tabs.length} with the address focused; no new window; the dock's page button made page window ${made && made.id}, tabs of ${id} unchanged`;
  } finally {
    srv.close();
  }
}

// Closing a page window always closes it, also when its site guards unsaved typing: no leave/stay ask (owner, Nov 1
// 20:47; lead 17:4x). Such a page is kept out of sight for 10 s, and ⇧⌘T in that time brings it back as it was: the same
// live page (performance.timeOrigin), typing and all.
async function guardCheck(cdp) {
  const { srv, base } = await tabSite();
  const url = `${base}guard`;
  try {
    const id = idOf(await cdp.eval(`window.__flow.openPage(${q(url)})`));
    if (!id) throw new Error('__flow.openPage() returned no window');
    await waitFor(async () => (await cdp.eval(`(() => { const p = window.__flow.page(${q(id)}); return p && !p.isLoading() ? p.getURL() : null; })()`)) === url, { timeout: 20000, interval: 300, label: `the guard page in window ${id}` });
    let last = '';
    await waitFor(async () => {
      const r = JSON.stringify(await cdp.eval(`(() => { const w = document.querySelector('.win[data-id="${id}"]'); if (!w) return null; const b = w.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`));
      const still = r === last;
      last = r;
      return still;
    }, { timeout: 5000, interval: 300, label: `window ${id} to hold still` });
    const target = await waitFor(async () => (await listTargets()).find((t) => t.type === 'webview' && t.url === url), { timeout: 10000, interval: 300, label: `a webview target for ${url}` });
    const g = new CDP(target.webSocketDebuggerUrl);
    await g.open();
    const typed = `typed by the e2e ${Date.now()}`;
    try {
      const box = await g.eval(`(() => { const r = document.getElementById('t').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2, vw: innerWidth }; })()`);
      const wv = await cdp.eval(`(() => { const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
      if (!wv) throw new Error(`window ${id} has no webview`);
      const sc = wv.w / box.vw;
      await clickInPage(cdp, g, wv.x + box.x * sc, wv.y + box.y * sc, `the text field of the guard page in window ${id}`, () => g.eval(`document.activeElement === document.getElementById('t')`), 3000);
      await g.send('Input.insertText', { text: typed });
      await waitFor(async () => (await g.eval(`document.getElementById('t').value`)) === typed, { timeout: 3000, interval: 100, label: 'the typing in the guard page' });
      const origin = await g.eval('performance.timeOrigin');
      // close it as a person does: the close light in its title bar
      const light = await cdp.eval(`(() => { const l = document.querySelector('.win[data-id="${id}"] .lights [data-l="close"]'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!light) throw new Error(`window ${id} has no close light`);
      await click(cdp, light.x, light.y);
      const open = () => cdp.eval(`window.__flow.windows().some((w) => w.id === ${q(id)})`);
      const gone = await waitFor(async () => !(await open()), { timeout: 3000, interval: 100, label: `window ${id} to close` }).then(() => true, () => false);
      const asked = await cdp.eval(`(() => { const a = document.querySelector('.win[data-id="${id}"] .pask.on'); if (!a) return null; const t = a.querySelector('.pa-t'); return (t || a).textContent.trim() + ' (' + [...a.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' / ') + ')'; })()`);
      if (!gone || asked) {
        // answer "leave", so the page does not hold up the rest of the run (the quit)
        await cdp.eval(`(() => { const b = document.querySelector('.win[data-id="${id}"] .pask.on .pa-yes'); if (b) b.click(); })()`);
        throw new Error(`closing page window ${id}, whose page guards typing, ${asked ? `asked ${q(asked)}` : 'left it open'}${gone ? '' : ' and the window stayed'}`);
      }
      const ran = await cdp.eval(`typeof window.__flow.menu === 'function' ? window.__flow.menu('tab-reopen') : 'no __flow.menu'`);
      if (ran !== true) throw new Error(`__flow.menu('tab-reopen') returned ${q(ran)}`);
      await waitFor(open, { timeout: 3000, interval: 100, label: `⇧⌘T to bring window ${id} back` });
      const back = await g.eval(`({ value: document.getElementById('t').value, origin: performance.timeOrigin })`);
      if (back.value !== typed || back.origin !== origin) throw new Error(`after ⇧⌘T window ${id} shows ${back.origin === origin ? 'the same page' : 'a reloaded page'} with ${q(back.value)} in its field, expected ${q(typed)}`);
    } finally {
      g.close();
    }
    await shot(cdp, '17-guard');
    // closed again for the rest of the run: it goes at once, and its page after the 10 s
    const light2 = await cdp.eval(`(() => { const l = document.querySelector('.win[data-id="${id}"] .lights [data-l="close"]'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (light2) await click(cdp, light2.x, light2.y);
    await waitFor(async () => !(await cdp.eval(`window.__flow.windows().some((w) => w.id === ${q(id)})`)), { timeout: 3000, interval: 100, label: `window ${id} to close again` });
    return `page window ${id} with typing its page guards closed at once with no leave/stay ask; ⇧⌘T brought back the same page with ${q(typed)} in its field`;
  } finally {
    srv.close();
  }
}

// The finger map (MAC_NOTES 60): two fingers pan the board and never leave the space; three fingers step through the
// sub-workspaces of the workspace; four step through the workspaces. Three and four are fed as the trackpad's touch
// stream (touch.js -> nav.fingers), as on the Mac.
async function swipeCheck(cdp) {
  await cdp.eval('window.__flow.go(0)');
  await waitFor(() => cdp.eval(`window.__flow.state().ui.at === window.__flow.state().ws[0].id`), { timeout: 5000, interval: 150, label: 'the first workspace on screen' });
  await sleep(800);
  const st = () => cdp.eval(`(() => { const s = window.__flow.state(); const i = s.ws.findIndex((w) => w.id === s.ui.at); const ws = s.ws[i < 0 ? 0 : i]; return { i, id: ws.id, at: ws.at || null, pan: ws.pan || 0, zones: (ws.zones || []).map((z) => ({ id: z.id, name: z.name })) }; })()`);
  let s = await st();
  if (!s.zones.length) throw new Error(`workspace ${s.id} has no sub-workspace to swipe to`);
  if (s.at) throw new Error(`workspace ${s.id} shows sub-workspace ${s.at}, expected its main space at the start`);
  const spot = await cdp.eval(`(() => {
    const v = document.getElementById('viewport').getBoundingClientRect();
    for (let y = v.top + v.height * 0.15; y < v.bottom - 90; y += 23) for (let x = v.left + 30; x < v.right - 30; x += 29) {
      const el = document.elementFromPoint(x, y);
      if (el && (el.classList.contains('canvas') || el.classList.contains('ws'))) return { x, y };
    }
    return null;
  })()`);
  if (!spot) throw new Error('no bare desktop in view to swipe over');
  const wheel = async (dx) => {
    const t0 = Date.now();
    for (let k = 0; k < 20; k++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: dx, deltaY: 0, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + k * 16) / 1000 });
    }
  };
  const touch = async (n, dx) => {
    const t0 = Date.now();
    for (let k = 0; k < 14; k++) await cdp.eval(`window.__flow.nav().fingers({ n: ${n}, t: ${t0 + k * 16}, dx: ${dx} })`);
    await cdp.eval(`window.__flow.nav().fingers({ n: 0, t: ${t0 + 14 * 16} })`);
  };
  // two fingers: the board pans, and the space and workspace stay
  const pan0 = s.pan;
  await wheel(30);
  await sleep(900);
  let a = await st();
  if (a.at || a.i !== s.i) throw new Error(`a two-finger swipe left the space: now ${q(a)}`);
  if (Math.abs(a.pan - pan0) < 0.01) throw new Error(`a two-finger swipe did not move the board (pan ${pan0} -> ${a.pan})`);
  // three fingers: the next sub-workspace, then back
  await touch(3, 40);
  s = await waitFor(async () => { const x = await st(); return x.at === x.zones[0].id ? x : null; }, { timeout: 5000, interval: 150, label: `a three-finger swipe to move ${s.id} to its first sub-workspace` }).catch(async (e) => { throw new Error(`${e.message}; now ${q(await st())}`); });
  await shot(cdp, '15-swiped');
  if (s.i !== a.i) throw new Error('the three-finger swipe changed the workspace instead of the space');
  await sleep(600);
  await touch(3, -40);
  await waitFor(async () => !(await st()).at, { timeout: 5000, interval: 150, label: 'a three-finger swipe back to the main space' }).catch(async (e) => { throw new Error(`${e.message}; now ${q(await st())}`); });
  // four fingers: the next workspace, then back
  await sleep(600);
  await touch(4, 40);
  const b = await waitFor(async () => { const x = await st(); return x.i === a.i + 1 ? x : null; }, { timeout: 5000, interval: 150, label: 'a four-finger swipe to the next workspace' }).catch(async (e) => { throw new Error(`${e.message}; now ${q(await st())}`); });
  await sleep(600);
  await touch(4, -40);
  await waitFor(async () => (await st()).i === a.i, { timeout: 5000, interval: 150, label: 'a four-finger swipe back' }).catch(async (e) => { throw new Error(`${e.message}; now ${q(await st())}`); });
  return `in ${a.id}: two fingers panned the board (pan ${pan0} -> ${a.pan}) and stayed in the space; three fingers moved to sub-workspace ${q(s.zones[0].name)} and back; four fingers moved to ${b.id} and back`;
}

function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Where pty.js finds claude: ~/bin, ~/.local/bin, then the login shell's PATH.
function claudeBin() {
  for (const p of [path.join(HOME, 'bin/claude'), path.join(HOME, '.local/bin/claude')]) if (isExec(p)) return p;
  const r = spawnSync('/bin/zsh', ['-ilc', 'command -v claude'], { encoding: 'utf8', timeout: 20000 });
  const p = (r.stdout || '').trim().split('\n').pop() || '';
  if (p.startsWith('/') && isExec(p)) return p;
  throw new Error(`cannot find claude in ~/bin, ~/.local/bin or the login shell's PATH (${q(oneLine(r.stderr || r.stdout || '', 160))})`);
}

// Tests only open, resume or fork sessions they made themselves (STATUS, since Nov 1 18:45). The /cost setup denies
// Bash: some Claude builds treat /cost as a prompt, and Bash can recursively invoke claude. It runs in a detached,
// bounded process group so a timeout kills every descendant before the e2e continues. OWN_DIR is removed at the end of
// the run; the transcript stays.
const OWN_DIR = path.join(HOME, '.flow-dev', 'ship', `e2e-${Date.now()}`);
const ownIds = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processGroupAlive(pid) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true;
    throw e;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
}

async function waitForProcessGroupGone(pid, timeout) {
  const end = Date.now() + timeout;
  while (processGroupAlive(pid) && Date.now() < end) await delay(25);
  return !processGroupAlive(pid);
}

async function runDetachedProbe(command, args, { cwd, env, timeout }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', outputTruncated = false;
  const capture = (current, chunk) => {
    const room = 1024 * 1024 - current.length;
    if (chunk.length > room) outputTruncated = true;
    return room > 0 ? current + chunk.slice(0, room) : current;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s) => { stdout = capture(stdout, s); });
  child.stderr.on('data', (s) => { stderr = capture(stderr, s); });
  const failed = new Promise((_, reject) => child.once('error', reject));
  let exitResult = { code: null, signal: null };
  child.once('exit', (code, signal) => { exitResult = { code, signal }; });
  const closed = new Promise((resolve) => child.once('close', () => resolve(exitResult)));
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeout); });
  let result;
  try {
    result = await Promise.race([closed, failed, timedOut]);
  } finally {
    clearTimeout(timer);
  }
  if (result.timedOut) {
    signalProcessGroup(child.pid, 'SIGTERM');
    if (!await waitForProcessGroupGone(child.pid, 400)) signalProcessGroup(child.pid, 'SIGKILL');
    const gone = await waitForProcessGroupGone(child.pid, 2000);
    child.stdout.destroy();
    child.stderr.destroy();
    if (!gone) throw new Error(`timed-out process group ${child.pid} survived SIGKILL`);
    return { code: null, signal: 'SIGKILL', timedOut: true, stdout, stderr, outputTruncated, pid: child.pid };
  }
  await closed;
  if (processGroupAlive(child.pid)) {
    signalProcessGroup(child.pid, 'SIGKILL');
    await waitForProcessGroupGone(child.pid, 2000);
    throw new Error(`probe exited but descendant process group ${child.pid} remained`);
  }
  return { ...result, timedOut: false, stdout, stderr, outputTruncated, pid: child.pid };
}

async function makeOwnSession() {
  const word = `flowe2e${Date.now().toString(36)}`;
  const dir = path.join(OWN_DIR, word);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const bin = claudeBin();
  const env = { PATH: process.env.PATH, HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, SHELL: process.env.SHELL, TERM: 'xterm-256color' };
  const r = await runDetachedProbe(bin,
    ['-p', '/cost', '--disallowedTools', 'Bash', '--session-id', id],
    { cwd: dir, env, timeout: 90000 });
  const files = [...new Set([dir, fs.realpathSync(dir)])].map((d) => path.join(HOME, '.claude/projects', d.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`));
  const file = files.find((f) => fs.existsSync(f));
  ownIds.push(`${id} (claude -p "/cost" in ${dir})`);
  if (r.timedOut || r.outputTruncated || r.code !== 0 || !file) {
    const outcome = r.timedOut ? 'timed out after 90s; process group killed' : r.outputTruncated ? 'wrote more than 1 MiB to stdout/stderr' : `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}`;
    throw new Error(`${bin} -p "/cost" --disallowedTools Bash --session-id ${id} in ${dir}: ${outcome}, transcript ${file ? 'written' : `missing (looked at ${files.join(', ')})`}, stdout ${q(oneLine(r.stdout || '', 400))}, stderr ${q(oneLine(r.stderr || '', 400))}`);
  }
  return { id, word, dir, file, said: commandOutput(file), probe: r, bin };
}

// What a local command printed, as the session's transcript keeps it (<local-command-stdout>): for /cost, "Total cost: ..."
// with an API key, and on a Max account a sentence about the subscription or its overages, worded by Claude Code's version
// (MAC_NOTES 17, 31). Lines of 12 characters or more, spaces collapsed.
function commandOutput(file) {
  const lines = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    let d;
    try {
      d = JSON.parse(l);
    } catch (e) {
      throw new Error(`${file} line ${i + 1} is not JSON: ${e.message}`);
    }
    const m = typeof d.content === 'string' && d.content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    if (m) lines.push(...m[1].split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 12));
  });
  return lines;
}
// A screen shows one of those lines (its first 40 characters), long lines wrapped at any width.
const showsOutput = (said, t) => {
  const flat = [String(t || '').replace(/\n\s*/g, ''), String(t || '').replace(/\n\s*/g, ' ')].map((x) => x.replace(/\s+/g, ' '));
  return said.find((l) => flat.some((f) => f.includes(l.slice(0, 40)))) || null;
};

async function forkCheck(cdp) {
  const own = await makeOwnSession();
  await cdp.eval('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  const box = await cdp.eval(`(() => { const el = document.querySelector('#q'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!box) throw new Error('there is no sidebar search box (#q)');
  await click(cdp, box.x, box.y);
  const rowOf = () => cdp.eval(`(() => { const r = document.querySelector('#sblist .srow[data-sess="${own.id}"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + Math.min(60, b.width / 2), y: b.top + b.height / 2 }; })()`);
  let row = null;
  for (const text of [own.id.slice(0, 8), own.word]) {
    await cdp.eval(`(() => { const el = document.querySelector('#q'); el.focus(); el.select(); })()`);
    await cdp.send('Input.insertText', { text });
    row = await waitFor(rowOf, { timeout: 8000, interval: 300, label: `the session ${own.id} in the sidebar search for ${q(text)}` }).catch(() => null);
    if (row) break;
  }
  if (!row) throw new Error(`the sidebar search lists session ${own.id} neither for the start of its id nor for its folder ${q(own.word)}`);
  await click(cdp, row.x, row.y);
  const winOf = (expr) => cdp.eval(`(() => { const w = window.__flow.windows().find((x) => ${expr}); return w ? { id: w.id, title: w.title, sessionId: w.sessionId } : null; })()`);
  const parent = await waitFor(() => winOf(`x.sessionId === ${q(own.id)}`), { timeout: 8000, interval: 200, label: 'a window for the session opened from the search' });
  let ptext = '';
  const claudeUp = (t) => CLAUDE_RE.test(t) || TRUST_RE.test(t);
  // The conversation is what /cost printed, read from the session's own transcript; without that, the fixed /cost lines.
  const CONVERSATION = /Total cost:|Total duration \(|Total code changes:|\d+ input, \d+ output/;
  const conversation = (t) => (own.said.length ? !!showsOutput(own.said, t) : CONVERSATION.test(t) || subscriptionCost(t));
  // Up means the conversation (the /cost exchange) or the trust question is drawn, not just the banner.
  await waitFor(async () => {
    ptext = (await cdp.eval(termText(parent.id))) || '';
    return TRUST_RE.test(ptext) || conversation(ptext);
  }, { timeout: 40000, interval: 500, label: `the resumed session ${parent.id} to show its conversation or the trust question` }).catch((e) => {
    if (!claudeUp(ptext)) throw new Error(`${e.message}; screen ${q(oneLine(ptext, 240))}`);
  });
  // the window's menu (fork) is on its title bar: a right-click in the terminal opens the terminal's own menu (Copy, Paste,
  // Select All) from batch 10 (term.js)
  const at = await cdp.eval(`(() => { const t = document.querySelector('.win[data-id="${parent.id}"] > .tb .title'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 }; })()`);
  if (!at) throw new Error(`window ${parent.id} has no title bar to right-click`);
  const before = await cdp.eval(`(() => { const r = document.querySelector('.win[data-id="${parent.id}"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  await rightClick(cdp, at.x, at.y);
  const items = await waitFor(async () => {
    const l = await cdp.eval(`[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`);
    return l.length ? l : null;
  }, { timeout: 3000, interval: 100, label: 'a menu after right-clicking the agent' }).catch(() => []);
  const after = (await cdp.eval(termText(parent.id))) || '';
  const tmuxMenu = /Horizontal Split|Vertical Split|Respawn|Swap Up/.test(after) && !/Horizontal Split|Vertical Split|Respawn|Swap Up/.test(ptext);
  const fi = items.findIndex((t) => /^fork/.test(t));
  if (fi < 0 || tmuxMenu) throw new Error(`right-clicking the agent showed ${items.length ? `Flow's menu [${items.join(' | ')}]` : 'no Flow menu'}${tmuxMenu ? ' and tmux\'s own menu in the terminal' : ''}`);
  const btn = await cdp.eval(`(() => { const b = document.querySelectorAll('.ctx button')[${fi}].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await click(cdp, btn.x, btn.y);
  const fork = await waitFor(() => cdp.eval(`(() => { for (const ws of window.__flow.state().ws) for (const w of ws.windows) if (w.forkFrom === ${q(own.id)}) return { id: w.id, title: w.title, label: w.label, sessionId: w.sessionId, forkFrom: w.forkFrom }; return null; })()`), { timeout: 10000, interval: 200, label: 'a window forked from the session' });
  const bad = [];
  if (!UUID_V4.test(fork.sessionId || '') || fork.sessionId === own.id) bad.push(`the fork's session id is ${q(fork.sessionId)}, it must be a new UUID`);
  // Its own title stays empty so Claude's topic shows (owner, 20:45); "fork of ..." is the name it carries until then.
  if (!/^fork of /.test(fork.title || fork.label || '')) bad.push(`the fork is named ${q(fork.title || fork.label)}`);
  await sleep(1200);
  const rects = await cdp.eval(`(() => { const r = (id) => { const b = document.querySelector('.win[data-id="' + id + '"]').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }; return { p: r(${q(parent.id)}), f: r(${q(fork.id)}), vw: document.getElementById('viewport').clientWidth, vh: document.getElementById('viewport').clientHeight }; })()`);
  const { p, f } = rects;
  const sideBySide = Math.abs(f.y - p.y) < 3 && f.x > p.x && f.x - (p.x + p.w) < rects.vw * 0.03;
  const stacked = Math.abs(f.x - p.x) < 3 && f.y > p.y && f.y - (p.y + p.h) < rects.vh * 0.04;
  if (!sideBySide && !stacked) bad.push(`the fork is not beside its parent (parent ${q(p)}, fork ${q(f)}, parent before ${q(before)})`);
  const cmd = tmux(['list-panes', '-t', `flow_${fork.id}`, '-F', '#{pane_start_command}']).out;
  if (!cmd.includes(`--resume ${own.id} --fork-session --session-id ${fork.sessionId}`)) bad.push(`tmux pane of flow_${fork.id} started ${q(oneLine(cmd, 300))}`);
  ownIds.push(`${fork.sessionId} (fork of ${own.id}, window ${fork.id})`);
  // The parent's conversation is the /cost exchange; the fork must show it too (unless Claude Code asks to trust the
  // folder first, as it may on a Mac whose home folder is not trusted: then only the rest is checked).
  // Any line of the /cost exchange: a fork window can be half the parent's height, so the top lines may be out of view.
  let ftext = '';
  const trusted = !TRUST_RE.test(ptext);
  await waitFor(async () => {
    ftext = (await cdp.eval(termText(fork.id))) || '';
    return trusted ? conversation(ftext) : claudeUp(ftext);
  }, { timeout: 40000, interval: 500, label: trusted ? `the parent's conversation (the /cost exchange) in the fork ${fork.id}` : `Claude Code in the fork ${fork.id}` }).catch((e) => bad.push(`${e.message}; screen ${q(oneLine(ftext, 240))}`));
  if (trusted && !conversation(ptext)) bad.push(`the parent does not show its conversation either (screen ${q(oneLine(ptext, 200))})`);
  if (bad.length) throw new Error(bad.join('; '));
  await shot(cdp, '11-fork');
  const shown = trusted ? `; the parent and the fork both show the conversation (${q(oneLine((own.said.length ? showsOutput(own.said, ftext) : ftext.split('\n').find((l) => CONVERSATION.test(l) || SUBSCRIPTION_RE.test(l))) || '', 60))}, ${own.said.length ? `one of ${own.said.length} lines /cost printed in the transcript` : 'the fixed /cost lines: the transcript kept no command output'})` : `; Claude Code asks whether to trust ${own.dir} (never answered), so the conversation itself is not on screen`;
  return `session ${own.id} made with claude -p "/cost" in ${own.dir}, opened from the search; right-click showed [${items.join(' | ')}]; fork ${fork.id} with session ${fork.sessionId}, ${sideBySide ? 'right of' : 'below'} its parent, runs claude --resume <parent> --fork-session --session-id <fork>${shown}`;
}

/* ---------- tmux (the e2e socket only) ---------- */

function tmux(args) {
  const r = spawnSync(TMUX, ['-L', SOCKET, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function tmuxSessions() {
  const r = tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}']);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const [name, created, attached] = l.split('\t');
    return { name, created: Number(created), attached: Number(attached) };
  });
}
function tmuxPane(session) {
  const r = tmux(['list-panes', '-t', `=${session}:`, '-F', '#{pane_pid}\t#{pane_current_command}']);
  const [pid, command] = (r.out.split('\n')[0] || '').split('\t');
  return { pid: Number(pid) || 0, command: command || '?' };
}
function findSession(id) {
  const names = new Set([`flow_${id}`, `flow_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`, `flow_${id.replace(/[^A-Za-z0-9_-]/g, '')}`]);
  return tmuxSessions().find((s) => names.has(s.name)) || null;
}

/* ---------- the app process ---------- */

function plistValue(bundle, k) {
  const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${k}`, path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function launchCommand() {
  if (opt.dev) {
    const rel = fs.readFileSync(path.join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim();
    // Linux (the VM, under xvfb): Chromium's setuid sandbox helper is not installed. The marker makes the e2e's own
    // Electron recognizable in ps; the e2e itself only ever stops the pid it launched and that pid's process group.
    const extra = LINUX ? ['--no-sandbox', '--flow-e2e'] : [];
    return { bin: path.join(ROOT, 'node_modules/electron/dist', rel), args: [ROOT, ...extra], cwd: ROOT, label: `dev build, ${ROOT}` };
  }
  if (!fs.existsSync(path.join(opt.app, 'Contents/Info.plist'))) throw new Error(`there is no app bundle at ${opt.app} (build and install it with scripts/package.sh)`);
  const id = plistValue(opt.app, 'CFBundleIdentifier');
  if (id !== BUNDLE_ID) throw new Error(`${opt.app} is ${id || 'not an app'}, not ${BUNDLE_ID}; not launching it`);
  const exe = plistValue(opt.app, 'CFBundleExecutable');
  return { bin: path.join(opt.app, 'Contents/MacOS', exe), args: [], cwd: '/', label: `${opt.app} (${plistValue(opt.app, 'CFBundleShortVersionString')})` };
}

// What launchd gives an app opened from the Finder or the Dock: no login PATH, no terminal variables.
function appEnv(userData) {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  // On Linux the app also needs the X display that xvfb-run gives this process.
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING', ...(LINUX ? ['DISPLAY', 'XAUTHORITY'] : [])]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // FLOW_BACKGROUND=1: every Flow window opens inactive (no focus, no dock icon), so a run on the Mac never takes
  // focus from the owner's own Flow (MAC_NOTES item 10). Check 9 proves it.
  return { ...env, FLOW_USER_DATA: userData, FLOW_TMUX_SOCKET: SOCKET, FLOW_CDP_PORT: String(PORT), FLOW_BACKGROUND: '1' };
}

class App {
  constructor(label, userData) {
    this.label = label;
    this.userData = userData;
    this.exit = null;
  }

  start() {
    const { bin, args, cwd } = launchCommand();
    this.logPath = path.join(SHOTS, `main-${this.label}.log`);
    const fd = fs.openSync(this.logPath, 'w');
    this.proc = spawn(bin, args, { cwd, env: appEnv(this.userData), stdio: ['ignore', fd, fd], detached: true });
    fs.closeSync(fd);
    this.exited = new Promise((resolve) => {
      this.proc.once('exit', (code, signal) => { this.exit = { code, signal }; resolve(this.exit); });
      this.proc.once('error', (e) => { this.exit = { error: e.message }; resolve(this.exit); });
    });
  }

  running() {
    return !!this.proc && !this.exit;
  }

  describeExit() {
    if (!this.exit) return 'still running';
    if (this.exit.error) return `could not start: ${this.exit.error}`;
    return this.exit.signal ? `killed by ${this.exit.signal}` : `exit code ${this.exit.code}`;
  }

  logTail(n = 30) {
    try {
      return fs.readFileSync(this.logPath, 'utf8').trim().split('\n').slice(-n).join('\n');
    } catch {
      return '';
    }
  }

  logSize() {
    try {
      return fs.statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }

  async quit(timeout = 20000) {
    if (!this.running()) return this.exit;
