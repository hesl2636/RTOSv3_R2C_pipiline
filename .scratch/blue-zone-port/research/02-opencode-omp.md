# 研究结果：opencode 与 omp 的安装单位与扩展原语（票 02）

> 来源：ResearchOpencodeOmp 子代理，2026-10-28。以下为报告原文。

## opencode

### 1. 安装单位

V1（`/docs`）与 V2（`/v2/docs`）双线并存。V1：`npm i -g opencode-ai` 或 `curl -fsSL https://opencode.ai/install | bash`；V2：`npm i -g @opencode/cli`，`opencode upgrade --major` 由 V1 升级；V2 明示不支持 Windows 包管理器（另有 zip）。扩展落盘：项目 `.opencode/{commands,agents,skills,plugins}/` + `opencode.json(c)`；全局 `~/.config/opencode/…`；npm 插件由 `opencode plugin <module>`（V2：`plugin add/list/update/remove`）写入配置、Bun 装到 `~/.cache/opencode/node_modules/`。**没有插件清单文件概念**（无 `plugin.json`）。

### 2. 原语矩阵

| 原语 | 结论 |
|---|---|
| 自定义命令 | 有。`.opencode/commands/*.md`（全局同名目录）；frontmatter `description/agent/model` + V1 `subtask` / V2 `subagent`；正文即模板，`$ARGUMENTS`、`$1…`。V1 支持 `` !`cmd` `` 与 `@file` 注入，V2 明确 `@path` 不展开。JSON：V1 `command` / V2 `commands`（需 `template`）。 |
| 子代理 | 有。`agents/<name>.md` 或 JSON（V1 `agent` / V2 `agents`）；mode `primary|subagent`（V2 加 `all`）、system/prompt、model、permissions、steps、hidden；内置 build/plan/general/explore。 |
| hooks | 仅有代码插件。V1 返回对象键：`tool.execute.before/after`、`event`、`chat.message/params/headers`、`shell.env`、`permission.ask`、`experimental.session.compacting`。V2 改 `Plugin.define({id,setup})`：`ctx.tool.hook("execute.before"/"execute.after")`、`ctx.event.subscribe({types})`、`ctx.session.hook("prompt"/"context"/"compaction"/"retry")`、`ctx.permission.hook("evaluate")`、`ctx.shell.hook("create.before")`。V1 插件不能在 V2 运行。 |
| skills | 有。`.opencode/skills/<id>/SKILL.md`，兼容 `.claude/skills`、`.agents/skills`，`skills` 数组可挂目录/HTTP catalog。V1 强制 name+description+目录名匹配；V2 frontmatter 全可选，无 description 即不向模型广告。 |
| MCP | 有。V1 `mcp.<name>`；V2 `mcp.servers.<name>`；local：`command[]`/`environment`/`cwd`；remote：`url`/`headers`；V2 用 `{env:X}` 替换，V1 的 `enabled` → V2 `disabled`。 |
| headless | `opencode run "<prompt>"`；V1 flags `--agent --model --command --format json --session --attach --file --auto`；`serve` + `--attach` 可复用常驻服务。 |

### 3. 本插件映射缺口

- 4 个 prompt step → 4 个 command：`agent:` 需先落 `agents/*.md`（建议 `mode: subagent`，并在 command 里 `subagent: true` 才隔离上下文）；`skill:` → skills 目录。
- `taskFile:` → V1 可用 `@tasks/step-*.md` 注入；V2 不展开 `@path`，只能写路径让 agent `read`（现模板已是该写法）。
- 2 个 shell step + 6 stage → **无工作流/阶段引擎**，只能用 `opencode run --command` 外部驱动或模板 `` !`cmd` `` 注入；阶段状态与 submit 门禁无原语 → 真缺口。
- `PreToolUse` → `tool.execute.before`（throw 即阻断），语义基本对得上。`Stop` → **无「阻止结束」钩子**：V1 只能订阅 `event` 的 `session.idle` 再经 SDK 提交，V2 用 `ctx.event.subscribe` + `ctx.session.prompt/command`；是插件驱动续跑，非同一语义。
- 7 个 command md 可直接搬入；`name:`、`argument-hint` 非其字段（名称取文件名）。
- MCP：`codeagent-extension.json` 无对应；`command` 已是数组、`environment` 键名一致可直搬；`${CODEAGENT3_*}` 不展开。

### 4. 未确定

V1/V2 谁是蓝区基线（两套 API 不兼容、键名不同：`plugin/plugins`、`command/commands`、`mcp.<name>/mcp.servers`、`subtask/subagent`）；V2 `opencode run` 完整 flag（V2 CLI 页只给一行示例）；V2 事件类型全集是否仍含 `session.idle`；opencode 是否读 `.claude-plugin/plugin.json` 或 `hooks/hooks.json`（文档未提）。

## omp

### 1. 安装单位

一手身份：CLI `omp`、包命名空间 `@oh-my-pi/*`（`@oh-my-pi/pi-coding-agent`）、文档站 live.omp.sh / skills.omp.sh；根文档 `omp://`（134 篇，本机路径即来源），状态目录 `~/.omp/agent/`（实测：`config.yml`、`extensions/`、`skills/`、`sessions/`）与 `~/.omp/plugins/`。安装单位是 plugin 包：`omp plugin install <npm|git>`（写 `~/.omp/plugins/{package.json,node_modules,omp-plugins.lock.json}`）、`omp plugin link <dir>`、`omp plugin install name@marketplace`（catalog：`.omp-plugin/marketplace.json`，回退 `.claude-plugin/marketplace.json`）。运行时只加载 `package.json` 含 `omp`(`pi`) manifest 的包；另有 `-e/--extension`、`--hook`、`--plugin-dir`、项目 `.omp/`。

### 2. 原语矩阵

| 原语 | 结论 |
|---|---|
| 命令 | `.omp/commands/*.md`、`~/.omp/agent/commands/*.md`、插件 `commands/*.md`；frontmatter `description`/`argument-hint`/`side`；`$ARGUMENTS`/`$1`/`$@[start:len]`。 |
| 子代理 | `.omp/agents/*.md`、`~/.omp/agent/agents/*.md`、插件 `agents/`；frontmatter name/description/model/tools/spawns/output/thinking-level。**无 primary-agent 概念**（主会话由内置 prompt + `modelRoles` 决定）。 |
| hooks | **无 hooks.json**。`.omp/hooks/pre|post/*.{ts,js}`、`~/.omp/agent/hooks/pre|post/`、`--hook`；模块 `export default (pi)=>{}`。事件：`tool_call`（可 block/改 input）、`tool_result`、`session_stop`（可 `{decision:"block",reason}` 阻止结束并续跑）、`context`、`before_agent_start`、`session_start/shutdown`、`mcp_notification`。 |
| skills | `.omp/skills/<name>/SKILL.md`（祖先逐级扫描）+ `~/.omp/agent/skills/`；native provider **要求 description**；`skill://` 读取、`/skill:<name>` 调用；兼容 `.claude/skills`、`.agents/skills`、插件 `skills/`。 |
| MCP | `.omp/mcp.json`、`~/.omp/agent/mcp.json`：`mcpServers`（stdio：`command` 字符串+`args`+`env`；http/sse：`url`+`headers`），`${VAR}` 展开；还会翻译读取 `opencode.json` 的 `mcp` map。 |
| headless | `omp -p "<prompt>"`、`--mode json`、`--no-session`、`--max-time`、`--wait-async`；扩展与子代理在 print 模式可用。 |

### 3. 本插件映射缺口

- 4 prompt step：`agent:` → task agent；`skill:` → skills；`taskFile:` → 命令模板无 `@file` 展开，需 agent `read`（现模板兼容）。
- 2 shell step / 6 stage → 无 YAML 编排引擎，可 `omp -p` 或扩展命令串阶段；阶段状态与 submit 门禁无原语 → 真缺口。
- `hooks/hooks.json`（Claude command-hook，node 读 stdin JSON）：文档无此读取路径 → **必须重写为 TS 扩展**；`tool_call` ≈ PreToolUse，`session_stop` ≈ Stop 且能 block 续跑（比 opencode 更贴合）。
- 7 个 command md → `.omp/commands/`；`name:` 不在支持字段表（名称取文件名）。
- MCP：`codeagent-extension.json` 不被读；需转 `.omp/mcp.json`（`command` 数组 → `command`+`args`，`environment` → `env`），或 marketplace 包 `.claude-plugin/plugin.json` 的 `mcpServers` / 默认 `.mcp.json`。
- 安装：仓库 `package.json` 为 `private` 且无 `omp` 字段 → link/install 后运行时被跳过；需补 manifest 或改走 `.omp/` + `--extension`。
- 35 个 0 字节 `SKILL.md`：native provider 缺 description → 全部不注册（与「先占位」方向冲突）。

### 4. 未确定

omp 公开产品页/文档站域名（本地仅 live.omp.sh、skills.omp.sh 与 `omp://`，未核公开一手页面）；`.claude-plugin/plugin.json` 的 `commands`/`skills` 重映射是否对本地目录（非 marketplace 安装）同样生效；claude-plugins provider 是否解析 Claude `hooks/hooks.json`（catalog 里 `hooks` 明确只是 metadata）。

## 来源

- opencode V1：https://opencode.ai/docs/config/ ・/commands/ ・/agents/ ・/plugins/ ・/skills/ ・/mcp-servers/ ・/cli/ ・/rules/
- opencode V2：https://opencode.ai/v2/docs/config ・/commands ・/agents ・/plugins ・/skills ・/mcp-servers ・/cli ・/build/plugins ・/build/plugins/server ・/build/plugins/migrate-v1
- omp（本机 `omp://`）：extensions.md、extension-loading.md、hooks.md、mcp-config.md、skills.md、slash-command-internals.md、cli-reference.md、task-agent-discovery.md、plugin-manager-installer-plumbing.md、marketplace.md、skills/authoring-marketplaces.md；现场核对 `~/.omp/agent/{config.yml,extensions,skills}`、`~/.omp/plugins`；站点 https://live.omp.sh 、https://skills.omp.sh
