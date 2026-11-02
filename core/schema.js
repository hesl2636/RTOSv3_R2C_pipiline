/**
 * `r2c.<family>/v<N>` schema identifiers.
 *
 * The accepted-revision tables belong to each layer (`assembler` owns bundle
 * and IR revisions); this module only parses the id so "malformed / unknown /
 * newer" stays one algorithm everywhere.
 */
const SCHEMA_ID = /^r2c\.([a-z][a-z0-9-]*)\/v(\d+)$/;

/** `{ family, revision }` for a schema id, or `null`. */
export function parseSchemaId(id) {
  if (typeof id !== 'string') return null;
  const match = SCHEMA_ID.exec(id);
  if (match === null) return null;
  return { family: match[1], revision: Number.parseInt(match[2], 10) };
}

/** The family portion of a schema id (`r2c.ir/v1` -> `ir`), or `null`. */
export function schemaFamily(id) {
  return parseSchemaId(id)?.family ?? null;
}
