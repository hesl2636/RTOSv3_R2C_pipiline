/**
 * The injectable GitHub REST client (#107).
 *
 * The client is dumb on purpose: it carries a base URL, an optional token and
 * a `fetch`, and returns `{ok, status, headers, data, url}`. Resolution rules,
 * error codes and hints live in `release-source.js`; the publish state machine
 * lives in `release-publish.js`.
 *
 * The token is read at the composition root (`release-auth.js`) and passed in
 * here. It only ever goes into the `authorization` header: never into the URL,
 * the query string, a log line or a result object.
 */
export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_USER_AGENT = 'hm2b-release-client';

export class GithubClientError extends Error {
  constructor(code, message, { cause = undefined } = {}) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'GithubClientError';
    this.code = code;
  }
}

function isAbsolute(url) {
  return /^https?:\/\//i.test(String(url));
}

function joinUrl(base, target) {
  if (isAbsolute(target)) return String(target);
  const path = String(target);
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * @param {{base?: string, token?: string|null, fetch: typeof fetch,
 *          userAgent?: string, timeoutMs?: number, allowInsecure?: boolean}} options
 */
export function createGithubClient({
  base = GITHUB_API_BASE,
  token = null,
  fetch: fetchImpl = globalThis.fetch,
  userAgent = GITHUB_USER_AGENT,
  timeoutMs = 30_000,
  allowInsecure = false,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new GithubClientError('RELEASE_DOWNLOAD_FAILED', 'a fetch implementation is required');
  }
  const root = String(base).replace(/\/+$/, '');
  const normalToken = typeof token === 'string' && token !== '' ? token : null;
  if (normalToken !== null && !/^https:\/\//i.test(root) && !allowInsecure) {
    // Decision #74 §7.1: a token is never sent to a non-HTTPS origin.
    throw new GithubClientError(
      'RELEASE_AUTH_REQUIRED',
      'refusing to send a token over plain http; use https or allowInsecure for loopback fixtures only',
    );
  }

  async function request(method, target, options = {}) {
    const {
      body = null,
      accept = 'application/vnd.github+json',
      contentType = null,
      parse = 'json',
      timeout = timeoutMs,
    } = options;
    const url = joinUrl(root, target);
    const headers = { accept, 'user-agent': userAgent };
    if (normalToken !== null) headers.authorization = `Bearer ${normalToken}`;

    let payload;
    if (body === null || body === undefined) {
      payload = undefined;
    } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      payload = body;
      headers['content-type'] = contentType ?? 'application/octet-stream';
    } else {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['content-type'] = contentType ?? 'application/json';
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: payload,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const label = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return 'request';
        }
      })();
      throw new GithubClientError(
        'RELEASE_DOWNLOAD_FAILED',
        `${method} ${label} failed: ${error?.message ?? error}`,
        { cause: error },
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    let data = buffer;
    if (parse === 'json') {
      const text = buffer.toString('utf8');
      try {
        data = text === '' ? null : JSON.parse(text);
      } catch {
        data = null;
      }
    } else if (parse === 'text') {
      data = buffer.toString('utf8');
    }
    return { ok: response.ok, status: response.status, headers: response.headers, data, url };
  }

  // `token` stays readable by the source/publish modules but non-enumerable:
  // serialising the client (a log line, a web response) cannot leak it.
  const api = { base: root, request };
  Object.defineProperty(api, 'token', { value: normalToken, enumerable: false });
  return api;
}
