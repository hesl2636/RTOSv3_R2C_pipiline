/**
 * agent-native target: omp (#97, decisions #71 §3.2/§10, #72 §5.2/§5.3/§5.5).
 *
 * The sample bundle projects to the closed omp tree: shared `.agents/skills`
 * (40), `.omp/agents` (4) and one roles.json. Role bytes for the sample roles
 * are the prototype oracle; the full-field frontmatter is asserted literally
 * (thinking-level, clamped effort, autoloadSkills intersection, model omission).
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
import { renderRole } from '../runtime/shared/render-role.js';
import { TARGETS, TARGET_ORDER } from '../runtime/agent-native/projection/targets/index.js';

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

function ompSample() {
  const { ir, irDigest } = sampleIr();
  return { ir, irDigest, result: runProject({ ir, irDigest, raw: { targets: ['omp'] } }) };
}

function source(path, fill) {
  return { path, sha256: fill.repeat(64) };
}

function skills(ids) {
  const out = {};
  for (const id of ids) {
    out[id] = {
      description: `Skill ${id}.`,
      placeholder: false,
      body: `\n# ${id}\n`,
      source: source(`skills/${id}/SKILL.md`, 'f'),
    };
  }
  return out;
}

function miniIr({ id = 'mini', roleId = 'worker', role = {}, skills: skillMap = {}, gates = [], outputs = [] } = {}) {
  return {
    schema: 'hm2b.ir/v2',
    id,
    name: 'Mini workflow',
    version: '1.0.0',
    description: 'A miniature workflow used by projection tests.',
    source: {
      bundle: { schema: 'hm2b.bundle/v1', id, version: '1.0.0', contentSha256: 'b'.repeat(64) },
      manifest: { path: 'bundle.json', sha256: 'c'.repeat(64) },
    },
    stages: [{
      id: 'one',
      name: 'One',
      steps: [{
        id: 'one',
        name: 'Step one',
        role: roleId,
        task: 'one-task',
        skills: Object.keys(skillMap),
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
        ...role,
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
    skills: skillMap,
    constitution: [],
  };
}

function roleFile(result, roleId = 'worker') {
  return result.files.find((file) => file.path === `.omp/agents/mini-${roleId}.md`);
}

function ompDegradations(result, pointer, field) {
  return result.degradations.filter((record) => record.target === 'omp'
    && record.pointer === pointer
    && (field === undefined || record.field === field));
}

// --- baseline ---------------------------------------------------------------

test('omp-only baseline: 45 files, 8 capability rows, 9 degradations, V1–V12 pass', () => {
  const { ir, irDigest, result } = ompSample();
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['omp']);
  assert.equal(result.files.length, 45);
  assert.equal(result.capabilityReport.length, 8);
  assert.equal(result.degradations.length, 9);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.options.targets, ['omp']);
  assert.deepEqual(result.options.stageOrder, ['analysis-design', 'detailed-design', 'implementation', 'verification']);
  assert.equal(result.options.skills.length, 35);

  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('the omp file set is .omp/agents + shared .agents/skills + roles.json', () => {
  const { result } = ompSample();
  const paths = result.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.filter((path) => path.startsWith('.omp/agents/')).length, 4);
  assert.equal(paths.filter((path) => path.startsWith('.agents/skills/')).length, 40);
  assert.equal(paths.filter((path) => path.endsWith('/SKILL.md')).length, 40);
  assert.deepEqual(paths.filter((path) => path.startsWith('.claude/')), []);
  assert.deepEqual(paths.filter((path) => path.startsWith('.agents/agent-native/')), [
    '.agents/agent-native/rtosv3-drvport/roles.json',
  ]);
  for (const path of paths) {
    assert.match(path, /^\.(?:agents|omp)\//);
    assert.doesNotMatch(path, /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|RULES\.md|opencode\.json|commands)(?:\/|$)/);
    assert.doesNotMatch(path, /^\.hm2b\//);
  }
  const kinds = new Map();
  for (const file of result.files) kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(kinds), { metadata: 1, agent: 4, skill: 35, stage: 4, workflow: 1 });
  assert.equal(result.installPlan.steps.length, result.files.length);
  assert.deepEqual(result.installPlan.steps.map((step) => step.path), paths);
});

test('sample omp role bytes match the prototype oracle', () => {
  const { result } = ompSample();
  const byPath = new Map(result.files.map((file) => [file.path, file.content]));
  const hashes = {
    '.omp/agents/rtosv3-drvport-bys-architect.md': 'adf799b37a3e0b904109d930d259e3e8578e45cc57937c4bc65e8a4ade1b3cee',
    '.omp/agents/rtosv3-drvport-bys-designer.md': '62dbe92405a8109bde8e58926bff6c54771fdfffff62558a4363dcd4b211c105',
    '.omp/agents/rtosv3-drvport-bys-impl-lead.md': '8544abe18bbeed178bfbd08cd8c827015ad0c4e1a6dba8ddf5b22930ab48afc1',
    '.omp/agents/rtosv3-drvport-bys-release-lead.md': 'd7244a17980b06a97a635d5f8556a3b0508f93deac07d55d81d60a5fa04c1c43',
  };
  for (const [path, hash] of Object.entries(hashes)) assert.equal(sha256(byPath.get(path)), hash, path);
});

test('full-field omp frontmatter: tools, thinking-level and autoloadSkills order', () => {
  const skillIds = ['alpha-skill', 'beta-skill'];
  const ir = miniIr({
    role: {
      title: 'Worker',
      model: 'strong',
      effort: 'high',
      tools: ['read', 'write', 'edit', 'glob', 'grep', 'web'],
      skills: ['beta-skill', 'alpha-skill'],
      instructions: '\n你是满字段角色。\n',
    },
    skills: skills(skillIds),
  });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['omp'] } });
  assert.equal(result.ok, true);
  assert.equal(roleFile(result).content, [
    '---',
    'name: mini-worker',
    'description: Runs the miniature step.',
    'tools:',
    '  - read',
    '  - write',
    '  - edit',
    '  - glob',
    '  - grep',
    '  - web_search',
    'thinking-level: high',
    'autoloadSkills:',
    '  - mini-skill-beta-skill',
    '  - mini-skill-alpha-skill',
    '---',
    '',
    '你是满字段角色。',
    '',
  ].join('\n'));
  const roles = JSON.parse(result.files.find((file) => file.path.endsWith('/roles.json')).content);
  const fields = roles.targets.omp.roles[0].fields;
  assert.equal(fields.model.state, 'degraded');
  assert.equal(fields.effort.state, 'adapted');
  assert.equal(fields.tools.state, 'adapted');
  assert.equal(fields.skills.state, 'native');
  assert.equal(fields.title.state, 'unavailable');
  assert.equal(roleFile(result).content.includes('model:'), false);
});

// --- preload intersection ---------------------------------------------------

test('autoloadSkills is role.skills ∩ skillNames; option-excluded skills are absent and recorded', () => {
  const ir = miniIr({
    role: { skills: ['alpha-skill', 'beta-skill'] },
    skills: skills(['alpha-skill', 'beta-skill']),
  });
  const irDigest = 'a'.repeat(64);
  const all = runProject({ ir, irDigest, raw: { targets: ['omp'] } });
  assert.equal(all.ok, true);
  assert.match(roleFile(all).content, /autoloadSkills:\n {2}- mini-skill-alpha-skill\n {2}- mini-skill-beta-skill\n/);

  const subset = runProject({ ir, irDigest, raw: { targets: ['omp'], skills: ['beta-skill'] } });
  assert.equal(subset.ok, true);
  assert.match(roleFile(subset).content, /autoloadSkills:\n {2}- mini-skill-beta-skill\n/);
  assert.equal(roleFile(subset).content.includes('alpha-skill'), false);
  const excluded = subset.degradations.filter((record) => record.code === 'CAP_PRELOAD_EXCLUDED');
  assert.deepEqual(excluded, [{
    code: 'CAP_PRELOAD_EXCLUDED',
    target: 'omp',
    capability: 'preload',
    level: 'unavailable',
    pointer: '/roles/worker/skills/0',
    field: 'skills',
    reason: '按投影选项 options.skills 排除',
    effect: '预载正文丢弃；技能本身也未安装',
  }]);
  const validation = validateResult(subset, { ir, irDigest, options: subset.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
});

// --- effort -----------------------------------------------------------------

test('thinking-level maps every IR effort 1:1 and clamps an out-of-ladder level downward', () => {
  const irDigest = 'a'.repeat(64);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const ir = miniIr({ role: { effort } });
    const result = runProject({ ir, irDigest, raw: { targets: ['omp'] } });
    assert.equal(result.ok, true);
    assert.match(roleFile(result).content, new RegExp(`\\nthinking-level: ${effort}\\n`));
    const fields = JSON.parse(result.files.find((file) => file.path.endsWith('/roles.json')).content)
      .targets.omp.roles[0].fields;
    assert.equal(fields.effort.state, 'adapted', effort);
    assert.deepEqual(ompDegradations(result, '/roles/worker', 'effort'), [], effort);
  }

  const ir = miniIr({ role: { effort: 'ultra' } });
  const result = runProject({ ir, irDigest, raw: { targets: ['omp'] } });
  assert.equal(result.ok, true);
  assert.match(roleFile(result).content, /\nthinking-level: max\n/);
  const fields = JSON.parse(result.files.find((file) => file.path.endsWith('/roles.json')).content)
    .targets.omp.roles[0].fields;
  assert.equal(fields.effort.state, 'degraded');
  const records = ompDegradations(result, '/roles/worker', 'effort');
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'degraded');
  assert.match(records[0].reason, /ultra/);
});

// --- model ------------------------------------------------------------------

test('a model tier without an alias is omitted and recorded once; an explicit literal is adapted', () => {
  const irDigest = 'a'.repeat(64);
  const ir = miniIr({ role: { model: 'strong' } });
  const result = runProject({ ir, irDigest, raw: { targets: ['omp'] } });
  assert.equal(result.ok, true);
  assert.equal(roleFile(result).content.includes('model:'), false);
  const records = ompDegradations(result, '/roles/worker', 'model');
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'degraded');

  const ctx = {
    namespace: 'mini',
    skillNames: new Map(),
    targets: TARGETS,
    roleModels: { omp: { strong: 'openai/gpt-5.4' } },
  };
  const rendered = renderRole({ ...miniIr({ role: { model: 'strong' } }).roles.worker, id: 'worker' }, 'omp', ctx);
  assert.match(rendered.content, /\nmodel: openai\/gpt-5\.4\n/);
  assert.equal(rendered.fields.model.state, 'adapted');
});

// --- exposure ---------------------------------------------------------------

test('omp has no primary-session agent: primary is skipped, any degrades', () => {
  const irDigest = 'a'.repeat(64);
  const primary = runProject({ ir: miniIr({ role: { mode: 'primary' } }), irDigest, raw: { targets: ['omp'] } });
  assert.equal(primary.ok, true);
  assert.equal(roleFile(primary), undefined);
  assert.deepEqual(primary.warnings.map((warning) => warning.code), ['ROLE_EXPOSURE_SKIPPED']);
  const skipped = JSON.parse(primary.files.find((file) => file.path.endsWith('/roles.json')).content)
    .targets.omp.roles[0];
  assert.equal(skipped.exposure, 'skipped');
  assert.equal(skipped.artifact, null);
  assert.equal(skipped.fields.mode.state, 'unavailable');

  const any = runProject({ ir: miniIr({ role: { mode: 'any' } }), irDigest, raw: { targets: ['omp'] } });
  assert.equal(any.ok, true);
  const section = JSON.parse(any.files.find((file) => file.path.endsWith('/roles.json')).content).targets.omp;
  assert.equal(section.roles[0].exposure, 'both');
  assert.equal(section.roles[0].fields.mode.state, 'degraded');
  assert.equal(ompDegradations(any, '/roles/worker', 'mode').length, 1);
});

// --- roles.json + capability report ----------------------------------------

test('roles.json gains an omp section consistent with idMap and one record per field loss', () => {
  const { ir, result } = ompSample();
  const file = result.files.find((item) => item.path.endsWith('/roles.json'));
  assert.equal(file.kind, 'metadata');
  assert.deepEqual(file.targets, ['omp']);
  assert.equal(result.installPlan.steps.filter((step) => step.path === file.path).length, 1);
  const roles = JSON.parse(file.content);
  assert.equal(roles.schema, 'hm2b.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets), ['omp']);
  assert.equal(roles.ir.sha256, result.ir.digest);
  const section = roles.targets.omp;
  assert.equal(section.namespace, 'rtosv3-drvport');
  assert.deepEqual(section.roles.map((role) => role.id), Object.keys(ir.roles).sort());
  for (const role of section.roles) {
    assert.equal(role.name, result.metadata.idMap.omp.roles[role.id]);
    assert.equal(role.placeholder, ir.roles[role.id].placeholder);
    assert.equal(role.artifact.path, `.omp/agents/${role.name}.md`);
    assert.equal(role.artifact.format, 'md');
    assert.equal(role.artifact.sha256, sha256(result.files.find((item) => item.path === role.artifact.path).content));
    assert.deepEqual(Object.keys(role.fields),
      ['id', 'description', 'instructions', 'mode', 'model', 'title', 'placeholder']);
    assert.equal(role.fields.id.state, 'adapted');
    assert.equal(role.fields.description.state, 'native');
    assert.equal(role.fields.instructions.state, 'native');
    assert.equal(role.fields.mode.state, 'native');
    assert.equal(role.fields.model.state, 'degraded');
    assert.equal(role.fields.title.state, 'unavailable');
    assert.equal(role.fields.placeholder.state, 'adapted');
    for (const [field, state] of Object.entries(role.fields)) {
      if (state.state !== 'degraded' && state.state !== 'unavailable') continue;
      assert.equal(ompDegradations(result, `/roles/${role.id}`, field).length, 1, `${role.id}/${field}`);
    }
  }
  const keys = result.degradations.map((record) => [record.target, record.capability, record.pointer, record.field ?? ''].join('|'));
  assert.equal(new Set(keys).size, keys.length);
});

test('the omp capability matrix is fixed: preload/subagents native, skills adapted, granularity native', () => {
  const { result } = ompSample();
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
  assert.deepEqual(result.capabilityReport.find((row) => row.capability === 'preload').uses, []);
  assert.deepEqual(result.capabilityReport.find((row) => row.capability === 'subagents').uses, [
    '/stages/0/steps/0/role',
    '/stages/1/steps/0/role',
    '/stages/2/steps/0/role',
    '/stages/3/steps/0/role',
  ]);
  assert.equal(result.metadata.placeholders.constitution, 'placeholder');
  assert.deepEqual(result.metadata.placeholders.roles, ['bys-architect', 'bys-designer', 'bys-impl-lead', 'bys-release-lead']);
  assert.equal(result.metadata.placeholders.skills.length, 35);
  assert.equal(result.metadata.placeholders.roles.length, 4);
  assert.deepEqual(result.metadata.runtime.targetGroups, { 'shared-skills': ['omp'] });
  assert.deepEqual(result.metadata.runtime.skillsRoots, { omp: '.agents/skills' });
  const roleFiles = result.files.filter((file) => file.kind === 'agent');
  assert.equal(roleFiles.length, 4);
  for (const file of roleFiles) assert.match(file.content, /hm2b:placeholder role=/);
});

test('the constitution block and {{submit}} receipt are identical to the Claude placement', () => {
  const { result } = ompSample();
  const stage = result.files.find((file) => file.path.endsWith('stage-analysis-design/SKILL.md'));
  assert.match(stage.content, /^---\n[\s\S]*?\n---\n\n<!-- constitution:begin scope=global placeholder=true -->\n/);
  assert.ok(stage.content.indexOf('<!-- constitution:begin') < stage.content.indexOf('# 阶段'));
  assert.match(stage.content, /> \*\*占位（placeholder）\*\*/);
  assert.match(stage.content, /^# hm2b-submit: step=analysis-design$/m);
  assert.doesNotMatch(stage.content, /\{\{submit\}\}/);
  assert.doesNotMatch(stage.content, /node \.hm2b\/bin\/hm2b\.js/);
  const entry = result.files.find((file) => file.kind === 'workflow');
  assert.doesNotMatch(entry.content, /constitution:begin/);
});

// --- determinism + manifest ------------------------------------------------

test('the same input twice yields byte-identical omp results', () => {
  const first = ompSample().result;
  const second = runProject({ ...sampleIr(), raw: { targets: ['omp'] } });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('projection.json is the canonical manifest with the omp target registered', () => {
  const path = join(ROOT, 'runtime/agent-native/projection/projection.json');
  assert.equal(readFileSync(path, 'utf8'), canonicalJson(AGENT_NATIVE_MANIFEST));
  assert.deepEqual(AGENT_NATIVE_MANIFEST.targets.map((target) => target.id), TARGET_ORDER);
  assert.ok(TARGET_ORDER.includes('omp'));
  const target = AGENT_NATIVE_MANIFEST.targets.find((item) => item.id === 'omp');
  assert.equal(target.name, 'Oh My Pi (omp)');
  assert.deepEqual(Object.keys(target.capabilities), CAPABILITIES);
  for (const capability of CAPABILITIES) {
    assert.equal(typeof target.capabilities[capability].note, 'string');
    assert.ok(target.capabilities[capability].note.length > 0);
  }
  for (const root of ['.omp/agents', '.agents/skills', '.agents/agent-native']) {
    assert.ok(AGENT_NATIVE_MANIFEST.writeRoots.includes(root), root);
  }
});
