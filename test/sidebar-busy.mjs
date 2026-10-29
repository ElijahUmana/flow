// sidebar's busy workspace, on the dev app on 9574 started from a fresh state (test/sidebar-dev.sh start --fresh):
// in "flow", a local team named "test team" whose tmux session gets 12 more real panes (each runs `sleep`, titled
// like the members of the ccm team, the case the owner described), two more open pages, a closed shell and a closed
// page that was never saved. Real input only, except __flow.spawn/openPage, which are the dock and a terminal link.
// Everything stays on the socket flow-dev-sidebar.
//   node test/sidebar-busy.mjs
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, size, sleep, click, dblclick, key, type } from './ui-lib.mjs';

const page = await connectTo(9574, /\/src\/index\.html$/);
await size(page, 1500, 913);
for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
await evaluate(page, 'window.__flow.ready');
const tmux = (...a) => execFileSync('tmux', ['-L', 'flow-dev-sidebar', ...a], { encoding: 'utf8' }).trim();

await evaluate(page, '(() => { __flow.go(0); return true; })()');
await sleep(500);
const id = await evaluate(page, '__flow.spawn("team")');
const sess = `flow_${id}`;
for (let i = 0; i < 40; i++) {
  try { tmux('has-session', '-t', sess); break; } catch { await sleep(250); }
}
const names = ['installed', 'sept', 'backlog', 'page', 'build', 'notes', 'nav', 'ux', 'orch', 'flows', 'browse', 'sidebar'];
for (const n of names) {
  const pane = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sess, 'sleep 86400');
  tmux('select-pane', '-t', pane, '-T', n);
  tmux('select-layout', '-t', sess, 'tiled');
}
await evaluate(page, '[__flow.openPage("https://example.com/"), __flow.openPage("https://www.alphaxiv.org/abs/2610.38355")]');
await sleep(800);
const label = await evaluate(page, `(() => { const el = document.querySelector('#sblist .tr[data-act="win|${id}"] .l'); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
if (!label) throw new Error(`no sidebar row for the team ${id}`);
await dblclick(page, label.x, label.y);
await sleep(200);
await key(page, 'a', 2);
await type(page, 'test team');
await key(page, 'Enter');
await sleep(1500);
/* A closed agent and a closed page that was never saved: made, then closed with a real click on the red light. */
const redLight = async (wid) => {
  const at = `(() => { const el = document.querySelector('.win[data-id="${wid}"] [data-l=close]'); const v = document.getElementById('viewport').getBoundingClientRect(); if (!el) return null; const b = el.getBoundingClientRect(); return b.left >= v.left && b.right <= v.right && b.top >= v.top ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`;
  /* in view and done with its opening animation (the same spot twice in a row, nothing outside the sidebar still
     moving); under load a press can still miss, so a second one after a while */
  const moving = () => evaluate(page, `document.getAnimations().some((x) => x.playState === 'running' && x.effect && x.effect.getComputedTiming().endTime !== Infinity && x.effect.target && x.effect.target.closest && !x.effect.target.closest('#sb'))`);
  const open = () => evaluate(page, `!!document.querySelector('.win[data-id="${wid}"]')`);
  for (let attempt = 0; attempt < 2 && (await open()); attempt++) {
    let r = null, last = null;
    for (let i = 0; i < 60; i++) {
      r = await evaluate(page, at);
      if (r && last && r.x === last.x && r.y === last.y && !(await moving())) break;
      last = r;
      await sleep(150);
    }
    if (!r) throw new Error(`the red light of ${wid} never came into view`);
    await click(page, r.x, r.y);
    for (let i = 0; i < 40 && (await open()); i++) await sleep(150);
  }
  if (await open()) throw new Error(`${wid} did not close`);
};
await redLight(await evaluate(page, '__flow.spawn("shell")'));
await redLight(await evaluate(page, '__flow.openPage("https://example.org/")'));
await sleep(2500);
console.log(`team ${id} (${sess}): ${tmux('list-panes', '-t', sess, '-F', '#{pane_title}').split('\n').length} panes; pages: ${(await evaluate(page, '__flow.windows().filter((w) => w.ws === "flow" && w.type === "page").map((w) => w.url)')).join(', ')}`);
page.ws.close();




