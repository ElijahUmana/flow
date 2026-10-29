// sidebar's check of what a page row's hover card and the sidebar's menus show: the card names a page as its row does,
// also a saved page whose title changed after it was saved (the row then shows its record's title), with its site once;
// and "remove" and "delete" in the menus carry no grey text beside them (the toast's undo already says it). Starts the
// dev app on a fresh state and serves the page itself on 127.0.0.1.
//   node test/sidebar-card.mjs
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { connectTo, evaluate, size, sleep, click, mouse, key, reporter } from './ui-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const R = reporter();
const dev = (a) => execFileSync('test/sidebar-dev.sh', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let title = 'first title';
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>${title}</title><p>a page about cards</p>`); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/doc`;

dev(['stop']);
dev(['start', '--fresh']);
try {
  const page = await connectTo(9574, /\/src\/index\.html$/);
  await size(page, 1500, 913);
  for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  const ev = (x) => evaluate(page, x);
  const rows = () => ev(`[...document.querySelectorAll('#sblist .tr')].map((e) => ({ act: e.dataset.act, label: (e.querySelector('.l') || {}).textContent || '', dim: e.classList.contains('dim') }))`);
  const rowSel = (act) => `#sblist .tr[data-act="${act}"]`;
  const rect = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { cx: b.left + Math.min(40, b.width / 2), cy: b.top + b.height / 2 }; })()`);
  const press = async (sel, o) => { const r = await rect(sel); if (!r) throw new Error(`nothing at ${sel}`); await click(page, r.cx, r.cy, o); await sleep(450); };
  const menu = async (sel) => {
    const r = await rect(sel);
    if (!r) throw new Error(`nothing at ${sel}`);
    await mouse(page, 'mouseMoved', r.cx, r.cy);
    await mouse(page, 'mousePressed', r.cx, r.cy, { button: 'right', buttons: 2 });
    await mouse(page, 'mouseReleased', r.cx, r.cy, { button: 'right', buttons: 2 });
    await sleep(300);
    return ev(`[...document.querySelectorAll('.ctx button')].map((b) => ({ label: b.firstChild.textContent, grey: (b.querySelector('.k') || {}).textContent || '' }))`);
  };
  const pick = async (label) => {
    const i = await ev(`[...document.querySelectorAll('.ctx button')].findIndex((b) => b.firstChild.textContent === ${JSON.stringify(label)})`);
    if (i < 0) throw new Error(`no menu item ${label}`);
    await press(`.ctx button[data-i="${i}"]`);
  };
  const waitRow = async (test, ms = 8000) => { const t0 = Date.now(); let r; while (!(r = (await rows()).find(test)) && Date.now() - t0 < ms) await sleep(150); return r || null; };

  await ev(`__flow.openPage(${JSON.stringify(url)})`);
  const tab = await waitRow((r) => r.act.startsWith('tab|') && r.label === 'first title', 15000);
  if (!R.ok('the page is open, its row named by its title', !!tab, await rows())) throw new Error('no tab row');
  await menu(rowSel(tab.act));
  await pick('save to a new section');
  await key(page, 'Enter');
  await sleep(300);
  let sv = await waitRow((r) => r.act.startsWith('saved|') && r.label === 'first title');
  R.ok('saved into a new section, bright because it is open', !!sv && !sv.dim, sv);
  await press(`${rowSel(sv.act)} [data-close]`);
  sv = await waitRow((r) => r.act === sv.act && r.dim);
  R.ok('× closes it; it stays saved, dim', !!sv, sv);
  title = 'second title';
  await press(`${rowSel(sv.act)} .l`);
  const back = await waitRow((r) => r.act === sv.act && !r.dim && r.label === 'second title', 15000);
  R.ok('opened again, the page has a new title and its row shows it', !!back, (await rows()).filter((r) => r.act === sv.act));
  for (let i = 0; i < 30 && !(await ev(`FlowNotes.records().some((r) => r.title === 'second title')`)); i++) await sleep(200);
  await press(`${rowSel(sv.act)} [data-close]`);
  const closed = await waitRow((r) => r.act === sv.act && r.dim);
  const savedTitle = await ev(`(__flow.state().ws.flatMap((w) => w.saved || []).find((s) => s.url === ${JSON.stringify(url)}) || {}).title`);
  const recTitle = await ev(`(FlowNotes.records().find((r) => r.url === ${JSON.stringify(url)}) || {}).title`);
  R.ok('closed again: the row keeps the new title (its record\'s), the saved entry still has the old one', !!closed && closed.label === 'second title' && savedTitle === 'first title' && recTitle === 'second title', { closed, savedTitle, recTitle });
  await mouse(page, 'mouseMoved', 900, 500);
  await sleep(300);
  const lr = await rect(`${rowSel(sv.act)} .l`);
  await mouse(page, 'mouseMoved', lr.cx, lr.cy);
  let card = null;
  for (let i = 0; i < 30 && !(card = await ev(`(() => { const c = document.querySelector('.sbcard .nbrief'); return c ? { name: (c.querySelector('.nb-t') || {}).textContent, site: (c.querySelector('.nb-s') || {}).textContent || '', text: c.innerText } : null; })()`)); i++) await sleep(100);
  R.ok('hovering the closed saved page: the card names it as its row does', !!card && !!closed && card.name === closed.label, { card, row: closed && closed.label });
  R.ok('and shows its site once', !!card && card.site === '127.0.0.1' && card.text.split('127.0.0.1').length === 2, card);
  await mouse(page, 'mouseMoved', 900, 500);
  await sleep(300);

  const ws = await ev(`(() => { const w = __flow.state().ws[0]; return { zones: (w.zones || []).map((z) => z.id), closedNote: (w.notes || []).find((n) => n.kind !== 'folder' && n.kind !== 'page' && !w.windows.some((x) => x.noteId === n.id)) }; })()`);
  const zoneItems = ws.zones.length ? await menu(rowSel(`zone|${ws.zones[0]}`)) : null;
  await key(page, 'Escape'); await sleep(200);
  R.ok('a sub-workspace\'s "remove" has no grey text beside it', !!zoneItems && zoneItems.some((x) => x.label === 'remove' && x.grey === ''), zoneItems);
  const noteItems = ws.closedNote ? await menu(rowSel(`note|${ws.closedNote.id}`)) : null;
  await key(page, 'Escape'); await sleep(200);
  R.ok('a closed note\'s "delete" has no grey text beside it', !!noteItems && noteItems.some((x) => x.label === 'delete' && x.grey === ''), noteItems);
  const head = await rect('#sblist .grp[data-grp$=":g:browser"]');
  await mouse(page, 'mouseMoved', head.cx + 60, head.cy);
  await sleep(300);
  await press('#sblist .grp[data-grp$=":g:browser"] .gadd');
  await key(page, 'Enter');
  await sleep(400);
  const empty = await ev(`(() => { const w = __flow.state().ws[0]; const f = w.notes.filter((n) => n.kind === 'folder' && n.holds === 'page' && !(w.saved || []).some((s) => s.section === n.id)); return f.length ? f[f.length - 1].id : null; })()`);
  const secItems = empty ? await menu(rowSel(`sec|${empty}`)) : null;
  await key(page, 'Escape'); await sleep(200);
  R.ok('an empty section\'s "remove" has no grey text beside it', !!secItems && secItems.some((x) => x.label === 'remove' && x.grey === ''), secItems);
  R.ok('no console errors', page.errors.length === 0, page.errors.slice(0, 4));
  page.ws.close();
} finally {
  dev(['stop']);
  srv.close();
}
R.summary();




