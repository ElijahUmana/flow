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
  if (params.mediaType === 'image' && /^(https?|data):/i.test(params.srcURL || '')) {
    items.push(
      { type: 'separator' },
      { label: 'Open Image in New Page', enabled: /^https?:/i.test(params.srcURL), click: () => sendNewWindow(guest, params.srcURL, 'new-page') },
      { label: 'Copy Image', click: () => guest.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL).catch((e) => console.error(`[flow] could not copy the image address: ${e.message}`)) },
      { label: 'Save Image', click: () => guest.downloadURL(params.srcURL) },
    );
  }
  items.push({ type: 'separator' }, { label: 'Inspect', click: () => guest.inspectElement(params.x, params.y) });
  const host = guest.hostWebContents;
  const win = host ? BrowserWindow.fromWebContents(host) : null;
  Menu.buildFromTemplate(items).popup(win ? { window: win, frame: params.frame } : { frame: params.frame });
}

// A page opens a page, a window or another app only from the owner's own action, as a browser's popup blocker allows:
// within ACTIVATION_MS of a click or key in it or in any frame of it (input main sees on its way in, which the page
// cannot make), once per action; a new document starts without one. Anything else is dropped, with no sign in the
// window (logged at most once a minute per page).
const ACTIVATION_MS = 5000;
const ACTIVATING = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'touchEnd', 'gestureTap']);
const activatedAt = new WeakMap();   // webContents -> when the owner last clicked or pressed a key in it
const droppedLogAt = new WeakMap();   // webContents -> when a dropped open of it was last logged

// The pages the owner has edited text in since they loaded (the guest preload says so at the first trusted input event,
// and an editing key into a frame of another site, which the preload cannot see, counts too): only these can hold unsaved
// text of the owner's, so a close or a quit asks only these, and a window with none goes at once.
const touched = new Set();   // webContents ids
const EDIT_KEYS = new Set(['Backspace', 'Delete', 'Enter', 'Process', 'Dead']);
const edits = (input) => (input.meta || input.control ? /^[vxz]$/i.test(input.key) : input.key.length === 1 || EDIT_KEYS.has(input.key));

// input-event sees input into the page itself, the before-* events also into frames of other sites inside it; each
// misses some of what the other sees.
function trackActivation(wc) {
  const id = wc.id;
  wc.once('destroyed', () => touched.delete(id));
  wc.on('input-event', (_event, input) => {
    if (ACTIVATING.has(input.type)) activatedAt.set(wc, Date.now());
  });
  wc.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') activatedAt.set(wc, Date.now());
  });
  wc.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key !== 'Escape') activatedAt.set(wc, Date.now());
    if (edits(input)) touched.add(id);
  });
  wc.on('did-navigate', () => {
    activatedAt.delete(wc);
    touched.delete(id);
  });
}

function takeActivation(wc) {
  const at = activatedAt.get(wc);
  if (!at || Date.now() - at > ACTIVATION_MS) return false;
  activatedAt.delete(wc);
  return true;
}

// window.open with features (a sign-in popup) or of about:blank (a window the page points somewhere next) stays a real
// popup, because sign-in flows (Notion's, Figma's "Continue with Google") need window.opener. Links (a shift-click is
// 'new-window' too, with no features) and a plain window.open open as Flow pages. Whatever a popup opens follows the
// same rule; its pages go to the opener's window. from: the page or popup asking.
function openFromPage(guest, { url, disposition, features }, from) {
  if (!takeActivation(from)) {
    if (Date.now() - (droppedLogAt.get(from) || 0) > 60000) {
      droppedLogAt.set(from, Date.now());
      console.warn(`[flow] dropped ${url}: a page opened it with no click or key from the owner`);
    }
    return { action: 'deny' };
  }
  if ((disposition === 'new-window' && features && /^https?:/i.test(url) && !inFilePages(guest)) || url === 'about:blank') return { action: 'allow' };
  if (/^https?:/i.test(url)) sendNewWindow(guest, url, disposition);
  else if (/^mailto:/i.test(url)) shell.openExternal(url).catch((e) => console.error(`[flow] could not open ${url}: ${e.message}`));
  else if (isAppLink(url)) askExternal(guest, url, (open) => { if (open) shell.openExternal(url).catch((e) => console.error(`[flow] could not open ${url}: ${e.message}`)); });
  else console.warn(`[flow] blocked a page popup to ${url}`);
  return { action: 'deny' };
}

function hardenPopup(win, guest) {
  trackActivation(win.webContents);
  keepKind(win.webContents, guest);
  win.webContents.setWindowOpenHandler((details) => openFromPage(guest, details, win.webContents));
  win.webContents.on('did-create-window', (child) => hardenPopup(child, guest));
}

// A webview's session is set when it is made, so a page or popup that sends itself or a frame to an address of the
// other kind (a report, or from a report a web page or another file) does not go there: when the owner clicked or
// typed, its window opens a main frame's address in the same tab with a webview of its own (page.js, 'current-tab').
// guest: the page it belongs to.
function keepKind(wc, guest) {
  if (inFilePages(wc)) wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  wc.on('will-frame-navigate', (event) => {
    if (!crossesKind(wc, event.url)) return;
    event.preventDefault();
    if (event.isMainFrame && takeActivation(wc)) sendNewWindow(guest, event.url, 'current-tab');
    else console.warn(`[flow] kept ${event.isMainFrame ? 'a page' : 'a frame'} from loading ${event.url.slice(0, 120)} in place`);
  });
  wc.on('will-redirect', (event) => {
    if (!crossesKind(wc, event.url)) return;
    event.preventDefault();
    console.warn(`[flow] stopped a redirect to ${event.url.slice(0, 120)}`);
  });
}

const pages = new Map();   // guest id -> { zoom, intent, blockedAt, allowedUntil }

function hardenGuest(guest) {
  const id = guest.id;
  const page = { zoom: null, intent: null, blockedAt: 0, allowedUntil: 0, asked: {}, using: {} };   // asked/using: a media device the site requested / has live
  pages.set(id, page);
  const restore = nextRestore;
  nextRestore = null;
  if (restore) {
    guest.once('did-attach', () => {
      guest.navigationHistory.restore({ index: restore.index, entries: restore.entries }).catch((e) => {
        // the page went away while its entry loaded (its window closed, or a quit): nothing to load it into
        if (guest.isDestroyed()) return;
        console.warn(`[flow] could not restore the history of ${restore.src}: ${e.message}`);
        guest.loadURL(restore.src).catch((err) => console.warn(`[flow] could not load ${restore.src}: ${err.message}`));
      });
    });
  }
  trackActivation(guest);
  keepKind(guest, guest);
  guest.setWindowOpenHandler((details) => openFromPage(guest, details, guest));
  guest.on('did-create-window', (win) => hardenPopup(win, guest));
  guest.on('context-menu', (_event, params) => guestContextMenu(guest, params));
  guest.on('login', (event, details, authInfo, callback) => {
    if (!details.isMainFrame || authInfo.isProxy) return;
    event.preventDefault();
    askLogin(guest, details.url, !details.firstAuthAttempt, callback);
  });
  // A page guarding unsaved typing never stops a navigation (owner, Nov 1 20:47): it goes on, and the page's own
  // unload handlers run, as after Chrome's Leave. Closing is the window's (page.js keeps such a page 10 s).
  guest.on('will-prevent-unload', (event) => event.preventDefault());
  guest.on('did-navigate', () => {
    if (page.zoom !== null) guest.send('flow:zoom', page.zoom);
  });
  guest.on('destroyed', () => {
    pages.delete(id);
    for (const ask of asks.values()) if (ask.guestId === id) ask.settle(false);
    for (const login of logins.values()) if (login.guestId === id) login.settle(null);
  });
}

// A tab comes back after a quit or a crash with its back/forward history and scroll (principle 5): the window keeps
// pageHistory() with the tab, and before it inserts the restored tab's webview it calls restorePageNext(src, history).
// That webview then loads nothing itself (Chromium restores history only into a page that has loaded nothing): its
// guest gets the history at did-attach. Electron creates the guest right after will-attach-webview, in the same call.
const HISTORY_MAX = 15;
function pageHistory(guest) {
  const h = guest.navigationHistory;
  const all = h.getAllEntries();
  const index = h.getActiveIndex();
  const from = Math.max(0, Math.min(index - 9, all.length - HISTORY_MAX));
  return { index: index - from, entries: all.slice(from, from + HISTORY_MAX).map(({ url, title, pageState }) => ({ url, title, pageState })) };
}

// Where Chromium's PDF viewer shows a page's PDF, and putting it back there after a restart. The viewer runs in an
// extension frame inside the page's guest, which only main can reach; viewport_ is the viewer's own object, so each call
// checks it is there (null or false when not).
const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
const pdfFrame = (guest) => guest.mainFrame.framesInSubtree.find((f) => f.url.startsWith(PDF_VIEWER)) || null;

async function pdfPlace(guest) {
  const f = pdfFrame(guest);
  if (!f) return null;
  return f.executeJavaScript(`(() => { const p = document.querySelector('pdf-viewer')?.viewport_;
    return p && p.position ? { x: p.position.x, y: p.position.y } : null; })()`);
}

// Once a page's PDF has loaded: the viewer's thumbnails pane closes (once, with the viewer's own toggle, so its ≡ opens it
// again), then a place kept from before a restart is set. Closing the pane lays the pages out again, and the viewer cuts
// a place short until its pages are laid out, so the place is done once it has held on two tries in a row (every 200 ms,
// for up to 6 s).
async function pdfShown(guest, at) {
  const place = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: Number(at.x), y: Number(at.y) } : null;
  let toggled = false;
  let held = 0;
  let failure = null;
  for (let i = 0; i < 30 && !guest.isDestroyed(); i++) {
    const f = pdfFrame(guest);
    const r = f && await f.executeJavaScript(`(() => {
      const v = document.querySelector('pdf-viewer'), p = v && v.viewport_;
      if (!p || typeof p.setPosition !== 'function') return null;
      if (${!toggled} && !v.sidenavCollapsed_ && typeof v.onSidenavToggleClick_ === 'function') {
        v.onSidenavToggleClick_();
        return { toggled: true };
      }
      const there = ${place ? `Math.abs(p.position.x - ${place.x}) < 2 && Math.abs(p.position.y - ${place.y}) < 2` : 'true'};
      if (!there) p.setPosition(${place ? `{ x: ${place.x}, y: ${place.y} }` : 'p.position'});
      return { there };
    })()`).catch((e) => {
      failure = e;
      return null;
    });
    if (r && r.toggled) toggled = true;
    held = r && r.there ? held + 1 : 0;
    if (held >= 2) return true;
    await new Promise((res) => setTimeout(res, 200));
  }
  if (failure) console.warn(`[flow] could not set up a page's PDF (pane, place): ${failure.message}`);
  return false;
}

const restores = new Map();   // host webContents id -> [{ src, history, at }] waiting for their webview (10 s at most)
let nextRestore = null;       // set by will-attach-webview, taken by the guest it creates

function expectRestore(hostId, src, history) {
  const entries = history && Array.isArray(history.entries) ? history.entries : [];
  const index = history && history.index;
  const ok = entries.length > 0 && entries.length <= 50 && Number.isInteger(index) && index >= 0 && index < entries.length &&
    entries.every((e) => e && typeof e.url === 'string' && /^(https?|flow-file):/i.test(e.url) && (e.title == null || typeof e.title === 'string') &&
      (e.pageState == null || (typeof e.pageState === 'string' && e.pageState.length < 262144)));
  if (!ok) return false;
  const list = (restores.get(hostId) || []).filter((r) => Date.now() - r.at < 10000);
  list.push({ src, at: Date.now(), history: { index, entries: entries.map(({ url, title, pageState }) => (pageState ? { url, title: title || '', pageState } : { url, title: title || '' })) } });
  restores.set(hostId, list);
  return true;
}

function takeRestore(hostId, src) {
  const waiting = (restores.get(hostId) || []).filter((r) => Date.now() - r.at < 10000);
  const at = src ? waiting.findIndex((r) => r.src === src) : -1;
  const found = at >= 0 ? waiting.splice(at, 1)[0] : null;
  if (waiting.length) restores.set(hostId, waiting);
  else restores.delete(hostId);
  if (!found) return null;
  // One saved before pages kept their kind may hold both: it keeps those of its page's.
  const { index, entries } = found.history;
  const kept = entries.filter((e) => isFilePage(e.url) === isFilePage(src));
  const active = kept.indexOf(entries[index]);
  return active >= 0 ? { src, index: active, entries: kept } : null;
}

// A page guarding unsaved changes (beforeunload) gets no dialog: the navigation stops and the page's window asks
// inline (page:unload-blocked). Leave calls allowUnload: the next unload of that page goes through for 10 s, and main
// repeats the navigation if the page started it (a link or a script; the guest preload sends where it was going) or
// the page's context menu did; otherwise allowUnload resolves false and the window repeats its own action.
function navigatePage(guest, run) {
  const page = pages.get(guest.id);
  if (page) page.intent = { at: Date.now(), run };
  run();
}

function pageNavigating(event, to) {
  const guest = event.sender;
  const page = pages.get(guest.id);
  if (!page || !event.senderFrame || event.senderFrame.parent || !to || typeof to !== 'object') {
    console.warn('[flow] ignored flow:page-navigate from a sender that is not a page');
    return;
  }
  let run = null;
  if (to.type === 'reload') run = () => guest.reload();
  else if (to.type === 'traverse' && Number.isInteger(to.delta)) run = () => guest.navigationHistory.goToOffset(to.delta);
  else if ((to.type === 'push' || to.type === 'replace') && /^https?:/i.test(to.url)) {
    run = crossesKind(guest, to.url) ? () => sendNewWindow(guest, to.url, 'current-tab')
      : () => guest.loadURL(to.url).catch((e) => console.warn(`[flow] could not go on to ${to.url}: ${e.message}`));
  }
  page.intent = run && { at: Date.now(), run };
}

function allowUnload(guest) {
  const page = pages.get(guest.id);
  page.allowedUntil = Date.now() + 10000;
  const intent = page.intent;
  page.intent = null;
  if (!intent || Math.abs(intent.at - page.blockedAt) > 1000) return false;
  intent.run();
  return true;
}

// Closing a page destroys its webview, which never asks the page, so the window asks first. Each frame answers by
// Chromium's rule: its guard counts only once the frame has had user activation. The page's own handlers run, as they
// do in Chrome when the user picks Stay.
const UNSAVED_CHECK = `(() => {
  const e = document.createEvent('BeforeUnloadEvent');
  e.initEvent('beforeunload', false, true);
  dispatchEvent(e);
  return navigator.userActivation.hasBeenActive && (e.defaultPrevented || !!e.returnValue);
})()`;

function within(ms, promise) {
  let timer;
  const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Quitting, or closing a Flow window, destroys its pages without asking them (Electron never runs a webview's
// beforeunload then). A Flow window that shows unsaved pages (flow.onUnsavedPages) is asked first: when one of its
// pages has unsaved changes the quit or close waits, the window gets window:unsaved-pages { action, pages }, and
// flow.closeAnyway(action) goes on. A window that does not listen closes as it always did.
const unsavedShown = new Set();   // webContents ids of Flow windows listening for window:unsaved-pages
const closeAnyway = new WeakSet();   // Flow windows the owner closes with unsaved pages: not asked again
const closeNow = new WeakSet();   // Flow windows that were asked and saved what they show: their close goes on
let quitAnyway = false;
let quitChecking = false;
let quitReady = false;   // every window was asked: the quit goes on
let quitGone = false;    // the quit has taken the windows off the screen: nothing can be shown any more
let startAgain = false;  // the owner opened Flow again while it was quitting

// Flow opened again (a second launch, or a Dock click on macOS) once a quit has taken the windows away: this instance
// is on its way out and that quit cannot be undone, so a new one starts once it has exited, with what it saved.
function openedWhileQuitting() {
  if (!quitGone && !quitting) return false;
  if (!startAgain) {
    startAgain = true;
    app.relaunch();
    console.log('[flow] opened again while quitting: Flow starts again once it has exited');
  }
  return true;
}

// Then a window that saves what it shows (flow.onFlushPages: its pages read their scroll and the state is written) is
// asked to, and the quit or close waits for its answer, at most FLUSH_WAIT_MS.
const flushShown = new Set();   // webContents ids of Flow windows listening for window:flush-pages
const flushWaits = new Map();   // request id -> { wcId, done }
const FLUSH_WAIT_MS = 2000;
let flushSeq = 0;
const shownPages = (pages) => (Array.isArray(pages) ? pages.map(String) : null);

function flushPagesOf(wins) {
  return Promise.all(wins.filter((w) => !w.isDestroyed() && flushShown.has(w.webContents.id)).map((w) => new Promise((resolve) => {
    const id = ++flushSeq;
    const wcId = w.webContents.id;
    const timer = setTimeout(() => {
      flushWaits.delete(id);
      console.error(`[flow] window ${wcId} did not save what it shows within ${FLUSH_WAIT_MS} ms; going on`);
      resolve();
    }, FLUSH_WAIT_MS);
    flushWaits.set(id, { wcId, done: () => { clearTimeout(timer); flushWaits.delete(id); resolve(); } });
    w.webContents.send('window:flush-pages', id);
  })));
}

function forgetFlush(wcId) {
  flushShown.delete(wcId);
  for (const f of [...flushWaits.values()]) if (f.wcId === wcId) f.done();
}

const guestsOf = (win) => webContents.getAllWebContents().filter((w) => w.getType() === 'webview' && !w.isDestroyed() && w.hostWebContents &&
  w.hostWebContents.id === win.webContents.id);

// Once nothing needs asking, a window on its way out (its close, or a quit) leaves the screen at once and saves what it
// shows behind it. Hidden, its renderer and pages would be throttled as background pages, so they stop being throttled
// first; its frame is read before it hides.
const leaving = new WeakSet();
const readFrame = new WeakMap();   // Flow window -> reads its frame (bounds, maximized, full screen) into what is kept of it

function leaveScreen(win) {
  if (win.isDestroyed() || leaving.has(win)) return;
  for (const wc of [win.webContents, ...guestsOf(win)]) wc.setBackgroundThrottling(false);
  // macOS would leave a full-screen window's Space behind, empty, if the window hid: that one goes as it closes.
  if (win.isFullScreen()) return;
  const read = readFrame.get(win);
  if (read) read();
  leaving.add(win);
  win.hide();
}

async function unsavedPagesOf(win) {
  const guests = guestsOf(win).filter((g) => touched.has(g.id));
  const flags = await Promise.all(guests.map((g) => hasUnsavedChanges(g)));
  return guests.filter((g, i) => flags[i] && !g.isDestroyed()).map((g) => ({ guestId: g.id, url: g.getURL(), title: g.getTitle() }));
}

// Whether those windows may close now; each one holding unsaved pages is told instead.
async function mayClose(wins, action) {
  const asked = wins.filter((w) => !w.isDestroyed() && unsavedShown.has(w.webContents.id));
  const found = await Promise.all(asked.map((w) => unsavedPagesOf(w)));
  let held = false;
  asked.forEach((w, i) => {
    if (!found[i].length || w.isDestroyed()) return;
    held = true;
    w.webContents.send('window:unsaved-pages', { action, pages: found[i] });
  });
  return !held;
}

async function hasUnsavedChanges(guest) {
  const answers = await Promise.all(guest.mainFrame.framesInSubtree.map((frame) => within(1000, frame.executeJavaScript(UNSAVED_CHECK)).catch((e) => {
    console.warn(`[flow] could not ask ${frame.url} about unsaved changes: ${e.message}`);
    return false;
  })));
  return answers.includes(true);
}

// Zoom is per page. Chromium zooms every page of a site together (webContents.setZoomLevel), so the guest preload
// zooms only its own page (webFrame.setZoomLevel), and main sets it again for each new document of the page.
const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];   // Chrome's steps
const levelOf = (factor) => Math.log(factor) / Math.log(1.2);

function setPageZoom(guest, level) {
  const page = pages.get(guest.id);
  page.zoom = Math.min(Math.max(level, levelOf(ZOOM_FACTORS[0])), levelOf(ZOOM_FACTORS[ZOOM_FACTORS.length - 1]));
  guest.send('flow:zoom', page.zoom);
  return page.zoom;
}

function zoomPage(guest, step) {
  const factor = 1.2 ** (pages.get(guest.id).zoom || 0);
  let next = 1;
  if (step > 0) next = ZOOM_FACTORS.find((f) => f > factor + 0.001) || factor;
  else if (step < 0) next = ZOOM_FACTORS.findLast((f) => f < factor - 0.001) || factor;
  return setPageZoom(guest, levelOf(next));
}

// A two-finger pinch over a page zooms inside it as Chrome's does (MAC_NOTES 58 b): the page is magnified, not laid out
// again, and the point under the fingers stays under them. A webview never applies the pinch its guest receives, so main
// sets Chromium's own page scale on the guest's debugger and moves its visual viewport to keep that point still. From 1x
// (Chrome does not pinch below the page's own size) to 5x; a new document starts at 1x, as in Chrome.
const PINCH_MAX = 5;
const PINCH_GAIN = 0.01;   // a ctrl+wheel delta of -100 px (Chromium's trackpad pinch) is e^1 ≈ 2.7x
async function pinchPage(guest, p) {
  const page = pages.get(guest.id);
  if (!page || guest.isDestroyed()) return null;
  const d = Number(p && p.deltaY);
  const x = Number(p && p.x);
  const y = Number(p && p.y);
  const vv = p && p.vv;
  if (!Number.isFinite(d) || !Number.isFinite(x) || !Number.isFinite(y) || !vv || !(vv.s > 0)) return null;
  const from = vv.s;
  const to = Math.min(PINCH_MAX, Math.max(1, from * Math.exp(-d * PINCH_GAIN)));
  if (Math.abs(to - from) < 1e-4) return from;
  // the page point under the fingers, in the layout viewport: it must be under the same screen point at the new scale
  const ox = vv.ox + x / from - x / to;
  const oy = vv.oy + y / from - y / to;
  if (!page.pinchReady) {
    await guest.setVisualZoomLevelLimits(1, PINCH_MAX);
    page.pinchReady = true;
  }
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3');
  await guest.debugger.sendCommand('Emulation.setPageScaleFactor', { pageScaleFactor: to });
  guest.send('flow:pinch-anchor', { x: ox, y: oy });
  return to;
}

// A link to another app (zoommtg:, slack:, ...) opens only after the page's window asked inline (page:open-external,
// answered by answerExternal); no answer in 60 s is no. mailto: opens at once.
const asks = new Map();   // request id -> { hostId, guestId, settle }
let lastAsk = 0;
const isAppLink = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url) &&
  !/^(https?|mailto|file|flow-file|javascript|data|blob|about|chrome|chrome-extension|chrome-untrusted|devtools|view-source|filesystem|ws|wss):/i.test(url);

function askExternal(guest, url, answer) {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) {
    console.warn(`[flow] blocked a page link to ${url}: its window is gone`);
    answer(false);
    return;
  }
  const requestId = ++lastAsk;
  const timer = setTimeout(() => {
    console.warn(`[flow] no answer about opening ${url} in 60 s, not opened`);
    settle(false);
  }, 60000);
  function settle(open) {
    clearTimeout(timer);
    asks.delete(requestId);
    answer(open);
  }
  asks.set(requestId, { hostId: host.id, guestId: guest.id, settle });
  host.send('page:open-external', { guestId: guest.id, url, requestId });
}

// A site's own sign-in on a page (HTTP auth): its window asks for a name and password in the page's area (page:login,
// answered by answerPageLogin; again: the last ones did not work) and the answer goes to the site. A page that starts
// another navigation or goes away, or no answer in 5 minutes, answers nothing, and the site's own page shows. A proxy's
// or a frame's sign-in is not asked. The name and password are never logged or kept.
const logins = new Map();   // request id -> { hostId, guestId, settle }
function askLogin(guest, url, again, callback) {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) {
    callback();
    return;
  }
  const requestId = ++lastAsk;
  const away = (details) => { if (details.isMainFrame && !details.isSameDocument) settle(null); };
  const timer = setTimeout(() => settle(null), 300000);
  function settle(answer) {
    if (!logins.delete(requestId)) return;
    clearTimeout(timer);
    if (!guest.isDestroyed()) guest.off('did-start-navigation', away);
    if (answer) callback(answer.user, answer.password);
    else callback();
  }
  logins.set(requestId, { hostId: host.id, guestId: guest.id, settle });
  guest.on('did-start-navigation', away);
  host.send('page:login', { guestId: guest.id, requestId, host: new URL(url).host, again });
}

// Page downloads go straight into the downloads folder, no dialog, "name (1).ext" on a clash (dev and test runs with
// FLOW_USER_DATA keep them in userData/Downloads). When one starts, its page's window is told (download:started) and
// says which workspace the page is in (download:workspace). When it is done, the page's tab shows it (page:download)
// and it lands in that workspace's downloads however the tab ended (download:done, to the page's window, or to the
// main window when that one has closed).
const downloaded = new Set();   // files Flow saved, the only paths showItemInFolder opens
const reserved = new Set();     // paths of downloads still running
const going = new Map();        // download id -> { hostId: the page's window, wsId: its workspace once that window says }
let downloadSeq = 0;
const downloadsDir = () => (process.env.FLOW_USER_DATA ? path.join(app.getPath('userData'), 'Downloads') : app.getPath('downloads'));

function downloadPath(name) {
  const dir = downloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const base = path.basename(name, ext) || 'download';
  let file = path.join(dir, base + ext);
  for (let n = 1; fs.existsSync(file) || reserved.has(file); n++) file = path.join(dir, `${base} (${n})${ext}`);
  return file;
}

function trackDownload(item, wc) {
  const file = downloadPath(path.basename(item.getFilename() || 'download'));
  reserved.add(file);
  item.setSavePath(file);
  const id = ++downloadSeq;
  const guestId = wc && !wc.isDestroyed() && wc.getType() === 'webview' ? wc.id : null;
  const host = guestId == null ? null : wc.hostWebContents;
  const at = { hostId: host ? host.id : null, wsId: null };
  going.set(id, at);
  if (host && !host.isDestroyed()) host.send('download:started', { id, guestId });
  item.once('done', (_event, state) => {
    reserved.delete(file);
    going.delete(id);
    if (state === 'completed') downloaded.add(file);
    const d = { id, url: item.getURL(), file, state, bytes: item.getReceivedBytes() };
    const hostLive = !!host && !host.isDestroyed();
    if (hostLive && !wc.isDestroyed()) host.send('page:download', { ...d, guestId });
    const main = flowWindows().find((w) => mainContents.has(w.webContents.id));
    const to = hostLive ? host : main && main.webContents;
    if (to && at.wsId) to.send('download:done', { ...d, wsId: at.wsId });
    if (state !== 'completed') console.warn(`[flow] download of ${item.getURL()} ${state}`);
  });
}

// Chromium writes cookies to disk about every 30 s, so a crash could lose a login made just before it: changes are
// written within 2 s. Session cookies (no expiry) would end at every quit: they are kept for 30 days instead, so
// logins come back after a quit or a reboot, as with Chrome's "continue where you left off". SameSite=None ones are
// left alone: Electron's cookie API does not say whether a cookie is partitioned (CHIPS, a third-party frame's cookie
// kept per top-level site), and a copy would be unpartitioned, sent to that site from every page that embeds it.
const SESSION_COOKIE_DAYS = 30;
function keepSessionCookie(ses, c) {
  const host = c.domain.replace(/^\./, '');
  const details = { url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: Date.now() / 1000 + SESSION_COOKIE_DAYS * 86400 };
  if (!c.hostOnly) details.domain = c.domain;
  ses.cookies.set(details).catch((e) => console.error(`[flow] could not keep the session cookie ${c.name} of ${host}: ${e.message}`));
}

const PROMPTED = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'midiSysex', 'display-capture']);
const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management']);
const decisions = new Map();   // `${origin} ${permission}` -> boolean, the user's answers, kept in the state file

// The microphone and the camera are answered apart (media:audio, media:video), as in Chrome.
function permissionKeys(origin, permission, mediaTypes) {
  if (permission === 'media' && mediaTypes.length) return mediaTypes.map((t) => `${origin} media:${t}`);
  return [`${origin} ${permission}`];
}

// A site the owner allowed still gets nothing until macOS has granted Flow the device; macOS only shows its own
// prompt when Flow asks it, so ask on the first allowed use (MAC_NOTES 41 b).
async function macMedia(mediaTypes) {
  if (process.platform !== 'darwin') return true;
  const devices = mediaTypes.filter((t) => t === 'video' || t === 'audio').map((t) => (t === 'video' ? 'camera' : 'microphone'));
  for (const device of devices) {
    const status = systemPreferences.getMediaAccessStatus(device);
    if (status === 'granted') continue;
    if (status !== 'not-determined') {
      console.warn(`[flow] macOS has ${status} Flow's ${device}; turn it on in System Settings > Privacy & Security > ${device === 'camera' ? 'Camera' : 'Microphone'}`);
      return false;
    }
    if (!(await systemPreferences.askForMediaAccess(device))) return false;
  }
  return true;
}

// A page's camera and microphone answers, for the small control in its address bar, and that control's own answers. A
// preference (MAC_NOTES 41 b, owner: "turn off my camera"): off is kept for the site and refused before the site can ask,
// on is kept too. It is the same map the dialog writes, so the next ask matches whichever way the owner last chose.
const MEDIA = ['media:video', 'media:audio'];
const mediaDevices = (key) => (key === 'media:video' ? ['video'] : key === 'media:audio' ? ['audio'] : []);
function mediaState(origin) {
  return Object.fromEntries(MEDIA.map((m) => {
    const v = decisions.get(`${origin} ${m}`);
    return [m === 'media:video' ? 'camera' : 'microphone', v === true ? 'on' : v === false ? 'off' : 'ask'];
  }));
}
// The OS gate is the stricter one, so a site answer of "on" still reads off when macOS has the device blocked.
function macState(device) {
  if (process.platform !== 'darwin' || !systemPreferences.getMediaAccessStatus) return 'ask';
  const status = systemPreferences.getMediaAccessStatus(device);
  return status === 'granted' ? 'ask' : status === 'not-determined' ? 'ask' : 'off';
}
async function setMedia(guest, device, state) {
  const kind = device === 'camera' ? 'media:video' : device === 'microphone' ? 'media:audio' : null;
  if (!kind) throw new Error(`flow: no device ${device}`);
  const origin = mediaOrigin(guest);
  if (!origin) throw new Error('flow: this page has no site to answer for');
  const key = `${origin} ${kind}`;
  if (state === 'ask') decisions.delete(key);
  else decisions.set(key, state === 'on');
  store.setPermissions(Object.fromEntries(decisions));
  if (state === 'on' && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus) {
    const os = systemPreferences.getMediaAccessStatus(device);
    if (os === 'not-determined' && systemPreferences.askForMediaAccess) {
      if (!(await systemPreferences.askForMediaAccess(device))) {
        decisions.set(key, false);
        store.setPermissions(Object.fromEntries(decisions));
        return mediaState(origin);
      }
    } else if (os !== 'granted') {
      decisions.set(key, false);
      store.setPermissions(Object.fromEntries(decisions));
    }
  }
