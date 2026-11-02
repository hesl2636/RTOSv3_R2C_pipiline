/**
 * #103 multi-bundle coexistence (spec §12, #76 §4).
 *
 * Two agent-native bundles coexist; agent-native and r2c coexist without path
 * overlap; the same bundle id on both projections warns `DUPLICATE_BACKEND`;
 * a second r2c bundle is refused with `R2C_ROOT_OCCUPIED` before any write;
 * cross-receipt literal collisions are refused, never last-wins.
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
import { installProjection } from '../installer/install.js';
import { uninstallProjection } from '../installer/uninstall.js';
import { customSample, fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();
const LATER = fixedClock('2026-04-01T00:00:00.000Z');

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-coexist-'));
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

function receiptOf(projectRoot, projection, bundle) {
  const path = join(projectRoot, '.r2c/install/receipts', projection, `${bundle}.json`);
  assert.equal(existsSync(path), true, `receipt ${projection}/${bundle} exists`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function receiptPaths(receipt) {
  return receipt.files.map((file) => file.path);
}

function install(projectRoot, set, extra = {}) {
  return installProjection({ result: set.result, irBytes: set.irBytes, projectRoot, clock: CLOCK, ...extra });
}

function codes(outcome) {
  return [...new Set((outcome.conflicts ?? []).map((conflict) => conflict.code))].sort();
}

function writeReceipt(projectRoot, { projection = 'agent-native', bundle = 'other-bundle', paths = [] }) {
  const receipt = {
    schema: 'r2c.install/v2',
    projection: { id: projection, version: '1.0.0', targets: [] },
    bundle: { id: bundle, version: '1.0.0' },
    ir: { path: `.r2c/bundles/${bundle}/1.0.0/workflow.ir.json`, digest: '0'.repeat(64), contentSha256: '0'.repeat(64) },
    root: 'project',
    scope: 'project',
    mode: 'fresh',
    host_targets: [],
    options: { stageOrder: null, skills: null, targets: null, digest: '0'.repeat(64) },
    requires_engine: null,
    files: paths.map((path) => ({
      path,
      kind: 'other',
      targets: [],
      sha256: '0'.repeat(64),
      mode: '0644',
      origin: 'projection',
    })),
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
  };
  const rel = `.r2c/install/receipts/${projection}/${bundle}.json`;
  const path = join(projectRoot, ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalJson(receipt));
}

test('two agent-native bundles with different ids coexist and uninstall independently', (t) => {
  const projectRoot = tempProject(t);
  const first = sample('agent-native');
  const second = customSample({ projectionId: 'agent-native', irPatch: { id: 'alpha-flow' } });

  assert.equal(install(projectRoot, first).code, 'OK');
  assert.equal(install(projectRoot, second, { clock: LATER }).code, 'OK');

  const firstReceipt = receiptOf(projectRoot, 'agent-native', 'rtosv3-drvport');
  const secondReceipt = receiptOf(projectRoot, 'agent-native', 'alpha-flow');
  const firstPaths = receiptPaths(firstReceipt);
  const secondPaths = receiptPaths(secondReceipt);
  assert.equal(firstPaths.length, 98);
  assert.equal(secondPaths.length, 98);
  assert.deepEqual(firstPaths.filter((path) => secondPaths.includes(path)), [], 'the <ns> keeps the two identities apart');
  for (const path of [...firstPaths, ...secondPaths]) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `${path} exists`);
  }

  const removed = uninstallProjection({ projectRoot, projectionId: 'agent-native', bundleId: 'alpha-flow', clock: LATER });
  assert.equal(removed.code, 'OK');
  assert.deepEqual(removed.leftover, []);
  for (const path of firstPaths) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `uninstalling alpha-flow keeps ${path}`);
  }
  receiptOf(projectRoot, 'agent-native', 'rtosv3-drvport');
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/receipts/agent-native/alpha-flow.json')), false);
});

test('agent-native and r2c bundles with different ids coexist with zero path overlap', (t) => {
  const projectRoot = tempProject(t);
  const native = sample('agent-native');
  const r2c = customSample({ irPatch: { id: 'other-workflow' } });

  assert.equal(install(projectRoot, native).code, 'OK');
  assert.equal(install(projectRoot, r2c, { clock: LATER }).code, 'OK');

  const nativeReceipt = receiptOf(projectRoot, 'agent-native', 'rtosv3-drvport');
  const r2cReceipt = receiptOf(projectRoot, 'r2c', 'other-workflow');
  const overlap = receiptPaths(nativeReceipt).filter((path) => receiptPaths(r2cReceipt).includes(path));
  assert.deepEqual(overlap, []);
  assert.equal(r2cReceipt.mode, 'fresh', 'the second projection is a fresh identity, not an upgrade');

  const removed = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: 'other-workflow', clock: LATER });
  assert.equal(removed.code, 'OK');
  for (const path of receiptPaths(nativeReceipt)) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `uninstalling r2c keeps ${path}`);
  }
  receiptOf(projectRoot, 'agent-native', 'rtosv3-drvport');
});

test('the same bundle id on both projections is allowed with DUPLICATE_BACKEND and nothing is deleted', (t) => {
  const projectRoot = tempProject(t);
  const r2c = sample('r2c');
  const native = sample('agent-native');

  const first = install(projectRoot, r2c);
  assert.equal(first.code, 'OK');
  assert.deepEqual(first.warnings.filter((warning) => warning.code === 'DUPLICATE_BACKEND'), []);

  const second = install(projectRoot, native, { clock: LATER });
  assert.equal(second.code, 'OK');
  const duplicate = second.warnings.filter((warning) => warning.code === 'DUPLICATE_BACKEND');
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].target, 'r2c');
  assert.equal(duplicate[0].pointer, '.r2c/install/receipts/r2c/rtosv3-drvport.json');
  assert.deepEqual(
    second.receipt.warnings.filter((warning) => warning.code === 'DUPLICATE_BACKEND').length,
    1,
    'the receipt records the warning',
  );

  const r2cReceipt = receiptOf(projectRoot, 'r2c', 'rtosv3-drvport');
  const nativeReceipt = receiptOf(projectRoot, 'agent-native', 'rtosv3-drvport');
  for (const path of [...receiptPaths(r2cReceipt), ...receiptPaths(nativeReceipt)]) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `${path} is kept`);
  }

  const rerun = install(projectRoot, r2c, { clock: LATER });
  assert.equal(rerun.code, 'OK');
  assert.equal(rerun.warnings.filter((warning) => warning.code === 'DUPLICATE_BACKEND').length, 1);

  const removed = uninstallProjection({ projectRoot, projectionId: 'agent-native', bundleId: 'rtosv3-drvport', clock: LATER });
  assert.equal(removed.code, 'OK');
  for (const path of receiptPaths(r2cReceipt)) {
    assert.equal(existsSync(absolute(projectRoot, path)), true, `uninstalling agent-native keeps r2c ${path}`);
  }
  receiptOf(projectRoot, 'r2c', 'rtosv3-drvport');
});

test('a second r2c bundle is refused with R2C_ROOT_OCCUPIED before any write', (t) => {
  const projectRoot = tempProject(t);
  const first = sample('r2c');
  assert.equal(install(projectRoot, first).code, 'OK');
  const before = snapshot(projectRoot);

  const second = customSample({ irPatch: { id: 'other-workflow' } });
  for (const force of [false, true]) {
    const outcome = install(projectRoot, second, { clock: LATER, force });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'R2C_ROOT_OCCUPIED');
    assert.match(outcome.message, /r2c/);
    assert.deepEqual(outcome.occupied, ['workflows/rtosv3-drvport.yaml']);
    assert.equal(outcome.occupier.projection, 'r2c');
    assert.equal(outcome.occupier.bundle, 'rtosv3-drvport');
  }
  assert.deepEqual(snapshot(projectRoot), before, 'nothing of the occupied root is rewritten');
});

test('an unowned workflows/*.yaml that is byte-identical is adopted, not refused', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const workflow = result.files.find((file) => file.path.startsWith('workflows/'));
  const target = absolute(projectRoot, workflow.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, workflow.content);

  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.ok(outcome.decisions.some((decision) => decision.path === workflow.path && decision.action === 'adopt'));
  assert.equal(readFileSync(target, 'utf8'), workflow.content);
  assert.ok(receiptPaths(receiptOf(projectRoot, 'r2c', 'rtosv3-drvport')).includes(workflow.path));
});

test('an unowned workflows/*.yaml with different bytes is refused even with --force', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const workflow = result.files.find((file) => file.path.startsWith('workflows/'));
  const target = absolute(projectRoot, workflow.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'name: someone-elses-workflow\n');

  for (const force of [false, true]) {
    const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK, force });
    assert.equal(outcome.code, 'R2C_ROOT_OCCUPIED');
    assert.deepEqual(outcome.occupied, [workflow.path]);
    assert.equal(outcome.occupier.reason, 'UNOWNED_DIFFERENT');
    assert.equal(readFileSync(target, 'utf8'), 'name: someone-elses-workflow\n');
  }
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/receipts/r2c/rtosv3-drvport.json')), false);
});

const COLLISION_MATRIX = [
  {
    name: 'exact path owned by another receipt',
    otherPath(result) {
      return result.files[1].path;
    },
    kind: 'exact',
  },
  {
    name: 'case-folded path owned by another receipt',
    otherPath(result) {
      return result.files[1].path.replace(/^./, (char) => char.toUpperCase());
    },
    kind: 'case-fold',
  },
  {
    name: 'file/directory prefix owned by another receipt',
    otherPath(result) {
      return result.files[0].path.split('/')[0];
    },
    kind: 'file-dir-prefix',
  },
];

for (const row of COLLISION_MATRIX) {
  test(`cross-receipt collision is refused, never last-wins: ${row.name}`, (t) => {
    const projectRoot = tempProject(t);
    const { result, irBytes } = sample('r2c');
    const otherPath = row.otherPath(result);
    writeReceipt(projectRoot, { paths: [otherPath] });
    const before = snapshot(projectRoot);

    for (const force of [false, true]) {
      const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK, force });
      assert.equal(outcome.code, 'INSTALL_CONFLICTS');
      assert.deepEqual(codes(outcome), ['INSTALL_PATH_CONFLICT']);
      assert.equal(outcome.conflicts[0].details.kind, row.kind);
      // --force never crosses another identity's ownership, and the receipt is
      // still the only truth after the refusal.
      assert.deepEqual(snapshot(projectRoot), before);
    }
  });
}

test('the full agent-native flow stays correct through uninstall, reinstall, upgrade and rollback', (t) => {
  const projectRoot = tempProject(t);
  const v1 = sample('agent-native');
  assert.equal(v1.result.files.length, 98);

  const first = installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: CLOCK });
  assert.equal(first.code, 'OK');
  assert.equal(first.mode, 'fresh');
  assert.equal(first.receipt.files.length, 98);

  const uninstalled = uninstallProjection({
    projectRoot, projectionId: 'agent-native', bundleId: 'rtosv3-drvport', clock: LATER,
  });
  assert.equal(uninstalled.code, 'OK');
  assert.deepEqual(uninstalled.leftover, []);
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/receipts/agent-native/rtosv3-drvport.json')), false);
  assert.deepEqual(
    walk(projectRoot).filter((path) => !path.startsWith('.r2c/')),
    [],
    'only the shared roots and empty installer dirs remain',
  );

  const reinstalled = installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: LATER });
  assert.equal(reinstalled.code, 'OK');
  assert.equal(reinstalled.mode, 'fresh', 'the receipt was removed with the install');
  const idempotent = installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: LATER });
  assert.equal(idempotent.code, 'OK');
  assert.equal(idempotent.action, 'unchanged');
  assert.equal(idempotent.wrote, undefined, 'an unchanged install writes nothing');

  const v2 = customSample({ projectionId: 'agent-native', irPatch: { version: '1.1.0' } });
  const upgraded = installProjection({ result: v2.result, irBytes: v2.irBytes, projectRoot, clock: LATER });
  assert.equal(upgraded.code, 'OK');
  assert.equal(upgraded.mode, 'upgrade');
  assert.equal(upgraded.receipt.bundle.version, '1.1.0');
  assert.equal(upgraded.receipt.files.length, 98);

  const rolledBack = installProjection({ result: v1.result, irBytes: v1.irBytes, projectRoot, clock: LATER });
  assert.equal(rolledBack.code, 'OK');
  assert.equal(rolledBack.receipt.bundle.version, '1.0.0');
  assert.equal(rolledBack.receipt.previous.version, '1.1.0');

  const receipt = receiptOf(projectRoot, 'agent-native', 'rtosv3-drvport');
  for (const file of receipt.files) {
    assert.equal(sha256File(absolute(projectRoot, file.path)), file.sha256, `${file.path} matches its receipt hash`);
  }
  const declared = new Set(receipt.files.map((file) => file.path));
  const onDisk = walk(projectRoot).filter((path) => !path.startsWith('.r2c/'));
  for (const path of onDisk) {
    assert.ok(declared.has(path), `${path} is owned by the receipt`);
  }
});
