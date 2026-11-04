/**
 * #94 transaction: journal before writes, reverse rollback, crash recovery,
 * ROLLBACK_FAILED and the project lock.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installProjection } from '../installer/install.js';
import {
  journalExists,
  prepareJournal,
  readJournal,
  recoverPending,
  writeJournal,
} from '../installer/transaction.js';
import { fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();
const LATER = fixedClock('2026-03-01T00:00:00.000Z');

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-txn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function absolute(projectRoot, path) {
  return join(projectRoot, ...path.split('/'));
}

function simulateInterruptedInstall(projectRoot, { bundleId }) {
  const target = 'roles/bys-architect.md';
  const created = 'roles/new-role.md';
  const journal = prepareJournal({
    projectRoot,
    command: 'install',
    operations: [
      { op: 'replace', path: target, backup: true },
      { op: 'create', path: created },
    ],
    createdDirs: [],
    projectionId: 'runner',
    bundleId,
    stamp: '2026-01-02T00-00-00-000Z',
    clock: CLOCK,
  });
  writeJournal(projectRoot, journal);
  writeFileSync(absolute(projectRoot, target), 'half-written\n');
  writeFileSync(absolute(projectRoot, created), 'half-written\n');
  return { journal, target, created };
}

test('an interrupted install is rolled back to pre-install bytes on the next command', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes, compiledWorkflow } = sample('runner');
  assert.equal(installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const targetPath = 'roles/bys-architect.md';
  const targetBytes = readFileSync(absolute(projectRoot, targetPath), 'utf8');

  simulateInterruptedInstall(projectRoot, { bundleId: compiledWorkflow.id });
  assert.equal(readFileSync(absolute(projectRoot, targetPath), 'utf8'), 'half-written\n');
  assert.equal(existsSync(absolute(projectRoot, 'roles/new-role.md')), true);

  // The next command (an ordinary reinstall) sees the journal first.
  const outcome = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.action, 'unchanged');
  assert.equal(outcome.recovered, true);
  assert.equal(readFileSync(absolute(projectRoot, targetPath), 'utf8'), targetBytes);
  assert.equal(existsSync(absolute(projectRoot, 'roles/new-role.md')), false);
  assert.equal(journalExists(projectRoot), false);
});

test('recoverPending is idempotent and reports what it restored', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes, compiledWorkflow } = sample('runner');
  assert.equal(installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const original = readFileSync(absolute(projectRoot, 'roles/bys-architect.md'), 'utf8');
  simulateInterruptedInstall(projectRoot, { bundleId: compiledWorkflow.id });

  const first = recoverPending(projectRoot);
  assert.equal(first.ok, true);
  assert.equal(first.recovered, true);
  assert.deepEqual(first.restored, ['roles/bys-architect.md']);
  assert.deepEqual(first.removed, ['roles/new-role.md']);
  assert.equal(readFileSync(absolute(projectRoot, 'roles/bys-architect.md'), 'utf8'), original);

  const second = recoverPending(projectRoot);
  assert.equal(second.ok, true);
  assert.equal(second.recovered, false);
});

test('a rollback that cannot restore a backup keeps the journal and reports ROLLBACK_FAILED', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  const target = 'roles/bys-architect.md';
  mkdirSync(absolute(projectRoot, 'roles'), { recursive: true });
  writeFileSync(absolute(projectRoot, target), 'current\n');

  writeJournal(projectRoot, {
    schema: 'hm2b.install-journal/v1',
    command: 'install',
    started_at: '2026-01-02T00:00:00.000Z',
    state: 'pending',
    operations: [{
      op: 'replace',
      path: target,
      backup: '.hm2b/install/backup/runner/x/2026-01-02/roles/bys-architect.md',
    }],
    created_dirs: [],
    receipts_written: [],
  });

  const recovered = recoverPending(projectRoot);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.code, 'ROLLBACK_FAILED');
  assert.deepEqual(recovered.failures, [{ path: target, reason: 'BACKUP_MISSING' }]);
  assert.equal(journalExists(projectRoot), true);
  assert.equal(readJournal(projectRoot).state, 'rollback-failed');
  assert.equal(readFileSync(absolute(projectRoot, target), 'utf8'), 'current\n');

  const outcome = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(outcome.code, 'ROLLBACK_FAILED');
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/receipts')), false);
});

test('a fresh lock blocks an install and a stale lock is taken over', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  const lock = absolute(projectRoot, '.hm2b/install/.lock');
  mkdirSync(join(projectRoot, '.hm2b/install'), { recursive: true });
  writeFileSync(lock, 'other-writer');

  const blocked = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(blocked.code, 'LOCK_CONFLICT');
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/receipts')), false);

  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);
  const taken = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(taken.code, 'OK');
  assert.equal(existsSync(lock), false);
});

test('a successful install removes the journal and unlocks the project', (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes } = sample('runner');
  assert.equal(installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  assert.equal(journalExists(projectRoot), false);
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/.lock')), false);
  assert.equal(statSync(absolute(projectRoot, 'roles/bys-architect.md')).isFile(), true);
});

const WORKER = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'test/helpers/install-worker.mjs');

function runWorker(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

test('two concurrent installs in one project: exactly one writes', async (t) => {
  const projectRoot = tempProject(t);
  const marker = join(projectRoot, '..', `${projectRoot.split(/[\\/]/).pop()}-held`);
  const release = join(projectRoot, '..', `${projectRoot.split(/[\\/]/).pop()}-release`);
  t.after(() => {
    rmSync(marker, { force: true });
    rmSync(release, { force: true });
  });

  // Deterministic single-writer proof: one process demonstrates that it holds
  // the project lock (it wrote the marker after acquiring it); a second
  // process must be refused while it does. No timing assumption anywhere.
  const holder = runWorker(['hold', projectRoot, marker, release]);
  const deadline = Date.now() + 20_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error('lock holder did not start');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  const refused = await runWorker(['install', projectRoot, 'bundle-a', marker]);
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).ok, false, 'a second writer must be refused');
  assert.equal(JSON.parse(refused.stdout).code, 'LOCK_CONFLICT');
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/receipts')), false, 'the loser wrote nothing');

  writeFileSync(release, 'go');
  const held = await holder;
  assert.equal(held.status, 0, held.stderr);
  assert.equal(JSON.parse(held.stdout).action, 'held');

  const winner = await runWorker(['install', projectRoot, 'bundle-a', marker]);
  assert.equal(winner.status, 0, winner.stderr);
  const outcome = JSON.parse(winner.stdout);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, 'installed');

  const receipts = readdirSync(absolute(projectRoot, '.hm2b/install/receipts/runner'));
  assert.deepEqual(receipts, ['bundle-a.json']);
  assert.equal(existsSync(absolute(projectRoot, 'workflows/bundle-a.yaml')), true);
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/pending.json')), false);
  assert.equal(existsSync(absolute(projectRoot, '.hm2b/install/.lock')), false);
});

test('a killed install is rolled back by the next command', async (t) => {
  const projectRoot = tempProject(t);
  const { result, compiledWorkflowBytes, compiledWorkflow } = sample('runner');
  assert.equal(installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK }).code, 'OK');
  const target = 'roles/bys-architect.md';
  const original = readFileSync(absolute(projectRoot, target), 'utf8');

  const killed = await runWorker(['crash', projectRoot, compiledWorkflow.id]);
  assert.equal(killed.status, 9, killed.stderr);
  assert.equal(journalExists(projectRoot), true, 'the killed process leaves its journal');
  assert.equal(readFileSync(absolute(projectRoot, target), 'utf8'), 'half-written\n');
  assert.equal(existsSync(absolute(projectRoot, 'roles/crashed-role.md')), true);

  const outcome = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: LATER });
  assert.equal(outcome.code, 'OK');
  assert.equal(outcome.recovered, true);
  assert.equal(readFileSync(absolute(projectRoot, target), 'utf8'), original);
  assert.equal(existsSync(absolute(projectRoot, 'roles/crashed-role.md')), false);
  assert.equal(journalExists(projectRoot), false);
});
