/**
 * One `renderRole(role, targetId, ctx)` for every projection (#72 §4).
 *
 * The driver owns identity, naming, field-state accounting, placeholder
 * instructions, exposure and text hygiene. Closed target descriptors own only
 * the target's byte shell and its capability matrix, so a new runtime is a
 * descriptor file — the driver never grows a per-target template.
 *
 * `ctx = { namespace, skillNames, targets, roleModels?, roleEfforts?, trailer? }`
 * is required: `targets` is the projection-owned descriptor map (target id ->
 * descriptor) and `skillNames` maps IR skill ids to runtime-visible names.
 */
import { placeholderInstructions } from './placeholder.js';
import { TARGETS as DEFAULT_TARGETS } from '../agent-native/projection/targets/index.js';

const ROLE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ROLE_NAME = 64;
const LEVELS = new Set(['native', 'adapted', 'degraded', 'unavailable']);

export const ROLE_ID_PATTERN = ROLE_ID_RE;

/** Field order used by renderRole().fields and by `roles.json` sections. */
export const ROLE_FIELD_ORDER = Object.freeze([
  'id',
  'description',
  'instructions',
  'mode',
  'model',
  'effort',
  'tools',
  'tools_deny',
  'skills',
  'title',
  'placeholder',
]);

const SETTABLE_FIELDS = Object.freeze([
  'description',
  'title',
  'mode',
  'model',
  'effort',
  'tools',
  'tools_deny',
  'skills',
  'placeholder',
  'instructions',
]);

function projectionError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function descriptorFor(ctx, targetId) {
  if (ctx === null || typeof ctx !== 'object') {
    throw projectionError('PROJECTION_INTERNAL', 'renderRole needs a context object');
  }
  if (typeof ctx.namespace !== 'string' || ctx.namespace === '') {
    throw projectionError('PROJECTION_INTERNAL', 'ctx.namespace is required');
  }
  if (ctx.skillNames === undefined || ctx.skillNames === null) {
    throw projectionError('PROJECTION_INTERNAL', 'ctx.skillNames is required');
  }
  const table = ctx.targets ?? DEFAULT_TARGETS;
  const descriptor = table instanceof Map ? table.get(targetId) : table?.[targetId];
  if (descriptor === undefined || descriptor === null) {
    throw projectionError('PROJECTION_TARGET_UNKNOWN', `no descriptor for target ${String(targetId)}`, { target: targetId });
  }
  if (descriptor.role === undefined) {
    throw projectionError('PROJECTION_INTERNAL', `descriptor ${targetId} has no role section`);
  }
  return descriptor;
}

export function skillNameOf(skillNames, skillId) {
  if (skillNames instanceof Map) return skillNames.get(skillId);
  if (typeof skillNames === 'object' && skillNames !== null) return skillNames[skillId];
  return undefined;
}

/** Deterministic tool view shared by every descriptor. */
export function effectiveTools(role) {
  const allow = role.tools === undefined ? null : new Set(role.tools);
  const deny = new Set(role.tools_deny ?? []);
  let effective = null;
  if (allow !== null) effective = new Set([...allow].filter((token) => !deny.has(token)));
  return { allow, deny, effective };
}

function baseState(field) {
  if (field === 'placeholder') {
    return { state: 'adapted', reason: '标记随产物保留；true 时正文替换为固定占位块' };
  }
  return { state: 'native' };
}

function assertState(field, state) {
  if (state === null || typeof state !== 'object' || !LEVELS.has(state.state)) {
    throw projectionError('PROJECTION_INTERNAL', `invalid state for role field ${field}`);
  }
  if (state.state === 'degraded' || state.state === 'unavailable') {
    if (typeof state.reason !== 'string' || state.reason === '') {
      throw projectionError('PROJECTION_INTERNAL', `field ${field} is ${state.state} without a reason`);
    }
    if (typeof state.effect !== 'string' || state.effect === '') {
      throw projectionError('PROJECTION_INTERNAL', `field ${field} is ${state.state} without an effect`);
    }
  }
}

/** Ensure final UTF-8-ready text: no CR/BOM, exactly one trailing LF. */
export function ensureText(content, path = 'content') {
  if (typeof content !== 'string') {
    throw projectionError('PROJECTION_INTERNAL', `${path} is not a string`);
  }
  if (content.includes('\r')) throw projectionError('PROJECTION_INTERNAL', `${path} contains CR`);
  if (content.startsWith('\uFEFF')) throw projectionError('PROJECTION_INTERNAL', `${path} starts with a BOM`);
  return content.endsWith('\n') ? content : `${content}\n`;
}

export function ensureTrailingLf(text) {
  return typeof text === 'string' && text.endsWith('\n') ? text : `${text}\n`;
}

export function yamlScalar(value) {
  const text = String(value);
  const safe = text !== ''
    && !/[\n\r\t]/.test(text)
    && !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text)
    && !/: /.test(text)
    && !/ #/.test(text)
    && !/:\s*$/.test(text);
  return safe ? text : JSON.stringify(text);
}

export function mdDocument(frontmatterLines, instructions) {
  return `---\n${frontmatterLines.join('\n')}\n---\n${ensureTrailingLf(instructions)}`;
}

export function tomlString(value) {
  return JSON.stringify(String(value));
}

export function tomlMultiline(instructions) {
  const body = instructions.startsWith('\n') ? instructions : `\n${instructions}`;
  const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const tail = escaped.endsWith('\n') ? '' : '\n';
  return `"""${escaped}${tail}"""`;
}

/**
 * Render one IR role for one target.
 *
 * Returns `{name, basename, format, content, exposure, fields}` where
 * `content === null` only when the descriptor refuses to expose the role
 * (`exposure: "skipped"`). `fields` always covers exactly the role fields the
 * IR actually set, plus `id`.
 */
export function renderRole(role, targetId, ctx) {
  if (role === null || typeof role !== 'object') {
    throw projectionError('PROJECTION_INTERNAL', 'renderRole needs a role object');
  }
  if (typeof role.id !== 'string' || role.id === '') {
    throw projectionError('PROJECTION_INTERNAL', 'renderRole needs role.id');
  }
  const descriptor = descriptorFor(ctx, targetId);
  const name = `${ctx.namespace}-${role.id}`;
  if (!ROLE_ID_RE.test(name) || [...name].length > MAX_ROLE_NAME) {
    throw projectionError('PROJECTION_NAME_TOO_LONG', `rendered role name ${name} is not a kebab id of at most 64 characters`, {
      target: targetId,
      pointer: `/roles/${role.id}`,
    });
  }

  const tools = effectiveTools(role);
  const fields = new Map();
  fields.set('id', descriptor.role.identity);
  for (const field of SETTABLE_FIELDS) {
    if (Object.hasOwn(role, field)) fields.set(field, baseState(field));
  }
  const overrides = descriptor.role.fieldStates?.(role, tools, ctx) ?? {};
  for (const [field, state] of Object.entries(overrides)) {
    if (field === 'id') {
      fields.set('id', state);
      continue;
    }
    if (!Object.hasOwn(role, field)) continue;
    fields.set(field, state);
  }
  for (const [field, state] of fields) assertState(field, state);

  const mode = role.mode ?? 'subagent';
  const exposure = descriptor.role.exposure({ role, mode });
  let instructions = role.placeholder === true
    ? `\n${placeholderInstructions(role)}`
    : String(role.instructions ?? '');
  if (typeof ctx.trailer === 'string' && ctx.trailer !== '') {
    instructions = `${ensureTrailingLf(instructions)}${ensureTrailingLf(ctx.trailer)}`;
  }

  const rendered = descriptor.role.render({
    role,
    name,
    instructions,
    tools,
    skillNames: ctx.skillNames,
    ctx,
    fields,
    exposure,
    helpers: {
      yamlScalar,
      mdDocument,
      tomlString,
      tomlMultiline,
      ensureText,
      ensureTrailingLf,
      skillNameOf,
    },
  });

  let content = null;
  if (rendered !== null && rendered !== undefined) content = ensureText(rendered, name);
  if (exposure === 'skipped' && content !== null) {
    throw projectionError('PROJECTION_INTERNAL', `role ${role.id} is skipped but produced content`);
  }
  if (exposure !== 'skipped' && content === null) {
    throw projectionError('PROJECTION_INTERNAL', `role ${role.id} is exposed but produced no content`);
  }

  const ordered = {};
  for (const field of ROLE_FIELD_ORDER) {
    if (fields.has(field)) ordered[field] = fields.get(field);
  }
  return {
    name,
    basename: descriptor.role.basename(name),
    format: descriptor.role.format,
    content,
    exposure,
    fields: ordered,
  };
}
