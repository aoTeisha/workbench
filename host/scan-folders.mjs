// Prints the folders a Workbench project can point at, as JSON for the board doc machine/folders:
// every directory Claude Code has been opened in, plus git repos near the home folder.
// Run by a Claude session (the page has no disk access) with --save, which writes the board's machine/folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const MAX_DEPTH = 4;
const SKIP = new Set(['node_modules', 'AppData', 'Application Data', 'Local Settings', 'OneDrive', 'Library', 'dist', 'build', 'vendor', '$RECYCLE.BIN']);
const found = new Map();
const add = (dir, git) => {
  if (!fs.existsSync(dir) || path.resolve(dir).toLowerCase() === HOME.toLowerCase()) return;
  found.set(dir.toLowerCase(), { name: path.basename(dir), path: dir, git: git || fs.existsSync(path.join(dir, '.git')) });
};

// The projects folder name is a lossy encoding of the path; a transcript line carries the real one as JSON "cwd".
const sessions = path.join(HOME, '.claude', 'projects');
for (const slug of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
  const dir = path.join(sessions, slug);
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const head = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 200000);
    const at = head.indexOf('"cwd":"');
    if (at < 0) continue;
    const end = head.indexOf('","', at);
    try { add(JSON.parse(head.slice(at + 6, end + 1)), false); } catch { continue; }
    break;
  }
}

function walk(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some(e => e.name === '.git')) { add(dir, true); return; }
  if (depth >= MAX_DEPTH) return;
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  }
}
const save = process.argv.includes('--save');
const roots = process.argv.slice(2).filter(a => a !== '--save');
for (const root of roots.length ? roots : [HOME]) walk(root, 0);

const items = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const doc = { at: stamp, host: os.hostname(), items };
// --save: straight into the board's machine/folders on this PC (host/db.mjs); else print it.
if (save) console.log(JSON.stringify((await import('./db.mjs')).write({ op: 'set', path: 'machine/folders', data: doc })));
else console.log(JSON.stringify(doc, null, 1));
