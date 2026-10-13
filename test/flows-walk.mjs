// flows: the owner's daily workflows end to end in flows' own app, with real input, timed, plus a check for each problem
// flows reported (K1..K7). Starts from a fresh seed every run. node test/flows-walk.mjs [label]
// Claude runs only in L.WORK (trusted through /home/claude); the trust question is never answered.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from './flows-lib.mjs';

const label = process.argv[2] || `walk-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
const T0 = Date.now();
const out = [];
const log = (...a) => { const s = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`; console.log(s); out.push(s); };
const results = [];
let page = null;
const S = {}; // ids and facts shared between steps

async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
    log(`ok   ${name} (${Date.now() - t} ms)${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    return detail;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: e.message });
    log(`FAIL ${name} (${Date.now() - t} ms): ${e.message.split('\n')[0]}`);
    if (page) { try { log('     shot', await L.shot(page, `${label}-fail-${name.replace(/\W+/g, '-')}`)); } catch (_) { /* window gone */ } }
    return null;
  }
}
const check = (name, ok, detail) => { results.push({ name, ok, ms: 0, detail, kind: 'check' }); log(`${ok ? 'ok  ' : 'BAD '} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

const ev = (expr) => L.ev(page, expr);
const ids = () => ev(`window.__flow.windows().map((w) => w.id)`);
const newWin = async (before, ms = 10000) => (await L.until(page, `window.__flow.windows().map((w) => w.id).filter((w) => !${JSON.stringify(before)}.includes(w))[0]`, ms)).v;
const text = (id, n = 40) => ev(`(() => { const t = window.__flow.term(${JSON.stringify(id)}); return t ? t.getText(${n}) : ''; })()`);
const tmuxv = (...a) => L.tmux(...a).trim();
const panePid = (id) => tmuxv('list-panes', '-t', `flow_${id}`, '-F', '#{pane_pid}');
async function rclick(x, y) {
  await L.mouse(page, 'mouseMoved', x, y);
  await L.mouse(page, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await L.mouse(page, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
  await L.sleep(450);
}
const menuItems = () => ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.innerText.replace(/\\n/g, ' '))`);
async function menuClick(re) {
  const b = await ev(`(() => { const b = [...document.querySelectorAll('.ctx button')].find((x) => ${re}.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  if (!b) throw new Error(`no menu item ${re}; menu: ${JSON.stringify(await menuItems())}`);
  await L.click(page, b.x, b.y);
}
// the dock may hide until the pointer reaches the bottom middle
async function dockButton(k) {
  const vp = await L.rect(page, '#viewport');
  await L.mouse(page, 'mouseMoved', vp.x + vp.w / 2, vp.y + vp.h - 6);
  await L.sleep(450);
  const b = await L.rect(page, `#dock button[data-k="${k}"]`);
  if (!b || b.w < 4) throw new Error(`dock button ${k} not found`);
  await L.mouse(page, 'mouseMoved', b.cx, b.cy);
  await L.sleep(250);
  return b;
}
// share of a window's rect inside the viewport (0..1)
const inView = (id) => ev(`(() => { const el = document.querySelector('.win[data-id="${id}"]'); if (!el) return -1; const r = el.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left)), h = Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top)); return +((w * h) / Math.max(1, r.width * r.height)).toFixed(2); })()`);
const geo = (id) => ev(`(() => { for (const ws of window.__flow.state().ws) { const w = [...ws.windows, ...(ws.closed || [])].find((x) => x.id === ${JSON.stringify(id)}); if (w) return { ws: ws.id, x: +(+w.x).toFixed(1), y: +(+w.y).toFixed(1), w: +(+w.w).toFixed(1), h: +(+w.h).toFixed(1), title: w.title || '', sessionId: w.sessionId, zone: w.zone || w.sub || undefined }; } return null; })()`);
// a sidebar row for a window, open or closed (data-act first, then its visible title)
async function sideRow(id, title) {
  const r = await ev(`(() => { let el = document.querySelector('#sblist [data-act="win|${id}"], #sblist [data-act="reopen|${id}"], #sblist [data-id="${id}"]'); if (!el && ${JSON.stringify(title || '')}) el = [...document.querySelectorAll('#sblist .tr')].find((x) => x.innerText.includes(${JSON.stringify(title || '')})); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  return r;
}
async function goTo(id, title) {
  const r = await sideRow(id, title);
  if (!r) throw new Error(`no sidebar row for ${id} ${title || ''}`);
  await L.click(page, r.x, r.y);
  await L.sleep(900);
}
async function waitClaude(id, ms = 60000) {
  const t = Date.now();
  const v = await L.until(page, `(() => { const h = window.__flow.term(${JSON.stringify(id)}); const t = h && h.getText(60); if (!t) return false; if (/trust this folder/.test(t)) return 'TRUST'; return /bypass permissions|for shortcuts|\\? for shortcuts|❯/.test(t) && /Claude Code|❯/.test(t) && 'ready'; })()`, ms, 200);
  if (v.v === 'TRUST') throw new Error(`${id} stopped at the folder trust question (not answered)`);
  return Date.now() - t;
}
async function prompt(id, words, want) {
  const r = await L.rect(page, `.win[data-id="${id}"] .termhost`);
  // the middle of the terminal: its bottom can sit under the dock, which model check 5.5 covers on its own
  await L.click(page, r.x + r.w / 2, r.y + r.h / 2);
  // a person's pace: keys typed at machine speed reach Claude Code as one chunk, which it reads as a paste
  for (const ch of words) { await L.key(page, ch); await L.sleep(35); }
  await L.sleep(1500);
  await L.key(page, 'Enter');
  const t = Date.now();
  const replied = `(() => { const t = window.__flow.term(${JSON.stringify(id)}).getText(80); return t.split('\\n').some((l) => /^[\\s]*[⏺●]/.test(l) && ${want}.test(l)); })()`;
  try {
    await L.until(page, replied, 8000, 300);
  } catch (e) {
    const tail = (await text(id, 80)).split('\n').filter((l) => l.trim()).slice(-4).join(' / ');
    if (tail.includes(words.slice(-12))) {
      log(`     ${id}: the first Enter became a newline in the input box; pressing Enter again`);
      await L.key(page, 'Enter');
    }
    await L.until(page, replied, 120000, 300);
  }
  return Date.now() - t;
}
async function clearSearch() {
  const q = await L.rect(page, '#q');
  if (!q) return;
  await L.click(page, q.cx, q.cy);
  await L.key(page, 'Escape');
  await L.sleep(400);
}
async function emptySpot() {
  return ev(`(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.top + 60; y < v.bottom - 140; y += 40) for (let x = v.left + 30; x < v.right - 30; x += 40) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .zl, .zone .zl, #dock, .ctx, .toast')) return { x, y }; } return null; })()`);
}
const pageTargets = async () => (await L.targets()).filter((t) => t.type === 'page' && /index\.html/.test(t.url)).map((t) => t.url.replace(/^.*index\.html/, '') || 'main');

/* ---------- prepare ---------- */
log(`flows walk ${label}; tree:`, spawnSync('sh', ['-c', 'cd ' + L.APP + ' && md5sum src/*.js src/*.css src/index.html src/flow-tmux.conf | cut -c1-8,33- | tr "\\n" " "'], { encoding: 'utf8' }).stdout);
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
const seedRun = spawnSync('node', [path.join(L.ROOT, 'test/flows-seed.mjs')], { encoding: 'utf8', cwd: L.ROOT });
log('seed:', (seedRun.stdout || '').split('\n').filter((l) => /removed|probe up/.test(l)).join(' | '), seedRun.status ? `exit ${seedRun.status} ${seedRun.stderr}` : '');

/* ---------- 1. launch ---------- */
await step('launch to ready', async () => {
  const up = await L.launch(`${label}-1`);
  page = await L.connect();
  await L.until(page, 'window.__flow && 1', 30000);
  await ev('window.__flow.ready');
  return `window ${up.ms} ms`;
});
if (!page) { console.log(out.join('\n')); process.exit(1); }
S.shot0 = await L.shot(page, `${label}-01-launch`);

/* ---------- 2. an agent with a conversation ---------- */
await step('w-design: claude ready (trusted folder)', async () => `${await waitClaude('w-design')} ms`);
await step('w-design: tiny prompt answered', async () => `${await prompt('w-design', 'Reply with exactly one word: kiwi', /[Kk]iwi/)} ms`);

/* ---------- 3. fork (K1, K5) ---------- */
await step('fork w-design from a right-click', async () => {
  const before = await ids();
  const r = await L.rect(page, '.win[data-id="w-design"] .termhost');
  await rclick(r.x + r.w / 2, r.y + r.h / 2);
  const items = await menuItems();
  const t = Date.now();
  await menuClick('/^fork/');
  S.fork1 = await newWin(before);
  const tw = Date.now() - t;
  await L.until(page, `/kiwi/i.test(window.__flow.term(${JSON.stringify(S.fork1)}).getText(80))`, 60000, 300);
  const tc = Date.now() - t;
  await L.sleep(2500);
  S.fork1View = await inView(S.fork1);
  S.parentView = await inView('w-design');
  S.fork1Geo = await geo(S.fork1);
  S.parentGeo = await geo('w-design');
  S.shotFork1 = await L.shot(page, `${label}-03-fork`);
  return { menu: items, windowMs: tw, conversationMs: tc };
});
if (S.fork1) {
  check('K1 fork lands beside its parent, both in view', S.fork1View >= 0.9 && S.parentView >= 0.5, { forkInView: S.fork1View, parentInView: S.parentView, fork: S.fork1Geo, parent: S.parentGeo, shot: S.shotFork1 });
  await L.sleep(3000);
  const pt = tmuxv('display', '-p', '-t', `flow_${S.fork1}`, '#{pane_title}').replace(/^[^\w]*\s*/, '');
  const shown = await ev(`(document.querySelector('.win[data-id="${S.fork1}"] .tb .tt') || document.querySelector('.win[data-id="${S.fork1}"] .tb .title') || {}).textContent || ''`);
  check("K5 a fork shows Claude Code's own title", !!pt && shown.includes(pt), { claude: pt, shown });
}

/* ---------- 4. several agents (K4) ---------- */
await step('two new agents from the dock', async () => {
  const res = [];
  S.agents = [];
  for (let i = 0; i < 2; i++) {
    const before = await ids();
    const view0 = await ev(`(() => { const st = window.__flow.state(); const ws = st.ws.find((w) => w.id === st.ui.at); const vw = document.getElementById('viewport').getBoundingClientRect().width; return { left: ${L.PANPX}(ws, null, 'x') / vw * 100 }; })()`);
    const s0 = await ev(L.SPACE);
    const b = await dockButton('agent');
    const t = Date.now();
    await L.click(page, b.cx, b.cy);
    const id = await newWin(before);
    const ready = await waitClaude(id);
    S.agents.push(id);
    const g = await geo(id);
    // batch 10 (lead): a dock click opens at its own size, never shrunk, so room in view is room for 36 x 44
    const rule = L.opened(id, s0, await ev(L.SPACE), 36, 44);
    res.push({ id, readyMs: Date.now() - t, geo: g, viewBefore: +view0.left.toFixed(1), inViewBefore: g.x >= view0.left - 0.5 && g.x + g.w <= view0.left + 100.5, ownSize: Math.abs(g.w - 36) < 0.05 && Math.abs(g.h - 44) < 0.05, rule });
  }
  S.agentsInfo = res;
  S.shotAgents = await L.shot(page, `${label}-04-agents`);
  return res;
});
if (S.agentsInfo) check('K4 a new agent lands at its own size in the view you were looking at, or with no room there just past the last window with the view brought to it, covering nothing', S.agentsInfo.every((a) => a.rule.ok && a.ownSize), S.agentsInfo.map((a) => ({ ready: a.readyMs, ownSize: a.ownSize, ...a.rule })));

/* ---------- 5. fork a normal-size agent: a split ---------- */
await step('fork a normal agent: split in its space', async () => {
  const id = S.agents[1];
  await prompt(id, 'Reply with exactly one word: plum', /[Pp]lum/);
  S.plumSession = (await geo(id)).sessionId;
  const g0 = await geo(id);
  const before = await ids();
  const r = await L.rect(page, `.win[data-id="${id}"] .termhost`);
  await rclick(r.x + r.w / 2, r.y + r.h / 2);
  const t = Date.now();
  await menuClick('/^fork/');
  S.fork2 = await newWin(before);
  await L.until(page, `/plum/i.test(window.__flow.term(${JSON.stringify(S.fork2)}).getText(80))`, 60000, 300);
  const g1 = await geo(id), g2 = await geo(S.fork2);
  const inside = (g) => g.x >= g0.x - 0.1 && g.y >= g0.y - 0.1 && g.x + g.w <= g0.x + g0.w + 0.1 && g.y + g.h <= g0.y + g0.h + 0.1;
  if (!inside(g1) || !inside(g2)) throw new Error(`not a split of ${JSON.stringify(g0)}: ${JSON.stringify(g1)} and ${JSON.stringify(g2)}`);
  return { ms: Date.now() - t, parent: g1, fork: g2 };
});

/* ---------- 6. end an agent, find its session again with ⌘K, open it ---------- */
await step('end the plum agent, ⌘K finds it, it resumes', async () => {
  const id = S.agents[1];
  if (!S.plumSession) throw new Error('no plum session id');
  await goTo(id);
  const red = await L.rect(page, `.win[data-id="${id}"] .tb [data-l="close"]`);
  await L.click(page, red.cx, red.cy);
  await L.sleep(600);
  const x = await ev(`(() => { const r = document.querySelector('#sblist [data-act="reopen|${id}"]'); if (!r) return null; r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const e = r.querySelector('[data-end]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!x) throw new Error('no end (×) on the closed agent row');
  await L.mouse(page, 'mouseMoved', x.x, x.y);
  await L.sleep(200);
  await L.click(page, x.x, x.y);
  // what the owner sees: the row goes and "ended ..." with undo shows; the session itself may take longer, since ending
  // waits for its claude to exit (STATUS item 31)
  const tEnd = Date.now(), seen = { rowGoneMs: null, toastMs: null, sessionGoneMs: null };
  while (Date.now() - tEnd < 30000 && (seen.rowGoneMs == null || seen.toastMs == null || seen.sessionGoneMs == null)) {
    const ui = await ev(`({ row: !!document.querySelector('#sblist [data-act="reopen|${id}"]'), toast: [...document.querySelectorAll('.toast.on')].some((t) => /ended/.test(t.innerText)) })`);
    if (seen.rowGoneMs == null && !ui.row) seen.rowGoneMs = Date.now() - tEnd;
    if (seen.toastMs == null && ui.toast) seen.toastMs = Date.now() - tEnd;
    if (seen.sessionGoneMs == null && tmuxv('has-session', '-t', `flow_${id}`).match(/can't find|no server running/) != null) seen.sessionGoneMs = Date.now() - tEnd;
    await L.sleep(100);
  }
  S.ended = seen;
  // the click shows its result at once (item 71): the row gone and "ended ... / undo" within 1.5 s
  if (seen.rowGoneMs == null || seen.rowGoneMs > 1500 || seen.toastMs == null || seen.toastMs > 1500) throw new Error(`ending did not show at once: ${JSON.stringify(seen)}`);
  if (seen.sessionGoneMs == null) throw new Error(`the session is still there 30 s after ending it: ${JSON.stringify(seen)}`);
  const t = Date.now();
  await L.key(page, 'k', L.MOD.meta);
  await L.until(page, `document.activeElement && document.activeElement.id === 'q'`, 3000);
  await L.type(page, 'one word: plum');
  // only ever click the row of the session this walk made; a person who does not see it types again
  const rowExpr = `(() => { const r = document.querySelector('#sblist .srow[data-sess="${S.plumSession}"]'); if (!r) return false; const b = r.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`;
  let row = null, retypes = 0;
  for (let i = 0; i < 8 && !row; i++) {
    try { row = await L.until(page, rowExpr, 5000, 150); } catch (e) { retypes++; await L.key(page, 'Backspace'); await L.sleep(200); await L.key(page, 'm'); }
  }
  if (!row) throw new Error(`the ended session never showed in ⌘K (typed again ${retypes} times)`);
  const found = Date.now() - t;
  S.retypes = retypes;
  const rows = await ev(`document.querySelectorAll('#sblist .srow').length`);
  const before = await ids();
  await L.click(page, row.v.x, row.v.y);
  // the session's claude can still be shutting down right after it was ended; ⌘K then says why and opens nothing,
  // and a person clicks again a moment later
  let w = null;
  const t1 = Date.now();
  try { w = await newWin(before, 4000); } catch (e) {
    S.firstClickToast = await ev(`(document.getElementById('toast') || {}).innerText || ''`);
    log('     first click opened nothing; toast:', JSON.stringify(S.firstClickToast));
    // a person waits a moment and clicks again, for up to a minute
    for (let i = 0; i < 12 && !w; i++) {
      await L.sleep(5000);
      const again = await L.until(page, rowExpr, 5000, 200).catch(() => null);
      if (again) await L.click(page, again.v.x, again.v.y);
      w = await newWin(before, 3000).catch(() => null);
    }
    S.reopenWaitMs = Date.now() - t1;
    if (!w) { await clearSearch(); throw new Error(`still not opened after ${S.reopenWaitMs} ms: ${S.firstClickToast}`); }
  }
  await L.until(page, `/plum/i.test(window.__flow.term(${JSON.stringify(w)}).getText(80))`, 60000, 300);
  S.searched = w;
  await clearSearch();
  return { ended: S.ended, foundMs: found, retypesNeeded: S.retypes, firstClickToast: S.firstClickToast || '', reopenWaitMs: S.reopenWaitMs || 0, rows, openedAndResumedMs: Date.now() - t - found, start: tmuxv('list-panes', '-t', `flow_${w}`, '-F', '#{pane_start_command}').replace(/.*claude. /, 'claude ').slice(0, 80) };
});

/* ---------- 7. move a window to another workspace ---------- */
await step('drag a terminal onto the mynotes pill', async () => {
  const id = S.fork2;
  await goTo(id);
  const pid0 = panePid(id);
  const tb = await L.rect(page, `.win[data-id="${id}"] > .tb .title`);
  const pill = await L.rect(page, '#spaces .sp[data-i="1"]');
  await L.drag(page, { x: tb.cx, y: tb.cy }, { x: pill.cx, y: pill.cy }, { steps: 20, stepMs: 15, holdMs: 200 });
  await L.sleep(800);
  const g = await geo(id);
  if (!g || g.ws !== 'mynotes') throw new Error(`not moved: ${JSON.stringify(g)}`);
  if (panePid(id) !== pid0) throw new Error('its process changed');
  return { geo: g };
});

/* ---------- 8. pop-out (K2) ---------- */
await step('pop out the flow workspace', async () => {
  const pill = await L.rect(page, '#spaces .sp[data-i="0"]');
  await L.click(page, pill.x + 8, pill.cy);
  await L.sleep(1000);
  const pop = await L.rect(page, '#spaces .sp[data-i="0"] .pop');
  if (!pop) throw new Error('no ⤢ on the flow pill');
  await L.mouse(page, 'mouseMoved', pop.cx, pop.cy);
  await L.sleep(250);
  const t = Date.now();
  await L.click(page, pop.cx, pop.cy);
  await L.until(page, 'true', 100);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { ok = (await pageTargets()).some((u) => /solo=flow$/.test(u)); if (!ok) await L.sleep(250); }
  if (!ok) throw new Error('no pop-out window');
  const ms = Date.now() - t;
  const pp = await L.connect(/index\.html#solo=flow$/);
  await L.until(pp, 'window.__flow && 1', 20000);
  await L.ev(pp, 'window.__flow.ready');
  await L.sleep(4000);
  S.popShot = await L.shot(pp, `${label}-08-popout`);
  pp.ws.close();
  S.mainAfterPop = await L.shot(page, `${label}-08-main-after-popout`);
  return `${ms} ms`;
});
{
  const lines = tmuxv('list-clients', '-F', '#{client_session} #{client_width}x#{client_height}').split('\n').filter((l) => l.startsWith('flow_w-'));
  const by = {};
  lines.forEach((l) => { const [s, sz] = l.split(' '); (by[s] = by[s] || []).push(sz); });
  const fights = Object.entries(by).filter(([, v]) => v.length > 1 && new Set(v).size > 1).map(([s, v]) => `${s} clients ${v.join(' ')} window ${tmuxv('list-windows', '-t', s, '-F', '#{window_width}x#{window_height}')}`);
  check('K2 no size fight between the main window and the pop-out', fights.length === 0, fights.length ? { fights, main: S.mainAfterPop, pop: S.popShot } : 'one size per session');
  const views = {};
  (await L.targets()).filter((x) => x.type === 'webview').forEach((x) => { const k = x.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40); views[k] = (views[k] || 0) + 1; });
  const twice = Object.entries(views).filter(([, n]) => n > 1).map(([u, n]) => `${u} x${n}`);
  check('P3/P6 a popped-out workspace runs each page once', twice.length === 0, twice.length ? twice : views);
  try { const pp = await L.connect(/index\.html#solo=flow$/); await L.ev(pp, 'setTimeout(() => window.close(), 50), 1'); pp.ws.close(); await L.sleep(1200); log('     closed the pop-out; windows:', JSON.stringify(await pageTargets())); } catch (e) { log('     could not close the pop-out:', e.message); }
}

/* ---------- 9. research: a link from a terminal, a page next to it (K7 later) ---------- */
await step('a link printed in a shell opens a page', async () => {
  const spot = await emptySpot();
  if (!spot) throw new Error('no empty spot on the desktop for a right-click');
  const before = await ids();
  await rclick(spot.x, spot.y);
  await menuClick('/new shell/');
  const sid = await newWin(before);
  S.shell = sid;
  await L.until(page, `/[%$#][\\s·.]*$/m.test(window.__flow.term(${JSON.stringify(sid)}).getText(8))`, 20000);
  await L.type(page, 'echo https://example.org/');
  await L.key(page, 'Enter');
  await L.sleep(1200);
  const pos = await ev(`(() => { const el = document.querySelector('.win[data-id="${sid}"] .xterm-screen'); const rows = document.querySelectorAll('.win[data-id="${sid}"] .xterm-rows > div'); for (let i = 0; i < rows.length; i++) { const t = rows[i].textContent; const k = t.indexOf('https://example.org/'); if (k >= 0 && !/echo/.test(t)) { const r = el.getBoundingClientRect(); const cw = r.width / window.__flow.term(${JSON.stringify(sid)}).cols; const rh = r.height / rows.length; return { x: r.left + (k + 5) * cw, y: r.top + (i + 0.5) * rh }; } } return null; })()`);
  if (!pos) throw new Error('the link is not on screen');
  const b2 = await ids();
  const tabs0 = await ev(`document.querySelectorAll('.tab, [data-tab]').length`);
  const t = Date.now();
  await L.mouse(page, 'mouseMoved', pos.x, pos.y);
  await L.sleep(250);
  await L.click(page, pos.x, pos.y);
  // a new page window, or a new tab in a page window
  const got = await L.until(page, `(() => { const n = window.__flow.windows().map((w) => w.id).filter((w) => !${JSON.stringify(b2)}.includes(w)); if (n.length) return { win: n[0] }; const tabs = document.querySelectorAll('.tab, [data-tab]').length; return tabs > ${tabs0} && { tab: tabs }; })()`, 10000);
  const pid = got.v.win || (await ev(`(() => { const w = window.__flow.windows().find((x) => x.type === 'page' && document.querySelector('.win[data-id="' + x.id + '"] .tab.on, .win[data-id="' + x.id + '"] [data-tab].on')); return w && w.id; })()`));
  await L.until(page, `(() => { const p = window.__flow.page(${JSON.stringify(pid)}); return p && !p.isLoading() && /Example Domain/.test(p.getTitle() || ''); })()`, 30000, 150);
  S.linkPage = pid;
  S.linkShot = await L.shot(page, `${label}-09-link-page`);
  return { as: got.v.win ? 'window' : 'tab', loadedMs: Date.now() - t, pageInView: await inView(pid), shellInView: await inView(sid), geo: await geo(pid), shot: S.linkShot };
});

/* ---------- 10. a workspace for a project (K6) ---------- */
await step('a new workspace for a project', async () => {
  // point at + first: a hovered pill shows its ⤢, so + moves once the pointer leaves the pill
  const p0 = await L.rect(page, '#addws');
  if (!p0) throw new Error('no + for a new workspace');
  await L.mouse(page, 'mouseMoved', p0.cx, p0.cy);
  await L.sleep(300);
  const plus = await L.rect(page, '#addws');
  const t = Date.now();
  await L.click(page, plus.cx, plus.cy);
  await L.sleep(500);
  // named like a folder in the home folder (wsbg.js folderFor: ~/ccm, the owner's own project), it picks that folder up
  await L.type(page, 'ccm');
  await L.key(page, 'Enter');
  await L.until(page, `(() => { const st = window.__flow.state(); return st.ws[st.ws.length - 1].folder !== '~'; })()`, 8000).catch(() => null);
  const ws = await ev(`(() => { const st = window.__flow.state(); const w = st.ws[st.ws.length - 1]; return { name: w.name, folder: w.folder, windows: w.windows.map((x) => x.type) }; })()`);
  S.newwsShot = await L.shot(page, `${label}-10-new-workspace`);
  // where a terminal here starts: a plain shell, never claude, so nothing runs in the home folder
  const spot = await emptySpot();
  const before = await ids();
  await rclick(spot.x, spot.y);
  await menuClick('/new shell/');
  const sid = await newWin(before);
  await L.until(page, `/[%$#][\\s·.]*$/m.test(window.__flow.term(${JSON.stringify(sid)}).getText(8))`, 20000);
  await L.type(page, 'pwd');
  await L.key(page, 'Enter');
  await L.sleep(800);
  S.newwsPwd = (await text(sid, 6)).split('\n').find((l) => l.startsWith('/')) || '';
  return { ms: Date.now() - t, ws, pwd: S.newwsPwd };
});
check('K6 a new workspace named like a folder in the home folder starts its terminals there', S.newwsPwd === '/home/claude/ccm', { pwd: S.newwsPwd, shot: S.newwsShot });

/* ---------- 11. the link page closed: does it linger (K7) ---------- */
await step('close the link page', async () => {
  const pill = await L.rect(page, '#spaces .sp[data-i="0"]');
  await L.click(page, pill.x + 8, pill.cy);
  await L.sleep(1000);
  await goTo(S.linkPage, 'Example Domain');
  const red = await L.rect(page, `.win[data-id="${S.linkPage}"] .tb [data-l="close"]`);
  await L.click(page, red.cx, red.cy);
  await L.sleep(700);
  S.lingers = await ev(`[...document.querySelectorAll('#sblist .tr')].filter((x) => x.innerText.includes('Example Domain')).map((x) => x.innerText.replace(/\\n/g, ' | ') + (x.classList.contains('dim') ? ' (dim)' : ''))`);
  return S.lingers;
});
check('K7 a closed page does not linger as a row', Array.isArray(S.lingers) && S.lingers.length === 0, S.lingers);

/* ---------- 12. quit and come back (K3), crash, reboot ---------- */
const sessions = () => Object.fromEntries(tmuxv('list-panes', '-a', '-F', '#{session_name} #{pane_pid}').split('\n').filter((l) => l.startsWith('flow_')).map((l) => l.split(' ')));
async function relaunch(how) {
  const before = { panes: sessions(), targets: await pageTargets() };
  page.ws.close();
  page = null;
  log(await L.stop({ kill9: how === 'crash' }));
  if (how === 'reboot') log('tmux:', L.tmux('kill-server') || 'killed');
  await L.sleep(1200);
  const t = Date.now();
  const up = await L.launch(`${label}-${how}`);
  page = await L.connect();
  await L.until(page, 'window.__flow && 1', 30000);
  await ev('window.__flow.ready');
  const ready = Date.now() - t;
  const vis = await ev(`window.__flow.windows().filter((w) => w.visible && (w.type === 'term' || w.type === 'team')).map((w) => w.id)`);
  await L.until(page, `${JSON.stringify(vis)}.every((id) => { const t = window.__flow.term(id); return t && t.getText(30).trim(); })`, 60000, 200);
  const drawn = Date.now() - t;
  await L.sleep(2500);
  const after = { panes: sessions(), targets: await pageTargets() };
  const kept = Object.keys(before.panes).filter((k) => after.panes[k] === before.panes[k]).length;
  return { windowMs: up.ms, readyMs: ready, drawnMs: drawn, sessionsKept: `${kept} of ${Object.keys(before.panes).length}`, targetsBefore: before.targets, targetsAfter: after.targets };
}
await step('quit and relaunch (a pop-out open)', async () => {
  const pill = await L.rect(page, '#spaces .sp[data-i="0"]');
  await L.click(page, pill.x + 8, pill.cy);
  await L.sleep(800);
  const pop = await L.rect(page, '#spaces .sp[data-i="0"] .pop');
  if (pop) { await L.mouse(page, 'mouseMoved', pop.cx, pop.cy); await L.sleep(250); await L.click(page, pop.cx, pop.cy); }
  for (let i = 0; i < 40 && !(await pageTargets()).some((u) => /solo=flow$/.test(u)); i++) await L.sleep(250);
  await L.sleep(1500);
  const r = await relaunch('quit');
  S.quit = r;
  return r;
});
if (S.quit) check('K3 pop-outs come back after a restart', S.quit.targetsAfter.some((u) => /solo=flow/.test(u)), { before: S.quit.targetsBefore, after: S.quit.targetsAfter });
// the rest types and reads in the main window, so flow comes back to it (a popped-out space lives only in its pop-out)
try { const pp = await L.connect(/index\.html#solo=flow$/); await L.ev(pp, 'setTimeout(() => window.close(), 50), 1'); pp.ws.close(); await L.sleep(1500); log('     closed the pop-out; windows:', JSON.stringify(await pageTargets())); } catch (e) { log('     no pop-out to close:', e.message); }
await step('crash 1 s after typing in a note, relaunch', async () => {
  await goTo('w-week', 'this week');
  const r = (await L.rect(page, '.win[data-id="w-week"] .nbody')) || (await ev(`(() => { const all = document.querySelectorAll('.win[data-id="w-week"] [contenteditable]'); const el = all[all.length - 1]; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`));
  if (!r) throw new Error('the this-week note is not open');
  await L.click(page, r.x + r.w - 10, r.y + r.h - 10);
  await L.key(page, 'End', L.MOD.ctrl);
  await L.type(page, ' back tomorrow: check the fork.');
  await L.sleep(1000);
  const x = await relaunch('crash');
  const body = await ev(`(window.__flow.state().ws[0].notes.find((n) => n.id === 'n-week') || {}).body || ''`);
  if (!body.includes('back tomorrow: check the fork.')) throw new Error(`the note lost the text: ${JSON.stringify(body.slice(-60))}`);
  return x;
});
await step('reboot (tmux gone): agents resume their conversations', async () => {
  const x = await relaunch('reboot');
  await L.sleep(6000);
  const conv = {};
  for (const [id, re] of [['w-design', /kiwi/i], [S.fork1, /kiwi/i], [S.searched, /plum/i]]) {
    if (!id) continue;
    const t = await text(id, 80);
    conv[id] = re.test(t) ? 'conversation back' : /trust this folder/.test(t) ? 'TRUST QUESTION' : `missing: ${t.split('\n').filter((l) => l.trim()).slice(-3).join(' / ')}`;
  }
  if (Object.values(conv).some((v) => v !== 'conversation back')) throw new Error(JSON.stringify(conv));
  return { ...x, conv };
});
S.shotEnd = page ? await L.shot(page, `${label}-12-after-reboot`) : null;

/* ---------- done ---------- */
if (page) { const errs = page.errors.filter((e) => !/favicon|ERR_ABORTED/.test(e)); if (errs.length) log('page errors:', errs.slice(0, 8).join(' | ')); page.ws.close(); }
log(await L.stop());
log('tmux:', L.tmux('kill-server') || 'killed');
const bad = results.filter((r) => !r.ok);
log(`summary: ${results.filter((r) => r.ok).length} ok, ${bad.length} not: ${bad.map((r) => r.name).join('; ')}`);
// anything not ok fails the run
process.exitCode = results.length > 0 && bad.length === 0 ? 0 : 1;
fs.writeFileSync(path.join(L.EVID, `${label}.log`), out.join('\n') + '\n');
fs.writeFileSync(path.join(L.EVID, `${label}.json`), JSON.stringify(results, null, 1));
console.log('log:', path.join(L.EVID, `${label}.log`));




