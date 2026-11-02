/**
 * Deterministic ustar+gzip container for bundle release payloads (#105, #74 §3.5).
 *
 * Owned by `installer/` so the installer can read a Release payload without
 * `scripts/` (#106); `scripts/lib/release-tar.mjs` re-exports it for the
 * packager and its tests.
 *
 * The legacy payload/engine writer in `src/plugin.js` freezes a 100-byte path
 * limit and 0644-only members because that is the frozen legacy asset
 * contract. Pre-projected payloads are a new asset family: projection paths
 * may reach 200 bytes and file modes are part of the manifest (`0644`/`0755`),
 * so they need the prefix split and the mode field. The byte recipe is
 * otherwise the same: sorted members, uid/gid 0, mtime 0, empty uname/gname,
 * no directory entries, gzip level 9 with MTIME 0.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { compareCodePoints } from '../core/code-point.js';

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const PATH_MAX = NAME_MAX + 1 + PREFIX_MAX;
const MODES = new Set([0o644, 0o755]);

/** Return a one-line reason when `path` cannot be a payload member, else null. */
export function releasePathProblem(path) {
  if (typeof path !== 'string' || path === '') return 'path is empty';
  if (path.startsWith('/') || path.includes('\\')) return `path must be relative and POSIX: ${path}`;
  if (Buffer.byteLength(path, 'utf8') > PATH_MAX) {
    return `path is longer than ${PATH_MAX} bytes: ${path}`;
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return `path is not canonical: ${path}`;
    if (segment === '.git') return `path contains a .git segment: ${path}`;
  }
  return null;
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

/** Split a long path into the ustar `prefix` + `name` pair. */
function splitPath(path) {
  if (Buffer.byteLength(path, 'utf8') <= NAME_MAX) return { prefix: '', name: path };
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (path[index] !== '/') continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name, 'utf8') > NAME_MAX) continue;
    if (Buffer.byteLength(prefix, 'utf8') > PREFIX_MAX) continue;
    return { prefix, name };
  }
  throw new Error(`path cannot be represented in ustar: ${path}`);
}

function header(path, size, mode) {
  const { prefix, name } = splitPath(path);
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, NAME_MAX, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(0, 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block[156] = 0x30; // regular file
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  if (prefix !== '') block.write(prefix, 345, PREFIX_MAX, 'utf8');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/**
 * Build one deterministic ustar+gzip archive.
 *
 * @param {Array<{path: string, data: Buffer|Uint8Array|string, mode?: number}>} entries
 * @returns {Buffer}
 */
export function createReleaseTarGz(entries) {
  const problems = [];
  const sorted = [...entries].sort((left, right) => compareCodePoints(left.path, right.path));
  const seen = new Set();
  for (const entry of sorted) {
    const problem = releasePathProblem(entry.path);
    if (problem !== null) problems.push(problem);
    if (seen.has(entry.path)) problems.push(`duplicate payload path: ${entry.path}`);
    seen.add(entry.path);
    const mode = entry.mode ?? 0o644;
    if (!MODES.has(mode)) problems.push(`mode must be 0644 or 0755: ${entry.path}`);
  }
  if (problems.length > 0) {
    throw new Error(`invalid release archive entries:\n- ${problems.join('\n- ')}`);
  }

  const blocks = [];
  for (const entry of sorted) {
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? '', 'utf8');
    blocks.push(header(entry.path, data.length, entry.mode ?? 0o644), data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
  gz.writeUInt32LE(0, 4); // gzip MTIME = 0 (RFC 1952 bytes 4..7)
  return gz;
}

function readString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

/**
 * Read a deterministic ustar+gzip archive.
 *
 * Returns `{entries: [{path, data, mode, mtime, uid, gid}], problems[]}`.
 * PAX/GNU long-name headers and non-regular members are problems, never
 * materialised: a release payload ships regular files only.
 */
export function readReleaseTarGz(buffer) {
  const entries = [];
  const problems = [];
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (error) {
    return { entries, problems: [`not a gzip stream: ${error.message}`] };
  }

  let offset = 0;
  const seen = new Set();
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const name = readString(block, 0, NAME_MAX);
    const prefix = readString(block, 345, PREFIX_MAX);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const mode = Number.parseInt(readString(block, 100, 8).trim() || '0', 8);
    const uid = Number.parseInt(readString(block, 108, 8).trim() || '0', 8);
    const gid = Number.parseInt(readString(block, 116, 8).trim() || '0', 8);
    const mtime = Number.parseInt(readString(block, 136, 12).trim() || '0', 8);
    const size = Number.parseInt(readString(block, 124, 12).trim() || '0', 8);
    const type = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
    offset += BLOCK;
    if (!Number.isFinite(size) || size < 0) {
      problems.push(`invalid tar entry size for ${path || '(unnamed)'}`);
      break;
    }
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (type === '5') continue;
    if (type === 'x' || type === 'g') {
      problems.push(`PAX extended header is not allowed: ${path || '(unnamed)'}`);
      continue;
    }
    if (type === 'L' || type === 'K') {
      problems.push('GNU long name header is not allowed');
      continue;
    }
    if (type !== '0') {
      problems.push(`unsupported tar entry type "${type}": ${path || '(unnamed)'}`);
      continue;
    }
    const problem = releasePathProblem(path);
    if (problem !== null) {
      problems.push(problem);
      continue;
    }
    if (seen.has(path)) {
      problems.push(`duplicate payload path: ${path}`);
      continue;
    }
    seen.add(path);
    entries.push({ path, data, mode, mtime, uid, gid });
  }
  return { entries, problems };
}
