/**
 * Highest-level acceptance seam after P6: build a real bundle Release from
 * the sample bundle, expose it as a local mirror and install it with the
 * bootstrap. No network, no npm, no `gh`, no model, no host binary.
 *
 * The legacy payload channel is frozen, so this test drives both bundle
 * projections instead: r2c installs the runtime + payload, agent-native
 * installs the host files and a receipt, and a tampered asset writes nothing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
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
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCanonicalJson } from '../core/canonical-json.js';
import { doctor } from '../installer/doctor.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(REPO, 'scripts', 'install.mjs');
const RELEASE = join(REPO, 'scripts', 'release.mjs');
const ENGINE_VERSION = JSON.parse(readFileSync(join(REPO, 'runtime/r2c/engine/package.json'), 'utf8')).version;
const BUNDLE_ID = 'rtosv3-drvport';
const VERSION = '1.0.0';
const TAG = `bundle-${BUNDLE_ID}-v${VERSION}`;

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `r2c-e2e-${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cleanEnv(home) {
  const env = { ...process.env };
  for (const key of [
    'R2C_SESSION_ID',
    'R2C_PROJECT_ROOT',
    'R2C_PLUGIN_SOURCE',
    'R2C_RELEASE_BASE',
    'R2C_ENGINE_HOME',
    'DSH_SESSION_ID',
    'DSH_HOME',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]) {
    delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.R2C_HOME = home;
  return env;
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, out);
    else if (entry.isFile()) out.push(absolute.slice(root.length + 1).replaceAll('\\', '/'));
  }
  return out.sort();
}

/** Build the sample bundle Release into `<base>/<tag>/` (directory mirror). */
function buildMirror(t) {
  const built = tempDir(t, 'bundle-build');
  const result = spawnSync(process.execPath, [RELEASE, '--bundle', join(REPO, 'examples', 'rtosv3', 'bundle'), '--out', built], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const base = tempDir(t, 'mirror');
  const tagDir = join(base, TAG);
  mkdirSync(tagDir, { recursive: true });
  for (const name of readdirSync(built)) copyFileSync(join(built, name), join(tagDir, name));
  return { base, tagDir, built };
}

function bootstrap(args, { env, cwd }) {
  return spawnSync(process.execPath, [BOOTSTRAP, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
}

test('r2c projection: engine, runtime, payload and receipts from a local mirror', (t) => {
  const { base } = buildMirror(t);
  const project = tempDir(t, 'project-r2c');
  const env = cleanEnv(tempDir(t, 'home-r2c'));

  const result = bootstrap([
    '--bundle', BUNDLE_ID,
    '--version', VERSION,
    '--projection', 'r2c',
    '--project', project,
    '--release-base', base,
  ], { env, cwd: project });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`install r2c/${BUNDLE_ID}@${VERSION}`));
  assert.match(result.stdout, /next: node \.r2c\/bin\/r2c\.js/);

  const files = walk(project);
  for (const required of [
    '.r2c/bin/r2c.js',
    '.r2c/install/runtime.json',
    `.r2c/engine/${ENGINE_VERSION}/bin/r2c.js`,
    'workflows/rtosv3-drvport.yaml',
    'tasks/analysis-design-orchestration.md',
    'skills/red-blue/SKILL.md',
    'roles/bys-architect.md',
    `.r2c/install/receipts/r2c/${BUNDLE_ID}.json`,
    '.r2c/projection/roles.json',
    '.claude/agents/r2c-bys-architect.md',
    '.claude/commands/r2c-run.md',
    '.codex/hooks.json',
    '.dsh/r2c/runtime.cordis.patch.yml',
    '.r2c/shims/hook.mjs',
  ]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }

  const runtime = JSON.parse(readFileSync(join(project, '.r2c/install/runtime.json'), 'utf8'));
  assert.equal(runtime.schema, 'r2c.runtime/v1');
  assert.equal(runtime.engine.entry, `.r2c/engine/${ENGINE_VERSION}/bin/r2c.js`);
  const receipt = JSON.parse(readFileSync(join(project, `.r2c/install/receipts/r2c/${BUNDLE_ID}.json`), 'utf8'));
  assert.equal(isCanonicalJson(readFileSync(join(project, `.r2c/install/receipts/r2c/${BUNDLE_ID}.json`), 'utf8')), true);
  assert.equal(receipt.projection.id, 'r2c');
  assert.equal(receipt.bundle.id, BUNDLE_ID);

  const version = spawnSync(process.execPath, [join(project, '.r2c', 'bin', 'r2c.js'), '--version'], {
    cwd: project,
    encoding: 'utf8',
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), ENGINE_VERSION);

  const report = doctor(project);
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === 'fail'), null, 2));
});

test('agent-native projection: host files and one receipt, no runtime', (t) => {
  const { base } = buildMirror(t);
  const project = tempDir(t, 'project-an');
  const env = cleanEnv(tempDir(t, 'home-an'));

  const result = bootstrap([
    '--bundle', BUNDLE_ID,
    '--version', VERSION,
    '--projection', 'agent-native',
    '--target', 'claude-code',
    '--target', 'codex',
    '--project', project,
    '--release-base', base,
  ], { env, cwd: project });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const files = walk(project);
  assert.ok(files.includes('.claude/agents/rtosv3-drvport-bys-architect.md'));
  assert.ok(files.includes('.claude/skills/rtosv3-drvport-workflow/SKILL.md'));
  assert.ok(files.includes('.codex/agents/rtosv3-drvport-bys-architect.toml'));
  assert.ok(files.includes('.agents/agent-native/rtosv3-drvport/roles.json'));
  assert.equal(existsSync(join(project, '.r2c/engine')), false, 'agent-native never installs a runtime');
  assert.equal(existsSync(join(project, '.r2c/bin/r2c.js')), false, 'agent-native never writes a launcher');

  const receipt = JSON.parse(readFileSync(join(project, `.r2c/install/receipts/agent-native/${BUNDLE_ID}.json`), 'utf8'));
  assert.deepEqual(receipt.host_targets, ['claude-code', 'codex']);
  assert.equal(reportOk(project), true);
});

test('a tampered asset fails with zero writes and no engine left behind', (t) => {
  const { base, tagDir } = buildMirror(t);
  const engine = readdirSync(tagDir).find((name) => /^r2c-engine-.*\.tgz$/.test(name));
  assert.ok(engine);
  const file = join(tagDir, engine);
  const bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(file, bytes);

  const project = tempDir(t, 'project-tampered');
  const env = cleanEnv(tempDir(t, 'home-tampered'));
  const result = bootstrap([
    '--bundle', BUNDLE_ID,
    '--version', VERSION,
    '--projection', 'r2c',
    '--project', project,
    '--release-base', base,
  ], { env, cwd: project });
  assert.notEqual(result.status, 0);
  assert.deepEqual(walk(project), []);
});

function reportOk(project) {
  const report = doctor(project);
  return report.checks.every((check) => check.status !== 'fail');
}
