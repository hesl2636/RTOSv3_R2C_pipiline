/**
 * Shared path predicates (pure, platform independent).
 *
 * Archive paths are POSIX and relative; install paths are project-relative
 * POSIX with a larger byte/depth budget. Both rules live here so bundle
 * validation, projections and the installer cannot drift.
 */
import { compareCodePoints } from './code-point.js';

export const MAX_PATH_BYTES = 100;
export const MAX_PROJECTION_PATH_BYTES = 200;
export const MAX_PROJECTION_DEPTH = 8;

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const DRIVE_RE = /^[A-Za-z]:/;
const encoder = new TextEncoder();

export function utf8Length(text) {
  if (typeof text !== 'string') return 0;
  return encoder.encode(text).length;
}

/** Resolve `.` / `..` segments without touching the filesystem. */
function resolveSegments(path) {
  const parts = String(path).replaceAll('\\', '/').split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0 || out[out.length - 1] === '..') out.push('..');
      else out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** True when `child` is `root` or lives beneath it, on any platform. */
export function isInside(root, child) {
  const base = resolveSegments(root);
  const target = resolveSegments(child);
  if (base.length > target.length) return false;
  for (let index = 0; index < base.length; index += 1) {
    if (base[index] !== target[index]) return false;
  }
  return true;
}

/** Code-point order; the one comparator used by reports and manifests. */
export function comparePaths(left, right) {
  return compareCodePoints(left, right);
}

export function pathDepth(path) {
  if (typeof path !== 'string') return 0;
  return path.split('/').filter((segment) => segment !== '' && segment !== '.').length;
}

/**
 * A canonical relative path: non-empty, POSIX, relative, ASCII segments from
 * `[A-Za-z0-9._-]`, no `.`/`..`/empty segment, no trailing space or dot, at
 * most 100 UTF-8 bytes.
 */
export function isCanonicalRelativePath(path) {
  if (typeof path !== 'string' || path === '') return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || DRIVE_RE.test(path)) return false;
  if (utf8Length(path) > MAX_PATH_BYTES) return false;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
    if (!SEGMENT_RE.test(segment)) return false;
    if (segment.endsWith(' ') || segment.endsWith('.')) return false;
  }
  return true;
}

/** ASCII-only case folding (the contract forbids locale-aware folding). */
export function foldCase(path) {
  if (typeof path !== 'string') return '';
  return path.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** True when one path is a directory prefix of the other after case folding. */
export function hasFileDirPrefixConflict(left, right) {
  const a = foldCase(String(left)).replace(/\/+$/, '');
  const b = foldCase(String(right)).replace(/\/+$/, '');
  if (a === b) return false;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
