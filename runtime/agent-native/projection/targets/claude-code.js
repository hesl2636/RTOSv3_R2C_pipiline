/**
 * Claude Code target descriptor (#95, decision #71 §10.1, #72 §5).
 *
 * Data only: capability matrix, tool/model mappings, file layout and the
 * Markdown byte shell. The shared driver (`runtime/shared/render-role.js`)
 * owns naming, field states, placeholder instructions and exposure.
 */
import { perRoleRoleFiles } from '../role-files.js';

const TOKENS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'web'];

const TOOL_NAMES = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  task: 'Task',
  web: 'WebFetch',
};

const TOOL_EXTRAS = { web: ['WebSearch'] };

const MODEL_ALIASES = Object.freeze({ fast: 'haiku', standard: 'sonnet', strong: 'opus' });

const CAPABILITIES = Object.freeze({
  state: 'unavailable',
  gates: 'degraded',
  outputs: 'degraded',
  subagents: 'native',
  skills: 'adapted',
  preload: 'native',
  'stage-invocation': 'native',
  'skill-invocation': 'native',
});

const CAPABILITY_NOTES = Object.freeze({
  state: '无 runner：没有状态文件，进度与续跑由执行者维护',
  gates: '命令原文 + 超时写入阶段技能；执行者运行并自证，机器不强制',
  outputs: 'glob 原样列出自检清单；回执逐项写存在/缺失，机器不检查',
  subagents: '角色定义落在 runtime 自动发现的项目目录',
  skills: '技能安装到 runtime 技能根；名字加 bundle 前缀，语义不变',
  preload: 'Claude skills: 整份注入',
  'stage-invocation': '阶段技能可单独加载',
  'skill-invocation': '技能副本可单独加载',
});

function claudeToolList(tokens) {
  const out = [];
  for (const token of TOKENS) {
    if (!tokens.has(token)) continue;
    out.push(TOOL_NAMES[token]);
    for (const extra of TOOL_EXTRAS[token] ?? []) out.push(extra);
  }
  return out;
}

export const claudeCodeTarget = Object.freeze({
  id: 'claude-code',
  name: 'Claude Code',
  default: true,
  capabilities: CAPABILITIES,
  capabilityNotes: CAPABILITY_NOTES,
  layout: Object.freeze({
    skillsRoot: '.claude/skills',
    agentsRoot: '.claude/agents',
    group: 'claude',
  }),
   renderTargetFiles: (args) => perRoleRoleFiles(args),
  role: Object.freeze({
    format: 'md',
    extension: 'md',
    formatName: 'md',
    identity: Object.freeze({ state: 'adapted', reason: '文件名 + frontmatter name 承载渲染名' }),
    basename: (name) => `${name}.md`,
    exposure({ mode }) {
      if (mode === 'primary') return 'primary';
      if (mode === 'any') return 'both';
      return 'subagent';
    },
    fieldStates(role) {
      const states = {};
      if (role.mode !== undefined) {
        states.mode = role.mode === 'primary'
          ? { state: 'adapted', reason: 'Claude 无 mode 字段；同一 md 既是子 agent 也可作会话人格', effect: '该角色也会出现在子 agent 列表里（过度暴露）' }
          : { state: 'adapted', reason: 'Claude 无 mode 字段；同一 md 既是子 agent 也可作会话人格' };
      }
      if (role.title !== undefined) {
        states.title = { state: 'unavailable', reason: 'Claude 无展示名槽', effect: '展示名丢弃，只保留 description' };
      }
      if (role.model !== undefined) {
        const alias = MODEL_ALIASES[role.model];
        states.model = alias === undefined
          ? { state: 'degraded', reason: `Claude 无能力档 ${role.model} 的别名`, effect: '省略 model，继承会话默认模型' }
          : { state: 'adapted', reason: `能力档 ${role.model} → ${alias}` };
      }
      if (role.effort !== undefined) {
        states.effort = { state: 'adapted', reason: 'effort: 1:1' };
      }
      if (role.tools !== undefined) {
        states.tools = { state: 'adapted', reason: '映射到 Claude 工具字面量' };
      }
      if (role.tools_deny !== undefined) {
        states.tools_deny = {
          state: 'adapted',
          reason: role.tools === undefined ? '写 disallowedTools' : '已从 allow-list 中移除',
        };
      }
      if (role.skills !== undefined) states.skills = { state: 'native' };
      return states;
    },
    render({ role, name, instructions, tools, skillNames, helpers }) {
      const fm = [`name: ${helpers.yamlScalar(name)}`, `description: ${helpers.yamlScalar(role.description)}`];
      if (role.model !== undefined) {
        const alias = MODEL_ALIASES[role.model];
        if (alias !== undefined) fm.push(`model: ${alias}`);
      }
      if (role.effort !== undefined) fm.push(`effort: ${helpers.yamlScalar(role.effort)}`);
      if (role.tools !== undefined) {
        const list = claudeToolList(tools.effective);
        if (list.length === 0) fm.push('tools: []');
        else fm.push('tools:', ...list.map((tool) => `  - ${tool}`));
      } else if (role.tools_deny !== undefined) {
        const list = claudeToolList(tools.deny);
        if (list.length === 0) fm.push('disallowedTools: []');
        else fm.push('disallowedTools:', ...list.map((tool) => `  - ${tool}`));
      }
      if (role.skills !== undefined) {
        const list = role.skills
          .map((skillId) => helpers.skillNameOf(skillNames, skillId))
          .filter((skillName) => typeof skillName === 'string' && skillName !== '');
        if (list.length === 0) fm.push('skills: []');
        else fm.push('skills:', ...list.map((skillName) => `  - ${helpers.yamlScalar(skillName)}`));
      }
      return helpers.mdDocument(fm, instructions);
    },
  }),
});

export { MODEL_ALIASES, TOKENS };
