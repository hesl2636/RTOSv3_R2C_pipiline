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
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-opencode-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake `opencode` on PATH so detection and the version pin never depend on the host. */
function fakeOpencode(t, version = '1.19.5') {
  const dir = tempDir(t, 'bin');
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'opencode.cmd'), `@echo off\r\necho ${version}\r\n`);
  } else {
    const file = join(dir, 'opencode');
    writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

function cleanEnv({ pathDir, home } = {}) {
  const env = { ...process.env };
  for (const key of ['R2C_SESSION_ID', 'R2C_PROJECT_ROOT', 'R2C_PLUGIN_SOURCE', 'R2C_HOME']) {
    delete env[key];
  }
  if (pathDir) env.PATH = `${pathDir}${delimiter}${env.PATH ?? ''}`;
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

function setup(t, { version = '1.19.5' } = {}) {
  const home = tempDir(t, 'home');
  const bin = fakeOpencode(t, version);
  const project = tempDir(t, 'project');
  const env = cleanEnv({ pathDir: bin, home });
  return { home, bin, project, env };
}

function runnerCmd() {
  return `node "${BIN}"`;
}

function install(env, project, extra = []) {
  return cli(
    [
      'adapter', 'install', 'opencode',
      '--from', REPO,
      '--project-root', project,
      '--runner-cmd', runnerCmd(),
      ...extra,
      '--json',
    ],
    { env, cwd: project },
  );
}

function writeWorkflow(project) {
  mkdirSync(join(project, 'workflows'), { recursive: true });
  writeFileSync(
    join(project, 'workflows', 'test.yaml'),
    `schema: r2c.workflow/v1
id: test-workflow
name: test-workflow
version: 0.1.0
description: opencode adapter test
stages:
  - id: stage-1
    name: Stage One
    steps:
      - id: step-1
        name: Step One
        type: prompt
        prompt: First step text.
      - id: step-2
        name: Step Two
        type: prompt
        prompt: Second step text.
`,
  );
}

function startRun(env, project, sessionId) {
  const args = ['run', '--project-root', project, '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  const result = cli(args, { env, cwd: project });
  assert.equal(result.status, 0, result.stderr);
  return envelope(result);
}

async function loadPlugin(project) {
  const file = join(project, '.opencode', 'plugins', 'r2c.ts');
  assert.ok(existsSync(file), file);
  const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  assert.deepEqual(Object.keys(module), ['R2cPlugin']);
  assert.equal(typeof module.R2cPlugin, 'function');
  return module.R2cPlugin;
}

function idle(sessionID) {
  return { type: 'session.idle', properties: { sessionID } };
}

function mockClient() {
  const calls = [];
  return {
    calls,
    session: {
      prompt: async (request) => {
        calls.push(request);
      },
    },
  };
}

function readReceipt(project) {
  return JSON.parse(readFileSync(join(project, '.r2c', 'install', 'opencode.json'), 'utf8'));
}

function check(checks, name) {
  const found = checks.find((entry) => entry.name === name);
  assert.ok(found, `missing doctor check: ${name}`);
  return found;
}

test('install writes commands, skills, agents, plugin and merged opencode.json mcp', (t) => {
  const { project, env } = setup(t);
  const mcpFile = join(tempDir(t, 'mcp'), 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify({ mcp: { 'r2c-sr': { type: 'local', command: ['node', 'sr.mjs'] } } }));
  writeFileSync(
    join(project, 'opencode.json'),
    JSON.stringify({ theme: 'dark', mcp: { foreign: { type: 'local', command: ['foreign'] } } }),
  );

  const result = install(env, project, ['--mcp', mcpFile]);
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.data.action, 'installed');
  assert.equal(json.data.scope, 'project');

  const command = readFileSync(join(project, '.opencode', 'commands', 'r2c-run.md'), 'utf8');
  assert.match(command, /node ".*bin[\\/]r2c\.js" run/);
  assert.ok(!command.includes('<runner>'));
  assert.ok(existsSync(join(project, '.opencode', 'skills', 'code-research', 'SKILL.md')));

  const agents = readFileSync(join(project, '.opencode', 'agents', 'r2c-bys-architect.md'), 'utf8');
  assert.match(agents, /^---\r?\ndescription: r2c workflow role bys-architect/);
  assert.match(agents, /mode: subagent/);
  assert.ok(existsSync(join(project, '.opencode', 'agents', 'r2c-bys-designer.md')));

  const plugin = readFileSync(join(project, '.opencode', 'plugins', 'r2c.ts'), 'utf8');
  assert.match(plugin, /shims[\\/]hook\.mjs/);
  assert.match(plugin, /session\.prompt/);
  assert.ok(!plugin.includes('${PAYLOAD_HOME}'));
  assert.ok(!plugin.includes('${RUNNER_CMD}'));

  const config = JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(Object.keys(config.mcp).sort(), ['foreign', 'r2c-sr']);
  assert.deepEqual(config.mcp['r2c-sr'], { type: 'local', command: ['node', 'sr.mjs'] });

  const receipt = readReceipt(project);
  assert.ok(receipt.files.some((file) => file.path.endsWith(join('.opencode', 'plugins', 'r2c.ts'))));
  assert.deepEqual(receipt.merged.map((entry) => entry.pointer), ['mcp.r2c-sr']);
  assert.equal(receipt.requires.agent, '>=1.19.5 <2');
});

test('user scope lands in ~/.config/opencode and leaves the project untouched', (t) => {
  const { home, project, env } = setup(t);
  const result = install(env, project, ['--scope', 'user']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope(result).data.scope, 'user');

  assert.ok(existsSync(join(home, '.config', 'opencode', 'plugins', 'r2c.ts')));
  assert.ok(existsSync(join(home, '.config', 'opencode', 'commands', 'r2c-run.md')));
  assert.ok(existsSync(join(home, '.config', 'opencode', 'skills', 'code-research', 'SKILL.md')));
  assert.ok(existsSync(join(home, '.config', 'opencode', 'agents', 'r2c-bys-architect.md')));
  assert.ok(!existsSync(join(project, '.opencode')));

  const receipt = JSON.parse(readFileSync(join(home, '.r2c', 'install', 'opencode.json'), 'utf8'));
  assert.equal(receipt.scope, 'user');
});

test('doctor reports plugin wiring, launch, plugin.loaded and the V1 pin', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);

  const result = cli(['adapter', 'doctor', 'opencode', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(result.status, 0, result.stderr);
  const checks = envelope(result).data.checks;
  assert.equal(check(checks, 'hooks.wired').status, 'pass');
  assert.equal(check(checks, 'hooks.launch').status, 'pass');
  assert.equal(check(checks, 'plugin.loaded').status, 'warn');
  assert.match(check(checks, 'plugin.loaded').detail, /r2c\.ts/);
  assert.equal(check(checks, 'platform.pin').status, 'pass');
  assert.equal(check(checks, 'agent.version').status, 'pass');
  assert.equal(check(checks, 'discovery').status, 'pass');
});

test('a version outside the V1 pin warns but does not fail install or doctor', (t) => {
  const { project, env } = setup(t, { version: '1.19.0' });
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(envelope(result).data.warnings.some((warning) => warning.startsWith('agent.below-min')));

  const doctor = cli(['adapter', 'doctor', 'opencode', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(doctor.status, 0, doctor.stderr);
  const checks = envelope(doctor).data.checks;
  assert.equal(check(checks, 'agent.version').status, 'warn');
  assert.equal(check(checks, 'platform.pin').status, 'warn');
  assert.match(check(checks, 'platform.pin').detail, /r2c next --format plain/);
});

test('a deleted plugin fails doctor hooks.wired instead of silently passing', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  rmSync(join(project, '.opencode', 'plugins', 'r2c.ts'));

  const doctor = cli(['adapter', 'doctor', 'opencode', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(doctor.status, 3, doctor.stderr);
  const checks = envelope(doctor).data.checks;
  assert.equal(check(checks, 'hooks.wired').status, 'fail');
  assert.match(check(checks, 'hooks.wired').detail, /plugin carrier missing/);
  assert.equal(check(checks, 'plugin.loaded').status, 'warn');
});

test('session.idle injects once, dedupes (run_id, step_id) and caps a run at 32', async (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  writeWorkflow(project);
  const run = startRun(env, project, 'idle-session');
  const R2cPlugin = await loadPlugin(project);
  const state = R2cPlugin.createIdleState();
  const client = mockClient();

  const first = await R2cPlugin.handleIdle({ event: idle('idle-session'), client, state });
  assert.equal(first.injected, true, first.reason);
  assert.equal(first.runId, run.run_id);
  assert.equal(first.stepId, 'step-1');
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].body.parts[0].text, /## 下一步/);
  assert.match(client.calls[0].body.parts[0].text, /--step step-1/);
  assert.deepEqual(client.calls[0].path, { id: 'idle-session' });

  const second = await R2cPlugin.handleIdle({ event: idle('idle-session'), client, state });
  assert.equal(second.injected, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(client.calls.length, 1);

  const capped = R2cPlugin.createIdleState();
  capped.injections.set(run.run_id, R2cPlugin.INJECTION_CAP);
  const third = await R2cPlugin.handleIdle({ event: idle('idle-session'), client, state: capped });
  assert.equal(third.injected, false);
  assert.equal(third.reason, 'capped');
  assert.equal(client.calls.length, 1);
});

test('the first idle claims a minted cli run through hook stop and injects its step', async (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  writeWorkflow(project);
  const run = startRun(env, project);
  assert.match(run.session_id, /^cli-R/);
  const R2cPlugin = await loadPlugin(project);
  const client = mockClient();

  const result = await R2cPlugin.handleIdle({
    event: idle('oc-real-session'),
    client,
    state: R2cPlugin.createIdleState(),
  });
  assert.equal(result.injected, true, result.reason);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].body.parts[0].text, /--session-id oc-real-session/);

  const latest = JSON.parse(readFileSync(join(project, '.r2c', 'latest.json'), 'utf8'));
  assert.equal(latest.runs['oc-real-session'].active_run_id, run.run_id);
});

test('no run means an empty hook stop: exit 0, no injection', async (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const R2cPlugin = await loadPlugin(project);
  const client = mockClient();

  const result = await R2cPlugin.handleIdle({
    event: idle('no-run-session'),
    client,
    state: R2cPlugin.createIdleState(),
  });
  assert.equal(result.injected, false);
  assert.equal(result.reason, 'no-run');
  assert.equal(client.calls.length, 0);
});

test('tool.execute.before throws on a protected write and passes ordinary writes', async (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  writeWorkflow(project);
  const run = startRun(env, project, 'guard-session');
  const R2cPlugin = await loadPlugin(project);

  const protectedFile = join(project, '.r2c', 'runs', run.run_id, 'state.json');
  await assert.rejects(
    R2cPlugin.guardTool({
      input: { tool: 'write', sessionID: 'guard-session' },
      output: { args: { filePath: protectedFile, content: '{}' } },
    }),
    /denied|guard/i,
  );

  const allowed = await R2cPlugin.guardTool({
    input: { tool: 'write', sessionID: 'guard-session' },
    output: { args: { filePath: join(project, 'src', 'safe.txt'), content: 'ok' } },
  });
  assert.equal(allowed.blocked, false);
});

test('uninstall removes the plugin and only our mcp entry', (t) => {
  const { project, env } = setup(t);
  const mcpFile = join(tempDir(t, 'mcp'), 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify({ mcp: { 'r2c-sr': { type: 'local', command: ['node', 'sr.mjs'] } } }));
  const foreign = { theme: 'dark', mcp: { foreign: { type: 'local', command: ['foreign'] } } };
  writeFileSync(join(project, 'opencode.json'), JSON.stringify(foreign));
  assert.equal(install(env, project, ['--mcp', mcpFile]).status, 0);

  const removed = cli(['adapter', 'uninstall', 'opencode', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(envelope(removed).data.action, 'removed');
  assert.ok(!existsSync(join(project, '.opencode', 'plugins', 'r2c.ts')));
  assert.ok(!existsSync(join(project, '.opencode', 'commands', 'r2c-run.md')));
  assert.ok(!existsSync(join(project, '.opencode', 'agents', 'r2c-bys-architect.md')));
  assert.deepEqual(JSON.parse(readFileSync(join(project, 'opencode.json'), 'utf8')), foreign);
  assert.ok(existsSync(join(project, '.r2c')));
});
