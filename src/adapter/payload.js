/**
 * Payload resolution, verification and materialisation.
 *
 * Resolution order (#7 §1): `--from <dir>` > `R2C_PLUGIN_SOURCE` >
 * `~/.r2c/cache/payload-<V>` > GitHub Release download. A `--from` directory is
 * either an unpacked payload (it contains `r2c-payload.json`) or a source-tree
 * root (it contains `package.json`, `pack/` and `adapters/`); for a source tree
 * the payload version comes from `package.json` and the per-file hashes are
 * computed on the fly.
 *
 * Verification happens before anything is written under the project: a
 * mismatching `r2c-payload.json.files` entry aborts with exit 2 and zero
 * installed bytes.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { EXIT_CODES, R2cError } from '../errors.js';
import {
  PAYLOAD_MANIFEST,
  PLUGIN_SCHEMA,
  comparePayloadPaths,
  manifestBuffer,
  payloadAssetName,
  readTarGz,
  verifyPluginFiles,
} from '../plugin.js';
import { isValidRange, isValidVersion } from '../version.js';
import { which } from './detect.js';
import { stateDir } from './state.js';
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

export { PLUGIN_SCHEMA };
const RELEASE_REPO = 'hesl2636/RTOSv3_R2C_pipiline';
const RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases/download`;
const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}`;

/**
 * `R2C_RELEASE_BASE` overrides where assets come from (C1): a directory is a
 * flat local release (no fetch at all), an http(s) URL is a mirror shaped
 * `<base>/v<V>/<asset>` exactly like GitHub's `/releases/download/v<V>/`.
 */
function releaseBaseOverride() {
  const raw = process.env.R2C_RELEASE_BASE;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
}

function isHttpBase(base) {
  return /^https?:\/\//i.test(base);
}

/**
 * Anonymous downloads use the public web URL. Token downloads must go through
 * the REST API: GitHub answers the web download URL with `404` when the
 * repository is private and the request carries a bearer token, while the
 * asset endpoint (`Accept: application/octet-stream`) streams it. Both paths
 * name the same `r2c-payload-<V>.tgz` asset. A custom base is always direct.
 */
export function releaseEndpoints({ version, token = null, base = null }) {
  const name = payloadAssetName(version);
  if (typeof base === 'string' && base !== '') {
    const trimmed = base.replace(/\/+$/, '');
    return {
      kind: 'direct',
      name,
      archive: `${trimmed}/v${version}/${name}`,
      sums: `${trimmed}/v${version}/SHA256SUMS.txt`,
    };
  }
  if (token) {
    return {
      kind: 'api',
      name,
      release: `${RELEASE_API}/releases/tags/v${version}`,
      asset: (id) => `${RELEASE_API}/releases/assets/${id}`,
    };
  }
  return {
    kind: 'direct',
    name,
    archive: `${RELEASE_BASE}/v${version}/${name}`,
    sums: `${RELEASE_BASE}/v${version}/SHA256SUMS.txt`,
  };
}

function payloadError(code, message, details = null, exitCode = EXIT_CODES.USAGE) {
  return new R2cError(code, message, details, exitCode);
}

/**
 * `git credential fill` for github.com, never prompting: GIT_TERMINAL_PROMPT=0
 * plus a short timeout means an unattended download cannot hang on a password
 * prompt, it just finds no credential. `git` is resolved through PATH because
 * a Windows git may be a `.cmd` shim, which needs a shell to start.
 */
function gitCredentialToken() {
  const bin = which('git');
  if (bin === null) return null;
  const needsShell = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(bin).toLowerCase());
  const result = spawnSync(
    needsShell ? `"${bin}" credential fill` : bin,
    needsShell ? [] : ['credential', 'fill'],
    {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: needsShell,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const match = /^password=(.*)$/m.exec(result.stdout);
  return match === null || match[1] === '' ? null : match[1];
}

/**
 * Credential chain (C4): `GH_TOKEN` → `GITHUB_TOKEN` → `git credential fill`.
 * `source` names the winning entry so an authorization failure can point at the
 * credential the user has to fix; `null` means "anonymous".
 */
export function releaseCredential() {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') return { token: value, source: name };
  }
  const fromGit = gitCredentialToken();
  return fromGit === null ? { token: null, source: null } : { token: fromGit, source: 'git-credential' };
}

/**
 * Why an HTTP status means the credential is the problem. A private repository
 * answers `404` (not `401`) to an anonymous request, so "no token" plus `404`
 * is the one case that must ask for a token instead of reporting a missing
 * release.
 */
export function releaseAuthHint(status, credential) {
  const anonymous = credential.token === null;
  if (status === 401 || status === 403) {
    return `: ${anonymous ? 'the anonymous request' : credential.source} is not authorized for ${RELEASE_REPO}; run \`gh auth login\` or set GH_TOKEN with release read access`;
  }
  if (status === 404) {
    return anonymous
      ? `: HTTP 404 on a private repository means a token is required — set GH_TOKEN, set GITHUB_TOKEN, or store a github.com credential for \`git credential fill\` (run \`gh auth login\` where it is installed)`
      : `: HTTP 404 — the release tag or asset is absent, or ${credential.source} cannot see ${RELEASE_REPO}; run \`gh auth login\` or set a GH_TOKEN with contents:read`;
  }
  if (status === null && anonymous) {
    return `: no credential found — set GH_TOKEN, set GITHUB_TOKEN, or store a github.com credential for \`git credential fill\` (run \`gh auth login\` where it is installed)`;
  }
  return '';
}

function hintFrom() {
  return 'pass --from <payload-dir|payload.tgz> or set R2C_PLUGIN_SOURCE to an unpacked payload (a checkout containing package.json, pack/ and adapters/ works too)';
}

function parsePayloadManifest(text, file) {
  let manifest;
  try {
    manifest = JSON.parse(text);
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
  if (manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw payloadError('PAYLOAD_INVALID_MANIFEST', `${file} has no files map`, { file });
  }
  return manifest;
}

function readPayloadManifest(dir) {
  const file = join(dir, PAYLOAD_MANIFEST);
  if (!existsSync(file)) return null;
  return parsePayloadManifest(readFileSync(file, 'utf8'), file);
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
  entries.sort((left, right) => comparePayloadPaths(left.rel, right.rel));
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
  entries.sort((left, right) => comparePayloadPaths(left.rel, right.rel));
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

  const normalized = normalizedManifest(manifest, files);
  const manifestBytes = manifestBuffer(normalized);
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

function parseSums(text, assetName) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match !== null && basename(match[2]) === assetName) return match[1];
  }
  return null;
}

function normalizedManifest(manifest, files) {
  const sortedFiles = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => comparePayloadPaths(left, right)),
  );
  return {
    schema: PLUGIN_SCHEMA,
    version: manifest.version,
    engine: manifest.engine,
    ...Object.fromEntries(
      Object.entries(manifest).filter(
        ([key]) => !['schema', 'version', 'engine', 'files'].includes(key),
      ),
    ),
    files: sortedFiles,
  };
}

/** Extract the ustar+gzip payload contract (no symlinks, no PAX). */
export function extractTarGz(buffer, destination) {
  const { entries, problems } = readTarGz(buffer);
  if (problems.length > 0) {
    throw payloadError('PAYLOAD_INVALID_TAR', `invalid payload archive: ${problems[0]}`, {
      problems,
    });
  }
  for (const entry of entries) {
    const target = join(destination, ...entry.path.split('/'));
    if (!isInside(destination, target)) {
      throw payloadError('PAYLOAD_INVALID_TAR', `payload path escapes its root: ${entry.path}`, {
        name: entry.path,
      });
    }
    ensureDir(dirname(target));
    atomicWriteFile(target, entry.data);
  }
  return destination;
}

/**
 * Verify a `--from <tgz>` payload, then materialise it under
 * `~/.r2c/cache/payload-<V>` as a sibling directory renamed into place.
 *
 * Order is fail-closed and project-free: the sidecar checksum (when the
 * release's `SHA256SUMS.txt` sits next to the archive) covers the container,
 * and every `r2c-payload.json.files` hash covers the contents. Nothing is
 * extracted until both pass.
 */
function resolveTgzPayload(file, sourceLabel) {
  const asset = basename(file);
  const buffer = readFileSync(file);
  const sumsFile = join(dirname(file), 'SHA256SUMS.txt');
  if (existsSync(sumsFile)) {
    const actual = sha256(buffer);
    const expected = parseSums(readFileSync(sumsFile, 'utf8'), asset);
    if (expected === null || expected !== actual) {
      throw payloadError(
        'PAYLOAD_CHECKSUM_MISMATCH',
        expected === null
          ? `${sumsFile} has no entry for ${asset}`
          : `SHA256SUMS.txt mismatch for ${asset}`,
        { asset, expected, actual, sums: sumsFile },
      );
    }
  }

  const { entries, problems } = readTarGz(buffer);
  if (problems.length > 0) {
    throw payloadError('PAYLOAD_INVALID_TAR', `invalid payload archive: ${problems[0]}`, {
      file,
      problems,
    });
  }
  const manifestEntry = entries.find((entry) => entry.path === PAYLOAD_MANIFEST);
  if (manifestEntry === undefined) {
    throw payloadError('PAYLOAD_MANIFEST_MISSING', `${asset} does not contain ${PAYLOAD_MANIFEST}`, {
      file,
    });
  }
  const manifest = parsePayloadManifest(
    manifestEntry.data.toString('utf8'),
    `${asset}:${PAYLOAD_MANIFEST}`,
  );
  const failures = verifyPluginFiles(manifest, entries, { strict: true });
  if (failures.length > 0) {
    const first = failures[0];
    throw payloadError(first.code, first.message, { file: asset, failures });
  }

  const normalized = normalizedManifest(manifest, manifest.files);
  const manifestBytes = manifestBuffer(normalized);
  const home = cacheDir(normalized.version);
  const cached = join(home, PAYLOAD_MANIFEST);
  const cacheValid = existsSync(cached) && readFileSync(cached).equals(manifestBytes);
  if (!cacheValid) extractPayloadArchive(home, entries, manifestBytes);
  return resolveInspection(home, sourceLabel);
}

function extractPayloadArchive(home, entries, manifestBytes) {
  const temp = `${home}.tmp-${process.pid}-${Date.now().toString(36)}`;
  removePath(temp);
  ensureDir(temp);
  try {
    for (const entry of entries) {
      if (entry.path === PAYLOAD_MANIFEST) continue;
      const target = join(temp, ...entry.path.split('/'));
      if (!isInside(temp, target)) {
        throw payloadError('PAYLOAD_INVALID_TAR', `payload path escapes its root: ${entry.path}`, {
          name: entry.path,
        });
      }
      ensureDir(dirname(target));
      atomicWriteFile(target, entry.data);
    }
    atomicWriteFile(join(temp, PAYLOAD_MANIFEST), manifestBytes);
    ensureDir(dirname(home));
    if (existsSync(home)) {
      const backup = `${home}.old-${process.pid}-${Date.now().toString(36)}`;
      renameSync(home, backup);
      try {
        renameSync(temp, home);
      } catch (error) {
        renameSync(backup, home);
        throw error;
      }
      removePath(backup);
    } else {
      renameSync(temp, home);
    }
  } catch (error) {
    removePath(temp);
    throw error;
  }
}

/**
 * Read the payload from a local release directory (`R2C_RELEASE_BASE=<dir>`),
 * verifying it against the same `SHA256SUMS.txt` the release publishes. This
 * is the offline path: nothing is fetched and nothing is extracted before the
 * container digest matches.
 */
function downloadReleaseDir(version, base) {
  const dir = resolve(process.cwd(), base);
  const asset = payloadAssetName(version);
  const archivePath = join(dir, asset);
  const sumsPath = join(dir, 'SHA256SUMS.txt');
  const unavailable = (name, file) =>
    payloadError(
      'PAYLOAD_UNAVAILABLE',
      `release v${version} does not carry ${name}: ${file}; ${hintFrom()}`,
      { version, asset: name, base: dir },
    );
  if (!existsSync(archivePath)) throw unavailable(asset, archivePath);
  if (!existsSync(sumsPath)) throw unavailable('SHA256SUMS.txt', sumsPath);
  const archive = readFileSync(archivePath);
  const expected = parseSums(readFileSync(sumsPath, 'utf8'), asset);
  if (expected === null) {
    throw payloadError('PAYLOAD_CHECKSUM_MISMATCH', `${sumsPath} has no entry for ${asset}`, {
      asset,
      sums: sumsPath,
    });
  }
  const actual = sha256(archive);
  if (actual !== expected) {
    throw payloadError(
      'PAYLOAD_CHECKSUM_MISMATCH',
      `SHA256SUMS.txt mismatch for ${asset}`,
      { asset, expected, actual, sums: sumsPath },
      EXIT_CODES.GATE,
    );
  }
  return stageArchive(archive);
}

/** Extract a verified payload archive into a temp dir; the caller owns cleanup. */
function stageArchive(archive) {
  const temp = mkdtempSync(join(tmpdir(), 'r2c-payload-download-'));
  try {
    extractTarGz(archive, temp);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  // The archive may wrap everything in `r2c-payload-<V>/`.
  const children = readdirSync(temp).filter((name) => !name.startsWith('.'));
  if (children.length === 1) {
    const nested = join(temp, children[0]);
    if (statSync(nested).isDirectory() && existsSync(join(nested, PAYLOAD_MANIFEST))) {
      return { dir: nested, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
    }
  }
  return { dir: temp, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

async function downloadRelease(version) {
  const declared = releaseBaseOverride();
  // Spelling out the default base must not degrade the API path a token needs.
  const base = declared === RELEASE_BASE ? null : declared;
  if (base !== null && !isHttpBase(base)) return downloadReleaseDir(version, base);
  // The GitHub credential (env or `git credential fill`) is only for GitHub: a
  // custom mirror authenticates its own way and must not receive it.
  const credential = base === null ? releaseCredential() : { token: null, source: null };
  const token = credential.token;
  const authHint = (status) => (base === null ? releaseAuthHint(status, credential) : '');
  const headers = { 'user-agent': 'r2c-runner' };
  if (token) headers.authorization = `Bearer ${token}`;
  const endpoints = releaseEndpoints({ version, token, base });
  const asset = endpoints.name;

  const request = async (url, timeout, extra = null) => {
    try {
      return await fetch(url, {
        headers: extra === null ? headers : { ...headers, ...extra },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw payloadError(
        'PAYLOAD_UNAVAILABLE',
        `cannot reach the payload release v${version}: ${error.message}${authHint(null)}; ${hintFrom()}`,
        { version, url, token_source: credential.source },
      );
    }
  };

  let archiveUrl;
  let response;
  let sumsResponse;
  if (endpoints.kind === 'api') {
    const releaseResponse = await request(endpoints.release, 30_000, {
      accept: 'application/vnd.github+json',
    });
    if (!releaseResponse.ok) {
      throw payloadError(
        'PAYLOAD_UNAVAILABLE',
        `cannot read release v${version}: HTTP ${releaseResponse.status}${authHint(releaseResponse.status)}; ${hintFrom()}`,
        {
          version,
          url: endpoints.release,
          status: releaseResponse.status,
          token_source: credential.source,
        },
      );
    }
    const release = await releaseResponse.json().catch(() => null);
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const archiveAsset = assets.find((entry) => entry?.name === asset);
    const sumsAsset = assets.find((entry) => entry?.name === 'SHA256SUMS.txt');
    if (archiveAsset === undefined || sumsAsset === undefined) {
      const missing = archiveAsset === undefined ? asset : 'SHA256SUMS.txt';
      throw payloadError(
        'PAYLOAD_UNAVAILABLE',
        `release v${version} does not carry ${missing}; ${hintFrom()}`,
        { version, url: endpoints.release },
      );
    }
    archiveUrl = endpoints.asset(archiveAsset.id);
    response = await request(archiveUrl, 60_000, { accept: 'application/octet-stream' });
    sumsResponse = await request(endpoints.asset(sumsAsset.id), 30_000, {
      accept: 'application/octet-stream',
    });
  } else {
    archiveUrl = endpoints.archive;
    response = await request(archiveUrl, 60_000);
    sumsResponse = await request(endpoints.sums, 30_000);
  }

  if (!response.ok) {
    throw payloadError(
      'PAYLOAD_UNAVAILABLE',
      `cannot download ${asset}: HTTP ${response.status}${authHint(response.status)}; ${hintFrom()}`,
      { version, url: archiveUrl, status: response.status, token_source: credential.source },
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
  const expected = parseSums(await sumsResponse.text(), asset);
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
  return stageArchive(archive);
}

function cacheDir(version) {
  return join(userHome(), '.r2c', 'cache', `payload-${version}`);
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
      if (!/\.(tgz|tar\.gz)$/i.test(candidate.dir)) {
        throw payloadError(
          'PAYLOAD_FORMAT_UNSUPPORTED',
          `unsupported payload file (expected a .tgz archive): ${candidate.dir}`,
          { dir: candidate.dir },
        );
      }
      return resolveTgzPayload(candidate.dir, candidate.source);
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
  return join(stateDir(scope, projectRoot), 'payload', version);
}

export function payloadReady(home, resolved) {
  const manifest = join(home, PAYLOAD_MANIFEST);
  if (!existsSync(manifest)) return false;
  return sha256File(manifest) === resolved.sha256;
}

/**
 * Copy (or link, for `--link`) the verified payload into `<state>/payload/<V>/`.
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
    atomicWriteFile(join(temp, PAYLOAD_MANIFEST), resolved.manifestBytes);
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
