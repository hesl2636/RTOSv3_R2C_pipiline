/**
 * Task-book checks (decision #67 §7.4 + §9.3).
 *
 * Tasks may omit frontmatter, but the body must carry the four fixed H2
 * sections and exactly one `{{submit}}` code block. The structural scanner is
 * shared with IR validation.
 */
import { codePointLength } from '../../core/code-point.js';
import { parseFrontmatter } from '../frontmatter.js';
import { scanTaskBody, FENCE_RE, TASK_HEADINGS } from '../markdown.js';
import { nonEmptyLines } from '../util.js';

const TASK_FRONTMATTER_KEYS = ['id', 'title', 'description'];
const LEAK_RE = /\br2c-(status|run|submit|pause|resume|cancel)\b|\br2c (status|run|submit|pause|resume|cancel)\b|\.r2c\/engine\b/;

function frontmatterError(context, path, line, reason, message) {
  context.fail(path, 'BUNDLE_FRONTMATTER_INVALID', message, {
    line,
    details: { reason },
  });
}

function checkFields(context, path, fields, stem) {
  if (fields === null) return;
  for (const key of Object.keys(fields)) {
    if (key === 'placeholder') {
      context.fail(path, 'BUNDLE_TASK_PLACEHOLDER_FORBIDDEN', 'task books must not be placeholders', {
        details: { key },
      });
      continue;
    }
    if (!TASK_FRONTMATTER_KEYS.includes(key)) {
      context.fail(path, 'BUNDLE_FRONTMATTER_UNKNOWN_KEY', `unknown task frontmatter key: ${key}`, {
        details: { key },
      });
    }
  }
  if (fields.id !== undefined) {
    if (typeof fields.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.id) || fields.id.length > 64) {
      context.fail(path, 'BUNDLE_TASK_ID_INVALID', 'task frontmatter id is invalid', {
        details: { where: 'frontmatter', value: fields.id },
      });
    } else if (fields.id !== stem) {
      context.fail(path, 'BUNDLE_TASK_ID_MISMATCH', 'task id does not match the file name', {
        details: { declared: stem, stem, actual: fields.id },
      });
    }
  }
  if (fields.title !== undefined) {
    if (typeof fields.title !== 'string' || codePointLength(fields.title) < 1 || codePointLength(fields.title) > 120) {
      context.fail(path, 'BUNDLE_SCHEMA_INVALID', 'task title must be 1-120 characters', {
        pointer: '/title',
        details: { pointer: '/title', rule: 'length' },
      });
    }
  }
  if (fields.description !== undefined) {
    if (typeof fields.description !== 'string' || codePointLength(fields.description) < 1
      || codePointLength(fields.description) > 500) {
      context.fail(path, 'BUNDLE_SCHEMA_INVALID', 'task description must be 1-500 characters', {
        pointer: '/description',
        details: { pointer: '/description', rule: 'length' },
      });
    }
  }
}

/** Body with the `## 提交` section blanked line-for-line (leak scan scope). */
function bodyOutsideSubmit(body) {
  const lines = body.split('\n');
  let fenced = false;
  let inSubmit = false;
  const scanned = [];
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      scanned.push(inSubmit ? '' : line);
      continue;
    }
    if (!fenced && /^## /.test(line)) {
      inSubmit = line.trimEnd() === '## 提交';
      scanned.push('');
      continue;
    }
    scanned.push(inSubmit ? '' : line);
  }
  return scanned.join('\n');
}

function checkLeak(context, path, body, lineOffset) {
  const scanned = bodyOutsideSubmit(body);
  const match = LEAK_RE.exec(scanned);
  if (match === null) return;
  const line = scanned.slice(0, match.index).split('\n').length + lineOffset;
  context.warn(path, 'BUNDLE_TASK_RUNTIME_LEAK', 'task body mentions a runner command', {
    line,
    details: { token: match[0] },
  });
}

function mapIssue(context, path, issue, lineOffset) {
  if (issue.rule === 'section-missing') {
    context.fail(path, 'BUNDLE_TASK_SECTION_MISSING', `missing task section: ${issue.heading}`, {
      details: { heading: issue.heading },
    });
    return;
  }
  if (issue.rule === 'section-order') {
    context.fail(path, 'BUNDLE_TASK_SECTION_ORDER', 'task sections are out of order', {
      line: issue.line ?? null,
      details: { expected: [...TASK_HEADINGS], found: issue.found ?? [] },
    });
    return;
  }
  if (issue.rule === 'section-empty') {
    context.fail(path, 'BUNDLE_TASK_SECTION_EMPTY', `task section is empty: ${issue.heading}`, {
      details: { heading: issue.heading },
    });
    return;
  }
  if (issue.rule === 'h2-unexpected') {
    context.fail(path, 'BUNDLE_TASK_H2_UNEXPECTED', 'unexpected H2 heading in task book', {
      line: issue.line ?? null,
      details: { heading: issue.heading, line: issue.line ?? null },
    });
    return;
  }
  context.fail(path, 'BUNDLE_TASK_SUBMIT_MARKER', 'submit section must be exactly one {{submit}} block', {
    line: issue.line ?? null,
    details: { reason: issue.reason },
  });
}

export function check(context) {
  if (context.skipped.tasks) return;
  if (context.declaredValid.tasks === false) return;
  const declared = context.declared.tasks;

  for (const entry of context.entries.values()) {
    if (!entry.path.startsWith('tasks/')) continue;
    const match = /^tasks\/([^/]+)\.md$/.exec(entry.path);
    if (match === null) continue;
    if (!declared.includes(match[1])) {
      context.fail(entry.path, 'BUNDLE_TASK_FILE_UNDECLARED', 'task file is not declared in bundle.json.tasks', {
        details: { id: match[1] },
      });
    }
  }

  const records = new Map();
  for (const id of declared) {
    const path = `tasks/${id}.md`;
    if (!context.entries.has(path)) {
      if (!context.rejectedPaths.has(path)) {
        context.fail(path, 'BUNDLE_TASK_FILE_MISSING', `declared task '${id}' has no task file`, {
          details: { id },
        });
      }
      continue;
    }
    const entry = context.entries.get(path);
    if (entry.size > context.limits.MAX_TASK_BYTES) {
      context.fail(path, 'BUNDLE_TASK_TOO_LARGE', 'task file exceeds the size limit', {
        details: { limit: context.limits.MAX_TASK_BYTES, actual: entry.size },
      });
      continue;
    }
    const text = context.texts.get(path);
    if (text === undefined) continue;

    const parsed = parseFrontmatter(text, { path });
    context.diagnostics.push(...parsed.diagnostics);
    // S6: a frontmatter parse failure suppresses every frontmatter-derived
    // check (id/title/description/placeholder); the body is independent.
    if (parsed.diagnostics.length === 0) checkFields(context, path, parsed.fields, id);

    const lineOffset = parsed.bodyLine - 1;
    if (nonEmptyLines(parsed.body).length === 0) {
      context.fail(path, 'BUNDLE_TASK_BODY_EMPTY', 'task body is empty');
      continue;
    }
    const scan = scanTaskBody(parsed.body, { lineOffset });
    for (const issue of scan.issues) mapIssue(context, path, issue, lineOffset);
    checkLeak(context, path, parsed.body, lineOffset);
    records.set(id, {
      id,
      path,
      bytes: entry.data,
      text,
      fields: parsed.fields,
      body: parsed.body,
    });
  }
  context.tasks = records;
}
