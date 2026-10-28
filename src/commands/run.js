/**
 * `r2c run`: create a run from the discovered manifest, then deliver the first
 * step. When no session id is supplied the run mints `cli-<runId>`; an explicit
 * synthetic id is reserved and an explicit session with a live run is refused.
 */
import { R2cError, EXIT_CODES } from '../errors.js';
import { loadManifest } from '../manifest.js';
import { assertRenderableSteps, defaultRunnerCommand, renderStep } from '../render.js';
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

  const loaded = loadManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  assertRenderableSteps(loaded.data, loaded.root);
  const created = createRun({
    root: ctx.projectRoot,
    manifest: loaded.data,
    manifestPath: loaded.manifestPath,
    sessionId: explicit,
    engineVersion: ctx.version,
    userInput: ctx.input,
    now: ctx.now(),
  });

  const runnerCmd = ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath);
  const text = renderStep({
    manifest: loaded.data,
    root: loaded.root,
    stepId: created.state.current_step_id,
    runnerCmd,
    sessionId: created.sessionId,
  });
  const step = created.state.steps.find((item) => item.id === created.state.current_step_id);
  return {
    runId: created.runId,
    sessionId: created.sessionId,
    step: { id: step.id, name: step.name, status: step.status },
    text,
    data: {
      status: created.state.status,
      workflow_id: created.state.workflow_id,
      current_step_id: created.state.current_step_id,
      text,
    },
  };
}
