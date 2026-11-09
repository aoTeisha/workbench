import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.WB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-db-'));
const { batch, get, list, parsePath, rev, snapshot, write } = await import('./db.mjs');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'db.mjs');

test('only board documents: cards, projects, machine, one id each', () => {
  assert.deepEqual(parsePath('cards/demo-001'), { collection: 'cards', id: 'demo-001' });
  for (const p of ['feed/mail', 'cards', 'cards/../x', 'cards/a/b', 'cards/..', 'machine/a b']) assert.throws(() => parsePath(p), /not a board document/);
});

test('set creates at version 1, update merges top-level and replaces arrays, __delete__ removes a field', () => {
  assert.equal(write({ op: 'set', path: 'cards/t-001', data: { title: 'A', log: [1, 2], keep: 'x', gone: 1 } }).version, 1);
  assert.equal(write({ op: 'update', path: 'cards/t-001', data: { title: 'B', log: [3], gone: { __delete__: true } }, ifVersion: 1 }).version, 2);
  assert.deepEqual(get('cards/t-001').data, { title: 'B', log: [3], keep: 'x' });
  assert.throws(() => write({ op: 'set', path: 'cards/t-002', data: { a: { __delete__: true } } }), /set cannot delete/);
  assert.throws(() => write({ op: 'update', path: 'cards/none-001', data: { a: 1 } }), /does not exist/);
});

test('a stale pin writes nothing and names the current version', () => {
  const r = rev();
  assert.throws(() => write({ op: 'update', path: 'cards/t-001', data: { title: 'C' }, ifVersion: 1 }), e => e.code === 'conflict' && e.version === 2);
  assert.equal(get('cards/t-001').data.title, 'B');
  assert.equal(rev(), r);
});

test('a batch is all or nothing; the revision moves once per write call', () => {
  const r = rev();
  assert.throws(() => batch([{ op: 'set', path: 'projects/p', data: { name: 'P' } }, { op: 'update', path: 'cards/t-001', data: {}, ifVersion: 9 }]), /conflict|version/);
  assert.equal(get('projects/p'), null);
  batch([{ op: 'set', path: 'projects/p', data: { name: 'P' } }, { op: 'set', path: 'cards/p-001', data: { project: 'p' } }]);
  assert.equal(rev(), r + 1);
  assert.deepEqual(list('cards', [['project', 'p']]).map(d => d.id), ['p-001']);
  write({ op: 'delete', path: 'cards/p-001' });
  assert.equal(get('cards/p-001'), null);
});

test('snapshot: everything, or unchanged when nothing was written since', () => {
  const s = snapshot();
  assert.deepEqual(Object.keys(s.docs), ['cards', 'projects', 'machine']);
  assert.ok(s.docs.cards.some(d => d.id === 't-001' && d.version === 2));
  assert.deepEqual(snapshot(s.rev), { rev: s.rev, unchanged: true });
});

test('CLI: update from a file with a pin, errors as JSON with exit 1', () => {
  const patch = path.join(process.env.WB_DATA, 'patch.json');
  fs.writeFileSync(patch, '﻿' + JSON.stringify({ status: 'review', handover: { headline: 'It "works" ✓' } }));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: process.env });
  const ok = run('update', 'cards/t-001', '--file', patch, '--if-version', '2');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).version, 3);
  assert.equal(get('cards/t-001').data.handover.headline, 'It "works" ✓');
  const bad = run('update', 'cards/t-001', '--file', patch, '--if-version', '2');
  assert.equal(bad.status, 1);
  assert.deepEqual([JSON.parse(bad.stdout).error, JSON.parse(bad.stdout).version], ['conflict', 3]);
  assert.equal(JSON.parse(run('get', 'cards/t-001').stdout).data.status, 'review');
  assert.equal(JSON.parse(run('list', 'cards', '--where', 'status=review').stdout).length, 1);
});
