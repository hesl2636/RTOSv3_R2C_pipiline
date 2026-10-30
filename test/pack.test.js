import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeTwoStepProject } from './helpers/two-step.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'r2c.js');
const SKILLS = join(REPO, 'pack', 'skills');
const COMMANDS = join(REPO, 'pack', 'commands');

const SKILL_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const COMMAND_IDS = [
  'r2c-analysis',
  'r2c-cancel',
  'r2c-pause',
  'r2c-resume',
  'r2c-run',
  'r2c-status',
  'r2c-upload',
].sort();

const BANNER =
  '> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤；执行细节以调用它的任务书为准，禁止按本技能臆测流程。';

const HEADINGS = ['## 用途', '## 何时调用', '## 输入 → 输出', '## 占位期行为', '## 实现归属'];

const GROUPS = {
  A: {
    members: [
      'r2c-design',
      'r2c-imdesign',
      'r2c-implement-redblue',
      'r2c-verify-rb',
      'r2c-build-redblue',
      'r2c-review',
      'red-blue',
      'subagent-driven-development',
      'using-workflow',
      'workflow-core',
    ],
    line: (id) =>
      `按调用方任务书内联执行子步骤；产物首行写 \`> 占位：${id} 未实现（<date>）\`，提交时 \`--note placeholder:${id}\`。`,
  },
  B: {
    members: [
      'codebase-search',
      'code-research',
      'sr-miner',
      'ar-miner',
      'v3-kb',
      'v3-query-symbol',
      'v3-check-symbol-context',
      'v3-hm-kernel',
      'aceharness-rag',
    ],
    line: (id) =>
      `改用 agent 内置检索（读文件 / glob / 正则）完成同等取证，并在产物中标注信息来源；\`--note placeholder:${id}\`。`,
  },
  C: {
    members: [
      'req-analysis',
      'req-design',
      'req-formal-verif',
      'design-gen',
      'writing-plans',
      'semantic-equiv',
      'executing-plans',
    ],
    line: () =>
      '按任务书手工产出该技能的交付物，首行写占位标记；门禁照常判定，不为占位放宽。',
  },
  D: {
    members: [
      'v3-personal-pipeline',
      'v3-commit',
      'all-build-single-package',
      'all-multirepo-upload',
      'all-cleancode',
      'all-securec-replace',
      'cleancode-scanfix',
      'huawei-c-coding-standard',
      'r2c-push-mr',
    ],
    line: (id) =>
      `不得伪造执行结果；工具不可用时如实报「${id} 不可用」，交由 gate/expect 判定（通常是 exit 3 → paused）。`,
  },
};

const GROUP_OF = new Map();
for (const [group, spec] of Object.entries(GROUPS)) {
  for (const id of spec.members) GROUP_OF.set(id, group);
}

const EXPECTED_RUNNERS = {
  'r2c-run': '<runner> run --input "$ARGUMENTS"',
  'r2c-status': '<runner> status',
  'r2c-pause': '<runner> pause',
  'r2c-resume': '<runner> resume',
  'r2c-cancel': '<runner> cancel',
};

const FORBIDDEN_COMMAND_TEXT = [
  '${',
  'node_modules',
  '@codeagent3-temp',
  'harness-engine',
  '--registry',
  'npx',
  'LEGACY_',
  'CA_UPLOAD_FORCE',
  'CLAUDE_',
  'CODEX_',
  '.codex/',
  '.opencode/',
  '.omp/',
  '.dsh/',
  'state.json',
  'events.jsonl',
  '.r2c/runs',
  'RTOSv3_R2C_pipiline',
];

function skillDirs() {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Parse a frontmatter file, failing on any line outside `key: value`. */
function splitFrontmatter(raw, file) {
  const text = raw.replace(/\r\n?/g, '\n');
  assert.ok(text.startsWith('---\n'), `${file}: first line must be ---`);
  const lines = text.split('\n');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, `${file}: missing closing ---`);
  const fields = [];
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z][a-z0-9-]*): (.*)$/.exec(line);
    assert.ok(match, `${file}: malformed frontmatter line ${JSON.stringify(line)}`);
    fields.push([match[1], match[2]]);
  }
  return {
    keys: fields.map(([key]) => key),
    fields: Object.fromEntries(fields),
    body: lines.slice(end + 1).join('\n'),
    lineCount: lines.length,
  };
}

function sectionBody(body, heading) {
  const start = body.indexOf(`${heading}\n`);
  assert.ok(start >= 0, `missing section ${heading}`);
  const rest = body.slice(start + heading.length + 1);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

test('the 35 skills are minimal, legal placeholders with one fixed group behavior', () => {
  const dirs = skillDirs().sort();
  assert.equal(dirs.length, 35, `expected 35 skill directories, got ${dirs.length}`);

  const mapped = [...GROUP_OF.keys()].sort();
  assert.deepEqual(mapped, dirs, 'group table must cover every skill directory exactly once');
  assert.equal(GROUPS.A.members.length, 10);
  assert.equal(GROUPS.B.members.length, 9);
  assert.equal(GROUPS.C.members.length, 7);
  assert.equal(GROUPS.D.members.length, 9);

  for (const id of dirs) {
    const file = join(SKILLS, id, 'SKILL.md');
    const text = readFileSync(file, 'utf8');
    assert.ok(statSync(file).size > 0, `${id}: SKILL.md must not be empty`);
    assert.ok(SKILL_NAME.test(id), `${id}: directory is not lowercase kebab`);
    assert.ok(id.length <= 32, `${id}: directory name exceeds 32 characters`);
    assert.ok(!['synced', 'anthropic-skills'].includes(id), `${id}: reserved skill name`);

    const { keys, fields, body, lineCount } = splitFrontmatter(text, id);
    assert.deepEqual(keys, ['name', 'description'], `${id}: frontmatter must have exactly name + description`);
    assert.equal(fields.name, id, `${id}: name must equal the directory`);
    assert.ok(SKILL_NAME.test(fields.name), `${id}: name is not lowercase kebab`);
    assert.ok(fields.name.length <= 32, `${id}: name exceeds 32 characters`);

    const description = fields.description;
    assert.ok(description.length > 0, `${id}: description is empty`);
    assert.ok(description.length <= 200, `${id}: description exceeds 200 characters`);
    assert.ok(description.includes('占位'), `${id}: description must contain 占位`);
    assert.ok(!description.includes(': '), `${id}: description must not contain an ASCII colon-space`);
    assert.ok(!description.includes('<') && !description.includes('>'), `${id}: description must not contain angle brackets`);

    const headings = body.match(/^#{1,2} .+$/gm) ?? [];
    assert.deepEqual(
      headings,
      [`# ${id}`, ...HEADINGS],
      `${id}: body must have the H1 plus exactly the five fixed H2 sections`,
    );
    assert.equal(headings.length, 6, `${id}: body must contain six heading sections`);
    assert.ok(body.includes(BANNER), `${id}: missing placeholder banner`);
    assert.equal(body.split('> **占位（placeholder）**').length - 1, 1, `${id}: banner must appear once`);

    const purpose = sectionBody(body, '## 用途');
    assert.ok(purpose.length > 0, `${id}: 用途 must not be empty`);
    const when = sectionBody(body, '## 何时调用');
    assert.ok(when.includes(id), `${id}: 何时调用 must name the skill`);
    const io = sectionBody(body, '## 输入 → 输出');
    assert.match(io, /\| 输入 \| 输出 \|/, `${id}: 输入 → 输出 must be the fixed table`);
    const behavior = sectionBody(body, '## 占位期行为');
    assert.equal(behavior, GROUPS[GROUP_OF.get(id)].line(id), `${id}: 占位期行为 must match its group line`);
    const owner = sectionBody(body, '## 实现归属');
    assert.ok(owner.length > 0, `${id}: 实现归属 must not be empty`);

    assert.ok(lineCount <= 40, `${id}: placeholder body must stay near 20 lines, got ${lineCount}`);
  }
});

test('pack/commands holds exactly the seven canonical r2c ids with minimal frontmatter', () => {
  const files = readdirSync(COMMANDS)
    .filter((name) => name.endsWith('.md'))
    .sort();
  assert.deepEqual(
    files,
    COMMAND_IDS.map((id) => `${id}.md`),
    'commands/ must contain exactly the seven canonical ids',
  );

  const dirs = new Set(skillDirs());
  for (const id of COMMAND_IDS) {
    assert.ok(!dirs.has(id), `${id}: command id collides with a skill directory`);
    const file = join(COMMANDS, `${id}.md`);
    const { keys, fields, body } = splitFrontmatter(readFileSync(file, 'utf8'), id);
    assert.deepEqual(
      keys,
      id === 'r2c-run' ? ['description', 'argument-hint'] : ['description'],
      `${id}: frontmatter must only keep description${id === 'r2c-run' ? ' + argument-hint' : ''}`,
    );
    assert.ok(fields.description.length > 0, `${id}: description is empty`);
    assert.ok(!keys.includes('name'), `${id}: command frontmatter must not declare name`);
    if (id === 'r2c-run') {
      assert.equal(fields['argument-hint'], '"[request]"', 'r2c-run: argument-hint must be "[request]"');
    }

    for (const forbidden of FORBIDDEN_COMMAND_TEXT) {
      assert.ok(!body.includes(forbidden), `${id}: body must not contain ${JSON.stringify(forbidden)}`);
    }

    const runnerLines = body.split('\n').filter((line) => line.startsWith('<runner>'));
    if (id === 'r2c-upload' || id === 'r2c-analysis') {
      assert.deepEqual(runnerLines, [], `${id}: must not invoke a nonexistent engine subcommand`);
      assert.match(body, /plugins\/(upload|analysis)\//, `${id}: must point at its frozen plugin`);
    } else {
      assert.deepEqual(runnerLines, [EXPECTED_RUNNERS[id]], `${id}: must invoke exactly one engine subcommand`);
    }
    if (id === 'r2c-run') {
      assert.ok(body.includes('$ARGUMENTS'), 'r2c-run: body must pass $ARGUMENTS');
    }
  }
});

function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'r2c-pack-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'r2c-pack-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeTwoStepProject(root);
  return { root, outside };
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.R2C_SESSION_ID;
  delete env.R2C_PROJECT_ROOT;
  return env;
}

function cli(args, { cwd }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? REPO,
    encoding: 'utf8',
    env: cleanEnv(),
  });
}

function cliJson(args, options) {
  const result = cli([...args, '--json'], options);
  const lines = result.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got ${JSON.stringify(result.stdout)}`);
  return { result, envelope: JSON.parse(lines[0]) };
}

test('submit --note placeholder is recorded in events without pausing the run', (t) => {
  const { root, outside } = tempProject(t);
  const started = cliJson(['run', '--project-root', root], { cwd: outside });
  assert.equal(started.result.status, 0, started.result.stderr);

  const runId = started.envelope.run_id;
  const sessionId = started.envelope.session_id;
  const note = 'placeholder:req-analysis';

  const submitted = cliJson(
    ['submit', '--project-root', root, '--session-id', sessionId, '--step', 'step-a', '--note', note],
    { cwd: outside },
  );
  assert.equal(submitted.result.status, 0, submitted.result.stderr);
  assert.equal(submitted.envelope.step.id, 'step-b');

  const events = readFileSync(join(root, '.r2c', 'runs', runId, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const record = events.find(
    (event) => event.kind === 'step' && event.event === 'submitted' && event.step?.id === 'step-a',
  );
  assert.ok(record, 'missing submit event for step-a');
  assert.equal(record.note, note, 'submit event must carry the placeholder note');
  assert.equal(
    events.filter((event) => JSON.stringify(event).includes('placeholder')).length,
    1,
    'the note must not create an extra event kind',
  );

  const state = JSON.parse(
    readFileSync(join(root, '.r2c', 'runs', runId, 'state.json'), 'utf8'),
  );
  assert.equal(state.status, 'running', 'placeholder note must not pause the run');
  assert.equal(state.current_step_id, 'step-b');
  assert.equal(state.steps.find((step) => step.id === 'step-a').status, 'completed');
  assert.equal(state.steps.find((step) => step.id === 'step-b').status, 'active');
});
