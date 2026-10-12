// flows: quit or crash flows' app and come back. node test/flows-restart.mjs <graceful|crash|reboot> <label> [note text]
import * as L from './flows-lib.mjs';

const [mode, label, noteText] = process.argv.slice(2);
const t00 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t00) / 1000).toFixed(1)}s]`, ...a);
const panes = () => Object.fromEntries(L.tmux('list-panes', '-a', '-F', '#{session_name} #{pane_pid} #{pane_current_command}').trim().split('\n').filter(Boolean).map((l) => { const [s, p, c] = l.split(' '); return [s, `${p} ${c}`]; }));
const summary = async (page) => L.ev(page, `(() => { const st = window.__flow.state(); return { at: st.ui.at, ws: st.ws.map((w) => ({ id: w.id, pan: Math.round(w.pan || 0), wins: w.windows.length, closed: w.closed.length })), week: (st.ws[0].notes.find((n) => n.id === 'n-week') || {}).body }; })()`);

let page = await L.connect();
if (noteText) {
  // type into the "this week" note body with real keys, at the end
  // the sidebar row brings the note's window into view, as the owner would get to it
  const row = await L.rect(page, '#sblist .tr[data-act="note|n-week"]');
  await L.click(page, row.x + 40, row.cy);
  await L.sleep(900);
  const r = await L.rect(page, '.win[data-id="w-week"] .nbody');
  if (!r || r.x < 0 || r.x > 1500) throw new Error('the this-week note is not on screen: ' + JSON.stringify(r));
  await L.click(page, r.x + r.w - 10, r.y + r.h - 10);
  await L.key(page, 'End', L.MOD.ctrl);
  await L.type(page, noteText);
  log('typed into this week; waiting', process.env.WAIT || 1000, 'ms before stopping');
  await L.sleep(+(process.env.WAIT || 1000));
}
const before = { s: await summary(page), panes: panes(), targets: (await L.targets()).filter((t) => t.type === 'page').map((t) => t.url.replace(/^.*index\.html/, 'index.html')) };
page.ws.close();
log('before:', JSON.stringify(before));
if (mode === 'crash') log(await L.stop({ kill9: true }));
else log(await L.stop());
if (mode === 'reboot') { log('tmux kill-server:', L.tmux('kill-server') || 'ok'); }
await L.sleep(1500);
log('tmux after stop:', JSON.stringify(panes()));
const t0 = Date.now();
const up = await L.launch(`${label}`);
log('window up in', up.ms, 'ms');
page = await L.connect();
await L.until(page, 'window.__flow && 1', 30000);
await L.ev(page, 'window.__flow.ready');
log('ready after', Date.now() - t0, 'ms');
const vis = await L.ev(page, `window.__flow.windows().filter((w) => w.visible && (w.type === 'term' || w.type === 'team')).map((w) => w.id)`);
const res = await L.until(page, `(() => { const ids = ${JSON.stringify(vis)}; const empty = ids.filter((id) => { const t = window.__flow.term(id); return !t || !t.getText(30).trim(); }); return empty.length === 0 ? 'all' : false; })()`, 60000, 200).catch((e) => ({ v: e.message }));
log('all visible terminals have content after', Date.now() - t0, 'ms', res.v === 'all' ? '' : res.v);
await L.sleep(4000);
const after = { s: await summary(page), panes: panes(), targets: (await L.targets()).filter((t) => t.type === 'page').map((t) => t.url.replace(/^.*index\.html/, 'index.html')) };
log('after:', JSON.stringify(after));
const kept = Object.keys(before.panes).filter((k) => k.startsWith('flow_') && after.panes[k] === before.panes[k]);
log('sessions with the same pane pid:', kept.length, 'of', Object.keys(before.panes).filter((k) => k.startsWith('flow_')).length);
const texts = await L.ev(page, `Object.fromEntries(${JSON.stringify(vis)}.map((id) => [id, window.__flow.term(id).getText(14).split('\\n').filter((l) => l.trim()).slice(-6).join(' ⏎ ')]))`);
log('visible terminals:', JSON.stringify(texts, null, 1));
log('shot', await L.shot(page, `restart-${label}`));
if (page.errors.length) log('page errors:', page.errors.join(' | '));
page.ws.close();




