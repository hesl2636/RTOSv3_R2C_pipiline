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
 * - #104 r2c host copies + `roles.json`: extend `incomingFiles` in install.js
 *   with installer-owned entries and set `hostTargets`; `fileEntry` already
 *   records `origin`/`source`, so the receipt shape does not change.
 * - #106 release install: feed the release IR bytes + pre-projected payload
 *   through the same `installProjection({result, irBytes})`.
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
