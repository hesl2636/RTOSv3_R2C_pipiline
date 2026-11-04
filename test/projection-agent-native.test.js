/**
 * agent-native projection + Claude Code target (#95).
 *
 * The sample bundle compiles to the frozen compiled workflow; projecting it with only the
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
import { TARGETS, targetOrder } from '../runtime/agent-native/projection/targets/index.js';
import {
  ASSET_CHECKLISTS,
  ASSET_HOOKS,
  ASSET_KNOWLEDGE_BASE,
  ASSET_MCP,
  assetZip,
} from './helpers/minimal-bundle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const MANIFEST = getProjection('agent-native');
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const CAPABILITIES = [
  'state', 'gates', 'outputs', 'subagents', 'skills', 'preload',
  'stage-invocation', 'skill-invocation',
];

let sample;
function sampleCompiledWorkflow() {
  if (sample !== undefined) return sample;
  const compiled = compileBundle(new Uint8Array(readFileSync(ZIP)), { inflateRaw, sha256: sha256Hex });
  assert.equal(compiled.ok, true);
  sample = { compiledWorkflow: JSON.parse(new TextDecoder().decode(compiled.compiledWorkflowBytes)), compiledWorkflowDigest: compiled.digest };
  return sample;
}

function runProject({ compiledWorkflow, compiledWorkflowDigest, raw }) {
  const normalized = normalizeOptions({
    projectionId: 'agent-native',
    compiledWorkflow,
    compiledWorkflowDigest,
    raw,
    manifest: MANIFEST,
  });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  return project({
    projectionId: 'agent-native',
    compiledWorkflow,
    compiledWorkflowDigest,
    options: normalized.options,
    environment: {},
    assets: {},
  });
}

function claudeSample() {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  return { compiledWorkflow, compiledWorkflowDigest, result: runProject({ compiledWorkflow, compiledWorkflowDigest, raw: { targets: ['claude-code'] } }) };
}

function miniCompiledWorkflow({ id = 'mini', roleId = 'worker', stages, gates = [], outputs = [], skills = {} } = {}) {
  const source = (path, fill) => ({ path, sha256: fill.repeat(64) });
  return {
    schema: 'hm2b.compiled-workflow/v2',
    id,
    name: 'Mini workflow',
    version: '1.0.0',
    description: 'A miniature workflow used by projection tests.',
    source: {
      bundle: { schema: 'hm2b.bundle/v1', id, version: '1.0.0', contentSha256: 'b'.repeat(64) },
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
  const { compiledWorkflow, compiledWorkflowDigest, result } = claudeSample();
  assert.equal(result.ok, true);
  assert.equal(result.schema, 'hm2b.projection-result/v1');
  assert.deepEqual(result.targets, ['claude-code']);
  assert.equal(result.files.length, 45);
  assert.equal(result.capabilityReport.length, 8);
  assert.equal(result.degradations.length, 5);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.options.stageOrder, ['analysis-design', 'detailed-design', 'implementation', 'verification']);
  assert.equal(result.options.skills.length, 35);
  assert.deepEqual(result.options.targets, ['claude-code']);

  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('the file set is the closed three-tree layout (no user files, commands or .hm2b)', () => {
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
    assert.doesNotMatch(path, /^\.hm2b\//);
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

test('declared bundle assets project once under the namespace root for every selected target', () => {
  const compiled = compileBundle(new Uint8Array(assetZip()), { inflateRaw, sha256: sha256Hex });
  assert.equal(compiled.ok, true);
  const compiledWorkflow = JSON.parse(new TextDecoder().decode(compiled.compiledWorkflowBytes));
  const compiledWorkflowDigest = compiled.digest;
  const result = runProject({ compiledWorkflow, compiledWorkflowDigest, raw: { targets: ['claude-code', 'codex'] } });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  const root = `.agents/agent-native/${compiledWorkflow.id}`;
  const assets = result.files.filter((file) => ['knowledge', 'checklist', 'hooks', 'mcp'].includes(file.kind));
  assert.deepEqual(assets.map((file) => [file.kind, file.path]), [
    ['checklist', `${root}/checklists/design.md`],
    ['checklist', `${root}/checklists/impl.md`],
    ['hooks', `${root}/hooks/hooks.json`],
    ['knowledge', `${root}/knowledge-base/coding-standards/cleancode/rules.md`],
    ['knowledge', `${root}/knowledge-base/os-api-mapping/freertos.md`],
    ['mcp', `${root}/mcp.json`],
  ]);
  for (const file of assets) {
    assert.deepEqual(file.targets, result.targets);
    assert.equal(file.origin, 'generated');
    assert.equal(file.mode, 0o644);
  }
  const byPath = new Map(result.files.map((file) => [file.path, file.content]));
  assert.equal(byPath.get(`${root}/knowledge-base/os-api-mapping/freertos.md`), ASSET_KNOWLEDGE_BASE.get('knowledge-base/os-api-mapping/freertos.md'));
  assert.equal(byPath.get(`${root}/knowledge-base/coding-standards/cleancode/rules.md`), ASSET_KNOWLEDGE_BASE.get('knowledge-base/coding-standards/cleancode/rules.md'));
  for (const [id, body] of ASSET_CHECKLISTS) assert.equal(byPath.get(`${root}/checklists/${id}.md`), body);
  assert.equal(byPath.get(`${root}/hooks/hooks.json`), canonicalJson(ASSET_HOOKS));
  assert.equal(byPath.get(`${root}/mcp.json`), canonicalJson(ASSET_MCP));

  assert.equal(result.metadata.artifacts['knowledge-os-api-mapping-freertos'], `${root}/knowledge-base/os-api-mapping/freertos.md`);
  assert.equal(result.metadata.artifacts['knowledge-coding-standards-cleancode-rules'], `${root}/knowledge-base/coding-standards/cleancode/rules.md`);
  assert.equal(result.metadata.artifacts['checklist-design'], `${root}/checklists/design.md`);
  assert.equal(result.metadata.artifacts['checklist-impl'], `${root}/checklists/impl.md`);
  assert.equal(result.metadata.artifacts.hooks, `${root}/hooks/hooks.json`);
  assert.equal(result.metadata.artifacts.mcp, `${root}/mcp.json`);

  // Exactly one shared copy: no target-local asset tree, no user-owned file.
  assert.equal(result.files.filter((file) => file.path.endsWith('/hooks/hooks.json')).length, 1);
  assert.equal(result.files.filter((file) => file.path.endsWith('/mcp.json')).length, 1);
  for (const file of result.files) {
    assert.doesNotMatch(file.path, /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.mcp\.json)(?:\/|$)/);
    if (file.kind === 'knowledge' || file.kind === 'checklist' || file.kind === 'hooks' || file.kind === 'mcp') {
      assert.ok(file.path.startsWith(`${root}/`), file.path);
    }
  }

  // Assets add no capability row and no degradation.
  assert.equal(result.capabilityReport.length, result.targets.length * CAPABILITIES.length);
  assert.deepEqual(result.capabilityReport.map((row) => row.capability), result.targets.flatMap(() => CAPABILITIES));

  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));

  const again = runProject({ compiledWorkflow, compiledWorkflowDigest, raw: { targets: ['claude-code', 'codex'] } });
  assert.equal(JSON.stringify(again), JSON.stringify(result));
});

test('generated bytes match the prototype oracle', () => {
  const { result } = claudeSample();
  const byPath = new Map(result.files.map((file) => [file.path, file.content]));
  const hashes = {
    '.claude/skills/workflow/SKILL.md': '17166b99c71bb0d70627905f83dcd98cccf6ca20fb423f71a29df5f2fccf0718',
    '.claude/skills/stage-analysis-design/SKILL.md': '08fe9d7d91da5b8b7483b001558668d6368d866f6fbc274f1acbbb8f3fd9593e',
    '.claude/skills/ar-miner/SKILL.md': '83a403c7e56c004bafcaa26bd0f4bb5fdc04a5242c177dea6308c0d02e4f48b2',
    '.claude/agents/bys-architect.md': 'e7d61157b65bc90831d9c1b3927bbe90f7567935c932498375afe6fffbf5837b',
    '.agents/agent-native/rtosv3-drvport/roles.json': '0e0e1b0a4ec658f995b48d576a7e03ece5ee294a837a9921d836d9433a0892ea',
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
  const markers = stage.content.match(/^# hm2b-submit: step=analysis-design$/gm) ?? [];
  assert.equal(markers.length, 1);
  assert.doesNotMatch(stage.content, /node \.hm2b\/bin\/hm2b\.js/);
  const receipt = stage.content.split('\n').filter((line) => line.startsWith('# hm2b-submit:'));
  assert.equal(receipt[0], '# hm2b-submit: step=analysis-design');
});

test('roles.json is one canonical file sectioned by target and consistent with idMap', () => {
  const { compiledWorkflow, result } = claudeSample();
  const file = result.files.find((item) => item.path.endsWith('/roles.json'));
  assert.equal(file.kind, 'metadata');
  assert.deepEqual(file.targets, ['claude-code']);
  assert.equal(result.installPlan.steps.filter((step) => step.path === file.path).length, 1);
  const roles = JSON.parse(file.content);
  assert.equal(roles.schema, 'hm2b.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets), ['claude-code']);
  assert.equal(roles.compiledWorkflow.sha256, result.compiledWorkflow.digest);
  const section = roles.targets['claude-code'];
  assert.equal(section.namespace, 'rtosv3-drvport');
  assert.deepEqual(section.roles.map((role) => role.id), Object.keys(compiledWorkflow.roles).sort());
  for (const role of section.roles) {
    assert.equal(role.name, result.metadata.idMap['claude-code'].roles[role.id]);
    assert.equal(role.placeholder, compiledWorkflow.roles[role.id].placeholder);
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
  const second = runProject({ ...sampleCompiledWorkflow(), raw: { targets: ['claude-code'] } });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(second.files.map((file) => [file.path, file.content]), first.files.map((file) => [file.path, file.content]));
});

test('stage order options reorder coverage and only warn', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const stages = compiledWorkflow.stages.map((stage) => stage.id).reverse();
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest, raw: { targets: ['claude-code'], stageOrder: stages } }) };
  assert.equal(result.ok, true);
  assert.deepEqual(result.coverage.stages, stages);
  assert.deepEqual(result.options.stageOrder, stages);
  assert.deepEqual(result.warnings, [{ code: 'STAGE_ORDER_OVERRIDDEN', message: 'options.stageOrder differs from compiled workflow order; rendering order follows the option' }]);
  assert.equal(result.files.length, 45);
});

test('a skill subset drops copies and records option losses', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const skills = Object.keys(compiledWorkflow.skills).sort().slice(0, 12);
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest, raw: { targets: ['claude-code'], skills } }) };
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
  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
});

test('gates and outputs degrade per use point and stay visible in the stage skill', () => {
  const compiledWorkflow = miniCompiledWorkflow({
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
  const compiledWorkflowDigest = 'a'.repeat(64);
  const result = runProject({ compiledWorkflow, compiledWorkflowDigest, raw: { targets: ['claude-code'] } });
  assert.equal(result.ok, true);
  const gates = result.degradations.filter((record) => record.capability === 'gates');
  const outputs = result.degradations.filter((record) => record.capability === 'outputs');
  assert.deepEqual(gates.map((record) => record.pointer), ['/stages/0/steps/0/gates/0']);
  assert.deepEqual(outputs.map((record) => record.pointer), ['/stages/0/steps/0/outputs/0']);
  const stage = result.files.find((file) => file.path.endsWith('stage-one/SKILL.md'));
  assert.ok(stage.content.includes('node --test'));
  assert.ok(stage.content.includes('reports/*.md'));
  assert.ok(stage.content.includes('超时：600 秒'));
  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('projection.json is the canonical manifest and derives from the target registry', () => {
  const path = join(ROOT, 'runtime/agent-native/projection/projection.json');
  assert.equal(readFileSync(path, 'utf8'), canonicalJson(AGENT_NATIVE_MANIFEST));
  assert.deepEqual(AGENT_NATIVE_MANIFEST.targets.map((target) => target.id), targetOrder());
  assert.ok(AGENT_NATIVE_MANIFEST.targets.some((target) => target.id === 'claude-code'));
  const target = AGENT_NATIVE_MANIFEST.targets.find((item) => item.id === 'claude-code');
  assert.equal(target.capabilities.state.level, 'unavailable');
  assert.equal(typeof target.capabilities.state.note, 'string');
  for (const root of ['.agents/agent-native', '.agents/skills', '.claude/agents', '.claude/skills']) {
    assert.ok(AGENT_NATIVE_MANIFEST.writeRoots.includes(root), root);
  }

  // Static host assets are declared, not hidden: every descriptor asset is
  // listed once with a stable id and the digest of its bytes on disk.
  const descriptors = targetOrder().flatMap((id) => TARGETS[id].assets ?? []);
  assert.equal(AGENT_NATIVE_MANIFEST.assets.length, descriptors.length);
  assert.equal(new Set(AGENT_NATIVE_MANIFEST.assets.map((asset) => asset.id)).size, descriptors.length);
  for (const asset of AGENT_NATIVE_MANIFEST.assets) {
    assert.match(asset.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.equal(asset.sha256, sha256Hex(readFileSync(join(ROOT, ...asset.path.split('/')))), asset.path);
  }
  assert.deepEqual(
    AGENT_NATIVE_MANIFEST.assets.map((asset) => asset.path).sort(),
    descriptors.map((asset) => asset.path).sort(),
  );
});

test('an hm2b.compiled-workflow/v1 document is rejected before any file is produced', () => {
  const compiledWorkflow = { ...miniCompiledWorkflow(), schema: 'hm2b.compiled-workflow/v1' };
  const result = runProject({ compiledWorkflow, compiledWorkflowDigest: 'a'.repeat(64), raw: { targets: ['claude-code'] } });
  assert.equal(result.ok, false);
  assert.equal(result.files, undefined);
  assert.deepEqual(result.errors, [{
    severity: 'error',
    code: 'PROJECTION_COMPILED_WORKFLOW_UNSUPPORTED',
    path: '',
    pointer: null,
    message: 'unsupported compiled workflow schema hm2b.compiled-workflow/v1',
  }]);
});

test('name collisions fail with PROJECTION_ID_COLLISION instead of silently renaming', () => {
  const compiledWorkflow = miniCompiledWorkflow({
    skills: {
      workflow: { description: 'Collides with the entry skill.', placeholder: false, body: '\n# workflow\n' },
    },
  });
  const result = runProject({ compiledWorkflow, compiledWorkflowDigest: 'a'.repeat(64), raw: { targets: ['claude-code'] } });
  assert.equal(result.ok, false);
  assert.equal(result.files, undefined);
  assert.ok(result.errors.some((error) => error.code === 'PROJECTION_ID_COLLISION'));
  for (const error of result.errors) {
    assert.equal(error.severity, 'error');
    assert.equal(error.path, '');
    assert.equal(typeof error.message, 'string');
  }
});

test('over-long rendered names fail instead of being truncated', () => {
  const roleId = `worker-${'x'.repeat(70)}`;
  const compiledWorkflow = miniCompiledWorkflow({ id: `bundle-${'y'.repeat(20)}`, roleId });
  const result = runProject({ compiledWorkflow, compiledWorkflowDigest: 'a'.repeat(64), raw: { targets: ['claude-code'] } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'PROJECTION_NAME_TOO_LONG'));
});
