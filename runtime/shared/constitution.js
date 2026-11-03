/**
 * Constitution injection block (#73 §5.3, spec §8).
 *
 * The text is markers + one visible line + the verbatim body. The trinary
 * state (`absent` / `present` / `placeholder`) is the only representation
 * consumers use; a boolean erases "declared but not written yet".
 */

export const CONSTITUTION_SCHEMA = 'hm2b.constitution-block/v1';

const BANNER_PRESENT = '> **项目宪法（constitution）** — 项目级规则，先于本步任务书生效；与任务书冲突时以本段为准。';
const BANNER_PLACEHOLDER = '> **占位（placeholder）** 本宪法本期未实现：不构成生效规则；如有正文，仅为草稿，不得据此推断约束。';

function assertMount(mount) {
  if (mount === null || typeof mount !== 'object') {
    throw new Error('PROJECTION_IR_UNSUPPORTED: constitution mount must be an object');
  }
  if (mount.scope !== 'global') {
    throw new Error(`PROJECTION_IR_UNSUPPORTED: constitution scope ${String(mount.scope)} is not supported by v1 consumers`);
  }
  if (typeof mount.placeholder !== 'boolean') {
    throw new Error('PROJECTION_IR_UNSUPPORTED: constitution placeholder must be boolean');
  }
  if (typeof mount.body !== 'string') {
    throw new Error('PROJECTION_IR_UNSUPPORTED: constitution body must be a string');
  }
}

/**
 * `absent | present | placeholder` for an IR `constitution` array.
 * Non-global and multi-mount arrays are rejected, never silently ignored.
 */
export function constitutionState(mounts) {
  if (mounts === undefined || mounts === null) return 'absent';
  if (!Array.isArray(mounts)) {
    throw new Error('PROJECTION_IR_UNSUPPORTED: constitution must be an array');
  }
  if (mounts.length === 0) return 'absent';
  if (mounts.length !== 1) {
    throw new Error('PROJECTION_IR_UNSUPPORTED: hm2b.ir/v2 carries at most one constitution mount');
  }
  const mount = mounts[0];
  assertMount(mount);
  return mount.placeholder ? 'placeholder' : 'present';
}

/** The one block text: machine markers, a single visible line, verbatim body. */
export function constitutionBlock(mount) {
  assertMount(mount);
  const lines = [`<!-- constitution:begin scope=${mount.scope} placeholder=${mount.placeholder} -->`];
  lines.push(mount.placeholder ? BANNER_PLACEHOLDER : BANNER_PRESENT);
  lines.push('');
  if (mount.body !== '') {
    const body = mount.body.endsWith('\n') ? mount.body.slice(0, -1) : mount.body;
    lines.push(body);
    lines.push('');
  }
  lines.push('<!-- constitution:end -->');
  return `${lines.join('\n')}\n`;
}
