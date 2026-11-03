/**
 * Module-level checks for the browser half of the read-only surface
 * (ticket #108): no Node builtins under `web/`, no inline assets, and the
 * browser primitives drive the same shared validator as the CLI.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { validateBundle, validateBundleAsync } from '../assembler/index.js';
import { inflateRaw as nodeInflateRaw } from '../core/node/inflate.js';
import { sha256Hex as nodeSha256Hex } from '../core/node/sha256.js';
import { minimalZip } from './helpers/minimal-bundle.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');

function webFiles(directory = WEB) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...webFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function relative(path) {
  return path.slice(ROOT.length + 1).split('\\').join('/');
}

test('web/ has no Node builtins or third-party imports (server modules are the only Node entries)', () => {
  // These run in the server process only; every other file in web/ is loaded
  // by the browser and must stay free of node: builtins.
  const serverModules = new Set(['web/serve.mjs', 'web/http.js', 'web/build.js', 'web/publish.js', 'web/child.js']);
  const nodeImport = /(?:from\s*|import\s*\(\s*)['"]node:/;
  const anyImport = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const file of webFiles()) {
    if (extname(file) !== '.js' && extname(file) !== '.mjs') continue;
    const name = relative(file);
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\brequire\s*\(/, `${name} must not use require()`);
    if (name === 'web/serve.mjs') {
      assert.match(source, nodeImport, 'serve.mjs should use node: builtins');
      continue;
    }
    // The other server modules receive node primitives from serve.mjs and are
    // never loaded by the browser; they still must not import third parties.
    if (serverModules.has(name)) continue;
    assert.doesNotMatch(source, nodeImport, `${name} must not import node: builtins`);
    for (const match of source.matchAll(anyImport)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith('.') || specifier.startsWith('/'), `${name} imports non-relative ${specifier}`);
    }
  }
});

test('index.html has no inline scripts, styles or style attributes', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.match(html, /<script\s+src="\/web\/boot-check\.js"><\/script>/);
  assert.match(html, /<script\s+type="module"\s+src="\/web\/app\.js"><\/script>/);
  assert.match(html, /<noscript>/);
  assert.match(html, /hm2b-assembler\.js bundle validate/);
});

test('primitives-browser.js implements SHA-256, raw inflate and the floor probe with Web APIs', async () => {
  const primitives = await import(pathToFileURL(join(WEB, 'primitives-browser.js')).href);
  assert.equal(
    await primitives.sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const deflated = new Uint8Array(deflateRawSync(Buffer.from('browser inflate parity', 'utf8')));
  const inflated = await primitives.inflateRaw(deflated);
  assert.equal(Buffer.from(inflated).toString('utf8'), 'browser inflate parity');

  await assert.rejects(
    primitives.inflateRaw(deflated, { maxOutputLength: 4 }),
    (error) => error.code === 'ERR_BUFFER_TOO_LARGE',
  );

  const floor = primitives.probeBrowserFloor();
  assert.equal(floor.cryptoSubtle, true);
  assert.equal(floor.deflateRaw, true);
  assert.deepEqual(primitives.missingRequirements(floor), []);

  const degraded = primitives.probeBrowserFloor({
    crypto: globalThis.crypto,
    TextDecoder: globalThis.TextDecoder,
    fetch: globalThis.fetch,
    Blob: globalThis.Blob,
    DecompressionStream: undefined,
  });
  assert.equal(degraded.deflateRaw, false);
  assert.deepEqual(primitives.missingRequirements(degraded), []);

  const broken = primitives.probeBrowserFloor({
    TextDecoder: globalThis.TextDecoder,
    fetch: globalThis.fetch,
    Blob: globalThis.Blob,
    DecompressionStream: globalThis.DecompressionStream,
    crypto: {},
  });
  assert.ok(primitives.missingRequirements(broken).includes('crypto.subtle'));
});

test('app.js is import-safe in Node and uses the shared validator', async () => {
  const app = await import(pathToFileURL(join(WEB, 'app.js')).href);
  assert.equal(typeof app.bootstrap, 'function');
  assert.equal(typeof app.upload, 'function');
  assert.equal(app.state.mismatch, false);
  assert.equal(app.state.irBytes, null);
});

test('browser primitives produce a byte-identical report to Node primitives (store and deflate)', async () => {
  const primitives = await import(pathToFileURL(join(WEB, 'primitives-browser.js')).href);
  const cases = [
    minimalZip(),
    minimalZip({ method: 'deflate' }),
    minimalZip({ method: 'deflate', dataDescriptor: true }),
  ];
  for (const bytes of cases) {
    const nodeReport = validateBundle(
      new Uint8Array(bytes),
      { inflateRaw: nodeInflateRaw, sha256: nodeSha256Hex },
      { path: 'bundle.zip' },
    );
    const browserReport = await validateBundleAsync(
      new Uint8Array(bytes),
      { inflateRaw: primitives.inflateRaw, sha256: primitives.sha256Hex },
      { path: 'bundle.zip' },
    );
    assert.deepEqual(browserReport, nodeReport);
    assert.equal(browserReport.ok, true);
  }
});
