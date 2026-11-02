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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withPath } from './support/env.js';
import { releaseAuthHint, releaseCredential, releaseEndpoints } from '../src/adapter/release.js';
import { archivePathProblem, assetUnavailable, authCredential, nodeSupported } from '../scripts/install.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(REPO, 'scripts', 'install.mjs');

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-bootstrap-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PROBE = `import { readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(
  process.env.FAKE_GIT_PROBE,
  JSON.stringify({
    args: process.argv.slice(2),
    prompt: process.env.GIT_TERMINAL_PROMPT ?? null,
    stdin: Buffer.concat(chunks).toString('utf8'),
  }),
);
if (process.env.FAKE_GIT_PASSWORD) {
  process.stdout.write(\`username=x\\npassword=\${process.env.FAKE_GIT_PASSWORD}\\n\`);
} else {
  process.exit(1);
}
`;

/**
 * Fake `git` on PATH. `git credential fill` must be answered without a prompt
 * (GIT_TERMINAL_PROMPT=0) and with protocol=https/host=github.com on stdin, so
 * the shim records both and answers from `FAKE_GIT_PASSWORD` (unset = no
 * stored credential).
 */
function fakeGit(t) {
  const dir = tempDir(t, 'git-bin');
  const script = join(dir, 'fake-git.mjs');
  writeFileSync(script, PROBE);
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'git.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const file = join(dir, 'git');
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  const record = join(tempDir(t, 'git-probe'), 'record.json');
  return { dir, record };
}

/** Save the credential-related environment, point PATH at the shim, restore after. */
function withFakeGit(t, git, { password = null } = {}) {
  const saved = new Map();
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_TERMINAL_PROMPT', 'FAKE_GIT_PROBE', 'FAKE_GIT_PASSWORD']) {
    saved.set(key, process.env[key]);
  }
  const savedPath = new Map();
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === 'path') savedPath.set(key, process.env[key]);
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === 'path') delete process.env[key];
    }
    for (const [key, value] of savedPath) process.env[key] = value;
  });
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.FAKE_GIT_PROBE = git.record;
  if (password === null) delete process.env.FAKE_GIT_PASSWORD;
  else process.env.FAKE_GIT_PASSWORD = password;
  withPath(process.env, git.dir);
  return git;
}

function cleanEnv(home) {
  const env = { ...process.env };
  for (const key of ['R2C_SESSION_ID', 'R2C_PROJECT_ROOT', 'R2C_PLUGIN_SOURCE', 'R2C_RELEASE_BASE']) {
    delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.R2C_HOME = home;
  return env;
}

function bootstrap(args, { env, cwd } = {}) {
  return spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env,
    timeout: 240_000,
  });
}

/** Every file under `root` by relative path: size, mtime and content. */
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

test('the payload downloader takes GH_TOKEN, then GITHUB_TOKEN, then git credential fill', (t) => {
  const git = withFakeGit(t, fakeGit(t), { password: 'stored-secret' });

  process.env.GH_TOKEN = 'gh-secret';
  process.env.GITHUB_TOKEN = 'pat-secret';
  assert.deepEqual(releaseCredential(), { token: 'gh-secret', source: 'GH_TOKEN' });

  delete process.env.GH_TOKEN;
  assert.deepEqual(releaseCredential(), { token: 'pat-secret', source: 'GITHUB_TOKEN' });

  delete process.env.GITHUB_TOKEN;
  assert.deepEqual(releaseCredential(), { token: 'stored-secret', source: 'git-credential' });
  const record = JSON.parse(readFileSync(git.record, 'utf8'));
  assert.deepEqual(record.args, ['credential', 'fill']);
  assert.equal(record.prompt, '0', 'the helper is called non-interactively');
  assert.match(record.stdin, /^protocol=https$/m);
  assert.match(record.stdin, /^host=github\.com$/m);
});

test('with no credential at all the chain reports nothing and names gh auth login', (t) => {
  withFakeGit(t, fakeGit(t), { password: null });
  assert.deepEqual(releaseCredential(), { token: null, source: null });

  // No credential still installs from a public release: the anonymous download
  // uses the plain web URL instead of the API.
  const anonymous = releaseEndpoints({ version: VERSION, token: null });
  assert.equal(anonymous.kind, 'direct');
  assert.match(anonymous.archive, /^https:\/\/github\.com\/hesl2636\/RTOSv3_R2C_pipiline\/releases\/download\//);

  const hint = releaseAuthHint(404, { token: null, source: null });
  assert.match(hint, /404/);
  assert.match(hint, /private/i);
  assert.match(hint, /token is required/i);
  assert.match(hint, /gh auth login/);

  const rejected = releaseAuthHint(403, { token: 'x', source: 'GH_TOKEN' });
  assert.match(rejected, /GH_TOKEN/);
  assert.match(rejected, /gh auth login/);
});

test('the bootstrap walks the same credential chain and its 404 names gh auth login', (t) => {
  const git = withFakeGit(t, fakeGit(t), { password: 'stored-secret' });

  process.env.GH_TOKEN = 'gh-secret';
  process.env.GITHUB_TOKEN = 'pat-secret';
  assert.deepEqual(authCredential(), { token: 'gh-secret', source: 'GH_TOKEN' });

  delete process.env.GH_TOKEN;
  assert.deepEqual(authCredential(), { token: 'pat-secret', source: 'GITHUB_TOKEN' });

  delete process.env.GITHUB_TOKEN;
  assert.deepEqual(authCredential(), { token: 'stored-secret', source: 'git-credential' });
  assert.equal(JSON.parse(readFileSync(git.record, 'utf8')).prompt, '0');

  const missing = assetUnavailable('r2c-engine-0.1.0.tgz', '0.1.0', 'https://example.invalid/v0.1.0/', {
    status: 404,
    credential: { token: null, source: null },
  });
  assert.equal(missing.code, 'ENGINE_AUTH_REQUIRED');
  assert.equal(missing.exitCode, 1);
  assert.match(missing.message, /404/);
  assert.match(missing.message, /token is required/i);
  assert.match(missing.message, /gh auth login/);
});

const RELEASE = join(REPO, 'scripts', 'release.mjs');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const NEXT_VERSION = `${VERSION.split('.').slice(0, 2).join('.')}.${Number(VERSION.split('.')[2]) + 1}`;

/** `node scripts/release.mjs --out <dir>`: engine, payload and sums in one dir. */
function buildRelease(t, prefix = 'release') {
  const out = tempDir(t, prefix);
  const result = spawnSync(process.execPath, [RELEASE, '--out', out], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return out;
}

/**
 * A release for another version: a copy of the checkout with a bumped
 * manifest. `mutate` edits the copied checkout before packaging, so a test can
 * model a payload that drops a file between versions.
 */
function releaseForVersion(t, version, mutate = null) {
  const copy = tempDir(t, `repo-${version}`);
  cpSync(REPO, copy, {
    recursive: true,
    filter: (source) => {
      if (source === REPO) return true;
      const parts = source.split(sep);
      if (parts.includes('node_modules') || parts.includes('.git')) return false;
      return !['dist', '.tmpbuild', '.r2c'].includes(basename(source));
    },
  });
  cpSync(join(REPO, 'node_modules', 'yaml'), join(copy, 'node_modules', 'yaml'), { recursive: true });
  const pkgFile = join(copy, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  if (mutate !== null) mutate(copy);
  const out = tempDir(t, `release-${version}`);
  const result = spawnSync(process.execPath, [join(copy, 'scripts', 'release.mjs'), '--out', out], {
    cwd: copy,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return out;
}

/**
 * The Stop hook launches the recorded runner command through a shell, so a
 * no-op `npx` on PATH keeps `doctor` offline: the engine's own command is
 * `node <entry>` and never reaches for this shim.
 */
function fakeNpx(t) {
  const dir = tempDir(t, 'npx-bin');
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'npx.cmd'), '@echo off\r\necho {}\r\nexit /b 0\r\n');
  } else {
    const file = join(dir, 'npx');
    writeFileSync(file, '#!/bin/sh\necho {}\nexit 0\n');
    chmodSync(file, 0o755);
  }
  return dir;
}

function receiptOf(project, agentId) {
  return JSON.parse(readFileSync(join(project, '.r2c', 'install', `${agentId}.json`), 'utf8'));
}

function install(project, agent, release, version, env, views) {
  return bootstrap(
    ['--agent', agent, '--version', version, '--project', project, '--release-base', release],
    { env, cwd: views.claim() },
  );
}

/** A per-call working directory, so a stray relative path cannot leak in. */
function viewsOf(t) {
  let index = 0;
  return { claim: () => tempDir(t, `cwd-${(index += 1)}`) };
}

test('re-running the same version and parameters writes nothing and exits 0', (t) => {
  const release = buildRelease(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = cleanEnv(home);
  const views = viewsOf(t);

  const first = install(project, 'claude-code', release, VERSION, env, views);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

  const receiptFile = join(project, '.r2c', 'install', 'claude-code.json');
  const receiptMtime = statSync(receiptFile).mtimeMs;
  const before = snapshot(project);

  const second = install(project, 'claude-code', release, VERSION, env, views);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /already at/, 'the engine is not re-extracted');
  assert.equal(statSync(receiptFile).mtimeMs, receiptMtime, 'the receipt is not rewritten');
  assert.deepEqual(snapshot(project), before, 'no file in the project changed');
});

test('--version installs engine, payload and adapters at one version and removes the set it replaces', (t) => {
  const oldRelease = buildRelease(t, 'release-old');
  const newRelease = releaseForVersion(t, NEXT_VERSION);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = cleanEnv(home);
  const views = viewsOf(t);
  const engineDir = (version) => join(project, '.r2c', 'engine', version);
  const payloadDir = (version) => join(project, '.r2c', 'payload', version);

  assert.equal(install(project, 'claude-code', oldRelease, VERSION, env, views).status, 0);
  assert.ok(existsSync(engineDir(VERSION)));
  assert.ok(existsSync(payloadDir(VERSION)));

  const upgrade = install(project, 'claude-code', newRelease, NEXT_VERSION, env, views);
  assert.equal(upgrade.status, 0, `${upgrade.stdout}\n${upgrade.stderr}`);

  const upgraded = receiptOf(project, 'claude-code');
  assert.equal(upgraded.engine.version, NEXT_VERSION, 'the receipt engine is the new version');
  assert.equal(upgraded.engine.home, engineDir(NEXT_VERSION));
  assert.equal(upgraded.payload.version, NEXT_VERSION, 'the receipt payload is the new version');
  assert.ok(existsSync(join(engineDir(NEXT_VERSION), 'bin', 'r2c.js')));
  assert.ok(existsSync(join(payloadDir(NEXT_VERSION), 'r2c-payload.json')));
  assert.ok(!existsSync(engineDir(VERSION)), 'the engine this receipt owned is gone');
  assert.ok(!existsSync(payloadDir(VERSION)), 'the payload this receipt owned is gone');

  // A dry run must show the same retirement without performing it.
  const dryRun = spawnSync(
    process.execPath,
    [
      join(engineDir(NEXT_VERSION), 'bin', 'r2c.js'),
      'adapter', 'install', '--agent', 'claude-code', '--project-root', project,
      '--engine', engineDir(VERSION), '--plugin', VERSION, '--dry-run', '--json',
    ],
    { cwd: project, encoding: 'utf8', env: { ...env, R2C_RELEASE_BASE: oldRelease } },
  );
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  const plan = JSON.parse(dryRun.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)).data.plan;
  const removals = plan.filter((entry) => entry.action === 'remove').map((entry) => entry.target);
  assert.deepEqual(removals.sort(), [engineDir(NEXT_VERSION), payloadDir(NEXT_VERSION)].sort());
  assert.ok(existsSync(engineDir(NEXT_VERSION)), 'a dry run removes nothing');
  assert.ok(existsSync(payloadDir(NEXT_VERSION)));

  const rolledBack = install(project, 'claude-code', oldRelease, VERSION, env, views);
  assert.equal(rolledBack.status, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
  const receipt = receiptOf(project, 'claude-code');
  assert.equal(receipt.engine.version, VERSION);
  assert.equal(receipt.payload.version, VERSION);
  assert.ok(existsSync(join(engineDir(VERSION), 'bin', 'r2c.js')));
  assert.ok(!existsSync(engineDir(NEXT_VERSION)), 'rollback removes the newer engine it replaced');
  assert.ok(!existsSync(payloadDir(NEXT_VERSION)), 'rollback removes the newer payload it replaced');

  const env2 = { ...env };
  withPath(env2, fakeNpx(t));
  const doctor = spawnSync(
    process.execPath,
    [join(engineDir(VERSION), 'bin', 'r2c.js'), 'adapter', 'doctor', '--agent', 'claude-code', '--project-root', project, '--json'],
    { cwd: project, encoding: 'utf8', env: env2 },
  );
  assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
  const data = JSON.parse(doctor.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)).data;
  assert.equal(data.healthy, true);
  const engineChecks = data.checks.filter((check) => check.name.startsWith('engine.'));
  assert.ok(engineChecks.length > 0, 'doctor checks the engine');
  for (const entry of engineChecks) assert.equal(entry.status, 'pass', `${entry.name}: ${entry.detail}`);
});

test('an upgrade removes layout files the new payload no longer ships, keeping hand edits', (t) => {
  const droppedRel = 'skills/code-research/SKILL.md';
  const oldRelease = buildRelease(t, 'release-old');
  const newRelease = releaseForVersion(t, NEXT_VERSION, (copy) => {
    rmSync(join(copy, 'pack', 'skills', 'code-research'), { recursive: true, force: true });
  });

  const makeProject = (prefix) => {
    const project = tempDir(t, prefix);
    const home = tempDir(t, `${prefix}-home`);
    mkdirSync(join(home, '.claude'), { recursive: true });
    return { project, env: cleanEnv(home), views: viewsOf(t) };
  };
  const doctor = (project, env) => {
    const result = spawnSync(
      process.execPath,
      [
        join(project, '.r2c', 'engine', NEXT_VERSION, 'bin', 'r2c.js'),
        'adapter', 'doctor', 'claude-code', '--project-root', project, '--json',
      ],
      { cwd: project, encoding: 'utf8', env },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };

  // Unmodified old layout: the upgrade removes the copy and drops it from the receipt.
  const clean = makeProject('project-clean');
  assert.equal(install(clean.project, 'claude-code', oldRelease, VERSION, clean.env, clean.views).status, 0);
  assert.ok(existsSync(join(clean.project, droppedRel)));
  const upgraded = install(clean.project, 'claude-code', newRelease, NEXT_VERSION, clean.env, clean.views);
  assert.equal(upgraded.status, 0, `${upgraded.stdout}\n${upgraded.stderr}`);
  assert.equal(existsSync(join(clean.project, droppedRel)), false, 'the stale layout copy is gone');
  assert.ok(!receiptOf(clean.project, 'claude-code').files.some((file) => file.path === droppedRel));
  doctor(clean.project, clean.env);

  // Hand-edited old layout: kept, reported, and no longer owned by the receipt.
  const edited = makeProject('project-edited');
  assert.equal(install(edited.project, 'claude-code', oldRelease, VERSION, edited.env, edited.views).status, 0);
  writeFileSync(join(edited.project, droppedRel), 'hand edit\n');
  const kept = install(edited.project, 'claude-code', newRelease, NEXT_VERSION, edited.env, edited.views);
  assert.equal(kept.status, 0, `${kept.stdout}\n${kept.stderr}`);
  assert.equal(readFileSync(join(edited.project, droppedRel), 'utf8'), 'hand edit\n');
  assert.match(kept.stdout, /warn: layout-stale:/);
  assert.ok(!receiptOf(edited.project, 'claude-code').files.some((file) => file.path === droppedRel));
  doctor(edited.project, edited.env);
});

/**
 * A second adapter in one project goes through the documented path once
 * `--force` is accepted: the payload layout (`workflows/`, `tasks/`, `skills/`)
 * already exists and is owned by the first adapter's receipt. The receipt it
 * writes is what matters here — it shares the same engine and payload homes.
 */
function installSecondAdapter(project, agent, release, version, env) {
  const result = bootstrap(
    ['--agent', agent, '--version', version, '--project', project, '--release-base', release, '--force'],
    { env, cwd: project },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

test('an upgrade keeps a version set another receipt still references', (t) => {
  const oldRelease = buildRelease(t, 'release-old');
  const newRelease = releaseForVersion(t, NEXT_VERSION);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const env = cleanEnv(home);
  const views = viewsOf(t);
  const engineDir = (version) => join(project, '.r2c', 'engine', version);
  const payloadDir = (version) => join(project, '.r2c', 'payload', version);

  assert.equal(install(project, 'claude-code', oldRelease, VERSION, env, views).status, 0);
  installSecondAdapter(project, 'codex', oldRelease, VERSION, env);
  assert.equal(receiptOf(project, 'codex').engine.home, engineDir(VERSION), 'both adapters share one set');

  assert.equal(install(project, 'claude-code', newRelease, NEXT_VERSION, env, views).status, 0);
  assert.ok(existsSync(engineDir(VERSION)), 'codex still runs the old engine');
  assert.ok(existsSync(payloadDir(VERSION)), 'codex still reads the old payload');

  installSecondAdapter(project, 'codex', newRelease, NEXT_VERSION, env);
  assert.ok(!existsSync(engineDir(VERSION)), 'the last reference is gone, so the set is too');
  assert.ok(!existsSync(payloadDir(VERSION)));
  assert.equal(receiptOf(project, 'claude-code').engine.version, NEXT_VERSION);
  assert.equal(receiptOf(project, 'codex').engine.version, NEXT_VERSION);
});

test('uninstall removes the engine and payload this receipt owns, and only then', (t) => {
  const release = buildRelease(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const env = cleanEnv(home);
  const views = viewsOf(t);
  const engineDir = join(project, '.r2c', 'engine', VERSION);
  const payloadDir = join(project, '.r2c', 'payload', VERSION);

  assert.equal(install(project, 'claude-code', release, VERSION, env, views).status, 0);
  installSecondAdapter(project, 'codex', release, VERSION, env);

  const shared = spawnSync(
    process.execPath,
    [join(engineDir, 'bin', 'r2c.js'), 'adapter', 'uninstall', '--agent', 'claude-code', '--project-root', project, '--json'],
    { cwd: project, encoding: 'utf8', env },
  );
  assert.equal(shared.status, 0, `${shared.stdout}\n${shared.stderr}`);
  const sharedData = JSON.parse(shared.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)).data;
  assert.equal(sharedData.engine_removed, false, 'codex still runs this engine');
  assert.equal(sharedData.engine_shared_with, 'codex');
  assert.ok(sharedData.warnings.includes(`engine-shared:${engineDir} still used by codex`));
  assert.ok(existsSync(engineDir), 'a shared engine survives');
  assert.ok(existsSync(payloadDir), 'a shared payload survives');

  const last = spawnSync(
    process.execPath,
    [join(engineDir, 'bin', 'r2c.js'), 'adapter', 'uninstall', '--agent', 'codex', '--project-root', project, '--json'],
    { cwd: project, encoding: 'utf8', env },
  );
  assert.equal(last.status, 0, `${last.stdout}\n${last.stderr}`);
  const lastData = JSON.parse(last.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)).data;
  assert.equal(lastData.engine_removed, true);
  assert.ok(!existsSync(engineDir), 'the last receipt takes the engine with it');
  assert.ok(!existsSync(payloadDir));
});

test('prune removes an engine directory no receipt references', (t) => {
  const release = buildRelease(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = cleanEnv(home);
  const views = viewsOf(t);

  assert.equal(install(project, 'claude-code', release, VERSION, env, views).status, 0);
  const stale = join(project, '.r2c', 'engine', '0.0.9');
  cpSync(join(project, '.r2c', 'engine', VERSION), stale, { recursive: true });

  const pruned = spawnSync(
    process.execPath,
    [join(project, '.r2c', 'engine', VERSION, 'bin', 'r2c.js'), 'adapter', 'prune', '--project-root', project, '--json'],
    { cwd: project, encoding: 'utf8', env },
  );
  assert.equal(pruned.status, 0, `${pruned.stdout}\n${pruned.stderr}`);
  const data = JSON.parse(pruned.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)).data;
  assert.ok(data.removed.includes(stale), JSON.stringify(data));
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(join(project, '.r2c', 'engine', VERSION)), 'the referenced engine is kept');
  assert.ok(data.referenced_engines.includes(join(project, '.r2c', 'engine', VERSION)));
});

test('a second adapter installs in the same project through the bootstrap with --force', (t) => {
  const release = buildRelease(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const env = cleanEnv(home);
  const views = viewsOf(t);

  assert.equal(install(project, 'claude-code', release, VERSION, env, views).status, 0);

  // Without --force the second adapter hits the layout the first receipt owns;
  // the bootstrap must surface the engine's own CONFLICT status instead of
  // dying on an unknown argument.
  const blocked = bootstrap(
    ['--agent', 'codex', '--version', VERSION, '--project', project, '--release-base', release],
    { env, cwd: views.claim() },
  );
  assert.equal(blocked.status, 2, `${blocked.stdout}\n${blocked.stderr}`);
  assert.match(blocked.stderr, /ADAPTER_INSTALL_FAILED: adapter install codex failed with exit 2/);
  assert.equal(receiptOf(project, 'claude-code').adapter, 'claude-code');
  assert.ok(!existsSync(join(project, '.r2c', 'install', 'codex.json')), 'the refused run writes no receipt');

  const forced = bootstrap(
    ['--agent', 'codex', '--version', VERSION, '--project', project, '--release-base', release, '--force'],
    { env, cwd: views.claim() },
  );
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  assert.match(forced.stdout, /already at/, 'the shared engine is not re-downloaded');
  const codex = receiptOf(project, 'codex');
  const claude = receiptOf(project, 'claude-code');
  assert.equal(codex.adapter, 'codex');
  assert.equal(codex.payload_home, claude.payload_home, 'both adapters share one payload');
  assert.equal(codex.engine.home, claude.engine.home, 'both adapters share one engine');
  assert.ok(existsSync(join(project, '.codex')), 'the second adapter wrote its own config');
  assert.ok(existsSync(join(project, 'workflows', 'RTOSv3_R2C_pipiline.yaml')), 'the layout survives');
});

test('the bootstrap refuses an unsupported node before it downloads anything', (t) => {
  // Mirror of src/cli.js NODE_RANGE: the boundary values, not the range string.
  assert.equal(nodeSupported('22.18.9'), false);
  assert.equal(nodeSupported('22.19.0'), true);
  assert.equal(nodeSupported('23.1.0'), false);
  assert.equal(nodeSupported('24.0.0'), true);
  assert.equal(nodeSupported('25.0.0'), true);
  assert.equal(nodeSupported('not-a-version'), false);

  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  const patch = join(tempDir(t, 'node-patch'), 'patch.cjs');
  writeFileSync(patch, 'Object.defineProperty(process.versions, "node", { value: "20.9.0" });\n');
  const env = cleanEnv(home);

  // The release base does not even exist: the floor must fire first, which is
  // the fix — an unsupported Node used to download, extract, then roll back.
  const result = spawnSync(
    process.execPath,
    [
      '--require', patch, BOOTSTRAP,
      '--agent', 'claude-code', '--version', VERSION,
      '--project', project, '--release-base', join(tempDir(t, 'empty'), 'missing'),
    ],
    { cwd: tempDir(t, 'cwd'), env, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /NODE_UNSUPPORTED/);
  assert.match(result.stderr, />=22\.19\.0 <23 \|\| >=24\.0\.0/);
  assert.match(result.stderr, /20\.9\.0/);
  assert.deepEqual(readdirSync(project), [], 'nothing was written into the project');
  assert.equal(existsSync(join(home, '.r2c')), false, 'nothing was extracted');
});

test('the bootstrap archive path check enforces the same 100-byte bound as the engine', () => {
  assert.equal(archivePathProblem('bin/r2c.js'), null);
  assert.equal(archivePathProblem('a'.repeat(100)), null);
  const tooLong = archivePathProblem(`${'a'.repeat(100)}b`);
  assert.match(tooLong, /101 bytes \(max 100\)/);
  assert.match(archivePathProblem('/abs'), /relative and POSIX/);
  assert.match(archivePathProblem('a\\b'), /relative and POSIX/);
  assert.match(archivePathProblem('../x'), /not canonical/);
  assert.match(archivePathProblem(''), /empty path/);
});

test('--profile reaches the engine: the bootstrap installs into the named dsh profile', (t) => {
  const release = buildRelease(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  const dshHome = tempDir(t, 'dsh-home');
  const env = cleanEnv(home);
  delete env.R2C_RELEASE_BASE;
  env.DSH_HOME = dshHome;

  const result = bootstrap(
    ['--agent', 'dsh', '--version', VERSION, '--scope', 'user', '--profile', 'headless', '--project', project, '--release-base', release],
    { env, cwd: tempDir(t, 'cwd') },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(readFileSync(join(home, '.r2c', 'install', 'dsh.json'), 'utf8'));
  assert.equal(receipt.steps.profile.name, 'headless');
  assert.ok(existsSync(join(dshHome, 'profiles', 'headless', 'package.json')));
  assert.equal(existsSync(join(dshHome, 'profiles', 'web')), false, 'the default profile is not touched');
});
