'use strict';
/* Test only: every page of the harness app sees navigator.platform 'MacIntel', so xterm.js takes its macOS branch
   (isMac: Option with macOptionClickForcesSelection forces a selection) on a Linux VM. Loaded into main next to the
   stand-in VM: NODE_OPTIONS="--require <flow>/test/term-standin-vm.cjs --require <flow>/test/term-mac.cjs", then
   FLOW_TEST_MAC=1 node test/term-cdp.mjs. Keys, menus and everything else stay Linux's. */
if (process.type === 'browser') {
  const SOURCE = "Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true });";
  /* electron is not loaded yet while --require runs; the first windows come after app ready */
  setImmediate(() => {
    const { app } = require('electron');
    app.on('web-contents-created', (_e, wc) => {
      try {
        wc.debugger.attach('1.3');
      } catch (err) {
        console.error('term-mac: could not attach to a new page, so it keeps its own platform', err);
        return;
      }
      /* A page with no renderer yet answers no command, and one sent alongside the first load lands after that page's
         scripts ran: so the first load goes to about:blank, the script is set there, then the page itself loads. */
      const load = wc.loadURL.bind(wc);
      let first = true;
      wc.loadURL = (...args) => {
        if (!first) return load(...args);
        first = false;
        return load('about:blank')
          .then(() => wc.debugger.sendCommand('Page.enable'))
          .then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE }))
          .catch((err) => console.error('term-mac: could not set the platform for a new page', err))
          .then(() => load(...args));
      };
    });
  });
}




