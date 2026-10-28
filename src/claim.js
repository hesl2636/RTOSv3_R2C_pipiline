/**
 * Session claiming: bind a synthetic `cli-<runId>` run to the first real
 * session that can prove it.
 *
 * A run started from the command surface has no real session id, so `run`
 * mints `cli-<runId>`. The first `hook stop` that carries a real session id
 * claims the run when exactly one structural candidate exists in the project
 * and that session does not already own a run. Claiming is the only trigger
 * write: it rewrites `state.session_id` plus `updated_at`, appends a
 * `run claimed` event and moves the `latest.json` route key.
 *
 * Candidates are matched structurally (`session_id === "cli-" + run_id`), never
 * by prefix, and `latest.json` is never used as a fallback for a missing sid.
 */
import { readdirSync } from 'node:fs';
import { runsDir } from './paths.js';
import { withRunWriteLock } from './lock.js';
import {
  STATE_SCHEMA,
  appendEvent,
  isCliSessionId,
  nowIso,
  readEvents,
  readLatest,
  readState,
  writeLatest,
  writeState,
} from './state.js';

/** Any `cli-R…` id is synthetic, including malformed ones. */
const SYNTHETIC_SESSION = /^cli-R/;

export function isSyntheticHookSession(sessionId) {
  return typeof sessionId === 'string' && SYNTHETIC_SESSION.test(sessionId);
}

function entryRunId(latest, sessionId) {
  const entry = latest.runs?.[sessionId];
  return entry?.active_run_id ?? entry?.latest_run_id ?? null;
}

/** The latest.json route target for `sessionId` and the run state behind it. */
export function routedRun(root, sessionId) {
  const latest = readLatest(root);
  const runId = entryRunId(latest, sessionId);
  if (runId === null) return null;
  const state = readState(root, runId);
  return state === null ? null : { runId, state };
}

function isLive(state) {
  return state?.status === 'running' || state?.status === 'paused';
}

/** True when `sessionId` already owns a running or paused run. */
export function hasLiveRun(root, sessionId) {
  const routed = routedRun(root, sessionId);
  return routed !== null && isLive(routed.state);
}

/** True when a non-synthetic session key already routes at this run. */
function routedToRealSession(latest, runId) {
  return Object.entries(latest.runs ?? {}).some(([key, entry]) => {
    if (SYNTHETIC_SESSION.test(key)) return false;
    return entry?.active_run_id === runId || entry?.latest_run_id === runId;
  });
}

function isCandidate(state, latest, workflowId) {
  if (state?.schema !== STATE_SCHEMA) return false;
  if (typeof state.run_id !== 'string') return false;
  if (state.session_id !== `cli-${state.run_id}`) return false;
  if (state.status !== 'running') return false;
  const current = state.steps?.find((step) => step.id === state.current_step_id);
  if (!current || current.status !== 'active') return false;
  if (routedToRealSession(latest, state.run_id)) return false;
  if (workflowId !== null && workflowId !== undefined && state.workflow_id !== workflowId) {
    return false;
  }
  return true;
}

/**
 * Every claimable synthetic run in the project. Reads only; the write path
 * re-evaluates the same predicates under the locks.
 */
export function findClaimCandidates(root, { workflowId = null } = {}) {
  const latest = readLatest(root);
  let names;
  try {
    names = readdirSync(runsDir(root));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const candidates = [];
  for (const name of names.sort()) {
    if (!name.startsWith('R')) continue;
    const state = readState(root, name);
    if (state === null || state.run_id !== name) continue;
    if (!isCandidate(state, latest, workflowId)) continue;
    candidates.push({ runId: name, state });
  }
  return candidates;
}

/**
 * Claim `runId` for `sessionId` when the predicates still hold inside the
 * latest → run lock order. Returns `null` when another writer already made the
 * claim ineligible; throws LOCK_CONFLICT (exit 5) when a lock is held.
 */
export function claimRun({ root, runId, sessionId, workflowId = null, now = new Date() }) {
  return withRunWriteLock(root, runId, () => {
    const latest = readLatest(root);
    const state = readState(root, runId);
    if (!isCandidate(state, latest, workflowId)) return null;
    if (state.run_id !== runId) return null;
    if (isLive(routedRun(root, sessionId)?.state)) return null;
    if (findClaimCandidates(root, { workflowId }).length !== 1) return null;

    const time = nowIso(now);
    appendEvent(root, runId, {
      kind: 'run',
      event: 'claimed',
      session: { from: `cli-${runId}`, to: sessionId },
      time,
    });

    state.session_id = sessionId;
    state.updated_at = time;
    writeState(root, runId, state);

    delete latest.runs[`cli-${runId}`];
    latest.runs[sessionId] = { active_run_id: runId, latest_run_id: runId };
    writeLatest(root, latest);

    return { runId, state, latest };
  });
}

/** The real session a run was claimed by, per its events (last claim wins). */
export function claimedSession(root, runId) {
  const events = readEvents(root, runId);
  if (events === null) return null;
  let claimed = null;
  for (const event of events) {
    if (event?.kind !== 'run' || event.event !== 'claimed') continue;
    const to = event.session?.to;
    if (typeof to === 'string' && to !== '') claimed = to;
  }
  return claimed;
}

/**
 * When `sessionId` is a synthetic `cli-<runId>` id whose run has already been
 * claimed, return the binding. Used by write commands to refuse the stale id
 * with `RUN_CLAIMED` before any lock or write.
 */
export function claimedBindingForSession(root, sessionId) {
  if (!isCliSessionId(sessionId)) return null;
  const runId = sessionId.slice(4);
  const claimed = claimedSession(root, runId);
  if (claimed !== null && claimed !== sessionId) return { runId, sessionId: claimed };
  const state = readState(root, runId);
  if (state !== null && state.session_id !== sessionId) {
    return { runId, sessionId: state.session_id };
  }
  return null;
}
