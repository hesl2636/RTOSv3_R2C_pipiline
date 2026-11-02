/**
 * Install from a per-bundle Release (#106, decisions #74 / #76, spec §12–§13).
 *
 * Every case builds a real local Release with `scripts/release.mjs --bundle …
 * --out …`, then runs the published bootstrap (`scripts/install.mjs`) against
 * that directory. No test reaches the network: the one latest-resolution case
 * uses a loopback GitHub fixture. The install must only verify, unpack, write
 * and issue receipts — never compile or re-project.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../core/canonical-json.js';
import { compareCodePoints } from '../core/code-point.js';
import { sha256Hex } from '../core/node/sha256.js';
import { installRelease, selectProjection, checkEngineRequirement } from '../installer/release-install.js';
import { serializeIr } from '../ir/serialize.js';
import { LAUNCHER_TEXT, RUNTIME_RECEIPT_PATH } from '../installer/runtime.js';
import { createReleaseTarGz, readReleaseTarGz } from '../scripts/lib/release-tar.mjs';
import { rawResponse, startGithubFixture, startHttpFixture } from './helpers/release-fixture.js';
import { toolSentinels } from './helpers/tools.js';
import { withPath } from './support/env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(ROOT, 'scripts', 'install.mjs');
const RELEASE = join(ROOT, 'scripts', 'release.mjs');
const SAMPLE_ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const SAMPLE_DIR = join(ROOT, 'examples/rtosv3/bundle');
const ID = 'rtosv3-drvport';
const VERSION = '1.0.0';
const ENGINE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const AGENT_TARGETS = ['claude-code', 'codex', 'dsh', 'omp', 'opencode'];

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-release-install-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(relative(root, full).split(sep).join('/'));
    }
  };
  if (existsSync(root)) visit(root);
  return files.sort(compareCodePoints);
}

/** Every file under `root` with its digest; the zero-write snapshot. */
function snapshot(root) {
  const out = new Map();
  for (const rel of walk(root)) out.set(rel, sha256File(join(root, ...rel.split('/'))));
  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** A local bundle source directory whose `requires` is overridden. */
function bundleSource(t, { projections = null, engine = undefined } = {}) {
  const dir = tempDir(t, 'bundle');
  cpSync(SAMPLE_DIR, dir, { recursive: true });
  const file = join(dir, 'bundle.json');
  const manifest = readJson(file);
  const requires = { ...(manifest.requires ?? {}) };
  if (projections !== null) requires.projections = projections;
  if (engine !== undefined) requires.engine = engine;
  if (Object.keys(requires).length === 0) delete manifest.requires;
  else manifest.requires = requires;
  writeFileSync(file, canonicalJson(manifest));
  return dir;
}

/** `node scripts/release.mjs --bundle <source> --out <dir>`: a local Release. */
function buildRelease(t, { projections = null, engine = undefined } = {}) {
  const out = tempDir(t, 'release');
  const source = projections === null && engine === undefined
    ? SAMPLE_ZIP
    : bundleSource(t, { projections, engine });
  const result = spawnSync(process.execPath, [RELEASE, '--bundle', source, '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `release build failed:\n${result.stdout}\n${result.stderr}`);
  return out;
}

function payloadManifest(dir, name) {
  const bytes = readFileSync(join(dir, name));
  const { entries, problems } = readReleaseTarGz(bytes);
  assert.deepEqual(problems, []);
  const manifest = entries.find((entry) => entry.path === 'manifest.json');
  assert.ok(manifest, `${name} carries manifest.json`);
  return {
    bytes,
    entries: new Map(entries.map((entry) => [entry.path, entry])),
    manifest: JSON.parse(Buffer.from(manifest.data).toString('utf8')),
  };
}

/** A home no developer state can leak through. */
function cleanEnv(home) {
  const env = { ...process.env };
  for (const key of [
    'R2C_SESSION_ID',
    'R2C_PROJECT_ROOT',
    'R2C_PLUGIN_SOURCE',
    'R2C_RELEASE_BASE',
    'R2C_ENGINE_HOME',
    'R2C_HOME',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'DSH_SESSION_ID',
    'DSH_HOME',
    'R2C_GITHUB_API',
  ]) {
    delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function isolatedEnv(t) {
  const home = tempDir(t, 'home');
  const shims = toolSentinels(t);
  const env = cleanEnv(home);
  withPath(env, shims.dir);
  return { env, shims, home };
}

function install(args, { env, cwd }) {
  return spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    cwd: cwd ?? env.HOME,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
}

/** Async twin: a loopback fixture in this process must stay responsive. */
function installAsync(args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOOTSTRAP, ...args], {
      cwd: cwd ?? env.HOME,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function project(t) {
  return tempDir(t, 'project');
}

function receipt(projectRoot, projectionId = 'r2c', bundleId = ID) {
  const file = join(projectRoot, '.r2c', 'install', 'receipts', projectionId, `${bundleId}.json`);
  assert.ok(existsSync(file), `missing receipt ${file}`);
  return { file, data: readJson(file) };
}

/** Paths the payload manifest declares for one projection. */
function payloadPaths(manifest) {
  return manifest.files.map((file) => `files/${file.path}`);
}

test('r2c installs the runtime and the pre-projected tree without compiling', (t) => {
  const release = buildRelease(t);
  const target = project(t);
  const { env, shims } = isolatedEnv(t);

  const result = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /r2c\/rtosv3-drvport@1\.0\.0/);
  assert.equal(shims.invoked(), false, 'the chain called no npm, npx, gh or git');

  const r2cPayload = payloadManifest(release, `r2c-payload-${ID}-v${VERSION}.tgz`);
  const projected = r2cPayload.manifest.files.map((file) => file.path).sort(compareCodePoints);
  assert.equal(projected.length, 45);

  // The five roots carry exactly the projected files, byte for byte.
  const outside = walk(target).filter((path) => !path.startsWith('.r2c/') && !path.startsWith('.claude/')
    && !path.startsWith('.agents/') && !path.startsWith('.codex/') && !path.startsWith('.omp/')
    && !path.startsWith('.opencode/') && !path.startsWith('.dsh/'));
  const roots = projected.filter((path) => /^(workflows|tasks|skills|roles|constitution)\//.test(path));
  assert.deepEqual(outside.sort(compareCodePoints), [...roots].sort(compareCodePoints));
  for (const file of r2cPayload.manifest.files) {
    assert.equal(sha256File(join(target, ...file.path.split('/'))), file.sha256, file.path);
  }

  // Runtime: engine, fixed launcher, runtime receipt.
  const engineEntry = join(target, '.r2c', 'engine', ENGINE_VERSION, 'bin', 'r2c.js');
  assert.ok(existsSync(engineEntry), 'the release engine was unpacked');
  assert.equal(readFileSync(join(target, '.r2c', 'bin', 'r2c.js'), 'utf8'), LAUNCHER_TEXT);
  const runtime = readJson(join(target, ...RUNTIME_RECEIPT_PATH.split('/')));
  assert.equal(runtime.schema, 'r2c.runtime/v1');
  assert.equal(runtime.engine.version, ENGINE_VERSION);
  assert.deepEqual(runtime.host_targets, AGENT_TARGETS);

  // Host roles and roles.json are installer-owned: four role files + one report.
  const hostRoles = walk(target).filter((path) => /^\.(claude\/agents|codex\/agents|omp\/agents|opencode\/agents)\/r2c-.*/.test(path));
  assert.equal(hostRoles.length, 16, 'four roles × four host targets');
  const roles = readJson(join(target, '.r2c', 'projection', 'roles.json'));
  assert.equal(roles.schema, 'r2c.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets), ['claude-code', 'codex', 'omp', 'opencode']);

  // Receipt: every owned path hashes from disk, the IR copy matches its digest.
  const own = receipt(target);
  assert.equal(own.data.schema, 'r2c.install/v2');
  assert.equal(own.data.projection.id, 'r2c');
  assert.deepEqual(own.data.projection.targets, ['r2c']);
  assert.equal(own.data.bundle.id, ID);
  assert.equal(own.data.bundle.version, VERSION);
  assert.equal(own.data.mode, 'fresh');
  assert.deepEqual(own.data.host_targets, ['claude-code', 'codex', 'omp', 'opencode']);
  assert.equal(own.data.requires_engine, null);
  const ownedPaths = own.data.files.map((file) => file.path).sort(compareCodePoints);
  assert.deepEqual(ownedPaths, [...projected, ...hostRoles, '.r2c/projection/roles.json'].sort(compareCodePoints));
  for (const file of own.data.files) {
    assert.equal(sha256File(join(target, ...file.path.split('/'))), file.sha256, file.path);
  }
  const irCopy = join(target, ...own.data.ir.path.split('/'));
  assert.equal(sha256File(irCopy), own.data.ir.digest);
  assert.equal(own.data.metadata.placeholders.constitution, 'placeholder');
  assert.equal(own.data.capability_report.length, 8);

  // Install-time evidence: no payload cache, no projection result, no compile.
  assert.equal(existsSync(join(target, '.r2c', 'payload')), false);
  assert.equal(walk(target).some((path) => path.endsWith('projection-result.json')), false);
  assert.equal(walk(target).some((path) => path.endsWith('bundle.json')), false);
});

test('agent-native installs the bundle only, never an engine', (t) => {
  const release = buildRelease(t);
  const target = project(t);
  const { env } = isolatedEnv(t);

  const result = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'agent-native', '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const payload = payloadManifest(release, `agent-native-${ID}-v${VERSION}.tgz`);
  assert.equal(payload.manifest.files.length, 98);
  const expected = payload.manifest.files.map((file) => file.path).sort(compareCodePoints);
  assert.deepEqual(walk(target).filter((path) => !path.startsWith('.r2c/')), expected);
  for (const file of payload.manifest.files) {
    assert.equal(sha256File(join(target, ...file.path.split('/'))), file.sha256, file.path);
  }
  assert.ok(existsSync(join(target, '.agents', 'agent-native', ID, 'roles.json')));
  assert.ok(existsSync(join(target, '.dsh', 'agent-native', `${ID}.roles.md`)));
  assert.ok(walk(target).some((path) => /^\.claude\/agents\/rtosv3-drvport-.*\.md$/.test(path)));
  assert.ok(walk(target).some((path) => /^\.codex\/agents\/rtosv3-drvport-.*\.toml$/.test(path)));

  // No engine, no launcher, no runtime receipt, no r2c host roles.
  assert.equal(existsSync(join(target, '.r2c', 'engine')), false);
  assert.equal(existsSync(join(target, '.r2c', 'bin')), false);
  assert.equal(existsSync(join(target, ...RUNTIME_RECEIPT_PATH.split('/'))), false);
  assert.equal(existsSync(join(target, '.r2c', 'projection')), false);
  assert.equal(walk(target).some((path) => /^\.\w+\/agents\/r2c-/.test(path)), false);

  const own = receipt(target, 'agent-native');
  assert.deepEqual(own.data.projection.targets, AGENT_TARGETS);
  assert.deepEqual(own.data.options.targets, AGENT_TARGETS);
  assert.deepEqual(own.data.files.map((file) => file.path).sort(compareCodePoints), expected);
  assert.equal(own.data.capability_report.length, 40);
  for (const file of own.data.files) {
    assert.equal(sha256File(join(target, ...file.path.split('/'))), file.sha256, file.path);
  }
});

test('--target narrows the written files but roles.json is still installed', (t) => {
  const release = buildRelease(t);
  const target = project(t);
  const { env } = isolatedEnv(t);

  const result = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'agent-native', '--target', 'claude-code',
      '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const payload = payloadManifest(release, `agent-native-${ID}-v${VERSION}.tgz`);
  const wanted = payload.manifest.files
    .filter((file) => file.targets.includes('claude-code'))
    .map((file) => file.path)
    .sort(compareCodePoints);
  assert.deepEqual(walk(target).filter((path) => !path.startsWith('.r2c/')), wanted);
  assert.ok(wanted.includes(`.agents/agent-native/${ID}/roles.json`));
  for (const other of ['.codex', '.omp', '.opencode', '.dsh']) {
    assert.equal(existsSync(join(target, other)), false, `${other} was not written`);
  }
  assert.equal(existsSync(join(target, '.agents', 'skills')), false, 'shared skills belong to the other targets');

  const own = receipt(target, 'agent-native');
  assert.deepEqual(own.data.projection.targets, ['claude-code']);
  assert.deepEqual(own.data.options.targets, ['claude-code']);
  assert.deepEqual(own.data.files.map((file) => file.path).sort(compareCodePoints), wanted);
  assert.equal(own.data.capability_report.length, 8, 'one target × eight capabilities');

  const again = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'agent-native', '--target', 'claude-code',
      '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.match(again.stdout, /unchanged/);
});

test('a release that only allows agent-native refuses r2c before any write', (t) => {
  const release = buildRelease(t, { projections: ['agent-native'] });
  const target = project(t);
  const { env } = isolatedEnv(t);
  const before = snapshot(target);

  const refused = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`);
  assert.match(refused.stderr, /RELEASE_PROJECTION_NOT_ALLOWED/);
  assert.deepEqual(snapshot(target), before);

  // One allowed projection: omitting --projection selects it.
  const auto = install(
    ['--bundle', ID, '--version', VERSION, '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(auto.status, 0, `${auto.stdout}\n${auto.stderr}`);
  assert.equal(existsSync(join(target, '.r2c', 'engine')), false);
  assert.ok(existsSync(join(target, '.agents', 'agent-native', ID, 'roles.json')));
});

test('two allowed projections require an explicit choice', (t) => {
  const release = buildRelease(t);
  const target = project(t);
  const { env } = isolatedEnv(t);
  const before = snapshot(target);

  const ambiguous = install(
    ['--bundle', ID, '--version', VERSION, '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(ambiguous.status, 2, `${ambiguous.stdout}\n${ambiguous.stderr}`);
  assert.match(ambiguous.stderr, /RELEASE_PROJECTION_REQUIRED/);
  assert.match(ambiguous.stderr, /r2c/);
  assert.match(ambiguous.stderr, /agent-native/);
  assert.deepEqual(snapshot(target), before);
});

test('three-way tampering refuses with zero writes', (t) => {
  const pristine = buildRelease(t);
  const cases = [];

  const copy = (label) => {
    const dir = tempDir(t, label);
    cpSync(pristine, dir, { recursive: true });
    return dir;
  };
  const mutate = (dir, file, edit) => {
    const path = join(dir, file);
    writeFileSync(path, edit(readFileSync(path)));
  };
  const rewriteSums = (dir, name) => {
    const file = join(dir, 'SHA256SUMS.txt');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      const [digest, asset] = line.split(/\s+/);
      return asset === name ? `${sha256File(join(dir, name))}  ${name}` : `${digest}  ${asset}`;
    });
    writeFileSync(file, `${lines.join('\n')}\n`);
  };

  // 1) one byte flipped in the payload asset: sums catch it.
  {
    const dir = copy('payload-byte');
    mutate(dir, `r2c-payload-${ID}-v${VERSION}.tgz`, (bytes) => {
      bytes[bytes.length - 20] = (bytes[bytes.length - 20] + 1) % 256;
      return bytes;
    });
    cases.push({ dir, label: 'payload byte flip' });
  }

  // 2) truncated archive that still matches its (updated) sums entry: the
  //    member/hash self-proof catches it.
  {
    const dir = copy('payload-truncated');
    const name = `r2c-payload-${ID}-v${VERSION}.tgz`;
    const original = readFileSync(join(dir, name));
    const { entries } = readReleaseTarGz(original);
    const truncated = Buffer.concat([original.subarray(0, Math.max(64, original.length - 4096))]);
    writeFileSync(join(dir, name), truncated);
    rewriteSums(dir, name);
    cases.push({ dir, label: `truncated payload (${entries.length} members originally)` });
  }

  // 3) payload member hash mismatch: manifest untouched, sums re-frozen.
  {
    const dir = copy('payload-member');
    const name = `r2c-payload-${ID}-v${VERSION}.tgz`;
    const { entries } = readReleaseTarGz(readFileSync(join(dir, name)));
    const targetPath = entries.find((entry) => entry.path.startsWith('files/workflows/')).path;
    const tampered = createReleaseTarGz(entries.map((entry) => (entry.path === targetPath
      ? { path: entry.path, data: Buffer.from('schema: "r2c.workflow/v1"\n'), mode: entry.mode }
      : { path: entry.path, data: entry.data, mode: entry.mode })));
    writeFileSync(join(dir, name), tampered);
    rewriteSums(dir, name);
    cases.push({ dir, label: 'payload member hash' });
  }

  // 4) zip member edited in place + sums re-frozen: IR's manifest digest breaks.
  {
    const dir = copy('zip-member');
    const name = `bundle-${ID}-v${VERSION}.zip`;
    const bytes = readFileSync(join(dir, name));
    const needle = Buffer.from('"description": "');
    const at = bytes.indexOf(needle);
    assert.ok(at > 0, 'bundle.json description found');
    bytes[at + needle.length] = bytes[at + needle.length] === 0x41 ? 0x42 : 0x41;
    writeFileSync(join(dir, name), bytes);
    rewriteSums(dir, name);
    cases.push({ dir, label: 'zip bundle.json byte' });
  }

  // 5) a missing asset.
  {
    const dir = copy('missing');
    rmSync(join(dir, `r2c-payload-${ID}-v${VERSION}.tgz`));
    cases.push({ dir, label: 'missing payload asset' });
  }

  for (const { dir, label } of cases) {
    const target = project(t);
    const { env } = isolatedEnv(t);
    const before = snapshot(target);
    const result = install(
      ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--project', target, '--release-base', dir],
      { env },
    );
    assert.equal(result.status, 2, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.deepEqual(snapshot(target), before, `${label} wrote into the project`);
    assert.equal(existsSync(join(target, '.r2c')), false, `${label} created state`);
  }
});

test('a wrong --version or unknown --target refuses before writing', (t) => {
  const release = buildRelease(t);
  const target = project(t);
  const { env } = isolatedEnv(t);

  const wrong = install(
    ['--bundle', ID, '--version', '9.9.9', '--projection', 'r2c', '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(wrong.status, 2, `${wrong.stdout}\n${wrong.stderr}`);
  assert.match(wrong.stderr, /workflow\.ir\.json|RELEASE_/);

  const unknown = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'agent-native', '--target', 'cursor',
      '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(unknown.status, 2, `${unknown.stdout}\n${unknown.stderr}`);
  assert.match(unknown.stderr, /RELEASE_PAYLOAD_TARGET_UNKNOWN/);

  const conflict = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--target', 'claude-code',
      '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(conflict.status, 2, `${conflict.stdout}\n${conflict.stderr}`);
  assert.match(conflict.stderr, /RELEASE_OPTION_CONFLICT/);
  assert.equal(walk(target).length, 0);

  const custom = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--stage-order', 'reverse',
      '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(custom.status, 2, `${custom.stdout}\n${custom.stderr}`);
  assert.match(custom.stderr, /already projected/);
  assert.match(custom.stderr, /Re-project/i);
  assert.equal(walk(target).length, 0, 'a rejected projection option writes nothing');
});

test('the bootstrap keeps the legacy surface byte-compatible', (t) => {
  const help = spawnSync(process.execPath, [BOOTSTRAP, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0);
  for (const flag of ['--agent', '--version', '--scope', '--project', '--release-base', '--profile', '--force',
    '--bundle', '--projection', '--target']) {
    assert.ok(help.stdout.includes(flag), `--help does not print ${flag}`);
  }

  const legacy = install(['--agent', 'claude-code', '--version', VERSION], {
    env: cleanEnv(tempDir(t, 'home')),
  });
  assert.equal(legacy.status, 1, 'legacy path still resolves the GitHub release base');
  assert.match(legacy.stderr, /ENGINE_/);

  const mixed = install(['--agent', 'claude-code', '--bundle', ID, '--version', VERSION], {
    env: cleanEnv(tempDir(t, 'home')),
  });
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /RELEASE_OPTION_CONFLICT/);

  const userScope = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--scope', 'user'],
    { env: cleanEnv(tempDir(t, 'home')) },
  );
  assert.equal(userScope.status, 2);
  assert.match(userScope.stderr, /RELEASE_OPTION_CONFLICT/);
});

test('an omitted --version resolves the latest bundle release through the release source', async (t) => {
  const release = buildRelease(t);
  const assets = readdirSync(release).sort(compareCodePoints).map((name) => ({
    name,
    data: readFileSync(join(release, name)),
  }));

  const fixture = await startGithubFixture(t, {
    repo: 'hesl2636/hm2B_drvport_pipiline',
    releases: [
      { tag: `bundle-${ID}-v0.9.0`, assets },
      { tag: `bundle-${ID}-v2.0.0`, draft: true, assets },
      { tag: `bundle-${ID}-v1.5.0`, prerelease: true, assets },
      { tag: `bundle-${ID}-v${VERSION}`, assets },
    ],
  });
  // The fixture seeds its own release ids; the published 1.0.0 assets are what
  // the run must pick even though newer draft/prerelease tags exist.
  const target = project(t);
  const env = cleanEnv(tempDir(t, 'home'));
  env.R2C_GITHUB_API = fixture.apiBase;

  const result = await installAsync(
    ['--bundle', ID, '--projection', 'r2c', '--project', target, '--release-base', `${fixture.origin}/download`],
    { env },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(join(target, '.r2c', 'engine', ENGINE_VERSION, 'bin', 'r2c.js')), true);
  const own = receipt(target);
  assert.equal(own.data.bundle.version, VERSION);
  const listCalls = fixture.callsOf('GET', '/releases(\\?|$)');
  assert.ok(listCalls.length >= 1, 'the latest path lists releases');
});

test('projection and engine requirement evaluation is the release contract', () => {
  assert.deepEqual(
    selectProjection({ allowed: ['r2c', 'agent-native'], requested: 'r2c' }),
    { ok: true, projection: 'r2c' },
  );
  assert.deepEqual(selectProjection({ allowed: ['agent-native'], requested: undefined }), {
    ok: true,
    projection: 'agent-native',
  });
  assert.equal(selectProjection({ allowed: ['agent-native'], requested: 'r2c' }).code, 'RELEASE_PROJECTION_NOT_ALLOWED');
  assert.equal(selectProjection({ allowed: ['r2c', 'agent-native'], requested: undefined }).code, 'RELEASE_PROJECTION_REQUIRED');
  assert.equal(selectProjection({ allowed: ['agent-native'], requested: 'nope' }).code, 'RELEASE_PROJECTION_NOT_ALLOWED');

  assert.deepEqual(checkEngineRequirement({ range: undefined, engineVersion: null }), { ok: true });
  assert.deepEqual(checkEngineRequirement({ range: '^0.1.0', engineVersion: ENGINE_VERSION }), { ok: true });
  assert.equal(checkEngineRequirement({ range: '^9.0.0', engineVersion: ENGINE_VERSION }).code, 'PROJECTION_ENGINE_UNSATISFIED');
  assert.equal(checkEngineRequirement({ range: '^0.1.0', engineVersion: null }).code, 'PROJECTION_ENGINE_UNKNOWN');
});

/** The release assets as an in-memory map, with sums regenerated after edits. */
function releaseAssets(release) {
  return new Map(readdirSync(release).sort(compareCodePoints).map((name) => [name, readFileSync(join(release, name))]));
}

function sumsFor(assets) {
  const lines = [...assets.keys()].sort(compareCodePoints)
    .filter((name) => name !== 'SHA256SUMS.txt')
    .map((name) => `${sha256Hex(assets.get(name))}  ${name}\n`);
  return Buffer.from(lines.join(''), 'utf8');
}

test('installRelease refuses a payload whose result block is missing', (t) => {
  const release = buildRelease(t);
  const target = project(t);
  const name = `r2c-payload-${ID}-v${VERSION}.tgz`;
  const payload = payloadManifest(release, name);
  delete payload.manifest.result;
  const rebuilt = createReleaseTarGz([...payload.entries.values()].map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    data: entry.path === 'manifest.json' ? Buffer.from(canonicalJson(payload.manifest), 'utf8') : entry.data,
  })));

  const assets = releaseAssets(release);
  assets.set(name, rebuilt);
  const sumsBytes = sumsFor(assets);

  const outcome = installRelease({
    projectRoot: target,
    bundleId: ID,
    version: VERSION,
    projection: 'r2c',
    sumsBytes,
    assets: Object.fromEntries(assets),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.message, /RELEASE_PAYLOAD_INVALID/);
  assert.equal(walk(target).length, 0);
});

/** Write an in-memory asset map back to a fresh local release directory. */
function writeAssets(t, assets) {
  const dir = tempDir(t, 'patched');
  for (const [name, bytes] of assets) writeFileSync(join(dir, name), bytes);
  return dir;
}

/** A coherent Release whose IR asks for an engine the Release does not ship. */
function withEngineRequirement(t, release, range) {
  const assets = releaseAssets(release);
  const ir = JSON.parse(assets.get('workflow.ir.json').toString('utf8'));
  ir.requires = { ...(ir.requires ?? {}), engine: range };
  const irBytes = Buffer.from(serializeIr(ir), 'utf8');
  const irDigest = sha256Hex(irBytes);
  assets.set('workflow.ir.json', irBytes);
  for (const projectionId of ['r2c', 'agent-native']) {
    const name = projectionId === 'r2c'
      ? `r2c-payload-${ID}-v${VERSION}.tgz`
      : `agent-native-${ID}-v${VERSION}.tgz`;
    const payload = payloadManifest(release, name);
    payload.manifest.ir.digest = irDigest;
    payload.manifest.result.ir.digest = irDigest;
    payload.manifest.result.options.ir.digest = irDigest;
    assets.set(name, createReleaseTarGz([...payload.entries.values()].map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      data: entry.path === 'manifest.json'
        ? Buffer.from(canonicalJson(payload.manifest), 'utf8')
        : entry.data,
    }))));
  }
  assets.set('SHA256SUMS.txt', sumsFor(assets));
  return writeAssets(t, assets);
}

test('requires.engine gates r2c and is ignored by agent-native', (t) => {
  const release = withEngineRequirement(t, buildRelease(t), '^9.0.0');
  const runtimeTarget = project(t);
  const { env } = isolatedEnv(t);

  const refused = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--project', runtimeTarget, '--release-base', release],
    { env },
  );
  assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`);
  assert.match(refused.stderr, /PROJECTION_ENGINE_UNSATISFIED/);
  assert.match(refused.stderr, /\^9\.0\.0/);
  assert.equal(walk(runtimeTarget).length, 0, 'nothing was written');

  const agentTarget = project(t);
  const accepted = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'agent-native', '--project', agentTarget, '--release-base', release],
    { env },
  );
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  assert.equal(existsSync(join(agentTarget, '.r2c', 'engine')), false);
});

test('a truncated IR asset refuses before writing', (t) => {
  const pristine = buildRelease(t);
  const assets = releaseAssets(pristine);
  const irBytes = assets.get('workflow.ir.json');
  assets.set('workflow.ir.json', irBytes.subarray(0, Math.floor(irBytes.length / 2)));
  assets.set('SHA256SUMS.txt', sumsFor(assets));
  const release = writeAssets(t, assets);
  const target = project(t);
  const { env } = isolatedEnv(t);

  const result = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /RELEASE_IR_MISMATCH/);
  assert.equal(walk(target).length, 0);
});

test('--target r2c is accepted for r2c and writes the same tree', (t) => {
  const release = buildRelease(t);
  const target = project(t);
  const { env } = isolatedEnv(t);
  const result = install(
    ['--bundle', ID, '--version', VERSION, '--projection', 'r2c', '--target', 'r2c',
      '--project', target, '--release-base', release],
    { env },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(existsSync(join(target, '.r2c', 'engine', ENGINE_VERSION, 'bin', 'r2c.js')));
});

test('an explicit version downloads anonymously over the mirror URL without the API', async (t) => {
  const release = buildRelease(t);
  const files = new Map(readdirSync(release).map((name) => [name, readFileSync(join(release, name))]));
  const fixture = await startHttpFixture(t, (ctx) => {
    const match = /^\/download\/([^/]+)\/([^/]+)$/.exec(ctx.path);
    if (match === null) return undefined;
    const data = files.get(decodeURIComponent(match[2]));
    return data === undefined ? undefined : rawResponse(200, data);
  });
  const target = project(t);
  const env = cleanEnv(tempDir(t, 'home'));

  // No --project: the default is the current directory.
  const result = await installAsync(
    ['--bundle', ID, '--version', VERSION, '--projection', 'agent-native', '--target', 'claude-code',
      '--release-base', `${fixture.origin}/download`],
    { env, cwd: target },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(fixture.requests.length > 0);
  for (const request of fixture.requests) {
    assert.match(request.path, /^\/download\/bundle-rtosv3-drvport-v1\.0\.0\//);
    assert.equal(request.headers.authorization, undefined, 'the anonymous path sends no credential');
  }
  assert.ok(existsSync(join(target, '.agents', 'agent-native', ID, 'roles.json')));
});
