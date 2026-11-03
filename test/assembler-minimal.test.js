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
import { validateCompiledWorkflow } from '../assembler/validate-compiled.js';
import { COMPILED_WORKFLOW_FILENAME } from '../compiled/schema.js';
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
  assert.equal(report.schema, 'hm2b.bundle/v2');
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

test('compile produces canonical, self-proving compiled workflow that compiled-workflow validate accepts', () => {
  const zip = minimalZip();
  const first = compileBundle(zip, PRIMITIVES);
  assert.equal(first.ok, true, JSON.stringify(first.report.errors));
  assert.notEqual(first.compiledWorkflowBytes, null);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  const text = new TextDecoder().decode(first.compiledWorkflowBytes);
  assert.equal(canonicalJson(JSON.parse(text)), text);
  assert.equal(sha256Hex(first.compiledWorkflowBytes), first.digest);

  const compiledWorkflow = JSON.parse(text);
  assert.equal(compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');
  assert.equal(compiledWorkflow.id, 'minimal-demo');
  assert.equal(compiledWorkflow.version, '1.0.0');
  assert.equal(compiledWorkflow.source.bundle.contentSha256.length, 64);
  assert.equal(compiledWorkflow.source.manifest.sha256, sha256Hex(canonicalJson(MINIMAL_MANIFEST)));
  assert.deepEqual(Object.keys(compiledWorkflow.roles), ['worker']);
  assert.deepEqual(Object.keys(compiledWorkflow.tasks), ['do-it']);
  assert.deepEqual(Object.keys(compiledWorkflow.skills), ['helper']);
  assert.deepEqual(compiledWorkflow.knowledgeBase, []);
  assert.deepEqual(compiledWorkflow.checklists, []);
  assert.equal(compiledWorkflow.hooks, null);
  assert.equal(compiledWorkflow.mcp, null);
  assert.deepEqual(compiledWorkflow.constitution, []);
  assert.deepEqual(compiledWorkflow.stages[0].steps[0].skills, ['helper']);
  assert.deepEqual(compiledWorkflow.stages[0].steps[0].outputs, ['out/*.md']);
  assert.deepEqual(compiledWorkflow.stages[0].steps[0].gates, [{ command: 'true', timeout: 30 }]);

  const compiledWorkflowReport = validateCompiledWorkflow(first.compiledWorkflowBytes, { sha256: sha256Hex });
  assert.equal(compiledWorkflowReport.ok, true, JSON.stringify(compiledWorkflowReport.errors));
  assert.equal(compiledWorkflowReport.target, 'compiled-workflow');
  assert.equal(compiledWorkflowReport.schema, 'hm2b.compiled-workflow/v2');
  assert.equal(compiledWorkflowReport.artifact.path, COMPILED_WORKFLOW_FILENAME);
  assert.equal(compiledWorkflowReport.artifact.sha256, first.digest);
});

test('compilation is byte-identical across repeats, compression methods and descriptors', () => {
  const store = compileBundle(minimalZip(), PRIMITIVES);
  const again = compileBundle(minimalZip(), PRIMITIVES);
  const deflate = compileBundle(minimalZip({ method: 'deflate' }), PRIMITIVES);
  const descriptor = compileBundle(minimalZip({ dataDescriptor: true }), PRIMITIVES);
  for (const result of [again, deflate, descriptor]) {
    assert.equal(result.ok, true, JSON.stringify(result.report.errors));
    assert.equal(Buffer.compare(Buffer.from(store.compiledWorkflowBytes), Buffer.from(result.compiledWorkflowBytes)), 0);
  }
  assert.equal(again.digest, store.digest);
});

test('reports are byte-identical on repeat', () => {
  const zip = minimalZip();
  const first = JSON.stringify(validateBundle(zip, PRIMITIVES));
  const second = JSON.stringify(validateBundle(zip, PRIMITIVES));
  assert.equal(first, second);
});

test('a warning does not change ok, compiled workflow bytes or the exit code', () => {
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
  assert.equal(Buffer.compare(Buffer.from(warned.compiledWorkflowBytes), Buffer.from(warnedAgain.compiledWorkflowBytes)), 0);

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
    assert.equal(existsSync(join(out, COMPILED_WORKFLOW_FILENAME)), true);
  });
});

test('an error yields no compiled workflow bytes and exit 2 without writing a file', () => {
  const brokenTask = MINIMAL_TASK.replace('\n## 约束条件\n\n- 不要跳过任何一步。\n', '\n');
  const zip = minimalZip({ overrides: { 'tasks/do-it.md': brokenTask } });
  const report = validateBundle(zip, PRIMITIVES);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'BUNDLE_TASK_SECTION_MISSING');
  const compiled = compileBundle(zip, PRIMITIVES);
  assert.equal(compiled.ok, false);
  assert.equal(compiled.compiledWorkflowBytes, null);

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
    assert.equal(existsSync(join(out, COMPILED_WORKFLOW_FILENAME)), false);
    assert.equal(result.stdout.trim().split('\n').length, 1);
  });
});

test('the CLI --json envelope is one line for bundle and compiled-workflow validate', () => {
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
    // The report is the `data` object itself (like bundle/compiled-workflow validate), with
    // the written artifact appended; there is no `data.report` wrapper.
    assert.equal(compileResult.envelope.data.ok, true);
    assert.equal(compileResult.envelope.data.target, 'bundle');
    assert.equal(compileResult.envelope.data.report, undefined);
    assert.equal(compileResult.envelope.data.compiledWorkflow.path, 'workflow.compiled.json');
    const compiledWorkflowPath = join(out, COMPILED_WORKFLOW_FILENAME);
    const compiledWorkflowResult = cli(['compiled-workflow', 'validate', compiledWorkflowPath, '--json']);
    assert.equal(compiledWorkflowResult.status, 0);
    assert.equal(compiledWorkflowResult.stdout.trim().split('\n').length, 1);
    assert.equal(compiledWorkflowResult.envelope.command, 'compiled-workflow.validate');
    assert.equal(compiledWorkflowResult.envelope.data.ok, true);
    assert.equal(compiledWorkflowResult.envelope.error, null);
  });
});
