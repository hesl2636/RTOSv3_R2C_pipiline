/**
 * Frozen schema revision table (spec §8).
 *
 * Schema revisions are orthogonal to the package version: a new revision bumps
 * the minor number, and a runner only accepts the revisions it was built for.
 * The documented shapes live in `schema/*.schema.json`; this table is the
 * runtime allow-list used to reject state written by a newer engine.
 */
export const SUPPORTED = Object.freeze({
  workflow: Object.freeze(['r2c.workflow/v1']),
  state: Object.freeze(['r2c.state/v1']),
  latest: Object.freeze(['r2c.latest/v1']),
  usage: Object.freeze(['r2c.usage/v1']),
  adapter: Object.freeze(['r2c.adapter/v1']),
  'adapter-map': Object.freeze(['r2c.adapter-map/v1']),
  plugin: Object.freeze(['r2c.plugin/v1']),
});

const SCHEMA_ID = /^r2c\.([a-z][a-z0-9-]*)\/v(\d+)$/;

/** `{ family, revision }` for a `r2c.<family>/v<N>` id, or `null`. */
export function parseSchemaId(id) {
  if (typeof id !== 'string') return null;
  const match = SCHEMA_ID.exec(id);
  if (match === null) return null;
  return { family: match[1], revision: Number.parseInt(match[2], 10) };
}

/** True when `id` is one of the accepted revisions of `family`. */
export function isSupportedSchema(family, id) {
  return SUPPORTED[family]?.includes(id) === true;
}

/**
 * True when `id` names `family` with a revision above every supported one.
 *
 * A malformed or unknown id is not "newer": callers treat it as its own error
 * so a corrupt file cannot masquerade as a version-skew signal.
 */
export function isNewerSchema(family, id) {
  const parsed = parseSchemaId(id);
  if (parsed === null || parsed.family !== family) return false;
  const revisions = (SUPPORTED[family] ?? []).map((value) => parseSchemaId(value)?.revision ?? 0);
  return parsed.revision > Math.max(...revisions);
}
