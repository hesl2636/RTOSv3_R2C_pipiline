/**
 * `r2c submit`: the only regular state writer. It validates the step, runs the
 * machine gates (`expect.outputs` then `gate[]`), records `submitted`, then
 * advances through any runner-executed shell steps to the next prompt step (or
 * the completed banner at the end of the workflow).
 *
 * Gate commands and shell steps may take arbitrary time, so they run outside
 * the run lock. Every read → transition → append → write window is locked and
 * revalidates the preflight step (a concurrent writer may have won).
 */
import { R2cError, EXIT_CODES } from '../errors.js';
import { refuseClaimedSession } from '../claim.js';
import { checkGates } from '../gate.js';
import { withRunWriteLock } from '../lock.js';
import { flattenSteps, loadManifest } from '../manifest.js';
import { assertRenderableSteps, defaultRunnerCommand, renderCompleted, renderStep } from '../render.js';
import { executeShellSteps } from '../shell.js';
import {
  appendEvent,
  loadRun,
  nowIso,
  refreshStageFromSteps,
  resolveRunForSession,
  resolveSingleRunningRun,
  writeState,
} from '../state.js';

export async function run(_argv, ctx) {
  let runId;
  if (ctx.sessionId) {
    refuseClaimedSession(ctx.projectRoot, ctx.sessionId);
    const routed = resolveRunForSession({
      root: ctx.projectRoot,
      sessionId: ctx.sessionId,
      fallbackToLatest: false,
      repair: false,
    });
    if (routed === null) {
      throw new R2cError(
        'NO_ACTIVE_RUN',
        'no active run for this session',
        { session_id: ctx.sessionId },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
    runId = routed.runId;
  } else {
    // No session id: the stable entry point resolves the single running run.
    // Zero or several is an error before any lock, gate or write.
    runId = resolveSingleRunningRun({ root: ctx.projectRoot }).runId;
  }

  const loadedManifest = loadManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const manifest = loadedManifest.data;
  assertRenderableSteps(manifest, loadedManifest.root);

  // Loading with the manifest applies the resume guard and repairs derived
  // state only after the recorded step sequence matches the manifest.
  const loadedRun = loadRun(ctx.projectRoot, runId, { manifest });
  if (loadedRun === null) {
    throw new R2cError(
      'NO_ACTIVE_RUN',
      'no active run for this session',
      { run_id: runId, session_id: ctx.sessionId },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }
  const { state } = loadedRun;
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

  /**
   * Run `fn(state)` under the latest → run lock order. The state read inside
   * the lock is authoritative; `fn` returns the value to the caller.
   */
  const writeTransaction = (fn) => withRunWriteLock(ctx.projectRoot, runId, () => {
    const locked = loadRun(ctx.projectRoot, runId, {
      assumeLocked: true,
      assumeLatestLocked: true,
      manifest,
    });
    if (locked === null) {
      throw new R2cError(
        'NO_ACTIVE_RUN',
        'no active run for this session',
        { session_id: ctx.sessionId },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
    return fn(locked.state, locked.events);
  });

  /** Revalidate the preflight step inside a lock and return its state object. */
  const lockedCurrentStep = (lockedState, stepId) => {
    if (lockedState.status !== 'running') {
      throw new R2cError(
        'NO_ACTIVE_RUN',
        `run is not running: ${lockedState.status}`,
        { run_id: runId, status: lockedState.status },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
    if (lockedState.current_step_id !== stepId) {
      throw new R2cError(
        'STEP_NOT_ACTIVE',
        `step is not the current step: ${stepId}`,
        { step: stepId, current_step_id: lockedState.current_step_id },
        EXIT_CODES.USAGE,
      );
    }
    const lockedCurrent = lockedState.steps.find((step) => step.id === stepId);
    if (!lockedCurrent || lockedCurrent.status !== 'active') {
      throw new R2cError(
        'STEP_NOT_ACTIVE',
        `current step is not active: ${lockedState.current_step_id}`,
        { step: lockedState.current_step_id, status: lockedCurrent?.status ?? null },
        EXIT_CODES.USAGE,
      );
    }
    return lockedCurrent;
  };

  const gate = await checkGates({
    step: flat[currentIndex].step,
    projectRoot: ctx.projectRoot,
  });
  if (!gate.ok) {
    writeTransaction((lockedState) => {
      const lockedCurrent = lockedCurrentStep(lockedState, current.id);
      const time = nowIso(ctx.now());
      lockedCurrent.retry_count += 1;
      lockedState.updated_at = time;
      const rejection = {
        kind: 'gate',
        event: 'rejected',
        step: { id: lockedCurrent.id, name: lockedCurrent.name },
        phase: gate.phase,
        code: gate.code ?? 'GATE_REJECTED',
        time,
      };
      if (Array.isArray(gate.patterns)) rejection.patterns = gate.patterns;
      if (typeof gate.command === 'string') rejection.command = gate.command;
      if (gate.exitCode !== undefined && gate.exitCode !== null) rejection.exit_code = gate.exitCode;
      if (gate.timedOut === true) rejection.timed_out = true;
      appendEvent(ctx.projectRoot, runId, rejection);
      writeState(ctx.projectRoot, runId, lockedState);
    });
    throw new R2cError(
      gate.code ?? 'GATE_REJECTED',
      gate.message ?? 'gate rejected this submission',
      gate.details ?? null,
      EXIT_CODES.GATE,
    );
  }

  const preflightStepId = current.id;
  writeTransaction((lockedState, lockedEvents) => {
    const lockedCurrent = lockedCurrentStep(lockedState, preflightStepId);
    const time = nowIso(ctx.now());
    const eventStep = { id: lockedCurrent.id, name: lockedCurrent.name };
    const submitted = { kind: 'step', event: 'submitted', step: eventStep, time };
    if (typeof ctx.note === 'string' && ctx.note !== '') submitted.note = ctx.note;
    appendEvent(ctx.projectRoot, runId, submitted);
    lockedEvents.push(submitted);

    lockedCurrent.status = 'completed';
    // replayDerived clears the cursor on `submitted`; the stage timestamps come
    // from the same shared derivation so the next loadRun finds no drift.
    if (lockedState.current_step_id === lockedCurrent.id) lockedState.current_step_id = null;
    lockedState.updated_at = time;
    refreshStageFromSteps(lockedState, lockedCurrent.stage_id, time, lockedEvents);
    writeState(ctx.projectRoot, runId, lockedState);
  });

  const runnerCmd = ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath, { projectRoot: ctx.projectRoot });
  const settled = await executeShellSteps({
    manifest,
    projectRoot: ctx.projectRoot,
    runId,
    startIndex: currentIndex + 1,
    now: ctx.now,
    transaction: writeTransaction,
  });

  const nextStep = settled.step;
  const finalState = settled.state;
  const text = nextStep === null
    ? renderCompleted(runId)
    : renderStep({
        manifest,
        root: loadedManifest.root,
        stepId: nextStep.id,
        runnerCmd,
        sessionId: finalState.session_id,
        manifestPath: ctx.manifest ?? null,
      });
  return {
    runId,
    sessionId: finalState.session_id,
    step: nextStep === null ? null : { id: nextStep.id, name: nextStep.name, status: nextStep.status },
    text,
    data: {
      status: finalState.status,
      current_step_id: finalState.current_step_id,
      ...(nextStep === null ? {} : { next_step: { id: nextStep.id, name: nextStep.name } }),
      text,
    },
  };
}
