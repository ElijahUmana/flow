# Applies the teams.js glue to src/app.js and src/index.html (orch's glue list in STATUS.md, for backlog).
# usage: python3 test/orch-teams-glue.py <dir holding app.js and index.html>
import sys, os
d = sys.argv[1]
app, html = os.path.join(d, 'app.js'), os.path.join(d, 'index.html')
s = open(app).read()
def rep(old, new):
    global s
    n = s.count(old)
    if n != 1: raise SystemExit(f'expected 1 match, found {n}: {old[:90]!r}')
    s = s.replace(old, new)
# 1. teams.js keeps the pane lists
rep("const PANES = new Map(); // team window id -> last flow.term.panes(id)\n", "")
# 2. termOpts: term.js takes pane lists from teams.js; a session's end and a pane drag go to teams.js
rep("    onMateDragStart: (pane, e) => startPaneDrag(id, pane, e),\n",
    "    panesFrom: 'app',\n    onExit: () => { if (window.FlowTeams) window.FlowTeams.onExit(id); },\n"
    "    onMateDragStart: (pane, e) => { if (window.FlowTeams) window.FlowTeams.startPaneDrag(id, pane, e); },\n")
# 3. onTermOpened
rep("  if (L.w.type === 'team') pollPanes(id);\n", "  if (window.FlowTeams) window.FlowTeams.onOpened(id, res);\n")
# 4. the old teams section goes, from its header to the window actions
a = s.index("/* ---------- teams: teammates are real tmux panes that can leave and join ---------- */")
b = s.index("/* ---------- window actions ---------- */")
s = s[:a] + s[b:]
# 5. a terminal dropped on a team
rep("const t = w.type === 'term' ? teamAt(ws, ev.clientX, ev.clientY, w) : null;",
    "const t = w.type === 'term' && window.FlowTeams ? window.FlowTeams.teamAt(ws, ev.clientX, ev.clientY, w) : null;")
rep("attachToTeam(ws, w, t, ox, oy); return; }", "window.FlowTeams.dropOnTeam(ws, w, t); return; }")
# 6. app.js's own sidebar rows (until sidebar.js is wired; then pass members and paneName from FlowTeams to it)
old6 = "    members(w).forEach((p) => add('agents', 1, '›_', paneName(p), '', `mate|${w.id}|${p.paneId}`, { path: `${termTitle(w)} › ${paneName(p)}`, text: `${p.title || ''} ${p.command || ''} ${p.cwd || ''}` }));"
if old6 in s:
    rep(old6, "    if (window.FlowTeams) window.FlowTeams.members(w).forEach((p) => add('agents', 1, '›_', window.FlowTeams.paneName(p), '', `mate|${w.id}|${p.paneId}`, { path: `${termTitle(w)} › ${window.FlowTeams.paneName(p)}`, text: `${p.title || ''} ${p.command || ''} ${p.cwd || ''}` }));")
# 7. the old 3 s poll of every team goes; teams.js polls what is on screen
rep("  setInterval(pollAllPanes, 3000);\n", "")
# 8. a teammate whose team link ended says so where remote windows say where they are
rep("""<span class="where">${esc(w.where || '')}</span>""",
    """<span class="where">${esc((window.FlowTeams && window.FlowTeams.label(w)) || w.where || '')}</span>""")
# 9. mount, after the dock
rep("  if (window.FlowDock) window.FlowDock.attach($('dock'));\n", """  if (window.FlowDock) window.FlowDock.attach($('dock'));
  if (window.FlowTeams) {
    window.FlowTeams.mount({
      get WS() { return WS; }, get cur() { return cur; }, get VW() { return VW; }, get VH() { return VH; },
      locate, save, toast, addWindow, removeWindow, apply, sizeCanvas, focusWin, bringFront, besideSpot, dockTopPct,
      geo, elOf, termTitle, splitTitle, renderTitle, onTermTitle, scheduleSidebar, renderSidebar, remoteOpts, newId,
      tilde, setDragging, rectHas, inSpace, WIN, els: { viewport },
    });
  } else {
    console.error('teams.js did not load, so teammates stay as panes of their team');
  }
""")
for name in ('PANES', 'pollAllPanes', 'attachToTeam', 'pollPanes(', 'paneErr'):
    if name in s: raise SystemExit(f'{name} is still referenced in app.js')
open(app, 'w').write(s)
h = open(html).read()
if h.count('<script src="app.js"></script>') != 1: raise SystemExit('index.html: no single app.js script tag')
if 'teams.js' not in h:
    h = h.replace('<script src="app.js"></script>', '<script src="teams.js"></script>\n<script src="app.js"></script>')
open(html, 'w').write(h)
print('teams.js glue applied to', d)




