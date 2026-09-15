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
  lastS = s;
  Emit(win, n, dx, dy, s, w, EpochMs(event));
}
#endif

void StopWatching() {
#ifndef FLOW_TOUCH_FAKE
  if (monitor != nil) [NSEvent removeMonitor:monitor];
  monitor = nil;
  lastAt = nil;
#endif
}

// The environment is going away (a quit): Node has already finalized the threadsafe function, so it is not released.
void Cleanup(void*) {
  StopWatching();
  tsfn = nullptr;
}

napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type = napi_undefined;
  if (argc >= 1) napi_typeof(env, argv[0], &type);
  if (type != napi_function) {
    napi_throw_type_error(env, nullptr, "start(cb): cb must be a function");
    return nullptr;
  }
  if (started) {
    napi_throw_error(env, nullptr, "start(cb): already started");
    return nullptr;
  }
  napi_value name;
  napi_create_string_utf8(env, "flow-touch", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, Finalized, nullptr, CallJs, &tsfn) != napi_ok) {
    napi_throw_error(env, nullptr, "start(cb): could not make the threadsafe function");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, tsfn);
  started = true;
  napi_valuetype optsType = napi_undefined;
  if (argc == 2) napi_typeof(env, argv[1], &optsType);
  if (optsType == napi_object) {
    napi_value v;
    bool on = false;
    if (napi_get_named_property(env, argv[1], "trace", &v) == napi_ok) napi_get_value_bool(env, v, &on);
    tracing = on;
  }
#ifndef FLOW_TOUCH_FAKE
  lastAt = [NSMutableDictionary dictionary];
  lastN = 0;
  lastS = 0;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskGesture
                                                 handler:^NSEvent*(NSEvent* event) {
                                                   @try {
                                                     OnTouches(event);
                                                   } @catch (NSException* e) {
                                                     (void)e;
                                                     if (!refused) Emit(0, -1, 0, 0, 0, 0, 0);
                                                     refused = true;
                                                   }
                                                   return event;
                                                 }];
  if (monitor == nil) {
    napi_throw_error(env, nullptr, "start(cb): AppKit gave no event monitor");
    return nullptr;
  }
#endif
  return Undefined(env);
}

napi_value Stop(napi_env env, napi_callback_info) {
  StopWatching();
  if (tsfn != nullptr) {
    napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
    tsfn = nullptr;
  }
  return Undefined(env);
}

napi_value Watch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool isBuffer = false;
  if (argc == 1) napi_is_buffer(env, argv[0], &isBuffer);
  void* data = nullptr;
  size_t length = 0;
  if (isBuffer) napi_get_buffer_info(env, argv[0], &data, &length);
#ifdef FLOW_TOUCH_FAKE
  const size_t handleSize = length == 4 ? 4 : sizeof(void*);  // an X11 window id on the VM
#else
  const size_t handleSize = sizeof(void*);
#endif
  if (!isBuffer || length != handleSize) {
    napi_throw_type_error(env, nullptr, "watch(handle): handle must be a window's getNativeWindowHandle()");
    return nullptr;
  }
  void* view = nullptr;
  memcpy(&view, data, handleSize);
#ifndef FLOW_TOUCH_FAKE
  NSView* v = (__bridge NSView*)view;
  if (v == nil || ![v isKindOfClass:[NSView class]]) {
    napi_throw_type_error(env, nullptr, "watch(handle): the handle is not a view");
    return nullptr;
  }
  AllowTouches(v);
#endif
  int32_t id = 0;
  for (const auto& p : watched)
    if (p.second == view) id = p.first;
  if (id == 0) {
    id = ++lastId;
    watched.emplace_back(id, view);
  }
  napi_value out;
  napi_create_int32(env, id, &out);
  return out;
}

napi_value Unwatch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int32_t id = 0;
  if (argc != 1 || napi_get_value_int32(env, argv[0], &id) != napi_ok) {
    napi_throw_type_error(env, nullptr, "unwatch(id): id must be a number");
    return nullptr;
  }
  for (auto it = watched.begin(); it != watched.end(); ++it) {
    if (it->first == id) {
      watched.erase(it);
      break;
    }
  }
  return Undefined(env);
}

#ifdef FLOW_TOUCH_FAKE
napi_value InjectTrace(napi_env env, napi_callback_info info) {
  size_t argc = 8;
  napi_value argv[8];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double v[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  for (size_t i = 0; i < argc && i < 8; i++) napi_get_value_double(env, argv[i], &v[i]);
  int32_t phases[6];
  for (int i = 0; i < 6; i++) phases[i] = static_cast<int32_t>(v[i + 1]);
  EmitTrace(static_cast<int32_t>(v[0]), phases, v[7]);
  return Undefined(env);
}

napi_value Inject(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value argv[7];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double v[7] = {0, 0, 0, 0, 0, 0, 0};
  for (size_t i = 0; i < argc && i < 7; i++) napi_get_value_double(env, argv[i], &v[i]);
  Emit(static_cast<int32_t>(v[0]), static_cast<int32_t>(v[1]), v[2], v[3], v[6], v[4], v[5]);
  return Undefined(env);
}
#endif

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"watch", nullptr, Watch, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"unwatch", nullptr, Unwatch, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
#ifdef FLOW_TOUCH_FAKE
    {"_inject", nullptr, Inject, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    {"_injectTrace", nullptr, InjectTrace, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
#endif
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(flow_touch, Init)




