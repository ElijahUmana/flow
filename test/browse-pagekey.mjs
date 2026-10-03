// browse: checks notes' proposed "same page" key on real sites, in browse's running Flow copy (CDP 9571).
// Each group lists addresses of one page (same: true) or of different pages (same: false). Every address is loaded in
// a real page window; the address Flow ends up at (after redirects and in-page rewrites) and the page's own canonical
// link are read, then keyed. A group of one page whose keys differ means missed notes; a group of different pages
// whose keys are equal means wrong notes.
// usage: node test/browse-pagekey.mjs
import { Cdp, targets, waitFor, sleep } from './main-cdp-lib.mjs';

// notes' proposal (Nov 1): https; host without "www."; path without a trailing "/"; fragment and :~:text= dropped;
// utm_*, fbclid, gclid, si, ref dropped; the remaining query sorted.
function key(u) {
  let x;
  try { x = new URL(u); } catch (e) { return `unparsable ${u}`; }
  const host = x.hostname.replace(/^www\./i, '').toLowerCase();
  const path = x.pathname.replace(/\/+$/, '') || '';
  const q = [...x.searchParams].filter(([k]) => !/^utm_/i.test(k) && !['fbclid', 'gclid', 'si', 'ref'].includes(k.toLowerCase()));
  q.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const qs = q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
  return `https://${host}${path}${qs}`;
}

const GROUPS = [
  { site: 'Wikipedia', same: true, urls: ['https://en.wikipedia.org/wiki/Web_browser', 'https://en.m.wikipedia.org/wiki/Web_browser', 'https://en.wikipedia.org/wiki/Web_browser#History', 'https://en.wikipedia.org/wiki/Web_Browser', 'https://en.wikipedia.org/w/index.php?title=Web_browser'] },
  { site: 'Wikipedia, encoded title', same: true, urls: ['https://en.wikipedia.org/wiki/Electron_(software_framework)', 'https://en.wikipedia.org/wiki/Electron_%28software_framework%29'] },
  { site: 'YouTube', same: true, urls: ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw?si=AbCdEf123', 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=10s', 'https://m.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/shorts/jNQXAC9IVRw'] },
  { site: 'X / Twitter', same: true, urls: ['https://x.com/jack/status/20', 'https://twitter.com/jack/status/20', 'https://x.com/jack/status/20?s=20'] },
  { site: 'Notion (the seed page)', same: true, urls: ['https://www.notion.so/f675abdb2a9b4ddd98eb09e2d576f669', 'https://notion.so/f675abdb2a9b4ddd98eb09e2d576f669', 'https://www.notion.so/Voiceless-Full-System-Design-f675abdb2a9b4ddd98eb09e2d576f669', 'https://www.notion.so/f675abdb2a9b4ddd98eb09e2d576f669?pvs=4'] },
  { site: 'Medium', same: true, urls: ['https://medium.com/@karpathy/software-2-0-a64152b37c35', 'https://karpathy.medium.com/software-2-0-a64152b37c35', 'https://medium.com/@karpathy/software-2-0-a64152b37c35?source=rss----------------------', 'https://medium.com/p/a64152b37c35'] },
  { site: 'GitHub, one repo', same: true, urls: ['https://github.com/torvalds/linux', 'https://github.com/Torvalds/Linux', 'https://github.com/torvalds/linux/'] },
  { site: 'GitHub, file views', same: false, urls: ['https://github.com/microsoft/vscode/blob/main/README.md', 'https://github.com/microsoft/vscode/blob/main/README.md?plain=1', 'https://github.com/microsoft/vscode/tree/main/src'] },
  { site: 'Guardian, share links', same: true, urls: ['https://www.theguardian.com/technology/artificialintelligenceai', 'https://www.theguardian.com/technology/artificialintelligenceai?CMP=share_btn_url', 'https://www.theguardian.com/technology/artificialintelligenceai?ref=hn'] },
];

const host = await Cdp.connect((await waitFor(async () => (await targets(9571)).find((t) => t.type === 'page' && /\/src\/index\.html/.test(t.url)), 20000, 'the Flow window')).webSocketDebuggerUrl);
await host.eval('await window.__flow.ready; return true;');
const id = await host.eval('return window.__flow.openPage("https://example.com/");');
await sleep(4000);

async function visit(u) {
  await host.eval(`window.__flow.page(${JSON.stringify(id)}).navigate(${JSON.stringify(u)}); return true;`);
  await sleep(1500);
  await waitFor(() => host.eval(`return !window.__flow.page(${JSON.stringify(id)}).isLoading();`), 25000, `${u} to load`).catch(() => null);
  await sleep(2500);
  const at = await host.eval(`return window.__flow.page(${JSON.stringify(id)}).getURL();`);
  const canonical = await host.eval(`const v = document.querySelector('.win[data-id="${id}"] webview:not(.off)'); try { return await v.executeJavaScript("(document.querySelector('link[rel=canonical]') || {}).href || ''"); } catch (e) { return 'unreadable: ' + e.message; }`);
  return { u, at, canonical };
}

// The app's own rule once notes ships it (window.FlowNotes.key in src/notes.js); the proposal above until then.
const appKey = await host.eval('return !!(window.FlowNotes && typeof window.FlowNotes.key === "function");');
console.log(appKey ? 'keys from window.FlowNotes.key (the app)' : 'keys from the proposal in this file (window.FlowNotes.key not in the app yet)');
const keyOf = (u) => (appKey ? host.eval(`return window.FlowNotes.key(${JSON.stringify(u)});`) : Promise.resolve(key(u)));

for (const g of GROUPS) {
  const rows = [];
  for (const u of g.urls) rows.push(await visit(u));
  const keys = [];
  for (const r of rows) keys.push(String(await keyOf(r.at)));
  const distinct = new Set(keys).size;
  const verdict = g.same ? (distinct === 1 ? 'ok, one key' : `MISSED NOTES: ${distinct} keys for one page`) : (distinct === keys.length ? 'ok, distinct keys' : 'WRONG NOTES: different pages share a key');
  console.log(`\n${g.site}: ${verdict}`);
  for (let i = 0; i < rows.length; i++) console.log(`  ${rows[i].u}\n    lands on ${rows[i].at}\n    key ${keys[i]}${rows[i].canonical ? `\n    canonical ${rows[i].canonical}` : ''}`);
}
host.close();




