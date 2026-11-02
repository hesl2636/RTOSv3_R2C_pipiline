/**
 * Task-book Markdown structure (decision #67 §9.3).
 *
 * One implementation shared by bundle validation (`checks/tasks.js`) and IR
 * validation (`IR_TASK_BODY_INVALID`), so a task that compiles can never fail
 * the IR's own section check (or vice versa).
 */
export const TASK_HEADINGS = Object.freeze(['Agent 角色设定', '任务', '约束条件', '提交']);

const FENCE_RE = /^```/;
const H2_RE = /^## (.*)$/;
export const SUBMIT_TOKEN = '{{submit}}';

function isContentLine(line) {
  const trimmed = line.trim();
  return trimmed !== '' && trimmed !== '---';
}

export function countNonEmptyLines(lines) {
  let count = 0;
  for (const line of lines) if (isContentLine(line)) count += 1;
  return count;
}

function checkSubmitSection(sectionLines, headingLine) {
  let open = null;
  const blocks = [];
  const outside = [];
  for (let index = 0; index < sectionLines.length; index += 1) {
    const line = sectionLines[index];
    const lineNumber = headingLine + index + 1;
    if (FENCE_RE.test(line)) {
      if (open === null) {
        open = { line: lineNumber, info: line.slice(3).trim(), content: [] };
      } else {
        blocks.push(open);
        open = null;
      }
      continue;
    }
    if (open !== null) open.content.push(line);
    else if (isContentLine(line)) outside.push(lineNumber);
  }

  let issue = null;
  if (open !== null) {
    issue = { rule: 'submit-marker', reason: 'code-block', line: open.line };
  } else if (blocks.length === 0) {
    issue = { rule: 'submit-marker', reason: 'code-block' };
  } else if (blocks.length > 1) {
    issue = { rule: 'submit-marker', reason: 'code-block', line: blocks[1].line };
  } else if (blocks[0].info !== '') {
    issue = { rule: 'submit-marker', reason: 'info-string', line: blocks[0].line };
  } else if (blocks[0].content.length !== 1 || blocks[0].content[0] !== SUBMIT_TOKEN) {
    issue = { rule: 'submit-marker', reason: 'block-content', line: blocks[0].line };
  } else if (outside.length > 0) {
    issue = { rule: 'submit-marker', reason: 'block-content', line: outside[0] };
  }

  const tokenInsideBlock = issue === null;
  return { issue, tokenInsideBlock };
}

/**
 * Scan a task body.
 *
 * @param {string} body
 * @param {{ lineOffset?: number }} [options] lineOffset added to reported lines
 * @returns {{
 *   issues: Array<{rule: string, heading?: string, line?: number, reason?: string}>,
 *   headings: Array<{heading: string, line: number, index: number}>,
 *   nonEmptyLines: number,
 * }}
 */
export function scanTaskBody(body, options = {}) {
  const offset = options.lineOffset ?? 0;
  const lines = typeof body === 'string' ? body.split('\n') : [];
  const headings = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = H2_RE.exec(line);
    if (match !== null) {
      headings.push({ heading: match[1].trimEnd(), line: offset + index + 1, index });
    }
  }

  const issues = [];
  const expected = TASK_HEADINGS;
  const seen = new Set();
  const firstIndex = new Map();
  for (const found of headings) {
    if (!expected.includes(found.heading)) {
      issues.push({ rule: 'h2-unexpected', heading: found.heading, line: found.line });
      continue;
    }
    if (seen.has(found.heading)) {
      issues.push({ rule: 'h2-unexpected', heading: found.heading, line: found.line });
      continue;
    }
    seen.add(found.heading);
    firstIndex.set(found.heading, found);
  }

  for (const heading of expected) {
    if (!seen.has(heading)) issues.push({ rule: 'section-missing', heading });
  }

  const order = headings
    .filter((found) => expected.includes(found.heading) && firstIndex.get(found.heading) === found)
    .map((found) => found.heading);
  const expectedOrder = expected.filter((heading) => seen.has(heading));
  if (order.length > 0 && order.join('\u0000') !== expectedOrder.join('\u0000')) {
    issues.push({ rule: 'section-order', line: firstIndex.get(order[0])?.line });
  }

  for (const heading of expected) {
    const found = firstIndex.get(heading);
    if (found === undefined) continue;
    let endIndex = lines.length;
    for (const next of headings) {
      if (next.index > found.index) {
        endIndex = next.index;
        break;
      }
    }
    const sectionLines = lines.slice(found.index + 1, endIndex);
    if (heading !== '提交') {
      if (countNonEmptyLines(sectionLines) === 0) issues.push({ rule: 'section-empty', heading });
      continue;
    }

    const submit = checkSubmitSection(sectionLines, found.line);
    if (submit.issue !== null) {
      issues.push(submit.issue);
    } else {
      const tokenCount = (typeof body === 'string' ? body.match(/\{\{submit\}\}/g) : null)?.length ?? 0;
      if (tokenCount !== 1) issues.push({ rule: 'submit-marker', reason: 'token-count' });
      else if (!submit.tokenInsideBlock) issues.push({ rule: 'submit-marker', reason: 'token-outside-block' });
    }
  }

  return { issues, headings, nonEmptyLines: countNonEmptyLines(lines) };
}
