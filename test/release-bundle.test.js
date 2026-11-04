/**
 * Per-bundle Release: deterministic assets and pre-projected payloads (#105).
 *
 * The sample bundle is the regression oracle. Everything here runs offline in
 * temp dirs: build → check → tamper, plus the pure tag/asset matrices that
 * decide what a Release may contain.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { sha256Hex } from '../core/node/sha256.js';
import {
  BUNDLE_MAKE_LATEST,
  COMPILED_WORKFLOW_ASSET,
  INSTALL_ASSET,
  PAYLOAD_FILE_KINDS,
  PAYLOAD_MANIFEST_NAME,
  RELEASE_PAYLOAD_SCHEMA,
  SUMS_ASSET,
  buildBundleRelease,
  bundleAssetNames,
  bundleTag,
  checkBundleRelease,
  collectFramework,
  frameworkSourceProblems,
  isLegacyEngineTag,
  parseBundleTag,
  verifyPayloadArchive,
} from '../scripts/lib/bundle-release.mjs';
import { createReleaseTarGz, readReleaseTarGz } from '../installer/release-tar.js';
import {
  ASSET_CHECKLISTS,
  ASSET_HOOKS,
  ASSET_KNOWLEDGE_BASE,
  ASSET_MCP,
  assetZip,
} from './helpers/minimal-bundle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'release.mjs');
const SAMPLE_ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const SAMPLE_DIR = join(ROOT, 'examples/rtosv3/bundle');
const ID = 'rtosv3-drvport';
const VERSION = '1.0.0';
const TAG = 'bundle-rtosv3-drvport-v1.0.0';
const SAMPLE_ASSETS = [
  'SHA256SUMS.txt',
  'agent-native-rtosv3-drvport-v1.0.0.tgz',
  'bundle-rtosv3-drvport-v1.0.0.zip',
  'hm2b-engine-0.1.0.tgz',
  'hm2b-framework-0.1.0.tgz',
  'hm2b-payload-rtosv3-drvport-v1.0.0.tgz',
  'install.mjs',
  'workflow.compiled.json',
];

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `hm2b-bundle-release-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runRelease(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function buildTo(t, prefix = 'out', extra = []) {
  const out = tempDir(t, prefix);
  const result = runRelease(['--bundle', SAMPLE_ZIP, '--out', out, ...extra]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return out;
}

function assetNames(dir) {
  return readdirSync(dir).sort(compareCodePoints);
}

function parseSums(text) {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      assert.notEqual(match, null, `malformed sums line: ${line}`);
      return { digest: match[1], name: match[2] };
    });
}

function readPayload(bytes, name) {
  const { entries, problems } = readReleaseTarGz(bytes);
  assert.deepEqual(problems, []);
  const manifestEntry = entries.find((entry) => entry.path === PAYLOAD_MANIFEST_NAME);
  assert.ok(manifestEntry, `${name} has no ${PAYLOAD_MANIFEST_NAME}`);
  return {
    entries,
    manifest: JSON.parse(Buffer.from(manifestEntry.data).toString('utf8')),
    byPath: new Map(entries.map((entry) => [entry.path, entry])),
  };
}

function payloadArchive(dir, name) {
  return readPayload(readFileSync(join(dir, name)), name);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function copySampleBundle(t, projections) {
  const dir = tempDir(t, 'bundle');
  cpSync(SAMPLE_DIR, dir, { recursive: true });
  const file = join(dir, 'bundle.json');
  const manifest = readJson(file);
  manifest.requires = { ...(manifest.requires ?? {}), projections };
  writeFileSync(file, canonicalJson(manifest));
  return dir;
}

test('bundle tags parse right-to-left with the known id and reject near misses', () => {
  assert.deepEqual(parseBundleTag(TAG, ID), { id: ID, version: VERSION });
  assert.deepEqual(parseBundleTag('bundle-a-b-v1.2.3-rc.1', 'a-b'), {
    id: 'a-b',
    version: '1.2.3-rc.1',
  });
  // An id that ends in `-v` is exactly the case `split('-v')` gets wrong.
  assert.deepEqual(parseBundleTag('bundle-a-v-v2.0.0', 'a-v'), { id: 'a-v', version: '2.0.0' });
  assert.deepEqual(parseBundleTag('bundle-rtosv3-drvport-extra-v1.0.0', 'rtosv3-drvport-extra'), {
    id: 'rtosv3-drvport-extra',
    version: VERSION,
  });

  for (const bad of [
    'bundle-rtosv3-drvport-extra-v1.0.0',
    'bundle-rtosv3-drvport-v1.0',
    'bundle-rtosv3-drvport-v1.0.0.0',
    'bundle-rtosv3-drvport-v01.0.0',
    'bundle-rtosv3-drvport-v1.0.0+build.5',
    'bundle-rtosv3-drvport-v1.0.0-',
    'bundle-rtosv3-drvport-1.0.0',
    'prefix-bundle-rtosv3-drvport-v1.0.0',
    'BUNDLE-rtosv3-drvport-v1.0.0',
    'v1.0.0',
    '',
  ]) {
    assert.equal(parseBundleTag(bad, ID), null, `${bad} must not parse`);
  }
  assert.equal(parseBundleTag(TAG, 'rtosv3'), null);
  assert.equal(parseBundleTag(TAG, ''), null);
  assert.equal(parseBundleTag(TAG, 'Rtosv3'), null);
  assert.equal(parseBundleTag(null, ID), null);

  assert.equal(isLegacyEngineTag('v1.0.0'), true);
  assert.equal(isLegacyEngineTag('v1.0.0-rc.1'), true);
  assert.equal(isLegacyEngineTag(TAG), false);
  assert.equal(isLegacyEngineTag('v1.0.0+build'), false);
  assert.equal(isLegacyEngineTag('v01.0.0'), false);
});

test('the asset matrix follows requires.projections and never emits legacy assets', () => {
  const runner = bundleAssetNames({
    id: 'x',
    version: '1.0.0',
    allowed: ['runner'],
    engineVersion: '0.2.0',
    frameworkVersion: '0.3.0',
  });
  assert.deepEqual(runner, [
    'SHA256SUMS.txt',
    'bundle-x-v1.0.0.zip',
    'hm2b-engine-0.2.0.tgz',
    'hm2b-framework-0.3.0.tgz',
    'hm2b-payload-x-v1.0.0.tgz',
    'install.mjs',
    'workflow.compiled.json',
  ]);

  const agent = bundleAssetNames({
    id: 'x',
    version: '1.0.0',
    allowed: ['agent-native'],
    engineVersion: '0.2.0',
    frameworkVersion: '0.3.0',
  });
  assert.deepEqual(agent, [
    'SHA256SUMS.txt',
    'agent-native-x-v1.0.0.tgz',
    'bundle-x-v1.0.0.zip',
    'hm2b-framework-0.3.0.tgz',
    'install.mjs',
    'workflow.compiled.json',
  ]);

  const both = bundleAssetNames({
    id: 'x',
    version: '1.0.0',
    allowed: ['runner', 'agent-native'],
    engineVersion: '0.2.0',
    frameworkVersion: '0.3.0',
  });
  assert.equal(both.length, 8);
  for (const name of [...runner, ...agent, ...both]) {
    assert.doesNotMatch(name, /^r2c-/, 'legacy channel name leaked');
    assert.notEqual(name, 'projection-result.json');
  }
  assert.equal(bundleTag(ID, VERSION), TAG);
  assert.equal(BUNDLE_MAKE_LATEST, false);
});

test('the sample bundle builds all eight assets with frozen zip and compiled workflow anchors', () => {
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE_ZIP, tag: TAG });
  assert.deepEqual(built.failures, []);
  assert.equal(built.ok, true);
  assert.equal(built.id, ID);
  assert.equal(built.version, VERSION);
  assert.deepEqual(built.allowed, ['runner', 'agent-native']);
  assert.deepEqual(built.assets.map((asset) => asset.name), SAMPLE_ASSETS);
  assert.deepEqual(built.plan.assets.map((asset) => asset.name), SAMPLE_ASSETS);
  assert.equal(built.plan.tag, TAG);
  assert.equal(built.plan.makeLatest, false);
  assert.equal(built.plan.prerelease, false);

  const zip = built.assets.find((asset) => asset.name === `bundle-${ID}-v${VERSION}.zip`);
  assert.equal(zip.data.length, 55043);
  assert.equal(sha256Hex(zip.data), 'ff1f3004c618be9d5ee6b090e0d635f6a6c7cb49a8c22e188cc11206bbe37cd4');
  assert.ok(zip.data.equals(readFileSync(SAMPLE_ZIP)));

  const compiledWorkflow = built.assets.find((asset) => asset.name === COMPILED_WORKFLOW_ASSET);
  assert.equal(compiledWorkflow.data.length, 58919);
  assert.equal(sha256Hex(compiledWorkflow.data), '518643ab9c92d270a66bd4545cba660d0511243070c3479234edec3225b6d23c');
  assert.equal(built.compiledWorkflowDigest, sha256Hex(compiledWorkflow.data));
  assert.equal(built.compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');
  assert.equal(built.compiledWorkflow.source.bundle.schema, 'hm2b.bundle/v2');
  assert.equal(built.compiledWorkflow.source.bundle.contentSha256, '2093b03b97c90c6e77dfeb26c69d585ef78a11170032151171c31272ac7dbbf2');
  assert.equal(built.compiledWorkflow.source.manifest.sha256, '6f92d763fb82cd00d36f99e8dc42ba26f0a510c4b64bd9d741e2625bec68df84');
  assert.deepEqual(built.compiledWorkflow.knowledgeBase, []);
  assert.deepEqual(built.compiledWorkflow.checklists, []);
  assert.equal(built.compiledWorkflow.hooks, null);
  assert.equal(built.compiledWorkflow.mcp, null);

  for (const asset of built.assets) {
    assert.ok(asset.data.length > 0, `${asset.name} is empty`);
    const planned = built.plan.assets.find((entry) => entry.name === asset.name);
    assert.equal(planned.size, asset.data.length);
    assert.equal(planned.sha256, sha256Hex(asset.data));
  }

  const install = built.assets.find((asset) => asset.name === INSTALL_ASSET);
  assert.ok(install.data.equals(readFileSync(join(ROOT, 'scripts/install.mjs'))));

  const sums = parseSums(built.assets.find((asset) => asset.name === SUMS_ASSET).data.toString('utf8'));
  const covered = built.assets
    .filter((asset) => asset.name !== SUMS_ASSET)
    .map((asset) => ({ name: asset.name, digest: sha256Hex(asset.data) }))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  assert.deepEqual(sums, covered);
  assert.deepEqual(sums.map((line) => line.name), [...sums.map((line) => line.name)].sort(compareCodePoints));
});

test('payload manifests self-prove every member, mode, kind and target', () => {
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE_ZIP });
  assert.equal(built.ok, true);

  const expected = new Map([
    ['runner', { file: 'hm2b-payload-rtosv3-drvport-v1.0.0.tgz', count: 45, targets: ['runner'] }],
    [
      'agent-native',
      {
        file: 'agent-native-rtosv3-drvport-v1.0.0.tgz',
        count: 98,
        targets: ['claude-code', 'codex', 'dsh', 'omp', 'opencode'],
      },
    ],
  ]);
  for (const [projectionId, want] of expected) {
    const payload = built.payloads.get(projectionId);
    assert.equal(payload.file, want.file);
    assert.equal(payload.data.readUInt32LE(4), 0, 'gzip MTIME must be zero');
    assert.equal(payload.manifest.schema, RELEASE_PAYLOAD_SCHEMA);
    assert.deepEqual(payload.manifest.bundle, { id: ID, version: VERSION });
    assert.equal(payload.manifest.compiledWorkflow.digest, built.compiledWorkflowDigest);
    assert.equal(payload.manifest.compiledWorkflow.contentSha256, built.compiledWorkflow.source.bundle.contentSha256);
    assert.equal(payload.manifest.projection.id, projectionId);
    assert.match(payload.manifest.projection.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(payload.manifest.options, {
      stageOrder: null,
      skills: null,
      targets: want.targets,
    });
    assert.deepEqual(payload.manifest.targets, want.targets);
    assert.equal(payload.manifest.files.length, want.count);
    assert.deepEqual(payload.manifest.files.map((file) => file.path), [...payload.manifest.files.map((file) => file.path)].sort(compareCodePoints));

    const archive = readPayload(payload.data, payload.file);
    // The in-memory archive is what the Release ships; compare member set.
    const members = archive.entries.map((entry) => entry.path).sort(compareCodePoints);
    assert.deepEqual(
      members,
      [PAYLOAD_MANIFEST_NAME, ...payload.manifest.files.map((file) => `files/${file.path}`)].sort(compareCodePoints),
    );
    assert.deepEqual(verifyPayloadArchive(payload.data, {
      id: ID,
      version: VERSION,
      compiledWorkflowDigest: built.compiledWorkflowDigest,
      contentSha256: built.compiledWorkflow.source.bundle.contentSha256,
      projectionId,
      options: payload.manifest.options,
      targets: payload.manifest.targets,
    }), []);
    for (const file of payload.manifest.files) {
      assert.ok(file.mode === 0o644 || file.mode === 0o755);
      assert.ok(PAYLOAD_FILE_KINDS.includes(file.kind), `${file.path}: ${file.kind}`);
      assert.ok(file.targets.length > 0);
      const member = archive.byPath.get(`files/${file.path}`);
      assert.equal(sha256Hex(Buffer.from(member.data)), file.sha256);
      assert.equal(member.mode, file.mode);
    }
  }
});

test('a compiled workflow with assets ships knowledge, checklist, hooks and mcp payload members', (t) => {
  const zipFile = join(tempDir(t, 'asset-zip'), 'bundle-minimal-demo-v1.0.0.zip');
  writeFileSync(zipFile, assetZip());
  const built = buildBundleRelease({ root: ROOT, bundlePath: zipFile });
  assert.deepEqual(built.failures, []);
  assert.equal(built.ok, true);
  assert.equal(built.id, 'minimal-demo');
  assert.equal(built.version, '1.0.0');
  assert.equal(built.compiledWorkflow.schema, 'hm2b.compiled-workflow/v2');
  assert.equal(built.compiledWorkflow.knowledgeBase.length, 2);
  assert.equal(built.compiledWorkflow.checklists.length, 2);
  assert.notEqual(built.compiledWorkflow.hooks, null);
  assert.notEqual(built.compiledWorkflow.mcp, null);

  const digest = (text) => sha256Hex(Buffer.from(text, 'utf8'));
  const expected = {
    knowledge: [...ASSET_KNOWLEDGE_BASE.values()].map(digest),
    checklist: [...ASSET_CHECKLISTS.values()].map(digest),
    hooks: [digest(canonicalJson(ASSET_HOOKS))],
    mcp: [digest(canonicalJson(ASSET_MCP))],
  };
  for (const [projectionId, payload] of built.payloads) {
    for (const [kind, digests] of Object.entries(expected)) {
      const members = payload.manifest.files.filter((file) => file.kind === kind);
      assert.deepEqual(
        members.map((file) => file.sha256).sort(compareCodePoints),
        [...digests].sort(compareCodePoints),
        `${projectionId}: ${kind} members`,
      );
      for (const file of members) {
        assert.ok(file.targets.length > 0);
        for (const target of file.targets) assert.ok(payload.manifest.targets.includes(target));
      }
    }
    // The archive really carries the declared bytes, not just the manifest.
    const archive = readPayload(payload.data, payload.file);
    for (const file of payload.manifest.files.filter((item) => item.kind in expected)) {
      const member = archive.byPath.get(`files/${file.path}`);
      assert.notEqual(member, undefined, `${projectionId}: ${file.path}`);
      assert.equal(sha256Hex(Buffer.from(member.data)), file.sha256);
    }
  }
});

test('a payload member with an unknown kind fails self-proof', () => {
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE_ZIP });
  const payload = built.payloads.get('runner');
  const { entries } = readReleaseTarGz(payload.data);
  const manifest = JSON.parse(JSON.stringify(payload.manifest));
  manifest.files[0].kind = 'bogus';
  const tampered = createReleaseTarGz(entries.map((entry) => (entry.path === PAYLOAD_MANIFEST_NAME
    ? { path: entry.path, data: Buffer.from(canonicalJson(manifest), 'utf8'), mode: entry.mode }
    : { path: entry.path, data: entry.data, mode: entry.mode })));
  const problems = verifyPayloadArchive(tampered, {
    id: ID,
    version: VERSION,
    compiledWorkflowDigest: built.compiledWorkflowDigest,
    contentSha256: built.compiledWorkflow.source.bundle.contentSha256,
    projectionId: 'runner',
    options: payload.manifest.options,
    targets: payload.manifest.targets,
  });
  assert.ok(problems.some((problem) => /kind bogus is not a known file kind/.test(problem)), problems.join('\n'));
});

test('a payload member the manifest does not declare fails self-proof', () => {
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE_ZIP });
  const payload = built.payloads.get('runner');
  const { entries } = readReleaseTarGz(payload.data);
  const tampered = createReleaseTarGz([
    ...entries.map((entry) => ({ path: entry.path, data: entry.data, mode: entry.mode })),
    { path: 'files/rogue.txt', data: Buffer.from('rogue\n', 'utf8'), mode: 0o644 },
  ]);
  const problems = verifyPayloadArchive(tampered, {
    id: ID,
    version: VERSION,
    compiledWorkflowDigest: built.compiledWorkflowDigest,
    contentSha256: built.compiledWorkflow.source.bundle.contentSha256,
    projectionId: 'runner',
    options: payload.manifest.options,
    targets: payload.manifest.targets,
  });
  assert.ok(problems.some((problem) => /payload member is not declared: files\/rogue\.txt/.test(problem)), problems.join('\n'));
  assert.ok(problems.some((problem) => /member count/.test(problem)), problems.join('\n'));
});

test('the CLI writes byte-identical assets twice and --check verifies the directory', (t) => {
  const first = buildTo(t, 'first', ['--tag', TAG]);
  const second = buildTo(t, 'second', ['--tag', TAG]);
  assert.deepEqual(assetNames(first), SAMPLE_ASSETS);
  assert.deepEqual(assetNames(second), SAMPLE_ASSETS);
  for (const name of SAMPLE_ASSETS) {
    assert.ok(
      readFileSync(join(first, name)).equals(readFileSync(join(second, name))),
      `${name} is not byte-identical across two runs`,
    );
  }

  const ok = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--out', first, '--tag', TAG]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /bundle release --check ok: bundle-rtosv3-drvport-v1\.0\.0, 8 assets, make_latest=false/);

  // The bundle directory form rebuilds the zip and must match the committed one.
  const fromDir = tempDir(t, 'dir');
  const dirBuild = runRelease(['--bundle', SAMPLE_DIR, '--out', fromDir]);
  assert.equal(dirBuild.status, 0, dirBuild.stderr);
  assert.ok(
    readFileSync(join(fromDir, `bundle-${ID}-v${VERSION}.zip`)).equals(readFileSync(SAMPLE_ZIP)),
  );
});

test('--check rejects a tag that disagrees with zip/compiled workflow and a legacy tag', (t) => {
  const wrongVersion = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--tag', 'bundle-rtosv3-drvport-v1.0.1']);
  assert.equal(wrongVersion.status, 1, wrongVersion.stdout);
  assert.match(wrongVersion.stderr, /RELEASE_TAG_MISMATCH/);
  assert.match(wrongVersion.stderr, /1\.0\.1/);

  const wrongId = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--tag', 'bundle-other-v1.0.0']);
  assert.equal(wrongId.status, 1, wrongId.stdout);
  assert.match(wrongId.stderr, /RELEASE_TAG_MISMATCH/);

  const legacy = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--tag', 'v1.0.0']);
  assert.equal(legacy.status, 1, legacy.stdout);
  assert.match(legacy.stderr, /RELEASE_TAG_MISMATCH/);

  const buildMismatch = runRelease(['--bundle', SAMPLE_ZIP, '--out', tempDir(t, 'mismatch'), '--tag', 'bundle-rtosv3-drvport-v1.0.1']);
  assert.equal(buildMismatch.status, 1);
  assert.match(buildMismatch.stderr, /RELEASE_TAG_MISMATCH/);
});

test('--check fails for tampered assets, missing assets and legacy channel leakage', (t) => {
  const out = buildTo(t, 'tamper');

  writeFileSync(join(out, COMPILED_WORKFLOW_ASSET), `${readFileSync(join(out, COMPILED_WORKFLOW_ASSET), 'utf8')} `);
  let result = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--out', out]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /workflow\.compiled\.json in .* is not byte-identical/);

  rmSync(join(out, COMPILED_WORKFLOW_ASSET));
  result = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--out', out]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RELEASE_ASSET_SET_MISMATCH.*missing \[workflow\.compiled\.json\]/);

  const fresh = buildTo(t, 'leak');
  writeFileSync(join(fresh, 'r2c-payload-0.1.0.tgz'), 'legacy');
  result = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--out', fresh]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /r2c-payload-0\.1\.0\.tgz is a legacy channel payload/);
  assert.match(result.stderr, /RELEASE_ASSET_SET_MISMATCH/);

  const reordered = buildTo(t, 'sums');
  const lines = readFileSync(join(reordered, SUMS_ASSET), 'utf8').split('\n').filter(Boolean).reverse();
  writeFileSync(join(reordered, SUMS_ASSET), `${lines.join('\n')}\n`);
  result = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--out', reordered]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SHA256SUMS\.txt is not the sorted digest list/);

  const installTamper = buildTo(t, 'install');
  writeFileSync(join(installTamper, INSTALL_ASSET), `${readFileSync(join(installTamper, INSTALL_ASSET), 'utf8')}\n// hand edit\n`);
  result = runRelease(['--bundle', SAMPLE_ZIP, '--check', '--out', installTamper]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install\.mjs in .* is not byte-identical to scripts\/install\.mjs/);
});

test('a tampered payload archive fails manifest self-proof', () => {
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE_ZIP });
  const payload = built.payloads.get('runner');
  const { entries } = readReleaseTarGz(payload.data);
  const tampered = createReleaseTarGz(
    entries.map((entry) => (entry.path === 'files/workflows/rtosv3-drvport.yaml'
      ? { path: entry.path, data: Buffer.from('schema: "hm2b.workflow/v1"\n'), mode: entry.mode }
      : { path: entry.path, data: entry.data, mode: entry.mode })),
  );
  const problems = verifyPayloadArchive(tampered, {
    id: ID,
    version: VERSION,
    compiledWorkflowDigest: built.compiledWorkflowDigest,
    contentSha256: built.compiledWorkflow.source.bundle.contentSha256,
    projectionId: 'runner',
    options: payload.manifest.options,
    targets: payload.manifest.targets,
  });
  assert.ok(problems.some((problem) => /hash does not match/.test(problem)), problems.join('\n'));
});

test('runner-only and agent-native-only bundles produce the conditional asset sets', (t) => {
  const runnerBundle = copySampleBundle(t, ['runner']);
  const runnerOut = tempDir(t, 'runner');
  const runnerRun = runRelease(['--bundle', runnerBundle, '--out', runnerOut]);
  assert.equal(runnerRun.status, 0, runnerRun.stderr);
  assert.deepEqual(assetNames(runnerOut), [
    'SHA256SUMS.txt',
    'bundle-rtosv3-drvport-v1.0.0.zip',
    'hm2b-engine-0.1.0.tgz',
    'hm2b-framework-0.1.0.tgz',
    'hm2b-payload-rtosv3-drvport-v1.0.0.tgz',
    'install.mjs',
    'workflow.compiled.json',
  ]);
  const runnerPayload = payloadArchive(runnerOut, 'hm2b-payload-rtosv3-drvport-v1.0.0.tgz');
  assert.deepEqual(runnerPayload.manifest.options, { stageOrder: null, skills: null, targets: ['runner'] });
  const runnerCheck = runRelease(['--bundle', runnerBundle, '--check', '--out', runnerOut]);
  assert.equal(runnerCheck.status, 0, runnerCheck.stderr);

  const agentBundle = copySampleBundle(t, ['agent-native']);
  const agentOut = tempDir(t, 'agent');
  const agentRun = runRelease(['--bundle', agentBundle, '--out', agentOut]);
  assert.equal(agentRun.status, 0, agentRun.stderr);
  assert.deepEqual(assetNames(agentOut), [
    'SHA256SUMS.txt',
    'agent-native-rtosv3-drvport-v1.0.0.tgz',
    'bundle-rtosv3-drvport-v1.0.0.zip',
    'hm2b-framework-0.1.0.tgz',
    'install.mjs',
    'workflow.compiled.json',
  ]);
  const agentPayload = payloadArchive(agentOut, 'agent-native-rtosv3-drvport-v1.0.0.tgz');
  assert.deepEqual(agentPayload.manifest.options, {
    stageOrder: null,
    skills: null,
    targets: ['claude-code', 'codex', 'dsh', 'omp', 'opencode'],
  });
  const agentCheck = runRelease(['--bundle', agentBundle, '--check', '--out', agentOut]);
  assert.equal(agentCheck.status, 0, agentCheck.stderr);
});

test('the framework source set excludes repo-only trees and keeps the toolchain', () => {
  const framework = collectFramework(ROOT);
  assert.deepEqual(framework.problems, []);
  const rels = framework.files.map((file) => file.rel);
  assert.deepEqual(rels, [...rels].sort(compareCodePoints));
  assert.deepEqual(frameworkSourceProblems(rels), []);
  for (const rel of rels) {
    assert.doesNotMatch(rel, /^(test|tests|docs|scripts|\.github|examples|plugins|pack|src|adapters|shims|schema|node_modules|dist)\//);
    assert.notEqual(rel, 'bin/hm2b.js');
  }
  for (const required of [
    'package.json',
    'LICENSE',
    'bin/hm2b-assembler.js',
    'bin/assembler/common.js',
    'core/canonical-json.js',
    'compiled/schema.js',
    'assembler/compile.js',
    'projection/project.js',
    'runtime/shared/render-role.js',
    'runtime/agent-native/projection/targets/claude-code.js',
    'installer/index.js',
    'web/serve.mjs',
  ]) {
    assert.ok(rels.includes(required), `${required} must ship in the framework archive`);
  }
  assert.equal(rels.some((rel) => rel.startsWith('examples/')), false);

  const violations = frameworkSourceProblems([
    'test/x.test.js',
    'docs/compat.md',
    'scripts/release.mjs',
    'scripts/install.mjs',
    '.github/workflows/ci.yml',
    'examples/rtosv3/bundle/bundle.json',
    'plugins/x.js',
    'bin/hm2b.js',
  ]);
  assert.equal(violations.length, 8);
  assert.ok(violations.some((message) => message.includes('test/x.test.js')));
  assert.ok(violations.some((message) => message.includes('bin/hm2b.js')));
});

test('the engine archive keeps its own whitelist', () => {
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE_ZIP });
  assert.equal(built.ok, true);
  assert.ok(built.engineFiles.length > 0);
  for (const rel of built.engineFiles) {
    assert.doesNotMatch(rel, /^(test|tests|docs|scripts|pack|adapters|plugins|dist)\//);
  }
  assert.ok(built.engineFiles.includes('package.json'));
  assert.ok(built.engineFiles.includes('bin/hm2b.js'));
});

test('--bundle requires an explicit --out', () => {
  const result = runRelease(['--bundle', SAMPLE_ZIP]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--bundle requires --out/);
});
