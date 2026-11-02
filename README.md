# r2c

r2c 把一份声明式移植工作流（bundle）编译成中立 IR，再投影成具体 runtime 的文件集：`r2c`（带状态、门禁、提交的运行器）或 `agent-native`（五个宿主的原生技能与子 agent 定义）。

## 快速开始

从某个 bundle Release 安装（`install.mjs` 是 Release 里的引导器，路径与文件名冻结）：

```bash
node install.mjs --bundle rtosv3-drvport --version 1.0.0 --projection r2c --project .
node .r2c/bin/r2c.js status
```

安装器只校验并写盘：Release 里的 zip、`workflow.ir.json`、预投影载荷、引擎与框架资产都必须与 `SHA256SUMS.txt` 一致；安装过程不编译、不投影、不联网取模型。

## 仓库结构

- `core/`、`ir/`、`assembler/`、`projection/`：纯契约层（浏览器可 import，无 `node:*`）。
- `runtime/shared/`：跨投影渲染（角色、宪法、占位、`{{submit}}`、确定性 YAML）。
- `runtime/r2c/`：r2c 投影、契约、schema 与可独立发布的引擎；引擎只依赖 `core/`、契约与 `yaml`。
- `runtime/agent-native/`：一个投影、五个 target；target 描述符声明能力、布局、检测与资产。
- `installer/`、`bin/`、`web/`：组合根（安装、框架 CLI、本地前端）。
- `examples/rtosv3/`：首个样例 bundle 与确定性 zip。
- `scripts/`：`install.mjs` 引导器、bundle 构建、发布与校验工具。

完整树见 [`docs/layout.md`](docs/layout.md)，安装/升级/回滚见 [`docs/install.md`](docs/install.md)，词汇见 [`GLOSSARY.md`](GLOSSARY.md)。

## 开发

```bash
node --test --test-concurrency=8 test/*.test.js
node scripts/build-bundle.mjs examples/rtosv3/bundle --check
node scripts/release.mjs --check
node web/serve.mjs
```

Node 版本：`>=22.19.0 <23 || >=24.0.0`。唯一第三方依赖是 `yaml`，只由引擎用于解析已安装的清单；框架侧只写出 YAML。

## 版本

框架（`r2c-framework`）、引擎（`r2c-runner`）与 bundle 各自 semver；契约修订（`r2c.bundle/v1`、`r2c.ir/v1`、`r2c.projection/v1`）与组件版本正交。`docs/compat.md` 由 `node scripts/release.mjs --compat` 生成。
