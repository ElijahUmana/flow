/* Checks that ⌘K searches made at the same time never fail, and that each sees history.jsonl as it was when it was
   made (STATUS item 68). The first search's open of history.jsonl is held (after its stat and checks), lines of a new
   session are appended, a second search asks for that session by its id, and the first open is let go 300 ms later;
   before the fix the first search read a negative length (RangeError).
   Works only on its own folders under /tmp/flow-dev-page-sessions-race. Run: node test/sessions-race-test.js */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'sessions.js');
const WORK = '/tmp/flow-dev-page-sessions-race';
fs.rmSync(WORK, { recursive: true, force: true });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const line = (id, i) => JSON.stringify({ display: `prompt ${i} of ${id}`, timestamp: 1790000000000 + i, project: '/tmp', sessionId: id }) + '\n';

let hist = '';
let held = null;
const realOpen = fs.promises.open;
fs.promises.open = async (p, ...rest) => {
  const fh = await realOpen.call(fs.promises, p, ...rest);
  if (p === hist && !held) {
    let go;
    held = new Promise((r) => { go = r; });
    held.go = go;
    await held;
  }
  return fh;
};
const sessions = require(SRC);

async function overlap(name, call) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(path.join(dir, 'claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  hist = path.join(dir, 'claude', 'history.jsonl');
  fs.writeFileSync(hist, Array.from({ length: 5 }, (_, i) => line(A, i)).join(''));
  sessions.setClaudeDir(path.join(dir, 'claude'));
  sessions.setCacheDir(path.join(dir, 'cache'));
  held = null;
  const settle = (p) => p.then((r) => ({ ok: r }), (e) => ({ error: String((e && e.message) || e) }));
  const first = settle(call());
  for (let i = 0; i < 50 && !held; i++) await new Promise((r) => setTimeout(r, 10));
  fs.appendFileSync(hist, line(B, 0) + line(B, 1) + line(A, 5));
  const second = settle(call());
  setTimeout(() => held.go(), 300);
  return Promise.all([first, second]);
}
const counts = (list) => {
  const a = list.find((s) => s.id === A), b = list.find((s) => s.id === B);
  return `A ${a ? a.count : 0}, B ${b ? b.count : 0}`;
};

(async () => {
  let failures = 0;
  const ok = (name, cond, detail) => {
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} (${detail})`);
    if (!cond) failures++;
  };
  let n = 0;
  const [s1, s2] = await overlap('search', () => sessions.search(n++ ? B.slice(0, 8) : A.slice(0, 8)));
  ok('two searches at once both answer', !s1.error && !s2.error, `${s1.error || 'ok'} | ${s2.error || 'ok'}`);
  ok('the one made after a new session was written finds it by its id', !!s2.ok && s2.ok.results.some((r) => r.id === B), s2.ok ? JSON.stringify(s2.ok.results.map((r) => r.id.slice(0, 8))) : s2.error);
  const after = counts(await sessions.list());
  ok('and every line of the history is counted once', after === 'A 6, B 2', after);
  sessions.stop();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();




