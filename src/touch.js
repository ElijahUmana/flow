'use strict';
// The trackpad's touches on macOS, for nav (MAC_NOTES 25). A three-finger movement reaches a page as wheels that look
// like two fingers, and the legacy 'swipe' comes only for a quick flick, once, at its end. native/touch (flow_touch.node,
// built on the Mac by native/touch/build-mac.sh) reads the touches themselves, and each Flow window gets them as
// 'fingers' { n, t, dx, pinch, x, y }: n fingers down (0 when lifted), t the event's time in epoch ms, and dx, once three
// or more move mostly sideways, their travel since the last report in the window's px (the trackpad's width is the
// window's), positive when they move left, a wheel's sign; or pinch, once three or more mostly spread or close, how much
// further apart they are than at the last report (2: twice as far), with x y the pointer in the window's px, where the
// pinch is. Only a window whose page asked (preload's onFingers) gets them; that page also gets the legacy 'swipe'
// (watch), module or not, and main's own handling of it gives way there. Without the module (another platform, not
// built, or it failed to load) nothing streams and the swipe is all of three fingers that reaches nav. FLOW_TOUCH_LOG=1
// logs each change in the count, asked for or not, with the travel and what it was (x, y or pinch) when three or more
// fingers lift, and for every gesture event with touches the module's trace: how many touches are in each phase and how
// many rest (MAC_NOTES 28: does a third finger come in another phase, or resting?). Counts only, never positions.

const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const { app, screen, webContents } = require('electron');

const ADDON = process.env.FLOW_TOUCH_ADDON || path.join(__dirname, '..', 'native', 'touch', 'flow_touch.node');
const LOCK_PT = 4;     // trackpad points of travel (or of spreading or closing) before three fingers count as moving
                       // sideways, up and down, or pinching
const TAP_MS = 250;    // two fingers down no longer than this, and never three, are a tap
const TAPS_MS = 400;   // the second tap of a double tap starts within this of the first one's end

/* macOS's own trackpad gestures that take fingers Flow uses (owner's finger map, MAC_NOTES 60; OK given, 54): four
   fingers sideways switch Flow's workspaces, so macOS's four-finger desktop swipe is off while Flow runs, and a
   four-finger swipe never also moves a macOS desktop. Three fingers step sub-workspaces and pinch the workspace's zoom,
   and while macOS's three-finger page swipe owns a gesture AppKit hands an app at most two of the three touches
   (MAC_NOTES 32), so macOS's three-finger swipes and tap are off too (32 b: Swipe between pages on two fingers only, no
   three-finger Mission Control or look-up). Each is put back as it was at quit. Each setting is the same key in the
   built-in and the Bluetooth trackpad's domain, and the per-host global one. What was there before Flow changed it is
   kept in userData until it is put back, and a watchdog outside Flow puts it back within a second of Flow ending
   without doing so itself (a crash, a force quit): macOS never keeps Flow's settings after Flow. Only the owner's app
   does this (no FLOW_USER_DATA), or a copy that asks with FLOW_TRACKPAD=1. */
const DEFAULTS = process.env.FLOW_DEFAULTS_BIN || '/usr/bin/defaults';
const ACTIVATE = process.env.FLOW_ACTIVATE_BIN || '/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings';
const PADS = ['com.apple.AppleMultitouchTrackpad', 'com.apple.driver.AppleBluetoothMultitouch.trackpad'];
const gesture = (key, host) => [...PADS.map((d) => ({ at: [d], key })), { at: ['-currentHost', '-g'], key: host }];
const OFF = [
  ...gesture('TrackpadFourFingerHorizSwipeGesture', 'com.apple.trackpad.fourFingerHorizSwipeGesture'),
  ...gesture('TrackpadThreeFingerHorizSwipeGesture', 'com.apple.trackpad.threeFingerHorizSwipeGesture'),
  ...gesture('TrackpadThreeFingerVertSwipeGesture', 'com.apple.trackpad.threeFingerVertSwipeGesture'),
  ...gesture('TrackpadThreeFingerTapGesture', 'com.apple.trackpad.threeFingerTapGesture'),
];
const ownsTrackpad = () => process.env.FLOW_TRACKPAD === '1' || (process.platform === 'darwin' && !process.env.FLOW_USER_DATA);
const keptFile = () => path.join(app.getPath('userData'), 'trackpad-before-flow.json');
let kept = null;   // [{ at, key, value }] what macOS had (value null: not set), while Flow's settings are on
const shell = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

let addon = null;
let refused = false;
const watched = new Map();   // module id -> { win, n, down, sx, sy, ss, ls, spread, axis, sent, touchAt, most, tapEnd }
const ids = new WeakMap();   // BrowserWindow -> module id
const wanting = new WeakSet();   // webContents of Flow windows whose page takes the touches
const LOG = process.env.FLOW_TOUCH_LOG === '1';

function report(r) {
  if (r.trace) {
    if (!watched.has(r.win)) return;
    console.log(`[flow] touches trace: ${r.began} began, ${r.moved} moved, ${r.stationary} stationary, ${r.ended} ended, ${r.cancelled} cancelled; ${r.resting} resting; t ${Math.round(r.t)}`);
    return;
  }
  if (r.n < 0) {
    if (!refused) console.error('[flow] trackpad touches: AppKit would not give a touch event\'s touches');
    refused = true;
    return;
  }
  const w = watched.get(r.win);
  if (!w || w.win.isDestroyed()) return;
  const out = { n: r.n, t: r.t };
  if (r.n >= 3) {
    if (!w.down) Object.assign(w, { down: true, sx: 0, sy: 0, ss: 0, ls: 0, spread: 0, axis: null, sent: false });
    w.sx += r.dx;
    w.sy += r.dy;
    // the spread changes only while the same fingers stay down (another finger moves the centre and the mean)
    const s = r.s > 0 ? r.s : 0, was = r.n === w.n && w.spread > 0 && s > 0 ? w.spread : s, ls = s > 0 ? Math.log(s / was) : 0;
    w.ss += s - was;
    w.ls += ls;
    w.spread = s;
    if (!w.axis && Math.max(Math.abs(w.sx), Math.abs(w.sy), Math.abs(w.ss)) >= LOCK_PT) w.axis = Math.abs(w.ss) > Math.max(Math.abs(w.sx), Math.abs(w.sy)) ? 'pinch' : Math.abs(w.sx) > Math.abs(w.sy) ? 'x' : 'y';
    // the travel (or the pinch) before the lock goes with its first report
    const pt = w.axis !== 'x' ? 0 : w.sent ? r.dx : w.sx;
    const pl = w.axis !== 'pinch' ? 0 : w.sent ? ls : w.ls;
    if (w.axis === 'x' || w.axis === 'pinch') w.sent = true;
    if (pt && r.w > 0) out.dx = (-pt / r.w) * w.win.getContentBounds().width;
    if (pl) {
      const c = screen.getCursorScreenPoint(), b = w.win.getContentBounds();
      Object.assign(out, { pinch: Math.exp(pl), x: c.x - b.x, y: c.y - b.y });
    }
  }
  if (LOG && r.n !== w.n) {
    const lifted = r.n < 3 && w.down ? `; three or more moved ${Math.round(w.sx)} pt sideways, ${Math.round(w.sy)} pt up (${w.axis || 'no direction'})` : '';
    console.log(`[flow] touches: ${r.n} finger${r.n === 1 ? '' : 's'} on a Flow window${lifted}`);
  }
  tapped(w, r);
  w.n = r.n;
  if (r.n < 3) w.down = false;
  if (wanting.has(w.win.webContents)) w.win.webContents.send('fingers', out);
}

/* A two-finger double tap (owner, Nov 7, 02-thoughts line 46; MAC_NOTES 58 c: double tap, then swipe the way the page
   should go) is told to the pages in that window as 'flow:double-tap' { t }: the page under the fingers takes the
   swipe that follows as back or forward (guest-preload.js). A touch counts as a tap when two fingers were its most and
   it lasted at most TAP_MS. */
function tapped(w, r) {
  if (r.n > 0 && w.n === 0) Object.assign(w, { touchAt: r.t, most: 0 });
  if (r.n > 0) w.most = Math.max(w.most || 0, r.n);
  if (r.n !== 0 || w.n === 0) return;
  const tap = w.most === 2 && r.t - w.touchAt <= TAP_MS;
  if (tap && w.tapEnd && w.touchAt - w.tapEnd <= TAPS_MS) {
    w.tapEnd = 0;
    const host = w.win.webContents;
    for (const c of webContents.getAllWebContents()) if (c.hostWebContents === host && !c.isDestroyed()) c.send('flow:double-tap', { t: r.t });
    return;
  }
  w.tapEnd = tap ? r.t : 0;
}

/* Loads the module and starts the stream; false when there is none. */
function start() {
  const wanted = process.env.FLOW_TOUCH_ADDON || process.platform === 'darwin';
  if (!wanted || addon) return !!addon;
  try {
    const m = require(ADDON);
    m.start((r) => {
      try {
        report(r);
      } catch (e) {
        console.error(`[flow] trackpad touches: a report failed: ${e.stack || e.message}`);
      }
    }, { trace: LOG });
    addon = m;
  } catch (e) {
    console.warn(`[flow] trackpad touches are off (three fingers step sub-workspaces on macOS's swipe alone): ${e.message}`);
    return false;
  }
  // Flow sees three and four fingers only through the module, so macOS keeps its gestures when there is none
  takeTrackpad();
