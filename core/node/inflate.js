/** Node-only raw-deflate primitive (`zip` method 8). */
import { inflateRawSync } from 'node:zlib';

/**
 * @param {Uint8Array} bytes raw-deflate stream
 * @param {{ maxOutputLength?: number }} [options]
 *   `maxOutputLength` lets the bundle reader stop a bomb during inflation;
 *   Node throws `ERR_BUFFER_TOO_LARGE` when the output would exceed it.
 */
export function inflateRaw(bytes, options = {}) {
  const max = options.maxOutputLength;
  return new Uint8Array(max === undefined ? inflateRawSync(bytes) : inflateRawSync(bytes, { maxOutputLength: max }));
}
