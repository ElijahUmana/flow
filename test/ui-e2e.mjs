// ui's end-to-end check of every mockup interaction in the real app, driven with real input events over CDP.
// Usage: test/ui-dev.sh start --fresh && node test/ui-e2e.mjs [--only a,b] [--mock] [--any-state]
//   --mock also drives the approved mockup (start it with test/ui-dev.sh start --fresh --mock).
//   Another owner, in isolation: UI_ROLE=<role> UI_PORT=<port> test/ui-dev.sh start --fresh, then the same env for this
//   script (socket flow-dev-<role>-e2e, /tmp/flow-dev-<role>-e2e, shots in /tmp/flow-<role>-e2e-shots; test/ui-env.mjs).
//   node test/ui-e2e.mjs [--only name,name] [--no-mock]
// Screenshot pairs go to test/ui-shots/NN-name-app.png and NN-name-mockup.png.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectTo, evaluate, size, shot, sleep, click, dblclick, drag, mouse, wheel, swipe, key, type, MOD, reporter } from './ui-lib.mjs';

import { PORT, MOCK_PORT, SOCK, LOGS, SHOTS, CWD, INSPECT } from './ui-env.mjs';
const W = 1500, H = 913;
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const noMock = !args.includes('--mock');
const R = reporter();

/* tmux on ui's socket: its output, or null when what it names is not there (no server, session, window or pane).
   Anything else tmux reports is an error, so a broken tmux cannot pass for a session that has ended. */
const NOT_THERE = /no server running|can't find (session|window|pane)|error connecting to .*\(No such file or directory\)/;
const tmux = (...a) => {
  try { return execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (err) {
    if (err.status === 1 && NOT_THERE.test(String(err.stderr))) return null;
    throw new Error(`tmux ${a.join(' ')}: ${String(err.stderr || err.message).trim()}`);
  }
};
/* the command a window's tmux session started with; under load the session comes up a while after its window */
async function paneCmd(wid, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const c = tmux('list-panes', '-t', `flow_${wid}`, '-F', '#{pane_start_command}');
    if (c) return c;
  }
  return tmux('list-panes', '-t', `flow_${wid}`, '-F', '#{pane_start_command}') || '';
}
const hasSession = (id) => tmux('has-session', '-t', `flow_${id}`) !== null;
/* Claude Code takes over 20 s to start on this machine when it is loaded (load average 90 on 16 cores, Nov 1 22:05) */
const CLAUDE_START_MS = 60000;
/* Ending a session is asynchronous (the app asks main to kill it): true once it is gone, within ms. */
async function sessionGone(id, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (!hasSession(id)) return true;
  return !hasSession(id);
}
const clients = (id) => (tmux('list-clients', '-t', `flow_${id}`) || '').split('\n').filter(Boolean).length;

/* In-page helpers, the same in the app and the mockup: windows are found by data-id (app) or by title text. */
const HELPERS = `window.__ui = {
  r(el) { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; },
  win(m) {
    const all = [...document.querySelectorAll('.win')].filter((w) => getComputedStyle(w).display !== 'none');
    const title = (w) => { const t = w.querySelector(':scope > .tb .title'); return t ? t.textContent.trim() : ''; };
    return document.querySelector('.win[data-id="' + m + '"]') || all.find((w) => title(w) === m) || all.find((w) => title(w).includes(m));
  },
  parts(m) {
    const w = this.win(m); if (!w) return null;
    const q = (s) => this.r(w.querySelector(s));
    return { win: this.r(w), tb: q(':scope > .tb'), close: q(':scope > .tb [data-l=close]'), park: q(':scope > .tb [data-l=park]'), max: q(':scope > .tb [data-l=max]'),
      rz: q(':scope > .rz'), act: q(':scope > .tb .act'), noted: w.classList.contains('noted'), front: w.classList.contains('front') };
  },
  pill(i) { const p = document.querySelectorAll('.sp')[i]; return this.r((p && p.querySelector('.sn')) || p); },
  active() { const p = [...document.querySelectorAll('.sp')]; return p.findIndex((x) => x.classList.contains('on')); },
  toast() { const t = document.getElementById('toast'); return t.classList.contains('on') ? t.textContent : ''; },
  /* the real clipboard (this display's own); cleared before a copy so an old value cannot pass */
  clip() { return navigator.clipboard.readText(); },
  clearClip() { return navigator.clipboard.writeText(''); },
  row(act) { return this.r(document.querySelector('.tr[data-act="' + act + '"]')); },
  rowText(act) { const r = document.querySelector('.tr[data-act="' + act + '"]'); return r ? r.textContent : null; },
};`;

async function setup(page) {
  await size(page, W, H);
  await evaluate(page, HELPERS);
  if (await evaluate(page, 'document.getElementById("sb").classList.contains("hide")')) {
    const ex = await evaluate(page, '__ui.r(document.getElementById("expand"))');
    await click(page, ex.cx, ex.cy);
    await sleep(500);
  }
}
const ui = (page, expr) => evaluate(page, `(() => { ${expr} })()`);
const parts = (page, m) => evaluate(page, `__ui.parts(${JSON.stringify(m)})`);
const st = (page) => evaluate(page, '__flow.state()');
const wsOf = (s, id) => s.ws.find((w) => w.id === id);
const winIn = (s, wid) => { for (const ws of s.ws) { const w = ws.windows.find((x) => x.id === wid); if (w) return { ws, w }; } return null; };
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const grabPoint = (p) => ({ x: p.tb.x + p.tb.w * 0.3, y: p.tb.cy });

async function pair(ctx, name, mockPage) {
  await shot(ctx.app, path.join(SHOTS, `${name}-app.png`));
  if (ctx.mock && mockPage !== false) await shot(ctx.mock, path.join(SHOTS, `${name}-mockup.png`));
}
/* An empty spot of the desktop: under the pills row, above the windows (the layout starts at 6.6% of the height). */
/* A point on the empty desktop at the top of the view: the middle unless a window or a toast (an undo stays 8 s) is there. */
const emptySpot = (page) => evaluate(page, `(() => {
  const v = document.getElementById('viewport').getBoundingClientRect(), y = v.top + 45;
  for (const f of [0.5, 0.2, 0.8, 0.35, 0.65]) {
    const x = v.left + v.width * f, hit = document.elementFromPoint(x, y);
    if (hit && !hit.closest('.win, .toast, .ctx, #dock')) return { x, y };
  }
  return { x: v.left + v.width * 0.5, y };
})()`);
/* Drags the empty desktop across the whole view, inside it (a release outside the window can be lost), three times:
   'start' pans back to the left end, 'end' to the right end. */
async function panTo(page, where) {
  const v = await evaluate(page, '__ui.r(document.getElementById("viewport"))');
  const y = v.y + 45, a = v.x + 30, b = v.x + v.w - 30;
  for (let i = 0; i < 3; i++) await drag(page, { x: where === 'start' ? a : b, y }, { x: where === 'start' ? b : a, y }, { holdMs: 120 });
  await sleep(500);
}
/* Mouse moves reach the page at its next frame; on a loaded machine that can be after the CDP call answers. */
const frames = (page) => evaluate(page, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
/* The dock comes up from the strip at the very bottom, then the pointer goes up to the button in small steps, as a hand
   does: dock.js stops taking clicks when one big step up looks like the pointer leaving. */
async function dockClick(page, k) {
  const v = await evaluate(page, '__ui.r(document.getElementById("viewport"))');
  const b = await evaluate(page, `__ui.r(document.querySelector('#dock [data-k="${k}"]'))`);
  const from = v.y + v.h - 3;
  await mouse(page, 'mouseMoved', b.cx, from);
  await sleep(300);
  await waitFor(page, `(() => { const d = document.getElementById('dock'); return getComputedStyle(d).visibility !== 'hidden' && d.style.opacity !== '0'; })()`, 3000, 100);
  for (let y = from - 3; y > b.cy; y -= 3) await mouse(page, 'mouseMoved', b.cx, y);
  await click(page, b.cx, b.cy);
}
async function blur(page) {
  const p = await emptySpot(page);
  await click(page, p.x, p.y);
}
async function goPill(page, i) {
  if (await evaluate(page, '!!(document.getElementById("q") && document.getElementById("q").value)')) {
    const qr = await evaluate(page, '__ui.r(document.getElementById("q"))');
    await click(page, qr.cx, qr.cy);
    await key(page, 'Escape');
    await sleep(200);
  }
  const p = await evaluate(page, `__ui.pill(${i})`);
  await click(page, p.cx, p.cy);
  await sleep(300);
  // the workspaces slide; on a loaded machine the slide outlasts any fixed wait, so wait until this one has arrived
  await waitFor(page, `(() => { const v = document.getElementById('viewport').getBoundingClientRect(); const s = document.querySelectorAll('.ws')[${i}]; return !s || Math.abs(s.getBoundingClientRect().left - v.left) < 2; })()`, 10000, 100);
  await sleep(150);
  // going back from a sub-workspace slides that workspace's canvas too: wait until it has stopped
  for (let k = 0, last = null; k < 30; k++) {
    const t = await evaluate(page, `(() => { const s = document.querySelectorAll('.ws')[${i}]; const c = s && s.querySelector('.canvas'); return c ? getComputedStyle(c).transform + ' ' + c.getBoundingClientRect().left : ''; })()`);
    if (t === last) break;
    last = t;
    await sleep(100);
  }
}
/* An expression in a page's own document (its <webview> target), by its address; undefined when no page has it. */
async function guestEval(re, expr) {
  const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'webview' && re.test(x.url));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`cannot open ${t.url}`)); });
  const v = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : undefined); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  return v;
}
async function waitFor(page, expr, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await evaluate(page, expr);
    if (v) return v;
    await sleep(step);
  }
  return v;
}

const SCEN = [];
const scenario = (name, fn) => SCEN.push({ name, fn });

/* ---------------------------------------------------------------- */
scenario('start', async (ctx) => {
  const { app } = ctx;
  const info = await ui(app, `return { pills: document.querySelectorAll('.sp').length, groups: [...document.querySelectorAll('#sblist .grp')].map((g) => g.textContent),
    dock: [...document.querySelectorAll('#dock button')].map((b) => b.dataset.k), flow: !!window.__flow, active: __ui.active() };`);
  R.ok('5 workspace pills', info.pills === 5, info.pills);
  R.ok('sidebar groups: agents, notes, browser, files, sub-workspaces', JSON.stringify(info.groups) === JSON.stringify(['agents', 'notes', 'browser', 'files', 'sub-workspaces']), info.groups);
  R.ok('title bars: no "this Mac" (the where shows only for a window on another host)', await evaluate(app, '![...document.querySelectorAll(".win .tb .where")].some((e) => /this Mac/.test(e.textContent))'));
  R.ok('dock: agent, team, note, page, sub-workspace', JSON.stringify(info.dock) === JSON.stringify(['agent', 'team', 'note', 'page', 'zone']), info.dock);
  const menuHook = await evaluate(app, '(() => { const a = __flow.menu("next-ws"), i1 = __ui.active(); const b = __flow.menu("prev-ws"), i0 = __ui.active(); return { a, i1, b, i0, none: __flow.menu("no-such-action") }; })()');
  R.ok('__flow.menu runs a native menu action (next-ws, prev-ws) and says false for an unknown one', menuHook.a && menuHook.i1 === 1 && menuHook.b && menuHook.i0 === 0 && menuHook.none === false, menuHook);
  await pair(ctx, '01-start');
});

scenario('drag', async (ctx) => {
  for (const [page, m, label] of [[ctx.app, 'w-week', 'app'], [ctx.mock, 'this week', 'mockup']]) {
    if (!page) continue;
    const a = await parts(page, m);
    await drag(page, grabPoint(a), { x: grabPoint(a).x + 150, y: grabPoint(a).y + 40 });
    await sleep(500);
    const b = await parts(page, m);
    R.ok(`${label}: dragging the title bar moves the window by the drag (150, 40)`, near(b.win.x - a.win.x, 150) && near(b.win.y - a.win.y, 40), { dx: b.win.x - a.win.x, dy: b.win.y - a.win.y });
  }
  const s = await st(ctx.app);
  const w = winIn(s, 'w-week').w;
  R.ok('app: the new position is saved in the state', near((w.x / 100) * W, 0, 99999) && w.x > 1.2 + 9 && w.y > 55.4, { x: w.x, y: w.y });
  await pair(ctx, '02-drag');
});

/* A local window (never one of the seed's VM windows: resizing those would resize their tmux client over ssh). */
scenario('resize', async (ctx) => {
  for (const [page, m, label] of [[ctx.app, 'w-mck', 'app'], [ctx.mock, 'The judgment bottleneck', 'mockup']]) {
    if (!page) continue;
    const a = await parts(page, m);
    await drag(page, { x: a.rz.cx, y: a.rz.cy }, { x: a.rz.cx - 90, y: a.rz.cy - 40 });
    await sleep(500);
    const b = await parts(page, m);
    R.ok(`${label}: dragging the corner resizes (-90, -40)`, near(b.win.w - a.win.w, -90) && near(b.win.h - a.win.h, -40), { dw: b.win.w - a.win.w, dh: b.win.h - a.win.h });
  }
  await pair(ctx, '03-resize');
});

scenario('lights', async (ctx) => {
  for (const [page, m, label] of [[ctx.app, 'w-week', 'app'], [ctx.mock, 'this week', 'mockup']]) {
    if (!page) continue;
    const a = await parts(page, m);
    await click(page, a.max.cx, a.max.cy);
    await sleep(600);
    const b = await parts(page, m);
    const vp = await evaluate(page, '__ui.r(document.getElementById("viewport"))');
    R.ok(`${label}: green fills the screen down to the dock`, near(b.win.w, vp.w * 0.988, 3) && near(b.win.y, vp.y + vp.h * 0.046, 3), { w: b.win.w, y: b.win.y });
    await shot(page, path.join(SHOTS, `04-green-${label}.png`));
    await click(page, b.max.cx, b.max.cy);
    await sleep(600);
    const c = await parts(page, m);
    R.ok(`${label}: green again puts it back`, near(c.win.x, a.win.x) && near(c.win.y, a.win.y) && near(c.win.w, a.win.w) && near(c.win.h, a.win.h), { before: a.win, after: c.win });
    await dblclick(page, a.tb.cx, a.tb.cy);
    await sleep(600);
    const d = await parts(page, m);
    R.ok(`${label}: double-clicking the title fills the screen`, near(d.win.w, vp.w * 0.988, 3), d.win.w);
    await dblclick(page, d.tb.cx, d.tb.cy);
    await sleep(600);
    const e = await parts(page, m);
    const back = near(e.win.w, a.win.w) && near(e.win.x, a.win.x);
    if (label === 'app') R.ok('app: double-clicking again puts it back', back, e.win);
    else console.log(`note mockup: double-clicking a filled window's title ${back ? 'puts it back' : 'leaves it filled (its press clears the saved size first)'}`);
    if (!back) { await click(page, e.max.cx, e.max.cy); await sleep(600); }
  }
  // yellow: park off to the right
  for (const [page, m, label] of [[ctx.app, 'w-week', 'app'], [ctx.mock, 'this week', 'mockup']]) {
    if (!page) continue;
    const a = await parts(page, m);
    await click(page, a.park.cx, a.park.cy);
    await sleep(400);
    const t = await evaluate(page, '__ui.toast()');
    const b = await parts(page, m);
    R.ok(`${label}: yellow parks it off to the right`, b.win.x > (await evaluate(page, 'innerWidth')), b.win.x);
    if (label === 'app') R.ok('app: yellow shows no notice', t === '', t);
    else R.ok(`${label}: yellow says where it went`, /parked off to the right/.test(t), t);
  }
  await pair(ctx, '05-yellow');
  // red: close a terminal, it stays in the sidebar, the session keeps running; reopen reattaches
  const app = ctx.app;
  const a = await parts(app, 'w-design');
  await click(app, a.close.cx, a.close.cy);
  await sleep(500);
  const gone = await evaluate(app, '!document.querySelector(\'.win[data-id="w-design"]\')');
  const row = await evaluate(app, '__ui.rowText("reopen|w-design")');
  const t = await evaluate(app, '__ui.toast()');
  R.ok('app: red closes the terminal window', gone);
  R.ok('app: it stays in the sidebar, dimmed, with an end action', !!row && await evaluate(app, '!!document.querySelector(\'.tr.dim[data-act="reopen|w-design"] [data-end]\')'), row);
  R.ok('app: red shows no notice', t === '', t);
  await sleep(300);
  R.ok('app: the tmux session is still running, with no Flow client', hasSession('w-design') && clients('w-design') === 0, { session: hasSession('w-design'), clients: clients('w-design') });
  if (ctx.mock) {
    const m = await parts(ctx.mock, 'design: workspaces');
    await click(ctx.mock, m.close.cx, m.close.cy);
    await sleep(500);
  }
  await pair(ctx, '06-red');
  const rr = await evaluate(app, '__ui.row("reopen|w-design")');
  await click(app, rr.cx, rr.cy);
  await sleep(1500);
  const back = await evaluate(app, '!!document.querySelector(\'.win[data-id="w-design"]\')');
  R.ok('app: clicking the closed row opens it again', back);
  await sleep(1500);
  R.ok('app: reopening reattaches to the same tmux session', clients('w-design') === 1, clients('w-design'));
});

scenario('rename', async (ctx) => {
  const app = ctx.app;
  // pill: double-click, type, Enter saves
  let p = await evaluate(app, '__ui.pill(3)');
  await dblclick(app, p.cx, p.cy);
  await sleep(300);
  const editing = await evaluate(app, 'document.activeElement && document.activeElement.classList.contains("rn") && !!document.activeElement.closest(".sp") && document.activeElement.textContent');
  R.ok('pill: double-click puts the name into rename, selected', editing === 'voiceless', editing);
  await type(app, 'voice notes');
  await shot(app, path.join(SHOTS, '07-rename-pill-app.png'));
  await key(app, 'Enter');
  await sleep(300);
  let s = await st(app);
  R.ok('pill: Enter saves the new name', wsOf(s, 'voiceless').name === 'voice notes' && (await evaluate(app, 'document.querySelectorAll(".sp")[3].textContent')).startsWith('voice notes'), wsOf(s, 'voiceless').name);
  p = await evaluate(app, '__ui.pill(3)');
  await dblclick(app, p.cx, p.cy);
  await sleep(300);
  await type(app, 'zzz');
  await key(app, 'Escape');
  await sleep(300);
  s = await st(app);
  R.ok('pill: Esc cancels', wsOf(s, 'voiceless').name === 'voice notes' && !(await evaluate(app, 'document.querySelector(".sp .rn")')), wsOf(s, 'voiceless').name);
  p = await evaluate(app, '__ui.pill(3)');
  await dblclick(app, p.cx, p.cy);
  await sleep(300);
  await type(app, 'voiceless');
  await key(app, 'Enter');
  await sleep(300);
  await goPill(app, 0);
  // sub-workspace: double-click its sidebar row
  let zl = await evaluate(app, '__ui.r(document.querySelector(\'.tr[data-act="zone|z-research"] .l\'))');
  await dblclick(app, zl.cx, zl.cy);
  await sleep(300);
  const zEditing = await evaluate(app, 'document.activeElement && document.activeElement.classList.contains("rn") && document.activeElement.closest(".tr") ? document.activeElement.textContent : null');
  R.ok('sub-workspace: double-click its sidebar row puts its name into rename', zEditing === 'research', zEditing);
  await type(app, 'reading room');
  await key(app, 'Enter');
  await sleep(300);
  s = await st(app);
  R.ok('sub-workspace: Enter saves, the sidebar follows', wsOf(s, 'flow').zones.find((z) => z.id === 'z-research').name === 'reading room' && /reading room/.test(await evaluate(app, '__ui.rowText("zone|z-research")')), wsOf(s, 'flow').zones.find((z) => z.id === 'z-research').name);
  zl = await evaluate(app, '__ui.r(document.querySelector(\'.tr[data-act="zone|z-research"] .l\'))');
  await dblclick(app, zl.cx, zl.cy);
  await sleep(300);
  await type(app, 'nope');
  await key(app, 'Escape');
  await sleep(300);
  s = await st(app);
  R.ok('sub-workspace: Esc cancels', wsOf(s, 'flow').zones.find((z) => z.id === 'z-research').name === 'reading room');
  zl = await evaluate(app, '__ui.r(document.querySelector(\'.tr[data-act="zone|z-research"] .l\'))');
  await dblclick(app, zl.cx, zl.cy);
  await sleep(300);
  await type(app, 'research');
  await key(app, 'Enter');
  await sleep(300);
  // +: a new workspace, its pill goes straight into rename
  const plus = await evaluate(app, '__ui.r(document.getElementById("addws"))');
  await click(app, plus.cx, plus.cy);
  await sleep(500);
  const newEditing = await evaluate(app, 'document.activeElement && document.activeElement.closest(".sp") ? document.activeElement.textContent : null');
  R.ok('+ makes a workspace and puts its name into rename', newEditing === 'new workspace', newEditing);
  await type(app, 'scratch');
  await key(app, 'Enter');
  await sleep(400);
  s = await st(app);
  const nw = s.ws[s.ws.length - 1];
  R.ok('+ then Enter: the new workspace is named and shown', s.ws.length === 6 && nw.name === 'scratch' && s.ui.at === nw.id && (await evaluate(app, '__ui.active()')) === 5, { n: s.ws.length, name: nw.name, at: s.ui.at });
  R.ok('+ then Enter: the new workspace starts empty, no note window made for it (c4)', nw.windows.length === 0 && nw.notes.length === 0, { windows: nw.windows.length, notes: nw.notes.length });
  // born complete: what sidebar's migrate would add at the next start is there already, so a restart changes nothing
  R.ok('+ then Enter: the new workspace has its saved list from the start', Array.isArray(nw.saved) && nw.saved.length === 0, { saved: nw.saved });
  await shot(app, path.join(SHOTS, '08-new-workspace-app.png'));
  await goPill(app, 0);
});

scenario('drop-on-pill', async (ctx) => {
  for (const [page, m, label] of [[ctx.app, 'mn-note', 'app'], [ctx.mock, 'mynotes', 'mockup']]) {
    if (!page) continue;
    await goPill(page, 1);
    const a = await parts(page, label === 'app' ? m : 'mynotes');
    const pill = await evaluate(page, '__ui.pill(4)');
    const from = grabPoint(a);
    await mouse(page, 'mouseMoved', from.x, from.y);
    await mouse(page, 'mousePressed', from.x, from.y);
    for (let i = 1; i <= 14; i++) await mouse(page, 'mouseMoved', from.x + ((pill.cx - from.x) * i) / 14, from.y + ((pill.cy - from.y) * i) / 14, { down: true });
    await frames(page);
    const lit = await evaluate(page, 'document.querySelectorAll(".sp")[4].classList.contains("dropon")');
    const seen = lit ? undefined : await evaluate(page, `(() => { const hit = document.elementFromPoint(${pill.cx}, ${pill.cy}); const w = __ui.win(${JSON.stringify(m)}); const r = w && w.getBoundingClientRect(); return { busy: document.body.classList.contains('busy'), drag: !!(w && w.classList.contains('drag')), win: r && [Math.round(r.left), Math.round(r.top)], hit: hit && hit.className, pills: document.querySelectorAll('.sp').length, from }; })()`.replace('from }', `from: ${JSON.stringify(from)} }`));
    R.ok(`${label}: dragging a window over a workspace name lights the name`, lit, seen);
    await mouse(page, 'mouseReleased', pill.cx, pill.cy);
    await sleep(500);
    const t = await evaluate(page, '__ui.toast()');
    if (label === 'app') R.ok('app: dropping it there shows no notice', t === '', t);
    else R.ok(`${label}: dropping it there moves it (toast)`, /moved to ef start/.test(t), t);
  }
  const s = await st(ctx.app);
  R.ok('app: the window and its note now live in ef start', !!wsOf(s, 'ef').windows.find((w) => w.id === 'mn-note') && !!wsOf(s, 'ef').notes.find((n) => n.id === 'n-mn')
    && !wsOf(s, 'mynotes').windows.find((w) => w.id === 'mn-note') && !wsOf(s, 'mynotes').notes.find((n) => n.id === 'n-mn'));
  await pair(ctx, '09-drop-on-pill');
  await goPill(ctx.app, 4);
  R.ok('app: it is on the ef start desktop', await evaluate(ctx.app, '!!document.querySelector(\'.ws[data-id="ef"] .win[data-id="mn-note"]\')'));
  await goPill(ctx.app, 0);
  if (ctx.mock) await goPill(ctx.mock, 0);
});

/* Two fingers move between the spaces of a workspace (the main one, then each sub-workspace), one per swipe; ⌃←/⌃→ (and
   three fingers, through main's next-ws/prev-ws) switch workspace. The owner: "if you want to go to like a sub-workspace
   in that main workspace, we can use the 2-finger swipe ... a different workspace entirely ... the 3-finger". */
scenario('swipe', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  await blur(app);
  const where = () => evaluate(app, '({ ws: __ui.active(), pill: document.querySelectorAll(".sp")[0].textContent.replace("⤢", "") })');
  const v = await evaluate(app, '__ui.r(document.getElementById("viewport"))');
  const t = Date.now();
  await wheel(app, v.cx, v.y + 45, 140, 0, t);
  await sleep(80);
  await wheel(app, v.cx, v.y + 45, 140, 0, t + 80);
  await sleep(800);
  let at = await where();
  R.ok('app: a two-finger swipe goes to the next sub-workspace, one at a time, in the same workspace', at.ws === 0 && /› research/.test(at.pill), at);
  await shot(app, path.join(SHOTS, '10-swipe-app.png'));
  await swipe(app, v.cx, v.y + 45, [8, 18, 30, 42, 46, 40, 34, 28, 22, 18, 14, 11, 9, 7, 5, 4, 3, 2, 2, 1]);
  await sleep(900);
  at = await where();
  R.ok('app: past the last sub-workspace a swipe stays (it bounces)', at.ws === 0 && /› research/.test(at.pill), at);
  await swipe(app, v.cx, v.y + 45, [-8, -18, -30, -42, -46, -40, -34, -28, -22, -18, -14, -11, -9, -7, -5, -4, -3, -2, -2, -1]);
  await sleep(900);
  at = await where();
  R.ok('app: a trackpad-like swipe back (20 wheel events 16 ms apart) goes to the main space, one step', at.ws === 0 && !/›/.test(at.pill), at);
  await blur(app);
  await key(app, 'ArrowRight', MOD.ctrl);
  await sleep(500);
  R.ok('app: ⌃→ goes to the next workspace', (await evaluate(app, '__ui.active()')) === 1);
  await key(app, 'ArrowLeft', MOD.ctrl);
  await sleep(500);
  R.ok('app: ⌃← goes back', (await evaluate(app, '__ui.active()')) === 0);
  await key(app, 'ArrowLeft', MOD.ctrl);
  await sleep(500);
  R.ok('app: ⌃← at the first workspace stays there', (await evaluate(app, '__ui.active()')) === 0);
});

scenario('pan', async (ctx) => {
  for (const [page, label] of [[ctx.app, 'app'], [ctx.mock, 'mockup']]) {
    if (!page) continue;
    await goPill(page, 0);
    if (label === 'app') {
      // flow's main space fits on one screen now that its sub-workspaces are spaces of their own: park a new note
      // off to the right (dock ✎, then yellow) so there is somewhere to pan to
      const had = new Set((await evaluate(page, '__flow.windows()')).map((x) => x.id));
      await dockClick(page, 'note');
      await sleep(600);
      const nw = (await evaluate(page, '__flow.windows()')).find((x) => !had.has(x.id));
      const np = nw && (await parts(page, nw.id));
      if (np) { await click(page, np.park.cx, np.park.cy); await sleep(700); }
      R.ok('app: a new note parked off to the right gives the main space room to pan', !!np && (await evaluate(page, 'new DOMMatrix(getComputedStyle(document.querySelector(".ws .canvas")).transform).m41')) <= 0);
    }
    const p = await emptySpot(page);
    await panTo(page, 'start');
    const pan0 = await evaluate(page, 'new DOMMatrix(getComputedStyle(document.querySelector(".ws .canvas")).transform).m41');
    R.ok(`${label}: dragging right from anywhere comes back to the start of the workspace`, near(pan0, 0, 1), pan0);
    await mouse(page, 'mouseMoved', p.x, p.y);
    await mouse(page, 'mousePressed', p.x, p.y);
    for (let i = 1; i <= 10; i++) await mouse(page, 'mouseMoved', p.x - 32 * i, p.y, { down: true });
    const grabbing = await evaluate(page, 'document.getElementById("viewport").classList.contains("panning")');
    const preview = await evaluate(page, '!!document.getElementById("mmap")');
    await sleep(120);
    await mouse(page, 'mouseReleased', p.x - 320, p.y);
    await sleep(200);
    const pan1 = await evaluate(page, 'new DOMMatrix(getComputedStyle(document.querySelector(".ws .canvas")).transform).m41');
    R.ok(`${label}: dragging the empty desktop 320px moves the workspace 320px`, near(pan0 - pan1, 320), pan0 - pan1);
    if (label === 'app') R.ok('app: while dragging the cursor is grabbing, with no layout preview (the owner called it distracting)', grabbing && !preview, { grabbing, preview });
    if (label === 'app') {
      // let go while still moving: it glides on past the drag and comes to rest (the owner: "just fling it and then it scrolls")
      await panTo(page, 'start');
      const g0 = await evaluate(page, 'new DOMMatrix(getComputedStyle(document.querySelector(".ws .canvas")).transform).m41');
      // stamped 12 ms apart with the release 8 ms after the last move, as a quick drag arrives, however late each lands
      const t0 = Date.now();
      await mouse(page, 'mouseMoved', p.x, p.y);
      await mouse(page, 'mousePressed', p.x, p.y, { at: t0 });
      for (let i = 1; i <= 8; i++) await mouse(page, 'mouseMoved', p.x - 25 * i, p.y, { down: true, at: t0 + 12 * i });
      await mouse(page, 'mouseReleased', p.x - 200, p.y, { at: t0 + 12 * 8 + 8 });
      await sleep(1500);
      const g1 = await evaluate(page, 'new DOMMatrix(getComputedStyle(document.querySelector(".ws .canvas")).transform).m41');
      R.ok('app: let go while moving and the desktop glides on past the 200px drag', g0 - g1 > 230, { moved: g0 - g1 });
    }
    else R.ok('mockup: while dragging the cursor is grabbing', grabbing, { grabbing });
    await shot(page, path.join(SHOTS, `11-pan-${label}.png`));
    // past the start the desktop stops at the start (a 1180px drag from 320px in, kept inside the view)
    const vw = await evaluate(page, '__ui.r(document.getElementById("viewport"))');
    await drag(page, { x: vw.x + 30, y: p.y }, { x: vw.x + vw.w - 30, y: p.y });
    await sleep(700);
    const pan4 = await evaluate(page, 'new DOMMatrix(getComputedStyle(document.querySelector(".ws .canvas")).transform).m41');
    R.ok(`${label}: dragging past the start stops at the start`, near(pan4, 0, 1), pan4);
  }
});

/* Sub-workspaces are separate spaces (the owner: "why should i be seeing the sub workspace there"): panning never shows
   one; the sidebar row or two fingers go there, the workspace's name goes back, and each space keeps its own pan. */
scenario('zones', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const shown = () => evaluate(app, `[...document.querySelectorAll('.ws[data-id="flow"] .win')].filter((w) => getComputedStyle(w).display !== 'none').map((w) => w.dataset.id).sort()`);
  const research = ['w-judge', 'w-kv', 'w-read'];
  let ids = await shown();
  R.ok('spaces: the main space shows none of the research windows', research.every((id) => !ids.includes(id)) && ids.includes('w-week'), ids);
  const p = await emptySpot(app);
  await panTo(app, 'end');
  ids = await evaluate(app, `[...document.querySelectorAll('.ws[data-id="flow"] .win')].filter((w) => { const r = w.getBoundingClientRect(); return getComputedStyle(w).display !== 'none' && r.right > 260 && r.left < innerWidth; }).map((w) => w.dataset.id)`);
  R.ok('spaces: panning to the far right never reaches a sub-workspace', research.every((id) => !ids.includes(id)), ids);
  await shot(app, path.join(SHOTS, '12-spaces-main-app.png'));
  const mainPan = await evaluate(app, 'new DOMMatrix(getComputedStyle(document.querySelector(\'.ws[data-id="flow"] .canvas\')).transform).m41');
  // the sidebar row goes there
  let row = await evaluate(app, '__ui.row("zone|z-research")');
  await click(app, row.cx, row.cy);
  await sleep(700);
  ids = await shown();
  const pillText = await evaluate(app, 'document.querySelectorAll(".sp")[0].textContent');
  R.ok('spaces: its sidebar row shows only that sub-workspace, named on the workspace pill', JSON.stringify(ids) === JSON.stringify(research) && /flow› research/.test(pillText), { ids, pillText });
  R.ok('spaces: the row of the space on screen is marked', await evaluate(app, '!!document.querySelector(\'.tr.here[data-act="zone|z-research"]\')'));
  await shot(app, path.join(SHOTS, '13-spaces-research-app.png'));
  // the workspace's name goes back, to the pan it had
  let pl = await evaluate(app, '__ui.pill(0)');
  await click(app, pl.cx, pl.cy);
  await sleep(700);
  ids = await shown();
  const back = await evaluate(app, 'new DOMMatrix(getComputedStyle(document.querySelector(\'.ws[data-id="flow"] .canvas\')).transform).m41');
  R.ok('spaces: clicking the workspace name goes back to the main space, where it was', ids.includes('w-week') && research.every((id) => !ids.includes(id)) && near(back, mainPan, 2), { ids, back, mainPan });
  await panTo(app, 'start');
  // a window dropped on a sub-workspace's row moves in; dropped on the workspace name it comes back
  const wr = await evaluate(app, '__ui.row("note|n-week")');
  await click(app, wr.cx, wr.cy);
  await sleep(700);
  let wk = await parts(app, 'w-week');
  row = await evaluate(app, '__ui.row("zone|z-research")');
  await drag(app, grabPoint(wk), { x: row.cx, y: row.cy }, { steps: 16, holdMs: 150 });
  await sleep(600);
  let s = await st(app);
  R.ok('spaces: dropping a window on a sub-workspace row moves it in', winIn(s, 'w-week').w.zone === 'z-research' && !(await shown()).includes('w-week'), { zone: winIn(s, 'w-week').w.zone, toast: await evaluate(app, '__ui.toast()') });
  row = await evaluate(app, '__ui.row("zone|z-research")');
  await click(app, row.cx, row.cy);
  await sleep(700);
  R.ok('spaces: there it is', (await shown()).includes('w-week'));
  wk = await parts(app, 'w-week');
  pl = await evaluate(app, '__ui.pill(0)');
  await drag(app, grabPoint(wk), { x: pl.cx, y: pl.cy }, { steps: 16, holdMs: 150 });
  await sleep(600);
  s = await st(app);
  R.ok('spaces: dropped on its workspace name, it goes back to the main space', !winIn(s, 'w-week').w.zone, winIn(s, 'w-week').w.zone || 'main');
  // ⤢ on the sub-workspace's row opens just that space in its own window
  const before = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  await mouse(app, 'mouseMoved', row.cx, row.cy);
  await sleep(200);
  const pop = await evaluate(app, '__ui.r(document.querySelector(\'.tr[data-act="zone|z-research"] [data-zpop]\'))');
  if (pop) await click(app, pop.cx, pop.cy);
  let solo = null;
  for (let i = 0; i < 40 && !solo; i++) {
    await sleep(250);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    solo = list.find((t) => t.type === 'page' && /#solo=flow&zone=z-research/.test(t.url) && !before.some((b) => b.id === t.id));
  }
  R.ok('⤢ on a sub-workspace opens it in its own window', !!solo, solo && solo.url);
  if (solo) {
    const sp = await connectTo(PORT, 'zone=z-research');
    await size(sp, W, H);
    await waitFor(sp, '!!window.__flow', 10000);
    await evaluate(sp, 'window.__flow.ready');
    await sleep(1500);
    const info = await evaluate(sp, '({ nav: document.getElementById("spaces").textContent, wins: [...document.querySelectorAll(".win")].filter((w) => getComputedStyle(w).display !== "none").map((w) => w.dataset.id).sort() })');
    R.ok('the pop-out shows only that sub-workspace', /research/.test(info.nav) && JSON.stringify(info.wins) === JSON.stringify(research), info);
    await shot(sp, path.join(SHOTS, '13-popout-app.png'));
    // the main window: a popped-out space lives only in its pop-out (its pages load once), and says where it is
    const mainSide = `(() => { const a = [...document.querySelectorAll('.ws[data-id="flow"] .away')].find((e) => getComputedStyle(e).display !== 'none');
      return { away: a ? a.textContent : null, shown: [...document.querySelectorAll('.ws[data-id="flow"] .win')].filter((w) => getComputedStyle(w).display !== 'none').map((w) => w.dataset.id).sort(),
        pages: ${JSON.stringify(research)}.filter((id) => !!__flow.page(id)) }; })()`;
    R.ok('main window: the popped-out space\'s pages have no body here', (await evaluate(app, mainSide)).pages.length === 0, await evaluate(app, mainSide));
    await goPill(app, 0);
    await sleep(600);
    const mainNow = await evaluate(app, `(() => ({ at: __flow.state().ws[0].at || null, side: ${mainSide} }))()`);
    R.ok('main window: the main space shows as usual meanwhile', mainNow.at === null && mainNow.side.away === null && mainNow.side.shown.length > 0, mainNow);
    const rr = await evaluate(app, '__ui.row("zone|z-research")');
    await click(app, rr.cx, rr.cy);
    await sleep(800);
    const away = await evaluate(app, mainSide);
    R.ok('main window: going to that space shows "research / in another window" and none of its windows', away.away === 'researchin another window' && away.shown.length === 0 && away.pages.length === 0, away);
    await shot(app, path.join(SHOTS, '13b-popout-main.png'));
    /* What the owner sees: the pop-out leaves the screen within about 100 ms of its close (main's clock: its window's
       'close' to its 'hide', or to 'closed' if it goes without hiding). It is gone once its pages are saved, which
       item 40 lets take up to 2 s. */
    const mainp = await connectTo(INSPECT, '', 'node');
    const armed = await evaluate(mainp, `(() => {
      const w = require('electron').BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('zone=z-research'));
      if (!w) return false;
      const t = globalThis.__uiPopClose = {};
      w.once('close', () => { t.close = Date.now(); });
      w.once('hide', () => { t.hide = Date.now(); });
      w.once('closed', () => { t.closed = Date.now(); });
      return true;
    })()`, true);
    await evaluate(sp, 'setTimeout(() => window.close(), 50), true');
    const listed = (all) => all.some((t) => /zone=z-research/.test(t.url));
    let times = {}, after = [];
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(50)) {
      times = (await evaluate(mainp, 'globalThis.__uiPopClose', true)) || {};
      after = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (times.close && !listed(after)) break;
    }
    const offScreen = times.close ? Math.min(times.hide || Infinity, times.closed || Infinity) - times.close : null;
    const gone = times.close && !listed(after) ? Date.now() - times.close : null;
    mainp.ws.close();
    console.log(`note pop-out off screen ${offScreen} ms after its close, its target gone after ${gone} ms`);
    R.ok('closing the pop-out takes it off screen within 100 ms', armed && offScreen !== null && offScreen <= 100, { offScreen, times });
    R.ok('closing the pop-out leaves the main window, the pop-out gone within 4 s', after.some((t) => t.type === 'page' && /\/src\/index\.html$/.test(t.url)) && gone !== null && gone <= 4000, { gone });
    const stNow = await st(app);
    R.ok('closing the pop-out keeps its windows in the workspace', research.every((id) => !!winIn(stNow, id)));
    const back = await waitFor(app, `(() => { const m = ${mainSide}; return m.away === null && m.pages.length === 2 ? m : null; })()`, 5000);
    R.ok('main window: after the pop-out closes, the space shows here again with its pages', !!back && JSON.stringify(back.shown) === JSON.stringify(research), back || (await evaluate(app, mainSide)));
  }
  // a window closed in a sub-workspace reopens there, not in the space you happen to be in (flows)
  row = await evaluate(app, '__ui.row("zone|z-research")');
  await click(app, row.cx, row.cy);
  await sleep(700);
  const ep = await emptySpot(app);
  const had = new Set((await evaluate(app, '__flow.windows()')).map((x) => x.id));
  await rightClick(app, ep.x, ep.y);
  await sleep(250);
  const ns = await evaluate(app, `__ui.r([...document.querySelectorAll('.ctx button')].find((b) => /^new shell here/.test(b.textContent)))`);
  if (ns) { await click(app, ns.cx, ns.cy); await sleep(1200); }
  const shw = (await evaluate(app, '__flow.windows()')).find((x) => !had.has(x.id));
  if (R.ok('spaces: a shell made in research lives there', !!shw && winIn(await st(app), shw.id).w.zone === 'z-research', shw && shw.id)) {
    const sp1 = await parts(app, shw.id);
    await click(app, sp1.close.cx, sp1.close.cy);
    await sleep(500);
    pl = await evaluate(app, '__ui.pill(0)');
    await click(app, pl.cx, pl.cy);
    await sleep(700);
    let rr = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${shw.id}"]'))`);
    if (!rr) {
      const tog = await evaluate(app, '__ui.r(document.querySelector(\'.tr[data-act="zone|z-research"] .g[data-tog]\'))');
      if (tog) { await click(app, tog.cx, tog.cy); await sleep(300); }
      rr = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${shw.id}"]'))`);
    }
    if (rr) { await click(app, rr.cx, rr.cy); await sleep(900); }
    const back = winIn(await st(app), shw.id);
    const here = await evaluate(app, `({ pill: document.querySelectorAll('.sp')[0].textContent, shown: getComputedStyle(__ui.win(${JSON.stringify(shw.id)})).display !== 'none' })`);
    R.ok('spaces: reopening it from the sidebar in the main space puts it back in research, and goes there', !!rr && !!back && back.w.zone === 'z-research' && /› research/.test(here.pill) && here.shown, { row: !!rr, zone: back && back.w.zone, ...here });
    R.ok('spaces: closing that shell and its × end it', await closeAndEnd(app, shw.id));
    pl = await evaluate(app, '__ui.pill(0)');
    await click(app, pl.cx, pl.cy);
    await sleep(600);
  }
  // ⤢ on a pill: the whole workspace in its own window
  const pill = await evaluate(app, '__ui.pill(1)');
  await mouse(app, 'mouseMoved', pill.cx, pill.cy);
  await sleep(200);
  const pp = await evaluate(app, '__ui.r(document.querySelectorAll(".sp")[1].querySelector("[data-pop]"))');
  R.ok('hovering a workspace name shows its ⤢', !!pp && pp.w > 0, pp);
  if (pp && pp.w) {
    await click(app, pp.cx, pp.cy);
    let t = null;
    for (let i = 0; i < 40 && !t; i++) {
      await sleep(250);
      t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && /#solo=mynotes$/.test(x.url));
    }
    R.ok('⤢ on a workspace name opens it in its own window', !!t, t && t.url);
    if (t) {
      const sp = await connectTo(PORT, 'solo=mynotes');
      await evaluate(sp, 'setTimeout(() => window.close(), 50), true');
      await sleep(1000);
    }
  }
  await goPill(app, 0);
});

scenario('dock', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const ids0 = (await evaluate(app, '__flow.windows().map((w) => w.id)'));
  const newest = async () => (await evaluate(app, '__flow.windows()')).filter((w) => !ids0.includes(w.id));
  // note
  await dockClick(app, 'note');
  await sleep(600);
  // notes' rule: the heading holds only the owner's title, and says "new note" faintly while the note is empty
  const noteFocus = await evaluate(app, '(() => { const a = document.activeElement; return a && a.classList.contains("ntitle") ? { text: a.textContent, faint: a.dataset.ph } : null; })()');
  R.ok('dock ✎: a new note with the caret in its empty heading, which says "new note" faintly', !!noteFocus && noteFocus.text === '' && noteFocus.faint === 'new note', noteFocus);
  await type(app, 'dock note');
  await sleep(300);
  let s = await st(app);
  R.ok('dock ✎: typing names the note', wsOf(s, 'flow').notes.some((n) => n.title === 'dock note'));
  // red on a note: it closes, stays in the sidebar dimmed, and the row opens it again
  const dn = (await newest()).find((w) => w.type === 'note');
  if (dn) {
    const np = await parts(app, dn.id);
    const nt0 = await evaluate(app, '__ui.toast()');
    await click(app, np.close.cx, np.close.cy);
    await sleep(400);
    const nt1 = await evaluate(app, '__ui.toast()');
    const nt = nt1 === nt0 ? '' : nt1;
    const dim = await evaluate(app, `!!document.querySelector('.tr.dim[data-act="note|${dn.noteId}"]')`);
    R.ok('red on a note closes it; it stays in the sidebar, dimmed', !(await evaluate(app, `!!document.querySelector('.win[data-id="${dn.id}"]')`)) && dim && nt === '', nt);
    const nr = await evaluate(app, `__ui.row("note|${dn.noteId}")`);
    await click(app, nr.cx, nr.cy);
    await sleep(600);
    R.ok('its sidebar row opens it again', (await evaluate(app, '__flow.windows()')).some((w) => w.noteId === dn.noteId));
  }
  // page
  await dockClick(app, 'page');
  await sleep(800);
  const pageFocus = await evaluate(app, 'document.activeElement ? (document.activeElement.closest(".addr") ? "address" : document.activeElement.className) : null');
  R.ok('dock ↗: a new page with its address focused', pageFocus === 'address', pageFocus);
  // zone
  const z0 = wsOf(await st(app), 'flow').zones.length;
  const zt0 = await evaluate(app, '__ui.toast()');
  await dockClick(app, 'zone');
  await sleep(600);
  const zt1 = await evaluate(app, '__ui.toast()');
  const zt = zt1 === zt0 ? '' : zt1;
  R.ok('dock ◳: a new sub-workspace, with no notice', wsOf(await st(app), 'flow').zones.length === z0 + 1 && zt === '', zt);
  // its name opens for typing in the pill (item 19); Enter keeps it, as after typing one
  const naming = await evaluate(app, '(() => { const a = document.activeElement; return !!(a && a.closest && a.closest("#spaces .sp .sz")); })()');
  R.ok('dock ◳: its name opens for typing in the pill', naming, await evaluate(app, 'document.activeElement ? document.activeElement.className : null'));
  // type a name, then one click on the workspace's name: the name is kept and the main space is back (spaces' fix)
  if (naming) {
    await type(app, 'goal');
    const sn = await evaluate(app, '__ui.pill(0)');
    await click(app, sn.cx, sn.cy);
    await sleep(700);
    const after = await evaluate(app, `(() => { const f = __flow.state().ws.find((w) => w.id === 'flow'); return { at: f.at || null, names: f.zones.map((z) => z.name) }; })()`);
    R.ok('dock ◳: a name typed, one click on the workspace name keeps it and goes back to the main space', after.at === null && after.names.includes('goal'), after);
  }
  await goPill(app, 0);
  await panTo(app, 'start');
  // agent: real Claude Code
  await dockClick(app, 'agent');
  await sleep(1000);
  const agent = (await newest()).find((w) => w.type === 'term');
  R.ok('dock ›_: a new agent window', !!agent, agent);
  if (agent) {
    const txt = await waitFor(app, `(() => { const t = __flow.term(${JSON.stringify(agent.id)}); const s = t && t.getText(); return /Welcome back|Claude Code|Free Code/.test(s) ? s.slice(0, 120) : ''; })()`, CLAUDE_START_MS, 500);
    R.ok('dock ›_: the agent window runs real Claude Code', !!txt, txt);
    R.ok('dock ›_: in its own tmux session', hasSession(agent.id));
    ctx.agentId = agent.id;
  }
  await pair(ctx, '14-dock-agent', false);
  // team
  await dockClick(app, 'team');
  await sleep(1500);
  const team = (await newest()).find((w) => w.type === 'team');
  for (let i = 0; team && i < 40 && !hasSession(team.id); i++) await sleep(250);
  R.ok('dock ◫: a new team window in its own tmux session', !!team && hasSession(team.id), team);
  if (team) ctx.teamId = team.id;
  if (ctx.mock) {
    await goPill(ctx.mock, 0);
    const mb = await evaluate(ctx.mock, '__ui.r(document.querySelector(\'#dock [data-k="agent"]\'))');
    await click(ctx.mock, mb.cx, mb.cy);
    await sleep(800);
    await shot(ctx.mock, path.join(SHOTS, '14-dock-agent-mockup.png'));
  }
});

scenario('notes', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const id = ctx.agentId || 'w-design';
  await inView(app, id, ':scope > .tb .act');
  let a = await parts(app, id);
  if (!a) { R.ok('notes: a terminal window to use', false); return; }
  await click(app, a.act.cx, a.act.cy);
  await sleep(500);
  const open = await evaluate(app, `(() => { const w = __ui.win(${JSON.stringify(id)}); const n = w.querySelector('.anote'); return { noted: w.classList.contains('noted'), shown: getComputedStyle(n).display !== 'none', focus: document.activeElement === n.querySelector('.ned') }; })()`);
  R.ok('✎ opens the agent note beside the terminal, with the cursor in it', open.noted && open.shown && open.focus, open);
  await type(app, 'watch the tests');
  await sleep(300);
  const s = await st(app);
  R.ok('typing in the agent note saves it', winIn(s, id).w.note === 'watch the tests', winIn(s, id).w.note);
  await pair(ctx, '15-agent-note', false);
  a = await parts(app, id);
  await click(app, a.act.cx, a.act.cy);
  await sleep(400);
  R.ok('✎ again hides it', !(await evaluate(app, `__ui.win(${JSON.stringify(id)}).classList.contains('noted')`)));
  if (ctx.mock) {
    const m = await parts(ctx.mock, 'design: workspaces');
    if (m && !m.noted) { await click(ctx.mock, m.act.cx, m.act.cy); await sleep(400); }
    await shot(ctx.mock, path.join(SHOTS, '15-agent-note-mockup.png'));
  }
});

/* A session this run makes for itself (tests only open, resume or fork their own sessions): `claude -p "/cost"` runs
   a local command, no API call, in a new folder under <CWD>/sessions (trusted through /home/claude, so Claude Code
   starts without its trust question). The folder name is the search word. */
function ownSession(tag) {
  const word = `${tag}-${Date.now().toString(36)}`;
  const cwd = path.join(CWD, 'sessions', word);
  fs.mkdirSync(cwd, { recursive: true });
  const id = crypto.randomUUID();
  execFileSync('claude', ['-p', '/cost', '--session-id', id], { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const file = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'), `${id}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`claude -p /cost made no transcript at ${file}`);
  return { id, cwd, word, title: '/cost' };
}
/* page's search index is built in the background on a fresh userData (minutes on a loaded VM): wait until ⌘K's
   search finds this session before typing for it. */
async function searchable(app, s, ms = 300000) {
  const ok = await waitFor(app, `flow.sessions.search(${JSON.stringify(s.word)}).then((r) => r.results.some((x) => x.id === ${JSON.stringify(s.id)}))`, ms, 2000);
  if (!ok) throw new Error(`page's search did not find ${s.id} within ${ms / 1000} s`);
}
/* ⌘K, type a word of its title, click its row: the session opens here as an agent window. */
async function openFromSearch(app, pick) {
  await searchable(app, pick);
  await blur(app);
  await key(app, 'k', MOD.meta);
  await sleep(300);
  await type(app, pick.word);
  if (!(await waitFor(app, `!!document.querySelector('.srow[data-sess="${pick.id}"]')`, 8000))) return null;
  const row = await evaluate(app, `__ui.r(document.querySelector('.srow[data-sess="${pick.id}"]'))`);
  await click(app, row.cx, row.cy);
  return waitFor(app, `__flow.windows().find((x) => x.sessionId === ${JSON.stringify(pick.id)}) || null`, 10000, 250);
}
/* Red closes the window, then the × on its sidebar row ends the session. True when the tmux session and the row are gone. */
/* The part of a window about to be clicked, made reachable as the owner would: past a toast over it (an undo stays
   8 s), and into view by the window's row in the sidebar when it is out of view or under another window (one that
   had no room opens past its space's last window, and a later pill click can leave it there). part: in the window;
   act: its row. */
async function inView(app, id, part = ':scope > .tb', act = `win|${id}`) {
  const where = () => evaluate(app, `(() => {
    const w = __ui.win(${JSON.stringify(id)}), e = w && w.querySelector(${JSON.stringify(part)});
    if (!e) return 'gone';
    const r = e.getBoundingClientRect(), v = document.getElementById('viewport').getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < v.left || x > v.right || y < v.top || y > v.bottom) return 'away';
    const h = document.elementFromPoint(x, y);
    return h && w.contains(h) ? 'there' : h && h.closest('#toast') ? 'toast' : 'away';
  })()`);
  let at = await where();
  if (at === 'toast') { await waitFor(app, '!document.getElementById("toast").classList.contains("on")', 9000, 200); at = await where(); }
  if (at !== 'away') return;
  const row = await evaluate(app, `__ui.row(${JSON.stringify(act)})`);
  if (row) { await click(app, row.cx, row.cy); await sleep(700); }
}
async function closeAndEnd(app, id) {
  await inView(app, id, ':scope > .tb [data-l=close]');
  const p = await parts(app, id);
  if (!p) return false;
  await click(app, p.close.cx, p.close.cy);
  await sleep(500);
  const end = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${id}"] [data-end]'))`);
  if (end) {
    await mouse(app, 'mouseMoved', end.cx - 30, end.cy);
    await sleep(100);
    const e2 = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${id}"] [data-end]'))`);
    await click(app, e2.cx, e2.cy);
    await sleep(1200);
  }
  return (await sessionGone(id)) && !(await evaluate(app, `!!document.querySelector('.tr[data-act="reopen|${id}"]')`));
}
async function rightClick(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  await mouse(page, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await mouse(page, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
}
/* A fork opens once flow.sessions.list() has its conversation: seconds when the machine is loaded (load 114, 23:23). */
const forkMs = [];
async function waitFork(app, sid, ms = 15000) {
  const t0 = Date.now();
  for (const end = t0 + ms; Date.now() < end; await sleep(250)) {
    const f = (await st(app)).ws.flatMap((w) => w.windows).find((w) => w.forkFrom === sid);
    if (f) { forkMs.push(Date.now() - t0); console.log(`note fork window after ${Date.now() - t0} ms`); await sleep(500); return f; }
  }
  forkMs.push(null);
  console.log(`note no fork window within ${ms} ms`);
  return null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

scenario('search', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const pick = ownSession('search');
  R.ok('made a session of its own to find and resume (claude -p /cost, no API call)', !!pick, pick && { id: pick.id, cwd: pick.cwd });
  await blur(app);
  await key(app, 'k', MOD.meta);
  await sleep(300);
  R.ok('⌘K puts the cursor in the sidebar search', await evaluate(app, 'document.activeElement === document.getElementById("q")'));
  await searchable(app, pick);
  await type(app, pick.word);
  const found = await waitFor(app, `!!document.querySelector('.srow[data-sess="${pick.id}"]')`, 8000);
  R.ok('⌘K search finds the old session, under older sessions', found && /older sessions/.test(await evaluate(app, 'document.getElementById("sblist").textContent')), pick.word);
  await shot(app, path.join(SHOTS, '16-search-app.png'));
  if (ctx.mock) {
    await blur(ctx.mock);
    await key(ctx.mock, 'k', MOD.meta);
    await sleep(200);
    await type(ctx.mock, 'onboarding');
    await sleep(400);
    await shot(ctx.mock, path.join(SHOTS, '16-search-mockup.png'));
    await key(ctx.mock, 'Escape');
  }
  const row = await evaluate(app, `__ui.r(document.querySelector('.srow[data-sess="${pick.id}"]'))`);
  await click(app, row.cx, row.cy);
  // opening first asks whether that session runs somewhere else (flow.sessions.running), seconds under load
  const w = await waitFor(app, `__flow.windows().find((x) => x.sessionId === ${JSON.stringify(pick.id)}) || null`, 10000, 250);
  R.ok('clicking it opens it here as an agent window', !!w && (await evaluate(app, 'document.getElementById("q").value')) === '', w && { ...w, title: (w.title || '').slice(0, 80) });
  if (!w) return;
  const cmd = await paneCmd(w.id);
  R.ok('the agent resumes that conversation (claude --resume <id>)', cmd.includes(`--resume ${pick.id}`), cmd.slice(0, 160));
  const txt = await waitFor(app, `(() => { const t = __flow.term(${JSON.stringify(w.id)}); const s = t ? t.getText() : ''; return /Claude Code|Free Code|Welcome back|❯|>/.test(s) ? s : ''; })()`, CLAUDE_START_MS, 500);
  R.ok('the resumed agent shows Claude Code', /Claude Code|Free Code|Welcome back|❯|>/.test(txt || ''), (txt || '').slice(0, 120));
  await shot(app, path.join(SHOTS, '17-resumed-app.png'));
  // close it and end it from the sidebar, so the resumed claude does not keep running
  const p = await parts(app, w.id);
  await click(app, p.close.cx, p.close.cy);
  await sleep(500);
  const end = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${w.id}"] [data-end]'))`);
  if (end) {
    await mouse(app, 'mouseMoved', end.cx - 30, end.cy);
    await sleep(100);
    const e2 = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${w.id}"] [data-end]'))`);
    await click(app, e2.cx, e2.cy);
    await sleep(1200);
  }
  R.ok('the closed agent\'s × ends its session', (await sessionGone(w.id)) && !(await evaluate(app, `!!document.querySelector('.tr[data-act="reopen|${w.id}"]')`)));
});

/* B4: an old session is found by its id, its row shows the id, and right-click copies the exact resume command. */
scenario('search-id', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const pick = ownSession('searchid');
  await blur(app);
  await key(app, 'k', MOD.meta);
  await sleep(300);
  await type(app, pick.id.slice(0, 13));
  const row = await waitFor(app, `(() => { const r = document.querySelector('.srow[data-sess="${pick.id}"]'); return r ? r.textContent : ''; })()`, 8000);
  R.ok('search-id: typing the start of an id finds that session, and its row shows the full id', !!row && row.includes(pick.id), row);
  const rr = await evaluate(app, `__ui.r(document.querySelector('.srow[data-sess="${pick.id}"]'))`);
  await rightClick(app, rr.cx, rr.cy);
  await sleep(250);
  const items = await evaluate(app, `[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`);
  R.ok('search-id: right-clicking the row offers open here, fork here and copy resume command', items.length === 3 && /^open here/.test(items[0]) && /^fork here/.test(items[1]) && /^copy resume command/.test(items[2]), items);
  await shot(app, path.join(SHOTS, '26-search-id-app.png'));
  const c = await evaluate(app, `__ui.r([...document.querySelectorAll('.ctx button')].find((b) => /^copy resume command/.test(b.textContent)))`);
  await evaluate(app, '__ui.clearClip()');
  // a toast already up (an undo stays 8 s) may stay; the copy must not put up one of its own
  const toast0 = await evaluate(app, '__ui.toast()');
  if (c) { await click(app, c.cx, c.cy); await sleep(300); }
  const copied = await evaluate(app, '__ui.clip()');
  const toast1 = await evaluate(app, '__ui.toast()');
  R.ok('search-id: copy puts cd <folder> && claude --resume <full id> on the clipboard, with no notice', copied.startsWith('cd ') && copied.endsWith(`&& claude --resume ${pick.id}`) && (toast1 === '' || toast1 === toast0), { copied, toast0, toast1 });
  const qr = await evaluate(app, '__ui.r(document.getElementById("q"))');
  await click(app, qr.cx, qr.cy);
  await key(app, 'Escape');
  await sleep(300);
  // an agent row in the sidebar tree has the agent's menu
  const agentRow = await evaluate(app, `(() => { const r = [...document.querySelectorAll('#sblist .tr[data-act^="win|"]')].find((x) => /›_/.test(x.textContent)); return r ? { r: __ui.r(r), act: r.dataset.act } : null; })()`);
  if (!R.ok('search-id: the sidebar has an agent row', !!agentRow)) return;
  await rightClick(app, agentRow.r.cx, agentRow.r.cy);
  await sleep(250);
  const items2 = await evaluate(app, `[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`);
  R.ok('search-id: right-clicking an agent row in the sidebar opens its menu', items2.some((t) => /^copy resume command/.test(t)), { row: agentRow.act, items: items2 });
  await key(app, 'Escape');
  await sleep(150);
  // Q9: a session whose transcript is gone is marked and offers only its id (it is never clicked: not ours to open)
  const gone = (await evaluate(app, 'flow.sessions.list()')).find((x) => x.resumable === false);
  if (!gone) { console.log('note search-id: no session without a transcript on this machine, Q9 rows not checked'); return; }
  await click(app, qr.cx, qr.cy);
  await type(app, gone.id.slice(0, 13));
  const grow = await waitFor(app, `(() => { const r = document.querySelector('.srow[data-sess="${gone.id}"]'); return r ? { dim: r.classList.contains('dim'), text: r.textContent, drag: r.draggable } : null; })()`, 8000);
  R.ok('search-id: a session without a transcript is dimmed, says it cannot be resumed and cannot be dragged', !!grow && grow.dim && grow.text.includes('cannot be resumed') && grow.drag === false, grow);
  const gr = await evaluate(app, `__ui.r(document.querySelector('.srow[data-sess="${gone.id}"]'))`);
  await rightClick(app, gr.cx, gr.cy);
  await sleep(250);
  const gitems = await evaluate(app, `[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`);
  R.ok('search-id: its menu only copies its id', gitems.length === 1 && /^copy session id/.test(gitems[0]), gitems);
  const gc = await evaluate(app, `__ui.r(document.querySelector('.ctx button'))`);
  await evaluate(app, '__ui.clearClip()');
  if (gc) { await click(app, gc.cx, gc.cy); await sleep(300); }
  R.ok('search-id: copy session id copies the full id', (await evaluate(app, '__ui.clip()')) === gone.id);
  await click(app, qr.cx, qr.cy);
  await key(app, 'Escape');
  await sleep(200);
});

/* Right-click an agent and fork it: a new agent beside it with its own session id, started from the parent's conversation. */
scenario('fork', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const pick = ownSession('fork');
  R.ok('fork: made a session of its own to open and fork (claude -p /cost, no API call)', !!pick, pick && { id: pick.id, cwd: pick.cwd });
  const parent = await openFromSearch(app, pick);
  R.ok('fork: the old session opens as an agent window', !!parent, parent && parent.id);
  if (!parent) return;
  await waitFor(app, `(() => { const t = __flow.term(${JSON.stringify(parent.id)}); return !!t && /Claude Code|Welcome back|❯/.test(t.getText()); })()`, CLAUDE_START_MS, 500);
  const g = await parts(app, parent.id);
  await click(app, g.max.cx, g.max.cy);
  await sleep(600);
  const before = await parts(app, parent.id);
  await rightClick(app, before.win.cx, before.win.cy);
  await sleep(250);
  const menu = await evaluate(app, `(() => { const m = document.querySelector('.ctx'); return m ? [...m.querySelectorAll('button')].map((b) => b.textContent) : null; })()`);
  R.ok('right-clicking an agent opens a menu with fork', !!menu && /^fork/.test(menu[0]), menu);
  await shot(app, path.join(SHOTS, '24-fork-menu-app.png'));
  await key(app, 'Escape');
  await sleep(150);
  R.ok('Esc closes the menu', !(await evaluate(app, '!!document.querySelector(".ctx")')));
  await rightClick(app, before.win.cx, before.win.cy);
  await sleep(250);
  const copy = await evaluate(app, `__ui.r([...document.querySelectorAll('.ctx button')].find((b) => /^copy resume command/.test(b.textContent)))`);
  await evaluate(app, '__ui.clearClip()');
  if (copy) { await click(app, copy.cx, copy.cy); await sleep(300); }
  const copied = await evaluate(app, '__ui.clip()');
  R.ok('the menu copies the full resume command (cd <folder> && claude --resume <id>)', !!copy && copied.startsWith('cd ') && copied.endsWith(`&& claude --resume ${pick.id}`), copied);
  await rightClick(app, before.win.cx, before.win.cy);
  await sleep(250);
  const item = await evaluate(app, `__ui.r(document.querySelector('.ctx button'))`);
  if (!item) { R.ok('fork: the menu opens again', false); return; }
  await click(app, item.cx, item.cy);
  const fw = await waitFork(app, pick.id);
  R.ok('fork: a new agent window with a new session id, forked from the parent', !!fw && fw.type === 'term' && UUID.test(fw.sessionId) && fw.sessionId !== pick.id,
    fw && { id: fw.id, sessionId: fw.sessionId, forkFrom: fw.forkFrom, label: fw.label });
  R.ok('fork: its name is a label until Claude Code titles it (no fixed title)', !!fw && !fw.title && /^fork of /.test(fw.label || ''), fw && { title: fw.title, label: fw.label });
  if (!fw) return;
  const a = await parts(app, parent.id), b = await parts(app, fw.id);
  R.ok('fork: the parent and the fork split the parent\'s space side by side', near(a.win.x, before.win.x) && near(b.win.x + b.win.w, before.win.x + before.win.w)
    && near(a.win.w, b.win.w) && b.win.x > a.win.x + a.win.w && near(a.win.y, before.win.y) && near(b.win.y, before.win.y) && near(b.win.h, before.win.h),
    { before: before.win, parent: a.win, fork: b.win });
  const cmd = await paneCmd(fw.id);
  R.ok('fork: it runs claude --resume <parent> --fork-session --session-id <new>', cmd.includes(`--resume ${pick.id} --fork-session --session-id ${fw.sessionId}`), cmd.slice(0, 220));
  const txt = await waitFor(app, `(() => { const t = __flow.term(${JSON.stringify(fw.id)}); const s = t ? t.getText() : ''; return /Claude Code|Welcome back|❯/.test(s) ? s : ''; })()`, CLAUDE_START_MS, 500);
  R.ok('fork: the fork shows Claude Code', !!txt, (txt || '').slice(0, 120));
  await shot(app, path.join(SHOTS, '25-fork-app.png'));
  R.ok('fork: closing the fork and its × end its session', await closeAndEnd(app, fw.id));
  R.ok('fork: closing the parent and its × end its session', await closeAndEnd(app, parent.id));
  // ending an agent offers undo: its row comes back, and opening it resumes the conversation
  const ended = await evaluate(app, '__ui.toast()');
  const undo = await evaluate(app, '__ui.r(document.querySelector("#toast .tact"))');
  R.ok('fork: ending an agent offers undo', /^ended /.test(ended) && !!undo, ended);
  // the toast sits over the top row's title bars for 8 s: only its undo takes a click, its text lets one through
  const through = undo && await evaluate(app, `(() => {
    const t = document.getElementById('toast'), b = t.querySelector('.tact'), r = t.getBoundingClientRect(), u = b.getBoundingClientRect();
    const onText = document.elementFromPoint(r.left + 6, r.top + r.height / 2), onUndo = document.elementFromPoint(u.left + u.width / 2, u.top + u.height / 2);
    return { text: !!onText && !t.contains(onText), undo: onUndo === b };
  })()`);
  R.ok('fork: the undo toast takes a click only on undo; on its text the click goes to what is under it', !!through && through.text && through.undo, through);
  if (undo) {
    await click(app, undo.cx, undo.cy);
    await sleep(500);
    const back = await evaluate(app, `!!document.querySelector('.tr.dim[data-act="reopen|${parent.id}"]')`);
    R.ok('fork: undo puts the ended agent\'s row back', back);
    if (back) {
      // the ended Claude exits a moment after its tmux session (seconds at load 140); until then opening it says it runs
      const gone = await waitFor(app, `flow.sessions.running().then((l) => !l.some((x) => x.id === ${JSON.stringify(pick.id)}))`, 20000, 500);
      R.ok('fork: the ended agent\'s Claude has exited', gone);
      const rr = await evaluate(app, `__ui.row("reopen|${parent.id}")`);
      await click(app, rr.cx, rr.cy);
      const rc = await paneCmd(parent.id);
      R.ok('fork: opening that row resumes its conversation (claude --resume <id>)', rc.includes(`--resume ${pick.id}`), rc.slice(0, 200));
      R.ok('fork: closing it again and its × end it', await closeAndEnd(app, parent.id));
    }
  }
  // a new agent has no conversation yet: fork says so and opens nothing
  await dockClick(app, 'agent');
  await sleep(1500);
  const fresh = (await evaluate(app, '__flow.windows()')).filter((x) => x.ws === 'flow' && x.type === 'term').pop();
  const n0 = (await evaluate(app, '__flow.windows()')).length;
  const fp = await parts(app, fresh.id);
  await rightClick(app, fp.win.cx, fp.win.cy);
  await sleep(250);
  const fi = await evaluate(app, `__ui.r(document.querySelector('.ctx button'))`);
  if (fi) await click(app, fi.cx, fi.cy);
  const said = (await waitFor(app, '(() => { const t = __ui.toast(); return /^nothing to fork yet/.test(t) ? t : ""; })()', 10000, 250)) || (await evaluate(app, '__ui.toast()'));
  R.ok('fork on a new agent with no conversation says so and opens nothing', !!fi && /^nothing to fork yet/.test(said) && (await evaluate(app, '__flow.windows()')).length === n0, said);
  R.ok('fork: closing the new agent and its × end its session', await closeAndEnd(app, fresh.id));
});

/* Fork without opening the original: an old session from ⌘K, and a closed agent from the sidebar. */
scenario('fork-more', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  // an old session, straight from its search row
  const a = ownSession('forkrow');
  await blur(app);
  await key(app, 'k', MOD.meta);
  await sleep(300);
  await searchable(app, a);
  await type(app, a.word);
  if (!R.ok('fork-more: ⌘K finds the session', await waitFor(app, `!!document.querySelector('.srow[data-sess="${a.id}"]')`, 8000))) return;
  const rr = await evaluate(app, `__ui.r(document.querySelector('.srow[data-sess="${a.id}"]'))`);
  await rightClick(app, rr.cx, rr.cy);
  await sleep(250);
  const fh = await evaluate(app, `__ui.r([...document.querySelectorAll('.ctx button')].find((b) => /^fork here/.test(b.textContent)))`);
  if (fh) await click(app, fh.cx, fh.cy);
  const f1 = fh ? await waitFork(app, a.id) : null;
  R.ok('fork-more: "fork here" on a search row opens a fork, and the session itself stays closed', !!fh && !!f1 && !(await evaluate(app, '__flow.windows()')).some((x) => x.sessionId === a.id), f1 && { id: f1.id, forkFrom: f1.forkFrom });
  if (f1) {
    const c1 = await paneCmd(f1.id);
    R.ok('fork-more: it runs claude --resume <session> --fork-session --session-id <new>', c1.includes(`--resume ${a.id} --fork-session --session-id ${f1.sessionId}`), c1.slice(0, 200));
    R.ok('fork-more: closing that fork and its × end it', await closeAndEnd(app, f1.id));
  }
  // a closed agent, from its sidebar row
  const b = ownSession('forkclosed');
  const parent = await openFromSearch(app, b);
  if (!R.ok('fork-more: a session opened as an agent', !!parent)) return;
  await inView(app, parent.id, ':scope > .tb [data-l=close]');
  const pp = await parts(app, parent.id);
  await click(app, pp.close.cx, pp.close.cy);
  await sleep(600);
  const row = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${parent.id}"]'))`);
  if (!R.ok('fork-more: the closed agent has its row in the sidebar', !!row)) return;
  await rightClick(app, row.cx, row.cy);
  await sleep(250);
  const items = await evaluate(app, `[...document.querySelectorAll('.ctx button')].map((x) => x.textContent)`);
  const fc = await evaluate(app, `__ui.r([...document.querySelectorAll('.ctx button')].find((x) => /^fork/.test(x.textContent)))`);
  if (fc) await click(app, fc.cx, fc.cy);
  const f2 = fc ? await waitFork(app, b.id) : null;
  R.ok('fork-more: "fork" on a closed agent\'s row opens a fork here', items.some((t) => /^forkopens here/.test(t)) && !!f2, { items, fork: f2 && f2.id });
  if (f2) {
    const c2 = await paneCmd(f2.id);
    R.ok('fork-more: its fork runs claude --resume <session> --fork-session --session-id <new>', c2.includes(`--resume ${b.id} --fork-session --session-id ${f2.sessionId}`), c2.slice(0, 200));
    R.ok('fork-more: closing that fork and its × end it', await closeAndEnd(app, f2.id));
  }
  const end = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${parent.id}"] [data-end]'))`);
  if (end) {
    await mouse(app, 'mouseMoved', end.cx - 30, end.cy);
    await sleep(100);
    const e2 = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="reopen|${parent.id}"] [data-end]'))`);
    await click(app, e2.cx, e2.cy);
    await sleep(1200);
  }
  R.ok('fork-more: the closed agent\'s × ends its session', await sessionGone(parent.id));
});

/* Q5: right-click the empty desktop for a new agent, shell, note or page right there; a shell is a plain zsh. */
scenario('desktop-menu', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const p = await emptySpot(app);
  await rightClick(app, p.x, p.y);
  await sleep(250);
  const items = await evaluate(app, `[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`);
  R.ok('right-clicking the empty desktop offers a new agent, shell, note or page here', items.length === 4 && /^new agent here/.test(items[0]) && /^new shell here/.test(items[1]) && /^new note here/.test(items[2]) && /^new page here/.test(items[3]), items);
  await shot(app, path.join(SHOTS, '27-desktop-menu-app.png'));
  const had = new Set((await evaluate(app, '__flow.windows()')).map((x) => x.id));
  const b = await evaluate(app, `__ui.r(document.querySelectorAll('.ctx button')[1])`);
  await click(app, b.cx, b.cy);
  await sleep(1500);
  const added = (await st(app)).ws.flatMap((w) => w.windows).filter((w) => !had.has(w.id));
  const sh = added.length === 1 && added[0].cmd === 'shell' && !added[0].sessionId ? added[0] : null;
  R.ok('new shell here: one new plain shell window, no Claude session id', !!sh, added.map((w) => ({ id: w.id, cmd: w.cmd, sessionId: w.sessionId })));
  if (!sh) return;
  const g = await parts(app, sh.id);
  /* nav's fitAt: its corner at the click when that spot is over no window; else in the open space at the click (the
     click inside it side to side), or with no open space there at the click, what is in its way moved clear. Made from
     the desktop, it never opens over a window (lead). Read after any of that moving. */
  const others = await evaluate(app, `[...document.querySelectorAll('.win')].filter((e) => e.offsetParent && e.dataset.id !== ${JSON.stringify(sh.id)}).map((e) => __ui.r(e))`);
  const hit = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
  const over = (a) => others.some((b) => hit(a, b));
  // fitAt can leave the click up to the gap (GAP_X, 1.2% of the view) outside the window's side
  const gx = 0.012 * (await evaluate(app, 'document.getElementById("viewport").getBoundingClientRect().width')) * ((await st(app)).ws[0].zoom || 1);
  const atClick = Math.abs(g.win.x - p.x) < 4, inOpen = g.win.x - gx <= p.x && p.x <= g.win.x + g.win.w + gx;
  R.ok('new shell here: it opens where the right-click was, or in the open space there, over no window', !over(g.win) && (over({ ...g.win, x: p.x }) ? atClick || inOpen : atClick) && g.win.y >= p.y - 2 && g.win.y - p.y < 60,
    { click: p, win: { x: g.win.x, y: g.win.y, w: g.win.w, h: g.win.h }, spotTaken: over({ ...g.win, x: p.x }), under: others.filter((b) => hit(g.win, b)) });
  const cmd = await paneCmd(sh.id);
  R.ok('new shell here: tmux runs a login zsh, not claude', /zsh -il/.test(cmd) && !/claude/.test(cmd), cmd);
  await waitFor(app, `(() => { const t = __flow.term(${JSON.stringify(sh.id)}); return !!t && t.getText().trim().length > 0; })()`, 15000, 300);
  // until a program titles it, a new shell is "shell" and its folder (not the machine's name, tmux's default title)
  const folder = sh.cwd.replace(/^\/home\/claude(?=\/|$)/, '~');
  const named = await evaluate(app, `(() => { const t = __ui.win(${JSON.stringify(sh.id)}).querySelector('.tb .title'); return { tt: t.querySelector('.tt').textContent, where: t.querySelector('.where').textContent }; })()`);
  R.ok('new shell here: titled "shell" and its folder until a program sets a title', named.tt === 'shell' && named.where === folder, { named, folder });
  await click(app, g.win.cx, g.win.cy);
  await type(app, 'echo flow-shell-$((6*7))');
  await key(app, 'Enter');
  const out = await waitFor(app, `(() => { const t = __flow.term(${JSON.stringify(sh.id)}); return t && t.getText().includes('flow-shell-42') ? 'flow-shell-42' : ''; })()`, 8000, 300);
  R.ok('new shell here: typing a command and Enter runs it in the shell', out === 'flow-shell-42', out);
  // a title with Claude's ✳ in front: the title bar shows only the text (the sleep keeps the shell's prompt from retitling)
  await type(app, "printf '\\033]0;\\342\\234\\263 flow-title-check\\007'; sleep 4");
  await key(app, 'Enter');
  const tt = await waitFor(app, `(() => { const t = document.querySelector('.win[data-id="${sh.id}"] > .tb .title'); return t && /flow-title-check/.test(t.textContent) ? t.textContent : ''; })()`, 6000, 200);
  R.ok('a terminal title with Claude\'s ✳ in front shows only its text', tt === 'flow-title-check', tt);
  await shot(app, path.join(SHOTS, '28-new-shell-app.png'));
  R.ok('new shell here: closing it and its × end the shell', await closeAndEnd(app, sh.id));
  // a window is not the desktop (the note in front first: earlier scenarios leave windows that can lie over it)
  const wr = await evaluate(app, '__ui.row("note|n-week")');
  if (wr) { await click(app, wr.cx, wr.cy); await sleep(600); }
  const wt = await parts(app, 'w-week');
  const under = await evaluate(app, `(() => { const h = document.elementFromPoint(${wt.tb.cx}, ${wt.tb.cy}); return h ? ((h.closest('.win') || {}).dataset || {}).id || h.className : null; })()`);
  await rightClick(app, wt.tb.cx, wt.tb.cy);
  await sleep(250);
  R.ok('right-clicking a note window does not open the desktop menu', under === 'w-week' && !(await evaluate(app, `[...document.querySelectorAll('.ctx button')].some((b) => /^new /.test(b.textContent))`)), under);
  // one menu per tool: a window's right-click menu is the one on its sidebar row
  const winItems = await evaluate(app, `[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`);
  await key(app, 'Escape');
  await sleep(150);
  const nr = await evaluate(app, '__ui.row("note|n-week")');
  await rightClick(app, nr.cx, nr.cy);
  await sleep(250);
  const rowMenu = await evaluate(app, `[...document.querySelectorAll('.ctx button')].map((b) => b.textContent)`);
  R.ok('a note window\'s right-click menu is the one on its sidebar row', winItems.length > 0 && JSON.stringify(winItems) === JSON.stringify(rowMenu), { window: winItems, row: rowMenu });
  await key(app, 'Escape');
});

scenario('teams', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  let tid = ctx.teamId;
  if (!tid) {
    const ids0 = await evaluate(app, '__flow.windows().map((w) => w.id)');
    await dockClick(app, 'team');
    await sleep(1500);
    const t = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'team' && !ids0.includes(w.id));
    tid = t && t.id;
  }
  R.ok('a local team window from the dock', !!tid && hasSession(tid), tid);
  if (!tid) return;
  await inView(app, tid, ':scope > .tb .act');
  const tp = await parts(app, tid);
  await click(app, tp.act.cx, tp.act.cy);
  await sleep(400);
  const tn = await evaluate(app, `(() => { const w = __ui.win(${JSON.stringify(tid)}); const n = w.querySelector('.tnote'); return { noted: w.classList.contains('noted'), shown: getComputedStyle(n).display !== 'none', focus: document.activeElement === n.querySelector('.ned'), side: n.getBoundingClientRect().left > w.querySelector('.termhost').getBoundingClientRect().left }; })()`);
  R.ok('✎ on a team opens the team note beside it (the one ✎ pane), with the cursor in it', tn.noted && tn.shown && tn.focus && tn.side, tn);
  await click(app, tp.act.cx, tp.act.cy);
  await sleep(300);
  // a second pane in the team's tmux window, on ui's own socket
  tmux('split-window', '-t', `flow_${tid}`, '-h', '-c', '/tmp', '/bin/sh');
  tmux('select-pane', '-t', `flow_${tid}.0`);
  const panes = () => (tmux('list-panes', '-t', `flow_${tid}`, '-F', '#{pane_id}') || '').split('\n').filter(Boolean);
  R.ok('tmux split-window gives the team two panes', panes().length === 2, panes());
  // the note pane can pan the space and leave the team partly out of view: its row brings it back before any drag
  const trow = await evaluate(app, `__ui.row("win|${tid}")`);
  if (trow) { await click(app, trow.cx, trow.cy); await sleep(700); }
  const handles = await waitFor(app, `(() => { const v = document.getElementById('viewport').getBoundingClientRect(); const h = [...__ui.win(${JSON.stringify(tid)}).querySelectorAll('.fterm-mate')];
    return h.length === 2 && h.every((x) => { const b = x.getBoundingClientRect(); return b.left >= v.left && b.right <= v.right; }) ? h.map((x) => __ui.r(x)) : null; })()`, 8000, 300);
  R.ok('the team window draws a grab handle on each pane, in view', !!handles, handles || await evaluate(app, `[...__ui.win(${JSON.stringify(tid)}).querySelectorAll('.fterm-mate')].map((x) => __ui.r(x))`));
  if (!handles) return;
  const tw = await parts(app, tid);
  const mate = handles.reduce((a, b) => (b.x > a.x ? b : a));
  const lead = handles.reduce((a, b) => (b.x < a.x ? b : a));
  // the lead stays
  await drag(app, { x: lead.cx, y: lead.cy }, { x: tw.win.x - 60, y: tw.win.y + 40 });
  await sleep(500);
  R.ok('the lead cannot be dragged out', /the lead stays with its team/.test(await evaluate(app, '__ui.toast()')) && panes().length === 2);
  // drop the teammate outside the team: it becomes its own window
  const ids0 = await evaluate(app, '__flow.windows().map((w) => w.id)');
  const drop = { x: tw.win.x - 40 > 280 ? tw.win.x - 40 : tw.win.x + tw.win.w + 60, y: tw.win.y + 60 };
  await drag(app, { x: mate.cx, y: mate.cy }, drop, { steps: 16 });
  await sleep(1800);
  const loose = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'term' && !ids0.includes(w.id));
  R.ok('dragging a teammate out makes it its own window', !!loose, loose);
  R.ok('…as its own tmux session, and the team is down to one pane', !!loose && hasSession(loose.id) && panes().length === 1, { session: loose && hasSession(loose.id), panes: panes().length });
  await shot(app, path.join(SHOTS, '18-break-app.png'));
  if (!loose) return;
  // drop that terminal on the team: it keeps its own window and session and sits beside the team, grouped with it
  // (orch's teams.js; the owner's teams are separate windows, "agent of the teams are ACTUALLY a different terminal")
  await sleep(1200);
  const lw = await parts(app, loose.id);
  const tw2 = await parts(app, tid);
  const from = grabPoint(lw);
  await mouse(app, 'mouseMoved', from.x, from.y);
  await mouse(app, 'mousePressed', from.x, from.y);
  for (let i = 1; i <= 16; i++) await mouse(app, 'mouseMoved', from.x + ((tw2.win.cx - from.x) * i) / 16, from.y + ((tw2.win.cy - from.y) * i) / 16, { down: true });
  R.ok('a terminal over a team window outlines the team', await evaluate(app, `__ui.win(${JSON.stringify(tid)}).classList.contains('dropon')`));
  await mouse(app, 'mouseReleased', tw2.win.cx, tw2.win.cy);
  await sleep(1800);
  const kept = winIn(await st(app), loose.id);
  const tw3 = winIn(await st(app), tid).w;
  R.ok('dropping a terminal on a team keeps its own window and session, grouped with the team (teams.js places it)', !!kept && kept.w.group === tid && hasSession(loose.id) && panes().length === 1,
    { group: kept && kept.w.group, session: hasSession(loose.id), panes: panes().length, team: { x: tw3.x, y: tw3.y, w: tw3.w, h: tw3.h }, it: kept && { x: kept.w.x, y: kept.w.y, w: kept.w.w, h: kept.w.h } });
  const fold = await evaluate(app, `__ui.r(document.querySelector('.tr[data-act="win|${tid}"] .g[data-tog]'))`);
  const folded = !!fold && !(await evaluate(app, `!!document.querySelector('.tr[data-act="win|${loose.id}"]')`));
  if (fold) { await click(app, fold.cx, fold.cy); await sleep(300); }
  R.ok('…and the sidebar folds it under the team, listed there once ▸ opens it', folded && await evaluate(app, `(() => { const r = document.querySelector('.tr[data-act="win|${loose.id}"]'); return !!r && r.classList.contains('d1') && document.querySelectorAll('.tr[data-act="win|${loose.id}"]').length === 1; })()`), { folded });
  await shot(app, path.join(SHOTS, '19-drop-on-team-app.png'));
  if (ctx.mock) {
    const tr = await evaluate(ctx.mock, '__ui.row("win|w-team")');
    if (tr) { await click(ctx.mock, tr.cx, tr.cy); await sleep(900); }
    const team = await parts(ctx.mock, 'team flow');
    const mtb = await evaluate(ctx.mock, '__ui.r([...document.querySelectorAll(".mini")].find((m) => m.textContent.includes("backlog")).querySelector(".mtb"))');
    await drag(ctx.mock, { x: mtb.cx, y: mtb.cy }, { x: team.win.x + team.win.w + 80 < 1450 ? team.win.x + team.win.w + 80 : 700, y: team.win.y + team.win.h + 60 }, { steps: 16 });
    await sleep(800);
    await shot(ctx.mock, path.join(SHOTS, '18-break-mockup.png'));
  }
});

scenario('sidebar', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  // groups fold
  const notesHdr = await evaluate(app, '__ui.r([...document.querySelectorAll("#sblist .grp")].find((g) => g.textContent === "notes"))');
  await click(app, notesHdr.cx, notesHdr.cy);
  await sleep(200);
  R.ok('clicking a group folds it', await evaluate(app, '[...document.querySelectorAll("#sblist .grp")].find((g) => g.textContent === "notes").classList.contains("closed") && !document.querySelector(\'.tr[data-act="note|n-week"]\')'));
  const nh = await evaluate(app, '__ui.r([...document.querySelectorAll("#sblist .grp")].find((g) => g.textContent === "notes"))');
  await click(app, nh.cx, nh.cy);
  await sleep(200);
  // sections fold: the seed's reading list is a section of saved pages
  let f = await evaluate(app, '__ui.row("sec|f-read")');
  await click(app, f.cx, f.cy);
  await sleep(200);
  R.ok('clicking a section folds it', await evaluate(app, '/▸/.test(__ui.rowText("sec|f-read")) && !document.querySelector(\'.tr[data-act^="saved|"]\')'));
  if (ctx.mock) {
    const mf = await evaluate(ctx.mock, '__ui.row("folder|f-read")');
    if (mf) { await click(ctx.mock, mf.cx, mf.cy); await sleep(200); }
  }
  await pair(ctx, '20-sidebar-folder');
  f = await evaluate(app, '__ui.row("sec|f-read")');
  await click(app, f.cx, f.cy);
  await sleep(200);
  R.ok('clicking it again unfolds it', await evaluate(app, '!!document.querySelector(\'.tr[data-act^="saved|"]\')'));
  if (ctx.mock) {
    const mf = await evaluate(ctx.mock, '__ui.row("folder|f-read")');
    if (mf) { await click(ctx.mock, mf.cx, mf.cy); await sleep(200); }
  }
  // a closed note opens from the sidebar
  const d = await evaluate(app, '__ui.row("note|n-design")');
  await click(app, d.cx, d.cy);
  await sleep(800);
  R.ok('clicking a closed note opens it', (await evaluate(app, '__flow.windows()')).some((w) => w.noteId === 'n-design'));
  // a row of a window in a sub-workspace takes you into that space, to the window
  const zt = await evaluate(app, '__ui.r(document.querySelector(\'.tr[data-act="zone|z-research"] .g[data-tog]\'))');
  if (zt && /▸/.test(await evaluate(app, '__ui.rowText("zone|z-research")'))) { await click(app, zt.cx, zt.cy); await sleep(300); }
  const sp = await evaluate(app, '__ui.row("tab|w-kv|0")');
  await click(app, sp.cx, sp.cy);
  await sleep(900);
  const there = await evaluate(app, '({ pill: document.querySelectorAll(".sp")[0].textContent, front: __ui.win("w-kv").classList.contains("front"), shown: getComputedStyle(__ui.win("w-kv")).display !== "none" })');
  R.ok('clicking the row of a window in a sub-workspace goes into that space, to the window', /› research/.test(there.pill) && there.front && there.shown, there);
  const back = await evaluate(app, '__ui.pill(0)');
  await click(app, back.cx, back.cy);
  await sleep(600);
  // double-click an agent row renames it in place
  const ar = await evaluate(app, '__ui.row("win|w-design")');
  await dblclick(app, ar.cx, ar.cy);
  await sleep(300);
  const ed = await evaluate(app, 'document.activeElement && document.activeElement.classList.contains("rn") && document.activeElement.closest(".tr") ? document.activeElement.textContent : null');
  R.ok('double-clicking an agent row puts its name into rename', ed === 'design: workspaces', ed);
  await type(app, 'design two');
  await key(app, 'Enter');
  await sleep(300);
  let s = await st(app);
  R.ok('Enter saves the agent name, in the sidebar and the title bar', winIn(s, 'w-design').w.title === 'design two' && /design two/.test(await evaluate(app, '__ui.win("w-design").querySelector(".tb .title").textContent')));
  const ar2 = await evaluate(app, '__ui.row("win|w-design")');
  await dblclick(app, ar2.cx, ar2.cy);
  await sleep(300);
  await type(app, 'zzz');
  await key(app, 'Escape');
  await sleep(300);
  s = await st(app);
  R.ok('Esc cancels the agent rename', winIn(s, 'w-design').w.title === 'design two');
  // hide and show the sidebar
  const col = await evaluate(app, '__ui.r(document.getElementById("collapse"))');
  await click(app, col.cx, col.cy);
  await sleep(500);
  R.ok('‹ hides the sidebar', await evaluate(app, 'document.getElementById("sb").classList.contains("hide")'));
  await shot(app, path.join(SHOTS, '21-sidebar-hidden-app.png'));
  await blur(app);
  await key(app, '\\', MOD.meta);
  await sleep(500);
  R.ok('⌘\\ shows it again', await evaluate(app, '!document.getElementById("sb").classList.contains("hide")'));
  // no help button or card (the owner: "why am i seeing question mark there"); ? types nothing anywhere
  await blur(app);
  await key(app, '?');
  await sleep(200);
  R.ok('there is no ? button or help card, and ? opens nothing', await evaluate(app, '!document.getElementById("helpbtn") && !document.getElementById("help") && !document.querySelector(".help, .qbtn")'));
});

scenario('modes', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 1);
  const m = (k) => evaluate(app, `__ui.r(document.querySelector('#modes [data-m="${k}"]'))`);
  let b = await m('grid');
  await click(app, b.cx, b.cy);
  await sleep(700);
  R.ok('grid lays the windows out in a grid', (await st(app)).ws.find((w) => w.id === 'mynotes').mode === 'grid');
  await pair(ctx, '23-grid', false);
  b = await m('float');
  await click(app, b.cx, b.cy);
  await sleep(700);
  R.ok('float puts them back', (await st(app)).ws.find((w) => w.id === 'mynotes').mode === 'float');
  await goPill(app, 0);
});

/* Electron 45 checks of the wiring around webviews and the main-process console log. */
/* A page window holds only the page; its note sits in a side panel behind ✎, closed by default (the owner's words). */
/* The dock hides until the pointer reaches the bottom middle (the owner: "why is it constantly there?"). */
scenario('dock-hide', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const v = await evaluate(app, '__ui.r(document.getElementById("viewport"))');
  await mouse(app, 'mouseMoved', v.cx, v.y + 200);
  await sleep(600);
  const st0 = await evaluate(app, '(() => { const d = document.getElementById("dock"); const c = getComputedStyle(d); return { vis: c.visibility, op: c.opacity, pe: c.pointerEvents }; })()');
  R.ok('dock: hidden while the pointer is away from the bottom middle', st0.vis === 'hidden' && st0.pe === 'none', st0);
  const d = await evaluate(app, '__ui.r(document.getElementById("dock"))');
  await mouse(app, 'mouseMoved', d.cx, v.y + v.h - 3);
  await sleep(400);
  const st1 = await evaluate(app, '(() => { const d = document.getElementById("dock"); const c = getComputedStyle(d); return { vis: c.visibility, op: c.opacity, pe: c.pointerEvents }; })()');
  R.ok('dock: the pointer at the bottom middle brings it up', st1.vis === 'visible' && st1.pe !== 'none' && +st1.op > 0.9, st1);
  await shot(app, path.join(SHOTS, '32-dock-up-app.png'));
  await mouse(app, 'mouseMoved', v.cx, v.y + 200);
  await sleep(800);
  const st2 = await evaluate(app, 'getComputedStyle(document.getElementById("dock")).visibility');
  R.ok('dock: it goes again once the pointer leaves', st2 === 'hidden', st2);
  // a flick: up from the bottom strip onto a button in one fast step, then a click; the click works
  const nb = await evaluate(app, `__ui.r(document.querySelector('#dock [data-k="note"]'))`);
  const had = new Set((await evaluate(app, '__flow.windows()')).map((w) => w.id));
  await mouse(app, 'mouseMoved', nb.cx, v.y + v.h - 3);
  await sleep(300);
  await waitFor(app, `(() => { const d = document.getElementById('dock'); return getComputedStyle(d).visibility !== 'hidden' && d.style.opacity !== '0'; })()`, 3000, 100);
  await click(app, nb.cx, nb.cy);
  await sleep(800);
  const flick = (await evaluate(app, '__flow.windows()')).find((w) => !had.has(w.id));
  R.ok('dock: one fast step up onto a button (' + Math.round(v.y + v.h - 3 - nb.cy) + ' px), then a click, opens it', !!flick && flick.type === 'note', flick);
  if (flick) {
    const fp = await parts(app, flick.id);
    await click(app, fp.close.cx, fp.close.cy);
    await sleep(300);
  }
});

/* Right-click a workspace's name: preset gradients, previewed as you point at them; a click keeps one. */
scenario('ws-menu', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 1);
  const bg0 = (await st(app)).ws[1].bg;
  const pill = await evaluate(app, '__ui.pill(1)');
  await rightClick(app, pill.cx, pill.cy);
  await sleep(300);
  const menu = await evaluate(app, '(() => { const m = document.querySelector(".wsm"); return m ? { swatches: m.querySelectorAll(".bs button").length, rows: [...m.querySelectorAll(".row")].map((r) => r.textContent) } : null; })()');
  R.ok('ws menu: right-clicking a workspace name offers backgrounds, folder and rename', !!menu && menu.swatches >= 8 && menu.rows.some((r) => /^folder/.test(r)) && menu.rows.some((r) => /^rename/.test(r)), menu);
  if (!menu) return;
  const sw = await evaluate(app, '__ui.r(document.querySelectorAll(".wsm .bs button")[6])');
  await mouse(app, 'mouseMoved', sw.cx, sw.cy);
  await sleep(250);
  const preview = await evaluate(app, 'document.querySelector(\'.ws[data-id="mynotes"]\').style.background');
  R.ok('ws menu: pointing at a gradient shows it on the workspace', preview && preview !== bg0, preview.slice(0, 60));
  await shot(app, path.join(SHOTS, '33-ws-menu-app.png'));
  await key(app, 'Escape');
  await sleep(250);
  R.ok('ws menu: Esc puts the old background back', (await evaluate(app, 'document.querySelector(\'.ws[data-id="mynotes"]\').style.background')) !== preview && (await st(app)).ws[1].bg === bg0);
  await rightClick(app, pill.cx, pill.cy);
  await sleep(300);
  const sw2 = await evaluate(app, '__ui.r(document.querySelectorAll(".wsm .bs button")[6])');
  await click(app, sw2.cx, sw2.cy);
  await sleep(400);
  const bg1 = (await st(app)).ws[1].bg;
  R.ok('ws menu: a click keeps it, saved to the workspace', bg1 !== bg0 && !(await evaluate(app, '!!document.querySelector(".wsm")')), bg1.slice(0, 60));
});

scenario('page-note', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const pr = await evaluate(app, '__ui.row("tab|w-mck|0")');
  await click(app, pr.cx, pr.cy);
  await sleep(600);
  const pw = await parts(app, 'w-mck');
  const id = JSON.stringify('w-mck');
  const closed = await evaluate(app, `(() => { const w = __ui.win(${id}); const n = w.querySelector('.anote'); const pg = w.querySelector('.pgc').getBoundingClientRect(), body = w.querySelector('.body').getBoundingClientRect(); return { title: !!w.querySelector('.ptitle'), noteShown: !!n && getComputedStyle(n).display !== 'none', pen: !!w.querySelector(':scope > .tb [data-act="note"]'), full: Math.abs(pg.width - body.width) < 2 }; })()`);
  R.ok('page note: a page window holds only the page (no title editor, note closed, the page spans the window)', !closed.title && !closed.noteShown && closed.full, closed);
  R.ok('page note: its title bar has ✎', closed.pen);
  await shot(app, path.join(SHOTS, '30-page-note-closed-app.png'));
  await click(app, pw.act.cx, pw.act.cy);
  await sleep(400);
  const open = await evaluate(app, `(() => { const w = __ui.win(${id}); const n = w.querySelector('.anote'); return { shown: getComputedStyle(n).display !== 'none', focus: document.activeElement === w.querySelector('.anote .ned'), text: w.querySelector('.anote .ned').textContent }; })()`);
  R.ok('page note: ✎ opens the note beside the page, with the cursor in it and the old note text', open.shown && open.focus && /judgment is the bottleneck/.test(open.text), { ...open, text: open.text.slice(0, 40) });
  await key(app, 'End', MOD.ctrl);
  await type(app, ' read again.');
  await sleep(500);
  // the page's note is the page's own record (notes' pages, keyed by its address), where the old note text moved
  const rec = Object.values((await st(app)).pages || {}).find((r) => /judgment is the bottleneck/.test(r.note || ''));
  const body = rec && rec.note;
  R.ok('page note: typing in it saves to the page\'s note', /read again\.\s*$/.test(body || ''), (body || '').slice(-40));
  await shot(app, path.join(SHOTS, '31-page-note-open-app.png'));
  await click(app, pw.act.cx, pw.act.cy);
  await sleep(300);
  R.ok('page note: ✎ again closes it', await evaluate(app, `getComputedStyle(__ui.win(${id}).querySelector('.anote')).display === 'none'`));
});

scenario('page-events', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  // with a page window in front, the dock's page button opens a tab in it (⌘T does the same)
  const mr = await evaluate(app, '__ui.row("tab|w-mck|0")');
  if (mr) { await click(app, mr.cx, mr.cy); await sleep(600); }
  const tabs0 = await evaluate(app, '__flow.page("w-mck").tabs().tabs.length');
  await dockClick(app, 'page');
  await sleep(800);
  const tabs1 = await evaluate(app, '__flow.page("w-mck").tabs()');
  R.ok('page: with a page window in front, the dock\'s page button opens a new tab in it', tabs1.tabs.length === tabs0 + 1 && tabs1.tab === tabs1.tabs.length - 1, { before: tabs0, after: tabs1.tabs.length, shown: tabs1.tab });
  const mckTitle = () => evaluate(app, '__ui.win("w-mck").querySelector(".tb .title").textContent');
  R.ok('page: with two tabs the title bar shows no title (the tab strip has them)', (await mckTitle()) === '', await mckTitle());
  await shot(app, path.join(SHOTS, '34-new-tab-app.png'));
  // ⌘W closes that tab, not the window
  await evaluate(app, '__flow.menu("close-window")');
  await sleep(400);
  R.ok('page: ⌘W (close-window) closes the tab, not the window', (await evaluate(app, '__flow.page("w-mck").tabs().tabs.length')) === tabs0 && (await evaluate(app, '__flow.windows()')).some((w) => w.id === 'w-mck'));
  R.ok('page: back to one tab, the title bar has the page\'s title again', tabs0 > 1 || (await mckTitle()) !== '', await mckTitle());
  // with no page window in front, a new page window
  const wr = await evaluate(app, '__ui.row("note|n-week")');
  if (wr) { await click(app, wr.cx, wr.cy); await sleep(600); }
  const ids0 = await evaluate(app, '__flow.windows().map((w) => w.id)');
  await dockClick(app, 'page');
  await sleep(800);
  const pw = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'page' && !ids0.includes(w.id));
  R.ok('page: a new page window with the address focused', !!pw && await evaluate(app, 'document.activeElement && document.activeElement.classList.contains("ad")'));
  if (!pw) return;
  await type(app, 'example.com');
  await key(app, 'Enter');
  // the address reaches the window's note; the title stays with the tab (one name per page: notes' name, else the tab's title)
  const done = await waitFor(app, `(() => { const s = __flow.state(); for (const ws of s.ws) { const n = ws.notes.find((x) => x.id === ${JSON.stringify(pw.noteId)}); const w = ws.windows.find((x) => x.id === ${JSON.stringify(pw.id)}); const t = w && Array.isArray(w.tabs) ? w.tabs[w.tab || 0] : null; if (n && /example\.com/.test(n.url) && t && t.title === 'Example Domain') return { url: n.url, tab: t.title }; } return null; })()`, 20000, 300);
  R.ok('page: the webview navigation reaches the note (url) and the tab (the page\'s title)', !!done, done);
  const follow = await waitFor(app, `(() => { const t = __ui.win(${JSON.stringify(pw.id)}).querySelector('.tb .title').textContent; const r = __ui.rowText("tab|${pw.id}|0") || ''; return t === 'Example Domain' && /Example Domain/.test(r) ? { title: t, row: r } : null; })()`, 3000, 200);
  R.ok('page: the window title and the sidebar follow', !!follow, follow || { title: await evaluate(app, `__ui.win(${JSON.stringify(pw.id)}).querySelector('.tb .title').textContent`), row: await evaluate(app, `__ui.rowText("tab|${pw.id}|0")`) });
  // a page that closes itself (window.close() in its last tab) takes its window with it
  await guestEval(/example\.com/, 'setTimeout(() => window.close(), 50), 1');
  const closedSelf = await waitFor(app, `!__flow.windows().some((w) => w.id === ${JSON.stringify(pw.id)})`, 5000);
  R.ok('page: a page that closes itself in its last tab closes its window', closedSelf);
  if (!closedSelf) {
    const p = await parts(app, pw.id);
    await click(app, p.close.cx, p.close.cy);
    await sleep(300);
  }
});

/* A wheel over a page behind another window scrolls that page (the shield over it keeps only clicks). */
scenario('back-page', async (ctx) => {
  const app = ctx.app;
  await goPill(app, 0);
  const wr = await evaluate(app, '__ui.row("note|n-week")');
  if (wr) { await click(app, wr.cx, wr.cy); await sleep(600); }
  const ids0 = await evaluate(app, '__flow.windows().map((w) => w.id)');
  // a new page right here, in view beside "this week": what is in its way makes way, and the view stays
  const ep = await emptySpot(app);
  await rightClick(app, ep.x, ep.y);
  await sleep(250);
  const np = await evaluate(app, `__ui.r([...document.querySelectorAll('.ctx button')].find((b) => /^new page here/.test(b.textContent)))`);
  if (np) { await click(app, np.cx, np.cy); await sleep(800); }
  const pw = (await evaluate(app, '__flow.windows()')).find((w) => w.type === 'page' && !ids0.includes(w.id));
  if (!R.ok('back-page: a new page window', !!pw)) return;
  await type(app, 'en.wikipedia.org/wiki/Tmux');
  await key(app, 'Enter');
  const loaded = await waitFor(app, `(() => { const p = __flow.page(${JSON.stringify(pw.id)}); return !!p && !p.isLoading() && /tmux/i.test(p.getTitle() || ''); })()`, 40000, 300);
  if (!R.ok('back-page: a long page loads (Wikipedia, tmux)', loaded)) return;
  await sleep(800);
  // another window to the front, by its title bar, away from the page: one in view (what made way for the page may have
  // moved out of it), else "this week" brought to it
  const g = await parts(app, pw.id);
  const other = await evaluate(app, `(() => {
    const v = document.getElementById('viewport').getBoundingClientRect();
    for (const w of document.querySelectorAll('.ws[data-id="flow"] .win')) {
      const t = w.dataset.id !== ${JSON.stringify(pw.id)} && w.offsetParent && w.querySelector(':scope > .tb');
      if (!t) continue;
      const r = t.getBoundingClientRect(), x = r.left + 30, y = r.top + r.height / 2;
      if (x < v.left || x > v.right || y < v.top || y > v.bottom) continue;
      const h = document.elementFromPoint(x, y);
      if (h && w.contains(h)) return { id: w.dataset.id, x, y };
    }
    return null;
  })()`);
  if (other) await click(app, other.x, other.y);
  else {
    await inView(app, 'w-week', ':scope > .tb', 'note|n-week');
    const wk = await parts(app, 'w-week');
    await click(app, wk.tb.x + 30, wk.tb.cy);
  }
  await sleep(400);
  const front = await evaluate(app, `[...document.querySelectorAll('.ws[data-id="flow"] .win.front')].map((w) => w.dataset.id)`);
  R.ok('back-page: the page window is behind another window', !front.includes(pw.id), front);
  const y0 = await guestEval(/wikipedia\.org\/wiki\/Tmux/i, 'Math.round(scrollY)');
  const at = await evaluate(app, `(() => { const b = __ui.win(${JSON.stringify(pw.id)}).querySelector('.pgv').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, hit: (document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) || {}).className }; })()`);
  const space0 = await evaluate(app, '__flow.state().ws[0].at || null');
  for (let i = 0; i < 6; i++) { await wheel(app, at.x, at.y, 0, 200); await sleep(60); }
  await sleep(900);
  const y1 = await guestEval(/wikipedia\.org\/wiki\/Tmux/i, 'Math.round(scrollY)');
  R.ok('back-page: a wheel over it scrolls the page', typeof y0 === 'number' && typeof y1 === 'number' && y1 > y0 + 300, { y0, y1, at });
  const front2 = await evaluate(app, `[...document.querySelectorAll('.ws[data-id="flow"] .win.front')].map((w) => w.dataset.id)`);
  R.ok('back-page: and leaves it behind, in the same space', !front2.includes(pw.id) && (await evaluate(app, '__flow.state().ws[0].at || null')) === space0, { front: front2 });
  // a sideways two-finger swipe over it still steps to the next space (the page hears it first, as in front)
  await swipe(app, at.x, at.y, [8, 18, 30, 42, 46, 40, 34, 28, 22, 18, 14, 11, 9, 7, 5, 4, 3, 2, 2, 1]);
  const stepped = await waitFor(app, '__flow.state().ws[0].at === "z-research"', 4000);
  R.ok('back-page: a sideways swipe over it goes to the next sub-workspace', stepped, await evaluate(app, '__flow.state().ws[0].at || null'));
  if (stepped) await goPill(app, 0);
  const p = await parts(app, pw.id);
  const hit = await evaluate(app, `(() => { const h = document.elementFromPoint(${p.close.cx}, ${p.close.cy}); return h ? (h.dataset && h.dataset.l) || h.className : null; })()`);
  await click(app, p.close.cx, p.close.cy);
  // red asks the page first (confirmClose: one round trip to main per live tab), so the window goes a moment later
  const gone = await waitFor(app, `!__flow.windows().some((w) => w.id === ${JSON.stringify(pw.id)})`, 5000, 150);
  R.ok('back-page: red closes the page window', gone, { hit });
});

scenario('console-log', async (ctx) => {
  const marker = `ui-console-probe-${Date.now()}`;
  /* The error is on line 3 of a script named by sourceURL, so the logged source and line are checked as well. */
  await evaluate(ctx.app, `console.warn(${JSON.stringify(`${marker}-warn`)});\n\nconsole.error(${JSON.stringify(marker)});\n//# sourceURL=ui-console-probe.js`);
  await sleep(500);
  const log = fs.existsSync(`${LOGS}/app.log`) ? fs.readFileSync(`${LOGS}/app.log`, 'utf8') : '';
  const lines = log.split('\n').filter((l) => l.includes(marker));
  const line = lines.find((l) => !l.includes(`${marker}-warn`));
  R.ok('main logs a renderer console.error with its text, source and line', !!line && /^\[flow renderer \d+\] /.test(line) && line.endsWith(`] ${marker} (ui-console-probe.js:3)`), line);
  R.ok('main leaves a renderer console.warn out of its log', !!line && !lines.some((l) => l.includes(`${marker}-warn`)), lines);
  /* Runtime.enable replays the page's earlier console messages, so probes from earlier --any-state runs show up too. */
  ctx.app.errors = ctx.app.errors.filter((e) => !/ui-console-probe-\d+/.test(e));
});

/* ---------------------------------------------------------------- */
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = await connectTo(PORT, /\/src\/index\.html$/);
  /* ui-dev.sh start returns once CDP answers, which can be before app.js has run. */
  if (!(await waitFor(app, '!!window.__flow', 30000, 200))) throw new Error('window.__flow did not show up in the app within 30 s');
  await evaluate(app, 'window.__flow.ready');
  const fresh = await evaluate(app, '(() => { const s = __flow.state(); const f = s.ws.find((w) => w.id === "flow"); const w = f && f.windows.find((x) => x.id === "w-week"); return s.ws.length === 5 && !!w && Math.abs(w.x - 1.2) < 0.01; })()');
  if (!fresh && !args.includes('--any-state')) {
    console.error('the suite expects the first-run state: run test/ui-dev.sh stop && test/ui-dev.sh start --fresh (or pass --any-state)');
    process.exit(2);
  }
  await setup(app);
  let mock = null;
  if (!noMock) { mock = await connectTo(MOCK_PORT, 'workspaces-mockup.html'); await setup(mock); }
  const ctx = { app, mock };
  for (const sc of SCEN) {
    if (only && !only.includes(sc.name)) continue;
    console.log(`\n== ${sc.name}`);
    try {
      await sc.fn(ctx);
    } catch (err) {
      R.ok(`${sc.name} ran to the end`, false, String(err && err.stack || err).split('\n').slice(0, 3).join(' | '));
    }
  }
  /* The VM team windows cannot reach claude-agents from the VM itself (expected here); warnings are listed, not failed. */
  const vmOnly = /Host key verification failed|could not list the panes of (w-team|mn-team)|flow\.term\.panes failed for (w-team|mn-team)/;
  /* Expected until installed lands flow.term.teammate (orch's teams.js says so once); printed as a note, not a failure. */
  const pending = /flow\.term\.teammate is missing \(preload\)/;
  app.errors.filter((e) => pending.test(e)).forEach((e) => console.log(`note app (pending in main) ${e.slice(0, 160)}`));
  const errs = app.errors.filter((e) => !e.startsWith('console.warning') && !vmOnly.test(e) && !pending.test(e));
  app.errors.filter((e) => e.startsWith('console.warning') && !vmOnly.test(e)).forEach((w) => console.log(`note app ${w.split('\n')[0].slice(0, 160)}`));
  R.ok('no new console errors or exceptions in the app during the run', errs.length === 0, errs.slice(0, 5));
  R.summary();
  process.exit();
}
main();




