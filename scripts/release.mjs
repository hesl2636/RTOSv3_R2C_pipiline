#!/usr/bin/env node
/**
 * The framework release packager.
 *
 * P6 (#111) split the old lock-step channel in two:
 *
 * - the **legacy channel** (`v<E>`) is frozen. This command still builds its
 *   engine asset `r2c-engine-<E>.tgz` with the P6 archive layout (root
 *   launcher + `runtime/runner/engine/**` + `core/**` + vendored `yaml`), and
 *   `--check` still gates the engine, the bootstrap and the generated
 *   compatibility document. It no longer builds or publishes a payload: main
 *   stopped shipping the legacy engine-version payload at the cutover, and old
 *   Releases remain installable with their frozen engines.
 * - the **bundle channel** (`bundle-<id>-v<version>`) lives in
 *   `scripts/lib/bundle-release.mjs`: `--bundle <zip|dir> --out DIR`,
 *   `--bundle ... --check` and `--bundle ... --publish`.
 *
 * `--check` is the pre-publish gate. Digests are `scripts/verify-sums.mjs`'s
 * job; this gate is structural so a coverage failure is never masked by a
 * digest failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCodePoints } from '../core/code-point.js';
import { sha256Hex as sha256 } from '../core/node/sha256.js';
import { isValidVersion } from '../core/semver.js';
import { COMPILED_WORKFLOW_BUNDLE_SCHEMA, COMPILED_WORKFLOW_SCHEMA } from '../compiled/schema.js';
import { listProjections } from '../projection/registry.js';
import { createReleaseTarGz, readReleaseTarGz } from '../installer/release-tar.js';
import {
  ENGINE_ENTRY,
  collectEngine,
  legacyEngineAssetName,
  engineEntryBytes,
} from './lib/engine-archive.mjs';
import {
  buildBundleRelease,
  checkBundleRelease,
  describeBundleCheck,
} from './lib/bundle-release.mjs';
import { GH_TOKEN_HINT, readGithubToken } from '../installer/release-auth.js';
import { GITHUB_API_BASE, createGithubClient } from '../installer/release-client.js';
import { publishBundle } from '../installer/release-publish.js';
import { DEFAULT_RELEASE_REPO } from '../installer/release-source.js';
import { COMPILED_WORKFLOW_ASSET } from '../installer/release-tags.js';
import { readBuiltRelease } from './lib/built-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The bootstrap ships verbatim; `scripts/install.mjs` is its only source (#41). */
const BOOTSTRAP_SOURCE = 'scripts/install.mjs';
const INSTALL_ASSET = 'install.mjs';
const SUMS_ASSET = 'SHA256SUMS.txt';
const ENGINE_PACKAGE = 'runtime/runner/engine/package.json';

/** The legacy asset names of one engine version, sorted. */
function releaseAssets(version) {
  return [INSTALL_ASSET, legacyEngineAssetName(version), SUMS_ASSET].sort();
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
    + '       node scripts/release.mjs --bundle <zip|dir> --check [--out DIR] [--tag TAG]\n'
    + '       node scripts/release.mjs --bundle <zip|dir> --publish [--out DIR] [--tag TAG] [--commit SHA] [--json]\n'
    + '       node scripts/release.mjs --publish --out <built-dir> [--tag TAG] [--commit SHA] [--json]\n'
    + '       --out must already hold a build; publishing never re-projects or re-packs.\n'
    + '       --publish reads GH_TOKEN/GITHUB_TOKEN from the launch environment; it never prompts.\n'
    + '       GH_REPO and HM2B_GITHUB_API are operator settings (default: ' + DEFAULT_RELEASE_REPO + ', '
    + GITHUB_API_BASE + ').\n',
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
    publish: false,
    commit: null,
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
    } else if (arg === '--publish') options.publish = true;
    else if (arg === '--commit') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--commit requires a commit sha');
      options.commit = value;
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
  if (options.tag !== null && options.bundle === null && !options.publish) usage('--tag only applies to --bundle');
  if (options.optionsFile !== null && options.bundle === null) usage('--options only applies to --bundle');
  if (options.optionsFile !== null && options.check) usage('--options is a build input, not a --check input');
  if (options.optionsFile !== null && options.publish) usage('--options does not apply to --publish');
  if (options.json && options.check) usage('--json is progress output, not a --check input');
  if (options.json && options.bundle === null && !options.publish) {
    usage('--json only applies to a bundle build or publish');
  }
  if (options.commit !== null && !options.publish) usage('--commit only applies to --publish');
  if (options.publish && options.check) usage('--publish and --check are mutually exclusive');
  if (options.publish && options.bundle === null && !options.outSet) {
    usage('--publish without --bundle requires --out <built-dir>');
  }
  if (options.bundle !== null && !options.check && !options.publish && !options.outSet) {
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

function load(ctx) {
  const framework = readJson(join(ctx.root, 'package.json'));
  if (framework === null) {
    process.stderr.write(`release: cannot read ${join(ctx.root, 'package.json')}\n`);
    process.exit(1);
  }
  const enginePkg = readJson(join(ctx.root, ENGINE_PACKAGE));
  if (enginePkg === null) {
    process.stderr.write(`release: cannot read ${join(ctx.root, ENGINE_PACKAGE)}\n`);
    process.exit(1);
  }
  // `collectEngine` reads the engine package itself; the parsed copy here is
  // only for the version/engine-range checks and the compatibility document.
  return { ...ctx, framework, enginePkg, engine: collectEngine(ctx.root) };
}

const ESCAPE_PIPE = /\\\|/g;

function escapePipe(value) {
  return String(value).replaceAll('|', '\\|');
}

/**
 * The compatibility document is generated from the three version sources the
 * framework actually has: the framework package, the engine package and the
 * static projection manifests. Contract revisions are the published API ids.
 */
function generateCompat({ framework, enginePkg }) {
  const projections = listProjections();
  const contracts = [COMPILED_WORKFLOW_BUNDLE_SCHEMA, COMPILED_WORKFLOW_SCHEMA, ...projections.map((projection) => projection.api.result)];
  const lines = [
    '# Compatibility matrix',
    '',
    'Generated from `package.json`, `runtime/runner/engine/package.json` and the',
    'projection manifests by `node scripts/release.mjs --compat`. Do not edit by',
    'hand: `node scripts/release.mjs --check` fails when this file drifts.',
    '',
    '| Dimension | Object | Range |',
    '| --- | --- | --- |',
    `| Framework | \`${framework.name}\` | \`${framework.version}\` |`,
    `| Engine | \`${enginePkg.name}\` | \`${enginePkg.version}\` |`,
    `| Contract | bundle / compiled workflow / projection | ${[...new Set(contracts)].map((id) => `\`${id}\``).join(', ')} |`,
    ...projections.map(
      (projection) => `| Projection | \`${projection.id}\` | \`${projection.version}\` |`,
    ),
    `| Node | \`${framework.name}\`, \`${enginePkg.name}\` | \`${escapePipe(framework.engines?.node ?? '')}\` |`,
    '',
  ];
  return lines.join('\n');
}

function checkEngine(ctx, failures) {
  for (const problem of ctx.engine.problems) failures.push(problem);
  if (ctx.engine.version !== ctx.enginePkg.version) {
    failures.push(
      `engine package version is ${ctx.engine.version} but ${ENGINE_PACKAGE} says ${ctx.enginePkg.version}`,
    );
  }
  if (ctx.engine.files.length === 0) failures.push('engine file set is empty');
  const rels = new Set(ctx.engine.files.map((file) => file.rel));
  for (const required of [
    ENGINE_ENTRY,
    'package.json',
    ENGINE_PACKAGE,
    'runtime/runner/engine/bin/hm2b.js',
    'runtime/runner/contract/manifest.js',
    'LICENSE',
  ]) {
    if (!rels.has(required)) failures.push(`engine archive is missing ${required}`);
  }
  if (![...rels].some((rel) => rel.startsWith('core/'))) failures.push('engine archive is missing core/**');
  if (![...rels].some((rel) => rel.startsWith('node_modules/yaml/'))) {
    failures.push('engine archive is missing the vendored node_modules/yaml');
  }
  for (const file of ctx.engine.files) {
    if (/^(test|tests|docs|scripts|pack|adapters|plugins|dist|web|installer|projection|assembler|compiledWorkflow|examples|\.github)\//.test(file.rel)) {
      failures.push(`engine must not ship ${file.rel}`);
    }
  }
  const rootPackage = ctx.engine.files.find((file) => file.rel === 'package.json');
  const nestedPackage = ctx.engine.files.find((file) => file.rel === ENGINE_PACKAGE);
  if (rootPackage !== undefined && nestedPackage !== undefined) {
    if (!engineEntryBytes(rootPackage).equals(engineEntryBytes(nestedPackage))) {
      failures.push('engine archive package.json is not byte-identical to the engine package');
    }
  }
  const launcher = ctx.engine.files.find((file) => file.rel === ENGINE_ENTRY);
  if (launcher !== undefined && !String(engineEntryBytes(launcher)).includes('runtime/runner/engine/bin/hm2b.js')) {
    failures.push(`${ENGINE_ENTRY} does not point at the extracted engine entry`);
  }
}

function checkVersion(ctx, failures) {
  const { framework, enginePkg } = ctx;
  if (typeof framework.version !== 'string' || !isValidVersion(framework.version)) {
    failures.push(`package.json version is not a valid version: ${framework.version}`);
  }
  if (typeof enginePkg.version !== 'string' || !isValidVersion(enginePkg.version)) {
    failures.push(`${ENGINE_PACKAGE} version is not a valid version: ${enginePkg.version}`);
  }
  if (framework.private !== true) failures.push('the root package must be private (hm2b-framework is not published)');
  if ('workspaces' in framework) failures.push('the root package must not declare npm workspaces');
  if (framework.engines?.node !== enginePkg.engines?.node) {
    failures.push('framework and engine must declare the same engines.node range');
  }
  if (framework.dependencies?.yaml !== enginePkg.dependencies?.yaml) {
    failures.push('framework and engine must declare the same yaml dependency');
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
    failures.push('docs/compat.md does not match the framework/engine/projection versions (run --compat)');
  }
}

function checkChangelog(ctx, failures) {
  const file = join(ctx.root, 'CHANGELOG.md');
  if (!existsSync(file)) {
    failures.push('CHANGELOG.md is missing');
    return;
  }
  const heading = `## [${ctx.framework.version}]`;
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
  const version = ctx.framework.version;
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    failures.push(`package-lock.json version ${lock.version} does not match package.json ${version}`);
  }
  if (lock.packages?.['']?.name !== ctx.framework.name) {
    failures.push(`package-lock.json name ${lock.packages?.['']?.name} does not match package.json ${ctx.framework.name}`);
  }
}

/** Exactly one example bundle and exactly one committed deterministic zip. */
function checkCounts(ctx, failures) {
  const bundleDir = join(ctx.root, 'examples', 'rtosv3', 'bundle');
  if (!existsSync(join(bundleDir, 'bundle.json'))) {
    failures.push('examples/rtosv3/bundle/bundle.json is missing');
  }
  const dist = join(ctx.root, 'examples', 'rtosv3', 'dist');
  const zips = existsSync(dist)
    ? readdirSync(dist).filter((name) => /^bundle-.+-v.+\.zip$/.test(name))
    : [];
  if (zips.length !== 1) {
    failures.push(`expected exactly one examples/rtosv3/dist/bundle-*.zip, found ${zips.length}`);
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
 * The legacy asset whitelist. Source side: the engine, the bootstrap and the
 * sums file, nothing else. Built side (when `--out` holds a build): the
 * directory holds exactly those, the sums cover every hashed asset and the
 * engine archive ships its frozen layout with an engine-version package.
 */
function checkAssets(ctx, failures) {
  const version = ctx.enginePkg.version;
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
  if (ctx.engine.problems.length > 0) return;

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

  const engineFile = join(outDir, legacyEngineAssetName(version));
  if (!existsSync(engineFile)) {
    failures.push(`${legacyEngineAssetName(version)} is missing from its asset directory`);
    return;
  }
  const { entries, problems } = readReleaseTarGz(readFileSync(engineFile));
  for (const problem of problems) failures.push(`${legacyEngineAssetName(version)}: ${problem}`);
  const members = entries.map((entry) => entry.path).sort();
  const memberDifference = setDifference(members, ctx.engine.files.map((file) => file.rel).sort());
  if (memberDifference !== null) {
    failures.push(`${legacyEngineAssetName(version)} ships paths outside its contract (${memberDifference})`);
  }
  const packageEntry = entries.find((entry) => entry.path === 'package.json');
  if (packageEntry === undefined) {
    failures.push(`${legacyEngineAssetName(version)} has no package.json`);
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(packageEntry.data.toString('utf8'));
    } catch (error) {
      failures.push(`${legacyEngineAssetName(version)}: package.json is not valid JSON: ${error.message}`);
    }
    if (parsed !== null && parsed.version !== version) {
      failures.push(
        `${legacyEngineAssetName(version)}: engine package.json version is ${parsed.version} but the engine package is ${version}`,
      );
    }
  }
}

function check(ctx) {
  const failures = [];
  checkEngine(ctx, failures);
  checkVersion(ctx, failures);
  checkDocs(ctx, failures);
  checkChangelog(ctx, failures);
  checkLockfile(ctx, failures);
  checkAssets(ctx, failures);
  checkCounts(ctx, failures);

  if (failures.length > 0) {
    process.stderr.write(`release --check failed for ${ctx.framework.name ?? 'hm2b'} ${ctx.framework.version ?? '?'}:\n`);
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `release --check ok: ${ctx.framework.name} ${ctx.framework.version}, engine ${ctx.enginePkg.version}, `
    + `${ctx.engine.files.length} engine files, ${releaseAssets(ctx.enginePkg.version).length} assets\n`,
  );
}

function build(ctx, outDir) {
  if (ctx.engine.problems.length > 0) {
    process.stderr.write('release: refusing to build an invalid engine archive:\n');
    for (const problem of ctx.engine.problems) process.stderr.write(`- ${problem}\n`);
    process.exit(1);
  }
  const bootstrap = join(ctx.root, BOOTSTRAP_SOURCE);
  if (!existsSync(bootstrap)) {
    process.stderr.write(`release: the ${INSTALL_ASSET} asset has no source: ${BOOTSTRAP_SOURCE}\n`);
    process.exit(1);
  }
  const version = ctx.enginePkg.version;

  // One build, one version: every asset name carries the engine version E.
  const assets = [
    {
      name: legacyEngineAssetName(version),
      data: createReleaseTarGz(
        ctx.engine.files.map((file) => ({ path: file.rel, data: engineEntryBytes(file), mode: 0o644 })),
      ),
    },
    // The bootstrap ships verbatim, so users can pipe the asset straight to node.
    { name: INSTALL_ASSET, data: readFileSync(bootstrap) },
  ].sort((left, right) => compareCodePoints(left.name, right.name));

  mkdirSync(outDir, { recursive: true });
  const sums = [];
  for (const asset of assets) {
    writeFileSync(join(outDir, asset.name), asset.data);
    sums.push(`${sha256(asset.data)}  ${asset.name}\n`);
  }
  const sumsPath = join(outDir, SUMS_ASSET);
  writeFileSync(sumsPath, sums.join(''));

  process.stdout.write(`engine ${version}: ${ctx.engine.files.length} files\n`);
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

/** Write the built assets into `--out`. */
function writeBundleAssets(result, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const asset of result.assets) writeFileSync(join(outDir, asset.name), asset.data);
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
  writeBundleAssets(result, options.out);
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

function headCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

const RECOVERY_HINT = Object.freeze({
  retry: 're-run --publish; the draft was deleted and the version is still unused',
  'new-patch': 'the version is consumed; publish a new patch version',
  'mark-prerelease-or-new-patch': 'mark the release prerelease, or publish a new patch version; never rewrite its assets',
});

const GH_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Target repository: `GH_REPO` (operator setting), else the frozen default. */
function publishRepo() {
  const raw = process.env.GH_REPO;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RELEASE_REPO;
  return GH_REPO_RE.test(raw.trim()) ? raw.trim() : null;
}

/**
 * API origin: `HM2B_GITHUB_API` is an operator-only override for a local
 * fixture or a self-hosted mirror; otherwise the public GitHub API. The
 * browser can never set it, and the token is only sent to this origin.
 */
function publishApiBase() {
  const raw = process.env.HM2B_GITHUB_API;
  if (raw === undefined || raw.trim() === '') return GITHUB_API_BASE;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return raw.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Read an already built asset directory. Publishing never rebuilds: the zip,
 * compiled workflow and payloads are exactly the bytes the build produced, and the manifest
 * (`SHA256SUMS.txt`) must cover every file and nothing else.
 */
function publishFailureLines(failures) {
  return failures.map((failure) => failure.replace(/^([A-Z_]+): (.*)$/, (whole, code, message) => `${code}: ${message}`));
}

/**
 * Publish a bundle Release (#107). The token comes only from the launch
 * environment; it is never printed, asked for or written to disk. With
 * `--json`, stdout is JSON-lines progress (`phase`) and one final `result`.
 */
async function publishBundleCli(options) {
  const credential = readGithubToken(process.env);
  if (credential.token === null) {
    process.stderr.write(`release: publish disabled — ${GH_TOKEN_HINT} in the launch environment\n`);
    process.exit(2);
  }
  const repo = publishRepo();
  if (repo === null) {
    process.stderr.write('release: GH_REPO must be owner/name\n');
    process.exit(2);
  }
  const base = publishApiBase();
  if (base === null) {
    process.stderr.write('release: HM2B_GITHUB_API must be an http(s) URL\n');
    process.exit(2);
  }

  let plan;
  let assets;
  if (options.bundle !== null) {
    const result = buildBundleRelease({
      root: ROOT,
      bundlePath: options.bundle,
      tag: options.tag,
    });
    if (!result.ok) {
      if (options.json) {
        emitJsonLine({ event: 'result', ok: false, state: 'FAILED', failures: result.failures });
      } else {
        process.stderr.write(`bundle release failed for ${options.bundle}:\n`);
        for (const failure of result.failures) process.stderr.write(`- ${failure}\n`);
      }
      process.exit(1);
    }
    if (options.outSet) writeBundleAssets(result, options.out);
    plan = result.plan;
    assets = result.assets;
  } else {
    const built = readBuiltRelease(options.out);
    if (!built.ok) {
      if (options.json) {
        emitJsonLine({ event: 'result', ok: false, state: 'FAILED', failures: built.failures });
      } else {
        process.stderr.write(`cannot publish ${options.out}:\n`);
        for (const failure of built.failures) process.stderr.write(`- ${failure}\n`);
      }
      process.exit(1);
    }
    if (options.tag !== null && options.tag !== built.plan.tag) {
      const failure = `RELEASE_TAG_MISMATCH: ${options.tag} does not match ${built.plan.tag}`;
      if (options.json) emitJsonLine({ event: 'result', ok: false, state: 'FAILED', failures: [failure] });
      else process.stderr.write(`release: ${failure}\n`);
      process.exit(1);
    }
    plan = built.plan;
    assets = built.assets;
  }

  const commit = options.commit ?? headCommit();
  if (commit === null) {
    process.stderr.write('release: --commit <sha> is required when git HEAD is unavailable\n');
    process.exit(2);
  }
  const client = createGithubClient({
    base,
    token: credential.token,
    allowInsecure: base.startsWith('http://'),
  });
  const published = await publishBundle({
    client,
    repo,
    plan,
    assets,
    targetCommitish: commit,
    onPhase: options.json
      ? (phase) => emitJsonLine({ event: 'phase', phase })
      : (phase) => process.stdout.write(`phase ${phase}\n`),
  });
  for (const note of published.notes) {
    if (options.json) emitJsonLine({ event: 'note', message: note });
    else process.stdout.write(`note: ${note}\n`);
  }
  if (options.json) {
    emitJsonLine({
      event: 'result',
      ok: published.ok,
      state: published.state,
      published: published.published,
      tag: published.tag,
      releaseId: published.releaseId,
      recovery: published.recovery,
      failures: published.failures,
      cleanup: published.cleanup,
      transitions: published.transitions,
    });
  }
  if (!published.ok) {
    process.stderr.write(`release: publish failed for ${published.tag} (${published.state}):\n`);
    for (const failure of publishFailureLines(published.failures)) process.stderr.write(`- ${failure}\n`);
    const hint = RECOVERY_HINT[published.recovery];
    if (hint !== undefined) process.stderr.write(`recovery: ${hint}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `published ${published.tag}: ${plan.assets.length} assets (release ${String(published.releaseId)})\n`,
  );
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
} else if (options.publish) {
  await publishBundleCli(options);
} else if (options.bundle !== null) {
  if (options.check) checkBundle(options);
  else buildBundle(options);
} else {
  const ctx = load({ root: ROOT, out: options.out });
  if (options.check) check(ctx);
  else build(ctx, options.out);
}
