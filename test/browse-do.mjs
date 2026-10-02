// browse: run an async function body in browse's Flow copy and print the result as JSON.
// usage: node test/browse-do.mjs main|page|wv:<url-substring> '<body>'
//   main  the Electron main process (inspector 9671), page  the Flow window, wv:  a webview guest (CDP 9571)
import { Cdp, targets, waitFor } from './main-cdp-lib.mjs';
const [where, body] = process.argv.slice(2);
let t;
if (where === 'main') t = await waitFor(async () => (await targets(9671))[0], 20000, 'the main-process inspector');
else if (where === 'page') t = await waitFor(async () => (await targets(9571)).find((x) => x.type === 'page' && /\/src\/index\.html/.test(x.url)), 20000, 'the Flow window');
else if (where.startsWith('wv:')) t = await waitFor(async () => (await targets(9571)).find((x) => x.type === 'webview' && x.url.includes(where.slice(3))), 20000, `a webview at ${where.slice(3)}`);
else throw new Error(`unknown target ${where}`);
const c = await Cdp.connect(t.webSocketDebuggerUrl);
try {
  const v = await c.eval(body, { commandLine: where === 'main', timeout: 60000 });
  process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}\n`);
} finally {
  c.close();
}




