#!/usr/bin/env node
/**
 * r2c bootstrap: one command from a release page to a working project.
 *
 * Downloads `r2c-engine-<V>.tgz`, verifies it against the release's
 * `SHA256SUMS.txt`, extracts it to `<project>/.r2c/engine/<V>/` (or
 * `~/.r2c/engine/<V>/` with `--scope user`), then hands over to that engine's
 * own `adapter install` — the payload is resolved by the engine, never here.
 *
 * Self-contained by design: node built-ins only (plus the global `fetch`), no
 * imports from `src/`, so this file runs both from the repository and as the
 * `install.mjs` release asset.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const RELEASE_REPO = 'hesl2636/RTOSv3_R2C_pipiline';
const DEFAULT_RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases/download`;
const GITHUB_API = `https://api.github.com`;
const SUMS_ASSET = 'SHA256SUMS.txt';
const BLOCK = 512;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SCOPES = Object.freeze(['project', 'user']);
const AUTH_HINT =
  'authentication: set GH_TOKEN, set GITHUB_TOKEN, or store a github.com credential for `git credential fill` (for example `gh auth login`)';

const USAGE = `Usage: node install.mjs --agent <id> [--version <V>] [--scope project|user]
                        [--project <dir>] [--release-base <dir|url>]

Downloads r2c-engine-<V>.tgz, verifies it against the release's
SHA256SUMS.txt, installs it under <project>/.r2c/engine/<V>/ (or
~/.r2c/engine/<V>/ with --scope user), then runs
"node <engine>/bin/r2c.js adapter install <id>".

  --agent <id>          Agent adapter to install (claude-code, codex, dsh,
                        omp, opencode).
  --version <V>         Engine and payload version. Default: the latest formal
                        GitHub release.
  --scope <scope>       project (default) or user.
  --project <dir>       Project root (default: the current directory).
  --release-base <src>  A directory of flat release assets or an http(s)
                        mirror shaped <base>/v<V>/<asset> (also
                        R2C_RELEASE_BASE).

Exit codes: 0 ok, 1 download or asset failure, 2 usage, 3 checksum failure.
`;

const VALUE_FLAGS = new Set(['--agent', '--version', '--scope', '--project', '--release-base']);

class BootstrapError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 1) {
  throw new BootstrapError(code, message, exitCode);
}

function parseArgs(argv) {
  const options = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!VALUE_FLAGS.has(name)) fail('USAGE', `unknown argument: ${arg}\n${USAGE}`, 2);
    let value = equals === -1 ? undefined : arg.slice(equals + 1);
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('USAGE', `${name} requires a value\n${USAGE}`, 2);
      }
      index += 1;
    }
    if (value === '') fail('USAGE', `${name} requires a value\n${USAGE}`, 2);
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }

  if (options.help) return options;
  if (options.agent === undefined) fail('USAGE', `--agent <id> is required\n${USAGE}`, 2);
  if (options.scope !== undefined && !SCOPES.includes(options.scope)) {
    fail('USAGE', `--scope must be one of ${SCOPES.join(', ')}: ${options.scope}\n${USAGE}`, 2);
  }
  if (options.version !== undefined && !VERSION_RE.test(options.version)) {
    fail('USAGE', `--version is not a semantic version: ${options.version}\n${USAGE}`, 2);
  }
  return options;
}

/** `R2C_HOME` first, exactly like the engine's own `userHome()`. */
function userHome() {
  return process.env.R2C_HOME || process.env.HOME || process.env.USERPROFILE || homedir();
}

/** A directory of flat assets, or an http(s) mirror (`<base>/v<V>/<asset>`). */
function releaseSource(raw) {
  const value = String(raw).trim();
  if (/^https?:\/\//i.test(value)) {
    const base = value.replace(/\/+$/, '');
    return { kind: 'url', base, github: base === DEFAULT_RELEASE_BASE };
  }
  return { kind: 'dir', dir: resolve(value) };
}

function bearer(token) {
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

/**
 * Credential order (C4): `GH_TOKEN` → `GITHUB_TOKEN` → `git credential fill`.
 * The helper call never prompts, so an unattended install cannot hang.
 */
function authToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const match = /^password=(.*)$/m.exec(result.stdout);
  return match === null || match[1] === '' ? null : match[1];
}

async function request(url, timeout, headers) {
  try {
    return await fetch(url, {
      headers: { 'user-agent': 'r2c-install', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    fail(
      'ENGINE_DOWNLOAD_FAILED',
      `cannot reach ${url}: ${error.message}\navailable ${AUTH_HINT}`,
      1,
    );
  }
}

function assetMissing(name, version, where) {
  return new BootstrapError(
    'ENGINE_ASSET_MISSING',
    `release v${version} does not carry ${name}: ${where}\navailable ${AUTH_HINT}`,
    1,
  );
}

/** Read `name` from the release: a local file, a mirror URL, or the GitHub API. */
async function fetchAsset(source, version, name) {
  if (source.kind === 'dir') {
    const file = join(source.dir, name);
    if (!existsSync(file)) throw assetMissing(name, version, file);
    return readFileSync(file);
  }

  const token = authToken();
  if (source.github && token !== null) {
    const releaseUrl = `${GITHUB_API}/repos/${RELEASE_REPO}/releases/tags/v${version}`;
    const release = await request(releaseUrl, 30_000, {
      ...bearer(token),
      accept: 'application/vnd.github+json',
    });
    if (!release.ok) throw assetMissing(name, version, `${releaseUrl} (HTTP ${release.status})`);
    const body = await release.json().catch(() => null);
    const assets = Array.isArray(body?.assets) ? body.assets : [];
    const found = assets.find((entry) => entry?.name === name);
    if (found === undefined) throw assetMissing(name, version, releaseUrl);
    const url = `${GITHUB_API}/repos/${RELEASE_REPO}/releases/assets/${found.id}`;
    const asset = await request(url, 60_000, {
      ...bearer(token),
      accept: 'application/octet-stream',
    });
    if (!asset.ok) throw assetMissing(name, version, `${url} (HTTP ${asset.status})`);
    return Buffer.from(await asset.arrayBuffer());
  }

  const url = `${source.base}/v${version}/${name}`;
  const response = await request(url, 60_000, bearer(token));
  if (!response.ok) throw assetMissing(name, version, `${url} (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function latestVersion(source) {
  if (source.kind === 'dir') {
    fail(
      'USAGE',
      `--version <V> is required when --release-base is a directory (${source.dir}): a local mirror carries no latest-release metadata`,
      2,
    );
  }
  if (!source.github) {
    fail(
      'USAGE',
      `--version <V> is required with --release-base ${source.base}: only the default GitHub release base resolves the latest version`,
      2,
    );
  }
  const token = authToken();
  const url = `${GITHUB_API}/repos/${RELEASE_REPO}/releases/latest`;
  const response = await request(url, 30_000, {
    ...bearer(token),
    accept: 'application/vnd.github+json',
  });
  if (!response.ok) {
    fail(
      'ENGINE_VERSION_UNRESOLVED',
      `cannot resolve the latest release of ${RELEASE_REPO}: HTTP ${response.status}; pass --version <V>\navailable ${AUTH_HINT}`,
      1,
    );
  }
  const body = await response.json().catch(() => null);
  const tag = typeof body?.tag_name === 'string' ? body.tag_name : '';
  const match = /^v(.+)$/.exec(tag);
  if (match === null || !VERSION_RE.test(match[1])) {
    fail(
      'ENGINE_VERSION_UNRESOLVED',
      `latest release tag is not v<semver>: ${tag === '' ? '(none)' : tag}; pass --version <V>`,
      1,
    );
  }
  return match[1];
}

function digestFor(sumsText, assetName) {
  for (const line of sumsText.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match !== null && match[2].replace(/^\.\//, '') === assetName) return match[1];
  }
  return null;
}

function tarString(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

function archivePathProblem(path) {
  if (path === '') return 'engine archive entry has an empty path';
  if (path.startsWith('/') || path.includes('\\')) {
    return `engine archive path must be relative and POSIX: ${path}`;
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `engine archive path is not canonical: ${path}`;
  }
  return null;
}

/** Read a ustar+gzip archive into memory; anything outside the contract fails. */
function readTarGz(buffer) {
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (error) {
    fail('ENGINE_INVALID_ARCHIVE', `engine archive is not a gzip stream: ${error.message}`, 3);
  }
  const entries = [];
  const seen = new Set();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const size = Number.parseInt(tarString(header, 124, 12).trim() || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    offset += BLOCK;
    if (!Number.isFinite(size) || size < 0) {
      fail('ENGINE_INVALID_ARCHIVE', `invalid tar entry size for ${path || '(unnamed)'}`, 3);
    }
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    if (type === '5') continue;
    if (type !== '0') {
      fail('ENGINE_INVALID_ARCHIVE', `unsupported tar entry type "${type}": ${path}`, 3);
    }
    const problem = archivePathProblem(path);
    if (problem !== null) fail('ENGINE_INVALID_ARCHIVE', problem, 3);
    if (seen.has(path)) fail('ENGINE_INVALID_ARCHIVE', `duplicate engine archive path: ${path}`, 3);
    seen.add(path);
    entries.push({ path, data });
  }
  if (entries.length === 0) fail('ENGINE_INVALID_ARCHIVE', 'engine archive is empty', 3);
  return entries;
}

/** Extract into a sibling temp directory, then rename it into place. */
function installEngine(archive, engineHome) {
  const entries = readTarGz(archive);
  const parent = dirname(engineHome);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.tmp-${process.pid}-${Date.now().toString(36)}`);
  rmSync(temp, { recursive: true, force: true });
  try {
    mkdirSync(temp, { recursive: true });
    for (const entry of entries) {
      const target = join(temp, ...entry.path.split('/'));
      const rel = relative(temp, target);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        fail('ENGINE_INVALID_ARCHIVE', `engine archive path escapes its root: ${entry.path}`, 3);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
    }
    if (existsSync(engineHome)) {
      const backup = `${engineHome}.old-${process.pid}-${Date.now().toString(36)}`;
      renameSync(engineHome, backup);
      try {
        renameSync(temp, engineHome);
      } catch (error) {
        renameSync(backup, engineHome);
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
    } else {
      renameSync(temp, engineHome);
    }
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function engineReady(engineHome, version) {
  if (!existsSync(join(engineHome, 'bin', 'r2c.js'))) return false;
  try {
    return JSON.parse(readFileSync(join(engineHome, 'package.json'), 'utf8'))?.version === version;
  } catch {
    return false;
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const projectDir = resolve(options.project ?? process.cwd());
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    fail('USAGE', `--project is not a directory: ${projectDir}`, 2);
  }
  const scope = options.scope ?? 'project';

  const explicitBase = options.releaseBase ?? process.env.R2C_RELEASE_BASE ?? null;
  const source = releaseSource(explicitBase === null ? DEFAULT_RELEASE_BASE : explicitBase);
  const version = options.version ?? (await latestVersion(source));
  const engineHome = join(scope === 'user' ? userHome() : projectDir, '.r2c', 'engine', version);

  // Same version already in place: re-running writes nothing and fetches nothing.
  if (engineReady(engineHome, version)) {
    process.stdout.write(`engine ${version} already at ${engineHome}\n`);
  } else {
    const assetName = `r2c-engine-${version}.tgz`;
    const sums = await fetchAsset(source, version, SUMS_ASSET);
    const expected = digestFor(sums.toString('utf8'), assetName);
    if (expected === null) {
      throw assetMissing(assetName, version, `${SUMS_ASSET} lists no entry for it`);
    }
    const archive = await fetchAsset(source, version, assetName);
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== expected) {
      fail(
        'ENGINE_CHECKSUM_MISMATCH',
        `${assetName} sha256 mismatch for v${version}: SHA256SUMS.txt says ${expected}, the download is ${actual}; nothing was written`,
        3,
      );
    }
    installEngine(archive, engineHome);
    process.stdout.write(`engine ${version}: ${engineHome}\n`);
  }

  const entry = join(engineHome, 'bin', 'r2c.js');
  const env = { ...process.env };
  if (explicitBase !== null) {
    env.R2C_RELEASE_BASE = source.kind === 'dir' ? source.dir : source.base;
  }
  const child = spawnSync(
    process.execPath,
    [entry, 'adapter', 'install', options.agent, '--engine', engineHome, '--scope', scope, '--project', projectDir],
    { cwd: projectDir, env, stdio: 'inherit' },
  );
  if (child.error) {
    fail('ENGINE_SPAWN_FAILED', `cannot run ${entry}: ${child.error.message}`, 1);
  }
  if (child.status !== 0) {
    fail(
      'ADAPTER_INSTALL_FAILED',
      `adapter install ${options.agent} failed with exit ${child.status ?? 'signal'}`,
      typeof child.status === 'number' && child.status !== 0 ? child.status : 1,
    );
  }

  const next = [`node "${entry}"`, 'run'];
  if (projectDir !== resolve(process.cwd())) next.push('--project', `"${projectDir}"`);
  process.stdout.write(`next: ${next.join(' ')}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof BootstrapError) {
      process.stderr.write(`install: ${error.code}: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`install: INTERNAL: ${detail}\n`);
    process.exitCode = 1;
  },
);
