/**
 * Bundle source collector for the deterministic bundle build.
 *
 * The walk is deterministic (paths sorted by UTF-8 byte order) and rejects
 * anything the bundle zip contract cannot represent: symlinks, non-regular
 * files, non-POSIX or over-long paths, depth above 3, and case-folded names
 * that collide on Windows/macOS. The optional top-level `README.md` is carried
 * in the source tree but deliberately excluded from the zip (decision #65 Z9).
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MAX_PATH_BYTES = 100;
export const MAX_DEPTH = 3;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Return a one-line reason when `path` cannot be a bundle zip entry, else null. */
export function pathProblem(path) {
  if (typeof path !== 'string' || path === '') return 'path is empty';
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > MAX_PATH_BYTES) return `path is ${bytes} bytes (max ${MAX_PATH_BYTES})`;
  if (path.includes('\\')) return 'path contains a backslash';
  if (path.startsWith('/')) return 'path is absolute';
  if (/^[A-Za-z]:/.test(path)) return 'path starts with a drive letter';
  if (path.includes(':')) return 'path contains a colon';
  const segments = path.split('/');
  if (segments.length > MAX_DEPTH) return `path has ${segments.length} segments (max ${MAX_DEPTH})`;
  for (const segment of segments) {
    if (segment === '') return 'path has an empty segment';
    if (segment === '.' || segment === '..') return 'path has a dot segment';
    if (/[. ]$/.test(segment)) return `path segment ${JSON.stringify(segment)} ends with a dot or space`;
    if (!SEGMENT_PATTERN.test(segment)) {
      return `path segment ${JSON.stringify(segment)} does not match [A-Za-z0-9._-]+`;
    }
  }
  return null;
}

/** Same UTF-8 byte order the zip writer uses. */
export function comparePaths(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Collect the regular files of `bundleDir` that belong in the bundle zip.
 *
 * @param {string} bundleDir
 * @returns {Array<{path: string, bytes: Buffer}>}
 */
export function collectBundleFiles(bundleDir) {
  const root = resolve(bundleDir);
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    throw new Error(`bundle directory is unreadable: ${error.code ?? error.message}`);
  }
  if (!rootStat.isDirectory()) throw new Error('bundle path is not a directory');

  const files = [];
  const folded = new Map();

  const walk = (dir, prefix) => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      const full = join(dir, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`bundle contains a symlink: ${relative}`);
      if (stat.isDirectory()) {
        if (relative.split('/').length >= MAX_DEPTH) {
          throw new Error(`bundle directory is deeper than ${MAX_DEPTH} segments: ${relative}`);
        }
        walk(full, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`bundle contains a non-regular file: ${relative}`);
      if (relative === 'README.md') continue;
      const problem = pathProblem(relative);
      if (problem !== null) throw new Error(`${problem}: ${relative}`);
      const key = relative.toLowerCase();
      const previous = folded.get(key);
      if (previous !== undefined) {
        throw new Error(`bundle paths collide when case is folded: ${previous} / ${relative}`);
      }
      folded.set(key, relative);
      files.push({ path: relative, bytes: readFileSync(full) });
    }
  };

  walk(root, '');
  files.sort((a, b) => comparePaths(a.path, b.path));
  return files;
}
