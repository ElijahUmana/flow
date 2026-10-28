/* Checks src/sessions.js (list, search, running) on this machine's real ~/.claude, which it only reads.
   Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/sessions-test.js
   Prints ok/FAIL per check and exits non-zero on any failure. Uses /tmp/flow-dev-page-sessions for the index
   and the fakes, and its own tmux socket flow-dev-page-sessions. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src', 'sessions.js');
const CLAUDE = path.join(os.homedir(), '.claude');
const WORK = '/tmp/flow-dev-page-sessions';
const SOCKET = 'flow-dev-page-sessions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let failures = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`);
  if (!cond) failures++;
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = () => {
  delete require.cache[require.resolve(SRC)];
  return require(SRC);
};
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/* Transcripts and a few real messages of each kind to search for, read straight from the files. */
function sample() {
  const files = [];
  for (const d of fs.readdirSync(path.join(CLAUDE, 'projects'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const n of fs.readdirSync(path.join(CLAUDE, 'projects', d.name))) {
      if (/^[0-9a-f-]{36}\.jsonl$/i.test(n)) files.push(path.join(CLAUDE, 'projects', d.name, n));
    }
  }
  const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  const picks = { you: [], claude: [], summary: [] };
  /* Five consecutive plain words from the middle of the message that occur nowhere else in the transcript. */
  const phrase = (t, raw) => {
    const w = t.replace(/\s+/g, ' ').trim().split(' ');
    for (let at = Math.floor(w.length / 2) - 2; at + 5 <= w.length; at++) {
      const five = w.slice(at, at + 5);
      if (!five.every((x) => /^[A-Za-z][A-Za-z'-]{2,}$/.test(x))) continue;
      const q = five.join(' ');
      if (raw.split(q).length === 2) return q;
    }
    return '';
  };
  for (const f of files.sort()) {
    if (picks.you.length >= 4 && picks.claude.length >= 4 && picks.summary.length >= 2) break;
    const id = path.basename(f, '.jsonl');
    const raw = fs.readFileSync(f, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line || line.includes('"toolUseResult"')) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      const c = o.message && o.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
      const kind = o.isCompactSummary ? 'summary' : o.type === 'assistant' ? 'claude' : o.type === 'user' && !o.isMeta && !/^\s*</.test(text) ? 'you' : '';
      if (!kind || picks[kind].length >= (kind === 'summary' ? 2 : 4) || picks[kind].some((p) => p.id === id)) continue;
      const q = phrase(kind === 'summary' ? text.split('\n').slice(4).join(' ') : text, raw);
      if (q) picks[kind].push({ id, query: q });
    }
  }
  return { files, bytes, picks };
}

(async () => {
  // Fakes left by an earlier run that was stopped (they live under WORK, so this cannot touch anything else).
  spawnSync('pkill', ['-f', `${WORK}/fake/`]);
  spawnSync('tmux', ['-L', SOCKET, 'kill-server']);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const { files, bytes, picks } = sample();
  console.log(`     measured on ${CLAUDE}: ${files.length} transcripts, ${mb(bytes)}, history.jsonl ${mb(fs.statSync(path.join(CLAUDE, 'history.jsonl')).size)}`);

  /* ---------- list() ---------- */
  {
    const s = fresh();
    let t = Date.now();
    const all = await s.list();
    const first = Date.now() - t;
    t = Date.now();
    await s.list();
    const second = Date.now() - t;
    ok('list() first call answers in under 1.5 s and a cached call in under 250 ms', first < 1500 && second < 250, `${first} ms first, ${second} ms cached, ${all.length} sessions, load ${os.loadavg()[0].toFixed(0)}`);
    ok('list() entries carry the session id and cwd', all.length > 0 && all.every((x) => UUID.test(x.id) && typeof x.cwd === 'string'));
  }

  /* ---------- list() after a restart: from its cache file, re-reading only what changed ---------- */
  {
    const dir = path.join(WORK, 'listcache');
    let s1 = fresh();
    s1.setCacheDir(dir);
    const first = await s1.list();
    s1.stop();
    ok('list() keeps its cache in the cache folder, not in ~/.claude', fs.existsSync(path.join(dir, 'list.json')) && !fs.readdirSync(CLAUDE).some((n) => /^list\.json/.test(n)), `${mb(fs.statSync(path.join(dir, 'list.json')).size)}`);
    s1 = fresh();
    s1.setCacheDir(dir);
    const t = Date.now();
    const again = await s1.list();
    const ms = Date.now() - t;
    const ids = new Set(again.map((x) => x.id));
    ok('after a restart list() answers from its cache file in under 500 ms, with every session', ms < 500 && first.every((x) => ids.has(x.id)), `${ms} ms (${again.length} sessions; without the cache the first call above), load ${os.loadavg()[0].toFixed(0)}`);
    s1.stop();
  }

  /* ---------- has(id): whether a session can be forked, without the list ---------- */
  {
    const root = path.join(WORK, 'has');
    const proj = path.join(root, 'projects', '-tmp-has');
    fs.mkdirSync(proj, { recursive: true });
    const line = (text) => JSON.stringify({ type: 'user', cwd: '/tmp/has', timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n';
    const ids = { transcript: '33333333-3333-4333-8333-333333333333', promptOnly: '44444444-4444-4444-8444-444444444444', later: '66666666-6666-4666-8666-666666666666' };
    fs.writeFileSync(path.join(root, 'history.jsonl'), JSON.stringify({ display: 'a prompt with no transcript', timestamp: Date.now(), project: '/tmp/has', sessionId: ids.promptOnly }) + '\n');
    fs.writeFileSync(path.join(proj, `${ids.transcript}.jsonl`), line('hello'));
    const h = fresh();
    h.setClaudeDir(root);
    const before = await h.has(ids.transcript);
    const resumable = Object.fromEntries((await h.list()).map((x) => [x.id, x.resumable]));
    const answers = await Promise.all([ids.transcript, ids.promptOnly, '55555555-5555-4555-8555-555555555555', '../history', '', null].map((id) => h.has(id)));
    ok('has(id) is true only for a session with a transcript, the sessions list() marks resumable', before && answers.join() === 'true,false,false,false,false,false' && resumable[ids.transcript] === true && resumable[ids.promptOnly] === false, JSON.stringify({ before, answers, resumable }));
    fs.writeFileSync(path.join(proj, `${ids.later}.jsonl`), line('later'));
    ok('has(id) finds a transcript written after the last list()', await h.has(ids.later));
  }
  {
    const s = fresh();
    const known = [files[0], files[files.length - 1]].map((f) => path.basename(f, '.jsonl'));
    const time = async (id) => {
      const t = process.hrtime.bigint();
      const r = await s.has(id);
      return [r, Number(process.hrtime.bigint() - t) / 1e6];
    };
    const cold = [];
    for (const id of [...known, '55555555-5555-4555-8555-555555555555']) cold.push(await time(id));
    await s.list();
    const warm = [];
    for (const id of known) warm.push(await time(id));
    const dirs = fs.readdirSync(path.join(CLAUDE, 'projects')).length;
    ok(`has(id) answers in under 250 ms over this machine's ${dirs} project folders, and in under 20 ms for a session list() has seen`, cold.every(([r, ms], i) => r === (i < 2) && ms < 250) && warm.every(([r, ms]) => r && ms < 20), `before a list: ${cold.map(([r, ms]) => `${r} ${ms.toFixed(0)} ms`).join(', ')}; after: ${warm.map(([r, ms]) => `${r} ${ms.toFixed(1)} ms`).join(', ')}; load ${os.loadavg()[0].toFixed(0)}`);
  }

  /* ---------- the index: first build, then a restart ---------- */
  let s = fresh();
  s.setCacheDir(path.join(WORK, 'index'));
  {
    const t = Date.now();
    const r = await s.search('flow');
    const firstMs = Date.now() - t;
    ok('the very first search answers at once while the index is built', firstMs < 1500, `${firstMs} ms, building ${r.index.building}, ${r.index.indexed}/${r.index.sessions} transcripts indexed`);
    let st;
    const t2 = Date.now();
    const cpu0 = r.index.cpuMs;
    const during = [];
    for (;;) {
      const q0 = Date.now();
      st = await s.search('');
      if (!st.index.building && st.index.indexed === st.index.sessions && st.index.sessions > 0) break;
      if (during.length < 3 && st.index.indexed > 0) {
        const r = await s.search('session');
        during.push(`${Date.now() - q0} ms with ${st.index.indexed}/${st.index.sessions} indexed`);
        void r;
      }
      await sleep(250);
    }
    const buildMs = Date.now() - t2 + firstMs;
    const share = (st.index.cpuMs - cpu0) / (Date.now() - t2);
    ok('the first full build finishes', st.index.indexed === files.length, `${(buildMs / 1000).toFixed(1)} s for ${mb(bytes)} of transcripts (${(bytes / 1e6 / (buildMs / 1000)).toFixed(0)} MB/s), pack ${mb(st.index.bytes)} = ${(100 * st.index.bytes / bytes).toFixed(1)}% of the transcripts`);
    ok('the first build is gentle: its thread uses about a quarter of one core', share < 0.3, `${(100 * share).toFixed(0)}% of one core over ${((Date.now() - t2) / 1000).toFixed(1)} s (thread CPU from process.threadCpuUsage), load ${os.loadavg()[0].toFixed(0)}`);
    ok('searches answer while the first build runs', during.length > 0 && during.every((x) => Number(x.split(' ')[0]) < 1500), during.join('; '));
  }
  s.stop();
  s = fresh();
  s.setCacheDir(path.join(WORK, 'index'));
  {
    const t = Date.now();
    const r = await s.search('session');
    const ms = Date.now() - t;
    ok('after a restart the first search answers from the saved index in under 1.5 s', ms < 1500 && r.index.sessions > 0 && r.index.indexed === r.index.sessions, `${ms} ms, ${r.total} matches, ${r.index.indexed}/${r.index.sessions} indexed`);
    // A second copy of the module in this process (a test loading it fresh inside the running app) must not open a
    // second worker on the same pack: both would write it.
    const second = fresh();
    second.setCacheDir(path.join(WORK, 'index'));
    const refused = await second.search('session').then(() => '', (e) => e.message);
    ok('a second copy of sessions.js in the same process cannot open the same index folder', /already open in this process/.test(refused), refused);
    second.stop();
  }

  /* ---------- finding real sessions by what was said ---------- */
  for (const kind of ['you', 'claude', 'summary']) {
    for (const p of picks[kind]) {
      const t = Date.now();
      const r = await s.search(p.query);
      const ms = Date.now() - t;
      const at = r.results.findIndex((x) => x.id === p.id);
      const hit = at >= 0 ? r.results[at] : null;
      // The same words can be in other sessions too (team prompts are copied to every agent): only sessions with
      // the exact phrase (score 1000 and up) may rank above it.
      const fair = hit && hit.score >= 1000 && r.results.slice(0, at).every((x) => x.score >= 1000);
      ok(`a phrase from ${kind === 'you' ? 'your prompt' : kind === 'claude' ? "Claude's reply" : 'a compaction summary'} finds its session`, fair && hit.hits.some((h) => h.kind === kind && h.text.toLowerCase().includes(p.query.toLowerCase().split(' ')[0])), `"${p.query}" -> rank ${at + 1} of ${r.total} (${r.results.filter((x) => x.score >= 1000).length} with the exact phrase), ${ms} ms total, scan ${r.scanMs} ms, ${hit ? hit.id : 'missing'} ${hit ? JSON.stringify(hit.hits[0]).slice(0, 120) : ''}`);
    }
  }
  {
    const r = await s.search('the');
    ok('every result has the exact session id, its cwd and a resume command', r.results.length > 0 && r.results.every((x) => UUID.test(x.id) && typeof x.cwd === 'string' && x.resume.endsWith(`claude --resume ${x.id}`) && (!x.cwd || x.resume.startsWith('cd '))), `${r.results.length} results, e.g. ${r.results[0] && r.results[0].resume}`);
    const times = [];
    for (const q of ['the', 'a', 'error', 'tmux socket', 'claude code', 'zzqxv-not-a-word']) {
      const t = Date.now();
      const r2 = await s.search(q);
      times.push(`${q}: ${Date.now() - t} ms (scan ${r2.scanMs}, ${r2.total} matches)`);
    }
    ok('searches answer well under 3 s on this machine', times.every((x) => Number(x.split(': ')[1].split(' ')[0]) < 1000), times.join(', '));
    const one = (await s.list())[3];
    const byId = [];
    for (const q of [one.id.slice(0, 8), one.id.slice(0, 13), one.id]) {
      const r2 = await s.search(q);
      byId.push(r2.results[0] && r2.results[0].id === one.id && r2.results[0].hits[0].kind === 'id' && 'running' in r2.results[0]);
    }
    ok('search finds a session by its id or the start of it, first, with its running mark', byId.every(Boolean), `${one.id}: ${byId.join(', ')}`);
  }

  /* ---------- search time at the Mac's size: the same pack copied until it is that big ---------- */
  {
    const src = path.join(WORK, 'index');
    const big = path.join(WORK, 'big');
    fs.mkdirSync(big, { recursive: true });
    const meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8'));
    const packLen = meta.packBytes;
    const target = Number(process.env.BIG_PACK_MB || 800) * 1e6;
    const copies = Math.max(1, Math.ceil(target / packLen));
    for (const name of ['pack.txt', 'pack.lc', 'pack.tri']) {
      const data = fs.readFileSync(path.join(src, name));
      const fd = fs.openSync(path.join(big, name), 'w');
      for (let c = 0; c < copies; c++) fs.writeSync(fd, data);
      fs.closeSync(fd);
    }
    const files2 = {};
    const runs2 = [];
    const blocks2 = [];
    let next = 1;
    for (let c = 0; c < copies; c++) {
      const map = new Map();
      for (const [file, f] of Object.entries(meta.files)) {
        const no = next++;
        map.set(f.no, no);
        files2[`${file}#${c}`] = { ...f, no, id: c === 0 ? f.id : `${f.id.slice(0, 24)}${String(c).padStart(12, '0')}` };
      }
      for (const [off, no] of meta.runs) runs2.push([off + c * packLen, map.get(no) || 0]);
      for (const off of meta.blocks) blocks2.push(off + c * packLen);
    }
    const total = packLen * copies;
    fs.writeFileSync(path.join(big, 'meta.json'), JSON.stringify({ ...meta, packBytes: total, nextNo: next, files: files2, runs: runs2, blocks: blocks2 }));
    const { Worker } = require('worker_threads');
    const w = new Worker(path.join(__dirname, '..', 'src', 'sessions-index.js'), { workerData: { root: CLAUDE, cacheDir: big, frozen: true } });
    const askBig = (msg) => new Promise((res, rej) => {
      const id = Math.random();
      const on = (m) => { if (m.id !== id) return; w.off('message', on); if (m.error) rej(new Error(m.error)); else res(m.result); };
      w.on('message', on);
      w.postMessage({ ...msg, id });
    });
    const times = [];
    for (const q of ['the', 'error', 'tmux socket', picks.claude[0] ? picks.claude[0].query : 'session', 'zzqxv-not-a-word']) {
      const r = await askBig({ type: 'search', query: q, limit: 50 });
      times.push(`${q.slice(0, 24)}: ${r.scanMs} ms (read ${r.readMB} MB, search cpu ${r.cpuMs} ms)`);
    }
    await w.terminate();
    const worst = Math.max(...times.map((x) => Number(x.split(': ')[1].split(' ')[0])));
    ok(`a ${mb(total)} pack (what ${(total / (packLen / bytes) / 1e9).toFixed(0)} GB of transcripts make at this machine's ratio) is searched well under 3 s`, worst < 2000, times.join(', '));
    fs.rmSync(big, { recursive: true, force: true });
  }

  /* ---------- a session that ended a moment ago: ⌘K finds it without retyping ---------- */
  {
    const root = path.join(WORK, 'ended');
    const proj = path.join(root, 'projects', '-tmp-ended');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(root, 'history.jsonl'), '');
    const line = (role, text) => JSON.stringify({ type: role, cwd: '/tmp/ended', timestamp: new Date().toISOString(), message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } }) + '\n';
    fs.writeFileSync(path.join(proj, '11111111-1111-4111-8111-111111111111.jsonl'), line('user', 'alpha bravo') + line('assistant', 'alpha reply'));
    const e = fresh();
    e.setClaudeDir(root);
    e.setCacheDir(path.join(WORK, 'ended-index'));
    let r = await e.search('alpha');
    while (r.index.building) {
      await sleep(300);
      r = await e.search('alpha');
    }
    fs.writeFileSync(path.join(proj, '22222222-2222-4222-8222-222222222222.jsonl'), line('user', 'zulu yankee') + line('assistant', 'zulu done'));
    const t0 = Date.now();
    r = await e.search('zulu');
    const first = `${r.results.length} result(s), updating ${r.index.updating}`;
    // ⌘K (sidebar) asks again every 2 s while the answer says building or updating.
    while (!r.results.length && (r.index.building || r.index.updating) && Date.now() - t0 < 10000) {
      await sleep(2000);
      r = await e.search('zulu');
    }
    const ms = Date.now() - t0;
    ok('a session that ended right after a search shows up within a few seconds when ⌘K asks again while updating', r.results.length === 1 && r.results[0].id === '22222222-2222-4222-8222-222222222222' && ms < 6000, `${ms} ms; the first answer: ${first}`);
    ok('the answer that has it no longer says updating, so ⌘K stops asking', r.index.updating === false && r.index.building === false, JSON.stringify(r.index));
    e.stop();
  }

  /* ---------- running sessions (B1) ---------- */
  {
    const fake = path.join(WORK, 'fake');
    fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
    const script = path.join(fake, 'claude');
    fs.writeFileSync(script, 'setTimeout(() => {}, 120000);\n');
    const node = execFileSync('sh', ['-c', 'command -v node']).toString().trim();
    fs.symlinkSync(node, path.join(fake, 'bin', 'claude'));
    const ids = { args: '11111111-2222-4333-8444-555555555555', fork: '66666666-7777-4888-8999-aaaaaaaaaaaa', flow: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', regOld: 'cccccccc-1111-4222-8333-444444444444', regNow: 'dddddddd-1111-4222-8333-444444444444', stale: 'eeeeeeee-1111-4222-8333-444444444444', wrapped: '12121212-3434-4565-8787-909090909090', reused: 'abababab-1111-4222-8333-444444444444', half: 'cdcdcdcd-1111-4222-8333-444444444444' };
    const kids = [
      spawn(path.join(fake, 'bin', 'claude'), [script, '--session-id', ids.args]),
      spawn(node, [script, '--resume', ids.fork, '--fork-session']),
      spawn(node, [script, '--resume', ids.regOld]),
      spawn('sh', ['-c', `${node} ${script} --session-id ${ids.wrapped}; true`], { detached: true }),
      spawn(node, [script, '--session-id', ids.half]),
    ];
    execFileSync('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'flow_w-test', `${node} ${script} --session-id ${ids.flow}`]);
    const fakeRoot = path.join(WORK, 'claude-root');
    fs.mkdirSync(path.join(fakeRoot, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'sessions', `${kids[2].pid}.json`), JSON.stringify({ pid: kids[2].pid, sessionId: ids.regNow, cwd: '/tmp', status: 'busy', tmux: '' }));
    fs.writeFileSync(path.join(fakeRoot, 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: ids.stale, cwd: '/tmp', status: 'idle' }));
    // A file left by an earlier claude whose pid a newer claude now has: its procStart is not this process's.
    fs.writeFileSync(path.join(fakeRoot, 'sessions', `${kids[0].pid}.json`), JSON.stringify({ pid: kids[0].pid, sessionId: ids.reused, cwd: '/tmp', status: 'idle', procStart: '1', startedAt: 1 }));
    // A file caught half written.
    fs.writeFileSync(path.join(fakeRoot, 'sessions', `${kids[4].pid}.json`), `{"pid":${kids[4].pid},"sessionId":"${ids.half}","cwd":"/tm`);
    await sleep(700);
    const r = fresh();
    r.setClaudeDir(fakeRoot);
    r.setTmux({ tmux: 'tmux', socket: SOCKET });
    const live = await r.running();
    const by = (id) => live.filter((x) => x.id === id);
    ok('a claude process with --session-id <id> in its arguments is running', by(ids.args).length === 1 && by(ids.args)[0].pid === kids[0].pid && by(ids.args)[0].flowWindow === '', JSON.stringify(by(ids.args)));
    ok('--resume <id> --fork-session is a new session, so <id> is not running', by(ids.fork).length === 0);
    ok("Claude Code's registry wins over the arguments (after /resume or /clear)", by(ids.regNow).length === 1 && by(ids.regNow)[0].status === 'busy' && by(ids.regOld).length === 0, JSON.stringify(by(ids.regNow)));
    ok('a registry file whose process is gone is ignored', by(ids.stale).length === 0);
    ok('a registry file from an earlier process with the same pid (other procStart) is ignored', by(ids.reused).length === 0 && by(ids.args).length === 1, JSON.stringify(by(ids.reused)));
    ok('a half-written registry file does not throw; that claude counts by its --session-id', by(ids.half).length === 1 && by(ids.half)[0].pid === kids[4].pid, JSON.stringify(by(ids.half)));
    ok('a shell that has claude on its command line is not counted, only the claude it runs', by(ids.wrapped).length === 1 && by(ids.wrapped)[0].pid !== kids[3].pid, JSON.stringify(by(ids.wrapped)));
    ok('a claude in a flow_<window> tmux session on Flow\'s socket names that window', by(ids.flow).length === 1 && by(ids.flow)[0].tmux === 'flow_w-test' && by(ids.flow)[0].flowWindow === 'w-test', JSON.stringify(by(ids.flow)));
    execFileSync('tmux', ['-L', SOCKET, 'kill-server']);
    [0, 1, 2, 4].forEach((i) => kids[i].kill());
    process.kill(-kids[3].pid);

    const real = fresh();
    const onReal = await real.running();
    const reg = fs.readdirSync(path.join(CLAUDE, 'sessions')).filter((n) => /^\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(CLAUDE, 'sessions', n), 'utf8')));
    const alive = reg.filter((o) => { try { process.kill(o.pid, 0); return true; } catch (e) { return false; } });
    const missing = alive.filter((o) => !onReal.some((x) => x.pid === o.pid && x.id === o.sessionId));
    ok("on this VM every live claude in Claude Code's registry is reported running", alive.length > 0 && missing.length === 0, `${onReal.length} running, registry ${alive.length} alive of ${reg.length}${missing.length ? `, missing ${missing.map((o) => o.pid).join(' ')}` : ''}`);
    // On macOS the check is the start time instead of procStart: the process cannot have started after the
    // session it holds. It must hold for every live entry here too.
    const ps = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', alive.map((o) => o.pid).join(',')], { env: { ...process.env, LC_ALL: 'C' } }).toString();
    const late = alive.filter((o) => {
      const m = new RegExp(`^\\s*${o.pid}\\s+(.+)$`, 'm').exec(ps);
      return !m || !(Date.parse(m[1]) <= o.startedAt + 2000);
    });
    ok('every live registry entry here also passes the start-time check used on macOS', late.length === 0, `${alive.length - late.length}/${alive.length}${late.length ? `, fails for ${late.map((o) => o.pid).join(' ')}` : ''}`);
    const one = alive.find((o) => o.cwd && path.basename(o.cwd).length > 3);
    if (one) {
      const r = await s.search(path.basename(one.cwd));
      const hit = r.results.find((x) => x.id === one.sessionId);
      ok('search results mark a session that runs right now', hit && hit.running && hit.running.pid === one.pid, JSON.stringify(hit ? { id: hit.id, running: hit.running } : { looked: path.basename(one.cwd), results: r.results.length }));
    }
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log(`FAIL the run stopped: ${e.stack || e}`);
  process.exit(1);
});




