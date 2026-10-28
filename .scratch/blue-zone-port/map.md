# 蓝区移植：RTOSv3_R2C_pipiline → 主流 agent

Status: open
Labels: wayfinder:map
Effort: blue-zone-port

## Destination

产出一份**可直接开工的移植方案**：内核、五份 agent 适配层、安装与验收方式全部决策落地，任何人拿着这套决策就能在 codex、claude code、deepseek harness、omp、opencode 上装上并推进工作流。本期不写实现。

## Notes

- 域：黄区（内网 + CodeAgentCLI + `codeagent` 二进制）→ 蓝区（公网可达，主流 agent）。现状只有编排壳：6 阶段 workflow、4 个 task、hooks、上传/分析脚本、35 个 0 字节技能占位；依赖内网 npm registry、`CODEAGENT3_*` 环境变量与 `~/.cac` 状态目录。
- 已锁定方向（不再论证）：共享核心 + 每 agent 薄适配层；内核稳定面＝声明式清单（YAML/JSON）+ 单个 runner；引擎重写为公共可达包；**切断黄区**；内网专属件（3 个 MCP、ca-viewer 上传/分析、内网 registry）剥离为可选插件；技能保持占位但写成最小合法 frontmatter；状态落项目内 `.r2c/`；分发＝npm 发引擎 + GitHub Release 发插件；验收＝装得上 + 命令可发现 + 首步能提交。
- 每个会话先读 `grilling`、`domain-modeling`；写适配层文档时再读 `writing-for-agents`。票只用 `wayfinder:` 标签，开工前先 `Status: claimed`。
- 术语：**内核**＝声明式清单 + runner；**适配层**＝把一个 agent 的入口原语翻译成内核可执行形态的薄包装；**阶段/步骤/门禁**沿用 workflow yaml 语义。
- 约定：一票一个 `## Question`，正文不含答案；答案落在 `## Answer`，同时只把要点与链接追加到本页 Decisions so far。

## Decisions so far

- [研究：claude code 与 codex 的安装单位与扩展原语](issues/01-research-claude-code-codex.md): 两者都没有 YAML 编排原语（编排必须留在内核 runner）；`hooks/hooks.json` 在 claude code 同形可直用，codex 需人工 `/hooks` 信任；codex 命令降级为 skills、agents 改 TOML、MCP 需改形。
- [研究：opencode 与 omp 的安装单位与扩展原语](issues/02-research-opencode-omp.md): opencode 的 V1/V2 API 不兼容、且无「阻止结束」钩子（只能订阅 `session.idle` 自驱）；omp 用 TS 钩子模块，`session_stop` 可 block 续跑，最贴近现有 Stop 语义；两者都无编排原语，0 字节技能不会被 omp 注册。
- [研究：deepseek harness 的形态与扩展点](issues/03-research-deepseek-harness.md): 身份＝官方 `dsh`（`@deepseek-ai/dsh`，Cordis 插件）；扩展单位是 npm 包 + `package.json.dsh.bundle.patch`；唯一内置读 `hooks.json` 的兼容层，但命令与 MCP 必须重写成插件模块。
- [研究：复原 harness-engine 0.2.x 的语义与状态协议](issues/04-research-engine-semantics.md): 复原出子命令面、`state.json`/`events.jsonl`/`latest.json` 字段与 `formatProjectId` 编码；给出重写必须保留的 10 条语义与可丢弃的 5 条，并列出重写前必须实测的 7 个未知。

## Not yet specified

- 无钩子 agent 的「下一步」提示文案与状态可见性（等推进分档定案后细化）
- 升级 / 回滚 / 多版本共存的具体机制（等版本策略定案）
- Windows 与 macOS 的安装脚本差异、shell 兼容（等适配层契约定案）
- 卸载残留清理与安装幂等校验
- 验收能否 CI 化：每 agent headless 跑一次首步
- 内网 MCP 与上传/分析剥离后，蓝区是否需要替代能力
- README / onboarding 文档与发布流程（等仓库布局定案）
- 黄区现存用户的交接说明与回退路径
- 命令命名冲突与各 agent 的入口呈现（如 `/RTOSv3_R2C_pipiline` 在 codex 上如何暴露）
- 引擎包命名、许可与维护者

## Out of scope

- 35 个技能的内容填充（本期保持占位）
- 黄区 CodeAgentCLI 与 harness-engine 的继续维护、升级
- ca-viewer 服务端与 3 个内网 MCP server 的开发
- 业务侧 SR/AR/SPEC 的内容质量与流程运作
- 各 agent 官方市场的审核上架（本期只走 npm + GitHub Release）
- 性能优化、多语言与遥测
