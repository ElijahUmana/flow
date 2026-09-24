'use strict';
/* Page records (FlowNotes) from two copies of the state: every Flow window holds one, and so does the store in main.
   For each page the copy the owner changed last wins (`at`), and a deletion is a record { gone: true, at }, so an older
   copy never brings back what was deleted. What a page says about itself (title, about) is not the owner's change: it
   comes from the copy that heard it last (`seen`). A deletion is forgotten after 30 days.
   merge(mine, theirs) → { pages, ahead }: ahead when mine holds something theirs lacks. On a tie theirs wins, so that
   copies agree. A classic script in a window (window.FlowNotesMerge), a module in main. */
(function (root) {
  const KEEP_MS = 30 * 24 * 3600 * 1000;
  const keysOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);
  const recOf = (o, k) => {
    const r = o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null;
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  };
  function merge(mine, theirs, now = Date.now()) {
    const pages = {};
    let ahead = false;
    for (const k of new Set([...keysOf(mine), ...keysOf(theirs)])) {
      const m = recOf(mine, k), t = recOf(theirs, k);
      let r = !t || (m && (m.at || 0) > (t.at || 0)) ? m : t;
      if (!r || (r.gone && now - (r.at || 0) > KEEP_MS)) continue;
      const o = r === m ? t : m;
      if (o && !o.gone && !r.gone && (o.seen || 0) > (r.seen || 0)) r = { ...r, title: o.title, about: o.about, seen: o.seen };
      pages[k] = r;
      if (r !== t) ahead = true;
    }
    return { pages, ahead };
  }
  const api = { merge };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.FlowNotesMerge = api;
})(this);




