/**
 * Structural JSON equality: two values are equal when their canonical
 * serializations are byte-identical (key order and array order included).
 * Used wherever a contract compares parsed documents without deep-equal.
 */
export function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
