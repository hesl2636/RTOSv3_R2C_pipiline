/**
 * Projection-result fixtures for the installer tests.
 *
 * The installer never projects: these helpers produce the `runner` result and
 * the compiled workflow bytes the result is bound to (V1), so a test can install the real
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

export const COMPILED_WORKFLOW_FIXTURE = join(ROOT, 'test/fixtures/compiled/workflow.compiled.json');

const cache = new Map();

/** `{compiledWorkflow, compiledWorkflowBytes, compiledWorkflowDigest, results: Map<projection, result>}`. */
export function sample(projectionId = 'runner', raw = {}) {
  const key = `${projectionId}|${JSON.stringify(raw)}`;
  if (cache.has(key)) return cache.get(key);
  const compiledWorkflowBytes = readFileSync(COMPILED_WORKFLOW_FIXTURE);
  const compiledWorkflow = JSON.parse(compiledWorkflowBytes.toString('utf8'));
  const compiledWorkflowDigest = sha256Hex(compiledWorkflowBytes);
  const descriptor = getProjection(projectionId);
  const { options } = normalizeOptions({ projectionId, compiledWorkflow, compiledWorkflowDigest, raw, manifest: descriptor });
  const result = project({ projectionId, compiledWorkflow, compiledWorkflowDigest, options, environment: {}, assets: {} });
  const value = { compiledWorkflow, compiledWorkflowBytes, compiledWorkflowDigest, options, result, descriptor };
  cache.set(key, value);
  return value;
}

/** Fixed clock so receipts are byte-stable across runs. */
export function fixedClock(iso = '2026-01-01T00:00:00.000Z') {
  return () => new Date(iso);
}

/**
 * Project a variant of the fixture compiled workflow: `compiledWorkflowPatch` overrides top-level fields
 * (a new `version` or `id` makes a genuinely different install identity) and
 * `raw` feeds projection options, exactly like `sample()`.
 */
export function customSample({ projectionId = 'runner', compiledWorkflowPatch = {}, raw = {} } = {}) {
  const compiledWorkflow = JSON.parse(readFileSync(COMPILED_WORKFLOW_FIXTURE, 'utf8'));
  Object.assign(compiledWorkflow, compiledWorkflowPatch);
  const compiledWorkflowBytes = Buffer.from(canonicalJson(compiledWorkflow), 'utf8');
  const compiledWorkflowDigest = sha256Hex(compiledWorkflowBytes);
  const descriptor = getProjection(projectionId);
  const { options } = normalizeOptions({ projectionId, compiledWorkflow, compiledWorkflowDigest, raw, manifest: descriptor });
  const result = project({ projectionId, compiledWorkflow, compiledWorkflowDigest, options, environment: {}, assets: {} });
  return { compiledWorkflow, compiledWorkflowBytes, compiledWorkflowDigest, options, result, descriptor };
}

/** Clone a result and let the caller mutate the clone (negative cases). */
export function cloneResult(result) {
  return JSON.parse(JSON.stringify(result));
}
