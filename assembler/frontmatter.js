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
  const bodyLine = source.slice(0, close + CLOSING.length).split('\n').length;
  const diagnostics = [];
  const fields = {};
  // An open block-list header: `key:` waiting for `  - item` lines.
  let list = null;

  const closeList = () => {
    if (list !== null && list.items === 0 && !list.superseded) {
      diagnostics.push(invalid(path, list.line, 'empty-value', `list '${list.key}' has no items`));
    }
    list = null;
  };

  const lines = frontmatter.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 2;
    if (line === '') {
      closeList();
      continue;
    }

    const itemMatch = /^  - (.*)$/.exec(line);
    if (itemMatch !== null) {
      if (list === null) {
        diagnostics.push(invalid(path, lineNumber, 'shape', 'list item without a list key'));
        continue;
      }
      const item = itemMatch[1];
      if (item === '') {
        diagnostics.push(invalid(path, lineNumber, 'empty-value', `list item is empty for '${list.key}'`));
        list.superseded = true;
        continue;
      }
      const forbidden = FORBIDDEN_SCALAR_START.get(item[0]);
      if (forbidden !== undefined || item.includes(' #')) {
        diagnostics.push(unsupported(path, lineNumber, forbidden ?? 'comment', 'list items are plain scalars'));
        list.superseded = true;
        continue;
      }
      fields[list.key].push(item);
      list.items += 1;
      continue;
    }

    if (line.trimStart().startsWith('#')) {
      diagnostics.push(unsupported(path, lineNumber, 'comment', 'comments are not supported'));
      if (list !== null) list.superseded = true;
      continue;
    }

    if (/^\s/.test(line)) {
      diagnostics.push(unsupported(path, lineNumber, 'nested', 'indented content is not supported'));
      if (list !== null) list.superseded = true;
      continue;
    }

    closeList();
    const colon = line.indexOf(':');
    if (colon <= 0) {
      diagnostics.push(invalid(path, lineNumber, 'shape', 'line is not `key: value`'));
      continue;
    }
    const key = line.slice(0, colon);
    if (!KEY_RE.test(key)) {
      diagnostics.push(invalid(path, lineNumber, 'key', `invalid frontmatter key: ${key}`));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      diagnostics.push(invalid(path, lineNumber, 'duplicate-key', `duplicate frontmatter key: ${key}`));
      continue;
    }

    const rest = line.slice(colon + 1);
    if (rest.trim() === '') {
      fields[key] = [];
      list = { key, line: lineNumber, items: 0, superseded: false };
      continue;
    }

    const value = rest.trim();
    const forbidden = FORBIDDEN_SCALAR_START.get(value[0]);
    if (forbidden !== undefined) {
      diagnostics.push(unsupported(path, lineNumber, forbidden, `unsupported value shape for '${key}'`));
      continue;
    }
    if (value.includes(' #') || value.endsWith(':')) {
      diagnostics.push(unsupported(path, lineNumber, 'comment', `unsupported value for '${key}'`));
      continue;
    }
    if (/^(null|Null|NULL|~)$/.test(value)) {
      diagnostics.push(unsupported(path, lineNumber, 'null', `null is not supported for '${key}'`));
      continue;
    }
    if (value === 'true') fields[key] = true;
    else if (value === 'false') fields[key] = false;
    else fields[key] = value;
  }
  closeList();

  return { fields, body, diagnostics, bodyLine };
}
