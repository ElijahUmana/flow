// flows: take a copy of a Flow tree to walk (package.json, src/, build/ if any; node_modules linked to ~/flow's) and record
// its md5s. node test/flows-clone.mjs <from dir> <to dir> <label>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EVID } from './flows-lib.mjs';

const [from, to, label] = process.argv.slice(2);
if (!from || !to || !label) { console.error('usage: node test/flows-clone.mjs <from> <to> <label>'); process.exit(2); }
if (!fs.existsSync(path.join(from, 'src', 'index.html'))) throw new Error(`${from} has no src/index.html`);
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
fs.copyFileSync(path.join(from, 'package.json'), path.join(to, 'package.json'));
fs.cpSync(path.join(from, 'src'), path.join(to, 'src'), { recursive: true });
if (fs.existsSync(path.join(from, 'build'))) fs.cpSync(path.join(from, 'build'), path.join(to, 'build'), { recursive: true });
fs.symlinkSync('/home/claude/flow/node_modules', path.join(to, 'node_modules'));
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const list = ['package.json', ...fs.readdirSync(path.join(to, 'src')).filter((f) => /\.(js|css|html|conf)$/.test(f)).sort().map((f) => `src/${f}`)];
const lines = list.map((f) => `${md5(path.join(to, f))}  ${f}`);
const diff = list.filter((f) => md5(path.join(from, f)) !== md5(path.join(to, f)));
fs.writeFileSync(path.join(EVID, `${label}.md5`), lines.join('\n') + '\n');
console.log(`copied ${from} -> ${to}; ${list.length} files; differing from the source right after the copy: ${diff.length ? diff.join(', ') : 'none'}`);
console.log(lines.map((l) => `${l.slice(0, 8)} ${l.slice(34)}`).join(' '));




