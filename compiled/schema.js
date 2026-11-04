/**
 * Neutral compiled workflow contract (`hm2b.compiled-workflow/v2`): names, fixed filename, field order and
 * the collection path. Field shapes live in `decisions/66.md`; this module is
 * the single source for the byte-level contract.
 */
export const COMPILED_WORKFLOW_SCHEMA = 'hm2b.compiled-workflow/v2';
export const COMPILED_WORKFLOW_FILENAME = 'workflow.compiled.json';
export const COMPILED_WORKFLOW_BUNDLE_SCHEMA = 'hm2b.bundle/v2';

/** Top-level members in canonical writing order (`requires` is optional). */
export const COMPILED_WORKFLOW_FIELDS = Object.freeze([
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

export const COMPILED_WORKFLOW_SOURCE_FIELDS = Object.freeze(['bundle', 'manifest']);
export const COMPILED_WORKFLOW_SOURCE_BUNDLE_FIELDS = Object.freeze(['schema', 'id', 'version', 'contentSha256']);
export const COMPILED_WORKFLOW_SOURCE_MANIFEST_FIELDS = Object.freeze(['path', 'sha256']);
export const COMPILED_WORKFLOW_SOURCE_REF_FIELDS = Object.freeze(['path', 'sha256']);
export const COMPILED_WORKFLOW_REQUIRES_FIELDS = Object.freeze(['engine', 'projections']);
export const COMPILED_WORKFLOW_STAGE_FIELDS = Object.freeze(['id', 'name', 'description', 'steps', 'source']);
export const COMPILED_WORKFLOW_STEP_FIELDS = Object.freeze(['id', 'name', 'role', 'task', 'skills', 'outputs', 'gates']);
export const COMPILED_WORKFLOW_GATE_FIELDS = Object.freeze(['command', 'timeout']);
export const COMPILED_WORKFLOW_ROLE_FIELDS = Object.freeze([
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
export const COMPILED_WORKFLOW_TASK_FIELDS = Object.freeze(['title', 'description', 'body', 'source']);
export const COMPILED_WORKFLOW_SKILL_FIELDS = Object.freeze(['description', 'placeholder', 'body', 'source']);
export const COMPILED_WORKFLOW_KNOWLEDGE_BASE_FIELDS = Object.freeze(['path', 'body', 'source']);
export const COMPILED_WORKFLOW_CHECKLIST_FIELDS = Object.freeze(['id', 'body', 'source']);
export const COMPILED_WORKFLOW_HOOKS_FIELDS = Object.freeze(['path', 'body', 'source']);
export const COMPILED_WORKFLOW_MCP_FIELDS = Object.freeze(['path', 'body', 'source']);
export const COMPILED_WORKFLOW_CONSTITUTION_FIELDS = Object.freeze([
  'scope',
  'target',
  'placeholder',
  'body',
  'source',
]);

/**
 * Fixed asset locations, shared by the bundle contract and the compiled workflow contract so
 * the two revisions cannot drift.
 */
export const COMPILED_WORKFLOW_HOOKS_PATH = 'hooks/hooks.json';
export const COMPILED_WORKFLOW_MCP_PATH = 'mcp.json';
export const COMPILED_WORKFLOW_KNOWLEDGE_BASE_ROOT = 'knowledge-base';
export const COMPILED_WORKFLOW_CHECKLIST_ROOT = 'checklists';

/** Checklist `<id>` lives at `checklists/<id>.md`. */
export function compiledWorkflowChecklistPath(id) {
  return `${COMPILED_WORKFLOW_CHECKLIST_ROOT}/${id}.md`;
}

/** `<bundle-id>/<version>/workflow.compiled.json` (pure POSIX virtual path). */
export function compiledWorkflowCollectionPath(id, version) {
  return `${id}/${version}/${COMPILED_WORKFLOW_FILENAME}`;
}
