/**
 * #94 install: declared paths only, receipt v2 hashes from disk, idempotency.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { isCanonicalJson } from '../core/canonical-json.js';
import { installProjection } from '../installer/install.js';
import { compiledWorkflowPath as compiledWorkflowRelPath } from '../installer/paths.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloneResult, customSample, fixedClock, COMPILED_WORKFLOW_FIXTURE, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, out);
    else if (entry.isFile()) out.push(relative(root, absolute).split('\\').join('/'));
  }
  return out.sort();
}

test('installs exactly the declared runner file set and records it in hm2b.install/v2', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes, compiledWorkflow, compiledWorkflowDigest } = sample('runner');
  const outcome = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'installed');
  assert.equal(outcome.files, result.files.length);

  const receiptRel = `.hm2b/install/receipts/runner/${compiledWorkflow.id}.json`;
  assert.equal(outcome.receiptPath, receiptRel);
  const receiptFile = join(projectRoot, ...receiptRel.split('/'));
  const text = readFileSync(receiptFile, 'utf8');
  assert.equal(isCanonicalJson(text), true, 'receipt must be canonical JSON');

  const expected = new Set([
    ...result.files.map((file) => file.path),
    compiledWorkflowRelPath(compiledWorkflow.id, compiledWorkflow.version),
    receiptRel,
  ]);
  const actual = new Set(walk(projectRoot));
  assert.deepEqual([...actual].sort(), [...expected].sort());

  const receipt = JSON.parse(text);
  assert.equal(receipt.schema, 'hm2b.install/v2');
  assert.deepEqual(receipt.projection, { id: 'runner', version: result.projection.version, targets: ['runner'] });
  assert.deepEqual(receipt.bundle, { id: compiledWorkflow.id, version: compiledWorkflow.version });
  assert.equal(receipt.compiled_workflow_path, compiledWorkflowRelPath(compiledWorkflow.id, compiledWorkflow.version));
  assert.deepEqual(receipt.compiledWorkflow, {
    path: compiledWorkflowRelPath(compiledWorkflow.id, compiledWorkflow.version),
    digest: compiledWorkflowDigest,
    contentSha256: result.compiledWorkflow.contentSha256,
  });
  assert.equal(receipt.root, 'project');
  assert.equal(receipt.scope, 'project');
  assert.equal(receipt.mode, 'fresh');
  assert.equal(receipt.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(receipt.updated_at, receipt.created_at);

  // Every hash is recomputed from the bytes that landed on disk.
  assert.equal(receipt.files.length, result.files.length);
  const byPath = new Map(receipt.files.map((file) => [file.path, file]));
  for (const file of result.files) {
    const entry = byPath.get(file.path);
    assert.ok(entry !== undefined, `${file.path} is recorded`);
    const disk = join(projectRoot, ...file.path.split('/'));
    assert.equal(entry.sha256, sha256File(disk), `${file.path} hash`);
    assert.equal(entry.mode, file.mode === 0o755 ? '0755' : '0644');
    assert.equal(entry.origin, 'projection');
    assert.equal(typeof entry.kind, 'string');
    assert.ok(Array.isArray(entry.targets) && entry.targets.length > 0);
  }
  assert.deepEqual([...byPath.keys()].sort(), receipt.files.map((file) => file.path));
  assert.equal(byPath.has(compiledWorkflowRelPath(compiledWorkflow.id, compiledWorkflow.version)), false, 'the compiled workflow copy is bookkeeping, not owned content');

  // No absolute path anywhere in the receipt, and nothing outside the project.
  assert.equal(text.includes(projectRoot.replaceAll('\\', '\\\\')), false);
  assert.doesNotMatch(text, /[A-Za-z]:\\\\/);
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/pending.json')), false);
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/.lock')), false);

  // Modes are applied where the platform has them.
  if (process.platform !== 'win32') {
    for (const file of result.files) {
      const mode = statSync(join(projectRoot, ...file.path.split('/'))).mode & 0o777;
      assert.equal(mode, file.mode);
    }
  }
});

test('reinstalling the same result is unchanged and byte-identical', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  const first = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(first.action, 'installed');
  const receiptFile = join(projectRoot, ...first.receiptPath.split('/'));
  const before = readFileSync(receiptFile, 'utf8');
  const beforeTree = walk(projectRoot).map((path) => [path, sha256File(join(projectRoot, ...path.split('/')))]);

  const second = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: fixedClock('2026-02-02T00:00:00.000Z') });
  assert.equal(second.code, 'OK');
  assert.equal(second.action, 'unchanged');
  assert.deepEqual(second.diff, {
    add: [],
    remove: [],
    change: [],
    keep: result.files.map((file) => file.path).sort(),
  });
  assert.equal(readFileSync(receiptFile, 'utf8'), before);
  const afterTree = walk(projectRoot).map((path) => [path, sha256File(join(projectRoot, ...path.split('/')))]);
  assert.deepEqual(afterTree, beforeTree);
});

test('adopts unowned files with identical bytes without rewriting them', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  for (const file of result.files) {
    const absolute = join(projectRoot, ...file.path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, { flag: 'w' });
  }
  const outcome = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'installed');
  assert.equal(outcome.wrote.length, 0, 'nothing is rewritten when every file is adopted');
  assert.equal(outcome.decisions.every((decision) => decision.action === 'adopt'), true);
});

test('dry-run reports the plan and writes nothing', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  const outcome = installProjection({ result, compiledWorkflowBytes, projectRoot, dryRun: true, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'would-install');
  assert.equal(outcome.decisions.length, result.files.length);
  assert.deepEqual(walk(projectRoot), []);
});

test('a compiled workflow whose bytes do not match the result digest is refused without writes', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  const tampered = Buffer.from(compiledWorkflowBytes.toString('utf8').replace('rtosv3-drvport', 'rtosv3-drvport'), 'utf8');
  const outcome = installProjection({
    result,
    compiledWorkflowBytes: Buffer.concat([tampered, Buffer.from('\n')]),
    projectRoot,
    clock: CLOCK,
  });
  assert.equal(outcome.code, 'PROJECTION_RESULT_INVALID');
  assert.deepEqual(walk(projectRoot), []);
});

test('executable modes survive to the receipt and the disk', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  const mutated = cloneResult(result);
  mutated.files[0].mode = 0o755;
  const outcome = installProjection({ result: mutated, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  const entry = outcome.receipt.files.find((file) => file.path === mutated.files[0].path);
  assert.equal(entry.mode, '0755');
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(projectRoot, ...mutated.files[0].path.split('/'))).mode & 0o777, 0o755);
  }
});

/** A fixture compiled workflow whose roles/skills/tasks carry a per-variant prefix. */
function prefixedCompiledWorkflow(prefix) {
  const compiledWorkflow = JSON.parse(readFileSync(COMPILED_WORKFLOW_FIXTURE, 'utf8'));
  compiledWorkflow.id = prefix;
  compiledWorkflow.constitution = [];
  const skills = new Map(Object.keys(compiledWorkflow.skills).map((id, index) => [id, `${prefix}-skill-${index}`]));
  compiledWorkflow.skills = Object.fromEntries(Object.entries(compiledWorkflow.skills).map(([id, value]) => [skills.get(id), value]));
  compiledWorkflow.roles = Object.fromEntries(Object.entries(compiledWorkflow.roles).map(([id, value]) => [`${prefix}-${id}`, value]));
  compiledWorkflow.tasks = Object.fromEntries(Object.entries(compiledWorkflow.tasks).map(([id, value]) => [`${prefix}-${id}`, value]));
  for (const stage of compiledWorkflow.stages) {
    for (const step of stage.steps) {
      if (step.task !== undefined) step.task = `${prefix}-${step.task}`;
      if (step.role !== undefined) step.role = `${prefix}-${step.role}`;
      step.skills = (step.skills ?? []).map((id) => skills.get(id)).filter(Boolean);
    }
  }
  return compiledWorkflow;
}

function runInstallerChild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { installProjection } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'installer', 'install.js')).href)};
      const { PROJECT, RESULT, COMPILED_WORKFLOW, READY, OTHER } = process.env;
      writeFileSync(READY, '1');
      for (let index = 0; index < 5000 && !existsSync(OTHER); index += 1) {
        await new Promise((settle) => setTimeout(settle, 1));
      }
      const result = JSON.parse(readFileSync(RESULT, 'utf8'));
      const compiledWorkflowBytes = readFileSync(COMPILED_WORKFLOW);
      const outcome = installProjection({ result, compiledWorkflowBytes, projectRoot: PROJECT, clock: () => new Date('2026-01-01T00:00:00.000Z') });
      process.stdout.write(JSON.stringify(outcome));
      process.exitCode = outcome.ok ? 0 : 2;
    `], { env: { ...process.env, ...env }, encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr, outcome: stdout === '' ? null : JSON.parse(stdout) }));
  });
}

test('two concurrent runner bundles with disjoint paths yield exactly one success', async (t) => {
  const projectRoot = tempProject(t);
  const barrier = tempProject(t);
  const variants = ['alpha', 'beta'].map((prefix) => ({ prefix, value: customSample({ compiledWorkflowPatch: prefixedCompiledWorkflow(prefix) }) }));
  for (const variant of variants) {
    variant.resultFile = join(barrier, `${variant.prefix}-result.json`);
    variant.compiledWorkflowFile = join(barrier, `${variant.prefix}-compiled-workflow.json`);
    writeFileSync(variant.resultFile, JSON.stringify(variant.value.result));
    writeFileSync(variant.compiledWorkflowFile, variant.value.compiledWorkflowBytes);
  }
  const [first, second] = variants;
  const runs = await Promise.all([
    runInstallerChild({
      PROJECT: projectRoot,
      RESULT: first.resultFile,
      COMPILED_WORKFLOW: first.compiledWorkflowFile,
      READY: join(barrier, 'ready-alpha'),
      OTHER: join(barrier, 'ready-beta'),
    }),
    runInstallerChild({
      PROJECT: projectRoot,
      RESULT: second.resultFile,
      COMPILED_WORKFLOW: second.compiledWorkflowFile,
      READY: join(barrier, 'ready-beta'),
      OTHER: join(barrier, 'ready-alpha'),
    }),
  ]);
  const success = runs.filter((run) => run.status === 0);
  assert.equal(success.length, 1, JSON.stringify(runs));

  const refused = runs.filter((run) => run.status !== 0);
  assert.equal(refused.length, 1);
  assert.ok(['RUNNER_ROOT_OCCUPIED', 'LOCK_CONFLICT'].includes(refused[0].outcome?.code), `${JSON.stringify(refused[0])}\n${refused[0].stderr}`);
  const receipts = readdirSync(join(projectRoot, '.hm2b', 'install', 'receipts', 'runner'));
  assert.deepEqual(receipts, [`${success[0].outcome.receipt.bundle.id}.json`]);
});
