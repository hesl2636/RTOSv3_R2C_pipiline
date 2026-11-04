/**
 * `hm2b resume`: paused → running.
 *
 * A manual pause leaves the current step active, so a plain resume returns to
 * the same step. A failed current step (shell/gate failure recorded by submit)
 * is only re-activated by `--retry`, which appends a fresh `step started`
 * event so replay derives the same active state. `retry_count` is not reset:
 * it is the attempt history owned by the gate seam.
 */
import { Hm2bError, EXIT_CODES } from '../errors.js';
import { refuseClaimedSession } from '../claim.js';
import { withRunLock } from '../lock.js';
import {
  appendEvent,
  loadRun,
  nowIso,
  resolveRunForSession,
  writeState,
} from '../state.js';

function requireSession(ctx) {
  if (!ctx.sessionId) {
    throw new Hm2bError(
      'MISSING_SESSION',
      'resume requires --session-id (or HM2B_SESSION_ID)',
      { option: '--session-id' },
      EXIT_CODES.USAGE,
    );
  }
}

export async function run(_argv, ctx) {
  requireSession(ctx);
  refuseClaimedSession(ctx.projectRoot, ctx.sessionId);
  const loaded = resolveRunForSession({
    root: ctx.projectRoot,
    sessionId: ctx.sessionId,
    fallbackToLatest: false,
  });
  if (loaded === null) {
    throw new Hm2bError(
      'NO_ACTIVE_RUN',
      'no active run for this session',
      { session_id: ctx.sessionId },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const { runId } = loaded;
  const state = withRunLock(ctx.projectRoot, runId, () => {
    const locked = loadRun(ctx.projectRoot, runId, { assumeLocked: true });
    if (locked === null) {
      throw new Hm2bError(
        'NO_ACTIVE_RUN',
        'no active run for this session',
        { session_id: ctx.sessionId },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
    if (locked.state.status !== 'paused') {
      throw new Hm2bError(
        'RUN_NOT_PAUSED',
        `run is not paused: ${locked.state.status}`,
        { run_id: runId, status: locked.state.status },
        EXIT_CODES.USAGE,
      );
    }

    const current = locked.state.steps.find((step) => step.id === locked.state.current_step_id);
    if (current?.status === 'failed' && ctx.retry !== true) {
      throw new Hm2bError(
        'STEP_FAILED',
        `current step is failed; rerun with --retry to re-activate it: ${current.id}`,
        { run_id: runId, step: current.id, status: current.status, retry_count: current.retry_count },
        EXIT_CODES.USAGE,
      );
    }

    const time = nowIso(ctx.now());
    if (current?.status === 'failed') {
      current.status = 'active';
      appendEvent(ctx.projectRoot, runId, {
        kind: 'step',
        event: 'started',
        step: { id: current.id, name: current.name },
        time,
      });
    }
    appendEvent(ctx.projectRoot, runId, { kind: 'run', event: 'resumed', time });
    locked.state.status = 'running';
    locked.state.updated_at = time;
    writeState(ctx.projectRoot, runId, locked.state);
    return locked.state;
  });

  const current = state.steps.find((step) => step.id === state.current_step_id) ?? null;
  return {
    runId,
    sessionId: state.session_id,
    step: current === null
      ? null
      : { id: current.id, name: current.name, status: current.status },
    text: `run/${runId} running${current === null ? '' : ` step/${current.id}`}\n`,
    data: {
      status: state.status,
      current_step_id: state.current_step_id,
      completed_at: state.completed_at,
    },
  };
}
