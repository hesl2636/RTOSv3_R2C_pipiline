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

/** Validate already-resolved options against the IR and the manifest. */
export function validateOptions({ projectionId, ir, irDigest, options, manifest }) {
  const errors = [];
  if (!isPlainObject(options)) {
    return { ok: false, errors: [error('PROJECTION_OPTIONS_INVALID', 'options must be an object')] };
  }
  if (options.schema !== OPTIONS_SCHEMA) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', `options.schema must be ${OPTIONS_SCHEMA}`));
  }
  if (options.projection !== projectionId) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', `options.projection must be ${projectionId}`));
  }
  const binding = isPlainObject(options.ir) ? options.ir : {};
  if (binding.digest !== irDigest || binding.id !== ir?.id || binding.version !== ir?.version) {
    errors.push(error('PROJECTION_OPTIONS_IR_MISMATCH', 'options.ir does not match the input IR', {
      hint: `expected digest ${irDigest}`,
    }));
  }
  const stageIds = irStageIds(ir);
  if (!uniqueStrings(options.stageOrder)
    || options.stageOrder.length !== stageIds.length
    || sorted(options.stageOrder).join('\u0000') !== sorted(stageIds).join('\u0000')) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', 'stageOrder must be a permutation of IR stage ids'));
  }
  const skillIds = irSkillIds(ir);
  if (!uniqueStrings(options.skills)
    || new Set(options.skills).size !== options.skills.length
    || options.skills.some((id) => !skillIds.includes(id))) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', 'skills must be a unique subset of IR skill ids'));
  }
  const targetIds = manifestTargets(manifest).map((target) => target.id);
  if (!uniqueStrings(options.targets) || options.targets.length === 0) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', 'targets must be a non-empty unique list'));
  } else {
    for (const id of options.targets) {
      if (!targetIds.includes(id)) {
        errors.push(error('PROJECTION_TARGET_UNKNOWN', `unknown target ${id}`, { target: id }));
      }
    }
  }
  if (!isPlainObject(options.extra)) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', 'extra must be an object'));
  } else if (manifest?.optionsSchema === undefined && Object.keys(options.extra).length !== 0) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', 'agent-native declares no optionsSchema, so extra must be {}'));
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
      errors: [error('PROJECTION_OPTIONS_INVALID', 'options must be an object or null')],
      warnings: [],
    };
  }
  for (const key of Object.keys(input)) {
    if (!OPTION_KEYS.has(key)) {
      errors.push(error('PROJECTION_OPTIONS_INVALID', `unknown option ${key}`, { pointer: `/${key}` }));
    }
  }
  if (input.schema !== undefined && input.schema !== OPTIONS_SCHEMA) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', `options.schema must be ${OPTIONS_SCHEMA}`));
  }
  if (input.projection !== undefined && input.projection !== projectionId) {
    errors.push(error('PROJECTION_OPTIONS_INVALID', `options.projection must be ${projectionId}`));
  }
  if (input.ir !== undefined) {
    const binding = isPlainObject(input.ir) ? input.ir : {};
    if (binding.digest !== irDigest || binding.id !== ir?.id || binding.version !== ir?.version) {
      errors.push(error('PROJECTION_OPTIONS_IR_MISMATCH', 'options.ir does not match the input IR', {
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
      errors.push(error('PROJECTION_OPTIONS_INVALID', 'stageOrder must be a permutation of IR stage ids'));
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
      errors.push(error('PROJECTION_OPTIONS_INVALID', 'skills must be a unique subset of IR skill ids'));
    } else {
      skills = sorted(value);
    }
  }

  const declaredTargets = manifestTargets(manifest).map((target) => target.id);
  let targets = defaultTargets(manifest);
  if (input.targets !== undefined && input.targets !== null) {
    const value = input.targets;
    if (!uniqueStrings(value) || value.length === 0) {
      errors.push(error('PROJECTION_OPTIONS_INVALID', 'targets must be a non-empty unique list'));
    } else {
      const unknown = value.filter((id) => !declaredTargets.includes(id));
      for (const id of [...new Set(unknown)]) {
        errors.push(error('PROJECTION_TARGET_UNKNOWN', `unknown target ${id}`, { target: id }));
      }
      if (new Set(value).size !== value.length) {
        errors.push(error('PROJECTION_OPTIONS_INVALID', 'targets must be a non-empty unique list'));
      }
      if (unknown.length === 0 && new Set(value).size === value.length) {
        targets = declaredTargets.filter((id) => value.includes(id));
      }
    }
  }

  let extra = {};
  if (input.extra !== undefined && input.extra !== null) {
    if (!isPlainObject(input.extra)) {
      errors.push(error('PROJECTION_OPTIONS_INVALID', 'extra must be an object'));
    } else if (manifest?.optionsSchema === undefined && Object.keys(input.extra).length !== 0) {
      errors.push(error('PROJECTION_OPTIONS_INVALID', 'agent-native declares no optionsSchema, so extra must be {}'));
    } else {
      extra = Object.fromEntries(sorted(Object.keys(input.extra)).map((key) => [key, input.extra[key]]));
    }
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

export { defaultTargets };
