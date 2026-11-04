/** Behavioral acceptance for the generated, stdin-compatible Release launcher. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { canonicalJson } from '../core/canonical-json.js';
import { buildBundleRelease } from '../scripts/lib/bundle-release.mjs';
import { installCommands } from '../web/build.js';
import { MINIMAL_MANIFEST, minimalZip } from './helpers/minimal-bundle.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAMPLE = path.join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');
const GITHUB = 'https://api.github.com/repos/hesl2636/hm2B_drvport_pipiline';
let sampleRelease;

function sample() {
  sampleRelease ??= buildBundleRelease({ root: ROOT, bundlePath: SAMPLE });
  assert.equal(sampleRelease.ok, true, sampleRelease.failures.join('\n'));
  return sampleRelease;
}

function restrictedRelease(t, projections) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hm2b-launcher-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundlePath = path.join(directory, 'bundle.zip');
  writeFileSync(bundlePath, minimalZip({ overrides: {
    'bundle.json': canonicalJson({ ...MINIMAL_MANIFEST, requires: { projections } }),
  } }));
  const built = buildBundleRelease({ root: ROOT, bundlePath });
  assert.equal(built.ok, true, built.failures.join('\n'));
  return built;
}

/**
 * All network, filesystem and subprocess effects are recorded in memory.
 * process.exit stops observable effects immediately, matching its real behavior
 * rather than accidentally treating it as a normal throw that runs finally.
 */
async function launch(options = {}) {
  const built = options.built ?? sample();
  const launcher = built.assets.find((asset) => asset.name === 'install').data.toString('utf8');
  const installer = built.assets.find((asset) => asset.name === 'install.mjs').data;
  const requests = [];
  const credentials = [];
  const children = [];
  const created = [];
  const removed = [];
  const writes = [];
  const timeouts = [];
  const gitLookups = [];
  let stderr = '';
  let terminated = false;
  let exitCode;
  const fakeProcess = {
    argv: ['node', '-', ...(options.args ?? [])],
    execPath: '/mock/node',
    platform: options.platform ?? 'linux',
    versions: { node: options.nodeVersion ?? process.versions.node },
    env: { PATH: options.git ? '/mock/bin' : '', ...options.env },
    stderr: { write(text) { if (!terminated) stderr += text; } },
    stdout: { write() {} },
    exit(code) {
      exitCode = code;
      terminated = true;
      throw new Error('mock process exited');
    },
    get exitCode() { return exitCode; },
    set exitCode(value) { if (!terminated) exitCode = value; },
  };
  const modules = {
    'node:crypto': { createHash },
    'node:path': path,
    'node:os': { tmpdir: () => '/mock/tmp' },
    'node:fs': {
      statSync(candidate) {
        gitLookups.push(candidate);
        if (options.git && path.basename(candidate) === (options.gitName ?? 'git')) return { isFile: () => true };
        throw new Error('ENOENT');
      },
      existsSync(candidate) {
        const directory = fakeProcess.env.HM2B_RELEASE_BASE;
        const local = options.localLayout === 'tagged'
          ? path.join(directory, `bundle-${built.id}-v${built.version}`, 'install.mjs')
          : path.join(directory, 'install.mjs');
        return Boolean(options.localLayout) && candidate === local;
      },
      readFileSync() { return installer; },
      mkdtempSync(prefix) {
        const directory = `${prefix}test`;
        created.push(directory);
        return directory;
      },
      writeFileSync(file, data) { if (!terminated) writes.push({ file, data: Buffer.from(data) }); },
      rmSync(directory) { if (!terminated) removed.push(directory); },
    },
    'node:child_process': {
      spawnSync(command, args, spawnOptions) {
        if (command !== fakeProcess.execPath) {
          credentials.push({ command, args: Array.from(args), options: spawnOptions });
          return options.gitFailure
            ? { status: 1, stdout: '' }
            : { status: 0, stdout: 'protocol=https\nhost=github.com\npassword=helper-token\n' };
        }
        children.push({ command, args: Array.from(args), options: spawnOptions });
        return options.child ?? { status: 0 };
      },
    },
  };
  const context = {
    process: fakeProcess,
    Buffer,
    URL,
    AbortSignal: { timeout(milliseconds) { timeouts.push(milliseconds); return { milliseconds }; } },
    require(name) {
      assert.ok(name in modules, `unexpected generated launcher dependency: ${name}`);
      return modules[name];
    },
    async fetch(url, requestOptions = {}) {
      const headers = Object.fromEntries(new Headers(requestOptions.headers));
      requests.push({ url: String(url), headers });
      if (options.networkError) throw options.networkError;
      if (String(url).includes('/releases/tags/')) {
        return {
          ok: true,
          status: 200,
          async json() { return { assets: [{ name: 'install.mjs', id: 27, url: `${GITHUB}/releases/assets/27` }] }; },
        };
      }
      return {
        ok: !options.httpStatus,
        status: options.httpStatus ?? 200,
        async arrayBuffer() {
          if (options.bodyError) throw options.bodyError;
          return options.tampered ? Buffer.from('console.log("tampered installer");\n') : installer;
        },
      };
    },
  };
  await runInNewContext(launcher, context, { filename: 'generated-release-install' });
  return { exitCode: exitCode ?? 0, stderr, requests, credentials, children, created, removed, writes, timeouts, gitLookups };
}

test('generated launcher installs runner by default and forwards project and force', async () => {
  const result = await launch({ args: ['--project', 'project with spaces', '--force'] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.children.length, 1);
  assert.deepEqual(result.children[0].args.slice(1), [
    '--bundle', 'rtosv3-drvport', '--version', '1.0.0', '--projection', 'runner',
    '--project', 'project with spaces', '--force',
  ]);
  assert.deepEqual(result.removed, result.created);
});

test('targets select agent-native and preserve every requested host', async () => {
  const result = await launch({ args: ['--target', 'omp', '--target', 'codex'] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.children[0].args.slice(1), [
    '--bundle', 'rtosv3-drvport', '--version', '1.0.0', '--projection', 'agent-native',
    '--project', '.', '--target', 'omp', '--target', 'codex',
  ]);
});

test('agent-native-only bundle defaults to its allowed projection', async (t) => {
  const result = await launch({ built: restrictedRelease(t, ['agent-native']) });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.children[0].args[result.children[0].args.indexOf('--projection') + 1], 'agent-native');
});

test('disallowed projections and runner targets are refused before downloading', async (t) => {
  const built = restrictedRelease(t, ['agent-native']);
  const disallowed = await launch({ built, args: ['--projection', 'runner'] });
  assert.equal(disallowed.exitCode, 2, disallowed.stderr);
  assert.equal(disallowed.requests.length, 0);
  assert.equal(disallowed.children.length, 0);
  const targets = await launch({ args: ['--projection', 'runner', '--target', 'omp'] });
  assert.equal(targets.exitCode, 2, targets.stderr);
  assert.equal(targets.requests.length, 0);
});

test('a custom mirror never receives GitHub credentials or runs its credential helper', async () => {
  const result = await launch({ git: true, env: {
    HM2B_RELEASE_BASE: 'https://mirror.example/download', GH_TOKEN: 'mirror-must-not-see-this', GITHUB_TOKEN: 'nor-this',
  } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.ok(result.requests[0].url.startsWith('https://mirror.example/download/'));
  assert.equal(result.requests[0].headers.authorization, undefined);
  assert.equal(result.credentials.length, 0);
  assert.equal(result.gitLookups.length, 0);
});

test('GH_TOKEN takes precedence and downloads the private asset through the GitHub API', async () => {
  const result = await launch({ env: { GH_TOKEN: 'first-token', GITHUB_TOKEN: 'second-token' } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.credentials.length, 0);
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[0].url, `${GITHUB}/releases/tags/bundle-rtosv3-drvport-v1.0.0`);
  assert.equal(result.requests[1].url, `${GITHUB}/releases/assets/27`);
  for (const request of result.requests) assert.equal(request.headers.authorization, 'Bearer first-token');
  assert.equal(result.requests[1].headers.accept, 'application/octet-stream');
});

test('GITHUB_TOKEN is used when GH_TOKEN is empty', async () => {
  const result = await launch({ env: { GH_TOKEN: '', GITHUB_TOKEN: 'second-token' } });
  assert.equal(result.exitCode, 0, result.stderr);
  for (const request of result.requests) assert.equal(request.headers.authorization, 'Bearer second-token');
});

test('GitHub credentials fall back to a bounded noninteractive git helper', async () => {
  const result = await launch({ git: true });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.credentials.length, 1);
  assert.deepEqual(result.credentials[0].args, ['credential', 'fill']);
  assert.equal(result.credentials[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(result.credentials[0].options.timeout > 0 && result.credentials[0].options.timeout <= 5000);
  assert.equal(result.requests[0].headers.authorization, 'Bearer helper-token');
});

test('failed Git credentials permit an anonymous public download', async () => {
  const result = await launch({ git: true, gitFailure: true });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.credentials.length, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].headers.authorization, undefined);
  assert.ok(result.requests[0].url.startsWith('https://github.com/'));
});

test('a Windows cmd Git helper runs hidden and noninteractively through its shell shim', async () => {
  const result = await launch({ git: true, gitName: 'git.cmd', platform: 'win32', env: { PATHEXT: '.CMD' } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.credentials.length, 1);
  assert.deepEqual(result.credentials[0].args, []);
  assert.match(result.credentials[0].command, /git\.cmd" credential fill$/);
  assert.equal(result.credentials[0].options.shell, true);
  assert.equal(result.credentials[0].options.windowsHide, true);
  assert.equal(result.credentials[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(result.requests[0].headers.authorization, 'Bearer helper-token');
});

test('the launcher pins a custom repository for both download and installer handoff', async () => {
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE, repo: 'other/project' });
  assert.equal(built.ok, true, built.failures.join('\n'));
  const result = await launch({ built, env: { GH_TOKEN: 'repo-token', GH_REPO: 'unrelated/repository' } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.requests[0].url, 'https://api.github.com/repos/other/project/releases/tags/bundle-rtosv3-drvport-v1.0.0');
  assert.equal(result.requests[1].url, 'https://api.github.com/repos/other/project/releases/assets/27');
  assert.equal(result.children[0].options.env.GH_REPO, 'other/project');
});

for (const localLayout of ['tagged', 'flat']) {
  test(`a ${localLayout} local mirror installs without network or GitHub credentials`, async () => {
    const result = await launch({ localLayout, git: true, env: { HM2B_RELEASE_BASE: '/mock/mirror', GH_TOKEN: 'local-secret' } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    assert.equal(result.credentials.length, 0);
    assert.equal(result.children.length, 1);
    assert.deepEqual(result.removed, result.created);
  });
}

test('help exits successfully and invalid arguments fail without downloading', async () => {
  const help = await launch({ args: ['--help'] });
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stderr, /usage:/);
  assert.equal(help.requests.length, 0);
  assert.equal(help.children.length, 0);
  const invalid = await launch({ args: ['--unknown'] });
  assert.equal(invalid.exitCode, 2, invalid.stderr);
  assert.equal(invalid.requests.length, 0);
  assert.equal(invalid.children.length, 0);
});

for (const nodeVersion of ['20.11.1', '22.18.0', '23.1.0']) {
  test(`Node ${nodeVersion} is refused before filesystem or network effects`, async () => {
    const result = await launch({ nodeVersion });
    assert.equal(result.exitCode, 2, result.stderr);
    assert.match(result.stderr, /ENGINE_NODE_UNSUPPORTED/);
    assert.equal(result.created.length, 0);
    assert.equal(result.requests.length, 0);
    assert.equal(result.children.length, 0);
  });
}

test('the first download honors the configured timeout budget', async () => {
  const result = await launch({ env: { HM2B_INSTALL_DOWNLOAD_TIMEOUT_MS: '12345' } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.timeouts.length > 0);
  assert.ok(result.timeouts.every((milliseconds) => milliseconds === 12345));
});

test('HTTP failures remove the temporary directory and report a download error', async () => {
  const result = await launch({ httpStatus: 404 });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /RELEASE_DOWNLOAD_FAILED/);
  assert.equal(result.children.length, 0);
  assert.ok(result.created.length > 0);
  assert.deepEqual(result.removed, result.created);
});

for (const phase of ['networkError', 'bodyError']) {
  test(`${phase} is a download failure with cleanup rather than INTERNAL`, async () => {
    const result = await launch({ [phase]: new Error('The operation was aborted due to timeout') });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /RELEASE_DOWNLOAD_FAILED/);
    assert.doesNotMatch(result.stderr, /INTERNAL/);
    assert.equal(result.children.length, 0);
    assert.deepEqual(result.removed, result.created);
  });
}

test('installer failure preserves its exit status and cleans up its downloaded script', async () => {
  const result = await launch({ child: { status: 3 } });
  assert.equal(result.exitCode, 3, result.stderr);
  assert.equal(result.children.length, 1);
  assert.deepEqual(result.removed, result.created);
});

test('a failed installer spawn cleans up and returns a failure', async () => {
  const result = await launch({ child: { status: null, error: new Error('spawn unavailable') } });
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(result.children.length, 1);
  assert.deepEqual(result.removed, result.created);
});

test('a tampered installer is rejected before any code is executed', async () => {
  const result = await launch({ tampered: true });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /RELEASE_CHECKSUM_MISMATCH/);
  assert.equal(result.children.length, 0);
  assert.equal(result.writes.length, 0);
  assert.deepEqual(result.removed, result.created);
});

test('the generated per-agent commands install only their selected host through the real stdin launcher', async (t) => {
  // Build fresh bytes so the launcher, its pinned installer and framework archive
  // are the same Release, independently of the VM fixture cached above.
  const built = buildBundleRelease({ root: ROOT, bundlePath: SAMPLE });
  assert.equal(built.ok, true, built.failures.join('\n'));
  const sandbox = mkdtempSync(path.join(tmpdir(), 'hm2b-stdin-launcher-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const release = path.join(sandbox, 'release');
  const temporary = path.join(sandbox, 'temporary');
  mkdirSync(release);
  mkdirSync(temporary);
  for (const asset of built.assets) writeFileSync(path.join(release, asset.name), asset.data);
  const launcher = built.assets.find((asset) => asset.name === 'install').data;
  const hostRoots = { 'claude-code': '.claude', codex: '.codex', dsh: '.dsh', omp: '.omp', opencode: '.opencode' };
  const install = installCommands({
    id: 'rtosv3-drvport', version: '1.0.0', publishable: true, repo: 'hesl2636/hm2B_drvport_pipiline',
    projections: [{ id: 'runner', targets: ['runner'] }, { id: 'agent-native', targets: Object.keys(hostRoots) }],
  });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:GH_|GITHUB_|HM2B_|R2C_)/.test(key)) delete env[key];
  }
  Object.assign(env, { HM2B_RELEASE_BASE: release, TMP: temporary, TEMP: temporary, TMPDIR: temporary });

  async function runStdin(project, args) {
    mkdirSync(project);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-', ...args], {
        cwd: project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`stdin launcher timed out: ${stdout}\n${stderr}`));
      }, 60_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      child.stdin.end(launcher);
    });
  }

  await t.test('no arguments install runner and its runtime', async () => {
    const project = path.join(sandbox, 'runner-project');
    const result = await runStdin(project, []);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(readFileSync(path.join(project, '.hm2b/install/receipts/runner/rtosv3-drvport.json'), 'utf8'));
    assert.equal(receipt.schema, 'hm2b.install/v2');
    assert.equal(receipt.projection.id, 'runner');
    assert.equal(receipt.bundle.id, 'rtosv3-drvport');
    assert.equal(receipt.bundle.version, '1.0.0');
    const runtime = JSON.parse(readFileSync(path.join(project, '.hm2b/install/runtime.json'), 'utf8'));
    assert.equal(runtime.schema, 'hm2b.runtime/v1');
    assert.equal(runtime.engine.version, built.engineVersion);
    assert.ok(existsSync(path.join(project, '.hm2b/engine', built.engineVersion, 'bin/hm2b.js')));
    assert.ok(existsSync(path.join(project, '.hm2b/bin/hm2b.js')));
    assert.equal(existsSync(path.join(project, '.hm2b/install/receipts/agent-native/rtosv3-drvport.json')), false);
  });

  for (const item of install.commands.filter((entry) => entry.projection === 'agent-native')) {
    await t.test(`generated ${item.target} command installs only that host and no runtime`, async () => {
      const project = path.join(sandbox, `${item.target}-project`);
      const args = item.command.split(' | node - ')[1].split(' ');
      assert.deepEqual(item.powershellCommand.split(' | node - ')[1].split(' '), args);
      const result = await runStdin(project, args);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const receipt = JSON.parse(readFileSync(path.join(project, '.hm2b/install/receipts/agent-native/rtosv3-drvport.json'), 'utf8'));
      assert.equal(receipt.schema, 'hm2b.install/v2');
      assert.equal(receipt.projection.id, 'agent-native');
      assert.deepEqual(receipt.projection.targets, [item.target]);
      assert.deepEqual(receipt.options.targets, [item.target]);
      assert.equal(receipt.bundle.id, 'rtosv3-drvport');
      for (const [target, root] of Object.entries(hostRoots)) {
        assert.equal(existsSync(path.join(project, root)), target === item.target, `${target} host files`);
      }
      assert.equal(existsSync(path.join(project, '.hm2b/install/runtime.json')), false);
      assert.equal(existsSync(path.join(project, '.hm2b/engine')), false);
      assert.equal(existsSync(path.join(project, '.hm2b/install/receipts/runner/rtosv3-drvport.json')), false);
    });
  }

  assert.deepEqual(readdirSync(temporary), [], 'both launcher and verified framework temporary directories were removed');
});
