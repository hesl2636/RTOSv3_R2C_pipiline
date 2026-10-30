/**
 * Documentation contract (#17 §1, §7, §8; ticket #36).
 *
 * Three docs are user-facing contracts, so they are tested like code:
 * `docs/install.md` (install → doctor → upgrade → rollback → uninstall),
 * `docs/compat.md` (generated from `adapter.json`, never hand-edited) and
 * `docs/blue-zone/preflight.md` (exactly 47 rows, each with five fields).
 * `README.md` is deliberately free-form and is not pinned by wording tests.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_IDS = ['claude-code', 'codex', 'dsh', 'omp', 'opencode'];
const PREFLIGHT_IDS = [
  ...Array.from({ length: 14 }, (_, index) => `A${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `B${index + 1}`),
  ...Array.from({ length: 15 }, (_, index) => `C${index + 1}`),
  ...Array.from({ length: 6 }, (_, index) => `D${index + 1}`),
];
const VERDICTS = ['pass', 'fail', 'risk', 'HITL', 'unverified'];

/**
 * Yellow-zone coordinates and non-public registry names must never reach a
 * blue-zone entry point. Each entry is [label, pattern] so a failure names the
 * literal instead of printing a whole file.
 */
const FORBIDDEN = [
  ['--plugin-root', /--plugin-root/],
  ['--legacy-plugin-root', /--legacy-plugin-root/],
  ['CodeAgent CLI', /codeagent/i],
  ['CODEAGENT environment variables', /CODEAGENT/],
  ['retired per-user state directory', /\.cac\b/],
  ['LEGACY_NPM_REGISTRY_URL', /LEGACY_NPM_REGISTRY_URL/],
  ['legacy tag', /legacy-yellow-zone/],
  ['internal registry name', /\b(nexus|artifactory|verdaccio|npmmirror)\b/i],
  ['plain-http URL', /http:\/\//],
];

function read(rel) {
  return readFileSync(join(REPO, rel), 'utf8');
}

function adapter(id) {
  return JSON.parse(read(`adapters/${id}/adapter.json`));
}

function section(text, heading) {
  const start = text.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

// --- docs/install.md ------------------------------------------------------

test('install doc covers install, detection, --from payload and doctor', () => {
  const install = read('docs/install.md');
  assert.match(install, /adapter install <agent> --from <payload-dir\|r2c-plugin-0\.1\.0\.tgz>/);
  assert.match(install, /## Payload: `--from <dir\|tgz>`/);
  assert.match(install, /AGENT_NOT_DETECTED/);
  assert.match(install, /## Doctor/);
  for (const id of ADAPTER_IDS) {
    assert.ok(install.includes(`adapter install <agent>`), 'install doc must install adapters');
    assert.ok(install.includes(`\`${id}\``), `install doc is missing adapter ${id}`);
  }
});

test('install doc covers upgrade with payload version = engine version', () => {
  const upgrade = section(read('docs/install.md'), '## Upgrade');
  assert.match(upgrade, /Re-run `adapter install <agent>`/);
  assert.match(upgrade, /payload version defaults to\s+the engine version/);
  assert.match(upgrade, /adapter doctor/);
  assert.match(upgrade, /no-op/);
});

test('install doc defines rollback as old engine + old payload, not PATH', () => {
  const rollback = section(read('docs/install.md'), '## Rollback');
  assert.match(rollback, /--from <old-payload-dir\|r2c-plugin-<old-V>\.tgz> --force/);
  assert.match(rollback, /--plugin <old-V>/);
  assert.match(rollback, /Pointing `PATH` back at an older engine is not a rollback/);
  assert.match(rollback, /doctor/);
});

test('install doc covers uninstall and --purge-state semantics', () => {
  const uninstall = section(read('docs/install.md'), '## Uninstall');
  assert.match(uninstall, /adapter uninstall <agent>/);
  assert.match(uninstall, /--purge-state/);
  assert.match(uninstall, /is \*\*kept\*\* by default/);
  assert.match(uninstall, /receipt/);
});

test('install doc states that B and C have no runtime guard', () => {
  const install = read('docs/install.md');
  assert.match(install, /## B and C have no runtime guard/);
  assert.match(install, /cannot intercept tool calls/);
  assert.match(install, /`hooks` trust|`\/hooks` trust/);
});

test('install doc lists per-scope landing paths for every adapter', () => {
  const install = read('docs/install.md');
  for (const id of ADAPTER_IDS) {
    assert.ok(install.includes(`\`${id}\``), `install doc is missing adapter ${id}`);
  }
  assert.match(install, /--scope user/);
  assert.match(install, /~\/\.claude\//);
  assert.match(install, /~\/\.dsh\//);
  assert.match(install, /~\/\.omp\//);
  assert.match(install, /~\/\.config\/opencode\//);
});

// --- forbidden literals ---------------------------------------------------

test('README and install doc contain no yellow-zone or internal-registry literals', () => {
  for (const rel of ['README.md', 'docs/install.md']) {
    const text = read(rel);
    for (const [label, pattern] of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${rel} contains ${label}`);
    }
    const registryHosts = text.match(/registry\.[a-z0-9.-]+/gi) ?? [];
    for (const host of registryHosts) {
      assert.equal(host.toLowerCase(), 'registry.npmjs.org', `${rel} names a non-public registry: ${host}`);
    }
  }
});

// --- docs/compat.md -------------------------------------------------------

test('compat matrix matches every adapter.json engine and agent range', () => {
  const compat = read('docs/compat.md');
  assert.match(compat, /^# Compatibility matrix\n/);
  assert.match(compat, /node scripts\/release\.mjs --compat/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    compat.includes(`| Version | \`r2c-runner\`, \`r2c-plugin-${pkg.version}.tgz\`, adapters | \`${pkg.version}\` |`),
    'compat matrix version row drifted from package.json',
  );
  for (const id of ADAPTER_IDS) {
    const declaration = adapter(id);
    const engineRow = compat
      .split('\n')
      .find((line) => line.startsWith(`| Engine ↔ adapter |`) && line.includes(`adapters/${id}/adapter.json`));
    assert.ok(engineRow, `compat matrix has no engine row for ${id}`);
    assert.ok(
      engineRow.endsWith(`| \`${declaration.requires.engine}\` |`),
      `compat matrix engine range for ${id} is not adapter.json's ${declaration.requires.engine}`,
    );
    const agentRow = compat.split('\n').find((line) => line.startsWith(`| Agent | \`${id}\` (`));
    assert.ok(agentRow, `compat matrix has no agent row for ${id}`);
    assert.ok(
      agentRow.endsWith(`| \`${declaration.requires.agent}\` |`),
      `compat matrix agent range for ${id} is not adapter.json's ${declaration.requires.agent}`,
    );
  }
  const nodeRow = compat.split('\n').find((line) => line.startsWith('| Node | `r2c-runner` |'));
  assert.ok(nodeRow, 'compat matrix has no Node row');
  assert.ok(nodeRow.includes('>=22.19.0 <23 \\|\\| >=24.0.0'), 'compat Node row drifted from engines.node');
});

// --- docs/blue-zone/preflight.md -----------------------------------------

function preflightRows() {
  const text = read('docs/blue-zone/preflight.md');
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\|\s*([ABCD]\d+)\s*\|/.exec(line);
    if (match === null) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    // '' | ID | date | command | output | verdict | executor | ''
    rows.push({ id: match[1], cells });
  }
  return rows;
}

test('preflight records exactly the 47 contract rows', () => {
  const rows = preflightRows();
  assert.equal(rows.length, 47, `expected 47 preflight rows, found ${rows.length}`);
  assert.deepEqual(
    rows.map((row) => row.id),
    PREFLIGHT_IDS,
    'preflight rows must be A1-A14, B1-B12, C1-C15, D1-D6 in order',
  );
  assert.equal(new Set(rows.map((row) => row.id)).size, 47, 'preflight ids must be unique');
});

test('every preflight row carries date, command, output, verdict and executor', () => {
  const rows = preflightRows();
  for (const { id, cells } of rows) {
    assert.equal(cells.length, 8, `row ${id} must have exactly six columns (ID + five fields)`);
    const [, , date, command, output, verdict, executor] = cells;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `row ${id} has no ISO date`);
    assert.ok(command.length > 0 && command !== '-', `row ${id} has no command text`);
    assert.ok(output.length > 0 && output !== '-', `row ${id} has no recorded output`);
    const token = verdict.split(/[\s(（]/)[0];
    assert.ok(VERDICTS.includes(token), `row ${id} verdict "${verdict}" is not one of ${VERDICTS.join('/')}`);
    assert.ok(executor.length > 0 && executor !== '-', `row ${id} has no executor`);
  }
});

test('preflight names the HITL blockers in a summary block', () => {
  const text = read('docs/blue-zone/preflight.md');
  assert.match(text, /## HITL blockers/);
  const summary = text.slice(text.indexOf('## HITL blockers'));
  for (const id of ['A1', 'A2', 'A3', 'A11', 'A12', 'A13', 'A14', 'B2', 'B8', 'B9', 'C6']) {
    assert.ok(summary.includes(id), `HITL summary does not list ${id}`);
  }
});

// --- links ----------------------------------------------------------------

function markdownLinkTargets(rel) {
  const text = read(rel);
  const base = dirname(join(REPO, rel));
  const targets = [];
  const pattern = /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1].split('#')[0];
    if (target === '') continue;
    targets.push({ target, absolute: resolve(base, target) });
  }
  return targets;
}

function markdownFiles() {
  const files = ['README.md'];
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) files.push(rel);
    }
  };
  walk('docs');
  walk('adapters');
  return files;
}

test('every relative markdown link resolves', () => {
  for (const rel of markdownFiles()) {
    assert.ok(existsSync(join(REPO, rel)), `${rel} is missing`);
    for (const { target, absolute } of markdownLinkTargets(rel)) {
      assert.ok(existsSync(absolute), `${rel} links to missing ${target}`);
    }
  }
});
