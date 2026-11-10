import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectDocs } from './project-docs.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-docs-'));
const project = path.join(root, 'project');
const outside = path.join(root, 'outside');
const put = (rel, body) => { const f = path.join(project, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
put('CONTEXT.md', '# Glossary\n\nCard: one goal.');
put('docs/adr/0001-files.md', 'no heading here');
put('.scratch/roadmap/map.md', '## Destination\n\nA rail.');
put('.scratch/roadmap/issues/01-who.md', 'Type: grilling\nStatus: resolved\n\n## Question\nWho?');
put('.scratch/roadmap/issues/02-how.md', 'Type: research\nStatus: claimed\n');
put('.scratch/roadmap/issues/03-phone.md', 'Type: prototype\nBlocked by: 01\n');
put('.scratch/loose/notes.md', '# not a map');
put('notes.txt', 'text');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.md'), '# no');
const opts = { folders: [project] };

test('lists the knowledge files and counts resolved decisions per map', () => {
  const out = projectDocs({ folder: project }, opts);
  assert.deepEqual(out.files.map(f => [f.path, f.title]), [
    ['CONTEXT.md', 'Glossary'], ['docs/adr/0001-files.md', '0001-files'], ['.scratch/roadmap/map.md', 'map']]);
  assert.deepEqual(out.maps, [{ path: '.scratch/roadmap/map.md', decided: 1, total: 3 }]);
});

test('reads one markdown file inside the folder', () => {
  assert.equal(projectDocs({ folder: project, file: 'CONTEXT.md' }, opts).text, '# Glossary\n\nCard: one goal.');
  assert.equal(projectDocs({ folder: project, file: '.scratch/roadmap/map.md' }, opts).path, '.scratch/roadmap/map.md');
});

test('refuses other folders, other files and paths that leave the folder', () => {
  assert.throws(() => projectDocs({ folder: outside }, opts), /not a project folder/);
  assert.throws(() => projectDocs({ folder: 'project' }, opts), /absolute/);
  assert.throws(() => projectDocs({ folder: project, file: 'notes.txt' }, opts), /not a markdown file/);
  assert.throws(() => projectDocs({ folder: project, file: '../outside/secret.md' }, opts), /not inside/);
  assert.throws(() => projectDocs({ folder: project, file: path.join(outside, 'secret.md') }, opts), /not inside/);
  assert.throws(() => projectDocs({ folder: project, file: 'gone.md' }, opts), /missing/);
});

test('a junction that leads out of the folder is neither listed nor read', () => {
  const away = path.join(root, 'away');
  fs.mkdirSync(path.join(away, 'issues'), { recursive: true });
  fs.writeFileSync(path.join(away, 'map.md'), '# Outside title');
  fs.writeFileSync(path.join(away, 'issues', '01-x.md'), 'Status: resolved\n');
  fs.symlinkSync(away, path.join(project, '.scratch', 'evil'), 'junction');
  const out = projectDocs({ folder: project }, opts);
  assert.ok(!out.files.some(f => f.path.includes('evil')));
  assert.ok(!out.maps.some(m => m.path.includes('evil')));
  assert.throws(() => projectDocs({ folder: project, file: '.scratch/evil/map.md' }, opts), /not inside/);
});

test('an unregistered folder is refused before anything says whether it exists', () => {
  assert.throws(() => projectDocs({ folder: path.join(root, 'no-such-folder') }, opts), /not a project folder/);
});

test('a folder with no knowledge files lists nothing', () => {
  assert.deepEqual(projectDocs({ folder: outside }, { folders: [outside] }), { folder: fs.realpathSync.native(outside), files: [], maps: [] });
});
