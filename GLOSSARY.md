# Glossary

hm2b 的词汇表。新文档只使用本表术语；文末“退役词汇”列出的词只允许出现在历史记录里。

## 领域

**bundle**:
一个可版本化的移植工作流包：`bundle.json` 清单 + stages / steps / tasks / roles / skills / constitution，外加可选的 `knowledge-base/`、`checklists/`、`hooks/hooks.json` 与 `mcp.json` 四类资产。唯一可编辑形式在 `examples/rtosv3/bundle/`，`hm2b.bundle/v2` 是它的契约修订。
_Avoid_: 工作流包、pack、plugin、载荷

**asset**:
bundle 携带的非流程内容：知识库、检查单、hooks 与 MCP 声明。资产按清单声明接纳、随编译工作流一起发布；投影把它们写成 runner 项目根的文件，或 agent-native 命名空间 `.agents/agent-native/<bundle-id>/` 下的文件。
_Avoid_: 附件、资源、插件

**knowledge-base**:
声明在 `knowledgeBase[]` 里的 Markdown 知识文件，归档路径 `knowledge-base/<group>/<subgroup>/<file>.md`，路径最多 4 段。
_Avoid_: 文档库、KB

**checklist**:
`checklists[]` 里的检查单 id；文件恒为 `checklists/<id>.md`，正文与 `source.sha256` 进入编译工作流。
_Avoid_: 清单、todo

**hooks**:
bundle 的 `hooks.path` 声明 `hooks/hooks.json`；该文件必须是规范 JSON，只按声明接纳，未声明时编译工作流的 `hooks` 为 `null`。
_Avoid_: 钩子脚本、hook 载体

**mcp**:
bundle 的 `mcp.path` 声明 `mcp.json`；该文件必须是规范 JSON 且在 `mcpServers` 下携带对象，未声明时编译工作流的 `mcp` 为 `null`。
_Avoid_: MCP 配置、server 列表

**manifest**:
`bundle.json`（bundle manifest），bundle 的封闭索引：id、version、阶段/任务/角色/技能列表、资产声明（`knowledgeBase`、`checklists`、`hooks`、`mcp`）与宪法路径。规范 JSON 字节是唯一比较形式。
_Avoid_: 配置文件、index

**stage**:
bundle 里的一个阶段（如“分析设计”），按数组顺序执行；阶段名、步骤列表在 `stages/<id>.json`。
_Avoid_: 环节、phase

**step**:
stage 内的一个可执行节点。bundle 的 step 引用一个 task、一个 role 和技能子集；编译工作流的 step 是编译后的稳定形状。
_Avoid_: 节点、stage

**task**:
一段可执行的任务书（Markdown），固定四节（角色设定、任务、约束、提交）且恰好一个 `{{submit}}` 占位。
_Avoid_: 提示词、prompt、模板

**role**:
执行任务的角色定义（id、description、instructions、skills）。投影时渲染为宿主原生 agent 定义，runner target 命名为 `runner-<id>`。
_Avoid_: agent、人格

**skill**:
可复用的技能正文（`SKILL.md` + frontmatter）；占位技能必须带占位横幅且不得臆测流程。
_Avoid_: 插件、能力

**constitution**:
跨阶段生效的约束文本；bundle 可以声明 `placeholder: true` 的 0 字节占位。
_Avoid_: 规则、policy

**placeholder**:
显式标注「本期未实现、只声明契约」的产物；只允许 role、skill、constitution 三类。角色占位正文可空、投影生成统一占位 instructions；技能占位必须在正文前导区带可见横幅；宪法占位由 `bundle.json.constitution.placeholder` 声明，文件可为 0 字节。占位必须带机读标记，不得用空正文伪装。
_Avoid_: stub、空实现

**compiled workflow**:
（中文：编译产物）
`hm2b.compiled-workflow/v2` 是 bundle 编译后的中立产物：`workflow.compiled.json`，投影的唯一输入，带 digest 与 `contentSha256`。顶层字段固定为 `schema`、`id`、`name`、`version`、`description`、`source`、`requires`、`stages`、`roles`、`tasks`、`skills`、`knowledgeBase`、`checklists`、`hooks`、`mcp`、`constitution`；资产正文内嵌，未声明的资产是 `[]` 或 `null`。投影、发布与 Web 都只读它。它不是华为的 IR（initial requirement），也不是跨产品标准；只是本流水线的编译产物与投影输入。
_Avoid_: IR（华为术语，指 initial requirement）、中间文件、AST

**projection**:
把一个编译工作流渲染成某个 runtime 的文件集的纯函数（`runner` / `agent-native`）。输入编译工作流 + canonical options，输出 `hm2b.projection-result/v1`。
_Avoid_: 适配、转换

**target**:
投影内的一个宿主（`claude-code`、`codex`、`dsh`、`omp`、`opencode`）；描述符声明能力、布局、检测与资产。
_Avoid_: adapter、agent 平台

**capability**:
target 对 8 项运行时能力（state / gates / outputs / subagents / skills / preload / stage-invocation / skill-invocation）的等级：`native`、`adapted`、`degraded`、`unavailable`。
_Avoid_: 特性、feature

**obligation**:
投影对 target 的一项必须满足的语义要求（例如“门禁必须可执行”）；无法满足时降级并记录，不得静默丢失。
_Avoid_: 需求、requirement

**degradation**:
逐字段的降级记录：`{code,target,capability,level,pointer,field,reason,effect}`；能力报告与安装摘要都读它。
_Avoid_: 警告、warning

**install root**:
投影路径的锚点；投影结果 v1 恒为项目根，所有 `files[].path` 相对它拼接，bundle 内容从不写入用户 home（只有引擎可用 `--engine-home`）。
_Avoid_: 安装目录、target dir

**install identity**:
`(projection.id, bundle.id)`；一个安装根下每个身份至多一份回执，回执路径由它唯一决定。
_Avoid_: 安装 id、slot

**receipt**:
安装账本（`.hm2b/install/receipts/<projection>/<bundle>.json`）：写了哪些文件、哈希、合并指针、备份与选项摘要。卸载与 doctor 只认回执。
_Avoid_: manifest、日志

**runtime receipt**:
引擎运行面的回执（`.hm2b/install/runtime.json`）：引擎版本/入口、launcher、宿主目标与 runtime 文件；bundle 回执永不记录引擎版本。
_Avoid_: 引擎清单

**pre-projected payload**:
发布时已投影、已校验的文件包（`hm2b-payload-<id>-v<ver>.tgz` / `agent-native-<id>-v<ver>.tgz`）；安装器只校验与写盘，不再投影。
_Avoid_: 安装时组装、动态载荷

**canonical options**:
投影选项的唯一字节形式（stageOrder、skills、targets、digest）；只有 canonical options 的构建可发布，自定义选择仅本地使用。
_Avoid_: 参数、配置

**projection options**:
解析后的投影选项 `hm2b.projection-options/v1`：`stageOrder`、`skills`、`targets` 与 `extra` 的回显，绑定 `compiledWorkflow.digest`。缺省归一化为编译工作流顺序、全部技能、清单默认目标与 `extra: {}`；只缩小或重排渲染面，不回写 bundle 或编译工作流。
_Avoid_: 参数、配置字段

**ownership**:
一条路径在任意时刻至多被一份回执拥有；安装永不覆盖别人的文件，卸载只删自己的文件。
_Avoid_: 所有权冲突、占用

**shared root**:
多个 target 共用的宿主目录（如 `.agents/skills`、`.claude/skills`）；卸载时只删回执记录的文件，不删共享根目录。
_Avoid_: 公共目录

**adopt**:
目标路径已存在且字节与将写入内容相同：不写盘，但仍记入回执。
_Avoid_: 跳过、skip

**takeover**:
把旧的 `r2c.install/v1` 安装经校验、备份、指针级撤销后转为新回执，旧回执移到 `.hm2b/install/legacy/*.retired`；失败整体回滚。takeover 只读取旧通道留在 `.r2c/install` 的回执，新的退役记录一律写 `.hm2b/install/legacy`。
_Avoid_: 覆盖、force

## 退役词汇

以下词只描述历史（`docs/legacy.md`、`docs/blue-zone/`、`docs/agents/`），新文档与新代码不得使用：已退役的声明式适配器机制、四份角色模板、旧的顶层源码树、旧的载荷清单、旧的验收命令。它们的替代分别是 target 描述符 + `projection.json`、`renderRole`、`runtime/runner/engine/`、`hm2b.release-payload/v1` 与 installer 的 doctor/target smoke。
