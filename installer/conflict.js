/**
 * Ownership and conflict matrix (#76 §6.2).
 *
 * Ownership is defined by receipts, never by the mere existence of a file.
 * The whole incoming set is checked in one read-only pass so a conflict report
 * is complete instead of first-error-wins; nothing here writes.
 */
import { foldCase, hasFileDirPrefixConflict } from '../core/paths.js';
import { isInstallPath, projectPath } from './paths.js';
import { lstatOrNull, sha256File, symlinkComponent } from './util.js';

export const CONFLICT_CODES = Object.freeze([
  'PATH_ESCAPE',
  'SYMLINK_AT_TARGET',
  'PATH_TYPE_CONFLICT',
  'PATH_CASE_COLLISION',
  'PATH_PREFIX_CONFLICT',
  'INSTALL_PATH_CONFLICT',
  'PATH_EXISTS',
  'MODIFIED_OWNED_FILE',
  'UNOWNED_PATH',
]);

function conflict(code, path, message, details = {}) {
  return { code, path, message, details };
}

function ownerLabel(receipt) {
  return `${receipt?.projection?.id ?? '?'}/${receipt?.bundle?.id ?? '?'}`;
}

/**
 * Check the incoming file set against the project.
 *
 * `incoming`   — `{path, sha256, mode, overwrite}` entries (projection files).
 * `previous`   — this identity's receipt (`{path, receipt}`) or `null`.
 * `others`     — every other identity's receipt (`{path, receipt}`).
 *
 * Returns `{conflicts, decisions, stale, warnings}` where `decisions` are
 * `{path, action: "create"|"replace"|"adopt"|"keep", backup}`.
 */
export function checkConflicts({ projectRoot, incoming, previous = null, others = [], force = false }) {
  const conflicts = [];
  const decisions = [];
  const stale = [];
  const warnings = [];

  const previousFiles = previous?.receipt?.files ?? [];
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  const previousFolded = new Map(previousFiles.map((file) => [foldCase(file.path), file.path]));

  const otherEntries = [];
  for (const item of others) {
    for (const file of item.receipt?.files ?? []) {
      otherEntries.push({ path: file.path, owner: ownerLabel(item.receipt), receipt: item.path });
    }
  }
  const otherByFold = new Map();
  const otherByPath = new Map();
  for (const entry of otherEntries) {
    if (!otherByFold.has(foldCase(entry.path))) otherByFold.set(foldCase(entry.path), entry);
    if (!otherByPath.has(entry.path)) otherByPath.set(entry.path, entry);
  }

  const incomingSorted = [...incoming].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  // Intra-incoming case folding and prefix collisions.
  const foldedIncoming = new Map();
  for (const entry of incomingSorted) {
    const key = foldCase(entry.path);
    if (foldedIncoming.has(key)) {
      conflicts.push(conflict('PATH_CASE_COLLISION', entry.path, `incoming path collides with ${foldedIncoming.get(key)}`));
    } else {
      foldedIncoming.set(key, entry.path);
    }
  }
  const prefixUniverse = [
    ...[...foldedIncoming.keys()].map((key) => ({ key, path: foldedIncoming.get(key), source: 'incoming', owner: null })),
    ...otherEntries.map((entry) => ({ key: foldCase(entry.path), path: entry.path, source: 'other', owner: entry.owner })),
    ...previousFiles.map((file) => ({ key: foldCase(file.path), path: file.path, source: 'previous', owner: null })),
  ].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const seenPrefix = new Set();
  for (let index = 0; index + 1 < prefixUniverse.length; index += 1) {
    const left = prefixUniverse[index];
    const right = prefixUniverse[index + 1];
    if (!hasFileDirPrefixConflict(left.key, right.key)) continue;
    const incomingSide = left.source === 'incoming' ? left : right.source === 'incoming' ? right : null;
    if (incomingSide === null) continue;
    const otherSide = left.source === 'incoming' ? right : left;
    const signature = `${incomingSide.path}|${otherSide.path}`;
    if (seenPrefix.has(signature)) continue;
    seenPrefix.add(signature);
    conflicts.push(conflict(
      'PATH_PREFIX_CONFLICT',
      incomingSide.path,
      `${incomingSide.path} is a file/directory prefix of ${otherSide.path}`,
      otherSide.owner === null ? {} : { owner: otherSide.owner },
    ));
  }

  for (const entry of incomingSorted) {
    const { path } = entry;
    if (!isInstallPath(path) || projectPath(projectRoot, path) === null) {
      conflicts.push(conflict('PATH_ESCAPE', path, `path is not project-relative and canonical`));
      continue;
    }

    const otherExact = otherByPath.get(path);
    if (otherExact !== undefined) {
      conflicts.push(conflict('INSTALL_PATH_CONFLICT', path, `${path} is owned by ${otherExact.owner}`, {
        owner: otherExact.owner,
        receipt: otherExact.receipt,
      }));
      continue;
    }
    const otherFolded = otherByFold.get(foldCase(path));
    if (otherFolded !== undefined) {
      conflicts.push(conflict('PATH_CASE_COLLISION', path, `${path} folds to ${otherFolded.path}, owned by ${otherFolded.owner}`, {
        owner: otherFolded.owner,
        receipt: otherFolded.receipt,
      }));
      continue;
    }

    const symlink = symlinkComponent(projectRoot, path);
    if (symlink !== null) {
      conflicts.push(conflict('SYMLINK_AT_TARGET', path, `${symlink} is a symbolic link; refusing to follow it`));
      continue;
    }

    const absolute = projectPath(projectRoot, path);
    const info = lstatOrNull(absolute);
    if (info !== null && !info.isFile()) {
      conflicts.push(conflict('PATH_TYPE_CONFLICT', path, `${path} exists and is not a regular file`));
      continue;
    }

    const diskSha = info === null ? null : sha256File(absolute);
    const own = previousByPath.get(path) ?? null;

    if (info === null) {
      decisions.push({ path, action: 'create', backup: false });
      continue;
    }
    if (entry.overwrite === 'fail-if-exists') {
      conflicts.push(conflict('PATH_EXISTS', path, `${path} exists and the install plan says fail-if-exists`));
      continue;
    }
    if (own !== null) {
      if (own.sha256 === entry.sha256 && diskSha === entry.sha256) {
        decisions.push({ path, action: 'keep', backup: false });
      } else if (diskSha === own.sha256) {
        decisions.push({ path, action: 'replace', backup: true });
      } else if (force) {
        decisions.push({ path, action: 'replace', backup: true });
      } else {
        conflicts.push(conflict('MODIFIED_OWNED_FILE', path, `${path} was modified after install; --force replaces it`, {
          expected: own.sha256,
          actual: diskSha,
        }));
      }
      continue;
    }
    if (diskSha === entry.sha256) {
      decisions.push({ path, action: 'adopt', backup: false });
    } else if (force) {
      decisions.push({ path, action: 'replace', backup: true });
    } else {
      conflicts.push(conflict('UNOWNED_PATH', path, `${path} exists with different content; --force replaces it`, {
        actual: diskSha,
      }));
    }
  }

  // Paths the previous receipt owned that this result no longer ships.
  const incomingPaths = new Set(incoming.map((entry) => entry.path));
  for (const file of previousFiles) {
    if (incomingPaths.has(file.path)) continue;
    const absolute = projectPath(projectRoot, file.path);
    const info = absolute === null ? null : lstatOrNull(absolute);
    if (info === null) {
      stale.push({ path: file.path, action: 'delete', backup: false });
      continue;
    }
    const diskSha = info.isFile() ? sha256File(absolute) : null;
    if (diskSha === file.sha256) {
      stale.push({ path: file.path, action: 'delete', backup: true });
    } else {
      warnings.push({
        code: 'STALE_MODIFIED_KEPT',
        path: file.path,
        message: `${file.path} is no longer part of the install but was modified; it is kept`,
      });
    }
  }
  // Previous paths that changed only by case would silently shadow on Windows.
  for (const entry of incomingSorted) {
    const folded = previousFolded.get(foldCase(entry.path));
    if (folded !== undefined && folded !== entry.path) {
      conflicts.push(conflict('PATH_CASE_COLLISION', entry.path, `${entry.path} folds to the previously owned ${folded}`));
    }
  }

  conflicts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : left.code < right.code ? -1 : 1));
  return { conflicts, decisions, stale, warnings };
}
