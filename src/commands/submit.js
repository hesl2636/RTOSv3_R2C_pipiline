/**
 * `r2c submit`: the only regular state writer. It validates the step, runs the
 * machine gates (`expect.outputs` then `gate[]`), records `submitted`, then
 * advances through any runner-executed shell steps to the next prompt step (or
 * the completed banner at the end of the workflow).
 */
import { R2cError, EXIT_CODES } from '../errors.js';
import { checkGates } from '../gate.js';
import { flattenSteps, loadManifest } from '../manifest.js';
import { assertRenderableSteps, defaultRunnerCommand, renderCompleted, renderStep } from '../render.js';
import { executeShellSteps } from '../shell.js';
import {
  appendEvent,
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
    step: flat[currentIndex].step,
    projectRoot: ctx.projectRoot,
  });
  if (!gate.ok) {
    const time = nowIso(ctx.now());
    current.retry_count += 1;
    state.updated_at = time;
    const rejection = {
      kind: 'gate',
      event: 'rejected',
      step: { id: current.id, name: current.name },
      phase: gate.phase,
      code: gate.code ?? 'GATE_REJECTED',
      time,
    };
    if (Array.isArray(gate.patterns)) rejection.patterns = gate.patterns;
    if (typeof gate.command === 'string') rejection.command = gate.command;
    if (gate.exitCode !== undefined && gate.exitCode !== null) rejection.exit_code = gate.exitCode;
    if (gate.timedOut === true) rejection.timed_out = true;
    appendEvent(ctx.projectRoot, runId, rejection);
    writeState(ctx.projectRoot, runId, state);
    throw new R2cError(
      gate.code ?? 'GATE_REJECTED',
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

  const runnerCmd = ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath);
  const settled = await executeShellSteps({
    manifest,
    projectRoot: ctx.projectRoot,
    state,
    runId,
    startIndex: currentIndex + 1,
    now: ctx.now,
  });

  const nextStep = settled.step;
  const text = nextStep === null
    ? renderCompleted(runId)
    : renderStep({
        manifest,
        root: loadedManifest.root,
        stepId: nextStep.id,
        runnerCmd,
        sessionId: state.session_id,
      });
  return {
    runId,
    sessionId: state.session_id,
    step: nextStep === null ? null : { id: nextStep.id, name: nextStep.name, status: nextStep.status },
    text,
    data: {
      status: state.status,
      current_step_id: state.current_step_id,
      ...(nextStep === null ? {} : { next_step: { id: nextStep.id, name: nextStep.name } }),
      text,
    },
  };
}
