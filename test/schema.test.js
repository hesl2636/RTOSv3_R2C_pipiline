/**
 * Schema documentation contract (spec §8).
 *
 * `schema/*.schema.json` are documentation only — the runner validates by hand
 * and never loads a JSON-Schema engine — but they are the published shape, so
 * every frozen `r2c.<family>/v1` id in src/schema.js must have a matching file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUPPORTED } from '../src/schema.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(REPO, 'schema');

function schema(id) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${id}.schema.json`), 'utf8'));
}

test('every frozen schema family has one v1 JSON Schema document', () => {
  const families = Object.keys(SUPPORTED).sort();
  assert.deepEqual(families, [
    'adapter',
    'adapter-map',
    'latest',
    'plugin',
    'state',
    'usage',
    'workflow',
  ]);
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
