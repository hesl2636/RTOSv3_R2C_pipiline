import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const RUN_ID = /^R\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-lifecycle-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-lifecycle-outside-'));
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

function readState(root, runId) {
  return readJson(join(root, '.r2c', 'runs', runId, 'state.json'));
}

function eventsFile(root, runId) {
  return join(root, '.r2c', 'runs', runId, 'events.jsonl');
}

function readEvents(root, runId) {
  return readFileSync(eventsFile(root, runId), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendEvents(root, runId, events) {
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  writeFileSync(eventsFile(root, runId), `${readFileSync(eventsFile(root, runId), 'utf8')}${lines}`);
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

function statusJson(root, sessionId) {
  const args = ['status', '--project-root', root];
  if (sessionId !== undefined && sessionId !== null) args.push('--session-id', sessionId);
  return cliJson(args, { cwd: root });
}

function statusText(root, sessionId) {
  const args = ['status', '--project-root', root];
  if (sessionId !== undefined && sessionId !== null) args.push('--session-id', sessionId);
  return cli(args, { cwd: root });
}

test('status plain text uses fixed run/stage/step/next markers', (t) => {
  const { root, sessionId } = startRun(t);
  const result = cli(['status', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');

  const lines = result.stdout.trimEnd().split(/\r?\n/);
  assert.ok(lines.length >= 4);
  for (const line of lines) assert.match(line, /^(run|stage|step|next)\//);
  assert.match(result.stdout, /^run\/R\d{8}T\d{6}Z-[0-9a-f]{6} running workflow-two-step$/m);
  assert.match(result.stdout, /^stage\/stg-one active 阶段一$/m);
  assert.match(result.stdout, /^step\/step-b pending 第二步$/m);
  assert.match(result.stdout, /^next\/step-a 第一步$/m);
});

test('status --json exposes run, stages, steps and next, and echoes submit notes', (t) => {
  const { root, runId, sessionId } = startRun(t);
  const submitted = cliJson(
    [
      'submit',
      '--project-root',
      root,
      '--session-id',
      sessionId,
      '--step',
      'step-a',
      '--note',
      'placeholder:demo-skill',
    ],
    { cwd: root },
  );
  assert.equal(submitted.result.status, 0, submitted.result.stderr);

  const { result, envelope } = statusJson(root, sessionId);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.command, 'status');
  assert.equal(envelope.run_id, runId);
  assert.equal(envelope.session_id, sessionId);
  assert.equal(envelope.data.run.run_id, runId);
  assert.equal(envelope.data.run.status, 'running');
  assert.equal(envelope.data.run.current_step_id, 'step-b');
  assert.deepEqual(envelope.data.stages.map((stage) => stage.id), ['stg-one', 'stg-two']);
  assert.deepEqual(
    envelope.data.steps.map((step) => [step.id, step.status, step.note]),
    [
      ['step-a', 'completed', 'placeholder:demo-skill'],
      ['step-b', 'active', null],
    ],
  );
  assert.deepEqual(envelope.data.next, {
    id: 'step-b',
    name: '第二步',
    status: 'active',
    stage_id: 'stg-two',
  });

  const events = readEvents(root, runId);
  const noteEvent = events.find((event) => event.kind === 'step' && event.event === 'submitted');
  assert.equal(noteEvent.note, 'placeholder:demo-skill');
});

test('status without a session falls back to latest.json and exits 4 when no run exists', (t) => {
  const project = tempProject(t);
  const noRun = statusJson(project.root);
  assert.equal(noRun.result.status, 4);
  assert.equal(noRun.envelope.ok, false);
  assert.equal(noRun.envelope.error.code, 'NO_ACTIVE_RUN');

  const { result, envelope } = cliJson(['run', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(result.status, 0, result.stderr);

  const fallback = statusJson(project.root);
  assert.equal(fallback.result.status, 0, fallback.result.stderr);
  assert.equal(fallback.envelope.run_id, envelope.run_id);
  const fallbackText = statusText(project.root);
  assert.equal(fallbackText.status, 0, fallbackText.stderr);
  assert.match(fallbackText.stdout, /^run\//m);
});

test('pause blocks delivery and resume returns to the same active step', (t) => {
  const { root, runId, sessionId, envelope: startedEnvelope } = startRun(t);

  const pause = cliJson(['pause', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(pause.result.status, 0, pause.result.stderr);
  assert.equal(pause.envelope.data.status, 'paused');

  let state = readState(root, runId);
  assert.equal(state.status, 'paused');
  assert.equal(state.current_step_id, 'step-a');
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'active');

  const nextWhilePaused = cli(['next', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(nextWhilePaused.status, 4);
  assert.equal(nextWhilePaused.stdout, '');

  const submitWhilePaused = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-a'],
    { cwd: root },
  );
  assert.equal(submitWhilePaused.result.status, 4);
  assert.equal(submitWhilePaused.envelope.error.code, 'NO_ACTIVE_RUN');

  const status = statusText(root, sessionId);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^run\/\S+ paused /m);
  assert.match(status.stdout, /^next\/step-a 第一步$/m);

  const resume = cliJson(['resume', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(resume.result.status, 0, resume.result.stderr);
  assert.equal(resume.envelope.data.status, 'running');
  assert.equal(resume.envelope.data.current_step_id, 'step-a');

  state = readState(root, runId);
  assert.equal(state.status, 'running');
  assert.equal(state.current_step_id, 'step-a');
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'active');

  const next = cli(['next', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout.trim(), startedEnvelope.data.text.trim());

  assert.deepEqual(
    readEvents(root, runId).map(({ kind, event }) => `${kind}:${event}`),
    ['run:started', 'step:started', 'run:paused', 'run:resumed'],
  );
});

test('resume --retry re-activates a failed current step; plain resume rejects it', (t) => {
  const { root, runId, sessionId } = startRun(t);
  const failedAt = new Date().toISOString();
  appendEvents(root, runId, [
    { kind: 'step', event: 'failed', step: { id: 'step-a', name: '第一步' }, time: failedAt },
    { kind: 'run', event: 'paused', time: failedAt },
  ]);
  const state = readState(root, runId);
  state.status = 'paused';
  state.steps.find((step) => step.id === 'step-a').status = 'failed';
  writeFileSync(
    join(root, '.r2c', 'runs', runId, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );

  const plain = cliJson(['resume', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(plain.result.status, 2);
  assert.equal(plain.envelope.error.code, 'STEP_FAILED');
  assert.equal(readState(root, runId).status, 'paused');

  const retry = cliJson(
    ['resume', '--project-root', root, '--session-id', sessionId, '--retry'],
    { cwd: root },
  );
  assert.equal(retry.result.status, 0, retry.result.stderr);
  assert.equal(retry.envelope.data.status, 'running');
  assert.equal(retry.envelope.data.current_step_id, 'step-a');

  const repaired = readState(root, runId);
  assert.equal(repaired.steps.find((step) => step.id === 'step-a').status, 'active');
  assert.equal(repaired.status, 'running');
  assert.deepEqual(
    readEvents(root, runId).map(({ kind, event }) => `${kind}:${event}`),
    ['run:started', 'step:started', 'step:failed', 'run:paused', 'step:started', 'run:resumed'],
  );

  const next = statusText(root, sessionId);
  assert.match(next.stdout, /^next\/step-a 第一步$/m);
  assert.equal(next.stderr, '', 'state must already agree with events');
});

test('cancel is terminal and blocks every later write', (t) => {
  const { root, runId, sessionId } = startRun(t);

  const cancel = cliJson(['cancel', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(cancel.result.status, 0, cancel.result.stderr);
  assert.equal(cancel.envelope.data.status, 'cancelled');

  const state = readState(root, runId);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.current_step_id, null);
  assert.ok(state.completed_at !== null);

  const latest = readJson(join(root, '.r2c', 'latest.json'));
  assert.equal(latest.runs[sessionId].active_run_id, null);
  assert.equal(latest.runs[sessionId].latest_run_id, runId);
  assert.equal(latest.active_run_id, null);

  const submit = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-a'],
    { cwd: root },
  );
  assert.equal(submit.result.status, 4);
  assert.equal(submit.envelope.error.code, 'NO_ACTIVE_RUN');

  const next = cli(['next', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(next.status, 4);
  assert.equal(next.stdout, '');

  const again = cliJson(['cancel', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(again.result.status, 2);
  assert.equal(again.envelope.error.code, 'RUN_TERMINAL');

  const pause = cliJson(['pause', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(pause.result.status, 2);
  assert.equal(pause.envelope.error.code, 'RUN_NOT_RUNNING');

  const status = statusText(root, sessionId);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^run\/\S+ cancelled /m);
  assert.match(status.stdout, /^next\/-$/m);

  assert.deepEqual(
    readEvents(root, runId).filter(({ kind }) => kind === 'run').map(({ event }) => event),
    ['started', 'cancelled'],
  );
});

test('write commands require a session id and never use the latest fallback', (t) => {
  const { root, runId } = startRun(t);
  const before = readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8');

  for (const command of ['pause', 'resume', 'cancel']) {
    const { result, envelope } = cliJson([command, '--project-root', root], { cwd: root });
    assert.equal(result.status, 2, `${command} must exit 2`);
    assert.equal(envelope.error.code, 'MISSING_SESSION');
  }

  assert.equal(readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8'), before);
});

test('token-usage takes the last cumulative snapshot per run/session and never sums', (t) => {
  const { root, runId, sessionId } = startRun(t);
  mkdirSync(join(root, '.r2c', 'usage'), { recursive: true });
  const lines = [
    {
      schema: 'r2c.usage/v1',
      time: '2026-10-28T00:00:01.000Z',
      run_id: runId,
      session_id: sessionId,
      adapter: 'claude-code',
      model: 'demo',
      event: 'stop',
      cumulative: true,
      usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      source: 'transcript',
    },
    {
      schema: 'r2c.usage/v1',
      time: '2026-10-28T00:00:02.000Z',
      run_id: runId,
      session_id: sessionId,
      adapter: 'claude-code',
      model: 'demo',
      event: 'stop',
      cumulative: true,
      usage: { input_tokens: 30, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      source: 'transcript',
    },
    {
      schema: 'r2c.usage/v1',
      time: '2026-10-28T00:00:03.000Z',
      run_id: runId,
      session_id: 'other-session',
      adapter: 'claude-code',
      model: 'demo',
      event: 'stop',
      cumulative: true,
      usage: { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      source: 'transcript',
    },
  ];
  writeFileSync(
    join(root, '.r2c', 'usage', `${runId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );

  const { result, envelope } = cliJson(
    ['token-usage', '--project-root', root, '--session-id', sessionId],
    { cwd: root },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.data.run_id, runId);
  assert.equal(envelope.data.source, 'transcript');
  assert.equal(envelope.data.entries.length, 2);
  assert.equal(envelope.data.total, 132);
  assert.equal(envelope.data.totals.input_tokens, 130);
  assert.equal(envelope.data.totals.output_tokens, 2);
  assert.equal(envelope.data.runs[runId].total, 132);
  assert.equal(envelope.data.runs[runId].sessions.length, 2);

  const sameSession = envelope.data.entries.find((entry) => entry.session_id === sessionId);
  assert.equal(sameSession.usage.input_tokens, 30);
  assert.equal(sameSession.usage.output_tokens, 2);
  assert.equal(sameSession.total, 32);
});

test('token-usage returns zero and source none when the usage file is missing', (t) => {
  const { root, sessionId } = startRun(t);

  const { result, envelope } = cliJson(
    ['token-usage', '--project-root', root, '--session-id', sessionId],
    { cwd: root },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.data.total, 0);
  assert.equal(envelope.data.source, 'none');
  assert.deepEqual(envelope.data.entries, []);
  assert.deepEqual(envelope.data.totals, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  });

  const text = cli(['token-usage', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^run\/\S+ total=0 source=none$/m);

  const empty = tempProject(t);
  const noRun = cliJson(['token-usage', '--project-root', empty.root], { cwd: empty.outside });
  assert.equal(noRun.result.status, 4);
  assert.equal(noRun.envelope.error.code, 'NO_ACTIVE_RUN');
});

test('corrupted state is repaired from events without appending an event', (t) => {
  const { root, runId, sessionId } = startRun(t);
  const statePath = join(root, '.r2c', 'runs', runId, 'state.json');
  const eventsBefore = readFileSync(eventsFile(root, runId), 'utf8');
  const state = readState(root, runId);
  state.status = 'paused';
  state.current_step_id = 'step-b';
  state.steps.find((step) => step.id === 'step-a').status = 'pending';
  state.steps.find((step) => step.id === 'step-b').status = 'active';
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const { result, envelope } = statusJson(root, sessionId);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /repaired from events/);
  assert.equal(envelope.data.run.status, 'running');
  assert.equal(envelope.data.run.current_step_id, 'step-a');
  assert.equal(envelope.data.next.id, 'step-a');
  const text = statusText(root, sessionId);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^next\/step-a 第一步$/m);

  const repaired = readState(root, runId);
  assert.equal(repaired.status, 'running');
  assert.equal(repaired.current_step_id, 'step-a');
  assert.equal(repaired.steps.find((step) => step.id === 'step-a').status, 'active');
  assert.equal(repaired.steps.find((step) => step.id === 'step-b').status, 'pending');
  assert.equal(
    readFileSync(eventsFile(root, runId), 'utf8'),
    eventsBefore,
    'repair is a derived write and must not append events',
  );
});

test('a stale run lock (older than 60s) is taken over', (t) => {
  const { root, runId, sessionId } = startRun(t);
  const lockPath = join(root, '.r2c', 'runs', runId, '.lock');
  writeFileSync(lockPath, 'stale-owner');
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath, old, old);

  const pause = cliJson(['pause', '--project-root', root, '--session-id', sessionId], { cwd: root });
  assert.equal(pause.result.status, 0, pause.result.stderr);
  assert.equal(readState(root, runId).status, 'paused');
  assert.equal(existsSync(lockPath), false);
});

async function waitForFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code) => resolvePromise(code));
  });
}

test('two concurrent writers: one succeeds, the other exits 5 with zero writes', async (t) => {
  const { root, runId, sessionId, outside } = startRun(t);
  const marker = join(outside, 'held.marker');
  const release = join(outside, 'release.marker');
  const holderScript = join(outside, 'holder.mjs');
  const lockUrl = pathToFileURL(join(REPO, 'src', 'lock.js')).href;
  writeFileSync(
    holderScript,
    [
      `import { withRunLock } from ${JSON.stringify(lockUrl)};`,
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const [root, runId, marker, release] = process.argv.slice(2);',
      'withRunLock(root, runId, () => {',
      "  const file = join(root, '.r2c', 'runs', runId, 'state.json');",
      "  const text = readFileSync(file, 'utf8');",
      '  writeFileSync(file, text);',
      "  writeFileSync(marker, 'held');",
      '  // Hold until the test says so; no wall-clock window to race.',
      '  const sleeper = new Int32Array(new SharedArrayBuffer(4));',
      '  while (!existsSync(release)) Atomics.wait(sleeper, 0, 0, 25);',
      '});',
      '',
    ].join('\n'),
  );

  const holder = spawn(process.execPath, [holderScript, root, runId, marker, release], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => holder.kill());

  const stateBefore = readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8');
  const eventsBefore = readFileSync(eventsFile(root, runId), 'utf8');
  await waitForFile(marker);

  const conflict = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-a'],
    { cwd: root },
  );
  assert.equal(conflict.result.status, 5);
  assert.equal(conflict.envelope.ok, false);
  assert.equal(conflict.envelope.error.code, 'LOCK_CONFLICT');
  assert.equal(readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8'), stateBefore);
  assert.equal(readFileSync(eventsFile(root, runId), 'utf8'), eventsBefore);

  writeFileSync(release, 'go');
  assert.equal(await waitForExit(holder), 0);

  const winner = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-a'],
    { cwd: root },
  );
  assert.equal(winner.result.status, 0, winner.result.stderr);
  assert.equal(winner.envelope.step.id, 'step-b');
});
