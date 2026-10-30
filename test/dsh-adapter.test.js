import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withPath } from './support/env.js';
import { writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const SHIM = join(REPO, 'shims', 'hook.mjs');
const ENGINE_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-dsh-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeDsh(t) {
  const dir = tempDir(t, 'bin');
  const script = join(dir, 'fake-dsh.mjs');
  writeFileSync(script, `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.DSH_HOME;
const profiles = join(home, 'profiles');

function profileName(values) {
  const index = values.indexOf('--profile');
  return index === -1 ? 'web' : values[index + 1];
}

function readManifest(name) {
  const file = join(profiles, name, 'package.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  return { name: 'dsh-profile-' + name, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
}

if (args[0] === '-V' || args[0] === '--version') {
  process.stdout.write((process.env.FAKE_DSH_VERSION || '0.2.1-rc.3') + '\\n');
  process.exit(0);
}

if (args[0] === 'plugin') {
  if (process.env.FAKE_DSH_PLUGIN_ADD === 'fail') {
    process.stderr.write('pnpm: store unavailable\\n');
    process.exit(1);
  }
  const name = profileName(args);
  const target = args.at(-1).replace(/^link:/, '');
  const dir = join(profiles, name);
  mkdirSync(join(dir, 'node_modules', 'r2c-adapter-dsh'), { recursive: true });
  const manifest = readManifest(name);
  manifest.dependencies['r2c-adapter-dsh'] = 'link:' + target.replaceAll('\\\\', '/');
  const bundles = manifest.dsh.profile.bundles;
  if (!bundles.includes('r2c-adapter-dsh')) bundles.push('r2c-adapter-dsh');
  manifest.dsh.profile.bundles = bundles;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\\n');
  if (!existsSync(join(dir, 'cordis.patch.yml'))) writeFileSync(join(dir, 'cordis.patch.yml'), '[]\\n');
  process.stdout.write('Done\\n');
  process.exit(0);
}

if (args[0] === '--profile' && args.includes('--dump-config')) {
  const name = args[1];
  const manifest = readManifest(name);
  if (process.env.FAKE_DSH_WARNING === '1') {
    process.stderr.write('dsh: warning: 1 entry did not activate\\nr2c-dsh (r2c-adapter-dsh): boom\\n');
  }
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  process.stdout.write('- id: r2c-dsh\\n  name: r2c-adapter-dsh\\n  bundles: ' + bundles.join(',') + '\\n');
  process.exit(0);
}

process.stderr.write('fake dsh: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`);
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'dsh.cmd'), '@echo off\r\nnode "%~dp0fake-dsh.mjs" %*\r\n');
  } else {
    const file = join(dir, 'dsh');
    writeFileSync(file, '#!/bin/sh\nexec node "$(dirname "$0")/fake-dsh.mjs" "$@"\n');
    chmodSync(file, 0o755);
  }
  return dir;
}

function cleanEnv({ pathDir, home, dshHome, extra = {} } = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    'R2C_SESSION_ID',
    'R2C_PROJECT_ROOT',
    'R2C_PLUGIN_SOURCE',
    'R2C_DSH_BIN',
    'DSH_SESSION_ID',
    'DSH_HOME',
    'FAKE_DSH_PLUGIN_ADD',
    'FAKE_DSH_WARNING',
    'FAKE_DSH_VERSION',
  ]) {
    delete env[key];
  }
  if (pathDir) withPath(env, pathDir);
  if (home) {
    env.R2C_HOME = home;
    env.HOME = home;
    env.USERPROFILE = home;
  }
  if (dshHome) env.DSH_HOME = dshHome;
  return env;
}

function cli(args, { env, cwd, input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env,
    input,
  });
}

function envelope(result) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`not a JSON envelope: ${JSON.stringify(result.stdout)} / ${result.stderr}`);
  }
}

function setup(t) {
  const home = tempDir(t, 'home');
  const dshHome = tempDir(t, 'dsh-home');
  const bin = fakeDsh(t);
  const project = tempDir(t, 'project');
  writeTwoStepProject(project);
  const env = cleanEnv({ pathDir: bin, home, dshHome });
  return { home, dshHome, bin, project, env };
}

function install(env, project, extra = []) {
  return cli(
    ['adapter', 'install', 'dsh', '--from', REPO, '--project-root', project, ...extra, '--json'],
    { env },
  );
}

function userReceipt(home) {
  return join(home, '.r2c', 'install', 'dsh.json');
}

function readReceipt(home) {
  return JSON.parse(readFileSync(userReceipt(home), 'utf8'));
}

function profileDir(dshHome, name = 'web') {
  return join(dshHome, 'profiles', name);
}

function readProfile(dshHome) {
  return JSON.parse(readFileSync(join(profileDir(dshHome), 'package.json'), 'utf8'));
}

function writePayload(t, { smoke } = {}) {
  const payload = tempDir(t, 'payload');
  cpSync(join(REPO, 'pack', 'commands'), join(payload, 'commands'), { recursive: true });
  cpSync(join(REPO, 'pack', 'skills'), join(payload, 'skills'), { recursive: true });
  cpSync(join(REPO, 'adapters'), join(payload, 'adapters'), { recursive: true });
  cpSync(join(REPO, 'shims'), join(payload, 'shims'), { recursive: true });
  if (smoke !== undefined) writeFileSync(join(payload, 'adapters', 'dsh', 'smoke.mjs'), smoke);
  writeFileSync(
    join(payload, 'r2c-plugin.json'),
    `${JSON.stringify({ schema: 'r2c.plugin/v1', version: ENGINE_VERSION, engine: '^0.1.0', files: {} }, null, 2)}\n`,
  );
  return payload;
}

function startRun(env, project, sessionId) {
  const result = cli(
    ['run', '--project-root', project, '--session-id', sessionId, '--json'],
    { env, cwd: project },
  );
  assert.equal(result.status, 0, result.stderr);
  return envelope(result);
}

function fixtureProject(t) {
  const project = tempDir(t, 'fixture-project');
  writeTwoStepProject(project);
  return project;
}

test('user-scope install renders the plugin, patch, hooks and profile entry', (t) => {
  const { home, dshHome, project, env } = setup(t);
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.data.scope, 'user');
  assert.equal(json.data.action, 'installed');
  assert.equal(json.data.runner_cmd, `npx --yes r2c-runner@${ENGINE_VERSION}`);

  const payloadHome = join(home, '.r2c', 'plugin', ENGINE_VERSION);
  for (const file of ['index.mjs', 'package.json', 'cordis.patch.yml', 'hooks.json']) {
    assert.ok(existsSync(join(payloadHome, 'adapters', 'dsh', file)), file);
  }
  const patch = readFileSync(join(payloadHome, 'adapters', 'dsh', 'cordis.patch.yml'), 'utf8');
  assert.ok(!patch.includes('${'), 'patch placeholders are rendered');
  assert.match(patch, /bundledSkillDir:/);
  assert.match(patch, new RegExp(`adapters[\\\\/]dsh[\\\\/]index\\.mjs`));
  assert.match(patch, /runnerCmd:/);
  const hooksText = readFileSync(join(payloadHome, 'adapters', 'dsh', 'hooks.json'), 'utf8');
  assert.ok(!hooksText.includes('${'), 'hooks placeholders are rendered');
  const hooks = JSON.parse(hooksText);
  assert.match(hooks.PreToolUse[0].hooks[0].command, /--event pre-tool-use/);
  assert.match(hooks.Stop[0].hooks[0].command, /--event stop/);

  const manifest = readProfile(dshHome);
  assert.match(manifest.dependencies['r2c-adapter-dsh'], /^link:/);
  assert.ok(manifest.dsh.profile.bundles.includes('r2c-adapter-dsh'));
  assert.ok(existsSync(join(profileDir(dshHome), 'cordis.patch.yml')));

  const receipt = readReceipt(home);
  assert.equal(receipt.steps.profile.name, 'web');
  assert.equal(receipt.steps.profile.dir, profileDir(dshHome));
  assert.match(receipt.steps.bundle_patch, /cordis\.patch\.yml$/);

  const second = install(env, project);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(envelope(second).data.action, 'noop');

  const doctor = cli(['adapter', 'doctor', 'dsh', '--scope', 'user', '--project-root', project, '--json'], { env });
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  const checks = envelope(doctor).data.checks;
  const activated = checks.find((entry) => entry.name === 'plugin.activated');
  assert.equal(activated.status, 'pass', JSON.stringify(activated));
  assert.equal(checks.find((entry) => entry.name === 'discovery').status, 'pass');
  assert.equal(checks.find((entry) => entry.name === 'hooks.sandbox_write').status, 'pass');
  assert.equal(checks.find((entry) => entry.name === 'hooks.launch').status, 'pass');

  const removed = cli(['adapter', 'uninstall', 'dsh', '--scope', 'user', '--project-root', project, '--json'], { env });
  assert.equal(removed.status, 0, removed.stderr);
  const removal = envelope(removed).data;
  assert.equal(removal.payload_removed, true);
  assert.ok(!existsSync(payloadHome));
  const after = readProfile(dshHome);
  assert.equal(after.dependencies['r2c-adapter-dsh'], undefined);
  assert.ok(!after.dsh.profile.bundles.includes('r2c-adapter-dsh'));
  assert.ok(removal.leftover.some((entry) => entry.startsWith('node_modules:')), JSON.stringify(removal.leftover));
  assert.ok(removal.leftover.includes('manual:restart dsh'));
  assert.ok(!existsSync(join(profileDir(dshHome), 'cordis.patch.yml')));
});

test('--profile selects the dsh profile directory', (t) => {
  const { home, dshHome, project, env } = setup(t);
  const result = install(env, project, ['--profile', 'headless']);
  assert.equal(result.status, 0, result.stderr);
  const receipt = readReceipt(home);
  assert.equal(receipt.steps.profile.name, 'headless');
  assert.equal(receipt.steps.profile.dir, profileDir(dshHome, 'headless'));
  assert.ok(existsSync(join(profileDir(dshHome, 'headless'), 'package.json')));
});

test('dsh plugin add is optional: the profile is merged when the command fails', (t) => {
  const { home, dshHome, project, env } = setup(t);
  const result = install(env, project, ['--no-smoke']);
  assert.equal(result.status, 0, result.stderr);
  const failedEnv = { ...env, FAKE_DSH_PLUGIN_ADD: 'fail' };
  const removed = cli(['adapter', 'uninstall', 'dsh', '--scope', 'user', '--project-root', project, '--json'], { env });
  assert.equal(removed.status, 0, removed.stderr);

  const second = cli(
    ['adapter', 'install', 'dsh', '--from', REPO, '--project-root', project, '--no-smoke', '--json'],
    { env: failedEnv, cwd: REPO },
  );
  // dsh is present but its plugin command fails; the adapter must fall back to
  // manual profile edits rather than leaving the bundle unlisted.
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.ok(envelope(second).data.warnings.some((warning) => warning.startsWith('dsh-plugin-add-failed:')));
  const manifest = readProfile(dshHome);
  assert.match(manifest.dependencies['r2c-adapter-dsh'], /^link:/);
  assert.ok(manifest.dsh.profile.bundles.includes('r2c-adapter-dsh'));
});

test('a failed smoke check rolls the profile edits back', (t) => {
  const { home, dshHome, project, env } = setup(t);
  const payload = writePayload(t, { smoke: 'process.exit(3);\n' });
  const before = cli(
    ['adapter', 'install', 'dsh', '--from', payload, '--project-root', project, '--json'],
    { env },
  );
  assert.equal(before.status, 3, before.stderr);
  assert.equal(envelope(before).error.code, 'SMOKE_FAILED');
  assert.ok(!existsSync(join(profileDir(dshHome), 'package.json')));
  assert.ok(!existsSync(join(profileDir(dshHome), 'cordis.patch.yml')));
  assert.ok(!existsSync(userReceipt(home)));
});

test('activation warnings fail doctor instead of passing as a healthy install', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const doctor = cli(
    ['adapter', 'doctor', 'dsh', '--scope', 'user', '--project-root', project, '--json'],
    { env: { ...env, FAKE_DSH_WARNING: '1' } },
  );
  assert.equal(doctor.status, 3, doctor.stdout + doctor.stderr);
  const payload = envelope(doctor);
  assert.equal(payload.error.code, 'DOCTOR_FAILED');
  const check = payload.data.checks.find((entry) => entry.name === 'plugin.activated');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /did not activate/);
});

test('an out-of-range dsh version is a doctor warning, not a failure', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const doctor = cli(
    ['adapter', 'doctor', 'dsh', '--scope', 'user', '--project-root', project, '--json'],
    { env: { ...env, FAKE_DSH_VERSION: '0.3.0' } },
  );
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  const check = envelope(doctor).data.checks.find((entry) => entry.name === 'agent.version');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /0\.3\.0 is outside/);
});

test('mcp servers are appended to the rendered bundle patch and removed with the payload', (t) => {
  const { home, dshHome, project, env } = setup(t);
  const mcpFile = join(tempDir(t, 'mcp'), 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify({
    mcpServers: { 'r2c-sr': { command: 'node', args: ['sr.mjs'], env: { A: '1' } } },
  }));
  const result = install(env, project, ['--mcp', mcpFile]);
  assert.equal(result.status, 0, result.stderr);
  const payloadHome = join(home, '.r2c', 'plugin', ENGINE_VERSION);
  const bundlePatch = join(payloadHome, 'adapters', 'dsh', 'cordis.patch.yml');
  const patch = readFileSync(bundlePatch, 'utf8');
  assert.match(patch, /r2c-mcp-r2c-sr/);
  assert.match(patch, /@deepseek-ai\/dsh-mcp-client/);
  assert.deepEqual(readReceipt(home).steps.mcp, ['r2c-mcp-r2c-sr']);

  const removed = cli(['adapter', 'uninstall', 'dsh', '--scope', 'user', '--project-root', project, '--json'], { env });
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!existsSync(bundlePatch));
  assert.ok(!existsSync(payloadHome));
  assert.ok(!existsSync(join(profileDir(dshHome), 'cordis.patch.yml')));
});

test('pre-tool-use denial is exit 0 + hookSpecificOutput.permissionDecision=deny', (t) => {
  const project = tempDir(t, 'guard-project');
  const result = spawnSync(process.execPath, [
    SHIM,
    '--agent', 'dsh',
    '--event', 'pre-tool-use',
    '--format', 'json',
    '--runner-cmd', `"${process.execPath}" "${BIN}"`,
    '--project-root', project,
  ], {
    cwd: project,
    encoding: 'utf8',
    env: cleanEnv({}),
    input: JSON.stringify({
      session_id: 'sid-guard',
      cwd: project,
      stop_hook_active: false,
      tool_name: 'Write',
      tool_input: { file_path: '.r2c/latest.json' },
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /r2c/);
});

test('the native plugin registers commands, steers on stop and denies guarded tools', async (t) => {
  const { home, project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const payloadHome = join(home, '.r2c', 'plugin', ENGINE_VERSION);
  const plugin = await import(`${pathToFileURL(join(payloadHome, 'adapters', 'dsh', 'index.mjs')).href}?t=${Date.now()}`);
  const listeners = new Map();
  const commands = [];
  const ctx = {
    get(name) {
      if (name !== 'commands') return undefined;
      return { register: (definition) => { commands.push(definition); return () => {}; } };
    },
    on(name, handler) {
      listeners.set(name, handler);
      return () => {};
    },
  };
  plugin.apply(ctx, {
    runnerCmd: `"${process.execPath}" "${BIN}"`,
    projectRoot: project,
    payloadHome,
    shim: join(payloadHome, 'shims', 'hook.mjs'),
    cap: 8,
  });
  assert.deepEqual(
    commands.map((command) => command.name).sort(),
    ['r2c-analysis', 'r2c-cancel', 'r2c-pause', 'r2c-resume', 'r2c-run', 'r2c-status', 'r2c-upload'],
  );
  const sessionId = 'sid-native';
  startRun(env, project, sessionId);

  const steered = [];
  await listeners.get('agent/turn-stopping')({
    agent: { session: { id: sessionId }, steer: (message) => steered.push(message) },
    turn: 1,
    signal: new AbortController().signal,
  });
  assert.equal(steered.length, 1);
  assert.match(steered[0].content[0].text, /下一步|submit/);

  let allowed = 0;
  const next = async () => { allowed += 1; return { kind: 'allow' }; };
  const denied = await listeners.get('tools/pre-execute')({
    name: 'Write',
    arguments: { file_path: '.r2c/latest.json' },
    agent: { session: { id: sessionId } },
  }, next);
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /r2c/);

  const accepted = await listeners.get('tools/pre-execute')({
    name: 'Write',
    arguments: { file_path: 'docs/readme.md' },
    agent: { session: { id: sessionId } },
  }, next);
  assert.equal(accepted.kind, 'allow');
  assert.equal(allowed, 1);
});

test('DSH_SESSION_ID covers a stop when the event has no session id', async (t) => {
  const { home, project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const payloadHome = join(home, '.r2c', 'plugin', ENGINE_VERSION);
  const plugin = await import(`${pathToFileURL(join(payloadHome, 'adapters', 'dsh', 'index.mjs')).href}?t=${Date.now()}-env`);
  let stop;
  plugin.apply({
    get: () => undefined,
    on: (name, handler) => { if (name === 'agent/turn-stopping') stop = handler; return () => {}; },
  }, {
    runnerCmd: `"${process.execPath}" "${BIN}"`,
    projectRoot: project,
    payloadHome,
    shim: join(payloadHome, 'shims', 'hook.mjs'),
  });
  const previous = process.env.DSH_SESSION_ID;
  process.env.DSH_SESSION_ID = 'sid-from-env';
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_SESSION_ID;
    else process.env.DSH_SESSION_ID = previous;
  });
  startRun(env, project, 'sid-from-env');
  const steered = [];
  await assert.doesNotReject(stop({
    agent: { session: { id: undefined }, steer: (message) => steered.push(message) },
    turn: 1,
    signal: new AbortController().signal,
  }));
  assert.equal(steered.length, 1);
});

test('plugin errors are warnings and never reject the turn', async (t) => {
  const { home, project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const payloadHome = join(home, '.r2c', 'plugin', ENGINE_VERSION);
  const plugin = await import(`${pathToFileURL(join(payloadHome, 'adapters', 'dsh', 'index.mjs')).href}?t=${Date.now()}-err`);
  let stop;
  plugin.apply({
    get: () => undefined,
    on: (name, handler) => { if (name === 'agent/turn-stopping') stop = handler; return () => {}; },
  }, {
    runnerCmd: 'definitely-not-a-real-r2c-binary',
    projectRoot: project,
    payloadHome,
    shim: join(payloadHome, 'shims', 'hook.mjs'),
  });
  await assert.doesNotReject(stop({
    agent: { session: { id: 'sid-broken' }, steer: () => { throw new Error('must not steer'); } },
    turn: 1,
    signal: new AbortController().signal,
  }));
});

test('B mode: DSH_SESSION_ID binds a headless run through the runner CLI', (t) => {
  const project = fixtureProject(t);
  const env = cleanEnv({});
  const started = cli(['run', '--project-root', project, '--json'], {
    env: { ...env, DSH_SESSION_ID: 'sid-dsh-headless' },
    cwd: project,
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(envelope(started).session_id, 'sid-dsh-headless');
  const status = cli(['status', '--project-root', project, '--json'], {
    env: { ...env, DSH_SESSION_ID: 'sid-dsh-headless' },
    cwd: project,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(envelope(status).data.run.session_id, 'sid-dsh-headless');
});

test('the bridge path ignores stop_hook_active=false and still caps at 8', (t) => {
  const project = fixtureProject(t);
  const env = cleanEnv({});
  startRun(env, project, 'sid-cap');
  const runnerCmd = `"${process.execPath}" "${BIN}"`;
  const outputs = [];
  for (let index = 0; index < 9; index += 1) {
    const result = spawnSync(process.execPath, [
      SHIM,
      '--agent', 'dsh',
      '--event', 'stop',
      '--format', 'json',
      '--runner-cmd', runnerCmd,
      '--project-root', project,
      '--session-id', 'sid-cap',
    ], {
      cwd: project,
      encoding: 'utf8',
      env,
      input: JSON.stringify({ session_id: 'sid-cap', cwd: project, stop_hook_active: false }),
    });
    assert.equal(result.status, 0, result.stderr);
    outputs.push({ stdout: result.stdout.trim(), stderr: result.stderr });
  }
  for (const output of outputs.slice(0, 8)) {
    const block = JSON.parse(output.stdout);
    assert.equal(block.decision, 'block');
  }
  assert.equal(outputs[8].stdout, '');
  assert.match(outputs[8].stderr, /stop guard capped at 8/);
  assert.match(outputs[8].stderr, /r2c next/);
});
