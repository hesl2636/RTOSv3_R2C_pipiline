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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

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
 * installers (different locks) cannot collide.
 */
export function atomicWriteFile(file, data, options = {}) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.r2c-tmp-${process.pid}-${Date.now().toString(36)}`);
  writeFileSync(temp, data, options);
  replacePath(temp, file);
}

export function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function replacePath(temp, target) {
  try {
    renameSync(temp, target);
  } catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    // Windows rename-over-existing can be denied while an antivirus/editor
    // holds the target; fall back to an explicit unlink and retry once.
    try {
      unlinkSync(target);
    } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    }
    renameSync(temp, target);
  }
}

export function toPosix(value) {
  return value.split(sep).join('/');
}

export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
