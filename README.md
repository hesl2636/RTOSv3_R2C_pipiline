# hm2b

hm2b 把一份声明式移植工作流（bundle）编译成中立的编译工作流（compiled workflow），再投影成具体 runtime 的文件集：`runner`（带状态、门禁、提交的运行器）或 `agent-native`（五个宿主的原生技能与子 agent 定义）。

## 快速开始

从某个 bundle Release 安装（`install.mjs` 是 Release 里的引导器，路径与文件名冻结）：

```bash
node install.mjs --bundle rtosv3-drvport --version 1.0.0 --projection runner --project .
node .hm2b/bin/hm2b.js status
```

安装器只校验并写盘：Release 里的 zip、`workflow.compiled.json`、预投影载荷、引擎与框架资产都必须与 `SHA256SUMS.txt` 一致；安装过程不编译、不投影、不联网取模型。

## 契约 v2

bundle 与编译工作流的契约修订都是 v2：`hm2b.bundle/v2` 与 `hm2b.compiled-workflow/v2`。v1 文档不再被校验器接受。

bundle manifest（`bundle.json`）的字段是 `schema`、`id`、`name`、`version`、`description`、`stages`、`roles`、`tasks`、`skills`、`knowledgeBase`、`checklists`、`hooks`、`mcp`、`constitution`、`requires`。除阶段、角色、任务与技能外，bundle 还携带四类资产，目录固定：

| 资产 | 清单字段 | 归档路径 |
| --- | --- | --- |
| 知识库 | `knowledgeBase[]` | `knowledge-base/<group>/<subgroup>/<file>.md` |
| 检查单 | `checklists[]` | `checklists/<id>.md` |
| hooks | `hooks.path` | `hooks/hooks.json`（规范 JSON） |
| MCP | `mcp.path` | `mcp.json`（规范 JSON，`mcpServers` 必须是对象） |

资产路径最多 4 段、100 个 UTF-8 字节。资产只按声明接纳：`hooks/hooks.json` 与 `mcp.json` 需要清单声明，知识库与检查单的每个文件都要出现在对应数组里；未声明的资产文件报 `BUNDLE_UNEXPECTED_PATH`，已声明但缺失的报 `BUNDLE_ASSET_FILE_MISSING`。

编译工作流（`workflow.compiled.json`）的顶层字段顺序固定为 `schema`、`id`、`name`、`version`、`description`、`source`、`requires`、`stages`、`roles`、`tasks`、`skills`、`knowledgeBase`、`checklists`、`hooks`、`mcp`、`constitution`。`knowledgeBase` 是按 path 排序的 `{path, body, source}` 数组，`checklists` 是按 id 排序的 `{id, body, source}` 数组，`hooks`/`mcp` 是同样的单条记录或 `null`；bundle 没有声明时分别是 `[]`、`[]`、`null`、`null`。资产正文与每条 `source.sha256` 都进入编译工作流，投影与安装不再读 zip。

投影随后把资产写入磁盘：runner 写项目根的同名路径（`knowledge-base/`、`checklists/`、`hooks/hooks.json`、`mcp.json`），agent-native 写共享命名空间 `.agents/agent-native/<bundle-id>/` 下的同名路径，不逐 target 复制。

## 仓库结构

- `core/`、`compiled/`、`assembler/`、`projection/`：纯契约层（浏览器可 import，无 `node:*`）。
- `runtime/shared/`：跨投影渲染（角色、宪法、占位、`{{submit}}`、确定性 YAML）。
- `runtime/runner/`：runner 投影、契约、schema 与可独立发布的引擎；引擎只依赖 `core/`、契约与 `yaml`。
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

框架（`hm2b-framework`）、引擎（`hm2b-runner`）与 bundle 各自 semver；契约修订（`hm2b.bundle/v2`、`hm2b.compiled-workflow/v2`、`hm2b.projection/v1` 与 `hm2b.projection-result/v1`）与组件版本正交。`docs/compat.md` 由 `node scripts/release.mjs --compat` 生成。
