/** Node-only raw-deflate primitive (`zip` method 8). */
import { inflateRawSync } from 'node:zlib';

export function inflateRaw(bytes) {
  return new Uint8Array(inflateRawSync(bytes));
}
