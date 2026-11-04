/**
 * Unicode code-point helpers.
 *
 * JSON Schema `maxLength` counts code points, while `String#length` counts
 * UTF-16 code units. Every length limit in the bundle/compiled workflow contracts is defined
 * in code points, so all validators must use these helpers; otherwise CJK
 * extension characters and emoji would validate differently in Node and in
 * the browser.
 */
export function codePointLength(text) {
  if (typeof text !== 'string') return 0;
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** Compare two strings by Unicode code point (UTF-16 order differs above BMP). */
export function compareCodePoints(left, right) {
  if (left === right) return 0;
  const a = String(left)[Symbol.iterator]();
  const b = String(right)[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done || y.done) {
      if (x.done && y.done) return 0;
      return x.done ? -1 : 1;
    }
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Slice by code point, so clipping never splits a surrogate pair. */
export function sliceCodePoints(text, start, end = undefined) {
  if (typeof text !== 'string') return '';
  return [...text].slice(start, end).join('');
}
