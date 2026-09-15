// The trackpad's touches on a Flow window (macOS, MAC_NOTES 25): how many fingers are down and how far they moved, from
// AppKit's touch events. Three-finger movement reaches a page as wheels that look like two fingers, and the legacy
// 'swipe' comes only for a quick flick, once, at its end; with these nav moves the workspaces under the fingers.
// Built on the Mac by build-mac.sh; src/touch.js loads it in the main process.
//
//   start(cb, opts) cb({ win, n, dx, dy, s, w, t }) on the main thread for each touch event on a watched window that
//                  changes the count, or that moves three or more fingers: n fingers touching (resting ones not
//                  counted), dx dy their mean travel since the last event in trackpad points (x to the right, y up), s
//                  their spread (mean distance from their centre, in points; a pinch changes it, a swipe does not), w
//                  the trackpad's width in points, t the event's time in epoch ms. Once per process. With opts.trace, also
//                  cb({ win, trace: true, began, moved, stationary, ended, cancelled, resting, t }) for every gesture event
//                  on a watched window that carries touches: how many of its touches (any phase, any view) are in each
//                  phase, and how many of them rest. Counts only.
//   watch(handle)  a BrowserWindow's getNativeWindowHandle() (its content view): the view and those in it take trackpad
//                  touches. Again for the same window (after its page loads) takes in views added since. Returns its id.
//   unwatch(id)    the window is gone (it is only compared from then on, never used)
//   stop()         no more reports
// A touch event AppKit will not give the touches of is reported once as { n: -1 }.
//
// Without AppKit (FLOW_TOUCH_FAKE, the Linux test build) nothing watches the trackpad and _inject(win, n, dx, dy, w, t, s)
// sends a report through the same path, so the stream and its end at a quit can be tested on the VM;
// _injectTrace(win, began, moved, stationary, ended, cancelled, resting, t) sends a trace report when tracing.

#include <node_api.h>

#include <cmath>
#include <cstring>
#include <utility>
#include <vector>

#ifndef FLOW_TOUCH_FAKE
#import <AppKit/AppKit.h>
#endif

namespace {

struct Report {
  int32_t win;
  int32_t n;
  double dx;
  double dy;
  double s;
  double w;
  double t;
  bool trace;
  int32_t phases[6];  // began, moved, stationary, ended, cancelled, resting
};

const char* const PHASES[6] = {"began", "moved", "stationary", "ended", "cancelled", "resting"};

napi_threadsafe_function tsfn = nullptr;
bool started = false;
bool tracing = false;
std::vector<std::pair<int32_t, void*>> watched;  // id, the window's content view
int32_t lastId = 0;

#ifndef FLOW_TOUCH_FAKE
id monitor = nil;
NSMutableDictionary* lastAt = nil;  // touch identity -> its normalizedPosition at the last event
bool refused = false;
int32_t lastN = 0;
double lastS = 0;
#endif

napi_value Undefined(napi_env env) {
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

void SetNumber(napi_env env, napi_value obj, const char* key, double value) {
  napi_value v;
  napi_create_double(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

// On the JS thread. env is null when the environment is going away: the report is only freed.
void CallJs(napi_env env, napi_value cb, void*, void* data) {
  Report* r = static_cast<Report*>(data);
  if (env != nullptr && cb != nullptr) {
    napi_value obj;
    napi_create_object(env, &obj);
    SetNumber(env, obj, "win", r->win);
    SetNumber(env, obj, "t", r->t);
    if (r->trace) {
      napi_value yes;
      napi_get_boolean(env, true, &yes);
      napi_set_named_property(env, obj, "trace", yes);
      for (int i = 0; i < 6; i++) SetNumber(env, obj, PHASES[i], r->phases[i]);
    } else {
      SetNumber(env, obj, "n", r->n);
      SetNumber(env, obj, "dx", r->dx);
      SetNumber(env, obj, "dy", r->dy);
      SetNumber(env, obj, "s", r->s);
      SetNumber(env, obj, "w", r->w);
    }
    napi_call_function(env, Undefined(env), cb, 1, &obj, nullptr);
  }
  delete r;
}

void Finalized(napi_env, void*, void*) { tsfn = nullptr; }

void Send(Report* r) {
  if (tsfn == nullptr || napi_call_threadsafe_function(tsfn, r, napi_tsfn_nonblocking) != napi_ok) delete r;
}

void Emit(int32_t win, int32_t n, double dx, double dy, double s, double w, double t) {
  Send(new Report{win, n, dx, dy, s, w, t, false, {0, 0, 0, 0, 0, 0}});
}

void EmitTrace(int32_t win, const int32_t phases[6], double t) {
  if (!tracing) return;
  Report* r = new Report{win, 0, 0, 0, 0, 0, t, true, {0, 0, 0, 0, 0, 0}};
  for (int i = 0; i < 6; i++) r->phases[i] = phases[i];
  Send(r);
}

#ifndef FLOW_TOUCH_FAKE
int32_t IdOf(NSWindow* window) {
  if (window == nil) return 0;
  void* view = (__bridge void*)window.contentView;
  for (const auto& p : watched)
    if (p.second == view) return p.first;
  return 0;
}

void AllowTouches(NSView* view) {
  view.allowedTouchTypes |= NSTouchTypeMaskIndirect;
  for (NSView* sub in view.subviews) AllowTouches(sub);
}

// the event's time (seconds since the Mac started) on the epoch clock
double EpochMs(NSEvent* event) {
  return ([[NSDate date] timeIntervalSince1970] - ([[NSProcessInfo processInfo] systemUptime] - event.timestamp)) * 1000.0;
}

void Trace(int32_t win, NSEvent* event) {
  int32_t phases[6] = {0, 0, 0, 0, 0, 0};
  NSSet<NSTouch*>* all = [event touchesMatchingPhase:NSTouchPhaseAny inView:nil];
  if (all.count == 0) return;
  for (NSTouch* touch in all) {
    NSTouchPhase p = touch.phase;
    if (p & NSTouchPhaseBegan) phases[0]++;
    else if (p & NSTouchPhaseMoved) phases[1]++;
    else if (p & NSTouchPhaseStationary) phases[2]++;
    else if (p & NSTouchPhaseEnded) phases[3]++;
    else if (p & NSTouchPhaseCancelled) phases[4]++;
    if (touch.isResting) phases[5]++;
  }
  EmitTrace(win, phases, EpochMs(event));
}

void OnTouches(NSEvent* event) {
  int32_t win = IdOf(event.window);
  if (win == 0) return;
  if (tracing) Trace(win, event);
  NSSet<NSTouch*>* touches = [event touchesMatchingPhase:NSTouchPhaseTouching inView:event.window.contentView];
  NSMutableDictionary* now = [NSMutableDictionary dictionary];
  int32_t n = 0, moved = 0;
  double sx = 0, sy = 0, w = 0;
  std::vector<NSPoint> at;  // where each touch is, in trackpad points
  for (NSTouch* touch in touches) {
    if (touch.type != NSTouchTypeIndirect || touch.isResting) continue;
    n++;
    NSPoint p = touch.normalizedPosition;
    NSSize size = touch.deviceSize;
    w = size.width;
    at.push_back(NSMakePoint(p.x * size.width, p.y * size.height));
    now[touch.identity] = [NSValue valueWithPoint:p];
    NSValue* was = lastAt[touch.identity];
    if (was != nil) {
      NSPoint q = was.pointValue;
      sx += (p.x - q.x) * size.width;
      sy += (p.y - q.y) * size.height;
      moved++;
    }
  }
  lastAt = now;
  double dx = moved ? sx / moved : 0, dy = moved ? sy / moved : 0;
  double cx = 0, cy = 0, s = 0;
  for (const NSPoint& q : at) { cx += q.x; cy += q.y; }
  if (n) { cx /= n; cy /= n; }
  for (const NSPoint& q : at) s += std::hypot(q.x - cx, q.y - cy);
  if (n) s /= n;
  if (n == lastN && (n < 3 || (dx == 0 && dy == 0 && s == lastS))) return;
  lastN = n;
