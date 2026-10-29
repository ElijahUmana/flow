// sidebar's check of the one-time page migration (pages leave the notes list; folders of pages become sections).
// Writes its own state from a fresh seed (test/sidebar-seed.mjs), with one closed page that has a note and one closed
// page with nothing written, starts the dev app on 9574, checks what the sidebar and the state show, and stops it.
//   node test/sidebar-migrate.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { connectTo, evaluate, sleep, size, type, key, reporter } from './ui-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FILE = '/tmp/flow-dev-sidebar/flow-state.json';
const R = reporter();
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

sh('test/sidebar-dev.sh', ['stop']);
sh('node', ['test/sidebar-seed.mjs']);
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const flow = doc.ws.find((w) => w.id === 'flow');
flow.windows = flow.windows.filter((w) => w.noteId !== 'p-judge');
flow.notes.push({ id: 'p-plain', kind: 'page', title: 'A page nobody wrote about', url: 'https://example.org/plain', body: '' });
fs.writeFileSync(FILE, JSON.stringify(doc));
sh('test/sidebar-dev.sh', ['start']);
try {
  const page = await connectTo(9574, /\/src\/index\.html$/);
  await size(page, 1500, 913);
  for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
await evaluate(page, 'window.__flow.ready');
  await sleep(800);
  const s = await evaluate(page, '__flow.state().ws.find((w) => w.id === "flow")');
  const saved = s.saved || [];
  const by = (re) => saved.find((x) => re.test(x.title));
  const sec = (id) => s.notes.find((n) => n.id === id && n.kind === 'folder');
  const read = s.notes.find((n) => n.kind === 'folder' && n.title === 'reading list');
  R.ok('the folder "reading list" became a page section holding its four pages', !!read && read.holds === 'page' && saved.filter((x) => x.section === read.id).length === 4, { read, saved: saved.map((x) => `${(sec(x.section) || {}).title}: ${x.title}`) });
  R.ok('its pages are no longer children of it in the notes', !s.notes.some((n) => n.kind === 'page' && n.parent), s.notes.filter((n) => n.parent).map((n) => n.id));
  const cj = by(/Careful Judge/);
  R.ok('a closed page with a note was kept, in a page section called "saved"', !!cj && !!sec(cj.section) && sec(cj.section).title === 'saved' && sec(cj.section).holds === 'page', cj);
  R.ok('a closed page with nothing written was not saved', !by(/nobody wrote/), saved.map((x) => x.title));
  R.ok('open pages were not saved', !by(/judgment bottleneck/i) && !by(/FlatCake/), saved.map((x) => x.title));
  /* batch 2: page text moves into notes.js's page records; every page the owner had stays open, saved or a record */
  const was = { 'p-mck': 'https://www.mckinsey.com/', 'p-judge': 'https://www.alphaxiv.org/abs/2610.09043', 'p-kv': 'https://www.alphaxiv.org/abs/2610.38355', 'p-9a': 'https://www.alphaxiv.org/abs/2610.22948', 'p-plain': 'https://example.org/plain' };
  const kept = await evaluate(page, `(() => { const key = FlowNotes.key, recs = new Set(FlowNotes.records().map((r) => r.key)); const ws = __flow.state().ws.find((w) => w.id === 'flow');
    const open = new Set(__flow.windows().filter((w) => w.type === 'page').map((w) => key(w.url))); const saved = new Set((ws.saved || []).map((x) => key(x.url)));
    return Object.fromEntries(Object.entries(${JSON.stringify(was)}).map(([id, u]) => { const n = ws.notes.find((x) => x.id === id); const k = key(n && n.url ? n.url : u); return [id, open.has(k) || saved.has(k) || recs.has(k)]; })); })()`);
  R.ok('every page the owner had is still open, saved or a page record (only the owner\'s × removes one)', Object.values(kept).every(Boolean), kept);
  const groups = await evaluate(page, `[...document.querySelectorAll('#sblist .grp')].map((g) => g.textContent)`);
  const want = ['agents', 'notes', 'browser', ...((await evaluate(page, '!!window.FlowFiles')) ? ['files'] : [])];
  const heads = await evaluate(page, `[...document.querySelectorAll('#sblist .tr.sph')].map((e) => e.dataset.act)`);
  R.ok(`the sidebar groups are ${want.join(', ')}, under the main workspace's heading, then the sub-workspaces' headings`, JSON.stringify(groups) === JSON.stringify(want) && heads[0] === 'zone|' && heads.length >= 2, { groups, heads });
  await evaluate(page, `(() => { const q = document.getElementById('q'); q.focus(); return true; })()`);
  await type(page, 'nobody wrote');
  await sleep(500);
  const hits = await evaluate(page, `[...document.querySelectorAll('#sblist .tr')].map((e) => e.dataset.act)`);
  R.ok('⌘K still finds the closed page that was not saved', hits.some((h) => /^rec\|https:\/\/example\.org\/plain$/.test(h)), hits);
  await key(page, 'Escape');
  const again = (await evaluate(page, '__flow.state().ws.find((w) => w.id === "flow")')).saved.length;
  await page.send('Page.reload', {});
  page.ws.close();
  await sleep(2500);
  const page2 = await connectTo(9574, /\/src\/index\.html$/);
  for (let i = 0; i < 60 && !(await evaluate(page2, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page2, 'window.__flow.ready');
  const after = (await evaluate(page2, '__flow.state().ws.find((w) => w.id === "flow")')).saved.length;
  R.ok('the migration runs once: after a reload the saved list is the same', after === again, { before: again, after });
  R.ok('no console errors', page.errors.length === 0 && page2.errors.length === 0, [...page.errors, ...page2.errors].slice(0, 5));
  page2.ws.close();
} finally {
  sh('test/sidebar-dev.sh', ['stop']);
}
R.summary();




