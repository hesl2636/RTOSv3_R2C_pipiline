import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { validateIr } from '../assembler/validate-ir.js';
import { IR_FILENAME, irCollectionPath } from '../ir/schema.js';
import {
  MINIMAL_MANIFEST,
  MINIMAL_TASK,
  minimalZip,
} from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };
const BIN = fileURLToPath(new URL('../bin/hm2b-assembler.js', import.meta.url));

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-assembler-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    envelope: result.stdout.trim() === '' ? null : JSON.parse(result.stdout),
  };
}

test('minimal compliant bundle validates with a complete report', () => {
  const zip = minimalZip();
  const report = validateBundle(zip, PRIMITIVES, { path: 'minimal.zip' });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.target, 'bundle');
  assert.equal(report.schema, 'hm2b.bundle/v1');
  assert.equal(report.artifact.path, 'minimal.zip');
  assert.equal(report.artifact.bytes, zip.length);
  assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.id, 'minimal-demo');
  assert.equal(report.version, '1.0.0');
  assert.deepEqual(report.counts, {
    stages: 1,
    steps: 1,
    roles: 1,
    tasks: 1,
    skills: 1,
    constitutions: 0,
    errors: 0,
    warnings: 0,
  });
});

test('compile produces canonical, self-proving IR that ir validate accepts', () => {
  const zip = minimalZip();
  const first = compileBundle(zip, PRIMITIVES);
  assert.equal(first.ok, true, JSON.stringify(first.report.errors));
  assert.notEqual(first.irBytes, null);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  const text = new TextDecoder().decode(first.irBytes);
  assert.equal(canonicalJson(JSON.parse(text)), text);
  assert.equal(sha256Hex(first.irBytes), first.digest);

  const ir = JSON.parse(text);
  assert.equal(ir.schema, 'hm2b.ir/v1');
  assert.equal(ir.id, 'minimal-demo');
  assert.equal(ir.version, '1.0.0');
  assert.equal(ir.source.bundle.contentSha256.length, 64);
  assert.equal(ir.source.manifest.sha256, sha256Hex(canonicalJson(MINIMAL_MANIFEST)));
  assert.deepEqual(Object.keys(ir.roles), ['worker']);
  assert.deepEqual(Object.keys(ir.tasks), ['do-it']);
  assert.deepEqual(Object.keys(ir.skills), ['helper']);
  assert.deepEqual(ir.constitution, []);
  assert.deepEqual(ir.stages[0].steps[0].skills, ['helper']);
  assert.deepEqual(ir.stages[0].steps[0].outputs, ['out/*.md']);
  assert.deepEqual(ir.stages[0].steps[0].gates, [{ command: 'true', timeout: 30 }]);

  const irReport = validateIr(first.irBytes, { sha256: sha256Hex });
  assert.equal(irReport.ok, true, JSON.stringify(irReport.errors));
  assert.equal(irReport.target, 'ir');
  assert.equal(irReport.schema, 'hm2b.ir/v1');
  assert.equal(irReport.artifact.path, IR_FILENAME);
  assert.equal(irReport.artifact.sha256, first.digest);
});

test('compilation is byte-identical across repeats, compression methods and descriptors', () => {
  const store = compileBundle(minimalZip(), PRIMITIVES);
  const again = compileBundle(minimalZip(), PRIMITIVES);
  const deflate = compileBundle(minimalZip({ method: 'deflate' }), PRIMITIVES);
  const descriptor = compileBundle(minimalZip({ dataDescriptor: true }), PRIMITIVES);
  for (const result of [again, deflate, descriptor]) {
    assert.equal(result.ok, true, JSON.stringify(result.report.errors));
    assert.equal(Buffer.compare(Buffer.from(store.irBytes), Buffer.from(result.irBytes)), 0);
  }
  assert.equal(again.digest, store.digest);
});

test('reports are byte-identical on repeat', () => {
  const zip = minimalZip();
  const first = JSON.stringify(validateBundle(zip, PRIMITIVES));
  const second = JSON.stringify(validateBundle(zip, PRIMITIVES));
  assert.equal(first, second);
});

test('a warning does not change ok, IR bytes or the exit code', () => {
  const leaky = minimalZip({
    overrides: {
      'tasks/do-it.md': MINIMAL_TASK.replace('完成唯一一步。', '先跑 hm2b-status 看状态。'),
    },
  });
  const report = validateBundle(leaky, PRIMITIVES);
  assert.equal(report.ok, true);
  assert.equal(report.counts.errors, 0);
  assert.equal(report.counts.warnings, 1);
  assert.equal(report.warnings[0].code, 'BUNDLE_TASK_RUNTIME_LEAK');
  const warned = compileBundle(leaky, PRIMITIVES);
  const warnedAgain = compileBundle(leaky, PRIMITIVES);
  assert.equal(warned.ok, true);
  assert.equal(Buffer.compare(Buffer.from(warned.irBytes), Buffer.from(warnedAgain.irBytes)), 0);

  withTempDir((dir) => {
    const zipPath = join(dir, 'leaky.zip');
    writeFileSync(zipPath, leaky);
    const validated = cli(['bundle', 'validate', zipPath, '--json']);
    assert.equal(validated.status, 0);
    assert.equal(validated.envelope.ok, true);
    assert.equal(validated.envelope.data.warnings.length, 1);
    const out = join(dir, 'out');
    const compiled = cli(['compile', zipPath, '--out', out, '--json']);
    assert.equal(compiled.status, 0);
    assert.equal(compiled.envelope.ok, true);
    assert.equal(existsSync(join(out, IR_FILENAME)), true);
  });
});

test('an error yields no IR bytes and exit 2 without writing a file', () => {
  const brokenTask = MINIMAL_TASK.replace('\n## 约束条件\n\n- 不要跳过任何一步。\n', '\n');
  const zip = minimalZip({ overrides: { 'tasks/do-it.md': brokenTask } });
  const report = validateBundle(zip, PRIMITIVES);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'BUNDLE_TASK_SECTION_MISSING');
  const compiled = compileBundle(zip, PRIMITIVES);
  assert.equal(compiled.ok, false);
  assert.equal(compiled.irBytes, null);

  withTempDir((dir) => {
    const zipPath = join(dir, 'broken.zip');
    writeFileSync(zipPath, zip);
    const out = join(dir, 'out');
    const result = cli(['compile', zipPath, '--out', out, '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.code, 2);
    assert.equal(result.envelope.error.code, 'BUNDLE_TASK_SECTION_MISSING');
    assert.equal(result.envelope.data.ok, false);
    assert.equal(existsSync(join(out, IR_FILENAME)), false);
    assert.equal(result.stdout.trim().split('\n').length, 1);
  });
});

test('the CLI --json envelope is one line for bundle and ir validate', () => {
  withTempDir((dir) => {
    const zipPath = join(dir, 'minimal.zip');
    writeFileSync(zipPath, minimalZip());
    const bundleResult = cli(['bundle', 'validate', zipPath, '--json']);
    assert.equal(bundleResult.status, 0);
    assert.equal(bundleResult.stdout.trim().split('\n').length, 1);
    assert.equal(bundleResult.envelope.command, 'bundle.validate');
    assert.equal(bundleResult.envelope.error, null);

    const out = join(dir, 'out');
    const compileResult = cli(['compile', zipPath, '--out', out, '--json']);
    assert.equal(compileResult.status, 0);
    // The report is the `data` object itself (like bundle/ir validate), with
    // the written artifact appended; there is no `data.report` wrapper.
    assert.equal(compileResult.envelope.data.ok, true);
    assert.equal(compileResult.envelope.data.target, 'bundle');
    assert.equal(compileResult.envelope.data.report, undefined);
    assert.equal(compileResult.envelope.data.ir.path, irCollectionPath(compileResult.envelope.data.id, compileResult.envelope.data.version));
    const irPath = join(out, IR_FILENAME);
    const irResult = cli(['ir', 'validate', irPath, '--json']);
    assert.equal(irResult.status, 0);
    assert.equal(irResult.stdout.trim().split('\n').length, 1);
    assert.equal(irResult.envelope.command, 'ir.validate');
    assert.equal(irResult.envelope.data.ok, true);
    assert.equal(irResult.envelope.error, null);
  });
});
