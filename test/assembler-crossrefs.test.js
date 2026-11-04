/**
 * Cross-reference contract (decision #67 §7.9/§7.12, spec §2).
 *
 * References are compared against the *declared* sets; file existence is
 * reported once by the per-kind modules. Unused assets are warnings and never
 * change `ok`. All assertions go through the public bytes-in report.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { buildZip } from './helpers/zip.js';
import {
  MINIMAL_MANIFEST,
  MINIMAL_TASK,
  minimalFiles,
} from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };
const STAGE_PATH = 'stages/only.json';

function stageValue(mutate) {
  const value = JSON.parse(minimalFiles().get(STAGE_PATH));
  mutate(value);
  return canonicalJson(value);
}

function report({ manifest = {}, overrides = {} } = {}) {
  const files = minimalFiles({
    'bundle.json': canonicalJson({ ...MINIMAL_MANIFEST, ...manifest }),
    ...overrides,
  });
  return validateBundle(buildZip(files), PRIMITIVES);
}

function codes(reportValue, severity = 'errors') {
  return reportValue[severity].map((diagnostic) => diagnostic.code);
}

function only(reportValue, severity = 'errors') {
  assert.equal(reportValue[severity].length, 1, JSON.stringify(reportValue[severity]));
  return reportValue[severity][0];
}

const SPARE_ROLE = '---\nid: spare\ndescription: Spare role.\n---\n\nSpare instructions.\n';
const SPARE_SKILL = '---\nname: spare\ndescription: Spare skill.\n---\n\n# spare\n\nSpare body.\n';

// ---------------------------------------------------------------------------
// step → task / role / skill
// ---------------------------------------------------------------------------

test('a step task must be declared, not merely present as a file', () => {
  const diagnostic = only(report({
    overrides: { [STAGE_PATH]: stageValue((stage) => { stage.steps[0].task = 'ghost'; }) },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_STEP_TASK_UNDECLARED');
  assert.equal(diagnostic.path, STAGE_PATH);
  assert.equal(diagnostic.pointer, '/steps/0/task');
  assert.deepEqual(diagnostic.details, { pointer: '/steps/0/task', field: 'task', id: 'ghost' });
});

test('a declared task with no file is reported as missing, not as an undeclared reference', () => {
  const reportValue = report({ overrides: { 'tasks/do-it.md': null } });
  assert.deepEqual(codes(reportValue), ['BUNDLE_TASK_FILE_MISSING']);
  assert.ok(!codes(reportValue).includes('BUNDLE_STEP_TASK_UNDECLARED'));
});

test('a step role must be declared', () => {
  const diagnostic = only(report({
    overrides: { [STAGE_PATH]: stageValue((stage) => { stage.steps[0].role = 'ghost'; }) },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_STEP_ROLE_UNDECLARED');
  assert.equal(diagnostic.path, STAGE_PATH);
  assert.equal(diagnostic.pointer, '/steps/0/role');
  assert.equal(diagnostic.details.id, 'ghost');
});

test('every step skill must be declared and points at its array index', () => {
  const diagnostic = only(report({
    overrides: { [STAGE_PATH]: stageValue((stage) => { stage.steps[0].skills = ['helper', 'ghost']; }) },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_STEP_SKILL_UNDECLARED');
  assert.equal(diagnostic.pointer, '/steps/0/skills/1');
  assert.equal(diagnostic.details.id, 'ghost');
});

test('role preloads must be declared skills (role → skill)', () => {
  const diagnostic = only(report({
    overrides: {
      'roles/worker.md': '---\nid: worker\ndescription: Executes the step.\nskills:\n  - ghost\n---\n\nInstructions.\n',
    },
  }));
  assert.equal(diagnostic.code, 'BUNDLE_ROLE_SKILL_UNDECLARED');
  assert.equal(diagnostic.path, 'roles/worker.md');
  assert.equal(diagnostic.details.id, 'ghost');
});

// ---------------------------------------------------------------------------
// bidirectional declared ↔ directory equality
// ---------------------------------------------------------------------------

test('declared ids without files are missing exactly once', () => {
  const cases = [
    ['roles/worker.md', 'BUNDLE_ROLE_FILE_MISSING', 'roles/worker.md'],
    ['tasks/do-it.md', 'BUNDLE_TASK_FILE_MISSING', 'tasks/do-it.md'],
    ['skills/helper/SKILL.md', 'BUNDLE_SKILL_FILE_MISSING', 'skills/helper/SKILL.md'],
  ];
  for (const [path, code, expectedPath] of cases) {
    const reportValue = report({ overrides: { [path]: null } });
    const diagnostic = only(reportValue);
    assert.equal(diagnostic.code, code, path);
    assert.equal(diagnostic.path, expectedPath);
  }
});

test('files without declarations are undeclared exactly once and their content is not checked', () => {
  const cases = [
    ['roles/spare.md', 'spare role body without frontmatter\n', 'BUNDLE_ROLE_FILE_UNDECLARED', 'roles/spare.md'],
    ['tasks/spare.md', 'not a task book\n', 'BUNDLE_TASK_FILE_UNDECLARED', 'tasks/spare.md'],
    ['skills/spare/SKILL.md', 'not a skill\n', 'BUNDLE_SKILL_DIR_UNDECLARED', 'skills/spare/SKILL.md'],
  ];
  for (const [path, content, code, expectedPath] of cases) {
    const reportValue = report({ overrides: { [path]: content } });
    assert.deepEqual(codes(reportValue), [code], path);
    assert.equal(reportValue.errors[0].path, expectedPath);
  }
});

// ---------------------------------------------------------------------------
// unused assets are warnings
// ---------------------------------------------------------------------------

test('declared but unreferenced roles, tasks and skills warn and stay accepted', () => {
  const reportValue = report({
    manifest: { roles: ['worker', 'spare'], tasks: ['do-it', 'spare'], skills: ['helper', 'spare'] },
    overrides: {
      'roles/spare.md': SPARE_ROLE,
      'tasks/spare.md': MINIMAL_TASK,
      'skills/spare/SKILL.md': SPARE_SKILL,
    },
  });
  assert.equal(reportValue.ok, true);
  assert.deepEqual(codes(reportValue), []);
  assert.deepEqual(codes(reportValue, 'warnings').sort(), [
    'BUNDLE_ROLE_UNUSED',
    'BUNDLE_SKILL_UNUSED',
    'BUNDLE_TASK_UNUSED',
  ]);
  const byCode = Object.fromEntries(reportValue.warnings.map((warning) => [warning.code, warning]));
  assert.equal(byCode.BUNDLE_ROLE_UNUSED.path, 'roles/spare.md');
  assert.equal(byCode.BUNDLE_TASK_UNUSED.path, 'tasks/spare.md');
  assert.equal(byCode.BUNDLE_SKILL_UNUSED.path, 'skills/spare/SKILL.md');
});

test('a skill preloaded by a role counts as used even without a step reference', () => {
  const reportValue = report({
    manifest: { skills: ['helper', 'spare'] },
    overrides: {
      'roles/worker.md': '---\nid: worker\ndescription: Executes the step.\nskills:\n  - helper\n  - spare\n---\n\nInstructions.\n',
      'skills/spare/SKILL.md': SPARE_SKILL,
    },
  });
  assert.equal(reportValue.ok, true);
  assert.ok(!codes(reportValue, 'warnings').includes('BUNDLE_SKILL_UNUSED'));
});

test('a step without skills warns when the bundle declares skills', () => {
  const diagnostic = only(report({
    overrides: {
      'roles/worker.md': '---\nid: worker\ndescription: Executes the step.\nskills:\n  - helper\n---\n\nInstructions.\n',
      [STAGE_PATH]: stageValue((stage) => { stage.steps[0].skills = []; }),
    },
  }), 'warnings');
  assert.equal(diagnostic.code, 'BUNDLE_STEP_NO_SKILLS');
  assert.equal(diagnostic.path, STAGE_PATH);
  assert.equal(diagnostic.pointer, '/steps/0/skills');
  assert.deepEqual(diagnostic.details, { step: 'only-step' });

  const noneDeclared = validateBundle(buildZip(minimalFiles({
    'bundle.json': canonicalJson({ ...MINIMAL_MANIFEST, skills: [] }),
    'skills/helper/SKILL.md': null,
    'stages/only.json': stageValue((stage) => { stage.steps[0].skills = []; }),
  })), PRIMITIVES);
  assert.equal(noneDeclared.ok, true);
  assert.ok(!codes(noneDeclared, 'warnings').includes('BUNDLE_STEP_NO_SKILLS'));
});

test('an incomplete stage set suppresses the unused warnings (S8)', () => {
  const reportValue = report({
    manifest: { roles: ['worker', 'spare'], tasks: ['do-it', 'spare'], skills: ['helper', 'spare'] },
    overrides: {
      [STAGE_PATH]: null,
      'roles/spare.md': SPARE_ROLE,
      'tasks/spare.md': MINIMAL_TASK,
      'skills/spare/SKILL.md': SPARE_SKILL,
    },
  });
  assert.ok(codes(reportValue).includes('BUNDLE_STAGE_FILE_MISSING'));
  const warnings = codes(reportValue, 'warnings');
  assert.ok(!warnings.includes('BUNDLE_ROLE_UNUSED'));
  assert.ok(!warnings.includes('BUNDLE_TASK_UNUSED'));
  assert.ok(!warnings.includes('BUNDLE_SKILL_UNUSED'));
  assert.ok(!warnings.includes('BUNDLE_STEP_NO_SKILLS'));
});

test('cross-reference reports are deterministic', () => {
  const options = {
    manifest: { roles: ['worker', 'spare'], skills: ['helper', 'spare'] },
    overrides: {
      [STAGE_PATH]: stageValue((stage) => {
        stage.steps[0].role = 'ghost';
        stage.steps[0].task = 'ghost';
        stage.steps[0].skills = ['ghost'];
      }),
      'roles/spare.md': SPARE_ROLE,
      'skills/spare/SKILL.md': SPARE_SKILL,
    },
  };
  const first = report(options);
  assert.deepEqual(first, report(options));
  assert.ok(first.errors.length >= 3, JSON.stringify(first.errors));
});

test('BUNDLE_STEP_NO_SKILLS is suppressed when the stage set is incomplete (S8)', () => {
  const reportValue = report({
    manifest: { stages: ['only', 'missing'] },
    overrides: {
      [STAGE_PATH]: stageValue((stage) => { stage.steps[0].skills = []; }),
    },
  });
  assert.ok(codes(reportValue).includes('BUNDLE_STAGE_FILE_MISSING'));
  assert.ok(!codes(reportValue, 'warnings').includes('BUNDLE_STEP_NO_SKILLS'));
});

test('a malformed skills field is one BUNDLE_SCHEMA_INVALID, not a no-skills warning too', () => {
  const reportValue = report({
    overrides: {
      [STAGE_PATH]: stageValue((stage) => { stage.steps[0].skills = 'helper'; }),
    },
  });
  const errors = codes(reportValue);
  assert.ok(errors.includes('BUNDLE_SCHEMA_INVALID'));
  assert.ok(!codes(reportValue, 'warnings').includes('BUNDLE_STEP_NO_SKILLS'));
});
