# r2c-runner

声明式工作流运行器：一份 `r2c.workflow/v1` YAML 驱动四个阶段，运行态保存在项目 `.r2c/`，每个步骤交给已安装的 agent 执行。

## 仓库结构

```text
bin/r2c.js            命令行入口
src/                  引擎
  commands/           run/next/submit/status/pause/resume/cancel/token-usage/hook/validate/adapter/acceptance
  adapter/            唯一安装器：install/doctor/smoke/uninstall/prune
  acceptance/         零模型验收
  state.js            运行态、事件、锁、replay
pack/                 工作流内容
  workflows/          1 份默认清单（四阶段）
  tasks/              4 份阶段任务书
  skills/             35 份技能
  commands/           7 个 r2c-* 命令
adapters/             五个 agent 的声明与资产：claude-code、codex、dsh、omp、opencode
shims/hook.mjs        五个 agent 共用的 hook 中间层
plugins/              冻结的业务插件：analysis、upload、intranet-mcp
schema/               7 份 JSON Schema
test/ scripts/ docs/ .github/   测试、打包、文档、CI
```

项目运行后，`.r2c/` 保存运行态（`runs/`、`usage/`、`payload/`、`engine/` 等）；`.r2c/ir.md` 与 `.r2c/artifacts/` 是可提交的业务产物。

## 安装与卸载

只有一个分发渠道：GitHub Release（`hesl2636/RTOSv3_R2C_pipiline`）上的四个资产
`r2c-engine-<V>.tgz`、`r2c-payload-<V>.tgz`、`install.mjs`、`SHA256SUMS.txt`。没有 npm 渠道，
也不需要手工复制载荷布局：`install.mjs` 按 `SHA256SUMS.txt` 校验并解包引擎到
`.r2c/engine/<V>/`（`--scope user` 时为 `~/.r2c/engine/<V>/`），随后由该引擎校验载荷、
把 `workflows/`、`tasks/`、`skills/` 逐文件复制到项目根、写好 agent 配置并留下安装回执。
版本 `V` = `0.1.0`，与 [docs/compat.md](docs/compat.md) 一致。以下命令都在目标项目根目录执行，
完整规则见 [docs/install.md](docs/install.md)。

### 首次安装

有 `gh`（POSIX）：

```bash
mkdir -p .r2c/bootstrap
gh release download v0.1.0 -R hesl2636/RTOSv3_R2C_pipiline -p install.mjs --dir .r2c/bootstrap
node .r2c/bootstrap/install.mjs --agent claude-code --version 0.1.0 --project .
```

有 `gh`（Windows cmd / PowerShell）：

```bat
mkdir .r2c\bootstrap
gh release download v0.1.0 -R hesl2636/RTOSv3_R2C_pipiline -p install.mjs --dir ".r2c\bootstrap"
node ".r2c\bootstrap\install.mjs" --agent claude-code --version 0.1.0 --project "."
```

没有 `gh`，就用仓库检出里的同一份引导脚本（`scripts/install.mjs` 与发行版里的
`install.mjs` 资产是同一个文件）：

```bash
node scripts/install.mjs --agent claude-code --version 0.1.0
node scripts/install.mjs --agent claude-code --version 0.1.0 --project "../other project"
```

```bat
node scripts\install.mjs --agent claude-code --version 0.1.0
node scripts\install.mjs --agent claude-code --version 0.1.0 --project "..\other project"
```

`--version` 省略时取最新正式发布（需要 GitHub API）；`--scope` 默认 `project`，`--project`
默认当前目录。含空格的路径必须加引号：Windows 用 `"C:\work\my project"`，POSIX 用
`"$HOME/my project"`。作用域差异：`project` 把引擎、载荷、回执都放在项目 `.r2c/` 下，写进
hook 与 Submit 行的是项目相对路径 `.r2c/engine/<V>/bin/r2c.js`，项目改名或移动后仍然可用；
`user` 把引擎、载荷、回执放在 `~/.r2c/`，agent 配置落在用户目录，写进配置的是带引号的绝对路径，
而载荷布局仍然复制到 `--project` 指向的项目根。

| agent | 作用域 | 额外参数 | 写入 |
| --- | --- | --- | --- |
| `claude-code` | project / user | — | `.claude/`、`.mcp.json` |
| `codex` | project | — | `.agents/skills/`、`.codex/`；首次要在 codex 里 `/hooks` 信任 |
| `dsh` | user | `--profile web` | `~/.dsh/profiles/web/`；安装后重启 dsh |
| `omp` | project / user | — | `.omp/` |
| `opencode` | project / user | — | `.opencode/`、`opencode.json` 的 `mcp` |

下一步：`node .r2c/engine/0.1.0/bin/r2c.js run`（Windows：`node ".r2c\engine\0.1.0\bin\r2c.js" run`）。

### 升级

引擎、载荷和适配器锁成一组版本，升级就是按新版本重跑同一条命令：

```bash
node .r2c/bootstrap/install.mjs --agent claude-code --version <new-V> --project .
```

```bat
node ".r2c\bootstrap\install.mjs" --agent claude-code --version <new-V> --project "."
```

检出里则用 `node scripts/install.mjs --agent <id> --version <new-V>`。新的引擎与载荷落到
`.r2c/engine/<new-V>/`、`.r2c/payload/<new-V>/`，hook、Submit 行与回执改指新入口；上一版引擎与载荷
在本回执拥有、且没有别的回执引用时被删除（只升级一个 agent 时，其他 agent 用到的旧版本会保留）。
同一版本重跑不写任何文件，退出码 `0`。

下一步：`node .r2c/engine/<new-V>/bin/r2c.js adapter doctor claude-code --project .` 确认自检通过。

### 回滚

回滚不是把 `PATH` 指回旧引擎（回执、hook 与 Submit 行仍指向安装时写下的入口），而是按旧版本重装
这一组：

```bash
node .r2c/bootstrap/install.mjs --agent claude-code --version <old-V> --project .
```

```bat
node ".r2c\bootstrap\install.mjs" --agent claude-code --version <old-V> --project "."
```

旧载荷优先取自 `~/.r2c/cache/payload-<old-V>`，否则从 `v<old-V>` 发布下载。若安装报 `CONFLICT`
（目标是不属于旧回执的文件），旧引擎此时已在磁盘上，用显式覆盖补完（先备份到
`.r2c/install/backup/`）：

```bash
node .r2c/engine/<old-V>/bin/r2c.js adapter install claude-code --scope project --project . --force
```

```bat
node ".r2c\engine\<old-V>\bin\r2c.js" adapter install claude-code --scope project --project "." --force
```

下一步：`node .r2c/engine/<old-V>/bin/r2c.js adapter doctor claude-code --project .`

### 卸载

```bash
node .r2c/engine/0.1.0/bin/r2c.js adapter uninstall claude-code --project .
```

```bat
node ".r2c\engine\0.1.0\bin\r2c.js" adapter uninstall claude-code --project "."
```

`--scope user` 安装的用 `~/.r2c/engine/0.1.0/bin/r2c.js` 并加 `--scope user`。卸载只删回执里
记录的文件（agent 配置与项目根的布局副本），只撤销本安装合并进 JSON 的条目，回收自建空目录，
并在没有别的回执引用时才删除载荷与引擎。sha256 已变的文件留在 `leftover[]` 里交人工处理（`--force`
才删）。`.r2c/` 下的运行历史与业务产物默认保留；加 `--purge-state` 连 `.r2c/runs/`、`.r2c/usage/`、
`.r2c/latest.json`、已装载荷和 `.r2c/install/` 一起删除。

下一步：`git status --short`，核对被回退的布局文件后再提交。
