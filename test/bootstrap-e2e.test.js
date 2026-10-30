/**
 * The highest-level acceptance seam: a locally built release directory stands
 * in for the GitHub release, and the bootstrap walks the whole chain —
 * download → verify → extract → adapter install → layout — with no network,
 * no npm and no `gh`. The installed engine then has to find the project-root
 * manifest, and uninstall has to put the project back while keeping runtime
 * state. Negative cases cover one tamper class per plausible failure (byte
 * flip, truncation, missing file) and prove the bootstrap writes nothing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withPath } from './support/env.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(REPO, 'scripts', 'install.mjs');
const RELEASE = join(REPO, 'scripts', 'release.mjs');
const BIN = join(REPO, 'bin', 'r2c.js');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const ENGINE_ASSET = `r2c-engine-${VERSION}.tgz`;
const PAYLOAD_ASSET = `r2c-payload-${VERSION}.tgz`;
const LAYOUT_DIRS = Object.freeze(['workflows', 'tasks', 'skills']);

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-e2e-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home that cannot fall back on the developer machine's state. */
function cleanEnv(home) {
  const env = { ...process.env };
  for (const key of [
    'R2C_SESSION_ID',
    'R2C_PROJECT_ROOT',
    'R2C_PLUGIN_SOURCE',
    'R2C_RELEASE_BASE',
    'R2C_ENGINE_HOME',
    'DSH_SESSION_ID',
    'DSH_HOME',
  ]) {
    delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.R2C_HOME = home;
  return env;
}

/**
 * The release tools the chain must never reach for. Each shim records its
 * invocation and refuses to run, so an empty marker after a successful
 * install is proof that npm, npx, gh and git were not part of the chain.
 */
function toolSentinels(t) {
  const dir = tempDir(t, 'path-shims');
  const marker = join(dir, 'invoked.log');
  for (const name of ['npm', 'npx', 'gh', 'git']) {
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\necho ${name} %*>>"${marker}"\r\nexit /b 91\r\n`);
    } else {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${marker}"\nexit 91\n`);
      chmodSync(file, 0o755);
    }
  }
  return { dir, marker };
}

/** Fake `claude` so detection and the doctor launch check never guess. */
function fakeClaude(t, version = '2.1.312') {
  const dir = tempDir(t, 'agent-bin');
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\necho ${version}\r\n`);
  } else {
    const file = join(dir, 'claude');
    writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** `node scripts/release.mjs --out <dir>`: the four flat release assets. */
function buildRelease(t) {
  const out = tempDir(t, 'release');
  const result = spawnSync(process.execPath, [RELEASE, '--out', out], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return out;
}

function bootstrap(args, { env, cwd }) {
  return spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
}

function cli(entry, args, { env, cwd }) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
}

function envelope(result) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  assert.notEqual(line, '', `no JSON envelope: ${result.stdout} / ${result.stderr}`);
  return JSON.parse(line);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Every file under `root` as POSIX relative paths, sorted. */
function walk(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(relative(root, full).split(sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

/**
 * Install the release into a fresh project with a spaced path, a fake agent
 * and shims shadowing npm/npx/gh/git. Returns everything the assertions need;
 * `result` is the bootstrap run itself.
 */
function install(t) {
  const release = buildRelease(t);
  const project = tempDir(t, 'project with space');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const shims = toolSentinels(t);
  const env = cleanEnv(home);
  withPath(env, fakeClaude(t));
  withPath(env, shims.dir);

  // The probe itself is recorded by the shim; clear the marker so the chain
  // below starts from a clean slate.
  const probe = spawnSync('npm --version', { shell: true, env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(probe.status, 0, 'npm must be unusable in this environment');
  rmSync(shims.marker, { force: true });

  const result = bootstrap(
    ['--agent', 'claude-code', '--version', VERSION, '--project', project, '--release-base', release],
    { env, cwd: tempDir(t, 'cwd') },
  );
  return {
    project,
    home,
    shims,
    env,
    result,
    engineEntry: join(project, '.r2c', 'engine', VERSION, 'bin', 'r2c.js'),
    payloadHome: join(project, '.r2c', 'payload', VERSION),
    receiptFile: join(project, '.r2c', 'install', 'claude-code.json'),
  };
}

test('the bootstrap lands engine, payload, adapter and layout from a local release alone', (t) => {
  const installed = install(t);
  const { project, home, env, result, engineEntry, payloadHome, receiptFile, shims } = installed;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  // Download → verify → extract: the engine the bootstrap announced is the one
  // unpacked from `r2c-engine-<V>.tgz`, with the vendored yaml it needs offline.
  assert.ok(result.stdout.includes(`engine ${VERSION}: ${join(project, '.r2c', 'engine', VERSION)}`), result.stdout);
  assert.ok(existsSync(engineEntry));
  assert.ok(existsSync(join(project, '.r2c', 'engine', VERSION, 'node_modules', 'yaml', 'package.json')));
  assert.match(result.stdout, /next: node "/);

  // Adapter install resolved the payload from the release directory, not a
  // cache or a source tree, and reported the layout hand-off.
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.payload.version, VERSION);
  assert.equal(receipt.payload.source, `release:v${VERSION}`);
  assert.equal(receipt.payload_home, payloadHome);
  assert.ok(existsSync(join(payloadHome, 'r2c-payload.json')));
  assert.match(result.stdout, /copied into the project root/);

  // Layout: every payload file under workflows/, tasks/ and skills/ is byte
  // identical at the project root, and the receipt records it project-relative.
  const layout = receipt.files.filter((file) => file.kind === 'layout');
  assert.ok(layout.length > 0, 'the receipt records the layout files');
  for (const dir of LAYOUT_DIRS) {
    assert.deepEqual(walk(join(project, dir)), walk(join(payloadHome, dir)), `${dir}/ mirrors the payload`);
  }
  for (const file of layout) {
    assert.equal(isAbsolute(file.path), false, `layout path is project-relative: ${file.path}`);
    assert.equal(sha256(join(project, ...file.path.split('/'))), file.sha256, file.path);
  }

  // The runner text is `node <entry>` (C3): no npx, no package name. Windows
  // records native separators; both spellings execute.
  assert.equal(
    receipt.runner_cmd.replaceAll('\\', '/'),
    `node .r2c/engine/${VERSION}/bin/r2c.js`,
  );
  assert.equal(receipt.engine.home, join(project, '.r2c', 'engine', VERSION));
  assert.equal(receipt.engine.entry, engineEntry);
  const settings = readFileSync(join(project, '.claude', 'settings.json'), 'utf8');
  assert.equal(settings.includes('npx'), false, 'the agent config does not reach for npx');

  // No network, no npm, no gh: none of the shadowed tools was ever run, and a
  // release-directory asset never populates the download cache.
  assert.equal(existsSync(shims.marker), false, 'the chain called no npm, npx, gh or git');
  assert.equal(existsSync(join(home, '.r2c')), false, 'no payload cache or user state was written');

  // The installed engine discovers the manifest that the layout put in the
  // project root, and a dry run leaves no runtime state behind.
  const dryRun = cli(engineEntry, ['run', '--dry-run', '--json'], { cwd: project, env });
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  const dry = envelope(dryRun).data;
  assert.equal(dry.dry_run, true);
  assert.equal(dry.status, 'dry-run');
  const manifests = readdirSync(join(project, 'workflows')).filter((name) => name.endsWith('.yaml'));
  assert.equal(manifests.length, 1, 'exactly one workflow manifest at the project root');
  assert.equal(realpathSync(dry.manifest), realpathSync(join(project, 'workflows', manifests[0])));
  const manifestText = readFileSync(join(project, 'workflows', manifests[0]), 'utf8');
  assert.ok(manifestText.split(/\r?\n/).includes(`id: ${dry.workflow_id}`), 'the dry run read the project-root manifest');
  assert.equal(existsSync(join(project, '.r2c', 'runs')), false, 'a dry run creates no run');
});

test('uninstall removes the layout, keeps runtime state, and doctor agrees at both ends', (t) => {
  const installed = install(t);
  const { project, env, result, engineEntry, receiptFile } = installed;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));

  // Doctor first: the receipt and the tree it describes agree.
  const healthy = cli(engineEntry, ['adapter', 'doctor', 'claude-code', '--project-root', project, '--json'], {
    cwd: project,
    env,
  });
  assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`);
  const checks = envelope(healthy).data;
  assert.equal(checks.healthy, true);
  const filesCheck = checks.checks.find((entry) => entry.name === 'receipt.files');
  assert.equal(filesCheck.status, 'pass');
  assert.equal(filesCheck.detail, `${receipt.files.length} file(s) match the receipt`);
  const engineCheck = checks.checks.find((entry) => entry.name === 'engine.executable');
  assert.equal(engineCheck.status, 'pass', JSON.stringify(engineCheck));

  // Runtime state that uninstall must not touch.
  const run = cli(engineEntry, ['run', '--json'], { cwd: project, env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const runId = envelope(run).run_id;
  assert.equal(existsSync(join(project, '.r2c', 'runs', runId, 'state.json')), true);

  const uninstall = cli(engineEntry, ['adapter', 'uninstall', 'claude-code', '--project-root', project, '--json'], {
    cwd: project,
    env,
  });
  assert.equal(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
  const removed = envelope(uninstall).data;
  assert.equal(removed.action, 'removed');
  assert.equal(removed.engine_removed, true, 'the only receipt took its engine with it');
  assert.ok(
    removed.leftover.every((entry) => !entry.startsWith('modified:')),
    `nothing diverged from the receipt: ${JSON.stringify(removed.leftover)}`,
  );

  // Every layout file the receipt owned is gone from the project root, and the
  // receipt is consistent with that uninstall report (which resolves the
  // project-relative layout paths).
  const layout = receipt.files.filter((file) => file.kind === 'layout');
  const uninstalledPaths = new Set(removed.files.map((entry) => entry.path));
  for (const file of layout) {
    const absolute = join(project, ...file.path.split('/'));
    assert.ok(uninstalledPaths.has(absolute), `uninstall reports ${absolute}`);
    assert.equal(existsSync(absolute), false, `${file.path} is gone`);
  }
  for (const dir of LAYOUT_DIRS) {
    assert.equal(existsSync(join(project, dir)), false, `${dir}/ is gone`);
  }
  assert.equal(existsSync(join(project, '.claude')), false, 'the agent config is gone');
  assert.equal(existsSync(receiptFile), false);

  // Runtime state survives: the run, its hook episode dir and latest.json.
  assert.equal(existsSync(join(project, '.r2c', 'runs', runId, 'state.json')), true, 'the run survives');
  assert.equal(existsSync(join(project, '.r2c', 'runs', '.hooks')), true, 'hook state survives');
  assert.equal(existsSync(join(project, '.r2c', 'latest.json')), true, 'latest.json survives');

  // Doctor afterwards reports the project as not installed, from the checkout's
  // engine (uninstall removed the project engine this receipt owned).
  const after = cli(BIN, ['adapter', 'doctor', 'claude-code', '--project-root', project, '--scope', 'project', '--json'], {
    cwd: project,
    env,
  });
  assert.equal(after.status, 4, `${after.stdout}\n${after.stderr}`);
  const envelopeAfter = envelope(after);
  assert.equal(envelopeAfter.ok, false);
  assert.equal(envelopeAfter.error.code, 'NOT_INSTALLED');
  assert.equal(envelopeAfter.error.details.scope, 'project');
});

test('a tampered or missing release asset fails the bootstrap with zero writes', async (t) => {
  const pristine = buildRelease(t);

  const copy = (label) => {
    const dir = tempDir(t, label);
    cpSync(pristine, dir, { recursive: true });
    return dir;
  };

  const flipByte = (file, fromEnd) => {
    const bytes = readFileSync(file);
    bytes[bytes.length - fromEnd] = (bytes[bytes.length - fromEnd] + 1) % 256;
    writeFileSync(file, bytes);
  };

  const cases = [
    {
      label: 'a byte flipped inside the engine archive',
      exitCode: 3,
      stderr: /ENGINE_CHECKSUM_MISMATCH/,
      rollback: false,
      mutate: (dir) => flipByte(join(dir, ENGINE_ASSET), 64),
    },
    {
      label: 'a truncated engine archive',
      exitCode: 3,
      stderr: /ENGINE_CHECKSUM_MISMATCH/,
      rollback: false,
      mutate: (dir) => writeFileSync(join(dir, ENGINE_ASSET), readFileSync(join(dir, ENGINE_ASSET)).subarray(0, 1024)),
    },
    {
      label: 'a missing engine archive',
      exitCode: 1,
      stderr: /ENGINE_ASSET_MISSING[\s\S]*r2c-engine-/,
      rollback: false,
      mutate: (dir) => rmSync(join(dir, ENGINE_ASSET)),
    },
    {
      label: 'a missing SHA256SUMS.txt',
      exitCode: 1,
      stderr: /ENGINE_ASSET_MISSING[\s\S]*SHA256SUMS\.txt/,
      rollback: false,
      mutate: (dir) => rmSync(join(dir, 'SHA256SUMS.txt')),
    },
    {
      // Every payload checksum failure is one exit code (2), wherever the
      // archive came from; only the engine archive is a 3.
      label: 'a byte flipped inside the payload archive',
      exitCode: 2,
      stderr: /SHA256SUMS\.txt mismatch for r2c-payload-/,
      rollback: true,
      mutate: (dir) => flipByte(join(dir, PAYLOAD_ASSET), 40),
    },
    {
      label: 'a missing payload archive',
      exitCode: 2,
      stderr: /does not carry r2c-payload-/,
      rollback: true,
      mutate: (dir) => rmSync(join(dir, PAYLOAD_ASSET)),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.label, (st) => {
      const release = copy(entry.label.replaceAll(' ', '-'));
      entry.mutate(release);
      const project = tempDir(st, 'project');
      const home = tempDir(st, 'home');
      mkdirSync(join(home, '.claude'), { recursive: true });
      const env = cleanEnv(home);

      const result = bootstrap(
        ['--agent', 'claude-code', '--version', VERSION, '--project', project, '--release-base', release],
        { env, cwd: tempDir(st, 'cwd') },
      );

      assert.equal(result.status, entry.exitCode, `${entry.label}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, entry.stderr);
      if (entry.rollback) {
        // The engine had already been extracted by the time the payload was
        // rejected, so the bootstrap has to take it back out.
        assert.ok(result.stdout.includes(`engine ${VERSION}: `), result.stdout);
        assert.match(result.stderr, /the engine this run extracted was removed/);
      } else {
        assert.equal(result.stdout.trim(), '', 'nothing was extracted');
      }
      assert.deepEqual(readdirSync(project), [], `${entry.label}: nothing written into the project`);
      assert.equal(existsSync(join(home, '.r2c')), false, `${entry.label}: no state under the user home`);
      assert.equal(existsSync(join(home, '.claude', 'settings.json')), false, `${entry.label}: no agent config`);
    });
  }
});
