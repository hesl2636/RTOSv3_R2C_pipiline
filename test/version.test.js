import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SemverError,
  compareVersions,
  isValidRange,
  isValidVersion,
  parseVersion,
  satisfies,
} from '../src/version.js';

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
    assert.equal(satisfies(version, range), expected, `${version} in ${range}`);
  }
});

test('supports every operator, bare versions and disjunctions', () => {
  assert.equal(satisfies('0.1.0', '0.1.0'), true);
  assert.equal(satisfies('0.1.0', '=0.1.0'), true);
  assert.equal(satisfies('0.1.1', '=0.1.0'), false);
  assert.equal(satisfies('0.1.0', '>0.1.0'), false);
  assert.equal(satisfies('0.1.1', '>0.1.0'), true);
  assert.equal(satisfies('0.1.0', '<0.1.0'), false);
  assert.equal(satisfies('0.0.9', '<0.1.0'), true);
  assert.equal(satisfies('0.1.0', '<=0.1.0'), true);
  assert.equal(satisfies('0.1.1', '<=0.1.0'), false);
  assert.equal(satisfies('0.1.9', '>=0.1.0'), true);
  assert.equal(satisfies('0.0.9', '>=0.1.0'), false);
  assert.equal(satisfies('1.0.0', '^9.0.0 || ^1.0.0'), true);
  assert.equal(satisfies('1.0.0', '^9.0.0 || ^2.0.0'), false);
  assert.equal(satisfies('1.2.3', '~1.2.0'), true);
  assert.equal(satisfies('1.3.0', '~1.2.0'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
});

test('applies semver prerelease precedence', () => {
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0') < 0, true);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0, true);
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-beta') < 0, true);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11') < 0, true);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0') < 0, true);
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.10') < 0, true);
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(satisfies('0.2.1-rc.1', '>=0.2.1-rc.2 <0.3.0'), false);
  assert.equal(satisfies('0.2.1-rc.10', '>=0.2.1-rc.2 <0.3.0'), true);
});

test('parses and validates strictly', () => {
  assert.deepEqual(parseVersion('1.2.3-rc.4+meta'), {
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
    assert.throws(() => parseVersion(invalid), SemverError, invalid);
  }
  assert.throws(() => satisfies('1.0.0', '>=x'), SemverError);
  assert.throws(() => satisfies('not-a-version', '^1.0.0'), SemverError);
});
