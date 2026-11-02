/**
 * Deterministic ZIP writer for bundle build products (no third-party deps).
 *
 * The output is a function of the entry paths and bytes only: entries are
 * sorted by path byte order, timestamps are frozen at 1980-01-01 00:00:00,
 * extra fields/attributes are zero, and there is no data descriptor. This is
 * the recipe frozen for `examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip`.
 *
 * `store` is the default and is what the sample bundle uses. `deflate` is the
 * Node built-in at a fixed level 9; callers may inject `deflateRaw` to pin a
 * different implementation.
 */
import { deflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION_MADE_BY = 20; // 2.0, MS-DOS/FAT host
const VERSION_NEEDED = 20;
const FIXED_DOS_TIME = 0; // 00:00:00
const FIXED_DOS_DATE = 0x21; // 1980-01-01
const MAX_ENTRIES = 0xffff;
const MAX_U32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as used by the ZIP format. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP path byte order (UTF-8 bytes, not locale or UTF-16 code units). */
export function compareZipPaths(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('zip: entry bytes must be a Buffer or Uint8Array');
}

/**
 * Build one ZIP archive.
 *
 * @param {Array<{path: string, bytes: Buffer|Uint8Array}>} files
 * @param {{method?: 'store'|'deflate', deflateRaw?: (bytes: Buffer) => Buffer|Uint8Array}} [options]
 * @returns {Buffer}
 */
export function writeZip(files, options = {}) {
  const methodName = options.method ?? 'store';
  if (methodName !== 'store' && methodName !== 'deflate') {
    throw new TypeError(`zip: unsupported method ${JSON.stringify(methodName)}`);
  }
  const method = methodName === 'store' ? 0 : 8;
  const deflate = options.deflateRaw ?? ((bytes) => deflateRawSync(bytes, { level: 9 }));
  if (method === 8 && typeof deflate !== 'function') {
    throw new TypeError('zip: deflateRaw must be a function');
  }
  if (!Array.isArray(files)) throw new TypeError('zip: files must be an array');
  if (files.length > MAX_ENTRIES) throw new RangeError(`zip: ${files.length} entries (max ${MAX_ENTRIES})`);

  const entries = files.map((file) => {
    if (file === null || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '') {
      throw new TypeError('zip: every entry needs a non-empty path');
    }
    return { path: file.path, bytes: toBuffer(file.bytes) };
  });
  entries.sort((a, b) => compareZipPaths(a.path, b.path));

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`zip: duplicate entry ${JSON.stringify(entry.path)}`);
    seen.add(entry.path);
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    if (name.length > 0xffff) throw new RangeError(`zip: path too long: ${entry.path}`);
    const data = entry.bytes;
    const payload = method === 0 ? data : toBuffer(deflate(data));
    if (data.length > MAX_U32 || payload.length > MAX_U32) {
      throw new RangeError(`zip: entry too large: ${entry.path}`);
    }
    if (offset > MAX_U32) throw new RangeError('zip: archive needs ZIP64 offsets');

    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8); // general purpose flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, payload);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > MAX_U32) throw new RangeError('zip: archive needs ZIP64 sizes');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}
