'use strict';
// src/store.js on quit: flushPending must write the newest state whether its debounced write is still waiting or already
// in flight, and temp files of writes a quit or crash cut short are removed when the state is loaded. A page window's
// tabs and shown tab are taken only from the window that shows it while that window is open (item 40).
//   node test/main-store-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v);
const live = new Set([1, 2]);
const make = (dir) => new Store(dir, { broadcast: () => {}, onCorrupt: (backup, e) => { throw e; }, alive: (id) => live.has(id) });
// one workspace with a page window (its tabs as a window last saw them) and a note
const docWith = (name, tabs, tab) => ({ v: 11, ws: [{ id: 'w', name, windows: [{ id: 'p1', type: 'page', x: 1, tabs, tab }, { id: 'n1', type: 'note', x: 2 }] }], ui: {} });
const pageOf = (doc) => doc.ws[0].windows.find((w) => w.id === 'p1');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-store-test-'));
  const file = path.join(dir, 'flow-state.json');
  const disk = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  try {
    const store = make(dir);
    store.load();
    // The debounce has fired and its write never finishes, as when the app quits in the middle of it.
    const realWrite = store.writeAsync;
    store.writeAsync = () => new Promise(() => {});
    store.save({ v: 11, ws: [{ id: 'in-flight' }], ui: {} }, 1);
    await sleep(300);
    store.flushPending();
    check('flushPending writes the newest state while its debounced write is still in flight', (disk() || { ws: [{}] }).ws[0].id === 'in-flight', JSON.stringify(disk()));
    store.writeAsync = realWrite;

    store.save({ v: 11, ws: [{ id: 'waiting' }], ui: {} }, 1);
    store.flushPending();
    check('flushPending writes a state still waiting for its debounce', (disk() || { ws: [{}] }).ws[0].id === 'waiting', JSON.stringify(disk()));

    const before = fs.statSync(file).mtimeMs;
    await sleep(30);
    store.flushPending();
    check('flushPending writes nothing when nothing is pending', fs.statSync(file).mtimeMs === before);

    store.setBounds({ x: 1, y: 2, width: 300, height: 200, maximized: false });
    store.flushPending();
    check('main\'s bounds are written next to the document and kept out of load()', disk().bounds.width === 300 && !('bounds' in make(dir).load()), JSON.stringify(disk()));

    // A temp file left by a write that was cut short, plus an unrelated file that must stay.
    const stale = path.join(dir, 'flow-state.json.4242.7.tmp');
    fs.writeFileSync(stale, '{"half":');
    const other = path.join(dir, 'flow-state.corrupt-1.json');
    fs.writeFileSync(other, 'kept');
    const reloaded = make(dir).load();
    check('loading removes temp files of cut-short writes and keeps the state', !fs.existsSync(stale) && fs.existsSync(other) && reloaded.ws[0].id === 'waiting');

    // item 40: window 1 shows page p1; window 2 (a pop-out) sends its older copy of it
    const own = make(fs.mkdtempSync(path.join(dir, 'own-')));
    own.load();
    const fresh = [{ id: 't1', url: 'https://a.test/', history: { index: 0, entries: [{ url: 'https://a.test/', pageState: 'scrolled' }] } }];
    const old = [{ id: 't1', url: 'https://a.test/', history: { index: 0, entries: [{ url: 'https://a.test/', pageState: 'top' }] } }];
    own.save(docWith('one', fresh, 0), 1, ['p1']);
    own.save(docWith('renamed by two', old, 0), 2, []);
    check('another window\'s copy of a shown page\'s tabs does not replace them; the rest of its save applies',
      pageOf(own.load()).tabs[0].history.entries[0].pageState === 'scrolled' && own.load().ws[0].name === 'renamed by two', JSON.stringify(pageOf(own.load())));
    own.flush(docWith('one', old, 0), 2, null);
    check('the same through flush, and from a sender that names no pages', JSON.parse(fs.readFileSync(own.file, 'utf8')).ws[0].windows[0].tabs[0].history.entries[0].pageState === 'scrolled');
    const second = [...fresh, { id: 't2', url: 'https://b.test/' }];
    own.save(docWith('one', second, 1), 1, ['p1']);
    check('the window that shows the page still changes them (a new tab, shown)', pageOf(own.load()).tabs.length === 2 && pageOf(own.load()).tab === 1);
    own.save(docWith('one', old, 0), 1, []);
    own.save(docWith('one', second, 1), 2, []);
    check('a window that no longer lists a page gives it up: the next save of it is taken', pageOf(own.load()).tabs.length === 2 && pageOf(own.load()).tab === 1, JSON.stringify(pageOf(own.load())));
    const sent = [];
    const told = new Store(fs.mkdtempSync(path.join(dir, 'told-')), { broadcast: (doc, except) => sent.push(except), onCorrupt: (backup, e) => { throw e; }, alive: (id) => live.has(id) });
    told.load();
    told.save(docWith('one', fresh, 0), 1, ['p1']);
    told.flushPending();
    told.save(docWith('one', old, 0), 2, []);
    told.flushPending();
    told.save(docWith('one', fresh, 0), 2, []);
    told.flushPending();
    check('a window whose copy of a shown page was older is sent the result too; one whose copy matched is not', JSON.stringify(sent) === JSON.stringify([1, null, 2]), JSON.stringify(sent));
    // two open windows both load p1 (a whole-workspace pop-out and one of its sub-workspaces): the first keeps it
    const both = make(fs.mkdtempSync(path.join(dir, 'both-')));
    both.load();
    both.save(docWith('one', fresh, 0), 1, ['p1']);
    both.save(docWith('one', old, 0), 2, ['p1']);
    const firstKept = pageOf(both.load()).tabs[0].history.entries[0].pageState === 'scrolled';
    both.save(docWith('one', fresh, 0), 1, []);
    both.save(docWith('one', old, 0), 2, ['p1']);
    check('when two open windows list a page the first keeps it, and the other takes it once the first lets go',
      firstKept && pageOf(both.load()).tabs[0].history.entries[0].pageState === 'top', JSON.stringify(pageOf(both.load())));

    // a quit: owners stay as they are while the windows close in any order
    const q = make(fs.mkdtempSync(path.join(dir, 'quit-')));
    q.load();
    live.add(3);
    q.save(docWith('one', fresh, 0), 1, ['p1']);
    q.freezeOwners();
    live.delete(1);
    q.flush(docWith('one', old, 0), 2, []);
    const keptWhileGone = pageOf(q.load()).tabs[0].history.entries[0].pageState === 'scrolled';
    q.flush(docWith('one', old, 0), 3, ['p1']);
    const noNewOwner = pageOf(q.load()).tabs[0].history.entries[0].pageState === 'scrolled';
    q.flush(docWith('one', second, 1), 1, ['p1']);
    check('during a quit a page keeps its owner\'s tabs though that window is gone, no other window takes it, and the owner\'s own last flush applies',
      keptWhileGone && noNewOwner && pageOf(JSON.parse(fs.readFileSync(q.file, 'utf8'))).tab === 1, JSON.stringify({ keptWhileGone, noNewOwner }));
    live.add(1);

    own.save(docWith('one', fresh, 0), 1, ['p1']);
    live.delete(1);
    own.save(docWith('one', old, 0), 2, []);
    check('once that window is gone its pages are taken from the others', pageOf(own.load()).tabs[0].history.entries[0].pageState === 'top');
    live.add(1);

    // item 45: which workspace the main window shows, and its sidebar state, come from the main window only
    const at = new Store(fs.mkdtempSync(path.join(dir, 'at-')), { broadcast: () => {}, onCorrupt: (backup, e) => { throw e; }, alive: (id) => live.has(id), isMain: (id) => id === 1 });
    at.load();
    const withUi = (ui) => ({ ...docWith('one', fresh, 0), ui });
    at.save(withUi({ at: 'infra', sbHidden: true, closed: ['a'] }), 1, ['p1']);
    at.save(withUi({ at: 'mynotes', sbHidden: false, closed: ['b'] }), 2, []);
    const fromPop = at.load().ui;
    at.flush(withUi({ at: 'flow', sbHidden: false, closed: ['b'] }), 1, ['p1']);
    check('a pop-out\'s save keeps the main window\'s ui.at and ui.sbHidden and takes the rest of its ui; the main window\'s own save sets them',
      fromPop.at === 'infra' && fromPop.sbHidden === true && j(fromPop.closed) === j(['b']) && JSON.parse(fs.readFileSync(at.file, 'utf8')).ui.at === 'flow', j(fromPop));
    at.save({ v: 11, ws: [], pages: {} }, 2, []);
    check('a pop-out\'s save with no ui at all keeps the stored one', j(at.load().ui) === j({ at: 'flow', sbHidden: false, closed: ['b'] }), j(at.load().ui));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(2);
});




