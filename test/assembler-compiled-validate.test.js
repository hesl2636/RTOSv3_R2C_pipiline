import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { validateCompiledWorkflow } from '../assembler/validate-compiled.js';
import { minimalZip } from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };

function baseCompiledWorkflow() {
  const compiled = compileBundle(minimalZip(), PRIMITIVES);
  assert.equal(compiled.ok, true);
  return JSON.parse(new TextDecoder().decode(compiled.compiledWorkflowBytes));
}

function codesFor(bytes) {
  return validateCompiledWorkflow(bytes, { sha256: sha256Hex }).errors.map((error) => `${error.code}@${error.pointer}`);
}

function mutated(mutate) {
  const compiledWorkflow = baseCompiledWorkflow();
  mutate(compiledWorkflow);
  return codesFor(new TextEncoder().encode(canonicalJson(compiledWorkflow)));
}

function expectCode(codes, code, pointer) {
  assert.ok(
    codes.some((entry) => entry === `${code}@${pointer}`),
    `expected ${code}@${pointer}, got ${JSON.stringify(codes)}`,
  );
}

test('compiled workflow validation covers schema, canonical bytes and parsing', () => {
  assert.deepEqual(codesFor(new TextEncoder().encode('{')), ['COMPILED_WORKFLOW_JSON_PARSE@']);
  const compiledWorkflow = baseCompiledWorkflow();
  assert.deepEqual(codesFor(new TextEncoder().encode(JSON.stringify(compiledWorkflow))), ['COMPILED_WORKFLOW_JSON_NOT_CANONICAL@']);
  assert.deepEqual(
    codesFor(new TextEncoder().encode(canonicalJson({ ...compiledWorkflow, schema: 'hm2b.compiled-workflow/v3' }))),
    ['COMPILED_WORKFLOW_SCHEMA_UNSUPPORTED@/schema'],
  );
  assert.deepEqual(
    codesFor(new TextEncoder().encode(canonicalJson({ ...compiledWorkflow, schema: 'other' }))),
    ['COMPILED_WORKFLOW_SCHEMA_UNSUPPORTED@/schema'],
  );
});

test('compiled workflow validation covers keys, order and runtime leaks', () => {
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.extra = true; }), 'COMPILED_WORKFLOW_UNKNOWN_KEY', '/extra');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].type = 'prompt'; }), 'COMPILED_WORKFLOW_RUNTIME_FIELD_LEAK', '/stages/0/steps/0/type');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].skills = ['helper', 'aaa']; }), 'COMPILED_WORKFLOW_ORDER_INVALID', '/stages/0/steps/0/skills');
  expectCode(
    mutated((compiledWorkflow) => {
      const { source, ...rest } = compiledWorkflow;
      for (const key of Object.keys(compiledWorkflow)) delete compiledWorkflow[key];
      Object.assign(compiledWorkflow, rest, { source });
    }),
    'COMPILED_WORKFLOW_ORDER_INVALID',
    '',
  );
  expectCode(
    mutated((compiledWorkflow) => {
      compiledWorkflow.roles['aaa'] = { ...compiledWorkflow.roles.worker, description: 'extra' };
    }),
    'COMPILED_WORKFLOW_ORDER_INVALID',
    '/roles',
  );
});

test('compiled workflow validation covers source identity, paths and hashes', () => {
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.source.bundle.id = 'other'; }), 'COMPILED_WORKFLOW_SOURCE_MISMATCH', '/id');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.source.manifest.path = 'other.json'; }), 'COMPILED_WORKFLOW_SOURCE_MISMATCH', '/source/manifest/path');
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.stages[0].source.path = 'stages/other.json'; }),
    'COMPILED_WORKFLOW_SOURCE_PATH_MISMATCH',
    '/stages/0/source/path',
  );
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.roles.worker.source.sha256 = '0'.repeat(64); }),
    'COMPILED_WORKFLOW_HASH_MISMATCH',
    '/source/bundle/contentSha256',
  );
});

test('compiled workflow validation covers duplicates and references', () => {
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages.push({ ...compiledWorkflow.stages[0], steps: [] }); }), 'COMPILED_WORKFLOW_STAGE_DUPLICATE', '/stages/1/id');
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps.push({ ...compiledWorkflow.stages[0].steps[0] }); }),
    'COMPILED_WORKFLOW_STEP_DUPLICATE',
    '/stages/0/steps/1/id',
  );
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].task = 'nope'; }), 'COMPILED_WORKFLOW_STEP_REF_UNDECLARED', '/stages/0/steps/0/task');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].role = 'nope'; }), 'COMPILED_WORKFLOW_STEP_REF_UNDECLARED', '/stages/0/steps/0/role');
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].skills = ['nope']; }),
    'COMPILED_WORKFLOW_STEP_REF_UNDECLARED',
    '/stages/0/steps/0/skills/0',
  );
});

test('compiled workflow validation covers outputs and gates', () => {
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].outputs = ['a{b']; }), 'COMPILED_WORKFLOW_OUTPUT_INVALID_GLOB', '/stages/0/steps/0/outputs/0');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].outputs = ['/abs']; }), 'COMPILED_WORKFLOW_OUTPUT_PATH_INVALID', '/stages/0/steps/0/outputs/0');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].outputs = ['skills/x']; }), 'COMPILED_WORKFLOW_OUTPUT_FORBIDDEN', '/stages/0/steps/0/outputs/0');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].gates = [{ command: ' ' }]; }), 'COMPILED_WORKFLOW_GATE_INVALID', '/stages/0/steps/0/gates/0/command');
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.stages[0].steps[0].gates = [{ command: 'true', timeout: 0 }]; }),
    'COMPILED_WORKFLOW_GATE_INVALID',
    '/stages/0/steps/0/gates/0/timeout',
  );
});

test('compiled workflow validation covers embedded bodies and text encoding', () => {
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.tasks['do-it'].body = 'not a task\n'; }), 'COMPILED_WORKFLOW_TASK_BODY_INVALID', '/tasks/do-it/body');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.roles.worker.instructions = ''; }), 'COMPILED_WORKFLOW_ROLE_BODY_INVALID', '/roles/worker/instructions');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.roles.worker.description = ''; }), 'COMPILED_WORKFLOW_ROLE_BODY_INVALID', '/roles/worker/description');
  expectCode(mutated((compiledWorkflow) => { compiledWorkflow.skills.helper.body = ''; }), 'COMPILED_WORKFLOW_SKILL_BODY_INVALID', '/skills/helper/body');
  expectCode(
    mutated((compiledWorkflow) => {
      compiledWorkflow.skills.helper.placeholder = true;
      compiledWorkflow.skills.helper.body = '# helper\n\nno banner\n';
    }),
    'COMPILED_WORKFLOW_SKILL_BODY_INVALID',
    '/skills/helper/body',
  );
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.tasks['do-it'].body = compiledWorkflow.tasks['do-it'].body.replace('\n', '\r\n'); }),
    'COMPILED_WORKFLOW_TEXT_ENCODING',
    '/tasks/do-it/body',
  );
});

test('compiled workflow validation covers constitution shape and scope', () => {
  const mount = {
    scope: 'global',
    placeholder: false,
    body: 'rules\n',
    source: { path: 'constitution/CONSTITUTION.md', sha256: '1'.repeat(64) },
  };
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.constitution = [{ ...mount, body: '---\nrules\n' }]; }),
    'COMPILED_WORKFLOW_CONSTITUTION_INVALID',
    '/constitution/0/body',
  );
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.constitution = [{ ...mount, body: '' }]; }),
    'COMPILED_WORKFLOW_CONSTITUTION_INVALID',
    '/constitution/0/body',
  );
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.constitution = [{ ...mount, placeholder: true, body: 'x'.repeat(65 * 1024) }]; }),
    'COMPILED_WORKFLOW_CONSTITUTION_INVALID',
    '/constitution/0/body',
  );
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.constitution = [{ ...mount, scope: 'stage', target: 'only', body: 'ok\n' }]; }),
    'COMPILED_WORKFLOW_CONSTITUTION_SCOPE',
    '/constitution/0/scope',
  );
  expectCode(
    mutated((compiledWorkflow) => { compiledWorkflow.constitution = [{ ...mount, body: 'ok\n' }, { ...mount, body: 'ok2\n' }]; }),
    'COMPILED_WORKFLOW_CONSTITUTION_SCOPE',
    '/constitution',
  );
});
