/**
 * dsh target descriptor (#99; spec §11 row 7, decision #71 §3.2/#10.1 as
 * amended by #82, #72 §5).
 *
 * dsh has no file-shaped role definition: an agent is a Cordis profile row.
 * v1 does not guess that row (the `insert:` entry key and the preset plugin
 * shape were not first-hand verified when the contract froze), so the target
 * ships the shared `.agents/skills` tree plus one aggregate, manually driven
 * role catalogue `.dsh/agent-native/<ns>.roles.md`. No preset lines, no
 * `allowedAgentPresets`, and `subagents` stays `unavailable`.
 *
 * Data only: capability matrix, exposure, field states and the catalogue byte
 * shell. Naming, placeholder text and field-state assertions stay in the
 * shared renderer.
 *
 * Evidence (2026-11-02, local `deepseek-harness` checkout; recorded in
 * notes/99-report.md): patch rows are `- insert:` lists whose entries are
 * `- id:` + `name: '@deepseek-ai/dsh-…'` + `config:` (packages/bundle/base/
 * README.md, docs/architecture.md) — the prototype's `plugin:` key is wrong.
 * A preset row is `name: '@deepseek-ai/dsh-agent-preset'` with `config.id` +
 * `config.plugins`; persona is `name: '@deepseek-ai/dsh-persona'` with a
 * required `config.prefix`; `allowedAgentPresets` is a `dsh-tool-subagent`
 * config field. v1 still does not emit them: the 1.1 landing is a contract
 * change, not a descriptor tweak.
 */
import { compareCodePoints } from '../../../../core/code-point.js';
import { layoutSmoke, hostProfile } from './host.js';

const CAPABILITIES = Object.freeze({
  state: 'unavailable',
  gates: 'degraded',
  outputs: 'degraded',
  subagents: 'unavailable',
  skills: 'adapted',
  preload: 'unavailable',
  'stage-invocation': 'native',
  'skill-invocation': 'native',
});

const CAPABILITY_NOTES = Object.freeze({
  state: '无 runner：没有状态文件，进度与续跑由执行者维护',
  gates: '命令原文 + 超时写入阶段技能；执行者运行并自证，机器不强制',
  outputs: 'glob 原样列出自检清单；回执逐项写存在/缺失，机器不检查',
  subagents: 'v1 不生成 dsh 原生 preset；角色正文进项目内角色目录，由主会话按同名段落执行',
  skills: '技能安装到 .agents/skills（dsh 项目级技能根）；名字加 bundle 前缀，语义不变',
  preload: 'dsh 无按角色预载技能的接缝；v1 也不按角色挂 skill provider',
  'stage-invocation': '阶段技能可单独加载',
  'skill-invocation': '技能工具可按需加载单个技能',
});

const AGENTS_ROOT = '.dsh/agent-native';

function sortedTokens(tokens) {
  return [...tokens].sort(compareCodePoints).join('/');
}

function banner(namespace) {
  return [
    `# agent-native · ${namespace} · dsh 角色目录`,
    '',
    '> **说明（v1 回退）** dsh 没有文件形态的角色定义，本目录不是 dsh 原生 agent preset，也不会自动生效：投影不猜 Cordis patch 的行键名与插件 id。',
    `> **用法** dsh 主会话按角色段落执行：派发任务时把该段落正文当作系统提示；角色正文与 \`.agents/agent-native/${namespace}/roles.json\` 的对应记录一致。`,
  ].join('\n');
}

/** One Markdown section per role; the instructions stay byte-verbatim. */
function renderSection({ role, name, instructions }) {
  const lines = [
    `## ${name}`,
    '',
    `- 角色 id：\`${role.id}\``,
    `- 描述：${role.description}`,
  ];
  if (role.title !== undefined) lines.push(`- 展示名：${role.title}`);
  if (role.mode !== undefined) lines.push(`- 模式：${role.mode}`);
  return `${lines.join('\n')}\n${instructions}`;
}

function roleCatalogue({ ir, roleIds, renderedByRole }) {
  const files = [];
  const artifacts = {};
  if (roleIds.length === 0) return { files, artifacts };
  const path = `${AGENTS_ROOT}/${ir.id}.roles.md`;
  const sections = roleIds.map((roleId) => renderedByRole.get(roleId).content);
  files.push({
    path,
    kind: 'role',
    content: `${banner(ir.id)}\n\n${sections.join('\n')}`,
  });
  for (const roleId of roleIds) artifacts[roleId] = { path, format: 'md' };
  return { files, artifacts, metadataArtifacts: { 'dsh-roles': path } };
}

/**
 * Every delegation use point loses the native seam in v1: the record carries
 * the step pointer (#82 keeps `/stages/<i>/steps/<j>/role`).
 */
function capabilityDegradations({ ir }) {
  const records = [];
  for (const [stageIndex, stage] of ir.stages.entries()) {
    for (const [stepIndex, step] of stage.steps.entries()) {
      if (step.role === undefined) continue;
      records.push({
        code: 'CAP_SUBAGENTS_UNAVAILABLE',
        capability: 'subagents',
        level: 'unavailable',
        pointer: `/stages/${stageIndex}/steps/${stepIndex}/role`,
        reason: 'dsh v1 不生成原生 agent preset；投影只写项目内文件',
        effect: '角色只在项目内角色目录里；主会话按同名段落执行，不能原生派发子 agent',
      });
    }
  }
  return records;
}

export const dshTarget = Object.freeze({
  id: 'dsh',
  name: 'DeepSeek Harness',
  default: true,
  capabilities: CAPABILITIES,
  capabilityNotes: CAPABILITY_NOTES,
  ...hostProfile({
    detect: {"commands":[["dsh","-V"]],"paths":["$DSH_HOME","~/.dsh"]},
    assets: [
    Object.freeze({ path: 'runtime/agent-native/targets/dsh/assets/dsh.patch.yml', sha256: '13de8ce3d23d38fc86426fb6ff21279af7eec0b11fd47950513900472b2fa029' }),
    Object.freeze({ path: 'runtime/agent-native/targets/dsh/assets/hooks.json', sha256: 'bf2247ed875939700b1f8014a19cbcd51b67bc40e88c6c452a6c295e995ceaed' }),
    Object.freeze({ path: 'runtime/agent-native/targets/dsh/assets/index.mjs', sha256: '6357068f46b5af30ffbffd39766d443599d1e181dd6fc0d6a9fd3bb7522862ec' }),
    Object.freeze({ path: 'runtime/agent-native/targets/dsh/assets/package.json', sha256: '2a3fd663c4034d73957def32f48ce2f44bf566d915d19c4543dc376c6472bf30' }),
    ],
    smoke: (namespace) => layoutSmoke(namespace, { skillsRoot: '.agents/skills', extra: [{ kind: 'agents', root: '.dsh/agent-native', prefix: `${namespace}.`, format: 'md' }] }),
  }),
  layout: Object.freeze({
    skillsRoot: '.agents/skills',
    agentsRoot: AGENTS_ROOT,
    group: 'shared-skills',
  }),
  renderTargetFiles: (args) => roleCatalogue(args),
  capabilityDegradations,
  role: Object.freeze({
    format: 'md',
    extension: 'md',
    formatName: 'md',
    identity: Object.freeze({ state: 'adapted', reason: '角色段落标题承载渲染名' }),
    basename: (name) => `${name}.roles.md`,
    exposure({ mode }) {
      if (mode === 'any') return 'both';
      return mode;
    },
    fieldStates(role) {
      const states = {
        description: {
          state: 'degraded',
          reason: 'dsh 只在 profile 层按 preset id 枚举角色；v1 角色目录不进入运行时路由',
          effect: '模型只能按角色 id/段落选择角色，读不到描述',
        },
        title: { state: 'native' },
        instructions: { state: 'adapted', reason: '正文逐字节进角色段落；没有 persona 槽' },
        mode: { state: 'native' },
      };
      if (role.model !== undefined) {
        states.model = {
          state: 'degraded',
          reason: 'dsh agentOptions 是委派工具级、跨角色共享',
          effect: '全角色共享 agentOptions；开启 modelSelection 时由模型逐次选择',
        };
      }
      if (role.effort !== undefined) {
        states.effort = {
          state: 'degraded',
          reason: 'dsh 无按角色的推理强度槽',
          effect: '全角色共享 agentOptions，强度偏好不逐角色生效',
        };
      }
      if (role.tools !== undefined) {
        states.tools = {
          state: 'degraded',
          reason: `dsh 无按 agent 的工具过滤接缝；无法限定 ${sortedTokens(role.tools)}`,
          effect: '角色继承 profile 插件组合出的工具面',
        };
      }
      if (role.tools_deny !== undefined) {
        states.tools_deny = {
          state: 'degraded',
          reason: `dsh 无按 agent 的工具过滤接缝；无法移除 ${sortedTokens(role.tools_deny)}`,
          effect: '被 deny 的工具仍可能可用',
        };
      }
      if (role.skills !== undefined) {
        states.skills = {
          state: 'unavailable',
          reason: 'dsh v1 不按角色挂 skill provider',
          effect: '预载丢弃；技能仍可在会话内调用',
        };
      }
      return states;
    },
    render: (args) => renderSection(args),
  }),
});
