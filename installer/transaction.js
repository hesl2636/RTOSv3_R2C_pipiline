/**
 * Install transaction: one project lock, a `pending.json` journal written
 * before the first mutation, per-file backups, same-directory temp + rename,
 * reverse rollback and crash recovery on the next command (#76 §6.3).
 *
 * Operations are project-relative POSIX paths. A journal exists only while a
 * transaction is in flight; `state: "rollback-failed"` is the one case it is
 * kept on purpose.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../core/canonical-json.js';
import { comparePaths } from '../core/paths.js';
import {
  BACKUP_DIR,
  JOURNAL_FILE,
  JOURNAL_SCHEMA,
  LOCK_FILE,
  projectPath,
} from './paths.js';
import {
  copyBackup,
  createExclusive,
  ensureAbsoluteDir,
  ensureProjectDirs,
  lstatOrNull,
  pruneEmptyDir,
  readJsonFile,
  unlinkIfExists,
  writeAbsoluteAtomic,
} from './util.js';

/** Age after which an abandoned lock is taken over (legacy semantics). */
export const STALE_LOCK_MS = 60_000;

function lockFailure(file) {
  const error = new Error(`lock is held by another writer: ${file}`);
  error.code = 'LOCK_CONFLICT';
  return error;
}

function lockToken() {
  return `${process.pid}-${randomBytes(8).toString('hex')}`;
}

/**
 * Create `.r2c/install/.lock` exclusively. A lock older than `staleMs` is
 * considered abandoned and taken over once.
 */
export function acquireProjectLock(projectRoot, { now = Date.now, staleMs = STALE_LOCK_MS } = {}) {
  const rel = LOCK_FILE;
  const file = projectPath(projectRoot, rel);
  ensureProjectDirs(projectRoot, '.r2c/install');
  const owner = lockToken();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createExclusive(file, owner)) return { file, owner };
    let stats;
    try {
      stats = statSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (now() - stats.mtimeMs < staleMs) throw lockFailure(rel);
    try {
      unlinkSync(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw lockFailure(rel);
}

export function releaseProjectLock(projectRoot, handle) {
  if (handle === null || handle === undefined) return;
  try {
    if (readFileSync(handle.file, 'utf8') !== handle.owner) return;
  } catch {
    return;
  }
  try {
    unlinkSync(handle.file);
  } catch {
    // Already gone; releasing a lock is idempotent.
  }
}

/** Run `fn` under the project lock, releasing it on every exit path. */
export function withProjectLock(projectRoot, fn, options = {}) {
  const handle = acquireProjectLock(projectRoot, options);
  try {
    return fn();
  } finally {
    releaseProjectLock(projectRoot, handle);
  }
}

export function journalPath(projectRoot) {
  return projectPath(projectRoot, JOURNAL_FILE);
}

export function readJournal(projectRoot) {
  const file = journalPath(projectRoot);
  const read = readJsonFile(file);
  return read.ok ? read.value : null;
}

export function writeJournal(projectRoot, journal) {
  const file = journalPath(projectRoot);
  ensureAbsoluteDir(dirname(file));
  writeAbsoluteAtomic(file, canonicalJson(journal));
}

export function removeJournal(projectRoot) {
  unlinkIfExists(journalPath(projectRoot));
}

/** `.r2c/install/backup/<projection>/<bundle>/<stamp>/<relpath>`. */
export function backupRelPath(projectionId, bundleId, stamp, relPath) {
  return `${BACKUP_DIR}/${projectionId}/${bundleId}/${stamp}/${relPath}`;
}

function operationPath(projectRoot, operation) {
  const absolute = projectPath(projectRoot, operation.path);
  if (absolute === null) {
    const error = new Error(`journal path escapes the project: ${operation.path}`);
    error.code = 'PATH_ESCAPE';
    throw error;
  }
  return absolute;
}

/**
 * Copy every operation that needs a backup and return the journal value.
 * `operations` entries: `{op:"create"|"replace"|"delete", path, backup?:bool}`.
 */
export function prepareJournal({
  projectRoot,
  command,
  operations,
  createdDirs = [],
  projectionId,
  bundleId,
  stamp,
  clock,
}) {
  const journal = {
    schema: JOURNAL_SCHEMA,
    command,
    started_at: clock().toISOString(),
    state: 'pending',
    operations: [],
    created_dirs: [...new Set(createdDirs)].sort(comparePaths),
    receipts_written: [],
  };
  for (const operation of [...operations].sort((left, right) => comparePaths(left.path, right.path))) {
    const entry = { op: operation.op, path: operation.path, backup: null };
    if (operation.backup === true) {
      const absolute = operationPath(projectRoot, operation);
      if (existsSync(absolute)) {
        const rel = backupRelPath(projectionId, bundleId, stamp, operation.path);
        entry.backup = rel;
        entry.before_sha256 = copyBackup(absolute, projectPath(projectRoot, rel));
      }
    }
    if (operation.after_sha256 !== undefined) entry.after_sha256 = operation.after_sha256;
    journal.operations.push(entry);
  }
  return journal;
}

/**
 * Reverse every journal operation: restore backups, delete created files,
 * then remove created directories bottom-up. Never throws; failures are
 * returned so the caller can keep the journal for `ROLLBACK_FAILED`.
 */
export function rollbackJournal(projectRoot, journal) {
  const restored = [];
  const removed = [];
  const dirsRemoved = [];
  const failures = [];
  const operations = Array.isArray(journal?.operations) ? journal.operations : [];
  for (const operation of [...operations].reverse()) {
    try {
      const absolute = operationPath(projectRoot, operation);
      if (operation.backup !== null && operation.backup !== undefined) {
        const backup = projectPath(projectRoot, operation.backup);
        if (!existsSync(backup)) {
          failures.push({ path: operation.path, reason: 'BACKUP_MISSING' });
          continue;
        }
        ensureAbsoluteDir(dirname(absolute));
        copyBackup(backup, absolute);
        restored.push(operation.path);
      } else if (operation.op === 'create' || operation.op === 'replace') {
        if (unlinkIfExists(absolute)) removed.push(operation.path);
      }
    } catch (error) {
      failures.push({ path: operation.path, reason: error?.code ?? 'ROLLBACK_IO' });
    }
  }
  const dirs = [...new Set(journal?.created_dirs ?? [])].sort((left, right) => {
    const byDepth = right.split('/').length - left.split('/').length;
    return byDepth !== 0 ? byDepth : comparePaths(right, left);
  });
  for (const dir of dirs) {
    try {
      if (pruneEmptyDir(projectRoot, dir)) dirsRemoved.push(dir);
    } catch (error) {
      failures.push({ path: dir, reason: error?.code ?? 'ROLLBACK_IO' });
    }
  }
  return { restored, removed, dirsRemoved, failures };
}

/**
 * Crash recovery, called at the start of every installer command. A committed
 * journal is simply removed; a pending one is rolled back. A failed rollback
 * keeps the journal with `state: "rollback-failed"`.
 */
export function recoverPending(projectRoot, { clock = () => new Date() } = {}) {
  const journal = readJournal(projectRoot);
  if (journal === null) return { ok: true, recovered: false, journal: null };
  if (journal.state === 'committed') {
    removeJournal(projectRoot);
    return { ok: true, recovered: false, committed: true, journal };
  }
  const outcome = rollbackJournal(projectRoot, journal);
  if (outcome.failures.length > 0) {
    writeJournal(projectRoot, { ...journal, state: 'rollback-failed', failed_at: clock().toISOString() });
    return {
      ok: false,
      code: 'ROLLBACK_FAILED',
      recovered: false,
      journalPath: JOURNAL_FILE,
      failures: outcome.failures,
      journal,
    };
  }
  removeJournal(projectRoot);
  return { ok: true, recovered: true, journal, ...outcome };
}

export function journalExists(projectRoot) {
  const file = journalPath(projectRoot);
  return lstatOrNull(file) !== null;
}

