/**
 * Spec §9: the runner projection's `preload` capability is `unavailable`.
 *
 * The install never creates a host skill root (`.claude/skills`,
 * `.agents/skills`, ...), so a host role file must not name IR skills: those
 * names could never resolve. The loss is recorded per declared use and
 * `roles.json` reports `fields.skills: unavailable`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isCanonicalJson } from '../core/canonical-json.js';
import { sha256Hex } from '../core/node/sha256.js';
import { installRunnerProject, ROLES_JSON_PATH } from '../installer/runner.js';
import { IR_FIXTURE, customSample, fixedClock } from './helpers/install-fixture.js';

const ROLE_ID = 'bys-architect';
const SKILL_ID = 'v3-kb';
const HOST_TARGETS = ['claude-code', 'codex', 'omp', 'opencode'];
const AGENT_PATHS = {
  'claude-code': `.claude/agents/runner-${ROLE_ID}.md`,
  codex: `.codex/agents/runner-${ROLE_ID}.toml`,
  omp: `.omp/agents/runner-${ROLE_ID}.md`,
  opencode: `.opencode/agents/runner-${ROLE_ID}.md`,
};

function read(projectRoot, path) {
  return readFileSync(join(projectRoot, ...path.split('/')), 'utf8');
}

test('host roles never preload a skill the runner install did not place', (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hm2b-runner-preload-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const base = JSON.parse(readFileSync(IR_FIXTURE, 'utf8'));
  const { result, irBytes, ir } = customSample({
    irPatch: {
      skills: {
        ...base.skills,
        [SKILL_ID]: { description: 'Fixture skill declared by one role.', body: '\n# v3-kb\n' },
      },
      roles: {
        ...base.roles,
        [ROLE_ID]: { ...base.roles[ROLE_ID], skills: [SKILL_ID] },
      },
    },
  });
  const outcome = installRunnerProject({ result, irBytes, projectRoot, clock: fixedClock() });
  assert.equal(outcome.code, 'OK', outcome.message);

  const receipt = JSON.parse(read(projectRoot, outcome.receiptPath));

  // No host role file names the skill, and none carries an empty skills line
  // either: the field is dropped from the render input entirely.
  const agentFiles = receipt.files.filter((file) => file.kind === 'agent');
  assert.ok(agentFiles.length > 0);
  for (const file of agentFiles) {
    const text = read(projectRoot, file.path);
    assert.equal(/^skills:/m.test(text), false, `${file.path} must not render a skills line`);
    assert.equal(/^autoloadSkills:/m.test(text), false, `${file.path} must not render an autoloadSkills line`);
    assert.equal(text.includes(SKILL_ID), false, `${file.path} must not name ${SKILL_ID}`);
  }

  const claudePath = AGENT_PATHS['claude-code'];
  const claude = read(projectRoot, claudePath);
  assert.match(claude, new RegExp(`^name: runner-${ROLE_ID}$`, 'm'));
  assert.equal(claude.includes(ir.roles[ROLE_ID].description), true, 'role description is unchanged');
  assert.match(claude, /占位（placeholder）/, 'role instructions are unchanged');

  // roles.json reports the field as unavailable on every installed target and
  // keeps the rest of the role record intact.
  const rolesBytes = readFileSync(join(projectRoot, ...ROLES_JSON_PATH.split('/')));
  const rolesText = rolesBytes.toString('utf8');
  assert.equal(isCanonicalJson(rolesText), true);
  const roles = JSON.parse(rolesText);
  assert.equal(roles.ir.id, ir.id);
  assert.equal(roles.ir.version, ir.version);
  assert.equal(roles.ir.sha256, sha256Hex(irBytes));
  for (const target of HOST_TARGETS) {
    const role = roles.targets[target].roles.find((item) => item.id === ROLE_ID);
    assert.ok(role, target);
    assert.equal(role.artifact.path, AGENT_PATHS[target], target);
    assert.deepEqual(role.fields.skills.state, 'unavailable', target);
    assert.equal(typeof role.fields.skills.reason, 'string', target);
    assert.match(role.fields.skills.reason, /宿主技能根/, target);
    assert.match(role.fields.skills.effect, /不预载/, target);
    assert.ok(role.fields.description, target);
    assert.ok(role.fields.instructions, target);
    assert.equal(
      role.artifact.sha256,
      sha256Hex(Buffer.from(read(projectRoot, role.artifact.path), 'utf8')),
      `${target} artifact hash matches the written file`,
    );
  }
  assert.equal(rolesText.includes(SKILL_ID), false);

  // The receipt records one degradation at the declared use point per host and
  // its roles.json hash stays consistent with the bytes it wrote.
  const usePoint = `/roles/${ROLE_ID}/skills/0`;
  for (const target of HOST_TARGETS) {
    const record = receipt.degradations.find(
      (item) => item.code === 'CAP_PRELOAD_UNAVAILABLE' && item.target === target && item.pointer === usePoint,
    );
    assert.ok(record, `${target} records ${usePoint}`);
    assert.equal(record.capability, 'preload');
    assert.equal(record.level, 'unavailable');
    assert.equal(record.field, 'skills');
    assert.match(record.reason, /preload/);
    assert.match(record.effect, /不预载/);
  }

  const metadata = receipt.files.find((file) => file.path === ROLES_JSON_PATH);
  assert.ok(metadata, 'receipt owns roles.json');
  assert.equal(metadata.kind, 'metadata');
  assert.equal(metadata.origin, 'installer');
  assert.equal(metadata.sha256, sha256Hex(rolesBytes));
  assert.equal(sha256Hex(read(projectRoot, ROLES_JSON_PATH)), metadata.sha256);
});
