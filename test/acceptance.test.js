/**
 * `r2c acceptance` contract tests.
 *
 * Every case is a real CLI subprocess: the engine face, the agent face, the
 * aggregate exit codes (#35) and the sandbox retention behaviour. The agent is
 * always a staged fake; no test touches a model, a secret or the network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');

const ENGINE_IDS = [
  'E0',
  'V1',
  'FS1',
  "FS3'",
  'FS4',
  'T2',
  'T4',
  ...Array.from({ length: 10 }, (_, index) => `SB${index + 1}`),
];

const AGENT_IDS = [
  'E0',
  'V1',
  'FS1',
  "FS3'",
  'FS4',
  'T2',
  'T4',
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'T1',
  'U1',
  'U2',
];

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-acceptance-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv({ home, pathDir } = {}) {
  const env = { ...process.env };
  for (const key of [
    'R2C_SESSION_ID',
    'R2C_PROJECT_ROOT',
    'R2C_PLUGIN_SOURCE',
    'R2C_DSH_BIN',
    'R2C_CODEX_BIN',
    'DSH_SESSION_ID',
  ]) {
    delete env[key];
  }
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;
    env.R2C_HOME = home;
    env.DSH_HOME = join(home, '.dsh');
  }
  if (pathDir) env.PATH = `${pathDir}${delimiter}${env.PATH ?? ''}`;
  return env;
}

function cli(args, { cwd = REPO, env } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
  });
}

/** Exactly one JSON envelope line. */
function envelope(result, label) {
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, `${label}: expected one JSON line, got ${JSON.stringify(result.stdout)}`);
  return JSON.parse(lines[0]);
}

/**
 * Agent executables that record any invocation. Acceptance stages its own fake
 * in front of PATH, so a marker means something beyond that fake was called.
 */
function sentinelBin(t, marker) {
  const dir = tempDir(t, 'sentinels');
  for (const name of ['claude', 'codex', 'dsh', 'omp', 'opencode']) {
    if (process.platform === 'win32') {
      writeFileSync(
        join(dir, `${name}.cmd`),
        `@echo off\r\necho %*>>"${marker}"\r\nexit /b 97\r\n`,
      );
    } else {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 97\n`);
      chmodSync(file, 0o755);
    }
  }
  return dir;
}

test('the engine face reports exactly 17 checks and exits 0', (t) => {
  const home = tempDir(t, 'engine-home');
  const result = cli(['acceptance', '--json'], { env: cleanEnv({ home }) });
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result, 'engine face');
  assert.equal(json.command, 'acceptance');
  assert.equal(json.ok, true);
  assert.deepEqual(json.data.checks.map((check) => check.id), ENGINE_IDS);
  assert.equal(new Set(json.data.checks.map((check) => check.id)).size, 17);
  assert.equal(json.data.checks.filter((check) => check.status === 'fail').length, 0);
  assert.deepEqual(json.data.summary, { pass: 17, warn: 0, fail: 0 });
  assert.equal(json.data.temp_dir, undefined, 'the default run must clean up');
});

test('the agent face reports 15 checks, never runs a model and never invokes another agent', (t) => {
  const home = tempDir(t, 'agent-home');
  const marker = join(tempDir(t, 'agent-marker'), 'invoked.txt');
  const sentinels = sentinelBin(t, marker);
  const result = cli(['acceptance', '--agent', 'claude-code', '--json'], {
    env: cleanEnv({ home, pathDir: sentinels }),
  });
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result, 'agent face');
  assert.deepEqual(json.data.checks.map((check) => check.id), AGENT_IDS);
  assert.equal(new Set(json.data.checks.map((check) => check.id)).size, 15);
  assert.equal(json.data.checks.filter((check) => check.id.startsWith('SB')).length, 0);
  assert.deepEqual(json.data.summary, { pass: 15, warn: 0, fail: 0 });
  assert.equal(existsSync(marker), false, `an unexpected agent binary was invoked: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`);
});

test('a modified installed file fails the relevant check and the aggregate exits 3', (t) => {
  const home = tempDir(t, 'tamper-home');
  const project = tempDir(t, 'tamper-project');
  const env = cleanEnv({ home });
  const installed = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--project-root', project, '--from', REPO, '--json'],
    { cwd: project, env },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const target = join(project, '.claude', 'commands', 'r2c-run.md');
  writeFileSync(target, `${readFileSync(target, 'utf8')}\ntampered\n`);

  const result = cli(
    ['acceptance', '--agent', 'claude-code', '--project-root', project, '--json'],
    { cwd: project, env },
  );
  assert.equal(result.status, 3, result.stderr);
  const json = envelope(result, 'tamper');
  assert.equal(json.error.code, 'ACCEPTANCE_FAILED');
  const doctor = json.data.checks.find((check) => check.id === 'I3');
  assert.equal(doctor.status, 'fail');
  assert.match(doctor.detail, /receipt\.files|doctor failed/i);
});

test('an unknown or uninstalled agent exits 4', (t) => {
  const home = tempDir(t, 'missing-home');
  const result = cli(['acceptance', '--agent', 'not-an-agent', '--json'], {
    env: cleanEnv({ home }),
  });
  assert.equal(result.status, 4, result.stderr);
  const json = envelope(result, 'missing agent');
  assert.equal(json.error.code, 'AGENT_NOT_FOUND');
});

test('a held install lock exits 5', (t) => {
  const home = tempDir(t, 'lock-home');
  const project = tempDir(t, 'lock-project');
  mkdirSync(join(project, '.r2c', 'install'), { recursive: true });
  writeFileSync(join(project, '.r2c', 'install', '.lock'), 'held-by-test\n');
  const result = cli(
    ['acceptance', '--agent', 'claude-code', '--project-root', project, '--json'],
    { cwd: project, env: cleanEnv({ home }) },
  );
  assert.equal(result.status, 5, result.stderr);
  const json = envelope(result, 'lock conflict');
  assert.equal(json.error.code, 'LOCK_CONFLICT');
});

test('--keep retains the sandbox and --json stays one line', (t) => {
  const home = tempDir(t, 'keep-home');
  const result = cli(['acceptance', '--keep', '--json'], { env: cleanEnv({ home }) });
  const json = envelope(result, 'keep');
  assert.equal(typeof json.data.temp_dir, 'string');
  // Register the cleanup before any assertion can throw, so a kept sandbox
  // never leaks out of a failing run.
  t.after(() => rmSync(json.data.temp_dir, { recursive: true, force: true }));
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(existsSync(json.data.temp_dir), true, '--keep must retain the sandbox');
  assert.equal(existsSync(join(json.data.temp_dir, 'home')), true);
});
