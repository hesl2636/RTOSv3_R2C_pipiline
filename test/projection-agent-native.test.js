/**
 * agent-native projection + Claude Code target (#95).
 *
 * The sample bundle compiles to the frozen IR; projecting it with only the
 * `claude-code` target must produce the closed 45-file set, 8 capability rows
 * and a result that passes V1–V12 twice byte-identically.
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
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import { AGENT_NATIVE_MANIFEST } from '../runtime/agent-native/projection/manifest.js';
import { TARGET_ORDER } from '../runtime/agent-native/projection/targets/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const MANIFEST = getProjection('agent-native');
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

function claudeSample() {
  const { ir, irDigest } = sampleIr();
  return { ir, irDigest, result: runProject({ ir, irDigest, raw: { targets: ['claude-code'] } }) };
}

function miniIr({ id = 'mini', roleId = 'worker', stages, gates = [], outputs = [], skills = {} } = {}) {
  const source = (path, fill) => ({ path, sha256: fill.repeat(64) });
  return {
    schema: 'r2c.ir/v1',
    id,
    name: 'Mini workflow',
    version: '1.0.0',
    description: 'A miniature workflow used by projection tests.',
    source: {
      bundle: { schema: 'r2c.bundle/v1', id, version: '1.0.0', contentSha256: 'b'.repeat(64) },
      manifest: { path: 'bundle.json', sha256: 'c'.repeat(64) },
    },
    stages: stages ?? [{
      id: 'one',
      name: 'One',
      steps: [{
        id: 'one',
        name: 'Step one',
        role: roleId,
        task: 'one-task',
        skills: Object.keys(skills),
        outputs,
        gates,
      }],
    }],
    roles: {
      [roleId]: {
        description: 'Runs the miniature step.',
        mode: 'subagent',
        placeholder: false,
        instructions: '\nDo the work.\n',
        source: source(`roles/${roleId}.md`, 'd'),
      },
    },
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

// --- the frozen baseline --------------------------------------------------

test('claude-only baseline: 45 files, 8 capability rows, 5 degradations, V1–V12 pass', () => {
  const { ir, irDigest, result } = claudeSample();
  assert.equal(result.ok, true);
  assert.equal(result.schema, 'r2c.projection-result/v1');
  assert.deepEqual(result.targets, ['claude-code']);
  assert.equal(result.files.length, 45);
  assert.equal(result.capabilityReport.length, 8);
  assert.equal(result.degradations.length, 5);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.options.stageOrder, ['analysis-design', 'detailed-design', 'implementation', 'verification']);
  assert.equal(result.options.skills.length, 35);
  assert.deepEqual(result.options.targets, ['claude-code']);

  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('the file set is the closed three-tree layout (no user files, commands or .r2c)', () => {
  const { result } = claudeSample();
  const paths = result.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.filter((path) => path.startsWith('.claude/agents/')).length, 4);
  assert.equal(paths.filter((path) => path.startsWith('.claude/skills/')).length, 40);
  assert.equal(paths.filter((path) => path.endsWith('/SKILL.md')).length, 40);
  assert.deepEqual(paths.filter((path) => path.startsWith('.agents/')), [
    '.agents/agent-native/rtosv3-drvport/roles.json',
  ]);
  for (const path of paths) {
    assert.match(path, /^\.(?:claude|agents)\//);
    assert.doesNotMatch(path, /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|RULES\.md|opencode\.json|commands)(?:\/|$)/);
    assert.doesNotMatch(path, /^\.r2c\//);
  }
  const kinds = new Map();
  for (const file of result.files) kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(kinds), { metadata: 1, agent: 4, skill: 35, stage: 4, workflow: 1 });
  assert.equal(result.installPlan.steps.length, result.files.length);
  assert.deepEqual(result.installPlan.steps.map((step) => step.path), paths);
  for (const step of result.installPlan.steps) {
    assert.equal(step.op, 'write');
    assert.equal(step.overwrite, 'replace');
  }
});

test('generated bytes match the prototype oracle', () => {
  const { result } = claudeSample();
  const byPath = new Map(result.files.map((file) => [file.path, file.content]));
  const hashes = {
    '.claude/skills/rtosv3-drvport-workflow/SKILL.md': 'e0e097a0092c9584f20956f8ad381eb6aa465578ab87f46e5e8d5d55e9e9d68f',
    '.claude/skills/rtosv3-drvport-stage-analysis-design/SKILL.md': 'b09c7be2338ca7740fd216bd6149ab98b7e184c856fb1985eab842915d706f1c',
    '.claude/skills/rtosv3-drvport-skill-ar-miner/SKILL.md': 'f7823d7ab51b2f9dd55f44e9bfc81e2a885f75ab4695ae19a399e5dfaca9f7f8',
    '.claude/agents/rtosv3-drvport-bys-architect.md': '2d2b1cf862d576c9cd8f431686343e06c64084ae9f137eb2a7f271f062d1d3cc',
    '.agents/agent-native/rtosv3-drvport/roles.json': 'aea579eb1d850dad6c340c05910a5239a4bfcef135d7dcc5e6ee98180520db93',
  };
  for (const [path, hash] of Object.entries(hashes)) {
    assert.equal(sha256(byPath.get(path)), hash, path);
  }
});

test('the constitution block starts every stage skill and never the entry skill', () => {
  const { result } = claudeSample();
  const stage = result.files.find((file) => file.kind === 'stage');
  assert.match(stage.content, /^---\n/);
  assert.match(stage.content, /^---\n[\s\S]*?\n---\n\n<!-- constitution:begin scope=global placeholder=true -->\n/);
  assert.ok(stage.content.indexOf('<!-- constitution:begin') < stage.content.indexOf('# 阶段'));
  assert.match(stage.content, /> \*\*占位（placeholder）\*\*/);
  const entry = result.files.find((file) => file.kind === 'workflow');
  assert.doesNotMatch(entry.content, /constitution:begin/);
  for (const file of result.files.filter((item) => item.kind === 'stage')) {
    assert.ok(file.content.includes('<!-- constitution:end -->'));
  }
});

test('{{submit}} is replaced exactly once per task and never survives', () => {
  const { result } = claudeSample();
  for (const file of result.files) assert.equal(file.content.includes('{{submit}}'), false, file.path);
  const stage = result.files.find((file) => file.path.endsWith('stage-analysis-design/SKILL.md'));
  const markers = stage.content.match(/^# r2c-submit: step=analysis-design$/gm) ?? [];
  assert.equal(markers.length, 1);
  assert.doesNotMatch(stage.content, /node \.r2c\/bin\/r2c\.js/);
  const receipt = stage.content.split('\n').filter((line) => line.startsWith('# r2c-submit:'));
  assert.equal(receipt[0], '# r2c-submit: step=analysis-design');
});

test('roles.json is one canonical file sectioned by target and consistent with idMap', () => {
  const { ir, result } = claudeSample();
  const file = result.files.find((item) => item.path.endsWith('/roles.json'));
  assert.equal(file.kind, 'metadata');
  assert.deepEqual(file.targets, ['claude-code']);
  assert.equal(result.installPlan.steps.filter((step) => step.path === file.path).length, 1);
  const roles = JSON.parse(file.content);
  assert.equal(roles.schema, 'r2c.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets), ['claude-code']);
  assert.equal(roles.ir.sha256, result.ir.digest);
  const section = roles.targets['claude-code'];
  assert.equal(section.namespace, 'rtosv3-drvport');
  assert.deepEqual(section.roles.map((role) => role.id), Object.keys(ir.roles).sort());
  for (const role of section.roles) {
    assert.equal(role.name, result.metadata.idMap['claude-code'].roles[role.id]);
    assert.equal(role.placeholder, ir.roles[role.id].placeholder);
    assert.equal(role.artifact.path, `.claude/agents/${role.name}.md`);
    assert.equal(role.artifact.sha256, sha256(result.files.find((item) => item.path === role.artifact.path).content));
    for (const [field, state] of Object.entries(role.fields)) {
      if (state.state !== 'degraded' && state.state !== 'unavailable') continue;
      const source = result.degradations.find((record) => record.target === 'claude-code'
        && record.pointer.startsWith(`/roles/${role.id}`)
        && record.field === field
        && record.level === state.state);
      assert.ok(source, `${role.id}/${field}`);
    }
  }
  const summary = { roles: section.roles.length, native: 0, adapted: 0, degraded: 0, unavailable: 0 };
  for (const role of section.roles) for (const state of Object.values(role.fields)) summary[state.state] += 1;
  assert.deepEqual(section.summary, summary);
  // Field-level records are unique by (target, capability, pointer, field).
  const keys = result.degradations.map((record) => [record.target, record.capability, record.pointer, record.field ?? ''].join('|'));
  assert.equal(new Set(keys).size, keys.length);
});

test('capability report is the claude-code matrix in fixed order', () => {
  const { result } = claudeSample();
  assert.deepEqual(result.capabilityReport.map((row) => row.capability), CAPABILITIES);
  const levels = Object.fromEntries(result.capabilityReport.map((row) => [row.capability, row.level]));
  assert.deepEqual(levels, {
    state: 'unavailable',
    gates: 'degraded',
    outputs: 'degraded',
    subagents: 'native',
    skills: 'adapted',
    preload: 'native',
    'stage-invocation': 'native',
    'skill-invocation': 'native',
  });
  assert.deepEqual(result.capabilityReport.find((row) => row.capability === 'state').uses, ['']);
  assert.equal(result.metadata.placeholders.constitution, 'placeholder');
  assert.deepEqual(result.metadata.placeholders.roles, ['bys-architect', 'bys-designer', 'bys-impl-lead', 'bys-release-lead']);
  assert.equal(result.metadata.placeholders.skills.length, 35);
});

test('the same input twice yields byte-identical results', () => {
  const first = claudeSample().result;
  const second = runProject({ ...sampleIr(), raw: { targets: ['claude-code'] } });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(second.files.map((file) => [file.path, file.content]), first.files.map((file) => [file.path, file.content]));
});

test('stage order options reorder coverage and only warn', () => {
  const { ir, irDigest } = sampleIr();
  const stages = ir.stages.map((stage) => stage.id).reverse();
  const { result } = { result: runProject({ ir, irDigest, raw: { targets: ['claude-code'], stageOrder: stages } }) };
  assert.equal(result.ok, true);
  assert.deepEqual(result.coverage.stages, stages);
  assert.deepEqual(result.options.stageOrder, stages);
  assert.deepEqual(result.warnings, [{ code: 'STAGE_ORDER_OVERRIDDEN', message: 'options.stageOrder differs from IR order; rendering order follows the option' }]);
  assert.equal(result.files.length, 45);
});

test('a skill subset drops copies and records option losses', () => {
  const { ir, irDigest } = sampleIr();
  const skills = Object.keys(ir.skills).sort().slice(0, 12);
  const { result } = { result: runProject({ ir, irDigest, raw: { targets: ['claude-code'], skills } }) };
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 22);
  assert.deepEqual(result.options.skills, skills);
  assert.equal(result.files.filter((file) => file.kind === 'skill').length, 12);
  const excluded = result.degradations.filter((record) => record.code === 'CAP_SKILL_EXCLUDED');
  assert.equal(excluded.length, 35 - 12);
  for (const record of excluded) {
    assert.equal(record.target, 'claude-code');
    assert.equal(record.capability, 'skills');
    assert.equal(record.level, 'unavailable');
  }
  assert.equal(result.capabilityReport.find((row) => row.capability === 'skills').level, 'unavailable');
  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
});

test('gates and outputs degrade per use point and stay visible in the stage skill', () => {
  const ir = miniIr({
    gates: [{ command: 'node --test', timeout: 600 }],
    outputs: ['reports/*.md'],
    skills: {
      helper: {
        description: 'Helps.',
        placeholder: false,
        body: '\n# Helper\n',
        source: { path: 'skills/helper/SKILL.md', sha256: 'f'.repeat(64) },
      },
    },
  });
  const irDigest = 'a'.repeat(64);
  const result = runProject({ ir, irDigest, raw: { targets: ['claude-code'] } });
  assert.equal(result.ok, true);
  const gates = result.degradations.filter((record) => record.capability === 'gates');
  const outputs = result.degradations.filter((record) => record.capability === 'outputs');
  assert.deepEqual(gates.map((record) => record.pointer), ['/stages/0/steps/0/gates/0']);
  assert.deepEqual(outputs.map((record) => record.pointer), ['/stages/0/steps/0/outputs/0']);
  const stage = result.files.find((file) => file.path.endsWith('stage-one/SKILL.md'));
  assert.ok(stage.content.includes('node --test'));
  assert.ok(stage.content.includes('reports/*.md'));
  assert.ok(stage.content.includes('超时：600 秒'));
  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('projection.json is the canonical manifest and derives from the target registry', () => {
  const path = join(ROOT, 'runtime/agent-native/projection/projection.json');
  assert.equal(readFileSync(path, 'utf8'), canonicalJson(AGENT_NATIVE_MANIFEST));
  assert.deepEqual(AGENT_NATIVE_MANIFEST.targets.map((target) => target.id), TARGET_ORDER);
  assert.ok(TARGET_ORDER.includes('claude-code'));
  const target = AGENT_NATIVE_MANIFEST.targets.find((item) => item.id === 'claude-code');
  assert.equal(target.capabilities.state.level, 'unavailable');
  assert.equal(typeof target.capabilities.state.note, 'string');
  for (const root of ['.agents/agent-native', '.agents/skills', '.claude/agents', '.claude/skills']) {
    assert.ok(AGENT_NATIVE_MANIFEST.writeRoots.includes(root), root);
  }
});

test('name collisions fail with PROJECTION_ID_COLLISION instead of silently renaming', () => {
  const ir = miniIr({ roleId: 'stage-one' });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['claude-code'] } });
  assert.equal(result.ok, false);
  assert.equal(result.files, undefined);
  assert.ok(result.errors.some((error) => error.code === 'PROJECTION_ID_COLLISION'));
});

test('over-long rendered names fail instead of being truncated', () => {
  const roleId = `worker-${'x'.repeat(50)}`;
  const ir = miniIr({ id: `bundle-${'y'.repeat(20)}`, roleId });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['claude-code'] } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'PROJECTION_NAME_TOO_LONG'));
});
