// Drives test/term-harness.html in a dev Electron over CDP and checks FlowTerm end to end against the real backend.
// Start the app first, from the flow folder, with the stand-in VM (test/term-standin-vm.cjs: ssh to flow-test.local runs
// against a local tmux server instead, nothing connects anywhere):
//   NODE_OPTIONS="--require $PWD/test/term-standin-vm.cjs --require $PWD/test/term-menu.cjs" FLOW_ENTRY=test/term-harness.html FLOW_USER_DATA=/tmp/flow-dev-term FLOW_TMUX_SOCKET=flow-dev-term FLOW_CDP_PORT=9563 ./node_modules/.bin/electron .
// then: FLOW_TEST_MENU=1 node test/term-cdp.mjs   (screenshots go to $SHOTS, default /tmp/flow-term-shots)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const PORT = Number(process.env.FLOW_CDP_PORT || 9563);
const SOCKET = process.env.FLOW_TMUX_SOCKET || 'flow-dev-term';
const SHOTS = process.env.SHOTS || '/tmp/flow-term-shots';
/* the same lookup as src/pty.js: Homebrew's tmux on the Mac, PATH elsewhere */
const TMUX = existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux';
/* Claude Code's first screen differs per machine and per folder trust state */
const BANNER = 'Welcome back|Claude Code|Free Code|Quick safety check';
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A session this suite makes for itself (tests open, resume or fork only their own sessions): `claude -p "/cost"` runs
   a local command, no API call, in a new folder under ~/.flow-dev/term/sessions, which is trusted through the home
   folder, so Claude Code opens it without the trust question (never answered by tests). */
function ownSession(tag) {
  const cwd = join(homedir(), '.flow-dev', 'term', 'sessions', `${tag}-${Date.now().toString(36)}`);
  mkdirSync(cwd, { recursive: true });
  const id = randomUUID();
  execFileSync('claude', ['-p', '/cost', '--session-id', id], { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[/.]/g, '-'), `${id}.jsonl`);
  if (!existsSync(file)) throw new Error(`claude -p /cost made no transcript at ${file}`);
  return { id, cwd };
}
/* every process below pid, with its command line (ps works on Linux and macOS) */
function descendants(pid) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const out = [];
  let frontier = [String(pid)];
  while (frontier.length) {
    const next = [];
    for (const r of rows) if (frontier.includes(r[2])) { out.push({ pid: r[1], args: r[3] }); next.push(r[1]); }
    frontier = next;
  }
  return out;
}
const results = [];
function ok(name, cond, detail) {
  const line = `${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` (${detail})` : ''}`;
  results.push({ name, cond: !!cond });
  console.log(line);
  return !!cond;
}
function tmux(...args) {
  return execFileSync(TMUX, ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim();
}
/* tmux 3.4 exits non-zero with "not in a mode" when there is no copy mode to cancel */
function cancelMode(session) {
  if (tmux('display', '-p', '-t', `=${session}:`, '#{pane_in_mode}') === '1') tmux('send-keys', '-t', `=${session}:`, '-X', 'cancel');
}
/* true when the tmux command exits 0, false when it exits non-zero; anything else (tmux missing) throws */
function tmuxOk(...args) {
  try {
    execFileSync(TMUX, ['-L', SOCKET, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch (e) {
    if (typeof e.status === 'number') return false;
    throw e;
  }
}

async function findTarget() {
  let lastErr = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('term-harness.html'));
      if (t) return t;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`term harness page not found on port ${PORT}: ${lastErr ? lastErr.message : 'no matching target'}`);
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
    else p.res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'assert')) {
    consoleErrors.push(msg.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleErrors.push(`exception: ${d.exception ? d.exception.description : d.text}`);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
};
await send('Runtime.enable');
await send('Page.enable');

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`evaluate threw: ${d.exception ? d.exception.description : d.text}\n  in: ${expression.slice(0, 160)}`);
  }
  return r.result.value;
}
async function waitFor(expression, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await ev(expression);
    if (last) return last;
    await sleep(step);
  }
  return last;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${SHOTS}/${name}.png`;
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`     screenshot ${file}`);
  return file;
}
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
};
async function key(k, modifiers = 0) {
  const d = typeof k === 'string' ? KEYS[k] : k;
  const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers };
  await send('Input.dispatchKeyEvent', d.text ? { type: 'keyDown', ...base, text: d.text, unmodifiedText: d.text } : { type: 'rawKeyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const letter = (ch) => ({ key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) });
const META = 4, CTRL = 2, SHIFT = 8, ALT = 1;
const type = (text) => send('Input.insertText', { text });
async function mouse(t, x, y, o = {}) {
  await send('Input.dispatchMouseEvent', {
    type: t, x, y, button: o.button || 'none', buttons: o.buttons || 0, clickCount: o.clickCount || 0,
    modifiers: o.modifiers || 0, deltaX: o.deltaX || 0, deltaY: o.deltaY || 0,
  });
}
const text = (name, n) => ev(`__h.t.${name}.getText(${n || 0})`);
async function dropFiles(name, files) {
  const r = await rectOf(`#w-${name} .fterm`);
  const x = r.x + r.w / 2, y = r.y + r.h / 2;
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x, y, data });
}
/* an 8x8 PNG in Claude orange */
function writePng(file) {
  const raw = Buffer.alloc(8 * 25);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) raw.set([215, 119, 87], y * 25 + 1 + x * 3);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
/* files on the clipboard as a Finder ⌘C leaves them (test/term-standin-vm.cjs writes them in main), then ⌘V */
async function pasteCopied(paths) {
  const marker = join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'clipboard-files');
  writeFileSync(`${marker}.new`, paths.join('\n') + '\n');
  renameSync(`${marker}.new`, marker);
  for (let i = 0; i < 50 && existsSync(marker); i++) await sleep(100);
  await sleep(200);
  const v = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: META };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...v, commands: ['paste'] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...v });
}
const rectOf = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function cellAt(name, row, col) {
  const r = await rectOf(`#w-${name} .xterm-screen`);
  const size = await ev(`({ cols: __h.t.${name}.cols, rows: __h.t.${name}.rows })`);
  const cw = r.w / size.cols, ch = r.h / size.rows;
  return { x: r.x + (col + 0.5) * cw, y: r.y + (row + 0.5) * ch, cw, ch };
}
async function focusTerm(name) {
  await ev(`__h.t.${name}.focus()`);
  await sleep(80);
}
const shellPrompt = async () => waitFor(`/[%$#❯>] *$/m.test(__h.t.shell.getText())`, 15000);
/* Records what the named terminal's xterm sends toward the pty into window.__sent[name], from xterm's own onData (the
   Terminal is found with queryObjects; FlowTerm does not expose it). */
async function recordSent(name) {
  const proto = await send('Runtime.evaluate', { expression: 'Terminal.prototype' });
  const all = await send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
  const r = await send('Runtime.callFunctionOn', {
    objectId: all.objects.objectId, returnByValue: true, arguments: [{ value: name }],
    functionDeclaration: `function (name) {
      const sent = window.__sent = window.__sent || {};
      sent[name] = [];
      const t = this.find((x) => __h.t[name].el.contains(x.element));
      if (t) t.onData((d) => sent[name].push(d));
      return !!t;
    }`,
  });
  if (!r.result.value) throw new Error(`no xterm found inside the ${name} terminal`);
}

try {
  // ---------- start: lazy spawn with the right size, all three open ----------
  const opened = await waitFor(`!!window.__h && ['claude','shell','team'].every((n) => __h.t[n] && __h.t[n].state === 'open')`, 20000);
  ok('claude, shell and team terminals open', opened, await ev(`JSON.stringify(Object.fromEntries(['claude','shell','team'].map((n) => [n, __h.t[n].state])))`));
  const sessions = tmux('list-sessions', '-F', '#{session_name}').split('\n');
  ok('tmux on the dev socket has flow_h-claude, flow_h-shell, flow_h-team', ['flow_h-claude', 'flow_h-shell', 'flow_h-team'].every((s) => sessions.includes(s)), sessions.join(' '));
  for (const n of ['claude', 'shell', 'team']) {
    const sz = await ev(`({ cols: __h.t.${n}.cols, rows: __h.t.${n}.rows })`);
    const tm = tmux('display', '-p', '-t', `=flow_h-${n}:`, '#{window_width} #{window_height}');
    ok(`${n}: tmux window size equals the xterm size from the first byte`, tm === `${sz.cols} ${sz.rows}`, `xterm ${sz.cols}x${sz.rows}, tmux ${tm.replace(' ', 'x')}`);
  }
  const look = await ev(`(() => {
    const el = document.querySelector('#w-claude .fterm'), cs = getComputedStyle(el);
    const row = document.querySelector('#w-claude .xterm-rows > div');
    const c = new OffscreenCanvas(1, 1).getContext('2d');
    c.font = '11.4px ' + cs.fontFamily;
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;white-space:pre;font:11.4px ' + cs.fontFamily;
    span.textContent = 'W'.repeat(32);
    document.body.appendChild(span);
    const domW = span.getBoundingClientRect().width / 32;
    span.remove();
    return { bg: cs.backgroundColor, color: cs.color, padding: cs.padding, family: cs.fontFamily, rowHeight: row && row.style.height,
      canvasW: c.measureText('W'.repeat(32)).width / 32, domW, sfMono: document.fonts.check('11.4px "SF Mono"'),
      cellW: document.querySelector('#w-claude .xterm-screen').getBoundingClientRect().width / __h.t.claude.cols, dpr: devicePixelRatio };
  })()`);
  ok('terminal body has the mockup .cc colors and padding', look.bg === 'rgb(12, 12, 12)' && look.color === 'rgb(232, 232, 232)' && look.padding === '8px 12px 6px', `${look.bg} ${look.color} ${look.padding}`);
  const pitch = Math.floor(11.4 * 1.55 * look.dpr) / look.dpr;
  ok('rows are the mockup line pitch (11.4px x 1.55 = 17.67px, floored to device pixels)', look.rowHeight && Math.abs(parseFloat(look.rowHeight) - pitch) < 0.02, `${look.rowHeight}, expected ${pitch}px at dpr ${look.dpr}`);
  ok('canvas and DOM resolve the same monospace font width', Math.abs(look.canvasW - look.domW) < 0.01, `canvas ${look.canvasW.toFixed(3)} dom ${look.domW.toFixed(3)} cell ${look.cellW.toFixed(3)} sfmono:${look.sfMono} dpr:${look.dpr}`);

  // ---------- Claude Code ----------
  const welcome = await waitFor(`/${BANNER}/.test(__h.t.claude.getText())`, 60000);
  ok('Claude Code welcome renders in the claude terminal', welcome);
  /* The folder trust question is answered with Enter, which changes Claude Code's own settings: report it, do not answer it. */
  const trust = /Quick safety check/.test(await text('claude'));
  const prompt = trust ? false : await waitFor(`/(❯|>)\\s/.test(__h.t.claude.getText()) && /\\?\\s*for shortcuts|bypass permissions|shift\\+tab|for shortcuts/i.test(__h.t.claude.getText())`, 30000);
  ok('Claude Code input prompt is ready', prompt, trust ? 'Claude Code asks whether to trust the home folder; answer it once by hand, then rerun' : undefined);
  await sleep(600);
  await shot('01-claude-welcome');
  /* Claude Code titles its terminal with its own name until the conversation has one: that names nothing, so it arrives
     as no title (owner, Nov 2 14:54); the shell checks below send real titles through the same path */
  const titled = await waitFor(`(__h.titles.claude || []).length >= 2`, 15000);
  const claudeTitles = await ev('__h.titles.claude || []');
  ok('Claude Code\'s own name as its title reaches the app as no title', titled && claudeTitles.every((t) => !/Claude Code|Free Code/i.test(t)), JSON.stringify(claudeTitles));

  /* Claude Code drops to 256 colors when TMUX is set unless CLAUDE_CODE_TMUX_TRUECOLOR is set; then its orange turns pale.
     xterm's DOM renderer writes RGB colors as inline style (as written, or as rgb() once it also sets a letter-spacing on
     that span, as it does for the banner's block glyphs with a steady cursor) and palette colors as xterm-fg-<n> classes. */
  const colors = await ev(`(() => {
    const glyphs = /[▐▛▜▝▘▗▖▙▟█╭╮╰╯✻]/;
    const rgb = new Set(), palette = new Set();
    const hex = (c) => (c[0] === '#' ? c.toLowerCase() : '#' + c.match(/\\d+/g).map((n) => Number(n).toString(16).padStart(2, '0')).join(''));
    let cells = 0;
    for (const row of [...document.querySelectorAll('#w-claude .xterm-rows > div')].slice(0, 12)) {
      for (const span of row.querySelectorAll('span')) {
        if (!glyphs.test(span.textContent)) continue;
        cells += 1;
        const m = /(?:^|;)\\s*color:\\s*(#[0-9a-f]{6}|rgb\\(\\d+,\\s*\\d+,\\s*\\d+\\))/i.exec(span.getAttribute('style') || '');
        const c = /xterm-fg-(\\d+)/.exec(span.className);
        if (m) rgb.add(hex(m[1]));
        if (c) palette.add(Number(c[1]));
      }
    }
    return { cells, rgb: [...rgb], palette: [...palette] };
  })()`);
  ok('Claude Code\'s banner glyphs reach xterm as RGB truecolor, not 256-color palette indexes', colors.cells > 0 && colors.rgb.length > 0 && colors.palette.length === 0, JSON.stringify(colors));
  ok('the banner is drawn in Claude orange #d77757 (the mockup\'s .c-w color)', colors.rgb.includes('#d77757'), colors.rgb.join(' ') || 'no RGB colors');
  await shot('01b-claude-colors');

  /* Shift+Enter first on an EMPTY input: if it ever arrived as Escape then Enter, an empty input submits nothing. */
  let newlineSafe = false;
  if (prompt) {
    await focusTerm('claude');
    await key('Enter', SHIFT);
    await sleep(300);
    await type('x');
    await waitFor(`/^\\s*x\\s*$/m.test(__h.t.claude.getText())`, 20000);
    const el = (await text('claude')).split('\n');
    const pr = el.findIndex((l) => /^\s*(❯|>)\s*$/.test(l));
    const xr = el.findIndex((l) => /^\s*x\s*$/.test(l));
    newlineSafe = pr >= 0 && xr === pr + 1;
    ok('Shift+Enter on an empty input opens a second input line', newlineSafe, `prompt row ${pr}, x row ${xr}`);
    await key(letter('c'), CTRL);
    await waitFor(`!/^\\s*x\\s*$/m.test(__h.t.claude.getText())`, 20000);
  }

  if (prompt) {
    await focusTerm('claude');
    await type('hello flow');
    const typed = await waitFor(`__h.t.claude.getText().includes('hello flow')`, 8000);
    ok('typing reaches Claude Code', typed);
  }
  if (newlineSafe) {
    await key('Enter', SHIFT);
    await sleep(150);
    await type('second line');
    await waitFor(`__h.t.claude.getText().includes('second line')`, 8000);
    const lines = (await text('claude')).split('\n');
    const a = lines.findIndex((l) => l.includes('hello flow'));
    const b = lines.findIndex((l) => l.includes('second line'));
    ok('Shift+Enter makes a newline in Claude Code\'s input (not a submit)', a >= 0 && b === a + 1 && !lines[a].includes('second line'), `rows ${a} and ${b}`);
    await shot('02-claude-shift-enter');
  } else {
    ok('Shift+Enter with text in the input (skipped: the empty-input check did not pass, so Enter could submit a prompt)', false);
  }

  if (prompt) {
    // a dropped image file becomes a Claude Code image attachment, also when its name needs escaping
    execFileSync('/bin/sh', ['-c', "mkdir -p '/tmp/flow term drop'"]);
    writePng("/tmp/flow term drop/it's an image.png");
    await dropFiles('claude', ["/tmp/flow term drop/it's an image.png"]);
    const attached = await waitFor(`/\\[Image #\\d+\\]/.test(__h.t.claude.getText())`, 8000);
    ok('a dropped image file becomes [Image #N] in Claude Code (name with a space and a quote)', attached, (await text('claude')).split('\n').filter((l) => /Image #|\.png/.test(l)).join(' | ') || 'no image line');
    await shot('02b-claude-image-drop');
  }

  if (prompt) {
    // ⌘V with an image and no text on the clipboard: main saves it as a PNG, its path is pasted, Claude Code attaches it
    const pasteDir = join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'pasted-images');
    const savedBefore = existsSync(pasteDir) ? readdirSync(pasteDir).length : 0;
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await ev(`(async () => {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const g = c.getContext('2d');
      g.fillStyle = '#d77757';
      g.fillRect(0, 0, 8, 8);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    })()`);
    await focusTerm('claude');
    const images = `(__h.t.claude.getText().match(/\\[Image #\\d+\\]/g) || []).length`;
    const imagesBefore = await ev(images);
    const v = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: META };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...v, commands: ['paste'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...v });
    const imaged = await waitFor(`${images} > ${imagesBefore}`, 8000);
    const saved = existsSync(pasteDir) ? readdirSync(pasteDir).filter((f) => f.endsWith('.png')) : [];
    ok('⌘V with an image on the clipboard attaches it in Claude Code ([Image #N], PNG saved by main)', imaged && saved.length > savedBefore,
      `${(await text('claude')).split('\n').filter((l) => /Image #/.test(l)).join(' | ') || 'no image line'}; ${saved.length} file(s) in ${pasteDir}`);
    await shot('02c-claude-image-paste');
  }

  if (prompt) {
    // ⌘V of an image file copied in Finder: its path is typed as a dropped file's is, so Claude Code attaches it
    writePng('/tmp/flow term drop/copied in finder.png');
    await focusTerm('claude');
    const images = `(__h.t.claude.getText().match(/\\[Image #\\d+\\]/g) || []).length`;
    const imagesBefore = await ev(images);
    await pasteCopied(['/tmp/flow term drop/copied in finder.png']);
    const attached = await waitFor(`${images} > ${imagesBefore}`, 8000);
    ok('⌘V of an image file copied in Finder attaches it in Claude Code ([Image #N]), as a drop does', attached,
      (await text('claude')).split('\n').filter((l) => /Image #|copied in finder/.test(l)).join(' | ') || 'no image line');
  }

  if (prompt) {
    // bracketed paste into Claude Code through xterm's own paste handling
    await ev(`(() => {
      const ta = document.querySelector('#w-claude .xterm-helper-textarea');
      const dt = new DataTransfer();
      dt.setData('text/plain', Array.from({ length: 14 }, (_, i) => 'pasted line ' + (i + 1)).join('\\n'));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    const pasted = await waitFor(`/Pasted text|pasted line 14/.test(__h.t.claude.getText())`, 8000);
    ok('paste reaches Claude Code as one bracketed paste', pasted, (await text('claude')).split('\n').filter((l) => /Pasted text|pasted line/.test(l)).slice(0, 2).join(' | '));
    await shot('03-claude-paste');
    /* one Ctrl+C on a non-empty input clears it; never press it on an empty input (twice exits Claude Code) */
    await key(letter('c'), CTRL);
    const cleared = await waitFor(`!__h.t.claude.getText().includes('hello flow') && !/Pasted text|pasted line 14/.test(__h.t.claude.getText())`, 8000);
    ok('Ctrl+C clears Claude Code\'s input', cleared);
  }

  if (prompt) {
    /* B6: xterm turns the wheel into Up/Down arrow keys whenever mouse reporting is off (scrollback is 0), and arrows at
       Claude Code's prompt step through earlier prompts. Through tmux the wheel must arrive as mouse wheel reports. */
    await recordSent('claude');
    const r = await rectOf('#w-claude .xterm-screen');
    for (let i = 0; i < 6; i++) await mouse('mouseWheel', r.x + r.w / 2, r.y + r.h / 2, { deltaY: -120 });
    for (let i = 0; i < 30; i++) await mouse('mouseWheel', r.x + r.w / 2, r.y + r.h / 2, { deltaY: -4 });
    for (let i = 0; i < 12; i++) await mouse('mouseWheel', r.x + r.w / 2, r.y + r.h / 2, { deltaY: 120 });
    await sleep(500);
    cancelMode('flow_h-claude');
    await sleep(300);
    const sent = (await ev('__sent.claude')).join('');
    const reports = (sent.match(/\x1b\[<6[45];\d+;\d+M/g) || []).length;
    const arrows = (sent.match(/\x1b[[O][AB]/g) || []).length;
    const inputLine = (await text('claude')).split('\n').filter((l) => /^\s*❯/.test(l)).pop();
    ok('the wheel over Claude Code arrives as mouse wheel reports, never as arrow keys, and the input stays empty',
      reports > 0 && arrows === 0 && inputLine !== undefined && /^\s*❯\s*$/.test(inputLine), `${reports} wheel reports, ${arrows} arrow keys, input ${JSON.stringify(inputLine)}`);
  }

  // ---------- resize reflows ----------
  const before = await ev(`({ cols: __h.t.claude.cols, rows: __h.t.claude.rows })`);
  await ev(`(() => { const w = document.getElementById('w-claude'); w.style.width = '520px'; w.style.height = '430px'; })()`);
  await waitFor(`__h.t.claude.cols < ${before.cols} && __h.t.claude.rows < ${before.rows}`, 3000, 50);
  await sleep(400);
  const after = await ev(`({ cols: __h.t.claude.cols, rows: __h.t.claude.rows })`);
  const tmAfter = tmux('display', '-p', '-t', '=flow_h-claude:', '#{window_width} #{window_height}');
  ok('resizing the window refits xterm and resizes the tmux window', after.cols < before.cols && tmAfter === `${after.cols} ${after.rows}`, `${before.cols}x${before.rows} -> ${after.cols}x${after.rows}, tmux ${tmAfter.replace(' ', 'x')}`);
  /* Claude Code's own redraw, not tmux's reflow of the old screen (which splits each old full-width line in two): the
     rule over its input line spans the new width, with the banner above it */
  const redraw = await ev(`(async () => {
    const t0 = Date.now(), seen = [];
    let last = '';
    for (;;) {
      const lines = __h.t.claude.getText().split('\\n');
      const at = lines.map((l) => /^\\s*❯/.test(l)).lastIndexOf(true);
      const above = at > 0 ? lines[at - 1] : '';
      const banner = /${BANNER}/.test(lines.slice(0, Math.max(at, 0)).join('\\n'));
      if (at > 0 && above === '─'.repeat(__h.t.claude.cols) && banner) return { ok: true, ms: Date.now() - t0 };
      const s = \`input row \${at}, line over it \${above.length} \${/^─+$/.test(above) ? 'rule' : 'text'}, banner \${banner}\`;
      if (s !== last) { seen.push(\`\${Date.now() - t0} ms: \${s}\`); last = s; }
      if (Date.now() - t0 > 15000) return { ok: false, seen, text: __h.t.claude.getText() };
      await new Promise((r) => setTimeout(r, 200));
    }
  })()`);
  ok('Claude Code redraws at the new width', redraw.ok, redraw.ok ? `after ${redraw.ms} ms`
    : `${redraw.seen.join('; ')}; copy mode ${tmux('display', '-p', '-t', '=flow_h-claude:', '#{pane_in_mode}')}; screen ${JSON.stringify(redraw.text)}`);
  await shot('04-claude-resized');
  await ev(`(() => { const w = document.getElementById('w-claude'); w.style.width = ''; w.style.height = ''; })()`);
  await waitFor(`__h.t.claude.cols === ${before.cols} && __h.t.claude.rows === ${before.rows}`, 3000, 50);
  const restored = await ev(`({ cols: __h.t.claude.cols, rows: __h.t.claude.rows })`);
  let tmBack = '';
  for (let i = 0; i < 30 && tmBack !== `${before.cols} ${before.rows}`; i++) { await sleep(100); tmBack = tmux('display', '-p', '-t', '=flow_h-claude:', '#{window_width} #{window_height}'); }
  ok('restoring the size restores the same cols and rows in xterm and tmux', restored.cols === before.cols && restored.rows === before.rows && tmBack === `${before.cols} ${before.rows}`, `first ${before.cols}x${before.rows}, restored xterm ${restored.cols}x${restored.rows}, tmux ${tmBack.replace(' ', 'x')}`);

  // a corner drag held with FlowTerm.hold gives the pty one resize at the end, not one per pause; tmux counts them
  tmux('set', '-g', '@flow_resizes', '0');
  tmux('set-hook', '-g', 'client-resized', 'set -gF @flow_resizes "#{e|+:#{@flow_resizes},1}"');
  const resizes = () => Number(tmux('show', '-gv', '@flow_resizes'));
  const dragCorner = async (w0, h0, w1, h1) => {
    for (let i = 1; i <= 8; i++) {
      await ev(`(() => { const w = document.getElementById('w-claude'); w.style.width = '${w0 + ((w1 - w0) * i) / 8}px'; w.style.height = '${h0 + ((h1 - h0) * i) / 8}px'; })()`);
      if (i === 4) await ev('__h.t.claude.fit()');
      await sleep(140);
    }
  };
  await ev('FlowTerm.hold(true)');
  await dragCorner(760, 560, 520, 430);
  const heldSize = await ev(`({ cols: __h.t.claude.cols, rows: __h.t.claude.rows })`);
  const duringHold = resizes();
  await ev('FlowTerm.hold(false)');
  await sleep(600);
  const releasedSize = await ev(`({ cols: __h.t.claude.cols, rows: __h.t.claude.rows })`);
  const afterHold = resizes();
  const tmHeld = tmux('display', '-p', '-t', '=flow_h-claude:', '#{window_width}x#{window_height}');
  tmux('set', '-g', '@flow_resizes', '0');
  await dragCorner(520, 430, 760, 560);
  await sleep(600);
  const unheld = resizes();
  tmux('set-hook', '-gu', 'client-resized');
  tmux('set', '-gu', '@flow_resizes');
  ok('FlowTerm.hold: an 8-step drag with a fit() in it gives no resize while held and one on release; the same drag unheld gives more',
    heldSize.cols === before.cols && heldSize.rows === before.rows && duringHold === 0 && afterHold === 1 && releasedSize.cols < before.cols
      && tmHeld === `${releasedSize.cols}x${releasedSize.rows}` && unheld > 1,
    `held at ${heldSize.cols}x${heldSize.rows}, pty resizes held ${duringHold}, on release ${afterHold} to ${tmHeld}; unheld drag ${unheld}`);
  await ev(`(() => { const w = document.getElementById('w-claude'); w.style.width = ''; w.style.height = ''; })()`);
  await waitFor(`__h.t.claude.cols === ${before.cols} && __h.t.claude.rows === ${before.rows}`, 3000, 50);

  // ---------- shell: typing, wheel through tmux history, links, find, keys ----------
  await shellPrompt();
  await focusTerm('shell');
  await type('seq 1 400; echo flow-shell-ok https://example.com/flow-link-test');
  await key('Enter');
  const shellOut = await waitFor(`/^flow-shell-ok https/m.test(__h.t.shell.getText())`, 8000);
  ok('shell runs typed commands', shellOut);
  await sleep(300);

  const sr = await rectOf('#w-shell .xterm-screen');
  const cx = sr.x + sr.w / 2, cy = sr.y + sr.h / 2;
  for (let i = 0; i < 12; i++) await mouse('mouseWheel', cx, cy, { deltaY: -40 });
  await sleep(500);
  const mode = tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode} #{scroll_position}').split(' ');
  ok('the wheel scrolls tmux history (copy mode, scrolled up)', mode[0] === '1' && Number(mode[1]) > 0, `pane_in_mode=${mode[0]} scroll_position=${mode[1]}`);
  const lines12 = Number(mode[1]);
  await shot('05-shell-history');
  for (let i = 0; i < 4; i++) await mouse('mouseWheel', cx, cy, { deltaY: 40 });
  await sleep(300);
  const mode2 = tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode} #{scroll_position}').split(' ');
  ok('wheel down scrolls back toward the bottom', Number(mode2[1]) < lines12, `scroll_position ${lines12} -> ${mode2[1]}`);
  cancelMode('flow_h-shell');
  await sleep(300);

  const swipes0 = await ev('__h.swipes.length');
  await mouse('mouseWheel', cx, cy, { deltaX: 120, deltaY: 0 });
  await sleep(150);
  ok('a sideways swipe over a terminal still reaches the app (workspace swipe)', (await ev('__h.swipes.length')) === swipes0 + 1, JSON.stringify(await ev('__h.swipes.slice(-1)')));
  await mouse('mouseWheel', cx, cy, { deltaX: 0, deltaY: -40 });
  await sleep(150);
  ok('a vertical wheel stays in the terminal', (await ev('__h.swipes.length')) === swipes0 + 1);
  cancelMode('flow_h-shell');
  await sleep(300);

  const sl = (await text('shell')).split('\n');
  const lrow = sl.findIndex((l) => /^flow-shell-ok https/.test(l));
  const lcol = sl[lrow].indexOf('https://');
  const at = await cellAt('shell', lrow, lcol + 6);
  await mouse('mouseMoved', at.x, at.y);
  await sleep(250);
  /* A plain click opens a link once it has turned out to be a single click (no drag, no second click within 300 ms);
     a drag or a double-click on one selects it; ⌘-click opens it at once. The delay is from the
     release to onLink, give or take the few ms by which a timer and performance.now() can differ. */
  await ev(`window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }`);
  await ev(`(() => { window.__upAt = 0; window.__linkAt = 0; window.__downs = []; document.addEventListener('mouseup', () => { window.__upAt = performance.now(); }, true);
    document.addEventListener('mousedown', (e) => { if (e.isTrusted) window.__downs.push(performance.now()); }, true);
    const push = __h.links.push.bind(__h.links); __h.links.push = (...a) => { window.__linkAt = performance.now(); return push(...a); }; })()`);
  const linkClick = async (c, count, modifiers = 0) => {
    await mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: count, modifiers });
    await mouse('mouseReleased', c.x, c.y, { button: 'left', buttons: 0, clickCount: count, modifiers });
  };
  let n0 = await ev('__h.links.length');
  await linkClick(at, 1);
  const plainOpen = await ev(`new Promise((r) => { const t0 = performance.now(); (function w() { if (__h.links.length > ${n0} || performance.now() - t0 > 2000) r(__h.links.length > ${n0} ? Math.round(window.__linkAt - window.__upAt) : null); else setTimeout(w, 5); })(); })`);
  const plainUrl = await ev('__h.links.length ? __h.links[__h.links.length - 1].url : null');
  await sleep(600);
  n0 = await ev('__h.links.length');
  await ev('window.__copied = null');
  await linkClick(at, 1);
  const firstUp = await ev('window.__upAt');
  await ev('window.__downs = []');
  await linkClick(at, 2);
  /* the rule is about the page: the gap from the first release to the second press as the page saw them, which on a
     loaded machine can pass 300 ms however fast the two clicks were sent; within 10 ms of 300 either outcome is right */
  const dblGap = Math.round((await ev('window.__downs[0] || 0')) - firstUp);
  await sleep(1200);
  const dblLinks = (await ev('__h.links.length')) - n0, dblCopied = await ev('window.__copied');
  await sleep(600);
  await ev('window.__copied = null');
  const d0 = await cellAt('shell', lrow, lcol + 2), d1 = await cellAt('shell', lrow, lcol + 12);
  await mouse('mousePressed', d0.x, d0.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', d0.x + ((d1.x - d0.x) * i) / 5, d0.y, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', d1.x, d1.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(1200);
  const dragLinks = (await ev('__h.links.length')) - n0 - dblLinks, dragCopied = await ev('window.__copied');
  await sleep(600);
  n0 = await ev('__h.links.length');
  await linkClick(at, 1, META);
  const metaOpen = await ev(`new Promise((r) => { const t0 = performance.now(); (function w() { if (__h.links.length > ${n0} || performance.now() - t0 > 2000) r(__h.links.length > ${n0} ? Math.round(window.__linkAt - window.__upAt) : null); else setTimeout(w, 5); })(); })`);
  ok('a plain click on a link opens it once no second click came within 300 ms; ⌘-click opens it at once',
    plainOpen !== null && plainOpen >= 295 && plainUrl === 'https://example.com/flow-link-test' && metaOpen !== null && metaOpen < 200,
    JSON.stringify({ plainClickToOpenMs: plainOpen, metaClickToOpenMs: metaOpen, url: plainUrl }));
  ok('a double-click or a drag on a link selects it; a drag opens nothing, nor a double-click whose second press came within 300 ms',
    (Math.abs(dblGap - 300) <= 10 ? dblLinks <= 1 : dblLinks === (dblGap < 300 ? 0 : 1)) && dblCopied === 'https://example.com/flow-link-test' && dragLinks === 0 && dragCopied === 'tps://examp',
    JSON.stringify({ dblGapMs: dblGap, dblLinks, dblCopied, dragLinks, dragCopied }));
  cancelMode('flow_h-shell');

  await ev(`window.__keys = []; window.addEventListener('keydown', (e) => { if (e.metaKey) window.__keys.push({ k: e.key, prevented: e.defaultPrevented }); })`);
  await focusTerm('shell');
  const beforeK = await text('shell');
  await key(letter('k'), META);
  await key(letter('v'), META);
  await sleep(200);
  const metaSeen = await ev('window.__keys');
  const kSeen = metaSeen.find((x) => x.k === 'k');
  const vSeen = metaSeen.find((x) => x.k === 'v');
  ok('⌘K is not consumed by the terminal (reaches the app and the menu)', kSeen && !kSeen.prevented && (await text('shell')) === beforeK, JSON.stringify(kSeen));
  ok('⌘V is left to the menu paste role (not prevented, nothing typed)', vSeen && !vSeen.prevented, JSON.stringify(vSeen));

  // ⌘C copies a Shift-drag's xterm selection (clipboard write captured, the real clipboard is untouched). xterm forces its
  // own selection over tmux mouse mode with Option on macOS (macOptionClickForcesSelection) and with Shift elsewhere;
  // term.js hands every plain or Shift press to xterm with that key. FLOW_TEST_MAC=1, with test/term-mac.cjs loaded into
  // main, runs xterm's macOS branch here.
  const mac = process.env.FLOW_TEST_MAC === '1' || (await ev('flow.platform')) === 'darwin';
  if (process.env.FLOW_TEST_MAC === '1') ok('the page reports a Mac (navigator.platform MacIntel), so xterm.js takes its macOS branch', (await ev('navigator.platform')) === 'MacIntel', await ev('navigator.platform'));
  await ev(`window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }`);
  await ev(`window.__forced = []; document.querySelector('#w-shell .xterm-screen').addEventListener('mousedown', (e) => { if (!e.isTrusted) window.__forced.push({ alt: e.altKey, shift: e.shiftKey }); }, true)`);
  const sl2 = (await text('shell')).split('\n');
  const orow = sl2.findIndex((l) => /^flow-shell-ok https/.test(l));
  const p0 = await cellAt('shell', orow, 0), p1 = await cellAt('shell', orow, 12);
  /* a plain click on an empty cell first: the link checks left a selection, and a Shift press would extend that */
  const blank = await cellAt('shell', orow + 1, 40);
  await mouse('mousePressed', blank.x, blank.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', blank.x, blank.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  await ev('window.__forced = []');
  await mouse('mousePressed', p0.x - p0.cw * 0.4, p0.y, { button: 'left', buttons: 1, clickCount: 1, modifiers: SHIFT });
  await mouse('mouseMoved', (p0.x + p1.x) / 2, p0.y, { button: 'left', buttons: 1, modifiers: SHIFT });
  await mouse('mouseMoved', p1.x + p1.cw * 0.4, p1.y, { button: 'left', buttons: 1, modifiers: SHIFT });
  await mouse('mouseReleased', p1.x + p1.cw * 0.4, p1.y, { button: 'left', buttons: 0, clickCount: 1, modifiers: SHIFT });
  await sleep(150);
  await ev('window.__copied = null');
  await key(letter('c'), META);
  await sleep(150);
  const copied = await ev('window.__copied');
  const forced = await ev('window.__forced');
  ok(`a Shift-drag selects in xterm over tmux mouse mode, handed on with xterm's ${mac ? 'macOS' : 'Linux'} force key (${mac ? 'Option' : 'Shift'}), and ⌘C copies it`,
    copied === 'flow-shell-ok' && forced.length === 1 && (mac ? forced[0].alt && !forced[0].shift : forced[0].shift && !forced[0].alt), JSON.stringify({ copied, forced }));

  // a plain drag is xterm's own selection, copied on release; UTF-8 intact
  await focusTerm('shell');
  await type("clear; echo 'osc52 ✳ café-ok'");
  await key('Enter');
  await waitFor(`/^osc52 ✳ café-ok/m.test(__h.t.shell.getText())`, 4000);
  await ev('window.__copied = null');
  const crow = (await text('shell')).split('\n').findIndex((l) => /^osc52 ✳ café-ok/.test(l));
  const c0 = await cellAt('shell', crow, 0), c1 = await cellAt('shell', crow, 15);
  await mouse('mousePressed', c0.x - c0.cw * 0.2, c0.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', c0.x + ((c1.x - c0.x) * i) / 6, c0.y, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', c1.x, c1.y, { button: 'left', buttons: 0, clickCount: 1 });
  const osc52 = await waitFor('window.__copied', 15000);
  ok('a plain drag copies to the clipboard on release, UTF-8 intact', osc52 === 'osc52 ✳ café-ok', JSON.stringify(osc52));
  cancelMode('flow_h-shell');

  /* a drag released on a letter copies that letter too (xterm ends a drag at the cell edge nearest the pointer; term.js
     takes in the cells the drag starts and ends on), from either direction, and at the last cell of a full-width line */
  const dragCopy = async (row, from, to) => {
    await ev('window.__copied = null');
    await sleep(400);   // past tmux's 300 ms double-click window since the last press
    const a = await cellAt('shell', row, from), b = await cellAt('shell', row, to);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 6, a.y, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    const got = await waitFor('window.__copied', 15000);
    cancelMode('flow_h-shell');
    return got;
  };
  await focusTerm('shell');
  await type("clear; echo 'alpha beta gamma'");
  await key('Enter');
  await waitFor(`/^alpha beta gamma$/m.test(__h.t.shell.getText())`, 4000);
  const wrow = (await text('shell')).split('\n').indexOf('alpha beta gamma');
  const toWord = await dragCopy(wrow, 0, 9), toEnd = await dragCopy(wrow, 0, 15), backward = await dragCopy(wrow, 9, 0);
  ok('a plain drag released on a word\'s last letter copies through it: mid-line, at the line\'s end, and right to left',
    toWord === 'alpha beta' && toEnd === 'alpha beta gamma' && backward === 'alpha beta', JSON.stringify([toWord, toEnd, backward]));
  const cols = await ev('__h.t.shell.cols');
  await focusTerm('shell');
  await type(`clear; printf '%0${cols}d\\n' 0`);
  await key('Enter');
  await waitFor(`__h.t.shell.getText().split('\\n').includes('0'.repeat(${cols}))`, 4000);
  const frow = (await text('shell')).split('\n').indexOf('0'.repeat(cols));
  const full = await dragCopy(frow, 0, cols - 1);
  ok('a plain drag released on the last cell of a full-width line copies all of it', full === '0'.repeat(cols), `${(full || '').length} of ${cols} characters`);
  await ev('window.__copied = null');
  await sleep(400);   // past tmux's 300 ms double-click window since the drag's press, so this is a click of its own
  const pc = await cellAt('shell', frow, 5);
  await mouse('mousePressed', pc.x, pc.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', pc.x, pc.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(800);
  const clickMode = tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode}');
  ok('a plain click copies nothing and opens no scrollback', (await ev('window.__copied')) === null && clickMode === '0', `copied ${JSON.stringify(await ev('window.__copied'))}, copy mode ${clickMode}`);

  /* A plain drag is xterm's own selection, drawn here and not through the pty: tmux stays out of copy mode, release
     copies the text, and the highlight stays until the next click. */
  await focusTerm('shell');
  await type("clear; echo 'alpha beta gamma'");
  await key('Enter');
  await waitFor(`/^alpha beta gamma$/m.test(__h.t.shell.getText())`, 4000);
  const srow = (await text('shell')).split('\n').indexOf('alpha beta gamma');
  const selBoxes = (name) => ev(`document.querySelectorAll('#w-${name} .xterm-selection div').length`);
  const localDrag = async (name, row, from, to, during) => {
    await ev('window.__copied = null');
    await sleep(400);
    const a = await cellAt(name, row, from), b = await cellAt(name, row, to);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 6, a.y, { button: 'left', buttons: 1 });
    const mid = during ? await during() : null;
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    return { copied: await waitFor('window.__copied', 5000), mid };
  };
  const ld = await localDrag('shell', srow, 0, 9, async () => ({ boxes: await selBoxes('shell'), mode: tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode}') }));
  await sleep(500);
  const stays = await selBoxes('shell');
  ok('a plain drag is xterm\'s own selection: drawn with tmux out of copy mode, release copies it, and it stays highlighted',
    ld.mid.boxes > 0 && ld.mid.mode === '0' && ld.copied === 'alpha beta' && stays > 0, JSON.stringify({ ...ld, boxesAfter: stays }));
  const clickAt = async (c, count, modifiers = 0) => {
    await mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: count, modifiers });
    await mouse('mouseReleased', c.x, c.y, { button: 'left', buttons: 0, clickCount: count, modifiers });
  };
  const wcell = await cellAt('shell', srow, 7);
  await ev('window.__copied = null');
  await sleep(400);
  await clickAt(wcell, 1);
  await clickAt(wcell, 2);
  const word = await waitFor('window.__copied', 3000);
  await ev('window.__copied = null');
  await sleep(400);
  await clickAt(wcell, 1);
  await clickAt(wcell, 2);
  await clickAt(wcell, 3);
  /* the double-click's copy may land first; the clipboard ends with the line */
  await waitFor(`window.__copied === 'alpha beta gamma'`, 3000);
  const whole = await ev('window.__copied');
  const first = await localDrag('shell', srow, 0, 4);
  await ev('window.__copied = null');
  await sleep(400);
  await clickAt(await cellAt('shell', srow, 15), 1, SHIFT);
  const extended = await waitFor('window.__copied', 3000);
  ok('a double-click copies the word, a triple-click the line, and a Shift-click extends the selection to it',
    word === 'beta' && whole === 'alpha beta gamma' && first.copied === 'alpha' && extended === 'alpha beta gamma', JSON.stringify([word, whole, first.copied, extended]));
  await clickAt(await cellAt('shell', srow + 2, 3), 1);
  if (prompt) {
    /* Claude Code asks for every mouse report and paints its own selection when it gets a drag; here it gets none */
    const clines = (await text('claude')).split('\n');
    const brow = clines.findIndex((l) => l.includes('Claude Code'));
    const bcol = brow >= 0 ? clines[brow].indexOf('Claude Code') : 0;
    const cd = await localDrag('claude', brow, bcol, bcol + 10, async () => ({ boxes: await selBoxes('claude'),
      claudePaints: await ev(`[...document.querySelectorAll('#w-claude .xterm-rows span')].some((s) => /rgb\\(38, 79, 120\\)/.test(s.style.backgroundColor))`) }));
    ok('a plain drag over Claude Code selects in xterm: Claude paints no selection of its own, and release copies the text',
      brow >= 0 && cd.mid.boxes > 0 && !cd.mid.claudePaints && cd.copied === 'Claude Code', JSON.stringify(cd));
    await clickAt(await cellAt('claude', brow + 1, 1), 1);
  }
  /* An Option drag goes on without Option: in a shell to tmux, whose selection (copy mode) is copied through OSC 52 on
     release; over Claude Code to Claude, which paints and copies its own. xterm draws none. */
  const optionDrag = async (name, row, from, to, during) => {
    await ev('window.__copied = null');
    await sleep(400);
    const a = await cellAt(name, row, from), b = await cellAt(name, row, to);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1, modifiers: ALT });
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 6, a.y, { button: 'left', buttons: 1, modifiers: ALT });
    const mid = during ? await during() : null;
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1, modifiers: ALT });
    return { copied: await waitFor('window.__copied', 15000), mid };
  };
  const od = await optionDrag('shell', srow, 0, 9, async () => ({ boxes: await selBoxes('shell'), mode: tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode}') }));
  await sleep(300);
  ok('an Option drag in a shell is tmux\'s selection (copy mode, no xterm selection), copied on release',
    od.mid.boxes === 0 && od.mid.mode === '1' && od.copied === 'alpha beta' && tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode}') === '0', JSON.stringify(od));
  if (prompt) {
    const clines = (await text('claude')).split('\n');
    const brow = clines.findIndex((l) => l.includes('Claude Code'));
    const bcol = brow >= 0 ? clines[brow].indexOf('Claude Code') : 0;
    /* Claude draws its own selection a step or more behind the pointer under load, so its paint is waited for */
    const co = await optionDrag('claude', brow, bcol, bcol + 10, async () => ({ boxes: await selBoxes('claude'),
      claudePaints: !!(await waitFor(`[...document.querySelectorAll('#w-claude .xterm-rows span')].some((s) => /rgb\\(38, 79, 120\\)/.test(s.style.backgroundColor))`, 3000)) }));
    ok('an Option drag over Claude Code goes to Claude: it paints its own selection, xterm draws none, and Claude\'s copy arrives',
      brow >= 0 && co.mid.boxes === 0 && co.mid.claudePaints && typeof co.copied === 'string' && co.copied.includes('Claude Cod'), JSON.stringify(co));
    await clickAt(await cellAt('claude', brow + 1, 1), 1);
  }
  /* In a terminal split by hand (nobody polls its panes; term.js asks tmux for them on each press) a drag is xterm's
     selection, clipped to the pane it started in, and copies only that pane's part of each row. A press on the border
     goes to tmux, which moves it. */
  await focusTerm('shell');
  await type("clear; echo 'left pane text'");
  await key('Enter');
  await waitFor(`/^left pane text$/m.test(__h.t.shell.getText())`, 4000);
  const right = tmux('split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', '=flow_h-shell:');
  tmux('send-keys', '-t', right, "clear; echo 'right pane text'", 'Enter');
  await waitFor(`/right pane text/.test(__h.t.shell.getText())`, 6000);
  await sleep(500);
  const lw = Number(tmux('display', '-p', '-t', '=flow_h-shell:.0', '#{pane_width}'));
  const hrow = (await text('shell')).split('\n').findIndex((l) => l.startsWith('left pane text'));
  const clipOf = (name) => ev(`document.querySelector('#w-${name} .xterm-selection').style.clipPath`);
  const sd = await localDrag('shell', hrow, 0, 3, async () => ({ boxes: await selBoxes('shell'), mode: tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode}') }));
  const across = await localDrag('shell', hrow, 0, lw + 8, async () => ({ clip: await clipOf('shell') }));
  const leftRows = tmux('capture-pane', '-p', '-t', '=flow_h-shell:.0').split('\n').map((l) => l.replace(/\s+$/, ''));
  const lrow0 = leftRows.indexOf('left pane text');
  const twoRows = await (async () => {
    await ev('window.__copied = null');
    await sleep(400);
    const a = await cellAt('shell', hrow, 0), b = await cellAt('shell', hrow + 1, lw + 8);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
    return waitFor('window.__copied', 5000);
  })();
  const twoWant = `${leftRows[lrow0]}\n${leftRows[lrow0 + 1]}`;
  ok('a terminal split by hand: a drag is xterm\'s selection (tmux out of copy mode), clipped to its pane, and copies only that pane\'s part of each row',
    sd.mid.boxes > 0 && sd.mid.mode === '0' && sd.copied === 'left' && /polygon/.test(across.mid.clip) && across.copied === 'left pane text' && lrow0 >= 0 && twoRows === twoWant,
    JSON.stringify({ sd, across, twoRows, twoWant, lw }));
  const tri = await (async () => {
    await ev('window.__copied = null');
    await sleep(400);
    const c = await cellAt('shell', hrow, 2);
    await clickAt(c, 1);
    await clickAt(c, 2);
    await clickAt(c, 3);
    await waitFor(`window.__copied === 'left pane text'`, 3000);
    return ev('window.__copied');
  })();
  await ev('window.__copied = null');
  await key(letter('c'), META);
  await sleep(200);
  const metaC = await ev('window.__copied');
  await ev(`window.__menuCopy = null; (() => { const set = DataTransfer.prototype.setData; DataTransfer.prototype.setData = function (t, d) { window.__menuCopy = d; return set.call(this, t, d); }; })()`);
  await ev(`(() => { document.querySelector('#w-shell .xterm-helper-textarea').focus(); return document.execCommand('copy'); })()`);
  const menuCopy = await ev('window.__menuCopy');
  ok('in a split terminal a triple-click copies the pane\'s line only, and ⌘C and the Edit menu\'s Copy copy only the pane\'s part too',
    tri === 'left pane text' && metaC === 'left pane text' && menuCopy === 'left pane text', JSON.stringify({ tri, metaC, menuCopy }));
  const b0 = await cellAt('shell', hrow + 1, lw), b1 = await cellAt('shell', hrow + 1, lw - 4);
  await sleep(400);
  await mouse('mousePressed', b0.x, b0.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 4; i++) await mouse('mouseMoved', b0.x + ((b1.x - b0.x) * i) / 4, b0.y, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', b1.x, b1.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(800);
  const lw2 = Number(tmux('display', '-p', '-t', '=flow_h-shell:.0', '#{pane_width}'));
  const bsel = await selBoxes('shell');
  ok('a drag on the border between two panes goes to tmux, which moves the border (no xterm selection)', lw2 === lw - 4 && bsel === 0, JSON.stringify({ lw, lw2, boxes: bsel }));
  cancelMode('flow_h-shell');
  tmux('kill-pane', '-t', right);
  await sleep(1000);
  await clickAt(await cellAt('shell', 2, 3), 1);
  await sleep(500);

  /* ⌘F finds in the whole history through tmux's copy mode (flow.term.find): typing finds the nearest match up, ↩ the
     next one up, ⇧↩ the next one down, the current match in term.js's find orange (flow-tmux.conf); closing keeps the
     view with nothing marked, and a key goes back to the end and reaches the program. The needles are printed with
     printf, so the command line itself holds none. */
  const NEEDLES = `clear; printf 'find%s alpha\\n' me; seq 1 200; printf 'Find%s beta\\n' Me; seq 201 400; printf 'semi %s;\\n' x; echo find-end`;
  /* the marked text of each row ('|' between rows): copy mode's cursor cell is a span of its own inside a match */
  const marked = (sel) => ev(`(() => {
    const rows = [...document.querySelectorAll('${sel} .xterm-rows > div')];
    const pick = (re) => rows.map((r) => [...r.querySelectorAll('span')].filter((s) => re.test(s.style.backgroundColor)).map((s) => s.textContent).join('')).filter(Boolean).join('|');
    return { current: pick(/rgb\\(215, 119, 87\\)/), others: pick(/rgb\\(74, 49, 40\\)/), said: document.querySelector('${sel} .fterm-n').textContent };
  })()`);
  /* tmux draws a match before the find's answer reaches the bar, so both are waited for: the mark, and the bar saying
     nothing (a match was found) */
  const markedAs = async (sel, current, ms = 5000) => {
    const t0 = Date.now();
    let m = await marked(sel);
    while ((m.current !== current || m.said !== '') && Date.now() - t0 < ms) {
      await sleep(100);
      m = await marked(sel);
    }
    return m;
  };
  const findText = async (sel, s) => {
    await ev(`(() => { const i = document.querySelector('${sel} .fterm-find input'); i.focus(); i.select(); })()`);
    await type(s);
  };
  const shellMode = () => tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode} #{scroll_position}');
  await focusTerm('shell');
  await type(NEEDLES);
  await key('Enter');
  await waitFor(`/^find-end$/m.test(__h.t.shell.getText())`, 8000);
  await key(letter('f'), META);
  const findOpen = await waitFor(`!document.querySelector('#w-shell .fterm-find').hidden && document.activeElement === document.querySelector('#w-shell .fterm-find input')`, 2000);
  ok('⌘F opens the find bar with the field focused', findOpen);
  for (const ch of 'findme') await type(ch);
  const f1 = await markedAs('#w-shell', 'FindMe'), f1mode = shellMode();
  ok('typing finds the nearest match up in tmux\'s history, beyond the screen, and draws it in the find orange',
    f1.current === 'FindMe' && f1.said === '' && f1mode.split(' ')[0] === '1' && Number(f1mode.split(' ')[1]) > 0, JSON.stringify({ ...f1, mode: f1mode }));
  await shot('06-shell-find');
  await key('Enter');
  const f2 = await markedAs('#w-shell', 'findme');
  ok('↩ goes to the next match up', f2.current === 'findme', JSON.stringify(f2));
  /* what find is for: a drag over a found line copies it, and the view stays where find put it (the press moves the
     keys from the bar to the terminal, whose focus report would end copy mode) */
  const alphaRow = (await text('shell')).split('\n').findIndex((l) => l === 'findme alpha');
  const dragFrom = shellMode();
  const fdrag = alphaRow >= 0 ? await localDrag('shell', alphaRow, 0, 11) : { copied: null };
  await sleep(300);
  const dragTo = shellMode();
  ok('a drag over a found line copies it, and the view stays where find put it',
    fdrag.copied === 'findme alpha' && dragTo === dragFrom && dragFrom.startsWith('1 '), JSON.stringify({ row: alphaRow, copied: fdrag.copied, before: dragFrom, after: dragTo }));
  await ev(`document.querySelector('#w-shell .fterm-find input').focus()`);
  await key('Enter', SHIFT);
  const f3 = await markedAs('#w-shell', 'FindMe');
  ok('⇧↩ goes to the next match down, at once after a step up', f3.current === 'FindMe', JSON.stringify(f3));
  await type('x');
  const f4 = await waitFor(`document.querySelector('#w-shell .fterm-n').textContent === 'no matches'`, 5000);
  const f4m = await marked('#w-shell'), f4mode = shellMode();
  ok('a text that is nowhere says "no matches", marks nothing, and goes back to where the find started',
    !!f4 && f4m.current === '' && f4mode === '1 0' && /^find-end$/m.test(await text('shell')), JSON.stringify({ ...f4m, mode: f4mode }));
  await findText('#w-shell', 'FINDME');
  const f5 = await markedAs('#w-shell', 'FindMe');
  ok('upper case finds any case, as the bar always has', f5.current === 'FindMe' && f5.said === '', JSON.stringify(f5));
  await findText('#w-shell', 'semi x;');
  const f6 = await markedAs('#w-shell', 'semi x;');
  ok('a text ending in ";" is found as typed (tmux would take a last ";" as the end of its command)', f6.current === 'semi x;' && f6.said === '', JSON.stringify(f6));
  const keptMode = shellMode();
  await key('Escape');
  await sleep(300);
  const f7 = await marked('#w-shell'), f7mode = shellMode();
  ok('Esc closes the bar and keeps the view where it was, with nothing marked; focus goes back to the terminal',
    (await ev(`document.querySelector('#w-shell .fterm-find').hidden && document.activeElement === document.querySelector('#w-shell .xterm-helper-textarea')`))
      && f7.current === '' && f7.others === '' && f7mode === keptMode && f7mode.startsWith('1 ') && (await text('shell')).split('\n').some((l) => l.trimEnd() === 'semi x;'),
    JSON.stringify({ ...f7, mode: f7mode, before: keptMode, focus: await ev('document.activeElement.className'),
      barHidden: await ev(`document.querySelector('#w-shell .fterm-find').hidden`), last: (await text('shell')).split('\n').slice(-4) }));
  await type('echo typed-after-find');
  await key('Enter');
  const typedAfter = await waitFor(`/^typed-after-find$/m.test(__h.t.shell.getText())`, 5000);
  if (!typedAfter) await shot('06b-typed-after-find');
  ok('after find, a key leaves copy mode and every key reaches the program', typedAfter && shellMode().startsWith('0'),
    JSON.stringify({ mode: shellMode(), focus: await ev('document.activeElement.className'), last: (await text('shell')).split('\n').slice(-3) }));

  /* the same in a VM window on Flow's own tmux there (through the stand-in VM's ssh) */
  await ev(`(() => {
    const d = document.createElement('div');
    d.id = 'vmfindhost';
    d.style.cssText = 'position:absolute;left:14px;top:620px;width:640px;height:260px;display:flex;flex-direction:column;z-index:5;outline:1px solid #555';
    document.getElementById('desk').appendChild(d);
    window.__vmfind = FlowTerm.mount(d, { id: 'h-vmfind', cmd: 'shell', host: 'flow-test.local' });
    window.__vmfind.setVisible(true);
  })()`);
  const vmfOpen = await waitFor(`__vmfind.state === 'open'`, 15000);
  await sleep(1500);
  await ev('__vmfind.focus()');
  await type(NEEDLES);
  await key('Enter');
  const vmfOut = await waitFor(`/^find-end$/m.test(__vmfind.getText())`, 10000);
  await key(letter('f'), META);
  await waitFor(`!document.querySelector('#vmfindhost .fterm-find').hidden`, 2000);
  await type('findme');
  const v1 = await markedAs('#vmfindhost', 'FindMe');
  await key('Enter');
  const v2 = await markedAs('#vmfindhost', 'findme');
  await findText('#vmfindhost', 'semi x;');
  const v3 = await markedAs('#vmfindhost', 'semi x;');
  ok('in a VM window find goes through the VM\'s tmux the same way (nearest up, ↩ up, a last ";")',
    vmfOpen && vmfOut && v1.current === 'FindMe' && v2.current === 'findme' && v3.current === 'semi x;', JSON.stringify({ open: vmfOpen, out: !!vmfOut, v1, v2, v3 }));
  await key('Escape');
  await ev(`(async () => { await __vmfind.kill(); document.getElementById('vmfindhost').remove(); })()`);
  await sleep(500);

  // after the wheel opened tmux's scrollback (copy mode), typing and pasting go to the program, as in a terminal app
  const inMode = () => tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode}');
  const scrollBack = async () => {
    for (let i = 0; i < 6; i++) await mouse('mouseWheel', cx, cy, { deltaY: -120 });
    await sleep(400);
    return inMode();
  };
  const pasteShell = (s) => ev(`(() => {
    const ta = document.querySelector('#w-shell .xterm-helper-textarea');
    ta.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(s)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await focusTerm('shell');
  await type('clear; seq 1 300');
  await key('Enter');
  await sleep(600);
  const typedMode = await scrollBack();
  await type('echo typed-after-scroll');
  await key('Enter');
  const typedRan = await waitFor(`/^typed-after-scroll$/m.test(__h.t.shell.getText())`, 4000);
  ok('after the wheel scrolled back, typing leaves the scrollback and reaches the shell', typedMode === '1' && typedRan && inMode() === '0', `copy mode before ${typedMode}, after ${inMode()}`);
  await type('clear; seq 1 300; cat -v');
  await key('Enter');
  await sleep(600);
  const firstKeys = [];
  for (const [label, press] of [['q', () => type('q')], ['Escape', () => key('Escape')], ['Up', () => key({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 })]]) {
    const before = await scrollBack();
    await press();
    await sleep(300);
    firstKeys.push(`${label} ${before}->${inMode()}`);
  }
  const catLine = await waitFor(`/^q\\^\\[\\^\\[\\[A$/m.test(__h.t.shell.getText())`, 3000);
  const ccMode = await scrollBack();
  await key(letter('c'), CTRL);
  await sleep(500);
  const catGone = tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_current_command}') !== 'cat';
  ok('q, Escape, Up and Ctrl+C (copy-mode keys in tmux) each leave the scrollback and reach the program as typed',
    firstKeys.every((s) => s.endsWith('1->0')) && catLine && ccMode === '1' && catGone && inMode() === '0', `${firstKeys.join(', ')}; cat -v line ${catLine ? 'q^[^[[A' : 'missing'}; Ctrl+C ended cat: ${catGone}`);
  await shellPrompt();
  await type('clear; seq 1 300');
  await key('Enter');
  await sleep(600);
  const pasteMode = await scrollBack();
  await pasteShell('echo pasted-after-scroll');
  await sleep(400);
  const pastedLine = (await text('shell')).split('\n').find((l) => l.includes('pasted-after-scroll')) || '';
  ok('a paste after the wheel scrolled back leaves the scrollback and reaches the shell, nothing else typed', pasteMode === '1' && inMode() === '0' && pastedLine.trimEnd().endsWith(' echo pasted-after-scroll'), `copy mode ${pasteMode} -> ${inMode()}, line ${JSON.stringify(pastedLine.trimEnd())}`);
  await key('Enter');
  await waitFor(`/^pasted-after-scroll$/m.test(__h.t.shell.getText())`, 4000);
  await pasteShell('echo pasted-plain');
  await sleep(400);
  const plainLine = (await text('shell')).split('\n').find((l) => l.includes('echo pasted-plain')) || '';
  ok('a paste with no scrollback open arrives exactly (tmux consumes the leave-scrollback key)', plainLine.trimEnd().endsWith(' echo pasted-plain'), JSON.stringify(plainLine.trimEnd()));
  await key(letter('u'), CTRL);

  // item 60: a terminal scrolled back stays there while another window has the keys, and when a click gives them back
  await type('clear; seq 1 300');
  await key('Enter');
  await sleep(600);
  for (let i = 0; i < 6; i++) await mouse('mouseWheel', cx, cy, { deltaY: -120 });
  await sleep(500);
  const where60 = () => tmux('display', '-p', '-t', '=flow_h-shell:', '#{pane_in_mode} #{scroll_position}');
  const back0 = where60();
  const cc60 = await cellAt('claude', 3, 10);
  await mouse('mousePressed', cc60.x, cc60.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', cc60.x, cc60.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
  const back1 = where60();
  const keysAway = await ev(`document.activeElement === document.querySelector('#w-claude .xterm-helper-textarea')`);
  await sleep(400);
  const sc60 = await cellAt('shell', 2, 10);
  await mouse('mousePressed', sc60.x, sc60.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', sc60.x, sc60.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
  const back2 = where60();
  ok('a terminal scrolled back stays there while another terminal has the keys, and when a click gives them back',
    back0.startsWith('1 ') && keysAway && back1 === back0 && back2 === back0, `${back0} -> ${back1} (keys in claude: ${keysAway}) -> ${back2}`);
  cancelMode('flow_h-shell');
  await sleep(300);

  /* A real paste (Chromium's paste command) leaves nothing in xterm's hidden input, so the menu's Select All there has
     no old paste to copy. The terminal's own Select All (the handle's selectAll, and ⌘A) selects what it shows, in a
     split only tmux's active pane, and ⌘C copies that. */
  await ev(`navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['echo menu-pasted'], { type: 'text/plain' }) })])`);
  await focusTerm('shell');
  const vk = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: META };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...vk, commands: ['paste'] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...vk });
  const menuPasted = await waitFor(`/echo menu-pasted/.test(__h.t.shell.getText())`, 4000);
  await sleep(300);
  const hidden = await ev(`(() => { const ta = document.querySelector('#w-shell .xterm-helper-textarea'); const left = ta.value; ta.focus(); document.execCommand('selectAll'); return { left, selected: ta.value.slice(ta.selectionStart, ta.selectionEnd) }; })()`);
  ok('a real paste reaches the shell and leaves nothing in xterm\'s hidden input for the menu\'s Select All to copy',
    !!menuPasted && hidden.left === '' && hidden.selected === '', JSON.stringify(hidden));
  await key(letter('u'), CTRL);
  /* rows that fit: a line the terminal wrapped is copied as one line, as Terminal.app does, so the screen's rows would
     not match it */
  await type("clear; printf 'select one\\nselect two\\n'");
  await key('Enter');
  await waitFor(`/^select two$/m.test(__h.t.shell.getText())`, 4000);
  await sleep(300);
  const trimRows = (t) => String(t || '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '');
  await ev('__h.t.shell.selectAll()');
  await sleep(400);
  await ev('window.__copied = null');
  await key(letter('c'), META);
  await sleep(200);
  const allCopied = await ev('window.__copied');
  await clickAt(await cellAt('shell', 0, 2), 1);
  await sleep(400);
  await focusTerm('shell');
  await key(letter('a'), META);
  await sleep(400);
  await ev('window.__copied = null');
  await key(letter('c'), META);
  await sleep(200);
  const keyCopied = await ev('window.__copied');
  const shownNow = trimRows(await text('shell'));
  ok('Select All (the handle\'s, and ⌘A) selects what the terminal shows, and ⌘C copies it',
    trimRows(allCopied) === shownNow && trimRows(keyCopied) === shownNow && shownNow.length > 0, JSON.stringify({ all: trimRows(allCopied).slice(-80), key: trimRows(keyCopied).slice(-80), shown: shownNow.slice(-80) }));
  await clickAt(await cellAt('shell', 0, 2), 1);
  const right2 = tmux('split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', '=flow_h-shell:');
  tmux('send-keys', '-t', right2, "clear; echo 'right side only'", 'Enter');
  tmux('select-pane', '-t', '=flow_h-shell:.0');
  await waitFor(`/right side only/.test(__h.t.shell.getText())`, 6000);
  await sleep(800);
  await ev('__h.t.shell.selectAll()');
  await sleep(800);
  await ev('window.__copied = null');
  await key(letter('c'), META);
  await sleep(200);
  const paneAll = await ev('window.__copied');
  const leftShown = trimRows(tmux('capture-pane', '-p', '-t', '=flow_h-shell:.0'));
  ok('in a split, Select All takes only tmux\'s active pane, clipped to it, and ⌘C copies only that pane',
    trimRows(paneAll) === leftShown && !String(paneAll).includes('right side only') && /polygon/.test(await ev(`document.querySelector('#w-shell .xterm-selection').style.clipPath`)),
    JSON.stringify({ copied: trimRows(paneAll).slice(-80), left: leftShown.slice(-80) }));
  tmux('kill-pane', '-t', right2);
  await sleep(1000);
  await clickAt(await cellAt('shell', 2, 3), 1);
  await sleep(400);

  /* A right-click on the terminal's screen is its own native menu: Copy (only with a selection), Paste, Select All, no
     Cut. test/term-menu.cjs, in main, stands in for the pick, which CDP cannot reach; the right-click is real input. */
  const udir = process.env.FLOW_USER_DATA || '/tmp/flow-dev-term';
  const hasPopup = await ev('!!(window.flow.menu && window.flow.menu.popup)');
  if (!hasPopup) ok('the terminal menu: preload gives flow.menu.popup', false, 'missing (main.js and preload.js older than batch 9)');
  else if (process.env.FLOW_TEST_MENU !== '1') ok('the terminal menu: run with test/term-menu.cjs in main and FLOW_TEST_MENU=1', false, 'a native menu nobody picks from would stay open');
  else {
    const rightClick = async (c, choice) => {
      rmSync(join(udir, 'menu-shown.json'), { force: true });
      if (choice) writeFileSync(join(udir, 'menu-choice'), choice);
      await mouse('mousePressed', c.x, c.y, { button: 'right', buttons: 2, clickCount: 1 });
      await mouse('mouseReleased', c.x, c.y, { button: 'right', buttons: 0, clickCount: 1 });
      for (let i = 0; i < 30 && !existsSync(join(udir, 'menu-shown.json')); i++) await sleep(100);
      await sleep(400);
      return existsSync(join(udir, 'menu-shown.json')) ? JSON.parse(readFileSync(join(udir, 'menu-shown.json'), 'utf8')) : null;
    };
    await focusTerm('shell');
    await type("clear; printf 'menu one\\nmenu two\\n'");
    await key('Enter');
    await waitFor(`/^menu two$/m.test(__h.t.shell.getText())`, 4000);
    const mrow = (await text('shell')).split('\n').indexOf('menu one');
    const bare = await rightClick(await cellAt('shell', mrow + 3, 30), null);
    const labels = (m) => (m || []).map((i) => (i.type === 'separator' ? '|' : `${i.label}${i.enabled ? '' : '(off)'}`)).join(' ');
    await localDrag('shell', mrow, 0, 3);
    await ev('window.__copied = null');
    const withSel = await rightClick(await cellAt('shell', mrow, 2), 'Copy');
    const menuCopied = await waitFor('window.__copied', 3000);
    ok('a right-click on a terminal shows Copy (off with no selection), Paste and Select All, no Cut; Copy copies the selection',
      labels(bare) === 'Copy(off) Paste | Select All' && labels(withSel) === 'Copy Paste | Select All' && menuCopied === 'menu', JSON.stringify({ bare: labels(bare), withSel: labels(withSel), menuCopied }));
    await rightClick(await cellAt('shell', mrow + 3, 30), 'Select All');
    await sleep(400);
    await ev('window.__copied = null');
    await key(letter('c'), META);
    await sleep(200);
    const allMenu = await ev('window.__copied');
    await clickAt(await cellAt('shell', 0, 2), 1);
    await sleep(400);
    await ev(`navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['echo menu-pasted-ok'], { type: 'text/plain' }) })])`);
    await rightClick(await cellAt('shell', mrow + 3, 30), 'Paste');
    const menuPasted = await waitFor(`/echo menu-pasted-ok/.test(__h.t.shell.getText())`, 4000);
    ok('the menu\'s Select All selects what the terminal shows, and its Paste types the clipboard into the shell as ⌘V does',
      String(allMenu || '').includes('menu one') && String(allMenu || '').includes('menu two') && !!menuPasted, JSON.stringify({ allMenu: String(allMenu || '').slice(0, 80), menuPasted: !!menuPasted }));
    await key(letter('u'), CTRL);
  }

  // set-titles-string: a pane still titled with the host name (tmux's own default) sends an empty title, a set one as set
  await type(`printf '\\033]2;flow title check\\007'`);
  await key('Enter');
  await waitFor(`(__h.titles.shell || []).includes('flow title check')`, 8000);
  const shellTitles = await ev('__h.titles.shell || []');
  ok('a shell\'s first title is empty, not the host name, and a title the program sets arrives as set',
    shellTitles[0] === '' && !shellTitles.includes(hostname()) && shellTitles.includes('flow title check'), JSON.stringify(shellTitles));
  /* A title that names no conversation (the CLI's own name, a prompt line) reaches the app as no title (owner, Nov 2
     14:54: agents all named "Free Code", one "❯"); a real one arrives as set. */
  const firstNew = (await ev('(__h.titles.shell || []).length'));
  for (const t of ['Free Code', '✳ Claude Code', '❯', '❯ x']) {
    await type(`printf '\\033]2;${t}\\007'`);
    await key('Enter');
    await sleep(500);
  }
  await type(`printf '\\033]2;✳ fix the login page\\007'`);
  await key('Enter');
  await waitFor(`(__h.titles.shell || []).includes('✳ fix the login page')`, 8000);
  const standIn = (await ev('__h.titles.shell || []')).slice(firstNew);
  ok('the CLI\'s own name ("Free Code", "Claude Code") and a prompt line ("❯", "❯ x") reach the app as no title; a real title as set',
    standIn.includes('✳ fix the login page') && standIn.every((t) => t === '' || t === '✳ fix the login page'), JSON.stringify(standIn));

  /* After a terminal narrows, xterm keeps the cells past its right edge in the alternate buffer, which tmux uses (it
     trims lines only when it reflows, and it never reflows that buffer). getText, which the sidebar's agent search
     reads, gives only what is on screen. */
  const wide = await ev('__h.t.shell.cols');
  await type(`clear; printf '%0${wide - 4}d\\n' 0`);
  await key('Enter');
  await waitFor(`__h.t.shell.getText().includes('0'.repeat(${wide - 4}))`, 8000);
  await ev(`document.getElementById('w-shell').style.width = '420px'`);
  await waitFor(`__h.t.shell.cols < ${wide}`, 3000, 50);
  await sleep(600);
  const narrow = await ev(`({ cols: __h.t.shell.cols, lines: __h.t.shell.getText().split('\\n') })`);
  await ev(`document.getElementById('w-shell').style.width = ''`);
  await waitFor(`__h.t.shell.cols === ${wide}`, 3000, 50);
  const zeros = narrow.lines.find((l) => l.startsWith('0'.repeat(20))) || '';
  ok('after the terminal narrows, getText gives only what is on screen (no line longer than the terminal is wide)',
    zeros !== '' && narrow.lines.every((l) => l.length <= narrow.cols),
    `${wide} to ${narrow.cols} cols, longest line ${Math.max(...narrow.lines.map((l) => l.length))}, zeros line ${zeros.length}`);

  // files dropped on the terminal type their paths escaped the way macOS terminals do, and the shell parses them
  execFileSync('/bin/sh', ['-c', "mkdir -p '/tmp/flow term drop' && : > '/tmp/flow term drop/it'\"'\"'s here.txt' && : > /tmp/flow-plain-drop.txt"]);
  await focusTerm('shell');
  await type('clear; ls -1 ');
  await dropFiles('shell', ["/tmp/flow term drop/it's here.txt", '/tmp/flow-plain-drop.txt']);
  const dropped = await waitFor(`__h.t.shell.getText().includes("/tmp/flow-plain-drop.txt")`, 4000);
  const dropLine = (await text('shell')).split('\n').find((l) => l.includes('flow-plain-drop')) || '';
  ok('dropped files type backslash-escaped paths', dropped && dropLine.includes(`ls -1 /tmp/flow\\ term\\ drop/it\\'s\\ here.txt /tmp/flow-plain-drop.txt`), dropLine.trim());
  await key('Enter');
  const listed = await waitFor(`(() => { const t = __h.t.shell.getText(); return t.includes("/tmp/flow term drop/it's here.txt") && /^\\/tmp\\/flow-plain-drop\\.txt$/m.test(t); })()`, 4000);
  ok('the shell parses the dropped paths (ls lists both files)', listed, (await text('shell')).split('\n').filter((l) => /flow-plain-drop|term drop/.test(l) && !l.includes('ls -1')).join(' | '));
  // the same two files copied in Finder and pasted with ⌘V: typed exactly as the drop typed them
  await shellPrompt();
  await type('clear; ls -1 ');
  await pasteCopied(["/tmp/flow term drop/it's here.txt", '/tmp/flow-plain-drop.txt']);
  const copiedTyped = await waitFor(`__h.t.shell.getText().includes("ls -1 /tmp/flow\\\\ term\\\\ drop/it\\\\'s\\\\ here.txt /tmp/flow-plain-drop.txt")`, 4000);
  const copiedLine = (await text('shell')).split('\n').find((l) => l.includes('ls -1')) || '';
  await key('Enter');
  const copiedListed = await waitFor(`(() => { const t = __h.t.shell.getText(); return t.includes("/tmp/flow term drop/it's here.txt") && /^\\/tmp\\/flow-plain-drop\\.txt$/m.test(t); })()`, 4000);
  ok('files copied in Finder and pasted with ⌘V type the same escaped paths as a drop, and the shell reads them', copiedTyped && copiedListed, copiedLine.trim());

  // a row dragged from Flow's files group (files' shape: application/x-flow-files = [{ host, path }], host null here)
  const dropRows = async (name, rows) => {
    const r = await rectOf(`#w-${name} .fterm`);
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    const data = { items: [{ mimeType: 'application/x-flow-files', data: JSON.stringify(rows) }, { mimeType: 'text/plain', data: rows[0].path }], dragOperationsMask: 1 };
    for (const t of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type: t, x, y, data });
  };
  await focusTerm('shell');
  await type('clear; echo row: ');
  await dropRows('shell', [{ host: null, path: "/tmp/flow term drop/it's here.txt" }]);
  const rowTyped = await waitFor(`__h.t.shell.getText().includes("echo row: /tmp/flow\\\\ term\\\\ drop/it\\\\'s\\\\ here.txt")`, 4000);
  await key('Enter');
  const rowListed = await waitFor(`/^row: \\/tmp\\/flow term drop\\/it's here\\.txt$/m.test(__h.t.shell.getText())`, 4000);
  ok('a Flow file row from this Mac dropped on a local terminal types its escaped path, and the shell reads it', rowTyped && rowListed,
    `typed ${rowTyped}; ${(await text('shell')).split('\n').filter((l) => l.includes('term drop')).join(' | ')}`);
  await shellPrompt();
  const cannot0 = await ev('__h.cannot.length');
  await dropRows('shell', [{ host: 'flow-test.local', path: '/flow-test/missing/notes.txt' }]);
  await waitFor(`__h.cannot.length > ${cannot0}`, 15000);
  const crossLine = (await text('shell')).split('\n').filter((l) => l.includes('notes.txt'));
  const said = await ev('__h.cannot.slice(-1)[0] || null');
  ok('a VM row whose file is not there types nothing and says why (vmfiles\' words)', crossLine.length === 0 && (await ev('__h.cannot.length')) === cannot0 + 1 && /^notes\.txt: not there$/.test(said && said.text),
    JSON.stringify(said));

  // a right-click is Flow's (the terminal's own menu): tmux must not open its own pane menu (Kill, Respawn, splits)
  const menuRows = `__h.t.shell.getText().split('\\n').filter((l) => /Respawn|Horizontal Split|Kill +\\(X\\)/.test(l)).length`;
  const rc = await cellAt('shell', 2, 20);
  const rightClicks = [];
  for (const mods of [0, ALT]) {
    await ev(`window.__ctx = 0; document.addEventListener('contextmenu', () => { window.__ctx += 1; }, { once: true, capture: true })`);
    await mouse('mousePressed', rc.x, rc.y, { button: 'right', buttons: 2, clickCount: 1, modifiers: mods });
    await mouse('mouseReleased', rc.x, rc.y, { button: 'right', buttons: 0, clickCount: 1, modifiers: mods });
    await sleep(500);
    rightClicks.push({ mods, menuRows: await ev(menuRows), contextmenu: await ev('window.__ctx') });
  }
  ok('right-click and Option-right-click on a shell open no tmux menu, and the page still gets contextmenu',
    rightClicks.every((c) => c.menuRows === 0 && c.contextmenu === 1), JSON.stringify(rightClicks));

  // ---------- team: pane handles ----------
  const p1id = tmux('split-window', '-h', '-t', '=flow_h-team:', '-P', '-F', '#{pane_id}');
  const p2id = tmux('split-window', '-v', '-t', p1id, '-P', '-F', '#{pane_id}');
  const p0id = tmux('display', '-p', '-t', '=flow_h-team:.0', '#{pane_id}');
  tmux('select-pane', '-t', p0id, '-T', 'lead');
  tmux('select-pane', '-t', p1id, '-T', 'researcher');
  tmux('select-pane', '-t', p2id, '-T', 'builder');
  const handles = await waitFor(`document.querySelectorAll('#w-team .fterm-mate').length === 3`, 5000);
  ok('team: a grab handle appears on each of the 3 panes', handles, `${await ev(`document.querySelectorAll('#w-team .fterm-mate').length`)} handles`);
  const geo = await ev(`(async () => {
    const ps = await flow.term.panes('h-team');
    const box = document.querySelector('#w-team .fterm-box'), screen = document.querySelector('#w-team .xterm-screen');
    const cw = screen.getBoundingClientRect().width / __h.t.team.cols, ch = screen.getBoundingClientRect().height / __h.t.team.rows;
    const hs = [...document.querySelectorAll('#w-team .fterm-mate')].map((h) => ({ left: h.offsetLeft, top: h.offsetTop, w: h.offsetWidth, h: h.offsetHeight }));
    return { ps, hs, x0: box.offsetLeft, y0: box.offsetTop, cw, ch };
  })()`);
  const placed = geo.ps.every((p, i) => {
    const h = geo.hs[i];
    return h && Math.abs(h.left - (geo.x0 + p.left * geo.cw)) < 1.5 && Math.abs(h.top - (geo.y0 + (p.top - 1) * geo.ch)) < 1.5 && Math.abs(h.h - geo.ch) < 1.5;
  });
  ok('team: each handle sits on its pane\'s title row', placed, geo.ps.map((p, i) => `${p.title}@${p.left},${p.top - 1} -> ${geo.hs[i] ? `${geo.hs[i].left},${geo.hs[i].top}` : 'none'}`).join(' '));
  tmux('send-keys', '-t', p0id, "clear; echo 'team lead text'", 'Enter');
  tmux('send-keys', '-t', p1id, "clear; echo 'team right text'", 'Enter');
  await waitFor(`/team lead text/.test(__h.t.team.getText()) && /team right text/.test(__h.t.team.getText())`, 6000);
  await sleep(400);
  const tl = (await text('team')).split('\n');
  const trow = tl.findIndex((l) => l.startsWith('team lead text'));
  const g0 = geo.ps.find((p) => p.paneId === p0id);
  const td = await localDrag('team', trow, 0, g0.left + g0.width + 6, async () => ({ boxes: await selBoxes('team'), clip: await ev(`document.querySelector('#w-team .xterm-selection').style.clipPath`) }));
  ok('team: a drag that runs into the next pane is xterm\'s selection, clipped to the pane it started in, and copies only its text',
    trow >= 0 && td.mid.boxes > 0 && /polygon/.test(td.mid.clip) && td.copied === 'team lead text', JSON.stringify({ trow, ...td }));
  await sleep(500);
  await shot('07-team-handles');
  const h1 = await ev(`(() => { const r = document.querySelectorAll('#w-team .fterm-mate')[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await mouse('mouseMoved', h1.x, h1.y);
  await mouse('mousePressed', h1.x, h1.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', h1.x, h1.y, { button: 'left', buttons: 0, clickCount: 1 });
  const drag = await waitFor(`__h.drags.length > 0 && __h.drags[0]`, 2000);
  ok('team: pointerdown on a handle calls onMateDragStart(pane, pointerEvent)', drag && drag.type === 'pointerdown' && drag.pane && drag.pane.paneId === p1id, drag ? `${drag.pane.paneId} ${drag.pane.title} ${drag.type}` : 'none');
  tmux('kill-pane', '-t', p2id);
  tmux('kill-pane', '-t', p1id);
  const gone = await waitFor(`document.querySelectorAll('#w-team .fterm-mate').length === 0`, 5000);
  ok('team: handles go away when only one pane is left', gone);
  let border = '';
  for (let i = 0; i < 20 && border !== '1 off'; i++) { await sleep(100); border = tmux('display', '-p', '-t', '=flow_h-team:', '#{window_panes} #{pane-border-status}'); }
  ok('team: tmux turns the pane-title border off when one pane is left', border === '1 off', `panes and pane-border-status: ${border}`);

  // with panesFrom: 'app' the app's single poller hands the panes over and the terminal never polls them itself
  await ev(`(() => {
    const d = document.createElement('div');
    d.id = 'appteam';
    d.style.cssText = 'position:absolute;left:820px;top:60px;width:560px;height:300px;display:flex;flex-direction:column';
    document.getElementById('desk').appendChild(d);
    window.__appTeam = FlowTerm.mount(d, { id: 'h-appteam', cmd: 'shell', cwd: flow.homeDir, team: true, panesFrom: 'app' });
    window.__appTeam.setVisible(true);
  })()`);
  await waitFor(`__appTeam.state === 'open'`, 10000);
  tmux('split-window', '-h', '-t', '=flow_h-appteam:');
  await sleep(3500);
  const appHandles = `document.querySelectorAll('#appteam .fterm-mate').length`;
  const unpolled = await ev(appHandles);
  await ev(`(async () => __appTeam.setPanes(await flow.term.panes('h-appteam')))()`);
  await sleep(200);
  const given = await ev(appHandles);
  tmux('kill-pane', '-t', '=flow_h-appteam:.1');
  await ev(`(async () => __appTeam.setPanes(await flow.term.panes('h-appteam')))()`);
  await sleep(200);
  const taken = await ev(appHandles);
  ok("panesFrom 'app': no handles from polling of its own in 3.5 s, setPanes draws them and takes them away",
    unpolled === 0 && given === 2 && taken === 0, `before setPanes ${unpolled}, after ${given}, one pane left ${taken}`);
  await ev(`(async () => { await __appTeam.kill(); document.getElementById('appteam').remove(); })()`);

  // ---------- a hidden terminal parks: no tmux client while hidden, the screen catches up when shown ----------
  const clientsOf = (s) => tmux('list-clients', '-t', `=${s}`, '-F', '#{client_pid}').split('\n').filter(Boolean);
  const pidsBefore = clientsOf('flow_h-shell');
  /* hidden and shown inside the page, so the 300 ms between them is the page's own timer, which always runs before the
     1 s park timer set when it was hidden, however slow the CDP round trips are */
  const hiddenFor = await ev(`(async () => {
    const t0 = performance.now();
    __h.t.shell.setVisible(false);
    await new Promise((r) => setTimeout(r, 300));
    __h.t.shell.setVisible(true);
    return Math.round(performance.now() - t0);
  })()`);
  await sleep(1200);
  const pidsAfter = clientsOf('flow_h-shell');
  ok('hidden and shown again within a second, a terminal keeps its tmux client', pidsBefore.length === 1 && pidsAfter.join() === pidsBefore.join() && (await ev('__h.t.shell.state')) === 'open',
    `hidden for ${hiddenFor} ms; clients ${pidsBefore.join() || 'none'} -> ${pidsAfter.join() || 'none'}`);
  await ev(`__h.t.shell.setVisible(false)`);
  const parked = await waitFor(`__h.t.shell.state === 'parked'`, 4000);
  await sleep(300);
  ok('hidden for a second, a terminal parks: its session has no tmux client', parked && clientsOf('flow_h-shell').length === 0,
    `state ${await ev('__h.t.shell.state')}, clients ${clientsOf('flow_h-shell').join() || 'none'}`);
  tmux('send-keys', '-t', '=flow_h-shell:', 'clear; echo parked-output-ok', 'Enter');
  await sleep(800);
  ok('nothing streams to a parked terminal', !/^parked-output-ok/m.test(await text('shell')));
  await ev(`__h.t.shell.setVisible(true)`);
  const unparked = await waitFor(`__h.t.shell.state === 'open' && /^parked-output-ok/m.test(__h.t.shell.getText())`, 6000);
  ok('shown again, it reattaches and shows what happened while it was parked', unparked && clientsOf('flow_h-shell').length === 1,
    `state ${await ev('__h.t.shell.state')}, clients ${clientsOf('flow_h-shell').length}`);
  const parkedEnd = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = document.createElement('div');
    d.id = 'parkhost';
    d.style.cssText = 'position:absolute;left:820px;top:60px;width:420px;height:220px;display:flex;flex-direction:column';
    document.getElementById('desk').appendChild(d);
    const exits = window.__parkExits = [];
    const t = window.__park = FlowTerm.mount(d, { id: 'h-park', cmd: 'shell', cwd: flow.homeDir, onExit: (c) => exits.push(c) });
    t.setVisible(true);
    let end = Date.now() + 8000;
    while (Date.now() < end && t.state !== 'open') await sleep(50);
    t.setVisible(false);
    end = Date.now() + 4000;
    while (Date.now() < end && t.state !== 'parked') await sleep(50);
    return t.state;
  })()`);
  tmux('kill-session', '-t', '=flow_h-park');
  await ev(`__park.setVisible(true)`);
  const endedShown = await waitFor(`__park.state === 'ended' && __park.getText().includes('[session ended, press return to start again]')`, 6000);
  await sleep(500);
  ok('a session that ends while parked shows the ended line when shown, and nothing starts again unasked',
    parkedEnd === 'parked' && endedShown && !tmuxOk('has-session', '-t', '=flow_h-park') && (await ev('__parkExits.length')) === 1,
    `parked: ${parkedEnd}, then ${await ev('__park.state')}, session ${tmuxOk('has-session', '-t', '=flow_h-park') ? 'started again' : 'gone'}, onExit ${await ev('JSON.stringify(__parkExits)')}`);
  await ev(`(() => { __park.dispose(); document.getElementById('parkhost').remove(); })()`);

  // ---------- exit and start again ----------
  await focusTerm('shell');
  await type('exit');
  /* tmux shows an error from a hook in whichever client is current, for about a second: watch the other terminals */
  const errorWatch = ev(`(async () => {
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      for (const n of ['claude', 'team']) { const m = /No such window[^\\n]*|unknown command[^\\n]*|invalid option[^\\n]*/i.exec(__h.t[n].getText()); if (m) seen.add(n + ': ' + m[0]); }
      await new Promise((r) => setTimeout(r, 60));
    }
    return [...seen];
  })()`);
  await key('Enter');
  const ended = await waitFor(`__h.t.shell.state === 'ended' && __h.t.shell.getText().includes('[session ended, press return to start again]')`, 8000);
  ok('session end shows the dim "[session ended, press return to start again]" line', ended, JSON.stringify(await ev('__h.exits.shell || []')));
  ok('onExit fired with the exit code', (await ev('(__h.exits.shell || []).length')) === 1);
  const tmuxErrors = await errorWatch;
  ok('a session ending shows no tmux error in the other terminals', tmuxErrors.length === 0, tmuxErrors.join(' | ') || 'none');
  await shot('08-shell-ended');
  await focusTerm('shell');
  await key('Enter');
  const back = await waitFor(`__h.t.shell.state === 'open' && !__h.t.shell.getText().includes('session ended')`, 10000);
  await shellPrompt();
  ok('Enter starts the session again', back && tmuxOk('has-session', '-t', '=flow_h-shell'), await ev('__h.t.shell.state'));
  await sleep(400);
  await shot('09-shell-restarted');

  // ---------- detach + remount reattaches with content ----------
  await ev(`__h.remount('claude')`);
  const re = await waitFor(`__h.t.claude.state === 'open' && /${BANNER}/.test(__h.t.claude.getText())`, 10000);
  ok('detach + remount reattaches to the same running Claude Code with its screen', re && tmuxOk('has-session', '-t', '=flow_h-claude'));
  ok('the remount reattached, it did not create a new session', (await ev(`__h.opened.claude[__h.opened.claude.length - 1].created`)) === false);
  await sleep(500);
  await shot('10-claude-remounted');

  // ---------- reparenting the window frame keeps the same live terminal ----------
  await ev(`document.getElementById('parking').appendChild(document.getElementById('w-claude'))`);
  await sleep(300);
  await focusTerm('claude');
  await type('moved');
  const moved = await waitFor(`__h.t.claude.getText().includes('moved')`, 5000);
  ok('moving the window frame to another parent keeps the terminal live', moved);
  await key(letter('c'), CTRL);
  await ev(`document.getElementById('desk').appendChild(document.getElementById('w-claude'))`);
  await sleep(300);

  /* item 60 in Claude Code: it draws full screen (alternate screen, mouse on) and scrolls its own view with the wheel,
     so tmux's copy mode is not involved; tmux's focus-events decides only whether Claude hears focus out and in. The
     window is made short so that Claude's banner alone overflows and can be scrolled, with nothing typed into Claude (no
     request to the API). Its view stays put while another window has the keys and when they come back; what Claude
     draws while away (its cursor, any row that changes) is in the details. After every check that reads the banner. */
  const claudeHeight = await ev(`(() => { const w = document.getElementById('w-claude'); const h = w.style.height; w.style.height = '200px'; return h; })()`);
  await waitFor(`__h.t.claude.rows <= 10`, 5000, 50);
  await sleep(1500);
  const claudeTop = async () => (await text('claude')).split('\n')[0] || '';
  const claudeLook = () => ({ cursor: tmux('display', '-p', '-t', '=flow_h-claude:', '#{cursor_flag} #{cursor_x},#{cursor_y}'), screen: tmux('capture-pane', '-e', '-p', '-t', '=flow_h-claude:') });
  await focusTerm('claude');
  await sleep(500);
  const topBottom = await claudeTop();
  const cr60 = await rectOf('#w-claude .xterm-screen');
  for (let i = 0; i < 6; i++) await mouse('mouseWheel', cr60.x + cr60.w / 2, cr60.y + cr60.h / 2, { deltaY: -120 });
  let top0 = await claudeTop();
  for (let i = 0, same = 0; i < 30 && same < 5; i++) {
    await sleep(200);
    const t = await claudeTop();
    same = t === top0 ? same + 1 : 0;
    top0 = t;
  }
  const lookKeys = claudeLook();
  const sc61 = await cellAt('shell', 2, 10);
  await mouse('mousePressed', sc61.x, sc61.y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', sc61.x, sc61.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(1500);
  const top1 = await claudeTop(), lookAway = claudeLook(), keysInShell = await ev(`document.activeElement === document.querySelector('#w-shell .xterm-helper-textarea')`);
  await focusTerm('claude');
  await sleep(1500);
  const top2 = await claudeTop(), lookBack = claudeLook();
  const rowChanged = (a, b) => { const x = a.split('\n'), y = b.split('\n'); const i = x.findIndex((l, k) => l !== y[k]); return i < 0 ? null : { row: i, with: x[i], without: y[i] }; };
  ok('Claude Code\'s own scrolled-back view stays where it was while another window has the keys, and when they come back',
    top0 !== topBottom && keysInShell && top1 === top0 && top2 === top0,
    JSON.stringify({ bottom: topBottom, scrolled: top0, away: top1, back: top2, keysInShell, cursor: { keys: lookKeys.cursor, away: lookAway.cursor, back: lookBack.cursor }, awayRowChanged: rowChanged(lookKeys.screen, lookAway.screen) }));
  for (let i = 0; i < 6; i++) await mouse('mouseWheel', cr60.x + cr60.w / 2, cr60.y + cr60.h / 2, { deltaY: 120 });
  await ev(`document.getElementById('w-claude').style.height = ${JSON.stringify(claudeHeight)}`);
  await sleep(800);

  // ---------- fork: forkFrom reaches pty.js, which starts claude --resume <parent> --fork-session --session-id <new> ----------
  let parent = null;
  try {
    parent = ownSession('fork');
  } catch (e) {
    console.error(`could not make a session to fork from: ${e.message}`);
  }
  ok('fork: made a session of its own to fork from (claude -p /cost, no API call)', !!parent, parent ? `${parent.id} in ${parent.cwd}` : 'see the error above');
  if (parent) {
    const forkId = await ev(`(() => {
      const d = document.createElement('div');
      d.id = 'forkhost';
      d.style.cssText = 'position:absolute;left:820px;top:60px;width:640px;height:300px;display:flex;flex-direction:column';
      document.getElementById('desk').appendChild(d);
      const sessionId = crypto.randomUUID();
      window.__fork = FlowTerm.mount(d, { id: 'h-fork', cmd: 'claude', cwd: ${JSON.stringify(parent.cwd)}, sessionId, resume: true, forkFrom: ${JSON.stringify(parent.id)} });
      window.__fork.setVisible(true);
      return sessionId;
    })()`);
    await waitFor(`__fork.state === 'open'`, 15000);
    let claudeArgs = '';
    for (let i = 0; i < 50 && !claudeArgs; i++) {
      await sleep(200);
      const pane = tmux('display', '-p', '-t', '=flow_h-fork:', '#{pane_pid}');
      const c = descendants(pane).find((p) => /claude/.test(p.args) && /--session-id/.test(p.args));
      claudeArgs = c ? c.args : '';
    }
    ok('fork: claude runs as --resume <parent> --fork-session --session-id <new>', claudeArgs.includes(`--resume ${parent.id} --fork-session --session-id ${forkId}`), claudeArgs || 'no claude process found');
    const shows = await waitFor(`/❯ \\/usage/.test(__fork.getText()) && /Total cost: +\\$0\\.0000/.test(__fork.getText())`, 60000);
    ok('fork: the new window shows the parent conversation (its /cost exchange)', shows, (await ev('__fork.getText()')).replace(/\s+/g, ' ').trim().slice(0, 160));
    await shot('10b-fork');
    await ev(`__fork.kill()`);
    await sleep(500);
    ok('fork: kill() ends the fork session', !tmuxOk('has-session', '-t', '=flow_h-fork'));
    await ev(`document.getElementById('forkhost').remove()`);
  }

  // ---------- a conversation open in another Claude: the window says where, waits, and starts once it is free ----------
  const host = (hostId, name, opts) => ev(`(() => {
    const d = document.createElement('div');
    d.id = ${JSON.stringify(hostId)};
    d.style.cssText = 'position:absolute;left:820px;top:60px;width:640px;height:300px;display:flex;flex-direction:column';
    document.getElementById('desk').appendChild(d);
    window[${JSON.stringify(name + 'Opened')}] = [];
    window[${JSON.stringify(name)}] = FlowTerm.mount(d, { ...${JSON.stringify(opts)}, onOpened: (r) => window[${JSON.stringify(name + 'Opened')}].push(r) });
    window[${JSON.stringify(name)}].setVisible(true);
  })()`);
  const claudePid = () => {
    const c = descendants(tmux('display', '-p', '-t', '=flow_h-claude:', '#{pane_pid}')).find((p) => /claude/.test(p.args) && /--session-id/.test(p.args));
    return c ? c.pid : '';
  };
  const firstClaude = claudePid();
  await host('twinhost', '__twin', { id: 'h-twin', cmd: 'claude', cwd: homedir(), sessionId: await ev('__h.specs.claude.sessionId'), resume: true });
  const twin = await waitFor(`__twin.state === 'waiting' && __twin.getText().trim()`, 15000);
  await sleep(3500);
  /* between its tries it is 'waiting', during one 'opening' (a try can take seconds under load); neither has a session */
  ok('a second window on the conversation of a running Flow window says so, starts nothing, and the first keeps running',
    twin === '[this conversation is open in another Flow window]' && (await ev(`['waiting', 'opening'].includes(__twin.state) && __twinOpened.length === 0`)) && !tmuxOk('has-session', '-t', '=flow_h-twin') &&
    !!firstClaude && claudePid() === firstClaude && (await ev(`__h.t.claude.state`)) === 'open', `${JSON.stringify(twin)}, first window's claude ${firstClaude} then ${claudePid()}`);
  await ev(`__twin.dispose(); document.getElementById('twinhost').remove()`);

  /* The Claude outside Flow is a stand-in whose command line names its conversation the way claude --resume does,
     started without TMUX as from another terminal app; it writes down any signal it gets. */
  let held = null;
  try {
    held = ownSession('held');
  } catch (e) {
    console.error(`could not make a session for the outside claude to hold: ${e.message}`);
  }
  ok('outside: made a session of its own (claude -p /cost, no API call)', !!held, held ? `${held.id} in ${held.cwd}` : 'see the error above');
  if (held) {
    const dir = join(SHOTS, 'outside-claude');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'claude-standin.cjs');
    const sigs = join(dir, 'signals');
    writeFileSync(script, `const fs = require('fs');\nfor (const s of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(s, () => fs.appendFileSync(${JSON.stringify(sigs)}, s + '\\n'));\nsetInterval(() => {}, 1000);\n`);
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const outside = spawn('node', [script, '--resume', held.id], { env, stdio: 'ignore', detached: true });
    outside.unref();
    const running = () => {
      try {
        process.kill(outside.pid, 0);
        return true;
      } catch (e) {
        if (e.code === 'ESRCH') return false;
        throw e;
      }
    };
    await sleep(500);
    const NOTE = '[this conversation is open in a Claude outside Flow]';
    await host('heldhost', '__held', { id: 'h-held', cmd: 'claude', cwd: held.cwd, sessionId: held.id, resume: true });
    const says = await waitFor(`__held.state === 'waiting' && __held.getText().trim()`, 15000);
    ok('outside: the window says only that the conversation is open in a Claude outside Flow, and starts nothing', says === NOTE && !tmuxOk('has-session', '-t', '=flow_h-held'), JSON.stringify(says));
    await sleep(7000);
    const still = await ev(`({ state: __held.state, text: __held.getText().trim(), opened: __heldOpened.length })`);
    ok('outside: it keeps waiting while that claude runs: the same one line, no session, no onOpened, and that claude got no signal',
      ['waiting', 'opening'].includes(still.state) && still.text === NOTE && still.opened === 0 && !tmuxOk('has-session', '-t', '=flow_h-held') && running() && !existsSync(sigs),
      `${JSON.stringify(still)}, outside claude ${running() ? 'running' : 'gone'}, signals ${existsSync(sigs) ? readFileSync(sigs, 'utf8').trim() : 'none'}`);
    await shot('10c-held-outside');
    process.kill(outside.pid, 'SIGKILL');
    const exited = Date.now();
    const started = await waitFor(`__held.state === 'open'`, 10000, 100);
    const ms = Date.now() - exited;
    let args = '';
    for (let i = 0; i < 50 && !args; i++) {
      if (tmuxOk('has-session', '-t', '=flow_h-held')) {
        const c = descendants(tmux('display', '-p', '-t', '=flow_h-held:', '#{pane_pid}')).find((p) => /claude/.test(p.args) && p.args.includes(held.id));
        args = c ? c.args : '';
      }
      if (!args) await sleep(200);
    }
    ok('outside: once that claude exits, the window starts its own within a few seconds, no key pressed',
      started && ms < 6000 && args.includes(`--resume ${held.id}`), `${ms} ms after it exited, ${args || 'no claude found'}`);
    const shows = await waitFor(`/❯ \\/usage/.test(__held.getText()) && !__held.getText().includes('outside Flow')`, 60000);
    ok('outside: it shows that conversation, with nothing of the notice left', shows, (await ev('__held.getText()')).replace(/\s+/g, ' ').trim().slice(0, 160));
    ok('outside: onOpened came once, with the start', (await ev(`JSON.stringify(__heldOpened.map((r) => [r.ok, !!r.retry]))`)) === '[[true,false]]', await ev('JSON.stringify(__heldOpened)'));
    await shot('10d-held-started');
    tmux('kill-session', '-t', '=flow_h-held');
    /* the ended line is written as the state changes and drawn a moment later */
    const endText = await waitFor(`__held.state === 'ended' && __held.getText().includes('[session ended, press return to start again]') && __held.getText()`, 15000);
    ok('outside: when that claude ends, the window shows the ended line and nothing of the old notice',
      !!endText && endText.includes('[session ended, press return to start again]') && !endText.includes('outside Flow'), JSON.stringify(endText));
    await ev(`__held.kill()`);
    await ev(`document.getElementById('heldhost').remove()`);
  }

  /* No process list: the stand-in module (test/term-standin-vm.cjs) makes the app's /bin/ps time out while
     <userData>/ps-fails exists. */
  const psFails = join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'ps-fails');
  let blind = null;
  try {
    blind = ownSession('blind');
  } catch (e) {
    console.error(`could not make a session for the window that cannot check: ${e.message}`);
  }
  ok('cannot check: made a session of its own (claude -p /cost, no API call)', !!blind, blind ? `${blind.id} in ${blind.cwd}` : 'see the error above');
  if (blind) {
    const NO_CHECK = '[could not check whether this conversation is open elsewhere]';
    writeFileSync(psFails, '');
    try {
      const t0 = Date.now();
      await host('blindhost', '__blind', { id: 'h-blind', cmd: 'claude', cwd: blind.cwd, sessionId: blind.id, resume: true });
      const said = await waitFor(`__blind.state === 'waiting' && __blind.getText().trim()`, 45000);
      const saidMs = Date.now() - t0;
      ok('cannot check: after 30 s without a process list the window says only that, and starts nothing',
        said === NO_CHECK && saidMs >= 30000 && !tmuxOk('has-session', '-t', '=flow_h-blind') && (await ev('__blindOpened.length')) === 0, `${saidMs} ms, ${JSON.stringify(said)}`);
      const again = await waitFor(`__blind.state === 'opening'`, 6000, 100);
      ok('cannot check: it checks again by itself, with the same line on screen', again && (await ev('__blind.getText().trim()')) === NO_CHECK, await ev('__blind.state'));
      await shot('10e-cannot-check');
    } finally {
      rmSync(psFails, { force: true });
    }
    const listed = Date.now();
    const started = await waitFor(`__blind.state === 'open'`, 10000, 100);
    const ms = Date.now() - listed;
    let args = '';
    for (let i = 0; i < 50 && !args; i++) {
      if (tmuxOk('has-session', '-t', '=flow_h-blind')) {
        const c = descendants(tmux('display', '-p', '-t', '=flow_h-blind:', '#{pane_pid}')).find((p) => /claude/.test(p.args) && p.args.includes(blind.id));
        args = c ? c.args : '';
      }
      if (!args) await sleep(200);
    }
    ok('cannot check: once a process list works and shows no other claude on it, the window starts its own, no key pressed',
      started && ms < 5000 && args.includes(`--resume ${blind.id}`), `${ms} ms after ps worked again, ${args || 'no claude found'}`);
    const shows = await waitFor(`/❯ \\/usage/.test(__blind.getText()) && !__blind.getText().includes('could not check')`, 60000);
    ok('cannot check: it shows that conversation, with nothing of the notice left', shows, (await ev('__blind.getText()')).replace(/\s+/g, ' ').trim().slice(0, 160));
    ok('cannot check: onOpened came once, with the start', (await ev(`JSON.stringify(__blindOpened.map((r) => [r.ok, !!r.retry]))`)) === '[[true,false]]', await ev('JSON.stringify(__blindOpened)'));
    await ev(`__blind.kill()`);
    await ev(`document.getElementById('blindhost').remove()`);
  }

  // ---------- kill() and an immediate mount of the same id ----------
  /* The killed tmux client's exit can reach the window after the new mount has taken the id; it must not end the new
     terminal. */
  const race = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = document.createElement('div');
    d.id = 'racehost';
    d.style.cssText = 'position:absolute;left:820px;top:60px;width:420px;height:220px;display:flex;flex-direction:column';
    document.getElementById('desk').appendChild(d);
    const exits = window.__raceExits = [];
    const mk = () => { const t = FlowTerm.mount(d, { id: 'h-race', cmd: 'shell', cwd: flow.homeDir, onExit: (c) => exits.push(c) }); t.setVisible(true); return t; };
    const settle = async (t) => { const end = Date.now() + 8000; while (Date.now() < end && t.state === 'opening') await sleep(50); await sleep(400); };
    let t = mk();
    await settle(t);
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      await t.kill();
      t = mk();
      await settle(t);
      rounds.push(t.state);
    }
    window.__race = t;
    return { rounds, exits: exits.length };
  })()`);
  ok('kill() then mounting the same id at once: the new terminal opens and no stale exit ends it (5 rounds)', race.rounds.every((s) => s === 'open') && race.exits === 0, `${race.rounds.join(' ')}, exits ${race.exits}`);
  await waitFor(`/[%$#❯>] *$/m.test(__race.getText())`, 15000);
  await ev('__race.focus()');
  await sleep(80);
  await type('exit');
  await key('Enter');
  const raceEnded = await waitFor(`__race.state === 'ended'`, 8000);
  ok('after that, the new terminal\'s own exit still ends it', raceEnded && (await ev('__raceExits.length')) === 1, `state ${await ev('__race.state')}, exits ${await ev('__raceExits.length')}`);
  await ev(`(() => { __race.dispose(); document.getElementById('racehost').remove(); })()`);

  // ---------- lazy: nothing spawns until visible and sized ----------
  await ev(`(() => {
    const d = document.createElement('div');
    d.id = 'lazy';
    d.style.cssText = 'position:absolute;left:820px;top:60px;width:0;height:0;display:flex;flex-direction:column;overflow:hidden';
    document.getElementById('desk').appendChild(d);
    window.__lazy = FlowTerm.mount(d, { id: 'h-lazy', cmd: 'shell', cwd: flow.homeDir });
    const s = document.createElement('div');
    s.id = 'lazy2';
    s.style.cssText = 'position:absolute;left:820px;top:300px;width:400px;height:200px;display:flex;flex-direction:column';
    document.getElementById('desk').appendChild(s);
    window.__lazy2 = FlowTerm.mount(s, { id: 'h-lazy2', cmd: 'shell', cwd: flow.homeDir });
    window.__lazy.setVisible(true);
  })()`);
  await sleep(1200);
  ok('visible but zero-size: nothing is spawned', (await ev('__lazy.state')) === 'idle' && !tmuxOk('has-session', '-t', '=flow_h-lazy'));
  ok('sized but never made visible: nothing is spawned', (await ev('__lazy2.state')) === 'idle' && !tmuxOk('has-session', '-t', '=flow_h-lazy2'));
  await ev(`(() => { const d = document.getElementById('lazy'); d.style.width = '420px'; d.style.height = '220px'; })()`);
  const lazyOpen = await waitFor(`__lazy.state === 'open'`, 8000);
  await sleep(400);
  const lsz = await ev(`({ cols: __lazy.cols, rows: __lazy.rows })`);
  const ltm = tmuxOk('has-session', '-t', '=flow_h-lazy') ? tmux('display', '-p', '-t', '=flow_h-lazy:', '#{window_width} #{window_height}') : 'none';
  ok('once it gets a real size it spawns, at that exact size', lazyOpen && ltm === `${lsz.cols} ${lsz.rows}`, `xterm ${lsz.cols}x${lsz.rows}, tmux ${ltm}`);
  await ev(`__lazy.kill()`);
  await ev(`__lazy2.dispose()`);
  await sleep(500);
  ok('kill() ends the tmux session', !tmuxOk('has-session', '-t', '=flow_h-lazy'));
  ok('dispose() on a never-opened terminal leaves nothing behind', !tmuxOk('has-session', '-t', '=flow_h-lazy2') && !(await ev(`!!document.querySelector('#lazy2 .fterm')`)));
  await ev(`['lazy', 'lazy2'].forEach((id) => document.getElementById(id).remove())`);

  // ---------- the conf can be sourced into the running server again ----------
  /* Flow sources flow-tmux.conf into a server that may have run for days under an older version: sourcing it again
     must change nothing, and the hooks older versions set must go. */
  const conf = fileURLToPath(new URL('../src/flow-tmux.conf', import.meta.url));
  const serverState = () => [['show', '-s'], ['show', '-g'], ['show', '-gw'], ['show-hooks', '-g'], ['show-hooks', '-gw'], ['list-keys']]
    .map((a) => tmux(...a)).join('\n');
  const stateBefore = serverState();
  tmux('set-hook', '-g', 'after-split-window', 'display-message old');
  tmux('set-hook', '-g', 'after-kill-pane', 'display-message old');
  const sourced = [1, 2].map(() => spawnSync(TMUX, ['-L', SOCKET, 'source-file', conf], { encoding: 'utf8' }));
  const stateAfter = serverState();
  const linesBefore = new Set(stateBefore.split('\n')), linesAfter = new Set(stateAfter.split('\n'));
  const changed = [...[...linesAfter].filter((l) => !linesBefore.has(l)).map((l) => `+ ${l}`), ...[...linesBefore].filter((l) => !linesAfter.has(l)).map((l) => `- ${l}`)];
  ok('sourcing flow-tmux.conf twice into the running server prints nothing, changes nothing and removes the old hooks',
    sourced.every((r) => r.status === 0 && !r.stdout && !r.stderr) && stateAfter === stateBefore,
    sourced.map((r) => `exit ${r.status} ${JSON.stringify((r.stdout + r.stderr).trim())}`).join(', ') + `; changed: ${changed.slice(0, 3).join(' | ') || 'none'}`);

  // ---------- a VM attach window shows the shared window at its own size ----------
  /* VM windows attach with ignore-size, and main starts the client at the window's size plus its status line
     (term.open returns size { cols, rows, status }); term.js keeps that size, follows changes from the panes list and
     shrinks the font so all of the window fits. End to end against a stand-in VM: test/term-standin-vm.cjs, loaded
     into the app (header), sends ssh to flow-test.local to a local tmux server with the VM's settings that matter
     here (status line on, mouse on) and a 150x45 window that Flow is the only client of. */
  const VM = `${SOCKET}-vm`;
  const vmTmux = (...a) => execFileSync(TMUX, ['-L', VM, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try { vmTmux('kill-server'); } catch (e) { if (typeof e.status !== 'number') throw e; }
  execFileSync(TMUX, ['-L', VM, '-f', '/dev/null', 'new-session', '-d', '-s', 'vmteam', '-x', '150', '-y', '45']);
  vmTmux('set', '-g', 'mouse', 'on');
  const vmClient = () => vmTmux('list-clients', '-F', '#{client_width}x#{client_height} #{client_flags}');
  const vmWindow = () => vmTmux('display', '-p', '-t', '=vmteam:', '#{window_width}x#{window_height}');
  await ev(`(() => {
    const d = document.createElement('div');
    d.id = 'vmhost';
    d.style.cssText = 'position:absolute;left:14px;top:620px;width:640px;height:260px;display:flex;flex-direction:column;z-index:5;outline:1px solid #555';
    document.getElementById('desk').appendChild(d);
    window.__vm = FlowTerm.mount(d, { id: 'h-vm', cmd: 'shell', host: 'flow-test.local', attach: 'vmteam', onOpened: (r) => { window.__vmOpened = r; } });
    window.__vm.setVisible(true);
  })()`);
  await waitFor(`__vm.state === 'open'`, 15000);
  await sleep(800);
  const vmGeo = `(() => {
    const b = document.querySelector('#vmhost .fterm-box').getBoundingClientRect(), s = document.querySelector('#vmhost .xterm-screen').getBoundingClientRect();
    return { cols: __vm.cols, rows: __vm.rows, font: parseFloat(getComputedStyle(document.querySelector('#vmhost .xterm-rows')).fontSize),
      fits: s.width <= b.width + 0.5 && s.height <= b.height + 0.5, box: [Math.round(b.width), Math.round(b.height)], screen: [Math.round(s.width), Math.round(s.height)] };
  })()`;
  const vmSize = await ev('JSON.stringify((window.__vmOpened || {}).size || null)');
  const vm1 = await ev(vmGeo), vmCl1 = vmClient(), vmWin1 = vmWindow();
  ok('a VM attach window: term.open gives size 150x46 (status 1), the client attaches there with ignore-size, the 150x45 window stays, the font shrinks to fit',
    vmSize === '{"cols":150,"rows":46,"status":1}' && vm1.cols === 150 && vm1.rows === 46 && vmCl1.startsWith('150x46 ') && vmCl1.includes('ignore-size')
      && vmWin1 === '150x45' && vm1.fits && vm1.font < 11.4,
    vmSize === 'null' ? 'no size from term.open: start the app with the stand-in (file header)' : `size ${vmSize}, ${JSON.stringify(vm1)}, client ${vmCl1}, window ${vmWin1}`);
  vmTmux('send-keys', '-t', '=vmteam:', "clear; printf '\\033[?1000h\\033[?1006h'; cat -v", 'Enter');
  await sleep(800);
  for (const [col, row] of [[20, 10], [149, 44], [0, 0]]) {
    const s = await ev(`(() => { const r = document.querySelector('#vmhost .xterm-screen').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width / __vm.cols, h: r.height / __vm.rows }; })()`);
    const x = s.x + (col + 0.5) * s.w, y = s.y + (row + 0.5) * s.h;
    await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
  }
  const vmClicks = (vmTmux('capture-pane', '-p', '-t', '=vmteam:').match(/\^\[\[<0;\d+;\d+M/g) || []).join(' ');
  ok('at the smaller font a click reaches the VM program on the exact cell (corners included)', vmClicks === '^[[<0;21;11M ^[[<0;150;45M ^[[<0;1;1M', vmClicks || 'no reports');
  // a plain drag there is xterm's selection: the VM program gets no report of it, and release copies the text
  const vmLines = (await ev('__vm.getText()')).split('\n');
  const vr = vmLines.findIndex((l) => l.includes('^[[<0;21;11M'));
  const vc = vr >= 0 ? vmLines[vr].indexOf('^[[<0;21;11M') : 0;
  const vmReports = () => (vmTmux('capture-pane', '-p', '-t', '=vmteam:').match(/\^\[\[</g) || []).length;
  const reportsBefore = vmReports();
  await ev('window.__copied = null');
  await sleep(400);
  const vs = await ev(`(() => { const r = document.querySelector('#vmhost .xterm-screen').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width / __vm.cols, h: r.height / __vm.rows }; })()`);
  const vx = (c) => vs.x + (c + 0.5) * vs.w, vy = vs.y + (vr + 0.5) * vs.h;
  await mouse('mousePressed', vx(vc), vy, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', vx(vc) + ((vx(vc + 11) - vx(vc)) * i) / 6, vy, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', vx(vc + 11), vy, { button: 'left', buttons: 0, clickCount: 1 });
  const vmCopied = await waitFor('window.__copied', 5000);
  await sleep(400);
  const reportsAfter = vmReports();
  ok('a plain drag in a VM window selects in xterm: the VM program gets no report of it, and release copies the text',
    vr >= 0 && vmCopied === '^[[<0;21;11M' && reportsAfter === reportsBefore, JSON.stringify({ vmCopied, reportsBefore, reportsAfter }));
  await shot('12-vm-own-size');
  vmTmux('resize-window', '-t', '=vmteam:', '-x', '100', '-y', '30');
  const followed = await waitFor(`__vm.cols === 100 && __vm.rows === 31`, 6000);
  const vm2 = await ev(vmGeo), vmCl2 = vmClient(), vmWin2 = vmWindow();
  await ev(`(() => { const d = document.getElementById('vmhost'); d.style.width = '900px'; d.style.height = '600px'; })()`);
  await sleep(600);
  const vm3 = await ev(vmGeo);
  ok('it follows a resize of the VM window (from the panes list), and the font grows back up to 11.4px when there is room',
    followed && vmCl2.startsWith('100x31 ') && vmWin2 === '100x30' && vm2.fits && vm2.font > vm1.font && vm3.font === 11.4 && vm3.fits,
    `100x30: ${JSON.stringify(vm2)}, client ${vmCl2}, window ${vmWin2}; bigger box: ${JSON.stringify(vm3)}`);
  /* an attach window's tmux is not Flow's: its find stays xterm's, on the screen, with a count, and leaves that server alone */
  await ev('__vm.focus()');
  await key(letter('f'), META);
  await waitFor(`!document.querySelector('#vmhost .fterm-find').hidden`, 2000);
  await type('21;11m');
  const vmCount = await waitFor(`/^\\d+ of \\d+$/.test(document.querySelector('#vmhost .fterm-n').textContent) && document.querySelector('#vmhost .fterm-n').textContent`, 3000);
  const vmFindMode = vmTmux('display', '-p', '-t', '=vmteam:', '#{pane_in_mode}');
  ok('find in a VM attach window searches its screen with xterm (a count, and no copy mode on the shared server)', !!vmCount && vmFindMode === '0', `${vmCount}, pane_in_mode ${vmFindMode}`);
  await key('Escape');
  await ev(`(async () => { await __vm.kill(); document.getElementById('vmhost').remove(); })()`);
  await sleep(500);
  let vmKept = false;
  try { vmTmux('has-session', '-t', '=vmteam'); vmKept = true; } catch (e) { if (typeof e.status !== 'number') throw e; }
  ok('kill() on an attach window ends only Flow\'s client; the VM session stays', vmKept && vmTmux('list-clients') === '', `session ${vmKept ? 'kept' : 'gone'}`);
  vmTmux('kill-server');

  // ---------- files between this Mac and the VM (vmfiles' put and copy, through the stand-in VM) ----------
  /* The stand-in VM's home is <userData>/vmhome (test/term-standin-vm.cjs), so everything put "on the VM" lands under
     it and never in this machine's home. */
  const vmHome = join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'vmhome');
  const vmWork = join(vmHome, 'work');
  const macDownloads = join(process.env.FLOW_USER_DATA || '/tmp/flow-dev-term', 'Downloads');
  rmSync(vmHome, { recursive: true, force: true });
  for (const f of existsSync(macDownloads) ? readdirSync(macDownloads) : []) if (f.startsWith('down to mac')) rmSync(join(macDownloads, f));
  mkdirSync(vmWork, { recursive: true });
  try { vmTmux('kill-server'); } catch (e) { if (typeof e.status !== 'number') throw e; }
  execFileSync(TMUX, ['-L', VM, '-f', '/dev/null', 'new-session', '-d', '-s', 'vmfiles', '-x', '100', '-y', '20']);
  await ev(`(() => {
    const d = document.createElement('div');
    d.id = 'vmfhost';
    d.style.cssText = 'position:absolute;left:14px;top:620px;width:760px;height:260px;display:flex;flex-direction:column;z-index:5';
    document.getElementById('desk').appendChild(d);
    window.__vmf = FlowTerm.mount(d, { id: 'h-vmf', cmd: 'shell', host: 'flow-test.local', attach: 'vmfiles', vmFolder: ${JSON.stringify(vmWork)},
      onCannot: (text) => __h.cannot.push({ name: 'vmf', text }), onDownload: (file) => __h.downloads.push({ name: 'vmf', file }) });
    window.__vmf.setVisible(true);
  })()`);
  await waitFor(`__vmf.state === 'open'`, 15000);
  /* the VM pane as tmux has it, wrapped lines joined (a long path does not fit one row), not trimmed (typed paths end
     in a space) */
  const vmText = () => execFileSync(TMUX, ['-L', VM, 'capture-pane', '-p', '-J', '-t', '=vmfiles:'], { encoding: 'utf8', stdio: 'pipe' });
  const vmLine = (pat) => vmText().split('\n').filter((l) => l.includes(pat));
  const vmWait = async (test, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = vmText();
      const m = test(t);
      if (m || Date.now() > end) return m;
      await sleep(250);
    }
  };
  const vmType = async (s) => { await ev('__vmf.focus()'); await sleep(80); await type(s); };
  const dropOn = async (sel, data) => {
    const r = await rectOf(sel);
    for (const t of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type: t, x: r.x + r.w / 2, y: r.y + r.h / 2, data });
  };
  await waitFor(`/[%$#] *$/m.test(__vmf.getText())`, 15000);
  // a Finder file dropped on the VM terminal is put into the workspace's VM folder and that path is typed there
  writeFileSync('/tmp/flow term drop/up from mac.txt', 'mac-to-vm\n');
  await vmType('clear; cat ');
  await dropOn('#vmfhost .fterm', { items: [], files: ['/tmp/flow term drop/up from mac.txt'], dragOperationsMask: 1 });
  const upLanded = join(vmWork, 'up from mac.txt');
  const upTyped = await vmWait((t) => t.includes(`cat ${upLanded.replace(/ /g, '\\ ')} `), 20000);
  const upSeen = vmLine('cat ').join(' | ');
  await key('Enter');
  const upRead = await vmWait((t) => /^mac-to-vm$/m.test(t), 8000);
  ok('a Finder file dropped on a VM terminal is put into the VM folder and its VM path is typed there (cat reads it)',
    upTyped && upRead && existsSync(upLanded) && readFileSync(upLanded, 'utf8') === 'mac-to-vm\n',
    `typed ${!!upTyped}, read ${!!upRead}, landed ${existsSync(upLanded)}; line ${JSON.stringify(upSeen)}; onCannot ${JSON.stringify(await ev('__h.cannot.slice(-1)'))}`);
  // the same for a row from the files group on this Mac; a second copy gets " (1)", never overwrites
  await vmType('clear; cat ');
  await dropOn('#vmfhost .fterm', { items: [{ mimeType: 'application/x-flow-files', data: JSON.stringify([{ host: null, path: '/tmp/flow term drop/up from mac.txt' }]) }], dragOperationsMask: 1 });
  const upLanded2 = join(vmWork, 'up from mac (1).txt');
  const rowUp = await vmWait((t) => t.includes(`cat ${upLanded2.replace(/[ ()]/g, '\\$&')} `), 20000);
  const rowSeen = vmLine('cat ').join(' | ');
  await key('Enter');
  const rowUpRead = await vmWait((t) => /^mac-to-vm$/m.test(t), 8000);
  ok('a Mac row from the files group dropped on a VM terminal is put there too, beside the first copy, not over it',
    rowUp && rowUpRead && existsSync(upLanded2), `typed ${!!rowUp}, read ${!!rowUpRead}, landed ${existsSync(upLanded2)}; line ${JSON.stringify(rowSeen)}`);
  // ⌘V of an image on the VM terminal: main saves it on the Mac, it is put into ~/.flow/pasted-images on the VM
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ev(`(async () => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#d77757';
    g.fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  })()`);
  await vmType('clear; file ');
  const vv = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: META };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...vv, commands: ['paste'] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...vv });
  const pastedOnVm = (await vmWait((t) => (t.match(/file (\S*\/\.flow\/pasted-images\/\S+\.png)/) || [])[1], 20000)) || '';
  const pastedFile = pastedOnVm.replace(/\\(.)/g, '$1');
  const isPng = !!pastedFile && existsSync(pastedFile) && readFileSync(pastedFile).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await key(letter('u'), CTRL);
  ok('⌘V of an image on a VM terminal puts the PNG into ~/.flow/pasted-images on the VM and types that path',
    pastedFile.startsWith(join(vmHome, '.flow', 'pasted-images') + '/') && isPng, pastedOnVm || 'nothing typed');
  /* The same into Claude Code on the VM: a real Claude, logged in through the login shell the way Flow starts one, on
     the stand-in VM's tmux in a new session of its own, shown in an attach window like any agent on the VM. Without the
     variables pty.js strips, so it never takes itself for a nested Claude. */
  const vmcDir = join(homedir(), '.flow-dev', 'term', 'sessions', `vmimage-${Date.now().toString(36)}`);
  mkdirSync(vmcDir, { recursive: true });
  const vmcId = randomUUID();
  execFileSync(TMUX, ['-L', VM, 'new-session', '-d', '-s', 'vmclaude', '-x', '110', '-y', '30', '-c', vmcDir,
    `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SSE_PORT /bin/zsh -ilc 'claude --session-id ${vmcId}'`]);
  await ev(`(() => {
    const d = document.createElement('div');
    d.id = 'vmchost';
    d.style.cssText = 'position:absolute;left:14px;top:500px;width:900px;height:380px;display:flex;flex-direction:column;z-index:6';
    document.getElementById('desk').appendChild(d);
    window.__vmc = FlowTerm.mount(d, { id: 'h-vmc', cmd: 'shell', host: 'flow-test.local', attach: 'vmclaude' });
    window.__vmc.setVisible(true);
  })()`);
  const vmcReady = await waitFor(`__vmc.state === 'open' && /Claude Code/.test(__vmc.getText()) && /❯/.test(__vmc.getText()) && !/Quick safety check|trust this folder/i.test(__vmc.getText())`, 60000);
  const vmPasted = join(vmHome, '.flow', 'pasted-images');
  const vmPngs = () => (existsSync(vmPasted) ? readdirSync(vmPasted).filter((f) => f.endsWith('.png')) : []);
  const pngsBefore = vmPngs();
  await ev(`(async () => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#5e8fd7';
    g.fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  })()`);
  await ev('__vmc.focus()');
  await sleep(150);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...vv, commands: ['paste'] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...vv });
  const vmcAttached = await waitFor(`/\\[Image #\\d+\\]/.test(__vmc.getText())`, 30000);
  const newPngs = vmPngs().filter((f) => !pngsBefore.includes(f));
  const newIsPng = newPngs.length === 1 && readFileSync(join(vmPasted, newPngs[0])).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  ok('⌘V of an image on a VM terminal running Claude Code: that Claude shows [Image #N], from the PNG put on the VM',
    vmcReady && vmcAttached && newIsPng,
    `ready ${!!vmcReady}; ${(await ev('__vmc.getText()')).split('\n').filter((l) => /Image #|pasted-images/.test(l)).join(' | ').trim() || 'no image line'}; new on the VM: ${newPngs.join(', ') || 'none'}`);
  await shot('12b-vm-claude-image-paste');
  // an image file copied in Finder and pasted there: put on the VM as a drop is (no VM folder here, so its home)
  writePng('/tmp/flow term drop/copied in finder.png');
  const onVm = join(vmHome, 'copied in finder.png');
  rmSync(onVm, { force: true });
  const vmcImages = `(__vmc.getText().match(/\\[Image #\\d+\\]/g) || []).length`;
  const vmcBefore = await ev(vmcImages);
  await ev('__vmc.focus()');
  await sleep(150);
  await pasteCopied(['/tmp/flow term drop/copied in finder.png']);
  const vmcCopied = await waitFor(`${vmcImages} > ${vmcBefore}`, 30000);
  ok('an image file copied in Finder and pasted into Claude Code on the VM is put on the VM, and that Claude shows [Image #N]',
    vmcCopied && existsSync(onVm) && readFileSync(onVm).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    `${(await ev('__vmc.getText()')).split('\n').filter((l) => /Image #|copied in finder/.test(l)).join(' | ').trim() || 'no image line'}; on the VM: ${existsSync(onVm)}`);
  await ev(`(async () => { await __vmc.kill(); document.getElementById('vmchost').remove(); })()`);
  vmTmux('kill-session', '-t', '=vmclaude');
  // a VM row dropped on a Mac terminal is copied into the Mac's downloads, typed there, and the app hears of it
  writeFileSync(join(vmWork, 'down to mac.txt'), 'vm-to-mac\n');
  const downloads0 = await ev('__h.downloads.length');
  await focusTerm('shell');
  await type('clear; cat ');
  await dropRows('shell', [{ host: 'flow-test.local', path: join(vmWork, 'down to mac.txt') }]);
  const downTyped = await waitFor(`__h.downloads.length > ${downloads0} && __h.t.shell.getText().includes('cat ' + __h.downloads[__h.downloads.length - 1].file.replace(/[ ()']/g, '\\\\$&'))`, 20000);
  const downFile = await ev('(__h.downloads[__h.downloads.length - 1] || {}).file || ""');
  await key('Enter');
  const downRead = await waitFor(`/^vm-to-mac$/m.test(__h.t.shell.getText())`, 8000);
  ok('a VM row dropped on a Mac terminal is copied into the Mac downloads, its Mac path is typed, and onDownload gets it',
    downTyped && downRead && dirname(downFile) === macDownloads && readFileSync(downFile, 'utf8') === 'vm-to-mac\n', downFile || 'no download');
  await ev(`(async () => { await __vmf.kill(); document.getElementById('vmfhost').remove(); })()`);
  vmTmux('kill-server');

  // ---------- errors ----------
  const pageErrors = await ev('__h.errors');
  ok('no page errors or console errors', pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].join(' | ') || 'none');
  await shot('11-final');
} catch (e) {
  ok(`driver crashed: ${e.message}`, false);
  await shot('99-crash').catch((err) => console.error(`could not take the crash screenshot: ${err.message}`));
} finally {
  const failed = results.filter((r) => !r.cond);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  const closed = await new Promise((resolve) => {
    ws.onclose = () => resolve(true);
    ws.close();
    setTimeout(() => resolve(false), 2000);
  });
  if (!closed) console.log('(the CDP websocket did not finish closing within 2s; exiting anyway)');
  process.stdout.write('', () => process.exit(failed.length ? 1 : 0));
}




