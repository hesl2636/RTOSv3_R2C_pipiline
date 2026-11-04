import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SemverError,
  compareSemver,
  isValidRange,
  isValidVersion,
  parseSemver,
  satisfiesRange,
} from '../core/semver.js';

/** Fixed vectors from #11 §1.4; the first five rows were cross-checked with npm. */
const VECTORS = [
  ['^0.1.0', '0.1.0', true],
  ['^0.1.0', '0.1.9', true],
  ['^0.1.0', '0.2.0', false],
  ['>=0.2.1-rc.2 <0.3.0', '0.2.1-rc.2', true],
  ['>=0.2.1-rc.2 <0.3.0', '0.2.1-rc.3', true],
  ['>=0.2.1-rc.2 <0.3.0', '0.2.1', true],
  ['>=0.2.1-rc.2 <0.3.0', '0.2.0', false],
  ['>=0.2.1-rc.2 <0.3.0', '0.3.0', false],
  ['>=22.19.0 <23 || >=24.0.0', '24.22.1', true],
  ['>=22.19.0 <23 || >=24.0.0', '23.5.0', false],
  ['>=0.165.0 <1', '0.165.0', true],
  ['>=0.165.0 <1', '0.164.9', false],
  ['>=0.165.0 <1', '1.0.0', false],
  ['^1.2.0', '1.2.0', true],
  ['^1.2.0', '1.9.9', true],
  ['^1.2.0', '2.0.0', false],
];

test('satisfies the fixed range vectors', () => {
  for (const [range, version, expected] of VECTORS) {
    assert.equal(satisfiesRange(range, version), expected, `${version} in ${range}`);
  }
});

test('supports every operator, bare versions and disjunctions', () => {
  assert.equal(satisfiesRange('0.1.0', '0.1.0'), true);
  assert.equal(satisfiesRange('=0.1.0', '0.1.0'), true);
  assert.equal(satisfiesRange('=0.1.0', '0.1.1'), false);
  assert.equal(satisfiesRange('>0.1.0', '0.1.0'), false);
  assert.equal(satisfiesRange('>0.1.0', '0.1.1'), true);
  assert.equal(satisfiesRange('<0.1.0', '0.1.0'), false);
  assert.equal(satisfiesRange('<0.1.0', '0.0.9'), true);
  assert.equal(satisfiesRange('<=0.1.0', '0.1.0'), true);
  assert.equal(satisfiesRange('<=0.1.0', '0.1.1'), false);
  assert.equal(satisfiesRange('>=0.1.0', '0.1.9'), true);
  assert.equal(satisfiesRange('>=0.1.0', '0.0.9'), false);
  assert.equal(satisfiesRange('^9.0.0 || ^1.0.0', '1.0.0'), true);
  assert.equal(satisfiesRange('^9.0.0 || ^2.0.0', '1.0.0'), false);
  assert.equal(satisfiesRange('~1.2.0', '1.2.3'), true);
  assert.equal(satisfiesRange('~1.2.0', '1.3.0'), false);
  assert.equal(satisfiesRange('^0.0.3', '0.0.3'), true);
  assert.equal(satisfiesRange('^0.0.3', '0.0.4'), false);
});

test('applies semver prerelease precedence', () => {
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0') < 0, true);
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0, true);
  assert.equal(compareSemver('1.0.0-alpha.beta', '1.0.0-beta') < 0, true);
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.11') < 0, true);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0') < 0, true);
  assert.equal(compareSemver('0.2.1-rc.2', '0.2.1-rc.10') < 0, true);
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(satisfiesRange('>=0.2.1-rc.2 <0.3.0', '0.2.1-rc.1'), false);
  assert.equal(satisfiesRange('>=0.2.1-rc.2 <0.3.0', '0.2.1-rc.10'), true);
});

test('parses and validates strictly', () => {
  assert.deepEqual(parseSemver('1.2.3-rc.4+meta'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['rc', '4'],
  });
  assert.equal(isValidVersion('0.1.0'), true);
  assert.equal(isValidVersion('v0.1.0'), false);
  assert.equal(isValidVersion('0.1'), false);
  assert.equal(isValidVersion('01.0.0'), false);
  assert.equal(isValidVersion('0.1.0-01'), false);
  assert.equal(isValidRange('^0.1.0'), true);
  assert.equal(isValidRange('>=22.19.0 <23 || >=24.0.0'), true);
  assert.equal(isValidRange(''), false);
  assert.equal(isValidRange('>=0.1.0 ||'), false);
  assert.equal(isValidRange('*'), false);

  for (const invalid of ['', 'nope', '1', '1.2', '1.2.3.4', '1.2.3-', '1.2.3+']) {
    assert.throws(() => parseSemver(invalid), SemverError, invalid);
  }
  assert.throws(() => satisfiesRange('>=x', '1.0.0'), SemverError);
  assert.throws(() => satisfiesRange('^1.0.0', 'not-a-version'), SemverError);
});

test('framework and engine versions are independent everywhere they are read', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readEngine } = await import('../scripts/lib/bundle-release.mjs');
  const { installRuntime } = await import('../installer/runtime.js');
  const { installStatus } = await import('../installer/status.js');
  const { checkEngineRequirement } = await import('../projection/engine-requirement.js');

  const root = mkdtempSync(join(tmpdir(), 'hm2b-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hm2b-framework', version: '9.9.9' }));
  mkdirSync(join(root, 'runtime/runner/engine'), { recursive: true });
  writeFileSync(
    join(root, 'runtime/runner/engine/package.json'),
    JSON.stringify({ name: 'hm2b-runner', version: '1.2.3' }),
  );

  // The release reads the engine package, never the root package.
  assert.equal(readEngine(root).version, '1.2.3');

  // The installer records the engine source's own version.
  mkdirSync(join(root, 'engine-source/bin'), { recursive: true });
  writeFileSync(join(root, 'engine-source/bin/hm2b.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'engine-source/package.json'), JSON.stringify({ name: 'hm2b-runner', version: '4.5.6' }));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const installed = installRuntime({ projectRoot, engineSource: join(root, 'engine-source') });
  assert.equal(installed.ok, true);
  assert.equal(installed.engine.version, '4.5.6');

  // `status` reports the runtime receipt's engine version, not the framework's.
  assert.equal(installStatus(projectRoot).engine.version, '4.5.6');

  // `requires.engine` is evaluated against the engine, so the framework
  // version could never satisfy or refuse it.
  assert.equal(checkEngineRequirement({ range: '^4.0.0', engineVersion: installed.engine.version }).ok, true);
  assert.equal(checkEngineRequirement({ range: '^4.0.0', engineVersion: '9.9.9' }).code, 'PROJECTION_ENGINE_UNSATISFIED');
});
