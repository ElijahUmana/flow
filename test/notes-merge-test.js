'use strict';
// src/notes-merge.js: page records from two copies of the state (a window's and another window's, or the store's)
// merge per page, newest change wins, deletions included and forgotten after 30 days; and src/store.js merges every
// save that way.
//   node test/notes-merge-test.js          FLOW_DIR=<tree> tests that tree's copy

const fs = require('fs');
const os = require('os');
const path = require('path');
const DIR = process.env.FLOW_DIR || path.join(__dirname, '..');
const { merge } = require(path.join(DIR, 'src', 'notes-merge.js'));
const { Store } = require(path.join(DIR, 'src', 'store.js'));

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra === undefined ? '' : `  ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
};
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 2, 3, 0, 0);
const rec = (note, at, more) => ({ url: 'https://example.com/a', title: 'A', about: '', note, at, ...more });
const A = 'https://example.com/a', B = 'https://example.com/b';

{
  const r = merge({ [A]: rec('mine', 20) }, { [A]: rec('theirs', 10) }, NOW);
  check('the copy changed last wins: mine', r.pages[A].note === 'mine' && r.ahead === true, r);
  const s = merge({ [A]: rec('mine', 10) }, { [A]: rec('theirs', 20) }, NOW);
  check('the copy changed last wins: theirs', s.pages[A].note === 'theirs' && s.ahead === false, s);
}
{
  const r = merge({ [A]: rec('mine', 10) }, { [A]: rec('theirs', 10) }, NOW);
  check('on a tie theirs wins, and mine is not ahead', r.pages[A].note === 'theirs' && r.ahead === false, r);
}
{
  const r = merge({ [A]: rec('only mine', 5) }, { [B]: rec('only theirs', 5) }, NOW);
  check('a page only one copy has is kept from either', r.pages[A].note === 'only mine' && r.pages[B].note === 'only theirs', r.pages);
  check('mine is ahead when it has a page theirs lacks', r.ahead === true);
  check('mine is not ahead when theirs has everything', merge({}, { [B]: rec('x', 5) }, NOW).ahead === false);
}
{
  const gone = { gone: true, at: NOW - 1000 };
  const r = merge({ [A]: rec('written before the deletion', NOW - 5000) }, { [A]: gone }, NOW);
  check('a deletion wins over an older copy', r.pages[A] && r.pages[A].gone === true && r.ahead === false, r);
  const s = merge({ [A]: gone }, { [A]: rec('written before the deletion', NOW - 5000) }, NOW);
  check('an older copy does not bring a deleted page back, and the deletion is sent on', s.pages[A].gone === true && s.ahead === true, s);
  const u = merge({ [A]: gone }, { [A]: rec('put back by undo', NOW - 10) }, NOW);
  check('a page put back after its deletion wins over the deletion', u.pages[A].note === 'put back by undo', u.pages[A]);
}
{
  const old = { gone: true, at: NOW - 31 * DAY }, recent = { gone: true, at: NOW - 29 * DAY };
  const r = merge({ [A]: old, [B]: recent }, {}, NOW);
  check('a deletion older than 30 days is forgotten, a newer one kept', !(A in r.pages) && r.pages[B] && r.pages[B].gone === true, r.pages);
  check('a forgotten deletion does not count as ahead', merge({ [A]: old }, {}, NOW).ahead === false);
  const s = merge({ [A]: old }, { [A]: rec('older than the deletion', NOW - 40 * DAY) }, NOW);
  check('a copy older than a forgotten deletion stays deleted', !(A in s.pages), s.pages);
}
{
  const mine = { [A]: rec('the owner wrote this later', 200, { title: 'old title', seen: 50 }) };
  const theirs = { [A]: rec('older note', 100, { title: 'new title', about: 'what it is', seen: 300 }) };
  const r = merge(mine, theirs, NOW);
  check('the owner\'s change comes from the copy changed last, the title from the copy that heard the page last',
    r.pages[A].note === 'the owner wrote this later' && r.pages[A].title === 'new title' && r.pages[A].about === 'what it is' && r.pages[A].at === 200 && r.pages[A].seen === 300, r.pages[A]);
  check('mine is ahead when theirs lacks its change', r.ahead === true);
  const s = merge({ [A]: rec('same', 100, { title: 'heard here', seen: 400 }) }, { [A]: rec('same', 100, { title: 'heard there', seen: 300 }) }, NOW);
  check('a title heard later is ahead even when the owner changed nothing', s.pages[A].title === 'heard here' && s.ahead === true, s);
  const t = merge({ [A]: rec('n', 200, { title: 'mine' }) }, { [A]: rec('n', 100, { title: 'theirs' }) }, NOW);
  check('without a newer page visit the title stays with the copy changed last', t.pages[A].title === 'mine', t.pages[A]);
  const g = merge({ [A]: { gone: true, at: NOW - 500 } }, { [A]: rec('n', NOW - 900, { title: 'visited', seen: NOW }) }, NOW);
  check('a page visit does not bring a deleted page back', g.pages[A].gone === true && !('title' in g.pages[A]), g.pages[A]);
}
{
  const mine = { [A]: rec('mine', 20), bad: null, arr: [1], str: 'x' };
  const theirs = { [B]: rec('theirs', 20), bad2: 7 };
  const before = JSON.stringify([mine, theirs]);
  const r = merge(mine, theirs, NOW);
  check('what is not a record is left out', Object.keys(r.pages).sort().join(' ') === [A, B].sort().join(' '), Object.keys(r.pages));
  check('neither copy is changed', JSON.stringify([mine, theirs]) === before);
  check('no copy at all gives no pages', Object.keys(merge(undefined, null, NOW).pages).length === 0 && Object.keys(merge([], 'x', NOW).pages).length === 0);
}
{
  // two windows and the store, the store keeping the merge of every save: whatever order the saves arrive in, every
  // copy ends with the newest of each page
  const w1 = { [A]: rec('w1 wrote', NOW - 30), [B]: rec('b', NOW - 50) };
  const w2 = { [A]: rec('a', NOW - 50), [B]: { gone: true, at: NOW - 20 } };
  for (const order of [[w1, w2], [w2, w1]]) {
    let store = {};
    for (const doc of order) store = merge(store, doc, NOW).pages;
    const one = merge(w1, store, NOW).pages, two = merge(w2, store, NOW).pages;
    const same = JSON.stringify(one) === JSON.stringify(store) && JSON.stringify(two) === JSON.stringify(store);
    check(`saves in either order end the same everywhere (${order[0] === w1 ? 'w1 first' : 'w2 first'})`,
      same && store[A].note === 'w1 wrote' && store[B].gone === true, store);
  }
}

(async () => {
  // the store: two windows save within one write (window 1 deletes B, window 2 writes in A), then a flush at quit
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-notes-merge-'));
  const disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'flow-state.json'), 'utf8')).pages;
  const sent = [];
  const store = new Store(dir, { broadcast: (doc, except) => sent.push({ doc, except }), onCorrupt: (b, e) => { throw e; } });
  const now = Date.now();
  const doc = (pages) => ({ v: 11, ws: [], ui: {}, pages });
  try {
    store.load();
    store.save(doc({ [A]: rec('base', now - 100), [B]: rec('b', now - 100) }), 1);
    await sleep(300);
    sent.length = 0;
    store.save(doc({ [A]: rec('base', now - 100), [B]: { gone: true, at: now - 10 } }), 1);
    store.save(doc({ [A]: rec('window 2 wrote', now - 5), [B]: rec('b', now - 100) }), 2);
    await sleep(300);
    check('the store keeps both changes saved within one write', disk()[A].note === 'window 2 wrote' && disk()[B].gone === true, disk());
    check('the window that saved last lacked the deletion, so it gets the result too', sent.length === 1 && sent[0].except === null && sent[0].doc.pages[B].gone === true, sent.map((x) => x.except));
    sent.length = 0;
    store.save(doc({ [A]: rec('window 2 wrote more', now), [B]: { gone: true, at: now - 10 } }), 2);
    await sleep(300);
    check('a window that had everything is not sent its own save back', sent.length === 1 && sent[0].except === 2, sent.map((x) => x.except));
    store.flush(doc({ [A]: rec('an older copy', now - 100) }), 1);
    check('a flush with an older copy keeps the newest', disk()[A].note === 'window 2 wrote more' && disk()[B].gone === true, disk());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();




