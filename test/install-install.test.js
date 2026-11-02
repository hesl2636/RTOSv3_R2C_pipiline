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
import { irPath as irRelPath } from '../installer/paths.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloneResult, customSample, fixedClock, IR_FIXTURE, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-install-'));
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

test('installs exactly the declared r2c file set and records it in r2c.install/v2', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir, irDigest } = sample('r2c');
  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'installed');
  assert.equal(outcome.files, result.files.length);

  const receiptRel = `.r2c/install/receipts/r2c/${ir.id}.json`;
  assert.equal(outcome.receiptPath, receiptRel);
  const receiptFile = join(projectRoot, ...receiptRel.split('/'));
  const text = readFileSync(receiptFile, 'utf8');
  assert.equal(isCanonicalJson(text), true, 'receipt must be canonical JSON');

  const expected = new Set([
    ...result.files.map((file) => file.path),
    irRelPath(ir.id, ir.version),
    receiptRel,
  ]);
  const actual = new Set(walk(projectRoot));
  assert.deepEqual([...actual].sort(), [...expected].sort());

  const receipt = JSON.parse(text);
  assert.equal(receipt.schema, 'r2c.install/v2');
  assert.deepEqual(receipt.projection, { id: 'r2c', version: result.projection.version, targets: ['r2c'] });
  assert.deepEqual(receipt.bundle, { id: ir.id, version: ir.version });
  assert.equal(receipt.ir_path, irRelPath(ir.id, ir.version));
  assert.deepEqual(receipt.ir, {
    path: irRelPath(ir.id, ir.version),
    digest: irDigest,
    contentSha256: result.ir.contentSha256,
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
  assert.equal(byPath.has(irRelPath(ir.id, ir.version)), false, 'the IR copy is bookkeeping, not owned content');

  // No absolute path anywhere in the receipt, and nothing outside the project.
  assert.equal(text.includes(projectRoot.replaceAll('\\', '\\\\')), false);
  assert.doesNotMatch(text, /[A-Za-z]:\\\\/);
  assert.equal(existsSync(join(projectRoot, '.r2c/install/pending.json')), false);
  assert.equal(existsSync(join(projectRoot, '.r2c/install/.lock')), false);

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
  const { result, irBytes } = sample('r2c');
  const first = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(first.action, 'installed');
  const receiptFile = join(projectRoot, ...first.receiptPath.split('/'));
  const before = readFileSync(receiptFile, 'utf8');
  const beforeTree = walk(projectRoot).map((path) => [path, sha256File(join(projectRoot, ...path.split('/')))]);

  const second = installProjection({ result, irBytes, projectRoot, clock: fixedClock('2026-02-02T00:00:00.000Z') });
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
  const { result, irBytes } = sample('r2c');
  for (const file of result.files) {
    const absolute = join(projectRoot, ...file.path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, { flag: 'w' });
  }
  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'installed');
  assert.equal(outcome.wrote.length, 0, 'nothing is rewritten when every file is adopted');
  assert.equal(outcome.decisions.every((decision) => decision.action === 'adopt'), true);
});

test('dry-run reports the plan and writes nothing', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const outcome = installProjection({ result, irBytes, projectRoot, dryRun: true, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'would-install');
  assert.equal(outcome.decisions.length, result.files.length);
  assert.deepEqual(walk(projectRoot), []);
});

test('an IR whose bytes do not match the result digest is refused without writes', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const tampered = Buffer.from(irBytes.toString('utf8').replace('rtosv3-drvport', 'rtosv3-drvport'), 'utf8');
  const outcome = installProjection({
    result,
    irBytes: Buffer.concat([tampered, Buffer.from('\n')]),
    projectRoot,
    clock: CLOCK,
  });
  assert.equal(outcome.code, 'PROJECTION_RESULT_INVALID');
  assert.deepEqual(walk(projectRoot), []);
});

test('executable modes survive to the receipt and the disk', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const mutated = cloneResult(result);
  mutated.files[0].mode = 0o755;
  const outcome = installProjection({ result: mutated, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  const entry = outcome.receipt.files.find((file) => file.path === mutated.files[0].path);
  assert.equal(entry.mode, '0755');
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(projectRoot, ...mutated.files[0].path.split('/'))).mode & 0o777, 0o755);
  }
});

/** A fixture IR whose roles/skills/tasks carry a per-variant prefix. */
function prefixedIr(prefix) {
  const ir = JSON.parse(readFileSync(IR_FIXTURE, 'utf8'));
  ir.id = prefix;
  ir.constitution = [];
  const skills = new Map(Object.keys(ir.skills).map((id, index) => [id, `${prefix}-skill-${index}`]));
  ir.skills = Object.fromEntries(Object.entries(ir.skills).map(([id, value]) => [skills.get(id), value]));
  ir.roles = Object.fromEntries(Object.entries(ir.roles).map(([id, value]) => [`${prefix}-${id}`, value]));
  ir.tasks = Object.fromEntries(Object.entries(ir.tasks).map(([id, value]) => [`${prefix}-${id}`, value]));
  for (const stage of ir.stages) {
    for (const step of stage.steps) {
      if (step.task !== undefined) step.task = `${prefix}-${step.task}`;
      if (step.role !== undefined) step.role = `${prefix}-${step.role}`;
      step.skills = (step.skills ?? []).map((id) => skills.get(id)).filter(Boolean);
    }
  }
  return ir;
}

function runInstallerChild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { installProjection } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'installer', 'install.js')).href)};
      const { PROJECT, RESULT, IR, READY, OTHER } = process.env;
      writeFileSync(READY, '1');
      for (let index = 0; index < 5000 && !existsSync(OTHER); index += 1) {
        await new Promise((settle) => setTimeout(settle, 1));
      }
      const result = JSON.parse(readFileSync(RESULT, 'utf8'));
      const irBytes = readFileSync(IR);
      const outcome = installProjection({ result, irBytes, projectRoot: PROJECT, clock: () => new Date('2026-01-01T00:00:00.000Z') });
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

test('two concurrent r2c bundles with disjoint paths yield exactly one success', async (t) => {
  const projectRoot = tempProject(t);
  const barrier = tempProject(t);
  const variants = ['alpha', 'beta'].map((prefix) => ({ prefix, value: customSample({ irPatch: prefixedIr(prefix) }) }));
  for (const variant of variants) {
    variant.resultFile = join(barrier, `${variant.prefix}-result.json`);
    variant.irFile = join(barrier, `${variant.prefix}-ir.json`);
    writeFileSync(variant.resultFile, JSON.stringify(variant.value.result));
    writeFileSync(variant.irFile, variant.value.irBytes);
  }
  const [first, second] = variants;
  const runs = await Promise.all([
    runInstallerChild({
      PROJECT: projectRoot,
      RESULT: first.resultFile,
      IR: first.irFile,
      READY: join(barrier, 'ready-alpha'),
      OTHER: join(barrier, 'ready-beta'),
    }),
    runInstallerChild({
      PROJECT: projectRoot,
      RESULT: second.resultFile,
      IR: second.irFile,
      READY: join(barrier, 'ready-beta'),
      OTHER: join(barrier, 'ready-alpha'),
    }),
  ]);
  const success = runs.filter((run) => run.status === 0);
  assert.equal(success.length, 1, JSON.stringify(runs));

  const refused = runs.filter((run) => run.status !== 0);
  assert.equal(refused.length, 1);
  assert.ok(['R2C_ROOT_OCCUPIED', 'LOCK_CONFLICT'].includes(refused[0].outcome?.code), `${JSON.stringify(refused[0])}\n${refused[0].stderr}`);
  const receipts = readdirSync(join(projectRoot, '.r2c', 'install', 'receipts', 'r2c'));
  assert.deepEqual(receipts, [`${success[0].outcome.receipt.bundle.id}.json`]);
});
