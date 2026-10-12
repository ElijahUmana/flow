// flows: ending an agent shows at once (STATUS item 71). Three new agents from the dock, each ended with its row's × once
// Claude Code is up; the row must go and "ended ... undo" show within 1.5 s each time, and the session end within 30 s
// (it may end behind the toast). Claude only in flow's folder under L.WORK. node test/flows-end.mjs [label]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from './flows-lib.mjs';

const label = process.argv[2] || 'end-lag';
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(' ')}`);
let page = null;
const ev = (e) => L.ev(page, e);
const ids = () => ev(`window.__flow.windows().map((w) => w.id)`);
const newWin = async (before, ms = 15000) => (await L.until(page, `window.__flow.windows().map((w) => w.id).filter((w) => !${JSON.stringify(before)}.includes(w))[0]`, ms)).v;
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
async function waitClaude(id, ms = 60000) {
  const v = await L.until(page, `(() => { const h = window.__flow.term(${JSON.stringify(id)}); const t = h && h.getText(60); if (!t) return false; if (/trust this folder/.test(t)) return 'TRUST'; return /bypass permissions|for shortcuts|\\? for shortcuts|❯/.test(t) && /Claude Code|❯/.test(t) && 'ready'; })()`, ms, 200);
  if (v.v === 'TRUST') throw new Error(`${id} stopped at the folder trust question (not answered)`);
}
const load = () => fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');

log('tree:', L.APP, spawnSync('sh', ['-c', `cd ${L.APP} && md5sum src/app.js src/pty.js | cut -c1-8,33- | tr "\\n" " "`], { encoding: 'utf8' }).stdout, 'load', load());
log(await L.stop());
L.tmux('kill-server');
const seedRun = spawnSync('node', [path.join(L.ROOT, 'test/flows-seed.mjs')], { encoding: 'utf8', cwd: L.ROOT, env: process.env });
if (seedRun.status) throw new Error(`seed failed: ${seedRun.stderr}`);
fs.rmSync(path.join(L.UD, 'Preferences'), { force: true });
await L.launch(`${label}`);
page = await L.connect();
await L.until(page, 'window.__flow && 1', 30000);
await ev('window.__flow.ready');
await L.sleep(3000);
const out = [];
try {
  const folder = await ev(`(() => { const st = window.__flow.state(); return st.ws.find((w) => w.id === st.ui.at).folder; })()`);
  const abs = folder.replace(/^~/, process.env.HOME);
  if (!abs.startsWith(L.WORK)) throw new Error(`not starting claude in ${folder}`);
  for (let k = 1; k <= 3; k++) {
    const before = await ids();
    const b = await dockButton('agent');
    await L.click(page, b.cx, b.cy);
    const id = await newWin(before);
    await waitClaude(id);
    await L.sleep(1500);
    const red = await L.rect(page, `.win[data-id="${id}"] .tb [data-l="close"]`);
    await L.click(page, red.cx, red.cy);
    await L.sleep(600);
    const x = await ev(`(() => { const r = document.querySelector('#sblist [data-act="reopen|${id}"]'); if (!r) return null; r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); const e = r.querySelector('[data-end]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!x) throw new Error(`no end (×) on ${id}'s closed row`);
    await L.mouse(page, 'mouseMoved', x.x, x.y);
    await L.sleep(200);
    // an earlier end's "ended" toast stays 8 s: wait for it to go, so this end's toast is the one timed
    await L.until(page, `![...document.querySelectorAll('.toast.on')].some((t) => /ended/.test(t.innerText))`, 12000, 100).catch(() => null);
    const loadAt = load();
    await L.click(page, x.x, x.y);
    const t = Date.now(), seen = { rowGoneMs: null, toastMs: null, sessionGoneMs: null };
    while (Date.now() - t < 30000 && (seen.rowGoneMs == null || seen.toastMs == null || seen.sessionGoneMs == null)) {
      const ui = await ev(`({ row: !!document.querySelector('#sblist [data-act="reopen|${id}"]'), toast: [...document.querySelectorAll('.toast.on')].some((t) => /ended/.test(t.innerText)) })`);
      if (seen.rowGoneMs == null && !ui.row) seen.rowGoneMs = Date.now() - t;
      if (seen.toastMs == null && ui.toast) seen.toastMs = Date.now() - t;
      if (seen.sessionGoneMs == null && L.tmux('has-session', '-t', `flow_${id}`).match(/can't find|no server running/) != null) seen.sessionGoneMs = Date.now() - t;
      await L.sleep(50);
    }
    out.push(seen);
    log(`end ${k}: row gone ${seen.rowGoneMs} ms, "ended" ${seen.toastMs} ms, session gone ${seen.sessionGoneMs} ms (load ${loadAt})`);
    await L.sleep(3000);
  }
} finally {
  page.ws.close();
  log(await L.stop());
  L.tmux('kill-server');
}
const ok = out.length === 3 && out.every((e) => e.rowGoneMs != null && e.rowGoneMs <= 1500 && e.toastMs != null && e.toastMs <= 1500 && e.sessionGoneMs != null);
process.exitCode = ok ? 0 : 1;
log(`${ok ? 'ok  ' : 'BAD '} item 71: ending an agent shows at once (row and "ended" within 1.5 s, the session gone within 30 s): ${JSON.stringify(out)}`);




