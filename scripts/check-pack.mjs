#!/usr/bin/env node
/**
 * P1 pack whitelist (#17 §8): `npm pack --dry-run --json` must ship exactly
 * `package.json` plus the files under the `files` whitelist. Anything under
 * `pack/ adapters/ plugins/ test/ docs/ scripts/ .github/` is a failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = [
  '.github/',
  'adapters/',
  'docs/',
  'pack/',
  'plugins/',
  'scripts/',
  'test/',
];

function npm(args) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const options = { cwd: ROOT, encoding: 'utf8' };
  if (existsSync(cli)) return spawnSync(process.execPath, [cli, ...args], options);
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

/** Git-tracked files keep the check independent of node_modules and dist/. */
function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean);
}

function walk(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(dir, rel));
    else found.push(rel);
  }
  return found;
}

function expectedFiles(pkg) {
  const tracked = trackedFiles();
  const candidates =
    tracked ?? ['bin', 'src', 'schema'].flatMap((dir) => (existsSync(join(ROOT, dir)) ? walk(ROOT, dir) : []));
  const expected = ['package.json'];
  for (const dir of pkg.files) {
    if (!dir.endsWith('/')) {
      if (candidates.includes(dir) || existsSync(join(ROOT, dir))) expected.push(dir);
      continue;
    }
    for (const file of candidates) {
      if (file.startsWith(dir)) expected.push(file);
    }
  }
  return expected.sort();
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const result = npm(['pack', '--dry-run', '--json', '--ignore-scripts']);
if (result.status !== 0) {
  process.stderr.write(`pack whitelist: npm pack failed\n${result.stdout}${result.stderr}`);
  process.exit(1);
}

const [metadata] = JSON.parse(result.stdout);
const actual = metadata.files.map((file) => file.path).sort();
const expected = expectedFiles(pkg);
const missing = expected.filter((file) => !actual.includes(file));
const extra = actual.filter((file) => !expected.includes(file));
const forbidden = actual.filter((file) => FORBIDDEN.some((prefix) => file.startsWith(prefix)));

if (missing.length > 0 || extra.length > 0 || forbidden.length > 0) {
  process.stderr.write('pack whitelist failed:\n');
  if (missing.length > 0) process.stderr.write(`- missing: ${missing.join(', ')}\n`);
  if (extra.length > 0) process.stderr.write(`- unexpected: ${extra.join(', ')}\n`);
  if (forbidden.length > 0) process.stderr.write(`- forbidden: ${forbidden.join(', ')}\n`);
  process.exit(1);
}

process.stdout.write(`pack whitelist ok: ${actual.length} files\n`);
