/**
 * Documentation contract (#17 §1, §7, §8; tickets #36, #45).
 *
 * Four docs are user-facing contracts, so they are tested like code:
 * `docs/install.md` (install → upgrade → rollback → uninstall → offline),
 * `docs/compat.md` (generated from `adapter.json`, never hand-edited),
 * `docs/blue-zone/preflight.md` (exactly 47 rows, each with five fields) and
 * the install sections of `README.md` plus `adapters/<agent>/README.md`.
 *
 * Since #45 there is exactly one distribution channel — the GitHub Release
 * assets driven by `scripts/install.mjs` — so every documented command is
 * checked against the real CLI help and the npm-era entry points are forbidden.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

/** The four install sections and the next command each one must end with. */
const INSTALL_SECTIONS = ['## Install', '## Upgrade', '## Rollback', '## Uninstall'];

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

/**
 * The npm era is over (#44): one install channel, and it is the release
 * bootstrap. Each entry is [label, pattern]; a doc that reinstates a package
 * manager, the retired runner spec or the manual layout copy fails here.
 */
const SECOND_CHANNEL = [
  ['npx', /\bnpx\b/],
  ['npm install', /\bnpm\s+(?:install|i|add|exec|pack|publish|ci)\b/],
  ['pnpm', /\bpnpm\b/],
  ['yarn', /\byarn\b/],
  ['retired runner spec', /\br2c-runner@/],
  ['retired payload asset', /\br2c-plugin-(?:\d|<)/],
  ['manual layout copy', /\bcp\s+-r\b[^\n]*payload/],
  ['manual layout copy (zh)', /手动复制/],
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

function lastLine(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.at(-1);
}

/** Every fenced code block, with its language tag. */
function fencedBlocks(text) {
  const blocks = [];
  const pattern = /```(\w*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(text)) !== null) blocks.push({ lang: match[1], body: match[2] });
  return blocks;
}

/** Command lines inside the blocks: [language, line]. */
function commandLines(text) {
  const commands = [];
  for (const { lang, body } of fencedBlocks(text)) {
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      commands.push({ lang, line });
    }
  }
  return commands;
}

function helpOutput(script, args = ['--help']) {
  const result = spawnSync(process.execPath, [join(REPO, script), ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${script} --help exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

/**
 * The flag vocabulary the documents may use: whatever `r2c --help` and
 * `install.mjs --help` really print today.
 */
function documentedFlagSources() {
  const cli = helpOutput('bin/r2c.js');
  const bootstrap = helpOutput('scripts/install.mjs');
  const flags = new Set();
  for (const text of [cli, bootstrap]) {
    for (const match of text.matchAll(/--[a-z][a-z-]*/g)) flags.add(match[0]);
  }
  flags.add('--help');
  flags.add('-h');
  const topLevel = sectionText(cli, 'Commands:', 'Global options:')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return { flags, topLevel, bootstrap };
}

function sectionText(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `help output has no ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, `help output has no ${endMarker}`);
  return text.slice(start + startMarker.length, end);
}

const HELP = documentedFlagSources();
const ADAPTER_SUBCOMMANDS = ['install', 'uninstall', 'doctor', 'smoke', 'list', 'prune'];
const GH_FLAGS = new Set(['-R', '--repo', '-p', '--pattern', '-D', '--dir']);

/** The docs that describe how to install r2c. */
function installDocs() {
  return ['README.md', 'docs/install.md', ...ADAPTER_IDS.map((id) => `adapters/${id}/README.md`)];
}

// --- single channel -------------------------------------------------------

test('no install doc offers a second channel or the retired npx runner', () => {
  for (const rel of installDocs()) {
    const text = read(rel);
    for (const [label, pattern] of SECOND_CHANNEL) {
      assert.doesNotMatch(text, pattern, `${rel} reinstates ${label}`);
    }
  }
});

test('every markdown doc except the dated preflight log avoids npx', () => {
  const files = ['README.md', 'CHANGELOG.md'];
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) files.push(rel);
    }
  };
  walk('docs');
  walk('adapters');
  for (const rel of files) {
    if (rel === 'docs/blue-zone/preflight.md') continue;
    assert.doesNotMatch(read(rel), /\bnpx\b/, `${rel} still names npx`);
  }
});

test('the retired plugin asset name survives only in the dated preflight record', () => {
  const files = ['README.md', 'CHANGELOG.md', 'GLOSSARY.md'];
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) files.push(rel);
    }
  };
  walk('docs');
  walk('adapters');
  for (const rel of files) {
    if (rel === 'docs/blue-zone/preflight.md') continue;
    assert.doesNotMatch(
      read(rel),
      /r2c-plugin-\d|\.r2c\/plugin\//,
      `${rel} names the retired plugin asset or install directory`,
    );
  }
});

test('install doc names the four release assets and the bootstrap, not a package', () => {
  const install = read('docs/install.md');
  for (const asset of [
    'r2c-engine-<V>.tgz',
    'r2c-payload-<V>.tgz',
    'install.mjs',
    'SHA256SUMS.txt',
  ]) {
    assert.ok(install.includes(asset), `install doc does not name ${asset}`);
  }
  assert.match(install, /There is no npm channel and no manual\s+payload copy/);
});

// --- install.md: the four sections ----------------------------------------

test('install doc covers the bootstrap, detection, payload and doctor', () => {
  const install = read('docs/install.md');
  assert.match(install, /gh release download v0\.1\.0 -R hesl2636\/hm2B_drvport_pipiline -p install\.mjs/);
  assert.match(install, /node \.r2c\/bootstrap\/install\.mjs --agent claude-code --version 0\.1\.0 --project \./);
  assert.match(install, /node ".r2c\\bootstrap\\install\.mjs"/);
  assert.match(install, /node scripts\/install\.mjs --agent claude-code --version 0\.1\.0/);
  assert.match(install, /AGENT_NOT_DETECTED/);
  assert.match(install, /## Doctor/);
  for (const id of ADAPTER_IDS) {
    assert.ok(install.includes(`\`${id}\``), `install doc is missing adapter ${id}`);
  }
});

test('install, upgrade, rollback and uninstall each end with the next command', () => {
  const install = read('docs/install.md');
  for (const heading of INSTALL_SECTIONS) {
    const body = section(install, heading);
    const tail = lastLine(body);
    assert.match(tail, new RegExp(`^Next: \`(?:node|git) .+\``), `${heading} does not end with a next command: ${tail}`);
    assert.match(tail, /bin\/r2c\.js|git status/, `${heading} next command names no engine: ${tail}`);
  }
  const upgrade = section(install, '## Upgrade');
  assert.match(upgrade, /--version <new-V>/);
  assert.match(upgrade, /engine, payload and adapters move\s+together/);
  assert.match(upgrade, /no-op|writes nothing/, 'upgrade must name the idempotent re-run');
  const rollback = section(install, '## Rollback');
  assert.match(rollback, /--version <old-V>/);
  assert.match(rollback, /not pointing `PATH` at an older engine/);
  assert.match(rollback, /--force/);
  assert.match(rollback, /cache\/payload-<old-V>/);
  const uninstall = section(install, '## Uninstall');
  assert.match(uninstall, /adapter uninstall claude-code/);
  assert.match(uninstall, /--purge-state/);
  assert.match(uninstall, /is \*\*kept\*\* by default/);
  assert.match(uninstall, /receipt/);
});

test('README gives one install command per adapter', () => {
  const readme = read('README.md');
  const install = section(readme, '## 安装');
  for (const id of ADAPTER_IDS) {
    assert.ok(install.includes(`--agent ${id}`), `README has no install command for ${id}`);
  }
  assert.match(install, /curl\.exe --create-dirs -fL -o \.r2c\/bootstrap\/install\.mjs/);
  assert.match(install, /GH_TOKEN/);
  assert.match(section(readme, '## 卸载'), /adapter uninstall opencode/);
});

// --- command contract -----------------------------------------------------

test('every documented node command uses flags and subcommands the CLI prints', () => {
  const docs = [...installDocs(), 'docs/plugins.md'];
  const seen = { node: 0, gh: 0, engine: 0 };
  for (const rel of docs) {
    for (const { line } of commandLines(read(rel))) {
      const [program, second, third] = line.split(/\s+/);
      if (program === 'gh') {
        seen.gh += 1;
        for (const token of line.split(/\s+/).filter((part) => part.startsWith('-'))) {
          assert.ok(GH_FLAGS.has(token), `${rel}: gh flag ${token} is not documented gh usage`);
        }
        continue;
      }
      if (program !== 'node') continue;
      // A shim invocation (`shims/hook.mjs`) has its own flag vocabulary.
      if (line.includes('hook.mjs')) continue;
      seen.node += 1;
      for (const flag of line.matchAll(/--[a-z][a-z-]*/g)) {
        assert.ok(HELP.flags.has(flag[0]), `${rel}: ${flag[0]} is not in r2c --help or install.mjs --help`);
      }
      if (second === undefined) continue;
      if (second.endsWith('install.mjs')) {
        assert.match(line, /--agent [a-z-]+/, `${rel}: the bootstrap requires --agent`);
        seen.engine += 1;
        continue;
      }
      if (!second.endsWith('r2c.js')) continue;
      seen.engine += 1;
      if (third === undefined) continue;
      if (third === 'adapter') {
        const sub = line.split(/\s+/)[3];
        assert.ok(
          ADAPTER_SUBCOMMANDS.includes(sub),
          `${rel}: adapter subcommand ${sub} is not one of ${ADAPTER_SUBCOMMANDS.join('/')}`,
        );
      } else if (third !== '--version') {
        assert.ok(HELP.topLevel.includes(third), `${rel}: ${third} is not a top-level r2c command`);
      }
    }
  }
  assert.ok(seen.node >= 10, `expected the docs to carry the real commands, saw ${seen.node}`);
  assert.ok(seen.gh >= 2, `expected gh download commands for both platforms, saw ${seen.gh}`);
  assert.ok(seen.engine >= 6, `expected engine entry commands, saw ${seen.engine}`);
});

test('both platform variants are separately copy-pasteable and quoting is stated', () => {
  for (const rel of ['docs/install.md']) {
    const text = read(rel);
    const blocks = fencedBlocks(text);
    assert.ok(blocks.some((block) => block.lang === 'bash'), `${rel} has no POSIX block`);
    assert.ok(blocks.some((block) => block.lang === 'bat'), `${rel} has no Windows block`);
    const posix = blocks.filter((block) => block.lang === 'bash').map((block) => block.body).join('\n');
    const windows = blocks.filter((block) => block.lang === 'bat').map((block) => block.body).join('\n');
    assert.match(posix, /mkdir -p \.r2c\/bootstrap/, `${rel} POSIX block does not create the bootstrap dir`);
    assert.match(windows, /mkdir \.r2c\\bootstrap/, `${rel} Windows block does not create the bootstrap dir`);
    assert.match(windows, /node "\.r2c\\bootstrap\\install\.mjs"/, `${rel} Windows block is not quoted`);
    assert.match(text, /quote|quoted|引号/i, `${rel} does not state the quoting rule`);
    assert.match(text, /--scope/, `${rel} does not state the scope switch`);
  }
});

test('scopes and landing paths still match every adapter declaration', () => {
  const install = read('docs/install.md');
  for (const id of ADAPTER_IDS) {
    assert.ok(install.includes(`\`${id}\``), `install doc is missing adapter ${id}`);
    const declaration = adapter(id);
    const row = install.split('\n').find((line) => line.startsWith(`| \`${id}\``));
    assert.ok(row, `install doc has no landing-path row for ${id}`);
    for (const scope of declaration.scopes) {
      assert.ok(
        install.includes(scope === 'user' ? '`~/' : '`<P>/'),
        `install doc has no ${scope} landing path`,
      );
    }
  }
  assert.match(install, /--scope user/);
  assert.match(install, /\.r2c\/engine\/<V>\//);
  assert.match(install, /~\/\.r2c\/engine\/<V>\//);
  assert.match(install, /~\/\.claude\//);
  assert.match(install, /~\/\.dsh\//);
  assert.match(install, /~\/\.omp\//);
  assert.match(install, /~\/\.config\/opencode\//);
});

// --- offline and private --------------------------------------------------

test('offline section matches the credential chain, cache and bases', () => {
  const install = read('docs/install.md');
  const offline = section(install, '## Offline and private downloads');
  const ghToken = offline.indexOf('GH_TOKEN');
  const gitHubToken = offline.indexOf('GITHUB_TOKEN');
  const gitFill = offline.indexOf('git credential fill');
  assert.ok(ghToken !== -1 && gitHubToken !== -1 && gitFill !== -1, 'credential chain is incomplete');
  assert.ok(ghToken < gitHubToken && gitHubToken < gitFill, 'credential order must be GH_TOKEN → GITHUB_TOKEN → git credential fill');
  assert.match(offline, /gh auth login/);
  assert.match(offline, /~\/\.r2c\/cache\/payload-<V>/);
  assert.match(offline, /--from <dir\|tgz>/);
  assert.match(offline, /R2C_RELEASE_BASE/);
  assert.match(offline, /--release-base <dir>/);
  assert.match(offline, /<base>\/v<V>\/<asset>/);
  assert.match(offline, /nothing is fetched/);
});

test('install doc still defines the B and C limitation', () => {
  const install = read('docs/install.md');
  assert.match(install, /## B and C have no runtime guard/);
  assert.match(install, /cannot intercept tool calls/);
  assert.match(install, /`\/hooks` trust/);
});

// --- forbidden literals ---------------------------------------------------

test('install docs contain no yellow-zone or internal-registry literals', () => {
  for (const rel of installDocs()) {
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
    compat.includes(`| Version | \`r2c-runner\`, \`r2c-payload-${pkg.version}.tgz\`, adapters | \`${pkg.version}\` |`),
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
