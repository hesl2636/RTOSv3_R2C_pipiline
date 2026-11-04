/**
 * Deterministic YAML writer for `hm2b.workflow/v1` (spec §9).
 *
 * No general-purpose serializer: key order is the caller's insertion order,
 * every string scalar is JSON-quoted, block sequences indent by two spaces,
 * empty collections are omitted, output is LF-only with one trailing newline.
 * Byte-identical input objects therefore produce byte-identical YAML.
 */

function fail(message) {
  throw new Error(`PROJECTION_INTERNAL: ${message}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scalar text, or `null` when the value needs a block. */
function scalarText(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('workflow YAML numbers must be finite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) fail('workflow YAML has no null/undefined scalar');
  return null;
}

function writeMapping(mapping, indent, lines) {
  const pad = ' '.repeat(indent);
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof key !== 'string' || key === '') fail('workflow YAML keys must be non-empty strings');
    const scalar = scalarText(value);
    if (scalar !== null) {
      lines.push(`${pad}${key}: ${scalar}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${pad}${key}:`);
      writeSequence(value, indent + 2, lines);
      continue;
    }
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) continue;
      lines.push(`${pad}${key}:`);
      writeMapping(value, indent + 2, lines);
      continue;
    }
    fail(`unsupported workflow YAML value for ${key}`);
  }
}

function writeSequence(items, indent, lines) {
  const pad = ' '.repeat(indent);
  for (const item of items) {
    const scalar = scalarText(item);
    if (scalar !== null) {
      lines.push(`${pad}- ${scalar}`);
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) continue;
      lines.push(`${pad}-`);
      writeSequence(item, indent + 2, lines);
      continue;
    }
    if (isPlainObject(item)) {
      if (Object.keys(item).length === 0) continue;
      const nested = [];
      writeMapping(item, indent + 2, nested);
      nested[0] = `${pad}- ${nested[0].slice(indent + 2)}`;
      lines.push(...nested);
      continue;
    }
    fail('unsupported workflow YAML sequence item');
  }
}

/** `dumpWorkflowYaml(doc)` — deterministic YAML for one workflow document. */
export function dumpWorkflowYaml(doc) {
  if (!isPlainObject(doc)) fail('workflow YAML document must be an object');
  const lines = [];
  writeMapping(doc, 0, lines);
  if (lines.length === 0) fail('workflow YAML document must not be empty');
  return `${lines.join('\n')}\n`;
}
