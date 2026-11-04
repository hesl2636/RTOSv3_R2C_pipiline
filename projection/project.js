/**
 * Projection pipeline: dispatch one registered projection and assemble the
 * canonical `hm2b.projection-result/v1` envelope (#69 §7, CONTEXT §11).
 *
 * The projection implementation returns the semantic body (targets, coverage,
 * files, capabilities, degradations, warnings, metadata); this module is the
 * single place that orders it, builds the install plan and refuses partial
 * results.
 */
import { compareCodePoints } from '../core/code-point.js';
import { SEVERITY } from '../core/diagnostics.js';
import { validateOptions } from './options.js';
import { getProjection } from './registry.js';

export const RESULT_SCHEMA = 'hm2b.projection-result/v1';
export const INSTALL_PLAN_SCHEMA = 'hm2b.install-plan/v1';
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function projectionError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function compiledWorkflowRef(compiledWorkflow, compiledWorkflowDigest) {
  return {
    id: compiledWorkflow?.id ?? null,
    version: compiledWorkflow?.version ?? null,
    digest: compiledWorkflowDigest,
    contentSha256: compiledWorkflow?.source?.bundle?.contentSha256 ?? null,
  };
}

/**
 * Normalize one failure into the diagnostic row shape (§6): every row carries
 * `severity: 'error'` plus the CLI location fields (`path`, `pointer`), so a
 * consumer can render failures with the same code as bundle/compiled workflow diagnostics.
 */
export function failureRow(error) {
  const row = {
    severity: SEVERITY.ERROR,
    code: error.code,
    path: typeof error.path === 'string' ? error.path : '',
    pointer: typeof error.pointer === 'string' ? error.pointer : null,
    message: error.message,
  };
  if (error.target !== undefined) row.target = error.target;
  if (error.hint !== undefined) row.hint = error.hint;
  return row;
}

function failure(descriptor, compiledWorkflow, compiledWorkflowDigest, errors) {
  return {
    schema: RESULT_SCHEMA,
    ok: false,
    projection: { id: descriptor.id, version: descriptor.version },
    compiledWorkflow: compiledWorkflowRef(compiledWorkflow, compiledWorkflowDigest),
    errors: errors.map(failureRow),
  };
}

function compareNullable(left, right) {
  const a = left ?? '';
  const b = right ?? '';
  return compareCodePoints(a, b);
}

function compareDegradations(left, right) {
  return compareNullable(left.target, right.target)
    || compareNullable(left.capability, right.capability)
    || compareCodePoints(left.pointer, right.pointer)
    || compareCodePoints(left.code, right.code);
}

function compareWarnings(left, right) {
  return compareCodePoints(left.code, right.code)
    || compareNullable(left.pointer, right.pointer)
    || compareNullable(left.target, right.target);
}

/**
 * `project({projectionId, compiledWorkflow, compiledWorkflowDigest, options, environment, assets})`.
 * Returns a success or failure result; failures never carry partial files.
 */
export function project({ projectionId, compiledWorkflow, compiledWorkflowDigest, options, environment = {}, assets = {} }) {
  const descriptor = getProjection(projectionId);
  if (descriptor === null) throw projectionError('PROJECTION_NOT_REGISTERED', `projection ${projectionId} is not registered`);
  if (compiledWorkflow === null || typeof compiledWorkflow !== 'object' || compiledWorkflow.schema !== descriptor.api.compiledWorkflow) {
    return failure(descriptor, compiledWorkflow, compiledWorkflowDigest, [{
      code: 'PROJECTION_COMPILED_WORKFLOW_UNSUPPORTED',
      message: `unsupported compiled workflow schema ${String(compiledWorkflow?.schema)}`,
    }]);
  }
  const check = validateOptions({ projectionId, compiledWorkflow, compiledWorkflowDigest, options, manifest: descriptor });
  if (!check.ok) return failure(descriptor, compiledWorkflow, compiledWorkflowDigest, check.errors);

  let body;
  try {
    body = descriptor.project({ compiledWorkflow, compiledWorkflowDigest, options, environment, assets });
  } catch (error) {
    return failure(descriptor, compiledWorkflow, compiledWorkflowDigest, [{
      code: error?.code ?? 'PROJECTION_INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
  if (body.ok === false) return failure(descriptor, compiledWorkflow, compiledWorkflowDigest, body.errors);

  const files = [...body.files].sort((left, right) => compareCodePoints(left.path, right.path));
  let totalBytes = 0;
  for (const file of files) {
    const bytes = encoder.encode(file.content).length;
    if (bytes > MAX_FILE_BYTES) {
      return failure(descriptor, compiledWorkflow, compiledWorkflowDigest, [{
        code: 'PROJECTION_OUTPUT_TOO_LARGE',
        message: `${file.path} exceeds 4 MiB`,
        pointer: file.path,
      }]);
    }
    totalBytes += bytes;
  }
  if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
    return failure(descriptor, compiledWorkflow, compiledWorkflowDigest, [{
      code: 'PROJECTION_OUTPUT_TOO_LARGE',
      message: `projection output exceeds ${MAX_FILES} files or 64 MiB`,
    }]);
  }

  return {
    schema: RESULT_SCHEMA,
    ok: true,
    projection: { id: descriptor.id, version: descriptor.version },
    compiledWorkflow: compiledWorkflowRef(compiledWorkflow, compiledWorkflowDigest),
    options: {
      schema: options.schema,
      projection: options.projection,
      compiledWorkflow: options.compiledWorkflow,
      stageOrder: options.stageOrder,
      skills: options.skills,
      targets: options.targets,
      extra: options.extra,
    },
    environment: { engineVersion: environment?.engineVersion ?? null },
    targets: body.targets,
    coverage: body.coverage,
    files,
    installPlan: {
      schema: INSTALL_PLAN_SCHEMA,
      root: 'project',
      steps: files.map((file) => ({ op: 'write', path: file.path, overwrite: 'replace' })),
    },
    capabilityReport: body.capabilityReport,
    degradations: [...body.degradations].sort(compareDegradations),
    warnings: [...body.warnings].sort(compareWarnings),
    metadata: body.metadata,
  };
}
