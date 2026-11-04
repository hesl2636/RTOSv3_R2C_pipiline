/**
 * Node-only SHA-256 primitive. The browser implementation injects
 * `crypto.subtle` instead; every validator and compiler takes the hash as an
 * injected primitive, so hashing logic itself has a single implementation.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(input) {
  const hash = createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input));
  return hash.digest('hex');
}

export const sha256 = sha256Hex;
