// browse: screenshot a CDP target on browse's copy (default the Flow window; or the first webview whose url has <substring>).
// usage: node test/browse-shot.mjs <port> <out.png> [url-substring]
import fs from 'node:fs';
import { Cdp, targets, waitFor } from './main-cdp-lib.mjs';
const [port, out, match] = process.argv.slice(2);
const t = await waitFor(async () => (await targets(Number(port))).find((x) => (match ? x.type === 'webview' && x.url.includes(match) : x.type === 'page' && /\/src\/index\.html/.test(x.url))), 20000, `a target for ${match || 'the Flow window'}`);
const c = await Cdp.connect(t.webSocketDebuggerUrl);
try {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(out);
} finally {
  c.close();
}




