import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { minimalZip } from './helpers/minimal-bundle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNED_DIRS = ['core', 'ir', 'assembler', 'bin'];
const PURE_DIRS = ['core', 'ir', 'assembler'];
const NODE_ONLY = join(ROOT, 'core', 'node');
const BIN = join(ROOT, 'bin', 'r2c-assembler.js');

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const absolute = join(dir, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) out.push(...walk(absolute));
    else if (name.endsWith('.js')) out.push(absolute);
  }
  return out;
}

function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  for (const match of text.matchAll(IMPORT_RE)) out.push(match[1]);
  return out;
}

function moduleFiles() {
  return OWNED_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
}

test('the owned module graph has no relative import cycles', () => {
  const files = moduleFiles();
  const graph = new Map();
  for (const file of files) {
    const edges = [];
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolve(dirname(file), specifier.endsWith('.js') ? specifier : `${specifier}.js`);
      if (files.includes(resolved)) edges.push(resolved);
    }
    graph.set(file, edges);
  }
  const visiting = new Set();
  const done = new Set();
  const stack = [];
  const visit = (file) => {
    if (done.has(file)) return;
    if (visiting.has(file)) {
      const cycle = [...stack.slice(stack.indexOf(file)), file].map((item) => relative(ROOT, item));
      assert.fail(`import cycle: ${cycle.join(' -> ')}`);
    }
    visiting.add(file);
    stack.push(file);
    for (const next of graph.get(file) ?? []) visit(next);
    stack.pop();
    visiting.delete(file);
    done.add(file);
  };
  for (const file of files) visit(file);
});

test('pure modules import nothing but relative files', () => {
  for (const dir of PURE_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      if (file.startsWith(NODE_ONLY)) continue;
      for (const specifier of importsOf(file)) {
        assert.match(
          specifier,
          /^\.\.?\//,
          `${relative(ROOT, file)} must not import ${specifier}`,
        );
      }
    }
  }
});

test('the only Node-only seam is core/node', () => {
  for (const file of moduleFiles()) {
    if (file.startsWith(NODE_ONLY) || file.startsWith(join(ROOT, 'bin'))) continue;
    for (const specifier of importsOf(file)) {
      assert.doesNotMatch(specifier, /^node:/, `${relative(ROOT, file)} imports ${specifier}`);
      assert.match(specifier, /^\.\.?\//, `${relative(ROOT, file)} imports third-party ${specifier}`);
    }
  }
});

test('the framework CLI --json output is exactly one envelope line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-arch-'));
  try {
    const zipPath = join(dir, 'minimal.zip');
    writeFileSync(zipPath, minimalZip());
    const result = spawnSync(process.execPath, [BIN, 'bundle', 'validate', zipPath, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const envelope = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(envelope), [
      'ok',
      'command',
      'code',
      'run_id',
      'session_id',
      'step',
      'data',
      'error',
    ]);
    assert.equal(envelope.ok, true);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
