#!/usr/bin/env node
/**
 * Cross-platform `sha256sum -c` for `dist/SHA256SUMS.txt`.
 *
 * The release workflow must run on every platform, and the installer uses the
 * same digest contract: one `<sha256>  <asset>` line per published archive.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const file = resolve(process.argv[2] ?? 'dist/SHA256SUMS.txt');
const dir = dirname(file);
const lines = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '');

if (lines.length === 0) {
  process.stderr.write(`checksums: ${file} is empty\n`);
  process.exit(1);
}

let failed = false;
for (const line of lines) {
  const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
  if (match === null) {
    process.stderr.write(`checksums: malformed line: ${line}\n`);
    process.exit(1);
  }
  const [, expected, asset] = match;
  const actual = createHash('sha256').update(readFileSync(join(dir, asset))).digest('hex');
  if (actual !== expected) {
    process.stderr.write(`${asset}: FAILED (expected ${expected}, got ${actual})\n`);
    failed = true;
  } else {
    process.stdout.write(`${asset}: OK\n`);
  }
}

if (failed) process.exit(1);
