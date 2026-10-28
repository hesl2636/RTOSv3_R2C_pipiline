#!/usr/bin/env node
/**
 * The only release packager (#17 §7).
 *
 * `node scripts/release.mjs` writes `dist/r2c-plugin-<V>.tgz` plus
 * `dist/SHA256SUMS.txt`. The container is deterministic (sorted ustar entries,
 * fixed metadata, gzip mtime 0), so repeated builds of the same tree are
 * byte-identical.
 *
 * `--check` asserts the contract before anything is published: one locked-step
 * version (`package.json.version`), the same `^V` engine range in the payload
 * manifest and all five `adapter.json` files, the payload file whitelist, the
 * `docs/compat.md` view, the npm `files` whitelist, the lockfile, and the
 * fixture/workflow yaml counts.
 *
 * `--compat` regenerates `docs/compat.md` from the same adapter data.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_MANIFEST,
  buildPluginManifest,
  collectPayload,
  createTarGz,
  hashPayloadFiles,
  manifestBuffer,
  sha256,
} from '../src/plugin.js';
import { isValidRange, isValidVersion } from '../src/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_IDS = Object.freeze(['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
const NPM_FILES = Object.freeze(['bin/', 'src/', 'schema/', 'README.md', 'LICENSE']);
const WORKFLOW_PATTERN = /(^|\/)workflows\/[^/]+\.yaml$/;

function usage(message) {
  if (message) process.stderr.write(`release: ${message}\n`);
  process.stderr.write(
    'usage: node scripts/release.mjs [--out DIR] | --check | --compat\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { check: false, compat: false, out: join(ROOT, 'dist') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--compat') options.compat = true;
    else if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--out requires a directory');
      options.out = resolve(process.cwd(), value);
      index += 1;
    } else usage(`unknown argument: ${arg}`);
  }
  if (options.check && options.compat) usage('--check and --compat are mutually exclusive');
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

function loadAdapter(root, id) {
  const file = join(root, 'adapters', id, 'adapter.json');
  if (!existsSync(file)) return null;
  return readJson(file);
}

function load(ctx) {
  const pkg = readJson(join(ctx.root, 'package.json'));
  if (pkg === null) {
    process.stderr.write(`release: cannot read ${join(ctx.root, 'package.json')}\n`);
    process.exit(1);
  }
  const adapters = [];
  for (const id of ADAPTER_IDS) {
    const adapter = loadAdapter(ctx.root, id);
    if (adapter !== null) adapters.push(adapter);
  }
  const payload = collectPayload(ctx.root);
  const manifest =
    typeof pkg.version === 'string'
      ? buildPluginManifest({ version: pkg.version, files: hashPayloadFiles(payload.files) })
      : null;
  return { ...ctx, pkg, adapters, payload, manifest };
}

function workflowFiles(root) {
  if (existsSync(join(root, '.git'))) {
    const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) {
      return result.stdout.split('\0').filter((file) => file !== '' && WORKFLOW_PATTERN.test(file));
    }
  }
  const found = [];
  const walk = (dir, relDir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (WORKFLOW_PATTERN.test(rel)) found.push(rel);
    }
  };
  walk(root, '');
  return found.sort();
}

function fixtureCount(root) {
  const dir = join(root, 'src', 'acceptance', 'fixture');
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter((name) => name.endsWith('.yaml')).length;
}

function escapePipe(value) {
  return String(value).replaceAll('|', '\\|');
}

function generateCompat({ pkg, adapters }) {
  const version = pkg.version;
  const engine = `^${version}`;
  const lines = [
    '# Compatibility matrix',
    '',
    'Generated from `package.json` and `adapters/*/adapter.json` by',
    '`node scripts/release.mjs --compat`. Do not edit by hand:',
    '`node scripts/release.mjs --check` fails when this file drifts.',
    '',
    '| Dimension | Object | Range |',
    '| --- | --- | --- |',
    `| Version | \`r2c-runner\`, \`r2c-plugin-${version}.tgz\`, adapters | \`${version}\` |`,
    `| Engine ↔ payload | \`${PLUGIN_MANIFEST}.engine\` | \`${engine}\` |`,
    ...adapters.map(
      (adapter) =>
        `| Engine ↔ adapter | \`adapters/${adapter.id}/adapter.json\` | \`${adapter.requires?.engine ?? ''}\` |`,
    ),
    ...adapters.map(
      (adapter) =>
        `| Agent | \`${adapter.id}\` (${adapter.title ?? adapter.id}) | \`${adapter.requires?.agent ?? ''}\` |`,
    ),
    `| Node | \`r2c-runner\` | \`${escapePipe(pkg.engines?.node ?? '')}\` |`,
    '',
  ];
  return lines.join('\n');
}

function checkPayloadProblems(ctx, failures) {
  for (const problem of ctx.payload.problems) failures.push(problem);
  if (ctx.payload.files.length === 0) failures.push('payload file set is empty');
  for (const file of ctx.payload.files) {
    if (file.rel === PLUGIN_MANIFEST) failures.push(`${PLUGIN_MANIFEST} is generated, not a payload input`);
    if (/^(test|tests|docs|plugins|scripts|node_modules|dist)\//.test(file.rel)) {
      failures.push(`payload must not ship ${file.rel}`);
    }
    if (file.rel === 'package.json' || file.rel === 'package-lock.json') {
      failures.push(`payload must not ship ${file.rel}`);
    }
  }
}

function checkVersion(ctx, failures) {
  const { pkg, adapters, manifest } = ctx;
  const version = pkg.version;
  if (typeof version !== 'string' || !isValidVersion(version)) {
    failures.push(`package.json version is not a valid version: ${version}`);
    return;
  }
  const engine = `^${version}`;
  if (manifest === null || manifest.engine !== engine) {
    failures.push(`${PLUGIN_MANIFEST} engine would be "${manifest?.engine}" but package.json ${version} implies "${engine}"`);
  }
  if (adapters.length !== ADAPTER_IDS.length) {
    failures.push(`expected ${ADAPTER_IDS.length} adapters, found ${adapters.length}`);
  }
  const present = adapters.map((adapter) => adapter.id).sort();
  if (JSON.stringify(present) !== JSON.stringify([...ADAPTER_IDS].sort())) {
    failures.push(`adapter ids differ from the contract: ${present.join(', ')}`);
  }
  for (const id of ADAPTER_IDS) {
    const adapter = adapters.find((entry) => entry.id === id);
    if (adapter === undefined) {
      failures.push(`adapters/${id}/adapter.json is missing`);
      continue;
    }
    const declared = adapter.requires?.engine;
    if (declared !== engine) {
      failures.push(
        `adapters/${id}/adapter.json requires.engine is "${declared}" but must equal "${engine}" byte-for-byte`,
      );
    }
    if (!isValidRange(declared)) {
      failures.push(`adapters/${id}/adapter.json requires.engine is not a valid range: ${declared}`);
    }
    if (!isValidRange(adapter.requires?.agent)) {
      failures.push(`adapters/${id}/adapter.json requires.agent is not a valid range: ${adapter.requires?.agent}`);
    }
  }
}

function checkFiles(ctx, failures) {
  const { pkg, payload, manifest } = ctx;
  if (JSON.stringify(pkg.files) !== JSON.stringify(NPM_FILES)) {
    failures.push(
      `package.json files whitelist drifted: ${JSON.stringify(pkg.files)} != ${JSON.stringify(NPM_FILES)}`,
    );
  }
  if (manifest === null) return;
  const declared = Object.keys(manifest.files);
  const expected = payload.files.map((file) => file.rel);
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    const missing = expected.filter((rel) => !declared.includes(rel));
    const extra = declared.filter((rel) => !expected.includes(rel));
    failures.push(
      `${PLUGIN_MANIFEST}.files does not match the payload contract (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }
}

function checkDocs(ctx, failures) {
  const file = join(ctx.root, 'docs', 'compat.md');
  if (!existsSync(file)) {
    failures.push('docs/compat.md is missing (run node scripts/release.mjs --compat)');
    return;
  }
  const expected = generateCompat(ctx);
  if (readFileSync(file, 'utf8') !== expected) {
    failures.push('docs/compat.md does not match adapter.json engine/agent ranges (run --compat)');
  }
}

function checkLockfile(ctx, failures) {
  const file = join(ctx.root, 'package-lock.json');
  if (!existsSync(file)) {
    failures.push('package-lock.json is missing');
    return;
  }
  const lock = readJson(file);
  if (lock === null) {
    failures.push('package-lock.json is not valid JSON');
    return;
  }
  const version = ctx.pkg.version;
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    failures.push(`package-lock.json version ${lock.version} does not match package.json ${version}`);
  }
}

function checkCounts(ctx, failures, notes) {
  const fixtures = fixtureCount(ctx.root);
  if (fixtures === null) {
    notes.push('src/acceptance/fixture is not present yet (#35); fixture count is enforced once it lands');
  } else if (fixtures !== 1) {
    failures.push(`expected exactly one fixture yaml in src/acceptance/fixture, found ${fixtures}`);
  }
  const workflows = workflowFiles(ctx.root);
  if (workflows.length !== 1) {
    failures.push(`expected exactly one tracked workflows/*.yaml, found ${workflows.length}: ${workflows.join(', ')}`);
  }
}

function check(ctx) {
  const failures = [];
  const notes = [];
  checkPayloadProblems(ctx, failures);
  checkVersion(ctx, failures);
  checkFiles(ctx, failures);
  checkDocs(ctx, failures);
  checkLockfile(ctx, failures);
  checkCounts(ctx, failures, notes);

  if (failures.length > 0) {
    process.stderr.write(`release --check failed for r2c ${ctx.pkg.version ?? '?'}:\n`);
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `release --check ok: r2c ${ctx.pkg.version}, engine ^${ctx.pkg.version}, ${ctx.payload.files.length} payload files\n`,
  );
  for (const note of notes) process.stdout.write(`note: ${note}\n`);
}

function build(ctx, outDir) {
  if (ctx.payload.problems.length > 0) {
    process.stderr.write('release: refusing to build an invalid payload:\n');
    for (const problem of ctx.payload.problems) process.stderr.write(`- ${problem}\n`);
    process.exit(1);
  }
  if (ctx.manifest === null || Object.keys(ctx.manifest.files).length !== ctx.payload.files.length) {
    process.stderr.write('release: payload manifest does not cover every payload file\n');
    process.exit(1);
  }

  const entries = ctx.payload.files.map((file) => ({
    path: file.rel,
    data: readFileSync(file.absolute),
  }));
  entries.push({ path: PLUGIN_MANIFEST, data: manifestBuffer(ctx.manifest) });
  const archive = createTarGz(entries);

  mkdirSync(outDir, { recursive: true });
  const asset = `r2c-plugin-${ctx.pkg.version}.tgz`;
  const archivePath = join(outDir, asset);
  writeFileSync(archivePath, archive);
  const digest = sha256(archive);
  const sumsPath = join(outDir, 'SHA256SUMS.txt');
  writeFileSync(sumsPath, `${digest}  ${asset}\n`);

  process.stdout.write(`payload ${ctx.pkg.version}: ${ctx.payload.files.length + 1} files\n`);
  process.stdout.write(`archive ${archivePath}\n`);
  process.stdout.write(`sha256 ${digest}\n`);
  process.stdout.write(`sums ${sumsPath}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.compat) {
  const ctx = load({ root: ROOT });
  const file = join(ROOT, 'docs', 'compat.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, generateCompat(ctx));
  process.stdout.write(`wrote ${file}\n`);
} else {
  const ctx = load({ root: ROOT });
  if (options.check) check(ctx);
  else build(ctx, options.out);
}
