/**
 * `hm2b status`: read-only run view.
 *
 * Plain output starts every line with one of four fixed markers (`run/`,
 * `stage/`, `step/`, `next/`) so shells and adapters can grep it without
 * parsing prose; when installs exist, install/engine/manifest lines are
 * appended after them. JSON exposes the same data as `run`, `stages`, `steps`
 * and `next`, plus each step's latest `submitted` note and the additive
 * `installs[]` view (#104).
 *
 * Reading a run also repairs a corrupted `state.json` from `events.jsonl`
 * (see `loadRun`); status never appends an event.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hm2bError, EXIT_CODES } from '../errors.js';
import { inspectManifest } from '../manifest.js';
import { loadRun, resolveRunForSession } from '../state.js';

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Minimal install surface (#104): `.hm2b/install/receipts/<p>/<b>.json`,
 * `.hm2b/install/runtime.json` and `workflows/*.yaml`. Unreadable entries are
 * silently dropped; the engine never fails because the installer state is odd.
 */
function installSurface(projectRoot) {
  const installs = [];
  const receiptsRoot = join(projectRoot, '.hm2b', 'install', 'receipts');
  let projections = [];
  try {
    projections = readdirSync(receiptsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    projections = [];
  }
  for (const projection of projections) {
    let names = [];
    try {
      names = readdirSync(join(receiptsRoot, projection), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const read = readJson(join(receiptsRoot, projection, name));
      if (!read.ok || read.value === null || typeof read.value !== 'object') continue;
      const receipt = read.value;
      const path = `.hm2b/install/receipts/${projection}/${name}`;
      if (receipt.schema !== 'hm2b.install/v2') {
        installs.push({
          projection: receipt.projection?.id ?? projection,
          bundle: receipt.bundle?.id ?? null,
          version: null,
          targets: [],
          receipt: path,
          schema: typeof receipt.schema === 'string' ? receipt.schema : null,
          unsupported: true,
        });
        continue;
      }
      installs.push({
        projection: receipt.projection?.id ?? projection,
        bundle: receipt.bundle?.id ?? null,
        version: receipt.bundle?.version ?? null,
        targets: [...(receipt.host_targets ?? [])].sort(),
        receipt: path,
      });
    }
  }

  const runtimeRead = readJson(join(projectRoot, '.hm2b', 'install', 'runtime.json'));
  const engine = runtimeRead.ok && typeof runtimeRead.value?.engine?.version === 'string'
    ? { version: runtimeRead.value.engine.version }
    : null;

  let manifests = [];
  try {
    manifests = readdirSync(join(projectRoot, 'workflows'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => `workflows/${entry.name}`)
      .sort();
  } catch {
    manifests = [];
  }
  const manifest = manifests.length === 1
    ? manifests[0]
    : manifests.length === 0 ? 'missing' : 'ambiguous';
  return { installs, engine, manifest };
}

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

  // Status stays readable without a manifest (it reports run state only), but
  // when one is available the resume guard applies before any repair write.
  const inspected = inspectManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const loaded = loadRun(ctx.projectRoot, routed.runId, { manifest: inspected.data }) ?? routed;
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

  const surface = installSurface(ctx.projectRoot);
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
    installs: surface.installs,
  };

  const lines = [
    `run/${state.run_id} ${state.status} ${state.workflow_id}`,
    ...stages.map((stage) => `stage/${stage.id} ${stage.status} ${stage.name}`),
    ...steps.map((step) => `step/${step.id} ${step.status} ${step.name}`),
    next === null ? 'next/-' : `next/${next.id} ${next.name}`,
  ];
  // Additive install surface (#104): only when an install is present, so the
  // existing four marker lines stay byte-identical for payload-only projects.
  if (surface.installs.length > 0) {
    for (const install of surface.installs) {
      if (install.unsupported === true) {
        lines.push(`install/${install.projection ?? '?'}/${install.bundle ?? '?'} unsupported schema=${install.schema ?? '?'}`);
      } else {
        lines.push(`install/${install.projection}/${install.bundle} ${install.version} targets=${install.targets.join(',')}`);
      }
    }
    if (surface.engine !== null) lines.push(`engine/${surface.engine.version}`);
    lines.push(`manifest/${surface.manifest}`);
  }
  const text = lines.join('\n').concat('\n');

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
