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
import { canonicalJson } from '../core/canonical-json.js';
import { installProjection, receiptOptions } from '../installer/install.js';
import { planUninstall, uninstallProjection } from '../installer/uninstall.js';
import { cloneResult, customSample, fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();
const LATER = fixedClock('2026-04-01T00:00:00.000Z');

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-upgrade-'));
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

/** Every installer compiled workflow copy under `.hm2b/bundles`, project-relative. */
function compiledWorkflowCopies(projectRoot) {
  return walk(projectRoot).filter((path) => path.startsWith('.hm2b/bundles/') && path.endsWith('/workflow.compiled.json'));
}

function byPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** Add a projected file + its install step (a payload that grew). */
function addFile(result, { path, content, kind = 'skill' }) {
  result.files.push({ path, targets: ['runner'], kind, content, mode: 0o644, origin: 'generated' });
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
  const variant = customSample({ compiledWorkflowPatch: { version: '1.1.0' } });
  const result = cloneResult(variant.result);
  changeFile(result, 'roles/bys-architect.md', `${result.files.find((file) => file.path === 'roles/bys-architect.md').content}\ncustomized in 1.1.0\n`);
  removeFile(result, 'roles/bys-designer.md');
  addFile(result, { path: 'skills/upgrade-only/SKILL.md', content: '# upgrade only\n\nAdded by 1.1.0.\n' });
  return { ...variant, result };
}

test('an upgrade reports add/remove/change/keep and deletes untouched removals', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('runner');
  const first = installProjection({ result: v1.result, compiledWorkflowBytes: v1.compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(first.code, 'OK');
  const v2 = changedPayload();
  const changedPath = 'roles/bys-architect.md';
  const workflowPath = 'workflows/rtosv3-drvport.yaml';
  const removedPath = 'roles/bys-designer.md';
  const addedPath = 'skills/upgrade-only/SKILL.md';
  const changedPaths = [changedPath, workflowPath];

  const outcome = installProjection({ result: v2.result, compiledWorkflowBytes: v2.compiledWorkflowBytes, projectRoot, clock: LATER });
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
    compiled_workflow_digest: v1.compiledWorkflowDigest,
    options: previousOptions,
  });
});

test('an upgrade from 1.0.0 to 1.1.0 leaves only the new compiled workflow copy', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('runner');
  const first = installProjection({ result: v1.result, compiledWorkflowBytes: v1.compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(first.code, 'OK');
  const oldCompiledWorkflow = `.hm2b/bundles/${v1.compiledWorkflow.id}/1.0.0/workflow.compiled.json`;
  assert.equal(first.receipt.compiledWorkflow.path, oldCompiledWorkflow);
  assert.deepEqual(compiledWorkflowCopies(projectRoot), [oldCompiledWorkflow]);

  const v2 = changedPayload();
  const newCompiledWorkflow = `.hm2b/bundles/${v2.compiledWorkflow.id}/1.1.0/workflow.compiled.json`;
  const outcome = installProjection({ result: v2.result, compiledWorkflowBytes: v2.compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.mode, 'upgrade');
  assert.equal(outcome.supersededCompiledWorkflow, oldCompiledWorkflow, 'the replaced compiled workflow copy is named');
  assert.equal(outcome.receipt.compiledWorkflow.path, newCompiledWorkflow);
  assert.equal(existsSync(absolute(projectRoot, oldCompiledWorkflow)), false, 'the unreferenced 1.0.0 compiled workflow is deleted');
  assert.equal(
    existsSync(absolute(projectRoot, `.hm2b/bundles/${v1.compiledWorkflow.id}/1.0.0`)),
    false,
    'the now-empty version directory is pruned',
  );
  assert.ok(outcome.pruned.includes(`.hm2b/bundles/${v1.compiledWorkflow.id}/1.0.0`));
  assert.deepEqual(compiledWorkflowCopies(projectRoot), [newCompiledWorkflow], 'only the new compiled workflow survives the upgrade');
  assert.equal(sha256File(absolute(projectRoot, newCompiledWorkflow)), v2.compiledWorkflowDigest, 'the new compiled workflow copy is byte-identical to the installed compiled workflow');
  assert.equal(outcome.receipt.compiledWorkflow.digest, v2.compiledWorkflowDigest);
  assert.equal(
    existsSync(absolute(projectRoot, `.hm2b/bundles/${v1.compiledWorkflow.id}`)),
    true,
    'the bundle directory still holds 1.1.0',
  );
  assert.equal(
    outcome.warnings.some((warning) => warning.code === 'COMPILED_WORKFLOW_STALE_KEPT'),
    false,
    'a writable project never needs the cleanup warning',
  );
});

test('a compiled workflow copy another receipt still references survives the upgrade', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('runner');
  assert.equal(installProjection({ result: v1.result, compiledWorkflowBytes: v1.compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const oldCompiledWorkflow = `.hm2b/bundles/${v1.compiledWorkflow.id}/1.0.0/workflow.compiled.json`;

  // A second identity pinning the same 1.0.0 compiled workflow copy: the upgrade must keep it.
  const otherReceipt = '.hm2b/install/receipts/agent-native/compiled-workflow-pin.json';
  mkdirSync(absolute(projectRoot, '.hm2b/install/receipts/agent-native'), { recursive: true });
  writeFileSync(absolute(projectRoot, otherReceipt), canonicalJson({
    schema: 'hm2b.install/v2',
    projection: { id: 'agent-native', version: '1.0.0', targets: [] },
    bundle: { id: 'compiled-workflow-pin', version: '1.0.0' },
    compiledWorkflow: { path: oldCompiledWorkflow, digest: v1.compiledWorkflowDigest, contentSha256: null },
    root: 'project',
    scope: 'project',
    mode: 'fresh',
    host_targets: [],
    options: {},
    requires_engine: null,
    files: [],
    metadata: {},
    capability_report: [],
    degradations: [],
    warnings: [],
    created_dirs: [],
    backups: [],
    previous: null,
    migrated_from: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }));

  const v2 = changedPayload();
  const newCompiledWorkflow = `.hm2b/bundles/${v2.compiledWorkflow.id}/1.1.0/workflow.compiled.json`;
  const outcome = installProjection({ result: v2.result, compiledWorkflowBytes: v2.compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.supersededCompiledWorkflow, null, 'a referenced compiled workflow copy is never a deletion candidate');
  assert.equal(existsSync(absolute(projectRoot, oldCompiledWorkflow)), true, 'the other receipt keeps its compiled workflow copy');
  assert.equal(existsSync(absolute(projectRoot, otherReceipt)), true);
  assert.deepEqual(compiledWorkflowCopies(projectRoot), [oldCompiledWorkflow, newCompiledWorkflow].sort());
});

test('a removal whose disk bytes were edited is kept with a warning', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('runner');
  assert.equal(installProjection({ result: v1.result, compiledWorkflowBytes: v1.compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const removedPath = 'roles/bys-designer.md';
  writeFileSync(absolute(projectRoot, removedPath), 'edited by the user\n');

  const v2 = changedPayload();
  const outcome = installProjection({ result: v2.result, compiledWorkflowBytes: v2.compiledWorkflowBytes, projectRoot, clock: LATER });
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
  const base = sample('runner');
  const first = installProjection({ result: base.result, compiledWorkflowBytes: base.compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(first.code, 'OK');

  const subset = ['r2c-design', 'req-analysis'];
  const narrowed = sample('runner', { skills: subset });
  const outcome = installProjection({ result: narrowed.result, compiledWorkflowBytes: narrowed.compiledWorkflowBytes, projectRoot, clock: LATER });

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
  const v1 = sample('runner');
  assert.equal(installProjection({ result: v1.result, compiledWorkflowBytes: v1.compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');

  const v2 = changedPayload();
  const upgraded = installProjection({ result: v2.result, compiledWorkflowBytes: v2.compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(upgraded.code, 'OK');

  const rolledBack = installProjection({
    result: v1.result,
    compiledWorkflowBytes: v1.compiledWorkflowBytes,
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
  assert.equal(rolledBack.receipt.previous.compiled_workflow_digest, v2.compiledWorkflowDigest);

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
  const v1 = sample('runner');
  assert.equal(installProjection({ result: v1.result, compiledWorkflowBytes: v1.compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const before = snapshot(projectRoot);

  const other = customSample({ compiledWorkflowPatch: { id: 'other-workflow' } });
  const refused = installProjection({ result: other.result, compiledWorkflowBytes: other.compiledWorkflowBytes, projectRoot, clock: LATER });
  // #103 / #76 §4.2: the runner roots hold one bundle, so a second runner identity is
  // refused at the root before the path-level conflict matrix runs.
  assert.equal(refused.code, 'RUNNER_ROOT_OCCUPIED');
  assert.equal(refused.occupier.bundle, 'rtosv3-drvport');
  assert.deepEqual(snapshot(projectRoot), before, 'nothing of the old identity is rewritten');
});

test('a different bundle id with the same bare names conflicts on agent-native', (t) => {
  const projectRoot = tempProject(t);
  const first = sample('agent-native');
  assert.equal(installProjection({ result: first.result, compiledWorkflowBytes: first.compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const firstPaths = first.result.files.map((file) => file.path);

  const other = customSample({ projectionId: 'agent-native', compiledWorkflowPatch: { id: 'other-workflow' } });
  const second = installProjection({ result: other.result, compiledWorkflowBytes: other.compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(second.code, 'INSTALL_CONFLICTS');
  for (const path of firstPaths) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `first identity keeps ${path}`);
  }
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/receipts/agent-native/rtosv3-drvport.json')), true);
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/receipts/agent-native/other-workflow.json')), false);
});

test('switching projection needs an explicit uninstall; installing never removes the other projection', (t) => {
  const projectRoot = tempProject(t);
  const runnerSet = sample('runner');
  const native = sample('agent-native');
  assert.equal(installProjection({ result: runnerSet.result, compiledWorkflowBytes: runnerSet.compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');

  const second = installProjection({ result: native.result, compiledWorkflowBytes: native.compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(second.code, 'OK');
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/receipts/runner/rtosv3-drvport.json')), true);
  for (const file of runnerSet.result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), true, `runner keeps ${file.path}`);
  }

  const removed = uninstallProjection({ projectRoot, projectionId: 'runner', bundleId: runnerSet.compiledWorkflow.id, clock: LATER });
  assert.equal(removed.code, 'OK');
  for (const file of native.result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), true, `agent-native keeps ${file.path}`);
  }
  for (const file of runnerSet.result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), false, `runner released ${file.path}`);
  }
});

test('uninstall after an upgrade removes the new set and preserves shared roots', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('runner');
  assert.equal(installProjection({ result: v1.result, compiledWorkflowBytes: v1.compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const v2 = changedPayload();
  const upgraded = installProjection({ result: v2.result, compiledWorkflowBytes: v2.compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(upgraded.code, 'OK');

  const plan = planUninstall({ projectRoot, receipt: upgraded.receipt, force: false });
  assert.deepEqual(plan.leftovers, []);
  const outcome = uninstallProjection({ projectRoot, projectionId: 'runner', bundleId: v1.compiledWorkflow.id, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.deepEqual(outcome.leftover, []);
  for (const file of upgraded.receipt.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), false, `${file.path} removed`);
  }
  for (const root of ['workflows', 'tasks', 'skills', 'roles', 'constitution', '.hm2b']) {
    assert.equal(existsSync(absolute(projectRoot, root)), true, `${root} is a shared root`);
  }
  assert.equal(existsSync(absolute(projectRoot, 'skills/upgrade-only')), false);
});
