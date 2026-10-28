# 研究结果：harness-engine@0.2.x 的语义与状态协议复原（票 04）

> 来源：ResearchEngineSemantics 子代理，2026-10-28。引擎包本体不可得，以下全部从仓库调用点反推。
> 标注：**[证实]**=代码直接证据；**[推断]**=由证据合理推导；**[未确定]**=无证据。

## 1. 引擎 CLI 子命令面

| 子命令 | 参数 | 证据 |
|---|---|---|
| `run` | `--workflow-name <yaml文件名> --plugin-root --project-root . --session-id --prompt-mode agent --input "$ARGUMENTS"` | [证实] `commands/RTOSv3_R2C_pipiline.md:18` |
| `status` / `pause` / `resume` / `cancel` | `--plugin-root --project-root . --session-id`（四者同形） | [证实] `commands/harness-status.md:9`、`harness-pause.md:9`、`harness-resume.md:9`、`harness-cancel.md:9` |
| `hook stop` / `hook pre-tool-use` | `--plugin-root --project-root --session-id` | [证实] `hooks/harness-guard.js:135-136` |
| `submit` / `submit-gate-review` / `token-usage` | 仅名字见于注释「引擎 hook-stop 生成的 agent 面向命令」；具体参数**[未确定]** | [证实名字] `bin/cli.js:5-6` |

调用协议 [证实]：`bin/cli.js` 剥出 `--plugin-root`（缺省=脚本上级目录，`cli.js:31-34`），其余参数原样转发，末尾强制追加 `--plugin-root`（`cli.js:37-41`）；引擎退出码原样透传（`cli.js:46`）。所有入口统一经 `npx -y --silent --strict-ssl=false --registry <内网> @codeagent3-temp/harness-engine@0.2.x`（`cli.js:38`；`harness-guard.js:132-135`）。Submit 命令形如 `node "<插件根>/bin/cli.js" …`，插件根由 agent 从命令文本自识别（`workflows/RTOSv3_R2C_pipiline.yaml:40` prompt 内文）。

## 2. state.json 与 run 目录字段级复原

**位置**：`~/.cac/projects/<projectId>/runs/<runId>/`；runId 以 `R` 开头且字典序=时间序（`upload-session.mjs:131-134`、`analyze-session.mjs:80`）。

**run 目录内容** [证实]：

- `state.json`（引擎写；存在性即 run 有效判据，`harness-guard.js:69-70`）
- `workflow.yaml`（引擎拷贝的 run 级快照，`analyze-session.mjs:173`、`upload-bundle.mjs:504`）
- `trace/events.jsonl`（引擎写，`runstate-loader.mjs:5`、`upload-bundle.mjs:518`）
- `runs/latest.json`：`{runs:{<sessionId>:{active_run_id,latest_run_id}}, active_run_id, latest_run_id}`（引擎写、guard 读，`harness-guard.js:58-66`）
- 插件脚本追加：`upload-marker.json`（`upload-session.mjs:169,214-222,248-255`）、`session-slice.jsonl`+`session-slice/{subagents,session-memory}/`（`collect-sessions.mjs:125,166,188`）、`analysis/`（`analyze-session.mjs:160`）

**state.json 字段**（引擎写；下游读方标注）[证实]：

`run_id`（`upload-bundle.mjs:134`）、`session_id`（`analyze-session.mjs:120`、`collect-sessions.mjs:103`）、`status`（`upload-bundle.mjs:494`；枚举值**[未确定]**）、`workflow_engine`=插件名（`harness-guard.js:112` 多插件路由）、`engine`/`engine_version` 如 "0.2.1"（`build-manifest.mjs:76`）、`interaction_mode`（`build-manifest.mjs:144`，[推断]来自 `--prompt-mode`）、`started_at`/`updated_at`/`completed_at`（`collect-sessions.mjs:110-111`、`build-manifest.mjs:145-146`）、`user_input`（`build-manifest.mjs:147`，[推断]来自 `run --input`）、`workflow_id`（`upload-bundle.mjs:457,494`）、`stages`（数组或 id→对象双形态；`id,name,status,trace_started_at,trace_completed_at`，`build-manifest.mjs:44-53`）、`steps`（双形态；`id,name,status,retry_count,review_retry_count`，可选 `stage_id,skill`；**无时间戳**——时间在 events.jsonl，`build-manifest.mjs:55-69`；`steps[stepId].status` 被 sdoc 当 checkpoint 用，`sdoc-js/index.mjs:261-267`）。

**events.jsonl 事件**：`{kind:"step", event:"started"|"completed"|"submitted", step:{id,name}, time}`（`runstate-loader.mjs:145-176`、`upload-bundle.mjs:141-151`）。`submitted` 是 submit 命令产生的完成变体（`runstate-loader.mjs:165-167`）。其他 kind **[未确定]**。

## 3. 阶段/步骤推进与门禁语义

- **驱动方式**：Stop 钩子是主循环——「Stop hook drives workflow next actions and PreToolUse protects runtime facts」（`hooks.json:1`）；run 启动后「Harness hooks drive the next action」（`commands/RTOSv3_R2C_pipiline.md:21`）。[证实]
- **prompt step**：引擎经 hook-stop 把 `command.prompt` 注入 agent；`taskFile`（插件根相对路径）是真正的任务书，prompt 只强制「先读任务文件再执行、未读禁止提交」（`yaml:40`）；`agent:`（bys-architect 等 4 个）与 `skill:`（req-analysis 等）由引擎消费——引擎「直接执行 skill 不产生 tool_use Skill 记录」（`sdoc-js/index.mjs:255-258` 注释）[证实存在，消费细节**[未确定]**]。任务文件尾部声明步骤可用 skills/MCP 白名单（`tasks/step-01479654….md:27-29`）。
- **shell step**：引擎按 `command.type: shell` 直接执行内联命令，`timeout` 以秒计（300/1800，`yaml:78,86`）。两条 shell step 自行定位插件根并 `import()` `scripts/upload-session.mjs` / `analyze-session.mjs`（`yaml:77,85`），失败 `process.exit(0)` 不阻塞（`upload-session.mjs:339`、`analyze-session.mjs:333`）。
- **推进**：agent 完成步骤后执行 hook-stop 给出的 Submit 命令 → 引擎写 `submitted/completed` 事件 + 更新 `state.steps[stepId].status` → 下一次 Stop 钩子给出下一步。[推断，基于 `runstate-loader.mjs:165-167` + `bin/cli.js:5-6` + `yaml:40`]
- **门禁**：exit 门禁条件写在任务文件（如「SR 对拍不通过不得提交；formal-verif 不通过不得提交」，`tasks/step-01479654….md:19-20`）；`submit-gate-review` 子命令 + `steps[].review_retry_count`/`retry_count` 表明存在评审提交与重试计数（`bin/cli.js:6`、`build-manifest.mjs:68-69`）。门禁校验逻辑本体**[未确定]**。
- **hook 前置守卫**（插件侧，非引擎）：guard 按 `state.workflow_engine` 与插件名模糊匹配决定是否放行，不匹配 `exit 0` 跳过；无法判定时保守放行，「交给引擎自身按 session 路由 no-op」（`harness-guard.js:106-129`）→ [推断]引擎 hook 对非本 session 的调用自身也是 no-op。

## 4. 插件根与 session 发现规则

- **formatProjectId**（与引擎 run-dir.js 逐字节一致，`harness-guard.js:36-49`）：`resolve()` → `\`→`/` → 非 `[A-Za-z0-9]`→`-`（保留首尾）→ >120 时 `slug.slice(0,109)+"-"+sha1(normalized).slice(0,10)` → 空回退 `"project"`。同实现复制于 `upload-session.mjs:82-88`、`collect-sessions.mjs:24-31`、`analyze-session.mjs:48-55`。旧规则=原始路径替换+剥首尾连字符，仅作兼容候选（`upload-session.mjs:90-94`）。
- **run 定位**：首选编码目录 `runs/latest.json`，按 sessionId 取 `active_run_id||latest_run_id`；失败则遍历全部 `~/.cac/projects/*/runs`（`harness-guard.js:53-93`）。脚本侧不用 latest.json，直接扫 `R*` 目录按 `state.session_id` 匹配、回退最新（`upload-session.mjs:127-163`）。
- **插件根**：`CODEAGENT3_PLUGIN_ROOT` 环境变量 > `__dirname` 向上 3 级找 `config.json+plugin.json` > 扫 `~/.cac/plugins/marketplaces/<market>/<plugin>/`（`upload-session.mjs:49-76,266`；`commands/upload.md:15`）。guard 的插件名提取兼容 `<market>/<name>/<version>` 与 `dev/<name>`（`harness-guard.js:96-103`）。
- **session 文件**：`~/.cac/projects/<projectId>/<sessionId>.jsonl` + `<sessionId>/subagents/*.jsonl` + `<sessionId>/session-memory/*.jsonl`（`collect-sessions.mjs:124,155,183`）——由 CodeAgentCLI 写，引擎只引用。

## 5. 重写引擎：最小保留清单 vs 可丢弃

**必须保留**（有下游硬依赖）：

1. `state.json` 全部被消费字段及双形态 stages/steps（§2 证据；manifest/meta/snapshot/切片全依赖）。
2. run 目录布局：`R*` runId、`state.json`、`workflow.yaml` 快照、`trace/events.jsonl`（`upload-bundle.mjs:488-529` 整目录打进 zip 供 ca-viewer）。
3. events.jsonl 的 `kind:step` + `started/completed|submitted` + `time` + `step.{id,name}`（步骤窗口归因的唯一时间源，`runstate-loader.mjs:145-176`、`pipeline.mjs:513`）。
4. `runs/latest.json` 的 `runs[sessionId].active_run_id/latest_run_id`（guard 路由，`harness-guard.js:58-66`）。
5. `formatProjectId` 逐字节一致（4 处独立实现互认，`harness-guard.js:36-41`）。
6. 子命令面 `run/status/pause/resume/cancel/hook stop/hook pre-tool-use/submit(+gate-review/token-usage)` 及 `--plugin-root/--project-root/--session-id` 参数约定、退出码透传（`cli.js:37-46`）。
7. Stop 钩子输出「含 `node "<插件根>/bin/cli.js"` 的 Submit 命令 + 步骤 prompt」的协议（agent 靠文本自识别插件根，`yaml:40`）。
8. shell step 的 `timeout`（秒）执行语义（`yaml:78,86`）。
9. `workflow_engine` 写入=插件名（多插件共存路由，`harness-guard.js:110-125`）。
10. hook 在非本 session run 时 no-op（`harness-guard.js:107` 注释所述引擎行为）。

**可丢弃**：

1. npx+内网 registry+`--strict-ssl=false` 分发链（`cli.js:38`）——已定方向：公共可达包直接调用。
2. 旧 `run-state/run-<sessionId>/` 路径兼容（`runstate-loader.mjs:73-116`，自注「旧路径（兼容保留）」）。
3. 旧 projectId 编码候选（`upload-session.mjs:92`，纯历史兼容）。
4. guard 的「遍历全部 projects 目录」兜底（`harness-guard.js:76-93`，为 cwd 漂移/旧编码兜底，重写后编码唯一即可）。
5. `engine_version` 别名兼容（`build-manifest.mjs:76` 双字段 fallback）。

**未确定项**（禁止臆造，重写前需实测或问原作者）：`submit/submit-gate-review/token-usage` 的完整参数与输出契约；`state.status` 枚举值；Stop 钩子与 agent 的通信协议细节（stdout 文本 or hook JSON decision）；`agent:` 字段是否触发子代理切换（本 yaml 无 `use_subagent`，该键仅 `upload-bundle.mjs:229` 认识）；`artifact_defaults.target: change`（`yaml:7-8`）的消费者；PreToolUse 钩子「protects runtime facts」的具体拦截规则；门禁（gate）校验的实现位置与判据。
