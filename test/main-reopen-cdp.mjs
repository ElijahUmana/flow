// Opening a conversation again right after its agent was ended (flows' walks: ⌘K refused with "already running in
// process ...", an undo opened nothing). A claude still writes to its conversation after its tmux session is killed (a
// cost-state line about 2 s later) and exits seconds later, so the conversation must not run twice meanwhile, and
// opening it must not be refused or kept waiting: running() (what both reopen guards ask) leaves out a claude Flow has
// just ended, and a terminal opened on that conversation at once starts its claude when the old one has exited. In the
// real app, on two claudes this test made in trusted folders of its own (nothing is typed):
//   - both are up (Claude Code registered them) and running() names their windows;
//   - right after the first is ended, running() answers at once without it, its claude still exiting, and still names
//     the second;
//   - a new window resuming the first conversation, opened at that moment, gets its terminal once the old claude has
//     exited, and the new claude then runs there; sampled every 50 ms meanwhile, two claudes never held it at once.
//   node test/main-reopen-cdp.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as L from './main-cdp-lib.mjs';

const require = createRequire(import.meta.url);
const { ownSession, TRUSTED_ROOT } = require('./main-own-session.js');
const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-reopen-${Date.now()}.log`);
const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude');

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const j = (v) => JSON.stringify(v);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};
function cleanup() {
  for (const pid of L.electronPids()) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
  try {
    L.tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr || e.message))) throw e;
  }
}
const term = (id, sessionId, cwd, x) => ({ id, type: 'term', title: id, cmd: 'claude', sessionId, resume: true, cwd, where: 'this Mac', x, y: 6.6, w: 40, h: 40 });

async function run() {
  cleanup();
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'no Flow process');
  const a = ownSession(CLAUDE, 'reopen', TRUSTED_ROOT);
  const b = ownSession(CLAUDE, 'reopen-other', TRUSTED_ROOT);
  console.log(`sessions this test made: ${a.id} (${a.cwd}), ${b.id} (${b.cwd})`);
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), j({ v: 11, ws: [{ id: 'ro', name: 'ro', folder: a.cwd, bg: '#141319', zones: [], notes: [], saved: [],
    windows: [term('w-ra', a.id, a.cwd, 1), term('w-rb', b.id, b.cwd, 45)], closed: [] }], ui: {} }));
  console.log(`app log: ${LOG}`);
  L.launch(LOG);
  const page = await L.flowPage();
  const runningOf = async (id) => (await page.eval('return await window.flow.sessions.running();')).find((r) => r.id === id) || null;
  // up when Claude Code has registered the session itself (~/.claude/sessions/<pid>.json, which running() reads: its cwd)
  const up = (id, win) => L.waitFor(async () => { const r = await runningOf(id); return r && r.flowWindow === win && r.cwd ? r : null; }, 90000, `the claude in ${win} to be up`);
  const ra = await up(a.id, 'w-ra');
  const rb = await up(b.id, 'w-rb');
  check('both claudes are up, and running() names their windows', !!ra && !!rb, j({ ra, rb }));

  // the claudes holding a conversation, from ps (a claude's own registry entry is gone once it starts to exit)
  const seen = [];
  const holders = (id) => {
    const ls = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,stat=,args='], { encoding: 'utf8' }).split('\n')
      .filter((l) => /claude/.test(l) && new RegExp(`(--resume|--session-id)[ =]${id}(\\s|$)`).test(l) && !/zsh/.test(l));
    if (ls.length > 1) seen.push({ t: Date.now(), ls: ls.map((l) => l.trim().slice(0, 160)) });
    return ls.length;
  };
  let most = 0;
  let sampling = true;
  const sampler = (async () => { while (sampling) { most = Math.max(most, holders(a.id)); await L.sleep(50); } })();

  const t0 = Date.now();
  await page.eval("await window.flow.term.kill('w-ra'); return true;");
  const killedMs = Date.now() - t0;
  const asked = await page.eval('const t = Date.now(); const live = await window.flow.sessions.running(); return { live, ms: Date.now() - t };');
  const exiting = alive(ra.pid);
  check('right after the first is ended, running() answers at once without it while its claude is still exiting, and names the second',
    exiting && asked.ms < 1500 && !asked.live.some((r) => r.id === a.id) && asked.live.some((r) => r.id === b.id && r.flowWindow === 'w-rb'),
    `kill ${killedMs} ms, running() ${asked.ms} ms, the ended claude ${exiting ? 'still exiting' : 'already gone'}`);

  const t1 = Date.now();
  const reopened = await page.eval(`const o = await window.flow.term.open({ id: 'w-ra2', cmd: 'claude', sessionId: ${j(a.id)}, resume: true, cwd: ${j(a.cwd)}, cols: 100, rows: 30 });
    return { ok: o.ok, created: o.created, error: o.error || '' };`);
  const openMs = Date.now() - t1;
  const goneAtOpen = !alive(ra.pid);
  const ra2 = await L.waitFor(async () => { const r = await runningOf(a.id); return r && r.flowWindow === 'w-ra2' ? r : null; }, 60000, 'the conversation to run again').catch(() => null);
  sampling = false;
  await sampler;
  check('a terminal opened on it at once gets its claude after the old one has exited, and the new claude runs there',
    reopened.ok && reopened.created && goneAtOpen && !!ra2 && ra2.pid !== ra.pid, `open took ${openMs} ms; ${j({ reopened, ra2 })}`);
  check('two claudes never held the conversation at once (ps every 50 ms)', most === 1, `most at once: ${most} ${JSON.stringify(seen.slice(0, 4))}`);
  page.close();
}

try {
  await run();
} catch (e) {
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  cleanup();
  // the killed app's helper processes can still write into its folder for a moment
  await L.waitFor(() => L.electronPids().length === 0, 10000, 'the app to be gone').catch((e) => { console.log(`FAIL ${e.message}`); failed++; });
  fs.rmSync(L.USER_DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




