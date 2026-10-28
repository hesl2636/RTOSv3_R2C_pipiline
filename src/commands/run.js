/**
 * `r2c run`: create a run from the discovered manifest, execute any leading
 * shell steps, then deliver the first prompt step. When no session id is
 * supplied the run mints `cli-<runId>`; an explicit synthetic id is reserved
 * and an explicit session with a live run is refused.
 *
 * The manifest is strictly validated with the same implementation as
 * `r2c validate` before anything under `.r2c/` is written.
 */
import { EXIT_CODES, R2cError } from '../errors.js';
import { inspectManifest, manifestError } from '../manifest.js';
import { assertRenderableSteps, defaultRunnerCommand, renderCompleted, renderStep } from '../render.js';
import { executeShellSteps } from '../shell.js';
import { createRun, hasRunningRun, isCliSessionId } from '../state.js';

export async function run(_argv, ctx) {
  const explicit = ctx.sessionId ?? null;
  if (explicit !== null && isCliSessionId(explicit)) {
    throw new R2cError(
      'SESSION_ID_RESERVED',
      `session id is reserved for minted runs: ${explicit}`,
      { session_id: explicit },
      EXIT_CODES.USAGE,
    );
  }
  if (explicit !== null && hasRunningRun(ctx.projectRoot, explicit)) {
    throw new R2cError(
      'RUN_ALREADY_ACTIVE',
      `session already has a running run: ${explicit}`,
      { session_id: explicit },
      EXIT_CODES.USAGE,
    );
  }

  const inspected = inspectManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  if (inspected.errors.length > 0) {
    if (!ctx.json) {
      for (const error of inspected.errors) {
        process.stderr.write(`error: ${error.path}: ${error.message} [${error.code}]\n`);
      }
      for (const warning of inspected.warnings) {
        process.stderr.write(`warning: ${warning.path}: ${warning.message}\n`);
      }
    }
    throw manifestError(inspected);
  }
  if (!ctx.json) {
    for (const warning of inspected.warnings) {
      process.stderr.write(`warning: ${warning.path}: ${warning.message}\n`);
    }
  }

  assertRenderableSteps(inspected.data, inspected.root);
  const created = createRun({
    root: ctx.projectRoot,
    manifest: inspected.data,
    manifestPath: inspected.manifestPath,
    sessionId: explicit,
    engineVersion: ctx.version,
    userInput: ctx.input,
    now: ctx.now(),
  });

  const runnerCmd = ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath);
  const settled = await executeShellSteps({
    manifest: inspected.data,
    projectRoot: ctx.projectRoot,
    state: created.state,
    runId: created.runId,
    startIndex: 0,
    now: ctx.now,
  });
  const step = settled.step;
  const text = step === null
    ? renderCompleted(created.runId)
    : renderStep({
        manifest: inspected.data,
        root: inspected.root,
        stepId: step.id,
        runnerCmd,
        sessionId: created.sessionId,
      });
  return {
    runId: created.runId,
    sessionId: created.sessionId,
    step: step === null ? null : { id: step.id, name: step.name, status: step.status },
    text,
    data: {
      status: created.state.status,
      workflow_id: created.state.workflow_id,
      current_step_id: created.state.current_step_id,
      text,
      warnings: inspected.warnings,
    },
  };
}
