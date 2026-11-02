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
 * Everything under `web/` except this file is browser-loadable ESM and runs
 * the same shared modules (`core/`, `ir/`, `assembler/`) as the CLI.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
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
import { compileBundle } from '../assembler/compile.js';
import { BUNDLE_ID_MAX, isValidId } from '../assembler/ids.js';
import { LIMITS } from '../assembler/limits.js';
import { canonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { isInside } from '../core/paths.js';
import { isValidVersion } from '../core/semver.js';
import { isCanonicalOptions, normalizeOptions, payloadInputOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { allowedProjections, getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import { buildChildEnv, publishChildEnv, redactSecrets } from './env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const BIND_HOST = '127.0.0.1';
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost'];

const URL_MAX_BYTES = 2 * 1024;
const HEADER_MAX_BYTES = 16 * 1024;
const UPLOAD_MAX_BYTES = LIMITS.MAX_ZIP_BYTES + 4 * 1024;
const HEADERS_TIMEOUT_MS = 10 * 1000;
const BODY_TIMEOUT_MS = 30 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT = 600;

const UPLOAD_TTL_MS = 30 * 60 * 1000;
const BUILD_TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

const JSON_MAX_BYTES = 256 * 1024;
const MAX_UPLOADS = 4;
const MAX_BUILDS = 16;
const BUILD_TIMEOUT_MS = 120 * 1000;
// Operator-only overrides (never browser-controlled): a tighter timeout for
// slow CI hosts and an alternate packager entry for the child-isolation tests.

const BUILD_RATE_LIMIT = 60;
const BUILD_RATE_WINDOW_MS = 60 * 60 * 1000;
const BUILD_CONCURRENCY = 2;
const PUBLISH_TIMEOUT_MS = 300 * 1000;
const PUBLISH_RATE_LIMIT = 10;
const PUBLISH_RATE_WINDOW_MS = 60 * 60 * 1000;
const PUBLISH_JOB_LOG_MAX = 200;
const PUBLISH_LOG_LINE_MAX = 2000;
const GH_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BUNDLE_TAG_RE = /^bundle-[a-z0-9][a-z0-9-]*-v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const DEFAULT_GITHUB_API = 'https://api.github.com';
const STDERR_MAX_BYTES = 16 * 1024;
const STDOUT_LINE_MAX_BYTES = 4 * 1024 * 1024;
const RELEASE_SCRIPT = resolve(ROOT, 'scripts', 'release.mjs');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
});

/** Only these trees are public (decision #75 §10.6). */
const STATIC_PREFIXES = new Set(['web', 'core', 'ir', 'assembler', 'projection', 'runtime']);
const DENIED_TOP_LEVEL = new Set([
  '.git', 'node_modules', 'src', 'test', 'docs', 'examples', 'scripts', 'bin',
  'installer', 'adapters', 'pack', 'shims', 'plugins',
]);
const MIME = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.tpl': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
});
const STATIC_MAX_BYTES = 8 * 1024 * 1024;

function parsePort(argv) {
  const options = { port: 0, open: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new Error('--port requires a number');
      options.port = Number(value);
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      throw new Error('loopback only: --host is not supported');
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  return options;
}

function rateLimitFromEnv() {
  const raw = process.env.R2C_WEB_RATE_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_RATE_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RATE_LIMIT;
}

function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8');
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function securityHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function sendJson(response, status, payload, extra = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(status, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extra,
  }));
  response.end(body);
}

function sendWebError(response, status, code, message, extra = {}, details = null) {
  sendJson(response, status, { ok: false, error: { code, message, details } }, extra);
}

function foreignHost(request, port) {
  const header = request.headers.host;
  if (typeof header !== 'string') return true;
  return !ALLOWED_HOSTS.some((host) => header === `${host}:${port}`);
}

function allowedOrigins(port) {
  return new Set(ALLOWED_HOSTS.map((host) => `http://${host}:${port}`));
}

function timingSafeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  // Hash both sides first: equal-length digests let timingSafeEqual run even
  // when an attacker sends a differently sized token.
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function rawPathOf(request) {
  const url = request.url ?? '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Decode the URL exactly once and reject anything non-canonical. A residual
 * `%` means double encoding; `..` after decoding means traversal.
 */
function decodeStaticPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  let decoded;
  try {
    decoded = rawPath.includes('%') ? decodeURIComponent(rawPath) : rawPath;
  } catch {
    return null;
  }
  if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0')) return null;
  if (!decoded.startsWith('/')) return null;
  if (decoded === '/') return [];
  const segments = decoded.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.startsWith('.')) return null;
    if (segment.includes(':') || /[\x00-\x1f\x7f]/.test(segment)) return null;
  }
  return segments;
}

function staticCandidate(segments) {
  if (segments.length === 0) return { relative: 'web/index.html' };
  const [top, ...rest] = segments;
  if (!STATIC_PREFIXES.has(top)) return null;
  if (DENIED_TOP_LEVEL.has(top)) return null;
  if (top === 'web' && rest.length === 1 && rest[0].toLowerCase() === 'serve.mjs') return null;
  // `runtime/<target>/engine/**` is never distributed (spec #83 §14).
  if (top === 'runtime' && rest.length >= 2 && rest[1].toLowerCase() === 'engine') return null;
  const relative = segments.join('/');
  if (/(^|\/)package[^/]*\.json$/i.test(relative)) return null;
  return { relative };
}

async function collectBody(request, declared, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error('request body timed out');
      error.code = 'WEB_TIMEOUT';
      request.destroy();
      rejectBody(error);
    }, BODY_TIMEOUT_MS);
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectBody(error);
      else resolveBody(value);
    };
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > declared || total > limit) {
        finish(null, Object.assign(new Error('body exceeds the declared length'), { code: 'WEB_BODY_TOO_LARGE' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (total !== declared) {
        finish(null, Object.assign(new Error('body length does not match Content-Length'), { code: 'WEB_BODY_INVALID' }));
        return;
      }
      finish(new Uint8Array(Buffer.concat(chunks, total)));
    });
    request.on('error', (error) => finish(null, error));
    request.on('aborted', () => finish(null, Object.assign(new Error('request aborted'), { code: 'WEB_BODY_INVALID' })));
  });
}

function isValidUploadContentType(value) {
  if (value === undefined) return true;
  const type = String(value).split(';', 1)[0].trim().toLowerCase();
  return type === '' || type === 'application/zip' || type === 'application/x-zip-compressed'
    || type === 'application/octet-stream';
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function runValidation(bytes) {
  const primitives = { inflateRaw, sha256: sha256Hex };
  const compiled = compileBundle(bytes, primitives, { path: 'bundle.zip' });
  let ir = null;
  if (compiled.ok && compiled.irBytes !== null) {
    let contentSha256 = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(compiled.irBytes));
      contentSha256 = parsed?.source?.bundle?.contentSha256 ?? null;
    } catch {
      contentSha256 = null;
    }
    ir = {
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

async function existsFile(path) {
  try {
    const stats = await lstat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Build: options, child isolation, verification                              */
/* -------------------------------------------------------------------------- */

function envInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function startupSecrets() {
  return [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]
    .filter((value) => typeof value === 'string' && value !== '');
}

/** The publish credential lives in this closure only (decision #75 §8.1). */
function startupToken() {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Parse `https://host/owner/repo(.git)` or `git@host:owner/repo(.git)`. */
function parseGitRemote(url) {
  const text = String(url).trim();
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text);
  if (https !== null) return `${https[1]}/${https[2]}`;
  const ssh = /^(?:ssh:\/\/)?[^@/]+@[^:/]+[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/**
 * Target repository (decision #75 §8.2): `GH_REPO` wins, otherwise the
 * origin remote. The page can never choose a repository.
 */
function resolvePublishRepo() {
  const explicit = process.env.GH_REPO;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const value = explicit.trim();
    return GH_REPO_RE.test(value) ? value : null;
  }
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const repo = parseGitRemote(result.stdout);
  return repo !== null && GH_REPO_RE.test(repo) ? repo : null;
}

/** `R2C_GITHUB_API` is operator-only (local fixture or mirror), never browser-settable. */
function resolveGithubApi() {
  const raw = process.env.R2C_GITHUB_API;
  if (raw === undefined || raw.trim() === '') return DEFAULT_GITHUB_API;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return raw.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function redactValue(value, secrets) {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value), secrets));
  } catch {
    return null;
  }
}

/** `{confirmTag, resume?, irDigest?, resultDigests?}` (decision #75 §8.4/§8.5). */
function parsePublishBody(body) {
  if (!isPlainObject(body)) return webError(400, 'WEB_BODY_INVALID', 'publish body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!['confirmTag', 'resume', 'irDigest', 'resultDigests'].includes(key)) {
      return webError(400, 'WEB_BODY_INVALID', `unknown field ${key}`);
    }
  }
  if (typeof body.confirmTag !== 'string' || body.confirmTag === '') {
    return webError(400, 'WEB_BODY_INVALID', 'confirmTag is required');
  }
  if (body.resume !== undefined && typeof body.resume !== 'boolean') {
    return webError(400, 'WEB_BODY_INVALID', 'resume must be a boolean');
  }
  if (body.irDigest !== undefined && (typeof body.irDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.irDigest))) {
    return webError(400, 'WEB_BODY_INVALID', 'irDigest must be a sha256 digest');
  }
  if (body.resultDigests !== undefined && body.resultDigests !== null) {
    if (!isPlainObject(body.resultDigests)) {
      return webError(400, 'WEB_BODY_INVALID', 'resultDigests must be an object keyed by projection id');
    }
    for (const [key, value] of Object.entries(body.resultDigests)) {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        return webError(400, 'WEB_BODY_INVALID', `resultDigests.${key} must be a sha256 digest`);
      }
    }
  }
  return {
    confirmTag: body.confirmTag,
    resume: body.resume === true,
    irDigest: body.irDigest,
    resultDigests: body.resultDigests ?? null,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function webError(status, code, message, details = null, headers = {}) {
  return { status, code, message, details, headers };
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

/** Parse/validate the JSON build request without touching any state. */
function parseBuildBody(body) {
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

/** Read one bounded JSON request body; errors are `webError` values. */
async function readJsonBody(request, limit = JSON_MAX_BYTES) {
  const type = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return { error: webError(415, 'WEB_CONTENT_TYPE_INVALID', 'this endpoint takes JSON') };
  }
  const declaredHeader = request.headers['content-length'];
  if (declaredHeader === undefined) {
    return { error: webError(411, 'WEB_BODY_MISSING', 'Content-Length is required') };
  }
  const declared = Number(declaredHeader);
  if (!Number.isInteger(declared) || declared < 0) {
    return { error: webError(400, 'WEB_BODY_INVALID', 'Content-Length is invalid') };
  }
  if (declared > limit) {
    return { error: webError(413, 'WEB_BODY_TOO_LARGE', 'the request body exceeds the JSON limit') };
  }
  let raw;
  try {
    raw = await collectBody(request, declared, limit);
  } catch (error) {
    const status = error?.code === 'WEB_BODY_TOO_LARGE' ? 413 : error?.code === 'WEB_TIMEOUT' ? 408 : 400;
    return { error: webError(status, error?.code ?? 'WEB_BODY_INVALID', 'the request body could not be read') };
  }
  try {
    return { body: JSON.parse(Buffer.from(raw).toString('utf8')) };
  } catch {
    return { error: webError(400, 'WEB_BODY_INVALID', 'the body is not JSON') };
  }
}

function installCommand({ id, version, projection, target, publishable }) {
  if (!isValidId(id, BUNDLE_ID_MAX) || !isValidVersion(version) || String(version).includes('+')) return null;
  const descriptor = getProjection(projection);
  if (descriptor === null) return null;
  if (target !== null && !descriptor.targets.some((item) => item.id === target)) return null;
  const parts = [
    'node .r2c/bootstrap/install.mjs',
    '--bundle', id,
    '--version', version,
    '--projection', projection,
  ];
  if (target !== null) parts.push('--target', target);
  if (!publishable) parts.push('--release-base', './dist');
  parts.push('--project', '.');
  return parts.join(' ');
}

/** One fixed-version command per projection (and per selected agent target). */
function installCommands({ id, version, projections, publishable }) {
  const commands = [];
  for (const projection of projections) {
    if (projection.id === 'r2c') {
      const command = installCommand({ id, version, projection: 'r2c', target: null, publishable });
      if (command === null) return null;
      commands.push({ projection: 'r2c', target: null, command });
      continue;
    }
    const all = installCommand({ id, version, projection: projection.id, target: null, publishable });
    if (all === null) return null;
    commands.push({ projection: projection.id, target: null, command: all });
    for (const target of projection.targets) {
      const command = installCommand({ id, version, projection: projection.id, target, publishable });
      if (command === null) return null;
      commands.push({ projection: projection.id, target, command });
    }
  }
  return { mode: publishable ? 'release' : 'local', commands };
}

/**
 * Run the release packager as an isolated child (#75 §10.8).
 *
 * `process.execPath` + an argument array, never a shell. Non-publish children
 * lose the GitHub credentials, stdout is JSON-lines, stderr is capped and
 * redacted, and a timeout kills the child without touching the server.
 */
function runReleaseChild({ script, args, env, cwd, timeoutMs, secrets, onEvent = null }) {
  return new Promise((resolveChild) => {
    let child;
    try {
      child = spawn(process.execPath, ['--max-old-space-size=512', script, ...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveChild({
        status: 'failed',
        code: null,
        signal: null,
        events: [],
        logLines: [],
        stderr: redactSecrets(String(error?.message ?? error), secrets),
        stderrTruncated: false,
      });
      return;
    }

    const events = [];
    const logLines = [];
    let stdoutBuffer = '';
    let stderr = '';
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const consume = (line) => {
      if (line.trim() === '') return;
      if (line.length > STDOUT_LINE_MAX_BYTES) {
        logLines.push('[oversized stdout line]');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        logLines.push(redactSecrets(line, secrets));
        return;
      }
      if (isPlainObject(parsed) && typeof parsed.event === 'string') {
        events.push(parsed);
        if (typeof onEvent === 'function') {
          try {
            onEvent(parsed);
          } catch {
            // A consumer error must never take down the child or the server.
          }
        }
      } else logLines.push(redactSecrets(line, secrets));
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        consume(line);
      }
      if (stdoutBuffer.length > STDOUT_LINE_MAX_BYTES) {
        stdoutBuffer = '';
        logLines.push('[oversized stdout line]');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= STDERR_MAX_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = STDERR_MAX_BYTES - stderr.length;
      stderr += chunk.slice(0, remaining);
      if (chunk.length > remaining) stderrTruncated = true;
    });

    const finish = (status, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBuffer !== '') consume(stdoutBuffer);
      resolveChild({
        status,
        code,
        signal,
        events,
        logLines,
        stderr: redactSecrets(stderr, secrets),
        stderrTruncated,
      });
    };
    child.on('error', (error) => {
      stderr += String(error?.message ?? error);
      finish('failed', null, null);
    });
    child.on('close', (code, signal) => {
      if (timedOut) finish('timeout', code, signal);
      else finish(code === 0 ? 'exited' : 'failed', code, signal);
    });
  });
}

function expectedSums(assets) {
  return [...assets]
    .filter((asset) => asset.name !== 'SHA256SUMS.txt')
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join('');
}

/**
 * The server is the authority: it recomputes every asset byte and compares the
 * child's payload manifests with its own projection results (#75 §7.1 step 5).
 */
async function verifyChildBuild({ result, projectionEvents, expected, outDir, upload, ir, irDigest }) {
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
  const onDisk = (await readdir(outDir)).sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(onDisk)) {
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

async function locateStatic(segments) {
  const candidate = staticCandidate(segments);
  if (candidate === null) return null;
  const target = resolve(ROOT, ...candidate.relative.split('/'));
  if (target === ROOT || !isInside(ROOT, target)) return null;
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return null;
  if (stats.size > STATIC_MAX_BYTES) return null;
  const extension = extname(target).toLowerCase();
  const type = MIME[extension];
  if (type === undefined) return null;
  return { target, size: stats.size, type };
}

async function sweepStaleSessions(ownTempRoot) {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('r2c-web-')) continue;
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

  const version = await readFile(resolve(ROOT, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text).version ?? '0.0.0')
    .catch(() => '0.0.0');

  const tempRoot = await mkdtemp(resolve(tmpdir(), `r2c-web-${process.pid}-`));
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
  const rateLimit = rateLimitFromEnv();
  const uploadLimit = UPLOAD_MAX_BYTES;
  const modules = {
    projection: await existsFile(resolve(ROOT, 'projection', 'registry.js')),
    runtimeShared: await existsFile(resolve(ROOT, 'runtime', 'shared', 'constitution.js')),
  };
  const rate = { windowStart: Date.now(), count: 0 };

  const engineVersion = version;
  const secrets = startupSecrets();
  const buildTimeoutMs = envInteger('R2C_WEB_BUILD_TIMEOUT_MS', BUILD_TIMEOUT_MS);
  const publishTimeoutMs = envInteger('R2C_WEB_PUBLISH_TIMEOUT_MS', PUBLISH_TIMEOUT_MS);
  const releaseScript = process.env.R2C_WEB_RELEASE_SCRIPT === undefined
    ? RELEASE_SCRIPT
    : resolve(process.env.R2C_WEB_RELEASE_SCRIPT);
  // Operator-only override for the publish child (child-isolation tests and
  // wrappers); the browser can never choose a script.
  const publishScript = process.env.R2C_WEB_PUBLISH_SCRIPT === undefined
    ? releaseScript
    : resolve(process.env.R2C_WEB_PUBLISH_SCRIPT);
  const uploads = new Map();
  const builds = new Map();
  const buildRate = { windowStart: Date.now(), count: 0 };
  let activeBuilds = 0;

  // Publish credentials stay in this closure: never serialized, never logged,
  // never placed in a URL or an argv (decision #75 §8).
  const publishToken = startupToken();
  const publishRepo = resolvePublishRepo();
  const publishApi = resolveGithubApi();
  const publishConfig = Object.freeze({
    token: publishToken,
    repo: publishRepo,
    apiBase: publishApi,
    enabled: publishToken !== null && publishRepo !== null && publishApi !== null,
    reason: publishToken === null ? 'no-token' : publishRepo === null ? 'no-repo' : publishApi === null ? 'no-api' : null,
  });
  const publishRate = { windowStart: Date.now(), count: 0 };
  const publishJobs = new Map();
  let activePublish = null;

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

  /* ---- publish ---------------------------------------------------------- */

  const recordPublishLog = (job, text) => {
    const line = redactSecrets(String(text), secrets).slice(0, PUBLISH_LOG_LINE_MAX);
    if (line === '') return;
    job.log.push(line);
    if (job.log.length > PUBLISH_JOB_LOG_MAX) job.log.splice(0, job.log.length - PUBLISH_JOB_LOG_MAX);
  };

  /** Release-form install commands for a published build (§13 frozen shape). */
  const publishedInstall = (build) => installCommands({
    id: build.summary.ir.id,
    version: build.summary.ir.version,
    projections: build.summary.projections,
    publishable: true,
  });

  const publishResultView = (job) => ({
    jobId: job.jobId,
    buildId: job.buildId,
    tag: job.tag,
    state: job.state,
    phase: job.phase,
    log: [...job.log],
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  });

  const failPublishJob = (job, code, message, details = null) => {
    job.state = 'FAILED';
    job.error = { code, message, details: redactValue(details, secrets) };
    job.finishedAt = Date.now();
    recordPublishLog(job, `${code}: ${message}`);
  };

  /**
   * The publish tool is the only child that keeps the credentials
   * (decision #75 §10.8). `--out` is the server's own build directory inside
   * the session temp root; the child gets a 300 s budget, its stdout is
   * JSON-lines, and a crash or timeout never touches the server.
   */
  const runPublishJob = async (build, tag, jobId = randomBytes(8).toString('hex')) => {
    const job = {
      jobId,
      buildId: build.summary.buildId,
      tag,
      state: 'RUNNING',
      phase: 'BUILD_READY',
      log: [],
      error: null,
      result: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    publishJobs.set(jobId, job);
    activePublish = job;
    recordPublishLog(job, `BUILD_READY: ${tag}`);

    const outDir = resolve(build.dir, 'assets');
    const tmpDir = resolve(build.dir, 'publish-tmp');
    let child;
    try {
      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const env = publishChildEnv({
        ...process.env,
        TMPDIR: tmpDir,
        TEMP: tmpDir,
        TMP: tmpDir,
        GH_REPO: publishConfig.repo,
      });
      if (publishConfig.apiBase === DEFAULT_GITHUB_API) delete env.R2C_GITHUB_API;
      else env.R2C_GITHUB_API = publishConfig.apiBase;

      child = await runReleaseChild({
        script: publishScript,
        args: ['--publish', '--out', outDir, '--tag', tag, '--json'],
        env,
        cwd: ROOT,
        timeoutMs: publishTimeoutMs,
        secrets,
        onEvent: (event) => {
          if (event.event === 'phase' && typeof event.phase === 'string') {
            job.phase = event.phase;
            recordPublishLog(job, `phase ${event.phase}`);
          } else if (event.event === 'note' && typeof event.message === 'string') {
            recordPublishLog(job, `note: ${event.message}`);
          }
        },
      });
    } catch (error) {
      activePublish = null;
      failPublishJob(job, 'WEB_CHILD_FAILED', 'the publish child could not start', {
        stderr: String(error?.message ?? error),
      });
      return job;
    } finally {
      activePublish = null;
    }

    for (const line of child.logLines.slice(0, 50)) recordPublishLog(job, line);
    const resultEvent = child.events.filter((event) => event.event === 'result').pop();
    const releaseView = resultEvent === undefined
      ? null
      : {
        state: resultEvent.state ?? null,
        published: resultEvent.published === true,
        releaseId: resultEvent.releaseId ?? null,
        recovery: resultEvent.recovery ?? null,
        failures: Array.isArray(resultEvent.failures) ? resultEvent.failures.slice(0, 20) : [],
        cleanup: resultEvent.cleanup ?? null,
      };

    if (child.status === 'timeout') {
      failPublishJob(job, 'WEB_CHILD_TIMEOUT', 'the publish child was killed after the timeout', {
        timeoutMs: publishTimeoutMs,
        stderr: child.stderr,
        stderrTruncated: child.stderrTruncated,
      });
      return job;
    }
    if (child.status !== 'exited' || resultEvent === undefined || resultEvent.ok !== true) {
      failPublishJob(job, 'WEB_CHILD_FAILED', 'the publish child failed', {
        exitCode: child.code,
        signal: child.signal,
        stderr: child.stderr,
        stderrTruncated: child.stderrTruncated,
        release: releaseView,
      });
      return job;
    }

    job.state = 'PUBLISHED';
    job.phase = 'PUBLISHED';
    job.result = {
      tag: typeof resultEvent.tag === 'string' ? resultEvent.tag : tag,
      state: 'PUBLISHED',
      releaseId: typeof resultEvent.releaseId === 'number' ? resultEvent.releaseId : null,
      published: true,
      assets: build.summary.artifacts.map((asset) => ({
        name: asset.name,
        bytes: asset.bytes,
        sha256: asset.sha256,
        url: asset.url,
      })),
      install: publishedInstall(build),
    };
    job.finishedAt = Date.now();
    recordPublishLog(job, `PUBLISHED: ${job.result.tag} (release ${String(job.result.releaseId)})`);
    return job;
  };

  /** `GET /api/releases/:tag` — read-only remote state for recovery. */
  const lookupRelease = async (tag) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'r2c-web',
    };
    headers.Authorization = `Bearer ${publishConfig.token}`;
    const request = async (path) => {
      const response = await fetch(`${publishConfig.apiBase}/repos/${publishConfig.repo}${path}`, {
        headers,
        redirect: 'error',
      });
      return response;
    };
    const byTag = await request(`/releases/tags/${encodeURIComponent(tag)}`);
    if (byTag.status === 200) {
      const data = await byTag.json().catch(() => null);
      const assets = Array.isArray(data?.assets)
        ? data.assets.map((asset) => ({
          name: typeof asset?.name === 'string' ? asset.name : null,
          size: typeof asset?.size === 'number' ? asset.size : null,
          sha256: typeof asset?.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : null,
        }))
        : [];
      return { state: data?.draft === true ? 'draft' : 'published', releaseId: data?.id ?? null, assets };
    }
    if (byTag.status !== 404) {
      return { error: byTag.status };
    }
    const ref = await request(`/git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref.status === 200) return { state: 'tag-only', releaseId: null, assets: [] };
    if (ref.status === 404) return { state: 'absent', releaseId: null, assets: [] };
    return { error: ref.status };
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
  const performBuild = async (upload, parsed) => {
    const now = Date.now();
    if (now - buildRate.windowStart >= BUILD_RATE_WINDOW_MS) {
      buildRate.windowStart = now;
      buildRate.count = 0;
    }
    buildRate.count += 1;
    if (buildRate.count > BUILD_RATE_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((buildRate.windowStart + BUILD_RATE_WINDOW_MS - now) / 1000));
      return webError(429, 'WEB_RATE_LIMITED', 'too many builds in the current window', null, {
        'Retry-After': String(retryAfter),
      });
    }
    if (activeBuilds >= BUILD_CONCURRENCY) {
      return webError(409, 'WEB_BUILD_BUSY', 'another build is already running');
    }

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

    activeBuilds += 1;
    let child;
    try {
      child = await runReleaseChild({
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
        cwd: ROOT,
        timeoutMs: buildTimeoutMs,
        secrets,
      });
    } finally {
      activeBuilds -= 1;
    }

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

  const pruneState = () => {
    const now = Date.now();
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
    for (const [key, job] of publishJobs) {
      if (job.state !== 'RUNNING' && now - (job.finishedAt ?? job.startedAt) > BUILD_TTL_MS) {
        publishJobs.delete(key);
      }
    }
  };

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
    pruneState();
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

    if (foreignHost(request, port)) {
      status = 403;
      sendWebError(response, status, 'WEB_HOST_INVALID', 'host is not allowed');
      return;
    }

    let rawHeaderBytes = 0;
    for (const value of request.rawHeaders ?? []) rawHeaderBytes += bytesOf(value);
    if (rawHeaderBytes > HEADER_MAX_BYTES) {
      status = 413;
      sendWebError(response, status, 'WEB_HEADER_TOO_LARGE', 'request headers exceed the limit');
      return;
    }
    if (bytesOf(String(request.url ?? '/')) > URL_MAX_BYTES) {
      status = 413;
      sendWebError(response, status, 'WEB_URL_TOO_LONG', 'request URL exceeds the limit');
      return;
    }

    const now = Date.now();
    if (now - rate.windowStart >= RATE_WINDOW_MS) {
      rate.windowStart = now;
      rate.count = 0;
    }
    rate.count += 1;
    if (rate.count > rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((rate.windowStart + RATE_WINDOW_MS - now) / 1000));
      status = 429;
      sendWebError(response, status, 'WEB_RATE_LIMITED', 'too many requests', { 'Retry-After': String(retryAfter) });
      return;
    }

    const method = request.method ?? 'GET';
    if (method === 'OPTIONS') {
      status = 405;
      sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD, POST' });
      return;
    }
    if (!['GET', 'HEAD', 'POST'].includes(method)) {
      status = 405;
      sendWebError(response, status, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', { Allow: 'GET, HEAD, POST' });
      return;
    }

    if (method === 'POST') {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !allowedOrigins(port).has(origin)) {
        status = 403;
        sendWebError(response, status, 'WEB_ORIGIN_INVALID', 'origin is not allowed');
        return;
      }
      const site = request.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        status = 403;
        sendWebError(response, status, 'WEB_FETCH_SITE_INVALID', 'cross-site requests are not allowed');
        return;
      }
      if (!timingSafeEqualText(request.headers['x-r2c-csrf'], csrf)) {
        status = 403;
        sendWebError(response, status, 'WEB_CSRF_INVALID', 'CSRF token is missing or invalid');
        return;
      }
    }

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
          repo: publishConfig.repo,
          publish: {
            enabled: publishConfig.enabled,
            reason: publishConfig.reason,
            repo: publishConfig.repo,
          },
          frameworkVersion: version,
          engineVersion,
          modules,
          limits: {
            zipBytes: LIMITS.MAX_ZIP_BYTES,
            uploadBodyBytes: uploadLimit,
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
      if (declared > uploadLimit) {
        status = 413;
        sendWebError(response, status, 'WEB_BODY_TOO_LARGE', 'upload exceeds the size limit');
        return;
      }
      let bytes;
      try {
        bytes = await collectBody(request, declared, uploadLimit);
      } catch (error) {
        status = error?.code === 'WEB_BODY_TOO_LARGE' ? 413 : error?.code === 'WEB_TIMEOUT' ? 408 : 400;
        sendWebError(response, status, error?.code ?? 'WEB_BODY_INVALID', 'upload could not be read');
        return;
      }
      status = 200;
      const data = await runValidation(bytes);
      if (path === '/api/uploads') {
        data.uploadId = data.ir === null ? null : await persistUpload(bytes, data);
      }
      sendJson(response, status, { ok: data.report.ok, data });
      return;
    }

    if (path === '/api/builds') {
      if (method === 'GET' || method === 'HEAD') {
        status = 200;
        const data = { builds: [...builds.values()].map((build) => build.summary) };
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
      const upload = uploads.get(parsed.uploadId);
      if (upload === undefined) {
        status = 404;
        sendWebError(response, status, 'WEB_UPLOAD_UNKNOWN', 'the upload is unknown or expired');
        return;
      }
      touchUpload(upload);
      const built = await performBuild(upload, parsed);
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
      const build = builds.get(artifactMatch[1]);
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
      if (!publishConfig.enabled) {
        status = 403;
        sendWebError(response, status, 'WEB_PUBLISH_DISABLED', 'publishing is disabled on this server', {}, {
          reason: publishConfig.reason,
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

      const nowMs = Date.now();
      if (nowMs - publishRate.windowStart >= PUBLISH_RATE_WINDOW_MS) {
        publishRate.windowStart = nowMs;
        publishRate.count = 0;
      }
      publishRate.count += 1;
      if (publishRate.count > PUBLISH_RATE_LIMIT) {
        const retryAfter = Math.max(1, Math.ceil((publishRate.windowStart + PUBLISH_RATE_WINDOW_MS - nowMs) / 1000));
        status = 429;
        sendWebError(response, status, 'WEB_RATE_LIMITED', 'too many publishes in the current window', {
          'Retry-After': String(retryAfter),
        });
        return;
      }
      if (activePublish !== null) {
        status = 409;
        sendWebError(response, status, 'WEB_PUBLISH_BUSY', 'a publish job is already running');
        return;
      }

      const build = builds.get(publishMatch[1]);
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
      void runPublishJob(build, build.summary.tag, jobId).catch((error) => {
        const job = publishJobs.get(jobId);
        if (job !== undefined && job.state === 'RUNNING') {
          failPublishJob(job, 'WEB_CHILD_FAILED', 'the publish job crashed', {
            message: String(error?.message ?? error),
          });
        }
        activePublish = null;
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
      const job = publishJobs.get(jobMatch[1]);
      if (job === undefined) {
        status = 404;
        sendWebError(response, status, 'WEB_JOB_UNKNOWN', 'the publish job is unknown or expired');
        return;
      }
      status = 200;
      const payload = { ok: true, data: publishResultView(job) };
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
      if (!publishConfig.enabled) {
        status = 403;
        sendWebError(response, status, 'WEB_PUBLISH_DISABLED', 'publishing is disabled on this server', {}, {
          reason: publishConfig.reason,
        });
        return;
      }
      let remote;
      try {
        remote = await lookupRelease(tag);
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
    const located = await locateStatic(segments);
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
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    const status = error?.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    socket.end(`HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\n\r\n`);
  });

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
