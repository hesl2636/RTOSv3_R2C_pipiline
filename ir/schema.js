/**
 * Neutral IR contract (`hm2b.ir/v2`): names, fixed filename, field order and
 * the collection path. Field shapes live in `decisions/66.md`; this module is
 * the single source for the byte-level contract.
 */
export const IR_SCHEMA = 'hm2b.ir/v2';
export const IR_FILENAME = 'workflow.ir.json';
export const IR_BUNDLE_SCHEMA = 'hm2b.bundle/v2';

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
  'knowledgeBase',
  'checklists',
  'hooks',
  'mcp',
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
export const IR_KNOWLEDGE_BASE_FIELDS = Object.freeze(['path', 'body', 'source']);
export const IR_CHECKLIST_FIELDS = Object.freeze(['id', 'body', 'source']);
export const IR_HOOKS_FIELDS = Object.freeze(['path', 'body', 'source']);
export const IR_MCP_FIELDS = Object.freeze(['path', 'body', 'source']);
export const IR_CONSTITUTION_FIELDS = Object.freeze([
  'scope',
  'target',
  'placeholder',
  'body',
  'source',
]);

/**
 * Fixed asset locations, shared by the bundle contract and the IR contract so
 * the two revisions cannot drift.
 */
export const IR_HOOKS_PATH = 'hooks/hooks.json';
export const IR_MCP_PATH = 'mcp.json';
export const IR_KNOWLEDGE_BASE_ROOT = 'knowledge-base';
export const IR_CHECKLIST_ROOT = 'checklists';

/** Checklist `<id>` lives at `checklists/<id>.md`. */
export function irChecklistPath(id) {
  return `${IR_CHECKLIST_ROOT}/${id}.md`;
}

/** `<bundle-id>/<version>/workflow.ir.json` (pure POSIX virtual path). */
export function irCollectionPath(id, version) {
  return `${id}/${version}/${IR_FILENAME}`;
}
