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

## 安装

在目标项目根目录执行一条命令。命令下载固定版本 `0.1.0` 的 `install.mjs`，校验并安装引擎、载荷和对应适配器。

### claude-code

```powershell
curl.exe --create-dirs -fL -o .r2c/bootstrap/install.mjs https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/install.mjs; node .r2c/bootstrap/install.mjs --agent claude-code --version 0.1.0 --project .
```

### codex

```powershell
curl.exe --create-dirs -fL -o .r2c/bootstrap/install.mjs https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/install.mjs; node .r2c/bootstrap/install.mjs --agent codex --version 0.1.0 --project .
```

### dsh

```powershell
curl.exe --create-dirs -fL -o .r2c/bootstrap/install.mjs https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/install.mjs; node .r2c/bootstrap/install.mjs --agent dsh --version 0.1.0 --scope user --profile web --project .
```

### omp

```powershell
curl.exe --create-dirs -fL -o .r2c/bootstrap/install.mjs https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/install.mjs; node .r2c/bootstrap/install.mjs --agent omp --version 0.1.0 --project .
```

### opencode

```powershell
curl.exe --create-dirs -fL -o .r2c/bootstrap/install.mjs https://github.com/hesl2636/hm2B_drvport_pipiline/releases/download/v0.1.0/install.mjs; node .r2c/bootstrap/install.mjs --agent opencode --version 0.1.0 --project .
```

POSIX 把 `curl.exe` 换成 `curl`。若 `curl` 下载 `install.mjs` 时报 `(56) Connection was reset`，改用 API 下载（需要 token）：

```powershell
$env:GH_TOKEN='<token>'; New-Item -ItemType Directory -Force .r2c\bootstrap | Out-Null; curl.exe -fL -H "Authorization: Bearer $env:GH_TOKEN" -H "Accept: application/vnd.github.raw" -o .r2c/bootstrap/install.mjs "https://api.github.com/repos/hesl2636/hm2B_drvport_pipiline/contents/scripts/install.mjs?ref=v0.1.0"; node .r2c/bootstrap/install.mjs --agent omp --version 0.1.0 --project .
```

把 `omp` 换成目标 agent。若 `install.mjs` 自己报 `fetch failed`，设置 `GH_TOKEN` 后重跑同一条命令。同一项目安装第二个 agent 时加 `--force`。

codex 首次需在 codex 里执行 `/hooks` 信任；dsh 安装后重启。

安装后启动：

```powershell
node .r2c\engine\0.1.0\bin\r2c.js run
```

## 安装后的文件结构

以项目级 `opencode` 安装为例，`<project>` 是执行安装命令的目录：

```text
<project>/
├─ .r2c/
│  ├─ bootstrap/install.mjs      # 下载的引导脚本，可删
│  ├─ engine/0.1.0/              # 引擎
│  ├─ payload/0.1.0/             # 载荷模板
│  └─ install/opencode.json      # 安装回执，卸载依据
├─ .opencode/
│  ├─ commands/r2c-*.md          # 7 个命令
│  ├─ skills/                    # 技能
│  ├─ agents/r2c-*.md            # 子 agent
│  └─ plugins/r2c.ts             # A′ hook
├─ workflows/
│  └─ hm2B_drvport_pipiline.yaml
├─ tasks/
│  └─ step-*.md
└─ skills/
   └─ */
```

`workflows/`、`tasks/`、`skills/` 是复制到项目根的布局副本，可以直接查看和修改。`.r2c/` 保存引擎、载荷、安装回执和运行态；`.opencode/` 是 opencode 的 agent 入口。

首次 `run` 后还会生成 `.r2c/runs/`、`.r2c/ir.md` 和 `.r2c/artifacts/`。

其他 agent 只替换 agent 侧目录：

| Agent | 安装后的 agent 目录 |
| --- | --- |
| `claude-code` | `.claude/`、`.mcp.json` |
| `codex` | `.agents/skills/`、`.codex/` |
| `dsh` | `~/.dsh/profiles/web/`（user scope） |
| `omp` | `.omp/` |
| `opencode` | `.opencode/` |

dsh 是 user scope：引擎、载荷和回执在 `~/.r2c/`，agent 文件在 `~/.dsh/profiles/web/`，项目根仍会得到 `workflows/`、`tasks/`、`skills/`。

## 卸载

```powershell
node .r2c\engine\0.1.0\bin\r2c.js adapter uninstall opencode --project .
```

把 `opencode` 换成 `claude-code`、`codex`、`omp`；dsh 是 user scope，用 `~/.r2c/engine/0.1.0/bin/r2c.js` 并加 `--scope user`。

升级、回滚和完整规则见 [docs/install.md](docs/install.md)。
