/**
 * File-system primitives shared by the installer.
 *
 * Every write an install performs goes through this module so the contract
 * holds in one place: directory creation is tracked (so uninstall can remove
 * only directories we created), file contents are hashed uniformly, and
 * replacements are written to a sibling temporary file and renamed into place.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isInside } from '../paths.js';
import { renameIntoPlace } from '../rename.js';

export function userHome() {
  return process.env.R2C_HOME || process.env.HOME || process.env.USERPROFILE || homedir();
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return sha256(readFileSync(file));
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  return readJson(file);
}

/** mkdir -p that pushes every directory it actually created onto `created`. */
export function ensureDir(dir, created = []) {
  if (existsSync(dir)) return created;
  const parent = dirname(dir);
  if (parent !== dir) ensureDir(parent, created);
  try {
    mkdirSync(dir);
    created.push(dir);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return created;
}

/**
 * Write `data` through a sibling temp file and rename. Same-directory rename is
 * atomic on NTFS and POSIX alike; the temp name is pid-scoped so concurrent
 * installers (different locks) cannot collide. Windows sharing violations are
 * retried by `renameIntoPlace`.
 */
export function atomicWriteFile(file, data, options = {}) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.r2c-tmp-${process.pid}-${Date.now().toString(36)}`);
  writeFileSync(temp, data, options);
  renameIntoPlace(temp, file);
}

export function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function toPosix(value) {
  return value.split(sep).join('/');
}

function readEntries(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readEntries(current)) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

export function removePath(target) {
  rmSync(target, { recursive: true, force: true });
}

export function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

export function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export function linkTarget(target) {
  try {
    return lstatSync(target).isSymbolicLink() ? readlinkSync(target) : null;
  } catch {
    return null;
  }
}

export function createDirLink(linkPath, targetPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(targetPath, linkPath, type);
}

/**
 * Resolve a path the receipt recorded at install time against the project that
 * is being read now.
 *
 * A renamed or moved project keeps every file, but not the absolute paths the
 * receipt recorded: a path that no longer exists but lived under the recorded
 * root is re-rooted at the live project root. Anything outside that root — the
 * user home of a `user` scope install, an engine on another drive — is returned
 * untouched, so a move never redirects a deletion elsewhere.
 */
export function resolveRecordedPath(path, { projectRoot, recordedRoot = null }) {
  if (typeof path !== 'string' || path === '') return path;
  if (existsSync(path) || recordedRoot === null || recordedRoot === projectRoot) return path;
  if (!isInside(recordedRoot, path)) return path;
  return join(projectRoot, relative(recordedRoot, path));
}

/**
 * Absolute path of one receipt entry.
 *
 * Agent config is recorded absolute, layout copies project-relative. Both are
 * resolved live-first and only fall back to `recordedRoot` (the receipt's
 * `project_root`) when the file is absent there, so install, doctor and
 * uninstall read one receipt with one rule.
 */
export function receiptEntryPath(entry, options) {
  const { projectRoot, recordedRoot = null } = options;
  if (entry.kind === 'layout' && !isAbsolute(entry.path)) {
    const live = join(projectRoot, entry.path);
    if (existsSync(live) || recordedRoot === null) return live;
    return resolveRecordedPath(join(recordedRoot, entry.path), options);
  }
  return resolveRecordedPath(entry.path, options);
}

/**
 * A receipt read for a project that may have moved since the install.
 *
 * Every recorded absolute path — payload home, engine home and entry, merged
 * files, created directories — is re-rooted at the live project root when the
 * old location is gone. `files` is left as recorded (`layout` entries are
 * project-relative by contract) and resolved per entry with
 * `receiptEntryPath`, so a receipt is never rewritten just to read it.
 */
export function liveReceipt(receipt, projectRoot) {
  const recordedRoot = receipt.project_root ?? null;
  const resolve = (path) => resolveRecordedPath(path, { projectRoot, recordedRoot });
  const engine = receipt.engine ?? null;
  return {
    ...receipt,
    payload_home: typeof receipt.payload_home === 'string' ? resolve(receipt.payload_home) : null,
    engine: engine === null ? null : {
      ...engine,
      home: typeof engine.home === 'string' ? resolve(engine.home) : engine.home,
      entry: typeof engine.entry === 'string' ? resolve(engine.entry) : engine.entry,
    },
    merged: Array.isArray(receipt.merged)
      ? receipt.merged.map((entry) => (
        typeof entry?.file === 'string' ? { ...entry, file: resolve(entry.file) } : entry
      ))
      : receipt.merged,
    merged_files_created: Array.isArray(receipt.merged_files_created)
      ? receipt.merged_files_created.map(resolve)
      : receipt.merged_files_created,
    backups: Array.isArray(receipt.backups)
      ? receipt.backups.map((entry) => ({
        ...entry,
        path: typeof entry?.path === 'string' ? resolve(entry.path) : entry?.path,
        backup: typeof entry?.backup === 'string' ? resolve(entry.backup) : entry?.backup,
      }))
      : receipt.backups,
    dirs_created: Array.isArray(receipt.dirs_created) ? receipt.dirs_created.map(resolve) : receipt.dirs_created,
    steps_file: typeof receipt.steps_file === 'string' ? resolve(receipt.steps_file) : receipt.steps_file,
  };
}
