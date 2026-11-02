/**
 * Install a validated projection result into a project root (#76 §6, spec §12).
 *
 * Order is the contract: recover any crashed transaction → refuse legacy →
 * validate the result (V1–V12) → load receipts → aggregate conflicts →
 * idempotency → lock → re-check (TOCTOU) → journal + backups → writes sorted by
 * path → verify hashes from disk → receipt last → remove journal.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../core/canonical-json.js';
import { comparePaths } from '../core/paths.js';
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import { checkConflicts } from './conflict.js';
import {
  ancestorDirs,
  irPath as irRelPath,
  projectPath,
  receiptPath as receiptRelPath,
} from './paths.js';
import {
  buildReceipt,
  fileEntry,
  modeString,
  readReceipts,
  scanLegacyInstallDir,
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
import {
  ensureProjectDirs,
  lstatOrNull,
  sha256File,
  sha256Hex,
  symlinkComponent,
  unlinkIfExists,
  writeAbsoluteAtomic,
  writeFileAtomic,
} from './util.js';


const TIMESTAMP_SAFE = /[:.]/g;

function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

function iso(clock) {
  return clock().toISOString();
}

function timestampSlug(clock) {
  return iso(clock).replace(TIMESTAMP_SAFE, '-');
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
      ir: echo.ir,
      stageOrder: echo.stageOrder ?? null,
      skills: echo.skills ?? null,
      targets: echo.targets ?? null,
      extra: echo.extra ?? null,
    }),
  };
}

function incomingFiles(result) {
  const overwrite = new Map((result.installPlan?.steps ?? []).map((step) => [step.path, step.overwrite]));
  return result.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    targets: [...(file.targets ?? [])],
    mode: file.mode,
    content: file.content,
    sha256: sha256Hex(file.content),
    overwrite: overwrite.get(file.path) ?? 'replace',
  }));
}

function sameIdentity(receipt, { projection, bundleId, version, irDigest: digest, irPath }) {
  return receipt.projection?.id === projection
    && receipt.projection?.version === version.projection
    && receipt.bundle?.id === bundleId
    && receipt.bundle?.version === version.bundle
    && receipt.ir?.digest === digest
    && receipt.ir?.path === irPath;
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
    origin: 'projection',
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

function computeCreatedDirs(projectRoot, paths) {
  const created = new Set();
  for (const path of paths) {
    for (const dir of ancestorDirs(path)) {
      const absolute = projectPath(projectRoot, dir);
      if (absolute === null) continue;
      const info = lstatOrNull(absolute);
      if (info === null) created.add(dir);
    }
  }
  return [...created].sort(comparePaths);
}

/**
 * Install one projection result.
 *
 * Input: `{result, irBytes, projectRoot, force, dryRun, clock, options, assets}`.
 * Returns `{ok, code, action, ...}`; expected failures are values, not throws.
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

  const legacy = scanLegacyInstallDir(projectRoot);
  if (legacy.length > 0) {
    return failure('LEGACY_INSTALL_PRESENT', 'a r2c.install/v1 receipt exists; the new channel refuses to mix with it', {
      legacy,
      hint: 'remove the legacy install (r2c adapter uninstall) before installing bundles; --migrate-legacy lands in #103',
    });
  }

  const result = input.result;
  if (result === null || typeof result !== 'object') {
    return failure('PROJECTION_RESULT_INVALID', 'missing projection result');
  }
  const projectionId = result.projection?.id;
  const descriptor = projectionId === undefined ? null : getProjection(projectionId);
  if (descriptor === null) {
    return failure('PROJECTION_NOT_REGISTERED', `projection ${String(projectionId)} is not registered`);
  }

  const irBytes = input.irBytes;
  if (irBytes === undefined || irBytes === null) {
    return failure('IR_INPUT_REQUIRED', 'V1–V12 bind the result to its IR; pass the validated IR bytes');
  }
  const irText = typeof irBytes === 'string' ? irBytes : Buffer.from(irBytes).toString('utf8');
  const irDigest = sha256Hex(irText);
  if (input.irDigest !== undefined && input.irDigest !== irDigest) {
    return failure('IR_DIGEST_MISMATCH', 'IR bytes do not hash to the supplied digest', {
      expected: input.irDigest,
      actual: irDigest,
    });
  }
  let ir;
  try {
    ir = JSON.parse(irText);
  } catch {
    return failure('IR_INPUT_INVALID', 'IR bytes are not JSON');
  }

  const validation = validateResult(result, {
    ir,
    irDigest,
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

  const bundleId = ir.id;
  const version = ir.version;
  const irRel = irRelPath(bundleId, version);
  const irAbsolute = projectPath(projectRoot, irRel);
  const ownRel = receiptRelPath(projectionId, bundleId);
  const ownAbsolute = projectPath(projectRoot, ownRel);
  const incoming = incomingFiles(result);
  const options = receiptOptions(result);

  let loaded;
  try {
    loaded = loadReceipts(projectRoot, ownRel);
  } catch (error) {
    return failure('RECEIPT_UNREADABLE', error?.message ?? 'receipts could not be read');
  }
  const { own, others } = loaded;

  const bookkeepingLink = [irRel, ownRel]
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

  const check = checkConflicts({ projectRoot, incoming, previous: own, others, force });
  if (check.conflicts.length > 0) {
    return {
      ok: false,
      code: 'INSTALL_CONFLICTS',
      message: `${check.conflicts.length} path conflict(s); nothing was written`,
      conflicts: check.conflicts,
      dryRun,
    };
  }

  const irDiskSha = lstatOrNull(irAbsolute)?.isFile() ? sha256File(irAbsolute) : null;
  const unchanged = own !== null
    && sameIdentity(own.receipt, {
      projection: projectionId,
      bundleId,
      version: { projection: result.projection.version, bundle: version },
      irDigest,
      irPath: irRel,
    })
    && sameOptions(own.receipt, options)
    && JSON.stringify(own.receipt.projection?.targets) === JSON.stringify([...result.targets].sort())
    && sameFileSet(own.receipt.files, incoming)
    && check.decisions.every((decision) => decision.action === 'keep')
    && check.stale.length === 0
    && irDiskSha === irDigest
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
      warnings: check.warnings,
      files: incoming.length,
      mode: own === null ? 'fresh' : 'upgrade',
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
    // TOCTOU: receipts and disk may have changed between check and lock.
    const fresh = loadReceipts(projectRoot, ownRel);
    const recheck = checkConflicts({ projectRoot, incoming, previous: fresh.own, others: fresh.others, force });
    if (recheck.conflicts.length > 0) {
      return {
        ok: false,
        code: 'INSTALL_CONFLICTS',
        message: `${recheck.conflicts.length} path conflict(s) appeared while waiting for the lock`,
        conflicts: recheck.conflicts,
        dryRun,
      };
    }

    const stamp = timestampSlug(clock);
    const targetPaths = [
      ...incoming.map((entry) => entry.path),
      irRel,
      ownRel,
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
    const receiptExisted = lstatOrNull(ownAbsolute) !== null;
    operations.push({ op: receiptExisted ? 'replace' : 'create', path: ownRel, backup: receiptExisted });

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
    try {
      writeJournal(projectRoot, journal);
      for (const dir of createdDirs) ensureProjectDirs(projectRoot, dir);
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
      // IR copy: installer-owned, outside `files[]` (#76 §3.3).
      const irDirs = ancestorDirs(irRel);
      ensureProjectDirs(projectRoot, irDirs[irDirs.length - 1]);
      writeAbsoluteAtomic(irAbsolute, irText);

      const mismatched = hashEvery(projectRoot, incoming);
      if (mismatched.length > 0) {
        const error = new Error(`post-write hash verification failed for ${mismatched[0].path}`);
        error.code = 'HASH_MISMATCH';
        error.details = mismatched;
        throw error;
      }
      if (sha256File(irAbsolute) !== irDigest) {
        const error = new Error('post-write IR hash verification failed');
        error.code = 'HASH_MISMATCH';
        throw error;
      }

      const receiptFiles = receiptEntries(projectRoot, incoming);
      const installWarnings = [...(result.warnings ?? []), ...recheck.warnings];
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
        ir: { path: irRel, digest: irDigest, contentSha256: result.ir?.contentSha256 ?? null },
        mode: fresh.own === null ? 'fresh' : 'upgrade',
        hostTargets: [],
        options,
        requiresEngine: ir.requires?.engine ?? null,
        files: receiptFiles,
        metadata: result.metadata,
        capabilityReport: result.capabilityReport,
        degradations: result.degradations,
        warnings: installWarnings,
        createdDirs,
        backups,
        previous: fresh.own === null ? null : { version: fresh.own.receipt.bundle?.version ?? null, receipt: ownRel },
        migratedFrom: null,
        createdAt: fresh.own?.receipt?.created_at ?? now,
        updatedAt: now,
      });
      writeAbsoluteAtomic(ownAbsolute, serializeReceipt(receipt));

      journal.state = 'committed';
      journal.receipts_written = [ownRel];
      writeJournal(projectRoot, journal);
      removeJournal(projectRoot);
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
        warnings: installWarnings,
        ignoreSuggestions: ['.r2c/bin/', '.r2c/bundles/', '.r2c/projection/'],
      };
    } catch (error) {
      const outcome = rollbackJournal(projectRoot, journal);
      if (outcome.failures.length > 0) {
        writeJournal(projectRoot, { ...journal, state: 'rollback-failed' });
        return failure('ROLLBACK_FAILED', 'install failed and the rollback could not restore every path', {
          failures: outcome.failures,
          journal: '.r2c/install/pending.json',
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

