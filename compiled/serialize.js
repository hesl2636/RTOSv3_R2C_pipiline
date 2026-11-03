/**
 * Canonical compiled workflow serialization and digest.
 *
 * `serializeCompiledWorkflow` re-emits top-level members in schema writing order, so a caller
 * cannot accidentally change bytes by building the object in another order.
 * Map members (`roles`, `tasks`, `skills`) are ordered by code point
 * explicitly: `JSON.stringify` enumerates integer-like keys in numeric order,
 * which would make ids `9`/`10` depend on the JavaScript engine rather than on
 * the contract. Hashing is injected (Node `crypto` / browser
 * `crypto.subtle`) exactly like `validateCompiledWorkflow`, keeping this module free of Node
 * builtins.
 */
import { compareCodePoints } from '../core/code-point.js';
import {
  COMPILED_WORKFLOW_CHECKLIST_FIELDS,
  COMPILED_WORKFLOW_CONSTITUTION_FIELDS,
  COMPILED_WORKFLOW_FIELDS,
  COMPILED_WORKFLOW_GATE_FIELDS,
  COMPILED_WORKFLOW_HOOKS_FIELDS,
  COMPILED_WORKFLOW_KNOWLEDGE_BASE_FIELDS,
  COMPILED_WORKFLOW_MCP_FIELDS,
  COMPILED_WORKFLOW_REQUIRES_FIELDS,
  COMPILED_WORKFLOW_ROLE_FIELDS,
  COMPILED_WORKFLOW_SKILL_FIELDS,
  COMPILED_WORKFLOW_SOURCE_BUNDLE_FIELDS,
  COMPILED_WORKFLOW_SOURCE_FIELDS,
  COMPILED_WORKFLOW_SOURCE_MANIFEST_FIELDS,
  COMPILED_WORKFLOW_SOURCE_REF_FIELDS,
  COMPILED_WORKFLOW_STAGE_FIELDS,
  COMPILED_WORKFLOW_STEP_FIELDS,
  COMPILED_WORKFLOW_TASK_FIELDS,
} from './schema.js';

const encoder = new TextEncoder();

function objectShape(fields, children = {}) {
  return { kind: 'object', fields, children };
}

function mapShape(value) {
  return { kind: 'map', value };
}

function listShape(item) {
  return { kind: 'list', item };
}

const SOURCE_REF = objectShape(COMPILED_WORKFLOW_SOURCE_REF_FIELDS);
const ASSET_RECORD = (fields) => objectShape(fields, { source: SOURCE_REF });

const COMPILED_WORKFLOW_SHAPE = objectShape(COMPILED_WORKFLOW_FIELDS, {
  source: objectShape(COMPILED_WORKFLOW_SOURCE_FIELDS, {
    bundle: objectShape(COMPILED_WORKFLOW_SOURCE_BUNDLE_FIELDS),
    manifest: objectShape(COMPILED_WORKFLOW_SOURCE_MANIFEST_FIELDS),
  }),
  requires: objectShape(COMPILED_WORKFLOW_REQUIRES_FIELDS),
  stages: listShape(objectShape(COMPILED_WORKFLOW_STAGE_FIELDS, {
    steps: listShape(objectShape(COMPILED_WORKFLOW_STEP_FIELDS, {
      gates: listShape(objectShape(COMPILED_WORKFLOW_GATE_FIELDS)),
    })),
    source: SOURCE_REF,
  })),
  roles: mapShape(objectShape(COMPILED_WORKFLOW_ROLE_FIELDS, { source: SOURCE_REF })),
  tasks: mapShape(objectShape(COMPILED_WORKFLOW_TASK_FIELDS, { source: SOURCE_REF })),
  skills: mapShape(objectShape(COMPILED_WORKFLOW_SKILL_FIELDS, { source: SOURCE_REF })),
  knowledgeBase: listShape(ASSET_RECORD(COMPILED_WORKFLOW_KNOWLEDGE_BASE_FIELDS)),
  checklists: listShape(ASSET_RECORD(COMPILED_WORKFLOW_CHECKLIST_FIELDS)),
  hooks: ASSET_RECORD(COMPILED_WORKFLOW_HOOKS_FIELDS),
  mcp: ASSET_RECORD(COMPILED_WORKFLOW_MCP_FIELDS),
  constitution: listShape(ASSET_RECORD(COMPILED_WORKFLOW_CONSTITUTION_FIELDS)),
});

function escape(value) {
  return JSON.stringify(value);
}

function scalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return escape(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  return null;
}

function keysFor(value, shape) {
  if (shape?.kind === 'map') return Object.keys(value).sort(compareCodePoints);
  if (shape?.kind !== 'object') return Object.keys(value);
  const keys = shape.fields.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  const known = new Set(shape.fields);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) keys.push(key);
  }
  return keys;
}

function childShape(shape, key) {
  if (shape?.kind === 'map') return shape.value;
  if (shape?.kind === 'object') return shape.children?.[key];
  return null;
}

/**
 * Emit `value` in `JSON.stringify(value, null, 2)` byte form while ordering
 * object members from the compiled workflow schema. Unknown members keep their own order so
 * the validator reports `COMPILED_WORKFLOW_UNKNOWN_KEY` instead of a misleading canonical
 * mismatch.
 */
function emit(value, shape, indent) {
  const primitive = scalar(value);
  if (primitive !== null) return primitive;

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const pad = ' '.repeat(indent + 2);
    const itemShape = shape?.kind === 'list' ? shape.item : null;
    const items = value.map((item) => `${pad}${emit(item, itemShape, indent + 2)}`);
    return `[\n${items.join(',\n')}\n${' '.repeat(indent)}]`;
  }

  if (typeof value === 'object') {
    const keys = keysFor(value, shape);
    if (keys.length === 0) return '{}';
    const pad = ' '.repeat(indent + 2);
    const members = keys.map((key) => (
      `${pad}${escape(key)}: ${emit(value[key], childShape(shape, key), indent + 2)}`
    ));
    return `{\n${members.join(',\n')}\n${' '.repeat(indent)}}`;
  }

  // JSON has no representation for these values; the compiled workflow validator rejects
  // them long before serialization becomes the source of truth.
  return 'null';
}

/** Canonical compiled workflow bytes as a string (UTF-8, LF, no BOM). */
export function serializeCompiledWorkflow(compiledWorkflow) {
  return `${emit(compiledWorkflow, COMPILED_WORKFLOW_SHAPE, 0)}\n`;
}

/**
 * SHA-256 of the serialized compiled workflow. Pass the host primitive as a function or as
 * `{ sha256 }`; the hash is never reimplemented here.
 */
export function digestOfCompiledWorkflow(bytes, primitives) {
  const sha256 = typeof primitives === 'function' ? primitives : primitives?.sha256;
  if (typeof sha256 !== 'function') {
    throw new TypeError('digestOfCompiledWorkflow requires a sha256 function or { sha256 } primitives');
  }
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  return sha256(data);
}
