/**
 * Regression tests for the PR #112 review fixes:
 *
 *   #88  skill-directory extra files are BUNDLE_UNEXPECTED_PATH
 *   #92  an unpacked directory compiles to the same compiled workflow bytes as the zip
 *        code-point map ordering for numeric ids (`9` before `10` is wrong)
 *        `compile --json` reports the path it actually wrote
 *   §6   projection failure rows are diagnostics (severity/path/pointer)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { validateCompiledWorkflow } from '../assembler/validate-compiled.js';
import { COMPILED_WORKFLOW_FILENAME } from '../compiled/schema.js';
import { project } from '../projection/project.js';
import { getProjection } from '../projection/registry.js';
import {
  MINIMAL_MANIFEST,
  MINIMAL_STAGE,
  minimalFiles,
  minimalZip,
} from './helpers/minimal-bundle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'hm2b-assembler.js');
const PRIMITIVES = { inflateRaw, sha256: sha256Hex };
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function codesOf(report) {
  return report.errors.map((error) => `${error.code}@${error.path}`);
}

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

/* --------------------------------------------------------------------------
 * #88 skill-directory extra files
 * ------------------------------------------------------------------------ */

test('a skill-directory extra file is one BUNDLE_UNEXPECTED_PATH', () => {
  const report = validateBundle(
    minimalZip({ overrides: { 'skills/helper/README.md': 'notes\n' } }),
    PRIMITIVES,
  );
  assert.equal(report.ok, false);
  assert.deepEqual(codesOf(report), ['BUNDLE_UNEXPECTED_PATH@skills/helper/README.md']);
  assert.equal(report.errors.some((error) => error.code === 'BUNDLE_SKILL_EXTRA_FILE'), false);
});

/* --------------------------------------------------------------------------
 * Numeric ids serialize and validate in code-point order
 * ------------------------------------------------------------------------ */

function numericRole(id) {
  return [
    '---',
    `id: ${id}`,
    `description: Role ${id} for the numeric-id fixture.`,
    '---',
    '',
    `Role ${id} executes the only step.`,
    '',
  ].join('\n');
}

function numericBundle() {
  const manifest = { ...MINIMAL_MANIFEST, roles: ['10', '9'] };
  const stage = {
    ...MINIMAL_STAGE,
    steps: MINIMAL_STAGE.steps.map((step) => ({ ...step, role: '9' })),
  };
  return {
    'bundle.json': canonicalJson(manifest),
    'stages/only.json': canonicalJson(stage),
    'roles/9.md': numericRole('9'),
    'roles/10.md': numericRole('10'),
    'roles/worker.md': null,
  };
}

test('numeric map ids compile in code-point order and validate as canonical', () => {
  const compiled = compileBundle(minimalZip({ overrides: numericBundle() }), PRIMITIVES);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.report?.errors ?? []));
  const text = DECODER.decode(compiled.compiledWorkflowBytes);
  const ten = text.indexOf('\n    "10": {');
  const nine = text.indexOf('\n    "9": {');
  assert.ok(ten > 0 && nine > 0, 'roles map is emitted');
  assert.ok(ten < nine, `roles must be ordered "10" before "9":\n${text.slice(text.indexOf('"roles"'))}`);

  const report = validateCompiledWorkflow(compiled.compiledWorkflowBytes, { sha256: sha256Hex });
  assert.equal(report.ok, true, JSON.stringify(report.errors));

  // JSON.stringify enumerates integer-like keys numerically, so re-serializing
  // the parsed compiled workflow produces "9" before "10" — the validator must reject it.
  const numericOrder = ENCODER.encode(canonicalJson(JSON.parse(text)));
  const rejected = validateCompiledWorkflow(numericOrder, { sha256: sha256Hex });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.code === 'COMPILED_WORKFLOW_JSON_NOT_CANONICAL'));
});

/* --------------------------------------------------------------------------
 * #92 directory input and the written path in `compile --json`
 * ------------------------------------------------------------------------ */

function writeDirectory(root, files) {
  for (const [path, content] of files) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

test('compile accepts an unpacked directory and reports the written compiled workflow path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-fixes-'));
  try {
    const zipPath = join(dir, 'bundle.zip');
    writeFileSync(zipPath, minimalZip());
    const bundleDir = join(dir, 'bundle');
    mkdirSync(bundleDir, { recursive: true });
    writeDirectory(bundleDir, minimalFiles());

    const zipOut = join(dir, 'out-zip');
    const dirOut = join(dir, 'out-dir');
    const zipRun = run(['compile', zipPath, '--out', zipOut, '--json']);
    const dirRun = run(['compile', bundleDir, '--out', dirOut, '--json']);
    assert.equal(zipRun.status, 0, zipRun.stderr);
    assert.equal(dirRun.status, 0, dirRun.stderr);

    const zipEnvelope = JSON.parse(zipRun.stdout.trim());
    const dirEnvelope = JSON.parse(dirRun.stdout.trim());
    for (const [envelope, out] of [[zipEnvelope, zipOut], [dirEnvelope, dirOut]]) {
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data.compiledWorkflow.path, COMPILED_WORKFLOW_FILENAME);
      assert.equal(existsSync(join(out, envelope.data.compiledWorkflow.path)), true);
    }

    const zipBytes = readFileSync(join(zipOut, COMPILED_WORKFLOW_FILENAME));
    const dirBytes = readFileSync(join(dirOut, COMPILED_WORKFLOW_FILENAME));
    assert.deepEqual(dirBytes, zipBytes);
    assert.equal(dirEnvelope.data.compiledWorkflow.sha256, zipEnvelope.data.compiledWorkflow.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------
 * Projection failure rows are diagnostics (§6)
 * ------------------------------------------------------------------------ */

test('projection failures carry severity, path and pointer', () => {
  const manifest = getProjection('agent-native');
  assert.ok(manifest !== null);
  const compiledWorkflow = {
    schema: manifest.api.compiledWorkflow,
    id: 'numeric-fixture',
    version: '1.0.0',
    stages: [],
    skills: {},
  };
  const compiledWorkflowDigest = 'a'.repeat(64);
  const result = project({
    projectionId: 'agent-native',
    compiledWorkflow,
    compiledWorkflowDigest,
    options: {
      schema: 'hm2b.projection-options/v1',
      projection: 'agent-native',
      compiledWorkflow: { digest: compiledWorkflowDigest, id: compiledWorkflow.id, version: compiledWorkflow.version },
      stageOrder: [],
      skills: [],
      targets: ['missing-target'],
      extra: {},
    },
  });
  assert.equal(result.ok, false);
  const row = result.errors.find((error) => error.code === 'PROJECTION_TARGET_UNKNOWN');
  assert.ok(row, JSON.stringify(result.errors));
  assert.equal(row.severity, 'error');
  assert.equal(row.path, '');
  assert.equal(row.pointer, '/targets');
  assert.equal(row.target, 'missing-target');
  assert.equal(typeof row.message, 'string');
});
