#!/usr/bin/env python3
"""Does anything in Claude Code depend on tmux's focus reports? Runs the user's own Claude Code twice through tmux with
flow-tmux.conf, focus-events on and then off, one tiny prompt each in a new session, and compares: the screens, the
notification bytes Claude writes (bare BEL, OSC 9, 777, 99) and tmux's bell flag. In each run the terminal loses focus
right after Enter, stays away past Claude's 60 s idle mark and comes back. With focus-events on, the stand-in terminal
(a tmux client in a pty) sends focus in and out as xterm does when tmux asks; with it off, it sends none, as xterm then
does. Uses its own tmux socket, flow-focus-check; never Flow's or the default one.

  python3 test/term-focus-check.py --dir <a folder Claude already trusts> [--out <dir>] [--tmux tmux] [--claude claude]

Prints the two runs and a verdict line. Two sessions are created (their ids are printed); each gets one prompt."""
import argparse, fcntl, os, pty, re, select, struct, subprocess, sys, termios, time, uuid

ap = argparse.ArgumentParser()
ap.add_argument('--dir', required=True, help='working folder for the two Claude sessions; Claude must already trust it')
ap.add_argument('--out', default=os.path.join(os.environ.get('TMPDIR', '/tmp'), 'flow-focus-check'))
ap.add_argument('--tmux', default='tmux')
ap.add_argument('--claude', default='claude', help='as the login shell finds it, the way Flow starts Claude')
ap.add_argument('--conf', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'flow-tmux.conf'))
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
SHELL = os.environ.get('SHELL', '/bin/zsh')
PROMPT = 'Reply with just the word ok.'


def run(mode):
    sid = str(uuid.uuid4())
    T = [args.tmux, '-L', 'flow-focus-check']
    raw = os.path.join(args.out, f'focus-{mode}-raw.out')
    conf = os.path.join(args.out, f'focus-{mode}.conf')
    with open(conf, 'w') as f:
        f.write(f'source-file {os.path.abspath(args.conf)}\nset -g focus-events {mode}\n')
    subprocess.run(T + ['kill-server'], stderr=subprocess.DEVNULL)
    open(raw, 'w').close()
    env = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT')}
    subprocess.run(T + ['-f', conf, 'new-session', '-d', '-s', 'c', '-x', '100', '-y', '30', '-c', args.dir,
                        f"{SHELL} -ilc '{args.claude} --session-id {sid}'"], check=True, env=env)
    subprocess.run(T + ['pipe-pane', '-o', '-t', 'c', f"cat >> '{raw}'"], check=True)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp(args.tmux, T + ['attach', '-t', 'c'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    client = bytearray()

    def pump(t):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    client.extend(os.read(fd, 65536))
                except OSError:
                    return

    def focus(on):
        if mode == 'on':
            os.write(fd, b'\x1b[I' if on else b'\x1b[O')
        pump(0.3)

    def tm(*a):
        return subprocess.run(T + list(a), capture_output=True, text=True).stdout

    steps = []

    def note(label):
        # once the screen has settled (two looks 2 s apart the same): hints such as the effort line come and go
        screen = tm('capture-pane', '-p', '-t', 'c')
        for _ in range(10):
            pump(2.0)
            again = tm('capture-pane', '-p', '-t', 'c')
            if plain(again) == plain(screen):
                break
            screen = again
        steps.append((label, tm('display', '-p', '-t', 'c', '#{window_bell_flag}').strip(), screen))

    pump(1.0)
    focus(True)
    ready = False
    for _ in range(90):
        pump(0.5)
        s = tm('capture-pane', '-p', '-t', 'c')
        if re.search(r'(❯|>)\s', s) and re.search(r'for shortcuts|bypass permissions|shift\+tab|accept edits', s, re.I):
            ready = True
            break
    if re.search(r'trust this folder|Quick safety check', tm('capture-pane', '-p', '-t', 'c'), re.I):
        subprocess.run(T + ['kill-server'])
        os.waitpid(pid, 0)
        sys.exit(f'Claude asks whether to trust {args.dir}; pick a folder it already trusts (this script never answers that)')
    note('ready, focused')
    if not ready:
        subprocess.run(T + ['kill-server'])
        os.waitpid(pid, 0)
        return {'session': sid, 'problems': ['Claude showed no input prompt within 45 s']}, steps
    for ch in PROMPT:
        os.write(fd, ch.encode())
        pump(0.02)
    os.write(fd, b'\r')
    pump(0.5)
    focus(False)
    answered = False
    for _ in range(240):
        pump(0.5)
        s = tm('capture-pane', '-p', '-t', 'c')
        if re.search(r'^\s*[⏺●]\s*ok(ay)?\b', s, re.M | re.I) and not re.search(r'esc to interrupt', s, re.I):
            answered = True
            break
    note('answered while away')
    pump(70)
    note('away 70 s more')
    focus(True)
    pump(6)
    note('back, focused')
    data = open(raw, 'rb').read()
    result = {
        'session': sid,
        'claude asked for focus reports': b'\x1b[?1004h' in data,
        'tmux asked the terminal for them': b'\x1b[?1004h' in client,
        'bare BEL': len(re.sub(rb'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', b'', data).split(b'\x07')) - 1,
        'OSC 9/777/99': [(a.decode(), b.decode()[:60]) for a, b in re.findall(rb'\x1b\](9|777|99);([^\x07\x1b]*)', data)],
        'tmux bell flags': [b for _, b, _ in steps],
    }
    # a run that did not do what it compares says nothing about focus reports
    problems = [] if answered else ['Claude did not answer within 120 s']
    if not result['claude asked for focus reports']:
        problems.append('Claude never asked for focus reports')
    if result['tmux asked the terminal for them'] != (mode == 'on'):
        problems.append(f"tmux {'did not ask' if mode == 'on' else 'asked'} the terminal for focus reports")
    result['problems'] = problems
    subprocess.run(T + ['kill-server'])
    os.waitpid(pid, 0)
    return result, steps


def plain(screen):
    """a screen without what differs from turn to turn anyway: the spinner's word, its seconds and the clock"""
    s = re.sub(r'^\s*[✻✳✶✽✢·*]\s*\w+ for \d+s.*$', '<spinner>', screen, flags=re.M)
    return re.sub(r'\d{1,2}:\d{2}\s*[AP]M', '<time>', s)


results = {}
for mode in ('on', 'off'):
    r, steps = run(mode)
    results[mode] = (r, steps)
    print(f'== focus-events {mode}: Claude session {r["session"]} created in {args.dir}')
    for k, v in r.items():
        if k != 'session':
            print(f'   {k}: {v}')
    for label, bell, screen in steps:
        print(f'   --- {label} (tmux bell flag {bell})')
        print('\n'.join('      ' + l for l in screen.split('\n') if l.strip()))
invalid = [f'focus-events {m}: {p}' for m in ('on', 'off') for p in results[m][0]['problems']]
if invalid:
    print(f'\nINVALID, no verdict: {"; ".join(invalid)} (logs in {args.out})')
    sys.exit(2)
(on, s_on), (off, s_off) = results['on'], results['off']
same_screens = [plain(a[2]) == plain(b[2]) for a, b in zip(s_on, s_off)]
same = all(same_screens) and on['bare BEL'] == off['bare BEL'] and on['OSC 9/777/99'] == off['OSC 9/777/99'] \
    and on['tmux bell flags'] == off['tmux bell flags']
print(f'\nverdict: {"no difference" if same else "DIFFERENT"} between focus-events on and off '
      f'(screens same at each step: {same_screens}; logs in {args.out})')
sys.exit(0 if same else 1)




