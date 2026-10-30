import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
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
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dropPayloadManifest, writeTwoStepProject } from './helpers/two-step.js';
import { writeEngine } from './helpers/engine.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const ENGINE_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const COMMAND_IDS = ['analysis', 'cancel', 'pause', 'resume', 'run', 'status', 'upload'];

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-codex-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake codex on PATH (or at an explicit path) with a controllable version. */
function fakeCodex(t, version = '0.165.0') {
  const dir = tempDir(t, 'bin');
  if (process.platform === 'win32') {
    writeFileSync(
      join(dir, 'codex.cmd'),
      `@echo off\r\nif "%1"=="--version" (\r\necho codex-cli ${version}\r\nexit /b 0\r\n)\r\nexit /b 1\r\n`,
    );
  } else {
    const file = join(dir, 'codex');
    writeFileSync(
      file,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi\nexit 1\n`,
    );
    chmodSync(file, 0o755);
  }
  return { dir, bin: join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex') };
}

function cleanEnv({ pathDir, home, localAppData } = {}) {
  const env = { ...process.env };
  for (const key of [
    'R2C_SESSION_ID',
    'R2C_PROJECT_ROOT',
    'R2C_PLUGIN_SOURCE',
    'R2C_CODEX_BIN',
  ]) {
    delete env[key];
  }
  if (pathDir !== undefined) {
    // Windows environment keys are case-insensitive; drop any existing casing
    // so the child really sees only the directories the test names.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
    env.PATH = pathDir;
  }
  if (home !== undefined) {
    env.R2C_HOME = home;
    env.HOME = home;
    env.USERPROFILE = home;
  }
  if (localAppData !== undefined) env.LOCALAPPDATA = localAppData;
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

function setup(t, { version = '0.165.0', projectName = 'project' } = {}) {
  const home = tempDir(t, 'home');
  const codex = fakeCodex(t, version);
  const base = tempDir(t, 'root');
  const project = join(base, projectName);
  mkdirSync(project, { recursive: true });
  const env = cleanEnv({
    pathDir: `${codex.dir}${delimiter}${dirname(process.execPath)}`,
    home,
  });
  return { home, codex, project, env };
}

function install(env, project, extra = []) {
  return cli(
    ['adapter', 'install', 'codex', '--from', REPO, '--project-root', project, ...extra, '--json'],
    { env },
  );
}

function receiptPath(project) {
  return join(project, '.r2c', 'install', 'codex.json');
}

function readReceipt(project) {
  return JSON.parse(readFileSync(receiptPath(project), 'utf8'));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function posix(value) {
  return value.replaceAll('\\', '/');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** path → {size, mtime, content} for every file under `root`. */
function snapshot(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === '.lock') continue;
      const data = readFileSync(full);
      files.set(relative(root, full), {
        size: data.length,
        mtime: statSync(full).mtimeMs,
        text: data.toString('base64'),
      });
    }
  };
  walk(root);
  return files;
}

function expectedCommandCount() {
  return readdirSync(join(REPO, 'pack', 'commands')).filter((name) => /^r2c-.*\.md$/.test(name)).length;
}

function expectedSkillCount() {
  return readdirSync(join(REPO, 'pack', 'skills')).length;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}

/** Payload files copied into the project root by every install. */
function expectedLayoutCount() {
  return ['workflows', 'tasks', 'skills']
    .reduce((total, dir) => total + countFiles(join(REPO, 'pack', dir)), 0);
}

test('install writes command skills, skills, agents, hooks and a receipt', (t) => {
  const { project, env } = setup(t);
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.command, 'adapter.install');
  assert.equal(json.data.action, 'installed');
  assert.equal(json.data.changed, true);
  assert.equal(json.data.scope, 'project');
  assert.equal(json.data.requires.agent, '>=0.165.0 <1');
  assert.equal(json.data.agent.version, '0.165.0');

  for (const id of COMMAND_IDS) {
    const file = join(project, '.agents', 'skills', `r2c-${id}`, 'SKILL.md');
    assert.ok(existsSync(file), file);
    const text = readFileSync(file, 'utf8');
    assert.match(text, new RegExp(`^---\\r?\\nname: r2c-${id}\\r?\\ndescription: .+\\r?\\n---`));
    assert.ok(!text.includes('<runner>'), `${id} kept the <runner> placeholder`);
  }
  const run = readFileSync(join(project, '.agents', 'skills', 'r2c-run', 'SKILL.md'), 'utf8');
  assert.match(run, new RegExp(`node ${escapeRegExp(posix(BIN))} run`));
  assert.match(run, /--input "\$ARGUMENTS"/);

  const skills = readdirSync(join(project, '.agents', 'skills'))
    .filter((name) => existsSync(join(project, '.agents', 'skills', name, 'SKILL.md')));
  assert.equal(skills.length, expectedCommandCount() + expectedSkillCount());

  const agentsDir = join(project, '.codex', 'agents');
  const agents = readdirSync(agentsDir).filter((name) => /^r2c-.*\.toml$/.test(name));
  assert.ok(agents.length >= 1);
  for (const name of agents) {
    const text = readFileSync(join(agentsDir, name), 'utf8');
    assert.match(text, /^name = "r2c-/);
    assert.match(text, /developer_instructions/);
    assert.ok(!text.includes('${'));
  }

  const hooks = readJson(join(project, '.codex', 'hooks.json'));
  assert.equal(hooks.hooks.Stop.length, 1);
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  const stop = hooks.hooks.Stop[0].hooks[0];
  assert.equal(stop.type, 'command');
  assert.match(stop.command, /shims\/hook\.mjs/);
  assert.match(stop.command, /--event stop/);
  assert.match(stop.command, /--project-root/);
  assert.ok(!stop.command.includes('${'));
  assert.equal(posix(stop.commandWindows), './.codex/r2c-hook-stop.cmd');

  const receipt = readReceipt(project);
  assert.equal(receipt.runner_cmd, `node ${posix(BIN)}`);
  assert.equal(receipt.adapter, 'codex');
  assert.equal(receipt.scope, 'project');
  const configFiles = receipt.files.filter((file) => file.kind !== 'layout');
  assert.equal(configFiles.length, expectedCommandCount() + expectedSkillCount() + agents.length + 3);
  const kinds = new Set(configFiles.map((file) => file.kind));
  for (const kind of ['wrap-skill', 'copy', 'derive-agent', 'render']) assert.ok(kinds.has(kind), kind);
  for (const file of configFiles) {
    const text = readFileSync(file.path, 'utf8');
    assert.ok(!text.includes('npx'), file.path);
    assert.ok(!text.includes('r2c-runner'), file.path);
  }
  const layoutFiles = receipt.files.filter((file) => file.kind === 'layout');
  assert.equal(layoutFiles.length, expectedLayoutCount());
  for (const file of layoutFiles) assert.ok(existsSync(join(project, file.path)), file.path);
  assert.equal(receipt.agent.version, '0.165.0');
  assert.deepEqual(receipt.manual, [
    'run /hooks in codex and trust the r2c Stop and PreToolUse hooks (non-interactive bypass: --dangerously-bypass-hook-trust)',
  ]);
});

test('a second install with the same arguments is a zero-write noop', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const receiptMtime = statSync(receiptPath(project)).mtimeMs;
  const before = snapshot(project);

  const second = install(env, project);
  assert.equal(second.status, 0, second.stderr);
  const json = envelope(second);
  assert.equal(json.data.action, 'noop');
  assert.equal(json.data.changed, false);
  assert.equal(json.data.files.length, 0);
  assert.equal(statSync(receiptPath(project)).mtimeMs, receiptMtime);
  assert.deepEqual(snapshot(project), before);
});

test('codex is project-scope only', (t) => {
  const { project, env } = setup(t);
  const result = cli(
    ['adapter', 'install', 'codex', '--from', REPO, '--project-root', project, '--scope', 'user', '--json'],
    { env },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.equal(envelope(result).error.code, 'SCOPE_UNSUPPORTED');
});

test('detect falls back to R2C_CODEX_BIN and then the desktop build glob', (t) => {
  const emptyPath = tempDir(t, 'empty-path');

  const envHome = tempDir(t, 'env-home');
  const envCodex = fakeCodex(t, '0.165.4');
  const envProject = tempDir(t, 'env-project');
  const envEnv = cleanEnv({ pathDir: emptyPath, home: envHome });
  envEnv.R2C_CODEX_BIN = envCodex.bin;
  const viaEnv = install(envEnv, envProject);
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  const envReceipt = readReceipt(envProject);
  assert.equal(posix(envReceipt.agent.bin), posix(envCodex.bin));
  assert.equal(envReceipt.agent.version, '0.165.4');

  if (process.platform !== 'win32') return;
  const localAppData = tempDir(t, 'localappdata');
  const globDir = join(localAppData, 'OpenAI', 'Codex', 'bin', 'deadbeef');
  mkdirSync(globDir, { recursive: true });
  const globBin = join(globDir, 'codex.exe');
  try {
    linkSync(process.execPath, globBin);
  } catch {
    // Hardlinks need the same volume; the env fallback above is still covered.
    return;
  }
  const globHome = tempDir(t, 'glob-home');
  const globProject = tempDir(t, 'glob-project');
  const globEnv = cleanEnv({ pathDir: emptyPath, home: globHome, localAppData });
  const viaGlob = install(globEnv, globProject);
  assert.equal(viaGlob.status, 0, viaGlob.stderr);
  const globReceipt = readReceipt(globProject);
  assert.equal(posix(globReceipt.agent.bin), posix(globBin));
  assert.match(globReceipt.agent.version, /^\d+\.\d+\.\d+/);
});

test('hooks.json and the .cmd launcher survive a project path with a space', (t) => {
  const { project, env } = setup(t, { projectName: 'project with space' });
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);

  const hooksFile = join(project, '.codex', 'hooks.json');
  const document = readJson(hooksFile);
  const stop = document.hooks.Stop[0].hooks[0];
  const preToolUse = document.hooks.PreToolUse[0].hooks[0];
  // Project scope records everything relative to the project root (C3), which
  // is what makes a renamed or moved project keep working.
  assert.equal(posix(stop.commandWindows), './.codex/r2c-hook-stop.cmd');
  assert.equal(posix(preToolUse.commandWindows), './.codex/r2c-hook-pre-tool-use.cmd');
  assert.ok(!stop.commandWindows.includes('"'), 'commandWindows must not carry quoted arguments');
  assert.ok(!posix(stop.command).includes(posix(project)), stop.command);
  assert.match(stop.command, /--project-root '\.'/);
  assert.ok(stop.command.startsWith('node '), 'POSIX launch uses node');
  assert.ok(!stop.command.includes('npx'));
  assert.ok(!stop.command.includes('r2c-runner'));

  const cmdFile = join(project, '.codex', 'r2c-hook-stop.cmd');
  const cmd = readFileSync(cmdFile, 'utf8');
  assert.ok(cmd.includes(`"${process.execPath}"`), 'node path is quoted inside the .cmd');
  assert.ok(
    cmd.includes(`".r2c/payload/${ENGINE_VERSION}/shims/hook.mjs"`),
    'shim path is quoted inside the .cmd',
  );
  assert.match(cmd, /--event stop/);
  assert.match(cmd, /--project-root "\."/);
  assert.ok(!cmd.includes(posix(project)), cmd);

  if (process.platform !== 'win32') {
    // A .cmd launcher is a Windows artifact; its content is asserted above.
    assert.ok(existsSync(cmdFile));
    return;
  }
  // Codex runs the relative launcher from the project directory, so this is
  // also the check that a moved project still starts the hook.
  const launch = spawnSync(process.env.ComSpec, ['/d', '/c', stop.commandWindows], {
    cwd: project,
    encoding: 'utf8',
    input: '{}',
    windowsHide: true,
  });
  assert.equal(launch.status, 0, launch.stderr);
  const trace = join(project, '.r2c', 'runs', '.hooks', 'trace', 'codex.jsonl');
  assert.ok(existsSync(trace));
  assert.match(readFileSync(trace, 'utf8'), /"hook":"stop".*"no-session"/);

  // The launcher, the shim path and --project-root are all project-relative,
  // so the same command still starts the hook after a rename.
  rmSync(trace, { force: true });
  const moved = join(dirname(project), `${basename(project)}-renamed`);
  renameSync(project, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  const relaunch = spawnSync(process.env.ComSpec, ['/d', '/c', stop.commandWindows], {
    cwd: moved,
    encoding: 'utf8',
    input: '{}',
    windowsHide: true,
  });
  assert.equal(relaunch.status, 0, relaunch.stderr);
  assert.ok(
    existsSync(join(moved, '.r2c', 'runs', '.hooks', 'trace', 'codex.jsonl')),
    'the moved project gets its own hook trace',
  );
});

function hookLauncher(project) {
  const document = readJson(join(project, '.codex', 'hooks.json'));
  const win = process.platform === 'win32';
  const pick = (event) => {
    const handler = document.hooks[event][0].hooks[0];
    return win ? handler.commandWindows : handler.command;
  };
  return { stop: pick('Stop'), preToolUse: pick('PreToolUse') };
}

function launchHook(command, project, payload) {
  const win = process.platform === 'win32';
  const shell = win ? process.env.ComSpec : '/bin/sh';
  const args = win ? ['/d', '/c', command] : ['-c', command];
  return spawnSync(shell, args, {
    cwd: project,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    windowsHide: true,
    timeout: 60_000,
  });
}

test('the installed Stop hook delivers next --format plain and caps at 8', (t) => {
  if (BIN.includes(' ')) {
    t.skip('the custom runner command cannot carry a path with a space in the .cmd');
    return;
  }
  const { project, env } = setup(t);
  const runnerCmd = `node ${BIN.replaceAll('\\', '/')}`;
  assert.equal(install(env, project, ['--runner-cmd', runnerCmd]).status, 0);

  dropPayloadManifest(project);
  writeTwoStepProject(project);
  const started = cli(
    ['run', '--project-root', project, '--session-id', 'sess-codex-a', '--runner-cmd', runnerCmd],
    { cwd: project, env },
  );
  assert.equal(started.status, 0, started.stderr);
  const expected = cli(
    ['next', '--project-root', project, '--session-id', 'sess-codex-a', '--format', 'plain'],
    { cwd: project, env },
  );
  assert.equal(expected.status, 0, expected.stderr);

  const launcher = hookLauncher(project);
  const payload = {
    session_id: 'sess-codex-a',
    cwd: project.replaceAll('\\', '/'),
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = launchHook(launcher.stop, project, payload);
    assert.equal(result.status, 0, result.stderr);
    const envelopeJson = JSON.parse(result.stdout.trim());
    assert.equal(envelopeJson.decision, 'block');
    assert.equal(envelopeJson.reason.trim(), expected.stdout.trim());
  }
  const capped = launchHook(launcher.stop, project, payload);
  assert.equal(capped.status, 0);
  assert.equal(capped.stdout, '');
  assert.match(capped.stderr, /capped at 8/);

  const denied = launchHook(launcher.preToolUse, project, {
    session_id: 'sess-codex-a',
    cwd: project.replaceAll('\\', '/'),
    hook_event_name: 'PreToolUse',
    tool_name: 'write',
    tool_input: { file_path: join(project, '.r2c', 'runs', 'x', 'state.json') },
  });
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout.trim()).permissionDecision, 'deny');

  const allowed = launchHook(launcher.preToolUse, project, {
    session_id: 'sess-codex-a',
    cwd: project.replaceAll('\\', '/'),
    hook_event_name: 'PreToolUse',
    tool_name: 'write',
    tool_input: { file_path: join(project, '.r2c', 'ir.md') },
  });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '');
});

test('untrusted or absent hooks never block the B-mode run -> submit chain', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);

  // Codex silently skips hooks that have not been trusted via /hooks. Simulate
  // the strongest form of that (hooks absent) and prove the runner chain is
  // unaffected: run and submit are the B-mode path.
  rmSync(join(project, '.codex', 'hooks.json'), { force: true });
  rmSync(join(project, '.codex', 'r2c-hook-stop.cmd'), { force: true });
  rmSync(join(project, '.codex', 'r2c-hook-pre-tool-use.cmd'), { force: true });

  dropPayloadManifest(project);
  writeTwoStepProject(project);

  const started = cli(['run', '--project-root', project], { cwd: project, env });
  assert.equal(started.status, 0, started.stderr);
  const sid = /--session-id (\S+)/.exec(started.stdout)?.[1];
  assert.ok(sid, started.stdout);
  assert.match(started.stdout, /^## 下一步：第一步（阶段：阶段一）$/m);

  const submitted = cli(
    ['submit', '--project-root', project, '--session-id', sid, '--step', 'step-a'],
    { cwd: project, env },
  );
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(submitted.stdout, /^## 下一步：第二步（阶段：阶段二）$/m);
  assert.ok(!existsSync(join(project, '.r2c', 'runs', '.hooks', 'trace', 'codex.jsonl')));
});

test('doctor passes launch/sandbox write, warns manual trust and the desktop build', (t) => {
  const { project, env } = setup(t, { version: '0.163.0-alpha.11.2', projectName: 'project with space' });
  assert.equal(install(env, project).status, 0);

  const result = cli(
    ['adapter', 'doctor', 'codex', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  const byName = Object.fromEntries(json.data.checks.map((check) => [check.name, check]));
  assert.equal(byName['hooks.wired'].status, 'pass');
  assert.equal(byName['hooks.launch'].status, 'pass');
  assert.equal(byName['hooks.sandbox_write'].status, 'pass');
  assert.equal(byName.discovery.status, 'pass');
  assert.match(byName.discovery.detail, /"commands":7/);
  assert.equal(byName.manual.status, 'warn');
  assert.match(byName.manual.detail, /\/hooks/);
  assert.equal(byName['agent.version'].status, 'warn');
  assert.match(byName['agent.version'].detail, /desktop build, not an acceptance baseline/);
  assert.equal(json.data.healthy, true);

  const smoke = cli(
    ['adapter', 'smoke', 'codex', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.equal(envelope(smoke).data.ok, true);
});

test('uninstall follows the receipt; only the /hooks trust step is left', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  writeFileSync(join(project, '.r2c', 'ir.md'), '# interface requirements\n');

  const removed = cli(
    ['adapter', 'uninstall', 'codex', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(removed.status, 0, removed.stderr);
  const json = envelope(removed);
  assert.equal(json.data.action, 'removed');
  assert.deepEqual(json.data.leftover, [
    'manual:run /hooks in codex and trust the r2c Stop and PreToolUse hooks (non-interactive bypass: --dangerously-bypass-hook-trust)',
  ]);
  assert.ok(!existsSync(join(project, '.agents')));
  assert.ok(!existsSync(join(project, '.codex')));
  assert.ok(existsSync(join(project, '.r2c', 'ir.md')), 'runtime/business state is kept');
  assert.ok(!existsSync(receiptPath(project)));

  const again = cli(
    ['adapter', 'uninstall', 'codex', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(again.status, 4, again.stderr);
  assert.equal(envelope(again).error.code, 'NOT_INSTALLED');
});

test('adapter list reports the codex contract from adapter.json', (t) => {
  const { env } = setup(t);
  const result = cli(['adapter', 'list', '--from', REPO, '--json'], { env, cwd: REPO });
  assert.equal(result.status, 0, result.stderr);
  const codex = envelope(result).data.adapters.find((adapter) => adapter.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.version, ENGINE_VERSION);
  assert.equal(codex.engine, '^0.1.0');
  assert.equal(codex.agent, '>=0.165.0 <1');
  assert.equal(codex.engine_satisfied, true);
});
