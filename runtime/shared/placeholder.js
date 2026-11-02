/**
 * Placeholder text shared by every projection (#72 §6, #73 §5.3, #65 §12).
 *
 * A placeholder is never silent: the projected artifact keeps one visible
 * banner and one machine marker. Only the role text is injected as
 * instructions; skill/constitution banners belong to their own documents.
 */

const BANNERS = {
  role: '> **占位（placeholder）** 本角色由规范包声明为占位：未提供角色正文。',
  skill: '> **占位（placeholder）** 本技能本期未实现：正文只声明契约，不含可执行步骤。',
  constitution: '> **占位（placeholder）** 本宪法本期未实现：不构成生效规则；如有正文，仅为草稿，不得据此推断约束。',
};

/** One visible banner line for `role`, `skill` or `constitution`. */
export function placeholderBanner(kind, id) {
  const banner = BANNERS[kind];
  if (banner === undefined) {
    throw new Error(`PROJECTION_INTERNAL: unknown placeholder kind ${String(kind)}`);
  }
  if (typeof id !== 'string' || id === '') {
    throw new Error('PROJECTION_INTERNAL: placeholder id must be a non-empty string');
  }
  return banner;
}

/**
 * The role placeholder instructions (byte-exact, five targets share it).
 * Accepts a role object (`{id}`) or the bare role id.
 */
export function placeholderInstructions(role) {
  const id = typeof role === 'string' ? role : role?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error('PROJECTION_INTERNAL: placeholder role needs an id');
  }
  return [
    BANNERS.role,
    '',
    '按当前步骤的任务书执行；不要臆测本角色未声明的专有职责。',
    '',
    `<!-- r2c:placeholder role=${id} -->`,
    '',
  ].join('\n');
}
