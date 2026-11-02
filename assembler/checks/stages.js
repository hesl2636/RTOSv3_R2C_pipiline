/**
 * Stage and step checks (decision #67 §7.3).
 *
 * Stages iterate in `bundle.json.stages` order; steps in the stage file's
 * array order. Nothing is sorted here: order is the execution order.
 */
import { codePointLength } from '../../core/code-point.js';
import { isValidGlob } from '../../core/glob.js';
import { ID_MAX, isValidId } from '../ids.js';
import { isPlainObject } from '../util.js';
import { readJsonDocument, findKeyOrderViolation } from './json.js';
import { checkUnknownKeys } from './manifest.js';

const STAGE_KEYS = ['id', 'name', 'description', 'steps'];
const STEP_KEYS = ['id', 'name', 'role', 'task', 'skills', 'outputs', 'gates'];
const GATE_KEYS = ['command', 'timeout'];

function schemaInvalid(context, path, pointer, rule, message) {
  context.fail(path, 'BUNDLE_SCHEMA_INVALID', message, { pointer, details: { pointer, rule } });
}

function lengthProblem(value, minimum, maximum) {
  if (typeof value !== 'string') return 'type';
  const length = codePointLength(value);
  if (length < minimum) return 'minLength';
  if (length > maximum) return 'maxLength';
  return null;
}

function isIdString(value) {
  return typeof value === 'string' && isValidId(value, ID_MAX);
}

function stageKeyOrder(value) {
  if (!isPlainObject(value)) return null;
  const top = findKeyOrderViolation(value, STAGE_KEYS);
  if (top !== null) return top;
  if (!Array.isArray(value.steps)) return null;
  for (const step of value.steps) {
    if (!isPlainObject(step)) continue;
    const stepViolation = findKeyOrderViolation(step, STEP_KEYS);
    if (stepViolation !== null) return stepViolation;
    if (!Array.isArray(step.gates)) continue;
    for (const gate of step.gates) {
      if (!isPlainObject(gate)) continue;
      const gateViolation = findKeyOrderViolation(gate, GATE_KEYS);
      if (gateViolation !== null) return gateViolation;
    }
  }
  return null;
}

function outputPathReason(output) {
  if (typeof output !== 'string') return 'type';
  if (output === '') return null;
  if (output.startsWith('/') || /^[A-Za-z]:/.test(output)) return 'absolute';
  if (output.includes('\\')) return 'backslash';
  if (output.split('/').includes('..')) return 'traversal';
  return null;
}

function targetsSkill(output) {
  if (typeof output !== 'string') return false;
  return output.replaceAll('\\', '/').split('/').some((segment) => {
    const lower = segment.toLowerCase();
    return lower === 'skills' || lower === 'skill.md';
  });
}

function checkOutputs(context, path, pointerBase, outputs) {
  if (!Array.isArray(outputs)) {
    schemaInvalid(context, path, pointerBase, 'type', "'outputs' must be an array");
    return;
  }
  outputs.forEach((output, index) => {
    const pointer = `${pointerBase}/${index}`;
    if (typeof output !== 'string') {
      schemaInvalid(context, path, pointer, 'type', 'output must be a string');
      return;
    }
    if (!isValidGlob(output)) {
      context.fail(path, 'BUNDLE_OUTPUT_INVALID_GLOB', 'output is not a valid glob', {
        pointer,
        details: { pointer },
      });
    }
    const reason = outputPathReason(output);
    if (reason !== null && reason !== 'type') {
      context.fail(path, 'BUNDLE_OUTPUT_PATH_INVALID', 'output path is invalid', {
        pointer,
        details: { reason },
      });
    }
    if (targetsSkill(output)) {
      context.fail(path, 'BUNDLE_OUTPUT_FORBIDDEN', 'output must not target the skill payload', {
        pointer,
        details: { pointer },
      });
    }
  });
}

function checkGates(context, path, pointerBase, gates) {
  if (!Array.isArray(gates)) {
    schemaInvalid(context, path, pointerBase, 'type', "'gates' must be an array");
    return;
  }
  gates.forEach((gate, index) => {
    const base = `${pointerBase}/${index}`;
    if (!isPlainObject(gate)) {
      schemaInvalid(context, path, base, 'type', 'gate must be an object');
      return;
    }
    checkUnknownKeys(context, path, gate, GATE_KEYS, base);
    const commandPointer = `${base}/command`;
    if (typeof gate.command !== 'string' || gate.command.trim() === ''
      || codePointLength(gate.command) > 2000) {
      context.fail(path, 'BUNDLE_GATE_INVALID', 'gate command is invalid', {
        pointer: commandPointer,
        details: { pointer: commandPointer, field: 'command' },
      });
    }
    if (gate.timeout !== undefined) {
      const timeout = gate.timeout;
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) {
        const timeoutPointer = `${base}/timeout`;
        context.fail(path, 'BUNDLE_GATE_INVALID', 'gate timeout is invalid', {
          pointer: timeoutPointer,
          details: { pointer: timeoutPointer, field: 'timeout' },
        });
      }
    }
  });
}

function checkStep(context, stageRecord, step, index) {
  const path = stageRecord.path;
  const base = `/steps/${index}`;
  if (!isPlainObject(step)) {
    schemaInvalid(context, path, base, 'type', 'step must be an object');
    context.complete.stages = false;
    return null;
  }
  checkUnknownKeys(context, path, step, STEP_KEYS, base);

  for (const key of ['id', 'name', 'task']) {
    if (step[key] === undefined) schemaInvalid(context, path, `${base}/${key}`, 'required', `step is missing '${key}'`);
  }

  if (step.id !== undefined) {
    if (!isIdString(step.id)) {
      context.fail(path, 'BUNDLE_STEP_ID_INVALID', 'step id is invalid', {
        pointer: `${base}/id`,
        details: { pointer: `${base}/id`, value: step.id },
      });
    } else if (context.stepIds.has(step.id)) {
      const first = context.stepFirst.get(step.id);
      context.fail(path, 'BUNDLE_STEP_DUPLICATE', `duplicate step id: ${step.id}`, {
        pointer: `${base}/id`,
        details: { first: `${first.path}#${first.pointer}` },
      });
    } else {
      context.stepIds.add(step.id);
      context.stepFirst.set(step.id, { path, pointer: `${base}/id` });
    }
  }

  if (step.name !== undefined) {
    const problem = lengthProblem(step.name, 1, 120);
    if (problem !== null) schemaInvalid(context, path, `${base}/name`, problem, 'step name must be 1-120 characters');
  }

  if (step.role !== undefined && !isIdString(step.role)) {
    schemaInvalid(context, path, `${base}/role`, 'pattern', 'step role must be a bare id');
  }
  if (step.task !== undefined && !isIdString(step.task)) {
    schemaInvalid(context, path, `${base}/task`, 'pattern', 'step task must be a bare id');
  }

  if (step.skills !== undefined) {
    if (!Array.isArray(step.skills)) {
      schemaInvalid(context, path, `${base}/skills`, 'type', "'skills' must be an array");
    } else {
      step.skills.forEach((skill, skillIndex) => {
        if (!isIdString(skill)) {
          schemaInvalid(context, path, `${base}/skills/${skillIndex}`, 'pattern', 'skill entry must be a bare id');
        }
      });
    }
  }

  // S10: without `task` the step is not a valid execution unit, so its
  // output/gate and reference checks are suppressed instead of cascading.
  if (step.task === undefined) {
    context.complete.stages = false;
    return {
      id: step.id,
      name: step.name,
      role: step.role,
      task: undefined,
      skills: Array.isArray(step.skills) ? [...step.skills] : [],
      skillsValid: Array.isArray(step.skills),
      pointer: base,
      references: false,
    };
  }

  const outputs = step.outputs === undefined ? [] : step.outputs;
  checkOutputs(context, path, `${base}/outputs`, outputs);
  const gates = step.gates === undefined ? [] : step.gates;
  checkGates(context, path, `${base}/gates`, gates);

  return {
    id: step.id,
    name: step.name,
    role: step.role,
    task: step.task,
    skills: Array.isArray(step.skills) ? [...step.skills] : [],
    skillsValid: Array.isArray(step.skills),
    pointer: base,
    references: true,
  };
}

export function check(context) {
  if (context.skipped.stages) return;
  if (context.declaredValid.stages === false) return;
  const stageFiles = [];
  for (const entry of context.entries.values()) {
    if (entry.path.startsWith('stages/')) stageFiles.push(entry.path);
  }
  const declared = context.declared.stages;
  const present = new Map();
  for (const path of stageFiles) {
    const match = /^stages\/([^/]+)\.json$/.exec(path);
    if (match === null) continue;
    present.set(match[1], path);
  }

  for (const id of declared) {
    const path = `stages/${id}.json`;
    if (!context.entries.has(path)) {
      if (!context.rejectedPaths.has(path)) {
        context.fail(path, 'BUNDLE_STAGE_FILE_MISSING', `declared stage '${id}' has no stage file`, {
          details: { id },
        });
      }
      // S4 keeps the container root cause, S8 still suppresses unused warnings.
      context.complete.stages = false;
    }
  }
  for (const [id, path] of present) {
    if (!declared.includes(id)) {
      context.fail(path, 'BUNDLE_STAGE_FILE_UNDECLARED', 'stage file is not declared in bundle.json.stages', {
        details: { id },
      });
    }
  }

  const records = [];
  let stepCount = 0;
  for (const id of declared) {
    const path = `stages/${id}.json`;
    const entry = context.entries.get(path);
    if (entry === undefined) continue;
    const text = context.texts.get(path);
    if (text === undefined) {
      context.complete.stages = false;
      continue;
    }
    const document = readJsonDocument(context, path, text, { order: stageKeyOrder });
    if (document === null) {
      context.complete.stages = false;
      continue;
    }
    const { value } = document;
    if (!isPlainObject(value)) {
      schemaInvalid(context, path, '', 'type', 'stage file must be a JSON object');
      context.complete.stages = false;
      continue;
    }
    checkUnknownKeys(context, path, value, STAGE_KEYS);

    if (value.id === undefined) {
      schemaInvalid(context, path, '/id', 'required', "stage is missing 'id'");
    } else if (!isIdString(value.id)) {
      context.fail(path, 'BUNDLE_STAGE_ID_INVALID', 'stage id is invalid', {
        pointer: '/id',
        details: { where: 'file', value: value.id },
      });
    } else if (value.id !== id) {
      context.fail(path, 'BUNDLE_STAGE_ID_MISMATCH', 'stage id does not match the file name', {
        pointer: '/id',
        details: { declared: id, stem: id, actual: value.id },
      });
    }
    if (value.name !== undefined) {
      const problem = lengthProblem(value.name, 1, 120);
      if (problem !== null) schemaInvalid(context, path, '/name', problem, 'stage name must be 1-120 characters');
    } else {
      schemaInvalid(context, path, '/name', 'required', "stage is missing 'name'");
    }
    if (value.description !== undefined) {
      const problem = lengthProblem(value.description, 1, 2000);
      if (problem !== null) schemaInvalid(context, path, '/description', problem, 'stage description must be 1-2000 characters');
    }

    const record = { id, path, value, text, bytes: entry.data, steps: [] };
    if (!Array.isArray(value.steps)) {
      schemaInvalid(context, path, '/steps', value.steps === undefined ? 'required' : 'type', "'steps' must be an array");
      context.complete.stages = false;
    } else if (value.steps.length === 0) {
      context.fail(path, 'BUNDLE_STAGE_EMPTY', 'stage has no steps', { pointer: '/steps' });
    } else {
      value.steps.forEach((step, index) => {
        const parsed = checkStep(context, record, step, index);
        if (parsed !== null) record.steps.push(parsed);
      });
      stepCount += value.steps.length;
    }
    records.push(record);
  }

  context.stages = records;
  context.counts.steps = stepCount;
}
