// nav's test pages on http://127.0.0.1:<port>/ (pages may only load http(s) addresses).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname);
const port = +process.argv[2] || 9768;
http.createServer((req, res) => {
  const f = path.join(dir, path.basename(new URL(req.url, 'http://x').pathname) || 'wide.html');
  if (!f.endsWith('.html') || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
}).listen(port, '127.0.0.1', () => console.log(`nav test pages on http://127.0.0.1:${port}/`));




