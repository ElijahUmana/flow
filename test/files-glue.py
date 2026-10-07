#!/usr/bin/env python3
"""files' glue for the owners of main.js and preload.js (installed), index.html and app.js (backlog), sidebar.js
(sidebar) and page.js (page): the lines that wire src/files.js, src/files.css and src/files-main.js into Flow.
(term.js takes a dragged files row already: sept's FLOW_FILES drop.)

  python3 test/files-glue.py <tree> [owner ...]     apply to <tree>/src (all owners, or only the ones named)

Each edit must match exactly once; nothing is written to a file unless all of its edits match.
"""
import os
import sys

EDITS = {
    'installed': {
        'main.js': [
            ("const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, screen, session, shell, webContents } = require('electron');",
             "const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, protocol, screen, session, shell, webContents } = require('electron');"),
            ("const sessions = require('./sessions');\n",
             "const sessions = require('./sessions');\n"
             "const files = require('./files-main');\n"
             "// Before ready, and only once for every scheme: pages open a workspace's files at flow-file: addresses.\n"
             "protocol.registerSchemesAsPrivileged([files.privileges]);\n"),
            ("  ses.on('will-download', (_event, item, wc) => trackDownload(item, wc));\n",
             "  ses.on('will-download', (_event, item, wc) => trackDownload(item, wc));\n"
             "  files.serveOn(ses);\n"),
            ("      if (src && !/^(https?:|about:blank$)/i.test(src)) {",
             "      if (src && !/^(https?:|flow-file:|about:blank$)/i.test(src)) {"),
            ("!/^(https?|mailto|file|javascript|data|blob|about|chrome|chrome-extension|chrome-untrusted|devtools|view-source|filesystem|ws|wss):/i.test(url);",
             "!/^(https?|mailto|file|flow-file|javascript|data|blob|about|chrome|chrome-extension|chrome-untrusted|devtools|view-source|filesystem|ws|wss):/i.test(url);"),
            ("  handle('sessions:running', () => sessions.running());\n",
             "  handle('sessions:running', () => sessions.running());\n"
             "\n"
             "  handle('files:list', (_event, host, dir) => files.list(host, dir));\n"
             "  handle('files:exist', (_event, paths) => files.exist(paths));\n"
             "  handle('files:open', (_event, host, file) => files.open(host, file));\n"
             "  on('files:watch', (event, dirs) => files.watch(event.sender, dirs));\n"
             "  on('files:reveal', (_event, file) => files.reveal(file));\n"),
            ("  store = new Store(app.getPath('userData'), { broadcast: broadcastState, onCorrupt: reportCorruptState });\n",
             "  store = new Store(app.getPath('userData'), { broadcast: broadcastState, onCorrupt: reportCorruptState });\n"
             "  files.init({ store, home: HOME });\n"),
        ],
        'preload.js': [
            ("  openWindow: (hash) =>",
             "  files: {\n"
             "    list: (host, dir) => ipcRenderer.invoke('files:list', host ? String(host) : null, String(dir)),\n"
             "    exist: (paths) => ipcRenderer.invoke('files:exist', Array.isArray(paths) ? paths.map(String) : []),\n"
             "    open: (host, file) => ipcRenderer.invoke('files:open', host ? String(host) : null, String(file)),\n"
             "    watch: (dirs) => ipcRenderer.send('files:watch', Array.isArray(dirs) ? dirs.map((d) => ({ host: d && d.host ? String(d.host) : null, dir: String(d && d.dir) })) : []),\n"
             "    reveal: (file) => ipcRenderer.send('files:reveal', String(file)),\n"
             "    onChanged: (cb) => listen('files:changed', cb),\n"
             "  },\n"
             "\n"
             "  openWindow: (hash) =>"),
        ],
    },
    'backlog': {
        'index.html': [
            ('<link rel="stylesheet" href="sidebar.css">', '<link rel="stylesheet" href="sidebar.css"><link rel="stylesheet" href="files.css">'),
            ('<script src="sidebar.js"></script>', '<script src="files.js"></script>\n<script src="sidebar.js"></script>'),
        ],
        'app.js': [
            ("const prettyTitle = (url) => url.replace(/^https?:\\/\\//, '').replace(/\\/$/, '').split('/').slice(0, 2).join('/');",
             "/* A workspace file's page (files.js) is called by its file name until it says its title. */\n"
             "const fileName = (url) => { const s = url.slice(url.lastIndexOf('/') + 1); try { return decodeURIComponent(s); } catch (e) { return s; } };\n"
             "const prettyTitle = (url) => (/^flow-file:/i.test(url) ? fileName(url) : url.replace(/^https?:\\/\\//, '').replace(/\\/$/, '').split('/').slice(0, 2).join('/'));"),
            ("  if (window.FlowSidebar) window.FlowSidebar.mount(sidebarHooks());\n  else console.error('sidebar.js did not load, so the sidebar cannot draw');\n",
             "  if (window.FlowSidebar) window.FlowSidebar.mount(sidebarHooks());\n  else console.error('sidebar.js did not load, so the sidebar cannot draw');\n"
             "  if (window.FlowFiles) {\n"
             "    window.FlowFiles.mount({\n"
             "      get WS() { return WS; }, get cur() { return cur; }, els: { sb, sblist, q }, save, renderSidebar, toast, expand, tilde,\n"
             "      openUrl: (ws, url) => window.FlowSidebar.openUrl(ws, url),\n"
             "    });\n"
             "  } else {\n"
             "    console.error('files.js did not load, so the sidebar shows no files');\n"
             "  }\n"),
            ("    onTabs: (tabs, tab) => {",
             "    onDownload: (d) => { const L = locate(id); if (L && window.FlowFiles) window.FlowFiles.downloaded(L.ws, d); },\n"
             "    onTabs: (tabs, tab) => {"),
        ],
    },
    'sidebar': {
        'sidebar.js': [
            ("    /* sub-workspaces, last: each with its own agents, notes and pages; drop anything on one to move it there */\n",
             "    /* files: the workspace's folder (and its folder on the VM) and its downloads, from files.js */\n"
             "    if (!all && window.FlowFiles) window.FlowFiles.rows(ws, add);\n"
             "\n"
             "    /* sub-workspaces, last: each with its own agents, notes and pages; drop anything on one to move it there */\n"),
            ("  const GROUPS = ['agents', 'notes', 'browser', 'sub-workspaces'];",
             "  const GROUPS = ['agents', 'notes', 'browser', 'files', 'sub-workspaces'];"),
            ("    if (k === 'saved') { openSaved(ws, a); return; }\n",
             "    if (k === 'saved') { openSaved(ws, a); return; }\n"
             "    if (k === 'files') { window.FlowFiles.perform(ws, act); return; }\n"),
            ("  function rowItems(ws, k, id, rest) {\n",
             "  function rowItems(ws, k, id, rest) {\n"
             "    if (k === 'files') return window.FlowFiles.menu(ws, `files|${id}`);\n"),
            ("      if (d) {\n        dragItem = { ws: +d.dataset.ws, what: d.dataset.drag };",
             "      if (d && d.dataset.drag.startsWith('files|')) { window.FlowFiles.dragStart(e, d.dataset.drag); return; }\n"
             "      if (d) {\n        dragItem = { ws: +d.dataset.ws, what: d.dataset.drag };"),
            ("      if (tr && e.detail > 1 && /^(sec|folder|zone)\\|/.test(tr.dataset.act)) return;",
             "      if (tr && e.detail > 1 && /^(sec|folder|zone|files)\\|/.test(tr.dataset.act)) return;"),
            ("  /* A saved page opens where it is open; otherwise its old page note",
             "  /* A page by its address: where it is open, else a new tab in the page in front in this space, else a new page. */\n"
             "  function openUrl(ws, url) {\n"
             "    const at = openPages(ws).find((p) => normUrl(p.url) === normUrl(url));\n"
             "    if (at) { showTab(ws, at.w, at.i); return at.w; }\n"
             "    const f = ws === A.WS[A.cur] ? frontWin() : null;\n"
             "    const r = f && f.w.type === 'page' && inSpace(ws, f.w) ? WIN.get(f.w.id) : null;\n"
             "    if (r && r.page && r.page.newTab) { r.page.newTab(url); focusWin(ws, f.w); return f.w; }\n"
             "    const w = openPageWin(ws, url);\n"
             "    render();\n"
             "    save();\n"
             "    return w;\n"
             "  }\n"
             "  /* A saved page opens where it is open; otherwise its old page note"),
            ("  window.FlowSidebar = { mount, render, migrate, savedHooks, savedSection, isSaved: (ws, url) => !!findSaved(ws, url) };",
             "  window.FlowSidebar = { mount, render, migrate, savedHooks, savedSection, openUrl, isSaved: (ws, url) => !!findSaved(ws, url) };"),
        ],
    },
    'page': {
        'page.js': [
            ("  const LOADABLE_RE = /^(?:https?:|about:blank$)/i;",
             "  const LOADABLE_RE = /^(?:https?:|flow-file:|about:blank$)/i;"),
            ("""      for (const t of tabs) {
        if (!t.wv) continue;
        t.wv.style.width = `${rw}px`;
        t.wv.style.height = `${h / s}px`;
        t.wv.style.transform = s < 1 ? `scale(${s})` : '';
      }""",
             """      for (const t of tabs) {
        if (!t.wv) continue;
        // A workspace file (files.js) reads at the window's own width; a site gets the desktop width it was made for.
        const own = /^flow-file:/i.test(t.url), tw = own ? w : rw, ts = own ? 1 : s;
        t.wv.style.width = `${tw}px`;
        t.wv.style.height = `${h / ts}px`;
        t.wv.style.transform = ts < 1 ? `scale(${ts})` : '';
      }"""),
        ],
    },
}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = os.path.join(sys.argv[1], 'src')
    owners = sys.argv[2:] or list(EDITS)
    bad = []
    for owner in owners:
        for name, pairs in EDITS[owner].items():
            p = os.path.join(src, name)
            text = open(p, encoding='utf-8').read()
            misses = [old.splitlines()[0][:90] for old, _ in pairs if text.count(old) != 1]
            if misses:
                bad.append(f'{owner} {name}: no single match for ' + '; '.join(repr(m) for m in misses))
                continue
            for old, new in pairs:
                text = text.replace(old, new)
            open(p, 'w', encoding='utf-8').write(text)
            print(f'{owner} {name}: {len(pairs)} edits applied')
    if bad:
        sys.exit('\n'.join(bad))


if __name__ == '__main__':
    main()




