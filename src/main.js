'use strict';
// Flow main process (BRIEF 2.6, 2.7): windows, menu, webview hardening, IPC for window.flow.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, protocol, screen, session, shell, systemPreferences, webContents } = require('electron');

const ROOT = path.join(__dirname, '..');
const HOME = os.homedir();

if (process.env.FLOW_USER_DATA) {
  const dir = path.resolve(process.env.FLOW_USER_DATA);
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
}
if (process.env.FLOW_CDP_PORT) app.commandLine.appendSwitch('remote-debugging-port', String(process.env.FLOW_CDP_PORT));
const SOCKET = process.env.FLOW_TMUX_SOCKET || 'flow';
const ENTRY = process.env.FLOW_ENTRY ? path.resolve(ROOT, process.env.FLOW_ENTRY) : path.join(__dirname, 'index.html');
// Test runs on a Mac where the owner works in the installed Flow: no window takes focus.
const BACKGROUND = process.env.FLOW_BACKGROUND === '1';

// Pages keep the agent string Electron gives them. Rewriting it to a plain Chrome one is what Google has been refusing:
// a Chrome-only agent claims to be real Chrome, so Google checks every client hint against it and finds a mismatch. The
// Electron engine's own agent passes, and with the Chrome brand added to Chromium's hint list it goes to the human check
// instead of "This browser or app may not be secure" (measured on the Mac, Nov 7).
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const CHROME_PLATFORM = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
  : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
const CHROME_UA = `Mozilla/5.0 (${CHROME_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
// What Electron itself sends: the real engine version and the Electron token, not the shortened "156.0.0.0".
const CHROME_EXACT_UA = `Mozilla/5.0 (${CHROME_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Electron/${process.versions.electron} Safari/537.36`;
app.userAgentFallback = CHROME_EXACT_UA;

const quoteHint = (value) => JSON.stringify(String(value ?? ''));
const brandHint = (list) => list.map(({ brand, version }) => `${quoteHint(brand)};v=${quoteHint(version)}`).join(', ');
const CHROME_ARCHITECTURES = {
  arm: { architecture: 'arm', bitness: '32' },
  arm64: { architecture: 'arm', bitness: '64' },
  ia32: { architecture: 'x86', bitness: '32' },
  x64: { architecture: 'x86', bitness: '64' },
};
// Google reads a UA without a "Google Chrome" brand (Electron's own "Not:A-Brand", "Chromium") as a browser embedded in
// another app and refuses sign-in, so both brand lists carry the Chrome brand. A guest webview is built from
// webPreferences and never takes the session UA, so this same metadata goes on each guest (chromeGuestIdentity below).
const CHROME_BRANDS = [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: CHROME_MAJOR }, { brand: 'Google Chrome', version: CHROME_MAJOR }];
const CHROME_FULL_BRANDS = [{ brand: 'Not:A-Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: process.versions.chrome }, { brand: 'Google Chrome', version: process.versions.chrome }];
function chromeHints() {
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const platformVersion = process.platform === 'darwin' && typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
  const cpu = CHROME_ARCHITECTURES[process.arch];
  if (!cpu) throw new Error(`[flow] cannot describe Chromium architecture ${process.arch}`);
  return {
    low: {
      'Sec-CH-UA': brandHint(CHROME_BRANDS),
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': quoteHint(platform),
    },
    high: {
      'Sec-CH-UA-Arch': quoteHint(cpu.architecture),
      'Sec-CH-UA-Bitness': quoteHint(cpu.bitness),
      'Sec-CH-UA-Full-Version': quoteHint(process.versions.chrome),
      'Sec-CH-UA-Full-Version-List': brandHint(CHROME_FULL_BRANDS),
      'Sec-CH-UA-Model': '""',
      'Sec-CH-UA-WoW64': '?0',
      'Sec-CH-UA-Form-Factors': '"Desktop"',
      'Sec-CH-UA-Platform-Version': quoteHint(platformVersion),
    },
  };
}

const BG = '#0b0b0d';
const DEFAULT_SIZE = { width: 1500, height: 940 };
const POPOUT_SIZE = { width: 1280, height: 820 };

const pty = require('./pty');
const sessions = require('./sessions');
const files = require('./files-main');
const vmfiles = require('./vmfiles');
const touch = require('./touch');
// Before ready, and only once for every scheme: pages open a workspace's files at flow-file: addresses.
protocol.registerSchemesAsPrivileged([files.privileges]);
const { Store } = require('./store');

const flowContents = new Set();   // webContents ids of Flow windows (the only trusted IPC senders)
const mainContents = new Set();   // those of them that are the main window (not a pop-out)
const windowLabels = new WeakMap();   // BrowserWindow -> 'main' or its pop-out hash, for the FLOW_BACKGROUND log lines
const popouts = new Map();   // open pop-out BrowserWindow -> { hash, bounds }, kept in the state file to reopen them
let quitting = false;        // set by before-quit: pop-outs closing on the way out stay on that list
let store = null;

function flowWindows() {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && flowContents.has(w.webContents.id));
}

// ---------- state ----------

function broadcastState(doc, exceptId) {
  for (const w of flowWindows()) {
    if (w.webContents.id !== exceptId) w.webContents.send('state:changed', doc);
  }
}

function reportCorruptState(backup, err) {
  const show = () => dialog.showMessageBox({
    type: 'warning',
    message: 'flow could not read its saved state',
    detail: `${err.message}\n\nthe unreadable file was kept at ${backup}. flow starts fresh.`,
  });
  if (app.isReady()) show();
  else app.whenReady().then(show);
}

// ---------- windows ----------

function onScreen(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false;
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 200 && h >= 120;
  });
}

function fitSize(size, near) {
  const area = (near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()).workArea;
  return { width: Math.min(size.width, area.width), height: Math.min(size.height, area.height), area };
}

function windowFrame(primary, saved) {
  const kept = (s) => ({ x: s.x, y: s.y, width: s.width, height: s.height, maximized: !!s.maximized, fullScreen: !!s.fullScreen });
  if (!primary && onScreen(saved)) return kept(saved);
  if (primary) {
    const saved = store.getBounds();
    if (onScreen(saved)) return kept(saved);
    const { width, height, area } = fitSize(DEFAULT_SIZE);
    return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
  }
  const from = BrowserWindow.getFocusedWindow() || flowWindows()[0];
  const near = from ? from.getBounds() : null;
  const { width, height, area } = fitSize(POPOUT_SIZE, near);
  const x = near ? Math.min(near.x + 36, area.x + area.width - width) : area.x + Math.round((area.width - width) / 2);
  const y = near ? Math.min(near.y + 36, area.y + area.height - height) : area.y + Math.round((area.height - height) / 2);
  return { x, y, width, height };
}

// e2e reads these lines to prove FLOW_BACKGROUND never focuses or hides a window.
const shownAt = new WeakMap();   // BrowserWindow -> when showInBackground showed it
function showInBackground(win) {
  win.showInactive();
  shownAt.set(win, Date.now());
  console.log(`[flow] background: ${windowLabels.get(win)} shown inactive, isFocused=${win.isFocused()}`);
}

const callerStack = () => String(new Error().stack).split('\n').slice(2).map((l) => l.trim().replace(/^at /, '')).join(' < ');

// A JS caller that focused the window synchronously (focus(), show(), ...) appears in the stack below the emit frame.
function logBackgroundFocus(win) {
  const shown = shownAt.get(win);
  const fc = webContents.getFocusedWebContents();
  console.log(`[flow] background: ${windowLabels.get(win)} got focus; ${shown ? `${Date.now() - shown} ms after it was shown` : 'before it was shown'}, ` +
    `focused contents ${fc ? `${fc.getType()} ${fc.id}` : 'none'}, stack: ${callerStack()}`);
}

// Calls that can activate a window, logged with their caller: a 'focus' the OS delivers later (always on Linux)
// carries no JS stack of its own. A window hidden by a hide() call is marked, so a 'hide' from macOS can be told apart.
const hideCalled = new WeakSet();   // windows a hide() call hid, until they show again
if (BACKGROUND) {
  const hide = BrowserWindow.prototype.hide;
  BrowserWindow.prototype.hide = function (...args) {
    hideCalled.add(this);
    return hide.apply(this, args);
  };
  for (const [owner, name] of [[BrowserWindow.prototype, 'focus'], [BrowserWindow.prototype, 'show'], [BrowserWindow.prototype, 'moveTop'],
    [BrowserWindow.prototype, 'restore'], [app, 'focus'], [app, 'show']]) {
    const original = owner[name];
    if (typeof original !== 'function') continue;
    owner[name] = function (...args) {
      console.log(`[flow] background: ${owner === app ? 'app' : windowLabels.get(this)} ${name}() called; stack: ${callerStack()}`);
      return original.apply(this, args);
    };
  }
}

function savePopouts(now) {
  store.setPopouts([...popouts.values()].map(({ hash, bounds, maximized, fullScreen }) => ({ hash, bounds, ...(maximized ? { maximized } : {}),
    ...(fullScreen ? { fullScreen } : {}) })), now);
}

// The spaces open in pop-outs, { ws, zone } each (zone null for a whole workspace), sent to every Flow window when one
// opens or closes: a popped-out space lives only in its pop-out, and the main window shows it as in another window.
function spaceOf(hash) {
  const q = new URLSearchParams(hash);
  return q.get('solo') ? { ws: q.get('solo'), zone: q.get('zone') || null } : null;
}

function workspaceOfContents(id) {
  for (const [win, { hash }] of popouts) {
    if (win.isDestroyed() || win.webContents.id !== id) continue;
    const space = spaceOf(hash);
    return space ? space.ws : null;
  }
  return null;
}

function openSpaces() {
  return [...popouts.entries()].filter(([w]) => !w.isDestroyed()).map(([, { hash }]) => spaceOf(hash)).filter(Boolean);
}

function openSpaceFrames() {
  return [...popouts.entries()].filter(([w]) => !w.isDestroyed()).map(([w, entry]) => {
    const space = spaceOf(entry.hash);
    if (!space) return null;
    const bounds = w.isMinimized() ? entry.bounds : w.getNormalBounds();
    return { ...space, frame: { ...bounds, maximized: w.isMaximized(), fullScreen: w.isFullScreen() } };
  }).filter(Boolean);
}

function popoutOf(space) {
  return [...popouts.entries()].find(([w, { hash }]) => {
    const s = !w.isDestroyed() && spaceOf(hash);
    return s && s.ws === space.ws && s.zone === space.zone;
  })?.[0] || null;
}

function sendPopouts() {
  const list = openSpaces();
  for (const w of flowWindows()) w.webContents.send('popouts:changed', list);
}

function bringForward(win) {
  if (BACKGROUND) {
    showInBackground(win);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// primary: the main Flow window (its frame is remembered). Pop-outs from openWindow are not primary; they are
// remembered with their bounds until the user closes them (savedBounds: where a restored pop-out was).
function createWindow(hash, primary, savedBounds) {
  const frame = windowFrame(primary, savedBounds);
  const win = new BrowserWindow({
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Flow',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 10 },
    backgroundColor: BG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  const wc = win.webContents;
  const wcId = wc.id;
  flowContents.add(wcId);
  if (primary) mainContents.add(wcId);
  if (frame.maximized) win.maximize();
  // Not when Flow starts in the background: full screen would take the owner's screen. It stays remembered for the next
  // start until the window itself enters or leaves full screen.
  if (frame.fullScreen && !BACKGROUND) win.setFullScreen(true);
  let heldFull = frame.fullScreen && BACKGROUND;
  for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => { heldFull = false; });
  const fullNow = () => win.isFullScreen() || heldFull;

  windowLabels.set(win, primary ? 'main' : hash);
  touch.watch(win);
  if (BACKGROUND) {
    win.on('focus', () => logBackgroundFocus(win));
    // A 'hide' no hide() call made came from macOS, not from Flow's code.
    win.on('hide', () => console.log(hideCalled.has(win) ? `[flow] background: ${windowLabels.get(win)} hidden`
      : `[flow] background: ${windowLabels.get(win)} out of sight per macOS (Flow did not hide it)`));
    win.on('show', () => hideCalled.delete(win));
  }
  // macOS three-finger swipe; it only fires with Trackpad > More Gestures > Swipe between pages set to two or three fingers.
  // With the touches streaming (touch.js) nav has the gesture already, and this would switch once more.
  win.on('swipe', (_event, direction) => {
    if (touch.live(win)) return;
    if (direction === 'left') sendMenu('next-ws', win);
    else if (direction === 'right') sendMenu('prev-ws', win);
  });
  // Once: a page that paints after the fallback below showed it must not show it again (show() brings Flow forward).
  let revealed = false;
  const reveal = () => {
    if (revealed || leaving.has(win)) return;
    revealed = true;
    if (BACKGROUND) showInBackground(win);
    else win.show();
  };
  win.once('ready-to-show', () => reveal());
  // A window whose page never paints still has to appear, so its errors can be seen.
  const showAnyway = setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) reveal(); }, 4000);
  win.once('show', () => clearTimeout(showAnyway));

  wc.on('context-menu', (_event, params) => textMenu(wc, params));
  // Nothing may navigate a Flow window away from Flow (a dropped file, a stray link): that would
  // destroy every live terminal and page in it.
  wc.on('will-navigate', (event, url) => {
    event.preventDefault();
    console.warn(`[flow] blocked navigation of a Flow window to ${url}`);
  });
  wc.setWindowOpenHandler(({ url }) => {
    console.warn(`[flow] blocked window.open from a Flow window: ${url}`);
    return { action: 'deny' };
  });
  // A reload or crash replaces the page: its tmux clients belong to the old page.
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    pty.detachAll(wcId);
    unsavedShown.delete(wcId);
    forgetFlush(wcId);
  });
  wc.on('render-process-gone', (_event, details) => {
    console.error(`[flow] renderer of window ${wcId} is gone (${details.reason}, exit ${details.exitCode})`);
    pty.detachAll(wcId);
  });
  wc.on('console-message', (event) => {
    if (event.level !== 'error') return;
    console.error(`[flow renderer ${wcId}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  wc.on('destroyed', () => {
    flowContents.delete(wcId);
    mainContents.delete(wcId);
    unsavedShown.delete(wcId);
    if (store) store.forget(wcId);
    forgetFlush(wcId);
    pty.detachAll(wcId);
  });
  let asking = false;
  win.on('close', (event) => {
    if (quitReady || quitAnyway || closeNow.has(win) || (!unsavedShown.has(wcId) && !flushShown.has(wcId))) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    (async () => {
      if (!closeAnyway.has(win) && !(await mayClose([win], 'close'))) return false;
      leaveScreen(win);
      await flushPagesOf([win]);
      return true;
    })().then((go) => {
      asking = false;
      if (!go || win.isDestroyed()) return;
      closeNow.add(win);
      win.close();
    }, (e) => {
      asking = false;
      console.error(`[flow] could not ask window ${wcId} before closing it, closing: ${e.message}`);
      closeNow.add(win);
      if (!win.isDestroyed()) win.close();
    });
  });

  if (primary) {
    let timer = null;
    const remember = () => {
      if (win.isDestroyed() || win.isMinimized() || leaving.has(win)) return;
      store.setBounds({ ...win.getNormalBounds(), maximized: win.isMaximized(), ...(fullNow() ? { fullScreen: true } : {}) });
    };
    readFrame.set(win, remember);
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(remember, 400);
    };
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, later);
    win.on('close', () => {
      clearTimeout(timer);
      remember();
    });
  } else {
    const entry = { hash, bounds: win.getNormalBounds() };
    popouts.set(win, entry);
    savePopouts(true);
    sendPopouts();
    let timer = null;
    const remember = () => {
      if (win.isDestroyed() || win.isMinimized() || leaving.has(win)) return;
      entry.bounds = win.getNormalBounds();
      entry.maximized = win.isMaximized();
      entry.fullScreen = fullNow();
    };
    readFrame.set(win, remember);
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        remember();
        savePopouts(false);
      }, 400);
    };
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, later);
    win.on('close', () => {
      clearTimeout(timer);
      remember();
    });
    win.on('closed', () => {
      if (!quitting) popouts.delete(win);
      savePopouts(true);
      sendPopouts();
    });
  }

  win.loadFile(ENTRY, hash ? { hash } : {}).catch((e) => console.error(`[flow] could not load ${ENTRY}: ${e.message}`));
  return win;
}

// ---------- menu ----------

const isFlowWindow = (w) => !!w && !w.isDestroyed() && flowContents.has(w.webContents.id);

const EDITS = { 'select-all': 'selectAll', undo: 'undo', redo: 'redo' };   // menu actions a page or a plain window does itself
function sendMenu(action, win) {
  // a page that has the keys selects, undoes and redoes in itself
  const fc = EDITS[action] && webContents.getFocusedWebContents();
  if (fc && fc.getType() === 'webview') {
    fc[EDITS[action]]();
    return;
  }
  // A sign-in popup is a plain window: ⌘W closes it and the edits act in it, every other action goes to a Flow window.
  if (win && !win.isDestroyed() && !isFlowWindow(win) && (action === 'close-window' || EDITS[action])) {
    if (action === 'close-window') win.close();
    else win.webContents[EDITS[action]]();
    return;
  }
  const focused = BrowserWindow.getFocusedWindow();
  const target = isFlowWindow(win) ? win : isFlowWindow(focused) ? focused : flowWindows()[0];
  if (target) {
    target.webContents.send('menu', action);
    return;
  }
  if (action === 'close-window') return;
  const fresh = createWindow('', true);
  fresh.webContents.once('did-finish-load', () => fresh.webContents.send('menu', action));
}

function buildMenu() {
  const act = (label, action, accelerator) => ({ label, accelerator, click: (_item, win) => sendMenu(action, win) });
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        act('New Agent', 'new-agent', 'Command+N'),
        act('New Shell', 'new-shell', 'Alt+Command+T'),
        act('New Team', 'new-team', 'Alt+Command+N'),
        act('New Note', 'new-note', 'Shift+Command+N'),
        act('New Page', 'new-page-window', 'Alt+Command+P'),
        act('New Sub-workspace', 'new-zone'),
        { type: 'separator' },
        act('New Tab', 'new-page', 'Command+T'),
        { label: 'New Beside', submenu: [
          act('Right', 'beside-right', 'Control+Command+Right'),
          act('Left', 'beside-left', 'Control+Command+Left'),
          act('Above', 'beside-above', 'Control+Command+Up'),
          act('Below', 'beside-below', 'Control+Command+Down'),
        ] },
        act('New Workspace', 'new-workspace', 'Control+Command+N'),
        { type: 'separator' },
        act('Reopen Closed Tab', 'tab-reopen', 'Shift+Command+T'),
        act('Close Window', 'close-window', 'Command+W'),
        { type: 'separator' },
        act('Print…', 'page-print', 'Command+P'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        act('Undo', 'undo', 'Command+Z'),
        act('Redo', 'redo', 'Shift+Command+Z'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        act('Select All', 'select-all', 'Command+A'),
        { type: 'separator' },
        act('Find', 'find', 'Command+F'),
        act('Search', 'search', 'Command+K'),
      ],
    },
    {
      label: 'View',
      submenu: [
        act('Toggle Sidebar', 'toggle-sidebar', 'Command+\\'),
        act('Arrange', 'arrange', 'Control+Command+A'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools', accelerator: 'Alt+Command+I', visible: false },
      ],
    },
    {
      label: 'Page',
      submenu: [
        act('Reload Page', 'reload-page', 'Command+R'),
        act('Back', 'page-back', 'Command+['),
        act('Forward', 'page-forward', 'Command+]'),
        { type: 'separator' },
        act('Next Tab', 'tab-next', 'Shift+Command+]'),
        { ...act('Next Tab', 'tab-next', 'Control+Tab'), visible: false },
        act('Previous Tab', 'tab-prev', 'Shift+Command+['),
        { ...act('Previous Tab', 'tab-prev', 'Control+Shift+Tab'), visible: false },
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ ...act(`Tab ${k}`, `tab-${k}`, `Command+${k}`), visible: false })),
        { ...act('Last Tab', 'tab-last', 'Command+9'), visible: false },
        { type: 'separator' },
        act('Zoom In', 'page-zoom-in', 'Command+Plus'),
        { ...act('Zoom In', 'page-zoom-in', 'Command+='), visible: false },   // ⌘+ without Shift, as in Chrome
        act('Zoom Out', 'page-zoom-out', 'Command+-'),
        act('Actual Size', 'page-zoom-reset', 'Command+0'),
        { type: 'separator' },
        act('Focus Address', 'focus-address', 'Command+L'),
        act('Save Page', 'save-page', 'Command+D'),
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Close', accelerator: 'Shift+Command+W', click: (_item, win) => { if (win) win.close(); } },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- webviews ----------

function sendNewWindow(guest, url, disposition) {
  const host = !guest.isDestroyed() && guest.hostWebContents;
  if (!host || host.isDestroyed()) {
    console.warn(`[flow] a page asked to open ${url} but its window is gone`);
    return;
  }
  host.send('page:new-window', { url, disposition, guestId: guest.id });
}

// Text in Flow itself (a note, a title, the address bar, search, a terminal's selection): the Mac's text menu, spelling
// first. app.js shows its own menus elsewhere, so this comes only where app.js leaves the right-click to Chromium.
function textMenu(wc, params) {
  const flags = params.editFlags || {};
  if (!params.isEditable && !(params.selectionText && params.selectionText.trim())) return;
  const items = [];
  if (params.isEditable && params.misspelledWord) {
    for (const word of (params.dictionarySuggestions || []).slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    if (!items.length) items.push({ label: 'No Spelling Suggestions', enabled: false });
    items.push({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
  }
  if (params.isEditable) items.push({ label: 'Cut', enabled: !!flags.canCut, click: () => wc.cut() });
  items.push({ label: 'Copy', enabled: !!flags.canCopy, click: () => wc.copy() });
  if (params.isEditable) items.push({ label: 'Paste', enabled: !!flags.canPaste, click: () => wc.paste() });
  const win = BrowserWindow.fromWebContents(wc);
  if (win) Menu.buildFromTemplate(items).popup({ window: win });
}

function guestContextMenu(guest, params) {
  const nav = guest.navigationHistory;
  const flags = params.editFlags || {};
  const items = [];
  // Spelling first, as in Chrome: Chromium's suggestions for the misspelled word under the pointer.
  if (params.misspelledWord) {
    for (const word of (params.dictionarySuggestions || []).slice(0, 5)) items.push({ label: word, click: () => guest.replaceMisspelling(word) });
    if (!items.length) items.push({ label: 'No Spelling Suggestions', enabled: false });
    items.push({ label: 'Add to Dictionary', click: () => guest.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
  }
  items.push(
    { label: 'Back', enabled: nav.canGoBack(), click: () => navigatePage(guest, () => nav.goBack()) },
    { label: 'Forward', enabled: nav.canGoForward(), click: () => navigatePage(guest, () => nav.goForward()) },
    { label: 'Reload', click: () => navigatePage(guest, () => guest.reload()) },
    { type: 'separator' },
  );
  if (params.isEditable) items.push({ label: 'Cut', enabled: !!flags.canCut, click: () => { touched.add(guest.id); guest.cut(); } });
  items.push(
    { label: 'Copy', enabled: !!flags.canCopy, click: () => guest.copy() },
    { label: 'Paste', enabled: params.isEditable && !!flags.canPaste, click: () => { touched.add(guest.id); guest.paste(); } },
    { label: 'Select All', enabled: flags.canSelectAll !== false, click: () => guest.selectAll() },
  );
  // The selection may sit where the page's own script cannot read it (Chromium's PDF viewer, cross-origin frames).
  if (params.selectionText && params.selectionText.trim()) {
    items.push({ label: 'Clip to Note', click: () => {
      const host = guest.hostWebContents;
      if (host && !host.isDestroyed()) host.send('page:clip', { guestId: guest.id, text: params.selectionText });
    } });
  }
  if (params.linkURL) {
    items.push(
      { type: 'separator' },
      { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL).catch((e) => console.error(`[flow] could not copy the link: ${e.message}`)) },
      { label: 'Open Link in New Page', click: () => sendNewWindow(guest, params.linkURL, 'new-page') },
    );
  }
