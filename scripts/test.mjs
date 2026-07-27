#!/usr/bin/env node
/**
 * Cross-version test runner.
 *
 * `node --test "test/*.test.mjs"` only works on Node 21+, where the test runner
 * learned to expand glob patterns itself. On Node 18 and 20 it fails with
 * "Could not find .../test/*.test.mjs", and cmd.exe does not expand the glob on
 * Windows either. Passing explicit file paths works everywhere.
 *
 * Only `*.test.mjs` is collected, so helpers such as test/mock-server.mjs are not
 * executed as tests.
 */

import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(TEST_DIR, name));

if (files.length === 0) {
  process.stderr.write('No *.test.mjs files found in test/\n');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
  cwd: ROOT,
});

child.on('error', (err) => {
  process.stderr.write(`Could not start the test runner: ${err.message}\n`);
  process.exit(1);
});
child.on('close', (code, signal) => {
  if (signal) {
    process.stderr.write(`Test runner terminated by ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
