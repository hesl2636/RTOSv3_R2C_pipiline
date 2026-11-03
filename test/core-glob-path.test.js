import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codePointLength, compareCodePoints } from '../core/code-point.js';
import { isValidGlob, matchesGlob } from '../core/glob.js';
import {
  MAX_PATH_BYTES,
  MAX_PROJECTION_DEPTH,
  MAX_PROJECTION_PATH_BYTES,
  comparePaths,
  foldCase,
  hasFileDirPrefixConflict,
  isCanonicalRelativePath,
  isInside,
  pathDepth,
} from '../core/paths.js';
import { parseSchemaId, schemaFamily } from '../core/schema.js';

test('codePointLength counts code points, not UTF-16 units', () => {
  const vectors = [
    ['', 0],
    ['abc', 3],
    ['中文', 2],
    ['𠀀', 1],
    ['😀😀', 2],
    ['a😀b', 3],
  ];
  for (const [value, expected] of vectors) assert.equal(codePointLength(value), expected, value);
});

test('compareCodePoints orders by code point', () => {
  assert.equal(compareCodePoints('a', 'a'), 0);
  assert.equal(compareCodePoints('a', 'b'), -1);
  assert.equal(compareCodePoints('b', 'a'), 1);
  assert.equal(compareCodePoints('a', 'aa'), -1);
  assert.equal(compareCodePoints('中文', '中'), 1);
});

test('globs accept the documented syntax only', () => {
  for (const pattern of ['*.md', 'design/**', 'a/{b,c}.txt', 'a[0-9].md', '**/*.json']) {
    assert.equal(isValidGlob(pattern), true, pattern);
  }
  for (const pattern of ['', '   ', 'a{b', 'a}b', 'a[b', 'a]b', 'a\0b']) {
    assert.equal(isValidGlob(pattern), false, pattern);
  }
});

test('matchesGlob handles star, globstar, question mark, braces and classes', () => {
  const vectors = [
    ['*.md', 'README.md', true],
    ['*.md', 'docs/README.md', false],
    ['**/*.md', 'docs/a/b.md', true],
    ['**/*.md', 'README.md', true],
    ['design/**', 'design/a/b.md', true],
    ['design/**', 'design', false],
    ['a/?.md', 'a/b.md', true],
    ['a/?.md', 'a/bb.md', false],
    ['{a,b}/x', 'b/x', true],
    ['{a,b}/x', 'c/x', false],
    ['a[0-9].md', 'a5.md', true],
    ['a[0-9].md', 'ax.md', false],
    ['a.b', 'a.b', true],
    ['a.b', 'axb', false],
  ];
  for (const [pattern, path, expected] of vectors) {
    assert.equal(matchesGlob(pattern, path), expected, `${pattern} ~ ${path}`);
  }
});

test('path predicates share one canonical rule', () => {
  for (const value of ['bundle.json', 'stages/a.json', 'skills/x/SKILL.md', '.dsh/a.roles.md']) {
    assert.equal(isCanonicalRelativePath(value), true, value);
  }
  for (const value of [
    '',
    '/abs',
    'a\\b',
    'a/../b',
    'a/./b',
    'a//b',
    'a/',
    'a/b.',
    'a/b ',
    'a:b',
    'a\0b',
    `a/${'x'.repeat(MAX_PATH_BYTES)}`,
    '中文.md',
  ]) {
    assert.equal(isCanonicalRelativePath(value), false, value);
  }
  assert.equal(MAX_PATH_BYTES, 100);
  assert.equal(MAX_PROJECTION_PATH_BYTES, 200);
  assert.equal(MAX_PROJECTION_DEPTH, 8);
});

test('path helpers are deterministic and platform independent', () => {
  assert.equal(pathDepth('a/b/c.md'), 3);
  assert.equal(comparePaths('a/b', 'a/c'), -1);
  assert.equal(foldCase('AbC-1'), 'abc-1');
  assert.equal(hasFileDirPrefixConflict('a/b', 'a/b/c'), true);
  assert.equal(hasFileDirPrefixConflict('a/b', 'a/bc'), false);
  assert.equal(hasFileDirPrefixConflict('a/b', 'A/B/c'), true);
  assert.equal(isInside('a', 'a/b'), true);
  assert.equal(isInside('a', 'a'), true);
  assert.equal(isInside('a', 'a/../b'), false);
  assert.equal(isInside('a/b', 'a/bc'), false);
  assert.equal(isInside('.', 'a/b'), true);
});

test('schemaFamily extracts the family and rejects malformed ids', () => {
  assert.equal(schemaFamily('hm2b.ir/v1'), 'ir');
  assert.equal(schemaFamily('hm2b.bundle/v1'), 'bundle');
  assert.equal(schemaFamily('hm2b.projection-result/v1'), 'projection-result');
  assert.equal(schemaFamily('hm2b.ir'), null);
  assert.equal(schemaFamily('hm2b.ir/vX'), null);
  assert.equal(schemaFamily(42), null);
  assert.deepEqual(parseSchemaId('hm2b.ir/v2'), { family: 'ir', revision: 2 });
  assert.equal(parseSchemaId('nope'), null);
});
