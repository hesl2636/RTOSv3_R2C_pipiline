/**
 * Projection option normalization and validation (#69 §5, #82 §2; #100 extends).
 *
 * Inputs may be `null` (meaning "default"), but the returned `options` always
 * echo the resolved arrays, bind the current `ir.digest` and never contain a
 * `null` stageOrder/skills/targets. A stale binding is rejected with
 * `PROJECTION_OPTIONS_IR_MISMATCH`, the code the future web build shares.
 */
import { compareCodePoints } from '../core/code-point.js';

export const OPTIONS_SCHEMA = 'r2c.projection-options/v1';

/**
 * Closed option failure codes (#69 §5.2). CLI, the future web build and
 * direct callers all surface these strings; a stale binding is always
 * `PROJECTION_OPTIONS_IR_MISMATCH` (no better frozen name exists).
 */
export const OPTION_CODES = Object.freeze({
  INVALID: 'PROJECTION_OPTIONS_INVALID',
  TARGET_UNKNOWN: 'PROJECTION_TARGET_UNKNOWN',
  IR_MISMATCH: 'PROJECTION_OPTIONS_IR_MISMATCH',
});

const OPTION_KEYS = new Set(['schema', 'projection', 'ir', 'stageOrder', 'skills', 'targets', 'extra']);

function sorted(values) {
  return [...values].sort(compareCodePoints);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(code, message, extra = {}) {
  return { code, message, ...extra };
}

function dedupe(errors) {
  const seen = new Set();
  const out = [];
  for (const item of errors) {
    const key = `${item.code}\u0000${item.message}\u0000${item.target ?? ''}\u0000${item.pointer ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function manifestTargets(manifest) {
  return Array.isArray(manifest?.targets) ? manifest.targets : [];
}

function defaultTargets(manifest) {
  const targets = manifestTargets(manifest);
  const defaults = targets.filter((target) => target.default !== false).map((target) => target.id);
  return defaults.length > 0 ? defaults : targets.map((target) => target.id);
}

function irStageIds(ir) {
  return Array.isArray(ir?.stages) ? ir.stages.map((stage) => stage.id) : [];
}

function irSkillIds(ir) {
  return sorted(Object.keys(ir?.skills ?? {}));
}

function uniqueStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');
}

function pointerSegment(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Recursively sort `extra` keys by code point so result bytes are stable. */
function sortExtra(value) {
  if (Array.isArray(value)) return value.map((item) => sortExtra(item));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(sorted(Object.keys(value)).map((key) => [key, sortExtra(value[key])]));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const TYPE_CHECKS = {
  object: isPlainObject,
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

/**
 * Validate one `extra` value against the closed JSON-Schema subset a
 * `projection.json` may declare (#69 §3.2): type, enum, properties,
 * additionalProperties, required, items, min/max and length limits.
 * Unknown object keys are an error unless `additionalProperties` opens the
 * object, because projection options are a closed surface.
 */
function validateExtraValue(value, schema, pointer, errors) {
  if (!isPlainObject(schema)) return;
  const fail = (message) => errors.push(error(OPTION_CODES.INVALID, `${message} at ${pointer}`, { pointer }));
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonEqual(item, value))) {
    fail('extra value is not in the declared enum');
    return;
  }
  if (typeof schema.type === 'string') {
    const check = TYPE_CHECKS[schema.type];
    if (check !== undefined && !check(value)) {
      fail(`extra value must be ${schema.type}`);
      return;
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of sorted(Object.keys(value))) {
      const child = `${pointer}/${pointerSegment(key)}`;
      if (Object.hasOwn(properties, key)) {
        validateExtraValue(value[key], properties[key], child, errors);
      } else if (schema.additionalProperties === true) {
        continue;
      } else if (isPlainObject(schema.additionalProperties)) {
        validateExtraValue(value[key], schema.additionalProperties, child, errors);
      } else {
        errors.push(error(OPTION_CODES.INVALID, `unknown extra key ${key}`, { pointer: child }));
      }
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(error(OPTION_CODES.INVALID, `extra is missing required key ${key}`, { pointer: `${pointer}/${pointerSegment(key)}` }));
      }
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) fail(`extra array needs at least ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) fail(`extra array allows at most ${schema.maxItems} items`);
    if (isPlainObject(schema.items)) {
      for (const [index, item] of value.entries()) validateExtraValue(item, schema.items, `${pointer}/${index}`, errors);
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) fail(`extra string needs at least ${schema.minLength} characters`);
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) fail(`extra string allows at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      let matches = true;
      try {
        matches = new RegExp(schema.pattern).test(value);
      } catch {
        matches = false;
      }
      if (!matches) fail(`extra string does not match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`extra number must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`extra number must be <= ${schema.maximum}`);
  }
}

/** Validate `extra` against the manifest's declared closed schema. */
function validateExtra(extra, manifest, projectionId) {
  if (!isPlainObject(extra)) {
    return [error(OPTION_CODES.INVALID, 'extra must be an object', { pointer: '/extra' })];
  }
  const schema = manifest?.optionsSchema;
  if (!isPlainObject(schema)) {
    return Object.keys(extra).map((key) => error(
      OPTION_CODES.INVALID,
      `${projectionId ?? manifest?.id ?? 'projection'} declares no optionsSchema, so extra must be {}`,
      { pointer: `/extra/${pointerSegment(key)}` },
    ));
  }
  const errors = [];
  validateExtraValue(extra, schema, '/extra', errors);
  return errors;
}

/** Validate already-resolved options against the IR and the manifest. */
export function validateOptions({ projectionId, ir, irDigest, options, manifest }) {
  const errors = [];
  if (!isPlainObject(options)) {
    return { ok: false, errors: [error(OPTION_CODES.INVALID, 'options must be an object')] };
  }
  if (options.schema !== OPTIONS_SCHEMA) {
    errors.push(error(OPTION_CODES.INVALID, `options.schema must be ${OPTIONS_SCHEMA}`));
  }
  if (options.projection !== projectionId) {
    errors.push(error(OPTION_CODES.INVALID, `options.projection must be ${projectionId}`));
  }
  const binding = isPlainObject(options.ir) ? options.ir : {};
  if (binding.digest !== irDigest || binding.id !== ir?.id || binding.version !== ir?.version) {
    errors.push(error(OPTION_CODES.IR_MISMATCH, 'options.ir does not match the input IR', {
      hint: `expected digest ${irDigest}`,
    }));
  }
  const stageIds = irStageIds(ir);
  if (!uniqueStrings(options.stageOrder)
    || options.stageOrder.length !== stageIds.length
    || sorted(options.stageOrder).join('\u0000') !== sorted(stageIds).join('\u0000')) {
    errors.push(error(OPTION_CODES.INVALID, 'stageOrder must be a permutation of IR stage ids', { pointer: '/stageOrder' }));
  }
  const skillIds = irSkillIds(ir);
  if (!uniqueStrings(options.skills)
    || new Set(options.skills).size !== options.skills.length
    || options.skills.some((id) => !skillIds.includes(id))) {
    errors.push(error(OPTION_CODES.INVALID, 'skills must be a unique subset of IR skill ids', { pointer: '/skills' }));
  }
  const targetIds = manifestTargets(manifest).map((target) => target.id);
  if (!uniqueStrings(options.targets) || options.targets.length === 0) {
    errors.push(error(OPTION_CODES.INVALID, 'targets must be a non-empty unique list', { pointer: '/targets' }));
  } else {
    for (const id of options.targets) {
      if (!targetIds.includes(id)) {
        errors.push(error(OPTION_CODES.TARGET_UNKNOWN, `unknown target ${id}`, { target: id, pointer: '/targets' }));
      }
    }
  }
  if (!isPlainObject(options.extra)) {
    errors.push(error(OPTION_CODES.INVALID, 'extra must be an object', { pointer: '/extra' }));
  } else {
    for (const item of validateExtra(options.extra, manifest, projectionId)) errors.push(item);
  }
  return { ok: errors.length === 0, errors: dedupe(errors) };
}

/**
 * Normalize raw options for one projection.
 *
 * Returns `{ok, options, errors, warnings}`. `options` is always the resolved
 * echo, even when validation failed, so callers can show what would run.
 */
export function normalizeOptions({ projectionId, ir, irDigest, raw, manifest }) {
  const errors = [];
  let input = raw;
  if (input === null || input === undefined) input = {};
  if (!isPlainObject(input)) {
    return {
      ok: false,
      options: null,
      errors: [error(OPTION_CODES.INVALID, 'options must be an object or null')],
      warnings: [],
    };
  }
  for (const key of Object.keys(input)) {
    if (!OPTION_KEYS.has(key)) {
      errors.push(error(OPTION_CODES.INVALID, `unknown option ${key}`, { pointer: `/${pointerSegment(key)}` }));
    }
  }
  if (input.schema !== undefined && input.schema !== OPTIONS_SCHEMA) {
    errors.push(error(OPTION_CODES.INVALID, `options.schema must be ${OPTIONS_SCHEMA}`));
  }
  if (input.projection !== undefined && input.projection !== projectionId) {
    errors.push(error(OPTION_CODES.INVALID, `options.projection must be ${projectionId}`));
  }
  if (input.ir !== undefined) {
    const binding = isPlainObject(input.ir) ? input.ir : {};
    if (binding.digest !== irDigest || binding.id !== ir?.id || binding.version !== ir?.version) {
      errors.push(error(OPTION_CODES.IR_MISMATCH, 'options.ir does not match the input IR', {
        hint: `expected digest ${irDigest}`,
      }));
    }
  }

  const stageIds = irStageIds(ir);
  let stageOrder = stageIds;
  if (input.stageOrder !== undefined && input.stageOrder !== null) {
    const value = input.stageOrder;
    if (!uniqueStrings(value)
      || value.length !== stageIds.length
      || new Set(value).size !== value.length
      || sorted(value).join('\u0000') !== sorted(stageIds).join('\u0000')) {
      errors.push(error(OPTION_CODES.INVALID, 'stageOrder must be a permutation of IR stage ids', { pointer: '/stageOrder' }));
    } else {
      stageOrder = [...value];
    }
  }

  const skillIds = irSkillIds(ir);
  let skills = skillIds;
  if (input.skills !== undefined && input.skills !== null) {
    const value = input.skills;
    if (!uniqueStrings(value)
      || new Set(value).size !== value.length
      || value.some((id) => !skillIds.includes(id))) {
      errors.push(error(OPTION_CODES.INVALID, 'skills must be a unique subset of IR skill ids', { pointer: '/skills' }));
    } else {
      skills = sorted(value);
    }
  }

  const declaredTargets = manifestTargets(manifest).map((target) => target.id);
  let targets = defaultTargets(manifest);
  if (input.targets !== undefined && input.targets !== null) {
    const value = input.targets;
    if (!uniqueStrings(value) || value.length === 0) {
      errors.push(error(OPTION_CODES.INVALID, 'targets must be a non-empty unique list', { pointer: '/targets' }));
    } else {
      const unknown = value.filter((id) => !declaredTargets.includes(id));
      for (const id of [...new Set(unknown)]) {
        errors.push(error(OPTION_CODES.TARGET_UNKNOWN, `unknown target ${id}`, { target: id, pointer: '/targets' }));
      }
      if (new Set(value).size !== value.length) {
        errors.push(error(OPTION_CODES.INVALID, 'targets must be a non-empty unique list', { pointer: '/targets' }));
      }
      if (unknown.length === 0 && new Set(value).size === value.length) {
        targets = declaredTargets.filter((id) => value.includes(id));
      }
    }
  }

  let extra = {};
  if (input.extra !== undefined && input.extra !== null) {
    for (const item of validateExtra(input.extra, manifest, projectionId)) errors.push(item);
    if (isPlainObject(input.extra)) extra = sortExtra(input.extra);
  }

  const options = {
    schema: OPTIONS_SCHEMA,
    projection: projectionId,
    ir: { digest: irDigest, id: ir?.id, version: ir?.version },
    stageOrder,
    skills,
    targets,
    extra,
  };

  const check = validateOptions({ projectionId, ir, irDigest, options, manifest });
  for (const item of check.errors) errors.push(item);
  const deduped = dedupe(errors);
  return { ok: deduped.length === 0, options, errors: deduped, warnings: [] };
}

/**
 * The canonical input for one projection: `null` means "do not override" and
 * the manifest default targets are the published selection (#69 §5, #74 §3.4).
 */
export function canonicalInputOptions(projectionId, manifest) {
  return { stageOrder: null, skills: null, targets: defaultTargets(manifest) };
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * True when the resolved options equal the published defaults field by field.
 * Only canonical builds may become a Release (#74 §3.4, #75 §6.5).
 */
export function isCanonicalOptions({ projectionId, ir, irDigest, options, manifest }) {
  if (!isPlainObject(options)) return false;
  const canonical = normalizeOptions({ projectionId, ir, irDigest, raw: null, manifest });
  if (!canonical.ok || !isPlainObject(options.extra)) return false;
  return sameStrings(options.stageOrder, canonical.options.stageOrder)
    && sameStrings(options.skills, canonical.options.skills)
    && sameStrings(options.targets, canonical.options.targets)
    && Object.keys(options.extra).length === 0;
}

/**
 * The options a payload manifest records: canonical builds keep the canonical
 * input (`null` overrides), custom local builds record the actual selection
 * (#74 §3.5, #75 §7.1 step 4).
 */
export function payloadInputOptions({ projectionId, ir, irDigest, options, manifest }) {
  if (isCanonicalOptions({ projectionId, ir, irDigest, options, manifest })) {
    return canonicalInputOptions(projectionId, manifest);
  }
  return {
    stageOrder: [...options.stageOrder],
    skills: [...options.skills],
    targets: [...options.targets],
  };
}

export { defaultTargets };
