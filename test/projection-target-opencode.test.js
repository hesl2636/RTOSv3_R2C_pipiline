/**
 * agent-native target: opencode (#98, decisions #71 §10, #72 §5).
 *
 * opencode V1 reads `.opencode/agents/<name>.md` (file name = agent name) and
 * shares `.agents/skills` with the other non-Claude targets. The descriptor
 * owns the Markdown shell and the permission mapping; the shared driver owns
 * naming, exposure, placeholders and field accounting.
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
import { normalizeOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import { AGENT_NATIVE_MANIFEST } from '../runtime/agent-native/projection/manifest.js';
import { targetOrder } from '../runtime/agent-native/projection/targets/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const MANIFEST = getProjection('agent-native');
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
  const normalized = normalizeOptions({ projectionId: 'agent-native', ir, irDigest, raw, manifest: MANIFEST });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  return project({ projectionId: 'agent-native', ir, irDigest, options: normalized.options, environment: {}, assets: {} });
}

function opencodeSample() {
  const { ir, irDigest } = sampleIr();
  return { ir, irDigest, result: runProject({ ir, irDigest, raw: { targets: ['opencode'] } }) };
}

const source = (path, fill) => ({ path, sha256: fill.repeat(64) });

function miniIr({ id = 'mini', role = {}, skills = {} } = {}) {
  const roleId = role.id ?? 'worker';
  const roleFields = {
    description: 'Runs the miniature step.',
    instructions: '\nDo the work.\n',
    placeholder: false,
    ...role,
  };
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
    stages: [{
      id: 'one',
      name: 'One',
      steps: [{
        id: 'one',
        name: 'Step one',
        role: roleId,
        task: 'one-task',
        skills: Object.keys(skills),
        outputs: [],
        gates: [],
      }],
    }],
    roles: { [roleId]: { ...roleFields, source: source(`roles/${roleId}.md`, 'd') } },
    tasks: {
      'one-task': {
        body: '## Agent 角色设定\n\n你是执行者。\n\n## 任务\n\n执行一步。\n\n## 约束条件\n\n- 只做一步\n\n## 提交\n\n```\n{{submit}}\n```\n',
        source: source('tasks/one-task.md', 'e'),
      },
    },
    skills,
    constitution: [],
  };
}

function roleFile(result, roleId = 'worker') {
  return result.files.find((file) => file.path === `.opencode/agents/mini-${roleId}.md`);
}

function permissionLines(content) {
  const fm = content.split('---\n')[1].split('\n');
  const index = fm.indexOf('permission:');
  if (index === -1) return {};
  const out = {};
  for (let i = index + 1; i < fm.length && fm[i].startsWith('  '); i += 1) {
    const [key, value] = fm[i].trim().split(': ');
    out[key] = value;
  }
  return out;
}

function rolesJson(result) {
  return JSON.parse(result.files.find((file) => file.path.endsWith('/roles.json')).content);
}

// --- the frozen opencode file set ----------------------------------------

test('opencode-only: 45 files, 8 capability rows, V1–V12 pass', () => {
  const { ir, irDigest, result } = opencodeSample();
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['opencode']);
  assert.equal(result.files.length, 45);
  assert.equal(result.capabilityReport.length, 8);
  assert.deepEqual(result.warnings, []);
  const paths = result.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.filter((path) => path.startsWith('.opencode/agents/')).length, 4);
  assert.equal(paths.filter((path) => path.startsWith('.agents/skills/')).length, 40);
  assert.deepEqual(paths.filter((path) => path.startsWith('.agents/agent-native/')), [
    '.agents/agent-native/rtosv3-drvport/roles.json',
  ]);
  for (const path of paths) assert.match(path, /^\.(?:opencode|agents)\//);
  for (const file of result.files) assert.deepEqual(file.targets, ['opencode']);
  const kinds = new Map();
  for (const file of result.files) kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(kinds), { metadata: 1, agent: 4, skill: 35, stage: 4, workflow: 1 });
  assert.equal(result.installPlan.steps.length, result.files.length);
  assert.deepEqual(result.metadata.runtime.skillsRoots, { opencode: '.agents/skills' });
  assert.equal(result.metadata.runtime.constitutionPlacement, 'stage-skill-prefix');
  assert.equal(result.metadata.runtime.submitProtocol, 'receipt-v1');
  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});

test('the opencode capability matrix is the fixed declared order', () => {
  const { result } = opencodeSample();
  assert.deepEqual(result.capabilityReport.map((row) => row.capability), CAPABILITIES);
  const levels = Object.fromEntries(result.capabilityReport.map((row) => [row.capability, row.level]));
  assert.deepEqual(levels, {
    state: 'unavailable',
    gates: 'degraded',
    outputs: 'degraded',
    subagents: 'native',
    skills: 'adapted',
    preload: 'unavailable',
    'stage-invocation': 'native',
    'skill-invocation': 'native',
  });
});

// --- byte shell -----------------------------------------------------------

test('the rendered placeholder agent matches the prototype byte for byte', () => {
  const { result } = opencodeSample();
  const file = result.files.find((path) => path.path === '.opencode/agents/rtosv3-drvport-bys-architect.md');
  const expected = [
    '---',
    'description: 占位：分析设计阶段主控角色，正文待补；委派时机见分析设计任务书。',
    'mode: subagent',
    '---',
    '',
    '> **占位（placeholder）** 本角色由规范包声明为占位：未提供角色正文。',
    '',
    '按当前步骤的任务书执行；不要臆测本角色未声明的专有职责。',
    '',
    '<!-- r2c:placeholder role=bys-architect -->',
    '',
  ].join('\n');
  assert.equal(file.content, expected);
  assert.equal(sha256Hex(file.content), 'c1d042c68f52f409795e4789f10463f8f38a68dd1d289d85b5c138e0ae483ac2');
});

test('mode maps to opencode semantics: subagent/all/primary with matching exposure', () => {
  const cases = [
    { mode: 'subagent', literal: 'subagent', exposure: 'subagent' },
    { mode: 'any', literal: 'all', exposure: 'both' },
    { mode: 'primary', literal: 'primary', exposure: 'primary' },
  ];
  for (const item of cases) {
    const ir = miniIr({ role: { mode: item.mode } });
    const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
    assert.equal(result.ok, true, item.mode);
    const file = roleFile(result);
    assert.match(file.content, new RegExp(`^---\\ndescription: [^\\n]+\\nmode: ${item.literal}\\n---\\n`));
    const roles = rolesJson(result).targets.opencode.roles.find((role) => role.id === 'worker');
    assert.equal(roles.exposure, item.exposure);
    assert.equal(roles.fields.mode.state, 'native');
  }
  // The IR default is subagent; opencode's own default is all, so the
  // renderer writes it explicitly instead of relying on the runtime default.
  const implicit = runProject({ ir: miniIr(), irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
  assert.match(roleFile(implicit).content, /^---\ndescription: [^\n]+\nmode: subagent\n---\n/);
  assert.equal(rolesJson(implicit).targets.opencode.roles[0].exposure, 'subagent');
  assert.equal(rolesJson(implicit).targets.opencode.roles[0].fields.mode, undefined);
});

// --- tools: allow-list, deny-only and the write/edit collision -----------

test('tools map to opencode permission literals; web splits and write shares edit', () => {
  const ir = miniIr({ role: { tools: ['read', 'write', 'edit', 'glob', 'bash', 'task', 'web'], tools_deny: ['bash'] } });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
  const content = roleFile(result).content;
  assert.deepEqual(permissionLines(content), {
    read: 'allow',
    edit: 'allow',
    glob: 'allow',
    grep: 'deny',
    bash: 'deny',
    task: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
  });
  assert.doesNotMatch(content, /^ {2}write:/m);
  const fields = rolesJson(result).targets.opencode.roles[0].fields;
  assert.equal(fields.tools.state, 'adapted');
  assert.equal(fields.tools_deny.state, 'adapted');
  assert.equal(result.degradations.filter((record) => record.field === 'tools' || record.field === 'tools_deny').length, 0);
});

test('tools: [] denies every opencode permission key', () => {
  const ir = miniIr({ role: { tools: [] } });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
  assert.deepEqual(permissionLines(roleFile(result).content), {
    read: 'deny',
    edit: 'deny',
    glob: 'deny',
    grep: 'deny',
    bash: 'deny',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
  });
  assert.equal(rolesJson(result).targets.opencode.roles[0].fields.tools.state, 'adapted');
});

test('tools_deny alone writes deny rules and keeps web as two literals', () => {
  const ir = miniIr({ role: { tools_deny: ['web', 'task'] } });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
  assert.deepEqual(permissionLines(roleFile(result).content), {
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
  });
  assert.equal(rolesJson(result).targets.opencode.roles[0].fields.tools_deny.state, 'adapted');
});

test('an unexpressible write-only deny degrades with the exact field and pointer', () => {
  const ir = miniIr({ role: { tools_deny: ['write'] } });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
  assert.deepEqual(permissionLines(roleFile(result).content), { edit: 'deny' });
  const role = rolesJson(result).targets.opencode.roles[0];
  assert.equal(role.fields.tools_deny.state, 'degraded');
  assert.match(role.fields.tools_deny.reason, /write/);
  assert.equal(typeof role.fields.tools_deny.effect, 'string');
  const record = result.degradations.find((item) => item.field === 'tools_deny');
  assert.ok(record);
  assert.equal(record.code, 'CAP_ROLE_FIELD_DEGRADED');
  assert.equal(record.target, 'opencode');
  assert.equal(record.capability, 'subagents');
  assert.equal(record.pointer, '/roles/worker');
  assert.equal(record.level, 'degraded');
});

test('an allow-list that keeps edit but drops write is degraded, never silently widened', () => {
  const ir = miniIr({ role: { tools: ['read', 'edit'] } });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
  assert.deepEqual(permissionLines(roleFile(result).content), {
    read: 'allow',
    edit: 'deny',
    glob: 'deny',
    grep: 'deny',
    bash: 'deny',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
  });
  const fields = rolesJson(result).targets.opencode.roles[0].fields;
  assert.equal(fields.tools.state, 'degraded');
  assert.match(fields.tools.reason, /write/);
  assert.ok(result.degradations.some((item) => item.field === 'tools' && item.pointer === '/roles/worker'));
});

// --- preload has no seam --------------------------------------------------

test('preload is unavailable and degraded per role use point', () => {
  const skills = {
    helper: {
      description: 'Helps.',
      placeholder: false,
      body: '\n# Helper\n',
      source: source('skills/helper/SKILL.md', 'f'),
    },
  };
  const ir = miniIr({ role: { skills: ['helper'] }, skills });
  const result = runProject({ ir, irDigest: 'a'.repeat(64), raw: { targets: ['opencode'] } });
  assert.equal(result.ok, true);
  const records = result.degradations.filter((record) => record.code === 'CAP_PRELOAD_UNAVAILABLE');
  assert.equal(records.length, 1);
  assert.deepEqual(
    { target: records[0].target, capability: records[0].capability, level: records[0].level, pointer: records[0].pointer, field: records[0].field },
    { target: 'opencode', capability: 'preload', level: 'unavailable', pointer: '/roles/worker/skills/0', field: 'skills' },
  );
  const row = result.capabilityReport.find((item) => item.capability === 'preload');
  assert.equal(row.level, 'unavailable');
  assert.deepEqual(row.uses, ['/roles/worker/skills/0']);
  const role = rolesJson(result).targets.opencode.roles[0];
  assert.equal(role.fields.skills.state, 'unavailable');
  assert.doesNotMatch(roleFile(result).content, /helper/);
});

// --- roles.json, idMap and visibility ------------------------------------

test('roles.json has one opencode section consistent with idMap and artifacts', () => {
  const { ir, irDigest, result } = opencodeSample();
  const roles = rolesJson(result);
  assert.equal(roles.schema, 'r2c.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets), ['opencode']);
  assert.equal(roles.ir.sha256, irDigest);
  const section = roles.targets.opencode;
  assert.equal(section.namespace, 'rtosv3-drvport');
  assert.deepEqual(section.roles.map((role) => role.id), Object.keys(ir.roles).sort());
  for (const role of section.roles) {
    assert.equal(role.name, result.metadata.idMap.opencode.roles[role.id]);
    assert.equal(role.placeholder, ir.roles[role.id].placeholder);
    assert.equal(role.artifact.path, `.opencode/agents/${role.name}.md`);
    const file = result.files.find((item) => item.path === role.artifact.path);
    assert.equal(role.artifact.sha256, sha256Hex(file.content));
    assert.equal(role.artifact.format, 'md');
    assert.equal(role.fields.id.state, 'adapted');
    assert.equal(role.fields.description.state, 'native');
    assert.equal(role.fields.instructions.state, 'native');
    assert.equal(role.fields.mode.state, 'native');
    assert.equal(role.fields.model.state, 'degraded');
    assert.equal(role.fields.title.state, 'unavailable');
    assert.equal(role.fields.placeholder.state, 'adapted');
    for (const [field, state] of Object.entries(role.fields)) {
      if (state.state !== 'degraded' && state.state !== 'unavailable') continue;
      const record = result.degradations.find((item) => item.target === 'opencode'
        && item.pointer === `/roles/${role.id}` && item.field === field && item.level === state.state);
      assert.ok(record, `${role.id}/${field}`);
    }
  }
  const summary = { roles: section.roles.length, native: 0, adapted: 0, degraded: 0, unavailable: 0 };
  for (const role of section.roles) for (const state of Object.values(role.fields)) summary[state.state] += 1;
  assert.deepEqual(section.summary, summary);
  assert.equal(result.metadata.placeholders.roles.length, 4);
  assert.equal(result.metadata.placeholders.constitution, 'placeholder');
});

test('placeholder banners and the {{submit}} receipt stay identical to Claude', () => {
  const { ir, irDigest } = sampleIr();
  const opencode = runProject({ ir, irDigest, raw: { targets: ['opencode'] } });
  const claude = runProject({ ir, irDigest, raw: { targets: ['claude-code'] } });
  const byName = (result, name) => result.files.find((file) => file.path.endsWith(`/${name}/SKILL.md`)).content;
  for (const name of ['rtosv3-drvport-stage-analysis-design', 'rtosv3-drvport-workflow', 'rtosv3-drvport-skill-ar-miner']) {
    assert.equal(byName(opencode, name), byName(claude, name), name);
  }
  for (const file of opencode.files.filter((item) => item.kind === 'stage')) {
    assert.match(file.content, /^---\n[\s\S]*?\n---\n\n<!-- constitution:begin scope=global placeholder=true -->\n/);
  }
  assert.equal(opencode.files.find((file) => file.kind === 'workflow').content.includes('constitution:begin'), false);
  for (const file of opencode.files) assert.equal(file.content.includes('{{submit}}'), false, file.path);
  const body = (content) => content.slice(content.indexOf('\n---\n') + 5);
  const claudeRole = claude.files.find((file) => file.path === '.claude/agents/rtosv3-drvport-bys-architect.md');
  const opencodeRole = opencode.files.find((file) => file.path === '.opencode/agents/rtosv3-drvport-bys-architect.md');
  assert.equal(body(opencodeRole.content), body(claudeRole.content));
});

// --- determinism, registry and V1–V12 -------------------------------------

test('the same input twice yields byte-identical opencode results', () => {
  const first = opencodeSample().result;
  const second = runProject({ ...sampleIr(), raw: { targets: ['opencode'] } });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(second.files.map((file) => [file.path, file.content]), first.files.map((file) => [file.path, file.content]));
});

test('projection.json is canonical and carries the opencode capability row', () => {
  const path = join(ROOT, 'runtime/agent-native/projection/projection.json');
  assert.equal(readFileSync(path, 'utf8'), canonicalJson(AGENT_NATIVE_MANIFEST));
  assert.deepEqual(AGENT_NATIVE_MANIFEST.targets.map((target) => target.id), targetOrder());
  assert.ok(AGENT_NATIVE_MANIFEST.targets.some((target) => target.id === 'opencode'));
  const target = AGENT_NATIVE_MANIFEST.targets.find((item) => item.id === 'opencode');
  assert.equal(target.name, 'opencode (V1)');
  assert.equal(target.default, true);
  assert.deepEqual(Object.keys(target.capabilities), CAPABILITIES);
  assert.equal(target.capabilities.preload.level, 'unavailable');
  assert.equal(target.capabilities.subagents.level, 'native');
  assert.equal(target.capabilities.skills.level, 'adapted');
  for (const root of ['.agents/skills', '.opencode/agents']) {
    assert.ok(AGENT_NATIVE_MANIFEST.writeRoots.includes(root), root);
  }
});

test('claude + opencode share skills and warn once about the mirrored roots', () => {
  const { ir, irDigest } = sampleIr();
  const result = runProject({ ir, irDigest, raw: { targets: ['claude-code', 'opencode'] } });
  assert.equal(result.ok, true);
  const shared = result.files.filter((file) => file.path.startsWith('.agents/skills/'));
  for (const file of shared) assert.deepEqual(file.targets, ['opencode']);
  assert.ok(result.files.some((file) => file.path === '.claude/agents/rtosv3-drvport-bys-architect.md'));
  assert.ok(result.files.some((file) => file.path === '.opencode/agents/rtosv3-drvport-bys-architect.md'));
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['SKILL_MIRRORED_ROOTS']);
  assert.equal(result.warnings[0].target, 'opencode');
  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));
});
