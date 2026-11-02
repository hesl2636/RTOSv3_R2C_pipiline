/** Small shared helpers for the assembler checks. */
import { codePointLength } from '../core/code-point.js';

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function lengthBetween(value, minimum, maximum) {
  const length = codePointLength(value);
  return length >= minimum && length <= maximum;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when a JS string contains an unpaired surrogate (invalid UTF-8 output). */
export function hasLoneSurrogate(text) {
  return typeof text === 'string' && LONE_SURROGATE.test(text);
}

/** Lines that carry content: not blank and not a bare `---` horizontal rule. */
export function nonEmptyLines(text) {
  if (typeof text !== 'string') return [];
  return text.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && trimmed !== '---';
  });
}

/** Text before the first `## ` heading (used for placeholder banners). */
export function preamble(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  const end = lines.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? lines : lines.slice(0, end)).join('\n');
}
