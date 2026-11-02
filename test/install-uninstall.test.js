/**
 * #94 uninstall: exact inverse over receipt paths, leftovers, pruning and
 * dry-run purity.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/canonical-json.js';
import { installProjection } from '../installer/install.js';
import { readReceipt, serializeReceipt } from '../installer/receipt.js';
import { planUninstall, uninstallProjection } from '../installer/uninstall.js';
import { fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'installer', 'cli.js');

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-uninstall-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function absolute(projectRoot, path) {
  return join(projectRoot, ...path.split('/'));
}

function snapshot(projectRoot, current = projectRoot, out = {}) {
  if (!existsSync(current)) return out;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const rel = relative(projectRoot, full).split('\\').join('/');
    if (entry.isDirectory()) {
      out[`${rel}/`] = 'dir';
      snapshot(projectRoot, full, out);
    } else {
      out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  return out;
}

test('uninstall is the exact inverse and keeps shared roots', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  // A user file inside a shared root proves pruning never touches user content.
  mkdirSync(absolute(projectRoot, '.claude/skills/user-owned'), { recursive: true });
  writeFileSync(absolute(projectRoot, '.claude/skills/user-owned/SKILL.md'), 'mine\n');

  const outcome = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: ir.id, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.leftover.length, 0);
  assert.equal(outcome.removed.length, result.files.length + 1, 'every file plus the IR copy');
  assert.equal(outcome.irRemoved, true);

  for (const file of result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), false, `${file.path} removed`);
  }
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/receipts/r2c')), false);
  assert.equal(existsSync(absolute(projectRoot, '.r2c/bundles')), true, '.r2c/bundles is a shared root');
  assert.equal(readdirSync(absolute(projectRoot, '.r2c/bundles')).length, 0);
  for (const root of ['workflows', 'tasks', 'skills', 'roles', 'constitution', '.claude', '.r2c']) {
    assert.equal(existsSync(absolute(projectRoot, root)), true, `${root} is a shared root`);
  }
  assert.equal(readFileSync(absolute(projectRoot, '.claude/skills/user-owned/SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(existsSync(absolute(projectRoot, '.gitignore')), false, 'the installer never creates .gitignore');
  assert.equal(existsSync(absolute(projectRoot, '.r2c/payload')), false);
});

test('a modified leaf is kept as a leftover and needs --force to be backed up and removed', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const path = 'roles/bys-architect.md';
  writeFileSync(absolute(projectRoot, path), 'edited by hand\n');

  const kept = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: ir.id, clock: CLOCK });
  assert.equal(kept.code, 'UNINSTALL_INCOMPLETE');
  assert.deepEqual(kept.leftover, [{ path, reason: 'modified' }]);
  assert.equal(readFileSync(absolute(projectRoot, path), 'utf8'), 'edited by hand\n');

  // The receipt is gone, so the leftover can only be removed by hand now.
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/receipts/r2c')), false);

  // Reinstall (the kept file is now unowned, so it needs force), edit, and force.
  assert.equal(installProjection({ result, irBytes, projectRoot, force: true, clock: CLOCK }).code, 'OK');
  writeFileSync(absolute(projectRoot, path), 'edited again\n');
  const forced = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: ir.id, force: true, clock: CLOCK });
  assert.equal(forced.code, 'OK');
  assert.equal(existsSync(absolute(projectRoot, path)), false);
  assert.equal(forced.warnings.some((warning) => warning.code === 'FORCED_DELETE'), true);
});

test('empty directories are pruned bottom-up and shared roots are preserved', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const outcome = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: ir.id, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.ok(outcome.pruned.includes('skills/aceharness-rag'));
  assert.ok(outcome.pruned.includes('.r2c/install/receipts/r2c'));
  assert.equal(outcome.pruned.includes('skills'), false);
  assert.equal(existsSync(absolute(projectRoot, 'skills')), true);
  assert.equal(readdirSync(absolute(projectRoot, 'skills')).length, 0);
});

test('dry-run uninstall writes nothing', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const before = snapshot(projectRoot);

  const outcome = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: ir.id, dryRun: true, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'would-uninstall');
  assert.equal(outcome.wouldRemove.length, result.files.length + 1);
  assert.deepEqual(snapshot(projectRoot), before);
});

test('the CLI exits non-zero and reports leftovers for a modified file', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  writeFileSync(absolute(projectRoot, 'roles/bys-architect.md'), 'edited\n');

  const run = spawnSync(process.execPath, [
    CLI,
    '--uninstall',
    '--projection', 'r2c',
    '--bundle', ir.id,
    '--project', projectRoot,
    '--json',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 3);
  const envelope = JSON.parse(run.stdout.trim());
  assert.equal(envelope.ok, false);
  assert.deepEqual(envelope.data.leftover, [{ path: 'roles/bys-architect.md', reason: 'modified' }]);
});

test('roles.json recorded in the receipt is removed with the identity', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');

  // #104 adds the r2c host report to the receipt; simulate its presence here.
  const rolesRel = '.r2c/projection/roles.json';
  const rolesContent = '{"schema":"r2c.projection.roles/v1"}\n';
  mkdirSync(absolute(projectRoot, '.r2c/projection'), { recursive: true });
  writeFileSync(absolute(projectRoot, rolesRel), rolesContent);
  const stored = readReceipt(projectRoot, 'r2c', ir.id);
  const updated = {
    ...stored.receipt,
    files: [
      ...stored.receipt.files,
      {
        path: rolesRel,
        kind: 'metadata',
        targets: ['r2c'],
        sha256: createHash('sha256').update(rolesContent).digest('hex'),
        mode: '0644',
        origin: 'projection',
      },
    ].sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
  writeFileSync(absolute(projectRoot, stored.path), serializeReceipt(updated));

  const plan = planUninstall({ projectRoot, receipt: updated, force: false });
  assert.equal(plan.deletions.some((entry) => entry.path === rolesRel), true);
  const outcome = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: ir.id, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(existsSync(absolute(projectRoot, rolesRel)), false);
});

test('a modified IR copy is kept and an IR shared with another receipt is preserved', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes, ir } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const irRel = `.r2c/bundles/${ir.id}/${ir.version}/workflow.ir.json`;

  // Another identity referencing the same IR keeps the shared copy.
  const otherRel = '.r2c/install/receipts/agent-native/shared.json';
  mkdirSync(dirname(absolute(projectRoot, otherRel)), { recursive: true });
  writeFileSync(absolute(projectRoot, otherRel), canonicalJson({
    schema: 'r2c.install/v2',
    projection: { id: 'agent-native', version: '1.0.0', targets: [] },
    bundle: { id: 'shared', version: '1.0.0' },
    ir: { path: irRel, digest: '0'.repeat(64), contentSha256: '0'.repeat(64) },
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
  const shared = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: ir.id, clock: CLOCK });
  assert.equal(shared.code, 'OK');
  assert.equal(existsSync(absolute(projectRoot, irRel)), true);
  assert.equal(shared.warnings.some((warning) => warning.code === 'IR_SHARED'), true);
});
