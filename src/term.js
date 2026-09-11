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
      });
    }

    /* A drag selects here: xterm draws it as the pointer moves, where tmux drew it through the pty and back, a step
       behind (owner, Nov 2: "highlighting is not smooth"). Letting go of a drag or a double or triple click copies it,
       and it stays highlighted until the next click. While tmux has the mouse, xterm selects only for a press with its
       force key, so a plain or Shift press goes on with that key; a click without a drag is then handed to tmux as
       before (a pane, a program that takes clicks). A Shift-click extends the selection to it and copies. An Option
       press goes on without Option, to tmux, which selects in a shell, or to a program that takes the mouse, as Claude
       does. Right, middle, ⌘ and Control presses are as they were. With two or more panes a selection stays in the
       pane it started in: its highlight is clipped to that pane and only that pane's part of each row is copied. A
       press on a border goes to tmux, which moves the border. */
    const ours = new WeakSet();
    let pressed = null, presses = 0, force, option = false, inPane = null;
    /* The force key is asked of xterm itself, so it follows xterm's own platform test (Option with
       macOptionClickForcesSelection on the Mac, Shift elsewhere); one that would start a column selection does not do. */
    function forceKey() {
      if (force === undefined) {
        const svc = term._core._selectionService;
        force = ['altKey', 'shiftKey'].find((k) => svc.shouldForceSelection({ [k]: true }) && !svc.shouldColumnSelect({ [k]: true })) || null;
        if (!force) console.error(`FlowTerm: xterm forces a selection with no key here, so ${id} keeps tmux's selection`);
      }
      return force;
    }
    /* Option is xterm's force key on the Mac, and tmux reads an Option drag as M-MouseDrag1Pane, which nothing is bound
       to; so every event of an Option drag reaches xterm's mouse reporting as a plain one. */
    const unOption = (e) => Object.defineProperty(e, 'altKey', { value: false });
    function optionMove(e) {
      if (option) unOption(e);
    }
    /* Nobody polls the panes of a terminal that is not a team or attached, yet it can be split by hand: its panes are
       asked of tmux on each press, and while the pointer moves over it at most every 2 s. */
    let split = [], splitAsk = null, splitAsked = 0, splitErr = '';
    function askSplit(now) {
      if (paneTimer || o.panesFrom === 'app' || state !== 'open' || (now !== true && Date.now() - splitAsked < 2000)) return;
      splitAsked = Date.now();
      splitAsk = window.flow.term.panes(id, o.host ? { host: o.host, attach: o.attach } : undefined).then((list) => {
        split = Array.isArray(list) ? list : [];
        splitErr = '';
      }, (err) => {
        const msg = String((err && err.message) || err);
        if (msg !== splitErr) console.error(`FlowTerm: flow.term.panes failed for ${id}`, err);
        splitErr = msg;
      });
    }
    const mouseEv = (type, p, init) => new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0,
      detail: p.detail, clientX: p.x, clientY: p.y, screenX: p.sx, screenY: p.sy, ...init });
    /* the cell under a point, as an index into the buffer's rows */
    function cellAt(x, y) {
      const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      const col = Math.min(term.cols - 1, Math.max(0, Math.floor(((x - r.left) * term.cols) / r.width)));
      const row = Math.min(term.rows - 1, Math.max(0, Math.floor(((y - r.top) * term.rows) / r.height)));
      return (row + term.buffer.active.viewportY) * term.cols + col;
    }
    const selectCells = (from, to) => term.select(from % term.cols, Math.floor(from / term.cols), to - from);
    /* null with fewer than two panes; else the pane the cell is in, undefined on a border */
    function paneAt(cell) {
      const list = paneTimer || o.panesFrom === 'app' ? panes : split;
      if (list.length < 2) return null;
      const x = cell % term.cols, y = Math.floor(cell / term.cols) - term.buffer.active.viewportY;
      return list.find((p) => x >= p.left && x < p.left + p.width && y >= p.top && y < p.top + p.height);
    }
    function clampTo(p, cell) {
      const top = p.top + term.buffer.active.viewportY;
      const x = Math.min(p.left + p.width - 1, Math.max(p.left, cell % term.cols));
      const y = Math.min(top + p.height - 1, Math.max(top, Math.floor(cell / term.cols)));
      return y * term.cols + x;
    }
    /* xterm's selection runs across the terminal's whole width, so in one pane of several what it draws is clipped */
    function clip() {
      const layer = term.element.querySelector('.xterm-selection');
      if (!layer) return;
      if (!inPane) {
        layer.style.clipPath = '';
        return;
      }
      const { width: w, height: h } = term._core._renderService.dimensions.css.cell;
      const l = inPane.left * w, t = inPane.top * h, r = (inPane.left + inPane.width) * w, b = (inPane.top + inPane.height) * h;
      layer.style.clipPath = `polygon(${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px)`;
    }
    /* the selection as text; in one pane of several, that pane's part of each row */
    function selected() {
      if (!inPane) return term.getSelection();
      const pos = term.getSelectionPosition();
      if (!pos) return '';
      const p = inPane, buf = term.buffer.active, top = p.top + buf.viewportY, rows = [];
      for (let y = Math.max(pos.start.y, top); y <= Math.min(pos.end.y, top + p.height - 1); y++) {
        if (y === pos.end.y && pos.end.x === 0 && y > pos.start.y) break;
        const from = y === pos.start.y ? Math.max(pos.start.x, p.left) : p.left;
        const to = y === pos.end.y ? Math.min(pos.end.x, p.left + p.width) : p.left + p.width;
        const line = buf.getLine(y);
        /* xterm trims only at the end of the whole row, which runs on into the next pane */
        rows.push(line && to > from ? line.translateToString(false, from, to).replace(/\s+$/, '') : '');
      }
      return rows.join('\n');
    }
    /* Select All: what the terminal shows; with two or more panes, tmux's active pane. Not xterm's selectAll, which also
       takes the lines a resize left above the screen. It selects at once with the panes known now, and again if tmux's
       answer about them (asked now, for a terminal split by hand) differs, unless a press came in between. */
    function selectShown() {
      if (!term) return;
      const pick = () => {
        const list = paneTimer || o.panesFrom === 'app' ? panes : split;
        inPane = list.length > 1 ? list.find((p) => p.active) || null : null;
        const y = term.buffer.active.viewportY;
        if (inPane) selectCells((y + inPane.top) * term.cols + inPane.left, (y + inPane.top + inPane.height - 1) * term.cols + inPane.left + inPane.width);
        else selectCells(y * term.cols, (y + term.rows) * term.cols);
        clip();
        return JSON.stringify(inPane && [inPane.left, inPane.top, inPane.width, inPane.height]);
      };
      const was = pick(), n = presses;
      askSplit(true);
      Promise.resolve(splitAsk).then(() => {
        if (term && n === presses && term.hasSelection() && !(paneTimer || o.panesFrom === 'app')) {
          const list = split;
          const now = list.length > 1 ? list.find((p) => p.active) || null : null;
          if (JSON.stringify(now && [now.left, now.top, now.width, now.height]) !== was) pick();
        }
      });
    }
    /* the selection from its far end to the cell under the pointer, as Shift-click does in a Mac app */
    function extendTo(e) {
      const { start, end } = term.getSelectionPosition();
      const at = inPane ? clampTo(inPane, cellAt(e.clientX, e.clientY)) : cellAt(e.clientX, e.clientY);
      const s = start.y * term.cols + start.x, en = end.y * term.cols + end.x;
      if (at < (s + en) / 2) selectCells(at, en);
      else selectCells(s, at + 1);
      copy();
    }
    function press(e) {
      /* a right-click on a selection is for the terminal's menu: reported to tmux it would be input, which clears the
         selection before the menu opens */
      if (e.button === 2 && term && !ours.has(e) && term.hasSelection() && term.element.contains(e.target) && window.flow.menu && window.flow.menu.popup) {
        e.stopImmediatePropagation();
        return;
      }
      if (ours.has(e) || !term || e.button !== 0 || !term.element.contains(e.target)) return;
      presses += 1;
      clearTimeout(linkWait);
      downAt = { x: e.clientX, y: e.clientY, plain: !(e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) };
      option = false;
      if (term.modes.mouseTrackingMode === 'none' || !forceKey() || e.metaKey || e.ctrlKey) return;
      if (e.altKey) {
        option = true;
        unOption(e);
        term.clearSelection();
        return;
      }
      askSplit(true);
      const at = cellAt(e.clientX, e.clientY), pane = paneAt(at);
      if (pane === undefined) {
        term.clearSelection();
        return;
      }
      if (e.shiftKey && term.hasSelection() && (pane && pane.paneId) === (inPane && inPane.paneId)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        term.focus();
        extendTo(e);
        return;
      }
      inPane = pane;
      pressed = { target: e.target, x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, detail: e.detail, at };
      e.stopImmediatePropagation();
      e.preventDefault();
      const f = mouseEv('mousedown', pressed, { buttons: 1, [force]: true });
      ours.add(f);
      e.target.dispatchEvent(f);
      clip();
    }
    function release(e) {
      if (option) {
        unOption(e);
        if (!e.buttons) option = false;
        return;
      }
      if (!pressed || ours.has(e) || e.button !== 0) return;
      const p = pressed, moved = Math.hypot(e.clientX - p.x, e.clientY - p.y) > 2, ask = splitAsk, n = presses;
      pressed = null;
      setTimeout(() => {
        if (!term) return;
        if (term.hasSelection() && (moved || p.detail > 1)) {
          /* the panes as tmux has them now, which a split made since the last look changes; a press since then has a
             selection of its own, which this must not redo */
          Promise.resolve(ask).then(() => {
            if (!term || n !== presses || !term.hasSelection()) return;
            const pane = paneAt(p.at);
            if (pane === undefined) {
              term.clearSelection();
              return;
            }
            inPane = pane;
            /* xterm ends a drag at the cell edge nearest the pointer; a drag takes in the letters it starts and ends on */
            if (moved && p.detail === 1) {
              const b = inPane ? clampTo(inPane, cellAt(e.clientX, e.clientY)) : cellAt(e.clientX, e.clientY);
              selectCells(Math.min(p.at, b), Math.max(p.at, b) + 1);
            }
            clip();
            copy();
          });
          return;
        }
        if (moved || p.detail > 1) return;
        /* on the screen element, which stays; the row xterm drew under the press may have been drawn again since */
        const screen = term.element.querySelector('.xterm-screen');
        const down = mouseEv('mousedown', p, { buttons: 1 });
        ours.add(down);
        screen.dispatchEvent(down);
        const up = mouseEv('mouseup', p, { buttons: 0 });
        ours.add(up);
        document.dispatchEvent(up);
      }, 0);
    }

    /* addon-fit divides by xterm's css cell width, which xterm derives as round(cols * charWidth) / cols, so its answer
       depends on the current column count and can land one column short until a second fit. The device cell size
       does not depend on cols. */
    function propose() {
      const cell = term._core._renderService.dimensions.device.cell;
      const dpr = window.devicePixelRatio;
      if (!(cell.width > 0) || !(cell.height > 0)) return null;
      const cs = getComputedStyle(box);
      return {
        cols: Math.max(2, Math.floor((parseFloat(cs.width) * dpr) / cell.width)),
        rows: Math.max(1, Math.floor((parseFloat(cs.height) * dpr) / cell.height)),
      };
    }

    function fitNow() {
      if (!term || !sized()) return;
      if (!natural && term.options.fontSize !== fontSize()) { setFont(fontSize()); fitted = ''; }
      const d = natural ? fitFont(natural) : propose();
      if (!d) return;
      if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows);
      pushSize();
      layoutMates();
    }

    /* A VM window attached with ignore-size is shown at that window's own size (natural: from open, then from the
       panes' extent plus tmux's status lines): xterm keeps its cols x rows and the font shrinks until it fits, never
       above FONT_SIZE. A smaller font rather than a CSS scale keeps mouse cells, selection and links exact. */
    function fitFont(n) {
      const cs = getComputedStyle(box);
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      const key = `${n.cols}x${n.rows} in ${w}x${h}`;
      if (key === fitted) return n;
      const dpr = window.devicePixelRatio;
      const need = () => {
        const cell = term._core._renderService.dimensions.device.cell;
        return Math.max((n.cols * cell.width) / dpr / w, (n.rows * cell.height) / dpr / h);
      };
      setFont(FONT_SIZE);
      let size = FONT_SIZE;
      const over = need();
      if (over > 1) {
        size = Math.max(MIN_FONT_SIZE, Math.floor((FONT_SIZE / over) * 10) / 10);
        setFont(size);
        while (need() > 1 && size > MIN_FONT_SIZE) {
          size = Math.round((size - 0.1) * 10) / 10;
          setFont(size);
        }
      }
      fitted = key;
      return n;
    }

    function setFont(size) {
      if (term.options.fontSize === size) return;
      term.options.fontSize = size;
      term.options.lineHeight = lineHeight(size);
    }

    /* nav.js hands a pinch over this window to what is under the fingers as 'flow-pinch' { factor, x, y, t }. The font
       follows the fingers; once they rest, cols and rows follow the new font with one resize, as at the end of a window
       drag, since every resize redraws the program. A VM window shown at its own size (natural) keeps the font that
       fits it: its cols and rows are that window's. */
    let pinch = null;
    el.addEventListener('flow-pinch', (e) => {
      e.stopPropagation();
      const d = e.detail || {}, f = +d.factor;
      if (!term || natural || !(f > 0) || !Number.isFinite(f)) return;
      const t = Number.isFinite(+d.t) ? +d.t : Date.now();
      if (!pinch || t - pinch.last > PINCH_GAP_MS) pinch = { last: t, hold: null, timer: 0 };
      pinch.last = Math.max(pinch.last, t);
      const was = Math.log(zoom), step = Math.log(f);
      let lz = was + step;
      if (pinch.hold !== null) pinch.hold += step;
      else if (was !== 0 && Math.sign(lz) !== Math.sign(was)) pinch.hold = 0;   // the step that crosses 100% stops there
      if (pinch.hold !== null) {
        lz = Math.abs(pinch.hold) < ZOOM_HOLD ? 0 : pinch.hold - Math.sign(pinch.hold) * ZOOM_HOLD;
        if (lz !== 0) pinch.hold = null;
      }
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.exp(lz)));
      setFont(fontSize());
      const p = pinch;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        if (pinch === p) pinch = null;
        if (state === 'disposed') return;
        if (held) heldFits.add(fitNow);
        else fitNow();
      }, PINCH_GAP_MS);
    });

    function pushSize() {
      if (state !== 'open' || (sent.cols === term.cols && sent.rows === term.rows)) return;
      sent = { cols: term.cols, rows: term.rows };
      window.flow.term.resize(id, term.cols, term.rows);
    }

    function scheduleFit() {
      if (state === 'disposed') return;
      if (!term) { activate(); return; }
      clearTimeout(fitTimer);
      if (held) heldFits.add(fitNow);
      else fitTimer = setTimeout(fitNow, FIT_DELAY_MS);
    }

    function watchDpr() {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const changed = () => {
        unwatchDpr();
        if (!term) return;
        term.options.lineHeight = lineHeight(term.options.fontSize);
        fitted = '';
        scheduleFit();
        watchDpr();
      };
      mq.addEventListener('change', changed);
      unwatchDpr = () => mq.removeEventListener('change', changed);
    }

    /* ---------- team: a grab handle on each pane's title row ---------- */
    /* With panesFrom: 'app' the app's single poller (teams.js, only what is on screen) hands the list to setPanes. */
    function startPanes() {
      if (!(o.team || natural) || o.panesFrom === 'app' || paneTimer || !visible || state !== 'open') return;
      pollPanes();
      paneTimer = setInterval(pollPanes, PANE_POLL_MS);
    }

    function stopPanes() {
      clearInterval(paneTimer);
      paneTimer = 0;
    }

    function pollPanes() {
      if (paneBusy) return;
      paneBusy = true;
      window.flow.term.panes(id, o.host ? { host: o.host, attach: o.attach } : undefined).then((list) => {
        paneBusy = false;
        paneErr = '';
        if (state === 'open') takePanes(list);
      }, (err) => {
        paneBusy = false;
        const msg = String((err && err.message) || err);
        if (msg !== paneErr) console.error(`FlowTerm: flow.term.panes failed for ${id}`, err);
        paneErr = msg;
      });
    }

    function takePanes(list) {
      panes = Array.isArray(list) ? list : [];
      /* a selection in a pane that moved, changed size or went no longer covers what it did */
      if (inPane) {
        const now = panes.find((p) => p.paneId === inPane.paneId);
        if (!now || ['left', 'top', 'width', 'height'].some((k) => now[k] !== inPane[k])) {
          inPane = null;
          if (term) {
            term.clearSelection();
            clip();
          }
        }
      }
      if (natural && panes.length) {
        const cols = Math.max(...panes.map((p) => p.left + p.width));
        const rows = Math.max(...panes.map((p) => p.top + p.height)) + statusRows;
        if (cols !== natural.cols || rows !== natural.rows) {
          natural = { cols, rows };
          fitNow();
          return;
        }
      }
      layoutMates();
    }

    function mateEl(entry) {
      const m = document.createElement('div');
      m.className = 'fterm-mate';
      m.title = 'drag this teammate out to make it its own window';
      m.innerHTML = '<i></i>';
      m.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (o.onMateDragStart) o.onMateDragStart(entry.pane, e);
      });
      return m;
    }

    function layoutMates() {
      if (!o.team) return;
      const keep = new Set();
      if (term && state === 'open' && panes.length > 1) {
        /* the same cell size addon-fit reads */
        const cell = term._core._renderService.dimensions.css.cell;
        const x0 = box.offsetLeft, y0 = box.offsetTop;
        for (const p of panes) {
          keep.add(p.paneId);
          let entry = mates.get(p.paneId);
          if (!entry) {
            entry = { pane: p, el: null };
            entry.el = mateEl(entry);
            mates.set(p.paneId, entry);
            layer.appendChild(entry.el);
          }
          entry.pane = p;
          /* pane-border-status top draws the pane title on the row just above the pane */
          const titled = p.top > 0;
          const cols = titled ? Math.max(2, Math.min(p.width, String(p.title || '').length + 5)) : 2;
          const left = titled ? p.left : p.left + Math.max(0, p.width - 2);
          const s = entry.el.style;
          s.left = `${x0 + left * cell.width}px`;
          s.top = `${y0 + (titled ? p.top - 1 : p.top) * cell.height}px`;
          s.width = `${cols * cell.width}px`;
          s.height = `${cell.height}px`;
          s.setProperty('--cw', `${cell.width}px`);
          entry.el.classList.toggle('active', !!p.active);
        }
      }
      for (const [paneId, entry] of mates) {
        if (keep.has(paneId)) continue;
        entry.el.remove();
        mates.delete(paneId);
      }
    }

    /* ---------- find bar ---------- */
    /* ⌘F finds in the whole history, which tmux keeps (scrollback 0 here): flow.term.find runs tmux's copy mode on the
       active pane, which shows each match where it is. Typing finds the nearest match up from where the view was, ↩ the
       next one up, ⇧↩ the next one down. Closing the bar keeps the view there; a key, or scrolling down to the end, goes
       back to the end, as after the wheel. tmux has no count, so the bar says only "no matches". Finds run one at a
       time, in order, and a newer text replaces one not sent yet. An attach window, whose tmux is not Flow's, finds on
       its screen with xterm's search. */
    let finds = [], finding = false, foundInTmux = false;
    const viaTmux = () => !o.attach && state === 'open' && !!window.flow.term.find;

    function openFind() {
      if (!term) return;
      findBar.hidden = false;
      findInput.focus();
      findInput.select();
    }

    function closeFind() {
      findBar.hidden = true;
      findCount.textContent = '';
      if (!term) return;
      if (foundInTmux) tmuxFind({ done: true });
      foundInTmux = false;
      finder.clearDecorations();
      term.focus();
    }

    /* dir: FIND_UP or FIND_DOWN; incremental: the text changed, so the nearest match up from where this find started */
    function search(dir, incremental) {
      if (!term) return;
      /* find selects or shows its match wherever it is, so a pane's clip from an earlier drag must not hide or cut it */
      inPane = null;
      clip();
      const text = findInput.value;
      if (viaTmux()) {
        /* the rows under an xterm selection are about to show other lines */
        term.clearSelection();
        foundInTmux = true;
        /* tmux matches any case for lowercase text, as this bar always has */
        tmuxFind({ text: text.toLowerCase(), step: incremental ? 0 : dir === FIND_UP ? 1 : -1 });
        return;
      }
      if (!text) {
        finder.clearDecorations();
        term.clearSelection();
        findCount.textContent = '';
        findCount.classList.remove('none');
        return;
      }
      const options = { caseSensitive: false, incremental, decorations: FIND_DECORATIONS };
      if (dir === FIND_UP) finder.findPrevious(text, options);
      else finder.findNext(text, options);
    }

    function tmuxFind(op) {
      const last = finds[finds.length - 1];
      if (op.step === 0 && last && last.step === 0) finds[finds.length - 1] = op;
      else finds.push(op);
      if (!finding) nextFind();
    }

    function nextFind() {
      const op = finds.shift();
      finding = !!op;
      if (!op) return;
      window.flow.term.find(id, op, o.host ? { host: o.host } : undefined).then((r) => r, (err) => ({ ok: false, error: String((err && err.message) || err) })).then((r) => {
        if (!r.ok) console.error(`FlowTerm: find in ${id} failed: ${r.error}`);
        if (state !== 'disposed' && !op.done && !findBar.hidden) {
          const none = r.ok && !!op.text && !r.found;
          findCount.textContent = !r.ok ? 'could not search' : none ? 'no matches' : '';
          findCount.classList.toggle('none', !r.ok || none);
        }
        nextFind();
      });
    }

    findInput.addEventListener('input', () => search(FIND_UP, true));
    findInput.addEventListener('focus', focused);
    findInput.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Enter') { e.preventDefault(); search(e.shiftKey ? FIND_DOWN : FIND_UP, false); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      else if (e.metaKey && k === 'f') { e.preventDefault(); findInput.select(); }
      else if (e.metaKey && k === 'g') { e.preventDefault(); search(e.shiftKey ? FIND_DOWN : FIND_UP, false); }
    });
    findBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-find]');
      if (!b) return;
      if (b.dataset.find === 'close') { closeFind(); return; }
      search(b.dataset.find === 'up' ? FIND_UP : FIND_DOWN, false);
      findInput.focus();
    });

    /* ---------- events on the whole view ---------- */
    /* Typing in a terminal never triggers the app's single-key shortcuts; ⌘ combos still reach the app and menu. */
    el.addEventListener('keydown', (e) => { if (!e.metaKey) e.stopPropagation(); });

    /* In tmux mouse mode xterm cancels every wheel event, so sideways swipes are handed to the app from above. */
    el.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !el.parentElement) return;
      e.stopPropagation();
      if (!el.parentElement.dispatchEvent(new WheelEvent('wheel', e))) e.preventDefault();
    }, { capture: true, passive: false });

    /* ⌘V of files copied in Finder (the paste carries them as Files) types their paths the way a drop does. ⌘V with no
       text on the clipboard: main saves a clipboard image as a PNG and its path is pasted the same way as a dropped
       file, so Claude Code attaches it as [Image #N]; on a VM terminal it is put there first. Text pastes stay with
       xterm. Capture on the root runs before xterm's own paste handler. */
    /* the Edit menu's Copy and execCommand('copy') reach xterm's own copy, which takes whole rows */
    el.addEventListener('copy', (e) => {
      if (!term || !inPane || !term.hasSelection()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.clipboardData.setData('text/plain', selected());
    }, true);
    /* A right-click on the terminal's screen is the terminal's own menu, as in Terminal.app: Copy, Paste, Select All, the
       same as ⌘C, ⌘V and ⌘A, and no Cut (owner's right-click Cut/Copy/Paste, batch 10). The window's menu (fork, move)
       is on its title bar. A program that takes the mouse still gets the right-click itself. */
    el.addEventListener('contextmenu', (e) => {
      if (!term || !term.element.contains(e.target) || !(window.flow.menu && window.flow.menu.popup)) return;
      e.preventDefault();
      e.stopPropagation();
      const items = [
        { id: 'copy', label: 'Copy', enabled: term.hasSelection() },
        { id: 'paste', label: 'Paste', enabled: true },
        { type: 'separator' },
        { id: 'all', label: 'Select All', enabled: true },
      ];
      window.flow.menu.popup(items, { x: e.clientX, y: e.clientY }).then((chosen) => {
        if (!term) return;
        if (chosen === 'copy') copy();
        else if (chosen === 'all') selectShown();
        else if (chosen === 'paste') {
          /* main pastes into xterm's input as the Edit menu's Paste does, so it is the page's own paste, as ⌘V: files and
             images as well as text, and out of the scrollback first */
          term.focus();
          window.flow.nativeEdit('paste');
        }
      }, (err) => console.error(`FlowTerm: the terminal menu of ${id} could not open`, err));
    });
    el.addEventListener('paste', (e) => {
      if (!term || e.target !== term.textarea) return;
      const viaCtrlV = !!ctrlV;
      clearTimeout(ctrlV);
      ctrlV = 0;
      const dt = e.clipboardData;
      if (!dt) { if (viaCtrlV) send('\x16'); return; }
      const rows = Array.from(dt.files, (f) => ({ host: null, path: window.flow.pathForFile(f) })).filter((r) => r.path);
      if (rows.length) {
        e.preventDefault();
        e.stopPropagation();
        bring(rows).then((paths) => { if (paths) typePaths(paths); });
        return;
      }
      if (viaCtrlV) {
        e.preventDefault();
        e.stopPropagation();
        pasteImage().then((done) => { if (!done) send('\x16'); });
        return;
      }
      /* xterm takes the text but lets Chromium put it in its hidden input too, where Select All would find it */
      if (dt.getData('text/plain')) {
        setTimeout(() => { if (term) term.textarea.value = ''; }, 0);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      pasteImage();
    }, true);
    /* A clipboard image: main saves it as a PNG on this Mac, and on a VM terminal it is put into ~/.flow/pasted-images
       there first; its path is typed as a dropped file's is, so Claude Code attaches it. Resolves false when the
       clipboard holds no image. */
    let ctrlV = 0;   // the timer that sends Control-V itself if the paste a VM terminal's Control-V asked for never comes
    function pasteImage() {
      return window.flow.saveClipboardImage().then((file) => {
        if (!file) return false;
        if (!o.host) { typePaths([file]); return true; }
        return bring([{ host: null, path: file }], PASTED_ON_VM).then((paths) => { if (paths) typePaths(paths); return true; });
      }, (err) => {
        console.error(`FlowTerm: could not save the clipboard image for ${id}`, err);
        cannot(`the image on the clipboard could not be saved: ${(err && err.message) || err}`);
        return true;
      });
    }

    /* Files come from Finder ('Files') or from Flow's files group: FLOW_FILES is JSON [{ host, path }], host null on
       this Mac, path absolute on that machine. */
    const dragTypes = (e) => (e.dataTransfer ? Array.from(e.dataTransfer.types) : []);
    const hasFiles = (e) => dragTypes(e).some((t) => t === 'Files' || t === FLOW_FILES);
    function flowRows(raw) {
      let rows;
      try {
        rows = JSON.parse(raw);
      } catch (err) {
        console.error(`FlowTerm: ${id} got a ${FLOW_FILES} drop that is not JSON`, err);
        return [];
      }
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r.path === 'string' && r.path) : [];
    }
    /* Why a drop typed nothing, for the app to say (the one kind of notice the owner keeps). */
    function cannot(text) {
      if (o.onCannot) o.onCannot(text);
      else console.error(`FlowTerm: ${id}: ${text}`);
    }
    function typePaths(paths) {
      if (term && (state === 'open' || state === 'opening')) term.paste(`${paths.map(shellQuote).join(' ')} `);
    }
    /* Files on the other machine are carried first (vmfiles through flow.files): a Mac file to a VM terminal is put
       into the workspace's VM folder (vmFolder, or dir), a VM file to a Mac terminal is copied into the Mac's downloads
       and the app hears of it (onDownload). Resolves the paths to type in order, or null after saying why. */
    function bring(rows, dir) {
      const here = o.host || null;
      return Promise.all(rows.map(async (r) => {
        const from = r.host || null;
        const name = r.path.split('/').pop();
        if (from === here) return { path: r.path };
        if (from && here) return { error: `${name} is on ${from}, and this terminal runs on ${here}` };
        try {
          const res = here
            ? await window.flow.files.put(r.path, here, dir || o.vmFolder || '~', { make: !!dir })
            : await window.flow.files.copy(from, r.path);
          if (!res || !res.ok) return { error: `${name}: ${(res && res.error) || 'no answer'}` };
          if (!here && o.onDownload) o.onDownload(res.file);
          return { path: here ? res.path : res.file };
        } catch (err) {
          console.error(`FlowTerm: could not carry ${r.path} for ${id}`, err);
          return { error: `${name}: ${(err && err.message) || err}` };
        }
      })).then((landed) => {
        const failed = landed.find((x) => x.error);
        if (failed) { cannot(failed.error); return null; }
        return landed.map((x) => x.path);
      });
    }
    el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('fterm-drop');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('fterm-drop'); });
    el.addEventListener('drop', (e) => {
      el.classList.remove('fterm-drop');
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!term) return;
      const rows = dragTypes(e).includes(FLOW_FILES)
        ? flowRows(e.dataTransfer.getData(FLOW_FILES))
        : Array.from(e.dataTransfer.files, (f) => ({ host: null, path: window.flow.pathForFile(f) })).filter((r) => r.path);
      if (!rows.length) return;
      term.focus();
      bring(rows).then((paths) => { if (paths) typePaths(paths); });
    });

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(box);

    const internal = {
      data(data) { if (term) term.write(data); },
      exit(code) {
        if (state !== 'open' && state !== 'opening') return;
        state = 'ended';
        stopPanes();
        panes = [];
        layoutMates();
        notice(ENDED);
        if (o.onExit) o.onExit(code);
      },
    };
    live.set(id, internal);

    /* returns whether this window still had (or was getting) a tmux client */
    function teardown() {
      if (state === 'disposed') return false;
      const attached = state === 'open' || state === 'opening';
      state = 'disposed';
      if (live.get(id) === internal) live.delete(id);
      clearTimeout(fitTimer);
      clearTimeout(parkTimer);
      clearTimeout(waitTimer);
      heldFits.delete(fitNow);
      stopPanes();
      ro.disconnect();
      if (unwatchDpr) unwatchDpr();
      document.removeEventListener('mousemove', optionMove, true);
      document.removeEventListener('mouseup', release, true);
      clearTimeout(linkWait);
      finds = [];
      if (term) term.dispose();
      term = null;
      finder = null;
      mates.clear();
      el.remove();
      return attached;
    }

    return {
      el,
      focus() { if (term) term.focus(); else wantFocus = true; },
      fit() {
        if (!term) { activate(); return; }
        clearTimeout(fitTimer);
        if (held) heldFits.add(fitNow);
        else fitNow();
      },
      setVisible(v) {
        if (state === 'disposed') return;
        visible = !!v;
        if (!visible) { stopPanes(); schedulePark(); return; }
        clearTimeout(parkTimer);
        if (!term) { activate(); return; }
        if (state === 'parked') { unpark(); return; }
        scheduleFit();
        startPanes();
      },
      setPanes(list) { if (state === 'open') takePanes(list); },
      find() { openFind(); },
      selectAll() { selectShown(); },
      detach() { if (teardown()) window.flow.term.detach(id); },
      kill() {
        if (teardown()) killed.add(id);
        return window.flow.term.kill(id, o.host ? { host: o.host, attach: o.attach } : undefined);
      },
      dispose() { if (teardown()) window.flow.term.detach(id); },
      getText(maxLines) {
        if (!term) return '';
        const buf = term.buffer.active;
        const lines = [];
        for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
          const line = buf.getLine(y);
          /* to cols: after the terminal narrows, the alternate buffer (tmux's) keeps the cells past the right edge */
          lines.push(line ? line.translateToString(true, 0, term.cols) : '');
        }
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        const n = maxLines > 0 ? Math.min(maxLines, lines.length) : lines.length;
        return lines.slice(lines.length - n).join('\n');
      },
      get state() { return state; },
      get cols() { return term ? term.cols : 0; },
      get rows() { return term ? term.rows : 0; },
      get fontSize() { return term ? term.options.fontSize : 0; },
    };
  }

  window.FlowTerm = { mount, hold, nameFrom };
})();




