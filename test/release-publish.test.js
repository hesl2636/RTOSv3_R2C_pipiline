/**
 * Publish state machine and credential hygiene for per-bundle Releases (#107).
 *
 * Contract under test (decision #74 §6/§7, spec §13):
 * - PRECHECK → DRAFT (`make_latest=false`) → upload → verify names/sizes/
 *   digests against SHA256SUMS.txt → `PATCH draft=false` → read-back.
 * - a failure before publish deletes the draft and any tag created in this run;
 *   a failure after publish leaves the published assets untouched and reports
 *   the recovery (mark prerelease or publish a new patch).
 * - same-name uploads are never replaced (422), published releases are never
 *   touched, and the two tag channels stay disjoint.
 * - the token stays in headers only: not in URLs, argv, results or assets.
 *
 * The API is a loopback fixture recording every call; no real network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readZip } from '../assembler/zip.js';
import { inflateRaw } from '../core/node/inflate.js';
import { canonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';
import { createGithubClient } from '../installer/release-client.js';
import {
  GH_TOKEN_ENV,
  publishAvailability,
  readGithubToken,
  redactSecret,
} from '../installer/release-auth.js';
import { buildBundleRelease } from '../scripts/lib/bundle-release.mjs';
import { readBuiltRelease } from '../scripts/lib/built-release.mjs';
import { publishBundle } from '../installer/release-publish.js';
import { bundleTag } from '../installer/release-tags.js';
import { publishBundle as installedPublishBundle } from '../installer/index.js';
import { jsonResponse, startGithubFixture } from './helpers/release-fixture.js';
import { buildZip } from './helpers/zip.js';

const REPO = 'owner/repo';
const ID = 'rtosv3-drvport';
const VERSION = '1.0.0';
const TAG = bundleTag(ID, VERSION);
const TOKEN = 'ghp_publish_token_a71c';
const COMMIT = 'b'.repeat(40);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');

function buildLocal() {
  const assets = [
    { name: `bundle-${ID}-v${VERSION}.zip`, data: Buffer.from('zip-bytes', 'utf8') },
    { name: 'workflow.compiled.json', data: Buffer.from('{"schema":"hm2b.compiled-workflow/v2"}\n', 'utf8') },
    { name: 'hm2b-engine-0.1.0.tgz', data: Buffer.from('engine-bytes', 'utf8') },
    { name: 'install.mjs', data: Buffer.from('// install\n', 'utf8') },
  ];
  const sums = assets
    .map((asset) => `${sha256Hex(asset.data)}  ${asset.name}\n`)
    .join('');
  assets.push({ name: 'SHA256SUMS.txt', data: Buffer.from(sums, 'utf8') });
  assets.sort((left, right) => (left.name < right.name ? -1 : 1));
  const plan = {
    tag: TAG,
    bundleId: ID,
    version: VERSION,
    name: `${ID} v${VERSION}`,
    makeLatest: false,
    prerelease: false,
    draft: true,
    assets: assets.map((asset) => ({
      name: asset.name,
      size: asset.data.length,
      sha256: sha256Hex(asset.data),
    })),
  };
  return { plan, assets };
}

function clientFor(fixture, { token = TOKEN } = {}) {
  return createGithubClient({ base: fixture.origin, token, allowInsecure: true });
}

function calls(fixture, method, path = null) {
  return fixture.calls.filter((call) => call.method === method && (path === null || call.path === path));
}

function uploadCalls(fixture) {
  return fixture.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/uploads/'));
}

test('publish walks PRECHECK → DRAFT → UPLOAD → VERIFY → PUBLISH and mutates only the draft', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO });
  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, true, result.failures.join('; '));
  assert.equal(result.state, 'PUBLISHED');
  assert.equal(result.published, true);
  assert.deepEqual(result.transitions, [
    'PRECHECK',
    'DRAFT_CREATED',
    'UPLOADING',
    'VERIFYING',
    'PUBLISHING',
    'PUBLISHED',
  ]);

  const created = calls(fixture, 'POST', `/repos/${REPO}/releases`);
  assert.equal(created.length, 1);
  const draftBody = JSON.parse(created[0].body.toString('utf8'));
  assert.equal(draftBody.tag_name, TAG);
  assert.equal(draftBody.draft, true);
  assert.equal(draftBody.prerelease, false);
  assert.equal(draftBody.make_latest, 'false');
  assert.equal(draftBody.target_commitish, COMMIT);

  assert.equal(uploadCalls(fixture).length, plan.assets.length);
  for (const call of uploadCalls(fixture)) {
    assert.equal(call.headers['content-type'], 'application/octet-stream');
    assert.equal(call.path, '/uploads/1');
  }

  const patches = calls(fixture, 'PATCH', `/repos/${REPO}/releases/1`);
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0].body.toString('utf8')), {
    draft: false,
    make_latest: 'false',
  });
  assert.equal(calls(fixture, 'DELETE').length, 0);
  assert.equal(fixture.release(TAG).draft, false);
  const localSums = assets.find((asset) => asset.name === 'SHA256SUMS.txt').data.toString('utf8');
  assert.equal(fixture.assetData(TAG, 'SHA256SUMS.txt').toString('utf8'), localSums);
  assert.deepEqual(result.cleanup, { draftDeleted: false, tagDeleted: false });
});

test('an upload failure deletes the draft and the tag created in this run', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO, createTagOnDraft: true });
  let uploaded = 0;
  fixture.intercept = (ctx) => {
    if (ctx.method === 'POST' && ctx.path.startsWith('/uploads/')) {
      uploaded += 1;
      if (uploaded === 2) return jsonResponse(500, { message: 'boom' });
    }
    return undefined;
  };

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, false);
  assert.equal(result.published, false);
  assert.equal(result.state, 'FAILED');
  assert.match(result.failures[0], /^RELEASE_PUBLISH_FAILED: .*bundle-rtosv3-drvport-v1\.0\.0\.zip/);
  assert.deepEqual(result.cleanup, { draftDeleted: true, tagDeleted: true });
  assert.equal(result.recovery, 'retry');
  assert.equal(calls(fixture, 'PATCH').length, 0);
  assert.equal(fixture.release(TAG), null);
  assert.equal(fixture.refs.has(TAG), false);
});

test('a pre-existing tag is never deleted by rollback', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO });
  fixture.addRef(TAG, COMMIT);
  fixture.intercept = (ctx) =>
    ctx.method === 'POST' && ctx.path.startsWith('/uploads/')
      ? jsonResponse(500, { message: 'boom' })
      : undefined;

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.cleanup, { draftDeleted: true, tagDeleted: false });
  assert.equal(calls(fixture, 'DELETE').filter((call) => call.path.includes('/git/refs/tags/')).length, 0);
  assert.equal(fixture.refs.get(TAG), COMMIT);
});

test('a tag that already points at another commit is a tag conflict, with no mutation', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO });
  fixture.addRef(TAG, 'c'.repeat(40));

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^RELEASE_TAG_CONFLICT:/);
  assert.equal(calls(fixture, 'POST').length, 0);
  assert.equal(calls(fixture, 'PATCH').length, 0);
  assert.equal(calls(fixture, 'DELETE').length, 0);
});

test('a remote verify mismatch deletes the draft and never publishes', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO });
  const tamperedDigest = `sha256:${'d'.repeat(64)}`;
  let uploadsDone = 0;
  fixture.intercept = (ctx) => {
    if (ctx.method === 'POST' && ctx.path.startsWith('/uploads/')) uploadsDone += 1;
    if (ctx.method === 'GET' && ctx.path === `/repos/${REPO}/releases/1/assets` && uploadsDone >= plan.assets.length) {
      const remote = fixture.assets(1).map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.data.length,
        digest: asset.name === 'workflow.compiled.json' ? tamperedDigest : `sha256:${sha256Hex(asset.data)}`,
        url: `${fixture.origin}/repos/${REPO}/releases/assets/${asset.id}`,
      }));
      return jsonResponse(200, remote);
    }
    return undefined;
  };

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^RELEASE_DRAFT_VERIFY_FAILED: workflow\.compiled\.json/);
  assert.equal(result.published, false);
  assert.equal(calls(fixture, 'PATCH').length, 0);
  assert.deepEqual(result.cleanup, { draftDeleted: true, tagDeleted: false });
  assert.equal(fixture.release(TAG), null);
});

test('a failure after publish leaves the published assets alone and reports the recovery', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO });
  let patched = false;
  fixture.intercept = (ctx) => {
    if (ctx.method === 'PATCH' && ctx.path === `/repos/${REPO}/releases/1`) patched = true;
    if (patched && ctx.method === 'GET' && ctx.path === `/repos/${REPO}/releases/1`) {
      return jsonResponse(200, { id: 1, tag_name: TAG, draft: true, prerelease: false, assets: [] });
    }
    return undefined;
  };

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.published, true);
  assert.equal(result.state, 'PUBLISHED_UNVERIFIED');
  assert.match(result.failures[0], /^RELEASE_PUBLISH_FAILED: .*read-back/);
  assert.match(result.notes.join(' '), /prerelease/);
  assert.match(result.notes.join(' '), /patch/);
  assert.equal(result.recovery, 'mark-prerelease-or-new-patch');
  assert.equal(calls(fixture, 'DELETE').length, 0);
  for (const name of plan.assets.map((asset) => asset.name)) {
    assert.notEqual(fixture.assetData(TAG, name), null, `${name} must survive`);
  }
});

test('a same-name upload with different bytes is refused, never replaced', async (t) => {
  const { plan, assets } = buildLocal();
  const existing = Buffer.from('older-sums', 'utf8');
  const fixture = await startGithubFixture(t, {
    repo: REPO,
    releases: [{ tag: TAG, draft: true, assets: [{ name: 'workflow.compiled.json', data: existing }] }],
  });

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^RELEASE_ASSET_IMMUTABLE: workflow\.compiled\.json/);
  assert.equal(result.published, false);
  assert.equal(calls(fixture, 'PATCH').length, 0);
  assert.equal(uploadCalls(fixture).length, plan.assets.length, 'each asset is attempted exactly once');
  assert.equal(fixture.assetData(TAG, 'workflow.compiled.json'), null);
  assert.equal(fixture.release(TAG), null);
});

test('a same-name upload with identical bytes resumes instead of failing', async (t) => {
  const { plan, assets } = buildLocal();
  const compiledWorkflow = assets.find((asset) => asset.name === 'workflow.compiled.json');
  const fixture = await startGithubFixture(t, {
    repo: REPO,
    releases: [{ tag: TAG, draft: true, assets: [{ name: 'workflow.compiled.json', data: compiledWorkflow.data }] }],
  });

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, true, result.failures.join('; '));
  assert.equal(result.state, 'PUBLISHED');
  assert.match(result.notes.join(' '), /already uploaded/);
  assert.equal(calls(fixture, 'PATCH').length, 1);
  assert.equal(fixture.release(TAG).draft, false);
});

test('an already published version is never moved, deleted or rebuilt', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, {
    repo: REPO,
    releases: [{ tag: TAG, assets: [{ name: 'install.mjs', data: Buffer.from('v1') }] }],
  });

  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.published, true);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'ALREADY_PUBLISHED');
  assert.match(result.failures[0], /^RELEASE_TAG_CONFLICT:/);
  assert.equal(result.recovery, 'new-patch');
  assert.deepEqual(result.cleanup, { draftDeleted: false, tagDeleted: false });
  assert.deepEqual(fixture.calls.filter((call) => call.method !== 'GET'), []);
});

test('the legacy v<engine> namespace is refused before any request', async (t) => {
  const { plan, assets } = buildLocal();
  for (const tag of ['v0.1.0', bundleTag(ID, '1.0.0+build')]) {
    const fixture = await startGithubFixture(t, { repo: REPO });
    const result = await publishBundle({
      client: clientFor(fixture),
      repo: REPO,
      plan: { ...plan, tag },
      assets,
      targetCommitish: COMMIT,
    });
    assert.equal(result.ok, false);
    assert.match(result.failures[0], /^RELEASE_(OPTION_CONFLICT|TAG_MISMATCH): /);
    assert.equal(fixture.calls.length, 0);
  }
});

test('without a token publishing is disabled and no request is made', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO });
  const result = await publishBundle({
    client: clientFor(fixture, { token: null }),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });

  assert.equal(result.ok, false);
  assert.equal(result.published, false);
  assert.match(result.failures[0], /^RELEASE_AUTH_REQUIRED: .*GH_TOKEN/);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(publishAvailability({}), {
    enabled: false,
    reason: 'set GH_TOKEN with Contents: Write',
    source: null,
  });
  assert.deepEqual(publishAvailability({ GITHUB_TOKEN: TOKEN }), {
    enabled: true,
    reason: null,
    source: 'GITHUB_TOKEN',
  });
});

test('the token is only ever sent in headers and never appears in results, urls or artifacts', async (t) => {
  const { plan, assets } = buildLocal();
  const fixture = await startGithubFixture(t, { repo: REPO });
  const result = await publishBundle({
    client: clientFor(fixture),
    repo: REPO,
    plan,
    assets,
    targetCommitish: COMMIT,
  });
  assert.equal(result.ok, true, result.failures.join('; '));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  for (const call of fixture.calls) {
    assert.doesNotMatch(call.url, new RegExp(TOKEN));
    assert.doesNotMatch(call.body.toString('utf8'), new RegExp(TOKEN));
    if (call.path.startsWith('/repos/') || call.path.startsWith('/uploads/')) {
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    }
  }
  for (const asset of assets) assert.doesNotMatch(asset.data.toString('utf8'), new RegExp(TOKEN));

  assert.deepEqual(readGithubToken({ GH_TOKEN: TOKEN, GITHUB_TOKEN: 'other' }), { token: TOKEN, source: 'GH_TOKEN' });
  assert.deepEqual(readGithubToken({}), { token: null, source: null });
  assert.deepEqual(GH_TOKEN_ENV, ['GH_TOKEN', 'GITHUB_TOKEN']);
  assert.equal(redactSecret(`a ${TOKEN} b ${encodeURIComponent(TOKEN)}`, TOKEN), 'a [redacted] b [redacted]');
});

test('a token is refused for a plain-http API base unless explicitly allowed', () => {
  assert.throws(
    () => createGithubClient({ base: 'http://example.test', token: TOKEN }),
    (error) => error.code === 'RELEASE_AUTH_REQUIRED' && !error.message.includes(TOKEN),
  );
  assert.doesNotThrow(() => createGithubClient({ base: 'http://127.0.0.1:1', token: TOKEN, allowInsecure: true }));
});

test('the release CLI disables publish without a token and never asks for one', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'gh_token' || key.toLowerCase() === 'github_token') delete env[key];
  }
  const result = spawnSync(
    process.execPath,
    ['scripts/release.mjs', '--bundle', SAMPLE_ZIP, '--publish'],
    { cwd: ROOT, encoding: 'utf8', env },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GH_TOKEN/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Bearer|ghp_/);
});

test('the release source API is reachable from the installer composition root', () => {
  assert.equal(installedPublishBundle, publishBundle);
});

function writeBuiltRelease(t, options = null) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-built-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE_ZIP, options });
  assert.equal(result.ok, true, result.failures.join('; '));
  for (const asset of result.assets) writeFileSync(join(dir, asset.name), asset.data);
  return { dir, result };
}

test('a canonical build is publishable and a custom build is refused before any call', async (t) => {
  const canonical = writeBuiltRelease(t);
  const accepted = readBuiltRelease(canonical.dir);
  assert.equal(accepted.ok, true, accepted.failures.join('; '));

  const custom = writeBuiltRelease(t, { 'agent-native': { targets: ['claude-code'] } });
  const refused = readBuiltRelease(custom.dir);
  assert.equal(refused.ok, false);
  assert.match(refused.failures[0], /^WEB_PUBLISH_NOT_CANONICAL: /);

  // Two-step CLI use cannot bypass the gate either: the child refuses before
  // touching the network.
  const fixture = await startGithubFixture(t, { repo: REPO });
  const result = spawnSync(
    process.execPath,
    ['scripts/release.mjs', '--publish', '--out', custom.dir, '--json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: TOKEN, GH_REPO: REPO, HM2B_GITHUB_API: fixture.origin },
    },
  );
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /WEB_PUBLISH_NOT_CANONICAL/);
  assert.equal(fixture.calls.length, 0, 'the canonical gate runs before the first remote call');
});

test('--publish --out refuses a compiled workflow that is not hm2b.compiled-workflow/v2', (t) => {
  const built = writeBuiltRelease(t);
  const compiledWorkflowFile = join(built.dir, 'workflow.compiled.json');
  const compiledWorkflow = JSON.parse(readFileSync(compiledWorkflowFile, 'utf8'));
  compiledWorkflow.schema = 'hm2b.compiled-workflow/v1';
  writeFileSync(compiledWorkflowFile, canonicalJson(compiledWorkflow));

  const refused = readBuiltRelease(built.dir);
  assert.equal(refused.ok, false);
  assert.match(refused.failures[0], /^RELEASE_COMPILED_WORKFLOW_MISMATCH: workflow\.compiled\.json schema is hm2b\.compiled-workflow\/v1 \(expected hm2b\.compiled-workflow\/v2\)/);
});

test('--publish --out refuses a zip whose manifest disagrees with the compiled workflow', (t) => {
  const built = writeBuiltRelease(t);
  const zipName = `bundle-${ID}-v${VERSION}.zip`;
  const zipPath = join(built.dir, zipName);
  const archive = readZip(new Uint8Array(readFileSync(zipPath)), { inflateRaw });
  const entries = new Map();
  for (const [name, entry] of archive.entries) {
    const data = name === 'bundle.json'
      ? Buffer.from(canonicalJson({ ...JSON.parse(Buffer.from(entry.data).toString('utf8')), version: '9.9.9' }), 'utf8')
      : Buffer.from(entry.data);
    entries.set(name, data);
  }
  const tampered = buildZip(entries);
  writeFileSync(zipPath, tampered);
  const names = built.result.assets.map((asset) => asset.name).filter((name) => name !== 'SHA256SUMS.txt').sort();
  const sums = names.map((name) => `${sha256Hex(readFileSync(join(built.dir, name)))}  ${name}\n`).join('');
  writeFileSync(join(built.dir, 'SHA256SUMS.txt'), sums);

  const refused = readBuiltRelease(built.dir);
  assert.equal(refused.ok, false);
  assert.match(refused.failures[0], /^RELEASE_TAG_MISMATCH: /);
});
