// sidebar's check that ⌘K results catch up while the session index is still being built (notes' report): starts the
// dev app on a fresh userData (so the index starts empty), makes its own session in a folder whose name is the search
// word (claude -p "/cost": local, no tokens), types the word once, and waits without typing again for its row.
//   node test/sidebar-index.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { connectTo, evaluate, size, sleep, click, key, type, reporter } from './ui-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const R = reporter();
const sh = (cmd, args, o) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o });
sh('test/sidebar-dev.sh', ['stop']);
sh('test/sidebar-dev.sh', ['start', '--fresh']);
try {
  const word = `sbidx${crypto.randomBytes(4).toString('hex')}`;
  const cwd = `/tmp/flow-dev-sidebar/idx/${word}`;
  fs.mkdirSync(cwd, { recursive: true });
  const id = crypto.randomUUID();
  sh('claude', ['-p', '/cost', '--session-id', id], { cwd, timeout: 90000 });
  const page = await connectTo(9574, /\/src\/index\.html$/);
  await size(page, 1500, 913);
  for (let i = 0; i < 60 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
  await evaluate(page, 'window.__flow.ready');
  const qr = await evaluate(page, `(() => { const b = document.getElementById('q').getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; })()`);
  await click(page, qr.x, qr.y);
  await type(page, word);
  const t0 = Date.now();
  /* whether the index is still being made, as the search itself reports it; asked without holding the page, since a
     search can take a while under load */
  const indexState = async () => {
    await evaluate(page, `(() => { window.__idx = null; flow.sessions.search(${JSON.stringify(word)}, { limit: 1 }).then((r) => { window.__idx = { building: !!(r && r.index && r.index.building) }; }, (e) => { window.__idx = { error: String(e) }; }); return true; })()`);
    for (let i = 0; i < 240 && !(await evaluate(page, '!!window.__idx')); i++) await sleep(250);
    return evaluate(page, 'window.__idx');
  };
  const sawBuilding = ((await indexState()) || {}).building === true;
  let row = null, status = [];
  while (Date.now() - t0 < 240000) {
    const s = await evaluate(page, `(() => { const r = document.querySelector('#sblist .srow[data-sess="${id}"]'); const e = [...document.querySelectorAll('#sblist .empty, #sblist .sec')].map((x) => x.textContent).join(' | '); return { row: !!r, notes: e }; })()`);
    if (/index/i.test(s.notes)) status.push(s.notes);
    if (s.row) { row = s; break; }
    await sleep(1000);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  R.ok('the index was still being built when the word was typed (the case this suite is for)', sawBuilding === true, { secs });
  R.ok('typed once, the session\'s row shows up by itself', !!row, { sawBuilding, secs, row });
  /* the index finishes by itself (the next case is a session that ends once it is made); ⌘K is read all along */
  let building = true;
  while (building && Date.now() - t0 < 300000) {
    await sleep(2000);
    const notes = await evaluate(page, `[...document.querySelectorAll('#sblist .empty, #sblist .sec')].map((x) => x.textContent).join(' | ')`);
    if (/index/i.test(notes)) status.push(notes);
    building = ((await indexState()) || {}).building !== false;
  }
  R.ok('while the index is made, ⌘K says nothing about indexing: the results fill in by themselves', status.length === 0 && !building, { building, status: status.slice(0, 3), secs: Math.round((Date.now() - t0) / 1000) });
  /* a session that ends right after a search shows up too, without typing again (page: index.updating) */
  const word2 = `sbidx${crypto.randomBytes(4).toString('hex')}`;
  const cwd2 = `/tmp/flow-dev-sidebar/idx/${word2}`;
  fs.mkdirSync(cwd2, { recursive: true });
  const id2 = crypto.randomUUID();
  sh('claude', ['-p', '/cost', '--session-id', id2], { cwd: cwd2, timeout: 90000 });
  await click(page, qr.x, qr.y);
  await key(page, 'a', 2);
  await type(page, word2);
  const t1 = Date.now();
  let seen = false;
  while (!seen && Date.now() - t1 < 20000) {
    seen = await evaluate(page, `!!document.querySelector('#sblist .srow[data-sess="${id2}"]')`);
    if (!seen) await sleep(500);
  }
  R.ok('a session that just ended shows up after one search, without typing again', seen, { secs: Math.round((Date.now() - t1) / 1000) });
  R.ok('no console errors', page.errors.length === 0, page.errors.slice(0, 4));
  page.ws.close();
} finally {
  sh('test/sidebar-dev.sh', ['stop']);
}
R.summary();




