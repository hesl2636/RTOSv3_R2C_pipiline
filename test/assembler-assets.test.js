/**
 * Bundle asset contract (`knowledge-base/`, `checklists/`, `hooks/`, `mcp.json`)
 * from declaration through the container whitelist, the compiler and IR v2.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { validateIr } from '../assembler/validate-ir.js';
import { buildZip } from './helpers/zip.js';
import {
  ASSET_CHECKLISTS,
  ASSET_HOOKS,
  ASSET_KNOWLEDGE_BASE,
  ASSET_MANIFEST,
  ASSET_MCP,
  assetFiles,
  assetZip,
} from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function reportFor(overrides = {}, options = {}) {
  return validateBundle(buildZip(assetFiles(overrides), options), PRIMITIVES);
}

function failures(report) {
  return report.errors.map((error) => `${error.code}@${error.path}`);
}

function expectSingle(report, { code, path, pointer, rule }) {
  assert.equal(report.ok, false, `expected ${code}`);
  assert.equal(report.errors.length, 1, JSON.stringify(report.errors, null, 2));
  const [error] = report.errors;
  assert.equal(error.code, code);
  assert.equal(error.path, path);
  if (pointer !== undefined) assert.equal(error.pointer, pointer);
  if (rule !== undefined) assert.equal(error.details.rule, rule);
  return error;
}

function irOf(overrides = {}) {
  const compiled = compileBundle(buildZip(assetFiles(overrides)), PRIMITIVES);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.report.errors));
  return JSON.parse(decoder.decode(compiled.irBytes));
}

function manifestWith(mutate) {
  const manifest = JSON.parse(JSON.stringify(ASSET_MANIFEST));
  mutate(manifest);
  return canonicalJson(manifest);
}

function irFailures(ir) {
  return validateIr(encoder.encode(canonicalJson(ir)), { sha256: sha256Hex })
    .errors.map((error) => `${error.code}@${error.pointer}`);
}

test('a bundle with declared assets validates clean and compiles to IR v2', () => {
  const report = reportFor();
  assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.schema, 'hm2b.bundle/v2');

  const compiled = compileBundle(assetZip(), PRIMITIVES);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.report.errors));
  const text = decoder.decode(compiled.irBytes);
  assert.equal(canonicalJson(JSON.parse(text)), text);
  const ir = JSON.parse(text);
  assert.equal(ir.schema, 'hm2b.ir/v2');
  assert.equal(ir.source.bundle.schema, 'hm2b.bundle/v2');
  assert.deepEqual(ir.knowledgeBase.map((item) => item.path), [
    'knowledge-base/coding-standards/cleancode/rules.md',
    'knowledge-base/os-api-mapping/freertos.md',
  ]);
  assert.deepEqual(ir.checklists.map((item) => item.id), ['design', 'impl']);
  assert.equal(ir.hooks.path, 'hooks/hooks.json');
  assert.equal(ir.mcp.path, 'mcp.json');
  assert.deepEqual(ir.constitution, []);

  for (const item of ir.knowledgeBase) {
    assert.equal(item.body, ASSET_KNOWLEDGE_BASE.get(item.path));
    assert.equal(item.source.path, item.path);
    assert.equal(item.source.sha256, sha256Hex(encoder.encode(item.body)));
  }
  for (const item of ir.checklists) {
    assert.equal(item.body, ASSET_CHECKLISTS.get(item.id));
    assert.equal(item.source.path, `checklists/${item.id}.md`);
    assert.equal(item.source.sha256, sha256Hex(encoder.encode(item.body)));
  }
  assert.equal(ir.hooks.body, canonicalJson(ASSET_HOOKS));
  assert.equal(ir.mcp.body, canonicalJson(ASSET_MCP));
  assert.equal(ir.hooks.source.sha256, sha256Hex(encoder.encode(ir.hooks.body)));
  assert.equal(ir.mcp.source.sha256, sha256Hex(encoder.encode(ir.mcp.body)));

  const irReport = validateIr(compiled.irBytes, { sha256: sha256Hex });
  assert.equal(irReport.ok, true, JSON.stringify(irReport.errors));
  assert.equal(irReport.schema, 'hm2b.ir/v2');
});

test('assets enter contentSha256 and compilation stays deterministic', () => {
  const files = assetFiles();
  const paths = [
    'bundle.json',
    'stages/only.json',
    'roles/worker.md',
    'tasks/do-it.md',
    'skills/helper/SKILL.md',
    'knowledge-base/coding-standards/cleancode/rules.md',
    'knowledge-base/os-api-mapping/freertos.md',
    'checklists/design.md',
    'checklists/impl.md',
    'hooks/hooks.json',
    'mcp.json',
  ].sort();
  const rows = paths.map((path) => `${path}\t${sha256Hex(encoder.encode(files.get(path)))}\n`).join('');
  const expected = sha256Hex(encoder.encode(rows));

  const first = compileBundle(assetZip(), PRIMITIVES);
  assert.equal(first.ok, true, JSON.stringify(first.report.errors));
  const ir = JSON.parse(decoder.decode(first.irBytes));
  assert.equal(ir.source.bundle.contentSha256, expected);

  const again = compileBundle(assetZip({ method: 'deflate', dataDescriptor: true }), PRIMITIVES);
  assert.equal(again.ok, true, JSON.stringify(again.report.errors));
  assert.equal(Buffer.compare(Buffer.from(first.irBytes), Buffer.from(again.irBytes)), 0);

  const changed = compileBundle(
    buildZip(assetFiles({ 'knowledge-base/os-api-mapping/freertos.md': '# changed mapping\n' })),
    PRIMITIVES,
  );
  assert.equal(changed.ok, true, JSON.stringify(changed.report.errors));
  const changedIr = JSON.parse(decoder.decode(changed.irBytes));
  assert.notEqual(changedIr.source.bundle.contentSha256, ir.source.bundle.contentSha256);
  assert.notEqual(changed.digest, first.digest);
});

test('manifest arrays are sets: IR output is sorted by path and id', () => {
  const reversed = manifestWith((value) => {
    value.knowledgeBase.reverse();
    value.checklists.reverse();
  });
  const ir = irOf({ 'bundle.json': reversed });
  assert.deepEqual(ir.knowledgeBase.map((item) => item.path), [
    'knowledge-base/coding-standards/cleancode/rules.md',
    'knowledge-base/os-api-mapping/freertos.md',
  ]);
  assert.deepEqual(ir.checklists.map((item) => item.id), ['design', 'impl']);
});

test('an undeclared asset file is one BUNDLE_UNEXPECTED_PATH', () => {
  expectSingle(reportFor({ 'knowledge-base/extra.md': '# extra\n' }), {
    code: 'BUNDLE_UNEXPECTED_PATH',
    path: 'knowledge-base/extra.md',
  });
  expectSingle(reportFor({ 'checklists/review.md': '# review\n' }), {
    code: 'BUNDLE_UNEXPECTED_PATH',
    path: 'checklists/review.md',
  });
  expectSingle(reportFor({ 'hooks/other.json': canonicalJson({}) }), {
    code: 'BUNDLE_UNEXPECTED_PATH',
    path: 'hooks/other.json',
  });
  const withoutDeclaration = manifestWith((value) => {
    delete value.mcp;
  });
  expectSingle(reportFor({ 'bundle.json': withoutDeclaration }), {
    code: 'BUNDLE_UNEXPECTED_PATH',
    path: 'mcp.json',
  });
});

test('a declared asset file must exist', () => {
  expectSingle(reportFor({ 'knowledge-base/os-api-mapping/freertos.md': null }), {
    code: 'BUNDLE_ASSET_FILE_MISSING',
    path: 'knowledge-base/os-api-mapping/freertos.md',
  });
  expectSingle(reportFor({ 'checklists/impl.md': null }), {
    code: 'BUNDLE_ASSET_FILE_MISSING',
    path: 'checklists/impl.md',
  });
  expectSingle(reportFor({ 'hooks/hooks.json': null }), {
    code: 'BUNDLE_ASSET_FILE_MISSING',
    path: 'hooks/hooks.json',
  });
  expectSingle(reportFor({ 'mcp.json': null }), {
    code: 'BUNDLE_ASSET_FILE_MISSING',
    path: 'mcp.json',
  });
});

test('hooks.json and mcp.json must be canonical JSON', () => {
  expectSingle(reportFor({ 'hooks/hooks.json': JSON.stringify(ASSET_HOOKS) }), {
    code: 'BUNDLE_JSON_NOT_CANONICAL',
    path: 'hooks/hooks.json',
  });
  expectSingle(reportFor({ 'mcp.json': JSON.stringify(ASSET_MCP) }), {
    code: 'BUNDLE_JSON_NOT_CANONICAL',
    path: 'mcp.json',
  });
  expectSingle(reportFor({ 'mcp.json': canonicalJson({ servers: {} }) }), {
    code: 'BUNDLE_MCP_INVALID',
    path: 'mcp.json',
  });
});

test('asset directory entries are admitted only below declared paths', () => {
  const admitted = buildZip(assetFiles(), {
    directory: [
      'knowledge-base',
      'knowledge-base/os-api-mapping',
      'knowledge-base/coding-standards',
      'knowledge-base/coding-standards/cleancode',
      'checklists',
      'hooks',
    ],
  });
  const report = validateBundle(admitted, PRIMITIVES);
  assert.equal(report.ok, true, JSON.stringify(report.errors));

  expectSingle(reportFor({}, { directory: ['knowledge-base/extra'] }), {
    code: 'BUNDLE_UNEXPECTED_PATH',
    path: 'knowledge-base/extra/',
  });
});

test('markdown assets follow the strict text rules', () => {
  expectSingle(reportFor({ 'checklists/design.md': '# Design checklist\n\n- [ ] x' }), {
    code: 'BUNDLE_TEXT_ENCODING',
    path: 'checklists/design.md',
  });
  expectSingle(reportFor({ 'knowledge-base/os-api-mapping/freertos.md': '# a\r\n' }), {
    code: 'BUNDLE_TEXT_ENCODING',
    path: 'knowledge-base/os-api-mapping/freertos.md',
  });
});

test('asset paths honour the grammar, depth and byte budget', () => {
  // Four segments is the limit and the fixture already uses it.
  assert.equal(reportFor().ok, true);
  const tooDeep = 'knowledge-base/a/b/c/d.md';
  expectSingle(reportFor({ [tooDeep]: '# deep\n' }), {
    code: 'BUNDLE_PATH_INVALID',
    path: tooDeep,
  });
  expectSingle(reportFor({ 'knowledge-base/notes.txt': '# notes\n' }), {
    code: 'BUNDLE_UNEXPECTED_PATH',
    path: 'knowledge-base/notes.txt',
  });
});

test('manifest declarations reject malformed entries once', () => {
  const emptyKnowledgeBase = {
    'knowledge-base/os-api-mapping/freertos.md': null,
    'knowledge-base/coding-standards/cleancode/rules.md': null,
  };
  const emptyChecklists = {
    'checklists/design.md': null,
    'checklists/impl.md': null,
  };
  expectSingle(
    reportFor({
      ...emptyKnowledgeBase,
      'bundle.json': manifestWith((value) => { value.knowledgeBase = ['knowledge-base/notes.txt']; }),
    }),
    { code: 'BUNDLE_SCHEMA_INVALID', path: 'bundle.json', pointer: '/knowledgeBase/0', rule: 'pattern' },
  );
  expectSingle(
    reportFor({
      ...emptyKnowledgeBase,
      'bundle.json': manifestWith((value) => {
        value.knowledgeBase = ['knowledge-base/a/b/c/d.md'];
      }),
    }),
    { code: 'BUNDLE_SCHEMA_INVALID', path: 'bundle.json', pointer: '/knowledgeBase/0', rule: 'pattern' },
  );
  expectSingle(
    reportFor({
      ...emptyKnowledgeBase,
      'bundle.json': manifestWith((value) => {
        value.knowledgeBase = ['knowledge-base/os-api-mapping/freertos.md', 'knowledge-base/os-api-mapping/freertos.md'];
      }),
    }),
    { code: 'BUNDLE_SCHEMA_INVALID', path: 'bundle.json', pointer: '/knowledgeBase/1', rule: 'uniqueItems' },
  );
  expectSingle(
    reportFor({
      ...emptyChecklists,
      'bundle.json': manifestWith((value) => { value.checklists = ['Design']; }),
    }),
    { code: 'BUNDLE_CHECKLIST_ID_INVALID', path: 'bundle.json', pointer: '/checklists/0' },
  );
  expectSingle(
    reportFor({
      ...emptyChecklists,
      'bundle.json': manifestWith((value) => { value.checklists = ['design', 'design']; }),
    }),
    { code: 'BUNDLE_SCHEMA_INVALID', path: 'bundle.json', pointer: '/checklists/1', rule: 'uniqueItems' },
  );
  expectSingle(
    reportFor({
      'bundle.json': manifestWith((value) => { value.hooks = { path: 'hooks/other.json' }; }),
      'hooks/hooks.json': null,
    }),
    { code: 'BUNDLE_SCHEMA_INVALID', path: 'bundle.json', pointer: '/hooks/path', rule: 'const' },
  );
  expectSingle(
    reportFor({
      'bundle.json': manifestWith((value) => { value.mcp = { path: 'mcp.json', extra: true }; }),
    }),
    { code: 'BUNDLE_UNKNOWN_KEY', path: 'bundle.json', pointer: '/mcp/extra' },
  );
});

test('the bundle schema rejects v1 and unknown revisions', () => {
  for (const schema of ['hm2b.bundle/v1', 'hm2b.bundle/v9']) {
    const report = reportFor({ 'bundle.json': manifestWith((value) => { value.schema = schema; }) });
    expectSingle(report, { code: 'BUNDLE_SCHEMA_UNSUPPORTED', path: 'bundle.json', pointer: '/schema' });
    const compiled = compileBundle(buildZip(assetFiles({ 'bundle.json': manifestWith((value) => { value.schema = schema; }) })), PRIMITIVES);
    assert.equal(compiled.ok, false);
    assert.equal(compiled.irBytes, null);
  }
});

test('IR v2 rejects v1 and checks asset order, source paths and hashes', () => {
  const ir = irOf();
  assert.deepEqual(irFailures({ ...ir, schema: 'hm2b.ir/v1' }), ['IR_SCHEMA_UNSUPPORTED@/schema']);

  const stale = structuredClone(ir);
  stale.source.bundle.schema = 'hm2b.bundle/v1';
  assert.ok(irFailures(stale).includes('IR_SOURCE_MISMATCH@/source/bundle/schema'));

  const unsorted = structuredClone(ir);
  unsorted.knowledgeBase.reverse();
  assert.ok(irFailures(unsorted).includes('IR_ORDER_INVALID@/knowledgeBase'));

  const wrongPath = structuredClone(ir);
  wrongPath.checklists[0].source.path = 'checklists/other.md';
  assert.ok(irFailures(wrongPath).includes('IR_SOURCE_PATH_MISMATCH@/checklists/0/source/path'));

  const tamperedHash = structuredClone(ir);
  tamperedHash.knowledgeBase[0].source.sha256 = '0'.repeat(64);
  assert.ok(irFailures(tamperedHash).includes('IR_HASH_MISMATCH@/source/bundle/contentSha256'));

  const dropped = structuredClone(ir);
  dropped.checklists = [];
  assert.ok(irFailures(dropped).includes('IR_HASH_MISMATCH@/source/bundle/contentSha256'));

  const nonCanonicalHooks = structuredClone(ir);
  nonCanonicalHooks.hooks.body = JSON.stringify(ASSET_HOOKS);
  assert.ok(irFailures(nonCanonicalHooks).includes('IR_ASSET_INVALID@/hooks/body'));

  const wrongMcpShape = structuredClone(ir);
  wrongMcpShape.mcp.body = canonicalJson({ servers: {} });
  assert.ok(irFailures(wrongMcpShape).includes('IR_ASSET_INVALID@/mcp/body'));

  const required = structuredClone(ir);
  delete required.hooks;
  assert.ok(irFailures(required).includes('IR_SCHEMA_INVALID@/hooks'));
});

test('an asset-free bundle keeps the empty defaults in IR v2', () => {
  const compiled = compileBundle(buildZip(assetFiles({
    'bundle.json': canonicalJson({
      schema: 'hm2b.bundle/v2',
      id: 'minimal-demo',
      name: 'Minimal Demo',
      version: '1.0.0',
      description: 'Minimal compliant bundle used by the framework tests.',
      stages: ['only'],
      roles: ['worker'],
      tasks: ['do-it'],
      skills: ['helper'],
    }),
    'knowledge-base/os-api-mapping/freertos.md': null,
    'knowledge-base/coding-standards/cleancode/rules.md': null,
    'checklists/design.md': null,
    'checklists/impl.md': null,
    'hooks/hooks.json': null,
    'mcp.json': null,
  })), PRIMITIVES);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.report.errors));
  const ir = JSON.parse(decoder.decode(compiled.irBytes));
  assert.deepEqual(ir.knowledgeBase, []);
  assert.deepEqual(ir.checklists, []);
  assert.equal(ir.hooks, null);
  assert.equal(ir.mcp, null);
});
