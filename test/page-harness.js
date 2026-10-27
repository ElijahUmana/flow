/* Mounts FlowPage windows for test/page-cdp.mjs. Every callback is recorded in window.__log. Tabs and saved pages go
   through the real backend's flow.saveState, so a restart of the app brings them back (window.__saved is the
   store; workspace "here" is this harness, "elsewhere" a second workspace for the new tab's grouping). */
(() => {
  'use strict';
  const log = (window.__log = []);
  const pages = (window.__pages = {});
  const grid = document.getElementById('grid');
  const record = (page, ev, data) => log.push({ page, ev, t: Date.now(), ...data });
  const params = new URLSearchParams(location.hash.slice(1));

  const state = { tabs: {}, saved: [], next: 1, section: { here: 'saved' } };
  const NAMES = { here: 'harness', elsewhere: 'elsewhere' };
  const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/$/, '');
  let saveTimer = 0;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.flow.saveState({ ...state, v: 'page-harness' }), 50);
  };
  const changed = () => {
    Object.values(pages).forEach((p) => p.savedChanged());
    persist();
  };
  /* The app's saved-page functions, bound to one workspace. */
  const savedFor = (ws) => ({
    find: (url) => state.saved.find((s) => s.ws === ws && norm(s.url) === norm(url)) || null,
    save: ({ url, title, about }) => {
      const e = { id: `s${state.next++}`, url, title, about, ws, section: state.section[ws] || 'saved', at: Date.now() };
      state.saved.push(e);
      record(ws, 'saved', { url, title, about, section: e.section });
      changed();
      return e;
    },
    remove: (id) => {
      state.saved = state.saved.filter((s) => s.id !== id);
      record(ws, 'removed', { id });
      changed();
    },
    all: () => state.saved.map((s) => ({ ...s, wsName: NAMES[s.ws] || s.ws, here: s.ws === ws })),
  });
  window.__saved = {
    state,
    add: (ws, url, title, about, section) => {
      state.saved.push({ id: `s${state.next++}`, url, title, about, ws, section, at: Date.now() });
      changed();
    },
    clear: () => {
      state.saved = [];
      changed();
    },
  };

  function add(spec) {
    const win = document.createElement('div');
    win.className = 'win page front';
    win.id = `win-${spec.id}`;
    const tb = document.createElement('div');
    tb.className = 'tb';
    const lights = document.createElement('div');
    lights.className = 'lights';
    lights.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const title = document.createElement('div');
    title.className = 'title';
    const act = document.createElement('span');
    act.className = 'act';
    tb.append(lights, title, act);
    // Like app.js's title bars (a press there starts a drag): the press keeps the keyboard focus where it was.
    tb.addEventListener('pointerdown', (e) => e.preventDefault());
    const pn = document.createElement('div');
    pn.className = 'pn';
    const ptitle = document.createElement('div');
    ptitle.className = 'ptitle';
    ptitle.contentEditable = 'true';
    ptitle.spellcheck = false;
    ptitle.dataset.ph = 'untitled page';
    const pgc = document.createElement('div');
    pgc.className = 'pgc';
    const pnote = document.createElement('div');
    pnote.className = 'pnote';
    pnote.contentEditable = 'true';
    pnote.spellcheck = false;
    pnote.dataset.ph = 'write about this page';
    pn.append(ptitle, pgc, pnote);
    win.append(tb, pn);
    grid.appendChild(win);

    const setTitle = (t) => {
      title.textContent = t;
      ptitle.textContent = t;
    };
    const kept = state.tabs[spec.id];
    const p = FlowPage.mount(pgc, {
      id: spec.id,
      url: spec.url,
      unloadAfter: spec.unloadAfter,
      tabs: kept ? kept.tabs : undefined,
      tab: kept ? kept.tab : undefined,
      saved: savedFor('here'),
      onTabs: (tabs, tab) => {
        record(spec.id, 'tabs', { tabs, tab });
        state.tabs[spec.id] = { tabs, tab };
        persist();
      },
      onNavigate: (e) => {
        record(spec.id, 'navigate', { url: e.url, title: e.title });
        if (e.title) setTitle(e.title);
      },
      onTitle: (t) => {
        record(spec.id, 'title', { title: t });
        setTitle(t);
      },
      onClip: (text, url, tab) => {
        record(spec.id, 'clip', { text, url, tab });
        pnote.textContent += (pnote.textContent ? '\n' : '') + text;
      },
      onFocus: () => record(spec.id, 'focus', {}),
      onClose: () => record(spec.id, 'close', {}),
      onDownload: (d) => record(spec.id, 'download', { download: d }),
      onMark: (text) => record(spec.id, 'mark', { text }),
      onPage: (info) => record(spec.id, 'pageinfo', { info }),
      onRedirect: (r) => record(spec.id, 'redirect', r),
      nameOf: (u) => (window.__names && window.__names[norm(u)]) || '',
      bare: !!spec.bare,
      onOpen: spec.bare ? (url) => record(spec.id, 'open', { url }) : undefined,
      onPinch: (e) => record(spec.id, 'pinch', e),
      onDragDone: () => record(spec.id, 'dragdone', {}),
      onWheel: (e) => record(spec.id, 'wheel', e),
      // A tab handed out of this page: taken unless a check says no (window.__tabOutNo).
      onTabOut: (kept, at) => {
        record(spec.id, 'tabout', { kept, at });
        return !window.__tabOutNo;
      },
      showMenu: (e, items) => {
        window.__menu = { page: spec.id, items };
        record(spec.id, 'menu', { labels: items.map((i) => i.label) });
      },
    });
    pages[spec.id] = p;
    if (spec.visible !== false) p.setVisible(true);
    return p;
  }

  window.flow.loadState().then((s) => {
    if (s && s.v === 'page-harness' && !params.has('fresh')) Object.assign(state, s, { v: undefined });
    [
      { id: 'a', url: params.has('a') ? params.get('a') : 'https://www.alphaxiv.org/abs/2610.38355' },
      { id: 'b', url: params.has('b') ? params.get('b') : 'https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-judgment-bottleneck-balancing-ai-and-human-speeds-in-strategy' },
      { id: 'c', url: params.get('c') || '' },
      { id: 'd', url: params.get('d') || '' },
    ].forEach(add);
    window.__add = add;
    window.__ready = true;
  }, (e) => {
    console.error('page harness: could not load its state', e);
  });
})();




