/**
 * Neutral IR contract (`hm2b.ir/v1`): names, fixed filename, field order and
 * the collection path. Field shapes live in `decisions/66.md`; this module is
 * the single source for the byte-level contract.
 */
export const IR_SCHEMA = 'hm2b.ir/v1';
export const IR_FILENAME = 'workflow.ir.json';
export const IR_BUNDLE_SCHEMA = 'hm2b.bundle/v1';

/** Top-level members in canonical writing order (`requires` is optional). */
export const IR_FIELDS = Object.freeze([
  'schema',
  'id',
  'name',
  'version',
  'description',
  'source',
  'requires',
  'stages',
  'roles',
  'tasks',
  'skills',
  'constitution',
]);

export const IR_SOURCE_FIELDS = Object.freeze(['bundle', 'manifest']);
export const IR_SOURCE_BUNDLE_FIELDS = Object.freeze(['schema', 'id', 'version', 'contentSha256']);
export const IR_SOURCE_MANIFEST_FIELDS = Object.freeze(['path', 'sha256']);
export const IR_SOURCE_REF_FIELDS = Object.freeze(['path', 'sha256']);
export const IR_REQUIRES_FIELDS = Object.freeze(['engine', 'projections']);
export const IR_STAGE_FIELDS = Object.freeze(['id', 'name', 'description', 'steps', 'source']);
export const IR_STEP_FIELDS = Object.freeze(['id', 'name', 'role', 'task', 'skills', 'outputs', 'gates']);
export const IR_GATE_FIELDS = Object.freeze(['command', 'timeout']);
export const IR_ROLE_FIELDS = Object.freeze([
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
  'source',
]);
export const IR_TASK_FIELDS = Object.freeze(['title', 'description', 'body', 'source']);
export const IR_SKILL_FIELDS = Object.freeze(['description', 'placeholder', 'body', 'source']);
export const IR_CONSTITUTION_FIELDS = Object.freeze([
  'scope',
  'target',
  'placeholder',
  'body',
  'source',
]);

/** `<bundle-id>/<version>/workflow.ir.json` (pure POSIX virtual path). */
export function irCollectionPath(id, version) {
  return `${id}/${version}/${IR_FILENAME}`;
}
