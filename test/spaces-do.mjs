// Runs code against spaces' running app with real input: node test/spaces-do.mjs '<async body>' or <steps.mjs>.
// In scope: c (the main Flow window), win(match) (another window, e.g. a pop-out), m (the main process, when the app was
// launched with its inspector), S (spaces-lib), N (nav-lib: mouse, drag, wheel, swipe, shot, sleep, waitFor), ev(expr),
// box(selector), press(x, y), shot(name) (into SPACES_SHOTS or /tmp/flow-dev-spaces/shots).
import fs from 'node:fs';
import path from 'node:path';
import * as S from './spaces-lib.mjs';
import * as N from './nav-lib.mjs';

const arg = process.argv[2];
if (!arg) { console.error('usage: node test/spaces-do.mjs \'<async body>\' | <steps.mjs>'); process.exit(2); }
const SHOTS = process.env.SPACES_SHOTS || path.join(S.USER_DATA, 'shots');
const c = await S.flowWindow();
let m = null;
try { m = await S.mainProcess(); } catch (err) { console.log(`no main process in scope (the app runs without its inspector): ${err.message}`); m = null; }
const ev = (x) => c.eval(x);
const box = (sel, on = c) => on.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
const press = async (x, y, on = c, o = {}) => { await N.mouse(on, 'mouseMoved', x, y); await N.mouse(on, 'mousePressed', x, y, o); await N.mouse(on, 'mouseReleased', x, y, o); };
const shot = (name, on = c) => N.shot(on, path.join(SHOTS, `${name}.png`));
const win = (match) => S.flowWindow((u) => /\/src\/index\.html/.test(u) && match.test(u));
const scope = { c, m, S, N, ev, box, press, shot, win, sleep: N.sleep, waitFor: N.waitFor };
try {
  const out = fs.existsSync(arg) ? await (await import(path.resolve(arg))).default(scope)
    : await new Function(...Object.keys(scope), `return (async () => { ${arg} })();`)(...Object.values(scope));
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  if (c.errors.length) console.log('console errors:\n  ' + c.errors.join('\n  '));
} catch (e) {
  console.log('STEP FAILED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  c.close();
  if (m) m.close();
}




