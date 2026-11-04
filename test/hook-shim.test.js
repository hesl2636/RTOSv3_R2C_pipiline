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
import { writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'runtime', 'runner', 'engine', 'bin', 'hm2b.js');
const SHIM = join(REPO, 'runtime', 'runner', 'assets', 'shims', 'hook.mjs');
const RUNNER_CMD = `node "${BIN}"`;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `hm2b-shim-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of ['HM2B_SESSION_ID', 'HM2B_PROJECT_ROOT', 'HM2B_HOME']) delete env[key];
  return env;
}

function cli(args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env: cleanEnv(),
    input,
  });
}

function envelope(result) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`not a JSON envelope: ${JSON.stringify(result.stdout)} / ${result.stderr}`);
  }
}

/** A project with the two-step fixture and one running step-a. */
function startedRun(t) {
  const root = tempDir(t, 'project');
  const outside = tempDir(t, 'outside');
  writeTwoStepProject(root);
  const run = cli(['run', '--project-root', root, '--json'], { cwd: outside });
  assert.equal(run.status, 0, run.stderr);
  const json = envelope(run);
  return { root, outside, runId: json.run_id };
}

function runShim(project, { event = 'stop', sessionId = null, input = {}, dialect = null } = {}) {
  const args = [
    SHIM,
    '--agent',
    'claude-code',
    '--event',
    event,
    '--format',
    'json',
    '--runner-cmd',
    RUNNER_CMD,
    '--project-root',
    project,
  ];
  if (sessionId !== null) args.push('--session-id', sessionId);
  if (dialect !== null) args.push('--dialect', dialect);
  return spawnSync(process.execPath, args, {
    cwd: project,
    encoding: 'utf8',
    input: JSON.stringify(input),
    timeout: 60_000,
  });
}

function trace(root, agent = 'claude-code') {
  const file = join(root, '.hm2b', 'runs', '.hooks', 'trace', `${agent}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

test('nine stops on one step block eight times, then cap with a manual hint', (t) => {
  const { root } = startedRun(t);
  const sid = 'sid-cap-28';
  const payload = { session_id: sid, cwd: root };
  const blocks = [];

  for (let index = 0; index < 8; index += 1) {
    const result = runShim(root, { sessionId: sid, input: payload });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1, `stop ${index + 1} must deliver one block: ${result.stdout}`);
    const block = JSON.parse(lines[0]);
    assert.equal(block.decision, 'block');
    assert.match(block.reason, /step-a/);
    blocks.push(block);
  }

  const ninth = runShim(root, { sessionId: sid, input: payload });
  assert.equal(ninth.status, 0, ninth.stderr);
  assert.equal(ninth.stdout.trim(), '');
  assert.match(ninth.stderr, /hm2b next/);

  const entries = trace(root).filter((entry) => entry.hook === 'stop');
  assert.equal(entries.length, 9);
  assert.equal(entries.filter((entry) => entry.delivered === true).length, 8);
  assert.equal(entries.filter((entry) => entry.capped === true).length, 1);
  assert.equal(entries.at(-1).reason, undefined);
  assert.equal(entries.at(-1).delivered, false);

  const guard = JSON.parse(readFileSync(join(root, '.hm2b', 'runs', '.hooks', 'stop-guard.json'), 'utf8'));
  assert.deepEqual(Object.values(guard), [8]);
});

test('stop_hook_active passes without blocking or counting', (t) => {
  const { root } = startedRun(t);
  const sid = 'sid-active-28';
  const result = runShim(root, {
    sessionId: sid,
    input: { session_id: sid, cwd: root, stop_hook_active: true },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(join(root, '.hm2b', 'runs', '.hooks', 'stop-guard.json')));

  const entries = trace(root).filter((entry) => entry.hook === 'stop');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'stop-hook-active');
  assert.equal(entries[0].delivered, false);
});

test('dsh dialect translates a deny into hookSpecificOutput and exit 0', (t) => {
  const { root } = startedRun(t);
  const sid = 'sid-dsh-28';
  const result = runShim(root, {
    event: 'pre-tool-use',
    sessionId: sid,
    dialect: 'dsh',
    input: {
      session_id: sid,
      cwd: root,
      tool_name: 'Write',
      tool_input: { file_path: '.hm2b/latest.json' },
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /protected runner state/);
});

test('a delivered stop appends a cumulative transcript usage snapshot', (t) => {
  const { root, runId } = startedRun(t);
  const sid = 'sid-usage-28';
  const transcript = join(tempDir(t, 'transcript'), 'session.jsonl');
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-test', usage: { input_tokens: 1 } } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-test',
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      }),
    ].join('\n') + '\n',
  );

  const result = runShim(root, {
    sessionId: sid,
    input: { session_id: sid, cwd: root, transcript_path: transcript },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).decision, 'block');

  const usageFile = join(root, '.hm2b', 'usage', `${runId}.jsonl`);
  assert.ok(existsSync(usageFile), usageFile);
  const snapshots = readFileSync(usageFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.schema, 'hm2b.usage/v1');
  assert.equal(snapshot.run_id, runId);
  assert.equal(snapshot.session_id, sid);
  assert.equal(snapshot.target, 'claude-code');
  assert.equal(snapshot.model, 'claude-test');
  assert.equal(snapshot.cumulative, true);
  assert.deepEqual(snapshot.usage, {
    input_tokens: 11,
    output_tokens: 7,
    cache_read_tokens: 3,
    cache_creation_tokens: 2,
  });
  assert.equal(snapshot.source, 'transcript');
});

test('a stop without a session exits 0 silently and records no delivery', (t) => {
  const root = tempDir(t, 'empty');
  const result = runShim(root, { input: {} });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(join(root, '.hm2b', 'runs', '.hooks', 'stop-guard.json')));
  const entries = trace(root).filter((entry) => entry.hook === 'stop');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session_id, null);
  assert.equal(entries[0].delivered, false);
  assert.equal(entries[0].reason, 'no-session');
});

test('runner argv stays literal: shell metacharacters and spaced paths never execute', (t) => {
  const base = tempDir(t, 'literal');
  const root = join(base, 'project with spaces');
  const runnerDir = join(base, 'runner dir');
  mkdirSync(root, { recursive: true });
  mkdirSync(runnerDir, { recursive: true });
  const recorder = join(runnerDir, 'record runner.mjs');
  const argvFile = join(base, 'argv.jsonl');
  writeFileSync(
    recorder,
    [
      "import { appendFileSync } from 'node:fs';",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => {",
      "  appendFileSync(process.env.HM2B_ARGV_OUT, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\\n`);",
      '});',
      '',
    ].join('\n'),
  );
  const sid = 'sid $(touch PWNED) `touch PWNED2` & echo "x y"';
  const result = spawnSync(
    process.execPath,
    [
      SHIM,
      '--agent', 'claude-code',
      '--event', 'pre-tool-use',
      '--format', 'json',
      '--runner-cmd', `node "${recorder}"`,
      '--project-root', root,
      '--session-id', sid,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...cleanEnv(), HM2B_ARGV_OUT: argvFile },
      input: JSON.stringify({ session_id: sid, cwd: root }),
      timeout: 60_000,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const records = readFileSync(argvFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].argv, [
    'hook', 'pre-tool-use', '--project-root', root, '--session-id', sid,
  ]);
  assert.equal(records[0].cwd, root);
  for (const name of ['PWNED', 'PWNED2']) {
    assert.equal(existsSync(join(root, name)), false, `${name} must never be created`);
    assert.equal(existsSync(join(base, name)), false, `${name} must never be created`);
  }
});
