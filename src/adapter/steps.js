/**
 * The single procedural escape hatch for adapters.
 *
 * `adapters/<id>/steps.mjs` may export `postInstall(context)`,
 * `preUninstall(context)` and `rollback(context)`. The context is a
 * JSON-serialisable object owned by the installer; a step returns
 * `{ warnings, leftover, receipt, undo }`. `undo` is persisted in the pending
 * marker so a later smoke failure (or an interrupted install) can reverse
 * external state before the file-level rollback runs.
 *
 * Steps are imported in-process so they can reuse the payload's own modules;
 * a thrown step is always converted into an r2c error with exit code 3.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT_CODES, R2cError } from '../errors.js';

function stepError(code, message, details = null) {
  return new R2cError(code, message, details, EXIT_CODES.GATE);
}

/** Locate the adapter's steps file in the resolved payload or an installed payload. */
export function stepsFile(resolved, agentId, home) {
  const rel = `adapters/${agentId}/steps.mjs`;
  const entry = resolved?.entries?.find((candidate) => candidate.rel === rel);
  if (entry !== undefined) return entry.abs;
  const installed = join(home, 'adapters', agentId, 'steps.mjs');
  return existsSync(installed) ? installed : null;
}

function handlerName(phase) {
  if (phase === 'post-install') return 'postInstall';
  if (phase === 'pre-uninstall') return 'preUninstall';
  return 'rollback';
}

function normalizeResult(result, phase, file) {
  if (result === undefined || result === null) return {};
  if (typeof result !== 'object' || Array.isArray(result)) {
    throw stepError('STEPS_INVALID_RESULT', 'adapter step returned a non-object result', {
      file,
      phase,
    });
  }
  return {
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    leftover: Array.isArray(result.leftover) ? result.leftover.map(String) : [],
    receipt: result.receipt !== null && typeof result.receipt === 'object' && !Array.isArray(result.receipt)
      ? result.receipt
      : null,
    undo: result.undo ?? null,
  };
}

/**
 * Run one step phase. Missing handlers return `null` so callers can tell
 * "adapter has no such phase" from "adapter returned an empty object".
 */
export async function runAdapterStep(file, phase, context) {
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    throw stepError('STEPS_IMPORT_FAILED', `cannot import ${file}: ${error.message}`, {
      file,
      phase,
    });
  }
  const handler = module[handlerName(phase)];
  if (typeof handler !== 'function') return null;
  let result;
  try {
    result = await handler(context);
  } catch (error) {
    throw stepError('STEPS_FAILED', `${phase} step failed for ${context.adapter}: ${error.message}`, {
      file,
      phase,
      adapter: context.adapter,
    });
  }
  return normalizeResult(result, phase, file);
}

/** Best-effort rollback of a previous post-install result. */
export async function undoAdapterStep(step, warnings) {
  if (step === null || step === undefined || step.undo === null || step.undo === undefined) return;
  try {
    await runAdapterStep(step.file, 'rollback', { ...step.context, undo: step.undo });
  } catch (error) {
    warnings?.push(`steps-rollback-failed:${error.message}`);
  }
}
