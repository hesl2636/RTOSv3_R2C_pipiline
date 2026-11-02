#!/usr/bin/env node
/**
 * r2c bootstrap: one command from a release page to a working project.
 *
 * Downloads `r2c-engine-<V>.tgz`, verifies it against the release's
 * `SHA256SUMS.txt`, extracts it to `<project>/.r2c/engine/<V>/` (or
 * `~/.r2c/engine/<V>/` with `--scope user`), then hands over to that engine's
 * own `adapter install` — the payload is resolved by the engine, never here.
 * Both stages are all-or-nothing: a checksum failure writes nothing, and a
 * failed hand-off (a tampered or missing payload asset, a conflict, a broken
 * agent config) removes the engine this run extracted.
 *
 * The per-bundle channel (#106, decision #74 §9) runs `--bundle <id>`
 * instead: it downloads the bundle Release's assets, verifies the three-way
 * asset/zip/IR/payload chain, unpacks the Release's framework archive to a
 * temporary directory and hands the verified bytes to that framework's
 * installer. It never compiles a bundle and never projects one.
 *
 * Self-contained by design: node built-ins only (plus the global `fetch`), no
 * imports from `src/`, so this file runs both from the repository and as the
 * `install.mjs` release asset. The bundle path imports only the framework
 * archive it just verified.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const RELEASE_REPO = 'hesl2636/hm2B_drvport_pipiline';
const DEFAULT_RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases/download`;
const GITHUB_API = `https://api.github.com`;
const SUMS_ASSET = 'SHA256SUMS.txt';
const IR_ASSET = 'workflow.ir.json';
const INSTALL_ASSET = 'install.mjs';
const PROJECTIONS = Object.freeze(['r2c', 'agent-native']);
const BUNDLE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUNDLE_ID_MAX = 40;
const FRAMEWORK_ASSET_RE = /^r2c-framework-(.+).tgz$/;
const ENGINE_ASSET_RE = /^r2c-engine-(.+).tgz$/;
/** Mirrors `ENGINE_ENTRY` in `src/engine.js`; the bootstrap may not import `src/` (C5). */
const ENGINE_ENTRY = 'bin/r2c.js';
const BLOCK = 512;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SCOPES = Object.freeze(['project', 'user']);
/**
 * `engines.node` from package.json, mirrored from `src/cli.js` because the
 * bootstrap may not import `src/` (C5). Checked before anything is fetched:
 * an unsupported Node would otherwise download and extract an engine it cannot
 * run, only to hand off into a child that refuses to start.
 */
export const NODE_RANGE = '>=22.19.0 <23 || >=24.0.0';
/** The archive path bound `plugin.js`/`engine.js` enforce for every asset. */
const MAX_PATH_BYTES = 100;

/** True when `version` (as reported by process.versions.node) is in NODE_RANGE. */
export function nodeSupported(version) {
  const [major, minor] = String(version).split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major === 22) return minor >= 19;
  return major >= 24;
}
const AUTH_HINT =
  'set GH_TOKEN, set GITHUB_TOKEN, or store a github.com credential for `git credential fill` (run `gh auth login` where it is installed)';

/** Why an HTTP status means the credential is the problem (private repo = 404). */
function credentialHint(status, credential) {
  if (status === 401 || status === 403) {
    const who = credential.token === null ? 'the anonymous request' : credential.source;
    return `: ${who} is not authorized for ${RELEASE_REPO}; run \`gh auth login\` or set GH_TOKEN with release read access`;
  }
  if (status === 404) {
    return credential.token === null
      ? `: HTTP 404 on a private repository means a token is required — ${AUTH_HINT}`
      : `: HTTP 404 — the tag or asset is absent, or ${credential.source} cannot see ${RELEASE_REPO}; run \`gh auth login\``;
  }
  return '';
}

/**
 * A missing asset: a `404`/`401`/`403` names the credential story, anything
 * else (or a local directory without the file) just says what is missing.
 */
export function assetUnavailable(name, version, where, { status = null, credential = null } = {}) {
  const hint = credential === null ? '' : credentialHint(status, credential);
  const anonymousPrivate = credential?.token === null && (status === 401 || status === 403 || status === 404);
  return new BootstrapError(
    anonymousPrivate ? 'ENGINE_AUTH_REQUIRED' : 'ENGINE_ASSET_MISSING',
    hint === ''
      ? `release v${version} does not carry ${name}: ${where}\navailable authentication: ${AUTH_HINT}`
      : `cannot read ${name} from release v${version}: ${where}${hint}`,
    1,
  );
}

const USAGE = `Usage: node install.mjs --agent <id> [--version <V>] [--scope project|user]
                        [--project <dir>] [--release-base <dir|url>]
                        [--profile <name>] [--force]
       node install.mjs --bundle <id> [--version <V>]
                        --projection r2c|agent-native [--target <t>]...
                        [--project <dir>] [--release-base <dir|url>] [--force]

Downloads a bundle Release's assets, verifies them against its
SHA256SUMS.txt, checks the zip / IR / payload manifest against each other,
then installs the pre-projected payload — never compiling or projecting.

  --bundle <id>         Bundle id of the Release (tag bundle-<id>-v<V>).
  --projection <id>     r2c or agent-native; required when the bundle allows
                        both, otherwise the single allowed projection.
  --target <t>          agent-native target to write (repeatable). The payload
                        is not re-projected; roles.json is still installed.
  --version <V>         Release version. Default: the latest published
                        bundle-<id> tag (requires the GitHub API).

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
  --profile <name>      Agent profile forwarded to "adapter install" (dsh:
                        default "web"; other adapters ignore it).
  --force               Forward "adapter install --force": back up and replace
                        files another install owns, which is what adding a
                        second adapter to one project needs.

Exit codes: 0 ok, 1 download or asset failure, 2 usage (including an
unsupported Node), 3 archive or checksum failure. A failing hand-off keeps the
engine's own status (2 usage, 3 gate, 4 not detected/not installed, 5 lock
conflict) instead of 1.
`;

const VALUE_FLAGS = new Set([
  '--agent', '--version', '--scope', '--project', '--release-base', '--profile',
  '--bundle', '--projection', '--target',
]);
const FLAG_FLAGS = new Set(['--force']);

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
    if (FLAG_FLAGS.has(arg)) {
      options[arg.slice(2)] = true;
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
    if (name === '--target') {
      options.targets = [...(options.targets ?? []), value];
      continue;
    }
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }

  if (options.help) return options;
  if (options.version !== undefined && !VERSION_RE.test(options.version)) {
    fail('USAGE', `--version is not a semantic version: ${options.version}\n${USAGE}`, 2);
  }
  if (options.scope !== undefined && !SCOPES.includes(options.scope)) {
    fail('USAGE', `--scope must be one of ${SCOPES.join(', ')}: ${options.scope}\n${USAGE}`, 2);
  }

  if (options.bundle === undefined) {
    if (options.agent === undefined) fail('USAGE', `--agent <id> is required\n${USAGE}`, 2);
    if (options.projection !== undefined) {
      fail('RELEASE_OPTION_CONFLICT', '--projection belongs to the --bundle channel, not to --agent', 2);
    }
    if (options.targets !== undefined) {
      fail('RELEASE_OPTION_CONFLICT', '--target belongs to the --bundle channel, not to --agent', 2);
    }
    return options;
  }

  // Bundle channel: the two CLIs are mutually exclusive, and a bundle install
  // root is always the project (decision #76 §2.1).
  if (options.agent !== undefined) {
    fail('RELEASE_OPTION_CONFLICT', '--bundle and --agent are mutually exclusive; pick one channel', 2);
  }
  if (!BUNDLE_ID_RE.test(options.bundle) || options.bundle.length > BUNDLE_ID_MAX) {
    fail('USAGE', `--bundle must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (max ${BUNDLE_ID_MAX}): ${options.bundle}\n${USAGE}`, 2);
  }
  if (options.projection !== undefined && !PROJECTIONS.includes(options.projection)) {
    fail('USAGE', `--projection must be one of ${PROJECTIONS.join(', ')}: ${options.projection}\n${USAGE}`, 2);
  }
  if (options.scope !== undefined && options.scope !== 'project') {
    fail('RELEASE_OPTION_CONFLICT', '--scope user belongs to the legacy --agent channel; a bundle installs into --project', 2);
  }
  if (options.profile !== undefined) {
    fail('RELEASE_OPTION_CONFLICT', '--profile belongs to "adapter install", not to a bundle Release', 2);
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
 * Resolve `git` through PATH with Windows PATHEXT, exactly like the engine's
 * `which()`: a Windows git may be a `.cmd` shim, which needs a shell to start.
 */
function gitBinary() {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir === '') continue;
    for (const extension of extensions) {
      const candidate = join(dir, `git${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * Credential order (C4): `GH_TOKEN` → `GITHUB_TOKEN` → `git credential fill`.
 * The helper call never prompts, so an unattended install cannot hang; `source`
 * names the entry that won so a 403/404 can point at the credential to fix.
 */
export function authCredential() {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') return { token: value, source: name };
  }
  const bin = gitBinary();
  if (bin === null) return { token: null, source: null };
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
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return { token: null, source: null };
  }
  const match = /^password=(.*)$/m.exec(result.stdout);
  return match === null || match[1] === ''
    ? { token: null, source: null }
    : { token: match[1], source: 'git-credential' };
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

/** Read `name` from the release: a local file, a mirror URL, or the GitHub API. */
async function fetchAsset(source, version, name) {
  if (source.kind === 'dir') {
    const file = join(source.dir, name);
    if (!existsSync(file)) throw assetUnavailable(name, version, file);
    return readFileSync(file);
  }

  // The credential chain is GitHub's; a custom mirror authenticates its own way.
  const credential = source.github ? authCredential() : null;
  if (credential !== null && credential.token !== null) {
    const releaseUrl = `${GITHUB_API}/repos/${RELEASE_REPO}/releases/tags/v${version}`;
    const release = await request(releaseUrl, 30_000, {
      ...bearer(credential.token),
      accept: 'application/vnd.github+json',
    });
    if (!release.ok) {
      throw assetUnavailable(name, version, releaseUrl, {
        status: release.status,
        credential,
      });
    }
    const body = await release.json().catch(() => null);
    const assets = Array.isArray(body?.assets) ? body.assets : [];
    const found = assets.find((entry) => entry?.name === name);
    if (found === undefined) throw assetUnavailable(name, version, releaseUrl);
    const url = `${GITHUB_API}/repos/${RELEASE_REPO}/releases/assets/${found.id}`;
    const asset = await request(url, 60_000, {
      ...bearer(credential.token),
      accept: 'application/octet-stream',
    });
    if (!asset.ok) throw assetUnavailable(name, version, url, { status: asset.status, credential });
    return Buffer.from(await asset.arrayBuffer());
  }

  const url = `${source.base}/v${version}/${name}`;
  const response = await request(url, 60_000, credential === null ? {} : bearer(credential.token));
  if (!response.ok) {
    throw assetUnavailable(name, version, url, { status: response.status, credential });
  }
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
  const credential = authCredential();
  const url = `${GITHUB_API}/repos/${RELEASE_REPO}/releases/latest`;
  const response = await request(url, 30_000, {
    ...bearer(credential.token),
    accept: 'application/vnd.github+json',
  });
  if (!response.ok) {
    fail(
      'ENGINE_VERSION_UNRESOLVED',
      `cannot resolve the latest release of ${RELEASE_REPO}: HTTP ${response.status}${credentialHint(response.status, credential)}; pass --version <V>`,
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
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match !== null && match[2].replace(/^\.\//, '') === assetName) return match[1];
  }
  return null;
}

function tarString(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

/**
 * The engine archive path contract, re-stated because the bootstrap may not
 * import `src/` (C5). It must not be laxer than `plugin.js`/`engine.js`:
 * non-empty, relative, POSIX, canonical and at most `MAX_PATH_BYTES` bytes.
 */
export function archivePathProblem(path) {
  if (path === '') return 'engine archive entry has an empty path';
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > MAX_PATH_BYTES) {
    return `engine archive path is ${bytes} bytes (max ${MAX_PATH_BYTES}): ${path}`;
  }
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
  if (!existsSync(join(engineHome, ENGINE_ENTRY))) return false;
  try {
    return JSON.parse(readFileSync(join(engineHome, 'package.json'), 'utf8'))?.version === version;
  } catch {
    return false;
  }
}

/**
 * Undo the engine this run extracted when the hand-off fails: a tampered or
 * missing payload asset must leave the project byte-for-byte as it was found,
 * not a project with an engine and no receipt. Directories this run created
 * (`.r2c/engine`, `.r2c`) are removed too, but only when they are empty.
 */
function undoExtractedEngine(engineHome, createdDirs) {
  rmSync(engineHome, { recursive: true, force: true });
  for (const dir of [dirname(engineHome), dirname(dirname(engineHome))]) {
    if (!createdDirs.has(dir)) continue;
    try {
      rmdirSync(dir);
    } catch {
      // something else already lives there
    }
  }
}

// --- per-bundle Release channel (#106, decision #74 §9) ---------------------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Semver precedence for the latest-release scan (prerelease rules included). */
function compareVersions(left, right) {
  const parse = (value) => {
    const [core, ...rest] = String(value).split('-');
    const [major, minor, patch] = core.split('.').map((part) => Number.parseInt(part, 10));
    const prerelease = rest.length === 0 ? [] : rest.join('-').split('.');
    return { major, minor, patch, prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const one = a.prerelease[index];
    const two = b.prerelease[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const numeric = /^\d+$/.test(one);
    const otherNumeric = /^\d+$/.test(two);
    if (numeric && otherNumeric) {
      if (Number(one) !== Number(two)) return Number(one) < Number(two) ? -1 : 1;
      continue;
    }
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    if (one !== two) return one < two ? -1 : 1;
  }
  return 0;
}

function releaseMissingCode(name) {
  if (name.startsWith('r2c-engine-')) return 'RELEASE_ENGINE_MISSING';
  if (name.startsWith('r2c-framework-')) return 'RELEASE_FRAMEWORK_MISSING';
  if (/^(r2c-payload-|agent-native-)/.test(name)) return 'RELEASE_PAYLOAD_MISSING';
  return 'RELEASE_NOT_FOUND';
}

function releaseAssetUnavailable(name, tag, where, { status = null, credential = null } = {}) {
  const hint = credential === null ? '' : credentialHint(status, credential);
  return new BootstrapError(
    releaseMissingCode(name),
    `release ${tag} does not carry ${name}: ${where}${hint}`,
    2,
  );
}

/** `R2C_GITHUB_API` is a loopback/mirror seam; it never receives a token. */
function apiBaseFor(source) {
  const override = process.env.R2C_GITHUB_API;
  if (source.kind === 'url' && source.github === false
    && typeof override === 'string' && override.trim() !== '') {
    return override.trim().replace(/\/+$/, '');
  }
  return GITHUB_API;
}

/**
 * The `release-source.js` client shape (`{base, token, request}`), built from
 * the bootstrap's own fetch/credential chain. `token` stays null for a custom
 * mirror: a mirror authenticates its own way (decision #74 §4).
 */
function releaseClient(source, credential) {
  const base = apiBaseFor(source);
  const token = credential?.token ?? null;
  return {
    base,
    token,
    async request(method, target, options = {}) {
      const url = /^https?:\/\//i.test(target) ? target : `${base}${target}`;
      const headers = {
        accept: options.accept ?? 'application/vnd.github+json',
        'user-agent': 'r2c-install',
      };
      if (token !== null) headers.authorization = `Bearer ${token}`;
      let response;
      try {
        response = await fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        fail('RELEASE_DOWNLOAD_FAILED', `cannot reach ${url}: ${error.message}`, 1);
      }
      const responseHeaders = {};
      response.headers?.forEach?.((value, key) => {
        responseHeaders[key] = value;
      });
      let data = null;
      if (options.parse === 'bytes') data = Buffer.from(await response.arrayBuffer());
      else {
        try {
          data = await response.json();
        } catch {
          data = null;
        }
      }
      return { ok: response.ok, status: response.status, headers: responseHeaders, data, url };
    },
  };
}

/**
 * Latest published `bundle-<id>-v<semver>` tag (mirrors `resolveLatest`):
 * paginated `/releases`, drafts/prereleases filtered, max semver. This scan
 * runs before the framework is available; after unpacking it, the framework's
 * own `resolveLatest` re-confirms the choice.
 */
async function listBundleRelease(client, bundleId) {
  const pattern = new RegExp(`^bundle-${escapeRegExp(bundleId)}-v(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$`);
  let best = null;
  let scanned = 0;
  const settle = (pages) => {
    if (best !== null) return { ...best, pages, scanned };
    fail(
      'RELEASE_VERSION_UNRESOLVED',
      `no published ${bundleId} release (scanned ${scanned} entries); pass --version <V>`,
      2,
    );
  };
  for (let page = 1; page <= 10; page += 1) {
    const response = await client.request('GET', `/repos/${RELEASE_REPO}/releases?per_page=100&page=${page}`);
    if (!response.ok) {
      if (response.status === 401) fail('RELEASE_AUTH_REQUIRED', 'the release list needs GH_TOKEN with contents:read', 2);
      if (response.status === 403 || response.status === 429) {
        fail('RELEASE_RATE_LIMITED', 'the anonymous GitHub API limit was hit; pass --version <V> or set GH_TOKEN', 2);
      }
      fail('RELEASE_NOT_FOUND', `cannot list the releases of ${RELEASE_REPO}: HTTP ${response.status}`, 2);
    }
    const entries = Array.isArray(response.data) ? response.data : null;
    if (entries === null) fail('RELEASE_VERSION_UNRESOLVED', 'the release list is not an array; pass --version <V>', 2);
    scanned += entries.length;
    for (const entry of entries) {
      if (entry?.draft === true || entry?.prerelease === true) continue;
      const match = pattern.exec(String(entry?.tag_name ?? ''));
      if (match === null) continue;
      if (best === null || compareVersions(match[1], best.version) > 0) {
        best = { tag: entry.tag_name, version: match[1] };
      }
    }
    if (entries.length < 100) return settle(page);
  }
  const overflow = await client.request('GET', `/repos/${RELEASE_REPO}/releases?per_page=100&page=11`);
  if (overflow.ok && Array.isArray(overflow.data) && overflow.data.length > 0) {
    fail('RELEASE_LIST_TRUNCATED', `the release list exceeds 1000 entries; pass --version <V>`, 2);
  }
  return settle(11);
}

/** `<base>/<tag>/<asset>` on a mirror, or a flat local release directory. */
async function fetchBundleAsset(source, tag, name, credential) {
  if (source.kind === 'dir') {
    for (const candidate of [join(source.dir, tag, name), join(source.dir, name)]) {
      if (existsSync(candidate)) return readFileSync(candidate);
    }
    throw releaseAssetUnavailable(name, tag, source.dir);
  }
  const url = `${source.base}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  const response = await request(url, 60_000, credential === null ? {} : bearer(credential.token));
  if (!response.ok) {
    throw releaseAssetUnavailable(name, tag, url, { status: response.status, credential });
  }
  return Buffer.from(await response.arrayBuffer());
}

/** `SHA256SUMS.txt` → `Map<name, digest>`; malformed lines refuse. */
function readSumsNames(bytes) {
  const names = new Map();
  for (const raw of bytes.toString('utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (match === null) fail('RELEASE_CHECKSUM_MISMATCH', `${SUMS_ASSET} has a malformed line: ${JSON.stringify(line)}`, 2);
    const name = match[2].trim().replace(/^\.\//, '');
    if (name === SUMS_ASSET) fail('RELEASE_CHECKSUM_MISMATCH', `${SUMS_ASSET} must not cover itself`, 2);
    const existing = names.get(name);
    if (existing !== undefined && existing !== match[1]) {
      fail('RELEASE_CHECKSUM_MISMATCH', `${SUMS_ASSET} lists ${name} twice with different digests`, 2);
    }
    names.set(name, match[1]);
  }
  return names;
}

function verifyAssetDigest(name, bytes, sums) {
  const expected = sums.get(name);
  if (expected === undefined) {
    fail(releaseMissingCode(name), `${SUMS_ASSET} lists no entry for ${name}`, 2);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    fail('RELEASE_CHECKSUM_MISMATCH', `${name} sha256 mismatch: ${SUMS_ASSET} says ${expected}, the download is ${actual}; nothing was written`, 2);
  }
}

/**
 * Read the framework archive. The bootstrap cannot import `scripts/` or
 * `src/`, and framework paths reach 200 bytes, so this is a local ustar
 * reader with the projection path budget instead of the engine one.
 */
function readFrameworkArchive(buffer) {
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (error) {
    fail('RELEASE_ASSET_SET_MISMATCH', `the framework archive is not a gzip stream: ${error.message}`, 2);
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
      fail('RELEASE_ASSET_SET_MISMATCH', `invalid framework entry size for ${path || '(unnamed)'}`, 2);
    }
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    if (type === '5') continue;
    if (type !== '0') {
      fail('RELEASE_ASSET_SET_MISMATCH', `unsupported framework entry type "${type}": ${path}`, 2);
    }
    const segments = path.split('/');
    if (path === '' || path.startsWith('/') || path.includes('\\')
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      fail('RELEASE_ASSET_SET_MISMATCH', `framework path is not a canonical relative POSIX path: ${path}`, 2);
    }
    if (Buffer.byteLength(path, 'utf8') > 255) {
      fail('RELEASE_ASSET_SET_MISMATCH', `framework path is longer than 255 bytes: ${path}`, 2);
    }
    if (seen.has(path)) fail('RELEASE_ASSET_SET_MISMATCH', `duplicate framework path: ${path}`, 2);
    seen.add(path);
    entries.push({ path, data });
  }
  if (entries.length === 0) fail('RELEASE_ASSET_SET_MISMATCH', 'the framework archive is empty', 2);
  return entries;
}

/** Unpack the framework release into a fresh temporary directory. */
function extractFramework(buffer) {
  const entries = readFrameworkArchive(buffer);
  const root = mkdtempSync(join(tmpdir(), 'r2c-framework-'));
  try {
    for (const entry of entries) {
      const target = join(root, ...entry.path.split('/'));
      const rel = relative(root, target);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        fail('RELEASE_ASSET_SET_MISMATCH', `framework path escapes its root: ${entry.path}`, 2);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data);
      chmodSync(target, 0o644);
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

/** Import the verified framework's release-source and installer modules. */
async function loadFramework(root) {
  try {
    const releaseSource = await import(pathToFileURL(join(root, 'installer', 'release-source.js')).href);
    const install = await import(pathToFileURL(join(root, 'installer', 'release-install.js')).href);
    return { releaseSource, install };
  } catch (error) {
    fail('RELEASE_FRAMEWORK_MISSING', `the framework archive cannot be loaded: ${error.message}`, 2);
  }
}

/** Download → three-way verify → install one bundle Release. */
async function runBundle(options, projectDir) {
  const explicitBase = options.releaseBase ?? process.env.R2C_RELEASE_BASE ?? null;
  const source = releaseSource(explicitBase === null ? DEFAULT_RELEASE_BASE : explicitBase);
  const bundleId = options.bundle;
  const credential = source.github ? authCredential() : null;
  const client = releaseClient(source, credential);

  let version = options.version;
  let tag = version === undefined ? null : `bundle-${bundleId}-v${version}`;
  if (version === undefined) {
    if (source.kind === 'dir') {
      fail('RELEASE_VERSION_REQUIRED', `--version <V> is required when --release-base is a directory (${source.dir}): a local mirror carries no release list`, 2);
    }
    if (!source.github && apiBaseFor(source) === GITHUB_API) {
      fail('RELEASE_VERSION_REQUIRED', `--version <V> is required with --release-base ${source.base}: only the default GitHub release base resolves the latest bundle tag`, 2);
    }
    const listed = await listBundleRelease(client, bundleId);
    version = listed.version;
    tag = listed.tag;
  }

  const sumsBytes = await fetchBundleAsset(source, tag, SUMS_ASSET, credential);
  const sums = readSumsNames(sumsBytes);
  const frameworkName = [...sums.keys()].find((name) => FRAMEWORK_ASSET_RE.test(name));
  if (frameworkName === undefined) {
    fail('RELEASE_FRAMEWORK_MISSING', `${SUMS_ASSET} of ${tag} lists no r2c-framework-<F>.tgz; nothing was written`, 2);
  }
  const frameworkBytes = await fetchBundleAsset(source, tag, frameworkName, credential);
  verifyAssetDigest(frameworkName, frameworkBytes, sums);

  const frameworkRoot = extractFramework(frameworkBytes);
  try {
    const framework = await loadFramework(frameworkRoot);

    // Version resolution is the framework's contract (release-source.js, #107).
    try {
      if (options.version === undefined) {
        const resolved = await framework.releaseSource.resolveLatest({ client, bundleId });
        if (resolved.version !== version) {
          fail(
            'RELEASE_VERSION_UNRESOLVED',
            `the latest ${bundleId} release changed while installing (${version} → ${resolved.version}); rerun or pass --version`,
            2,
          );
        }
      } else {
        await framework.releaseSource.resolveVersion({
          client,
          bundleId,
          version,
          downloadBase: source.kind === 'url' ? source.base : undefined,
        });
      }
    } catch (error) {
      if (error?.name === 'ReleaseSourceError') {
        fail(error.code, String(error.message).replace(/^[A-Z][A-Z0-9_]*: /, ''), 2);
      }
      throw error;
    }

    const irBytes = await fetchBundleAsset(source, tag, IR_ASSET, credential);
    verifyAssetDigest(IR_ASSET, irBytes, sums);
    let ir;
    try {
      ir = JSON.parse(irBytes.toString('utf8'));
    } catch (error) {
      fail('RELEASE_IR_MISMATCH', `${IR_ASSET} is not JSON: ${error.message}`, 2);
    }
    const allowed = framework.install.allowedProjections(ir);
    if (allowed === null) {
      fail('RELEASE_PROJECTION_NOT_ALLOWED', 'requires.projections must be a non-empty array of projection ids', 2);
    }
    const selection = framework.install.selectProjection({ allowed, requested: options.projection });
    if (selection.ok === false) {
      fail(selection.code, selection.message.replace(/^[A-Z][A-Z0-9_]*: /, ''), selection.exitCode ?? 2);
    }
    const projection = selection.projection;

    const assets = {
      [INSTALL_ASSET]: readFileSync(fileURLToPath(import.meta.url)),
      [IR_ASSET]: irBytes,
      [frameworkName]: frameworkBytes,
    };
    const needed = [
      `bundle-${bundleId}-v${version}.zip`,
      projection === 'r2c'
        ? `r2c-payload-${bundleId}-v${version}.tgz`
        : `agent-native-${bundleId}-v${version}.tgz`,
    ];
    if (projection === 'r2c') {
      const engineName = [...sums.keys()].find((name) => ENGINE_ASSET_RE.test(name));
      if (engineName === undefined) {
        fail('RELEASE_ENGINE_MISSING', `${SUMS_ASSET} of ${tag} lists no r2c-engine-<E>.tgz for the r2c runtime`, 2);
      }
      needed.push(engineName);
    }
    for (const name of needed) {
      if (!sums.has(name)) {
        fail(releaseMissingCode(name), `${SUMS_ASSET} of ${tag} lists no ${name}; nothing was written`, 2);
      }
      const bytes = await fetchBundleAsset(source, tag, name, credential);
      verifyAssetDigest(name, bytes, sums);
      assets[name] = bytes;
    }

    const outcome = framework.install.installRelease({
      projectRoot: projectDir,
      bundleId,
      version,
      projection,
      targets: options.targets ?? null,
      sumsBytes,
      assets,
      force: options.force === true,
    });
    if (outcome.ok === false) {
      fail(outcome.code, String(outcome.message).replace(/^[A-Z][A-Z0-9_]*: /, ''), outcome.exitCode ?? 2);
    }

    if (outcome.runtime !== null) {
      process.stdout.write(`runtime/engine/${outcome.runtime.engine.version}: ${outcome.runtime.files} file(s) ${outcome.runtime.action}\n`);
    }
    process.stdout.write(
      `install ${outcome.projection}/${outcome.bundleId}@${outcome.version}: ${outcome.files} file(s) ${outcome.action}\n`,
    );
    if (outcome.receiptPath !== undefined && outcome.receiptPath !== null) {
      process.stdout.write(`receipt: ${outcome.receiptPath}\n`);
    }
    for (const warning of outcome.warnings ?? []) {
      process.stdout.write(`warn: ${warning.code ?? 'WARNING'} ${warning.message ?? ''}`.trim() + '\n');
    }
    if (projection === 'r2c') {
      process.stdout.write('next: node .r2c/bin/r2c.js\n');
    }
  } finally {
    rmSync(frameworkRoot, { recursive: true, force: true });
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // The floor comes before every download: an unsupported Node cannot run the
  // engine, so failing here leaves the project and the release untouched.
  if (!nodeSupported(process.versions.node)) {
    fail(
      'NODE_UNSUPPORTED',
      `r2c requires node ${NODE_RANGE}; this is node ${process.versions.node}`,
      2,
    );
  }

  const projectDir = resolve(options.project ?? process.cwd());
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    fail('USAGE', `--project is not a directory: ${projectDir}`, 2);
  }
  if (options.bundle !== undefined) {
    await runBundle(options, projectDir);
    return 0;
  }
  const scope = options.scope ?? 'project';

  const explicitBase = options.releaseBase ?? process.env.R2C_RELEASE_BASE ?? null;
  const source = releaseSource(explicitBase === null ? DEFAULT_RELEASE_BASE : explicitBase);
  const version = options.version ?? (await latestVersion(source));
  const engineHome = join(scope === 'user' ? userHome() : projectDir, '.r2c', 'engine', version);
  const engineRoot = dirname(engineHome);
  const stateRoot = dirname(engineRoot);
  const createdDirs = new Set([stateRoot, engineRoot].filter((dir) => !existsSync(dir)));
  let extracted = false;

  // Same version already in place: re-running writes nothing and fetches nothing.
  if (engineReady(engineHome, version)) {
    process.stdout.write(`engine ${version} already at ${engineHome}\n`);
  } else {
    const assetName = `r2c-engine-${version}.tgz`;
    const sums = await fetchAsset(source, version, SUMS_ASSET);
    const expected = digestFor(sums.toString('utf8'), assetName);
    if (expected === null) {
      throw assetUnavailable(assetName, version, `${SUMS_ASSET} lists no entry for it`);
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
    extracted = true;
    process.stdout.write(`engine ${version}: ${engineHome}\n`);
  }

  const entry = join(engineHome, ENGINE_ENTRY);
  const env = { ...process.env };
  if (explicitBase !== null) {
    env.R2C_RELEASE_BASE = source.kind === 'dir' ? source.dir : source.base;
  }
  const installArgs = [
    entry,
    'adapter',
    'install',
    options.agent,
    '--engine',
    engineHome,
    '--scope',
    scope,
    '--project',
    projectDir,
  ];
  // Only `adapter install` takes these, so they never reach the next command.
  if (options.profile !== undefined) installArgs.push('--profile', options.profile);
  if (options.force === true) installArgs.push('--force');
  const child = spawnSync(
    process.execPath,
    installArgs,
    { cwd: projectDir, env, stdio: 'inherit' },
  );
  if (child.error) {
    if (extracted) undoExtractedEngine(engineHome, createdDirs);
    fail('ENGINE_SPAWN_FAILED', `cannot run ${entry}: ${child.error.message}`, 1);
  }
  if (child.status !== 0) {
    const removedEngine = extracted;
    if (removedEngine) undoExtractedEngine(engineHome, createdDirs);
    fail(
      'ADAPTER_INSTALL_FAILED',
      `adapter install ${options.agent} failed with exit ${child.status ?? 'signal'}${
        removedEngine ? '; the engine this run extracted was removed' : ''
      }`,
      typeof child.status === 'number' && child.status !== 0 ? child.status : 1,
    );
  }

  const next = [`node "${entry}"`, 'run'];
  if (projectDir !== resolve(process.cwd())) next.push('--project', `"${projectDir}"`);
  process.stdout.write(`next: ${next.join(' ')}\n`);
  return 0;
}

/**
 * Run only when executed (`node install.mjs`), never when imported: the tests
 * import the pure helpers above, and the release asset is the same file.
 */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  const invokedPath = resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
}

if (invokedDirectly()) {
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
}
