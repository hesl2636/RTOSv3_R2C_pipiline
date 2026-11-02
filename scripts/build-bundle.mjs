#!/usr/bin/env node
/**
 * Build the committed sample bundle zip (#87, spec §17).
 *
 * `node scripts/build-bundle.mjs examples/rtosv3/bundle [--out <zip>]`
 * packages every regular file under the bundle directory (top-level README.md
 * excluded) in POSIX path byte order, store(0), with frozen 1980-01-01 DOS
 * timestamps and zero extra fields/attributes. Repeated builds are byte
 * identical.
 *
 * `--check` rebuilds in memory and byte-compares the result with the committed
 * zip: exit 0 on a match, exit 2 when the artifact is missing or stale.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { collectBundleFiles } from './lib/file-set.mjs';
import { writeZip } from './lib/zip-writer.mjs';

function usage(message) {
  if (message !== undefined) process.stderr.write(`build-bundle: ${message}\n`);
  process.stderr.write(
    'usage: node scripts/build-bundle.mjs <bundle-dir> [--out <zip>] [--check]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { bundle: null, out: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--out requires a zip path');
      options.out = resolve(process.cwd(), value);
      index += 1;
    } else if (arg.startsWith('-')) {
      usage(`unknown option ${arg}`);
    } else if (options.bundle === null) {
      options.bundle = resolve(process.cwd(), arg);
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }
  if (options.bundle === null) usage('a bundle directory is required');
  return options;
}

function readManifest(bundleDir) {
  const path = join(bundleDir, 'bundle.json');
  if (!existsSync(path)) throw new Error('bundle.json is missing');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`bundle.json is not valid JSON: ${error.message}`);
  }
  if (typeof manifest.id !== 'string' || manifest.id === '') throw new Error('bundle.json id is missing');
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('bundle.json version is missing');
  }
  return manifest;
}

function defaultOutput(bundleDir, manifest) {
  return join(dirname(bundleDir), 'dist', `bundle-${manifest.id}-v${manifest.version}.zip`);
}

function describe(path) {
  const display = relative(process.cwd(), path);
  return display === '' ? '.' : display.split('\\').join('/');
}

function buildZip(bundleDir) {
  const files = collectBundleFiles(bundleDir);
  if (!files.some((file) => file.path === 'bundle.json')) throw new Error('bundle.json is missing');
  const manifest = readManifest(bundleDir);
  const bytes = writeZip(files, { method: 'store' });
  return { files, manifest, bytes };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { files, manifest, bytes } = buildZip(options.bundle);
  const target = options.out ?? defaultOutput(options.bundle, manifest);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const summary = `${files.length} files, ${bytes.length} bytes, sha256 ${digest}`;

  if (options.check) {
    if (!existsSync(target)) {
      process.stderr.write(`build-bundle: check failed: ${describe(target)} does not exist\n`);
      process.exit(2);
    }
    const committed = readFileSync(target);
    if (!committed.equals(bytes)) {
      const committedDigest = createHash('sha256').update(committed).digest('hex');
      process.stderr.write(
        `build-bundle: check failed: ${describe(target)} `
          + `(committed ${committed.length} bytes, sha256 ${committedDigest}; rebuilt ${summary})\n`,
      );
      process.exit(2);
    }
    process.stdout.write(`build-bundle: check ok ${describe(target)} (${summary})\n`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  process.stdout.write(`build-bundle: wrote ${describe(target)} (${summary})\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`build-bundle: ${error.message}\n`);
  process.exit(2);
}
