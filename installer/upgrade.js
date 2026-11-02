/**
 * Same-identity upgrade diff (#76 §6.4, spec §12).
 *
 * The diff is a pure record of the receipt `files[]` path/hash difference. The
 * installer owns the write decisions (see `conflict.js`); this module must not
 * decide what lands on disk, so the report cannot disagree with the receipt.
 */
import { comparePaths } from '../core/paths.js';

const ADD = 'add';
const REMOVE = 'remove';
const CHANGE = 'change';
const KEEP = 'keep';

function sorted(paths) {
  return [...paths].sort(comparePaths);
}

/**
 * `add`    — new result paths the old receipt did not own;
 * `remove` — old receipt paths the new result no longer ships;
 * `change` — paths in both whose recorded content hash differs;
 * `keep`   — paths in both with the same content hash.
 *
 * `remove` is a plan, not a promise: `conflict.js` keeps a removal whose disk
 * bytes no longer match the old receipt and raises `STALE_MODIFIED_KEPT`.
 */
export function diffFileSets(previousFiles = [], incoming = []) {
  const previousByPath = new Map((previousFiles ?? []).map((file) => [file.path, file]));
  const incomingByPath = new Map((incoming ?? []).map((file) => [file.path, file]));
  const add = [];
  const remove = [];
  const change = [];
  const keep = [];

  for (const entry of incomingByPath.values()) {
    const previous = previousByPath.get(entry.path);
    if (previous === undefined) add.push(entry.path);
    else if (previous.sha256 !== entry.sha256) change.push(entry.path);
    else keep.push(entry.path);
  }
  for (const path of previousByPath.keys()) {
    if (!incomingByPath.has(path)) remove.push(path);
  }

  return {
    [ADD]: sorted(add),
    [REMOVE]: sorted(remove),
    [CHANGE]: sorted(change),
    [KEEP]: sorted(keep),
  };
}

/**
 * The `previous` receipt field: everything needed to reconstruct which
 * identity just got replaced, without trusting the overwritten receipt file.
 * `receipt` keeps the frozen `r2c.install/v2` field from #76 §5.2.
 */
export function previousRecord(previous, receiptPath) {
  if (previous === null || previous === undefined) return null;
  const receipt = previous.receipt ?? {};
  const options = receipt.options ?? null;
  return {
    path: receiptPath,
    receipt: receiptPath,
    version: receipt.bundle?.version ?? null,
    digest: options?.digest ?? null,
    ir_digest: receipt.ir?.digest ?? null,
    options,
  };
}
