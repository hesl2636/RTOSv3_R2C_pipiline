# 研究：opencode 与 omp 的安装单位与扩展原语

Type: research
Status: resolved
Labels: wayfinder:research
Map: ../map.md

## Question

opencode 与 omp（当前运行环境所用的 agent 框架，本地技能目录 `~/.omp/agent/skills/`）各自「装一个第三方工作流插件」的官方单位、落盘位置与扩展原语分别是什么——自定义命令、子代理、hooks 或等价拦截机制、skills 或指令文件、MCP 配置、headless 调用——以及本插件的 6 阶段编排 + 钩子 + 命令 + MCP 在这些原语上哪些能直接落、哪些必须由适配层补齐？

## Answer

- **opencode**：单位＝`.opencode/{commands,agents,skills,plugins}/` + `opencode.json`（无插件清单文件）；V1 与 V2 两套 API 不兼容（`command/commands`、`mcp.<n>/mcp.servers`、`subtask/subagent`），**蓝区基线必须先选**；钩子只有代码插件（`tool.execute.before`≈PreToolUse），**没有阻止结束的钩子**，续跑只能靠订阅 `session.idle` 事件自己驱动；MCP 形状接近，key 改名。
- **omp**：单位＝plugin 包（`omp plugin install <npm|git>`、`omp plugin link <dir>`，或项目 `.omp/`）；commands/agents/skills 都是 md，与现仓库结构同源；**hooks 是 TS 模块（`.omp/hooks/pre|post/*.ts`）而非 hooks.json**，`tool_call` ≈ PreToolUse（可 block）、`session_stop` ≈ Stop（可 `{decision:"block"}` 续跑）；`omp -p` 可 headless；现有 `package.json` 为 `private` 且无 `omp` manifest，安装后会被跳过；0 字节 `SKILL.md` 因缺 description 不会被注册。
- 结论：omp 的钩子语义最接近现有引擎（甚至比 opencode 更贴合），但需重写 hook 载体；opencode 的「续跑」是插件自主行为；两者都不提供阶段编排原语。
- 证据与逐项映射表：`research/blue-zone-port` 分支 `.scratch/blue-zone-port/research/02-opencode-omp.md`。
