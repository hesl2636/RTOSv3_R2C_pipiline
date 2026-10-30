import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withPath } from './support/env.js';
import { createDirLink, linkTarget } from '../src/adapter/util.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const ENGINE_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-adapter-${prefix}-`));
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
  for (const key of [
    'R2C_SESSION_ID',
    'R2C_PROJECT_ROOT',
    'R2C_PLUGIN_SOURCE',
  ]) {
    delete env[key];
  }
  if (pathDir) withPath(env, pathDir);
  if (home) {
    env.R2C_HOME = home;
    env.HOME = home;
    env.USERPROFILE = home;
  }
  return env;
}

function cli(args, { env, cwd } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env,
  });
  return result;
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
  const bin = fakeClaude(t);
  const project = tempDir(t, 'project');
  const env = cleanEnv({ pathDir: bin, home });
  return { home, bin, project, env };
}

function install(env, project, extra = []) {
  return cli(
    ['adapter', 'install', 'claude-code', '--from', REPO, '--project-root', project, ...extra, '--json'],
    { env },
  );
}

function receiptPath(project) {
  return join(project, '.r2c', 'install', 'claude-code.json');
}

function readReceipt(project) {
  return JSON.parse(readFileSync(receiptPath(project), 'utf8'));
}

/** path → {size, mtime, sha256-ish content} for every file under `root`. */
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

function writeFakePayload(t, { engine, version }) {
  const payload = tempDir(t, 'payload');
  cpSync(join(REPO, 'pack', 'commands'), join(payload, 'commands'), { recursive: true });
  cpSync(join(REPO, 'pack', 'skills'), join(payload, 'skills'), { recursive: true });
  cpSync(join(REPO, 'pack', 'workflows'), join(payload, 'workflows'), { recursive: true });
  cpSync(join(REPO, 'shims'), join(payload, 'shims'), { recursive: true });
  cpSync(join(REPO, 'adapters'), join(payload, 'adapters'), { recursive: true });
  const adapterFile = join(payload, 'adapters', 'claude-code', 'adapter.json');
  const adapter = JSON.parse(readFileSync(adapterFile, 'utf8'));
  adapter.requires.engine = engine;
  adapter.requires.agent = '>=2.1.312 <3';
  writeFileSync(adapterFile, `${JSON.stringify(adapter, null, 2)}\n`);
  writeFileSync(
    join(payload, 'r2c-payload.json'),
    `${JSON.stringify({ schema: 'r2c.plugin/v1', version, engine, files: {} }, null, 2)}\n`,
  );
  return payload;
}

test('install --from a source tree writes commands, skills and a receipt', (t) => {
  const { project, env } = setup(t);
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.command, 'adapter.install');
  assert.equal(json.data.action, 'installed');
  assert.equal(json.data.changed, true);
  assert.equal(json.data.scope, 'project');

  const commandFile = join(project, '.claude', 'commands', 'r2c-run.md');
  assert.ok(existsSync(commandFile));
  const command = readFileSync(commandFile, 'utf8');
  assert.match(command, new RegExp(`npx --yes r2c-runner@${ENGINE_VERSION} run`));
  assert.ok(!command.includes('<runner>'));

  const skills = readdirSync(join(project, '.claude', 'skills'));
  assert.equal(skills.length, 35);
  const skill = readFileSync(join(project, '.claude', 'skills', 'code-research', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: code-research\r?\n/);

  const receipt = readReceipt(project);
  assert.equal(receipt.payload.version, ENGINE_VERSION);
  assert.match(receipt.payload.sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.runner_cmd, `npx --yes r2c-runner@${ENGINE_VERSION}`);
  assert.equal(receipt.engine.version, ENGINE_VERSION);
  assert.equal(receipt.engine.requires, '^0.1.0');
  assert.equal(receipt.requires.agent, '>=2.1.312 <3');
  const configFiles = receipt.files.filter((file) => file.kind !== 'layout');
  assert.equal(configFiles.length, 46);
  for (const file of configFiles) {
    assert.ok(existsSync(file.path), file.path);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    const expectedKind = file.path.includes(`${join('.claude', 'commands')}`)
      ? 'render'
      : file.path.includes(`${join('.claude', 'agents')}`)
        ? 'derive-agent'
        : 'copy';
    assert.equal(file.kind, expectedKind);
  }
  const layoutFiles = receipt.files.filter((file) => file.kind === 'layout');
  assert.equal(layoutFiles.length, 40, 'workflows/, tasks/ and skills/ are copied into the project root');
  for (const file of layoutFiles) {
    assert.ok(existsSync(join(project, file.path)), file.path);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(readdirSync(join(project, '.claude', 'agents')).length, 4);
  assert.ok(existsSync(join(receipt.payload_home, 'r2c-payload.json')));
  assert.ok(existsSync(join(receipt.payload_home, 'adapters', 'claude-code', 'map.json')));
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

test('foreign files conflict without --force; --force backs up and replaces', (t) => {
  const { project, env } = setup(t);
  mkdirSync(join(project, '.claude', 'commands'), { recursive: true });
  const target = join(project, '.claude', 'commands', 'r2c-run.md');
  writeFileSync(target, 'foreign command\n');

  const conflict = install(env, project);
  assert.equal(conflict.status, 2, conflict.stderr);
  const error = envelope(conflict).error;
  assert.equal(error.code, 'CONFLICT');
  assert.equal(error.details.conflicts[0].path, target);
  assert.equal(readFileSync(target, 'utf8'), 'foreign command\n');
  assert.ok(!existsSync(receiptPath(project)));

  const forced = install(env, project, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(envelope(forced).data.action, 'installed');
  const receipt = readReceipt(project);
  const backup = receipt.backups.find((entry) => entry.path === target);
  assert.ok(backup, 'conflict backup recorded');
  assert.equal(readFileSync(backup.backup, 'utf8'), 'foreign command\n');
  assert.match(readFileSync(target, 'utf8'), /npx --yes r2c-runner/);
});

test('--dry-run prints the plan and writes nothing', (t) => {
  const { project, env } = setup(t);
  const result = install(env, project, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.data.dry_run, true);
  assert.ok(json.data.plan.length > 0);
  assert.ok(!existsSync(join(project, '.claude')));
  assert.ok(!existsSync(join(project, '.r2c')));
});

test('engine range failure exits 2 for --copy and only warns for --link', (t) => {
  const { project, env } = setup(t);
  const payload = writeFakePayload(t, { engine: '^9.0.0', version: '9.0.0' });

  const copy = cli(
    ['adapter', 'install', 'claude-code', '--from', payload, '--project-root', project, '--copy', '--json'],
    { env },
  );
  assert.equal(copy.status, 2, copy.stderr);
  assert.equal(envelope(copy).error.code, 'ENGINE_RANGE');
  assert.ok(!existsSync(join(project, '.claude')));

  const link = cli(
    ['adapter', 'install', 'claude-code', '--from', payload, '--project-root', project, '--link', '--json'],
    { env },
  );
  assert.equal(link.status, 0, link.stderr);
  const json = envelope(link);
  assert.ok(json.data.warnings.some((warning) => warning.startsWith('engine-range:')));
  const receipt = readReceipt(project);
  assert.equal(receipt.mode, 'link');
  assert.equal(receipt.requires.engine, '^9.0.0');
  const skillLink = receipt.files.find((file) => file.kind === 'link');
  assert.ok(skillLink, 'skills directory is linked');
  assert.equal(skillLink.target, join(payload, 'skills'), 'receipt records the real link target');
  assert.equal(receipt.files.some((file) => file.path.endsWith('r2c-run.md')), true);
});

test('doctor fails on a tampered file, uninstall removes the receipt and keeps .r2c', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  writeFileSync(join(project, '.r2c', 'ir.md'), '# interface requirements\n');
  const target = join(project, '.claude', 'commands', 'r2c-run.md');
  writeFileSync(target, `${readFileSync(target, 'utf8')}\ntampered\n`);

  const doctor = cli(
    ['adapter', 'doctor', 'claude-code', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(doctor.status, 3, doctor.stderr);
  const doctorJson = envelope(doctor);
  assert.equal(doctorJson.error.code, 'DOCTOR_FAILED');
  assert.equal(doctorJson.data.checks.find((check) => check.name === 'receipt.files').status, 'fail');

  const removed = cli(
    ['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(envelope(removed).data.action, 'removed');
  assert.ok(!existsSync(receiptPath(project)));
  assert.ok(existsSync(join(project, '.r2c', 'ir.md')), '.r2c runtime/business state is kept');
  assert.ok(!existsSync(join(project, '.r2c', 'payload', ENGINE_VERSION)));
  assert.ok(existsSync(target), 'edited file is left for --force');

  const again = cli(
    ['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(again.status, 4, again.stderr);
  assert.equal(envelope(again).error.code, 'NOT_INSTALLED');
});

test('doctor on an uninstalled project exits 4', (t) => {
  const { project, env } = setup(t);
  const result = cli(['adapter', 'doctor', 'claude-code', '--project-root', project, '--json'], {
    env,
  });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(envelope(result).error.code, 'NOT_INSTALLED');
});

test('adapter list reports versions and engine ranges from adapter.json', (t) => {
  const { env } = setup(t);
  const result = cli(['adapter', 'list', '--from', REPO, '--json'], { env, cwd: REPO });
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.command, 'adapter.list');
  const claude = json.data.adapters.find((adapter) => adapter.id === 'claude-code');
  assert.ok(claude);
  assert.equal(claude.version, ENGINE_VERSION);
  assert.equal(claude.engine, '^0.1.0');
  assert.equal(claude.agent, '>=2.1.312 <3');
  assert.equal(claude.engine_satisfied, true);
});

test('smoke reports a clean install and uninstall of a linked skills dir keeps the source', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project, ['--link']).status, 0);
  const smoke = cli(['adapter', 'smoke', 'claude-code', '--project-root', project, '--json'], { env });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.equal(envelope(smoke).data.ok, true);

  const skillsLink = join(project, '.claude', 'skills');
  assert.ok(existsSync(skillsLink));
  const removed = cli(
    ['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(existsSync(join(REPO, 'pack', 'skills', 'code-research', 'SKILL.md')), 'link target survives');
});

test('a payload hash mismatch aborts before any project write', (t) => {
  const { project, env } = setup(t);
  const payload = writeFakePayload(t, { engine: '^0.1.0', version: ENGINE_VERSION });
  writeFileSync(
    join(payload, 'r2c-payload.json'),
    `${JSON.stringify({
      schema: 'r2c.plugin/v1',
      version: ENGINE_VERSION,
      engine: '^0.1.0',
      files: { 'commands/r2c-run.md': '0'.repeat(64) },
    }, null, 2)}\n`,
  );
  const result = cli(
    ['adapter', 'install', 'claude-code', '--from', payload, '--project-root', project, '--json'],
    { env },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.equal(envelope(result).error.code, 'PAYLOAD_HASH_MISMATCH');
  assert.ok(!existsSync(join(project, '.claude')));
  assert.ok(!existsSync(join(project, '.r2c')));
});

test('--mcp merges only our keys, is idempotent and uninstall restores the foreign file', (t) => {
  const { project, env } = setup(t);
  const mcpFile = join(tempDir(t, 'mcp'), 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { 'r2c-sr': { command: 'node', args: ['sr.mjs'] } } }));
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { foreign: { command: 'x' } }, other: 1 }));

  const first = cli(
    ['adapter', 'install', 'claude-code', '--from', REPO, '--project-root', project, '--mcp', mcpFile, '--json'],
    { env },
  );
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(afterFirst.mcpServers).sort(), ['foreign', 'r2c-sr']);
  assert.equal(afterFirst.other, 1);
  const receipt = readReceipt(project);
  assert.deepEqual(
    receipt.merged.map((entry) => entry.pointer).sort(),
    ['hooks.PreToolUse', 'hooks.Stop', 'mcpServers.r2c-sr'],
  );

  const second = cli(
    ['adapter', 'install', 'claude-code', '--from', REPO, '--project-root', project, '--mcp', mcpFile, '--json'],
    { env },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(envelope(second).data.action, 'noop');

  const removed = cli(
    ['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'],
    { env },
  );
  assert.equal(removed.status, 0, removed.stderr);
  const afterRemove = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'));
  assert.deepEqual(afterRemove, { mcpServers: { foreign: { command: 'x' } }, other: 1 });
});

test('linkTarget resolves a real directory link and returns null for plain files', (t) => {
  const dir = tempDir(t, 'link-probe');
  const source = join(dir, 'source');
  mkdirSync(source, { recursive: true });
  const link = join(dir, 'linked');
  createDirLink(link, source);
  assert.equal(linkTarget(link), source);
  const plain = join(dir, 'plain.txt');
  writeFileSync(plain, 'x');
  assert.equal(linkTarget(plain), null);
  assert.equal(linkTarget(join(dir, 'missing')), null);
});
