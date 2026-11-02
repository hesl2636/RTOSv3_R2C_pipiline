/**
 * Per-bundle Release assembly (#105, decisions #74 / #63, spec §13/§15).
 *
 * One `(bundle.id, bundle.version)` is one self-contained Release, tag
 * `bundle-<id>-v<version>`. The asset set is a pure function of the bundle
 * zip, the framework checkout and the engine checkout:
 *
 *   bundle-<id>-v<version>.zip          always
 *   workflow.ir.json                    always
 *   r2c-payload-<id>-v<version>.tgz     r2c in requires.projections
 *   agent-native-<id>-v<version>.tgz    agent-native in requires.projections
 *   r2c-engine-<E>.tgz                  r2c in requires.projections
 *   r2c-framework-<F>.tgz               always (framework sources + installer/)
 *   install.mjs                         always, byte-identical to scripts/install.mjs
 *   SHA256SUMS.txt                      always, covers every other asset
 *
 * The payloads are pre-projected with canonical options, validated V1–V12,
 * packed deterministically and accompanied by `manifest.json`
 * (`r2c.release-payload/v1`). Installation never compiles or projects again.
 *
 * No legacy asset is produced here: `r2c-payload-<E>.tgz` belongs to the
 * `v<E>` channel, and the two tag namespaces never overlap.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { inflateRaw } from '../../core/node/inflate.js';
import { sha256Hex } from '../../core/node/sha256.js';
import { analyzeBundle, compileBundle } from '../../assembler/index.js';
import { canonicalJson, isCanonicalJson } from '../../core/canonical-json.js';
import { compareCodePoints } from '../../core/code-point.js';
import { foldCase, hasFileDirPrefixConflict } from '../../core/paths.js';
import { isValidRange, isValidVersion, satisfiesRange } from '../../core/semver.js';
import { IR_FILENAME } from '../../ir/schema.js';
import { normalizeOptions } from '../../projection/options.js';
import { project } from '../../projection/project.js';
import { defaultTargets, getProjection } from '../../projection/registry.js';
import { validateResult } from '../../projection/validate-result.js';
import { collectEngine } from '../../src/engine.js';
import { createTarGz } from '../../src/plugin.js';
import { collectBundleFiles } from './file-set.mjs';
import { createReleaseTarGz, readReleaseTarGz, releasePathProblem } from './release-tar.mjs';
import { writeZip } from './zip-writer.mjs';

export const RELEASE_PAYLOAD_SCHEMA = 'r2c.release-payload/v1';
export const PAYLOAD_MANIFEST_NAME = 'manifest.json';
export const IR_ASSET = IR_FILENAME;
export const INSTALL_ASSET = 'install.mjs';
export const SUMS_ASSET = 'SHA256SUMS.txt';
export const BUNDLE_MAKE_LATEST = false;
export const CANONICAL_PROJECTIONS = Object.freeze(['r2c', 'agent-native']);

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?`;
const TAG_PATTERN = String.raw`^bundle-<ID>-v(${TAG_VERSION})$`;
const LEGACY_TAG_PATTERN = new RegExp(String.raw`^v(${TAG_VERSION})$`);

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
const FRAMEWORK_ROOT_FILES = Object.freeze(['package.json', 'LICENSE', 'bin/r2c-assembler.js']);
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isValidBundleId(id) {
  return typeof id === 'string' && ID_RE.test(id) && id.length <= 40;
}

/** The only bundle tag shape; parsing always anchors on the known id. */
export function bundleTag(id, version) {
  return `bundle-${id}-v${version}`;
}

/**
 * Parse `bundle-<id>-v<version>` from right to left with an anchored regex
 * built from the known id (#74 §2.1). Returns `{id, version}` or null.
 * Never `split('-v')`, never guesses the id, never accepts build metadata.
 */
export function parseBundleTag(tag, id) {
  if (typeof tag !== 'string' || !isValidBundleId(id)) return null;
  if (tag.includes('+')) return null;
  const pattern = new RegExp(TAG_PATTERN.replace('<ID>', escapeRegExp(id)));
  const match = pattern.exec(tag);
  if (match === null) return null;
  if (!isValidVersion(match[1])) return null;
  return { id, version: match[1] };
}

/** `v<engine>` is the legacy channel; the two namespaces are disjoint. */
export function isLegacyEngineTag(tag) {
  if (typeof tag !== 'string' || tag.includes('+')) return false;
  const match = LEGACY_TAG_PATTERN.exec(tag);
  return match !== null && isValidVersion(match[1]);
}

/**
 * The exact asset names of one bundle Release, sorted by code point.
 * `allowed` is `ir.requires.projections` (default: both projections).
 */
export function bundleAssetNames({ id, version, allowed, engineVersion, frameworkVersion }) {
  const names = [
    INSTALL_ASSET,
    IR_ASSET,
    `bundle-${id}-v${version}.zip`,
    `r2c-framework-${frameworkVersion}.tgz`,
  ];
  if (allowed.includes('r2c')) {
    names.push(`r2c-payload-${id}-v${version}.tgz`, `r2c-engine-${engineVersion}.tgz`);
  }
  if (allowed.includes('agent-native')) names.push(`agent-native-${id}-v${version}.tgz`);
  names.push(SUMS_ASSET);
  return [...new Set(names)].sort(compareCodePoints);
}

/** The four legacy `v<E>` asset names, for cross-channel isolation checks. */
export function legacyAssetNames(engineVersion) {
  return [
    INSTALL_ASSET,
    SUMS_ASSET,
    `r2c-engine-${engineVersion}.tgz`,
    `r2c-payload-${engineVersion}.tgz`,
  ].sort(compareCodePoints);
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
    if (rel.startsWith('bin/') && rel !== 'bin/r2c-assembler.js' && !rel.startsWith('bin/assembler/')) {
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
 * Engine version and file set. #111 moves the engine to
 * `runtime/r2c/engine/`; until then the root package is the engine home and
 * the root version is E (documented fallback, ticket #105).
 */
export function readEngine(root) {
  const nested = join(root, 'runtime/r2c/engine/package.json');
  if (existsSync(nested)) {
    const pkg = readJsonFile(nested);
    const engineRoot = join(root, 'runtime/r2c/engine');
    const dirs = ['bin', 'src', 'schema', 'node_modules/yaml']
      .filter((dir) => existsSync(join(engineRoot, dir)))
      .map((dir) => ({ from: dir, rel: dir }));
    const files = [];
    const problems = [];
    const walk = (dir, prefix) => {
      for (const name of readdirSync(dir).sort(compareCodePoints)) {
        const absolute = join(dir, name);
        const rel = `${prefix}/${name}`;
        const stat = lstatSync(absolute, { throwIfNoEntry: false });
        if (stat === undefined) continue;
        if (stat.isSymbolicLink()) {
          problems.push(`symlink not allowed in engine archive: ${rel}`);
        } else if (stat.isDirectory()) walk(absolute, rel);
        else if (stat.isFile()) files.push({ rel, absolute });
        else problems.push(`unsupported file type in engine archive: ${rel}`);
      }
    };
    for (const dir of dirs) walk(join(engineRoot, dir.from), dir.rel);
    for (const name of ['package.json', 'LICENSE']) {
      const absolute = join(engineRoot, name);
      if (!existsSync(absolute)) problems.push(`missing engine archive file: ${name}`);
      else files.push({ rel: name, absolute });
    }
    files.sort((left, right) => compareCodePoints(left.rel, right.rel));
    return { version: pkg?.version ?? null, files, problems };
  }

  const rootPkg = readJsonFile(join(root, 'package.json'));
  const collected = collectEngine(root);
  return {
    version: rootPkg?.version ?? null,
    files: collected.files,
    problems: collected.problems,
  };
}

function validateProjectionOptions({ projectionId, ir, irDigest }) {
  const descriptor = getProjection(projectionId);
  const options = { stageOrder: null, skills: null, targets: defaultTargets(projectionId) };
  const normalized = normalizeOptions({
    projectionId,
    ir,
    irDigest,
    raw: options,
    manifest: descriptor,
  });
  return { descriptor, options, normalized };
}

function payloadFileName(projectionId, id, version) {
  return projectionId === 'r2c'
    ? `r2c-payload-${id}-v${version}.tgz`
    : `agent-native-${id}-v${version}.tgz`;
}

/**
 * Build the canonical payload manifest for one projection. `options` records
 * the canonical *input* (nulls), never `result.options`.
 */
export function buildPayloadManifest({ id, version, projection, ir, irDigest, options, targets, files }) {
  const sorted = [...files]
    .map((file) => ({
      path: file.path,
      mode: file.mode,
      sha256: sha256Hex(Buffer.from(file.content, 'utf8')),
      kind: file.kind,
      targets: [...file.targets],
    }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  return {
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
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Self-proof of one payload archive: member set == manifest set, member hashes
 * == manifest hashes, deterministic metadata, canonical manifest bytes.
 */
export function verifyPayloadArchive(bytes, expected) {
  const problems = [];
  const { entries, problems: readProblems } = readReleaseTarGz(bytes);
  problems.push(...readProblems);
  const memberPaths = entries.map((entry) => entry.path);
  if (!sameValue(memberPaths, [...memberPaths].sort(compareCodePoints))) {
    problems.push('payload members are not sorted by path');
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get(PAYLOAD_MANIFEST_NAME);
  if (manifestEntry === undefined) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} is missing from the payload`);
    return problems;
  }
  const text = Buffer.from(manifestEntry.data).toString('utf8');
  if (!isCanonicalJson(text)) problems.push(`${PAYLOAD_MANIFEST_NAME} is not canonical JSON`);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} is not valid JSON: ${error.message}`);
    return problems;
  }
  if (manifest?.schema !== RELEASE_PAYLOAD_SCHEMA) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} schema is ${String(manifest?.schema)}`);
  }
  if (!sameValue(manifest?.bundle, { id: expected.id, version: expected.version })) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} bundle ${JSON.stringify(manifest?.bundle)} does not match ${expected.id}@${expected.version}`);
  }
  if (manifest?.ir?.digest !== expected.irDigest) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} ir.digest does not match the IR bytes`);
  }
  if (manifest?.ir?.contentSha256 !== expected.contentSha256) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} ir.contentSha256 does not match the IR source`);
  }
  if (manifest?.projection?.id !== expected.projectionId) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} projection.id is ${String(manifest?.projection?.id)}`);
  }
  if (!isValidVersion(manifest?.projection?.version)) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} projection.version is not a semver`);
  }
  if (!sameValue(manifest?.options, expected.options)) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} options do not record the canonical input`);
  }
  if (!sameValue(manifest?.targets, expected.targets)) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} targets do not match the projection`);
  }

  const declared = Array.isArray(manifest?.files) ? manifest.files : [];
  const declaredPaths = declared.map((file) => file?.path);
  const sorted = [...declaredPaths].sort(compareCodePoints);
  if (!sameValue(declaredPaths, sorted)) problems.push(`${PAYLOAD_MANIFEST_NAME} files are not sorted by path`);
  if (new Set(declaredPaths.map(foldCase)).size !== declaredPaths.length) {
    problems.push(`${PAYLOAD_MANIFEST_NAME} has duplicate paths`);
  }
  for (let index = 0; index < declaredPaths.length; index += 1) {
    for (let other = index + 1; other < declaredPaths.length; other += 1) {
      if (hasFileDirPrefixConflict(declaredPaths[index], declaredPaths[other])) {
        problems.push(`${PAYLOAD_MANIFEST_NAME} paths conflict: ${declaredPaths[index]} / ${declaredPaths[other]}`);
      }
    }
  }
  const expectedMembers = new Set(declaredPaths.map((path) => `files/${path}`));
  expectedMembers.add(PAYLOAD_MANIFEST_NAME);
  for (const entry of entries) {
    if (!expectedMembers.has(entry.path)) problems.push(`payload member is not declared: ${entry.path}`);
    if (entry.mtime !== 0 || entry.uid !== 0 || entry.gid !== 0) {
      problems.push(`payload member has non-zero metadata: ${entry.path}`);
    }
  }
  if (entries.length !== expectedMembers.size) {
    problems.push(`payload member count ${entries.length} does not match the manifest (${expectedMembers.size})`);
  }
  const targets = new Set(manifest?.targets ?? []);
  const covered = new Set();
  for (const file of declared) {
    if (file === null || typeof file !== 'object') {
      problems.push(`${PAYLOAD_MANIFEST_NAME} has a non-object file entry`);
      continue;
    }
    if (file.mode !== 0o644 && file.mode !== 0o755) problems.push(`${file.path}: mode must be 0644 or 0755`);
    if (!Array.isArray(file.targets) || file.targets.length === 0) {
      problems.push(`${file.path}: targets must be a non-empty array`);
    } else {
      for (const target of file.targets) {
        covered.add(target);
        if (!targets.has(target)) problems.push(`${file.path}: target ${target} is not in targets`);
      }
    }
    if (typeof file.kind !== 'string' || file.kind === '') problems.push(`${file.path}: kind is missing`);
    const member = byPath.get(`files/${file.path}`);
    if (member === undefined) {
      problems.push(`payload file is listed but missing: ${file.path}`);
      continue;
    }
    if (member.mode !== file.mode) problems.push(`${file.path}: archive mode ${member.mode} != manifest ${file.mode}`);
    const digest = sha256Hex(Buffer.from(member.data));
    if (digest !== file.sha256) problems.push(`${file.path}: archive hash does not match the manifest`);
  }
  for (const target of manifest?.targets ?? []) {
    if (!covered.has(target)) problems.push(`payload target ${target} has no files`);
  }
  return problems;
}

function payloadEntries(result) {
  return result.files.map((file) => ({
    path: `files/${file.path}`,
    data: Buffer.from(file.content, 'utf8'),
    mode: file.mode,
  }));
}

function buildPayload({ ir, irDigest, id, version, projectionId, engineVersion }) {
  const { descriptor, options, normalized } = validateProjectionOptions({ projectionId, ir, irDigest });
  if (!normalized.ok) {
    throw new ReleaseError(
      'RELEASE_PAYLOAD_INVALID',
      `${projectionId} canonical options are invalid: ${normalized.errors.map((error) => error.message).join('; ')}`,
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

  const manifest = buildPayloadManifest({
    id,
    version,
    projection: descriptor,
    ir,
    irDigest,
    options,
    targets: result.targets,
    files: result.files,
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
  };
}

function frameworkArchive(collection) {
  return createReleaseTarGz(
    collection.files.map((file) => ({ path: file.rel, data: file.data(), mode: 0o644 })),
  );
}

function engineArchive(files) {
  // The engine asset is byte-identical in both channels (#74 §2.3), so it
  // uses the legacy deterministic writer unchanged.
  return createTarGz(files.map((file) => ({ path: file.rel, data: readFileSync(file.absolute) })));
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
 * @param {{root: string, bundlePath: string, tag?: string|null}} input
 * @returns {{ok: boolean, failures: string[], notes: string[], assets: Array<{name: string, data: Buffer}>|null, plan: object|null}}
 */
export function buildBundleRelease({ root, bundlePath, tag = null }) {
  const failures = [];
  const notes = [];
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
  if (allowed.includes('r2c')) {
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
  try {
    for (const projectionId of allowed) {
      payloads.set(projectionId, buildPayload({
        ir,
        irDigest,
        id,
        version,
        projectionId,
        engineVersion,
      }));
    }
  } catch (error) {
    failures.push(error instanceof ReleaseError ? error.message : `RELEASE_PAYLOAD_INVALID: ${error.message}`);
    return failureResult(failures, notes);
  }

  const assets = [];
  assets.push({ name: `bundle-${id}-v${version}.zip`, data: Buffer.from(source.bytes) });
  assets.push({ name: IR_ASSET, data: irBytes });
  for (const payload of payloads.values()) assets.push({ name: payload.file, data: payload.data });
  if (allowed.includes('r2c')) {
    assets.push({ name: `r2c-engine-${engineVersion}.tgz`, data: engineArchive(engine.files) });
  }
  assets.push({ name: `r2c-framework-${frameworkVersion}.tgz`, data: frameworkArchive(framework) });
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
    engineVersion,
    frameworkVersion,
    ir,
    irBytes,
    irDigest,
    payloads,
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

  const framework = first.assets.find((asset) => asset.name === `r2c-framework-${first.frameworkVersion}.tgz`);
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
  if (first.allowed.includes('r2c')) {
    const engineAsset = first.assets.find((asset) => asset.name === `r2c-engine-${first.engineVersion}.tgz`);
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
