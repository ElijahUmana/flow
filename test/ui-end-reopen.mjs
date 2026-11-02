// Item 71's reopen race (installed): a closed shell's × shows "ended / undo" at once and its session ends behind it;
// an undo and a reopen before that end has settled must get a new shell, not attach to the session being ended. main's
// pty.kill is held 3 s through the main process's inspector, as long as its process scan can take under load, so the
// reopen lands inside the kill. Real input.
//   node test/ui-end-reopen.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e)
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';
import { PORT, INSPECT, SOCK } from './ui-env.mjs';

const R = reporter();
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOLD = 3000;
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
// tmux exits 1 for every error: only "no such session or server" is a session that is not there
function hasSession(id) {
  try {
    execFileSync('tmux', ['-L', SOCK, 'has-session', '-t', `=flow_${id}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (err) {
    if (err.status === 1 && /no server running|can't find session|error connecting to .*\(No such file or directory\)/.test(String(err.stderr))) return false;
    throw err;
  }
}
const waitFor = async (app, expr, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await evaluate(app, expr); if (v) return v; }
  return evaluate(app, expr);
};
const box = (app, sel) => evaluate(app, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
const text = (id) => `(() => { const t = __flow.term(${JSON.stringify(id)}); return t ? t.getText() : ''; })()`;

dev('stop');
dev('start', '--fresh');
const app = await connectTo(PORT, /\/src\/index\.html$/);
for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
await evaluate(app, 'window.__flow.ready');
if ((await evaluate(app, '[innerWidth, innerHeight].join()')) !== '1500,913') {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
}
await sleep(800);
const main = await connectTo(INSPECT, '', 'node');
const PTY = JSON.stringify(path.join(ROOT, 'src', 'pty.js'));
try {
  // a new shell from the desktop's right-click, with a line of its own
  const p = await evaluate(app, `(() => { const v = document.getElementById('viewport').getBoundingClientRect(); for (let y = v.top + 80; y < v.bottom - 160; y += 30) for (let x = v.left + 40; x < v.right - 40; x += 30) { const e = document.elementFromPoint(x, y); if (e && !e.closest('.win, .toast, .ctx, #dock')) return { x, y }; } return null; })()`);
  if (!R.ok('the desktop has an empty spot to right-click', !!p)) throw new Error('no empty spot');
  const had = new Set((await evaluate(app, '__flow.windows()')).map((w) => w.id));
  await mouse(app, 'mouseMoved', p.x, p.y);
  await mouse(app, 'mousePressed', p.x, p.y, { button: 'right', buttons: 2 });
  await mouse(app, 'mouseReleased', p.x, p.y, { button: 'right', buttons: 2 });
  await sleep(300);
  const b = await evaluate(app, `(() => { const e = [...document.querySelectorAll('.ctx button')].find((x) => /^new shell here/.test(x.textContent)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!R.ok('the right-click offers a new shell here', !!b)) throw new Error('no menu');
  await click(app, b.x, b.y);
  await sleep(1500);
  const sh = (await evaluate(app, '__flow.state()')).ws.flatMap((ws) => ws.windows).find((w) => !had.has(w.id) && w.cmd === 'shell');
  if (!R.ok('a new shell window opens', !!sh)) throw new Error('no shell');
  const id = sh.id, row = `.tr[data-act="reopen|${id}"]`;
  await waitFor(app, `${text(id)}.trim().length > 0`, 20000);
  const g = await box(app, `.win[data-id="${id}"] .termhost`);
  await click(app, g.x, g.y);
  await sleep(300);
  await type(app, 'echo first-$((6*7))');
  await key(app, 'Enter');
  R.ok('the shell runs a command', !!(await waitFor(app, `${text(id)}.includes('first-42')`, 10000)));

  // closed: its row in the sidebar; then main's kill is held, and the row's × ends it
  const close = await box(app, `.win[data-id="${id}"] > .tb [data-l=close]`);
  await click(app, close.x, close.y);
  R.ok('closing the shell leaves its row', !!(await waitFor(app, `!!document.querySelector(${JSON.stringify(row)})`, 5000)));
  const held = await evaluate(main, `(() => { const pty = require(${PTY}); if (!pty.__uiKill) pty.__uiKill = pty.kill; pty.kill = (...a) => new Promise((r) => setTimeout(r, ${HOLD})).then(() => pty.__uiKill(...a)); return true; })()`, true);
  if (!R.ok(`main's kill is held ${HOLD} ms`, held === true)) throw new Error('kill not held');
  const end = await box(app, `${row} [data-end]`);
  await mouse(app, 'mouseMoved', end.x - 30, end.y);
  await sleep(100);
  const e2 = await box(app, `${row} [data-end]`);
  const t0 = Date.now();
  await click(app, e2.x, e2.y);
  const shown = await waitFor(app, `!document.querySelector(${JSON.stringify(row)}) && /^ended/.test(document.getElementById('toast').textContent) && document.getElementById('toast').classList.contains('on')`, 2000);
  R.ok('the × shows its result at once: the row goes, "ended / undo" shows', !!shown, { ms: Date.now() - t0 });

  // undo, then the row reopens the shell, all inside the held kill
  const undo = await box(app, '#toast .tact');
  if (!R.ok('the toast offers undo', !!undo)) throw new Error('no undo');
  await click(app, undo.x, undo.y);
  R.ok('undo brings the row back', !!(await waitFor(app, `!!document.querySelector(${JSON.stringify(row)})`, 2000)));
  const rb = await box(app, row);
  await click(app, rb.x, rb.y);
  const back = await waitFor(app, `!!document.querySelector('.win[data-id="${id}"]')`, 2000);
  const inside = hasSession(id);
  R.ok('the reopened window shows at once, while its old session is still being ended', !!back && inside, { back, oldSessionThere: inside, ms: Date.now() - t0 });
  const early = await evaluate(app, `({ term: !!__flow.term(${JSON.stringify(id)}), text: ${text(id)} })`);
  R.ok('meanwhile it does not attach to the session being ended', !early.term && !early.text.includes('first-42'), early);

  // once the kill has settled: a new shell, with the keys, that the kill does not end
  let termAt = 0;
  for (const stop = Date.now() + HOLD + 15000; Date.now() < stop && !termAt; await sleep(100)) if (await evaluate(app, `!!__flow.term(${JSON.stringify(id)})`)) termAt = Date.now();
  const opened = await waitFor(app, `${text(id)}.trim().length > 0`, 20000);
  R.ok('the window opens its shell only once the kill has settled', !!termAt && termAt - t0 >= HOLD && !!opened && hasSession(id), { termMs: termAt ? termAt - t0 : null });
  R.ok('the new shell has the keys', !!(await evaluate(app, `(() => { const a = document.activeElement, w = document.querySelector('.win[data-id="${id}"]'); return !!a && !!w && w.contains(a); })()`)));
  const g2 = await box(app, `.win[data-id="${id}"] .termhost`);
  await click(app, g2.x, g2.y);
  await sleep(300);
  await type(app, 'echo second-$((6*7))');
  await key(app, 'Enter');
  const after = await waitFor(app, `${text(id)}.includes('second-42') && ${text(id)}`, 10000);
  R.ok('it is a new shell: it runs a command and has none of the old one\'s lines', !!after && !after.includes('first-42'), after && after.slice(-200));
  await sleep(3000);
  R.ok('its session is still there 3 s later', hasSession(id) && !!(await evaluate(app, `!!__flow.term(${JSON.stringify(id)})`)));
} finally {
  await evaluate(main, `(() => { const pty = require(${PTY}); if (pty.__uiKill) { pty.kill = pty.__uiKill; delete pty.__uiKill; } return true; })()`, true);
  main.ws.close();
  dev('stop');
}
R.summary();
process.exit();




