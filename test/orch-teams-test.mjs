// orch's checks of src/teams.js rules that the live runs can't cover on this VM: it never moves panes out of an attach
// session (the VM's ccm), a pane that is not a teammate yet is checked again only when its command changes, a teammate
// window whose session was made again says the team link ended, and runsOn. teams.js runs in a vm context with a
// window.flow that records every call. Usage: node test/orch-teams-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(process.env.ORCH_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const code = fs.readFileSync(path.join(ROOT, 'src/teams.js'), 'utf8');
let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
  if (!cond) failed++;
};
const tick = () => new Promise((r) => setTimeout(r, 20));

function setup({ panes, mates }) {
  const calls = [];
  const flow = {
    term: {
      panes: async (id, opts) => { calls.push(['panes', id, opts]); return panes(id); },
      teammate: async (id, paneId, opts) => { calls.push(['teammate', id, paneId, opts]); return mates(id, paneId); },
      breakPane: async (id, paneId, nid) => { calls.push(['breakPane', id, paneId, nid]); return { ok: true, error: null }; },
    },
  };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval: () => 0, document: { hidden: false } });
  ctx.window = ctx;
  ctx.window.flow = flow;
  /* term.js's title rule, as the page has it before teams.js runs */
  const termSrc = fs.readFileSync(path.join(ROOT, 'src/term.js'), 'utf8');
  const rule = termSrc.slice(termSrc.indexOf('  const SPIN'), termSrc.indexOf('\n  }\n', termSrc.indexOf('function nameFrom')) + 4);
  ctx.window.FlowTerm = { nameFrom: vm.runInNewContext(`${rule}; nameFrom`) };
  vm.runInContext(code, ctx, { filename: 'teams.js' });
  const ws = { id: 'ws', folder: '~/p', pan: 0, windows: [], closed: [] };
  const WIN = new Map();
  const titles = [];
  const added = [];
  let n = 0;
  const app = {
    WS: [ws], cur: 0, VW: 1000, VH: 800,
    locate: (id) => { const w = ws.windows.find((x) => x.id === id); return w ? { ws, w } : null; },
    save: () => {}, toast: (m) => calls.push(['toast', m]),
    addWindow: (s, w) => { s.windows.push(w); added.push(w); return w; },
    removeWindow: (s, w) => { s.windows.splice(s.windows.indexOf(w), 1); },
    apply: () => {}, sizeCanvas: () => {}, focusWin: () => {}, bringFront: () => {},
    besideSpot: () => ({ x: 50, y: 7, w: 46, h: 50 }), toSpace: () => ({ x: 20, y: 20 }), bottom: () => 98,
    geo: (w) => w, elOf: () => null, termTitle: (w) => w.title || w.id,
    splitTitle: (t) => { const m = /^([⠀-⣿✳])\s*/.exec(t || ''); return m ? { glyph: m[1], text: t.slice(m[0].length) } : { glyph: '', text: t || '' }; },
    renderTitle: () => {}, onTermTitle: (id, t) => titles.push([id, t]), scheduleSidebar: () => {}, renderSidebar: () => {},
    remoteOpts: (w) => (w.host ? { host: w.host, attach: w.attach || undefined } : undefined),
    newId: (p) => `${p}-${++n}`, tilde: (p) => p, setDragging: () => {}, rectHas: () => false,
    inSpace: () => true, WIN, els: { viewport: {} },
  };
  ctx.window.FlowTeams.mount(app);
  return { T: ctx.window.FlowTeams, ws, WIN, calls, titles, added };
}
const pane = (paneId, index, command, title = '') => ({ paneId, index, active: index === 0, left: 0, top: 0, width: 80, height: 24, command, cwd: '/home/x', title });

// 1. An attach team (the VM's ccm): two Claude teammate panes, never looked up and never moved; its lead's pane title
//    becomes the window title.
{
  const s = setup({ panes: () => [pane('%0', 0, 'claude', '✳ team flow lead'), pane('%5', 1, '2.1.296', '✳ alpha')], mates: () => ({ name: 'alpha', team: 't', sessionId: 'x' }) });
  s.ws.windows.push({ id: 'w-team', type: 'team', host: 'claude-agents', attach: 'ccm', where: 'on the VM' });
  s.T.pollPanes('w-team');
  await tick(); await tick();
  ok('attach team: no teammate lookup over ssh', !s.calls.some((c) => c[0] === 'teammate'), s.calls.map((c) => c[0]));
  ok('attach team: no pane moved out of ccm', !s.calls.some((c) => c[0] === 'breakPane'));
  ok('attach team: no window added', s.added.length === 0);
  ok('attach team: its title comes from the lead pane', s.titles.some(([id, t]) => id === 'w-team' && t === '✳ team flow lead'), s.titles);
  ok('attach team: polled with its host and attach', s.calls.some((c) => c[0] === 'panes' && c[2] && c[2].host === 'claude-agents' && c[2].attach === 'ccm'));
}

// 2. A team Flow made: a teammate pane moves to its own window beside the team, with its session id and teammate fields.
{
  const s = setup({ panes: () => [pane('%0', 0, 'claude'), pane('%1', 1, '2.1.296', '✳ foxtrot')], mates: (id, p) => (p === '%1' ? { name: 'foxtrot', team: 'session-1', color: 'blue', sessionId: 'ccd4fd84-0fd6-4256-9804-c0a725dd5bbc' } : null) });
  s.ws.windows.push({ id: 'w-lead', type: 'team', where: 'this Mac' });
  s.T.pollPanes('w-lead');
  await tick(); await tick();
  const w = s.added[0];
  ok('own team: the teammate pane is moved out', s.calls.some((c) => c[0] === 'breakPane' && c[2] === '%1'));
  ok('own team: its window carries the teammate and its session', !!w && w.title === 'foxtrot' && w.sessionId === 'ccd4fd84-0fd6-4256-9804-c0a725dd5bbc'
    && w.mate && w.mate.lead === 'w-lead' && w.mate.paneId === '%1', w);
  ok('own team: placed beside the team', !!w && w.x === 50 && w.y === 7);
  ok('own team: no toast for a move Flow made itself', !s.calls.some((c) => c[0] === 'toast'));
  ok('own team: a local team does not take titles from panes', s.titles.length === 0);
}

// 3. A pane checked before Claude Code started the teammate in it is checked again only once its command changes.
{
  let cmd = 'zsh';
  const s = setup({ panes: () => [pane('%0', 0, 'claude'), pane('%2', 1, cmd)], mates: () => (cmd === 'zsh' ? null : { name: 'golf', team: 't', sessionId: 'bc1ec636-0000-4000-8000-000000000000' }) });
  s.ws.windows.push({ id: 'w-lead', type: 'team' });
  s.T.pollPanes('w-lead'); await tick(); await tick();
  s.T.pollPanes('w-lead'); await tick(); await tick();
  const looks = () => s.calls.filter((c) => c[0] === 'teammate').length;
  ok('early pane: looked up once while its command stays the same', looks() === 1, looks());
  cmd = '2.1.296';
  s.T.pollPanes('w-lead'); await tick(); await tick();
  ok('early pane: looked up again once its command changed, then moved', looks() === 2 && s.calls.some((c) => c[0] === 'breakPane' && c[2] === '%2'), looks());
}

// 4. A teammate window whose session had to be made again says the team link ended; one that reattached does not.
{
  const s = setup({ panes: () => [], mates: () => null });
  const a = { id: 'w-a', type: 'term', title: 'hotel', sessionId: '44d74d73-0000-4000-8000-000000000000', mate: { name: 'hotel', lead: 'w-lead', paneId: '%1' } };
  const b = { id: 'w-b', type: 'term', title: 'india', sessionId: '0b9fac2d-0000-4000-8000-000000000000', mate: { name: 'india', lead: 'w-lead', paneId: '%3' } };
  const c = { id: 'w-c', type: 'term', title: 'juliet', mate: { name: 'juliet', lead: 'w-lead', paneId: '%4' } };
  s.ws.windows.push(a, b, c);
  s.T.onOpened('w-a', { ok: true, created: true });
  s.T.onOpened('w-b', { ok: true, created: false });
  s.T.onOpened('w-c', { ok: true, created: true });
  ok('restart: a recreated teammate says "team link ended"', s.T.label(a) === 'team link ended');
  ok('restart: a reattached teammate keeps its link', s.T.label(b) === '');
  ok('restart: a recreated teammate with no session id drops the teammate name', c.title === '' && s.T.label(c) === 'team link ended');
}

// 5. Where a new agent runs.
{
  const s = setup({ panes: () => [], mates: () => null });
  const vmws = s.T.runsOn({ host: 'claude-agents', hostFolder: '~/proj', folder: '~/x' });
  ok('runsOn: a VM workspace', vmws.host === 'claude-agents' && vmws.where === 'on the VM' && vmws.cwd === '~/proj', vmws);
  ok('runsOn: a VM workspace with no folder starts in the VM home', s.T.runsOn({ host: 'claude-agents', folder: '~/x' }).cwd === '~');
  const mac = s.T.runsOn({ folder: '~/x' });
  ok('runsOn: a Mac workspace', !mac.host && mac.cwd === '~/x', mac);
}

// 6. The workspace menu's folder and "runs on" rows: switching where a workspace runs, and a typed VM folder.
{
  const s = setup({ panes: () => [], mates: () => null });
  const ws = { id: 'w1', folder: '~/proj-mac' };
  let picked = 0;
  const mac = s.T.runsOnMenu(ws, () => { picked++; });
  ok('menu on a Mac workspace: the Mac folder with the picker, runs on this Mac', mac.folder === '~/proj-mac' && typeof mac.onFolder === 'function' && !mac.onFolderText && mac.runsOn === 'mac');
  mac.onFolder();
  ok('menu: the Mac folder row opens the picker', picked === 1);
  mac.onRunsOn('vm');
  ok('menu: "the VM" sets the workspace host to claude-agents', ws.host === 'claude-agents');
  const vm = s.T.runsOnMenu(ws, () => {});
  ok('menu on a VM workspace: a typed folder, the VM home by default, runs on the VM', vm.folder === '~' && typeof vm.onFolderText === 'function' && !vm.onFolder && vm.runsOn === 'vm');
  vm.onFolderText('~/proj');
  ok('menu: a typed VM folder is kept as typed', ws.hostFolder === '~/proj' && s.T.runsOn(ws).cwd === '~/proj');
  vm.onFolderText('');
  ok('menu: an emptied VM folder goes back to the VM home', !('hostFolder' in ws) && s.T.runsOn(ws).cwd === '~');
  s.T.runsOnMenu(ws, () => {}).onRunsOn('mac');
  ok('menu: "this Mac" clears the host, the Mac folder stays', !('host' in ws) && ws.folder === '~/proj-mac' && !s.T.runsOn(ws).host);
}

// 7. ps on a loaded machine can outlast pty.js's wait: a timed-out teammate lookup logs no error and the next poll looks
//    again; one that keeps timing out is reported once, after 20 in a row; any other failure is reported at once.
{
  const TIMED_OUT = "Error invoking remote method 'term:teammate': Error: sh ps -ww -o args= -p 4242; for c in $(pgrep -P 4242); do ps -ww -o args= -p \"$c\"; done: timed out";
  const logged = async (fn) => {
    const errors = [];
    const real = console.error;
    console.error = (...a) => errors.push(a.map((x) => (x && x.message) || String(x)).join(' '));
    try { await fn(); } finally { console.error = real; }
    return errors;
  };
  let slowFor = 2;
  const a = setup({ panes: () => [pane('%0', 0, 'claude'), pane('%3', 1, '2.1.296')],
    mates: () => { if (slowFor > 0) { slowFor--; throw new Error(TIMED_OUT); } return { name: 'hotel', team: 't', sessionId: 'a1e2c3d4-0000-4000-8000-000000000000' }; } });
  a.ws.windows.push({ id: 'w-slow', type: 'team' });
  const aErrors = await logged(async () => { for (let i = 0; i < 3; i++) { a.T.pollPanes('w-slow'); await tick(); await tick(); } });
  const aLooks = a.calls.filter((c) => c[0] === 'teammate').length;
  ok('slow ps: two timed-out lookups log nothing, the third poll moves the teammate', aErrors.length === 0 && aLooks === 3 && a.calls.some((c) => c[0] === 'breakPane' && c[2] === '%3'), { aErrors, aLooks });
  const b = setup({ panes: () => [pane('%0', 0, 'claude'), pane('%4', 1, '2.1.296')], mates: () => { throw new Error(TIMED_OUT); } });
  b.ws.windows.push({ id: 'w-stuck', type: 'team' });
  const bErrors = await logged(async () => { for (let i = 0; i < 25; i++) { b.T.pollPanes('w-stuck'); await tick(); await tick(); } });
  ok('slow ps: a lookup that times out 20 times in a row is reported once', bErrors.length === 1 && /timed out 20 times in a row/.test(bErrors[0]), bErrors);
  const c = setup({ panes: () => [pane('%0', 0, 'claude'), pane('%5', 1, '2.1.296')], mates: () => { throw new Error("Error invoking remote method 'term:teammate': Error: tmux display-message: can't find pane: %5"); } });
  c.ws.windows.push({ id: 'w-gone', type: 'team' });
  const cErrors = await logged(async () => { c.T.pollPanes('w-gone'); await tick(); await tick(); });
  ok('slow ps: any other lookup failure is still reported at once', cErrors.length === 1 && /can't find pane/.test(cErrors[0]), cErrors);
}

// 8. A pane title that is the CLI's own name or a prompt line names nothing; the lead's real title still does.
{
  const titled = (title) => setup({ panes: () => [{ ...pane('%0', 0, 'claude', title) }], mates: () => null });
  const seen = [];
  for (const t of ['Free Code', '✳ Claude Code', '❯', '❯ x', '✳ Fix the login page']) {
    const s = titled(t);
    s.ws.windows.push({ id: 'w-att', type: 'team', attach: 'ccm', host: 'vm' });
    s.T.pollPanes('w-att'); await tick(); await tick();
    seen.push([t, s.titles.map((x) => x[1])]);
  }
  ok('titles: the CLI\'s name and a prompt line name no window; a real title does', seen.slice(0, 4).every(([, got]) => got.length === 0) && seen[4][1].join() === '✳ Fix the login page', seen);
}

// 9. A sub-workspace with a folder of its own: a new agent starts there, on this Mac or on the VM; else the workspace's.
{
  const s = setup({ panes: () => [], mates: () => null });
  const mac = { id: 'm', folder: '~/proj' }, vm = { id: 'v', host: 'claude-agents', hostFolder: '~/vproj' };
  const got = [
    s.T.runsOn(mac, { folder: '~/proj/sub' }).cwd, s.T.runsOn(mac, {}).cwd, s.T.runsOn(mac, null).cwd,
    s.T.runsOn(vm, { hostFolder: '~/zproj' }).cwd, s.T.runsOn(vm, { folder: '~/mac-only' }).cwd, s.T.runsOn({ id: 'v2', host: 'claude-agents' }, null).cwd,
  ];
  ok('runsOn: a sub-workspace\'s own folder, else the workspace\'s, on this Mac and on the VM',
    got.join('|') === '~/proj/sub|~/proj|~/proj|~/zproj|~/vproj|~', got);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;




