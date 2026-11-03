/**
 * #103 legacy takeover (spec §12, #76 §9).
 *
 * A project-scope `r2c.install/v1` receipt blocks every new install until
 * `--migrate-legacy` verifies hashes, backs up, revokes merge pointers and
 * retires the old receipts under `.r2c/install/legacy/*.retired`. User-scope
 * leftovers are reported as manual steps and never touched.
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { installProjection } from '../installer/install.js';
import { legacyJournalOperations } from '../installer/legacy.js';
import { unlinkIfExists } from '../installer/util.js';
import { fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
  return walk(projectRoot).map((path) => [path, statSync(absolute(projectRoot, path)).isFile() ? sha256File(absolute(projectRoot, path)) : 'dir']);
}

function writeFile(projectRoot, path, content) {
  const target = absolute(projectRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return { path, content, sha256: createHash('sha256').update(content).digest('hex') };
}

function legacySettings(projectRoot) {
  return {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node .r2c/bin/r2c.js stop' }] }] },
    keep: 'user-owned',
  };
}

/**
 * A project-scope legacy install: layout copies, an absolute agent file, a
 * merge pointer and the receipt in `.r2c/install/<agent>.json`.
 */
function writeLegacyProject(projectRoot, { revision = '1.0.0' } = {}) {
  const settingsPath = join(projectRoot, '.claude/settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  const settings = legacySettings(projectRoot);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const files = [
    writeFile(projectRoot, 'workflows/rtosv3-drvport.yaml', 'name: legacy-workflow\nstages: []\n'),
    writeFile(projectRoot, 'tasks/legacy-task.md', '# legacy task\n'),
    writeFile(projectRoot, 'skills/legacy-skill/SKILL.md', '# legacy skill\n'),
    writeFile(projectRoot, '.claude/agents/bys-architect.md', '# legacy role\n'),
  ];

  const receipt = {
    schema: 'r2c.install/v1',
    adapter: 'claude',
    scope: 'project',
    project_root: projectRoot,
    payload_home: join(projectRoot, `.r2c/payload/${revision}`),
    mode: 'copy',
    payload: { version: revision, files: [] },
    engine: { version: revision },
    runner_cmd: 'node .r2c/bin/r2c.js',
    requires: {},
    agent: { id: 'claude' },
    files: files.map((file, index) => ({
      path: index === 3 ? join(projectRoot, file.path) : file.path,
      kind: index === 3 ? 'agent' : 'layout',
      sha256: file.sha256,
      source: file.path,
    })),
    merged: [{
      file: settingsPath,
      pointer: 'hooks.Stop',
      value: settings.hooks.Stop,
    }],
    merged_files_created: [],
    backups: [],
    manual: [],
    dirs_created: ['skills/legacy-skill'],
    installed_at: '2025-10-01T00:00:00.000Z',
    updated_at: '2025-10-01T00:00:00.000Z',
    state_dir: join(projectRoot, '.r2c'),
  };
  const receiptPath = join(projectRoot, '.r2c/install/claude.json');
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, receiptPath, files, settingsPath, settings };
}

function writeUserLegacy(userHome) {
  const path = join(userHome, '.r2c/install/omp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: 'r2c.install/v1',
    adapter: 'omp',
    scope: 'user',
    files: [],
    installed_at: '2025-10-01T00:00:00.000Z',
  }, null, 2)}\n`);
  return path;
}

test('a legacy receipt refuses a new install and points at --migrate-legacy', (t) => {
  const projectRoot = tempDir(t, 'r2c-migrate-refuse-');
  writeLegacyProject(projectRoot);
  const before = snapshot(projectRoot);
  const { result, irBytes } = sample('r2c');

  const outcome = installProjection({ result, irBytes, projectRoot, force: true, clock: CLOCK });
  assert.equal(outcome.code, 'LEGACY_INSTALL_PRESENT');
  assert.deepEqual(outcome.legacy.map((item) => item.path), ['.r2c/install/claude.json']);
  assert.match(outcome.hint, /--migrate-legacy/);
  assert.deepEqual(snapshot(projectRoot), before);
});

test('--migrate-legacy verifies hashes, backs up, revokes pointers and retires receipts', (t) => {
  const projectRoot = tempDir(t, 'r2c-migrate-ok-');
  const legacy = writeLegacyProject(projectRoot);
  const oldReceiptBytes = readFileSync(legacy.receiptPath, 'utf8');
  const { result, irBytes } = sample('r2c');

  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK, migrateLegacy: true });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.mode, 'migrated');
  assert.deepEqual(outcome.migration.receipts, ['.r2c/install/claude.json']);
  assert.deepEqual(outcome.migration.retired, ['.r2c/install/legacy/claude.json.retired']);
  assert.deepEqual(outcome.migration.manual_leftovers, []);
  assert.deepEqual(outcome.manualSteps, []);

  // The receipt is retired verbatim, not deleted and not rewritten.
  const retired = absolute(projectRoot, '.r2c/install/legacy/claude.json.retired');
  assert.equal(existsSync(retired), true);
  assert.equal(readFileSync(retired, 'utf8'), oldReceiptBytes);
  assert.equal(existsSync(legacy.receiptPath), false);
  assert.deepEqual(outcome.receipt.migrated_from.receipts, ['.r2c/install/claude.json']);
  assert.deepEqual(outcome.receipt.migrated_from.retired, ['.r2c/install/legacy/claude.json.retired']);
  assert.equal(outcome.receipt.migrated_from.manual_leftovers.length, 0);

  // Legacy files are gone; the new projection owns its own paths.
  for (const file of legacy.files) {
    if (file.path === 'workflows/rtosv3-drvport.yaml') continue;
    assert.equal(existsSync(absolute(projectRoot, file.path)), false, `${file.path} is removed`);
  }
  for (const file of result.files) {
    assert.equal(existsSync(absolute(projectRoot, file.path)), true, `${file.path} is installed`);
  }

  // Merge pointers are revoked, foreign keys stay.
  const settings = JSON.parse(readFileSync(legacy.settingsPath, 'utf8'));
  assert.equal(settings.hooks, undefined);
  assert.equal(settings.keep, 'user-owned');

  // Every destructive step has a backup on disk with the pre-migration bytes.
  const backupRoot = absolute(projectRoot, '.r2c/install/backup');
  assert.equal(existsSync(backupRoot), true);
  const backedUp = walk(projectRoot).filter((path) => path.startsWith('.r2c/install/backup/'));
  for (const path of ['claude.json', 'settings.json', 'legacy-task.md', 'legacy-skill/SKILL.md']) {
    const matches = backedUp.filter((entry) => entry.endsWith(`/${path}`));
    assert.equal(matches.length, 1, `${path} is backed up exactly once`);
  }
  const receiptBackup = backedUp.find((entry) => entry.endsWith('/claude.json'));
  assert.equal(readFileSync(absolute(projectRoot, receiptBackup), 'utf8'), oldReceiptBytes);
  const settingsBackup = backedUp.find((entry) => entry.endsWith('/settings.json'));
  assert.equal(
    JSON.parse(readFileSync(absolute(projectRoot, settingsBackup), 'utf8')).keep,
    'user-owned',
    'the backup keeps the merged document before the pointer revoke',
  );
  assert.ok(outcome.backups.some((backup) => backup.path === '.claude/settings.json'));
});

test('a legacy hash mismatch refuses migration unless --force backs it up', (t) => {
  const projectRoot = tempDir(t, 'r2c-migrate-hash-');
  writeLegacyProject(projectRoot);
  writeFileSync(absolute(projectRoot, 'tasks/legacy-task.md'), '# edited after install\n');
  const before = snapshot(projectRoot);
  const { result, irBytes } = sample('r2c');

  const refused = installProjection({ result, irBytes, projectRoot, clock: CLOCK, migrateLegacy: true });
  assert.equal(refused.code, 'LEGACY_HASH_MISMATCH');
  assert.deepEqual(refused.conflicts.map((conflict) => conflict.path), ['tasks/legacy-task.md']);
  assert.deepEqual(snapshot(projectRoot), before);

  const forced = installProjection({ result, irBytes, projectRoot, clock: CLOCK, migrateLegacy: true, force: true });
  assert.equal(forced.code, 'OK');
  const backup = walk(projectRoot).find((path) => path.startsWith('.r2c/install/backup/') && path.endsWith('/tasks/legacy-task.md'));
  assert.ok(backup !== undefined, 'the edited file is backed up before takeover');
  assert.equal(readFileSync(absolute(projectRoot, backup), 'utf8'), '# edited after install\n');
});

test('user-scope leftovers are printed as manual steps and never touched', (t) => {
  const projectRoot = tempDir(t, 'r2c-migrate-user-');
  const userHome = tempDir(t, 'r2c-migrate-home-');
  writeLegacyProject(projectRoot);
  const userReceipt = writeUserLegacy(userHome);
  const userBytes = readFileSync(userReceipt, 'utf8');
  const { result, irBytes } = sample('r2c');

  const outcome = installProjection({
    result, irBytes, projectRoot, clock: CLOCK, migrateLegacy: true, userHome,
  });
  assert.equal(outcome.code, 'OK');
  assert.equal(readFileSync(userReceipt, 'utf8'), userBytes, 'user scope is read-only');
  const manual = outcome.manualSteps.join('\n');
  assert.match(manual, /user-scope/);
  assert.match(manual, /r2c adapter uninstall omp/);
  assert.ok(manual.includes(userReceipt));
  assert.ok(outcome.receipt.migrated_from.manual_leftovers.some((line) => line.includes(userReceipt)));
});

test('an unknown legacy schema aborts migration without touching the project', (t) => {
  const projectRoot = tempDir(t, 'r2c-migrate-unknown-');
  writeLegacyProject(projectRoot);
  const unknown = join(projectRoot, '.r2c/install/codex.json');
  writeFileSync(unknown, '{"schema":"r2c.install/v9"}\n');
  const before = snapshot(projectRoot);
  const { result, irBytes } = sample('r2c');

  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK, migrateLegacy: true });
  assert.equal(outcome.code, 'LEGACY_RECEIPT_UNSUPPORTED');
  assert.deepEqual(outcome.unsupported.map((item) => item.path), ['.r2c/install/codex.json']);
  assert.deepEqual(snapshot(projectRoot), before);
});

test('a failed migration rolls back every legacy deletion', (t) => {
  const projectRoot = tempDir(t, 'r2c-migrate-rollback-');
  writeLegacyProject(projectRoot);
  // A regular file where the new projection needs a directory: the write fails
  // after the legacy files were already removed.
  writeFileSync(join(projectRoot, 'constitution'), 'blocker\n');
  const stable = () => snapshot(projectRoot).filter(([path]) => !path.startsWith('.r2c/install/backup/'));
  const before = stable();
  const { result, irBytes } = sample('r2c');

  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK, migrateLegacy: true });
  assert.notEqual(outcome.code, 'OK');
  assert.deepEqual(stable(), before, 'legacy bytes and the receipt are restored');
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/legacy/claude.json.retired')), false);
  assert.equal(existsSync(absolute(projectRoot, '.r2c/install/pending.json')), false);
});

test('unlinkIfExists treats a path below a regular file as absent', (t) => {
  const projectRoot = tempDir(t, 'r2c-unlink-');
  writeFileSync(join(projectRoot, 'blocker'), 'not a directory\n');
  // Linux reports ENOTDIR, Windows ENOENT; both mean "nothing to unlink".
  assert.equal(unlinkIfExists(join(projectRoot, 'blocker', 'CONSTITUTION.md')), false);
});

test('journal operations skip merged pointers whose file is gone', (t) => {
  const projectRoot = tempDir(t, 'r2c-journal-');
  const operations = legacyJournalOperations({
    merged: [{ file: 'settings.json', pointer: 'hooks.Stop' }],
    deletions: [],
    receipts: [],
  }, new Set(), projectRoot);
  assert.deepEqual(operations, []);
});
