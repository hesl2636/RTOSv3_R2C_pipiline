/**
 * Bundle validation entry point.
 *
 * `analyzeBundle` returns both the report and the parsed model used by the
 * compiler, so validation never runs twice. `validateBundle` is the pure
 * bytes-in/report-out function of decision #67 §3.
 */
import { buildReport } from '../core/diagnostics.js';
import { createContext, flushDiagnostics } from './checks/context.js';
import { runChecks } from './checks/index.js';
import { BUNDLE_SCHEMA } from './checks/manifest.js';
import { readZip } from './zip.js';

export const BUNDLE_SUMMARY_CODE = 'BUNDLE_INVALID';

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(0);
}

/**
 * @param {Uint8Array} input zip bytes
 * @param {{ inflateRaw?: Function, sha256?: Function }} primitives
 * @param {{ path?: string }} [options] display name for `artifact.path`
 * @returns {{ report: object, model: object }}
 */
export function analyzeBundle(input, primitives = {}, options = {}) {
  const bytes = asBytes(input);
  const artifactPath = options.path ?? 'bundle.zip';
  const zip = readZip(bytes, primitives);
  const context = createContext({ bytes, zip, primitives, artifactPath });
  context.diagnostics.push(...zip.diagnostics);
  // A cumulative-inflation abort leaves the archive only partially decoded:
  // content phases cannot trust the entry set, so only container checks run.
  if (!zip.readable || zip.container.aborted === true) context.skipContent();
  if (zip.readable) runChecks(context);
  const { errors, warnings } = flushDiagnostics(context);
  const manifest = context.manifest;
  const schema = manifest !== null && manifest.schema === BUNDLE_SCHEMA ? manifest.schema : null;
  const report = buildReport({
    target: 'bundle',
    schema,
    artifact: {
      path: artifactPath,
      bytes: bytes.length,
      sha256: typeof primitives.sha256 === 'function' ? primitives.sha256(bytes) : null,
    },
    id: manifest !== null && typeof manifest.id === 'string' ? manifest.id : null,
    version: manifest !== null && typeof manifest.version === 'string' ? manifest.version : null,
    counts: context.counts,
    errors,
    warnings,
  });
  return { report, model: context };
}

/** Validate a zip and return only the report. */
export function validateBundle(input, primitives = {}, options = {}) {
  return analyzeBundle(input, primitives, options).report;
}
