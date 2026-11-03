/**
 * Projection options semantics (#100).
 *
 * Covers the four input classes end to end: resolved echo, compiled workflow-digest binding,
 * stage reordering, skill subsetting with its preload/capability losses, and
 * target narrowing. The sample bundle is the frozen RTOSv3 compiled workflow; the mini compiled workflow
 * adds the role skill references the sample does not carry.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileBundle } from '../assembler/compile.js';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { normalizeOptions, OPTION_CODES } from '../projection/options.js';
import { project } from '../projection/project.js';
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');

let sample;
function sampleCompiledWorkflow() {
  if (sample !== undefined) return sample;
  const compiled = compileBundle(new Uint8Array(readFileSync(ZIP)), { inflateRaw, sha256: sha256Hex });
  assert.equal(compiled.ok, true);
  sample = { compiledWorkflow: JSON.parse(new TextDecoder().decode(compiled.compiledWorkflowBytes)), compiledWorkflowDigest: compiled.digest };
  return sample;
}

function runProject({ projectionId, compiledWorkflow, compiledWorkflowDigest, raw }) {
  const manifest = getProjection(projectionId);
  const normalized = normalizeOptions({ projectionId, compiledWorkflow, compiledWorkflowDigest, raw, manifest });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  const result = project({ projectionId, compiledWorkflow, compiledWorkflowDigest, options: normalized.options, environment: {}, assets: {} });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: normalized.options, manifest, environment: {}, assets: {} });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
  return result;
}

function miniCompiledWorkflow({ model } = {}) {
  const source = (path, fill) => ({ path, sha256: fill.repeat(64) });
  return {
    schema: 'hm2b.compiled-workflow/v2',
    id: 'mini',
    name: 'Mini workflow',
    version: '1.0.0',
    description: 'A miniature workflow used by projection option tests.',
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
        skills: ['helper', 'other'],
        outputs: [],
        gates: [],
      }],
    }],
    roles: {
      worker: {
        description: 'Runs the miniature step.',
        mode: 'subagent',
        placeholder: false,
        instructions: '\nDo the work.\n',
        skills: ['helper', 'other'],
        ...(model === undefined ? {} : { model }),
        source: source('roles/worker.md', 'd'),
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
    skills: {
      helper: { description: 'Helps.', placeholder: false, body: '\n# Helper\n', source: source('skills/helper/SKILL.md', 'f') },
      other: { description: 'Other.', placeholder: false, body: '\n# Other\n', source: source('skills/other/SKILL.md', 'a') },
    },
    constitution: [],
  };
}

function file(result, path) {
  return result.files.find((item) => item.path === path);
}

// --- target subset + skill subset ----------------------------------------

test('five targets with 12 skills: 52 files, 40 capability rows, all targets lose the excluded skills', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const skills = Object.keys(compiledWorkflow.skills).sort().slice(0, 12);
  const result = runProject({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: { skills } });

  assert.deepEqual(result.options.skills, skills);
  assert.deepEqual(result.options.targets, ['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
  assert.deepEqual(result.options.stageOrder, compiledWorkflow.stages.map((stage) => stage.id));
  assert.deepEqual(result.options.extra, {});
  assert.equal(result.files.length, 52);
  assert.equal(result.files.filter((item) => item.kind === 'skill').length, 24);
  assert.equal(result.capabilityReport.length, 40);
  assert.equal(result.degradations.filter((item) => item.code === 'CAP_SKILL_EXCLUDED').length, 5 * (35 - 12));
  assert.equal(result.degradations.length, 160);
  for (const row of result.capabilityReport.filter((item) => item.capability === 'skills')) {
    assert.equal(row.level, 'unavailable');
    assert.deepEqual(row.uses, skills.map((id) => `/skills/${id}`));
  }

  const again = runProject({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: { skills } });
  assert.equal(JSON.stringify(again), JSON.stringify(result));
});

test('stage reversal keeps 98 files, only warns, and follows the overridden order', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const baseline = runProject({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: {} });
  const stages = compiledWorkflow.stages.map((stage) => stage.id).reverse();
  const result = runProject({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: { stageOrder: stages } });

  assert.equal(baseline.files.length, 98);
  assert.equal(result.files.length, 98);
  assert.deepEqual(result.options.stageOrder, stages);
  assert.deepEqual(result.coverage.stages, stages);
  assert.deepEqual(result.coverage.steps, [...stages]
    .flatMap((id) => compiledWorkflow.stages.find((stage) => stage.id === id).steps.map((step) => step.id)));
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['SKILL_MIRRORED_ROOTS', 'STAGE_ORDER_OVERRIDDEN']);
  assert.deepEqual(result.degradations, baseline.degradations);
  assert.equal(result.installPlan.steps.length, 98);
  assert.equal(result.files.length, result.installPlan.steps.length);
});

test('reversed stage order plus a 12-skill subset still yields the 52-file set', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const skills = Object.keys(compiledWorkflow.skills).sort().slice(0, 12);
  const stages = compiledWorkflow.stages.map((stage) => stage.id).reverse();
  const result = runProject({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: { stageOrder: stages, skills } });
  assert.equal(result.files.length, 52);
  assert.deepEqual(result.coverage.stages, stages);
  assert.ok(result.warnings.some((warning) => warning.code === 'STAGE_ORDER_OVERRIDDEN'));
});

test('narrow targets render only those targets and normalise to manifest order', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const result = runProject({
    projectionId: 'agent-native',
    compiledWorkflow,
    compiledWorkflowDigest,
    raw: { targets: ['opencode', 'claude-code'] },
  });
  assert.deepEqual(result.options.targets, ['claude-code', 'opencode']);
  assert.deepEqual(result.targets, ['claude-code', 'opencode']);
  for (const item of result.files) {
    assert.ok(item.targets.every((target) => result.targets.includes(target)));
  }
  assert.equal(result.files.some((item) => item.path.startsWith('.omp/')), false);
  assert.equal(result.files.some((item) => item.path.startsWith('.codex/')), false);
});

// --- preload seam losses --------------------------------------------------

test('an excluded role skill degrades preload only on targets with a seam', () => {
  const compiledWorkflow = miniCompiledWorkflow();
  const compiledWorkflowDigest = sha256Hex(canonicalJson(compiledWorkflow));
  const result = runProject({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: { skills: ['helper'] } });

  const excluded = result.degradations.filter((record) => record.code === 'CAP_PRELOAD_EXCLUDED');
  assert.deepEqual(excluded.map((record) => record.target), ['claude-code', 'omp']);
  for (const record of excluded) {
    assert.equal(record.capability, 'preload');
    assert.equal(record.level, 'unavailable');
    assert.equal(record.pointer, '/roles/worker/skills/1');
    assert.equal(record.field, 'skills');
  }
  const withoutSeam = result.degradations.filter((record) => record.capability === 'preload'
    && ['codex', 'dsh', 'opencode'].includes(record.target)
    && record.pointer === '/roles/worker/skills/1');
  assert.deepEqual(withoutSeam, []);

  for (const record of result.degradations.filter((item) => item.code === 'CAP_PRELOAD_UNAVAILABLE')) {
    assert.equal(record.pointer, '/roles/worker/skills/0');
    assert.ok(['codex', 'dsh', 'opencode'].includes(record.target));
  }
  for (const target of ['claude-code', 'omp']) {
    const row = result.capabilityReport.find((item) => item.target === target && item.capability === 'preload');
    assert.equal(row.level, 'unavailable');
    assert.deepEqual(row.uses, ['/roles/worker/skills/0']);
  }

  const claude = file(result, '.claude/agents/mini-worker.md').content;
  assert.equal(claude, [
    '---',
    'name: mini-worker',
    'description: Runs the miniature step.',
    'skills:',
    '  - mini-skill-helper',
    '---',
    '',
    'Do the work.',
    '',
  ].join('\n'));
  assert.equal(claude.includes('mini-skill-other'), false);
  const ompAgent = file(result, '.omp/agents/mini-worker.md').content;
  assert.ok(ompAgent.includes('autoloadSkills:\n  - mini-skill-helper\n'));
  assert.equal(ompAgent.includes('mini-skill-other'), false);
});

test('adapted and field-level states never worsen capability aggregation', () => {
  const compiledWorkflow = miniCompiledWorkflow({ model: 'strong' });
  const compiledWorkflowDigest = sha256Hex(canonicalJson(compiledWorkflow));
  const result = runProject({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: { targets: ['claude-code', 'codex'] } });

  const claudeModel = result.degradations.filter((record) => record.target === 'claude-code' && record.pointer === '/roles/worker');
  assert.deepEqual(claudeModel, []);
  const codexModel = result.degradations.filter((record) => record.code === 'CAP_ROLE_FIELD_DEGRADED'
    && record.target === 'codex'
    && record.pointer === '/roles/worker');
  assert.deepEqual(codexModel.map((record) => record.field), ['model']);
  assert.equal(codexModel[0].capability, 'subagents');
  for (const target of ['claude-code', 'codex']) {
    assert.equal(result.capabilityReport.find((row) => row.target === target && row.capability === 'subagents').level, 'native');
    assert.equal(result.capabilityReport.find((row) => row.target === target && row.capability === 'skills').level, 'adapted');
    assert.equal(result.degradations.some((record) => record.target === target && record.capability === 'skills'), false);
  }
  // No option exclusion: Claude (native seam) keeps preload whole; codex only
  // records its declared, static loss, which is not an option-caused one.
  assert.equal(result.degradations.some((record) => record.target === 'claude-code' && record.capability === 'preload'), false);
  assert.equal(result.degradations.some((record) => record.target === 'codex' && record.code === 'CAP_PRELOAD_EXCLUDED'), false);
  assert.equal(result.capabilityReport.find((row) => row.target === 'claude-code' && row.capability === 'preload').level, 'native');
  assert.equal(result.capabilityReport.find((row) => row.target === 'codex' && row.capability === 'preload').level, 'unavailable');
});

// --- runner ------------------------------------------------------------------

test('runner narrowing drops copies and preloads only the selected role skills', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const skills = Object.keys(compiledWorkflow.skills).sort().slice(0, 12);
  const stages = compiledWorkflow.stages.map((stage) => stage.id).reverse();
  const result = runProject({ projectionId: 'runner', compiledWorkflow, compiledWorkflowDigest, raw: { stageOrder: stages, skills } });

  assert.deepEqual(result.options.targets, ['runner']);
  assert.equal(result.files.length, 22);
  assert.equal(result.files.filter((item) => item.kind === 'skill').length, 12);
  assert.ok(result.warnings.some((warning) => warning.code === 'STAGE_ORDER_OVERRIDDEN'));
  assert.equal(result.warnings.some((warning) => warning.code === 'PROJECTION_EMPTY_TARGET'), false);
  assert.equal(result.capabilityReport.find((row) => row.capability === 'skills').level, 'unavailable');
  assert.equal(result.capabilityReport.find((row) => row.capability === 'preload').level, 'unavailable');
  const excluded = result.degradations.filter((record) => record.code === 'RUNNER_SKILL_EXCLUDED');
  assert.equal(excluded.length, 35 - 12);
});

test('runner keeps the declared preload loss only for selected role references', () => {
  const compiledWorkflow = miniCompiledWorkflow();
  const compiledWorkflowDigest = sha256Hex(canonicalJson(compiledWorkflow));
  const result = runProject({ projectionId: 'runner', compiledWorkflow, compiledWorkflowDigest, raw: { skills: ['helper'] } });
  const preload = result.degradations.filter((record) => record.capability === 'preload');
  assert.deepEqual(preload.map((record) => record.pointer), ['/roles/worker/skills/0']);
  assert.equal(preload[0].code, 'RUNNER_PRELOAD_UNAVAILABLE');
  const row = result.capabilityReport.find((item) => item.capability === 'preload');
  assert.deepEqual(row.uses, ['/roles/worker/skills/0']);
  assert.equal(file(result, 'roles/worker.md').content.includes('- "helper"'), true);
  assert.equal(file(result, 'roles/worker.md').content.includes('- "other"'), true);
});

// --- binding and rejection ------------------------------------------------

test('a stale compiled workflow binding is rejected and produces no partial result', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const manifest = getProjection('agent-native');
  const normalized = normalizeOptions({ projectionId: 'agent-native', compiledWorkflow, compiledWorkflowDigest, raw: {}, manifest });
  assert.equal(normalized.ok, true);
  const stale = project({
    projectionId: 'agent-native',
    compiledWorkflow,
    compiledWorkflowDigest: 'f'.repeat(64),
    options: normalized.options,
    environment: {},
    assets: {},
  });
  assert.equal(stale.ok, false);
  assert.deepEqual([...new Set(stale.errors.map((item) => item.code))], [OPTION_CODES.COMPILED_WORKFLOW_MISMATCH]);
  assert.equal(Object.hasOwn(stale, 'files'), false);
  assert.equal(OPTION_CODES.COMPILED_WORKFLOW_MISMATCH, 'PROJECTION_OPTIONS_COMPILED_WORKFLOW_MISMATCH');
});

test('unknown stage ids, skills, targets and extra are rejected with stable codes', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const manifest = getProjection('agent-native');
  const normalize = (raw, projectionId = 'agent-native') => normalizeOptions({
    projectionId,
    compiledWorkflow,
    compiledWorkflowDigest,
    raw,
    manifest: projectionId === 'agent-native' ? manifest : getProjection(projectionId),
  });
  const unknownStage = normalize({ stageOrder: ['nope', ...compiledWorkflow.stages.map((stage) => stage.id).slice(1)] });
  assert.equal(unknownStage.ok, false);
  assert.deepEqual(unknownStage.errors.map((item) => item.code), [OPTION_CODES.INVALID]);
  assert.equal(unknownStage.errors[0].pointer, '/stageOrder');

  const unknownSkill = normalize({ skills: ['nope'] });
  assert.deepEqual(unknownSkill.errors.map((item) => item.code), [OPTION_CODES.INVALID]);
  assert.equal(unknownSkill.errors[0].pointer, '/skills');

  const unknownTarget = normalize({ targets: ['claude-code', 'nope'] });
  assert.deepEqual(unknownTarget.errors.map((item) => item.code), [OPTION_CODES.TARGET_UNKNOWN]);

  for (const projectionId of ['agent-native', 'runner']) {
    const extra = normalize({ extra: { roleModels: {} } }, projectionId);
    assert.equal(extra.ok, false);
    assert.deepEqual(extra.errors.map((item) => item.code), [OPTION_CODES.INVALID]);
    assert.equal(extra.errors[0].pointer, '/extra/roleModels');
    const empty = normalize({ extra: {} }, projectionId);
    assert.equal(empty.ok, true);
  }
});
