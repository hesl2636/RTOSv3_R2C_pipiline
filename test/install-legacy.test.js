/**
 * #94 refusal paths: legacy receipts, invalid results and the retired
 * `r2c.plugin/v1` / `.r2c/payload/` channel.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { installProjection } from '../installer/install.js';
import { uninstallProjection } from '../installer/uninstall.js';
import { cloneResult, fixedClock, sample } from './helpers/install-fixture.js';

const CLOCK = fixedClock();

function tempProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, out);
    else out.push(relative(root, absolute).split('\\').join('/'));
  }
  return out.sort();
}

function writeLegacyReceipt(projectRoot) {
  const dir = join(projectRoot, '.r2c/install');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude.json'), `${JSON.stringify({
    schema: 'r2c.install/v1',
    adapter: 'claude',
    scope: 'project',
    project_root: projectRoot,
    files: [],
    installed_at: '2025-01-01T00:00:00.000Z',
  }, null, 2)}\n`);
}

test('a legacy r2c.install/v1 receipt refuses a new install with a migration hint', (t) => {
  const projectRoot = tempProject(t);
  writeLegacyReceipt(projectRoot);
  const before = walk(projectRoot);
  const { result, irBytes } = sample('r2c');

  const outcome = installProjection({ result, irBytes, projectRoot, force: true, clock: CLOCK });
  assert.equal(outcome.code, 'LEGACY_INSTALL_PRESENT');
  assert.deepEqual(outcome.legacy.map((item) => item.path), ['.r2c/install/claude.json']);
  assert.match(outcome.hint, /--migrate-legacy/);
  assert.deepEqual(walk(projectRoot), before);
});

test('a legacy receipt also blocks uninstall (the receipt is the only plan)', (t) => {
  const projectRoot = tempProject(t);
  writeLegacyReceipt(projectRoot);
  const outcome = uninstallProjection({ projectRoot, projectionId: 'r2c', bundleId: 'x', clock: CLOCK });
  assert.equal(outcome.code, 'LEGACY_INSTALL_PRESENT');
});

test('r2c.plugin/v1 is neither read nor written and no .r2c/payload appears', (t) => {
  const projectRoot = tempProject(t);
  const pluginDir = join(projectRoot, '.r2c');
  mkdirSync(pluginDir, { recursive: true });
  const plugin = `${JSON.stringify({ schema: 'r2c.plugin/v1', payload: { version: '0.0.0', files: [] } }, null, 2)}\n`;
  writeFileSync(join(pluginDir, 'plugin.json'), plugin);
  const { result, irBytes } = sample('r2c');

  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'OK');
  assert.equal(readFileSync(join(projectRoot, '.r2c/plugin.json'), 'utf8'), plugin);
  assert.equal(existsSync(join(projectRoot, '.r2c/payload')), false);
});

test('an invalid result is refused before any write, even in dry-run', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const broken = cloneResult(result);
  [broken.capabilityReport[0], broken.capabilityReport[1]] = [broken.capabilityReport[1], broken.capabilityReport[0]];

  for (const dryRun of [false, true]) {
    const outcome = installProjection({ result: broken, irBytes, projectRoot, dryRun, clock: CLOCK });
    assert.equal(outcome.code, 'PROJECTION_RESULT_INVALID');
    assert.ok(outcome.diagnostics.length > 0);
    assert.ok(outcome.diagnostics.every((diagnostic) => diagnostic.code === 'PROJECTION_RESULT_INVALID'));
    assert.deepEqual(walk(projectRoot), []);
  }
});

test('a result with ok:false is refused like any other invalid result', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const broken = cloneResult(result);
  broken.ok = false;
  const outcome = installProjection({ result: broken, irBytes, projectRoot, clock: CLOCK });
  assert.equal(outcome.code, 'PROJECTION_RESULT_INVALID');
  assert.deepEqual(walk(projectRoot), []);
});

test('a receipt with an unknown schema is reported, not silently replaced', (t) => {
  const projectRoot = tempProject(t);
  const { result, irBytes } = sample('r2c');
  const dir = join(projectRoot, '.r2c/install/receipts/r2c');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stale.json'), '{"schema":"r2c.install/v9"}\n');
  const outcome = installProjection({ result, irBytes, projectRoot, clock: CLOCK });
  // The unknown receipt owns nothing, so the install proceeds and leaves it.
  assert.equal(outcome.code, 'OK');
  assert.equal(readFileSync(join(dir, 'stale.json'), 'utf8'), '{"schema":"r2c.install/v9"}\n');
});
