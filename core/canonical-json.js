/**
 * Canonical JSON: `JSON.stringify(value, null, 2) + "\n"`.
 *
 * Every persisted contract (bundle.json, stage files, workflow.compiled.json,
 * projection results, receipts) is written in this exact byte form, so
 * validation can be "parse -> re-serialize -> compare bytes".
 */
export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** True when `text` is already the canonical byte form of its parsed value. */
export function isCanonicalJson(text) {
  if (typeof text !== 'string') return false;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return canonicalJson(value) === text;
}

/** First differing UTF-16 offset between two strings, or -1 when equal. */
export function firstDifferenceOffset(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return -1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : length;
}
