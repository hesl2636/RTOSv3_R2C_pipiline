/**
 * agent-native target: Codex (#96).
 *
 * Codex reads one TOML file per role from `.codex/agents/` and shares the
 * `.agents/skills` tree with the other non-Claude runtimes. The capability
 * gaps (tool allow-list, skill preload, model tiers) must surface as
 * field-level records rather than disappearing behind a plausible-looking
 * file.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileBundle } from '../assembler/compile.js';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { normalizeOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { validateResult } from '../projection/validate-result.js';
import { AGENT_NATIVE_MANIFEST } from '../runtime/agent-native/projection/manifest.js';
import { targetOrder } from '../runtime/agent-native/projection/targets/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const MANIFEST = AGENT_NATIVE_MANIFEST;
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const CAPABILITIES = [
  'state', 'gates', 'outputs', 'subagents', 'skills', 'preload',
  'stage-invocation', 'skill-invocation',
];

let sample;
function sampleIr() {
  if (sample !== undefined) return sample;
  const compiled = compileBundle(new Uint8Array(readFileSync(ZIP)), { inflateRaw, sha256: sha256Hex });
  assert.equal(compiled.ok, true);
  sample = { ir: JSON.parse(new TextDecoder().decode(compiled.irBytes)), irDigest: compiled.digest };
  return sample;
}

function runProject({ ir, irDigest, raw }) {
  const normalized = normalizeOptions({
    projectionId: 'agent-native',
    ir,
    irDigest,
    raw,
    manifest: MANIFEST,
  });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  return project({
    projectionId: 'agent-native',
    ir,
    irDigest,
    options: normalized.options,
    environment: {},
    assets: {},
  });
}

function codexSample() {
  const { ir, irDigest } = sampleIr();
  return { ir, irDigest, result: runProject({ ir, irDigest, raw: { targets: ['codex'] } }) };
}

function claudeSample() {
  const { ir, irDigest } = sampleIr();
  return runProject({ ir, irDigest, raw: { targets: ['claude-code'] } });
}

function source(path, fill) {
  return { path, sha256: fill.repeat(64) };
}

function role(id, extra = {}) {
  return {
    description: `Runs ${id}.`,
    mode: 'subagent',
    placeholder: false,
    instructions: `\nDo the ${id} work.\n`,
    source: source(`roles/${id}.md`, 'd'),
    ...extra,
  };
}

function miniIr({ roles, skills = {} } = {}) {
  return {
    schema: 'hm2b.ir/v2',
    id: 'mini',
    name: 'Mini workflow',
    version: '1.0.0',
    description: 'A miniature workflow used by projection tests.',
    source: {
      bundle: { schema: 'hm2b.bundle/v1', id: 'mini', version: '1.0.0', contentSha256: 'b'.repeat(64) },
      manifest: { path: 'bundle.json', sha256: 'c'.repeat(64) },
    },
    stages: [{
      id: 'one',
      name: 'One',
      steps: [{
        id: 'one',
        name: 'Step one',
        role: 'worker',
        task: 'one-task',
        skills: Object.keys(skills),
        outputs: [],
        gates: [],
      }],
    }],
    roles: roles ?? { worker: role('worker') },
    tasks: {
      'one-task': {
        body: [
          '## Agent 角色设定', '', '你是执行者。', '',
          '## 任务', '', '执行一步。', '',
          '## 约束条件', '', '- 只做一步', '',
          '## 提交', '', '```', '{{submit}}', '```', '',
        ].join('\n'),
        source: source('tasks/one-task.md', 'e'),
      },
    },
    skills,
    constitution: [],
  };
}

function helperSkill() {
  return {
    helper: {
      description: 'Helps.',
      placeholder: false,
      body: '\n# Helper\n',
      source: source('skills/helper/SKILL.md', 'f'),
    },
  };
}

function recordsOf(result) {
  return result.degradations.map((record) => [
    record.code,
    record.capability,
    record.level,
    record.pointer,
    record.field ?? '',
  ].join('|'));
}

// --- frozen baseline ------------------------------------------------------

test('codex-only baseline: 45 files, 8 capability rows, 9 degradations, V1–V12 pass', () => {
  const { ir, irDigest, result } = codexSample();
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['codex']);
  assert.deepEqual(result.options.targets, ['codex']);
  assert.equal(result.files.length, 45);
  assert.equal(result.capabilityReport.length, 8);
  assert.equal(result.degradations.length, 9);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.metadata.placeholders.constitution, 'placeholder');

  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('the closed file set is 40 shared SKILL.md files + 4 role TOMLs + roles.json', () => {
  const { result } = codexSample();
  const paths = result.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.filter((path) => path.startsWith('.agents/skills/')).length, 40);
  assert.equal(paths.filter((path) => path.endsWith('/SKILL.md')).length, 40);
  assert.equal(paths.filter((path) => path.startsWith('.codex/agents/')).length, 4);
  assert.equal(paths.filter((path) => path.endsWith('.toml')).length, 4);
  assert.deepEqual(paths.filter((path) => !path.startsWith('.agents/skills/') && !path.startsWith('.codex/agents/')), [
    '.agents/agent-native/rtosv3-drvport/roles.json',
  ]);
  assert.equal(paths.some((path) => path.startsWith('.claude/')), false);
  for (const path of paths) {
    assert.match(path, /^\.(?:agents|codex)\//);
    assert.doesNotMatch(path, /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|RULES\.md|opencode\.json|commands)(?:\/|$)/);
  }
  const kinds = new Map();
  for (const file of result.files) kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(kinds), { metadata: 1, agent: 4, skill: 35, stage: 4, workflow: 1 });
  assert.equal(result.installPlan.steps.length, result.files.length);
  assert.deepEqual(result.installPlan.steps.map((step) => step.path), paths);
  for (const file of result.files.filter((item) => item.kind !== 'metadata')) {
    assert.deepEqual(file.targets, ['codex']);
  }
  assert.deepEqual(result.files.find((file) => file.kind === 'metadata').targets, ['codex']);
});

test('role TOMLs match the prototype oracle byte for byte', () => {
  const { result } = codexSample();
  const byPath = new Map(result.files.map((file) => [file.path, file.content]));
  const hashes = {
    '.codex/agents/rtosv3-drvport-bys-architect.toml': '8c9da9ed40dda49dacf2072f5eebaa78bf16999de1dcaad60d5283a204f0f3bd',
    '.codex/agents/rtosv3-drvport-bys-designer.toml': '2747f7cedf0eaf3d1cf11e6b1f9e4468f6c7fffd411c529e6b8f2fcf863bf1ba',
    '.codex/agents/rtosv3-drvport-bys-impl-lead.toml': '8e9249c147be284b841201c5416dd8d6209d980afe7ad3b8600d1188e31535fe',
    '.codex/agents/rtosv3-drvport-bys-release-lead.toml': 'b0365bca01634865717de621348b79e6f4b4a50fc25571ef0e1c3fdaff2ae445',
  };
  for (const [path, hash] of Object.entries(hashes)) {
    assert.equal(sha256(byPath.get(path)), hash, path);
  }
  assert.equal(byPath.get('.codex/agents/rtosv3-drvport-bys-architect.toml'), [
    'name = "rtosv3-drvport-bys-architect"',
    'description = "占位：分析设计阶段主控角色，正文待补；委派时机见分析设计任务书。"',
    'developer_instructions = """',
    '> **占位（placeholder）** 本角色由规范包声明为占位：未提供角色正文。',
    '',
    '按当前步骤的任务书执行；不要臆测本角色未声明的专有职责。',
    '',
    '<!-- hm2b:placeholder role=bys-architect -->',
    '"""',
    '',
  ].join('\n'));
});

test('the TOML shell carries only the Codex agent keys', () => {
  const { result } = codexSample();
  for (const file of result.files.filter((item) => item.kind === 'agent')) {
    const lines = file.content.split('\n').filter((line) => line !== '');
    assert.match(lines[0], /^name = "[a-z0-9-]+"$/);
    assert.match(lines[1], /^description = "/);
    assert.match(lines[2], /^developer_instructions = """$/);
    assert.equal(file.content.endsWith('"""\n'), true, file.path);
    assert.doesNotMatch(file.content, /^model\s*=/m);
    assert.doesNotMatch(file.content, /^tools\s*=/m);
    assert.doesNotMatch(file.content, /^skills\s*=/m);
    assert.doesNotMatch(file.content, /^title\s*=/m);
    assert.doesNotMatch(file.content, /^mode\s*=/m);
  }
});

test('sample field losses: model tiers omit the slot, titles have none', () => {
  const { result } = codexSample();
  assert.deepEqual(recordsOf(result), [
    'CAP_STATE_UNAVAILABLE|state|unavailable||',
    'CAP_ROLE_FIELD_DEGRADED|subagents|degraded|/roles/bys-architect|model',
    'CAP_ROLE_FIELD_DEGRADED|subagents|unavailable|/roles/bys-architect|title',
    'CAP_ROLE_FIELD_DEGRADED|subagents|degraded|/roles/bys-designer|model',
    'CAP_ROLE_FIELD_DEGRADED|subagents|unavailable|/roles/bys-designer|title',
    'CAP_ROLE_FIELD_DEGRADED|subagents|degraded|/roles/bys-impl-lead|model',
    'CAP_ROLE_FIELD_DEGRADED|subagents|unavailable|/roles/bys-impl-lead|title',
    'CAP_ROLE_FIELD_DEGRADED|subagents|degraded|/roles/bys-release-lead|model',
    'CAP_ROLE_FIELD_DEGRADED|subagents|unavailable|/roles/bys-release-lead|title',
  ]);
  const model = result.degradations.find((record) => record.field === 'model');
  assert.match(model.reason, /无能力档别名/);
  assert.match(model.effect, /default_subagent_model/);
  assert.equal(result.capabilityReport.find((row) => row.capability === 'subagents').level, 'native');
});

test('capability report is the codex matrix in fixed order', () => {
  const { result } = codexSample();
  assert.deepEqual(result.capabilityReport.map((row) => row.capability), CAPABILITIES);
  const levels = Object.fromEntries(result.capabilityReport.map((row) => [row.capability, row.level]));
  assert.deepEqual(levels, {
    state: 'unavailable',
    gates: 'degraded',
    outputs: 'degraded',
    subagents: 'native',
    skills: 'adapted',
    preload: 'unavailable',
    'stage-invocation': 'adapted',
    'skill-invocation': 'adapted',
  });
  assert.deepEqual(result.capabilityReport.find((row) => row.capability === 'state').uses, ['']);
  assert.deepEqual(result.capabilityReport.find((row) => row.capability === 'preload').uses, []);
});

// --- shared bytes ---------------------------------------------------------

test('shared skills are the Claude bytes at the shared root', () => {
  const codex = codexSample().result;
  const claude = claudeSample();
  const claudeByRest = new Map(claude.files
    .filter((file) => file.path.startsWith('.claude/skills/'))
    .map((file) => [file.path.slice('.claude/skills/'.length), file.content]));
  const shared = codex.files.filter((file) => file.path.startsWith('.agents/skills/'));
  assert.equal(shared.length, claudeByRest.size);
  for (const file of shared) {
    assert.equal(file.content, claudeByRest.get(file.path.slice('.agents/skills/'.length)), file.path);
  }
});

test('the role body is identical to Claude; only the shell differs', () => {
  const codex = codexSample().result;
  const claude = claudeSample();
  const toml = codex.files.find((file) => file.path === '.codex/agents/rtosv3-drvport-bys-architect.toml').content;
  const md = claude.files.find((file) => file.path === '.claude/agents/rtosv3-drvport-bys-architect.md').content;
  const mdBody = md.slice(md.indexOf('\n---\n') + 5);
  const start = toml.indexOf('"""') + 3;
  const tomlBody = toml.slice(start, toml.lastIndexOf('"""'));
  assert.equal(tomlBody, mdBody);
  assert.match(tomlBody, /^\n> \*\*占位（placeholder）\*\*/);
});

test('submit receipts and constitution placement are identical to Claude', () => {
  const codex = codexSample().result;
  const claude = claudeSample();
  const pick = (result, path) => result.files.find((file) => file.path === path).content;
  const relative = 'rtosv3-drvport-stage-analysis-design/SKILL.md';
  const codexStage = pick(codex, `.agents/skills/${relative}`);
  const claudeStage = pick(claude, `.claude/skills/${relative}`);
  assert.equal(codexStage, claudeStage);
  assert.match(codexStage, /^---\n[\s\S]*?\n---\n\n<!-- constitution:begin scope=global placeholder=true -->\n/);
  assert.ok(codexStage.indexOf('<!-- constitution:begin') < codexStage.indexOf('# 阶段'));
  assert.match(codexStage, /^# hm2b-submit: step=analysis-design$/m);
  assert.doesNotMatch(codexStage, /\{\{submit\}\}/);
  assert.doesNotMatch(codexStage, /node \.hm2b\/bin\/hm2b\.js/);
  const entry = pick(codex, '.agents/skills/rtosv3-drvport-workflow/SKILL.md');
  assert.equal(entry, pick(claude, '.claude/skills/rtosv3-drvport-workflow/SKILL.md'));
  assert.doesNotMatch(entry, /constitution:begin/);
});

// --- field-level capability gaps -----------------------------------------

test('a tool allow-list degrades by field and names the lost tokens', () => {
  const ir = miniIr({
    roles: {
      worker: role('worker', {
        tools: ['read', 'bash', 'task'],
        tools_deny: ['task'],
      }),
    },
  });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['codex'] } });
  assert.equal(result.ok, true);
  const tools = result.degradations.find((record) => record.field === 'tools');
  const deny = result.degradations.find((record) => record.field === 'tools_deny');
  assert.equal(tools.capability, 'subagents');
  assert.equal(tools.level, 'degraded');
  assert.equal(tools.pointer, '/roles/worker');
  assert.match(tools.reason, /read\/bash/);
  assert.match(tools.effect, /继承父会话工具面/);
  assert.equal(deny.capability, 'subagents');
  assert.equal(deny.level, 'degraded');
  assert.equal(deny.pointer, '/roles/worker');
  assert.match(deny.reason, /任务|task/);
  assert.match(deny.effect, /task（角色仍可再派子 agent）/);
  const file = result.files.find((item) => item.path === '.codex/agents/mini-worker.toml');
  assert.doesNotMatch(file.content, /features\.shell_tool/);
  assert.doesNotMatch(file.content, /^tools\s*=/m);
});

test('a bash-only deny is adapted to features.shell_tool = false', () => {
  const ir = miniIr({ roles: { shell: role('shell', { tools_deny: ['bash'] }) } });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['codex'] } });
  assert.equal(result.ok, true);
  assert.equal(result.degradations.some((record) => record.field === 'tools_deny'), false);
  const file = result.files.find((item) => item.path === '.codex/agents/mini-shell.toml');
  assert.match(file.content, /^features\.shell_tool = false$/m);
  const roles = JSON.parse(result.files.find((item) => item.path === '.agents/agent-native/mini/roles.json').content);
  assert.equal(roles.targets.codex.roles[0].fields.tools_deny.state, 'adapted');
});

test('model tiers without an alias are omitted; high efforts clamp', () => {
  const ir = miniIr({
    roles: { worker: role('worker', { model: 'strong', effort: 'max' }) },
  });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['codex'] } });
  assert.equal(result.ok, true);
  const file = result.files.find((item) => item.path === '.codex/agents/mini-worker.toml');
  assert.doesNotMatch(file.content, /^model\s*=/m);
  assert.match(file.content, /^model_reasoning_effort = "high"$/m);
  const model = result.degradations.find((record) => record.field === 'model');
  const effort = result.degradations.find((record) => record.field === 'effort');
  assert.equal(model.level, 'degraded');
  assert.equal(effort.level, 'degraded');
  assert.match(effort.reason, /向下钳制/);
  assert.match(effort.effect, /high/);
});

test('preload has no seam: skills stay out of the TOML and degrade per use', () => {
  const skills = helperSkill();
  const ir = miniIr({ skills, roles: { worker: role('worker', { skills: ['helper'] }) } });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['codex'] } });
  assert.equal(result.ok, true);
  const preload = result.degradations.filter((record) => record.capability === 'preload');
  assert.deepEqual(preload.map((record) => [record.code, record.level, record.pointer, record.field]), [
    ['CAP_PRELOAD_UNAVAILABLE', 'unavailable', '/roles/worker/skills/0', 'skills'],
  ]);
  assert.match(preload[0].reason, /没有按 agent 预载技能的接缝/);
  assert.equal(result.capabilityReport.find((row) => row.capability === 'preload').level, 'unavailable');
  const file = result.files.find((item) => item.path === '.codex/agents/mini-worker.toml');
  assert.doesNotMatch(file.content, /^skills\s*=/m);
  assert.doesNotMatch(file.content, /autoloadSkills/);
  assert.equal(result.files.some((item) => item.path === '.agents/skills/mini-skill-helper/SKILL.md'), true);
  const roles = JSON.parse(result.files.find((item) => item.path === '.agents/agent-native/mini/roles.json').content);
  assert.equal(roles.targets.codex.roles[0].fields.skills.state, 'unavailable');
});

test('mode=primary is skipped with a warning instead of faking an agent', () => {
  const ir = miniIr({
    roles: {
      worker: role('worker'),
      primary: role('primary', { mode: 'primary' }),
    },
  });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['codex'] } });
  assert.equal(result.ok, true);
  assert.equal(result.files.some((file) => file.path === '.codex/agents/mini-primary.toml'), false);
  assert.deepEqual(result.warnings, [{
    code: 'ROLE_EXPOSURE_SKIPPED',
    target: 'codex',
    pointer: '/roles/primary',
    message: 'role primary declares mode=primary; codex has no primary-session agent entry, so the role is not rendered',
  }]);
  const roles = JSON.parse(result.files.find((item) => item.path === '.agents/agent-native/mini/roles.json').content);
  const primary = roles.targets.codex.roles.find((entry) => entry.id === 'primary');
  assert.equal(primary.artifact, null);
  assert.equal(primary.exposure, 'skipped');
  assert.equal(primary.fields.mode.state, 'unavailable');
});

// --- roles.json -----------------------------------------------------------

test('roles.json gains a codex section consistent with idMap and file hashes', () => {
  const { ir, result } = codexSample();
  const file = result.files.find((item) => item.path === '.agents/agent-native/rtosv3-drvport/roles.json');
  assert.equal(file.kind, 'metadata');
  assert.deepEqual(file.targets, ['codex']);
  const roles = JSON.parse(file.content);
  assert.equal(roles.schema, 'hm2b.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets), ['codex']);
  assert.equal(roles.ir.sha256, result.ir.digest);
  const section = roles.targets.codex;
  assert.equal(section.namespace, 'rtosv3-drvport');
  assert.deepEqual(section.roles.map((entry) => entry.id), Object.keys(ir.roles).sort());
  assert.deepEqual(section.summary, { roles: 4, native: 8, adapted: 12, degraded: 4, unavailable: 4 });
  for (const entry of section.roles) {
    assert.equal(entry.name, result.metadata.idMap.codex.roles[entry.id]);
    assert.equal(entry.artifact.path, `.codex/agents/${entry.name}.toml`);
    assert.equal(entry.artifact.format, 'toml');
    const content = result.files.find((item) => item.path === entry.artifact.path).content;
    assert.equal(entry.artifact.sha256, sha256(content));
    assert.deepEqual(Object.keys(entry.fields), [
      'id', 'description', 'instructions', 'mode', 'model', 'title', 'placeholder',
    ]);
    assert.equal(entry.fields.id.state, 'adapted');
    assert.equal(entry.fields.instructions.state, 'adapted');
    assert.equal(entry.fields.model.state, 'degraded');
    assert.equal(entry.fields.title.state, 'unavailable');
  }
});

test('the same input twice yields byte-identical Codex results', () => {
  const first = codexSample().result;
  const second = codexSample().result;
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(second.files.map((file) => [file.path, file.content]), first.files.map((file) => [file.path, file.content]));
});

test('projection.json is canonical and lists the codex descriptor', () => {
  const path = join(ROOT, 'runtime/agent-native/projection/projection.json');
  assert.equal(readFileSync(path, 'utf8'), canonicalJson(AGENT_NATIVE_MANIFEST));
  assert.deepEqual(AGENT_NATIVE_MANIFEST.targets.map((target) => target.id), targetOrder());
  assert.ok(AGENT_NATIVE_MANIFEST.targets.some((target) => target.id === 'codex'));
  const codex = AGENT_NATIVE_MANIFEST.targets.find((target) => target.id === 'codex');
  assert.equal(codex.name, 'Codex');
  assert.equal(codex.default, true);
  assert.deepEqual(Object.keys(codex.capabilities), CAPABILITIES);
  assert.equal(codex.capabilities.subagents.level, 'native');
  assert.equal(codex.capabilities.preload.level, 'unavailable');
  assert.equal(codex.capabilities['stage-invocation'].level, 'adapted');
  for (const root of ['.agents/skills', '.codex/agents']) {
    assert.ok(AGENT_NATIVE_MANIFEST.writeRoots.includes(root), root);
  }
});
