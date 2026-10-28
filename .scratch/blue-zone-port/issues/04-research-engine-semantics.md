# 研究：复原 harness-engine 0.2.x 的语义与状态协议

Type: research
Status: resolved
Labels: wayfinder:research
Map: ../map.md

## Question

引擎包本体不可得（内网 registry 不可达、公网 404），只能从仓库调用点反推：`harness-engine@0.2.x` 究竟提供了哪些子命令（run/status/submit/resume/cancel/submit-gate-review/token-usage/hook…）、`state.json` 与 run 目录的字段级结构是什么、阶段与步骤如何推进与门禁、插件根与会话如何被发现，以及重写引擎时必须保留的最小语义是什么、哪些可以丢弃？

## Answer

- **子命令面**（证实）：`run --workflow-name/--plugin-root/--project-root/--session-id/--prompt-mode/--input`；`status|pause|resume|cancel` 同形；`hook stop|pre-tool-use`；`submit`/`submit-gate-review`/`token-usage` 仅见名字，参数未确定。`bin/cli.js` 剥 `--plugin-root` 后原样透传，退出码透传。
- **状态协议**（证实）：`~/.cac/projects/<formatProjectId>/runs/R*/` 下 `state.json`（run_id、session_id、status、workflow_engine、stages/steps 双形态、时间戳…）、`workflow.yaml` 快照、`trace/events.jsonl`（`kind:step` + `started/completed|submitted`）、上一级 `latest.json`（sessionId→active/latest run）；插件脚本再追加 upload-marker、session-slice、analysis。
- **最小保留清单 10 条**：state 全部被消费字段、run 目录布局、events 事件形状、latest.json 路由、`formatProjectId` 逐字节一致、子命令与参数约定、Stop 输出「含 `node "<插件根>/bin/cli.js"` 的 Submit 命令 + 步骤 prompt」协议、shell step `timeout` 秒语义、`workflow_engine`=插件名、非本 session no-op。
- **可丢弃 5 条**：内网 npx 分发链、旧 `run-state/run-<sid>` 路径兼容、旧 projectId 编码、guard 的全 projects 兜底遍历、`engine_version` 别名兼容。
- **重写前必须实测/确认**：submit 三件套的参数与退出契约、`state.status` 枚举、Stop 的通信协议（stdout 文本 or hook JSON）、`agent:` 是否真触发子代理、`artifact_defaults.target` 消费者、PreToolUse 具体拦截规则、门禁实现位置。
- 证据（文件:行）：`research/blue-zone-port` 分支 `.scratch/blue-zone-port/research/04-engine-semantics.md`。
