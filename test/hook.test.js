import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const FIXTURE = join(REPO, 'test', 'fixtures', 'two-step');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
  return env;
}

function cli(args, { cwd, env, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env: cleanEnv(env),
    input,
  });
}

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-hook-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-hook-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  cpSync(join(FIXTURE, 'two-step.yaml'), join(root, 'workflows', 'two-step.yaml'));
  cpSync(join(FIXTURE, 'tasks'), join(root, 'tasks'), { recursive: true });
  return { root, outside };
}

function startRun(t, args = []) {
  const project = tempProject(t);
  const result = cli(['run', '--project-root', project.root, ...args], { cwd: project.outside });
  assert.equal(result.status, 0, result.stderr);
  return { ...project, result };
}

function hook(root, args, input) {
  return cli(['hook', ...args, '--project-root', root], {
    cwd: root,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
}

/** Every byte under `.r2c`, keyed by relative path (including mtimes). */
function snapshot(root) {
  const files = {};
  const base = join(root, '.r2c');
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const info = statSync(file);
      if (info.isDirectory()) walk(file);
      else files[relative(base, file)] = readFileSync(file, 'utf8');
    }
  };
  walk(base);
  return files;
}

function denyReason(result) {
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one deny line, got ${JSON.stringify(result.stdout)}`);
  const payload = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(payload).sort(), ['permissionDecision', 'reason']);
  assert.equal(payload.permissionDecision, 'deny');
  assert.equal(typeof payload.reason, 'string');
  assert.notEqual(payload.reason.trim(), '');
  assert.equal(/[\r\n]/.test(payload.reason), false, 'reason must be one line');
  return payload.reason;
}

test('pre-tool-use denies every protected surface and writes nothing', (t) => {
  const project = tempProject(t);
  const before = snapshot(project.root);
  const cases = [
    { tool_name: 'Write', tool_input: { file_path: '.r2c/runs/R20260101T000000Z-abcdef/state.json' } },
    { tool_name: 'Write', tool_input: { path: '.r2c/usage/R20260101T000000Z-abcdef.jsonl' } },
    { tool_name: 'Edit', tool_input: { file_path: join(project.root, '.r2c', 'latest.json') } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'workflows/two-step.yaml' } },
    { tool_name: 'Edit', tool_input: { edits: [{ file_path: '.r2c/latest.json' }] } },
    {
      tool_name: 'apply_patch',
      tool_input: { patch: '*** Begin Patch\n*** Update File: .r2c/runs/R/state.json\n*** End Patch\n' },
    },
    {
      tool_name: 'apply_patch',
      tool_input: '*** Begin Patch\n*** Add File: workflows/other.yaml\n+id: other\n*** End Patch\n',
    },
  ];

  for (const payload of cases) {
    const result = hook(project.root, ['pre-tool-use'], { session_id: 'sid-guard', cwd: project.root, ...payload });
    assert.equal(result.status, 2, `${JSON.stringify(payload)} => ${result.stderr}`);
    assert.equal(result.stderr, '');
    denyReason(result);
    assert.deepEqual(snapshot(project.root), before, 'guard must not write');
  }
});

test('pre-tool-use allows business artefacts and unrelated paths', (t) => {
  const project = tempProject(t);
  const before = snapshot(project.root);
  const cases = [
    { tool_name: 'Write', tool_input: { file_path: '.r2c/ir.md' } },
    { tool_name: 'Write', tool_input: { path: '.r2c/sr-map.md' } },
    { tool_name: 'Write', tool_input: { file_path: '.r2c/artifacts/x' } },
    { tool_name: 'Write', tool_input: { file_path: 'docs/a.md' } },
    { tool_name: 'Edit', tool_input: { edits: [{ file_path: 'src/app.js' }] } },
  ];

  for (const payload of cases) {
    const result = hook(project.root, ['pre-tool-use'], { session_id: 'sid-guard', cwd: project.root, ...payload });
    assert.equal(result.status, 0, `${JSON.stringify(payload)} => ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(project.root), before, 'allowed guard call must not write');
  }
});

test('pre-tool-use never parses Bash command bodies', (t) => {
  const project = tempProject(t);
  const before = snapshot(project.root);
  const cases = [
    { tool_name: 'Bash', tool_input: { command: 'rm -rf .r2c/runs .r2c/latest.json' } },
    { tool_name: 'bash', tool_input: 'rm -rf .r2c/usage && echo "*** Update File: .r2c/latest.json"' },
    { tool_name: 'exec_command', tool_input: { command: 'cat workflows/two-step.yaml' } },
  ];

  for (const payload of cases) {
    const result = hook(project.root, ['pre-tool-use'], { session_id: 'sid-guard', cwd: project.root, ...payload });
    assert.equal(result.status, 0, `${JSON.stringify(payload)} => ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(project.root), before);
  }
});

test('hook stop plain and json match next --format plain byte for byte after trim', (t) => {
  const project = startRun(t, ['--session-id', 'sid-real']);
  const before = snapshot(project.root);

  const next = cli(
    ['next', '--project-root', project.root, '--session-id', 'sid-real', '--format', 'plain'],
    { cwd: project.outside },
  );
  assert.equal(next.status, 0, next.stderr);

  const plain = hook(project.root, ['stop', '--session-id', 'sid-real'], {
    session_id: 'sid-real',
    cwd: project.root,
  });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), next.stdout.trim());
  assert.equal(plain.stderr, '');

  const json = hook(project.root, ['stop', '--session-id', 'sid-real', '--format', 'json'], {
    session_id: 'sid-real',
    cwd: project.root,
  });
  assert.equal(json.status, 0, json.stderr);
  const lines = json.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const block = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(block).sort(), ['decision', 'reason']);
  assert.equal(block.decision, 'block');
  assert.equal(block.reason.trim(), next.stdout.trim());

  const runner = hook(
    project.root,
    ['stop', '--session-id', 'sid-real', '--runner-cmd', 'custom-r2c'],
    { session_id: 'sid-real', cwd: project.root },
  );
  assert.equal(runner.status, 0, runner.stderr);
  assert.match(runner.stdout, /custom-r2c submit --session-id sid-real --step step-a/);

  assert.deepEqual(snapshot(project.root), before, 'stop must be read-only');
});

test('hook stop no-ops with no sid, a cli sid or no routed run', (t) => {
  // An explicit session produces no claimable cli run, so every case below is
  // a pure no-op (claiming is covered by test/claim.test.js).
  const project = startRun(t, ['--session-id', 'sid-explicit']);
  const before = snapshot(project.root);

  const runIds = readdirSync(join(project.root, '.r2c', 'runs')).filter((name) => name.startsWith('R'));
  assert.equal(runIds.length >= 1, true);
  const cliSid = `cli-${runIds[0]}`;

  const cases = [
    { args: ['stop'], input: { cwd: project.root } },
    { args: ['stop', '--session-id', cliSid], input: { cwd: project.root, session_id: cliSid } },
    { args: ['stop', '--session-id', 'sid-never-seen'], input: { cwd: project.root } },
    { args: ['stop'], input: { cwd: project.root, session_id: null, sessionId: 42 } },
  ];

  for (const item of cases) {
    const result = hook(project.root, item.args, item.input);
    assert.equal(result.status, 0, `${JSON.stringify(item.args)} => ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.deepEqual(snapshot(project.root), before, `${JSON.stringify(item.args)} must not write`);
  }
});

test('hook stop stays silent for a paused routed run', (t) => {
  const project = startRun(t, ['--session-id', 'sid-paused']);
  const paused = cli(
    ['pause', '--project-root', project.root, '--session-id', 'sid-paused'],
    { cwd: project.outside },
  );
  assert.equal(paused.status, 0, paused.stderr);
  const before = snapshot(project.root);
  const result = hook(project.root, ['stop', '--session-id', 'sid-paused'], {
    session_id: 'sid-paused',
    cwd: project.root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(snapshot(project.root), before);
});
