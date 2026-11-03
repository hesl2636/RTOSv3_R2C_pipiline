/**
 * Upload, validation and authoritative build orchestration.
 *
 * Server-only module: it owns the in-memory upload/build maps, the bounded
 * temp directories, the in-process projections and the isolated release child.
 * The HTTP layer in `serve.mjs` only parses requests and serialises these
 * results.
 */
import { compileBundle } from '../assembler/compile.js';
import { BUNDLE_ID_MAX, isValidId } from '../assembler/ids.js';
import { LIMITS } from '../assembler/limits.js';
import { isPlainObject } from '../assembler/util.js';
import { canonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { isInside } from '../core/paths.js';
import { isValidVersion } from '../core/semver.js';
import { checkEngineRequirement } from '../projection/engine-requirement.js';
import { isCanonicalOptions, normalizeOptions, payloadInputOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { allowedProjections, getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import { runReleaseChild } from './child.js';
import { buildChildEnv } from './env.js';
import { createRateLimiter, webError } from './http.js';

export const UPLOAD_MAX_BYTES = LIMITS.MAX_ZIP_BYTES + 4 * 1024;
export const UPLOAD_TTL_MS = 30 * 60 * 1000;
export const BUILD_TTL_MS = 60 * 60 * 1000;
export const MAX_UPLOADS = 4;
export const MAX_BUILDS = 16;
export const BUILD_TIMEOUT_MS = 120 * 1000;
export const BUILD_RATE_LIMIT = 60;
export const BUILD_RATE_WINDOW_MS = 60 * 60 * 1000;
export const BUILD_CONCURRENCY = 2;

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** Parse/validate the JSON build request without touching any state. */
export function parseBuildBody(body) {
  if (!isPlainObject(body)) return webError(400, 'WEB_BODY_INVALID', 'build body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!['uploadId', 'options', 'irDigest'].includes(key)) {
      return webError(400, 'WEB_BODY_INVALID', `unknown field ${key}`);
    }
  }
  if (typeof body.uploadId !== 'string' || !/^[0-9a-f]{16}$/.test(body.uploadId)) {
    return webError(400, 'WEB_BODY_INVALID', 'uploadId must be 16 hex characters');
  }
  if (body.irDigest !== undefined && (typeof body.irDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.irDigest))) {
    return webError(400, 'WEB_BODY_INVALID', 'irDigest must be a sha256 digest');
  }
  if (body.options !== undefined && body.options !== null && !isPlainObject(body.options)) {
    return webError(400, 'WEB_BODY_INVALID', 'options must be an object keyed by projection id');
  }
  return { uploadId: body.uploadId, options: body.options ?? null, irDigest: body.irDigest };
}

export async function runValidation(bytes) {
  const primitives = { inflateRaw, sha256: sha256Hex };
  const compiled = compileBundle(bytes, primitives, { path: 'bundle.zip' });
  let ir = null;
  if (compiled.ok && compiled.irBytes !== null) {
    let schema = compiled.irReport?.schema ?? null;
    let contentSha256 = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(compiled.irBytes));
      schema = parsed?.schema ?? schema;
      contentSha256 = parsed?.source?.bundle?.contentSha256 ?? null;
    } catch {
      contentSha256 = null;
    }
    ir = {
      schema,
      id: compiled.irReport?.id ?? null,
      version: compiled.irReport?.version ?? null,
      digest: compiled.digest,
      bytes: compiled.irBytes.length,
      contentSha256,
      encoding: 'base64',
      data: base64(compiled.irBytes),
    };
  }
  return { report: compiled.report, ir };
}

function projectBytes(result) {
  return result.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
}

function filesSummary(result) {
  return result.files.map((file) => ({
    path: file.path,
    targets: [...file.targets],
    kind: file.kind,
    mode: file.mode,
    sha256: sha256Hex(file.content),
  }));
}

function manifestFiles(result) {
  return result.files.map((file) => ({
    path: file.path,
    mode: file.mode,
    sha256: sha256Hex(file.content),
    kind: file.kind,
    targets: [...file.targets],
  }));
}

const PROJECT_CLI = 'node bin/hm2b-assembler.js';
const INSTALLER_CLI = 'node installer/cli.js';
const BOOTSTRAP_PATH = '.hm2b/bootstrap/install.mjs';

/** Quote one shell token; every value here still has to pass its id check. */
function shellToken(value) {
  const text = String(value);
  return /^[A-Za-z0-9._:/=+,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function releaseCommand({ id, version, projection, target }) {
  if (!isValidId(id, BUNDLE_ID_MAX) || !isValidVersion(version) || String(version).includes('+')) return null;
  const descriptor = getProjection(projection);
  if (descriptor === null) return null;
  if (target !== null && !descriptor.targets.some((item) => item.id === target)) return null;
  const parts = [
    'node .hm2b/bootstrap/install.mjs',
    '--bundle', id,
    '--version', version,
    '--projection', projection,
  ];
  if (target !== null) parts.push('--target', target);
  parts.push('--project', '.');
  return parts.join(' ');
}

/**
 * A custom payload is not a Release payload (`release-install.js` refuses
 * non-canonical options), so the local chain re-projects the downloaded IR
 * with the same options into a result directory and feeds that directory to
 * `installer/cli.js --result` (#106's reproject path).
 */
function localCommand({ projection, target, options }) {
  const descriptor = getProjection(projection);
  if (descriptor === null) return null;
  if (!isPlainObject(options) || !Array.isArray(options.targets)) return null;
  const targets = options.targets;
  if (targets.length === 0) return null;
  if (!targets.every((item) => typeof item === 'string' && descriptor.targets.some((entry) => entry.id === item))) return null;
  if (target !== null && !targets.includes(target)) return null;
  const stageOrder = options.stageOrder;
  const skills = options.skills;
  if (!Array.isArray(stageOrder) || !stageOrder.every((item) => typeof item === 'string')) return null;
  if (!Array.isArray(skills) || !skills.every((item) => typeof item === 'string')) return null;
  const resultDir = target === null ? `.hm2b/build/${projection}` : `.hm2b/build/${projection}-${target}`;
  const parts = [
    PROJECT_CLI, 'project', 'workflow.ir.json',
    '--projection', shellToken(projection),
  ];
  if (target !== null) {
    parts.push('--target', shellToken(target));
  } else if (descriptor.targets.length > 1) {
    for (const id of targets) parts.push('--target', shellToken(id));
  }
  if (stageOrder.length > 0) parts.push('--stage-order', shellToken(stageOrder.join(',')));
  if (skills.length > 0) parts.push('--skills', shellToken(skills.join(',')));
  parts.push('--result', shellToken(resultDir));
  return `${parts.join(' ')} && ${INSTALLER_CLI} --result ${shellToken(resultDir)} --ir workflow.ir.json --project .`;
}

/** One install command per projection (and per selected agent target). */
export function installCommands({ id, version, projections, publishable }) {
  const commands = [];
  for (const projection of projections) {
    if (projection.id === 'runner') {
      const command = publishable
        ? releaseCommand({ id, version, projection: 'runner', target: null })
        : localCommand({ projection: 'runner', target: null, options: projection.options });
      if (command === null) return null;
      commands.push({ projection: 'runner', target: null, command });
      continue;
    }
    const all = publishable
      ? releaseCommand({ id, version, projection: projection.id, target: null })
      : localCommand({ projection: projection.id, target: null, options: projection.options });
    if (all === null) return null;
    commands.push({ projection: projection.id, target: null, command: all });
    for (const target of projection.targets) {
      const command = publishable
        ? releaseCommand({ id, version, projection: projection.id, target })
        : localCommand({ projection: projection.id, target, options: projection.options });
      if (command === null) return null;
      commands.push({ projection: projection.id, target, command });
    }
  }
  return {
    mode: publishable ? 'release' : 'local',
    bootstrap: publishable
      ? {
        asset: 'install.mjs',
        path: BOOTSTRAP_PATH,
        instruction: `Download install.mjs from the Release assets (the install.mjs asset listed below) into ${BOOTSTRAP_PATH} before running the commands below.`,
      }
      : null,
    commands,
  };
}

function expectedSums(assets) {
  return [...assets]
    .filter((asset) => asset.name !== 'SHA256SUMS.txt')
    .sort((left, right) => compareCodePoints(left.name, right.name))
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join('');
}

/**
 * The server is the authority: it recomputes every asset byte and compares the
 * child's payload manifests with its own projection results (#75 §7.1 step 5).
 */
async function verifyChildBuild({ result, projectionEvents, expected, outDir, upload, ir, irDigest, node }) {
  const { readdir, readFile, resolve } = node;
  const problems = [];
  if (result.ok !== true) problems.push('child result is not ok');
  if (result.id !== upload.bundleId || result.version !== upload.version) {
    problems.push(`child built ${String(result.id)}@${String(result.version)} for ${upload.bundleId}@${upload.version}`);
  }
  if (result.canonical !== expected.canonical) problems.push('canonical agreement');
  if (JSON.stringify(result.allowed) !== JSON.stringify(expected.allowed)) problems.push('allowed projections disagree');

  const reported = Array.isArray(result.assets) ? result.assets : [];
  const names = reported.map((asset) => asset.name);
  if (new Set(names).size !== names.length) problems.push('duplicate asset names');
  const onDisk = (await readdir(outDir)).sort(compareCodePoints);
  if (JSON.stringify([...names].sort(compareCodePoints)) !== JSON.stringify(onDisk)) {
    problems.push(`asset names on disk differ from the child report: ${onDisk.join(', ')}`);
  }
  for (const asset of reported) {
    const file = resolve(outDir, asset.name);
    if (!isInside(outDir, file)) {
      problems.push(`${asset.name}: escapes the build directory`);
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      problems.push(`${asset.name}: missing on disk`);
      continue;
    }
    if (bytes.length !== asset.bytes) problems.push(`${asset.name}: byte count differs`);
    if (sha256Hex(bytes) !== asset.sha256) problems.push(`${asset.name}: sha256 differs`);
  }
  const sums = reported.find((asset) => asset.name === 'SHA256SUMS.txt');
  if (sums === undefined) {
    problems.push('SHA256SUMS.txt is missing');
  } else {
    const text = await readFile(resolve(outDir, 'SHA256SUMS.txt'), 'utf8').catch(() => null);
    if (text !== expectedSums(reported)) problems.push('SHA256SUMS.txt does not cover the assets');
  }

  for (const entry of expected.projections) {
    const event = projectionEvents.find((item) => item.id === entry.id);
    if (event === undefined) {
      problems.push(`${entry.id}: child emitted no projection manifest`);
      continue;
    }
    if (event.digest !== entry.digest) problems.push(`${entry.id}: result digest differs`);
    const options = payloadInputOptions({
      projectionId: entry.id,
      ir,
      irDigest,
      options: entry.normalized.options,
      manifest: entry.descriptor,
    });
    if (JSON.stringify(event.options) !== JSON.stringify(options)) {
      problems.push(`${entry.id}: payload options differ`);
    }
    const manifest = event.manifest ?? {};
    if (manifest.ir?.digest !== irDigest) problems.push(`${entry.id}: payload IR digest differs`);
    if (JSON.stringify(manifest.bundle) !== JSON.stringify({ id: upload.bundleId, version: upload.version })) {
      problems.push(`${entry.id}: payload bundle identity differs`);
    }
    // Compare only the contract fields; later payload manifests add fields
    // (e.g. `files[].origin`, a top-level `result`) without changing bytes.
    const declared = Array.isArray(manifest.files) ? manifest.files : [];
    const projected = manifestFiles(entry.result);
    if (declared.length !== projected.length) {
      problems.push(`${entry.id}: payload file count differs from the projection result`);
    } else {
      for (let index = 0; index < declared.length; index += 1) {
        const actual = declared[index] ?? {};
        const want = projected[index];
        if (actual.path !== want.path || actual.mode !== want.mode || actual.sha256 !== want.sha256
          || actual.kind !== want.kind
          || JSON.stringify(actual.targets) !== JSON.stringify(want.targets)) {
          problems.push(`${entry.id}: payload file ${want.path} differs from the projection result`);
          break;
        }
      }
    }
  }
  return problems;
}

/**
 * In-memory upload/build state plus the authoritative build flow.
 *
 * @param {{
 *   root: string,
 *   tempRoot: string,
 *   engineVersion: string|null,
 *   secrets: string[],
 *   releaseScript: string,
 *   buildTimeoutMs: number,
 *   uploadLimit?: number,
 * }} options
 */
export function createBuildService({
  root,
  tempRoot,
  engineVersion,
  secrets,
  releaseScript,
  buildTimeoutMs,
  uploadLimit = UPLOAD_MAX_BYTES,
  node,
}) {
  const { randomBytes, mkdir, readFile, rm, writeFile, resolve, spawn } = node;
  const uploads = new Map();
  const builds = new Map();
  const buildRate = createRateLimiter({ limit: BUILD_RATE_LIMIT, windowMs: BUILD_RATE_WINDOW_MS });
  let activeBuilds = 0;

  const touchUpload = (upload) => {
    upload.lastUsed = Date.now();
    uploads.delete(upload.uploadId);
    uploads.set(upload.uploadId, upload);
  };

  const evictUploads = async () => {
    while (uploads.size > MAX_UPLOADS) {
      const [key, value] = uploads.entries().next().value;
      uploads.delete(key);
      await rm(value.dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const evictBuilds = async () => {
    while (builds.size > MAX_BUILDS) {
      const [key, value] = builds.entries().next().value;
      builds.delete(key);
      await rm(value.dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const persistUpload = async (bytes, data) => {
    const uploadId = randomBytes(8).toString('hex');
    const dir = resolve(tempRoot, 'uploads', uploadId);
    await mkdir(dir, { mode: 0o700 });
    const irBytes = Buffer.from(data.ir.data, 'base64');
    await writeFile(resolve(dir, 'input.zip'), bytes, { mode: 0o600 });
    await writeFile(resolve(dir, 'workflow.ir.json'), irBytes, { mode: 0o600 });
    const record = {
      uploadId,
      dir,
      bundleId: data.ir.id,
      version: data.ir.version,
      digest: data.ir.digest,
      contentSha256: data.ir.contentSha256,
      sha256: data.report.artifact.sha256,
      report: data.report,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    await writeFile(resolve(dir, 'meta.json'), canonicalJson({
      uploadId,
      sha256: record.sha256,
      id: record.bundleId,
      version: record.version,
      digest: record.digest,
      contentSha256: record.contentSha256,
    }), { mode: 0o600 });
    uploads.set(uploadId, record);
    await evictUploads();
    return uploadId;
  };

  /**
   * Authoritative build (#75 §7.1): the uploaded zip and IR come from the
   * session dir, the shared projections run in-process, the release packager
   * runs as an isolated child, and the child's payload manifests must equal
   * the in-process results byte for byte.
   */
  const buildOnce = async (upload, parsed) => {
    const irBytes = await readFile(resolve(upload.dir, 'workflow.ir.json')).catch(() => null);
    if (irBytes === null) return webError(404, 'WEB_UPLOAD_UNKNOWN', 'the upload is gone');
    const irDigest = sha256Hex(irBytes);
    if (irDigest !== upload.digest) {
      return webError(500, 'WEB_INTERNAL', 'the stored IR does not match its digest');
    }
    let ir;
    try {
      ir = JSON.parse(irBytes.toString('utf8'));
    } catch {
      return webError(500, 'WEB_INTERNAL', 'the stored IR is not JSON');
    }
    if (ir.id !== upload.bundleId || ir.version !== upload.version) {
      return webError(500, 'WEB_INTERNAL', 'the stored IR identity differs from the upload');
    }
    if (parsed.irDigest !== undefined && parsed.irDigest !== irDigest) {
      return webError(409, 'PROJECTION_OPTIONS_IR_MISMATCH', 'the options are bound to a different IR digest');
    }

    const allowed = allowedProjections(ir);
    // `requires.engine` constrains the engine package, not the framework, and
    // only when the runner runtime is part of this bundle (spec §13).
    if (allowed.includes('runner')) {
      const requirement = checkEngineRequirement({ range: ir.requires?.engine, engineVersion });
      if (!requirement.ok) {
        return webError(409, requirement.code, requirement.message);
      }
    }
    const requested = parsed.options ?? {};
    for (const projectionId of Object.keys(requested)) {
      if (!allowed.includes(projectionId)) {
        return webError(400, 'WEB_OPTIONS_INVALID', `unknown projection ${projectionId}`, {
          allowed,
        });
      }
      const raw = requested[projectionId];
      if (raw !== null && !isPlainObject(raw)) {
        return webError(400, 'WEB_OPTIONS_INVALID', `${projectionId} options must be an object or null`);
      }
    }

    const expected = [];
    for (const projectionId of allowed) {
      const descriptor = getProjection(projectionId);
      if (descriptor === null) {
        return webError(500, 'WEB_INTERNAL', `projection ${projectionId} is not registered`);
      }
      const normalized = normalizeOptions({
        projectionId,
        ir,
        irDigest,
        raw: requested[projectionId] ?? null,
        manifest: descriptor,
      });
      if (!normalized.ok) {
        const first = normalized.errors[0];
        const status = normalized.errors.some((item) => item.code === 'PROJECTION_OPTIONS_IR_MISMATCH')
          ? 409
          : 400;
        return webError(status, first.code, first.message, {
          errors: normalized.errors,
          ...(first.target === undefined ? {} : { target: first.target }),
        });
      }
      const result = project({
        projectionId,
        ir,
        irDigest,
        options: normalized.options,
        environment: { engineVersion },
        assets: {},
      });
      if (!result.ok) {
        const first = (result.errors ?? [])[0] ?? { code: 'PROJECTION_INTERNAL', message: 'projection failed' };
        return webError(400, first.code, first.message, { errors: result.errors ?? [] });
      }
      const validation = validateResult(result, {
        ir,
        irDigest,
        manifest: descriptor,
        options: normalized.options,
        environment: { engineVersion },
        assets: {},
      });
      if (!validation.ok) {
        return webError(500, 'PROJECTION_RESULT_INVALID', validation.diagnostics[0].message, {
          diagnostics: validation.diagnostics,
        });
      }
      expected.push({
        id: projectionId,
        descriptor,
        normalized,
        result,
        canonical: isCanonicalOptions({
          projectionId,
          ir,
          irDigest,
          options: normalized.options,
          manifest: descriptor,
        }),
        digest: sha256Hex(canonicalJson(result)),
      });
    }
    expected.sort((left, right) => compareCodePoints(left.id, right.id));
    const canonical = expected.every((entry) => entry.canonical);

    const buildId = randomBytes(8).toString('hex');
    const workDir = resolve(tempRoot, 'builds', buildId);
    const outDir = resolve(workDir, 'assets');
    const tempDir = resolve(workDir, 'tmp');
    const optionsPath = resolve(workDir, 'options.json');
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const childOptions = {};
    for (const entry of expected) childOptions[entry.id] = requested[entry.id] ?? null;
    await writeFile(optionsPath, canonicalJson(childOptions), { mode: 0o600 });

    const child = await runReleaseChild({
      spawn,
      script: releaseScript,
      args: [
        '--bundle', resolve(upload.dir, 'input.zip'),
        '--out', outDir,
        '--options', optionsPath,
        '--json',
      ],
      env: buildChildEnv({
        ...process.env,
        TMPDIR: tempDir,
        TEMP: tempDir,
        TMP: tempDir,
      }),
      cwd: root,
      timeoutMs: buildTimeoutMs,
      secrets,
    });

    if (child.status === 'timeout') {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      return webError(504, 'WEB_CHILD_TIMEOUT', 'the build child was killed after the timeout', {
        stderr: child.stderr,
        stderrTruncated: child.stderrTruncated,
      });
    }
    const resultEvent = child.events.filter((event) => event.event === 'result').pop();
    const projectionEvents = child.events.filter((event) => event.event === 'projection');
    if (child.status !== 'exited' || resultEvent === undefined || resultEvent.ok !== true) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      return webError(500, 'WEB_CHILD_FAILED', 'the build child failed', {
        stderr: child.stderr,
        stderrTruncated: child.stderrTruncated,
        log: child.logLines.slice(0, 50),
        exitCode: child.code,
      });
    }

    const problems = await verifyChildBuild({
      result: resultEvent,
      projectionEvents,
      expected: { canonical, allowed, projections: expected },
      outDir,
      upload,
      ir,
      irDigest,
      node,
    });
    if (problems.length > 0) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      return webError(500, 'WEB_CLIENT_SERVER_MISMATCH', 'the packaged payloads differ from the server projection', {
        problems,
      });
    }

    const projections = expected.map((entry) => ({
      id: entry.id,
      version: entry.descriptor.version,
      options: entry.result.options,
      targets: entry.result.targets,
      coverage: entry.result.coverage,
      counts: {
        files: entry.result.files.length,
        bytes: projectBytes(entry.result),
        degradations: entry.result.degradations.length,
        warnings: entry.result.warnings.length,
        capabilities: entry.result.capabilityReport.length,
      },
      files: filesSummary(entry.result),
      capabilityReport: entry.result.capabilityReport,
      degradations: entry.result.degradations,
      warnings: entry.result.warnings,
      metadata: entry.result.metadata,
      digest: entry.digest,
    }));
    const install = installCommands({
      id: upload.bundleId,
      version: upload.version,
      projections,
      publishable: canonical,
    });
    if (install === null) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      return webError(500, 'WEB_COMMAND_INVALID', 'the install command values are not whitelisted');
    }

    const assets = new Map();
    const artifacts = [];
    for (const asset of resultEvent.assets) {
      const path = resolve(outDir, asset.name);
      if (!isInside(outDir, path)) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
        return webError(500, 'WEB_CLIENT_SERVER_MISMATCH', 'an asset escapes the build directory');
      }
      assets.set(asset.name, { name: asset.name, bytes: asset.bytes, sha256: asset.sha256, path });
      artifacts.push({
        name: asset.name,
        bytes: asset.bytes,
        sha256: asset.sha256,
        url: `/api/builds/${buildId}/artifacts/${encodeURIComponent(asset.name)}`,
      });
    }

    const summary = {
      buildId,
      tag: resultEvent.tag,
      canonical,
      publishable: canonical,
      ir: {
        schema: ir.schema,
        id: upload.bundleId,
        version: upload.version,
        digest: irDigest,
        contentSha256: upload.contentSha256,
      },
      engineVersion,
      projections,
      artifacts,
      install,
    };
    builds.set(buildId, {
      summary,
      dir: workDir,
      assets,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });
    await evictBuilds();
    return { status: 200, summary };
  };

  /**
   * Reserve the concurrency slot synchronously, before the first `await`, so
   * parallel POSTs cannot all pass the check while an earlier build is still
   * projecting; every exit path releases it.
   */
  const performBuild = async (upload, parsed) => {
    const limited = buildRate.take(Date.now());
    if (!limited.ok) {
      return webError(429, 'WEB_RATE_LIMITED', 'too many builds in the current window', null, {
        'Retry-After': String(limited.retryAfter),
      });
    }
    if (activeBuilds >= BUILD_CONCURRENCY) {
      return webError(409, 'WEB_BUILD_BUSY', 'another build is already running');
    }
    activeBuilds += 1;
    try {
      return await buildOnce(upload, parsed);
    } finally {
      activeBuilds -= 1;
    }
  };

  const pruneState = (now = Date.now()) => {
    for (const [key, value] of uploads) {
      if (now - value.lastUsed > UPLOAD_TTL_MS) {
        uploads.delete(key);
        void rm(value.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    for (const [key, value] of builds) {
      if (now - value.lastUsed > BUILD_TTL_MS) {
        builds.delete(key);
        void rm(value.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };

  return {
    uploads,
    builds,
    uploadLimit,
    touchUpload,
    persistUpload,
    performBuild,
    pruneState,
  };
}
