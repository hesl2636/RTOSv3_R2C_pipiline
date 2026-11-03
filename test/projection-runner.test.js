/**
 * runner projection: compiled workflow -> five project-root payload roots (#93, #70, spec §9).
 *
 * The sample bundle compiles to the frozen compiled workflow. Projecting it for `runner` must
 * produce the closed 45-file set, four role degradations, the eight static
 * capability rows and a result that passes V1–V12 twice byte-identically.
 * Workflow/task/skill/constitution bytes match the prototype oracle; role
 * copies are the normalised compiled workflow copy with the host-visible `agent:` header.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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
import { RUNNER_MANIFEST } from '../runtime/runner/projection/manifest.js';
import {
  ASSET_CHECKLISTS,
  ASSET_HOOKS,
  ASSET_KNOWLEDGE_BASE,
  ASSET_MCP,
  assetZip,
} from './helpers/minimal-bundle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const ASSEMBLER = join(ROOT, 'bin', 'hm2b-assembler.js');
const ENGINE = join(ROOT, 'runtime', 'runner', 'engine', 'bin', 'hm2b.js');
const MANIFEST = getProjection('runner');
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

function runProject({ compiledWorkflow, compiledWorkflowDigest, raw, environment = {} }) {
  const normalized = normalizeOptions({ projectionId: 'runner', compiledWorkflow, compiledWorkflowDigest, raw, manifest: MANIFEST });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  return project({
    projectionId: 'runner',
    compiledWorkflow,
    compiledWorkflowDigest,
    options: normalized.options,
    environment,
    assets: {},
  });
}

function sampleResult() {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  return { compiledWorkflow, compiledWorkflowDigest, result: runProject({ compiledWorkflow, compiledWorkflowDigest, raw: null }) };
}

const SOURCE = (path, fill) => ({ path, sha256: fill.repeat(64) });
const TASK_BODY = (label) => [
  '## Agent 角色设定', '', `你是${label}。`, '',
  '## 任务', '', '做一件事。', '',
  '## 约束条件', '', '- 只做一件事', '',
  '## 提交', '', '```', '{{submit}}', '```', '',
].join('\n');

function miniCompiledWorkflow({
  id = 'mini',
  stages,
  roles,
  tasks,
  skills = {},
  constitution = [],
  requires,
} = {}) {
  const defaultRole = {
    description: 'Runs the miniature step.',
    title: 'Worker',
    mode: 'subagent',
    model: 'strong',
    placeholder: false,
    instructions: '\nDo the work.\n',
    source: SOURCE('roles/worker.md', 'd'),
  };
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
    ...(requires === undefined ? {} : { requires }),
    stages: stages ?? [{
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
    roles: roles ?? { worker: defaultRole },
    tasks: tasks ?? {
      'one-task': { body: TASK_BODY('执行者'), source: SOURCE('tasks/one-task.md', 'e') },
    },
    skills,
    constitution,
  };
}

function fileByPath(result, path) {
  const file = result.files.find((item) => item.path === path);
  assert.ok(file, path);
  return file;
}

// --- the frozen baseline --------------------------------------------------

test('baseline: 45 files, 4 degradations, 8 capability rows, V1–V12 pass', () => {
  const { compiledWorkflow, compiledWorkflowDigest, result } = sampleResult();
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.schema, 'hm2b.projection-result/v1');
  assert.deepEqual(result.targets, ['runner']);
  assert.equal(result.files.length, 45);
  assert.equal(result.degradations.length, 4);
  assert.equal(result.capabilityReport.length, 8);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.options.stageOrder, ['analysis-design', 'detailed-design', 'implementation', 'verification']);
  assert.equal(result.options.skills.length, 35);
  assert.deepEqual(result.options.targets, ['runner']);
  assert.equal(result.metadata.runtime.runnerCommand, 'node .hm2b/bin/hm2b.js');
  assert.equal(result.metadata.runtime.constitution, 'inline-prefix');

  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: result.options, manifest: MANIFEST, environment: {} });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('declared bundle assets project verbatim at the project root', () => {
  const compiled = compileBundle(new Uint8Array(assetZip()), { inflateRaw, sha256: sha256Hex });
  assert.equal(compiled.ok, true);
  const compiledWorkflow = JSON.parse(new TextDecoder().decode(compiled.compiledWorkflowBytes));
  const compiledWorkflowDigest = compiled.digest;
  const result = runProject({ compiledWorkflow, compiledWorkflowDigest, raw: null });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  const assets = result.files.filter((file) => ['knowledge', 'checklist', 'hooks', 'mcp'].includes(file.kind));
  assert.deepEqual(assets.map((file) => [file.kind, file.path]), [
    ['checklist', 'checklists/design.md'],
    ['checklist', 'checklists/impl.md'],
    ['hooks', 'hooks/hooks.json'],
    ['knowledge', 'knowledge-base/coding-standards/cleancode/rules.md'],
    ['knowledge', 'knowledge-base/os-api-mapping/freertos.md'],
    ['mcp', 'mcp.json'],
  ]);
  for (const file of assets) {
    assert.deepEqual(file.targets, ['runner']);
    assert.equal(file.origin, 'generated');
    assert.equal(file.mode, 0o644);
  }
  assert.equal(
    fileByPath(result, 'knowledge-base/os-api-mapping/freertos.md').content,
    ASSET_KNOWLEDGE_BASE.get('knowledge-base/os-api-mapping/freertos.md'),
  );
  assert.equal(
    fileByPath(result, 'knowledge-base/coding-standards/cleancode/rules.md').content,
    ASSET_KNOWLEDGE_BASE.get('knowledge-base/coding-standards/cleancode/rules.md'),
  );
  for (const [id, body] of ASSET_CHECKLISTS) {
    assert.equal(fileByPath(result, `checklists/${id}.md`).content, body);
  }
  assert.equal(fileByPath(result, 'hooks/hooks.json').content, canonicalJson(ASSET_HOOKS));
  assert.equal(fileByPath(result, 'mcp.json').content, canonicalJson(ASSET_MCP));

  assert.equal(result.metadata.artifacts['knowledge-os-api-mapping-freertos'], 'knowledge-base/os-api-mapping/freertos.md');
  assert.equal(result.metadata.artifacts['knowledge-coding-standards-cleancode-rules'], 'knowledge-base/coding-standards/cleancode/rules.md');
  assert.equal(result.metadata.artifacts['checklist-design'], 'checklists/design.md');
  assert.equal(result.metadata.artifacts['checklist-impl'], 'checklists/impl.md');
  assert.equal(result.metadata.artifacts.hooks, 'hooks/hooks.json');
  assert.equal(result.metadata.artifacts.mcp, 'mcp.json');

  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: result.options, manifest: MANIFEST, environment: {} });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));

  const again = runProject({ compiledWorkflow, compiledWorkflowDigest, raw: null });
  assert.equal(JSON.stringify(again), JSON.stringify(result));

  // No user-owned configuration file or engine path is ever projected.
  for (const file of result.files) {
    assert.doesNotMatch(file.path, /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.mcp\.json)(?:\/|$)/);
  }
});

test('the sample file set stays on the five payload roots', () => {
  const { result } = sampleResult();
  const paths = result.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  const kinds = new Map();
  for (const file of result.files) kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(kinds), {
    workflow: 1, task: 4, skill: 35, role: 4, constitution: 1,
  });
  for (const path of paths) {
    assert.match(path, /^(?:constitution|roles|skills|tasks|workflows)\//);
  }
  assert.equal(paths.filter((path) => path.endsWith('/SKILL.md')).length, 35);
  assert.equal(paths.some((path) => /(?:^|\/)(?:commands|adapters|schema|shims|hm2b-payload\.json|workflow\.compiled\.json|bundle\.json)(?:\/|$)/.test(path)), false);
  assert.equal(result.installPlan.steps.length, result.files.length);
  assert.deepEqual(result.installPlan.steps.map((step) => step.path), paths);
  for (const step of result.installPlan.steps) {
    assert.equal(step.op, 'write');
    assert.equal(step.overwrite, 'replace');
  }
});

test('generated workflow, task, skill and constitution bytes match the prototype oracle', () => {
  const { result } = sampleResult();
  const hashes = {
    'workflows/rtosv3-drvport.yaml': '4210e7dc3b93b2660fb3868f501aa3a434d161bc23b234cc40520c1856ae3209',
    'tasks/analysis-design-orchestration.md': '85fb537bb05d3091e5afbc032b3f8f4658a6c3b95fc619a082e3c33ad8a97622',
    'skills/ar-miner/SKILL.md': 'fab07d93cfcc1a9b63ec87817988264b438d0d3c9f299702c00f11b840bca91f',
    'constitution/CONSTITUTION.md': 'c811548708ff4b8cb8556ecbd0be2a3da6dbc5fdbd223fd2b4d3520bcb4648cd',
  };
  for (const [path, hash] of Object.entries(hashes)) {
    assert.equal(sha256(fileByPath(result, path).content), hash, path);
  }
});

test('workflow YAML is schema-ordered, quoted, 2-space, LF and omits empty collections', () => {
  const { result } = sampleResult();
  const yaml = fileByPath(result, 'workflows/rtosv3-drvport.yaml').content;
  assert.ok(yaml.startsWith('schema: "hm2b.workflow/v1"\nid: "rtosv3-drvport"\nname: '));
  assert.ok(yaml.endsWith('\n'));
  assert.equal(yaml.includes('\r'), false);
  assert.ok(yaml.includes('        type: "prompt"\n        agent: "runner-bys-architect"\n        taskFile: "tasks/analysis-design-orchestration.md"\n        skills:\n          - "ar-miner"\n'));
  for (const forbidden of ['timeout:', 'skill:', 'prompt:', 'mcp:', 'subagent:', 'input:']) {
    const key = `\n${forbidden.endsWith(':') ? forbidden : `${forbidden}:`}`;
    assert.equal(yaml.includes(key), false, forbidden);
  }

  const doc = parseYaml(yaml);
  assert.deepEqual(Object.keys(doc), ['schema', 'id', 'name', 'version', 'description', 'stages']);
  assert.deepEqual(doc.stages.map((stage) => Object.keys(stage)), [
    ['id', 'name', 'steps'], ['id', 'name', 'steps'], ['id', 'name', 'steps'], ['id', 'name', 'steps'],
  ]);
  const step = doc.stages[0].steps[0];
  assert.deepEqual(Object.keys(step), ['id', 'name', 'type', 'agent', 'taskFile', 'skills']);
  assert.equal(step.type, 'prompt');
  assert.equal(step.agent, 'runner-bys-architect');
  for (const stage of doc.stages) {
    for (const item of stage.steps) {
      assert.equal(item.agent, `runner-${sampleCompiledWorkflow().compiledWorkflow.stages.flatMap((entry) => entry.steps).find((entry) => entry.id === item.id).role}`);
      assert.equal(item.skill, undefined);
      assert.equal(item.timeout, undefined);
    }
  }
});

test('gates and outputs map verbatim; an explicit timeout is kept', () => {
  const compiledWorkflow = miniCompiledWorkflow();
  compiledWorkflow.stages[0].steps[0].gates = [
    { command: 'node --test', timeout: 30 },
    { command: 'node tools/check.mjs' },
  ];
  compiledWorkflow.stages[0].steps[0].outputs = ['reports/*.md'];
  compiledWorkflow.stages[0].steps[0].skills = [];
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)) }) };
  assert.equal(result.ok, true);
  const yaml = fileByPath(result, 'workflows/mini.yaml').content;
  assert.ok(yaml.includes('        expect:\n          outputs:\n            - "reports/*.md"\n        gate:\n          - command: "node --test"\n            timeout: 30\n          - command: "node tools/check.mjs"\n'));
  const doc = parseYaml(yaml);
  assert.deepEqual(doc.stages[0].steps[0].gate, [
    { command: 'node --test', timeout: 30 },
    { command: 'node tools/check.mjs' },
  ]);
});

// --- {{submit}} -----------------------------------------------------------

test('{{submit}} derivation: 1 reference pins --step, 0 or 2 use the generic command', () => {
  const compiledWorkflow = miniCompiledWorkflow({
    stages: [{
      id: 's',
      name: 'S',
      steps: [
        { id: 'first', name: 'First', role: 'worker', task: 'used-once', skills: [], outputs: [], gates: [] },
        { id: 'second', name: 'Second', role: 'worker', task: 'shared', skills: [], outputs: [], gates: [] },
        { id: 'third', name: 'Third', task: 'shared', skills: [], outputs: [], gates: [] },
      ],
    }],
    tasks: {
      'used-once': { body: TASK_BODY('一次'), source: SOURCE('tasks/used-once.md', '1') },
      shared: { body: TASK_BODY('共享'), source: SOURCE('tasks/shared.md', '2') },
      unused: { body: TASK_BODY('未用'), source: SOURCE('tasks/unused.md', '3') },
    },
  });
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)) }) };
  assert.equal(result.ok, true);
  const once = fileByPath(result, 'tasks/used-once.md').content;
  const shared = fileByPath(result, 'tasks/shared.md').content;
  const unused = fileByPath(result, 'tasks/unused.md').content;
  assert.ok(once.includes('node .hm2b/bin/hm2b.js submit --step first\n'));
  assert.equal((once.match(/node \.hm2b\/bin\/hm2b\.js submit/g) ?? []).length, 1);
  assert.ok(shared.includes('node .hm2b/bin/hm2b.js submit\n'));
  assert.equal(shared.includes('--step'), false);
  assert.ok(unused.includes('node .hm2b/bin/hm2b.js submit\n'));
  assert.equal(result.files.filter((file) => file.content.includes('{{submit}}')).length, 0);
  assert.equal(once.includes('--session-id'), false);
  assert.equal(once.includes(ROOT), false);
  const warnings = result.warnings.filter((warning) => warning.code === 'RUNNER_SUBMIT_STEP_GENERIC');
  assert.deepEqual(warnings.map((warning) => warning.pointer).sort(), ['/tasks/shared', '/tasks/unused']);
});

test('a task without exactly one {{submit}} token fails without files', () => {
  const compiledWorkflow = miniCompiledWorkflow({
    tasks: {
      'one-task': { body: '## 提交\n\n没有 token。\n', source: SOURCE('tasks/one-task.md', 'e') },
    },
  });
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)) }) };
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{
    severity: 'error',
    code: 'PROJECTION_SUBMIT_TOKEN_COUNT',
    path: '',
    pointer: '/tasks/one-task/body',
    message: 'task one-task body must contain exactly one {{submit}} token',
  }]);
  assert.equal(result.files, undefined);
});

// --- skills / roles / constitution ---------------------------------------

test('skill copies rebuild frontmatter, always write placeholder and keep the body verbatim', () => {
  const body = '\n# helper\n\nDo it.\n';
  const compiledWorkflow = miniCompiledWorkflow({
    skills: {
      helper: { description: 'Helper skill.', placeholder: false, body, source: SOURCE('skills/helper/SKILL.md', 'f') },
      other: { description: 'Other skill.', placeholder: true, body, source: SOURCE('skills/other/SKILL.md', 'a') },
    },
  });
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)) }) };
  assert.equal(result.ok, true);
  assert.equal(
    fileByPath(result, 'skills/helper/SKILL.md').content,
    `---\nname: "helper"\ndescription: "Helper skill."\nplaceholder: false\n---\n${body}`,
  );
  assert.equal(
    fileByPath(result, 'skills/other/SKILL.md').content,
    `---\nname: "other"\ndescription: "Other skill."\nplaceholder: true\n---\n${body}`,
  );
});

test('a skill subset drops copies, keeps step references and records option losses', () => {
  const compiledWorkflow = miniCompiledWorkflow({
    skills: {
      helper: { description: 'Helper skill.', placeholder: false, body: '\n# helper\n', source: SOURCE('skills/helper/SKILL.md', 'f') },
      other: { description: 'Other skill.', placeholder: false, body: '\n# other\n', source: SOURCE('skills/other/SKILL.md', 'a') },
    },
  });
  compiledWorkflow.roles.worker.skills = ['helper', 'other'];
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)), raw: { skills: ['helper'] } }) };
  assert.equal(result.ok, true);
  assert.deepEqual(result.options.skills, ['helper']);
  assert.equal(result.files.some((file) => file.path === 'skills/other/SKILL.md'), false);
  const excluded = result.degradations.find((record) => record.code === 'RUNNER_SKILL_EXCLUDED' && record.pointer === '/skills/other');
  assert.equal(excluded.capability, 'skills');
  assert.equal(excluded.level, 'unavailable');
  assert.equal(result.capabilityReport.find((row) => row.capability === 'skills').level, 'unavailable');
  // runner has no preload seam: an excluded role skill produces no preload record
  // (the loss is the excluded skill itself); selected refs keep the declared one.
  assert.equal(result.degradations.some((record) => record.capability === 'preload' && record.pointer === '/roles/worker/skills/1'), false);
  const preload = result.degradations.filter((record) => record.capability === 'preload');
  assert.deepEqual(preload.map((record) => record.pointer), ['/roles/worker/skills/0']);
  const preloadRow = result.capabilityReport.find((row) => row.capability === 'preload');
  assert.deepEqual(preloadRow.uses, ['/roles/worker/skills/0']);
  const yaml = fileByPath(result, 'workflows/mini.yaml').content;
  assert.ok(yaml.includes('        skills:\n          - "helper"\n          - "other"\n'));
  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)), options: result.options, manifest: MANIFEST, environment: {} });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
});

test('role copies are normalised: bare id, agent header, fixed key order, verbatim instructions', () => {
  const instructions = '\nLead the miniature step.\n';
  const role = {
    description: 'Leads the step.',
    title: 'Lead',
    mode: 'subagent',
    model: 'strong',
    effort: 'high',
    tools: ['read', 'bash'],
    tools_deny: ['web'],
    skills: ['helper'],
    placeholder: false,
    instructions,
    source: SOURCE('roles/lead.md', 'd'),
  };
  const compiledWorkflow = miniCompiledWorkflow({
    roles: { lead: role },
    skills: { helper: { description: 'Helper.', placeholder: false, body: '\n# helper\n', source: SOURCE('skills/helper/SKILL.md', 'f') } },
  });
  compiledWorkflow.stages[0].steps[0].role = 'lead';
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)) }) };
  assert.equal(result.ok, true);
  assert.equal(
    fileByPath(result, 'roles/lead.md').content,
    [
      '---',
      'id: "lead"',
      'agent: "runner-lead"',
      'description: "Leads the step."',
      'title: "Lead"',
      'mode: "subagent"',
      'model: "strong"',
      'effort: "high"',
      'tools:',
      '  - "read"',
      '  - "bash"',
      'tools_deny:',
      '  - "web"',
      'skills:',
      '  - "helper"',
      'placeholder: false',
      '---',
      instructions,
    ].join('\n'),
  );
});

test('placeholder roles use the fixed instructions and keep the agent header', () => {
  const compiledWorkflow = miniCompiledWorkflow({
    roles: {
      worker: {
        description: 'Placeholder worker.',
        placeholder: true,
        instructions: '',
        source: SOURCE('roles/worker.md', 'd'),
      },
    },
  });
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)) }) };
  assert.equal(result.ok, true);
  const content = fileByPath(result, 'roles/worker.md').content;
  assert.ok(content.startsWith('---\nid: "worker"\nagent: "runner-worker"\ndescription: "Placeholder worker."\nplaceholder: true\n---\n'));
  assert.ok(content.includes('> **占位（placeholder）** 本角色由规范包声明为占位：未提供角色正文。\n\n按当前步骤的任务书执行；不要臆测本角色未声明的专有职责。\n\n<!-- hm2b:placeholder role=worker -->\n'));
});

test('constitution is the injection block and its state is trinary', () => {
  const absent = miniCompiledWorkflow();
  const absentResult = runProject({ compiledWorkflow: absent, compiledWorkflowDigest: sha256Hex(canonicalJson(absent)) });
  assert.equal(absentResult.ok, true);
  assert.equal(absentResult.files.some((file) => file.kind === 'constitution'), false);
  assert.equal(absentResult.metadata.placeholders.constitution, 'absent');

  const placeholder = miniCompiledWorkflow({
    constitution: [{ scope: 'global', placeholder: true, body: '', source: SOURCE('constitution/CONSTITUTION.md', '0') }],
  });
  const placeholderResult = runProject({ compiledWorkflow: placeholder, compiledWorkflowDigest: sha256Hex(canonicalJson(placeholder)) });
  assert.equal(placeholderResult.ok, true);
  assert.equal(fileByPath(placeholderResult, 'constitution/CONSTITUTION.md').content, [
    '<!-- constitution:begin scope=global placeholder=true -->',
    '> **占位（placeholder）** 本宪法本期未实现：不构成生效规则；如有正文，仅为草稿，不得据此推断约束。',
    '',
    '<!-- constitution:end -->',
    '',
  ].join('\n'));
  assert.equal(placeholderResult.metadata.placeholders.constitution, 'placeholder');

  const present = miniCompiledWorkflow({
    constitution: [{ scope: 'global', placeholder: false, body: '\nRule one.\n', source: SOURCE('constitution/CONSTITUTION.md', '1') }],
  });
  const presentResult = runProject({ compiledWorkflow: present, compiledWorkflowDigest: sha256Hex(canonicalJson(present)) });
  const content = fileByPath(presentResult, 'constitution/CONSTITUTION.md').content;
  assert.ok(content.startsWith('<!-- constitution:begin scope=global placeholder=false -->\n> **项目宪法（constitution）**'));
  assert.ok(content.includes('\nRule one.\n\n<!-- constitution:end -->\n'));
  assert.equal(presentResult.metadata.placeholders.constitution, 'present');
});

// --- metadata, capabilities, engine gate ---------------------------------

test('metadata records idMap, artifacts, placeholders and runtime', () => {
  const { compiledWorkflow, result } = sampleResult();
  assert.deepEqual(result.metadata.idMap, {
    runner: {
      stages: {},
      steps: {},
      roles: Object.fromEntries(Object.keys(compiledWorkflow.roles).sort().map((id) => [id, `runner-${id}`])),
      skills: {},
    },
  });
  assert.deepEqual(result.metadata.placeholders.roles, ['bys-architect', 'bys-designer', 'bys-impl-lead', 'bys-release-lead']);
  assert.equal(result.metadata.placeholders.skills.length, 35);
  assert.equal(result.metadata.placeholders.constitution, 'placeholder');
  assert.deepEqual(result.metadata.runtime, {
    runnerCommand: 'node .hm2b/bin/hm2b.js',
    constitution: 'inline-prefix',
  });
  const artifacts = result.metadata.artifacts;
  assert.equal(artifacts.workflow, 'workflows/rtosv3-drvport.yaml');
  assert.equal(artifacts.constitution, 'constitution/CONSTITUTION.md');
  assert.equal(artifacts['task-analysis-design-orchestration'], 'tasks/analysis-design-orchestration.md');
  assert.equal(artifacts['skill-ar-miner'], 'skills/ar-miner/SKILL.md');
  assert.equal(artifacts['role-bys-architect'], 'roles/bys-architect.md');
  assert.deepEqual(Object.keys(artifacts), Object.keys(artifacts).sort());
});

test('capability report is the static runner matrix in fixed order with resolvable uses', () => {
  const { compiledWorkflow, result } = sampleResult();
  assert.deepEqual(result.capabilityReport.map((row) => row.capability), CAPABILITIES);
  const levels = Object.fromEntries(result.capabilityReport.map((row) => [row.capability, row.level]));
  assert.deepEqual(levels, {
    state: 'native',
    gates: 'native',
    outputs: 'native',
    subagents: 'degraded',
    skills: 'native',
    preload: 'unavailable',
    'stage-invocation': 'unavailable',
    'skill-invocation': 'adapted',
  });
  const subagents = result.capabilityReport.find((row) => row.capability === 'subagents');
  assert.deepEqual(subagents.uses, ['/stages/0/steps/0/role', '/stages/1/steps/0/role', '/stages/2/steps/0/role', '/stages/3/steps/0/role']);
  assert.deepEqual(result.degradations, subagents.uses.map((pointer) => ({
    code: 'RUNNER_ROLE_NOT_DISPATCHED',
    target: 'runner',
    capability: 'subagents',
    level: 'degraded',
    pointer,
    reason: 'runner prints the role name but never dispatches a subagent',
    effect: 'host may dispatch; runner does not enforce it',
  })));
  assert.deepEqual(result.capabilityReport.find((row) => row.capability === 'state').uses, ['']);
  assert.equal(result.capabilityReport.find((row) => row.capability === 'preload').uses.length, 0);
});

test('stage order options reorder coverage and still pass V1–V12', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sampleCompiledWorkflow();
  const stageOrder = compiledWorkflow.stages.map((stage) => stage.id).reverse();
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest, raw: { stageOrder } }) };
  assert.equal(result.ok, true);
  assert.deepEqual(result.coverage.stages, stageOrder);
  assert.deepEqual(result.options.stageOrder, stageOrder);
  assert.equal(result.files.length, 45);
  assert.ok(result.warnings.some((warning) => warning.code === 'STAGE_ORDER_OVERRIDDEN' && warning.pointer === '/stages'));
  const validation = validateResult(result, { compiledWorkflow, compiledWorkflowDigest, options: result.options, manifest: MANIFEST, environment: {} });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
});

test('an hm2b.compiled-workflow/v1 document is rejected before any file is produced', () => {
  const compiledWorkflow = { ...miniCompiledWorkflow(), schema: 'hm2b.compiled-workflow/v1' };
  const result = runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)), raw: null });
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

test('requires.engine is evaluated against environment.engineVersion and never enters files', () => {
  const base = miniCompiledWorkflow({ requires: { engine: '>=0.1.0 <1.0.0' } });
  const digest = sha256Hex(canonicalJson(base));
  const unknown = runProject({ compiledWorkflow: base, compiledWorkflowDigest: digest, environment: {} });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors[0].severity, 'error');
  assert.equal(unknown.errors[0].code, 'PROJECTION_ENGINE_UNKNOWN');
  assert.equal(unknown.errors[0].path, '');
  assert.equal(unknown.errors[0].pointer, null);
  assert.equal(unknown.files, undefined);

  const unsatisfied = runProject({ compiledWorkflow: base, compiledWorkflowDigest: digest, environment: { engineVersion: '2.0.0' } });
  assert.equal(unsatisfied.ok, false);
  assert.equal(unsatisfied.errors[0].severity, 'error');
  assert.equal(unsatisfied.errors[0].code, 'PROJECTION_ENGINE_UNSATISFIED');
  assert.equal(unsatisfied.errors[0].path, '');
  assert.equal(unsatisfied.errors[0].pointer, null);
  assert.ok(unsatisfied.errors[0].message.includes('2.0.0'));

  const satisfied = runProject({ compiledWorkflow: base, compiledWorkflowDigest: digest, environment: { engineVersion: '0.1.0' } });
  assert.equal(satisfied.ok, true);
  for (const file of satisfied.files) assert.equal(file.content.includes('0.1.0'), false, file.path);
});

test('requires.projections is the caller whitelist and is not evaluated in the projection', () => {
  const compiledWorkflow = miniCompiledWorkflow({ requires: { projections: ['agent-native'] } });
  const { result } = { result: runProject({ compiledWorkflow, compiledWorkflowDigest: sha256Hex(canonicalJson(compiledWorkflow)) }) };
  assert.equal(result.ok, true);
  assert.equal(result.files.some((file) => file.content.includes('agent-native')), false);
});

test('the same input twice yields byte-identical results', () => {
  const first = sampleResult().result;
  const second = sampleResult().result;
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(second.files.map((file) => [file.path, file.content]), first.files.map((file) => [file.path, file.content]));
});

// --- projection.json and CLI ---------------------------------------------

test('projection.json is exactly canonicalJson(RUNNER_MANIFEST)', () => {
  const file = readFileSync(join(ROOT, 'runtime/runner/projection/projection.json'), 'utf8');
  assert.equal(file, canonicalJson(RUNNER_MANIFEST));
  assert.deepEqual(RUNNER_MANIFEST.writeRoots, [
    'checklists', 'constitution', 'hooks', 'knowledge-base', 'mcp.json', 'roles', 'skills', 'tasks', 'workflows',
  ]);
  assert.equal(RUNNER_MANIFEST.targets.length, 1);
  assert.equal(RUNNER_MANIFEST.targets[0].id, 'runner');
  assert.deepEqual(Object.keys(RUNNER_MANIFEST.targets[0].capabilities), CAPABILITIES);
});

test('CLI projects the sample and the engine validates it with 0 errors and 0 warnings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-projection-runner-'));
  try {
    const out = join(dir, 'project');
    const projected = spawnSync(process.execPath, [
      ASSEMBLER, 'project', 'test/fixtures/compiled/workflow.compiled.json', '--projection', 'runner', '--out', out, '--json',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(projected.status, 0, projected.stderr);
    const envelope = JSON.parse(projected.stdout.trim());
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.counts.files, 45);
    assert.equal(envelope.data.counts.degradations, 4);
    assert.equal(envelope.data.counts.capabilities, 8);
    assert.equal(envelope.data.output.files, 45);

    const manifest = join(out, 'workflows', 'rtosv3-drvport.yaml');
    assert.equal(existsSync(manifest), true);
    const validated = spawnSync(process.execPath, [
      ENGINE, 'validate', '--json', '--project-root', out, '--manifest', manifest,
    ], { cwd: out, encoding: 'utf8' });
    assert.equal(validated.status, 0, validated.stderr);
    const report = JSON.parse(validated.stdout.trim());
    assert.equal(report.ok, true);
    assert.equal(report.data.stages, 4);
    assert.equal(report.data.steps, 4);
    assert.deepEqual(report.data.errors, []);
    assert.deepEqual(report.data.warnings, []);

    const walk = (current) => readdirSync(current).flatMap((name) => {
      const absolute = join(current, name);
      return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    });
    assert.equal(walk(out).length, 45);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function parseYaml(text) {
  // The engine already depends on `yaml`; using it here also proves the file
  // is accepted by the same parser without making the projection depend on it.
  const require = createRequire(import.meta.url);
  return require('yaml').parse(text);
}
