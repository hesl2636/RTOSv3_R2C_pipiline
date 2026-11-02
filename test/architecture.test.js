/**
 * Architecture gate (spec §15, decision #77 §2.1, ticket #111).
 *
 * Static import graph, layer rules, the engine's physical dependency cut and
 * the released source sets are all asserted from source text: a wrong import
 * turns CI red instead of surfacing as a runtime surprise.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectEngine } from '../scripts/lib/engine-archive.mjs';
import { collectFramework } from '../scripts/lib/bundle-release.mjs';
import { minimalZip } from './helpers/minimal-bundle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'r2c-assembler.js');

const MODULES = [
  'core/node',
  'runtime/r2c/engine',
  'runtime/r2c/contract',
  'runtime/r2c/projection',
  'runtime/agent-native',
  'runtime/shared',
  'core',
  'ir',
  'assembler',
  'projection',
  'installer',
  'web',
  'bin',
];
const PURE_EXEMPT = new Set(['core/node']);
const PURE_MODULES = [
  'core',
  'ir',
  'assembler',
  'projection',
  'runtime/shared',
  'runtime/r2c/contract',
  'runtime/r2c/projection',
  'runtime/agent-native',
  'web',
];

function walkModule(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      const stat = statSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (/\.(?:js|mjs)$/.test(name)) out.push(absolute);
    }
  };
  walk(resolve(ROOT, dir));
  return out;
}

/** Remove comments and template-literal bodies; keep ordinary string literals. */
function codeOf(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === '\'' || char === '"') {
      const quote = char;
      out += char;
      index += 1;
      while (index < text.length) {
        const next = text[index];
        out += next;
        index += 1;
        if (next === '\\') {
          if (index < text.length) out += text[index];
          index += 1;
          continue;
        }
        if (next === quote) break;
      }
      continue;
    }
    if (char === '`') {
      out += '`';
      index += 1;
      let depth = 0;
      while (index < text.length) {
        const next = text[index];
        index += 1;
        if (next === '\\') {
          index += 1;
          continue;
        }
        if (next === '$' && text[index] === '{') {
          depth += 1;
          out += '${';
          index += 1;
          continue;
        }
        if (next === '}' && depth > 0) {
          depth -= 1;
          out += '}';
          continue;
        }
        if (next === '`' && depth === 0) break;
      }
      out += '`';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(([^)]*)\)/g;

function importsOf(file) {
  const code = codeOf(readFileSync(file, 'utf8'));
  const specifiers = [];
  for (const match of code.matchAll(IMPORT_RE)) specifiers.push(match[1]);
  return specifiers;
}

function dynamicImportsOf(file) {
  const code = codeOf(readFileSync(file, 'utf8'));
  return [...code.matchAll(DYNAMIC_RE)].map((match) => match[1].trim());
}

function moduleOf(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  for (const module of MODULES) {
    if (rel === module || rel.startsWith(`${module}/`)) return module;
  }
  return null;
}

function resolveSpecifier(file, specifier) {
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep trying
    }
  }
  return base;
}

function moduleFiles() {
  return MODULES.flatMap((dir) => walkModule(dir));
}

function relModule(file) {
  return relative(ROOT, file).split(sep).join('/');
}

test('the module graph has no relative import cycle', () => {
  const files = moduleFiles();
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    graph.set(
      file,
      importsOf(file)
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => resolveSpecifier(file, specifier))
        .filter((target) => known.has(target)),
    );
  }
  const visiting = new Set();
  const done = new Set();
  const stack = [];
  const visit = (file) => {
    if (done.has(file)) return;
    if (visiting.has(file)) {
      const cycle = [...stack.slice(stack.indexOf(file)), file].map(relModule);
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

test('pure modules have no node: and no third-party import', () => {
  for (const module of PURE_MODULES) {
    for (const file of walkModule(module)) {
      const rel = relModule(file);
      if (rel.startsWith('core/node/') || rel === 'web/serve.mjs') continue;
      if (/^runtime\/agent-native\/targets\/[^/]+\/assets\//.test(rel)) continue;
      if ([...PURE_EXEMPT].some((dir) => rel.startsWith(`${dir}/`))) continue;
      for (const specifier of importsOf(file)) {
        assert.match(specifier, /^\.\.?\//, `${rel} must not import ${specifier}`);
      }
    }
  }
});

test('the engine imports only core, the r2c contract, yaml and node:*', () => {
  const files = walkModule('runtime/r2c/engine');
  assert.ok(files.length > 10, 'engine sources exist');
  for (const file of files) {
    const rel = relModule(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:') || specifier === 'yaml') continue;
      if (specifier.startsWith('.')) {
        const target = relModule(resolveSpecifier(file, specifier));
        assert.match(
          target,
          /^(core\/|runtime\/r2c\/contract\/|runtime\/r2c\/engine\/)/,
          `${rel} must not import ${specifier} (${target})`,
        );
        continue;
      }
      assert.fail(`${rel} imports third-party ${specifier}`);
    }
  }
});

test('yaml is imported by the engine and the build tools only', () => {
  for (const file of [...moduleFiles(), ...walkModule('scripts')]) {
    const rel = relModule(file);
    if (rel.startsWith('scripts/')) continue;
    for (const specifier of importsOf(file)) {
      if (specifier === 'yaml') assert.match(rel, /^runtime\/r2c\/engine\//, `${rel} imports yaml`);
    }
  }
});

test('installer, bin and test import node:* or repository modules only', () => {
  const files = [...walkModule('installer'), ...walkModule('bin'), ...walkModule('test')];
  for (const file of files) {
    const rel = relModule(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) continue;
      assert.match(specifier, /^\.\.?\//, `${rel} must not import ${specifier}`);
    }
  }
});

test('no module uses a computed dynamic import', () => {
  for (const file of moduleFiles()) {
    for (const argument of dynamicImportsOf(file)) {
      assert.match(
        argument,
        /^(?:['"][^'"]+['"]|new URL\(['"][^'"]+['"], import\.meta\.url\))$/,
        `${relModule(file)} has a computed dynamic import: import(${argument})`,
      );
    }
  }
});

test('the root bin holds only the framework CLI and the engine entry moved', () => {
  assert.deepEqual(readdirSync(join(ROOT, 'bin')).sort(), ['assembler', 'r2c-assembler.js']);
  assert.equal(existsSync(join(ROOT, 'bin', 'r2c.js')), false);
  assert.equal(existsSync(join(ROOT, 'runtime', 'r2c', 'engine', 'bin', 'r2c.js')), true);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'r2c-framework');
  assert.equal(pkg.private, true);
  assert.equal('workspaces' in pkg, false);
  assert.deepEqual(pkg.bin, {
    r2c: 'runtime/r2c/engine/bin/r2c.js',
    'r2c-assembler': 'bin/r2c-assembler.js',
  });
  const enginePkg = JSON.parse(readFileSync(join(ROOT, 'runtime', 'r2c', 'engine', 'package.json'), 'utf8'));
  assert.equal(enginePkg.name, 'r2c-runner');
  assert.deepEqual(enginePkg.bin, { r2c: 'bin/r2c.js' });
});

test('the P6 retired paths are gone', () => {
  for (const path of ['src', 'adapters', 'pack', 'plugins', 'shims', 'schema', 'docs/plugins.md']) {
    assert.equal(existsSync(join(ROOT, ...path.split('/'))), false, `${path} must be retired`);
  }
  for (const file of [...walkModule('core'), ...walkModule('installer'), ...walkModule('bin'), ...walkModule('runtime')]) {
    const rel = relModule(file);
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /r2c\.adapter(?:\/|-)v1|r2c\.plugin\/v1/, `${rel}: retired schema id`);
    assert.doesNotMatch(text, /\bderive-agent\b/, `${rel}: retired action`);
  }
});

test('release source sets are disjoint and exclude retired trees', () => {
  const framework = collectFramework(ROOT);
  assert.deepEqual(framework.problems, []);
  const frameworkRels = new Set(framework.files.map((file) => file.rel));
  for (const forbidden of ['test/', 'docs/', 'scripts/', 'examples/', 'runtime/r2c/engine/', 'runtime/r2c/schema/', 'bin/r2c.js', 'src/', 'adapters/', 'pack/', 'plugins/', 'shims/', 'schema/']) {
    assert.equal([...frameworkRels].some((rel) => rel === forbidden.slice(0, -1) || rel.startsWith(forbidden)), false, `framework ships ${forbidden}`);
  }
  for (const required of ['package.json', 'bin/r2c-assembler.js', 'installer/index.js', 'runtime/r2c/projection/projection.json', 'runtime/r2c/assets/commands/r2c-run.md', 'runtime/r2c/assets/shims/hook.mjs']) {
    assert.ok(frameworkRels.has(required), `framework is missing ${required}`);
  }

  const engine = collectEngine(ROOT);
  assert.deepEqual(engine.problems, []);
  const engineRels = new Set(engine.files.map((file) => file.rel));
  for (const forbidden of ['test/', 'docs/', 'scripts/', 'examples/', 'web/', 'installer/', 'projection/', 'assembler/', 'ir/', 'bin/r2c-assembler.js']) {
    assert.equal([...engineRels].some((rel) => rel.startsWith(forbidden) || rel === forbidden.slice(0, -1)), false, `engine ships ${forbidden}`);
  }
  assert.equal(engine.version, JSON.parse(readFileSync(join(ROOT, 'runtime/r2c/engine/package.json'), 'utf8')).version);
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
