import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SemverError,
  compareSemver,
  isValidVersion,
  parseSemver,
  satisfiesRange,
} from '../core/semver.js';

test('parseSemver accepts strict semver and splits prerelease identifiers', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseSemver('0.0.1-rc.2'), {
    major: 0,
    minor: 0,
    patch: 1,
    prerelease: ['rc', '2'],
  });
});

test('parseSemver rejects malformed versions', () => {
  for (const value of ['', '1', '1.2', '1.2.3.4', '01.2.3', '1.2.3-01', 'v1.2.3', '1.2.3-']) {
    assert.throws(() => parseSemver(value), SemverError, value);
    assert.equal(isValidVersion(value), false, value);
  }
});

test('version comparison follows semver §11 precedence', () => {
  const vectors = [
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha', 1],
    ['1.0.0-alpha.beta', '1.0.0-alpha.1', 1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1],
  ];
  for (const [left, right, expected] of vectors) {
    assert.equal(compareSemver(left, right), expected, `${left} vs ${right}`);
    assert.equal(compareSemver(right, left), expected === 0 ? 0 : -expected, `${right} vs ${left}`);
  }
});

test('satisfiesRange covers comparators, caret, tilde and alternatives', () => {
  const vectors = [
    ['1.2.3', '^1.2.3', true],
    ['1.9.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['22.19.0', '>=22.19.0 <23 || >=24.0.0', true],
    ['22.18.9', '>=22.19.0 <23 || >=24.0.0', false],
    ['24.0.0', '>=22.19.0 <23 || >=24.0.0', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3', '>=1.2.3-0', true],
  ];
  for (const [version, range, expected] of vectors) {
    assert.equal(satisfiesRange(range, version), expected, `${version} in ${range}`);
  }
});

test('satisfiesRange rejects malformed ranges and versions', () => {
  for (const range of ['', '   ', '>= ', '1.2.3 ||', '|| 1.2.3', '1.2.3 - 2.0.0', '!=1.2.3']) {
    assert.throws(() => satisfiesRange(range, '1.2.3'), SemverError, range);
  }
  assert.throws(() => satisfiesRange('^1.0.0', 'nope'), SemverError);
});
