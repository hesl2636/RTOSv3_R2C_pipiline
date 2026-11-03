/**
 * Shared projection rendering primitives (#95 / CONTEXT §11, decision #73
 * §5.3, #71 §5.2/§6, #72 §4/§6).
 *
 * These are the single implementations every projection imports: role
 * rendering, the constitution block, placeholder text, the `{{submit}}`
 * replacement and the deterministic YAML writer.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { constitutionBlock, constitutionState } from '../runtime/shared/constitution.js';
import { placeholderBanner, placeholderInstructions } from '../runtime/shared/placeholder.js';
import { renderRole } from '../runtime/shared/render-role.js';
import { sha256Hex } from '../runtime/shared/sha256.js';
import {
  countSubmitTokens,
  replaceSubmitToken,
  submitReplacement,
} from '../runtime/shared/submit.js';
import { dumpWorkflowYaml } from '../runtime/shared/yaml.js';
import { claudeCodeTarget } from '../runtime/agent-native/projection/targets/claude-code.js';
import { TARGETS, getTarget } from '../runtime/agent-native/projection/targets/index.js';

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const CONSTITUTION = { scope: 'global', placeholder: false, body: 'Always answer in Chinese.\n' };

const SAMPLE_ROLE = {
  id: 'bys-architect',
  description: '占位：分析设计阶段主控角色，正文待补；委派时机见分析设计任务书。',
  title: '架构师',
  mode: 'subagent',
  model: 'strong',
  placeholder: true,
  instructions: '',
};

const FULL_ROLE = {
  id: 'bys-architect',
  description: '需要产出架构决策、接口边界与依赖取舍时委派。',
  title: '架构师',
  mode: 'subagent',
  model: 'strong',
  effort: 'high',
  tools: ['bash', 'edit', 'glob', 'grep', 'read', 'write'],
  tools_deny: ['bash'],
  skills: ['codebase-search'],
  placeholder: false,
  instructions: '\n你是 HM2B 工作流中的架构师角色。\n',
};

function ctx(skillNames = new Map()) {
  return {
    namespace: 'rtosv3-drvport',
    skillNames,
    targets: TARGETS,
    roleModels: undefined,
    roleEfforts: undefined,
    trailer: undefined,
  };
}

// --- constitution ---------------------------------------------------------

test('constitutionState distinguishes absent / present / placeholder', () => {
  assert.equal(constitutionState([]), 'absent');
  assert.equal(constitutionState(undefined), 'absent');
  assert.equal(constitutionState([{ ...CONSTITUTION }]), 'present');
  assert.equal(constitutionState([{ ...CONSTITUTION, placeholder: true }]), 'placeholder');
  assert.throws(() => constitutionState([{ ...CONSTITUTION, scope: 'stage' }]));
  assert.throws(() => constitutionState([CONSTITUTION, CONSTITUTION]));
});

test('constitutionBlock is markers + one visible line + verbatim body', () => {
  const present = constitutionBlock(CONSTITUTION);
  assert.equal(present, [
    '<!-- constitution:begin scope=global placeholder=false -->',
    '> **项目宪法（constitution）** — 项目级规则，先于本步任务书生效；与任务书冲突时以本段为准。',
    '',
    'Always answer in Chinese.',
    '',
    '<!-- constitution:end -->',
    '',
  ].join('\n'));

  const placeholder = constitutionBlock({ ...CONSTITUTION, placeholder: true, body: '' });
  assert.equal(placeholder, [
    '<!-- constitution:begin scope=global placeholder=true -->',
    '> **占位（placeholder）** 本宪法本期未实现：不构成生效规则；如有正文，仅为草稿，不得据此推断约束。',
    '',
    '<!-- constitution:end -->',
    '',
  ].join('\n'));

  const draft = constitutionBlock({ ...CONSTITUTION, placeholder: true, body: 'draft rule\n' });
  assert.match(draft, /占位（placeholder）/);
  assert.match(draft, /\ndraft rule\n/);
  assert.equal(draft.endsWith('<!-- constitution:end -->\n'), true);
});

// --- placeholders ---------------------------------------------------------

test('placeholderInstructions is the one visible role placeholder text', () => {
  const text = placeholderInstructions('bys-architect');
  assert.equal(text, [
    '> **占位（placeholder）** 本角色由规范包声明为占位：未提供角色正文。',
    '',
    '按当前步骤的任务书执行；不要臆测本角色未声明的专有职责。',
    '',
    '<!-- hm2b:placeholder role=bys-architect -->',
    '',
  ].join('\n'));
  assert.match(placeholderBanner('skill', 'ar-miner'), /占位（placeholder）/);
  assert.match(placeholderBanner('constitution', 'global'), /占位（placeholder）/);
  assert.throws(() => placeholderBanner('stage', 'x'));
});

// --- submit ---------------------------------------------------------------

test('the receipt is exactly six shell comment lines with the step marker first', () => {
  const { text, mode } = submitReplacement({ taskId: 'analysis-design', stepIds: ['analysis-design'], mode: 'receipt' });
  assert.equal(mode, 'receipt');
  const lines = text.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], '# hm2b-submit: step=analysis-design');
  assert.equal(lines[1], '# 无 runner：提交 = 在本步回复末尾输出回执，包含');
  for (const line of lines) assert.match(line, /^#/);
  assert.doesNotMatch(text, /\.hm2b\/bin\/hm2b\.js|hm2b-submit: step=\s*$/);
  assert.throws(() => submitReplacement({ taskId: 't', stepIds: [], mode: 'receipt' }));
});

test('the hm2b command form only gains --step when exactly one step references the task', () => {
  assert.deepEqual(submitReplacement({ taskId: 't', stepIds: ['only-step'] }), {
    mode: 'command',
    text: 'node .hm2b/bin/hm2b.js submit --step only-step',
  });
  assert.deepEqual(submitReplacement({ taskId: 't', stepIds: [] }), {
    mode: 'command',
    text: 'node .hm2b/bin/hm2b.js submit',
  });
  assert.deepEqual(submitReplacement({ taskId: 't', stepIds: ['a', 'b'] }), {
    mode: 'command',
    text: 'node .hm2b/bin/hm2b.js submit',
  });
});

test('the submit token is sliced literally, never through $ replacement semantics', () => {
  const body = 'before\n```\n{{submit}}\n```\nafter\n';
  const { text } = submitReplacement({ taskId: 't', stepIds: ['s'], mode: 'receipt' });
  assert.equal(countSubmitTokens(body), 1);
  const replaced = replaceSubmitToken(body, text);
  assert.equal(replaced.includes('{{submit}}'), false);
  assert.equal(replaced.includes('$&'), false);
  assert.equal(replaceSubmitToken('x {{submit}} y', '$&'), 'x $& y');
  assert.throws(() => replaceSubmitToken('no token', 'x'));
  assert.throws(() => replaceSubmitToken('{{submit}}{{submit}}', 'x'));
});

// --- renderRole -----------------------------------------------------------

test('renderRole renders the baseline Claude role byte-for-byte', () => {
  const rendered = renderRole(SAMPLE_ROLE, 'claude-code', ctx(new Map()));
  assert.equal(rendered.name, 'rtosv3-drvport-bys-architect');
  assert.equal(rendered.basename, 'rtosv3-drvport-bys-architect.md');
  assert.equal(rendered.format, 'md');
  assert.equal(rendered.exposure, 'subagent');
  assert.equal(sha256(rendered.content), '1c689ab30c3e4b4aec4f3ee8e04e244b91739b8c36922ae47f6603a43c805dc4');
  assert.deepEqual(Object.keys(rendered.fields), [
    'id', 'description', 'instructions', 'mode', 'model', 'title', 'placeholder',
  ]);
  assert.equal(rendered.fields.title.state, 'unavailable');
  assert.equal(rendered.fields.model.reason, '能力档 strong → opus');
  assert.equal(rendered.fields.mode.state, 'adapted');
});

test('renderRole maps tools, denies and preload names for Claude', () => {
  const skillNames = new Map([['codebase-search', 'codebase-search']]);
  const rendered = renderRole(FULL_ROLE, 'claude-code', ctx(skillNames));
  assert.match(rendered.content, /^---\nname: rtosv3-drvport-bys-architect\n/);
  assert.match(rendered.content, /\nmodel: opus\n/);
  assert.match(rendered.content, /\neffort: high\n/);
  assert.match(rendered.content, /\ntools:\n {2}- Read\n {2}- Write\n {2}- Edit\n {2}- Glob\n {2}- Grep\n/);
  assert.match(rendered.content, /\nskills:\n {2}- codebase-search\n/);
  assert.equal(rendered.fields.tools.state, 'adapted');
  assert.equal(rendered.fields.tools_deny.state, 'adapted');
  assert.equal(rendered.fields.skills.state, 'native');
  // Excluded preload skills never leak a rendered name.
  const filtered = renderRole(FULL_ROLE, 'claude-code', ctx(new Map()));
  assert.doesNotMatch(filtered.content, /codebase-search/);
});

test('renderRole resolves the closed registry when ctx omits a target table', () => {
  const rendered = renderRole(SAMPLE_ROLE, 'claude-code', {
    namespace: 'rtosv3-drvport',
    skillNames: new Map(),
  });
  assert.equal(rendered.name, 'rtosv3-drvport-bys-architect');
  assert.equal(sha256(rendered.content), '1c689ab30c3e4b4aec4f3ee8e04e244b91739b8c36922ae47f6603a43c805dc4');
  assert.throws(() => renderRole(SAMPLE_ROLE, 'claude-code', { namespace: 'rtosv3-drvport' }), /ctx\.skillNames/);
});

test('renderRole honours exposure and rejects unknown targets', () => {
  assert.equal(renderRole({ ...SAMPLE_ROLE, mode: 'any' }, 'claude-code', ctx()).exposure, 'both');
  assert.equal(renderRole({ ...SAMPLE_ROLE, mode: 'primary' }, 'claude-code', ctx()).exposure, 'primary');
  assert.throws(() => renderRole(SAMPLE_ROLE, 'unknown-target', ctx()), /PROJECTION_TARGET_UNKNOWN/);
  assert.equal(getTarget('claude-code'), claudeCodeTarget);
  assert.deepEqual(Object.keys(claudeCodeTarget.capabilities), [
    'state', 'gates', 'outputs', 'subagents', 'skills', 'preload',
    'stage-invocation', 'skill-invocation',
  ]);
});

// --- sha256 ---------------------------------------------------------------

test('the pure sha256 matches the Node primitive byte for byte', () => {
  const samples = ['', 'a', 'hello world', '中文 role 正文\n', 'x'.repeat(1000)];
  for (const sample of samples) {
    assert.equal(sha256Hex(sample), sha256(sample), JSON.stringify(sample.slice(0, 8)));
  }
});

// --- yaml -----------------------------------------------------------------
test('dumpWorkflowYaml is deterministic: caller order, quoted scalars, 2-space sequences', () => {
  const doc = {
    schema: 'hm2b.workflow/v1',
    id: 'demo',
    stages: [
      {
        id: 'one',
        steps: [
          { id: 'step-1', taskFile: 'tasks/step-1.md', gates: [{ command: 'node --test', timeout: 600 }] },
        ],
      },
    ],
    empty: {},
    emptyList: [],
  };
  const expected = [
    'schema: "hm2b.workflow/v1"',
    'id: "demo"',
    'stages:',
    '  - id: "one"',
    '    steps:',
    '      - id: "step-1"',
    '        taskFile: "tasks/step-1.md"',
    '        gates:',
    '          - command: "node --test"',
    '            timeout: 600',
    '',
  ].join('\n');
  assert.equal(dumpWorkflowYaml(doc), expected);
  assert.equal(dumpWorkflowYaml(doc), dumpWorkflowYaml(structuredClone(doc)));
  assert.throws(() => dumpWorkflowYaml([1]));
  assert.throws(() => dumpWorkflowYaml({ value: undefined }));
});
