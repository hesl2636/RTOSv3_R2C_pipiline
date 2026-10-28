/**
 * Receipt-driven uninstall.
 *
 * Only files the receipt owns are deleted; foreign tool state, edited files
 * and agent-managed residues are reported in `leftover[]` instead. Merged JSON
 * entries are removed one pointer at a time, never by rewriting the foreign
 * parts of the file. Runtime state under `.r2c` survives unless `--purge-state`
 * is explicit.
 */
import { existsSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EXIT_CODES, R2cError } from '../errors.js';
import { withLock } from '../lock.js';
import { installLockPath, installDir, receiptPath, stateDir } from './state.js';
import {
  atomicWriteJson,
  isFile,
  isLink,
  readJsonIfExists,
  removePath,
  sha256File,
} from './util.js';

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

function pointerGet(object, pointer) {
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
  for (const key of keys.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return false;
    node = node[key];
  }
  const leaf = keys[keys.length - 1];
  if (node === null || typeof node !== 'object' || !(leaf in node)) return false;
  delete node[leaf];
  return true;
}

function readReceipts(state) {
  const dir = installDir(state);
  if (!existsSync(dir)) return [];
  const receipts = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.pending.json')) continue;
    try {
      receipts.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    } catch {
      // A corrupt receipt is doctor's problem, not prune's.
    }
  }
  return receipts;
}

function payloadReferenced(home, projectRoot, excludeAgent, excludeState) {
  for (const state of [stateDir('project', projectRoot), stateDir('user', projectRoot)]) {
    for (const receipt of readReceipts(state)) {
      if (receipt.adapter === excludeAgent && state === excludeState) continue;
      if (receipt.payload_home === home) return receipt.adapter;
    }
  }
  return null;
}

function planUninstall({ receipt, force }) {
  const deletions = [];
  const leftovers = [];
  for (const file of receipt.files ?? []) {
    if (!existsSync(file.path)) continue;
    if (file.kind === 'link') {
      if (isLink(file.path)) {
        deletions.push({ path: file.path, kind: 'link' });
      } else if (force) {
        deletions.push({ path: file.path, kind: 'link' });
      } else {
        leftovers.push(`modified:${file.path}`);
      }
      continue;
    }
    if (!isFile(file.path)) {
      if (force) deletions.push({ path: file.path, kind: file.kind });
      else leftovers.push(`modified:${file.path}`);
      continue;
    }
    if (sha256File(file.path) === file.sha256) {
      deletions.push({ path: file.path, kind: file.kind });
    } else if (force) {
      deletions.push({ path: file.path, kind: file.kind });
    } else {
      leftovers.push(`modified:${file.path}`);
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
  for (const name of ['runs', 'usage', 'plugin']) {
    removePath(join(state, name));
  }
  removePath(join(state, 'latest.json'));
}

export function uninstallAdapter({ ctx, agentId, options }) {
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
      data: buildReport({
        receipt,
        scope,
        dryRun: true,
        options,
        state,
        projectRoot: ctx.projectRoot,
      }),
    };
  }
  return withLock(installLockPath(state), () => {
    const fresh = readJsonIfExists(receiptFile);
    if (fresh === null) {
      throw uninstallError('NOT_INSTALLED', `adapter ${agentId} is not installed`, {
        adapter: agentId,
        scope,
      }, EXIT_CODES.NO_ACTIVE_RUN);
    }
    const data = buildReport({ receipt: fresh, scope, dryRun: false, options, state, projectRoot: ctx.projectRoot });
    unlinkSync(receiptFile);
    if (options.purgeState) {
      purgeRuntimeState(state);
      removePath(installDir(state));
    }
    return { command: 'adapter.uninstall', data };
  });
}

function buildReport({ receipt, scope, dryRun, options, state, projectRoot }) {
  const warnings = [];
  const leftovers = [];
  const { deletions, leftovers: modified } = planUninstall({ receipt, force: options.force === true });
  leftovers.push(...modified);

  const sharedWith = receipt.payload_home
    ? payloadReferenced(receipt.payload_home, projectRoot, receipt.adapter, state)
    : null;
  if (sharedWith !== null) warnings.push(`payload-shared:${receipt.payload_home} still used by ${sharedWith}`);

  const payloadRemoved = Boolean(receipt.payload_home) && sharedWith === null;
  const files = deletions.map((entry) => ({ path: entry.path, kind: entry.kind }));

  // Applying removals in a dry run would mutate the world; report the plan only.
  if (!dryRun && state !== undefined) {
    for (const deletion of deletions) removePath(deletion.path);
    const touched = applyMergedRemovals(receipt, options.force === true, leftovers);
    files.push(...touched);

    if (payloadRemoved) removePath(receipt.payload_home);
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
    payload_home: receipt.payload_home,
    payload_removed: payloadRemoved && !dryRun,
    payload_shared_with: sharedWith,
    files,
    skipped: [],
    warnings,
    manual: [],
    leftover: leftovers,
  };
}
