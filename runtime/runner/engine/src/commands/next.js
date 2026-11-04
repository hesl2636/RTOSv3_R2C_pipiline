/**
 * `hm2b next`: read-only delivery. Text is produced only when the run is running
 * and its current step is active; every other state exits 4 with no stdout.
 */
import { Hm2bError, EXIT_CODES } from '../errors.js';
import { loadManifest } from '../manifest.js';
import { defaultRunnerCommand, renderStep } from '../render.js';
import { loadRun, resolveRunForSession } from '../state.js';

export async function run(_argv, ctx) {
  // Read first without repair so the manifest guard runs before any write.
  const routed = resolveRunForSession({
    root: ctx.projectRoot,
    sessionId: ctx.sessionId,
    fallbackToLatest: true,
    repair: false,
  });
  if (routed === null) {
    throw new Hm2bError(
      'NO_ACTIVE_RUN',
      'no active run for this session',
      { session_id: ctx.sessionId ?? null },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const manifest = loadManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const loaded = loadRun(ctx.projectRoot, routed.runId, { manifest: manifest.data }) ?? routed;
  const { state } = loaded;
  const current = state.steps.find((step) => step.id === state.current_step_id);
  if (state.status !== 'running' || !current || current.status !== 'active') {
    throw new Hm2bError(
      'NO_ACTIVE_RUN',
      'run is not running with an active current step',
      { run_id: state.run_id, status: state.status },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const runnerCmd = ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath, { projectRoot: ctx.projectRoot });
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
