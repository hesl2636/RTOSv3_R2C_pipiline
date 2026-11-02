/**
 * #104 installer status (no run) and doctor failure modes.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { doctor } from '../installer/doctor.js';
import { installR2cProject } from '../installer/r2c.js';
import { installRuntime } from '../installer/runtime.js';
import { formatStatus, installStatus } from '../installer/status.js';
import { fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempDir(t, prefix = 'r2c-status-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeEngineSource(root, version = '1.2.3') {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'r2c.js'), `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log(${JSON.stringify(version)})\n`);
  mkdirSync(join(root, 'commands'), { recursive: true });
  writeFileSync(join(root, 'commands', 'r2c-status.md'), `---\ndescription: status\n---\n\n<runner> status\n`);
  return root;
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, out);
    else if (entry.isFile()) out.push(relative(root, absolute).split('\\').join('/'));
  }
  return out.sort();
}

function installedProject(t, { runtime = true } = {}) {
  const projectRoot = tempDir(t, 'r2c-project-');
  const { result, irBytes } = sample('r2c');
  const bundle = installR2cProject({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(bundle.code, 'OK', bundle.message);
  if (runtime) {
    const source = writeEngineSource(tempDir(t, 'r2c-engine-'));
    const outcome = installRuntime({ projectRoot, engineSource: source, engineVersion: '1.2.3', clock: CLOCK });
    assert.equal(outcome.code, 'OK', outcome.message);
  }
  return { projectRoot, result, bundle };
}

function check(report, id) {
  const found = report.checks.find((item) => item.id === id);
  assert.ok(found, `missing doctor check ${id}: ${report.checks.map((item) => item.id).join(', ')}`);
  return found;
}

test('installer status works without a run and reports install, engine and manifest selection', (t) => {
  const { projectRoot, result } = installedProject(t);
  const status = installStatus(projectRoot);
  assert.equal(status.schema, 'r2c.install-status/v1');
  assert.equal(status.installs.length, 1);
  const [install] = status.installs;
  assert.equal(install.projection, 'r2c');
  assert.equal(install.bundle, result.ir.id);
  assert.equal(install.version, result.ir.version);
  assert.equal(install.mode, 'fresh');
  assert.deepEqual(install.targets, ['claude-code', 'codex', 'omp', 'opencode']);
  assert.equal(install.receipt, `.r2c/install/receipts/r2c/${result.ir.id}.json`);
  assert.equal(install.files, install.receiptFiles);
  assert.deepEqual(install.problems, []);

  assert.deepEqual(status.engine, {
    version: '1.2.3',
    entry: '.r2c/engine/1.2.3/bin/r2c.js',
    ok: true,
  });
  assert.deepEqual(status.manifest, {
    selection: 'single',
    path: `workflows/${result.ir.id}.yaml`,
    candidates: [`workflows/${result.ir.id}.yaml`],
  });
  assert.equal(status.journal, null);

  const text = formatStatus(status);
  assert.match(text, new RegExp(`^install/r2c/${result.ir.id} ${result.ir.version} targets=claude-code,codex,omp,opencode files=\\d+$`, 'm'));
  assert.match(text, /^engine\/1\.2\.3$/m);
  assert.match(text, new RegExp(`^manifest/workflows/${result.ir.id}\\.yaml$`, 'm'));
});

test('installer status on an empty project is stable', (t) => {
  const projectRoot = tempDir(t, 'r2c-empty-');
  const status = installStatus(projectRoot);
  assert.deepEqual(status.installs, []);
  assert.equal(status.engine, null);
  assert.deepEqual(status.manifest, { selection: 'missing', path: null, candidates: [] });
  assert.equal(status.journal, null);
  const text = formatStatus(status);
  assert.match(text, /^manifest\/missing$/m);
});

test('installer status reports ambiguous manifests and unsupported receipts', (t) => {
  const { projectRoot, result } = installedProject(t);
  writeFileSync(join(projectRoot, 'workflows', 'second.yaml'), 'schema: r2c.workflow/v1\nid: second\nversion: 0.1.0\nstages: []\n');
  const badDir = join(projectRoot, '.r2c/install/receipts/r2c');
  writeFileSync(join(badDir, 'unknown.json'), canonicalJson({ schema: 'r2c.install/v9', projection: { id: 'r2c' }, bundle: { id: 'unknown' } }));

  const status = installStatus(projectRoot);
  assert.equal(status.manifest.selection, 'ambiguous');
  assert.deepEqual(status.manifest.candidates, [`workflows/${result.ir.id}.yaml`, 'workflows/second.yaml']);
  assert.equal(status.manifest.path, null);
  const unsupported = status.installs.find((install) => install.bundle === 'unknown');
  assert.equal(unsupported.schema, 'r2c.install/v9');
  assert.equal(unsupported.supported, false);
  assert.deepEqual(unsupported.problems, ['SCHEMA_UNSUPPORTED']);
});

test('doctor passes a clean r2c install with exactly one workflow manifest', (t) => {
  const { projectRoot, result } = installedProject(t);
  const report = doctor(projectRoot, { clock: CLOCK });
  assert.equal(report.schema, 'r2c.doctor/v1');
  assert.equal(report.ok, true, report.checks.filter((item) => item.status === 'fail').map((item) => item.id).join(', '));
  assert.equal(check(report, 'receipt:r2c').status, 'pass');
  assert.equal(check(report, 'engine.entry').status, 'pass');
  assert.equal(check(report, 'engine.launcher').status, 'pass');
  assert.equal(check(report, 'engine.version').status, 'pass');
  assert.equal(check(report, 'manifest.selection').status, 'pass');
  assert.equal(check(report, 'transaction.residue').status, 'pass');
  const files = readdirSync(join(projectRoot, 'workflows')).filter((name) => name.endsWith('.yaml'));
  assert.deepEqual(files, [`${result.ir.id}.yaml`]);
  const summary = check(report, 'summary');
  assert.equal(summary.status, 'info');
  assert.match(summary.message, /degradation/);
  assert.match(summary.message, /placeholder/);
});

test('doctor fails on a modified receipt-owned file and on a missing file', (t) => {
  const { projectRoot, result } = installedProject(t);
  const receipt = JSON.parse(readFileSync(join(projectRoot, `.r2c/install/receipts/r2c/${result.ir.id}.json`), 'utf8'));
  const roleFile = receipt.files.find((file) => file.path.startsWith('.claude/agents/')).path;
  const missing = receipt.files.find((file) => file.path.startsWith('.opencode/agents/')).path;

  writeFileSync(join(projectRoot, ...roleFile.split('/')), 'tampered\n');
  unlinkSync(join(projectRoot, ...missing.split('/')));

  const report = doctor(projectRoot, { clock: CLOCK });
  assert.equal(report.ok, false);
  const receiptCheck = check(report, 'receipt:r2c');
  assert.equal(receiptCheck.status, 'fail');
  assert.ok(receiptCheck.details.mismatched.some((item) => item.path === roleFile));
  assert.ok(receiptCheck.details.missing.some((item) => item.path === missing));
});

test('doctor fails when the engine entry, launcher or manifest selection is broken', (t) => {
  const { projectRoot, result } = installedProject(t);
  unlinkSync(join(projectRoot, '.r2c/bin/r2c.js'));
  writeFileSync(join(projectRoot, 'workflows', 'second.yaml'), 'schema: r2c.workflow/v1\nid: second\nversion: 0.1.0\nstages: []\n');

  const report = doctor(projectRoot, { clock: CLOCK });
  assert.equal(report.ok, false);
  assert.equal(check(report, 'engine.launcher').status, 'fail');
  assert.equal(check(report, 'manifest.selection').status, 'fail');

  // Recreate the launcher but break the engine entry; the version probe fails too.
  const launcher = check(report, 'engine.launcher').details;
  assert.ok(Array.isArray(launcher.problems));
  writeFileSync(join(projectRoot, '.r2c/bin/r2c.js'), readFileSync(join(projectRoot, 'workflows', `${result.ir.id}.yaml`)) ? '#!/usr/bin/env node\n' : '');
  unlinkSync(join(projectRoot, '.r2c/engine/1.2.3/bin/r2c.js'));
  const second = doctor(projectRoot, { clock: CLOCK });
  assert.equal(second.ok, false);
  assert.equal(check(second, 'engine.entry').status, 'fail');
  assert.equal(check(second, 'engine.launcher').status, 'fail');
});

test('doctor reports transaction residue and extra files without deleting anything', (t) => {
  const { projectRoot, result } = installedProject(t);
  mkdirSync(join(projectRoot, '.r2c/install'), { recursive: true });
  writeFileSync(join(projectRoot, '.r2c/install/pending.json'), canonicalJson({
    schema: 'r2c.install-journal/v1',
    command: 'install',
    state: 'pending',
    operations: [],
    created_dirs: [],
    receipts_written: [],
  }));
  writeFileSync(join(projectRoot, 'tasks', 'extra.md'), '# extra\n');

  const report = doctor(projectRoot, { clock: CLOCK });
  assert.equal(check(report, 'transaction.residue').status, 'warn');
  assert.equal(check(report, 'extra.files').status, 'warn');
  assert.ok(check(report, 'extra.files').details.extra.includes('tasks/extra.md'));
  assert.equal(existsSync(join(projectRoot, 'tasks/extra.md')), true, 'doctor is read-only');
  assert.equal(existsSync(join(projectRoot, '.r2c/install/pending.json')), true);

  writeFileSync(join(projectRoot, '.r2c/install/pending.json'), canonicalJson({
    schema: 'r2c.install-journal/v1',
    command: 'install',
    state: 'rollback-failed',
    operations: [],
    created_dirs: [],
    receipts_written: [],
  }));
  const rolled = doctor(projectRoot, { clock: CLOCK });
  assert.equal(rolled.ok, false);
  assert.equal(check(rolled, 'transaction.residue').status, 'fail');
  assert.equal(result.ir.id.length > 0, true);
});

test('doctor reports host detection and missing roles.json', (t) => {
  const { projectRoot } = installedProject(t);
  unlinkSync(join(projectRoot, '.r2c/projection/roles.json'));
  const report = doctor(projectRoot, { clock: CLOCK });
  assert.equal(report.ok, false);
  assert.equal(check(report, 'roles.json').status, 'fail');
  const hosts = check(report, 'host.detection');
  assert.equal(hosts.status, 'info');
  assert.deepEqual(hosts.details.targets.map((item) => item.target), ['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
});

test('installer status reports cross-receipt ownership conflicts', (t) => {
  const { projectRoot, result } = installedProject(t);
  const receipt = JSON.parse(readFileSync(join(projectRoot, `.r2c/install/receipts/r2c/${result.ir.id}.json`), 'utf8'));
  const shared = receipt.files[0].path;
  const otherDir = join(projectRoot, '.r2c/install/receipts/agent-native');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'other.json'), canonicalJson({
    schema: 'r2c.install/v2',
    projection: { id: 'agent-native', version: '1.0.0', targets: ['claude-code'] },
    bundle: { id: 'other', version: '1.0.0' },
    host_targets: ['claude-code'],
    files: [{ path: shared, kind: 'agent', targets: ['claude-code'], sha256: '0'.repeat(64), mode: '0644', origin: 'projection' }],
  }));
  const status = installStatus(projectRoot);
  assert.ok(status.conflicts.some((conflict) => conflict.code === 'INSTALL_PATH_CONFLICT' && conflict.path === shared));
  const r2c = status.installs.find((install) => install.projection === 'r2c');
  assert.ok(r2c.problems.includes('INSTALL_PATH_CONFLICT'));
});
