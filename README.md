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

项目运行后，`.r2c/` 保存运行态（`runs/`、`usage/`、`plugin/` 等）；`.r2c/ir.md` 与 `.r2c/artifacts/` 是可提交的业务产物。

## 安装与卸载

引擎为 `r2c-runner@0.1.0`，载荷为 `r2c-plugin-0.1.0.tgz`。以下命令在目标项目根目录执行。

### 使用（所有 agent 相同）

```bash
npx r2c-runner@0.1.0 run --project .
# 完成当前步骤后，执行打印的 submit 行
npx r2c-runner@0.1.0 status --project .
```

### claude-code

```bash
npx r2c-runner@0.1.0 adapter install claude-code --from r2c-plugin-0.1.0.tgz --project .
npx r2c-runner@0.1.0 adapter doctor  claude-code --project .
npx r2c-runner@0.1.0 adapter uninstall claude-code --project .
```

项目级，写入 `.claude/` 与 `.mcp.json`。

### codex

```bash
npx r2c-runner@0.1.0 adapter install codex --from r2c-plugin-0.1.0.tgz --project .
npx r2c-runner@0.1.0 adapter doctor  codex --project .
npx r2c-runner@0.1.0 adapter uninstall codex --project .
```

项目级，写入 `.agents/` 与 `.codex/`；首次使用需在 codex 中 `/hooks` 信任 hook。

### dsh

```bash
npx r2c-runner@0.1.0 adapter install dsh --from r2c-plugin-0.1.0.tgz --profile web --project .
npx r2c-runner@0.1.0 adapter doctor  dsh --project .
npx r2c-runner@0.1.0 adapter uninstall dsh --profile web --project .
```

用户级，写入 `~/.dsh/profiles/web/`；安装或卸载后重启 dsh。

### omp

```bash
npx r2c-runner@0.1.0 adapter install omp --from r2c-plugin-0.1.0.tgz --project .
npx r2c-runner@0.1.0 adapter doctor  omp --project .
npx r2c-runner@0.1.0 adapter uninstall omp --project .
```

项目级，写入 `.omp/`。

### opencode

```bash
npx r2c-runner@0.1.0 adapter install opencode --from r2c-plugin-0.1.0.tgz --project .
npx r2c-runner@0.1.0 adapter doctor  opencode --project .
npx r2c-runner@0.1.0 adapter uninstall opencode --project .
```

项目级，写入 `.opencode/` 与 `opencode.json` 的 `mcp`；要求 V1 `>=1.19.5 <2`。

卸载默认保留 `.r2c/` 运行历史与业务产物；加 `--purge-state` 同时删除运行态。完整规则见 [docs/install.md](docs/install.md)。
