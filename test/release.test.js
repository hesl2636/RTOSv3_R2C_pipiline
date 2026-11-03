/**
 * Frozen legacy engine channel after P6 (decision #77 §3.6, ticket #111).
 *
 * This file covers **only** the frozen legacy `v<E>` channel: one Release with
 * the legacy asset name `r2c-engine-<E>.tgz`, the frozen bootstrap and their
 * sums. No `r2c-payload-<E>.tgz` is produced anymore. The archive keeps the P6
 * extracted layout shared with the new channel — a generated `bin/hm2b.js`
 * launcher, the engine under `runtime/runner/engine/`, the pure contract,
 * `core/`, the vendored `yaml`, two identical `package.json` copies and
 * LICENSE. Old installs keep consuming that archive from their frozen
 * `.r2c/engine` layout.
 *
 * The `bundle-<id>-v<version>` channel (asset name `hm2b-engine-<E>.tgz`) is
 * covered by `release-bundle.test.js`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256Hex } from '../core/node/sha256.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(REPO, 'scripts', 'release.mjs');
const BOOTSTRAP = join(REPO, 'scripts', 'install.mjs');
const ENGINE_VERSION = JSON.parse(readFileSync(join(REPO, 'runtime/runner/engine/package.json'), 'utf8')).version;
const FRAMEWORK_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const ENGINE_ASSET = `r2c-engine-${ENGINE_VERSION}.tgz`;
const INSTALL_ASSET = 'install.mjs';
const SUMS_ASSET = 'SHA256SUMS.txt';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `hm2b-release-${prefix}-`));
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
  for (const name of readdirSync(REPO)) {
    if (['.git', 'node_modules', 'dist', '.tmpbuild', '.r2c', '.hm2b'].includes(name)) continue;
    const from = join(REPO, name);
    spawnSync('node', ['-e', `
      const { cpSync } = require('node:fs');
      cpSync(process.argv[1], process.argv[2], { recursive: true });
    `, from, join(copy, name)]);
  }
  mkdirSync(join(copy, 'node_modules'), { recursive: true });
  spawnSync('node', ['-e', `
    const { cpSync } = require('node:fs');
    cpSync(process.argv[1], process.argv[2], { recursive: true });
  `, join(REPO, 'node_modules', 'yaml'), join(copy, 'node_modules', 'yaml')]);
  return copy;
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

test('two consecutive builds are byte-identical', (t) => {
  const first = build(t, 'first');
  const second = build(t, 'second');
  for (const name of [ENGINE_ASSET, INSTALL_ASSET, SUMS_ASSET]) {
    assert.equal(
      sha256Hex(readFileSync(join(first, name))),
      sha256Hex(readFileSync(join(second, name))),
      `${name} must be deterministic`,
    );
  }
  assert.equal(
    readFileSync(join(first, INSTALL_ASSET)).equals(readFileSync(BOOTSTRAP)),
    true,
    'install.mjs is the bootstrap, byte for byte',
  );
});

test('one build writes exactly the three legacy assets', (t) => {
  const out = build(t);
  assert.deepEqual(readdirSync(out).sort(), [SUMS_ASSET, INSTALL_ASSET, ENGINE_ASSET].sort());
  const lines = readFileSync(join(out, SUMS_ASSET), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map((line) => line.slice(64 + 2)), [INSTALL_ASSET, ENGINE_ASSET].sort());
  for (const line of lines) {
    const [, digest, name] = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.equal(digest, sha256Hex(readFileSync(join(out, name))), `${name} digest`);
  }
});

test('the legacy engine archive keeps the P6 extracted layout', (t) => {
  const out = build(t);
  const entries = listArchive(join(out, ENGINE_ASSET));
  assert.ok(entries.every((entry) => entry.type === '0'), 'only regular files');
  const paths = entries.map((entry) => entry.path).sort();
  for (const path of paths) {
    assert.ok(Buffer.byteLength(path) <= 100, `path over 100 bytes: ${path}`);
    assert.ok(!path.startsWith('/') && !path.includes('\\'), path);
    assert.ok(!/(^|\/)\.\.(\/|$)/.test(path), path);
  }
  for (const required of [
    'bin/hm2b.js',
    'package.json',
    'runtime/runner/engine/package.json',
    'runtime/runner/engine/bin/hm2b.js',
    'runtime/runner/engine/src/cli.js',
    'runtime/runner/contract/manifest.js',
    'runtime/runner/schema/workflow.schema.json',
    'core/canonical-json.js',
    'LICENSE',
  ]) {
    assert.ok(paths.includes(required), `engine archive is missing ${required}`);
  }
  assert.ok(paths.some((path) => path.startsWith('node_modules/yaml/')));
  for (const forbidden of [/^test\//, /^docs\//, /^scripts\//, /^examples\//, /^web\//, /^installer\//, /^src\//]) {
    assert.ok(!paths.some((path) => forbidden.test(path)), `unexpected engine path ${forbidden}`);
  }
  const rootPackage = entries.find((entry) => entry.path === 'package.json');
  const nestedPackage = entries.find((entry) => entry.path === 'runtime/runner/engine/package.json');
  assert.equal(rootPackage.data.equals(nestedPackage.data), true, 'both package.json copies are identical');
  assert.equal(JSON.parse(rootPackage.data.toString('utf8')).version, ENGINE_VERSION);
  const launcher = entries.find((entry) => entry.path === 'bin/hm2b.js').data.toString('utf8');
  assert.match(launcher, /runtime\/runner\/engine\/bin\/hm2b\.js/);
});

test('the extracted engine runs offline with the vendored yaml', (t) => {
  const out = build(t);
  const home = tempDir(t, 'engine-home');
  for (const entry of listArchive(join(out, ENGINE_ASSET))) {
    const target = join(home, ...entry.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  const run = spawnSync(process.execPath, [join(home, 'bin', 'hm2b.js'), '--version'], {
    cwd: home,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), ENGINE_VERSION);
});

test('build refuses over-long and symlinked engine paths', (t) => {
  const longCopy = copyRepo(t, 'long-path');
  writeFileSync(join(longCopy, 'core', `${'x'.repeat(96)}.js`), 'export {};\n');
  const tooLong = runRelease(['--out', tempDir(t, 'long-out')], { cwd: longCopy });
  assert.equal(tooLong.status, 1, tooLong.stdout);
  assert.match(tooLong.stderr, /engine archive path is \d+ bytes \(max 100\)/);

  const linkCopy = copyRepo(t, 'symlink');
  try {
    if (process.platform === 'win32') {
      symlinkSync(linkCopy, join(linkCopy, 'core', 'linked'), 'junction');
    } else {
      symlinkSync(join(linkCopy, 'README.md'), join(linkCopy, 'core', 'linked.js'));
    }
  } catch {
    t.skip('symlink creation is not permitted on this platform');
    return;
  }
  const linked = runRelease(['--out', tempDir(t, 'link-out')], { cwd: linkCopy });
  assert.equal(linked.status, 1, linked.stdout);
  assert.match(linked.stderr, /symlink not allowed in engine archive/);
});

test('--check passes on the repository and fails when the engine package drifts', (t) => {
  const pass = runRelease(['--check']);
  assert.equal(pass.status, 0, pass.stderr);

  const copy = copyRepo(t, 'engine-version');
  const file = join(copy, 'runtime/runner/engine/package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.engines.node = '>=24.0.0';
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /framework and engine must declare the same engines\.node range/);
});

test('--check fails when the root version moves without the lockfile', (t) => {
  const copy = copyRepo(t, 'version-lock');
  const pkgFile = join(copy, 'package.json');
  const bumped = JSON.parse(readFileSync(pkgFile, 'utf8'));
  bumped.version = '0.2.0';
  writeFileSync(pkgFile, `${JSON.stringify(bumped, null, 2)}\n`);
  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /package-lock\.json version 0\.1\.0 does not match package\.json 0\.2\.0/);
});

test('--check fails when CHANGELOG has no section for the version', (t) => {
  const copy = copyRepo(t, 'changelog');
  const file = join(copy, 'CHANGELOG.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(new RegExp(`^## \\[${FRAMEWORK_VERSION.replaceAll('.', '\\.')}\\]`, 'm'), '## [0.0.9]'));
  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, new RegExp(`CHANGELOG\\.md has no "## \\[${FRAMEWORK_VERSION.replaceAll('.', '\\.')}\\]" section`));
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

test('--check fails when docs/compat.md drifts from the projection manifests', (t) => {
  const copy = copyRepo(t, 'compat');
  const file = join(copy, 'docs', 'compat.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}| Projection | \`stale\` | \`9.9.9\` |\n`);
  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /docs[/\\]compat\.md does not match/);
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

test('--check validates a built asset directory: whitelist, sums, archive contract', (t) => {
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
});

test('--check fails when the built engine archive ships an extra member', (t) => {
  const copy = copyRepo(t, 'engine-tamper');
  const out = join(copy, 'dist');
  assert.equal(runRelease(['--out', out], { cwd: copy }).status, 0);

  const file = join(out, ENGINE_ASSET);
  const tar = gunzipSync(readFileSync(file));
  const extra = Buffer.alloc(512);
  const name = 'extra.txt';
  extra.write(name, 0, name.length, 'utf8');
  extra.write('0000644\0', 100, 8, 'ascii');
  extra.write('0000000\0', 108, 8, 'ascii');
  extra.write('0000000\0', 116, 8, 'ascii');
  extra.write('00000000001\0', 124, 12, 'ascii');
  extra.write('00000000000\0', 136, 12, 'ascii');
  extra.write('        ', 148, 8, 'ascii');
  extra[156] = 0x30;
  extra.write('ustar\0', 257, 6, 'ascii');
  extra.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of extra) checksum += byte;
  extra.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const data = Buffer.from('x\n');
  const rebuilt = Buffer.concat([tar.subarray(0, tar.length - 1024), extra, data, Buffer.alloc(512 - data.length + 1024)]);
  writeFileSync(file, gzipSync(rebuilt, { level: 9 }));

  const failed = runRelease(['--check'], { cwd: copy });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /ships paths outside its contract/);
});
