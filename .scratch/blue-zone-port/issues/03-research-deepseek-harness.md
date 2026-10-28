# 研究：deepseek harness 的形态与扩展点

Type: research
Status: resolved
Labels: wayfinder:research
Map: ../map.md

## Question

「deepseek harness」具体指哪个产品（官方 CLI、agent harness 还是内部工具），它的安装单位、配置落盘位置与扩展原语（自定义命令、子代理、hooks 或拦截机制、skills/指令文件、MCP、headless 调用）是什么，以及本插件的 6 阶段编排 + 钩子 + 命令 + MCP 能落到哪些原语上、哪些完全不可用？

## Answer

- 身份确认：`deepseek harness` ＝ DeepSeek 官方 **`dsh`**（`@deepseek-ai/dsh`，Cordis 插件体系，2026-10-28 dist-tags latest `0.2.1-rc.2`）；社区站 `deepseekdocs.com`/`deepseekharness.io` 均为非官方镜像，已排除。
- 单位＝npm 包 + `package.json` 的 `dsh.bundle.patch`，经 `dsh plugin --profile web add <git|link>` 装进 `$DSH_HOME/profiles/<name>/`；**没有 Markdown 命令文件格式**，命令要 `ctx.commands.register` 注册；有 `@deepseek-ai/dsh-hooks-claude-code` 兼容层**直接读 `hooks.json`**（`PreToolUse`/`Stop` 等，exit 2 阻断，替换 `${CLAUDE_PLUGIN_ROOT}`），是五者中唯一能复用现成 hooks.json 的；MCP 是 patch 里的一行 `dsh-mcp-client` 配置；headless `dsh --profile headless "任务"`。
- 结论：钩子层几乎零成本迁移，命令层与 MCP 层必须重写成插件模块；YAML 编排同样无原语。
- 证据与映射缺口：`research/blue-zone-port` 分支 `.scratch/blue-zone-port/research/03-deepseek-harness.md`。
