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
