// orch's B7 check ("URGENTTTTT ... overflow repetition", "all i did was to fork a conversation and then boom the entire
// terminal gets scattered"): real claude in Flow, the fullscreen renderer (NO_FLICKER, the owner's setting) and the
// classic one, through fork, resize, maximize and restore, a workspace switch (park and reattach), pinch zoom, pop-out
// and a restart that reattaches. After each step every agent's xterm screen is compared with tmux's own screen
// (capture-pane), and the classic agent's tmux history is checked for repeated output.
// Runs orch's isolated app only (socket flow-dev-orch, cwd under /home/claude/.flow-dev/orch). Steps: setup | run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, connect, quit, killTmux, tmuxTry, SHOTS, USER_DATA, SOCKET } from './orch-lib.mjs';
import { evaluate, click, dblclick, drag, key, mouse, shot, sleep, wheel } from './ui-lib.mjs';

const DIR = '/home/claude/.flow-dev/orch/b7';
const LOG = path.join(SHOTS, 'b7-run.log');
const PROMPT = 'print the numbers 1 to 120, one per line, nothing else';
const CLASSIC = `claude --settings '{"env":{"CLAUDE_CODE_NO_FLICKER":"0"}}'`;
fs.mkdirSync(SHOTS, { recursive: true });
const out = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n'); };

const ev = (page, expr) => evaluate(page, expr);
const norm = (t) => t.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
const tmuxScreen = (id) => norm(execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-t', `=flow_${id}:`], { encoding: 'utf8' }));
const tmuxHistory = (id) => tmuxTry('capture-pane', '-p', '-S', '-', '-E', '-', '-t', `=flow_${id}:`).out;

async function compare(page, label, agents) {
  for (const a of agents) {
    const cols = await ev(page, `window.__flow.term(${JSON.stringify(a.id)}).cols`);
    const x = norm((await ev(page, `window.__flow.term(${JSON.stringify(a.id)}).getText()`) || '').split('\n').map((l) => [...l].slice(0, cols).join('')).join('\n'));
    const t = tmuxScreen(a.id);
    const xl = x.split('\n'), tl = t.split('\n');
    const diffs = [];
    for (let i = 0; i < Math.max(xl.length, tl.length); i++) if ((xl[i] || '') !== (tl[i] || '')) diffs.push(i);
    const hist = tmuxHistory(a.id);
    const asked = (hist.match(/❯ print the numbers 1 to 120/g) || []).length;
    const last = (hist.match(/^\s*120\s*$/gm) || []).length;
    const size = tmuxTry('display', '-p', '-t', `=flow_${a.id}:`, '#{pane_width}x#{pane_height} alt=#{alternate_on} hist=#{history_size}').out;
    out(`${diffs.length ? 'DIFF' : 'same'} ${label} ${a.name}: xterm ${xl.length} lines vs tmux ${tl.length} (${size}); differing rows ${diffs.length ? diffs.slice(0, 8).join(',') : 'none'}; in tmux's screen and history: the prompt ${asked}x, "120" ${last}x`);
    if (diffs.length) {
      fs.writeFileSync(path.join(SHOTS, `b7-${label}-${a.name}-xterm.txt`), x);
      fs.writeFileSync(path.join(SHOTS, `b7-${label}-${a.name}-tmux.txt`), t);
    }
  }
  await shot(page, path.join(SHOTS, `b7-${label}.png`));
}

async function rect(page, sel) {
  return ev(page, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
}

const step = process.argv[2];
if (step === 'setup') {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws: [
    { id: 'b7', name: 'b7', folder: DIR, bg: '#141319', zones: [], notes: [{ id: 'n-b7', kind: 'note', title: 'b7', body: '' }], windows: [], closed: [] },
    { id: 'other', name: 'other', folder: DIR, bg: '#10171a', zones: [], notes: [{ id: 'n-o', kind: 'note', title: 'other', body: '' }], windows: [], closed: [] },
  ], ui: { at: 'b7' } }));
  fs.writeFileSync(LOG, '');
  launch(path.join(USER_DATA, 'main-b7.log'));
  const page = await connect();
  // F: a new agent from the dock, Claude's fullscreen renderer (the owner's NO_FLICKER setting).
  const F = await ev(page, 'window.__flow.spawn("agent")');
  // C: a shell running claude with the classic renderer.
  const C = await ev(page, 'window.__flow.spawn("shell")');
  await sleep(6000);
  await ev(page, `window.__flow.term(${JSON.stringify(C)}).focus()`);
  await page.send('Input.insertText', { text: CLASSIC });
  await key(page, 'Enter');
  await sleep(9000);
  for (const id of [F, C]) {
    await ev(page, `window.__flow.term(${JSON.stringify(id)}).focus()`);
    await page.send('Input.insertText', { text: PROMPT });
    await sleep(300);
    await key(page, 'Enter');
  }
  await sleep(25000);
  fs.writeFileSync(path.join(USER_DATA, 'b7-ids.json'), JSON.stringify({ F, C }));
  out(`setup: F=${F} (fullscreen) C=${C} (classic)`);
  page.ws.close();
} else if (step === 'run') {
  const { F, C } = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'b7-ids.json'), 'utf8'));
  const agents = [{ id: F, name: 'fullscreen' }, { id: C, name: 'classic' }];
  let page = await connect();
  await compare(page, '0-start', agents);

  // 1. resize: three times smaller and back, by the corner handle.
  for (const a of agents) {
    for (let i = 0; i < 3; i++) {
      const r = await rect(page, `.win[data-id="${a.id}"] .rz`);
      await drag(page, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, { x: r.x - 160, y: r.y - 90 }, { steps: 10, stepMs: 16 });
      await sleep(600);
      const r2 = await rect(page, `.win[data-id="${a.id}"] .rz`);
      await drag(page, { x: r2.x + r2.w / 2, y: r2.y + r2.h / 2 }, { x: r2.x + 160, y: r2.y + 90 }, { steps: 10, stepMs: 16 });
      await sleep(600);
    }
  }
  await sleep(2500);
  await compare(page, '1-resize', agents);

  // 2. maximize and restore: a double-click on each title bar, twice.
  for (const a of agents) {
    for (let i = 0; i < 2; i++) {
      const t = await rect(page, `.win[data-id="${a.id}"] .tb`);
      await dblclick(page, t.x + t.w / 2, t.y + t.h / 2);
      await sleep(1200);
    }
  }
  await sleep(2500);
  await compare(page, '2-max-restore', agents);

  // 3. a workspace switch: hidden terminals park (detach), then reattach on return.
  await ev(page, 'window.__flow.go(1)');
  await sleep(4000);
  await ev(page, 'window.__flow.go(0)');
  await sleep(4000);
  await compare(page, '3-switch-back', agents);

  // 4. pinch zoom: ctrl-wheel out and back in over the empty desktop.
  const vp = await rect(page, '#viewport, .viewport');
  const px = vp.x + vp.w - 40, py = vp.y + vp.h - 120;
  for (let i = 0; i < 12; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: 6, modifiers: 2, button: 'none', buttons: 0 }); await sleep(20); }
  await sleep(1500);
  await compare(page, '4a-zoomed-out', agents);
  for (let i = 0; i < 12; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: -6, modifiers: 2, button: 'none', buttons: 0 }); await sleep(20); }
  await sleep(2000);
  await compare(page, '4b-zoomed-back', agents);
  out(`zoom after the pinch: ${JSON.stringify(await ev(page, '(() => { const s = window.__flow.state().ws[0]; return { zoom: s.zoom, mainZoom: s.mainZoom }; })()'))}`);

  // 5. pop-out: the workspace opens in its own window, then that window closes.
  await mouse(page, 'mouseMoved', 300, 15);
  await sleep(300);
  const pop = await rect(page, '.sp[data-i="0"] .pop');
  if (pop && pop.w) {
    await click(page, pop.x + pop.w / 2, pop.y + pop.h / 2);
    await sleep(6000);
    const solo = await connect(/solo=b7/);
    await compare(solo, '5a-popped-out', agents);
    await ev(solo, 'setTimeout(() => window.close(), 50), true');
    solo.ws.close();
    await sleep(5000);
    await compare(page, '5b-pop-out-closed', agents);
  } else {
    out('5 pop-out: no ⤢ on the workspace pill, skipped');
  }

  // 6. fork the fullscreen agent from its context menu.
  const body = await rect(page, `.win[data-id="${F}"] .fterm-box`);
  await mouse(page, 'mouseMoved', body.x + body.w / 2, body.y + body.h / 2);
  await mouse(page, 'mousePressed', body.x + body.w / 2, body.y + body.h / 2, { button: 'right', buttons: 2 });
  await mouse(page, 'mouseReleased', body.x + body.w / 2, body.y + body.h / 2, { button: 'right', buttons: 0 });
  await sleep(500);
  const fk = await ev(page, '(() => { const b = [...document.querySelectorAll(".ctx button")].find((x) => /^fork/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()');
  if (fk) {
    const before = await ev(page, 'window.__flow.windows().map((w) => w.id)');
    await click(page, fk.x, fk.y);
    await sleep(12000);
    const fork = (await ev(page, 'window.__flow.windows().map((w) => w.id)')).find((id) => !before.includes(id));
    agents.push({ id: fork, name: 'fork' });
    await compare(page, '6-fork', agents);
  } else {
    out('6 fork: no fork item in the menu (the agent may have no conversation yet), skipped');
  }

  // 7. a restart that reattaches every agent.
  page.ws.close();
  out(`quit: ${await quit(25000)}`);
  launch(path.join(USER_DATA, 'main-b7.log'));
  page = await connect();
  await sleep(8000);
  await compare(page, '7-restart', agents);
  page.ws.close();
} else if (step === 'again') {
  const { F, C } = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'b7-ids.json'), 'utf8'));
  const page = await connect();
  const ids = await ev(page, 'window.__flow.windows().filter((w) => w.type === "term").map((w) => w.id)');
  const agents = [{ id: F, name: 'fullscreen' }, { id: C, name: 'classic' }, ...ids.filter((i) => i !== F && i !== C).map((id) => ({ id, name: 'fork' }))];
  await compare(page, '8-now', agents);
  for (const a of agents) {
    for (let i = 0; i < 4; i++) {
      const r = await rect(page, `.win[data-id="${a.id}"] .rz`);
      await drag(page, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, { x: r.x + (i % 2 ? 140 : -140), y: r.y + (i % 2 ? 80 : -80) }, { steps: 8, stepMs: 10 });
      await sleep(250);
    }
    const t = await rect(page, `.win[data-id="${a.id}"] .tb`);
    await dblclick(page, t.x + t.w / 2, t.y + t.h / 2);
    await sleep(800);
    await dblclick(page, t.x + t.w / 2, t.y + t.h / 2);
  }
  await sleep(3000);
  await compare(page, '9-fast-resizes', agents);
  page.ws.close();
} else if (step === 'stream') {
  // Resizes while Claude is still writing its answer (the likeliest trigger for repeated output in a renderer).
  const { F, C } = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'b7-ids.json'), 'utf8'));
  const page = await connect();
  const agents = [{ id: F, name: 'fullscreen' }, { id: C, name: 'classic' }];
  // No window may cover another's resize corner: restore any that is maximized.
  for (const a of agents) {
    if (await ev(page, `!!(window.__flow.state().ws[0].windows.find((w) => w.id === ${JSON.stringify(a.id)}) || {}).max`)) {
      const t = await rect(page, `.win[data-id="${a.id}"] .tb`);
      await dblclick(page, t.x + t.w / 2, t.y + t.h / 2);
      await sleep(800);
    }
  }
  for (const a of agents) {
    await ev(page, `window.__flow.term(${JSON.stringify(a.id)}).focus()`);
    await page.send('Input.insertText', { text: 'print the numbers 1 to 200, one per line, nothing else' });
    await sleep(300);
    await key(page, 'Enter');
  }
  const end = Date.now() + 30000;
  let n = 0;
  while (Date.now() < end) {
    for (const a of agents) {
      const t = await rect(page, `.win[data-id="${a.id}"] .tb`);
      await click(page, t.x + 40, t.y + t.h / 2);
      const r = await rect(page, `.win[data-id="${a.id}"] .rz`);
      if (!r) continue;
      await drag(page, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, { x: r.x + (n % 2 ? 120 : -120), y: r.y + (n % 2 ? 60 : -60) }, { steps: 6, stepMs: 10 });
      a.sizes = a.sizes || new Set();
      a.sizes.add(tmuxTry('display', '-p', '-t', `=flow_${a.id}:`, '#{pane_width}x#{pane_height}').out);
    }
    n++;
    await sleep(400);
  }
  out(`stream: ${n} resize rounds while both answered; sizes seen: ${agents.map((a) => `${a.name} ${[...(a.sizes || [])].join(' ')}`).join('; ')}`);
  await sleep(8000);
  for (const a of agents) {
    const hist = tmuxHistory(a.id);
    out(`stream ${a.name}: in tmux's screen and history the prompt for 200 ${(hist.match(/print the numbers 1 to 200/g) || []).length}x, "200" ${(hist.match(/^\s*200\s*$/gm) || []).length}x, "137" ${(hist.match(/^\s*137\s*$/gm) || []).length}x, "163" ${(hist.match(/^\s*163\s*$/gm) || []).length}x`);
  }
  await compare(page, '10-after-streaming-resizes', agents);
  page.ws.close();
} else if (step === 'stop') {
  out(`quit: ${await quit(25000)}`);
  killTmux();
}




