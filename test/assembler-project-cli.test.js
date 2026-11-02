/**
 * `r2c-assembler project` end-to-end (#95, CONTEXT §7).
 *
 * The CLI is the highest seam: compile the sample zip to an IR file, project
 * it into a temp directory, and assert the on-disk tree, the single-line
 * envelope and the no-partial-write failure behaviour.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileBundle } from '../assembler/compile.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { IR_FILENAME } from '../ir/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'r2c-assembler.js');
const ZIP = join(ROOT, 'examples/rtosv3/dist/bundle-rtosv3-drvport-v1.0.0.zip');

function compileTo(dir) {
  const compiled = compileBundle(new Uint8Array(readFileSync(ZIP)), { inflateRaw, sha256: sha256Hex });
  assert.equal(compiled.ok, true);
  const path = join(dir, IR_FILENAME);
  writeFileSync(path, compiled.irBytes);
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const absolute = join(dir, name);
    if (statSync(absolute).isDirectory()) out.push(...walk(absolute));
    else out.push(absolute);
  }
  return out;
}

function treeHash(dir) {
  const hash = createHash('sha256');
  for (const file of walk(dir)) {
    hash.update(relative(dir, file).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('project writes the 45-file Claude tree and prints one envelope line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-project-cli-'));
  try {
    const irPath = compileTo(dir);
    const out = join(dir, 'out');
    const result = run([ 'project', irPath, '--projection', 'agent-native', '--target', 'claude-code', '--out', out, '--json' ]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const envelope = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(envelope), ['ok', 'command', 'code', 'run_id', 'session_id', 'step', 'data', 'error']);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, 'project');
    assert.equal(envelope.data.targets[0], 'claude-code');
    assert.equal(envelope.data.counts.files, 45);
    assert.equal(envelope.data.counts.degradations, 5);
    assert.equal(envelope.data.counts.capabilities, 8);
    assert.equal(envelope.data.files.length, 45);

    const files = walk(out);
    assert.equal(files.length, 45);
    assert.equal(files.some((file) => /(?:^|[\\/])CLAUDE\.md$/.test(file)), false);
    assert.equal(files.some((file) => /\.r2c[\\/]/.test(file)), false);
    assert.equal(existsSync(join(out, '.agents', 'agent-native', 'rtosv3-drvport', 'roles.json')), true);
    const stage = readFileSync(join(out, '.claude', 'skills', 'rtosv3-drvport-stage-analysis-design', 'SKILL.md'), 'utf8');
    assert.ok(stage.indexOf('<!-- constitution:begin') < stage.indexOf('# 阶段'));
    assert.equal(stage.includes('{{submit}}'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project is byte-deterministic across two output directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-project-det-'));
  try {
    const irPath = compileTo(dir);
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    assert.equal(run(['project', irPath, '--projection', 'agent-native', '--target', 'claude-code', '--out', a]).status, 0);
    assert.equal(run(['project', irPath, '--projection', 'agent-native', '--target', 'claude-code', '--out', b]).status, 0);
    assert.equal(treeHash(a), treeHash(b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI options narrow skills and reorder stages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-project-opt-'));
  try {
    const irPath = compileTo(dir);
    const out = join(dir, 'out');
    const result = run([
      'project', irPath, '--projection', 'agent-native', '--target', 'claude-code',
      '--stage-order', 'verification,implementation,detailed-design,analysis-design',
      '--skills', 'ar-miner,code-research,codebase-search,design-gen,executing-plans,huawei-c-coding-standard,r2c-build-redblue,r2c-design,r2c-imdesign,r2c-implement-redblue,r2c-push-mr,r2c-review',
      '--out', out, '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.data.counts.files, 22);
    assert.equal(envelope.data.counts.warnings, 1);
    assert.equal(envelope.data.warnings[0].code, 'STAGE_ORDER_OVERRIDDEN');
    assert.deepEqual(envelope.data.coverage.stages, ['verification', 'implementation', 'detailed-design', 'analysis-design']);
    assert.equal(envelope.data.options.skills.length, 12);
    assert.equal(walk(out).length, 22);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid options fail with a stable code and write nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-project-bad-'));
  try {
    const irPath = compileTo(dir);
    const out = join(dir, 'out');
    const result = run(['project', irPath, '--projection', 'agent-native', '--target', 'nope', '--out', out, '--json']);
    assert.equal(result.status, 2);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'PROJECTION_TARGET_UNKNOWN');
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all five targets with 12 skills and a reversed stage order: 52 files, warnings only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-project-five-'));
  try {
    const irPath = compileTo(dir);
    const out = join(dir, 'out');
    const skills = Object.keys(JSON.parse(readFileSync(irPath, 'utf8')).skills).sort().slice(0, 12).reverse();
    const result = run([
      'project', irPath, '--projection', 'agent-native',
      '--stage-order', 'verification,implementation,detailed-design,analysis-design',
      '--skills', skills.join(','),
      '--out', out, '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.data.counts.files, 52);
    assert.equal(envelope.data.counts.capabilities, 40);
    assert.equal(envelope.data.counts.warnings, 2);
    assert.deepEqual(envelope.data.warnings.map((warning) => warning.code), ['SKILL_MIRRORED_ROOTS', 'STAGE_ORDER_OVERRIDDEN']);
    assert.deepEqual(envelope.data.targets, ['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
    assert.deepEqual(envelope.data.coverage.stages, ['verification', 'implementation', 'detailed-design', 'analysis-design']);
    assert.deepEqual(envelope.data.options.skills, [...skills].sort());
    assert.deepEqual(envelope.data.options.targets, ['claude-code', 'codex', 'dsh', 'omp', 'opencode']);
    assert.equal(envelope.data.options.ir.digest, sha256Hex(readFileSync(irPath)));
    assert.equal(walk(out).length, 52);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('r2c with 12 skills adjusts the payload to 22 files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-project-r2c-'));
  try {
    const irPath = compileTo(dir);
    const out = join(dir, 'out');
    const skills = Object.keys(JSON.parse(readFileSync(irPath, 'utf8')).skills).sort().slice(0, 12);
    const result = run(['project', irPath, '--projection', 'r2c', '--skills', skills.join(','), '--out', out, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.data.counts.files, 22);
    assert.deepEqual(envelope.data.options.targets, ['r2c']);
    assert.equal(envelope.data.options.skills.length, 12);
    assert.equal(envelope.data.capabilityReport.find((row) => row.capability === 'skills').level, 'unavailable');
    assert.equal(walk(out).length, 22);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown skills and stage ids are rejected through the CLI without output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2c-project-reject-'));
  try {
    const irPath = compileTo(dir);
    for (const args of [
      ['--skills', 'nope'],
      ['--stage-order', 'nope,implementation,detailed-design,analysis-design'],
    ]) {
      const out = join(dir, 'out');
      const result = run(['project', irPath, '--projection', 'agent-native', ...args, '--out', out, '--json']);
      assert.equal(result.status, 2);
      const envelope = JSON.parse(result.stdout.trim());
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, 'PROJECTION_OPTIONS_INVALID');
      assert.equal(existsSync(out), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing input is a usage failure, not an internal error', () => {
  const result = run(['project', 'does-not-exist.json', '--projection', 'agent-native', '--json']);
  assert.equal(result.status, 2);
  const envelope = JSON.parse(result.stdout.trim());
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'IR_INPUT_NOT_FOUND');
});
