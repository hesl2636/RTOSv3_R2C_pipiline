/**
 * `hm2b hook`: the agent-facing trigger surface.
 *
 * `pre-tool-use` only guards writes and never claims. `stop` delivers the
 * current step and, for a real session id, may perform the single claim write
 * that binds a synthetic `cli-<runId>` run to that session (ticket #24).
 *
 * Claim rules: no sid and synthetic sids are no-ops; a routed running run is
 * delivered without a claim; a claim happens only when exactly one structural
 * candidate exists and the calling session owns no live run. Ambiguity is
 * silent on stdout and reported once on stderr. `stop` never exits 2.
 */
import { relative, resolve } from 'node:path';
import { Hm2bError, EXIT_CODES, isHm2bError } from '../errors.js';
import {
  claimRun,
  findClaimCandidates,
  hasLiveRun,
  isSyntheticHookSession,
  routedRun,
} from '../claim.js';
import {
  detectedManifestPaths,
  extractTargetPaths,
  findProtectedTarget,
  normalizeHookInput,
} from '../hook.js';
import { loadManifest } from '../manifest.js';
import { defaultRunnerCommand, renderStep } from '../render.js';
import { STATE_SCHEMA } from '../state.js';

function raw(stdout, exitCode = EXIT_CODES.OK) {
  return { raw: true, stdout, exitCode };
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function displayPath(root, target) {
  const absolute = resolve(root, target);
  const rel = relative(root, absolute);
  return rel === '' || rel.startsWith('..') ? absolute : rel;
}

function preToolUse(ctx) {
  const input = normalizeHookInput(ctx.hookInput);
  const paths = extractTargetPaths(input);
  if (paths.length === 0) return raw('');

  const hit = findProtectedTarget({
    projectRoot: ctx.projectRoot,
    targetPaths: paths,
    manifestPaths: detectedManifestPaths({
      projectRoot: ctx.projectRoot,
      manifest: ctx.manifest,
    }),
  });
  if (hit === null) return raw('');

  const reason = oneLine(
    `hm2b guard: write to protected runner state is denied: ${displayPath(ctx.projectRoot, hit)}`,
  );
  return raw(`${JSON.stringify({ permissionDecision: 'deny', reason })}\n`, EXIT_CODES.USAGE);
}

function deliverableStep(state) {
  if (state?.schema !== STATE_SCHEMA || state.status !== 'running') return null;
  const current = state.steps?.find((step) => step.id === state.current_step_id);
  return current?.status === 'active' ? current : null;
}

/** Render the step block for the (possibly just claimed) run. */
function deliver(ctx, state) {
  const current = deliverableStep(state);
  if (current === null) return raw('');

  const manifest = loadManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const text = renderStep({
    manifest: manifest.data,
    root: manifest.root,
    stepId: state.current_step_id,
    runnerCmd: ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath, { projectRoot: ctx.projectRoot }),
    sessionId: state.session_id,
    manifestPath: ctx.manifest ?? null,
  });

  if (ctx.format === 'json') {
    return raw(`${JSON.stringify({ decision: 'block', reason: text })}\n`);
  }
  return raw(text);
}

function stopFlow(ctx) {
  const sessionId = ctx.sessionId;
  // No sid, or a synthetic `cli-R…` sid: never guess, never claim.
  if (typeof sessionId !== 'string' || sessionId === '' || isSyntheticHookSession(sessionId)) {
    return raw('');
  }

  // A session already routed to a running run gets normal delivery.
  const routed = routedRun(ctx.projectRoot, sessionId);
  if (routed !== null && routed.state.status === 'running') {
    return deliver(ctx, routed.state);
  }

  const workflowId = typeof ctx.workflow === 'string' && ctx.workflow !== ''
    ? ctx.workflow
    : null;
  const candidates = findClaimCandidates(ctx.projectRoot, { workflowId });
  if (candidates.length === 0) return raw('');
  if (candidates.length > 1) {
    process.stderr.write(
      `[hm2b] ${candidates.length} unclaimed cli runs in this project; claim skipped (ambiguous). `
      + 'Use "hm2b status --session-id cli-<runId>" / "hm2b cancel --session-id cli-<runId>" '
      + 'to resolve.\n',
    );
    return raw('');
  }
  if (hasLiveRun(ctx.projectRoot, sessionId)) return raw('');

  const claimed = claimRun({
    root: ctx.projectRoot,
    runId: candidates[0].runId,
    sessionId,
    workflowId,
    now: ctx.now(),
  });
  if (claimed === null) return raw('');
  return deliver(ctx, claimed.state);
}

function stop(ctx) {
  try {
    return stopFlow(ctx);
  } catch (error) {
    if (isHm2bError(error) && error.code === 'LOCK_CONFLICT') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Hm2bError('INTERNAL', message, null, EXIT_CODES.INTERNAL);
  }
}

export async function run(argv, ctx) {
  const subcommand = argv[0];
  if (subcommand === 'pre-tool-use') return preToolUse(ctx);
  if (subcommand === 'stop') return stop(ctx);
  throw new Hm2bError(
    'USAGE',
    `hook requires a subcommand: stop or pre-tool-use${subcommand ? ` (got ${subcommand})` : ''}`,
    { command: 'hook', subcommand: subcommand ?? null },
    EXIT_CODES.USAGE,
  );
}
