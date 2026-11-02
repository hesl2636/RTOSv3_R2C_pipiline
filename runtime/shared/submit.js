/**
 * `{{submit}}` replacement (spec §9/§10, #71 §5.2).
 *
 * Only the marker/comment rules are shared; each projection renders its own
 * text. The replacement is a literal slice, never `String#replace`, so `$&`,
 * `$1` and friends inside the replacement cannot be reinterpreted.
 */

export const SUBMIT_TOKEN = '{{submit}}';

/** Number of `{{submit}}` occurrences in a task body. Contract is exactly 1. */
export function countSubmitTokens(body) {
  if (typeof body !== 'string') return 0;
  let count = 0;
  let index = body.indexOf(SUBMIT_TOKEN);
  while (index !== -1) {
    count += 1;
    index = body.indexOf(SUBMIT_TOKEN, index + SUBMIT_TOKEN.length);
  }
  return count;
}

/** Replace the single token; zero or multiple occurrences is an internal error. */
export function replaceSubmitToken(body, text) {
  if (typeof body !== 'string') {
    throw new Error('PROJECTION_INTERNAL: task body must be a string');
  }
  if (typeof text !== 'string') {
    throw new Error('PROJECTION_INTERNAL: submit replacement must be a string');
  }
  const count = countSubmitTokens(body);
  if (count !== 1) {
    throw new Error(`PROJECTION_INTERNAL: task body has ${count} ${SUBMIT_TOKEN} tokens (expected 1)`);
  }
  const index = body.indexOf(SUBMIT_TOKEN);
  return `${body.slice(0, index)}${text}${body.slice(index + SUBMIT_TOKEN.length)}`;
}

function receiptText(stepId) {
  return [
    `# r2c-submit: step=${stepId}`,
    '# 无 runner：提交 = 在本步回复末尾输出回执，包含',
    `#   1) 上一行原样（r2c-submit: step=${stepId}）`,
    '#   2) 上面每条门禁命令的完整输出与退出码',
    '#   3) 「提交前必须存在」逐项核对：存在 / 缺失',
    '# 任一门禁非零退出或有缺失项：不得进入下一阶段，并在回执中写明原因。',
  ].join('\n');
}

function commandText(stepIds) {
  const suffix = stepIds.length === 1 ? ` --step ${stepIds[0]}` : '';
  return `node .r2c/bin/r2c.js submit${suffix}`;
}

/**
 * `submitReplacement({taskId, stepIds, mode})` ->
 * `{text, mode: 'command'|'receipt'}`.
 *
 * - `receipt` (agent-native): six shell-comment lines, first line
 *   `# r2c-submit: step=<id>`; the task must be rendered for one step.
 * - `command` (r2c): `--step` only when exactly one step references the task.
 */
export function submitReplacement({ taskId, stepIds, mode = 'command' } = {}) {
  if (typeof taskId !== 'string' || taskId === '') {
    throw new Error('PROJECTION_INTERNAL: submit needs a task id');
  }
  if (!Array.isArray(stepIds) || stepIds.some((id) => typeof id !== 'string' || id === '')) {
    throw new Error('PROJECTION_INTERNAL: submit needs step ids');
  }
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error('PROJECTION_INTERNAL: submit step ids must be unique');
  }
  if (mode === 'receipt') {
    if (stepIds.length !== 1) {
      throw new Error('PROJECTION_INTERNAL: the receipt text needs exactly one step id');
    }
    return { text: receiptText(stepIds[0]), mode };
  }
  if (mode === 'command') {
    return { text: commandText(stepIds), mode };
  }
  throw new Error(`PROJECTION_INTERNAL: unknown submit mode ${String(mode)}`);
}
