/**
 * Canonical IR serialization and digest.
 *
 * `serializeIr` re-emits top-level members in schema writing order, so a caller
 * cannot accidentally change bytes by building the object in another order.
 * Map members (`roles`, `tasks`, `skills`) are ordered by code point
 * explicitly: `JSON.stringify` enumerates integer-like keys in numeric order,
 * which would make ids `9`/`10` depend on the JavaScript engine rather than on
 * the contract. Hashing is injected (Node `crypto` / browser
 * `crypto.subtle`) exactly like `validateIr`, keeping this module free of Node
 * builtins.
 */
import { compareCodePoints } from '../core/code-point.js';
import {
  IR_CHECKLIST_FIELDS,
  IR_CONSTITUTION_FIELDS,
  IR_FIELDS,
  IR_GATE_FIELDS,
  IR_HOOKS_FIELDS,
  IR_KNOWLEDGE_BASE_FIELDS,
  IR_MCP_FIELDS,
  IR_REQUIRES_FIELDS,
  IR_ROLE_FIELDS,
  IR_SKILL_FIELDS,
  IR_SOURCE_BUNDLE_FIELDS,
  IR_SOURCE_FIELDS,
  IR_SOURCE_MANIFEST_FIELDS,
  IR_SOURCE_REF_FIELDS,
  IR_STAGE_FIELDS,
  IR_STEP_FIELDS,
  IR_TASK_FIELDS,
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

const SOURCE_REF = objectShape(IR_SOURCE_REF_FIELDS);
const ASSET_RECORD = (fields) => objectShape(fields, { source: SOURCE_REF });

const IR_SHAPE = objectShape(IR_FIELDS, {
  source: objectShape(IR_SOURCE_FIELDS, {
    bundle: objectShape(IR_SOURCE_BUNDLE_FIELDS),
    manifest: objectShape(IR_SOURCE_MANIFEST_FIELDS),
  }),
  requires: objectShape(IR_REQUIRES_FIELDS),
  stages: listShape(objectShape(IR_STAGE_FIELDS, {
    steps: listShape(objectShape(IR_STEP_FIELDS, {
      gates: listShape(objectShape(IR_GATE_FIELDS)),
    })),
    source: SOURCE_REF,
  })),
  roles: mapShape(objectShape(IR_ROLE_FIELDS, { source: SOURCE_REF })),
  tasks: mapShape(objectShape(IR_TASK_FIELDS, { source: SOURCE_REF })),
  skills: mapShape(objectShape(IR_SKILL_FIELDS, { source: SOURCE_REF })),
  knowledgeBase: listShape(ASSET_RECORD(IR_KNOWLEDGE_BASE_FIELDS)),
  checklists: listShape(ASSET_RECORD(IR_CHECKLIST_FIELDS)),
  hooks: ASSET_RECORD(IR_HOOKS_FIELDS),
  mcp: ASSET_RECORD(IR_MCP_FIELDS),
  constitution: listShape(ASSET_RECORD(IR_CONSTITUTION_FIELDS)),
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
 * object members from the IR schema. Unknown members keep their own order so
 * the validator reports `IR_UNKNOWN_KEY` instead of a misleading canonical
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

  // JSON has no representation for these values; the IR validator rejects
  // them long before serialization becomes the source of truth.
  return 'null';
}

/** Canonical IR bytes as a string (UTF-8, LF, no BOM). */
export function serializeIr(ir) {
  return `${emit(ir, IR_SHAPE, 0)}\n`;
}

/**
 * SHA-256 of the serialized IR. Pass the host primitive as a function or as
 * `{ sha256 }`; the hash is never reimplemented here.
 */
export function digestOfIr(bytes, primitives) {
  const sha256 = typeof primitives === 'function' ? primitives : primitives?.sha256;
  if (typeof sha256 !== 'function') {
    throw new TypeError('digestOfIr requires a sha256 function or { sha256 } primitives');
  }
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  return sha256(data);
}
