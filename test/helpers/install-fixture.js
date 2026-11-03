/**
 * Projection-result fixtures for the installer tests.
 *
 * The installer never projects: these helpers produce the `runner` result and
 * the IR bytes the result is bound to (V1), so a test can install the real
 * sample payload without re-implementing the projection.
 */
import { canonicalJson } from '../../core/canonical-json.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../core/node/sha256.js';
import { normalizeOptions } from '../../projection/options.js';
import { project } from '../../projection/project.js';
import { getProjection } from '../../projection/registry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const IR_FIXTURE = join(ROOT, 'test/fixtures/ir/workflow.ir.json');

const cache = new Map();

/** `{ir, irBytes, irDigest, results: Map<projection, result>}`. */
export function sample(projectionId = 'runner', raw = {}) {
  const key = `${projectionId}|${JSON.stringify(raw)}`;
  if (cache.has(key)) return cache.get(key);
  const irBytes = readFileSync(IR_FIXTURE);
  const ir = JSON.parse(irBytes.toString('utf8'));
  const irDigest = sha256Hex(irBytes);
  const descriptor = getProjection(projectionId);
  const { options } = normalizeOptions({ projectionId, ir, irDigest, raw, manifest: descriptor });
  const result = project({ projectionId, ir, irDigest, options, environment: {}, assets: {} });
  const value = { ir, irBytes, irDigest, options, result, descriptor };
  cache.set(key, value);
  return value;
}

/** Fixed clock so receipts are byte-stable across runs. */
export function fixedClock(iso = '2026-01-01T00:00:00.000Z') {
  return () => new Date(iso);
}

/**
 * Project a variant of the fixture IR: `irPatch` overrides top-level fields
 * (a new `version` or `id` makes a genuinely different install identity) and
 * `raw` feeds projection options, exactly like `sample()`.
 */
export function customSample({ projectionId = 'runner', irPatch = {}, raw = {} } = {}) {
  const ir = JSON.parse(readFileSync(IR_FIXTURE, 'utf8'));
  Object.assign(ir, irPatch);
  const irBytes = Buffer.from(canonicalJson(ir), 'utf8');
  const irDigest = sha256Hex(irBytes);
  const descriptor = getProjection(projectionId);
  const { options } = normalizeOptions({ projectionId, ir, irDigest, raw, manifest: descriptor });
  const result = project({ projectionId, ir, irDigest, options, environment: {}, assets: {} });
  return { ir, irBytes, irDigest, options, result, descriptor };
}

/** Clone a result and let the caller mutate the clone (negative cases). */
export function cloneResult(result) {
  return JSON.parse(JSON.stringify(result));
}
