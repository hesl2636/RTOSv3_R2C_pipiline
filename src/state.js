/**
 * Run state: minting run ids, reading/writing `.r2c/` files, routing sessions
 * to runs, and replaying `events.jsonl` when the derived `state.json` drifts.
 *
 * Invariants implemented here (spec §3):
 * - runId = R<UTC timestamp>-<6 hex>, so lexicographic order follows time;
 * - state.json has a closed field set;
 * - events are the repair source: a mismatch produces a derived write only,
 *   never a new event.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { R2cError, EXIT_CODES, isR2cError } from './errors.js';
import { withLatestLock, withRunLock, withRunWriteLock } from './lock.js';
import {
  eventsPath,
  latestPath,
  runDir,
  runsDir,
  statePath,
  workflowSnapshotPath,
} from './paths.js';

export const STATE_SCHEMA = 'r2c.state/v1';
export const LATEST_SCHEMA = 'r2c.latest/v1';
export const CLI_SESSION_ID = /^cli-R\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function nowIso(now = new Date()) {
  return now.toISOString();
}

function timestamp(now) {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Mint a run id. `after` is the greatest suffix already used in the same
 * second; staying above it keeps the lexicographic order equal to time order
 * even when two runs start within the same second.
 */
export function mintRunId(now = new Date(), after = null) {
  const stamp = timestamp(now);
  let suffix = randomBytes(3).toString('hex');
  if (after !== null && after >= suffix) {
    const next = (Number.parseInt(after, 16) + 1).toString(16).padStart(6, '0');
    if (next.length === 6) suffix = next;
  }
  return `R${stamp}-${suffix}`;
}

export function isCliSessionId(sessionId) {
  return typeof sessionId === 'string' && CLI_SESSION_ID.test(sessionId);
}

function tempName(file) {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/** Write a file atomically (same-directory temp file + rename). */
export function atomicWriteFile(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = tempName(file);
  try {
    writeFileSync(temp, content);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function emptyLatest() {
  return {
    schema: LATEST_SCHEMA,
    runs: {},
    active_run_id: null,
    latest_run_id: null,
  };
}

export function readLatest(root) {
  const latest = readJson(latestPath(root));
  if (!latest || typeof latest !== 'object') return emptyLatest();
  if (latest.schema !== LATEST_SCHEMA) return emptyLatest();
  return {
    schema: LATEST_SCHEMA,
    runs: latest.runs ?? {},
    active_run_id: latest.active_run_id ?? null,
    latest_run_id: latest.latest_run_id ?? null,
  };
}

export function writeLatest(root, latest) {
  atomicWriteJson(latestPath(root), latest);
}

export function readState(root, runId) {
  return readJson(statePath(root, runId));
}

export function writeState(root, runId, state) {
  atomicWriteJson(statePath(root, runId), state);
}

export function readEvents(root, runId) {
  let raw;
  try {
    raw = readFileSync(eventsPath(root, runId), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function appendEvent(root, runId, event) {
  mkdirSync(runDir(root, runId), { recursive: true });
  appendFileSync(eventsPath(root, runId), `${JSON.stringify(event)}\n`);
}

function flattenSteps(manifest) {
  const steps = [];
  for (const stage of manifest.stages) {
    for (const step of stage.steps) {
      steps.push({ step, stage });
    }
  }
  return steps;
}

function buildState({ runId, sessionId, manifest, engineVersion, startedAt, userInput }) {
  const flattened = flattenSteps(manifest);
  const stages = manifest.stages.map((stage, index) => ({
    id: stage.id,
    name: stage.name,
    status: index === 0 ? 'active' : 'pending',
    started_at: index === 0 ? startedAt : null,
    completed_at: null,
    trace_started_at: null,
    trace_completed_at: null,
  }));
  const steps = flattened.map(({ step, stage }, index) => ({
    id: step.id,
    name: step.name,
    stage_id: stage.id,
    skill: step.skill ?? null,
    status: index === 0 ? 'active' : 'pending',
    retry_count: 0,
    review_retry_count: 0,
  }));
  return {
    schema: STATE_SCHEMA,
    run_id: runId,
    session_id: sessionId,
    status: 'running',
    workflow_id: manifest.id,
    workflow_engine: null,
    engine: engineVersion,
    engine_version: engineVersion,
    interaction_mode: 'cli',
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    user_input: userInput ?? null,
    current_step_id: steps[0]?.id ?? null,
    stages,
    steps,
  };
}

/**
 * Create a run: mint the directory, snapshot the manifest, write the initial
 * state/events and route the session in latest.json.
 */
export function createRun({
  root,
  manifest,
  manifestPath,
  sessionId,
  engineVersion,
  userInput = null,
  now = new Date(),
}) {
  const startedAt = nowIso(now);
  mkdirSync(runsDir(root), { recursive: true });

  // The id mint reads run directory names and the routing write updates
  // latest.json; holding the latest lock across both keeps run ids ordered and
  // the `latest.json` merge atomic.
  return withLatestLock(root, () => {
    if (sessionId !== null && sessionId !== undefined) {
      const active = liveRunForSession(root, sessionId);
      if (active !== null) {
        throw new R2cError(
          'RUN_ALREADY_ACTIVE',
          `session already has a running run: ${sessionId}`,
          { session_id: sessionId, run_id: active },
          EXIT_CODES.USAGE,
        );
      }
    }

    const prefix = `R${timestamp(now)}-`;
    let after = null;
    for (const name of readdirSync(runsDir(root))) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (/^[0-9a-f]{6}$/.test(suffix) && (after === null || suffix > after)) after = suffix;
    }

    let runId;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = mintRunId(now, after);
      try {
        mkdirSync(runDir(root, candidate));
        runId = candidate;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        after = candidate.slice(prefix.length);
      }
    }
    if (!runId) {
      throw new R2cError('RUN_ID_MINT_FAILED', 'could not mint a unique run id', null, EXIT_CODES.INTERNAL);
    }

    const finalSessionId = sessionId ?? `cli-${runId}`;
    // Locks are always acquired latest → run (see src/lock.js).
    const state = withRunLock(root, runId, () => {
      copyFileSync(manifestPath, workflowSnapshotPath(root, runId));
      const built = buildState({
        runId,
        sessionId: finalSessionId,
        manifest,
        engineVersion,
        startedAt,
        userInput,
      });

      const firstStep = built.steps[0];
      appendEvent(root, runId, { kind: 'run', event: 'started', time: startedAt });
      appendEvent(root, runId, {
        kind: 'step',
        event: 'started',
        step: { id: firstStep.id, name: firstStep.name },
        time: startedAt,
      });
      writeState(root, runId, built);
      return built;
    });

    const latest = readLatest(root);
    latest.runs[finalSessionId] = { active_run_id: runId, latest_run_id: runId };
    latest.active_run_id = runId;
    latest.latest_run_id = runId;
    writeLatest(root, latest);

    return { runId, sessionId: finalSessionId, state, latest };
  });
}

/**
 * Replay events into the derived fields of state. Returns a repaired copy plus
 * the list of deeply changed derived fields (for diagnostics only).
 */
export function replayDerived(state, events) {
  const repaired = structuredClone(state);
  const stepById = new Map(repaired.steps.map((step) => [step.id, step]));
  const stepStatus = new Map(repaired.steps.map((step) => [step.id, 'pending']));
  const stepStartedAt = new Map();
  const stepCompletedAt = new Map();
  const stageById = new Map(repaired.stages.map((stage) => [stage.id, stage]));
  let runStatus = 'pending';
  let currentStepId = null;
  let sessionId = repaired.session_id;
  let startedAt = repaired.started_at ?? null;
  let completedAt = repaired.completed_at ?? null;

  for (const event of events) {
    const time = event?.time ?? null;
    if (event?.kind === 'run') {
      if (event.event === 'started') {
        runStatus = 'running';
        startedAt ??= time;
      } else if (event.event === 'paused') {
        runStatus = 'paused';
      } else if (event.event === 'resumed') {
        runStatus = 'running';
      } else if (event.event === 'completed') {
        runStatus = 'completed';
        completedAt ??= time;
        currentStepId = null;
      } else if (event.event === 'failed') {
        runStatus = 'failed';
        completedAt ??= time;
      } else if (event.event === 'cancelled') {
        runStatus = 'cancelled';
        completedAt ??= time;
        currentStepId = null;
      } else if (event.event === 'claimed') {
        const to = event.session?.to;
        if (typeof to === 'string' && to !== '') sessionId = to;
      }
    } else if (event?.kind === 'step') {
      const id = event.step?.id;
      if (!id || !stepById.has(id)) continue;
      if (event.event === 'started') {
        stepStatus.set(id, 'active');
        stepStartedAt.set(id, time);
        currentStepId = id;
      } else if (event.event === 'submitted' || event.event === 'completed') {
        stepStatus.set(id, 'completed');
        stepCompletedAt.set(id, time);
        if (currentStepId === id) currentStepId = null;
      } else if (event.event === 'failed') {
        stepStatus.set(id, 'failed');
        currentStepId = id;
      } else if (event.event === 'skipped') {
        stepStatus.set(id, 'skipped');
        if (currentStepId === id) currentStepId = null;
      }
    }
  }

  for (const step of repaired.steps) {
    step.status = stepStatus.get(step.id) ?? step.status;
  }

  for (const stage of repaired.stages) {
    const members = repaired.steps.filter((step) => step.stage_id === stage.id);
    const allDone = members.length > 0 && members.every(
      (step) => step.status === 'completed' || step.status === 'skipped',
    );
    const anyLive = members.some(
      (step) => step.status === 'active' || step.status === 'failed',
    );
    if (allDone) {
      stage.status = 'completed';
      if (stage.started_at === null) {
        const first = members.map((step) => stepStartedAt.get(step.id)).find(Boolean);
        stage.started_at = first ?? null;
      }
      if (stage.completed_at === null) {
        const times = members.map((step) => stepCompletedAt.get(step.id)).filter(Boolean);
        stage.completed_at = times.length > 0 ? times[times.length - 1] : null;
      }
    } else if (anyLive) {
      stage.status = 'active';
      if (stage.started_at === null) {
        const first = members.map((step) => stepStartedAt.get(step.id)).find(Boolean);
        stage.started_at = first ?? null;
      }
      stage.completed_at = null;
    } else {
      stage.status = 'pending';
      stage.started_at = null;
      stage.completed_at = null;
    }
  }

  repaired.status = runStatus;
  repaired.current_step_id = currentStepId;
  repaired.session_id = sessionId;
  repaired.started_at = startedAt;
  repaired.completed_at = completedAt;
  return repaired;
}

function claimedRoutes(events) {
  const routes = [];
  for (const event of events) {
    if (event?.kind !== 'run' || event.event !== 'claimed') continue;
    const from = event.session?.from;
    const to = event.session?.to;
    if (typeof from === 'string' && typeof to === 'string' && from !== '' && to !== '') {
      routes.push({ from, to });
    }
  }
  return routes;
}

/**
 * A claimed run expects `latest.json` to route `to` at the run and to hold no
 * `from` (synthetic) key. Only a missing `to` key is restored; an existing
 * entry is left alone because a later run may legitimately own that session.
 */
function latestClaimDrift(latest, runId, routes) {
  return routes.some(({ from, to }) => latest.runs?.[from] !== undefined
    || latest.runs?.[to] === undefined);
}

function repairLatestClaims(latest, runId, routes) {
  for (const { from, to } of routes) {
    delete latest.runs[from];
    if (latest.runs[to] === undefined) {
      latest.runs[to] = { active_run_id: runId, latest_run_id: runId };
    }
  }
  return latest;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function warnRepair(runId) {
  process.stderr.write(`[r2c] state.json for ${runId} repaired from events\n`);
}

function warnRouteRepair(runId) {
  process.stderr.write(`[r2c] latest.json route for ${runId} repaired from events\n`);
}

/**
 * Read a run and repair derived fields from events when they disagree.
 *
 * `events.jsonl` is the authority; `state.json` is a derived cache. A repair
 * therefore writes only `state.json`/`latest.json` and never appends an event.
 * The write is performed under the latest → run lock order so a concurrent
 * writer cannot interleave; `assumeLocked` is used by callers that already
 * hold the run lock, and `assumeLatestLocked` by those that also hold the
 * latest lock.
 */
export function loadRun(
  root,
  runId,
  { repair = true, assumeLocked = false, assumeLatestLocked = false } = {},
) {
  const state = readState(root, runId);
  if (!state) return null;
  const events = readEvents(root, runId);
  if (!repair || events === null) return { runId, state, events: events ?? [] };

  const derived = replayDerived(state, events);
  const routes = claimedRoutes(events);
  const stateDrift = !sameJson(derived, state);
  const latestDrift = routes.length > 0 && latestClaimDrift(readLatest(root), runId, routes);
  if (!stateDrift && !latestDrift) {
    return { runId, state, events, repaired: false };
  }

  if (assumeLocked) {
    let nextState = state;
    if (stateDrift) {
      writeState(root, runId, derived);
      nextState = derived;
    }
    if (latestDrift && assumeLatestLocked) {
      writeLatest(root, repairLatestClaims(readLatest(root), runId, routes));
    }
    if (stateDrift) warnRepair(runId);
    else if (latestDrift && assumeLatestLocked) warnRouteRepair(runId);
    return { runId, state: nextState, events, repaired: stateDrift };
  }

  try {
    const result = withRunWriteLock(root, runId, () => {
      const freshState = readState(root, runId) ?? state;
      const freshEvents = readEvents(root, runId) ?? events;
      const freshDerived = replayDerived(freshState, freshEvents);
      const freshRoutes = claimedRoutes(freshEvents);
      const freshStateDrift = !sameJson(freshDerived, freshState);
      const freshLatestDrift = freshRoutes.length > 0
        && latestClaimDrift(readLatest(root), runId, freshRoutes);

      if (freshStateDrift) writeState(root, runId, freshDerived);
      if (freshLatestDrift) {
        writeLatest(root, repairLatestClaims(readLatest(root), runId, freshRoutes));
      }
      return {
        state: freshStateDrift ? freshDerived : freshState,
        events: freshEvents,
        stateRepaired: freshStateDrift,
        repaired: freshStateDrift || freshLatestDrift,
      };
    });
    if (result.repaired) {
      if (result.stateRepaired) warnRepair(runId);
      else warnRouteRepair(runId);
    }
    return { runId, state: result.state, events: result.events, repaired: result.repaired };
  } catch (error) {
    if (isR2cError(error) && error.code === 'LOCK_CONFLICT') {
      // Another writer owns the run and will persist the same derivation; do
      // not turn a read-only command into an exit 5 just to repair the cache.
      return { runId, state: derived, events, repaired: false, repairSkipped: true };
    }
    throw error;
  }
}

/**
 * Route a session (or the latest run for read-only commands) to a run.
 * `undefined` sessionId asks for the documented read-only fallback.
 */
export function resolveRunForSession({ root, sessionId = undefined, fallbackToLatest = false }) {
  const latest = readLatest(root);
  let activeRunId = null;
  let latestRunId = null;

  if (typeof sessionId === 'string' && sessionId !== '') {
    const entry = latest.runs?.[sessionId];
    if (!entry) return null;
    activeRunId = entry.active_run_id ?? null;
    latestRunId = entry.latest_run_id ?? null;
  } else if (fallbackToLatest) {
    activeRunId = latest.active_run_id ?? null;
    latestRunId = latest.latest_run_id ?? null;
  } else {
    return null;
  }

  const runId = activeRunId ?? latestRunId;
  if (!runId) return null;
  const loaded = loadRun(root, runId);
  if (!loaded) return null;
  return { ...loaded, latest, activeRunId, latestRunId };
}

/** Return the session's routed run id when that run is still running. */
function liveRunForSession(root, sessionId) {
  const latest = readLatest(root);
  const entry = latest.runs?.[sessionId];
  const runId = entry?.active_run_id ?? entry?.latest_run_id;
  if (!runId) return null;
  const state = readState(root, runId);
  return state?.status === 'running' ? runId : null;
}

/** True when latest.json already routes this session to a running run. */
export function hasRunningRun(root, sessionId) {
  return liveRunForSession(root, sessionId) !== null;
}

/**
 * Mark the session's run as no longer active in latest.json. Latest fields are
 * route data, not state: the run's own status lives in state.json.
 *
 * The caller must hold `withLatestLock` (normally through
 * `withRunWriteLock`); this function intentionally does not re-acquire it.
 */
export function deactivateLatestRun(root, sessionId, runId) {
  const latest = readLatest(root);
  const entry = latest.runs?.[sessionId];
  if (entry && (entry.active_run_id === runId || entry.latest_run_id === runId)) {
    entry.active_run_id = null;
    entry.latest_run_id = runId;
  }
  if (latest.active_run_id === runId) latest.active_run_id = null;
  latest.latest_run_id = latest.latest_run_id ?? runId;
  writeLatest(root, latest);
  return latest;
}
