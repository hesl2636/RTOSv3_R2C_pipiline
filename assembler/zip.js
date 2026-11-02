/**
 * ZIP container reader for `r2c.bundle/v1` (decision #65 §2, #67 §7.1/§10).
 *
 * Two explicit phases keep the contract "container checks before inflation"
 * true:
 *
 * 1. the central directory is parsed and every structural rule is decided —
 *    paths, entry types, encryption, Zip64, duplicates, declared sizes,
 *    compression method, special task/constitution limits, local headers;
 * 2. only the files that survived phase 1 are inflated, under a per-entry and
 *    a cumulative output cap, so a "declared 0, expands to a bomb" archive is
 *    stopped before it can consume memory.
 *
 * Pure module: raw-deflate is injected (`core/node/inflate.js` in Node,
 * `DecompressionStream` in the browser). The optional `maxOutputLength` hint
 * lets a host stop inflation early; hosts that ignore it are still bounded by
 * the post-inflation checks.
 */
import { makeDiagnostic, SEVERITY } from '../core/diagnostics.js';
import { foldCase, MAX_PATH_BYTES, utf8Length } from '../core/paths.js';
import { LIMITS, entryLimitFor } from './limits.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_LOCATOR64 = 0x07064b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const ALLOWED_FLAGS = FLAG_DATA_DESCRIPTOR | FLAG_UTF8;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

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
  for (let index = 0; index < bytes.length; index += 1) {
    c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeName(nameBytes) {
  try {
    return decoder.decode(nameBytes);
  } catch {
    return null;
  }
}

/** Why a file path is not canonical (#67 §7.1 `BUNDLE_PATH_INVALID`). */
function pathReason(path, { directory = false } = {}) {
  const value = directory && path.endsWith('/') ? path.slice(0, -1) : path;
  if (value === '') return 'empty';
  if (value.includes('\0')) return 'nul';
  if (value.includes('\\')) return 'not-posix';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'absolute';
  if (utf8Length(value) > MAX_PATH_BYTES) return 'too-long';
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'not-canonical';
  if (!/^[\x20-\x7E]+$/.test(value)) return 'not-ascii';
  if (segments.some((segment) => /[ .]$/.test(segment))) return 'trailing-space-or-dot';
  if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) return 'charset';
  if (segments.length > LIMITS.MAX_PATH_DEPTH) return 'too-deep';
  return null;
}

function findEocd(bytes) {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (u32(bytes, offset) !== SIG_EOCD) continue;
    const commentLength = u16(bytes, offset + 20);
    if (commentLength === null) continue;
    if (offset + 22 + commentLength <= bytes.length) return offset;
  }
  return -1;
}

function readExtraFields(bytes, offset, length) {
  const fields = [];
  let cursor = offset;
  const end = offset + length;
  while (cursor + 4 <= end) {
    const id = u16(bytes, cursor);
    const size = u16(bytes, cursor + 2);
    if (id === null || size === null) break;
    fields.push({ id, size });
    cursor += 4 + size;
  }
  return fields;
}

/**
 * Read a zip archive.
 *
 * The parser is written once as a generator: the only host-specific step is
 * raw-deflate, so a synchronous driver (`readZip`, Node zlib) and an
 * asynchronous driver (`readZipAsync`, browser `DecompressionStream`) share
 * every check, in the same order, with the same diagnostics.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{ inflateRaw?: (bytes: Uint8Array, options?: {maxOutputLength?: number}) => Uint8Array }} [primitives]
 * @returns {{
 *   readable: boolean,
 *   ok: boolean,
 *   entries: Map<string, object>,
 *   directories: Array<{name: string, path: string}>,
 *   rejected: Array<{path: string, code: string}>,
 *   diagnostics: Array<object>,
 *   container: object,
 * }}
 */
export function readZip(input, primitives = {}) {
  return driveReadZip(zipSteps(input, primitives), primitives);
}

/**
 * Async twin of `readZip`. The host primitive may return a promise
 * (`DecompressionStream`); the archive checks are byte-identical.
 *
 * @returns {Promise<ReturnType<typeof readZip>>}
 */
export async function readZipAsync(input, primitives = {}) {
  return driveReadZipAsync(zipSteps(input, primitives), primitives);
}

function driveReadZip(iterator, primitives) {
  let step = iterator.next();
  while (!step.done) {
    let data;
    try {
      data = primitives.inflateRaw(step.value.bytes, step.value.options);
    } catch (error) {
      step = iterator.throw(error);
      continue;
    }
    step = iterator.next(data);
  }
  return step.value;
}

async function driveReadZipAsync(iterator, primitives) {
  let step = iterator.next();
  while (!step.done) {
    let data;
    try {
      data = await primitives.inflateRaw(step.value.bytes, step.value.options);
    } catch (error) {
      step = iterator.throw(error);
      continue;
    }
    step = iterator.next(data);
  }
  return step.value;
}

function* zipSteps(input, primitives) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const diagnostics = [];
  const entries = new Map();
  const directories = [];
  const rejected = [];
  const rejectedPaths = new Set();
  const accepted = [];
  const container = {
    bytes: bytes.length,
    entryCount: 0,
    declaredUncompressed: 0,
    accepted: 0,
    directories: 0,
  };

  const fail = (path, code, message, extra = {}) => {
    diagnostics.push(makeDiagnostic({
      severity: SEVERITY.ERROR,
      code,
      path,
      line: null,
      pointer: null,
      message,
      details: extra.details,
    }));
  };
  const markRejected = (path, code) => {
    if (path === '' || rejectedPaths.has(path)) return;
    rejectedPaths.add(path);
    rejected.push({ path, code });
  };
  const reject = (path, code, message, extra = {}) => {
    fail(path, code, message, extra);
    markRejected(path, code);
  };
  const result = (readable) => {
    container.accepted = entries.size;
    container.directories = directories.length;
    return {
      readable,
      ok: diagnostics.length === 0,
      entries,
      filePaths: accepted.map((item) => item.record.name),
      directories,
      rejected,
      diagnostics,
      container,
    };
  };

  if (bytes.length > LIMITS.MAX_ZIP_BYTES) {
    fail('', 'BUNDLE_ZIP_TOO_LARGE', 'zip exceeds the size limit', {
      details: { limit: LIMITS.MAX_ZIP_BYTES, actual: bytes.length },
    });
    return result(false);
  }

  const eocd = findEocd(bytes);
  if (eocd < 0) {
    fail('', 'BUNDLE_ZIP_INVALID', 'not a zip archive', { details: { reason: 'not-zip' } });
    return result(false);
  }

  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const totalEntries = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if ([disk, centralDisk, entriesOnDisk, totalEntries, centralSize, centralOffset].some((value) => value === null)) {
    fail('', 'BUNDLE_ZIP_INVALID', 'truncated end-of-central-directory record', { details: { reason: 'eocd' } });
    return result(false);
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    fail('', 'BUNDLE_ZIP_INVALID', 'multi-disk archives are not supported', { details: { reason: 'spanned' } });
    return result(false);
  }
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_LOCATOR64) {
    fail('', 'BUNDLE_ZIP64', 'zip64 archives are not supported', { details: { entry: null } });
    return result(false);
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('', 'BUNDLE_ZIP64', 'zip64 archives are not supported', { details: { entry: null } });
    return result(false);
  }
  if (centralOffset + centralSize > bytes.length) {
    fail('', 'BUNDLE_ZIP_INVALID', 'central directory is out of bounds', { details: { reason: 'eocd' } });
    return result(false);
  }
  if (totalEntries > LIMITS.MAX_ENTRIES) {
    fail('', 'BUNDLE_ENTRY_COUNT', 'too many zip entries', {
      details: { limit: LIMITS.MAX_ENTRIES, actual: totalEntries },
    });
    return result(false);
  }
  container.entryCount = totalEntries;

  // -------------------------------------------------------------------------
  // Phase 1: central directory. No entry data is read or inflated here.
  // -------------------------------------------------------------------------
  const records = [];
  const seenNames = new Map();
  const seenOffsets = new Map();
  let cursor = centralOffset;
  let declaredUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (u32(bytes, cursor) !== SIG_CENTRAL) {
      fail('', 'BUNDLE_ZIP_INVALID', 'corrupt central directory record', { details: { reason: 'eocd' } });
      return result(false);
    }
    const madeBy = u16(bytes, cursor + 4);
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const crc = u32(bytes, cursor + 16);
    const compressedSize = u32(bytes, cursor + 20);
    const size = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const externalAttributes = u32(bytes, cursor + 38);
    const localOffset = u32(bytes, cursor + 42);
    if ([madeBy, flags, method, crc, compressedSize, size, nameLength, extraLength, commentLength, externalAttributes, localOffset]
      .some((value) => value === null)) {
      fail('', 'BUNDLE_ZIP_INVALID', 'truncated central directory record', { details: { reason: 'eocd' } });
      return result(false);
    }
    const nameStart = cursor + 46;
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decodeName(nameBytes);
    if (name === null) {
      fail('', 'BUNDLE_PATH_INVALID', 'entry name is not valid UTF-8', { details: { reason: 'not-utf8' } });
      cursor = nameStart + nameLength + extraLength + commentLength;
      continue;
    }
    const record = {
      name,
      madeBy,
      flags,
      method,
      crc,
      compressedSize,
      size,
      externalAttributes,
      localOffset,
      extraFields: readExtraFields(bytes, nameStart + nameLength, extraLength),
      duplicate: false,
      hardLink: false,
    };
    const fold = foldCase(name);
    if (seenNames.has(fold)) {
      record.duplicate = true;
      reject(name, 'BUNDLE_DUPLICATE_ENTRY', 'duplicate entry name', {
        details: { entry: name, mode: seenNames.get(fold) === name ? 'exact' : 'case-fold' },
      });
    } else {
      seenNames.set(fold, name);
      if (localOffset !== 0xffffffff && seenOffsets.has(localOffset)) {
        record.hardLink = true;
        reject(name, 'BUNDLE_ENTRY_TYPE', 'hard-linked entries are not allowed', {
          details: { kind: 'hardlink' },
        });
      } else if (localOffset !== 0xffffffff) {
        seenOffsets.set(localOffset, name);
      }
    }
    records.push(record);
    declaredUncompressed += size;
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  container.declaredUncompressed = declaredUncompressed;

  if (declaredUncompressed > LIMITS.MAX_UNCOMPRESSED_BYTES) {
    fail('', 'BUNDLE_UNCOMPRESSED_TOO_LARGE', 'declared uncompressed size exceeds the limit', {
      details: { limit: LIMITS.MAX_UNCOMPRESSED_BYTES, actual: declaredUncompressed },
    });
    return result(false);
  }

  for (const record of records) {
    if (record.duplicate || record.hardLink) continue;
    const { name, flags, method, externalAttributes, madeBy } = record;
    const isDirectoryName = name.endsWith('/');

    if (record.size === 0xffffffff || record.compressedSize === 0xffffffff
      || record.localOffset === 0xffffffff
      || record.extraFields.some((field) => field.id === 0x0001)) {
      reject(name, 'BUNDLE_ZIP64', 'zip64 entries are not supported', { details: { entry: name } });
      continue;
    }
    if ((flags & FLAG_ENCRYPTED) !== 0 || (flags & FLAG_STRONG_ENCRYPTION) !== 0
      || record.extraFields.some((field) => field.id === 0x9901)) {
      reject(name, 'BUNDLE_ENCRYPTED', 'encrypted entries are not allowed', { details: { entry: name } });
      continue;
    }
    const unknownFlags = flags & ~ALLOWED_FLAGS & ~(FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION);
    if (unknownFlags !== 0) {
      reject(name, 'BUNDLE_ZIP_INVALID', 'unsupported general-purpose flags', {
        details: { reason: 'flags', entry: name },
      });
      continue;
    }
    if (method !== 0 && method !== 8) {
      reject(name, 'BUNDLE_COMPRESSION_UNSUPPORTED', 'unsupported compression method', {
        details: { method },
      });
      continue;
    }

    const reason = pathReason(name, { directory: isDirectoryName });
    if (reason !== null) {
      reject(name, 'BUNDLE_PATH_INVALID', 'entry path is not canonical', { details: { reason } });
      continue;
    }

    if (isDirectoryName) {
      if (record.size !== 0 || record.compressedSize !== 0) {
        reject(name, 'BUNDLE_ZIP_INVALID', 'directory entries must not carry data', {
          details: { reason: 'dir-with-data' },
        });
        continue;
      }
      directories.push({ name, path: name.slice(0, -1) });
      continue;
    }

    const host = (madeBy ?? 0) >>> 8;
    const unixMode = (externalAttributes ?? 0) >>> 16;
    const unixType = unixMode & S_IFMT;
    if (host === 3 || host === 19) {
      if (unixType === S_IFLNK) {
        reject(name, 'BUNDLE_SYMLINK', 'symlink entries are not allowed', { details: { kind: 'symlink' } });
        continue;
      }
      if (unixType === S_IFDIR) {
        reject(name, 'BUNDLE_ENTRY_TYPE', 'directory entry must end with a slash', { details: { kind: 'directory' } });
        continue;
      }
      if (unixType !== 0 && unixType !== S_IFREG) {
        reject(name, 'BUNDLE_ENTRY_TYPE', 'only regular files and directories are allowed', {
          details: { kind: 'special' },
        });
        continue;
      }
    } else {
      const dosAttributes = (externalAttributes ?? 0) & 0xffff;
      if ((dosAttributes & 0x0400) !== 0) {
        reject(name, 'BUNDLE_SYMLINK', 'reparse-point entries are not allowed', { details: { kind: 'reparse' } });
        continue;
      }
      if ((dosAttributes & 0x0010) !== 0) {
        reject(name, 'BUNDLE_ENTRY_TYPE', 'directory entry must end with a slash', { details: { kind: 'directory' } });
        continue;
      }
    }

    const special = entryLimitFor(name);
    if (special !== null && record.size > special.limit) {
      reject(name, special.code, 'entry exceeds the size limit for its kind', {
        details: { limit: special.limit, actual: record.size },
      });
      continue;
    }
    if (record.size > LIMITS.MAX_ENTRY_BYTES) {
      reject(name, 'BUNDLE_ENTRY_TOO_LARGE', 'entry exceeds the size limit', {
        details: { entry: name, limit: LIMITS.MAX_ENTRY_BYTES, actual: record.size },
      });
      continue;
    }

    const localCheck = checkLocalHeader(bytes, record);
    if (localCheck.ok !== true) {
      reject(name, 'BUNDLE_ZIP_INVALID', localCheck.message, { details: { reason: localCheck.reason, entry: name } });
      continue;
    }
    accepted.push({ record, dataStart: localCheck.dataStart });
  }

  // -------------------------------------------------------------------------
  // Phase 2: inflate accepted files only, with a per-entry and a cumulative cap.
  // -------------------------------------------------------------------------
  let inflatedTotal = 0;
  let aborted = false;
  for (let index = 0; index < accepted.length; index += 1) {
    const { record, dataStart } = accepted[index];
    const { name, method } = record;
    let data;
    if (method === 0) {
      data = bytes.slice(dataStart, dataStart + record.compressedSize);
    } else {
      if (typeof primitives.inflateRaw !== 'function') {
        reject(name, 'BUNDLE_ZIP_INVALID', 'deflate support is not available', {
          details: { reason: 'deflate-unavailable', entry: name },
        });
        continue;
      }
      const remaining = LIMITS.MAX_UNCOMPRESSED_BYTES - inflatedTotal;
      const bound = Math.min(LIMITS.MAX_ENTRY_BYTES, remaining);
      const cap = bound + 1;
      try {
        const raw = bytes.subarray(dataStart, dataStart + record.compressedSize);
        data = yield { bytes: raw, options: { maxOutputLength: cap } };
      } catch (error) {
        if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
          if (bound === LIMITS.MAX_ENTRY_BYTES) {
            reject(name, 'BUNDLE_ENTRY_TOO_LARGE', 'entry exceeds the size limit', {
              details: { entry: name, limit: LIMITS.MAX_ENTRY_BYTES, actual: cap },
            });
          } else {
            fail('', 'BUNDLE_UNCOMPRESSED_TOO_LARGE', 'inflated data exceeds the limit', {
              details: { limit: LIMITS.MAX_UNCOMPRESSED_BYTES, actual: inflatedTotal + cap },
            });
            for (const pending of accepted.slice(index)) {
              markRejected(pending.record.name, 'BUNDLE_UNCOMPRESSED_TOO_LARGE');
            }
            aborted = true;
          }
          if (aborted) break;
          continue;
        }
        reject(name, 'BUNDLE_ZIP_INVALID', 'entry could not be inflated', {
          details: { reason: 'inflate', entry: name },
        });
        continue;
      }
    }

    const actualSpecial = entryLimitFor(name);
    if (actualSpecial !== null && data.length > actualSpecial.limit) {
      reject(name, actualSpecial.code, 'entry exceeds the size limit for its kind', {
        details: { limit: actualSpecial.limit, actual: data.length },
      });
      continue;
    }
    if (data.length > LIMITS.MAX_ENTRY_BYTES) {
      reject(name, 'BUNDLE_ENTRY_TOO_LARGE', 'entry exceeds the size limit', {
        details: { entry: name, limit: LIMITS.MAX_ENTRY_BYTES, actual: data.length },
      });
      continue;
    }
    inflatedTotal += data.length;
    if (inflatedTotal > LIMITS.MAX_UNCOMPRESSED_BYTES) {
      fail('', 'BUNDLE_UNCOMPRESSED_TOO_LARGE', 'inflated data exceeds the limit', {
        details: { limit: LIMITS.MAX_UNCOMPRESSED_BYTES, actual: inflatedTotal },
      });
      for (const pending of accepted.slice(index)) {
        markRejected(pending.record.name, 'BUNDLE_UNCOMPRESSED_TOO_LARGE');
      }
      aborted = true;
      break;
    }
    // A deflate stream that expands past its declared size is bounded by the
    // limits above; one that expands to less is a truncated/lying archive.
    if (data.length < record.size) {
      reject(name, 'BUNDLE_ZIP_INVALID', 'entry size does not match the central directory', {
        details: { reason: 'size', entry: name },
      });
      continue;
    }
    if (crc32(data) !== record.crc) {
      reject(name, 'BUNDLE_ZIP_INVALID', 'entry CRC does not match', { details: { reason: 'crc', entry: name } });
      continue;
    }

    entries.set(name, {
      name,
      path: name,
      data,
      method,
      flags: record.flags,
      compressedSize: record.compressedSize,
      size: record.size,
      crc32: record.crc,
      externalAttributes: record.externalAttributes,
    });
  }
  container.inflated = inflatedTotal;
  container.aborted = aborted;

  if (aborted) return result(true);
  return result(records.length > 0 || totalEntries === 0);
}

function checkLocalHeader(bytes, record) {
  const offset = record.localOffset;
  if (u32(bytes, offset) !== SIG_LOCAL) {
    return { ok: false, reason: 'local-header', message: 'bad local header signature' };
  }
  const flags = u16(bytes, offset + 6);
  const method = u16(bytes, offset + 8);
  const nameLength = u16(bytes, offset + 26);
  const extraLength = u16(bytes, offset + 28);
  if (flags === null || method === null || nameLength === null || extraLength === null) {
    return { ok: false, reason: 'local-header', message: 'truncated local header' };
  }
  if (flags !== record.flags || method !== record.method) {
    return { ok: false, reason: 'local-header', message: 'local header disagrees with the central directory' };
  }
  const nameStart = offset + 30;
  const localName = bytes.subarray(nameStart, nameStart + nameLength);
  const centralName = encoder.encode(record.name);
  if (localName.length !== centralName.length) {
    return { ok: false, reason: 'local-header', message: 'local entry name disagrees with the central directory' };
  }
  for (let index = 0; index < localName.length; index += 1) {
    if (localName[index] !== centralName[index]) {
      return { ok: false, reason: 'local-header', message: 'local entry name disagrees with the central directory' };
    }
  }
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart + record.compressedSize > bytes.length) {
    return { ok: false, reason: 'local-header', message: 'entry data is out of bounds' };
  }
  return { ok: true, dataStart };
}
