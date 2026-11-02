/**
 * Child-process worker for the #102 concurrency and crash-recovery tests.
 *
 * `install <projectRoot> <bundleId> <gateFile>` waits for the gate, then
 * installs a projection of the fixture IR under that bundle id. Two workers
 * with different ids share r2c paths, so exactly one can win.
 *
 * `crash <projectRoot> <bundleId>` simulates a killed install: journal first,
 * then half-written files, then an abrupt exit without any cleanup.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installProjection } from '../../installer/install.js';
import {
  acquireProjectLock,
  prepareJournal,
  releaseProjectLock,
  writeJournal,
} from '../../installer/transaction.js';
import { customSample, fixedClock } from './install-fixture.js';

const [scenario, projectRoot, argument, gateFile] = process.argv.slice(2);
const CLOCK = fixedClock('2026-05-01T00:00:00.000Z');

function waitForGate(file) {
  const deadline = Date.now() + 20_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error('gate timeout');
    Atomics.wait(sleeper, 0, 0, 5);
  }
}

function absolute(path) {
  return join(projectRoot, ...path.split('/'));
}

if (scenario === 'install') {
  waitForGate(gateFile);
  const variant = customSample({ irPatch: { id: argument } });
  const outcome = installProjection({
    result: variant.result,
    irBytes: variant.irBytes,
    projectRoot,
    clock: CLOCK,
  });
  process.stdout.write(JSON.stringify({ ok: outcome.ok, code: outcome.code, action: outcome.action }));
  process.exit(0);
}

if (scenario === 'hold') {
  // Hold the project lock until the test releases it: the contender must see
  // LOCK_CONFLICT while the lock is demonstrably held, with no sleep window.
  const [root, marker, release] = process.argv.slice(3);
  const lock = acquireProjectLock(root, { now: () => CLOCK().getTime() });
  writeFileSync(marker, 'held');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(sleeper, 0, 0, 10);
  releaseProjectLock(root, lock);
  process.stdout.write(JSON.stringify({ ok: true, action: 'held' }));
  process.exit(0);
}

if (scenario === 'crash') {
  const target = 'roles/bys-architect.md';
  const created = 'roles/crashed-role.md';
  const journal = prepareJournal({
    projectRoot,
    command: 'install',
    operations: [
      { op: 'replace', path: target, backup: true },
      { op: 'create', path: created },
    ],
    createdDirs: [],
    projectionId: 'r2c',
    bundleId: argument,
    stamp: '2026-05-01T00-00-00-000Z',
    clock: CLOCK,
  });
  writeJournal(projectRoot, journal);
  mkdirSync(dirname(absolute(created)), { recursive: true });
  writeFileSync(absolute(target), 'half-written\n');
  writeFileSync(absolute(created), 'half-written\n');
  // The installer process dies here: no rollback, no journal cleanup.
  process.exit(9);
}

throw new Error(`unknown scenario: ${scenario}`);
