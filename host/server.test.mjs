import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Importing server.mjs would start the helper (stdin loop, night timer), so only its syntax is checked: a broken
// server.mjs keeps the desktop app from starting the helper at all, and the board then shows no cards.
test('server.mjs parses', () => {
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', server], { stdio: 'pipe' }));
});
