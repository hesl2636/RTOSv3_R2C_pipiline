/**
 * agent-native dsh target (#99, spec §11 row 7, decisions #71 §3.2/#10.1 as
 * amended by #82, #72 §5).
 *
 * v1 fallback: dsh gets the shared `.agents/skills` tree plus one aggregate
 * role catalogue at `.dsh/agent-native/<ns>.roles.md`; no preset lines, no
 * `insert:` keys, no `allowedAgentPresets`, `subagents = unavailable`.
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
import { placeholderInstructions } from '../runtime/shared/placeholder.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const MANIFEST = getProjection('agent-native');
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const CAPABILITIES = [
  'state', 'gates', 'outputs', 'subagents', 'skills', 'preload',
  'stage-invocation', 'skill-invocation',
];
const NS = 'rtosv3-drvport';
const CATALOGUE = `.dsh/agent-native/${NS}.roles.md`;
const BANNER = [
  `# agent-native · ${NS} · dsh 角色目录`,
  '',
  '> **说明（v1 回退）** dsh 没有文件形态的角色定义，本目录不是 dsh 原生 agent preset，也不会自动生效：投影不猜 Cordis patch 的行键名与插件 id。',
  `> **用法** dsh 主会话按角色段落执行：派发任务时把该段落正文当作系统提示；角色正文与 \`.agents/agent-native/${NS}/roles.json\` 的对应记录一致。`,
].join('\n');

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
  return project({
    projectionId: 'agent-native',
    ir,
    irDigest,
    options: normalized.options,
    environment: {},
    assets: {},
  });
}

function dshSample() {
  const { ir, irDigest } = sampleIr();
  return { ir, irDigest, result: runProject({ ir, irDigest, raw: { targets: ['dsh'] } }) };
}

const source = (path, fill) => ({ path, sha256: fill.repeat(64) });

function miniIr({ roles, stages, skills = {} } = {}) {
  const roleRecord = roles ?? {
    worker: {
      description: 'Runs the miniature step.',
      mode: 'subagent',
      placeholder: false,
      instructions: '\nDo the work.\n',
      source: source('roles/worker.md', 'd'),
    },
  };
  return {
    schema: 'r2c.ir/v1',
    id: 'mini',
    name: 'Mini workflow',
    version: '1.0.0',
    description: 'A miniature workflow used by dsh projection tests.',
    source: {
      bundle: { schema: 'r2c.bundle/v1', id: 'mini', version: '1.0.0', contentSha256: 'b'.repeat(64) },
      manifest: { path: 'bundle.json', sha256: 'c'.repeat(64) },
    },
    stages: stages ?? [{
      id: 'one',
      name: 'One',
      steps: [{
        id: 'one',
        name: 'Step one',
        role: Object.keys(roleRecord)[0],
        task: 'one-task',
        skills: [],
        outputs: [],
        gates: [],
      }],
    }],
    roles: roleRecord,
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

// --- the file set ---------------------------------------------------------

test('dsh-only baseline: 42 files = 40 shared skills + role catalogue + roles.json', () => {
  const { result } = dshSample();
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, ['dsh']);
  assert.equal(result.files.length, 42);
  assert.equal(result.installPlan.steps.length, 42);

  const paths = result.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.filter((path) => path.startsWith('.agents/skills/')).length, 40);
  assert.equal(paths.filter((path) => path === CATALOGUE).length, 1);
  assert.deepEqual(paths.filter((path) => path.startsWith('.agents/agent-native/')), [
    `.agents/agent-native/${NS}/roles.json`,
  ]);
  for (const path of paths) {
    assert.match(path, /^\.(?:agents|dsh)\//);
    assert.doesNotMatch(path, /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|RULES\.md|opencode\.json|commands)(?:\/|$)/);
    assert.doesNotMatch(path, /^\.r2c\//);
  }

  const kinds = new Map();
  for (const file of result.files) kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(kinds), { metadata: 1, role: 1, skill: 35, stage: 4, workflow: 1 });
});

test('shared skills are byte-identical to the claude-code copies', () => {
  const { ir, irDigest } = sampleIr();
  const claude = runProject({ ir, irDigest, raw: { targets: ['claude-code'] } });
  const shared = runProject({ ir, irDigest, raw: { targets: ['dsh'] } });
  const byPath = new Map(claude.files.map((file) => [file.path, file.content]));
  let compared = 0;
  for (const file of shared.files.filter((item) => item.path.startsWith('.agents/skills/'))) {
    const twin = file.path.replace(/^\.agents\/skills\//, '.claude/skills/');
    assert.equal(file.content, byPath.get(twin), file.path);
    compared += 1;
  }
  assert.equal(compared, 40);
  for (const file of shared.files.filter((item) => item.path.startsWith('.agents/skills/'))) {
    assert.deepEqual(file.targets, ['dsh']);
  }
});

// --- the catalogue --------------------------------------------------------

test('the catalogue has the fixed banner and one section per role in role-id order', () => {
  const { ir, result } = dshSample();
  const file = result.files.find((item) => item.path === CATALOGUE);
  assert.equal(file.kind, 'role');
  assert.deepEqual(file.targets, ['dsh']);
  assert.equal(file.mode, 0o644);
  assert.equal(file.origin, 'generated');

  assert.ok(file.content.startsWith(`${BANNER}\n\n`), 'fixed banner');
  const roleIds = Object.keys(ir.roles).sort();
  const headings = roleIds.map((id) => `## ${NS}-${id}\n`);
  let cursor = file.content.indexOf(BANNER) + BANNER.length;
  for (const [index, roleId] of roleIds.entries()) {
    const role = ir.roles[roleId];
    const heading = file.content.indexOf(headings[index], cursor);
    assert.ok(heading > cursor, `heading order at ${roleId}`);
    const instructions = role.placeholder === true ? placeholderInstructions(roleId) : role.instructions;
    const body = file.content.indexOf(instructions, heading);
    assert.ok(body > heading, `body of ${roleId}`);
    assert.ok(file.content.includes(`- 角色 id：\`${roleId}\``), `id line of ${roleId}`);
    assert.ok(file.content.includes(`- 描述：${role.description}`), `description of ${roleId}`);
    assert.ok(file.content.includes(`- 展示名：${role.title}`), `title of ${roleId}`);
    assert.ok(file.content.includes('- 模式：subagent'), 'mode line');
    cursor = body + instructions.length;
  }
});

test('the catalogue is not a dsh preset: no patch rows, plugin ids or preset allowlists', () => {
  const { result } = dshSample();
  const content = result.files.find((item) => item.path === CATALOGUE).content;
  assert.doesNotMatch(content, /^\s*-?\s*insert:/m);
  assert.doesNotMatch(content, /allowedAgentPresets/);
  assert.doesNotMatch(content, /dsh-agent-preset|dsh-persona|dsh-tool-subagent|agent-preset/);
  assert.doesNotMatch(content, /^\s*plugin:/m);
  assert.doesNotMatch(content, /^\s*- id:/m);
  assert.equal(result.files.some((file) => file.path.endsWith('.cordis.patch.yml')), false);
});

test('role bodies stay byte-verbatim (awkward whitespace, placeholders)', () => {
  const roles = {
    gamma: {
      description: 'Third alphabetically.',
      mode: 'subagent',
      placeholder: false,
      instructions: '\nline one  \n\n\tkeep the tab\nlast line without a final newline',
      source: source('roles/gamma.md', '1'),
    },
    alpha: {
      description: 'First alphabetically.',
      mode: 'any',
      placeholder: false,
      instructions: 'Second body\n\n\nwith blank lines\n',
      source: source('roles/alpha.md', '2'),
    },
    beta: {
      description: 'A placeholder role.',
      mode: 'subagent',
      placeholder: true,
      instructions: 'ignored draft body',
      source: source('roles/beta.md', '3'),
    },
  };
  const ir = miniIr({ roles });
  const result = runProject({ ir, irDigest: 'f'.repeat(64), raw: { targets: ['dsh'] } });
  assert.equal(result.ok, true);
  const content = result.files.find((file) => file.path === '.dsh/agent-native/mini.roles.md').content;
  const sections = content.split('\n## ').slice(1);
  assert.deepEqual(sections.map((section) => section.split('\n')[0]), [
    'mini-alpha', 'mini-beta', 'mini-gamma',
  ]);
  assert.ok(content.includes(roles.alpha.instructions));
  assert.ok(content.includes(placeholderInstructions('beta')));
  assert.ok(content.includes(roles.gamma.instructions));
  assert.equal(content.includes(roles.beta.instructions), false, 'the draft placeholder body is replaced');
  for (const record of Object.entries(result.metadata.idMap?.dsh?.roles ?? {})) {
    assert.equal(record[1], `mini-${record[0]}`);
  }
});

test('R = 0 produces no catalogue but still emits roles.json', () => {
  const ir = miniIr({ roles: {} });
  const result = runProject({ ir, irDigest: 'f'.repeat(64), raw: { targets: ['dsh'] } });
  assert.equal(result.ok, true);
  assert.equal(result.files.some((file) => file.path.endsWith('.roles.md')), false);
  assert.equal(result.files.some((file) => file.path === '.dsh/agent-native/mini.roles.md'), false);
  assert.deepEqual(result.files.map((file) => file.path).filter((path) => path.startsWith('.dsh/')), []);
  const rolesJson = result.files.find((file) => file.path === '.agents/agent-native/mini/roles.json');
  assert.ok(rolesJson);
  assert.deepEqual(JSON.parse(rolesJson.content).targets.dsh.roles, []);
});

// --- roles.json and the capability surface --------------------------------

test('roles.json has a complete dsh section that points at the catalogue', () => {
  const { ir, result } = dshSample();
  const file = result.files.find((item) => item.path === `.agents/agent-native/${NS}/roles.json`);
  const roles = JSON.parse(file.content);
  assert.deepEqual(Object.keys(roles.targets), ['dsh']);
  const section = roles.targets.dsh;
  assert.equal(section.namespace, NS);
  const roleIds = Object.keys(ir.roles).sort();
  assert.deepEqual(section.roles.map((role) => role.id), roleIds);
  const catalogue = result.files.find((item) => item.path === CATALOGUE).content;
  for (const role of section.roles) {
    assert.equal(role.name, result.metadata.idMap.dsh.roles[role.id]);
    assert.equal(role.placeholder, ir.roles[role.id].placeholder);
    assert.deepEqual(role.artifact, {
      path: CATALOGUE,
      format: 'md',
      sha256: sha256(catalogue),
    });
    for (const [field, state] of Object.entries(role.fields)) {
      if (state.state !== 'degraded' && state.state !== 'unavailable') continue;
      const record = result.degradations.find((item) => item.target === 'dsh'
        && item.pointer === `/roles/${role.id}`
        && item.field === field
        && item.level === state.state);
      assert.ok(record, `${role.id}/${field}`);
    }
  }
  const summary = { roles: section.roles.length, native: 0, adapted: 0, degraded: 0, unavailable: 0 };
  for (const role of section.roles) for (const state of Object.values(role.fields)) summary[state.state] += 1;
  assert.deepEqual(section.summary, summary);
});

test('dsh capability report: subagents unavailable, every use point carries a degradation', () => {
  const { ir, result } = dshSample();
  assert.deepEqual(result.capabilityReport.map((row) => row.capability), CAPABILITIES);
  const levels = Object.fromEntries(result.capabilityReport.map((row) => [row.capability, row.level]));
  assert.deepEqual(levels, {
    state: 'unavailable',
    gates: 'degraded',
    outputs: 'degraded',
    subagents: 'unavailable',
    skills: 'adapted',
    preload: 'unavailable',
    'stage-invocation': 'native',
    'skill-invocation': 'native',
  });

  const subagents = result.capabilityReport.find((row) => row.capability === 'subagents');
  const expectedUses = ir.stages.flatMap((stage, stageIndex) => stage.steps.flatMap((step, stepIndex) => (
    step.role === undefined ? [] : [`/stages/${stageIndex}/steps/${stepIndex}/role`]
  )));
  assert.deepEqual(subagents.uses, expectedUses);
  for (const use of subagents.uses) {
    const record = result.degradations.find((item) => item.target === 'dsh'
      && item.capability === 'subagents'
      && item.pointer === use
      && item.level === 'unavailable');
    assert.ok(record, use);
    assert.equal(record.code, 'CAP_SUBAGENTS_UNAVAILABLE');
  }

  const preload = result.degradations.filter((item) => item.capability === 'preload');
  assert.deepEqual(preload, [], 'the sample roles preload no skills');

  const withPreload = miniIr({
    roles: {
      worker: {
        description: 'Preloads one skill.',
        mode: 'subagent',
        placeholder: false,
        instructions: '\nDo the work.\n',
        skills: ['helper'],
        source: source('roles/worker.md', 'd'),
      },
    },
    skills: {
      helper: {
        description: 'Helps.',
        placeholder: false,
        body: '\n# Helper\n',
        source: source('skills/helper/SKILL.md', 'a'),
      },
    },
  });
  const preloaded = runProject({ ir: withPreload, irDigest: 'f'.repeat(64), raw: { targets: ['dsh'] } });
  const records = preloaded.degradations.filter((item) => item.capability === 'preload');
  assert.equal(records.length, 1);
  assert.equal(records[0].code, 'CAP_PRELOAD_UNAVAILABLE');
  assert.equal(records[0].level, 'unavailable');
  assert.equal(records[0].pointer, '/roles/worker/skills/0');
  assert.equal(records[0].field, 'skills');
});

// --- contract checks ------------------------------------------------------

test('deterministic: the same input twice is byte-identical', () => {
  const first = dshSample().result;
  const second = runProject({ ...sampleIr(), raw: { targets: ['dsh'] } });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('V1–V12 pass and the manifest declares the dsh target', () => {
  const { ir, irDigest, result } = dshSample();
  const validation = validateResult(result, { ir, irDigest, options: result.options, manifest: MANIFEST });
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics, null, 2));

  const onDisk = readFileSync(join(ROOT, 'runtime/agent-native/projection/projection.json'), 'utf8');
  assert.equal(onDisk, canonicalJson(AGENT_NATIVE_MANIFEST));
  const dsh = MANIFEST.targets.find((target) => target.id === 'dsh');
  assert.ok(dsh);
  assert.equal(dsh.name, 'DeepSeek Harness');
  assert.equal(dsh.capabilities.subagents.level, 'unavailable');
  assert.equal(dsh.capabilities.preload.level, 'unavailable');
  assert.ok(MANIFEST.writeRoots.includes('.dsh/agent-native'));
  assert.equal(MANIFEST.writeRoots.some((root) => /\.cordis\.patch\.yml$/.test(root)), false);

  const adapter = JSON.parse(readFileSync(join(ROOT, 'adapters/dsh/adapter.json'), 'utf8'));
  assert.equal(adapter.capabilities.agents, 'none');
  assert.equal(adapter.sharedRoots.includes('.agents/skills'), true);
});
