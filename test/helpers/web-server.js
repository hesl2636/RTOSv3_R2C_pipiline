/**
 * Shared harness for `test/web-*.test.js`: spawn the real `web/serve.mjs`
 * process, talk to it over loopback, and read its session/CSRF.
 *
 * Nothing here reaches into the server module; every assertion goes through
 * HTTP, the seam the browser uses.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export async function startWebServer(t, env = {}) {
  const child = spawn(process.execPath, ['web/serve.mjs'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error(`server did not start: ${stdout}${stderr}`)), 15_000);
    child.stdout.on('data', () => {
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
    stdout: () => stdout,
    stderr: () => stderr,
  };
  t.after(async () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') child.stdin.write('shutdown\n');
    else child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(8000).then(() => child.kill('SIGKILL')),
    ]);
  });
  return server;
}

export function httpRequest({ port, method = 'GET', path = '/', headers = {}, body = null }) {
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

export function rawRequest(port, text) {
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

export function statusOf(raw) {
  return Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0);
}

export async function sessionOf(server) {
  const response = await httpRequest({ port: server.port, path: '/api/session' });
  assert.equal(response.status, 200);
  return response.json.data;
}

export function postHeaders(server, csrf, extra = {}) {
  return {
    Origin: server.base,
    'Sec-Fetch-Site': 'same-origin',
    'X-HM2B-CSRF': csrf,
    ...extra,
  };
}

export function cliJson(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, `CLI produced no stdout: ${result.stderr}`);
  return JSON.parse(lines[lines.length - 1]);
}

export function jsonRequest(server, csrf, path, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return httpRequest({
    port: server.port,
    method: 'POST',
    path,
    headers: postHeaders(server, csrf, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      ...extra,
    }),
    body,
  });
}
