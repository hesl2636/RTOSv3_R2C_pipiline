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
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const RUN_ID = /^R\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const STATE_FIELDS = [
  'schema',
  'run_id',
  'session_id',
  'status',
  'workflow_id',
  'workflow_engine',
  'engine',
  'engine_version',
  'interaction_mode',
  'started_at',
  'updated_at',
  'completed_at',
  'user_input',
  'current_step_id',
  'stages',
  'steps',
].sort();

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-kernel-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-kernel-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeTwoStepProject(root);
  return { root, outside };
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
  return env;
}

function cli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env: cleanEnv(env),
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

function readEvents(root, runId) {
  const file = join(root, '.r2c', 'runs', runId, 'events.jsonl');
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readState(root, runId) {
  return readJson(join(root, '.r2c', 'runs', runId, 'state.json'));
}

function startRun(t, args = []) {
  const project = tempProject(t);
  const { result, envelope } = cliJson(['run', '--project-root', project.root, ...args], {
    cwd: project.outside,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.ok, true);
  return { ...project, result, envelope, runId: envelope.run_id, sessionId: envelope.session_id };
}

test('run mints a cli session and writes only inside the project .r2c', (t) => {
  const project = tempProject(t);
  const { result, envelope } = cliJson(['run', '--project-root', project.root], {
    cwd: project.outside,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, 'run');
  assert.equal(envelope.code, 0);
  assert.equal(envelope.error, null);
  assert.match(envelope.run_id, RUN_ID);
  assert.equal(envelope.session_id, `cli-${envelope.run_id}`);
  assert.deepEqual(envelope.step, {
    id: 'step-a',
    name: '第一步',
    status: 'active',
  });

  const runId = envelope.run_id;
  const runDir = join(project.root, '.r2c', 'runs', runId);
  for (const name of ['state.json', 'events.jsonl', 'workflow.yaml']) {
    assert.ok(existsSync(join(runDir, name)), `missing ${name}`);
  }
  assert.deepEqual(readdirSync(project.outside), [], 'cwd outside the project must stay untouched');
  assert.equal(existsSync(join(project.outside, '.r2c')), false);

  const state = readState(project.root, runId);
  assert.deepEqual(Object.keys(state).sort(), STATE_FIELDS);
  assert.equal(state.schema, 'r2c.state/v1');
  assert.equal(state.run_id, runId);
  assert.equal(state.session_id, `cli-${runId}`);
  assert.equal(state.status, 'running');
  assert.equal(state.workflow_id, 'workflow-two-step');
  assert.equal(state.current_step_id, 'step-a');
  assert.equal(state.completed_at, null);
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'active');
  assert.equal(state.steps.find((step) => step.id === 'step-b').status, 'pending');
  assert.equal(state.stages[0].status, 'active');
  assert.equal(state.stages[1].status, 'pending');
  assert.equal(state.stages[0].trace_started_at, null);
  assert.equal(state.stages[0].trace_completed_at, null);

  const latest = readJson(join(project.root, '.r2c', 'latest.json'));
  assert.deepEqual(latest, {
    schema: 'r2c.latest/v1',
    runs: {
      [`cli-${runId}`]: { active_run_id: runId, latest_run_id: runId },
    },
    active_run_id: runId,
    latest_run_id: runId,
  });

  const events = readEvents(project.root, runId);
  assert.deepEqual(
    events.map(({ kind, event }) => `${kind}:${event}`),
    ['run:started', 'step:started'],
  );
  assert.deepEqual(events[1].step, { id: 'step-a', name: '第一步' });

  const snapshot = readFileSync(join(project.root, '.r2c', 'runs', runId, 'workflow.yaml'), 'utf8');
  assert.ok(snapshot.includes('schema: r2c.workflow/v1'));
});

test('run text output carries the prompt, whitelists and an executable submit line', (t) => {
  const project = tempProject(t);
  const result = cli(['run', '--project-root', project.root], { cwd: project.root });
  assert.equal(result.status, 0, result.stderr);

  assert.match(result.stdout, /^## 下一步：第一步（阶段：阶段一）$/m);
  assert.match(result.stdout, /执行第一步，产出可以提交的结果。/);
  assert.match(result.stdout, /技能白名单：alpha、beta/);
  assert.match(result.stdout, /MCP 白名单：mcp-demo/);
  assert.match(result.stdout, /提交命令（完成后执行；不要手改 \.r2c）：/);

  const submitLine = result.stdout
    .trimEnd()
    .split(/\r?\n/)
    .find((line) => line.includes(' submit --session-id '));
  assert.ok(submitLine, 'submit line is missing');
  const sid = /--session-id (\S+)/.exec(submitLine)[1];
  assert.match(sid, new RegExp(`^cli-R\\d{8}T\\d{6}Z-[0-9a-f]{6}$`));
  assert.match(submitLine, /--step step-a$/);

  // The rendered line must be directly executable by the platform shell.
  const submitted = spawnSync(submitLine, {
    cwd: project.root,
    encoding: 'utf8',
    env: cleanEnv(),
    shell: true,
  });
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(submitted.stdout, /^## 下一步：第二步（阶段：阶段二）$/m);
  assert.match(submitted.stdout, /执行第二步（内联提示）。/);
});

test('next --format plain reproduces the run delivery byte-for-byte', (t) => {
  const project = tempProject(t);
  const started = cli(['run', '--project-root', project.root], { cwd: project.root });
  assert.equal(started.status, 0, started.stderr);

  const sid = /--session-id (\S+)/.exec(started.stdout)[1];
  const next = cli(
    ['next', '--project-root', project.root, '--session-id', sid, '--format', 'plain'],
    { cwd: project.root },
  );
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout.trim(), started.stdout.trim());
});

test('submit advances one step, delivers the next step and completes the last step', (t) => {
  const { root, runId, sessionId } = startRun(t);

  const first = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-a'],
    { cwd: root },
  );
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.envelope.ok, true);
  assert.equal(first.envelope.command, 'submit');
  assert.equal(first.envelope.step.id, 'step-b');
  assert.equal(first.envelope.step.status, 'active');
  assert.match(first.envelope.data.text, /^## 下一步：第二步（阶段：阶段二）$/m);
  assert.match(first.envelope.data.text, /--step step-b\r?\n$/);

  let state = readState(root, runId);
  assert.equal(state.status, 'running');
  assert.equal(state.current_step_id, 'step-b');
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'completed');
  assert.equal(state.steps.find((step) => step.id === 'step-b').status, 'active');
  assert.equal(state.stages[0].status, 'completed');
  assert.equal(state.stages[1].status, 'active');
  assert.deepEqual(
    readEvents(root, runId).map(({ kind, event }) => `${kind}:${event}`),
    ['run:started', 'step:started', 'step:submitted', 'step:started'],
  );

  const last = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-b'],
    { cwd: root },
  );
  assert.equal(last.result.status, 0, last.result.stderr);
  assert.equal(last.envelope.ok, true);
  assert.equal(last.envelope.step, null);
  assert.equal(last.envelope.data.status, 'completed');
  assert.match(last.envelope.data.text, new RegExp(`^## 工作流完成（run ${runId}）\\r?\\n$`));

  state = readState(root, runId);
  assert.equal(state.status, 'completed');
  assert.equal(state.current_step_id, null);
  assert.equal(state.completed_at !== null, true);
  assert.deepEqual(
    state.steps.map((step) => step.status),
    ['completed', 'completed'],
  );
  assert.deepEqual(
    readEvents(root, runId).map(({ kind, event }) => `${kind}:${event}`),
    ['run:started', 'step:started', 'step:submitted', 'step:started', 'step:submitted', 'run:completed'],
  );

  const latest = readJson(join(root, '.r2c', 'latest.json'));
  assert.equal(latest.runs[sessionId].active_run_id, null);
  assert.equal(latest.runs[sessionId].latest_run_id, runId);
  assert.equal(latest.active_run_id, null);
  assert.equal(latest.latest_run_id, runId);

  const after = cli(['next', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(after.status, 4);
  assert.equal(after.stdout, '');
});

test('session-required write commands without a session exit 2 and leave state untouched', (t) => {
  const { root, runId } = startRun(t);
  const before = readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8');

  // `submit` alone resolves a single running run when no session id is given
  // (ticket #86); every other writer still requires one.
  for (const command of ['pause', 'resume', 'cancel']) {
    const { result, envelope } = cliJson([command, '--project-root', root], { cwd: root });
    assert.equal(result.status, 2, command);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'MISSING_SESSION');
  }
  assert.equal(
    readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8'),
    before,
  );
});

test('read-only commands exit 4 when there is no deliverable run', (t) => {
  const project = tempProject(t);
  const noRun = cli(['next', '--project-root', project.root, '--session-id', 'ghost'], {
    cwd: project.outside,
  });
  assert.equal(noRun.status, 4);
  assert.equal(noRun.stdout, '');

  const bare = cli(['next', '--project-root', project.root], { cwd: project.outside });
  assert.equal(bare.status, 4);
  assert.equal(bare.stdout, '');

  const { result, envelope } = cliJson(['next', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(result.status, 4);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'NO_ACTIVE_RUN');
});

test('run ids keep lexicographic time order for runs in the same second', (t) => {
  const project = tempProject(t);
  const first = cliJson(['run', '--project-root', project.root], { cwd: project.outside });
  const second = cliJson(['run', '--project-root', project.root], { cwd: project.outside });
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.ok(first.envelope.run_id < second.envelope.run_id);

  const latest = readJson(join(project.root, '.r2c', 'latest.json'));
  assert.equal(latest.active_run_id, second.envelope.run_id);
  assert.equal(latest.latest_run_id, second.envelope.run_id);
  assert.equal(
    latest.runs[first.envelope.session_id].latest_run_id,
    first.envelope.run_id,
  );
});

test('delivery requires a running run with an active current step', (t) => {
  const { root, runId, sessionId, envelope } = startRun(t);
  const statePath = join(root, '.r2c', 'runs', runId, 'state.json');
  const eventsPath = join(root, '.r2c', 'runs', runId, 'events.jsonl');

  const state = readState(root, runId);
  state.status = 'paused';
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    eventsPath,
    `${readFileSync(eventsPath, 'utf8')}${JSON.stringify({
      kind: 'run',
      event: 'paused',
      time: new Date().toISOString(),
    })}\n`,
  );

  const paused = cli(['next', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(paused.status, 4);
  assert.equal(paused.stdout, '');

  assert.equal(envelope.session_id, sessionId);
});

test('events are the repair source for inconsistent derived state', (t) => {
  const { root, runId, sessionId } = startRun(t);
  const statePath = join(root, '.r2c', 'runs', runId, 'state.json');
  const eventsBefore = readFileSync(join(root, '.r2c', 'runs', runId, 'events.jsonl'), 'utf8');

  const state = readState(root, runId);
  state.status = 'paused';
  state.current_step_id = 'step-b';
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const result = cli(['next', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^## 下一步：第一步（阶段：阶段一）$/m);

  const repaired = readState(root, runId);
  assert.equal(repaired.status, 'running');
  assert.equal(repaired.current_step_id, 'step-a');
  assert.equal(repaired.steps.find((step) => step.id === 'step-a').status, 'active');
  assert.equal(
    readFileSync(join(root, '.r2c', 'runs', runId, 'events.jsonl'), 'utf8'),
    eventsBefore,
    'repair must not append events',
  );
});

test('run rejects reserved cli sessions and duplicate live sessions', (t) => {
  const project = tempProject(t);
  const reserved = cliJson(
    ['run', '--project-root', project.root, '--session-id', 'cli-R20260101T000000Z-abcdef'],
    { cwd: project.outside },
  );
  assert.equal(reserved.result.status, 2);
  assert.equal(reserved.envelope.error.code, 'SESSION_ID_RESERVED');

  const malformed = cliJson(
    ['run', '--project-root', project.root, '--session-id', 'cli-R123'],
    { cwd: project.outside },
  );
  assert.equal(malformed.result.status, 2);
  assert.equal(malformed.envelope.error.code, 'SESSION_ID_RESERVED');

  const viaAlias = cliJson(['run', '--project', project.root], { cwd: project.outside });
  assert.equal(viaAlias.result.status, 0, viaAlias.result.stderr);
  assert.match(viaAlias.envelope.session_id, /^cli-R/);

  const session = 'session-01';
  const first = cliJson(
    ['run', '--project-root', project.root, '--session-id', session],
    { cwd: project.outside },
  );
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.envelope.session_id, session);

  const again = cliJson(
    ['run', '--project-root', project.root, '--session-id', session],
    { cwd: project.outside },
  );
  assert.equal(again.result.status, 2);
  assert.equal(again.envelope.error.code, 'RUN_ALREADY_ACTIVE');
});

test('submit rejects a step that is not current or not active', (t) => {
  const { root, sessionId } = startRun(t);
  const wrong = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-b'],
    { cwd: root },
  );
  assert.equal(wrong.result.status, 2);
  assert.equal(wrong.envelope.error.code, 'STEP_NOT_ACTIVE');
});

test('--runner-cmd is rendered verbatim into the submit line', (t) => {
  const project = tempProject(t);
  const result = cli(
    ['run', '--project-root', project.root, '--runner-cmd', 'node "custom runner.js"'],
    { cwd: project.root },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^node "custom runner\.js" submit --session-id \S+ --step step-a$/m,
  );
});

test('explicit --manifest resolves task files relative to its manifest root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'r2c-kernel-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTwoStepProject(root);

  const result = cli(
    [
      'run',
      '--project-root',
      root,
      '--manifest',
      join(root, 'workflows', 'two-step.yaml'),
    ],
    { cwd: root },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /执行第一步，产出可以提交的结果。/);
  const manifestPath = join(root, 'workflows', 'two-step.yaml');
  assert.ok(
    result.stdout.includes(`--manifest "${manifestPath}"`),
    'the printed Submit line must repeat --manifest so it stays executable',
  );
});

test('--version prints exactly one line', () => {
  const result = cli(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${VERSION}\n`);
  assert.equal(result.stderr, '');
});

test('an unsupported Node version exits 2 with NODE_UNSUPPORTED', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-node-floor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, 'node-floor.cjs');
  writeFileSync(
    preload,
    "Object.defineProperty(process.versions, 'node', { value: '23.0.0' });\n",
  );
  const run = (args) => spawnSync(process.execPath, ['--require', preload, BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanEnv(),
  });

  const plain = run(['--version']);
  assert.equal(plain.status, 2, plain.stderr);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /unsupported Node\.js 23\.0\.0/);

  const json = run(['status', '--json']);
  assert.equal(json.status, 2, json.stderr);
  const lines = json.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got ${JSON.stringify(json.stdout)}`);
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'NODE_UNSUPPORTED');
});

test('state from a newer schema exits 2 STATE_SCHEMA_NEWER without writes', (t) => {
  const { root, runId, sessionId } = startRun(t);
  const file = join(root, '.r2c', 'runs', runId, 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.schema = 'r2c.state/v2';
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  const before = readFileSync(file, 'utf8');

  const result = cliJson(['status', '--project-root', root, '--session-id', sessionId], {
    cwd: root,
  });
  assert.equal(result.result.status, 2);
  assert.equal(result.envelope.error.code, 'STATE_SCHEMA_NEWER');
  assert.equal(result.envelope.error.details.schema, 'r2c.state/v2');
  assert.equal(readFileSync(file, 'utf8'), before, 'state must not be repaired or downgraded');
});

test('unknown commands and options exit 2 with stable error codes', () => {
  const unknown = cliJson(['nope']);
  assert.equal(unknown.result.status, 2);
  assert.equal(unknown.envelope.error.code, 'UNKNOWN_COMMAND');

  const usage = cliJson(['next', '--bogus']);
  assert.equal(usage.result.status, 2);
  assert.equal(usage.envelope.error.code, 'USAGE');
});
