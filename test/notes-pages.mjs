// notes' check of the page as a primitive: one record per page (its normalized address) holds what was written about
// it, wherever it opens. Old page notes move into records without losing a line; the record survives a restart, and a
// web page and a file page show their highlights again after it; the same page opened in another workspace under
// another spelling of its address shows the same note; a clip becomes a "> sentence" annotation in it. Real input over CDP on notes' own isolated app (userData /tmp/flow-dev-notes, socket
// flow-dev-notes, CDP 9566), started from FLOW_DIR (default this repo). Screenshots: test/notes-shots/pages-*.png.
//   node test/notes-pages.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, evaluate, sleep, click, drag, type, key, MOD, shot, reporter } from './ui-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = process.env.FLOW_DIR || path.resolve(HERE, '..');
const UD = '/tmp/flow-dev-notes', SOCK = 'flow-dev-notes', PORT = 9566, MARK = '--flow-dev=notes';
const SHOTS = path.join(HERE, 'notes-shots');
const R = reporter();
fs.mkdirSync(SHOTS, { recursive: true });

const pids = () => spawnSync('pgrep', ['-f', `[e]lectron/dist/electron .*${MARK}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
function launch(userData) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ELECTRON_RUN_AS_NODE|FLOW_)/.test(k)) delete env[k];
  const log = fs.openSync(path.join(UD, 'app.log'), 'a');
  spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${userData}`, `FLOW_TMUX_SOCKET=${SOCK}`, `FLOW_CDP_PORT=${PORT}`,
    'FLOW_BACKGROUND=1', './node_modules/.bin/electron', '.', '--no-sandbox', MARK], { cwd: DIR, env, stdio: ['ignore', log, log], detached: true }).unref();
}
async function quit() {
  for (const p of pids()) process.kill(+p, 'SIGTERM');
  for (let i = 0; i < 60 && pids().length; i++) await sleep(250);
  if (pids().length) throw new Error(`the app did not quit: ${pids().join(' ')}`);
}
async function cleanup() {
  for (const p of pids()) process.kill(+p, 'SIGKILL');
  for (let i = 0; i < 40 && pids().length; i++) await sleep(250);
  spawnSync('tmux', ['-L', SOCK, 'kill-server']);
}
async function connect() {
  const page = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 160 && !(await evaluate(page, '!!(window.__flow && window.__flow.ready)')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready.then(() => true)');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return page;
}
const ev = (p, e) => evaluate(p, e);
/* The ✂ of a page window once it shows (it may wait for the page to say that something is selected): its center. */
const clipShown = (id) => `(() => { const b = document.querySelector('.win[data-id="${id}"] .pclip'); if (!b || getComputedStyle(b).visibility === 'hidden') return null; const r = b.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`;
/* The highlighted ranges in the loaded page whose address has `part` (the most of any such page), polled up to ms. */
async function marksIn(part, ms) {
  let most = 0;
  for (const end = Date.now() + ms; Date.now() < end && most === 0; await sleep(500)) {
    const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'webview' && t.url.includes(part));
    for (const t of targets) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      const n = await new Promise((res) => {
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result && d.result.result ? d.result.result.value : 0); };
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; })()', returnByValue: true } }));
      });
      ws.close();
      most = Math.max(most, n || 0);
    }
  }
  return most;
}
/* The id of the page window showing an address that contains part, once it is there. */
async function waitFor(p, expr, ms) {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { v = await ev(p, expr); if (v) return v; }
  return v;
}
async function waitPage(p, part, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const id = await ev(p, `(() => { const w = window.__flow.windows().find((x) => x.type === 'page' && (x.url || '').includes(${JSON.stringify(part)})); return w ? w.id : ''; })()`);
    if (id) return id;
  }
  return '';
}
/* True once nothing slides: a window opened past the others brings the view to it with a CSS transition (nav). */
const still = `!document.getAnimations().some((a) => 'transitionProperty' in a && a.effect && a.effect.target && a.effect.target.matches('.track, .canvas, .win, .sb'))`;
const disk = () => JSON.parse(fs.readFileSync(path.join(UD, 'flow-state.json'), 'utf8'));
async function seed() {
  const probe = `${UD}-probe`;
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'flow-state.json'), JSON.stringify({ v: 11, ws: [{ id: 'probe', name: 'probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  fs.mkdirSync(UD, { recursive: true });
  launch(probe);
  const p = await connect();
  const s = await ev(p, 'window.__flow.seed()');
  p.ws.close();
  await quit();
  fs.rmSync(probe, { recursive: true, force: true });
  for (const ws of s) {
    const dir = path.join(UD, 'cwd', ws.id);
    fs.mkdirSync(dir, { recursive: true });
    ws.folder = dir;
    for (const k of ['windows', 'closed']) {
      ws[k] = (ws[k] || []).filter((w) => !w.host);
      ws[k].forEach((w) => { if (w.type === 'term' || w.type === 'team') w.cwd = dir; });
    }
  }
  return s;
}

const MCK = 'https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-judgment-bottleneck-balancing-ai-and-human-speeds-in-strategy';
const ALPHA = 'https://www.alphaxiv.org/abs/2610.09043';

await cleanup();
fs.rmSync(UD, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
const s = await seed();
// old page notes of every shape: open and closed, the same page under another spelling, the same text twice, a
// section, old clips, a page without an address
const flow = s.find((w) => w.id === 'flow'), ef = s.find((w) => w.id === 'ef'), mn = s.find((w) => w.id === 'mynotes');
flow.notes.push({ id: 'p-old1', kind: 'page', title: 'old mckinsey note', url: `http://mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-judgment-bottleneck-balancing-ai-and-human-speeds-in-strategy/?utm_source=mail#top`, body: 'a closed note on the same page\nwith a second line' });
flow.notes.push({ id: 'p-old2', kind: 'page', title: 'same text again', url: MCK, body: flow.notes.find((n) => n.id === 'p-mck').body });
flow.notes.push({ id: 'p-plain', kind: 'page', title: 'a page with nothing written', url: 'https://example.org/plain', body: '' });
flow.notes.push({ id: 'p-clip', kind: 'page', title: 'a clip', url: 'https://en.wikipedia.org/wiki/Hyperlink', body: '> The term "link" was coined in 1965\nwho coined it', clips: [{ text: 'The term "link" was coined in 1965', url: 'https://en.wikipedia.org/wiki/Hyperlink#:~:text=The%20term' }] });
mn.notes.push({ id: 'p-noaddr', kind: 'page', title: 'no address', url: '', body: 'kept as it is' });
ef.notes.push({ id: 'p-ef2', kind: 'page', title: 'ef again', url: 'https://app.efstart.com/work/', body: 'day 3: film the demo' });
const lines = [];
for (const ws of s) for (const n of ws.notes) if (n.kind === 'page') String(n.body || '').split('\n').filter((l) => l.trim()).forEach((l) => lines.push({ ws: ws.id, id: n.id, line: l }));
fs.writeFileSync(path.join(UD, 'flow-state.json'), JSON.stringify({ v: 11, ws: s, ui: {} }));
fs.writeFileSync(path.join(UD, 'cwd', 'flow', 'paper.txt'), 'A paper in the project folder.\nFlow is a macOS Electron app with notes on every page.\nThe end.\n');
R.ok('an old state with page notes of every shape', lines.length >= 10, `${lines.length} lines in ${new Set(lines.map((l) => l.id)).size} page notes`);

launch(UD);
let p = await connect();
try {
  await sleep(1500);
  let st = await ev(p, 'window.__flow.state()');
  const notes = Object.values(st.pages || {}).map((r) => r.note);
  const kept = st.ws.flatMap((w) => w.notes.filter((n) => n.kind === 'page').map((n) => n.body || ''));
  const lost = lines.filter((l) => !notes.some((t) => t.split('\n').includes(l.line)) && !kept.some((t) => t.split('\n').includes(l.line)));
  R.ok('the migration moves every line of every old page note into its page\'s record', lost.length === 0, lost.length ? lost.slice(0, 3) : `${Object.keys(st.pages).length} records`);
  const mckKey = await ev(p, `FlowNotes.key(${JSON.stringify(MCK)})`);
  const mck = st.pages[mckKey];
  R.ok('two spellings of one address and the same text twice make one record, text once', !!mck && mck.note.includes('a closed note on the same page') && mck.note.split('judgment is the bottleneck').length === 2, mck && mck.note.slice(0, 80));
  const addrs = s.flatMap((w) => w.notes.filter((n) => n.kind === 'page' && n.url).map((n) => ({ id: n.id, url: n.url })));
  const keyOf = async (u) => ev(p, `FlowNotes.key(${JSON.stringify(u)})`);
  const savedKeys = await Promise.all(st.ws.flatMap((w) => (w.saved || []).map((x) => keyOf(x.url))));
  const openKeys = await Promise.all(st.ws.flatMap((w) => w.windows.filter((x) => x.type === 'page').flatMap((x) => (x.tabs || []).map((t) => keyOf(t.url)))));
  const gone = [];
  for (const a of addrs) { const k = await keyOf(a.url); if (!st.pages[k] && !savedKeys.includes(k) && !openKeys.includes(k)) gone.push(a.id); }
  R.ok('every page the owner had is still in a record, a saved list or a tab (written or not)', gone.length === 0, gone.length ? gone : `${addrs.length} pages`);
  R.ok('a page without an address keeps its entry and text', st.ws.find((w) => w.id === 'mynotes').notes.some((n) => n.id === 'p-noaddr' && n.body === 'kept as it is'));
  R.ok('no page entry keeps text that moved', st.ws.every((w) => w.notes.every((n) => n.kind !== 'page' || !n.url || !(n.body || '').trim())));
  await sleep(800);
  R.ok('the records are in flow-state.json', !!(disk().pages || {})[mckKey]);

  // the same page, another workspace, another spelling: same note, ✎ bright
  await ev(p, 'window.__flow.go(4)');
  await sleep(1500);
  const id = await ev(p, `window.__flow.openPage(${JSON.stringify('http://alphaxiv.org/abs/2610.09043/?utm_source=newsletter#comments')})`);
  await sleep(4000);
  const pen = await ev(p, `(() => { const b = document.querySelector('.win[data-id="${id}"] .tb .act'); const r = b.getBoundingClientRect(); return { on: b.classList.contains('on'), x: r.right - 8, y: r.top + r.height / 2 }; })()`);
  R.ok('a page with a note shows a bright ✎ in another workspace', pen.on);
  await click(p, pen.x, pen.y);
  await sleep(600);
  const pane = await ev(p, `(() => { const ed = document.querySelector('.win[data-id="${id}"] .npane .fnote-ed'); return { text: ed.textContent, focus: document.activeElement === ed }; })()`);
  R.ok('its ✎ opens the note written on that page elsewhere', pane.focus && pane.text.startsWith('human judgment in the loop'), JSON.stringify(pane.text.slice(0, 50)));
  await type(p, ' and who answers for it');
  await sleep(500);
  const alphaKey = await ev(p, `FlowNotes.key(${JSON.stringify(ALPHA)})`);
  R.ok('typing there writes the page\'s own record', (await ev(p, `window.__flow.state().pages[${JSON.stringify(alphaKey)}].note`)).endsWith('and when. and who answers for it'));

  // a clip becomes an annotation in that record
  const guest = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url.includes('2610.09043') && x.url.includes('utm') === false) || (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url.includes('2610.09043'));
  const gws = new WebSocket(guest.webSocketDebuggerUrl);
  await new Promise((res) => { gws.onopen = res; });
  let gseq = 0;
  const gev = (expression) => new Promise((res) => { const id = ++gseq; gws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) res(d.result && d.result.result ? d.result.result.value : undefined); }; gws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
  const picked = await gev(`(() => { const p = [...document.querySelectorAll('p, div')].find((x) => x.children.length === 0 && (x.innerText || '').length > 80); const t = p.firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, Math.min(t.data.length, 50)); getSelection().removeAllRanges(); getSelection().addRange(r); return String(getSelection()); })()`);
  await waitFor(p, still, 8000);
  const clipBtn = await waitFor(p, clipShown(id), 5000);
  await click(p, clipBtn.x, clipBtn.y);
  const head = `> ${picked.trim().split(' ').slice(0, 4).join(' ')}`;
  const after = (await waitFor(p, `(() => { const n = window.__flow.state().pages[${JSON.stringify(alphaKey)}].note; return n.split('\\n').some((l) => l.startsWith(${JSON.stringify(head)})) ? n : ''; })()`, 5000)) || (await ev(p, `window.__flow.state().pages[${JSON.stringify(alphaKey)}].note`));
  const quote = after.split('\n').reverse().find((l) => l.startsWith('> '));
  R.ok('✂ puts the sentence into the page\'s record as "> sentence"', !!quote && quote.slice(2).startsWith(picked.trim().split(' ').slice(0, 4).join(' ')), quote);
  await type(p, 'my note on it');
  R.ok('the annotation goes under it', !!(await waitFor(p, `window.__flow.state().pages[${JSON.stringify(alphaKey)}].note.endsWith(${JSON.stringify(`${quote}\nmy note on it`)})`, 5000)));
  // a quote whose sentence is not (or no longer) on the site: it stays in the note as written, is not highlighted,
  // and has no ↗, so nothing has to say it is missing (owner, Nov 1 20:46: no bloated notifications)
  await key(p, 'Enter');
  await key(p, 'Enter');
  await type(p, '> a sentence that this page does not have');
  await key(p, 'Enter');
  await type(p, 'words under it');
  await sleep(1500);
  const painted = await gev(`(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; })()`);
  const noteNow = await ev(p, `window.__flow.state().pages[${JSON.stringify(alphaKey)}].note`);
  R.ok('a quote not on the page stays in the note and only the sentence that is there is highlighted', noteNow.includes('> a sentence that this page does not have\nwords under it') && painted === 1, { painted });
  const MISSING = 'a sentence that this page';
  const arrows = await waitFor(p, `(() => { const cs = [...document.querySelectorAll('.win[data-id="${id}"] .fnote-clip')].map((a) => { const r = a.getBoundingClientRect(); return { q: a.dataset.quote, gone: a.classList.contains('gone'), arrow: getComputedStyle(a, '::before').content, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); const miss = cs.find((a) => a.q.startsWith(${JSON.stringify(MISSING)})), hit = cs.find((a) => !a.q.startsWith(${JSON.stringify(MISSING)})); return miss && hit && miss.gone && !hit.gone ? cs : null; })()`, 5000);
  const miss = arrows && arrows.find((a) => a.gone), hit = arrows && arrows.find((a) => !a.gone);
  R.ok('↗ shows only on the sentence the page has; the missing one is still a quote, with no arrow', !!arrows && miss.arrow === 'none' && hit.arrow.includes('↗') && arrows.length === 2 && (await ev(p, `document.querySelectorAll('.win[data-id="${id}"] .fnote-qbar').length`)) === 2, arrows);
  // a click where its arrow would be lands in the note, and nothing pops up
  await click(p, miss.x, miss.y);
  let popped = '';
  for (let i = 0; i < 12 && !popped; i++) { await sleep(250); popped = await ev(p, 'document.getElementById("toast").classList.contains("on") ? document.getElementById("toast").textContent : ""'); }
  const keysIn = await ev(p, `(() => { const e = document.querySelector('.win[data-id="${id}"] .npane .fnote-ed'); return document.activeElement === e; })()`);
  R.ok('a click on the missing quote\'s mark shows no notification and leaves the keys in the note', !popped && keysIn, { popped, keysIn });
  gws.close();
  await shot(p, path.join(SHOTS, 'pages-1-annotation.png'));

  // a file from the workspace folder, shown as a page: a clip lands in that file's own note
  await ev(p, 'window.__flow.go(0)');
  await sleep(1200);
  // its row is named as Finder names the folder (batch 8), or by its path (batch 7)
  const folder = await ev(p, `(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => /^files\\|/.test(x.dataset.act || '') && /(^|\\/cwd\\/)flow$/.test((x.querySelector('.l') || x).textContent.trim())); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  R.ok('the workspace folder shows in the sidebar', !!folder);
  await click(p, folder.x, folder.y);
  await sleep(1200);
  const fileRow = await ev(p, `(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => x.textContent.trim().endsWith('paper.txt')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  await click(p, fileRow.x, fileRow.y);
  const fileWin = await waitPage(p, 'paper.txt', 15000);
  R.ok('a click on the file opens it as a page', !!fileWin, fileWin);
  let fg = null;
  for (let i = 0; i < 40 && !fg; i++) { fg = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && x.url.includes('paper.txt')); if (!fg) await sleep(250); }
  const fws = new WebSocket(fg.webSocketDebuggerUrl);
  await new Promise((res) => { fws.onopen = res; });
  let fseq = 100;
  const fev = (expression) => new Promise((res) => { const id = ++fseq; fws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) res(d.result && d.result.result ? d.result.result.value : undefined); }; fws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
  for (let i = 0; i < 40 && !(await fev(`!!(document.querySelector('pre') && document.querySelector('pre').textContent.includes('Flow is a macOS'))`)); i++) await sleep(250);
  const t0 = Date.now(), stopped = !!(await waitFor(p, still, 8000));
  R.ok('the view stops moving after the file opens', stopped, `${Date.now() - t0} ms`);
  const fsel = await fev(`(() => { const t = document.querySelector('pre').firstChild; const i = t.data.indexOf('Flow is a macOS'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 'Flow is a macOS Electron app'.length); const b = r.getClientRects()[0]; return { x0: b.left + 1, x1: b.right - 1, y: (b.top + b.bottom) / 2, iw: innerWidth }; })()`);
  const fwv = await ev(p, `(() => { const el = document.querySelector('.win[data-id="${fileWin}"]'); const v = [...el.querySelectorAll('webview')].find((x) => x.getBoundingClientRect().width > 0); const r = v.getBoundingClientRect(); const t = el.querySelector('.tb .title').getBoundingClientRect(); const c = el.querySelector('.pclip').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, tx: t.left + 30, ty: t.top + t.height / 2, cx: c.left + c.width / 2, cy: c.top + c.height / 2 }; })()`);
  await click(p, fwv.tx, fwv.ty);
  await sleep(300);
  const fk = fwv.w / fsel.iw;
  await drag(p, { x: fwv.x + fsel.x0 * fk, y: fwv.y + fsel.y * fk }, { x: fwv.x + fsel.x1 * fk, y: fwv.y + fsel.y * fk }, { steps: 12, stepMs: 15 });
  const fclip = await waitFor(p, clipShown(fileWin), 5000);
  await click(p, fclip.x, fclip.y);
  await sleep(1500);
  const fileMarks = await fev(`(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; })()`);
  fws.close();
  const fileKey = await ev(p, `FlowNotes.key(window.__flow.windows().find((w) => w.id === ${JSON.stringify(fileWin)}).url)`);
  const fileNote = await ev(p, `(window.__flow.state().pages[${JSON.stringify(fileKey)}] || {}).note`);
  R.ok('✂ on a file page puts the sentence in that file\'s own note, keyed by its path', fileKey === 'flow-file://mac/tmp/flow-dev-notes/cwd/flow/paper.txt' && fileNote === '> Flow is a macOS Electron app\n', { fileKey, fileNote });
  R.ok('the file page shows the clipped sentence marked', fileMarks === 1, { fileMarks });
  await shot(p, path.join(SHOTS, 'pages-3-file.png'));
  // the same file opened again finds its note
  const red = await ev(p, `(() => { const r = document.querySelector('.win[data-id="${fileWin}"] [data-l=close]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(p, red.x, red.y);
  await sleep(800);
  const openFile = async () => {
    const row = await ev(p, `(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => /^files\\|/.test(x.dataset.act || '') && x.textContent.trim().endsWith('paper.txt')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
    if (!row) return '';
    await click(p, row.x, row.y);
    return waitPage(p, 'paper.txt', 15000);
  };
  const again = await openFile();
  const pen2 = again ? await ev(p, `(() => { const b = document.querySelector('.win[data-id="${again}"] .tb .act'); const r = b.getBoundingClientRect(); return { on: b.classList.contains('on'), x: r.right - 8, y: r.top + r.height / 2 }; })()`) : null;
  if (pen2) { await click(p, pen2.x, pen2.y); await sleep(600); }
  const paneText = again ? await ev(p, `(() => { const e = document.querySelector('.win[data-id="${again}"] .npane .fnote-ed'); return e ? e.textContent : ''; })()`) : '';
  R.ok('the same file opened again: ✎ is bright and holds the clip', !!pen2 && pen2.on && paneText.startsWith('> Flow is a macOS Electron app'), { again, pen: pen2 && pen2.on, paneText });

  // a link to that page in a note unfolds in place: the page in brief with what was written about it, then the page
  await ev(p, 'window.__flow.go(0)');
  await sleep(1500);
  const row = await ev(p, `(() => { const r = document.querySelector('#sblist .tr[data-act="note|n-week"]').getBoundingClientRect(); return { x: r.left + 50, y: r.top + r.height / 2 }; })()`);
  await click(p, row.x, row.y);
  await sleep(700);
  await key(p, 'Enter');
  await type(p, `the paper: ${ALPHA} read it`);
  await key(p, 'Enter');
  await type(p, 'a line under it');
  await sleep(400);
  const linkAt = await ev(p, `(() => { const ed = document.querySelector('.win[data-id="w-week"] .nbody'); const t = [...ed.childNodes].find((n) => n.nodeType === 3 && n.data.includes('alphaxiv.org/abs')); const i = t.data.indexOf('alphaxiv.org/abs'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 4); const q = r.getClientRects()[0]; return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`);
  await click(p, linkAt.x, linkAt.y);
  await sleep(800);
  const l1 = await ev(p, `(() => { const x = document.querySelector('.win[data-id="w-week"] .fnote-x'); return x ? { cls: x.className, text: x.innerText } : null; })()`);
  R.ok('a click on the link in a note unfolds the page in brief, with the note written on that page', !!l1 && /l1/.test(l1.cls) && l1.text.includes('and who answers for it') && l1.text.includes('In human-AI collaborative'), l1 && l1.text.slice(0, 120));
  const body0 = await ev(p, 'window.__flow.state().ws[0].notes.find((n) => n.id === "n-week").body');
  R.ok('the note\'s text does not change', body0.endsWith(`the paper: ${ALPHA} read it\na line under it`));
  const brief = await ev(p, `(() => { const r = document.querySelector('.win[data-id="w-week"] .fnote-x .fx-brief').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; })()`);
  await click(p, brief.x, brief.y);
  await sleep(5000);
  const l2 = await ev(p, `(() => { const x = document.querySelector('.win[data-id="w-week"] .fnote-x'); return x ? { cls: x.className, live: !!x.querySelector('webview') } : null; })()`);
  R.ok('a click on the brief shows the page itself inside the note', !!l2 && /l2/.test(l2.cls) && l2.live, l2);
  await shot(p, path.join(SHOTS, 'pages-2-unfolded.png'));
  await key(p, 'Escape');
  await sleep(500);
  R.ok('Esc folds it away, live page and all', !(await ev(p, '!!document.querySelector(\'.win[data-id="w-week"] .fnote-x\')')) && (await ev(p, 'document.querySelectorAll(".fx-live webview").length')) === 0);
  await click(p, linkAt.x, linkAt.y);
  await sleep(600);

  // restart: records come back exactly as they were left, and a page opened but not written about adds none
  const plainId = await ev(p, `window.__flow.openPage('https://example.com/?flow-roundtrip=notes')`);
  const plainLoaded = await waitFor(p, `(() => { const w = window.__flow.state().ws.flatMap((x) => x.windows).find((x) => x.id === ${JSON.stringify(plainId)}); const t = w && w.tabs && w.tabs[w.tab || 0]; return !!(t && /flow-roundtrip/.test(t.url) && t.title); })()`, 20000);
  await sleep(1000);
  const pagesAtQuit = JSON.stringify((await ev(p, 'window.__flow.state()')).pages);
  p.ws.close();
  await quit();
  // the files' signing key is made anew (a lost or bad key file): file addresses change, the file's note must not
  fs.rmSync(path.join(UD, 'flow-file.key'), { force: true });
  launch(UD);
  p = await connect();
  await sleep(1500);
  st = await ev(p, 'window.__flow.state()');
  R.ok('after a restart the page records are exactly as they were at the quit, and the page opened but not written about added none', !!plainLoaded && JSON.stringify(st.pages) === pagesAtQuit && !Object.keys(st.pages).some((k) => k.includes('flow-roundtrip')), { plainId, plainLoaded });
  R.ok('after a restart: the file\'s note', ((st.pages['flow-file://mac/tmp/flow-dev-notes/cwd/flow/paper.txt'] || {}).note || '').startsWith('> Flow is a macOS Electron app'));
  await ev(p, 'window.__flow.go(4)');
  const webMarks = await marksIn('2610.09043', 20000);
  R.ok('after a restart the annotated web page shows its sentence highlighted again', webMarks === 1, { webMarks });
  await ev(p, 'window.__flow.go(0)');
  await sleep(1200);
  const rowAfter = await ev(p, `(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => /^files\\|/.test(x.dataset.act || '') && x.textContent.trim().endsWith('paper.txt')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  // close the restored window that shows the file under its old address, then open the file again: a new address
  const oldUrl = await ev(p, `(() => { const w = window.__flow.windows().find((x) => (x.url || '').includes('paper.txt')); return w ? w.url : ''; })()`);
  const oldWin = await ev(p, `(() => { const w = window.__flow.windows().find((x) => (x.url || '').includes('paper.txt')); return w ? w.id : ''; })()`);
  if (oldWin) {
    const red2 = await ev(p, `(() => { const r = document.querySelector('.win[data-id="${oldWin}"] [data-l=close]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await click(p, red2.x, red2.y);
    await sleep(800);
  }
  const rowNow = await ev(p, `(() => { const r = [...document.querySelectorAll('#sblist .tr')].find((x) => /^files\\|/.test(x.dataset.act || '') && x.textContent.trim().endsWith('paper.txt')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  let reopened = null;
  if (rowNow) {
    await click(p, rowNow.x, rowNow.y);
    for (let i = 0; i < 60 && !reopened; i++) { await sleep(250); reopened = await ev(p, `(() => { const w = window.__flow.windows().find((x) => (x.url || '').includes('paper.txt')); return w ? { id: w.id, url: w.url } : null; })()`); }
  }
  const sig = (u) => (/^flow-file:\/\/mac\/([^/]+)\//.exec(u || '') || [])[1] || '';
  const lit2 = reopened ? await ev(p, `document.querySelector('.win[data-id="${reopened.id}"] .tb .act').classList.contains('on')`) : false;
  R.ok('after the key file was made anew, the file opens under a new address and still finds its note (bright ✎)', !!reopened && sig(oldUrl) && sig(reopened.url) && sig(oldUrl) !== sig(reopened.url) && lit2, { old: sig(oldUrl), now: reopened && sig(reopened.url), lit: lit2 });
  R.ok('after a restart: the records and the annotations', !!st.pages[mckKey] && st.pages[alphaKey].note.includes('\nmy note on it') && st.pages[alphaKey].note.endsWith('> a sentence that this page does not have\nwords under it'));
  R.ok('after a restart: the link is still unfolded in brief', !!(await ev(p, '!!document.querySelector(\'.win[data-id="w-week"] .fnote-x.l1\')')));
  R.ok('the file opened again shows its sentence highlighted', (await marksIn('paper.txt', 20000)) === 1);
  // one more restart, the key file kept: the file page comes back as a tab and shows its highlight again
  const errs = p.errors.filter((e) => !e.startsWith('console.warning'));
  p.ws.close();
  await quit();
  launch(UD);
  p = await connect();
  await ev(p, 'window.__flow.go(0)');
  const fileMarksBack = await marksIn('paper.txt', 20000);
  R.ok('after a restart the file page shows its sentence highlighted again', fileMarksBack === 1, { fileMarksBack });
  errs.push(...p.errors.filter((e) => !e.startsWith('console.warning')));
  R.ok('no console errors in the app', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (err) {
  R.ok(`run stopped: ${err.message}`, false);
} finally {
  try { p.ws.close(); } catch (e) { console.error('closing CDP:', e.message); }
  if (process.env.NOTES_KEEP) console.log('NOTES_KEEP: the app is left running on 9566');
  else await cleanup();
}
R.summary();




