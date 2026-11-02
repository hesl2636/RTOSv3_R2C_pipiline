#!/usr/bin/env node
/**
 * The only release packager (#17 §7, #44).
 *
 * `node scripts/release.mjs` writes exactly four assets into `--out`
 * (default `dist/`): `r2c-engine-<V>.tgz`, `r2c-payload-<V>.tgz`,
 * `install.mjs` (published byte-identical to `scripts/install.mjs`) and
 * `SHA256SUMS.txt` (one line per hashed asset). The engine asset is the
 * runnable CLI (sources, schema, `package.json`, the vendored `yaml` and
 * LICENSE); the payload asset is the adapter/workflow file set. Both use the
 * same container: deterministic (sorted ustar entries, fixed metadata, gzip
 * mtime 0), so repeated builds of the same tree are byte-identical.
 *
 * `--check` is the pre-publish gate, and it replaces the npm `files` whitelist
 * with the asset whitelist above: one locked-step version
 * (`package.json.version`), the same `^V` engine range in the payload manifest
 * and all five `adapter.json` files, the payload file whitelist, the
 * `docs/compat.md` view, the CHANGELOG section, the lockfile and the
 * fixture/workflow yaml counts. When the output directory holds a build, the
 * same run also verifies the four asset names, the sums coverage, the
 * byte-identical bootstrap and the whitelist/manifest of both archives — so a
 * bad package is caught locally instead of in CI.
 *
 * `--compat` regenerates `docs/compat.md` from the same adapter data.
 *
 * The bundle channel (#105, decision #74) lives in the same command:
 * `--bundle <zip|dir> --out DIR` writes the 6–8 per-bundle assets, and
 * `--bundle <zip|dir> --check [--out DIR] [--tag TAG]` is the pre-publish
 * gate. A bundle Release is self-contained: zip, IR, pre-projected payloads,
 * engine, framework, bootstrap and sums. `--bundle` never touches the legacy
 * `v<engine>` asset set. `--options FILE` packs a custom local selection (the
 * payload manifests record the actual options; only canonical builds are
 * publishable) and `--json` emits JSON-lines progress for the web child.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAYLOAD_MANIFEST,
  buildPayloadManifest,
  collectPayload,
  createTarGz,
  hashPayloadFiles,
  manifestBuffer,
  payloadAssetName,
  readTarGz,
  sha256,
} from '../src/plugin.js';
import { collectEngine, engineAssetName } from '../src/engine.js';
import { isValidRange, isValidVersion } from '../src/version.js';
import {
  buildBundleRelease,
  checkBundleRelease,
  describeBundleCheck,
} from './lib/bundle-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_IDS = Object.freeze(['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
const WORKFLOW_PATTERN = /(^|\/)workflows\/[^/]+\.yaml$/;
/** The bootstrap ships verbatim; `scripts/install.mjs` is its only source (#41). */
const BOOTSTRAP_SOURCE = 'scripts/install.mjs';
const INSTALL_ASSET = 'install.mjs';
const SUMS_ASSET = 'SHA256SUMS.txt';

/** The four asset names of one release at one version, sorted. */
function releaseAssets(version) {
  return [INSTALL_ASSET, engineAssetName(version), payloadAssetName(version), SUMS_ASSET].sort();
}

/** The assets `SHA256SUMS.txt` covers: everything except the sums file itself. */
function hashedAssets(version) {
  return releaseAssets(version).filter((name) => name !== SUMS_ASSET);
}

function usage(message) {
  if (message) process.stderr.write(`release: ${message}\n`);
  process.stderr.write(
    'usage: node scripts/release.mjs [--out DIR] | --check [--out DIR] | --compat\n'
    + '       node scripts/release.mjs --bundle <zip|dir> --out DIR [--tag TAG] [--options FILE] [--json]\n'
    + '       node scripts/release.mjs --bundle <zip|dir> --check [--out DIR] [--tag TAG]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    check: false,
    compat: false,
    out: join(ROOT, 'dist'),
    outSet: false,
    bundle: null,
    tag: null,
    optionsFile: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--compat') options.compat = true;
    else if (arg === '--bundle') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--bundle requires a zip or directory');
      options.bundle = resolve(process.cwd(), value);
      index += 1;
    } else if (arg === '--tag') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--tag requires a tag name');
      options.tag = value;
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--out requires a directory');
      options.out = resolve(process.cwd(), value);
      options.outSet = true;
      index += 1;
    } else if (arg === '--options') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--options requires a JSON file');
      options.optionsFile = resolve(process.cwd(), value);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else usage(`unknown argument: ${arg}`);
  }
  if (options.check && options.compat) usage('--check and --compat are mutually exclusive');
  if (options.compat && options.bundle !== null) usage('--compat and --bundle are mutually exclusive');
  if (options.tag !== null && options.bundle === null) usage('--tag only applies to --bundle');
  if (options.optionsFile !== null && options.bundle === null) usage('--options only applies to --bundle');
  if (options.optionsFile !== null && options.check) usage('--options is a build input, not a --check input');
  if (options.json && (options.bundle === null || options.check)) {
    usage('--json only applies to a --bundle build');
  }
  if (options.bundle !== null && !options.check && !options.outSet) {
    usage('--bundle requires --out DIR (a bundle Release never shares the legacy dist directory)');
  }
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
  const engine = collectEngine(ctx.root);
  const manifest =
    typeof pkg.version === 'string'
      ? buildPayloadManifest({ version: pkg.version, files: hashPayloadFiles(payload.files) })
      : null;
  return { ...ctx, pkg, adapters, payload, engine, manifest };
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
    `| Version | \`r2c-runner\`, \`r2c-payload-${version}.tgz\`, adapters | \`${version}\` |`,
    `| Engine ↔ payload | \`${PAYLOAD_MANIFEST}.engine\` | \`${engine}\` |`,
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
    if (file.rel === PAYLOAD_MANIFEST) failures.push(`${PAYLOAD_MANIFEST} is generated, not a payload input`);
    if (/^(test|tests|docs|plugins|scripts|node_modules|dist)\//.test(file.rel)) {
      failures.push(`payload must not ship ${file.rel}`);
    }
    if (file.rel === 'package.json' || file.rel === 'package-lock.json') {
      failures.push(`payload must not ship ${file.rel}`);
    }
  }
}

function checkEngine(ctx, failures) {
  for (const problem of ctx.engine.problems) failures.push(problem);
  if (ctx.engine.files.length === 0) failures.push('engine file set is empty');
  for (const file of ctx.engine.files) {
    if (/^(test|docs|scripts|pack|adapters|plugins|dist)\//.test(file.rel)) {
      failures.push(`engine must not ship ${file.rel}`);
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
    failures.push(`${PAYLOAD_MANIFEST} engine would be "${manifest?.engine}" but package.json ${version} implies "${engine}"`);
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
  const { payload, manifest } = ctx;
  if (manifest === null) return;
  const declared = Object.keys(manifest.files);
  const expected = payload.files.map((file) => file.rel);
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    const missing = expected.filter((rel) => !declared.includes(rel));
    const extra = declared.filter((rel) => !expected.includes(rel));
    failures.push(
      `${PAYLOAD_MANIFEST}.files does not match the payload contract (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
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

function checkChangelog(ctx, failures) {
  const file = join(ctx.root, 'CHANGELOG.md');
  if (!existsSync(file)) {
    failures.push('CHANGELOG.md is missing');
    return;
  }
  const heading = `## [${ctx.pkg.version}]`;
  if (!readFileSync(file, 'utf8').split(/\r?\n/).some((line) => line.startsWith(heading))) {
    failures.push(`CHANGELOG.md has no "${heading}" section`);
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

/** Compare two path sets; `null` when they match, otherwise the difference. */
function setDifference(actual, expected) {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  if (missing.length === 0 && extra.length === 0) return null;
  return `missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}`;
}

/**
 * The asset whitelist (#44). Source side: the four names of one release, one
 * bootstrap copy, nothing else. Built side (when `--out` holds a build): the
 * directory holds exactly those four, the sums cover every hashed asset, the
 * bootstrap is byte-identical, and both archives ship only their contract.
 *
 * Digests are `scripts/verify-sums.mjs`'s job: this gate is structural, so a
 * coverage failure is never masked by a digest failure.
 */
function checkAssets(ctx, failures) {
  const version = ctx.pkg.version;
  if (typeof version !== 'string' || !isValidVersion(version)) return;
  const expected = releaseAssets(version);
  const hashed = hashedAssets(version);
  if (new Set(expected).size !== expected.length) failures.push('release asset names collide');

  const bootstrap = join(ctx.root, BOOTSTRAP_SOURCE);
  if (!existsSync(bootstrap)) {
    failures.push(`the ${INSTALL_ASSET} asset has no source: ${BOOTSTRAP_SOURCE} is missing`);
  } else {
    const text = readFileSync(bootstrap, 'utf8');
    if (!text.startsWith('#!/usr/bin/env node')) {
      failures.push(`${BOOTSTRAP_SOURCE} must start with "#!/usr/bin/env node"`);
    }
    if (/from\s+['"]\.\.?\/src\//.test(text)) {
      failures.push(`${BOOTSTRAP_SOURCE} must be self-contained: no imports from src/`);
    }
  }
  if (existsSync(join(ctx.root, INSTALL_ASSET))) {
    failures.push(
      `${INSTALL_ASSET} exists at the repository root; the only bootstrap source is ${BOOTSTRAP_SOURCE}`,
    );
  }
  if (ctx.payload.problems.length > 0 || ctx.engine.problems.length > 0) return;
  if (ctx.manifest === null) return;

  const outDir = ctx.out;
  if (!existsSync(outDir)) return;
  const built = readdirSync(outDir).sort();
  if (built.length === 0) return;

  const difference = setDifference(built, expected);
  if (difference !== null) {
    failures.push(
      `${outDir} does not hold the release asset whitelist (${difference}); delete the directory or rebuild it with node scripts/release.mjs`,
    );
    return;
  }

  const sumsFile = join(outDir, SUMS_ASSET);
  if (!existsSync(sumsFile)) {
    failures.push(`${SUMS_ASSET} is missing from ${outDir}`);
  } else {
    const listed = readFileSync(sumsFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const match = /^[0-9a-f]{64} [ *](.+)$/.exec(line);
        if (match === null) failures.push(`${SUMS_ASSET} has a malformed line: ${line}`);
        return match === null ? null : match[1];
      })
      .filter((name) => name !== null)
      .sort();
    const sumsDifference = setDifference(listed, hashed);
    if (sumsDifference !== null) {
      failures.push(`${SUMS_ASSET} does not cover the asset whitelist (${sumsDifference})`);
    }
  }

  const installAsset = join(outDir, INSTALL_ASSET);
  if (existsSync(installAsset) && existsSync(bootstrap)) {
    if (!readFileSync(installAsset).equals(readFileSync(bootstrap))) {
      failures.push(`${INSTALL_ASSET} in ${outDir} is not byte-identical to ${BOOTSTRAP_SOURCE}`);
    }
  }

  checkArchiveWhitelist({
    failures,
    name: payloadAssetName(version),
    file: join(outDir, payloadAssetName(version)),
    expected: [...ctx.payload.files.map((file) => file.rel), PAYLOAD_MANIFEST],
    manifest: {
      expected: PAYLOAD_MANIFEST,
      describe: (manifest) => {
        if (manifest.version !== version) {
          return `payload version is ${manifest.version} but package.json is ${version}`;
        }
        if (manifest.engine !== `^${version}`) {
          return `payload engine is ${manifest.engine} but package.json ${version} implies ^${version}`;
        }
        return null;
      },
    },
  });

  checkArchiveWhitelist({
    failures,
    name: engineAssetName(version),
    file: join(outDir, engineAssetName(version)),
    expected: ctx.engine.files.map((file) => file.rel),
    manifest: {
      expected: 'package.json',
      describe: (manifest) =>
        manifest.version === version
          ? null
          : `engine package.json version is ${manifest.version} but package.json is ${version}`,
    },
  });
}

/** Member whitelist and embedded manifest/version lock of one built archive. */
function checkArchiveWhitelist({ failures, name, file, expected, manifest }) {
  if (!existsSync(file)) {
    failures.push(`${name} is missing from its asset directory`);
    return;
  }
  const { entries, problems } = readTarGz(readFileSync(file));
  for (const problem of problems) failures.push(`${name}: ${problem}`);
  const members = entries.map((entry) => entry.path).sort();
  const difference = setDifference(members, [...expected].sort());
  if (difference !== null) {
    failures.push(`${name} ships paths outside its contract (${difference})`);
    return;
  }
  const entry = entries.find((member) => member.path === manifest.expected);
  if (entry === undefined) {
    failures.push(`${name} has no ${manifest.expected}`);
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(entry.data.toString('utf8'));
  } catch (error) {
    failures.push(`${name}: ${manifest.expected} is not valid JSON: ${error.message}`);
    return;
  }
  const drifted = manifest.describe(parsed);
  if (drifted !== null) failures.push(`${name}: ${drifted}`);
  if (manifest.expected !== PAYLOAD_MANIFEST) return;
  const declared = Object.keys(parsed.files ?? {}).sort();
  const covered = members.filter((member) => member !== PAYLOAD_MANIFEST);
  const missing = covered.filter((member) => !declared.includes(member));
  if (missing.length > 0) {
    failures.push(`${name}: ${PAYLOAD_MANIFEST} does not cover ${missing.join(', ')}`);
  }
  const extra = declared.filter((member) => !covered.includes(member));
  if (extra.length > 0) {
    failures.push(`${name}: ${PAYLOAD_MANIFEST} lists files the archive does not ship: ${extra.join(', ')}`);
  }
}

function check(ctx) {
  const failures = [];
  const notes = [];
  checkPayloadProblems(ctx, failures);
  checkEngine(ctx, failures);
  checkVersion(ctx, failures);
  checkFiles(ctx, failures);
  checkDocs(ctx, failures);
  checkChangelog(ctx, failures);
  checkLockfile(ctx, failures);
  checkAssets(ctx, failures);
  checkCounts(ctx, failures, notes);

  if (failures.length > 0) {
    process.stderr.write(`release --check failed for r2c ${ctx.pkg.version ?? '?'}:\n`);
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `release --check ok: r2c ${ctx.pkg.version}, engine ^${ctx.pkg.version}, ${ctx.payload.files.length} payload files, ${ctx.engine.files.length} engine files, ${releaseAssets(ctx.pkg.version).length} assets\n`,
  );
  for (const note of notes) process.stdout.write(`note: ${note}\n`);
}

function build(ctx, outDir) {
  if (ctx.payload.problems.length > 0) {
    process.stderr.write('release: refusing to build an invalid payload:\n');
    for (const problem of ctx.payload.problems) process.stderr.write(`- ${problem}\n`);
    process.exit(1);
  }
  if (ctx.engine.problems.length > 0) {
    process.stderr.write('release: refusing to build an invalid engine archive:\n');
    for (const problem of ctx.engine.problems) process.stderr.write(`- ${problem}\n`);
    process.exit(1);
  }
  if (ctx.manifest === null || Object.keys(ctx.manifest.files).length !== ctx.payload.files.length) {
    process.stderr.write('release: payload manifest does not cover every payload file\n');
    process.exit(1);
  }
  const bootstrap = join(ctx.root, BOOTSTRAP_SOURCE);
  if (!existsSync(bootstrap)) {
    process.stderr.write(`release: the ${INSTALL_ASSET} asset has no source: ${BOOTSTRAP_SOURCE}\n`);
    process.exit(1);
  }

  const entries = ctx.payload.files.map((file) => ({
    path: file.rel,
    data: readFileSync(file.absolute),
  }));
  entries.push({ path: PAYLOAD_MANIFEST, data: manifestBuffer(ctx.manifest) });

  // One build, one version: every asset name carries the same V.
  const assets = [
    { name: engineAssetName(ctx.pkg.version), data: createTarGz(
      ctx.engine.files.map((file) => ({ path: file.rel, data: readFileSync(file.absolute) })),
    ) },
    { name: payloadAssetName(ctx.pkg.version), data: createTarGz(entries) },
    // The bootstrap ships verbatim, so users can pipe the asset straight to node.
    { name: INSTALL_ASSET, data: readFileSync(bootstrap) },
  ].sort((left, right) => (left.name < right.name ? -1 : 1));

  mkdirSync(outDir, { recursive: true });
  const sums = [];
  for (const asset of assets) {
    writeFileSync(join(outDir, asset.name), asset.data);
    sums.push(`${sha256(asset.data)}  ${asset.name}\n`);
  }
  const sumsPath = join(outDir, SUMS_ASSET);
  writeFileSync(sumsPath, sums.join(''));

  process.stdout.write(`engine ${ctx.pkg.version}: ${ctx.engine.files.length} files\n`);
  process.stdout.write(`payload ${ctx.pkg.version}: ${ctx.payload.files.length + 1} files\n`);
  for (const asset of assets) {
    process.stdout.write(`asset ${join(outDir, asset.name)}\n`);
    process.stdout.write(`sha256 ${sha256(asset.data)}\n`);
  }
  process.stdout.write(`asset ${sumsPath}\n`);
}

function emitJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readRequestedOptions(options) {
  if (options.optionsFile === null) return { ok: true, options: null };
  const parsed = readJson(options.optionsFile);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: `RELEASE_PAYLOAD_INVALID: --options ${options.optionsFile} is not a JSON object` };
  }
  return { ok: true, options: parsed };
}

function buildBundle(options) {
  const requested = readRequestedOptions(options);
  const result = requested.ok
    ? buildBundleRelease({
      root: ROOT,
      bundlePath: options.bundle,
      tag: options.tag,
      options: requested.options,
    })
    : { ok: false, failures: [requested.message], notes: [], assets: null, plan: null };
  if (!result.ok) {
    if (options.json) {
      emitJsonLine({ event: 'error', ok: false, code: 'RELEASE_BUILD_FAILED', failures: result.failures });
    } else {
      process.stderr.write(`bundle release failed for ${options.bundle}:\n`);
      for (const failure of result.failures) process.stderr.write(`- ${failure}\n`);
    }
    process.exit(1);
  }
  mkdirSync(options.out, { recursive: true });
  for (const asset of result.assets) {
    writeFileSync(join(options.out, asset.name), asset.data);
  }
  if (options.json) {
    for (const projection of result.projections) {
      emitJsonLine({
        event: 'projection',
        id: projection.id,
        digest: projection.digest,
        options: projection.options,
        manifest: projection.manifest,
      });
    }
    emitJsonLine({
      event: 'result',
      ok: true,
      id: result.id,
      version: result.version,
      tag: result.plan.tag,
      canonical: result.canonical,
      publishable: result.publishable,
      allowed: result.allowed,
      engineVersion: result.engineVersion,
      frameworkVersion: result.frameworkVersion,
      assets: result.plan.assets.map((asset) => ({
        name: asset.name,
        bytes: asset.size,
        sha256: asset.sha256,
      })),
      projections: result.projections.map((projection) => ({
        id: projection.id,
        digest: projection.digest,
        options: projection.options,
      })),
    });
    return;
  }
  process.stdout.write(
    `bundle ${result.id}@${result.version}: ${result.frameworkFiles.length} framework files, `
    + `${result.engineFiles.length} engine files, ${result.plan.assets.length} assets`
    + `${result.canonical ? '' : ' (custom options, local only)'}\n`,
  );
  for (const asset of result.plan.assets) {
    process.stdout.write(`asset ${join(options.out, asset.name)}\n`);
    process.stdout.write(`sha256 ${asset.sha256}\n`);
  }
  for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
}

function checkBundle(options) {
  const result = checkBundleRelease({
    root: ROOT,
    bundlePath: options.bundle,
    tag: options.tag,
    outDir: options.outSet ? options.out : null,
  });
  if (!result.ok) {
    process.stderr.write(`bundle release --check failed for ${options.tag ?? options.bundle}:\n`);
    for (const failure of result.failures) process.stderr.write(`- ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`${describeBundleCheck(result)}\n`);
  for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.compat) {
  const ctx = load({ root: ROOT });
  const file = join(ROOT, 'docs', 'compat.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, generateCompat(ctx));
  process.stdout.write(`wrote ${file}\n`);
} else if (options.bundle !== null) {
  if (options.check) checkBundle(options);
  else buildBundle(options);
} else {
  const ctx = load({ root: ROOT, out: options.out });
  if (options.check) check(ctx);
  else build(ctx, options.out);
}
