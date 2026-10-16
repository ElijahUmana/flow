// Full-app checks for main on the real src/index.html, under xvfb, with main's own socket, userData, CDP port and
// --flow-dev=main marker (BRIEF 0). Also opens a main-process inspector on 9661 for the menu checks.
//   node test/main-app-cdp.mjs
// Prints ok/FAIL per check and info lines for measurements; exits non-zero on any FAIL. Cleans up its app and
// tmux server (flow-dev-main) at the end. The app never builds the seed itself: a probe launch reads __flow.seed() and
// the state is written without the windows that ssh to the VM (MAC_NOTES item 6). Real Claude Code starts in the
// seed's agent windows; nothing is typed into it.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as L from './main-cdp-lib.mjs';

const LOG = process.env.MAIN_APP_LOG || path.join(os.tmpdir(), `flow-dev-main-app-${Date.now()}.log`);
// Recorders for what Electron hands to the desktop (Linux: xdg-email for mailto:, xdg-open for other schemes).
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dev-main-bin-'));
const OPENED = path.join(BIN, 'opened.log');
for (const name of ['xdg-email', 'xdg-open']) {
  fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> '${OPENED}'\n`, { mode: 0o755 });
}
const APP_ENV = { PATH: `${BIN}:${process.env.PATH}` };
const openedLog = () => (fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8') : '');
const PROBE_STATE = { v: 11, ws: [{ id: 'main-probe', name: 'main probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} };
const MCKINSEY = 'https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/the-judgment-bottleneck-balancing-ai-and-human-speeds-in-strategy';

let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};
const info = (name, text) => console.log(`info ${name}: ${text}`);
const j = (v) => JSON.stringify(v);

// ---------- local pages for popups and the context menu ----------
// A valid one-page PDF showing `text`.
function tinyPdf(text) {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`;
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
let port = 0;
const server = http.createServer((req, res) => {
  const pages = {
    '/opener.html': `<!doctype html><title>opener</title><body style="margin:0"><a id="shift" href="http://127.0.0.1:${port}/shift-target.html" style="display:block;font-size:20px;padding:10px">shift</a><a id="lnk" href="http://127.0.0.1:${port}/linked.html" style="display:block;font-size:48px;padding:60px">linked page</a></body>`,
    '/popup.html': '<!doctype html><title>popup page</title><p>popup</p>',
    '/login.html': '<!doctype html><title>login</title><script>document.title = "login " + (window.opener ? "with opener" : "without opener");</script>',
    '/linked.html': '<!doctype html><title>linked page</title><p>linked</p>',
    '/shift-target.html': '<!doctype html><title>shift target</title><p>shift</p>',
    // #map takes Ctrl+wheel as a map or a canvas app does; the rest of the page does nothing with it
    '/pinch.html': '<!doctype html><title>pinch</title><body style="margin:0;height:3000px"><div id="sx" style="width:300px;height:100px;overflow-x:auto"><div style="width:2000px;height:80px">wide</div></div><div id="map" style="width:300px;height:80px"></div><script>window.__wheels = []; window.__mapZoom = 0; addEventListener("wheel", (e) => __wheels.push({ ctrl: e.ctrlKey, dx: e.deltaX, dy: e.deltaY }), { passive: true }); document.getElementById("map").addEventListener("wheel", (e) => { if (e.ctrlKey) { e.preventDefault(); __mapZoom++; } }, { passive: false });</script></body>',
    '/mail.html': '<!doctype html><title>mail</title><body style="margin:0"><a id="mail" href="mailto:flow-main@example.com" style="display:block;font-size:40px;padding:40px">mail</a><a id="zoom" href="zoommtg://zoom.us/join?confno=1" style="display:block;font-size:40px;padding:40px">zoom</a></body>',
  };
  if (req.url.split('?')[0] === '/paper.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(tinyPdf('FLOW PDF OK'));
    return;
  }
  const body = pages[req.url.split('?')[0]];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
  res.end(body || 'not found');
});

function cleanup() {
  for (const pid of L.electronPids()) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
  try {
    L.tmux('kill-server');
  } catch (e) {
    if (!/no server running|error connecting/.test(String(e.stderr))) throw e;
  }
}

// The webview showing `url`. Probes add a unique #fragment (never sent to the server), so a seed page with the same
// address cannot match, and a guest still at about:blank is never picked.
async function guest(url, ms = 45000) {
  const t = await L.waitFor(async () => (await L.targets(L.PORT)).find((x) => x.type === 'webview' && x.url === url), ms, `a webview showing ${url}`);
  const c = await L.Cdp.connect(t.webSocketDebuggerUrl);
  c.target = t;
  return c;
}
// Input sent straight to a page that has not painted yet is dropped: two animation frames there first.
const painted = (g) => g.eval('await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true;');

async function quitApp(mainp) {
  // Close the inspector link first: Node keeps the process alive while a debugger is attached.
  mainp.send('Runtime.evaluate', { expression: 'const { app } = require("electron"); setTimeout(() => app.quit(), 200); 1', includeCommandLineAPI: true })
    .catch((e) => console.log(`info quit: ${e.message}`));
  await L.sleep(50);
  mainp.close();
  await L.waitFor(() => L.electronPids().length === 0, 20000, 'the app to quit');
}

function fdsOf(pid) {
  return fs.readdirSync(`/proc/${pid}/fd`).map((f) => {
    try {
      return fs.readlinkSync(`/proc/${pid}/fd/${f}`);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }).filter(Boolean);
}
const electronFiles = (links) => links.filter((l) => /electron\/dist|\/tmp\/flow-dev-main|\.org\.chromium|\.pak$/.test(l));
const listeners = (p) => execFileSync('ss', ['-ltnpH', `sport = :${p}`], { encoding: 'utf8' }).trim();

// Reads seed() from a probe app whose state is one empty workspace, then writes the seed without its host windows.
async function writeSeedWithoutHosts() {
  fs.mkdirSync(L.USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), JSON.stringify(PROBE_STATE));
  L.launch(LOG, APP_ENV);
  const probe = await L.flowPage();
  const probeMain = await L.mainProcess();
  const seed = await probe.eval('return typeof window.__flow.seed === "function" ? window.__flow.seed() : null;');
  probe.close();
  await quitApp(probeMain);
  if (!Array.isArray(seed)) throw new Error('window.__flow.seed() is missing; not starting the app on a fresh seed (it would run ssh claude-agents)');
  const removed = [];
  for (const w of seed) {
    for (const k of ['windows', 'closed']) {
      if (!Array.isArray(w[k])) continue;
      const kept = [];
      for (const x of w[k]) {
        if (x && x.host) removed.push(`${w.id}/${x.id} (${x.host}, attach ${x.attach})`);
        else kept.push(x);
      }
      w[k] = kept;
    }
  }
  // Team rule: real claude in tests runs under /tmp/flow-dev-main. Every workspace folder and window cwd moves there
  // (new agents start in their workspace's folder); the folders exist before launch, so nothing falls back to home.
  for (const w of seed) {
    w.folder = path.join(L.USER_DATA, 'ws', w.id);
    fs.mkdirSync(w.folder, { recursive: true });
    for (const x of [...(w.windows || []), ...(w.closed || [])]) if (x && 'cwd' in x) x.cwd = w.folder;
  }
  fs.writeFileSync(path.join(L.USER_DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws: seed, ui: {} }));
  return { workspaces: seed.length, removed };
}

const sessionTimes = () => {
  try {
    return Object.fromEntries(L.tmux('ls', '-F', '#{session_name} #{session_created}').split('\n').map((l) => l.split(' ')));
  } catch (e) {
    return {};
  }
};

// Terminal titles (osc) are live: a reattached terminal reports its current title.
// Changes on their own after a snapshot: terminal titles, a tab's history, which page.js records a moment after a
// navigation and again when the page unloads, and a tab's scroll, which page.js reads at a quit and uses up when the
// tab comes back.
const live = (d) => /\.osc: |\.tabs\.\d+\.(?:history|scroll)[.:]/.test(d);
const box = (b) => b && { x: b.x, y: b.y, width: b.width, height: b.height };

function diffPaths(a, b, at = '$', out = []) {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a && !b) || (!a && b)) {
    out.push(`${at}: ${j(a)?.slice(0, 80)} vs ${j(b)?.slice(0, 80)}`);
    return out;
  }
  if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${at}.${k}`, out);
  } else if (a !== b) {
    out.push(`${at}: ${j(a)} vs ${j(b)}`);
  }
  return out;
}

async function run() {
  cleanup();
  fs.rmSync(L.USER_DATA, { recursive: true, force: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  console.log(`app log: ${LOG}`);

  // ---------- the seed without its VM windows, then the first launch ----------
  const seeded = await writeSeedWithoutHosts();
  info('seed', `${seeded.workspaces} workspaces, removed ${seeded.removed.join(', ')}`);
  const probeFreed = await L.waitFor(() => listeners(L.PORT) === '', 5000, 'the probe launch to free the DevTools port').then(() => true, () => false);
  check('the probe launch quit and freed the DevTools port', probeFreed, listeners(L.PORT));
  // as a fresh install: no session index and no list cache from the probe launch (sessions.js writes them at quit)
  fs.rmSync(path.join(L.USER_DATA, 'session-index'), { recursive: true, force: true });
  const launchedAt = Date.now();
  L.launch(LOG, APP_ENV);
  let page = await L.flowPage();
  let mainp = await L.mainProcess();
  const first = await page.eval('const s = window.__flow.state(); return { title: document.title, ws: s.ws.length, windows: window.__flow.windows().length, hosts: s.ws.flatMap((w) => w.windows.concat(w.closed || [])).filter((x) => x.host).length };');
  check('the window loads index.html with the seed, no window has a host', first.title === 'Flow' && first.ws === 5 && first.hosts === 0, j(first));

  // sessions.list through IPC. The first call is a fresh install's cold path: it joins main's warm-up build (1.5 s after
  // ready), which reads every transcript. The next call, after it returned, is a warm one.
  const listOnce = 'const t = performance.now(); const l = await window.flow.sessions.list(); return { ms: Math.round(performance.now() - t), count: l.length, newest: l[0] && { id: l[0].id, title: String(l[0].title).slice(0, 60) } };';
  const sl = await page.eval(listOnce);
  info('sessions.list first call (cold, fresh install)', `${sl.ms} ms for the call, returned ${Date.now() - launchedAt} ms after launch, ${sl.count} sessions, newest ${j(sl.newest)}`);
  const warm = await page.eval(listOnce);
  info('sessions.list next call (warm)', `${warm.ms} ms, ${warm.count} sessions`);
  const wired = await page.eval('const s = await window.flow.sessions.search("flow", { limit: 3 }); const r = await window.flow.sessions.running(); return { searchKeys: Object.keys(s).sort(), results: Array.isArray(s.results), running: Array.isArray(r) };', { timeout: 60000 });
  check('flow.sessions.search and flow.sessions.running are wired to sessions.js', wired.results && wired.running && ['index', 'ms', 'query', 'results', 'total'].every((k) => wired.searchKeys.includes(k)), j(wired));
  // The first call of a fresh copy of sessions.js (no transcript cache) inside the running app's main process. Its stop()
  // right after keeps it from starting a second index worker on the app's folder (one per process, sessions.js:439).
  const cold = await mainp.eval(`const p = ${j(path.join(L.ROOT, 'src', 'sessions.js'))}; const orig = require.cache[p]; delete require.cache[p];
    const fresh = require(p); require.cache[p] = orig; const t = performance.now(); const l = await fresh.list(); const ms = Math.round(performance.now() - t);
    fresh.stop(); return { ms, count: l.length };`, { commandLine: true });
  // Not a check: under the VM's load it missed BRIEF 2.5's 1.5 s on landed code (1559 and 1647 ms) and ran in 713 ms at
  // a lower load. ~/flow-evidence/main/sessions-ab times it at low load.
  info('sessions.list first call (fresh module, in the running app; BRIEF 2.5: under 1.5 s)', `${cold.ms} ms, ${cold.count} sessions`);

  // ---------- nothing of Electron's leaks into tmux (Linux: node-pty and libuv fork without closing fds) ----------
  const srv = await L.waitFor(() => L.tmux('display-message', '-p', '#{pid}'), 60000, 'the tmux server of the seed\'s terminals');
  await L.waitFor(() => L.tmux('list-clients', '-F', '#{client_pid}'), 30000, 'a tmux client');
  const serverFds = fdsOf(srv);
  check('the tmux server holds none of Electron\'s files', electronFiles(serverFds).length === 0, `${serverFds.length} fds ${j(electronFiles(serverFds).slice(0, 4))}`);
  const clientPids = L.tmux('list-clients', '-F', '#{client_pid}').split('\n').filter(Boolean);
  const clientLeaks = clientPids.flatMap((pid) => electronFiles(fdsOf(pid)));
  check('the tmux clients hold none of Electron\'s files', clientLeaks.length === 0, `${clientPids.length} clients ${j(clientLeaks.slice(0, 4))}`);
  const claudeCwds = L.tmux('list-panes', '-a', '-F', '#{pane_current_command} #{pane_current_path}').split('\n').filter(Boolean);
  check('every terminal of the run works under /tmp/flow-dev-main', claudeCwds.length > 0 && claudeCwds.every((l) => l.split(' ').slice(1).join(' ').startsWith(L.USER_DATA + '/')), j(claudeCwds));
  const devtools = listeners(L.PORT);
  check('only Electron listens on the DevTools port', /"electron"/.test(devtools) && !/tmux/.test(devtools), devtools);

  // ---------- menu template (BRIEF 2.6) ----------
  const menu = await mainp.eval(`const { Menu } = require('electron'); const out = [];
    const walk = (m, trail) => m.items.forEach((i) => { out.push({ label: i.label, role: i.role || null, accel: i.accelerator || null, trail }); if (i.submenu) walk(i.submenu, trail + '/' + i.label); });
    walk(Menu.getApplicationMenu(), ''); return out;`, { commandLine: true });
  const roles = menu.map((i) => String(i.role || '').toLowerCase()).filter(Boolean);
  check('no reload or forceReload role anywhere in the menu', !roles.some((r) => r === 'reload' || r === 'forcereload'), `roles: ${roles.join(',')}`);
  const want = {
    'New Agent': 'Command+N', 'New Shell': 'Alt+Command+T', 'New Team': 'Alt+Command+N', 'New Note': 'Shift+Command+N', 'New Tab': 'Command+T',
    'New Page': 'Alt+Command+P', 'New Sub-workspace': null, 'New Workspace': 'Control+Command+N', 'Close Window': 'Command+W',
    Search: 'Command+K', 'Toggle Sidebar': 'Command+\\',
    'Reload Page': 'Command+R', Back: 'Command+[', Forward: 'Command+]', 'Focus Address': 'Command+L', Find: 'Command+F',
    Arrange: 'Control+Command+A', 'Save Page': 'Command+D', 'Zoom In': 'Command+Plus', 'Zoom Out': 'Command+-', 'Actual Size': 'Command+0',
  };
  const accelOk = Object.entries(want).every(([label, accel]) => menu.some((i) => i.label === label && (i.accel || null) === accel));
  check('every BRIEF 2.6 action has its item and accelerator', accelOk, accelOk ? '' : j(menu.filter((i) => want[i.label] !== undefined)));
  check('no Help menu: nothing in the app handles a help action', !menu.some((i) => i.label === 'Help' || i.label === 'Flow Help' || String(i.role).toLowerCase() === 'help'),
    j(menu.filter((i) => /help/i.test(i.label + ' ' + i.role))));
  // Undo and Redo are Flow's actions since batch 9 (main-menu-test checks them)
  const editRoles = ['cut', 'copy', 'paste', 'pasteandmatchstyle'];
  check('standard Edit roles present', editRoles.every((r) => roles.includes(r)), roles.join(','));
  // the lead's ruling on browse's round 5: Select All reaches the focused terminal, so it is Flow's action, not the role
  check('Select All is Flow\'s select-all action on ⌘A', menu.some((i) => i.label === 'Select All' && i.accel === 'Command+A' && !i.role) && !roles.includes('selectall'),
    j(menu.filter((i) => /select/i.test(`${i.label} ${i.role}`))));
  check('Toggle Developer Tools on Alt+Command+I', menu.some((i) => String(i.role).toLowerCase() === 'toggledevtools' && i.accel === 'Alt+Command+I'));
  const cmdR = menu.filter((i) => i.accel === 'Command+R' || i.accel === 'CmdOrCtrl+R' || i.accel === 'CommandOrControl+R');
  check('Command+R belongs to Reload Page only', cmdR.length === 1 && cmdR[0].label === 'Reload Page', j(cmdR));

  // ---------- B3: an image on the clipboard becomes a PNG file in userData, its path for the terminal ----------
  await mainp.eval(`const { clipboard, nativeImage, ClipboardItem } = require('electron');
    const png = nativeImage.createFromBitmap(Buffer.alloc(3 * 2 * 4, 0x80), { width: 3, height: 2 }).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]); return true;`, { commandLine: true });
  const pasted = await page.eval('return await window.flow.saveClipboardImage();');
  const pastedInfo = pasted && fs.existsSync(pasted) ? {
    dir: path.dirname(pasted), png: fs.readFileSync(pasted).subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
    mode: (fs.statSync(pasted).mode & 0o777).toString(8), dirMode: (fs.statSync(path.dirname(pasted)).mode & 0o777).toString(8),
    size: await mainp.eval(`return require('electron').nativeImage.createFromPath(${j(pasted)}).getSize();`, { commandLine: true }),
  } : null;
  check('saveClipboardImage writes the clipboard image as a PNG in userData/pasted-images and returns its path',
    !!pastedInfo && pastedInfo.dir === path.join(L.USER_DATA, 'pasted-images') && pastedInfo.png && pastedInfo.mode === '600' && pastedInfo.dirMode === '700' &&
    pastedInfo.size.width === 3 && pastedInfo.size.height === 2, `${pasted} ${j(pastedInfo)}`);
  await mainp.eval('await require("electron").clipboard.writeText("flow paste text"); return true;', { commandLine: true });
  const notImage = await page.eval('return await window.flow.saveClipboardImage();');
  await mainp.eval('require("electron").clipboard.clear(); return true;', { commandLine: true });
  const emptyClip = await page.eval('return await window.flow.saveClipboardImage();');
  check('saveClipboardImage returns null for text or an empty clipboard', notImage === null && emptyClip === null, j([notImage, emptyClip]));

  // ---------- user agent and client hints from inside a webview (MAC_NOTES item 8) ----------
  const engine = await mainp.eval('return process.versions.chrome;');
  const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${engine.split('.')[0]}.0.0.0 Safari/537.36`;
  const echoUrls = ['https://httpbin.org/headers', 'https://postman-echo.com/headers'];
  let echo = null;
  for (const url of echoUrls) {
    const probeUrl = `${url}#flow-main-echo-${Date.now()}`;
    await page.eval(`window.__flow.openPage(${j(probeUrl)}); return true;`);
    try {
      const g = await guest(probeUrl);
      const body = await L.waitFor(() => g.eval('const t = document.body && document.body.innerText; return t && t.includes("{") ? t : null;'), 30000, `${url} to answer`);
      const nav = await g.eval('const d = navigator.userAgentData; return { ua: navigator.userAgent, brands: d.brands, mobile: d.mobile, platform: d.platform };');
      g.close();
      const parsed = JSON.parse(body);
      echo = { url, nav, headers: Object.fromEntries(Object.entries(parsed.headers || {}).map(([k, v]) => [k.toLowerCase(), v])) };
      break;
    } catch (e) {
      info('header echo', `${url} did not answer: ${e.message}`);
    }
  }
  check('an https header echo answered inside a webview', !!echo, echo ? echo.url : '');
  if (echo) {
    const h = echo.headers;
    const major = engine.split('.')[0];
    const brands = echo.nav.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
    check(`navigator.userAgent in the guest is Chrome ${major} (the engine's major) on macOS, no Electron or app token`, echo.nav.ua === UA, echo.nav.ua);
    check('User-Agent on the wire is the same', h['user-agent'] === UA, h['user-agent']);
    check('navigator.userAgentData names the same Chromium major', echo.nav.brands.some((b) => b.brand === 'Chromium' && b.version === major), `${brands}, platform ${echo.nav.platform}`);
    // Electron 45 sends no UA client hints, with or without a UA override; if it ever does, they must be Chromium's.
    const hints = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'].filter((k) => k in h);
    check('Flow adds no client hints: any sec-ch-ua on the wire is what navigator.userAgentData says', hints.length === 0 ||
      (h['sec-ch-ua'] === brands && h['sec-ch-ua-mobile'] === (echo.nav.mobile ? '?1' : '?0') && h['sec-ch-ua-platform'] === `"${echo.nav.platform}"`),
      hints.length ? hints.map((k) => `${k}: ${h[k]}`).join(' | ') : 'no sec-ch-ua* headers on the wire');
    info('request headers seen by the echo', Object.keys(h).join(', '));
  }

  // ---------- McKinsey from this VM (Akamai may block the IP; the Mac lead verifies on the Mac) ----------
  const mckProbe = `${MCKINSEY}#flow-main-probe-${Date.now()}`;
  await page.eval(`window.__flow.openPage(${j(mckProbe)}); return true;`);
  try {
    const g = await guest(mckProbe);
    // The guest's initial about:blank is also "complete": wait for the McKinsey document itself.
    const mk = await L.waitFor(() => g.eval(`const n = performance.getEntriesByType("navigation")[0]; return location.href.startsWith(${j(MCKINSEY)}) && document.readyState === "complete" && n ? { status: n.responseStatus, title: document.title, url: location.href } : null;`), 60000, 'the McKinsey page');
    g.close();
    info('McKinsey from this VM', `HTTP ${mk.status}, title ${j(mk.title)}, ${mk.url}`);
  } catch (e) {
    info('McKinsey from this VM', `no result: ${e.message}`);
  }

  // ---------- webview popups -> page:new-window ----------
  await page.eval('window.__nw = []; window.flow.onPageNewWindow((e) => window.__nw.push(e)); return true;');
  const opener = `http://127.0.0.1:${port}/opener.html`;
  const warnings = [];
  page.on((m) => { if (m.method === 'Runtime.consoleAPICalled' && /warn|error/.test(m.params.type)) warnings.push(m.params.args.map((a) => a.value ?? a.description).join(' ')); });
  await page.send('Runtime.enable');
  const openerWin = await page.eval(`return window.__flow.openPage(${j(opener)});`);
  // page.js binds the guest on did-navigate, which comes before page-title-updated: the title means it is bound.
  await L.waitFor(() => page.eval(`const p = window.__flow.page(${j(openerWin)}); return !!p && p.getTitle() === 'opener';`), 30000, 'the opener page in its window');
  const og = await guest(opener);
  await L.waitFor(() => og.eval('return document.readyState === "complete";'), 20000, 'the opener page');
  const guestId = await mainp.eval(`const { webContents } = require('electron'); const w = webContents.getAllWebContents().find((x) => x.getType() === 'webview' && x.getURL().startsWith(${j(opener)})); return w ? w.id : null;`, { commandLine: true });
  // main opens what a page opens only after the owner's own click or key in it (item 72): each open below follows a real
  // click into the page, on nothing, once it has painted
  const ownClick = async () => {
    await og.eval('await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true;');
    for (const type of ['mousePressed', 'mouseReleased']) await og.send('Input.dispatchMouseEvent', { type, x: 3, y: 300, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  };
  await ownClick();
  await og.eval(`window.open(${j(`http://127.0.0.1:${port}/popup.html`)}); return true;`, { gesture: true });
  await L.waitFor(() => page.eval('return window.__nw.length ? window.__nw : null;'), 10000, 'page:new-window');
  await L.sleep(500);
  const nw = await page.eval('return window.__nw;');
  check('window.open in a webview reaches the host as page:new-window with its guestId', nw.length === 1 && nw[0].url.endsWith('/popup.html') && nw[0].guestId === guestId, `${j(nw)} guest ${guestId}`);
  let popupWin = null;
  try {
    popupWin = await L.waitFor(() => page.eval(`return window.__flow.windows().find((w) => w.url && w.url.endsWith('/popup.html')) || null;`), 10000, 'a page window for the popup');
  } catch (e) {
    info('popup diagnostics', `pages ${j(await page.eval('return window.__flow.windows().filter((w) => w.type === "page").map((w) => [w.id, w.url]);'))}`);
    info('popup diagnostics', `webContents ${j(await mainp.eval('const { webContents } = require("electron"); return webContents.getAllWebContents().map((w) => [w.id, w.getType(), w.getURL().slice(0, 60)]);', { commandLine: true }))}`);
    info('popup diagnostics', `renderer warnings ${j(warnings.filter((w) => !/claude-agents/.test(w)).slice(-5))}`);
  }
  check('the app opened the popup as a page window', !!popupWin, j(popupWin));
  const popupGuests = (await L.targets(L.PORT)).filter((t) => t.type !== 'webview' && t.url.endsWith('/popup.html'));
  check('no native popup window was created', popupGuests.length === 0, j(popupGuests.map((t) => t.type)));
  // A popup or a link from the opener opens as a shown tab in the opener's window and hides the opener's tab, and input
  // sent straight to a page that has not painted is dropped (the popup can hide it before its first frame): the
  // opener's tab is shown, and has painted, before each input.
  const showOpener = async () => {
    await page.eval(`const p = window.__flow.page(${j(openerWin)}); p.selectTab(p.tabs().tabs.findIndex((t) => t.url.endsWith('/opener.html'))); return true;`);
    await L.waitFor(() => og.eval('return document.visibilityState === "visible";'), 10000, 'the opener tab to be shown');
    await og.eval('await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true;');
  };
  // a shift-click on a link: Chromium calls it 'new-window' too, with no features, and it opens as a Flow page
  await page.eval('window.__nw = []; return true;');
  await showOpener();
  const sh = await og.eval('const r = document.getElementById("shift").getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 };');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await og.send('Input.dispatchMouseEvent', { type, x: sh.x, y: sh.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers: 8 });
  }
  await L.waitFor(() => page.eval('return window.__nw.length ? window.__nw : null;'), 10000, 'page:new-window for the shift-click').catch(() => []);
  await L.sleep(500);
  const shifted = await page.eval('return window.__nw;');
  const shiftWins = await mainp.eval(`return require('electron').BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('/shift-target.html')).length;`, { commandLine: true });
  check('a shift-click on a link opens a Flow page (page:new-window, disposition new-window), not a real window',
    shifted.length === 1 && shifted[0].url.endsWith('/shift-target.html') && shifted[0].disposition === 'new-window' && shiftWins === 0, `${j(shifted)}, real windows ${shiftWins}`);

  // ---------- sign-in popups: window.open with features, or of about:blank, is a real window with an opener ----------
  const popupWins = () => mainp.eval(`const { BrowserWindow, session } = require('electron');
    return BrowserWindow.getAllWindows().filter((w) => /\\/login\\.html/.test(w.webContents.getURL())).map((w) => {
      const p = w.webContents.getLastWebPreferences() || {};
      return { id: w.id, url: w.webContents.getURL().replace(/^.*\\/login/, '/login'), title: w.webContents.getTitle(), flowSession: w.webContents.session === session.fromPartition('persist:flow'),
        sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, preload: p.preload || '' };
    });`, { commandLine: true });
  const flowWins = await mainp.eval('return require("electron").BrowserWindow.getAllWindows().length;', { commandLine: true });
  await showOpener();
  await ownClick();
  const openedFeat = await og.eval(`window.__login = window.open('/login.html?via=features', 'login', 'width=500,height=600'); return !!window.__login;`, { gesture: true });
  const pop1 = await L.waitFor(async () => (await popupWins()).find((w) => w.url.includes('via=features') && w.title === 'login with opener'), 15000, 'the sign-in popup').catch(() => null);
  check('window.open with features opens a real window: the page gets it, the popup has window.opener, persist:flow, sandboxed',
    openedFeat && !!pop1 && pop1.flowSession && pop1.sandbox === true && pop1.contextIsolation === true && pop1.nodeIntegration === false, j(pop1));
  check('the popup runs without the guest preload (a popup does not inherit the webview\'s)', !!pop1 && pop1.preload === '', j(pop1 && pop1.preload));
  await showOpener();
  await ownClick();
  const openedBlank = await og.eval(`const w = window.open('', '_blank'); if (!w) return false; w.location = '/login.html?via=blank'; return true;`, { gesture: true });
  const pop2 = await L.waitFor(async () => (await popupWins()).find((w) => w.url.includes('via=blank') && w.title === 'login with opener'), 15000, 'the blank-then-located popup').catch(() => null);
  check('window.open("", "_blank") returns a window the page can point somewhere (it keeps window.opener)', openedBlank && !!pop2, j(pop2));
  await mainp.eval(`const { Menu, BrowserWindow } = require('electron'); const find = (m) => { for (const i of m.items) { if (i.label === 'Close Window') return i; if (i.submenu) { const f = find(i.submenu); if (f) return f; } } return null; };
    for (const w of BrowserWindow.getAllWindows().filter((x) => /\\/login\\.html/.test(x.webContents.getURL()))) find(Menu.getApplicationMenu()).click({}, w, w.webContents);
    return true;`, { commandLine: true });
  await L.waitFor(async () => (await popupWins()).length === 0, 10000, 'the popups to close').catch(() => null);
  const afterClose = await mainp.eval('return require("electron").BrowserWindow.getAllWindows().length;', { commandLine: true });
  check('⌘W (Close Window) closes a sign-in popup and leaves the Flow windows', (await popupWins()).length === 0 && afterClose === flowWins, `${afterClose} windows, ${flowWins} before`);
  // xvfb has no window manager to give focus back when a window closes; macOS does.
  await mainp.eval('require("electron").BrowserWindow.getAllWindows()[0].focus(); return true;', { commandLine: true });
  await og.eval('window.__ctx = 0; addEventListener("contextmenu", () => { window.__ctx++; }, true); return true;');

  // ---------- webview context menu ----------
  await mainp.eval(`const { Menu } = require('electron'); globalThis.__flowTestMenus = [];
    globalThis.__flowTestPopup = Menu.prototype.popup;
    Menu.prototype.popup = function (opts) { globalThis.__flowTestMenus.push(this); };
    return true;`, { commandLine: true });
  await showOpener();
  const rect = await og.eval('const r = document.getElementById("lnk").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await og.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: type === 'mouseMoved' ? 'none' : 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
  }
  const items = await L.waitFor(() => mainp.eval('const m = globalThis.__flowTestMenus.at(-1); return m ? m.items.map((i) => ({ label: i.label, type: i.type, enabled: i.enabled })) : null;'), 10000, 'the webview context menu')
    .catch(async (e) => { info('context menu', `page contextmenu events ${await og.eval('return window.__ctx;')}`); throw e; });
  const labels = items.filter((i) => i.type !== 'separator').map((i) => i.label);
  check('right-click on a link builds the webview menu', j(labels) === j(['Back', 'Forward', 'Reload', 'Copy', 'Paste', 'Select All', 'Copy Link', 'Open Link in New Page', 'Inspect']), j(items));
  await mainp.eval('const m = globalThis.__flowTestMenus.at(-1); m.items.find((i) => i.label === "Copy Link").click(); return true;');
  const copied = await L.waitFor(() => mainp.eval('return await require("electron").clipboard.readText();', { commandLine: true }), 5000, 'the copied link').catch((e) => e.message);
  check('"Copy Link" puts the link on the clipboard', copied === `http://127.0.0.1:${port}/linked.html`, j(copied));
  await mainp.eval('const m = globalThis.__flowTestMenus.at(-1); m.items.find((i) => i.label === "Open Link in New Page").click(); return true;');
  const linkedWin = await L.waitFor(() => page.eval(`return window.__flow.windows().find((w) => w.url && w.url.endsWith('/linked.html')) || null;`), 10000, 'a page window for the link');
  check('"Open Link in New Page" opens a page window', !!linkedWin, j(linkedWin));
  // Clip to Note: with text selected, the menu hands the selection to the host (a PDF viewer's selection is out of
  // the page script's reach; main gets it from the context-menu params).
  await page.eval('window.__clips = []; window.flow.onPageClip((e) => window.__clips.push(e)); return true;');
  await showOpener();
  const selected = await og.eval('const r = document.createRange(); r.selectNodeContents(document.getElementById("lnk")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return sel.toString();');
  const menusBefore = await mainp.eval('return globalThis.__flowTestMenus.length;');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await og.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: type === 'mouseMoved' ? 'none' : 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
  }
  const clipLabels = await L.waitFor(() => mainp.eval(`const m = globalThis.__flowTestMenus.length > ${menusBefore} ? globalThis.__flowTestMenus.at(-1) : null; return m ? m.items.map((i) => i.label) : null;`), 10000, 'the menu with a selection');
  await mainp.eval('const m = globalThis.__flowTestMenus.at(-1); const i = m.items.find((x) => x.label === "Clip to Note"); if (i) i.click(); return !!i;');
  await L.waitFor(() => page.eval('return window.__clips.length ? window.__clips : null;'), 5000, 'page:clip').catch(() => []);
  await L.sleep(500);
  const clips = await page.eval('return window.__clips;');
  check('with text selected, "Clip to Note" sends the selection to the host as page:clip with the guestId', clipLabels.includes('Clip to Note') &&
    clips.length === 1 && clips[0].text === selected && clips[0].guestId === guestId, `${j(clipLabels)} ${j(clips)} selected ${j(selected)}`);
  await mainp.eval('const { Menu } = require("electron"); Menu.prototype.popup = globalThis.__flowTestPopup; return true;', { commandLine: true });
  og.close();

  // ---------- a PDF opens in Chromium's PDF viewer inside the page (sandboxed persist:flow webview), not as a download ----------
  await mainp.eval('globalThis.__flowDownloads = []; require("electron").session.fromPartition("persist:flow").on("will-download", (e, item) => globalThis.__flowDownloads.push(item.getURL())); return true;', { commandLine: true });
  const pdfUrl = `http://127.0.0.1:${port}/paper.pdf`;
  await page.eval(`window.__flow.openPage(${j(pdfUrl)}); return true;`);
  const pdfFrames = await L.waitFor(async () => {
    const f = await mainp.eval(`const { webContents } = require('electron'); const g = webContents.getAllWebContents().find((x) => x.getType() === 'webview' && x.getURL() === ${j(pdfUrl)});
      return g ? g.mainFrame.framesInSubtree.map((fr) => fr.url) : null;`, { commandLine: true });
    return f && f.some((u) => u.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) ? f : null;
  }, 20000, "Chromium's PDF viewer in the page").catch((e) => e.message);
  const downloads = await mainp.eval('return globalThis.__flowDownloads;', { commandLine: true });
  check("a PDF opens in Chromium's PDF viewer inside the page, with no download", Array.isArray(pdfFrames) && downloads.length === 0, `${j(pdfFrames)} downloads ${j(downloads)}`);

  // ---------- pinch, content first: a Ctrl+wheel in a page (what Chromium makes of a trackpad pinch) reaches the page,
  // and the host's <webview> element gets ipc-message 'flow:pinch' with used = the page took it (then nav leaves the
  // workspace alone); a plain wheel still scrolls the page ----------
  const pinchUrl = `http://127.0.0.1:${port}/pinch.html`;
  const pinchWin = await page.eval(`return window.__flow.openPage(${j(pinchUrl)});`);
  await L.waitFor(() => page.eval(`const p = window.__flow.page(${j(pinchWin)}); return !!p && p.getTitle() === 'pinch';`), 30000, 'the pinch page');
  await page.eval(`const wv = [...document.querySelectorAll('webview')].find((w) => { try { return w.getURL() === ${j(pinchUrl)}; } catch (e) { return false; } });
    window.__pinch = []; window.__wheel = []; wv.addEventListener('ipc-message', (e) => {
      if (e.channel === 'flow:pinch') window.__pinch.push(e.args[0]);
      if (e.channel === 'flow:wheel') window.__wheel.push(e.args[0]);
    }); return true;`);
  const pg = await guest(pinchUrl);
  await painted(pg);
  const wheelAt = async (x, y, deltaX, deltaY, modifiers) => {
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers });
    await L.sleep(300);
  };
  // a fast vertical scroll, 30 wheels 8 ms apart by event time with one sideways drift: every wheel reaches the page, and
  // the host gets only what nav needs (the deciding first one, the drift, one per 100 ms to keep the gesture open). It
  // runs first: a sideways wheel below moves nav to the next space, away from this page.
  await page.eval('window.__wheel = []; return true;');
  await pg.eval('window.__wheels = []; return true;');
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await pg.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 40, y: 200, deltaX: i === 15 ? 40 : 0, deltaY: i === 15 ? 0 : 30, modifiers: 0, timestamp: (t0 + i * 8) / 1000 });
  }
  await L.sleep(800);
  const fastHost = await page.eval('return window.__wheel.map(({ dx, dy, t }) => ({ dx, dy, t }));');
  const fastPage = await pg.eval('return window.__wheels.length;');
  const sinceFirst = fastHost.map((w) => Math.round(w.t - fastHost[0].t));
  const keptApart = fastHost.every((w, i) => i === 0 || w.dx === 40 || fastHost[i - 1].dx === 40 || sinceFirst[i] - sinceFirst[i - 1] >= 95);
  check('a fast scroll reaches the page in full, and the host only as nav needs it: the first wheel, the sideways drift, one per 100 ms',
    fastPage === 30 && fastHost.length >= 3 && fastHost.length <= 6 && fastHost[0].dy === 30 && fastHost.some((w) => w.dx === 40) && keptApart,
    `page ${fastPage}, host ${fastHost.length}: ${j(fastHost.map((w, i) => [w.dx, w.dy, sinceFirst[i]]))}`);
  await page.eval('window.__wheel = []; return true;');
  await pg.eval('window.__wheels = []; window.scrollTo(0, 0); return true;');
  await L.sleep(400);
  const widthBefore = await pg.eval('return innerWidth;');
  await wheelAt(40, 200, 0, -12.5, 2);   // pinch (Ctrl) over the plain page
  await wheelAt(40, 140, 0, -12.5, 2);   // pinch (Ctrl) over the map, which takes it
  await wheelAt(40, 200, 0, -30, 0);     // vertical scroll
  await wheelAt(40, 200, 40, 0, 0);      // sideways over a page that cannot scroll sideways
  await wheelAt(40, 30, 40, 0, 0);       // sideways over the page's own sideways scroller
  await L.sleep(300);
  const pinched = await page.eval('return window.__pinch.map(({ deltaY, deltaMode, x, y, used, t }) => ({ deltaY, deltaMode, x, y, used, t: typeof t }));');
  const wheeled = await page.eval('return window.__wheel.map(({ dx, dy, used, t }) => ({ dx, dy, used, t: typeof t }));');
  const pageSaw = await pg.eval('return { wheels: window.__wheels, mapZoom: window.__mapZoom, width: innerWidth, sx: document.getElementById("sx").scrollLeft, globals: [typeof require, typeof ipcRenderer, typeof process].join(" ") };');
  pg.close();
  check('a Ctrl+wheel the page does not use reaches the page, and the host as flow:pinch with used false (nav zooms the workspace); the page does not zoom',
    j(pinched[0]) === j({ deltaY: -12.5, deltaMode: 0, x: 40, y: 200, used: false, t: 'number' }) && pageSaw.wheels.filter((w) => w.ctrl).length === 2 && pageSaw.width === widthBefore,
    `host ${j(pinched)} page ${j(pageSaw.wheels)} width ${widthBefore} -> ${pageSaw.width}`);
  check('a Ctrl+wheel the page takes (a map, a canvas app) stays the page\'s: flow:pinch has used true', j(pinched[1]) === j({ deltaY: -12.5, deltaMode: 0, x: 40, y: 140, used: true, t: 'number' }) &&
    pinched.length === 2 && pageSaw.mapZoom === 1, `host ${j(pinched)} map zoomed ${pageSaw.mapZoom}`);
  check('every other wheel still reaches the page, and goes to the host as flow:wheel { dx, dy, t, used }', pageSaw.wheels.filter((w) => !w.ctrl).length === 3 &&
    j(wheeled) === j([{ dx: 0, dy: -30, used: false, t: 'number' }, { dx: 40, dy: 0, used: false, t: 'number' }, { dx: 40, dy: 0, used: true, t: 'number' }]),
    `host ${j(wheeled)} page ${j(pageSaw.wheels)}`);
  check('a sideways swipe over the page\'s own scroller still scrolls it', pageSaw.sx > 0, String(pageSaw.sx));
  check('the page sees nothing of the guest preload', pageSaw.globals === 'undefined undefined undefined', pageSaw.globals);

  // ---------- same-tab links to other schemes: mailto opens the mail app, an app link waits for the window's answer ----------
  const mailUrl = `http://127.0.0.1:${port}/mail.html`;
  const mailWin = await page.eval(`return window.__flow.openPage(${j(mailUrl)});`);
  await L.waitFor(() => page.eval(`const p = window.__flow.page(${j(mailWin)}); return !!p && p.getTitle() === 'mail';`), 30000, 'the mail page in its window');
  const mg = await guest(mailUrl);
  await painted(mg);
  const click = async (id) => {
    const r = await mg.eval(`const r = document.getElementById(${j(id)}).getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 };`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await mg.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    }
  };
  await click('mail');
  const mailed = await L.waitFor(() => (/^xdg-email mailto:flow-main@example\.com$/m.test(openedLog()) ? openedLog() : null), 10000, 'xdg-email to get the address').catch((e) => e.message);
  check('a mailto link clicked in a page reaches the mail app', /^xdg-email mailto:flow-main@example\.com$/m.test(openedLog()), j(mailed));
  await page.eval('window.__ext = []; window.flow.onPageOpenExternal((x) => window.__ext.push(x)); return true;');
  await click('zoom');
  await L.sleep(2000);
  const stay = await mg.eval('return location.href;');
  const asked = await page.eval('return window.__ext;');
  check('a zoommtg link waits: its window is asked (page:open-external), nothing opens yet, the page stays',
    asked.length === 1 && /^zoommtg:/.test(asked[0].url) && !/zoommtg/.test(openedLog()) && stay === mailUrl, `${j(asked)} opened ${j(openedLog())}, page at ${stay}`);
  await page.eval(`window.flow.answerExternal(${asked.length ? asked[0].requestId : 0}, false); return true;`);
  mg.close();

  // ---------- menu actions reach the focused window; Command+R never reloads the app ----------
  await page.eval('window.__menuLog = []; window.flow.onMenu((a) => window.__menuLog.push(a)); window.__noReload = 1; return true;');
  const navs = [];
  page.on((m) => { if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navs.push(m.params.frame.url); });
  await page.send('Page.enable');
  const actions = [['New Note', 'new-note'], ['New Tab', 'new-page'], ['New Page', 'new-page-window'], ['New Sub-workspace', 'new-zone'], ['Search', 'search'],
    ['Toggle Sidebar', 'toggle-sidebar'], ['Reload Page', 'reload-page'],
    ['Back', 'page-back'], ['Forward', 'page-forward'], ['Focus Address', 'focus-address'], ['Find', 'find'], ['Arrange', 'arrange'],
    ['Save Page', 'save-page'], ['New Workspace', 'new-workspace'], ['New Shell', 'new-shell'],
    ['New Agent', 'new-agent'], ['New Team', 'new-team'], ['Zoom In', 'page-zoom-in'], ['Zoom Out', 'page-zoom-out'], ['Actual Size', 'page-zoom-reset']];
  for (const [label] of actions) {
    await mainp.eval(`const { Menu, BrowserWindow } = require('electron'); const find = (m) => { for (const i of m.items) { if (i.label === ${j(label)}) return i; if (i.submenu) { const f = find(i.submenu); if (f) return f; } } return null; };
      const w = BrowserWindow.getAllWindows()[0]; find(Menu.getApplicationMenu()).click({}, w, w.webContents); return true;`, { commandLine: true });
    await L.sleep(250);
  }
  const got = await page.eval('window.__menuLogAll = window.__menuLog; return window.__menuLog;');
  check('every menu action arrives in the Flow window, in order', j(got) === j(actions.map((a) => a[1])), j(got));
  // Three-finger swipes (macOS 'swipe' event, emitted here): left -> next-ws, right -> prev-ws, up/down -> nothing.
  await page.eval('window.__menuLog = []; return true;');
  await mainp.eval(`const w = require('electron').BrowserWindow.getAllWindows()[0]; for (const d of ['left', 'right', 'up', 'down']) w.emit('swipe', {}, d); return true;`, { commandLine: true });
  await L.sleep(400);
  const swiped = await page.eval('return window.__menuLog;');
  check('a three-finger swipe left/right sends next-ws/prev-ws to the window, up/down send nothing', j(swiped) === j(['next-ws', 'prev-ws']), j(swiped));
  await page.eval('window.__menuLog = window.__menuLogAll; return true;');
  const alive = await page.eval('return window.__noReload === 1;');
  check('Reload Page (Command+R) did not reload the app', alive && navs.length === 0, `marker kept: ${alive}, main-frame navigations: ${j(navs)}`);

  // ---------- pop-out window ----------
  const st = await page.eval('return window.__flow.state();');
  const ws0 = st.ws[0];
  const zone = (ws0.zones && ws0.zones[0] && ws0.zones[0].id) || '';
  const hash = zone ? `solo=${ws0.id}&zone=${zone}` : `solo=${ws0.id}`;
  await page.eval(`window.flow.openWindow(${j(hash)}); return true;`);
  const pop = await L.flowPage((t) => t.type === 'page' && t.url.includes('#solo='));
  const popInfo = await pop.eval('return { hash: location.hash, windows: window.__flow.windows().length, title: document.title };');
  check('openWindow opens another Flow window on index.html#<hash>', popInfo.hash === '#' + hash, j(popInfo));
  const bw = await mainp.eval('const { BrowserWindow } = require("electron"); return BrowserWindow.getAllWindows().length;', { commandLine: true });
  check('two BrowserWindows exist', bw === 2, String(bw));
  await pop.eval('window.__menuLog = []; window.flow.onMenu((a) => window.__menuLog.push(a)); return true;');
  await mainp.eval(`const { Menu, BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#solo='));
    w.focus(); const find = (m) => { for (const i of m.items) { if (i.label === 'Find') return i; if (i.submenu) { const f = find(i.submenu); if (f) return f; } } return null; };
    find(Menu.getApplicationMenu()).click({}, w, w.webContents); return true;`, { commandLine: true });
  await L.waitFor(() => pop.eval('return window.__menuLog.length ? window.__menuLog : null;'), 5000, 'the menu action in the pop-out').catch(() => []);
  await L.sleep(500);
  const popGot = await pop.eval('return window.__menuLog;');
  const mainGot = await page.eval('return window.__menuLog.length;');
  check('a menu action goes to the window it was invoked for (the pop-out), not the main window', j(popGot) === j(['find']) && mainGot === actions.length, `pop-out ${j(popGot)}, main log length ${mainGot}`);
  await mainp.eval('const { BrowserWindow } = require("electron"); BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("#solo=")).close(); return true;', { commandLine: true });
  pop.close();
  await L.waitFor(async () => !(await L.targets(L.PORT)).some((t) => t.type === 'page' && t.url.includes('#solo=')), 10000, 'the pop-out to close');
  check('closing the pop-out leaves the main window running', (await mainp.eval('return require("electron").BrowserWindow.getAllWindows().length;', { commandLine: true })) === 1);

  // ---------- breakPane / joinPane on real tmux panes ----------
  const opened = await page.eval('return await window.flow.term.open({ id: "bjteam", cmd: "shell", cwd: "/tmp", cols: 120, rows: 40 });');
  check('a shell team session opens', opened.ok, j(opened));
  L.tmux('split-window', '-d', '-t', '=flow_bjteam:', '-c', '/tmp');
  const p2 = await page.eval('return await window.flow.term.panes("bjteam");');
  const moved = p2.find((p) => !p.active) || p2[1];
  L.tmux('send-keys', '-t', moved.paneId, 'echo BJ_MARK_$((6*7))', 'Enter');
  await L.sleep(800);
  const br = await page.eval(`return await window.flow.term.breakPane("bjteam", ${j(moved.paneId)}, "bjbroke");`);
  const afterBreakTeam = await page.eval('return (await window.flow.term.panes("bjteam")).map((p) => p.paneId);');
  const brokePanes = await page.eval('return (await window.flow.term.panes("bjbroke")).map((p) => p.paneId);');
  const brokeText = L.tmux('capture-pane', '-p', '-t', moved.paneId);
  check('breakPane moves the pane into flow_<newId> with its process', br.ok && j(brokePanes) === j([moved.paneId]) && afterBreakTeam.length === 1 && !afterBreakTeam.includes(moved.paneId) && brokeText.includes('BJ_MARK_42'),
    `${j(br)} team ${j(afterBreakTeam)} new ${j(brokePanes)}`);
  const jn = await page.eval('return await window.flow.term.joinPane("bjbroke", "bjteam");');
  const afterJoin = await page.eval('return (await window.flow.term.panes("bjteam")).map((p) => p.paneId);');
  const brokeGone = await page.eval('return !(await window.flow.term.exists("bjbroke"));');
  check('joinPane moves it back into the team and the empty session ends', jn.ok && afterJoin.length === 2 && afterJoin.includes(moved.paneId) && brokeGone, `${j(jn)} team ${j(afterJoin)} bjbroke gone ${brokeGone}`);
  const sameMark = L.tmux('capture-pane', '-p', '-t', moved.paneId).includes('BJ_MARK_42');
  check('the moved pane keeps its screen across break and join', sameMark);
  await page.eval('await window.flow.term.kill("bjteam"); return true;');

  // ---------- state round trip across a full restart ----------
  const marker = `https://example.com/?flow-roundtrip=${Date.now()}`;
  const markerWin = await page.eval(`return window.__flow.openPage(${j(marker)});`);
  // The page's title becomes the note's title once it loads; saves are debounced (150 ms): wait for both.
  await L.waitFor(() => page.eval(`const p = window.__flow.page(${j(markerWin)}); return !!p && !p.isLoading() && p.getTitle() !== '';`), 30000, 'the marker page to load')
    .catch((e) => info('marker page', e.message));
  let before = null;
  let lastDiff = [];
  await L.waitFor(async () => {
    const st = await page.eval('return window.__flow.state();');
    const { bounds: _b, ...diskDoc } = JSON.parse(fs.readFileSync(path.join(L.USER_DATA, 'flow-state.json'), 'utf8'));
    lastDiff = diffPaths(st, diskDoc);
    if (lastDiff.length) return false;
    before = st;
    return true;
  }, 5000, 'flow-state.json to match the renderer').catch(() => null);
  check('flow-state.json holds the renderer document', !!before, j(lastDiff.slice(0, 5)));
  before = before || await page.eval('return window.__flow.state();');
  const winBounds = await mainp.eval('return require("electron").BrowserWindow.getAllWindows()[0].getBounds();', { commandLine: true });
  const termsBefore = sessionTimes();
  const clientsBefore = [...new Set(L.tmux('list-clients', '-F', '#{client_session}').split('\n').filter(Boolean))];
  const shellPaths = new Map(L.tmux('list-sessions', '-F', '#{session_name}\t#{pane_current_path}').split('\n').filter(Boolean).map((l) => l.split('\t')));
  page.close();
  await quitApp(mainp);
  const termsAfterQuit = sessionTimes();
  check('quitting keeps the tmux sessions', Object.keys(termsBefore).length > 0 && Object.keys(termsBefore).every((k) => termsAfterQuit[k] === termsBefore[k]), `${j(Object.keys(termsBefore))} -> ${j(Object.keys(termsAfterQuit))}`);
  // the exiting main process can hold its sockets a moment after pgrep stops listing it
  const portFree = await L.waitFor(() => listeners(L.PORT) === '', 5000, 'the DevTools port to close').then(() => true, () => false);
  check('after the quit nothing listens on the DevTools port', portFree, listeners(L.PORT));
  const tmuxAfterQuit = L.tmux('display-message', '-p', '#{pid}');
  check('the surviving tmux server holds none of Electron\'s files', electronFiles(fdsOf(tmuxAfterQuit)).length === 0, `${fdsOf(tmuxAfterQuit).length} fds`);
  const { bounds: savedBounds, ...savedDoc } = JSON.parse(fs.readFileSync(path.join(L.USER_DATA, 'flow-state.json'), 'utf8'));
  check('the quit wrote the window bounds', !!savedBounds && j(box(savedBounds)) === j(winBounds) && savedBounds.maximized === false, `saved ${j(savedBounds)}, window was ${j(winBounds)}`);
  const quitDiff = diffPaths(before, savedDoc);
  // The quit's flush reads where each local shell is from tmux (app.js keepShellFolders), so its saved folder is tmux's.
  const shellRead = (d) => {
    const m = /^\$\.ws\.(\d+)\.windows\.(\d+)\.cwd: /.exec(d);
    const w = m && before.ws[m[1]].windows[m[2]];
    const s = m && savedDoc.ws[m[1]] && savedDoc.ws[m[1]].windows[m[2]];
    return !!w && !!s && w.cmd === 'shell' && !w.host && s.id === w.id && s.cwd === shellPaths.get(`flow_${w.id}`);
  };
  const quitOff = quitDiff.filter((d) => !live(d) && !shellRead(d));
  info('shells\' folders the quit read from tmux', quitDiff.filter(shellRead).join(' | ') || 'none changed');
  check('the document on disk after the quit is the one the renderer had (terminal titles, tab history and the shells\' folders as tmux has them aside)', quitOff.length === 0, quitOff.slice(0, 8).join(' | '));
  const markerSaved = savedDoc.ws.flatMap((w) => w.windows).find((w) => w.id === markerWin);
  const savedHist = markerSaved && markerSaved.tabs && markerSaved.tabs[0] && markerSaved.tabs[0].history;
  check('the marker page\'s tab was saved with its history', !!savedHist && savedHist.entries.some((e) => e.url === marker), j(savedHist && savedHist.entries.map((e) => e.url)));

  L.launch(LOG, APP_ENV);
  page = await L.flowPage();
  mainp = await L.mainProcess();
  const loaded = await page.eval('return await window.flow.loadState();');
  const after = await page.eval('return window.__flow.state();');
  const loadDiff = diffPaths(savedDoc, loaded || {});
  check('loadState after the restart returns the saved document without main\'s bounds key', !!loaded && !('bounds' in loaded) && loadDiff.filter((d) => !live(d)).length === 0, loadDiff.filter((d) => !live(d)).slice(0, 8).join(' | '));
  const diff = diffPaths(savedDoc, after);
  check('the whole state document survives a full restart', diff.filter((d) => !live(d)).length === 0 && after.ws.some((w) => w.notes.some((n) => n.url === marker)), diff.filter((d) => !live(d)).slice(0, 8).join(' | '));
  if (diff.some(live)) info('terminal titles that changed since the quit', diff.filter(live).join(' | '));
  const relaunchBounds = await mainp.eval('return require("electron").BrowserWindow.getAllWindows()[0].getBounds();', { commandLine: true });
  check('the relaunched window has the saved bounds', j(relaunchBounds) === j(box(savedBounds)), `${j(relaunchBounds)} vs saved ${j(savedBounds)}`);
  await L.sleep(4000);
  const termsAfter = sessionTimes();
  const reattached = Object.keys(termsBefore).filter((k) => termsAfter[k] === termsBefore[k]);
  const clients = L.tmux('list-clients', '-F', '#{client_session}').split('\n').filter(Boolean);
  check('agent windows reattach to the same tmux sessions after the restart', Object.keys(termsBefore).length > 0 && reattached.length === Object.keys(termsBefore).length &&
    clientsBefore.length > 0 && clientsBefore.every((x) => clients.includes(x)),
    `same sessions ${reattached.length}/${Object.keys(termsBefore).length}, clients before ${j(clientsBefore)}, after ${j([...new Set(clients)])}`);
  check('the relaunched window has tmux clients attached again', clients.length > 0, j(clients));

  page.close();
  await quitApp(mainp);
}

let crashed = null;
try {
  await run();
} catch (e) {
  crashed = e;
  console.log(`FAIL the run stopped: ${e.stack || e.message}`);
  failed++;
} finally {
  server.close();
  cleanup();
  fs.rmSync(BIN, { recursive: true, force: true });
}
const logText = fs.readFileSync(LOG, 'utf8');
check('the app log is this run\'s (it holds the quit lines)', /^\[flow\] quit: /m.test(logText));
check('the app never mentioned claude-agents (no VM window was opened)', !/claude-agents/.test(logText));
check('Electron logged no error about a preload path (the sign-in popups)', !/preload script must have absolute path/.test(logText));
check('no second session index was opened (the fresh copy above stopped)', !/already open in this process/.test(logText));
const errors = logText.split('\n').filter((l) => /^\[flow renderer|^\[flow\]|Error occurred in handler|DeprecationWarning|\(electron\)/.test(l));
info('main-process log lines', `${errors.length}`);
for (const l of errors.slice(0, 15)) console.log(`  log: ${l}`);
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);




