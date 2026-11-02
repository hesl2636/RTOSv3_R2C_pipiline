/**
 * `installer/` public API (#94).
 *
 * The installer is a composition root: it may import `node:*` and every lower
 * layer (`core`, `ir`, `assembler`, `projection`, `runtime/*`); no lower layer
 * imports it. Later tickets extend this surface:
 *
 * - #102 upgrade diff: `installProjection` resolves the whole receipt set,
 *   returns `stale` paths and keeps modified ones with a
 *   `STALE_MODIFIED_KEPT` warning; its `diff` is the four-way
 *   `add/remove/change/keep` report and `receipt.previous` records the
 *   replaced identity (path/version/options digest/options/IR digest).
 * - #103 multi-bundle + legacy takeover: two agent-native identities coexist,
 *   a second r2c bundle is refused (`R2C_ROOT_OCCUPIED`) before any write, the
 *   same bundle id on both projections warns `DUPLICATE_BACKEND`, and
 *   `--migrate-legacy` verifies/backs up/retires a `r2c.install/v1` install
 *   inside the same journal.
 * - #104 r2c host copies + `roles.json`: `installR2cProject` renders the four
 *   host role definitions through `runtime/shared/render-role.js`; the generic
 *   `installProjection` accepts them as `installerOwned` so its BC surface is
 *   unchanged. `installRuntime`, `installStatus` and `doctor` own the runtime
 *   receipt, launcher, host commands/hooks/pointers and diagnostics.
 * - #106 release install: feed the release IR bytes + pre-projected payload
 *   through the same `installR2cProject({result, irBytes})` (or
 *   `installProjection` for agent-native).
 */
export { installProjection, receiptOptions } from './install.js';
export { checkR2cRoot, duplicateBackendWarnings } from './coexist.js';
export {
  applyLegacyDeletions,
  detectLegacyInstall,
  planLegacyMigration,
  retireLegacyReceipts,
  revokeMergedPointers,
} from './legacy.js';
export { diffFileSets, previousRecord } from './upgrade.js';
export { installR2cProject, renderR2cRoles, R2C_ROLE_TARGETS, ROLES_JSON_PATH } from './r2c.js';
export {
  ENGINE_ROOT,
  LAUNCHER_PATH,
  LAUNCHER_SHA256,
  LAUNCHER_TEXT,
  RUNTIME_HOST_TARGETS,
  RUNTIME_RECEIPT_PATH,
  RUNTIME_SCHEMA,
  buildRuntimeReceipt,
  installRuntime,
  isRuntimeReceipt,
  readRuntimeReceipt,
} from './runtime.js';
export { formatStatus, installStatus, manifestSelection, STATUS_SCHEMA } from './status.js';
export { DOCTOR_SCHEMA, doctor, formatDoctor } from './doctor.js';
export { planUninstall, uninstallProjection } from './uninstall.js';
export { readJournal, recoverPending, STALE_LOCK_MS } from './transaction.js';
export {
  LEGACY_RECEIPT_SCHEMA,
  RECEIPT_SCHEMA,
  readReceipt,
  readReceipts,
  scanLegacyInstallDir,
  serializeReceipt,
} from './receipt.js';
export {
  INSTALL_DIR,
  JOURNAL_FILE,
  LOCK_FILE,
  RECEIPTS_DIR,
  SHARED_ROOTS,
  irPath,
  isSharedRoot,
  receiptPath,
} from './paths.js';
