/**
 * #94 CLI: result directory / inline result, JSON envelope and exit codes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { sample } from './helpers/install-fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'installer', 'cli.js');

function tempDir(t, prefix = 'r2c-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeResultDir(t, { result, irBytes }) {
  const dir = tempDir(t, 'r2c-result-');
  writeFileSync(join(dir, 'projection-result.json'), canonicalJson(result));
  writeFileSync(join(dir, 'workflow.ir.json'), irBytes);
  for (const file of result.files) {
    const absolute = join(dir, 'files', ...file.path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content);
  }
  return dir;
}

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function envelopeOf(run) {
  assert.equal(run.stderr, '');
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1, '--json output is one envelope line');
  return JSON.parse(lines[0]);
}

test('installs from a result directory and reports one envelope', (t) => {
  const { result, irBytes } = sample('r2c');
  const resultDir = writeResultDir(t, { result, irBytes });
  const projectRoot = tempDir(t, 'r2c-project-');

  const run = cli(['--result', resultDir, '--project', projectRoot, '--json']);
  assert.equal(run.status, 0);
  const envelope = envelopeOf(run);
  assert.deepEqual(Object.keys(envelope), ['ok', 'command', 'code', 'run_id', 'session_id', 'step', 'data', 'error']);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.action, 'installed');
  assert.equal(envelope.data.receipt_path, `.r2c/install/receipts/r2c/${result.ir.id}.json`);
  const receipt = JSON.parse(readFileSync(join(projectRoot, ...envelope.data.receipt_path.split('/')), 'utf8'));
  assert.equal(envelope.data.files, receipt.files.length);
  assert.ok(envelope.data.files > result.files.length, 'r2c installs add installer-owned host roles');
  assert.ok(receipt.files.some((file) => file.origin === 'installer'));
  assert.equal(existsSync(join(projectRoot, ...envelope.data.receipt_path.split('/'))), true);

  const again = cli(['--result', resultDir, '--project', projectRoot, '--json']);
  assert.equal(again.status, 0);
  assert.equal(envelopeOf(again).data.action, 'unchanged');
});

test('accepts an inline result JSON path', (t) => {
  const { result, irBytes } = sample('r2c');
  const resultDir = writeResultDir(t, { result, irBytes });
  const projectRoot = tempDir(t, 'r2c-project-');
  const run = cli(['--result', join(resultDir, 'projection-result.json'), '--ir', join(resultDir, 'workflow.ir.json'), '--project', projectRoot, '--json']);
  assert.equal(run.status, 0);
  assert.equal(envelopeOf(run).data.action, 'installed');
});

test('a payload mismatch is refused with no writes', (t) => {
  const { result, irBytes } = sample('r2c');
  const resultDir = writeResultDir(t, { result, irBytes });
  const target = join(resultDir, 'files', ...result.files[0].path.split('/'));
  writeFileSync(target, 'tampered\n');
  const projectRoot = tempDir(t, 'r2c-project-');

  const run = cli(['--result', resultDir, '--project', projectRoot, '--json']);
  assert.equal(run.status, 2);
  const envelope = envelopeOf(run);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'PAYLOAD_FILE_MISMATCH');
  assert.deepEqual(readdirSyncSafe(projectRoot), []);
});

test('a result directory without its IR is a usage error', (t) => {
  const { result } = sample('r2c');
  const resultDir = tempDir(t, 'r2c-result-');
  writeFileSync(join(resultDir, 'projection-result.json'), canonicalJson(result));
  const projectRoot = tempDir(t, 'r2c-project-');
  const run = cli(['--result', resultDir, '--project', projectRoot, '--json']);
  assert.equal(run.status, 2);
  assert.equal(envelopeOf(run).error.code, 'IR_INPUT_REQUIRED');
});

test('conflicts exit 2 and list every path', (t) => {
  const { result, irBytes } = sample('r2c');
  const resultDir = writeResultDir(t, { result, irBytes });
  const projectRoot = tempDir(t, 'r2c-project-');
  for (const file of result.files.slice(0, 2)) {
    const absolute = join(projectRoot, ...file.path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'different\n');
  }
  const run = cli(['--result', resultDir, '--project', projectRoot, '--json']);
  assert.equal(run.status, 2);
  const envelope = envelopeOf(run);
  assert.equal(envelope.error.code, 'INSTALL_CONFLICTS');
  assert.equal(envelope.error.details.length, 2);
});

test('uninstall exits 0, then 4 when the identity is gone', (t) => {
  const { result, irBytes } = sample('r2c');
  const resultDir = writeResultDir(t, { result, irBytes });
  const projectRoot = tempDir(t, 'r2c-project-');
  assert.equal(cli(['--result', resultDir, '--project', projectRoot]).status, 0);

  const removed = cli(['--uninstall', '--projection', 'r2c', '--bundle', result.ir.id, '--project', projectRoot, '--json']);
  assert.equal(removed.status, 0);
  assert.equal(envelopeOf(removed).data.action, 'uninstalled');

  const missing = cli(['--uninstall', '--projection', 'r2c', '--bundle', result.ir.id, '--project', projectRoot, '--json']);
  assert.equal(missing.status, 4);
  assert.equal(envelopeOf(missing).error.code, 'NOT_INSTALLED');
});

test('--migrate-legacy is install-only and needs a result', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const missingResult = cli(['--migrate-legacy', '--project', projectRoot, '--json']);
  assert.equal(missingResult.status, 2);
  assert.equal(envelopeOf(missingResult).error.code, 'USAGE');

  const withUninstall = cli([
    '--migrate-legacy', '--uninstall', '--projection', 'r2c', '--bundle', 'x', '--project', projectRoot, '--json',
  ]);
  assert.equal(withUninstall.status, 2);
  assert.equal(envelopeOf(withUninstall).error.code, 'USAGE');
});

test('dry-run through the CLI writes nothing', (t) => {
  const { result, irBytes } = sample('r2c');
  const resultDir = writeResultDir(t, { result, irBytes });
  const projectRoot = tempDir(t, 'r2c-project-');
  const run = cli(['--result', resultDir, '--project', projectRoot, '--dry-run', '--json']);
  assert.equal(run.status, 0);
  assert.equal(envelopeOf(run).data.dry_run, true);
  assert.deepEqual(readdirSyncSafe(projectRoot), []);
});

function readdirSyncSafe(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}
test('uninstall without --bundle is a usage error', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const run = cli(['--uninstall', '--projection', 'r2c', '--project', projectRoot, '--json']);
  assert.equal(run.status, 2);
  assert.equal(envelopeOf(run).error.code, 'USAGE');
});
