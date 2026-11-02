/**
 * `requires.engine` evaluation (spec §13), shared by the web build and the
 * installer. One implementation means the two surfaces cannot disagree.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEngineRequirement } from '../projection/engine-requirement.js';

test('an absent range constrains nothing', () => {
  assert.deepEqual(checkEngineRequirement({ range: undefined, engineVersion: null }), { ok: true });
  assert.deepEqual(checkEngineRequirement({}), { ok: true });
});

test('the engine version must satisfy the range', () => {
  assert.deepEqual(checkEngineRequirement({ range: '^0.1.0', engineVersion: '0.1.0' }), { ok: true });
  const unsatisfied = checkEngineRequirement({ range: '^9.0.0', engineVersion: '0.1.0' });
  assert.equal(unsatisfied.ok, false);
  assert.equal(unsatisfied.code, 'PROJECTION_ENGINE_UNSATISFIED');
});

test('an unreadable version or range is PROJECTION_ENGINE_UNKNOWN', () => {
  assert.equal(checkEngineRequirement({ range: '^0.1.0', engineVersion: null }).code, 'PROJECTION_ENGINE_UNKNOWN');
  assert.equal(checkEngineRequirement({ range: 'nope', engineVersion: '0.1.0' }).code, 'PROJECTION_ENGINE_UNKNOWN');
});

test('the framework version never satisfies an engine requirement by accident', () => {
  // Engine 0.1.0, framework 9.9.9: only the engine version is authoritative.
  assert.equal(checkEngineRequirement({ range: '^0.1.0', engineVersion: '0.1.0' }).ok, true);
  assert.equal(checkEngineRequirement({ range: '^0.1.0', engineVersion: '9.9.9' }).code, 'PROJECTION_ENGINE_UNSATISFIED');
});
