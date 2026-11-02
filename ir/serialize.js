/**
 * Canonical IR serialization and digest.
 *
 * `serializeIr` re-emits top-level members in schema writing order, so a caller
 * cannot accidentally change bytes by building the object in another order.
 * Hashing is injected (Node `crypto` / browser `crypto.subtle`) exactly like
 * `validateIr`, keeping this module free of Node builtins.
 */
import { canonicalJson } from '../core/canonical-json.js';
import { IR_FIELDS } from './schema.js';

const encoder = new TextEncoder();

/** Canonical IR bytes as a string (UTF-8, LF, no BOM). */
export function serializeIr(ir) {
  const ordered = {};
  for (const field of IR_FIELDS) {
    if (ir !== null && typeof ir === 'object' && Object.prototype.hasOwnProperty.call(ir, field)) {
      ordered[field] = ir[field];
    }
  }
  for (const key of Object.keys(ir ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) ordered[key] = ir[key];
  }
  return canonicalJson(ordered);
}

/**
 * SHA-256 of the serialized IR. Pass the host primitive as a function or as
 * `{ sha256 }`; the hash is never reimplemented here.
 */
export function digestOfIr(bytes, primitives) {
  const sha256 = typeof primitives === 'function' ? primitives : primitives?.sha256;
  if (typeof sha256 !== 'function') {
    throw new TypeError('digestOfIr requires a sha256 function or { sha256 } primitives');
  }
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  return sha256(data);
}
