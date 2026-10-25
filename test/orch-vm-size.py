# Reproduces what a VM "attach" window does to the shared VM tmux window: with the VM's ~/.tmux.conf (window-size
# latest, aggressive-resize on), a Flow-sized client attaching to session ccm shrinks the whole window and every pane
# for every other client, and it flips back whenever the other client types. Runs on its own socket only.
# usage: python3 test/orch-vm-size.py [extra attach flags, e.g. -f ignore-size]
import os, pty, sys, time, fcntl, termios, struct, select, subprocess

SOCK = 'flow-dev-orch-vmsim'
CONF = os.path.expanduser('~/.tmux.conf')
EXTRA = sys.argv[1:]
T = ['tmux', '-L', SOCK, '-f', CONF]


def tmux(*a):
    return subprocess.run(T + list(a), capture_output=True, text=True).stdout.strip()


def sizes():
    return f"window {tmux('list-windows', '-t', 'ccm', '-F', '#{window_width}x#{window_height}')}, panes " + \
        ' '.join(tmux('list-panes', '-t', 'ccm', '-F', '#{pane_width}x#{pane_height}').split('\n'))


def client(cols, rows, flags):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp('tmux', T + ['attach'] + flags + ['-t', 'ccm'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.kill(pid, 28)
    return pid, fd


def drain(fds, secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select(fds, [], [], 0.1)
        for fd in r:
            try:
                os.read(fd, 65536)
            except OSError:
                pass


subprocess.run(T + ['kill-server'], capture_output=True)
tmux('new-session', '-d', '-s', 'ccm', '-x', '200', '-y', '50', 'cat')
tmux('split-window', '-h', '-t', 'ccm', 'cat')
for _ in range(3):
    tmux('split-window', '-v', '-t', 'ccm', 'cat')
print(f"VM conf: window-size {tmux('show', '-gv', 'window-size')}, aggressive-resize {tmux('show', '-gwv', 'aggressive-resize')}")
a_pid, a_fd = client(200, 50, [])
drain([a_fd], 1.5)
print('a 200x50 terminal attached:        ' + sizes())
b_pid, b_fd = client(80, 22, EXTRA)
drain([a_fd, b_fd], 1.5)
print(f"Flow-sized 80x22 attach {' '.join(EXTRA) or ''}: ".ljust(35) + sizes())
os.write(a_fd, b' ')
drain([a_fd, b_fd], 1.5)
print('the 200x50 terminal typed a key:   ' + sizes())
for p in (a_pid, b_pid):
    os.kill(p, 15)
subprocess.run(T + ['kill-server'], capture_output=True)




