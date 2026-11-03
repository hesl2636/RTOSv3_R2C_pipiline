/**
 * Schema documentation contract (spec §8, decision #77 §3.4).
 *
 * The documents now live with their owner: the engine's state/workflow/
 * latest/usage revisions are in `runtime/runner/schema/`. They are
 * documentation and test fixtures only — the hand-written validators are the
 * implementation — but every frozen engine revision must have one closed v1
 * document. The retired adapter/payload families no longer have documents or
 * ids, and their frozen `r2c.*` spellings are never parsed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSchemaId } from '../core/schema.js';
import { LEGACY_RECEIPT_SCHEMA, RECEIPT_SCHEMA } from '../installer/paths.js';
import { RUNTIME_SCHEMA } from '../installer/runtime.js';
import { SUPPORTED } from '../runtime/runner/engine/src/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'runtime/runner/schema');

function schema(family) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${family}.schema.json`), 'utf8'));
}

test('every frozen engine schema family has one v1 JSON Schema document', () => {
  const families = Object.keys(SUPPORTED).sort();
  assert.deepEqual(families, ['latest', 'state', 'usage', 'workflow']);
  for (const family of families) {
    const ids = SUPPORTED[family];
    assert.deepEqual(ids, [`hm2b.${family}/v1`], `${family}: one v1 revision`);
    const document = schema(family);
    assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(document.title, ids[0], `${family}: title is the schema id`);
    assert.equal(document.type, 'object', `${family}: root object`);
    assert.equal(document.additionalProperties, false, `${family}: closed root object`);
    assert.equal(document.properties.schema.const, ids[0], `${family}: schema const`);
  }
});

test('schema documents keep the frozen hm2b.runner $id base', () => {
  for (const family of Object.keys(SUPPORTED)) {
    const document = schema(family);
    assert.equal(document.$id, `https://hm2b.runner/schema/${family}.schema.json`);
  }
});

test('installer schemas are hm2b.install/v2 and hm2b.runtime/v1', () => {
  assert.equal(RECEIPT_SCHEMA, 'hm2b.install/v2');
  assert.equal(RUNTIME_SCHEMA, 'hm2b.runtime/v1');
  assert.deepEqual(parseSchemaId(RECEIPT_SCHEMA), { family: 'install', revision: 2 });
  assert.deepEqual(parseSchemaId(RUNTIME_SCHEMA), { family: 'runtime', revision: 1 });
  // The legacy receipt id is recognised by equality only; it is not a
  // supported hm2b schema revision and never parses.
  assert.equal(LEGACY_RECEIPT_SCHEMA, 'r2c.install/v1');
  assert.equal(parseSchemaId(LEGACY_RECEIPT_SCHEMA), null);
});

test('usage snapshots name the host target', () => {
  const usage = schema('usage');
  assert.ok(usage.required.includes('target'), 'usage: target must be required');
  assert.equal('adapter' in usage.properties, false, 'usage: the adapter field is retired');
  assert.deepEqual(
    usage.properties.target.enum,
    ['claude-code', 'codex', 'dsh', 'omp', 'opencode'],
    'usage: target is one of the five hosts',
  );
  const state = schema('state');
  assert.match(state.properties.workflow_engine.description, /\btarget\b/i);
});

test('engine schema documents use target vocabulary only', () => {
  for (const family of Object.keys(SUPPORTED)) {
    const text = readFileSync(join(SCHEMA_DIR, `${family}.schema.json`), 'utf8');
    assert.doesNotMatch(text, /\b(?:adapter|plugin)s?\b/i, `${family}: retired host vocabulary`);
  }
});

test('retired schema families have no document and no id', () => {
  for (const family of ['adapter', 'adapter-map', 'plugin', 'payload']) {
    assert.equal(family in SUPPORTED, false, `${family} must be retired`);
  }
  for (const id of ['r2c.adapter/v1', 'r2c.adapter-map/v1', 'r2c.plugin/v1', 'r2c.payload/v1']) {
    assert.equal(parseSchemaId(id), null, `${id} must not parse`);
  }
});

test('no schema document points at a retired source path', () => {
  for (const family of Object.keys(SUPPORTED)) {
    const text = readFileSync(join(SCHEMA_DIR, `${family}.schema.json`), 'utf8');
    assert.doesNotMatch(text, /(?<!engine\/)\bsrc\//, `${family}: stale src/ path`);
    assert.doesNotMatch(text, /adapters\//, `${family}: retired adapter path`);
  }
});
