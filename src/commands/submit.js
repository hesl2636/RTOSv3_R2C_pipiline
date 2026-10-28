/**
 * `r2c submit`: the only regular state writer. It validates the step, calls the
 * gate seam, records `submitted`, completes the step, advances the cursor and
 * delivers the next step (or the completed banner on the last step).
 */
import { R2cError, EXIT_CODES } from '../errors.js';
import { checkGates } from '../gate.js';
import { flattenSteps, loadManifest } from '../manifest.js';
import { assertRenderableSteps, defaultRunnerCommand, renderCompleted, renderStep } from '../render.js';
import {
  appendEvent,
  deactivateLatestRun,
  nowIso,
  resolveRunForSession,
  writeState,
} from '../state.js';

export async function run(_argv, ctx) {
  if (!ctx.sessionId) {
    throw new R2cError(
      'MISSING_SESSION',
      'submit requires --session-id (or R2C_SESSION_ID)',
      { option: '--session-id' },
      EXIT_CODES.USAGE,
    );
  }

  const loadedRun = resolveRunForSession({
    root: ctx.projectRoot,
    sessionId: ctx.sessionId,
    fallbackToLatest: false,
  });
  if (loadedRun === null) {
    throw new R2cError(
      'NO_ACTIVE_RUN',
      'no active run for this session',
      { session_id: ctx.sessionId },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const { runId, state } = loadedRun;
  if (state.status !== 'running') {
    throw new R2cError(
      'NO_ACTIVE_RUN',
      `run is not running: ${state.status}`,
      { run_id: runId, status: state.status },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  if (ctx.step !== null && ctx.step !== state.current_step_id) {
    throw new R2cError(
      'STEP_NOT_ACTIVE',
      `step is not the current step: ${ctx.step}`,
      { step: ctx.step, current_step_id: state.current_step_id },
      EXIT_CODES.USAGE,
    );
  }
  const current = state.steps.find((step) => step.id === state.current_step_id);
  if (!current || current.status !== 'active') {
    throw new R2cError(
      'STEP_NOT_ACTIVE',
      `current step is not active: ${state.current_step_id}`,
      { step: state.current_step_id, status: current?.status ?? null },
      EXIT_CODES.USAGE,
    );
  }

  const loadedManifest = loadManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const manifest = loadedManifest.data;
  assertRenderableSteps(manifest, loadedManifest.root);
  const flat = flattenSteps(manifest);
  const currentIndex = flat.findIndex(({ step }) => step.id === current.id);
  if (currentIndex < 0) {
    throw new R2cError(
      'MANIFEST_INVALID',
      `step missing from manifest: ${current.id}`,
      { step: current.id },
      EXIT_CODES.USAGE,
    );
  }

  const gate = await checkGates({
    root: loadedManifest.root,
    projectRoot: ctx.projectRoot,
    manifest,
    state,
    step: flat[currentIndex].step,
  });
  if (!gate.ok) {
    throw new R2cError(
      'GATE_REJECTED',
      gate.message ?? 'gate rejected this submission',
      gate.details ?? null,
      EXIT_CODES.GATE,
    );
  }

  const time = nowIso(ctx.now());
  const eventStep = { id: current.id, name: current.name };
  const submitted = { kind: 'step', event: 'submitted', step: eventStep, time };
  if (typeof ctx.note === 'string' && ctx.note !== '') submitted.note = ctx.note;
  appendEvent(ctx.projectRoot, runId, submitted);

  current.status = 'completed';
  state.updated_at = time;

  const currentStage = state.stages.find((stage) => stage.id === current.stage_id);
  const stageSteps = state.steps.filter((step) => step.stage_id === current.stage_id);
  if (stageSteps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
    currentStage.status = 'completed';
    currentStage.completed_at = time;
  }

  const nextEntry = flat[currentIndex + 1];
  const runnerCmd = ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath);

  if (nextEntry) {
    const nextStep = state.steps.find((step) => step.id === nextEntry.step.id);
    if (!nextStep) {
      throw new R2cError(
        'STATE_INCONSISTENT',
        `next step missing from state: ${nextEntry.step.id}`,
        { step: nextEntry.step.id },
        EXIT_CODES.INTERNAL,
      );
    }
    nextStep.status = 'active';
    state.current_step_id = nextStep.id;
    state.status = 'running';
    const nextStage = state.stages.find((stage) => stage.id === nextStep.stage_id);
    nextStage.status = 'active';
    if (nextStage.started_at === null) nextStage.started_at = time;

    appendEvent(ctx.projectRoot, runId, {
      kind: 'step',
      event: 'started',
      step: { id: nextStep.id, name: nextStep.name },
      time,
    });
    writeState(ctx.projectRoot, runId, state);

    const text = renderStep({
      manifest,
      root: loadedManifest.root,
      stepId: nextStep.id,
      runnerCmd,
      sessionId: state.session_id,
    });
    return {
      runId,
      sessionId: state.session_id,
      step: { id: nextStep.id, name: nextStep.name, status: nextStep.status },
      text,
      data: {
        status: state.status,
        current_step_id: state.current_step_id,
        next_step: { id: nextStep.id, name: nextStep.name },
        text,
      },
    };
  }

  state.status = 'completed';
  state.current_step_id = null;
  state.completed_at = time;
  currentStage.status = 'completed';
  if (currentStage.started_at === null) currentStage.started_at = time;
  currentStage.completed_at = time;
  appendEvent(ctx.projectRoot, runId, { kind: 'run', event: 'completed', time });
  writeState(ctx.projectRoot, runId, state);
  deactivateLatestRun(ctx.projectRoot, state.session_id, runId);

  const text = renderCompleted(runId);
  return {
    runId,
    sessionId: state.session_id,
    step: null,
    text,
    data: {
      status: state.status,
      current_step_id: null,
      text,
    },
  };
}
