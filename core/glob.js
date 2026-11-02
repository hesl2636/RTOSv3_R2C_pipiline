/**
 * Minimal glob grammar shared by bundle outputs, IR outputs and gates.
 *
 * `isValidGlob` only rejects patterns that can never match (unbalanced
 * braces/brackets, empty, NUL). `matchesGlob` implements the same subset the
 * runtime uses: `*`, `**`, `?`, `[...]`, `{a,b}` and `\` escapes.
 */
export function isValidGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '' || pattern.includes('\0')) return false;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') {
      if (braces > 0) return false;
      braces += 1;
    } else if (char === '}') {
      if (braces === 0) return false;
      braces -= 1;
    } else if (char === '[') {
      if (brackets > 0) return false;
      brackets += 1;
    } else if (char === ']') {
      if (brackets === 0) return false;
      brackets -= 1;
    }
  }
  return braces === 0 && brackets === 0;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(char) {
  return char.replace(REGEX_SPECIAL, '\\$&');
}

function translate(pattern) {
  let out = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        out += '\\\\';
        index += 1;
      } else {
        out += escapeLiteral(next);
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 3;
        } else {
          out += '.*';
          index += 2;
        }
        continue;
      }
      out += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) {
        out += '\\[';
        index += 1;
        continue;
      }
      let body = pattern.slice(index + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      index = end + 1;
      continue;
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end < 0) {
        out += '\\{';
        index += 1;
        continue;
      }
      const alternatives = pattern
        .slice(index + 1, end)
        .split(',')
        .map((alternative) => translate(alternative))
        .join('|');
      out += `(?:${alternatives})`;
      index = end + 1;
      continue;
    }
    out += escapeLiteral(char);
    index += 1;
  }
  return out;
}

/** True when `path` matches the glob. Case-sensitive, POSIX separators. */
export function matchesGlob(pattern, path) {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  return new RegExp(`^${translate(pattern)}$`).test(path);
}
