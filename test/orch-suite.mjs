// orch's suite on the wired tree: teams (src/teams.js) and "runs on the VM", in orch's isolation only (socket
// flow-dev-orch, userData /tmp/flow-dev-orch, CDP 9569, inspector 9669, cwd under /home/claude/.flow-dev/orch).
//   A. node test/orch-teams-test.mjs: teams.js rules in a vm context (attach sessions untouched, early panes, link
//      ended, runsOn, the menu rows).
//   B. A stand-in VM (test/orch-standin-vm.cjs; ssh to flow-test.local runs here with its own HOME and private tmux
//      sockets, never the default server): a VM workspace's new terminal runs on Flow's socket there in its folder, a Mac
//      workspace's stays here, and the workspace menu's "runs on" and folder rows.
//   C. Real claude teammates (tiny prompts): each teammate gets its own window with its session id, one poller for what
//      is on screen, a terminal dropped on a team stays its own, a pane dragged out of a zoomed space lands at the drop
//      point, and after a reboot every teammate resumes its own conversation and says the team link ended.
//   D. Batch 2 (B7): one corner drag of a terminal window sends its pty one resize, not one per step.
//   E. Batch 3, real claude: a team carried from the dock, pinched out far over its lead (the lead gets no
//      input and keeps its size), its teammates arriving far out, a teammate's sidebar row from far out, agents carried
//      into the gap beside the team and to the right side, and one carried in a VM workspace on the stand-in VM.
//   F. Quit and reopen with a team, real claude: a quit right after the teammates get their windows, a closed teammate
//      across a quit, a teammate ended then brought back (undo, reopen) and a quit after it, and the lead ended then
//      brought back. Every claude is counted: one per conversation, none left of what was ended.
// usage: [ORCH_ROOT=<tree>] node test/orch-suite.mjs [A] [B] [C] [D] [E] [F]   (A, B and C by default; ORCH_ROOT runs the app
// from that tree, by default the one these files are in). Prints ok/FAIL per check; exit 1 on a failure.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { launch, connect, quit, killTmux, tmuxTry, pids, USER_DATA, SHOTS, ROOT, SOCKET } from './orch-lib.mjs';
import { evaluate, click, drag, mouse, key, type, shot, sleep } from './ui-lib.mjs';

const want = process.argv.slice(2).map((x) => x.toUpperCase());
const parts = want.length ? want : ['A', 'B', 'C'];
const LOG = path.join(SHOTS, 'orch-suite.log');
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(LOG, '');
let failed = 0, passed = 0;
const out = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };
const ok = (name, cond, detail) => {
  if (cond) passed++; else failed++;
  out(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  return !!cond;
};
const ev = (page, expr) => evaluate(page, expr);
const md5 = (f) => execFileSync('md5sum', [path.join(ROOT, f)], { encoding: 'utf8' }).slice(0, 8);
const HERE = path.dirname(new URL(import.meta.url).pathname);
out(`tree ${ROOT}: ${['src/app.js', 'src/teams.js', 'src/term.js', 'src/pty.js', 'src/main.js', 'src/preload.js', 'src/nav.js', 'src/wsbg.js'].map((f) => `${path.basename(f)} ${md5(f)}`).join(', ')}`);

function writeState(ws, at) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws, ui: { at } }));
}
const blankWs = (id, name, folder, extra = {}) => ({ id, name, folder, bg: '#141319', zones: [], notes: [{ id: `n-${id}`, kind: 'note', title: name, body: '' }], windows: [], closed: [], ...extra });
async function stopAll() {
  await quit(25000);
  killTmux();
  for (const s of [`${SOCKET}-vmflow`, `${SOCKET}-vmdefault`]) spawnSync('tmux', ['-L', s, 'kill-server']);
}
const rectOf = (page, sel) => ev(page, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
async function rightClick(page, x, y) {
  await mouse(page, 'mouseMoved', x, y);
  await mouse(page, 'mousePressed', x, y, { button: 'right', buttons: 2 });
  await mouse(page, 'mouseReleased', x, y, { button: 'right', buttons: 0 });
  await sleep(500);
}
async function until(fn, ms, step = 1000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

/* ---------- the main process, through its inspector: counts pty calls ---------- */
async function mainEval(expr) {
  const t = (await (await fetch('http://127.0.0.1:9669/json/list')).json())[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('main inspector')); });
  const v = await new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m.result); }; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  ws.close();
  if (v.exceptionDetails) throw new Error(v.exceptionDetails.text);
  return v.result ? v.result.value : v;
}
// Each call as [time, kind, terminal id, first bytes written]; write and resize get the sender's id first.
const WRAP = `(() => { const pty = process.mainModule.require(${JSON.stringify(path.join(ROOT, 'src/pty.js'))}); if (!pty.__orch) { globalThis.__orchCalls = []; for (const k of ['panes', 'teammate', 'resize', 'write']) { const o = pty[k], at = k === 'resize' || k === 'write' ? 1 : 0; pty[k] = (...a) => { globalThis.__orchCalls.push([Date.now(), k, String(a[at]), k === 'write' ? JSON.stringify(String(a[2])).slice(0, 40) : '']); return o(...a); }; } pty.__orch = true; } return 'wrapped'; })()`;
const callsSince = (t0, kind) => mainEval(`(globalThis.__orchCalls || []).filter((x) => x[0] >= ${t0} && x[1] === ${JSON.stringify(kind)}).length`);
const callsFor = (t0, kind, id) => mainEval(`(globalThis.__orchCalls || []).filter((x) => x[0] >= ${t0} && x[1] === ${JSON.stringify(kind)} && x[2] === ${JSON.stringify(id)}).map((x) => x[3])`);
async function launchCounted(log) {
  launch(log, ['--inspect=9669']);
  const page = await connect();
  for (let i = 0; i < 80; i++) { try { if ((await mainEval(WRAP)) === 'wrapped') break; } catch { await sleep(250); } }
  return page;
}

/* ---------- A ---------- */
if (parts.includes('A')) {
  out('\nA. teams.js rules (test/orch-teams-test.mjs)');
  const r = spawnSync(process.execPath, [path.join(HERE, 'orch-teams-test.mjs')], { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter((l) => /^(ok|FAIL)/.test(l));
  ok(`A: ${lines.filter((l) => l.startsWith('ok')).length} of ${lines.length} rule checks pass`, r.status === 0 && lines.length > 0 && !lines.some((l) => l.startsWith('FAIL')), lines.filter((l) => l.startsWith('FAIL')).join(' | ') || undefined);
}

/* ---------- B ---------- */
if (parts.includes('B')) {
  out('\nB. runs on the VM, on a stand-in VM (flow-test.local)');
  if (pids().length) await stopAll();
  const VM_HOME = '/tmp/flow-dev-orch/vmhome';
  fs.rmSync(path.join(VM_HOME, '.flow'), { recursive: true, force: true });
  fs.mkdirSync(path.join(VM_HOME, 'proj'), { recursive: true });
  const macDir = '/home/claude/.flow-dev/orch/b7';
  fs.mkdirSync(macDir, { recursive: true });
  writeState([blankWs('vm', 'vm work', macDir, { host: 'flow-test.local', hostFolder: '~/proj' }), blankWs('mac', 'mac work', macDir)], 'vm');
  process.env.NODE_OPTIONS = `--require ${path.join(HERE, 'orch-standin-vm.cjs')}`;
  launch(path.join(USER_DATA, 'main-suite-b.log'));
  delete process.env.NODE_OPTIONS;
  const page = await connect();
  try {
    const id = await ev(page, 'window.__flow.spawn("shell")');
    const st = await until(() => ev(page, `(() => { const t = window.__flow.term(${JSON.stringify(id)}); return t && t.state === 'open' ? 'open' : null; })()`), 20000, 500);
    const w = await ev(page, `(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.id === ${JSON.stringify(id)}); return { host: w.host, where: w.where, cwd: w.cwd, label: document.querySelector('.win[data-id="${id}"] .where').textContent }; })()`);
    ok('B1: a VM workspace\'s new terminal runs on the VM in its typed folder', w.host === 'flow-test.local' && w.where === 'on the VM' && w.cwd === '~/proj' && w.label === 'on the VM' && st === 'open', w);
    await sleep(1500);
    const own = (spawnSync('tmux', ['-L', `${SOCKET}-vmflow`, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}'], { encoding: 'utf8' }).stdout || '').trim();
    const dflt = spawnSync('tmux', ['-L', `${SOCKET}-vmdefault`, 'ls'], { encoding: 'utf8' });
    ok('B2: its session is on Flow\'s socket on the VM, started in the VM\'s ~/proj', own.includes(`flow_${id}\t${VM_HOME}/proj`), own);
    ok('B3: nothing was started on the VM\'s default server', dflt.status !== 0, (dflt.stderr || dflt.stdout).trim());
    const conf = path.join(VM_HOME, '.flow/flow-tmux.conf');
    ok('B4: Flow\'s tmux conf was written on the VM, private to the user', fs.existsSync(conf) && (fs.statSync(conf).mode & 0o777) === 0o600, fs.existsSync(conf) ? (fs.statSync(conf).mode & 0o777).toString(8) : 'missing');
    // The menu, on the VM workspace's pill.
    const pill = await rectOf(page, '.sp[data-i="0"]');
    await rightClick(page, pill.x + pill.w / 2, pill.y + pill.h / 2);
    /* "new agents start on" is a row whose hint names the chosen place and opens the two places as a submenu */
    const menuVm = await ev(page, '({ rows: [...document.querySelectorAll(".row")].map((r) => r.textContent.replace(/\\s+/g, " ").trim()), on: [...document.querySelectorAll("button.row")].filter((r) => r.firstChild && r.firstChild.textContent === "new agents start on").map((r) => r.querySelector(".k").textContent.replace(/\\s*›$/, "")) })');
    ok('B5: the menu of a VM workspace shows its VM folder and "the VM" chosen', menuVm.rows.some((r) => r === 'folder~/proj') && menuVm.on.join() === 'the VM', menuVm);
    await key(page, 'Escape');
    await sleep(300);
    // A Mac workspace: its new terminal stays on this machine.
    await ev(page, 'window.__flow.go(1)');
    await sleep(800);
    const mid = await ev(page, 'window.__flow.spawn("shell")');
    await until(() => ev(page, `(() => { const t = window.__flow.term(${JSON.stringify(mid)}); return t && t.state === 'open'; })()`), 20000, 500);
    const mw = await ev(page, `(() => { const w = window.__flow.state().ws[1].windows.find((x) => x.id === ${JSON.stringify(mid)}); return { host: w.host || null, where: w.where, cwd: w.cwd }; })()`);
    const local = tmuxTry('list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}').out;
    ok('B6: a Mac workspace\'s new terminal runs here in its folder', !mw.host && mw.cwd === macDir && local.includes(`flow_${mid}\t${macDir}`), { mw, local });
    // "the VM" on the Mac workspace's menu sets the host and turns the folder row into the VM folder; "this Mac" clears it.
    const pill2 = await rectOf(page, '.sp[data-i="1"]');
    await rightClick(page, pill2.x + pill2.w / 2, pill2.y + pill2.h / 2);
    const placeBtn = async (label) => {
      const sub = await ev(page, '(() => { const b = [...document.querySelectorAll("button.row")].find((x) => x.firstChild && x.firstChild.textContent === "new agents start on"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
      await click(page, sub.x, sub.y);
      await sleep(300);
      return ev(page, `(() => { const b = [...document.querySelectorAll("button.row")].find((x) => x.textContent === ${JSON.stringify(label)}); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    };
    const vmBtn = await placeBtn('the VM');
    await click(page, vmBtn.x, vmBtn.y);
    await sleep(400);
    const afterVm = await ev(page, '(() => { const w = window.__flow.state().ws[1]; return { host: w.host || null, folder: w.folder }; })()');
    await rightClick(page, pill2.x + pill2.w / 2, pill2.y + pill2.h / 2);
    const rowsVm = await ev(page, '[...document.querySelectorAll(".row")].map((r) => r.textContent.replace(/\\s+/g, " ").trim())');
    const macBtn = await placeBtn('this Mac');
    await click(page, macBtn.x, macBtn.y);
    await sleep(400);
    const afterMac = await ev(page, '(() => { const w = window.__flow.state().ws[1]; return { host: w.host || null, folder: w.folder }; })()');
    ok('B7: "the VM" in the menu sets host claude-agents and shows the VM folder; "this Mac" clears it', afterVm.host === 'claude-agents' && rowsVm.includes('folder~') && afterMac.host === null && afterMac.folder === macDir, { afterVm, rowsVm, afterMac });
    // Only ssh processes themselves (other agents' shell command lines may mention the words).
    const ssh = spawnSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' }).stdout.split('\n')
      .map((l) => l.trim().split(/\s+/)).filter((f) => f[1] === 'ssh' && f.slice(2).includes('claude-agents')).map((f) => f.join(' '));
    ok('B8: no ssh to claude-agents was started', ssh.length === 0, ssh.join(' | ') || undefined);
    await shot(page, path.join(SHOTS, 'orch-suite-b.png'));
  } finally {
    page.ws.close();
    await stopAll();
  }
}

/* ---------- C ---------- */
if (parts.includes('C')) {
  out('\nC. real claude teammates');
  if (pids().length) await stopAll();
  const dir = '/home/claude/.flow-dev/orch/suite';
  fs.mkdirSync(dir, { recursive: true });
  writeState([blankWs('t', 'teams', dir), blankWs('o', 'other', dir)], 't');
  let page = await launchCounted(path.join(USER_DATA, 'main-suite-c.log'));
  try {
    const team = await ev(page, 'window.__flow.spawn("team")');
    await until(() => (tmuxTry('capture-pane', '-p', '-t', `=flow_${team}:`).out.includes('bypass permissions') ? 1 : 0), 60000);
    // Submit the prompt; under load Claude Code can take a quick Enter after typed text as part of a paste, so Enter is
    // pressed again until the lead's transcript exists (a session has none before its first prompt).
    await ev(page, `window.__flow.term(${JSON.stringify(team)}).focus()`);
    await page.send('Input.insertText', { text: 'Create an agent team with two teammates named oscar and papa. Each only replies with the single word ok and then waits idle. Do nothing else and do not shut them down.' });
    const leadSid = await ev(page, `window.__flow.state().ws[0].windows.find((w) => w.id === ${JSON.stringify(team)}).sessionId`);
    const transcript = path.join(process.env.HOME, '.claude/projects', dir.replace(/[^A-Za-z0-9]/g, '-'), `${leadSid}.jsonl`);
    for (let i = 0; i < 4 && !fs.existsSync(transcript); i++) {
      await sleep(1500);
      await ev(page, `window.__flow.term(${JSON.stringify(team)}).focus()`);
      await key(page, 'Enter');
      await until(() => fs.existsSync(transcript), 6000, 500);
    }
    ok('C0: the lead got its prompt', fs.existsSync(transcript), transcript);
    const mates = await until(async () => { const m = await ev(page, '(() => window.__flow.state().ws[0].windows.filter((w) => w.mate).map((w) => ({ id: w.id, name: w.mate.name, sid: w.sessionId || null })))()'); return m.length === 2 ? m : null; }, 120000, 2000);
    ok('C1: each teammate the lead spawns gets its own window', !!mates && mates.length === 2, mates);
    const leadPanes = tmuxTry('list-panes', '-t', `=flow_${team}:`, '-F', '#{pane_id}').out.split('\n').filter(Boolean).length;
    ok('C2: the lead keeps its whole window', leadPanes === 1, leadPanes);
    const sids = await until(async () => { const m = await ev(page, '(() => window.__flow.state().ws[0].windows.filter((w) => w.mate).map((w) => w.sessionId || null))()'); return m.length === 2 && m.every(Boolean) ? m : null; }, 45000, 2000);
    ok('C3: each teammate window has its own session id', !!sids, sids);
    // One poller, only for what is on screen.
    let t0 = Date.now();
    await sleep(15000);
    const shown = await callsSince(t0, 'panes');
    await ev(page, 'window.__flow.go(1)');
    await sleep(1500);
    t0 = Date.now();
    await sleep(15000);
    const hidden = await callsSince(t0, 'panes');
    await ev(page, 'window.__flow.go(0)');
    await sleep(1500);
    ok('C4: about one pane poll per 1.5 s with the team on screen, none with it hidden', shown >= 8 && shown <= 12 && hidden === 0, { shown, hidden });
    // A terminal dropped on the team keeps its window and record and sits beside the team.
    await ev(page, `window.__flow.term(${JSON.stringify(team)}).focus()`);
    const tw = await rectOf(page, `.win[data-id="${team}"]`);
    await rightClick(page, tw.x + 40, Math.min(tw.y + tw.h + 120, 760));
    const here = await ev(page, '(() => { const b = [...document.querySelectorAll(".ctx button")].find((x) => /^new shell/.test(x.textContent.trim())); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()');
    let dropped = null;
    if (here) {
      const before = await ev(page, 'window.__flow.windows().map((w) => w.id)');
      await click(page, here.x, here.y);
      await sleep(5000);
      dropped = (await ev(page, 'window.__flow.windows().map((w) => w.id)')).find((x) => !before.includes(x));
      const tb = await rectOf(page, `.win[data-id="${dropped}"] .tb`);
      await drag(page, { x: tb.x + 60, y: tb.y + tb.h / 2 }, { x: tw.x + tw.w / 2, y: tw.y + tw.h / 2 }, { steps: 16, stepMs: 16 });
      await sleep(2000);
    }
    const d = dropped ? await ev(page, `(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.id === ${JSON.stringify(dropped)}); return w ? { group: w.group || null, mate: !!w.mate } : null; })()`) : null;
    const ownSession = dropped && tmuxTry('has-session', '-t', `=flow_${dropped}`).code === 0;
    const onePane = tmuxTry('list-panes', '-t', `=flow_${team}:`, '-F', '#{pane_id}').out.split('\n').filter(Boolean).length === 1;
    ok('C5: a terminal dropped on the team keeps its own window and session, grouped with the team', !!d && d.group === team && !d.mate && ownSession && onePane, { d, ownSession, onePane });
    // A pane dragged out of a zoomed space lands at the drop point (nav's toSpace).
    tmuxTry('split-window', '-d', '-t', `=flow_${team}:`, 'sh');
    await sleep(3500);
    const vp = await rectOf(page, '#viewport');
    for (let i = 0; i < 8; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.x + vp.w - 30, y: vp.y + vp.h - 60, deltaX: 0, deltaY: 6, modifiers: 2, button: 'none', buttons: 0 }); await sleep(20); }
    await sleep(1500);
    const handle = await until(() => ev(page, '(() => { const hs = [...document.querySelectorAll(".fterm-mate")].filter((m) => !m.classList.contains("active")); const m = hs[hs.length - 1]; if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })()'), 10000, 500);
    let landed = { handle };
    if (handle) {
      // The pinch zooms around the pointer, so the team moves: drop just right of where it is now, outside it.
      const tr = await rectOf(page, `.win[data-id="${team}"]`);
      const target = { x: Math.round(tr.x + tr.w + 80), y: Math.round(tr.y + 60) };
      const want = await ev(page, '(() => ({ zoom: window.__flow.state().ws[0].zoom || 1 }))()');
      const before = await ev(page, 'window.__flow.windows().map((w) => w.id)');
      await drag(page, handle, target, { steps: 14, stepMs: 16 });
      await sleep(3000);
      const nid = (await ev(page, 'window.__flow.windows().map((w) => w.id)')).find((x) => !before.includes(x));
      if (nid) {
        const r = await rectOf(page, `.win[data-id="${nid}"]`);
        landed = { zoom: want && want.zoom, left: Math.round(r.x), top: Math.round(r.y), target };
      } else {
        landed = { handle, zoom: want && want.zoom, nid: null, toast: await ev(page, '(document.querySelector(".toast, #toast") || {}).textContent || ""') };
      }
    }
    ok('C6: in a zoomed space a pane dragged out of its team lands near the drop point', !!landed && landed.left !== undefined && landed.zoom < 1 && Math.abs(landed.left - (landed.target.x - (0.10 * vp.w * landed.zoom))) < vp.w * 0.06 && Math.abs(landed.top - (landed.target.y - (0.04 * vp.h * landed.zoom))) < vp.h * 0.06, landed);
    for (let i = 0; i < 8; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.x + vp.w - 30, y: vp.y + vp.h - 60, deltaX: 0, deltaY: -6, modifiers: 2, button: 'none', buttons: 0 }); await sleep(20); }
    await shot(page, path.join(SHOTS, 'orch-suite-c1.png'));
    // A reboot: the tmux server is gone; every teammate resumes its own conversation and says the team link ended.
    page.ws.close();
    await quit(25000);
    killTmux();
    await sleep(2000);
    page = await launchCounted(path.join(USER_DATA, 'main-suite-c.log'));
    await sleep(14000);
    const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout;
    const resumed = (sids || []).filter((sid) => ps.includes(`--resume ${sid}`));
    const words = await ev(page, '(() => window.__flow.state().ws[0].windows.filter((w) => w.mate).map((w) => (document.querySelector(`.win[data-id="${w.id}"] .where`) || {}).textContent))()');
    ok('C7: after a reboot every teammate resumes its own conversation', !!sids && resumed.length === sids.length, { sids, resumed });
    ok('C8: and its window says the team link ended', words.length === 2 && words.every((x) => x === 'team link ended'), words);
    await shot(page, path.join(SHOTS, 'orch-suite-c2.png'));
  } finally {
    page.ws.close();
    await stopAll();
  }
}

/* ---------- D ---------- */
if (parts.includes('D')) {
  out('\nD. one pty resize per window drag (B7, batch 2)');
  if (pids().length) await stopAll();
  const dir = '/home/claude/.flow-dev/orch/b7';
  fs.mkdirSync(dir, { recursive: true });
  writeState([blankWs('d', 'drag', dir)], 'd');
  const page = await launchCounted(path.join(USER_DATA, 'main-suite-d.log'));
  try {
    const id = await ev(page, 'window.__flow.spawn("shell")');
    await until(() => ev(page, `(() => { const t = window.__flow.term(${JSON.stringify(id)}); return t && t.state === 'open'; })()`), 20000, 500);
    await sleep(2500);
    const before = tmuxTry('display', '-p', '-t', `=flow_${id}:`, '#{pane_width}x#{pane_height}').out;
    const rz = await rectOf(page, `.win[data-id="${id}"] .rz`);
    const t0 = Date.now();
    await drag(page, { x: rz.x + rz.w / 2, y: rz.y + rz.h / 2 }, { x: rz.x - 250, y: rz.y - 150 }, { steps: 30, stepMs: 16 });
    await sleep(2500);
    const n = await callsSince(t0, 'resize');
    const after = tmuxTry('display', '-p', '-t', `=flow_${id}:`, '#{pane_width}x#{pane_height}').out;
    const xterm = await ev(page, `(() => { const t = window.__flow.term(${JSON.stringify(id)}); return t.cols + 'x' + t.rows; })()`);
    ok('D1: a 30-step corner drag sends the pty exactly one resize, and tmux ends at xterm\'s size', n === 1 && after === xterm && after !== before, { resizes: n, before, after, xterm });
  } finally {
    page.ws.close();
    await stopAll();
  }
}

/* ---------- E ---------- */
// The dock the way a hand uses it (as test/layout-dock.mjs does): the pointer goes to the bottom middle to bring it up,
// a button is pressed and carried, and the outline under the hand is read just before the release.
let hand = { x: 700, y: 400 };
async function glide(page, x, y, n = 10) {
  for (let k = 1; k <= n; k++) await mouse(page, 'mouseMoved', hand.x + ((x - hand.x) * k) / n, hand.y + ((y - hand.y) * k) / n);
  hand = { x, y };
}
/* the carry's own outline (app.js's ghost, white at .4); beside.js keeps its own dashed guides in #viewport too, hidden */
const outline = (page) => ev(page, '(() => { const g = [...document.getElementById("viewport").children].find((e) => /dashed rgba\\(255, 255, 255, 0\\.4\\)/.test(e.style.border) && e.style.display !== "none"); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
async function carry(page, kind, x, y) {
  const d = await ev(page, '(() => { const r = document.getElementById("dock").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom + 7 }; })()');
  await glide(page, d.x, d.y, 12);
  await sleep(400);
  const b = await ev(page, `(() => { const d = document.getElementById('dock'), b = d.querySelector('button[data-k=${JSON.stringify(kind)}]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, shown: getComputedStyle(d).opacity > 0.9 && d.style.pointerEvents !== 'none' }; })()`);
  if (!b || !b.shown) return { button: b, seen: null };
  await glide(page, b.x, b.y, 4);
  await mouse(page, 'mousePressed', b.x, b.y);
  for (let k = 1; k <= 24; k++) { await mouse(page, 'mouseMoved', b.x + ((x - b.x) * k) / 24, b.y + ((y - b.y) * k) / 24, { down: true }); await sleep(16); }
  await sleep(150);
  const seen = await outline(page);
  await mouse(page, 'mouseReleased', x, y);
  hand = { x, y };
  await sleep(700);
  return { button: b, seen };
}
/* The space on screen: its view, its windows in % and on screen, the front window and where the keys go. */
const spaceNow = (page) => ev(page, `(() => { const s = __flow.state(), ws = s.ws.find((w) => w.id === s.ui.at), vp = document.getElementById('viewport').getBoundingClientRect();
  const wins = {}; ws.windows.filter((w) => (w.zone || null) === (ws.at || null)).forEach((w) => { const el = document.querySelector('.win[data-id="' + w.id + '"]'), b = el && el.getBoundingClientRect();
    wins[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, type: w.type, mate: w.mate ? w.mate.name : null, sid: w.sessionId || null, sx: b ? b.left : null, sy: b ? b.top : null, sw: b ? b.width : null, sh: b ? b.height : null }; });
  const keys = document.activeElement && document.activeElement.closest && document.activeElement.closest('.win'), front = document.querySelector('.win.front');
  return { ws: ws.id, pan: ws.pan || 0, panY: ws.panY || 0, zoom: ws.zoom || 1, vp: { x: vp.left, y: vp.top, w: vp.width, h: vp.height, r: vp.right, b: vp.bottom }, wins, keys: keys ? keys.dataset.id : null, front: front ? front.dataset.id : null }; })()`);
const newIn = (a, b) => Object.keys(b.wins).filter((id) => !a.wins[id]);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const inView = (s, w) => !!w && w.sx >= s.vp.x - 1 && w.sy >= s.vp.y - 1 && w.sx + w.sw <= s.vp.r + 1 && w.sy + w.sh <= s.vp.b + 1;
function overlapsIn(s) {
  const ids = Object.keys(s.wins), outs = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = s.wins[ids[i]], b = s.wins[ids[j]];
    if (a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05) outs.push(`${ids[i]}/${ids[j]}`);
  }
  return outs;
}
const isOpen = (page, id) => ev(page, `(() => { const t = window.__flow.term(${JSON.stringify(id)}); return !!t && t.state === 'open'; })()`);
const claudeUp = (page, id) => until(async () => ((await isOpen(page, id)) && tmuxTry('capture-pane', '-p', '-t', `=flow_${id}:`).out.includes('bypass permissions') ? 1 : 0), 90000);
async function sizes(page, id) {
  const [tm, cwd] = tmuxTry('display', '-p', '-t', `=flow_${id}:`, '#{window_width}x#{window_height}\t#{pane_current_path}').out.split('\t');
  const xterm = await ev(page, `(() => { const t = window.__flow.term(${JSON.stringify(id)}); return t ? t.cols + 'x' + t.rows : null; })()`);
  return { tmux: tm || null, cwd: cwd || null, xterm };
}
const runsWith = (sid) => !!sid && spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout.split('\n').some((l) => l.includes(`--session-id ${sid}`));
/* A pinch as Chromium gives it (ctrl-wheel), stamped 16 ms apart, then until the zoom has settled. */
async function pinchAt(page, x, y, dys) {
  const t0 = Date.now();
  for (let i = 0; i < dys.length; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dys[i], modifiers: 2, button: 'none', buttons: 0, pointerType: 'mouse', timestamp: (t0 + i * 16) / 1000 });
  await sleep(1600);
  let last = null;
  for (let i = 0; i < 30; i++) { const z = await ev(page, '(() => { const s = __flow.state(); return s.ws.find((w) => w.id === s.ui.at).zoom || 1; })()'); if (z === last) return z; last = z; await sleep(400); }
  return last;
}
/* far out each window keeps its own title bar (batch 7 dropped the far-title bars and the sheet) */
const farTitles = (page) => ev(page, '(() => { const t = [...document.querySelectorAll(`.ws[data-id="${__flow.state().ui.at}"] .canvas > .win`)].filter((w) => w.style.display !== "none" && w.querySelector(":scope > .tb .tt")); if (!t.length) return null; return Object.fromEntries(t.map((w) => [w.dataset.id, w.querySelector(":scope > .tb .tt").textContent])); })()');
async function sidebarTo(page, id, teamId) {
  const row = () => rectOf(page, `#sblist .tr[data-act="win|${id}"]`);
  if (!(await row()) && teamId) { const g = await rectOf(page, `#sblist .tr[data-act="win|${teamId}"] .g[data-tog]`); if (g) { await click(page, g.x + g.w / 2, g.y + g.h / 2); await sleep(500); } }
  const r = await row();
  if (!r) return false;
  await click(page, r.x + Math.min(60, r.w / 2), r.y + r.h / 2);
  hand = { x: r.x + Math.min(60, r.w / 2), y: r.y + r.h / 2 };
  await sleep(1500);
  return true;
}
const realErrors = (page) => (page.errors || []).filter((e) => /^(exception|console\.error)/.test(e) && !/net::|Failed to load resource|ERR_/.test(e));

if (parts.includes('E')) {
  out('\nE. batch 3: agents and teammates pinched out far, and the dock placement');
  if (pids().length) await stopAll();
  const dir = '/home/claude/.flow-dev/orch/suite3';
  fs.mkdirSync(dir, { recursive: true });
  writeState([blankWs('t', 'teams', dir), blankWs('o', 'other', dir)], 't');
  let page = await launchCounted(path.join(USER_DATA, 'main-suite-e.log'));
  const errors = [];
  try {
    // E1. A team carried from the dock onto open desktop.
    let s0 = await spaceNow(page);
    const c1 = await carry(page, 'team', s0.vp.x + s0.vp.w * 0.32, s0.vp.y + s0.vp.h * 0.22);
    let s1 = await spaceNow(page);
    const team = newIn(s0, s1)[0];
    const up = team && (await claudeUp(page, team));
    s1 = await spaceNow(page);
    const T1 = team && s1.wins[team], z1 = team && (await sizes(page, team));
    ok('E1: a team carried from the dock opens where its outline was, takes the keys, and its lead starts in the folder at its window\'s size',
      !!c1.seen && newIn(s0, s1).length === 1 && T1.type === 'team' && near(T1.sx, c1.seen.x, 3) && near(T1.sy, c1.seen.y, 3) && near(T1.sw, c1.seen.w, 3)
      && s1.keys === team && !!up && z1.tmux === z1.xterm && z1.cwd === dir && runsWith(T1.sid), { outline: c1.seen, win: T1 && [T1.sx, T1.sy, T1.sw], keys: s1.keys, up: !!up, ...z1 });

    // E2. A pinch over the lead: the space zooms out and the lead gets nothing (no sheet or shade since batch 7).
    let t0 = Date.now();
    const pz = await pinchAt(page, T1.sx + T1.sw / 2, T1.sy + T1.sh / 2, Array(10).fill(9.2));
    const z2 = await sizes(page, team), wrote = await callsFor(t0, 'write', team), rs = await callsFor(t0, 'resize', team);
    ok('E2: a pinch over the lead zooms the space out; the lead gets no input and keeps its columns and rows',
      pz < 0.5 && wrote.length === 0 && rs.length === 0 && z2.tmux === z1.tmux && z2.xterm === z1.xterm, { zoom: pz, writes: wrote.slice(0, 6), resizes: rs.length, before: z1, after: z2 });

    // E3. The lead's teammates arrive while far out.
    await ev(page, `window.__flow.term(${JSON.stringify(team)}).focus()`);
    await page.send('Input.insertText', { text: 'Create an agent team with two teammates named quebec and romeo. Each only replies with the single word ok and then waits idle. Do nothing else and do not shut them down.' });
    const transcript = path.join(process.env.HOME, '.claude/projects', dir.replace(/[^A-Za-z0-9]/g, '-'), `${T1.sid}.jsonl`);
    for (let i = 0; i < 4 && !fs.existsSync(transcript); i++) {
      await sleep(1500);
      await ev(page, `window.__flow.term(${JSON.stringify(team)}).focus()`);
      await key(page, 'Enter');
      await until(() => fs.existsSync(transcript), 6000, 500);
    }
    const mates = await until(async () => { const s = await spaceNow(page); const m = Object.entries(s.wins).filter(([, w]) => w.mate); return m.length === 2 ? m.map(([id]) => id) : null; }, 150000, 2000);
    await sleep(2500);
    const s3 = await spaceNow(page), ft = await farTitles(page);
    const shown = (mates || []).every((id) => inView(s3, s3.wins[id]));
    const named = !!ft && (mates || []).every((id) => ft[id] === s3.wins[id].mate) && !!ft[team];
    // Moving a teammate out is Flow's own doing, so the keys stay in the lead the owner typed into.
    ok('E3: far out, each teammate gets its own window in view, the view keeps its zoom and the lead its keys, and each shows its name in its own title bar',
      fs.existsSync(transcript) && !!mates && shown && near(s3.zoom, pz, 0.002) && s3.keys === team && named, { prompt: fs.existsSync(transcript), mates: mates && mates.map((id) => s3.wins[id].mate), zoom: [pz, s3.zoom], keys: s3.keys, shown, titles: ft });
    await shot(page, path.join(SHOTS, 'orch-suite-e3.png'));

    // E4. The first teammate's sidebar row, from far out.
    const m1 = mates ? [...mates].sort((a, b) => s3.wins[a].x - s3.wins[b].x)[0] : null;
    const went = m1 && (await sidebarTo(page, m1, team));
    /* going to a window only pans; it never changes the zoom (batch 7) */
    const s4 = await until(async () => { const s = await spaceNow(page); return m1 && inView(s, s.wins[m1]) && s.keys === m1 ? s : null; }, 6000, 300) || (await spaceNow(page));
    ok('E4: from far out, a teammate\'s sidebar row brings it fully into view at the same zoom, with the keys in it', !!went && near(s4.zoom, pz, 0.002) && inView(s4, s4.wins[m1]) && s4.keys === m1, { went, zoom: [pz, s4.zoom], win: m1 && s4.wins[m1], keys: s4.keys });

    // E5. An agent carried into the gap between the team and its first teammate.
    const A = s4.wins[team], B = m1 && s4.wins[m1];
    let a1 = null;
    if (A && B) {
      const G = { x: (A.sx + A.sw + B.sx) / 2, y: (Math.max(A.sy, B.sy) + Math.min(A.sy + A.sh, B.sy + B.sh)) / 2 };
      const before = Object.fromEntries((mates || []).map((id) => [id, tmuxTry('display', '-p', '-t', `=flow_${id}:`, '#{window_width}x#{window_height}').out]));
      t0 = Date.now();
      const c5 = await carry(page, 'agent', G.x, G.y);
      let s5 = await spaceNow(page);
      a1 = newIn(s4, s5)[0];
      const up5 = a1 && (await claudeUp(page, a1));
      s5 = await spaceNow(page);
      const N = a1 && s5.wins[a1], z5 = a1 && (await sizes(page, a1));
      const dx = (mates || []).map((id) => s5.wins[id].x - s4.wins[id].x);
      const kept = (mates || []).every((id) => s5.wins[id].mate === s4.wins[id].mate && s5.wins[id].sid === s4.wins[id].sid && tmuxTry('display', '-p', '-t', `=flow_${id}:`, '#{window_width}x#{window_height}').out === before[id]);
      const mateResizes = (await Promise.all((mates || []).map((id) => callsFor(t0, 'resize', id)))).flat().length;
      // Beside a window it takes that window's top and its height up to its own (an agent is 44 tall; nav placeRoom).
      ok('E5: an agent carried into the gap beside the team opens where its outline showed, beside the team and level with it; the teammates make way together',
        !!N && !!c5.seen && G.x > s4.vp.x && G.x < s4.vp.r && near(N.sx, c5.seen.x, 3) && near(N.sw, c5.seen.w, 3) && near(N.x, A.x + A.w + 1.2, 0.3) && near(N.y, A.y, 0.3) && near(N.h, Math.min(A.h, 44), 0.3)
        && dx.every((d) => d > 5 && near(d, dx[0], 0.05)) && near(s5.wins[team].x, A.x, 0.05) && overlapsIn(s5).length === 0,
        { gap: G, outline: c5.seen, at: N && [N.x, N.y, N.w, N.h, N.sx, N.sw], team: [A.x, A.y, A.w, A.h], made: dx, overlaps: overlapsIn(s5) });
      ok('E6: the teammates that made way keep their records, sessions and sizes; the new agent has the keys and starts at its size',
        kept && mateResizes === 0 && s5.keys === a1 && !!up5 && z5.tmux === z5.xterm && z5.cwd === dir && runsWith(N.sid), { kept, mateResizes, keys: s5.keys, up: !!up5, ...z5 });
    } else ok('E5/E6: the team and its first teammate are on screen', false, { A, B });

    // E7. An agent carried to the right side goes past the last window and the view stays. Landing out of view it
    // leaves the keys with the agent in use; landing wholly in view it takes them (layout, the lead's rule, Nov 2).
    const s6 = await spaceNow(page);
    const end = Math.max(...Object.values(s6.wins).map((w) => w.x + w.w));
    const c7 = await carry(page, 'agent', s6.vp.r - 10, s6.vp.y + s6.vp.h * 0.4);
    const s7 = await spaceNow(page), a2 = newIn(s6, s7)[0], E = a2 && s7.wins[a2], shown7 = inView(s7, E);
    // Real key presses: CDP's insertText still reaches a textarea that has lost focus, a keyboard does not.
    let typed = null;
    if (!shown7) {
      await type(page, 'zq');
      typed = !!(a1 && (await until(() => (tmuxTry('capture-pane', '-p', '-t', `=flow_${a1}:`).out.split('\n').some((l) => l.includes('❯') && l.includes('zq')) ? 1 : 0), 8000, 500)));
      if (typed) { await key(page, 'Backspace'); await key(page, 'Backspace'); }
    }
    const keys7 = shown7 ? s7.keys === a2 && s7.front === a2 : s7.keys === a1 && s7.front === a1 && typed;
    ok(`E7: an agent carried to the right side goes past the last window, the view stays, and ${shown7 ? 'landing in view it takes the keys' : 'landing out of view the keys stay with the agent in use'}`,
      !!c7.seen && !!E && near(E.x, end + 1.5, 0.3) && near(E.y, 6.6, 0.3) && near(s7.pan, s6.pan, 0.5) && near(s7.zoom, s6.zoom, 0.001) && keys7,
      { outline: c7.seen, at: E && [E.x, E.y], end, inView: shown7, pan: [s6.pan, s7.pan], keys: s7.keys, front: s7.front, typed });
    const went8 = a2 && (await sidebarTo(page, a2));
    const up8 = went8 && (await claudeUp(page, a2));
    const z8 = a2 && (await sizes(page, a2));
    ok('E8: going to it, that agent runs in the folder at its window\'s size', !!up8 && z8.tmux === z8.xterm && z8.cwd === dir && runsWith(E.sid), { went: went8, up: !!up8, ...z8 });
    await shot(page, path.join(SHOTS, 'orch-suite-e8.png'));
  } catch (err) {
    ok('E: the run went to the end', false, String((err && err.stack) || err).slice(0, 400));
  } finally {
    errors.push(...realErrors(page));
    page.ws.close();
    await stopAll();
  }

  // E9. A VM workspace on the stand-in VM: an agent carried from the dock runs there, on Flow's socket, in its folder.
  const VM_HOME = '/tmp/flow-dev-orch/vmhome';
  fs.mkdirSync(path.join(VM_HOME, 'proj'), { recursive: true });
  writeState([blankWs('vm', 'vm work', dir, { host: 'flow-test.local', hostFolder: '~/proj' })], 'vm');
  process.env.NODE_OPTIONS = `--require ${path.join(HERE, 'orch-standin-vm.cjs')}`;
  launch(path.join(USER_DATA, 'main-suite-e.log'));
  delete process.env.NODE_OPTIONS;
  page = await connect();
  try {
    hand = { x: 700, y: 400 };
    const s0 = await spaceNow(page);
    await carry(page, 'agent', s0.vp.x + s0.vp.w * 0.4, s0.vp.y + s0.vp.h * 0.25);
    const s1 = await spaceNow(page), id = newIn(s0, s1)[0];
    const w = id && (await ev(page, `(() => { const w = window.__flow.state().ws[0].windows.find((x) => x.id === ${JSON.stringify(id)}); return { host: w.host, where: w.where, cwd: w.cwd, label: document.querySelector('.win[data-id="${id}"] .where').textContent }; })()`));
    const own = id && (await until(() => (spawnSync('tmux', ['-L', `${SOCKET}-vmflow`, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}'], { encoding: 'utf8' }).stdout || '').split('\n').find((l) => l.startsWith(`flow_${id}\t`)) || null, 20000, 500));
    const dflt = spawnSync('tmux', ['-L', `${SOCKET}-vmdefault`, 'ls'], { encoding: 'utf8' });
    const here = id && tmuxTry('has-session', '-t', `=flow_${id}`).code === 0;
    ok('E9: in a VM workspace, an agent carried from the dock runs on the VM, on Flow\'s socket there, in the typed folder',
      !!w && w.host === 'flow-test.local' && w.where === 'on the VM' && w.cwd === '~/proj' && w.label === 'on the VM' && own === `flow_${id}\t${VM_HOME}/proj` && dflt.status !== 0 && !here,
      { w, own, vmDefault: (dflt.stderr || dflt.stdout).trim(), onThisMachine: here });
  } finally {
    errors.push(...realErrors(page));
    page.ws.close();
    await stopAll();
  }
  ok('E10: no console errors or exceptions in either run', errors.length === 0, errors.slice(0, 6));
}

/* ---------- F ---------- */
const psArgs = () => spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.trim()).filter(Boolean);
/* The claude processes holding a conversation: a teammate by its --agent-id, any other by --session-id or --resume.
   Only claude itself counts (its binary), not the shell line around it that names the same arguments. */
const isClaudeBin = (pid) => { try { const exe = fs.readlinkSync(`/proc/${pid}/exe`); return /\/claude\/versions\//.test(exe) || path.basename(exe) === 'claude'; } catch { return false; } };
const claudesOf = (sid, mate) => psArgs()
  .filter((l) => (mate && l.includes(`--agent-id ${mate}@`)) || (sid && new RegExp(`(^|\\s)(--session-id|--resume)\\s+${sid}(\\s|$)`).test(l)))
  .map((l) => +l.split(/\s+/)[0]).filter(isClaudeBin);
const panePid = (id) => tmuxTry('display', '-p', '-t', `=flow_${id}:`, '#{pane_pid}').out || null;
/* A row of the sidebar, unfolding the team it sits under when it is folded away. */
async function sidebarRow(page, act, teamId) {
  const sel = `#sblist .tr[data-act=${JSON.stringify(act)}]`;
  if (!(await rectOf(page, sel)) && teamId) {
    const g = await rectOf(page, `#sblist .tr[data-act="win|${teamId}"] .g[data-tog], #sblist .tr[data-act="reopen|${teamId}"] .g[data-tog]`);
    if (g) { await click(page, g.x + g.w / 2, g.y + g.h / 2); await sleep(500); }
  }
  return rectOf(page, sel);
}
const winRec = (page, id) => ev(page, `(() => { const ws = window.__flow.state().ws[0], w = [...ws.windows, ...ws.closed].find((x) => x.id === ${JSON.stringify(id)}); if (!w) return null;
  return { open: ws.windows.some((x) => x.id === w.id), closed: ws.closed.some((x) => x.id === w.id), sid: w.sessionId || null, mate: w.mate ? w.mate.name : null, unlinked: !!(w.mate && w.mate.unlinked), where: (document.querySelector('.win[data-id="' + w.id + '"] .where') || {}).textContent || null }; })()`);
async function relaunch(log) {
  await quit(25000);
  const page = await launchCounted(log);
  await sleep(6000);
  return page;
}

if (parts.includes('F')) {
  out('\nF. quit and reopen with a team (item 40 and item 31), real claude');
  if (pids().length) await stopAll();
  const dir = '/home/claude/.flow-dev/orch/suite4';
  fs.mkdirSync(dir, { recursive: true });
  writeState([blankWs('f', 'quits', dir)], 'f');
  const LOGF = path.join(USER_DATA, 'main-suite-f.log');
  const errsF = [];
  let page = await launchCounted(LOGF);
  try {
    const team = await ev(page, 'window.__flow.spawn("team")');
    await until(() => (tmuxTry('capture-pane', '-p', '-t', `=flow_${team}:`).out.includes('bypass permissions') ? 1 : 0), 90000);
    await ev(page, `window.__flow.term(${JSON.stringify(team)}).focus()`);
    await page.send('Input.insertText', { text: 'Create an agent team with two teammates named sierra and tango. Each only replies with the single word ok and then waits idle. Do nothing else and do not shut them down.' });
    const leadSid = await ev(page, `window.__flow.state().ws[0].windows.find((w) => w.id === ${JSON.stringify(team)}).sessionId`);
    const transcript = path.join(process.env.HOME, '.claude/projects', dir.replace(/[^A-Za-z0-9]/g, '-'), `${leadSid}.jsonl`);
    for (let i = 0; i < 4 && !fs.existsSync(transcript); i++) {
      await sleep(1500);
      await ev(page, `window.__flow.term(${JSON.stringify(team)}).focus()`);
      await key(page, 'Enter');
      await until(() => fs.existsSync(transcript), 6000, 500);
    }
    // F1. A quit as soon as both teammate windows have their session ids: they come back on their live sessions.
    const mates = await until(async () => { const m = await ev(page, '(() => window.__flow.state().ws[0].windows.filter((w) => w.mate && w.sessionId).map((w) => ({ id: w.id, name: w.mate.name, sid: w.sessionId })))()'); return m.length === 2 ? m : null; }, 150000, 500);
    if (!mates) throw new Error(`the lead's two teammates did not get windows with session ids (prompt sent: ${fs.existsSync(transcript)})`);
    const byName = Object.fromEntries(mates.map((m) => [m.name, m]));
    const S = byName.sierra, T = byName.tango;
    if (!S || !T) throw new Error(`teammates are not sierra and tango: ${JSON.stringify(mates)}`);
    const pp = { [S.id]: panePid(S.id), [T.id]: panePid(T.id), [team]: panePid(team) };
    errsF.push(...realErrors(page));
    page.ws.close();
    page = await relaunch(LOGF);
    const f1 = await Promise.all([S.id, T.id].map((id) => winRec(page, id)));
    const same = [S.id, T.id, team].every((id) => panePid(id) === pp[id] && !!pp[id]);
    const leadPanes = tmuxTry('list-panes', '-t', `=flow_${team}:`, '-F', '#{pane_id}').out.split('\n').filter(Boolean).length;
    ok('F1: quit as soon as the teammates got their windows: both come back on their own live sessions, still linked',
      f1.every((r, i) => r && r.open && r.mate === [S, T][i].name && r.sid === [S, T][i].sid && !r.unlinked && r.where !== 'team link ended') && same && leadPanes === 1,
      { f1, panePids: { before: pp, after: { [S.id]: panePid(S.id), [T.id]: panePid(T.id), [team]: panePid(team) } }, leadPanes });

    // F2. Sierra closed (it keeps running), quit at once: still closed after the restart, and reopening it reattaches.
    const red = await rectOf(page, `.win[data-id="${S.id}"] .lights i[data-l="close"]`);
    if (red) await click(page, red.x + red.w / 2, red.y + red.h / 2);
    await until(async () => { const r = await winRec(page, S.id); return r && r.closed ? 1 : 0; }, 5000, 200);
    errsF.push(...realErrors(page));
    page.ws.close();
    page = await relaunch(LOGF);
    const f2a = await winRec(page, S.id);
    const row = await sidebarRow(page, `reopen|${S.id}`, team);
    if (row) await click(page, row.x + Math.min(60, row.w / 2), row.y + row.h / 2);
    const f2b = await until(async () => { const r = await winRec(page, S.id); return r && r.open ? r : null; }, 10000, 500);
    await sleep(3000);
    ok('F2: a teammate closed right before a quit stays closed and running; reopened, it is the same claude on its link',
      !!red && !!f2a && f2a.closed && !f2a.open && !!f2b && !f2b.unlinked && panePid(S.id) === pp[S.id] && claudesOf(S.sid, 'sierra').length === 1,
      { closedAfterRestart: f2a, reopened: f2b, panePid: [pp[S.id], panePid(S.id)], claudes: claudesOf(S.sid, 'sierra') });

    // F3. Tango ended, then undo and reopen right away, as a hand does: its own conversation comes back once, with no
    // teammate claude left of it, and the window says the link ended.
    const red3 = await rectOf(page, `.win[data-id="${T.id}"] .lights i[data-l="close"]`);
    if (red3) await click(page, red3.x + red3.w / 2, red3.y + red3.h / 2);
    await until(async () => { const r = await winRec(page, T.id); return r && r.closed ? 1 : 0; }, 5000, 200);
    const endX = await sidebarRow(page, `reopen|${T.id}`, team) && (await rectOf(page, `#sblist .tr[data-act="reopen|${T.id}"] .x[data-end="${T.id}"]`));
    if (endX) await click(page, endX.x + endX.w / 2, endX.y + endX.h / 2);
    const toast = await until(() => ev(page, '(() => { const t = document.getElementById("toast"); return t.classList.contains("on") && /ended/.test(t.textContent) ? t.textContent : null; })()'), 8000, 200);
    const undo = await rectOf(page, '#toast button.tact');
    if (undo) await click(page, undo.x + undo.w / 2, undo.y + undo.h / 2);
    const back = await sidebarRow(page, `reopen|${T.id}`, team);
    if (back) await click(page, back.x + Math.min(60, back.w / 2), back.y + back.h / 2);
    const f3first = await until(async () => { const r = await winRec(page, T.id); return r && r.open && claudesOf(T.sid).length === 1 ? r : null; }, 30000, 1000);
    await sleep(4000);
    /* read again: "team link ended" is set when the open's answer reaches teams.js, which can come just after its claude
       shows in ps */
    const f3 = f3first && (await winRec(page, T.id));
    const one3 = claudesOf(T.sid, 'tango'), mate3 = claudesOf(null, 'tango');
    ok('F3: a teammate ended, then undo and reopen right away: one claude resumes its own conversation, no teammate claude is left, and it says the team link ended',
      !!toast && !!undo && !!f3 && one3.length === 1 && mate3.length === 0 && f3.unlinked && f3.where === 'team link ended',
      { toast, undo: !!undo, reopened: f3, claudes: one3, teammateLeft: mate3 });

    // F4. A quit right after that: tango comes back the same way, sierra and the lead on their live sessions.
    const pT = panePid(T.id);
    errsF.push(...realErrors(page));
    page.ws.close();
    page = await relaunch(LOGF);
    const f4 = await winRec(page, T.id);
    ok('F4: quit right after: the reopened teammate is back on its session, one claude, still "team link ended"; the rest attached',
      !!f4 && f4.open && f4.unlinked && f4.where === 'team link ended' && panePid(T.id) === pT && claudesOf(T.sid, 'tango').length === 1 && panePid(S.id) === pp[S.id] && panePid(team) === pp[team],
      { f4, panePid: [pT, panePid(T.id)], claudes: claudesOf(T.sid, 'tango'), sierra: [pp[S.id], panePid(S.id)], lead: [pp[team], panePid(team)] });

    // F5. The lead ended, then undo and reopen right away: one claude on the lead's conversation; its live teammate
    // went with the old lead and its window waits as a closed row.
    const red5 = await rectOf(page, `.win[data-id="${team}"] .lights i[data-l="close"]`);
    if (red5) await click(page, red5.x + red5.w / 2, red5.y + red5.h / 2);
    await until(async () => { const r = await winRec(page, team); return r && r.closed ? 1 : 0; }, 5000, 200);
    const endL = await sidebarRow(page, `reopen|${team}`) && (await rectOf(page, `#sblist .tr[data-act="reopen|${team}"] .x[data-end="${team}"]`));
    if (endL) await click(page, endL.x + endL.w / 2, endL.y + endL.h / 2);
    await until(() => ev(page, '(() => { const t = document.getElementById("toast"); return t.classList.contains("on") && /ended/.test(t.textContent) ? 1 : 0; })()'), 8000, 200);
    const undo5 = await rectOf(page, '#toast button.tact');
    if (undo5) await click(page, undo5.x + undo5.w / 2, undo5.y + undo5.h / 2);
    const backL = await sidebarRow(page, `reopen|${team}`);
    if (backL) await click(page, backL.x + Math.min(60, backL.w / 2), backL.y + backL.h / 2);
    // What the reopen says, if anything (a refusal shows as a toast for a few seconds).
    const said = await until(() => ev(page, '(() => { const t = document.getElementById("toast"); return t.classList.contains("on") && !/^ended/.test(t.textContent) ? t.textContent : null; })()'), 3000, 150);
    const f5 = await until(async () => { const r = await winRec(page, team); return r && r.open && claudesOf(leadSid).length === 1 ? r : null; }, 30000, 1000);
    await sleep(4000);
    const one5 = claudesOf(leadSid), sLeft = claudesOf(null, 'sierra'), sAfter = await winRec(page, S.id);
    ok('F5: the lead ended, then undo and reopen right away: one claude resumes the lead\'s conversation; its live teammate went with it and waits as a closed row',
      !!endL && !!undo5 && !!f5 && one5.length === 1 && psArgs().some((l) => l.includes(`--resume ${leadSid}`)) && sLeft.length === 0 && !!sAfter && sAfter.closed,
      { undo: !!undo5, said: said || null, reopened: f5, claudes: one5, sierraLeft: sLeft, sierra: sAfter });
    await shot(page, path.join(SHOTS, 'orch-suite-f.png'));
  } catch (err) {
    ok('F: the run went to the end', false, String((err && err.stack) || err).slice(0, 400));
  } finally {
    errsF.push(...realErrors(page));
    page.ws.close();
    await stopAll();
    ok('F6: no console errors or exceptions in any of the runs', errsF.length === 0, errsF.slice(0, 6));
  }
}

out(`\n${passed} of ${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;




