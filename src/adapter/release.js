/**
 * Release transport: where `r2c-payload-<V>.tgz` comes from, and the credential
 * chain used to read a private release.
 *
 * This module owns the network and the local mirror, and nothing else:
 * `payload.js` decides what a payload means, verifies its manifest and
 * materialises it. Errors here still carry the payload resolver's codes
 * (`PAYLOAD_UNAVAILABLE`, `PAYLOAD_CHECKSUM_MISMATCH`) and stay usage-level
 * (exit 2), exactly like every other resolution failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { EXIT_CODES, R2cError } from '../errors.js';
import { payloadAssetName } from '../plugin.js';
import { which } from './detect.js';
import { sha256 } from './util.js';

const RELEASE_REPO = 'hesl2636/RTOSv3_R2C_pipiline';
const RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases/download`;
const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}`;

function releaseError(code, message, details = null) {
  return new R2cError(code, message, details, EXIT_CODES.USAGE);
}

export function hintFrom() {
  return 'pass --from <payload-dir|payload.tgz> or set R2C_PLUGIN_SOURCE to an unpacked payload (a checkout containing package.json, pack/ and adapters/ works too)';
}

/**
 * `R2C_RELEASE_BASE` overrides where assets come from (C1): a directory is a
 * flat local release (no fetch at all), an http(s) URL is a mirror shaped
 * `<base>/v<V>/<asset>` exactly like GitHub's `/releases/download/v<V>/`.
 */
function releaseBaseOverride() {
  const raw = process.env.R2C_RELEASE_BASE;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
}

function isHttpBase(base) {
  return /^https?:\/\//i.test(base);
}

/**
 * Anonymous downloads use the public web URL. Token downloads must go through
 * the REST API: GitHub answers the web download URL with `404` when the
 * repository is private and the request carries a bearer token, while the
 * asset endpoint (`Accept: application/octet-stream`) streams it. Both paths
 * name the same `r2c-payload-<V>.tgz` asset. A custom base is always direct.
 */
export function releaseEndpoints({ version, token = null, base = null }) {
  const name = payloadAssetName(version);
  if (typeof base === 'string' && base !== '') {
    const trimmed = base.replace(/\/+$/, '');
    return {
      kind: 'direct',
      name,
      archive: `${trimmed}/v${version}/${name}`,
      sums: `${trimmed}/v${version}/SHA256SUMS.txt`,
    };
  }
  if (token) {
    return {
      kind: 'api',
      name,
      release: `${RELEASE_API}/releases/tags/v${version}`,
      asset: (id) => `${RELEASE_API}/releases/assets/${id}`,
    };
  }
  return {
    kind: 'direct',
    name,
    archive: `${RELEASE_BASE}/v${version}/${name}`,
    sums: `${RELEASE_BASE}/v${version}/SHA256SUMS.txt`,
  };
}

/**
 * `git credential fill` for github.com, never prompting: GIT_TERMINAL_PROMPT=0
 * plus a short timeout means an unattended download cannot hang on a password
 * prompt, it just finds no credential. `git` is resolved through PATH because
 * a Windows git may be a `.cmd` shim, which needs a shell to start.
 */
function gitCredentialToken() {
  const bin = which('git');
  if (bin === null) return null;
  const needsShell = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(bin).toLowerCase());
  const result = spawnSync(
    needsShell ? `"${bin}" credential fill` : bin,
    needsShell ? [] : ['credential', 'fill'],
    {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: needsShell,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const match = /^password=(.*)$/m.exec(result.stdout);
  return match === null || match[1] === '' ? null : match[1];
}

/**
 * Credential chain (C4): `GH_TOKEN` → `GITHUB_TOKEN` → `git credential fill`.
 * `source` names the winning entry so an authorization failure can point at the
 * credential the user has to fix; `null` means "anonymous".
 */
export function releaseCredential() {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') return { token: value, source: name };
  }
  const fromGit = gitCredentialToken();
  return fromGit === null ? { token: null, source: null } : { token: fromGit, source: 'git-credential' };
}

/**
 * Why an HTTP status means the credential is the problem. A private repository
 * answers `404` (not `401`) to an anonymous request, so "no token" plus `404`
 * is the one case that must ask for a token instead of reporting a missing
 * release.
 */
export function releaseAuthHint(status, credential) {
  const anonymous = credential.token === null;
  if (status === 401 || status === 403) {
    return `: ${anonymous ? 'the anonymous request' : credential.source} is not authorized for ${RELEASE_REPO}; run \`gh auth login\` or set GH_TOKEN with release read access`;
  }
  if (status === 404) {
    return anonymous
      ? `: HTTP 404 on a private repository means a token is required — set GH_TOKEN, set GITHUB_TOKEN, or store a github.com credential for \`git credential fill\` (run \`gh auth login\` where it is installed)`
      : `: HTTP 404 — the release tag or asset is absent, or ${credential.source} cannot see ${RELEASE_REPO}; run \`gh auth login\` or set a GH_TOKEN with contents:read`;
  }
  if (status === null && anonymous) {
    return `: no credential found — set GH_TOKEN, set GITHUB_TOKEN, or store a github.com credential for \`git credential fill\` (run \`gh auth login\` where it is installed)`;
  }
  return '';
}

/** The digest `SHA256SUMS.txt` records for `assetName`, or `null`. */
export function sumsDigest(text, assetName) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match !== null && basename(match[2]) === assetName) return match[1];
  }
  return null;
}

/**
 * Read the payload from a local release directory (`R2C_RELEASE_BASE=<dir>`),
 * verifying it against the same `SHA256SUMS.txt` the release publishes. This
 * is the offline path: nothing is fetched and the container digest is checked
 * before the caller extracts anything.
 */
function readReleaseDir(version, base) {
  const dir = resolve(process.cwd(), base);
  const asset = payloadAssetName(version);
  const archivePath = join(dir, asset);
  const sumsPath = join(dir, 'SHA256SUMS.txt');
  const unavailable = (name, file) =>
    releaseError(
      'PAYLOAD_UNAVAILABLE',
      `release v${version} does not carry ${name}: ${file}; ${hintFrom()}`,
      { version, asset: name, base: dir },
    );
  if (!existsSync(archivePath)) throw unavailable(asset, archivePath);
  if (!existsSync(sumsPath)) throw unavailable('SHA256SUMS.txt', sumsPath);
  const archive = readFileSync(archivePath);
  const expected = sumsDigest(readFileSync(sumsPath, 'utf8'), asset);
  if (expected === null) {
    throw releaseError('PAYLOAD_CHECKSUM_MISMATCH', `${sumsPath} has no entry for ${asset}`, {
      asset,
      sums: sumsPath,
    });
  }
  const actual = sha256(archive);
  if (actual !== expected) {
    throw releaseError(
      'PAYLOAD_CHECKSUM_MISMATCH',
      `SHA256SUMS.txt mismatch for ${asset}`,
      { asset, expected, actual, sums: sumsPath },
    );
  }
  return archive;
}

/** Download the payload of `version`, verified against the release's sums. */
async function readRemoteRelease(version, base) {
  // The GitHub credential (env or `git credential fill`) is only for GitHub: a
  // custom mirror authenticates its own way and must not receive it.
  const credential = base === null ? releaseCredential() : { token: null, source: null };
  const token = credential.token;
  const authHint = (status) => (base === null ? releaseAuthHint(status, credential) : '');
  const headers = { 'user-agent': 'r2c-runner' };
  if (token) headers.authorization = `Bearer ${token}`;
  const endpoints = releaseEndpoints({ version, token, base });
  const asset = endpoints.name;

  const request = async (url, timeout, extra = null) => {
    try {
      return await fetch(url, {
        headers: extra === null ? headers : { ...headers, ...extra },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw releaseError(
        'PAYLOAD_UNAVAILABLE',
        `cannot reach the payload release v${version}: ${error.message}${authHint(null)}; ${hintFrom()}`,
        { version, url, token_source: credential.source },
      );
    }
  };

  let archiveUrl;
  let response;
  let sumsResponse;
  if (endpoints.kind === 'api') {
    const releaseResponse = await request(endpoints.release, 30_000, {
      accept: 'application/vnd.github+json',
    });
    if (!releaseResponse.ok) {
      throw releaseError(
        'PAYLOAD_UNAVAILABLE',
        `cannot read release v${version}: HTTP ${releaseResponse.status}${authHint(releaseResponse.status)}; ${hintFrom()}`,
        {
          version,
          url: endpoints.release,
          status: releaseResponse.status,
          token_source: credential.source,
        },
      );
    }
    const release = await releaseResponse.json().catch(() => null);
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const archiveAsset = assets.find((entry) => entry?.name === asset);
    const sumsAsset = assets.find((entry) => entry?.name === 'SHA256SUMS.txt');
    if (archiveAsset === undefined || sumsAsset === undefined) {
      const missing = archiveAsset === undefined ? asset : 'SHA256SUMS.txt';
      throw releaseError(
        'PAYLOAD_UNAVAILABLE',
        `release v${version} does not carry ${missing}; ${hintFrom()}`,
        { version, url: endpoints.release },
      );
    }
    archiveUrl = endpoints.asset(archiveAsset.id);
    response = await request(archiveUrl, 60_000, { accept: 'application/octet-stream' });
    sumsResponse = await request(endpoints.asset(sumsAsset.id), 30_000, {
      accept: 'application/octet-stream',
    });
  } else {
    archiveUrl = endpoints.archive;
    response = await request(archiveUrl, 60_000);
    sumsResponse = await request(endpoints.sums, 30_000);
  }

  if (!response.ok) {
    throw releaseError(
      'PAYLOAD_UNAVAILABLE',
      `cannot download ${asset}: HTTP ${response.status}${authHint(response.status)}; ${hintFrom()}`,
      { version, url: archiveUrl, status: response.status, token_source: credential.source },
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (!sumsResponse.ok) {
    throw releaseError(
      'PAYLOAD_UNAVAILABLE',
      `cannot download SHA256SUMS.txt: HTTP ${sumsResponse.status}; ${hintFrom()}`,
      { version, status: sumsResponse.status },
    );
  }
  const expected = sumsDigest(await sumsResponse.text(), asset);
  if (expected === null) {
    throw releaseError('PAYLOAD_CHECKSUM_MISMATCH', `SHA256SUMS.txt has no entry for ${asset}`, {
      asset,
    });
  }
  const actual = sha256(archive);
  if (actual !== expected) {
    throw releaseError(
      'PAYLOAD_CHECKSUM_MISMATCH',
      `SHA256SUMS.txt mismatch for ${asset}`,
      { asset, expected, actual },
    );
  }
  return archive;
}

/**
 * Fetch `r2c-payload-<V>.tgz` from wherever the release is: a flat local
 * directory, a mirror, or GitHub. Returns the container bytes after the
 * release's `SHA256SUMS.txt` digest matched; extraction and manifest
 * verification belong to the caller.
 */
export async function fetchPayloadArchive(version) {
  const declared = releaseBaseOverride();
  // Spelling out the default base must not degrade the API path a token needs.
  const base = declared === RELEASE_BASE ? null : declared;
  if (base !== null && !isHttpBase(base)) return readReleaseDir(version, base);
  return readRemoteRelease(version, base);
}
