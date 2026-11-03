import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { LIMITS } from '../assembler/limits.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { buildZip } from './helpers/zip.js';
import {
  MINIMAL_MANIFEST,
  MINIMAL_ROLE,
  MINIMAL_TASK,
  minimalFiles,
  minimalZip,
} from './helpers/minimal-bundle.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/hm2b-assembler.js', import.meta.url));
const BASELINE = join(
  REPO,
  'examples',
  'rtosv3',
  'dist',
  'bundle-rtosv3-drvport-v1.0.0.zip',
);
const PRIMITIVES = { inflateRaw, sha256: sha256Hex };

function validate(zip) {
  return validateBundle(zip, PRIMITIVES);
}

function labels(report) {
  return report.errors.map((error) => `${error.code}@${error.path}`);
}

function expectErrors(zip, expected) {
  const report = validate(zip);
  assert.equal(report.ok, false, 'expected the bundle to be rejected');
  assert.deepEqual(labels(report), expected);
  return report;
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-container-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    envelope: result.stdout.trim() === '' ? null : JSON.parse(result.stdout),
  };
}

/** 4 MiB skill payload whose declared size lies (1 byte) to build a real bomb. */
function bombBundle() {
  const ids = Array.from({ length: 9 }, (_, index) => `s${index}`);
  const manifest = { ...MINIMAL_MANIFEST, skills: ['helper', ...ids] };
  const files = minimalFiles({ 'bundle.json': canonicalJson(manifest) });
  const declaredSizes = {};
  const methods = {};
  for (const id of ids) {
    const path = `skills/${id}/SKILL.md`;
    const head = `---\nname: ${id}\ndescription: Bomb filler skill.\n---\n\n`;
    const overhead = Buffer.byteLength(head, 'utf8') + 1;
    files.set(path, `${head}${'A'.repeat(LIMITS.MAX_ENTRY_BYTES - overhead)}\n`);
    declaredSizes[path] = 1;
    methods[path] = 'deflate';
  }
  for (const path of ['bundle.json', 'roles/worker.md', 'tasks/do-it.md', 'skills/helper/SKILL.md']) {
    methods[path] = 'deflate';
  }
  return { files, options: { methodFor: (name) => methods[name], declaredSizes } };
}

// ---------------------------------------------------------------------------
// P0/P1 container matrix (decision #67 §7.1)
// ---------------------------------------------------------------------------

test('bundle.json outside the archive root is reported as missing plus unexpected', () => {
  const files = minimalFiles();
  files.delete('bundle.json');
  files.set('sub/bundle.json', canonicalJson(MINIMAL_MANIFEST));
  expectErrors(buildZip(files), [
    'BUNDLE_MANIFEST_MISSING@bundle.json',
    'BUNDLE_UNEXPECTED_PATH@sub/bundle.json',
  ]);
});

test('a single outer directory is one composite diagnostic and suppresses children (S3)', () => {
  // Keep paths within the depth budget so the only violation is the wrapper
  // itself; content checks are suppressed by S3 regardless of manifest shape.
  const wrapped = new Map([
    ['bundle/bundle.json', canonicalJson(MINIMAL_MANIFEST)],
    ['bundle/stages/only.json', canonicalJson({ id: 'only', name: 'Only', steps: [] })],
  ]);
  expectErrors(buildZip(wrapped), ['BUNDLE_OUTER_DIRECTORY@']);
});

test('symlink entries are rejected', () => {
  const zip = buildZip(minimalFiles(), {
    externalAttributes: (name) => (
      name === 'roles/worker.md' ? (0o120777 << 16) >>> 0 : undefined
    ),
  });
  expectErrors(zip, ['BUNDLE_SYMLINK@roles/worker.md']);
});

test('hard-linked entries (shared local header) are rejected', () => {
  const entries = [...minimalFiles(), ['roles/worker-alias.md', '']];
  const zip = buildZip(entries, { hardLinks: { 'roles/worker-alias.md': 'roles/worker.md' } });
  expectErrors(zip, ['BUNDLE_ENTRY_TYPE@roles/worker-alias.md']);
});

test('encrypted entries are rejected', () => {
  const zip = buildZip(minimalFiles(), {
    flags: (name) => (name === 'roles/worker.md' ? 0x0001 : undefined),
  });
  expectErrors(zip, ['BUNDLE_ENCRYPTED@roles/worker.md']);
});

test('zip64 markers are rejected before any entry is decoded', () => {
  const zip = buildZip(minimalFiles(), { eocd: { totalEntries: 0xffff } });
  expectErrors(zip, ['BUNDLE_ZIP64@']);
});

test('multi-disk archives are rejected', () => {
  const zip = buildZip(minimalFiles(), { eocd: { disk: 1 } });
  expectErrors(zip, ['BUNDLE_ZIP_INVALID@']);
  assert.equal(validate(zip).errors[0].details.reason, 'spanned');
});

test('compression methods other than store/deflate are rejected', () => {
  const zip = buildZip(minimalFiles(), {
    methodFor: (name) => (name === 'roles/worker.md' ? 12 : undefined),
  });
  expectErrors(zip, ['BUNDLE_COMPRESSION_UNSUPPORTED@roles/worker.md']);
});

test('case-folded duplicate names are rejected once', () => {
  const entries = [...minimalFiles(), ['ROLES/worker.md', MINIMAL_ROLE]];
  const report = expectErrors(buildZip(entries), ['BUNDLE_DUPLICATE_ENTRY@ROLES/worker.md']);
  assert.equal(report.errors[0].details.mode, 'case-fold');
});

test('exact duplicate names are rejected once', () => {
  const entries = [...minimalFiles(), ['roles/worker.md', MINIMAL_ROLE]];
  const report = expectErrors(buildZip(entries), ['BUNDLE_DUPLICATE_ENTRY@roles/worker.md']);
  assert.equal(report.errors[0].details.mode, 'exact');
});

test('path rule fixtures', async (t) => {
  const cases = [
    ['backslash', 'docs\\notes.md'],
    ['drive letter', 'C:/evil.md'],
    ['colon in a segment', 'roles/worker:1.md'],
    ['trailing dot', 'tasks/do-it.md.'],
    ['trailing space', 'tasks/do-it.md '],
    ['invalid segment characters', 'tasks/do it.md'],
    ['path over 100 bytes', `tasks/${'a'.repeat(100)}.md`],
    ['depth over 3', 'stages/a/b/c.json'],
  ];
  for (const [name, badPath] of cases) {
    await t.test(name, () => {
      const entries = [...minimalFiles(), [badPath, 'x\n']];
      expectErrors(buildZip(entries), [`BUNDLE_PATH_INVALID@${badPath}`]);
    });
  }
});

test('a zip over 8 MiB is rejected without parsing it', () => {
  const zip = Buffer.concat([minimalZip(), Buffer.alloc(LIMITS.MAX_ZIP_BYTES)]);
  const report = expectErrors(zip, ['BUNDLE_ZIP_TOO_LARGE@']);
  assert.equal(report.errors[0].details.limit, LIMITS.MAX_ZIP_BYTES);
});

test('more than 512 entries are rejected', () => {
  const entries = [...minimalFiles()];
  for (let index = 0; entries.length < LIMITS.MAX_ENTRIES + 1; index += 1) {
    entries.push([`extra-${index}.txt`, '']);
  }
  expectErrors(buildZip(entries), ['BUNDLE_ENTRY_COUNT@']);
});

test('more than 32 MiB of inflated data aborts immediately (one diagnostic)', () => {
  const { files, options } = bombBundle();
  const report = expectErrors(buildZip(files, options), ['BUNDLE_UNCOMPRESSED_TOO_LARGE@']);
  assert.equal(report.errors[0].details.limit, LIMITS.MAX_UNCOMPRESSED_BYTES);
});

test('container path checks complete before inflation starts', () => {
  const { files, options } = bombBundle();
  files.set('roles\\evil.md', 'x');
  const report = validate(buildZip(files, options));
  const labelsSeen = labels(report);
  assert.ok(labelsSeen.includes('BUNDLE_UNCOMPRESSED_TOO_LARGE@'), JSON.stringify(labelsSeen));
  assert.ok(labelsSeen.includes('BUNDLE_PATH_INVALID@roles\\evil.md'), JSON.stringify(labelsSeen));
});

test('a single entry over 4 MiB is rejected before inflation', () => {
  const files = minimalFiles({ 'README.md': 'A'.repeat(LIMITS.MAX_ENTRY_BYTES + 1) });
  const zip = buildZip(files, {
    methodFor: (name) => (name === 'README.md' ? 'deflate' : undefined),
  });
  const report = expectErrors(zip, ['BUNDLE_ENTRY_TOO_LARGE@README.md']);
  assert.equal(report.errors[0].details.limit, LIMITS.MAX_ENTRY_BYTES);
});

test('a task book over 128 KiB is rejected before inflation', () => {
  const task = `${MINIMAL_TASK}${'A'.repeat(LIMITS.MAX_TASK_BYTES)}`;
  const files = minimalFiles({ 'tasks/do-it.md': task });
  const zip = buildZip(files, {
    methodFor: (name) => (name === 'tasks/do-it.md' ? 'deflate' : undefined),
  });
  const report = expectErrors(zip, ['BUNDLE_TASK_TOO_LARGE@tasks/do-it.md']);
  assert.equal(report.errors[0].details.limit, LIMITS.MAX_TASK_BYTES);
});

test('a task whose declared size lies is still capped by its actual size', () => {
  const task = `${MINIMAL_TASK}${'A'.repeat(LIMITS.MAX_TASK_BYTES)}`;
  const files = minimalFiles({ 'tasks/do-it.md': task });
  const zip = buildZip(files, {
    methodFor: (name) => (name === 'tasks/do-it.md' ? 'deflate' : undefined),
    declaredSizes: { 'tasks/do-it.md': 1 },
  });
  const report = expectErrors(zip, ['BUNDLE_TASK_TOO_LARGE@tasks/do-it.md']);
  assert.equal(report.errors[0].details.limit, LIMITS.MAX_TASK_BYTES);
});

test('a constitution over 64 KiB is rejected before inflation', () => {
  const manifest = {
    ...MINIMAL_MANIFEST,
    constitution: { path: 'constitution/CONSTITUTION.md' },
  };
  const files = minimalFiles({
    'bundle.json': canonicalJson(manifest),
    'constitution/CONSTITUTION.md': `${'A'.repeat(LIMITS.MAX_CONSTITUTION_BYTES)}\n`,
  });
  const zip = buildZip(files, {
    methodFor: (name) => (
      name === 'constitution/CONSTITUTION.md' ? 'deflate' : undefined
    ),
  });
  const report = expectErrors(zip, ['BUNDLE_CONSTITUTION_TOO_LARGE@constitution/CONSTITUTION.md']);
  assert.equal(report.errors[0].details.limit, LIMITS.MAX_CONSTITUTION_BYTES);
});

// ---------------------------------------------------------------------------
// Encoding contract (#67 §7.1 BUNDLE_TEXT_ENCODING, §9)
// ---------------------------------------------------------------------------

test('text encoding fixtures', async (t) => {
  const cases = [
    ['BOM', '\uFEFF', MINIMAL_ROLE, 'bom'],
    ['carriage return', '', MINIMAL_ROLE.replaceAll('\n', '\r\n'), 'cr'],
    ['missing final LF', '', MINIMAL_ROLE.replace(/\n$/, ''), 'missing-final-lf'],
  ];
  for (const [name, prefix, text, reason] of cases) {
    await t.test(name, () => {
      const files = minimalFiles({ 'roles/worker.md': `${prefix}${text}` });
      const report = expectErrors(buildZip(files), ['BUNDLE_TEXT_ENCODING@roles/worker.md']);
      assert.equal(report.errors[0].details.reason, reason);
    });
  }
});

test('strict UTF-8 fixtures reject invalid bytes', () => {
  const files = minimalFiles({ 'roles/worker.md': new Uint8Array([0xff, 0xfe, 0x0a]) });
  const report = expectErrors(buildZip(files), ['BUNDLE_TEXT_ENCODING@roles/worker.md']);
  assert.equal(report.errors[0].details.reason, 'utf8');
});

test('a lone surrogate inside JSON is a text-encoding error', () => {
  const manifest = { ...MINIMAL_MANIFEST, description: `Demo \uD800 text.` };
  const files = minimalFiles({ 'bundle.json': canonicalJson(manifest) });
  const report = expectErrors(buildZip(files), ['BUNDLE_TEXT_ENCODING@bundle.json']);
  assert.equal(report.errors[0].details.reason, 'lone-surrogate');
});

test('a zero-byte non-constitution text keeps its owning code', () => {
  const files = minimalFiles({ 'skills/helper/SKILL.md': '' });
  expectErrors(buildZip(files), ['BUNDLE_SKILL_EMPTY_FILE@skills/helper/SKILL.md']);
});

// ---------------------------------------------------------------------------
// Exhaustive path whitelist (#67 §7.11)
// ---------------------------------------------------------------------------

test('extra paths use the frozen layout codes exactly once', async (t) => {
  const cases = [
    ['extra skill file keeps its dedicated code', () => minimalFiles({ 'skills/helper/README.md': 'notes\n' }), 'BUNDLE_SKILL_EXTRA_FILE@skills/helper/README.md'],
    ['unexpected stage file', () => minimalFiles({ 'stages/extra.md': 'x\n' }), 'BUNDLE_UNEXPECTED_PATH@stages/extra.md'],
    ['repository metadata', () => minimalFiles({ '.github/workflows/ci.yml': 'x\n' }), 'BUNDLE_UNEXPECTED_PATH@.github/workflows/ci.yml'],
    ['package manifest', () => minimalFiles({ 'package.json': '{}\n' }), 'BUNDLE_UNEXPECTED_PATH@package.json'],
  ];
  for (const [name, build, expected] of cases) {
    await t.test(name, () => {
      expectErrors(buildZip(build()), [expected]);
    });
  }
});

test('directory entries outside the whitelist are unexpected', () => {
  const zip = buildZip(minimalFiles(), { directory: ['docs'] });
  expectErrors(zip, ['BUNDLE_UNEXPECTED_PATH@docs/']);
});

test('a constitution directory without a manifest item is undeclared', () => {
  const zip = buildZip(minimalFiles(), { directory: ['constitution'] });
  expectErrors(zip, ['BUNDLE_CONSTITUTION_UNDECLARED@constitution/CONSTITUTION.md']);
});

test('the optional README and directory entries stay allowed', () => {
  const files = minimalFiles({ 'README.md': 'Just notes.\n' });
  const report = validate(buildZip(files, {
    directory: ['stages', 'roles', 'tasks', 'skills', 'skills/helper'],
  }));
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

// ---------------------------------------------------------------------------
// CLI / determinism / purity
// ---------------------------------------------------------------------------

test('a container failure exits 2 and repeated runs produce identical JSON', () => {
  const zip = buildZip(minimalFiles(), {
    externalAttributes: (name) => (name === 'roles/worker.md' ? (0o120777 << 16) >>> 0 : undefined),
  });
  withTempDir((dir) => {
    const zipPath = join(dir, 'symlink.zip');
    writeFileSync(zipPath, zip);
    const first = cli(['bundle', 'validate', zipPath, '--json']);
    const second = cli(['bundle', 'validate', zipPath, '--json']);
    assert.equal(first.status, 2);
    assert.equal(first.envelope.ok, false);
    assert.equal(first.envelope.code, 2);
    assert.equal(first.envelope.error.code, 'BUNDLE_SYMLINK');
    assert.equal(first.stdout.trim().split('\n').length, 1);
    assert.equal(first.stdout, second.stdout);
  });
});

test('warnings never change the exit code', () => {
  const zip = minimalZip({
    overrides: { 'tasks/do-it.md': MINIMAL_TASK.replace('完成唯一一步。', '先跑 hm2b-status。') },
  });
  withTempDir((dir) => {
    const zipPath = join(dir, 'warning.zip');
    writeFileSync(zipPath, zip);
    const result = cli(['bundle', 'validate', zipPath, '--json']);
    assert.equal(result.status, 0);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.data.warnings.length, 1);
  });
});

test('the validator is a pure bytes-in/report-out function (no filesystem writes)', () => {
  const sources = [
    'assembler/zip.js',
    'assembler/validate-bundle.js',
    'assembler/checks/container.js',
    'assembler/checks/context.js',
  ];
  for (const relative of sources) {
    const source = readFileSync(join(REPO, relative), 'utf8');
    assert.doesNotMatch(source, /from\s+['"](?:node:)?fs['"]/, relative);
    assert.doesNotMatch(source, /\b(writeFile|appendFile|createWriteStream|mkdirSync)\b/, relative);
  }
});

test('the baseline bundle keeps 0 errors, 2 warnings and the frozen IR', () => {
  const bytes = readFileSync(BASELINE);
  assert.equal(bytes.length, 55043);
  assert.equal(sha256Hex(bytes), '4b4700207e2a1398b930b46123f5e7aef27f803e3afc3596d19e31dc454d8196');
  const report = validate(bytes);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings.map((warning) => warning.code), [
    'BUNDLE_CONSTITUTION_PLACEHOLDER',
    'BUNDLE_TASK_RUNTIME_LEAK',
  ]);
  const compiled = compileBundle(bytes, PRIMITIVES);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.irBytes.length, 58829);
  assert.equal(compiled.digest, 'd6e8957287117c7b476891e1807e303c9a965fbe366087a13947baf34b0da09f');
});
