/**
 * Frozen legacy `v<E>` channel: bootstrap (`scripts/install.mjs`) unit contract
 * after P6.
 *
 * The legacy payload channel is frozen: main no longer builds or publishes
 * `r2c-payload-<V>.tgz`, and a current engine has no `adapter` command. The
 * bootstrap keeps its transport/credential/argument contract so old Releases
 * (whose own engines are frozen) remain installable. Those old Releases name
 * their engine `r2c-engine-<E>.tgz`; the new bundle channel names it
 * `hm2b-engine-<E>.tgz` and is covered end-to-end by `bootstrap-e2e.test.js`
 * and `release-install.test.js`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withPath } from './support/env.js';
import { archivePathProblem, assetUnavailable, authCredential, nodeSupported } from '../scripts/install.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(REPO, 'scripts', 'install.mjs');

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `hm2b-bootstrap-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PROBE = `import { readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(
  process.env.FAKE_GIT_PROBE,
  JSON.stringify({
    args: process.argv.slice(2),
    prompt: process.env.GIT_TERMINAL_PROMPT ?? null,
    stdin: Buffer.concat(chunks).toString('utf8'),
  }),
);
if (process.env.FAKE_GIT_PASSWORD) {
  process.stdout.write(\`username=x\\npassword=\${process.env.FAKE_GIT_PASSWORD}\\n\`);
} else {
  process.exit(1);
}
`;

/**
 * Fake `git` on PATH. `git credential fill` must be answered without a prompt
 * (GIT_TERMINAL_PROMPT=0) and with protocol=https/host=github.com on stdin, so
 * the shim records both and answers from `FAKE_GIT_PASSWORD` (unset = no
 * stored credential).
 */
function fakeGit(t) {
  const dir = tempDir(t, 'git-bin');
  const script = join(dir, 'fake-git.mjs');
  writeFileSync(script, PROBE);
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'git.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const file = join(dir, 'git');
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  const record = join(tempDir(t, 'git-probe'), 'record.json');
  return { dir, record };
}

function withFakeGit(t, git, { password = null } = {}) {
  const saved = new Map();
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_TERMINAL_PROMPT', 'FAKE_GIT_PROBE', 'FAKE_GIT_PASSWORD']) {
    saved.set(key, process.env[key]);
  }
  const savedPath = [];
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === 'path') savedPath.push([key, process.env[key]]);
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key] of savedPath) delete process.env[key];
    for (const [key, value] of savedPath) process.env[key] = value;
  });
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.FAKE_GIT_PROBE = git.record;
  if (password === null) delete process.env.FAKE_GIT_PASSWORD;
  else process.env.FAKE_GIT_PASSWORD = password;
  withPath(process.env, git.dir);
  return git;
}

test('the downloader takes GH_TOKEN, then GITHUB_TOKEN, then git credential fill', (t) => {
  const git = withFakeGit(t, fakeGit(t), { password: 'stored-secret' });
  const tokens = [];

  process.env.GH_TOKEN = 'gh-token';
  process.env.GITHUB_TOKEN = 'github-token';
  tokens.push(authCredential());

  delete process.env.GH_TOKEN;
  tokens.push(authCredential());

  delete process.env.GITHUB_TOKEN;
  tokens.push(authCredential());

  assert.deepEqual(tokens.map((item) => item.token), ['gh-token', 'github-token', 'stored-secret']);
  assert.deepEqual(tokens.map((item) => item.source), ['GH_TOKEN', 'GITHUB_TOKEN', 'git-credential']);

  const probe = JSON.parse(readFileSync(git.record, 'utf8'));
  assert.deepEqual(probe.args, ['credential', 'fill']);
  assert.equal(probe.prompt, '0');
  assert.match(probe.stdin, /protocol=https/);
  assert.match(probe.stdin, /host=github\.com/);
});

test('with no credential at all the chain reports nothing', (t) => {
  withFakeGit(t, fakeGit(t));
  const credential = authCredential();
  assert.equal(credential.token, null);
  assert.equal(credential.source, null);
});

test('a missing asset names the credential story for private repositories', () => {
  const anonymous = assetUnavailable('r2c-engine-1.0.0.tgz', '1.0.0', 'https://example.invalid', {
    status: 404,
    credential: { token: null, source: null },
  });
  assert.equal(anonymous.code, 'ENGINE_AUTH_REQUIRED');
  assert.match(anonymous.message, /gh auth login|GH_TOKEN/);

  const authorized = assetUnavailable('r2c-engine-1.0.0.tgz', '1.0.0', 'local mirror', {
    status: 404,
    credential: { token: 'x', source: 'GH_TOKEN' },
  });
  assert.equal(authorized.code, 'ENGINE_ASSET_MISSING');
  assert.match(authorized.message, /local mirror/);
});

test('the Node floor is checked before any download', () => {
  assert.equal(nodeSupported('22.19.0'), true);
  assert.equal(nodeSupported('22.18.9'), false);
  assert.equal(nodeSupported('23.5.0'), false);
  assert.equal(nodeSupported('24.0.0'), true);
  assert.equal(nodeSupported('not-a-version'), false);
});

test('the shared engine archive path bound is the frozen 100-byte one', () => {
  assert.equal(archivePathProblem('bin/hm2b.js'), null);
  assert.equal(archivePathProblem('runtime/runner/engine/src/cli.js'), null);
  assert.equal(archivePathProblem('x'.repeat(100)), null);
  assert.match(archivePathProblem('x'.repeat(101)), /max 100/);
  assert.match(archivePathProblem('/abs'), /relative|absolute|POSIX/);
  assert.match(archivePathProblem('a\\b'), /POSIX|backslash/);
});

test('bad arguments fail with exit 2 before touching the release', () => {
  const bad = spawnSync(process.execPath, [BOOTSTRAP, '--unknown-flag'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage|unknown/i);
});
