// Coming back after a quit (principle 5: "every window, tab ... survives a quit"): the window in front, a page's tabs
// and the sub-workspace on screen, set with real input, then the app stopped and started again on the same state.
//   node test/ui-restart.mjs   (stops and starts test/ui-dev.sh itself; UI_ROLE and UI_PORT as for ui-e2e)
import { execFileSync } from 'node:child_process';
import { connectTo, evaluate, sleep, click, mouse, key, type, reporter } from './ui-lib.mjs';
import { PORT } from './ui-env.mjs';

const R = reporter();
const dev = (...a) => execFileSync('test/ui-dev.sh', a, { encoding: 'utf8' });
const HELP = `window.__t = {
  r(el) { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; },
  row(act) { return this.r(document.querySelector('.tr[data-act="' + act + '"]')); },
};`;
async function open() {
  const app = await connectTo(PORT, /\/src\/index\.html$/);
  for (let i = 0; i < 80 && !(await evaluate(app, '!!window.__flow')); i++) await sleep(250);
  await evaluate(app, 'window.__flow.ready');
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
  await evaluate(app, HELP);
  await sleep(800);
  return app;
}
const waitFor = async (app, expr, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await evaluate(app, expr); if (v) return v; }
  return evaluate(app, expr);
};

dev('stop');
dev('start', '--fresh');
let app = await open();
// a second tab in the McKinsey page window: bring it to the front from its sidebar row, the dock's page button,
// then an address
let row = await evaluate(app, '__t.row("tab|w-mck|0")');
await click(app, row.cx, row.cy);
await sleep(600);
const v = await evaluate(app, '__t.r(document.getElementById("viewport"))');
const pb = await evaluate(app, `__t.r(document.querySelector('#dock [data-k="page"]'))`);
await mouse(app, 'mouseMoved', pb.cx, v.y + v.h - 3);
await sleep(300);
await waitFor(app, `(() => { const d = document.getElementById('dock'); return getComputedStyle(d).visibility !== 'hidden' && d.style.opacity !== '0'; })()`, 3000);
// up to the button in small steps, as a hand does (dock.js drops a click after one big step up)
for (let y = v.y + v.h - 6; y > pb.cy; y -= 3) await mouse(app, 'mouseMoved', pb.cx, y);
await click(app, pb.cx, pb.cy);
await sleep(800);
await type(app, 'example.com');
await key(app, 'Enter');
const tabs = await waitFor(app, '(() => { const t = __flow.page("w-mck").tabs(); return t.tabs.length === 2 && /example\\.com/.test(t.tabs[1].url || "") ? t : null; })()', 20000);
R.ok('before: w-mck has two tabs, the second on example.com', !!tabs, tabs || await evaluate(app, '(() => { const p = __flow.page("w-mck"); return { tabs: p && p.tabs().tabs.map((t) => t.url), front: [...document.querySelectorAll(".win.front")].map((w) => w.dataset.id), windows: __flow.windows().map((w) => w.id), active: document.activeElement && document.activeElement.className }; })()'));
// a new tab focuses its page when the webview attaches, which can land after a click elsewhere (sent to page): wait
// for the load to finish so the click below is the last thing that picks the window in front
await waitFor(app, '!__flow.page("w-mck").isLoading()', 20000);
await sleep(800);
// "this week" to the front, by its title bar
const wk = await evaluate(app, '__t.r(document.querySelector(\'.win[data-id="w-week"] > .tb\'))');
const under = await evaluate(app, `(() => { const h = document.elementFromPoint(${wk.x + wk.w * 0.3}, ${wk.cy}); return h ? h.className + ' / ' + ((h.closest('.win') || {}).dataset || {}).id : null; })()`);
await click(app, wk.x + wk.w * 0.3, wk.cy);
await sleep(400);
R.ok('before: "this week" is the window in front', await evaluate(app, 'document.querySelector(\'.win[data-id="w-week"]\').classList.contains("front")'), { under, at: [wk.x + wk.w * 0.3, wk.cy] });
// into the research sub-workspace
row = await evaluate(app, '__t.row("zone|z-research")');
await click(app, row.cx, row.cy);
await sleep(800);
R.ok('before: research is the space on screen', await evaluate(app, '__flow.state().ws[0].at === "z-research"'));
await sleep(1500);

dev('stop');
dev('start');
app = await open();
const after = await evaluate(app, `(() => {
  const s = __flow.state(), f = s.ws[0];
  const wins = [...document.querySelectorAll('.ws[data-id="flow"] .win')];
  const z = (id) => +(document.querySelector('.win[data-id="' + id + '"]') || { style: {} }).style.zIndex || 0;
  const topMain = f.windows.filter((w) => !w.zone).map((w) => w.id).sort((a, b) => z(b) - z(a))[0];
  const t = __flow.page('w-mck');
  return { at: f.at, pill: document.querySelectorAll('.sp')[0].textContent, topMain, front: wins.filter((w) => w.classList.contains('front')).map((w) => w.dataset.id),
    tabs: t ? t.tabs() : null };
})()`);
R.ok('after: the research sub-workspace is still the space on screen', after.at === 'z-research' && /› research/.test(after.pill), { at: after.at, pill: after.pill });
R.ok('after: "this week" is still on top of the main space\'s windows', after.topMain === 'w-week', { topMain: after.topMain, front: after.front });
R.ok('after: w-mck has its two tabs back, the second on example.com, the same one shown',
  !!after.tabs && after.tabs.tabs.length === 2 && /example\.com/.test(after.tabs.tabs[1].url || '') && after.tabs.tab === tabs.tab, after.tabs);
R.ok('no console errors or exceptions after the restart', app.errors.filter((e) => !e.startsWith('console.warning')).length === 0, app.errors.slice(0, 3));

// again from the main space, where the page window w-mck loads its page at start (flows' 7.x): "this week" stays on top
// the workspace's name: a click on "› research" after it no longer leaves the sub-workspace (item 18)
const pill = await evaluate(app, '(() => { const p = document.querySelectorAll(".sp")[0]; return __t.r((p && p.querySelector(".sn")) || p); })()');
await click(app, pill.cx, pill.cy);
await sleep(800);
R.ok('before 2: the main space is on screen', await evaluate(app, '!__flow.state().ws[0].at'));
await sleep(1500);
dev('stop');
dev('start');
app = await open();
const top = `(() => { const f = __flow.state().ws[0];
  const z = (id) => +(document.querySelector('.win[data-id="' + id + '"]') || { style: {} }).style.zIndex || 0;
  return { at: f.at || null, top: f.windows.filter((w) => !w.zone).map((w) => w.id).sort((a, b) => z(b) - z(a))[0], front: [...document.querySelectorAll('.ws[data-id="flow"] .win.front')].map((w) => w.dataset.id),
    loaded: !!__flow.page('w-mck') && !__flow.page('w-mck').isLoading() }; })()`;
const t0 = await evaluate(app, top);
await waitFor(app, '!!__flow.page("w-mck") && !__flow.page("w-mck").isLoading()', 20000);
await sleep(1500);
const t1 = await evaluate(app, top);
R.ok('after 2: "this week" is on top right after the start', t0.at === null && t0.top === 'w-week', t0);
R.ok('after 2: and still on top once the page in that space has loaded', t1.top === 'w-week' && t1.front.join() === 'w-week', t1);
R.ok('no console errors or exceptions after the second restart', app.errors.filter((e) => !e.startsWith('console.warning')).length === 0, app.errors.slice(0, 3));

// a window raised in a pop-out, then another raised in the main window: after a restart the main window's one is on
// top (flows' 7.x: the pop-out counts its own z, so its raise outranked the later one)
row = await evaluate(app, '__t.row("zone|z-research")');
await click(app, row.cx, row.cy);
await sleep(800);
await mouse(app, 'mouseMoved', row.cx, row.cy);
await sleep(200);
const zpop = await evaluate(app, '__t.r(document.querySelector(\'.tr[data-act="zone|z-research"] [data-zpop]\'))');
if (zpop) await click(app, zpop.cx, zpop.cy);
const sp = zpop ? await connectTo(PORT, 'zone=z-research') : null;
R.ok('before 3: ⤢ pops research out', !!sp);
if (sp) {
  for (let i = 0; i < 40 && !(await evaluate(sp, '!!window.__flow')); i++) await sleep(250);
  await evaluate(sp, 'window.__flow.ready');
  await sp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 913, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  const jt = await evaluate(sp, '(() => { const b = document.querySelector(\'.win[data-id="w-judge"] > .tb\').getBoundingClientRect(); return { x: b.left + b.width * 0.3, y: b.top + b.height / 2 }; })()');
  await click(sp, jt.x, jt.y);
  await sleep(600);
  R.ok('before 3: in the pop-out, w-judge is in front', await evaluate(sp, 'document.querySelector(\'.win[data-id="w-judge"]\').classList.contains("front")'));
  await evaluate(sp, 'setTimeout(() => window.close(), 50), true');
  // research comes back in the main window once the pop-out has gone (seconds at load 100)
  await waitFor(app, '(() => { const w = document.querySelector(\'.win[data-id="w-kv"]\'); return !!w && getComputedStyle(w).display !== "none" && w.getBoundingClientRect().width > 0 && !document.querySelector(".away:not([style*=\\"display: none\\"])"); })()', 15000);
  await sleep(500);
  const kt = await evaluate(app, '__t.r(document.querySelector(\'.win[data-id="w-kv"] > .tb\'))');
  const kunder = await evaluate(app, `(() => { const h = document.elementFromPoint(${kt.x + kt.w * 0.3}, ${kt.cy}); return h ? ((h.closest('.win') || {}).dataset || {}).id || h.className : null; })()`);
  await click(app, kt.x + kt.w * 0.3, kt.cy);
  await sleep(600);
  R.ok('before 3: back in the main window, w-kv is in front', await evaluate(app, 'document.querySelector(\'.win[data-id="w-kv"]\').classList.contains("front")'), { under: kunder, at: [kt.x + kt.w * 0.3, kt.cy] });
  await sleep(1500);
  dev('stop');
  dev('start');
  app = await open();
  const r3 = await evaluate(app, `(() => { const f = __flow.state().ws[0];
    const z = (id) => +(document.querySelector('.win[data-id="' + id + '"]') || { style: {} }).style.zIndex || 0;
    return { at: f.at || null, top: f.windows.filter((w) => w.zone === 'z-research').map((w) => w.id).sort((a, b) => z(b) - z(a))[0],
      saved: Object.fromEntries(f.windows.filter((w) => w.zone === 'z-research').map((w) => [w.id, w.z])) }; })()`);
  R.ok('after 3: w-kv, raised last, is on top of research', r3.at === 'z-research' && r3.top === 'w-kv', r3);
}
R.summary();
dev('stop');
process.exit();




