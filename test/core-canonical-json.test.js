import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, firstDifferenceOffset, isCanonicalJson } from '../core/canonical-json.js';

test('canonicalJson is JSON.stringify(value, null, 2) plus one LF', () => {
  assert.equal(canonicalJson({ b: 1, a: [1, 2] }), '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}\n');
  assert.equal(canonicalJson([]), '[]\n');
  assert.equal(canonicalJson('中文'), '"中文"\n');
  assert.equal(canonicalJson(null), 'null\n');
});

test('isCanonicalJson accepts only the canonical byte form', () => {
  assert.equal(isCanonicalJson(canonicalJson({ a: 1 })), true);
  assert.equal(isCanonicalJson('{"a": 1}\n'), false);
  assert.equal(isCanonicalJson('{\n  "a": 1\n}'), false, 'missing final LF');
  assert.equal(isCanonicalJson('{\n  "a": 1\n}\n\n'), false, 'extra LF');
  assert.equal(isCanonicalJson('{\n    "a": 1\n}\n'), false, 'wrong indent');
  assert.equal(isCanonicalJson('{"a": 1, "a": 2}\n'), false, 'duplicate key');
  assert.equal(isCanonicalJson('{\n  "a": 1,\n}\n'), false, 'trailing comma');
  assert.equal(isCanonicalJson('not json'), false);
  assert.equal(isCanonicalJson(null), false);
});

test('firstDifferenceOffset locates the first differing byte', () => {
  assert.equal(firstDifferenceOffset('abc', 'abd'), 2);
  assert.equal(firstDifferenceOffset('abc', 'abcd'), 3);
  assert.equal(firstDifferenceOffset('abc', 'abc'), -1);
});
