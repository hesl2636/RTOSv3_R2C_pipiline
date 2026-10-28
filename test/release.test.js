import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
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
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256, sha256File } from '../src/plugin.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const RELEASE = join(REPO, 'scripts', 'release.mjs');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const ASSET = `r2c-plugin-${VERSION}.tgz`;
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

/** Copy the checkout without VCS/build artefacts so the copy is self-contained. */
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
  const entry = listArchive(file).find((item) => item.path === 'r2c-plugin.json');
  assert.ok(entry, 'archive contains r2c-plugin.json');
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
  const paths = new Set(['LICENSE', 'shims/hook.mjs']);
  for (const dir of ['adapters', 'schema']) files(paths, dir, join(REPO, dir));
  for (const dir of ['commands', 'skills', 'tasks', 'workflows']) files(paths, dir, join(REPO, 'pack', dir));
  return paths;
}

function files(target, prefix, dir) {
  for (const rel of walkFiles(dir, prefix)) target.add(rel);
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
    readFileSync(join(first, 'SHA256SUMS.txt'), 'utf8'),
    readFileSync(join(second, 'SHA256SUMS.txt'), 'utf8'),
  );
  assert.equal(
    readFileSync(join(first, 'SHA256SUMS.txt'), 'utf8'),
    `${sha256File(archiveA)}  ${ASSET}\n`,
  );
  assert.deepEqual(manifestOf(archiveA).files, manifestOf(archiveB).files);
});

test('archive paths and metadata follow the payload contract exactly', (t) => {
  const out = build(t);
  const archive = join(out, ASSET);
  const entries = listArchive(archive);

  assert.ok(entries.every((entry) => entry.type === '0'), 'only regular files');
  const paths = entries.map((entry) => entry.path).sort();
  const expected = [...expectedPayload()].sort();
  assert.deepEqual(paths, ['r2c-plugin.json', ...expected].sort());

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
  assert.ok(!existsSync(join(home, '.r2c', 'cache', `plugin-${VERSION}`)));

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
  assert.ok(existsSync(join(project, '.r2c', 'plugin', VERSION, 'r2c-plugin.json')));
  assert.ok(existsSync(join(home, '.r2c', 'cache', `plugin-${VERSION}`, 'r2c-plugin.json')));

  const receipt = JSON.parse(readFileSync(join(project, '.r2c', 'install', 'claude-code.json'), 'utf8'));
  const manifestEntry = listArchive(join(out, ASSET)).find((entry) => entry.path === 'r2c-plugin.json');
  assert.equal(receipt.payload.version, VERSION);
  assert.equal(receipt.payload.sha256, sha256(manifestEntry.data));
  assert.equal(receipt.engine.requires, `^${VERSION}`);
});
