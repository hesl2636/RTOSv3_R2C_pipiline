/**
 * `hm2b cancel`: move a run to the terminal `cancelled` state.
 *
 * Cancelling also clears the session's `latest.json` active route (inside the
 * latest lock) so `submit`/`next` exit 4 from then on. Terminal runs are not
 * cancellable again.
 */
import { Hm2bError, EXIT_CODES } from '../errors.js';
import { refuseClaimedSession } from '../claim.js';
import { withRunWriteLock } from '../lock.js';
import {
  appendEvent,
  deactivateLatestRun,
  loadRun,
  nowIso,
  resolveRunForSession,
  writeState,
} from '../state.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function requireSession(ctx) {
  if (!ctx.sessionId) {
    throw new Hm2bError(
      'MISSING_SESSION',
      'cancel requires --session-id (or HM2B_SESSION_ID)',
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
  const state = withRunWriteLock(ctx.projectRoot, runId, () => {
    const locked = loadRun(ctx.projectRoot, runId, { assumeLocked: true });
    if (locked === null) {
      throw new Hm2bError(
        'NO_ACTIVE_RUN',
        'no active run for this session',
        { session_id: ctx.sessionId },
        EXIT_CODES.NO_ACTIVE_RUN,
      );
    }
    if (TERMINAL.has(locked.state.status)) {
      throw new Hm2bError(
        'RUN_TERMINAL',
        `run is already terminal: ${locked.state.status}`,
        { run_id: runId, status: locked.state.status },
        EXIT_CODES.USAGE,
      );
    }

    const time = nowIso(ctx.now());
    appendEvent(ctx.projectRoot, runId, { kind: 'run', event: 'cancelled', time });
    locked.state.status = 'cancelled';
    locked.state.current_step_id = null;
    locked.state.completed_at = time;
    locked.state.updated_at = time;
    writeState(ctx.projectRoot, runId, locked.state);
    deactivateLatestRun(ctx.projectRoot, locked.state.session_id, runId);
    return locked.state;
  });

  return {
    runId,
    sessionId: state.session_id,
    step: null,
    text: `run/${runId} cancelled\n`,
    data: {
      status: state.status,
      current_step_id: null,
      completed_at: state.completed_at,
    },
  };
}
