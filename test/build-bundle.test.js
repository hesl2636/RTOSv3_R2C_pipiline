import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'build-bundle.mjs');
const EXAMPLE = join(REPO, 'examples', 'rtosv3');
const BUNDLE = join(EXAMPLE, 'bundle');
const COMMITTED_ZIP = join(EXAMPLE, 'dist', 'bundle-rtosv3-drvport-v1.0.0.zip');
const FILES_SUMS = join(EXAMPLE, 'FILES.sha256');
const EXPECTED_SHA256 = 'c22064539aa189b4d9345b1d39b148967a450584badd2593dcf47c0c5b75a13e';
const EXPECTED_BYTES = 55042;
const EXPECTED_FILES = 49;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-build-bundle-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runBuild(args, { cwd = REPO } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every regular file below `dir`, as sorted POSIX relative paths. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = join(dir, entry.name).slice(base.length + 1).split('\\').join('/');
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(rel);
  }
  return out.sort();
}

/** Minimal central-directory reader, independent of the production writer. */
function readCentralDirectory(bytes) {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'zip has no end-of-central-directory record');
  const count = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  const entries = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), CEN, `bad central header at entry ${index}`);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    entries.push({
      versionMadeBy: bytes.readUInt16LE(offset + 4),
      versionNeeded: bytes.readUInt16LE(offset + 6),
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      time: bytes.readUInt16LE(offset + 12),
      date: bytes.readUInt16LE(offset + 14),
      compressedSize: bytes.readUInt32LE(offset + 20),
      size: bytes.readUInt32LE(offset + 24),
      nameLength,
      extraLength,
      commentLength: entryCommentLength,
      diskStart: bytes.readUInt16LE(offset + 34),
      internalAttributes: bytes.readUInt16LE(offset + 36),
      externalAttributes: bytes.readUInt32LE(offset + 38),
      localOffset: bytes.readUInt32LE(offset + 42),
      name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
    });
    offset += 46 + nameLength + extraLength + entryCommentLength;
  }
  return { entries, count, cdSize, cdOffset, commentLength, eocd };
}

test('build-bundle rebuilds the committed zip byte for byte and is deterministic', (t) => {
  const out = tempDir(t, 'build');
  const first = join(out, 'first.zip');
  const second = join(out, 'second.zip');
  for (const target of [first, second]) {
    const result = runBuild([BUNDLE, '--out', target]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  const a = readFileSync(first);
  const b = readFileSync(second);
  assert.ok(a.equals(b), 'two builds produced different bytes');
  assert.ok(a.equals(readFileSync(COMMITTED_ZIP)), 'built bytes differ from the committed zip');
  assert.equal(a.length, EXPECTED_BYTES);
  assert.equal(sha256(a), EXPECTED_SHA256);
});

test('--check accepts the committed zip', () => {
  const result = runBuild([BUNDLE, '--check']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('--check exits 2 for a tampered zip', (t) => {
  const dir = tempDir(t, 'tampered');
  const tampered = join(dir, 'bundle.zip');
  cpSync(COMMITTED_ZIP, tampered);
  const bytes = readFileSync(tampered);
  bytes[0] ^= 0xff;
  writeFileSync(tampered, bytes);
  const result = runBuild([BUNDLE, '--check', '--out', tampered]);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
});

test('FILES.sha256 covers all 49 bundle files in path order', () => {
  const text = readFileSync(FILES_SUMS, 'utf8');
  assert.ok(text.endsWith('\n'));
  const lines = text.slice(0, -1).split('\n');
  assert.equal(lines.length, EXPECTED_FILES);
  const paths = lines.map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.ok(match, `malformed checksum line: ${JSON.stringify(line)}`);
    return match[2];
  });
  assert.deepEqual(paths, walk(BUNDLE));
  for (const line of lines) {
    const [, expected, path] = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.equal(sha256(readFileSync(join(BUNDLE, path))), expected, path);
  }
});

test('zip uses 49 stored entries with the fixed DOS timestamp and no directory entries', () => {
  const bytes = readFileSync(COMMITTED_ZIP);
  const { entries, count, cdSize, cdOffset, commentLength, eocd } = readCentralDirectory(bytes);
  assert.equal(count, EXPECTED_FILES);
  assert.equal(entries.length, EXPECTED_FILES);
  assert.equal(commentLength, 0);
  assert.equal(cdOffset + cdSize, eocd);
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(!names.includes('README.md'));
  for (const entry of entries) {
    assert.equal(entry.versionMadeBy, 20, entry.name);
    assert.equal(entry.versionNeeded, 20, entry.name);
    assert.equal(entry.flags, 0, entry.name);
    assert.equal(entry.method, 0, entry.name);
    assert.equal(entry.time, 0, entry.name);
    assert.equal(entry.date, 0x21, entry.name);
    assert.equal(entry.extraLength, 0, entry.name);
    assert.equal(entry.commentLength, 0, entry.name);
    assert.equal(entry.diskStart, 0, entry.name);
    assert.equal(entry.internalAttributes, 0, entry.name);
    assert.equal(entry.externalAttributes, 0, entry.name);
    assert.equal(entry.compressedSize, entry.size, entry.name);
    assert.ok(!entry.name.endsWith('/'), entry.name);
    const local = entry.localOffset;
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, entry.name);
    assert.equal(bytes.readUInt16LE(local + 4), 20, entry.name);
    assert.equal(bytes.readUInt16LE(local + 6), 0, entry.name);
    assert.equal(bytes.readUInt16LE(local + 8), 0, entry.name);
    assert.equal(bytes.readUInt16LE(local + 10), 0, entry.name);
    assert.equal(bytes.readUInt16LE(local + 12), 0x21, entry.name);
    assert.equal(bytes.readUInt16LE(local + 26), entry.nameLength, entry.name);
    assert.equal(bytes.readUInt16LE(local + 28), 0, entry.name);
  }
});

test('build fails on a bundle path that cannot be represented in a zip', (t) => {
  const dir = tempDir(t, 'invalid');
  const bundle = join(dir, 'bundle');
  mkdirSync(join(bundle, 'skills'), { recursive: true });
  writeFileSync(join(bundle, 'bundle.json'), JSON.stringify({ id: 'demo', version: '1.0.0' }, null, 2) + '\n');
  writeFileSync(join(bundle, 'skills', 'bad name.md'), 'x\n');
  const target = join(dir, 'out.zip');
  const result = runBuild([bundle, '--out', target]);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(target), false);
});
