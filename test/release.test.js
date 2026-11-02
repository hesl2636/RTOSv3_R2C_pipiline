import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256, sha256File, createTarGz } from '../src/plugin.js';
import { isR2cError } from '../src/errors.js';
import { withPath } from './support/env.js';
import { toolSentinels } from './helpers/tools.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const RELEASE = join(REPO, 'scripts', 'release.mjs');
const BOOTSTRAP = join(REPO, 'scripts', 'install.mjs');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const ASSET = `r2c-payload-${VERSION}.tgz`;
const ENGINE_ASSET = `r2c-engine-${VERSION}.tgz`;
const INSTALL_ASSET = 'install.mjs';
const SUMS_ASSET = 'SHA256SUMS.txt';
const ADAPTERS = ['claude-code', 'codex', 'dsh', 'omp', 'opencode'];

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-release-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runRelease(args, { cwd = REPO } = {}) {
  const script = cwd === REPO ? RELEASE : join(cwd, 'scripts', 'release.mjs');
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function build(t, prefix = 'build') {
  const out = tempDir(t, prefix);
  const result = runRelease(['--out', out]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return out;
}

/**
 * Copy the checkout without VCS/build artefacts so the copy is self-contained;
 * the vendored `yaml` dependency is what a release build needs, so it comes along.
 */
function copyRepo(t, prefix = 'repo') {
  const copy = tempDir(t, prefix);
  cpSync(REPO, copy, {
    recursive: true,
    filter: (source) => {
      if (source === REPO) return true;
      const parts = source.split(sep);
      if (parts.includes('node_modules') || parts.includes('.git')) return false;
      const name = basename(source);
      return !['dist', '.tmpbuild', '.r2c'].includes(name);
    },
  });
  cpSync(join(REPO, 'node_modules', 'yaml'), join(copy, 'node_modules', 'yaml'), { recursive: true });
  return copy;
}

function cli(args, { env, cwd = REPO } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

function envelope(result) {
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return JSON.parse(line);
}

function cleanEnv(home) {
  const env = { ...process.env };
  for (const key of ['R2C_SESSION_ID', 'R2C_PROJECT_ROOT', 'R2C_PLUGIN_SOURCE']) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.R2C_HOME = home;
  return env;
}

function readString(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

/** Independent ustar reader: the tests must not trust the release writer. */
function listArchive(file) {
  const tar = gunzipSync(readFileSync(file));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    offset += 512;
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    entries.push({ path: prefix === '' ? name : `${prefix}/${name}`, type, data });
  }
  return entries;
}

function manifestOf(file) {
  const entry = listArchive(file).find((item) => item.path === 'r2c-payload.json');
  assert.ok(entry, 'archive contains r2c-payload.json');
  return JSON.parse(entry.data.toString('utf8'));
}

function walkFiles(dir, prefix) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walkFiles(join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

function expectedPayload() {
  const paths = new Set(['LICENSE']);
  files(paths, 'shims', join(REPO, 'shims'));
  for (const dir of ['adapters', 'schema']) files(paths, dir, join(REPO, dir));
  for (const dir of ['commands', 'skills', 'tasks', 'workflows']) files(paths, dir, join(REPO, 'pack', dir));
  return paths;
}

function files(target, prefix, dir) {
  for (const rel of walkFiles(dir, prefix)) target.add(rel);
}

function extractArchive(file, destination) {
  for (const entry of listArchive(file)) {
    assert.equal(entry.type, '0', `only regular files: ${entry.path}`);
    const target = join(destination, ...entry.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  return destination;
}

function bootstrap(args, { env, cwd } = {}) {
  return spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env,
    timeout: 240_000,
  });
}

/** A release directory with the engine asset removed or replaced. */
function releaseWith(t, mutate) {
  const out = build(t, 'release');
  mutate(out);
  return out;
}

function expectedEngine() {
  const paths = new Set(['package.json', 'LICENSE']);
  for (const dir of ['bin', 'src', 'schema']) files(paths, dir, join(REPO, dir));
  files(paths, 'node_modules/yaml', join(REPO, 'node_modules', 'yaml'));
  return paths;
}

/** Flip one byte of a member's payload while keeping the tar structure valid. */
function tamperArchive(file, targetPath) {
  const tar = Buffer.from(gunzipSync(readFileSync(file)));
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8);
    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (name === targetPath) {
      assert.ok(size > 0, `${targetPath} is not empty`);
      tar[dataStart] = (tar[dataStart] + 1) % 256;
      return gzipSync(tar, { level: 9 });
    }
  }
  throw new Error(`archive member not found: ${targetPath}`);
}

test('two consecutive builds are byte-identical and list identical per-file hashes', (t) => {
  const first = build(t, 'first');
  const second = build(t, 'second');
  const archiveA = join(first, ASSET);
  const archiveB = join(second, ASSET);

  assert.equal(sha256File(archiveA), sha256File(archiveB));
  assert.equal(
    sha256File(join(first, ENGINE_ASSET)),
    sha256File(join(second, ENGINE_ASSET)),
    'engine archive is byte-identical across builds',
  );
  assert.equal(
    sha256File(join(first, INSTALL_ASSET)),
    sha256File(join(second, INSTALL_ASSET)),
    'install.mjs asset is byte-identical across builds',
  );
  assert.equal(
    readFileSync(join(first, SUMS_ASSET), 'utf8'),
    readFileSync(join(second, SUMS_ASSET), 'utf8'),
  );
  assert.equal(
    readFileSync(join(first, INSTALL_ASSET)).equals(readFileSync(BOOTSTRAP)),
    true,
    'the published install.mjs is the repository bootstrap, byte for byte',
  );
  assert.deepEqual(manifestOf(archiveA).files, manifestOf(archiveB).files);
});

test('one build writes exactly the four assets and the sums cover every hashed asset', (t) => {
  const out = build(t);

  assert.deepEqual(readdirSync(out).sort(), [
    SUMS_ASSET,
    INSTALL_ASSET,
    ENGINE_ASSET,
    ASSET,
  ].sort());

  // Sorted asset names, one digest each, no self-entry and no extra asset.
  const lines = readFileSync(join(out, SUMS_ASSET), 'utf8').split('\n').filter(Boolean);
  const expected = [INSTALL_ASSET, ENGINE_ASSET, ASSET].sort();
  assert.deepEqual(lines.map((line) => line.slice(64 + 2)), expected);
  for (const line of lines) {
    const [, digest, name] = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.equal(digest, sha256File(join(out, name)), `${name} digest matches its file`);
  }
  assert.equal(
    readFileSync(join(out, INSTALL_ASSET)).equals(readFileSync(BOOTSTRAP)),
    true,
    'install.mjs is published byte-identical to scripts/install.mjs',
  );
});

test('archive paths and metadata follow the payload contract exactly', (t) => {
  const out = build(t);
  const archive = join(out, ASSET);
  const entries = listArchive(archive);

  assert.ok(entries.every((entry) => entry.type === '0'), 'only regular files');
  const paths = entries.map((entry) => entry.path).sort();
  const expected = [...expectedPayload()].sort();
  assert.deepEqual(paths, ['r2c-payload.json', ...expected].sort());

  for (const path of paths) {
    assert.ok(Buffer.byteLength(path) <= 100, `path is longer than 100 bytes: ${path}`);
    assert.ok(!path.startsWith('/') && !path.includes('\\'), path);
    assert.ok(!path.includes('..'), path);
  }
  for (const notShipped of [/^package\.json$/, /^test\//, /^docs\//, /^plugins\//, /^scripts\//]) {
    assert.ok(!paths.some((path) => notShipped.test(path)), `unexpected payload path ${notShipped}`);
  }

  for (const id of ADAPTERS) {
    assert.ok(paths.includes(`adapters/${id}/adapter.json`), `payload ships ${id}`);
    assert.ok(paths.includes(`adapters/${id}/map.json`), `payload ships ${id} map`);
  }

  const manifest = manifestOf(archive);
  assert.equal(manifest.schema, 'r2c.plugin/v1');
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.engine, `^${VERSION}`);
  assert.deepEqual(Object.keys(manifest.files).sort(), expected.sort());
});

test('build refuses payload paths longer than 100 bytes and symlinked files', (t) => {
  const longCopy = copyRepo(t, 'long-path');
  const longName = `${'x'.repeat(96)}.md`;
  writeFileSync(join(longCopy, 'pack', 'tasks', longName), 'x');
  const tooLong = runRelease(['--out', tempDir(t, 'long-out')], { cwd: longCopy });
  assert.equal(tooLong.status, 1, tooLong.stdout);
  assert.match(tooLong.stderr, /payload path is \d+ bytes \(max 100\)/);

  const linkCopy = copyRepo(t, 'symlink');
  try {
    if (process.platform === 'win32') {
      // Junctions are creatable without elevation and lstat reports them as links.
      symlinkSync(linkCopy, join(linkCopy, 'pack', 'tasks', 'linked'), 'junction');
    } else {
      symlinkSync(join(linkCopy, 'README.md'), join(linkCopy, 'pack', 'tasks', 'linked.md'));
    }
  } catch {
    t.skip('symlink creation is not permitted on this platform');
    return;
  }
  const linked = runRelease(['--out', tempDir(t, 'link-out')], { cwd: linkCopy });
  assert.equal(linked.status, 1, linked.stdout);
  assert.match(linked.stderr, /symlink not allowed in payload/);
});

test('--check passes on the repository and fails when an adapter engine range drifts', (t) => {
  const pass = runRelease(['--check']);
  assert.equal(pass.status, 0, pass.stderr);

  const copy = copyRepo(t);
  const baseline = runRelease(['--check'], { cwd: copy });
  assert.equal(baseline.status, 0, baseline.stderr);

  const adapterFile = join(copy, 'adapters', 'codex', 'adapter.json');
  const adapter = JSON.parse(readFileSync(adapterFile, 'utf8'));
  adapter.requires.engine = '^0.0.9';
  writeFileSync(adapterFile, `${JSON.stringify(adapter, null, 2)}\n`);

  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /adapters[/\\]codex[/\\]adapter\.json/);
  assert.match(failed.stderr, /\^0\.0\.9/);
});

test('--check fails when package.json moves without the adapters and the lockfile', (t) => {
  const copy = copyRepo(t, 'version-lock');
  const pkgFile = join(copy, 'package.json');
  const bumped = JSON.parse(readFileSync(pkgFile, 'utf8'));
  bumped.version = '0.2.0';
  writeFileSync(pkgFile, `${JSON.stringify(bumped, null, 2)}\n`);

  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /requires\.engine is "\^0\.1\.0" but must equal "\^0\.2\.0" byte-for-byte/);
  assert.match(failed.stderr, /package-lock\.json version 0\.1\.0 does not match package\.json 0\.2\.0/);
});

test('--check fails when CHANGELOG has no section for the version', (t) => {
  const copy = copyRepo(t, 'changelog');
  const file = join(copy, 'CHANGELOG.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^## \[0\.1\.0\][^\n]*$/m, '## [0.0.9] - 2026-10-28'));

  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /CHANGELOG\.md has no "## \[0\.1\.0\]" section/);
});

test('--check fails when the lockfile version drifts', (t) => {
  const copy = copyRepo(t, 'lockfile');
  const file = join(copy, 'package-lock.json');
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  lock.version = '0.0.9';
  lock.packages[''].version = '0.0.9';
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);

  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /package-lock\.json version 0\.0\.9 does not match package\.json 0\.1\.0/);
});

test('--check fails when docs/compat.md drifts from the adapter declarations', (t) => {
  const copy = copyRepo(t, 'compat');
  const file = join(copy, 'docs', 'compat.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}| Agent | \`stale\` (Stale) | \`>=1 <2\` |\n`);

  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /docs[/\\]compat\.md does not match adapter\.json/);
});

test('--check keeps one bootstrap source and refuses a second install.mjs', (t) => {
  const copy = copyRepo(t, 'bootstrap');
  const missing = join(copy, 'scripts', 'install.mjs');
  const saved = readFileSync(missing);
  rmSync(missing);
  const gone = runRelease(['--check'], { cwd: copy });
  assert.equal(gone.status, 1, gone.stdout);
  assert.match(gone.stderr, /install\.mjs asset has no source/);
  writeFileSync(missing, saved);

  writeFileSync(join(copy, 'install.mjs'), saved);
  const second = runRelease(['--check'], { cwd: copy });
  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stderr, /only bootstrap source is scripts\/install\.mjs/);
});

test('--check validates a built asset directory: whitelist, sums coverage, bootstrap bytes', (t) => {
  const copy = copyRepo(t, 'assets');
  const out = join(copy, 'dist');
  const built = runRelease(['--out', out], { cwd: copy });
  assert.equal(built.status, 0, built.stderr);
  const clean = runRelease(['--check'], { cwd: copy });
  assert.equal(clean.status, 0, clean.stderr);

  writeFileSync(join(out, 'notes.txt'), 'x');
  const stray = runRelease(['--check'], { cwd: copy });
  assert.equal(stray.status, 1, stray.stdout);
  assert.match(stray.stderr, /does not hold the release asset whitelist.*notes\.txt/);
  rmSync(join(out, 'notes.txt'));

  writeFileSync(join(out, 'r2c-payload-0.0.9.tgz'), 'x');
  const stale = runRelease(['--check'], { cwd: copy });
  assert.equal(stale.status, 1, stale.stdout);
  assert.match(stale.stderr, /r2c-payload-0\.0\.9\.tgz/);
  rmSync(join(out, 'r2c-payload-0.0.9.tgz'));

  const sumsFile = join(out, SUMS_ASSET);
  const sums = readFileSync(sumsFile, 'utf8');
  const trimmed = sums.split('\n').filter(Boolean).slice(1).join('\n');
  writeFileSync(sumsFile, trimmed === '' ? '' : `${trimmed}\n`);
  const uncovered = runRelease(['--check'], { cwd: copy });
  assert.equal(uncovered.status, 1, uncovered.stdout);
  assert.match(uncovered.stderr, /SHA256SUMS\.txt does not cover the asset whitelist/);
  writeFileSync(sumsFile, sums);

  writeFileSync(
    join(out, INSTALL_ASSET),
    `${readFileSync(join(out, INSTALL_ASSET), 'utf8')}\n// hand edit\n`,
  );
  const edited = runRelease(['--check'], { cwd: copy });
  assert.equal(edited.status, 1, edited.stdout);
  assert.match(edited.stderr, /install\.mjs in .* is not byte-identical to scripts\/install\.mjs/);
});

test('--check fails when the payload archive manifest misses a file', (t) => {
  const copy = copyRepo(t, 'manifest');
  const out = join(copy, 'dist');
  const built = runRelease(['--out', out], { cwd: copy });
  assert.equal(built.status, 0, built.stderr);

  const archive = join(out, ASSET);
  const members = listArchive(archive);
  const manifestEntry = members.find((member) => member.path === 'r2c-payload.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  const dropped = Object.keys(manifest.files).sort()[0];
  delete manifest.files[dropped];
  writeFileSync(
    archive,
    createTarGz(
      members.map((member) =>
        member.path === 'r2c-payload.json'
          ? { path: member.path, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }
          : { path: member.path, data: member.data },
      ),
    ),
  );

  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /r2c-payload\.json does not cover/);
  assert.ok(failed.stderr.includes(dropped), `${dropped} must be named: ${failed.stderr}`);
});

test('a tampered archive installs nothing into the project', (t) => {
  const out = build(t);
  const archive = join(out, ASSET);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');

  const tamperedDir = tempDir(t, 'tampered');
  const tampered = join(tamperedDir, ASSET);
  writeFileSync(tampered, tamperArchive(archive, 'workflows/RTOSv3_R2C_pipiline.yaml'));
  const result = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--from', tampered, '--project-root', project, '--no-smoke', '--json'],
    { env: cleanEnv(home) },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.equal(envelope(result).error.code, 'PAYLOAD_HASH_MISMATCH');
  assert.deepEqual(readdirSync(project), []);
  assert.ok(!existsSync(join(home, '.r2c', 'cache', `payload-${VERSION}`)));

  const sidecarDir = tempDir(t, 'sidecar');
  const sidecar = join(sidecarDir, ASSET);
  cpSync(archive, sidecar);
  cpSync(join(out, 'SHA256SUMS.txt'), join(sidecarDir, 'SHA256SUMS.txt'));
  writeFileSync(sidecar, Buffer.concat([readFileSync(sidecar), Buffer.from('x')]));
  const mismatch = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--from', sidecar, '--project-root', project, '--no-smoke', '--json'],
    { env: cleanEnv(tempDir(t, 'home2')) },
  );
  assert.equal(mismatch.status, 2, mismatch.stderr);
  assert.equal(envelope(mismatch).error.code, 'PAYLOAD_CHECKSUM_MISMATCH');
  assert.deepEqual(readdirSync(project), []);
});

test('install --from <tgz> verifies the archive, caches it and installs the adapter', (t) => {
  const out = build(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  const result = cli(
    [
      'adapter',
      'install',
      '--agent',
      'claude-code',
      '--from',
      join(out, ASSET),
      '--project-root',
      project,
      '--no-smoke',
      '--json',
    ],
    { env: cleanEnv(home) },
  );
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.data.action, 'installed');
  assert.equal(json.data.changed, true);
  assert.ok(json.data.payload.source.startsWith('from:'), json.data.payload.source);

  assert.equal(readdirSync(join(project, '.claude', 'commands')).length, 7);
  assert.equal(readdirSync(join(project, '.claude', 'skills')).length, 35);
  assert.ok(existsSync(join(project, '.r2c', 'payload', VERSION, 'r2c-payload.json')));
  assert.ok(existsSync(join(home, '.r2c', 'cache', `payload-${VERSION}`, 'r2c-payload.json')));

  const receipt = JSON.parse(readFileSync(join(project, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  const manifestEntry = listArchive(join(out, ASSET)).find((entry) => entry.path === 'r2c-payload.json');
  assert.equal(receipt.payload.version, VERSION);
  assert.equal(receipt.payload.sha256, sha256(manifestEntry.data));
  assert.equal(receipt.engine.requires, `^${VERSION}`);
});

test('install --from <tgz> materialises the payload under the user-scope state dir', (t) => {
  const out = build(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  const result = cli(
    [
      'adapter',
      'install',
      '--agent',
      'claude-code',
      '--from',
      join(out, ASSET),
      '--scope',
      'user',
      '--project-root',
      project,
      '--no-smoke',
      '--json',
    ],
    { env: cleanEnv(home) },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope(result).data.scope, 'user');
  assert.ok(existsSync(join(home, '.r2c', 'payload', VERSION, 'r2c-payload.json')));
  assert.ok(existsSync(join(home, '.claude', 'settings.json')));
  assert.deepEqual(
    readdirSync(project).sort(),
    ['skills', 'tasks', 'workflows'],
    'user scope writes only the shared layout into the project root',
  );
  const receipt = JSON.parse(readFileSync(join(home, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  assert.equal(receipt.project_root, project, 'the user-scope receipt records the project it wrote into');
});

test('createTarGz rejects invalid entries with a coded runner error', () => {
  assert.throws(
    () => createTarGz([
      { path: 'a.txt', data: '' },
      { path: 'a.txt', data: '' },
    ]),
    (error) => {
      assert.ok(isR2cError(error), 'must be an R2cError');
      assert.equal(error.code, 'PAYLOAD_INVALID');
      assert.equal(error.exitCode, 1);
      assert.deepEqual(error.details.problems, ['duplicate payload path: a.txt']);
      assert.match(error.message, /^invalid payload entries:\n- duplicate payload path: a\.txt$/);
      return true;
    },
  );
});

test('the engine archive ships the CLI, sources, schema, manifest, yaml and LICENSE only', (t) => {
  const out = build(t);
  const archive = join(out, ENGINE_ASSET);
  const entries = listArchive(archive);
  const paths = entries.map((entry) => entry.path);

  assert.ok(entries.every((entry) => entry.type === '0'), 'only regular files');
  assert.deepEqual(paths, [...expectedEngine()].sort());
  for (const path of paths) {
    assert.ok(Buffer.byteLength(path) <= 100, `path is longer than 100 bytes: ${path}`);
    assert.ok(!path.startsWith('/') && !path.includes('\\'), path);
  }
  for (const required of [
    'bin/r2c.js',
    'src/cli.js',
    'schema/payload.schema.json',
    'package.json',
    'LICENSE',
    'node_modules/yaml/package.json',
    'node_modules/yaml/dist/index.js',
  ]) {
    assert.ok(paths.includes(required), `engine ships ${required}`);
  }
  for (const forbidden of [/^r2c-payload\.json$/, /^test\//, /^docs\//, /^scripts\//, /^pack\//, /^adapters\//, /^package-lock\.json$/, /^node_modules\/\.bin\//]) {
    assert.ok(!paths.some((path) => forbidden.test(path)), `unexpected engine path ${forbidden}`);
  }
  const manifest = JSON.parse(entries.find((entry) => entry.path === 'package.json').data.toString('utf8'));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.type, 'module');
});

test('the extracted engine runs offline with the vendored yaml and no repository', (t) => {
  const out = build(t);
  const engine = tempDir(t, 'engine');
  extractArchive(join(out, ENGINE_ASSET), engine);
  const entry = join(engine, 'bin', 'r2c.js');
  const home = tempDir(t, 'home');
  const env = cleanEnv(home);
  delete env.NODE_PATH;
  env.NODE_OPTIONS = '';

  const version = spawnSync(process.execPath, [entry, '--version'], { cwd: home, env, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), VERSION);

  const yaml = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('yaml').then((m) => process.stdout.write(typeof m.parse));"],
    { cwd: engine, env, encoding: 'utf8' },
  );
  assert.equal(yaml.status, 0, yaml.stderr);
  assert.equal(yaml.stdout, 'function', 'yaml resolves from the vendored copy');

  const planUrl = pathToFileURL(join(engine, 'src', 'adapter', 'plan.js')).href;
  const chain = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import(${JSON.stringify(planUrl)}).then((m) => process.stdout.write(typeof m.buildPlan));`],
    { cwd: home, env, encoding: 'utf8' },
  );
  assert.equal(chain.status, 0, chain.stderr);
  assert.equal(chain.stdout, 'function', 'the installer module loads yaml from the vendored copy');
});

test('the bootstrap downloads, verifies, extracts and installs with no npm and no network', (t) => {
  const out = build(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = cleanEnv(home);
  delete env.R2C_RELEASE_BASE;
  // npm, npx, gh and git are shadowed by sentinels that record and refuse:
  // reaching for any of them fails the run and names the tool. Asserting they
  // are absent would only describe the machine, not the chain.
  const shims = toolSentinels(t);
  withPath(env, shims.dir);

  const result = bootstrap(
    ['--agent', 'claude-code', '--version', VERSION, '--project', project, '--release-base', out],
    { env, cwd: tempDir(t, 'cwd') },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const engineHome = join(project, '.r2c', 'engine', VERSION);
  assert.ok(existsSync(join(engineHome, 'bin', 'r2c.js')));
  assert.ok(existsSync(join(engineHome, 'node_modules', 'yaml', 'package.json')));
  assert.ok(existsSync(join(project, '.r2c', 'payload', VERSION, 'r2c-payload.json')));
  assert.ok(existsSync(join(project, 'workflows', 'RTOSv3_R2C_pipiline.yaml')), 'layout landed in the project root');
  assert.ok(existsSync(join(project, 'skills')), 'skills landed in the project root');
  assert.ok(existsSync(join(project, '.claude', 'settings.json')), 'agent config written');

  const receipt = JSON.parse(readFileSync(join(project, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  assert.equal(receipt.payload.version, VERSION);
  assert.equal(receipt.payload.source, `release:v${VERSION}`, 'payload came from the local release dir');
  assert.equal(receipt.engine.version, VERSION);
  assert.equal(receipt.engine.home, engineHome);
  assert.equal(receipt.engine.entry, join(engineHome, 'bin', 'r2c.js'));
  assert.match(result.stdout, /next: node "/);

  const rerun = bootstrap(
    ['--agent', 'claude-code', '--version', VERSION, '--project', project, '--release-base', out],
    { env, cwd: tempDir(t, 'cwd2') },
  );
  assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
  assert.match(rerun.stdout, new RegExp(`engine ${VERSION.replaceAll('.', '\\.')} already at`));
  assert.equal(
    shims.invoked(),
    false,
    `the chain reached for a sentinel tool:\n${shims.invoked() ? readFileSync(shims.marker, 'utf8') : ''}`,
  );
});

test('--scope user puts the engine under the user home and a dsh user-scope install works', (t) => {
  const out = build(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  const dshHome = tempDir(t, 'dsh-home');
  const env = cleanEnv(home);
  delete env.R2C_RELEASE_BASE;
  env.DSH_HOME = dshHome;

  const result = bootstrap(
    ['--agent', 'dsh', '--version', VERSION, '--scope', 'user', '--project', project, '--release-base', out],
    { env, cwd: tempDir(t, 'cwd') },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  assert.ok(existsSync(join(home, '.r2c', 'engine', VERSION, 'bin', 'r2c.js')));
  assert.ok(!existsSync(join(project, '.r2c', 'engine')), 'user scope keeps the engine out of the project');
  assert.ok(existsSync(join(home, '.r2c', 'payload', VERSION, 'r2c-payload.json')));
  assert.ok(existsSync(join(home, '.r2c', 'install', 'dsh.json')));
  const profile = JSON.parse(readFileSync(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.ok(profile.dsh.profile.bundles.includes('r2c-adapter-dsh'));
  const receipt = JSON.parse(readFileSync(join(home, '.r2c', 'install', 'dsh.json'), 'utf8'));
  assert.equal(receipt.scope, 'user');
  assert.equal(receipt.engine.home, join(home, '.r2c', 'engine', VERSION));
});

test('a truncated or tampered engine archive fails verification and writes nothing', (t) => {
  const rerunWith = (label, mutate) => {
    const out = releaseWith(t, (dir) => {
      const file = join(dir, ENGINE_ASSET);
      writeFileSync(file, mutate(readFileSync(file)));
    });
    const project = tempDir(t, `${label}-project`);
    const home = tempDir(t, `${label}-home`);
    mkdirSync(join(home, '.claude'), { recursive: true });
    const result = bootstrap(
      ['--agent', 'claude-code', '--version', VERSION, '--project', project, '--release-base', out],
      { env: cleanEnv(home), cwd: tempDir(t, `${label}-cwd`) },
    );
    assert.notEqual(result.status, 0, `${label}: ${result.stdout}`);
    assert.match(result.stderr, /sha256 mismatch|SHA256SUMS\.txt/i);
    assert.deepEqual(readdirSync(project), [], `${label}: nothing written into the project`);
    assert.ok(!existsSync(join(home, '.r2c')), `${label}: no state dir`);
    assert.ok(!existsSync(join(home, '.claude', 'settings.json')), `${label}: no agent config`);
  };

  rerunWith('truncated', (buffer) => buffer.subarray(0, 1024));
  rerunWith('tampered', (buffer) => {
    const copy = Buffer.from(buffer);
    copy[copy.length - 64] = (copy[copy.length - 64] + 1) % 256;
    return copy;
  });
});

test('an unknown version names the missing asset, the version and the authentication methods', (t) => {
  const out = build(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const result = bootstrap(
    ['--agent', 'claude-code', '--version', '9.9.9', '--project', project, '--release-base', out],
    { env: cleanEnv(home), cwd: tempDir(t, 'cwd') },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /r2c-engine-9\.9\.9\.tgz/);
  assert.match(result.stderr, /9\.9\.9/);
  assert.match(result.stderr, /GH_TOKEN/);
  assert.match(result.stderr, /GITHUB_TOKEN/);
  assert.match(result.stderr, /git credential fill/);
  assert.deepEqual(readdirSync(project), []);
  assert.ok(!existsSync(join(home, '.r2c')));
});

test('the bootstrap rejects bad arguments before touching anything', (t) => {
  const project = tempDir(t, 'project');
  const missingAgent = bootstrap(['--version', VERSION, '--project', project], {});
  assert.equal(missingAgent.status, 2, missingAgent.stdout);
  assert.match(missingAgent.stderr, /--agent/);

  const badScope = bootstrap(['--agent', 'claude-code', '--scope', 'global', '--project', project], {});
  assert.equal(badScope.status, 2, badScope.stdout);
  assert.match(badScope.stderr, /--scope/);

  const badVersion = bootstrap(['--agent', 'claude-code', '--version', 'latest-ish', '--project', project], {});
  assert.equal(badVersion.status, 2, badVersion.stdout);
  assert.match(badVersion.stderr, /--version/);

  const noVersionLocal = bootstrap(
    ['--agent', 'claude-code', '--project', project, '--release-base', tempDir(t, 'empty')],
    {},
  );
  assert.equal(noVersionLocal.status, 2, noVersionLocal.stdout);
  assert.match(noVersionLocal.stderr, /--version/);
  assert.deepEqual(readdirSync(project), []);
});

test('R2C_RELEASE_BASE=<dir> lets the payload downloader work offline from a local dist', (t) => {
  const out = build(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  const env = cleanEnv(home);
  env.R2C_RELEASE_BASE = out;

  const result = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--project-root', project, '--no-smoke', '--json'],
    { env },
  );
  assert.equal(result.status, 0, result.stderr);
  const json = envelope(result);
  assert.equal(json.data.payload.source, `release:v${VERSION}`);
  assert.ok(existsSync(join(project, '.r2c', 'payload', VERSION, 'r2c-payload.json')));

  const empty = tempDir(t, 'empty');
  const missing = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--project-root', tempDir(t, 'project2'), '--no-smoke', '--json'],
    { env: { ...cleanEnv(tempDir(t, 'home2')), R2C_RELEASE_BASE: empty } },
  );
  assert.equal(missing.status, 2, missing.stdout);
  const error = envelope(missing).error;
  assert.equal(error.code, 'PAYLOAD_UNAVAILABLE');
  assert.match(error.message, new RegExp(`r2c-payload-${VERSION.replaceAll('.', '\\.')}\\.tgz`));
  assert.match(error.message, new RegExp(VERSION.replaceAll('.', '\\.')));
});

test('adapter install records where the engine lives, from --engine, the env, or the running checkout', (t) => {
  const out = build(t);
  const project = tempDir(t, 'project');
  const home = tempDir(t, 'home');
  const explicitHome = tempDir(t, 'engine-home');

  const explicit = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--from', join(out, ASSET), '--project-root', project, '--engine', explicitHome, '--no-smoke', '--json'],
    { env: cleanEnv(home) },
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  const receipt = JSON.parse(readFileSync(join(project, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  assert.deepEqual(receipt.engine, {
    version: VERSION,
    requires: `^${VERSION}`,
    home: explicitHome,
    entry: join(explicitHome, 'bin', 'r2c.js'),
  });

  const fromEnv = tempDir(t, 'engine-env');
  const envProject = tempDir(t, 'project-env');
  const envResult = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--from', join(out, ASSET), '--project-root', envProject, '--no-smoke', '--json'],
    { env: { ...cleanEnv(tempDir(t, 'home-env')), R2C_ENGINE_HOME: fromEnv } },
  );
  assert.equal(envResult.status, 0, envResult.stderr);
  const envReceipt = JSON.parse(readFileSync(join(envProject, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  assert.equal(envReceipt.engine.home, fromEnv);

  const checkoutProject = tempDir(t, 'project-checkout');
  const checkout = cli(
    ['adapter', 'install', '--agent', 'claude-code', '--from', join(out, ASSET), '--project-root', checkoutProject, '--no-smoke', '--json'],
    { env: cleanEnv(tempDir(t, 'home-checkout')) },
  );
  assert.equal(checkout.status, 0, checkout.stderr);
  const checkoutReceipt = JSON.parse(readFileSync(join(checkoutProject, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  assert.equal(checkoutReceipt.engine.home, REPO);
  assert.equal(checkoutReceipt.engine.entry, BIN);
});
