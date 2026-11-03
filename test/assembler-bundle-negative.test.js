import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { buildZip } from './helpers/zip.js';
import {
  MINIMAL_MANIFEST,
  MINIMAL_STAGE,
  minimalFiles,
  minimalZip,
} from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };

function codes(report) {
  return report.errors.map((error) => error.code);
}

test('JSON canonical bytes own the trailing-LF rule', () => {
  const manifestNoLf = canonicalJson(MINIMAL_MANIFEST).replace(/\n$/, '');
  const bundle = buildZip(minimalFiles({ 'bundle.json': manifestNoLf }));
  const manifestReport = validateBundle(bundle, PRIMITIVES);
  assert.equal(manifestReport.ok, false);
  assert.deepEqual(codes(manifestReport), ['BUNDLE_JSON_NOT_CANONICAL']);

  const stageNoLf = canonicalJson(MINIMAL_STAGE).replace(/\n$/, '');
  const stageBundle = buildZip(minimalFiles({ 'stages/only.json': stageNoLf }));
  const stageReport = validateBundle(stageBundle, PRIMITIVES);
  assert.ok(codes(stageReport).includes('BUNDLE_JSON_NOT_CANONICAL'));
  assert.ok(!codes(stageReport).includes('BUNDLE_TEXT_ENCODING'));
});

test('markdown text without a final LF is a text-encoding error', () => {
  const files = minimalFiles({ 'roles/worker.md': '---\nid: worker\ndescription: Executes the step.\n---\n\nbody' });
  const report = validateBundle(buildZip(files), PRIMITIVES);
  assert.ok(codes(report).includes('BUNDLE_TEXT_ENCODING'));
});

test('a missing declared stage suppresses unused warnings (S8)', () => {
  const files = minimalFiles({ 'stages/only.json': null });
  const report = validateBundle(buildZip(files), PRIMITIVES);
  assert.ok(codes(report).includes('BUNDLE_STAGE_FILE_MISSING'));
  assert.ok(!codes(report).includes('BUNDLE_TASK_UNUSED'));
  assert.ok(!codes(report).includes('BUNDLE_ROLE_UNUSED'));
  assert.ok(!codes(report).includes('BUNDLE_SKILL_UNUSED'));
});

test('layout, undeclared files and outer directories are rejected once', () => {
  const unexpected = validateBundle(buildZip(minimalFiles({ 'notes.txt': 'hi\n' })), PRIMITIVES);
  assert.ok(codes(unexpected).includes('BUNDLE_UNEXPECTED_PATH'));

  const undeclared = validateBundle(
    buildZip(minimalFiles({ 'tasks/extra.md': '## Agent 角色设定\n\nx\n' })),
    PRIMITIVES,
  );
  assert.ok(codes(undeclared).includes('BUNDLE_TASK_FILE_UNDECLARED'));

  const outerEntries = new Map();
  for (const [path, value] of minimalFiles()) outerEntries.set(`bundle/${path}`, value);
  const outer = validateBundle(buildZip(outerEntries), PRIMITIVES);
  assert.ok(codes(outer).includes('BUNDLE_OUTER_DIRECTORY'));
  assert.ok(!codes(outer).includes('BUNDLE_MANIFEST_MISSING'));
});

test('an unsupported schema suppresses content phases', () => {
  const files = minimalFiles({
    'bundle.json': canonicalJson({ ...MINIMAL_MANIFEST, schema: 'hm2b.bundle/v2' }),
    'stages/only.json': null,
  });
  const report = validateBundle(buildZip(files), PRIMITIVES);
  assert.deepEqual(codes(report), ['BUNDLE_SCHEMA_UNSUPPORTED']);
});

test('the minimal bundle stays valid when zipped with directory entries', () => {
  const report = validateBundle(
    buildZip(minimalFiles(), { directory: ['stages', 'roles', 'tasks', 'skills', 'skills/helper'] }),
    PRIMITIVES,
  );
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(validateBundle(minimalZip(), PRIMITIVES).ok, true);
});
