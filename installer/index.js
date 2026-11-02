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
 * - #103 legacy migration: `--migrate-legacy` is intentionally unsupported
 *   here; `LEGACY_INSTALL_PRESENT` carries the migration hint.
 * - #104 r2c host copies + `roles.json`: extend `incomingFiles` in install.js
 *   with installer-owned entries and set `hostTargets`; `fileEntry` already
 *   records `origin`/`source`, so the receipt shape does not change.
 * - #106 release install: feed the release IR bytes + pre-projected payload
 *   through the same `installProjection({result, irBytes})`.
 */
export { installProjection, receiptOptions } from './install.js';
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
