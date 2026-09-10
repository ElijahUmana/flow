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
