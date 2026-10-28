/**
 * `r2c pause`: running → paused. The current step stays active; no delivery
 * happens until a matching `resume`. The lock covers only the read-modify-write.
 */
import { R2cError, EXIT_CODES } from '../errors.js';
import { withRunLock } from '../lock.js';
import {
  appendEvent,
  loadRun,
  nowIso,
  resolveRunForSession,
  writeState,
} from '../state.js';

function requireSession(ctx, command) {
  if (!ctx.sessionId) {
    throw new R2cError(
      'MISSING_SESSION',
      `${command} requires --session-id (or R2C_SESSION_ID)`,
      { option: '--session-id' },
      EXIT_CODES.USAGE,
    );
  }
}

export async function run(_argv, ctx) {
  requireSession(ctx, 'pause');
  const loaded = resolveRunForSession({
    root: ctx.projectRoot,
    sessionId: ctx.sessionId,
    fallbackToLatest: false,
  });
  if (loaded === null) {
    throw new R2cError(
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
      throw new R2cError(
        'NO_ACTIVE_RUN',
        'no active run for this session',
        { session_id: ctx.sessionId },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
    if (locked.state.status !== 'running') {
      throw new R2cError(
        'RUN_NOT_RUNNING',
        `run is not running: ${locked.state.status}`,
        { run_id: runId, status: locked.state.status },
        EXIT_CODES.USAGE,
      );
    }

    const time = nowIso(ctx.now());
    appendEvent(ctx.projectRoot, runId, { kind: 'run', event: 'paused', time });
    locked.state.status = 'paused';
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
    text: `run/${runId} paused${current === null ? '' : ` step/${current.id}`}\n`,
    data: {
      status: state.status,
      current_step_id: state.current_step_id,
      completed_at: state.completed_at,
    },
  };
}
