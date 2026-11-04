import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEVERITY,
  buildReport,
  compareDiagnostics,
  dedupeDiagnostics,
  makeDiagnostic,
  reportFailureSummary,
  toEnvelope,
} from '../core/diagnostics.js';

function diag(path, code, extra = {}) {
  return makeDiagnostic({ severity: SEVERITY.ERROR, code, path, message: extra.message ?? code, ...extra });
}

test('makeDiagnostic keeps the documented field order', () => {
  const diagnostic = makeDiagnostic({
    severity: SEVERITY.WARNING,
    code: 'BUNDLE_TASK_RUNTIME_LEAK',
    path: 'tasks/a.md',
    line: 9,
    message: 'task body mentions a runner command',
    details: { token: 'hm2b-status' },
  });
  assert.deepEqual(Object.keys(diagnostic), [
    'severity',
    'code',
    'path',
    'line',
    'pointer',
    'message',
    'details',
  ]);
  assert.equal(diagnostic.pointer, null);
  const bare = makeDiagnostic({ severity: SEVERITY.ERROR, code: 'C', path: '', message: 'm' });
  assert.deepEqual(Object.keys(bare), ['severity', 'code', 'path', 'line', 'pointer', 'message']);
  assert.equal(bare.line, null);
});

test('diagnostic messages are single line and clipped by code point', () => {
  const clipped = makeDiagnostic({
    severity: SEVERITY.ERROR,
    code: 'C',
    path: 'p',
    message: `first\nsecond ${'𠀀'.repeat(200)}`,
  });
  assert.doesNotMatch(clipped.message, /\n/);
  assert.ok([...clipped.message].length <= 120);
  assert.ok(clipped.message.endsWith('…'));
});

test('diagnostics sort by path, pointer (null first), line (null first), code', () => {
  const list = [
    diag('b.md', 'CODE_B'),
    diag('a.md', 'CODE_C', { line: 2 }),
    diag('a.md', 'CODE_A', { line: 10 }),
    diag('a.md', 'CODE_A', { line: 2, pointer: '/z' }),
    diag('a.md', 'CODE_A', { line: 2, pointer: '' }),
    diag('a.md', 'CODE_B', { line: 2 }),
    diag('', 'CODE_Z'),
  ];
  const sorted = [...list].sort(compareDiagnostics);
  assert.deepEqual(
    sorted.map((item) => [item.path, item.pointer, item.line, item.code]),
    [
      ['', null, null, 'CODE_Z'],
      ['a.md', null, 2, 'CODE_B'],
      ['a.md', null, 2, 'CODE_C'],
      ['a.md', null, 10, 'CODE_A'],
      ['a.md', '', 2, 'CODE_A'],
      ['a.md', '/z', 2, 'CODE_A'],
      ['b.md', null, null, 'CODE_B'],
    ],
  );
});

test('dedupe keeps the first diagnostic per (code,path,pointer,line)', () => {
  const list = [
    diag('a', 'C', { message: 'first' }),
    diag('a', 'C', { message: 'second' }),
    diag('a', 'D'),
    diag('a', 'C', { line: 1 }),
  ];
  const deduped = dedupeDiagnostics(list);
  assert.equal(deduped.length, 3);
  assert.equal(deduped[0].message, 'first');
});

test('buildReport derives ok from errors and never from counts', () => {
  const report = buildReport({
    target: 'bundle',
    schema: 'hm2b.bundle/v1',
    artifact: { path: 'bundle.zip', bytes: 10, sha256: 'a'.repeat(64) },
    id: 'demo',
    version: '1.0.0',
    counts: { stages: 1, steps: 1, roles: 1, tasks: 1, skills: 1, constitutions: 0 },
    errors: [diag('b.md', 'C'), diag('a.md', 'C')],
    warnings: [diag('tasks/a.md', 'W')],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.counts, {
    stages: 1,
    steps: 1,
    roles: 1,
    tasks: 1,
    skills: 1,
    constitutions: 0,
    errors: 2,
    warnings: 1,
  });
  assert.equal(report.errors[0].path, 'a.md');
  assert.equal(report.warnings.length, 1);

  const valid = buildReport({
    target: 'bundle',
    schema: 'hm2b.bundle/v1',
    artifact: { path: 'bundle.zip', bytes: 10, sha256: 'a'.repeat(64) },
    id: 'demo',
    version: '1.0.0',
    errors: [],
    warnings: [diag('tasks/a.md', 'W')],
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.counts.errors, 0);
});

test('toEnvelope mirrors the hm2b envelope contract', () => {
  assert.deepEqual(
    toEnvelope({ command: 'bundle.validate', code: 0, data: { ok: true } }),
    {
      ok: true,
      command: 'bundle.validate',
      code: 0,
      run_id: null,
      session_id: null,
      step: null,
      data: { ok: true },
      error: null,
    },
  );
  const failure = toEnvelope({
    command: 'compiled-workflow.validate',
    code: 2,
    data: { ok: false },
    error: { code: 'COMPILED_WORKFLOW_INVALID', message: 'x', details: null },
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'COMPILED_WORKFLOW_INVALID');
});

test('reportFailureSummary uses a single distinct code and the summary otherwise', () => {
  const base = {
    target: 'bundle',
    schema: null,
    artifact: { path: 'bundle.zip', bytes: 1, sha256: null },
    id: null,
    version: null,
  };
  const single = buildReport({
    ...base,
    errors: [diag('a', 'BUNDLE_X', { message: 'only' })],
    warnings: [],
  });
  assert.deepEqual(reportFailureSummary(single, 'BUNDLE_INVALID'), {
    code: 'BUNDLE_X',
    message: 'only',
    details: { target: 'bundle', errors: 1, warnings: 0 },
  });

  const many = buildReport({
    ...base,
    errors: [diag('a', 'BUNDLE_X'), diag('b', 'BUNDLE_Y')],
    warnings: [diag('c', 'BUNDLE_W')],
  });
  const summary = reportFailureSummary(many, 'BUNDLE_INVALID');
  assert.equal(summary.code, 'BUNDLE_INVALID');
  assert.match(summary.message, /^bundle invalid: 2 error\(s\), first: a: /);
  assert.deepEqual(summary.details, { target: 'bundle', errors: 2, warnings: 1 });
});
