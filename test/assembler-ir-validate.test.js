import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { validateIr } from '../assembler/validate-ir.js';
import { minimalZip } from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };

function baseIr() {
  const compiled = compileBundle(minimalZip(), PRIMITIVES);
  assert.equal(compiled.ok, true);
  return JSON.parse(new TextDecoder().decode(compiled.irBytes));
}

function codesFor(bytes) {
  return validateIr(bytes, { sha256: sha256Hex }).errors.map((error) => `${error.code}@${error.pointer}`);
}

function mutated(mutate) {
  const ir = baseIr();
  mutate(ir);
  return codesFor(new TextEncoder().encode(canonicalJson(ir)));
}

function expectCode(codes, code, pointer) {
  assert.ok(
    codes.some((entry) => entry === `${code}@${pointer}`),
    `expected ${code}@${pointer}, got ${JSON.stringify(codes)}`,
  );
}

test('IR validation covers schema, canonical bytes and parsing', () => {
  assert.deepEqual(codesFor(new TextEncoder().encode('{')), ['IR_JSON_PARSE@']);
  const ir = baseIr();
  assert.deepEqual(codesFor(new TextEncoder().encode(JSON.stringify(ir))), ['IR_JSON_NOT_CANONICAL@']);
  assert.deepEqual(
    codesFor(new TextEncoder().encode(canonicalJson({ ...ir, schema: 'hm2b.ir/v3' }))),
    ['IR_SCHEMA_UNSUPPORTED@/schema'],
  );
  assert.deepEqual(
    codesFor(new TextEncoder().encode(canonicalJson({ ...ir, schema: 'other' }))),
    ['IR_SCHEMA_UNSUPPORTED@/schema'],
  );
});

test('IR validation covers keys, order and runtime leaks', () => {
  expectCode(mutated((ir) => { ir.extra = true; }), 'IR_UNKNOWN_KEY', '/extra');
  expectCode(mutated((ir) => { ir.stages[0].steps[0].type = 'prompt'; }), 'IR_RUNTIME_FIELD_LEAK', '/stages/0/steps/0/type');
  expectCode(mutated((ir) => { ir.stages[0].steps[0].skills = ['helper', 'aaa']; }), 'IR_ORDER_INVALID', '/stages/0/steps/0/skills');
  expectCode(
    mutated((ir) => {
      const { source, ...rest } = ir;
      for (const key of Object.keys(ir)) delete ir[key];
      Object.assign(ir, rest, { source });
    }),
    'IR_ORDER_INVALID',
    '',
  );
  expectCode(
    mutated((ir) => {
      ir.roles['aaa'] = { ...ir.roles.worker, description: 'extra' };
    }),
    'IR_ORDER_INVALID',
    '/roles',
  );
});

test('IR validation covers source identity, paths and hashes', () => {
  expectCode(mutated((ir) => { ir.source.bundle.id = 'other'; }), 'IR_SOURCE_MISMATCH', '/id');
  expectCode(mutated((ir) => { ir.source.manifest.path = 'other.json'; }), 'IR_SOURCE_MISMATCH', '/source/manifest/path');
  expectCode(
    mutated((ir) => { ir.stages[0].source.path = 'stages/other.json'; }),
    'IR_SOURCE_PATH_MISMATCH',
    '/stages/0/source/path',
  );
  expectCode(
    mutated((ir) => { ir.roles.worker.source.sha256 = '0'.repeat(64); }),
    'IR_HASH_MISMATCH',
    '/source/bundle/contentSha256',
  );
});

test('IR validation covers duplicates and references', () => {
  expectCode(mutated((ir) => { ir.stages.push({ ...ir.stages[0], steps: [] }); }), 'IR_STAGE_DUPLICATE', '/stages/1/id');
  expectCode(
    mutated((ir) => { ir.stages[0].steps.push({ ...ir.stages[0].steps[0] }); }),
    'IR_STEP_DUPLICATE',
    '/stages/0/steps/1/id',
  );
  expectCode(mutated((ir) => { ir.stages[0].steps[0].task = 'nope'; }), 'IR_STEP_REF_UNDECLARED', '/stages/0/steps/0/task');
  expectCode(mutated((ir) => { ir.stages[0].steps[0].role = 'nope'; }), 'IR_STEP_REF_UNDECLARED', '/stages/0/steps/0/role');
  expectCode(
    mutated((ir) => { ir.stages[0].steps[0].skills = ['nope']; }),
    'IR_STEP_REF_UNDECLARED',
    '/stages/0/steps/0/skills/0',
  );
});

test('IR validation covers outputs and gates', () => {
  expectCode(mutated((ir) => { ir.stages[0].steps[0].outputs = ['a{b']; }), 'IR_OUTPUT_INVALID_GLOB', '/stages/0/steps/0/outputs/0');
  expectCode(mutated((ir) => { ir.stages[0].steps[0].outputs = ['/abs']; }), 'IR_OUTPUT_PATH_INVALID', '/stages/0/steps/0/outputs/0');
  expectCode(mutated((ir) => { ir.stages[0].steps[0].outputs = ['skills/x']; }), 'IR_OUTPUT_FORBIDDEN', '/stages/0/steps/0/outputs/0');
  expectCode(mutated((ir) => { ir.stages[0].steps[0].gates = [{ command: ' ' }]; }), 'IR_GATE_INVALID', '/stages/0/steps/0/gates/0/command');
  expectCode(
    mutated((ir) => { ir.stages[0].steps[0].gates = [{ command: 'true', timeout: 0 }]; }),
    'IR_GATE_INVALID',
    '/stages/0/steps/0/gates/0/timeout',
  );
});

test('IR validation covers embedded bodies and text encoding', () => {
  expectCode(mutated((ir) => { ir.tasks['do-it'].body = 'not a task\n'; }), 'IR_TASK_BODY_INVALID', '/tasks/do-it/body');
  expectCode(mutated((ir) => { ir.roles.worker.instructions = ''; }), 'IR_ROLE_BODY_INVALID', '/roles/worker/instructions');
  expectCode(mutated((ir) => { ir.roles.worker.description = ''; }), 'IR_ROLE_BODY_INVALID', '/roles/worker/description');
  expectCode(mutated((ir) => { ir.skills.helper.body = ''; }), 'IR_SKILL_BODY_INVALID', '/skills/helper/body');
  expectCode(
    mutated((ir) => {
      ir.skills.helper.placeholder = true;
      ir.skills.helper.body = '# helper\n\nno banner\n';
    }),
    'IR_SKILL_BODY_INVALID',
    '/skills/helper/body',
  );
  expectCode(
    mutated((ir) => { ir.tasks['do-it'].body = ir.tasks['do-it'].body.replace('\n', '\r\n'); }),
    'IR_TEXT_ENCODING',
    '/tasks/do-it/body',
  );
});

test('IR validation covers constitution shape and scope', () => {
  const mount = {
    scope: 'global',
    placeholder: false,
    body: 'rules\n',
    source: { path: 'constitution/CONSTITUTION.md', sha256: '1'.repeat(64) },
  };
  expectCode(
    mutated((ir) => { ir.constitution = [{ ...mount, body: '---\nrules\n' }]; }),
    'IR_CONSTITUTION_INVALID',
    '/constitution/0/body',
  );
  expectCode(
    mutated((ir) => { ir.constitution = [{ ...mount, body: '' }]; }),
    'IR_CONSTITUTION_INVALID',
    '/constitution/0/body',
  );
  expectCode(
    mutated((ir) => { ir.constitution = [{ ...mount, placeholder: true, body: 'x'.repeat(65 * 1024) }]; }),
    'IR_CONSTITUTION_INVALID',
    '/constitution/0/body',
  );
  expectCode(
    mutated((ir) => { ir.constitution = [{ ...mount, scope: 'stage', target: 'only', body: 'ok\n' }]; }),
    'IR_CONSTITUTION_SCOPE',
    '/constitution/0/scope',
  );
  expectCode(
    mutated((ir) => { ir.constitution = [{ ...mount, body: 'ok\n' }, { ...mount, body: 'ok2\n' }]; }),
    'IR_CONSTITUTION_SCOPE',
    '/constitution',
  );
});
