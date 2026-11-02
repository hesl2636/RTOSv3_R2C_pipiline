/**
 * Frozen schema revision table (spec §8).
 *
 * Schema revisions are orthogonal to the package version: a new revision bumps
 * the minor number, and a runner only accepts the revisions it was built for.
 * The documented shapes live beside this file in `runtime/r2c/schema/`; this
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
  workflow: Object.freeze(['r2c.workflow/v1']),
  state: Object.freeze(['r2c.state/v1']),
  latest: Object.freeze(['r2c.latest/v1']),
  usage: Object.freeze(['r2c.usage/v1']),
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
