// sidebar's check of teams as orch shapes them: each teammate is its own window with w.mate.lead = the team window's
// id, and a terminal dropped on a team has w.group = it. Writes its own state from a fresh seed (test/sidebar-seed.mjs)
// with a team, two teammates, a closed teammate and a grouped terminal (plain shells, nothing runs claude), starts the
// dev app on 9574, checks the agents rows with real clicks, and stops it.
//   node test/sidebar-teams.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { connectTo, evaluate, sleep, size, click, reporter } from './ui-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FILE = '/tmp/flow-dev-sidebar/flow-state.json';
const R = reporter();
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

sh('test/sidebar-dev.sh', ['stop']);
sh('node', ['test/sidebar-seed.mjs']);
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const flow = doc.ws.find((w) => w.id === 'flow');
const shell = (id, title, x, extra) => ({ id, type: 'term', title, cmd: 'shell', cwd: flow.folder, where: 'this Mac', note: '', x, y: 60, w: 20, h: 25, ...extra });
const mate = (name) => ({ mate: { name, team: 'test', color: 'blue', lead: 't-lead', paneId: '' } });
flow.windows.push({ ...shell('t-lead', 'test team', 1.2), type: 'team' });
flow.windows.push(shell('t-m1', 'researcher', 22, mate('researcher')), shell('t-m2', 'tester', 43, mate('tester')), shell('t-g', 'dropped in', 64, { group: 't-lead' }));
flow.closed.push(shell('t-m3', 'reviewer', 85, mate('reviewer')));
fs.writeFileSync(FILE, JSON.stringify(doc));
sh('test/sidebar-dev.sh', ['start']);
try {
  const page = await connectTo(9574, /\/src\/index\.html$/);
  await size(page, 1500, 913);
  for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  await sleep(600);
  const rows = () => evaluate(page, `[...document.querySelectorAll('#sblist .tr')].map((e) => ({ act: e.dataset.act, depth: +((e.className.match(/\\bd(\\d)\\b/) || [0, 0])[1]), label: e.querySelector('.l').textContent, meta: (e.querySelector('.m') || {}).textContent || '', glyph: e.querySelector('.g').textContent, dim: e.classList.contains('dim') }))`);
  const members = ['t-m1', 't-m2', 't-g', 't-m3'];
  const isMember = (r) => members.some((m) => r.act === `win|${m}` || r.act === `reopen|${m}`);
  let rs = await rows();
  const team = rs.find((r) => r.act === 'win|t-lead');
  R.ok('the team is one folded row counting its teammates, closed and grouped ones too', !!team && team.glyph === '▸' && team.meta === '4', team);
  R.ok('no teammate shows as its own agent row while the team is folded', !rs.some(isMember), rs.filter(isMember).map((r) => r.label));
  const g = await evaluate(page, `(() => { const el = document.querySelector('#sblist .tr[data-act="win|t-lead"] .g[data-tog]'); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await click(page, g.x, g.y);
  await sleep(400);
  rs = await rows();
  const at = rs.findIndex((r) => r.act === 'win|t-lead');
  const under = rs.slice(at + 1, at + 5);
  R.ok('▸ lists the four under the team, one level in, each once', under.length === 4 && under.every((r) => r.depth === 1 && isMember(r)) && rs.filter(isMember).length === 4, under.map((r) => `${r.label}${r.dim ? ' (closed)' : ''}`));
  R.ok('the closed teammate is dim and reopens from its row', under.some((r) => r.act === 'reopen|t-m3' && r.dim));
  const m = await evaluate(page, `(() => { const el = document.querySelector('#sblist .tr[data-act="win|t-m2"]'); const b = el.getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`);
  await click(page, m.x, m.y);
  await sleep(500);
  R.ok('clicking a teammate brings its own window to the front', await evaluate(page, `document.querySelector('.win[data-id="t-m2"]').classList.contains('front')`));
  R.ok('no console errors', page.errors.length === 0, page.errors.slice(0, 5));
  page.ws.close();
} finally {
  sh('test/sidebar-dev.sh', ['stop']);
}
R.summary();




