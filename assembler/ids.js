/** Bundle id/step/tool vocabularies (decision #65 §6/§9.1). */
export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BUNDLE_ID_RE = ID_RE;
export const ID_MAX = 64;
export const BUNDLE_ID_MAX = 40;
export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export const ROLE_RESERVED = Object.freeze(['main', 'sub']);
export const SKILL_RESERVED = Object.freeze(['synced', 'anthropic-skills']);
export const TOOL_TOKENS = Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'web']);

export const ROLE_ENUMS = Object.freeze({
  mode: Object.freeze(['subagent', 'primary', 'any']),
  model: Object.freeze(['fast', 'standard', 'strong']),
  effort: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});

export const PROJECTION_IDS = Object.freeze(['runner', 'agent-native']);

/** True when `id` matches the id grammar and the 1..`max` length window. */
export function isValidId(id, max = ID_MAX) {
  return typeof id === 'string' && ID_RE.test(id) && id.length <= max;
}
