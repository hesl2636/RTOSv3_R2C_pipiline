/**
 * Browser host primitives for the shared assembler/IR modules (decision #75
 * §2.4, ticket #108).
 *
 * `validateBundleAsync` / `validateIr` take hashing and raw-deflate as injected
 * primitives; this module is the only browser implementation of them. It uses
 * Web APIs exclusively and is safe to import in Node for tests (all Web API
 * lookups happen at call time).
 *
 * `inflateRaw` reports its output cap with `ERR_BUFFER_TOO_LARGE`, the same
 * error code `zlib.inflateRawSync` uses, so the shared zip reader maps browser
 * and Node overruns to the identical `BUNDLE_*` diagnostics.
 */

const encoder = new TextEncoder();

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return encoder.encode(String(input));
}

function overflowError(limit) {
  const error = new RangeError(`inflated output exceeds ${limit} bytes`);
  error.code = 'ERR_BUFFER_TOO_LARGE';
  return error;
}

/**
 * SHA-256 as lowercase hex (`crypto.subtle.digest`).
 *
 * @param {Uint8Array|ArrayBuffer|string} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined || typeof subtle.digest !== 'function') {
    throw new Error('crypto.subtle is not available');
  }
  const data = typeof input === 'string' ? encoder.encode(input) : toBytes(input);
  const digest = new Uint8Array(await subtle.digest('SHA-256', data));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export const sha256 = sha256Hex;

/**
 * Raw-deflate inflation (`DecompressionStream('deflate-raw')`).
 *
 * The stream is consumed incrementally: output is counted as it arrives, and
 * the reader is cancelled as soon as `maxOutputLength` is crossed, so a zip
 * bomb never gets fully materialised.
 *
 * @param {Uint8Array} bytes raw deflate stream
 * @param {{ maxOutputLength?: number }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function inflateRaw(bytes, options = {}) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error("DecompressionStream('deflate-raw') is not available");
  }
  const limit = Number.isFinite(options.maxOutputLength) ? options.maxOutputLength : Infinity;
  const source = new Blob([toBytes(bytes)]).stream();
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw overflowError(limit);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The stream is already errored closed.
    }
    throw error;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Capability probe used by the boot check. No UA sniffing: every answer is a
 * feature test. JSON import attributes are proven by the caller having loaded
 * its own module graph (the application module cannot execute otherwise), so
 * they are reported as supported when `esm` is true.
 *
 * @param {object} [scope] global object to probe (tests may pass a stub)
 * @returns {{ esm: boolean, jsonImportAttributes: boolean, cryptoSubtle: boolean,
 *   deflateRaw: boolean, textDecoder: boolean, fetch: boolean, blob: boolean }}
 */
export function probeBrowserFloor(scope = globalThis) {
  const esm = typeof scope !== 'undefined' && scope !== null;
  let deflateRaw = false;
  if (typeof scope.DecompressionStream === 'function') {
    try {
      new scope.DecompressionStream('deflate-raw');
      deflateRaw = true;
    } catch {
      deflateRaw = false;
    }
  }
  return {
    esm,
    jsonImportAttributes: esm,
    cryptoSubtle: typeof scope.crypto?.subtle?.digest === 'function',
    deflateRaw,
    textDecoder: typeof scope.TextDecoder === 'function',
    fetch: typeof scope.fetch === 'function',
    blob: typeof scope.Blob === 'function',
  };
}

/** Missing hard requirements: everything except `deflateRaw` (that degrades). */
export function missingRequirements(floor) {
  const missing = [];
  if (!floor.esm) missing.push('esm');
  if (!floor.jsonImportAttributes) missing.push('json-import-attributes');
  if (!floor.cryptoSubtle) missing.push('crypto.subtle');
  if (!floor.textDecoder) missing.push('TextDecoder');
  if (!floor.fetch) missing.push('fetch');
  if (!floor.blob) missing.push('Blob');
  return missing;
}
