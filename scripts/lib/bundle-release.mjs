/**
 * Per-bundle Release assembly (#105, decisions #74 / #63, spec §13/§15).
 *
 * One `(bundle.id, bundle.version)` is one self-contained Release, tag
 * `bundle-<id>-v<version>`. The asset set is a pure function of the bundle
 * zip, the framework checkout and the engine checkout:
 *
 *   bundle-<id>-v<version>.zip          always
 *   workflow.ir.json                    always
 *   hm2b-payload-<id>-v<version>.tgz    runner in requires.projections
 *   agent-native-<id>-v<version>.tgz    agent-native in requires.projections
 *   hm2b-engine-<E>.tgz                 runner in requires.projections
 *   hm2b-framework-<F>.tgz              always (framework sources + installer/)
 *   install.mjs                         always, byte-identical to scripts/install.mjs
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
  IR_ASSET,
  SUMS_ASSET,
  bundleAssetNames,
  bundleTag,
  isLegacyEngineTag,
  isValidBundleId,
  legacyAssetNames,
  parseBundleTag,
} from '../../installer/release-tags.js';
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
  IR_ASSET,
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
  'ir',
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
function validateProjectionOptions({ projectionId, ir, irDigest, raw = null }) {
  const descriptor = getProjection(projectionId);
  const normalized = normalizeOptions({
    projectionId,
    ir,
    irDigest,
    raw,
    manifest: descriptor,
  });
  const canonical = normalized.ok && isCanonicalOptions({
    projectionId,
    ir,
    irDigest,
    options: normalized.options,
    manifest: descriptor,
  });
  const options = canonical || !normalized.ok
    ? canonicalInputOptions(projectionId, descriptor)
    : payloadInputOptions({
      projectionId,
      ir,
      irDigest,
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
export function buildPayloadManifest({ id, version, projection, ir, irDigest, options, targets, files, result = null }) {
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
    ir: {
      digest: irDigest,
      contentSha256: ir?.source?.bundle?.contentSha256 ?? null,
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
 * IR assets are part of the projected result, not bundle-internal bytes: a
 * Release whose IR carries an asset kind must ship one payload member per
 * declared asset, otherwise the install would silently drop the asset. Paths
 * are projection-owned, so the proof is by kind and count, not by IR path.
 */
function missingIrAssetKinds(ir, result) {
  const present = new Map();
  for (const file of result.files) present.set(file.kind, (present.get(file.kind) ?? 0) + 1);
  const missing = [];
  const need = (kind, count) => {
    const actual = present.get(kind) ?? 0;
    if (actual < count) missing.push(`${kind} (${actual}/${count})`);
  };
  need('knowledge', (ir.knowledgeBase ?? []).length);
  need('checklist', (ir.checklists ?? []).length);
  need('hooks', ir.hooks === null || ir.hooks === undefined ? 0 : 1);
  need('mcp', ir.mcp === null || ir.mcp === undefined ? 0 : 1);
  return missing;
}

function buildPayload({ ir, irDigest, id, version, projectionId, engineVersion, raw = null }) {
  const { descriptor, options, canonical, normalized } = validateProjectionOptions({
    projectionId,
    ir,
    irDigest,
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
    ir,
    irDigest,
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
    ir,
    irDigest,
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
  const missingAssets = missingIrAssetKinds(ir, result);
  if (missingAssets.length > 0) {
    throw new ReleaseError(
      'RELEASE_PAYLOAD_INVALID',
      `${projectionId} projection omitted IR assets: ${missingAssets.join(', ')}`,
    );
  }

  const manifest = buildPayloadManifest({
    id,
    version,
    projection: descriptor,
    ir,
    irDigest,
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
    irDigest,
    contentSha256: ir?.source?.bundle?.contentSha256 ?? null,
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
 * Assemble every asset of one bundle Release in memory.
 *
 * @param {{root: string, bundlePath: string, tag?: string|null, options?: object|null}} input
 * @returns {{ok: boolean, failures: string[], notes: string[], assets: Array<{name: string, data: Buffer}>|null, plan: object|null}}
 */
export function buildBundleRelease({ root, bundlePath, tag = null, options = null }) {
  const failures = [];
  const notes = [];
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
  const irBytes = Buffer.from(compiled.irBytes);
  const ir = JSON.parse(irBytes.toString('utf8'));
  const irDigest = compiled.digest;
  if (ir.id !== id || ir.version !== version) {
    failures.push(
      `RELEASE_TAG_MISMATCH: zip bundle.json ${id}@${version} != IR ${String(ir.id)}@${String(ir.version)}`,
    );
  }
  if (tag !== null) {
    const parsed = parseBundleTag(tag, id);
    if (parsed === null) {
      failures.push(`RELEASE_TAG_MISMATCH: ${tag} is not a bundle tag for ${id}`);
    } else if (parsed.version !== version) {
      failures.push(`RELEASE_TAG_MISMATCH: tag ${tag} carries ${parsed.version} but the zip/IR carry ${version}`);
    }
  }
  if (failures.length > 0) return failureResult(failures, notes);

  const declared = ir?.requires?.projections;
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
  const requiredEngine = ir?.requires?.engine;
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
        ir,
        irDigest,
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
  assets.push({ name: IR_ASSET, data: irBytes });
  for (const payload of payloads.values()) assets.push({ name: payload.file, data: payload.data });
  if (allowed.includes('runner')) {
    assets.push({ name: engineAssetName(engineVersion), data: engineArchive(engine.files) });
  }
  assets.push({ name: `hm2b-framework-${frameworkVersion}.tgz`, data: frameworkArchive(framework) });
  assets.push({ name: INSTALL_ASSET, data: installBytes });
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
    ir,
    irBytes,
    irDigest,
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
export function checkBundleRelease({ root, bundlePath, tag = null, outDir = null }) {
  const first = buildBundleRelease({ root, bundlePath, tag });
  const failures = [...first.failures];
  const notes = [...first.notes];
  if (!first.ok) return { ok: false, failures, notes, plan: null };

  const second = buildBundleRelease({ root, bundlePath, tag });
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
      irDigest: first.irDigest,
      contentSha256: first.ir?.source?.bundle?.contentSha256 ?? null,
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
