/**
 * Deterministic ZIP writer for tests (store / deflate, fixed DOS time).
 *
 * The assembler only consumes bytes, so fixtures are built in-process instead
 * of committing binary blobs. Output is stable for the same input map order.
 *
 * Options exist only to reproduce container violations; every default matches
 * a well-formed archive so existing fixtures keep their exact bytes.
 */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (value) => (typeof value === 'string' ? new TextEncoder().encode(value) : value);

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value & 0xffff);
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

/** DOS timestamp 1980-01-01 00:00:00, so every fixture has the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function optionFor(value, name) {
  if (typeof value === 'function') return value(name);
  if (value !== null && typeof value === 'object') return value[name];
  return value;
}

function normalizeEntries(entries) {
  if (Array.isArray(entries)) return entries;
  if (entries instanceof Map) return [...entries];
  return Object.entries(entries);
}

function extraFieldBytes(fields) {
  if (!fields || fields.length === 0) return Buffer.alloc(0);
  const chunks = [];
  for (const field of fields) {
    const data = Buffer.from(field.data ?? '');
    chunks.push(Buffer.concat([u16(field.id), u16(data.length), data]));
  }
  return Buffer.concat(chunks);
}

/**
 * Build a zip archive.
 *
 * @param {Map<string, string|Uint8Array>|Record<string, string|Uint8Array>|Array<[string, string|Uint8Array]>} entries
 * @param {{
 *   method?: 'store'|'deflate',
 *   methodFor?: (name: string) => 'store'|'deflate'|number,
 *   directory?: string[],
 *   dataDescriptor?: boolean,
 *   flags?: number|((name: string) => number),
 *   madeBy?: number|((name: string) => number),
 *   externalAttributes?: number|((name: string) => number),
 *   extraFields?: Array<{id: number, data?: string|Uint8Array}>|((name: string) => Array<object>),
 *   declaredSizes?: Record<string, number>|((name: string) => number|undefined),
 *   zip64?: boolean,
 *   hardLinks?: Record<string, string>,
 *   eocd?: { disk?: number, centralDisk?: number, entriesOnDisk?: number, totalEntries?: number, centralSize?: number, centralOffset?: number },
 * }} [options]
 * @returns {Buffer}
 */
export function buildZip(entries, options = {}) {
  const defaultMethod = options.method === 'deflate' ? 8 : 0;
  const dataDescriptor = options.dataDescriptor === true;
  const files = normalizeEntries(entries);
  const directories = options.directory ?? [];
  const hardLinks = options.hardLinks ?? {};
  const local = [];
  const central = [];
  const offsets = new Map();
  let offset = 0;

  const methodOf = (name) => {
    const value = options.methodFor === undefined ? defaultMethod : optionFor(options.methodFor, name);
    if (value === 'deflate') return 8;
    if (value === 'store') return 0;
    return value;
  };

  const push = (name, data, isDirectory) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const shared = hardLinks[name];
    if (shared !== undefined) {
      const target = records.get(shared);
      if (target === undefined) throw new Error(`hard link target is not earlier: ${shared}`);
      central.push(centralRecord(nameBytes, target));
      return;
    }
    const raw = isDirectory ? Buffer.alloc(0) : Buffer.from(utf8(data));
    const method = isDirectory ? 0 : methodOf(name);
    const body = method === 8 && !isDirectory ? deflateRawSync(raw) : raw;
    const checksum = crc32(raw);
    const flags = optionFor(options.flags, name) ?? (dataDescriptor ? 0x0008 : 0);
    const madeBy = optionFor(options.madeBy, name) ?? 0x0314;
    const external = optionFor(options.externalAttributes, name)
      ?? (isDirectory ? (0o040755 << 16) >>> 0 : (0o100644 << 16) >>> 0);
    const extra = extraFieldBytes(optionFor(options.extraFields, name));
    const declaredSize = optionFor(options.declaredSizes, name);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(dataDescriptor ? 0 : checksum),
      u32(dataDescriptor ? 0 : body.length),
      u32(dataDescriptor ? 0 : raw.length),
      u16(nameBytes.length),
      u16(extra.length),
      nameBytes,
      extra,
    ]);
    local.push(localHeader, body);
    if (dataDescriptor) local.push(u32(0x08074b50), u32(checksum), u32(body.length), u32(raw.length));
    const record = {
      name,
      nameBytes,
      flags,
      method,
      checksum,
      compressedSize: body.length,
      size: raw.length,
      declaredSize,
      extra,
      madeBy,
      external,
    };
    records.set(name, record);
    offsets.set(name, offset);
    central.push(centralRecord(nameBytes, record, { localOffset: offset }));
    offset += localHeader.length + body.length
      + (dataDescriptor ? 16 : 0);
  };

  const records = new Map();

  const centralRecord = (nameBytes, record, overrides = {}) => {
    const zip64 = options.zip64 === true;
    const size = record.declaredSize ?? record.size;
    return Buffer.concat([
      u32(0x02014b50),
      u16(record.madeBy),
      u16(20),
      u16(record.flags),
      u16(record.method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(record.checksum),
      u32(zip64 ? 0xffffffff : record.compressedSize),
      u32(zip64 ? 0xffffffff : size),
      u16(nameBytes.length),
      u16(record.extra.length),
      u16(0),
      u16(0),
      u16(0),
      u32(record.external),
      u32(zip64 ? 0xffffffff : overrides.localOffset ?? offsets.get(record.name)),
      nameBytes,
      record.extra,
    ]);
  };

  for (const name of directories) push(name.endsWith('/') ? name : `${name}/`, '', true);
  for (const [name, data] of files) push(name, data, false);

  const centralBytes = Buffer.concat(central);
  const localBytes = Buffer.concat(local);
  const eocd = options.eocd ?? {};
  const totalEntries = eocd.totalEntries ?? central.length;
  const eocdBytes = Buffer.concat([
    u32(0x06054b50),
    u16(eocd.disk ?? 0),
    u16(eocd.centralDisk ?? 0),
    u16(eocd.entriesOnDisk ?? totalEntries),
    u16(totalEntries),
    u32(eocd.centralSize ?? centralBytes.length),
    u32(eocd.centralOffset ?? localBytes.length),
    u16(0),
  ]);
  return Buffer.concat([localBytes, centralBytes, eocdBytes]);
}
