/**
 * #40: the installer copies the payload's `workflows/`, `tasks/` and `skills/`
 * trees into the project root, records them in the receipt, and uninstall
 * reverts exactly what it recorded.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withPath } from './support/env.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const PACK = join(REPO, 'pack');
const LAYOUT_DIRS = ['workflows', 'tasks', 'skills'];

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-layout-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function walk(rel, out = []) {
  for (const entry of readdirSync(join(PACK, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Every payload layout file, project-relative (`workflows/x.yaml`, …). */
function layoutRels() {
  return LAYOUT_DIRS.flatMap((dir) => walk(dir)).sort();
}

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
  for (const key of ['R2C_SESSION_ID', 'R2C_PROJECT_ROOT', 'R2C_PLUGIN_SOURCE', 'R2C_HOME']) {
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
  return spawnSync(process.execPath, [BIN, ...args], { cwd: cwd ?? REPO, encoding: 'utf8', env });
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
  return { home, project, env: cleanEnv({ pathDir: bin, home }) };
}

function install(env, project, extra = []) {
  return cli(
    ['adapter', 'install', 'claude-code', '--from', REPO, '--project-root', project, ...extra, '--json'],
    { env, cwd: project },
  );
}

function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readReceipt(project, agent = 'claude-code') {
  return JSON.parse(readFileSync(join(project, '.r2c', 'install', `${agent}.json`), 'utf8'));
}

/** path → {bytes, mtime} for every file under `root` (locks excluded). */
function snapshot(root) {
  const files = new Map();
  const walkDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
        continue;
      }
      if (entry.name === '.lock') continue;
      const data = readFileSync(full);
      files.set(relative(root, full), { text: data.toString('base64'), mtime: statSync(full).mtimeMs });
    }
  };
  walkDir(root);
  return files;
}

test('a clean project receives the layout and run discovers the manifest', (t) => {
  const { project, env } = setup(t);
  const result = install(env, project);
  assert.equal(result.status, 0, result.stderr);

  for (const rel of layoutRels()) {
    assert.ok(existsSync(join(project, rel)), `missing layout file ${rel}`);
  }

  const run = cli(['run', '--dry-run', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(run.status, 0, run.stderr);
  const data = envelope(run).data;
  assert.equal(data.dry_run, true);
  assert.equal(data.workflow_id, 'rtosv3-r2c-pipeline');
  assert.equal(existsSync(join(project, '.r2c', 'runs')), false, 'dry run writes no runtime state');
});

test('--dry-run lists every layout copy and writes nothing', (t) => {
  const { project, env } = setup(t);
  const result = install(env, project, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const planned = envelope(result).data.plan
    .filter((step) => step.action === 'layout')
    .map((step) => relative(project, step.target).split('\\').join('/'))
    .sort();
  assert.deepEqual(planned, layoutRels());
  assert.equal(existsSync(join(project, 'workflows')), false, 'dry run writes no layout file');
  assert.equal(existsSync(join(project, '.r2c')), false, 'dry run writes no state');
});

test('the receipt records each layout file project-relative and doctor reports a hand edit', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);

  const layout = readReceipt(project).files.filter((file) => file.kind === 'layout');
  assert.deepEqual(layout.map((file) => file.path).sort(), layoutRels());
  for (const file of layout) {
    assert.equal(isAbsolute(file.path), false, `layout path is not project-relative: ${file.path}`);
    assert.equal(file.sha256, fileHash(join(project, file.path)), `sha256 of ${file.path}`);
  }

  const clean = cli(['adapter', 'doctor', 'claude-code', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(clean.status, 0, clean.stderr);

  const edited = join(project, 'skills', 'code-research', 'SKILL.md');
  writeFileSync(edited, `${readFileSync(edited, 'utf8')}\nhand edit\n`);
  const doctor = cli(['adapter', 'doctor', 'claude-code', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(doctor.status, 3, doctor.stderr);
  const files = envelope(doctor).data.checks.find((entry) => entry.name === 'receipt.files');
  assert.equal(files.status, 'fail');
  assert.match(files.detail, /hash-mismatch:/);
  assert.ok(files.detail.includes(edited), `offending path missing from: ${files.detail}`);
});

test('an unowned same-name layout file is a conflict, and --force backs it up first', (t) => {
  const { project, env } = setup(t);
  const rel = 'workflows/RTOSv3_R2C_pipiline.yaml';
  mkdirSync(join(project, 'workflows'), { recursive: true });
  writeFileSync(join(project, rel), 'id: mine\n');
  const before = snapshot(project);

  const refused = install(env, project);
  assert.equal(refused.status, 2, refused.stderr);
  const failure = envelope(refused);
  assert.equal(failure.error.code, 'CONFLICT');
  assert.ok(
    failure.error.details.conflicts.some((entry) => entry.path === join(project, rel)),
    JSON.stringify(failure.error.details.conflicts),
  );
  assert.deepEqual(snapshot(project), before, 'a conflict writes nothing');

  const forced = install(env, project, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  const backup = readReceipt(project).backups.find((entry) => entry.path === join(project, rel));
  assert.ok(backup, 'the replaced file is backed up');
  assert.equal(readFileSync(backup.backup, 'utf8'), 'id: mine\n');
  assert.equal(readFileSync(join(project, rel), 'utf8'), readFileSync(join(PACK, rel), 'utf8'));
});

test('re-installing the same version is a noop that leaves the receipt untouched', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const receipt = join(project, '.r2c', 'install', 'claude-code.json');
  const receiptBytes = readFileSync(receipt, 'utf8');
  const receiptMtime = statSync(receipt).mtimeMs;
  const before = snapshot(project);

  const again = install(env, project);
  assert.equal(again.status, 0, again.stderr);
  const data = envelope(again).data;
  assert.equal(data.action, 'noop');
  assert.equal(data.changed, false);
  assert.deepEqual(snapshot(project), before, 'noop writes nothing');
  assert.equal(readFileSync(receipt, 'utf8'), receiptBytes, 'receipt bytes unchanged');
  assert.equal(statSync(receipt).mtimeMs, receiptMtime, 'receipt not rewritten');
});

test('uninstall removes receipt-owned layout copies and self-created dirs, keeping hand edits and runtime state', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  const edited = 'skills/code-research/SKILL.md';
  writeFileSync(join(project, edited), 'edited\n');
  mkdirSync(join(project, '.r2c', 'runs', 'run-1'), { recursive: true });
  writeFileSync(join(project, '.r2c', 'runs', 'run-1', 'state.json'), '{}\n');
  writeFileSync(join(project, 'notes.txt'), 'business output\n');

  const result = cli(['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'], { env, cwd: project });
  assert.equal(result.status, 0, result.stderr);
  const data = envelope(result).data;

  for (const rel of layoutRels()) {
    if (rel === edited) continue;
    assert.equal(existsSync(join(project, rel)), false, `still present: ${rel}`);
  }
  assert.ok(existsSync(join(project, edited)), 'the hand-edited copy is kept');
  assert.ok(
    data.leftover.includes(`modified:${join(project, edited)}`),
    JSON.stringify(data.leftover),
  );
  assert.equal(existsSync(join(project, 'workflows')), false, 'emptied self-created dir removed');
  assert.equal(existsSync(join(project, 'tasks')), false, 'emptied self-created dir removed');
  assert.ok(existsSync(join(project, 'skills')), 'a dir that still holds a leftover file stays');
  assert.ok(existsSync(join(project, '.r2c', 'runs', 'run-1', 'state.json')), 'runtime state survives');
  assert.equal(readFileSync(join(project, 'notes.txt'), 'utf8'), 'business output\n');
});

test('user scope copies the layout into the project, records the root, and reverts from any cwd', (t) => {
  const { project, home, env } = setup(t);
  const result = install(env, project, ['--scope', 'user']);
  assert.equal(result.status, 0, result.stderr);

  const receipt = JSON.parse(readFileSync(join(home, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  assert.equal(receipt.scope, 'user');
  assert.equal(receipt.project_root, project, 'a user-scope receipt records the project it wrote into');
  for (const rel of layoutRels()) assert.ok(existsSync(join(project, rel)), `missing ${rel}`);

  const out = cli(
    ['adapter', 'uninstall', 'claude-code', '--scope', 'user', '--project-root', project, '--json'],
    { env, cwd: REPO },
  );
  assert.equal(out.status, 0, out.stderr);
  for (const rel of layoutRels()) {
    assert.equal(existsSync(join(project, rel)), false, `not reverted: ${rel}`);
  }
});

test('a pending marker rolls back layout copies before the next install writes', (t) => {
  const { project, env } = setup(t);
  const layout = join(project, 'workflows', 'RTOSv3_R2C_pipiline.yaml');
  mkdirSync(join(project, 'workflows'), { recursive: true });
  writeFileSync(layout, 'half-written\n');
  mkdirSync(join(project, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(project, '.claude', 'commands', 'r2c-run.md'), 'foreign\n');
  mkdirSync(join(project, '.r2c', 'install'), { recursive: true });
  writeFileSync(
    join(project, '.r2c', 'install', 'claude-code.pending.json'),
    JSON.stringify({
      adapter: 'claude-code',
      payload_home: join(project, '.r2c', 'payload', '0.1.0'),
      payload_created: false,
      created_files: [layout],
      created_dirs: [join(project, 'workflows')],
      backups: [],
    }),
  );

  const result = install(env, project);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(existsSync(layout), false, 'the interrupted layout copy was rolled back');
  assert.equal(existsSync(join(project, 'workflows')), false, 'the self-created dir was removed');
});

test('--purge-state still drops runtime state and the install dir only', (t) => {
  const { project, env } = setup(t);
  assert.equal(install(env, project).status, 0);
  mkdirSync(join(project, '.r2c', 'runs', 'run-1'), { recursive: true });
  writeFileSync(join(project, '.r2c', 'runs', 'run-1', 'state.json'), '{}\n');
  writeFileSync(join(project, 'notes.txt'), 'business output\n');

  const result = cli(
    ['adapter', 'uninstall', 'claude-code', '--project-root', project, '--purge-state', '--json'],
    { env, cwd: project },
  );
  assert.equal(result.status, 0, result.stderr);
  for (const rel of layoutRels()) assert.equal(existsSync(join(project, rel)), false, `still present: ${rel}`);
  assert.equal(existsSync(join(project, '.r2c', 'runs')), false);
  assert.equal(existsSync(join(project, '.r2c', 'install')), false);
  assert.equal(readFileSync(join(project, 'notes.txt'), 'utf8'), 'business output\n');
});
