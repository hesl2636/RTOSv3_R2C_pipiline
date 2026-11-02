/**
 * HTTP-level acceptance for the read-only web surface (ticket #108).
 *
 * The server is spawned as a real process; every request goes over loopback.
 * No browser automation is used: the browser half is covered by
 * `web-modules.test.js` importing the same modules in Node.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SAMPLE = join(ROOT, 'examples', 'rtosv3', 'dist', 'bundle-rtosv3-drvport-v1.0.0.zip');
const SAMPLE_SHA256 = 'c22064539aa189b4d9345b1d39b148967a450584badd2593dcf47c0c5b75a13e';
const IR_DIGEST = '8a2a57593939f91117d57f9ca34c56b2fc631f6837168ef74032daa95202d395';

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function startServer(t, env = {}) {
  const child = spawn(process.execPath, ['web/serve.mjs'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    let stdout = '';
    const timer = setTimeout(() => rejectUrl(new Error(`server did not start: ${stdout}${stderr}`)), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`server exited ${code}: ${stderr}`));
    });
  });
  const server = {
    child,
    url,
    base: url.replace(/\/$/, ''),
    port: Number(new URL(url).port),
    stderr: () => stderr,
  };
  t.after(async () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') {
      child.stdin.write('shutdown\n');
    } else {
      child.kill('SIGTERM');
    }
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(8000).then(() => child.kill('SIGKILL')),
    ]);
  });
  return server;
}

function httpRequest({ port, method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          json = null;
        }
        resolveRequest({ status: response.statusCode, headers: response.headers, raw, json });
      });
    });
    request.on('error', rejectRequest);
    if (body !== null) request.write(body);
    request.end();
  });
}

function rawRequest(port, text) {
  return new Promise((resolveRaw, rejectRaw) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolveRaw(data));
    socket.on('error', rejectRaw);
    socket.write(text);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveRaw(data);
    }, 5000);
    timer.unref();
  });
}

function statusOf(raw) {
  return Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0);
}

async function session(server) {
  const response = await httpRequest({ port: server.port, path: '/api/session' });
  assert.equal(response.status, 200);
  return response.json.data;
}

function postHeaders(server, csrf, extra = {}) {
  return {
    Origin: server.base,
    'Sec-Fetch-Site': 'same-origin',
    'X-R2C-CSRF': csrf,
    ...extra,
  };
}

function cliJson(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, `CLI produced no stdout: ${result.stderr}`);
  return JSON.parse(lines[lines.length - 1]);
}

test('upload returns the CLI report field-by-field and the frozen IR', async (t) => {
  const server = await startServer(t);
  const { csrf } = await session(server);
  const zip = readFileSync(SAMPLE);

  const response = await httpRequest({
    port: server.port,
    method: 'POST',
    path: '/api/validate',
    headers: postHeaders(server, csrf, {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
    }),
    body: zip,
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  const report = response.json.data.report;

  const work = mkdtempSync(join(tmpdir(), 'r2c-web-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const zipPath = join(work, 'bundle.zip');
  copyFileSync(SAMPLE, zipPath);

  const cliReport = cliJson(['bin/r2c-assembler.js', 'bundle', 'validate', zipPath, '--json']).data;
  assert.deepEqual(report, cliReport);
  assert.equal(report.artifact.sha256, SAMPLE_SHA256);
  assert.equal(report.counts.stages, 4);
  assert.equal(report.counts.skills, 35);
  assert.equal(report.counts.errors, 0);
  assert.equal(report.counts.warnings, 2);

  const outDir = join(work, 'out');
  mkdirSync(outDir);
  const cliCompile = cliJson(['bin/r2c-assembler.js', 'compile', zipPath, '--out', outDir, '--json']).data;
  assert.equal(response.json.data.ir.digest, cliCompile.ir.sha256);
  assert.equal(response.json.data.ir.digest, IR_DIGEST);
  assert.equal(response.json.data.ir.bytes, 58827);
  assert.ok(readFileSync(join(outDir, 'workflow.ir.json')).equals(Buffer.from(response.json.data.ir.data, 'base64')));
});

test('transport limits: 411 without Content-Length, 413 above the upload cap', async (t) => {
  const server = await startServer(t);
  const { csrf } = await session(server);

  const missing = await rawRequest(server.port, [
    'POST /api/validate HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    `Origin: ${server.base}`,
    'Sec-Fetch-Site: same-origin',
    `X-R2C-CSRF: ${csrf}`,
    'Content-Type: application/zip',
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
  assert.equal(statusOf(missing), 411);
  assert.match(missing, /WEB_BODY_MISSING/);

  const oversized = await rawRequest(server.port, [
    'POST /api/validate HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    `Origin: ${server.base}`,
    'Sec-Fetch-Site: same-origin',
    `X-R2C-CSRF: ${csrf}`,
    'Content-Type: application/zip',
    `Content-Length: ${8 * 1024 * 1024 + 8 * 1024}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
  assert.equal(statusOf(oversized), 413);
  assert.match(oversized, /WEB_BODY_TOO_LARGE/);

  const bigHeader = await rawRequest(server.port, [
    'GET /api/session HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    `X-Pad: ${'a'.repeat(20 * 1024)}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n'));
  assert.equal(statusOf(bigHeader), 413);
  assert.match(bigHeader, /WEB_HEADER_TOO_LARGE/);
  assert.match(bigHeader, /Content-Security-Policy: default-src 'none'/);
  assert.match(bigHeader, /Content-Type: application\/json/);
});

test('request security envelope rejects bad Host, Origin, fetch site, CSRF and OPTIONS', async (t) => {
  const server = await startServer(t);
  const { csrf } = await session(server);
  const zip = readFileSync(SAMPLE);
  const body = {
    'Content-Type': 'application/zip',
    'Content-Length': String(zip.length),
    ...postHeaders(server, csrf),
  };

  const badHost = await new Promise((resolveHost, rejectHost) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/session',
      setHost: false,
      headers: { Host: 'evil.example:8080' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolveHost(response.statusCode));
    });
    request.on('error', rejectHost);
    request.end();
  });
  assert.equal(badHost, 403);

  const badOrigin = await httpRequest({
    port: server.port,
    method: 'POST',
    path: '/api/validate',
    headers: { ...body, Origin: 'http://evil.example' },
    body: zip,
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.json.error.code, 'WEB_ORIGIN_INVALID');

  const crossSite = await httpRequest({
    port: server.port,
    method: 'POST',
    path: '/api/validate',
    headers: { ...body, 'Sec-Fetch-Site': 'cross-site' },
    body: zip,
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json.error.code, 'WEB_FETCH_SITE_INVALID');

  const { 'Sec-Fetch-Site': _omitted, ...withoutSite } = body;
  const missingSite = await httpRequest({
    port: server.port,
    method: 'POST',
    path: '/api/validate',
    headers: withoutSite,
    body: zip,
  });
  assert.equal(missingSite.status, 403);
  assert.equal(missingSite.json.error.code, 'WEB_FETCH_SITE_INVALID');

  const noCsrf = await httpRequest({
    port: server.port,
    method: 'POST',
    path: '/api/validate',
    headers: { ...body, 'X-R2C-CSRF': 'wrong-token' },
    body: zip,
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, 'WEB_CSRF_INVALID');

  const options = await httpRequest({
    port: server.port,
    method: 'OPTIONS',
    path: '/api/validate',
    headers: { Origin: server.base },
  });
  assert.equal(options.status, 405);
  assert.equal(options.json.error.code, 'WEB_METHOD_NOT_ALLOWED');
});

test('static responses carry the strict security envelope', async (t) => {
  const server = await startServer(t);
  const root = await httpRequest({ port: server.port, path: '/' });
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /^text\/html/);
  assert.match(root.headers['content-security-policy'], /default-src 'none'/);
  assert.match(root.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(root.headers['content-security-policy'], /unsafe-inline/);
  assert.equal(root.headers['x-content-type-options'], 'nosniff');
  assert.equal(root.headers['x-frame-options'], 'DENY');
  assert.equal(root.headers['referrer-policy'], 'no-referrer');
  assert.equal(root.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(root.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(root.headers['cache-control'], 'no-store');
  assert.match(root.headers['permissions-policy'], /camera=\(\)/);
  assert.equal(root.headers['access-control-allow-origin'], undefined);
  assert.equal(root.headers['set-cookie'], undefined);

  const module = await httpRequest({ port: server.port, path: '/web/app.js' });
  assert.equal(module.status, 200);
  assert.match(module.headers['content-type'], /^text\/javascript/);
  const manifest = await httpRequest({ port: server.port, path: '/web/web-manifest.json' });
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers['content-type'], /^application\/json/);

  const head = await httpRequest({ port: server.port, method: 'HEAD', path: '/' });
  assert.equal(head.status, 200);
  assert.equal(head.raw.length, 0);
});

test('static whitelist denies traversal, source trees and serve.mjs', async (t) => {
  const server = await startServer(t);
  const denied = [
    '/.git/config',
    '/src/cli.js',
    '/test/web-static.test.js',
    '/docs/README.md',
    '/package.json',
    '/web/serve.mjs',
    '/web/http.js',
    '/web/build.js',
    '/web/publish.js',
    '/web/child.js',
    '/web/../core/canonical-json.js',
    '/web/%2e%2e/%2e%2e/package.json',
    '/web/%252e%252e/package.json',
    '/web/%2Fetc',
    '/web//app.js',
    '/runtime/r2c/engine/index.js',
    '/api/unknown',
  ];
  for (const path of denied) {
    const response = await httpRequest({ port: server.port, path });
    assert.equal(response.status, 404, path);
  }
});

test('global rate limit returns 429 with Retry-After (env override)', async (t) => {
  const server = await startServer(t, { R2C_WEB_RATE_LIMIT: '3' });
  const statuses = [];
  let last = null;
  for (let index = 0; index < 4; index += 1) {
    last = await httpRequest({ port: server.port, path: '/api/session' });
    statuses.push(last.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(last.json.error.code, 'WEB_RATE_LIMITED');
  assert.ok(Number(last.headers['retry-after']) >= 1);
});

test('temp root is created 0700 and removed on shutdown; stale sessions are swept', async (t) => {
  const stale = join(tmpdir(), `r2c-web-99999999-${Date.now()}`);
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'session.json'), `${JSON.stringify({ pid: 99999999, startedAt: Date.now() })}\n`);
  t.after(() => rmSync(stale, { recursive: true, force: true }));

  const server = await startServer(t);
  await delay(200);
  assert.equal(existsSync(stale), false, 'stale marked session directory should be swept');

  const own = readdirSync(tmpdir()).filter((name) => name.startsWith(`r2c-web-${server.child.pid}-`));
  assert.equal(own.length, 1);
  const ownPath = join(tmpdir(), own[0]);

  if (process.platform === 'win32') {
    server.child.stdin.write('shutdown\n');
  } else {
    server.child.kill('SIGTERM');
  }
  await new Promise((resolveExit) => server.child.once('exit', resolveExit));
  await delay(100);
  assert.equal(existsSync(ownPath), false, 'session temp root should be deleted');
});
