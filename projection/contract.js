/**
 * The projection capability vocabulary, shared by every producer and the
 * validator (#69 §6.1/§12.2, #82 §2).
 *
 * One definition feeds the agent-native and r2c projections (which emit
 * `capabilityReport` rows in this order) and `validate-result.js` (which
 * checks them). A new capability is added here and nowhere else.
 */

/** Fixed capability order of every `capabilityReport`. */
export const CAPABILITIES = Object.freeze([
  'state',
  'gates',
  'outputs',
  'subagents',
  'skills',
  'preload',
  'stage-invocation',
  'skill-invocation',
]);

/** Capabilities whose loss must be visible in `degradations`. */
export const SEMANTIC_CAPABILITIES = Object.freeze([
  'state',
  'gates',
  'outputs',
  'subagents',
  'skills',
  'preload',
]);

/** Aggregate level order: a higher rank is a worse delivery. */
export const LEVEL_RANK = Object.freeze({ native: 0, adapted: 1, degraded: 2, unavailable: 3 });

/** Kebab-case id used for bundles, targets, roles, skills and artifacts. */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
