/**
 * Result validation V1–V12 (#69 §12.2, #82 §2/§5/§8).
 *
 * Every consumer (CLI, web, installer) must run this before using a result.
 * Each case mutates one contract point and asserts the named check fires.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileBundle } from '../assembler/compile.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { payloadResultBlock, RESULT_BLOCK_FIELDS, RESULT_FIELDS } from '../installer/release-payload.js';
import { normalizeOptions } from '../projection/options.js';
import { RESULT_FIELDS as CONTRACT_RESULT_FIELDS } from '../projection/result-fields.js';
import { project } from '../projection/project.js';
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const MANIFEST = getProjection('agent-native');

let cached;
function baseline() {
  if (cached !== undefined) return cached;
  const compiled = compileBundle(new Uint8Array(readFileSync(ZIP)), { inflateRaw, sha256: sha256Hex });
  assert.equal(compiled.ok, true);
  const compiledWorkflow = JSON.parse(new TextDecoder().decode(compiled.compiledWorkflowBytes));
  const compiledWorkflowDigest = compiled.digest;
  const { options } = normalizeOptions({
    projectionId: 'agent-native',
    compiledWorkflow,
    compiledWorkflowDigest,
    raw: { targets: ['claude-code'] },
    manifest: MANIFEST,
  });
  const result = project({
    projectionId: 'agent-native',
    compiledWorkflow,
    compiledWorkflowDigest,
    options,
    environment: {},
    assets: {},
  });
  cached = { compiledWorkflow, compiledWorkflowDigest, options, result };
  return cached;
}

function validate(result, base = baseline()) {
  return validateResult(result, {
    compiledWorkflow: base.compiledWorkflow,
    compiledWorkflowDigest: base.compiledWorkflowDigest,
    options: base.options,
    manifest: MANIFEST,
  });
}

function checksOf(outcome) {
  return outcome.diagnostics.map((diagnostic) => diagnostic.details.check);
}

function mutate(mutator) {
  const base = baseline();
  const result = structuredClone(base.result);
  mutator(result);
  return validate(result, base);
}

test('the baseline result passes every check', () => {
  const outcome = validate(baseline().result);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.diagnostics, null, 2));
  assert.deepEqual(outcome.diagnostics, []);
});

test('V1 rejects a projection/compiled workflow reference mismatch', () => {
  const outcome = mutate((result) => { result.compiledWorkflow.digest = '0'.repeat(64); });
  assert.equal(outcome.ok, false);
  assert.ok(checksOf(outcome).includes('V1'));
});

test('V2 rejects options/environment that do not echo the resolved input', () => {
  assert.ok(checksOf(mutate((result) => { result.options.stageOrder = null; })).includes('V2'));
  assert.ok(checksOf(mutate((result) => { result.options.targets = null; })).includes('V2'));
  assert.ok(checksOf(mutate((result) => { result.environment.engineVersion = '9.9.9'; })).includes('V2'));
});

test('V3 rejects targets that are not the resolved option targets', () => {
  const outcome = mutate((result) => { result.targets = ['codex']; });
  assert.ok(checksOf(outcome).includes('V3'));
});

test('V4 rejects coverage that is not the applied stage/step order', () => {
  const outcome = mutate((result) => { result.coverage.stages = [...result.coverage.stages].reverse(); });
  assert.ok(checksOf(outcome).includes('V4'));
});

test('V5 rejects escaped, duplicated and out-of-root paths', () => {
  assert.ok(checksOf(mutate((result) => { result.files[0].path = '../escape'; })).includes('V5'));
  assert.ok(checksOf(mutate((result) => { result.files[0].path = 'CLAUDE.md'; })).includes('V5'));
  assert.ok(checksOf(mutate((result) => {
    result.files[1].path = result.files[0].path;
  })).includes('V5'));
});

test('V5 allows bundle asset roots only in the projection that declares them', () => {
  const base = baseline();
  const result = structuredClone(base.result);
  const original = result.files[0].path;
  result.files[0].path = 'knowledge-base/demo.md';
  for (const step of result.installPlan.steps) {
    if (step.path === original) step.path = result.files[0].path;
  }
  // agent-native writes assets under .agents/agent-native/<ns>/, never the root.
  const outside = (outcome) => outcome.diagnostics.some((item) => item.details.check === 'V5'
    && item.message.includes(`${result.files[0].path}: outside writeRoots`));
  assert.equal(outside(validate(result, base)), true);

  // runner declares knowledge-base/ at the project root, so that path is legal.
  const runner = getProjection('runner');
  const runnerOutcome = validateResult(result, {
    compiledWorkflow: base.compiledWorkflow,
    compiledWorkflowDigest: base.compiledWorkflowDigest,
    options: base.options,
    manifest: runner,
  });
  assert.equal(outside(runnerOutcome), false);
});

test('the result schema documents the bundle asset file kinds', () => {
  const document = JSON.parse(readFileSync(join(ROOT, 'projection/schema/result.schema.json'), 'utf8'));
  const kinds = document.$defs.file.properties.kind.enum;
  for (const kind of ['knowledge', 'checklist', 'hooks', 'mcp']) assert.ok(kinds.includes(kind), kind);
});

test('V6 rejects CR, missing trailing LF and bad modes', () => {
  assert.ok(checksOf(mutate((result) => { result.files[0].content = result.files[0].content.replace('\n', '\r\n'); })).includes('V6'));
  assert.ok(checksOf(mutate((result) => { result.files[0].content = 'no trailing newline'; })).includes('V6'));
  assert.ok(checksOf(mutate((result) => { result.files[0].mode = 0o600; })).includes('V6'));
});

test('V7 rejects an install plan that drops or duplicates a write', () => {
  assert.ok(checksOf(mutate((result) => { result.installPlan.steps.pop(); })).includes('V7'));
  assert.ok(checksOf(mutate((result) => { result.installPlan.steps.push(structuredClone(result.installPlan.steps[0])); })).includes('V7'));
});

test('V8 rejects capability rows out of order or better than declared', () => {
  assert.ok(checksOf(mutate((result) => {
    const first = result.capabilityReport[0];
    result.capabilityReport[0] = result.capabilityReport[1];
    result.capabilityReport[1] = first;
  })).includes('V8'));
  assert.ok(checksOf(mutate((result) => { result.capabilityReport[0].level = 'native'; })).includes('V8'));
  assert.ok(checksOf(mutate((result) => { result.capabilityReport[1].uses = ['/stages/99']; })).includes('V8'));

  // Worse than declared is a defect unless the option selection explains it.
  const overDegraded = mutate((result) => { result.capabilityReport[3].level = 'unavailable'; });
  assert.ok(checksOf(overDegraded).includes('V8'));
  assert.ok(overDegraded.diagnostics.some((item) => item.message.includes('worse than declared')));
  // Excluding skills is the one legitimate reason: the projection records a
  // CAP_SKILL_EXCLUDED degradation for the worst use point.
  assert.equal(validate(baseline().result).ok, true);
});

test('V9 rejects a semantic use point without its degradation record', () => {
  const outcome = mutate((result) => {
    result.degradations = result.degradations.filter((record) => record.capability !== 'state');
  });
  assert.ok(checksOf(outcome).includes('V9'));
  // Degradation pointers must resolve in the compiled workflow.
  assert.ok(checksOf(mutate((result) => {
    result.degradations[0].pointer = '/stages/99';
  })).includes('V9'));
});

test('V10 rejects placeholder, idMap and artifact drift', () => {
  assert.ok(checksOf(mutate((result) => { result.metadata.placeholders.constitution = 'present'; })).includes('V10'));
  assert.ok(checksOf(mutate((result) => { result.metadata.placeholders.roles = []; })).includes('V10'));
  assert.ok(checksOf(mutate((result) => {
    result.metadata.artifacts.workflow = '.claude/missing/SKILL.md';
  })).includes('V10'));
});

test('V11 rejects a {{submit}} residue', () => {
  const outcome = mutate((result) => { result.files[0].content += '{{submit}}\n'; });
  assert.ok(checksOf(outcome).includes('V11'));
});

test('V12 rejects non-canonical top-level order', () => {
  const outcome = mutate((result) => {
    const reordered = { ok: result.ok, schema: result.schema };
    for (const [key, value] of Object.entries(result)) {
      if (key !== 'schema' && key !== 'ok') reordered[key] = value;
    }
    for (const key of Object.keys(result)) delete result[key];
    Object.assign(result, reordered);
  });
  assert.ok(checksOf(outcome).includes('V12'));
});

test('diagnostics use the stable PROJECTION_RESULT_INVALID code', () => {
  const outcome = mutate((result) => { result.schema = 'hm2b.projection-result/v2'; });
  assert.equal(outcome.ok, false);
  for (const diagnostic of outcome.diagnostics) {
    assert.equal(diagnostic.code, 'PROJECTION_RESULT_INVALID');
    assert.equal(diagnostic.severity, 'error');
  }
});

test('the result field order has one source for the validator and the payload', () => {
  // V12 enforces this order; the payload manifest rebuilds results in it.
  assert.equal(RESULT_FIELDS, CONTRACT_RESULT_FIELDS);
  assert.deepEqual(Object.keys(baseline().result), [...CONTRACT_RESULT_FIELDS]);
  assert.deepEqual(Object.keys(payloadResultBlock(baseline().result)), [...RESULT_BLOCK_FIELDS]);
  assert.deepEqual(RESULT_BLOCK_FIELDS, CONTRACT_RESULT_FIELDS.filter((field) => field !== 'files'));
});

test('V8 accepts a worse level only when option exclusion explains the worst use', () => {
  const base = baseline();
  const selected = Object.keys(base.compiledWorkflow.skills).slice(0, 1);
  const { options } = normalizeOptions({
    projectionId: 'agent-native',
    compiledWorkflow: base.compiledWorkflow,
    compiledWorkflowDigest: base.compiledWorkflowDigest,
    raw: { targets: ['claude-code'], skills: selected },
    manifest: MANIFEST,
  });
  const projected = project({
    projectionId: 'agent-native',
    compiledWorkflow: base.compiledWorkflow,
    compiledWorkflowDigest: base.compiledWorkflowDigest,
    options,
    environment: {},
    assets: {},
  });
  const row = projected.capabilityReport.find((entry) => entry.target === 'claude-code' && entry.capability === 'skills');
  const declared = MANIFEST.targets.find((target) => target.id === 'claude-code').capabilities.skills.level;
  assert.ok(row.level !== declared, 'the excluded selection must lower the aggregate level');
  assert.ok(projected.degradations.some((record) => record.code === 'CAP_SKILL_EXCLUDED'
    && record.capability === 'skills' && record.level === row.level));

  const outcome = validateResult(projected, {
    compiledWorkflow: base.compiledWorkflow,
    compiledWorkflowDigest: base.compiledWorkflowDigest,
    options,
    manifest: MANIFEST,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.diagnostics, null, 2));
});

test('the capability vocabulary and level ranks have one source', async () => {
  const { CAPABILITIES, LEVEL_RANK, SEMANTIC_CAPABILITIES } = await import('../projection/contract.js');
  const { CAPABILITIES: producerCapabilities, LEVEL_RANK: producerRanks } = await import('../runtime/agent-native/projection/project.js');
  const { RUNNER_CAPABILITIES } = await import('../runtime/runner/projection/manifest.js');
  assert.deepEqual(producerCapabilities, CAPABILITIES);
  assert.deepEqual(RUNNER_CAPABILITIES, CAPABILITIES);
  assert.equal(producerRanks, LEVEL_RANK);
  assert.deepEqual(SEMANTIC_CAPABILITIES, ['state', 'gates', 'outputs', 'subagents', 'skills', 'preload']);
  // The validator consumes the same list, so report order cannot drift.
  assert.deepEqual(baseline().result.capabilityReport.slice(0, CAPABILITIES.length).map((row) => row.capability), [...CAPABILITIES]);
});
