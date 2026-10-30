import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const PACK = join(REPO, 'pack');
const MANIFEST = join(PACK, 'workflows', 'RTOSv3_R2C_pipiline.yaml');
const SKILLS = join(PACK, 'skills');

const H2 = ['## Agent 角色设定', '## 任务', '## 约束条件'];
const STAGE_NAMES = ['分析设计', '详细设计', '编码实现', '验证检视'];
const PLACEHOLDER_LINE =
  '- 占位技能不得臆测执行：按本文件步骤降级，产物首行写「> 占位：<id> 未实现（<date>）」并填入当天日期，提交时 --note placeholder:<id>';

/** `/<name>` entry forms, but never a slash inside a relative path. */
const SLASH_ENTRY = /(?:^|[\s`'“（(])\/[A-Za-z0-9_.-]+/gm;
const RUNTIME_PATH = /runs\/|latest\.json|state\.json|events\.jsonl|usage\//g;
const AGENT_PRIMITIVE = /AskUserQuestion|\bRead\s*工具|\bGlob\b/g;
const TASK_WHITELIST = /该步骤可用\s+(?:skills|MCP Servers):/g;

function counts(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

function readManifest() {
  return parse(readFileSync(MANIFEST, 'utf8'));
}

function allSteps(manifest) {
  return manifest.stages.flatMap((stage) => stage.steps);
}

function taskFiles(manifest) {
  return allSteps(manifest).map((step) => resolve(PACK, step.taskFile));
}

function skillDirs() {
  return new Set(
    readdirSync(SKILLS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(SKILLS, entry.name, 'SKILL.md')))
      .map((entry) => entry.name),
  );
}

test('the default manifest validates with exit 0', () => {
  const result = spawnSync(process.execPath, [BIN, 'validate', '--manifest', MANIFEST], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `validate failed: ${result.stderr}`);
  assert.match(result.stdout, /^manifest valid: /);
});

test('the default manifest has exactly four stages with one prompt step each', () => {
  const manifest = readManifest();
  assert.equal(manifest.schema, 'r2c.workflow/v1');
  assert.equal(manifest.stages.length, 4);
  assert.deepEqual(
    manifest.stages.map((stage) => stage.name),
    STAGE_NAMES,
  );

  for (const stage of manifest.stages) {
    assert.equal(stage.steps.length, 1, `${stage.name}: exactly one step`);
    for (const step of stage.steps) {
      assert.equal(step.type, 'prompt', `${step.id}: prompt step only`);
      assert.ok(!('shell' in step), `${step.id}: no shell payload`);
    }
  }
  assert.equal(allSteps(manifest).filter((step) => step.type === 'shell').length, 0);
});

test('the default manifest carries no stale path instructions', () => {
  // taskFile is the authoritative body; the old inline prompt told the model to
  // derive <插件根> from a bin/cli.js path that no longer exists.
  const text = readFileSync(MANIFEST, 'utf8');
  assert.doesNotMatch(text, /bin\/cli\.js/);
  assert.doesNotMatch(text, /<插件根>/);
  for (const step of allSteps(readManifest())) {
    assert.ok(!('prompt' in step), `${step.id}: prompt body belongs in taskFile`);
  }
});

test('every manifest skill reference is a real pack/skills directory', () => {
  const dirs = skillDirs();
  for (const step of allSteps(readManifest())) {
    const references = [step.skill, ...(step.skills ?? [])];
    for (const skill of references) {
      assert.ok(dirs.has(skill), `${step.id}: skills/${skill}/SKILL.md is missing`);
    }
    for (const mcp of step.mcp ?? []) {
      assert.equal(typeof mcp, 'string');
      assert.ok(mcp.length > 0, `${step.id}: empty mcp entry`);
    }
  }
});

test('task files contain no slash entry, runtime path, or agent primitive', () => {
  const manifest = readManifest();
  for (const file of taskFiles(manifest)) {
    const text = readFileSync(file, 'utf8');
    const label = file.slice(REPO.length + 1);
    assert.equal(counts(text, SLASH_ENTRY), 0, `${label}: /<name> entry reference`);
    assert.equal(counts(text, RUNTIME_PATH), 0, `${label}: runner runtime path`);
    assert.equal(counts(text, AGENT_PRIMITIVE), 0, `${label}: agent-specific primitive`);
    assert.equal(counts(text, TASK_WHITELIST), 0, `${label}: whitelist must render from the manifest`);
    assert.ok(text.includes(PLACEHOLDER_LINE), `${label}: placeholder fallback constraint`);
    assert.ok(text.split(/\r?\n/).length <= 500, `${label}: must stay under 500 lines`);
  }
});

test('each task keeps exactly the three fixed H2 sections in order', () => {
  for (const file of taskFiles(readManifest())) {
    const headings = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('## '));
    assert.deepEqual(headings, H2, `${file.slice(REPO.length + 1)}: H2 contract`);
  }
});

test('exactly one tracked workflows yaml exists and it is the default manifest', () => {
  const result = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  const tracked = result.stdout
    .split(/\r?\n/)
    .filter((file) => /(^|\/)workflows\/[^/]+\.yaml$/.test(file));
  assert.deepEqual(tracked, ['pack/workflows/RTOSv3_R2C_pipiline.yaml']);
});
