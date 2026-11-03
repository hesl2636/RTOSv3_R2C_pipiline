/**
 * runner projection manifest (#69 §3.1, #70 §2).
 *
 * `projection.json` is the frozen on-disk form; this module is the static
 * import the registry uses (JSON import attributes are not available across
 * the whole supported Node range). A test asserts the file is exactly
 * `canonicalJson(RUNNER_MANIFEST)`, so the two cannot drift.
 */
export const RUNNER_CAPABILITIES = Object.freeze([
  'state',
  'gates',
  'outputs',
  'subagents',
  'skills',
  'preload',
  'stage-invocation',
  'skill-invocation',
]);

const capabilities = Object.freeze({
  state: {
    level: 'native',
    note: 'runner 运行时记录步骤进度、强制顺序、支持 pause/resume；状态只在 .hm2b/**。',
  },
  gates: {
    level: 'native',
    note: 'submit 在项目根按序执行 gate[].command，任一非零拒绝提交；缺省超时 120 s。',
  },
  outputs: {
    level: 'native',
    note: 'submit 先检查 expect.outputs 的每个 glob 都存在，再执行 gate。',
  },
  subagents: {
    level: 'degraded',
    note: '角色以宿主原生定义安装并按 runner-<id> 命名，但 runner 只输出角色提示、从不强制派发。',
  },
  skills: {
    level: 'native',
    note: '技能按宿主目录安装/注册，占位横幅保留。',
  },
  preload: {
    level: 'unavailable',
    note: 'runner 投影响应最差宿主：codex/opencode/dsh 无角色级预载接缝。',
  },
  'stage-invocation': {
    level: 'unavailable',
    note: '运行粒度只保证全流程；单阶段调用不在 runner 命令面。',
  },
  'skill-invocation': {
    level: 'adapted',
    note: '单技能调用由宿主 agent 的技能面提供，runner 不提供单独命令。',
  },
});

export const RUNNER_MANIFEST = Object.freeze({
  schema: 'hm2b.projection/v1',
  id: 'runner',
  name: 'runner 运行时投影',
  version: '0.1.0',
  description: '把中立 IR 投影成 runner 项目根载荷（workflows/tasks/skills/roles/constitution）；一个 target，不生成引擎资产。',
  api: {
    ir: 'hm2b.ir/v1',
    options: 'hm2b.projection-options/v1',
    result: 'hm2b.projection-result/v1',
  },
  writeRoots: Object.freeze(['constitution', 'roles', 'skills', 'tasks', 'workflows']),
  targets: Object.freeze([
    Object.freeze({
      id: 'runner',
      name: 'runner 运行时',
      default: true,
      capabilities,
    }),
  ]),
  assets: Object.freeze([]),
  // Closed: runner declares no custom options, so `extra` must be `{}`.
  optionsSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({}),
  }),
});
