/**
 * Payload resolution, verification and materialisation.
 *
 * Resolution order (#7 §1): `--from <dir>` > `R2C_PLUGIN_SOURCE` >
 * `~/.r2c/cache/plugin-<V>` > GitHub Release download. A `--from` directory is
 * either an unpacked payload (it contains `r2c-plugin.json`) or a source-tree
 * root (it contains `package.json`, `pack/` and `adapters/`); for a source tree
 * the payload version comes from `package.json` and the per-file hashes are
 * computed on the fly.
 *
 * Verification happens before anything is written under the project: a
 * mismatching `r2c-plugin.json.files` entry aborts with exit 2 and zero
 * installed bytes.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { EXIT_CODES, R2cError } from '../errors.js';
import { isValidRange, isValidVersion } from '../version.js';
import {
  atomicWriteFile,
  createDirLink,
  ensureDir,
  isInside,
  listFiles,
  removePath,
  sha256,
  sha256File,
  toPosix,
  userHome,
} from './util.js';

export const PLUGIN_SCHEMA = 'r2c.plugin/v1';
const RELEASE_BASE = 'https://github.com/hesl2636/RTOSv3_R2C_pipiline/releases/download';

function payloadError(code, message, details = null, exitCode = EXIT_CODES.USAGE) {
  return new R2cError(code, message, details, exitCode);
}

function hintFrom() {
  return 'pass --from <payload-dir> or set R2C_PLUGIN_SOURCE to an unpacked payload (a checkout containing package.json, pack/ and adapters/ works too)';
}

function readPayloadManifest(dir) {
  const file = join(dir, 'r2c-plugin.json');
  if (!existsSync(file)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw payloadError('PAYLOAD_INVALID_JSON', `cannot parse ${file}: ${error.message}`, { file });
  }
  if (manifest?.schema !== PLUGIN_SCHEMA) {
    throw payloadError(
      'PAYLOAD_SCHEMA_UNSUPPORTED',
      `unsupported payload schema in ${file}: ${manifest?.schema}`,
      { file, supported: [PLUGIN_SCHEMA] },
    );
  }
  if (!isValidVersion(manifest.version)) {
    throw payloadError('PAYLOAD_INVALID_VERSION', `invalid payload version: ${manifest.version}`, {
      file,
    });
  }
  if (!isValidRange(manifest.engine)) {
    throw payloadError('PAYLOAD_INVALID_RANGE', `invalid payload engine range: ${manifest.engine}`, {
      file,
    });
  }
  return manifest;
}

function isSourceTree(dir) {
  return (
    existsSync(join(dir, 'package.json')) &&
    existsSync(join(dir, 'pack')) &&
    statSync(join(dir, 'pack')).isDirectory() &&
    existsSync(join(dir, 'adapters')) &&
    statSync(join(dir, 'adapters')).isDirectory()
  );
}

function collectPayloadDir(dir) {
  const entries = [];
  const skipped = new Set(['.git', 'node_modules']);
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push({ rel: toPosix(relative(dir, full)), abs: full });
    }
  };
  walk(dir);
  entries.sort((left, right) => left.rel.localeCompare(right.rel));
  const topDirs = {};
  for (const entry of entries) {
    const [first, ...rest] = entry.rel.split('/');
    if (rest.length > 0 && topDirs[first] === undefined) topDirs[first] = join(dir, first);
  }
  return { entries, topDirs };
}

function collectSourceTree(dir) {
  const entries = [];
  const topDirs = {};
  const addTree = (name, absolute) => {
    if (!existsSync(absolute)) return;
    if (!statSync(absolute).isDirectory()) return;
    topDirs[name] = absolute;
    for (const file of listFiles(absolute)) {
      entries.push({ rel: toPosix(`${name}/${relative(absolute, file)}`), abs: file });
    }
  };
  addTree('adapters', join(dir, 'adapters'));
  addTree('schema', join(dir, 'schema'));
  addTree('shims', join(dir, 'shims'));
  const pack = join(dir, 'pack');
  if (existsSync(pack)) {
    for (const name of readdirSync(pack)) {
      const absolute = join(pack, name);
      if (statSync(absolute).isDirectory()) addTree(name, absolute);
    }
  }
  for (const name of ['LICENSE']) {
    const absolute = join(dir, name);
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      entries.push({ rel: name, abs: absolute });
    }
  }
  entries.sort((left, right) => left.rel.localeCompare(right.rel));
  return { entries, topDirs };
}

function verifyDeclaredFiles(entries, files) {
  const byRel = new Map(entries.map((entry) => [entry.rel, entry.abs]));
  for (const [rel, expected] of Object.entries(files)) {
    const absolute = byRel.get(toPosix(rel));
    if (absolute === undefined) {
      throw payloadError('PAYLOAD_FILE_MISSING', `payload file is listed but missing: ${rel}`, {
        file: rel,
        expected,
      });
    }
    const actual = sha256File(absolute);
    if (actual !== expected) {
      throw payloadError(
        'PAYLOAD_HASH_MISMATCH',
        `payload file hash mismatch: ${rel}`,
        { file: rel, expected, actual },
      );
    }
  }
}

function resolveInspection(dir, sourceLabel) {
  const payloadManifest = readPayloadManifest(dir);
  let entries;
  let topDirs;
  let manifest;
  if (payloadManifest !== null) {
    ({ entries, topDirs } = collectPayloadDir(dir));
    manifest = { ...payloadManifest };
  } else if (isSourceTree(dir)) {
    ({ entries, topDirs } = collectSourceTree(dir));
    let version;
    try {
      version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    } catch (error) {
      throw payloadError('PAYLOAD_INVALID_JSON', `cannot read ${join(dir, 'package.json')}`, {
        file: join(dir, 'package.json'),
      });
    }
    if (!isValidVersion(version)) {
      throw payloadError('PAYLOAD_INVALID_VERSION', `invalid package version: ${version}`, {
        file: join(dir, 'package.json'),
      });
    }
    manifest = {
      schema: PLUGIN_SCHEMA,
      version,
      engine: `^${version}`,
      files: {},
    };
  } else {
    throw payloadError(
      'PAYLOAD_NOT_FOUND',
      `not a payload or source tree: ${dir}; ${hintFrom()}`,
      { dir },
    );
  }

  const declared = manifest.files !== null && typeof manifest.files === 'object' ? manifest.files : null;
  let files;
  if (declared !== null && Object.keys(declared).length > 0) {
    verifyDeclaredFiles(entries, declared);
    files = { ...declared };
  } else {
    files = {};
    for (const entry of entries) files[entry.rel] = sha256File(entry.abs);
  }

  const normalized = {
    schema: PLUGIN_SCHEMA,
    version: manifest.version,
    engine: manifest.engine,
    ...Object.fromEntries(Object.entries(manifest).filter(([key]) => !['schema', 'version', 'engine', 'files'].includes(key))),
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return {
    kind: 'dir',
    root: dir,
    entries,
    topDirs,
    manifest: normalized,
    manifestBytes,
    sha256: sha256(manifestBytes),
    source: sourceLabel,
  };
}

function parseSums(text, version) {
  const asset = `r2c-plugin-${version}.tgz`;
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match !== null && basename(match[2]) === asset) return match[1];
  }
  return null;
}

function readTarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

/** Extract the ustar+gzip payload contract (no symlinks, no PAX). */
export function extractTarGz(buffer, destination) {
  const tar = gunzipSync(buffer);
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    if (prefix !== '') name = `${prefix}/${name}`;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    offset += 512;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if (name === '') continue;
    const normalized = toPosix(name);
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw payloadError('PAYLOAD_INVALID_TAR', `unsafe path in payload archive: ${name}`, { name });
    }
    const target = join(destination, ...normalized.split('/'));
    if (!isInside(destination, target)) {
      throw payloadError('PAYLOAD_INVALID_TAR', `payload path escapes its root: ${name}`, { name });
    }
    if (type === '5') {
      ensureDir(target);
    } else if (type === '0') {
      ensureDir(dirname(target));
      atomicWriteBuffer(target, data);
    } else if (type === 'x' || type === 'g') {
      continue;
    } else {
      throw payloadError('PAYLOAD_INVALID_TAR', `unsupported tar entry type "${type}": ${name}`, {
        name,
        type,
      });
    }
  }
  return destination;
}

function atomicWriteBuffer(file, data) {
  ensureDir(dirname(file));
  const temp = join(dirname(file), `.${basename(file)}.r2c-tmp-${process.pid}`);
  readFileSyncWrite(temp, data);
  try {
    // Reuse the atomic rename helper without exporting another primitive.
    const { atomicWriteFile } = requireUtil();
    atomicWriteFile(file, data);
    rmSync(temp, { force: true });
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readFileSyncWrite(file, data) {
  // Kept separate so the temp write is always followed by an atomic rename.
  const { writeFileSync } = requireFs();
  writeFileSync(file, data);
}

import { writeFileSync } from 'node:fs';
import * as utilModule from './util.js';

function requireUtil() {
  return utilModule;
}

function requireFs() {
  return { writeFileSync };
}

async function downloadRelease(version) {
  const asset = `r2c-plugin-${version}.tgz`;
  const base = `${RELEASE_BASE}/v${version}`;
  const headers = { 'user-agent': 'r2c-runner' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  let sumsResponse;
  try {
    response = await fetch(`${base}/${asset}`, { headers, signal: AbortSignal.timeout(60_000) });
    sumsResponse = await fetch(`${base}/SHA256SUMS.txt`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw payloadError(
      'PAYLOAD_UNAVAILABLE',
      `cannot reach the payload release v${version}: ${error.message}; ${hintFrom()}`,
      { version, url: `${base}/${asset}` },
    );
  }
  if (!response.ok) {
    const authHint = token ? '' : ' (the release repository is private; set GITHUB_TOKEN)';
    throw payloadError(
      'PAYLOAD_UNAVAILABLE',
      `cannot download ${asset}: HTTP ${response.status}${authHint}; ${hintFrom()}`,
      { version, url: `${base}/${asset}`, status: response.status },
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (!sumsResponse.ok) {
    throw payloadError(
      'PAYLOAD_UNAVAILABLE',
      `cannot download SHA256SUMS.txt: HTTP ${sumsResponse.status}; ${hintFrom()}`,
      { version, status: sumsResponse.status },
    );
  }
  const expected = parseSums(await sumsResponse.text(), version);
  if (expected === null) {
    throw payloadError('PAYLOAD_CHECKSUM_MISMATCH', `SHA256SUMS.txt has no entry for ${asset}`, {
      asset,
    });
  }
  const actual = sha256(archive);
  if (actual !== expected) {
    throw payloadError(
      'PAYLOAD_CHECKSUM_MISMATCH',
      `SHA256SUMS.txt mismatch for ${asset}`,
      { asset, expected, actual },
      EXIT_CODES.GATE,
    );
  }
  const temp = mkdtempSync(join(tmpdir(), 'r2c-plugin-download-'));
  try {
    extractTarGz(archive, temp);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  // The archive may wrap everything in `r2c-plugin-<V>/`.
  const children = readdirSync(temp).filter((name) => !name.startsWith('.'));
  if (children.length === 1) {
    const nested = join(temp, children[0]);
    if (statSync(nested).isDirectory() && existsSync(join(nested, 'r2c-plugin.json'))) {
      return { dir: nested, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
    }
  }
  return { dir: temp, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

function cacheDir(version) {
  return join(userHome(), '.r2c', 'cache', `plugin-${version}`);
}

function pluginStateDir(scope, projectRoot) {
  return scope === 'user' ? join(userHome(), '.r2c') : join(projectRoot, '.r2c');
}

/**
 * Resolve the payload for `version`, verify it, and return an inspection that
 * is safe to plan from. No file is written under the project at this point.
 */
export async function resolvePayload({ from = null, pluginVersion = null, projectRoot, engineVersion }) {
  const version = pluginVersion || engineVersion;
  const candidates = [];
  if (from !== null) candidates.push({ dir: resolve(process.cwd(), from), source: `from:${from}` });
  if (process.env.R2C_PLUGIN_SOURCE) {
    candidates.push({
      dir: resolve(process.cwd(), process.env.R2C_PLUGIN_SOURCE),
      source: `env:${process.env.R2C_PLUGIN_SOURCE}`,
    });
  }
  candidates.push({ dir: cacheDir(version), source: `cache:${cacheDir(version)}` });

  for (const candidate of candidates) {
    if (!existsSync(candidate.dir)) {
      if (candidate.source.startsWith('from:')) {
        throw payloadError('PAYLOAD_NOT_FOUND', `payload directory does not exist: ${candidate.dir}`, {
          dir: candidate.dir,
        });
      }
      continue;
    }
    if (statSync(candidate.dir).isFile()) {
      throw payloadError(
        'PAYLOAD_FORMAT_UNSUPPORTED',
        `tgz payloads are installed by the release packager; pass an unpacked directory: ${candidate.dir}`,
        { dir: candidate.dir },
      );
    }
    return resolveInspection(candidate.dir, candidate.source);
  }

  const downloaded = await downloadRelease(version);
  try {
    const inspection = resolveInspection(downloaded.dir, `release:v${version}`);
    inspection.cleanup = downloaded.cleanup;
    return inspection;
  } catch (error) {
    downloaded.cleanup();
    throw error;
  }
}

export function payloadHome(scope, projectRoot, version) {
  return join(pluginStateDir(scope, projectRoot), 'plugin', version);
}

export function payloadReady(home, resolved) {
  const manifest = join(home, 'r2c-plugin.json');
  if (!existsSync(manifest)) return false;
  return sha256File(manifest) === resolved.sha256;
}

/**
 * Copy (or link, for `--link`) the verified payload into `<state>/plugin/<V>/`.
 * The directory is assembled as a sibling temp directory and renamed into
 * place, so an interrupted install never leaves a half payload under a live
 * version path.
 */
export function materializePayload(resolved, home, { mode = 'copy' } = {}) {
  if (payloadReady(home, resolved)) return { created: false, dirs: [], links: [] };
  const created = [];
  ensureDir(dirname(home), created);
  const temp = `${home}.tmp-${process.pid}-${Date.now().toString(36)}`;
  removePath(temp);
  ensureDir(temp);
  try {
    for (const entry of resolved.entries) {
      if (mode === 'link' && !entry.rel.includes('/')) {
        atomicWriteBufferFrom(join(temp, ...entry.rel.split('/')), readFileSync(entry.abs));
        continue;
      }
      if (mode === 'link') continue;
      const target = join(temp, ...entry.rel.split('/'));
      ensureDir(dirname(target));
      atomicWriteBufferFrom(target, readFileSync(entry.abs));
    }
    if (mode === 'link') {
      for (const [name, absolute] of Object.entries(resolved.topDirs)) {
        const link = join(temp, name);
        try {
          deleteLink(link);
          createDirLinkSafe(link, absolute);
        } catch (error) {
          throw payloadError(
            'LINK_UNSUPPORTED',
            `cannot create directory link ${link} -> ${absolute}: ${error.message}; rerun with --copy`,
            { path: link, target: absolute },
          );
        }
      }
    }
    atomicWriteFile(join(temp, 'r2c-plugin.json'), resolved.manifestBytes);
    removePath(home);
    renameDir(temp, home);
    return { created: true, dirs: [...created, home], links: mode === 'link' };
  } catch (error) {
    removePath(temp);
    throw error;
  }
}

function atomicWriteBufferFrom(file, data) {
  atomicWriteFile(file, data);
}

function deleteLink(path) {
  rmSync(path, { recursive: true, force: true });
}

function createDirLinkSafe(link, target) {
  createDirLink(link, target);
}

function renameDir(from, to) {
  renameSync(from, to);
}
