// sidebar's B1 check: ⌘K and the sidebar never open a second copy of a conversation that is running right now.
// Makes its own session (claude -p "/cost" --session-id <uuid>: local, no tokens, a real transcript) in
// /tmp/flow-dev-sidebar/b1, runs it in a tmux session of its own on flow-dev-sidebar, and drives the dev app on 9574
// (test/sidebar-dev.sh start --fresh) with real input. Never touches a session it did not make.
//   node test/sidebar-b1.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { connectTo, evaluate, size, sleep, click, dblclick, mouse, key, type, MOD, reporter } from './ui-lib.mjs';

const R = reporter();
const CWD = '/tmp/flow-dev-sidebar/b1';
const SOCK = 'flow-dev-sidebar';
const tmux = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasTmux = (name) => { try { tmux('has-session', '-t', name); return true; } catch { return false; } };
fs.mkdirSync(CWD, { recursive: true });
const id = crypto.randomUUID();
execFileSync('claude', ['-p', '/cost', '--session-id', id], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });

const page = await connectTo(9574, /\/src\/index\.html$/);
await size(page, 1500, 913);
for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
await evaluate(page, 'window.__flow.ready');
const ev = (expr) => evaluate(page, expr);
const rect = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
/* A window's control once the window stops moving (its opening animation): the same spot twice in a row. */
async function settled(sel) {
  let r = null, last = null;
  for (let i = 0; i < 40; i++) {
    r = await rect(sel);
    if (r && last && r.cx === last.cx && r.cy === last.cy) return r;
    last = r;
    await sleep(120);
  }
  return r;
}
/* Whether a window holds the keys: the element with focus is inside it (never true while nothing has focus). */
const hasKeys = (wid) => ev(`(() => { const w = document.querySelector('.win[data-id="${wid}"]'); const a = document.activeElement; return !!w && !!a && a !== document.body && w.contains(a); })()`);
const toastText = () => ev(`(() => { const t = document.getElementById('toast'); return t.classList.contains('on') ? t.textContent : ''; })()`);
const windowsWith = () => ev(`__flow.state().ws.flatMap((w) => [...w.windows, ...w.closed]).filter((w) => w.sessionId === ${JSON.stringify(id)}).map((w) => w.id)`);
const rowSel = `#sblist .srow[data-sess="${id}"]`;
async function search() {
  const q = await rect('#q');
  await click(page, q.cx, q.cy);
  await key(page, 'a', MOD.ctrl);
  await key(page, 'Backspace');
  await type(page, id.slice(0, 13));
  for (let i = 0; i < 60; i++) {
    const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel)}); return r ? { text: r.textContent, drag: r.draggable } : null; })()`);
    if (r) return r;
    await sleep(250);
  }
  return null;
}
let menuGrey = {};
async function rightClickRow() {
  const r = await rect(rowSel);
  await mouse(page, 'mouseMoved', r.cx, r.cy);
  await mouse(page, 'mousePressed', r.cx, r.cy, { button: 'right', buttons: 2 });
  await mouse(page, 'mouseReleased', r.cx, r.cy, { button: 'right', buttons: 2 });
  await sleep(300);
  const items = await ev(`[...document.querySelectorAll('.ctx button')].map((b) => b.firstChild.textContent)`);
  menuGrey = await ev(`Object.fromEntries([...document.querySelectorAll('.ctx button')].map((b) => [b.firstChild.textContent, (b.querySelector('.k') || {}).textContent || '']))`);
  await key(page, 'Escape');
  await sleep(200);
  return items;
}

try {
  await ev('(() => { __flow.go(0); return true; })()');
  await sleep(500);
  // running somewhere else: a tmux session of this test's own, not a Flow window
  tmux('new-session', '-d', '-s', 'b1-elsewhere', '-c', CWD, `claude --resume ${id}`);
  for (let i = 0; i < 40 && !(await ev(`flow.sessions.running().then((l) => l.some((x) => x.id === ${JSON.stringify(id)}))`)); i++) await sleep(250);
  let row = await search();
  R.ok('⌘K finds the session by the start of its id', !!row, row);
  R.ok('its row says where it runs, and it cannot be dragged out', !!row && row.text.includes('running in tmux session b1-elsewhere') && row.drag === false, row);
  const before = await windowsWith();
  const r1 = await rect(rowSel);
  await click(page, r1.cx, r1.cy);
  let t1 = '';
  for (let i = 0; i < 60 && !/so it is not opened again/.test(t1 = await toastText()); i++) await sleep(100);
  R.ok('clicking it opens nothing and says where it is running, with no how-to tail', (await windowsWith()).length === before.length && /already running in tmux session b1-elsewhere, so it is not opened again/.test(t1) && !/right-click/.test(t1), { t1, windows: await windowsWith() });
  const items = await rightClickRow();
  R.ok('its menu has no "open here", and keeps fork and copy resume command', !items.includes('open here') && items.includes('fork here') && items.includes('copy resume command'), items);
  R.ok('"fork here" has no grey text beside it', menuGrey['fork here'] === '', menuGrey);

  // not running any more: it opens here, once
  tmux('kill-session', '-t', 'b1-elsewhere');
  for (let i = 0; i < 40 && (await ev(`flow.sessions.running().then((l) => l.some((x) => x.id === ${JSON.stringify(id)}))`)); i++) await sleep(250);
  /* search results mark running sessions from a list up to 3 s old (sessions.js RUNNING_TTL); a search after that
     must not say running any more */
  for (let i = 0; i < 6 && (row = await search()) && row.text.includes('running in'); i++) await sleep(1000);
  R.ok('once it stops, the row no longer says running', !!row && !row.text.includes('running in'), row);
  const r2 = await rect(rowSel);
  /* clicked twice in quick succession, as an impatient owner does: one window, one claude */
  /* a double-click whose second click comes once the first has opened it and the search has cleared (about 250 ms, inside
     a double-click's time): the second click lands on whatever row is there now, and must do nothing */
  await mouse(page, 'mouseMoved', r2.cx, r2.cy);
  await mouse(page, 'mousePressed', r2.cx, r2.cy, { clickCount: 1 });
  await mouse(page, 'mouseReleased', r2.cx, r2.cy, { clickCount: 1 });
  await sleep(250);
  await mouse(page, 'mousePressed', r2.cx, r2.cy, { clickCount: 2 });
  await mouse(page, 'mouseReleased', r2.cx, r2.cy, { clickCount: 2 });
  /* the open asks whether it runs right before resuming, which takes a ps call */
  let opened = [];
  for (let i = 0; i < 50 && !(opened = await windowsWith()).length; i++) await sleep(100);
  await sleep(2500);
  opened = await windowsWith();
  R.ok('clicking it now resumes it in a new window here, and a second quick click opens no second one', opened.length === 1, { opened, toast: await toastText() });
  let keys1 = false;
  for (let i = 0; i < 40 && opened.length && !(keys1 = await hasKeys(opened[0])); i++) await sleep(150);
  R.ok('and that window has the keys, ready to type', keys1, await ev(`(document.activeElement && (document.activeElement.className || document.activeElement.tagName)) + ''`));
  const ow = opened.length === 1 && (await ev(`__flow.state().ws.flatMap((w) => w.windows).find((w) => w.id === ${JSON.stringify(opened[0])})`));
  R.ok('…and its title follows Claude: nothing fixed in w.title, the session\'s title as w.label until Claude sets its own', !!ow && ow.title === '' && ow.label === '/cost', ow && { title: ow.title, label: ow.label });
  const wid = opened[0];

  // a closed agent's row brings its window back at once (installed, batch 10); while its conversation runs elsewhere, pty
  // starts no second claude, and the window says where it runs and opens it by itself once it is free
  const holdersOf = () => ev(`flow.sessions.running().then((l) => l.filter((x) => x.id === ${JSON.stringify(id)}).map((x) => ({ pid: x.pid, flowWindow: x.flowWindow || null })))`);
  if (R.ok('the conversation\'s window is there for the closed-agent checks', !!wid)) {
    const red = await settled(`.win[data-id="${wid}"] [data-l=close]`);
    await click(page, red.cx, red.cy);
    await sleep(500);
    for (let i = 0; i < 40 && hasTmux(`flow_${wid}`); i++) { if (i === 0) tmux('kill-session', '-t', `flow_${wid}`); await sleep(250); }
    tmux('new-session', '-d', '-s', 'b1-elsewhere2', '-c', CWD, `claude --resume ${id}`);
    /* claude takes a while to start under load: the case is only there once Flow can see it running */
    let elsewhere = false;
    for (let i = 0; i < 240 && !(elsewhere = await ev(`flow.sessions.running().then((l) => l.some((x) => x.id === ${JSON.stringify(id)}))`)); i++) await sleep(250);
    const qr = await rect('#q');
    await click(page, qr.cx, qr.cy);
    await key(page, 'Escape');
    await sleep(400);
    const cr = await rect(`#sblist .tr[data-act="reopen|${wid}"]`);
    if (R.ok('the closed agent has its row', !!cr)) {
      const t0 = Date.now();
      await click(page, cr.cx, cr.cy);
      let back = false;
      for (let i = 0; i < 100 && !(back = await ev(`__flow.windows().some((w) => w.id === ${JSON.stringify(wid)})`)); i++) await sleep(50);
      const ms = Date.now() - t0;
      let said = '';
      /* pty's reason: the other claude runs on Flow's own tmux server here (this suite's tmux -L), so "another Flow window";
         one in the owner's own terminal reads "a Claude outside Flow" */
      const where = /this conversation is open in (another Flow window|a Claude outside Flow)/;
      for (let i = 0; i < 60 && !where.test(said); i++) { said = await ev(`(() => { const t = __flow.term(${JSON.stringify(wid)}); return t && t.getText ? t.getText(40) : ''; })()`); if (!where.test(said)) await sleep(250); }
      const held = await holdersOf();
      R.ok('clicking it while the conversation runs elsewhere brings its window back at once; it says where the conversation is open, and no second claude starts', elsewhere === true && back === true && ms < 2500 && where.test(said) && held.length === 1 && held[0].flowWindow !== wid, { elsewhere, back, ms, said: said.slice(-160), held });
    }
  }
  // once the other claude stops, the window that waited opens the conversation by itself
  for (const n of ['b1-elsewhere', 'b1-elsewhere2']) if (hasTmux(n)) tmux('kill-session', '-t', n);
  let reopened = false;
  for (let i = 0; i < 240 && !(reopened = !!wid && (await holdersOf()).some((h) => h.flowWindow === wid)); i++) await sleep(250);
  if (R.ok('with nothing running it any more, the window that waited opens the conversation by itself', reopened)) {
    const pen = await settled(`.win[data-id="${wid}"] .tb .act`);
    await click(page, pen.cx, pen.cy);
    await sleep(500);
    await type(page, 'remember the b1 note');
    await sleep(500);
    const red2 = await settled(`.win[data-id="${wid}"] [data-l=close]`);
    await click(page, red2.cx, red2.cy);
    await sleep(500);
    const end = await rect(`#sblist .tr[data-act="reopen|${wid}"] [data-end]`);
    if (end) await click(page, end.cx, end.cy);
    /* right away, while the ended claude may still be exiting: ⌘K opens its window at once, and its claude starts once
       the old one has gone (item 31; main leaves out a claude Flow has just ended, and pty starts the new one after) */
    row = await search();
    const r4 = row && (await rect(rowSel));
    const t0 = Date.now();
    if (r4) await click(page, r4.cx, r4.cy);
    let w3 = null;
    for (let i = 0; i < 100 && !(w3 = await ev(`__flow.state().ws.flatMap((w) => w.windows).find((w) => w.sessionId === ${JSON.stringify(id)}) || null`)); i++) await sleep(50);
    const ms = Date.now() - t0;
    R.ok('right after the agent ends, ⌘K opens its window at once, with no toast', !!w3 && ms < 2500 && !/running/.test(await toastText()), { ms, toast: await toastText() });
    let keys3 = false;
    for (let i = 0; i < 40 && w3 && !(keys3 = await hasKeys(w3.id)); i++) await sleep(150);
    R.ok('and the reopened window has the keys, ready to type', keys3, await ev(`(document.activeElement && (document.activeElement.className || document.activeElement.tagName)) + ''`));
    R.ok('an agent ended with a note gets it back when ⌘K opens its conversation', !!w3 && w3.id !== wid && w3.note === 'remember the b1 note' && w3.noted === true, w3 && { id: w3.id, note: w3.note, noted: w3.noted });
    let live = null;
    for (let i = 0; i < 160 && w3 && !(live = await ev(`flow.sessions.running().then((l) => l.find((x) => x.id === ${JSON.stringify(id)} && x.flowWindow === ${JSON.stringify(w3 && w3.id)}) || null)`)); i++) await sleep(250);
    R.ok('and its claude starts in that window once the old one has gone', !!live, { live, after: `${Math.round((Date.now() - t0) / 1000)} s` });
    /* one claude holds the conversation: no second one shows up while the first runs */
    const holders = async () => ev(`flow.sessions.running().then((l) => l.filter((x) => x.id === ${JSON.stringify(id)}).map((x) => ({ pid: x.pid, flowWindow: x.flowWindow })))`);
    let h1 = await holders();
    await sleep(3000);
    let h2 = await holders();
    R.ok('one claude holds the conversation', h1.length === 1 && h2.length === 1 && h1[0].pid === h2[0].pid, { h1, h2 });
    /* undo then reopen: end it, take the end back from the toast, and reopen it from its row: one window, one claude */
    if (R.ok('the reopened window is there for undo then reopen', !!w3)) {
      const before = await holders();
      const red3 = await settled(`.win[data-id="${w3.id}"] [data-l=close]`);
      await click(page, red3.cx, red3.cy);
      await sleep(500);
      const end3 = await rect(`#sblist .tr[data-act="reopen|${w3.id}"] [data-end]`);
      if (end3) await click(page, end3.cx, end3.cy);
      let undo = null;
      for (let i = 0; i < 40 && !(undo = await rect('#toast.on button')); i++) await sleep(100);
      if (undo) await click(page, undo.cx, undo.cy);
      let row3 = null;
      for (let i = 0; i < 40 && !(row3 = await rect(`#sblist .tr[data-act="reopen|${w3.id}"]`)); i++) await sleep(100);
      const t3 = Date.now();
      if (row3) await click(page, row3.cx, row3.cy);
      let back3 = false;
      for (let i = 0; i < 100 && !(back3 = await ev(`__flow.windows().some((w) => w.id === ${JSON.stringify(w3.id)})`)); i++) await sleep(50);
      const ms3 = Date.now() - t3;
      /* the new claude starts once the ended one has gone, which under load takes seconds: wait for it, then for it to stay */
      let h3 = [];
      for (let i = 0; i < 120 && !((h3 = await holders()).length === 1 && !before.some((b) => b.pid === h3[0].pid)); i++) await sleep(250);
      await sleep(3000);
      const h4 = await holders();
      const wins = await ev(`__flow.state().ws.flatMap((w) => w.windows).filter((w) => w.sessionId === ${JSON.stringify(id)}).map((w) => w.id)`);
      R.ok('undo then reopen: its window is back at once, and one claude in one window holds the conversation', !!undo && back3 && ms3 < 2500 && h3.length === 1 && !before.some((b) => b.pid === h3[0].pid) && h3[0].flowWindow === w3.id && h4.length === 1 && h4[0].pid === h3[0].pid && wins.length === 1, { undo: !!undo, ms: ms3, before, holders: h3, after3s: h4, windows: wins });
    }
  }
  R.ok('no console errors or exceptions', page.errors.length === 0, page.errors.slice(0, 5));
} finally {
  for (const s of ['b1-elsewhere', 'b1-elsewhere2']) if (hasTmux(s)) tmux('kill-session', '-t', s);
  page.ws.close();
}
R.summary();




