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
const BIN = join(REPO, 'bin', 'r2c.js');

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-manifest-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-manifest-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
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

function writeManifest(root, name, yaml) {
  const file = join(root, 'workflows', name);
  writeFileSync(file, yaml);
  return file;
}

function writeTask(root, name, text) {
  const file = join(root, 'tasks', name);
  writeFileSync(file, text);
  return file;
}

const BROKEN = `schema: r2c.workflow/v1
id: broken
name: broken
unexpected: true
stages:
  - id: stage-one
    name: 阶段一
    steps:
      - id: step-a
        name: 缺少任务文件
        type: prompt
        taskFile: tasks/missing.md
      - id: step-a
        name: 重复步骤
        type: prompt
        prompt: 重复的步骤 id
        expect:
          outputs:
            - 'skills/**'
            - '[unclosed'
      - id: step-c
        name: 空门禁
        type: prompt
        prompt: 内联提示
        gate:
          - command: ''
`;

const VALID_TWO_STEP = `schema: r2c.workflow/v1
id: workflow-manifest-test
name: manifest-test
version: 0.1.0
description: 清单校验用
stages:
  - id: stage-one
    name: 阶段一
    steps:
      - id: step-a
        name: 第一步
        type: prompt
        agent: architect
        skill: missing-skill
        taskFile: tasks/a.md
        skills:
          - alpha
          - beta
        mcp:
          - mcp-demo
  - id: stage-two
    name: 阶段二
    steps:
      - id: step-b
        name: 第二步
        type: shell
        shell: node -e "process.exit(0)"
        timeout: 30
`;

test('validate reports five-plus distinct error classes in one pass', (t) => {
  const project = tempProject(t);
  writeManifest(project.root, 'broken.yaml', BROKEN);

  const { result, envelope } = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });

  assert.equal(result.status, 2);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.command, 'validate');
  assert.equal(envelope.code, 2);
  assert.equal(envelope.error.code, 'MANIFEST_INVALID');
  const errors = envelope.data.errors;
  assert.ok(Array.isArray(errors));
  assert.equal(envelope.error.details.errors.length, errors.length);
  assert.ok(errors.length >= 5, JSON.stringify(errors));

  for (const error of errors) {
    assert.equal(typeof error.path, 'string');
    assert.notEqual(error.path, '');
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
  }

  const codes = new Set(errors.map((error) => error.code));
  for (const code of [
    'UNKNOWN_KEY',
    'TASKFILE_MISSING',
    'DUPLICATE_STEP_ID',
    'OUTPUT_FORBIDDEN',
    'GLOB_INVALID',
    'GATE_COMMAND_EMPTY',
  ]) {
    assert.ok(codes.has(code), `missing ${code} in ${[...codes].join(', ')}`);
  }

  const paths = errors.map((error) => error.path);
  for (const path of [
    'unexpected',
    'stages[0].steps[0].taskFile',
    'stages[0].steps[1].id',
    'stages[0].steps[1].expect.outputs[0]',
    'stages[0].steps[1].expect.outputs[1]',
    'stages[0].steps[2].gate[0].command',
  ]) {
    assert.ok(paths.includes(path), `missing path ${path} in ${paths.join(', ')}`);
  }

  const text = cli(['validate', '--project-root', project.root], { cwd: project.outside });
  assert.equal(text.status, 2);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /^error: unexpected: unknown key: unexpected \[UNKNOWN_KEY\]$/m);
  assert.match(text.stderr, /^error: stages\[0\]\.steps\[0\]\.taskFile: /m);
  assert.match(text.stderr, /^r2c: manifest invalid: /m);
});

test('two discovered manifests make run exit 2 and list candidates', (t) => {
  const project = tempProject(t);
  writeTask(project.root, 'a.md', '# A\n');
  writeManifest(project.root, 'a.yaml', VALID_TWO_STEP);
  writeManifest(
    project.root,
    'b.yaml',
    VALID_TWO_STEP.replace('workflow-manifest-test', 'workflow-manifest-test-b'),
  );

  const { result, envelope } = cliJson(['run', '--project-root', project.root], {
    cwd: project.outside,
  });

  assert.equal(result.status, 2);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'MANIFEST_AMBIGUOUS');
  assert.deepEqual(envelope.error.details.candidates, ['a.yaml', 'b.yaml']);
  assert.match(envelope.error.message, /a\.yaml/);
  assert.match(envelope.error.message, /b\.yaml/);
  assert.equal(existsSync(join(project.root, '.r2c')), false);
});

test('missing taskFile is rejected by validate and by run before writes', (t) => {
  const project = tempProject(t);
  writeManifest(
    project.root,
    'one.yaml',
    VALID_TWO_STEP.replace('taskFile: tasks/a.md', 'taskFile: tasks/absent.md'),
  );

  const validated = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(validated.result.status, 2);
  const taskError = validated.envelope.data.errors.find(
    (error) => error.code === 'TASKFILE_MISSING',
  );
  assert.ok(taskError, JSON.stringify(validated.envelope.data.errors));
  assert.equal(taskError.path, 'stages[0].steps[0].taskFile');

  const run = cliJson(['run', '--project-root', project.root], { cwd: project.outside });
  assert.equal(run.result.status, 2);
  assert.equal(run.envelope.error.code, 'MANIFEST_INVALID');
  assert.ok(
    run.envelope.data.errors.some((error) => error.code === 'TASKFILE_MISSING'),
    JSON.stringify(run.envelope.data),
  );
  assert.equal(existsSync(join(project.root, '.r2c')), false);
});

test('missing skill warns but validates and still starts a run', (t) => {
  const project = tempProject(t);
  writeTask(project.root, 'a.md', '# 任务 A\n\n执行第一步。\n');
  writeManifest(project.root, 'one.yaml', VALID_TWO_STEP);

  const text = cli(['validate', '--project-root', project.root], { cwd: project.outside });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^manifest valid: /);
  assert.match(text.stderr, /^warning: stages\[0\]\.steps\[0\]\.skill: skill not found: missing-skill/m);

  const validated = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(validated.result.status, 0);
  assert.deepEqual(validated.envelope.data.errors, []);
  assert.equal(validated.envelope.data.warnings.length, 1);
  assert.equal(validated.envelope.data.warnings[0].code, 'SKILL_MISSING');

  const run = cliJson(['run', '--project-root', project.root], { cwd: project.outside });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.envelope.data.warnings.length, 1);
  assert.equal(run.envelope.data.warnings[0].code, 'SKILL_MISSING');
  assert.equal(run.envelope.step.id, 'step-a');
});

test('expect.outputs targeting skills/** or SKILL.md is rejected', (t) => {
  const project = tempProject(t);
  writeManifest(
    project.root,
    'one.yaml',
    `schema: r2c.workflow/v1
id: outputs
name: outputs
stages:
  - id: stage-one
    name: 阶段一
    steps:
      - id: step-a
        name: 一步
        type: prompt
        prompt: 内联
        expect:
          outputs:
            - 'skills/**'
            - '**/SKILL.md'
`,
  );

  const { result, envelope } = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });

  assert.equal(result.status, 2);
  const forbidden = envelope.data.errors.filter((error) => error.code === 'OUTPUT_FORBIDDEN');
  assert.equal(forbidden.length, 2, JSON.stringify(envelope.data.errors));
  assert.deepEqual(
    forbidden.map((error) => error.path),
    ['stages[0].steps[0].expect.outputs[0]', 'stages[0].steps[0].expect.outputs[1]'],
  );
});

test('empty stages and empty step lists are reported', (t) => {
  const project = tempProject(t);
  writeManifest(
    project.root,
    'empty-stages.yaml',
    `schema: r2c.workflow/v1
id: empty
name: empty
stages: []
`,
  );
  const emptyStages = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(emptyStages.result.status, 2);
  assert.equal(emptyStages.envelope.data.errors[0].code, 'EMPTY');
  assert.equal(emptyStages.envelope.data.errors[0].path, 'stages');

  writeManifest(
    project.root,
    'empty-steps.yaml',
    `schema: r2c.workflow/v1
id: empty-steps
name: empty-steps
stages:
  - id: stage-one
    name: 阶段一
    steps: []
`,
  );
  rmSync(join(project.root, 'workflows', 'empty-stages.yaml'));
  const emptySteps = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(emptySteps.result.status, 2);
  assert.equal(emptySteps.envelope.data.errors[0].code, 'EMPTY');
  assert.equal(emptySteps.envelope.data.errors[0].path, 'stages[0].steps');
});

test('prompt and shell payloads are mutually exclusive and shell needs timeout', (t) => {
  const project = tempProject(t);
  writeManifest(
    project.root,
    'payloads.yaml',
    `schema: r2c.workflow/v1
id: payloads
name: payloads
stages:
  - id: stage-one
    name: 阶段一
    steps:
      - id: prompt-with-shell
        name: 冲突一
        type: prompt
        prompt: 文本
        shell: echo hi
      - id: shell-with-prompt
        name: 冲突二
        type: shell
        shell: echo hi
        prompt: 文本
      - id: shell-without-timeout
        name: 缺超时
        type: shell
        shell: echo hi
      - id: prompt-without-source
        name: 缺载荷
        type: prompt
`,
  );

  const { result, envelope } = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(result.status, 2);
  const codes = new Set(envelope.data.errors.map((error) => error.code));
  assert.ok(codes.has('PAYLOAD_CONFLICT'));
  assert.ok(codes.has('TIMEOUT_REQUIRED'));
  assert.ok(codes.has('PROMPT_SOURCE_MISSING'));
  const conflicts = envelope.data.errors.filter((error) => error.code === 'PAYLOAD_CONFLICT');
  assert.equal(conflicts.length, 2, JSON.stringify(envelope.data.errors));
});

test('--manifest derives the manifest root from the manifest path', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'r2c-manifest-root-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'r2c-manifest-state-'));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  mkdirSync(join(base, 'pack', 'workflows'), { recursive: true });
  mkdirSync(join(base, 'pack', 'tasks'), { recursive: true });
  writeFileSync(join(base, 'pack', 'tasks', 't.md'), '# 显式清单任务\n\n根目录推导检查。\n');
  const manifest = join(base, 'pack', 'workflows', 'explicit.yaml');
  writeFileSync(
    manifest,
    `schema: r2c.workflow/v1
id: explicit-root
name: explicit-root
stages:
  - id: stage-one
    name: 阶段一
    steps:
      - id: step-a
        name: 一步
        type: prompt
        taskFile: tasks/t.md
`,
  );

  const validated = cliJson(
    ['validate', '--project-root', projectRoot, '--manifest', manifest],
    { cwd: base },
  );
  assert.equal(validated.result.status, 0, validated.result.stderr);
  assert.equal(validated.envelope.data.manifest, manifest);
  assert.equal(validated.envelope.data.root, join(base, 'pack'));

  const run = cliJson(
    ['run', '--project-root', projectRoot, '--manifest', manifest],
    { cwd: base },
  );
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.match(run.envelope.data.text, /根目录推导检查。/);
  assert.equal(existsSync(join(projectRoot, '.r2c', 'latest.json')), true);
  assert.equal(existsSync(join(base, 'pack', '.r2c')), false);
});

test('default discovery rooted at --project-root resolves task files there', (t) => {
  const project = tempProject(t);
  writeTwoStepProject(project.root);

  const validated = cliJson(['validate', '--project-root', project.root], {
    cwd: project.outside,
  });
  assert.equal(validated.result.status, 0, validated.result.stderr);
  assert.equal(validated.envelope.data.root, project.root);
  assert.equal(validated.envelope.data.stages, 2);
  assert.equal(validated.envelope.data.steps, 2);
});

test('run renders task content and skill/MCP whitelists without dispatching', (t) => {
  const project = tempProject(t);
  writeTask(project.root, 'a.md', '# 任务 A\n\n执行第一步，产出可以提交的结果。\n');
  writeManifest(project.root, 'one.yaml', VALID_TWO_STEP);

  const run = cliJson(['run', '--project-root', project.root], { cwd: project.outside });
  assert.equal(run.result.status, 0, run.result.stderr);
  const text = run.envelope.data.text;
  assert.match(text, /执行第一步，产出可以提交的结果。/);
  assert.match(text, /^角色：architect$/m);
  assert.match(text, /^主技能：missing-skill$/m);
  assert.match(text, /^技能白名单：alpha、beta$/m);
  assert.match(text, /^MCP 白名单：mcp-demo$/m);
  assert.doesNotMatch(text, /子代理：/);
  assert.deepEqual(run.envelope.data.warnings.map((warning) => warning.code), ['SKILL_MISSING']);
});
