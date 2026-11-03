#!/usr/bin/env node
/**
 * Local read-only web surface (spec #83 §14, decision #75, ticket #108).
 *
 * One process, static ESM, zero build:
 *   node web/serve.mjs [--port <n>] [--no-open]
 *
 * The server binds loopback only (there is deliberately no `--host`), serves a
 * fixed whitelist of source directories, and exposes exactly one authoritative
 * operation: upload one zip, receive the shared `Report` plus the compiled IR.
 * Uploads are handled entirely in memory; the only filesystem writes are the
 * 0700 session directory under `os.tmpdir()`.
 *
 * This file is the wiring only. HTTP hardening lives in `http.js`, upload /
 * build orchestration in `build.js`, and publish orchestration in `publish.js`.
 * Everything under `web/` except the server modules is browser-loadable ESM
 * and runs the same shared modules (`core/`, `ir/`, `assembler/`) as the CLI.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../assembler/limits.js';
import {
  BUILD_TTL_MS,
  UPLOAD_TTL_MS,
  createBuildService,
  parseBuildBody,
  runValidation,
} from './build.js';
import {
  BIND_HOST,
  BODY_TIMEOUT_MS,
  HEADER_MAX_BYTES,
  HEADERS_TIMEOUT_MS,
  JSON_MAX_BYTES,
  bytesOf,
  collectBody,
  createRateLimiter,
  createHttpGuards,
  decodeStaticPath,
  envInteger,
  isValidUploadContentType,
  parsePort,
  rateLimitFromEnv,
  rawPathOf,
  readJsonBody,
  respondClientError,
  securityHeaders,
  sendJson,
  sendWebError,
} from './http.js';
import {
  BUNDLE_TAG_RE,
  PUBLISH_TIMEOUT_MS,
  createPublishService,
  parsePublishBody,
} from './publish.js';
import { redactSecrets } from './env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;
const RELEASE_SCRIPT = resolve(ROOT, 'scripts', 'release.mjs');

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function startupSecrets(env) {
  return [env.GH_TOKEN, env.GITHUB_TOKEN]
    .filter((value) => typeof value === 'string' && value !== '');
}

async function sweepStaleSessions(ownTempRoot) {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('hm2b-web-')) continue;
    const candidate = resolve(tmpdir(), entry.name);
    if (candidate === ownTempRoot) continue;
    let marker;
    try {
      marker = JSON.parse(await readFile(resolve(candidate, 'session.json'), 'utf8'));
    } catch {
      continue; // Only directories carrying our marker are ours to delete.
    }
    const old = Number.isFinite(marker?.startedAt) && Date.now() - marker.startedAt > STALE_SESSION_MS;
    if (old || !isAlive(marker?.pid)) {
      await rm(candidate, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function sweepIdle(tempRoot) {
  for (const [name, ttl] of [['uploads', UPLOAD_TTL_MS], ['builds', BUILD_TTL_MS]]) {
    const directory = resolve(tempRoot, name);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = resolve(directory, entry.name);
      let stats;
      try {
        stats = await lstat(target);
      } catch {
        continue;
      }
      if (Date.now() - stats.mtimeMs > ttl) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

async function readVersion(path) {
  return readFile(path, 'utf8')
    .then((text) => JSON.parse(text).version ?? null)
    .catch(() => null);
}

async function main() {
  let options;
  try {
    options = parsePort(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write('Usage: node web/serve.mjs [--port <n>] [--no-open]\nLoopback only; no --host.\n');
    return;
  }

  const version = (await readVersion(resolve(ROOT, 'package.json'))) ?? '0.0.0';
  // The framework and the runtime engine ship independently (spec §13): the
  // session/projection environment reports `runtime/runner/engine/package.json`.
  const engineVersion = await readVersion(resolve(ROOT, 'runtime', 'runner', 'engine', 'package.json'));

  const tempRoot = await mkdtemp(resolve(tmpdir(), `hm2b-web-${process.pid}-`));
  await chmod(tempRoot, 0o700);
  await writeFile(
    resolve(tempRoot, 'session.json'),
    `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), frameworkVersion: version })}\n`,
    { mode: 0o600 },
  );
  await mkdir(resolve(tempRoot, 'uploads'), { mode: 0o700 });
  await mkdir(resolve(tempRoot, 'builds'), { mode: 0o700 });
  await sweepStaleSessions(tempRoot);

  const csrf = randomBytes(32).toString('hex');
  const rate = createRateLimiter({ limit: rateLimitFromEnv(), windowMs: 60 * 1000 });
  const secrets = startupSecrets(process.env);
  const buildTimeoutMs = envInteger('HM2B_WEB_BUILD_TIMEOUT_MS', 120 * 1000);
  const publishTimeoutMs = envInteger('HM2B_WEB_PUBLISH_TIMEOUT_MS', PUBLISH_TIMEOUT_MS);
  const releaseScript = process.env.HM2B_WEB_RELEASE_SCRIPT === undefined
    ? RELEASE_SCRIPT
    : resolve(process.env.HM2B_WEB_RELEASE_SCRIPT);
  // Operator-only override for the publish child (child-isolation tests and
  // wrappers); the browser can never choose a script.
  const publishScript = process.env.HM2B_WEB_PUBLISH_SCRIPT === undefined
    ? releaseScript
    : resolve(process.env.HM2B_WEB_PUBLISH_SCRIPT);

  const { guardRequest, locateStatic } = createHttpGuards({
    createHash,
    timingSafeEqual,
    lstat,
    extname,
    resolve,
  });
  const node = {
    randomBytes,
    spawn,
    spawnSync,
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
    lstat,
    extname,
    resolve,
  };

  const builds = createBuildService({
    root: ROOT,
    tempRoot,
    engineVersion,
    secrets,
    releaseScript,
    buildTimeoutMs,
    node,
  });
  const publishes = createPublishService({
    root: ROOT,
    secrets,
    publishScript,
    publishTimeoutMs,
    node,
  });

  let port = options.port;
  let shutdownStarted = false;
  let server;

  const shutdown = async (code) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearInterval(sweeper);
    try {
      server?.close();
      server?.closeAllConnections?.();
    } catch {
      // The listener may never have been created.
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
  };

  const sweeper = setInterval(() => {
    void sweepIdle(tempRoot);
    builds.pruneState();
    publishes.pruneState();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const handler = async (request, response) => {
    const started = Date.now();
    const path = rawPathOf(request);
    let status = 500;
    const finish = () => {
      process.stdout.write(`${request.method} ${path} ${status} ${Date.now() - started}ms\n`);
    };
    response.on('finish', finish);

    const refused = guardRequest({ request, port, csrf, rate });
    if (refused !== null) {
      status = refused.status;
      sendWebError(response, status, refused.code, refused.message, refused.headers, refused.details);
      return;
    }

    const method = request.method ?? 'GET';

    if (path === '/api/session') {
      if (method === 'POST') {
        status = 405;
        sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD' });
        return;
      }
      status = 200;
      const payload = {
        ok: true,
        data: {
          csrf,
          mode: 'build',
          repo: publishes.config.repo,
          publish: {
            enabled: publishes.config.enabled,
            reason: publishes.config.reason,
            repo: publishes.config.repo,
          },
          frameworkVersion: version,
          engineVersion,
          limits: {
            zipBytes: LIMITS.MAX_ZIP_BYTES,
            uploadBodyBytes: builds.uploadLimit,
            entries: LIMITS.MAX_ENTRIES,
            uncompressedBytes: LIMITS.MAX_UNCOMPRESSED_BYTES,
            entryBytes: LIMITS.MAX_ENTRY_BYTES,
            pathBytes: LIMITS.MAX_PATH_BYTES,
            pathDepth: LIMITS.MAX_PATH_DEPTH,
            taskBytes: LIMITS.MAX_TASK_BYTES,
            constitutionBytes: LIMITS.MAX_CONSTITUTION_BYTES,
          },
        },
      };
      if (method === 'HEAD') {
        response.writeHead(status, securityHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(bytesOf(JSON.stringify(payload)) + 1),
        }));
        response.end();
        return;
      }
      sendJson(response, status, payload);
      return;
    }

    if (path === '/api/validate' || path === '/api/uploads') {
      if (method !== 'POST') {
        status = 405;
        sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'POST' });
        return;
      }
      if (!isValidUploadContentType(request.headers['content-type'])) {
        status = 415;
        sendWebError(response, status, 'WEB_CONTENT_TYPE_INVALID', 'upload must be a zip byte stream');
        return;
      }
      const declaredHeader = request.headers['content-length'];
      if (declaredHeader === undefined) {
        status = 411;
        sendWebError(response, status, 'WEB_BODY_MISSING', 'Content-Length is required');
        return;
      }
      const declared = Number(declaredHeader);
      if (!Number.isInteger(declared) || declared < 0) {
        status = 400;
        sendWebError(response, status, 'WEB_BODY_INVALID', 'Content-Length is invalid');
        return;
      }
      if (declared > builds.uploadLimit) {
        status = 413;
        sendWebError(response, status, 'WEB_BODY_TOO_LARGE', 'upload exceeds the size limit');
        return;
      }
      let bytes;
      try {
        bytes = await collectBody(request, declared, builds.uploadLimit);
      } catch (error) {
        status = error?.code === 'WEB_BODY_TOO_LARGE' ? 413 : error?.code === 'WEB_TIMEOUT' ? 408 : 400;
        sendWebError(response, status, error?.code ?? 'WEB_BODY_INVALID', 'upload could not be read');
        return;
      }
      status = 200;
      const data = await runValidation(bytes);
      if (path === '/api/uploads') {
        data.uploadId = data.ir === null ? null : await builds.persistUpload(bytes, data);
      }
      sendJson(response, status, { ok: data.report.ok, data });
      return;
    }

    if (path === '/api/builds') {
      if (method === 'GET' || method === 'HEAD') {
        status = 200;
        const data = { builds: [...builds.builds.values()].map((build) => build.summary) };
        if (method === 'HEAD') {
          const length = bytesOf(JSON.stringify({ ok: true, data })) + 1;
          response.writeHead(status, securityHeaders({
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(length),
          }));
          response.end();
          return;
        }
        sendJson(response, status, { ok: true, data });
        return;
      }
      if (method !== 'POST') {
        status = 405;
        sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD, POST' });
        return;
      }
      const type = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (type !== 'application/json') {
        status = 415;
        sendWebError(response, status, 'WEB_CONTENT_TYPE_INVALID', 'build requests are JSON');
        return;
      }
      const declaredHeader = request.headers['content-length'];
      if (declaredHeader === undefined) {
        status = 411;
        sendWebError(response, status, 'WEB_BODY_MISSING', 'Content-Length is required');
        return;
      }
      const declared = Number(declaredHeader);
      if (!Number.isInteger(declared) || declared < 0) {
        status = 400;
        sendWebError(response, status, 'WEB_BODY_INVALID', 'Content-Length is invalid');
        return;
      }
      if (declared > JSON_MAX_BYTES) {
        status = 413;
        sendWebError(response, status, 'WEB_BODY_TOO_LARGE', 'build request exceeds the JSON limit');
        return;
      }
      let raw;
      try {
        raw = await collectBody(request, declared, JSON_MAX_BYTES);
      } catch (error) {
        status = error?.code === 'WEB_BODY_TOO_LARGE' ? 413 : error?.code === 'WEB_TIMEOUT' ? 408 : 400;
        sendWebError(response, status, error?.code ?? 'WEB_BODY_INVALID', 'build request could not be read');
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        status = 400;
        sendWebError(response, status, 'WEB_BODY_INVALID', 'build body is not JSON');
        return;
      }
      const parsed = parseBuildBody(body);
      if (parsed.status !== undefined) {
        status = parsed.status;
        sendWebError(response, status, parsed.code, parsed.message, parsed.headers, parsed.details);
        return;
      }
      const upload = builds.uploads.get(parsed.uploadId);
      if (upload === undefined) {
        status = 404;
        sendWebError(response, status, 'WEB_UPLOAD_UNKNOWN', 'the upload is unknown or expired');
        return;
      }
      builds.touchUpload(upload);
      const built = await builds.performBuild(upload, parsed);
      status = built.status;
      if (built.summary !== undefined) {
        sendJson(response, status, { ok: true, data: built.summary });
      } else {
        sendWebError(response, status, built.code, built.message, built.headers, built.details);
      }
      return;
    }

    const artifactMatch = /^\/api\/builds\/([0-9a-f]{16})\/artifacts\/([^/]+)$/.exec(path);
    if (artifactMatch !== null) {
      if (method === 'POST') {
        status = 405;
        sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD' });
        return;
      }
      const build = builds.builds.get(artifactMatch[1]);
      if (build === undefined) {
        status = 404;
        sendWebError(response, status, 'WEB_BUILD_UNKNOWN', 'the build is unknown or expired');
        return;
      }
      let name;
      try {
        name = decodeURIComponent(artifactMatch[2]);
      } catch {
        status = 404;
        sendWebError(response, status, 'WEB_PATH_INVALID', 'not found');
        return;
      }
      if (name.includes('/') || name.includes('\\') || name.includes('%') || name.includes('..')) {
        status = 404;
        sendWebError(response, status, 'WEB_PATH_INVALID', 'not found');
        return;
      }
      const asset = build.assets.get(name);
      if (asset === undefined) {
        status = 404;
        sendWebError(response, status, 'WEB_NOT_FOUND', 'not found');
        return;
      }
      let bytes;
      try {
        bytes = await readFile(asset.path);
      } catch {
        status = 404;
        sendWebError(response, status, 'WEB_NOT_FOUND', 'not found');
        return;
      }
      build.lastUsed = Date.now();
      status = 200;
      response.writeHead(status, securityHeaders({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${name}"`,
      }));
      if (method === 'HEAD') response.end();
      else response.end(bytes);
      return;
    }

    const publishMatch = /^\/api\/builds\/([0-9a-f]{16})\/publish$/.exec(path);
    if (publishMatch !== null) {
      if (method !== 'POST') {
        status = 405;
        sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'POST' });
        return;
      }
      if (!publishes.config.enabled) {
        status = 403;
        sendWebError(response, status, 'WEB_PUBLISH_DISABLED', 'publishing is disabled on this server', {}, {
          reason: publishes.config.reason,
        });
        return;
      }
      const parsedBody = await readJsonBody(request);
      if (parsedBody.error !== undefined) {
        status = parsedBody.error.status;
        sendWebError(response, status, parsedBody.error.code, parsedBody.error.message);
        return;
      }
      const body = parsePublishBody(parsedBody.body);
      if (body.status !== undefined) {
        status = body.status;
        sendWebError(response, status, body.code, body.message);
        return;
      }

      const limited = publishes.takeRate();
      if (!limited.ok) {
        status = 429;
        sendWebError(response, status, 'WEB_RATE_LIMITED', 'too many publishes in the current window', {
          'Retry-After': String(limited.retryAfter),
        });
        return;
      }
      if (publishes.isBusy()) {
        status = 409;
        sendWebError(response, status, 'WEB_PUBLISH_BUSY', 'a publish job is already running');
        return;
      }

      const build = builds.builds.get(publishMatch[1]);
      if (build === undefined) {
        status = 404;
        sendWebError(response, status, 'WEB_BUILD_UNKNOWN', 'the build is unknown or expired');
        return;
      }
      if (build.summary.publishable !== true || build.summary.canonical !== true) {
        status = 409;
        sendWebError(response, status, 'WEB_PUBLISH_NOT_CANONICAL', 'only a canonical build can be published');
        return;
      }
      if (body.confirmTag !== build.summary.tag) {
        status = 400;
        sendWebError(response, status, 'WEB_TAG_MISMATCH', 'confirmTag does not match the release tag', {}, {
          tag: build.summary.tag,
        });
        return;
      }
      if (body.irDigest !== undefined && body.irDigest !== build.summary.ir.digest) {
        status = 409;
        sendWebError(response, status, 'WEB_CLIENT_SERVER_MISMATCH', 'the browser and the server disagree about the IR digest');
        return;
      }
      if (body.resultDigests !== null) {
        for (const projection of build.summary.projections) {
          const supplied = body.resultDigests[projection.id];
          if (supplied !== undefined && supplied !== projection.digest) {
            status = 409;
            sendWebError(
              response,
              status,
              'WEB_CLIENT_SERVER_MISMATCH',
              `the browser and the server disagree about the ${projection.id} result digest`,
            );
            return;
          }
        }
      }

      const jobId = randomBytes(8).toString('hex');
      void publishes.runPublishJob(build, build.summary.tag, jobId).catch((error) => {
        const job = publishes.getJob(jobId);
        if (job !== undefined && job.state === 'RUNNING') {
          publishes.failJob(job, 'WEB_CHILD_FAILED', 'the publish job crashed', {
            message: String(error?.message ?? error),
          });
        }
        publishes.clearActive();
      });
      status = 202;
      sendJson(response, status, {
        ok: true,
        data: { jobId, tag: build.summary.tag, state: 'RUNNING', phase: 'BUILD_READY' },
      });
      return;
    }

    const jobMatch = /^\/api\/publish\/([0-9a-f]{16})$/.exec(path);
    if (jobMatch !== null) {
      if (method === 'POST') {
        status = 405;
        sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD' });
        return;
      }
      const job = publishes.getJob(jobMatch[1]);
      if (job === undefined) {
        status = 404;
        sendWebError(response, status, 'WEB_JOB_UNKNOWN', 'the publish job is unknown or expired');
        return;
      }
      status = 200;
      const payload = { ok: true, data: publishes.view(job) };
      if (method === 'HEAD') {
        response.writeHead(status, securityHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(bytesOf(JSON.stringify(payload)) + 1),
        }));
        response.end();
        return;
      }
      sendJson(response, status, payload);
      return;
    }

    const releaseMatch = /^\/api\/releases\/([^/]+)$/.exec(path);
    if (releaseMatch !== null) {
      if (method === 'POST') {
        status = 405;
        sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD' });
        return;
      }
      let tag;
      try {
        tag = decodeURIComponent(releaseMatch[1]);
      } catch {
        status = 404;
        sendWebError(response, status, 'WEB_NOT_FOUND', 'not found');
        return;
      }
      if (!BUNDLE_TAG_RE.test(tag)) {
        status = 404;
        sendWebError(response, status, 'WEB_NOT_FOUND', 'not found');
        return;
      }
      if (!publishes.config.enabled) {
        status = 403;
        sendWebError(response, status, 'WEB_PUBLISH_DISABLED', 'publishing is disabled on this server', {}, {
          reason: publishes.config.reason,
        });
        return;
      }
      let remote;
      try {
        remote = await publishes.lookupRelease(tag);
      } catch (error) {
        status = 502;
        sendWebError(response, status, 'RELEASE_LOOKUP_FAILED', 'the release state could not be read', {}, {
          message: redactSecrets(String(error?.message ?? error), secrets),
        });
        return;
      }
      if (remote.error !== undefined) {
        status = 502;
        sendWebError(response, status, 'RELEASE_LOOKUP_FAILED', 'the release state could not be read', {}, {
          status: remote.error,
        });
        return;
      }
      status = 200;
      sendJson(response, status, { ok: true, data: { tag, ...remote } });
      return;
    }

    if (path.startsWith('/api/')) {
      status = 404;
      sendWebError(response, status, 'WEB_NOT_FOUND', 'not found');
      return;
    }

    if (method === 'POST') {
      status = 405;
      sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const segments = decodeStaticPath(path);
    if (segments === null) {
      status = 404;
      sendWebError(response, status, 'WEB_PATH_INVALID', 'not found');
      return;
    }
    const located = await locateStatic(ROOT, segments);
    if (located === null) {
      status = 404;
      sendWebError(response, status, 'WEB_NOT_FOUND', 'not found');
      return;
    }
    let body;
    try {
      body = await readFile(located.target);
    } catch {
      status = 404;
      sendWebError(response, status, 'WEB_NOT_FOUND', 'not found');
      return;
    }
    status = 200;
    response.writeHead(status, securityHeaders({
      'Content-Type': located.type,
      'Content-Length': String(body.length),
    }));
    if (method === 'HEAD') response.end();
    else response.end(body);
  };

  server = createServer({ maxHeaderSize: HEADER_MAX_BYTES, headersTimeout: HEADERS_TIMEOUT_MS }, (request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) {
        sendWebError(response, 500, 'WEB_INTERNAL', 'internal error');
      } else {
        response.end();
      }
    });
  });
  server.requestTimeout = BODY_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.on('clientError', respondClientError);

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, BIND_HOST, () => {
      server.off('error', rejectListen);
      port = server.address().port;
      resolveListen();
    });
  });

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('uncaughtException', (error) => {
    process.stderr.write(`uncaught: ${error instanceof Error ? error.message : String(error)}\n`);
    void shutdown(1);
  });
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`unhandled: ${error instanceof Error ? error.message : String(error)}\n`);
    void shutdown(1);
  });
  process.on('exit', () => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Best effort during abrupt termination.
    }
  });
  // Piped stdin is an auxiliary graceful-stop channel (tests/wrappers):
  // `shutdown\n` exits through the same cleanup path as SIGTERM. EOF alone
  // does nothing, so `stdio: ['ignore']` launches keep serving.
  if (process.stdin && typeof process.stdin.on === 'function' && process.stdin.isTTY !== true) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (String(chunk).trim() === 'shutdown') void shutdown(0);
    });
    process.stdin.resume();
  }

  process.stdout.write(`http://${BIND_HOST}:${port}/\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
