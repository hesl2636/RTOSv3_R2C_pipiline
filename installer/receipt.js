/**
 * `r2c.install/v2` receipts (#76 §5, #82 §11, spec §12).
 *
 * One receipt per install identity `(projection.id, bundle.id)`, project
 * relative, canonical JSON, no absolute paths. `files[]` records every path the
 * identity owns, with hashes computed from disk after the write; the IR copy
 * and the receipt itself are installer bookkeeping and never appear in
 * `files[]` (#76 R3).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, isCanonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { comparePaths } from '../core/paths.js';
import {
  INSTALL_DIR,
  LEGACY_RECEIPT_SCHEMA,
  RECEIPT_SCHEMA,
  RECEIPTS_DIR,
  receiptPath as receiptRelPath,
} from './paths.js';
import { readJsonFile } from './util.js';

export { RECEIPT_SCHEMA, LEGACY_RECEIPT_SCHEMA, receiptRelPath };

/** `0644` / `0755` are the only modes the contract allows (#76 L5). */
export function modeString(mode) {
  return mode === 0o755 ? '0755' : '0644';
}

export function modeNumber(mode) {
  return mode === '0755' || mode === 0o755 ? 0o755 : 0o644;
}

/** One `files[]` entry in contract key order. */
export function fileEntry({ path, kind, targets, sha256, mode, origin, source }) {
  const entry = {
    path,
    kind,
    targets: [...(targets ?? [])].sort(compareCodePoints),
    sha256,
    mode: typeof mode === 'string' ? mode : modeString(mode),
    origin,
  };
  if (origin === 'installer') entry.source = source ?? path;
  return entry;
}

/**
 * Build the canonical receipt value. Key order is the contract (#76 R1) and is
 * the order this literal writes.
 */
export function buildReceipt({
  projection,
  bundle,
  ir,
  mode,
  hostTargets,
  options,
  requiresEngine,
  files,
  metadata,
  capabilityReport,
  degradations,
  warnings,
  createdDirs,
  backups,
  previous,
  migratedFrom,
  createdAt,
  updatedAt,
}) {
  return {
    schema: RECEIPT_SCHEMA,
    projection: {
      id: projection.id,
      version: projection.version,
      targets: [...projection.targets].sort(compareCodePoints),
    },
    bundle: { id: bundle.id, version: bundle.version },
    ir: { path: ir.path, digest: ir.digest, contentSha256: ir.contentSha256 },
    root: 'project',
    scope: 'project',
    mode,
    host_targets: [...(hostTargets ?? [])].sort(compareCodePoints),
    options,
    requires_engine: requiresEngine ?? null,
    files: [...files].sort((left, right) => comparePaths(left.path, right.path)),
    metadata,
    capability_report: capabilityReport,
    degradations,
    warnings,
    created_dirs: [...new Set(createdDirs ?? [])].sort(comparePaths),
    backups: [...(backups ?? [])].sort((left, right) => comparePaths(left.path, right.path)),
    previous,
    migrated_from: migratedFrom ?? null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function serializeReceipt(receipt) {
  return canonicalJson(receipt);
}

/** True when a parsed value is a canonical `r2c.install/v2` receipt header. */
export function isReceiptV2(value) {
  return value !== null && typeof value === 'object' && value.schema === RECEIPT_SCHEMA;
}

/**
 * Load every receipt under `.r2c/install/receipts/`. Unreadable or
 * non-v2 files are reported, never trusted. Legacy `r2c.install/v1` receipts
 * live directly in `.r2c/install/` and are reported separately.
 */
export function readReceipts(projectRoot) {
  const receipts = [];
  const invalid = [];
  const legacy = [];
  const root = join(projectRoot, ...RECEIPTS_DIR.split('/'));
  let projections = [];
  try {
    projections = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCodePoints);
  } catch {
    projections = [];
  }
  for (const projection of projections) {
    let files = [];
    try {
      files = readdirSync(join(root, projection), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort(compareCodePoints);
    } catch {
      files = [];
    }
    for (const name of files) {
      const rel = `${RECEIPTS_DIR}/${projection}/${name}`;
      const read = readJsonFile(join(projectRoot, ...rel.split('/')));
      if (!read.ok) {
        invalid.push({ path: rel, reason: read.error.code });
        continue;
      }
      if (!isReceiptV2(read.value)) {
        if (read.value?.schema === LEGACY_RECEIPT_SCHEMA) legacy.push({ path: rel, receipt: read.value });
        else invalid.push({ path: rel, reason: 'SCHEMA_UNSUPPORTED' });
        continue;
      }
      receipts.push({ path: rel, receipt: read.value });
    }
  }
  for (const item of scanLegacyInstallDir(projectRoot)) legacy.push(item);
  return { receipts, invalid, legacy };
}

/** `r2c.install/v1` receipts still sitting in `.r2c/install/*.json`. */
export function scanLegacyInstallDir(projectRoot) {
  const dir = join(projectRoot, ...INSTALL_DIR.split('/'));
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort(compareCodePoints);
  } catch {
    names = [];
  }
  const out = [];
  for (const name of names) {
    const rel = `${INSTALL_DIR}/${name}`;
    const read = readJsonFile(join(projectRoot, ...rel.split('/')));
    if (read.ok && read.value?.schema === LEGACY_RECEIPT_SCHEMA) {
      out.push({ path: rel, receipt: read.value });
    }
  }
  return out;
}

/** Read one receipt by identity; `null` when absent, throws on a bad file. */
export function readReceipt(projectRoot, projectionId, bundleId) {
  const rel = receiptRelPath(projectionId, bundleId);
  const file = join(projectRoot, ...rel.split('/'));
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!isReceiptV2(value)) {
    const error = new Error(`unsupported receipt schema at ${rel}`);
    error.code = 'RECEIPT_SCHEMA_UNSUPPORTED';
    throw error;
  }
  return { path: rel, receipt: value };
}

/** True when the receipt bytes are canonical (doctor uses this). */
export function isCanonicalReceipt(text) {
  return isCanonicalJson(text);
}
