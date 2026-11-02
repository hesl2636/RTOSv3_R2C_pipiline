/**
 * Installer path contract (#76 §2–§5).
 *
 * Every path the installer records is project-relative POSIX. Absolute roots
 * are resolved only at the syscall boundary and never enter a receipt, a
 * journal or an error message. Shared roots are the directories that are never
 * removed, not even when they are empty (#76 §3.2).
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { compareCodePoints } from '../core/code-point.js';
import { MAX_PROJECTION_PATH_BYTES, foldCase, utf8Length } from '../core/paths.js';

export const INSTALL_DIR = '.r2c/install';
export const LOCK_FILE = '.r2c/install/.lock';
export const JOURNAL_FILE = '.r2c/install/pending.json';
export const RECEIPTS_DIR = '.r2c/install/receipts';
export const BACKUP_DIR = '.r2c/install/backup';
export const LEGACY_DIR = '.r2c/install/legacy';

export const RECEIPT_SCHEMA = 'r2c.install/v2';
export const LEGACY_RECEIPT_SCHEMA = 'r2c.install/v1';
export const JOURNAL_SCHEMA = 'r2c.install-journal/v1';

/** Directories that survive uninstall even when empty (#76 §3.2). */
export const SHARED_ROOTS = Object.freeze([
  'workflows',
  'tasks',
  'skills',
  'roles',
  'constitution',
  '.claude',
  '.claude/agents',
  '.claude/skills',
  '.claude/commands',
  '.agents',
  '.agents/skills',
  '.agents/agent-native',
  '.codex',
  '.codex/agents',
  '.dsh',
  '.dsh/agent-native',
  '.dsh/r2c',
  '.omp',
  '.omp/agents',
  '.opencode',
  '.opencode/agents',
  '.r2c',
  '.r2c/bin',
  '.r2c/engine',
  '.r2c/bundles',
  '.r2c/projection',
  '.r2c/install',
]);

const SHARED_SET = new Set(SHARED_ROOTS.map((root) => foldCase(root)));

/** True for a shared root (`workflows/`, `.claude/skills/`, `.r2c/install/`, …). */
export function isSharedRoot(path) {
  return SHARED_SET.has(foldCase(path));
}

/** `.r2c/install/receipts/<projection>/<bundle>.json` (#76 §5.1). */
export function receiptPath(projectionId, bundleId) {
  return `${RECEIPTS_DIR}/${projectionId}/${bundleId}.json`;
}

/** Installer-owned IR copy; not a receipt entry (#76 §3.3). */
export function irPath(bundleId, version) {
  return `.r2c/bundles/${bundleId}/${version}/workflow.ir.json`;
}

/** POSIX separators, no trailing slash; the only form receipts may contain. */
export function toPosix(path) {
  return String(path).split('\\').join('/');
}

/** Absolute path for a project-relative POSIX path; refuses escapes. */
export function projectPath(projectRoot, relPath) {
  const rel = toPosix(relPath);
  if (!isInstallPath(rel)) return null;
  const absolute = resolve(projectRoot, ...rel.split('/'));
  return isInsideProject(projectRoot, absolute) ? absolute : null;
}

const INSTALL_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Project-relative POSIX path with the projection budget (200 bytes), not the
 * 100-byte bundle-archive budget: backup paths prefix a projection path with
 * `.r2c/install/backup/<projection>/<bundle>/<stamp>/`.
 */
export function isInstallPath(path) {
  if (typeof path !== 'string' || path === '') return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  if (utf8Length(path) > MAX_PROJECTION_PATH_BYTES) return false;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    if (!INSTALL_SEGMENT_RE.test(segment)) return false;
    if (segment.endsWith(' ') || segment.endsWith('.')) return false;
  }
  return true;
}

/** True when `absolute` is the project root or lives beneath it. */
export function isInsideProject(projectRoot, absolute) {
  const rel = relative(resolve(projectRoot), resolve(absolute));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  const first = toPosix(rel).split('/')[0];
  return first !== '..';
}

/** Parent directories of a relative path, root first (`a/b/c` → `a`, `a/b`). */
export function ancestorDirs(relPath) {
  const segments = toPosix(relPath).split('/');
  segments.pop();
  const out = [];
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    out.push(current);
  }
  return out;
}

/** Candidate directories for empty-dir pruning, deepest first. */
export function pruneCandidates(paths) {
  const expanded = new Set();
  for (const path of paths) {
    for (const dir of ancestorDirs(path)) {
      if (!isSharedRoot(dir)) expanded.add(dir);
    }
  }
  return [...expanded].sort((left, right) => {
    const byDepth = right.split('/').length - left.split('/').length;
    return byDepth !== 0 ? byDepth : compareCodePoints(right, left);
  });
}

