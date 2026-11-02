/**
 * Shared validation context.
 *
 * Modules append diagnostics through `ctx.fail` / `ctx.warn`; a failed
 * prerequisite sets `ctx.skipped.<area>` so later modules can return early
 * (decision #67 §6.2). `flushDiagnostics` performs the contract sort and
 * dedupe, never the modules.
 */
import {
  SEVERITY,
  dedupeDiagnostics,
  makeDiagnostic,
  sortDiagnostics,
} from '../../core/diagnostics.js';
import { LIMITS } from '../limits.js';

const AREAS = ['container', 'manifest', 'stages', 'tasks', 'entities', 'crossrefs'];

export function createContext({ bytes, zip, primitives, limits = LIMITS, artifactPath = 'bundle.zip' }) {
  const context = {
    bytes,
    primitives,
    limits,
    artifactPath,
    entries: zip.entries,
    directories: zip.directories,
    rejected: zip.rejected,
    rejectedPaths: new Set(zip.rejected.map((item) => item.path)),
    undecodable: new Set(),
    texts: new Map(),
    manifest: null,
    manifestBytes: null,
    declared: { stages: [], roles: [], tasks: [], skills: [] },
    declaredValid: { stages: true, roles: true, tasks: true, skills: true },
    stages: null,
    tasks: null,
    roles: null,
    skills: null,
    constitution: null,
    stepIds: new Set(),
    stepFirst: new Map(),
    complete: { stages: true },
    counts: { stages: 0, steps: 0, roles: 0, tasks: 0, skills: 0, constitutions: 0 },
    diagnostics: [],
    skipped: Object.fromEntries(AREAS.map((area) => [area, false])),
  };

  context.fail = (path, code, message, extra = {}) => {
    context.diagnostics.push(makeDiagnostic({
      severity: SEVERITY.ERROR,
      code,
      path,
      line: extra.line ?? null,
      pointer: extra.pointer ?? null,
      message,
      details: extra.details,
    }));
  };
  context.warn = (path, code, message, extra = {}) => {
    context.diagnostics.push(makeDiagnostic({
      severity: SEVERITY.WARNING,
      code,
      path,
      line: extra.line ?? null,
      pointer: extra.pointer ?? null,
      message,
      details: extra.details,
    }));
  };
  context.skip = (area) => {
    if (area in context.skipped) context.skipped[area] = true;
  };
  context.skipContent = () => {
    for (const area of ['manifest', 'stages', 'tasks', 'entities', 'crossrefs']) context.skip(area);
  };
  return context;
}

export function flushDiagnostics(context) {
  const errors = [];
  const warnings = [];
  for (const diagnostic of context.diagnostics) {
    if (diagnostic.severity === SEVERITY.WARNING) warnings.push(diagnostic);
    else errors.push(diagnostic);
  }
  return {
    errors: dedupeDiagnostics(sortDiagnostics(errors)),
    warnings: dedupeDiagnostics(sortDiagnostics(warnings)),
  };
}

export { AREAS as CHECK_AREAS };
