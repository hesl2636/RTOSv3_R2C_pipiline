/**
 * Filesystem primitives for the installer (composition root: `node:*` allowed).
 *
 * All content writes go through `core/node/atomic-write.js`; reads are
 * symlink-aware so a link planted between the conflict check and the write
 * cannot redirect a project-relative path outside the project.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile as coreAtomicWrite } from '../core/node/atomic-write.js';
import { sha256Hex } from '../core/node/sha256.js';
import { comparePaths } from '../core/paths.js';
import { ancestorDirs, isSharedRoot, projectPath, toPosix } from './paths.js';

export { sha256Hex };

export function sha256File(file) {
  return sha256Hex(readFileSync(file));
}

/** `lstat` without throwing; `null` when the path does not exist. */
export function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
    return {
      ok: false,
      value: null,
      error: { code: missing ? 'ENOENT' : 'EJSON', message: `${file}: ${error?.message ?? 'unreadable'}` },
    };
  }
}

export function relativeInside(projectRoot, absolute) {
  return toPosix(absolute.slice(projectRoot.length).replace(/^[/\\]+/, ''));
}

/** `clock()` as a filesystem-safe stamp: `2026-01-02T03-04-05-678Z`. */
export function timestampSlug(clock) {
  return clock().toISOString().replace(/[:.]/g, '-');
}

/** Project-relative parent directories of `paths` that are still missing, sorted. */
export function computeCreatedDirs(projectRoot, paths) {
  const created = new Set();
  for (const path of paths) {
    for (const dir of ancestorDirs(path)) {
      const absolute = projectPath(projectRoot, dir);
      if (absolute === null) continue;
      if (lstatOrNull(absolute) === null) created.add(dir);
    }
  }
  return [...created].sort(comparePaths);
}

/** Create every missing directory of `relDir`, recording the created ones. */
export function ensureProjectDirs(projectRoot, relDir, created = new Set()) {
  if (relDir === '') return created;
  const absolute = projectPath(projectRoot, relDir);
  if (absolute === null) throw new Error(`path escapes project: ${relDir}`);
  const missing = [];
  let current = absolute;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of missing.reverse()) {
    try {
      mkdirSync(dir);
    } catch (error) {
      // A concurrent installer created it between the check and the mkdir;
      // the directory exists, which is all this loop promises.
      if (error?.code !== 'EEXIST') throw error;
      continue;
    }
    created.add(relativeInside(projectRoot, dir));
  }
  return created;
}

/** The first symlink component of `relPath` (including the leaf), or `null`. */
export function symlinkComponent(projectRoot, relPath) {
  const segments = relPath.split('/');
  let current = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const info = lstatOrNull(current);
    if (info === null) return null;
    if (info.isSymbolicLink()) return segments.slice(0, index + 1).join('/');
  }
  return null;
}

/** Write content through a same-directory temporary file and rename. */
export function writeFileAtomic(absolute, content, mode) {
  coreAtomicWrite(absolute, content, {});
  if (mode === 0o755) {
    try {
      chmodSync(absolute, 0o755);
    } catch {
      // Windows has no executable bit; the mode stays advisory.
    }
  }
}

export function writeAbsoluteAtomic(absolute, content) {
  coreAtomicWrite(absolute, content, {});
}

export function ensureAbsoluteDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/** Copy `source` to `backup`; returns the backup hash. */
export function copyBackup(source, backup) {
  mkdirSync(dirname(backup), { recursive: true });
  copyFileSync(source, backup);
  return sha256File(backup);
}

export function unlinkIfExists(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    // A path below a regular file ("file/child") is absent, not an I/O
    // failure: Linux reports ENOTDIR where Windows reports ENOENT.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Remove `dir` only when it exists, is empty and is not a shared root. */
export function pruneEmptyDir(projectRoot, relDir) {
  if (isSharedRoot(relDir)) return false;
  const absolute = projectPath(projectRoot, relDir);
  if (absolute === null) return false;
  const info = lstatOrNull(absolute);
  if (info === null || !info.isDirectory()) return false;
  if (readdirSync(absolute).length > 0) return false;
  rmdirSync(absolute);
  return true;
}

/** Exclusive-create a lock file; returns `false` when it already exists. */
export function createExclusive(file, token) {
  let handle;
  try {
    handle = openSync(file, 'wx');
    writeSync(handle, token);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
