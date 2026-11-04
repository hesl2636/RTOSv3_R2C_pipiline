/**
 * Release-source API shared by the installer (#106), the web publisher (#110)
 * and the framework CLI (#107, decisions #74).
 *
 * Four operations:
 * - `resolveLatest`  — paginated `/releases`, drafts/prereleases filtered, max
 *                      semver among exact `bundle-<id>-v<semver>` tags.
 * - `resolveVersion` — explicit version: `/releases/tags/<tag>` with a token,
 *                      no API at all without one (direct asset URLs).
 * - `downloadAsset`  — asset id (token) or `<downloadBase>/<tag>/<asset>`.
 * - `verifySums`     — compare asset bytes/plan entries to `SHA256SUMS.txt`.
 *
 * The GitHub client is injected; this module never reads `process.env`.
 */
import { compareSemver, isValidVersion } from '../core/semver.js';
import { sha256Hex } from '../core/node/sha256.js';
import {
  SUMS_ASSET,
  bundleTag,
  isLegacyEngineTag,
  isValidBundleId,
  parseBundleTag,
} from './release-tags.js';

export const DEFAULT_RELEASE_REPO = 'hesl2636/hm2B_drvport_pipiline';
export const RELEASE_PAGE_SIZE = 100;
export const RELEASE_MAX_PAGES = 10;
const SUMS_LINE = /^([0-9a-f]{64})\s+\*?(.+)$/;

export class ReleaseSourceError extends Error {
  constructor(code, message, { status = null, hint = null } = {}) {
    super(`${code}: ${message}`);
    this.name = 'ReleaseSourceError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

/** `https://github.com/<repo>/releases/download` (mirrors the bootstrap). */
export function releaseDownloadBase(repo = DEFAULT_RELEASE_REPO, origin = 'https://github.com') {
  return `${String(origin).replace(/\/+$/, '')}/${repo}/releases/download`;
}

function apiMessage(response) {
  const message = response?.data?.message;
  return typeof message === 'string' && message !== '' ? ` (${message})` : '';
}

/**
 * Map a failed read request to the release/installer error family (#74 §5.3).
 * Anonymous 403/429 is the API rate limit — never a reason to guess a version.
 */
function readFailure(response, { anonymous, what }) {
  const status = response.status;
  const detail = apiMessage(response);
  if (status === 401) {
    return new ReleaseSourceError(
      'RELEASE_AUTH_REQUIRED',
      `${what}: HTTP 401${detail}; set GH_TOKEN with contents:read`,
      { status, hint: 'GH_TOKEN' },
    );
  }
  if (status === 403 || status === 429) {
    if (anonymous) {
      return new ReleaseSourceError(
        'RELEASE_RATE_LIMITED',
        `${what}: HTTP ${status}${detail}; the anonymous API limit was hit — pass --version <V> (anonymous) or set GH_TOKEN`,
        { status, hint: '--version <V> (anonymous) or GH_TOKEN' },
      );
    }
    return new ReleaseSourceError(
      'RELEASE_FORBIDDEN',
      `${what}: HTTP ${status}${detail}; GH_TOKEN needs contents:read on the repository`,
      { status, hint: 'contents:read' },
    );
  }
  if (status === 404) {
    return new ReleaseSourceError('RELEASE_NOT_FOUND', `${what}: HTTP 404 (missing or not visible)`, { status });
  }
  return new ReleaseSourceError('RELEASE_DOWNLOAD_FAILED', `${what}: HTTP ${status}${detail}`, { status });
}

function requireClient(client) {
  if (client === null || typeof client !== 'object' || typeof client.request !== 'function') {
    throw new TypeError('a GitHub client ({base, token, fetch}) is required');
  }
  return client.token === null || client.token === undefined ? null : client.token;
}

/**
 * Resolve the latest published version of one bundle.
 *
 * @returns {Promise<{tag: string, bundleId: string, version: string,
 *   releaseId: number|null, assets: Array<object>|null, pages: number, scanned: number}>}
 */
export async function resolveLatest({
  client,
  repo = DEFAULT_RELEASE_REPO,
  bundleId,
  perPage = RELEASE_PAGE_SIZE,
  maxPages = RELEASE_MAX_PAGES,
} = {}) {
  requireClient(client);
  if (!isValidBundleId(bundleId)) {
    throw new ReleaseSourceError(
      'RELEASE_OPTION_CONFLICT',
      `--bundle must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got ${JSON.stringify(bundleId)})`,
      { hint: '--bundle <id>' },
    );
  }

  let best = null;
  let scanned = 0;
  const seenTags = [];

  const fetchPage = async (page) => {
    const response = await client.request(
      'GET',
      `/repos/${repo}/releases?per_page=${perPage}&page=${page}`,
      { accept: 'application/vnd.github+json' },
    );
    if (!response.ok) {
      throw readFailure(response, { anonymous: client.token === null, what: `list releases of ${repo}` });
    }
    if (!Array.isArray(response.data)) {
      throw new ReleaseSourceError(
        'RELEASE_VERSION_UNRESOLVED',
        `list releases of ${repo}: page ${page} is not an array; pass --version <V>`,
        { hint: '--version <V>' },
      );
    }
    return response.data;
  };

  const collect = (entries) => {
    scanned += entries.length;
    for (const entry of entries) {
      const tag = entry?.tag_name;
      if (typeof tag !== 'string' || !tag.startsWith('bundle-')) continue;
      seenTags.push(tag);
      if (entry.draft === true || entry.prerelease === true) continue;
      const parsed = parseBundleTag(tag, bundleId);
      if (parsed === null) continue;
      if (best === null || compareSemver(parsed.version, best.version) > 0) {
        best = {
          tag,
          version: parsed.version,
          releaseId: typeof entry.id === 'number' ? entry.id : null,
          assets: Array.isArray(entry.assets) ? entry.assets : null,
        };
      }
    }
  };

  const settle = (pages) => {
    if (best !== null) return { bundleId, ...best, pages, scanned };
    const unique = [...new Set(seenTags)].slice(0, 5);
    const saw = unique.length === 0 ? '' : ` (saw ${unique.join(', ')})`;
    throw new ReleaseSourceError(
      'RELEASE_VERSION_UNRESOLVED',
      `no published ${bundleId} release in ${repo}${saw}; pass --version <V>`,
      { hint: '--version <V>' },
    );
  };

  for (let page = 1; page <= maxPages; page += 1) {
    const entries = await fetchPage(page);
    collect(entries);
    if (entries.length < perPage) return settle(page);
  }

  // Ten full pages may still be the whole list (exactly 1000 releases), so
  // probe once: any entry beyond the budget makes the max semver unknowable.
  const overflow = await fetchPage(maxPages + 1);
  if (overflow.length > 0) {
    throw new ReleaseSourceError(
      'RELEASE_LIST_TRUNCATED',
      `the release list of ${repo} exceeds ${maxPages} pages (${maxPages * perPage} releases); cannot prove the max semver — pass --version <V>`,
      { hint: '--version <V>' },
    );
  }
  return settle(maxPages + 1);
}

/**
 * Resolve one explicit version.
 *
 * With a token the release record (and its asset ids) comes from
 * `/releases/tags/<tag>`; a draft is invisible (404) and therefore
 * `RELEASE_NOT_FOUND`. Without a token no request is made: assets are
 * downloaded from `<downloadBase>/<tag>/<asset>`.
 */
export async function resolveVersion({
  client,
  repo = DEFAULT_RELEASE_REPO,
  bundleId,
  version,
  downloadBase = releaseDownloadBase(repo),
} = {}) {
  const token = requireClient(client);
  if (!isValidBundleId(bundleId)) {
    throw new ReleaseSourceError(
      'RELEASE_OPTION_CONFLICT',
      `--bundle must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got ${JSON.stringify(bundleId)})`,
      { hint: '--bundle <id>' },
    );
  }
  if (typeof version !== 'string' || !isValidVersion(version) || version.includes('+')) {
    throw new ReleaseSourceError(
      'RELEASE_OPTION_CONFLICT',
      `--version must be a bare semver without build metadata (got ${JSON.stringify(version)})`,
      { hint: '--version <V>' },
    );
  }
  const tag = bundleTag(bundleId, version);
  if (isLegacyEngineTag(tag)) {
    throw new ReleaseSourceError('RELEASE_OPTION_CONFLICT', `${tag} would land in the legacy v<engine> namespace`);
  }
  if (parseBundleTag(tag, bundleId) === null) {
    throw new ReleaseSourceError('RELEASE_TAG_MISMATCH', `${tag} is not a bundle tag for ${bundleId}`);
  }

  if (token === null) {
    return {
      tag,
      bundleId,
      version,
      releaseId: null,
      assets: null,
      anonymous: true,
      downloadBase,
    };
  }

  const response = await client.request('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    accept: 'application/vnd.github+json',
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new ReleaseSourceError(
        'RELEASE_NOT_FOUND',
        `release ${tag} not found in ${repo} (a draft, a private repo or a typo is invisible); pass --version <V>`,
        { status: 404, hint: '--version <V>' },
      );
    }
    throw readFailure(response, { anonymous: false, what: `release ${tag}` });
  }
  const data = response.data;
  if (data === null || typeof data !== 'object') {
    throw new ReleaseSourceError('RELEASE_NOT_FOUND', `release ${tag}: response is not a release object`);
  }
  if (typeof data.tag_name === 'string' && data.tag_name !== tag) {
    throw new ReleaseSourceError(
      'RELEASE_TAG_MISMATCH',
      `release ${tag} resolved to tag ${data.tag_name}`,
    );
  }
  if (data.draft === true) {
    throw new ReleaseSourceError('RELEASE_NOT_FOUND', `release ${tag} is a draft and cannot be installed; publish it or pass another --version <V>`);
  }
  return {
    tag,
    bundleId,
    version,
    releaseId: typeof data.id === 'number' ? data.id : null,
    assets: Array.isArray(data.assets) ? data.assets : [],
    anonymous: false,
    downloadBase,
  };
}

/** Missing-asset code by asset family (#74 §5.3). */
export function assetMissingCode(name) {
  if (typeof name !== 'string') return 'RELEASE_NOT_FOUND';
  // Bundle-channel names are `hm2b-*`; the `r2c-*` spellings stay classified
  // for the frozen legacy `v<E>` channel.
  if (/^(?:hm2b|r2c)-engine-/.test(name)) return 'RELEASE_ENGINE_MISSING';
  if (/^(?:hm2b|r2c)-framework-/.test(name)) return 'RELEASE_FRAMEWORK_MISSING';
  if (/^(?:(?:hm2b|r2c)-payload-|agent-native-)/.test(name)) return 'RELEASE_PAYLOAD_MISSING';
  return 'RELEASE_NOT_FOUND';
}

function missingAsset(name, tag) {
  const code = assetMissingCode(name);
  return new ReleaseSourceError(code, `${name} is missing from release ${tag}`, { hint: name });
}

function assertAssetName(name) {
  if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new ReleaseSourceError('RELEASE_OPTION_CONFLICT', `asset name is not a plain file name: ${JSON.stringify(name)}`);
  }
}

/**
 * Download one asset. Token mode uses the asset id from the release record;
 * anonymous mode builds `<downloadBase>/<tag>/<asset>` and needs no API.
 */
export async function downloadAsset({
  client,
  repo = DEFAULT_RELEASE_REPO,
  release,
  name,
  downloadBase = release?.downloadBase ?? releaseDownloadBase(repo),
} = {}) {
  requireClient(client);
  assertAssetName(name);
  if (release === null || typeof release !== 'object' || typeof release.tag !== 'string') {
    throw new ReleaseSourceError('RELEASE_NOT_FOUND', 'a resolved release is required to download an asset');
  }

  if (Array.isArray(release.assets)) {
    const found = release.assets.find((asset) => asset?.name === name);
    if (found === undefined) throw missingAsset(name, release.tag);
    const target = typeof found.url === 'string' && found.url !== ''
      ? found.url
      : `/repos/${repo}/releases/assets/${found.id}`;
    const response = await client.request('GET', target, { accept: 'application/octet-stream', parse: 'bytes' });
    if (!response.ok) {
      if (response.status === 404) throw missingAsset(name, release.tag);
      throw readFailure(response, { anonymous: false, what: `download ${name} of ${release.tag}` });
    }
    return Buffer.from(response.data);
  }

  const target = `${String(downloadBase).replace(/\/+$/, '')}/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)}`;
  const response = await client.request('GET', target, { accept: 'application/octet-stream', parse: 'bytes' });
  if (!response.ok) {
    if (response.status === 404) throw missingAsset(name, release.tag);
    throw readFailure(response, { anonymous: client.token === null, what: `download ${name} of ${release.tag}` });
  }
  return Buffer.from(response.data);
}

/**
 * Parse `SHA256SUMS.txt` (`<64hex>  <name>`, one per line, name-sorted).
 * Returns the map plus parse failures (never throws for malformed content).
 */
export function parseSums(sums) {
  const text = Buffer.isBuffer(sums) || sums instanceof Uint8Array
    ? Buffer.from(sums).toString('utf8')
    : typeof sums === 'string'
      ? sums
      : null;
  if (text === null) throw new TypeError('SHA256SUMS.txt must be bytes or text');
  const entries = new Map();
  const failures = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const match = SUMS_LINE.exec(line);
    if (match === null) {
      failures.push(`RELEASE_CHECKSUM_MISMATCH: ${JSON.stringify(line)} is not "<sha256>  <name>"`);
      continue;
    }
    const digest = match[1];
    const name = match[2].trim().replace(/^\.\//, '');
    const existing = entries.get(name);
    if (existing !== undefined) {
      if (existing !== digest) failures.push(`RELEASE_CHECKSUM_MISMATCH: duplicate entry for ${name} with a different digest`);
      continue;
    }
    entries.set(name, digest);
  }
  return { entries, failures };
}

/**
 * Verify downloaded assets or a publish plan against `SHA256SUMS.txt`.
 *
 * @param {Buffer|string|{entries: Map, failures: string[]}} sums
 * @param {Array<{name: string, data?: Buffer|Uint8Array|string, sha256?: string}>} entries
 * @param {{requireAll?: boolean}} options `requireAll` demands every sums line.
 * @returns {{ok: boolean, failures: string[]}}
 */
export function verifySums(sums, entries, { requireAll = true } = {}) {
  const parsed = sums !== null && typeof sums === 'object' && sums.entries instanceof Map
    ? sums
    : parseSums(sums);
  const failures = [...parsed.failures];
  const provided = new Map();

  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string') continue;
    if (entry.name === SUMS_ASSET) {
      failures.push(`RELEASE_CHECKSUM_MISMATCH: ${SUMS_ASSET} must not cover itself`);
      continue;
    }
    if (provided.has(entry.name)) {
      failures.push(`RELEASE_CHECKSUM_MISMATCH: ${entry.name} is provided twice`);
      continue;
    }
    let actual;
    if (typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256.toLowerCase())) {
      actual = entry.sha256.toLowerCase();
    } else if (entry.data !== undefined && entry.data !== null) {
      actual = sha256Hex(entry.data);
    } else {
      failures.push(`RELEASE_CHECKSUM_MISMATCH: ${entry.name} has neither bytes nor a sha256`);
      continue;
    }
    provided.set(entry.name, actual);
  }

  for (const [name, actual] of provided) {
    const expected = parsed.entries.get(name);
    if (expected === undefined) {
      failures.push(`RELEASE_CHECKSUM_MISMATCH: ${name} is not listed in ${SUMS_ASSET}`);
      continue;
    }
    if (expected !== actual) {
      failures.push(`RELEASE_CHECKSUM_MISMATCH: ${name} expected ${expected} but is ${actual}`);
    }
  }
  if (requireAll) {
    for (const name of parsed.entries.keys()) {
      if (!provided.has(name)) {
        failures.push(`RELEASE_CHECKSUM_MISMATCH: ${name} is listed in ${SUMS_ASSET} but not provided`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
