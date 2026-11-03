/**
 * HTTP hardening for the local read-only surface (spec #83 §14, decision #75).
 *
 * Server-only module: the browser never loads this file. It owns the security
 * envelope, the request preamble (host/origin/fetch-site/CSRF, header and URL
 * caps, rate limit), bounded body collection and the static whitelist.
 *
 * Every refusal uses the same envelope the handlers use:
 *   { ok: false, error: { code, message, details } }
 */
import { isInside } from '../core/paths.js';

export const BIND_HOST = '127.0.0.1';
export const ALLOWED_HOSTS = ['127.0.0.1', 'localhost'];

export const URL_MAX_BYTES = 2 * 1024;
export const HEADER_MAX_BYTES = 16 * 1024;
export const HEADERS_TIMEOUT_MS = 10 * 1000;
export const BODY_TIMEOUT_MS = 30 * 1000;
export const RATE_WINDOW_MS = 60 * 1000;
export const DEFAULT_RATE_LIMIT = 600;
export const JSON_MAX_BYTES = 256 * 1024;

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

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
});

/** Server-only modules under `web/` are never part of the static surface. */
const SERVER_MODULES = new Set(['serve.mjs', 'http.js', 'build.js', 'publish.js', 'child.js']);
/** Only these trees are public (decision #75 §10.6). */
const STATIC_PREFIXES = new Set(['web', 'core', 'compiled', 'assembler', 'projection', 'runtime']);
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

const HEADER_TOO_LARGE_MESSAGE = 'request headers exceed the limit';

export function parsePort(argv) {
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

export function rateLimitFromEnv(env = process.env) {
  const raw = env.HM2B_WEB_RATE_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_RATE_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RATE_LIMIT;
}

export function envInteger(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function securityHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

export function sendJson(response, status, payload, extra = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(status, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extra,
  }));
  response.end(body);
}

export function sendWebError(response, status, code, message, extra = {}, details = null) {
  sendJson(response, status, { ok: false, error: { code, message, details } }, extra);
}

export function webError(status, code, message, details = null, headers = {}) {
  return { status, code, message, details, headers };
}

export function foreignHost(request, port) {
  const header = request.headers.host;
  if (typeof header !== 'string') return true;
  return !ALLOWED_HOSTS.some((host) => header === `${host}:${port}`);
}

export function allowedOrigins(port) {
  return new Set(ALLOWED_HOSTS.map((host) => `http://${host}:${port}`));
}

function makeTimingSafeEqualText({ createHash, timingSafeEqual }) {
  return function timingSafeEqualText(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    // Hash both sides first: equal-length digests let timingSafeEqual run even
    // when an attacker sends a differently sized token.
    const a = createHash('sha256').update(left, 'utf8').digest();
    const b = createHash('sha256').update(right, 'utf8').digest();
    return timingSafeEqual(a, b);
  };
}

export function rawPathOf(request) {
  const url = request.url ?? '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Decode the URL exactly once and reject anything non-canonical. A residual
 * `%` means double encoding; `..` after decoding means traversal.
 */
export function decodeStaticPath(rawPath) {
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

export function staticCandidate(segments) {
  if (segments.length === 0) return { relative: 'web/index.html' };
  const [top, ...rest] = segments;
  if (!STATIC_PREFIXES.has(top)) return null;
  if (DENIED_TOP_LEVEL.has(top)) return null;
  if (top === 'web' && rest.length === 1 && SERVER_MODULES.has(rest[0].toLowerCase())) return null;
  // `runtime/<target>/engine/**` is never distributed (spec #83 §14).
  if (top === 'runtime' && rest.length >= 2 && rest[1].toLowerCase() === 'engine') return null;
  const relative = segments.join('/');
  if (/(^|\/)package[^/]*\.json$/i.test(relative)) return null;
  return { relative };
}

function makeLocateStatic({ lstat, extname, resolve }) {
  return async function locateStatic(root, segments) {
    const candidate = staticCandidate(segments);
    if (candidate === null) return null;
    const target = resolve(root, ...candidate.relative.split('/'));
    if (target === root || !isInside(root, target)) return null;
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
  };
}

export async function collectBody(request, declared, limit) {
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

export function isValidUploadContentType(value) {
  if (value === undefined) return true;
  const type = String(value).split(';', 1)[0].trim().toLowerCase();
  return type === '' || type === 'application/zip' || type === 'application/x-zip-compressed'
    || type === 'application/octet-stream';
}

/** Read one bounded JSON request body; errors are `webError` values. */
export async function readJsonBody(request, limit = JSON_MAX_BYTES) {
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

/** Sliding fixed-window counter shared by the global/build/publish limits. */
export function createRateLimiter({ limit, windowMs }) {
  const state = { windowStart: Date.now(), count: 0 };
  return {
    take(now = Date.now()) {
      if (now - state.windowStart >= windowMs) {
        state.windowStart = now;
        state.count = 0;
      }
      state.count += 1;
      if (state.count > limit) {
        const retryAfter = Math.max(1, Math.ceil((state.windowStart + windowMs - now) / 1000));
        return { ok: false, retryAfter };
      }
      return { ok: true };
    },
  };
}

/**
 * Bind the node-only primitives in the composition root (`serve.mjs`) so this
 * module stays a pure relative-import module for the architecture check.
 *
 * @param {{
 *   createHash: Function,
 *   timingSafeEqual: Function,
 *   lstat: Function,
 *   extname: Function,
 *   resolve: Function,
 * }} node
 */
export function createHttpGuards(node) {
  const timingSafeEqualText = makeTimingSafeEqualText(node);
  const locateStatic = makeLocateStatic(node);

  /**
   * The request preamble, in the frozen order: host, header bytes, URL bytes,
   * rate limit, method, then the POST triple (Origin, Sec-Fetch-Site, CSRF).
   * Returns `null` when the request may proceed.
   */
  const guardRequest = ({ request, port, csrf, rate }) => {
    if (foreignHost(request, port)) {
      return webError(403, 'WEB_HOST_INVALID', 'host is not allowed');
    }

    let rawHeaderBytes = 0;
    for (const value of request.rawHeaders ?? []) rawHeaderBytes += bytesOf(value);
    if (rawHeaderBytes > HEADER_MAX_BYTES) {
      return webError(413, 'WEB_HEADER_TOO_LARGE', HEADER_TOO_LARGE_MESSAGE);
    }
    if (bytesOf(String(request.url ?? '/')) > URL_MAX_BYTES) {
      return webError(413, 'WEB_URL_TOO_LONG', 'request URL exceeds the limit');
    }

    const limited = rate.take();
    if (!limited.ok) {
      return webError(429, 'WEB_RATE_LIMITED', 'too many requests', null, {
        'Retry-After': String(limited.retryAfter),
      });
    }

    const method = request.method ?? 'GET';
    if (method === 'OPTIONS' || !['GET', 'HEAD', 'POST'].includes(method)) {
      return webError(405, 'WEB_METHOD_NOT_ALLOWED', 'method is not allowed', null, { Allow: 'GET, HEAD, POST' });
    }

    if (method === 'POST') {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !allowedOrigins(port).has(origin)) {
        return webError(403, 'WEB_ORIGIN_INVALID', 'origin is not allowed');
      }
      // Missing, cross-site and any other value are refused: same-origin fetch
      // always sends `same-origin`, and a direct navigation sends `none`.
      const site = request.headers['sec-fetch-site'];
      if (site !== 'same-origin' && site !== 'none') {
        return webError(403, 'WEB_FETCH_SITE_INVALID', 'cross-site requests are not allowed');
      }
      if (!timingSafeEqualText(request.headers['x-hm2b-csrf'], csrf)) {
        return webError(403, 'WEB_CSRF_INVALID', 'CSRF token is missing or invalid');
      }
    }
    return null;
  };

  return { timingSafeEqualText, locateStatic, guardRequest };
}

function writeRawResponse(socket, status, reason, extraHeaders, body = null) {
  if (!socket.writable) return;
  const headers = securityHeaders({
    ...extraHeaders,
    ...(body === null ? {} : { 'Content-Length': String(body.length) }),
    Connection: 'close',
  });
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
  socket.end(body === null ? head : Buffer.concat([head, body]));
}

/**
 * Answer parse errors that Node raises before the request handler. An
 * oversized header is a contract refusal (413 + envelope); every other parse
 * error keeps the original bare 400/408 and closes the connection.
 */
export function respondClientError(error, socket) {
  if (!socket.writable) return;
  if (error?.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
    socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
    return;
  }
  if (error?.code === 'HPE_HEADER_OVERFLOW') {
    const body = Buffer.from(`${JSON.stringify({
      ok: false,
      error: { code: 'WEB_HEADER_TOO_LARGE', message: HEADER_TOO_LARGE_MESSAGE, details: null },
    })}\n`, 'utf8');
    writeRawResponse(socket, 413, 'Payload Too Large', { 'Content-Type': 'application/json; charset=utf-8' }, body);
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
}
