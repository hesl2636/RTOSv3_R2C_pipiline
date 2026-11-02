/**
 * Lenient JSON scanner used only to explain why a document is not canonical.
 *
 * `JSON.parse` silently drops duplicate keys and refuses comments and trailing
 * commas, so the canonical check needs its own view: the scanner records those
 * three shapes (with line numbers) and can repair them so the document's value
 * stays available for the semantic checks. It never decides validity; the
 * repaired text still has to survive `JSON.parse`.
 */

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);
const TOKEN_BREAK = new Set([' ', '\t', '\r', '\n', ',', '{', '}', '[', ']', ':']);

function skipString(text, index, line) {
  let cursor = index + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '"') return { end: cursor + 1, line };
    if (char === '\n') line += 1;
    cursor += 1;
  }
  return { end: cursor, line };
}

/**
 * @param {string} text
 * @returns {{
 *   duplicates: Array<{key: string, line: number}>,
 *   comments: Array<{start: number, end: number, line: number}>,
 *   trailingCommas: Array<{index: number, line: number}>,
 * }}
 */
export function scanJson(text) {
  const duplicates = [];
  const comments = [];
  const trailingCommas = [];
  const stack = [];
  let line = 1;
  let index = 0;
  let pendingComma = null;

  while (index < text.length) {
    const char = text[index];
    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (WHITESPACE.has(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const start = index;
      const startLine = line;
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      comments.push({ start, end: index, line: startLine });
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const start = index;
      const startLine = line;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') line += 1;
        index += 1;
      }
      if (index < text.length) index += 2;
      comments.push({ start, end: index, line: startLine });
      continue;
    }
    if (char === '"') {
      const startLine = line;
      const start = index;
      const scanned = skipString(text, index, line);
      index = scanned.end;
      line = scanned.line;
      const top = stack[stack.length - 1];
      if (top !== undefined && top.type === 'object' && top.expectKey) {
        const raw = text.slice(start, index);
        let key = raw;
        try { key = JSON.parse(raw); } catch { /* keep raw text */ }
        if (top.keys.has(key)) duplicates.push({ key, line: startLine });
        else top.keys.add(key);
        top.expectKey = false;
      }
      pendingComma = null;
      continue;
    }
    if (char === '{') {
      stack.push({ type: 'object', keys: new Set(), expectKey: true });
      pendingComma = null;
      index += 1;
      continue;
    }
    if (char === '[') {
      stack.push({ type: 'array' });
      pendingComma = null;
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      if (pendingComma !== null) {
        trailingCommas.push(pendingComma);
        pendingComma = null;
      }
      stack.pop();
      index += 1;
      continue;
    }
    if (char === ',') {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        if (top.type === 'object') top.expectKey = true;
        pendingComma = { index, line };
      }
      index += 1;
      continue;
    }
    if (char === ':') {
      pendingComma = null;
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && !TOKEN_BREAK.has(text[index])) index += 1;
    if (index === start) index += 1;
    pendingComma = null;
    const top = stack[stack.length - 1];
    if (top !== undefined && top.type === 'object') top.expectKey = false;
  }

  return { duplicates, comments, trailingCommas };
}

/** Remove every comment and trailing comma the scanner found. */
export function repairJson(text) {
  const { comments, trailingCommas } = scanJson(text);
  const ranges = [
    ...comments.map((comment) => ({ start: comment.start, end: comment.end })),
    ...trailingCommas.map((comma) => ({ start: comma.index, end: comma.index + 1 })),
  ].sort((left, right) => left.start - right.start);
  let repaired = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    repaired += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return repaired + text.slice(cursor);
}
