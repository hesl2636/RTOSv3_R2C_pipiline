/**
 * Schema documentation contract (spec §8, decision #77 §3.4).
 *
 * The documents now live with their owner: the engine's state/workflow/
 * latest/usage revisions are in `runtime/r2c/schema/`. They are documentation
 * and test fixtures only — the hand-written validators are the implementation
 * — but every frozen engine revision must have one closed v1 document. The
 * retired adapter/payload families no longer have documents or ids.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUPPORTED } from '../runtime/r2c/engine/src/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'runtime/r2c/schema');

function schema(family) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${family}.schema.json`), 'utf8'));
}

test('every frozen engine schema family has one v1 JSON Schema document', () => {
  const families = Object.keys(SUPPORTED).sort();
  assert.deepEqual(families, ['latest', 'state', 'usage', 'workflow']);
  for (const family of families) {
    const ids = SUPPORTED[family];
    assert.deepEqual(ids, [`r2c.${family}/v1`], `${family}: one v1 revision`);
    const document = schema(family);
    assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(document.title, ids[0], `${family}: title is the schema id`);
    assert.equal(document.type, 'object', `${family}: root object`);
    assert.equal(document.additionalProperties, false, `${family}: closed root object`);
    assert.equal(document.properties.schema.const, ids[0], `${family}: schema const`);
  }
});

test('schema documents keep the frozen r2c.runner $id base', () => {
  for (const family of Object.keys(SUPPORTED)) {
    const document = schema(family);
    assert.equal(document.$id, `https://r2c.runner/schema/${family}.schema.json`);
  }
});

test('retired schema families have no document and no id', () => {
  for (const family of ['adapter', 'adapter-map', 'plugin', 'payload']) {
    assert.equal(family in SUPPORTED, false, `${family} must be retired`);
  }
});

test('no schema document points at a retired source path', () => {
  for (const family of Object.keys(SUPPORTED)) {
    const text = readFileSync(join(SCHEMA_DIR, `${family}.schema.json`), 'utf8');
    assert.doesNotMatch(text, /(?<!engine\/)\bsrc\//, `${family}: stale src/ path`);
    assert.doesNotMatch(text, /adapters\//, `${family}: retired adapter path`);
  }
});
