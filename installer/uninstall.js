/**
 * Uninstall one install identity (#76 §6.5).
 *
 * The receipt is the only plan: delete exactly the recorded paths whose disk
 * hash still equals the receipt hash. Modified paths stay on disk and are
 * reported as leftovers (non-zero exit at the CLI); `--force` backs them up
 * first. Empty directories are pruned bottom-up and shared roots are never
 * removed.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { comparePaths } from '../core/paths.js';
import {
  isInstallPath,
  pruneCandidates,
  projectPath,
  receiptPath as receiptRelPath,
} from './paths.js';
import { readReceipt, readReceipts, scanLegacyInstallDir } from './receipt.js';
import {
  acquireProjectLock,
  prepareJournal,
  releaseProjectLock,
  removeJournal,
  rollbackJournal,
  recoverPending,
  writeJournal,
} from './transaction.js';
import {
  lstatOrNull,
  pruneEmptyDir,
  sha256File,
  symlinkComponent,
  unlinkIfExists,
} from './util.js';

function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

function timestampSlug(clock) {
  return clock().toISOString().replace(/[:.]/g, '-');
}

function sharedIrWarnings(receipt, shared) {
  if (!shared) return [];
  return [{
    code: 'IR_SHARED',
    path: receipt.ir?.path ?? '',
    message: 'the IR copy is still referenced by another receipt and is kept',
  }];
}

function irStillReferenced(receipts, receiptPath, irPath) {
  return receipts.some((item) => item.path !== receiptPath
    && item.receipt?.ir?.path === irPath);
}

/**
 * Read-only plan: which receipt paths would be deleted, kept or skipped.
 * Every path is recorded with its reason so callers need no second pass.
 */
export function planUninstall({ projectRoot, receipt, force = false }) {
  const deletions = [];
  const leftovers = [];
  const warnings = [];

  for (const file of receipt.files ?? []) {
    const path = file.path;
    if (!isInstallPath(path) || projectPath(projectRoot, path) === null) {
      leftovers.push({ path: String(path), reason: 'path-escape' });
      continue;
    }
    const absolute = projectPath(projectRoot, path);
    const info = lstatOrNull(absolute);
    if (info === null) continue;
    if (info.isSymbolicLink()) {
      if (force) deletions.push({ path, backup: true });
      else leftovers.push({ path, reason: 'symlink' });
      continue;
    }
    if (!info.isFile()) {
      leftovers.push({ path, reason: 'not-a-file' });
      continue;
    }
    if (sha256File(absolute) === file.sha256) {
      deletions.push({ path, backup: true });
    } else if (force) {
      deletions.push({ path, backup: true, forced: true });
    } else {
      leftovers.push({ path, reason: 'modified' });
    }
  }

  const irPath = receipt.ir?.path;
  if (typeof irPath === 'string' && isInstallPath(irPath)) {
    const absolute = projectPath(projectRoot, irPath);
    const info = absolute === null ? null : lstatOrNull(absolute);
    if (info !== null && info.isFile()) {
      if (sha256File(absolute) === receipt.ir.digest) deletions.push({ path: irPath, backup: true, ir: true, irRemoved: true });
      else if (force) deletions.push({ path: irPath, backup: true, forced: true, ir: true, irRemoved: true });
      else leftovers.push({ path: irPath, reason: 'ir-modified' });
    }
  }

  for (const deletion of deletions) {
    if (deletion.forced) warnings.push({ code: 'FORCED_DELETE', path: deletion.path, message: `${deletion.path} was modified; --force backed it up and deleted it` });
  }
  return {
    deletions,
    leftovers: leftovers.sort((left, right) => comparePaths(left.path, right.path)),
    warnings,
    irRemoved: deletions.some((entry) => entry.irRemoved === true),
  };
}

/**
 * Uninstall an identity. Input:
 * `{projectRoot, projectionId, bundleId, force, dryRun, clock}`.
 */
export function uninstallProjection(input = {}) {
  const clock = input.clock ?? (() => new Date());
  const force = input.force === true;
  const dryRun = input.dryRun === true;
  const projectRoot = resolve(input.projectRoot ?? process.cwd());

  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    return failure('PROJECT_NOT_FOUND', `project root is not a directory: ${projectRoot}`);
  }
  const recovery = recoverPending(projectRoot, { clock });
  if (!recovery.ok) {
    return failure(recovery.code, 'the previous transaction could not be rolled back', {
      failures: recovery.failures,
      journal: recovery.journalPath,
    });
  }

  const legacy = scanLegacyInstallDir(projectRoot);
  if (legacy.length > 0) {
    return failure('LEGACY_INSTALL_PRESENT', 'a r2c.install/v1 receipt exists; uninstall it with the legacy adapter command', {
      legacy,
      hint: 'the new channel never reads or writes r2c.install/v1 receipts',
    });
  }

  if (typeof input.bundleId !== 'string' || input.bundleId === '') {
    return failure('USAGE', 'uninstall needs --bundle <id>');
  }
  if (typeof input.projectionId !== 'string' || input.projectionId === '') {
    return failure('USAGE', 'uninstall needs --projection <id>');
  }

  const ownRel = receiptRelPath(input.projectionId, input.bundleId);
  const receiptLink = symlinkComponent(projectRoot, ownRel);
  if (receiptLink !== null) {
    return failure('SYMLINK_AT_TARGET', `${receiptLink} is a symbolic link; refusing to follow it`);
  }

  let own;
  try {
    own = readReceipt(projectRoot, input.projectionId, input.bundleId);
  } catch (error) {
    return failure('RECEIPT_UNREADABLE', error?.message ?? 'receipt is unreadable');
  }
  if (own === null) {
    return failure('NOT_INSTALLED', `no ${input.projectionId}/${input.bundleId} receipt in this project`);
  }

  const { receipts } = readReceipts(projectRoot);
  const sharedIr = irStillReferenced(receipts, own.path, own.receipt.ir?.path);
  const plan = planUninstall({ projectRoot, receipt: own.receipt, force });
  plan.warnings.push(...sharedIrWarnings(own.receipt, sharedIr));
  const effectiveDeletions = sharedIr
    ? plan.deletions.filter((entry) => entry.ir !== true)
    : plan.deletions;

  const report = {
    ok: plan.leftovers.length === 0,
    code: plan.leftovers.length === 0 ? 'OK' : 'UNINSTALL_INCOMPLETE',
    action: dryRun ? 'would-uninstall' : 'uninstalled',
    dryRun,
    receiptPath: own.path,
    removed: [],
    leftover: plan.leftovers,
    warnings: plan.warnings,
    pruned: [],
    irRemoved: false,
  };

  if (dryRun) {
    report.wouldRemove = effectiveDeletions.map((entry) => entry.path).sort(comparePaths);
    report.irRemoved = effectiveDeletions.some((entry) => entry.irRemoved === true);
    return report;
  }

  let lock;
  try {
    lock = acquireProjectLock(projectRoot);
  } catch (error) {
    if (error?.code === 'LOCK_CONFLICT') return failure('LOCK_CONFLICT', error.message);
    throw error;
  }

  try {
    // Re-read under the lock: the receipt is the plan, so it must be current.
    let fresh;
    try {
      fresh = readReceipt(projectRoot, input.projectionId, input.bundleId);
    } catch (error) {
      return failure('RECEIPT_UNREADABLE', error?.message ?? 'receipt is unreadable');
    }
    if (fresh === null) return failure('NOT_INSTALLED', `no ${input.projectionId}/${input.bundleId} receipt in this project`);
    const freshPlan = planUninstall({ projectRoot, receipt: fresh.receipt, force });
    const freshReceipts = readReceipts(projectRoot).receipts;
    const sharedIrFresh = irStillReferenced(freshReceipts, fresh.path, fresh.receipt.ir?.path);
    const freshDeletions = sharedIrFresh
      ? freshPlan.deletions.filter((entry) => entry.ir !== true)
      : freshPlan.deletions;

    const stamp = timestampSlug(clock);
    const operations = freshDeletions.map((entry) => ({
      op: 'delete',
      path: entry.path,
      backup: entry.backup,
    }));
    operations.push({ op: 'delete', path: fresh.path, backup: true });

    const candidates = [
      ...(fresh.receipt.created_dirs ?? []),
      ...freshDeletions.map((entry) => entry.path),
      fresh.path,
    ];
    const journal = prepareJournal({
      projectRoot,
      command: 'uninstall',
      operations,
      createdDirs: [],
      projectionId: input.projectionId,
      bundleId: input.bundleId,
      stamp,
      clock,
    });

    try {
      writeJournal(projectRoot, journal);
      for (const entry of freshDeletions) {
        unlinkIfExists(projectPath(projectRoot, entry.path));
      }
      unlinkIfExists(projectPath(projectRoot, fresh.path));
      const pruned = [];
      for (const dir of pruneCandidates(candidates)) {
        if (pruneEmptyDir(projectRoot, dir)) pruned.push(dir);
      }
      journal.state = 'committed';
      writeJournal(projectRoot, journal);
      removeJournal(projectRoot);
      return {
        ...report,
        ok: freshPlan.leftovers.length === 0,
        code: freshPlan.leftovers.length === 0 ? 'OK' : 'UNINSTALL_INCOMPLETE',
        removed: freshDeletions.map((entry) => entry.path).sort(comparePaths),
        leftover: freshPlan.leftovers,
        warnings: [...freshPlan.warnings, ...sharedIrWarnings(fresh.receipt, sharedIrFresh)],
        pruned,
        irRemoved: freshDeletions.some((entry) => entry.irRemoved === true),
      };
    } catch (error) {
      const outcome = rollbackJournal(projectRoot, journal);
      if (outcome.failures.length > 0) {
        writeJournal(projectRoot, { ...journal, state: 'rollback-failed' });
        return failure('ROLLBACK_FAILED', 'uninstall failed and the rollback could not restore every path', {
          failures: outcome.failures,
          journal: '.hm2b/install/pending.json',
          cause: error?.message ?? String(error),
        });
      }
      removeJournal(projectRoot);
      return failure('UNINSTALL_FAILED', error?.message ?? 'uninstall failed', {
        cause: error?.code ?? 'IO',
        rolledBack: true,
      });
    }
  } catch (error) {
    return failure('UNINSTALL_FAILED', error?.message ?? 'uninstall failed', { cause: error?.code ?? 'IO' });
  } finally {
    releaseProjectLock(projectRoot, lock);
  }
}

