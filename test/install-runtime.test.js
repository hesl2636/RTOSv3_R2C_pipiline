/**
 * #104 r2c runtime install surface: engine layout, fixed launcher, runtime
 * receipt ownership, upgrade-only swap and install-time host role rendering.
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { isCanonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';
import { installProjection } from '../installer/install.js';
import { installR2cProject, renderR2cRoles, R2C_ROLE_TARGETS } from '../installer/r2c.js';
import {
  LAUNCHER_PATH,
  LAUNCHER_TEXT,
  RUNTIME_RECEIPT_PATH,
  installRuntime,
  readRuntimeReceipt,
} from '../installer/runtime.js';
import { fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempDir(t, prefix = 'r2c-runtime-') {
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
  writeFileSync(join(root, 'bin', 'r2c.js'), bin);
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'r2c-status.md'), `---\ndescription: status\n---\n\n\`\`\`bash\n<runner> status\n\`\`\`\n`);
  writeFileSync(join(root, 'commands', 'r2c-run.md'), `---\ndescription: run\n---\n\n\`\`\`bash\n<runner> run\n\`\`\`\n`);
  mkdirSync(join(root, 'hosts', 'claude-code'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'claude-code', 'settings.hooks.json'), `${JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node <hook>' }] }] },
  }, null, 2)}\n`);
  writeFileSync(join(root, 'hosts', 'claude-code', 'mcp.json'), `${JSON.stringify({ mcpServers: { demo: { command: 'demo' } } }, null, 2)}\n`);
  mkdirSync(join(root, 'hosts', 'codex'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'codex', 'hooks.json'), `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`);
  writeFileSync(join(root, 'hosts', 'codex', 'r2c-hook-stop.cmd'), '@echo off\r\n');
  mkdirSync(join(root, 'hosts', 'omp'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'omp', 'mcp.json'), `${JSON.stringify({ mcpServers: { demo: { command: 'demo' } } }, null, 2)}\n`);
  mkdirSync(join(root, 'hosts', 'opencode'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'opencode', 'mcp.json'), `${JSON.stringify({ mcp: { demo: { type: 'local' } } }, null, 2)}\n`);
  writeFileSync(join(root, 'hosts', 'opencode', 'r2c.ts'), 'export default {};\n');
  mkdirSync(join(root, 'hosts', 'dsh'), { recursive: true });
  writeFileSync(join(root, 'hosts', 'dsh', 'runtime.cordis.patch.yml'), '---\n# r2c runtime\n');
  return root;
}

function read(projectRoot, path) {
  return readFileSync(join(projectRoot, ...path.split('/')), 'utf8');
}

test('installs the engine under .r2c/engine/<V> with a fixed resolver launcher', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const engineSource = writeEngineSource(tempDir(t, 'r2c-engine-'), '1.2.3');
  const outcome = installRuntime({
    projectRoot,
    engineSource,
    engineVersion: '1.2.3',
    clock: CLOCK,
  });
  assert.equal(outcome.code, 'OK', outcome.message);
  assert.equal(outcome.action, 'installed');

  const entry = join(projectRoot, '.r2c/engine/1.2.3/bin/r2c.js');
  assert.equal(existsSync(entry), true);
  assert.equal(read(projectRoot, LAUNCHER_PATH), LAUNCHER_TEXT);
  assert.equal(read(projectRoot, LAUNCHER_PATH).includes('1.2.3'), false);
  assert.equal(read(projectRoot, LAUNCHER_PATH).includes(projectRoot.replaceAll('\\', '/')), false);

  const runtimeText = read(projectRoot, RUNTIME_RECEIPT_PATH);
  assert.equal(isCanonicalJson(runtimeText), true);
  const runtime = JSON.parse(runtimeText);
  assert.equal(runtime.schema, 'r2c.runtime/v1');
  assert.deepEqual(runtime.engine, {
    version: '1.2.3',
    home: '.r2c/engine',
    entry: '.r2c/engine/1.2.3/bin/r2c.js',
  });
  assert.equal(runtime.launcher, LAUNCHER_PATH);
  assert.deepEqual(runtime.host_targets, ['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
  assert.equal(JSON.stringify(runtime).includes(projectRoot.replaceAll('\\', '/')), false);
  assert.equal(JSON.stringify(runtime).includes('1.2.3/bin'), true);

  const files = new Map(runtime.files.map((file) => [file.path, file]));
  assert.equal(files.get(LAUNCHER_PATH).kind, 'launcher');
  assert.equal(files.get(LAUNCHER_PATH).mode, '0755');
  assert.ok(files.has('.claude/commands/r2c-status.md'));
  assert.ok(files.has('.agents/skills/r2c-run/SKILL.md'));
  assert.ok(files.has('.omp/commands/r2c-run.md'));
  assert.ok(files.has('.opencode/commands/r2c-status.md'));
  assert.ok(files.has('.codex/hooks.json'));
  assert.ok(files.has('.dsh/r2c/runtime.cordis.patch.yml'));
  for (const file of runtime.files) {
    assert.equal(sha256Hex(readFileSync(join(projectRoot, ...file.path.split('/')))), file.sha256);
    assert.equal(file.path.includes('\\'), false);
    assert.equal(file.path.startsWith('/'), false);
  }

  const merged = runtime.merged.map((item) => `${item.path}|${item.pointer}`).sort();
  assert.deepEqual(merged, ['.claude/settings.json|hooks', '.mcp.json|mcpServers', '.omp/mcp.json|mcpServers', 'opencode.json|mcp']);
  assert.equal(JSON.parse(read(projectRoot, '.mcp.json')).mcpServers.demo.command, 'demo');
  assert.deepEqual(JSON.parse(read(projectRoot, '.claude/settings.json')).hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(JSON.parse(read(projectRoot, '.omp/mcp.json')).mcpServers.demo.command, 'demo');
  assert.equal(JSON.parse(read(projectRoot, 'opencode.json')).mcp.demo.type, 'local');

  const run = spawnSync(process.execPath, [LAUNCHER_PATH, '--version'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '1.2.3');

  const second = installRuntime({ projectRoot, engineSource, engineVersion: '1.2.3', clock: CLOCK });
  assert.equal(second.code, 'OK');
  assert.equal(second.action, 'unchanged');
});

test('--engine-home records an absolute engine entry only outside the project', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const engineSource = writeEngineSource(tempDir(t, 'r2c-engine-'), '1.2.3');
  const engineHome = tempDir(t, 'r2c-engine-home-');
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
  assert.equal(runtime.engine.entry, join(engineHome, '1.2.3', 'bin', 'r2c.js').replaceAll('\\', '/'));
  assert.equal(existsSync(join(engineHome, '1.2.3', 'bin', 'r2c.js')), true);
  assert.equal(existsSync(join(projectRoot, '.r2c/engine')), false);

  const run = spawnSync(process.execPath, [LAUNCHER_PATH, '--version'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '1.2.3');
});

test('engine upgrade swaps only runtime.json and the engine directory', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const { result, irBytes } = sample('r2c');
  const bundle = installR2cProject({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(bundle.code, 'OK', bundle.message);

  const source1 = writeEngineSource(tempDir(t, 'r2c-engine1-'), '1.0.0');
  const first = installRuntime({ projectRoot, engineSource: source1, engineVersion: '1.0.0', clock: CLOCK });
  assert.equal(first.code, 'OK', first.message);

  const receiptFile = join(projectRoot, ...bundle.receiptPath.split('/'));
  const bundleReceipt = readFileSync(receiptFile);
  const before = hashTree(projectRoot);
  const hostBefore = [...before.entries()]
    .filter(([path]) => !path.startsWith('.r2c/engine/') && path !== RUNTIME_RECEIPT_PATH && path !== bundle.receiptPath);

  const source2 = writeEngineSource(tempDir(t, 'r2c-engine2-'), '2.0.0');
  const second = installRuntime({ projectRoot, engineSource: source2, engineVersion: '2.0.0', clock: CLOCK });
  assert.equal(second.code, 'OK', second.message);
  assert.equal(second.action, 'installed');

  assert.equal(existsSync(join(projectRoot, '.r2c/engine/1.0.0')), false, 'old engine version is pruned');
  assert.equal(existsSync(join(projectRoot, '.r2c/engine/2.0.0/bin/r2c.js')), true);
  const runtime = JSON.parse(read(projectRoot, RUNTIME_RECEIPT_PATH));
  assert.equal(runtime.engine.version, '2.0.0');
  assert.equal(runtime.engine.entry, '.r2c/engine/2.0.0/bin/r2c.js');
  assert.equal(runtime.files.some((file) => file.path === '.claude/settings.json' || file.path === 'opencode.json'), false);
  assert.deepEqual(runtime.merged.map((item) => item.pointer).sort(), ['hooks', 'mcp', 'mcpServers', 'mcpServers']);
  assert.equal(readFileSync(receiptFile).equals(bundleReceipt), true, 'bundle receipt never records the engine version');

  const after = hashTree(projectRoot);
  for (const [path, hash] of hostBefore) assert.equal(after.get(path), hash, `${path} must not change on engine upgrade`);
  assert.equal(read(projectRoot, LAUNCHER_PATH), LAUNCHER_TEXT);
});

test('render-roles renders four host definitions named r2c-<id> and dsh none', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const { result, irBytes, ir } = sample('r2c');
  const outcome = installR2cProject({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK', outcome.message);

  const receipt = JSON.parse(read(projectRoot, outcome.receiptPath));
  const roleIds = Object.keys(ir.roles).sort();
  const roleFiles = receipt.files.filter((file) => file.kind === 'agent');
  assert.equal(roleFiles.length, roleIds.length * 4);
  assert.equal(receipt.host_targets.join(','), R2C_ROLE_TARGETS.join(','));
  for (const file of roleFiles) {
    assert.equal(file.origin, 'installer');
    assert.equal(typeof file.source, 'string');
    assert.equal(JSON.parse(JSON.stringify(file.targets)).length, 1);
  }

  const expected = new Set();
  for (const roleId of roleIds) {
    expected.add(`.claude/agents/r2c-${roleId}.md`);
    expected.add(`.codex/agents/r2c-${roleId}.toml`);
    expected.add(`.omp/agents/r2c-${roleId}.md`);
    expected.add(`.opencode/agents/r2c-${roleId}.md`);
  }
  assert.deepEqual([...new Set(roleFiles.map((file) => file.path))].sort(), [...expected].sort());
  for (const path of expected) assert.equal(existsSync(join(projectRoot, ...path.split('/'))), true, path);

  const claude = read(projectRoot, `.claude/agents/r2c-${roleIds[0]}.md`);
  assert.match(claude, new RegExp(`r2c-${roleIds[0]}`));
  assert.equal(claude.includes('rtosv3-drvport'), false, 'host roles use the r2c namespace');
  assert.equal(read(projectRoot, `.codex/agents/r2c-${roleIds[0]}.toml`).includes(`r2c-${roleIds[0]}`), true);
  assert.equal(existsSync(join(projectRoot, '.dsh/agent-native')), false);

  const rolesText = read(projectRoot, '.r2c/projection/roles.json');
  assert.equal(isCanonicalJson(rolesText), true);
  const roles = JSON.parse(rolesText);
  assert.equal(roles.schema, 'r2c.projection.roles/v1');
  assert.deepEqual(Object.keys(roles.targets).sort(), [...R2C_ROLE_TARGETS].sort());
  assert.equal(roles.targets.dsh, undefined);
  assert.deepEqual(roles.targets['claude-code'].roles.map((role) => role.name), roleIds.map((id) => `r2c-${id}`));
  assert.equal(rolesText.includes(projectRoot.replaceAll('\\', '/')), false);
  const metadataFile = receipt.files.find((file) => file.path === '.r2c/projection/roles.json');
  assert.equal(metadataFile.kind, 'metadata');
  assert.equal(metadataFile.origin, 'installer');

  assert.ok(receipt.degradations.some((item) => item.code === 'CAP_ROLE_FIELD_DEGRADED' && item.field === 'title'));
  assert.ok(receipt.degradations.some((item) => item.code === 'CAP_ROLE_FIELD_DEGRADED' && item.capability === 'subagents'));
});

test('dsh alone renders no host role definitions', () => {
  const { ir, irDigest } = sample('r2c');
  const rendered = renderR2cRoles({ ir, irDigest, hostTargets: ['dsh'] });
  assert.deepEqual(rendered.targets, []);
  assert.deepEqual(rendered.files.map((file) => file.path), ['.r2c/projection/roles.json']);
  const roles = JSON.parse(rendered.files[0].content);
  assert.deepEqual(roles.targets, {});
  assert.equal(rendered.files[0].targets.length, 0);
});

test('runtime install refuses a broken engine source before writing', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const engineSource = tempDir(t, 'r2c-engine-');
  const outcome = installRuntime({ projectRoot, engineSource, engineVersion: '1.0.0', clock: CLOCK });
  assert.equal(outcome.code, 'ENGINE_ENTRY_MISSING');
  assert.deepEqual(walk(projectRoot), []);
});

test('launcher stays byte-identical and executable on the host platform', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  const engineSource = writeEngineSource(tempDir(t, 'r2c-engine-'), '1.2.3');
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
  const projectRoot = tempDir(t, 'r2c-project-');
  const { result, irBytes } = sample('r2c');
  const bundle = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  const engineSource = writeEngineSource(tempDir(t, 'r2c-engine-'), '3.1.4');
  const runtime = installRuntime({ projectRoot, engineSource, engineVersion: '3.1.4', clock: CLOCK });
  assert.equal(runtime.code, 'OK');
  const receiptText = read(projectRoot, bundle.receiptPath);
  assert.equal(receiptText.includes('3.1.4'), false);
  assert.equal(readRuntimeReceipt(projectRoot).engine.version, '3.1.4');
});

test('an r2c install refuses a foreign workflows/*.yaml', (t) => {
  const projectRoot = tempDir(t, 'r2c-project-');
  mkdirSync(join(projectRoot, 'workflows'), { recursive: true });
  writeFileSync(join(projectRoot, 'workflows', 'other.yaml'), 'schema: r2c.workflow/v1\nid: other\nversion: 0.1.0\nstages: []\n');
  const { result, irBytes } = sample('r2c');
  const outcome = installR2cProject({ result, irBytes, projectRoot, clock: CLOCK, force: true });
  assert.equal(outcome.code, 'R2C_ROOT_OCCUPIED');
  assert.deepEqual(outcome.occupied, ['workflows/other.yaml']);
  assert.equal(existsSync(join(projectRoot, '.r2c/install/receipts')), false);
  assert.deepEqual(readdirSync(join(projectRoot, 'workflows')), ['other.yaml']);
});
