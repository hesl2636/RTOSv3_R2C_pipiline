/**
 * Web publish: immutable Release + subprocess isolation (ticket #110).
 *
 * Everything here goes through the HTTP surface of the real `web/serve.mjs`
 * and a loopback GitHub fixture: no test touches the real network, and the
 * browser never receives a credential. The expected asset digests, payload
 * files and install commands are recomputed from the shared modules and the
 * frozen release contract, never copied from a server response.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

import { compileBundle } from '../assembler/compile.js';
import { sha256Hex } from '../core/node/sha256.js';
import { inflateRaw } from '../core/node/inflate.js';
import { normalizeOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { getProjection } from '../projection/registry.js';
import { validateResult } from '../projection/validate-result.js';
import { installProjection } from '../installer/install.js';
import { readReceipt } from '../installer/receipt.js';
import { PAYLOAD_MANIFEST_NAME } from '../scripts/lib/bundle-release.mjs';
import { readReleaseTarGz } from '../scripts/lib/release-tar.mjs';
import { buildChildEnv, publishChildEnv } from '../web/env.js';
import { publishAvailability } from '../web/publish-state.js';
import { jsonResponse, startGithubFixture } from './helpers/release-fixture.js';
import {
  ROOT,
  httpRequest,
  jsonRequest,
  postHeaders,
  sessionOf,
  startWebServer,
} from './helpers/web-server.js';

const SAMPLE = join(ROOT, 'examples', 'rtosv3', 'dist', 'bundle-rtosv3-drvport-v1.0.0.zip');
const REPO = 'owner/repo';
const BUNDLE = 'rtosv3-drvport';
const VERSION = '1.0.0';
const TAG = 'bundle-rtosv3-drvport-v1.0.0';
const TOKEN = 'ghp_web_publish_secret_110a';
const SAMPLE_SHA256 = 'c22064539aa189b4d9345b1d39b148967a450584badd2593dcf47c0c5b75a13e';
const IR_DIGEST = '8a2a57593939f91117d57f9ca34c56b2fc631f6837168ef74032daa95202d395';
const R2C_FILES = 45;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-web-publish-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function compiled() {
  const bytes = readFileSync(SAMPLE);
  const result = compileBundle(new Uint8Array(bytes), { inflateRaw, sha256: sha256Hex }, { path: 'bundle.zip' });
  assert.equal(result.ok, true, JSON.stringify(result.report?.errors));
  return {
    ir: JSON.parse(Buffer.from(result.irBytes).toString('utf8')),
    irBytes: Buffer.from(result.irBytes),
    digest: result.digest,
  };
}

async function upload(server, csrf) {
  const zip = readFileSync(SAMPLE);
  const response = await httpRequest({
    port: server.port,
    method: 'POST',
    path: '/api/uploads',
    headers: postHeaders(server, csrf, {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
    }),
    body: zip,
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.data;
}

function build(server, csrf, payload) {
  return jsonRequest(server, csrf, '/api/builds', payload);
}

function publishRequest(server, csrf, buildId, payload) {
  return jsonRequest(server, csrf, `/api/builds/${buildId}/publish`, payload);
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitForJob(server, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await httpRequest({ port: server.port, path: `/api/publish/${jobId}` });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    last = response.json.data;
    if (last.state !== 'RUNNING') return last;
    await delay(100);
  }
  assert.fail(`publish job did not finish: ${JSON.stringify(last)}`);
}

async function canonicalBuild(server, csrf) {
  const uploaded = await upload(server, csrf);
  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: {} });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.data;
}

const PUBLISH_ENV = (fixture, extra = {}) => ({
  GH_TOKEN: TOKEN,
  GITHUB_TOKEN: '',
  GH_REPO: REPO,
  R2C_GITHUB_API: fixture.origin,
  ...extra,
});

/* -------------------------------------------------------------------------- */
/* Disabled state                                                             */
/* -------------------------------------------------------------------------- */

test('no token: the session says why, the API answers 403 and the button stays disabled', async (t) => {
  const server = await startWebServer(t, { GH_TOKEN: '', GITHUB_TOKEN: '', GH_REPO: REPO });
  const session = await sessionOf(server);
  assert.deepEqual(session.publish, { enabled: false, reason: 'no-token', repo: REPO });
  assert.equal(JSON.stringify(session).includes('ghp_'), false);
  assert.equal('token' in session, false);
  assert.equal('token' in (session.publish ?? {}), false);

  const buildData = await canonicalBuild(server, session.csrf);
  const denied = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'WEB_PUBLISH_DISABLED');
  assert.equal(denied.json.error.details.reason, 'no-token');

  // The same rule drives the browser button (decision #75 §8.3).
  assert.deepEqual(
    publishAvailability({ publish: session.publish, build: buildData, mismatch: false }),
    { enabled: false, reason: 'no-token', note: 'publish disabled (no-token)' },
  );

  // Publish is the only disabled operation: session and build still answer.
  const alive = await httpRequest({ port: server.port, path: '/api/session' });
  assert.equal(alive.status, 200);

  const remote = await httpRequest({ port: server.port, path: `/api/releases/${TAG}` });
  assert.equal(remote.status, 403);
  assert.equal(remote.json.error.code, 'WEB_PUBLISH_DISABLED');
  assert.equal(remote.json.error.details.reason, 'no-token');
});

test('no repository: publishing is disabled with its own reason before any child starts', async (t) => {
  const server = await startWebServer(t, {
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: '',
    GH_REPO: 'not a repo',
    R2C_GITHUB_API: 'http://127.0.0.1:9',
  });
  const session = await sessionOf(server);
  assert.deepEqual(session.publish, { enabled: false, reason: 'no-repo', repo: null });
  const buildData = await canonicalBuild(server, session.csrf);
  const denied = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.details.reason, 'no-repo');
});

test('a client/server digest mismatch disables publishing without spawning the child', async (t) => {
  const dir = tempDir(t, 'mismatch');
  const record = join(dir, 'argv.json');
  const stub = join(dir, 'stub.mjs');
  writeFileSync(stub, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
    '',
  ].join('\n'));

  const server = await startWebServer(t, {
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: '',
    GH_REPO: REPO,
    R2C_GITHUB_API: 'http://127.0.0.1:9',
    R2C_WEB_PUBLISH_SCRIPT: stub,
  });
  const session = await sessionOf(server);
  const buildData = await canonicalBuild(server, session.csrf);

  const wrongIr = await publishRequest(server, session.csrf, buildData.buildId, {
    confirmTag: TAG,
    irDigest: 'f'.repeat(64),
  });
  assert.equal(wrongIr.status, 409);
  assert.equal(wrongIr.json.error.code, 'WEB_CLIENT_SERVER_MISMATCH');

  const wrongResult = await publishRequest(server, session.csrf, buildData.buildId, {
    confirmTag: TAG,
    resultDigests: { r2c: 'e'.repeat(64) },
  });
  assert.equal(wrongResult.status, 409);
  assert.equal(wrongResult.json.error.code, 'WEB_CLIENT_SERVER_MISMATCH');

  const wrongTag = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: 'bundle-other-v2.0.0' });
  assert.equal(wrongTag.status, 400);
  assert.equal(wrongTag.json.error.code, 'WEB_TAG_MISMATCH');

  const badCsrf = await jsonRequest(server, session.csrf, `/api/builds/${buildData.buildId}/publish`, { confirmTag: TAG }, {
    'X-R2C-CSRF': 'wrong',
  });
  assert.equal(badCsrf.status, 403);
  assert.equal(badCsrf.json.error.code, 'WEB_CSRF_INVALID');

  const unknownBuild = await publishRequest(server, session.csrf, 'f'.repeat(16), { confirmTag: TAG });
  assert.equal(unknownBuild.status, 404);
  assert.equal(unknownBuild.json.error.code, 'WEB_BUILD_UNKNOWN');

  const { ir } = compiled();
  const customUpload = await upload(server, session.csrf);
  const custom = await build(server, session.csrf, {
    uploadId: customUpload.uploadId,
    options: { r2c: { stageOrder: ir.stages.map((stage) => stage.id).reverse() } },
  });
  assert.equal(custom.status, 200, JSON.stringify(custom.json));
  assert.equal(custom.json.data.publishable, false);
  const notCanonical = await publishRequest(server, session.csrf, custom.json.data.buildId, {
    confirmTag: custom.json.data.tag,
  });
  assert.equal(notCanonical.status, 409);
  assert.equal(notCanonical.json.error.code, 'WEB_PUBLISH_NOT_CANONICAL');

  assert.equal(existsSync(record), false, 'a rejected request must not start the publish child');

  assert.deepEqual(
    publishAvailability({ publish: session.publish, build: buildData, mismatch: true }),
    { enabled: false, reason: 'client-server-mismatch', note: 'publish disabled: client/server mismatch' },
  );
  assert.equal(publishAvailability({ publish: session.publish, build: buildData, mismatch: false }).enabled, true);
  assert.equal(
    publishAvailability({ publish: session.publish, build: { ...buildData, publishable: false }, mismatch: false }).reason,
    'not-canonical',
  );
});

/* -------------------------------------------------------------------------- */
/* Child isolation                                                            */
/* -------------------------------------------------------------------------- */

function stubScript(dir, { mode, record }) {
  const stub = join(dir, 'publish-stub.mjs');
  const tag = TAG;
  writeFileSync(stub, [
    "import { writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(record)}, JSON.stringify({`,
    '  argv: args,',
    '  tokenPresent: typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN !== "",',
    '  repo: process.env.GH_REPO ?? null,',
    '}));',
    `const mode = ${JSON.stringify(mode)};`,
    "process.stdout.write(JSON.stringify({ event: 'phase', phase: 'DRAFT_CREATED' }) + '\\n');",
    "if (mode === 'hang') { setInterval(() => {}, 1000); }",
    "else if (mode === 'fail') {",
    "  process.stderr.write('stub exploded with ' + (process.env.GH_TOKEN ?? '') + '\\n');",
    "  process.stdout.write(JSON.stringify({ event: 'result', ok: false, state: 'FAILED', failures: ['RELEASE_PUBLISH_FAILED: stub'] }) + '\\n');",
    '  process.exit(9);',
    '} else {',
    `  process.stdout.write(JSON.stringify({ event: 'result', ok: true, state: 'PUBLISHED', published: true, tag: ${JSON.stringify(tag)}, releaseId: 7 }) + '\\n');`,
    '}',
    '',
  ].join('\n'));
  return stub;
}

test('the publish child keeps the token in env only, gets --out inside the session root, and maps a crash to WEB_CHILD_FAILED', async (t) => {
  const dir = tempDir(t, 'child');
  const record = join(dir, 'record.json');
  const stub = stubScript(dir, { mode: 'ok', record });
  const server = await startWebServer(t, {
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: '',
    GH_REPO: REPO,
    R2C_GITHUB_API: 'http://127.0.0.1:9',
    R2C_WEB_PUBLISH_SCRIPT: stub,
  });
  const session = await sessionOf(server);
  const buildData = await canonicalBuild(server, session.csrf);
  const accepted = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  assert.equal(accepted.json.data.phase, 'BUILD_READY');
  const job = await waitForJob(server, accepted.json.data.jobId);
  assert.equal(job.state, 'PUBLISHED', JSON.stringify(job));
  assert.equal(job.result.tag, TAG);
  assert.equal(job.result.releaseId, 7);
  assert.equal(job.result.install.mode, 'release');

  const child = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(child.tokenPresent, true, 'the publish child inherits the credential through env');
  assert.equal(child.repo, REPO);
  assert.ok(child.argv.includes('--publish'));
  const outIndex = child.argv.indexOf('--out');
  assert.ok(outIndex > 0, 'the child must be given --out');
  const out = resolve(child.argv[outIndex + 1]);
  assert.ok(out.includes(`${sep}r2c-web-`) || /r2c-web-[^\\/]+/.test(out), `--out must be in the session temp root: ${out}`);
  assert.equal(child.argv.join(' ').includes(TOKEN), false, 'the token must never cross argv');
  assert.equal(JSON.stringify(job).includes(TOKEN), false, 'the job payload must not leak the token');
  assert.equal(`${server.stdout()}\n${server.stderr()}`.includes(TOKEN), false, 'the server log must not leak the token');

  // Non-publish children never inherit the credential.
  const stripped = buildChildEnv({ ...process.env, GH_TOKEN: TOKEN, GITHUB_TOKEN: 'x', KEEP: '1' });
  assert.equal(stripped.GH_TOKEN, undefined);
  assert.equal(stripped.GITHUB_TOKEN, undefined);
  assert.equal(stripped.KEEP, '1');
  assert.equal(publishChildEnv({ GH_TOKEN: TOKEN, KEEP: '1' }).GH_TOKEN, TOKEN);
  assert.equal(publishChildEnv({ GH_TOKEN: TOKEN, KEEP: '1' }).KEEP, '1');

  // A crashing child is redacted and the server survives.
  const failing = stubScript(dir, { mode: 'fail', record: join(dir, 'record-fail.json') });
  const second = await startWebServer(t, {
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: '',
    GH_REPO: REPO,
    R2C_GITHUB_API: 'http://127.0.0.1:9',
    R2C_WEB_PUBLISH_SCRIPT: failing,
  });
  const secondSession = await sessionOf(second);
  const secondBuild = await canonicalBuild(second, secondSession.csrf);
  const failed = await publishRequest(second, secondSession.csrf, secondBuild.buildId, { confirmTag: TAG });
  assert.equal(failed.status, 202);
  const failedJob = await waitForJob(second, failed.json.data.jobId);
  assert.equal(failedJob.state, 'FAILED');
  assert.equal(failedJob.error.code, 'WEB_CHILD_FAILED');
  assert.match(failedJob.error.details.stderr, /stub exploded/);
  assert.equal(failedJob.error.details.stderr.includes(TOKEN), false, 'stderr must be redacted');
  assert.equal(JSON.stringify(failedJob).includes(TOKEN), false);
  assert.equal(`${second.stdout()}\n${second.stderr()}`.includes(TOKEN), false);
  const alive = await httpRequest({ port: second.port, path: '/api/session' });
  assert.equal(alive.status, 200, 'a failed publish child must not kill the server');
});

test('a hung publish child is killed after its budget and maps to WEB_CHILD_TIMEOUT', async (t) => {
  const dir = tempDir(t, 'timeout');
  const stub = stubScript(dir, { mode: 'hang', record: join(dir, 'record-hang.json') });
  const server = await startWebServer(t, {
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: '',
    GH_REPO: REPO,
    R2C_GITHUB_API: 'http://127.0.0.1:9',
    R2C_WEB_PUBLISH_SCRIPT: stub,
    R2C_WEB_PUBLISH_TIMEOUT_MS: '400',
  });
  const session = await sessionOf(server);
  const buildData = await canonicalBuild(server, session.csrf);
  const started = Date.now();
  const accepted = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(accepted.status, 202);
  const job = await waitForJob(server, accepted.json.data.jobId, 20_000);
  assert.equal(job.state, 'FAILED');
  assert.equal(job.error.code, 'WEB_CHILD_TIMEOUT');
  assert.ok(Date.now() - started < 10_000, 'the timeout must kill the child promptly');
  const alive = await httpRequest({ port: server.port, path: '/api/session' });
  assert.equal(alive.status, 200);
});

test('publish is serialised (concurrency 1) and limited to 10 per hour with Retry-After', async (t) => {
  const dir = tempDir(t, 'rate');
  const stub = stubScript(dir, { mode: 'hang', record: join(dir, 'record.json') });
  const server = await startWebServer(t, {
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: '',
    GH_REPO: REPO,
    R2C_GITHUB_API: 'http://127.0.0.1:9',
    R2C_WEB_PUBLISH_SCRIPT: stub,
    R2C_WEB_PUBLISH_TIMEOUT_MS: '600',
  });
  const session = await sessionOf(server);
  const buildData = await canonicalBuild(server, session.csrf);

  const first = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(first.status, 202);
  const busy = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, 'WEB_PUBLISH_BUSY');
  await waitForJob(server, first.json.data.jobId, 20_000);

  // Nine requests in the window are counted; the tenth accepted publish is
  // the last and the next request is throttled.
  for (let index = 0; index < 8; index += 1) {
    const accepted = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
    assert.equal(accepted.status, 202, `attempt ${index + 2}: ${JSON.stringify(accepted.json)}`);
    const job = await waitForJob(server, accepted.json.data.jobId, 20_000);
    assert.equal(job.state === 'FAILED' || job.state === 'PUBLISHED', true);
  }
  const limited = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'WEB_RATE_LIMITED');
  const retryAfter = Number(limited.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 3600, `Retry-After: ${limited.headers['retry-after']}`);
});

/* -------------------------------------------------------------------------- */
/* Fixture publish: state machine, immutability, credential hygiene           */
/* -------------------------------------------------------------------------- */

async function fixtureServer(t, fixture, extra = {}) {
  const server = await startWebServer(t, PUBLISH_ENV(fixture, extra));
  const session = await sessionOf(server);
  assert.equal(session.publish.enabled, true, JSON.stringify(session.publish));
  assert.equal(session.publish.repo, REPO);
  const buildData = await canonicalBuild(server, session.csrf);
  return { server, session, buildData };
}

test('publish walks draft → upload → verify → publish against the fixture and stays token-clean', async (t) => {
  const fixture = await startGithubFixture(t, { repo: REPO, requireToken: true });
  const { server, session, buildData } = await fixtureServer(t, fixture);
  assert.equal(buildData.tag, TAG);
  assert.equal(buildData.canonical, true);

  const accepted = await publishRequest(server, session.csrf, buildData.buildId, {
    confirmTag: TAG,
    irDigest: buildData.ir.digest,
    resultDigests: Object.fromEntries(buildData.projections.map((projection) => [projection.id, projection.digest])),
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  const job = await waitForJob(server, accepted.json.data.jobId);
  assert.equal(job.state, 'PUBLISHED', JSON.stringify(job));
  assert.equal(job.phase, 'PUBLISHED');
  assert.equal(job.result.tag, TAG);
  assert.equal(job.result.install.mode, 'release');
  for (const phase of ['PRECHECK', 'DRAFT_CREATED', 'UPLOADING', 'VERIFYING', 'PUBLISHING', 'PUBLISHED']) {
    assert.ok(job.log.includes(`phase ${phase}`), `publish log records ${phase}: ${job.log.join(' | ')}`);
  }

  const release = fixture.release(TAG);
  assert.ok(release, 'the fixture must hold the release');
  assert.equal(release.draft, false);
  assert.equal(release.makeLatest, 'false');
  assert.equal(release.prerelease, false);

  const remoteNames = fixture.assets(TAG).map((asset) => asset.name).sort();
  const localNames = buildData.artifacts.map((asset) => asset.name).sort();
  assert.deepEqual(remoteNames, localNames);
  for (const asset of buildData.artifacts) {
    assert.equal(sha256Hex(fixture.assetData(TAG, asset.name)), asset.sha256, asset.name);
    assert.equal(fixture.assetData(TAG, asset.name).length, asset.bytes, asset.name);
  }
  const sums = fixture.assetData(TAG, 'SHA256SUMS.txt').toString('utf8').trim().split('\n');
  assert.equal(sums.length, localNames.length - 1);
  for (const line of sums) {
    const [digest, name] = line.split('  ');
    assert.equal(sha256Hex(fixture.assetData(TAG, name)), digest, name);
  }

  // The generated commands are the frozen install shape (§13/§75 §9).
  const commands = job.result.install.commands;
  const r2cCommand = commands.find((item) => item.projection === 'r2c');
  assert.equal(
    r2cCommand.command,
    `node .r2c/bootstrap/install.mjs --bundle ${BUNDLE} --version ${VERSION} --projection r2c --project .`,
  );
  assert.ok(commands.some((item) => item.projection === 'agent-native' && item.target === 'claude-code'));

  // Credential hygiene: token only in the Authorization header.
  const blobs = [
    server.stdout(),
    server.stderr(),
    JSON.stringify(job),
    JSON.stringify(buildData),
    JSON.stringify(session),
  ];
  for (const asset of buildData.artifacts) {
    blobs.push(fixture.assetData(TAG, asset.name).toString('utf8'));
  }
  for (const blob of blobs) assert.equal(blob.includes(TOKEN), false, 'token leaked outside the Authorization header');
  for (const call of fixture.calls) {
    assert.equal(call.url.includes(TOKEN), false, 'token leaked into a URL');
    assert.equal(call.body.toString('utf8').includes(TOKEN), false, 'token leaked into a request body');
    if (call.path.startsWith('/repos/') || call.path.startsWith('/uploads/')) {
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    }
  }
  for (const asset of buildData.artifacts) {
    assert.equal(asset.sha256.length, 64);
    if (asset.name === `bundle-${BUNDLE}-v${VERSION}.zip`) assert.equal(asset.sha256, SAMPLE_SHA256);
  }

  const remoteState = await httpRequest({ port: server.port, path: `/api/releases/${TAG}` });
  assert.equal(remoteState.status, 200, JSON.stringify(remoteState.json));
  assert.equal(remoteState.json.data.state, 'published');
  assert.deepEqual(
    remoteState.json.data.assets.map((asset) => asset.name).sort(),
    localNames,
  );
});

test('a published tag is never rewritten: a second publish makes no upload, PATCH or DELETE', async (t) => {
  const fixture = await startGithubFixture(t, { repo: REPO, requireToken: true });
  const { server, session, buildData } = await fixtureServer(t, fixture);

  const first = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  const published = await waitForJob(server, first.json.data.jobId);
  assert.equal(published.state, 'PUBLISHED', JSON.stringify(published));

  const before = {
    posts: fixture.callsOf('POST', '/repos/.*/releases$').length,
    uploads: fixture.callsOf('POST', '^/uploads/').length,
    patches: fixture.callsOf('PATCH').length,
    deletes: fixture.callsOf('DELETE').length,
  };
  const assetsBefore = fixture.assets(TAG).map((asset) => [asset.name, sha256Hex(asset.data)]);

  const second = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(second.status, 202);
  const repeat = await waitForJob(server, second.json.data.jobId);
  assert.equal(repeat.state, 'FAILED');
  assert.equal(repeat.error.code, 'WEB_CHILD_FAILED');
  assert.equal(repeat.error.details.release.state, 'ALREADY_PUBLISHED');
  assert.equal(repeat.error.details.release.recovery, 'new-patch');
  assert.match(repeat.error.details.release.failures.join(' '), /RELEASE_TAG_CONFLICT/);

  assert.deepEqual(
    {
      posts: fixture.callsOf('POST', '/repos/.*/releases$').length,
      uploads: fixture.callsOf('POST', '^/uploads/').length,
      patches: fixture.callsOf('PATCH').length,
      deletes: fixture.callsOf('DELETE').length,
    },
    before,
    'no request may rewrite a published release',
  );
  assert.deepEqual(fixture.assets(TAG).map((asset) => [asset.name, sha256Hex(asset.data)]), assetsBefore);
});

test('a pre-publish failure deletes the draft and the tag, and maps to WEB_CHILD_FAILED', async (t) => {
  const fixture = await startGithubFixture(t, { repo: REPO, requireToken: true });
  fixture.intercept = (ctx) => (
    ctx.method === 'POST' && ctx.path.startsWith('/uploads/')
      ? jsonResponse(500, { message: 'injected upload failure' })
      : undefined
  );
  const { server, session, buildData } = await fixtureServer(t, fixture);

  const accepted = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(accepted.status, 202);
  const job = await waitForJob(server, accepted.json.data.jobId);
  assert.equal(job.state, 'FAILED');
  assert.equal(job.error.code, 'WEB_CHILD_FAILED');
  assert.equal(job.error.details.release.state, 'FAILED');
  assert.equal(job.error.details.release.published, false);
  assert.equal(job.error.details.release.recovery, 'retry');
  assert.equal(fixture.release(TAG), null, 'the draft must be deleted');
  assert.equal(fixture.refs.has(TAG), false, 'the tag created in this run must be deleted');
  assert.ok(fixture.callsOf('DELETE').length >= 1);
  const alive = await httpRequest({ port: server.port, path: '/api/session' });
  assert.equal(alive.status, 200);
});

test('a post-publish failure leaves the published assets untouched and advises a new patch', async (t) => {
  const fixture = await startGithubFixture(t, { repo: REPO, requireToken: true });
  fixture.intercept = (ctx) => {
    const match = /^\/repos\/owner\/repo\/releases\/(\d+)$/.exec(ctx.path);
    if (match !== null && ctx.method === 'GET' && fixture.release(TAG)?.draft === false) {
      return jsonResponse(500, { message: 'injected read-back failure' });
    }
    return undefined;
  };
  const { server, session, buildData } = await fixtureServer(t, fixture);

  const accepted = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  assert.equal(accepted.status, 202);
  const job = await waitForJob(server, accepted.json.data.jobId);
  assert.equal(job.state, 'FAILED');
  assert.equal(job.error.code, 'WEB_CHILD_FAILED');
  assert.equal(job.error.details.release.published, true);
  assert.equal(job.error.details.release.state, 'PUBLISHED_UNVERIFIED');
  assert.equal(job.error.details.release.recovery, 'mark-prerelease-or-new-patch');
  assert.match(job.error.details.release.failures.join(' '), /RELEASE_PUBLISH_FAILED/);
  assert.equal(fixture.callsOf('DELETE').length, 0, 'a published release is never deleted');
  assert.equal(fixture.release(TAG).draft, false);
  for (const asset of buildData.artifacts) {
    assert.equal(sha256Hex(fixture.assetData(TAG, asset.name)), asset.sha256, asset.name);
  }
});

/* -------------------------------------------------------------------------- */
/* End-to-end: publish → install the Release into a temp project              */
/* -------------------------------------------------------------------------- */

function downloadFixtureAsset(fixture, name) {
  return httpRequest({
    port: Number(new URL(fixture.origin).port),
    path: `/download/${encodeURIComponent(TAG)}/${encodeURIComponent(name)}`,
  });
}

test('end-to-end: publish once, take the generated command and install the Release with verifiable receipts', async (t) => {
  const fixture = await startGithubFixture(t, { repo: REPO, requireToken: true });
  const { server, session, buildData } = await fixtureServer(t, fixture);
  const accepted = await publishRequest(server, session.csrf, buildData.buildId, { confirmTag: TAG });
  const job = await waitForJob(server, accepted.json.data.jobId);
  assert.equal(job.state, 'PUBLISHED', JSON.stringify(job));

  // 1. The generated command is the release form and names this release.
  const command = job.result.install.commands.find((item) => item.projection === 'r2c').command;
  const tokens = command.split(' ');
  assert.equal(tokens[0], 'node');
  assert.equal(tokens[1], '.r2c/bootstrap/install.mjs');
  const flag = (name) => tokens[tokens.indexOf(name) + 1];
  assert.equal(flag('--bundle'), BUNDLE);
  assert.equal(flag('--version'), VERSION);
  assert.equal(flag('--projection'), 'r2c');
  assert.equal(flag('--project'), '.');
  assert.equal(tokens.includes('--release-base'), false, 'a published release needs no local mirror');

  // 2. Every published byte is verified against the Release manifest.
  const payloadName = `r2c-payload-${BUNDLE}-v${VERSION}.tgz`;
  const downloaded = new Map();
  for (const asset of buildData.artifacts) {
    const response = await downloadFixtureAsset(fixture, asset.name);
    assert.equal(response.status, 200, asset.name);
    downloaded.set(asset.name, response.raw);
    assert.equal(sha256Hex(response.raw), asset.sha256, `${asset.name} differs from the build`);
  }
  const sums = downloaded.get('SHA256SUMS.txt').toString('utf8');
  for (const asset of buildData.artifacts) {
    if (asset.name === 'SHA256SUMS.txt') continue;
    assert.match(sums, new RegExp(`^${asset.sha256}  ${asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }

  // 3. The payload archive matches its manifest and the projection result.
  const { ir, irBytes, digest } = compiled();
  assert.equal(digest, IR_DIGEST);
  const manifest = getProjection('r2c');
  const normalized = normalizeOptions({ projectionId: 'r2c', ir, irDigest: digest, raw: null, manifest });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  const result = project({
    projectionId: 'r2c',
    ir,
    irDigest: digest,
    options: normalized.options,
    environment: { engineVersion: buildData.engineVersion },
    assets: {},
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const checked = validateResult(result, {
    ir,
    irDigest: digest,
    manifest,
    options: normalized.options,
    environment: { engineVersion: buildData.engineVersion },
    assets: {},
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert.equal(result.files.length, R2C_FILES);

  const payload = readReleaseTarGz(downloaded.get(payloadName));
  assert.deepEqual(payload.problems, []);
  const payloadManifestEntry = payload.entries.find((entry) => entry.path === PAYLOAD_MANIFEST_NAME);
  assert.ok(payloadManifestEntry, 'the payload has a manifest');
  const payloadManifest = JSON.parse(Buffer.from(payloadManifestEntry.data).toString('utf8'));
  assert.deepEqual(payloadManifest.bundle, { id: BUNDLE, version: VERSION });
  assert.equal(payloadManifest.ir.digest, digest);
  assert.equal(payloadManifest.files.length, result.files.length);
  for (const file of result.files) {
    const entry = payload.entries.find((candidate) => candidate.path === `files/${file.path}`);
    assert.ok(entry, `${file.path} is in the payload`);
    assert.equal(sha256Hex(entry.data), sha256Hex(file.content), `${file.path} bytes differ`);
    const declared = payloadManifest.files.find((candidate) => candidate.path === file.path);
    assert.ok(declared, `${file.path} is declared in the payload manifest`);
    assert.equal(declared.sha256, sha256Hex(file.content));
    assert.equal(declared.mode, file.mode);
  }

  // 4. Install the release payload into a temp project via the installer.
  const projectRoot = tempDir(t, 'project');
  const installed = installProjection({ projectRoot, result, irBytes, irDigest: digest });
  assert.equal(installed.ok, true, JSON.stringify(installed));

  // 5. Every receipt hash recomputes, and the installed bytes equal the payload.
  const stored = readReceipt(projectRoot, 'r2c', BUNDLE);
  assert.ok(stored, 'the installer wrote a receipt');
  const receipt = stored.receipt;
  assert.equal(receipt.bundle.id, BUNDLE);
  assert.equal(receipt.bundle.version, VERSION);
  assert.equal(receipt.ir.digest, digest);
  assert.equal(receipt.files.length, payloadManifest.files.length);
  const payloadByPath = new Map(payloadManifest.files.map((file) => [file.path, file]));
  for (const file of receipt.files) {
    const absolute = join(projectRoot, ...file.path.split('/'));
    assert.equal(existsSync(absolute), true, `${file.path} was installed`);
    const bytes = readFileSync(absolute);
    assert.equal(sha256Hex(bytes), file.sha256, `${file.path} receipt hash recomputes`);
    const declared = payloadByPath.get(file.path);
    assert.ok(declared, `${file.path} comes from the payload manifest`);
    assert.equal(sha256Hex(bytes), declared.sha256, `${file.path} matches the payload`);
    const archived = payload.entries.find((entry) => entry.path === `files/${file.path}`);
    assert.ok(archived, `${file.path} is in the payload archive`);
    assert.equal(Buffer.compare(bytes, Buffer.from(archived.data)), 0, `${file.path} bytes equal the payload`);
  }
  for (const file of payloadManifest.files) {
    assert.ok(receipt.files.some((entry) => entry.path === file.path), `${file.path} is in the receipt`);
  }

  // Nothing in the install wrote outside the project root.
  const entries = readdirSync(projectRoot).sort();
  assert.ok(entries.includes('.r2c'), 'the installer wrote its own state under the project root');
});
