/**
 * `hm2b.compiled-workflow/v2` validation (decision #67 §8).
 *
 * Bytes in, report out. compiled workflow diagnostics are errors only: the compiled workflow is a machine
 * artifact, so any deviation is an integrity failure. Embedded hashing is
 * injected (`{ sha256 }`), keeping the module browser-capable.
 */
import { canonicalJson, firstDifferenceOffset } from '../core/canonical-json.js';
import { codePointLength, compareCodePoints } from '../core/code-point.js';
import {
  SEVERITY,
  buildReport,
  makeDiagnostic,
} from '../core/diagnostics.js';
import { isValidGlob } from '../core/glob.js';
import { parseSchemaId } from '../core/schema.js';
import { isValidRange } from '../core/semver.js';
import {
  COMPILED_WORKFLOW_BUNDLE_SCHEMA,
  COMPILED_WORKFLOW_CHECKLIST_FIELDS,
  COMPILED_WORKFLOW_CONSTITUTION_FIELDS,
  COMPILED_WORKFLOW_FIELDS,
  COMPILED_WORKFLOW_FILENAME,
  COMPILED_WORKFLOW_GATE_FIELDS,
  COMPILED_WORKFLOW_HOOKS_FIELDS,
  COMPILED_WORKFLOW_HOOKS_PATH,
  COMPILED_WORKFLOW_KNOWLEDGE_BASE_FIELDS,
  COMPILED_WORKFLOW_MCP_FIELDS,
  COMPILED_WORKFLOW_MCP_PATH,
  COMPILED_WORKFLOW_REQUIRES_FIELDS,
  COMPILED_WORKFLOW_ROLE_FIELDS,
  COMPILED_WORKFLOW_SCHEMA,
  COMPILED_WORKFLOW_SKILL_FIELDS,
  COMPILED_WORKFLOW_SOURCE_BUNDLE_FIELDS,
  COMPILED_WORKFLOW_SOURCE_FIELDS,
  COMPILED_WORKFLOW_SOURCE_MANIFEST_FIELDS,
  COMPILED_WORKFLOW_SOURCE_REF_FIELDS,
  COMPILED_WORKFLOW_STAGE_FIELDS,
  COMPILED_WORKFLOW_STEP_FIELDS,
  COMPILED_WORKFLOW_TASK_FIELDS,
  compiledWorkflowChecklistPath,
} from '../compiled/schema.js';
import { scanTaskBody } from './markdown.js';
import { serializeCompiledWorkflow } from '../compiled/serialize.js';
import { hasLoneSurrogate, isPlainObject, nonEmptyLines, preamble } from './util.js';

export const COMPILED_WORKFLOW_SUMMARY_CODE = 'COMPILED_WORKFLOW_INVALID';

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SOURCE_PATH_RE = /^(?:stages\/[a-z0-9]+(?:-[a-z0-9]+)*\.json|roles\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|tasks\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md|knowledge-base\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md|checklists\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|hooks\/hooks\.json|mcp\.json|constitution\/CONSTITUTION\.md)$/;
const KNOWLEDGE_BASE_RE = /^knowledge-base\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
const SCHEMA_REVISION = parseSchemaId(COMPILED_WORKFLOW_SCHEMA).revision;
const RUNTIME_KEYS = new Set([
  'type',
  'metadata',
  'hooks',
  'mcpServers',
  'temperature',
  'color',
  'hidden',
  'maxTurns',
  'spawns',
  'prompt',
  'taskFile',
  'expect',
  'shell',
  'script',
  'commandFile',
]);
const TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'web'];
const ROLE_ENUMS = {
  mode: ['subagent', 'primary', 'any'],
  model: ['fast', 'standard', 'strong'],
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
};
const PLACEHOLDER_BANNER = /^> \*\*.*(占位|placeholder)/im;
const CONSTITUTION_MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(0);
}

function pointerSegment(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

function idProblem(value, max = 64) {
  return typeof value !== 'string' || !ID_RE.test(value) || value.length > max;
}

function lengthProblem(value, minimum, maximum) {
  if (typeof value !== 'string') return 'type';
  const length = codePointLength(value);
  if (length < minimum) return 'minLength';
  if (length > maximum) return 'maxLength';
  return null;
}

function outputPathReason(output) {
  if (output.startsWith('/') || /^[A-Za-z]:/.test(output)) return 'absolute';
  if (output.includes('\\')) return 'backslash';
  if (output.split('/').includes('..')) return 'traversal';
  return null;
}

function targetsSkill(output) {
  return output.replaceAll('\\', '/').split('/').some((segment) => {
    const lower = segment.toLowerCase();
    return lower === 'skills' || lower === 'skill.md';
  });
}

/**
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{ sha256?: Function }} [primitives]
 * @returns {object} Report
 */
export function validateCompiledWorkflow(input, primitives = {}) {
  const bytes = asBytes(input);
  const sha256 = typeof primitives.sha256 === 'function' ? primitives.sha256 : null;
  const errors = [];

  const fail = (pointer, code, message, details) => {
    errors.push(makeDiagnostic({
      severity: SEVERITY.ERROR,
      code,
      path: COMPILED_WORKFLOW_FILENAME,
      line: null,
      pointer,
      message,
      details,
    }));
  };

  let parsed = null;
  let counts = { stages: 0, steps: 0, roles: 0, tasks: 0, skills: 0, constitutions: 0 };

  const finalize = () => {
    const schema = parsed !== null && parsed !== undefined && parsed.schema === COMPILED_WORKFLOW_SCHEMA ? COMPILED_WORKFLOW_SCHEMA : null;
    return buildReport({
      target: 'compiled-workflow',
      schema,
      artifact: {
        path: COMPILED_WORKFLOW_FILENAME,
        bytes: bytes.length,
        sha256: sha256 !== null ? sha256(bytes) : null,
      },
      id: parsed !== null && typeof parsed?.id === 'string' ? parsed.id : null,
      version: parsed !== null && typeof parsed?.version === 'string' ? parsed.version : null,
      counts,
      errors,
      warnings: [],
    });
  };

  // P1 text decoding
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('', 'COMPILED_WORKFLOW_TEXT_ENCODING', 'compiled workflow file starts with a UTF-8 BOM', { pointer: '', reason: 'bom' });
    return finalize();
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail('', 'COMPILED_WORKFLOW_TEXT_ENCODING', 'compiled workflow file is not valid UTF-8', { pointer: '', reason: 'utf8' });
    return finalize();
  }
  if (text.includes('\r')) {
    fail('', 'COMPILED_WORKFLOW_TEXT_ENCODING', 'compiled workflow file contains a carriage return', { pointer: '', reason: 'cr' });
    return finalize();
  }

  // P2 JSON + canonical bytes
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('', 'COMPILED_WORKFLOW_JSON_PARSE', 'compiled workflow file is not valid JSON');
    return finalize();
  }
  const canonical = serializeCompiledWorkflow(parsed);
  if (canonical !== text) {
    fail('', 'COMPILED_WORKFLOW_JSON_NOT_CANONICAL', 'compiled workflow file is not canonical JSON', {
      offset: firstDifferenceOffset(canonical, text),
    });
  }
  if (!isPlainObject(parsed)) {
    fail('', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'compiled workflow must be a JSON object', { pointer: '', rule: 'type' });
    return finalize();
  }

  // P3 schema id
  if (parsed.schema !== COMPILED_WORKFLOW_SCHEMA) {
    const parsedId = parseSchemaId(parsed.schema);
    let reason = 'unknown';
    if (typeof parsed.schema !== 'string' || parsedId === null) reason = 'malformed';
    else if (parsedId.family === 'compiled-workflow' && parsedId.revision > SCHEMA_REVISION) reason = 'newer';
    fail('/schema', 'COMPILED_WORKFLOW_SCHEMA_UNSUPPORTED', 'compiled workflow schema is not supported', { reason });
    return finalize();
  }

  counts = countCompiledWorkflow(parsed);

  const checkUnknown = (value, fields, pointer) => {
    for (const key of Object.keys(value)) {
      if (fields.includes(key)) continue;
      const at = `${pointer}/${pointerSegment(key)}`;
      if (RUNTIME_KEYS.has(key)) {
        fail(at, 'COMPILED_WORKFLOW_RUNTIME_FIELD_LEAK', `runtime-only field in compiled workflow: ${key}`, { key });
      } else {
        fail(at, 'COMPILED_WORKFLOW_UNKNOWN_KEY', `unknown compiled workflow key: ${key}`, { pointer: at, key });
      }
    }
  };
  const checkMemberOrder = (value, fields, pointer) => {
    const known = Object.keys(value).filter((key) => fields.includes(key));
    const expected = fields.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
    if (known.join('\u0000') !== expected.join('\u0000')) {
      fail(pointer, 'COMPILED_WORKFLOW_ORDER_INVALID', 'object members are not in schema order', { kind: 'member' });
    }
  };
  const checkAscending = (values, pointer) => {
    for (let index = 1; index < values.length; index += 1) {
      if (compareCodePoints(values[index - 1], values[index]) > 0) {
        fail(pointer, 'COMPILED_WORKFLOW_ORDER_INVALID', 'array is not sorted, ascending', { kind: 'array' });
        return;
      }
    }
  };
  const checkMapOrder = (value, pointer) => {
    const keys = Object.keys(value);
    const sorted = [...keys].sort(compareCodePoints);
    const expected = Object.keys(Object.fromEntries(sorted.map((key) => [key, true])));
    if (keys.join('\u0000') !== expected.join('\u0000')) {
      fail(pointer, 'COMPILED_WORKFLOW_ORDER_INVALID', 'map keys are not in code-point order', { kind: 'map' });
    }
  };
  const checkTextEncoding = (value, pointer) => {
    if (typeof value !== 'string') return;
    if (value.includes('\r')) {
      fail(pointer, 'COMPILED_WORKFLOW_TEXT_ENCODING', 'embedded text contains a carriage return', { pointer, reason: 'cr' });
    } else if (value.startsWith('\uFEFF')) {
      fail(pointer, 'COMPILED_WORKFLOW_TEXT_ENCODING', 'embedded text starts with a BOM', { pointer, reason: 'bom' });
    } else if (hasLoneSurrogate(value)) {
      fail(pointer, 'COMPILED_WORKFLOW_TEXT_ENCODING', 'embedded text contains a lone surrogate', { pointer, reason: 'lone-surrogate' });
    } else if (value !== '' && !value.endsWith('\n')) {
      fail(pointer, 'COMPILED_WORKFLOW_TEXT_ENCODING', 'non-empty embedded text must end with a line feed', {
        pointer,
        reason: 'missing-final-lf',
      });
    }
  };

  checkUnknown(parsed, COMPILED_WORKFLOW_FIELDS, '');
  checkMemberOrder(parsed, COMPILED_WORKFLOW_FIELDS, '');
  for (const key of COMPILED_WORKFLOW_FIELDS) {
    if (key === 'requires') continue;
    if (parsed[key] === undefined) {
      fail(`/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `compiled workflow is missing '${key}'`, { pointer: `/${key}`, rule: 'required' });
    }
  }

  if (typeof parsed.id !== 'string' || idProblem(parsed.id, 40)) {
    fail('/id', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'compiled workflow id is invalid', { pointer: '/id', rule: 'pattern' });
  }
  if (lengthProblem(parsed.name, 1, 120) !== null) {
    fail('/name', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'compiled workflow name must be 1-120 characters', { pointer: '/name', rule: 'length' });
  }
  if (typeof parsed.version !== 'string' || !VERSION_RE.test(parsed.version)) {
    fail('/version', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'compiled workflow version is not strict semver', { pointer: '/version', rule: 'pattern' });
  }
  if (lengthProblem(parsed.description, 1, 2000) !== null) {
    fail('/description', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'compiled workflow description must be 1-2000 characters', {
      pointer: '/description',
      rule: 'length',
    });
  }

  // source
  let sourceValid = false;
  if (!isPlainObject(parsed.source)) {
    fail('/source', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'source' must be an object", { pointer: '/source', rule: 'type' });
  } else {
    const source = parsed.source;
    checkUnknown(source, COMPILED_WORKFLOW_SOURCE_FIELDS, '/source');
    checkMemberOrder(source, COMPILED_WORKFLOW_SOURCE_FIELDS, '/source');
    for (const key of COMPILED_WORKFLOW_SOURCE_FIELDS) {
      if (source[key] === undefined) {
        fail(`/source/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `source is missing '${key}'`, {
          pointer: `/source/${key}`,
          rule: 'required',
        });
      }
    }
    let bundleValid = false;
    if (!isPlainObject(source.bundle)) {
      fail('/source/bundle', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'source.bundle' must be an object", {
        pointer: '/source/bundle',
        rule: 'type',
      });
    } else {
      const bundle = source.bundle;
      checkUnknown(bundle, COMPILED_WORKFLOW_SOURCE_BUNDLE_FIELDS, '/source/bundle');
      checkMemberOrder(bundle, COMPILED_WORKFLOW_SOURCE_BUNDLE_FIELDS, '/source/bundle');
      for (const key of COMPILED_WORKFLOW_SOURCE_BUNDLE_FIELDS) {
        if (bundle[key] === undefined) {
          fail(`/source/bundle/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `source.bundle is missing '${key}'`, {
            pointer: `/source/bundle/${key}`,
            rule: 'required',
          });
        }
      }
      if (typeof bundle.schema !== 'string') {
        fail('/source/bundle/schema', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'source.bundle.schema must be a string', {
          pointer: '/source/bundle/schema',
          rule: 'type',
        });
      }
      if (typeof bundle.id !== 'string' || idProblem(bundle.id, 40)) {
        fail('/source/bundle/id', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'source.bundle.id is invalid', {
          pointer: '/source/bundle/id',
          rule: 'pattern',
        });
      }
      if (typeof bundle.version !== 'string' || !VERSION_RE.test(bundle.version)) {
        fail('/source/bundle/version', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'source.bundle.version is invalid', {
          pointer: '/source/bundle/version',
          rule: 'pattern',
        });
      }
      if (typeof bundle.contentSha256 !== 'string' || !SHA_RE.test(bundle.contentSha256)) {
        fail('/source/bundle/contentSha256', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'contentSha256 must be 64 lowercase hex', {
          pointer: '/source/bundle/contentSha256',
          rule: 'pattern',
        });
      }
      bundleValid = true;
    }
    let manifestValid = false;
    if (!isPlainObject(source.manifest)) {
      fail('/source/manifest', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'source.manifest' must be an object", {
        pointer: '/source/manifest',
        rule: 'type',
      });
    } else {
      const manifest = source.manifest;
      checkUnknown(manifest, COMPILED_WORKFLOW_SOURCE_MANIFEST_FIELDS, '/source/manifest');
      checkMemberOrder(manifest, COMPILED_WORKFLOW_SOURCE_MANIFEST_FIELDS, '/source/manifest');
      if (typeof manifest.path !== 'string') {
        fail('/source/manifest/path', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'manifest path must be a string', {
          pointer: '/source/manifest/path',
          rule: 'type',
        });
      }
      if (typeof manifest.sha256 !== 'string' || !SHA_RE.test(manifest.sha256)) {
        fail('/source/manifest/sha256', 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'manifest sha256 must be 64 lowercase hex', {
          pointer: '/source/manifest/sha256',
          rule: 'pattern',
        });
      }
      manifestValid = true;
    }
    sourceValid = bundleValid && manifestValid;

    if (bundleValid) {
      if (parsed.id !== source.bundle.id) {
        fail('/id', 'COMPILED_WORKFLOW_SOURCE_MISMATCH', 'compiled workflow id differs from source.bundle.id', { field: 'id' });
      }
      if (parsed.version !== source.bundle.version) {
        fail('/version', 'COMPILED_WORKFLOW_SOURCE_MISMATCH', 'compiled workflow version differs from source.bundle.version', { field: 'version' });
      }
      if (source.bundle.schema !== COMPILED_WORKFLOW_BUNDLE_SCHEMA) {
        fail('/source/bundle/schema', 'COMPILED_WORKFLOW_SOURCE_MISMATCH', `source bundle schema must be ${COMPILED_WORKFLOW_BUNDLE_SCHEMA}`, {
          field: 'source.bundle.schema',
        });
      }
    }
    if (manifestValid && source.manifest.path !== 'bundle.json') {
      fail('/source/manifest/path', 'COMPILED_WORKFLOW_SOURCE_MISMATCH', 'manifest path must be bundle.json', {
        field: 'source.manifest.path',
      });
    }
  }

  // requires
  if (parsed.requires !== undefined) {
    if (!isPlainObject(parsed.requires)) {
      fail('/requires', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'requires' must be an object", { pointer: '/requires', rule: 'type' });
    } else {
      const requires = parsed.requires;
      checkUnknown(requires, COMPILED_WORKFLOW_REQUIRES_FIELDS, '/requires');
      checkMemberOrder(requires, COMPILED_WORKFLOW_REQUIRES_FIELDS, '/requires');
      if (Object.keys(requires).length === 0) {
        fail('/requires', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'requires' must declare at least one key", {
          pointer: '/requires',
          rule: 'minProperties',
        });
      }
      if (requires.engine !== undefined) {
        if (typeof requires.engine !== 'string' || !isValidRange(requires.engine)) {
          fail('/requires/engine', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'requires.engine' is not a supported range", {
            pointer: '/requires/engine',
            rule: 'range',
          });
        }
      }
      if (requires.projections !== undefined) {
        if (!Array.isArray(requires.projections) || requires.projections.length === 0) {
          fail('/requires/projections', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'requires.projections' must be a non-empty array", {
            pointer: '/requires/projections',
            rule: 'type',
          });
        } else {
          const seen = new Set();
          requires.projections.forEach((item, index) => {
            const pointer = `/requires/projections/${index}`;
            if (typeof item !== 'string' || !['runner', 'agent-native'].includes(item) || seen.has(item)) {
              fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'projection entry is invalid', { pointer, rule: 'enum' });
            }
            if (typeof item === 'string') seen.add(item);
          });
          checkAscending(requires.projections.filter((item) => typeof item === 'string'), '/requires/projections');
        }
      }
    }
  }

  // stages / maps -----------------------------------------------------------
  const stageIds = new Set();
  const stepIds = new Set();
  const checkSourceRef = (ref, pointer) => {
    if (!isPlainObject(ref)) {
      fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'source reference must be an object', { pointer, rule: 'type' });
      return;
    }
    checkUnknown(ref, COMPILED_WORKFLOW_SOURCE_REF_FIELDS, pointer);
    checkMemberOrder(ref, COMPILED_WORKFLOW_SOURCE_REF_FIELDS, pointer);
    if (typeof ref.path !== 'string' || !SOURCE_PATH_RE.test(ref.path)) {
      fail(`${pointer}/path`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'source path is not a contract path', {
        pointer: `${pointer}/path`,
        rule: 'pattern',
      });
    }
    if (typeof ref.sha256 !== 'string' || !SHA_RE.test(ref.sha256)) {
      fail(`${pointer}/sha256`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'source sha256 must be 64 lowercase hex', {
        pointer: `${pointer}/sha256`,
        rule: 'pattern',
      });
    }
  };

  if (!Array.isArray(parsed.stages)) {
    fail('/stages', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'stages' must be an array", { pointer: '/stages', rule: 'type' });
  } else {
    if (parsed.stages.length === 0) {
      fail('/stages', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'stages' must not be empty", { pointer: '/stages', rule: 'minItems' });
    }
    parsed.stages.forEach((stage, stageIndex) => {
      const pointer = `/stages/${stageIndex}`;
      if (!isPlainObject(stage)) {
        fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'stage must be an object', { pointer, rule: 'type' });
        return;
      }
      checkUnknown(stage, COMPILED_WORKFLOW_STAGE_FIELDS, pointer);
      checkMemberOrder(stage, COMPILED_WORKFLOW_STAGE_FIELDS, pointer);
      for (const key of ['id', 'name', 'steps', 'source']) {
        if (stage[key] === undefined) {
          fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `stage is missing '${key}'`, {
            pointer: `${pointer}/${key}`,
            rule: 'required',
          });
        }
      }
      if (typeof stage.id !== 'string' || idProblem(stage.id)) {
        fail(`${pointer}/id`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'stage id is invalid', { pointer: `${pointer}/id`, rule: 'pattern' });
      } else if (stageIds.has(stage.id)) {
        fail(`${pointer}/id`, 'COMPILED_WORKFLOW_STAGE_DUPLICATE', `duplicate stage id: ${stage.id}`, { first: stage.id });
      } else {
        stageIds.add(stage.id);
      }
      if (lengthProblem(stage.name, 1, 120) !== null) {
        fail(`${pointer}/name`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'stage name must be 1-120 characters', {
          pointer: `${pointer}/name`,
          rule: 'length',
        });
      }
      if (stage.description !== undefined && lengthProblem(stage.description, 1, 2000) !== null) {
        fail(`${pointer}/description`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'stage description must be 1-2000 characters', {
          pointer: `${pointer}/description`,
          rule: 'length',
        });
      }
      checkSourceRef(stage.source, `${pointer}/source`);
      if (typeof stage.id === 'string' && isPlainObject(stage.source)
        && typeof stage.source.path === 'string' && stage.source.path !== `stages/${stage.id}.json`) {
        fail(`${pointer}/source/path`, 'COMPILED_WORKFLOW_SOURCE_PATH_MISMATCH', 'stage source path does not match the stage id', {
          kind: 'stage',
          id: stage.id,
          path: stage.source.path,
        });
      }
      if (!Array.isArray(stage.steps)) {
        fail(`${pointer}/steps`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'steps' must be an array", {
          pointer: `${pointer}/steps`,
          rule: 'type',
        });
        return;
      }
      if (stage.steps.length === 0) {
        fail(`${pointer}/steps`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'steps' must not be empty", {
          pointer: `${pointer}/steps`,
          rule: 'minItems',
        });
      }
      stage.steps.forEach((step, stepIndex) => {
        const stepPointer = `${pointer}/steps/${stepIndex}`;
        if (!isPlainObject(step)) {
          fail(stepPointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'step must be an object', { pointer: stepPointer, rule: 'type' });
          return;
        }
        checkUnknown(step, COMPILED_WORKFLOW_STEP_FIELDS, stepPointer);
        checkMemberOrder(step, COMPILED_WORKFLOW_STEP_FIELDS, stepPointer);
        for (const key of ['id', 'name', 'task', 'skills', 'outputs', 'gates']) {
          if (step[key] === undefined) {
            fail(`${stepPointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `step is missing '${key}'`, {
              pointer: `${stepPointer}/${key}`,
              rule: 'required',
            });
          }
        }
        if (typeof step.id !== 'string' || idProblem(step.id)) {
          fail(`${stepPointer}/id`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'step id is invalid', {
            pointer: `${stepPointer}/id`,
            rule: 'pattern',
          });
        } else if (stepIds.has(step.id)) {
          fail(`${stepPointer}/id`, 'COMPILED_WORKFLOW_STEP_DUPLICATE', `duplicate step id: ${step.id}`, { first: step.id });
        } else {
          stepIds.add(step.id);
        }
        if (lengthProblem(step.name, 1, 120) !== null) {
          fail(`${stepPointer}/name`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'step name must be 1-120 characters', {
            pointer: `${stepPointer}/name`,
            rule: 'length',
          });
        }
        if (step.role !== undefined && (typeof step.role !== 'string' || idProblem(step.role))) {
          fail(`${stepPointer}/role`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'step role must be a bare id', {
            pointer: `${stepPointer}/role`,
            rule: 'pattern',
          });
        }
        if (step.task !== undefined && (typeof step.task !== 'string' || idProblem(step.task))) {
          fail(`${stepPointer}/task`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'step task must be a bare id', {
            pointer: `${stepPointer}/task`,
            rule: 'pattern',
          });
        }
        if (Array.isArray(step.skills)) {
          step.skills.forEach((skill, index) => {
            if (typeof skill !== 'string' || idProblem(skill)) {
              fail(`${stepPointer}/skills/${index}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'skill entry must be a bare id', {
                pointer: `${stepPointer}/skills/${index}`,
                rule: 'pattern',
              });
            }
          });
          checkAscending(step.skills.filter((skill) => typeof skill === 'string'), `${stepPointer}/skills`);
        } else if (step.skills !== undefined) {
          fail(`${stepPointer}/skills`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'skills' must be an array", {
            pointer: `${stepPointer}/skills`,
            rule: 'type',
          });
        }
        checkOutputs(step.outputs, `${stepPointer}/outputs`, fail);
        checkGates(step.gates, `${stepPointer}/gates`, fail);
      });
    });
  }

  const mapChecks = [
    {
      key: 'roles',
      fields: COMPILED_WORKFLOW_ROLE_FIELDS,
      reserved: ['main', 'sub'],
      checkValue: checkRole,
      pathFor: (id) => `roles/${id}.md`,
      mapPointer: '/roles',
    },
    {
      key: 'tasks',
      fields: COMPILED_WORKFLOW_TASK_FIELDS,
      reserved: [],
      checkValue: checkTask,
      pathFor: (id) => `tasks/${id}.md`,
      mapPointer: '/tasks',
    },
    {
      key: 'skills',
      fields: COMPILED_WORKFLOW_SKILL_FIELDS,
      reserved: ['synced', 'anthropic-skills'],
      checkValue: checkSkill,
      pathFor: (id) => `skills/${id}/SKILL.md`,
      mapPointer: '/skills',
    },
  ];

  for (const spec of mapChecks) {
    const map = parsed[spec.key];
    if (!isPlainObject(map)) {
      fail(`/${spec.key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `'${spec.key}' must be an object`, {
        pointer: `/${spec.key}`,
        rule: 'type',
      });
      continue;
    }
    if (spec.key === 'tasks' && Object.keys(map).length === 0) {
      fail('/tasks', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'tasks' must not be empty", { pointer: '/tasks', rule: 'minProperties' });
    }
    checkMapOrder(map, spec.mapPointer);
    for (const [id, value] of Object.entries(map)) {
      const pointer = `${spec.mapPointer}/${pointerSegment(id)}`;
      if (idProblem(id)) {
        fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${spec.key} key is not a valid id`, { pointer, rule: 'pattern' });
        continue;
      }
      if (spec.reserved.includes(id)) {
        fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${spec.key} key is reserved: ${id}`, { pointer, rule: 'reserved' });
      }
      if (!isPlainObject(value)) {
        fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${spec.key} entry must be an object`, { pointer, rule: 'type' });
        continue;
      }
      checkUnknown(value, spec.fields, pointer);
      checkMemberOrder(value, spec.fields, pointer);
      spec.checkValue(value, pointer, fail, checkTextEncoding, checkAscending, checkSourceRef);
      if (isPlainObject(value.source) && typeof value.source.path === 'string'
        && value.source.path !== spec.pathFor(id)) {
        fail(`${pointer}/source/path`, 'COMPILED_WORKFLOW_SOURCE_PATH_MISMATCH', `${spec.key} source path does not match the id`, {
          kind: spec.key,
          id,
          path: value.source.path,
        });
      }
    }
  }

  // assets: knowledgeBase / checklists / hooks / mcp -----------------------
  const checkAssetRecord = (value, pointer, fields, label) => {
    if (!isPlainObject(value)) {
      fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${label} must be an object`, { pointer, rule: 'type' });
      return null;
    }
    checkUnknown(value, fields, pointer);
    checkMemberOrder(value, fields, pointer);
    for (const key of fields) {
      if (value[key] === undefined) {
        fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${label} is missing '${key}'`, {
          pointer: `${pointer}/${key}`,
          rule: 'required',
        });
      }
    }
    if (value.body !== undefined) {
      if (typeof value.body !== 'string') {
        fail(`${pointer}/body`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${label} body must be a string`, {
          pointer: `${pointer}/body`,
          rule: 'type',
        });
      } else {
        checkTextEncoding(value.body, `${pointer}/body`);
      }
    }
    checkSourceRef(value.source, `${pointer}/source`);
    return value;
  };
  const checkAssetSourcePath = (record, pointer, expected, kind) => {
    if (isPlainObject(record.source) && typeof record.source.path === 'string'
      && record.source.path !== expected) {
      fail(`${pointer}/source/path`, 'COMPILED_WORKFLOW_SOURCE_PATH_MISMATCH', `${kind} source path does not match the asset`, {
        kind,
        path: record.source.path,
      });
    }
  };
  const checkAssetArray = (key, fields, label, identityOf, expectedPathOf) => {
    const value = parsed[key];
    if (!Array.isArray(value)) {
      fail(`/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `'${key}' must be an array`, { pointer: `/${key}`, rule: 'type' });
      return;
    }
    const seen = new Set();
    const identities = [];
    value.forEach((item, index) => {
      const pointer = `/${key}/${index}`;
      const record = checkAssetRecord(item, pointer, fields, label);
      if (record === null) return;
      const identity = identityOf(record);
      if (typeof identity !== 'string') return;
      const expectedPath = expectedPathOf(identity);
      if (expectedPath === null) {
        fail(`${pointer}/${fields[0]}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${label} ${fields[0]} is not a contract value`, {
          pointer: `${pointer}/${fields[0]}`,
          rule: 'pattern',
        });
        return;
      }
      if (seen.has(identity)) {
        fail(`${pointer}/${fields[0]}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `${label} is repeated: ${identity}`, {
          pointer: `${pointer}/${fields[0]}`,
          rule: 'uniqueItems',
        });
        return;
      }
      seen.add(identity);
      identities.push(identity);
      checkAssetSourcePath(record, pointer, expectedPath, key);
    });
    checkAscending(identities, `/${key}`);
  };

  checkAssetArray(
    'knowledgeBase',
    COMPILED_WORKFLOW_KNOWLEDGE_BASE_FIELDS,
    'knowledge-base entry',
    (record) => record.path,
    // ASCII-only charset, so code points equal UTF-8 bytes.
    (path) => (KNOWLEDGE_BASE_RE.test(path) && path.split('/').length <= 4
      && codePointLength(path) <= 100 ? path : null),
  );
  checkAssetArray(
    'checklists',
    COMPILED_WORKFLOW_CHECKLIST_FIELDS,
    'checklist',
    (record) => record.id,
    (id) => (idProblem(id) ? null : compiledWorkflowChecklistPath(id)),
  );

  const checkAssetFile = (key, fields, expectedPath, shape) => {
    const value = parsed[key];
    if (value === undefined) return;
    if (value === null) return;
    if (!isPlainObject(value)) {
      fail(`/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `'${key}' must be null or an object`, {
        pointer: `/${key}`,
        rule: 'type',
      });
      return;
    }
    const pointer = `/${key}`;
    const record = checkAssetRecord(value, pointer, fields, key);
    if (record === null) return;
    if (typeof record.path === 'string' && record.path !== expectedPath) {
      fail(`${pointer}/path`, 'COMPILED_WORKFLOW_SOURCE_PATH_MISMATCH', `${key} path must be ${expectedPath}`, {
        kind: key,
        path: record.path,
      });
    }
    checkAssetSourcePath(record, pointer, expectedPath, key);
    if (typeof record.body !== 'string') return;
    let asset;
    try {
      asset = JSON.parse(record.body);
    } catch {
      fail(`${pointer}/body`, 'COMPILED_WORKFLOW_ASSET_INVALID', `${key} body is not JSON`, { rule: 'json' });
      return;
    }
    if (canonicalJson(asset) !== record.body) {
      fail(`${pointer}/body`, 'COMPILED_WORKFLOW_ASSET_INVALID', `${key} body is not canonical JSON`, { rule: 'not-canonical' });
      return;
    }
    shape?.(asset, `${pointer}/body`);
  };

  checkAssetFile('hooks', COMPILED_WORKFLOW_HOOKS_FIELDS, COMPILED_WORKFLOW_HOOKS_PATH);
  checkAssetFile('mcp', COMPILED_WORKFLOW_MCP_FIELDS, COMPILED_WORKFLOW_MCP_PATH, (asset, pointer) => {
    if (isPlainObject(asset) && isPlainObject(asset.mcpServers)) return;
    fail(pointer, 'COMPILED_WORKFLOW_ASSET_INVALID', "mcp body must carry an object under 'mcpServers'", { rule: 'mcp-shape' });
  });

  // references
  const roles = isPlainObject(parsed.roles) ? parsed.roles : {};
  const tasks = isPlainObject(parsed.tasks) ? parsed.tasks : {};
  const skills = isPlainObject(parsed.skills) ? parsed.skills : {};
  if (Array.isArray(parsed.stages)) {
    parsed.stages.forEach((stage, stageIndex) => {
      if (!isPlainObject(stage) || !Array.isArray(stage.steps)) return;
      stage.steps.forEach((step, stepIndex) => {
        if (!isPlainObject(step)) return;
        const pointer = `/stages/${stageIndex}/steps/${stepIndex}`;
        if (typeof step.role === 'string' && !Object.prototype.hasOwnProperty.call(roles, step.role)) {
          fail(`${pointer}/role`, 'COMPILED_WORKFLOW_STEP_REF_UNDECLARED', `step references an undeclared role: ${step.role}`, {
            pointer: `${pointer}/role`,
            field: 'role',
            id: step.role,
          });
        }
        if (typeof step.task === 'string' && !Object.prototype.hasOwnProperty.call(tasks, step.task)) {
          fail(`${pointer}/task`, 'COMPILED_WORKFLOW_STEP_REF_UNDECLARED', `step references an undeclared task: ${step.task}`, {
            pointer: `${pointer}/task`,
            field: 'task',
            id: step.task,
          });
        }
        if (Array.isArray(step.skills)) {
          step.skills.forEach((skill, skillIndex) => {
            if (typeof skill === 'string' && !Object.prototype.hasOwnProperty.call(skills, skill)) {
              fail(`${pointer}/skills/${skillIndex}`, 'COMPILED_WORKFLOW_STEP_REF_UNDECLARED', `step references an undeclared skill: ${skill}`, {
                pointer: `${pointer}/skills/${skillIndex}`,
                field: 'skills',
                id: skill,
              });
            }
          });
        }
      });
    });
  }

  // constitution
  if (!Array.isArray(parsed.constitution)) {
    fail('/constitution', 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'constitution' must be an array", {
      pointer: '/constitution',
      rule: 'type',
    });
  } else {
    if (parsed.constitution.length > 1) {
      fail('/constitution', 'COMPILED_WORKFLOW_CONSTITUTION_SCOPE', 'v1 allows at most one constitution mount', {
        reason: 'count',
      });
    }
    parsed.constitution.forEach((mount, index) => {
      const pointer = `/constitution/${index}`;
      if (!isPlainObject(mount)) {
        fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'constitution mount must be an object', { pointer, rule: 'type' });
        return;
      }
      checkUnknown(mount, COMPILED_WORKFLOW_CONSTITUTION_FIELDS, pointer);
      checkMemberOrder(mount, COMPILED_WORKFLOW_CONSTITUTION_FIELDS, pointer);
      for (const key of ['scope', 'placeholder', 'body', 'source']) {
        if (mount[key] === undefined) {
          fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `constitution is missing '${key}'`, {
            pointer: `${pointer}/${key}`,
            rule: 'required',
          });
        }
      }
      if (mount.scope !== undefined && !['global', 'stage', 'step'].includes(mount.scope)) {
        fail(`${pointer}/scope`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'constitution scope is not a known value', {
          pointer: `${pointer}/scope`,
          rule: 'enum',
        });
      }
      if (mount.scope !== undefined && (mount.scope !== 'global' || mount.target !== undefined)) {
        fail(`${pointer}/scope`, 'COMPILED_WORKFLOW_CONSTITUTION_SCOPE', 'v1 only supports a global constitution mount', {
          reason: mount.target !== undefined ? 'target' : 'scope',
        });
      }
      if (typeof mount.placeholder !== 'boolean') {
        fail(`${pointer}/placeholder`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'constitution placeholder must be a boolean', {
          pointer: `${pointer}/placeholder`,
          rule: 'type',
        });
      }
      if (mount.body !== undefined && typeof mount.body !== 'string') {
        fail(`${pointer}/body`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'constitution body must be a string', {
          pointer: `${pointer}/body`,
          rule: 'type',
        });
      }
      if (typeof mount.body === 'string') {
        checkTextEncoding(mount.body, `${pointer}/body`);
        if (/^---(\n|$)/.test(mount.body)) {
          fail(`${pointer}/body`, 'COMPILED_WORKFLOW_CONSTITUTION_INVALID', 'constitution must not carry frontmatter', {
            rule: 'frontmatter',
          });
        }
        if (mount.placeholder === false && nonEmptyLines(mount.body).length === 0) {
          fail(`${pointer}/body`, 'COMPILED_WORKFLOW_CONSTITUTION_INVALID', 'constitution is empty', { rule: 'empty' });
        }
        if (encoder.encode(mount.body).length > CONSTITUTION_MAX_BYTES) {
          fail(`${pointer}/body`, 'COMPILED_WORKFLOW_CONSTITUTION_INVALID', 'constitution exceeds the size limit', {
            rule: 'too-large',
          });
        }
      }
      checkSourceRef(mount.source, `${pointer}/source`);
      if (isPlainObject(mount.source) && typeof mount.source.path === 'string'
        && mount.source.path !== 'constitution/CONSTITUTION.md') {
        fail(`${pointer}/source/path`, 'COMPILED_WORKFLOW_SOURCE_PATH_MISMATCH', 'constitution path must be the fixed path', {
          kind: 'constitution',
          id: 'constitution',
          path: mount.source.path,
        });
      }
    });
  }

  // hash self-proof
  if (sourceValid && sha256 !== null) {
    const rows = [];
    let complete = true;
    const push = (path, hash) => {
      if (typeof path !== 'string' || typeof hash !== 'string' || !SHA_RE.test(hash)) complete = false;
      else rows.push([path, hash]);
    };
    push('bundle.json', parsed.source.manifest.sha256);
    if (Array.isArray(parsed.stages)) {
      for (const stage of parsed.stages) {
        if (!isPlainObject(stage)) {
          complete = false;
          continue;
        }
        push(`stages/${stage.id}.json`, stage.source?.sha256);
      }
    }
    for (const [kind, map] of [['roles', parsed.roles], ['tasks', parsed.tasks], ['skills', parsed.skills]]) {
      if (!isPlainObject(map)) {
        complete = false;
        continue;
      }
      for (const [id, value] of Object.entries(map)) {
        const path = kind === 'skills' ? `skills/${id}/SKILL.md` : `${kind}/${id}.md`;
        push(path, isPlainObject(value) ? value.source?.sha256 : undefined);
      }
    }
    if (Array.isArray(parsed.constitution)) {
      for (const mount of parsed.constitution) {
        if (isPlainObject(mount) && isPlainObject(mount.source)) push(mount.source.path, mount.source.sha256);
      }
    }
    for (const [key, identity] of [['knowledgeBase', 'path'], ['checklists', 'id']]) {
      for (const record of Array.isArray(parsed[key]) ? parsed[key] : []) {
        if (!isPlainObject(record) || !isPlainObject(record.source)
          || typeof record[identity] !== 'string') {
          complete = false;
          continue;
        }
        const path = key === 'checklists' ? compiledWorkflowChecklistPath(record.id) : record.path;
        push(path, record.source.sha256);
      }
    }
    for (const key of ['hooks', 'mcp']) {
      const record = parsed[key];
      if (record === null) continue;
      if (!isPlainObject(record) || !isPlainObject(record.source)) {
        complete = false;
        continue;
      }
      push(record.source.path, record.source.sha256);
    }
    if (complete) {
      rows.sort((left, right) => compareCodePoints(left[0], right[0]));
      const manifest = rows.map(([path, hash]) => `${path}\t${hash}\n`).join('');
      const expected = sha256(encoder.encode(manifest));
      if (expected !== parsed.source.bundle.contentSha256) {
        fail('/source/bundle/contentSha256', 'COMPILED_WORKFLOW_HASH_MISMATCH', 'contentSha256 does not match the embedded assets', {
          expected,
          actual: parsed.source.bundle.contentSha256,
        });
      }
    }
  }

  return finalize();
}

function countCompiledWorkflow(parsed) {
  const counts = { stages: 0, steps: 0, roles: 0, tasks: 0, skills: 0, constitutions: 0 };
  if (Array.isArray(parsed.stages)) {
    counts.stages = parsed.stages.length;
    for (const stage of parsed.stages) {
      if (isPlainObject(stage) && Array.isArray(stage.steps)) counts.steps += stage.steps.length;
    }
  }
  if (isPlainObject(parsed.roles)) counts.roles = Object.keys(parsed.roles).length;
  if (isPlainObject(parsed.tasks)) counts.tasks = Object.keys(parsed.tasks).length;
  if (isPlainObject(parsed.skills)) counts.skills = Object.keys(parsed.skills).length;
  if (Array.isArray(parsed.constitution)) counts.constitutions = parsed.constitution.length;
  return counts;
}

function checkOutputs(outputs, pointer, fail) {
  if (outputs === undefined) return;
  if (!Array.isArray(outputs)) {
    fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'outputs' must be an array", { pointer, rule: 'type' });
    return;
  }
  outputs.forEach((output, index) => {
    const at = `${pointer}/${index}`;
    if (typeof output !== 'string') {
      fail(at, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'output must be a string', { pointer: at, rule: 'type' });
      return;
    }
    if (!isValidGlob(output)) {
      fail(at, 'COMPILED_WORKFLOW_OUTPUT_INVALID_GLOB', 'output is not a valid glob', { pointer: at });
    }
    const reason = outputPathReason(output);
    if (reason !== null) {
      fail(at, 'COMPILED_WORKFLOW_OUTPUT_PATH_INVALID', 'output path is invalid', { pointer: at, reason });
    }
    if (targetsSkill(output)) {
      fail(at, 'COMPILED_WORKFLOW_OUTPUT_FORBIDDEN', 'output must not target the skill payload', { pointer: at });
    }
  });
}

function checkGates(gates, pointer, fail) {
  if (gates === undefined) return;
  if (!Array.isArray(gates)) {
    fail(pointer, 'COMPILED_WORKFLOW_SCHEMA_INVALID', "'gates' must be an array", { pointer, rule: 'type' });
    return;
  }
  gates.forEach((gate, index) => {
    const base = `${pointer}/${index}`;
    if (!isPlainObject(gate)) {
      fail(base, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'gate must be an object', { pointer: base, rule: 'type' });
      return;
    }
    for (const key of Object.keys(gate)) {
      if (!COMPILED_WORKFLOW_GATE_FIELDS.includes(key)) {
        fail(`${base}/${pointerSegment(key)}`, 'COMPILED_WORKFLOW_UNKNOWN_KEY', `unknown gate key: ${key}`, { key });
      }
    }
    const known = Object.keys(gate).filter((key) => COMPILED_WORKFLOW_GATE_FIELDS.includes(key));
    const expected = COMPILED_WORKFLOW_GATE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(gate, key));
    if (known.join('\u0000') !== expected.join('\u0000')) {
      fail(base, 'COMPILED_WORKFLOW_ORDER_INVALID', 'gate members are not in schema order', { kind: 'member' });
    }
    if (typeof gate.command !== 'string' || gate.command.trim() === ''
      || codePointLength(gate.command) > 2000) {
      fail(`${base}/command`, 'COMPILED_WORKFLOW_GATE_INVALID', 'gate command is invalid', {
        pointer: `${base}/command`,
        field: 'command',
      });
    }
    if (gate.timeout !== undefined && (typeof gate.timeout !== 'number' || !Number.isFinite(gate.timeout)
      || gate.timeout <= 0 || gate.timeout > 86400)) {
      fail(`${base}/timeout`, 'COMPILED_WORKFLOW_GATE_INVALID', 'gate timeout is invalid', {
        pointer: `${base}/timeout`,
        field: 'timeout',
      });
    }
  });
}

function checkRole(value, pointer, fail, checkTextEncoding, checkAscending, checkSourceRef) {
  for (const key of ['description', 'placeholder', 'instructions', 'source']) {
    if (value[key] === undefined) {
      fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `role is missing '${key}'`, {
        pointer: `${pointer}/${key}`,
        rule: 'required',
      });
    }
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    fail(`${pointer}/description`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'role description must be a string', {
      pointer: `${pointer}/description`,
      rule: 'type',
    });
  } else if (value.description !== undefined) {
    const length = codePointLength(value.description);
    if (length < 1 || length > 1024) {
      fail(`${pointer}/description`, 'COMPILED_WORKFLOW_ROLE_BODY_INVALID', 'role description must be 1-1024 characters', {
        rule: 'description',
      });
    }
  }
  if (value.title !== undefined && lengthProblem(value.title, 1, 120) !== null) {
    fail(`${pointer}/title`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'role title must be 1-120 characters', {
      pointer: `${pointer}/title`,
      rule: 'length',
    });
  }
  for (const key of ['mode', 'model', 'effort']) {
    if (value[key] !== undefined && !ROLE_ENUMS[key].includes(value[key])) {
      fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `role ${key} is not supported`, {
        pointer: `${pointer}/${key}`,
        rule: 'enum',
      });
    }
  }
  for (const key of ['tools', 'tools_deny', 'skills']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) {
      fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `role ${key} must be an array`, {
        pointer: `${pointer}/${key}`,
        rule: 'type',
      });
      continue;
    }
    value[key].forEach((item, index) => {
      if (typeof item !== 'string') {
        fail(`${pointer}/${key}/${index}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `role ${key} entry must be a string`, {
          pointer: `${pointer}/${key}/${index}`,
          rule: 'type',
        });
        return;
      }
      if (key === 'skills' ? idProblem(item) : !TOOLS.includes(item)) {
        fail(`${pointer}/${key}/${index}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `role ${key} entry is invalid: ${item}`, {
          pointer: `${pointer}/${key}/${index}`,
          rule: 'enum',
        });
      }
    });
    checkAscending(value[key].filter((item) => typeof item === 'string'), `${pointer}/${key}`);
  }
  if (value.placeholder !== undefined && typeof value.placeholder !== 'boolean') {
    fail(`${pointer}/placeholder`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'role placeholder must be a boolean', {
      pointer: `${pointer}/placeholder`,
      rule: 'type',
    });
  }
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== 'string') {
      fail(`${pointer}/instructions`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'role instructions must be a string', {
        pointer: `${pointer}/instructions`,
        rule: 'type',
      });
    } else {
      checkTextEncoding(value.instructions, `${pointer}/instructions`);
      if (value.placeholder === false && nonEmptyLines(value.instructions).length === 0) {
        fail(`${pointer}/instructions`, 'COMPILED_WORKFLOW_ROLE_BODY_INVALID', 'non-placeholder role instructions are empty', {
          rule: 'instructions-empty',
        });
      }
    }
  }
  checkSourceRef(value.source, `${pointer}/source`);
}

function checkTask(value, pointer, fail, checkTextEncoding, checkAscending, checkSourceRef) {
  for (const key of ['body', 'source']) {
    if (value[key] === undefined) {
      fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `task is missing '${key}'`, {
        pointer: `${pointer}/${key}`,
        rule: 'required',
      });
    }
  }
  if (value.title !== undefined && lengthProblem(value.title, 1, 120) !== null) {
    fail(`${pointer}/title`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'task title must be 1-120 characters', {
      pointer: `${pointer}/title`,
      rule: 'length',
    });
  }
  if (value.description !== undefined && lengthProblem(value.description, 1, 2000) !== null) {
    fail(`${pointer}/description`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'task description must be 1-2000 characters', {
      pointer: `${pointer}/description`,
      rule: 'length',
    });
  }
  if (value.body !== undefined) {
    if (typeof value.body !== 'string') {
      fail(`${pointer}/body`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'task body must be a string', {
        pointer: `${pointer}/body`,
        rule: 'type',
      });
    } else {
      checkTextEncoding(value.body, `${pointer}/body`);
      const scan = scanTaskBody(value.body);
      const first = scan.issues[0];
      if (first !== undefined) {
        fail(`${pointer}/body`, 'COMPILED_WORKFLOW_TASK_BODY_INVALID', `task body structure is invalid: ${first.rule}`, {
          rule: first.rule === 'submit-marker' ? 'submit-marker' : first.rule,
        });
      }
    }
  }
  checkSourceRef(value.source, `${pointer}/source`);
}

function checkSkill(value, pointer, fail, checkTextEncoding, checkAscending, checkSourceRef) {
  for (const key of ['description', 'placeholder', 'body', 'source']) {
    if (value[key] === undefined) {
      fail(`${pointer}/${key}`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', `skill is missing '${key}'`, {
        pointer: `${pointer}/${key}`,
        rule: 'required',
      });
    }
  }
  if (value.description !== undefined && lengthProblem(value.description, 1, 1024) !== null) {
    fail(`${pointer}/description`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'skill description must be 1-1024 characters', {
      pointer: `${pointer}/description`,
      rule: 'length',
    });
  }
  if (value.placeholder !== undefined && typeof value.placeholder !== 'boolean') {
    fail(`${pointer}/placeholder`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'skill placeholder must be a boolean', {
      pointer: `${pointer}/placeholder`,
      rule: 'type',
    });
  }
  if (value.body !== undefined) {
    if (typeof value.body !== 'string') {
      fail(`${pointer}/body`, 'COMPILED_WORKFLOW_SCHEMA_INVALID', 'skill body must be a string', {
        pointer: `${pointer}/body`,
        rule: 'type',
      });
    } else {
      checkTextEncoding(value.body, `${pointer}/body`);
      if (value.placeholder === true) {
        if (!PLACEHOLDER_BANNER.test(preamble(value.body))) {
          fail(`${pointer}/body`, 'COMPILED_WORKFLOW_SKILL_BODY_INVALID', 'placeholder skill is missing the visible banner', {
            rule: 'placeholder-banner',
          });
        }
      } else if (nonEmptyLines(value.body).length === 0) {
        fail(`${pointer}/body`, 'COMPILED_WORKFLOW_SKILL_BODY_INVALID', 'skill body is empty', { rule: 'body-empty' });
      }
    }
  }
  checkSourceRef(value.source, `${pointer}/source`);
}

