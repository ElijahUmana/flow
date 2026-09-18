#!/usr/bin/env python3
import argparse
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('source')
parser.add_argument('--expect', choices=('pass', 'fail'), required=True)
args = parser.parse_args()
source_path = Path(args.source).resolve()
text = source_path.read_text()
needle = 'static void\npty_posix_spawn(char** argv, char** env,'
start = text.rfind(needle)
if start < 0:
    raise SystemExit(f'{source_path}: Darwin pty_posix_spawn not found')
brace = text.find('{', start)
depth = 0
end = None
for i in range(brace, len(text)):
    if text[i] == '{':
        depth += 1
    elif text[i] == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
if end is None:
    raise SystemExit(f'{source_path}: incomplete pty_posix_spawn')
function = text[start:end]
has_stage = 'const char** stage' in function

harness = r'''
#include <cerrno>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <set>
#include <signal.h>
#include <spawn.h>
#include <string>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#ifndef POSIX_SPAWN_CLOEXEC_DEFAULT
#define POSIX_SPAWN_CLOEXEC_DEFAULT 0x4000
#endif
#ifndef POSIX_SPAWN_SETSID
#define POSIX_SPAWN_SETSID 0x0400
#endif
#ifndef TIOCPTYGNAME
#define TIOCPTYGNAME 0x40047453
#endif

struct State {
  std::set<int> open;
  std::set<int> initial;
  std::string fail;
  int openpt_calls = 0;
  int fail_openpt_at = -1;
  int fail_openpt_first = 0;
  int double_close = 0;
  int action_init = 0;
  int action_destroy = 0;
  int attr_init = 0;
  int attr_destroy = 0;
  int spawn_calls = 0;
} state;

static int allocate_fd() {
  for (int fd = 0;; fd++) {
    if (!state.open.count(fd)) {
      state.open.insert(fd);
      return fd;
    }
  }
}
static int fake_posix_openpt(int) {
  int call = state.openpt_calls++;
  if (call < state.fail_openpt_first || call == state.fail_openpt_at) {
    errno = ENXIO;
    return -1;
  }
  return allocate_fd();
}
static int fake_grantpt(int) {
  if (state.fail == "grantpt") { errno = EACCES; return -1; }
  return 0;
}
static int fake_unlockpt(int) {
  if (state.fail == "unlockpt") { errno = EACCES; return -1; }
  return 0;
}
static int fake_ioctl(int, unsigned long request, ...) {
  if (request == TIOCPTYGNAME) {
    if (state.fail == "ioctl(TIOCPTYGNAME)") { errno = EIO; return -1; }
    va_list ap;
    va_start(ap, request);
    char* name = va_arg(ap, char*);
    std::strcpy(name, "/dev/fake-pty");
    va_end(ap);
    return 0;
  }
  if (state.fail == "ioctl(TIOCSWINSZ)") { errno = EIO; return -1; }
  return 0;
}
static int fake_open(const char*, int, ...) {
  if (state.fail == "open") { errno = EIO; return -1; }
  return allocate_fd();
}
static int fake_close(int fd) {
  if (!state.open.erase(fd)) {
    state.double_close++;
    errno = EBADF;
    return -1;
  }
  return 0;
}
static int fake_tcsetattr(int, int, const struct termios*) {
  if (state.fail == "tcsetattr") { errno = EIO; return -1; }
  return 0;
}
static int fake_nonblock(int) {
  if (state.fail == "fcntl") { errno = EIO; return -1; }
  return 0;
}
static int fake_actions_init(posix_spawn_file_actions_t*) {
  if (state.fail == "posix_spawn_file_actions_init") return EIO;
  state.action_init++;
  return 0;
}
static int fake_actions_destroy(posix_spawn_file_actions_t*) { state.action_destroy++; return 0; }
static int fake_actions_adddup2(posix_spawn_file_actions_t*, int, int) {
  return state.fail == "posix_spawn_file_actions_adddup2" ? EIO : 0;
}
static int fake_actions_addclose(posix_spawn_file_actions_t*, int) {
  return state.fail == "posix_spawn_file_actions_addclose" ? EIO : 0;
}
static int fake_attr_init(posix_spawnattr_t*) {
  if (state.fail == "posix_spawnattr_init") return EIO;
  state.attr_init++;
  return 0;
}
static int fake_attr_destroy(posix_spawnattr_t*) { state.attr_destroy++; return 0; }
static int fake_attr_setflags(posix_spawnattr_t*, short) {
  return state.fail == "posix_spawnattr_setflags" ? EIO : 0;
}
static int fake_sigfillset(sigset_t* set) {
  if (state.fail == "sigfillset") { errno = EIO; return -1; }
  std::memset(set, 0xff, sizeof(*set));
  return 0;
}
static int fake_sigemptyset(sigset_t* set) {
  if (state.fail == "sigemptyset") { errno = EIO; return -1; }
  std::memset(set, 0, sizeof(*set));
  return 0;
}
static int fake_attr_setsigdefault(posix_spawnattr_t*, const sigset_t*) {
  return state.fail == "posix_spawnattr_setsigdefault" ? EIO : 0;
}
static int fake_attr_setsigmask(posix_spawnattr_t*, const sigset_t*) {
  return state.fail == "posix_spawnattr_setsigmask" ? EIO : 0;
}
static int fake_spawn(pid_t* pid, const char*, const posix_spawn_file_actions_t*, const posix_spawnattr_t*, char* const[], char* const[]) {
  state.spawn_calls++;
  if (state.fail == "posix_spawn-eintr" && state.spawn_calls == 1) return EINTR;
  if (state.fail == "posix_spawn") return EAGAIN;
  *pid = 4242;
  return 0;
}

#define posix_openpt fake_posix_openpt
#define grantpt fake_grantpt
#define unlockpt fake_unlockpt
#define ioctl fake_ioctl
#define open fake_open
#define close fake_close
#define tcsetattr fake_tcsetattr
#define pty_nonblock fake_nonblock
#define posix_spawn_file_actions_init fake_actions_init
#define posix_spawn_file_actions_destroy fake_actions_destroy
#define posix_spawn_file_actions_adddup2 fake_actions_adddup2
#define posix_spawn_file_actions_addclose fake_actions_addclose
#define posix_spawnattr_init fake_attr_init
#define posix_spawnattr_destroy fake_attr_destroy
#define posix_spawnattr_setflags fake_attr_setflags
#define sigfillset fake_sigfillset
#define sigemptyset fake_sigemptyset
#define posix_spawnattr_setsigdefault fake_attr_setsigdefault
#define posix_spawnattr_setsigmask fake_attr_setsigmask
#define posix_spawn fake_spawn
'''
harness += '\n' + function + '\n'
harness += r'''
#undef posix_openpt
#undef grantpt
#undef unlockpt
#undef ioctl
#undef open
#undef close
#undef tcsetattr
#undef pty_nonblock
#undef posix_spawn_file_actions_init
#undef posix_spawn_file_actions_destroy
#undef posix_spawn_file_actions_adddup2
#undef posix_spawn_file_actions_addclose
#undef posix_spawnattr_init
#undef posix_spawnattr_destroy
#undef posix_spawnattr_setflags
#undef sigfillset
#undef sigemptyset
#undef posix_spawnattr_setsigdefault
#undef posix_spawnattr_setsigmask
#undef posix_spawn

static void reset(int std_mask) {
  state = State{};
  for (int fd = 0; fd < 3; fd++) {
    if (std_mask & (1 << fd)) state.open.insert(fd);
  }
  state.initial = state.open;
}
static void check(bool ok, const std::string& message) {
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s\n", message.c_str());
    std::exit(2);
  }
}
static void call_spawn(int* master, pid_t* pid, int* err, const char** stage) {
  char arg0[] = "/bin/true";
  char* argv[] = {arg0, nullptr};
  char* env[] = {nullptr};
  struct termios term{};
  struct winsize win{};
'''
if has_stage:
    harness += '  pty_posix_spawn(argv, env, &term, &win, master, pid, err, stage);\n'
else:
    harness += '  (void)stage;\n  pty_posix_spawn(argv, env, &term, &win, master, pid, err);\n'
harness += r'''
}
static void expect_success(int std_mask, const std::string& fail = "") {
  reset(std_mask);
  state.fail = fail;
  int master = -7;
  pid_t pid = -7;
  int err = -7;
  const char* stage = "unset";
  call_spawn(&master, &pid, &err, &stage);
  check(err == 0, "success err=" + std::to_string(err));
  check(pid == 4242, "success pid not transferred");
  check(master >= 0 && state.open.count(master), "success master not transferred");
  fake_close(master);
  check(state.open == state.initial, "success leaked descriptor(s), std mask " + std::to_string(std_mask));
  check(state.double_close == 0, "success double close");
  check(state.action_init == state.action_destroy, "success file actions imbalance");
  check(state.attr_init == state.attr_destroy, "success attrs imbalance");
}
'''
if has_stage:
    harness += r'''
static void expect_failure(const std::string& failure, const std::string& expected_stage, int expected_errno = EIO) {
  reset(7);
  state.fail = failure;
  int master = -7;
  pid_t pid = -7;
  int err = -7;
  const char* stage = "unset";
  call_spawn(&master, &pid, &err, &stage);
  check(master == -1, failure + ": failure master escaped");
  check(pid == -1, failure + ": failure pid escaped");
  check(err == expected_errno, failure + ": errno=" + std::to_string(err));
  check(std::string(stage) == expected_stage, failure + ": stage=" + stage);
  check(state.open == state.initial, failure + ": leaked descriptor(s)");
  check(state.double_close == 0, failure + ": double close");
  check(state.action_init == state.action_destroy, failure + ": file actions imbalance");
  check(state.attr_init == state.attr_destroy, failure + ": attrs imbalance");
}
'''
harness += r'''
int main() {
  for (int mask = 0; mask < 8; mask++) expect_success(mask);
  expect_success(7, "posix_spawn-eintr");
'''
if has_stage:
    harness += r'''
  reset(7);
  state.fail_openpt_first = 3;
  int master = -7;
  pid_t pid = -7;
  int err = -7;
  const char* stage = "unset";
  call_spawn(&master, &pid, &err, &stage);
  check(master == -1 && pid == -1 && err == ENXIO, "all spare opens fail contract");
  check(std::string(stage) == "posix_openpt", "all spare opens fail stage");
  check(state.open == state.initial && state.double_close == 0, "all spare opens fail cleanup");

  reset(7);
  state.fail_openpt_at = 1;
  master = -7; pid = -7; err = -7; stage = "unset";
  call_spawn(&master, &pid, &err, &stage);
  check(master == -1 && pid == -1 && err == ENXIO, "master open failure contract");
  check(std::string(stage) == "posix_openpt", "master open failure stage");
  check(state.open == state.initial && state.double_close == 0, "master open failure cleanup");

  expect_failure("grantpt", "grantpt", EACCES);
  expect_failure("unlockpt", "unlockpt", EACCES);
  expect_failure("ioctl(TIOCPTYGNAME)", "ioctl(TIOCPTYGNAME)");
  expect_failure("open", "open");
  expect_failure("tcsetattr", "tcsetattr");
  expect_failure("ioctl(TIOCSWINSZ)", "ioctl(TIOCSWINSZ)");
  expect_failure("fcntl", "fcntl");
  expect_failure("posix_spawn_file_actions_init", "posix_spawn_file_actions_init");
  expect_failure("posix_spawn_file_actions_adddup2", "posix_spawn_file_actions_adddup2");
  expect_failure("posix_spawn_file_actions_addclose", "posix_spawn_file_actions_addclose");
  expect_failure("posix_spawnattr_init", "posix_spawnattr_init");
  expect_failure("posix_spawnattr_setflags", "posix_spawnattr_setflags");
  expect_failure("sigfillset", "sigfillset");
  expect_failure("posix_spawnattr_setsigdefault", "posix_spawnattr_setsigdefault");
  expect_failure("sigemptyset", "sigemptyset");
  expect_failure("posix_spawnattr_setsigmask", "posix_spawnattr_setsigmask");
  expect_failure("posix_spawn", "posix_spawn", EAGAIN);
'''
harness += r'''
  std::puts("PASS: Darwin PTY descriptor ownership and cleanup");
  return 0;
}
'''

sanitizers = 'address,undefined'
if sys.platform == 'darwin':
    version = platform.mac_ver()[0]
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,2}', version):
        raise SystemExit(f'FAIL: unavailable or malformed macOS product version: {version!r}')
    # ASan hangs before main on macOS 26; the kernel major does not match the product major.
    if int(version.split('.')[0]) >= 26:
        sanitizers = 'undefined'
env = {**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1'}
if sanitizers == 'undefined':
    env.pop('ASAN_OPTIONS', None)
else:
    env['ASAN_OPTIONS'] = 'detect_leaks=0:abort_on_error=1'
compiler = os.environ.get('CXX') or ('clang++' if shutil.which('clang++') else 'g++')
with tempfile.TemporaryDirectory(prefix='flow-pty-cleanup-') as tmp:
    tmp = Path(tmp)
    cpp = tmp / 'cleanup.cc'
    binary = tmp / 'cleanup'
    cpp.write_text(harness)
    try:
        build = subprocess.run([
            compiler, '-std=c++17', '-g', '-O1', '-fno-omit-frame-pointer',
            f'-fsanitize={sanitizers}', str(cpp), '-o', str(binary)
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    except subprocess.TimeoutExpired as error:
        raise SystemExit(f'FAIL: cleanup harness compilation timed out after {error.timeout}s')
    if build.returncode != 0:
        print(build.stdout, end='')
        raise SystemExit('FAIL: cleanup harness did not compile')
    try:
        run = subprocess.run([str(binary)], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             env=env, timeout=30)
    except subprocess.TimeoutExpired as error:
        raise SystemExit(f'FAIL: cleanup harness execution timed out after {error.timeout}s')
    print(run.stdout, end='')
    passed = run.returncode == 0
    if args.expect == 'pass' and not passed:
        raise SystemExit(f'FAIL: expected patched source to pass, exit {run.returncode}')
    if args.expect == 'fail' and passed:
        raise SystemExit('FAIL: expected baseline source to fail')
    if args.expect == 'fail':
        print(f'PASS: baseline rejected, native harness exit {run.returncode}')




