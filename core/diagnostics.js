/**
 * Diagnostic, Report and JSON-envelope contract (decision #67 §2.4/§2.5/§4).
 *
 * One rule -> one code; one violation -> one diagnostic. Reports are values:
 * the same bytes produce a byte-identical report (no timestamps, no absolute
 * paths, deterministic order). The summary code (`BUNDLE_INVALID` /
 * `IR_INVALID`) only ever appears in `envelope.error.code`.
 */
import { compareCodePoints, codePointLength, sliceCodePoints } from './code-point.js';

export const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
});

const MESSAGE_MAX_CODE_POINTS = 120;

function clipMessage(message) {
  const raw = typeof message === 'string' ? message : String(message ?? '');
  const singleLine = raw.replace(/\s*\n\s*/g, ' ').trim();
  if (codePointLength(singleLine) <= MESSAGE_MAX_CODE_POINTS) return singleLine;
  return `${sliceCodePoints(singleLine, 0, MESSAGE_MAX_CODE_POINTS - 1)}…`;
}

/**
 * Build one diagnostic. Field order is fixed:
 * `severity, code, path, line, pointer, message, details?`.
 */
export function makeDiagnostic({
  severity,
  code,
  path = '',
  line = null,
  pointer = null,
  message,
  details,
}) {
  const diagnostic = {
    severity,
    code,
    path,
    line: line ?? null,
    pointer: pointer ?? null,
    message: clipMessage(message),
  };
  if (details !== undefined) diagnostic.details = details;
  return diagnostic;
}

function compareNullableNumbers(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return left < right ? -1 : 1;
}

function compareNullableStrings(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return compareCodePoints(left, right);
}

/** Order: path -> pointer (null first) -> line (null first) -> code. */
export function compareDiagnostics(left, right) {
  return compareCodePoints(left.path, right.path)
    || compareNullableStrings(left.pointer, right.pointer)
    || compareNullableNumbers(left.line, right.line)
    || compareCodePoints(left.code, right.code);
}

function dedupeKey(diagnostic) {
  return [
    diagnostic.code,
    diagnostic.path,
    diagnostic.pointer === null ? '\u0000null' : diagnostic.pointer,
    diagnostic.line === null ? '\u0000null' : String(diagnostic.line),
  ].join('\u0000');
}

/** Stable sort by the contract comparator, then keep the first duplicate. */
export function sortDiagnostics(list) {
  return [...list].sort(compareDiagnostics);
}

export function dedupeDiagnostics(list) {
  const seen = new Set();
  const out = [];
  for (const diagnostic of list) {
    const key = dedupeKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

const COUNT_KEYS = ['stages', 'steps', 'roles', 'tasks', 'skills', 'constitutions'];

/**
 * Build a report. `ok` is derived from `errors` only; `counts` is informative.
 */
export function buildReport({
  target,
  schema = null,
  artifact = { path: '', bytes: 0, sha256: null },
  id = null,
  version = null,
  counts = {},
  errors = [],
  warnings = [],
}) {
  const sortedErrors = dedupeDiagnostics(sortDiagnostics(errors));
  const sortedWarnings = dedupeDiagnostics(sortDiagnostics(warnings));
  const counted = {};
  for (const key of COUNT_KEYS) counted[key] = counts[key] ?? 0;
  counted.errors = sortedErrors.length;
  counted.warnings = sortedWarnings.length;
  return {
    target,
    schema,
    artifact,
    id,
    version,
    ok: sortedErrors.length === 0,
    counts: counted,
    errors: sortedErrors,
    warnings: sortedWarnings,
  };
}

/** The single `--json` envelope shape shared by CLI and HTTP. */
export function toEnvelope({
  command = null,
  code,
  data = null,
  error = null,
  runId = null,
  sessionId = null,
  step = null,
}) {
  return {
    ok: error === null,
    command,
    code,
    run_id: runId,
    session_id: sessionId,
    step,
    data,
    error,
  };
}

function locationOf(diagnostic, target) {
  const where = diagnostic.path === '' ? target : diagnostic.path;
  if (diagnostic.line !== null && diagnostic.line !== undefined) return `${where}:${diagnostic.line}`;
  if (diagnostic.pointer !== null && diagnostic.pointer !== undefined) return `${where}${diagnostic.pointer}`;
  return where;
}

/**
 * The failure summary for `envelope.error` (decision #67 §4 rule 2).
 * A single distinct code is preserved; multiple codes collapse to the family
 * summary code. The report itself stays the only copy of the arrays.
 */
export function reportFailureSummary(report, summaryCode) {
  const details = {
    target: report.target,
    errors: report.errors.length,
    warnings: report.warnings.length,
  };
  const codes = new Set(report.errors.map((diagnostic) => diagnostic.code));
  const first = report.errors[0];
  if (codes.size === 1 && report.errors.length === 1) {
    return { code: first.code, message: first.message, details };
  }
  if (codes.size === 1) {
    return {
      code: first.code,
      message: `${report.target} invalid: ${report.errors.length} error(s), first: ${locationOf(first, report.target)}: ${first.message}`,
      details,
    };
  }
  return {
    code: summaryCode,
    message: `${report.target} invalid: ${report.errors.length} error(s), first: ${locationOf(first, report.target)}: ${first.message}`,
    details,
  };
}
