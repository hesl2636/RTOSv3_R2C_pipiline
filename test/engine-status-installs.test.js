/**
 * #104 engine `r2c status` install surface: additive `installs[]` and install
 * lines; exit codes and existing lines stay untouched.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../core/canonical-json.js';
import { writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-engine-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTwoStepProject(root);
  return root;
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
  return env;
}

function cli(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: cleanEnv() });
}

function cliJson(args, cwd) {
  const result = cli([...args, '--json'], cwd);
  const lines = result.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got: ${JSON.stringify(result.stdout)}`);
  return { result, envelope: JSON.parse(lines[0]) };
}

const RECEIPT = {
  schema: 'r2c.install/v2',
  projection: { id: 'r2c', version: '1.0.0', targets: ['r2c'] },
  bundle: { id: 'demo-bundle', version: '2.3.4' },
  ir: { path: '.r2c/bundles/demo-bundle/2.3.4/workflow.ir.json', digest: '0'.repeat(64), contentSha256: '0'.repeat(64) },
  root: 'project',
  scope: 'project',
  mode: 'fresh',
  host_targets: ['claude-code', 'codex', 'omp', 'opencode'],
  options: { stageOrder: null, skills: null, targets: ['r2c'], digest: '0'.repeat(64) },
  requires_engine: null,
  files: [],
  metadata: {},
  capability_report: [],
  degradations: [],
  warnings: [],
  created_dirs: [],
  backups: [],
  previous: null,
  migrated_from: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function writeInstallSurface(root, { receipts = [RECEIPT], runtime = true } = {}) {
  const receiptsDir = join(root, '.r2c/install/receipts/r2c');
  mkdirSync(receiptsDir, { recursive: true });
  for (const [index, receipt] of receipts.entries()) {
    writeFileSync(join(receiptsDir, `bundle-${index}.json`), canonicalJson(receipt));
  }
  if (runtime) {
    writeFileSync(join(root, '.r2c/install/runtime.json'), canonicalJson({
      schema: 'r2c.runtime/v1',
      engine: { version: '0.1.0', home: '.r2c/engine', entry: '.r2c/engine/0.1.0/bin/r2c.js' },
      launcher: '.r2c/bin/r2c.js',
      host_targets: ['claude-code'],
      files: [],
      merged: [],
      backups: [],
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }));
  }
}

function startRun(t, root) {
  const { result, envelope } = cliJson(['run', '--project-root', root], REPO);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.ok, true);
  return envelope;
}

test('engine status JSON gains installs[] without changing existing fields', (t) => {
  const root = tempProject(t);
  const started = startRun(t, root);
  writeInstallSurface(root);

  const { result, envelope } = cliJson(['status', '--project-root', root, '--session-id', started.session_id], root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.run.run_id, started.run_id);
  assert.equal(typeof envelope.data.stages.length, 'number');
  assert.equal(typeof envelope.data.steps.length, 'number');
  assert.ok(envelope.data.next !== undefined);
  assert.deepEqual(envelope.data.installs, [{
    projection: 'r2c',
    bundle: 'demo-bundle',
    version: '2.3.4',
    targets: ['claude-code', 'codex', 'omp', 'opencode'],
    receipt: '.r2c/install/receipts/r2c/bundle-0.json',
  }]);
});

test('engine status text keeps existing lines and appends install/engine/manifest lines', (t) => {
  const root = tempProject(t);
  const started = startRun(t, root);
  writeInstallSurface(root);

  const baseline = cli(['status', '--project-root', root, '--session-id', started.session_id], root);
  assert.equal(baseline.status, 0, baseline.stderr);
  const withInstall = cli(['status', '--project-root', root, '--session-id', started.session_id], root);
  const lines = withInstall.stdout.trimEnd().split(/\r?\n/);
  const runLines = lines.filter((line) => /^(run|stage|step|next)\//.test(line));
  assert.deepEqual(runLines.slice(0, 1), [baseline.stdout.trimEnd().split(/\r?\n/)[0]]);
  assert.match(withInstall.stdout, /^install\/r2c\/demo-bundle 2\.3\.4 targets=claude-code,codex,omp,opencode$/m);
  assert.match(withInstall.stdout, /^engine\/0\.1\.0$/m);
  assert.match(withInstall.stdout, /^manifest\/workflows\/two-step\.yaml$/m);
  const installAt = lines.findIndex((line) => line.startsWith('install/'));
  const nextAt = lines.findIndex((line) => line.startsWith('next/'));
  assert.ok(installAt > nextAt, 'install lines come after every existing line');
});

test('engine status reports unsupported receipts without failing', (t) => {
  const root = tempProject(t);
  const started = startRun(t, root);
  writeInstallSurface(root, { receipts: [{ schema: 'r2c.install/v9', projection: { id: 'r2c' }, bundle: { id: 'future' } }] });

  const { result, envelope } = cliJson(['status', '--project-root', root, '--session-id', started.session_id], root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(envelope.data.installs, [{
    projection: 'r2c',
    bundle: 'future',
    version: null,
    targets: [],
    receipt: '.r2c/install/receipts/r2c/bundle-0.json',
    schema: 'r2c.install/v9',
    unsupported: true,
  }]);
});

test('engine status exit code and error stay NO_ACTIVE_RUN/4 when no run exists', (t) => {
  const root = tempProject(t);
  writeInstallSurface(root);
  const { result, envelope } = cliJson(['status', '--project-root', root], root);
  assert.equal(result.status, 4);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'NO_ACTIVE_RUN');
});

test('engine status silently ignores an unreadable install surface', (t) => {
  const root = tempProject(t);
  const started = startRun(t, root);
  mkdirSync(join(root, '.r2c/install/receipts/r2c'), { recursive: true });
  writeFileSync(join(root, '.r2c/install/receipts/r2c/broken.json'), '{not json');

  const { result, envelope } = cliJson(['status', '--project-root', root, '--session-id', started.session_id], root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(envelope.data.installs, []);
});
