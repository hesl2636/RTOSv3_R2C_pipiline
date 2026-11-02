/**
 * Atomic file replacement: write a sibling temporary file, fsync, then rename
 * over the target. On Windows a rename over an existing file can fail with
 * EPERM/EACCES/EBUSY while a reader or virus scanner holds the target briefly,
 * so transient errors are retried with a bounded backoff (same policy as the
 * legacy `src/rename.js`).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const TRANSIENT = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameIntoPlace(temp, target, options = {}) {
  const win32 = process.platform === 'win32';
  const attempts = options.attempts ?? (win32 ? 30 : 1);
  const delayMs = options.delayMs ?? 10;
  const rename = options.rename ?? renameSync;
  const unlink = options.unlink ?? unlinkSync;
  const wait = options.wait ?? sleepSync;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rename(temp, target);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT.has(error?.code)) throw error;
      if (attempt + 1 < attempts) wait(delayMs);
    }
  }

  if (!win32 && options.allowUnlink !== true) throw lastError;
  try {
    unlink(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw lastError;
  }
  rename(temp, target);
}

/**
 * Replace `target` with `data` atomically. No half-written file is ever
 * visible: the temporary file lives next to the target and is cleaned up when
 * the write fails.
 */
export function atomicWriteFile(target, data, options = {}) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = options.temp ?? `${target}.tmp`;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let fd;
  try {
    fd = openSync(temp, 'w');
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameIntoPlace(temp, target, options);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or never opened; the unlink below is best effort.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may not exist; the original error is authoritative.
    }
    throw error;
  }
}

export { TRANSIENT as TRANSIENT_RENAME_CODES };
