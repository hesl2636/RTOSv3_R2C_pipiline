/**
 * Latest/version resolution for per-bundle Releases (#107).
 *
 * Contract under test (decision #74 §4.1/§4.2, spec §13):
 * - latest never reads `/releases/latest`; it paginates `GET /releases`,
 *   drops drafts/prereleases and picks the max semver among exact
 *   `bundle-<id>-v<semver>` tags; more than 10 pages is `RELEASE_LIST_TRUNCATED`.
 * - explicit `--version` uses `/releases/tags/<tag>` with a token and the
 *   direct `<base>/<tag>/<asset>` path without one.
 * - 403 points at `--version` or `GH_TOKEN`; missing assets map to the
 *   projection-specific codes; sums cover exactly the published assets.
 *
 * The GitHub API is a loopback fixture; nothing reaches the real network.
 */
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { sha256Hex } from '../core/node/sha256.js';
import { createGithubClient } from '../installer/release-client.js';
import {
  ReleaseSourceError,
  downloadAsset,
  parseSums,
  resolveLatest,
  resolveVersion,
  verifySums,
} from '../installer/release-source.js';
import {
  bundleAssetNames,
  bundleTag,
  isLegacyEngineTag,
  legacyAssetNames,
  parseBundleTag,
} from '../installer/release-tags.js';
import { buildBundleRelease } from '../scripts/lib/bundle-release.mjs';
import { jsonResponse, startGithubFixture, startHttpFixture } from './helpers/release-fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'owner/repo';
const ID = 'rtosv3-drvport';
const TOKEN = 'ghp_release_source_token_5f4d';

function entry(tag, extra = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [],
    ...extra,
  };
}

function clientFor(origin, { token = null } = {}) {
  return createGithubClient({ base: origin, token, allowInsecure: true, fetch: globalThis.fetch });
}

async function rejectsWith(promise, code, pattern = null) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ReleaseSourceError, `expected ReleaseSourceError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (pattern !== null) assert.match(error.message, pattern);
    return true;
  });
}

test('latest paginates /releases, filters drafts and prereleases, and picks the max semver', async (t) => {
  const page1 = [
    entry(bundleTag(ID, '1.9.0')),
    entry(bundleTag(ID, '9.0.0'), { draft: true }),
    entry(bundleTag(ID, '8.0.0'), { prerelease: true }),
    entry(bundleTag('other-bundle', '9.9.9')),
    entry('v0.1.0'),
    ...Array.from({ length: 95 }, (_, index) => entry(bundleTag('noise-bundle', `0.0.${index + 1}`))),
  ];
  assert.equal(page1.length, 100);
  const page2 = [entry(bundleTag(ID, '1.10.0')), entry(bundleTag(ID, '2.0.0-rc.1'), { prerelease: true })];
  const fixture = await startHttpFixture(t, (ctx) => {
    if (ctx.path !== `/repos/${REPO}/releases`) return undefined;
    const page = Number(ctx.query.get('page'));
    return jsonResponse(200, page === 1 ? page1 : page === 2 ? page2 : []);
  });

  const resolved = await resolveLatest({ client: clientFor(fixture.origin), repo: REPO, bundleId: ID });

  assert.equal(resolved.tag, bundleTag(ID, '1.10.0'));
  assert.equal(resolved.version, '1.10.0');
  assert.equal(resolved.bundleId, ID);
  assert.equal(resolved.pages, 2);
  assert.equal(fixture.requests.length, 2);
  assert.match(fixture.requests[0].url, /per_page=100/);
  assert.match(fixture.requests[0].url, /page=1/);
  assert.match(fixture.requests[1].url, /page=2/);
  for (const request of fixture.requests) assert.doesNotMatch(request.url, /\/releases\/latest/);
});

test('latest stops at the first short page and reports unresolved tags with a --version hint', async (t) => {
  const fixture = await startHttpFixture(t, (ctx) =>
    jsonResponse(200, [entry(bundleTag(ID, '1.0.0'), { draft: true }), entry(bundleTag('another-bundle', '1.0.0'))]));

  await assert.rejects(
    resolveLatest({ client: clientFor(fixture.origin), repo: REPO, bundleId: ID }),
    (error) => {
      assert.equal(error.code, 'RELEASE_VERSION_UNRESOLVED');
      assert.match(error.message, /--version/);
      assert.match(error.message, /another-bundle/);
      return true;
    },
  );
  assert.equal(fixture.requests.length, 1);
});

test('latest refuses more than ten pages with RELEASE_LIST_TRUNCATED', async (t) => {
  const page = Array.from({ length: 100 }, (_, index) => entry(bundleTag('noise', `0.0.${index + 1}`)));
  const fixture = await startHttpFixture(t, () => jsonResponse(200, page));

  await rejectsWith(
    resolveLatest({ client: clientFor(fixture.origin), repo: REPO, bundleId: ID }),
    'RELEASE_LIST_TRUNCATED',
    /--version/,
  );
  assert.equal(fixture.requests.length, 11, 'ten pages plus one overflow probe');
  for (let pageNumber = 1; pageNumber <= 11; pageNumber += 1) {
    assert.match(fixture.requests[pageNumber - 1].url, new RegExp(`page=${pageNumber}(&|$)`));
  }
});

test('exactly ten full pages still resolve when the probe page is empty', async (t) => {
  const full = [
    entry(bundleTag(ID, '1.0.0')),
    ...Array.from({ length: 99 }, (_, index) => entry(bundleTag('noise', `0.0.${index + 1}`))),
  ];
  const fixture = await startHttpFixture(t, (ctx) =>
    jsonResponse(200, Number(ctx.query.get('page')) <= 10 ? full : []));

  const resolved = await resolveLatest({ client: clientFor(fixture.origin), repo: REPO, bundleId: ID });
  assert.equal(resolved.tag, bundleTag(ID, '1.0.0'));
  assert.equal(resolved.pages, 11);
  assert.equal(fixture.requests.length, 11);
});

test('anonymous 403 maps to RELEASE_RATE_LIMITED with --version and GH_TOKEN hints', async (t) => {
  const fixture = await startHttpFixture(t, () => jsonResponse(403, { message: 'API rate limit exceeded' }));

  await assert.rejects(
    resolveLatest({ client: clientFor(fixture.origin), repo: REPO, bundleId: ID }),
    (error) => {
      assert.equal(error.code, 'RELEASE_RATE_LIMITED');
      assert.match(error.message, /--version/);
      assert.match(error.message, /GH_TOKEN/);
      return true;
    },
  );
});

test('a token that cannot read the repository maps 403 to RELEASE_FORBIDDEN', async (t) => {
  const fixture = await startHttpFixture(t, () => jsonResponse(403, { message: 'Resource not accessible by personal access token' }));

  await rejectsWith(
    resolveLatest({ client: clientFor(fixture.origin, { token: TOKEN }), repo: REPO, bundleId: ID }),
    'RELEASE_FORBIDDEN',
    /contents:read/,
  );
  assert.equal(fixture.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('explicit version with a token uses /releases/tags/<tag> and the asset id', async (t) => {
  const data = Buffer.from('engine-bytes', 'utf8');
  const fixture = await startGithubFixture(t, {
    repo: REPO,
    releases: [{ tag: bundleTag(ID, '1.2.3'), assets: [{ name: 'hm2b-engine-0.1.0.tgz', data }] }],
  });
  const client = clientFor(fixture.origin, { token: TOKEN });

  const release = await resolveVersion({ client, repo: REPO, bundleId: ID, version: '1.2.3' });
  assert.equal(release.tag, bundleTag(ID, '1.2.3'));
  assert.equal(release.anonymous, false);
  assert.equal(release.assets.length, 1);

  const bytes = await downloadAsset({ client, repo: REPO, release, name: 'hm2b-engine-0.1.0.tgz' });
  assert.deepEqual(bytes, data);
  assert.deepEqual(
    fixture.callsOf('GET').map((call) => call.path),
    [
      `/repos/${REPO}/releases/tags/${bundleTag(ID, '1.2.3')}`,
      `/repos/${REPO}/releases/assets/1`,
    ],
  );
  for (const call of fixture.calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.doesNotMatch(call.url, new RegExp(TOKEN));
  }
});

test('explicit version without a token never touches the API and downloads <base>/<tag>/<asset>', async (t) => {
  const data = Buffer.from('payload-bytes', 'utf8');
  const fixture = await startGithubFixture(t, {
    repo: REPO,
    releases: [{ tag: bundleTag(ID, '1.2.3'), assets: [{ name: 'hm2b-payload-rtosv3-drvport-v1.2.3.tgz', data }] }],
  });
  const client = clientFor(fixture.origin);

  const release = await resolveVersion({ client, repo: REPO, bundleId: ID, version: '1.2.3' });
  assert.equal(release.anonymous, true);
  assert.equal(release.assets, null);
  assert.equal(fixture.calls.length, 0);

  const bytes = await downloadAsset({
    client,
    repo: REPO,
    release,
    name: 'hm2b-payload-rtosv3-drvport-v1.2.3.tgz',
    downloadBase: fixture.downloadBase,
  });
  assert.deepEqual(bytes, data);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].path, `/download/${bundleTag(ID, '1.2.3')}/hm2b-payload-rtosv3-drvport-v1.2.3.tgz`);
  assert.equal(fixture.calls[0].headers.authorization, undefined);
});

test('explicit version with a token maps an invisible draft or tag to RELEASE_NOT_FOUND', async (t) => {
  const fixture = await startGithubFixture(t, {
    repo: REPO,
    releases: [{ tag: bundleTag(ID, '1.2.3'), draft: true, assets: [] }],
  });
  const client = clientFor(fixture.origin, { token: TOKEN });

  await rejectsWith(
    resolveVersion({ client, repo: REPO, bundleId: ID, version: '1.2.3' }),
    'RELEASE_NOT_FOUND',
    /--version/,
  );
  await rejectsWith(
    resolveVersion({ client, repo: REPO, bundleId: ID, version: '1.2.4' }),
    'RELEASE_NOT_FOUND',
  );
});

test('missing assets carry the projection-specific code, including for anonymous downloads', async (t) => {
  const fixture = await startGithubFixture(t, {
    repo: REPO,
    releases: [{ tag: bundleTag(ID, '1.0.0'), assets: [{ name: 'install.mjs', data: Buffer.from('x') }] }],
  });
  const client = clientFor(fixture.origin, { token: TOKEN });
  const release = await resolveVersion({ client, repo: REPO, bundleId: ID, version: '1.0.0' });

  await rejectsWith(downloadAsset({ client, repo: REPO, release, name: 'hm2b-engine-0.1.0.tgz' }), 'RELEASE_ENGINE_MISSING');
  await rejectsWith(
    downloadAsset({ client, repo: REPO, release, name: 'hm2b-payload-rtosv3-drvport-v1.0.0.tgz' }),
    'RELEASE_PAYLOAD_MISSING',
  );
  await rejectsWith(downloadAsset({ client, repo: REPO, release, name: 'hm2b-framework-0.1.0.tgz' }), 'RELEASE_FRAMEWORK_MISSING');
  await rejectsWith(downloadAsset({ client, repo: REPO, release, name: 'workflow.compiled.json' }), 'RELEASE_NOT_FOUND');

  const anonymous = await resolveVersion({ client: clientFor(fixture.origin), repo: REPO, bundleId: ID, version: '1.0.0' });
  await rejectsWith(
    downloadAsset({
      client: clientFor(fixture.origin),
      repo: REPO,
      release: anonymous,
      name: 'bundle-rtosv3-drvport-v1.0.0.zip',
      downloadBase: fixture.downloadBase,
    }),
    'RELEASE_NOT_FOUND',
  );
});

test('anonymous asset 403 points at --version or GH_TOKEN', async (t) => {
  const fixture = await startHttpFixture(t, () => jsonResponse(403, { message: 'rate limited' }));
  const client = clientFor(fixture.origin);
  const release = await resolveVersion({ client, repo: REPO, bundleId: ID, version: '1.0.0' });

  await assert.rejects(
    downloadAsset({ client, repo: REPO, release, name: 'install.mjs', downloadBase: fixture.origin }),
    (error) => {
      assert.equal(error.code, 'RELEASE_RATE_LIMITED');
      assert.match(error.message, /--version/);
      assert.match(error.message, /GH_TOKEN/);
      return true;
    },
  );
});

test('verifySums checks every listed asset and refuses missing, extra or tampered bytes', () => {
  const engine = Buffer.from('engine', 'utf8');
  const compiledWorkflow = Buffer.from('compiled workflow', 'utf8');
  const sums = `${sha256Hex(engine)}  hm2b-engine-0.1.0.tgz\n${sha256Hex(compiledWorkflow)}  workflow.compiled.json\n`;
  const parsed = parseSums(sums);
  assert.equal(parsed.failures.length, 0);
  assert.equal(parsed.entries.size, 2);

  const good = verifySums(sums, [
    { name: 'hm2b-engine-0.1.0.tgz', data: engine },
    { name: 'workflow.compiled.json', data: compiledWorkflow },
  ]);
  assert.deepEqual(good, { ok: true, failures: [] });

  const tampered = verifySums(sums, [
    { name: 'hm2b-engine-0.1.0.tgz', data: engine },
    { name: 'workflow.compiled.json', data: Buffer.from('compiled workflow tampered', 'utf8') },
  ]);
  assert.equal(tampered.ok, false);
  assert.match(tampered.failures[0], /^RELEASE_CHECKSUM_MISMATCH: workflow\.compiled\.json/);

  const missing = verifySums(sums, [{ name: 'hm2b-engine-0.1.0.tgz', data: engine }]);
  assert.equal(missing.ok, false);
  assert.match(missing.failures[0], /workflow\.compiled\.json is listed .* but not provided/);

  const extra = verifySums(sums, [
    { name: 'hm2b-engine-0.1.0.tgz', data: engine },
    { name: 'workflow.compiled.json', data: compiledWorkflow },
    { name: 'stowaway.txt', data: Buffer.from('x') },
  ]);
  assert.equal(extra.ok, false);
  assert.match(extra.failures[0], /stowaway\.txt is not listed/);

  const malformed = verifySums('not a sums file\n', [], { requireAll: false });
  assert.equal(malformed.ok, false);
  assert.match(malformed.failures[0], /^RELEASE_CHECKSUM_MISMATCH:/);

  const selfCovering = verifySums(`${sha256Hex(Buffer.from('x'))}  SHA256SUMS.txt\n`, [
    { name: 'SHA256SUMS.txt', data: Buffer.from('x') },
  ]);
  assert.equal(selfCovering.ok, false);
});

test('the two tag channels never overlap or reuse each other', () => {
  const bundleNames = bundleAssetNames({
    id: ID,
    version: '1.0.0',
    allowed: ['runner', 'agent-native'],
    engineVersion: '0.1.0',
    frameworkVersion: '0.1.0',
  });
  const legacyNames = legacyAssetNames('0.1.0');
  // The bootstrap and its sums file are the only shared asset names: the
  // bundle channel prefixes the engine and the payload with `hm2b-`, the
  // frozen legacy channel with `r2c-` (decision #74 §2.3).
  assert.deepEqual(bundleNames.filter((name) => legacyNames.includes(name)), [
    'SHA256SUMS.txt',
    'install.mjs',
  ]);
  assert.ok(!legacyNames.includes('hm2b-payload-rtosv3-drvport-v1.0.0.tgz'));
  assert.ok(bundleNames.includes('hm2b-payload-rtosv3-drvport-v1.0.0.tgz'));
  assert.ok(legacyNames.includes('r2c-payload-0.1.0.tgz'));
  assert.ok(!bundleNames.includes('r2c-payload-0.1.0.tgz'));
  // Same engine bytes, different channel names.
  assert.ok(bundleNames.includes('hm2b-engine-0.1.0.tgz'));
  assert.ok(legacyNames.includes('r2c-engine-0.1.0.tgz'));
  assert.ok(!bundleNames.includes('r2c-engine-0.1.0.tgz'));

  assert.deepEqual(parseBundleTag(bundleTag(ID, '1.0.0'), ID), { id: ID, version: '1.0.0' });
  assert.equal(parseBundleTag('v0.1.0', ID), null);
  assert.equal(parseBundleTag(bundleTag(ID, '1.0.0+build'), ID), null);
  assert.equal(parseBundleTag(bundleTag('rtosv3', '1.0.0'), ID), null);
  assert.equal(isLegacyEngineTag('v0.1.0'), true);
  assert.equal(isLegacyEngineTag('v1.0.0+build'), false);
  assert.equal(isLegacyEngineTag(bundleTag(ID, '1.0.0')), false);
  assert.equal(isLegacyEngineTag(bundleTag('v0.1.0', '1.0.0')), false);
});

test('the token never leaks into resolved urls or error messages', async (t) => {
  const fixture = await startHttpFixture(t, () => jsonResponse(404, { message: 'Not Found' }));
  const client = clientFor(fixture.origin, { token: TOKEN });
  let error;
  try {
    await resolveVersion({ client, repo: REPO, bundleId: ID, version: '1.0.0' });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, 'RELEASE_NOT_FOUND');
  assert.doesNotMatch(error.message, new RegExp(TOKEN));
  for (const request of fixture.requests) assert.doesNotMatch(request.url, new RegExp(TOKEN));
});

test('the release assets of the sample bundle contain no token from the launch environment', () => {
  const token = 'ghp_artifact_scan_token_9c2e';
  const previousGh = process.env.GH_TOKEN;
  const previousGithub = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = token;
  delete process.env.GITHUB_TOKEN;
  try {
    const built = buildBundleRelease({
      root: ROOT,
      bundlePath: join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip'),
    });
    assert.equal(built.ok, true);
    for (const asset of built.assets) {
      assert.equal(asset.data.includes(Buffer.from(token, 'utf8')), false, `${asset.name} contains the token`);
    }
  } finally {
    if (previousGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGh;
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithub;
  }
});
