/**
 * Baseline anchors and compile determinism (ticket #92, spec §5/§17, #68).
 *
 * The committed rtosv3 sample is the regression oracle:
 *   - validating it yields exactly the frozen 2 warnings and exit 0;
 *   - compiling it yields the frozen 58,919-byte compiled workflow (sha256 34d55ee6…);
 *   - the zip, the source directory, and repacked variants compile to the
 *     same bytes;
 *   - only contract content can change the compiled workflow; README.md cannot;
 *   - `compiled-workflow validate` rejects every non-canonical/hash-inconsistent document.
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
import { validateCompiledWorkflow } from '../assembler/validate-compiled.js';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { buildZip } from './helpers/zip.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(REPO, 'examples', 'rtosv3');
const BUNDLE = join(EXAMPLE, 'bundle');
const COMMITTED_ZIP = join(EXAMPLE, 'dist', 'bundle-rtosv3-drvport-v1.0.0.zip');
const FILES_SUMS = join(EXAMPLE, 'FILES.sha256');
const GOLDEN_COMPILED_WORKFLOW = join(REPO, 'test', 'fixtures', 'compiled', 'workflow.compiled.json');
const CLI = join(REPO, 'bin', 'hm2b-assembler.js');

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };

const ANCHORS = Object.freeze({
  zipBytes: 55043,
  zipSha256: 'ff1f3004c618be9d5ee6b090e0d635f6a6c7cb49a8c22e188cc11206bbe37cd4',
  compiledWorkflowBytes: 58919,
  compiledWorkflowSha256: '518643ab9c92d270a66bd4545cba660d0511243070c3479234edec3225b6d23c',
  contentSha256: '2093b03b97c90c6e77dfeb26c69d585ef78a11170032151171c31272ac7dbbf2',
  manifestSha256: '6f92d763fb82cd00d36f99e8dc42ba26f0a510c4b64bd9d741e2625bec68df84',
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
  const dir = mkdtempSync(join(tmpdir(), `hm2b-baseline-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8' });
}

function compiledWorkflowObject(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function canonicalBytes(compiledWorkflow) {
  return new TextEncoder().encode(canonicalJson(compiledWorkflow));
}

const COMMITTED_ZIP_BYTES = readFileSync(COMMITTED_ZIP);
const GOLDEN_BYTES = readFileSync(GOLDEN_COMPILED_WORKFLOW);
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

test('compile matches the committed golden compiled workflow byte for byte', () => {
  const result = compile(COMMITTED_ZIP_BYTES);
  assert.equal(result.ok, true, JSON.stringify(result.report?.errors));
  assert.equal(result.compiledWorkflowBytes.length, ANCHORS.compiledWorkflowBytes);
  assert.equal(result.digest, ANCHORS.compiledWorkflowSha256);
  assert.deepEqual(Buffer.from(result.compiledWorkflowBytes), GOLDEN_BYTES);
  assert.equal(sha256(GOLDEN_BYTES), ANCHORS.compiledWorkflowSha256);

  const compiledWorkflow = compiledWorkflowObject(GOLDEN_BYTES);
  assert.equal(compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');
  assert.equal(compiledWorkflow.source.bundle.schema, 'hm2b.bundle/v2');
  assert.equal(compiledWorkflow.source.bundle.contentSha256, ANCHORS.contentSha256);
  assert.equal(compiledWorkflow.source.manifest.sha256, ANCHORS.manifestSha256);
  assert.deepEqual(compiledWorkflow.knowledgeBase, []);
  assert.deepEqual(compiledWorkflow.checklists, []);
  assert.equal(compiledWorkflow.hooks, null);
  assert.equal(compiledWorkflow.mcp, null);

  const report = validateCompiledWorkflow(GOLDEN_BYTES, { sha256: sha256Hex });
  assert.equal(report.ok, true);
  assert.equal(report.counts.errors, 0);
  assert.deepEqual(report.warnings, []);

  const cliValidate = runCli(['compiled-workflow', 'validate', GOLDEN_COMPILED_WORKFLOW, '--json']);
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
    assert.deepEqual(Buffer.from(variant.compiledWorkflowBytes), GOLDEN_BYTES);
  }

  const text = new TextDecoder().decode(GOLDEN_BYTES);
  assert.equal(canonicalJson(JSON.parse(text)), text);
});

test('README.md is not contract content; every contract byte change moves the compiled workflow', (t) => {
  const copied = tempDir(t, 'readme');
  cpSync(BUNDLE, copied, { recursive: true });
  writeFileSync(join(copied, 'README.md'), '# changed README\n');
  const readmeFiles = readBundleDirectory(copied);
  assert.equal(readmeFiles.length, 49);
  assert.equal(readmeFiles.some((file) => file.path === 'README.md'), false);
  assert.deepEqual(Buffer.from(compile(zipOf(readmeFiles)).compiledWorkflowBytes), GOLDEN_BYTES);

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
      Buffer.from(result.compiledWorkflowBytes),
      GOLDEN_BYTES,
      `changing ${file.path} must change the compiled workflow`,
    );
  }
});

test('contentSha256 and per-asset hashes self-prove independently', () => {
  const compiledWorkflow = compiledWorkflowObject(GOLDEN_BYTES);
  const files = new Map(DIRECTORY_FILES.map((file) => [file.path, file.bytes]));

  const rows = ['bundle.json'];
  for (const stage of compiledWorkflow.stages) rows.push(stage.source.path);
  for (const entry of Object.values(compiledWorkflow.roles)) rows.push(entry.source.path);
  for (const entry of Object.values(compiledWorkflow.tasks)) rows.push(entry.source.path);
  for (const entry of Object.values(compiledWorkflow.skills)) rows.push(entry.source.path);
  for (const mount of compiledWorkflow.constitution) rows.push(mount.source.path);
  rows.sort();

  const manifest = rows.map((path) => `${path}\t${sha256(files.get(path))}\n`).join('');
  assert.equal(sha256(new TextEncoder().encode(manifest)), ANCHORS.contentSha256);
  assert.equal(compiledWorkflow.source.bundle.contentSha256, ANCHORS.contentSha256);
  assert.equal(compiledWorkflow.source.manifest.sha256, sha256(files.get('bundle.json')));

  const references = [
    ...compiledWorkflow.stages.map((stage) => stage.source),
    ...Object.values(compiledWorkflow.roles).map((entry) => entry.source),
    ...Object.values(compiledWorkflow.tasks).map((entry) => entry.source),
    ...Object.values(compiledWorkflow.skills).map((entry) => entry.source),
    ...compiledWorkflow.constitution.map((mount) => mount.source),
  ];
  for (const reference of references) {
    assert.equal(reference.sha256, sha256(files.get(reference.path)), reference.path);
  }
});

test('compiled-workflow validate rejects non-canonical, unsupported and hash-inconsistent compiled workflow', () => {
  const base = compiledWorkflowObject(GOLDEN_BYTES);

  const expectRejected = (label, bytes, code, pointer) => {
    const report = validateCompiledWorkflow(bytes, { sha256: sha256Hex });
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
    'COMPILED_WORKFLOW_ORDER_INVALID',
    '',
  );

  expectRejected(
    'non-canonical formatting',
    new TextEncoder().encode(`${JSON.stringify(base, null, 4)}\n`),
    'COMPILED_WORKFLOW_JSON_NOT_CANONICAL',
    '',
  );

  const unknownSchema = structuredClone(base);
  unknownSchema.schema = 'hm2b.compiled-workflow/v3';
  expectRejected(
    'unknown schema',
    canonicalBytes(unknownSchema),
    'COMPILED_WORKFLOW_SCHEMA_UNSUPPORTED',
    '/schema',
  );

  const nonGlobal = structuredClone(base);
  nonGlobal.constitution[0].scope = 'stage';
  expectRejected(
    'non-global constitution mount',
    canonicalBytes(nonGlobal),
    'COMPILED_WORKFLOW_CONSTITUTION_SCOPE',
    '/constitution/0/scope',
  );

  const assetHash = structuredClone(base);
  assetHash.roles['bys-architect'].source.sha256 = '0'.repeat(64);
  expectRejected(
    'asset hash mismatch',
    canonicalBytes(assetHash),
    'COMPILED_WORKFLOW_HASH_MISMATCH',
    '/source/bundle/contentSha256',
  );

  const contentHash = structuredClone(base);
  contentHash.source.bundle.contentSha256 = '0'.repeat(64);
  expectRejected(
    'content hash mismatch',
    canonicalBytes(contentHash),
    'COMPILED_WORKFLOW_HASH_MISMATCH',
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

test('CLI compile is byte-stable across runs and writes the golden compiled workflow', (t) => {
  const first = tempDir(t, 'cli-a');
  const second = tempDir(t, 'cli-b');
  for (const out of [first, second]) {
    const cli = runCli(['compile', COMMITTED_ZIP, '--out', out]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(readFileSync(join(out, 'workflow.compiled.json')), GOLDEN_BYTES);
  }
  assert.deepEqual(
    readFileSync(join(first, 'workflow.compiled.json')),
    readFileSync(join(second, 'workflow.compiled.json')),
  );
});
