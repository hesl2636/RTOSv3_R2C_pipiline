/**
 * #94 conflict matrix (#76 §6.2): ownership, fail-if-exists, modified/own,
 * unowned, symlink, case folding, file/directory prefixes and escapes.
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { installProjection } from '../installer/install.js';
import { cloneResult, fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-conflict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, out);
    else out.push(relative(root, absolute).split('\\').join('/'));
  }
  return out.sort();
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
  const absolute = join(projectRoot, ...rel.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, canonicalJson(receipt));
}

function targetOf(result, index = 0) {
  return result.files[index].path;
}

function codes(outcome) {
  return [...new Set((outcome.conflicts ?? []).map((conflict) => conflict.code))].sort();
}

test('a path owned by another identity is refused even with --force', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const path = targetOf(result, 1);
  writeReceipt(projectRoot, { paths: [path] });

  for (const force of [false, true]) {
    const outcome = installProjection({ result, irBytes, projectRoot, force, clock: CLOCK });
    assert.equal(outcome.code, 'INSTALL_CONFLICTS');
    assert.deepEqual(codes(outcome), ['INSTALL_PATH_CONFLICT']);
    assert.match(outcome.conflicts[0].message, /agent-native\/other-bundle/);
  }
  assert.deepEqual(walk(projectRoot).filter((path2) => !path2.startsWith('.r2c/install/receipts/')), []);
});

test('fail-if-exists steps refuse an existing path', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const path = targetOf(result);
  const absolute = join(projectRoot, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, 'preexisting\n');
  const mutated = cloneResult(result);
  mutated.installPlan.steps.find((step) => step.path === path).overwrite = 'fail-if-exists';

  const outcome = installProjection({ result: mutated, irBytes, projectRoot, force: true, clock: CLOCK });
  assert.equal(outcome.code, 'INSTALL_CONFLICTS');
  assert.deepEqual(codes(outcome), ['PATH_EXISTS']);
  assert.equal(readFileSync(absolute, 'utf8'), 'preexisting\n');
});

test('a modified file owned by this identity needs --force and is backed up', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const path = targetOf(result);
  const absolute = join(projectRoot, ...path.split('/'));
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');
  writeFileSync(absolute, 'hand edited\n');

  const refused = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(refused.code, 'INSTALL_CONFLICTS');
  assert.deepEqual(codes(refused), ['MODIFIED_OWNED_FILE']);
  assert.equal(readFileSync(absolute, 'utf8'), 'hand edited\n');

  const forced = installProjection({ result, irBytes, projectRoot, force: true, clock: CLOCK });
  assert.equal(forced.code, 'OK');
  assert.equal(readFileSync(absolute, 'utf8'), result.files.find((file) => file.path === path).content);
  assert.equal(forced.backups.some((backup) => backup.path === path), true);
  const backup = forced.backups.find((item) => item.path === path);
  assert.equal(readFileSync(join(projectRoot, ...backup.backup.split('/')), 'utf8'), 'hand edited\n');
});

test('an unmodified file owned by this identity is backed up and replaced on upgrade', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  assert.equal(installProjection({ result, irBytes, projectRoot, clock: CLOCK }).code, 'OK');

  const path = targetOf(result);
  const upgraded = cloneResult(result);
  const file = upgraded.files.find((entry) => entry.path === path);
  file.content = `${file.content}extra line\n`;
  const outcome = installProjection({ result: upgraded, irBytes, projectRoot, clock: fixedClock('2026-02-01T00:00:00.000Z') });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.mode, 'upgrade');
  assert.equal(outcome.receipt.previous.version, result.ir.version);
  assert.equal(readFileSync(join(projectRoot, ...path.split('/')), 'utf8'), file.content);
  assert.equal(outcome.backups.some((backup) => backup.path === path), true);
  assert.equal(outcome.receipt.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(outcome.receipt.updated_at, '2026-02-01T00:00:00.000Z');
});

test('an unowned file with different bytes is refused, and --force backs it up', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const path = targetOf(result);
  const absolute = join(projectRoot, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, 'user content\n');

  const refused = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(refused.code, 'INSTALL_CONFLICTS');
  assert.deepEqual(codes(refused), ['UNOWNED_PATH']);
  assert.equal(readFileSync(absolute, 'utf8'), 'user content\n');

  const forced = installProjection({ result, irBytes, projectRoot, force: true, clock: CLOCK });
  assert.equal(forced.code, 'OK');
  assert.equal(forced.backups.some((backup) => backup.path === path), true);
});

test('symlinks at a target are refused and never followed', (t) => {
  const projectRoot = tempProject(t);
  const outside = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const path = targetOf(result, 1); // `roles/bys-architect.md`
  const absolute = join(projectRoot, ...path.split('/'));
  const victim = join(outside, ...path.split('/'));
  mkdirSync(dirname(victim), { recursive: true });
  writeFileSync(victim, 'outside\n');
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    symlinkSync(victim, absolute, 'file');
  } catch (error) {
    // Windows without Developer Mode refuses file symlinks; a directory
    // junction needs no privilege and exercises the same ancestor check.
    try {
      rmSync(dirname(absolute), { recursive: true, force: true });
      symlinkSync(dirname(victim), dirname(absolute), 'junction');
    } catch {
      t.skip(`symlinks unavailable: ${error?.code}`);
      return;
    }
  }
  const outcome = installProjection({ result, irBytes, projectRoot, force: true, clock: CLOCK });
  assert.equal(outcome.code, 'INSTALL_CONFLICTS');
  assert.deepEqual(codes(outcome), ['SYMLINK_AT_TARGET']);
  assert.equal(readFileSync(victim, 'utf8'), 'outside\n');
});

test('case-folded ownership collision is refused', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const path = targetOf(result, 1);
  writeReceipt(projectRoot, { paths: [path.replace(/^./, (char) => char.toUpperCase())] });
  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'INSTALL_CONFLICTS');
  assert.deepEqual(codes(outcome), ['PATH_CASE_COLLISION']);
});

test('a file/directory prefix collision between receipts is refused', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const path = targetOf(result); // e.g. `constitution/CONSTITUTION.md`
  const prefix = path.split('/')[0];
  writeReceipt(projectRoot, { paths: [prefix] });
  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'INSTALL_CONFLICTS');
  assert.deepEqual(codes(outcome), ['PATH_PREFIX_CONFLICT']);
});

test('an escaping path is refused by V5 before anything is written', (t) => {
  const projectRoot = tempProject(t);
  const parent = dirname(projectRoot);
  const victim = join(parent, 'r2c-escape-victim.md');
  t.after(() => rmSync(victim, { force: true }));
  const { result, irBytes } = sample('r2c');
  const mutated = cloneResult(result);
  mutated.files[0].path = '../r2c-escape-victim.md';
  mutated.installPlan.steps[0].path = '../r2c-escape-victim.md';

  const outcome = installProjection({ result: mutated, irBytes, projectRoot, force: true, clock: CLOCK });
  assert.equal(outcome.code, 'PROJECTION_RESULT_INVALID');
  assert.equal(existsSync(victim), false);
  assert.deepEqual(walk(projectRoot), []);
});

test('all conflicts are aggregated in one pass, not first-error-wins', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const first = targetOf(result, 0);
  const second = targetOf(result, 1);
  for (const path of [first, second]) {
    const absolute = join(projectRoot, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'different\n');
  }
  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'INSTALL_CONFLICTS');
  assert.deepEqual(outcome.conflicts.map((conflict) => conflict.path), [first, second]);
  assert.equal(outcome.conflicts.every((conflict) => conflict.code === 'UNOWNED_PATH'), true);
});
