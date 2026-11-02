/**
 * Manifest checks (`bundle.json`, decision #67 §7.2).
 *
 * A manifest that cannot be parsed or does not carry `r2c.bundle/v1` stops the
 * content phases (S0/S1): declarations are unknown, so "declared vs present"
 * cannot be judged and must not cascade into dozens of follow-up errors.
 */
import { codePointLength } from '../../core/code-point.js';
import { parseSchemaId } from '../../core/schema.js';
import { isValidRange } from '../../core/semver.js';
import {
  BUNDLE_ID_MAX,
  ID_MAX,
  PROJECTION_IDS,
  VERSION_RE,
  isValidId,
} from '../ids.js';
import { isPlainObject } from '../util.js';
import { readJsonDocument, findKeyOrderViolation } from './json.js';

export const BUNDLE_SCHEMA = 'r2c.bundle/v1';
export const CONSTITUTION_PATH = 'constitution/CONSTITUTION.md';

const MANIFEST_KEYS = [
  'schema',
  'id',
  'name',
  'version',
  'description',
  'stages',
  'roles',
  'tasks',
  'skills',
  'constitution',
  'requires',
];

const CONSTITUTION_KEYS = ['path', 'placeholder'];
const REQUIRES_KEYS = ['engine', 'projections'];

function manifestKeyOrder(value) {
  if (!isPlainObject(value)) return null;
  const top = findKeyOrderViolation(value, MANIFEST_KEYS);
  if (top !== null) return top;
  if (isPlainObject(value.constitution)) {
    const constitution = findKeyOrderViolation(value.constitution, CONSTITUTION_KEYS);
    if (constitution !== null) return constitution;
  }
  if (isPlainObject(value.requires)) {
    const requires = findKeyOrderViolation(value.requires, REQUIRES_KEYS);
    if (requires !== null) return requires;
  }
  return null;
}

function pointerSegment(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

export function checkUnknownKeys(context, path, value, allowed, base = '') {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const pointer = `${base}/${pointerSegment(key)}`;
    context.fail(path, 'BUNDLE_UNKNOWN_KEY', `unknown key: ${key}`, { pointer, details: { pointer, key } });
  }
}

function schemaInvalid(context, path, pointer, rule, message, extra = {}) {
  context.fail(path, 'BUNDLE_SCHEMA_INVALID', message, {
    pointer,
    details: { pointer, rule, ...extra },
  });
}

function lengthProblem(value, minimum, maximum) {
  if (typeof value !== 'string') return 'type';
  const length = codePointLength(value);
  if (length < minimum) return 'minLength';
  if (length > maximum) return 'maxLength';
  return null;
}

function readIdArray(context, path, manifest, key, options) {
  const {
    required, kind, max, minItems, invalidCode, reserved = [],
  } = options;
  const value = manifest[key];
  if (value === undefined || value === null) {
    if (required) {
      schemaInvalid(context, path, `/${key}`, 'required', `manifest is missing '${key}'`);
      context.declaredValid[`${kind}s`] = false;
    }
    return null;
  }
  if (!Array.isArray(value)) {
    schemaInvalid(context, path, `/${key}`, 'type', `'${key}' must be an array`);
    context.declaredValid[`${kind}s`] = false;
    return null;
  }
  if (minItems !== undefined && value.length < minItems) {
    schemaInvalid(context, path, `/${key}`, 'minItems', `'${key}' must have at least ${minItems} item(s)`);
    context.declaredValid[`${kind}s`] = false;
  }
  const seen = new Set();
  const valid = [];
  value.forEach((item, index) => {
    const pointer = `/${key}/${index}`;
    if (typeof item !== 'string') {
      schemaInvalid(context, path, pointer, 'type', `'${key}[${index}]' must be a string`);
      context.declaredValid[`${kind}s`] = false;
      return;
    }
    if (seen.has(item)) {
      schemaInvalid(context, path, pointer, 'uniqueItems', `duplicate '${key}' entry: ${item}`);
      context.declaredValid[`${kind}s`] = false;
      return;
    }
    seen.add(item);
    if (!isValidId(item, max)) {
      context.fail(path, invalidCode, `${kind} id is invalid`, {
        pointer,
        details: { where: 'manifest', value: item },
      });
      context.declaredValid[`${kind}s`] = false;
      return;
    }
    if (reserved.includes(item)) {
      const code = kind === 'role' ? 'BUNDLE_ROLE_ID_RESERVED' : 'BUNDLE_SKILL_ID_RESERVED';
      context.fail(path, code, `${kind} id is reserved: ${item}`, { pointer, details: { value: item } });
    }
    valid.push(item);
  });
  return valid;
}

export function check(context) {
  if (context.skipped.manifest) return;
  const path = 'bundle.json';
  if (!context.entries.has(path)) {
    context.fail(path, 'BUNDLE_MANIFEST_MISSING', 'bundle.json is missing from the archive root');
    context.skipContent();
    return;
  }
  const text = context.texts.get(path);
  if (text === undefined) {
    context.skipContent();
    return;
  }

  const document = readJsonDocument(context, path, text, {
    order: manifestKeyOrder,
  });
  if (document === null) {
    context.skipContent();
    return;
  }
  const { value: manifest } = document;
  if (!isPlainObject(manifest)) {
    schemaInvalid(context, path, '', 'type', 'bundle.json must be a JSON object');
    context.skipContent();
    return;
  }

  const parsedSchema = parseSchemaId(manifest.schema);
  if (manifest.schema !== BUNDLE_SCHEMA) {
    let reason = 'unknown';
    if (typeof manifest.schema !== 'string' || parsedSchema === null) reason = 'malformed';
    else if (parsedSchema.family === 'bundle' && parsedSchema.revision > 1) reason = 'newer';
    context.fail(path, 'BUNDLE_SCHEMA_UNSUPPORTED', 'bundle schema is not supported', {
      pointer: '/schema',
      details: { reason },
    });
    context.skip('stages');
    context.skip('tasks');
    context.skip('entities');
    context.skip('crossrefs');
    return;
  }

  context.manifest = manifest;
  context.manifestBytes = context.entries.get(path).data;

  checkUnknownKeys(context, path, manifest, MANIFEST_KEYS);

  for (const key of ['id', 'name', 'version', 'description', 'stages', 'tasks']) {
    if (manifest[key] === undefined) {
      schemaInvalid(context, path, `/${key}`, 'required', `manifest is missing '${key}'`);
    }
  }

  if (typeof manifest.id === 'string') {
    if (!isValidId(manifest.id, BUNDLE_ID_MAX)) {
      context.fail(path, 'BUNDLE_ID_INVALID', 'bundle id is invalid', {
        pointer: '/id',
        details: { value: manifest.id, reason: 'pattern-or-length' },
      });
    } else if (manifest.id === 'r2c') {
      context.fail(path, 'BUNDLE_ID_RESERVED', 'bundle id "r2c" is reserved', {
        pointer: '/id',
        details: { value: manifest.id },
      });
    }
  } else if (manifest.id !== undefined) {
    schemaInvalid(context, path, '/id', 'type', "'id' must be a string");
  }

  if (manifest.name !== undefined) {
    const problem = lengthProblem(manifest.name, 1, 120);
    if (problem !== null) {
      schemaInvalid(context, path, '/name', problem, "'name' must be 1-120 characters");
    }
  }

  if (manifest.version !== undefined) {
    if (typeof manifest.version !== 'string') {
      schemaInvalid(context, path, '/version', 'type', "'version' must be a string");
    } else if (manifest.version.includes('+')) {
      context.fail(path, 'BUNDLE_VERSION_INVALID', 'version must not carry build metadata', {
        pointer: '/version',
        details: { reason: 'build-metadata' },
      });
    } else if (!VERSION_RE.test(manifest.version)) {
      context.fail(path, 'BUNDLE_VERSION_INVALID', 'version is not strict semver', {
        pointer: '/version',
        details: { reason: 'pattern' },
      });
    }
  }

  if (manifest.description !== undefined) {
    const problem = lengthProblem(manifest.description, 1, 2000);
    if (problem !== null) {
      schemaInvalid(context, path, '/description', problem, "'description' must be 1-2000 characters");
    }
  }

  const declaredStages = readIdArray(context, path, manifest, 'stages', {
    required: true,
    kind: 'stage',
    max: ID_MAX,
    minItems: 1,
    invalidCode: 'BUNDLE_STAGE_ID_INVALID',
  });
  const declaredRoles = readIdArray(context, path, manifest, 'roles', {
    required: false,
    kind: 'role',
    max: ID_MAX,
    invalidCode: 'BUNDLE_ROLE_ID_INVALID',
    reserved: ['main', 'sub'],
  });
  const declaredTasks = readIdArray(context, path, manifest, 'tasks', {
    required: true,
    kind: 'task',
    max: ID_MAX,
    minItems: 1,
    invalidCode: 'BUNDLE_TASK_ID_INVALID',
  });
  const declaredSkills = readIdArray(context, path, manifest, 'skills', {
    required: false,
    kind: 'skill',
    max: ID_MAX,
    invalidCode: 'BUNDLE_SKILL_ID_INVALID',
    reserved: ['synced', 'anthropic-skills'],
  });
  context.declared.stages = declaredStages ?? [];
  context.declared.roles = declaredRoles ?? [];
  context.declared.tasks = declaredTasks ?? [];
  context.declared.skills = declaredSkills ?? [];
  if (declaredStages === null || context.declaredValid.stages === false) context.skip('stages');

  context.constitutionDeclaration = { declared: false, placeholder: false, valid: true };
  if (manifest.constitution !== undefined) {
    const constitution = manifest.constitution;
    if (!isPlainObject(constitution)) {
      schemaInvalid(context, path, '/constitution', 'type', "'constitution' must be an object");
      context.constitutionDeclaration.valid = false;
    } else {
      checkUnknownKeys(context, path, constitution, CONSTITUTION_KEYS, '/constitution');
      if (constitution.path !== CONSTITUTION_PATH) {
        schemaInvalid(context, path, '/constitution/path', 'const', "'constitution.path' must be the fixed path");
      }
      if (constitution.placeholder !== undefined && typeof constitution.placeholder !== 'boolean') {
        schemaInvalid(context, path, '/constitution/placeholder', 'type', "'constitution.placeholder' must be a boolean");
      }
      context.constitutionDeclaration = {
        declared: true,
        placeholder: constitution.placeholder === true,
        valid: true,
      };
    }
  }

  if (manifest.requires !== undefined) {
    checkRequires(context, path, manifest.requires);
  }

  context.counts.stages = context.declared.stages.length;
  context.counts.roles = context.declared.roles.length;
  context.counts.tasks = context.declared.tasks.length;
  context.counts.skills = context.declared.skills.length;
  context.counts.constitutions = context.constitutionDeclaration.declared ? 1 : 0;
}

function checkRequires(context, path, requires) {
  if (!isPlainObject(requires)) {
    context.fail(path, 'BUNDLE_REQUIRES_INVALID', "'requires' must be an object", {
      pointer: '/requires',
      details: { pointer: '/requires', reason: 'type' },
    });
    return;
  }
  const keys = Object.keys(requires);
  if (keys.length === 0) {
    context.fail(path, 'BUNDLE_REQUIRES_INVALID', "'requires' must declare at least one key", {
      pointer: '/requires',
      details: { pointer: '/requires', reason: 'empty' },
    });
  }
  for (const key of keys) {
    if (key !== 'engine' && key !== 'projections') {
      context.fail(path, 'BUNDLE_REQUIRES_INVALID', `unknown requires key: ${key}`, {
        pointer: `/requires/${key}`,
        details: { pointer: `/requires/${key}`, reason: 'unknown-key' },
      });
    }
  }
  if (requires.engine !== undefined) {
    if (typeof requires.engine !== 'string' || !isValidRange(requires.engine)) {
      context.fail(path, 'BUNDLE_REQUIRES_INVALID', "'requires.engine' is not a valid range", {
        pointer: '/requires/engine',
        details: { pointer: '/requires/engine', reason: 'range' },
      });
    }
  }
  if (requires.projections !== undefined) {
    const value = requires.projections;
    if (!Array.isArray(value) || value.length === 0) {
      context.fail(path, 'BUNDLE_REQUIRES_INVALID', "'requires.projections' must be a non-empty array", {
        pointer: '/requires/projections',
        details: { pointer: '/requires/projections', reason: 'projections' },
      });
    } else {
      const seen = new Set();
      value.forEach((item, index) => {
        const pointer = `/requires/projections/${index}`;
        if (typeof item !== 'string' || !PROJECTION_IDS.includes(item) || seen.has(item)) {
          context.fail(path, 'BUNDLE_REQUIRES_INVALID', "'requires.projections' has an invalid entry", {
            pointer,
            details: { pointer, reason: 'projections' },
          });
        }
        if (typeof item === 'string') seen.add(item);
      });
    }
  }
}
