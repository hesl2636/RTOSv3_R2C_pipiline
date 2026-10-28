/**
 * Dotted merge pointers (`mcpServers`, `hooks.Stop`) shared by the installer
 * and the receipt-driven uninstaller.
 *
 * A `null` pointer addresses the document root. Reading and writing must not
 * change merge semantics: values are compared by the callers, and a missing
 * intermediate container is created as an object. Creating one where an array
 * already sits keeps install's behaviour (the array is replaced, not indexed
 * into) — no adapter map points through an array.
 */

/** Value at `pointer`, or `undefined` when any segment is missing. */
export function pointerGet(object, pointer) {
  if (pointer === null) return object;
  let node = object;
  for (const key of pointer.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/** Set `value` at `pointer`, creating intermediate objects; returns the root. */
export function pointerSet(object, pointer, value) {
  if (pointer === null) return value;
  const keys = pointer.split('.');
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
  return object;
}
