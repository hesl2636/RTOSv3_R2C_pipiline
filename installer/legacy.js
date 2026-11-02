/**
 * Legacy `r2c.install/v1` takeover (spec §12, #76 §9).
 *
 * The legacy channel and the bundle channel have different file semantics
 * (role names, YAML/frontmatter, `{{submit}}`), so migration is delete-then-
 * install, never incremental: verify every recorded hash, back up every path
 * the transaction touches, revoke merged pointers one by one, delete the old
 * layout, retire the receipts under `.r2c/install/legacy/*.retired` and write
 * the new install in the same journal. Any failure rolls the whole thing back.
 *
 * User-scope receipts live outside the project and are reported as manual
 * steps only — this module never writes outside the project.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { comparePaths } from '../core/paths.js';
import { LEGACY_DIR, LEGACY_RECEIPT_SCHEMA, isInstallPath, isInsideProject, projectPath, toPosix } from './paths.js';
import { scanLegacyInstallDir } from './receipt.js';
import {
  ensureAbsoluteDir,
  lstatOrNull,
  readJsonFile,
  sha256File,
  unlinkIfExists,
  writeAbsoluteAtomic,
  writeFileAtomic,
} from './util.js';

export const LEGACY_RETIRE_SUFFIX = '.retired';

function pointerGet(object, pointer) {
  if (pointer === null) return object;
  let node = object;
  for (const key of pointer.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function pointerDelete(object, pointer) {
  const keys = pointer.split('.');
  let node = object;
  const trail = [];
  for (const key of keys.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return false;
    trail.push([node, key]);
    node = node[key];
  }
  const leaf = keys[keys.length - 1];
  if (node === null || typeof node !== 'object' || !(leaf in node)) return false;
  delete node[leaf];
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const [parent, key] = trail[index];
    const child = parent[key];
    if (child !== null && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
}

function pointerSet(object, pointer, value) {
  const keys = pointer.split('.');
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
  return object;
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/** Project-relative POSIX path for a recorded legacy path, or `null`. */
function normalizeRecordedPath(projectRoot, recorded) {
  if (typeof recorded !== 'string' || recorded === '') return null;
  let rel;
  if (isAbsolute(recorded)) {
    if (!isInsideProject(projectRoot, recorded)) return null;
    rel = toPosix(relative(projectRoot, resolve(recorded)));
  } else {
    rel = toPosix(recorded).replace(/^\.\//, '');
  }
  if (!isInstallPath(rel)) return null;
  return projectPath(projectRoot, rel) === null ? null : rel;
}

function legacyJsonFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort(compareCodePoints);
  } catch {
    return [];
  }
}

/**
 * Find what the legacy channel left behind.
 *
 * `project`      — project-scope `r2c.install/v1` receipts (`.r2c/install/*.json`).
 * `unsupported`  — install-receipt-shaped files with another `r2c.install/*` schema.
 * `user`         — user-scope receipts (`<userHome>/.r2c/install/*.json`), read-only.
 */
export function detectLegacyInstall({ projectRoot, userHome = homedir(), scanUser = true }) {
  const project = scanLegacyInstallDir(projectRoot);
  const known = new Set(project.map((item) => item.path));
  const unsupported = [];
  for (const name of legacyJsonFiles(join(projectRoot, ...'.r2c/install'.split('/')))) {
    const rel = `.r2c/install/${name}`;
    if (known.has(rel)) continue;
    const read = readJsonFile(join(projectRoot, ...rel.split('/')));
    if (!read.ok || typeof read.value?.schema !== 'string') continue;
    if (!read.value.schema.startsWith('r2c.install/')) continue;
    if (read.value.schema === LEGACY_RECEIPT_SCHEMA) continue;
    unsupported.push({ path: rel, schema: read.value.schema });
  }
  const user = [];
  if (scanUser) {
    const userDir = join(userHome, '.r2c', 'install');
    for (const name of legacyJsonFiles(userDir)) {
      const absolute = join(userDir, name);
      const read = readJsonFile(absolute);
      if (read.ok && read.value?.schema === LEGACY_RECEIPT_SCHEMA) user.push({ path: absolute, receipt: read.value });
    }
  }
  return { project, unsupported, user };
}

function manualStepsForUser({ project, user }) {
  const steps = [];
  for (const item of user) {
    steps.push(`user-scope legacy receipt ${item.path} is not touched; remove it with \`r2c adapter uninstall ${item.receipt.adapter ?? basename(item.path, '.json')}\` from the legacy engine`);
  }
  const mentionsDsh = project.some((item) => item.receipt?.adapter === 'dsh'
    || (item.receipt?.files ?? []).some((file) => String(file.path).includes('.dsh/')));
  if (mentionsDsh) {
    steps.push('remove the legacy rows this install merged into $DSH_HOME/profiles/<profile>/cordis.patch.yml by hand; the installer never writes a user profile');
  }
  return steps;
}

/**
 * Read-only migration plan.
 *
 * Returns `{conflicts, deletions, merged, receipts, manualLeftovers, ownedPaths}`.
 * `conflicts` lists `LEGACY_HASH_MISMATCH` entries; `--force` backs them up and
 * continues, anything else aborts the takeover.
 */
export function planLegacyMigration({ projectRoot, legacy }) {
  const conflicts = [];
  const deletions = [];
  const merged = [];
  const receipts = [];
  const manualLeftovers = [];
  const ownedPaths = new Set();
  const dirs = new Set();
  const payloadHomes = new Set();

  const manual = (message) => {
    if (!manualLeftovers.includes(message)) manualLeftovers.push(message);
  };

  for (const item of legacy.project) {
    const receipt = item.receipt ?? {};
    const agent = typeof receipt.adapter === 'string' && receipt.adapter !== ''
      ? receipt.adapter
      : basename(item.path, '.json');
    const retired = `${LEGACY_DIR}/${agent}.json${LEGACY_RETIRE_SUFFIX}`;
    receipts.push({ agent, from: item.path, to: retired });

    for (const entry of receipt.files ?? []) {
      const rel = normalizeRecordedPath(projectRoot, entry?.path);
      if (rel === null) {
        manual(`legacy receipt ${item.path} lists ${String(entry?.path)} outside the project; it is not touched`);
        continue;
      }
      const absolute = projectPath(projectRoot, rel);
      const info = lstatOrNull(absolute);
      if (info === null) continue;
      ownedPaths.add(rel);
      if (entry.kind === 'link' || info.isSymbolicLink()) {
        if (!info.isSymbolicLink()) {
          conflicts.push({
            code: 'LEGACY_HASH_MISMATCH',
            path: rel,
            message: `${rel} is recorded as a link but is not one`,
          });
          continue;
        }
        deletions.push({ path: rel, kind: 'link' });
        continue;
      }
      if (!info.isFile()) {
        conflicts.push({
          code: 'LEGACY_HASH_MISMATCH',
          path: rel,
          message: `${rel} is recorded as a file but is not a regular file`,
        });
        continue;
      }
      const actual = sha256File(absolute);
      if (typeof entry.sha256 === 'string' && actual !== entry.sha256) {
        conflicts.push({
          code: 'LEGACY_HASH_MISMATCH',
          path: rel,
          message: `${rel} was modified after the legacy install (recorded ${entry.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…)`,
          expected: entry.sha256,
          actual,
        });
        // `--force` backs it up and continues; without it the whole takeover
        // is refused before anything is written.
        deletions.push({ path: rel, kind: entry.kind ?? 'layout', modified: true });
        continue;
      }
      deletions.push({ path: rel, kind: entry.kind ?? 'layout' });
    }

    const created = new Set((receipt.merged_files_created ?? []).map((file) => toPosix(String(file))));
    for (const entry of receipt.merged ?? []) {
      const rel = normalizeRecordedPath(projectRoot, entry?.file);
      if (rel === null) {
        manual(`legacy receipt ${item.path} merged into ${String(entry?.file)} outside the project; that pointer is not touched`);
        continue;
      }
      const absolute = projectPath(projectRoot, rel);
      const isCreated = created.has(absolute) || created.has(toPosix(String(entry.file)));
      merged.push({
        file: rel,
        pointer: entry.pointer ?? null,
        value: entry.value,
        added: entry.added,
        created: isCreated,
      });
    }

    for (const dir of receipt.dirs_created ?? []) {
      const rel = normalizeRecordedPath(projectRoot, dir);
      if (rel === null) continue;
      ownedPaths.add(rel);
      dirs.add(rel);
    }

    const payloadHome = normalizeRecordedPath(projectRoot, receipt.payload_home);
    if (payloadHome !== null && payloadHome.startsWith('.r2c/payload/')) payloadHomes.add(payloadHome);
  }

  for (const step of manualStepsForUser({ project: legacy.project, user: legacy.user })) manual(step);

  return {
    conflicts: conflicts.sort((left, right) => comparePaths(left.path, right.path)),
    deletions: deletions.sort((left, right) => comparePaths(left.path, right.path)),
    merged,
    receipts: receipts.sort((left, right) => compareCodePoints(left.from, right.from)),
    manualLeftovers,
    ownedPaths,
    dirs: [...dirs].sort((left, right) => {
      const byDepth = right.split('/').length - left.split('/').length;
      return byDepth !== 0 ? byDepth : comparePaths(left, right);
    }),
    payloadHomes: [...payloadHomes].sort(comparePaths),
  };
}

/**
 * Journal operations for a takeover. `incomingPaths` are written by the new
 * install instead of being deleted, so they never appear as legacy deletions.
 */
export function legacyJournalOperations(plan, incomingPaths) {
  const operations = [];
  const mergedSeen = new Set();
  for (const entry of plan.merged) {
    if (mergedSeen.has(entry.file)) continue;
    mergedSeen.add(entry.file);
    if (lstatOrNull === null) continue;
    operations.push({ op: 'replace', path: entry.file, backup: true });
  }
  for (const entry of plan.deletions) {
    if (incomingPaths.has(entry.path)) continue;
    operations.push({ op: 'delete', path: entry.path, backup: true });
  }
  for (const item of plan.receipts) {
    operations.push({ op: 'create', path: item.to });
    operations.push({ op: 'delete', path: item.from, backup: true });
  }
  return operations;
}

/** Remove every merged pointer that still carries the recorded value. */
export function revokeMergedPointers({ projectRoot, merged, force = false }) {
  const leftovers = [];
  const written = [];
  const removed = [];
  const byFile = new Map();
  for (const entry of merged) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(entry);
  }
  for (const [file, entries] of byFile) {
    const absolute = projectPath(projectRoot, file);
    if (absolute === null) {
      leftovers.push({ file, pointer: null, reason: 'path-escape' });
      continue;
    }
    if (!existsSync(absolute)) continue;
    let document;
    try {
      document = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch {
      leftovers.push({ file, pointer: null, reason: 'invalid-json' });
      continue;
    }
    let changed = false;
    for (const entry of entries) {
      if (typeof entry.pointer !== 'string' || entry.pointer === '') {
        leftovers.push({ file, pointer: entry.pointer ?? null, reason: 'root-pointer' });
        continue;
      }
      const current = pointerGet(document, entry.pointer);
      if (Array.isArray(current) && Array.isArray(entry.added)) {
        const remaining = current.filter((item) => !entry.added.some((added) => sameValue(added, item)));
        if (remaining.length === current.length) {
          if (!force) {
            leftovers.push({ file, pointer: entry.pointer, reason: 'modified' });
            continue;
          }
          if (pointerDelete(document, entry.pointer)) changed = true;
        } else if (remaining.length === 0) {
          if (pointerDelete(document, entry.pointer)) changed = true;
        } else {
          pointerSet(document, entry.pointer, remaining);
          changed = true;
        }
        continue;
      }
      if (sameValue(current, entry.value) || force) {
        if (pointerDelete(document, entry.pointer)) changed = true;
      } else {
        leftovers.push({ file, pointer: entry.pointer, reason: 'modified' });
      }
    }
    if (!changed) continue;
    if (Object.keys(document).length === 0 && entries.some((entry) => entry.created)) {
      unlinkSync(absolute);
      removed.push(file);
      continue;
    }
    writeFileAtomic(absolute, `${JSON.stringify(document, null, 2)}\n`);
    written.push(file);
  }
  return { written, removed, leftovers };
}

/** Delete the legacy layout files and links recorded by the receipts. */
export function applyLegacyDeletions({ projectRoot, plan, skip = new Set() }) {
  const deleted = [];
  for (const entry of plan.deletions) {
    if (skip.has(entry.path)) continue;
    const absolute = projectPath(projectRoot, entry.path);
    if (absolute === null) continue;
    if (unlinkIfExists(absolute)) deleted.push(entry.path);
  }
  return deleted;
}

/** Copy each receipt to `.r2c/install/legacy/<agent>.json.retired`, then remove the original. */
export function retireLegacyReceipts({ projectRoot, plan }) {
  const retired = [];
  for (const item of plan.receipts) {
    const from = projectPath(projectRoot, item.from);
    const to = projectPath(projectRoot, item.to);
    if (from === null || to === null) continue;
    if (!existsSync(from)) continue;
    ensureAbsoluteDir(dirname(to));
    writeAbsoluteAtomic(to, readFileSync(from));
    unlinkIfExists(from);
    retired.push({ from: item.from, to: item.to });
  }
  return retired;
}
