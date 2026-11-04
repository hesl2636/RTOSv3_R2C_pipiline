/**
 * Codex target descriptor (#96, decisions #71 §10.1, #72 §5.5).
 *
 * Data only: capability matrix, field states, the TOML byte shell and the
 * file layout. The shared driver (`runtime/shared/render-role.js`) owns
 * naming, field-state accounting, placeholder instructions and exposure.
 *
 * Codex custom agents are standalone TOML files under `.codex/agents/` with
 * required `name`, `description` and `developer_instructions`; they inherit
 * the parent's permissions, provider and MCP servers, can set
 * `model`/`model_reasoning_effort`, disable `features.shell_tool`, and inherit
 * skills (that is, there is no per-agent preload seam). Docs smoke
 * (2026-11-02): https://learn.chatgpt.com/docs/agent-configuration/subagents
 * confirms the three required keys, the project-local `.codex/agents/`
 * discovery path, `features.shell_tool = false`, and that a custom agent file
 * cannot express a per-tool allow-list. No `codex` binary is installed in the
 * development environment, so no runtime smoke was performed; the TOML shape
 * is verified against the prototype oracle and the published schema only.
 */
import { perRoleRoleFiles } from '../role-files.js';
import { layoutSmoke, hostProfile } from './host.js';

const TOKENS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'web'];

const CAPABILITIES = Object.freeze({
  state: 'unavailable',
  gates: 'degraded',
  outputs: 'degraded',
  subagents: 'native',
  skills: 'adapted',
  preload: 'unavailable',
  'stage-invocation': 'adapted',
  'skill-invocation': 'adapted',
});

const CAPABILITY_NOTES = Object.freeze({
  state: '无 runner：没有状态文件，进度与续跑由执行者维护',
  gates: '命令原文 + 超时写入阶段技能；执行者运行并自证，机器不强制',
  outputs: 'glob 原样列出自检清单；回执逐项写存在/缺失，机器不检查',
  subagents: '角色 TOML 落在 .codex/agents，Codex 自动发现；无法表达的字段逐字段记降级',
  skills: '技能安装到 .agents/skills；显示名不加 bundle 前缀；目录名仅用于避免多 bundle 冲突',
  preload: 'Codex 自定义 agent 继承父会话技能，没有按 agent 预载接缝',
  'stage-invocation': '阶段技能可由 Codex 技能选择器加载；无稳定命令行 token',
  'skill-invocation': '技能副本可由技能选择器加载；无稳定命令行 token',
});

function effectiveTokenNames(tokens) {
  return TOKENS.filter((token) => tokens.has(token));
}

function denyEffect(lost) {
  const named = lost.map((token) => (token === 'task'
    ? 'task（角色仍可再派子 agent）'
    : token));
  return `这些工具仍可用：${named.join('、')}`;
}

export const codexTarget = Object.freeze({
  id: 'codex',
  name: 'Codex',
  default: true,
  capabilities: CAPABILITIES,
  capabilityNotes: CAPABILITY_NOTES,
  ...hostProfile({
    detect: {"commands":[["codex","--version"]],"envBins":["HM2B_CODEX_BIN"],"globBins":["%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe"],"versionArgs":["--version"],"paths":["~/.codex"]},
    assets: [
    Object.freeze({ path: 'runtime/agent-native/targets/codex/assets/hooks.json', sha256: 'cdf111fbb5931bb9310eac326df4eee62e04a45564841b6ec17920353da7105d' }),
    Object.freeze({ path: 'runtime/agent-native/targets/codex/assets/hm2b-hook-pre-tool-use.cmd', sha256: '5edea3f6a09166456fa4108bc04363e81ef467a0d2a795e4f24e1e765d21e527' }),
    Object.freeze({ path: 'runtime/agent-native/targets/codex/assets/hm2b-hook-stop.cmd', sha256: 'a68c7adde225b60d8220b5d699468f5c50b5233e1726a1013a46fece25f2a756' }),
    ],
    smoke: (namespace) => layoutSmoke(namespace, { skillsRoot: '.agents/skills', agentsRoot: '.codex/agents', agentFormat: 'toml' }),
  }),
  layout: Object.freeze({
    skillsRoot: '.agents/skills',
    agentsRoot: '.codex/agents',
    group: 'shared',
  }),
  renderTargetFiles: (args) => perRoleRoleFiles(args),
  role: Object.freeze({
    format: 'toml',
    extension: 'toml',
    formatName: 'toml',
    identity: Object.freeze({ state: 'adapted', reason: 'TOML name 承载渲染名' }),
    basename: (name) => `${name}.toml`,
    exposure({ mode }) {
      if (mode === 'primary') return 'skipped';
      if (mode === 'any') return 'both';
      return 'subagent';
    },
    fieldStates(role, tools) {
      const states = {};
      states.instructions = { state: 'adapted', reason: 'developer_instructions 多行基本字符串，反斜杠与引号转义' };
      if (role.mode !== undefined) {
        if (role.mode === 'subagent') states.mode = { state: 'native' };
        else if (role.mode === 'any') {
          states.mode = {
            state: 'degraded',
            reason: 'codex 无 primary 子 agent 语义',
            effect: '仅能作为子 agent 暴露，会话人格部分丢弃',
          };
        } else if (role.mode === 'primary') {
          states.mode = {
            state: 'unavailable',
            reason: 'codex 无会话人格入口',
            effect: '不渲染该角色',
          };
        }
      }
      if (role.title !== undefined) {
        states.title = { state: 'unavailable', reason: 'codex 无展示名槽', effect: '展示名丢弃' };
      }
      if (role.model !== undefined) {
        states.model = {
          state: 'degraded',
          reason: 'codex 无能力档别名，槽位需要具体 model id',
          effect: '继承 default_subagent_model',
        };
      }
      if (role.effort !== undefined) {
        if (role.effort === 'xhigh' || role.effort === 'max') {
          states.effort = {
            state: 'degraded',
            reason: `codex 最高档为 high，${role.effort} 向下钳制`,
            effect: '以 high 运行，推理强度可能低于作者意图',
          };
        } else {
          states.effort = { state: 'adapted', reason: '映射到 model_reasoning_effort' };
        }
      }
      if (role.tools !== undefined) {
        const allowed = effectiveTokenNames(tools.effective);
        states.tools = {
          state: 'degraded',
          reason: allowed.length === 0
            ? 'codex 自定义 agent 不能按名白名单：空 allow-list 无法表达'
            : `codex 自定义 agent 不能按名白名单：${allowed.join('/')} 无法限定`,
          effect: allowed.length === 0
            ? '角色继承父会话工具面，全部工具仍可用'
            : '角色继承父会话工具面，上述工具仍可用',
        };
      }
      if (role.tools_deny !== undefined) {
        if (tools.deny.size === 0) {
          states.tools_deny = { state: 'adapted', reason: '空 deny 列表，无需渲染' };
        } else if (tools.deny.size === 1 && tools.deny.has('bash')) {
          states.tools_deny = { state: 'adapted', reason: 'bash → features.shell_tool = false' };
        } else {
          const lost = TOKENS.filter((token) => token !== 'bash' && tools.deny.has(token));
          states.tools_deny = {
            state: 'degraded',
            reason: `codex 只能表达 bash deny；无法 deny ${lost.join('/')}`,
            effect: denyEffect(lost),
          };
        }
      }
      if (role.skills !== undefined) {
        states.skills = {
          state: 'unavailable',
          reason: 'codex 无按 agent 预载接缝',
          effect: '预载丢弃；技能仍在会话内可调用',
        };
      }
      return states;
    },
    render({ role, name, instructions, tools, exposure, helpers }) {
      if (exposure === 'skipped') return null;
      const lines = [
        `name = ${helpers.tomlString(name)}`,
        `description = ${helpers.tomlString(role.description)}`,
      ];
      if (role.effort !== undefined) {
        const effort = role.effort === 'xhigh' || role.effort === 'max' ? 'high' : role.effort;
        lines.push(`model_reasoning_effort = ${helpers.tomlString(effort)}`);
      }
      if (tools.deny.has('bash')) lines.push('features.shell_tool = false');
      lines.push(`developer_instructions = ${helpers.tomlMultiline(instructions)}`);
      return `${lines.join('\n')}\n`;
    },
  }),
});

export { CAPABILITIES, TOKENS };
