# Glossary

r2c 的词汇表。新文档只使用本表术语；文末“退役词汇”列出的词只允许出现在历史记录里。

## 领域

**bundle**:
一个可版本化的移植工作流包：`bundle.json` 清单 + stages / steps / tasks / roles / skills / constitution。唯一可编辑形式在 `examples/rtosv3/bundle/`，`r2c.bundle/v1` 是它的契约修订。
_Avoid_: 工作流包、pack、plugin、载荷

**manifest**:
`bundle.json`（bundle manifest），bundle 的封闭索引：id、version、阶段/任务/角色/技能列表、宪法路径。规范 JSON 字节是唯一比较形式。
_Avoid_: 配置文件、index

**stage**:
bundle 里的一个阶段（如“分析设计”），按数组顺序执行；阶段名、步骤列表在 `stages/<id>.json`。
_Avoid_: 环节、phase

**step**:
stage 内的一个可执行节点。bundle 的 step 引用一个 task、一个 role 和技能子集；IR 的 step 是编译后的稳定形状。
_Avoid_: 节点、stage

**task**:
一段可执行的任务书（Markdown），固定四节（角色设定、任务、约束、提交）且恰好一个 `{{submit}}` 占位。
_Avoid_: 提示词、prompt、模板

**role**:
执行任务的角色定义（id、description、instructions、skills）。投影时渲染为宿主原生 agent 定义，r2c target 命名为 `r2c-<id>`。
_Avoid_: agent、人格

**skill**:
可复用的技能正文（`SKILL.md` + frontmatter）；占位技能必须带占位横幅且不得臆测流程。
_Avoid_: 插件、能力

**constitution**:
跨阶段生效的约束文本；bundle 可以声明 `placeholder: true` 的 0 字节占位。
_Avoid_: 规则、policy

**IR**:
`r2c.ir/v1` 中立中间表示：`workflow.ir.json`，bundle 编译后的唯一输入，带 digest 与 `contentSha256`。投影、发布与 Web 都只读 IR。
_Avoid_: AST、中间文件

**projection**:
把一个 IR 渲染成某个 runtime 的文件集的纯函数（`r2c` / `agent-native`）。输入 IR + canonical options，输出 `r2c.projection-result/v1`。
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

**receipt**:
安装账本（`.r2c/install/receipts/<projection>/<bundle>.json`）：写了哪些文件、哈希、合并指针、备份与选项摘要。卸载与 doctor 只认回执。
_Avoid_: manifest、日志

**runtime receipt**:
引擎运行面的回执（`.r2c/install/runtime.json`）：引擎版本/入口、launcher、宿主目标与 runtime 文件；bundle 回执永不记录引擎版本。
_Avoid_: 引擎清单

**pre-projected payload**:
发布时已投影、已校验的文件包（`r2c-payload-<id>-v<ver>.tgz` / `agent-native-<id>-v<ver>.tgz`）；安装器只校验与写盘，不再投影。
_Avoid_: 安装时组装、动态载荷

**canonical options**:
投影选项的唯一字节形式（stageOrder、skills、targets、digest）；只有 canonical options 的构建可发布，自定义选择仅本地使用。
_Avoid_: 参数、配置

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
把旧的 `r2c.install/v1` 安装经校验、备份、指针级撤销后转为新回执，旧回执移到 `.r2c/install/legacy/*.retired`；失败整体回滚。
_Avoid_: 覆盖、force

## 退役词汇

以下词只描述历史（`docs/legacy.md`、`docs/blue-zone/`、`docs/agents/`），新文档与新代码不得使用：已退役的声明式适配器机制、四份角色模板、旧的顶层源码树、旧的载荷清单、旧的验收命令。它们的替代分别是 target 描述符 + `projection.json`、`renderRole`、`runtime/r2c/engine/`、`r2c.release-payload/v1` 与 installer 的 doctor/target smoke。
