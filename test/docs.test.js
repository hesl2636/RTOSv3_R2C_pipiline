/**
 * Documentation contract after P6 (#111, spec §15).
 *
 * The docs describe one forward channel (per-bundle Releases) and the three
 * layers (framework, engine, bundle). Retired mechanisms may only appear in
 * the historical notes (`docs/legacy.md`, `docs/blue-zone/`, `docs/agents/`),
 * every relative link resolves, and every command in a fenced block uses a
 * path and flag the tools really have.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'docs/install.md', 'docs/layout.md', 'docs/compat.md', 'GLOSSARY.md', 'CHANGELOG.md'];
const HISTORICAL = new Set(['docs/legacy.md', 'docs/blue-zone/preflight.md', 'docs/agents/issue-tracker.md']);

/** Retired vocabulary: the replacement is the bundle/projection/target world. */
const RETIRED = [
  ['top-level src/', /(^|[\s`(])(?:\.\/)?src\//m],
  ['adapters tree', /(^|[\s`(])adapters\//],
  ['adapter declaration', /adapter\.json/],
  ['adapter map', /map\.json/],
  ['derive-agent action', /\bderive-agent\b/],
  ['pack tree', /(^|[\s`(])pack\//],
  ['plugins tree', /(^|[\s`(])plugins\//],
  ['shims tree', /(?<![/\w-])shims\//],
  ['top-level schema tree', /(?<![/\w-])schema\//],
  ['adapter command', /\br2c adapter\b/],
  ['acceptance command', /\br2c acceptance\b/],
  ['legacy payload asset', /r2c-payload-<E>|r2c-payload-\d/],
  // The framework/engine/projection names moved to hm2b; current docs must
  // not describe the new channel with the retired r2c names.
  ['legacy framework name', /\br2c-framework\b/],
  ['legacy engine name', /\br2c-runner\b/],
  ['legacy engine asset', /\br2c-engine-/],
  ['legacy bundle schema', /\br2c\.bundle\//],
  ['legacy IR schema', /\br2c\.ir\//],
  ['legacy workflow schema', /\br2c\.workflow\//],
  ['legacy runtime receipt', /\br2c\.runtime\//],
  ['legacy projection report', /\br2c\.projection/],
  ['legacy projection id', /(?<![\w./`-])r2c(?![\w./`-])/],
];

function read(rel) {
  return readFileSync(join(REPO, ...rel.split('/')), 'utf8');
}

function fencedBlocks(text) {
  const blocks = [];
  const pattern = /```(\w*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(text)) !== null) blocks.push({ lang: match[1], body: match[2] });
  return blocks;
}

function commandLines(text) {
  const commands = [];
  for (const { body } of fencedBlocks(text)) {
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('…')) continue;
      commands.push(line);
    }
  }
  return commands;
}

function helpOf(file, args = ['--help']) {
  const result = spawnSync(process.execPath, [join(REPO, ...file.split('/')), ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${file} --help exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

const FLAGS = new Set(['--help', '-h', '--json', '--version', '-v']);
for (const file of ['runtime/runner/engine/bin/hm2b.js', 'bin/hm2b-assembler.js', 'scripts/install.mjs', 'scripts/release.mjs', 'installer/cli.js']) {
  const text = file.endsWith('release.mjs')
    ? spawnSync(process.execPath, [join(REPO, ...file.split('/')), '--help'], { encoding: 'utf8' }).stderr
    : helpOf(file);
  for (const match of text.matchAll(/--[a-z][a-z-]*/g)) FLAGS.add(match[0]);
}

test('the user-facing documents exist and are not empty', () => {
  for (const rel of DOCS) {
    assert.ok(existsSync(join(REPO, ...rel.split('/'))), `${rel} is missing`);
    assert.ok(read(rel).trim().length > 200, `${rel} is empty`);
  }
});

test('retired mechanisms appear only in the historical notes', () => {
  for (const rel of DOCS.filter((doc) => doc !== 'CHANGELOG.md')) {
    const text = read(rel);
    for (const [label, pattern] of RETIRED) {
      assert.doesNotMatch(text, pattern, `${rel} mentions retired ${label}`);
    }
  }
  // The historical note may name them, but only with an explicit "retired".
  const legacy = read('docs/legacy.md');
  assert.match(legacy, /retired|冻结|退役/i);
});

test('every relative markdown link resolves', () => {
  for (const rel of [...DOCS, 'docs/legacy.md']) {
    const text = read(rel);
    const base = dirname(join(REPO, ...rel.split('/')));
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1].trim();
      if (/^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(base, target)), `${rel}: broken link ${target}`);
    }
  }
});

test('documented commands use real paths and known flags', () => {
  for (const rel of [...DOCS, 'docs/legacy.md']) {
    for (const line of commandLines(read(rel))) {
      const isCommand = line.startsWith('node ') || line.startsWith('r2c ') || line.startsWith('hm2b ')
        || line.startsWith('npm ') || line.startsWith('npx ');
      if (!isCommand) continue;
      if (line.startsWith('node ')) {
        const path = line.split(/\s+/)[1].replace(/^"|"$/g, '');
        if (path === 'install.mjs' || path.startsWith('-')) continue;
        if (!path.startsWith('<') && !path.startsWith('.')) {
          assert.ok(existsSync(join(REPO, ...path.split('/'))), `${rel}: node ${path} does not exist`);
        }
      } else if (line.startsWith('r2c ') || line.startsWith('hm2b ')
        || line.startsWith('npx ') || line.startsWith('npm ')) {
        assert.fail(`${rel}: unexpected command ${line}`);
      }
      for (const match of line.matchAll(/--[a-z][a-z-]*/g)) {
        assert.ok(FLAGS.has(match[0]), `${rel}: unknown flag ${match[0]} in "${line}"`);
      }
    }
  }
});

test('install docs describe exactly the bundle channel and the frozen legacy channel', () => {
  const install = read('docs/install.md');
  for (const heading of ['## Install', '## Upgrade', '## Rollback', '## Uninstall', '## Offline and private downloads']) {
    assert.ok(install.includes(heading), `docs/install.md is missing ${heading}`);
  }
  assert.match(install, /--bundle/);
  assert.match(install, /--projection/);
  assert.match(install, /frozen|冻结|legacy/i);
  assert.doesNotMatch(install, /\bnpx\b|\bnpm\s+install\b|\byarn\b|\bpnpm\b/);
});

test('the layout document lists every top-level module that exists', () => {
  const layout = read('docs/layout.md');
  const dirs = [
    'assembler', 'bin', 'core', 'docs', 'examples', 'installer', 'ir', 'projection',
    'runtime/agent-native', 'runtime/runner/contract', 'runtime/runner/engine', 'runtime/runner/projection',
    'runtime/runner/schema', 'runtime/shared', 'scripts', 'test', 'web',
  ];
  for (const dir of dirs) {
    assert.ok(layout.includes(dir), `docs/layout.md does not mention ${dir}`);
    assert.ok(existsSync(join(REPO, ...dir.split('/'))), `${dir} does not exist`);
  }
  assert.ok(layout.includes('hm2b-framework'));
  assert.ok(layout.includes('hm2b-runner'));
});

test('GLOSSARY carries the new vocabulary and marks the retired one', () => {
  const glossary = read('GLOSSARY.md');
  for (const term of ['bundle', 'manifest', 'stage', 'step', 'task', 'role', 'skill', 'constitution', 'IR',
    'projection', 'target', 'capability', 'obligation', 'degradation', 'receipt', 'runtime receipt',
    'pre-projected payload', 'canonical options', 'ownership', 'shared root', 'adopt', 'takeover']) {
    assert.match(glossary, new RegExp(`\\*\\*${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*|^\\| \`?${term}`, 'im'), `GLOSSARY is missing ${term}`);
  }
  assert.match(glossary, /retired|退役/i);
});

test('GLOSSARY defines the placeholder and install vocabulary', () => {
  const glossary = read('GLOSSARY.md');
  for (const term of ['placeholder', 'projection options', 'install root', 'install identity']) {
    const pattern = new RegExp(`^\\*\\*${term}\\*\\*:`, 'm');
    assert.match(glossary, pattern, `GLOSSARY is missing ${term}`);
  }
  assert.match(glossary, /^## 领域$/m);
  assert.match(glossary, /^## 退役词汇$/m);
});

test('CHANGELOG records the P6 cutover', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /## \[0\.1\.0\]/);
  assert.match(changelog, /P6|cutover/i);
});

test('the compatibility document is the generated framework/engine/projection matrix', () => {
  const compat = read('docs/compat.md');
  assert.match(compat, /\| Framework \| `hm2b-framework` \| `0\.1\.0` \|/);
  assert.match(compat, /\| Engine \| `hm2b-runner` \| `0\.1\.0` \|/);
  assert.match(compat, /\| Projection \| `agent-native` \|/);
  assert.match(compat, /\| Projection \| `runner` \|/);
  assert.doesNotMatch(compat, /adapter/i);
});
