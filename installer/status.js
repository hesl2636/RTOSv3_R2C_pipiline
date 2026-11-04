/**
 * Installer `status` (#104, #76 §7.1): the authoritative view that works
 * without a run. It reads receipts, `runtime.json`, `workflows/*.yaml` and the
 * journal only; it never hashes files (that is `doctor`'s job).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { compareCodePoints } from '../core/code-point.js';
import { foldCase } from '../core/paths.js';
import { RECEIPT_SCHEMA, RECEIPTS_DIR } from './paths.js';
import { readJournal } from './transaction.js';
import { readReceipts } from './receipt.js';
import { readRuntimeReceipt } from './runtime.js';
import { sorted } from '../core/sort.js';

export const STATUS_SCHEMA = 'hm2b.install-status/v1';

/** Cross-receipt ownership conflicts (literal, case-folded and prefix). */
function receiptConflicts(receipts) {
  const owners = new Map();
  for (const item of receipts) {
    const identity = `${item.receipt.projection?.id ?? '?'}/${item.receipt.bundle?.id ?? '?'}`;
    for (const file of item.receipt.files ?? []) {
      const key = foldCase(file.path);
      const list = owners.get(key) ?? [];
      list.push({ identity, path: file.path, receipt: item.path });
      owners.set(key, list);
    }
  }
  const conflicts = [];
  for (const list of owners.values()) {
    if (new Set(list.map((entry) => entry.identity)).size > 1) {
      conflicts.push({
        code: 'INSTALL_PATH_CONFLICT',
        path: list[0].path,
        owners: list.map((entry) => entry.identity),
        receipts: list.map((entry) => entry.receipt),
        receipt: list[0].receipt,
      });
    }
  }
  const paths = [...new Set([...owners.values()].flat().map((entry) => entry.path))].sort(compareCodePoints);
  for (let index = 0; index < paths.length; index += 1) {
    for (let inner = index + 1; inner < paths.length; inner += 1) {
      if (!foldCase(paths[inner]).startsWith(`${foldCase(paths[index])}/`)) continue;
      const left = owners.get(foldCase(paths[index]))[0];
      const right = owners.get(foldCase(paths[inner]))[0];
      conflicts.push({
        code: 'INSTALL_PATH_CONFLICT',
        path: `${paths[index]} <> ${paths[inner]}`,
        owners: [left.identity, right.identity],
        receipts: [left.receipt, right.receipt],
        receipt: right.receipt,
      });
    }
  }
  return conflicts;
}

export function manifestSelection(projectRoot) {
  const dir = join(projectRoot, 'workflows');
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareCodePoints);
  } catch {
    names = [];
  }
  const candidates = names.map((name) => `workflows/${name}`);
  if (candidates.length === 1) return { selection: 'single', path: candidates[0], candidates };
  if (candidates.length === 0) return { selection: 'missing', path: null, candidates };
  return { selection: 'ambiguous', path: null, candidates };
}

function engineView(projectRoot) {
  let runtime;
  try {
    runtime = readRuntimeReceipt(projectRoot);
  } catch {
    return null;
  }
  if (runtime === null) return null;
  const entry = runtime.engine?.entry;
  const absolute = typeof entry === 'string' && isAbsolute(entry) ? entry : join(projectRoot, ...String(entry).split('/'));
  return {
    version: runtime.engine?.version ?? null,
    entry: entry ?? null,
    ok: typeof entry === 'string' && entry !== '' && existsSync(absolute),
  };
}

function supportedInstall(item) {
  const receipt = item.receipt;
  const receiptFiles = Array.isArray(receipt.files) ? receipt.files.length : 0;
  return {
    projection: receipt.projection?.id ?? null,
    bundle: receipt.bundle?.id ?? null,
    version: receipt.bundle?.version ?? null,
    mode: receipt.mode ?? null,
    targets: sorted(receipt.host_targets ?? receipt.projection?.targets ?? []),
    files: receiptFiles,
    receiptFiles,
    receipt: item.path,
    problems: [],
  };
}

function unsupportedInstall(item) {
  let value = {};
  try {
    value = JSON.parse(readFileSync(join(item.root, ...item.path.split('/')), 'utf8'));
  } catch {
    value = {};
  }
  const reason = item.reason ?? (typeof value.schema === 'string' && value.schema !== RECEIPT_SCHEMA ? 'SCHEMA_UNSUPPORTED' : 'UNREADABLE');
  return {
    projection: value.projection?.id ?? null,
    bundle: value.bundle?.id ?? null,
    version: null,
    targets: [],
    files: Array.isArray(value.files) ? value.files.length : 0,
    receipt: item.path,
    schema: typeof value.schema === 'string' ? value.schema : null,
    supported: false,
    problems: [reason],
  };
}

/** `hm2b.install-status/v1` object; no run state is consulted. */
export function installStatus(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const { receipts, invalid, legacy } = readReceipts(projectRoot);
  const installs = receipts.map(supportedInstall);
  const conflicts = receiptConflicts(receipts);
  for (const conflict of conflicts) {
    for (const install of installs) {
      if ((conflict.receipts ?? [conflict.receipt]).includes(install.receipt) && !install.problems.includes(conflict.code)) {
        install.problems.push(conflict.code);
      }
    }
  }
  for (const item of invalid) installs.push(unsupportedInstall({ ...item, root: projectRoot }));
  installs.sort((left, right) => compareCodePoints(left.receipt, right.receipt));

  const journal = readJournal(projectRoot);
  const manifest = manifestSelection(projectRoot);
  return {
    schema: STATUS_SCHEMA,
    root: projectRoot,
    engine: engineView(projectRoot),
    installs,
    conflicts,
    manifest,
    journal: journal === null ? null : { state: journal.state ?? null, started_at: journal.started_at ?? null },
    legacy: legacy.map((item) => item.path),
  };
}

/** Text view from #76 §7.1; every line is prefixed and greppable. */
export function formatStatus(status) {
  const lines = [];
  for (const install of status.installs) {
    if (install.supported === false) {
      lines.push(`install/${install.projection ?? '?'}/${install.bundle ?? '?'} unsupported schema=${install.schema ?? '?'}`);
      continue;
    }
    lines.push(`install/${install.projection}/${install.bundle} ${install.version} targets=${install.targets.join(',')} files=${install.files}`);
  }
  if (status.engine !== null) lines.push(`engine/${status.engine.version}`);
  const manifest = status.manifest.selection === 'single' ? status.manifest.path : status.manifest.selection;
  lines.push(`manifest/${manifest}`);
  return `${lines.join('\n')}\n`;
}
