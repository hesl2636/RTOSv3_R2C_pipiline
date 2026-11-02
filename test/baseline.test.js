/**
 * Baseline anchors and compile determinism (ticket #92, spec §5/§17, #68).
 *
 * The committed rtosv3 sample is the regression oracle:
 *   - validating it yields exactly the frozen 2 warnings and exit 0;
 *   - compiling it yields the frozen 58,827-byte IR (sha256 8a2a5759…);
 *   - the zip, the source directory, and repacked variants compile to the
 *     same bytes;
 *   - only contract content can change the IR; README.md cannot;
 *   - `ir validate` rejects every non-canonical/hash-inconsistent document.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileBundle } from '../assembler/compile.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { validateIr } from '../assembler/validate-ir.js';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { buildZip } from './helpers/zip.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(REPO, 'examples', 'rtosv3');
const BUNDLE = join(EXAMPLE, 'bundle');
const COMMITTED_ZIP = join(EXAMPLE, 'dist', 'bundle-rtosv3-drvport-v1.0.0.zip');
const FILES_SUMS = join(EXAMPLE, 'FILES.sha256');
const GOLDEN_IR = join(REPO, 'test', 'fixtures', 'ir', 'workflow.ir.json');
const CLI = join(REPO, 'bin', 'r2c-assembler.js');

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };

const ANCHORS = Object.freeze({
  zipBytes: 55042,
  zipSha256: 'c22064539aa189b4d9345b1d39b148967a450584badd2593dcf47c0c5b75a13e',
  irBytes: 58827,
  irSha256: '8a2a57593939f91117d57f9ca34c56b2fc631f6837168ef74032daa95202d395',
  contentSha256: 'df61a4136d191a2eee1a31e6cbef83a3ccd2002e74c822c93e7b8edda4a16be3',
});

const EXPECTED_WARNINGS = [
  ['BUNDLE_CONSTITUTION_PLACEHOLDER', 'constitution/CONSTITUTION.md'],
  ['BUNDLE_TASK_RUNTIME_LEAK', 'tasks/analysis-design-orchestration.md'],
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Independent walk of the editable bundle tree, excluding the top-level README. */
function readBundleDirectory(dir = BUNDLE) {
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), relative);
      } else if (relative !== 'README.md') {
        files.push({ path: relative, bytes: readFileSync(join(current, entry.name)) });
      }
    }
  };
  walk(dir, '');
  return files.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
}

/** Same virtual file table, serialized in the requested zip shape. */
function zipOf(files, options = {}) {
  return buildZip(files.map((file) => [file.path, file.bytes]), options);
}

function compile(bytes) {
  return compileBundle(bytes, PRIMITIVES);
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-baseline-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8' });
}

function irObject(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function canonicalBytes(ir) {
  return new TextEncoder().encode(canonicalJson(ir));
}

const COMMITTED_ZIP_BYTES = readFileSync(COMMITTED_ZIP);
const GOLDEN_BYTES = readFileSync(GOLDEN_IR);
const DIRECTORY_FILES = readBundleDirectory();

test('committed sample zip validates with the frozen warning baseline', () => {
  assert.equal(COMMITTED_ZIP_BYTES.length, ANCHORS.zipBytes);
  assert.equal(sha256(COMMITTED_ZIP_BYTES), ANCHORS.zipSha256);

  const report = validateBundle(COMMITTED_ZIP_BYTES, PRIMITIVES);
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, {
    stages: 4,
    steps: 4,
    roles: 4,
    tasks: 4,
    skills: 35,
    constitutions: 1,
    errors: 0,
    warnings: 2,
  });
  assert.deepEqual(
    report.warnings.map((warning) => [warning.code, warning.path]),
    EXPECTED_WARNINGS,
  );
  assert.deepEqual(report.errors, []);

  const cli = runCli(['bundle', 'validate', COMMITTED_ZIP, '--json']);
  assert.equal(cli.status, 0, cli.stderr);
  const envelope = JSON.parse(cli.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.code, 0);
  assert.equal(envelope.data.counts.errors, 0);
  assert.equal(envelope.data.counts.warnings, 2);
});

test('compile matches the committed golden IR byte for byte', () => {
  const result = compile(COMMITTED_ZIP_BYTES);
  assert.equal(result.ok, true, JSON.stringify(result.report?.errors));
  assert.equal(result.irBytes.length, ANCHORS.irBytes);
  assert.equal(result.digest, ANCHORS.irSha256);
  assert.deepEqual(Buffer.from(result.irBytes), GOLDEN_BYTES);
  assert.equal(sha256(GOLDEN_BYTES), ANCHORS.irSha256);

  const ir = irObject(GOLDEN_BYTES);
  assert.equal(ir.source.bundle.contentSha256, ANCHORS.contentSha256);

  const report = validateIr(GOLDEN_BYTES, { sha256: sha256Hex });
  assert.equal(report.ok, true);
  assert.equal(report.counts.errors, 0);
  assert.deepEqual(report.warnings, []);

  const cliValidate = runCli(['ir', 'validate', GOLDEN_IR, '--json']);
  assert.equal(cliValidate.status, 0, cliValidate.stderr);
  assert.equal(JSON.parse(cliValidate.stdout).ok, true);
});

test('the zip, the bundle directory and repacked zips compile identically', () => {
  assert.equal(DIRECTORY_FILES.length, 49);
  const fromDirectory = zipOf(DIRECTORY_FILES);
  assert.equal(fromDirectory.length, ANCHORS.zipBytes);

  const repacked = zipOf([...DIRECTORY_FILES].reverse(), {
    method: 'deflate',
    dosTime: 0x7c00,
    dosDate: 0x5a3f,
  });
  const repackedFast = zipOf(DIRECTORY_FILES, {
    method: 'deflate',
    deflateLevel: 1,
    dosTime: 0x1234,
    dosDate: 0x5c21,
  });
  assert.notEqual(repacked.length, COMMITTED_ZIP_BYTES.length);
  assert.notEqual(repackedFast.length, repacked.length);
  for (const zip of [repacked, repackedFast]) {
    const zipReport = validateBundle(zip, PRIMITIVES);
    assert.equal(zipReport.ok, true);
    assert.deepEqual(
      zipReport.warnings.map((warning) => [warning.code, warning.path]),
      EXPECTED_WARNINGS,
    );
  }

  const variants = [
    compile(COMMITTED_ZIP_BYTES),
    compile(fromDirectory),
    compile(repacked),
    compile(repackedFast),
    compile(COMMITTED_ZIP_BYTES),
  ];
  for (const variant of variants) {
    assert.equal(variant.ok, true);
    assert.deepEqual(Buffer.from(variant.irBytes), GOLDEN_BYTES);
  }

  const text = new TextDecoder().decode(GOLDEN_BYTES);
  assert.equal(canonicalJson(JSON.parse(text)), text);
});

test('README.md is not contract content; every contract byte change moves the IR', (t) => {
  const copied = tempDir(t, 'readme');
  cpSync(BUNDLE, copied, { recursive: true });
  writeFileSync(join(copied, 'README.md'), '# changed README\n');
  const readmeFiles = readBundleDirectory(copied);
  assert.equal(readmeFiles.length, 49);
  assert.equal(readmeFiles.some((file) => file.path === 'README.md'), false);
  assert.deepEqual(Buffer.from(compile(zipOf(readmeFiles)).irBytes), GOLDEN_BYTES);

  const mutated = (file) => {
    const text = file.bytes.toString('utf8');
    if (text.length === 0) return Buffer.from('x\n');
    if (file.path.endsWith('.json')) {
      const target = /"(?:description|name)": "/.exec(text);
      assert.notEqual(target, null, `no mutable JSON string in ${file.path}`);
      const at = target.index + target[0].length;
      return Buffer.from(`${text.slice(0, at)}x${text.slice(at)}`);
    }
    // Frontmatter-only role files need a body line; other Markdown gains a
    // character before the final LF so it still satisfies the text rules.
    return Buffer.from(text.endsWith('---\n') ? `${text}x\n` : `${text.slice(0, -1)}x\n`);
  };

  for (const file of DIRECTORY_FILES) {
    const files = DIRECTORY_FILES.map((candidate) => (
      candidate.path === file.path
        ? { path: candidate.path, bytes: mutated(candidate) }
        : candidate
    ));
    const result = compile(zipOf(files));
    assert.equal(result.ok, true, `${file.path}: ${JSON.stringify(result.report?.errors?.slice(0, 2))}`);
    assert.notDeepEqual(
      Buffer.from(result.irBytes),
      GOLDEN_BYTES,
      `changing ${file.path} must change the IR`,
    );
  }
});

test('contentSha256 and per-asset hashes self-prove independently', () => {
  const ir = irObject(GOLDEN_BYTES);
  const files = new Map(DIRECTORY_FILES.map((file) => [file.path, file.bytes]));

  const rows = ['bundle.json'];
  for (const stage of ir.stages) rows.push(stage.source.path);
  for (const entry of Object.values(ir.roles)) rows.push(entry.source.path);
  for (const entry of Object.values(ir.tasks)) rows.push(entry.source.path);
  for (const entry of Object.values(ir.skills)) rows.push(entry.source.path);
  for (const mount of ir.constitution) rows.push(mount.source.path);
  rows.sort();

  const manifest = rows.map((path) => `${path}\t${sha256(files.get(path))}\n`).join('');
  assert.equal(sha256(new TextEncoder().encode(manifest)), ANCHORS.contentSha256);
  assert.equal(ir.source.bundle.contentSha256, ANCHORS.contentSha256);
  assert.equal(ir.source.manifest.sha256, sha256(files.get('bundle.json')));

  const references = [
    ...ir.stages.map((stage) => stage.source),
    ...Object.values(ir.roles).map((entry) => entry.source),
    ...Object.values(ir.tasks).map((entry) => entry.source),
    ...Object.values(ir.skills).map((entry) => entry.source),
    ...ir.constitution.map((mount) => mount.source),
  ];
  for (const reference of references) {
    assert.equal(reference.sha256, sha256(files.get(reference.path)), reference.path);
  }
});

test('ir validate rejects non-canonical, unsupported and hash-inconsistent IR', () => {
  const base = irObject(GOLDEN_BYTES);

  const expectRejected = (label, bytes, code, pointer) => {
    const report = validateIr(bytes, { sha256: sha256Hex });
    assert.equal(report.ok, false, label);
    assert.deepEqual(report.warnings, [], label);
    assert.ok(report.errors.length > 0, label);
    assert.ok(
      report.errors.some((error) => error.code === code && error.pointer === pointer),
      `${label}: expected ${code}@${pointer}, got ${report.errors.map((e) => `${e.code}@${e.pointer}`).join(', ')}`,
    );
  };

  const reordered = { ...base };
  const keys = Object.keys(reordered);
  [keys[0], keys[1]] = [keys[1], keys[0]];
  const reorderedObject = Object.fromEntries(keys.map((key) => [key, reordered[key]]));
  expectRejected(
    'member reordering',
    canonicalBytes(reorderedObject),
    'IR_ORDER_INVALID',
    '',
  );

  expectRejected(
    'non-canonical formatting',
    new TextEncoder().encode(`${JSON.stringify(base, null, 4)}\n`),
    'IR_JSON_NOT_CANONICAL',
    '',
  );

  const unknownSchema = structuredClone(base);
  unknownSchema.schema = 'r2c.ir/v2';
  expectRejected(
    'unknown schema',
    canonicalBytes(unknownSchema),
    'IR_SCHEMA_UNSUPPORTED',
    '/schema',
  );

  const nonGlobal = structuredClone(base);
  nonGlobal.constitution[0].scope = 'stage';
  expectRejected(
    'non-global constitution mount',
    canonicalBytes(nonGlobal),
    'IR_CONSTITUTION_SCOPE',
    '/constitution/0/scope',
  );

  const assetHash = structuredClone(base);
  assetHash.roles['bys-architect'].source.sha256 = '0'.repeat(64);
  expectRejected(
    'asset hash mismatch',
    canonicalBytes(assetHash),
    'IR_HASH_MISMATCH',
    '/source/bundle/contentSha256',
  );

  const contentHash = structuredClone(base);
  contentHash.source.bundle.contentSha256 = '0'.repeat(64);
  expectRejected(
    'content hash mismatch',
    canonicalBytes(contentHash),
    'IR_HASH_MISMATCH',
    '/source/bundle/contentSha256',
  );
});

test('FILES.sha256 verifies 49/49 against the bundle tree', () => {
  const lines = readFileSync(FILES_SUMS, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 49);
  const rows = lines.map((line) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.notEqual(match, null, `malformed line: ${line}`);
    return [match[1], match[2]];
  });
  assert.equal(rows.length, 49);
  assert.deepEqual(
    rows.map(([, path]) => path),
    DIRECTORY_FILES.map((file) => file.path),
  );
  for (const [expected, path] of rows) {
    assert.equal(sha256(readFileSync(join(BUNDLE, path))), expected, path);
  }
});

test('CLI compile is byte-stable across runs and writes the golden IR', (t) => {
  const first = tempDir(t, 'cli-a');
  const second = tempDir(t, 'cli-b');
  for (const out of [first, second]) {
    const cli = runCli(['compile', COMMITTED_ZIP, '--out', out]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(readFileSync(join(out, 'workflow.ir.json')), GOLDEN_BYTES);
  }
  assert.deepEqual(
    readFileSync(join(first, 'workflow.ir.json')),
    readFileSync(join(second, 'workflow.ir.json')),
  );
});
