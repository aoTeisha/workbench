// A project's knowledge files for the board's project page: list them, or read one. Read-only, .md only, and only
// inside a board project's folder (the same guard as open-file.mjs), so a page can never read anything else on this PC.
// Listed: CONTEXT.md, docs/adr/*.md and wayfinder maps (.scratch/<effort>/map.md, with how many decisions are resolved).
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 200 * 1024;
const real = p => fs.realpathSync.native(p);
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const inside = (base, p) => p.toLowerCase().startsWith(base.toLowerCase().replace(/[\\/]+$/, '') + path.sep);
// Every listed or read path is checked on its real path, so a link or junction cannot lead out of the folder.
const realInside = (base, p) => { try { return inside(base, real(p)); } catch { return false; } };
const mdIn = (base, dir) => (isDir(dir) && realInside(base, dir)
  ? fs.readdirSync(dir).filter(n => /\.md$/i.test(n) && realInside(base, path.join(dir, n))).sort() : []);

// Matched on the registered path first, so the answer never says whether some other path exists.
function projectFolder(folder, folders) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('refused: not an absolute path');
  const want = path.resolve(folder).toLowerCase();
  const hit = folders.find(f => typeof f === 'string' && f && path.resolve(f).toLowerCase() === want);
  if (!hit) throw new Error('refused: not a project folder');
  if (!isDir(hit)) throw new Error(`missing: ${hit}`);
  return real(hit);
}

// The first "# heading", else the file name.
function titleOf(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
  return /^#\s+(.+)$/m.exec(head)?.[1].trim() || path.basename(file, path.extname(file));
}

function mapOf(base, dir, rel) {
  const issues = path.join(dir, 'issues');
  const files = mdIn(base, issues);
  const decided = files.filter(n => /^Status:\s*resolved\b/im.test(fs.readFileSync(path.join(issues, n), 'utf8').slice(0, 2000))).length;
  return { path: rel, decided, total: files.length };
}

export function projectDocs({ folder, file } = {}, { folders }) {
  const base = projectFolder(folder, folders);
  if (file !== undefined) {
    if (typeof file !== 'string' || !file) throw new Error('refused: no file');
    const full = path.resolve(base, file);
    if (!inside(base, full)) throw new Error('refused: not inside the project folder');
    if (!isFile(full)) throw new Error(`missing: ${file}`);
    const target = real(full);
    if (!inside(base, target)) throw new Error('refused: not inside the project folder');
    if (!/\.md$/i.test(target)) throw new Error('refused: not a markdown file');
    const size = fs.statSync(target).size;
    if (size > MAX_BYTES) throw new Error(`refused: larger than ${MAX_BYTES / 1024} KB`);
    return { path: path.relative(base, full).split(path.sep).join('/'), text: fs.readFileSync(target, 'utf8') };
  }
  const files = [];
  const add = rel => {
    const full = path.join(base, rel);
    if (isFile(full) && realInside(base, full)) files.push({ path: rel, title: titleOf(full), at: fs.statSync(full).mtime.toISOString() });
  };
  add('CONTEXT.md');
  for (const n of mdIn(base, path.join(base, 'docs', 'adr'))) add(`docs/adr/${n}`);
  const scratch = path.join(base, '.scratch');
  const maps = [];
  for (const effort of isDir(scratch) && realInside(base, scratch) ? fs.readdirSync(scratch).sort() : []) {
    const dir = path.join(scratch, effort);
    const rel = `.scratch/${effort}/map.md`;
    if (!isFile(path.join(base, rel)) || !realInside(base, dir)) continue;
    add(rel);
    maps.push(mapOf(base, dir, rel));
  }
  return { folder: base, files, maps };
}
