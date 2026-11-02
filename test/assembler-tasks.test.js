/**
 * Task-book contract (decision #67 §7.4/§7.5/§9.2/§9.3, spec §2).
 *
 * Every case goes through the public bytes-in/report-out entry point so the
 * codes, paths, lines and severities are the contract, not the internals.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../core/canonical-json.js';
import { inflateRaw } from '../core/node/inflate.js';
import { sha256Hex } from '../core/node/sha256.js';
import { compileBundle } from '../assembler/compile.js';
import { parseFrontmatter } from '../assembler/frontmatter.js';
import { validateBundle } from '../assembler/validate-bundle.js';
import { validateIr } from '../assembler/validate-ir.js';
import { MINIMAL_TASK, minimalZip } from './helpers/minimal-bundle.js';

const PRIMITIVES = { inflateRaw, sha256: sha256Hex };
const TASK_PATH = 'tasks/do-it.md';
const TASK_HEADINGS = ['Agent 角色设定', '任务', '约束条件', '提交'];

function taskReport(task) {
  return validateBundle(minimalZip({ overrides: { [TASK_PATH]: task } }), PRIMITIVES);
}

function codes(report) {
  return report.errors.map((diagnostic) => diagnostic.code);
}

function only(report) {
  assert.equal(report.errors.length, 1, JSON.stringify(report.errors));
  return report.errors[0];
}

/** 1-based line of the first occurrence of `needle` in a fixture. */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `fixture must contain ${needle}`);
  return text.slice(0, index).split('\n').length;
}

function compileTask(task) {
  const result = compileBundle(minimalZip({ overrides: { [TASK_PATH]: task } }), PRIMITIVES);
  assert.equal(result.ok, true, JSON.stringify(result.report.errors));
  return result;
}

function irOf(result) {
  return JSON.parse(new TextDecoder().decode(result.irBytes));
}

test('the frontmatter subset accepts flat scalars and block lists', () => {
  const parsed = parseFrontmatter(
    '---\nid: do-it\ntitle: Hello\nitems:\n  - read\n  - grep\n---\nbody text\n',
    { path: 'tasks/do-it.md' },
  );
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.fields, { id: 'do-it', title: 'Hello', items: ['read', 'grep'] });
  assert.equal(parsed.body, 'body text\n');
});

test('a task without frontmatter is legal', () => {
  const report = taskReport(MINIMAL_TASK);
  assert.equal(report.ok, true);
  assert.equal(report.counts.errors, 0);
  assert.equal(report.counts.warnings, 0);
});

test('nested maps are unsupported and reported once', () => {
  const task = `---\nid: do-it\nmeta:\n  nested: value\n---\n${MINIMAL_TASK}`;
  const report = taskReport(task);
  const diagnostic = only(report);
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_UNSUPPORTED');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.equal(diagnostic.line, 4);
  assert.equal(diagnostic.details.feature, 'nested');
});

test('flow sequences are unsupported', () => {
  const task = `---\nid: do-it\ntitle: [a, b]\n---\n${MINIMAL_TASK}`;
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_UNSUPPORTED');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.details.feature, 'flow');
});

test('quoted scalars are unsupported', () => {
  const task = `---\nid: do-it\ntitle: "quoted"\n---\n${MINIMAL_TASK}`;
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_UNSUPPORTED');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.details.feature, 'quoted');
});

test('comments are unsupported', () => {
  const wholeLine = `---\nid: do-it\n# a comment\n---\n${MINIMAL_TASK}`;
  const first = only(taskReport(wholeLine));
  assert.equal(first.code, 'BUNDLE_FRONTMATTER_UNSUPPORTED');
  assert.equal(first.line, 3);
  assert.equal(first.details.feature, 'comment');

  const inline = `---\nid: do-it\ntitle: value # a comment\n---\n${MINIMAL_TASK}`;
  const second = only(taskReport(inline));
  assert.equal(second.code, 'BUNDLE_FRONTMATTER_UNSUPPORTED');
  assert.equal(second.line, 3);
  assert.equal(second.details.feature, 'comment');
});

test('duplicate keys are invalid', () => {
  const task = `---\nid: do-it\nid: do-it\n---\n${MINIMAL_TASK}`;
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_INVALID');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.details.reason, 'duplicate-key');
});

test('a frontmatter parse failure suppresses derived frontmatter checks', () => {
  // The first `id` wins on parse, so an unsuppressed check would also report
  // BUNDLE_TASK_ID_MISMATCH for `other`; one root cause yields one diagnostic.
  const task = `---\nid: other\nid: do-it\n---\n${MINIMAL_TASK}`;
  const report = taskReport(task);
  assert.deepEqual(codes(report), ['BUNDLE_FRONTMATTER_INVALID']);
  assert.equal(report.errors[0].details.reason, 'duplicate-key');
});

test('unknown task frontmatter keys are rejected', () => {
  const task = `---\nid: do-it\nbogus: 1\n---\n${MINIMAL_TASK}`;
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_FRONTMATTER_UNKNOWN_KEY');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.deepEqual(diagnostic.details, { key: 'bogus' });
});

test('a task may not declare placeholder', () => {
  const task = `---\nplaceholder: true\n---\n${MINIMAL_TASK}`;
  const report = taskReport(task);
  assert.deepEqual(codes(report), ['BUNDLE_TASK_PLACEHOLDER_FORBIDDEN']);
  assert.equal(report.errors[0].path, TASK_PATH);
  assert.deepEqual(report.errors[0].details, { key: 'placeholder' });
});

test('task frontmatter id must be kebab-case and equal the file stem', () => {
  const mismatch = only(taskReport(`---\nid: other\n---\n${MINIMAL_TASK}`));
  assert.equal(mismatch.code, 'BUNDLE_TASK_ID_MISMATCH');
  assert.equal(mismatch.path, TASK_PATH);
  assert.deepEqual(mismatch.details, { declared: 'do-it', stem: 'do-it', actual: 'other' });

  const invalid = only(taskReport(`---\nid: Do_It\n---\n${MINIMAL_TASK}`));
  assert.equal(invalid.code, 'BUNDLE_TASK_ID_INVALID');
  assert.equal(invalid.details.where, 'frontmatter');
});

test('a missing section reports its heading', () => {
  const task = MINIMAL_TASK.replace('\n## 约束条件\n\n- 不要跳过任何一步。\n', '\n');
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_TASK_SECTION_MISSING');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.equal(diagnostic.line, null);
  assert.deepEqual(diagnostic.details, { heading: '约束条件' });
});

test('sections out of order report expected and found order', () => {
  const body = MINIMAL_TASK
    .replace('## Agent 角色设定', '## 任务')
    .replace('## 任务\n\n完成唯一一步。', '## Agent 角色设定\n\n完成唯一一步。');
  const task = `---\nid: do-it\n---\n${body}`;
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_TASK_SECTION_ORDER');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.equal(diagnostic.line, lineOf(task, '## 任务'));
  assert.deepEqual(diagnostic.details, {
    expected: TASK_HEADINGS,
    found: ['任务', 'Agent 角色设定', '约束条件', '提交'],
  });
});

test('extra H2 headings are reported with their line', () => {
  const task = `${MINIMAL_TASK}\n## 备注\n\n随便。\n`;
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_TASK_H2_UNEXPECTED');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.equal(diagnostic.line, lineOf(task, '## 备注'));
  assert.equal(diagnostic.details.heading, '备注');
  assert.equal(diagnostic.details.line, lineOf(task, '## 备注'));
});

test('a repeated section heading is unexpected, not a second section', () => {
  const task = MINIMAL_TASK.replace('## 约束条件', '## 任务');
  const report = taskReport(task);
  assert.ok(codes(report).includes('BUNDLE_TASK_H2_UNEXPECTED'));
  assert.ok(!codes(report).includes('BUNDLE_TASK_SECTION_ORDER'));
});

test('a section with only blank lines is empty', () => {
  const task = MINIMAL_TASK.replace('完成唯一一步。\n', '\n');
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_TASK_SECTION_EMPTY');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.deepEqual(diagnostic.details, { heading: '任务' });
});

test('H2 headings inside fenced blocks do not count as sections', () => {
  const task = MINIMAL_TASK.replace(
    '完成唯一一步。',
    '完成唯一一步。\n\n```md\n## 备注\n```',
  );
  const report = taskReport(task);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test('the submit section must hold exactly one empty-info block', () => {
  const cases = [
    {
      name: 'missing block',
      task: MINIMAL_TASK.replace('```\n{{submit}}\n```\n', ''),
      reason: 'code-block',
    },
    {
      name: 'info string',
      task: MINIMAL_TASK.replace('```\n{{submit}}', '```sh\n{{submit}}'),
      reason: 'info-string',
    },
    {
      name: 'two blocks',
      task: MINIMAL_TASK.replace('```\n{{submit}}\n```', '```\n{{submit}}\n```\n\n```\nextra\n```'),
      reason: 'code-block',
    },
    {
      name: 'one non-token line',
      task: MINIMAL_TASK.replace('{{submit}}', 'r2c submit --step do-it'),
      reason: 'block-content',
    },
    {
      name: 'trailing space in the token line',
      task: MINIMAL_TASK.replace('{{submit}}', '{{submit}} '),
      reason: 'block-content',
    },
    {
      name: 'content outside the block',
      task: MINIMAL_TASK.replace('## 提交\n', '## 提交\n\n说明。\n'),
      reason: 'block-content',
    },
  ];
  for (const { name, task, reason } of cases) {
    const report = taskReport(task);
    const diagnostic = only(report);
    assert.equal(diagnostic.code, 'BUNDLE_TASK_SUBMIT_MARKER', name);
    assert.equal(diagnostic.path, TASK_PATH, name);
    assert.equal(diagnostic.details.reason, reason, name);
  }
});

test('{{submit}} must appear exactly once in the whole body', () => {
  const task = MINIMAL_TASK.replace('完成唯一一步。', '完成唯一一步，然后 {{submit}}。');
  const diagnostic = only(taskReport(task));
  assert.equal(diagnostic.code, 'BUNDLE_TASK_SUBMIT_MARKER');
  assert.equal(diagnostic.details.reason, 'token-count');
});

test('runtime commands in the submit block are a submit marker error, not a leak', () => {
  const task = MINIMAL_TASK.replace('{{submit}}', 'r2c submit --step do-it');
  const report = taskReport(task);
  assert.deepEqual(codes(report), ['BUNDLE_TASK_SUBMIT_MARKER']);
  assert.equal(report.warnings.length, 0);
});

for (const [label, sentence, token] of [
  ['hyphen command', '先跑 r2c-status 看状态。', 'r2c-status'],
  ['spaced command', '先跑 r2c submit --step do-it 提交。', 'r2c submit'],
  ['engine path', '看 .r2c/engine/bin/r2c.js。', '.r2c/engine'],
]) {
  test(`a runtime leak is only a warning: ${label}`, () => {
    const task = MINIMAL_TASK.replace('完成唯一一步。', sentence);
    const report = taskReport(task);
    assert.equal(report.ok, true);
    assert.equal(report.counts.errors, 0);
    assert.equal(report.counts.warnings, 1);
    const [warning] = report.warnings;
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.code, 'BUNDLE_TASK_RUNTIME_LEAK');
    assert.equal(warning.path, TASK_PATH);
    assert.equal(warning.line, lineOf(task, sentence));
    assert.equal(warning.details.token, token);
  });
}

test('a leak warning does not block compilation or IR validation', () => {
  const task = MINIMAL_TASK.replace('完成唯一一步。', '先跑 r2c-status 看状态。');
  const compiled = compileTask(task);
  const ir = irOf(compiled);
  assert.ok(ir.tasks['do-it'].body.includes('r2c-status'));
  const irReport = validateIr(compiled.irBytes, { sha256: sha256Hex });
  assert.equal(irReport.ok, true, JSON.stringify(irReport.errors));
});

test('the 128 KiB task limit is inclusive and reports limit and actual', () => {
  const marker = '完成唯一一步。';
  const baseBytes = new TextEncoder().encode(MINIMAL_TASK).length;
  const padTo = (size) => MINIMAL_TASK.replace(marker, marker + 'x'.repeat(size - baseBytes));

  const atLimit = taskReport(padTo(128 * 1024));
  assert.equal(atLimit.ok, true, JSON.stringify(atLimit.errors));

  const overLimit = taskReport(padTo(128 * 1024 + 1));
  const diagnostic = only(overLimit);
  assert.equal(diagnostic.code, 'BUNDLE_TASK_TOO_LARGE');
  assert.equal(diagnostic.path, TASK_PATH);
  assert.deepEqual(diagnostic.details, { limit: 128 * 1024, actual: 128 * 1024 + 1 });
});

test('task text must be UTF-8, BOM-free, LF-only and newline-terminated', () => {
  const encoder = new TextEncoder();
  const withBom = new Uint8Array(3 + encoder.encode(MINIMAL_TASK).length);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(encoder.encode(MINIMAL_TASK), 3);

  const cases = [
    { name: 'BOM', task: withBom, reason: 'bom' },
    { name: 'CR', task: MINIMAL_TASK.replace(/\n/g, '\r\n'), reason: 'cr' },
    { name: 'missing final LF', task: MINIMAL_TASK.slice(0, -1), reason: 'missing-final-lf' },
    { name: 'invalid UTF-8', task: Uint8Array.of(0x23, 0x23, 0x20, 0xff, 0x0a), reason: 'utf8' },
  ];
  for (const { name, task, reason } of cases) {
    const report = taskReport(task);
    const diagnostic = only(report);
    assert.equal(diagnostic.code, 'BUNDLE_TEXT_ENCODING', name);
    assert.equal(diagnostic.path, TASK_PATH, name);
    assert.equal(diagnostic.details.reason, reason, name);
  }
});

test('an empty frontmatter block keeps body line numbers aligned', () => {
  const task = `---\n---\n\n${MINIMAL_TASK.replace('完成唯一一步。', '先跑 r2c-status 看状态。')}`;
  const report = taskReport(task);
  assert.equal(report.counts.warnings, 1);
  assert.equal(report.warnings[0].line, lineOf(task, '先跑 r2c-status'));
});

test('an empty or frontmatter-only task body reports only the body error', () => {
  for (const task of ['', '---\nid: do-it\n---\n']) {
    const report = taskReport(task);
    assert.deepEqual(codes(report), ['BUNDLE_TASK_BODY_EMPTY']);
    assert.equal(report.errors[0].path, TASK_PATH);
    assert.equal(report.errors[0].line, null);
  }
});

test('{{submit}} is retained verbatim in the IR', () => {
  const result = compileTask(MINIMAL_TASK);
  const body = irOf(result).tasks['do-it'].body;
  assert.equal(body, MINIMAL_TASK);
  assert.equal((body.match(/\{\{submit\}\}/g) ?? []).length, 1);
});

test('body slicing is byte-reversible and keeps leading blank lines', () => {
  const frontmatter = '---\nid: do-it\ntitle: 写交付摘要\n---\n';
  const task = `${frontmatter}\n\n${MINIMAL_TASK}`;
  const record = irOf(compileTask(task)).tasks['do-it'];
  assert.equal(record.body, `\n\n${MINIMAL_TASK}`);
  assert.equal(record.body, task.slice(frontmatter.length));
  assert.equal(record.title, '写交付摘要');
  assert.equal(record.source.sha256, sha256Hex(new TextEncoder().encode(task)));
});

test('IR validation owns the {{submit}} count', () => {
  const result = compileTask(MINIMAL_TASK);
  const ir = irOf(result);
  ir.tasks['do-it'].body = ir.tasks['do-it'].body
    .replace('完成唯一一步。', '完成唯一一步，然后 {{submit}}。');
  const report = validateIr(new TextEncoder().encode(canonicalJson(ir)), { sha256: sha256Hex });
  const diagnostic = report.errors.find((error) => error.code === 'IR_TASK_BODY_INVALID');
  assert.ok(diagnostic, JSON.stringify(report.errors));
  assert.equal(diagnostic.pointer, '/tasks/do-it/body');
  assert.equal(diagnostic.details.rule, 'submit-marker');
});

test('task diagnostics are deterministic and sorted', () => {
  const task = MINIMAL_TASK
    .replace('完成唯一一步。', '先跑 r2c-status 看状态。')
    .replace('\n## 约束条件\n\n- 不要跳过任何一步。\n', '\n');
  const first = taskReport(task);
  const second = taskReport(task);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const byPathLine = [...first.errors, ...first.warnings].map((d) => [d.path, d.line ?? 0]);
  const sorted = [...byPathLine].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  assert.deepEqual(byPathLine, sorted);
});
