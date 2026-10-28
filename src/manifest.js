/**
 * Workflow manifest loading and discovery.
 *
 * The runtime responsibility here is deliberately narrow: parse YAML, enforce
 * the v1 top-level closed set, require embedded stage→step objects and resolve
 * the manifest root used for `taskFile` / `skills/<name>/SKILL.md`. Strict
 * all-errors validation is layered on top by `validate` (ticket #21).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { R2cError, EXIT_CODES } from './errors.js';

export const WORKFLOW_SCHEMA = 'r2c.workflow/v1';

const TOP_LEVEL_KEYS = new Set(['schema', 'id', 'name', 'version', 'description', 'stages']);

function invalid(message, details = null) {
  return new R2cError('MANIFEST_INVALID', message, details, EXIT_CODES.USAGE);
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
        { manifest: manifestPath },
        EXIT_CODES.USAGE,
      );
    }
    return { manifestPath, root: dirname(dirname(manifestPath)) };
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

function validateShape(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalid('manifest must be a YAML mapping');
  }
  const unknown = Object.keys(data).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw invalid(`unknown top-level key(s): ${unknown.join(', ')}`, { keys: unknown });
  }
  if (data.schema !== WORKFLOW_SCHEMA) {
    throw new R2cError(
      'MANIFEST_SCHEMA_UNSUPPORTED',
      `unsupported manifest schema: ${String(data.schema)}`,
      { schema: data.schema ?? null, supported: [WORKFLOW_SCHEMA] },
      EXIT_CODES.USAGE,
    );
  }
  if (typeof data.id !== 'string' || data.id === '') throw invalid('manifest id is required');
  if (typeof data.name !== 'string' || data.name === '') throw invalid('manifest name is required');
  if (!Array.isArray(data.stages) || data.stages.length === 0) {
    throw invalid('manifest stages must be a non-empty array');
  }

  for (const [stageIndex, stage] of data.stages.entries()) {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      throw invalid(`stages[${stageIndex}] must be an object`);
    }
    if (typeof stage.id !== 'string' || stage.id === '') {
      throw invalid(`stages[${stageIndex}].id is required`);
    }
    if (typeof stage.name !== 'string' || stage.name === '') {
      throw invalid(`stages[${stageIndex}].name is required`);
    }
    if (!Array.isArray(stage.steps) || stage.steps.length === 0) {
      throw invalid(`stages[${stageIndex}].steps must be a non-empty array`);
    }
    for (const [stepIndex, step] of stage.steps.entries()) {
      const path = `stages[${stageIndex}].steps[${stepIndex}]`;
      if (step === null || typeof step !== 'object' || Array.isArray(step)) {
        throw invalid(`${path} must be an embedded step object`);
      }
      if (typeof step.id !== 'string' || step.id === '') throw invalid(`${path}.id is required`);
      if (typeof step.name !== 'string' || step.name === '') {
        throw invalid(`${path}.name is required`);
      }
      if (step.type !== 'prompt' && step.type !== 'shell') {
        throw invalid(`${path}.type must be "prompt" or "shell"`);
      }
    }
  }
}

export function loadManifest({ manifest = null, projectRoot }) {
  const { manifestPath, root } = discoverManifest({ manifest, projectRoot });
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

  let data;
  try {
    data = parse(text);
  } catch (error) {
    throw new R2cError(
      'MANIFEST_PARSE_ERROR',
      `cannot parse manifest: ${manifestPath}`,
      { manifest: manifestPath, message: error?.message ?? String(error) },
      EXIT_CODES.USAGE,
    );
  }

  validateShape(data);
  return { manifestPath, root, data };
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
