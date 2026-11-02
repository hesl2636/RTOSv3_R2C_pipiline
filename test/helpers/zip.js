/**
 * Deterministic ZIP writer for tests (store / deflate, fixed DOS time).
 *
 * The assembler only consumes bytes, so fixtures are built in-process instead
 * of committing binary blobs. Output is stable for the same input map order.
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

/**
 * Build a zip archive.
 *
 * @param {Map<string, string|Uint8Array>|Record<string, string|Uint8Array>} entries
 * @param {{ method?: 'store'|'deflate', directory?: string[], dataDescriptor?: boolean }} [options]
 * @returns {Buffer}
 */
export function buildZip(entries, options = {}) {
  const method = options.method === 'deflate' ? 8 : 0;
  const dataDescriptor = options.dataDescriptor === true;
  const files = entries instanceof Map ? [...entries] : Object.entries(entries);
  const directories = options.directory ?? [];
  const local = [];
  const central = [];
  let offset = 0;

  const push = (name, data, isDirectory) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = isDirectory ? Buffer.alloc(0) : Buffer.from(utf8(data));
    const body = method === 8 && !isDirectory ? deflateRawSync(raw) : raw;
    const checksum = crc32(raw);
    const flags = dataDescriptor ? 0x0008 : 0;
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
      u16(0),
      nameBytes,
    ]);
    local.push(localHeader, body);
    if (dataDescriptor) local.push(u32(0x08074b50), u32(checksum), u32(body.length), u32(raw.length));
    const external = isDirectory ? (0o040755 << 16) >>> 0 : (0o100644 << 16) >>> 0;
    central.push(Buffer.concat([
      u32(0x02014b50),
      u16(0x0314),
      u16(20),
      u16(flags),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(checksum),
      u32(body.length),
      u32(raw.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(external),
      u32(offset),
      nameBytes,
    ]));
    offset += localHeader.length + body.length
      + (dataDescriptor ? 16 : 0);
  };

  for (const name of directories) push(name.endsWith('/') ? name : `${name}/`, '', true);
  for (const [name, data] of files) push(name, data, false);

  const centralBytes = Buffer.concat(central);
  const localBytes = Buffer.concat(local);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(centralBytes.length),
    u32(localBytes.length),
    u16(0),
  ]);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}
