import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { buildZip } from './helpers/zip.js';
import {
  MINIMAL_MANIFEST,
  MINIMAL_STAGE,
  minimalFiles,
} from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };
const MANIFEST_PATH = 'bundle.json';
const STAGE_PATH = 'stages/only.json';
const CONSTITUTION_PATH = 'constitution/CONSTITUTION.md';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function manifestText(mutate) {
  const value = clone(MINIMAL_MANIFEST);
  mutate(value);
  return canonicalJson(value);
}

function stageText(mutate) {
  const value = clone(MINIMAL_STAGE);
  mutate(value);
  return canonicalJson(value);
}

function reportFor(overrides) {
  return validateBundle(buildZip(minimalFiles(overrides)), PRIMITIVES);
}

function errorCodes(report) {
  return report.errors.map((error) => error.code);
}

function expectSingle(report, { code, path, pointer = null, line = undefined, details = undefined }) {
  assert.equal(report.ok, false, `expected an error for ${code}`);
  assert.equal(report.errors.length, 1, JSON.stringify(report.errors, null, 2));
  const [error] = report.errors;
  assert.equal(error.code, code);
  if (path !== undefined) assert.equal(error.path, path);
  if (pointer !== null) assert.equal(error.pointer, pointer);
  if (line !== undefined) assert.equal(error.line, line);
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) {
      assert.deepEqual(error.details[key], value, `details.${key}`);
    }
  }
  return error;
}

test('non-canonical bundle.json forms each yield exactly one diagnostic', () => {
  const canonical = canonicalJson(MINIMAL_MANIFEST);
  const reversed = Object.fromEntries(Object.entries(MINIMAL_MANIFEST).reverse());
  const duplicateLine = 4;
  const commentLine = canonical.split('\n').indexOf('}') + 1;
  const cases = [
    {
      name: 'indentation',
      text: canonical.replace(/\n  /g, '\n    '),
      reason: 'bytes',
    },
    {
      name: 'key order',
      text: canonicalJson(reversed),
      reason: 'key-order',
    },
    {
      name: 'trailing comma',
      text: canonical.replace(/\n}\n$/, ',\n}\n'),
      reason: 'trailing-comma',
      line: commentLine - 1,
    },
    {
      name: 'duplicate keys',
      text: canonical.replace(
        '  "id": "minimal-demo",\n',
        '  "id": "minimal-demo",\n  "id": "minimal-demo",\n',
      ),
      reason: 'duplicate-key',
      line: duplicateLine,
    },
    {
      name: 'comments',
      text: canonical.replace('\n}\n', '\n  // author note\n}\n'),
      reason: 'comment',
      line: commentLine,
    },
  ];

  for (const item of cases) {
    const report = reportFor({ "bundle.json": item.text });
    const error = expectSingle(report, {
      code: 'BUNDLE_JSON_NOT_CANONICAL',
      path: MANIFEST_PATH,
      line: item.reason === 'bytes' ? null : item.line,
      details: { reason: item.reason },
    });
    assert.equal(typeof error.details.offset, 'number', item.name);
  }
});

test('nested manifest objects keep schema key order', () => {
  const report = reportFor({
    'bundle.json': manifestText((value) => {
      value.requires = { projections: ['runner'], engine: '>=1.0.0' };
    }),
  });
  expectSingle(report, {
    code: 'BUNDLE_JSON_NOT_CANONICAL',
    path: MANIFEST_PATH,
    details: { reason: 'key-order' },
  });
});

test('a syntactically broken manifest is BUNDLE_JSON_PARSE and suppresses content phases', () => {
  const report = reportFor({ 'bundle.json': '{' });
  expectSingle(report, { code: 'BUNDLE_JSON_PARSE', path: MANIFEST_PATH });
  assert.deepEqual(errorCodes(report), ['BUNDLE_JSON_PARSE']);
});

test('stage JSON shares the canonical rule and still reports one diagnostic', () => {
  const text = canonicalJson(MINIMAL_STAGE).replace('\n}\n', ',\n}\n');
  const report = reportFor({ [STAGE_PATH]: text });
  expectSingle(report, {
    code: 'BUNDLE_JSON_NOT_CANONICAL',
    path: STAGE_PATH,
    details: { reason: 'trailing-comma' },
  });
});

test('unknown keys are reported once per object, never dropped', () => {
  const top = reportFor({ 'bundle.json': manifestText((value) => { value.extra = true; }) });
  expectSingle(top, {
    code: 'BUNDLE_UNKNOWN_KEY',
    path: MANIFEST_PATH,
    pointer: '/extra',
    details: { key: 'extra' },
  });

  const step = reportFor({
    [STAGE_PATH]: stageText((value) => { value.steps[0].bogus = 1; }),
  });
  expectSingle(step, {
    code: 'BUNDLE_UNKNOWN_KEY',
    path: STAGE_PATH,
    pointer: '/steps/0/bogus',
    details: { key: 'bogus' },
  });

  const gate = reportFor({
    [STAGE_PATH]: stageText((value) => { value.steps[0].gates[0].shell = 'sh'; }),
  });
  expectSingle(gate, {
    code: 'BUNDLE_UNKNOWN_KEY',
    path: STAGE_PATH,
    pointer: '/steps/0/gates/0/shell',
    details: { key: 'shell' },
  });

  const constitution = reportFor({
    'bundle.json': manifestText((value) => {
      value.constitution = { path: CONSTITUTION_PATH, placeholder: false, extra: true };
    }),
    [CONSTITUTION_PATH]: '# Rules\n\nBe good.\n',
  });
  expectSingle(constitution, {
    code: 'BUNDLE_UNKNOWN_KEY',
    path: MANIFEST_PATH,
    pointer: '/constitution/extra',
    details: { key: 'extra' },
  });
});

test('missing required keys and wrong schemas are structural errors', () => {
  const missingName = reportFor({ 'bundle.json': manifestText((value) => { delete value.name; }) });
  expectSingle(missingName, {
    code: 'BUNDLE_SCHEMA_INVALID',
    path: MANIFEST_PATH,
    pointer: '/name',
    details: { rule: 'required' },
  });

  const cases = [
    { schema: 'hm2b.bundle/v3', reason: 'newer' },
    { schema: 'not-a-schema', reason: 'malformed' },
    { schema: 'hm2b.ir/v1', reason: 'unknown' },
    { schema: null, reason: 'malformed' },
  ];
  for (const item of cases) {
    const report = reportFor({ 'bundle.json': manifestText((value) => { value.schema = item.schema; }) });
    expectSingle(report, {
      code: 'BUNDLE_SCHEMA_UNSUPPORTED',
      path: MANIFEST_PATH,
      details: { reason: item.reason },
    });
  }
});

test('bundle id grammar, length and reserved name', () => {
  const invalid = [
    'a'.repeat(41),
    'Bad',
    'bad_id',
    '-bad',
    'bad-',
  ];
  for (const id of invalid) {
    const report = reportFor({ 'bundle.json': manifestText((value) => { value.id = id; }) });
    expectSingle(report, { code: 'BUNDLE_ID_INVALID', path: MANIFEST_PATH, pointer: '/id' });
  }
  const reserved = reportFor({ 'bundle.json': manifestText((value) => { value.id = 'hm2b'; }) });
  expectSingle(reserved, {
    code: 'BUNDLE_ID_RESERVED',
    path: MANIFEST_PATH,
    pointer: '/id',
    details: { value: 'hm2b' },
  });

  for (const id of ['a', 'a'.repeat(40)]) {
    const report = reportFor({ 'bundle.json': manifestText((value) => { value.id = id; }) });
    assert.equal(report.ok, true, `${id}: ${JSON.stringify(report.errors)}`);
  }
});

test('role and skill reserved ids are reported once', () => {
  const roleText = [
    '---',
    'id: main',
    'description: Reserved role.',
    '---',
    '',
    'You coordinate the run.',
    '',
  ].join('\n');
  const role = reportFor({
    'bundle.json': manifestText((value) => {
      value.roles = ['main'];
      value.stages = [value.stages[0]];
    }),
    [STAGE_PATH]: stageText((value) => { value.steps[0].role = 'main'; }),
    'roles/worker.md': null,
    'roles/main.md': roleText,
  });
  expectSingle(role, {
    code: 'BUNDLE_ROLE_ID_RESERVED',
    path: MANIFEST_PATH,
    details: { value: 'main' },
  });

  const skillText = [
    '---',
    'name: synced',
    'description: Reserved skill.',
    '---',
    '',
    '# synced',
    '',
    'Body.',
    '',
  ].join('\n');
  const skill = reportFor({
    'bundle.json': manifestText((value) => { value.skills = ['synced']; }),
    [STAGE_PATH]: stageText((value) => { value.steps[0].skills = ['synced']; }),
    'skills/helper/SKILL.md': null,
    'skills/synced/SKILL.md': skillText,
  });
  expectSingle(skill, {
    code: 'BUNDLE_SKILL_ID_RESERVED',
    path: MANIFEST_PATH,
    details: { value: 'synced' },
  });
});

test('manifest id arrays with illegal ids suppress equality and reference checks (S9)', () => {
  const report = reportFor({ 'bundle.json': manifestText((value) => { value.stages = ['Bad']; }) });
  expectSingle(report, {
    code: 'BUNDLE_STAGE_ID_INVALID',
    path: MANIFEST_PATH,
    pointer: '/stages/0',
    details: { where: 'manifest', value: 'Bad' },
  });

  const missingStages = reportFor({ 'bundle.json': manifestText((value) => { delete value.stages; }) });
  expectSingle(missingStages, {
    code: 'BUNDLE_SCHEMA_INVALID',
    path: MANIFEST_PATH,
    pointer: '/stages',
    details: { rule: 'required' },
  });

  const duplicateTask = reportFor({
    'bundle.json': manifestText((value) => { value.tasks = ['do-it', 'do-it']; }),
  });
  expectSingle(duplicateTask, {
    code: 'BUNDLE_SCHEMA_INVALID',
    path: MANIFEST_PATH,
    pointer: '/tasks/1',
    details: { rule: 'uniqueItems' },
  });
});

test('declared-vs-present equality is bidirectional for every product kind', () => {
  const cases = [
    {
      name: 'stage declared but missing',
      overrides: { [STAGE_PATH]: null },
      expected: { code: 'BUNDLE_STAGE_FILE_MISSING', path: STAGE_PATH },
    },
    {
      name: 'stage present but undeclared',
      overrides: {
        'stages/ghost.json': canonicalJson({ ...clone(MINIMAL_STAGE), id: 'ghost' }),
      },
      expected: { code: 'BUNDLE_STAGE_FILE_UNDECLARED', path: 'stages/ghost.json' },
    },
    {
      name: 'role declared but missing',
      overrides: { 'roles/worker.md': null },
      expected: { code: 'BUNDLE_ROLE_FILE_MISSING', path: 'roles/worker.md' },
    },
    {
      name: 'role present but undeclared',
      overrides: {
        'roles/extra.md': '---\nid: extra\ndescription: Extra role.\n---\n\nBody.\n',
      },
      expected: { code: 'BUNDLE_ROLE_FILE_UNDECLARED', path: 'roles/extra.md' },
    },
    {
      name: 'task declared but missing',
      overrides: { 'tasks/do-it.md': null },
      expected: { code: 'BUNDLE_TASK_FILE_MISSING', path: 'tasks/do-it.md' },
    },
    {
      name: 'task present but undeclared',
      overrides: { 'tasks/extra.md': '# extra\n' },
      expected: { code: 'BUNDLE_TASK_FILE_UNDECLARED', path: 'tasks/extra.md' },
    },
    {
      name: 'skill declared but missing',
      overrides: { 'skills/helper/SKILL.md': null },
      expected: { code: 'BUNDLE_SKILL_FILE_MISSING', path: 'skills/helper/SKILL.md' },
    },
    {
      name: 'skill present but undeclared',
      overrides: {
        'skills/extra/SKILL.md': '---\nname: extra\ndescription: Extra skill.\n---\n\nBody.\n',
      },
      expected: { code: 'BUNDLE_SKILL_DIR_UNDECLARED', path: 'skills/extra/SKILL.md' },
    },
  ];
  for (const item of cases) {
    const report = reportFor(item.overrides);
    assert.ok(
      report.errors.some((error) => error.code === item.expected.code && error.path === item.expected.path),
      `${item.name}: ${JSON.stringify(report.errors)}`,
    );
    assert.equal(errorCodes(report).length, 1, `${item.name}: ${JSON.stringify(report.errors)}`);
  }
});

test('stage file ids must be valid and byte-equal to the stem', () => {
  const invalid = reportFor({ [STAGE_PATH]: stageText((value) => { value.id = 'Bad'; }) });
  expectSingle(invalid, {
    code: 'BUNDLE_STAGE_ID_INVALID',
    path: STAGE_PATH,
    pointer: '/id',
    details: { where: 'file', value: 'Bad' },
  });

  const mismatch = reportFor({ [STAGE_PATH]: stageText((value) => { value.id = 'other'; }) });
  expectSingle(mismatch, {
    code: 'BUNDLE_STAGE_ID_MISMATCH',
    path: STAGE_PATH,
    pointer: '/id',
    details: { declared: 'only', stem: 'only', actual: 'other' },
  });
});

test('step references to undeclared ids are errors', () => {
  const cases = [
    { field: 'task', value: 'ghost', code: 'BUNDLE_STEP_TASK_UNDECLARED', pointer: '/steps/0/task' },
    { field: 'role', value: 'ghost', code: 'BUNDLE_STEP_ROLE_UNDECLARED', pointer: '/steps/0/role' },
    { field: 'skills', value: ['ghost'], code: 'BUNDLE_STEP_SKILL_UNDECLARED', pointer: '/steps/0/skills/0' },
  ];
  for (const item of cases) {
    const report = reportFor({
      [STAGE_PATH]: stageText((value) => { value.steps[0][item.field] = item.value; }),
    });
    assert.deepEqual(errorCodes(report), [item.code], JSON.stringify(report.errors));
    assert.equal(report.errors[0].path, STAGE_PATH);
    assert.equal(report.errors[0].pointer, item.pointer);
  }
});

test('version is strict semver without build metadata', () => {
  const build = reportFor({ 'bundle.json': manifestText((value) => { value.version = '1.0.0+build.5'; }) });
  expectSingle(build, {
    code: 'BUNDLE_VERSION_INVALID',
    path: MANIFEST_PATH,
    pointer: '/version',
    details: { reason: 'build-metadata' },
  });
  for (const version of ['1.0', 'v1.0.0', '1.0.0.0', '01']) {
    const report = reportFor({ 'bundle.json': manifestText((value) => { value.version = version; }) });
    expectSingle(report, {
      code: 'BUNDLE_VERSION_INVALID',
      path: MANIFEST_PATH,
      pointer: '/version',
      details: { reason: 'pattern' },
    });
  }
  const prerelease = reportFor({ 'bundle.json': manifestText((value) => { value.version = '1.0.0-alpha.1'; }) });
  assert.equal(prerelease.ok, true, JSON.stringify(prerelease.errors));
});

test('requires validates syntax, the closed projection set and non-emptiness', () => {
  const invalid = [
    { requires: {}, reason: 'empty' },
    { requires: { engine: 'definitely not a range' }, reason: 'range' },
    { requires: { engine: 3 }, reason: 'range' },
    { requires: { projections: [] }, reason: 'projections' },
    { requires: { projections: ['runner', 'other'] }, reason: 'projections' },
    { requires: { projections: ['runner', 'runner'] }, reason: 'projections' },
    { requires: { projections: 'runner' }, reason: 'projections' },
    { requires: { extra: true }, reason: 'unknown-key' },
  ];
  for (const item of invalid) {
    const report = reportFor({ 'bundle.json': manifestText((value) => { value.requires = item.requires; }) });
    const error = expectSingle(report, {
      code: 'BUNDLE_REQUIRES_INVALID',
      path: MANIFEST_PATH,
      details: { reason: item.reason },
    });
    assert.equal(typeof error.pointer, 'string', JSON.stringify(item.requires));
  }

  const valid = reportFor({
    'bundle.json': manifestText((value) => {
      value.requires = { engine: '>=1.0.0 <2.0.0', projections: ['runner', 'agent-native'] };
    }),
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
});

test('stages reject the step-only keys', () => {
  for (const key of ['role', 'outputs', 'gates', 'constitution']) {
    const report = reportFor({
      [STAGE_PATH]: stageText((value) => { value[key] = key === 'role' ? 'worker' : []; }),
    });
    expectSingle(report, {
      code: 'BUNDLE_UNKNOWN_KEY',
      path: STAGE_PATH,
      pointer: `/${key}`,
      details: { key },
    });
  }
});

test('an empty stage yields exactly one error', () => {
  const report = reportFor({ [STAGE_PATH]: stageText((value) => { value.steps = []; }) });
  expectSingle(report, { code: 'BUNDLE_STAGE_EMPTY', path: STAGE_PATH, pointer: '/steps' });
});

test('a step without task suppresses its dependent checks (S10)', () => {
  const report = reportFor({
    [STAGE_PATH]: stageText((value) => {
      delete value.steps[0].task;
      value.steps[0].outputs = ['/absolute/*.md'];
      value.steps[0].gates = [{}];
    }),
  });
  expectSingle(report, {
    code: 'BUNDLE_SCHEMA_INVALID',
    path: STAGE_PATH,
    pointer: '/steps/0/task',
    details: { rule: 'required' },
  });
  assert.equal(report.warnings.length, 0, JSON.stringify(report.warnings));
});

test('step outputs are project-root relative globs', () => {
  const cases = [
    { outputs: [''], code: 'BUNDLE_OUTPUT_INVALID_GLOB', pointer: '/steps/0/outputs/0' },
    { outputs: ['a{b'], code: 'BUNDLE_OUTPUT_INVALID_GLOB', pointer: '/steps/0/outputs/0' },
    { outputs: ['/abs/*.md'], code: 'BUNDLE_OUTPUT_PATH_INVALID', pointer: '/steps/0/outputs/0', reason: 'absolute' },
    { outputs: ['..\\x'], code: 'BUNDLE_OUTPUT_PATH_INVALID', pointer: '/steps/0/outputs/0', reason: 'backslash' },
    { outputs: ['skills/x.md'], code: 'BUNDLE_OUTPUT_FORBIDDEN', pointer: '/steps/0/outputs/0' },
    { outputs: ['a/skill.md'], code: 'BUNDLE_OUTPUT_FORBIDDEN', pointer: '/steps/0/outputs/0' },
  ];
  for (const item of cases) {
    const report = reportFor({
      [STAGE_PATH]: stageText((value) => { value.steps[0].outputs = item.outputs; }),
    });
    expectSingle(report, {
      code: item.code,
      path: STAGE_PATH,
      pointer: item.pointer,
      details: item.reason === undefined ? undefined : { reason: item.reason },
    });
  }
});

test('gate commands are required and timeouts stay in range', () => {
  const cases = [
    { gates: [{}], pointer: '/steps/0/gates/0/command', field: 'command' },
    { gates: [{ command: '   ' }], pointer: '/steps/0/gates/0/command', field: 'command' },
    { gates: [{ command: 'x', timeout: 0 }], pointer: '/steps/0/gates/0/timeout', field: 'timeout' },
    { gates: [{ command: 'x', timeout: 86401 }], pointer: '/steps/0/gates/0/timeout', field: 'timeout' },
    { gates: [{ command: 'x', timeout: 'soon' }], pointer: '/steps/0/gates/0/timeout', field: 'timeout' },
  ];
  for (const item of cases) {
    const report = reportFor({
      [STAGE_PATH]: stageText((value) => { value.steps[0].gates = item.gates; }),
    });
    expectSingle(report, {
      code: 'BUNDLE_GATE_INVALID',
      path: STAGE_PATH,
      pointer: item.pointer,
      details: { field: item.field },
    });
  }
});

test('step ids are valid and unique bundle-wide', () => {
  const invalid = reportFor({
    [STAGE_PATH]: stageText((value) => { value.steps[0].id = 'Bad'; }),
  });
  expectSingle(invalid, {
    code: 'BUNDLE_STEP_ID_INVALID',
    path: STAGE_PATH,
    pointer: '/steps/0/id',
  });

  const secondStage = canonicalJson({
    id: 'second',
    name: 'Second Stage',
    steps: [{
      id: 'only-step',
      name: 'Duplicate Step',
      role: 'worker',
      task: 'do-it',
      skills: ['helper'],
    }],
  });
  const report = reportFor({
    'bundle.json': manifestText((value) => { value.stages = ['only', 'second']; }),
    'stages/second.json': secondStage,
  });
  assert.deepEqual(errorCodes(report), ['BUNDLE_STEP_DUPLICATE'], JSON.stringify(report.errors));
  assert.equal(report.errors[0].path, 'stages/second.json');
  assert.equal(report.errors[0].pointer, '/steps/0/id');
  assert.match(report.errors[0].details.first, /^stages\/only\.json#/);
});

test('stage declaration order is execution order, never sorted', () => {
  const order = ['zeta', 'alpha', 'mid'];
  const overrides = {
    'bundle.json': manifestText((value) => { value.stages = order; }),
    [STAGE_PATH]: null,
  };
  order.forEach((id, index) => {
    overrides[`stages/${id}.json`] = canonicalJson({
      id,
      name: `Stage ${id}`,
      steps: [{
        id: `step-${index}`,
        name: `Step ${id}`,
        role: 'worker',
        task: 'do-it',
        skills: ['helper'],
      }],
    });
  });
  const zip = buildZip(minimalFiles(overrides));
  const compiled = compileBundle(zip, PRIMITIVES);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.report.errors));
  const ir = JSON.parse(new TextDecoder().decode(compiled.irBytes));
  assert.deepEqual(ir.stages.map((stage) => stage.id), order);
  assert.deepEqual(ir.stages.flatMap((stage) => stage.steps.map((step) => step.id)), ['step-0', 'step-1', 'step-2']);
});

test('reports are byte-identical on repeat for an invalid manifest', () => {
  const files = minimalFiles({
    'bundle.json': manifestText((value) => {
      value.version = '1.0.0+build';
      value.extra = true;
    }),
  });
  const zip = buildZip(files);
  const first = JSON.stringify(validateBundle(zip, PRIMITIVES));
  const second = JSON.stringify(validateBundle(zip, PRIMITIVES));
  assert.equal(first, second);
});
