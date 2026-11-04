/**
 * Repository workflow contract after P6.
 *
 * The legacy `v<E>` release job is gone (main stopped shipping the legacy
 * payload); the bundle channel owns `bundle-*` tags. CI checks the sample
 * bundle's determinism and the static release gate instead of validating the
 * retired `pack/` manifest, and no workflow may reach a retired path.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

function workflow(name) {
  return readFileSync(join(WORKFLOWS, name), 'utf8');
}

test('package.json exposes test/bundle/release scripts and stays private', () => {
  assert.deepEqual(pkg.scripts, {
    test: 'node --test --test-concurrency=8 test/*.test.js',
    web: 'node web/serve.mjs',
    'bundle:build': 'node scripts/build-bundle.mjs examples/rtosv3/bundle',
    'bundle:check': 'node scripts/build-bundle.mjs examples/rtosv3/bundle --check',
    release: 'node scripts/release.mjs',
  });
  assert.equal(pkg.private, true);
  assert.equal('files' in pkg, false, 'npm files whitelist must stay removed');
  assert.deepEqual(pkg.bin, {
    hm2b: 'runtime/runner/engine/bin/hm2b.js',
    'hm2b-assembler': 'bin/hm2b-assembler.js',
  });
});

test('three workflows exist with their expected triggers', () => {
  for (const name of ['ci.yml', 'live.yml', 'release.yml']) {
    assert.ok(existsSync(join(WORKFLOWS, name)), `${name} is missing`);
  }
  const ci = workflow('ci.yml');
  assert.match(ci, /pull_request:/);
  assert.match(ci, /push:/);
  const live = workflow('live.yml');
  assert.match(live, /workflow_dispatch:/);
  const release = workflow('release.yml');
  assert.match(release, /tags:\s*\n\s*- 'bundle-\*'/);
});

test('ci runs the node matrix, tests, bundle check and release gate', () => {
  const ci = workflow('ci.yml');
  for (const entry of ['ubuntu-24.04', "'22.19'", "'24'", 'windows-2025']) {
    assert.ok(ci.includes(entry), `ci matrix is missing ${entry}`);
  }
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm test/);
  assert.match(ci, /node scripts\/build-bundle\.mjs examples\/rtosv3\/bundle --check/);
  assert.match(ci, /node scripts\/release\.mjs --check/);
  assert.match(ci, /git ls-files 'examples\/\*\/dist\/\*\.zip'/);
  assert.doesNotMatch(ci, /pack\/|adapters\/|(?:^|\s)bin\/r2c\.js|(?:^|\s)bin\/hm2b\.js|acceptance/);
});

test('release publishes bundle tags only, through the bundle channel', () => {
  const release = workflow('release.yml');
  assert.match(release, /--bundle examples\/rtosv3\/dist\/bundle-rtosv3-drvport-v1\.0\.0\.zip/);
  assert.match(release, /--check --tag/);
  assert.match(release, /--publish --tag/);
  assert.match(release, /GH_TOKEN:/);
  assert.doesNotMatch(release, /r2c-payload-|gh release create|"v\$\{version\}"/);
});

test('no workflow references a retired path or mechanism', () => {
  for (const name of ['ci.yml', 'live.yml', 'release.yml']) {
    const text = workflow(name);
    assert.doesNotMatch(text, /\bsrc\/|\badapters\/|\bpack\/|\bplugins\/|\bshims\/|adapter\.json|acceptance --agent/, name);
  }
});
