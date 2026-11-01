'use strict';
/* Test only: stands in for the hand that picks from a native menu, which CDP cannot reach. Loaded into main next to the
   stand-in VM: NODE_OPTIONS="--require <flow>/test/term-standin-vm.cjs --require <flow>/test/term-menu.cjs". When a
   menu pops up it writes what it shows to <userData>/menu-shown.json ([{ label, enabled, type }]), then clicks the
   enabled item whose label <userData>/menu-choice names (the file is used once and removed) and closes the menu; with no
   choice it closes it with nothing picked. Everything else about the menu is main's own (flow.menu.popup). */
if (process.type === 'browser') {
  /* electron is not loaded yet while --require runs */
  setImmediate(() => {
    const fs = require('fs');
    const path = require('path');
    const { app, Menu } = require('electron');
    Menu.prototype.popup = function popup(opts = {}) {
      const dir = app.getPath('userData');
      fs.writeFileSync(path.join(dir, 'menu-shown.json'), JSON.stringify(this.items.map((i) => ({ label: i.label, enabled: i.enabled, type: i.type }))));
      const file = path.join(dir, 'menu-choice');
      let want = '';
      try {
        want = fs.readFileSync(file, 'utf8').trim();
        fs.unlinkSync(file);
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('term-menu: could not read the menu choice', err);
      }
      const item = want && this.items.find((i) => i.label === want && i.enabled);
      if (want && !item) console.error(`term-menu: no enabled item "${want}" in the menu`);
      if (item) item.click();
      if (opts.callback) opts.callback();
    };
  });
}




