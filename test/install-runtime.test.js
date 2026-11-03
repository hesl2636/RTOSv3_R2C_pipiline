/**
 * #104 runner runtime install surface: engine layout, fixed launcher, runtime
 * receipt ownership, upgrade-only swap and install-time host role rendering.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { isCanonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';
import { installProjection } from '../installer/install.js';
import { installRunnerProject, renderRunnerRoles, RUNNER_ROLE_TARGETS } from '../installer/runner.js';
import { prepareJournal, writeJournal } from '../installer/transaction.js';
import {
  LAUNCHER_PATH,
  LAUNCHER_TEXT,
  RUNTIME_RECEIPT_PATH,
  installRuntime,
  readRuntimeReceipt,
} from '../installer/runtime.js';
import { fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempDir(t, prefix = 'hm2b-runtime-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, out);
    else if (entry.isFile()) out.push(relative(root, absolute).split('\\').join('/'));
  }
  return out.sort();
}

function hashTree(root) {
  const map = new Map();
  for (const path of walk(root)) map.set(path, sha256Hex(readFileSync(join(root, ...path.split('/')))));
  return map;
}

function writeEngineSource(root, version = '1.2.3') {
  const bin = `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log(${JSON.stringify(version)});\nelse console.log('engine-ok');\n`;
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'hm2b.js'), bin);
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'hm2b-status.md'), `---\ndescription: status\n---\n\n\`\`\`bash\n<runner> status\n\`\`\`\n`);
  writeFileSync(join(root, 'commands', 'hm2b-run.md'), `---\ndescription: run\n---\n\n\`\`\`bash\n<runner> run\n\`\`\`\n`);
  mkdirSync(join(root, 'hosts', 'claude-code'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'claude-code', 'settings.hooks.json'), `${JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node <hook>' }] }] },
  }, null, 2)}\n`);
  writeFileSync(join(root, 'hosts', 'claude-code', 'mcp.json'), `${JSON.stringify({ mcpServers: { demo: { command: 'demo' } } }, null, 2)}\n`);
  mkdirSync(join(root, 'hosts', 'codex'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'codex', 'hooks.json'), `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`);
  writeFileSync(join(root, 'hosts', 'codex', 'hm2b-hook-stop.cmd'), '@echo off\r\n');
  mkdirSync(join(root, 'hosts', 'omp'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'omp', 'mcp.json'), `${JSON.stringify({ mcpServers: { demo: { command: 'demo' } } }, null, 2)}\n`);
  mkdirSync(join(root, 'hosts', 'opencode'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'opencode', 'mcp.json'), `${JSON.stringify({ mcp: { demo: { type: 'local' } } }, null, 2)}\n`);
  writeFileSync(join(root, 'hosts', 'opencode', 'hm2b.ts'), 'export default {};\n');
  mkdirSync(join(root, 'hosts', 'dsh'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'dsh', 'runtime.cordis.patch.yml'), '---\n# hm2b runtime\n');
  return root;
}

function read(projectRoot, path) {
  return readFileSync(join(projectRoot, ...path.split('/')), 'utf8');
}

const RUNTIME_MODULE_URL = new URL('../installer/runtime.js', import.meta.url).href;

/**
 * Child process that runs a real `installRuntime` and parks in the transaction
 * stamp — the first clock call happens under the project lock — until the test
 * releases it. That makes "another runtime install is in flight" observable
 * without a sleep window.
 */
function writeRuntimeWorker(dir) {
  const file = join(dir, 'runtime-worker.mjs');
  writeFileSync(file, `import { existsSync, writeFileSync } from 'node:fs';
import { installRuntime } from ${JSON.stringify(RUNTIME_MODULE_URL)};

const [projectRoot, engineSource, version, marker, release] = process.argv.slice(2);
let calls = 0;
const clock = () => {
  calls += 1;
  if (calls === 1) {
    writeFileSync(marker, 'locked');
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 20_000;
    while (!existsSync(release)) {
      if (Date.now() > deadline) throw new Error('release timeout');
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
  return new Date('2026-05-01T00:00:00.000Z');
};
const outcome = installRuntime({ projectRoot, engineSource, engineVersion: version, clock });
process.stdout.write(JSON.stringify({ ok: outcome.ok, code: outcome.code, action: outcome.action }));
`);
  return file;
}

function waitForPath(file, message) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 20_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(message);
    Atomics.wait(sleeper, 0, 0, 5);
  }
}

test('installs the engine under .hm2b/engine/<V> with a fixed resolver launcher', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const engineSource = writeEngineSource(tempDir(t, 'hm2b-engine-'), '1.2.3');
  const outcome = installRuntime({
    projectRoot,
    engineSource,
    engineVersion: '1.2.3',
    clock: CLOCK,
  });
  assert.equal(outcome.code, 'OK', outcome.message);
  assert.equal(outcome.action, 'installed');

  const entry = join(projectRoot, '.hm2b/engine/1.2.3/bin/hm2b.js');
  assert.equal(existsSync(entry), true);
  assert.equal(read(projectRoot, LAUNCHER_PATH), LAUNCHER_TEXT);
  assert.equal(read(projectRoot, LAUNCHER_PATH).includes('1.2.3'), false);
  assert.equal(read(projectRoot, LAUNCHER_PATH).includes(projectRoot.replaceAll('\\', '/')), false);

  const runtimeText = read(projectRoot, RUNTIME_RECEIPT_PATH);
  assert.equal(isCanonicalJson(runtimeText), true);
  const runtime = JSON.parse(runtimeText);
  assert.equal(runtime.schema, 'hm2b.runtime/v1');
  assert.deepEqual(runtime.engine, {
    version: '1.2.3',
    home: '.hm2b/engine',
    entry: '.hm2b/engine/1.2.3/bin/hm2b.js',
  });
  assert.equal(runtime.launcher, LAUNCHER_PATH);
  assert.deepEqual(runtime.host_targets, ['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
  assert.equal(JSON.stringify(runtime).includes(projectRoot.replaceAll('\\', '/')), false);
  assert.equal(JSON.stringify(runtime).includes('1.2.3/bin'), true);

  const files = new Map(runtime.files.map((file) => [file.path, file]));
  assert.equal(files.get(LAUNCHER_PATH).kind, 'launcher');
  assert.equal(files.get(LAUNCHER_PATH).mode, '0755');
  assert.ok(files.has('.claude/commands/hm2b-status.md'));
  assert.ok(files.has('.agents/skills/hm2b-run/SKILL.md'));
  assert.ok(files.has('.omp/commands/hm2b-run.md'));
  assert.ok(files.has('.opencode/commands/hm2b-status.md'));
  assert.ok(files.has('.codex/hooks.json'));
  assert.ok(files.has('.dsh/hm2b/runtime.cordis.patch.yml'));
  for (const file of runtime.files) {
    assert.equal(sha256Hex(readFileSync(join(projectRoot, ...file.path.split('/')))), file.sha256);
    assert.equal(file.path.includes('\\'), false);
    assert.equal(file.path.startsWith('/'), false);
  }

  const merged = runtime.merged.map((item) => `${item.path}|${item.pointer}`).sort();
  assert.deepEqual(merged, ['.claude/settings.json|hooks', '.mcp.json|mcpServers', '.omp/mcp.json|mcpServers', 'opencode.json|mcp']);
  assert.deepEqual(JSON.parse(read(projectRoot, '.mcp.json')).mcpServers, {});
  assert.deepEqual(JSON.parse(read(projectRoot, '.claude/settings.json')).hooks.Stop[0].hooks[0].type, 'command');
  assert.deepEqual(JSON.parse(read(projectRoot, '.omp/mcp.json')).mcpServers, {});
  assert.deepEqual(JSON.parse(read(projectRoot, 'opencode.json')).mcp, {});

  const run = spawnSync(process.execPath, [LAUNCHER_PATH, '--version'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '1.2.3');

  const second = installRuntime({ projectRoot, engineSource, engineVersion: '1.2.3', clock: CLOCK });
  assert.equal(second.code, 'OK');
  assert.equal(second.action, 'unchanged');
});

test('--engine-home records an absolute engine entry only outside the project', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const engineSource = writeEngineSource(tempDir(t, 'hm2b-engine-'), '1.2.3');
  const engineHome = tempDir(t, 'hm2b-engine-home-');
  const outcome = installRuntime({
    projectRoot,
    engineSource,
    engineVersion: '1.2.3',
    engineHome,
    clock: CLOCK,
  });
  assert.equal(outcome.code, 'OK', outcome.message);
  const runtime = JSON.parse(read(projectRoot, RUNTIME_RECEIPT_PATH));
  assert.equal(runtime.engine.home, engineHome.replaceAll('\\', '/'));
  assert.equal(runtime.engine.entry, join(engineHome, '1.2.3', 'bin', 'hm2b.js').replaceAll('\\', '/'));
  assert.equal(existsSync(join(engineHome, '1.2.3', 'bin', 'hm2b.js')), true);
  assert.equal(existsSync(join(projectRoot, '.hm2b/engine')), false);

  const run = spawnSync(process.execPath, [LAUNCHER_PATH, '--version'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '1.2.3');
});

test('engine upgrade swaps only runtime.json and the engine directory', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const { result, compiledWorkflowBytes } = sample('runner');
  const bundle = installRunnerProject({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(bundle.code, 'OK', bundle.message);

  const source1 = writeEngineSource(tempDir(t, 'hm2b-engine1-'), '1.0.0');
  const first = installRuntime({ projectRoot, engineSource: source1, engineVersion: '1.0.0', clock: CLOCK });
  assert.equal(first.code, 'OK', first.message);

  const receiptFile = join(projectRoot, ...bundle.receiptPath.split('/'));
  const bundleReceipt = readFileSync(receiptFile);
  const before = hashTree(projectRoot);
  const hostBefore = [...before.entries()]
    .filter(([path]) => !path.startsWith('.hm2b/engine/') && path !== RUNTIME_RECEIPT_PATH && path !== bundle.receiptPath);

  const source2 = writeEngineSource(tempDir(t, 'hm2b-engine2-'), '2.0.0');
  const second = installRuntime({ projectRoot, engineSource: source2, engineVersion: '2.0.0', clock: CLOCK });
  assert.equal(second.code, 'OK', second.message);
  assert.equal(second.action, 'installed');

  assert.equal(existsSync(join(projectRoot, '.hm2b/engine/1.0.0')), false, 'old engine version is pruned');
  assert.equal(existsSync(join(projectRoot, '.hm2b/engine/2.0.0/bin/hm2b.js')), true);
  const runtime = JSON.parse(read(projectRoot, RUNTIME_RECEIPT_PATH));
  assert.equal(runtime.engine.version, '2.0.0');
  assert.equal(runtime.engine.entry, '.hm2b/engine/2.0.0/bin/hm2b.js');
  assert.equal(runtime.files.some((file) => file.path === '.claude/settings.json' || file.path === 'opencode.json'), false);
  assert.deepEqual(runtime.merged.map((item) => item.pointer).sort(), ['hooks', 'mcp', 'mcpServers', 'mcpServers']);
  assert.equal(readFileSync(receiptFile).equals(bundleReceipt), true, 'bundle receipt never records the engine version');

  const after = hashTree(projectRoot);
  for (const [path, hash] of hostBefore) assert.equal(after.get(path), hash, `${path} must not change on engine upgrade`);
  assert.equal(read(projectRoot, LAUNCHER_PATH), LAUNCHER_TEXT);
});

test('a crashed runtime transaction is rolled back before the next install', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const engineSource = writeEngineSource(tempDir(t, 'hm2b-engine-'), '1.2.3');
  const first = installRuntime({ projectRoot, engineSource, engineVersion: '1.2.3', clock: CLOCK });
  assert.equal(first.code, 'OK', first.message);
  const receiptBefore = read(projectRoot, RUNTIME_RECEIPT_PATH);
  const statusBefore = read(projectRoot, '.claude/commands/hm2b-status.md');

  // A killed upgrade: journal first, then half-written files, then an abrupt
  // exit without rollback or journal cleanup. runtime.json only survives in
  // the transaction backup.
  const journal = prepareJournal({
    projectRoot,
    command: 'runtime',
    operations: [
      { op: 'replace', path: '.claude/commands/hm2b-status.md', backup: true },
      { op: 'replace', path: RUNTIME_RECEIPT_PATH, backup: true },
    ],
    createdDirs: [],
    projectionId: 'runtime',
    bundleId: '1.2.3',
    stamp: '2026-01-01T00-00-00-000Z',
    clock: CLOCK,
  });
  writeJournal(projectRoot, journal);
  writeFileSync(join(projectRoot, ...RUNTIME_RECEIPT_PATH.split('/')), '{"schema":"hm2b.runtime/v1","engine":');
  writeFileSync(join(projectRoot, '.claude', 'commands', 'hm2b-status.md'), 'half-written\n');
  assert.throws(() => readRuntimeReceipt(projectRoot), SyntaxError, 'the crashed run left no readable receipt');

  const outcome = installRuntime({ projectRoot, engineSource, engineVersion: '1.2.3', clock: CLOCK });
  assert.equal(outcome.code, 'OK', outcome.message);
  assert.equal(outcome.action, 'unchanged', 'the rollback restored the receipt and every runtime-owned file');
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/pending.json')), false);
  assert.equal(read(projectRoot, RUNTIME_RECEIPT_PATH), receiptBefore);
  assert.equal(read(projectRoot, '.claude/commands/hm2b-status.md'), statusBefore);
});

test('a failed runtime upgrade restores the previous runtime.json', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const source1 = writeEngineSource(tempDir(t, 'hm2b-engine1-'), '1.0.0');
  const first = installRuntime({ projectRoot, engineSource: source1, engineVersion: '1.0.0', clock: CLOCK });
  assert.equal(first.code, 'OK', first.message);
  const receiptBefore = read(projectRoot, RUNTIME_RECEIPT_PATH);
  const statusBefore = read(projectRoot, '.claude/commands/hm2b-status.md');

  // 2.0.0 changes a runtime-owned file, so the journal has real work to undo.
  const source2 = writeEngineSource(tempDir(t, 'hm2b-engine2-'), '2.0.0');
  writeFileSync(join(source2, 'commands', 'hm2b-status.md'), '---\ndescription: status v2\n---\n\n```bash\n<runner> status\n```\n');
  let calls = 0;
  const failingClock = () => {
    calls += 1;
    // Calls: the stamp, the journal start, then the receipt timestamp after
    // every file was written and before runtime.json is swapped.
    if (calls === 3) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    return CLOCK();
  };

  const failed = installRuntime({ projectRoot, engineSource: source2, engineVersion: '2.0.0', clock: failingClock });
  assert.equal(failed.code, 'RUNTIME_INSTALL_FAILED', JSON.stringify(failed));
  assert.equal(failed.cause, 'EIO');
  assert.equal(existsSync(join(projectRoot, ...RUNTIME_RECEIPT_PATH.split('/'))), true, 'runtime.json is restored, not unlinked');
  assert.equal(read(projectRoot, RUNTIME_RECEIPT_PATH), receiptBefore);
  assert.equal(read(projectRoot, '.claude/commands/hm2b-status.md'), statusBefore);
  assert.equal(existsSync(join(projectRoot, '.hm2b/engine/2.0.0')), false);
  assert.equal(existsSync(join(projectRoot, '.hm2b/engine/1.0.0/bin/hm2b.js')), true);
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/pending.json')), false);
  assert.equal(readRuntimeReceipt(projectRoot).engine.version, '1.0.0');
});

test('a runtime conflict that appears after the pre-lock check is caught under the lock', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const engineSource = writeEngineSource(tempDir(t, 'hm2b-engine-'), '1.2.3');
  const intruder = join(projectRoot, '.claude', 'commands', 'hm2b-status.md');
  let calls = 0;
  // The stamp is taken immediately after the lock: a file landing in that
  // window means the pre-lock scan is stale and the ownership set must be
  // re-read under the lock.
  const clock = () => {
    calls += 1;
    if (calls === 1) {
      mkdirSync(dirname(intruder), { recursive: true });
      writeFileSync(intruder, 'intruder\n');
    }
    return CLOCK();
  };

  const outcome = installRuntime({ projectRoot, engineSource, engineVersion: '1.2.3', clock });
  assert.equal(outcome.code, 'RUNTIME_CONFLICTS', JSON.stringify(outcome));
  assert.match(outcome.message, /while waiting for the lock/);
  assert.deepEqual(outcome.conflicts.map((conflict) => conflict.path), ['.claude/commands/hm2b-status.md']);
  assert.equal(readFileSync(intruder, 'utf8'), 'intruder\n', 'the late file is never overwritten');
  assert.equal(existsSync(join(projectRoot, ...RUNTIME_RECEIPT_PATH.split('/'))), false);
  assert.equal(existsSync(join(projectRoot, '.hm2b/engine')), false);
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/pending.json')), false);
});

test('two concurrent runtime installs yield exactly one success', async (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const engineSource = writeEngineSource(tempDir(t, 'hm2b-engine-'), '1.2.3');
  const barrier = tempDir(t, 'hm2b-barrier-');
  const marker = join(barrier, 'locked');
  const release = join(barrier, 'release');

  const child = spawn(
    process.execPath,
    [writeRuntimeWorker(barrier), projectRoot, engineSource, '1.2.3', marker, release],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolve) => child.on('close', (status) => resolve(status)));

  waitForPath(marker, 'the concurrent runtime install never took the project lock');
  const contender = installRuntime({ projectRoot, engineSource, engineVersion: '1.2.3', clock: CLOCK });
  assert.equal(contender.code, 'LOCK_CONFLICT', JSON.stringify(contender));

  writeFileSync(release, 'go');
  assert.equal(await closed, 0, stderr);
  const winner = JSON.parse(stdout);
  assert.equal(winner.ok, true, stdout);
  assert.equal(winner.action, 'installed');

  const successes = [contender, winner].filter((outcome) => outcome.ok === true);
  assert.equal(successes.length, 1, JSON.stringify({ contender, winner }));
  assert.equal(readRuntimeReceipt(projectRoot).engine.version, '1.2.3');
  assert.equal(existsSync(join(projectRoot, '.hm2b/engine/1.2.3/bin/hm2b.js')), true);
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/pending.json')), false);
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/.lock')), false);
});

test('render-roles renders four host definitions named runner-<id> and dsh none', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const { result, compiledWorkflowBytes, compiledWorkflow } = sample('runner');
  const outcome = installRunnerProject({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK', outcome.message);

  const receipt = JSON.parse(read(projectRoot, outcome.receiptPath));
  const roleIds = Object.keys(compiledWorkflow.roles).sort();
  const roleFiles = receipt.files.filter((file) => file.kind === 'agent');
  assert.equal(roleFiles.length, roleIds.length * 4);
  assert.equal(receipt.host_targets.join(','), RUNNER_ROLE_TARGETS.join(','));
  for (const file of roleFiles) {
    assert.equal(file.origin, 'installer');
    assert.equal(typeof file.source, 'string');
    assert.equal(JSON.parse(JSON.stringify(file.targets)).length, 1);
  }

  const expected = new Set();
  for (const roleId of roleIds) {
    expected.add(`.claude/agents/runner-${roleId}.md`);
    expected.add(`.codex/agents/runner-${roleId}.toml`);
    expected.add(`.omp/agents/runner-${roleId}.md`);
    expected.add(`.opencode/agents/runner-${roleId}.md`);
  }
  assert.deepEqual([...new Set(roleFiles.map((file) => file.path))].sort(), [...expected].sort());
  for (const path of expected) assert.equal(existsSync(join(projectRoot, ...path.split('/'))), true, path);

  const claude = read(projectRoot, `.claude/agents/runner-${roleIds[0]}.md`);
  assert.match(claude, new RegExp(`runner-${roleIds[0]}`));
  assert.equal(claude.includes('rtosv3-drvport'), false, 'host roles use the runner namespace');
  assert.equal(read(projectRoot, `.codex/agents/runner-${roleIds[0]}.toml`).includes(`runner-${roleIds[0]}`), true);
  assert.equal(existsSync(join(projectRoot, '.dsh/agent-native')), false);

  const rolesText = read(projectRoot, '.hm2b/projection/roles.json');
  assert.equal(isCanonicalJson(rolesText), true);
  const roles = JSON.parse(rolesText);
  assert.equal(roles.schema, 'hm2b.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets).sort(), [...RUNNER_ROLE_TARGETS].sort());
  assert.equal(roles.targets.dsh, undefined);
  assert.deepEqual(roles.targets['claude-code'].roles.map((role) => role.name), roleIds.map((id) => `runner-${id}`));
  assert.equal(rolesText.includes(projectRoot.replaceAll('\\', '/')), false);
  const metadataFile = receipt.files.find((file) => file.path === '.hm2b/projection/roles.json');
  assert.equal(metadataFile.kind, 'metadata');
  assert.equal(metadataFile.origin, 'installer');

  assert.ok(receipt.degradations.some((item) => item.code === 'CAP_ROLE_FIELD_DEGRADED' && item.field === 'title'));
  assert.ok(receipt.degradations.some((item) => item.code === 'CAP_ROLE_FIELD_DEGRADED' && item.capability === 'subagents'));
});

test('dsh alone renders no host role definitions', () => {
  const { compiledWorkflow, compiledWorkflowDigest } = sample('runner');
  const rendered = renderRunnerRoles({ compiledWorkflow, compiledWorkflowDigest, hostTargets: ['dsh'] });
  assert.deepEqual(rendered.targets, []);
  assert.deepEqual(rendered.files.map((file) => file.path), ['.hm2b/projection/roles.json']);
  const roles = JSON.parse(rendered.files[0].content);
  assert.deepEqual(roles.targets, {});
  assert.equal(rendered.files[0].targets.length, 0);
});

test('runtime install refuses a broken engine source before writing', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const engineSource = tempDir(t, 'hm2b-engine-');
  const outcome = installRuntime({ projectRoot, engineSource, engineVersion: '1.0.0', clock: CLOCK });
  assert.equal(outcome.code, 'ENGINE_ENTRY_MISSING');
  assert.deepEqual(walk(projectRoot), []);
});

test('launcher stays byte-identical and executable on the host platform', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const engineSource = writeEngineSource(tempDir(t, 'hm2b-engine-'), '1.2.3');
  installRuntime({ projectRoot, engineSource, engineVersion: '1.2.3', clock: CLOCK });
  const launcher = read(projectRoot, LAUNCHER_PATH);
  assert.equal(launcher, LAUNCHER_TEXT);
  assert.equal(launcher.endsWith('\n'), true);
  assert.equal(launcher.includes('\r'), false);
  assert.equal(launcher.startsWith('#!'), true);
  assert.equal(launcher.includes('runtime?.engine?.entry'), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(projectRoot, ...LAUNCHER_PATH.split('/'))).mode & 0o777, 0o755);
  }
});

test('an engine install does not create a bundle receipt or record the engine version in one', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  const { result, compiledWorkflowBytes } = sample('runner');
  const bundle = installProjection({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK });
  const engineSource = writeEngineSource(tempDir(t, 'hm2b-engine-'), '3.1.4');
  const runtime = installRuntime({ projectRoot, engineSource, engineVersion: '3.1.4', clock: CLOCK });
  assert.equal(runtime.code, 'OK');
  const receiptText = read(projectRoot, bundle.receiptPath);
  assert.equal(receiptText.includes('3.1.4'), false);
  assert.equal(readRuntimeReceipt(projectRoot).engine.version, '3.1.4');
});

test('a runner install refuses a foreign workflows/*.yaml', (t) => {
  const projectRoot = tempDir(t, 'hm2b-project-');
  mkdirSync(join(projectRoot, 'workflows'), { recursive: true });
  writeFileSync(join(projectRoot, 'workflows', 'other.yaml'), 'schema: hm2b.workflow/v1\nid: other\nversion: 0.1.0\nstages: []\n');
  const { result, compiledWorkflowBytes } = sample('runner');
  const outcome = installRunnerProject({ result, compiledWorkflowBytes, projectRoot, clock: CLOCK, force: true });
  assert.equal(outcome.code, 'RUNNER_ROOT_OCCUPIED');
  assert.deepEqual(outcome.occupied, ['workflows/other.yaml']);
  assert.equal(existsSync(join(projectRoot, '.hm2b/install/receipts')), false);
  assert.deepEqual(readdirSync(join(projectRoot, 'workflows')), ['other.yaml']);
});

test('renderRunnerRoles drops unresolvable skill names and records preload loss at the seam', () => {
  const compiledWorkflow = {
    schema: 'hm2b.compiled-workflow/v2',
    id: 'demo',
    version: '1.0.0',
    stages: [],
    tasks: {},
    constitution: [],
    skills: { keep: {}, drop: {} },
    roles: {
      worker: {
        description: 'Worker role.',
        instructions: 'Do the work.\n',
        skills: ['keep', 'drop'],
      },
    },
  };
  const rendered = renderRunnerRoles({
    compiledWorkflow,
    compiledWorkflowDigest: 'a'.repeat(64),
    hostTargets: ['claude-code', 'codex', 'omp', 'opencode'],
    skills: ['keep'],
  });
  assert.equal(rendered.ok, true, JSON.stringify(rendered));

  const byTarget = (target) => rendered.files.filter((file) => file.kind === 'agent' && file.targets.includes(target));
  // No host skill root is installed, so a rendered role may never name a
  // skill: the field is dropped instead of being written unresolvable.
  for (const target of ['claude-code', 'codex', 'omp', 'opencode']) {
    const [role] = byTarget(target);
    assert.equal(role !== undefined, true, target);
    assert.doesNotMatch(role.content, /^\s*skills:/m, `${target} role must not declare skills`);
    assert.doesNotMatch(role.content, /keep|drop/, `${target} role must not name unresolvable skills`);
  }

  // The selected `keep` use is unavailable at install on every target; the
  // excluded `drop` use is only a seam-level loss where the target has one.
  const unavailable = rendered.degradations.filter((record) => record.code === 'CAP_PRELOAD_UNAVAILABLE');
  assert.deepEqual(unavailable.map((record) => record.target).sort(), ['claude-code', 'codex', 'omp', 'opencode']);
  for (const record of unavailable) {
    assert.equal(record.capability, 'preload');
    assert.equal(record.level, 'unavailable');
    assert.equal(record.pointer, '/roles/worker/skills/0');
    assert.equal(record.field, 'skills');
  }

  const preload = rendered.degradations.filter((record) => record.code === 'CAP_PRELOAD_EXCLUDED');
  assert.deepEqual(preload.map((record) => record.target).sort(), ['claude-code', 'omp']);
  for (const record of preload) {
    assert.equal(record.capability, 'preload');
    assert.equal(record.level, 'unavailable');
    assert.equal(record.pointer, '/roles/worker/skills/1');
    assert.equal(record.field, 'skills');
  }
  // codex/opencode have no preload seam; the projection's declared loss owns
  // that record, so install-time rendering adds no EXCLUDED row there.
  assert.ok(!preload.some((record) => record.target === 'codex' || record.target === 'opencode'));

  const roles = JSON.parse(rendered.rolesJson);
  for (const target of rendered.targets) {
    assert.equal(roles.targets[target].roles[0].fields.skills.state, 'unavailable', target);
  }
});
