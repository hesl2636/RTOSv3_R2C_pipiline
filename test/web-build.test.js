/**
 * Web options and build (#109).
 *
 * HTTP-level acceptance for the options panel contract and the authoritative
 * build: the server compiles from its own upload, runs the shared projections,
 * spawns the release packager as an isolated child, and hands back the same
 * numbers the CLI prints. Every expected value comes from the shared modules
 * (or from the frozen anchors), never from the server response itself.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileBundle } from '../assembler/compile.js';
import { canonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';
import { inflateRaw } from '../core/node/inflate.js';
import { normalizeOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { getProjection } from '../projection/registry.js';
import { readReleaseTarGz } from '../scripts/lib/release-tar.mjs';
import { PAYLOAD_MANIFEST_NAME } from '../scripts/lib/bundle-release.mjs';
import {
  ROOT,
  cliJson,
  httpRequest,
  jsonRequest,
  postHeaders,
  rawRequest,
  sessionOf,
  startWebServer,
  statusOf,
} from './helpers/web-server.js';

const SAMPLE = join(ROOT, 'examples', 'rtosv3', 'dist', 'bundle-rtosv3-drvport-v1.0.0.zip');
const IR_FIXTURE = join(ROOT, 'test', 'fixtures', 'ir', 'workflow.ir.json');
const SAMPLE_SHA256 = 'c22064539aa189b4d9345b1d39b148967a450584badd2593dcf47c0c5b75a13e';
const IR_DIGEST = '8a2a57593939f91117d57f9ca34c56b2fc631f6837168ef74032daa95202d395';
const TAG = 'bundle-rtosv3-drvport-v1.0.0';
const ASSETS = [
  'SHA256SUMS.txt',
  'agent-native-rtosv3-drvport-v1.0.0.tgz',
  'bundle-rtosv3-drvport-v1.0.0.zip',
  'install.mjs',
  'r2c-engine-0.1.0.tgz',
  'r2c-framework-0.1.0.tgz',
  'r2c-payload-rtosv3-drvport-v1.0.0.tgz',
  'workflow.ir.json',
];
const R2C_CANONICAL = { files: 45, bytes: 48840, degradations: 4, capabilities: 8, warnings: 0 };
const AGENT_NATIVE_CANONICAL = { files: 98, bytes: 142620, degradations: 45, capabilities: 40, warnings: 1 };

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-web-build-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function compiledIr() {
  const bytes = readFileSync(SAMPLE);
  const compiled = compileBundle(new Uint8Array(bytes), { inflateRaw, sha256: sha256Hex }, { path: 'bundle.zip' });
  assert.equal(compiled.ok, true);
  return {
    ir: JSON.parse(Buffer.from(compiled.irBytes).toString('utf8')),
    irDigest: compiled.digest,
    irBytes: Buffer.from(compiled.irBytes),
  };
}

/** Project with the shared modules: the independent oracle for every number. */
function expected({ projectionId, raw = null, engineVersion }) {
  const { ir, irDigest } = compiledIr();
  const manifest = getProjection(projectionId);
  const normalized = normalizeOptions({ projectionId, ir, irDigest, raw, manifest });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  const result = project({
    projectionId,
    ir,
    irDigest,
    options: normalized.options,
    environment: { engineVersion },
    assets: {},
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const bytes = result.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
  return {
    options: normalized.options,
    result,
    digest: sha256Hex(canonicalJson(result)),
    files: result.files.map((file) => ({
      path: file.path,
      targets: [...file.targets],
      kind: file.kind,
      mode: file.mode,
      sha256: sha256Hex(file.content),
    })),
    counts: {
      files: result.files.length,
      bytes,
      degradations: result.degradations.length,
      warnings: result.warnings.length,
      capabilities: result.capabilityReport.length,
    },
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
  assert.match(response.json.data.uploadId, /^[0-9a-f]{16}$/);
  return response.json.data;
}

async function build(server, csrf, payload) {
  return jsonRequest(server, csrf, '/api/builds', payload);
}

function projectionOf(data, id) {
  const found = data.projections.find((projection) => projection.id === id);
  assert.ok(found, `missing projection ${id}`);
  return found;
}

function payloadManifest(bytes) {
  const { entries, problems } = readReleaseTarGz(bytes);
  assert.deepEqual(problems, []);
  const entry = entries.find((item) => item.path === PAYLOAD_MANIFEST_NAME);
  assert.ok(entry, 'payload has no manifest.json');
  return JSON.parse(Buffer.from(entry.data).toString('utf8'));
}

function assertMatchesExpected(actual, oracle) {
  assert.deepEqual(actual.files, oracle.files, 'file list');
  assert.deepEqual(actual.capabilityReport, oracle.result.capabilityReport, 'capability matrix');
  assert.deepEqual(actual.degradations, oracle.result.degradations, 'degradations');
  assert.deepEqual(actual.warnings, oracle.result.warnings, 'warnings');
  assert.deepEqual(actual.coverage, oracle.result.coverage, 'coverage');
  assert.deepEqual(actual.targets, oracle.result.targets, 'targets');
  assert.deepEqual(actual.options, oracle.options, 'resolved options echo');
  assert.deepEqual(actual.metadata, oracle.result.metadata, 'metadata');
  assert.equal(actual.digest, oracle.digest, 'result digest');
  assert.deepEqual(actual.counts, oracle.counts, 'counts');
}

test('canonical build is publishable and matches the CLI projection numbers', async (t) => {
  const server = await startWebServer(t);
  const { csrf, engineVersion } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  assert.equal(uploaded.report.ok, true);
  assert.equal(uploaded.ir.digest, IR_DIGEST);
  const report = uploaded.report;

  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: {} });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const data = response.json.data;

  assert.match(data.buildId, /^[0-9a-f]{16}$/);
  assert.equal(data.tag, TAG);
  assert.equal(data.canonical, true);
  assert.equal(data.publishable, true);
  assert.deepEqual(
    { id: data.ir.id, version: data.ir.version, digest: data.ir.digest },
    { id: report.id, version: report.version, digest: IR_DIGEST },
  );
  assert.deepEqual(data.projections.map((item) => item.id), ['agent-native', 'r2c']);

  const r2c = projectionOf(data, 'r2c');
  const agentNative = projectionOf(data, 'agent-native');
  const r2cOracle = expected({ projectionId: 'r2c', engineVersion });
  const agentOracle = expected({ projectionId: 'agent-native', engineVersion });
  assertMatchesExpected(r2c, r2cOracle);
  assertMatchesExpected(agentNative, agentOracle);
  assert.deepEqual(
    { files: r2c.counts.files, bytes: r2c.counts.bytes, degradations: r2c.counts.degradations, capabilities: r2c.counts.capabilities },
    { files: R2C_CANONICAL.files, bytes: R2C_CANONICAL.bytes, degradations: R2C_CANONICAL.degradations, capabilities: R2C_CANONICAL.capabilities },
  );
  assert.deepEqual(
    {
      files: agentNative.counts.files,
      bytes: agentNative.counts.bytes,
      degradations: agentNative.counts.degradations,
      capabilities: agentNative.counts.capabilities,
    },
    {
      files: AGENT_NATIVE_CANONICAL.files,
      bytes: AGENT_NATIVE_CANONICAL.bytes,
      degradations: AGENT_NATIVE_CANONICAL.degradations,
      capabilities: AGENT_NATIVE_CANONICAL.capabilities,
    },
  );

  // The CLI prints the same contract numbers for the frozen IR.
  const cli = cliJson(['bin/r2c-assembler.js', 'project', IR_FIXTURE, '--projection', 'r2c', '--json']).data;
  assert.deepEqual(r2c.files, cli.files);
  assert.deepEqual(r2c.capabilityReport, cli.capabilityReport);
  assert.deepEqual(r2c.degradations, cli.degradations);
  assert.deepEqual(r2c.warnings, cli.warnings);
  assert.deepEqual(r2c.coverage, cli.coverage);

  // Assets are exactly the release table, verified byte for byte.
  assert.deepEqual(data.artifacts.map((asset) => asset.name), ASSETS);
  for (const asset of data.artifacts) {
    assert.match(asset.url, new RegExp(`^/api/builds/${data.buildId}/artifacts/`));
    const download = await httpRequest({ port: server.port, path: asset.url });
    assert.equal(download.status, 200, asset.name);
    assert.equal(download.raw.length, asset.bytes, asset.name);
    assert.equal(sha256Hex(download.raw), asset.sha256, asset.name);
  }

  const sums = await httpRequest({
    port: server.port,
    path: `/api/builds/${data.buildId}/artifacts/SHA256SUMS.txt`,
  });
  const lines = sums.raw.toString('utf8').trim().split('\n');
  assert.equal(lines.length, ASSETS.length - 1);
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.notEqual(match, null, line);
    assert.notEqual(match[2], 'SHA256SUMS.txt');
    const asset = data.artifacts.find((item) => item.name === match[2]);
    assert.ok(asset, `sums cover ${match[2]}`);
    assert.equal(asset.sha256, match[1], match[2]);
  }

  // Payload archives record canonical inputs and exactly the projected files.
  for (const [id, oracle, name] of [
    ['r2c', r2cOracle, 'r2c-payload-rtosv3-drvport-v1.0.0.tgz'],
    ['agent-native', agentOracle, 'agent-native-rtosv3-drvport-v1.0.0.tgz'],
  ]) {
    const download = await httpRequest({ port: server.port, path: `/api/builds/${data.buildId}/artifacts/${name}` });
    const manifest = payloadManifest(download.raw);
    assert.equal(manifest.projection.id, id);
    assert.equal(manifest.ir.digest, IR_DIGEST);
    assert.deepEqual(manifest.options, {
      stageOrder: null,
      skills: null,
      targets: id === 'r2c' ? ['r2c'] : agentOracle.result.targets,
    });
    assert.deepEqual(
      manifest.files.map(({ path, mode, sha256, kind, targets }) => ({ path, mode, sha256, kind, targets })),
      oracle.files,
    );
  }

  // Fixed-version install commands, never a project write.
  assert.equal(data.install.mode, 'release');
  const commands = data.install.commands;
  const r2cCommand = commands.find((item) => item.projection === 'r2c');
  assert.deepEqual(
    { projection: r2cCommand.projection, target: r2cCommand.target, command: r2cCommand.command },
    {
      projection: 'r2c',
      target: null,
      command: 'node .r2c/bootstrap/install.mjs --bundle rtosv3-drvport --version 1.0.0 --projection r2c --project .',
    },
  );
  const agentCommands = commands.filter((item) => item.projection === 'agent-native');
  assert.equal(agentCommands.filter((item) => item.target === null).length, 1);
  for (const target of ['claude-code', 'codex', 'dsh', 'omp', 'opencode']) {
    assert.ok(
      agentCommands.some((item) => item.target === target && item.command.includes(`--target ${target}`)),
      target,
    );
  }
  for (const item of commands) {
    assert.match(
      item.command,
      /^node \.r2c\/bootstrap\/install\.mjs --bundle [a-z0-9-]+ --version \d+\.\d+\.\d+ --projection (r2c|agent-native)( --target [a-z-]+)? --project \.$/,
    );
    assert.doesNotMatch(item.command, /--release-base/);
  }

  const list = await httpRequest({ port: server.port, path: '/api/builds' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.builds.map((item) => item.buildId), [data.buildId]);
});

test('custom options build locally, record the actual options and stay unpublishable', async (t) => {
  const server = await startWebServer(t);
  const { csrf, engineVersion } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const { ir } = compiledIr();
  const skillIds = Object.keys(ir.skills).sort();
  const stageIds = ir.stages.map((stage) => stage.id);
  const twelve = skillIds.slice(0, 12);
  const custom = {
    r2c: { stageOrder: [...stageIds].reverse(), skills: twelve, targets: ['r2c'] },
    'agent-native': { skills: twelve, targets: ['claude-code', 'codex'] },
  };

  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: custom });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const data = response.json.data;
  assert.equal(data.canonical, false);
  assert.equal(data.publishable, false);
  assert.equal(data.install.mode, 'local');

  const r2c = projectionOf(data, 'r2c');
  const agentNative = projectionOf(data, 'agent-native');
  const r2cOracle = expected({ projectionId: 'r2c', raw: custom.r2c, engineVersion });
  const agentOracle = expected({ projectionId: 'agent-native', raw: custom['agent-native'], engineVersion });
  assertMatchesExpected(r2c, r2cOracle);
  assertMatchesExpected(agentNative, agentOracle);
  // The frozen K=12 anchor is agent-native with every target selected.
  const twelveSkills = expected({ projectionId: 'agent-native', raw: { skills: twelve }, engineVersion });
  assert.equal(twelveSkills.counts.files, 52, 'K=12 anchor');
  assert.deepEqual(r2c.options.stageOrder, [...stageIds].reverse());
  assert.deepEqual(r2c.options.skills, twelve);
  assert.deepEqual(agentNative.targets, ['claude-code', 'codex']);

  // The asset table is unchanged; only the recorded options differ.
  assert.deepEqual(data.artifacts.map((asset) => asset.name), ASSETS);
  for (const [name, oracle, projectionId] of [
    ['r2c-payload-rtosv3-drvport-v1.0.0.tgz', r2cOracle, 'r2c'],
    ['agent-native-rtosv3-drvport-v1.0.0.tgz', agentOracle, 'agent-native'],
  ]) {
    const download = await httpRequest({ port: server.port, path: `/api/builds/${data.buildId}/artifacts/${name}` });
    const manifest = payloadManifest(download.raw);
    assert.deepEqual(manifest.options, {
      stageOrder: [...oracle.result.options.stageOrder],
      skills: [...oracle.result.options.skills],
      targets: [...oracle.result.options.targets],
    });
    assert.deepEqual(
      manifest.files.map(({ path, mode, sha256, kind, targets }) => ({ path, mode, sha256, kind, targets })),
      oracle.files,
    );
    assert.equal(manifest.projection.id, projectionId);
  }

  for (const item of data.install.commands) {
    assert.match(item.command, / --release-base \.\/dist /);
    assert.doesNotMatch(item.command, /--targets/);
  }
});

test('stale digests are 409 and unknown stage/skill/target are 400 without a build', async (t) => {
  const server = await startWebServer(t);
  const { csrf } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const { ir } = compiledIr();

  const stale = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: {
      r2c: {
        ir: { digest: '0'.repeat(64), id: ir.id, version: ir.version },
        stageOrder: null,
        skills: null,
        targets: null,
      },
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'PROJECTION_OPTIONS_IR_MISMATCH');

  const staleTopLevel = await build(server, csrf, { uploadId: uploaded.uploadId, irDigest: '0'.repeat(64) });
  assert.equal(staleTopLevel.status, 409);
  assert.equal(staleTopLevel.json.error.code, 'PROJECTION_OPTIONS_IR_MISMATCH');

  const badStage = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: { r2c: { stageOrder: ['nope', ...ir.stages.slice(1).map((stage) => stage.id)] } },
  });
  assert.equal(badStage.status, 400);
  assert.equal(badStage.json.error.code, 'PROJECTION_OPTIONS_INVALID');
  assert.match(badStage.json.error.message, /stageOrder/);

  const badSkill = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: { r2c: { skills: ['nope'] } },
  });
  assert.equal(badSkill.status, 400);
  assert.equal(badSkill.json.error.code, 'PROJECTION_OPTIONS_INVALID');
  assert.match(badSkill.json.error.message, /skills/);

  const badTarget = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: { 'agent-native': { targets: ['nope'] } },
  });
  assert.equal(badTarget.status, 400);
  assert.equal(badTarget.json.error.code, 'PROJECTION_TARGET_UNKNOWN');
  assert.equal(badTarget.json.error.details.target, 'nope');

  const badProjection = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: { 'not-a-projection': {} },
  });
  assert.equal(badProjection.status, 400);
  assert.equal(badProjection.json.error.code, 'WEB_OPTIONS_INVALID');

  const unknownUpload = await build(server, csrf, { uploadId: 'ffffffffffffffff' });
  assert.equal(unknownUpload.status, 404);
  assert.equal(unknownUpload.json.error.code, 'WEB_UPLOAD_UNKNOWN');

  const list = await httpRequest({ port: server.port, path: '/api/builds' });
  assert.deepEqual(list.json.data.builds, []);
  const missing = await httpRequest({ port: server.port, path: '/api/builds/ffffffffffffffff/artifacts/install.mjs' });
  assert.equal(missing.status, 404);
});

test('the web never accepts or writes a target project path', async (t) => {
  const server = await startWebServer(t);
  const { csrf } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const target = tempDir(t, 'project');

  for (const payload of [
    { uploadId: uploaded.uploadId, project: target },
    { uploadId: uploaded.uploadId, target: target },
    { uploadId: uploaded.uploadId, options: {}, projectRoot: target },
  ]) {
    const response = await build(server, csrf, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(response.json.error.code, 'WEB_BODY_INVALID');
  }
  assert.deepEqual(readdirSync(target), []);
});

test('token values are stripped from the build child env and never reach logs, responses or assets', async (t) => {
  const secrets = { GH_TOKEN: 'ghp_web_build_secret_A1B2C3', GITHUB_TOKEN: 'ghp_web_build_secret_D4E5F6' };
  const server = await startWebServer(t, secrets);
  const { csrf } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: {} });
  assert.equal(response.status, 200, JSON.stringify(response.json));

  const { buildChildEnv, redactSecrets } = await import('../web/env.js');
  const env = buildChildEnv({ ...process.env, ...secrets, KEEP_ME: '1' });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.KEEP_ME, '1');
  assert.equal(redactSecrets(`ghp ${secrets.GH_TOKEN} ${secrets.GITHUB_TOKEN}`, Object.values(secrets)),
    'ghp [redacted] [redacted]');

  const text = JSON.stringify(response.json);
  const logs = `${server.stdout()}\n${server.stderr()}`;
  for (const secret of Object.values(secrets)) {
    assert.equal(text.includes(secret), false, 'response leaks token');
    assert.equal(logs.includes(secret), false, 'logs leak token');
  }
  for (const asset of response.json.data.artifacts) {
    const download = await httpRequest({ port: server.port, path: asset.url });
    for (const secret of Object.values(secrets)) {
      assert.equal(download.raw.includes(Buffer.from(secret)), false, `${asset.name} leaks token`);
    }
  }
});

test('a crashed, hung or non-JSON child maps to WEB_CHILD_FAILED/TIMEOUT and the server survives', async (t) => {
  const dir = tempDir(t, 'child');
  const secrets = 'ghp_child_secret_XYZ';

  const crash = join(dir, 'crash.mjs');
  writeFileSync(crash, [
    "process.stderr.write('boom ' + (process.env.GH_TOKEN ?? 'missing') + '\\n');",
    "process.stdout.write('not json at all\\n');",
    'process.exit(9);',
    '',
  ].join('\n'));

  const hang = join(dir, 'hang.mjs');
  writeFileSync(hang, 'setInterval(() => {}, 1000);\n');

  for (const [script, extraEnv, code, status] of [
    [crash, { GH_TOKEN: secrets }, 'WEB_CHILD_FAILED', 500],
    [hang, {}, 'WEB_CHILD_TIMEOUT', 504],
  ]) {
    const server = await startWebServer(t, {
      R2C_WEB_RELEASE_SCRIPT: script,
      R2C_WEB_BUILD_TIMEOUT_MS: '400',
      ...extraEnv,
    });
    const { csrf } = await sessionOf(server);
    const uploaded = await upload(server, csrf);
    const started = Date.now();
    const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: {} });
    const elapsed = Date.now() - started;
    assert.equal(response.status, status, JSON.stringify(response.json));
    assert.equal(response.json.error.code, code);
    assert.equal(response.json.data ?? null, null);
    if (code === 'WEB_CHILD_FAILED') {
      assert.match(response.json.error.details.stderr, /boom/);
      assert.equal(response.json.error.details.stderr.includes(secrets), false, 'stderr must be redacted');
      assert.ok(response.json.error.details.stderr.length <= 16 * 1024);
    } else {
      assert.ok(elapsed < 10_000, 'timeout must kill the child promptly');
    }
    const alive = await httpRequest({ port: server.port, path: '/api/session' });
    assert.equal(alive.status, 200, 'server survives a failed build child');
  }
});

test('build endpoints keep the Host/Origin/fetch-site/CSRF/CSP envelope and JSON limit', async (t) => {
  const server = await startWebServer(t);
  const { csrf } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const body = { uploadId: uploaded.uploadId, options: {} };

  const noCsrf = await jsonRequest(server, csrf, '/api/builds', body, { 'X-R2C-CSRF': 'wrong' });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'WEB_CSRF_INVALID');

  const badOrigin = await jsonRequest(server, csrf, '/api/builds', body, { Origin: 'http://evil.example' });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.json.error.code, 'WEB_ORIGIN_INVALID');

  const crossSite = await jsonRequest(server, csrf, '/api/builds', body, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.error.code, 'WEB_FETCH_SITE_INVALID');

  const padded = { uploadId: uploaded.uploadId, options: {}, pad: 'x'.repeat(300 * 1024) };
  const oversized = await jsonRequest(server, csrf, '/api/builds', padded);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, 'WEB_BODY_TOO_LARGE');

  const noLength = await rawRequest(server.port, [
    'POST /api/builds HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    `Origin: ${server.base}`,
    'Sec-Fetch-Site: same-origin',
    `X-R2C-CSRF: ${csrf}`,
    'Content-Type: application/json',
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
  assert.equal(statusOf(noLength), 411);

  const options = await httpRequest({
    port: server.port,
    method: 'OPTIONS',
    path: '/api/builds',
    headers: postHeaders(server, csrf),
  });
  assert.equal(options.status, 405);

  const built = await build(server, csrf, body);
  assert.equal(built.status, 200);
  assert.match(built.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(built.headers['cache-control'], 'no-store');

  // Artifact names are exact members of the build; traversal is 404.
  for (const name of ['../package.json', 'install.mjs/../x', 'nope.tgz']) {
    const response = await httpRequest({
      port: server.port,
      path: `/api/builds/${built.json.data.buildId}/artifacts/${encodeURIComponent(name)}`,
    });
    assert.equal(response.status, 404, name);
  }
});

test('a new upload resets the client binding and the server refuses an old digest', async (t) => {
  const server = await startWebServer(t);
  const { csrf } = await sessionOf(server);
  const first = await upload(server, csrf);
  const second = await upload(server, csrf);
  assert.notEqual(first.uploadId, second.uploadId);
  assert.equal(first.ir.digest, second.ir.digest);

  const built = await build(server, csrf, {
    uploadId: second.uploadId,
    options: {
      r2c: {
        ir: { digest: first.ir.digest, id: first.ir.id, version: first.ir.version },
        stageOrder: null,
        skills: null,
        targets: null,
      },
    },
  });
  assert.equal(built.status, 200, 'same IR bytes keep the binding valid');

  const before = await upload(server, csrf);
  const different = { ...before.ir, digest: 'a'.repeat(64) };
  const stale = await build(server, csrf, {
    uploadId: before.uploadId,
    options: { r2c: { ir: { digest: different.digest, id: different.id, version: different.version } } },
  });
  assert.equal(stale.status, 409);

  // Four uploads max in one session: the oldest is evicted (decision #75 §3.4).
  const extra = [];
  for (let index = 0; index < 4; index += 1) extra.push((await upload(server, csrf)).uploadId);
  const evicted = await build(server, csrf, { uploadId: first.uploadId, options: {} });
  assert.equal(evicted.status, 404);
  assert.equal(evicted.json.error.code, 'WEB_UPLOAD_UNKNOWN');
});
