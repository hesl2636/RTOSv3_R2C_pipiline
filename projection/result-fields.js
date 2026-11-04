/**
 * The projection-result top-level member order (#69 §12.2, V12).
 *
 * `validate-result.js` enforces it and `installer/release-payload.js` rebuilds
 * a result from a payload manifest in it; both import this one list so the
 * installer can never assemble an object the validator rejects.
 */

export const RESULT_FIELDS = Object.freeze([
  'schema',
  'ok',
  'projection',
  'compiledWorkflow',
  'options',
  'environment',
  'targets',
  'coverage',
  'files',
  'installPlan',
  'capabilityReport',
  'degradations',
  'warnings',
  'metadata',
]);

/** Result members a payload manifest records verbatim (everything but files). */
export const RESULT_BLOCK_FIELDS = Object.freeze(RESULT_FIELDS.filter((field) => field !== 'files'));
