/**
 * Replace a file with a sibling temporary file via rename.
 *
 * On Windows a rename over an existing file can fail with EPERM/EACCES/EBUSY
 * while another process (a concurrent reader or a virus scanner) holds the
 * target for a moment. Those windows are short, so the rename is retried with
 * a bounded backoff instead of failing a lock-protected write. As a last
 * resort the target is unlinked and the rename attempted once more; that is
 * not atomic, but it only runs after the retries have been exhausted.
 *
 * POSIX rename is atomic and does not have this failure mode, so it is not
 * retried unless the caller asks for it (`attempts`/`allowUnlink`).
 */
import { renameSync, unlinkSync } from 'node:fs';

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

  // The target refused to be replaced for longer than a transient window.
  // Removing it first is the only remaining option on Windows.
  if (!win32 && options.allowUnlink !== true) throw lastError;
  try {
    unlink(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw lastError;
  }
  rename(temp, target);
}
