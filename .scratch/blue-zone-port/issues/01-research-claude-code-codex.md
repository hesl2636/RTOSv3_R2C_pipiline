# 研究：claude code 与 codex 的安装单位与扩展原语

Type: research
Status: resolved
Labels: wayfinder:research
Map: ../map.md

## Question

claude code 与 codex 各自「装一个第三方工作流插件」的官方单位、落盘位置与扩展原语分别是什么——自定义命令、子代理、hooks（可用事件与 stdin 契约）、skills 或指令文件、MCP 配置、headless 调用——以及本插件的 6 阶段编排 + PreToolUse/Stop 钩子 + 7 个命令 + 3 个 MCP 在这些原语上哪些能直接落、哪些必须由适配层补齐？

## Answer

- **claude code**：单位＝`.claude-plugin/plugin.json` + marketplace（`claude plugin install`），也可 `--plugin-dir` 直挂；命令/agents/skills 都是 md，`hooks/hooks.json` 与现仓库同形（`PreToolUse`/`Stop` 都有，支持 `decision:"block"` 续跑，连续续跑上限 8 次）；变量换成 `${CLAUDE_PLUGIN_ROOT}` 与 hook stdin 的 `session_id`；MCP 用 `.mcp.json`，需改写 `command`/`args`/`env`。**无 YAML 编排原语**（其 `workflows/` 是 JS）。
- **codex**：单位＝根 `plugin.json`（兼容 Claude 清单）+ `codex plugin marketplace add`，缓存到 `~/.codex/plugins/cache/<market>/<plugin>/<version>/`；命令降级为 skills（`$name`）或已 deprecated 的 `~/.codex/prompts/*.md`；子代理是 TOML（`agents/*.toml`）；hooks 事件同形，但**非托管 hook 需人工 `/hooks` 信任**才执行；MCP 要改成 `command` 字符串 + `args` + `env` 表；headless `codex exec --json`。
- 结论：claude code 与 codex 都不能承载 stage/step 声明，**编排必须留在内核 runner**；两者的 `PreToolUse`/`Stop` 可直接映射现有 hook 语义，codex 多了人工信任这一道验收动作。
- 证据与逐项映射表：`research/blue-zone-port` 分支 `.scratch/blue-zone-port/research/01-claude-code-codex.md`。
