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
import {
  MANIFEST_CODES,
  WORKFLOW_SCHEMA,
  isValidGlob,
  targetsSkillPayload,
  validateManifest as validateManifestContract,
} from '../../contract/manifest.js';
import { EXIT_CODES, R2cError } from './errors.js';

export { MANIFEST_CODES, WORKFLOW_SCHEMA, isValidGlob, targetsSkillPayload };

/**
 * Filesystem-backed wrapper around the pure contract: the engine supplies the
 * three existence probes (task file, skill file, display path) and the
 * contract stays importable without `node:*`.
 */
export function validateManifest({ data, root }) {
  return validateManifestContract({
    data,
    probe: {
      hasTaskFile: (taskFile) => existsSync(resolve(root, taskFile)),
      taskFileDisplay: (taskFile) => resolve(root, taskFile),
      hasSkill: (skill) => existsSync(resolve(root, 'skills', skill, 'SKILL.md')),
    },
  });
}
export function manifestError(inspected) {
  const { errors, warnings, manifestPath, candidates = [] } = inspected;
  const first = errors[0];
  let code = 'MANIFEST_INVALID';
  if (errors.length === 1 && ['MANIFEST_AMBIGUOUS', 'MANIFEST_NOT_FOUND', 'MANIFEST_PARSE_ERROR', 'MANIFEST_SCHEMA_UNSUPPORTED', 'USAGE'].includes(first.code)) {
    code = first.code;
  } else if (errors.some((item) => item.code === MANIFEST_CODES.SCHEMA_UNSUPPORTED)) {
    code = MANIFEST_CODES.SCHEMA_UNSUPPORTED;
  }
  const summary =
    errors.length === 1
      ? first.message
      : `${errors.length} manifest error(s), first: ${first.path}: ${first.message}`;
  const message =
    code === 'MANIFEST_AMBIGUOUS' ||
    code === 'MANIFEST_NOT_FOUND' ||
    code === 'MANIFEST_PARSE_ERROR' ||
    code === 'USAGE'
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
