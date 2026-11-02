/**
 * Restricted YAML frontmatter subset (decision #65 §7, #67 §9.2).
 *
 * Only these shapes parse:
 *   key: scalar
 *   key:
 *     - item
 * Anything else (nested maps, flow collections, quotes, comments, anchors,
 * tags, multi-line scalars, `null`) is reported as unsupported instead of being
 * guessed. The body is returned byte-exact after the closing `---` line.
 */
import { makeDiagnostic, SEVERITY } from '../core/diagnostics.js';

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const CLOSING = '\n---\n';

const FORBIDDEN_SCALAR_START = new Map([
  ['"', 'quoted'],
  ["'", 'quoted'],
  ['[', 'flow'],
  ['{', 'flow'],
  ['&', 'anchor'],
  ['*', 'alias'],
  ['!', 'tag'],
  ['|', 'multiline'],
  ['>', 'multiline'],
  ['%', 'directive'],
  ['@', 'reserved'],
  ['`', 'reserved'],
  ['#', 'comment'],
]);

function invalid(path, line, reason, message) {
  return makeDiagnostic({
    severity: SEVERITY.ERROR,
    code: 'BUNDLE_FRONTMATTER_INVALID',
    path,
    line,
    message,
    details: { reason },
  });
}

function unsupported(path, line, feature, message) {
  return makeDiagnostic({
    severity: SEVERITY.ERROR,
    code: 'BUNDLE_FRONTMATTER_UNSUPPORTED',
    path,
    line,
    message,
    details: { feature },
  });
}

/**
 * Parse a Markdown file's frontmatter.
 *
 * @param {string} text
 * @param {{ path?: string }} [options]
 * @returns {{
 *   fields: Record<string, string|boolean|string[]>|null,
 *   body: string,
 *   diagnostics: Array<object>,
 *   bodyLine: number,
 * }}
 */
export function parseFrontmatter(text, options = {}) {
  const path = options.path ?? '';
  const source = typeof text === 'string' ? text : '';
  if (!source.startsWith('---\n')) {
    return { fields: null, body: source, diagnostics: [], bodyLine: 1 };
  }
  const close = source.indexOf(CLOSING, 3);
  if (close < 0) {
    return {
      fields: null,
      body: source,
      diagnostics: [invalid(path, 1, 'unclosed', 'frontmatter block is not closed')],
      bodyLine: 1,
    };
  }

  const frontmatter = source.slice(4, close);
  const body = source.slice(close + CLOSING.length);
  const bodyLine = 1 + 1 + frontmatter.split('\n').length + 1;
  const diagnostics = [];
  const fields = {};
  let listKey = null;
  let listLine = 0;

  const lines = frontmatter.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 2;
    if (line === '') {
      listKey = null;
      continue;
    }

    const itemMatch = /^  - (.*)$/.exec(line);
    if (itemMatch !== null) {
      if (listKey === null) {
        diagnostics.push(invalid(path, lineNumber, 'shape', 'list item without a list key'));
        continue;
      }
      const item = itemMatch[1];
      if (item === '') {
        diagnostics.push(invalid(path, lineNumber, 'empty-value', `list item is empty for '${listKey}'`));
        continue;
      }
      const forbidden = FORBIDDEN_SCALAR_START.get(item[0]);
      if (forbidden !== undefined || item.includes(' #')) {
        diagnostics.push(unsupported(path, lineNumber, forbidden ?? 'comment', 'list items are plain scalars'));
        continue;
      }
      fields[listKey].push(item);
      continue;
    }

    if (/^\s/.test(line)) {
      diagnostics.push(unsupported(path, lineNumber, 'nested', 'indented content is not supported'));
      listKey = null;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) {
      diagnostics.push(invalid(path, lineNumber, 'shape', 'line is not `key: value`'));
      listKey = null;
      continue;
    }
    const key = line.slice(0, colon);
    if (!KEY_RE.test(key)) {
      diagnostics.push(invalid(path, lineNumber, 'key', `invalid frontmatter key: ${key}`));
      listKey = null;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      diagnostics.push(invalid(path, lineNumber, 'duplicate-key', `duplicate frontmatter key: ${key}`));
      listKey = null;
      continue;
    }

    const rest = line.slice(colon + 1);
    if (rest.trim() === '') {
      fields[key] = [];
      listKey = key;
      listLine = lineNumber;
      continue;
    }

    const value = rest.trim();
    const forbidden = FORBIDDEN_SCALAR_START.get(value[0]);
    if (forbidden !== undefined) {
      diagnostics.push(unsupported(path, lineNumber, forbidden, `unsupported value shape for '${key}'`));
      listKey = null;
      continue;
    }
    if (value.includes(' #') || value.endsWith(':')) {
      diagnostics.push(unsupported(path, lineNumber, 'comment', `unsupported value for '${key}'`));
      listKey = null;
      continue;
    }
    if (/^(null|Null|NULL|~)$/.test(value)) {
      diagnostics.push(unsupported(path, lineNumber, 'null', `null is not supported for '${key}'`));
      listKey = null;
      continue;
    }
    if (value === 'true') fields[key] = true;
    else if (value === 'false') fields[key] = false;
    else fields[key] = value;
    listKey = null;
  }

  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value) && value.length === 0) {
      diagnostics.push(invalid(path, listLine, 'empty-value', `list '${key}' has no items`));
    }
  }

  return { fields, body, diagnostics, bodyLine };
}
