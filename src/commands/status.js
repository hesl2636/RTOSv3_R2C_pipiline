/**
 * `r2c status`: read-only run view.
 *
 * Plain output starts every line with one of four fixed markers (`run/`,
 * `stage/`, `step/`, `next/`) so shells and adapters can grep it without
 * parsing prose. JSON exposes the same data as `run`, `stages`, `steps` and
 * `next`, plus each step's latest `submitted` note.
 *
 * Reading a run also repairs a corrupted `state.json` from `events.jsonl`
 * (see `loadRun`); status never appends an event.
 */
import { R2cError, EXIT_CODES } from '../errors.js';
import { resolveRunForSession } from '../state.js';

function noteByStep(events) {
  const notes = new Map();
  for (const event of events) {
    if (event?.kind !== 'step' || event.event !== 'submitted') continue;
    const id = event.step?.id;
    if (typeof id !== 'string') continue;
    if (typeof event.note === 'string') notes.set(id, event.note);
  }
  return notes;
}

function currentStep(state) {
  if (typeof state.current_step_id !== 'string') return null;
  return state.steps.find((step) => step.id === state.current_step_id) ?? null;
}

export async function run(_argv, ctx) {
  const loaded = resolveRunForSession({
    root: ctx.projectRoot,
    sessionId: ctx.sessionId,
    fallbackToLatest: true,
  });
  if (loaded === null) {
    throw new R2cError(
      'NO_ACTIVE_RUN',
      'no active run for this session',
      { session_id: ctx.sessionId ?? null },
      EXIT_CODES.NO_ACTIVE_RUN,
    );
  }

  const { state, events } = loaded;
  const notes = noteByStep(events);
  const current = currentStep(state);
  const next = current === null
    ? null
    : {
      id: current.id,
      name: current.name,
      status: current.status,
      stage_id: current.stage_id,
    };

  const stages = state.stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    status: stage.status,
    started_at: stage.started_at,
    completed_at: stage.completed_at,
  }));
  const steps = state.steps.map((step) => ({
    id: step.id,
    name: step.name,
    stage_id: step.stage_id,
    skill: step.skill ?? null,
    status: step.status,
    retry_count: step.retry_count ?? 0,
    review_retry_count: step.review_retry_count ?? 0,
    note: notes.get(step.id) ?? null,
  }));

  const data = {
    run: {
      run_id: state.run_id,
      session_id: state.session_id,
      status: state.status,
      workflow_id: state.workflow_id,
      current_step_id: state.current_step_id,
      started_at: state.started_at,
      updated_at: state.updated_at,
      completed_at: state.completed_at,
    },
    stages,
    steps,
    next,
  };

  const text = [
    `run/${state.run_id} ${state.status} ${state.workflow_id}`,
    ...stages.map((stage) => `stage/${stage.id} ${stage.status} ${stage.name}`),
    ...steps.map((step) => `step/${step.id} ${step.status} ${step.name}`),
    next === null ? 'next/-' : `next/${next.id} ${next.name}`,
  ].join('\n').concat('\n');

  return {
    runId: state.run_id,
    sessionId: state.session_id,
    step: current === null
      ? null
      : { id: current.id, name: current.name, status: current.status },
    text,
    data,
  };
}
