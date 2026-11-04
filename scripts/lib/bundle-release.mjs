/**
 * Per-bundle Release assembly (#105, decisions #74 / #63, spec §13/§15).
 *
 * One `(bundle.id, bundle.version)` is one self-contained Release, tag
 * `bundle-<id>-v<version>`. The asset set is a pure function of the bundle
 * zip, the framework checkout and the engine checkout:
 *
 *   bundle-<id>-v<version>.zip          always
 *   workflow.compiled.json                    always
 *   hm2b-payload-<id>-v<version>.tgz    runner in requires.projections
 *   agent-native-<id>-v<version>.tgz    agent-native in requires.projections
 *   hm2b-engine-<E>.tgz                 runner in requires.projections
 *   hm2b-framework-<F>.tgz              always (framework sources + installer/)
 *   install.mjs                         always, byte-identical to scripts/install.mjs
 *   install                             always, the flag-free launcher for this tag
 *   SHA256SUMS.txt                      always, covers every other asset
 *
 * The payloads are pre-projected with canonical options, validated V1–V12,
 * packed deterministically and accompanied by `manifest.json`
 * (`hm2b.release-payload/v1`). Installation never compiles or projects again.
 *
 * No legacy asset is produced here: `r2c-payload-<E>.tgz` belongs to the
 * `v<E>` channel, and the two tag namespaces never overlap.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { inflateRaw } from '../../core/node/inflate.js';
import { sha256Hex } from '../../core/node/sha256.js';
import { analyzeBundle, compileBundle } from '../../assembler/index.js';
import { jsonEqual as sameValue } from '../../core/json.js';
import { canonicalJson, isCanonicalJson } from '../../core/canonical-json.js';
import { compareCodePoints } from '../../core/code-point.js';
import { foldCase, hasFileDirPrefixConflict } from '../../core/paths.js';
import { isValidRange, isValidVersion, satisfiesRange } from '../../core/semver.js';
import {
  INSTALL_ASSET,
  LAUNCHER_ASSET,
  COMPILED_WORKFLOW_ASSET,
  SUMS_ASSET,
  bundleAssetNames,
  bundleTag,
  isLegacyEngineTag,
  isValidBundleId,
  legacyAssetNames,
  parseBundleTag,
} from '../../installer/release-tags.js';
import { DEFAULT_RELEASE_REPO } from '../../installer/release-source.js';
import {
  PAYLOAD_FILE_KINDS,
  PAYLOAD_MANIFEST_NAME,
  RELEASE_PAYLOAD_SCHEMA,
  payloadResultBlock,
  verifyPayloadArchive,
} from '../../installer/release-payload.js';
import { canonicalInputOptions, isCanonicalOptions, normalizeOptions, payloadInputOptions } from '../../projection/options.js';
import { project } from '../../projection/project.js';
import { getProjection } from '../../projection/registry.js';
import { validateResult } from '../../projection/validate-result.js';
import { collectEngine, engineAssetName, engineEntryBytes } from './engine-archive.mjs';
import { collectBundleFiles } from './file-set.mjs';
import { createReleaseTarGz, readReleaseTarGz, releasePathProblem } from '../../installer/release-tar.js';
import { writeZip } from './zip-writer.mjs';

export const BUNDLE_MAKE_LATEST = false;
export const CANONICAL_PROJECTIONS = Object.freeze(['runner', 'agent-native']);

// The tag/asset-name contract is shared with the installer and the web
// publisher (#107); this module re-exports it so #105 callers keep working.
export {
  INSTALL_ASSET,
  COMPILED_WORKFLOW_ASSET,
  SUMS_ASSET,
  bundleAssetNames,
  bundleTag,
  isLegacyEngineTag,
  isValidBundleId,
  legacyAssetNames,
  parseBundleTag,
};
export { PAYLOAD_FILE_KINDS, PAYLOAD_MANIFEST_NAME, RELEASE_PAYLOAD_SCHEMA, verifyPayloadArchive };

/** Framework source roots (#77 §5.5, decision #74 §3.3). */
const FRAMEWORK_DIRS = Object.freeze([
  'core',
  'compiled',
  'assembler',
  'projection',
  'installer',
  'web',
  'bin/assembler',
]);
const FRAMEWORK_RUNTIME_DIRS = Object.freeze(['projection', 'assets', 'targets']);
const FRAMEWORK_ROOT_FILES = Object.freeze(['package.json', 'LICENSE', 'bin/hm2b-assembler.js']);
const FRAMEWORK_FORBIDDEN = Object.freeze([
  'test/',
  'tests/',
  'docs/',
  'scripts/',
  '.github/',
  'examples/',
  'plugins/',
  'pack/',
  'src/',
  'adapters/',
  'shims/',
  'schema/',
  'node_modules/',
  'dist/',
]);

export class ReleaseError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function asBytes(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function buildReportErrors(report) {
  return (report?.errors ?? []).map((error) => `${error.code}: ${error.message}`);
}

function sourceProblemMessages(problems, code) {
  return problems.map((problem) => `${code}: ${problem}`);
}

/** Read the bundle source: a committed zip is used verbatim, a directory is packed. */
export function loadBundleSource(bundlePath) {
  const absolute = resolve(bundlePath);
  if (!existsSync(absolute)) {
    throw new ReleaseError('RELEASE_BUNDLE_MISSING', `bundle source does not exist: ${bundlePath}`);
  }
  const stat = statSync(absolute);
  if (stat.isDirectory()) {
    const files = collectBundleFiles(absolute);
    return {
      path: absolute,
      directory: true,
      bytes: asBytes(writeZip(files, { method: 'store' })),
    };
  }
  if (!stat.isFile()) {
    throw new ReleaseError('RELEASE_BUNDLE_MISSING', `bundle source is not a file or directory: ${bundlePath}`);
  }
  return { path: absolute, directory: false, bytes: asBytes(readFileSync(absolute)) };
}

/**
 * Collect the framework source set (#77 §5.5 + `installer/`, #74 §3.3).
 * Deterministic ordering, no VCS build artefacts, no bootstrap (it is its own
 * asset), no root engine CLI.
 */
export function collectFramework(root) {
  const problems = [];
  const files = [];
  const folded = new Map();
  const addFile = (absolute, rel) => {
    const problem = releasePathProblem(rel);
    if (problem !== null) {
      problems.push(problem);
      return;
    }
    const key = foldCase(rel);
    if (folded.has(key)) {
      problems.push(`framework paths collide when case is folded: ${folded.get(key)} / ${rel}`);
      return;
    }
    folded.set(key, rel);
    files.push({ rel, absolute, data: () => readFileSync(absolute) });
  };
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort(compareCodePoints)) {
      const absolute = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const stat = lstatSync(absolute, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) {
        problems.push(`symlink not allowed in framework archive: ${rel}`);
        continue;
      }
      if (stat.isDirectory()) walk(absolute, rel);
      else if (stat.isFile()) addFile(absolute, rel);
      else problems.push(`unsupported file type in framework archive: ${rel}`);
    }
  };

  for (const dir of FRAMEWORK_DIRS) {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) {
      problems.push(`missing framework path: ${dir}`);
      continue;
    }
    walk(absolute, dir);
  }
  const runtimeRoot = join(root, 'runtime');
  const runtimeIds = existsSync(runtimeRoot)
    ? readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCodePoints)
    : [];
  for (const id of runtimeIds) {
    if (id === 'shared') walk(join(runtimeRoot, id), `runtime/${id}`);
    for (const dir of FRAMEWORK_RUNTIME_DIRS) {
      const relative = `runtime/${id}/${dir}`;
      const absolute = join(root, relative);
      if (existsSync(absolute)) walk(absolute, relative);
    }
  }
  for (const name of FRAMEWORK_ROOT_FILES) {
    const absolute = join(root, name);
    if (!existsSync(absolute)) {
      problems.push(`missing framework file: ${name}`);
      continue;
    }
    addFile(absolute, name);
  }

  files.sort((left, right) => compareCodePoints(left.rel, right.rel));
  return { files, problems };
}

/** Forbidden framework paths (spec §15 "不发布" list). */
export function frameworkSourceProblems(rels) {
  const problems = [];
  for (const rel of rels) {
    if (FRAMEWORK_FORBIDDEN.some((prefix) => rel.startsWith(prefix))) {
      problems.push(`framework source set must not ship ${rel}`);
    }
    if (rel.startsWith('bin/') && rel !== 'bin/hm2b-assembler.js' && !rel.startsWith('bin/assembler/')) {
      problems.push(`framework source set must not ship ${rel}`);
    }
  }
  return problems;
}

function engineSourceProblems(rels) {
  return rels
    .filter((rel) => /^(test|tests|docs|scripts|pack|adapters|plugins|dist)\//.test(rel))
    .map((rel) => `engine archive must not ship ${rel}`);
}

/**
 * Engine version and file set.
 *
 * Both channels ship the same bytes: `scripts/lib/engine-archive.mjs` owns
 * the P6 layout (root launcher + `runtime/runner/engine/**` + `core/**` +
 * vendored `yaml`), and the version is the engine package version E, not the
 * framework version.
 */
export function readEngine(root) {
  const collected = collectEngine(root);
  return {
    version: collected.version,
    files: collected.files,
    problems: collected.problems,
  };
}

/**
 * Resolve one projection's options. `raw` is the caller's request (canonical
 * `null` for a Release build, or the exact local selection from the web/CLI).
 */
function validateProjectionOptions({ projectionId, compiledWorkflow, compiledWorkflowDigest, raw = null }) {
  const descriptor = getProjection(projectionId);
  const normalized = normalizeOptions({
    projectionId,
    compiledWorkflow,
    compiledWorkflowDigest,
    raw,
    manifest: descriptor,
  });
  const canonical = normalized.ok && isCanonicalOptions({
    projectionId,
    compiledWorkflow,
    compiledWorkflowDigest,
    options: normalized.options,
    manifest: descriptor,
  });
  const options = canonical || !normalized.ok
    ? canonicalInputOptions(projectionId, descriptor)
    : payloadInputOptions({
      projectionId,
      compiledWorkflow,
      compiledWorkflowDigest,
      options: normalized.options,
      manifest: descriptor,
    });
  return { descriptor, raw, options, canonical, normalized };
}

function payloadFileName(projectionId, id, version) {
  return projectionId === 'runner'
    ? `hm2b-payload-${id}-v${version}.tgz`
    : `agent-native-${id}-v${version}.tgz`;
}

/**
 * Build the canonical payload manifest for one projection. `options` records
 * the canonical *input* (nulls), never `result.options`.
 */
export function buildPayloadManifest({ id, version, projection, compiledWorkflow, compiledWorkflowDigest, options, targets, files, result = null }) {
  const sorted = [...files]
    .map((file) => {
      const entry = {
        path: file.path,
        mode: file.mode,
        sha256: sha256Hex(Buffer.from(file.content, 'utf8')),
        kind: file.kind,
        targets: [...file.targets],
        origin: file.origin,
      };
      if (file.assetId !== undefined) entry.assetId = file.assetId;
      return entry;
    })
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const manifest = {
    schema: RELEASE_PAYLOAD_SCHEMA,
    bundle: { id, version },
    compiledWorkflow: {
      digest: compiledWorkflowDigest,
      contentSha256: compiledWorkflow?.source?.bundle?.contentSha256 ?? null,
    },
    projection: { id: projection.id, version: projection.version },
    options: {
      stageOrder: options.stageOrder,
      skills: options.skills,
      targets: [...options.targets],
    },
    targets: [...targets],
    files: sorted,
  };
  // The validated result minus file content: the installer rebuilds it and
  // re-runs V1–V12 without compiling or projecting (#106).
  if (result !== null) manifest.result = payloadResultBlock(result);
  return manifest;
}

function payloadEntries(result) {
  return result.files.map((file) => ({
    path: `files/${file.path}`,
    data: Buffer.from(file.content, 'utf8'),
    mode: file.mode,
  }));
}

/**
 * compiled workflow assets are part of the projected result, not bundle-internal bytes: a
 * Release whose compiled workflow carries an asset kind must ship one payload member per
 * declared asset, otherwise the install would silently drop the asset. Paths
 * are projection-owned, so the proof is by kind and count, not by compiled workflow path.
 */
function missingIrAssetKinds(compiledWorkflow, result) {
  const present = new Map();
  for (const file of result.files) present.set(file.kind, (present.get(file.kind) ?? 0) + 1);
  const missing = [];
  const need = (kind, count) => {
    const actual = present.get(kind) ?? 0;
    if (actual < count) missing.push(`${kind} (${actual}/${count})`);
  };
  need('knowledge', (compiledWorkflow.knowledgeBase ?? []).length);
  need('checklist', (compiledWorkflow.checklists ?? []).length);
  need('hooks', compiledWorkflow.hooks === null || compiledWorkflow.hooks === undefined ? 0 : 1);
  need('mcp', compiledWorkflow.mcp === null || compiledWorkflow.mcp === undefined ? 0 : 1);
  return missing;
}

function buildPayload({ compiledWorkflow, compiledWorkflowDigest, id, version, projectionId, engineVersion, raw = null }) {
  const { descriptor, options, canonical, normalized } = validateProjectionOptions({
    projectionId,
    compiledWorkflow,
    compiledWorkflowDigest,
    raw,
  });
  if (!normalized.ok) {
    throw new ReleaseError(
      'RELEASE_PAYLOAD_INVALID',
      `${projectionId} options are invalid: ${normalized.errors.map((error) => `${error.code}: ${error.message}`).join('; ')}`,
    );
  }
  const environment = { engineVersion };
  const result = project({
    projectionId,
    compiledWorkflow,
    compiledWorkflowDigest,
    options: normalized.options,
    environment,
    assets: {},
  });
  if (!result.ok) {
    throw new ReleaseError(
      'RELEASE_PAYLOAD_INVALID',
      `${projectionId} projection failed: ${(result.errors ?? []).map((error) => error.message).join('; ')}`,
    );
  }
  const validation = validateResult(result, {
    compiledWorkflow,
    compiledWorkflowDigest,
    manifest: descriptor,
    options: normalized.options,
    environment,
    assets: {},
  });
  if (!validation.ok) {
    throw new ReleaseError(
      'RELEASE_PAYLOAD_INVALID',
      `${projectionId} result failed V1–V12: ${validation.diagnostics.map((item) => item.message).join('; ')}`,
    );
  }
  const missingAssets = missingIrAssetKinds(compiledWorkflow, result);
  if (missingAssets.length > 0) {
    throw new ReleaseError(
      'RELEASE_PAYLOAD_INVALID',
      `${projectionId} projection omitted compiled workflow assets: ${missingAssets.join(', ')}`,
    );
  }

  const manifest = buildPayloadManifest({
    id,
    version,
    projection: descriptor,
    compiledWorkflow,
    compiledWorkflowDigest,
    options,
    targets: result.targets,
    files: result.files,
    result,
  });
  const entries = payloadEntries(result);
  entries.push({ path: PAYLOAD_MANIFEST_NAME, data: Buffer.from(canonicalJson(manifest), 'utf8') });
  const data = createReleaseTarGz(entries);
  const problems = verifyPayloadArchive(data, {
    id,
    version,
    compiledWorkflowDigest,
    contentSha256: compiledWorkflow?.source?.bundle?.contentSha256 ?? null,
    projectionId,
    options: manifest.options,
    targets: manifest.targets,
    result,
  });
  if (problems.length > 0) {
    throw new ReleaseError('RELEASE_PAYLOAD_INVALID', `${projectionId} payload is inconsistent: ${problems.join('; ')}`);
  }
  return {
    projectionId,
    file: payloadFileName(projectionId, id, version),
    data,
    manifest,
    result,
    canonical,
  };
}

function frameworkArchive(collection) {
  return createReleaseTarGz(
    collection.files.map((file) => ({ path: file.rel, data: file.data(), mode: 0o644 })),
  );
}

function engineArchive(files) {
  // The engine asset is byte-identical in both channels (#74 §2.3) and uses
  // the same deterministic writer as the payload archives.
  return createReleaseTarGz(
    files.map((file) => ({ path: file.rel, data: engineEntryBytes(file), mode: 0o644 })),
  );
}

function sumsBuffer(assets) {
  const lines = [...assets]
    .sort((left, right) => compareCodePoints(left.name, right.name))
    .map((asset) => `${sha256Hex(asset.data)}  ${asset.name}\n`);
  return Buffer.from(lines.join(''), 'utf8');
}

function planFor({ id, version, assets }) {
  return Object.freeze({
    tag: bundleTag(id, version),
    bundleId: id,
    version,
    name: `${id} v${version}`,
    makeLatest: BUNDLE_MAKE_LATEST,
    prerelease: false,
    draft: true,
    assets: Object.freeze(
      [...assets]
        .sort((left, right) => compareCodePoints(left.name, right.name))
        .map((asset) => Object.freeze({
          name: asset.name,
          size: asset.data.length,
          sha256: sha256Hex(asset.data),
        })),
    ),
  });
}

function failureResult(failures, notes = []) {
  return { ok: false, failures, notes, assets: null, plan: null };
}

/**
 * The extensionless launcher shipped with every bundle Release. It is the
 * whole install surface: `curl -fsSL …/<tag>/install | node -` fetches the
 * Release's own `install.mjs` and installs one projection. Runner and
 * agent-native own overlapping host role paths, so a project installs one of
 * them; `--target` selects agent-native for a single host.
 */
function launcherAsset({ id, version, allowed, repo, installerSha256 }) {
  const tag = bundleTag(id, version);
  const projections = CANONICAL_PROJECTIONS.filter((projection) => allowed.includes(projection));
  const fallback = projections.includes('runner') ? 'runner' : projections[0];
  return Buffer.from(`#!/usr/bin/env node
// Generated for ${tag}: installs this Release online, no flags required.
'use strict';
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, extname, join } = require('node:path');

const REPO = ${JSON.stringify(repo)};
const TAG = ${JSON.stringify(tag)};
const BUNDLE = ${JSON.stringify(id)};
const VERSION = ${JSON.stringify(version)};
const PROJECTIONS = ${JSON.stringify(projections)};
const DEFAULT_PROJECTION = ${JSON.stringify(fallback)};
const INSTALLER_SHA256 = ${JSON.stringify(installerSha256)};
const DEFAULT_BASE = \`https://github.com/\${REPO}/releases/download\`;
// A local fixture or mirror wins, the same seam install.mjs reads.
const rawBase = (process.env.HM2B_RELEASE_BASE || DEFAULT_BASE).trim();
const BASE = /^https?:\\/\\//i.test(rawBase) ? rawBase.replace(/\\/+$/, '') : rawBase;
const rawTimeout = Number(process.env.HM2B_INSTALL_DOWNLOAD_TIMEOUT_MS);
const DOWNLOAD_TIMEOUT_MS = Number.isInteger(rawTimeout) && rawTimeout > 0 && rawTimeout <= 4294967295 ? rawTimeout : 300_000;
const NETWORK_HINT = 'For a proxy, set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY; raise HM2B_INSTALL_DOWNLOAD_TIMEOUT_MS for a slow link.';

function fail(code, message, exitCode = 1) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  throw error;
}

function usage(message) {
  if (message !== undefined) process.stderr.write(\`install: \${message}\\n\`);
  process.stderr.write(
    'usage: curl -fsSL <release>/install | node - [--target <t>]... [--projection runner|agent-native] [--project <dir>] [--force]\\n',
  );
  const error = new Error(message || 'help requested');
  error.silent = true;
  error.exitCode = message === undefined ? 0 : 2;
  throw error;
}

// Match install.mjs: never prompt, and only consult Git credentials for GitHub.
function githubToken() {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[key]) return process.env[key];
  }
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((value) => value.toLowerCase())]
    : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir === '') continue;
    for (const extension of extensions) {
      const bin = join(dir, 'git' + extension);
      try { if (!statSync(bin).isFile()) continue; } catch { continue; }
      const needsShell = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(bin).toLowerCase());
      const result = spawnSync(needsShell ? '"' + bin + '" credential fill' : bin, needsShell ? [] : ['credential', 'fill'], {
        input: 'protocol=https\\nhost=github.com\\n\\n', encoding: 'utf8', timeout: 5000,
        windowsHide: true, shell: needsShell, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const match = result.status === 0 && !result.error && typeof result.stdout === 'string'
        ? /^password=(.+)$/m.exec(result.stdout) : null;
      return match === null ? null : match[1];
    }
  }
  return null;
}

async function download(url, token, asJson = false) {
  const headers = { 'user-agent': 'hm2b-install', accept: asJson ? 'application/vnd.github+json' : 'application/octet-stream' };
  if (token !== null) headers.authorization = \`Bearer \${token}\`;
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      fail('RELEASE_DOWNLOAD_FAILED', \`cannot read install.mjs for \${TAG}: HTTP \${response.status}; for private releases set GH_TOKEN/GITHUB_TOKEN or a git credential\`);
    }
    return asJson ? await response.json() : Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error.code === 'RELEASE_DOWNLOAD_FAILED') throw error;
    fail('RELEASE_DOWNLOAD_FAILED', \`cannot download install.mjs: \${error.message}\\n\${NETWORK_HINT}\`);
  }
}

async function installerBytes() {
  if (!/^https?:\\/\\//i.test(BASE)) {
    for (const path of [join(BASE, TAG, 'install.mjs'), join(BASE, 'install.mjs')]) {
      if (existsSync(path)) return readFileSync(path);
    }
    fail('RELEASE_DOWNLOAD_FAILED', \`install.mjs is missing from \${BASE}\`);
  }
  // Mirrors authenticate their own way: GitHub secrets never leave GitHub.
  const token = BASE === DEFAULT_BASE ? githubToken() : null;
  if (token === null) return download(\`\${BASE}/\${TAG}/install.mjs\`, null);
  const release = await download(\`https://api.github.com/repos/\${REPO}/releases/tags/\${TAG}\`, token, true);
  const asset = Array.isArray(release?.assets) ? release.assets.find((item) => item.name === 'install.mjs') : null;
  if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) fail('RELEASE_DOWNLOAD_FAILED', \`install.mjs is missing from \${TAG}\`);
  return download(\`https://api.github.com/repos/\${REPO}/releases/assets/\${asset.id}\`, token);
}

function parseArgs(argv) {
  const opts = { project: '.', targets: [], force: false, projection: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--target requires a host id');
      opts.targets.push(value);
      index += 1;
    } else if (arg === '--projection') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--projection requires runner or agent-native');
      opts.projection = value;
      index += 1;
    } else if (arg === '--project') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--project requires a directory');
      opts.project = value;
      index += 1;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      usage(\`unknown argument: \${arg}\`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major === 22 && minor >= 19 || major >= 24)) {
    fail('ENGINE_NODE_UNSUPPORTED', 'Node.js >=22.19.0 <23 || >=24.0.0 is required', 2);
  }
  // One projection per project: runner and agent-native share host role paths.
  let projection = opts.projection;
  if (projection === null) projection = opts.targets.length > 0 ? 'agent-native' : DEFAULT_PROJECTION;
  if (!PROJECTIONS.includes(projection)) {
    usage(\`projection \${projection} is not allowed by \${BUNDLE} v\${VERSION} (allowed: \${PROJECTIONS.join(', ')})\`);
  }
  if (opts.targets.length > 0 && projection !== 'agent-native') {
    usage('--target needs --projection agent-native');
  }
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-install-'));
  try {
    const bytes = await installerBytes();
    if (createHash('sha256').update(bytes).digest('hex') !== INSTALLER_SHA256) {
      fail('RELEASE_CHECKSUM_MISMATCH', 'install.mjs does not match this Release; nothing was executed', 2);
    }
    const installer = join(dir, 'install.mjs');
    writeFileSync(installer, bytes);
    const args = [installer, '--bundle', BUNDLE, '--version', VERSION, '--projection', projection, '--project', opts.project];
    if (projection === 'agent-native') {
      for (const target of opts.targets) args.push('--target', target);
    }
    if (opts.force) args.push('--force');
    const run = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true, env: { ...process.env, GH_REPO: REPO } });
    if (run.error !== undefined && run.error !== null) {
      fail('INTERNAL', run.error.message);
    }
    process.exitCode = run.status === null ? 1 : run.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (!error.silent) process.stderr.write(\`install: \${error.code || 'INTERNAL'}: \${error.message || String(error)}\\n\`);
  process.exitCode = error.exitCode === undefined ? 1 : error.exitCode;
});
`);
}

/**
 * Assemble every asset of one bundle Release in memory.
 *
 * @param {{root: string, bundlePath: string, tag?: string|null, options?: object|null, repo?: string}} input
 * @returns {{ok: boolean, failures: string[], notes: string[], assets: Array<{name: string, data: Buffer}>|null, plan: object|null}}
 */
export function buildBundleRelease({ root, bundlePath, tag = null, options = null, repo = DEFAULT_RELEASE_REPO }) {
  const failures = [];
  const notes = [];
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return failureResult(['RELEASE_SOURCE_SET_MISMATCH: repository must be owner/name'], notes);
  }
  if (options !== null && (typeof options !== 'object' || Array.isArray(options))) {
    return failureResult(['RELEASE_PAYLOAD_INVALID: options must be an object keyed by projection id'], notes);
  }
  const requestedOptions = options ?? {};
  let source;
  try {
    source = loadBundleSource(bundlePath);
  } catch (error) {
    return failureResult([error.message], notes);
  }

  const primitives = { inflateRaw, sha256: sha256Hex };
  const analysis = analyzeBundle(source.bytes, primitives, { path: basename(source.path) });
  if (!analysis.report.ok) {
    failures.push(...buildReportErrors(analysis.report));
    return failureResult(failures, notes);
  }
  const manifest = analysis.model.manifest;
  const id = manifest.id;
  const version = manifest.version;
  if (!isValidBundleId(id)) failures.push(`RELEASE_TAG_MISMATCH: bundle.json id ${String(id)} is not a valid bundle id`);
  if (!isValidVersion(version) || String(version).includes('+')) {
    failures.push(`RELEASE_VERSION_MISMATCH: bundle.json version ${String(version)} is not a valid semver without build metadata`);
  }

  const compiled = compileBundle(source.bytes, primitives, { path: basename(source.path) });
  if (!compiled.ok) {
    failures.push(...buildReportErrors(compiled.report));
    return failureResult(failures, notes);
  }
  const compiledWorkflowBytes = Buffer.from(compiled.compiledWorkflowBytes);
  const compiledWorkflow = JSON.parse(compiledWorkflowBytes.toString('utf8'));
  const compiledWorkflowDigest = compiled.digest;
  if (compiledWorkflow.id !== id || compiledWorkflow.version !== version) {
    failures.push(
      `RELEASE_TAG_MISMATCH: zip bundle.json ${id}@${version} != compiled workflow ${String(compiledWorkflow.id)}@${String(compiledWorkflow.version)}`,
    );
  }
  if (tag !== null) {
    const parsed = parseBundleTag(tag, id);
    if (parsed === null) {
      failures.push(`RELEASE_TAG_MISMATCH: ${tag} is not a bundle tag for ${id}`);
    } else if (parsed.version !== version) {
      failures.push(`RELEASE_TAG_MISMATCH: tag ${tag} carries ${parsed.version} but the zip/compiled workflow carry ${version}`);
    }
  }
  if (failures.length > 0) return failureResult(failures, notes);

  const declared = compiledWorkflow?.requires?.projections;
  const allowed = Array.isArray(declared) ? [...declared].sort(compareCodePoints) : [...CANONICAL_PROJECTIONS];
  if (allowed.length === 0) failures.push('RELEASE_ASSET_SET_MISMATCH: requires.projections is empty');
  for (const projectionId of allowed) {
    if (getProjection(projectionId) === null) {
      failures.push(`PROJECTION_NOT_REGISTERED: requires.projections names ${projectionId}`);
    }
  }
  if (failures.length > 0) return failureResult(failures, notes);

  const engine = readEngine(root);
  const rootPkg = readJsonFile(join(root, 'package.json'));
  const frameworkVersion = rootPkg?.version ?? null;
  const engineVersion = engine.version;
  if (!isValidVersion(frameworkVersion)) {
    failures.push(`RELEASE_VERSION_MISMATCH: framework package.json version ${String(frameworkVersion)} is not a valid semver`);
  }
  if (!isValidVersion(engineVersion)) {
    failures.push(`RELEASE_VERSION_MISMATCH: engine version ${String(engineVersion)} is not a valid semver`);
  }
  failures.push(...sourceProblemMessages(engine.problems, 'RELEASE_SOURCE_SET_MISMATCH'));
  const requiredEngine = compiledWorkflow?.requires?.engine;
  if (allowed.includes('runner')) {
    if (requiredEngine !== undefined) {
      if (!isValidRange(requiredEngine)) {
        failures.push(`RELEASE_ENGINE_UNSATISFIED: requires.engine ${String(requiredEngine)} is not a valid range`);
      } else if (!satisfiesRange(requiredEngine, engineVersion)) {
        failures.push(`RELEASE_ENGINE_UNSATISFIED: engine ${engineVersion} does not satisfy ${requiredEngine}`);
      }
    }
    failures.push(...engineSourceProblems(engine.files.map((file) => file.rel)));
  }
  if (failures.length > 0) return failureResult(failures, notes);

  const framework = collectFramework(root);
  failures.push(...sourceProblemMessages(framework.problems, 'RELEASE_SOURCE_SET_MISMATCH'));
  failures.push(...frameworkSourceProblems(framework.files.map((file) => file.rel)));
  if (failures.length > 0) return failureResult(failures, notes);

  const installSource = join(root, 'scripts/install.mjs');
  if (!existsSync(installSource)) {
    failures.push(`RELEASE_ASSET_SET_MISMATCH: ${INSTALL_ASSET} has no source at scripts/install.mjs`);
    return failureResult(failures, notes);
  }
  const installBytes = readFileSync(installSource);
  if (!installBytes.toString('utf8').startsWith('#!/usr/bin/env node')) {
    failures.push(`RELEASE_ASSET_SET_MISMATCH: scripts/install.mjs must start with "#!/usr/bin/env node"`);
  }

  const payloads = new Map();
  for (const projectionId of Object.keys(requestedOptions)) {
    if (!allowed.includes(projectionId)) {
      failures.push(`RELEASE_PROJECTION_NOT_ALLOWED: options name ${projectionId}, allowed: ${allowed.join(', ')}`);
    } else if (requestedOptions[projectionId] !== null
      && (typeof requestedOptions[projectionId] !== 'object' || Array.isArray(requestedOptions[projectionId]))) {
      failures.push(`RELEASE_PAYLOAD_INVALID: ${projectionId} options must be an object or null`);
    }
  }
  if (failures.length > 0) return failureResult(failures, notes);
  try {
    for (const projectionId of allowed) {
      payloads.set(projectionId, buildPayload({
        compiledWorkflow,
        compiledWorkflowDigest,
        id,
        version,
        projectionId,
        engineVersion,
        raw: requestedOptions[projectionId] ?? null,
      }));
    }
  } catch (error) {
    failures.push(error instanceof ReleaseError ? error.message : `RELEASE_PAYLOAD_INVALID: ${error.message}`);
    return failureResult(failures, notes);
  }

  // Only canonical options may become a Release; custom selections are local.
  const canonical = [...payloads.values()].every((payload) => payload.canonical);

  const assets = [];
  assets.push({ name: `bundle-${id}-v${version}.zip`, data: Buffer.from(source.bytes) });
  assets.push({ name: COMPILED_WORKFLOW_ASSET, data: compiledWorkflowBytes });
  for (const payload of payloads.values()) assets.push({ name: payload.file, data: payload.data });
  if (allowed.includes('runner')) {
    assets.push({ name: engineAssetName(engineVersion), data: engineArchive(engine.files) });
  }
  assets.push({ name: `hm2b-framework-${frameworkVersion}.tgz`, data: frameworkArchive(framework) });
  assets.push({ name: INSTALL_ASSET, data: installBytes });
  assets.push({ name: LAUNCHER_ASSET, data: launcherAsset({ id, version, allowed, repo, installerSha256: sha256Hex(installBytes) }) });
  assets.sort((left, right) => compareCodePoints(left.name, right.name));
  assets.push({ name: SUMS_ASSET, data: sumsBuffer(assets) });
  assets.sort((left, right) => compareCodePoints(left.name, right.name));

  const expected = bundleAssetNames({ id, version, allowed, engineVersion, frameworkVersion });
  const actual = assets.map((asset) => asset.name).sort(compareCodePoints);
  if (!sameValue(actual, expected)) {
    failures.push(`RELEASE_ASSET_SET_MISMATCH: built ${actual.join(', ')} but expected ${expected.join(', ')}`);
    return failureResult(failures, notes);
  }
  // Channel-neutral names are shared by design (#74 §2.3): `install.mjs`,
  // `SHA256SUMS.txt` and the byte-identical engine archive. Only the legacy
  // engine-version payload may never appear in a bundle Release.
  const legacyPayload = `r2c-payload-${engineVersion}.tgz`;
  for (const name of actual) {
    if (name === legacyPayload) {
      failures.push(`RELEASE_ASSET_SET_MISMATCH: ${name} belongs to the legacy engine channel`);
    }
  }

  if (source.directory) {
    notes.push(`packed ${basename(source.path)}/ into bundle-${id}-v${version}.zip`);
  }

  return {
    ok: failures.length === 0,
    failures,
    notes,
    assets: failures.length === 0 ? assets : null,
    plan: failures.length === 0 ? planFor({ id, version, assets }) : null,
    id,
    version,
    allowed,
    canonical,
    publishable: canonical,
    engineVersion,
    frameworkVersion,
    compiledWorkflow,
    compiledWorkflowBytes,
    compiledWorkflowDigest,
    payloads,
    projections: [...payloads.values()].map((payload) => ({
      id: payload.projectionId,
      digest: sha256Hex(canonicalJson(payload.result)),
      options: payload.manifest.options,
      manifest: payload.manifest,
    })),
    frameworkFiles: framework.files.map((file) => file.rel),
    engineFiles: engine.files.map((file) => file.rel),
  };
}

function archiveVersion(bytes, memberName, label, failures) {
  const { entries, problems } = readReleaseTarGz(bytes);
  for (const problem of problems) failures.push(`${label}: ${problem}`);
  const entry = entries.find((item) => item.path === memberName);
  if (entry === undefined) {
    failures.push(`${label} has no ${memberName}`);
    return null;
  }
  try {
    return JSON.parse(Buffer.from(entry.data).toString('utf8')).version ?? null;
  } catch (error) {
    failures.push(`${label}: ${memberName} is not valid JSON: ${error.message}`);
    return null;
  }
}

function checkOutDir({ outDir, built, failures }) {
  const absolute = resolve(outDir);
  if (!existsSync(absolute)) return;
  const entries = readdirSync(absolute).sort(compareCodePoints);
  if (entries.length === 0) return;
  const expected = built.assets.map((asset) => asset.name).sort(compareCodePoints);
  const missing = expected.filter((name) => !entries.includes(name));
  const extra = entries.filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    failures.push(
      `RELEASE_ASSET_SET_MISMATCH: ${absolute} missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`,
    );
  }
  for (const name of extra) {
    if (/^r2c-payload-\d/.test(name)) {
      failures.push(`RELEASE_ASSET_SET_MISMATCH: ${name} is a legacy channel payload, not a bundle asset`);
    }
  }
  const byName = new Map(built.assets.map((asset) => [asset.name, asset]));
  for (const name of expected) {
    const asset = byName.get(name);
    const file = join(absolute, name);
    if (asset === undefined || !existsSync(file)) continue;
    if (!readFileSync(file).equals(asset.data)) {
      failures.push(`${name} in ${absolute} is not byte-identical to the rebuilt asset`);
    }
  }
  const sumsFile = join(absolute, SUMS_ASSET);
  const sumsAsset = byName.get(SUMS_ASSET);
  if (existsSync(sumsFile) && sumsAsset !== undefined) {
    if (!readFileSync(sumsFile).equals(sumsAsset.data)) {
      failures.push(`${SUMS_ASSET} is not the sorted digest list of every other asset`);
    }
  }
  const installFile = join(absolute, INSTALL_ASSET);
  const installAsset = byName.get(INSTALL_ASSET);
  if (existsSync(installFile) && installAsset !== undefined && !readFileSync(installFile).equals(installAsset.data)) {
    failures.push(`${INSTALL_ASSET} in ${absolute} is not byte-identical to scripts/install.mjs`);
  }
  const zipFile = join(absolute, `bundle-${built.id}-v${built.version}.zip`);
  if (existsSync(zipFile) && !readFileSync(zipFile).equals(built.assets.find((asset) => asset.name.endsWith('.zip')).data)) {
    failures.push(`bundle-${built.id}-v${built.version}.zip in ${absolute} is not byte-identical to the source bundle`);
  }
}

/**
 * Pre-publish gate for the bundle channel. Builds twice and compares bytes
 * (determinism), then verifies a built directory when it exists.
 *
 * @returns {{ok: boolean, failures: string[], notes: string[], plan: object|null}}
 */
export function checkBundleRelease({ root, bundlePath, tag = null, outDir = null, repo = DEFAULT_RELEASE_REPO }) {
  const first = buildBundleRelease({ root, bundlePath, tag, repo });
  const failures = [...first.failures];
  const notes = [...first.notes];
  if (!first.ok) return { ok: false, failures, notes, plan: null };

  const second = buildBundleRelease({ root, bundlePath, tag, repo });
  if (!second.ok) {
    failures.push(...second.failures.map((failure) => `deterministic rebuild failed: ${failure}`));
  } else {
    const firstNames = first.assets.map((asset) => asset.name);
    const secondNames = second.assets.map((asset) => asset.name);
    if (!sameValue(firstNames, secondNames)) failures.push('deterministic rebuild produced a different asset set');
    for (const asset of first.assets) {
      const twin = second.assets.find((candidate) => candidate.name === asset.name);
      if (twin === undefined || !asset.data.equals(twin.data)) {
        failures.push(`${asset.name} is not byte-identical across two builds`);
      }
    }
  }

  const legacyPayload = `r2c-payload-${first.engineVersion}.tgz`;
  for (const name of first.plan.assets.map((asset) => asset.name)) {
    if (name === legacyPayload) {
      failures.push(`RELEASE_ASSET_SET_MISMATCH: ${name} crosses into the legacy channel`);
    }
  }
  if (first.plan.makeLatest !== false) failures.push('RELEASE_ASSET_SET_MISMATCH: bundle releases must set make_latest=false');

  const framework = first.assets.find((asset) => asset.name === `hm2b-framework-${first.frameworkVersion}.tgz`);
  if (framework !== undefined) {
    const frameworkVersion = archiveVersion(framework.data, 'package.json', framework.name, failures);
    if (frameworkVersion !== first.frameworkVersion) {
      failures.push(`${framework.name}: package.json version ${String(frameworkVersion)} != ${first.frameworkVersion}`);
    }
    const members = readReleaseTarGz(framework.data).entries.map((entry) => entry.path);
    const difference = first.frameworkFiles.filter((path) => !members.includes(path));
    if (difference.length > 0 || members.length !== first.frameworkFiles.length) {
      failures.push(`${framework.name} members do not match the framework source set`);
    }
  }
  if (first.allowed.includes('runner')) {
    const engineAsset = first.assets.find((asset) => asset.name === engineAssetName(first.engineVersion));
    if (engineAsset !== undefined) {
      const members = readReleaseTarGz(engineAsset.data).entries.map((entry) => entry.path);
      if (!sameValue([...members].sort(compareCodePoints), [...first.engineFiles].sort(compareCodePoints))) {
        failures.push(`${engineAsset.name} members do not match the engine source set`);
      }
      const version = archiveVersion(engineAsset.data, 'package.json', engineAsset.name, failures);
      if (version !== first.engineVersion) {
        failures.push(`${engineAsset.name}: package.json version ${String(version)} != ${first.engineVersion}`);
      }
    }
  }
  for (const payload of first.payloads.values()) {
    const problems = verifyPayloadArchive(payload.data, {
      id: first.id,
      version: first.version,
      compiledWorkflowDigest: first.compiledWorkflowDigest,
      contentSha256: first.compiledWorkflow?.source?.bundle?.contentSha256 ?? null,
      projectionId: payload.projectionId,
      options: payload.manifest.options,
      targets: payload.manifest.targets,
    });
    failures.push(...problems.map((problem) => `${payload.file}: ${problem}`));
  }
  if (outDir !== null) checkOutDir({ outDir, built: first, failures });
  return { ok: failures.length === 0, failures, notes, plan: first.plan };
}

/** Human-readable one-line summary used by `release.mjs --check`. */
export function describeBundleCheck(result) {
  if (!result.ok) return '';
  const plan = result.plan;
  return `bundle release --check ok: ${plan.tag}, ${plan.assets.length} assets, make_latest=${String(plan.makeLatest)}`;
}
