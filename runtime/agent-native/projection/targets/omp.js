/**
 * omp (Oh My Pi) target descriptor (#97, decisions #71 §3.2/§10, #72 §5.2).
 *
 * Data only: capability matrix, tool/effort mappings, file layout and the
 * Markdown byte shell. The shared driver (`runtime/shared/render-role.js`)
 * owns naming, field states, placeholder instructions and exposure.
 *
 * Field facts (omp v18.15.0, `omp://task-agent-discovery.md`, `omp --help`,
 * `omp config set defaultThinkingLevel <invalid>`):
 * - project agents are `.omp/agents/*.md`; frontmatter `name`, `description`,
 *   `tools`, `model`, `thinking-level`, `autoloadSkills`, `spawns`;
 * - no primary-agent concept: `mode: primary` has no entry and is skipped;
 * - `autoloadSkills` injects skills of the parent session by name; unknown
 *   names are ignored (hence rendered names, never bare compiled workflow ids);
 * - supported effort levels are `minimal|low|medium|high|xhigh|max`, a
 *   superset of the compiled workflow ladder `low..max`, so every valid compiled workflow effort maps 1:1.
 */
import { perRoleRoleFiles } from '../role-files.js';
import { layoutSmoke, hostProfile } from './host.js';

const TOKENS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'web'];

const TOOL_NAMES = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  glob: 'glob',
  grep: 'grep',
  bash: 'bash',
  task: 'task',
  web: 'web_search',
};

/** omp `thinking-level` ladder (v18.15.0), lowest to highest. */
const EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

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
  subagents: '角色定义落在 .omp/agents；omp 自动发现并按名派发',
  skills: '技能安装到 .agents/skills；名字加 bundle 前缀，语义不变',
  preload: 'omp autoloadSkills 整份注入',
  'stage-invocation': '阶段技能可单独加载',
  'skill-invocation': '技能副本可单独加载；/skill:<name> 需开启 skills.enableSkillCommands',
});

function ompToolList(tokens) {
  const out = [];
  for (const token of TOKENS) {
    if (tokens.has(token)) out.push(TOOL_NAMES[token]);
  }
  return out;
}

/**
 * Map a compiled workflow effort onto omp's `thinking-level` ladder.
 *
 * The omp ladder is wider than the compiled workflow ladder, so `low..max` are identities.
 * A level from outside the ladder (a forward compiled workflow version) clamps down to the
 * nearest supported level — the top one — and the caller records the loss.
 */
export function clampEffort(effort) {
  const index = EFFORT_LEVELS.indexOf(effort);
  if (index !== -1) return { level: effort, clamped: false };
  return { level: EFFORT_LEVELS[EFFORT_LEVELS.length - 1], clamped: true };
}

function modelLiteral(ctx, tier) {
  const literal = ctx?.roleModels?.['omp']?.[tier];
  return typeof literal === 'string' && literal !== '' ? literal : undefined;
}

export const ompTarget = Object.freeze({
  id: 'omp',
  name: 'Oh My Pi (omp)',
  default: true,
  mirrorsSharedSkills: true,
  capabilities: CAPABILITIES,
  capabilityNotes: CAPABILITY_NOTES,
  ...hostProfile({
    detect: {"commands":[["omp","--version"]],"paths":["~/.omp/agent"]},
    assets: [
    Object.freeze({ path: 'runtime/agent-native/targets/omp/assets/mcp.json', sha256: 'd8e397af03b5b032f21d0aa967086f0c78b33c87b76f2e9898ae0a144df7de02' }),
    Object.freeze({ path: 'runtime/agent-native/targets/omp/assets/hooks/pre/hm2b-guard.ts', sha256: '2035bba12db8cdf1d8832753ed3cfeaaa4f2616bfaab4f3c43f342d621bcf075' }),
    Object.freeze({ path: 'runtime/agent-native/targets/omp/assets/hooks/post/hm2b-stop.ts', sha256: '87efd26f032f9287e4703325f3d8be81a2d745a73221f1a2e4b9cba4867e6918' }),
    ],
    smoke: (namespace) => layoutSmoke(namespace, { skillsRoot: '.agents/skills', agentsRoot: '.omp/agents', agentFormat: 'md' }),
  }),
  layout: Object.freeze({
    skillsRoot: '.agents/skills',
    agentsRoot: '.omp/agents',
    group: 'shared-skills',
  }),
  renderTargetFiles: (args) => perRoleRoleFiles(args),
  role: Object.freeze({
    format: 'md',
    extension: 'md',
    formatName: 'md',
    identity: Object.freeze({ state: 'adapted', reason: '文件名 + frontmatter name 承载渲染名' }),
    basename: (name) => `${name}.md`,
    exposure({ mode }) {
      if (mode === 'primary') return 'skipped';
      if (mode === 'any') return 'both';
      return 'subagent';
    },
    fieldStates(role, _tools, ctx) {
      const states = {};
      if (role.mode !== undefined) {
        if (role.mode === 'primary') {
          states.mode = { state: 'unavailable', reason: 'omp 无会话人格入口', effect: '不渲染该角色' };
        } else if (role.mode === 'any') {
          states.mode = { state: 'degraded', reason: 'omp 无 primary 子 agent 语义', effect: '仅能作为子 agent 暴露' };
        } else {
          states.mode = { state: 'native' };
        }
      }
      if (role.title !== undefined) {
        states.title = { state: 'unavailable', reason: 'omp 无展示名槽', effect: '展示名丢弃' };
      }
      if (role.model !== undefined) {
        const literal = modelLiteral(ctx, role.model);
        states.model = literal === undefined
          ? { state: 'degraded', reason: 'omp @tier 别名需要 modelRoles 条目，渲染期无法证明', effect: '继承 profile 默认模型' }
          : { state: 'adapted', reason: `能力档 ${role.model} → ${literal}` };
      }
      if (role.effort !== undefined) {
        const { level, clamped } = clampEffort(role.effort);
        states.effort = clamped
          ? {
            state: 'degraded',
            reason: `omp thinking-level 最高为 ${EFFORT_LEVELS[EFFORT_LEVELS.length - 1]}，${role.effort} 向下钳制`,
            effect: `以 ${level} 运行，推理强度可能低于作者意图`,
          }
          : { state: 'adapted', reason: 'thinking-level: 1:1' };
      }
      if (role.tools !== undefined) {
        states.tools = { state: 'adapted', reason: '映射到 omp 工具字面量' };
      }
      if (role.tools_deny !== undefined) {
        states.tools_deny = {
          state: 'degraded',
          reason: 'omp 默认工具面未知，无法从其上做减法',
          effect: '被 deny 的工具可能仍可用',
        };
      }
      if (role.skills !== undefined) states.skills = { state: 'native' };
      return states;
    },
    render({ role, name, instructions, tools, skillNames, ctx, helpers }) {
      if (role.mode === 'primary') return null;
      const fm = [`name: ${helpers.yamlScalar(name)}`, `description: ${helpers.yamlScalar(role.description)}`];
      if (role.model !== undefined) {
        const literal = modelLiteral(ctx, role.model);
        if (literal !== undefined) fm.push(`model: ${helpers.yamlScalar(literal)}`);
      }
      if (role.tools !== undefined) {
        const list = ompToolList(tools.effective);
        if (list.length === 0) fm.push('tools: []');
        else fm.push('tools:', ...list.map((tool) => `  - ${tool}`));
      }
      if (role.effort !== undefined) {
        fm.push(`thinking-level: ${helpers.yamlScalar(clampEffort(role.effort).level)}`);
      }
      if (role.skills !== undefined) {
        const list = role.skills
          .map((skillId) => helpers.skillNameOf(skillNames, skillId))
          .filter((skillName) => typeof skillName === 'string' && skillName !== '');
        if (list.length === 0) fm.push('autoloadSkills: []');
        else fm.push('autoloadSkills:', ...list.map((skillName) => `  - ${helpers.yamlScalar(skillName)}`));
      }
      return helpers.mdDocument(fm, instructions);
    },
  }),
});

export { EFFORT_LEVELS, TOKENS };
