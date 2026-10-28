/**
 * `r2c hook`: the agent-facing trigger surface.
 *
 * `pre-tool-use` only guards writes; `stop` only delivers the current step.
 * Neither subcommand claims a synthetic run (that write belongs to a later
 * ticket), and every path here is read-only: state, events and latest.json are
 * never written.
 */
import { relative, resolve } from 'node:path';
import { R2cError, EXIT_CODES } from '../errors.js';
import {
  detectedManifestPaths,
  extractTargetPaths,
  findProtectedTarget,
  normalizeHookInput,
} from '../hook.js';
import { loadManifest } from '../manifest.js';
import { defaultRunnerCommand, renderStep } from '../render.js';
import { readLatest, readState, STATE_SCHEMA } from '../state.js';

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
    `r2c guard: write to protected runner state is denied: ${displayPath(ctx.projectRoot, hit)}`,
  );
  return raw(`${JSON.stringify({ permissionDecision: 'deny', reason })}\n`, EXIT_CODES.USAGE);
}

function deliverableStep(state) {
  if (state?.schema !== STATE_SCHEMA || state.status !== 'running') return null;
  const current = state.steps?.find((step) => step.id === state.current_step_id);
  return current?.status === 'active' ? current : null;
}

function stop(ctx) {
  const sessionId = ctx.sessionId;
  // No sid, or a synthetic `cli-R…` sid: never guess, never claim.
  if (typeof sessionId !== 'string' || sessionId === '' || /^cli-R/.test(sessionId)) {
    return raw('');
  }

  const latest = readLatest(ctx.projectRoot);
  const entry = latest.runs?.[sessionId];
  const runId = entry?.active_run_id ?? entry?.latest_run_id ?? null;
  if (runId === null) return raw('');

  const state = readState(ctx.projectRoot, runId);
  const current = deliverableStep(state);
  if (current === null) return raw('');

  const manifest = loadManifest({ manifest: ctx.manifest, projectRoot: ctx.projectRoot });
  const text = renderStep({
    manifest: manifest.data,
    root: manifest.root,
    stepId: state.current_step_id,
    runnerCmd: ctx.runnerCmd ?? defaultRunnerCommand(ctx.binPath),
    sessionId: state.session_id,
  });

  if (ctx.format === 'json') {
    return raw(`${JSON.stringify({ decision: 'block', reason: text })}\n`);
  }
  return raw(text);
}

export async function run(argv, ctx) {
  const subcommand = argv[0];
  if (subcommand === 'pre-tool-use') return preToolUse(ctx);
  if (subcommand === 'stop') return stop(ctx);
  throw new R2cError(
    'USAGE',
    `hook requires a subcommand: stop or pre-tool-use${subcommand ? ` (got ${subcommand})` : ''}`,
    { command: 'hook', subcommand: subcommand ?? null },
    EXIT_CODES.USAGE,
  );
}
