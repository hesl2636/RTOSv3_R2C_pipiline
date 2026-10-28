import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const ENGINE_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const LIVE = process.env.R2C_LIVE_OMP === '1';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-omp-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Fake `omp` on PATH. `--version` reports 18.13.2; `skill list --json` scans
 * the project/user skill roots exactly like omp's native provider (0-byte and
 * description-less SKILL.md files are skipped). Invocations are logged so a
 * test can prove `omp plugin link` was never called.
 */
function fakeOmp(t) {
  const dir = tempDir(t, 'bin');
  const script = join(dir, 'fake-omp.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const log = process.env.R2C_FAKE_OMP_LOG;
if (log) appendFileSync(log, args.join(' ') + '\\n');

if (args.includes('--version')) {
  process.stdout.write('omp/18.13.2\\n');
  process.exit(0);
}

if (args[0] === 'skill' && args[1] === 'list') {
  const cwd = process.cwd();
  const roots = [join(cwd, '.omp', 'skills'), join(cwd, '.omp', 'agent', 'skills')];
  const skills = [];
  for (const base of roots) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(base, entry.name, 'SKILL.md');
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/.exec(text);
      if (!match) continue;
      let name = null;
      let description = null;
      for (const line of match[1].split(/\\r?\\n/)) {
        const separator = line.indexOf(':');
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key === 'name') name = value;
        if (key === 'description') description = value;
      }
      if (!name || !description) continue;
      skills.push({
        name,
        description,
        filePath: file,
        baseDir: join(base, entry.name),
        source: base.includes(join('.omp', 'agent', 'skills')) ? 'native:user' : 'native:project',
      });
    }
  }
  process.stdout.write(JSON.stringify({ skills }) + '\\n');
  process.exit(0);
}

process.exit(0);
`,
  );
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'omp.cmd'), '@echo off\r\nnode "%~dp0fake-omp.mjs" %*\r\n');
  } else {
    const file = join(dir, 'omp');
    writeFileSync(file, '#!/bin/sh\nexec node "$(dirname "$0")/fake-omp.mjs" "$@"\n');
    chmodSync(file, 0o755);
  }
  return dir;
}

function cleanEnv({ pathDir, home, log } = {}) {
  const env = { ...process.env };
  for (const key of ['R2C_SESSION_ID', 'R2C_PROJECT_ROOT', 'R2C_PLUGIN_SOURCE']) delete env[key];
  if (pathDir) env.PATH = `${pathDir}${delimiter}${env.PATH ?? ''}`;
  if (home) {
    env.R2C_HOME = home;
    env.HOME = home;
    env.USERPROFILE = home;
  }
  if (log) env.R2C_FAKE_OMP_LOG = log;
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

function setup(t, { fake = true } = {}) {
  const home = tempDir(t, 'home');
  const bin = fake ? fakeOmp(t) : null;
  const project = tempDir(t, 'project');
  const log = fake ? join(tempDir(t, 'log'), 'omp.log') : null;
  const env = cleanEnv({ pathDir: bin, home, log });
  return { home, bin, project, env, log };
}

function install(env, project, extra = []) {
  return cli(
    ['adapter', 'install', 'omp', '--from', REPO, '--project-root', project, ...extra, '--json'],
    { env },
  );
}

function receiptPath(root) {
  return join(root, '.r2c', 'install', 'omp.json');
}

function readReceipt(root) {
  return JSON.parse(readFileSync(receiptPath(root), 'utf8'));
}

test('project install writes .omp files, never touches user scope, and never links a plugin', (t) => {
  const { home, project, env, log } = setup(t);
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.command, 'adapter.install');
  assert.equal(json.data.scope, 'project');
  assert.equal(json.data.action, 'installed');

  const commands = readdirSync(join(project, '.omp', 'commands')).sort();
  assert.equal(commands.length, 7);
  assert.ok(commands.includes('r2c-run.md'));
  const run = readFileSync(join(project, '.omp', 'commands', 'r2c-run.md'), 'utf8');
  assert.match(run, new RegExp(`npx --yes r2c-runner@${ENGINE_VERSION} run`));
  assert.ok(!run.includes('<runner>'));

  const skills = readdirSync(join(project, '.omp', 'skills')).sort();
  assert.equal(skills.length, 35);
  const skill = readFileSync(join(project, '.omp', 'skills', 'code-research', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: code-research\r?\n/);
  assert.match(skill, /\ndescription: [^\n]*占位/);

  const agents = readdirSync(join(project, '.omp', 'agents')).sort();
  assert.deepEqual(agents, [
    'r2c-bys-architect.md',
    'r2c-bys-designer.md',
    'r2c-bys-impl-lead.md',
    'r2c-bys-release-lead.md',
  ]);
  const agent = readFileSync(join(project, '.omp', 'agents', 'r2c-bys-architect.md'), 'utf8');
  assert.match(agent, /^---\r?\nname: r2c-bys-architect\r?\ndescription: /);
  assert.ok(agent.includes('npx --yes r2c-runner'));

  for (const relative of ['hooks/post/r2c-stop.ts', 'hooks/pre/r2c-guard.ts']) {
    assert.ok(existsSync(join(project, '.omp', ...relative.split('/'))), relative);
  }
  const stop = readFileSync(join(project, '.omp', 'hooks', 'post', 'r2c-stop.ts'), 'utf8');
  assert.ok(stop.includes('event.session_id'));
  assert.ok(stop.includes('stop_hook_active'));
  assert.ok(stop.includes('process.env.PATH'));
  assert.ok(stop.includes('try'));
  assert.ok(!stop.includes('process.execPath'));
  assert.ok(!stop.includes('<runner>'));
  const guard = readFileSync(join(project, '.omp', 'hooks', 'pre', 'r2c-guard.ts'), 'utf8');
  assert.ok(guard.includes('ctx?.sessionManager?.getSessionId?.()'));
  assert.ok(guard.includes('process.env.PATH'));
  assert.ok(guard.includes('try'));
  assert.ok(!guard.includes('process.execPath'));

  const mcp = JSON.parse(readFileSync(join(project, '.omp', 'mcp.json'), 'utf8'));
  assert.equal(typeof mcp, 'object');

  const receipt = readReceipt(project);
  assert.equal(receipt.payload.version, ENGINE_VERSION);
  assert.equal(receipt.requires.agent, '>=18.13.2 <19');
  assert.ok(receipt.files.some((file) => file.path.endsWith('r2c-run.md') && file.kind === 'render'));
  assert.ok(receipt.files.some((file) => file.path.endsWith('r2c-stop.ts') && file.kind === 'render'));
  assert.ok(receipt.files.some((file) => file.path.endsWith('SKILL.md') && file.kind === 'copy'));

  assert.ok(!existsSync(join(home, '.omp')), 'project install must not write user scope');
  assert.ok(!existsSync(join(home, '.r2c')), 'project install must not write user state');

  const invocations = readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.ok(invocations.length > 0);
  for (const line of invocations) {
    assert.ok(line === '--version' || line === 'skill list --json', line);
  }
  assert.ok(!invocations.some((line) => line.includes('plugin')), 'project scope must not call omp plugin');
});

test('doctor discovery passes on a clean install and fails when a skill is emptied', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);

  const clean = cli(['adapter', 'doctor', 'omp', '--project-root', project, '--json'], { env });
  assert.equal(clean.status, 0, clean.stderr);
  const cleanChecks = envelope(clean).data.checks;
  assert.equal(cleanChecks.find((check) => check.name === 'discovery').status, 'pass');
  assert.equal(cleanChecks.find((check) => check.name === 'hooks.launch').status, 'pass');
  assert.equal(cleanChecks.find((check) => check.name === 'scope.conflict').status, 'pass');

  writeFileSync(join(project, '.omp', 'skills', 'code-research', 'SKILL.md'), '');
  const broken = cli(['adapter', 'doctor', 'omp', '--project-root', project, '--json'], { env });
  assert.equal(broken.status, 3, broken.stderr);
  const checks = envelope(broken).data.checks;
  assert.equal(checks.find((check) => check.name === 'receipt.files').status, 'fail');
  const discovery = checks.find((check) => check.name === 'discovery');
  assert.equal(discovery.status, 'fail');
  assert.match(discovery.detail, /code-research/);
});

test('uninstall removes adapter files and keeps .r2c runtime state', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  writeFileSync(join(project, '.r2c', 'ir.md'), '# interface requirements\n');

  const removed = cli(['adapter', 'uninstall', 'omp', '--project-root', project, '--json'], { env });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(envelope(removed).data.action, 'removed');
  assert.ok(!existsSync(receiptPath(project)));
  assert.ok(!existsSync(join(project, '.omp', 'commands', 'r2c-run.md')));
  assert.ok(!existsSync(join(project, '.omp', 'skills', 'code-research', 'SKILL.md')));
  assert.ok(!existsSync(join(project, '.omp', 'hooks', 'post', 'r2c-stop.ts')));
  assert.ok(!existsSync(join(project, '.omp', 'agents', 'r2c-bys-architect.md')));
  assert.ok(existsSync(join(project, '.r2c', 'ir.md')), '.r2c business state survives');
  assert.ok(!existsSync(join(project, '.r2c', 'plugin', ENGINE_VERSION)));

  const again = cli(['adapter', 'uninstall', 'omp', '--project-root', project, '--json'], { env });
  assert.equal(again.status, 4, again.stderr);
  assert.equal(envelope(again).error.code, 'NOT_INSTALLED');
});

test('user scope installs under ~/.omp/agent and leaves the project untouched', (t) => {
  const { home, project, env } = setup(t);
  const result = install(env, project, ['--scope', 'user']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope(result).data.scope, 'user');

  assert.ok(existsSync(join(home, '.omp', 'agent', 'commands', 'r2c-run.md')));
  assert.ok(existsSync(join(home, '.omp', 'agent', 'skills', 'code-research', 'SKILL.md')));
  assert.ok(existsSync(join(home, '.omp', 'agent', 'agents', 'r2c-bys-architect.md')));
  assert.ok(existsSync(join(home, '.omp', 'agent', 'hooks', 'post', 'r2c-stop.ts')));
  assert.ok(existsSync(join(home, '.omp', 'agent', 'hooks', 'pre', 'r2c-guard.ts')));
  assert.ok(existsSync(join(home, '.omp', 'agent', 'mcp.json')));
  assert.ok(!existsSync(join(project, '.omp')));

  const removed = cli(
    ['adapter', 'uninstall', 'omp', '--project-root', project, '--scope', 'user', '--json'],
    { env },
  );
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!existsSync(join(home, '.omp', 'agent', 'commands', 'r2c-run.md')));
});

test(
  'live: real omp skill list discovers every installed project skill',
  { skip: LIVE ? false : 'set R2C_LIVE_OMP=1 to run against a real omp', timeout: 300_000 },
  (t) => {
    const probe = spawnSync('omp', ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (probe.error || probe.status !== 0) {
      t.skip(`omp unavailable: ${probe.error?.message ?? `exit ${probe.status}`}`);
      return;
    }
    const version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(probe.stdout ?? '');
    if (version === null || version[1] !== '18.13.2') {
      t.skip(`expected omp 18.13.2, got ${version?.[1] ?? 'unknown'}`);
      return;
    }

    const { home, project, env } = setup(t, { fake: false });
    const installed = install(env, project);
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(existsSync(join(project, '.omp', 'skills', 'code-research', 'SKILL.md')));

    const listed = spawnSync('omp', ['skill', 'list', '--json'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    if (listed.error || listed.status !== 0) {
      t.skip(`omp skill list unavailable: ${listed.error?.message ?? `exit ${listed.status}`}`);
      return;
    }
    /** @type {{skills?: Array<{name?: string, description?: string, filePath?: string, source?: string}>}} */
    const parsed = JSON.parse(listed.stdout.trim());
    const byName = new Map((parsed.skills ?? []).map((skill) => [skill.name, skill]));
    const expected = readdirSync(join(REPO, 'pack', 'skills')).sort();
    assert.equal(expected.length, 35);
    for (const name of expected) {
      const skill = byName.get(name);
      assert.ok(skill, `omp did not list ${name}`);
      assert.equal(typeof skill.description, 'string');
      assert.ok(skill.description.trim() !== '', `${name} has no description`);
      assert.equal(skill.source, 'native:project', `${name} was not discovered from the project`);
      assert.match(skill.filePath ?? '', new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const relative of [
      ['commands', 'r2c-run.md'],
      ['skills', 'code-research', 'SKILL.md'],
      ['agents', 'r2c-bys-architect.md'],
      ['hooks', 'post', 'r2c-stop.ts'],
      ['mcp.json'],
    ]) {
      assert.ok(
        !existsSync(join(home, '.omp', 'agent', ...relative)),
        `project install leaked into user scope: ${relative.join('/')}`,
      );
    }
  },
);
