/**
 * Workflow manifest discovery, loading and strict validation.
 *
 * Discovery and loading can fail once (no manifest, ambiguous candidates,
 * unreadable or unparsable YAML); those are still exit 2. Structural and
 * semantic checks never stop at the first problem: `validateManifest` walks the
 * whole document and returns every error as `{ path, code, message }`, shared by
 * `r2c validate` and `r2c run` so `run` refuses to write `.r2c` for a manifest
 * the author was told was broken.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { EXIT_CODES, R2cError } from './errors.js';

export const WORKFLOW_SCHEMA = 'r2c.workflow/v1';

/** Machine-readable codes carried in `errors[]` / `warnings[]` (schema §2). */
export const MANIFEST_CODES = Object.freeze({
  NOT_MAPPING: 'MANIFEST_NOT_MAPPING',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  REQUIRED: 'REQUIRED',
  TYPE: 'TYPE',
  SCHEMA_UNSUPPORTED: 'MANIFEST_SCHEMA_UNSUPPORTED',
  EMPTY: 'EMPTY',
  DUPLICATE_STAGE_ID: 'DUPLICATE_STAGE_ID',
  DUPLICATE_STEP_ID: 'DUPLICATE_STEP_ID',
  TASKFILE_MISSING: 'TASKFILE_MISSING',
  GLOB_INVALID: 'GLOB_INVALID',
  OUTPUT_FORBIDDEN: 'OUTPUT_FORBIDDEN',
  GATE_COMMAND_EMPTY: 'GATE_COMMAND_EMPTY',
  PAYLOAD_CONFLICT: 'PAYLOAD_CONFLICT',
  PROMPT_SOURCE_MISSING: 'PROMPT_SOURCE_MISSING',
  SHELL_REQUIRED: 'SHELL_REQUIRED',
  TIMEOUT_REQUIRED: 'TIMEOUT_REQUIRED',
  TIMEOUT_INVALID: 'TIMEOUT_INVALID',
  SKILL_MISSING: 'SKILL_MISSING',
});

const TOP_LEVEL_KEYS = new Set(['schema', 'id', 'name', 'version', 'description', 'stages']);
const STAGE_KEYS = new Set(['id', 'name', 'steps']);
const STEP_KEYS = new Set([
  'id',
  'name',
  'type',
  'agent',
  'skill',
  'taskFile',
  'prompt',
  'shell',
  'timeout',
  'input',
  'skills',
  'mcp',
  'subagent',
  'expect',
  'gate',
]);
const EXPECT_KEYS = new Set(['outputs']);
const GATE_KEYS = new Set(['command', 'timeout']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function fieldPath(base, key) {
  return base === '' ? key : `${base}.${key}`;
}

function indexPath(base, index) {
  return `${base}[${index}]`;
}

/**
 * A glob is syntactically valid when braces/brackets balance and it is
 * non-empty. Matching semantics stay with the gate (`src/gate.js`); this check
 * only rejects patterns that can never match.
 */
export function isValidGlob(pattern) {
  if (!isNonEmptyString(pattern) || pattern.includes('\0')) return false;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') {
      if (braces > 0) return false;
      braces += 1;
    } else if (char === '}') {
      if (braces === 0) return false;
      braces -= 1;
    } else if (char === '[') {
      if (brackets > 0) return false;
      brackets += 1;
    } else if (char === ']') {
      if (brackets === 0) return false;
      brackets -= 1;
    }
  }
  return braces === 0 && brackets === 0;
}

/** `expect.outputs` must never point into the read-only skill payload. */
export function targetsSkillPayload(pattern) {
  if (typeof pattern !== 'string') return false;
  const segments = pattern.replaceAll('\\', '/').split('/');
  return segments.some(
    (segment) => segment.toLowerCase() === 'skills' || segment.toLowerCase() === 'skill.md',
  );
}

function unknownKeys(object, allowed, base, error) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      error(fieldPath(base, key), MANIFEST_CODES.UNKNOWN_KEY, `unknown key: ${key}`);
    }
  }
}

/**
 * Validate a parsed manifest against `r2c.workflow/v1` without throwing.
 * Returns `{ errors, warnings }`; both arrays are ordered by document position.
 */
export function validateManifest({ data, root }) {
  const errors = [];
  const warnings = [];
  const error = (path, code, message) => errors.push({ path, code, message });
  const warn = (path, code, message) => warnings.push({ path, code, message });

  if (!isPlainObject(data)) {
    error('manifest', MANIFEST_CODES.NOT_MAPPING, 'manifest must be a YAML mapping');
    return { errors, warnings };
  }

  unknownKeys(data, TOP_LEVEL_KEYS, '', error);

  if (!('schema' in data)) {
    error('schema', MANIFEST_CODES.REQUIRED, 'schema is required');
  } else if (data.schema !== WORKFLOW_SCHEMA) {
    error(
      'schema',
      MANIFEST_CODES.SCHEMA_UNSUPPORTED,
      `unsupported schema: ${JSON.stringify(data.schema)} (expected ${WORKFLOW_SCHEMA})`,
    );
  }

  for (const key of ['id', 'name']) {
    if (!(key in data)) error(key, MANIFEST_CODES.REQUIRED, `${key} is required`);
    else if (!isNonEmptyString(data[key])) {
      error(key, MANIFEST_CODES.TYPE, `${key} must be a non-empty string`);
    }
  }
  if ('version' in data && !isNonEmptyString(data.version)) {
    error('version', MANIFEST_CODES.TYPE, 'version must be a non-empty string');
  }
  if ('description' in data && typeof data.description !== 'string') {
    error('description', MANIFEST_CODES.TYPE, 'description must be a string');
  }

  if (!('stages' in data)) {
    error('stages', MANIFEST_CODES.REQUIRED, 'stages is required');
    return { errors, warnings };
  }
  if (!Array.isArray(data.stages)) {
    error('stages', MANIFEST_CODES.TYPE, 'stages must be an array');
    return { errors, warnings };
  }
  if (data.stages.length === 0) {
    error('stages', MANIFEST_CODES.EMPTY, 'stages must not be empty');
    return { errors, warnings };
  }

  const stageIds = new Set();
  const stepIds = new Set();

  for (const [stageIndex, stage] of data.stages.entries()) {
    const stagePath = indexPath('stages', stageIndex);
    if (!isPlainObject(stage)) {
      error(stagePath, MANIFEST_CODES.TYPE, 'stage must be an object');
      continue;
    }
    unknownKeys(stage, STAGE_KEYS, stagePath, error);

    if (!('id' in stage)) {
      error(fieldPath(stagePath, 'id'), MANIFEST_CODES.REQUIRED, 'stage id is required');
    } else if (!isNonEmptyString(stage.id)) {
      error(fieldPath(stagePath, 'id'), MANIFEST_CODES.TYPE, 'stage id must be a non-empty string');
    } else if (stageIds.has(stage.id)) {
      error(
        fieldPath(stagePath, 'id'),
        MANIFEST_CODES.DUPLICATE_STAGE_ID,
        `duplicate stage id: ${stage.id}`,
      );
    } else {
      stageIds.add(stage.id);
    }
    if (!('name' in stage)) {
      error(fieldPath(stagePath, 'name'), MANIFEST_CODES.REQUIRED, 'stage name is required');
    } else if (!isNonEmptyString(stage.name)) {
      error(
        fieldPath(stagePath, 'name'),
        MANIFEST_CODES.TYPE,
        'stage name must be a non-empty string',
      );
    }

    if (!('steps' in stage)) {
      error(fieldPath(stagePath, 'steps'), MANIFEST_CODES.REQUIRED, 'stage steps is required');
      continue;
    }
    if (!Array.isArray(stage.steps)) {
      error(fieldPath(stagePath, 'steps'), MANIFEST_CODES.TYPE, 'stage steps must be an array');
      continue;
    }
    if (stage.steps.length === 0) {
      error(fieldPath(stagePath, 'steps'), MANIFEST_CODES.EMPTY, 'stage steps must not be empty');
      continue;
    }

    for (const [stepIndex, step] of stage.steps.entries()) {
      const stepPath = indexPath(fieldPath(stagePath, 'steps'), stepIndex);
      if (!isPlainObject(step)) {
        error(stepPath, MANIFEST_CODES.TYPE, 'step must be an object');
        continue;
      }
      validateStep({ step, stepPath });
    }
  }

  function validateStep({ step, stepPath }) {
    unknownKeys(step, STEP_KEYS, stepPath, error);

    if (!('id' in step)) {
      error(fieldPath(stepPath, 'id'), MANIFEST_CODES.REQUIRED, 'step id is required');
    } else if (!isNonEmptyString(step.id)) {
      error(fieldPath(stepPath, 'id'), MANIFEST_CODES.TYPE, 'step id must be a non-empty string');
    } else if (stepIds.has(step.id)) {
      error(
        fieldPath(stepPath, 'id'),
        MANIFEST_CODES.DUPLICATE_STEP_ID,
        `duplicate step id: ${step.id}`,
      );
    } else {
      stepIds.add(step.id);
    }

    if (!('name' in step)) {
      error(fieldPath(stepPath, 'name'), MANIFEST_CODES.REQUIRED, 'step name is required');
    } else if (!isNonEmptyString(step.name)) {
      error(
        fieldPath(stepPath, 'name'),
        MANIFEST_CODES.TYPE,
        'step name must be a non-empty string',
      );
    }

    let type = null;
    if (!('type' in step)) {
      error(fieldPath(stepPath, 'type'), MANIFEST_CODES.REQUIRED, 'step type is required');
    } else if (step.type !== 'prompt' && step.type !== 'shell') {
      error(
        fieldPath(stepPath, 'type'),
        MANIFEST_CODES.TYPE,
        'step type must be "prompt" or "shell"',
      );
    } else {
      type = step.type;
    }

    // `agent` is deliberately not validated: it is prompt metadata only.
    if ('skill' in step) {
      if (!isNonEmptyString(step.skill)) {
        error(fieldPath(stepPath, 'skill'), MANIFEST_CODES.TYPE, 'skill must be a non-empty string');
      } else if (!hasSkillFile(root, step.skill)) {
        warn(
          fieldPath(stepPath, 'skill'),
          MANIFEST_CODES.SKILL_MISSING,
          `skill not found: ${step.skill} (skills/${step.skill}/SKILL.md)`,
        );
      }
    }

    if ('taskFile' in step) {
      if (!isNonEmptyString(step.taskFile)) {
        error(
          fieldPath(stepPath, 'taskFile'),
          MANIFEST_CODES.TYPE,
          'taskFile must be a non-empty string',
        );
      } else {
        const taskPath = resolve(root, step.taskFile);
        if (!existsSync(taskPath)) {
          error(
            fieldPath(stepPath, 'taskFile'),
            MANIFEST_CODES.TASKFILE_MISSING,
            `task file not found: ${step.taskFile} (resolved to ${taskPath})`,
          );
        }
      }
    }

    if ('prompt' in step && typeof step.prompt !== 'string') {
      error(fieldPath(stepPath, 'prompt'), MANIFEST_CODES.TYPE, 'prompt must be a string');
    }
    if ('shell' in step && !isNonEmptyString(step.shell)) {
      error(fieldPath(stepPath, 'shell'), MANIFEST_CODES.TYPE, 'shell must be a non-empty string');
    }

    if ('timeout' in step) {
      if (typeof step.timeout !== 'number' || !Number.isFinite(step.timeout)) {
        error(fieldPath(stepPath, 'timeout'), MANIFEST_CODES.TYPE, 'timeout must be a number');
      } else if (!(step.timeout > 0)) {
        error(
          fieldPath(stepPath, 'timeout'),
          MANIFEST_CODES.TIMEOUT_INVALID,
          'timeout must be greater than 0',
        );
      }
    }

    for (const key of ['skills', 'mcp']) {
      if (!(key in step)) continue;
      const value = step[key];
      if (!Array.isArray(value)) {
        error(fieldPath(stepPath, key), MANIFEST_CODES.TYPE, `${key} must be an array`);
        continue;
      }
      for (const [index, item] of value.entries()) {
        if (!isNonEmptyString(item)) {
          error(
            indexPath(fieldPath(stepPath, key), index),
            MANIFEST_CODES.TYPE,
            `${key} entries must be non-empty strings`,
          );
        }
      }
    }

    if ('subagent' in step && typeof step.subagent !== 'boolean') {
      error(fieldPath(stepPath, 'subagent'), MANIFEST_CODES.TYPE, 'subagent must be a boolean');
    }

    if ('expect' in step) {
      validateExpect({ expect: step.expect, path: fieldPath(stepPath, 'expect') });
    }

    if ('gate' in step) {
      validateGate({ gate: step.gate, path: fieldPath(stepPath, 'gate') });
    }

    if (type === 'prompt') {
      if ('shell' in step) {
        error(
          fieldPath(stepPath, 'shell'),
          MANIFEST_CODES.PAYLOAD_CONFLICT,
          'prompt steps must not define shell',
        );
      }
      const hasPrompt = typeof step.prompt === 'string' && step.prompt.trim() !== '';
      const hasTask = isNonEmptyString(step.taskFile);
      if (!hasPrompt && !hasTask) {
        error(
          stepPath,
          MANIFEST_CODES.PROMPT_SOURCE_MISSING,
          'prompt step requires prompt text or taskFile',
        );
      }
    } else if (type === 'shell') {
      for (const key of ['prompt', 'taskFile']) {
        if (key in step) {
          error(
            fieldPath(stepPath, key),
            MANIFEST_CODES.PAYLOAD_CONFLICT,
            `shell steps must not define ${key}`,
          );
        }
      }
      if (!isNonEmptyString(step.shell)) {
        error(
          fieldPath(stepPath, 'shell'),
          MANIFEST_CODES.SHELL_REQUIRED,
          'shell step requires a non-empty shell command',
        );
      }
      if (!('timeout' in step)) {
        error(
          fieldPath(stepPath, 'timeout'),
          MANIFEST_CODES.TIMEOUT_REQUIRED,
          'shell step requires timeout',
        );
      }
    }
  }

  function validateExpect({ expect, path }) {
    if (!isPlainObject(expect)) {
      error(path, MANIFEST_CODES.TYPE, 'expect must be an object');
      return;
    }
    unknownKeys(expect, EXPECT_KEYS, path, error);
    if (!('outputs' in expect)) return;
    if (!Array.isArray(expect.outputs)) {
      error(fieldPath(path, 'outputs'), MANIFEST_CODES.TYPE, 'expect.outputs must be an array');
      return;
    }
    for (const [index, output] of expect.outputs.entries()) {
      const outputPath = indexPath(fieldPath(path, 'outputs'), index);
      if (!isNonEmptyString(output)) {
        error(outputPath, MANIFEST_CODES.TYPE, 'expect.outputs entries must be non-empty strings');
        continue;
      }
      if (!isValidGlob(output)) {
        error(outputPath, MANIFEST_CODES.GLOB_INVALID, `invalid glob: ${output}`);
      } else if (targetsSkillPayload(output)) {
        error(
          outputPath,
          MANIFEST_CODES.OUTPUT_FORBIDDEN,
          `expect.outputs must not target skills/** or SKILL.md: ${output}`,
        );
      }
    }
  }

  function validateGate({ gate, path }) {
    if (!Array.isArray(gate)) {
      error(path, MANIFEST_CODES.TYPE, 'gate must be an array');
      return;
    }
    for (const [index, item] of gate.entries()) {
      const itemPath = indexPath(path, index);
      if (!isPlainObject(item)) {
        error(itemPath, MANIFEST_CODES.TYPE, 'gate entries must be objects');
        continue;
      }
      unknownKeys(item, GATE_KEYS, itemPath, error);
      if (!('command' in item)) {
        error(fieldPath(itemPath, 'command'), MANIFEST_CODES.GATE_COMMAND_EMPTY, 'gate command is required');
      } else if (!isNonEmptyString(item.command)) {
        error(
          fieldPath(itemPath, 'command'),
          MANIFEST_CODES.GATE_COMMAND_EMPTY,
          'gate command must be a non-empty string',
        );
      }
      if ('timeout' in item) {
        if (typeof item.timeout !== 'number' || !Number.isFinite(item.timeout)) {
          error(fieldPath(itemPath, 'timeout'), MANIFEST_CODES.TYPE, 'gate timeout must be a number');
        } else if (!(item.timeout > 0)) {
          error(
            fieldPath(itemPath, 'timeout'),
            MANIFEST_CODES.TIMEOUT_INVALID,
            'gate timeout must be greater than 0',
          );
        }
      }
    }
  }

  return { errors, warnings };
}

export function manifestError(inspected) {
  const { errors, warnings, manifestPath, candidates = [] } = inspected;
  const first = errors[0];
  let code = 'MANIFEST_INVALID';
  if (errors.length === 1 && ['MANIFEST_AMBIGUOUS', 'MANIFEST_NOT_FOUND', 'MANIFEST_PARSE_ERROR', 'MANIFEST_SCHEMA_UNSUPPORTED'].includes(first.code)) {
    code = first.code;
  } else if (errors.some((item) => item.code === MANIFEST_CODES.SCHEMA_UNSUPPORTED)) {
    code = MANIFEST_CODES.SCHEMA_UNSUPPORTED;
  }
  const summary =
    errors.length === 1
      ? first.message
      : `${errors.length} manifest error(s), first: ${first.path}: ${first.message}`;
  const message =
    code === 'MANIFEST_AMBIGUOUS' || code === 'MANIFEST_NOT_FOUND'
      ? first.message
      : `manifest invalid: ${summary}`;
  const error = new R2cError(
    code,
    message,
    { manifest: manifestPath, candidates, errors, warnings },
    EXIT_CODES.USAGE,
    { manifest: manifestPath, root: inspected.root, errors, warnings },
  );
  return error;
}

export function discoverManifest({ manifest = null, projectRoot }) {
  if (manifest !== null && manifest !== undefined) {
    if (!isAbsolute(manifest)) {
      throw new R2cError(
        'USAGE',
        `--manifest must be an absolute path: ${manifest}`,
        { option: '--manifest' },
        EXIT_CODES.USAGE,
      );
    }
    const manifestPath = resolve(manifest);
    if (!existsSync(manifestPath)) {
      throw new R2cError(
        'MANIFEST_NOT_FOUND',
        `manifest not found: ${manifestPath}`,
        { manifest: manifestPath, candidates: [] },
        EXIT_CODES.USAGE,
      );
    }
    return { manifestPath, root: dirname(dirname(manifestPath)), candidates: [] };
  }

  const workflowsDir = join(projectRoot, 'workflows');
  let candidates = [];
  try {
    candidates = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yaml'))
      .sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (candidates.length === 1) {
    return {
      manifestPath: join(workflowsDir, candidates[0]),
      root: projectRoot,
      candidates: [],
    };
  }
  if (candidates.length === 0) {
    throw new R2cError(
      'MANIFEST_NOT_FOUND',
      `no workflow manifest found under ${workflowsDir}`,
      { candidates: [] },
      EXIT_CODES.USAGE,
    );
  }
  throw new R2cError(
    'MANIFEST_AMBIGUOUS',
    `expected exactly one workflow manifest under ${workflowsDir}, found ${candidates.length}: ${candidates.join(', ')}`,
    { candidates },
    EXIT_CODES.USAGE,
  );
}

function parseManifestFile(manifestPath) {
  let text;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new R2cError(
      'MANIFEST_NOT_FOUND',
      `cannot read manifest: ${manifestPath}`,
      { manifest: manifestPath, cause: error?.message ?? String(error) },
      EXIT_CODES.USAGE,
    );
  }

  try {
    return parse(text);
  } catch (error) {
    throw new R2cError(
      'MANIFEST_PARSE_ERROR',
      `cannot parse manifest: ${manifestPath}`,
      { manifest: manifestPath, message: error?.message ?? String(error) },
      EXIT_CODES.USAGE,
    );
  }
}

/**
 * Non-throwing manifest inspection shared by `validate` and `run`: discovery,
 * parse and validation failures all land in `errors`.
 */
export function inspectManifest({ manifest = null, projectRoot }) {
  let discovered;
  try {
    discovered = discoverManifest({ manifest, projectRoot });
  } catch (error) {
    if (error instanceof R2cError) {
      return {
        manifestPath: error.details?.manifest ?? null,
        root: projectRoot,
        data: null,
        candidates: error.details?.candidates ?? [],
        errors: [{ path: 'manifest', code: error.code, message: error.message }],
        warnings: [],
      };
    }
    throw error;
  }

  let data;
  try {
    data = parseManifestFile(discovered.manifestPath);
  } catch (error) {
    if (error instanceof R2cError) {
      return {
        ...discovered,
        data: null,
        errors: [{ path: 'manifest', code: error.code, message: error.message }],
        warnings: [],
      };
    }
    throw error;
  }

  const { errors, warnings } = validateManifest({ data, root: discovered.root });
  return { ...discovered, data, errors, warnings };
}

export function loadManifest({ manifest = null, projectRoot }) {
  const inspected = inspectManifest({ manifest, projectRoot });
  if (inspected.errors.length > 0) throw manifestError(inspected);
  return {
    manifestPath: inspected.manifestPath,
    root: inspected.root,
    data: inspected.data,
    warnings: inspected.warnings,
  };
}

export function flattenSteps(manifest) {
  const steps = [];
  for (const stage of manifest.stages) {
    for (const step of stage.steps) steps.push({ step, stage });
  }
  return steps;
}

export function findStep(manifest, stepId) {
  return flattenSteps(manifest).find(({ step }) => step.id === stepId) ?? null;
}

export function taskFilePath(root, step) {
  if (typeof step.taskFile !== 'string' || step.taskFile === '') return null;
  return resolve(root, step.taskFile);
}

export function readTaskFile(root, step) {
  const file = taskFilePath(root, step);
  if (file === null) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new R2cError(
      'MANIFEST_TASKFILE_MISSING',
      `task file not found: ${step.taskFile}`,
      { step: step.id, taskFile: step.taskFile, path: file },
      EXIT_CODES.USAGE,
    );
  }
}

export function skillFilePath(root, skill) {
  if (typeof skill !== 'string' || skill === '') return null;
  return resolve(root, 'skills', skill, 'SKILL.md');
}

export function hasSkillFile(root, skill) {
  const file = skillFilePath(root, skill);
  return file !== null && existsSync(file);
}
