// notes' end-to-end check of every note in the real app, with real input over CDP (BRIEF: notes.js, notes.css).
// Starts its own isolated app (userData /tmp/flow-dev-notes, socket flow-dev-notes, CDP 9566) from FLOW_DIR (default
// this repo) on the seed without its VM windows, every terminal in a folder under /tmp/flow-dev-notes/cwd. The one
// Claude prompt it sends goes to a session it created there. It checks whichever notes model the tree has: page notes
// in ws.notes (batch 1) or one record per page (batch 2). Screenshots: test/notes-shots/.
//   FLOW_DIR=<tree> node test/notes-e2e.mjs [--only a2,b2,a3,a5,a6,links,b4,b1]
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, drag, mouse, wheel, key, type, MOD, shot, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const SHOTS = path.join(HERE, 'notes-shots');
const PAGE_URL = 'https://en.wikipedia.org/wiki/Hyperlink';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const want = (k) => !only || only.includes(k);
const R = reporter();
fs.mkdirSync(SHOTS, { recursive: true });

/* ---------- the app ---------- */
const pids = () => {
  const r = spawnSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARK}`], { encoding: 'utf8' });
  return r.stdout.trim().split('\n').filter(Boolean);
};
function launch(userData) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const log = fs.openSync(path.join(UD, 'app.log'), 'a');
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${userData}`, `FLOW_TMUX_SOCKET=${SOCK}`,
    `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1', './node_modules/.bin/electron', '.', '--no-sandbox', MARK], { cwd: DIR, env, stdio: ['ignore', log, log], detached: true });
  child.unref();
}
/* A graceful quit (SIGTERM is Electron's app.quit on Linux), then wait for the process to be gone. */
async function quit() {
  for (const p of pids()) process.kill(+p, 'SIGTERM');
  for (let i = 0; i < 60 && pids().length; i++) await sleep(250);
  if (pids().length) throw new Error(`the app did not quit: ${pids().join(' ')}`);
}
async function connect() {
  const page = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 160 && !(await evaluate(page, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready.then(() => true)');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(page, HELPERS);
  return page;
}
async function seed() {
  const probe = `${UD}-probe`;
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'flow-state.json'), JSON.stringify({ v: 11, ws: [{ id: 'probe', name: 'probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  fs.mkdirSync(UD, { recursive: true });
  launch(probe);
  const p = await connect();
  const s = await evaluate(p, 'window.__flow.seed()');
  p.ws.close();
  await quit();
  fs.rmSync(probe, { recursive: true, force: true });
  let hosts = 0;
  for (const ws of s) {
    const dir = path.join(UD, 'cwd', ws.id);
    fs.mkdirSync(dir, { recursive: true });
    ws.folder = dir;
    for (const k of ['windows', 'closed']) {
      ws[k] = (ws[k] || []).filter((w) => { if (w.host) hosts++; return !w.host; });
      ws[k].forEach((w) => { if (w.type === 'term' || w.type === 'team') w.cwd = dir; });
    }
  }
  fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: s, ui: {} }));
  return hosts;
}
async function cleanup() {
  for (const p of pids()) process.kill(+p, 'SIGKILL');
  for (let i = 0; i < 40 && pids().length; i++) await sleep(250);
  spawnSync('tmux', ['-L', SOCK, 'kill-server']);
}

/* ---------- in-page helpers ---------- */
const HELPERS = `window.__n = {
  r(el) { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; },
  win(id) { return document.querySelector('.win[data-id="' + id + '"]'); },
  ws() { return window.__flow.state().ws[0]; },
  w(id) { const ws = this.ws(); return ws.windows.find((w) => w.id === id) || ws.closed.find((w) => w.id === id); },
  note(id) { return this.ws().notes.find((n) => n.id === id); },
  focus() { const a = document.activeElement; return a ? (a.dataset.key || a.className || a.tagName) : ''; },
  boxes(id) { return [...this.win(id).querySelectorAll('.fnote-box')].map((b) => ({ ...this.r(b), done: b.classList.contains('done') })); },
};`;
const ev = (p, e) => evaluate(p, e);
const rect = (p, e) => ev(p, `__n.r(${e})`);
async function waitFor(p, expr, ms = 8000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await ev(p, expr); if (v) return v; await sleep(150); }
  return v;
}
async function guest(match) {
  const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url.includes(match));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  return {
    eval: (expression) => new Promise((res) => { const id = ++seq; pend.set(id, (d) => res(d.result && d.result.result ? d.result.result.value : undefined)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }),
    close: () => ws.close(),
  };
}
async function paste(p, text) {
  await ev(p, `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => 1)`);
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: MOD.ctrl, commands: ['paste'] });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: MOD.ctrl });
  await sleep(300);
}
const snap = (p, name) => shot(p, path.join(SHOTS, `${name}.png`));
const disk = () => JSON.parse(fs.readFileSync(path.join(UD, 'flow-state.json'), 'utf8'));

/* ---------- the run ---------- */
await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
const hosts = await seed();
R.ok('seed written without its VM windows', hosts === 2, `${hosts} host windows removed`);
launch(UD);
let p = await connect();
const ctx = {};
// batch 2 (the page as a primitive) has page records and unfolding links; batch 1 keeps page notes in ws.notes
const PAGES = await ev(p, 'typeof FlowNotes.load === "function"');
console.log(`notes model: ${PAGES ? 'page records (batch 2)' : 'page notes in ws.notes (batch 1)'}`);

try {
  if (want('a2') || want('b2') || want('b1')) {
    // a2: the ✎ pane of an agent: a click anywhere in it lands in the note.
    const pane = await rect(p, '__n.win("w-design").querySelector(".npane")');
    R.ok('w-design shows its ✎ pane', pane && pane.w > 100, pane);
    await click(p, pane.cx, pane.y + pane.h - 20);
    R.ok('a click in the empty part of the ✎ pane puts the caret in the agent note', (await ev(p, '__n.focus()')) === 'win:w-design', await ev(p, '__n.focus()'));
    await key(p, 'Enter');
    await type(p, 'agent todo:');
    await key(p, 'Enter');
    // b2: todos
    await type(p, '[ ] check the fork menu');
    await key(p, 'Enter');
    await type(p, 'answer page about clips');
    await key(p, 'Enter');
    await key(p, 'Enter');
    await type(p, 'after the list');
    await sleep(400);
    const note = await ev(p, '__n.w("w-design").note');
    R.ok('typing "[ ] " starts a todo, Enter continues it, Enter on an empty one ends the list',
      note.endsWith('agent todo:\n[ ] check the fork menu\n[ ] answer page about clips\nafter the list'), JSON.stringify(note.slice(-90)));
    let boxes = await ev(p, '__n.boxes("w-design")');
    R.ok('both todos show a box', boxes.length === 2, boxes.length);
    await click(p, boxes[0].x + 5, boxes[0].cy);
    await sleep(300);
    boxes = await ev(p, '__n.boxes("w-design")');
    R.ok('a click on a box ticks it: the text says [x] and the box is done', (await ev(p, '__n.w("w-design").note')).includes('[x] check the fork menu') && boxes[0].done && !boxes[1].done);
    await key(p, 'z', MOD.ctrl);
    await sleep(300);
    R.ok('⌘Z undoes the tick', (await ev(p, '__n.w("w-design").note')).includes('[ ] check the fork menu'));
    await click(p, boxes[0].x + 5, boxes[0].cy);
    let onDisk = false;
    for (let i = 0; i < 20 && !onDisk; i++) { await sleep(250); onDisk = disk().ws[0].windows.find((w) => w.id === 'w-design').note.includes('[x] check the fork menu'); }
    R.ok('the tick is saved to flow-state.json', onDisk);
    await snap(p, '01-agent-pane-todos');
  }

  if (want('a3')) {
    const dock = await rect(p, 'document.querySelector(".dock [data-k=note]")');
    await mouse(p, 'mouseMoved', dock.cx, dock.cy);
    await sleep(400);
    await click(p, dock.cx, dock.cy);
    await sleep(500);
    const nid = await ev(p, '__n.ws().notes[0].id');
    R.ok('the dock ✎ makes a note with its title selected', (await ev(p, '__n.focus()')) === `title:${nid}`);
    await type(p, 'groceries');
    await key(p, 'Enter');
    R.ok('Enter in the title goes on to the body', (await ev(p, '__n.focus()')) === `note:${nid}`, await ev(p, '__n.focus()'));
    await type(p, '[ ] milk');
    await key(p, 'Enter');
    await type(p, 'eggs');
    await sleep(300);
    const n = await ev(p, `__n.note("${nid}")`);
    R.ok('the title is one line and the body holds the list', n.title === 'groceries' && n.body === '[ ] milk\n[ ] eggs', JSON.stringify(n));
    const t = await rect(p, `document.querySelector('.ntitle[data-key="title:${nid}"]')`);
    await click(p, t.x + t.w - 4, t.cy);
    await key(p, 'End');
    await paste(p, ' for the\nweek\n');
    const n2 = await ev(p, `__n.note("${nid}")`);
    R.ok('a paste into a title comes in as one line', n2.title === 'groceries for the week', JSON.stringify(n2.title));
    ctx.nid = nid;
    await snap(p, '02-new-note');
  }

  if (want('a5') || want('a6')) {
    const row = await rect(p, 'document.querySelector(\'#sblist .tr[data-act="note|n-design"]\')');
    await click(p, row.x + 50, row.cy);
    await sleep(600);
    R.ok('opening a closed note from the sidebar puts the caret in its body', (await ev(p, '__n.focus()')) === 'note:n-design', await ev(p, '__n.focus()'));
    await type(p, ' typed at once');
    await sleep(300);
    R.ok('typing right after opening goes into the note', (await ev(p, '__n.note("n-design").body')).endsWith(' typed at once'));
    // going back to a note puts the caret where it was: 5 characters back, a click away, its row again, a key
    for (let i = 0; i < 5; i++) await key(p, 'ArrowLeft');
    const q = await rect(p, 'document.getElementById("q")');
    await click(p, q.cx, q.cy);
    await sleep(300);
    const away = await ev(p, '__n.focus()');
    const row2 = await rect(p, 'document.querySelector(\'#sblist .tr[data-act="note|n-design"]\')');
    await click(p, row2.x + 50, row2.cy);
    await sleep(600);
    await type(p, 'X');
    await sleep(300);
    const back = await ev(p, '__n.note("n-design").body');
    R.ok('going back to a note puts the caret where it was', away !== 'note:n-design' && back.endsWith(' typed atX once'), { away, tail: back.slice(-16) });
    await key(p, 'Backspace');
    for (let i = 0; i < 5; i++) await key(p, 'ArrowRight');
    let long = '';
    for (let i = 1; i <= 400; i++) long += `\nline ${i}: a long note line with some words so that it wraps when the window is narrow`;
    await paste(p, long);
    await sleep(500);
    const m = await ev(p, `(() => { const w = document.querySelector('.nbody[data-key="note:n-design"]').closest('.win'); const nd = w.querySelector('.nd'); const t = w.querySelector('.ntitle').getBoundingClientRect(); const b = nd.getBoundingClientRect(); const f = w.querySelector('.fnote'); return { title: t.top >= b.top && t.bottom <= b.bottom, ndTop: nd.scrollTop, fTop: f.scrollTop, fh: f.scrollHeight, ch: f.clientHeight, len: __n.note('n-design').body.split('\\n').length }; })()`);
    R.ok('a 400-line note keeps its title in view and scrolls only its body', m.title && m.ndTop === 0 && m.fTop > 0 && m.fh > m.ch && m.len >= 401, m);
    await snap(p, '03-long-note');
  }

  if (want('a7')) {
    // a note closed with its red light and opened again from its row comes back where it was, at its size (browse)
    const winOf = () => ev(p, `(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.noteId === 'n-design'); return w ? { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h } : null; })()`);
    // first a size of its own, its grip dragged
    const was0 = await winOf();
    const rz = was0 ? await rect(p, `__n.win(${JSON.stringify(was0.id)}).querySelector('.rz')`) : null;
    if (rz) await drag(p, { x: rz.cx, y: rz.cy }, { x: rz.cx - 60, y: rz.cy + 50 }, { steps: 10, stepMs: 20 });
    await sleep(500);
    const was = await winOf();
    const resized = !!was && !!was0 && (was.w !== was0.w || was.h !== was0.h);
    const red = was ? await rect(p, `__n.win(${JSON.stringify(was.id)}).querySelector('[data-l=close]')`) : null;
    if (red) await click(p, red.cx, red.cy);
    await sleep(600);
    const shut = !(await winOf());
    const row = await rect(p, 'document.querySelector(\'#sblist .tr[data-act="note|n-design"]\')');
    if (row) await click(p, row.x + 50, row.cy);
    await sleep(800);
    const now = await winOf();
    R.ok('a note closed with its red light and opened again from its row comes back where it was, at its size', resized && shut && !!now && now.x === was.x && now.y === was.y && now.w === was.w && now.h === was.h, { was0, was, now });
  }

  if (want('links')) {
    const row = await rect(p, 'document.querySelector(\'#sblist .tr[data-act="note|n-week"]\')');
    await click(p, row.x + 50, row.cy);
    await sleep(600);
    await type(p, ' read https://example.com/page. and www.example.org too');
    await sleep(400);
    const at = (word) => ev(p, `(() => { const ed = __n.win("w-week").querySelector(".nbody"); const all = [...ed.childNodes].map((n) => (n.nodeType === 3 ? n.data : '\\n')).join(''); let left = all.indexOf(${JSON.stringify(word)}), node = null, off = 0; for (const n of ed.childNodes) { const len = n.nodeType === 3 ? n.data.length : 1; if (!node && left <= len && n.nodeType === 3) { node = n; off = left; } left -= len; } const r = document.createRange(); r.setStart(node, off); r.setEnd(node, off + 2); const q = r.getClientRects()[0]; return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
    const pages = () => ev(p, '__flow.windows().filter((w) => w.ws === "flow" && w.type === "page").map((w) => w.url)');
    const before = (await pages()).length;
    const end = await at('too');
    await click(p, end.x + 40, end.y);
    await sleep(800);
    R.ok('a click beside a link only places the caret', (await pages()).length === before && (await ev(p, '__n.focus()')) === 'note:n-week', await ev(p, '__n.focus()'));
    const l1 = await at('https://example.com/page');
    if (PAGES) {
      await click(p, l1.x, l1.y);
      await sleep(800);
      const unfolded = await ev(p, `(() => { const x = __n.win("w-week").querySelector('.fnote-x'); return x ? { url: x.dataset.url, text: x.innerText.slice(0, 60) } : null; })()`);
      R.ok('a click on a web address in a note unfolds the page in brief under its line', !!unfolded && unfolded.url === 'https://example.com/page' && (await pages()).length === before, unfolded);
      await click(p, l1.x, l1.y);
      await sleep(500);
      R.ok('a second click on it folds it', !(await ev(p, '!!__n.win("w-week").querySelector(".fnote-x")')));
    }
    await click(p, l1.x, l1.y, { modifiers: PAGES ? MOD.ctrl : 0 });
    await sleep(1500);
    const after = await pages();
    R.ok(`${PAGES ? '⌘-click' : 'a click'} opens it as a page beside, without the full stop after it`, after.length === before + 1 && after.includes('https://example.com/page'), after.slice(-1));
    const row2 = await rect(p, 'document.querySelector(\'#sblist .tr[data-act="note|n-week"]\')');
    await click(p, row2.x + 50, row2.cy);
    await sleep(800);
    const l2 = await at('www.example.org');
    await click(p, l2.x, l2.y, { modifiers: PAGES ? MOD.ctrl : 0 });
    let www = [];
    for (let i = 0; i < 24 && !www.includes('https://www.example.org/'); i++) { await sleep(250); www = await pages(); }
    R.ok('a www. address opens as https', www.includes('https://www.example.org/'), www.slice(-1));
    R.ok('the note stays plain text', (await ev(p, '__n.note("n-week").body')).endsWith(' read https://example.com/page. and www.example.org too'));
    await snap(p, '04a-links');
  }

  if (want('b4')) {
    const id = await ev(p, `window.__flow.openPage(${JSON.stringify(PAGE_URL)})`);
    ctx.page = id;
    let g = null;
    for (let i = 0; i < 60 && !g; i++) { g = await guest('wikipedia.org/wiki/Hyperlink'); if (!g) await sleep(250); }
    await sleep(3000);
    const target = await g.eval(`(() => { const p = [...document.querySelectorAll('#mw-content-text p')].filter((x) => x.innerText.length > 120)[30]; p.scrollIntoView({ block: 'center' }); return p.innerText.slice(0, 60); })()`);
    await sleep(500);
    // select the first words of that paragraph with a real drag: guest coordinates scaled to the window
    const sel = await g.eval(`(() => { const p = [...document.querySelectorAll('#mw-content-text p')].filter((x) => x.innerText.length > 120)[30]; const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const t = w.nextNode(); const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, Math.min(t.data.length, 40)); const b = r.getClientRects()[0]; return { x0: b.left + 1, x1: b.right - 1, y: (b.top + b.bottom) / 2, iw: innerWidth, text: t.data.slice(0, 40) }; })()`);
    const wv = await rect(p, `[...__n.win("${id}").querySelectorAll('webview')].find((v) => (v.getAttribute('src') || '').includes('wikipedia.org'))`);
    const k = wv.w / sel.iw;
    // bring the page's window to the front with a click on a part of it that no other window covers
    const spot = await ev(p, `(() => { const w = __n.win("${id}"); const t = w.querySelector('.tb .title').getBoundingClientRect(); for (let x = t.left + 4; x < t.right; x += 10) { const y = t.top + t.height / 2; const e = document.elementFromPoint(x, y); if (e && e.closest('.win') === w && e.closest('.tb')) return { x, y }; } return null; })()`);
    if (spot) { await click(p, spot.x, spot.y); await sleep(400); }
    const top = await ev(p, `(() => { const e = document.elementFromPoint(${wv.x + sel.x0 * k}, ${wv.y + sel.y * k}); return !!e && e.closest('.win') === __n.win("${id}"); })()`);
    R.ok('a click on its title bar brings the page window over the others', spot && top, spot);
    await drag(p, { x: wv.x + sel.x0 * k, y: wv.y + sel.y * k }, { x: wv.x + sel.x1 * k, y: wv.y + sel.y * k }, { steps: 12, stepMs: 15 });
    const picked = await g.eval('String(getSelection())');
    R.ok('a real drag selects text on the page', picked.trim().length > 10, JSON.stringify(picked));
    const clipBtn = await rect(p, `__n.win("${id}").querySelector('.pclip')`);
    await click(p, clipBtn.cx, clipBtn.cy);
    await sleep(600);
    const snapped = await g.eval('String(getSelection())');
    R.ok('the clip snaps the selection to whole words', snapped.trim().length >= picked.trim().length && snapped.includes(picked.trim().split(' ').slice(1, -1).join(' ')), JSON.stringify(snapped));
    const after = PAGES
      ? await ev(p, `(() => { const w = __n.w("${id}"); const r = window.__flow.state().pages[FlowNotes.key(${JSON.stringify(PAGE_URL)})]; return { noted: !!w.noted, body: r ? r.note : '', focus: __n.focus(), key: 'page:' + w.id }; })()`)
      : await ev(p, `(() => { const w = __n.w("${id}"); const n = __n.note(w.noteId); return { noted: !!w.noted, body: n.body, clips: n.clips || [], focus: __n.focus(), key: 'note:' + w.noteId }; })()`);
    const quote = snapped.replace(/\s+/g, ' ').trim();
    R.ok(`✂ opens the page's ✎ panel with the sentence quoted ${PAGES ? "in the page's own note " : ''}and the caret under it`,
      after.noted && after.body.endsWith(`> ${quote}\n`) && after.focus === after.key, JSON.stringify({ noted: after.noted, tail: after.body.slice(-80), focus: after.focus }));
    if (!PAGES) {
      const c = after.clips.find((x) => x.text === quote);
      R.ok('the clip keeps the page link with a text fragment', c && c.url.startsWith(`${PAGE_URL}#:~:text=`), c && c.url);
    }
    await type(p, 'my note on this sentence');
    await sleep(300);
    const noteNow = PAGES ? await ev(p, `window.__flow.state().pages[FlowNotes.key(${JSON.stringify(PAGE_URL)})].note`) : await ev(p, `__n.note(__n.w("${id}").noteId).body`);
    R.ok('the annotation goes under the quote', noteNow.endsWith(`> ${quote}\nmy note on this sentence`));
    await g.eval('scrollTo(0, 0)');
    await sleep(300);
    // ↗ shows once the page says it has the sentence
    await waitFor(p, `(() => { const c = [...__n.win("${id}").querySelectorAll('.fnote-clip')].pop(); return !!c && !c.classList.contains('gone'); })()`, 5000);
    const arrow = await rect(p, `[...__n.win("${id}").querySelectorAll('.fnote-clip')].pop()`);
    /* The quote's ↗ (its opacity), its bar's right edge, and where each of its text lines starts. */
    const look = () => ev(p, `(() => {
      const w = __n.win("${id}"), c = [...w.querySelectorAll('.fnote-clip')].pop(), bar = [...w.querySelectorAll('.fnote-qbar')].pop();
      const tw = document.createTreeWalker(w.querySelector('.npane .fnote-ed'), NodeFilter.SHOW_TEXT);
      let lines = [];
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        const i = t.data.lastIndexOf(${JSON.stringify(quote)});
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + ${quote.length});
        lines = [...r.getClientRects()].map((x) => Math.round(x.left));
      }
      return { arrow: c ? getComputedStyle(c, '::before').opacity : null, bar: bar ? Math.round(bar.getBoundingClientRect().right) : null, lines };
    })()`);
    const atRest = arrow ? await look() : null;
    await mouse(p, 'mouseMoved', arrow.x + arrow.w + 40, arrow.y + 8);
    await sleep(300);
    const onLine = arrow ? await look() : null;
    R.ok('a quote has a bar beside all its lines, and its ↗ shows once the pointer is on it, moving nothing', !!atRest && atRest.bar != null && atRest.lines.length > 0 && atRest.lines.every((x) => x >= atRest.bar + 2) && atRest.arrow === '0' && onLine.arrow === '1' && onLine.bar === atRest.bar && JSON.stringify(onLine.lines) === JSON.stringify(atRest.lines), { atRest, onLine });
    await click(p, arrow.cx, arrow.cy);
    await sleep(2500);
    const where = await g.eval(`(() => { const want = ${JSON.stringify(quote.slice(0, 24))}; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t; t = w.nextNode()) { const i = t.data.indexOf(want); if (i < 0) continue; const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + want.length); const b = r.getBoundingClientRect(); return { y: scrollY, top: b.top, h: innerHeight, docTop: b.top + scrollY }; } return null; })()`);
    R.ok('the arrow opens the page scrolled to that sentence', where && where.top > -20 && where.top < where.h && (where.docTop < where.h || where.y > 0), where);
    await snap(p, '04-clip');
    g.close();
    ctx.quote = quote;
  }

  if (want('b1')) {
    // a tiny prompt in w-design (a session this run created) so that ⌘K can find it after it ends
    const sid = await ev(p, '__n.w("w-design").sessionId');
    const row = await rect(p, 'document.querySelector(\'#sblist .tr[data-act="win|w-design"]\')');
    await click(p, row.x + 50, row.cy);
    await sleep(800);
    const host = await rect(p, '__n.win("w-design").querySelector(".termhost")');
    await click(p, host.cx, host.cy);
    const text = () => ev(p, 'window.__flow.term("w-design").getText(40)');
    await waitFor(p, '/trust this folder|❯/.test(window.__flow.term("w-design").getText(40))', 30000);
    if (/trust this folder/.test(await text())) { await key(p, 'ArrowDown'); await key(p, 'Enter'); }
    const word = `notesprobe${Date.now().toString(36)}`;
    await waitFor(p, '/^❯ ?$/m.test(window.__flow.term("w-design").getText(40))', 30000);
    await type(p, `${word}: reply with the word ok`);
    await key(p, 'Enter');
    const replied = await waitFor(p, '/● ok/i.test(window.__flow.term("w-design").getText(40))', 60000);
    R.ok('the agent answered the one tiny prompt', !!replied);
    const kept = await ev(p, '__n.w("w-design").note');
    const red = await rect(p, '__n.win("w-design").querySelector("[data-l=close]")');
    await click(p, red.cx, red.cy);
    await sleep(600);
    const end = await rect(p, 'document.querySelector(\'#sblist .tr[data-act="reopen|w-design"] [data-end]\')');
    await click(p, end.cx, end.cy);
    await waitFor(p, '!__n.ws().closed.some((w) => w.id === "w-design")', 10000);
    const stored = await ev(p, `(__n.ws().sessionNotes || {})["${sid}"]`);
    R.ok('ending the agent keeps its note under its session id', stored === kept, JSON.stringify((stored || '').slice(-60)));
    const q = await rect(p, 'document.getElementById("q")');
    await click(p, q.cx, q.cy);
    await type(p, word);
    const srow = await waitFor(p, `__n.r(document.querySelector('#sblist .srow[data-sess="${sid}"]'))`, 180000);
    R.ok('⌘K finds the ended session', !!srow);
    await click(p, srow.x + 40, srow.cy);
    const clicked = Date.now();
    await waitFor(p, `__n.ws().windows.some((x) => x.sessionId === "${sid}")`, 10000);
    const ms = Date.now() - clicked;
    const back = await ev(p, `(() => { const w = __n.ws().windows.find((x) => x.sessionId === "${sid}"); return w ? { id: w.id, note: w.note, left: (__n.ws().sessionNotes || {})["${sid}"], ms: ${ms} } : null; })()`);
    R.ok('reopening it from ⌘K brings its note back', back && back.note === kept && back.left === undefined, JSON.stringify(back && { tail: back.note.slice(-60), ms: back.ms }));
    ctx.sid = sid;
    ctx.kept = kept;
    await snap(p, '05-reopened');
  }

  // restart: everything above comes back
  p.ws.close();
  await quit();
  launch(UD);
  p = await connect();
  await sleep(1500);
  const s = await ev(p, `(() => { const ws = __n.ws(); return { notes: ws.notes, windows: ws.windows }; })()`);
  if (ctx.nid) {
    const n = s.notes.find((x) => x.id === ctx.nid);
    R.ok('after a restart: the new note', n && n.title === 'groceries for the week' && n.body === '[ ] milk\n[ ] eggs');
  }
  if (ctx.sid) {
    const w = s.windows.find((x) => x.sessionId === ctx.sid);
    R.ok('after a restart: the reopened agent and its note with the ticked todo', w && w.note === ctx.kept && w.note.includes('[x] check the fork menu'));
  }
  if (ctx.page) {
    const w = s.windows.find((x) => x.id === ctx.page);
    const arrows = (await waitFor(p, `__n.win("${ctx.page}") ? __n.win("${ctx.page}").querySelectorAll('.fnote-clip:not(.gone)').length : 0`, 10000)) || 0;
    const text = PAGES ? ((await ev(p, 'window.__flow.state().pages'))[await ev(p, `FlowNotes.key(${JSON.stringify(PAGE_URL)})`)] || {}).note || '' : (s.notes.find((x) => x.id === w.noteId) || {}).body || '';
    R.ok('after a restart: the page\'s ✎ panel is open with its quote and the arrow', w && w.noted && text.includes(`> ${ctx.quote}`) && arrows >= 1, { noted: w && w.noted, arrows });
  }
  await snap(p, '06-restarted');
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  R.ok('no console errors in the app', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (err) {
  R.ok(`run stopped: ${err.message}`, false);
} finally {
  try { p.ws.close(); } catch (e) { console.error('closing CDP:', e.message); }
  if (process.env.NOTES_KEEP) console.log('NOTES_KEEP: the app is left running on 9566');
  else await cleanup();
}
R.summary();




