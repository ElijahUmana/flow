/* FlowTerm: an xterm.js view of one tmux session, driven through window.flow.term (BRIEF 2.2). */
(() => {
  'use strict';

  const FONT_FAMILY = '"SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace';
  const FONT_SIZE = 11.4;
  /* css px per row: the mockup's .cc line-height of 1.55 */
  const ROW_PITCH = FONT_SIZE * 1.55;
  const PANE_POLL_MS = 1500;
  const FIT_DELAY_MS = 40;
  const PARK_MS = 1000;
  const RECHECK_MS = 3000;
  const MIN_FONT_SIZE = 1;
  /* A two-finger pinch sizes a terminal's font (MAC_NOTES 60, line 5), on the board's curve: ZOOM_MIN..ZOOM_MAX of
     FONT_SIZE, resting at 100% until the fingers go ZOOM_HOLD further, the way back. */
  const ZOOM_MIN = 0.5, ZOOM_MAX = 3;
  const ZOOM_HOLD = Math.log(1.12);
  const PINCH_GAP_MS = 220;   // a pinch ends after this long without an event (nav.js GAP_MS)
  /* A terminal title names its window only when it names the conversation (owner, Nov 2 14:54: six agents all "Free
     Code", one "❯"). Claude Code's working glyph stays on it for app.js; the CLI's own name or a prompt line is passed
     on as no title. */
  const SPIN = /^[\u2800-\u28ff✳✻✽✶✢·]\s*/;
  const NOT_A_NAME = /^(?:[❯›>$%#➜λ]|(?:claude|claude code|free code)(?:\s+v?\d[\d.]*)?$)/i;
  function nameFrom(title) {
    const t = String(title || '').trim().replace(SPIN, '').trim();
    return t && !NOT_A_NAME.test(t) ? t : '';
  }
  const ENDED = '[session ended, press return to start again]';
  const DIM = '\x1b[0;38;2;138;138;138m';
  /* A client that dies without cleaning up leaves xterm in tmux's alternate screen with mouse and paste modes on. */
  const RESTORE = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25l\x1b[0m';
  /* User0 in flow-tmux.conf: tmux drops a bracketed paste while a pane is in copy mode (scrolled back), so this key goes
     first and leaves copy mode; otherwise tmux consumes it. A VM pane leaves it through pty instead (send). */
  const LEAVE_COPY_MODE = '\x1b[59999~';
  const PASTE_START = '\x1b[200~';
  const FLOW_FILES = 'application/x-flow-files';
  const PASTED_ON_VM = '~/.flow/pasted-images';

  const THEME = {
    background: '#0c0c0c',
    foreground: '#e8e8e8',
    cursor: '#d0d0d0',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#3d3d42',
    selectionInactiveBackground: '#2c2c30',
    black: '#1c1c1e',
    red: '#ff453a',
    green: '#30d158',
    yellow: '#ffd60a',
    blue: '#0a84ff',
    magenta: '#bf5af2',
    cyan: '#64d2ff',
    white: '#c7c7cc',
    brightBlack: '#8e8e93',
    brightRed: '#ff6961',
    brightGreen: '#5de37b',
    brightYellow: '#ffe066',
    brightBlue: '#409cff',
    brightMagenta: '#da8fff',
    brightCyan: '#8ee3ff',
    brightWhite: '#ffffff',
  };
  const FIND_DECORATIONS = {
    matchBackground: '#4a3128',
    matchBorder: '#7a4a3a',
    matchOverviewRuler: '#7a4a3a',
    activeMatchBackground: '#d77757',
    activeMatchBorder: '#ffd9c9',
    activeMatchColorOverviewRuler: '#d77757',
  };
  const FIND_UP = -1;
  const FIND_DOWN = 1;

  const live = new Map();
  /* hold(true) while a window is resized by hand: fits wait (the box crops meanwhile) and hold(false) runs each waiting
     fit once, so a drag gives each pty one resize, not one per pause (classic-renderer Claude redraws on every one). */
  let held = false;
  const heldFits = new Set();
  function hold(on) {
    held = !!on;
    if (held) return;
    const fits = [...heldFits];
    heldFits.clear();
    fits.forEach((fit) => fit());
  }
  /* Ids whose tmux client kill() ended. Its exit can arrive after a new mount of the same id has registered, so the
     first exit is dropped. If main dropped that client quietly instead, the new mount's open reply comes first and
     clears the id. */
  const killed = new Set();
  let routed = false;

  function route() {
    if (routed) return;
    routed = true;
    window.flow.term.onData((id, data) => { const t = live.get(id); if (t) t.data(data); });
    window.flow.term.onExit((id, code) => {
      if (killed.delete(id)) return;
      const t = live.get(id);
      if (t) t.exit(code);
    });
  }

  /* xterm makes a row floor(ceil(charHeight * dpr) * lineHeight) device px tall, with charHeight measured by
     canvas TextMetrics exactly like this; solve for the lineHeight that gives the mockup's row pitch. */
  function lineHeight(size = FONT_SIZE) {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d');
    ctx.font = `${size}px ${FONT_FAMILY}`;
    const m = ctx.measureText('W');
    const dpr = window.devicePixelRatio;
    return Math.max(1, (((ROW_PITCH * size) / FONT_SIZE) * dpr) / Math.ceil((m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) * dpr));
  }

  /* Dropped paths are escaped with backslashes, the way macOS terminals type them: Claude Code turns those into
     [Image #N] attachments but leaves POSIX '...'\''...' quoting as plain text. A path with control characters keeps
     single quotes (a backslash before a newline would be a line continuation). */
  const shellQuote = (p) => (/[\x00-\x1f\x7f]/.test(p)
    ? `'${p.replace(/'/g, `'\\''`)}'`
    : p.replace(/[^\w@%+=:,./\-\u0080-￿]/g, '\\$&'));

  function mount(container, opts) {
    if (!container) throw new Error('FlowTerm.mount needs a container element');
    const o = opts || {};
    if (!o.id) throw new Error('FlowTerm.mount needs an id');
    const id = String(o.id);
    if (live.has(id)) throw new Error(`FlowTerm: terminal ${id} is already mounted in this window`);
    route();

    const el = document.createElement('div');
    el.className = 'fterm';
    el.innerHTML = '<div class="fterm-box"></div><div class="fterm-mates"></div>'
      + '<div class="fterm-find" hidden><input type="text" spellcheck="false" autocomplete="off" placeholder="find" aria-label="find in this terminal">'
      + '<span class="fterm-n"></span>'
      + '<button type="button" data-find="up" title="next match up (↩)">↑</button>'
      + '<button type="button" data-find="down" title="next match down (⇧↩)">↓</button>'
      + '<button type="button" data-find="close" title="close (esc)">×</button></div>';
    container.appendChild(el);
    const box = el.querySelector('.fterm-box');
    const layer = el.querySelector('.fterm-mates');
    const findBar = el.querySelector('.fterm-find');
    const findInput = findBar.querySelector('input');
    const findCount = findBar.querySelector('.fterm-n');

    let term = null, finder = null;
    let state = 'idle';
    let visible = false, wantFocus = false, restarting = false;
    let sent = { cols: 0, rows: 0 };
    let openSeq = 0, fitTimer = 0, parkTimer = 0, waitTimer = 0, paneTimer = 0, paneBusy = false, paneErr = '';
    let natural = null, statusRows = 0, fitted = '';
    let zoom = 1;
    const fontSize = () => Math.round(FONT_SIZE * zoom * 10) / 10;
    let panes = [];
    let unwatchDpr = null;
    const mates = new Map();

    const sized = () => box.isConnected && box.clientWidth >= 24 && box.clientHeight >= 16;
    const focused = () => { if (o.onFocus) o.onFocus(); };
    /* ⌘-click opens a link at once. A plain click opens it once it has turned out to be a single click: it did not
       move, and no other press came within 300 ms (the lead's choice, under macOS's 500 ms double-click default: a
       slower double-click may also open the link). A drag or a double-click on a link selects it. */
    const LINK_WAIT_MS = 300;
    let linkWait = 0, downAt = null;
    function openLink(e, uri) {
      clearTimeout(linkWait);
      if (!o.onLink) return;
      if (e.metaKey) {
        o.onLink(uri);
        return;
      }
      const still = downAt && downAt.plain && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) <= 2;
      if (!still || e.detail > 1) return;
      linkWait = setTimeout(() => { if (term) o.onLink(uri); }, LINK_WAIT_MS);
    }

    function create() {
      term = new window.Terminal({
        allowProposedApi: true,
        scrollback: 0,
        fontFamily: FONT_FAMILY,
        fontSize: fontSize(),
        lineHeight: lineHeight(fontSize()),
        cursorBlink: false,
        cursorStyle: 'block',
        macOptionClickForcesSelection: true,
        macOptionIsMeta: false,
        minimumContrastRatio: 1,
        theme: THEME,
        /* xterm's own, and tmux's pane border, so a double-click by a border selects a word in that pane only */
        wordSeparator: ' ()[]{}\',"`│',
        linkHandler: { activate: openLink },
      });
      finder = new window.SearchAddon.SearchAddon();
      term.loadAddon(finder);
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon(openLink));
      term.open(box);
      term.onData(send);
      term.onTitleChange((title) => { if (o.onTitle) o.onTitle(nameFrom(title) ? title : ''); });
      /* tmux hands every copy to the outer terminal as OSC 52, Flow's tmux on the Mac or the VM and the VM's own alike;
         this is what puts it on the Mac's clipboard. Writes only: a "?" query, which would read the clipboard, is ignored. */
      term.parser.registerOscHandler(52, (data) => {
        const b64 = data.slice(data.indexOf(';') + 1);
        if (!b64 || b64 === '?') return true;
        let text;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        } catch (err) {
          console.error(`FlowTerm: ${id} sent an OSC 52 copy that is not base64 UTF-8`, err);
          return true;
        }
        navigator.clipboard.writeText(text).catch((err) => console.error(`FlowTerm: OSC 52 copy from ${id} could not be written to the clipboard`, err));
        return true;
      });
      term.attachCustomKeyEventHandler(keys);
      term.textarea.addEventListener('focus', focused);
      box.addEventListener('mousedown', press, true);
      box.addEventListener('pointermove', askSplit);
      document.addEventListener('mousemove', optionMove, true);
      document.addEventListener('mouseup', release, true);
      finder.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (!findInput.value) { findCount.textContent = ''; return; }
        findCount.textContent = resultCount === 0 ? 'no matches' : resultIndex >= 0 ? `${resultIndex + 1} of ${resultCount}` : `${resultCount} matches`;
        findCount.classList.toggle('none', resultCount === 0);
      });
      watchDpr();
      if (wantFocus) { wantFocus = false; term.focus(); }
    }

    function activate() {
      if (term || state === 'disposed' || !visible || !sized()) return;
      create();
      fitNow();
      open();
    }

    function open() {
      state = 'opening';
      const seq = ++openSeq;
      const size = { cols: term.cols, rows: term.rows };
      const req = {
        id, cmd: o.cmd, cwd: o.cwd, host: o.host, attach: o.attach, sessionId: o.sessionId, forkFrom: o.forkFrom,
        resume: restarting ? true : !!o.resume, cols: size.cols, rows: size.rows,
      };
      window.flow.term.open(req).then((r) => r, (err) => {
        console.error(`FlowTerm: flow.term.open failed for ${id}`, err);
        return { ok: false, error: String((err && err.message) || err) };
      }).then((r) => {
        if (state === 'disposed') {
          if (r.ok && !live.has(id)) window.flow.term.detach(id);
          return;
        }
        killed.delete(id);
        if (seq !== openSeq) return;
        if (state === 'opening') {
          if (r.ok) {
            state = 'open';
            sent = size;
            natural = o.attach && r.size ? { cols: r.size.cols, rows: r.size.rows } : null;
            statusRows = natural ? r.size.status || 0 : 0;
            if (natural) fitNow();
            pushSize();
            startPanes();
          } else if (r.retry) {
            /* its conversation is open in another Claude, or that could not be checked: the open goes on once it is
               free, so no onOpened yet */
            state = 'waiting';
            waitNotice(`[${r.error}]`);
            waitTimer = setTimeout(open, RECHECK_MS);
            return;
          } else {
            state = 'failed';
            notice(`[could not start: ${r.error || 'no reason given'}, press return to try again]`);
          }
        }
        if (o.onOpened) o.onOpened(r);
      });
    }

    function restart() {
      restarting = true;
      term.reset();
      open();
    }

    /* A hidden local terminal gives up its tmux client, whose output would keep the renderer busy, and gets a new one
       when shown again. Remote ones stay attached: a new client there is a new ssh connection. */
    function schedulePark() {
      clearTimeout(parkTimer);
      if (!o.host) parkTimer = setTimeout(park, PARK_MS);
    }

    function park() {
      if (visible) return;
      if (state === 'opening' || state === 'waiting') { schedulePark(); return; }
      if (state !== 'open') return;
      state = 'parked';
      window.flow.term.detach(id);
    }

    /* A session that ended while parked shows the ended line instead of starting again unasked. */
    function unpark() {
      state = 'unparking';
      const seq = ++openSeq;
      window.flow.term.exists(id).then((alive) => alive, (err) => {
        console.error(`FlowTerm: flow.term.exists failed for ${id}, attaching anyway`, err);
        return true;
      }).then((alive) => {
        if (state === 'disposed' || seq !== openSeq) return;
        if (!visible) { state = 'parked'; return; }
        if (!alive) {
          state = 'ended';
          notice(ENDED);
          if (o.onExit) o.onExit(null);
          return;
        }
        restarting = true;
        open();
        scheduleFit();
      });
    }

    /* In the alternate screen, which tmux clears as its client starts, so none of it is left once that claude ends. */
    function waitNotice(text) {
      term.write(`${RESTORE}\x1b[?1049h\x1b[H\r\n${DIM}${text}\x1b[0m`);
    }

    function notice(text) {
      term.write(`${RESTORE}\r\n${DIM}${text}\x1b[0m`);
    }

    /* A VM pane's tmux is not this Mac's, so the User0 key cannot take it out of the scrollback: pty leaves copy mode
       there first, and input typed meanwhile waits behind the paste so nothing is reordered. */
    let sendAfter = null;
    function write(data) {
      if (state === 'open' || state === 'opening') window.flow.term.write(id, data);
    }
    function send(data) {
      if (state === 'open' || state === 'opening') {
        const paste = data.startsWith(PASTE_START);
        if (!o.host) { write(paste ? LEAVE_COPY_MODE + data : data); return; }
        if (!paste && !sendAfter) { write(data); return; }
        const before = paste
          ? (sendAfter || Promise.resolve()).then(() => window.flow.term.find(id, { leave: true }, { host: o.host, attach: o.attach }))
            .then((r) => { if (r && !r.ok) console.error(`FlowTerm: ${id} could not leave the scrollback before a paste: ${r.error}`); },
              (err) => console.error(`FlowTerm: ${id} could not leave the scrollback before a paste`, err))
          : sendAfter;
        const next = before.then(() => write(data));
        sendAfter = next;
        next.then(() => { if (sendAfter === next) sendAfter = null; });
      } else if ((state === 'ended' || state === 'failed') && data.includes('\r')) restart();
    }

    function keys(e) {
      if (e.isComposing) return true;
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === 'keydown') { e.preventDefault(); send('\x1b\r'); }
        return false;
      }
      /* Claude Code's own image key is Control-V, which on a VM reads the VM's clipboard, where a Mac image never is
         ("No image found in clipboard. You're SSH'd"). So on a VM terminal Control-V pastes as ⌘V does when this Mac's
         clipboard holds files or an image, and stays the program's Control-V otherwise (the paste listener below). */
      if (o.host && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
        if (e.type === 'keydown' && !ctrlV) {
          e.preventDefault();
          ctrlV = setTimeout(() => { ctrlV = 0; send('\x16'); }, 1000);
          window.flow.nativeEdit('paste');
        }
        return false;
      }
      if (!e.metaKey || e.ctrlKey || e.altKey) return true;
      const k = e.key.toLowerCase();
      /* ⌘K is the app's search: never consumed here, so the menu gets it */
      if (k === 'k') return false;
      if (k === 'f' && !e.shiftKey) {
        if (e.type === 'keydown') { e.preventDefault(); openFind(); }
        return false;
      }
      if (k === 'g' && !findBar.hidden) {
        if (e.type === 'keydown') { e.preventDefault(); search(e.shiftKey ? FIND_DOWN : FIND_UP, false); }
        return false;
      }
      if (k === 'a' && !e.shiftKey) {
        if (e.type === 'keydown') { e.preventDefault(); selectShown(); }
        return false;
      }
      if (k === 'c' && !e.shiftKey && term.hasSelection()) {
        if (e.type === 'keydown') { e.preventDefault(); copy(); }
        return false;
      }
      return true;
    }

    function copy() {
      navigator.clipboard.writeText(selected()).catch((err) => {
        console.error('FlowTerm: clipboard write failed, trying execCommand', err);
        if (!document.execCommand('copy')) console.error('FlowTerm: execCommand copy failed too');
