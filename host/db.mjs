// Workbench's board data on this PC: cards, projects and machine settings, one JSON file per document under data/.
// The board page reaches it through the helper (db_read, db_write, db_delete); card sessions of any Claude account, Claude
// day sessions and the night check use it directly, so no Claude login has to reach claude.ai's database (2026-11-08:
// a work account could open the board page but never its data).
//   node host/db.mjs get cards/<key>          node host/db.mjs list cards [--where field=value]...
//   node host/db.mjs update cards/<key> --file patch.json [--if-version N]     (set: replace, delete: remove)
//   node host/db.mjs batch --file writes.json   ([{ op, path, data, ifVersion }], all or nothing)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// WB_DATA: tests keep their documents in a temp folder.
const DATA = () => process.env.WB_DATA || path.join(ROOT, 'data');
export const COLLECTIONS = ['cards', 'projects', 'machine'];
const ID = /^(?!\.\.?$)[A-Za-z0-9_.~:@+-]{1,200}$/;
const LOCK_STALE_MS = 10 * 1000;

const now = () => new Date().toISOString();
const fileOf = (collection, id) => path.join(DATA(), collection, `${id}.json`);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export function parsePath(p) {
  const [collection, id, ...rest] = String(p || '').split('/');
  if (rest.length || !COLLECTIONS.includes(collection) || !ID.test(id || '')) throw dbError('bad_path', `not a board document: ${p}`);
  return { collection, id };
}
const dbError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const rev = () => Number(readJson(path.join(DATA(), 'rev'))) || 0;

export function get(p) {
  const { collection, id } = parsePath(p);
  const doc = readJson(fileOf(collection, id));
  return doc ? { id, version: doc.version, updatedAt: doc.updatedAt, data: doc.data } : null;
}

export function list(collection, where = []) {
  if (!COLLECTIONS.includes(collection)) throw dbError('bad_path', `not a board collection: ${collection}`);
  const dir = path.join(DATA(), collection);
  const docs = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
    .filter(id => ID.test(id)).map(id => get(`${collection}/${id}`)).filter(Boolean);
  return docs.filter(d => where.every(([field, value]) => String(d.data?.[field] ?? '') === String(value)));
}

// Everything the board shows, for the page's poll: unchanged while `since` is the current revision.
export function snapshot(since) {
  const r = rev();
  if (since === r) return { rev: r, unchanged: true };
  return { rev: r, docs: Object.fromEntries(COLLECTIONS.map(c => [c, list(c)])) };
}

// One writer at a time across the helper, card sessions and Claude sessions. ponytail: one lock for the whole store;
// writes are a few a minute, per-document locks if that ever changes.
function withLock(fn) {
  fs.mkdirSync(DATA(), { recursive: true });
  const lock = path.join(DATA(), '.lock');
  const take = () => { try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
  const until = Date.now() + 5000;
  while (!take()) {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch { /* released meanwhile */ }
    if (Date.now() > until) throw dbError('busy', 'the board data is locked by another writer; try again');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

// A whole file is replaced in one rename, so a reader never sees half a document.
function writeFileAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

// The same rules as claude.ai's artifact database: update merges top-level fields (arrays replace wholesale, a field
// given as { "__delete__": true } is removed), set replaces, delete removes; if_version pins the write.
function applyOne({ op, path: p, data, ifVersion }, stamp) {
  const { collection, id } = parsePath(p);
  const file = fileOf(collection, id);
  const cur = readJson(file);
  if (ifVersion !== undefined && ifVersion !== null && (cur?.version ?? 0) !== Number(ifVersion)) {
    throw dbError('conflict', `${p} is at version ${cur?.version ?? 0}, not ${ifVersion}: read it again and redo the write`, { version: cur?.version ?? 0 });
  }
  if (op === 'delete') {
    if (cur) fs.rmSync(file);
    return { path: p, deleted: !!cur };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw dbError('bad_data', `${op} ${p} needs an object`);
  if (op !== 'set' && op !== 'update') throw dbError('bad_op', `unknown op ${op}`);
  if (op === 'update' && !cur) throw dbError('not_found', `${p} does not exist; use set to create it`);
  const removes = v => !!v && typeof v === 'object' && !Array.isArray(v) && v.__delete__ === true;
  if (op === 'set' && Object.values(data).some(removes)) throw dbError('bad_data', 'set cannot delete fields; use update');
  const next = op === 'set' ? {} : { ...cur.data };
  for (const [k, v] of Object.entries(data)) {
    if (removes(v)) delete next[k];
    else next[k] = v;
  }
  const version = (cur?.version ?? 0) + 1;
  writeFileAtomic(file, { id, version, updatedAt: stamp, data: next });
  return { path: p, version };
}

export function write(one) { return batch([one])[0]; }

// All or nothing: every pin is checked before anything is written.
export function batch(writes) {
  if (!Array.isArray(writes) || !writes.length || writes.length > 100) throw dbError('bad_data', 'a batch is 1 to 100 writes');
  return withLock(() => {
    for (const w of writes) {
      const { collection, id } = parsePath(w.path);
      const cur = readJson(fileOf(collection, id));
      if (w.ifVersion !== undefined && w.ifVersion !== null && (cur?.version ?? 0) !== Number(w.ifVersion)) {
        throw dbError('conflict', `${w.path} is at version ${cur?.version ?? 0}, not ${w.ifVersion}: read it again and redo the write`, { version: cur?.version ?? 0 });
      }
      if (w.op === 'update' && !cur) throw dbError('not_found', `${w.path} does not exist; use set to create it`);
    }
    const stamp = now();
    const out = writes.map(w => applyOne(w, stamp));
    writeFileAtomic(path.join(DATA(), 'rev'), rev() + 1);
    return out;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, target, ...rest] = process.argv.slice(2);
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const body = () => {
    const file = flag('--file') ?? (target === '--file' ? rest[0] : undefined);
    if (file) return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (flag('--json') !== undefined) return JSON.parse(flag('--json'));
    throw dbError('bad_data', 'give the data with --file <path> (or --json <text>)');
  };
  try {
    let out;
    if (cmd === 'get') out = get(target) ?? (() => { throw dbError('not_found', `${target} does not exist`); })();
    else if (cmd === 'list') out = list(target, rest.flatMap((a, i) => (a === '--where' ? [rest[i + 1].split('=')] : [])).map(([f, ...v]) => [f, v.join('=')]));
    else if (cmd === 'set' || cmd === 'update') out = write({ op: cmd, path: target, data: body(), ifVersion: flag('--if-version') });
    else if (cmd === 'delete') out = write({ op: 'delete', path: target, ifVersion: flag('--if-version') });
    else if (cmd === 'batch') out = batch(body());
    else if (cmd === 'rev') out = { rev: rev() };
    else throw dbError('usage', 'usage: node host/db.mjs get|list|set|update|delete|batch|rev ... (see the top of host/db.mjs)');
    console.log(JSON.stringify(out, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.code || 'failed', message: e.message, ...(e.version !== undefined && { version: e.version }) }));
    process.exit(1);
  }
}
