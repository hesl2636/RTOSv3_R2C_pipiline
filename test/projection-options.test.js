/**
 * Projection option normalization (#95 seed, #69 §5, #82 §2).
 *
 * Inputs may be `null` (default), but the returned options always echo the
 * resolved arrays: consumers never have to re-resolve `null` themselves.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOptions } from '../projection/options.js';

const DIGEST = 'a'.repeat(64);

const MANIFEST = {
  id: 'agent-native',
  targets: [
    { id: 'claude-code', default: true },
    { id: 'codex', default: true },
    { id: 'dsh', default: true },
    { id: 'omp', default: true },
    { id: 'opencode', default: true },
  ],
};

const IR = {
  schema: 'r2c.ir/v1',
  id: 'demo',
  version: '1.0.0',
  stages: [
    { id: 'analysis', steps: [{ id: 'analysis', task: 't', skills: [], outputs: [], gates: [] }] },
    { id: 'implementation', steps: [{ id: 'implementation', task: 't', skills: [], outputs: [], gates: [] }] },
  ],
  skills: { 'zeta-skill': {}, 'alpha-skill': {} },
  roles: {},
  tasks: {},
  constitution: [],
  source: { bundle: { contentSha256: 'b'.repeat(64) } },
};

function normalize(raw) {
  return normalizeOptions({
    projectionId: 'agent-native',
    ir: IR,
    irDigest: DIGEST,
    raw,
    manifest: MANIFEST,
  });
}

function codes(outcome) {
  return outcome.errors.map((error) => error.code);
}

test('null inputs resolve to the IR order, sorted skills and manifest targets', () => {
  const outcome = normalize(null);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.options, {
    schema: 'r2c.projection-options/v1',
    projection: 'agent-native',
    ir: { digest: DIGEST, id: 'demo', version: '1.0.0' },
    stageOrder: ['analysis', 'implementation'],
    skills: ['alpha-skill', 'zeta-skill'],
    targets: ['claude-code', 'codex', 'dsh', 'omp', 'opencode'],
    extra: {},
  });
});

test('explicit options are resolved: user stage order, sorted skills, manifest target order', () => {
  const outcome = normalize({
    stageOrder: ['implementation', 'analysis'],
    skills: ['zeta-skill'],
    targets: ['omp', 'claude-code'],
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.options.stageOrder, ['implementation', 'analysis']);
  assert.deepEqual(outcome.options.skills, ['zeta-skill']);
  assert.deepEqual(outcome.options.targets, ['claude-code', 'omp']);
});

test('the IR binding is recomputed and a stale digest is rejected with the shared code', () => {
  const outcome = normalize({ ir: { digest: 'c'.repeat(64), id: 'demo', version: '1.0.0' } });
  assert.equal(outcome.ok, false);
  assert.deepEqual(codes(outcome), ['PROJECTION_OPTIONS_IR_MISMATCH']);
  assert.equal(outcome.options.ir.digest, DIGEST);
});

test('invalid stage order, skills, targets and extra are rejected', () => {
  assert.deepEqual(codes(normalize({ stageOrder: ['analysis'] })), ['PROJECTION_OPTIONS_INVALID']);
  assert.deepEqual(codes(normalize({ stageOrder: ['analysis', 'analysis'] })), ['PROJECTION_OPTIONS_INVALID']);
  assert.deepEqual(codes(normalize({ skills: ['missing-skill'] })), ['PROJECTION_OPTIONS_INVALID']);
  assert.deepEqual(codes(normalize({ skills: ['alpha-skill', 'alpha-skill'] })), ['PROJECTION_OPTIONS_INVALID']);
  assert.deepEqual(codes(normalize({ targets: [] })), ['PROJECTION_OPTIONS_INVALID']);
  const unknown = normalize({ targets: ['claude-code', 'nope'] });
  assert.equal(unknown.ok, false);
  assert.deepEqual(codes(unknown), ['PROJECTION_TARGET_UNKNOWN']);
  assert.deepEqual(codes(normalize({ extra: { roleModels: {} } })), ['PROJECTION_OPTIONS_INVALID']);
  assert.deepEqual(codes(normalize({ schema: 'r2c.projection-options/v2' })), ['PROJECTION_OPTIONS_INVALID']);
  assert.deepEqual(codes(normalize({ projection: 'r2c' })), ['PROJECTION_OPTIONS_INVALID']);
});
