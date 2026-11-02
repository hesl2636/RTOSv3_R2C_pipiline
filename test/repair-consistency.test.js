/**
 * Every write command must leave `state.json` exactly equal to what
 * `replayDerived` computes from `events.jsonl`. Any drift makes the next
 * `loadRun` repair (and warn) inside the following transaction, so these tests
 * drive the real CLI and assert both: no repair warning, and state == replay
 * after every command.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { replayDerived } from '../src/state.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const PACK = join(REPO, 'pack');
const REPAIR_WARNING = /repaired from events/;

const MANIFEST_HEAD = `schema: r2c.workflow/v1
id: workflow-repair
name: repair
version: 0.1.0
description: ''
stages:
`;

function cleanEnv() {
  const env = { ...process.env };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
  return env;
}

function cli(args, { cwd, json = false } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args, ...(json ? ['--json'] : [])], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
  });
  return result;
}

function cliJson(args, options) {
  const result = cli(args, { ...options, json: true });
  const lines = result.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got: ${JSON.stringify(result.stdout)}`);
  return { result, envelope: JSON.parse(lines[0]) };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-repair-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-repair-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  return { root, outside };
}

/** The shipped default manifest (4 stages, one prompt step each) in a temp project. */
function defaultProject(t) {
  const project = tempRoot(t);
  cpSync(
    join(PACK, 'workflows', 'hm2B_drvport_pipiline.yaml'),
    join(project.root, 'workflows', 'hm2B_drvport_pipiline.yaml'),
  );
  cpSync(join(PACK, 'tasks'), join(project.root, 'tasks'), { recursive: true });
  cpSync(join(PACK, 'skills'), join(project.root, 'skills'), { recursive: true });
  return project;
}

function promptStep(id, name, text = `${name}。`) {
  return `      - id: ${id}
        name: ${name}
        type: prompt
        prompt: |
          ${text}
`;
}

function shellStep(id, name, command, timeout = 10) {
  return `      - id: ${id}
        name: ${name}
        type: shell
        shell: ${command}
        timeout: ${timeout}
`;
}

function stage(id, name, steps) {
  return `  - id: ${id}
    name: ${name}
    steps:
${steps.join('')}`;
}

function writeManifest(project, stages) {
  const file = join(project.root, 'workflows', 'repair.yaml');
  writeFileSync(file, `${MANIFEST_HEAD}${stages.join('')}`);
  return file;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readState(root, runId) {
  return readJson(join(root, '.r2c', 'runs', runId, 'state.json'));
}

function readEvents(root, runId) {
  return readFileSync(join(root, '.r2c', 'runs', runId, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * The invariant: state.json is a derived cache of events.jsonl. A command that
 * leaves them apart forces the next `loadRun` to repair (and warn).
 */
function assertNoDrift(root, runId, label) {
  const state = readState(root, runId);
  const events = readEvents(root, runId);
  assert.deepEqual(
    replayDerived(state, events),
    state,
    `${label}: state.json must equal replayDerived(state, events)`,
  );
  return state;
}

function assertNoRepair(result, label) {
  assert.doesNotMatch(result.stderr, REPAIR_WARNING, `${label}: repair warning on stderr`);
}

function startRun(t, project) {
  const { result, envelope } = cliJson(['run', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(result.status, 0, result.stderr);
  assertNoRepair(result, 'run');
  assert.deepEqual(result.stderr, '', 'default project run must not warn');
  assertNoDrift(project.root, envelope.run_id, 'run');
  return { runId: envelope.run_id, sessionId: envelope.session_id };
}

function submit(project, sessionId, stepId, label) {
  const { result, envelope } = cliJson(
    ['submit', '--project-root', project.root, '--session-id', sessionId, '--step', stepId],
    { cwd: project.root },
  );
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assertNoRepair(result, label);
  return { result, envelope };
}

test('default manifest: run and every submit are events-consistent without repair', (t) => {
  const project = defaultProject(t);
  const { runId, sessionId } = startRun(t, project);
  const statePath = join(project.root, '.r2c', 'runs', runId, 'state.json');

  let state = assertNoDrift(project.root, runId, 'after run');
  assert.equal(state.current_step_id, 'step-01479654-57d0-468a-9a53-78c821a29f5b');
  assert.equal(state.stages[0].status, 'active');

  const stepIds = state.steps.map((step) => step.id);

  // First submit: its single-step stage completes inside the same transaction.
  let submitted = submit(project, sessionId, stepIds[0], 'first submit');
  assert.equal(submitted.envelope.step.id, stepIds[1]);
  state = assertNoDrift(project.root, runId, 'after first submit');
  assert.equal(state.stages[0].status, 'completed');
  assert.equal(state.stages[0].completed_at !== null, true);
  assert.equal(state.stages[1].status, 'active');
  assert.equal(state.status, 'running');

  // Middle submit: earlier stages stay completed, the run keeps running.
  submitted = submit(project, sessionId, stepIds[1], 'middle submit');
  assert.equal(submitted.envelope.step.id, stepIds[2]);
  state = assertNoDrift(project.root, runId, 'after middle submit');
  assert.deepEqual(
    state.stages.map((stageItem) => stageItem.status),
    ['completed', 'completed', 'active', 'pending'],
  );

  submit(project, sessionId, stepIds[2], 'third submit');
  state = assertNoDrift(project.root, runId, 'after third submit');
  assert.equal(state.stages[3].status, 'active');

  // Final submit: the stage and the run both complete without a repair.
  submitted = submit(project, sessionId, stepIds[3], 'final submit');
  assert.equal(submitted.envelope.step, null);
  state = assertNoDrift(project.root, runId, 'after final submit');
  assert.equal(state.status, 'completed');
  assert.equal(state.current_step_id, null);
  assert.deepEqual(
    state.stages.map((stageItem) => stageItem.status),
    ['completed', 'completed', 'completed', 'completed'],
  );

  assert.deepEqual(
    readEvents(project.root, runId).map(({ kind, event }) => `${kind}:${event}`),
    [
      'run:started',
      'step:started',
      'step:submitted',
      'step:started',
      'step:submitted',
      'step:started',
      'step:submitted',
      'step:started',
      'step:submitted',
      'run:completed',
    ],
    'transitions must not append extra events',
  );

  // Re-reading the run (a fresh loadRun) must not repair either.
  const status = cli(['status', '--project-root', project.root, '--session-id', sessionId], {
    cwd: project.root,
  });
  assert.equal(status.status, 0, status.stderr);
  assertNoRepair(status, 'status after completion');
  assert.equal(readFileSync(statePath, 'utf8'), `${JSON.stringify(state, null, 2)}\n`);
});

test('a submit in a multi-step middle stage keeps that stage active without repair', (t) => {
  const project = tempRoot(t);
  writeManifest(project, [
    stage('stg-one', '阶段一', [promptStep('step-a', '第一步')]),
    stage('stg-two', '阶段二', [
      promptStep('step-b', '第二步'),
      promptStep('step-c', '第三步'),
    ]),
    stage('stg-three', '阶段三', [promptStep('step-d', '第四步')]),
  ]);
  const { runId, sessionId } = startRun(t, project);

  submit(project, sessionId, 'step-a', 'submit step-a');
  let state = assertNoDrift(project.root, runId, 'after step-a');
  assert.equal(state.stages[0].status, 'completed');
  assert.equal(state.stages[1].status, 'active');

  // step-b completes, but its stage still owns the pending step-c.
  const middle = submit(project, sessionId, 'step-b', 'submit step-b');
  assert.equal(middle.envelope.step.id, 'step-c');
  state = assertNoDrift(project.root, runId, 'after step-b');
  assert.equal(state.steps.find((step) => step.id === 'step-b').status, 'completed');
  assert.equal(state.steps.find((step) => step.id === 'step-c').status, 'active');
  assert.equal(state.stages[1].status, 'active');
  assert.equal(state.stages[1].completed_at, null);

  submit(project, sessionId, 'step-c', 'submit step-c');
  state = assertNoDrift(project.root, runId, 'after step-c');
  assert.equal(state.stages[1].status, 'completed');
  assert.equal(state.stages[2].status, 'active');

  submit(project, sessionId, 'step-d', 'submit step-d');
  state = assertNoDrift(project.root, runId, 'after step-d');
  assert.equal(state.status, 'completed');
});

test('a prompt -> shell -> prompt chain writes an events-consistent state without repair', (t) => {
  const project = tempRoot(t);
  mkdirSync(join(project.root, 'scripts'));
  writeFileSync(
    join(project.root, 'scripts', 'shell-ok.cjs'),
    "require('fs').appendFileSync('shell-ran.txt', 'ok\\n')\n",
  );
  writeManifest(project, [
    stage('stg-one', '阶段一', [
      promptStep('step-a', '第一步'),
      shellStep('step-shell', '中间 shell 步', 'node scripts/shell-ok.cjs'),
      promptStep('step-b', '第二步'),
    ]),
    stage('stg-two', '阶段二', [promptStep('step-c', '第三步')]),
  ]);
  const { runId, sessionId } = startRun(t, project);
  assertNoDrift(project.root, runId, 'after run');

  // Submitting the prompt runs the shell step and delivers the second prompt.
  const chained = submit(project, sessionId, 'step-a', 'submit step-a (runs shell)');
  assert.equal(chained.envelope.step.id, 'step-b');
  assert.deepEqual(chained.envelope.step.status, 'active');
  const state = assertNoDrift(project.root, runId, 'after shell chain');
  assert.deepEqual(
    state.steps.map((step) => [step.id, step.status]),
    [
      ['step-a', 'completed'],
      ['step-shell', 'completed'],
      ['step-b', 'active'],
      ['step-c', 'pending'],
    ],
  );
  assert.equal(state.stages[0].status, 'active');
  assert.equal(state.stages[0].completed_at, null);
  assert.equal(readFileSync(join(project.root, 'shell-ran.txt'), 'utf8'), 'ok\n');

  // The stage started_at survives the pending -> active round trip exactly as
  // the event replay derives it from the first member's start event.
  const stepStart = readEvents(project.root, runId)
    .find((event) => event.kind === 'step' && event.event === 'started' && event.step.id === 'step-a');
  assert.equal(state.stages[0].started_at, stepStart.time);

  submit(project, sessionId, 'step-b', 'submit step-b');
  assertNoDrift(project.root, runId, 'after step-b');
  submit(project, sessionId, 'step-c', 'submit step-c');
  const done = assertNoDrift(project.root, runId, 'after step-c');
  assert.equal(done.status, 'completed');
});
