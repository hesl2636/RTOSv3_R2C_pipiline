/**
 * Frozen schema revision table (spec §8).
 *
 * Schema revisions are orthogonal to the package version: a new revision bumps
 * the minor number, and a runner only accepts the revisions it was built for.
 * The documented shapes live beside this file in `runtime/runner/schema/`; this
 * table is the runtime allow-list used to reject state written by a newer
 * engine. The id helpers are shared with the framework in `core/schema.js`;
 * the accepted table stays engine-owned so the engine cannot learn upstream
 * bundle/IR revisions.
 */
import {
  isNewerSchema as isNewerSchemaIn,
  isSupportedSchema as isSupportedSchemaIn,
  parseSchemaId,
} from '../../../../core/schema.js';

export const SUPPORTED = Object.freeze({
  workflow: Object.freeze(['hm2b.workflow/v1']),
  state: Object.freeze(['hm2b.state/v1']),
  latest: Object.freeze(['hm2b.latest/v1']),
  usage: Object.freeze(['hm2b.usage/v1']),
});

export { parseSchemaId };

/** True when `id` is one of the accepted revisions of `family`. */
export function isSupportedSchema(family, id) {
  return isSupportedSchemaIn(SUPPORTED, family, id);
}

/** True when `id` names `family` with a revision above every supported one. */
export function isNewerSchema(family, id) {
  return isNewerSchemaIn(SUPPORTED, family, id);
}
