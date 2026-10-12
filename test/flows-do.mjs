// Runs one steps module against flows' running app: node test/flows-do.mjs <steps.mjs> [args...]
// The module's default export gets { page, L (this lib), args, log } and may return a value to print.
import path from 'node:path';
import * as L from './flows-lib.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node test/flows-do.mjs <steps.mjs> [args...]'); process.exit(2); }
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const mod = await import(path.resolve(file));
let page = null;
try {
  if (L.running().length) page = await L.connect();
  const out = await mod.default({ page, L, args: process.argv.slice(3), log });
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  if (page && page.errors.length) console.log('page errors:\n  ' + page.errors.join('\n  '));
} catch (e) {
  console.log('STEP FAILED:', e && e.stack ? e.stack : e);
  if (page) { try { console.log('shot:', await L.shot(page, `fail-${Date.now()}`)); } catch (_) { /* window gone */ } }
  process.exitCode = 1;
} finally {
  if (page) page.ws.close();
}




