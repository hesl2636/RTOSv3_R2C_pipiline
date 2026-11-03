/**
 * `hm2b.ir/v1` validation (decision #67 §8).
 *
 * Bytes in, report out. IR diagnostics are errors only: the IR is a machine
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
  IR_BUNDLE_SCHEMA,
  IR_CONSTITUTION_FIELDS,
  IR_FIELDS,
  IR_FILENAME,
  IR_GATE_FIELDS,
  IR_REQUIRES_FIELDS,
  IR_ROLE_FIELDS,
  IR_SCHEMA,
  IR_SKILL_FIELDS,
  IR_SOURCE_BUNDLE_FIELDS,
  IR_SOURCE_FIELDS,
  IR_SOURCE_MANIFEST_FIELDS,
  IR_SOURCE_REF_FIELDS,
  IR_STAGE_FIELDS,
  IR_STEP_FIELDS,
  IR_TASK_FIELDS,
} from '../ir/schema.js';
import { scanTaskBody } from './markdown.js';
import { hasLoneSurrogate, isPlainObject, nonEmptyLines, preamble } from './util.js';

export const IR_SUMMARY_CODE = 'IR_INVALID';

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SOURCE_PATH_RE = /^(?:stages\/[a-z0-9]+(?:-[a-z0-9]+)*\.json|roles\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|tasks\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md|constitution\/CONSTITUTION\.md)$/;
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
export function validateIr(input, primitives = {}) {
  const bytes = asBytes(input);
  const sha256 = typeof primitives.sha256 === 'function' ? primitives.sha256 : null;
  const errors = [];

  const fail = (pointer, code, message, details) => {
    errors.push(makeDiagnostic({
      severity: SEVERITY.ERROR,
      code,
      path: IR_FILENAME,
      line: null,
      pointer,
      message,
      details,
    }));
  };

  let parsed = null;
  let counts = { stages: 0, steps: 0, roles: 0, tasks: 0, skills: 0, constitutions: 0 };

  const finalize = () => {
    const schema = parsed !== null && parsed !== undefined && parsed.schema === IR_SCHEMA ? IR_SCHEMA : null;
    return buildReport({
      target: 'ir',
      schema,
      artifact: {
        path: IR_FILENAME,
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
    fail('', 'IR_TEXT_ENCODING', 'IR file starts with a UTF-8 BOM', { pointer: '', reason: 'bom' });
    return finalize();
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    fail('', 'IR_TEXT_ENCODING', 'IR file is not valid UTF-8', { pointer: '', reason: 'utf8' });
    return finalize();
  }
  if (text.includes('\r')) {
    fail('', 'IR_TEXT_ENCODING', 'IR file contains a carriage return', { pointer: '', reason: 'cr' });
    return finalize();
  }

  // P2 JSON + canonical bytes
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('', 'IR_JSON_PARSE', 'IR file is not valid JSON');
    return finalize();
  }
  const canonical = canonicalJson(parsed);
  if (canonical !== text) {
    fail('', 'IR_JSON_NOT_CANONICAL', 'IR file is not canonical JSON', {
      offset: firstDifferenceOffset(canonical, text),
    });
  }
  if (!isPlainObject(parsed)) {
    fail('', 'IR_SCHEMA_INVALID', 'IR must be a JSON object', { pointer: '', rule: 'type' });
    return finalize();
  }

  // P3 schema id
  if (parsed.schema !== IR_SCHEMA) {
    const parsedId = parseSchemaId(parsed.schema);
    let reason = 'unknown';
    if (typeof parsed.schema !== 'string' || parsedId === null) reason = 'malformed';
    else if (parsedId.family === 'ir' && parsedId.revision > 1) reason = 'newer';
    fail('/schema', 'IR_SCHEMA_UNSUPPORTED', 'IR schema is not supported', { reason });
    return finalize();
  }

  counts = countIr(parsed);

  const checkUnknown = (value, fields, pointer) => {
    for (const key of Object.keys(value)) {
      if (fields.includes(key)) continue;
      const at = `${pointer}/${pointerSegment(key)}`;
      if (RUNTIME_KEYS.has(key)) {
        fail(at, 'IR_RUNTIME_FIELD_LEAK', `runtime-only field in IR: ${key}`, { key });
      } else {
        fail(at, 'IR_UNKNOWN_KEY', `unknown IR key: ${key}`, { pointer: at, key });
      }
    }
  };
  const checkMemberOrder = (value, fields, pointer) => {
    const known = Object.keys(value).filter((key) => fields.includes(key));
    const expected = fields.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
    if (known.join('\u0000') !== expected.join('\u0000')) {
      fail(pointer, 'IR_ORDER_INVALID', 'object members are not in schema order', { kind: 'member' });
    }
  };
  const checkAscending = (values, pointer) => {
    for (let index = 1; index < values.length; index += 1) {
      if (compareCodePoints(values[index - 1], values[index]) > 0) {
        fail(pointer, 'IR_ORDER_INVALID', 'array is not sorted, ascending', { kind: 'array' });
        return;
      }
    }
  };
  const checkMapOrder = (value, pointer) => {
    const keys = Object.keys(value);
    const sorted = [...keys].sort(compareCodePoints);
    const expected = Object.keys(Object.fromEntries(sorted.map((key) => [key, true])));
    if (keys.join('\u0000') !== expected.join('\u0000')) {
      fail(pointer, 'IR_ORDER_INVALID', 'map keys are not in code-point order', { kind: 'map' });
    }
  };
  const checkTextEncoding = (value, pointer) => {
    if (typeof value !== 'string') return;
    if (value.includes('\r')) {
      fail(pointer, 'IR_TEXT_ENCODING', 'embedded text contains a carriage return', { pointer, reason: 'cr' });
    } else if (value.startsWith('\uFEFF')) {
      fail(pointer, 'IR_TEXT_ENCODING', 'embedded text starts with a BOM', { pointer, reason: 'bom' });
    } else if (hasLoneSurrogate(value)) {
      fail(pointer, 'IR_TEXT_ENCODING', 'embedded text contains a lone surrogate', { pointer, reason: 'lone-surrogate' });
    } else if (value !== '' && !value.endsWith('\n')) {
      fail(pointer, 'IR_TEXT_ENCODING', 'non-empty embedded text must end with a line feed', {
        pointer,
        reason: 'missing-final-lf',
      });
    }
  };

  checkUnknown(parsed, IR_FIELDS, '');
  checkMemberOrder(parsed, IR_FIELDS, '');
  for (const key of IR_FIELDS) {
    if (key === 'requires') continue;
    if (parsed[key] === undefined) {
      fail(`/${key}`, 'IR_SCHEMA_INVALID', `IR is missing '${key}'`, { pointer: `/${key}`, rule: 'required' });
    }
  }

  if (typeof parsed.id !== 'string' || idProblem(parsed.id, 40)) {
    fail('/id', 'IR_SCHEMA_INVALID', 'IR id is invalid', { pointer: '/id', rule: 'pattern' });
  }
  if (lengthProblem(parsed.name, 1, 120) !== null) {
    fail('/name', 'IR_SCHEMA_INVALID', 'IR name must be 1-120 characters', { pointer: '/name', rule: 'length' });
  }
  if (typeof parsed.version !== 'string' || !VERSION_RE.test(parsed.version)) {
    fail('/version', 'IR_SCHEMA_INVALID', 'IR version is not strict semver', { pointer: '/version', rule: 'pattern' });
  }
  if (lengthProblem(parsed.description, 1, 2000) !== null) {
    fail('/description', 'IR_SCHEMA_INVALID', 'IR description must be 1-2000 characters', {
      pointer: '/description',
      rule: 'length',
    });
  }

  // source
  let sourceValid = false;
  if (!isPlainObject(parsed.source)) {
    fail('/source', 'IR_SCHEMA_INVALID', "'source' must be an object", { pointer: '/source', rule: 'type' });
  } else {
    const source = parsed.source;
    checkUnknown(source, IR_SOURCE_FIELDS, '/source');
    checkMemberOrder(source, IR_SOURCE_FIELDS, '/source');
    for (const key of IR_SOURCE_FIELDS) {
      if (source[key] === undefined) {
        fail(`/source/${key}`, 'IR_SCHEMA_INVALID', `source is missing '${key}'`, {
          pointer: `/source/${key}`,
          rule: 'required',
        });
      }
    }
    let bundleValid = false;
    if (!isPlainObject(source.bundle)) {
      fail('/source/bundle', 'IR_SCHEMA_INVALID', "'source.bundle' must be an object", {
        pointer: '/source/bundle',
        rule: 'type',
      });
    } else {
      const bundle = source.bundle;
      checkUnknown(bundle, IR_SOURCE_BUNDLE_FIELDS, '/source/bundle');
      checkMemberOrder(bundle, IR_SOURCE_BUNDLE_FIELDS, '/source/bundle');
      for (const key of IR_SOURCE_BUNDLE_FIELDS) {
        if (bundle[key] === undefined) {
          fail(`/source/bundle/${key}`, 'IR_SCHEMA_INVALID', `source.bundle is missing '${key}'`, {
            pointer: `/source/bundle/${key}`,
            rule: 'required',
          });
        }
      }
      if (typeof bundle.schema !== 'string') {
        fail('/source/bundle/schema', 'IR_SCHEMA_INVALID', 'source.bundle.schema must be a string', {
          pointer: '/source/bundle/schema',
          rule: 'type',
        });
      }
      if (typeof bundle.id !== 'string' || idProblem(bundle.id, 40)) {
        fail('/source/bundle/id', 'IR_SCHEMA_INVALID', 'source.bundle.id is invalid', {
          pointer: '/source/bundle/id',
          rule: 'pattern',
        });
      }
      if (typeof bundle.version !== 'string' || !VERSION_RE.test(bundle.version)) {
        fail('/source/bundle/version', 'IR_SCHEMA_INVALID', 'source.bundle.version is invalid', {
          pointer: '/source/bundle/version',
          rule: 'pattern',
        });
      }
      if (typeof bundle.contentSha256 !== 'string' || !SHA_RE.test(bundle.contentSha256)) {
        fail('/source/bundle/contentSha256', 'IR_SCHEMA_INVALID', 'contentSha256 must be 64 lowercase hex', {
          pointer: '/source/bundle/contentSha256',
          rule: 'pattern',
        });
      }
      bundleValid = true;
    }
    let manifestValid = false;
    if (!isPlainObject(source.manifest)) {
      fail('/source/manifest', 'IR_SCHEMA_INVALID', "'source.manifest' must be an object", {
        pointer: '/source/manifest',
        rule: 'type',
      });
    } else {
      const manifest = source.manifest;
      checkUnknown(manifest, IR_SOURCE_MANIFEST_FIELDS, '/source/manifest');
      checkMemberOrder(manifest, IR_SOURCE_MANIFEST_FIELDS, '/source/manifest');
      if (typeof manifest.path !== 'string') {
        fail('/source/manifest/path', 'IR_SCHEMA_INVALID', 'manifest path must be a string', {
          pointer: '/source/manifest/path',
          rule: 'type',
        });
      }
      if (typeof manifest.sha256 !== 'string' || !SHA_RE.test(manifest.sha256)) {
        fail('/source/manifest/sha256', 'IR_SCHEMA_INVALID', 'manifest sha256 must be 64 lowercase hex', {
          pointer: '/source/manifest/sha256',
          rule: 'pattern',
        });
      }
      manifestValid = true;
    }
    sourceValid = bundleValid && manifestValid;

    if (bundleValid) {
      if (parsed.id !== source.bundle.id) {
        fail('/id', 'IR_SOURCE_MISMATCH', 'IR id differs from source.bundle.id', { field: 'id' });
      }
      if (parsed.version !== source.bundle.version) {
        fail('/version', 'IR_SOURCE_MISMATCH', 'IR version differs from source.bundle.version', { field: 'version' });
      }
      if (source.bundle.schema !== IR_BUNDLE_SCHEMA) {
        fail('/source/bundle/schema', 'IR_SOURCE_MISMATCH', 'source bundle schema must be hm2b.bundle/v1', {
          field: 'source.bundle.schema',
        });
      }
    }
    if (manifestValid && source.manifest.path !== 'bundle.json') {
      fail('/source/manifest/path', 'IR_SOURCE_MISMATCH', 'manifest path must be bundle.json', {
        field: 'source.manifest.path',
      });
    }
  }

  // requires
  if (parsed.requires !== undefined) {
    if (!isPlainObject(parsed.requires)) {
      fail('/requires', 'IR_SCHEMA_INVALID', "'requires' must be an object", { pointer: '/requires', rule: 'type' });
    } else {
      const requires = parsed.requires;
      checkUnknown(requires, IR_REQUIRES_FIELDS, '/requires');
      checkMemberOrder(requires, IR_REQUIRES_FIELDS, '/requires');
      if (Object.keys(requires).length === 0) {
        fail('/requires', 'IR_SCHEMA_INVALID', "'requires' must declare at least one key", {
          pointer: '/requires',
          rule: 'minProperties',
        });
      }
      if (requires.engine !== undefined) {
        if (typeof requires.engine !== 'string' || !isValidRange(requires.engine)) {
          fail('/requires/engine', 'IR_SCHEMA_INVALID', "'requires.engine' is not a supported range", {
            pointer: '/requires/engine',
            rule: 'range',
          });
        }
      }
      if (requires.projections !== undefined) {
        if (!Array.isArray(requires.projections) || requires.projections.length === 0) {
          fail('/requires/projections', 'IR_SCHEMA_INVALID', "'requires.projections' must be a non-empty array", {
            pointer: '/requires/projections',
            rule: 'type',
          });
        } else {
          const seen = new Set();
          requires.projections.forEach((item, index) => {
            const pointer = `/requires/projections/${index}`;
            if (typeof item !== 'string' || !['runner', 'agent-native'].includes(item) || seen.has(item)) {
              fail(pointer, 'IR_SCHEMA_INVALID', 'projection entry is invalid', { pointer, rule: 'enum' });
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
      fail(pointer, 'IR_SCHEMA_INVALID', 'source reference must be an object', { pointer, rule: 'type' });
      return;
    }
    checkUnknown(ref, IR_SOURCE_REF_FIELDS, pointer);
    checkMemberOrder(ref, IR_SOURCE_REF_FIELDS, pointer);
    if (typeof ref.path !== 'string' || !SOURCE_PATH_RE.test(ref.path)) {
      fail(`${pointer}/path`, 'IR_SCHEMA_INVALID', 'source path is not a contract path', {
        pointer: `${pointer}/path`,
        rule: 'pattern',
      });
    }
    if (typeof ref.sha256 !== 'string' || !SHA_RE.test(ref.sha256)) {
      fail(`${pointer}/sha256`, 'IR_SCHEMA_INVALID', 'source sha256 must be 64 lowercase hex', {
        pointer: `${pointer}/sha256`,
        rule: 'pattern',
      });
    }
  };

  if (!Array.isArray(parsed.stages)) {
    fail('/stages', 'IR_SCHEMA_INVALID', "'stages' must be an array", { pointer: '/stages', rule: 'type' });
  } else {
    if (parsed.stages.length === 0) {
      fail('/stages', 'IR_SCHEMA_INVALID', "'stages' must not be empty", { pointer: '/stages', rule: 'minItems' });
    }
    parsed.stages.forEach((stage, stageIndex) => {
      const pointer = `/stages/${stageIndex}`;
      if (!isPlainObject(stage)) {
        fail(pointer, 'IR_SCHEMA_INVALID', 'stage must be an object', { pointer, rule: 'type' });
        return;
      }
      checkUnknown(stage, IR_STAGE_FIELDS, pointer);
      checkMemberOrder(stage, IR_STAGE_FIELDS, pointer);
      for (const key of ['id', 'name', 'steps', 'source']) {
        if (stage[key] === undefined) {
          fail(`${pointer}/${key}`, 'IR_SCHEMA_INVALID', `stage is missing '${key}'`, {
            pointer: `${pointer}/${key}`,
            rule: 'required',
          });
        }
      }
      if (typeof stage.id !== 'string' || idProblem(stage.id)) {
        fail(`${pointer}/id`, 'IR_SCHEMA_INVALID', 'stage id is invalid', { pointer: `${pointer}/id`, rule: 'pattern' });
      } else if (stageIds.has(stage.id)) {
        fail(`${pointer}/id`, 'IR_STAGE_DUPLICATE', `duplicate stage id: ${stage.id}`, { first: stage.id });
      } else {
        stageIds.add(stage.id);
      }
      if (lengthProblem(stage.name, 1, 120) !== null) {
        fail(`${pointer}/name`, 'IR_SCHEMA_INVALID', 'stage name must be 1-120 characters', {
          pointer: `${pointer}/name`,
          rule: 'length',
        });
      }
      if (stage.description !== undefined && lengthProblem(stage.description, 1, 2000) !== null) {
        fail(`${pointer}/description`, 'IR_SCHEMA_INVALID', 'stage description must be 1-2000 characters', {
          pointer: `${pointer}/description`,
          rule: 'length',
        });
      }
      checkSourceRef(stage.source, `${pointer}/source`);
      if (typeof stage.id === 'string' && isPlainObject(stage.source)
        && typeof stage.source.path === 'string' && stage.source.path !== `stages/${stage.id}.json`) {
        fail(`${pointer}/source/path`, 'IR_SOURCE_PATH_MISMATCH', 'stage source path does not match the stage id', {
          kind: 'stage',
          id: stage.id,
          path: stage.source.path,
        });
      }
      if (!Array.isArray(stage.steps)) {
        fail(`${pointer}/steps`, 'IR_SCHEMA_INVALID', "'steps' must be an array", {
          pointer: `${pointer}/steps`,
          rule: 'type',
        });
        return;
      }
      if (stage.steps.length === 0) {
        fail(`${pointer}/steps`, 'IR_SCHEMA_INVALID', "'steps' must not be empty", {
          pointer: `${pointer}/steps`,
          rule: 'minItems',
        });
      }
      stage.steps.forEach((step, stepIndex) => {
        const stepPointer = `${pointer}/steps/${stepIndex}`;
        if (!isPlainObject(step)) {
          fail(stepPointer, 'IR_SCHEMA_INVALID', 'step must be an object', { pointer: stepPointer, rule: 'type' });
          return;
        }
        checkUnknown(step, IR_STEP_FIELDS, stepPointer);
        checkMemberOrder(step, IR_STEP_FIELDS, stepPointer);
        for (const key of ['id', 'name', 'task', 'skills', 'outputs', 'gates']) {
          if (step[key] === undefined) {
            fail(`${stepPointer}/${key}`, 'IR_SCHEMA_INVALID', `step is missing '${key}'`, {
              pointer: `${stepPointer}/${key}`,
              rule: 'required',
            });
          }
        }
        if (typeof step.id !== 'string' || idProblem(step.id)) {
          fail(`${stepPointer}/id`, 'IR_SCHEMA_INVALID', 'step id is invalid', {
            pointer: `${stepPointer}/id`,
            rule: 'pattern',
          });
        } else if (stepIds.has(step.id)) {
          fail(`${stepPointer}/id`, 'IR_STEP_DUPLICATE', `duplicate step id: ${step.id}`, { first: step.id });
        } else {
          stepIds.add(step.id);
        }
        if (lengthProblem(step.name, 1, 120) !== null) {
          fail(`${stepPointer}/name`, 'IR_SCHEMA_INVALID', 'step name must be 1-120 characters', {
            pointer: `${stepPointer}/name`,
            rule: 'length',
          });
        }
        if (step.role !== undefined && (typeof step.role !== 'string' || idProblem(step.role))) {
          fail(`${stepPointer}/role`, 'IR_SCHEMA_INVALID', 'step role must be a bare id', {
            pointer: `${stepPointer}/role`,
            rule: 'pattern',
          });
        }
        if (step.task !== undefined && (typeof step.task !== 'string' || idProblem(step.task))) {
          fail(`${stepPointer}/task`, 'IR_SCHEMA_INVALID', 'step task must be a bare id', {
            pointer: `${stepPointer}/task`,
            rule: 'pattern',
          });
        }
        if (Array.isArray(step.skills)) {
          step.skills.forEach((skill, index) => {
            if (typeof skill !== 'string' || idProblem(skill)) {
              fail(`${stepPointer}/skills/${index}`, 'IR_SCHEMA_INVALID', 'skill entry must be a bare id', {
                pointer: `${stepPointer}/skills/${index}`,
                rule: 'pattern',
              });
            }
          });
          checkAscending(step.skills.filter((skill) => typeof skill === 'string'), `${stepPointer}/skills`);
        } else if (step.skills !== undefined) {
          fail(`${stepPointer}/skills`, 'IR_SCHEMA_INVALID', "'skills' must be an array", {
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
      fields: IR_ROLE_FIELDS,
      reserved: ['main', 'sub'],
      checkValue: checkRole,
      pathFor: (id) => `roles/${id}.md`,
      mapPointer: '/roles',
    },
    {
      key: 'tasks',
      fields: IR_TASK_FIELDS,
      reserved: [],
      checkValue: checkTask,
      pathFor: (id) => `tasks/${id}.md`,
      mapPointer: '/tasks',
    },
    {
      key: 'skills',
      fields: IR_SKILL_FIELDS,
      reserved: ['synced', 'anthropic-skills'],
      checkValue: checkSkill,
      pathFor: (id) => `skills/${id}/SKILL.md`,
      mapPointer: '/skills',
    },
  ];

  for (const spec of mapChecks) {
    const map = parsed[spec.key];
    if (!isPlainObject(map)) {
      fail(`/${spec.key}`, 'IR_SCHEMA_INVALID', `'${spec.key}' must be an object`, {
        pointer: `/${spec.key}`,
        rule: 'type',
      });
      continue;
    }
    if (spec.key === 'tasks' && Object.keys(map).length === 0) {
      fail('/tasks', 'IR_SCHEMA_INVALID', "'tasks' must not be empty", { pointer: '/tasks', rule: 'minProperties' });
    }
    checkMapOrder(map, spec.mapPointer);
    for (const [id, value] of Object.entries(map)) {
      const pointer = `${spec.mapPointer}/${pointerSegment(id)}`;
      if (idProblem(id)) {
        fail(pointer, 'IR_SCHEMA_INVALID', `${spec.key} key is not a valid id`, { pointer, rule: 'pattern' });
        continue;
      }
      if (spec.reserved.includes(id)) {
        fail(pointer, 'IR_SCHEMA_INVALID', `${spec.key} key is reserved: ${id}`, { pointer, rule: 'reserved' });
      }
      if (!isPlainObject(value)) {
        fail(pointer, 'IR_SCHEMA_INVALID', `${spec.key} entry must be an object`, { pointer, rule: 'type' });
        continue;
      }
      checkUnknown(value, spec.fields, pointer);
      checkMemberOrder(value, spec.fields, pointer);
      spec.checkValue(value, pointer, fail, checkTextEncoding, checkAscending, checkSourceRef);
      if (isPlainObject(value.source) && typeof value.source.path === 'string'
        && value.source.path !== spec.pathFor(id)) {
        fail(`${pointer}/source/path`, 'IR_SOURCE_PATH_MISMATCH', `${spec.key} source path does not match the id`, {
          kind: spec.key,
          id,
          path: value.source.path,
        });
      }
    }
  }

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
          fail(`${pointer}/role`, 'IR_STEP_REF_UNDECLARED', `step references an undeclared role: ${step.role}`, {
            pointer: `${pointer}/role`,
            field: 'role',
            id: step.role,
          });
        }
        if (typeof step.task === 'string' && !Object.prototype.hasOwnProperty.call(tasks, step.task)) {
          fail(`${pointer}/task`, 'IR_STEP_REF_UNDECLARED', `step references an undeclared task: ${step.task}`, {
            pointer: `${pointer}/task`,
            field: 'task',
            id: step.task,
          });
        }
        if (Array.isArray(step.skills)) {
          step.skills.forEach((skill, skillIndex) => {
            if (typeof skill === 'string' && !Object.prototype.hasOwnProperty.call(skills, skill)) {
              fail(`${pointer}/skills/${skillIndex}`, 'IR_STEP_REF_UNDECLARED', `step references an undeclared skill: ${skill}`, {
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
    fail('/constitution', 'IR_SCHEMA_INVALID', "'constitution' must be an array", {
      pointer: '/constitution',
      rule: 'type',
    });
  } else {
    if (parsed.constitution.length > 1) {
      fail('/constitution', 'IR_CONSTITUTION_SCOPE', 'v1 allows at most one constitution mount', {
        reason: 'count',
      });
    }
    parsed.constitution.forEach((mount, index) => {
      const pointer = `/constitution/${index}`;
      if (!isPlainObject(mount)) {
        fail(pointer, 'IR_SCHEMA_INVALID', 'constitution mount must be an object', { pointer, rule: 'type' });
        return;
      }
      checkUnknown(mount, IR_CONSTITUTION_FIELDS, pointer);
      checkMemberOrder(mount, IR_CONSTITUTION_FIELDS, pointer);
      for (const key of ['scope', 'placeholder', 'body', 'source']) {
        if (mount[key] === undefined) {
          fail(`${pointer}/${key}`, 'IR_SCHEMA_INVALID', `constitution is missing '${key}'`, {
            pointer: `${pointer}/${key}`,
            rule: 'required',
          });
        }
      }
      if (mount.scope !== undefined && !['global', 'stage', 'step'].includes(mount.scope)) {
        fail(`${pointer}/scope`, 'IR_SCHEMA_INVALID', 'constitution scope is not a known value', {
          pointer: `${pointer}/scope`,
          rule: 'enum',
        });
      }
      if (mount.scope !== undefined && (mount.scope !== 'global' || mount.target !== undefined)) {
        fail(`${pointer}/scope`, 'IR_CONSTITUTION_SCOPE', 'v1 only supports a global constitution mount', {
          reason: mount.target !== undefined ? 'target' : 'scope',
        });
      }
      if (typeof mount.placeholder !== 'boolean') {
        fail(`${pointer}/placeholder`, 'IR_SCHEMA_INVALID', 'constitution placeholder must be a boolean', {
          pointer: `${pointer}/placeholder`,
          rule: 'type',
        });
      }
      if (mount.body !== undefined && typeof mount.body !== 'string') {
        fail(`${pointer}/body`, 'IR_SCHEMA_INVALID', 'constitution body must be a string', {
          pointer: `${pointer}/body`,
          rule: 'type',
        });
      }
      if (typeof mount.body === 'string') {
        checkTextEncoding(mount.body, `${pointer}/body`);
        if (/^---(\n|$)/.test(mount.body)) {
          fail(`${pointer}/body`, 'IR_CONSTITUTION_INVALID', 'constitution must not carry frontmatter', {
            rule: 'frontmatter',
          });
        }
        if (mount.placeholder === false && nonEmptyLines(mount.body).length === 0) {
          fail(`${pointer}/body`, 'IR_CONSTITUTION_INVALID', 'constitution is empty', { rule: 'empty' });
        }
        if (encoder.encode(mount.body).length > CONSTITUTION_MAX_BYTES) {
          fail(`${pointer}/body`, 'IR_CONSTITUTION_INVALID', 'constitution exceeds the size limit', {
            rule: 'too-large',
          });
        }
      }
      checkSourceRef(mount.source, `${pointer}/source`);
      if (isPlainObject(mount.source) && typeof mount.source.path === 'string'
        && mount.source.path !== 'constitution/CONSTITUTION.md') {
        fail(`${pointer}/source/path`, 'IR_SOURCE_PATH_MISMATCH', 'constitution path must be the fixed path', {
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
    if (complete) {
      rows.sort((left, right) => compareCodePoints(left[0], right[0]));
      const manifest = rows.map(([path, hash]) => `${path}\t${hash}\n`).join('');
      const expected = sha256(encoder.encode(manifest));
      if (expected !== parsed.source.bundle.contentSha256) {
        fail('/source/bundle/contentSha256', 'IR_HASH_MISMATCH', 'contentSha256 does not match the embedded assets', {
          expected,
          actual: parsed.source.bundle.contentSha256,
        });
      }
    }
  }

  return finalize();
}

function countIr(parsed) {
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
    fail(pointer, 'IR_SCHEMA_INVALID', "'outputs' must be an array", { pointer, rule: 'type' });
    return;
  }
  outputs.forEach((output, index) => {
    const at = `${pointer}/${index}`;
    if (typeof output !== 'string') {
      fail(at, 'IR_SCHEMA_INVALID', 'output must be a string', { pointer: at, rule: 'type' });
      return;
    }
    if (!isValidGlob(output)) {
      fail(at, 'IR_OUTPUT_INVALID_GLOB', 'output is not a valid glob', { pointer: at });
    }
    const reason = outputPathReason(output);
    if (reason !== null) {
      fail(at, 'IR_OUTPUT_PATH_INVALID', 'output path is invalid', { pointer: at, reason });
    }
    if (targetsSkill(output)) {
      fail(at, 'IR_OUTPUT_FORBIDDEN', 'output must not target the skill payload', { pointer: at });
    }
  });
}

function checkGates(gates, pointer, fail) {
  if (gates === undefined) return;
  if (!Array.isArray(gates)) {
    fail(pointer, 'IR_SCHEMA_INVALID', "'gates' must be an array", { pointer, rule: 'type' });
    return;
  }
  gates.forEach((gate, index) => {
    const base = `${pointer}/${index}`;
    if (!isPlainObject(gate)) {
      fail(base, 'IR_SCHEMA_INVALID', 'gate must be an object', { pointer: base, rule: 'type' });
      return;
    }
    for (const key of Object.keys(gate)) {
      if (!IR_GATE_FIELDS.includes(key)) {
        fail(`${base}/${pointerSegment(key)}`, 'IR_UNKNOWN_KEY', `unknown gate key: ${key}`, { key });
      }
    }
    const known = Object.keys(gate).filter((key) => IR_GATE_FIELDS.includes(key));
    const expected = IR_GATE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(gate, key));
    if (known.join('\u0000') !== expected.join('\u0000')) {
      fail(base, 'IR_ORDER_INVALID', 'gate members are not in schema order', { kind: 'member' });
    }
    if (typeof gate.command !== 'string' || gate.command.trim() === ''
      || codePointLength(gate.command) > 2000) {
      fail(`${base}/command`, 'IR_GATE_INVALID', 'gate command is invalid', {
        pointer: `${base}/command`,
        field: 'command',
      });
    }
    if (gate.timeout !== undefined && (typeof gate.timeout !== 'number' || !Number.isFinite(gate.timeout)
      || gate.timeout <= 0 || gate.timeout > 86400)) {
      fail(`${base}/timeout`, 'IR_GATE_INVALID', 'gate timeout is invalid', {
        pointer: `${base}/timeout`,
        field: 'timeout',
      });
    }
  });
}

function checkRole(value, pointer, fail, checkTextEncoding, checkAscending, checkSourceRef) {
  for (const key of ['description', 'placeholder', 'instructions', 'source']) {
    if (value[key] === undefined) {
      fail(`${pointer}/${key}`, 'IR_SCHEMA_INVALID', `role is missing '${key}'`, {
        pointer: `${pointer}/${key}`,
        rule: 'required',
      });
    }
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    fail(`${pointer}/description`, 'IR_SCHEMA_INVALID', 'role description must be a string', {
      pointer: `${pointer}/description`,
      rule: 'type',
    });
  } else if (value.description !== undefined) {
    const length = codePointLength(value.description);
    if (length < 1 || length > 1024) {
      fail(`${pointer}/description`, 'IR_ROLE_BODY_INVALID', 'role description must be 1-1024 characters', {
        rule: 'description',
      });
    }
  }
  if (value.title !== undefined && lengthProblem(value.title, 1, 120) !== null) {
    fail(`${pointer}/title`, 'IR_SCHEMA_INVALID', 'role title must be 1-120 characters', {
      pointer: `${pointer}/title`,
      rule: 'length',
    });
  }
  for (const key of ['mode', 'model', 'effort']) {
    if (value[key] !== undefined && !ROLE_ENUMS[key].includes(value[key])) {
      fail(`${pointer}/${key}`, 'IR_SCHEMA_INVALID', `role ${key} is not supported`, {
        pointer: `${pointer}/${key}`,
        rule: 'enum',
      });
    }
  }
  for (const key of ['tools', 'tools_deny', 'skills']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) {
      fail(`${pointer}/${key}`, 'IR_SCHEMA_INVALID', `role ${key} must be an array`, {
        pointer: `${pointer}/${key}`,
        rule: 'type',
      });
      continue;
    }
    value[key].forEach((item, index) => {
      if (typeof item !== 'string') {
        fail(`${pointer}/${key}/${index}`, 'IR_SCHEMA_INVALID', `role ${key} entry must be a string`, {
          pointer: `${pointer}/${key}/${index}`,
          rule: 'type',
        });
        return;
      }
      if (key === 'skills' ? idProblem(item) : !TOOLS.includes(item)) {
        fail(`${pointer}/${key}/${index}`, 'IR_SCHEMA_INVALID', `role ${key} entry is invalid: ${item}`, {
          pointer: `${pointer}/${key}/${index}`,
          rule: 'enum',
        });
      }
    });
    checkAscending(value[key].filter((item) => typeof item === 'string'), `${pointer}/${key}`);
  }
  if (value.placeholder !== undefined && typeof value.placeholder !== 'boolean') {
    fail(`${pointer}/placeholder`, 'IR_SCHEMA_INVALID', 'role placeholder must be a boolean', {
      pointer: `${pointer}/placeholder`,
      rule: 'type',
    });
  }
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== 'string') {
      fail(`${pointer}/instructions`, 'IR_SCHEMA_INVALID', 'role instructions must be a string', {
        pointer: `${pointer}/instructions`,
        rule: 'type',
      });
    } else {
      checkTextEncoding(value.instructions, `${pointer}/instructions`);
      if (value.placeholder === false && nonEmptyLines(value.instructions).length === 0) {
        fail(`${pointer}/instructions`, 'IR_ROLE_BODY_INVALID', 'non-placeholder role instructions are empty', {
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
      fail(`${pointer}/${key}`, 'IR_SCHEMA_INVALID', `task is missing '${key}'`, {
        pointer: `${pointer}/${key}`,
        rule: 'required',
      });
    }
  }
  if (value.title !== undefined && lengthProblem(value.title, 1, 120) !== null) {
    fail(`${pointer}/title`, 'IR_SCHEMA_INVALID', 'task title must be 1-120 characters', {
      pointer: `${pointer}/title`,
      rule: 'length',
    });
  }
  if (value.description !== undefined && lengthProblem(value.description, 1, 2000) !== null) {
    fail(`${pointer}/description`, 'IR_SCHEMA_INVALID', 'task description must be 1-2000 characters', {
      pointer: `${pointer}/description`,
      rule: 'length',
    });
  }
  if (value.body !== undefined) {
    if (typeof value.body !== 'string') {
      fail(`${pointer}/body`, 'IR_SCHEMA_INVALID', 'task body must be a string', {
        pointer: `${pointer}/body`,
        rule: 'type',
      });
    } else {
      checkTextEncoding(value.body, `${pointer}/body`);
      const scan = scanTaskBody(value.body);
      const first = scan.issues[0];
      if (first !== undefined) {
        fail(`${pointer}/body`, 'IR_TASK_BODY_INVALID', `task body structure is invalid: ${first.rule}`, {
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
      fail(`${pointer}/${key}`, 'IR_SCHEMA_INVALID', `skill is missing '${key}'`, {
        pointer: `${pointer}/${key}`,
        rule: 'required',
      });
    }
  }
  if (value.description !== undefined && lengthProblem(value.description, 1, 1024) !== null) {
    fail(`${pointer}/description`, 'IR_SCHEMA_INVALID', 'skill description must be 1-1024 characters', {
      pointer: `${pointer}/description`,
      rule: 'length',
    });
  }
  if (value.placeholder !== undefined && typeof value.placeholder !== 'boolean') {
    fail(`${pointer}/placeholder`, 'IR_SCHEMA_INVALID', 'skill placeholder must be a boolean', {
      pointer: `${pointer}/placeholder`,
      rule: 'type',
    });
  }
  if (value.body !== undefined) {
    if (typeof value.body !== 'string') {
      fail(`${pointer}/body`, 'IR_SCHEMA_INVALID', 'skill body must be a string', {
        pointer: `${pointer}/body`,
        rule: 'type',
      });
    } else {
      checkTextEncoding(value.body, `${pointer}/body`);
      if (value.placeholder === true) {
        if (!PLACEHOLDER_BANNER.test(preamble(value.body))) {
          fail(`${pointer}/body`, 'IR_SKILL_BODY_INVALID', 'placeholder skill is missing the visible banner', {
            rule: 'placeholder-banner',
          });
        }
      } else if (nonEmptyLines(value.body).length === 0) {
        fail(`${pointer}/body`, 'IR_SKILL_BODY_INVALID', 'skill body is empty', { rule: 'body-empty' });
      }
    }
  }
  checkSourceRef(value.source, `${pointer}/source`);
}

