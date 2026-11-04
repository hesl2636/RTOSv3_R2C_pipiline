/**
 * Install one already-published bundle Release (#106, decisions #74 / #76,
 * spec §12–§13).
 *
 * The installer consumes the Release assets it was handed and does exactly
 * four things: verify, unpack, write, receipt. It never validates a bundle,
 * compiles a compiled workflow or runs a projection; the pre-projected payload is the
 * authority.
 *
 * Three-way verification before any write:
 *   1. every used asset hashes to its `SHA256SUMS.txt` entry, and the sums
 *      names are exactly the asset set the bundle's `requires` implies;
 *   2. the zip's `bundle.json` (id/version/manifest digest) and the compiled workflow's
 *      `source.bundle.contentSha256` agree with each other, with the asset
 *      names and with the payload manifest's `compiledWorkflow` block;
 *   3. the payload's member set and hashes agree with its manifest, and the
 *      rebuilt projection result re-passes V1–V12.
 *
 * Failures are values `{ok:false, code, message, exitCode}` and happen before
 * the first syscall that writes into the project.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzeBundle } from '../assembler/index.js';
import { bundleContentSha256 } from '../assembler/compile.js';
import { compareCodePoints } from '../core/code-point.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { isValidVersion } from '../core/semver.js';
import { canonicalInputOptions, normalizeOptions } from '../projection/options.js';
import { checkEngineRequirement as evaluateEngineRequirement } from '../projection/engine-requirement.js';
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import {
  PAYLOAD_MANIFEST_NAME,
  readPayloadArchive,
  resultFromPayload,
  verifyPayloadArchive,
} from './release-payload.js';
import {
  SUMS_ASSET,
  bundleAssetNames,
  isValidBundleId,
} from './release-tags.js';
import { parseSums, verifySums } from './release-source.js';
import { installProjection } from './install.js';
import { installRunnerProject } from './runner.js';
import { ENGINE_ROOT, RUNTIME_RECEIPT_PATH, installRuntime } from './runtime.js';
import { readReleaseTarGz } from './release-tar.js';
import { projectPath } from './paths.js';
import { lstatOrNull, pruneEmptyDir, unlinkIfExists } from './util.js';
import { sorted } from '../core/sort.js';
import { COMPILED_WORKFLOW_SCHEMA } from '../compiled/schema.js';

/** Exit codes of the release-install surface (decision #74 §5.2). */
export const RELEASE_EXIT = Object.freeze({ OK: 0, INTEGRITY: 2 });

const DEFAULT_PROJECTIONS = Object.freeze(['runner', 'agent-native']);
const FRAMEWORK_ASSET = /^hm2b-framework-(.+)\.tgz$/;
const ENGINE_ASSET = /^hm2b-engine-(.+)\.tgz$/;

function failure(code, message, { exitCode = RELEASE_EXIT.INTEGRITY, details = null } = {}) {
  return { ok: false, code, message: `${code}: ${message}`, exitCode, details };
}

/** `requires.projections` with its default, or `null` when it is malformed. */
export function allowedProjections(compiledWorkflow) {
  const declared = compiledWorkflow?.requires?.projections;
  if (declared === undefined || declared === null) return [...DEFAULT_PROJECTIONS];
  if (!Array.isArray(declared) || declared.length === 0) return null;
  if (declared.some((id) => typeof id !== 'string' || id === '')) return null;
  return [...new Set(declared)];
}

/**
 * Resolve `--projection` against `requires.projections`: an explicit choice
 * outside the whitelist is a hard refusal (never a silent fallback), and two
 * allowed projections need an explicit choice.
 */
export function selectProjection({ allowed, requested } = {}) {
  const list = Array.isArray(allowed) && allowed.length > 0 ? [...allowed] : [...DEFAULT_PROJECTIONS];
  const unregistered = list.filter((id) => getProjection(id) === null);
  if (unregistered.length > 0) {
    return failure(
      'RELEASE_PROJECTION_NOT_ALLOWED',
      `requires.projections names an unregistered projection: ${unregistered.join(', ')}`,
    );
  }
  if (requested === undefined || requested === null) {
    if (list.length === 1) return { ok: true, projection: list[0] };
    return failure(
      'RELEASE_PROJECTION_REQUIRED',
      `the bundle allows ${list.join(', ')}; pass --projection <${list.join('|')}>`,
    );
  }
  if (getProjection(requested) === null) {
    return failure('RELEASE_PROJECTION_NOT_ALLOWED', `--projection ${requested} is not a registered projection`);
  }
  if (!list.includes(requested)) {
    return failure(
      'RELEASE_PROJECTION_NOT_ALLOWED',
      `--projection ${requested} is not allowed by requires.projections (${list.join(', ')})`,
    );
  }
  return { ok: true, projection: requested };
}

/**
 * `requires.engine` only constrains runner (spec §13). The evaluation lives in
 * `projection/engine-requirement.js` so the web build applies exactly the
 * same rule; this wrapper adds the Release exit code.
 */
export function checkEngineRequirement(input = {}) {
  const result = evaluateEngineRequirement(input);
  if (result.ok) return result;
  return failure(result.code, result.message);
}

/** The last path segment of an asset name, for messages. */
function assetNameList(names) {
  return sorted(names).join(', ');
}

function pickAsset(sumsNames, pattern) {
  return sumsNames.filter((name) => pattern.test(name));
}

/**
 * Rebuild the projection result from the payload and prove it is the one the
 * publisher validated: manifest shape, member self-proof, canonical options
 * and V1–V12 against the Release compiled workflow.
 */
function verifyPayload({ payloadBytes, compiledWorkflow, compiledWorkflowDigest, descriptor, canonical, id, version }) {
  const parsed = readPayloadArchive(payloadBytes);
  if (parsed.manifest !== null
    && JSON.stringify(parsed.manifest.options) !== JSON.stringify(canonical.options)) {
    return failure(
      'RELEASE_PAYLOAD_INVALID',
      'the payload was built with custom projection options; a Release payload is canonical. Re-project the published compiled workflow with the framework CLI or the web front end and install that result',
      { details: { expected: canonical.options, actual: parsed.manifest.options } },
    );
  }
  const problems = verifyPayloadArchive(payloadBytes, {
    id,
    version,
    compiledWorkflowDigest,
    contentSha256: compiledWorkflow?.source?.bundle?.contentSha256 ?? null,
    projectionId: descriptor.id,
    options: canonical.options,
    targets: canonical.targets,
  });
  if (problems.length > 0) {
    return failure('RELEASE_PAYLOAD_INVALID', `payload self-proof failed: ${problems.join('; ')}`, {
      details: { problems },
    });
  }
  const { entries, manifest, problems: readProblems } = parsed;
  if (readProblems.length > 0 || manifest === null) {
    return failure('RELEASE_PAYLOAD_INVALID', `payload manifest is unreadable: ${readProblems.join('; ')}`, {
      details: { problems: readProblems },
    });
  }
  const rebuilt = resultFromPayload(manifest, entries);
  if (rebuilt.result === null) {
    return failure('RELEASE_PAYLOAD_INVALID', `payload result is incomplete: ${rebuilt.problems.join('; ')}`, {
      details: { problems: rebuilt.problems },
    });
  }
  const result = rebuilt.result;
  if (JSON.stringify(result.options) !== JSON.stringify(canonical.normalized)) {
    return failure(
      'RELEASE_PAYLOAD_INVALID',
      'the payload was built with custom projection options; a Release payload is canonical. Re-project the published compiled workflow with the framework CLI or the web front end and install that result',
      { details: { expected: canonical.normalized, actual: result.options } },
    );
  }
  if (JSON.stringify(result.targets) !== JSON.stringify(canonical.targets)) {
    return failure('RELEASE_PAYLOAD_INVALID', `${PAYLOAD_MANIFEST_NAME} result.targets do not match the canonical targets`);
  }
  const validation = validateResult(result, {
    compiledWorkflow,
    compiledWorkflowDigest,
    manifest: descriptor,
    options: canonical.normalized,
    environment: result.environment,
    assets: {},
  });
  if (!validation.ok) {
    return failure('RELEASE_PAYLOAD_INVALID', 'the rebuilt result failed V1–V12', {
      details: { diagnostics: validation.diagnostics },
    });
  }
  return { ok: true, result, manifest };
}

/** Zip ↔ compiled workflow: `bundle.json` identity + manifest digest + content digest. */
function verifyZip({ zipBytes, compiledWorkflow, id, version }) {
  const analysis = analyzeBundle(zipBytes, { sha256: sha256Hex, inflateRaw });
  if (analysis.report.errors.length > 0) {
    return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', `the bundle zip is not valid: ${analysis.report.errors[0].message}`);
  }
  const manifest = analysis.model.manifest;
  if (manifest?.id !== id || manifest?.version !== version) {
    return failure(
      'RELEASE_TAG_MISMATCH',
      `the zip manifest is ${String(manifest?.id)}@${String(manifest?.version)}, the Release is ${id}@${version}`,
    );
  }
  const entry = analysis.model.entries.get(compiledWorkflow?.source?.manifest?.path ?? 'bundle.json');
  if (entry === undefined) {
    return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', `the compiled workflow names ${String(compiledWorkflow?.source?.manifest?.path)}, which the zip does not carry`);
  }
  if (sha256Hex(entry.data) !== compiledWorkflow?.source?.manifest?.sha256) {
    return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', 'the zip bundle.json digest does not match the compiled workflow source manifest');
  }
  for (const [path, digest] of verifyIrSources({ compiledWorkflow })) {
    const member = analysis.model.entries.get(path);
    if (member === undefined) return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', `the compiled workflow names ${path}, which the zip does not carry`);
    if (sha256Hex(member.data) !== digest) return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', `${path}: the zip bytes do not match the compiled workflow source digest`);
  }
  const content = bundleContentSha256({ sha256: sha256Hex }, analysis.model);
  if (content !== compiledWorkflow?.source?.bundle?.contentSha256) {
    return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', 'the zip content digest does not match compiled workflow source.bundle.contentSha256', {
      details: { expected: compiledWorkflow?.source?.bundle?.contentSha256, actual: content },
    });
  }
  return { ok: true };
}

/** Every compiled workflow entity's `source` must name a zip member with that digest. */
function verifyIrSources({ compiledWorkflow }) {
  const sources = new Map();
  const add = (source) => {
    if (source === null || typeof source !== 'object') return;
    if (typeof source.path !== 'string' || typeof source.sha256 !== 'string') return;
    sources.set(source.path, source.sha256);
  };
  for (const stage of compiledWorkflow.stages ?? []) add(stage.source);
  for (const map of [compiledWorkflow.roles, compiledWorkflow.tasks, compiledWorkflow.skills]) {
    for (const value of Object.values(map ?? {})) add(value?.source);
  }
  for (const item of compiledWorkflow.knowledgeBase ?? []) add(item?.source);
  for (const item of compiledWorkflow.checklists ?? []) add(item?.source);
  add(compiledWorkflow.hooks?.source);
  add(compiledWorkflow.mcp?.source);
  for (const mount of compiledWorkflow.constitution ?? []) add(mount?.source);
  return sources;
}

/**
 * Verify one Release end to end without writing anything.
 *
 * Input: `{bundleId, version, projection, targets, sumsBytes, assets}` where
 * `assets` maps every downloaded asset name to its bytes. Returns
 * `{ok:true, ...facts}` or `{ok:false, code, message, exitCode}`.
 */
export function verifyRelease(input = {}) {
  const bundleId = input.bundleId;
  const version = input.version;
  if (!isValidBundleId(bundleId)) {
    return failure('RELEASE_OPTION_CONFLICT', `--bundle must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got ${JSON.stringify(bundleId)})`);
  }
  if (typeof version !== 'string' || !isValidVersion(version) || version.includes('+')) {
    return failure('RELEASE_OPTION_CONFLICT', `--version must be a bare semver (got ${JSON.stringify(version)})`);
  }
  const assets = input.assets ?? {};
  const tag = `bundle-${bundleId}-v${version}`;

  // 1) SHA256SUMS: parse, discover the versioned asset names, prove the set.
  const sums = parseSums(input.sumsBytes);
  if (sums.failures.length > 0) {
    return failure('RELEASE_CHECKSUM_MISMATCH', sums.failures.join('; '), { details: { failures: sums.failures } });
  }
  const names = [...sums.entries.keys()];
  const frameworks = pickAsset(names, FRAMEWORK_ASSET);
  const engines = pickAsset(names, ENGINE_ASSET);
  if (frameworks.length !== 1) {
    return failure(
      'RELEASE_FRAMEWORK_MISSING',
      frameworks.length === 0
        ? `${SUMS_ASSET} lists no hm2b-framework-<F>.tgz`
        : `${SUMS_ASSET} lists several framework assets: ${assetNameList(frameworks)}`,
    );
  }
  const frameworkVersion = FRAMEWORK_ASSET.exec(frameworks[0])[1];
  if (!isValidVersion(frameworkVersion)) {
    return failure('RELEASE_ASSET_SET_MISMATCH', `framework asset does not carry a semver: ${frameworks[0]}`);
  }

  // 2) compiled workflow identity, projection whitelist and the expected asset set.
  const compiledWorkflowAsset = assets['workflow.compiled.json'];
  if (!(compiledWorkflowAsset instanceof Uint8Array) && !Buffer.isBuffer(compiledWorkflowAsset)) {
    return failure('RELEASE_NOT_FOUND', `${SUMS_ASSET} is present but workflow.compiled.json was not downloaded`);
  }
  const compiledWorkflowBytes = Buffer.from(compiledWorkflowAsset);
  const compiledWorkflowDigest = sha256Hex(compiledWorkflowBytes);
  let compiledWorkflow;
  try {
    compiledWorkflow = JSON.parse(compiledWorkflowBytes.toString('utf8'));
  } catch (error) {
    return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', `workflow.compiled.json is not JSON: ${error.message}`);
  }
  if (compiledWorkflow?.schema !== COMPILED_WORKFLOW_SCHEMA) {
    return failure('RELEASE_COMPILED_WORKFLOW_MISMATCH', `compiled workflow schema is ${String(compiledWorkflow?.schema)} (expected ${COMPILED_WORKFLOW_SCHEMA})`);
  }
  if (compiledWorkflow.id !== bundleId || compiledWorkflow.version !== version) {
    return failure(
      'RELEASE_TAG_MISMATCH',
      `the compiled workflow is ${String(compiledWorkflow.id)}@${String(compiledWorkflow.version)}, the requested Release is ${bundleId}@${version}`,
    );
  }
  const allowed = allowedProjections(compiledWorkflow);
  if (allowed === null) {
    return failure('RELEASE_PROJECTION_NOT_ALLOWED', 'requires.projections must be a non-empty array of projection ids');
  }
  const selection = selectProjection({ allowed, requested: input.projection });
  if (selection.ok === false) return selection;
  const projectionId = selection.projection;
  const descriptor = getProjection(projectionId);

  const engineVersion = engines.length === 0 ? null : ENGINE_ASSET.exec(engines[0])[1];
  if (engines.length > 1) {
    return failure('RELEASE_ASSET_SET_MISMATCH', `${SUMS_ASSET} lists several engine assets: ${assetNameList(engines)}`);
  }
  if (projectionId === 'runner') {
    if (engineVersion === null) {
      return failure('RELEASE_ENGINE_MISSING', `${SUMS_ASSET} lists no hm2b-engine-<E>.tgz for the runner runtime`);
    }
    if (!isValidVersion(engineVersion)) {
      return failure('RELEASE_ASSET_SET_MISMATCH', `engine asset does not carry a semver: ${engines[0]}`);
    }
    const required = checkEngineRequirement({ range: compiledWorkflow.requires?.engine, engineVersion });
    if (required.ok === false) return required;
  }

  // `SHA256SUMS.txt` covers every other asset, so it is not one of its own lines.
  const expected = bundleAssetNames({ id: bundleId, version, allowed, engineVersion, frameworkVersion })
    .filter((name) => name !== SUMS_ASSET);
  const missing = expected.filter((name) => !sums.entries.has(name));
  const extra = names.filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    const detail = [missing.length > 0 ? `missing: ${assetNameList(missing)}` : null,
      extra.length > 0 ? `unexpected: ${assetNameList(extra)}` : null].filter(Boolean).join('; ');
    const code = missing.some((name) => name.startsWith('hm2b-engine-')) ? 'RELEASE_ENGINE_MISSING'
      : missing.some((name) => /^(hm2b-payload-|agent-native-)/.test(name)) ? 'RELEASE_PAYLOAD_MISSING'
        : 'RELEASE_ASSET_SET_MISMATCH';
    return failure(code, `the Release asset set of ${tag} does not match its requires (${detail})`, { details: { missing, extra } });
  }

  // Every used asset must be present and hash to its sums entry.
  const wanted = ['install.mjs', 'workflow.compiled.json', `bundle-${bundleId}-v${version}.zip`,
    projectionId === 'runner' ? `hm2b-payload-${bundleId}-v${version}.tgz` : `agent-native-${bundleId}-v${version}.tgz`,
    frameworks[0]];
  if (projectionId === 'runner') wanted.push(engines[0]);
  const absent = wanted.filter((name) => !(assets[name] instanceof Uint8Array) && !Buffer.isBuffer(assets[name]));
  if (absent.length > 0) {
    const code = absent.some((name) => name.startsWith('hm2b-engine-')) ? 'RELEASE_ENGINE_MISSING'
      : absent.some((name) => /^(hm2b-payload-|agent-native-)/.test(name)) ? 'RELEASE_PAYLOAD_MISSING'
        : 'RELEASE_NOT_FOUND';
    return failure(code, `the Release assets were not downloaded: ${assetNameList(absent)}`, { details: { absent } });
  }
  const checksum = verifySums(sums, wanted.map((name) => ({ name, data: Buffer.from(assets[name]) })), {
    requireAll: false,
  });
  if (!checksum.ok) {
    return failure('RELEASE_CHECKSUM_MISMATCH', checksum.failures.join('; '), { details: { failures: checksum.failures } });
  }

  // The framework archive is the installer that runs this check; its own
  // version must be the one the asset name claims.
  const framework = readReleaseTarGz(assets[frameworks[0]]);
  if (framework.problems.length > 0) {
    return failure('RELEASE_ASSET_SET_MISMATCH', `${frameworks[0]} is not a readable archive: ${framework.problems[0]}`);
  }
  const frameworkPkg = framework.entries.find((entry) => entry.path === 'package.json');
  let frameworkDeclared = null;
  try {
    frameworkDeclared = frameworkPkg === undefined ? null : JSON.parse(Buffer.from(frameworkPkg.data).toString('utf8')).version;
  } catch {
    frameworkDeclared = null;
  }
  if (frameworkDeclared !== frameworkVersion) {
    return failure(
      'RELEASE_ASSET_SET_MISMATCH',
      `${frameworks[0]} declares framework version ${String(frameworkDeclared)}; the asset name says ${frameworkVersion}`,
    );
  }

  // 3) zip ↔ compiled workflow, then payload ↔ compiled workflow ↔ manifest.
  const zip = verifyZip({ zipBytes: Buffer.from(assets[`bundle-${bundleId}-v${version}.zip`]), compiledWorkflow, id: bundleId, version });
  if (zip.ok === false) return zip;

  const canonicalInput = canonicalInputOptions(projectionId, descriptor);
  const normalized = normalizeOptions({
    projectionId,
    compiledWorkflow,
    compiledWorkflowDigest,
    raw: canonicalInput,
    manifest: descriptor,
  });
  if (!normalized.ok) {
    return failure('RELEASE_PAYLOAD_INVALID', `${projectionId} canonical options are invalid: ${(normalized.errors ?? []).map((error) => error.message).join('; ')}`);
  }
  const canonical = {
    options: canonicalInput,
    targets: normalized.options.targets,
    normalized: normalized.options,
  };
  const payloadName = projectionId === 'runner'
    ? `hm2b-payload-${bundleId}-v${version}.tgz`
    : `agent-native-${bundleId}-v${version}.tgz`;
  const payload = verifyPayload({
    payloadBytes: Buffer.from(assets[payloadName]),
    compiledWorkflow,
    compiledWorkflowDigest,
    descriptor,
    canonical,
    id: bundleId,
    version,
  });
  if (payload.ok === false) return payload;

  if (projectionId === 'runner') {
    const projectedEngine = payload.result.environment?.engineVersion ?? null;
    if (projectedEngine !== engineVersion) {
      return failure(
        'RELEASE_COMPILED_WORKFLOW_MISMATCH',
        `the payload was projected for engine ${String(projectedEngine)}, the Release ships ${engineVersion}`,
      );
    }
  }

  // Requested targets must exist in the payload; runner has exactly one target.
  const requested = Array.isArray(input.targets) && input.targets.length > 0 ? [...new Set(input.targets)] : null;
  if (requested !== null) {
    if (projectionId === 'runner') {
      if (requested.length !== 1 || requested[0] !== 'runner') {
        return failure('RELEASE_OPTION_CONFLICT', `--target applies to agent-native; runner has a single target (runner)`);
      }
    } else {
      const unknown = requested.filter((target) => !canonical.targets.includes(target));
      if (unknown.length > 0) {
        return failure(
          'RELEASE_PAYLOAD_TARGET_UNKNOWN',
          `--target ${unknown.join(', ')} is not in the payload targets (${canonical.targets.join(', ')})`,
        );
      }
    }
  }

  return {
    ok: true,
    tag,
    compiledWorkflow,
    compiledWorkflowBytes,
    compiledWorkflowDigest,
    projection: projectionId,
    descriptor,
    allowed,
    targets: requested,
    canonicalTargets: canonical.targets,
    canonicalOptions: canonical.normalized,
    engineVersion: projectionId === 'runner' ? engineVersion : null,
    frameworkVersion,
    result: payload.result,
    payloadManifest: payload.manifest,
  };
}

/**
 * Install-time `--target` filter (#74 §9.3): not a re-projection, only a
 * consistent slice of the validated result — files, plan, capability rows,
 * degradations, id maps and artifact pointers stay mutually consistent so the
 * installer can re-run V1–V12 on the narrowed object.
 */
export function narrowResult(result, requested) {
  const keep = new Set(requested);
  const targets = result.targets.filter((target) => keep.has(target));
  const overwrite = new Map(result.installPlan.steps.map((step) => [step.path, step.overwrite]));
  const files = result.files
    .filter((file) => file.targets.some((target) => keep.has(target)))
    .map((file) => ({ ...file, targets: file.targets.filter((target) => keep.has(target)) }));
  const kept = new Set(files.map((file) => file.path));
  const artifacts = {};
  for (const [name, path] of Object.entries(result.metadata?.artifacts ?? {})) {
    if (kept.has(path)) artifacts[name] = path;
  }
  return {
    ...result,
    options: { ...result.options, targets },
    targets,
    files,
    installPlan: {
      ...result.installPlan,
      steps: files.map((file) => ({ op: 'write', path: file.path, overwrite: overwrite.get(file.path) ?? 'replace' })),
    },
    capabilityReport: result.capabilityReport.filter((row) => keep.has(row.target)),
    degradations: result.degradations.filter((record) => record.target === undefined || keep.has(record.target)),
    warnings: result.warnings.filter((record) => record.target === undefined || keep.has(record.target)),
    metadata: {
      ...result.metadata,
      idMap: Object.fromEntries(Object.entries(result.metadata?.idMap ?? {}).filter(([target]) => keep.has(target))),
      artifacts,
    },
  };
}


/** Every regular file under `rootRel`, project-relative. */
function listTree(projectRoot, rootRel) {
  const out = [];
  const walk = (rel) => {
    const absolute = projectPath(projectRoot, rel);
    if (absolute === null) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  const absolute = projectPath(projectRoot, rootRel);
  if (absolute !== null && lstatOrNull(absolute)?.isDirectory()) walk(rootRel);
  return out;
}

/**
 * Snapshot every path the runtime install may touch, plus the engine tree it
 * replaces. The Release transaction restores this if the bundle half fails.
 */
function captureReleaseState(projectRoot, paths) {
  const engineRoot = projectPath(projectRoot, ENGINE_ROOT);
  const wanted = [...new Set([
    ...paths,
    RUNTIME_RECEIPT_PATH,
    ...listTree(projectRoot, ENGINE_ROOT),
  ])].sort(compareCodePoints);
  const entries = wanted.map((path) => {
    const absolute = projectPath(projectRoot, path);
    const info = absolute === null ? null : lstatOrNull(absolute);
    if (info === null || !info.isFile()) return { path, missing: true };
    return { path, data: readFileSync(absolute), mode: info.mode & 0o777 };
  });
  return { entries, engineRoot };
}

/** Restore a `captureReleaseState` snapshot; returns the paths that failed. */
function restoreReleaseState(projectRoot, snapshot) {
  const failures = [];
  if (snapshot.engineRoot !== null && existsSync(snapshot.engineRoot)) {
    try {
      rmSync(snapshot.engineRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push({ path: ENGINE_ROOT, reason: error?.code ?? 'ROLLBACK_IO' });
    }
  }
  for (const entry of snapshot.entries) {
    const absolute = projectPath(projectRoot, entry.path);
    if (absolute === null) {
      failures.push({ path: entry.path, reason: 'PATH_ESCAPE' });
      continue;
    }
    try {
      if (entry.missing) {
        unlinkIfExists(absolute);
        continue;
      }
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, entry.data);
      if (entry.mode === 0o755) chmodSync(absolute, 0o755);
    } catch (error) {
      failures.push({ path: entry.path, reason: error?.code ?? 'ROLLBACK_IO' });
    }
  }
  for (const entry of snapshot.entries) {
    if (!entry.missing) continue;
    const parts = entry.path.split('/');
    for (let index = parts.length - 1; index > 0; index -= 1) {
      try {
        pruneEmptyDir(projectRoot, parts.slice(0, index).join('/'));
      } catch {
        // A non-empty directory is still used; leave it.
      }
    }
  }
  return failures;
}

/** Unpack a release tgz into a fresh temp directory; caller removes it. */
export function extractReleaseArchive(bytes, { prefix = 'hm2b-release-' } = {}) {
  const { entries, problems } = readReleaseTarGz(bytes);
  if (problems.length > 0) {
    return failure('RELEASE_ASSET_SET_MISMATCH', `release archive is unreadable: ${problems[0]}`, { details: { problems } });
  }
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    for (const entry of entries) {
      const absolute = join(root, ...entry.path.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, entry.data);
      if ((entry.mode & 0o111) !== 0) chmodSync(absolute, 0o755);
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    return failure('RELEASE_ASSET_SET_MISMATCH', `cannot unpack ${prefix}${error.message}`);
  }
  return { ok: true, root, files: entries.length };
}

function exitCodeFor(outcome) {
  if (outcome.ok) return 0;
  switch (outcome.code) {
    case 'LOCK_CONFLICT': return 5;
    case 'NOT_INSTALLED': return 4;
    case 'INTERNAL': return 1;
    case 'ROLLBACK_FAILED': return 1;
    default: return 2;
  }
}

/**
 * Verify, unpack and install one Release.
 *
 * runner installs the runtime (engine + launcher + host files) and the bundle;
 * agent-native installs bundle files only. All verification happens before
 * the runtime transaction so a tampered Release never writes.
 */
export function installRelease(input = {}) {
  const verified = verifyRelease(input);
  if (verified.ok === false) return verified;
  const projectRoot = input.projectRoot;
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    return failure('RELEASE_OPTION_CONFLICT', 'a project root is required');
  }
  const dryRun = input.dryRun === true;
  const force = input.force === true;
  const clock = input.clock;

  let result = verified.result;
  if (verified.targets !== null && verified.projection === 'agent-native') {
    result = narrowResult(result, verified.targets);
  }

  const install = verified.projection === 'runner' ? installRunnerProject : installProjection;

  // Read-only preflight: legacy receipts, runner occupancy, V1–V12, receipts and
  // conflicts all run before the runtime transaction, so a refused Release
  // never writes an engine or launcher file.
  const preflight = install({
    result,
    compiledWorkflowBytes: verified.compiledWorkflowBytes,
    projectRoot,
    dryRun: true,
    force,
    clock,
  });
  if (preflight.ok === false) {
    return {
      ok: false,
      code: preflight.code,
      message: preflight.message,
      exitCode: exitCodeFor(preflight),
      details: preflight.conflicts ?? preflight.diagnostics ?? preflight.failures ?? null,
      stage: 'bundle',
      runtime: null,
    };
  }

  let runtime = null;
  let snapshot = null;
  const cleanup = [];
  try {
    if (verified.projection === 'runner') {
      const extracted = extractReleaseArchive(Buffer.from(input.assets[`hm2b-engine-${verified.engineVersion}.tgz`]), {
        prefix: 'hm2b-engine-',
      });
      if (extracted.ok === false) return extracted;
      cleanup.push(extracted.root);
      const plan = installRuntime({
        projectRoot,
        engineSource: extracted.root,
        engineVersion: verified.engineVersion,
        dryRun: true,
        force,
        clock,
      });
      if (plan.ok === false) {
        return {
          ok: false,
          code: plan.code,
          message: plan.message,
          exitCode: exitCodeFor(plan),
          details: plan.conflicts ?? plan.failures ?? null,
          stage: 'runtime',
        };
      }
      // One all-or-rollback release transaction: snapshot everything the
      // runtime half may touch, then install both halves; a bundle failure
      // restores the snapshot (the bundle install rolls back its own journal).
      snapshot = captureReleaseState(projectRoot, plan.writes ?? []);
      const outcome = installRuntime({
        projectRoot,
        engineSource: extracted.root,
        engineVersion: verified.engineVersion,
        dryRun,
        force,
        clock,
      });
      if (outcome.ok === false) {
        if (!dryRun && snapshot !== null) restoreReleaseState(projectRoot, snapshot);
        return {
          ok: false,
          code: outcome.code,
          message: outcome.message,
          exitCode: exitCodeFor(outcome),
          details: outcome.conflicts ?? outcome.failures ?? null,
          stage: 'runtime',
          rolledBack: !dryRun,
        };
      }
      runtime = outcome;
    }

    const outcome = install({
      result,
      compiledWorkflowBytes: verified.compiledWorkflowBytes,
      projectRoot,
      dryRun,
      force,
      clock,
    });
    if (outcome.ok === false) {
      let rollbackFailures = [];
      if (!dryRun && snapshot !== null) rollbackFailures = restoreReleaseState(projectRoot, snapshot);
      if (rollbackFailures.length > 0) {
        return {
          ok: false,
          code: 'ROLLBACK_FAILED',
          message: 'the bundle install failed and the runtime rollback could not restore every path',
          exitCode: 1,
          details: { failures: rollbackFailures },
          stage: 'bundle',
          runtime: null,
        };
      }
      return {
        ok: false,
        code: outcome.code,
        message: outcome.message,
        exitCode: exitCodeFor(outcome),
        details: outcome.conflicts ?? outcome.diagnostics ?? outcome.failures ?? null,
        stage: 'bundle',
        runtime: null,
        rolledBack: !dryRun && snapshot !== null,
      };
    }
    return {
      ok: true,
      code: 'OK',
      exitCode: 0,
      action: outcome.action,
      projection: verified.projection,
      bundleId: verified.compiledWorkflow.id,
      version: verified.compiledWorkflow.version,
      engineVersion: verified.engineVersion,
      frameworkVersion: verified.frameworkVersion,
      targets: result.targets,
      files: outcome.files,
      receiptPath: outcome.receiptPath,
      receipt: outcome.receipt,
      warnings: outcome.warnings ?? [],
      decisions: outcome.decisions,
      diff: outcome.diff,
      runtime: runtime === null ? null : {
        action: runtime.action,
        engine: runtime.engine,
        files: runtime.files,
        runtimePath: runtime.runtimePath,
      },
    };
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
}
