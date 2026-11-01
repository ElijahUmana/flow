/* Mounts a claude, a shell and a team FlowTerm against the real backend and records every callback in window.__h. */
(() => {
  'use strict';
  const H = window.__h = { errors: [], titles: {}, opened: {}, exits: {}, links: [], drags: [], focus: [], swipes: [], menu: [], cannot: [], downloads: [], t: {} };
  window.addEventListener('error', (e) => H.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => H.errors.push(String(e.reason && e.reason.stack || e.reason)));
  if (!window.flow) throw new Error('term harness: window.flow is missing, run it through electron . with FLOW_ENTRY');

  const home = window.flow.homeDir;
  const SPECS = {
    claude: { id: 'h-claude', cmd: 'claude', cwd: home, sessionId: crypto.randomUUID() },
    shell: { id: 'h-shell', cmd: 'shell', cwd: home },
    team: { id: 'h-team', cmd: 'shell', cwd: home, team: true },
  };
  const push = (bag, k, v) => { (bag[k] = bag[k] || []).push(v); };

  function mount(name, extra) {
    const win = document.getElementById(`w-${name}`);
    const t = window.FlowTerm.mount(win.querySelector('.termhost'), {
      ...SPECS[name],
      ...(extra || {}),
      onTitle: (s) => { push(H.titles, name, s); win.querySelector('.ttl').textContent = s; },
      onOpened: (r) => push(H.opened, name, r),
      onExit: (code) => push(H.exits, name, code),
      onLink: (url) => H.links.push({ name, url }),
      onFocus: () => H.focus.push(name),
      onMateDragStart: (pane, e) => H.drags.push({ name, pane, type: e.type, x: e.clientX, y: e.clientY, target: e.target.className }),
      onCannot: (text) => H.cannot.push({ name, text }),
      onDownload: (file) => H.downloads.push({ name, file }),
    });
    H.t[name] = t;
    t.setVisible(true);
    return t;
  }

  H.mount = mount;
  H.remount = (name, extra) => { H.t[name].detach(); return mount(name, extra); };
  H.specs = SPECS;

  document.getElementById('desk').addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    H.swipes.push({ dx: e.deltaX, trusted: e.isTrusted });
  }, { passive: false });
  window.flow.onMenu((action) => H.menu.push(action));

  Object.keys(SPECS).forEach((name) => mount(name));
})();




