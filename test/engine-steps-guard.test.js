/**
 * #86: the resume guard — a run records a step-id sequence; resuming it against
 * a manifest whose sequence changed (add/remove/reorder) is refused with
 * `MANIFEST_STEPS_CHANGED` before any state or event write.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { STATE_SCHEMA, loadRun } from '../runtime/runner/engine/src/state.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'runtime', 'runner', 'engine', 'bin', 'hm2b.js');

function promptStep(id, name = `步骤 ${id}`) {
  return { id, name, type: 'prompt', prompt: `执行 ${id}。` };
}

function manifest(steps, { stageName = '阶段一' } = {}) {
  return {
    schema: 'hm2b.workflow/v1',
    id: 'workflow-guard',
    name: 'guard',
    version: '0.1.0',
    stages: [{ id: 'stg-one', name: stageName, steps }],
  };
}

function writeManifest(root, steps, options) {
  mkdirSync(join(root, 'workflows'), { recursive: true });
  writeFileSync(join(root, 'workflows', 'guard.yaml'), `${JSON.stringify(manifest(steps, options), null, 2)}
`);
}

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'hm2b-guard-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'hm2b-guard-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeManifest(root, [promptStep('step-a'), promptStep('step-b')]);
  return { root, outside };
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.HM2B_SESSION_ID;
  delete env.HM2B_PROJECT_ROOT;
  delete env.DSH_SESSION_ID;
  return env;
}

function cli(args, { cwd }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
  });
}

function cliJson(args, options) {
  const result = cli([...args, '--json'], options);
  const lines = result.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got: ${JSON.stringify(result.stdout)}`);
  return { result, envelope: JSON.parse(lines[0]) };
}

function startRun(t, project) {
  const { result, envelope } = cliJson(
    ['run', '--project-root', project.root],
    { cwd: project.outside },
  );
  assert.equal(result.status, 0, result.stderr);
  return { runId: envelope.run_id, sessionId: envelope.session_id };
}

function runFiles(root, runId) {
  const dir = join(root, '.hm2b', 'runs', runId);
  return {
    state: join(dir, 'state.json'),
    events: join(dir, 'events.jsonl'),
  };
}

/**
 * Invoke a command and assert it was refused by the guard without touching
 * `state.json` or `events.jsonl`.
 */
function assertGuardRejected(t, project, runId, args, expected = {}) {
  const files = runFiles(project.root, runId);
  const stateBefore = readFileSync(files.state, 'utf8');
  const eventsBefore = readFileSync(files.events, 'utf8');

  const { result, envelope } = cliJson(
    [...args, '--project-root', project.root, ...(expected.sessionless ? [] : ['--session-id', expected.sessionId])],
    { cwd: project.root },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'MANIFEST_STEPS_CHANGED');
  assert.equal(readFileSync(files.state, 'utf8'), stateBefore, 'state.json must not change');
  assert.equal(readFileSync(files.events, 'utf8'), eventsBefore, 'events.jsonl must not change');
  return envelope;
}

test('adding a step rejects submit, next and status with MANIFEST_STEPS_CHANGED', (t) => {
  const project = tempProject(t);
  const { runId, sessionId } = startRun(t, project);

  writeManifest(project.root, [
    promptStep('step-a'),
    promptStep('step-b'),
    promptStep('step-c'),
  ]);

  const submit = assertGuardRejected(t, project, runId, ['submit', '--step', 'step-a'], { sessionId });
  assert.equal(submit.error.details.position, 3);
  assert.deepEqual(submit.error.details.recorded, ['step-a', 'step-b']);
  assert.deepEqual(submit.error.details.manifest, ['step-a', 'step-b', 'step-c']);

  assertGuardRejected(t, project, runId, ['next'], { sessionId });
  assertGuardRejected(t, project, runId, ['status'], { sessionId });
});

test('session-less submit is guarded too', (t) => {
  const project = tempProject(t);
  const { runId } = startRun(t, project);
  writeManifest(project.root, [promptStep('step-a'), promptStep('step-b'), promptStep('step-c')]);

  assertGuardRejected(t, project, runId, ['submit', '--step', 'step-a'], {
    sessionless: true,
  });
});

test('removing a step is rejected', (t) => {
  const project = tempProject(t);
  const { runId, sessionId } = startRun(t, project);

  writeManifest(project.root, [promptStep('step-a')]);

  const envelope = assertGuardRejected(t, project, runId, ['submit', '--step', 'step-a'], { sessionId });
  assert.equal(envelope.error.details.position, 2);
  assert.deepEqual(envelope.error.details.recorded, ['step-a', 'step-b']);
  assert.deepEqual(envelope.error.details.manifest, ['step-a']);
});

test('reordering the same step ids is rejected', (t) => {
  const project = tempProject(t);
  const { runId, sessionId } = startRun(t, project);

  writeManifest(project.root, [promptStep('step-b'), promptStep('step-a')]);

  const envelope = assertGuardRejected(t, project, runId, ['submit', '--step', 'step-a'], { sessionId });
  assert.equal(envelope.error.details.position, 1);
  assert.deepEqual(envelope.error.details.recorded, ['step-a', 'step-b']);
  assert.deepEqual(envelope.error.details.manifest, ['step-b', 'step-a']);
});

test('an unchanged id sequence resumes, ignoring names', (t) => {
  const project = tempProject(t);
  const { runId, sessionId } = startRun(t, project);

  writeManifest(
    project.root,
    [promptStep('step-a', '改过的第一步'), promptStep('step-b', '改过的第二步')],
    { stageName: '改过的阶段' },
  );

  const submitted = cliJson(
    ['submit', '--project-root', project.root, '--session-id', sessionId, '--step', 'step-a'],
    { cwd: project.root },
  );
  assert.equal(submitted.result.status, 0, submitted.result.stderr);
  assert.equal(submitted.envelope.step.id, 'step-b');

  const state = JSON.parse(readFileSync(runFiles(project.root, runId).state, 'utf8'));
  assert.equal(state.current_step_id, 'step-b');
});

test('a legacy state without a steps array is not compared', (t) => {
  const project = tempProject(t);
  const { runId } = startRun(t, project);

  const files = runFiles(project.root, runId);
  writeFileSync(
    files.state,
    `${JSON.stringify({ schema: STATE_SCHEMA, run_id: runId }, null, 2)}\n`,
  );

  const loaded = loadRun(project.root, runId, {
    repair: false,
    manifest: manifest([promptStep('step-a'), promptStep('step-b')]),
  });
  assert.notEqual(loaded, null);
  assert.deepEqual(loaded.state.steps, undefined);
});
