import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

const ADAPTERS = ['claude-code', 'codex', 'dsh', 'omp', 'opencode'];

function workflow(name) {
  const text = readFileSync(join(WORKFLOWS, name), 'utf8');
  return { text, parsed: parse(text) };
}

function stepRuns(parsed) {
  return Object.values(parsed.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? '');
}

function findStep(parsed, needle) {
  for (const job of Object.values(parsed.jobs)) {
    for (const step of job.steps ?? []) {
      if ((step.run ?? '').includes(needle)) return step;
    }
  }
  return null;
}

test('package.json exposes test/bundle/release scripts and no npm publishing whitelist', () => {
  assert.deepEqual(pkg.scripts, {
    test: 'node --test --test-concurrency=8 test/*.test.js',
    web: 'node web/serve.mjs',
    'bundle:build': 'node scripts/build-bundle.mjs examples/rtosv3/bundle',
    'bundle:check': 'node scripts/build-bundle.mjs examples/rtosv3/bundle --check',
    release: 'node scripts/release.mjs',
  });
  // #44: the package is not published to npm, so the npm `files` whitelist is
  // gone; the release asset whitelist in scripts/release.mjs replaces it.
  assert.equal('files' in pkg, false, 'npm files whitelist must stay removed');
  assert.equal(existsSync(join(REPO, 'scripts', 'check-pack.mjs')), false, 'the npm pack gate must stay deleted');
});

test('all four workflows exist with their expected triggers', () => {
  const ci = workflow('ci.yml').parsed;
  assert.deepEqual(Object.keys(ci.on).sort(), ['pull_request', 'push']);

  const acceptance = workflow('acceptance.yml').parsed;
  assert.deepEqual(Object.keys(acceptance.on).sort(), ['pull_request', 'schedule', 'workflow_dispatch']);

  const live = workflow('live.yml').parsed;
  assert.deepEqual(Object.keys(live.on), ['workflow_dispatch']);

  const release = workflow('release.yml').parsed;
  assert.deepEqual(Object.keys(release.on), ['push']);
  assert.deepEqual(release.on.push.tags, ['v*']);
});

test('ci, acceptance, and live contain no secrets', () => {
  for (const name of ['ci.yml', 'acceptance.yml', 'live.yml']) {
    assert.doesNotMatch(workflow(name).text, /secrets\./, `${name} must be secret-free`);
  }
});

test('ci runs the node matrix, tests, manifest validation, and the release gate', () => {
  const ci = workflow('ci.yml').parsed;
  const include = ci.jobs.test.strategy.matrix.include;
  // Adjudication: spec §7 says "node 22.19/24 × ubuntu + windows 24" and
  // ticket #34 says two Node versions on ubuntu plus windows 24, so windows is
  // not paired with 22.19. Do not "fix" this matrix by adding windows × 22.19.
  assert.deepEqual(include, [
    { os: 'ubuntu-24.04', node: '22.19' },
    { os: 'ubuntu-24.04', node: '24' },
    { os: 'windows-2025', node: '24' },
  ]);

  const runs = stepRuns(ci).join('\n');
  assert.match(runs, /npm ci/);
  assert.match(runs, /npm test/);
  assert.match(
    runs,
    /node bin\/r2c\.js validate --manifest .*pack\/workflows\/hm2B_drvport_pipiline\.yaml/,
  );
  assert.match(runs, /node scripts\/release\.mjs --check/);
  assert.match(runs, /git ls-files .*workflows\/\*\.yaml/);
  assert.match(runs, /-ne 1/);

  // #44: the npm pack whitelist is gone. The asset whitelist lives in
  // `scripts/release.mjs --check`, so a second npm-flavoured gate must not
  // come back and contradict it.
  assert.doesNotMatch(runs, /check-pack|npm pack/);
  const text = workflow('ci.yml').text;
  assert.doesNotMatch(text, /npm pack/, 'ci must not pack npm tarballs');
});

test('acceptance covers all five adapters on ubuntu and windows', () => {
  const acceptance = workflow('acceptance.yml').parsed;
  const matrix = acceptance.jobs.acceptance.strategy.matrix;
  assert.deepEqual(matrix.os, ['ubuntu-24.04', 'windows-2025']);
  assert.deepEqual(matrix.agent, ADAPTERS);
  assert.equal(acceptance.jobs.acceptance['runs-on'], '${{ matrix.os }}');
  const setup = acceptance.jobs.acceptance.steps.find((step) => step.uses === 'actions/setup-node@v4');
  assert.equal(setup.with['node-version'], '24');

  const run = findStep(acceptance, 'acceptance --agent')?.run ?? '';
  assert.match(run, /node bin\/r2c\.js acceptance --agent "\$AGENT" --json/);
  assert.match(run, /summary\.fail !== 0/);
  assert.match(run, /warn=\$\{summary\.warn\}/, 'warn must be reported');
  assert.doesNotMatch(run, /summary\.warn\s*!==?\s*0/, 'warn must not gate');

  // The CLIs are installed best-effort and need no login; the gate itself is
  // still the zero-model acceptance harness, so a missing CLI only skips its
  // own checks instead of failing the workflow.
  const install = findStep(acceptance, 'npm install -g')?.run ?? '';
  for (const pin of [
    '@anthropic-ai/claude-code@2.1.312',
    '@openai/codex@0.165.0',
    '@deepseek-ai/dsh@0.2.1-rc.2',
    'opencode-ai@1.19.5',
  ]) {
    assert.ok(install.includes(pin), `acceptance installs ${pin}`);
  }
  const installSteps = acceptance.jobs.acceptance.steps.filter(
    (step) => /Install agent CLIs|Install omp/.test(step.name ?? ''),
  );
  assert.equal(installSteps.length, 2);
  for (const step of installSteps) {
    assert.equal(step['continue-on-error'], true);
    assert.equal(step['timeout-minutes'], 2, 'a best-effort install must time-box itself');
  }
  assert.match(installSteps[1].run, /omp\.sh\/install/);
});

test('live is manual, redirects HOME/USERPROFILE/DSH_HOME, and never gates', () => {
  const live = workflow('live.yml').parsed;
  const job = live.jobs.live;
  assert.equal(job['continue-on-error'], true);
  assert.deepEqual(job.strategy.matrix.agent, ADAPTERS);
  for (const key of ['HOME', 'USERPROFILE', 'DSH_HOME']) {
    assert.match(job.env[key], /^\$\{\{ runner\.temp \}\}\//);
  }

  const probes = job.steps.filter((step) => step.name?.startsWith('Probe '));
  assert.equal(probes.length, 5);
  for (const probe of probes) assert.equal(probe['continue-on-error'], true);

  const runs = probes.map((probe) => probe.run).join('\n');
  assert.match(runs, /claude -p .*--output-format stream-json/);
  assert.match(runs, /codex exec --json/);
  assert.match(runs, /dsh --profile headless/);
  assert.match(runs, /omp -p .*--mode json/);
  assert.match(runs, /opencode run .*--format json/);
});

test('release gates tag==version, builds four assets, verifies sums, then publishes', () => {
  const release = workflow('release.yml').parsed;
  assert.deepEqual(release.permissions, { contents: 'write' });

  const version = findStep(release, 'GITHUB_REF_NAME');
  assert.ok(version, 'tag==version step is missing');
  assert.equal(version.id, 'version');
  assert.match(version.run, /package\.json/);
  assert.match(version.run, /"\$\{GITHUB_REF_NAME\}"\s*!=/);
  assert.match(version.run, /v\$\{version\}/);
  assert.match(version.run, /exit 1/);

  const runs = stepRuns(release);
  const joined = runs.join('\n');
  // npm stays for `npm ci` + `npm test` only; it is not a distribution channel.
  assert.match(joined, /npm ci/);
  assert.match(joined, /npm test/);
  assert.doesNotMatch(joined, /npm publish/);
  assert.match(joined, /node scripts\/release\.mjs --check/);
  assert.match(joined, /node scripts\/release\.mjs --out dist/);
  assert.match(joined, /node scripts\/verify-sums\.mjs dist\/SHA256SUMS\.txt/);
  assert.ok(
    runs.findIndex((run) => run.includes('--out dist')) <
      runs.findIndex((run) => run.includes('verify-sums')),
    'the assets must be built before their checksums are verified',
  );

  const draftIndex = runs.findIndex((run) => run.includes('gh release create'));
  const editIndex = runs.findIndex((run) => run.includes('gh release edit'));
  assert.ok(draftIndex >= 0, 'draft release step is missing');
  assert.ok(editIndex >= 0, 'draft must be published after the assets are verified');
  assert.ok(draftIndex < editIndex, 'draft release must be created before it is published');

  const draft = runs[draftIndex];
  assert.match(draft, /--draft/);
  const assets = [...new Set(draft.match(/dist\/[^\s"\\]+/g) ?? [])].sort();
  assert.deepEqual(assets, [
    'dist/SHA256SUMS.txt',
    'dist/install.mjs',
    'dist/r2c-engine-${version}.tgz',
    'dist/r2c-payload-${version}.tgz',
  ]);

  assert.match(runs[editIndex], /--draft=false/);
  assert.equal(runs.filter((run) => run.includes('gh release edit')).length, 1);

  const text = workflow('release.yml').text;
  assert.doesNotMatch(text, /secrets\./, 'the release must hold no secret');
  assert.doesNotMatch(text, /NPM_TOKEN|NODE_AUTH_TOKEN|R2C_PROVENANCE/);
  assert.doesNotMatch(text, /id-token|npm publish|registry-url/);
});

test('CHANGELOG records the 0.1.0 release', () => {
  const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^##\s+\[?0\.1\.0\]?/m);
});
