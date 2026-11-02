import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withPath } from './support/env.js';
import { writeEngine } from './helpers/engine.js';
import { dropPayloadManifest, writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const ENGINE_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-claude-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake `claude` on PATH so detection never depends on the developer machine. */
function fakeClaude(t, version = '2.1.312') {
  const dir = tempDir(t, 'bin');
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\necho ${version}\r\n`);
  } else {
    const file = join(dir, 'claude');
    writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

function cleanEnv({ pathDir, home } = {}) {
  const env = { ...process.env };
  for (const key of ['R2C_SESSION_ID', 'R2C_PROJECT_ROOT', 'R2C_PLUGIN_SOURCE']) delete env[key];
  if (pathDir) withPath(env, pathDir);
  if (home) {
    env.R2C_HOME = home;
    env.HOME = home;
    env.USERPROFILE = home;
  }
  return env;
}

function cli(args, { env, cwd } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env,
  });
}

function envelope(result) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`not a JSON envelope: ${JSON.stringify(result.stdout)} / ${result.stderr}`);
  }
}

function setup(t) {
  const home = tempDir(t, 'home');
  const bin = fakeClaude(t);
  const project = tempDir(t, 'project');
  return { home, bin, project, env: cleanEnv({ pathDir: bin, home }) };
}

function install(env, project, extra = []) {
  return cli(
    ['adapter', 'install', 'claude-code', '--from', REPO, '--project-root', project, ...extra, '--json'],
    { env },
  );
}

function receiptPath(root) {
  return join(root, '.r2c', 'install', 'claude-code.json');
}

function readReceipt(project) {
  return JSON.parse(readFileSync(receiptPath(project), 'utf8'));
}

function settingsFor(root) {
  return JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
}

function posixPath(file) {
  return file.replaceAll('\\', '/');
}

/** Flatten one Claude-style event (`Stop`/`PreToolUse`) to command strings. */
function commandsFor(settings, event) {
  const groups = settings?.hooks?.[event] ?? [];
  return groups.flatMap((group) =>
    (group.hooks ?? []).map((hook) => hook.command).filter((command) => typeof command === 'string'),
  );
}

test('install wires seven commands, thirty-five skills and both Claude hooks', (t) => {
  const { project, env } = setup(t);
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);

  const commandsDir = join(project, '.claude', 'commands');
  assert.equal(readdirSync(commandsDir).length, 7);
  assert.equal(readdirSync(join(project, '.claude', 'skills')).length, 35);

  const receipt = readReceipt(project);
  const settings = settingsFor(project);
  // Project scope records the payload project-relative (C3), so the installed
  // hook survives renaming the project directory.
  const shim = posixPath(`.r2c/payload/${ENGINE_VERSION}/shims/hook.mjs`);

  const stop = commandsFor(settings, 'Stop');
  const preToolUse = commandsFor(settings, 'PreToolUse');
  assert.equal(stop.length, 1);
  assert.equal(preToolUse.length, 1);
  assert.ok(posixPath(stop[0]).includes(shim), stop[0]);
  assert.ok(posixPath(preToolUse[0]).includes(shim), preToolUse[0]);
  assert.ok(!posixPath(stop[0]).includes(posixPath(project)), stop[0]);
  assert.equal(receipt.payload_home, join(project, '.r2c', 'payload', ENGINE_VERSION));
  assert.match(stop[0], /--agent claude-code --event stop --format json/);
  assert.match(preToolUse[0], /--agent claude-code --event pre-tool-use --format json/);
  assert.equal(receipt.runner_cmd, `node ${posixPath(BIN)}`);
  assert.ok(stop[0].includes(`--runner-cmd="${receipt.runner_cmd}"`), stop[0]);
  assert.ok(!stop[0].includes('npx'), stop[0]);
  assert.ok(!stop[0].includes('r2c-runner'), stop[0]);

  assert.deepEqual(
    receipt.merged.map((entry) => entry.pointer).sort(),
    ['hooks.PreToolUse', 'hooks.Stop'],
  );
  for (const entry of receipt.merged) {
    assert.equal(entry.file, join(project, '.claude', 'settings.json'));
    assert.equal(entry.added.length, 1);
  }
});

test('a second install leaves settings and receipt untouched', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const settingsFile = join(project, '.claude', 'settings.json');
  const before = readFileSync(settingsFile, 'utf8');
  const receiptMtime = statSync(receiptPath(project)).mtimeMs;

  const second = install(env, project);
  assert.equal(second.status, 0, second.stderr);
  const json = envelope(second);
  assert.equal(json.data.action, 'noop');
  assert.equal(json.data.changed, false);
  assert.equal(readFileSync(settingsFile, 'utf8'), before);
  assert.equal(statSync(receiptPath(project)).mtimeMs, receiptMtime);
});

test('doctor reports wired, parsed and launchable hooks as healthy', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);

  const result = cli(['adapter', 'doctor', 'claude-code', '--project-root', project, '--json'], { env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const data = envelope(result).data;
  assert.equal(data.healthy, true);
  for (const name of ['hooks.wired', 'hooks.smoke', 'hooks.launch', 'discovery']) {
    const check = data.checks.find((entry) => entry.name === name);
    assert.equal(check?.status, 'pass', `${name}: ${JSON.stringify(check)}`);
  }
  assert.match(data.checks.find((entry) => entry.name === 'hooks.launch').detail, /exited 0/);
});

test('foreign Stop/PreToolUse hooks survive install and uninstall', (t) => {
  const { project, env } = setup(t);
  mkdirSync(join(project, '.claude'), { recursive: true });
  const settingsFile = join(project, '.claude', 'settings.json');
  const foreign = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo foreign-stop' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo foreign-pre' }] }],
    },
    permissions: { allow: ['Bash(ls:*)'] },
  };
  writeFileSync(settingsFile, `${JSON.stringify(foreign, null, 2)}\n`);

  assert.equal(install(env, project).status, 0);
  const wired = settingsFor(project);
  assert.deepEqual(commandsFor(wired, 'Stop').slice(0, 1), ['echo foreign-stop']);
  assert.deepEqual(commandsFor(wired, 'PreToolUse').slice(0, 1), ['echo foreign-pre']);
  assert.equal(commandsFor(wired, 'Stop').length, 2);
  assert.equal(commandsFor(wired, 'PreToolUse').length, 2);
  assert.deepEqual(wired.permissions, foreign.permissions);

  const removed = cli(['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'], { env });
  assert.equal(removed.status, 0, removed.stderr);
  const after = settingsFor(project);
  assert.deepEqual(after, foreign);
});

test('user scope writes only commands, skills and settings under the home claude dir', (t) => {
  const { home, project, env } = setup(t);
  const result = install(env, project, ['--scope', 'user']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope(result).data.scope, 'user');

  const claudeHome = join(home, '.claude');
  assert.equal(readdirSync(join(claudeHome, 'commands')).length, 7);
  assert.equal(readdirSync(join(claudeHome, 'skills')).length, 35);
  assert.ok(existsSync(join(claudeHome, 'settings.json')));
  assert.ok(!existsSync(join(home, '.claude.json')), 'must not write ~/.claude.json');
  assert.ok(!existsSync(join(project, '.claude')), 'user scope must not touch the project');

  const settings = settingsFor(home);
  assert.equal(commandsFor(settings, 'Stop').length, 1);
  assert.equal(commandsFor(settings, 'PreToolUse').length, 1);
  assert.deepEqual(
    readdirSync(claudeHome).sort().filter((name) => !['agents', 'commands', 'settings.json', 'skills'].includes(name)),
    [],
  );

  const doctor = cli(
    ['adapter', 'doctor', 'claude-code', '--project-root', project, '--scope', 'user', '--json'],
    { env },
  );
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.equal(envelope(doctor).data.healthy, true);
});

test('a project path with spaces renders a command that really launches', (t) => {
  const { bin, home } = setup(t);
  const project = join(tempDir(t, 'spaced'), 'space project 28');
  mkdirSync(project, { recursive: true });
  const env = cleanEnv({ pathDir: bin, home });

  assert.equal(install(env, project).status, 0);
  const stop = commandsFor(settingsFor(project), 'Stop')[0];
  // Project scope is project-relative, so a moved project still resolves it;
  // the shim path stays quoted because the surrounding directory has a space.
  assert.ok(stop.startsWith('node "'), stop);
  assert.ok(posixPath(stop).includes(posixPath(`.r2c/payload/${ENGINE_VERSION}/shims/hook.mjs`)), stop);
  assert.ok(!posixPath(stop).includes(posixPath(project)), stop);
  assert.ok(stop.includes('--runner-cmd="'), stop);

  const launched = spawnSync(stop, {
    shell: true,
    cwd: project,
    encoding: 'utf8',
    input: '',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(launched.status, 0, `${launched.stderr}\n${stop}`);
});

test('renaming the project directory keeps the Stop hook delivering', (t) => {
  const { project, env } = setup(t);
  const engine = writeEngine(join(project, '.r2c', 'engine', ENGINE_VERSION), BIN);
  assert.equal(install(env, project, ['--engine', engine]).status, 0);

  dropPayloadManifest(project);
  writeTwoStepProject(project);
  const started = cli(['run', '--project-root', project, '--session-id', 'sess-renamed', '--json'], {
    env,
    cwd: project,
  });
  assert.equal(started.status, 0, started.stderr);

  const moved = join(dirname(project), `${basename(project)}-renamed`);
  renameSync(project, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));

  const stop = commandsFor(settingsFor(moved), 'Stop')[0];
  assert.ok(!posixPath(stop).includes(posixPath(project)), stop);
  const launched = spawnSync(stop, {
    shell: true,
    cwd: moved,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sess-renamed' }),
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(launched.status, 0, `${launched.stderr}\n${stop}`);
  const delivered = JSON.parse(launched.stdout.trim());
  assert.equal(delivered.decision, 'block');
  assert.match(
    delivered.reason,
    new RegExp(`node \\.r2c/engine/${ENGINE_VERSION.replaceAll('.', '\\.')}/bin/r2c\\.js submit --session-id sess-renamed --step step-a`),
  );
  const trace = readFileSync(join(moved, '.r2c', 'runs', '.hooks', 'trace', 'claude-code.jsonl'), 'utf8');
  assert.match(trace, /"hook":"stop".*"delivered":true/);
});

test('user scope quotes the absolute engine path so a spaced home still runs', (t) => {
  const { bin, project } = setup(t);
  const home = join(tempDir(t, 'spaced-home'), 'home with space');
  mkdirSync(home, { recursive: true });
  const env = cleanEnv({ pathDir: bin, home });
  const engine = writeEngine(join(home, '.r2c', 'engine', ENGINE_VERSION), BIN);
  const result = install(env, project, ['--scope', 'user', '--engine', engine]);
  assert.equal(result.status, 0, result.stderr);

  const entry = join(engine, 'bin', 'r2c.js');
  const receipt = JSON.parse(readFileSync(join(home, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  assert.equal(receipt.runner_cmd, `node "${posixPath(entry)}"`, 'user scope stays absolute and quoted');
  const stop = commandsFor(settingsFor(home), 'Stop')[0];
  assert.ok(stop.includes(`--runner-cmd="node \\"${posixPath(entry)}\\""`), stop);

  const doctor = cli(
    ['adapter', 'doctor', 'claude-code', '--project-root', project, '--scope', 'user', '--json'],
    { env },
  );
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);

  dropPayloadManifest(project);
  writeTwoStepProject(project);
  const started = cli(['run', '--project-root', project, '--session-id', 'sess-user', '--json'], {
    env,
    cwd: project,
  });
  assert.equal(started.status, 0, started.stderr);

  const launched = spawnSync(stop, {
    shell: true,
    cwd: project,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sess-user' }),
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(launched.status, 0, `${launched.stderr}\n${stop}`);
  assert.equal(JSON.parse(launched.stdout.trim()).decision, 'block');
});

test('--runner-cmd overrides the derived project-relative command', (t) => {
  const { project, env } = setup(t);
  const engine = writeEngine(join(project, '.r2c', 'engine', ENGINE_VERSION), BIN);
  const result = install(env, project, ['--engine', engine, '--runner-cmd', 'r2c-custom --hook']);
  assert.equal(result.status, 0, result.stderr);

  const receipt = readReceipt(project);
  assert.equal(receipt.runner_cmd, 'r2c-custom --hook');
  const stop = commandsFor(settingsFor(project), 'Stop')[0];
  assert.ok(stop.includes('--runner-cmd="r2c-custom --hook"'), stop);
  assert.ok(!stop.includes('.r2c/engine/'), stop);
});

test('doctor fails when the recorded engine is gone or reports another version', (t) => {
  const { project, env } = setup(t);
  const engine = writeEngine(join(project, '.r2c', 'engine', ENGINE_VERSION), BIN);
  const entry = join(engine, 'bin', 'r2c.js');
  assert.equal(install(env, project, ['--engine', engine]).status, 0);
  const doctor = () => cli(['adapter', 'doctor', 'claude-code', '--project-root', project, '--json'], { env });

  assert.equal(doctor().status, 0, doctor().stdout);

  writeFileSync(entry, 'process.stdout.write("9.9.9\\n");\n');
  const mismatched = doctor();
  assert.equal(mismatched.status, 3, mismatched.stderr);
  const mismatch = envelope(mismatched);
  assert.equal(mismatch.error.code, 'DOCTOR_FAILED');
  const mismatchCheck = mismatch.data.checks.find((item) => item.name === 'engine.executable');
  assert.equal(mismatchCheck.status, 'fail');
  assert.match(mismatchCheck.detail, /9\.9\.9/);

  rmSync(engine, { recursive: true, force: true });
  const missing = doctor();
  assert.equal(missing.status, 3, missing.stderr);
  const missingCheck = envelope(missing).data.checks.find((item) => item.name === 'engine.executable');
  assert.equal(missingCheck.status, 'fail');
  assert.match(missingCheck.detail, /missing/);
});

test('uninstall removes only our hook items, even from a settings file it created', (t) => {
  const { project, env } = setup(t);
  const settingsFile = join(project, '.claude', 'settings.json');

  assert.equal(install(env, project).status, 0);
  assert.ok(existsSync(settingsFile));
  const firstRemove = cli(['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'], { env });
  assert.equal(firstRemove.status, 0, firstRemove.stderr);
  assert.ok(!existsSync(settingsFile), 'a settings file created only for our merge is deleted');

  assert.equal(install(env, project).status, 0);
  const settings = settingsFor(project);
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo later-foreign-stop' }] });
  settings.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'echo later-foreign-pre' }] });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  const secondRemove = cli(['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'], { env });
  assert.equal(secondRemove.status, 0, secondRemove.stderr);
  const after = settingsFor(project);
  assert.deepEqual(commandsFor(after, 'Stop'), ['echo later-foreign-stop']);
  assert.deepEqual(commandsFor(after, 'PreToolUse'), ['echo later-foreign-pre']);
});
