/**
 * Engine rendering contract (#85): a task body that already carries a
 * `## 提交` section must not get a second, engine-generated submit block; and
 * `constitution/CONSTITUTION.md`, when installed, is injected verbatim between
 * the meta lines and the task body on every delivery surface.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TWO_STEP_YAML, writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'runtime', 'r2c', 'engine', 'bin', 'r2c.js');
const RUNNER = 'node .r2c/bin/r2c.js';
const SESSION = 'sid-render';

const CONSTITUTION = [
  '<!-- constitution:begin scope=global placeholder=false -->',
  '> **项目宪法（constitution）** — 项目级规则，先于本步任务书生效；与任务书冲突时以本段为准。',
  '',
  '项目规则：禁止提交未验证的产物。',
  '',
  '<!-- constitution:end -->',
  '',
].join('\n');

const TASK_WITH_SUBMIT = [
  '# 任务 A',
  '',
  '执行第一步，产出可以提交的结果。',
  '',
  '## 提交',
  '',
  '```',
  'node .r2c/bin/r2c.js submit --step step-a',
  '```',
  '',
].join('\n');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
  return env;
}

function cli(args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env: cleanEnv(),
    input: input === undefined ? undefined : JSON.stringify(input),
  });
}

function tempProject(t, { constitution = null, task = null, yaml = TWO_STEP_YAML } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-render-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-render-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeTwoStepProject(root, { yaml });
  if (task !== null) writeFileSync(join(root, 'tasks', 'a.md'), task);
  if (constitution !== null) {
    mkdirSync(join(root, 'constitution'), { recursive: true });
    writeFileSync(join(root, 'constitution', 'CONSTITUTION.md'), constitution);
  }
  return { root, outside };
}

function runStep(root, outside, extra = []) {
  return cli(
    ['run', '--project-root', root, '--session-id', SESSION, '--runner-cmd', RUNNER, ...extra],
    { cwd: outside },
  );
}

function submitInstructionCount(text) {
  return (text.match(/submit --/g) ?? []).length;
}

function blockOf(text) {
  const start = text.indexOf('<!-- constitution:begin');
  const end = text.indexOf('<!-- constitution:end -->');
  assert.ok(start !== -1 && end !== -1, `constitution block missing:\n${text}`);
  return text.slice(start, end + '<!-- constitution:end -->'.length);
}

test('a task that already has a `## 提交` section gets no second submit block', (t) => {
  const { root, outside } = tempProject(t, { task: TASK_WITH_SUBMIT });
  const result = runStep(root, outside);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^## 提交$/m);
  assert.match(result.stdout, /node \.r2c\/bin\/r2c\.js submit --step step-a/);
  assert.doesNotMatch(result.stdout, /提交命令（完成后执行；不要手改 \.r2c）：/);
  assert.equal(submitInstructionCount(result.stdout), 1);
});

test('an inline prompt that already has a `## 提交` section gets no second submit block', (t) => {
  const yaml = TWO_STEP_YAML.replace(
    '          执行第二步（内联提示）。\n',
    [
      '          执行第二步（内联提示）。',
      '',
      '          ## 提交',
      '',
      '          ```',
      '          node .r2c/bin/r2c.js submit --step step-b',
      '          ```',
      '',
    ].join('\n'),
  );
  const { root, outside } = tempProject(t, { yaml });
  const started = runStep(root, outside);
  assert.equal(started.status, 0, started.stderr);

  const submitted = cli(
    ['submit', '--project-root', root, '--session-id', SESSION, '--step', 'step-a'],
    { cwd: outside },
  );
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(submitted.stdout, /node \.r2c\/bin\/r2c\.js submit --step step-b/);
  assert.doesNotMatch(submitted.stdout, /提交命令（完成后执行；不要手改 \.r2c）：/);
  assert.equal(submitInstructionCount(submitted.stdout), 1);
});

test('without a `## 提交` section or a constitution the rendered bytes are unchanged', (t) => {
  const { root, outside } = tempProject(t);
  const result = runStep(root, outside);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    [
      '## 下一步：第一步（阶段：阶段一）',
      '',
      '角色：tester',
      '技能白名单：alpha、beta',
      'MCP 白名单：mcp-demo',
      '',
      '# 任务 A',
      '',
      '执行第一步，产出可以提交的结果。',
      '',
      '提交命令（完成后执行；不要手改 .r2c）：',
      `${RUNNER} submit --session-id ${SESSION} --step step-a`,
      '',
    ].join('\n'),
  );
});

test('the constitution block sits after meta, before the task body, exactly once', (t) => {
  const { root, outside } = tempProject(t, { constitution: CONSTITUTION });
  const result = runStep(root, outside);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');

  const metaAt = result.stdout.indexOf('MCP 白名单：mcp-demo');
  const blockAt = result.stdout.indexOf('<!-- constitution:begin');
  const bodyAt = result.stdout.indexOf('# 任务 A');
  assert.ok(metaAt !== -1 && blockAt !== -1 && bodyAt !== -1);
  assert.ok(metaAt < blockAt && blockAt < bodyAt, result.stdout);
  assert.equal((result.stdout.match(/<!-- constitution:begin/g) ?? []).length, 1);
  assert.equal(blockOf(result.stdout), CONSTITUTION.trimEnd());
});

test('run, submit, next and hook deliver the identical constitution block', (t) => {
  const { root, outside } = tempProject(t, { constitution: CONSTITUTION });

  const started = runStep(root, outside);
  assert.equal(started.status, 0, started.stderr);
  const runBlock = blockOf(started.stdout);

  const next = cli(
    ['next', '--project-root', root, '--session-id', SESSION, '--format', 'plain',
      '--runner-cmd', RUNNER],
    { cwd: outside },
  );
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout, started.stdout);
  assert.equal(blockOf(next.stdout), runBlock);

  const hooked = cli(
    ['hook', 'stop', '--project-root', root, '--session-id', SESSION, '--runner-cmd', RUNNER],
    { cwd: root, input: { session_id: SESSION, cwd: root } },
  );
  assert.equal(hooked.status, 0, hooked.stderr);
  assert.equal(hooked.stdout, started.stdout);
  assert.equal(blockOf(hooked.stdout), runBlock);

  const submitted = cli(
    [
      'submit', '--project-root', root, '--session-id', SESSION, '--step', 'step-a',
      '--runner-cmd', RUNNER,
    ],
    { cwd: outside },
  );
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(blockOf(submitted.stdout), runBlock);
  assert.equal((submitted.stdout.match(/<!-- constitution:begin/g) ?? []).length, 1);

  // Step-b has no meta lines, so the block still leads the body directly.
  assert.equal(
    submitted.stdout,
    [
      '## 下一步：第二步（阶段：阶段二）',
      '',
      CONSTITUTION.trimEnd(),
      '',
      '执行第二步（内联提示）。',
      '',
      '提交命令（完成后执行；不要手改 .r2c）：',
      `${RUNNER} submit --session-id ${SESSION} --step step-b`,
      '',
    ].join('\n'),
  );
});

test('an absent constitution injects nothing and adds no warning', (t) => {
  const { root, outside } = tempProject(t, { task: TASK_WITH_SUBMIT });
  const result = runStep(root, outside);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /constitution:begin/);
});

test('a task with its own submit section still precedes the injected constitution rule', (t) => {
  const { root, outside } = tempProject(t, { constitution: CONSTITUTION, task: TASK_WITH_SUBMIT });
  const result = runStep(root, outside);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.indexOf('<!-- constitution:begin') < result.stdout.indexOf('# 任务 A'));
  assert.equal(result.stdout.indexOf('<!-- constitution:end -->') < result.stdout.indexOf('## 提交'), true);
});
