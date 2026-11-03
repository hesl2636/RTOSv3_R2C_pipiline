/**
 * Agent-native baseline regression anchor (#101).
 *
 * The sample bundle projected with the canonical options (five targets, all 35
 * skills) is the release oracle: 98 files / 45 degradations / 40 capability
 * rows. The CLI is the only entry point — the fixture records contract
 * artefacts (path→sha256, result digest, resolved options, metadata, capability
 * rows, degradations, roles.json bytes), never renderer intermediates.
 *
 * Byte-total reconciliation with the prototype's 143,338 B: the retired
 * `.dsh/agent-native/<ns>.cordis.patch.yml` (3,615 B) is replaced 1:1 by
 * `.dsh/agent-native/<ns>.roles.md` (2,261 B), and `roles.json` gained 636 B of
 * target-field metadata from #98/#99. 143,338 − 3,615 + 2,261 + 636 = 142,620.
 * The `r2c` → `hm2b` product rename adds 37 B: 20 role placeholder markers
 * (`<!-- r2c:placeholder` → `<!-- hm2b:placeholder`), 16 submit markers
 * (`# r2c-submit` → `# hm2b-submit`) and the `roles.json` schema id, one byte
 * each. 142,620 + 37 = 142,657.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
import { canonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'hm2b-assembler.js');
const IR = join(ROOT, 'test/fixtures/ir/workflow.ir.json');
const FIXTURES = join(ROOT, 'test/fixtures/projection');
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, 'agent-native-baseline.json'), 'utf8'));
const ROLES_JSON_FIXTURE = join(FIXTURES, 'agent-native-roles.json');

const TARGETS = ['claude-code', 'codex', 'dsh', 'omp', 'opencode'];
const SHARED = ['codex', 'dsh', 'omp', 'opencode'];
const AGENT_CARRIERS = ['claude-code', 'codex', 'omp', 'opencode'];
const NS = 'rtosv3-drvport';
const IR_DIGEST = '34d55ee62bf284594218d4923b0eafa267799edb1edbbeb7bb313a6f2ab0bc04';

// Hard anchors from the ticket; the byte total is the recomputed baseline.
const BASELINE = { files: 98, bytes: 142657, degradations: 45, capabilities: 40, warnings: 1 };
const RUNNER = { files: 45, degradations: 4, capabilities: 8, warnings: 0 };

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Contract digest of a CLI summary: everything the projection promises. */
function snapshotDigest(data) {
  return sha256Hex(canonicalJson({
    projection: data.projection,
    ir: data.ir,
    targets: data.targets,
    coverage: data.coverage,
    options: data.options,
    files: data.files.map(({ path, targets, kind, mode, sha256: hash }) => ({ path, targets, kind, mode, sha256: hash })),
    capabilityReport: data.capabilityReport,
    degradations: data.degradations,
    warnings: data.warnings,
    metadata: data.metadata,
  }));
}

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function project({ projection = 'agent-native', ir = IR, out, extra = [] } = {}) {
  const args = ['project', ir, '--projection', projection];
  if (out !== undefined) args.push('--out', out);
  args.push(...extra, '--json');
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'the JSON envelope is one line');
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  return envelope.data;
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

function product(out, path) {
  return readFileSync(join(out, ...path.split('/')), 'utf8');
}

/** `F = (1+S+K)·[claude] + (1+S+K)·[shared≠∅] + R·|{claude,codex,omp,opencode}| + [dsh ∧ R>0] + 1`. */
function fileCount({ stages, skills, roles, targets }) {
  const claude = targets.includes('claude-code') ? 1 : 0;
  const shared = targets.some((target) => SHARED.includes(target)) ? 1 : 0;
  const carriers = AGENT_CARRIERS.filter((target) => targets.includes(target)).length;
  const dshCatalogue = targets.includes('dsh') && roles > 0 ? 1 : 0;
  return (1 + stages + skills) * (claude + shared) + roles * carriers + dshCatalogue + 1;
}

test('agent-native baseline matches the frozen contract snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-baseline-an-'));
  try {
    const out = join(dir, 'out');
    const data = project({ out });

    assert.deepEqual(data.counts, { ...BASELINE });
    assert.deepEqual(data.targets, TARGETS);
    assert.deepEqual({ id: data.ir.id, version: data.ir.version, digest: data.ir.digest }, {
      id: NS,
      version: '1.0.0',
      digest: IR_DIGEST,
    });

    assert.deepEqual(data.options, SNAPSHOT.options, 'resolved options echo');
    assert.deepEqual(data.metadata, SNAPSHOT.metadata, 'metadata');
    assert.deepEqual(data.capabilityReport, SNAPSHOT.capabilityReport, 'capability rows');
    assert.deepEqual(data.degradations, SNAPSHOT.degradations, 'degradations');
    assert.deepEqual(data.warnings, SNAPSHOT.warnings, 'warnings');
    assert.deepEqual(data.coverage, SNAPSHOT.coverage, 'coverage');

    const files = data.files.map(({ path, sha256: hash }) => ({ path, sha256: hash }));
    assert.deepEqual(files, SNAPSHOT.files);
    assert.deepEqual(files.map((file) => file.path), [...files.map((file) => file.path)].sort());
    assert.equal(new Set(files.map((file) => file.path)).size, files.length, 'paths are unique');
    assert.equal(snapshotDigest(data), SNAPSHOT.resultDigest, 'result digest');

    const rolesPath = data.metadata.artifacts['roles-json'];
    assert.equal(rolesPath, `.agents/agent-native/${NS}/roles.json`);
    const rolesBytes = readFileSync(join(out, ...rolesPath.split('/')));
    assert.equal(rolesBytes.length, SNAPSHOT.rolesJson.bytes);
    assert.equal(sha256(rolesBytes), SNAPSHOT.rolesJson.sha256);
    assert.deepEqual(rolesBytes, readFileSync(ROLES_JSON_FIXTURE), 'roles.json contract bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the counting formula reproduces 98 files for K=35 and 52 for K=12', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-baseline-formula-'));
  try {
    const full = project({ out: join(dir, 'full') });
    const roles = Object.keys(full.metadata.idMap['claude-code'].roles).length;
    const stages = full.options.stageOrder.length;
    const skills = full.options.skills.length;
    assert.equal(stages, 4);
    assert.equal(skills, 35);
    assert.equal(roles, 4);
    assert.equal(fileCount({ stages, skills, roles, targets: full.targets }), 98);
    assert.equal(fileCount({ stages, skills, roles, targets: full.targets }), full.counts.files);

    const reduced = project({
      out: join(dir, 'reduced'),
      extra: ['--skills', full.options.skills.slice(0, 12).join(',')],
    });
    assert.equal(reduced.options.skills.length, 12);
    assert.equal(reduced.counts.files, 52);
    assert.equal(
      fileCount({ stages, skills: 12, roles, targets: reduced.targets }),
      reduced.counts.files,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two CLI runs on the same input are byte-identical with a stable digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-baseline-det-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    const first = project({ out: a });
    const second = project({ out: b });
    assert.equal(treeHash(a), treeHash(b));
    assert.equal(snapshotDigest(first), snapshotDigest(second));
    assert.equal(snapshotDigest(first), SNAPSHOT.resultDigest);
    assert.deepEqual(first.files, second.files);
    assert.deepEqual(readFileSync(join(a, '.agents', 'agent-native', NS, 'roles.json')), readFileSync(join(b, '.agents', 'agent-native', NS, 'roles.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('40 placeholders are visible in the products (1 constitution + 4 roles + 35 skills)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-baseline-ph-'));
  try {
    const out = join(dir, 'out');
    const data = project({ out });
    const placeholders = data.metadata.placeholders;
    assert.equal(placeholders.constitution, 'placeholder');
    assert.deepEqual(placeholders.roles, ['bys-architect', 'bys-designer', 'bys-impl-lead', 'bys-release-lead']);
    assert.equal(placeholders.skills.length, 35);
    assert.equal(1 + placeholders.roles.length + placeholders.skills.length, 40);

    // 1 constitution placeholder: every stage skill carries the inline block, in both roots.
    for (const root of ['.claude', '.agents']) {
      for (const stage of data.options.stageOrder) {
        const text = product(out, `${root}/skills/${NS}-stage-${stage}/SKILL.md`);
        assert.match(text, /<!-- constitution:begin scope=global placeholder=true -->/, `${root} ${stage}`);
      }
    }

    // 35 skill placeholders: banner + frontmatter flag, mirrored byte-identically.
    for (const skill of placeholders.skills) {
      const claude = product(out, `.claude/skills/${NS}-skill-${skill}/SKILL.md`);
      const shared = product(out, `.agents/skills/${NS}-skill-${skill}/SKILL.md`);
      assert.equal(claude, shared, `${skill} copies`);
      assert.match(shared, /^placeholder: true$/m, skill);
      assert.match(shared, /> \*\*占位（placeholder）\*\*/, skill);
    }

    // 4 role placeholders: one marker per role in each of the five target carriers.
    const catalogue = product(out, `.dsh/agent-native/${NS}.roles.md`);
    for (const role of placeholders.roles) {
      const marker = `<!-- hm2b:placeholder role=${role} -->`;
      assert.equal(catalogue.split(marker).length - 1, 1, `dsh catalogue ${role}`);
      for (const path of [
        `.claude/agents/${NS}-${role}.md`,
        `.codex/agents/${NS}-${role}.toml`,
        `.omp/agents/${NS}-${role}.md`,
        `.opencode/agents/${NS}-${role}.md`,
      ]) {
        assert.equal(product(out, path).split(marker).length - 1, 1, `${path} ${role}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner baseline stays at 45 files / 4 degradations / 8 capability rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-baseline-runner-'));
  try {
    const data = project({ projection: 'runner', out: join(dir, 'out') });
    assert.deepEqual(data.targets, ['runner']);
    assert.equal(data.counts.files, RUNNER.files);
    assert.equal(data.counts.degradations, RUNNER.degradations);
    assert.equal(data.counts.capabilities, RUNNER.capabilities);
    assert.equal(data.counts.warnings, RUNNER.warnings);
    assert.equal(data.files.length, RUNNER.files);
    assert.deepEqual(data.options.targets, ['runner']);
    assert.equal(data.options.skills.length, 35);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one changed IR byte changes the IR digest, the result digest and the dependent hashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm2b-baseline-mut-'));
  try {
    const bytes = Buffer.from(readFileSync(IR));
    const marker = Buffer.from('"description": "');
    const offset = bytes.indexOf(marker) + marker.length;
    assert.ok(bytes.indexOf(marker) > 0 && bytes[offset] >= 0xe4 && bytes[offset] <= 0xe9);
    bytes[offset] = bytes[offset] === 0xe5 ? 0xe4 : 0xe5; // stays valid UTF-8
    const mutated = join(dir, 'workflow.ir.json');
    writeFileSync(mutated, bytes);
    assert.notEqual(sha256(readFileSync(mutated)), sha256(readFileSync(IR)));

    const data = project({ ir: mutated, out: join(dir, 'out') });
    assert.equal(data.counts.files, BASELINE.files);
    assert.notEqual(data.ir.digest, IR_DIGEST);
    assert.notEqual(snapshotDigest(data), SNAPSHOT.resultDigest);
    assert.notEqual(data.files.find((file) => file.path === `.agents/skills/${NS}-workflow/SKILL.md`).sha256,
      SNAPSHOT.files.find((file) => file.path === `.agents/skills/${NS}-workflow/SKILL.md`).sha256);
    assert.notEqual(data.files.find((file) => file.path === `.claude/skills/${NS}-workflow/SKILL.md`).sha256,
      SNAPSHOT.files.find((file) => file.path === `.claude/skills/${NS}-workflow/SKILL.md`).sha256);
    assert.notEqual(data.files.find((file) => file.path === `.agents/agent-native/${NS}/roles.json`).sha256,
      SNAPSHOT.rolesJson.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
