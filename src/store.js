'use strict';
// The app state: one JSON document in userData/flow-state.json, written atomically (tmp + rename).
// The renderer owns the document; main adds keys of its own, `bounds` (the main window frame), `popouts` (the open
// pop-out windows, { hash, bounds }) and `permissions` (the user's answers to pages, "<origin> <permission>": boolean),
// which it keeps out of what loadState returns.

const fs = require('fs');
const path = require('path');
const { merge: mergePages } = require('./notes-merge');

const DEBOUNCE_MS = 150;
const MISSING = Symbol('missing');
const clone = (value) => value === MISSING ? MISSING : JSON.parse(JSON.stringify(value));
const same = (a, b) => a === MISSING || b === MISSING ? a === b : JSON.stringify(a) === JSON.stringify(b);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keyed = (...lists) => lists.every((list) => Array.isArray(list) && list.every((item) => record(item) && item.id != null));
function mergeValue(base, incoming, current) {
  if (same(incoming, base)) return clone(current);
  if (same(current, base) || same(incoming, current)) return clone(incoming);
  if (incoming === MISSING) return same(current, base) ? MISSING : clone(current);
  if (current === MISSING) return same(incoming, base) ? MISSING : clone(incoming);
  if (base === MISSING && record(incoming) && record(current)) base = {};
  if (record(base) && record(incoming) && record(current)) {
    const out = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(incoming), ...Object.keys(current)])) {
      const value = mergeValue(key in base ? base[key] : MISSING, key in incoming ? incoming[key] : MISSING,
        key in current ? current[key] : MISSING);
      if (value !== MISSING) out[key] = value;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(incoming) && Array.isArray(current) && keyed(base, incoming, current)) {
    const maps = [base, incoming, current].map((list) => new Map(list.map((item) => [String(item.id), item])));
    const idsOf = (list) => list.map((item) => String(item.id));
    const order = same(idsOf(incoming), idsOf(base)) ? idsOf(current) : idsOf(incoming);
    const ids = [...order, ...idsOf(current), ...idsOf(incoming)].filter((id, i, list) => list.indexOf(id) === i);
    const out = [];
    for (const id of ids) {
      const value = mergeValue(maps[0].has(id) ? maps[0].get(id) : MISSING, maps[1].has(id) ? maps[1].get(id) : MISSING,
        maps[2].has(id) ? maps[2].get(id) : MISSING);
      if (value !== MISSING) out.push(value);
    }
    return out;
  }
  return clone(incoming);
}
const VIEW_KEYS = ['at', 'pan', 'panY', 'zoom', 'mainPan', 'mainPanY', 'mainZoom', 'popView'];
const stableWorkspace = (workspace) => {
  if (!workspace) return null;
  const copy = clone(workspace);
  for (const key of VIEW_KEYS) delete copy[key];
  for (const zone of copy.zones || []) for (const key of VIEW_KEYS) delete zone[key];
  for (const w of [...(copy.windows || []), ...(copy.closed || [])]) delete w.osc;
  return copy;
};

class Store {
  constructor(dir, { broadcast, onCorrupt, alive, isMain, workspaceOf }) {
    this.file = path.join(dir, 'flow-state.json');
    this.broadcast = broadcast;
    this.onCorrupt = onCorrupt;
    this.alive = alive;
    this.isMain = isMain;
    this.workspaceOf = workspaceOf;
    this.claims = new Map();
    this.owners = new Map();
    this.frozen = false;
    this.loaded = false;
    this.doc = null;
    this.bounds = null;
    this.popouts = [];
    this.permissions = {};
    this.timer = null;
    this.pendingBroadcast = false;
    this.lastSender = null;
    this.senderBehind = false;
    this.seq = 0;
    this.committed = 0;
    this.chain = Promise.resolve();
    this.revisions = new Map();
    this.senderDocs = new Map();   // webContents id -> the document that window last loaded or saved
  }

  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const dir = path.dirname(this.file);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of names) if (/^flow-state\.json\.\d+\.\d+\.tmp$/.test(name)) fs.unlinkSync(path.join(dir, name));
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (text == null) return;
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      const backup = path.join(path.dirname(this.file), `flow-state.corrupt-${Date.now()}.json`);
      fs.renameSync(this.file, backup);
      console.error(`[flow] ${this.file} is not valid JSON (${e.message}); moved it to ${backup}`);
      this.onCorrupt(backup, e);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const { bounds, popouts, permissions, ...doc } = parsed;
    this.permissions = permissions && typeof permissions === 'object' && !Array.isArray(permissions) ? permissions : {};
    this.bounds = bounds && typeof bounds === 'object' ? bounds : null;
    this.popouts = Array.isArray(popouts) ? popouts.filter((p) => p && typeof p.hash === 'string' && p.bounds && typeof p.bounds === 'object') : [];
    this.doc = Object.keys(doc).length ? doc : null;
  }

  load(senderId) {
    this.ensureLoaded();
    if (senderId != null) this.senderDocs.set(senderId, clone(this.doc));
    return this.doc;
  }
  forget(senderId) { this.senderDocs.delete(senderId); }
  getBounds() { this.ensureLoaded(); return this.bounds; }
  getPopouts() { this.ensureLoaded(); return this.popouts; }
  setPopouts(list, now) { this.ensureLoaded(); this.popouts = list; if (now) this.writeNowSync(); else this.schedule(); }
  getPermissions() { this.ensureLoaded(); return this.permissions; }
  setPermissions(permissions) { this.ensureLoaded(); this.permissions = permissions; this.schedule(); }
  setBounds(bounds) { this.ensureLoaded(); this.bounds = bounds; this.schedule(); }

  accept(next, senderId, now) {
    const previous = this.doc, revisions = new Map(this.revisions);
    const stable = (doc) => new Map((doc && Array.isArray(doc.ws) ? doc.ws : []).filter((ws) => ws && ws.id != null)
      .map((ws) => [String(ws.id), JSON.stringify(stableWorkspace(ws))]));
    const before = stable(previous), after = stable(next);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) !== after.get(id)) this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
    }
    this.doc = next;
    this.lastSender = senderId;
    this.pendingBroadcast = true;
    const senderDoc = this.senderDocs.get(senderId);
    if (senderId != null) this.senderDocs.set(senderId, clone(next));
    try {
      if (now) this.writeNowSync();
      else this.schedule();
    } catch (error) {
      this.doc = previous;
      this.revisions = revisions;
      if (senderDoc === undefined) this.senderDocs.delete(senderId); else this.senderDocs.set(senderId, senderDoc);
      this.pendingBroadcast = false;
      throw error;
    }
    return clone(this.doc);
  }

  // How many accepted saves changed this workspace's model (not its views): equal content reached through a change and
  // its reversal still counts, so a close can tell that another window touched the workspace while it was deciding.
  revision(id) { this.ensureLoaded(); return this.revisions.get(String(id)) || 0; }

  save(obj, senderId, pages, base) {
    this.ensureLoaded();
    return this.accept(this.merge(obj, senderId, pages, base), senderId, false);
  }

  flush(obj, senderId, pages, base) {
    this.ensureLoaded();
    return this.accept(this.merge(obj, senderId, pages, base), senderId, true);
  }

  closeWorkspace(obj, senderId, pages, base, targetId, expected, revision) {
    this.ensureLoaded();
    this.flushPending();
    const current = this.doc && Array.isArray(this.doc.ws) ? this.doc.ws.find((ws) => ws && String(ws.id) === String(targetId)) : null;
    if (!current || this.revision(targetId) !== revision || JSON.stringify(stableWorkspace(current)) !== JSON.stringify(expected)) return { ok: false, doc: clone(this.doc) };
    return { ok: true, doc: this.accept(this.merge(obj, senderId, pages, base), senderId, true) };
  }

  merge(obj, senderId, pages, baseDoc) {
    this.senderBehind = false;
    const current = this.doc;
    const known = this.senderDocs.has(senderId) ? this.senderDocs.get(senderId) : current;
    const base = baseDoc && typeof baseDoc === 'object' ? clone(baseDoc) : clone(known);
    let incoming = clone(obj);
    if (Array.isArray(pages) && !this.frozen) this.claims.set(senderId, new Set(pages.map(String)));
    if (incoming && typeof incoming === 'object' && current && ('pages' in incoming || 'pages' in current)) {
      const r = mergePages(current.pages, incoming.pages);
      incoming.pages = r.pages;
      if (r.ahead) this.senderBehind = true;
    }
    const main = !this.isMain || this.isMain(senderId);
    if (!main && incoming && Array.isArray(incoming.ws) && current && Array.isArray(current.ws)) {
      const ownedSpace = this.workspaceOf ? this.workspaceOf(senderId) : null;
      const owned = ownedSpace && typeof ownedSpace === 'object' ? ownedSpace.ws : ownedSpace;
      const incomingById = new Map(incoming.ws.filter((ws) => ws && ws.id != null).map((ws) => [String(ws.id), ws]));
      const baseById = new Map((base && Array.isArray(base.ws) ? base.ws : []).filter((ws) => ws && ws.id != null).map((ws) => [String(ws.id), ws]));
      incoming.ws = current.ws.map((ws) => owned != null && String(ws.id) === String(owned) && incomingById.has(String(ws.id))
        ? incomingById.get(String(ws.id)) : baseById.get(String(ws.id)) || ws);
      const baseUi = base && record(base.ui) ? base.ui : {};
      incoming.ui = record(incoming.ui) ? { ...incoming.ui } : clone(baseUi);
      for (const key of ['at', 'sbHidden', 'workspaceUndos']) {
        if (key in baseUi) incoming.ui[key] = baseUi[key];
        else delete incoming.ui[key];
      }
    }
    let next = base && current ? mergeValue(base, incoming, current) : incoming;
    if (!next || !Array.isArray(next.ws) || !current || !Array.isArray(current.ws)) return next;
    const byId = new Map(next.ws.filter((ws) => ws && ws.id != null).map((ws) => [String(ws.id), ws]));
    const order = main && incoming && Array.isArray(incoming.ws) ? incoming.ws : current.ws;
    next.ws = order.map((ws) => byId.get(String(ws.id)) || clone(ws));
    if (main && incoming && record(incoming.ui)) {
      next.ui = record(next.ui) ? next.ui : {};
      for (const key of ['at', 'sbHidden', 'workspaceUndos']) {
        if (key in incoming.ui) next.ui[key] = clone(incoming.ui[key]);
        else delete next.ui[key];
      }
    }
    const last = new Map(), sent = new Map();
    for (const ws of current.ws) for (const w of (ws && Array.isArray(ws.windows) ? ws.windows : [])) if (w && w.type === 'page') last.set(w.id, w);
    for (const ws of (incoming && Array.isArray(incoming.ws) ? incoming.ws : [])) for (const w of (ws && Array.isArray(ws.windows) ? ws.windows : [])) if (w && w.type === 'page') sent.set(w.id, w);
    for (const ws of next.ws) for (const w of (ws && Array.isArray(ws.windows) ? ws.windows : [])) {
      if (!w || w.type !== 'page' || !last.has(w.id)) continue;
      const owner = this.ownerOf(w.id);
      // A page window's tabs and shown tab are whole: the window that shows it, or any window while none does, sets them.
      if (owner === undefined || owner === senderId) {
        const mine = sent.get(w.id);
        if (mine) for (const key of ['tabs', 'tab']) { if (key in mine) w[key] = clone(mine[key]); else delete w[key]; }
        continue;
      }
      const kept = last.get(w.id);
      if (JSON.stringify([kept.tabs, kept.tab]) === JSON.stringify([w.tabs, w.tab])) continue;
      for (const key of ['tabs', 'tab']) {
        if (key in kept) w[key] = kept[key];
        else delete w[key];
      }
      this.senderBehind = true;
    }
    if (!same(next, incoming)) this.senderBehind = true;
    return next;
  }

  ownerOf(id) {
    if (this.frozen) return this.owners.get(id);
    const open = (wc) => {
      if (this.alive && this.alive(wc)) return true;
      this.claims.delete(wc);
      return false;
    };
    const cur = this.owners.get(id);
    if (cur !== undefined && open(cur) && this.claims.has(cur) && this.claims.get(cur).has(id)) return cur;
    for (const [wc, ids] of [...this.claims]) if (ids.has(id) && open(wc)) { this.owners.set(id, wc); return wc; }
    this.owners.delete(id);
    return undefined;
  }

  freezeOwners() { for (const ids of [...this.claims.values()]) for (const id of ids) this.ownerOf(id); this.frozen = true; }
  flushPending() { if (this.timer || this.seq > this.committed) this.writeNowSync(); }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const seq = ++this.seq;
      const text = this.serialize();
      this.announce();
      this.chain = this.chain.then(() => this.writeAsync(seq, text)).catch((e) => console.error(`[flow] could not save ${this.file}: ${e.message}`));
    }, DEBOUNCE_MS);
  }

  serialize() {
    return JSON.stringify(Object.assign({}, this.doc || {}, this.bounds ? { bounds: this.bounds } : {}, this.popouts.length ? { popouts: this.popouts } : {},
      Object.keys(this.permissions).length ? { permissions: this.permissions } : {}));
  }

  announce() {
    if (!this.pendingBroadcast) return;
    this.pendingBroadcast = false;
    if (this.doc) this.broadcast(this.doc, this.senderBehind ? null : this.lastSender);
  }

  writeNowSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const seq = ++this.seq;
    const text = this.serialize();
    const tmp = `${this.file}.${process.pid}.${seq}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    this.committed = seq;
    this.announce();
  }

  async writeAsync(seq, text) {
    const tmp = `${this.file}.${process.pid}.${seq}.tmp`;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    if (seq < this.committed) { await fs.promises.unlink(tmp); return; }
    fs.renameSync(tmp, this.file);
    this.committed = seq;
  }
}

module.exports = { Store };




