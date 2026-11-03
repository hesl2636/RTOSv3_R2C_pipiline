/**
 * Exclusive project locks.
 *
 * A lock is a file created with `open(..., 'wx')`: the create is atomic, so
 * exactly one writer wins. A file older than 60 s is considered stale (its
 * writer crashed or the process was killed) and may be taken over.
 *
 * Lock order is fixed everywhere: `.hm2b/runs/.latest.lock` first, then
 * `.hm2b/runs/<runId>/.lock`. Taking them in one order everywhere removes the
 * possibility of a cycle, so two concurrent writers cannot deadlock.
 *
 * Locks only cover the read-modify-write window. Gate commands and shell
 * steps run outside the lock; see `src/commands/submit.js`.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { EXIT_CODES, Hm2bError } from './errors.js';
import { latestLockPath, runLockPath } from './paths.js';

/** Age at which a lock file is assumed abandoned. */
export const STALE_LOCK_MS = 60_000;

function lockConflict(file) {
  return new Hm2bError(
    'LOCK_CONFLICT',
    `lock is held by another writer: ${file}`,
    { lock: file },
    EXIT_CODES.LOCK,
  );
}

function token() {
  return `${process.pid}-${randomBytes(8).toString('hex')}`;
}

function tryCreate(file, owner) {
  let fd;
  try {
    fd = openSync(file, 'wx');
    writeSync(fd, owner);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Create `file` exclusively. Returns an ownership token that must be passed to
 * `releaseLock`. Raises LOCK_CONFLICT (exit 5) when a fresh lock exists.
 */
export function acquireLock(file, { staleMs = STALE_LOCK_MS, now = Date.now() } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const owner = token();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreate(file, owner)) return owner;

    let stats;
    try {
      stats = statSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (now - stats.mtimeMs < staleMs) throw lockConflict(file);

    // Stale: remove it and race for a fresh create on the next attempt.
    try {
      unlinkSync(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  throw lockConflict(file);
}

/**
 * Release a lock only when this process still owns it. If the lock was taken
 * over as stale while we were slow, its token changed and we must not delete
 * the new owner's file.
 */
export function releaseLock(file, owner) {
  try {
    if (readFileSync(file, 'utf8') !== owner) return false;
    unlinkSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Run `fn` while holding one lock; always releases on throw. */
export function withLock(file, fn, options = {}) {
  const owner = acquireLock(file, options);
  try {
    return fn();
  } finally {
    releaseLock(file, owner);
  }
}

export function withLatestLock(root, fn, options = {}) {
  return withLock(latestLockPath(root), fn, options);
}

export function withRunLock(root, runId, fn, options = {}) {
  return withLock(runLockPath(root, runId), fn, options);
}

/**
 * Read-modify-write of a run that may also update `latest.json`.
 * Fixed order: latest lock → run lock.
 */
export function withRunWriteLock(root, runId, fn, options = {}) {
  return withLatestLock(root, () => withRunLock(root, runId, fn, options), options);
}
