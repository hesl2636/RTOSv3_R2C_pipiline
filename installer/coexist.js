/**
 * Multi-bundle coexistence rules (spec §12, #76 §4).
 *
 * Two agent-native identities coexist because `<ns>` keeps their paths apart;
 * runner has no bundle dimension at all (`workflows/`, `tasks/`, `skills/`,
 * `roles/` and `constitution/` use bare ids), so an install root holds at most
 * one runner bundle. These checks run read-only before the conflict matrix and
 * before the lock, so a refused install never writes.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { foldCase } from '../core/paths.js';
import { compareCodePoints } from '../core/code-point.js';
import { projectPath } from './paths.js';
import { lstatOrNull, sha256File } from './util.js';

export const COEXIST_CODES = Object.freeze(['RUNNER_ROOT_OCCUPIED', 'DUPLICATE_BACKEND']);

/** `workflows/` is the runner occupancy marker (#76 §4.2). */
export const RUNNER_WORKFLOW_DIR = 'workflows';

function ownerIdentity(receipt) {
  return {
    projection: receipt?.projection?.id ?? null,
    bundle: receipt?.bundle?.id ?? null,
    receipt: null,
  };
}

/** `RUNNER_ROOT_OCCUPIED`: `occupied` stays a path list (status/doctor friendly). */
function occupied(paths, occupier, message) {
  return {
    code: 'RUNNER_ROOT_OCCUPIED',
    message,
    occupied: [...paths],
    occupier,
    hint: 'uninstall the other runner bundle, install it into another project, or wait for a namespaced runner projection',
  };
}

/** Every `workflows/*.yaml` currently on disk, project-relative. */
function workflowFiles(projectRoot) {
  const dir = projectPath(projectRoot, RUNNER_WORKFLOW_DIR);
  if (dir === null) return [];
  const info = lstatOrNull(dir);
  if (info === null || !info.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => `${RUNNER_WORKFLOW_DIR}/${entry.name}`)
    .sort(compareCodePoints);
}

/**
 * Refuse a second runner bundle in one project.
 *
 * `previous` is this identity's own receipt, `others` every other receipt.
 * `takeoverPaths` are legacy files the migration will remove, so they cannot
 * occupy the root. Unowned but byte-identical workflow files are adoptable;
 * everything else is `RUNNER_ROOT_OCCUPIED` — `--force` never crosses this.
 */
export function checkRunnerRoot({ projectRoot, projectionId, bundleId, incoming, previous = null, others = [], takeoverPaths = new Set() }) {
  if (projectionId !== 'runner') return null;

  const foreign = others.find((item) => item.receipt?.projection?.id === 'runner'
    && item.receipt?.bundle?.id !== bundleId);
  if (foreign !== undefined) {
    const paths = (foreign.receipt?.files ?? [])
      .map((file) => file.path)
      .filter((path) => /^workflows\/.*\.ya?ml$/i.test(path))
      .sort(compareCodePoints);
    return occupied(
      paths.length > 0 ? paths : [foreign.path],
      { ...ownerIdentity(foreign.receipt), receipt: foreign.path, reason: 'OTHER_IDENTITY' },
      `the runner root is occupied by bundle ${foreign.receipt?.bundle?.id ?? '?'}`,
    );
  }

  const incomingByPath = new Map(incoming.map((entry) => [entry.path, entry]));
  const ownPaths = new Map((previous?.receipt?.files ?? []).map((file) => [foldCase(file.path), file]));
  const ownedByOthers = new Map();
  for (const item of others) {
    for (const file of item.receipt?.files ?? []) {
      ownedByOthers.set(foldCase(file.path), { ...ownerIdentity(item.receipt), receipt: item.path });
    }
  }

  for (const path of workflowFiles(projectRoot)) {
    if (takeoverPaths.has(path)) continue;
    const own = ownPaths.get(foldCase(path));
    if (own !== undefined && foldCase(own.path) === foldCase(path)) continue;
    const foreign = ownedByOthers.get(foldCase(path));
    if (foreign !== undefined) {
      return occupied(
        [path],
        { ...foreign, reason: 'OTHER_IDENTITY' },
        `${path} is owned by ${foreign.projection}/${foreign.bundle}`,
      );
    }
    const entry = incomingByPath.get(path);
    if (entry === undefined) {
      return occupied(
        [path],
        { projection: null, bundle: null, receipt: null, reason: 'UNOWNED_DIFFERENT' },
        `${path} exists without a receipt; the runner root is already in use`,
      );
    }
    const absolute = projectPath(projectRoot, path);
    let digest = null;
    try {
      digest = absolute === null ? null : sha256File(absolute);
    } catch {
      // A concurrent writer removed/replaced the file between readdir and
      // hash; the under-lock re-check is authoritative.
      continue;
    }
    if (absolute === null || digest !== entry.sha256) {
      return occupied(
        [path],
        { projection: null, bundle: null, receipt: null, reason: 'UNOWNED_DIFFERENT' },
        `${path} exists with different bytes; --force never crosses the runner root`,
      );
    }
    // Byte-identical: the conflict matrix records it as an adopt.
  }
  return null;
}

/**
 * `DUPLICATE_BACKEND`: the same bundle id installed through both projections.
 * Allowed, never silent: each identity keeps its own files and its own receipt.
 */
export function duplicateBackendWarnings({ projectionId, bundleId, others }) {
  return others
    .filter((item) => item.receipt?.bundle?.id === bundleId
      && item.receipt?.projection?.id !== projectionId)
    .map((item) => ({
      code: 'DUPLICATE_BACKEND',
      target: item.receipt.projection.id,
      pointer: item.path,
      message: `bundle ${bundleId} is also installed as ${item.receipt.projection.id}; both projections keep their own files`,
    }));
}
