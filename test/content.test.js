/**
 * Sample bundle content contract (replaces the retired `pack/` checks).
 *
 * `examples/rtosv3/bundle/` is the only editable form of the first bundle:
 * four stages, four roles, four tasks and thirty-five placeholder skills, with
 * `bundle.json` as the closed index. The task bodies stay runner-agnostic and
 * the skills keep the placeholder banner. The committed zip is a build output
 * (`scripts/build-bundle.mjs --check` proves it), not an input.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(REPO, 'examples', 'rtosv3', 'bundle');
const DIST = join(REPO, 'examples', 'rtosv3', 'dist');

const STAGE_IDS = ['analysis-design', 'detailed-design', 'implementation', 'verification'];
const STAGE_NAMES = ['分析设计', '详细设计', '编码实现', '验证检视'];
const H2 = ['## Agent 角色设定', '## 任务', '## 约束条件', '## 提交'];
const PLACEHOLDER_BANNER = '> **占位（placeholder）** 本技能本期未实现';

const SLASH_ENTRY = /(?:^|[\s`'“（(])\/[A-Za-z0-9_.-]+/gm;
const RUNTIME_PATH = /runs\/|latest\.json|state\.json|events\.jsonl|usage\//g;
const AGENT_PRIMITIVE = /AskUserQuestion|\bRead\s*工具|\bGlob\b/g;
const TASK_WHITELIST = /该步骤可用\s+(?:skills|MCP Servers):/g;

function counts(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(BUNDLE, rel), 'utf8'));
}

const bundle = readJson('bundle.json');

test('bundle.json indexes exactly four stages, roles, tasks and thirty-five skills', () => {
  assert.equal(bundle.schema, 'r2c.bundle/v1');
  assert.equal(bundle.id, 'rtosv3-drvport');
  assert.equal(bundle.version, '1.0.0');
  assert.deepEqual(bundle.stages, STAGE_IDS);
  assert.equal(bundle.roles.length, 4);
  assert.equal(bundle.tasks.length, 4);
  assert.equal(bundle.skills.length, 35);
  assert.equal(new Set(bundle.skills).size, 35);
  assert.deepEqual(bundle.constitution, { path: 'constitution/CONSTITUTION.md', placeholder: true });
});

test('every stage has one prompt step and references only declared entities', () => {
  const roles = new Set(bundle.roles);
  const tasks = new Set(bundle.tasks);
  const skills = new Set(bundle.skills);
  for (const [index, id] of STAGE_IDS.entries()) {
    const stage = readJson(`stages/${id}.json`);
    assert.equal(stage.id, id);
    assert.equal(stage.name, STAGE_NAMES[index]);
    assert.equal(stage.steps.length, 1, `${id}: exactly one step`);
    const [step] = stage.steps;
    assert.equal(step.type, undefined, `${id}: stage steps are prompt steps by shape`);
    assert.ok(roles.has(step.role), `${id}: role ${step.role}`);
    assert.ok(tasks.has(step.task), `${id}: task ${step.task}`);
    for (const skill of step.skills ?? []) assert.ok(skills.has(skill), `${id}: skill ${skill}`);
  }
});

test('task bodies keep the three fixed H2 sections and stay runner-agnostic', () => {
  for (const id of bundle.tasks) {
    const text = readFileSync(join(BUNDLE, 'tasks', `${id}.md`), 'utf8');
    const headings = text.split(/\r?\n/).filter((line) => line.startsWith('## '));
    assert.deepEqual(headings, H2, `${id}: H2 contract`);
    assert.equal(counts(text, SLASH_ENTRY), 0, `${id}: /<name> entry reference`);
    assert.equal(counts(text, RUNTIME_PATH), 0, `${id}: runner runtime path`);
    assert.equal(counts(text, AGENT_PRIMITIVE), 0, `${id}: agent-specific primitive`);
    assert.equal(counts(text, TASK_WHITELIST), 0, `${id}: whitelist must render from the IR`);
    assert.equal(text.split('{{submit}}').length, 2, `${id}: exactly one submit token`);
    assert.ok(text.split(/\r?\n/).length <= 500, `${id}: under 500 lines`);
  }
});

test('every skill is a placeholder directory with frontmatter and the banner', () => {
  const dirs = new Set(
    readdirSync(join(BUNDLE, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(BUNDLE, 'skills', entry.name, 'SKILL.md')))
      .map((entry) => entry.name),
  );
  assert.deepEqual([...dirs].sort(), [...bundle.skills].sort());
  for (const id of bundle.skills) {
    const text = readFileSync(join(BUNDLE, 'skills', id, 'SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: [a-z0-9-]+\ndescription: .+\nplaceholder: true\n---\n/, `${id}: frontmatter`);
    assert.ok(text.includes(PLACEHOLDER_BANNER), `${id}: placeholder banner`);
  }
});

test('the constitution is the zero-byte placeholder declared by bundle.json', () => {
  const file = join(BUNDLE, ...bundle.constitution.path.split('/'));
  assert.equal(readFileSync(file).length, 0);
});

test('exactly one committed deterministic zip exists for the sample bundle', () => {
  const zips = readdirSync(DIST).filter((name) => /^bundle-.+-v.+\.zip$/.test(name));
  assert.deepEqual(zips, ['bundle-rtosv3-drvport-v1.0.0.zip']);
});
