/**
 * Receipt-driven uninstall.
 *
 * Only files the receipt owns are deleted; foreign tool state, edited files
 * and agent-managed residues are reported in `leftover[]` instead. Merged JSON
 * entries are removed one pointer at a time, never by rewriting the foreign
 * parts of the file. Runtime state under `.r2c` survives unless `--purge-state`
 * is explicit.
 */
import { existsSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EXIT_CODES, R2cError } from '../errors.js';
import { withLock } from '../lock.js';
import { installLockPath, installDir, receiptPath, stateDir } from './state.js';
import { pointerGet, pointerSet } from './pointer.js';
import { runAdapterStep, stepsFile } from './steps.js';
import {
  atomicWriteJson,
  isFile,
  isLink,
  liveReceipt,
  readJsonIfExists,
  receiptEntryPath,
  removePath,
  sha256File,
} from './util.js';
import { engineReferenced, isEngineHome, payloadReferenced, removeVersionSet } from './versions.js';

function uninstallError(code, message, details = null, exitCode = EXIT_CODES.USAGE) {
  return new R2cError(code, message, details, exitCode);
}

function chooseScope(projectRoot, options) {
  if (options.scope) return options.scope;
  if (readJsonIfExists(receiptPath(stateDir('project', projectRoot), options.agentId)) !== null) {
    return 'project';
  }
  if (readJsonIfExists(receiptPath(stateDir('user', projectRoot), options.agentId)) !== null) {
    return 'user';
  }
  return 'project';
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
  // Drop containers this removal emptied, so a file created only for the merge
  // becomes empty and can be deleted with it.
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

function planUninstall({ receipt, force, projectRoot }) {
  const recordedRoot = receipt.project_root ?? null;
  const deletions = [];
  const leftovers = [];
  for (const entry of receipt.files ?? []) {
    const path = receiptEntryPath(entry, { projectRoot, recordedRoot });
    if (!existsSync(path)) continue;
    if (entry.kind === 'link') {
      if (isLink(path)) {
        deletions.push({ path, kind: 'link' });
      } else if (force) {
        deletions.push({ path, kind: 'link' });
      } else {
        leftovers.push(`modified:${path}`);
      }
      continue;
    }
    if (!isFile(path)) {
      if (force) deletions.push({ path, kind: entry.kind });
      else leftovers.push(`modified:${path}`);
      continue;
    }
    if (sha256File(path) === entry.sha256) {
      deletions.push({ path, kind: entry.kind });
    } else if (force) {
      deletions.push({ path, kind: entry.kind });
    } else {
      leftovers.push(`modified:${path}`);
    }
  }
  return { deletions, leftovers };
}

function applyMergedRemovals(receipt, force, leftovers) {
  const touched = [];
  const byFile = new Map();
  for (const entry of receipt.merged ?? []) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(entry);
  }
  for (const [file, entries] of byFile) {
    if (!existsSync(file)) continue;
    let document;
    try {
      document = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      leftovers.push(`modified:${file}`);
      continue;
    }
    let changed = false;
    for (const entry of entries) {
      const current = pointerGet(document, entry.pointer);
      if (Array.isArray(current) && Array.isArray(entry.added)) {
        const remaining = current.filter((item) => !entry.added.some((added) => isDeepStrictEqual(added, item)));
        if (remaining.length === current.length) {
          if (force) {
            if (pointerDelete(document, entry.pointer)) changed = true;
          } else {
            leftovers.push(`modified:${file}#${entry.pointer}`);
          }
        } else if (remaining.length === 0) {
          if (pointerDelete(document, entry.pointer)) changed = true;
        } else {
          pointerSet(document, entry.pointer, remaining);
          changed = true;
        }
        continue;
      }
      if (isDeepStrictEqual(current, entry.value) || force) {
        if (pointerDelete(document, entry.pointer)) changed = true;
      } else {
        leftovers.push(`modified:${file}#${entry.pointer}`);
      }
    }
    if (!changed) continue;
    if (Object.keys(document).length === 0 && (receipt.merged_files_created ?? []).includes(file)) {
      unlinkSync(file);
      touched.push({ path: file, kind: 'merge-json' });
      continue;
    }
    atomicWriteJson(file, document);
    touched.push({ path: file, kind: 'merge-json' });
  }
  return touched;
}

function purgeRuntimeState(state) {
  for (const name of ['runs', 'usage', 'payload']) {
    removePath(join(state, name));
  }
  removePath(join(state, 'latest.json'));
}

export async function uninstallAdapter({ ctx, agentId, options }) {
  const scope = chooseScope(ctx.projectRoot, { ...options, agentId });
  const state = stateDir(scope, ctx.projectRoot);
  const receiptFile = receiptPath(state, agentId);
  const receipt = readJsonIfExists(receiptFile);
  if (receipt === null) {
    throw uninstallError(
      'NOT_INSTALLED',
      `adapter ${agentId} is not installed (${scope} scope)`,
      { adapter: agentId, scope, receipt: receiptFile },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }
  if (options.dryRun) {
    return {
      command: 'adapter.uninstall',
      data: await buildReport({
        receipt: liveReceipt(receipt, ctx.projectRoot),
        scope,
        dryRun: true,
        options,
        state,
        projectRoot: ctx.projectRoot,
      }),
    };
  }
  return withLock(installLockPath(state), async () => {
    const fresh = readJsonIfExists(receiptFile);
    if (fresh === null) {
      throw uninstallError('NOT_INSTALLED', `adapter ${agentId} is not installed`, {
        adapter: agentId,
        scope,
      }, EXIT_CODES.NO_ACTIVE_RUN);
    }
    const data = await buildReport({
      receipt: liveReceipt(fresh, ctx.projectRoot),
      scope,
      dryRun: false,
      options,
      state,
      projectRoot: ctx.projectRoot,
    });
    unlinkSync(receiptFile);
    if (options.purgeState) {
      purgeRuntimeState(state);
      removePath(installDir(state));
    }
    return { command: 'adapter.uninstall', data };
  });
}

async function buildReport({ receipt, scope, dryRun, options, state, projectRoot }) {
  const warnings = [];
  const leftovers = [];
  // `receipt` is already the live view (see `liveReceipt`): payload home,
  // engine home and merged files point at the project as it is now.
  const payloadHome = receipt.payload_home ?? null;
  const engineHome = receipt.engine?.home ?? null;

  if (!dryRun) {
    const file = payloadHome ? stepsFile(null, receipt.adapter, payloadHome) : null;
    if (file !== null) {
      const outcome = await runAdapterStep(file, 'pre-uninstall', {
        adapter: receipt.adapter,
        scope,
        projectRoot,
        payloadHome,
        runnerCmd: receipt.runner_cmd ?? null,
        version: receipt.payload?.version ?? null,
        profile: receipt.steps?.profile?.name ?? null,
        receipt,
      });
      warnings.push(...(outcome?.warnings ?? []));
      leftovers.push(...(outcome?.leftover ?? []));
    } else if (receipt.steps !== null && receipt.steps !== undefined && receipt.steps_file) {
      warnings.push(`steps-missing:${receipt.steps_file}`);
    }
  }

  const { deletions, leftovers: modified } = planUninstall({
    receipt,
    force: options.force === true,
    projectRoot,
  });
  leftovers.push(...modified);

  const sharedWith = payloadHome
    ? payloadReferenced(payloadHome, projectRoot, { state, adapter: receipt.adapter })
    : null;
  if (sharedWith !== null) warnings.push(`payload-shared:${payloadHome} still used by ${sharedWith}`);

  const payloadRemoved = Boolean(payloadHome) && sharedWith === null;
  const engineVersion = receipt.engine?.version ?? null;
  const engineSharedWith = engineHome === null
    ? null
    : engineReferenced(engineHome, projectRoot, { state, adapter: receipt.adapter });
  if (engineSharedWith !== null) warnings.push(`engine-shared:${engineHome} still used by ${engineSharedWith}`);
  const engineRemoved = engineSharedWith === null && isEngineHome(engineHome, engineVersion);
  const files = deletions.map((entry) => ({ path: entry.path, kind: entry.kind }));

  // Applying removals in a dry run would mutate the world; report the plan only.
  if (!dryRun && state !== undefined) {
    for (const deletion of deletions) removePath(deletion.path);
    const touched = applyMergedRemovals(receipt, options.force === true, leftovers);
    files.push(...touched);

    if (payloadRemoved) removePath(payloadHome);
    if (engineRemoved) {
      const outcome = removeVersionSet([{ path: engineHome, kind: 'engine' }]);
      for (const failure of outcome.failed) {
        warnings.push(`cleanup-failed:${failure.path}: ${failure.error}`);
      }
    }
    for (const dir of [...(receipt.dirs_created ?? [])].sort((left, right) => right.length - left.length)) {
      try {
        rmdirSync(dir);
      } catch {
        // not empty
      }
    }
  }

  for (const step of receipt.manual ?? []) leftovers.push(`manual:${step}`);

  return {
    adapter: receipt.adapter,
    scope,
    action: dryRun ? 'remove' : 'removed',
    changed: true,
    dry_run: dryRun,
    payload_home: payloadHome,
    payload_removed: payloadRemoved && !dryRun,
    payload_shared_with: sharedWith,
    engine_home: engineHome,
    engine_removed: engineRemoved && !dryRun,
    engine_shared_with: engineSharedWith,
    files,
    skipped: [],
    warnings,
    manual: [],
    leftover: leftovers,
  };
}
