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
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileBundle } from '../assembler/compile.js';
import { readZip } from '../assembler/zip.js';
import { canonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { sha256Hex } from '../core/node/sha256.js';
import { inflateRaw } from '../core/node/inflate.js';
import { normalizeOptions } from '../projection/options.js';
import { project } from '../projection/project.js';
import { getProjection } from '../projection/registry.js';
import { readReleaseTarGz } from '../installer/release-tar.js';
import { PAYLOAD_MANIFEST_NAME } from '../scripts/lib/bundle-release.mjs';
import { assetZip } from './helpers/minimal-bundle.js';
import { buildZip } from './helpers/zip.js';
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
const COMPILED_WORKFLOW_FIXTURE = join(ROOT, 'test', 'fixtures', 'compiled', 'workflow.compiled.json');
const SAMPLE_SHA256 = 'ff1f3004c618be9d5ee6b090e0d635f6a6c7cb49a8c22e188cc11206bbe37cd4';
const COMPILED_WORKFLOW_DIGEST = '518643ab9c92d270a66bd4545cba660d0511243070c3479234edec3225b6d23c';
const TAG = 'bundle-rtosv3-drvport-v1.0.0';
const ASSETS = [
  'SHA256SUMS.txt',
  'agent-native-rtosv3-drvport-v1.0.0.tgz',
  'bundle-rtosv3-drvport-v1.0.0.zip',
  'hm2b-engine-0.1.0.tgz',
  'hm2b-framework-0.1.0.tgz',
  'hm2b-payload-rtosv3-drvport-v1.0.0.tgz',
  'install.mjs',
  'workflow.compiled.json',
];
const RUNNER_CANONICAL = { files: 45, bytes: 48877, degradations: 4, capabilities: 8, warnings: 0 };
const AGENT_NATIVE_CANONICAL = { files: 98, bytes: 139143, degradations: 45, capabilities: 40, warnings: 1 };

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `hm2b-web-build-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function compiledCompiledWorkflow(bundle = SAMPLE) {
  const bytes = typeof bundle === 'string' ? readFileSync(bundle) : bundle;
  const compiled = compileBundle(new Uint8Array(bytes), { inflateRaw, sha256: sha256Hex }, { path: 'bundle.zip' });
  assert.equal(compiled.ok, true);
  return {
    compiledWorkflow: JSON.parse(Buffer.from(compiled.compiledWorkflowBytes).toString('utf8')),
    compiledWorkflowDigest: compiled.digest,
    compiledWorkflowBytes: Buffer.from(compiled.compiledWorkflowBytes),
  };
}

/** Project with the shared modules: the independent oracle for every number. */
function expected({ projectionId, raw = null, engineVersion, bundle = SAMPLE }) {
  const { compiledWorkflow, compiledWorkflowDigest } = compiledCompiledWorkflow(bundle);
  const manifest = getProjection(projectionId);
  const normalized = normalizeOptions({ projectionId, compiledWorkflow, compiledWorkflowDigest, raw, manifest });
  assert.equal(normalized.ok, true, JSON.stringify(normalized.errors));
  const result = project({
    projectionId,
    compiledWorkflow,
    compiledWorkflowDigest,
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

async function uploadBytes(server, csrf, zip) {
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

async function upload(server, csrf) {
  return uploadBytes(server, csrf, readFileSync(SAMPLE));
}

async function build(server, csrf, payload) {
  return jsonRequest(server, csrf, '/api/builds', payload);
}

/** Run one generated shell chain in `cwd`; the chain is `project && install`. */
function runChain(command, cwd) {
  return spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 180_000, windowsHide: true });
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
  assert.equal(uploaded.report.schema, 'hm2b.bundle/v2');
  assert.equal(uploaded.compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');
  assert.equal(uploaded.compiledWorkflow.digest, COMPILED_WORKFLOW_DIGEST);
  const report = uploaded.report;

  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: {} });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const data = response.json.data;

  assert.match(data.buildId, /^[0-9a-f]{16}$/);
  assert.equal(data.tag, TAG);
  assert.equal(data.compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');
  assert.equal(data.canonical, true);
  assert.equal(data.publishable, true);
  assert.deepEqual(
    { id: data.compiledWorkflow.id, version: data.compiledWorkflow.version, digest: data.compiledWorkflow.digest },
    { id: report.id, version: report.version, digest: COMPILED_WORKFLOW_DIGEST },
  );
  assert.deepEqual(data.projections.map((item) => item.id), ['agent-native', 'runner']);

  const runner = projectionOf(data, 'runner');
  const agentNative = projectionOf(data, 'agent-native');
  const runnerOracle = expected({ projectionId: 'runner', engineVersion });
  const agentOracle = expected({ projectionId: 'agent-native', engineVersion });
  assertMatchesExpected(runner, runnerOracle);
  assertMatchesExpected(agentNative, agentOracle);
  assert.deepEqual(
    { files: runner.counts.files, bytes: runner.counts.bytes, degradations: runner.counts.degradations, capabilities: runner.counts.capabilities },
    { files: RUNNER_CANONICAL.files, bytes: RUNNER_CANONICAL.bytes, degradations: RUNNER_CANONICAL.degradations, capabilities: RUNNER_CANONICAL.capabilities },
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

  // The CLI prints the same contract numbers for the frozen compiled workflow.
  const cli = cliJson(['bin/hm2b-assembler.js', 'project', COMPILED_WORKFLOW_FIXTURE, '--projection', 'runner', '--json']).data;
  assert.deepEqual(runner.files, cli.files);
  assert.deepEqual(runner.capabilityReport, cli.capabilityReport);
  assert.deepEqual(runner.degradations, cli.degradations);
  assert.deepEqual(runner.warnings, cli.warnings);
  assert.deepEqual(runner.coverage, cli.coverage);

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
    ['runner', runnerOracle, 'hm2b-payload-rtosv3-drvport-v1.0.0.tgz'],
    ['agent-native', agentOracle, 'agent-native-rtosv3-drvport-v1.0.0.tgz'],
  ]) {
    const download = await httpRequest({ port: server.port, path: `/api/builds/${data.buildId}/artifacts/${name}` });
    const manifest = payloadManifest(download.raw);
    assert.equal(manifest.projection.id, id);
    assert.equal(manifest.compiledWorkflow.digest, COMPILED_WORKFLOW_DIGEST);
    assert.deepEqual(manifest.options, {
      stageOrder: null,
      skills: null,
      targets: id === 'runner' ? ['runner'] : agentOracle.result.targets,
    });
    assert.deepEqual(
      manifest.files.map(({ path, mode, sha256, kind, targets }) => ({ path, mode, sha256, kind, targets })),
      oracle.files,
    );
  }

  // Fixed-version install commands, never a project write.
  assert.equal(data.install.mode, 'release');
  assert.deepEqual(
    {
      asset: data.install.bootstrap.asset,
      path: data.install.bootstrap.path,
    },
    { asset: 'install.mjs', path: '.hm2b/bootstrap/install.mjs' },
  );
  assert.match(data.install.bootstrap.instruction, /install\.mjs/);
  assert.match(data.install.bootstrap.instruction, /\.hm2b\/bootstrap\/install\.mjs/);
  const commands = data.install.commands;
  const runnerCommand = commands.find((item) => item.projection === 'runner');
  assert.deepEqual(
    { projection: runnerCommand.projection, target: runnerCommand.target, command: runnerCommand.command },
    {
      projection: 'runner',
      target: null,
      command: 'node .hm2b/bootstrap/install.mjs --bundle rtosv3-drvport --version 1.0.0 --projection runner --project .',
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
      /^node \.hm2b\/bootstrap\/install\.mjs --bundle [a-z0-9-]+ --version \d+\.\d+\.\d+ --projection (runner|agent-native)( --target [a-z-]+)? --project \.$/,
    );
    assert.doesNotMatch(item.command, /--release-base/);
  }

  const list = await httpRequest({ port: server.port, path: '/api/builds' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.builds.map((item) => item.buildId), [data.buildId]);
});

test('compiled workflow v2 asset groups are listed in every projection summary without extra web rules', async (t) => {
  const server = await startWebServer(t);
  const { csrf, engineVersion } = await sessionOf(server);
  const zip = assetZip();
  const uploaded = await uploadBytes(server, csrf, zip);
  assert.equal(uploaded.report.ok, true, JSON.stringify(uploaded.report));
  assert.equal(uploaded.compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');

  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: {} });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const data = response.json.data;
  assert.equal(data.compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');

  for (const projectionId of ['runner', 'agent-native']) {
    const projected = projectionOf(data, projectionId);
    const oracle = expected({ projectionId, engineVersion, bundle: zip });
    assertMatchesExpected(projected, oracle);

    // The projection decides the kinds; the web surface only groups and lists them.
    const assetFiles = projected.files.filter((file) => ['knowledge', 'checklist', 'hooks', 'mcp'].includes(file.kind));
    assert.equal(assetFiles.length, 6, `${projectionId} lists every declared asset`);
    assert.deepEqual(
      [...new Set(assetFiles.map((file) => file.kind))].sort(),
      ['checklist', 'hooks', 'knowledge', 'mcp'],
      projectionId,
    );
  }
});

test('custom options build locally, record the actual options and stay unpublishable', async (t) => {
  const server = await startWebServer(t);
  const { csrf, engineVersion } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const { compiledWorkflow } = compiledCompiledWorkflow();
  const skillIds = Object.keys(compiledWorkflow.skills).sort();
  const stageIds = compiledWorkflow.stages.map((stage) => stage.id);
  const twelve = skillIds.slice(0, 12);
  const custom = {
    runner: { stageOrder: [...stageIds].reverse(), skills: twelve, targets: ['runner'] },
    'agent-native': { skills: twelve, targets: ['claude-code', 'codex'] },
  };

  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: custom });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const data = response.json.data;
  assert.equal(data.canonical, false);
  assert.equal(data.publishable, false);
  assert.equal(data.install.mode, 'local');
  assert.equal(data.install.bootstrap, null);
  const runnerCommand = data.install.commands.find((item) => item.projection === 'runner');
  assert.equal(runnerCommand.target, null);
  assert.ok(runnerCommand.command.startsWith('node bin/hm2b-assembler.js project workflow.compiled.json --projection runner '));
  assert.ok(runnerCommand.command.includes(`--stage-order ${[...stageIds].reverse().join(',')} `));
  assert.ok(runnerCommand.command.includes(`--skills ${twelve.join(',')} `));
  assert.ok(runnerCommand.command.endsWith(
    '--result .hm2b/build/runner && node installer/cli.js --result .hm2b/build/runner --compiled-workflow workflow.compiled.json --project .',
  ));
  const agentAll = data.install.commands.find((item) => item.projection === 'agent-native' && item.target === null);
  assert.ok(agentAll.command.includes('--target claude-code --target codex'));
  const agentTargets = data.install.commands.filter((item) => item.projection === 'agent-native' && item.target !== null);
  for (const target of ['claude-code', 'codex']) {
    const item = agentTargets.find((entry) => entry.target === target);
    assert.ok(item, target);
    assert.ok(item.command.includes(`--target ${target} `));
    assert.ok(item.command.includes(`--result .hm2b/build/agent-native-${target} && `));
    assert.ok(item.command.endsWith(`--result .hm2b/build/agent-native-${target} --compiled-workflow workflow.compiled.json --project .`));
  }
  for (const item of data.install.commands) {
    assert.doesNotMatch(item.command, /--release-base/);
    assert.doesNotMatch(item.command, /\.hm2b\/bootstrap\/install\.mjs/);
    assert.match(
      item.command,
      /^node bin\/hm2b-assembler\.js project workflow\.compiled\.json --projection (runner|agent-native)(?: --target [a-z-]+)* --stage-order [a-z0-9,-]+ --skills [a-z0-9,-]+ --result \.hm2b\/build\/[a-z-]+ && node installer\/cli\.js --result \.hm2b\/build\/[a-z-]+ --compiled-workflow workflow\.compiled\.json --project \.$/,
    );
  }
  const runner = projectionOf(data, 'runner');
  const agentNative = projectionOf(data, 'agent-native');
  const runnerOracle = expected({ projectionId: 'runner', raw: custom.runner, engineVersion });
  const agentOracle = expected({ projectionId: 'agent-native', raw: custom['agent-native'], engineVersion });
  assertMatchesExpected(runner, runnerOracle);
  assertMatchesExpected(agentNative, agentOracle);
  // The frozen K=12 anchor is agent-native with every target selected.
  const twelveSkills = expected({ projectionId: 'agent-native', raw: { skills: twelve }, engineVersion });
  assert.equal(twelveSkills.counts.files, 52, 'K=12 anchor');
  assert.deepEqual(runner.options.stageOrder, [...stageIds].reverse());
  assert.deepEqual(runner.options.skills, twelve);
  assert.deepEqual(agentNative.targets, ['claude-code', 'codex']);

  // The asset table is unchanged; only the recorded options differ.
  assert.deepEqual(data.artifacts.map((asset) => asset.name), ASSETS);
  for (const [name, oracle, projectionId] of [
    ['hm2b-payload-rtosv3-drvport-v1.0.0.tgz', runnerOracle, 'runner'],
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
});

test('a custom build chain re-projects the downloaded compiled workflow and installs the result', async (t) => {
  const server = await startWebServer(t);
  const { csrf } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const { compiledWorkflow } = compiledCompiledWorkflow();
  const skillIds = Object.keys(compiledWorkflow.skills).sort();
  const stageIds = compiledWorkflow.stages.map((stage) => stage.id);
  const twelve = skillIds.slice(0, 12);
  const custom = {
    runner: { stageOrder: [...stageIds].reverse(), skills: twelve, targets: ['runner'] },
    'agent-native': { skills: twelve, targets: ['claude-code'] },
  };

  const response = await build(server, csrf, { uploadId: uploaded.uploadId, options: custom });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  const data = response.json.data;
  assert.equal(data.install.mode, 'local');

  // The chain runs from the framework source, against the downloaded compiled workflow.
  const root = copyFramework(t);
  const compiledWorkflowAsset = data.artifacts.find((asset) => asset.name === 'workflow.compiled.json');
  const download = await httpRequest({ port: server.port, path: compiledWorkflowAsset.url });
  assert.equal(download.status, 200);
  writeFileSync(join(root, 'workflow.compiled.json'), download.raw);

  for (const [projectionId, target] of [['runner', null], ['agent-native', 'claude-code']]) {
    const item = data.install.commands.find((entry) => entry.projection === projectionId && entry.target === target);
    assert.ok(item, `${projectionId}/${String(target)}`);
    const run = runChain(item.command, root);
    assert.equal(run.status, 0, `${item.command}\n${run.stdout}\n${run.stderr}`);

    const resultDir = join(root, '.hm2b', 'build', target === null ? projectionId : `${projectionId}-${target}`);
    const written = JSON.parse(readFileSync(join(resultDir, 'projection-result.json'), 'utf8'));
    assert.equal(written.schema, 'hm2b.projection-result/v1');
    assert.equal(written.projection.id, projectionId);
    assert.deepEqual(written.options.skills, twelve);
    assert.deepEqual(written.targets, target === null ? ['runner'] : [target]);
    assert.equal(existsSync(join(resultDir, 'workflow.compiled.json')), true);
    assert.equal(
      readFileSync(join(resultDir, 'workflow.compiled.json')).equals(Buffer.from(download.raw)),
      true,
      'the result directory carries the downloaded compiled workflow bytes',
    );

    const receiptPath = join(root, '.hm2b', 'install', 'receipts', projectionId, 'rtosv3-drvport.json');
    assert.equal(existsSync(receiptPath), true, `missing receipt ${receiptPath}`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.bundle.id, 'rtosv3-drvport');
    assert.equal(receipt.projection.id, projectionId);
    if (target === null) {
      assert.deepEqual(receipt.projection.targets, written.targets);
    } else {
      assert.deepEqual(receipt.projection.targets, [target]);
    }
  }
});

test('the build concurrency slot is reserved before the first await', async (t) => {
  const dir = tempDir(t, 'busy');
  const hang = join(dir, 'hang.mjs');
  writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
  const server = await startWebServer(t, {
    HM2B_WEB_RELEASE_SCRIPT: hang,
    HM2B_WEB_BUILD_TIMEOUT_MS: '800',
  });
  const { csrf } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const payload = { uploadId: uploaded.uploadId, options: {} };

  const responses = await Promise.all([
    build(server, csrf, payload),
    build(server, csrf, payload),
    build(server, csrf, payload),
  ]);
  const statuses = responses.map((item) => item.status).sort((left, right) => left - right);
  assert.deepEqual(statuses, [409, 504, 504]);
  const busy = responses.find((item) => item.status === 409);
  assert.equal(busy.json.error.code, 'WEB_BUILD_BUSY');

  // The two losers time out; the slot must be free again afterwards.
  const after = await build(server, csrf, payload);
  assert.equal(after.status, 504, JSON.stringify(after.json));
  assert.equal(after.json.error.code, 'WEB_CHILD_TIMEOUT');
});

test('stale digests are 409 and unknown stage/skill/target are 400 without a build', async (t) => {
  const server = await startWebServer(t);
  const { csrf } = await sessionOf(server);
  const uploaded = await upload(server, csrf);
  const { compiledWorkflow } = compiledCompiledWorkflow();

  const stale = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: {
      runner: {
        compiledWorkflow: { digest: '0'.repeat(64), id: compiledWorkflow.id, version: compiledWorkflow.version },
        stageOrder: null,
        skills: null,
        targets: null,
      },
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'PROJECTION_OPTIONS_COMPILED_WORKFLOW_MISMATCH');

  const staleTopLevel = await build(server, csrf, { uploadId: uploaded.uploadId, compiledWorkflowDigest: '0'.repeat(64) });
  assert.equal(staleTopLevel.status, 409);
  assert.equal(staleTopLevel.json.error.code, 'PROJECTION_OPTIONS_COMPILED_WORKFLOW_MISMATCH');

  const badStage = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: { runner: { stageOrder: ['nope', ...compiledWorkflow.stages.slice(1).map((stage) => stage.id)] } },
  });
  assert.equal(badStage.status, 400);
  assert.equal(badStage.json.error.code, 'PROJECTION_OPTIONS_INVALID');
  assert.match(badStage.json.error.message, /stageOrder/);

  const badSkill = await build(server, csrf, {
    uploadId: uploaded.uploadId,
    options: { runner: { skills: ['nope'] } },
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
      HM2B_WEB_RELEASE_SCRIPT: script,
      HM2B_WEB_BUILD_TIMEOUT_MS: '400',
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

  const noCsrf = await jsonRequest(server, csrf, '/api/builds', body, { 'X-HM2B-CSRF': 'wrong' });
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
    `X-HM2B-CSRF: ${csrf}`,
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
  assert.equal(first.compiledWorkflow.digest, second.compiledWorkflow.digest);

  const built = await build(server, csrf, {
    uploadId: second.uploadId,
    options: {
      runner: {
        compiledWorkflow: { digest: first.compiledWorkflow.digest, id: first.compiledWorkflow.id, version: first.compiledWorkflow.version },
        stageOrder: null,
        skills: null,
        targets: null,
      },
    },
  });
  assert.equal(built.status, 200, 'same compiled workflow bytes keep the binding valid');

  const before = await upload(server, csrf);
  const different = { ...before.compiledWorkflow, digest: 'a'.repeat(64) };
  const stale = await build(server, csrf, {
    uploadId: before.uploadId,
    options: { runner: { compiledWorkflow: { digest: different.digest, id: different.id, version: different.version } } },
  });
  assert.equal(stale.status, 409);

  // Four uploads max in one session: the oldest is evicted (decision #75 §3.4).
  const extra = [];
  for (let index = 0; index < 4; index += 1) extra.push((await upload(server, csrf)).uploadId);
  const evicted = await build(server, csrf, { uploadId: first.uploadId, options: {} });
  assert.equal(evicted.status, 404);
  assert.equal(evicted.json.error.code, 'WEB_UPLOAD_UNKNOWN');
});

/* -------------------------------------------------------------------------- */
/* requires.engine: engine version, not framework version                     */
/* -------------------------------------------------------------------------- */

/** Copy the framework tree (including the linked yaml dependency) so versions can differ. */
function copyFramework(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-web-engine-'));
  t.after(async () => {
    // Windows keeps the directory busy for a moment after the server exits.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  cpSync(ROOT, dir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const top = src.slice(ROOT.length).replace(/^[\\/]/, '').split(/[\\/]/, 1)[0];
      return top !== '.git' && top !== '.scratch';
    },
  });
  const rootPackage = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  rootPackage.version = '9.9.9';
  writeFileSync(join(dir, 'package.json'), canonicalJson(rootPackage));
  return dir;
}

async function stopServer(server) {
  const { child } = server;
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') child.stdin.write('shutdown\n');
  else child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveKill) => setTimeout(resolveKill, 8000)).then(() => child.kill('SIGKILL')),
  ]);
}

async function startServerAt(t, root, env = {}) {
  const child = spawn(process.execPath, [join(root, 'web', 'serve.mjs')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error(`server did not start: ${stdout}${stderr}`)), 15_000);
    child.stdout.on('data', () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`server exited ${code}: ${stderr}`));
    });
  });
  const server = {
    child,
    url,
    base: url.replace(/\/$/, ''),
    port: Number(new URL(url).port),
    stdout: () => stdout,
    stderr: () => stderr,
  };
  t.after(async () => stopServer(server));
  return server;
}

/** The sample bundle with `requires.engine` added to its manifest. */
function bundleWithEngineRange(range) {
  const original = readZip(new Uint8Array(readFileSync(SAMPLE)), { inflateRaw });
  assert.equal(original.ok, true, JSON.stringify(original.diagnostics));
  const entries = [...original.entries.entries()].map(([path, entry]) => {
    let bytes = Buffer.from(entry.data);
    if (path === 'bundle.json') {
      const manifest = JSON.parse(bytes.toString('utf8'));
      manifest.requires = { engine: range };
      bytes = Buffer.from(canonicalJson(manifest), 'utf8');
    }
    return [path, bytes];
  });
  entries.sort(([left], [right]) => compareCodePoints(left, right));
  return buildZip(entries);
}

test('requires.engine is checked against the engine version, never the framework version', async (t) => {
  const root = copyFramework(t);
  const engineVersion = JSON.parse(readFileSync(join(root, 'runtime', 'runner', 'engine', 'package.json'), 'utf8')).version;
  assert.equal(engineVersion, '0.1.0');
  assert.notEqual(engineVersion, '9.9.9');

  const server = await startServerAt(t, root);
  try {
    const session = await sessionOf(server);
    assert.equal(session.frameworkVersion, '9.9.9');
    assert.equal(session.engineVersion, engineVersion);

    // `^0.1.0` satisfies only the engine, not the framework that hosts it.
    const satisfied = await uploadBytes(server, session.csrf, bundleWithEngineRange('^0.1.0'));
    assert.equal(satisfied.report.ok, true, JSON.stringify(satisfied.report));
    const built = await build(server, session.csrf, { uploadId: satisfied.uploadId, options: {} });
    assert.equal(built.status, 200, JSON.stringify(built.json));
    assert.equal(built.json.data.engineVersion, engineVersion);
    assert.equal(built.json.data.canonical, true);

    // `^9.0.0` satisfies only the framework: the build must be refused before
    // any child starts, with the release's stable code.
    const unsatisfied = await uploadBytes(server, session.csrf, bundleWithEngineRange('^9.0.0'));
    assert.equal(unsatisfied.report.ok, true, JSON.stringify(unsatisfied.report));
    const refused = await build(server, session.csrf, { uploadId: unsatisfied.uploadId, options: {} });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json.error.code, 'PROJECTION_ENGINE_UNSATISFIED');
    assert.match(refused.json.error.message, /\^9\.0\.0/);
    const list = await httpRequest({ port: server.port, path: '/api/builds' });
    assert.deepEqual(list.json.data.builds.map((item) => item.buildId), [built.json.data.buildId]);
  } finally {
    await stopServer(server);
  }
});
