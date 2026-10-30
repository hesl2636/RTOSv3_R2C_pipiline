/**
 * Plugin payload contract.
 *
 * This module is the single definition of what a payload is: the file set
 * (`PAYLOAD_*` below), the `r2c.plugin/v1` manifest, and the deterministic
 * ustar+gzip container. `scripts/release.mjs` writes payloads with it and
 * `src/adapter/payload.js` reads them with it, so a payload can only be
 * produced in the shape the installer verifies.
 *
 * Container rules (#17 §5): ustar only (no PAX, no GNU long names), regular
 * files and directories only (no links), and every path at most 100 bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { EXIT_CODES, R2cError } from './errors.js';

export const PLUGIN_SCHEMA = 'r2c.plugin/v1';
export const PAYLOAD_MANIFEST = 'r2c-payload.json';

/** The one release asset name the packager writes and the installer downloads. */
export function payloadAssetName(version) {
  return `r2c-payload-${version}.tgz`;
}

/** Directories copied verbatim from the repository root. */
export const PAYLOAD_DIRS = Object.freeze(['adapters', 'schema', 'shims']);
/** Directories copied from `pack/` to the payload root. */
export const PAYLOAD_PACK_DIRS = Object.freeze(['commands', 'skills', 'tasks', 'workflows']);
/** Individual files copied from the repository root. */
export const PAYLOAD_ROOT_FILES = Object.freeze(['LICENSE']);

export const MAX_PATH_BYTES = 100;
const BLOCK = 512;

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return sha256(readFileSync(file));
}

/** Codepoint order, shared with the installer so manifests hash identically. */
export function comparePayloadPaths(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `null` when `rel` is a legal payload path, otherwise a problem string. */
export function payloadPathProblem(rel) {
  if (typeof rel !== 'string' || rel === '') return 'payload path is empty';
  const bytes = Buffer.byteLength(rel, 'utf8');
  if (bytes > MAX_PATH_BYTES) {
    return `payload path is ${bytes} bytes (max ${MAX_PATH_BYTES}): ${rel}`;
  }
  if (rel.startsWith('/') || rel.includes('\\')) {
    return `payload path must be relative and POSIX: ${rel}`;
  }
  const segments = rel.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `payload path is not canonical: ${rel}`;
  }
  return null;
}

/**
 * Collect the payload file set from a repository checkout.
 *
 * Returns `{ files: [{rel, absolute}], problems[] }`; problems (missing,
 * empty, symlinked or over-long paths) make the release build fail.
 */
export function collectPayload(root) {
  const files = [];
  const problems = [];

  const walk = (absolute, relDir) => {
    for (const name of readdirSync(absolute).sort(comparePayloadPaths)) {
      const child = join(absolute, name);
      const rel = `${relDir}/${name}`;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        problems.push(`symlink not allowed in payload: ${rel}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(child, rel);
        continue;
      }
      if (!stat.isFile()) {
        problems.push(`unsupported file type in payload: ${rel}`);
        continue;
      }
      const problem = payloadPathProblem(rel);
      if (problem !== null) {
        problems.push(problem);
        continue;
      }
      files.push({ rel, absolute: child });
    }
  };

  const addTree = (absolute, relDir) => {
    if (!existsSync(absolute)) {
      problems.push(`missing payload path: ${relDir}`);
      return;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      problems.push(`symlink not allowed in payload: ${relDir}`);
      return;
    }
    if (!stat.isDirectory()) {
      problems.push(`payload path is not a directory: ${relDir}`);
      return;
    }
    const before = files.length;
    walk(absolute, relDir);
    if (files.length === before) problems.push(`payload directory is empty: ${relDir}`);
  };

  for (const dir of PAYLOAD_DIRS) addTree(join(root, dir), dir);
  for (const dir of PAYLOAD_PACK_DIRS) addTree(join(root, 'pack', dir), dir);
  for (const name of PAYLOAD_ROOT_FILES) {
    const absolute = join(root, name);
    if (!existsSync(absolute)) {
      problems.push(`missing payload file: ${name}`);
      continue;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) problems.push(`symlink not allowed in payload: ${name}`);
    else if (!stat.isFile()) problems.push(`payload file is not a regular file: ${name}`);
    else files.push({ rel: name, absolute });
  }

  files.sort((left, right) => comparePayloadPaths(left.rel, right.rel));
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.rel)) problems.push(`duplicate payload path: ${file.rel}`);
    seen.add(file.rel);
  }
  return { files, problems };
}

/** `{ rel: sha256 }` in codepoint order, exactly what `r2c-payload.json.files` holds. */
export function hashPayloadFiles(files) {
  const hashes = {};
  for (const file of [...files].sort((left, right) => comparePayloadPaths(left.rel, right.rel))) {
    const data = file.absolute === undefined ? Buffer.from(file.data ?? '') : readFileSync(file.absolute);
    hashes[file.rel] = sha256(data);
  }
  return hashes;
}

export function buildPluginManifest({ version, files }) {
  const sorted = {};
  for (const rel of Object.keys(files).sort(comparePayloadPaths)) sorted[rel] = files[rel];
  return {
    schema: PLUGIN_SCHEMA,
    version,
    engine: `^${version}`,
    files: sorted,
  };
}

export function manifestBuffer(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function tarString(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

function tarOctal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarHeader(path, size) {
  const header = Buffer.alloc(BLOCK);
  header.write(path, 0, 100, 'utf8');
  header.write(tarOctal(0o644, 8), 100, 8, 'ascii');
  header.write(tarOctal(0, 8), 108, 8, 'ascii');
  header.write(tarOctal(0, 8), 116, 8, 'ascii');
  header.write(tarOctal(size, 12), 124, 12, 'ascii');
  header.write(tarOctal(0, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header[156] = 0x30; // regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/**
 * Deterministic ustar+gzip writer: entries are sorted, every header field is
 * fixed (mode 0644, uid/gid 0, mtime 0) and the gzip mtime is zeroed, so two
 * builds of the same bytes are identical.
 */
export function createTarGz(entries) {
  const problems = [];
  const sorted = [...entries].sort((left, right) => comparePayloadPaths(left.path, right.path));
  const seen = new Set();
  for (const entry of sorted) {
    const problem = payloadPathProblem(entry.path);
    if (problem !== null) problems.push(problem);
    if (seen.has(entry.path)) problems.push(`duplicate payload path: ${entry.path}`);
    seen.add(entry.path);
  }
  if (problems.length > 0) {
    throw new R2cError(
      'PAYLOAD_INVALID',
      `invalid payload entries:\n- ${problems.join('\n- ')}`,
      { problems },
      EXIT_CODES.INTERNAL,
    );
  }

  const blocks = [];
  for (const entry of sorted) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    blocks.push(tarHeader(entry.path, data.length), data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  const tar = Buffer.concat(blocks);
  const gz = gzipSync(tar, { level: 9 });
  gz.writeUInt32LE(0, 4); // gzip MTIME = 0 (RFC 1952 bytes 4..7)
  return gz;
}

/**
 * Read a ustar+gzip payload into memory.
 *
 * Returns `{ entries: [{path, data}], problems[] }`. PAX headers, GNU long
 * names, links and out-of-contract paths are reported, never materialised.
 */
export function readTarGz(buffer) {
  const entries = [];
  const problems = [];
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (error) {
    return { entries, problems: [`payload is not a gzip stream: ${error.message}`] };
  }

  let offset = 0;
  const seen = new Set();
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const sizeText = tarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText === '' ? '0' : sizeText, 8);
    const typeByte = header[156];
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
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
    if (path === '') {
      problems.push('tar entry has an empty path');
      continue;
    }
    const problem = payloadPathProblem(path);
    if (problem !== null) {
      problems.push(problem);
      continue;
    }
    if (seen.has(path)) {
      problems.push(`duplicate payload path: ${path}`);
      continue;
    }
    seen.add(path);
    entries.push({ path, data });
  }
  return { entries, problems };
}

/**
 * Compare an archive's members with the hashes declared in its manifest.
 *
 * `strict` also rejects members that the manifest does not declare (the
 * manifest itself is always implicit). Returns a failure list instead of
 * throwing so the installer can carry the details into its error envelope.
 */
export function verifyPluginFiles(manifest, entries, { strict = false } = {}) {
  const failures = [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry.data]));
  for (const rel of Object.keys(manifest.files).sort(comparePayloadPaths)) {
    const expected = manifest.files[rel];
    const data = byPath.get(rel);
    if (data === undefined) {
      failures.push({
        code: 'PAYLOAD_FILE_MISSING',
        message: `payload file is listed but missing: ${rel}`,
        file: rel,
        expected,
      });
      continue;
    }
    const actual = sha256(data);
    if (actual !== expected) {
      failures.push({
        code: 'PAYLOAD_HASH_MISMATCH',
        message: `payload file hash mismatch: ${rel}`,
        file: rel,
        expected,
        actual,
      });
    }
  }
  if (strict) {
    const declared = new Set([...Object.keys(manifest.files), PAYLOAD_MANIFEST]);
    for (const entry of entries) {
      if (declared.has(entry.path)) continue;
      failures.push({
        code: 'PAYLOAD_UNLISTED_FILE',
        message: `payload file is not declared in ${PAYLOAD_MANIFEST}: ${entry.path}`,
        file: entry.path,
      });
    }
  }
  return failures;
}
