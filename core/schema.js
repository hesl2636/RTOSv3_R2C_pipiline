/**
 * `hm2b.<family>/v<N>` schema identifiers.
 *
 * The accepted-revision tables belong to each layer (`assembler` owns bundle
 * and IR revisions); this module only parses the id so "malformed / unknown /
 * newer" stays one algorithm everywhere.
 */
const SCHEMA_ID = /^hm2b\.([a-z][a-z0-9-]*)\/v(\d+)$/;

/** `{ family, revision }` for a schema id, or `null`. */
export function parseSchemaId(id) {
  if (typeof id !== 'string') return null;
  const match = SCHEMA_ID.exec(id);
  if (match === null) return null;
  return { family: match[1], revision: Number.parseInt(match[2], 10) };
}

/** The family portion of a schema id (`hm2b.ir/v1` -> `ir`), or `null`. */
export function schemaFamily(id) {
  return parseSchemaId(id)?.family ?? null;
}

/** True when `id` is one of the accepted revisions of `family` in `table`. */
export function isSupportedSchema(table, family, id) {
  return table[family]?.includes(id) === true;
}

/**
 * True when `id` names `family` with a revision above every supported one.
 *
 * A malformed or unknown id is not "newer": callers treat it as its own error
 * so a corrupt file cannot masquerade as a version-skew signal.
 */
export function isNewerSchema(table, family, id) {
  const parsed = parseSchemaId(id);
  if (parsed === null || parsed.family !== family) return false;
  const revisions = (table[family] ?? []).map((value) => parseSchemaId(value)?.revision ?? 0);
  return parsed.revision > Math.max(...revisions);
}
