/**
 * Role / skill / constitution contract (decision #67 §7.6–§7.8, §7.12 and
 * spec §2/§8).
 *
 * The report is the contract: one diagnostic per violation, the matrix code
 * and the file path (plus pointer/line where the matrix fixes them). Every
 * case goes through the public bytes-in/report-out entry point.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { validateIr } from '../assembler/validate-ir.js';
import { buildZip } from './helpers/zip.js';
import {
  MINIMAL_MANIFEST,
  MINIMAL_TASK,
  minimalFiles,
} from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };
const ROLE_PATH = 'roles/worker.md';
const SKILL_PATH = 'skills/helper/SKILL.md';
const CONSTITUTION_PATH = 'constitution/CONSTITUTION.md';
const BANNER = '> **占位（placeholder）** 本技能本期未实现。';

function report({ manifest = {}, overrides = {} } = {}) {
  const files = minimalFiles({
    'bundle.json': canonicalJson({ ...MINIMAL_MANIFEST, ...manifest }),
    ...overrides,
  });
  return validateBundle(buildZip(files), PRIMITIVES);
}

function compile({ manifest = {}, overrides = {} } = {}) {
  const files = minimalFiles({
    'bundle.json': canonicalJson({ ...MINIMAL_MANIFEST, ...manifest }),
    ...overrides,
  });
  const result = compileBundle(buildZip(files), PRIMITIVES);
  assert.equal(result.ok, true, JSON.stringify(result.report.errors));
  return result;
}

function codes(reportValue, severity = 'errors') {
  return reportValue[severity].map((diagnostic) => diagnostic.code);
}

function only(reportValue, severity = 'errors') {
  assert.equal(reportValue[severity].length, 1, JSON.stringify(reportValue[severity]));
  return reportValue[severity][0];
}

function roleFile({ id = 'worker', description = 'Executes the single step.', extra = [], body = '\nYou execute the step.\n' } = {}) {
  const lines = ['---', `id: ${id}`];
  if (description !== null) lines.push(`description: ${description}`);
  lines.push(...extra, '---', body);
  return lines.join('\n');
}

function skillFile({ name = 'helper', description = 'Helps with the single step.', extra = [], body = '\n# helper\n\nRead the task and produce the output.\n' } = {}) {
  const lines = ['---'];
  if (name !== null) lines.push(`name: ${name}`);
  if (description !== null) lines.push(`description: ${description}`);
  lines.push(...extra, '---', body);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

test('role description is required and single-line', () => {
  const missing = only(report({ overrides: { [ROLE_PATH]: roleFile({ description: null }) } }));
  assert.equal(missing.code, 'BUNDLE_FRONTMATTER_INVALID');
  assert.equal(missing.path, ROLE_PATH);
  assert.equal(missing.details.reason, 'required');

  const nested = only(report({
    overrides: { [ROLE_PATH]: roleFile({ description: 'first line', extra: ['  continued: value'] }) },
  }));
  assert.equal(nested.code, 'BUNDLE_FRONTMATTER_UNSUPPORTED');
  assert.equal(nested.path, ROLE_PATH);
});

test('role description length is 1-1024 code points with a 200 warning threshold', () => {
  const longEnough = report({ overrides: { [ROLE_PATH]: roleFile({ description: 'x'.repeat(201) }) } });
  const warning = only(longEnough, 'warnings');
  assert.equal(warning.code, 'BUNDLE_ROLE_DESCRIPTION_LONG');
  assert.equal(longEnough.ok, true);
  assert.deepEqual(codes(longEnough), []);

  assert.deepEqual(report({ overrides: { [ROLE_PATH]: roleFile({ description: 'x'.repeat(200) }) } }).warnings, []);
  assert.equal(
    only(report({ overrides: { [ROLE_PATH]: roleFile({ description: 'x'.repeat(1025) }) } })).code,
    'BUNDLE_ROLE_DESCRIPTION_LENGTH',
  );
});

test('role enums are closed for mode, model and effort', () => {
  const cases = [
    ['mode', 'sometimes'],
    ['model', 'gpt-4'],
    ['effort', 'extreme'],
  ];
  for (const [key, value] of cases) {
    const diagnostic = only(report({
      overrides: { [ROLE_PATH]: roleFile({ extra: [`${key}: ${value}`] }) },
    }));
    assert.equal(diagnostic.code, 'BUNDLE_ROLE_ENUM_INVALID', key);
    assert.equal(diagnostic.path, ROLE_PATH);
    assert.deepEqual(diagnostic.details, { key, value });
  }
});

test('role tools and tools_deny accept only the eight neutral tokens', () => {
  const tools = only(report({
    overrides: { [ROLE_PATH]: roleFile({ extra: ['tools:', '  - read', '  - zoom'] }) },
  }));
  assert.equal(tools.code, 'BUNDLE_ROLE_TOOL_UNKNOWN');
  assert.equal(tools.path, ROLE_PATH);
  assert.equal(tools.details.token, 'zoom');

  const deny = only(report({
    overrides: { [ROLE_PATH]: roleFile({ extra: ['tools_deny:', '  - bash', '  - net'] }) },
  }));
  assert.equal(deny.code, 'BUNDLE_ROLE_TOOL_UNKNOWN');
  assert.equal(deny.details.token, 'net');
});

test('role tools and tools_deny must be sorted ascending', () => {
  for (const key of ['tools', 'tools_deny']) {
    const diagnostic = only(report({
      overrides: { [ROLE_PATH]: roleFile({ extra: [`${key}:`, '  - write', '  - read'] }) },
    }));
    assert.equal(diagnostic.code, 'BUNDLE_SCHEMA_INVALID', key);
    assert.equal(diagnostic.path, ROLE_PATH);
    assert.equal(diagnostic.pointer, `/${key}`);
    assert.equal(diagnostic.details.rule, 'sorted');
  }
});

test('role skills must be declared bundle skill ids and sorted ascending', () => {
  const undeclared = only(report({
    overrides: { [ROLE_PATH]: roleFile({ extra: ['skills:', '  - ghost'] }) },
  }));
  assert.equal(undeclared.code, 'BUNDLE_ROLE_SKILL_UNDECLARED');
  assert.equal(undeclared.path, ROLE_PATH);
  assert.equal(undeclared.details.id, 'ghost');

  const unsorted = only(report({
    manifest: { skills: ['helper', 'spare'] },
    overrides: {
      [ROLE_PATH]: roleFile({ extra: ['skills:', '  - spare', '  - helper'] }),
      'skills/spare/SKILL.md': skillFile({ name: 'spare', description: 'Spare skill.' }),
    },
  }));
  assert.equal(unsorted.code, 'BUNDLE_SCHEMA_INVALID');
  assert.equal(unsorted.pointer, '/skills');
  assert.equal(unsorted.details.rule, 'sorted');
});

test('a non-placeholder role needs a non-empty body; a placeholder role may be empty', () => {
  const empty = only(report({ overrides: { [ROLE_PATH]: roleFile({ body: '\n\n' }) } }));
  assert.equal(empty.code, 'BUNDLE_ROLE_BODY_EMPTY');
  assert.equal(empty.path, ROLE_PATH);

  const placeholder = report({
    overrides: { [ROLE_PATH]: roleFile({ extra: ['placeholder: true'], body: '\n' }) },
  });
  assert.equal(placeholder.ok, true);
  assert.deepEqual(placeholder.errors, []);
  assert.deepEqual(placeholder.warnings, []);
});

test('role placeholder must be a boolean', () => {
  const diagnostic = only(report({
    overrides: { [ROLE_PATH]: roleFile({ extra: ['placeholder: yes'] }) },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_INVALID');
  assert.equal(diagnostic.details.reason, 'boolean');
});

test('role instructions mentioning the runner warn without blocking', () => {
  const submit = report({ overrides: { [ROLE_PATH]: roleFile({ body: '\nCall {{submit}} when done.\n' }) } });
  assert.equal(submit.ok, true);
  assert.equal(only(submit, 'warnings').code, 'BUNDLE_ROLE_RUNTIME_LEAK');
  assert.equal(submit.warnings[0].path, ROLE_PATH);
  assert.equal(submit.warnings[0].line, 6);

  const engine = report({ overrides: { [ROLE_PATH]: roleFile({ body: '\nRead .r2c/engine/state.json first.\n' }) } });
  assert.equal(only(engine, 'warnings').code, 'BUNDLE_ROLE_RUNTIME_LEAK');
});

test('role id must match the file name and stay out of the reserved names', () => {
  const mismatch = only(report({ overrides: { [ROLE_PATH]: roleFile({ id: 'other' }) } }));
  assert.equal(mismatch.code, 'BUNDLE_ROLE_ID_MISMATCH');
  assert.deepEqual(mismatch.details, { declared: 'worker', stem: 'worker', actual: 'other' });

  const reserved = validateBundle(buildZip(minimalFiles({
    'bundle.json': canonicalJson({ ...MINIMAL_MANIFEST, roles: ['main'] }),
    [ROLE_PATH]: null,
    'roles/main.md': roleFile({ id: 'main' }),
  })), PRIMITIVES);
  assert.ok(codes(reserved).includes('BUNDLE_ROLE_ID_RESERVED'));
});

test('unknown role frontmatter keys are rejected', () => {
  const diagnostic = only(report({
    overrides: { [ROLE_PATH]: roleFile({ extra: ['colour: blue'] }) },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_UNKNOWN_KEY');
  assert.deepEqual(diagnostic.details, { key: 'colour' });
});

test('a frontmatter parse failure suppresses every frontmatter-derived role check', () => {
  const duplicate = roleFile({ id: 'other', extra: ['id: worker'] });
  const diagnostic = only(report({ overrides: { [ROLE_PATH]: duplicate } }));
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_INVALID');
  assert.equal(diagnostic.details.reason, 'duplicate-key');
  assert.equal(codes(report({ overrides: { [ROLE_PATH]: duplicate } })).includes('BUNDLE_ROLE_ID_MISMATCH'), false);
});

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

test('skill name and description are required', () => {
  const name = only(report({ overrides: { [SKILL_PATH]: skillFile({ name: null }) } }));
  assert.equal(name.code, 'BUNDLE_FRONTMATTER_INVALID');
  assert.equal(name.details.reason, 'required');

  const description = only(report({ overrides: { [SKILL_PATH]: skillFile({ description: null }) } }));
  assert.equal(description.code, 'BUNDLE_FRONTMATTER_INVALID');
  assert.equal(description.details.reason, 'required');
});

test('a zero-byte skill file is reported once, before any content check', () => {
  const zero = report({ overrides: { [SKILL_PATH]: '' } });
  assert.deepEqual(codes(zero), ['BUNDLE_SKILL_EMPTY_FILE']);
  assert.equal(zero.errors[0].path, SKILL_PATH);
});

test('a non-placeholder skill needs a non-empty body', () => {
  const diagnostic = only(report({ overrides: { [SKILL_PATH]: skillFile({ body: '\n' }) } }));
  assert.equal(diagnostic.code, 'BUNDLE_SKILL_BODY_EMPTY');
  assert.equal(diagnostic.path, SKILL_PATH);
});

test('a placeholder skill must start its preamble with the visible banner', () => {
  const missing = only(report({
    overrides: { [SKILL_PATH]: skillFile({ extra: ['placeholder: true'] }) },
  }));
  assert.equal(missing.code, 'BUNDLE_SKILL_PLACEHOLDER_BANNER');
  assert.equal(missing.path, SKILL_PATH);

  const wrongBanner = only(report({
    overrides: { [SKILL_PATH]: skillFile({ extra: ['placeholder: true'], body: `\n# helper\n\n> **未完成** 占位。\n` }) },
  }));
  assert.equal(wrongBanner.code, 'BUNDLE_SKILL_PLACEHOLDER_BANNER');

  const afterHeading = only(report({
    overrides: { [SKILL_PATH]: skillFile({ extra: ['placeholder: true'], body: `\n# helper\n\n## 用途\n\n${BANNER}\n` }) },
  }));
  assert.equal(afterHeading.code, 'BUNDLE_SKILL_PLACEHOLDER_BANNER');

  const accepted = report({
    overrides: { [SKILL_PATH]: skillFile({ extra: ['placeholder: true'], body: `\n# helper\n\n${BANNER}\n` }) },
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.errors, []);
  assert.deepEqual(accepted.warnings, []);
});

test('a skill directory may only contain SKILL.md', () => {
  const diagnostic = only(report({
    overrides: { 'skills/helper/README.md': 'not allowed\n' },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_SKILL_EXTRA_FILE');
  assert.equal(diagnostic.path, 'skills/helper/README.md');
});

test('an undeclared skill directory is reported once and its content is not checked', () => {
  const diagnostic = only(report({
    overrides: { 'skills/ghost/SKILL.md': 'not even frontmatter\n' },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_SKILL_DIR_UNDECLARED');
  assert.deepEqual(diagnostic.details, { id: 'ghost' });
});

test('skill name must equal its directory and honour the reserved names', () => {
  const mismatch = only(report({ overrides: { [SKILL_PATH]: skillFile({ name: 'other' }) } }));
  assert.equal(mismatch.code, 'BUNDLE_SKILL_ID_MISMATCH');
  assert.deepEqual(mismatch.details, { declared: 'helper', stem: 'helper', actual: 'other' });

  const reserved = report({
    manifest: { skills: ['helper', 'anthropic-skills'] },
    overrides: { 'skills/anthropic-skills/SKILL.md': skillFile({ name: 'anthropic-skills' }) },
  });
  // The manifest declaration owns the reserved-id diagnostic; the file must
  // not repeat it (decision #67 one root cause = one diagnostic).
  const reservedDiagnostics = reserved.errors.filter((error) => error.code === 'BUNDLE_SKILL_ID_RESERVED');
  assert.equal(reservedDiagnostics.length, 1);
  assert.equal(reservedDiagnostics[0].path, 'bundle.json');
});

// ---------------------------------------------------------------------------
// constitution — absent / present / placeholder trinary
// ---------------------------------------------------------------------------

test('no constitution item means no file, no diagnostics and an empty IR mount list', () => {
  const value = report();
  assert.equal(value.ok, true);
  assert.deepEqual(value.errors, []);
  assert.deepEqual(value.warnings, []);
  assert.ok(!minimalFiles().has(CONSTITUTION_PATH));

  const ir = JSON.parse(new TextDecoder().decode(compile().irBytes));
  assert.deepEqual(ir.constitution, []);
});

test('a placeholder constitution may be zero bytes and warns without blocking', () => {
  const value = report({
    manifest: { constitution: { path: CONSTITUTION_PATH, placeholder: true } },
    overrides: { [CONSTITUTION_PATH]: '' },
  });
  assert.equal(value.ok, true);
  assert.deepEqual(value.errors, []);
  const warning = only(value, 'warnings');
  assert.equal(warning.code, 'BUNDLE_CONSTITUTION_PLACEHOLDER');
  assert.equal(warning.path, CONSTITUTION_PATH);

  const result = compile({
    manifest: { constitution: { path: CONSTITUTION_PATH, placeholder: true } },
    overrides: { [CONSTITUTION_PATH]: '' },
  });
  const irBytes = result.irBytes;
  const ir = JSON.parse(new TextDecoder().decode(irBytes));
  assert.equal(ir.constitution.length, 1);
  assert.equal(ir.constitution[0].scope, 'global');
  assert.equal(ir.constitution[0].placeholder, true);
  assert.equal(ir.constitution[0].body, '');
  const irReport = validateIr(irBytes, { sha256: sha256Hex });
  assert.equal(irReport.ok, true, JSON.stringify(irReport.errors));
});

test('a zero-byte constitution is only legal as a placeholder and is exempt from the trailing LF rule', () => {
  const value = report({
    manifest: { constitution: { path: CONSTITUTION_PATH } },
    overrides: { [CONSTITUTION_PATH]: '' },
  });
  assert.deepEqual(codes(value), ['BUNDLE_CONSTITUTION_EMPTY']);
  assert.equal(value.errors[0].path, CONSTITUTION_PATH);
});

test('a present constitution gets the normal checks', () => {
  const present = report({
    manifest: { constitution: { path: CONSTITUTION_PATH } },
    overrides: { [CONSTITUTION_PATH]: '# 宪法\n\nAlways be precise.\n' },
  });
  assert.equal(present.ok, true);
  assert.deepEqual(present.errors, []);
  assert.deepEqual(present.warnings, []);

  const draft = report({
    manifest: { constitution: { path: CONSTITUTION_PATH, placeholder: true } },
    overrides: { [CONSTITUTION_PATH]: '# 宪法（草稿）\n\nAlways be precise.\n' },
  });
  assert.equal(only(draft, 'warnings').code, 'BUNDLE_CONSTITUTION_PLACEHOLDER');

  const frontmatter = only(report({
    manifest: { constitution: { path: CONSTITUTION_PATH } },
    overrides: { [CONSTITUTION_PATH]: '---\nscope: global\n---\n\nbody\n' },
  }));
  assert.equal(frontmatter.code, 'BUNDLE_CONSTITUTION_FRONTMATTER');

  const tooLarge = only(report({
    manifest: { constitution: { path: CONSTITUTION_PATH } },
    overrides: { [CONSTITUTION_PATH]: `${'x'.repeat(64 * 1024)}\n` },
  }));
  assert.equal(tooLarge.code, 'BUNDLE_CONSTITUTION_TOO_LARGE');
  assert.equal(tooLarge.details.limit, 64 * 1024);
  assert.equal(tooLarge.details.actual, 64 * 1024 + 1);
});

test('a declared constitution without a file is a single missing-file error', () => {
  const diagnostic = only(report({
    manifest: { constitution: { path: CONSTITUTION_PATH } },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_CONSTITUTION_MISSING');
  assert.equal(diagnostic.path, CONSTITUTION_PATH);
});

test('a constitution directory or file without a manifest item is undeclared', () => {
  const file = only(report({ overrides: { [CONSTITUTION_PATH]: '# 宪法\n' } }));
  assert.equal(file.code, 'BUNDLE_CONSTITUTION_UNDECLARED');
  assert.equal(file.path, CONSTITUTION_PATH);

  const files = minimalFiles();
  const directoryEntry = validateBundle(
    buildZip(files, { directory: ['stages', 'roles', 'tasks', 'skills', 'constitution'] }),
    PRIMITIVES,
  );
  assert.deepEqual(codes(directoryEntry), ['BUNDLE_CONSTITUTION_UNDECLARED']);
});

// ---------------------------------------------------------------------------
// placeholder whitelist
// ---------------------------------------------------------------------------

test('tasks, stages and steps may not declare placeholders', () => {
  const task = only(report({ overrides: { 'tasks/do-it.md': `---\nplaceholder: true\n---\n${MINIMAL_TASK}` } }));
  assert.equal(task.code, 'BUNDLE_TASK_PLACEHOLDER_FORBIDDEN');

  const stage = validateBundle(buildZip(minimalFiles({
    'stages/only.json': canonicalJson({ ...JSON.parse(canonicalJson(JSON.parse(minimalFiles().get('stages/only.json')))), placeholder: true }),
  })), PRIMITIVES);
  const stageDiagnostic = stage.errors.find((diagnostic) => diagnostic.code === 'BUNDLE_UNKNOWN_KEY');
  assert.ok(stageDiagnostic, JSON.stringify(stage.errors));
  assert.equal(stageDiagnostic.pointer, '/placeholder');

  const stepValue = JSON.parse(minimalFiles().get('stages/only.json'));
  stepValue.steps[0].placeholder = true;
  const step = validateBundle(buildZip(minimalFiles({
    'stages/only.json': canonicalJson(stepValue),
  })), PRIMITIVES);
  const stepDiagnostic = step.errors.find((diagnostic) => diagnostic.code === 'BUNDLE_UNKNOWN_KEY');
  assert.ok(stepDiagnostic, JSON.stringify(step.errors));
  assert.equal(stepDiagnostic.pointer, '/steps/0/placeholder');
});

test('placeholder roles, skills and constitutions keep their ids, declarations and IR entries', () => {
  const value = compile({
    manifest: { constitution: { path: CONSTITUTION_PATH, placeholder: true } },
    overrides: {
      [ROLE_PATH]: roleFile({ extra: ['placeholder: true'], body: '' }),
      [SKILL_PATH]: skillFile({ extra: ['placeholder: true'], body: `\n# helper\n\n${BANNER}\n` }),
      [CONSTITUTION_PATH]: '',
    },
  });
  const ir = JSON.parse(new TextDecoder().decode(value.irBytes));
  assert.deepEqual(Object.keys(ir.roles), ['worker']);
  assert.deepEqual(Object.keys(ir.skills), ['helper']);
  assert.equal(ir.roles.worker.placeholder, true);
  assert.equal(ir.roles.worker.instructions, '');
  assert.equal(ir.skills.helper.placeholder, true);
  assert.equal(ir.constitution.length, 1);
  assert.equal(ir.constitution[0].placeholder, true);
  assert.equal(validateIr(value.irBytes, { sha256: sha256Hex }).ok, true);
});

test('entity diagnostics are deterministic and sorted', () => {
  const options = {
    manifest: { constitution: { path: CONSTITUTION_PATH } },
    overrides: {
      [ROLE_PATH]: roleFile({ extra: ['mode: sometimes', 'tools:', '  - write', '  - read'] }),
      [SKILL_PATH]: skillFile({ extra: ['placeholder: true'], body: '\nno banner\n' }),
      [CONSTITUTION_PATH]: '',
    },
  };
  const first = report(options);
  const second = report(options);
  assert.deepEqual(first, second);
  assert.ok(first.errors.length >= 4, JSON.stringify(first.errors));
  const order = first.errors.map((diagnostic) => `${diagnostic.path}\u0000${diagnostic.pointer ?? ''}`);
  const sorted = [...order].sort();
  assert.deepEqual(order, sorted);
});

test('distinct violations never collapse into one diagnostic', () => {
  // Two missing frontmatter fields share code/path/line; their pointers keep
  // them apart (dedupe key is code/path/pointer/line).
  const missing = report({ overrides: { [ROLE_PATH]: '---\n---\n\nBody.\n' } });
  const required = missing.errors.filter((error) => error.code === 'BUNDLE_FRONTMATTER_INVALID');
  assert.deepEqual(required.map((error) => error.pointer).sort(), ['/description', '/id']);
  assert.deepEqual(required.map((error) => error.details.reason), ['required', 'required']);

  // Two unknown tool tokens are two violations with distinct pointers/tokens.
  const tokens = report({
    overrides: { [ROLE_PATH]: roleFile({ extra: ['tools:', '  - alpha', '  - beta'] }) },
  });
  const unknown = tokens.errors.filter((error) => error.code === 'BUNDLE_ROLE_TOOL_UNKNOWN');
  assert.deepEqual(unknown.map((error) => error.details.token).sort(), ['alpha', 'beta']);
  assert.deepEqual(unknown.map((error) => error.pointer).sort(), ['/tools/0', '/tools/1']);
});
