/**
 * #102 same-identity upgrade diff, rollback and identity boundaries
 * (#76 §6.4, spec §12): `add/remove/change/keep`, modified removals,
 * options-only upgrades, rollback through the same receipt, `bundle.id`
 * changes and explicit projection switches.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { installProjection, receiptOptions } from '../installer/install.js';
import { planUninstall, uninstallProjection } from '../installer/uninstall.js';
import { cloneResult, customSample, fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();
const LATER = fixedClock('2026-04-01T00:00:00.000Z');

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function absolute(projectRoot, path) {
  return join(projectRoot, ...path.split('/'));
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out.sort();
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function snapshot(projectRoot) {
  return walk(projectRoot).map((path) => [path, sha256File(absolute(projectRoot, path))]);
}

function byPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** Add a projected file + its install step (a payload that grew). */
function addFile(result, { path, content, kind = 'skill' }) {
  result.files.push({ path, targets: ['r2c'], kind, content, mode: 0o644, origin: 'generated' });
  result.files.sort(byPath);
  result.installPlan.steps.push({ op: 'write', path, overwrite: 'replace' });
  result.installPlan.steps.sort(byPath);
}

/** Remove a projected file, its install step and any artifact pointer. */
function removeFile(result, path) {
  result.files = result.files.filter((file) => file.path !== path);
  result.installPlan.steps = result.installPlan.steps.filter((step) => step.path !== path);
  for (const [name, value] of Object.entries(result.metadata.artifacts)) {
    if (value === path) delete result.metadata.artifacts[name];
  }
}

function changeFile(result, path, content) {
  const file = result.files.find((entry) => entry.path === path);
  assert.ok(file !== undefined, `${path} is part of the payload`);
  file.content = content;
}

/** A v1.1.0 payload: one change, one removal, one addition. */
function changedPayload() {
  const variant = customSample({ irPatch: { version: '1.1.0' } });
  const result = cloneResult(variant.result);
  changeFile(result, 'roles/bys-architect.md', `${result.files.find((file) => file.path === 'roles/bys-architect.md').content}\ncustomized in 1.1.0\n`);
  removeFile(result, 'roles/bys-designer.md');
  addFile(result, { path: 'skills/upgrade-only/SKILL.md', content: '# upgrade only\n\nAdded by 1.1.0.\n' });
  return { ...variant, result };
}

test('an upgrade reports add/remove/change/keep and deletes untouched removals', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('r2c');
  const first = installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: CLOCK });
  assert.equal(first.code, 'OK');
  const v2 = changedPayload();
  const changedPath = 'roles/bys-architect.md';
  const workflowPath = 'workflows/rtosv3-drvport.yaml';
  const removedPath = 'roles/bys-designer.md';
  const addedPath = 'skills/upgrade-only/SKILL.md';
  const changedPaths = [changedPath, workflowPath];

  const outcome = installProjection({ result: v2.result, irBytes: v2.irBytes, projectRoot, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.mode, 'upgrade');
  assert.deepEqual(outcome.diff, {
    add: [addedPath],
    remove: [removedPath],
    change: changedPaths,
    keep: v1.result.files
      .map((file) => file.path)
      .filter((path) => !changedPaths.includes(path) && path !== removedPath)
      .sort(),
  });

  assert.equal(existsSync(absolute(projectRoot, removedPath)), false, 'an untouched removal is deleted');
  assert.equal(existsSync(absolute(projectRoot, addedPath)), true, 'an addition is written');
  assert.equal(
    readFileSync(absolute(projectRoot, changedPath), 'utf8'),
    v2.result.files.find((file) => file.path === changedPath).content,
  );

  const previousOptions = receiptOptions(v1.result);
  assert.deepEqual(outcome.receipt.previous, {
    path: first.receiptPath,
    receipt: first.receiptPath,
    version: '1.0.0',
    digest: previousOptions.digest,
    ir_digest: v1.irDigest,
    options: previousOptions,
  });
});

test('a removal whose disk bytes were edited is kept with a warning', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('r2c');
  assert.equal(installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const removedPath = 'roles/bys-designer.md';
  writeFileSync(absolute(projectRoot, removedPath), 'edited by the user\n');

  const v2 = changedPayload();
  const outcome = installProjection({ result: v2.result, irBytes: v2.irBytes, projectRoot, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.ok(outcome.diff.remove.includes(removedPath));
  assert.deepEqual(outcome.warnings.find((warning) => warning.path === removedPath), {
    code: 'STALE_MODIFIED_KEPT',
    path: removedPath,
    message: `${removedPath} is no longer part of the install but was modified; it is kept`,
  });
  assert.equal(readFileSync(absolute(projectRoot, removedPath), 'utf8'), 'edited by the user\n');
  assert.equal(outcome.receipt.files.some((file) => file.path === removedPath), false, 'kept path leaves ownership');
});

test('the same version with different options is an upgrade, not unchanged', (t) => {
  const projectRoot = tempProject(t);
  const base = sample('r2c');
  const first = installProjection({ result: base.result, irBytes: base.irBytes, projectRoot, clock: CLOCK });
  assert.equal(first.code, 'OK');

  const subset = ['r2c-design', 'req-analysis'];
  const narrowed = sample('r2c', { skills: subset });
  const outcome = installProjection({ result: narrowed.result, irBytes: narrowed.irBytes, projectRoot, clock: LATER });

  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.mode, 'upgrade');
  assert.equal(outcome.receipt.bundle.version, '1.0.0');
  assert.equal(outcome.receipt.previous.version, '1.0.0', 'the previous version can equal the new one');
  assert.equal(outcome.receipt.previous.digest, receiptOptions(base.result).digest);
  assert.deepEqual(outcome.receipt.previous.options, receiptOptions(base.result));
  assert.deepEqual(outcome.receipt.options.skills, subset);
  assert.equal(outcome.diff.add.length, 0);
  assert.equal(outcome.diff.change.length, 0);
  assert.equal(outcome.diff.keep.length, narrowed.result.files.length);
  assert.equal(outcome.diff.remove.length, base.result.files.length - narrowed.result.files.length);
  assert.equal(existsSync(absolute(projectRoot, 'skills/aceharness-rag/SKILL.md')), false);
  assert.equal(existsSync(absolute(projectRoot, 'skills/r2c-design/SKILL.md')), true);
});

test('rollback installs the older payload through the same identity and keeps previous', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('r2c');
  assert.equal(installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: CLOCK }).code, 'OK');

  const v2 = changedPayload();
  const upgraded = installProjection({ result: v2.result, irBytes: v2.irBytes, projectRoot, clock: LATER });
  assert.equal(upgraded.code, 'OK');

  const rolledBack = installProjection({
    result: v1.result,
    irBytes: v1.irBytes,
    projectRoot,
    clock: fixedClock('2026-05-01T00:00:00.000Z'),
  });
  assert.equal(rolledBack.code, 'OK');
  assert.equal(rolledBack.mode, 'upgrade');
  assert.equal(rolledBack.receipt.bundle.version, '1.0.0');
  assert.equal(rolledBack.receipt.previous.version, '1.1.0', 'the replaced version stays traceable');
  assert.equal(rolledBack.receipt.previous.digest, upgraded.receipt.options.digest);
  assert.deepEqual(rolledBack.receipt.previous.options, upgraded.receipt.options);
  assert.equal(rolledBack.receipt.previous.path, rolledBack.receiptPath);
  assert.equal(rolledBack.receipt.previous.ir_digest, v2.irDigest);

  for (const file of v1.result.files) {
    assert.equal(
      readFileSync(absolute(projectRoot, file.path), 'utf8'),
      file.content,
      `${file.path} is back to the 1.0.0 bytes`,
    );
  }
  assert.equal(existsSync(absolute(projectRoot, 'skills/upgrade-only/SKILL.md')), false);
  assert.ok(rolledBack.diff.remove.includes('skills/upgrade-only/SKILL.md'));
  assert.ok(rolledBack.diff.change.includes('roles/bys-architect.md'));
});

test('a changed bundle id is a new identity, never an in-place migration', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('r2c');
  assert.equal(installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const before = snapshot(projectRoot);

  const other = customSample({ irPatch: { id: 'other-workflow' } });
  const refused = installProjection({ result: other.result, irBytes: other.irBytes, projectRoot, clock: LATER });
  assert.equal(refused.code, 'INSTALL_CONFLICTS');
  assert.deepEqual([...new Set(refused.conflicts.map((conflict) => conflict.code))], ['INSTALL_PATH_CONFLICT']);
  assert.deepEqual(snapshot(projectRoot), before, 'nothing of the old identity is rewritten');
});

test('a different bundle id on another projection is a separate identity that can coexist', (t) => {
  const projectRoot = tempProject(t);
  const first = sample('agent-native');
  assert.equal(installProjection({ result: first.result, irBytes: first.irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const firstPaths = first.result.files.map((file) => file.path);

  const other = customSample({ projectionId: 'agent-native', irPatch: { id: 'other-workflow' } });
  const second = installProjection({ result: other.result, irBytes: other.irBytes, projectRoot, clock: LATER });
  assert.equal(second.code, 'OK');
  assert.equal(second.mode, 'fresh');
  assert.equal(second.receiptPath, '.r2c/install/receipts/agent-native/other-workflow.json');
  for (const path of firstPaths) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `first identity keeps ${path}`);
  }
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/receipts/agent-native/rtosv3-drvport.json')), true);

  const removed = uninstallProjection({ projectRoot, projectionId: 'agent-native', bundleId: 'other-workflow', clock: LATER });
  assert.equal(removed.code, 'OK');
  for (const path of firstPaths) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `uninstalling the new identity keeps ${path}`);
  }
});

test('switching projection needs an explicit uninstall; installing never removes the other projection', (t) => {
  const projectRoot = tempProject(t);
  const r2c = sample('r2c');
  const native = sample('agent-native');
  assert.equal(installProjection({ result: r2c.result, irBytes: r2c.irBytes, projectRoot, clock: CLOCK }).code, 'OK');

  const second = installProjection({ result: native.result, irBytes: native.irBytes, projectRoot, clock: LATER });
  assert.equal(second.code, 'OK');
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/receipts/r2c/rtosv3-drvport.json')), true);
  for (const file of r2c.result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), true, `r2c keeps ${file.path}`);
  }

  const removed = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: r2c.ir.id, clock: LATER });
  assert.equal(removed.code, 'OK');
  for (const file of native.result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), true, `agent-native keeps ${file.path}`);
  }
  for (const file of r2c.result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), false, `r2c released ${file.path}`);
  }
});

test('uninstall after an upgrade removes the new set and preserves shared roots', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('r2c');
  assert.equal(installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const v2 = changedPayload();
  const upgraded = installProjection({ result: v2.result, irBytes: v2.irBytes, projectRoot, clock: LATER });
  assert.equal(upgraded.code, 'OK');

  const plan = planUninstall({ projectRoot, receipt: upgraded.receipt, force: false });
  assert.deepEqual(plan.leftovers, []);
  const outcome = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: v1.ir.id, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.deepEqual(outcome.leftover, []);
  for (const file of upgraded.receipt.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), false, `${file.path} removed`);
  }
  for (const root of ['workflows', 'tasks', 'skills', 'roles', 'constitution', '.r2c']) {
    assert.equal(existsSync(absolute(projectRoot, root)), true, `${root} is a shared root`);
  }
  assert.equal(existsSync(absolute(projectRoot, 'skills/upgrade-only')), false);
});
