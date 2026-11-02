/**
 * opencode target descriptor (#98, decision #71 §10.1, #72 §5).
 *
 * Data only: capability matrix, permission mapping, file layout and the
 * Markdown byte shell. The shared driver (`runtime/shared/render-role.js`)
 * owns naming, field states, placeholder instructions and exposure.
 *
 * opencode V1 discovers project agents at `.opencode/agents/<name>.md`; the
 * file name is the agent name (there is no `name` field). It also reads the
 * shared `.agents/skills` root.
 */
import { perRoleRoleFiles } from '../role-files.js';

const TOKENS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'web'];

/**
 * Neutral token -> opencode `permission` literals.
 *
 * opencode V1 has no standalone `write` permission: the `edit` permission
 * gates edit, write and patch (`opencode debug agent` on 1.19.5 shows a
 * `write:` rule has no effect, while `edit:` toggles both `tools.edit` and
 * `tools.write`). Using `edit` for the `write` token is therefore the only
 * expressible mapping; asymmetric edit/write requests are recorded as
 * `degraded` instead of silently widening or narrowing the write surface.
 */
const PERMISSIONS = Object.freeze({
  read: ['read'],
  write: ['edit'],
  edit: ['edit'],
  glob: ['glob'],
  grep: ['grep'],
  bash: ['bash'],
  task: ['task'],
  web: ['webfetch', 'websearch'],
});

/** Emission order of permission keys in the rendered frontmatter. */
const PERMISSION_ORDER = Object.freeze([
  'read',
  'edit',
  'glob',
  'grep',
  'bash',
  'task',
  'webfetch',
  'websearch',
]);

const CAPABILITIES = Object.freeze({
  state: 'unavailable',
  gates: 'degraded',
  outputs: 'degraded',
  subagents: 'native',
  skills: 'adapted',
  preload: 'unavailable',
  'stage-invocation': 'native',
  'skill-invocation': 'native',
});

const CAPABILITY_NOTES = Object.freeze({
  state: '无 runner：没有状态文件，进度与续跑由执行者维护',
  gates: '命令原文 + 超时写入阶段技能；执行者运行并自证，机器不强制',
  outputs: 'glob 原样列出自检清单；回执逐项写存在/缺失，机器不检查',
  subagents: '角色定义落在 .opencode/agents，opencode 按文件名自动发现；Task 工具按名派发',
  skills: '技能安装到 .agents/skills；名字加 bundle 前缀，语义不变',
  preload: 'opencode agent md 无按角色预载字段，预载正文没有落点',
  'stage-invocation': '阶段技能可经 skill 工具单独加载',
  'skill-invocation': '技能副本可经 skill 工具单独加载',
});

function modeLiteral(mode) {
  if (mode === 'any') return 'all';
  if (mode === 'primary') return 'primary';
  return 'subagent';
}

function exposureOf(mode) {
  if (mode === 'any') return 'both';
  if (mode === 'primary') return 'primary';
  return 'subagent';
}

/**
 * Build the permission decision map from the shared tool view.
 *
 * Returns `{decisions, conflict}`; `conflict` is non-null only when the
 * requested edit/write pair cannot be expressed by the single `edit` key.
 */
function permissionDecisions(role, tools) {
  const decisions = new Map();
  let conflict = null;
  if (role.tools !== undefined) {
    const effective = tools.effective;
    const allowEdit = effective.has('edit');
    const allowWrite = effective.has('write');
    if (allowEdit === allowWrite) {
      decisions.set('edit', allowEdit ? 'allow' : 'deny');
    } else {
      const kept = allowEdit ? 'edit' : 'write';
      const lost = allowEdit ? 'write' : 'edit';
      decisions.set('edit', 'deny');
      conflict = {
        reason: `opencode 用同一个 edit 权限门禁 edit/write，无法只允许 ${kept} 而拒绝 ${lost}`,
        effect: `edit 与 write 一并 deny：${lost} 的拒绝生效，${kept} 也被过度收紧`,
      };
    }
    decisions.set('read', effective.has('read') ? 'allow' : 'deny');
    decisions.set('glob', effective.has('glob') ? 'allow' : 'deny');
    decisions.set('grep', effective.has('grep') ? 'allow' : 'deny');
    decisions.set('bash', effective.has('bash') ? 'allow' : 'deny');
    decisions.set('task', effective.has('task') ? 'allow' : 'deny');
    const allowWeb = effective.has('web');
    for (const literal of PERMISSIONS.web) decisions.set(literal, allowWeb ? 'allow' : 'deny');
  } else if (role.tools_deny !== undefined) {
    const deny = tools.deny;
    const denyEdit = deny.has('edit');
    const denyWrite = deny.has('write');
    if (denyEdit || denyWrite) {
      decisions.set('edit', 'deny');
      if (denyEdit !== denyWrite) {
        const denied = denyEdit ? 'edit' : 'write';
        const lost = denyEdit ? 'write' : 'edit';
        conflict = {
          reason: `opencode 用同一个 edit 权限门禁 edit/write，无法只拒绝 ${denied}`,
          effect: `${lost} 也被一并 deny（写入面被过度收紧）`,
        };
      }
    }
    for (const token of ['read', 'glob', 'grep', 'bash', 'task', 'web']) {
      if (!deny.has(token)) continue;
      for (const literal of PERMISSIONS[token]) decisions.set(literal, 'deny');
    }
  }
  return { decisions, conflict };
}

export const opencodeTarget = Object.freeze({
  id: 'opencode',
  name: 'opencode (V1)',
  default: true,
  mirrorsSharedSkills: true,
  capabilities: CAPABILITIES,
  capabilityNotes: CAPABILITY_NOTES,
  layout: Object.freeze({
    skillsRoot: '.agents/skills',
    agentsRoot: '.opencode/agents',
    group: 'shared-skills',
  }),
  renderTargetFiles: (args) => perRoleRoleFiles(args),
  role: Object.freeze({
    format: 'md',
    extension: 'md',
    formatName: 'md',
    identity: Object.freeze({ state: 'adapted', reason: '文件名即渲染名；opencode 无 name 字段' }),
    basename: (name) => `${name}.md`,
    exposure({ mode }) {
      return exposureOf(mode);
    },
    fieldStates(role, tools) {
      const states = {};
      if (role.title !== undefined) {
        states.title = { state: 'unavailable', reason: 'opencode 无展示名槽', effect: '展示名丢弃，只保留 description' };
      }
      if (role.mode !== undefined) {
        states.mode = { state: 'native', reason: 'mode: subagent/primary/all 与 IR 三值精确对应' };
      }
      if (role.model !== undefined) {
        states.model = {
          state: 'degraded',
          reason: 'opencode 的 model 需要 provider/model-id 字面量',
          effect: '省略 model，继承父会话模型',
        };
      }
      if (role.effort !== undefined) {
        states.effort = { state: 'unavailable', reason: 'opencode V1 无推理强度字段', effect: 'effort 偏好丢弃' };
      }
      const { conflict } = permissionDecisions(role, tools);
      if (role.tools !== undefined) {
        states.tools = conflict === null
          ? { state: 'adapted', reason: 'permission 白名单：8 个 token 全落到 opencode 字面量（write 由 edit 承载）' }
          : { state: 'degraded', reason: conflict.reason, effect: conflict.effect };
      }
      if (role.tools_deny !== undefined) {
        states.tools_deny = conflict === null
          ? { state: 'adapted', reason: 'permission: deny（web 拆成 webfetch + websearch；write 由 edit 承载）' }
          : { state: 'degraded', reason: conflict.reason, effect: conflict.effect };
      }
      if (role.skills !== undefined) {
        states.skills = {
          state: 'unavailable',
          reason: 'opencode agent md 无按角色预载字段',
          effect: '预载丢弃；技能仍在会话内可经 skill 工具调用',
        };
      }
      return states;
    },
    render({ role, instructions, tools, helpers }) {
      const fm = [
        `description: ${helpers.yamlScalar(role.description)}`,
        `mode: ${modeLiteral(role.mode)}`,
      ];
      const { decisions } = permissionDecisions(role, tools);
      if (decisions.size > 0) {
        fm.push('permission:');
        for (const literal of PERMISSION_ORDER) {
          const decision = decisions.get(literal);
          if (decision !== undefined) fm.push(`  ${literal}: ${decision}`);
        }
      }
      return helpers.mdDocument(fm, instructions);
    },
  }),
});

export { PERMISSIONS, PERMISSION_ORDER, TOKENS };
