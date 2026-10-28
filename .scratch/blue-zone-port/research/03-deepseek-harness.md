# 研究结果：deepseek harness 的形态与扩展点（票 03）

> 来源：ResearchDeepseekHarness 子代理，2026-10-28。以下为报告原文。

## 结论：**确认**

「deepseek harness」= **DeepSeek Harness（`dsh`）**，DeepSeek AI 官方开源的 agent harness，TypeScript/MIT，构建在 Cordis 插件系统上（"Everything is a Plugin"）。官方仓库 `deepseek-ai/deepseek-harness`，npm 包 `@deepseek-ai/dsh`（2026-10-28 查询 dist-tags：`latest 0.2.1-rc.2`、`next 0.2.1-rc.4`、`alpha 0.2.2-alpha.2`），另有 macOS/Windows 桌面包。官方文档入口由 README 指定为 `deepseek-harness.github.io/deepseek-harness/`，仓库内 `docs/` 为一手技术文档。

**排除的候选**（均非官方）：

| 候选 | 差异证据 |
|---|---|
| `deepseekdocs.com` | 页面 meta-author 自述"DeepSeek Harness 社区"；其版本说明（latest=0.1.2-rc.1）已落后 npm 实际 dist-tags，属社区镜像 |
| `deepseekharness.io` / `deepseekdsh.com` | 后者页脚自述"Independent community guide" |
| `peiyuwang54/deepseek-harness-cli` | 个人账号仓库，非 `deepseek-ai` 组织 |
| `deepseek-agent`(PyPI)、`model-clis/deepseek`、`DeepSeek-TUI` | 第三方 CLI/技能封装，与 harness 本体无关 |

## 1. 安装单位

两层：**harness 安装**与**扩展安装**。

- harness：`npx @deepseek-ai/dsh web`（零安装，需 Node `^22.19.0` 或 `>=24.0.0`），或 `npm i -g @deepseek-ai/dsh`；源码态 `pnpm dsh <args>`。唯一入口命令 `dsh`，profile 决定形态（`web`/`headless`/`acp`/`sdk`/`sdk-minimal`）。
- 扩展单位 = **一个 npm 包（Cordis 插件）**，元数据写在 `package.json` 的 `dsh` 字段：`manifestVersion: 1`、`bundle.patch`（一个或有序多个 patch 文件）、`client`（浏览器半边）、`engines.dsh`（兼容区间，安装与启动都校验）。**不是** `plugin.json`/`.claude-plugin/plugin.json`。
- 安装命令：`dsh plugin --profile web add "github:org/repo#ref"`、`add link:/path`（参数原样转发 pnpm，profile 目录内执行）；装 bundle 需**重启** `dsh web`。也可在 `cordis.patch.yml` 里写 `insert` 行（name + config + 可选 `!!js`）直接挂载。
- 落盘：`$DSH_HOME`（默认 `~/.dsh`）下 `profiles/<name>/package.json`（含 `dsh.profile.bundles` 有序列表）、`profiles/<name>/cordis.patch.yml`、`profiles/node_modules`；机器级 overlay 为 `$DSH_HOME/cordis.patch.yml`（优先级高于 profile 层）；另有 `$DSH_HOME/.env`、`$DSH_HOME/AGENTS.md`、`$DSH_HOME/skills`、`~/.agents/`。合成树用 `dsh --profile web --dump-config` 核对。

## 2. 扩展原语矩阵

| 原语 | 有/无 | 等价物 |
|---|---|---|
| 自定义命令 | 有 | 插件内 `ctx.commands.register({name, description, input?, handler})`；`/name rawInput`，不产生模型消息，可 agent 作用域覆盖全局；生命周期事件 `command/run`/`command/done`。**无 Markdown 命令文件格式** |
| 子代理 | 有 | `ctx.subagent` 命名 provider + `SubagentStartRequest`（cwd/preset/depth/outputSchema）；自定义子代理=**Agent preset（Cordis YAML 的 `plugins` 子列表）**，不是 md 文件；另有实验性 Agent Teams |
| hooks/拦截 | 有 | 原生：Cordis 事件 + 工具流水线 waterfall（`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`）。兼容层：`@deepseek-ai/dsh-hooks-claude-code` 直接读你的 `hooks.json`/settings，支持 `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop`/`SubagentStart`/`SubagentStop`，只跑 command hook，exit 2 阻断，`${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` 会替换；另有 codex 方言与 claude-code mods 桥（`defineMod`） |
| skills / 指令文件 | 有 | `SKILL.md`（目录包或扁平 `<name>.md`），搜索序：`<project>/.dsh/skills`→`<project>/.agents/skills`→`customSkillDirs`→`$DSH_HOME/skills`→`~/.agents/skills`→bundled；frontmatter 支持 `disable-model-invocation`/`user-invocable`；模型侧 `skill({name})` 工具。指令文件：`AGENTS.md`/`CLAUDE.md`（+`.local.md`），按 `$DSH_HOME`→`~/.agents`→项目根到 cwd 逐层注入 |
| MCP | 有 | 每个 server 一条 `@deepseek-ai/dsh-mcp-client` 配置行（stdio 或 Streamable HTTP、env、超时/重连），工具名 `mcp__<server>__<tool>`；**无 `mcpServers` JSON 文件**；不支持 prompt 模板、elicitation、resource 订阅 |
| headless | 有 | `dsh --profile headless "任务"`：跑一个持久化会话，末段回答打到 stdout，退出码 `completed`→0 否则 1，不监听端口；另有 `--profile acp`（ACP stdio）、`--profile sdk`（JSON-RPC stdio） |

## 3. 本插件的映射缺口

- `plugin.json` / `.claude-plugin/plugin.json` → 改写成 npm 包 `package.json` 的 `dsh.bundle.patch`；`commands+skills` 目录结构不被识别，需一个插件模块把命令注册进 `ctx.commands`，技能目录走 `bundledSkillDir` 或复制到 `.dsh/skills`。
- `commands/*.md`（7 个）→ 无文件加载器，逐条改写为 handler 或降级为 skill；`${CODEAGENT3_PLUGIN_ROOT}`/`${CODEAGENT3_SESSION_ID}` 无对应变量，`hooks.json` 桥只替换 `CLAUDE_*`，`transcript_path` 恒为空串。
- `workflows/*.yaml`（stage/step + prompt/shell step）→ **没有声明式 YAML 编排**；`workflow` 子系统是模型写的 JS 脚本 + `agent()` 起子代理，需自建插件/命令承载。
- `codeagent-extension.json`（MCP）→ 拆成 Cordis patch 的 MCP 行。
- `bin/cli.js` + npx 引擎 → 由 `dsh plugin`/profile 机制取代，不需要自建 bin。
- 真实缺失：命令级 Markdown 文件、`.claude-plugin` 市场语义、`.claude/rules/` 与 `@path` 导入（指令文档明确"不解释"）。

## 4. 未确定项

- 官方文档站（VitePress）正文在无 JS 抓取下为空，我按仓库 `docs/` 取证；站点与仓库的版本对应关系未核实。
- 技能标记 `user-invocable` 后以 `/命令` 出现在具体哪个适配器——skills 文档只写"进入人类命令目录"，未见适配器级说明。
- 是否存在第三方 bundle 自行实现 `commands/*.md` 加载器（面板生态 `.dsh-plugin`/`plugin-console` 属第三方，非内核）。
- Desktop 版对 `dsh plugin` 的管理限制细节（npm CLI 对 reserved `desktop` profile 拒绝插件操作）。

## 来源

- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/package-manifest/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/commands.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/commands/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/hooks-claude-code/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/hook-protocol/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/mcp.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workflow.md
- https://www.npmjs.com/package/@deepseek-ai/dsh
- https://deepseek-harness.github.io/deepseek-harness/
- https://deepseekdocs.com/en/docs/user-guide/cli（社区站，仅用于交叉比对）
