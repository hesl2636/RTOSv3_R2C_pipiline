/**
 * Target descriptors after the P6 asset move.
 *
 * `runtime/agent-native/targets/<id>/assets/**` replaced the legacy
 * `adapters/<id>/assets/**` tree. Each descriptor declares its detection data,
 * the exact asset paths with sha256, and the post-install discovery
 * expectations (the model-free replacement for the retired adapter smoke
 * scripts). Nothing here touches a host binary or a model.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../core/node/sha256.js';
import { TARGETS, TARGET_ORDER } from '../runtime/agent-native/projection/targets/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('every target declares detection commands, paths and assets', () => {
  assert.deepEqual([...TARGET_ORDER], ['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
  for (const id of TARGET_ORDER) {
    const target = TARGETS[id];
    assert.ok(Array.isArray(target.detect.commands) && target.detect.commands.length > 0, `${id}: detect.commands`);
    for (const command of target.detect.commands) {
      assert.equal(command.length, 2, `${id}: command pair`);
      assert.equal(typeof command[0], 'string');
      assert.equal(typeof command[1], 'string');
    }
    assert.ok(Array.isArray(target.detect.paths) && target.detect.paths.length > 0, `${id}: detect.paths`);
    assert.ok(Array.isArray(target.assets) && target.assets.length > 0, `${id}: assets`);
  }
});

test('declared target assets exist and their sha256 matches the file', () => {
  for (const id of TARGET_ORDER) {
    for (const asset of TARGETS[id].assets) {
      assert.equal(asset.path.startsWith(`runtime/agent-native/targets/${id}/assets/`), true, asset.path);
      const bytes = readFileSync(join(ROOT, ...asset.path.split('/')));
      assert.equal(sha256Hex(bytes), asset.sha256, asset.path);
    }
  }
});

test('a target asset cannot be declared with an unknown location', () => {
  for (const id of TARGET_ORDER) {
    for (const asset of TARGETS[id].assets) {
      assert.doesNotMatch(asset.path, /adapters\/|shims\//, `${id}: ${asset.path}`);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    }
  }
});

test('smoke expectations are per-namespace, closed and host-native', () => {
  for (const id of TARGET_ORDER) {
    const target = TARGETS[id];
    assert.equal(typeof target.smoke, 'function', `${id}: smoke`);
    const expectations = target.smoke('demo-bundle');
    assert.ok(expectations.length > 0, `${id}: expectations`);
    assert.deepEqual(
      expectations.find((entry) => entry.kind === 'metadata'),
      { kind: 'metadata', root: '.agents/agent-native', prefix: 'demo-bundle/roles.json', format: 'json' },
      `${id}: roles metadata`,
    );
    for (const expectation of expectations) {
      assert.equal(typeof expectation.root, 'string');
      assert.equal(typeof expectation.prefix, 'string');
      assert.equal(expectation.root.startsWith('/'), false);
      assert.equal(expectation.root.includes('\\'), false);
    }
    const skills = expectations.find((entry) => entry.kind === 'skills');
    assert.ok(skills !== undefined, `${id}: skills`);
    assert.equal(skills.prefix, '');
  }
});

test('dsh exposes a role catalogue instead of per-role agent files', () => {
  const expectations = TARGETS.dsh.smoke('demo-bundle');
  const agents = expectations.find((entry) => entry.kind === 'agents');
  assert.deepEqual(agents, {
    kind: 'agents',
    root: '.dsh/agent-native',
    prefix: '',
    format: 'md',
  });
  assert.equal(TARGETS['claude-code'].smoke('x').some((entry) => entry.root === '.dsh/agent-native'), false);
});
