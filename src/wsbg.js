/* Right-click a workspace: its background, its folder, where its new agents start, rename, delete. Rows only, as a Mac
   menu is (owner, Nov 2 14:33: "why can't backgrounds be its own ... you hover over and it shows you the options"):
   the gradients and the two places agents can start open beside the menu when their row is pointed at or clicked.
   Pointing at a gradient shows it on the workspace and a click keeps it; Esc or a click elsewhere closes the menu and
   puts the old one back. */
(() => {
'use strict';

const glow = (a, b, c) => `radial-gradient(1100px 650px at 15% 10%, ${a} 0%, transparent 62%), radial-gradient(900px 600px at 90% 92%, ${b} 0%, transparent 60%), ${c}`;
const presets = [
  { name: 'dusk', css: 'radial-gradient(1100px 650px at 18% 8%, #2b2444 0%, transparent 62%), radial-gradient(900px 600px at 92% 95%, #3b2236 0%, transparent 60%), #141319' },
  { name: 'plum', css: glow('#33203b', '#2a1c33', '#151018') },
  { name: 'wine', css: glow('#3e1d26', '#341c1c', '#150e10') },
  { name: 'amber', css: glow('#3a2a17', '#33241a', '#17130f') },
  { name: 'forest', css: glow('#1b3424', '#28331a', '#0e1410') },
  { name: 'teal', css: glow('#16323a', '#1d3a2f', '#10171a') },
  { name: 'ocean', css: glow('#113046', '#0f363c', '#0b1317') },
  { name: 'navy', css: glow('#1c2a45', '#1b2f4a', '#0f131b') },
  { name: 'indigo', css: glow('#24304a', '#2f2446', '#121318') },
  { name: 'graphite', css: glow('#2c2c33', '#25252b', '#111113') },
];
/* The same colors count as the same background, wherever the glows sit. */
const colors = (css) => (String(css || '').toLowerCase().match(/#[0-9a-f]{3,8}\b/g) || []).join(' ');
const shorten = (p) => (p.length > 30 ? `…${p.slice(-29)}` : p);

const OPEN_MS = 100;    // a row's choices open this long after the pointer comes onto it, so passing over opens none
const SWITCH_MS = 250;  // with another row's open: this long, so a slanting path over other rows to them keeps them
let open = null;

function close() {
  if (!open) return;
  const o = open;
  open = null;
  o.closeSub();
  o.menu.remove();
  document.removeEventListener('pointerdown', o.outside, true);
  document.removeEventListener('keydown', o.key, true);
  window.removeEventListener('blur', close);
  if (o.el && !o.picked) o.el.style.background = o.bg;
  if (o.commit && !o.cancelled) o.commit();
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

/* o: { el, bg, onBg(css), folder, onFolder() or onFolderText(text), runsOn: 'mac'|'vm', onRunsOn(where), onRename(),
   onDelete() }. A part shows only when its callback is given. Every click closes the menu before its callback runs.
   With onFolderText (a folder on the VM, typed) the folder row turns into a field: Enter or a click elsewhere keeps the
   text, as renaming in place does, Esc drops it; onFolderText gets it trimmed ('' when emptied), only if it changed. */
function show(e, o) {
  e.preventDefault();
  close();
  const menu = node('div', 'wsm');
  const state = { menu, el: o.el, bg: o.bg, picked: false, sub: null, subT: 0, over: null };
  const act = (fn, ...args) => () => { close(); fn(...args); };

  const rows = [], fills = new Map();
  const row = (label, hint, run) => {
    const b = node('button', 'row', label);
    if (hint) b.appendChild(node('span', 'k', shorten(hint)));
    b.addEventListener('click', run);
    rows.push(b);
  };
  state.closeSub = () => {
    clearTimeout(state.subT);
    state.subT = 0;
    const s = state.sub;
    if (!s) return;
    state.sub = null;
    s.row.classList.remove('open');
    s.el.remove();
  };
  /* A row's choices, beside the menu at the row's height (on its left when the right has no room). */
  const openSub = (b) => {
    clearTimeout(state.subT);
    state.subT = 0;
    if (state.sub && state.sub.row === b) return;
    state.closeSub();
    const el = node('div', 'wsm sub');
    fills.get(b)(el);
    el.addEventListener('pointerenter', () => { clearTimeout(state.subT); state.subT = 0; state.over = null; });
    document.body.appendChild(el);
    const r = b.getBoundingClientRect(), m = menu.getBoundingClientRect(), s = el.getBoundingClientRect();
    el.style.left = (m.right + 2 + s.width <= innerWidth - 6 ? m.right + 2 : Math.max(6, m.left - 2 - s.width)) + 'px';
    el.style.top = Math.max(6, Math.min(r.top - 5, innerHeight - s.height - 6)) + 'px';
    b.classList.add('open');
    state.sub = { row: b, el };
  };
  const subRow = (label, hint, fill) => {
    const b = node('button', 'row', label);
    b.appendChild(node('span', 'k', hint ? `${shorten(hint)} ›` : '›'));
    b.addEventListener('click', () => openSub(b));
    fills.set(b, fill);
    rows.push(b);
  };
  menu.addEventListener('pointerover', (ev) => {
    const b = ev.target.closest('.row');
    if (!b || b === state.over) return;
    state.over = b;
    clearTimeout(state.subT);
    state.subT = 0;
    if ((state.sub && state.sub.row === b) || (!fills.has(b) && !state.sub)) return;
    state.subT = setTimeout(() => { state.subT = 0; if (fills.has(b)) openSub(b); else state.closeSub(); }, state.sub ? SWITCH_MS : OPEN_MS);
