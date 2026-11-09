import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openFile } from './open-file.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-open-'));
const project = path.join(root, 'project');
const outside = path.join(root, 'outside');
fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
fs.mkdirSync(outside);
const doc = path.join(project, 'docs', 'update.md');
fs.writeFileSync(doc, '# hi');
fs.writeFileSync(path.join(project, 'run.bat'), 'echo hi');
fs.writeFileSync(path.join(outside, 'notes.md'), '# no');
fs.writeFileSync(path.join(root, 'project-other.md'), '# sibling');

const opened = [];
const opts = { folders: [project], launch: f => opened.push(f) };

test('opens a document inside a project folder', () => {
  assert.equal(openFile({ path: doc }, opts).opened.toLowerCase(), fs.realpathSync.native(doc).toLowerCase());
  assert.equal(opened.length, 1);
});

test('refuses programs, files outside the folders, relative and missing paths', () => {
  assert.throws(() => openFile({ path: path.join(project, 'run.bat') }, opts), /not a document/);
  assert.throws(() => openFile({ path: path.join(outside, 'notes.md') }, opts), /not inside/);
  assert.throws(() => openFile({ path: path.join(root, 'project-other.md') }, opts), /not inside/);
  assert.throws(() => openFile({ path: path.join(project, 'docs', '..', '..', 'outside', 'notes.md') }, opts), /not inside/);
  assert.throws(() => openFile({ path: 'docs/update.md' }, opts), /absolute/);
  assert.throws(() => openFile({ path: path.join(project, 'gone.md') }, opts), /missing/);
  assert.equal(opened.length, 1);
});
