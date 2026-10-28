# 研究结果：claude code 与 codex 的安装单位与扩展原语（票 01）

> 来源：ResearchClaudeCodex 子代理，2026-10-28。以下为报告原文。

## 一、Claude Code（Claude Code 2.1.312，npm `@anthropic-ai/claude-code` latest）

### 1. 安装单位

- CLI：`curl -fsSL https://claude.ai/install.sh | bash`（Win 用 `install.ps1`/`install.cmd`）、`brew install --cask claude-code`、`winget install Anthropic.ClaudeCode`。
- 插件：`/plugin marketplace add <owner/repo|git URL|本地目录|marketplace.json URL>` → `/plugin install <name>@<market>`；或 `claude plugin install <name>@<market> --scope user|project|local`。
- 落盘：`~/.claude/plugins/`；启用记录 `enabledPlugins` 写入 `~/.claude/settings.json`（user）、`.claude/settings.json`（project）、`.claude/settings.local.json`（local）。单次调试可 `claude --plugin-dir <path>`。
- 清单**必须**位于 `.claude-plugin/plugin.json`（无清单时按标准布局 `skills/ commands/ agents/ hooks/hooks.json .mcp.json` 加载）。

### 2. 原语矩阵

| 原语 | 有无 | 落点/形态 |
|---|---|---|
| 自定义命令 | 有 | `commands/*.md` → `/plugin:name`；frontmatter `description/argument-hint/allowed-tools/model`；正文支持 `$ARGUMENTS/$0/$1`、`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_SESSION_ID}` |
| 子代理 | 有 | `agents/*.md`（`name/description/tools/model`），命名空间 `plugin:agent`，`@agent-plugin:name` 调用 |
| hooks | 有 | `hooks/hooks.json`；事件约 30 个：`SessionStart/End`、`Setup`、`UserPromptSubmit`、`UserPromptExpansion`、`PreToolUse`、`PermissionRequest/Denied`、`PostToolUse/Failure/Batch`、`SubagentStart/Stop`、`Stop/StopFailure`、`Pre/PostCompact`、`Notification`、`FileChanged`、`CwdChanged` 等 |
| hooks stdin | 有 | 每个 command hook 收一个 JSON：`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`permission_mode`，工具事件另加 `tool_name/tool_input/tool_use_id`；输出 `hookSpecificOutput.permissionDecision` / `decision:"block"+reason`；进程内另有 `CLAUDE_CODE_SESSION_ID`、`CLAUDE_PLUGIN_ROOT` |
| skills | 有 | `skills/<name>/SKILL.md`（需 `description`），`/plugin:skill`，支持 `context: fork` |
| MCP | 有 | 插件根 `.mcp.json` 或 manifest `mcpServers`，`{command,args,env}`；用户级 `~/.claude.json`；项目 `.mcp.json`；`claude mcp add --scope` |
| headless | 有 | `claude -p`，`--output-format text\|json\|stream-json`、`--json-schema`、`--plugin-dir`、`--mcp-config`、`--agents`、`--bare`；另有 Agent SDK |

### 3. 本插件映射缺口

- 根 `plugin.json` 不生效，只有 `.claude-plugin/plugin.json` 生效；`name` 非 kebab-case 仅告警。
- `hooks/hooks.json` 结构一致；`${CODEAGENT3_PLUGIN_ROOT}` → `${CLAUDE_PLUGIN_ROOT}`，`${CODEAGENT3_SESSION_ID}` → hook stdin 的 `session_id`（或 `CLAUDE_CODE_SESSION_ID`）。
- `workflows/*.yaml`（stage/step/`agent:`/`skill:`/`taskFile:`）**无对应原语**：Claude Code 的 `workflows/` 是 `export const meta` + `agent()` 的 JS，不是 YAML；必须把编排留在引擎/状态机。
- `codeagent-extension.json` 的 `{type:"local", command:[...], environment:{}}` 不被识别，须改写为 `mcpServers.<n>.{command:"uvx",args:[...],env:{}}`。
- 0 字节 `skills/` 无 `description`，不会被技能列表采用。

### 4. 未确定项

- 根 `plugin.json` 是否被任何版本容错读取（文档只认 `.claude-plugin/`）。
- hook command 内 `${CLAUDE_SESSION_ID}` 替换（变量表只列 ROOT/DATA/PROJECT_DIR，SESSION_ID 只在 skill 正文列出）。

## 二、Codex（Codex CLI 0.165.0，rust-v0.165.0，2026-10-27）

### 1. 安装单位

- CLI：`npm i -g @openai/codex`、`brew install --cask codex`、standalone `install.sh`/`install.ps1`。
- 配置：`~/.codex/config.toml`（`CODEX_HOME` 可改）；项目 `.codex/config.toml`（仅受信任项目加载）；`~/.codex/AGENTS.md` + 仓库 `AGENTS.md`（`AGENTS.override.md` 优先，32 KiB 上限）。
- 插件：`codex plugin marketplace add ./<marketplace-root>`（或 `owner/repo`、git URL）→ `/plugins` 浏览器或 `codex plugin add`；缓存落 `~/.codex/plugins/cache/<market>/<plugin>/<version>/`。清单为根 `plugin.json`（Agent Plugins schema），兼容 `.codex-plugin/plugin.json` 与 Claude 清单。

### 2. 原语矩阵

| 原语 | 有无 | 落点/形态 |
|---|---|---|
| 自定义命令 | 等价物 | 首选 skills（`$name`、`/skills`）；旧 `~/.codex/prompts/*.md` → `/prompts:name`（`$1..$9`/`$ARGUMENTS`），文档已标 **deprecated**，且仅用户级 |
| 子代理 | 有 | 内建 `default/worker/explorer`；`~/.codex/agents/*.toml`、`.codex/agents/*.toml`，必填 `name/description/developer_instructions`，可选 `model`、`model_reasoning_effort`；`[agents]` 设默认；不能覆盖沙箱/审批/MCP；`/subagents` 查看 |
| hooks | 有 | `~/.codex/hooks.json`、`~/.codex/config.toml [hooks]`、`.codex/hooks.json`、插件 `hooks/hooks.json`；事件：`SessionStart/End`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact/PostCompact`、`SubagentStart/Stop`、`Stop`、`Interrupt`；handler 仅 `command`/`mcp_tool`（`prompt`/`agent` 解析后跳过）；**非托管 hook 需人工 `/hooks` 信任**，否则不执行 |
| hooks stdin | 有 | 同一对象：`session_id/transcript_path/cwd/hook_event_name/model`，工具事件加 `tool_name/tool_input/tool_use_id`；`Stop` 可 `decision:"block"+reason` 续跑，或 exit 2 |
| skills | 有 | `.agents/skills`、`$HOME/.agents/skills`、`/etc/codex/skills`、插件 `skills/`；`SKILL.md` 必填 `name`+`description` |
| MCP | 有 | `[mcp_servers.<id>] command/args/env`（项目级 `.codex/config.toml`）；`codex mcp add`；插件 `mcp.json`（portable，需 `type`） |
| headless | 有 | `codex exec`，`--json`（JSONL：`thread.started`/`turn.*`/`item.*`/`error`）、`--output-schema`、`-o`、`--ephemeral`、`exec resume`；默认只读沙箱、要求 git 仓库 |

### 3. 本插件映射缺口

- YAML 工作流无原语；Codex 连 JS workflow 都没有 → 编排只能留在引擎。
- 每 step 的 `agent:` → `agents/*.toml`（TOML，不能用 md；无工具白名单，只有 `features.*` 开关）。
- `skill:`/`taskFile:` 只能写进 prompt 文本（Read 工具自行读取），无声明字段。
- 命令/skill 正文**无** `${PLUGIN_ROOT}`/`${SESSION_ID}` 变量替换；插件 hook 进程仅注入 `PLUGIN_ROOT`、`PLUGIN_DATA`（并兼容 `CLAUDE_PLUGIN_ROOT`），session id 必须从 stdin JSON 读 → 现有 `--session-id "${CODEAGENT3_SESSION_ID}"` 参数化写法需改。
- MCP 形状不兼容：`command` 数组/`environment` → `command` 字符串 + `args` + `env` 表。
- 插件 hooks 首次运行需信任，直接影响「首步能提交」的验收。

### 4. 未确定项

- CLI 是否同 desktop 一样读取 `<repo>/.claude-plugin/marketplace.json`（文档把该路径限定在 desktop app）。
- `Stop` hook 是否有连续续跑上限（Claude 为 8 次）。
- 插件 skill 是否有 `/plugin:skill` 命名空间（文档只写 `$name`/`/skills`）。
- portable `mcp.json` 的 stdio 条目字段（仅给 streamable-http 示例）。

## 三、逐项映射总表

| 插件资产 | Claude Code | Codex | 真缺口 |
|---|---|---|---|
| 6 stage / 6 step YAML | 无（JS workflow 形态不同） | 无 | **有：编排必须留在引擎** |
| 4 个 prompt step（agent+skill+taskFile） | agents + 正文指令 | agents TOML + 正文指令 | 中：无 step 级声明 |
| 2 个 shell step | Bash | shell 工具 | 无 |
| 7 个 slash 命令 | `commands/*.md` | skills / 旧 prompts | 中：Codex 无插件命名空间变量 |
| PreToolUse guard | 有（同形 deny） | 有（同形 deny） | 无 |
| Stop 驱动下一步 | 有（block+reason，8 次上限） | 有（block+reason） | 无（Codex 上限未知） |
| 3 个内网 MCP | `.mcp.json` | `config.toml`/`mcp.json` | 小：仅改形状 |
| 状态/上传脚本 | 可保留 | 可保留 | 依赖切断内网 |

## 来源

- https://code.claude.com/docs/en/setup.md
- https://code.claude.com/docs/en/plugins/install.md
- https://code.claude.com/docs/en/plugins/manifest-reference.md
- https://code.claude.com/docs/en/plugins/components.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/skills.md
- https://code.claude.com/docs/en/sub-agents.md
- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/headless.md
- https://code.claude.com/docs/en/env-vars.md
- https://registry.npmjs.org/@anthropic-ai/claude-code/latest
- https://learn.chatgpt.com/docs/codex/cli.md
- https://learn.chatgpt.com/docs/config-file/config-basic.md
- https://learn.chatgpt.com/docs/agent-configuration/agents-md.md
- https://learn.chatgpt.com/docs/agent-configuration/subagents.md
- https://learn.chatgpt.com/docs/hooks.md
- https://learn.chatgpt.com/docs/build-skills.md
- https://learn.chatgpt.com/docs/custom-prompts.md
- https://learn.chatgpt.com/docs/extend/mcp.md
- https://learn.chatgpt.com/docs/non-interactive-mode.md
- https://learn.chatgpt.com/docs/plugins.md
- https://developers.openai.com/plugins/build/plugins.md
- https://learn.chatgpt.com/docs/developer-commands.md?surface=cli
- https://github.com/openai/codex/releases/tag/rust-v0.165.0
