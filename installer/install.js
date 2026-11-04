/**
 * Install a validated projection result into a project root (#76 §6, spec §12).
 *
 * Order is the contract: recover any crashed transaction → refuse legacy →
 * validate the result (V1–V12) → load receipts → aggregate conflicts →
 * idempotency → lock → re-check (TOCTOU) → journal + backups → writes sorted by
 * path → verify hashes from disk → receipt last → remove journal.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../core/canonical-json.js';
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import { checkConflicts } from './conflict.js';
import { checkRunnerRoot, duplicateBackendWarnings } from './coexist.js';
import {
  applyLegacyDeletions,
  detectLegacyInstall,
  legacyJournalOperations,
  planLegacyMigration,
  retireLegacyReceipts,
  revokeMergedPointers,
} from './legacy.js';
import {
  ancestorDirs,
  compiledWorkflowPath as compiledWorkflowRelPath,
  isInstallPath,
  projectPath,
  pruneCandidates,
  receiptPath as receiptRelPath,
} from './paths.js';
import {
  buildReceipt,
  fileEntry,
  modeString,
  readReceipts,
  serializeReceipt,
} from './receipt.js';
import {
  acquireProjectLock,
  prepareJournal,
  releaseProjectLock,
  removeJournal,
  rollbackJournal,
  recoverPending,
  writeJournal,
} from './transaction.js';
import { diffFileSets, previousRecord } from './upgrade.js';
import {
  computeCreatedDirs,
  ensureProjectDirs,
  lstatOrNull,
  pruneEmptyDir,
  sha256File,
  sha256Hex,
  symlinkComponent,
  timestampSlug,
  unlinkIfExists,
  writeAbsoluteAtomic,
  writeFileAtomic,
} from './util.js';

function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

function iso(clock) {
  return clock().toISOString();
}

function optionsDigest(options) {
  return sha256Hex(canonicalJson(options));
}

/** The resolved-option shape a receipt records (#76 §5.2). */
export function receiptOptions(result) {
  const echo = result?.options ?? {};
  return {
    stageOrder: echo.stageOrder ?? null,
    skills: echo.skills ?? null,
    targets: echo.targets ?? null,
    digest: optionsDigest({
      schema: echo.schema,
      projection: echo.projection,
      compiledWorkflow: echo.compiledWorkflow,
      stageOrder: echo.stageOrder ?? null,
      skills: echo.skills ?? null,
      targets: echo.targets ?? null,
      extra: echo.extra ?? null,
    }),
  };
}

function incomingFiles(result, owned = null) {
  const overwrite = new Map((result.installPlan?.steps ?? []).map((step) => [step.path, step.overwrite]));
  const files = result.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    targets: [...(file.targets ?? [])],
    mode: file.mode,
    content: file.content,
    sha256: sha256Hex(file.content),
    overwrite: overwrite.get(file.path) ?? 'replace',
    origin: 'projection',
  }));
  for (const file of owned?.files ?? []) {
    files.push({
      path: file.path,
      kind: file.kind ?? 'other',
      targets: [...(file.targets ?? [])],
      mode: file.mode ?? 0o644,
      content: file.content,
      sha256: sha256Hex(file.content),
      overwrite: 'replace',
      origin: file.origin ?? 'installer',
      source: file.source,
    });
  }
  return files;
}

function sameIdentity(receipt, { projection, bundleId, version, compiledWorkflowDigest: digest, compiledWorkflowPath }) {
  return receipt.projection?.id === projection
    && receipt.projection?.version === version.projection
    && receipt.bundle?.id === bundleId
    && receipt.bundle?.version === version.bundle
    && receipt.compiledWorkflow?.digest === digest
    && receipt.compiledWorkflow?.path === compiledWorkflowPath;
}

function sameOptions(receipt, options) {
  return JSON.stringify(receipt.options) === JSON.stringify(options);
}

function sameFileSet(receiptFiles, incoming) {
  if (!Array.isArray(receiptFiles) || receiptFiles.length !== incoming.length) return false;
  const byPath = new Map(receiptFiles.map((file) => [file.path, file]));
  for (const entry of incoming) {
    const recorded = byPath.get(entry.path);
    if (recorded === undefined) return false;
    if (recorded.sha256 !== entry.sha256) return false;
    if (recorded.mode !== modeString(entry.mode)) return false;
    if (recorded.kind !== entry.kind) return false;
    if (JSON.stringify(recorded.targets) !== JSON.stringify([...entry.targets].sort())) return false;
  }
  return true;
}

function receiptEntries(projectRoot, incoming) {
  return incoming.map((entry) => fileEntry({
    path: entry.path,
    kind: entry.kind,
    targets: entry.targets,
    sha256: sha256File(projectPath(projectRoot, entry.path)),
    mode: modeString(entry.mode),
    origin: entry.origin ?? 'projection',
    source: entry.source ?? entry.path,
  }));
}

function hashEvery(projectRoot, incoming) {
  const mismatched = [];
  for (const entry of incoming) {
    const absolute = projectPath(projectRoot, entry.path);
    if (absolute === null || !existsSync(absolute)) {
      mismatched.push({ path: entry.path, reason: 'MISSING' });
      continue;
    }
    if (sha256File(absolute) !== entry.sha256) mismatched.push({ path: entry.path, reason: 'HASH_MISMATCH' });
  }
  return mismatched;
}

function loadReceipts(projectRoot, ownRel) {
  const { receipts } = readReceipts(projectRoot);
  const own = receipts.find((item) => item.path === ownRel) ?? null;
  return { own, others: receipts.filter((item) => item.path !== ownRel) };
}

/**
 * The compiled workflow copy the replaced receipt still owns. It is removable only when it is
 * the exact installer path for the replaced version, is a project-relative
 * plain file, differs from the compiled workflow this run writes, and no other receipt still
 * points at it.
 */
function supersededCompiledWorkflow(projectRoot, { previous, others, compiledWorkflowRel, bundleId }) {
  const previousCompiledWorkflow = previous?.receipt?.compiledWorkflow?.path;
  const previousVersion = previous?.receipt?.bundle?.version;
  if (typeof previousCompiledWorkflow !== 'string' || typeof previousVersion !== 'string') return null;
  if (previousCompiledWorkflow !== compiledWorkflowRelPath(bundleId, previousVersion)) return null;
  if (previousCompiledWorkflow === compiledWorkflowRel) return null;
  if (!isInstallPath(previousCompiledWorkflow) || projectPath(projectRoot, previousCompiledWorkflow) === null) return null;
  if (others.some((item) => item.receipt?.compiledWorkflow?.path === previousCompiledWorkflow)) return null;
  if (symlinkComponent(projectRoot, previousCompiledWorkflow) !== null) return null;
  return previousCompiledWorkflow;
}

/** Prune the bundle/version directories a removed compiled workflow copy left empty. */
function pruneIrDirs(projectRoot, compiledWorkflowRel) {
  const pruned = [];
  for (const dir of pruneCandidates([compiledWorkflowRel])) {
    try {
      if (pruneEmptyDir(projectRoot, dir)) pruned.push(dir);
    } catch {
      // best effort: an occupied or unreadable directory simply stays
    }
  }
  return pruned;
}

/** The `migrated_from` block a receipt records (#76 §5.2). */
function migrationSummary(migration) {
  return {
    receipts: migration.receipts.map((item) => item.from),
    retired: migration.receipts.map((item) => item.to),
    manual_leftovers: migration.manualLeftovers,
  };
}

/** Post-commit legacy cleanup: empty dirs the old install created, then payload home. */
function pruneLegacyDirs(projectRoot, migration) {
  if (migration === null) return [];
  const pruned = [];
  for (const dir of migration.dirs) {
    try {
      if (pruneEmptyDir(projectRoot, dir)) pruned.push(dir);
    } catch {
      // best effort: an occupied directory simply stays
    }
  }
  for (const dir of migration.payloadHomes) {
    const absolute = projectPath(projectRoot, dir);
    if (absolute === null || !existsSync(absolute)) continue;
    try {
      rmSync(absolute, { recursive: true, force: true });
      pruned.push(dir);
    } catch {
      // best effort: the payload is legacy state, not ownership
    }
  }
  return pruned;
}

/**
 * Install one projection result.
 *
 * Input: `{result, compiledWorkflowBytes, projectRoot, force, dryRun, clock, options, assets,
 * migrateLegacy, userHome}`. Returns `{ok, code, action, ...}`; expected
 * failures are values, not throws.
 */
export function installProjection(input = {}) {
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
  const recoveryNote = recovery.recovered ? { recovered: true } : {};

  const migrateLegacy = input.migrateLegacy === true;
  const legacyState = detectLegacyInstall({
    projectRoot,
    userHome: input.userHome,
    scanUser: migrateLegacy,
  });
  let migration = null;
  if (!migrateLegacy) {
    if (legacyState.project.length > 0) {
      return failure('LEGACY_INSTALL_PRESENT', 'a legacy r2c.install/v1 receipt exists; the new channel refuses to mix with it', {
        legacy: legacyState.project,
        hint: 'rerun with --migrate-legacy to verify, back up, retire the old receipts and take over',
      });
    }
  } else {
    if (legacyState.unsupported.length > 0) {
      return failure('LEGACY_RECEIPT_UNSUPPORTED', 'a legacy receipt uses an unsupported schema; nothing was changed', {
        unsupported: legacyState.unsupported,
      });
    }
    migration = planLegacyMigration({ projectRoot, legacy: legacyState });
    if (migration.conflicts.length > 0 && !force) {
      return failure('LEGACY_HASH_MISMATCH', 'legacy files were modified after their install; --force backs them up and continues', {
        conflicts: migration.conflicts,
        manualSteps: migration.manualLeftovers,
        dryRun,
      });
    }
  }
  const takeoverPaths = new Set(migration?.deletions.map((entry) => entry.path) ?? []);
  const manualSteps = migration?.manualLeftovers ?? [];

  const result = input.result;
  if (result === null || typeof result !== 'object') {
    return failure('PROJECTION_RESULT_INVALID', 'missing projection result');
  }
  const projectionId = result.projection?.id;
  const descriptor = projectionId === undefined ? null : getProjection(projectionId);
  if (descriptor === null) {
    return failure('PROJECTION_NOT_REGISTERED', `projection ${String(projectionId)} is not registered`);
  }

  const compiledWorkflowBytes = input.compiledWorkflowBytes;
  if (compiledWorkflowBytes === undefined || compiledWorkflowBytes === null) {
    return failure('COMPILED_WORKFLOW_INPUT_REQUIRED', 'V1–V12 bind the result to its compiled workflow; pass the validated compiled workflow bytes');
  }
  const compiledWorkflowText = typeof compiledWorkflowBytes === 'string' ? compiledWorkflowBytes : Buffer.from(compiledWorkflowBytes).toString('utf8');
  const compiledWorkflowDigest = sha256Hex(compiledWorkflowText);
  if (input.compiledWorkflowDigest !== undefined && input.compiledWorkflowDigest !== compiledWorkflowDigest) {
    return failure('COMPILED_WORKFLOW_DIGEST_MISMATCH', 'compiled workflow bytes do not hash to the supplied digest', {
      expected: input.compiledWorkflowDigest,
      actual: compiledWorkflowDigest,
    });
  }
  let compiledWorkflow;
  try {
    compiledWorkflow = JSON.parse(compiledWorkflowText);
  } catch {
    return failure('COMPILED_WORKFLOW_INPUT_INVALID', 'compiled workflow bytes are not JSON');
  }

  const validation = validateResult(result, {
    compiledWorkflow,
    compiledWorkflowDigest,
    manifest: descriptor,
    options: input.options ?? result.options,
    environment: result.environment ?? {},
    assets: input.assets ?? {},
  });
  if (!validation.ok) {
    return failure('PROJECTION_RESULT_INVALID', 'the projection result failed V1–V12', {
      diagnostics: validation.diagnostics,
    });
  }

  const bundleId = compiledWorkflow.id;
  const version = compiledWorkflow.version;
  const compiledWorkflowRel = compiledWorkflowRelPath(bundleId, version);
  const compiledWorkflowAbsolute = projectPath(projectRoot, compiledWorkflowRel);
  const ownRel = receiptRelPath(projectionId, bundleId);
  const ownAbsolute = projectPath(projectRoot, ownRel);
  const owned = input.installerOwned ?? null;
  const declared = new Set(result.files.map((file) => file.path));
  const ownedProblems = [];
  for (const file of owned?.files ?? []) {
    if (declared.has(file.path)) {
      ownedProblems.push({ code: 'INSTALLER_FILE_CONFLICT', path: file.path, message: `${file.path} is declared by both the projection result and the installer` });
      continue;
    }
    if (!isInstallPath(file.path) || projectPath(projectRoot, file.path) === null) {
      ownedProblems.push({ code: 'INSTALLER_FILE_INVALID', path: file.path, message: `${file.path} is not a project-relative install path` });
    }
  }
  if (ownedProblems.length > 0) {
    return failure('INSTALLER_FILE_INVALID', `${ownedProblems.length} installer-owned path problem(s)`, { problems: ownedProblems });
  }
  const incoming = incomingFiles(result, owned);
  const options = receiptOptions(result);

  let loaded;
  try {
    loaded = loadReceipts(projectRoot, ownRel);
  } catch (error) {
    return failure('RECEIPT_UNREADABLE', error?.message ?? 'receipts could not be read');
  }
  const { own, others } = loaded;

  const bookkeepingLink = [compiledWorkflowRel, ownRel]
    .map((rel) => ({ rel, link: symlinkComponent(projectRoot, rel) }))
    .find((entry) => entry.link !== null);
  if (bookkeepingLink !== undefined) {
    return {
      ok: false,
      code: 'INSTALL_CONFLICTS',
      message: 'installer bookkeeping paths must not be symbolic links',
      conflicts: [{
        code: 'SYMLINK_AT_TARGET',
        path: bookkeepingLink.rel,
        message: `${bookkeepingLink.link} is a symbolic link; refusing to follow it`,
        details: {},
      }],
    };
  }

  const occupied = checkRunnerRoot({
    projectRoot,
    projectionId,
    bundleId,
    incoming,
    previous: own,
    others,
    takeoverPaths,
  });
  if (occupied !== null) {
    return {
      ok: false,
      ...occupied,
      conflicts: [],
      manualSteps,
      dryRun,
    };
  }
  const coexistWarnings = duplicateBackendWarnings({ projectionId, bundleId, others });

  const check = checkConflicts({
    projectRoot,
    incoming,
    previous: own,
    others,
    force,
    takeoverPaths,
  });
  const diff = diffFileSets(own?.receipt?.files ?? [], incoming);
  if (check.conflicts.length > 0) {
    return {
      ok: false,
      code: 'INSTALL_CONFLICTS',
      message: `${check.conflicts.length} path conflict(s); nothing was written`,
      conflicts: check.conflicts,
      manualSteps,
      dryRun,
    };
  }

  const compiledWorkflowDiskSha = lstatOrNull(compiledWorkflowAbsolute)?.isFile() ? sha256File(compiledWorkflowAbsolute) : null;
  const hostTargets = [...(owned?.hostTargets ?? result.targets ?? [])].sort();
  const unchanged = own !== null
    && sameIdentity(own.receipt, {
      projection: projectionId,
      bundleId,
      version: { projection: result.projection.version, bundle: version },
      compiledWorkflowDigest,
      compiledWorkflowPath: compiledWorkflowRel,
    })
    && sameOptions(own.receipt, options)
    && JSON.stringify(own.receipt.projection?.targets) === JSON.stringify([...result.targets].sort())
    && JSON.stringify(own.receipt.host_targets ?? []) === JSON.stringify(hostTargets)
    && sameFileSet(own.receipt.files, incoming)
    && check.decisions.every((decision) => decision.action === 'keep')
    && check.stale.length === 0
    && compiledWorkflowDiskSha === compiledWorkflowDigest
    && check.warnings.length === 0;

  if (unchanged) {
    return {
      ok: true,
      code: 'OK',
      action: 'unchanged',
      ...recoveryNote,
      dryRun,
      receipt: own.receipt,
      receiptPath: ownRel,
      files: incoming.length,
      warnings: [...(owned?.warnings ?? []), ...coexistWarnings],
      manualSteps,
      diff,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      code: 'OK',
      action: 'would-install',
      ...recoveryNote,
      dryRun,
      decisions: check.decisions,
      stale: check.stale,
      supersededCompiledWorkflow: supersededCompiledWorkflow(projectRoot, { previous: own, others, compiledWorkflowRel, bundleId }),
      warnings: [...(owned?.warnings ?? []), ...check.warnings, ...coexistWarnings],
      files: incoming.length,
      mode: own === null ? (migration?.receipts.length ? 'migrated' : 'fresh') : 'upgrade',
      migration: migration?.receipts.length ? migrationSummary(migration) : null,
      manualSteps,
      diff,
    };
  }

  let lock;
  try {
    lock = acquireProjectLock(projectRoot);
  } catch (error) {
    if (error?.code === 'LOCK_CONFLICT') return failure('LOCK_CONFLICT', error.message, { lock: error.message });
    throw error;
  }

  try {
    const stamp = timestampSlug(clock);
    // TOCTOU: receipts and disk may have changed between check and lock.
    const fresh = loadReceipts(projectRoot, ownRel);
    // The replaced receipt may own a compiled workflow copy at another version (A → B). It
    // is only removable when no other receipt points at it; the new compiled workflow is
    // never a candidate because `supersededCompiledWorkflow` refuses `compiledWorkflowRel`.
    const staleCompiledWorkflow = supersededCompiledWorkflow(projectRoot, { previous: fresh.own, others: fresh.others, compiledWorkflowRel, bundleId });
    // TOCTOU: the runner singleton decision is only valid under the lock. Two
    // bundles that passed the pre-lock check with disjoint paths would both
    // claim one runner root; the loser must be refused here, before any write.
    const occupiedNow = checkRunnerRoot({
      projectRoot,
      projectionId,
      bundleId,
      incoming,
      previous: fresh.own,
      others: fresh.others,
      takeoverPaths,
    });
    if (occupiedNow !== null) {
      return {
        ok: false,
        ...occupiedNow,
        conflicts: [],
        manualSteps,
        dryRun,
      };
    }
    const recheck = checkConflicts({
      projectRoot,
      incoming,
      previous: fresh.own,
      others: fresh.others,
      force,
      takeoverPaths,
    });

    if (recheck.conflicts.length > 0) {
      return {
        ok: false,
        code: 'INSTALL_CONFLICTS',
        message: `${recheck.conflicts.length} path conflict(s) appeared while waiting for the lock`,
        conflicts: recheck.conflicts,
        dryRun,
      };
    }
    const appliedDiff = diffFileSets(fresh.own?.receipt?.files ?? [], incoming);

    const targetPaths = [
      ...incoming.map((entry) => entry.path),
      compiledWorkflowRel,
      ownRel,
      ...(migration?.receipts.map((item) => item.to) ?? []),
    ];
    const createdDirs = computeCreatedDirs(projectRoot, targetPaths);
    const operations = [];
    for (const decision of recheck.decisions) {
      if (decision.action === 'adopt' || decision.action === 'keep') continue;
      operations.push({
        op: decision.action === 'create' ? 'create' : 'replace',
        path: decision.path,
        backup: decision.backup,
      });
    }
    for (const entry of recheck.stale) {
      operations.push({ op: 'delete', path: entry.path, backup: entry.backup });
    }
    if (migration !== null && migration.receipts.length > 0) {
      operations.push(...legacyJournalOperations(migration, new Set(incoming.map((entry) => entry.path)), projectRoot));
    }
    const receiptExisted = lstatOrNull(ownAbsolute) !== null;
    operations.push({ op: receiptExisted ? 'replace' : 'create', path: ownRel, backup: receiptExisted });
    if (staleCompiledWorkflow !== null) operations.push({ op: 'delete', path: staleCompiledWorkflow, backup: true });

    const journal = prepareJournal({
      projectRoot,
      command: 'install',
      operations,
      createdDirs,
      projectionId,
      bundleId,
      stamp,
      clock,
    });

    const wrote = [];
    let migrationFacts = null;
    try {
      writeJournal(projectRoot, journal);
      for (const dir of createdDirs) ensureProjectDirs(projectRoot, dir);
      if (migration !== null && migration.receipts.length > 0) {
        const revoked = revokeMergedPointers({ projectRoot, merged: migration.merged, force });
        const deleted = applyLegacyDeletions({
          projectRoot,
          plan: migration,
          skip: new Set(incoming.map((entry) => entry.path)),
        });
        const retired = retireLegacyReceipts({ projectRoot, plan: migration });
        migrationFacts = { ...revoked, deleted, retired };
      }
      for (const decision of recheck.decisions) {
        if (decision.action === 'adopt' || decision.action === 'keep') continue;
        const entry = incoming.find((item) => item.path === decision.path);
        const absolute = projectPath(projectRoot, entry.path);
        const dirs = ancestorDirs(entry.path);
        ensureProjectDirs(projectRoot, dirs.length === 0 ? '' : dirs[dirs.length - 1]);
        writeFileAtomic(absolute, entry.content, entry.mode);
        wrote.push(entry.path);
      }
      for (const entry of recheck.stale) {
        const absolute = projectPath(projectRoot, entry.path);
        unlinkIfExists(absolute);
      }
      // compiled workflow copy: installer-owned, outside `files[]` (#76 §3.3).
      const compiledWorkflowDirs = ancestorDirs(compiledWorkflowRel);
      ensureProjectDirs(projectRoot, compiledWorkflowDirs[compiledWorkflowDirs.length - 1]);
      writeAbsoluteAtomic(compiledWorkflowAbsolute, compiledWorkflowText);

      const mismatched = hashEvery(projectRoot, incoming);
      if (mismatched.length > 0) {
        const error = new Error(`post-write hash verification failed for ${mismatched[0].path}`);
        error.code = 'HASH_MISMATCH';
        error.details = mismatched;
        throw error;
      }
      if (sha256File(compiledWorkflowAbsolute) !== compiledWorkflowDigest) {
        const error = new Error('post-write compiled workflow hash verification failed');
        error.code = 'HASH_MISMATCH';
        throw error;
      }
      // Superseded compiled workflow copy (A → B): once this receipt lands, no receipt points
      // at the old version any more, so the copy and its now-empty bundle
      // directories leave the project. Journaled above, so a rollback restores
      // it together with the replaced receipt.
      const staleWarnings = [];
      const compiledWorkflowPruned = [];
      if (staleCompiledWorkflow !== null) {
        try {
          unlinkIfExists(projectPath(projectRoot, staleCompiledWorkflow));
          compiledWorkflowPruned.push(...pruneIrDirs(projectRoot, staleCompiledWorkflow));
        } catch {
          staleWarnings.push({
            code: 'COMPILED_WORKFLOW_STALE_KEPT',
            path: staleCompiledWorkflow,
            message: `${staleCompiledWorkflow} is no longer referenced by any receipt but could not be deleted; remove it by hand`,
          });
        }
      }

      const receiptFiles = receiptEntries(projectRoot, incoming);
      const installWarnings = [
        ...(result.warnings ?? []),
        ...(owned?.warnings ?? []),
        ...recheck.warnings,
        ...coexistWarnings,
        ...staleWarnings,
      ];
      const installDegradations = [
        ...(result.degradations ?? []),
        ...(owned?.degradations ?? []),
      ];
      const migrated = migrationFacts !== null && migrationFacts.retired.length > 0;
      const backups = journal.operations
        .filter((operation) => operation.backup !== null && operation.path !== ownRel)
        .map((operation) => ({
          path: operation.path,
          backup: operation.backup,
          sha256: operation.before_sha256 ?? null,
        }));
      const now = iso(clock);
      const receipt = buildReceipt({
        projection: { id: projectionId, version: result.projection.version, targets: result.targets },
        bundle: { id: bundleId, version },
        compiledWorkflow: { path: compiledWorkflowRel, digest: compiledWorkflowDigest, contentSha256: result.compiledWorkflow?.contentSha256 ?? null },
        mode: migrated ? 'migrated' : fresh.own === null ? 'fresh' : 'upgrade',
        hostTargets,
        options,
        requiresEngine: compiledWorkflow.requires?.engine ?? null,
        files: receiptFiles,
        metadata: result.metadata,
        capabilityReport: result.capabilityReport,
        degradations: installDegradations,
        warnings: installWarnings,
        createdDirs,
        backups,
        previous: previousRecord(fresh.own, ownRel),
        migratedFrom: migrated ? migrationSummary(migration) : null,
        createdAt: fresh.own?.receipt?.created_at ?? now,
        updatedAt: now,
      });
      writeAbsoluteAtomic(ownAbsolute, serializeReceipt(receipt));

      journal.state = 'committed';
      journal.receipts_written = [ownRel];
      writeJournal(projectRoot, journal);
      removeJournal(projectRoot);
      const pruned = [...compiledWorkflowPruned, ...pruneLegacyDirs(projectRoot, migration)];
      return {
        ok: true,
        code: 'OK',
        action: 'installed',
        ...recoveryNote,
        dryRun: false,
        receipt,
        receiptPath: ownRel,
        mode: receipt.mode,
        files: receiptFiles.length,
        wrote,
        decisions: recheck.decisions,
        createdDirs,
        backups,
        supersededCompiledWorkflow: staleCompiledWorkflow,
        warnings: installWarnings,
        manualSteps,
        migration: migrated ? migrationSummary(migration) : null,
        pruned,
        diff: appliedDiff,
        ignoreSuggestions: ['.hm2b/bin/', '.hm2b/bundles/', '.hm2b/projection/'],
      };
    } catch (error) {
      const outcome = rollbackJournal(projectRoot, journal);
      if (outcome.failures.length > 0) {
        writeJournal(projectRoot, { ...journal, state: 'rollback-failed' });
        return failure('ROLLBACK_FAILED', 'install failed and the rollback could not restore every path', {
          failures: outcome.failures,
          journal: '.hm2b/install/pending.json',
          cause: error?.message ?? String(error),
        });
      }
      removeJournal(projectRoot);
      return failure('INSTALL_FAILED', error?.message ?? 'install failed', {
        cause: error?.code ?? 'IO',
        details: error?.details ?? null,
        rolledBack: true,
      });
    }
  } catch (error) {
    return failure('INSTALL_FAILED', error?.message ?? 'install failed', { cause: error?.code ?? 'IO' });
  } finally {
    releaseProjectLock(projectRoot, lock);
  }
}

