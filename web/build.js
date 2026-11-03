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
    if (!['uploadId', 'options', 'compiledWorkflowDigest'].includes(key)) {
      return webError(400, 'WEB_BODY_INVALID', `unknown field ${key}`);
    }
  }
  if (typeof body.uploadId !== 'string' || !/^[0-9a-f]{16}$/.test(body.uploadId)) {
    return webError(400, 'WEB_BODY_INVALID', 'uploadId must be 16 hex characters');
  }
  if (body.compiledWorkflowDigest !== undefined && (typeof body.compiledWorkflowDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.compiledWorkflowDigest))) {
    return webError(400, 'WEB_BODY_INVALID', 'compiledWorkflowDigest must be a sha256 digest');
  }
  if (body.options !== undefined && body.options !== null && !isPlainObject(body.options)) {
    return webError(400, 'WEB_BODY_INVALID', 'options must be an object keyed by projection id');
  }
  return { uploadId: body.uploadId, options: body.options ?? null, compiledWorkflowDigest: body.compiledWorkflowDigest };
}

export async function runValidation(bytes) {
  const primitives = { inflateRaw, sha256: sha256Hex };
  const compiled = compileBundle(bytes, primitives, { path: 'bundle.zip' });
  let compiledWorkflow = null;
  if (compiled.ok && compiled.compiledWorkflowBytes !== null) {
    let schema = compiled.compiledWorkflowReport?.schema ?? null;
    let contentSha256 = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(compiled.compiledWorkflowBytes));
      schema = parsed?.schema ?? schema;
      contentSha256 = parsed?.source?.bundle?.contentSha256 ?? null;
    } catch {
      contentSha256 = null;
    }
    compiledWorkflow = {
      schema,
      id: compiled.compiledWorkflowReport?.id ?? null,
      version: compiled.compiledWorkflowReport?.version ?? null,
      digest: compiled.digest,
      bytes: compiled.compiledWorkflowBytes.length,
      contentSha256,
      encoding: 'base64',
      data: base64(compiled.compiledWorkflowBytes),
    };
  }
  return { report: compiled.report, compiledWorkflow };
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
const RELEASE_BASE = '.hm2b/release';

/** Quote one shell token; every value here still has to pass its id check. */
function shellToken(value) {
  const text = String(value);
  return /^[A-Za-z0-9._:/=+,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function releaseCommand({ id, version, projection, target, installScript, releaseBase }) {
  if (!isValidId(id, BUNDLE_ID_MAX) || !isValidVersion(version) || String(version).includes('+')) return null;
  const descriptor = getProjection(projection);
  if (descriptor === null) return null;
  if (target !== null && !descriptor.targets.some((item) => item.id === target)) return null;
  const parts = [
    `node ${installScript}`,
    '--bundle', id,
    '--version', version,
    '--projection', projection,
  ];
  if (target !== null) parts.push('--target', target);
  if (releaseBase !== null) parts.push('--release-base', releaseBase);
  parts.push('--project', '.');
  return parts.join(' ');
}

/**
 * A custom payload is not a Release payload (`release-install.js` refuses
 * non-canonical options), so the local chain re-projects the downloaded compiled workflow
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
    PROJECT_CLI, 'project', 'workflow.compiled.json',
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
  return `${parts.join(' ')} && ${INSTALLER_CLI} --result ${shellToken(resultDir)} --compiled-workflow workflow.compiled.json --project .`;
}

/** One install command per projection (and per selected agent target). */
export function installCommands({ id, version, projections, publishable, repo = null }) {
  const tag = `bundle-${id}-v${version}`;
  const validRepo = typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
  const releaseDir = `${RELEASE_BASE}/${tag}`;
  const installScript = publishable && validRepo ? `${releaseDir}/install.mjs` : '.hm2b/bootstrap/install.mjs';
  const releaseBase = publishable && validRepo ? RELEASE_BASE : null;
  const commands = [];
  const add = (projection, target, command) => {
    commands.push({ projection, target, command });
  };
  for (const projection of projections) {
    if (projection.id === 'runner') {
      const command = publishable
        ? releaseCommand({ id, version, projection: 'runner', target: null, installScript, releaseBase })
        : localCommand({ projection: 'runner', target: null, options: projection.options });
      if (command === null) return null;
      add('runner', null, command);
      continue;
    }
    for (const target of projection.targets) {
      const command = publishable
        ? releaseCommand({ id, version, projection: projection.id, target, installScript, releaseBase })
        : localCommand({ projection: projection.id, target, options: projection.options });
      if (command === null) return null;
      add(projection.id, target, command);
    }
    // The all-targets form is useful only when there is more than one target.
    if (projection.targets.length > 1) {
      const all = publishable
        ? releaseCommand({ id, version, projection: projection.id, target: null, installScript, releaseBase })
        : localCommand({ projection: projection.id, target: null, options: projection.options });
      if (all === null) return null;
      add(projection.id, null, all);
    }
  }
  const bootstrap = publishable && validRepo
    ? {
      asset: 'install.mjs',
      path: installScript,
      base: RELEASE_BASE,
      repo,
      tag,
      command: `gh release download ${tag} --repo ${repo} --dir ${releaseDir} --clobber`,
      instruction: `先用 gh 把整个 Release（含 install.mjs）下载到 ${releaseDir}，再从本地目录离线安装；不需要再把 token 传给安装器。`,
    }
    : publishable
      ? {
        asset: 'install.mjs',
        path: installScript,
        base: null,
        repo: null,
        tag,
        command: null,
        instruction: `Download install.mjs from the Release assets into ${installScript} before running the commands below.`,
      }
      : null;
  for (const item of commands) {
    item.oneLiner = bootstrap?.command === null || bootstrap?.command === undefined
      ? item.command
      : `${bootstrap.command}; ${item.command}`;
  }
  return {
    mode: publishable ? 'release' : 'local',
    bootstrap,
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
async function verifyChildBuild({ result, projectionEvents, expected, outDir, upload, compiledWorkflow, compiledWorkflowDigest, node }) {
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
      compiledWorkflow,
      compiledWorkflowDigest,
      options: entry.normalized.options,
      manifest: entry.descriptor,
    });
    if (JSON.stringify(event.options) !== JSON.stringify(options)) {
      problems.push(`${entry.id}: payload options differ`);
    }
    const manifest = event.manifest ?? {};
    if (manifest.compiledWorkflow?.digest !== compiledWorkflowDigest) problems.push(`${entry.id}: payload compiled workflow digest differs`);
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
 *   repo?: string|null,
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
  repo = null,
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
    const compiledWorkflowBytes = Buffer.from(data.compiledWorkflow.data, 'base64');
    await writeFile(resolve(dir, 'input.zip'), bytes, { mode: 0o600 });
    await writeFile(resolve(dir, 'workflow.compiled.json'), compiledWorkflowBytes, { mode: 0o600 });
    const record = {
      uploadId,
      dir,
      bundleId: data.compiledWorkflow.id,
      version: data.compiledWorkflow.version,
      digest: data.compiledWorkflow.digest,
      contentSha256: data.compiledWorkflow.contentSha256,
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
   * Authoritative build (#75 §7.1): the uploaded zip and compiled workflow come from the
   * session dir, the shared projections run in-process, the release packager
   * runs as an isolated child, and the child's payload manifests must equal
   * the in-process results byte for byte.
   */
  const buildOnce = async (upload, parsed) => {
    const compiledWorkflowBytes = await readFile(resolve(upload.dir, 'workflow.compiled.json')).catch(() => null);
    if (compiledWorkflowBytes === null) return webError(404, 'WEB_UPLOAD_UNKNOWN', 'the upload is gone');
    const compiledWorkflowDigest = sha256Hex(compiledWorkflowBytes);
    if (compiledWorkflowDigest !== upload.digest) {
      return webError(500, 'WEB_INTERNAL', 'the stored compiled workflow does not match its digest');
    }
    let compiledWorkflow;
    try {
      compiledWorkflow = JSON.parse(compiledWorkflowBytes.toString('utf8'));
    } catch {
      return webError(500, 'WEB_INTERNAL', 'the stored compiled workflow is not JSON');
    }
    if (compiledWorkflow.id !== upload.bundleId || compiledWorkflow.version !== upload.version) {
      return webError(500, 'WEB_INTERNAL', 'the stored compiled workflow identity differs from the upload');
    }
    if (parsed.compiledWorkflowDigest !== undefined && parsed.compiledWorkflowDigest !== compiledWorkflowDigest) {
      return webError(409, 'PROJECTION_OPTIONS_COMPILED_WORKFLOW_MISMATCH', 'the options are bound to a different compiled workflow digest');
    }

    const allowed = allowedProjections(compiledWorkflow);
    // `requires.engine` constrains the engine package, not the framework, and
    // only when the runner runtime is part of this bundle (spec §13).
    if (allowed.includes('runner')) {
      const requirement = checkEngineRequirement({ range: compiledWorkflow.requires?.engine, engineVersion });
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
        compiledWorkflow,
        compiledWorkflowDigest,
        raw: requested[projectionId] ?? null,
        manifest: descriptor,
      });
      if (!normalized.ok) {
        const first = normalized.errors[0];
        const status = normalized.errors.some((item) => item.code === 'PROJECTION_OPTIONS_COMPILED_WORKFLOW_MISMATCH')
          ? 409
          : 400;
        return webError(status, first.code, first.message, {
          errors: normalized.errors,
          ...(first.target === undefined ? {} : { target: first.target }),
        });
      }
      const result = project({
        projectionId,
        compiledWorkflow,
        compiledWorkflowDigest,
        options: normalized.options,
        environment: { engineVersion },
        assets: {},
      });
      if (!result.ok) {
        const first = (result.errors ?? [])[0] ?? { code: 'PROJECTION_INTERNAL', message: 'projection failed' };
        return webError(400, first.code, first.message, { errors: result.errors ?? [] });
      }
      const validation = validateResult(result, {
        compiledWorkflow,
        compiledWorkflowDigest,
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
          compiledWorkflow,
          compiledWorkflowDigest,
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
      compiledWorkflow,
      compiledWorkflowDigest,
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
      repo,
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
      repo,
      compiledWorkflow: {
        schema: compiledWorkflow.schema,
        id: upload.bundleId,
        version: upload.version,
        digest: compiledWorkflowDigest,
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
