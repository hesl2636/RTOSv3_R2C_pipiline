import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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


const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'runtime', 'r2c', 'engine', 'bin', 'r2c.js');

function manifest(stages) {
  return {
    schema: 'r2c.workflow/v1',
    id: 'workflow-gate',
    name: 'gate-tests',
    version: '0.1.0',
    stages,
  };
}

function promptStep(id, name, extra = {}) {
  return { id, name, type: 'prompt', prompt: `执行 ${id}。`, ...extra };
}

function shellStep(id, name, shell, timeout = 10) {
  return { id, name, type: 'shell', shell, timeout };
}

function tempProject(t, data) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-gate-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-gate-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'workflows', 'gate.yaml'), `${JSON.stringify(data, null, 2)}
`);
  return { root, outside };
}

function script(project, name, body) {
  writeFileSync(join(project.root, 'scripts', name), body);
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
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

function readState(root, runId) {
  return readJson(join(root, '.r2c', 'runs', runId, 'state.json'));
}

function onlyRunId(root) {
  return readJson(join(root, '.r2c', 'latest.json')).latest_run_id;
}

function readEvents(root, runId) {
  return readFileSync(join(root, '.r2c', 'runs', runId, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function startRun(t, project) {
  const { result, envelope } = cliJson(['run', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.ok, true);
  return { runId: envelope.run_id, sessionId: envelope.session_id, envelope };
}

function submit(project, sessionId, step, extra = []) {
  return cliJson(
    ['submit', '--project-root', project.root, '--session-id', sessionId, '--step', step, ...extra],
    { cwd: project.outside },
  );
}

test('submit reports every missing expect.outputs glob, increments retry_count and stays active', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          promptStep('step-a', '第一步', {
            expect: { outputs: ['out/a.txt', 'out/b.txt'] },
            gate: [
              { command: 'node scripts/gate-first.cjs' },
              { command: 'node scripts/gate-second.cjs' },
            ],
          }),
          promptStep('step-b', '第二步'),
        ],
      },
    ]),
  );
  script(project, 'gate-first.cjs', "require('fs').appendFileSync('gate-order.txt','first\\n')\n");
  script(project, 'gate-second.cjs', "require('fs').appendFileSync('gate-order.txt','second\\n')\n");

  const { root, outside } = project;
  const { runId, sessionId } = startRun(t, project);

  const rejected = submit(project, sessionId, 'step-a');
  assert.equal(rejected.result.status, 3);
  assert.equal(rejected.envelope.ok, false);
  assert.equal(rejected.envelope.error.code, 'EXPECT_MISSING');
  assert.deepEqual(rejected.envelope.error.details.patterns, ['out/a.txt', 'out/b.txt']);
  assert.match(rejected.envelope.error.message, /out\/a\.txt/);
  assert.match(rejected.envelope.error.message, /out\/b\.txt/);

  let state = readState(root, runId);
  assert.equal(state.status, 'running');
  assert.equal(state.current_step_id, 'step-a');
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'active');
  assert.equal(state.steps.find((step) => step.id === 'step-a').retry_count, 1);
  assert.equal(state.steps.find((step) => step.id === 'step-b').status, 'pending');
  assert.equal(existsSync(join(root, 'gate-order.txt')), false, 'gates must not run without outputs');
  assert.equal(existsSync(join(outside, 'gate-order.txt')), false);

  let events = readEvents(root, runId);
  assert.equal(events.some((event) => event.event === 'submitted'), false);
  const rejection = events.filter((event) => event.kind === 'gate').at(-1);
  assert.equal(rejection.event, 'rejected');
  assert.equal(rejection.phase, 'outputs');
  assert.deepEqual(rejection.patterns, ['out/a.txt', 'out/b.txt']);

  // A second failed submit increments again and still advances nothing.
  assert.equal(submit(project, sessionId, 'step-a').result.status, 3);
  state = readState(root, runId);
  assert.equal(state.steps.find((step) => step.id === 'step-a').retry_count, 2);
  assert.equal(state.current_step_id, 'step-a');

  const next = cli(
    ['next', '--project-root', root, '--session-id', sessionId, '--format', 'plain'],
    { cwd: outside },
  );
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /^## 下一步：第一步（阶段：阶段一）$/m);

  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'out', 'a.txt'), 'a');
  writeFileSync(join(root, 'out', 'b.txt'), 'b');

  const passed = submit(project, sessionId, 'step-a');
  assert.equal(passed.result.status, 0, passed.result.stderr);
  assert.equal(passed.envelope.step.id, 'step-b');
  assert.match(passed.envelope.data.text, /^## 下一步：第二步（阶段：阶段一）$/m);

  state = readState(root, runId);
  assert.equal(state.current_step_id, 'step-b');
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'completed');
  assert.equal(state.steps.find((step) => step.id === 'step-a').retry_count, 2);
  assert.equal(readFileSync(join(root, 'gate-order.txt'), 'utf8'), 'first\nsecond\n');

  events = readEvents(root, runId);
  assert.deepEqual(
    events.map(({ kind, event }) => `${kind}:${event}`),
    [
      'run:started',
      'step:started',
      'gate:rejected',
      'gate:rejected',
      'step:submitted',
      'step:started',
    ],
  );
});

test('gate commands run in manifest order and stop at the first non-zero exit', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          promptStep('step-a', '第一步', {
            expect: { outputs: ['out/a.txt'] },
            gate: [
              { command: 'node scripts/gate-one.cjs' },
              { command: 'node scripts/gate-fail.cjs' },
              { command: 'node scripts/gate-three.cjs' },
            ],
          }),
          promptStep('step-b', '第二步'),
        ],
      },
    ]),
  );
  mkdirSync(join(project.root, 'out'));
  writeFileSync(join(project.root, 'out', 'a.txt'), 'a');
  script(project, 'gate-one.cjs', "require('fs').appendFileSync('gate-order.txt','one\\n')\n");
  script(
    project,
    'gate-fail.cjs',
    "require('fs').appendFileSync('gate-order.txt','fail\\n');process.exit(9)\n",
  );
  script(project, 'gate-three.cjs', "require('fs').appendFileSync('gate-order.txt','three\\n')\n");

  const { root } = project;
  const { runId, sessionId } = startRun(t, project);
  const rejected = submit(project, sessionId, 'step-a');

  assert.equal(rejected.result.status, 3);
  assert.equal(rejected.envelope.error.code, 'GATE_FAILED');
  assert.match(rejected.envelope.error.details.command, /gate-fail\.cjs/);
  assert.equal(rejected.envelope.error.details.exit_code, 9);
  assert.equal(readFileSync(join(root, 'gate-order.txt'), 'utf8'), 'one\nfail\n');

  const state = readState(root, runId);
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'active');
  assert.equal(state.steps.find((step) => step.id === 'step-a').retry_count, 1);
  assert.equal(state.current_step_id, 'step-a');

  const events = readEvents(root, runId);
  const rejection = events.filter((event) => event.kind === 'gate').at(-1);
  assert.equal(rejection.phase, 'gate');
  assert.match(rejection.command, /gate-fail\.cjs/);
  assert.equal(rejection.exit_code, 9);
  assert.equal(events.some((event) => event.event === 'submitted'), false);
});

test('submit runs a shell step between prompt steps and delivers the next prompt', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          promptStep('step-a', '第一步'),
          shellStep('step-shell', '中间 shell 步', 'node scripts/shell-ok.cjs', 5),
          promptStep('step-b', '第二步'),
        ],
      },
    ]),
  );
  script(project, 'shell-ok.cjs', "require('fs').writeFileSync('shell-ran.txt','ok')\n");

  const { root, outside } = project;
  const { runId, sessionId } = startRun(t, project);

  const delivered = submit(project, sessionId, 'step-a', ['--note', 'done a']);
  assert.equal(delivered.result.status, 0, delivered.result.stderr);
  assert.equal(delivered.envelope.step.id, 'step-b');
  assert.equal(delivered.envelope.step.status, 'active');
  assert.match(delivered.envelope.data.text, /^## 下一步：第二步（阶段：阶段一）$/m);
  assert.equal(
    delivered.envelope.data.text.includes('shell-ok.cjs'),
    false,
    'a shell command must never be rendered as prompt text',
  );
  assert.equal(readFileSync(join(root, 'shell-ran.txt'), 'utf8'), 'ok');
  assert.equal(existsSync(join(outside, 'shell-ran.txt')), false, 'shell cwd must be the project root');

  const state = readState(root, runId);
  assert.deepEqual(
    state.steps.map((step) => [step.id, step.status]),
    [
      ['step-a', 'completed'],
      ['step-shell', 'completed'],
      ['step-b', 'active'],
    ],
  );
  assert.equal(state.current_step_id, 'step-b');
  assert.equal(state.status, 'running');

  const events = readEvents(root, runId);
  assert.deepEqual(
    events.map(({ kind, event }) => `${kind}:${event}`),
    [
      'run:started',
      'step:started',
      'step:submitted',
      'step:started',
      'step:completed',
      'step:started',
    ],
  );
  assert.equal(events.find((event) => event.event === 'submitted').note, 'done a');
  assert.equal(events.find((event) => event.kind === 'step' && event.event === 'completed').step.id, 'step-shell');
});

test('run executes leading and consecutive shell steps before delivering the first prompt', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          shellStep('shell-one', '前置一', 'node scripts/one.cjs', 5),
          shellStep('shell-two', '前置二', 'node scripts/two.cjs', 5),
          promptStep('step-a', '第一步'),
        ],
      },
    ]),
  );
  script(project, 'one.cjs', "require('fs').appendFileSync('order.txt','one\\n')\n");
  script(project, 'two.cjs', "require('fs').appendFileSync('order.txt','two\\n')\n");

  const { root } = project;
  const { result, envelope } = cliJson(['run', '--project-root', root], { cwd: project.outside });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.step.id, 'step-a');
  assert.equal(envelope.step.status, 'active');
  assert.match(envelope.data.text, /^## 下一步：第一步（阶段：阶段一）$/m);
  assert.equal(envelope.data.text.includes('one.cjs'), false);
  assert.equal(readFileSync(join(root, 'order.txt'), 'utf8'), 'one\ntwo\n');

  const state = readState(root, envelope.run_id);
  assert.deepEqual(
    state.steps.map((step) => step.status),
    ['completed', 'completed', 'active'],
  );
  assert.equal(state.current_step_id, 'step-a');
});

test('run fails a leading shell step, pauses the run and exits 3', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          shellStep('shell-boom', '前置失败', 'node scripts/boom.cjs', 5),
          promptStep('step-a', '第一步'),
        ],
      },
    ]),
  );
  script(project, 'boom.cjs', 'process.exit(4)\n');

  const { root } = project;
  const failed = cli(['run', '--project-root', root], { cwd: project.outside });
  assert.equal(failed.status, 3);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /shell step shell-boom failed with exit 4/);

  const runId = onlyRunId(root);
  const state = readState(root, runId);
  assert.equal(state.status, 'paused');
  assert.equal(state.current_step_id, 'shell-boom');
  assert.deepEqual(
    state.steps.map((step) => [step.id, step.status]),
    [
      ['shell-boom', 'failed'],
      ['step-a', 'pending'],
    ],
  );
  const events = readEvents(root, runId);
  assert.equal(events.at(-2).kind, 'step');
  assert.equal(events.at(-2).event, 'failed');
  assert.equal(events.at(-1).kind, 'run');
  assert.equal(events.at(-1).event, 'paused');
});

test('run delivers the completed banner when the workflow has only shell steps', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          shellStep('shell-one', '唯一一', 'node scripts/one.cjs', 5),
          shellStep('shell-two', '唯一二', 'node scripts/two.cjs', 5),
        ],
      },
    ]),
  );
  script(project, 'one.cjs', "require('fs').appendFileSync('order.txt','one\\n')\n");
  script(project, 'two.cjs', "require('fs').appendFileSync('order.txt','two\\n')\n");

  const { root } = project;
  const { result, envelope } = cliJson(['run', '--project-root', root], { cwd: project.outside });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.step, null);
  assert.equal(envelope.data.status, 'completed');
  assert.equal(envelope.data.current_step_id, null);
  assert.match(envelope.data.text, new RegExp(`^## 工作流完成（run ${envelope.run_id}）\\r?\\n$`));
  assert.equal(readFileSync(join(root, 'order.txt'), 'utf8'), 'one\ntwo\n');

  const state = readState(root, envelope.run_id);
  assert.equal(state.status, 'completed');
  assert.equal(state.current_step_id, null);
  assert.deepEqual(
    state.steps.map((step) => step.status),
    ['completed', 'completed'],
  );
  const latest = readJson(join(root, '.r2c', 'latest.json'));
  assert.equal(latest.runs[envelope.session_id].active_run_id, null);
});

test('a failing shell step marks the step failed, pauses the run and exits 3', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          promptStep('step-a', '第一步'),
          shellStep('step-boom', '失败 shell 步', 'node scripts/boom.cjs', 5),
          promptStep('step-b', '第二步'),
        ],
      },
    ]),
  );
  script(project, 'boom.cjs', 'process.exit(7)\n');

  const { root } = project;
  const { runId, sessionId } = startRun(t, project);

  const failed = cli(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-a'],
    { cwd: project.outside },
  );
  assert.equal(failed.status, 3);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /shell step step-boom failed with exit 7/);

  const state = readState(root, runId);
  assert.equal(state.status, 'paused');
  assert.equal(state.current_step_id, 'step-boom');
  assert.deepEqual(
    state.steps.map((step) => [step.id, step.status]),
    [
      ['step-a', 'completed'],
      ['step-boom', 'failed'],
      ['step-b', 'pending'],
    ],
  );
  assert.equal(state.steps.find((step) => step.id === 'step-a').retry_count, 0);

  const events = readEvents(root, runId);
  assert.deepEqual(
    events.map(({ kind, event }) => `${kind}:${event}`),
    [
      'run:started',
      'step:started',
      'step:submitted',
      'step:started',
      'step:failed',
      'run:paused',
    ],
  );
  const failure = events.find((event) => event.event === 'failed');
  assert.equal(failure.exit_code, 7);
  assert.equal(failure.timed_out, false);

  const next = cli(['next', '--project-root', root, '--session-id', sessionId], {
    cwd: project.outside,
  });
  assert.equal(next.status, 4);
  assert.equal(next.stdout, '');
});

test('a timing-out shell step fails the step, pauses the run and exits 3', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          promptStep('step-a', '第一步'),
          shellStep('step-slow', '超时 shell 步', 'node scripts/slow.cjs', 1),
          promptStep('step-b', '第二步'),
        ],
      },
    ]),
  );
  script(project, 'slow.cjs', 'setTimeout(() => {}, 30000);\n');

  const { root } = project;
  const { runId, sessionId } = startRun(t, project);

  const failed = submit(project, sessionId, 'step-a');

  assert.equal(failed.result.status, 3);
  assert.equal(failed.envelope.error.code, 'SHELL_TIMEOUT');
  assert.equal(failed.envelope.error.details.timed_out, true);

  const state = readState(root, runId);
  assert.equal(state.status, 'paused');
  assert.equal(state.steps.find((step) => step.id === 'step-slow').status, 'failed');
  assert.equal(state.current_step_id, 'step-slow');

  const events = readEvents(root, runId);
  assert.equal(events.at(-2).event, 'failed');
  assert.equal(events.at(-2).timed_out, true);
  assert.equal(events.at(-1).event, 'paused');
  assert.equal(events.at(-1).kind, 'run');
});

test('a workflow ending on a successful shell step delivers the completed banner', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [promptStep('step-a', '第一步')],
      },
      {
        id: 'stg-two',
        name: '阶段二',
        steps: [shellStep('step-tail', '收尾 shell 步', 'node scripts/tail.cjs', 5)],
      },
    ]),
  );
  script(project, 'tail.cjs', "require('fs').writeFileSync('tail.txt','ok')\n");

  const { root } = project;
  const { runId, sessionId } = startRun(t, project);

  const done = submit(project, sessionId, 'step-a');
  assert.equal(done.result.status, 0, done.result.stderr);
  assert.equal(done.envelope.step, null);
  assert.equal(done.envelope.data.status, 'completed');
  assert.equal(done.envelope.data.current_step_id, null);
  assert.match(done.envelope.data.text, new RegExp(`^## 工作流完成（run ${runId}）\\r?\\n$`));
  assert.equal(readFileSync(join(root, 'tail.txt'), 'utf8'), 'ok');

  const state = readState(root, runId);
  assert.equal(state.status, 'completed');
  assert.equal(state.current_step_id, null);
  assert.deepEqual(
    state.steps.map((step) => step.status),
    ['completed', 'completed'],
  );
  assert.deepEqual(
    state.stages.map((stage) => stage.status),
    ['completed', 'completed'],
  );
  const latest = readJson(join(root, '.r2c', 'latest.json'));
  assert.equal(latest.runs[sessionId].active_run_id, null);
});

test('submit has no --force bypass', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [promptStep('step-a', '第一步')],
      },
    ]),
  );
  const { root } = project;
  const { runId, sessionId } = startRun(t, project);
  const before = readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8');

  const forced = submit(project, sessionId, 'step-a', ['--force']);
  assert.equal(forced.result.status, 2);
  assert.equal(forced.envelope.ok, false);
  assert.equal(forced.envelope.error.code, 'USAGE');
  assert.match(forced.envelope.error.message, /unknown option: --force/);

  assert.equal(readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8'), before);
  assert.equal(readEvents(root, runId).some((event) => event.kind === 'gate'), false);
});

test('a quoted gate command is executed verbatim, not silently passed', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          promptStep('step-a', '第一步', {
            gate: [{ command: 'node -e "process.exit(1)"' }],
          }),
        ],
      },
    ]),
  );
  const { runId, sessionId } = startRun(t, project);

  const rejected = submit(project, sessionId, 'step-a');
  assert.equal(rejected.result.status, 3, rejected.result.stderr);
  assert.equal(rejected.envelope.error.code, 'GATE_FAILED');
  assert.equal(readState(project.root, runId).steps[0].status, 'active');
});

test('gate[].timeout overrides the default 120s', (t) => {
  const project = tempProject(
    t,
    manifest([
      {
        id: 'stg-one',
        name: '阶段一',
        steps: [
          promptStep('step-a', '第一步', {
            gate: [{ command: 'node -e "setTimeout(() => {}, 5000)"', timeout: 1 }],
          }),
        ],
      },
    ]),
  );
  const { sessionId } = startRun(t, project);

  const startedAt = Date.now();
  const rejected = submit(project, sessionId, 'step-a');
  const elapsed = Date.now() - startedAt;
  assert.equal(rejected.result.status, 3, rejected.result.stderr);
  assert.equal(rejected.envelope.error.code, 'GATE_TIMEOUT');
  assert.ok(elapsed < 4500, `gate timeout was not honoured (${elapsed}ms)`);
});
