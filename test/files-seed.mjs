// A first-run state for files' runs: the app's own seed, read from a probe launch through __flow.seed() (an empty
// probe state, so the probe opens no terminal), with every window that has a host removed (no ssh to claude-agents
// ever starts from a test), each workspace's folder moved to /home/claude/.flow-dev/files/cdp/<workspace> (folders
// of this test, filled with real files), and the local agents parked in the closed list (listed, none running).
//   FILES_ROOT=<tree> node test/files-seed.mjs    writes /tmp/flow-dev-files/flow-state.json
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { connectTo, evaluate, sleep } from './ui-lib.mjs';

export const PORT = 9576;
export const MARK = 'files';
export const SOCK = 'flow-dev-files';
export const DATA = '/tmp/flow-dev-files';
export const CWD = '/home/claude/.flow-dev/files/cdp';
export const ROOT = process.env.FILES_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
/* "The VM" of test/files-vm-local.js: the home folder its local stand-in for ssh runs vmfiles' command lines in. */
export const VM_HOME = '/home/claude/.flow-dev/files/vm-home';

/* A .md as agents and the owner write them: what the viewer renders, a link to another file, an image next to it. */
export const GUIDE = `# Guide

Some **bold** and \`code\` and a [plan link](../PLAN.md#plan) and <host>.

- [ ] todo item
- [x] done item

| a | b |
|---|---|
| 1 | 2 |

> a quote line to clip

![pic](shots/pic.png)

<details>
<summary>More</summary>

hidden body

</details>

## Second

\`\`\`js
const x = 1;
\`\`\`

Filler paragraph 0 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 1 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 2 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 3 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 4 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 5 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 6 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 7 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 8 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 9 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 10 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 11 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 12 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 13 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 14 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 15 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 16 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 17 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 18 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 19 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 20 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 21 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 22 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 23 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 24 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 25 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 26 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 27 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 28 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 29 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 30 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 31 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 32 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 33 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 34 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 35 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 36 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 37 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 38 about the plan, long enough to take a line or two in the page so the reader scrolls.\n\nFiller paragraph 39 about the plan, long enough to take a line or two in the page so the reader scrolls.

## Third

The third part.
`;

/* An orange w x h PNG. */
export function png(w, h) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [0xd9, 0x77, 0x57]).flat())]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/* A one-page PDF showing text. */
export function minimalPdf(text) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 36 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* The flow workspace's folder: a small project, a deep folder, a big one, files of every kind Flow shows. */
export function fillProject(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  put('README.md', '# flow\n\nworkspaces for claude code terminals, pages and notes.\n');
  put('PLAN.md', '# plan\n\n1. files in the sidebar\n2. downloads per workspace\n');
  put('src/app.js', "console.log('app');\n");
  put('src/files.js', "console.log('files');\n");
  put('src/deep/a/b/c/d/e/f/g/leaf.txt', 'deep\n');
  put('notes/ideas.txt', 'ideas\n');
  put('notes/guide.md', GUIDE);
  put('notes/steps.md', `# steps\n\n${Array.from({ length: 200 }, (_, k) => `- plan step ${k + 1}`).join('\n')}\n`);
  put('notes/shots/pic.png', png(8, 8));
  put('notes/nometa.html', '<!doctype html><title>nometa</title><p>›_ ✎ ◫</p>');
  put('notes/utf8meta.html', '<!doctype html><meta charset="utf-8"><title>utf8meta</title><p>›_ ✎ ◫</p>');
  put('notes/legacy.html', Buffer.concat([Buffer.from('<!doctype html><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>legacy</title><p>price '), Buffer.from([0x80]), Buffer.from('5</p>')]));
  put('.git/config', '[core]\n');
  put('.env', 'SECRET=1\n');
  put('data/blob.bin', Buffer.from([0, 1, 2, 3, 255, 0]));
  for (let i = 0; i < 340; i++) put(`many/file-${i}.txt`, `${i}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const PROBE = `${DATA}-probe`;
  fs.rmSync(PROBE, { recursive: true, force: true });
  fs.mkdirSync(PROBE, { recursive: true });
  fs.writeFileSync(path.join(PROBE, 'flow-state.json'), JSON.stringify({ v: 11, ws: [{ id: 'probe', name: 'probe', folder: '~', bg: '#141319', zones: [], notes: [], windows: [], closed: [] }], ui: {} }));
  const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', 'env', `FLOW_USER_DATA=${PROBE}`, `FLOW_TMUX_SOCKET=${SOCK}-probe`, `FLOW_CDP_PORT=${PORT}`, 'FLOW_BACKGROUND=1',
    './node_modules/.bin/electron', '.', '--no-sandbox', `--flow-dev=${MARK}-probe`], { cwd: ROOT, stdio: 'ignore', detached: true });
  let seed;
  try {
    const page = await connectTo(PORT, /\/src\/index\.html$/);
    for (let i = 0; i < 80 && !(await evaluate(page, '!!window.__flow')); i++) await sleep(250);
    await evaluate(page, 'window.__flow.ready');
    seed = await evaluate(page, 'window.__flow.seed()');
    page.ws.close();
  } finally {
    process.kill(-app.pid, 'SIGTERM');
  }
  for (let i = 0; i < 40; i++) {
    try { process.kill(-app.pid, 0); } catch { break; }
    await sleep(250);
  }
  fs.rmSync(PROBE, { recursive: true, force: true });

  const removed = [], parked = [];
  for (const ws of seed) {
    const cwd = path.join(CWD, ws.id);
    if (ws.id === 'flow') fillProject(cwd);
    else fs.mkdirSync(cwd, { recursive: true });
    ws.folder = cwd;
    // voiceless: a sub-workspace with a folder of its own, outside the workspace's, and one without (item 15); a
    // download made in each space
    if (ws.id === 'voiceless') {
      const own = path.join(CWD, 'zone-own');
      fs.rmSync(own, { recursive: true, force: true });
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(path.join(own, 'own.txt'), 'in the sub-workspace\n');
      fs.mkdirSync(path.join(CWD, 'zone-not'), { recursive: true });
      ws.zones = [...(ws.zones || []), { id: 'z-files', name: 'with files', pan: 0, folder: own }, { id: 'z-bare', name: 'without', pan: 0 }];
      // where these downloads were saved: a folder of its own, since the suite empties userData/Downloads before it starts
      const dls = path.join(CWD, 'dl-seed');
      fs.rmSync(dls, { recursive: true, force: true });
      fs.mkdirSync(dls, { recursive: true });
      for (const name of ['zone-dl.txt', 'main-dl.txt']) fs.writeFileSync(path.join(dls, name), `${name}\n`);
      ws.downloads = [{ file: path.join(dls, 'zone-dl.txt'), url: 'http://127.0.0.1:1/zone-dl.txt', at: 2, zone: 'z-files' },
        { file: path.join(dls, 'main-dl.txt'), url: 'http://127.0.0.1:1/main-dl.txt', at: 1 }];
    }
    // ef runs "on the VM" (host 'standin'), but only in a tree whose main.js runs vmfiles' lines locally
    // (test/files-vm-local.js): anywhere else that host would go to ssh. None of its agents run.
    if (ws.id === 'ef' && fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8').includes('FILES_VM')) {
      ws.host = 'standin';
      ws.hostFolder = '~/proj';
      fs.rmSync(VM_HOME, { recursive: true, force: true });
      fs.mkdirSync(path.join(VM_HOME, 'proj', 'src'), { recursive: true });
      fs.writeFileSync(path.join(VM_HOME, 'proj', 'notes.md'), '# on the vm\n');
      fs.writeFileSync(path.join(VM_HOME, 'proj', 'plan.md'), `# vm plan\n\nSee [the notes](notes.md), and [the source](src).\n\n${Array.from({ length: 40 }, (_, k) => `Step ${k} of the plan an agent on the VM writes, long enough to fill a line in the page.`).join('\n\n')}\n\n## third\n\nThe end.\n`);
      fs.writeFileSync(path.join(VM_HOME, 'proj', 'src', 'main.py'), 'print(1)\n');
      fs.writeFileSync(path.join(VM_HOME, 'proj', '.hidden'), 'x\n');
      fs.mkdirSync(path.join(VM_HOME, 'zproj'), { recursive: true });
      fs.writeFileSync(path.join(VM_HOME, 'zproj', 'z.py'), 'print(3)\n');
      fs.mkdirSync(path.join(VM_HOME, 'zother'), { recursive: true });
      fs.writeFileSync(path.join(VM_HOME, 'zother', 'x.py'), 'print(4)\n');
      ws.zones = [...(ws.zones || []), { id: 'z-vm', name: 'vm files', pan: 0, hostFolder: '~/zproj' }];
    }
    for (const k of ['windows', 'closed']) {
      ws[k] = (ws[k] || []).filter((w) => {
        if (w.host) { removed.push(`${ws.id}/${w.id}`); return false; }
        return true;
      });
    }
    ws.windows = ws.windows.filter((w) => {
      if (w.type !== 'term' && w.type !== 'team') return true;
      w.cwd = cwd;
      ws.closed.push(w);
      parked.push(`${ws.id}/${w.id}`);
      return false;
    });
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'flow-state.json'), JSON.stringify({ v: 11, ws: seed, ui: {} }));
  console.log(`wrote ${path.join(DATA, 'flow-state.json')}: ${seed.map((w) => `${w.id} in ${w.folder}`).join(', ')}; removed host windows: ${removed.join(', ') || 'none'}; parked agents: ${parked.join(', ') || 'none'}`);
}




