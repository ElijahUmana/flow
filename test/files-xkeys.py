#!/usr/bin/env python3
"""files-xkeys.py <pid> <keys...>: real key presses into the X display that process <pid> runs on (its DISPLAY and
XAUTHORITY, as xvfb-run gave them), through the server's XTEST extension, as xdotool types. Python's standard library
only: no xdotool or libXtst here. Each key is text to type ("/home/x"), {Return}, {Escape}, {Tab}, {Ctrl+<letter>},
{click} (a left click at the window's middle), {click:x,y} (at x, y on the screen) or {accept} (on the button at
the window's bottom right, where GTK puts a dialog's accept button). A first key {dialog} waits up to 20 s for a
second window to show beside the app's own (the dialog, which can take seconds under load) and acts on it. Under xvfb, Return in GTK's folder chooser closes
it as cancelled; a person's way through it here is a click in its list, Down to the first folder, and its button. The keys go to the topmost window shown (a dialog just opened):
under xvfb no window manager gives it the keyboard, so this does, and puts the pointer in it.
For test/files-cdp.mjs, which drives the native folder picker (GTK's chooser under xvfb) this way."""
import os
import socket
import struct
import sys
import time

KEYSYMS = {'{Return}': 0xff0d, '{Escape}': 0xff1b, '{Tab}': 0xff09, '{Down}': 0xff54}
SHIFT_L = 0xffe1
CONTROL_L = 0xffe3


def env_of(pid):
    # Chromium writes its process title over its own environment, so the display comes from the nearest parent that
    # still has it (node's electron launcher, or env under xvfb-run).
    while pid and pid != '1':
        with open(f'/proc/{pid}/environ', 'rb') as f:
            pairs = [x.split(b'=', 1) for x in f.read().split(b'\0') if b'=' in x]
        env = {k.decode(errors='replace'): v.decode(errors='replace') for k, v in pairs}
        if 'DISPLAY' in env and 'XAUTHORITY' in env:
            return env
        with open(f'/proc/{pid}/stat') as f:
            pid = f.read().rsplit(')', 1)[1].split()[1]
    raise SystemExit('no DISPLAY and XAUTHORITY in that process or its parents')


def cookie(xauth, number):
    data = open(xauth, 'rb').read()
    i = 0
    while i < len(data):
        i += 2   # family
        fields = []
        for _ in range(4):   # address, number, name, data
            n = struct.unpack('>H', data[i:i + 2])[0]
            fields.append(data[i + 2:i + 2 + n])
            i += 2 + n
        if fields[1].decode() == number and fields[2] == b'MIT-MAGIC-COOKIE-1':
            return fields[3]
    raise SystemExit(f'no MIT-MAGIC-COOKIE-1 for display :{number} in {xauth}')


def pad(n):
    return (4 - n % 4) % 4


class X:
    def __init__(self, number, auth):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(f'/tmp/.X11-unix/X{number}')
        name = b'MIT-MAGIC-COOKIE-1'
        self.s.sendall(struct.pack('<BxHHHHxx', ord('l'), 11, 0, len(name), len(auth)) + name + b'\0' * pad(len(name)) + auth + b'\0' * pad(len(auth)))
        head = self.read(8)
        if head[0] != 1:
            raise SystemExit(f'the X server refused the connection: {self.read(struct.unpack("<H", head[6:8])[0] * 4)[:80]!r}')
        body = self.read(struct.unpack('<H', head[6:8])[0] * 4)
        self.min_keycode, self.max_keycode = body[26], body[27]
        vendor_len = struct.unpack('<H', body[16:18])[0]
        formats = body[21]
        roots = 32 + vendor_len + pad(vendor_len) + 8 * formats
        self.root = struct.unpack('<I', body[roots:roots + 4])[0]

    def read(self, n):
        out = b''
        while len(out) < n:
            chunk = self.s.recv(n - len(out))
            if not chunk:
                raise SystemExit('the X server closed the connection')
            out += chunk
        return out

    def reply(self):
        while True:
            head = self.read(32)
            if head[0] == 0:
                raise SystemExit(f'X error {head[1]} on request {head[10]}')
            if head[0] == 1:
                return head + self.read(struct.unpack('<I', head[4:8])[0] * 4)
            # an event, sent to every client even unasked (MappingNotify, as input comes from XTEST's own keyboard)

    def extension(self, name):
        n = name.encode()
        self.s.sendall(struct.pack('<BxHHxx', 98, (8 + len(n) + pad(len(n))) // 4, len(n)) + n + b'\0' * pad(len(n)))
        r = self.reply()
        if not r[8]:
            raise SystemExit(f'the X server has no {name} extension')
        return r[9]

    def shown(self):
        # QueryTree lists the root's children bottom to top: the last one shown is the one in front
        self.s.sendall(struct.pack('<BxHI', 15, 2, self.root))
        r = self.reply()
        n = struct.unpack('<H', r[16:18])[0]
        kids = struct.unpack(f'<{n}I', r[32:32 + 4 * n])
        out = []
        for w in kids:
            self.s.sendall(struct.pack('<BxHI', 3, 2, w))   # GetWindowAttributes
            if self.reply()[26] == 2:   # map-state Viewable
                self.s.sendall(struct.pack('<BxHI', 14, 2, w))   # GetGeometry
                g = self.reply()
                out.append((w,) + struct.unpack('<hhHH', g[12:20]))
        return out

    def topmost(self):
        shown = self.shown()
        if not shown:
            raise SystemExit('no window is shown')
        return shown[-1]

    def keymap(self):
        count = self.max_keycode - self.min_keycode + 1
        self.s.sendall(struct.pack('<BxHBBxx', 101, 2, self.min_keycode, count))
        r = self.reply()
        per = r[1]
        syms = struct.unpack(f'<{count * per}I', r[32:32 + count * per * 4])
        found = {}
        for k in range(count):
            for level in (0, 1):
                sym = syms[k * per + level] if level < per else 0
                if sym and sym not in found:
                    found[sym] = (self.min_keycode + k, level == 1)
        return found


def main():
    pid, keys = sys.argv[1], sys.argv[2:]
    env = env_of(pid)
    number = env['DISPLAY'].lstrip(':').split('.')[0]
    x = X(number, cookie(env['XAUTHORITY'], number))
    xtest = x.extension('XTEST')
    found = x.keymap()
    if keys[:1] == ['{dialog}']:
        keys = keys[1:]
        end = time.time() + 20
        while len(x.shown()) < 2:
            if time.time() > end:
                raise SystemExit('no dialog showed in 20 s')
            time.sleep(0.2)
        time.sleep(0.5)   # mapped; let it draw and take its first input
    win, wx, wy, ww, wh = x.topmost()
    # the pointer into it (XTEST motion, absolute), then the keyboard to it (SetInputFocus, revert to parent)
    x.s.sendall(struct.pack('<BBHBBxxIIxxxxxxxxhhxxxxxxxB', xtest, 2, 9, 6, 0, 0, x.root, wx + ww // 2, wy + wh // 2, 0))
    x.s.sendall(struct.pack('<BBHII', 42, 2, 3, win, 0))

    def fake(kind, keycode):
        # XTEST FakeInput: type 2 is a key press, 3 its release
        x.s.sendall(struct.pack('<BBHBBxxIIxxxxxxxxhhxxxxxxxB', xtest, 2, 9, kind, keycode, 0, 0, 0, 0, 0))
        time.sleep(0.02)

    def press(sym):
        if sym not in found:
            raise SystemExit(f'no key gives keysym {sym:#x}')
        code, shifted = found[sym]
        shift = found[SHIFT_L][0] if shifted else None
        if shift:
            fake(2, shift)
        fake(2, code)
        fake(3, code)
        if shift:
            fake(3, shift)

    for k in keys:
        if k in KEYSYMS:
            press(KEYSYMS[k])
        elif k == '{click}':
            fake(4, 1)
            fake(5, 1)
        elif k == '{accept}':
            x.s.sendall(struct.pack('<BBHBBxxIIxxxxxxxxhhxxxxxxxB', xtest, 2, 9, 6, 0, 0, x.root, wx + ww - 50, wy + wh - 24, 0))
            time.sleep(0.05)
            fake(4, 1)
            fake(5, 1)
        elif k.startswith('{click:') and k.endswith('}'):
            px, py = (int(v) for v in k[7:-1].split(','))
            x.s.sendall(struct.pack('<BBHBBxxIIxxxxxxxxhhxxxxxxxB', xtest, 2, 9, 6, 0, 0, x.root, px, py, 0))
            time.sleep(0.05)
            fake(4, 1)
            fake(5, 1)
        elif k.startswith('{Ctrl+') and k.endswith('}') and len(k) == 8:
            ctrl = found[CONTROL_L][0]
            fake(2, ctrl)
            press(ord(k[6]))
            fake(3, ctrl)
        else:
            for ch in k:
                press(ord(ch))
        time.sleep(0.15)
    # a round trip, so every request has reached the server before this exits
    x.s.sendall(struct.pack('<BxH', 43, 1))   # GetInputFocus
    x.reply()


if __name__ == '__main__':
    main()




