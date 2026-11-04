/**
 * #86: `submit` from the stable entry point, without a session id.
 *
 * With no `--session-id` / `HM2B_SESSION_ID`, submit resolves the single
 * running run. Exactly one is usable; zero or many is exit 2 with a stable
 * code and no writes (no state, no events, no gate command).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'runtime', 'runner', 'engine', 'bin', 'hm2b.js');

const GATED_TWO_STEP_YAML = `schema: hm2b.workflow/v1
id: workflow-two-step
name: two-step
version: 0.1.0
description: 内核验收用两步清单
stages:
  - id: stg-one
    name: 阶段一
    steps:
      - id: step-a
        name: 第一步
        type: prompt
        prompt: |
          执行第一步。
        gate:
          - command: node gate.cjs
  - id: stg-two
    name: 阶段二
    steps:
      - id: step-b
        name: 第二步
        type: prompt
        prompt: |
          执行第二步（内联提示）。
`;

function tempProject(t, { yaml } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hm2b-sessionless-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'hm2b-sessionless-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeTwoStepProject(root, yaml === undefined ? {} : { yaml });
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

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function startRun(t, project, extra = []) {
  const { result, envelope } = cliJson(
    ['run', '--project-root', project.root, ...extra],
    { cwd: project.outside },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.ok, true);
  return { runId: envelope.run_id, sessionId: envelope.session_id };
}

/**
 * Byte + path snapshot of `.hm2b` (null when the directory does not exist).
 * Directory mtimes are ignored: lock files are created and removed by design.
 */
function snapshotHm2b(root) {
  const base = join(root, '.hm2b');
  if (!existsSync(base)) return null;
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        files.set(relative(base, path), readFileSync(path).toString('base64'));
      }
    }
  };
  walk(base);
  return files;
}

function assertSnapshotEqual(before, after, label) {
  if (before === null) {
    assert.equal(after, null, `${label}: .hm2b/ must not be created`);
    return;
  }
  assert.deepEqual(
    [...after.keys()].sort(),
    [...before.keys()].sort(),
    `${label}: file set changed`,
  );
  for (const [name, bytes] of before) {
    assert.equal(after.get(name), bytes, `${label}: ${name} changed`);
  }
}

test('session-less submit resolves the only running run and advances to the next step', (t) => {
  const project = tempProject(t);
  const started = startRun(t, project);

  const submitted = cliJson(
    ['submit', '--project-root', project.root, '--step', 'step-a'],
    { cwd: project.root },
  );
  assert.equal(submitted.result.status, 0, submitted.result.stderr);
  assert.equal(submitted.envelope.ok, true);
  assert.equal(submitted.envelope.run_id, started.runId);
  assert.equal(submitted.envelope.session_id, started.sessionId);
  assert.equal(submitted.envelope.step.id, 'step-b');
  assert.equal(submitted.envelope.step.status, 'active');

  const state = readJson(join(project.root, '.hm2b', 'runs', started.runId, 'state.json'));
  assert.equal(state.current_step_id, 'step-b');
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'completed');
  assert.equal(state.steps.find((step) => step.id === 'step-b').status, 'active');
});

test('session-less submit without --step advances the current step', (t) => {
  const project = tempProject(t);
  const started = startRun(t, project);

  const submitted = cliJson(['submit', '--project-root', project.root], { cwd: project.root });
  assert.equal(submitted.result.status, 0, submitted.result.stderr);
  assert.equal(submitted.envelope.run_id, started.runId);
  assert.equal(submitted.envelope.step.id, 'step-b');
});

test('session-less submit with no running run exits 2 and writes nothing', (t) => {
  const project = tempProject(t);
  const before = snapshotHm2b(project.root);
  assert.equal(before, null);

  const submitted = cliJson(
    ['submit', '--project-root', project.root, '--step', 'step-a'],
    { cwd: project.root },
  );
  assert.equal(submitted.result.status, 2, submitted.result.stderr);
  assert.equal(submitted.envelope.ok, false);
  assert.equal(submitted.envelope.error.code, 'NO_ACTIVE_RUN');
  assertSnapshotEqual(before, snapshotHm2b(project.root), 'no running run');
});

test('session-less submit with two running runs exits 2, lists candidates and writes nothing', (t) => {
  const project = tempProject(t, { yaml: GATED_TWO_STEP_YAML });
  // The gate proves the failure happens before any gate command runs.
  writeFileSync(
    join(project.root, 'gate.cjs'),
    "require('node:fs').appendFileSync('gate.log', 'ran\\n');\n",
  );

  const first = startRun(t, project, ['--session-id', 'session-alpha']);
  const second = startRun(t, project, ['--session-id', 'session-beta']);
  assert.notEqual(first.runId, second.runId);

  const before = snapshotHm2b(project.root);
  const submitted = cliJson(
    ['submit', '--project-root', project.root, '--step', 'step-a'],
    { cwd: project.root },
  );
  assert.equal(submitted.result.status, 2, submitted.result.stderr);
  assert.equal(submitted.envelope.error.code, 'AMBIGUOUS_RUN');
  assert.deepEqual(
    submitted.envelope.data.candidates,
    [first.runId, second.runId].sort(),
  );
  assert.equal(existsSync(join(project.root, 'gate.log')), false, 'no gate command may run');
  assertSnapshotEqual(before, snapshotHm2b(project.root), 'two running runs');
});

test('explicit --session-id keeps NO_ACTIVE_RUN and STEP_NOT_ACTIVE behaviour', (t) => {
  const project = tempProject(t);

  const noRun = cliJson(
    ['submit', '--project-root', project.root, '--session-id', 'session-x', '--step', 'step-a'],
    { cwd: project.root },
  );
  assert.equal(noRun.result.status, 4);
  assert.equal(noRun.envelope.error.code, 'NO_ACTIVE_RUN');

  const started = startRun(t, project, ['--session-id', 'session-x']);
  const before = snapshotHm2b(project.root);

  const wrongStep = cliJson(
    ['submit', '--project-root', project.root, '--session-id', 'session-x', '--step', 'step-b'],
    { cwd: project.root },
  );
  assert.equal(wrongStep.result.status, 2);
  assert.equal(wrongStep.envelope.error.code, 'STEP_NOT_ACTIVE');
  assertSnapshotEqual(before, snapshotHm2b(project.root), 'STEP_NOT_ACTIVE');

  const submitted = cliJson(
    ['submit', '--project-root', project.root, '--session-id', 'session-x', '--step', 'step-a'],
    { cwd: project.root },
  );
  assert.equal(submitted.result.status, 0, submitted.result.stderr);
  assert.equal(submitted.envelope.run_id, started.runId);
  assert.equal(submitted.envelope.step.id, 'step-b');

  const cancelled = cliJson(
    ['cancel', '--project-root', project.root, '--session-id', 'session-x'],
    { cwd: project.root },
  );
  assert.equal(cancelled.result.status, 0, cancelled.result.stderr);

  const afterCancel = cliJson(
    ['submit', '--project-root', project.root, '--session-id', 'session-x', '--step', 'step-b'],
    { cwd: project.root },
  );
  assert.equal(afterCancel.result.status, 4);
  assert.equal(afterCancel.envelope.error.code, 'NO_ACTIVE_RUN');
});
