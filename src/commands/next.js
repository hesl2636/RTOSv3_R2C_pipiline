/**
 * `r2c next`: read-only delivery. Text is produced only when the run is running
 * and its current step is active; every other state exits 4 with no stdout.
 */
import { R2cError, EXIT_CODES } from '../errors.js';
import { loadManifest } from '../manifest.js';
import { defaultRunnerCommand, renderStep } from '../render.js';
import { resolveRunForSession } from '../state.js';

export async function run(_argv, ctx) {
  const loadedRun = resolveRunForSession({
    root: ctx.projectRoot,
    sessionId: ctx.sessionId,
    fallbackToLatest: true,
  });
  if (loadedRun === null) {
    throw new R2cError(
      'NO_ACTIVE_RUN',
      'no active run for this session',
      { session_id: ctx.sessionId ?? null },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const { state } = loadedRun;
  const current = state.steps.find((step) => step.id === state.current_step_id);
  if (state.status !== 'running' || !current || current.status !== 'active') {
    throw new R2cError(
      'NO_ACTIVE_RUN',
      'run is not running with an active current step',
      { run_id: state.run_id, status: state.status },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const manifest = loadManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const runnerCmd = ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath);
  const sessionId = state.session_id;
  const text = renderStep({
    manifest: manifest.data,
    root: manifest.root,
    stepId: state.current_step_id,
    runnerCmd,
    sessionId,
    manifestPath: ctx.manifest ?? null,
  });
  return {
    runId: state.run_id,
    sessionId,
    step: { id: current.id, name: current.name, status: current.status },
    text,
    data: {
      status: state.status,
      workflow_id: state.workflow_id,
      current_step_id: state.current_step_id,
      text,
    },
  };
}
